import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../src/shared/settings.js';
import { TrackTaskService } from '../src/background/track-tasks.js';

const settings = normalizeSettings({ apiBaseUrl: 'http://localhost:9876/v1', apiKey: 'test-only-key', model: 'fixture-model' });
const cues = Array.from({ length: 12 }, (_, i) => ({ id: String(i), start: i * 65, end: i * 65 + 3, text: `Caption ${i}` }));
const request = (extra = {}) => ({ videoId: 'fixture-video', title: 'Buffered video', track: { id: '0', language: 'en', automatic: false }, cues, ...extra });
const storage = () => ({
  saved: {},
  async get() { return structuredClone(this.saved); },
  async set(values) { Object.assign(this.saved, structuredClone(values)); },
  async remove(keys) { for (const key of keys) delete this.saved[key]; },
});
const ids = options => JSON.parse(JSON.parse(options.body).messages[1].content).subtitles.map(row => row.id);
function response(options, prefix = '译:') {
  const rows = JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: rows.map(row => ({ id: row.id, text: prefix + row.text })) }) } }] }));
}
function create({ local = storage(), ...extra } = {}) {
  return new TrackTaskService({ storage: local, loadSettings: async () => settings, hasPermission: async () => true,
    fetchImpl: async (_url, options) => response(options), retryDelaysMs: [1, 2], jitter: () => 0, logger: () => {}, ...extra });
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('test wait timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
async function done(service, id) {
  await until(async () => !['queued', 'translating', 'retrying'].includes((await service.status(id)).state));
  await service.entry(id).persistence;
  return service.status(id);
}
function deferredApi() {
  const calls = [];
  return { calls, fetchImpl: (_url, options) => new Promise(resolve => calls.push({ options, ids: ids(options), signal: options.signal, release: () => resolve(response(options)) })) };
}

test('partial success is durable and public before the other two requests finish; starts deduplicate', async () => {
  const local = storage(), api = deferredApi(), service = create({ local, fetchImpl: api.fetchImpl });
  const [first, second] = await Promise.all([service.start(request()), service.start(request())]);
  assert.equal(first.id, second.id);
  assert.deepEqual(first.translations, []);
  await until(() => api.calls.length === 3);
  api.calls[0].release();
  await until(async () => (await service.status(first.id)).translatedCount === 1);
  const partial = await service.status(first.id);
  assert.equal(partial.state, 'translating');
  assert.equal(partial.translations[0].id, '0');
  assert.equal(Object.values(local.saved)[0].translations.length, 1);
  assert.equal(partial.revision, 1);
  const serialized = JSON.stringify(local.saved);
  for (const secret of ['test-only-key', 'apiKey', 'http://localhost']) assert.ok(!serialized.includes(secret));
  await service.cancel(first.id);
});

test('out-of-order simultaneous saves merge against latest rows without lost updates', async () => {
  const local = storage(), api = deferredApi(), service = create({ local, fetchImpl: api.fetchImpl });
  const task = await service.start(request({ cues: cues.slice(0, 3) }));
  await until(() => api.calls.length === 3);
  api.calls[2].release(); api.calls[0].release(); api.calls[1].release();
  const result = await done(service, task.id);
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.translations.map(row => row.id), ['0', '1', '2']);
  assert.equal(result.revision, 3);
  assert.deepEqual(Object.values(local.saved)[0].translations, result.translations);
});

test('each video has three independent slots and the same video shares slots across configurations', async () => {
  const api = deferredApi(); let current = settings;
  const service = create({ fetchImpl: api.fetchImpl, loadSettings: async () => current });
  const a = await service.start(request());
  current = { ...settings, model: 'second-model' };
  const sameVideo = await service.start(request());
  assert.equal(api.calls.length, 3);
  const b = await service.start(request({ videoId: 'video-b' }));
  await until(() => api.calls.length === 6);
  assert.equal(service.pool('fixture-video').active, 3);
  assert.equal(service.pool('video-b').active, 3);
  await Promise.all([service.cancel(a.id), service.cancel(sameVideo.id), service.cancel(b.id)]);
});

test('seek keeps in-flight requests and the next available slot handles the new position', async () => {
  const api = deferredApi(), service = create({ fetchImpl: api.fetchImpl });
  const task = await service.start(request(), 11);
  await until(() => api.calls.length === 3);
  await service.position({ id: task.id, videoId: 'fixture-video', position: 650, rate: 2, reason: 'seek' }, 11);
  assert.equal(api.calls.length, 3);
  assert.ok(api.calls.every(call => !call.signal.aborted));
  api.calls[0].release();
  await until(() => api.calls.length === 4);
  assert.deepEqual(api.calls[3].ids, ['10']);
  await until(async () => (await service.status(task.id)).translations.some(row => row.id === '0'));
  await service.cancel(task.id);
});

test('background tick cannot steal the latest explicit page priority; detach does not cancel', async () => {
  const api = deferredApi(), service = create({ fetchImpl: api.fetchImpl });
  const task = await service.start(request(), 11);
  await service.position({ id: task.id, videoId: 'fixture-video', position: 650, rate: 1, reason: 'seek' }, 22);
  await service.position({ id: task.id, videoId: 'fixture-video', position: 0, rate: 1, reason: 'tick' }, 11);
  assert.equal(service.entry(task.id).position, 650);
  service.detach(22);
  assert.equal(service.entry(task.id).running, true);
  await assert.rejects(service.position({ id: task.id, videoId: 'wrong-video', position: 0 }, 11), /不匹配/);
  await service.cancel(task.id);
});

test('temporary failures retry twice, do not duplicate saved cues and expose no provider error', async () => {
  const counts = new Map(), logs = [];
  const service = create({ logger: event => logs.push(event), fetchImpl: async (_url, options) => {
    const key = ids(options).join(','); counts.set(key, (counts.get(key) || 0) + 1);
    if (key === '0' && counts.get(key) < 3) return new Response('provider-secret', { status: 503 });
    return response(options);
  } });
  const task = await service.start(request({ cues: cues.slice(0, 3) }));
  const result = await done(service, task.id);
  assert.equal(result.state, 'complete');
  assert.equal(counts.get('0'), 3); assert.equal(counts.get('1'), 1); assert.equal(counts.get('2'), 1);
  assert.equal(logs.filter(row => row.action === 'retry').length, 2);
  assert.ok(!JSON.stringify([logs, result]).includes('provider-secret'));
  assert.equal(result.error, undefined);
});

test('retry backoff releases slots and honors Retry-After without blocking other segments', async () => {
  let first = true; const calls = [];
  const service = create({ retryDelaysMs: [70, 70], fetchImpl: async (_url, options) => {
    calls.push(ids(options));
    if (ids(options)[0] === '0' && first) { first = false; return new Response('', { status: 429, headers: { 'Retry-After': '0.1' } }); }
    return response(options);
  } });
  const task = await service.start(request({ cues: cues.slice(0, 6) }));
  await until(async () => (await service.status(task.id)).retryingCount === 1);
  await until(async () => (await service.status(task.id)).translatedCount === 5);
  assert.equal(service.pool('fixture-video').active, 0);
  assert.ok(calls.length >= 4);
  const start = Date.now();
  assert.equal((await done(service, task.id)).state, 'complete');
  assert.ok(Date.now() - start >= 60);
});

test('a queued retry covering a seek point outranks future chunks and explicit interaction prioritizes its task', async () => {
  const api = deferredApi(); let current = settings;
  const service = create({ loadSettings: async () => current, fetchImpl: api.fetchImpl });
  const compact = cues.map((cue, i) => ({ ...cue, start: i * 10, end: i * 10 + 9 }));
  const a = await service.start(request(), 1);
  await until(() => api.calls.length === 3);
  const entry = service.makeEntry({ ...request({ cues: compact }), translations: [] });
  const chunk = { id: 'queued-retry', ids: compact.slice(0, 6).map(c => c.id), cues: compact.slice(0, 6), state: 'queued', attempt: 1 };
  entry.segments.set(chunk.id, chunk); entry.position = 30;
  assert.equal(service.chooseSegment(entry), chunk);
  current = { ...settings, model: 'new-model' };
  const b = await service.start(request(), 2);
  await service.position({ id: b.id, videoId: 'fixture-video', position: 650, reason: 'seek', rate: 1 }, 2);
  api.calls[0].release();
  await until(() => api.calls.length === 4);
  assert.equal(JSON.parse(api.calls[3].options.body).model, 'new-model');
  assert.equal(api.calls[3].ids[0], '10');
  await Promise.all([service.cancel(a.id), service.cancel(b.id)]);
});

test('retry exhaustion retains successful segments and resume translates only the missing range', async () => {
  let fail = true; const counts = new Map();
  const service = create({ fetchImpl: async (_url, options) => {
    const key = ids(options).join(','); counts.set(key, (counts.get(key) || 0) + 1);
    if (key === '0' && fail) return new Response('', { status: 503 });
    return response(options);
  } });
  const task = await service.start(request({ cues: cues.slice(0, 3) }));
  const failed = await done(service, task.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.translatedCount, 2); assert.equal(counts.get('0'), 3);
  fail = false; await service.resume(task.id);
  assert.equal((await done(service, task.id)).state, 'complete');
  assert.equal(counts.get('0'), 4); assert.equal(counts.get('1'), 1); assert.equal(counts.get('2'), 1);
});

test('invalid configuration pauses without futile automatic retries', async () => {
  let calls = 0;
  const service = create({ fetchImpl: async () => { calls++; return new Response('secret', { status: 401 }); } });
  const task = await service.start(request({ cues: cues.slice(0, 1) }));
  assert.equal((await done(service, task.id)).state, 'paused'); assert.equal(calls, 1);
});

test('malformed segment results use bounded retries and never publish incomplete rows', async () => {
  let calls = 0;
  const compact = cues.slice(0, 2).map((cue, i) => ({ ...cue, start: i * 3, end: i * 3 + 2 }));
  const service = create({ fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: '0', text: 'only one' }] }) } }] }));
  } });
  const task = await service.start(request({ cues: compact }));
  const result = await done(service, task.id);
  assert.equal(result.state, 'failed'); assert.equal(result.translatedCount, 0); assert.equal(calls, 3);
});

test('length rejection splits only the rejected segment, with independently saved children', async () => {
  let calls = 0;
  const compact = cues.slice(0, 4).map((cue, i) => ({ ...cue, start: i * 3, end: i * 3 + 2 }));
  const service = create({ fetchImpl: async (_url, options) => {
    calls++; return ids(options).length > 1 ? new Response('', { status: 413 }) : response(options);
  } });
  const task = await service.start(request({ cues: compact }));
  assert.equal((await done(service, task.id)).translatedCount, 4); assert.equal(calls, 7);
  assert.ok(service.entry(task.id).metrics.maxConcurrency <= 3);
});

test('source save failure avoids API charges; successful remote results retry storage only', async () => {
  const broken = storage(); broken.set = async () => { throw new Error('provider-secret'); };
  await assert.rejects(create({ local: broken, fetchImpl: () => assert.fail('must not charge') }).start(request()), /保存/);
  const local = storage(), save = local.set.bind(local); let failures = 2, calls = 0;
  local.set = async values => {
    if (Object.values(values).some(r => r.translations.length) && failures-- > 0) throw new Error('full disk');
    await save(values);
  };
  const service = create({ local, fetchImpl: async (_url, options) => { calls++; return response(options); } });
  const task = await service.start(request({ cues: cues.slice(0, 1) }));
  assert.equal((await done(service, task.id)).state, 'complete'); assert.equal(calls, 1);
});

test('exhausted storage writes pause; manual resume saves retained results without API replay', async () => {
  const local = storage(), save = local.set.bind(local); let broken = true, calls = 0;
  local.set = async values => {
    if (Object.values(values).some(r => r.translations.length) && broken) throw new Error('disk full');
    await save(values);
  };
  const service = create({ local, fetchImpl: async (_url, options) => { calls++; return response(options); } });
  const task = await service.start(request({ cues: cues.slice(0, 1) }));
  const result = await done(service, task.id);
  assert.equal(result.state, 'paused'); assert.equal(result.translatedCount, 0);
  broken = false; await service.resume(task.id);
  assert.equal((await done(service, task.id)).state, 'complete'); assert.equal(calls, 1);
});

test('cancellation during persistence wins state but retains successfully saved rows', async () => {
  const local = storage(), save = local.set.bind(local); let release;
  local.set = async values => {
    if (!release && Object.values(values).some(r => r.state === 'complete')) await new Promise(resolve => { release = resolve; });
    await save(values);
  };
  const service = create({ local });
  const task = await service.start(request({ cues: cues.slice(0, 1) }));
  await until(() => release);
  const cancellation = service.cancel(task.id);
  await until(async () => (await service.status(task.id)).state === 'cancelled');
  release(); await cancellation;
  assert.equal((await service.status(task.id)).state, 'cancelled');
  assert.equal(Object.values(local.saved)[0].state, 'cancelled');
  assert.equal(Object.values(local.saved)[0].translations.length, 1);
  service.fetchImpl = () => assert.fail('all durable rows must not be translated again');
  service.hasPermission = async () => false;
  assert.equal((await service.resume(task.id)).state, 'complete');
  assert.equal(Object.values(local.saved)[0].state, 'complete');
});

test('cancel followed immediately by resume isolates aborted callbacks and fills all missing cues', async () => {
  let first = true, signal;
  const service = create({ fetchImpl: (_url, options) => {
    if (!first) return Promise.resolve(response(options));
    first = false; signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const task = await service.start(request({ cues: cues.slice(0, 1) }));
  await until(() => signal);
  await service.cancel(task.id); await service.resume(task.id);
  assert.equal(signal.aborted, true);
  assert.equal((await done(service, task.id)).state, 'complete');
});

test('response-body stalls obey timeout and do not block another video', async () => {
  let first = true;
  const service = create({ timeoutMs: 15, fetchImpl: async (_url, options) => {
    if (first) { first = false; return { ok: true, json: () => new Promise(() => {}) }; }
    return response(options);
  } });
  const a = await service.start(request({ cues: cues.slice(0, 1) }));
  const b = await service.start(request({ videoId: 'video-b', cues: cues.slice(0, 1) }));
  assert.equal((await done(service, b.id)).state, 'complete');
  assert.equal((await done(service, a.id)).state, 'complete');
  assert.equal(service.entry(a.id).metrics.requestCount, 2);
});

test('partial restart performs zero automatic requests and start resumes only missing cues', async () => {
  const local = storage(), api = deferredApi(), before = create({ local, fetchImpl: api.fetchImpl });
  const task = await before.start(request({ cues: cues.slice(0, 3) }));
  await until(() => api.calls.length === 3); api.calls[0].release();
  await until(async () => (await before.status(task.id)).translatedCount === 1);
  const restoredStore = { ...storage(), saved: structuredClone(local.saved) }, requested = [];
  const after = create({ local: restoredStore, fetchImpl: async (_url, options) => { requested.push(...ids(options)); return response(options); } });
  const restored = await after.status(task.id);
  assert.equal(restored.state, 'paused'); assert.equal(restored.translatedCount, 1); assert.deepEqual(requested, []);
  await after.start(request({ cues: cues.slice(0, 3), track: { id: 'changed', language: 'en', automatic: false } }));
  assert.equal((await done(after, task.id)).state, 'complete'); assert.deepEqual(requested.sort(), ['1', '2']);
  await before.cancel(task.id);
});

test('v1 complete caches migrate without permission or API and exports retain original timestamps', async () => {
  const local = storage(), original = create({ local });
  const task = await original.start(request({ cues: cues.slice(0, 3) }));
  await done(original, task.id);
  const value = Object.values(local.saved)[0]; value.version = 1; delete value.revision; delete value.segments;
  const restored = create({ local, fetchImpl: () => assert.fail('cache should avoid API'), hasPermission: async () => false });
  const cached = await restored.start(request({ cues: cues.slice(0, 3) }));
  assert.equal(cached.cached, true); assert.equal(cached.translatedCount, 3);
  assert.match((await restored.export(task.id, 'bilingual')).content, /Caption 0\r\n译:Caption 0/);
  assert.match((await restored.export(task.id, 'original')).content, /00:01:05,000 --> 00:01:08,000/);
  assert.ok((await restored.list()).every(row => !row.cues && !row.translations));
});

test('cache identity and settings snapshots isolate source/config changes but allow key rotation', async () => {
  let current = settings; const bodies = [], api = deferredApi();
  const service = create({ loadSettings: async () => current, fetchImpl: (url, options) => { bodies.push(JSON.parse(options.body)); return api.fetchImpl(url, options); } });
  const first = await service.start(request({ cues: cues.slice(0, 1) }));
  current = { ...settings, model: 'other-model', apiKey: 'another-key' };
  const second = await service.start(request({ cues: cues.slice(0, 1) }));
  assert.notEqual(first.id, second.id); assert.deepEqual(bodies.map(b => b.model), ['fixture-model', 'other-model']);
  await assert.rejects(service.resume(first.id), /配置已改变/);
  api.calls.forEach(call => call.release()); await done(service, first.id); await done(service, second.id);
  current = { ...settings, apiKey: 'rotated-key', fontSize: 40 };
  assert.equal((await service.start(request({ cues: cues.slice(0, 1) }))).id, first.id);
  const changed = await service.start(request({ cues: [{ ...cues[0], text: 'changed' }] }));
  assert.notEqual(changed.id, first.id); await service.cancel(changed.id);
});

test('force is explicit full retranslation; partial translated exports remain gated and clear preserves active work', async () => {
  let calls = 0;
  const service = create({ fetchImpl: async (_url, options) => response(options, `${++calls}:`) });
  const first = await service.start(request({ cues: cues.slice(0, 1) })); await done(service, first.id);
  await service.start(request({ cues: cues.slice(0, 1), force: true }));
  assert.equal((await done(service, first.id)).translations[0].text, '2:Caption 0');
  const api = deferredApi(); service.fetchImpl = api.fetchImpl;
  const active = await service.start(request({ videoId: 'active-video' }));
  assert.ok((await service.export(active.id, 'original')).content.includes('Caption 0'));
  await assert.rejects(service.export(active.id, 'translated'), /等待完整/);
  assert.equal((await service.clear()).cleared, 1); await assert.rejects(service.status(first.id), /不存在/);
  await service.cancel(active.id);
});

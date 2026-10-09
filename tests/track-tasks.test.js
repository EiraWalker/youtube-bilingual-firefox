import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../src/shared/settings.js';
import { TrackTaskService } from '../src/background/track-tasks.js';

const settings = normalizeSettings({ apiBaseUrl: 'http://localhost:9876/v1', apiKey: 'test-only-key', model: 'fixture-model' });
const cues = [
  { id: 'a', start: 0, end: 2, text: 'Hello' },
  { id: 'b', start: 150, end: 153, text: 'End of video' },
];
const request = (extra = {}) => ({ videoId: 'fixture-video', title: 'Whole video', track: { id: '0', language: 'en', automatic: false }, cues, ...extra });
const storage = () => ({
  saved: {},
  async get() { return structuredClone(this.saved); },
  async set(values) { Object.assign(this.saved, structuredClone(values)); },
  async remove(keys) { for (const key of keys) delete this.saved[key]; },
});
function translatedResponse(options, prefix = '译:') {
  const rows = JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: rows.map(row => ({ id: row.id, text: `${prefix}${row.text}` })) }) } }] }));
}
function createService({ local = storage(), ...extra } = {}) {
  return new TrackTaskService({ storage: local, loadSettings: async () => settings, hasPermission: async () => true, fetchImpl: async (_url, options) => translatedResponse(options), ...extra });
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('test wait timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
async function done(service, id) {
  await until(async () => !['queued', 'translating'].includes((await service.status(id)).state));
  return service.status(id);
}

test('a stalled API response body cannot block the queue after deadline or cancellation', async () => {
  for (const stop of ['timeout', 'cancel']) {
    let calls = 0;
    const service = createService({ timeoutMs: stop === 'timeout' ? 30 : 600_000, fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) return { ok: true, json: () => new Promise(() => {}) };
      return translatedResponse(options);
    } });
    const first = await service.start(request({ videoId: `stalled-${stop}` }));
    await until(() => calls === 1);
    const next = await service.start(request({ videoId: `waiting-${stop}` }));
    if (stop === 'cancel') await service.cancel(first.id);
    const complete = await done(service, next.id);
    assert.equal(complete.state, 'complete');
    assert.equal(calls, 2);
    const stopped = await service.status(first.id);
    assert.equal(stopped.state, stop === 'timeout' ? 'failed' : 'cancelled');
    if (stop === 'timeout') assert.match(stopped.error, /超时/);
  }
});

test('start returns an independent background task, deduplicates simultaneous starts, and persists the whole result without credentials', async () => {
  const local = storage();
  let release, calls = 0;
  const service = createService({ local, fetchImpl: async (_url, options) => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return translatedResponse(options);
  } });
  const [first, second] = await Promise.all([service.start(request()), service.start(request())]);
  assert.equal(first.id, second.id);
  assert.ok(['queued', 'translating'].includes(first.state));
  assert.equal(first.translations, undefined);
  await until(() => release);
  assert.equal(calls, 1);
  release();
  const complete = await done(service, first.id);
  assert.equal(complete.state, 'complete');
  assert.deepEqual(complete.cues, cues);
  assert.equal(complete.translatedCount, 2);
  assert.deepEqual(complete.translations, [{ id: 'a', text: '译:Hello' }, { id: 'b', text: '译:End of video' }]);
  const serialized = JSON.stringify(local.saved);
  assert.ok(!serialized.includes('test-only-key'));
  assert.ok(!serialized.includes('apiKey'));
  assert.ok(!serialized.includes('http://localhost'));
  assert.ok(!JSON.stringify(complete).includes('http://localhost'));
});

test('new service restores persisted complete subtitles and stable track identity without another request', async () => {
  const local = storage();
  const firstService = createService({ local });
  const first = await firstService.start(request());
  await done(firstService, first.id);
  const restored = createService({ local, fetchImpl: () => assert.fail('cache must avoid API'), hasPermission: async () => false });
  const cache = await restored.start(request({ track: { id: 'changed-index', language: 'en', automatic: false } }));
  assert.equal(cache.id, first.id);
  assert.equal(cache.state, 'complete');
  assert.equal(cache.cached, true);
  const found = await restored.lookup({ videoId: 'fixture-video', track: { id: '2', language: 'en', automatic: false } });
  assert.deepEqual(found.cues, cues);
  assert.equal(found.translations[1].text, '译:End of video');
  assert.equal(await restored.lookup({ videoId: 'fixture-video', track: { language: 'en', automatic: true } }), null);
});

test('queued jobs keep their initial configuration while other videos and settings change', async () => {
  let current = settings, release;
  const bodies = [];
  const service = createService({ loadSettings: async () => current, fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) await new Promise(resolve => { release = resolve; });
    return translatedResponse(options);
  } });
  const first = await service.start(request());
  await until(() => release);
  const second = await service.start(request({ videoId: 'next-video' }));
  current = { ...settings, model: 'different-model', targetLanguage: 'ja', apiKey: 'different-test-key' };
  // There is no page-owner lease: the first page can disappear while the
  // second video is queued. Both requests retain their start-time settings.
  release();
  assert.equal((await done(service, first.id)).state, 'complete');
  assert.equal((await done(service, second.id)).state, 'complete');
  assert.deepEqual(bodies.map(body => body.model), ['fixture-model', 'fixture-model']);
  assert.ok(bodies.every(body => body.messages[0].content.includes('zh-CN')));
});

test('cache identity covers source text/times, source kind, video and all translation settings', async () => {
  let current = settings, calls = 0;
  const service = createService({ loadSettings: async () => current, fetchImpl: async (_url, options) => { calls++; return translatedResponse(options); } });
  const base = await service.start(request());
  await done(service, base.id);
  const identities = new Set([base.id]);
  for (const changed of [
    request({ videoId: 'other-video' }),
    request({ track: { language: 'en', automatic: true } }),
    request({ cues: cues.map((cue, index) => index ? cue : { ...cue, text: 'New caption' }) }),
    request({ cues: cues.map((cue, index) => index ? cue : { ...cue, end: 3 }) }),
  ]) {
    const task = await service.start(changed);
    identities.add(task.id);
    await done(service, task.id);
  }
  for (const changed of [{ targetLanguage: 'ja' }, { model: 'other-model' }, { apiBaseUrl: 'http://localhost:9877/v1' }]) {
    current = { ...settings, ...changed };
    const task = await service.start(request());
    identities.add(task.id);
    await done(service, task.id);
  }
  assert.equal(identities.size, 8);
  assert.equal(calls, 8);
  current = { ...settings, apiKey: 'rotated-test-key', fontSize: 40 };
  assert.equal((await service.start(request())).id, base.id);
  assert.equal(calls, 8);
});

test('force retranslates a complete track instead of reusing its previous translation', async () => {
  let calls = 0;
  const service = createService({ fetchImpl: async (_url, options) => translatedResponse(options, `${++calls}:`) });
  const first = await service.start(request());
  await done(service, first.id);
  const cached = await service.start(request());
  assert.equal(cached.cached, true);
  const forced = await service.start(request({ force: true }));
  assert.equal(forced.id, first.id);
  assert.equal(forced.cached, false);
  assert.equal((await done(service, forced.id)).translations[0].text, '2:Hello');
  assert.equal(calls, 2);
});

test('explicit cancellation aborts in-flight fetch and stops a queued track without API requests', async () => {
  let calls = 0, signal;
  const service = createService({ fetchImpl: (_url, options) => {
    calls++;
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const first = await service.start(request());
  await until(() => signal);
  const queued = await service.start(request({ videoId: 'queued-video' }));
  assert.equal((await service.cancel(queued.id)).state, 'cancelled');
  assert.equal((await service.cancel(first.id)).state, 'cancelled');
  await service.queue;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal((await service.status(first.id)).translations, undefined);
});

test('cancellation while a complete record is being saved wins both the public state and final durable state', async () => {
  const local = storage();
  const save = local.set.bind(local);
  let releaseSave;
  local.set = async (values) => {
    if (Object.values(values).some(value => value.state === 'complete')) await new Promise(resolve => { releaseSave = resolve; });
    await save(values);
  };
  const service = createService({ local });
  const task = await service.start(request());
  await until(() => releaseSave);
  const cancellation = service.cancel(task.id);
  await until(async () => (await service.status(task.id)).state === 'cancelled');
  releaseSave();
  assert.equal((await cancellation).state, 'cancelled');
  await service.queue;
  assert.equal((await service.status(task.id)).translations, undefined);
  assert.equal(Object.values(local.saved)[0].state, 'cancelled');
  assert.equal(Object.values(local.saved)[0].translations, undefined);
});

test('partial or malformed translations fail with no saved complete result or chunk retries', async () => {
  const local = storage();
  let calls = 0;
  const service = createService({ local, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 'a', text: 'Only one' }] }) } }] }));
  } });
  const task = await service.start(request());
  const failure = await done(service, task.id);
  assert.equal(failure.state, 'failed');
  assert.match(failure.error, /漏译/);
  assert.equal(failure.translations, undefined);
  assert.equal(calls, 1);
  assert.equal(Object.values(local.saved)[0].state, 'failed');
  assert.equal(Object.values(local.saved)[0].translations, undefined);
});

test('storage failure cannot report complete or saved, and a broken source save avoids charging an API request', async () => {
  const local = storage();
  const save = local.set.bind(local);
  local.set = async (values) => {
    if (Object.values(values).some(value => value.state === 'complete')) throw new Error('disk is full');
    await save(values);
  };
  const service = createService({ local });
  const task = await service.start(request());
  const failed = await done(service, task.id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /保存/);
  assert.equal(failed.translations, undefined);
  const broken = storage();
  broken.set = async () => { throw new Error('provider-secret'); };
  const denied = createService({ local: broken, fetchImpl: () => assert.fail('must not translate unsavable task') });
  await assert.rejects(denied.start(request()), error => /保存/.test(error.message) && !error.message.includes('provider-secret'));
});

test('length fallback publishes a complete result only after both halves finish', async () => {
  let calls = 0, release;
  const service = createService({ fetchImpl: async (_url, options) => {
    calls++;
    if (calls === 1) return new Response('', { status: 413 });
    if (calls === 3) await new Promise(resolve => { release = resolve; });
    return translatedResponse(options);
  } });
  const task = await service.start(request());
  await until(() => release);
  const partial = await service.status(task.id);
  assert.equal(partial.state, 'translating');
  assert.equal(partial.translatedCount, 0);
  assert.equal(partial.translations, undefined);
  release();
  assert.equal((await done(service, task.id)).translatedCount, 2);
  assert.equal(calls, 3);
});

test('original SRT is available during translation, translated exports wait; clearing saved caches preserves active work', async () => {
  let release;
  const service = createService();
  const completed = await service.start(request());
  await done(service, completed.id);
  service.fetchImpl = async (_url, options) => { await new Promise(resolve => { release = resolve; }); return translatedResponse(options); };
  const active = await service.start(request({ videoId: 'active-video' }));
  await until(() => release);
  assert.match((await service.export(active.id, 'original')).content, /00:02:30,000 --> 00:02:33,000\r\nEnd of video/);
  await assert.rejects(service.export(active.id, 'translated'), /等待完整/);
  assert.match((await service.export(completed.id, 'bilingual')).content, /Hello\r\n译:Hello/);
  const list = await service.list();
  assert.equal(list.length, 2);
  assert.ok(list.every(row => row.cues === undefined && row.translations === undefined));
  assert.equal((await service.clear()).cleared, 1);
  await assert.rejects(service.status(completed.id), /不存在/);
  release();
  assert.equal((await done(service, active.id)).state, 'complete');
});

test('after Firefox restart an interrupted task fails visibly rather than claiming it is resumable or complete', async () => {
  const local = storage();
  let release;
  const before = createService({ local, fetchImpl: async (_url, options) => { await new Promise(resolve => { release = resolve; }); return translatedResponse(options); } });
  const task = await before.start(request());
  await until(() => release);
  const after = createService({ local: { ...storage(), saved: structuredClone(local.saved) }, fetchImpl: () => assert.fail('restart requires explicit retry') });
  const interrupted = await after.status(task.id);
  assert.equal(interrupted.state, 'failed');
  assert.match(interrupted.error, /Firefox 退出/);
  assert.equal(await after.lookup({ videoId: 'fixture-video', track: { language: 'en' } }), null);
  release();
  await done(before, task.id);
});

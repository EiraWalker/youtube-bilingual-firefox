import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../src/shared/settings.js';
import { TrackTaskService } from '../src/background/track-tasks.js';

const settings = normalizeSettings({ apiBaseUrl: 'http://localhost:9876/v1', apiKey: 'test-only-key', model: 'fixture-model' });
const cues = Array.from({ length: 100 }, (_, i) => ({ id: String(i), start: i * 10, end: i * 10 + 3, text: `Caption ${i}` }));
const playback = (overrides = {}) => ({ session: 'page-a', sequence: 1, view: 1, active: true, position: 0, rate: 1, reason: 'activate', ...overrides });
const request = (extra = {}) => ({ videoId: 'fixture-video', title: 'Buffered video', track: { id: '0', language: 'en', automatic: false }, cues, playback: playback(), ...extra });
const storage = () => ({ saved: {}, writes: 0,
  async get() { return structuredClone(this.saved); },
  async set(values) { this.writes++; Object.assign(this.saved, structuredClone(values)); },
  async remove(keys) { for (const key of keys) delete this.saved[key]; },
});
function response(options, prefix = '译:') {
  const rows = JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: rows.map(row => ({ id: row.id, text: prefix + row.text })) }) } }] }));
}
function apiFixture() {
  const calls = [];
  return { calls, fetchImpl: (_url, options) => new Promise(resolve => calls.push({ options,
    ids: JSON.parse(JSON.parse(options.body).messages[1].content).subtitles.map(row => row.id),
    release(value = response(options)) { if (!this.released) { this.released = true; resolve(value); } },
  })) };
}
function mtFixture() {
  const calls = [];
  const config = normalizeSettings({ apiBaseUrl: settings.apiBaseUrl, model: 'qwen-mt-flash' });
  return { calls, loadSettings: async () => config,
    fetchImpl: (_url, options) => new Promise(resolve => calls.push({ body: JSON.parse(options.body),
      release(value = 'MT') {
        resolve(value instanceof Response ? value : new Response(JSON.stringify({ choices: [{ message: { content: value } }] })));
      },
    })),
  };
}
function create(t, extra = {}) {
  const local = storage(), api = apiFixture();
  const service = new TrackTaskService({ storage: local, loadSettings: async () => settings, hasPermission: async () => true,
    fetchImpl: api.fetchImpl, retryDelaysMs: [10, 15], jitter: () => 0, logger: () => {}, ...extra });
  t.after(async () => { for (const entry of await service.list()) await service.cancel(entry.id); });
  return { service, local, api };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('test wait timed out'); await tick(); }
}
async function settle(api, service, id) {
  for (let round = 0; round < 30; round++) {
    for (const call of api.calls) call.release();
    await tick();
    if ((await service.status(id)).inFlightCount === 0) return service.status(id);
  }
  throw new Error('Requests did not stop');
}
const position = (id, extra = {}) => ({ id, videoId: 'fixture-video', ...playback({ sequence: 2, ...extra }) });

const multiSettings = (profiles = {}) => ({ ...settings, models: [
  { id: 'quality', name: 'Quality', apiBaseUrl: 'http://localhost:9876/v1', model: 'quality-model', apiKey: '', enabled: true, priority: 1, ...profiles.quality },
  { id: 'balanced', name: 'Balanced', apiBaseUrl: 'http://localhost:9876/v1', model: 'balanced-model', apiKey: '', enabled: true, priority: 2, ...profiles.balanced },
  { id: 'fast', name: 'Fast', apiBaseUrl: 'http://localhost:9876/v1', model: 'fast-model', apiKey: '', enabled: true, priority: 3, ...profiles.fast },
  { id: 'disabled', name: 'Disabled', apiBaseUrl: 'http://localhost:9876/v1', model: 'disabled-model', apiKey: '', enabled: false, priority: 1 },
] });
const modelCall = (api, model) => api.calls.find(call => JSON.parse(call.options.body).model === model);

test('enabled models race the same segment and each higher-priority result upgrades the timeline immediately', async t => {
  const { service, api, local } = create(t, { loadSettings: async () => multiSettings() });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  assert.equal(api.calls.length, 3);
  assert.deepEqual(api.calls.map(call => JSON.parse(call.options.body).model).sort(), ['balanced-model', 'fast-model', 'quality-model']);
  assert.ok(api.calls.every(call => JSON.stringify(call.ids) === JSON.stringify(['0', '1', '2'])));
  let revision = task.revision;
  for (const model of ['fast-model', 'balanced-model', 'quality-model']) {
    const call = modelCall(api, model);
    call.release(response(call.options, model + ':'));
    await until(async () => (await service.status(task.id)).revision > revision);
    const current = await service.status(task.id);
    assert.equal(current.translatedCount, 3);
    assert.ok(current.translations.every(row => row.text.startsWith(model + ':')));
    revision = current.revision;
  }
  assert.equal((await service.status(task.id)).state, 'complete');
  assert.equal(local.writes, 0);
});

test('later equal or lower priority results never downgrade an already usable translation', async t => {
  for (const equalPriority of [false, true]) {
    const config = multiSettings(equalPriority ? { fast: { priority: 1 }, balanced: { priority: 1 } } : {});
    const { service, api } = create(t, { loadSettings: async () => config });
    const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
    const quality = modelCall(api, 'quality-model'); quality.release(response(quality.options, 'best:'));
    await until(async () => (await service.status(task.id)).translatedCount === 3);
    const firstRevision = (await service.status(task.id)).revision;
    await settle(api, service, task.id);
    const current = await service.status(task.id);
    assert.ok(current.translations.every(row => row.text.startsWith('best:')));
    assert.equal(current.revision, firstRevision);
  }
});

test('three segment slots fan out to all enabled models while sharing one bounded viewing window', async t => {
  const { service, api } = create(t, { loadSettings: async () => multiSettings() });
  const task = await service.start(request(), 11);
  assert.equal(api.calls.length, 9);
  assert.equal(task.inFlightCount, 9); assert.equal(task.inFlightSegmentCount, 3);
  for (const model of ['quality-model', 'balanced-model', 'fast-model']) {
    const ids = api.calls.filter(call => JSON.parse(call.options.body).model === model).flatMap(call => call.ids);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => cues[Number(id)].start < 120));
  }
  await service.position(position(task.id, { active: false }), 11);
  await settle(api, service, task.id);
  assert.equal(api.calls.length, 9, 'late upgrades after pause never submit another segment');
});

test('one model authentication failure cannot cancel another model or discard its usable rows', async t => {
  const { service, api } = create(t, { loadSettings: async () => multiSettings() });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  modelCall(api, 'quality-model').release(new Response('private-provider-body', { status: 401 }));
  await tick();
  await settle(api, service, task.id);
  const current = await service.status(task.id);
  assert.equal(current.translatedCount, 3); assert.equal(current.state, 'complete');
  assert.equal(api.calls.length, 3);
  assert.ok(!JSON.stringify(current).includes('private-provider-body'));
});

test('a model retries independently while another model in the same segment is still in flight', async t => {
  const { service, api } = create(t, { loadSettings: async () => multiSettings(), concurrency: 1 });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  modelCall(api, 'quality-model').release(new Response('{}', { status: 503 }));
  await until(() => api.calls.length === 4);
  assert.equal(JSON.parse(api.calls[3].options.body).model, 'quality-model');
  assert.equal(modelCall(api, 'fast-model').released, undefined);
  assert.equal((await service.status(task.id)).inFlightSegmentCount, 1);
  await settle(api, service, task.id);
});

test('priority and enabled-set changes isolate multi-model cache identity, but key rotation does not', async t => {
  let config = multiSettings();
  const { service, api } = create(t, { loadSettings: async () => config });
  const source = { cues: cues.slice(0, 3) };
  const first = await service.start(request(source), 11); await settle(api, service, first.id);
  config = { ...config, models: config.models.map(model => ({ ...model, apiKey: 'fixture-rotated' })) };
  assert.equal((await service.start(request({ ...source, playback: playback({ sequence: 2 }) }), 11)).id, first.id);
  config = { ...config, models: config.models.map(model => ({ ...model, priority: model.id === 'fast' ? 1 : 3 })) };
  const next = await service.start(request({ ...source, playback: playback({ sequence: 3 }) }), 11);
  assert.notEqual(next.id, first.id); await settle(api, service, next.id);
  config = { ...config, models: config.models.map(model => ({ ...model, enabled: model.id === 'fast' })) };
  assert.notEqual((await service.start(request({ ...source, playback: playback({ sequence: 4 }) }), 11)).id, next.id);
});

test('active request timing starts at dispatch and resets for each retry, excluding backoff', async t => {
  let now = 1000;
  const { service, api } = create(t, { now: () => now, concurrency: 1, retryDelaysMs: [2000, 2000] });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  assert.deepEqual(task.activeRequests, [{ ids: ['0', '1', '2'], startedAt: 1000, attempt: 1 }]);
  now = 2500;
  assert.deepEqual((await service.status(task.id)).activeRequests, task.activeRequests);
  for (const [attempt, startedAt] of [[2, 6000], [3, 11000]]) {
    api.calls.at(-1).release(new Response('{}', { status: 503 }));
    await until(async () => (await service.status(task.id)).retryingCount === 1);
    assert.deepEqual((await service.status(task.id)).activeRequests, []);
    now = startedAt;
    await service.position(position(task.id, { sequence: attempt }), 11);
    assert.equal(api.calls.length, attempt);
    assert.deepEqual((await service.status(task.id)).activeRequests,
      [{ ids: ['0', '1', '2'], startedAt, attempt }]);
  }
  assert.equal(task.activeRequests[0].startedAt, 1000, 'earlier snapshots remain unchanged');
  await settle(api, service, task.id);
  assert.deepEqual((await service.status(task.id)).activeRequests, []);
});

test('Qwen MT publishes each cue immediately and pause stops subsequent calls without retranslating completed cues', async t => {
  let now = 1000;
  const calls = [];
  const config = normalizeSettings({ apiBaseUrl: 'http://localhost:9876/v1', model: 'qwen-mt-flash' });
  const { service } = create(t, { now: () => now, concurrency: 1, loadSettings: async () => config,
    fetchImpl: (_url, options) => new Promise(resolve => calls.push({ body: JSON.parse(options.body),
      release(text) { resolve(new Response(JSON.stringify({ choices: [{ message: { content: text } }] }))); },
    })) });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  assert.equal(calls[0].body.messages[0].content, 'Caption 0');
  assert.deepEqual(task.activeRequests, [{ ids: ['0'], startedAt: 1000, attempt: 1 }]);
  now = 2000; calls[0].release('MT0');
  await until(async () => (await service.status(task.id)).translatedCount === 1 && calls.length === 2);
  assert.equal((await service.status(task.id)).translations[0].text, 'MT0');
  assert.deepEqual((await service.status(task.id)).activeRequests, [{ ids: ['1'], startedAt: 2000, attempt: 1 }]);
  await service.position(position(task.id, { active: false }), 11);
  calls[1].release('MT1');
  await until(async () => (await service.status(task.id)).translatedCount === 2);
  await tick();
  assert.equal(calls.length, 2, 'a sequential MT call is still a new request and must respect pause');
  now = 5000;
  await service.position(position(task.id, { sequence: 3, active: true }), 11);
  await until(() => calls.length === 3);
  assert.equal(calls[2].body.messages[0].content, 'Caption 2');
  assert.deepEqual((await service.status(task.id)).activeRequests, [{ ids: ['2'], startedAt: 5000, attempt: 1 }]);
  calls[2].release('MT2');
  await until(async () => (await service.status(task.id)).state === 'complete');
  const current = await service.status(task.id);
  assert.deepEqual(current.translations.map(row => row.text), ['MT0', 'MT1', 'MT2']);
  assert.equal(current.metrics.requestCount, 3);
});

test('Qwen MT single-cue length rejection terminates without splitting or replaying paid partial rows', async t => {
  for (const failedIndex of [1, 2]) {
    const calls = [];
    const config = normalizeSettings({ apiBaseUrl: settings.apiBaseUrl, model: 'qwen-mt-flash' });
    const { service, local } = create(t, { concurrency: 1, loadSettings: async () => config,
      fetchImpl: async (_url, options) => {
        const text = JSON.parse(options.body).messages[0].content;
        calls.push(text);
        return Number(text.split(' ').at(-1)) < failedIndex
          ? new Response(JSON.stringify({ choices: [{ message: { content: 'MT:' + text } }] }))
          : new Response('{}', { status: 413 });
      },
    });
    const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
    await until(async () => (await service.status(task.id)).inFlightCount === 0);
    const current = await service.status(task.id);
    assert.deepEqual(calls, cues.slice(0, failedIndex + 1).map(cue => cue.text));
    assert.equal(current.state, 'failed');
    assert.equal(current.translatedCount, failedIndex);
    assert.equal(current.metrics.requestCount, failedIndex + 1);
    assert.equal(local.writes, 0);
  }
});

test('each sequential Qwen MT cue gets its own retry budget and first-dispatch attempt', async t => {
  const mt = mtFixture();
  const { service } = create(t, { ...mt, concurrency: 1, retryDelaysMs: [0, 0] });
  const task = await service.start(request({ cues: cues.slice(0, 2) }), 11);
  for (const [index, id, attempt, succeeds] of [
    [0, '0', 1, false], [1, '0', 2, true],
    [2, '1', 1, false], [3, '1', 2, false], [4, '1', 3, true],
  ]) {
    await until(() => mt.calls.length > index);
    assert.equal(mt.calls[index].body.messages[0].content, cues[Number(id)].text);
    assert.equal((await service.status(task.id)).activeRequests[0].attempt, attempt, `cue ${id}, call ${index}`);
    mt.calls[index].release(succeeds ? 'MT:' + id : new Response('{}', { status: 503 }));
  }
  await until(async () => (await service.status(task.id)).state === 'complete');
  assert.deepEqual((await service.status(task.id)).translations, [{ id: '0', text: 'MT:0' }, { id: '1', text: 'MT:1' }]);
  assert.equal(mt.calls.length, 5);
});

test('manual Qwen MT resume restores retries without resetting dispatch history or replaying completed cues', async t => {
  let now = 1000;
  const mt = mtFixture();
  const { service } = create(t, { ...mt, now: () => now, concurrency: 1, retryDelaysMs: [0, 0] });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  mt.calls[0].release('MT:0');
  for (let index = 1; index <= 3; index++) {
    await until(() => mt.calls.length > index);
    mt.calls[index].release(new Response('{}', { status: 503 }));
  }
  await until(async () => (await service.status(task.id)).state === 'failed');
  await service.position(position(task.id, { active: false, reason: 'visibility' }), 11);
  now = 5000;
  await service.resume(task.id);
  assert.equal(mt.calls.length, 4, 'manual resume does not grant viewing demand');
  await service.position(position(task.id, { sequence: 3 }), 11);
  await until(() => mt.calls.length === 5);
  assert.deepEqual((await service.status(task.id)).activeRequests, [{ ids: ['1'], startedAt: 5000, attempt: 4 }]);
  mt.calls[4].release(new Response('{}', { status: 503 }));
  await until(async () => mt.calls.length === 6 || (await service.status(task.id)).state === 'failed');
  assert.equal(mt.calls.length, 6, 'deliberate resume restores the failed cue retry budget');
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 5);
  mt.calls[5].release('MT:1');
  await until(() => mt.calls.length === 7);
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 1, 'the next cue is not a retry');
  mt.calls[6].release('MT:2');
  await until(async () => (await service.status(task.id)).state === 'complete');
  assert.deepEqual(mt.calls.map(call => call.body.messages[0].content), ['Caption 0', ...Array(5).fill('Caption 1'), 'Caption 2']);
});

test('Qwen MT pause and seek splitting preserve a failed cue deadline and consumed retry budget', async t => {
  let now = 1000;
  const mt = mtFixture();
  const { service } = create(t, { ...mt, now: () => now, concurrency: 1, retryDelaysMs: [1000, 1000] });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  mt.calls[0].release('MT:0');
  await until(() => mt.calls.length === 2);
  mt.calls[1].release(new Response('{}', { status: 503 }));
  await until(async () => (await service.status(task.id)).retryingCount === 1);
  now = 2000;
  await service.position(position(task.id), 11);
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 2);
  await service.position(position(task.id, { sequence: 3, active: false }), 11);
  mt.calls[2].release(new Response('{}', { status: 503 }));
  await until(async () => (await service.status(task.id)).retryingCount === 1);
  now = 2500;
  await service.position(position(task.id, { sequence: 4, position: 10, reason: 'seek' }), 11);
  assert.equal(mt.calls.length, 3, 'a split cannot bypass the failed cue backoff');
  now = 3000;
  await service.position(position(task.id, { sequence: 5, position: 10 }), 11);
  assert.deepEqual((await service.status(task.id)).activeRequests, [{ ids: ['1'], startedAt: 3000, attempt: 3 }]);
  mt.calls[3].release(new Response('{}', { status: 503 }));
  await until(async () => (await service.status(task.id)).state === 'failed');
  now = 9000;
  await service.position(position(task.id, { sequence: 6, position: 10 }), 11);
  assert.equal(mt.calls.length, 4, 'seek and playback do not restore exhausted retries');
  assert.deepEqual(mt.calls.map(call => call.body.messages[0].content), ['Caption 0', 'Caption 1', 'Caption 1', 'Caption 1']);
});

test('seeking past an exhausted Qwen cue dispatches an untouched cue without replaying paid rows', async t => {
  const mt = mtFixture();
  const { service } = create(t, { ...mt, concurrency: 1, retryDelaysMs: [0, 0] });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  mt.calls[0].release('MT:0');
  for (let index = 1; index <= 3; index++) {
    await until(() => mt.calls.length > index);
    mt.calls[index].release(new Response('{}', { status: 503 }));
  }
  await until(async () => (await service.status(task.id)).state === 'failed');
  await service.position(position(task.id, { position: 20, reason: 'seek' }), 11);
  assert.equal(mt.calls.length, 5, 'the untouched cue does not inherit its sibling failure');
  assert.deepEqual((await service.status(task.id)).activeRequests.map(item => ({ ids: item.ids, attempt: item.attempt })),
    [{ ids: ['2'], attempt: 1 }]);
  mt.calls[4].release('MT:2');
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  assert.deepEqual((await service.status(task.id)).translations, [{ id: '0', text: 'MT:0' }, { id: '2', text: 'MT:2' }]);
  await service.position(position(task.id, { sequence: 3, position: 10, reason: 'seek' }), 11);
  assert.equal(mt.calls.length, 5, 'returning to the exhausted sibling does not renew its budget');
});

test('a retry deadline survives leaving the whole window and still wakes after returning', async t => {
  const { service, api } = create(t, { concurrency: 1 });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  api.calls[0].release(new Response('{}', { status: 429, headers: { 'Retry-After': '0.1' } }));
  await until(async () => (await service.status(task.id)).retryingCount === 1);
  await service.position(position(task.id, { position: 1000, reason: 'seek' }), 11);
  await service.position(position(task.id, { sequence: 3, position: 0, reason: 'seek' }), 11);
  assert.equal(api.calls.length, 1, 'returning cannot bypass provider backoff');
  await until(() => api.calls.length === 2);
  assert.deepEqual(api.calls[1].ids, ['0', '1', '2']);
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 2);
  await settle(api, service, task.id);
});

test('exhausted retries survive complete window eviction without consuming a slot for fresh cues', async t => {
  const { service, api } = create(t, { concurrency: 1, retryDelaysMs: [0, 0] });
  const source = [...cues.slice(0, 3), cues[50]];
  const task = await service.start(request({ cues: source }), 11);
  for (let index = 0; index < 3; index++) {
    await until(() => api.calls.length > index);
    api.calls[index].release(new Response('{}', { status: 503 }));
  }
  await until(async () => (await service.status(task.id)).state === 'failed');
  await service.position(position(task.id, { position: 1000, reason: 'seek' }), 11);
  await service.position(position(task.id, { sequence: 3, position: 0, reason: 'seek' }), 11);
  assert.equal(api.calls.length, 3, 'eviction does not grant a fourth attempt');
  assert.equal((await service.status(task.id)).state, 'failed');
  await service.position(position(task.id, { sequence: 4, position: 500, reason: 'seek' }), 11);
  assert.deepEqual(api.calls[3].ids, ['50']);
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 1);
  await settle(api, service, task.id);
});

test('cancel during the third dispatch then explicit paused resume restores only the failure budget', async t => {
  const { service, api } = create(t, { concurrency: 1, retryDelaysMs: [0, 0] });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  for (let index = 0; index < 2; index++) {
    await until(() => api.calls.length > index);
    api.calls[index].release(new Response('{}', { status: 503 }));
  }
  await until(() => api.calls.length === 3);
  await service.cancel(task.id);
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  await service.resume(task.id);
  assert.equal(api.calls.length, 3, 'explicit resume cannot grant viewing demand');
  await service.position(position(task.id), 11);
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 4);
  api.calls[3].release(new Response('{}', { status: 503 }));
  await until(async () => api.calls.length === 5 || (await service.status(task.id)).state === 'failed');
  assert.equal(api.calls.length, 5, 'cancelled segment cleanup cannot prevent resetting the unfinished cue budget');
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 5);
  api.calls[2].release();
  await settle(api, service, task.id);
  assert.equal((await service.status(task.id)).state, 'complete');
});

test('credential refresh changes future Qwen HTTP calls without replacing a paid in-flight call', async t => {
  let config = normalizeSettings({ apiBaseUrl: settings.apiBaseUrl, model: 'qwen-mt-flash', apiKey: 'old-fixture' });
  const calls = [];
  const { service } = create(t, { concurrency: 1, loadSettings: async () => config,
    fetchImpl: (_url, options) => new Promise(resolve => calls.push({ options, body: JSON.parse(options.body),
      release(text) { resolve(new Response(JSON.stringify({ choices: [{ message: { content: text } }] }))); },
    })) });
  const source = cues.slice(0, 3);
  const task = await service.start(request({ cues: source }), 11);
  calls[0].release('MT:0');
  await until(() => calls.length === 2);
  await service.position(position(task.id, { active: false }), 11);
  config = normalizeSettings({ apiBaseUrl: settings.apiBaseUrl, model: 'qwen-mt-flash', apiKey: 'new-fixture' });
  const restarted = await service.start(request({ cues: source, playback: playback({ sequence: 3, active: false }) }), 11);
  assert.equal(restarted.id, task.id);
  assert.equal(calls.length, 2, 'credential refresh must not restart the in-flight cue');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer old-fixture');
  assert.equal(calls[1].options.signal.aborted, false);
  await service.position(position(task.id, { sequence: 4 }), 11);
  calls[1].release('MT:1');
  await until(() => calls.length === 3);
  assert.equal(calls[2].options.headers.Authorization, 'Bearer new-fixture');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer old-fixture', 'sent headers remain a snapshot');
  assert.equal(calls[2].body.messages[0].content, 'Caption 2');
  calls[2].release('MT:2');
  await until(async () => (await service.status(task.id)).state === 'complete');
  assert.deepEqual((await service.status(task.id)).translations.map(row => row.text), ['MT:0', 'MT:1', 'MT:2']);
});

test('a failed sibling retains completion eligibility but no losing candidate text in task memory', async t => {
  const { service, api } = create(t, { concurrency: 1, loadSettings: async () => multiSettings() });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  const winner = modelCall(api, 'quality-model');
  winner.release(response(winner.options, 'selected-candidate:'));
  await until(async () => (await service.status(task.id)).translatedCount === 3);
  const loser = modelCall(api, 'fast-model');
  loser.release(response(loser.options, 'discarded-candidate:'));
  modelCall(api, 'balanced-model').release(new Response('{}', { status: 401 }));
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  // entry() is the service's existing inspection seam. Check reachability, not
  // any particular Map/Set/request representation of completion bookkeeping.
  const seen = new Set(), strings = [];
  const visit = value => {
    if (typeof value === 'string') { strings.push(value); return; }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) for (const [key, item] of value) { visit(key); visit(item); }
    else for (const item of value instanceof Set ? value : Object.values(value)) visit(item);
  };
  visit(service.entry(task.id));
  assert.equal(strings.filter(value => value.startsWith('discarded-candidate:')).length, 0);
  assert.equal(strings.filter(value => value.startsWith('selected-candidate:')).length, 3);
  await service.resume(task.id);
  assert.equal(api.calls.length, 4, 'only the failed sibling can dispatch again');
  assert.equal(JSON.parse(api.calls[3].options.body).model, 'balanced-model');
  await settle(api, service, task.id);
  assert.ok((await service.status(task.id)).translations.every(row => row.text.startsWith('selected-candidate:')));
});

test('sibling-selected rows do not erase a retrying upgrade on seek or a deliberate paused resume', async t => {
  let now = 1000;
  const { service, api } = create(t, { now: () => now, concurrency: 1, retryDelaysMs: [1000, 1000],
    loadSettings: async () => multiSettings({ balanced: { enabled: false } }) });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  modelCall(api, 'quality-model').release(new Response('{}', { status: 503 }));
  modelCall(api, 'fast-model').release();
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  await service.position(position(task.id, { position: 1000, reason: 'seek' }), 11);
  await service.position(position(task.id, { sequence: 3, position: 0, reason: 'seek' }), 11);
  assert.equal(api.calls.length, 2, 'a sibling result cannot bypass the upgrade deadline');
  now = 2000;
  await service.position(position(task.id, { sequence: 4 }), 11);
  assert.equal(api.calls.length, 3, 'the upgrade survives eviction even when every timeline cue is usable');
  assert.equal(JSON.parse(api.calls[2].options.body).model, 'quality-model');
  api.calls[2].release(new Response('{}', { status: 503 }));
  await until(async () => (await service.status(task.id)).retryingCount === 1);
  now = 3000;
  await service.position(position(task.id, { sequence: 5 }), 11);
  api.calls[3].release(new Response('{}', { status: 503 }));
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  await service.position(position(task.id, { sequence: 6, position: 1000, reason: 'seek' }), 11);
  await service.position(position(task.id, { sequence: 7, position: 0, active: false }), 11);
  await service.resume(task.id);
  assert.equal(api.calls.length, 4, 'manual resume while paused grants no demand');
  await service.position(position(task.id, { sequence: 8 }), 11);
  assert.equal(api.calls.length, 5);
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 4);
  api.calls[4].release(response(api.calls[4].options, 'upgraded:'));
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  assert.ok((await service.status(task.id)).translations.every(row => row.text.startsWith('upgraded:')));
  assert.equal(api.calls.filter(call => JSON.parse(call.options.body).model === 'fast-model').length, 1);
});

test('queued and retrying dispatches use refreshed credentials while preserving paid rows and backoff', async t => {
  for (const mode of ['chat-retry', 'mt-queued']) {
    let now = 1000;
    let config = normalizeSettings({ apiBaseUrl: settings.apiBaseUrl, model: mode === 'mt-queued' ? 'qwen-mt-flash' : 'fixture-model', apiKey: 'old-fixture' });
    const calls = [];
    const { service } = create(t, { concurrency: 1, now: () => now, retryDelaysMs: [100_000, 100_000], loadSettings: async () => config,
      fetchImpl: (_url, options) => new Promise(resolve => calls.push({ options,
        release(value) { resolve(value instanceof Response ? value : mode === 'mt-queued'
          ? new Response(JSON.stringify({ choices: [{ message: { content: value } }] })) : response(options)); },
      })) });
    const source = cues.slice(0, 2);
    const task = await service.start(request({ cues: source }), 11);
    await service.position(position(task.id, { active: false }), 11);
    calls[0].release(mode === 'mt-queued' ? 'MT:0' : new Response('{}', { status: 503 }));
    await until(async () => (await service.status(task.id)).inFlightCount === 0);
    config = { ...config, models: config.models.map(model => ({ ...model, apiKey: 'new-fixture' })) };
    assert.equal((await service.start(request({ cues: source, playback: playback({ sequence: 3, active: false }) }), 11)).id, task.id);
    assert.equal(calls.length, 1);
    await service.position(position(task.id, { sequence: 4 }), 11);
    if (mode === 'chat-retry') {
      assert.equal(calls.length, 1, 'refreshing credentials does not reset backoff');
      now = 101_000;
      await service.position(position(task.id, { sequence: 5 }), 11);
    }
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers.Authorization, 'Bearer new-fixture');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer old-fixture');
    if (mode === 'mt-queued') assert.equal(JSON.parse(calls[1].options.body).messages[0].content, 'Caption 1');
    calls[1].release('MT:1');
    await until(async () => (await service.status(task.id)).state === 'complete');
    assert.equal((await service.status(task.id)).metrics.requestCount, 2);
  }
});

test('a Qwen sibling seek preserves chat-selected cues and only resumes the unfinished model/cue', async t => {
  const config = multiSettings({ quality: { model: 'qwen-mt-flash' }, balanced: { enabled: false } });
  const calls = [];
  const { service } = create(t, { concurrency: 1, retryDelaysMs: [0, 0], loadSettings: async () => config,
    fetchImpl: (_url, options) => new Promise(resolve => {
      const body = JSON.parse(options.body);
      calls.push({ body, release(value) { resolve(value instanceof Response ? value : body.model === 'qwen-mt-flash'
        ? new Response(JSON.stringify({ choices: [{ message: { content: value } }] })) : response(options, 'chat:')); } });
    }) });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  calls[1].release(); calls[0].release('MT:0');
  for (let index = 2; index <= 4; index++) {
    await until(() => calls.length > index);
    calls[index].release(new Response('{}', { status: 503 }));
  }
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  await service.position(position(task.id, { position: 20, reason: 'seek' }), 11);
  assert.equal(calls.length, 6);
  assert.deepEqual((await service.status(task.id)).activeRequests.map(({ ids, attempt, modelId }) => ({ ids, attempt, modelId })),
    [{ ids: ['2'], attempt: 1, modelId: 'quality' }]);
  calls[5].release('MT:2');
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  assert.deepEqual((await service.status(task.id)).translations.map(row => row.text), ['MT:0', 'chat:Caption 1', 'MT:2']);
  await service.position(position(task.id, { sequence: 3, position: 1000, reason: 'seek' }), 11);
  await service.position(position(task.id, { sequence: 4, position: 0, active: false }), 11);
  await service.resume(task.id);
  assert.equal(calls.length, 6);
  await service.position(position(task.id, { sequence: 5 }), 11);
  assert.equal(calls.length, 7);
  assert.equal(calls[6].body.messages[0].content, 'Caption 1');
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 4);
  calls[6].release('MT:1');
  await until(async () => (await service.status(task.id)).state === 'complete');
  assert.equal(calls.filter(call => call.body.model === 'fast-model').length, 1);
});

test('resuming while a sibling owns the slot does not replay a length-rejected parent batch', async t => {
  const { service, api } = create(t, { concurrency: 1, loadSettings: async () => multiSettings({ balanced: { enabled: false } }) });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  modelCall(api, 'quality-model').release(new Response('{}', { status: 413 }));
  await tick();
  await service.position(position(task.id, { active: false }), 11);
  await service.resume(task.id);
  assert.equal(api.calls.length, 2);
  await service.position(position(task.id, { sequence: 3 }), 11);
  assert.equal(api.calls.length, 2, 'the paid sibling retains its segment slot');
  modelCall(api, 'fast-model').release();
  await until(() => api.calls.length === 3);
  assert.deepEqual(api.calls[2].ids, ['0', '1']);
  await settle(api, service, task.id);
  assert.deepEqual(api.calls.filter(call => JSON.parse(call.options.body).model === 'quality-model').map(call => call.ids),
    [['0', '1', '2'], ['0', '1'], ['2']]);
});

test('length split resubmissions retain each cue dispatch history through further splits', async t => {
  const { service, api } = create(t, { concurrency: 1 });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  api.calls[0].release(new Response('{}', { status: 413 }));
  await until(() => api.calls.length === 2);
  assert.deepEqual(api.calls[1].ids, ['0', '1']);
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 2);
  api.calls[1].release(new Response('{}', { status: 413 }));
  await until(() => api.calls.length === 3);
  assert.deepEqual(api.calls[2].ids, ['2']);
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 2);
  api.calls[2].release();
  await until(() => api.calls.length === 4);
  assert.deepEqual(api.calls[3].ids, ['0']);
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 3);
  await settle(api, service, task.id);
  assert.equal((await service.status(task.id)).state, 'complete');
});

test('manual resume retries only failed models with refreshed credentials and preserves completed model rows', async t => {
  let config = multiSettings({ balanced: { enabled: false } });
  const { service, api } = create(t, { loadSettings: async () => config, concurrency: 1 });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  modelCall(api, 'quality-model').release(new Response('{}', { status: 401 }));
  modelCall(api, 'fast-model').release();
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  config = { ...config, models: config.models.map(model => ({ ...model, apiKey: 'replacement-fixture' })) };
  await service.resume(task.id);
  assert.equal(api.calls.length, 3);
  assert.equal(JSON.parse(api.calls[2].options.body).model, 'quality-model');
  assert.equal(api.calls[2].options.headers.Authorization, 'Bearer replacement-fixture');
  assert.equal((await service.status(task.id)).activeRequests[0].attempt, 2);
  await settle(api, service, task.id);
  assert.equal(api.calls.filter(call => JSON.parse(call.options.body).model === 'fast-model').length, 1);
});

test('resuming a failed upgrade still requires origin permission when another model filled every cue', async t => {
  let allowed = true;
  const config = multiSettings({ balanced: { enabled: false } });
  const { service, api } = create(t, { loadSettings: async () => config, hasPermission: async () => allowed, concurrency: 1 });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  modelCall(api, 'quality-model').release(new Response('{}', { status: 401 }));
  modelCall(api, 'fast-model').release();
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  allowed = false;
  await assert.rejects(service.resume(task.id), /尚未授权/);
  assert.equal(api.calls.length, 2);
});

test('mixed MT and chat models keep three segment slots and gate every sequential HTTP dispatch after hiding', async t => {
  const config = multiSettings({ quality: { model: 'qwen-mt-plus' }, balanced: { model: 'qwen-mt-flash' } });
  const calls = [];
  const { service, local } = create(t, { loadSettings: async () => config,
    fetchImpl: (_url, options) => new Promise(resolve => {
      const body = JSON.parse(options.body), mt = body.model.startsWith('qwen-mt-');
      calls.push({ model: body.model,
        ids: mt ? [cues.find(cue => cue.text === body.messages[0].content).id]
          : JSON.parse(body.messages[1].content).subtitles.map(cue => cue.id),
        release() { resolve(mt ? new Response(JSON.stringify({ choices: [{ message: { content: 'MT' } }] })) : response(options)); },
      });
    }),
  });
  const task = await service.start(request(), 11);
  assert.equal(calls.length, 9);
  assert.equal(task.inFlightCount, 9);
  assert.equal(task.inFlightSegmentCount, 3);
  await service.position(position(task.id, { active: false, reason: 'visibility' }), 11);
  calls.forEach(call => call.release());
  await until(async () => (await service.status(task.id)).inFlightCount === 0);
  assert.equal(calls.length, 9, 'hidden sequential MT work cannot submit its next cue');
  await service.position(position(task.id, { sequence: 3 }), 11);
  assert.equal(calls.length, 15);
  const current = await service.status(task.id);
  assert.equal(current.inFlightCount, 6);
  assert.equal(current.inFlightSegmentCount, 3);
  assert.ok(current.activeRequests.every(item => item.attempt === 1));
  for (const model of ['qwen-mt-plus', 'qwen-mt-flash', 'fast-model']) {
    const ids = calls.filter(call => call.model === model).flatMap(call => call.ids);
    assert.equal(new Set(ids).size, ids.length, model);
  }
  assert.equal(local.writes, 0);
});

test('fixed playback stops within a shared 120-second horizon; results are public without disk writes', async t => {
  const { service, local, api } = create(t);
  const task = await service.start(request(), 11);
  assert.equal(api.calls.length, 3);
  const result = await settle(api, service, task.id);
  const ids = api.calls.flatMap(c => c.ids);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => cues[Number(id)].start < 120));
  assert.equal(result.translatedCount, 12); assert.equal(result.state, 'buffered');
  assert.equal(local.writes, 0); assert.deepEqual(local.saved, {});
  await tick(); assert.equal(api.calls.length, 3);
});

test('buffer replenishes only below low water; a faster rate cannot expand the hard horizon', async t => {
  const { service, api } = create(t);
  const task = await service.start(request(), 11); await settle(api, service, task.id);
  await service.position(position(task.id, { position: 40, rate: 16 }), 11);
  assert.equal(api.calls.length, 3);
  await service.position(position(task.id, { sequence: 3, position: 70, rate: 16 }), 11);
  await settle(api, service, task.id);
  assert.ok(api.calls.length > 3);
  assert.ok(api.calls.slice(3).flatMap(c => c.ids).every(id => cues[Number(id)].start < 190));
});

test('pause, hide, disable, detach and navigation prevent new submissions after in-flight replies', async t => {
  for (const reason of ['pause', 'visibility', 'toggle', 'detach', 'navigation']) {
    const { service, api } = create(t);
    const task = await service.start(request(), 11);
    if (reason === 'navigation') service.detach(11);
    else await service.position(position(task.id, { active: false, reason }), 11);
    const before = api.calls.length;
    const result = await settle(api, service, task.id);
    assert.equal(api.calls.length, before, reason);
    assert.ok(result.translatedCount > 0); assert.equal(result.state, 'paused');
    assert.ok(api.calls.every(call => !call.options.signal.aborted));
  }
});

test('a pause observed while a start is loading prevents even the first API request', async t => {
  let release;
  const config = new Promise(resolve => { release = resolve; });
  const { service, api } = create(t, { loadSettings: () => config });
  const pending = service.start(request(), 11);
  await service.position({ videoId: 'fixture-video', ...playback({ sequence: 2, active: false }) }, 11);
  release(settings); const task = await pending;
  assert.equal(api.calls.length, 0); assert.equal(task.state, 'paused');
});

test('stale state and retired document sessions cannot reactivate a newer view', async t => {
  const { service, api } = create(t);
  const task = await service.start(request({ playback: playback({ active: false }) }), 11);
  await service.position(position(task.id, { session: 'new-document', active: false }), 11);
  await service.position(position(task.id, { session: 'page-a', sequence: 99, active: true }), 11);
  await service.position(position(task.id, { session: 'new-document', sequence: 1, active: true }), 11);
  assert.equal(api.calls.length, 0);
});

test('expired viewing leases cannot create another request; valid heartbeats can resume missing ranges', async t => {
  let now = 100;
  const { service, api } = create(t, { now: () => now });
  const task = await service.start(request(), 11);
  now += 11_000; await settle(api, service, task.id);
  assert.equal((await service.status(task.id)).state, 'paused');
  await service.position(position(task.id, { position: 150 }), 11);
  assert.ok(api.calls.length > 3);
});

test('seeks preserve in-flight work and never backfill skipped gaps', async t => {
  const { service, api } = create(t);
  const task = await service.start(request(), 11);
  await service.position(position(task.id, { reason: 'seek', position: 650 }), 11);
  assert.equal(api.calls.length, 3);
  api.calls[0].release(); await until(() => api.calls.length > 3);
  assert.ok(api.calls[3].ids.every(id => Number(id) >= 65 && Number(id) < 77));
  await settle(api, service, task.id);
  assert.ok(api.calls.flatMap(c => c.ids).every(id => Number(id) < 12 || Number(id) >= 65));
  const before = api.calls.length;
  await service.position(position(task.id, { sequence: 3, position: 1200, reason: 'seek' }), 11);
  assert.equal(api.calls.length, before);
});

test('a sparse gap cannot pull a distant cue outside the horizon; overlapping boundary cue stays whole', async t => {
  const { service, api } = create(t);
  const source = [{ id: 'a', start: 0, end: 180, text: 'long cue' }, { id: 'b', start: 200, end: 202, text: 'distant' }];
  const task = await service.start(request({ cues: source }), 11);
  await settle(api, service, task.id);
  assert.deepEqual(api.calls.flatMap(c => c.ids), ['a']);
});

test('same video shares three slots across pages, and one paused page does not stop another viewer', async t => {
  const { service, api } = create(t);
  const [a, b] = await Promise.all([service.start(request(), 11), service.start(request({ playback: playback({ session: 'page-b', position: 500 }) }), 22)]);
  assert.equal(a.id, b.id); assert.equal(api.calls.length, 3);
  await service.position(position(a.id, { active: false }), 11);
  await settle(api, service, a.id);
  assert.ok(api.calls.slice(3).flatMap(c => c.ids).every(id => Number(id) >= 50 && Number(id) < 62));
  assert.equal((await service.status(a.id)).metrics.maxConcurrency, 3);
});

test('switching video revokes old page demand; other visible pages retain independent pools', async t => {
  const { service, api } = create(t);
  const a = await service.start(request(), 11);
  const b = await service.start(request({ videoId: 'video-b', playback: playback({ sequence: 2, view: 2 }) }), 11);
  assert.equal(api.calls.length, 6);
  await settle(api, service, a.id);
  assert.equal((await service.status(a.id)).state, 'paused');
  assert.equal((await service.status(b.id)).state, 'buffered');
});

test('queued retries honor backoff and pause, without a duplicate replacement request', async t => {
  const { service, api } = create(t, { concurrency: 1 });
  const task = await service.start(request(), 11);
  api.calls[0].release(new Response('{}', { status: 429, headers: { 'Retry-After': '0.05' } }));
  await service.position(position(task.id, { active: false }), 11);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(api.calls.length, 1);
  await service.position(position(task.id, { sequence: 3, active: true }), 11);
  assert.deepEqual(api.calls[1].ids, api.calls[0].ids);
  await settle(api, service, task.id);
  const counts = api.calls.flatMap(c => c.ids).filter(id => id === '0').length;
  assert.equal(counts, 2);
});

test('retry exhaustion retains successful rows; manual resume requests only missing current rows', async t => {
  const { service, api } = create(t, { concurrency: 1, retryDelaysMs: [0, 0] });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  for (let attempt = 0; attempt < 3; attempt++) {
    await until(() => api.calls.length > attempt);
    api.calls[attempt].release(new Response('{}', { status: 503 })); await tick();
  }
  await until(async () => (await service.status(task.id)).state === 'failed');
  await service.resume(task.id);
  await settle(api, service, task.id);
  assert.equal((await service.status(task.id)).translatedCount, 3);
});

test('seeking into a rate-limited segment preserves its retry deadline for the remaining cues', async t => {
  const { service, api } = create(t, { concurrency: 1 });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
  api.calls[0].release(new Response('{}', { status: 429, headers: { 'Retry-After': '0.1' } }));
  await tick();
  await service.position(position(task.id, { position: 10, reason: 'seek' }), 11);
  assert.equal(api.calls.length, 1);
  await until(() => api.calls.length === 2);
  assert.deepEqual(api.calls[1].ids, ['1', '2']);
  await settle(api, service, task.id);
});

test('authentication errors stop retries, malformed responses stay bounded and length rejection splits', async t => {
  for (const mode of ['config', 'malformed', 'length']) {
    const { service, api } = create(t, { concurrency: 1, retryDelaysMs: [0, 0] });
    const task = await service.start(request({ cues: cues.slice(0, 3) }), 11);
    api.calls[0].release(mode === 'config' ? new Response('secret', { status: 401 }) : mode === 'length' ? new Response('{}', { status: 413 }) : new Response('{}'));
    await tick();
    if (mode === 'config') { assert.equal(api.calls.length, 1); assert.equal((await service.status(task.id)).state, 'failed'); }
    else { await settle(api, service, task.id); assert.equal((await service.status(task.id)).translatedCount, 3); }
    assert.ok(!JSON.stringify(await service.status(task.id)).includes('secret'));
  }
});

test('explicit cancellation isolates late callbacks; resuming alone cannot create watching demand', async t => {
  const { service, api } = create(t);
  const task = await service.start(request(), 11);
  await service.cancel(task.id); await service.resume(task.id);
  for (const call of api.calls) call.release(); await tick();
  assert.equal(api.calls.length, 3);
  assert.equal((await service.status(task.id)).translatedCount, 0);
  await service.position(position(task.id, { sequence: 3 }), 11);
  await settle(api, service, task.id);
  assert.ok((await service.status(task.id)).translatedCount > 0);
});

test('configuration snapshots isolate paid requests; source/config changes isolate reuse but key rotation does not', async t => {
  let current = settings;
  const { service, api } = create(t, { loadSettings: async () => current });
  const first = await service.start(request(), 11); await settle(api, service, first.id);
  current = { ...settings, apiKey: 'rotated' };
  assert.equal((await service.start(request({ playback: playback({ sequence: 2 }) }), 11)).id, first.id);
  current = { ...current, model: 'new-model', models: current.models.map(profile => ({ ...profile, model: 'new-model' })) };
  const next = await service.start(request({ playback: playback({ sequence: 3 }) }), 11);
  assert.notEqual(next.id, first.id);
  assert.equal(JSON.parse(api.calls.at(-1).options.body).model, 'new-model');
});

test('legacy cache reads do not mutate stored data and exports keep timestamps', async t => {
  const local = storage();
  const { service, api } = create(t, { storage: local });
  const task = await service.start(request({ cues: cues.slice(0, 3) }), 11); await settle(api, service, task.id);
  const full = await service.status(task.id);
  local.saved['track:v1:' + task.id] = { ...full, version: 1,
    configFingerprint: service.entry(task.id).record.configFingerprint };
  const before = structuredClone(local.saved);
  const fresh = create(t, { storage: local, hasPermission: async () => false });
  const loaded = await fresh.service.start(request({ cues: cues.slice(0, 3), playback: playback({ active: false }) }), 11);
  assert.equal(loaded.translatedCount, 3); assert.equal(fresh.api.calls.length, 0);
  assert.deepEqual(local.saved, before);
  assert.match((await fresh.service.export(task.id, 'bilingual')).content, /00:00:10,000 --> 00:00:13,000/);
});

test('default restart discards temporary subtitles; no state is charged or persisted without a valid viewer', async t => {
  const { service, api, local } = create(t);
  const task = await service.start(request(), 11); await settle(api, service, task.id);
  const fresh = create(t, { storage: local });
  assert.deepEqual(await fresh.service.list(), []);
  await fresh.service.start(request({ playback: undefined }));
  assert.equal(fresh.api.calls.length, 0);
  assert.equal(local.writes, 0);
});

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
function response(options) {
  const rows = JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: rows.map(row => ({ id: row.id, text: '译:' + row.text })) }) } }] }));
}
function apiFixture() {
  const calls = [];
  return { calls, fetchImpl: (_url, options) => new Promise(resolve => calls.push({ options,
    ids: JSON.parse(JSON.parse(options.body).messages[1].content).subtitles.map(row => row.id),
    release(value = response(options)) { if (!this.released) { this.released = true; resolve(value); } },
  })) };
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
  current = { ...current, model: 'new-model' };
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

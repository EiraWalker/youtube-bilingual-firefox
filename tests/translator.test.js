import test from 'node:test';
import assert from 'node:assert/strict';
import { apiOriginPattern, completionEndpoint, normalizeSettings, publicSettings } from '../src/shared/settings.js';
import { parseTranslations, translateCues, translateTrack, TranslationService } from '../src/background/translator.js';

const settings = normalizeSettings({ apiBaseUrl: 'http://127.0.0.1:9876/v1', apiKey: 'test-only-key', model: 'fixture-model' });
const cues = [{ id: 'a', text: 'Hello' }, { id: 'b', text: 'World' }];
const response = rows => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: rows }) } }] }), { headers: { 'Content-Type': 'application/json' } });

test('API endpoints accept base or complete URLs and Firefox permissions omit port', () => {
  assert.equal(completionEndpoint('https://example.com/'), 'https://example.com/v1/chat/completions');
  assert.equal(completionEndpoint('https://example.com/api/v1/'), 'https://example.com/api/v1/chat/completions');
  assert.equal(completionEndpoint('http://localhost:8000/v1/chat/completions'), 'http://localhost:8000/v1/chat/completions');
  assert.equal(apiOriginPattern(settings), 'http://127.0.0.1/*');
  for (const url of ['file:///tmp/api', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret']) assert.throws(() => completionEndpoint(url));
});

test('public settings never include credentials, model or API address', () => {
  const publicValue = publicSettings(settings);
  assert.equal(publicValue.ready, true);
  assert.ok(!('apiKey' in publicValue) && !('apiBaseUrl' in publicValue) && !('model' in publicValue));
  assert.equal(publicSettings(normalizeSettings()).ready, false);
});

test('model output is reordered by ID; missing, unknown and duplicate IDs fail', () => {
  assert.deepEqual(parseTranslations('```json\n{"translations":[{"id":"b","text":"世界"},{"id":"a","text":"你好"}]}\n```', cues), [{ id: 'a', text: '你好' }, { id: 'b', text: '世界' }]);
  for (const rows of [[{ id: 'a', text: '你好' }], [{ id: 'a', text: '你好' }, { id: 'a', text: '重复' }], [{ id: 'a', text: '你好' }, { id: 'c', text: '未知' }]]) {
    assert.throws(() => parseTranslations(JSON.stringify({ translations: rows }), cues));
  }
  assert.throws(() => parseTranslations('not JSON', cues), /JSON/);
});

test('Chat Completions sends only text and IDs with configured model and bearer key', async () => {
  let captured;
  const translated = await translateCues(settings, [{ id: 'a', text: 'Hello', start: 10, end: 20 }], {
    fetchImpl: async (url, options) => { captured = { url, ...options }; return response([{ id: 'a', text: '你好' }]); },
  });
  assert.equal(captured.url, 'http://127.0.0.1:9876/v1/chat/completions');
  assert.equal(captured.headers.Authorization, 'Bearer test-only-key');
  assert.equal(captured.credentials, 'omit');
  const body = JSON.parse(captured.body);
  assert.equal(body.model, 'fixture-model');
  assert.equal(body.stream, false);
  assert.deepEqual(JSON.parse(body.messages[1].content), { subtitles: [{ id: 'a', text: 'Hello' }] });
  assert.deepEqual(translated, [{ id: 'a', text: '你好' }]);
});

test('HTTP failures redact provider response and distinguish authentication and rate limits', async () => {
  for (const code of [401, 429, 500]) {
    await assert.rejects(translateCues(settings, cues, { fetchImpl: async () => new Response('provider-secret', { status: code }) }), error => error.message.includes(String(code)) && !error.message.includes('provider-secret'));
  }
});

test('timeout and explicit cancellation release the in-flight request', async () => {
  const abortingFetch = (_url, { signal }) => new Promise((_, reject) => {
    if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
    else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(translateCues(settings, cues, { fetchImpl: abortingFetch, timeoutMs: 15 }), /超时/);
  const controller = new AbortController();
  const pending = translateCues(settings, cues, { fetchImpl: abortingFetch, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /取消/);
});

test('service caches text across IDs, isolates target languages and honors permissions', async () => {
  let calls = 0, current = settings;
  const service = new TranslationService({ loadSettings: async () => current, hasPermission: async () => true, fetchImpl: async (_url, options) => {
    calls++;
    return response(JSON.parse(JSON.parse(options.body).messages[1].content).subtitles.map(cue => ({ id: cue.id, text: `译:${cue.text}` })));
  } });
  await service.translate('one', cues);
  assert.deepEqual(await service.translate('two', [{ id: 'other', text: 'Hello' }]), [{ id: 'other', text: '译:Hello' }]);
  assert.equal(calls, 1);
  current = { ...settings, targetLanguage: 'ja' };
  await service.translate('three', cues);
  assert.equal(calls, 2);
  const denied = new TranslationService({ loadSettings: async () => settings, hasPermission: async () => false, fetchImpl: () => { assert.fail('must not fetch'); } });
  await assert.rejects(denied.translate('denied', cues), /授权/);
});

test('canceling a queued video prevents its API request and a later video still works', async () => {
  let release, calls = 0;
  const service = new TranslationService({ loadSettings: async () => settings, hasPermission: async () => true, fetchImpl: async (_url, options) => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return response(JSON.parse(JSON.parse(options.body).messages[1].content).subtitles.map(cue => ({ id: cue.id, text: `译:${cue.text}` })));
  } });
  const first = service.translate('first', [{ id: '1', text: 'First' }]);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const abandoned = service.translate('old-video', [{ id: '2', text: 'Old' }]);
  service.cancel('old-video');
  const assertion = assert.rejects(abandoned, /取消/);
  release();
  await first; await assertion;
  await service.translate('new-video', [{ id: '3', text: 'New' }]);
  assert.equal(calls, 2);
});

test('a complete long track is sent in one request, including captions far beyond playback', async () => {
  const track = Array.from({ length: 160 }, (_, index) => ({ id: String(index), start: index * 100, end: index * 100 + 2, text: `Complete caption ${index} ${'words '.repeat(30)}` }));
  let calls = 0;
  const result = await translateTrack(settings, track, { fetchImpl: async (_url, options) => {
    calls++;
    const rows = JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
    assert.equal(rows.length, track.length);
    return response(rows.map(cue => ({ id: cue.id, text: `译:${cue.text}` })));
  } });
  assert.equal(calls, 1);
  assert.equal(result.length, 160);
});

test('only provider length rejection or output truncation permits whole-track splitting', async () => {
  for (const lengthFailure of [
    () => new Response('too large', { status: 413 }),
    () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'provider-secret' } }), { status: 400 }),
    () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'cut-off JSON' } }] })),
  ]) {
    let calls = 0;
    const result = await translateTrack(settings, cues, { fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) return lengthFailure();
      const rows = JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
      return response(rows.map(cue => ({ id: cue.id, text: `译:${cue.text}` })));
    } });
    assert.equal(calls, 3);
    assert.deepEqual(result.map(row => row.id), ['a', 'b']);
  }
});

test('rate limits, malformed JSON and missing IDs never trigger smaller retry requests', async () => {
  for (const failure of [
    () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 429 }),
    () => new Response(JSON.stringify({ error: { message: 'invalid model' } }), { status: 400 }),
    () => new Response(JSON.stringify({ choices: [{ message: { content: 'bad JSON' } }] })),
    () => response([{ id: 'a', text: 'Only first caption' }]),
  ]) {
    let calls = 0;
    await assert.rejects(translateTrack(settings, cues, { fetchImpl: async () => { calls++; return failure(); } }));
    assert.equal(calls, 1);
  }
});

test('a single caption that exceeds provider context fails without infinite splitting', async () => {
  let calls = 0;
  await assert.rejects(translateTrack(settings, [cues[0]], { fetchImpl: async () => { calls++; return new Response('', { status: 413 }); } }), /过长/);
  assert.equal(calls, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { apiOriginPattern, enabledModels, publicSettings, readSettings } from '../src/shared/settings.js';
import { TranslationService, translateCues } from '../src/background/translator.js';
import { TrackTaskService } from '../src/background/track-tasks.js';

const source = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');

test('connection testing targets the selected enabled profile and checks its own origin permission', async t => {
  const calls = [], origins = [], logs = [];
  const config = { targetLanguage: 'zh-CN', models: [
    { id: 'first', apiBaseUrl: 'http://localhost:9876/v1', model: 'first-model', enabled: true, priority: 2 },
    { id: 'quality', apiBaseUrl: 'http://quality.example/v1', model: 'quality-model', enabled: true, priority: 1 },
    { id: 'off', apiBaseUrl: 'http://disabled.example/v1', model: 'off-model', enabled: false, priority: 1 },
  ] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"translations":[{"id":"test","text":"测试译文"}]}' } }] }));
  });
  let onMessage;
  const context = vm.createContext({
    apiOriginPattern, enabledModels, publicSettings, readSettings, TranslationService, translateCues, TrackTaskService,
    SubtitleCache: class {}, URL, crypto: webcrypto,
    console: { warn: (...args) => logs.push(args) },
    browser: {
      storage: { local: { async get() { return { settings: config }; } } },
      permissions: { async contains(value) { origins.push(value.origins); return !value.origins.includes('http://quality.example/*') || origins.length === 1; } },
      runtime: { getURL: path => 'moz-extension://fixture/' + path, onMessage: { addListener(listener) { onMessage = listener; } } },
    },
  });
  vm.runInContext(source, context);
  const sender = { url: 'moz-extension://fixture/options.html' };
  const result = await onMessage({ type: 'api:test', modelId: 'quality' }, sender);
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'http://quality.example/v1/chat/completions');
  assert.equal(calls[0].body.model, 'quality-model');
  assert.deepEqual(Array.from(origins[0]), ['http://quality.example/*']);
  assert.equal((await onMessage({ type: 'api:test', modelId: 'quality' }, sender)).ok, false, 'permission refusal prevents fetch');
  assert.equal((await onMessage({ type: 'api:test', modelId: 'off' }, sender)).ok, false);
  assert.equal((await onMessage({ type: 'api:test', modelId: 'missing' }, sender)).ok, false);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /quality\.example|disabled\.example/);
});

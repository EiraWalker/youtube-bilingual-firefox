import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { apiOriginPattern, normalizeSettings, SETTINGS_KEY, validateSettings } from '../src/shared/settings.js';

const source = readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/, '');
function element(tag = 'div') {
  const handlers = new Map();
  return {
    tag, textContent: '', children: [], dataset: {}, value: '', type: 'text', disabled: false,
    style: { setProperty() {} }, parentElement: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {}, reportValidity: () => true,
    addEventListener(name, handler) { handlers.set(name, handler); },
    async emit(name) { await handlers.get(name)?.({ preventDefault() {}, currentTarget: this }); },
  };
}
function allNodes(root) { return [root, ...root.children.flatMap(allNodes)]; }
async function fixture(records, extraRespond = async () => null) {
  const elements = new Map(), logs = [], calls = [];
  const settings = normalizeSettings({ apiBaseUrl: 'http://localhost:8045/v1', apiKey: 'fixture-key', model: 'fixture-model' });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('autoEnable').type = 'checkbox';
  const context = vm.createContext({ apiOriginPattern, normalizeSettings, SETTINGS_KEY, validateSettings,
    readSettings: async () => settings,
    document: { hidden: false, getElementById: get, createElement: element },
    ResizeObserver: class { observe() {} },
    console: { error: (...args) => logs.push(args) }, setInterval() {},
    browser: { permissions: { request: async () => true }, storage: { local: { set: async () => {} } },
      runtime: { async sendMessage(message) {
        calls.push(message);
        if (message.type === 'track:list') return { ok: true, data: records };
        return { ok: true, data: await extraRespond(message) };
      } } },
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, logs, calls, context, elements };
}
const record = (overrides = {}) => ({ id: 'task-a', videoId: 'fixture0001', title: 'Video', state: 'paused',
  track: { language: 'en', automatic: false }, targetLanguage: 'zh-CN', model: 'fixture-model',
  total: 10, translatedCount: 4, canResume: true, ...overrides });

test('saved library shows partial counts and resumes only missing work; translated export remains gated', async () => {
  const f = await fixture([record({ error: 'provider-secret' })]);
  const card = f.get('library-list').children[0], nodes = allNodes(card);
  const text = nodes.map(n => n.textContent).join(' ');
  assert.match(text, /已翻译 4 \/ 10/);
  assert.doesNotMatch(text, /provider-secret/);
  const mode = nodes.find(n => n.tag === 'select');
  const download = nodes.find(n => n.textContent === '导出 SRT');
  assert.equal(mode.value, 'original');
  assert.equal(download.disabled, false);
  mode.value = 'translated'; await mode.emit('change');
  assert.equal(download.disabled, true);
  await nodes.find(n => n.textContent === '恢复翻译').emit('click');
  assert.equal(f.calls.filter(c => c.type === 'track:resume').length, 1);
  assert.equal(f.calls.find(c => c.type === 'track:resume').id, 'task-a');
});

test('library operation and API test failures remain neutral in UI and do not echo provider secrets into console', async () => {
  const f = await fixture([record()], async () => { throw new Error('Authorization: Bearer provider-secret'); });
  const nodes = allNodes(f.get('library-list'));
  await nodes.find(n => n.textContent === '恢复翻译').emit('click');
  await f.get('test').emit('click');
  const visibleText = [...f.elements.values()].flatMap(allNodes).map(n => n.textContent).join(' ');
  assert.doesNotMatch(visibleText + JSON.stringify(f.logs), /provider-secret|Authorization/);
  assert.equal(f.get('status').dataset.error, 'false');
  assert.match(f.get('status').textContent, /控制台/);
  assert.ok(f.logs.length >= 2);
});

test('a retrying library task exposes cancellation instead of another resume and keeps original export available', async () => {
  const f = await fixture([record({ state: 'retrying', retryingCount: 1, canResume: false })]);
  const nodes = allNodes(f.get('library-list'));
  assert.ok(nodes.some(n => n.textContent === '等待重试'));
  assert.ok(nodes.some(n => n.textContent === '取消翻译'));
  assert.equal(nodes.some(n => n.textContent === '恢复翻译'), false);
  assert.equal(nodes.find(n => n.textContent === '导出 SRT').disabled, false);
});

test('changed cache directory is validated and normalized before settings are saved', async () => {
  const f = await fixture([], async message => message.type === 'cache:validate' ? { folder: 'validated-directory' } : null);
  f.get('cacheFolder').value = 'new-directory';
  await f.get('settings-form').emit('submit');
  assert.equal(f.calls.find(c => c.type === 'cache:validate').folder, 'new-directory');
  assert.equal(f.get('cacheFolder').value, 'validated-directory');
  assert.match(f.get('status').textContent, /已保存/);
});

test('unavailable native cache rejects changed settings; directory reveal only follows explicit action', async () => {
  const f = await fixture([], async () => { throw new Error('missing native host'); });
  assert.equal(f.calls.some(c => c.type === 'cache:open'), false);
  f.get('cacheFolder').value = 'new-directory';
  await f.get('settings-form').emit('submit');
  assert.match(f.get('status').textContent, /尚未保存/);
  await f.get('open-cache-folder').emit('click');
  assert.equal(f.calls.filter(c => c.type === 'cache:open').length, 1);
});

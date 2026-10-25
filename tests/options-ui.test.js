import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { apiOriginPattern, apiOriginPatterns, normalizeSettings, SETTINGS_KEY, validateSettings } from '../src/shared/settings.js';

const source = readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/, '');
const html = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
function element(tag = 'div') {
  const handlers = new Map(), attributes = new Map();
  let text = '', value = '';
  return {
    tag, children: [], dataset: {}, type: tag === 'input' ? 'text' : '', disabled: false, checked: false, required: false,
    get value() { return value; },
    set value(input) { value = String(input); },
    style: { setProperty() {} }, parentElement: null,
    get textContent() { return text + this.children.map(child => child.textContent).join(''); },
    set textContent(value) { text = String(value); this.replaceChildren(); },
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } },
    remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } },
    replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
      else this[name === 'for' ? 'htmlFor' : name] = ['disabled', 'checked', 'required', 'hidden'].includes(name) ? true : String(value);
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    reportValidity() { return allNodes(this).every(node => node.disabled || !node.required || (node.type === 'checkbox' ? node.checked : Boolean(node.value))); },
    addEventListener(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    async emit(name) { if (this.disabled) return; for (const handler of handlers.get(name) || []) await handler({ preventDefault() {}, currentTarget: this }); },
  };
}
function allNodes(root) { return [root, ...root.children.flatMap(allNodes)]; }
function parseDocument(markup) {
  const root = element('document'), stack = [root];
  const voidTags = new Set(['input', 'meta', 'link', 'br', 'hr']);
  for (const token of markup.match(/<[^>]+>|[^<]+/g)) {
    if (/^<\//.test(token)) { stack.pop(); continue; }
    if (/^<!/.test(token)) continue;
    if (!token.startsWith('<')) { const text = element('#text'); text.textContent = token; stack.at(-1).append(text); continue; }
    const [, tag, attrs] = token.match(/^<(\w+)([\s\S]*?)\/?\s*>$/) || [];
    if (!tag) continue;
    const node = element(tag);
    for (const match of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(match[1], match[2] ?? '');
    stack.at(-1).append(node);
    if (!voidTags.has(tag)) stack.push(node);
  }
  return root;
}
async function fixture(records, extraRespond = async () => null, options = {}) {
  const root = parseDocument(html), logs = [], calls = [], permissionCalls = [], writes = [];
  let settings = options.settings || normalizeSettings({ apiBaseUrl: 'http://localhost:8045/v1', apiKey: 'provider-secret', model: 'fixture-model' });
  const get = id => allNodes(root).find(node => node.id === id) || null;
  const elements = new Map(allNodes(root).filter(node => node.id).map(node => [node.id, node]));
  const context = vm.createContext({ apiOriginPattern, apiOriginPatterns, normalizeSettings, SETTINGS_KEY, validateSettings,
    readSettings: async () => settings,
    document: { hidden: false, getElementById: get, createElement: element },
    ResizeObserver: class { observe() {} },
    console: { error: (...args) => logs.push(args) }, setInterval() {},
    browser: { permissions: { request: async request => { permissionCalls.push(request); return options.granted !== false; } }, storage: { local: { set: async value => { writes.push(value); settings = value[SETTINGS_KEY]; } } },
      runtime: { async sendMessage(message) {
        calls.push(message);
        if (message.type === 'track:list') return { ok: true, data: records };
        return { ok: true, data: await extraRespond(message) };
      } } },
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, logs, calls, context, elements, root, permissionCalls, writes };
}
function byLabel(root, text) {
  const label = allNodes(root).find(node => node.tag === 'label' && node.textContent === text);
  assert.ok(label, `Missing field label: ${text}`);
  return allNodes(root).find(node => node.id === label.htmlFor);
}
function modelCards(f) { return f.get('model-list').children; }
const record = (overrides = {}) => ({ id: 'task-a', videoId: 'fixture0001', title: 'Video', state: 'paused',
  track: { language: 'en', automatic: false }, targetLanguage: 'zh-CN', model: 'fixture-model',
  total: 10, translatedCount: 4, canResume: true, ...overrides });

test('multiple saved model cards preserve editable configuration and request all enabled origins in one save', async () => {
  const settings = normalizeSettings({ models: [
    { id: 'primary', name: 'Primary', apiBaseUrl: 'https://one.example/v1', apiKey: 'primary-fixture-key', model: 'one', priority: 2 },
    { id: 'backup', name: 'Backup', apiBaseUrl: 'http://localhost:8045/v1', apiKey: 'backup-fixture-key', model: 'two', priority: 1 },
    { id: 'shared', apiBaseUrl: 'https://one.example/v1', model: 'three' },
    { id: 'draft', apiBaseUrl: '', apiKey: '', model: '', enabled: false },
  ] });
  const f = await fixture([], undefined, { settings });
  assert.equal(modelCards(f).length, 4);
  assert.equal(f.get('apiBaseUrl'), byLabel(modelCards(f)[0], 'API 地址'));
  assert.equal(f.get('apiKey').type, 'password');
  assert.equal(f.get('model').value, 'one');
  const backup = modelCards(f)[1];
  byLabel(backup, '显示名称').value = 'Edited backup';
  byLabel(backup, '优先级').value = '7';
  byLabel(backup, 'API Key').value = 'edited-fixture-key';
  assert.equal(byLabel(backup, 'API Key').type, 'password');
  assert.equal(byLabel(modelCards(f)[3], 'API 地址').required, false);
  await f.get('settings-form').emit('submit');
  assert.equal(f.permissionCalls.length, 1);
  assert.deepEqual(Array.from(f.permissionCalls[0].origins), ['https://one.example/*', 'http://localhost/*']);
  assert.equal(f.writes.length, 1);
  const saved = f.writes[0].settings;
  assert.equal(saved.models[1].name, 'Edited backup');
  assert.equal(saved.models[1].priority, 7);
  assert.equal(saved.models[1].apiKey, 'edited-fixture-key');
  assert.equal(saved.models[3].enabled, false);
  assert.equal(saved.apiKey, saved.models[0].apiKey);
  assert.match(f.get('status').textContent, /已保存/);
  assert.doesNotMatch(f.root.textContent + JSON.stringify(f.logs), /primary-fixture-key|backup-fixture-key|edited-fixture-key/);
});

test('adding, disabling and removing model cards persists stable IDs and first-profile selectors after reload', async () => {
  const f = await fixture([]);
  byLabel(modelCards(f)[0], '显示名称').value = 'Unsaved primary edit';
  await f.get('add-model').emit('click');
  assert.equal(modelCards(f).length, 2);
  assert.equal(byLabel(modelCards(f)[0], '显示名称').value, 'Unsaved primary edit');
  let added = modelCards(f)[1];
  byLabel(added, '显示名称').value = 'Secondary';
  byLabel(added, 'API 地址').value = 'https://secondary.example/v1';
  byLabel(added, 'API Key').value = 'secondary-fixture-key';
  byLabel(added, '模型名称').value = 'secondary-model';
  byLabel(added, '优先级').value = '3';
  await f.get('add-model').emit('click');
  const draft = modelCards(f)[2];
  const enabled = byLabel(draft, '启用此模型'); enabled.checked = false; await enabled.emit('change');
  assert.equal(byLabel(draft, '模型名称').required, false);
  assert.equal(f.get('settings-form').reportValidity(), true);
  await f.get('settings-form').emit('submit');
  const firstSave = f.writes.at(-1).settings;
  assert.equal(firstSave.models.length, 3);
  const retainedId = firstSave.models[1].id;
  await allNodes(modelCards(f)[0]).find(node => node.tag === 'button' && node.textContent === '删除模型').emit('click');
  assert.equal(modelCards(f).length, 2);
  assert.equal(f.get('model').value, 'secondary-model');
  await f.get('settings-form').emit('submit');
  const saved = f.writes.at(-1).settings;
  assert.equal(saved.models[0].id, retainedId);
  assert.equal(saved.models[0].priority, 3);
  assert.equal(saved.models[0].apiKey, 'secondary-fixture-key');
  assert.equal(saved.models[1].enabled, false);
  const reloaded = await fixture([], undefined, { settings: saved });
  assert.equal(modelCards(reloaded).length, 2);
  assert.equal(reloaded.get('model').value, 'secondary-model');
  assert.equal(byLabel(modelCards(reloaded)[0], '优先级').value, '3');
  assert.match(reloaded.root.textContent, /3.*启用模型数/);
  assert.match(reloaded.root.textContent, /费用/);
  assert.match(reloaded.root.textContent, /数值越小.*优先.*同优先级/);
});

test('permission refusal and invalid enabled models never persist partial settings or test a provider', async () => {
  const settings = normalizeSettings({ models: [
    { id: 'one', apiBaseUrl: 'https://one.example/v1', model: 'one' },
    { id: 'two', apiBaseUrl: 'https://two.example/v1', model: 'two' },
  ] });
  const denied = await fixture([], undefined, { settings, granted: false });
  await denied.get('settings-form').emit('submit');
  assert.equal(denied.permissionCalls.length, 1);
  assert.equal(denied.writes.length, 0);
  assert.match(denied.get('status').textContent, /权限/);
  await denied.get('test').emit('click');
  assert.equal(denied.writes.length, 0);
  assert.equal(denied.calls.some(call => call.type === 'api:test'), false);
  const invalid = await fixture([], undefined, { settings });
  byLabel(modelCards(invalid)[1], '模型名称').value = '';
  await invalid.get('settings-form').emit('submit');
  assert.equal(invalid.writes.length, 0);
  assert.equal(invalid.permissionCalls.length, 0);
  for (const card of modelCards(invalid)) { const checkbox = byLabel(card, '启用此模型'); checkbox.checked = false; await checkbox.emit('change'); }
  await invalid.get('settings-form').emit('submit');
  assert.equal(invalid.writes.length, 0);
  assert.match(invalid.get('status').textContent, /至少.*启用/);
});

test('connection tests address each enabled model and keep individual success or failure results', async () => {
  const settings = normalizeSettings({ models: [
    { id: 'primary', apiBaseUrl: 'https://one.example/v1', model: 'one' },
    { id: 'backup', apiBaseUrl: 'https://two.example/v1', model: 'two' },
    { id: 'draft', apiBaseUrl: '', model: '', enabled: false },
  ] });
  const f = await fixture([], async message => {
    if (message.type !== 'api:test') return null;
    if (message.modelId === 'backup') throw new Error('Authorization: Bearer provider-secret');
    return [{ id: 'test', text: '你好' }];
  }, { settings });
  assert.equal(allNodes(modelCards(f)[2]).find(node => node.textContent === '测试此模型').disabled, true);
  await f.get('test').emit('click');
  assert.deepEqual(f.calls.filter(call => call.type === 'api:test').map(call => ({ ...call })), [
    { type: 'api:test', modelId: 'primary' }, { type: 'api:test', modelId: 'backup' },
  ]);
  assert.equal(f.permissionCalls.length, 1);
  assert.match(modelCards(f)[0].textContent, /连接成功.*你好/);
  assert.match(modelCards(f)[1].textContent, /测试未通过/);
  assert.match(f.get('status').textContent, /1.*成功.*1.*未通过/);
  await allNodes(modelCards(f)[0]).find(node => node.tag === 'button' && node.textContent === '测试此模型').emit('click');
  assert.equal(f.calls.filter(call => call.type === 'api:test').length, 3);
  assert.equal(f.calls.at(-1).modelId, 'primary');
  assert.doesNotMatch(f.root.textContent + JSON.stringify(f.logs), /provider-secret|Authorization/);
});

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

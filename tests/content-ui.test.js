import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { activeCue, chooseTrack, parseCaptionPayload } from '../src/shared/captions.js';

const source = readFileSync(new URL('../src/content/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/, '').replace(/start\(\)\.catch\(\(\) => logFailure\('initialize'\)\);/, '');

function node() {
  const classes = new Set(), handlers = new Map();
  return {
    textContent: '', hidden: false, dataset: {}, disabled: false, value: 'bilingual',
    currentTime: 1, playbackRate: 1, paused: false, ended: false,
    classList: {
      contains: name => classes.has(name), add: name => classes.add(name),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
    },
    addEventListener(name, handler) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(handler); },
    setAttribute() {},
    removeEventListener(name, handler) { handlers.get(name)?.delete(handler); },
    emit(name) { for (const handler of handlers.get(name) || []) handler(); },
  };
}
function fixture(respond = async () => null) {
  const calls = [], logs = [], posted = [];
  let now = 0;
  const elements = Object.fromEntries(['player', 'video', 'overlay', 'originalLine', 'translatedLine', 'progress', 'status', 'panel',
    'exportButton', 'exportMode', 'cancelButton', 'retryButton', 'cacheButton'].map(key => [key, node()]));
  elements.panel.hidden = true;
  const context = vm.createContext({
    activeCue, chooseTrack, parseCaptionPayload, URL, crypto: webcrypto, performance: { now: () => now },
    console: { error: (...args) => logs.push(args) },
    document: { hidden: false, addEventListener() {}, querySelector: () => null, title: 'Fixture video' },
    location: { origin: 'https://www.youtube.com', href: 'https://www.youtube.com/watch?v=fixture0001' },
    window: { addEventListener() {}, postMessage: message => posted.push(message) },
    browser: { runtime: { async sendMessage(message) { calls.push(message); return { ok: true, data: await respond(message) }; } },
      storage: { onChanged: { addListener() {} } } },
    setTimeout, clearTimeout, setInterval: () => 0, elements,
  });
  vm.runInContext(source, context);
  vm.runInContext(`({player,video,overlay,originalLine,translatedLine,progress,status,panel,exportButton,exportMode,cancelButton,retryButton,cacheButton} = elements);
    enabled=true;sourceVerified=true;currentVideo='fixture0001';settings={ready:true,cacheConfigured:true};
    tracks=[{id:'.en',language:'en',automatic:false}];trackId='.en';`, context);
  return { ...elements, calls, logs, posted, context,
    time(value) { now = value; },
    run(code) { return vm.runInContext(code, context); },
    apply(value) { context.applyTask(value); context.render(); },
  };
}
const cues = [{ id: '0', start: 0, end: 2, text: 'First source' }, { id: '1', start: 3, end: 5, text: 'Next source' }];
const task = (overrides = {}) => ({ id: 'task-a', videoId: 'fixture0001', state: 'translating', total: 2, translatedCount: 1,
  cues, translations: [{ id: '0', text: '首条译文' }], revision: 1, ...overrides });

test('saved partial cues display during translation and failure, but untranslated positions preserve native CC', () => {
  const f = fixture();
  f.apply(task());
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.translatedLine.textContent, '首条译文');
  assert.equal(f.player.classList.contains('ytbl-rendering'), true);
  assert.match(f.status.textContent, /1 \/ 2/);
  assert.equal(f.exportButton.disabled, true);
  f.video.currentTime = 3.5; f.context.render();
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.player.classList.contains('ytbl-rendering'), false);
  f.video.currentTime = 1;
  for (const state of ['failed', 'cancelled', 'paused']) {
    f.apply(task({ state, error: 'provider-secret', revision: 2 }));
    assert.equal(f.overlay.hidden, false, state);
    assert.equal(f.panel.hidden, true, state);
    assert.equal(f.status.dataset.error, 'false');
    assert.doesNotMatch(f.status.textContent, /provider-secret/);
  }
});

test('older revisions and responses for another video cannot replace the visible translation', () => {
  const f = fixture();
  f.apply(task({ revision: 5 }));
  f.apply(task({ revision: 4, translations: [] }));
  assert.equal(f.translatedLine.textContent, '首条译文');
  f.apply(task({ videoId: 'fixture0002', revision: 9, translations: [] }));
  assert.equal(f.translatedLine.textContent, '首条译文');
});

test('playback ticks are throttled; seeks, pause and ads update viewing eligibility; rebinding removes listeners', async () => {
  const f = fixture(); f.apply(task());
  f.context.bindPlayback();
  f.video.emit('timeupdate'); f.time(500); f.video.emit('timeupdate');
  f.video.emit('seeked');
  assert.deepEqual(f.calls.map(call => call.reason), ['tick', 'seek']);
  f.player.classList.add('ad-showing'); f.video.emit('ratechange');
  assert.equal(f.calls.at(-1).active, false);
  assert.equal(f.calls.length, 3);
  f.player.classList.remove('ad-showing');
  const replacement = node();
  f.context.replacement = replacement;
  f.run('video=replacement;bindPlayback()');
  f.video.emit('play'); assert.equal(f.calls.length, 3);
  replacement.playbackRate = 2; replacement.emit('ratechange');
  assert.equal(f.calls.at(-1).rate, 2);
  assert.equal(f.calls.at(-1).id, 'task-a');
  await Promise.resolve();
});

test('partial cache lookup never starts paid work before full source verification', async () => {
  const f = fixture(async message => message.type === 'track:lookup' ? task({ state: 'paused' }) : null);
  await f.context.lookupTrack();
  assert.equal(f.calls.some(call => call.type === 'track:resume' || call.type === 'track:start'), false);
  assert.equal(f.posted.at(-1).type, 'fetch-track');
  f.context.render(); assert.equal(f.translatedLine.textContent, '首条译文');
});

test('resume keeps saved cues and runtime failures expose no provider text or automatic panel', async () => {
  const f = fixture(async message => {
    if (message.type === 'track:resume') throw new Error('Authorization: Bearer provider-secret');
    return null;
  });
  f.apply(task({ state: 'paused' }));
  await f.context.resumeTask(); f.context.render();
  assert.equal(f.calls[0].type, 'track:resume');
  assert.equal(f.translatedLine.textContent, '首条译文');
  assert.equal(f.panel.hidden, true);
  assert.doesNotMatch(f.status.textContent + JSON.stringify(f.logs), /provider-secret|Authorization/);
  assert.ok(f.logs.length > 0);
});

test('start includes current playback and an outdated poll cannot apply after view reset', async () => {
  let release;
  const f = fixture(async message => {
    if (message.type === 'track:status') return new Promise(resolve => { release = resolve; });
    if (message.type === 'track:start') return task();
    return null;
  });
  f.apply(task({ state: 'paused' }));
  await f.context.submitTrack();
  const start = f.calls.find(call => call.type === 'track:start');
  assert.equal(start.playback.position, 1);
  assert.equal(start.playback.reason, 'activate');
  const pending = f.context.pollTask();
  f.context.resetView(); release(task({ state: 'complete', revision: 10 }));
  await pending;
  assert.equal(f.run('task'), null);
  assert.equal(f.translatedLine.textContent, '');
});

test('manual caching uses a snapshot only and prevents duplicate clicks without resuming playback', async () => {
  let release;
  const f = fixture(async message => message.type === 'track:cache' ? new Promise(resolve => { release = resolve; }) : null);
  f.apply(task({ state: 'paused' })); f.video.paused = true;
  const pending = f.context.cacheSubtitles();
  await f.context.cacheSubtitles();
  assert.equal(f.calls.filter(c => c.type === 'track:cache').length, 1);
  assert.equal(f.cacheButton.disabled, true);
  release({ path: 'fixture-cache', translatedCount: 1, total: 2, complete: false });
  await pending;
  assert.match(f.status.textContent, /部分缓存.*1 \/ 2/);
  assert.equal(f.cacheButton.disabled, false); assert.equal(f.video.paused, true);
  assert.equal(f.calls.some(c => ['track:resume', 'track:start'].includes(c.type)), false);
});

test('unconfigured cache opens settings, and pause/disable reports revoke watching eligibility', async () => {
  const f = fixture(); f.apply(task());
  f.run('settings.cacheConfigured=false');
  await f.context.cacheSubtitles();
  assert.equal(f.calls[0].type, 'settings:open');
  f.context.bindPlayback(); f.video.paused = true; f.video.emit('pause');
  assert.equal(f.calls.at(-1).active, false);
  f.video.paused = false; f.context.setEnabled(false);
  assert.equal(f.calls.at(-1).active, false);
});

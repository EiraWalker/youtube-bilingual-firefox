import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bridgeSource = readFileSync(new URL('../src/content/page-bridge.js', import.meta.url), 'utf8');

function bridgeFixture({ cc = true, fetchImpl = async () => ({ ok: false, status: 403 }) } = {}) {
  const timers = new Map();
  const intervals = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const requests = [];
  const messages = [];
  let resourceObserver;
  let clock = 0;
  let timerId = 0;
  const location = { href: 'https://www.youtube.com/watch?v=first', origin: 'https://www.youtube.com' };

  function makePlayer(id, language, initialCC) {
    const track = { vssId: `.${language}`, languageCode: language, kind: '', name: '',
      baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&lang=${language}` };
    const otherLanguage = language === 'en' ? 'ja' : 'en';
    const otherTrack = { ...track, vssId: `.${otherLanguage}`, languageCode: otherLanguage,
      baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&lang=${otherLanguage}` };
    const tracks = [track, otherTrack];
    let selectedTrack = { ...track };
    let pressed = initialCC;
    const selections = [];
    const button = {
      getAttribute(name) {
        return name === 'aria-disabled' ? 'false' : name === 'aria-pressed' ? String(pressed) : null;
      },
      click() {
        pressed = !pressed;
        if (pressed && !selectedTrack.languageCode) selectedTrack = { ...track };
      },
    };
    return {
      selections,
      button,
      get cc() { return pressed; },
      get selectedTrack() { return selectedTrack; },
      classList: { contains: () => false },
      querySelector: selector => selector === '.ytp-subtitles-button' ? button : null,
      getPlayerResponse: () => ({ videoDetails: { videoId: id },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } }),
      getOption: (_module, key) => key === 'tracklist' ? tracks : selectedTrack,
      loadModule() {},
      setOption(_module, _key, value) {
        selectedTrack = { ...value };
        selections.push({ ...value });
        pressed = Boolean(value.languageCode);
      },
    };
  }

  let player = makePlayer('first', 'en', cc);
  const window = {
    fetch(url, options) { requests.push({ url: String(url), options }); return fetchImpl(url, options); },
    postMessage: message => messages.push(message),
    addEventListener: (type, listener) => windowListeners.set(type, listener),
  };
  const document = {
    getElementById: id => id === 'movie_player' ? player : null,
    querySelector: selector => selector === '#movie_player .ytp-subtitles-button' ? player.button : null,
    addEventListener: (type, listener) => documentListeners.set(type, listener),
  };
  class XMLHttpRequest {
    constructor() { this.listeners = new Map(); this.responseType = ''; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    open() {}
    send() {}
    complete(body) {
      this.status = 200;
      this.responseText = body;
      this.listeners.get('load')?.();
    }
  }
  const context = {
    window, document, location, URL, XMLHttpRequest, AbortController,
    PerformanceObserver: class { constructor(callback) { resourceObserver = callback; } observe() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, at: clock + delay });
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    setInterval: callback => intervals.push(callback),
  };
  vm.runInNewContext(bridgeSource, context, { filename: 'page-bridge.js' });

  return {
    requests, messages,
    get player() { return player; },
    nativeFetch: url => window.fetch(url),
    startXHR(url) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.send();
      return xhr;
    },
    observeResource: url => resourceObserver({ getEntries: () => [{ name: url }] }),
    send(type, data = {}) {
      windowListeners.get('message')({ source: window, origin: location.origin,
        data: { channel: 'youtube-bilingual-local-v1', direction: 'content', type, ...data } });
    },
    advance(milliseconds) {
      const until = clock + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      clock = until;
    },
    navigate() {
      location.href = 'https://www.youtube.com/watch?v=second';
      player = makePlayer('second', 'ja', false);
      documentListeners.get('yt-navigate-finish')();
    },
    replacePlayer() {
      player = makePlayer('first', 'ja', true);
    },
  };
}

function startRearm(fixture) {
  fixture.send('enable', { trackId: '.en' });
  fixture.send('enable', { trackId: '.en', rearm: true });
  assert.equal(fixture.player.selectedTrack.languageCode, undefined);
}

test('disabling during rearm restores a track whose native CC was already on', () => {
  const fixture = bridgeFixture();
  startRearm(fixture);
  fixture.send('disable');
  assert.equal(fixture.player.selectedTrack.languageCode, 'en');
  assert.equal(fixture.player.cc, true);
  const commands = fixture.player.selections.length;
  fixture.advance(1000);
  assert.equal(fixture.player.selections.length, commands);
});

test('disabling during rearm keeps native CC off when the extension enabled it', () => {
  const fixture = bridgeFixture({ cc: false });
  startRearm(fixture);
  fixture.send('disable');
  fixture.advance(1000);
  assert.equal(fixture.player.cc, false);
  assert.equal(fixture.player.selectedTrack.languageCode, undefined);
  assert.deepEqual(fixture.player.selections.map(track => track.languageCode), [undefined]);
});

test('navigation cancels rearm without applying the previous video track', () => {
  const fixture = bridgeFixture();
  startRearm(fixture);
  const previousPlayer = fixture.player;
  fixture.navigate();
  fixture.advance(1000);
  fixture.send('disable');
  assert.equal(previousPlayer.selectedTrack.languageCode, undefined);
  assert.equal(previousPlayer.selections.length, 1);
  assert.equal(fixture.player.selectedTrack.languageCode, 'ja');
  assert.equal(fixture.player.cc, false);
  assert.equal(fixture.player.selections.length, 0);
});

test('disabling after a player replacement does not restore into the new instance', () => {
  const fixture = bridgeFixture();
  startRearm(fixture);
  fixture.replacePlayer();
  fixture.send('disable');
  fixture.advance(1000);
  assert.equal(fixture.player.selectedTrack.languageCode, 'ja');
  assert.equal(fixture.player.selections.length, 0);
});

test('uninterrupted rearm restores the selected track after its delay', () => {
  const fixture = bridgeFixture();
  startRearm(fixture);
  fixture.advance(250);
  assert.equal(fixture.player.selectedTrack.languageCode, 'en');
  assert.equal(fixture.player.cc, true);
});

const fullTrack = JSON.stringify({ events: [
  { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Beginning.' }] },
  { tStartMs: 600000, dDurationMs: 2000, segs: [{ utf8: 'End of the complete track.' }] },
] });
const response = body => ({ ok: true, status: 200, text: async () => body, clone() { return this; } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function settle() {
  for (let step = 0; step < 40; step++) await Promise.resolve();
}
function captions(fixture) { return fixture.messages.filter(message => message.type === 'captions'); }

test('enable proactively retrieves one complete selected track without a playback clock', async () => {
  const fixture = bridgeFixture({ fetchImpl: async () => response(fullTrack) });
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  await settle();
  assert.equal(fixture.requests.length, 1);
  assert.equal(new URL(fixture.requests[0].url).searchParams.get('lang'), 'en');
  assert.equal(captions(fixture).length, 1);
  assert.equal(captions(fixture)[0].body, fullTrack);
});

test('captured signed subtitle URLs are replayed unchanged with page credentials', async () => {
  const signed = 'https://www.youtube.com/api/timedtext?v=first&lang=en&fmt=srv3&pot=test%2Btoken&signature=test%2Fsignature&expire=9999999999';
  const fixture = bridgeFixture({ fetchImpl: async () => response(fullTrack) });
  fixture.observeResource(signed);
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  await settle();
  assert.equal(fixture.requests[0].url, signed);
  assert.equal(fixture.requests[0].options.credentials, 'include');
  assert.equal(captions(fixture)[0].body, fullTrack);
});

test('an actual captured player response is reused instead of fetched again', async () => {
  const fixture = bridgeFixture({ fetchImpl: async () => response(fullTrack) });
  await fixture.nativeFetch('https://www.youtube.com/api/timedtext?v=first&lang=en&fmt=json3&pot=test');
  await settle();
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  await settle();
  assert.equal(fixture.requests.length, 1);
  assert.equal(captions(fixture).length, 1);
});

test('concurrent full-track commands share the in-flight extraction', async () => {
  const pending = deferred();
  const fixture = bridgeFixture({ fetchImpl: () => pending.promise });
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  fixture.send('fetch-track', { trackId: '.en' });
  fixture.send('fetch-track', { trackId: '.en' });
  assert.equal(fixture.requests.length, 1);
  pending.resolve(response(fullTrack));
  await settle();
  assert.equal(captions(fixture).length, 1);
});

test('empty JSON3 falls back to a complete VTT format on the same source track', async () => {
  const vtt = 'WEBVTT\n\n00:00.000 --> 00:02.000\nBeginning.\n\n10:00.000 --> 10:02.000\nEnd.';
  const fixture = bridgeFixture({ fetchImpl: async url => response(new URL(url).searchParams.get('fmt') === 'vtt' ? vtt : '') });
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  await settle();
  assert.deepEqual(fixture.requests.map(request => new URL(request.url).searchParams.get('fmt')), ['json3', 'vtt']);
  assert.ok(fixture.requests.every(request => new URL(request.url).searchParams.get('lang') === 'en'));
  assert.equal(captions(fixture)[0].body, vtt);
});

test('all empty formats report complete-track failure without a DOM caption fallback', async () => {
  const fixture = bridgeFixture({ fetchImpl: async () => response('') });
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  await settle();
  assert.equal(fixture.requests.length, 3);
  assert.equal(captions(fixture).length, 0);
  const failure = fixture.messages.find(message => message.type === 'status' && message.failed);
  assert.match(failure.message, /无法获取完整字幕.*空字幕响应/);
  assert.doesNotMatch(failure.message, /正在读取播放器字幕/);
});

test('the extraction deadline includes response body reading and aborts the fetch', async () => {
  const pendingBody = deferred();
  const fixture = bridgeFixture({ fetchImpl: async () => ({ ok: true, status: 200, text: () => pendingBody.promise }) });
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  await settle();
  fixture.advance(12000);
  await settle();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].options.signal.aborted, true);
  assert.match(fixture.messages.find(message => message.failed)?.message, /超时/);
});

test('selecting another track aborts and discards an old response body', async () => {
  const pendingBody = deferred();
  const fixture = bridgeFixture({ fetchImpl: async url => new URL(url).searchParams.get('lang') === 'en'
    ? { ok: true, status: 200, text: () => pendingBody.promise } : response(fullTrack) });
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  await settle();
  fixture.send('select-track', { trackId: '.ja' });
  fixture.advance(150);
  await settle();
  pendingBody.resolve('OLD ENGLISH TRACK');
  await settle();
  assert.equal(fixture.requests[0].options.signal.aborted, true);
  assert.deepEqual(captions(fixture).map(message => message.language), ['ja']);
});

test('navigation discards late complete-track responses from the previous video', async () => {
  const pending = deferred();
  const fixture = bridgeFixture({ fetchImpl: url => new URL(url).searchParams.get('v') === 'first'
    ? pending.promise : Promise.resolve(response(fullTrack)) });
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  fixture.navigate();
  fixture.send('enable', { trackId: '.ja' });
  fixture.advance(150);
  pending.resolve(response('OLD VIDEO TRACK'));
  await settle();
  assert.equal(fixture.requests[0].options.signal.aborted, true);
  assert.deepEqual(captions(fixture).map(message => message.videoId), ['second']);
});

test('disable cancels extraction even if the network later returns a body', async () => {
  const pending = deferred();
  const fixture = bridgeFixture({ fetchImpl: () => pending.promise });
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  fixture.send('disable');
  pending.resolve(response(fullTrack));
  await settle();
  assert.equal(fixture.requests[0].options.signal.aborted, true);
  assert.equal(captions(fixture).length, 0);
});

test('YouTube machine-translated tlang responses are not reused as the source track', async () => {
  const fixture = bridgeFixture({ fetchImpl: async url => response(new URL(url).searchParams.has('tlang') ? 'MACHINE TRANSLATION' : fullTrack) });
  await fixture.nativeFetch('https://www.youtube.com/api/timedtext?v=first&lang=en&tlang=zh&pot=test');
  await settle();
  fixture.send('enable', { trackId: '.en' });
  fixture.advance(150);
  await settle();
  assert.equal(fixture.requests.length, 2);
  assert.equal(new URL(fixture.requests[1].url).searchParams.has('tlang'), false);
  assert.equal(captions(fixture)[0].body, fullTrack);
});

test('an actual XHR track response wins before proactive extraction starts', async () => {
  const fixture = bridgeFixture();
  fixture.send('enable', { trackId: '.en' });
  const xhr = fixture.startXHR('https://www.youtube.com/api/timedtext?v=first&lang=en&pot=test');
  xhr.complete(fullTrack);
  fixture.advance(150);
  await settle();
  assert.equal(fixture.requests.length, 0);
  assert.equal(captions(fixture)[0].body, fullTrack);
});

test('captured fetch bodies that finish after a track switch are discarded', async () => {
  const pendingBody = deferred();
  const nativeResponse = { ok: true, status: 200, text: () => pendingBody.promise, clone() { return this; } };
  const fixture = bridgeFixture({ fetchImpl: async url => new URL(url).searchParams.get('lang') === 'en'
    ? nativeResponse : response(fullTrack) });
  fixture.send('enable', { trackId: '.en' });
  await fixture.nativeFetch('https://www.youtube.com/api/timedtext?v=first&lang=en&pot=test');
  fixture.send('select-track', { trackId: '.ja' });
  fixture.advance(150);
  await settle();
  pendingBody.resolve('OLD CAPTURED FETCH');
  await settle();
  assert.deepEqual(captions(fixture).map(message => message.language), ['ja']);
});

test('captured XHR bodies that finish after a track switch are discarded', async () => {
  const fixture = bridgeFixture({ fetchImpl: async () => response(fullTrack) });
  fixture.send('enable', { trackId: '.en' });
  const xhr = fixture.startXHR('https://www.youtube.com/api/timedtext?v=first&lang=en&pot=test');
  fixture.send('select-track', { trackId: '.ja' });
  xhr.complete('OLD CAPTURED XHR');
  fixture.advance(150);
  await settle();
  assert.deepEqual(captions(fixture).map(message => message.language), ['ja']);
});

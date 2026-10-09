// Runs in the page world. Only subtitle data and player commands cross the bridge.
const CHANNEL = 'youtube-bilingual-local-v1';
let enabled = false;
let originalCC = null;
let enabledVideo = '';
let metadataSignature = '';
let lastPayload = null;
const capturedUrls = new Map();
let activationTimer;
let activationSequence = 0;
let observedCC = null;
let ccObserver;
let desiredTrack = '';
let pendingRearm = null;
let extractionGeneration = 0;
let extractionContext = null;
let extractionRequest = null;
let extractionStartTimer;
const ownSubtitleUrls = new Set();
const EXTRACTION_TIMEOUT_MS = 12_000;

function videoId() {
  return new URL(location.href).searchParams.get('v') || '';
}

function emit(type, data = {}) {
  window.postMessage({ channel: CHANNEL, direction: 'page', type, ...data }, location.origin);
}

function subtitleUrl(value) {
  try {
    const url = new URL(value, location.href);
    if (url.protocol !== 'https:' || !/(^|\.)youtube\.com$/.test(url.hostname)
      || url.pathname !== '/api/timedtext' || url.searchParams.has('tlang')) return null;
    if (url.searchParams.get('v') !== videoId()) return null;
    return url;
  } catch { return null; }
}

function rememberUrl(value) {
  const url = subtitleUrl(value);
  if (!url) return null;
  const key = `${url.searchParams.get('lang') || ''}:${url.searchParams.get('kind') || ''}`;
  const previous = capturedUrls.get(key);
  capturedUrls.set(key, url.href);
  if (capturedUrls.size > 8) capturedUrls.delete(capturedUrls.keys().next().value);
  if (enabled && previous !== url.href && !ownSubtitleUrls.has(url.href)) scheduleExtraction();
  return url;
}

function receivePayload(value, body, generation = extractionGeneration) {
  const url = rememberUrl(value);
  if (!url || generation !== extractionGeneration || typeof body !== 'string'
    || !body.trim() || body.length > 8_000_000) return false;
  const track = selectedTrack(playerMetadata());
  if (enabled && (!track || !urlMatchesTrack(url, track))) return false;
  // A complete track is consumed once, rather than replacing it as playback advances.
  if (enabled && payloadMatchesTrack(lastPayload, track)) return true;
  lastPayload = { videoId: videoId(), language: url.searchParams.get('lang') || '', automatic: url.searchParams.get('kind') === 'asr', body };
  if (enabled) {
    clearTimeout(extractionStartTimer);
    emit('captions', lastPayload);
    extractionRequest?.controller.abort();
  }
  return true;
}

// Read the response YouTube actually received, retaining its signed request intact.
const originalFetch = window.fetch;
window.fetch = function (...args) {
  const generation = extractionGeneration;
  const result = Reflect.apply(originalFetch, this, args);
  const value = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url;
  if (rememberUrl(value)) result.then(response => {
    if (response.ok) response.clone().text().then(body => receivePayload(value, body, generation)).catch(() => {});
  }).catch(() => {});
  return result;
};

const xhrUrls = new WeakMap();
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url, ...args) {
  xhrUrls.set(this, String(url));
  return Reflect.apply(originalOpen, this, [method, url, ...args]);
};
XMLHttpRequest.prototype.send = function (...args) {
  const url = xhrUrls.get(this);
  const generation = extractionGeneration;
  if (rememberUrl(url)) this.addEventListener('load', () => {
    if (this.status < 200 || this.status >= 300) return;
    try {
      const body = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
      receivePayload(url, body, generation);
    } catch { /* YouTube may use another response type. */ }
  }, { once: true });
  return Reflect.apply(originalSend, this, args);
};

try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) rememberUrl(entry.name);
  }).observe({ type: 'resource', buffered: true });
} catch { /* Fetch/XHR capture and player metadata remain available. */ }

function playerMetadata() {
  const player = document.getElementById('movie_player');
  let response;
  try { response = player?.getPlayerResponse?.(); } catch { /* Player is still loading. */ }
  if (response?.videoDetails?.videoId !== videoId()) response = window.ytInitialPlayerResponse;
  if (response?.videoDetails?.videoId !== videoId()) return null;
  const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  let current;
  try { current = player?.getOption?.('captions', 'track'); } catch { /* No caption module yet. */ }
  return {
    videoId: videoId(),
    tracks: tracks.map((track, index) => ({
      id: track.vssId || String(index), language: track.languageCode,
      name: track.name?.simpleText || track.name?.runs?.map(run => run.text).join('') || track.languageCode,
      automatic: track.kind === 'asr', baseUrl: track.baseUrl,
    })),
    currentId: current?.vssId || (current?.languageCode ? tracks.find(track =>
      track.languageCode === current.languageCode && (track.kind || '') === (current.kind || ''))?.vssId : '') || '',
  };
}

function publishMetadata(force = false) {
  const metadata = playerMetadata();
  if (!metadata) return;
  const safe = { ...metadata, tracks: metadata.tracks.map(({ baseUrl, ...track }) => track) };
  const signature = JSON.stringify(safe);
  if (force || signature !== metadataSignature) {
    metadataSignature = signature;
    emit('metadata', safe);
  }
}

function selectedTrack(metadata, trackId = desiredTrack) {
  if (!metadata) return null;
  if (trackId) return metadata.tracks.find(track => track.id === trackId) || null;
  return metadata.tracks.find(track => track.id === metadata.currentId)
    || (metadata.tracks.length === 1 ? metadata.tracks[0] : null);
}

function trackKey(track) {
  return `${track.id}:${track.language}:${track.automatic ? 'asr' : ''}`;
}

function urlMatchesTrack(url, track) {
  return url.searchParams.get('lang') === track.language
    && (url.searchParams.get('kind') === 'asr') === track.automatic;
}

function payloadMatchesTrack(payload, track) {
  return payload?.videoId === videoId() && payload.language === track?.language
    && payload.automatic === track?.automatic;
}

function cancelExtraction() {
  extractionGeneration++;
  clearTimeout(extractionStartTimer);
  extractionRequest?.controller.abort();
  extractionRequest = null;
}

function synchronizeExtraction(track) {
  const player = document.getElementById('movie_player');
  const key = trackKey(track);
  if (extractionContext && (extractionContext.videoId !== videoId()
    || extractionContext.player !== player || extractionContext.key !== key)) cancelExtraction();
  extractionContext = { videoId: videoId(), player, key };
  if (!payloadMatchesTrack(lastPayload, track)) lastPayload = null;
}

function scheduleExtraction() {
  clearTimeout(extractionStartTimer);
  if (enabled) extractionStartTimer = setTimeout(() => void fetchTrack(desiredTrack), 150);
}

function extractionIsCurrent(request) {
  const track = selectedTrack(playerMetadata());
  return enabled && request.generation === extractionGeneration && request.videoId === videoId()
    && request.player === document.getElementById('movie_player')
    && track && request.key === trackKey(track);
}

function subtitleCandidates(track) {
  const urls = [];
  const captured = subtitleUrl(capturedUrls.get(`${track.language}:${track.automatic ? 'asr' : ''}`));
  if (captured) urls.push(captured.href); // Replay captured signatures and PO tokens unchanged.
  const base = subtitleUrl(track.baseUrl);
  if (base) {
    for (const format of ['json3', 'vtt']) {
      const candidate = new URL(base.href);
      candidate.searchParams.set('fmt', format);
      urls.push(candidate.href);
    }
    urls.push(base.href);
  }
  return [...new Set(urls)];
}

function activateTrack(trackId, sequence, attempts = 16, rearm = false) {
  if (!enabled || sequence !== activationSequence) return;
  const player = document.getElementById('movie_player');
  const button = player?.querySelector('.ytp-subtitles-button');
  if (button && button !== observedCC) {
    ccObserver?.disconnect();
    observedCC = button;
    let wasReady = button.getAttribute('aria-disabled') !== 'true';
    ccObserver = new MutationObserver(() => {
      const ready = button.getAttribute('aria-disabled') !== 'true';
      const becameReady = ready && !wasReady;
      wasReady = ready;
      if (enabled && becameReady) {
        clearTimeout(activationTimer);
        activateTrack(desiredTrack, activationSequence);
      }
    });
    ccObserver.observe(button, { attributes: true, attributeFilter: ['aria-disabled'] });
  }
  const retry = () => {
    if (attempts > 0) activationTimer = setTimeout(() => activateTrack(trackId, sequence, attempts - 1, rearm), 250);
  };
  if (!playerMetadata() || !button || button.getAttribute('aria-disabled') === 'true'
    || player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
    retry(); return;
  }
  enabledVideo = videoId();
  if (originalCC === null && button) originalCC = button.getAttribute('aria-pressed') === 'true';
  if (button?.getAttribute('aria-pressed') === 'false') button.click();
  try {
    player?.loadModule?.('captions');
    let response = player?.getPlayerResponse?.();
    if (response?.videoDetails?.videoId !== videoId()) response = window.ytInitialPlayerResponse;
    if (response?.videoDetails?.videoId !== videoId()) { retry(); return; }
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const currentTrack = player?.getOption?.('captions', 'track');
    const track = tracks.find((item, index) => (item.vssId || String(index)) === trackId)
      || (!trackId && tracks.find(item => item.languageCode === currentTrack?.languageCode
        && (item.kind || '') === (currentTrack.kind || '')));
    if (!currentTrack?.languageCode && !track) { retry(); return; }
    if (track) {
      const current = player?.getOption?.('captions', 'track');
      const same = current?.languageCode === track.languageCode && (current.kind || '') === (track.kind || '');
      if (same && rearm && lastPayload?.videoId !== videoId()
        && !player.querySelector('.ytp-caption-segment')?.textContent) {
        const pending = { videoId: videoId(), player, track: { ...current } };
        pendingRearm = pending;
        player?.setOption?.('captions', 'track', {});
        const restoreId = track.vssId || String(tracks.indexOf(track));
        activationTimer = setTimeout(() => {
          if (pendingRearm !== pending || sequence !== activationSequence || !enabled) return;
          if (pending.videoId !== videoId() || pending.player !== document.getElementById('movie_player')) {
            pendingRearm = null;
            return;
          }
          activateTrack(restoreId, sequence, Math.max(0, attempts - 1), false);
        }, 250);
        return;
      }
      if (!same) {
        const loaded = player?.getOption?.('captions', 'tracklist');
        const option = Array.isArray(loaded) ? loaded.find(item => item.vssId === track.vssId
          || (item.languageCode === track.languageCode && (item.kind || '') === (track.kind || ''))) : null;
        // Player options use a different shape from captionTracks metadata (notably name).
        player?.setOption?.('captions', 'track', option || { languageCode: track.languageCode, kind: track.kind || '' });
      }
      if (pendingRearm?.videoId === videoId() && pendingRearm.player === player) pendingRearm = null;
    }
  } catch { retry(); }
  publishMetadata(true);
  scheduleExtraction();
}

async function fetchTrack(trackId = desiredTrack) {
  if (!enabled) return;
  const metadata = playerMetadata();
  const track = selectedTrack(metadata, trackId);
  if (!track) {
    emit('status', { videoId: videoId(), message: '正在等待所选字幕轨道就绪；可在面板中指定原字幕语言。' });
    return;
  }
  synchronizeExtraction(track);
  if (payloadMatchesTrack(lastPayload, track)) { emit('captions', lastPayload); return; }
  if (extractionRequest?.generation === extractionGeneration) return extractionRequest.promise;

  const controller = new AbortController();
  const request = { ...extractionContext, generation: extractionGeneration, controller, timedOut: false };
  extractionRequest = request;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error(request.timedOut ? '提取完整字幕超时。' : '字幕提取已取消。'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => { request.timedOut = true; controller.abort(); }, EXTRACTION_TIMEOUT_MS);
  request.promise = (async () => {
    const attempted = new Set();
    let failure = '没有可用的整轨字幕地址。';
    try {
      // Re-check captured URLs between attempts: the player may acquire a PO token meanwhile.
      for (let attempt = 0; attempt < 4 && extractionIsCurrent(request); attempt++) {
        const url = subtitleCandidates(track).find(candidate => !attempted.has(candidate));
        if (!url) break;
        attempted.add(url);
        ownSubtitleUrls.add(url);
        if (ownSubtitleUrls.size > 32) ownSubtitleUrls.delete(ownSubtitleUrls.values().next().value);
        try {
          const body = await Promise.race([
            (async () => {
              const response = await Reflect.apply(originalFetch, window, [url, { credentials: 'include', signal: controller.signal }]);
              if (!response.ok) throw new Error(`字幕请求返回 HTTP ${response.status}。`);
              const text = await response.text();
              if (!text.trim()) throw new Error('YouTube 返回空字幕响应。');
              if (text.length > 8_000_000) throw new Error('字幕响应过大。');
              return text;
            })(), aborted,
          ]);
          if (!extractionIsCurrent(request)) return;
          receivePayload(url, body, request.generation);
          return;
        } catch (error) {
          failure = error.message;
          if (controller.signal.aborted) break;
        }
      }
      if (extractionIsCurrent(request) && !payloadMatchesTrack(lastPayload, track)) {
        emit('status', { videoId: request.videoId, failed: true,
          message: `无法获取完整字幕：${failure} 请确认原生 CC 可用后重试；站点可能限制字幕请求。` });
      }
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      if (extractionRequest === request) extractionRequest = null;
    }
  })();
  return request.promise;
}

window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== window || event.origin !== location.origin || message?.channel !== CHANNEL
    || message.direction !== 'content') return;
  if (message.type === 'refresh') publishMetadata(true);
  if (message.type === 'enable' || message.type === 'select-track') {
    const nextTrack = message.trackId || '';
    if (!enabled || nextTrack !== desiredTrack) { cancelExtraction(); extractionContext = null; }
    enabled = true;
    desiredTrack = nextTrack;
    const track = selectedTrack(playerMetadata());
    if (track) synchronizeExtraction(track);
    clearTimeout(activationTimer);
    activationSequence++;
    activateTrack(nextTrack, activationSequence, 16, message.rearm === true);
    scheduleExtraction();
  }
  if (message.type === 'fetch-track') void fetchTrack(message.trackId);
    if (message.type === 'disable') {
      enabled = false;
      cancelExtraction();
      extractionContext = null;
      clearTimeout(activationTimer);
      activationSequence++;
    const pending = pendingRearm;
    pendingRearm = null;
    if (originalCC === true && pending?.videoId === videoId()
      && pending.player === document.getElementById('movie_player')) {
      try { pending.player.setOption?.('captions', 'track', pending.track); }
      catch { /* The player may be shutting down. */ }
    }
    if (enabledVideo === videoId() && originalCC === false) {
      const button = document.querySelector('#movie_player .ytp-subtitles-button');
      if (button?.getAttribute('aria-pressed') === 'true') button.click();
    }
    originalCC = null;
    enabledVideo = '';
  }
});

document.addEventListener('yt-navigate-finish', () => {
  cancelExtraction();
  extractionContext = null;
  clearTimeout(activationTimer);
  activationSequence++;
  pendingRearm = null;
  originalCC = null;
  enabledVideo = '';
  ccObserver?.disconnect();
  observedCC = null;
  capturedUrls.clear();
  ownSubtitleUrls.clear();
  lastPayload = null;
  metadataSignature = '';
  publishMetadata(true);
});
setInterval(() => publishMetadata(), 1000);
publishMetadata(true);

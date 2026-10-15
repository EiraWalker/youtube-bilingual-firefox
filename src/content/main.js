import { activeCue, chooseTrack, parseCaptionPayload } from '../shared/captions.js';

const CHANNEL = 'youtube-bilingual-local-v1';
let settings, player, video, overlay, originalLine, translatedLine, progress;
let button, cacheButton, panel, status, trackSelect, retryButton, cancelButton, exportMode, exportButton;
let caching = false, watchSequence = 0;
const pageSession = crypto.randomUUID();
let enabled = false, currentVideo = '', generation = 0;
let tracks = [], trackId = '', manualTrack = false;
let cues = [], translations = new Map(), task = null;
let submitting = false, polling = false, failed = false, sourceVerified = false;
let lastCapture = '', submittedSource = '', lookupKey = '', lookupSequence = 0;
let fetchTimer, recoveryTimer, missingTimer, wasAdvert = false;
let detachPlayback = () => {}, lastPositionAt = -Infinity;

// Provider errors belong to the background console. Never forward arbitrary
// response text (which can contain credentials or captions) into the page.
function logFailure(operation) {
  console.error('[YouTube bilingual]', { operation, category: 'operation-failed' });
}
function reportFailure(operation, text = '操作未完成，可稍后重试。') {
  logFailure(operation); setStatus(text);
}
const isAdvert = () => player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting');
function playbackSnapshot(reason) {
  return { position: Math.max(0, Number(video?.currentTime) || 0), rate: Math.max(.1, Number(video?.playbackRate) || 1),
    active: Boolean(enabled && sourceVerified && video && !video.paused && !video.ended && !document.hidden && !isAdvert()),
    paused: video?.paused, visible: !document.hidden, reason, session: pageSession, sequence: ++watchSequence, view: generation };
}
async function reportPosition(reason = 'tick') {
  if (!video || !currentVideo) return;
  const now = performance.now();
  if (reason === 'tick' && now - lastPositionAt < 1000) return;
  lastPositionAt = now;
  try { await request('track:position', { id: task?.id, videoId: currentVideo, ...playbackSnapshot(reason) }); }
  catch { logFailure('track:position'); }
}
function bindPlayback() {
  detachPlayback();
  const boundVideo = video;
  const listeners = [['timeupdate', () => void reportPosition()], ['seeked', () => void reportPosition('seek')],
    ['play', () => void reportPosition('play')], ['pause', () => void reportPosition('pause')],
    ['ended', () => void reportPosition('ended')], ['ratechange', () => void reportPosition('ratechange')]];
  for (const [name, handler] of listeners) boundVideo.addEventListener(name, handler);
  detachPlayback = () => {
    for (const [name, handler] of listeners) boundVideo.removeEventListener(name, handler);
  };
}

async function request(type, data = {}) {
  const result = await browser.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有响应。');
  return result.data;
}
function bridge(type, data = {}) {
  window.postMessage({ channel: CHANNEL, direction: 'content', type, ...data }, location.origin);
}
const selectedTrack = () => tracks.find(item => item.id === trackId);
const busy = () => submitting || ['queued', 'translating', 'retrying'].includes(task?.state);
const requestedTrack = () => settings?.sourceLanguage === 'auto' && !manualTrack ? '' : trackId;

function updateControls() {
  if (cacheButton) {
    cacheButton.disabled = caching || !task?.id || !cues.length;
    cacheButton.textContent = caching ? '缓存中…' : task?.cachePath ? (task.cachedCount === task.total ? '已缓存' : '部分缓存') : '缓存字幕';
    cacheButton.title = task?.cachePath ? `已缓存 ${task.cachedCount} / ${task.total} · ${task.cachePath}` : '保存当前可用字幕';
    cacheButton.setAttribute('aria-label', '缓存字幕');
  }
  if (!exportButton) return;
  exportButton.disabled = !task?.id || (exportMode.value !== 'original' && task.state !== 'complete');
  cancelButton.disabled = !task?.id || task.state === 'complete' || task.state === 'cancelled';
  retryButton.disabled = busy();
  retryButton.textContent = task?.state === 'complete' ? '重新翻译' : task?.id ? '恢复翻译' : '重试';
}
function setStatus(text, error = false) {
  if (status) { status.textContent = text; status.dataset.error = String(error); }
  updateControls();
}

// Revoke the old view even when source loading or a start request is pending.
function resetView() {
  if (currentVideo) {
    const snapshot = playbackSnapshot('detach'); snapshot.active = false;
    request('track:position', { id: task?.id, videoId: task?.videoId || currentVideo, ...snapshot }).catch(() => {});
  }
  generation++; lookupSequence++;
  cues = []; translations = new Map(); task = null;
  sourceVerified = false;
  submitting = false; polling = false; failed = false;
  lastCapture = ''; submittedSource = ''; lookupKey = '';
  lastPositionAt = -Infinity;
  clearTimeout(fetchTimer); clearTimeout(recoveryTimer); clearTimeout(missingTimer);
  if (overlay) overlay.hidden = true;
  if (progress) progress.hidden = true;
  if (originalLine) originalLine.textContent = '';
  if (translatedLine) translatedLine.textContent = '';
  player?.classList.remove('ytbl-rendering'); updateControls();
}
function applyTask(result) {
  if (!result || (result.videoId && result.videoId !== currentVideo)) return;
  if (result.id === task?.id && Number.isFinite(result.revision) && Number.isFinite(task?.revision)
    && result.revision < task.revision) return;
  const changed = result.id !== task?.id || result.revision === undefined || result.revision !== task?.revision;
  task = result;
  failed = ['failed', 'cancelled', 'paused'].includes(result.state);
  if (changed) {
    if (Array.isArray(result.cues)) cues = result.cues;
    if (Array.isArray(result.translations)) translations = new Map(result.translations.map(row => [row.id, row.text]));
  }
  const count = `${result.translatedCount ?? translations.size} / ${result.total ?? cues.length}`;
  clearTimeout(fetchTimer); clearTimeout(recoveryTimer); clearTimeout(missingTimer);
  if (result.state === 'complete') {
    setStatus(`已翻译 ${count} 条字幕`);
  } else if (failed) {
    setStatus(`${result.state === 'cancelled' ? '已取消' : result.state === 'paused' ? '已暂停' : '未完成'} · 已翻译 ${count}`);
  } else if (result.state === 'buffered') {
    setStatus(`缓冲就绪 · 已翻译 ${count}`);
  } else setStatus(`${result.retryingCount ? '等待重试' : '正在翻译'} · ${count}`);
  updateControls();
}
async function resumeTask() {
  if (!task?.id || submitting) return;
  const id = task.id, version = generation;
  submitting = true; failed = false; updateControls();
  try {
    const result = await request('track:resume', { id });
    if (version === generation && id === task?.id && enabled) { applyTask(result); void reportPosition('activate'); }
  } catch { if (version === generation) reportFailure('track:resume', '未完成，可点击恢复翻译。'); }
  finally { if (version === generation) { submitting = false; updateControls(); } }
}
async function lookupTrack() {
  const track = selectedTrack();
  if (!enabled || !track || !settings?.ready || submitting) return;
  const key = `${currentVideo}:${track.language}:${track.automatic}`;
  if (lookupKey === key) return;
  lookupKey = key;
  const version = generation, sequence = ++lookupSequence;
  try {
    const saved = await request('track:lookup', { videoId: currentVideo, track });
    if (version !== generation || sequence !== lookupSequence || !enabled) return;
    if (saved) {
      applyTask(saved);
      // Lookup has only a track identity. Fetch the full source again so start
      // can verify its fingerprint before resuming a paid partial task.
      bridge('fetch-track', { trackId });
    }
  } catch {
    if (version === generation && !task) logFailure('track:lookup');
  }
}
async function submitTrack(force = false) {
  const track = selectedTrack();
  if (!enabled || !track || !cues.length || submitting || !settings?.ready) return;
  const source = JSON.stringify(cues);
  if (!force && submittedSource === source) return;
  submittedSource = source; lookupSequence++;
  const version = generation;
  submitting = true; failed = false;
  sourceVerified = true;
  if (force) { translations = new Map(); task = null; }
  setStatus('正在翻译');
  try {
    const result = await request('track:start', {
      videoId: currentVideo,
      title: document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim()
        || document.title.replace(/\s*-\s*YouTube\s*$/, ''),
      track, cues, force, playback: playbackSnapshot('activate'),
    });
    if (version === generation && enabled) applyTask(result);
  } catch {
    if (version === generation) { failed = true; sourceVerified = false; submittedSource = ''; reportFailure('track:start', '未完成，可点击重试。'); }
  } finally {
    if (version === generation) { submitting = false; updateControls(); }
  }
}
async function pollTask() {
  if (!task?.id || polling) return;
  const version = generation, id = task.id;
  polling = true;
  try {
    const result = await request('track:status', { id });
    if (version === generation && id === task?.id) applyTask(result);
  } catch {
    if (version === generation) logFailure('track:status');
  } finally { if (version === generation) polling = false; }
}
function scheduleCapture() {
  clearTimeout(fetchTimer); clearTimeout(recoveryTimer); clearTimeout(missingTimer);
  void lookupTrack();
  fetchTimer = setTimeout(() => { if (enabled && !task && !cues.length) bridge('fetch-track', { trackId }); }, 1200);
  recoveryTimer = setTimeout(() => {
    if (enabled && !task && !cues.length && !failed) bridge('enable', { trackId: requestedTrack(), rearm: true });
  }, 6500);
  missingTimer = setTimeout(() => {
    if (enabled && !task && !cues.length && !failed && !player?.classList.contains('ad-showing')) {
      failed = true; reportFailure('captions:timeout', '字幕尚未就绪，可点击重试。');
    }
  }, 30000);
}
function applyAppearance() {
  if (!player || !settings) return;
  player.style.setProperty('--ytbl-font-size', `${settings.fontSize}px`);
  player.style.setProperty('--ytbl-bottom', `${settings.bottomOffset}px`);
}
function setEnabled(value) {
  if (value && !settings?.ready) {
    setStatus('请先配置 API 地址、模型与目标语言。');
    request('settings:open').catch(() => {}); return;
  }
  enabled = value;
  void reportPosition('toggle');
  player?.classList.toggle('ytbl-enabled', enabled);
  button?.setAttribute('aria-pressed', String(enabled));
  if (enabled) {
    setStatus('正在获取完整字幕…'); bridge('enable', { trackId: requestedTrack() }); scheduleCapture();
    if (task?.id) void reportPosition('activate');
  } else { bridge('disable'); setStatus('双语字幕已关闭'); }
}
async function cacheSubtitles() {
  if (!task?.id || caching) return;
  if (!settings?.cacheConfigured) { await request('settings:open'); return; }
  const id = task.id, version = generation;
  caching = true; updateControls();
  try {
    const result = await request('track:cache', { id });
    if (version === generation && id === task?.id) {
      task.cachePath = result.path; task.cachedCount = result.translatedCount;
      setStatus(`${result.complete ? '已缓存' : '部分缓存'} · ${result.translatedCount} / ${result.total}`);
      cacheButton.title = result.path;
    }
  } catch { if (version === generation) reportFailure('track:cache', '缓存未完成，请检查设置中的目录与缓存组件。'); }
  finally { caching = false; updateControls(); }
}
function element(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text) result.textContent = text;
  return result;
}
function attachPlayer(nextPlayer, nextVideo) {
  player?.classList.remove('ytbl-enabled', 'ytbl-rendering');
  overlay?.remove(); progress?.remove(); button?.remove(); cacheButton?.remove(); panel?.remove();
  player = nextPlayer; video = nextVideo;
  bindPlayback();
  overlay = element('div', 'ytbl-overlay'); overlay.hidden = true;
  originalLine = element('div', 'ytbl-original'); translatedLine = element('div', 'ytbl-translated');
  overlay.append(originalLine, translatedLine); player.append(overlay);
  progress = element('div', 'ytbl-progress', '正在翻译'); progress.hidden = true;
  progress.setAttribute('role', 'status'); player.append(progress);
  button = element('button', 'ytbl-toggle', '双语字幕'); button.type = 'button';
  button.title = '单击开关双语字幕；右键打开字幕设置'; button.setAttribute('aria-pressed', String(enabled));
  cacheButton = element('button', 'ytbl-cache', '缓存字幕'); cacheButton.type = 'button';
  cacheButton.addEventListener('click', event => { event.stopPropagation(); void cacheSubtitles(); });
  button.addEventListener('click', event => { event.stopPropagation(); setEnabled(!enabled); });
  button.addEventListener('contextmenu', event => {
    event.preventDefault(); event.stopPropagation(); panel.hidden = !panel.hidden;
  });
  const controls = player.querySelector('.ytp-right-controls');
  button.classList.toggle('ytbl-floating', !controls); cacheButton.classList.toggle('ytbl-floating', !controls);
  (controls || player).prepend(button, cacheButton);
  panel = element('div', 'ytbl-panel'); panel.hidden = true;
  panel.addEventListener('click', event => event.stopPropagation());
  const title = element('strong', '', 'YouTube 双语字幕');
  const close = element('button', 'ytbl-close', '×');
  close.title = '关闭设置面板'; close.addEventListener('click', () => { panel.hidden = true; });
  const label = element('label', '', '原字幕语言'); trackSelect = element('select', 'ytbl-track');
  trackSelect.addEventListener('change', () => {
    trackId = trackSelect.value; manualTrack = true;
    if (enabled) { resetView(); bridge('select-track', { trackId }); scheduleCapture(); setStatus('正在获取完整字幕…'); }
  });
  label.append(trackSelect);
  status = element('p', 'ytbl-status', enabled ? '正在获取完整字幕…' : '双语字幕已关闭'); status.setAttribute('role', 'status');
  const actions = element('div', 'ytbl-actions'); retryButton = element('button', 'ytbl-retry', '重试');
  retryButton.addEventListener('click', () => {
    failed = false;
    if (!enabled) setEnabled(true);
    else if (task?.id && task.state !== 'complete') void resumeTask();
    else if (cues.length) void submitTrack(task?.state === 'complete');
    else {
      lookupKey = ''; submittedSource = ''; bridge('enable', { trackId: requestedTrack(), rearm: true });
      bridge('fetch-track', { trackId }); scheduleCapture(); setStatus('正在获取完整字幕…');
    }
  });
  cancelButton = element('button', 'ytbl-cancel', '取消翻译');
  cancelButton.addEventListener('click', async () => {
    const id = task?.id, version = generation;
    if (!id) return;
    try {
      await request('track:cancel', { id }); const result = await request('track:status', { id });
      if (version === generation && id === task?.id) applyTask(result);
    } catch { if (version === generation) reportFailure('track:cancel'); }
  });
  const config = element('button', '', 'API 与已保存字幕');
  config.addEventListener('click', () => request('settings:open').catch(() => reportFailure('settings:open')));
  actions.append(retryButton, cancelButton, config);
  const exportActions = element('div', 'ytbl-export-actions');
  exportMode = element('select', 'ytbl-export-mode'); exportMode.setAttribute('aria-label', 'SRT 导出内容');
  for (const [value, text] of [['bilingual', '双语'], ['translated', '译文'], ['original', '原文']]) {
    const option = element('option', '', text); option.value = value; exportMode.append(option);
  }
  exportMode.addEventListener('change', updateControls);
  exportButton = element('button', 'ytbl-export', '导出 SRT');
  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true;
    try { await request('track:download', { id: task.id, mode: exportMode.value }); }
    catch { reportFailure('track:download', '字幕尚未导出，可稍后重试。'); }
    finally { updateControls(); }
  });
  exportActions.append(exportMode, exportButton);
  panel.append(title, close, label, status, actions, exportActions); player.append(panel);
  player.classList.toggle('ytbl-enabled', enabled); applyAppearance(); updateTracks(); updateControls();
}
function updateTracks() {
  if (!trackSelect) return;
  trackSelect.replaceChildren();
  for (const track of tracks) {
    const option = element('option', '', `${track.name}${track.automatic ? '（自动生成）' : ''}`);
    option.value = track.id; trackSelect.append(option);
  }
  if (!tracks.length) { const option = element('option', '', '等待 YouTube 字幕'); option.value = ''; trackSelect.append(option); }
  trackSelect.value = trackId;
}
function synchronizePage() {
  const id = new URL(location.href).searchParams.get('v') || '';
  const nextPlayer = document.getElementById('movie_player'), nextVideo = nextPlayer?.querySelector('video');
  if (!id || !nextPlayer || !nextVideo) {
    if (currentVideo) {
      resetView(); bridge('disable'); player?.classList.remove('ytbl-enabled', 'ytbl-rendering');
      detachPlayback(); detachPlayback = () => {};
      overlay?.remove(); progress?.remove(); button?.remove(); cacheButton?.remove(); panel?.remove(); player = null; video = null; currentVideo = '';
    }
    return;
  }
  const changed = id !== currentVideo;
  if (changed) { currentVideo = id; tracks = []; trackId = ''; manualTrack = false; resetView(); }
  const rebound = nextPlayer !== player || nextVideo !== video || !overlay?.isConnected;
  if (rebound) { if (!changed) resetView(); attachPlayer(nextPlayer, nextVideo); }
  const controls = player.querySelector('.ytp-right-controls');
  if (controls && button.parentElement !== controls) {
    button.classList.remove('ytbl-floating'); cacheButton.classList.remove('ytbl-floating'); controls.prepend(button, cacheButton);
    if (enabled) { bridge('enable', { trackId: requestedTrack() }); scheduleCapture(); }
  }
  if (changed || rebound) {
    bridge('refresh');
    if (enabled) { bridge('enable', { trackId: requestedTrack() }); scheduleCapture(); setStatus('正在获取完整字幕…'); }
  }
}
window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== window || event.origin !== location.origin || message?.channel !== CHANNEL
    || message.direction !== 'page' || message.videoId !== currentVideo) return;
  if (message.type === 'metadata' && Array.isArray(message.tracks)) {
    tracks = message.tracks;
    const keepCurrent = manualTrack || (settings?.sourceLanguage === 'auto' && !message.currentId);
    const awaitingNative = settings?.sourceLanguage === 'auto' && !manualTrack && !message.currentId && !trackId && tracks.length > 1;
    const selected = awaitingNative ? null : (keepCurrent && selectedTrack()) || chooseTrack(tracks, settings?.sourceLanguage || 'auto', message.currentId);
    const previous = trackId; trackId = selected?.id || ''; updateTracks();
    if (enabled && !tracks.length) setStatus('此视频暂无可用字幕。');
    if (enabled && trackId && previous !== trackId) {
      resetView(); bridge('select-track', { trackId: requestedTrack() }); scheduleCapture();
    } else void lookupTrack();
  }
  if (message.type === 'captions' && enabled && typeof message.body === 'string') {
    const track = selectedTrack();
    if (!track || (message.language && message.language !== track.language) || message.automatic !== track.automatic) return;
    if (message.body === lastCapture) return;
    try {
      const parsed = parseCaptionPayload(message.body);
      if (!parsed.length) return;
      lastCapture = message.body;
      clearTimeout(fetchTimer); clearTimeout(recoveryTimer); clearTimeout(missingTimer);
      if (JSON.stringify(parsed) === JSON.stringify(cues) && task) {
        if (!sourceVerified) void submitTrack();
        return;
      }
      generation++; lookupSequence++; polling = false; submitting = false;
      cues = parsed; translations = new Map(); task = null;
      failed = false; void submitTrack();
    } catch { if (!failed) reportFailure('captions:parse', '字幕尚未就绪，可点击重试。'); }
  }
  if (message.type === 'status' && enabled && message.failed && task) logFailure('captions:fetch');
  if (message.type === 'status' && enabled && !task && !cues.length && !failed) {
    if (message.failed) { failed = true; reportFailure('captions:fetch', '字幕尚未就绪，可点击重试。'); }
    else setStatus('正在获取完整字幕…');
  }
});
function render() {
  if (!player || !video) return;
  const advert = isAdvert();
  if (advert !== wasAdvert) void reportPosition('advert');
  const advertEnded = wasAdvert && !advert;
  wasAdvert = advert;
  if (enabled && advertEnded) {
    // The source can fail while YouTube is showing an ad. Recover its CC
    // state before checking whether the independent translation is complete.
    bridge('enable', { trackId: requestedTrack(), rearm: true });
    void reportPosition('activate');
    if (!task && !cues.length) { failed = false; lookupKey = ''; scheduleCapture(); }
  }
  progress.hidden = !enabled || advert || failed || ['complete', 'buffered'].includes(task?.state) || video.ended;
  progress.textContent = task?.retryingCount ? '等待重试' : busy() ? '正在翻译' : '正在获取完整字幕…';
  if (!enabled || advert || video.ended) {
    overlay.hidden = true; player.classList.remove('ytbl-rendering'); return;
  }
  const cue = activeCue(cues, video.currentTime);
  const translated = cue ? translations.get(cue.id) || '' : '';
  originalLine.textContent = translated ? cue.text : ''; translatedLine.textContent = translated;
  overlay.hidden = !translated; player.classList.toggle('ytbl-rendering', Boolean(translated));
}
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  try {
    settings = await request('settings:public'); applyAppearance();
    resetView();
    trackId = ''; manualTrack = false; bridge('refresh');
    if (enabled) setEnabled(settings.ready);
  } catch { logFailure('settings:public'); }
});
document.addEventListener('visibilitychange', () => void reportPosition('visibility'));
window.addEventListener('pagehide', () => {
  const snapshot = playbackSnapshot('detach'); snapshot.active = false;
  request('track:position', { id: task?.id, videoId: currentVideo, ...snapshot }).catch(() => {});
});
window.addEventListener('focus', () => void reportPosition('activate'));
async function start() {
  settings = await request('settings:public'); enabled = settings.autoEnable && settings.ready;
  synchronizePage(); document.addEventListener('yt-navigate-finish', synchronizePage);
  setInterval(synchronizePage, 500); setInterval(render, 120); setInterval(() => void pollTask(), 700);
  setInterval(() => void reportPosition('heartbeat'), 2500);
}
start().catch(() => logFailure('initialize'));

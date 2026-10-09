import { activeCue, chooseTrack, parseCaptionPayload } from '../shared/captions.js';

const CHANNEL = 'youtube-bilingual-local-v1';
let settings, player, video, overlay, originalLine, translatedLine, progress;
let button, panel, status, trackSelect, retryButton, cancelButton, exportMode, exportButton;
let enabled = false, currentVideo = '', generation = 0;
let tracks = [], trackId = '', manualTrack = false;
let cues = [], translations = new Map(), task = null;
let submitting = false, polling = false, failed = false;
let lastCapture = '', submittedSource = '', lookupKey = '', lookupSequence = 0;
let fetchTimer, recoveryTimer, missingTimer, wasAdvert = false;

async function request(type, data = {}) {
  const result = await browser.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有响应。');
  return result.data;
}
function bridge(type, data = {}) {
  window.postMessage({ channel: CHANNEL, direction: 'content', type, ...data }, location.origin);
}
const selectedTrack = () => tracks.find(item => item.id === trackId);
const busy = () => submitting || task?.state === 'queued' || task?.state === 'translating';
const requestedTrack = () => settings?.sourceLanguage === 'auto' && !manualTrack ? '' : trackId;

function updateControls() {
  if (!exportButton) return;
  exportButton.disabled = !task?.id || (exportMode.value !== 'original' && task.state !== 'complete');
  cancelButton.disabled = !task?.id || !busy();
  retryButton.disabled = busy();
  retryButton.textContent = task?.state === 'complete' ? '重新翻译' : '重试';
}
function setStatus(text, error = false) {
  if (status) { status.textContent = text; status.dataset.error = String(error); }
  updateControls();
}

// Detaching a player view never cancels its independently owned background job.
function resetView() {
  generation++; lookupSequence++;
  cues = []; translations = new Map(); task = null;
  submitting = false; polling = false; failed = false;
  lastCapture = ''; submittedSource = ''; lookupKey = '';
  clearTimeout(fetchTimer); clearTimeout(recoveryTimer); clearTimeout(missingTimer);
  if (overlay) overlay.hidden = true;
  if (progress) progress.hidden = true;
  if (originalLine) originalLine.textContent = '';
  if (translatedLine) translatedLine.textContent = '';
  player?.classList.remove('ytbl-rendering'); updateControls();
}
function applyTask(result) {
  if (!result) return;
  task = result;
  failed = result.state === 'failed' || result.state === 'cancelled';
  if (result.state === 'complete') {
    cues = result.cues;
    translations = new Map(result.translations.map(row => [row.id, row.text]));
    clearTimeout(fetchTimer); clearTimeout(recoveryTimer); clearTimeout(missingTimer);
    setStatus(`已翻译 ${translations.size} / ${cues.length} 条字幕${result.cached ? '（已保存）' : ''}`);
  } else if (failed) {
    setStatus(result.error || (result.state === 'cancelled' ? '翻译已取消，可点击重试。' : '翻译失败，可点击重试。'), true);
    if (panel) panel.hidden = false;
  } else setStatus('正在翻译');
  updateControls();
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
    if (saved) applyTask(saved);
  } catch (error) {
    if (version === generation && !task) setStatus(error.message, true);
  }
}
async function submitTrack(force = false) {
  const track = selectedTrack();
  if (!enabled || !track || !cues.length || submitting || !settings?.ready) return;
  const source = JSON.stringify(cues);
  if (!force && submittedSource === source) return;
  submittedSource = source; lookupSequence++;
  const version = generation;
  submitting = true; failed = false; translations = new Map(); task = null;
  setStatus('正在翻译');
  try {
    const result = await request('track:start', {
      videoId: currentVideo,
      title: document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim()
        || document.title.replace(/\s*-\s*YouTube\s*$/, ''),
      track, cues, force,
    });
    if (version === generation && enabled) applyTask(result);
  } catch (error) {
    if (version === generation) { failed = true; setStatus(error.message, true); panel.hidden = false; }
  } finally {
    if (version === generation) { submitting = false; updateControls(); }
  }
}
async function pollTask() {
  if (!task?.id || polling || ['complete', 'failed', 'cancelled'].includes(task.state)) return;
  const version = generation, id = task.id;
  polling = true;
  try {
    const result = await request('track:status', { id });
    if (version === generation && id === task?.id) applyTask(result);
  } catch (error) {
    if (version === generation) { failed = true; setStatus(error.message, true); }
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
      failed = true; setStatus('无法获取完整字幕。请确认视频提供字幕，再点击重试。', true); panel.hidden = false;
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
    setStatus('请先配置 API 地址、模型与目标语言。', true); panel.hidden = false;
    request('settings:open').catch(() => {}); return;
  }
  enabled = value; resetView();
  player?.classList.toggle('ytbl-enabled', enabled);
  button?.setAttribute('aria-pressed', String(enabled));
  if (enabled) {
    setStatus('正在获取完整字幕…'); bridge('enable', { trackId: requestedTrack() }); scheduleCapture();
  } else { bridge('disable'); setStatus('双语字幕已关闭；已提交的翻译会在后台继续。'); }
}
function element(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text) result.textContent = text;
  return result;
}
function attachPlayer(nextPlayer, nextVideo) {
  player?.classList.remove('ytbl-enabled', 'ytbl-rendering');
  overlay?.remove(); progress?.remove(); button?.remove(); panel?.remove();
  player = nextPlayer; video = nextVideo;
  overlay = element('div', 'ytbl-overlay'); overlay.hidden = true;
  originalLine = element('div', 'ytbl-original'); translatedLine = element('div', 'ytbl-translated');
  overlay.append(originalLine, translatedLine); player.append(overlay);
  progress = element('div', 'ytbl-progress', '正在翻译'); progress.hidden = true;
  progress.setAttribute('role', 'status'); player.append(progress);
  button = element('button', 'ytbl-toggle', '双语字幕'); button.type = 'button';
  button.title = '单击开关双语字幕；右键打开字幕设置'; button.setAttribute('aria-pressed', String(enabled));
  button.addEventListener('click', event => { event.stopPropagation(); setEnabled(!enabled); });
  button.addEventListener('contextmenu', event => {
    event.preventDefault(); event.stopPropagation(); panel.hidden = !panel.hidden;
  });
  const controls = player.querySelector('.ytp-right-controls');
  button.classList.toggle('ytbl-floating', !controls); (controls || player).prepend(button);
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
    else if (cues.length) void submitTrack(true);
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
    } catch (error) { if (version === generation) setStatus(error.message, true); }
  });
  const config = element('button', '', 'API 与已保存字幕');
  config.addEventListener('click', () => request('settings:open').catch(error => setStatus(error.message, true)));
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
    catch (error) { setStatus(error.message, true); }
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
      overlay?.remove(); progress?.remove(); button?.remove(); panel?.remove(); player = null; video = null; currentVideo = '';
    }
    return;
  }
  const changed = id !== currentVideo;
  if (changed) { currentVideo = id; tracks = []; trackId = ''; manualTrack = false; resetView(); }
  const rebound = nextPlayer !== player || nextVideo !== video || !overlay?.isConnected;
  if (rebound) { if (!changed) resetView(); attachPlayer(nextPlayer, nextVideo); }
  const controls = player.querySelector('.ytp-right-controls');
  if (controls && button.parentElement !== controls) {
    button.classList.remove('ytbl-floating'); controls.prepend(button);
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
    if (enabled && !tracks.length) setStatus('此视频未提供字幕。需要人工或自动生成字幕。', true);
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
      if (JSON.stringify(parsed) === JSON.stringify(cues) && task) return;
      generation++; lookupSequence++; polling = false; submitting = false;
      cues = parsed; translations = new Map(); task = null;
      if (!failed) void submitTrack();
    } catch { if (!failed) setStatus('完整字幕格式无法解析，请点击重试。', true); }
  }
  if (message.type === 'status' && enabled && !task && !cues.length && !failed) {
    if (message.failed) { failed = true; panel.hidden = false; }
    setStatus(message.message, Boolean(message.failed));
  }
});
function render() {
  if (!player || !video) return;
  const advert = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  const advertEnded = wasAdvert && !advert;
  wasAdvert = advert;
  if (enabled && advertEnded) {
    // The source can fail while YouTube is showing an ad. Recover its CC
    // state before checking whether the independent translation is complete.
    bridge('enable', { trackId: requestedTrack(), rearm: true });
    if (!task && !cues.length) { failed = false; lookupKey = ''; scheduleCapture(); }
  }
  progress.hidden = !enabled || advert || failed || task?.state === 'complete' || video.ended;
  progress.textContent = busy() ? '正在翻译' : '正在获取完整字幕…';
  if (!enabled || advert || video.ended || busy() || failed || task?.state !== 'complete') {
    overlay.hidden = true; player.classList.remove('ytbl-rendering'); return;
  }
  const cue = activeCue(cues, video.currentTime);
  originalLine.textContent = cue?.text || ''; translatedLine.textContent = cue ? translations.get(cue.id) || '' : '';
  overlay.hidden = !cue; player.classList.toggle('ytbl-rendering', Boolean(cue));
}
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settings = await request('settings:public'); applyAppearance();
  trackId = ''; manualTrack = false; bridge('refresh');
  if (enabled) setEnabled(settings.ready);
});
async function start() {
  settings = await request('settings:public'); enabled = settings.autoEnable && settings.ready;
  synchronizePage(); document.addEventListener('yt-navigate-finish', synchronizePage);
  setInterval(synchronizePage, 500); setInterval(render, 120); setInterval(() => void pollTask(), 700);
}
start().catch(() => {});

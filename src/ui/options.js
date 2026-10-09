import { apiOriginPattern, normalizeSettings, readSettings, SETTINGS_KEY, validateSettings } from '../shared/settings.js';

const form = document.getElementById('settings-form');
const status = document.getElementById('status');
const saveButton = document.getElementById('save');
const testButton = document.getElementById('test');
const fields = ['apiBaseUrl', 'apiKey', 'model', 'targetLanguage', 'sourceLanguage', 'fontSize', 'bottomOffset', 'autoEnable'];

const previewCanvas = document.getElementById('preview-canvas');
function updatePreview() {
  const fontSize = Math.max(14, Math.min(48, Number(document.getElementById('fontSize').value) || 24));
  const offset = Math.max(20, Math.min(240, Number(document.getElementById('bottomOffset').value) || 70));
  previewCanvas.style.setProperty('--preview-font', `${fontSize}px`);
  previewCanvas.style.setProperty('--preview-offset', `${Math.min(offset, 324 - fontSize * 3)}px`);
}
for (const id of ['fontSize', 'bottomOffset']) document.getElementById(id).addEventListener('input', updatePreview);
new ResizeObserver(entries => {
  previewCanvas.style.setProperty('--preview-scale', entries[0].contentRect.width / 640);
}).observe(previewCanvas.parentElement);
updatePreview();

function display(text, error = false) {
  status.textContent = text; status.dataset.error = String(error);
}

function collect() {
  return normalizeSettings(Object.fromEntries(fields.map(id => {
    const input = document.getElementById(id);
    return [id, input.type === 'checkbox' ? input.checked : input.value];
  })));
}

async function save() {
  const settings = collect();
  validateSettings(settings);
  // Called immediately from the submit/click handler to preserve the user gesture.
  const granted = await browser.permissions.request({ origins: [apiOriginPattern(settings)] });
  if (!granted) throw new Error('未授予 API 地址访问权限，设置尚未保存。');
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  saveButton.disabled = true; testButton.disabled = true;
  try { await save(); display('设置已保存。返回 YouTube 即可启用双语字幕。'); }
  catch (error) { display(error.message, true); }
  finally { saveButton.disabled = false; testButton.disabled = false; }
});

testButton.addEventListener('click', async () => {
  if (!form.reportValidity()) return;
  saveButton.disabled = true; testButton.disabled = true;
  try {
    await save();
    display('正在发送一条测试字幕…');
    const result = await browser.runtime.sendMessage({ type: 'api:test' });
    if (!result?.ok) throw new Error(result?.error || '扩展后台没有响应。');
    display(`连接成功，测试译文：${result.data[0].text}`);
  } catch (error) { display(error.message, true); }
  finally { saveButton.disabled = false; testButton.disabled = false; }
});

readSettings(browser.storage.local).then(settings => {
  for (const id of fields) {
    const input = document.getElementById(id);
    if (input.type === 'checkbox') input.checked = settings[id]; else input.value = settings[id];
  }
  updatePreview();
}).catch(error => display(error.message, true));

const libraryList = document.getElementById('library-list');
const libraryStatus = document.getElementById('library-status');
const selectedModes = new Map();
let refreshing = false;
let librarySignature = '';

async function trackRequest(type, data = {}) {
  const result = await browser.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有响应。');
  return result.data;
}

function makeElement(tag, text, className = '') {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

async function refreshLibrary() {
  if (refreshing) return;
  refreshing = true;
  try {
    const records = await trackRequest('track:list');
    const signature = JSON.stringify(records);
    if (signature === librarySignature) return;
    librarySignature = signature;
    document.getElementById('library-count').textContent = `${records.length} 项`;
    document.getElementById('library-empty').hidden = records.length > 0;
    const labels = { queued: '等待翻译', translating: '正在翻译', complete: '已保存', failed: '未完成', cancelled: '已取消' };
    const cards = records.map(record => {
      const card = makeElement('article', '', 'subtitle-record');
      card.dataset.taskId = record.id;
      card.dataset.state = record.state;
      const title = makeElement('a', record.title || record.videoId);
      title.href = `https://www.youtube.com/watch?v=${encodeURIComponent(record.videoId)}`;
      title.target = '_blank'; title.rel = 'noopener noreferrer';
      const heading = makeElement('div', '', 'record-heading');
      heading.append(title, makeElement('span', labels[record.state] || record.state, 'record-state'));
      const detail = makeElement('p', `${record.track.language}${record.track.automatic ? '（自动生成）' : ''} → ${record.targetLanguage} · ${record.model}`);
      card.append(heading, detail);
      if (record.error) card.append(makeElement('p', record.error, 'record-error'));
      const actions = makeElement('div', '', 'record-actions');
      const mode = makeElement('select'); mode.setAttribute('aria-label', 'SRT 导出内容');
      for (const [value, label] of [['bilingual', '双语'], ['translated', '译文'], ['original', '原文']]) {
        const option = makeElement('option', label); option.value = value; mode.append(option);
      }
      mode.value = selectedModes.get(record.id) || (record.state === 'complete' ? 'bilingual' : 'original');
      const download = makeElement('button', '导出 SRT', 'secondary'); download.type = 'button';
      const updateDownload = () => { download.disabled = record.state !== 'complete' && mode.value !== 'original'; };
      mode.addEventListener('change', () => { selectedModes.set(record.id, mode.value); updateDownload(); });
      updateDownload();
      download.addEventListener('click', async () => {
        download.disabled = true;
        try { await trackRequest('track:download', { id: record.id, mode: mode.value }); libraryStatus.textContent = '已打开字幕保存窗口。'; }
        catch (error) { libraryStatus.textContent = error.message; }
        finally { updateDownload(); }
      });
      actions.append(mode, download);
      if (record.state === 'queued' || record.state === 'translating') {
        const cancel = makeElement('button', '取消翻译', 'secondary'); cancel.type = 'button';
        cancel.addEventListener('click', async () => {
          cancel.disabled = true;
          try { await trackRequest('track:cancel', { id: record.id }); await refreshLibrary(); }
          catch (error) { libraryStatus.textContent = error.message; cancel.disabled = false; }
        });
        actions.append(cancel);
      }
      card.append(actions); return card;
    });
    libraryList.replaceChildren(...cards);
  } catch (error) { libraryStatus.textContent = error.message; }
  finally { refreshing = false; }
}

document.getElementById('refresh-library').addEventListener('click', () => void refreshLibrary());
document.getElementById('clear-library').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    await trackRequest('track:clear');
    libraryStatus.textContent = '已清除保存的译文；正在运行的任务继续执行。';
    await refreshLibrary();
  } catch (error) { libraryStatus.textContent = error.message; }
  finally { button.disabled = false; }
});
void refreshLibrary();
setInterval(() => { if (!document.hidden) void refreshLibrary(); }, 2500);

import { apiOriginPattern, enabledModels, publicSettings, readSettings } from '../shared/settings.js';
import { TranslationService, translateCues } from './translator.js';
import { TrackTaskService } from './track-tasks.js';
import { SubtitleCache } from './subtitle-cache.js';

const loadSettings = () => readSettings(browser.storage.local);
const service = new TranslationService({
  loadSettings,
  hasPermission: (settings) => browser.permissions.contains({ origins: [apiOriginPattern(settings)] }),
});
const cache = new SubtitleCache();
const tasks = new TrackTaskService({
  cache,
  storage: browser.storage.local,
  loadSettings,
  hasPermission: (settings) => browser.permissions.contains({ origins: [apiOriginPattern(settings)] }),
});
const downloadUrls = new Map();

function releaseDownload(downloadId) {
  const url = downloadUrls.get(downloadId);
  if (!url) return;
  URL.revokeObjectURL(url);
  downloadUrls.delete(downloadId);
}

browser.downloads?.onChanged.addListener((change) => {
  if (['complete', 'interrupted'].includes(change.state?.current)) releaseDownload(change.id);
});
browser.tabs?.onRemoved.addListener(tabId => tasks.detach(tabId));
browser.tabs?.onUpdated.addListener((tabId, change) => { if (change.status === 'loading' || change.url) tasks.detach(tabId); });

async function downloadSrt(message) {
  const { filename, content } = await tasks.export(message.id, message.mode);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/x-subrip;charset=utf-8' }));
  let downloadId;
  try {
    downloadId = await browser.downloads.download({ url, filename, saveAs: message.saveAs !== false, conflictAction: 'uniquify' });
    downloadUrls.set(downloadId, url);
    // A small download can finish before its initial promise resolves.
    const [download] = await browser.downloads.search({ id: downloadId });
    if (['complete', 'interrupted'].includes(download?.state)) releaseDownload(downloadId);
    return { downloadId, filename };
  } catch {
    if (downloadId !== undefined) releaseDownload(downloadId);
    else URL.revokeObjectURL(url);
    throw new Error('字幕下载未完成，请重试。');
  }
}

function trustedPage(sender) {
  try { return new URL(sender.url).origin === 'https://www.youtube.com' && Number.isInteger(sender.tab?.id); }
  catch { return false; }
}

browser.runtime.onMessage.addListener((message, sender) => {
  const fromOptions = sender.url?.startsWith(browser.runtime.getURL('options.html'));
  const fromPopup = sender.url?.startsWith(browser.runtime.getURL('popup.html'));
  if (!trustedPage(sender) && !fromOptions && !fromPopup) return undefined;
  return (async () => {
    switch (message?.type) {
      case 'settings:public': return publicSettings(await loadSettings());
      case 'settings:open': await browser.runtime.openOptionsPage(); return null;
      case 'track:start':
        if (!trustedPage(sender)) throw new Error('请从 YouTube 页面获取字幕。');
        return tasks.start(message, sender.tab.id);
      case 'track:position':
        if (!trustedPage(sender)) throw new Error('播放位置请求来源不正确。');
        return tasks.position(message, sender.tab.id);
      case 'track:cache':
        if (!trustedPage(sender) && !fromOptions) throw new Error('缓存请求来源不正确。');
        return tasks.snapshot(message.id);
      case 'cache:validate':
        if (!fromOptions) throw new Error('请从设置页配置缓存目录。');
        return cache.validate(message.folder);
      case 'cache:open':
        if (!fromOptions) throw new Error('请从设置页定位缓存目录。');
        return cache.open((await loadSettings()).cacheFolder);
      case 'track:resume':
        if (!trustedPage(sender) && !fromOptions) throw new Error('恢复请求来源不正确。');
        return tasks.resume(message.id);
      case 'track:lookup': return tasks.lookup(message);
      case 'track:status': return tasks.status(message.id);
      case 'track:list': return tasks.list();
      case 'track:cancel': return tasks.cancel(message.id);
      case 'track:clear':
        if (!fromOptions) throw new Error('请从设置页清除已保存的译文。');
        return tasks.clear();
      case 'track:export': return tasks.export(message.id, message.mode);
      case 'track:download': return downloadSrt(message);
      case 'translate':
        if (!trustedPage(sender) || typeof message.session !== 'string' || message.session.length > 120) throw new Error('字幕请求来源不正确。');
        return service.translate(`${sender.tab.id}:${message.session}`, message.cues);
      case 'translate:cancel': service.cancel(`${sender.tab?.id}:${message.session}`); return null;
      case 'api:test':
        if (!fromOptions) throw new Error('请从设置页测试接口。');
        {
          const settings = await loadSettings();
          const models = enabledModels(settings);
          const model = message.modelId === undefined ? models[0] : models.find(item => item.id === message.modelId);
          if (!model) throw new Error('请选择已启用的模型。');
          if (!await browser.permissions.contains({ origins: [apiOriginPattern(model)] })) throw new Error('尚未授权访问翻译接口，请保存设置并授权。');
          return translateCues(model, [{ id: 'test', text: 'Hello, welcome to this video.' }]);
        }
      default: throw new Error('未知请求。');
    }
  })().then((data) => ({ ok: true, data }), (error) => {
    console.warn('[YouTube bilingual] operation failed', { operation: message?.type, category: error?.category || 'operation', status: Number.isInteger(error?.status) ? error.status : null });
    return { ok: false, error: '操作未完成，请查看扩展控制台。' };
  });
});

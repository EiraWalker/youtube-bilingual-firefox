export const SETTINGS_KEY = 'settings';
export const DEFAULT_SETTINGS = Object.freeze({
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  targetLanguage: 'zh-CN',
  sourceLanguage: 'auto',
  fontSize: 24,
  bottomOffset: 70,
  autoEnable: false,
  cacheFolder: '',
});

export function completionEndpoint(input) {
  let url;
  try { url = new URL(String(input).trim()); }
  catch { throw new Error('请输入有效的 API 地址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址须为 HTTP/HTTPS，不能包含账号、查询参数或片段。');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/chat/completions') ? pathname
    : `${pathname || '/v1'}/chat/completions`;
  return url.href;
}

export function apiOriginPattern(settings) {
  const url = new URL(completionEndpoint(settings.apiBaseUrl));
  // Firefox match patterns do not support ports; fetch still uses the exact port.
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizeSettings(input = {}) {
  return {
    apiBaseUrl: String(input.apiBaseUrl ?? DEFAULT_SETTINGS.apiBaseUrl).trim(),
    apiKey: String(input.apiKey ?? '').trim(),
    model: String(input.model ?? '').trim(),
    targetLanguage: String(input.targetLanguage || 'zh-CN').trim().slice(0, 80),
    sourceLanguage: String(input.sourceLanguage || 'auto').trim().slice(0, 30),
    fontSize: Math.max(14, Math.min(48, Number(input.fontSize) || 24)),
    bottomOffset: Math.max(20, Math.min(240, Number(input.bottomOffset) || 70)),
    autoEnable: input.autoEnable === true,
    cacheFolder: String(input.cacheFolder ?? '').trim(),
  };
}

export function validateSettings(settings) {
  completionEndpoint(settings.apiBaseUrl);
  if (!settings.model || settings.model.length > 200) throw new Error('请填写接口支持的模型名称。');
  if (!settings.targetLanguage) throw new Error('请选择目标语言。');
  return settings;
}

export function publicSettings(settings) {
  let ready = true;
  try { validateSettings(settings); } catch { ready = false; }
  const { targetLanguage, sourceLanguage, fontSize, bottomOffset, autoEnable } = settings;
  return { targetLanguage, sourceLanguage, fontSize, bottomOffset, autoEnable, ready, cacheConfigured: Boolean(settings.cacheFolder) };
}

export async function readSettings(storage) {
  const saved = await storage.get(SETTINGS_KEY);
  return normalizeSettings(saved[SETTINGS_KEY]);
}

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
  const profiles = Array.isArray(input.models) ? input.models : [{ ...input, id: 'default', name: '默认模型', enabled: true, priority: 1 }];
  const usedIds = new Set();
  const reservedIds = new Set(profiles.map(profile => String(profile?.id ?? '').trim()).filter(Boolean));
  const models = profiles.map((value, index) => {
    const profile = value || {};
    let id = String(profile.id ?? '').trim();
    if (!id || usedIds.has(id)) {
      const base = `model-${index + 1}`;
      id = base;
      let suffix = 1;
      while (usedIds.has(id) || reservedIds.has(id)) id = `${base}-${suffix++}`;
    }
    usedIds.add(id);
    const priority = Number(profile.priority);
    return {
      id,
      name: String(profile.name ?? '').trim().slice(0, 80),
      apiBaseUrl: String(profile.apiBaseUrl ?? DEFAULT_SETTINGS.apiBaseUrl).trim(),
      apiKey: String(profile.apiKey ?? '').trim(),
      model: String(profile.model ?? '').trim(),
      enabled: profile.enabled !== false,
      priority: Number.isFinite(priority) ? Math.max(1, Math.min(1000, Math.floor(priority))) : 1,
    };
  });
  const first = models[0] || {};
  return {
    models,
    // Older single-model callers read these mirrors; profiles own configuration.
    apiBaseUrl: first.apiBaseUrl ?? '',
    apiKey: first.apiKey ?? '',
    model: first.model ?? '',
    targetLanguage: String(input.targetLanguage || 'zh-CN').trim().slice(0, 80),
    sourceLanguage: String(input.sourceLanguage || 'auto').trim().slice(0, 30),
    fontSize: Math.max(14, Math.min(48, Number(input.fontSize) || 24)),
    bottomOffset: Math.max(20, Math.min(240, Number(input.bottomOffset) || 70)),
    autoEnable: input.autoEnable === true,
    cacheFolder: String(input.cacheFolder ?? '').trim(),
  };
}

// Keep configuration order (including tied priorities); scheduling owns racing.
export function enabledModels(settings) {
  const normalized = normalizeSettings(settings);
  return normalized.models.filter(profile => profile.enabled).map(profile => ({ ...profile, targetLanguage: normalized.targetLanguage }));
}

export function apiOriginPatterns(settings) {
  return [...new Set(enabledModels(settings).map(apiOriginPattern))];
}

export function validateSettings(settings) {
  const models = enabledModels(settings);
  if (!models.length) throw new Error('请至少启用一个翻译模型。');
  for (const [index, profile] of models.entries()) {
    try { completionEndpoint(profile.apiBaseUrl); }
    catch { throw new Error(`第 ${index + 1} 个启用模型的 API 地址无效，请使用不含账号、查询参数或片段的 HTTP/HTTPS 地址。`); }
    if (!profile.model || profile.model.length > 200) throw new Error(`请填写第 ${index + 1} 个启用模型的模型名称（最多 200 字符）。`);
  }
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

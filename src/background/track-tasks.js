import { completionEndpoint, validateSettings } from '../shared/settings.js';
import { exportSrt, srtFilename } from '../shared/srt.js';
import { parseTranslations, translateTrack, validateBatch } from './translator.js';

const STORAGE_PREFIX = 'track:v1:';
const ACTIVE_STATES = new Set(['queued', 'translating']);
const TASK_STATES = new Set(['queued', 'translating', 'complete', 'failed', 'cancelled']);

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeTrack(track) {
  if (!track || typeof track.language !== 'string' || !track.language.trim() || track.language.length > 60) throw new Error('源字幕轨道不正确。');
  return {
    id: String(track.id ?? '').slice(0, 160),
    language: track.language.trim(),
    automatic: track.automatic === true,
  };
}

// YouTube can reorder its track list. List indexes are metadata, not identity.
function trackIdentity(track) {
  return [track.language.toLowerCase(), track.automatic];
}

function normalizedRequest(input) {
  if (!input || typeof input.videoId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.videoId)) throw new Error('视频编号不正确。');
  const track = normalizeTrack(input.track);
  validateBatch(input.cues);
  const cues = input.cues.map(({ id, start, end, text }) => {
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) throw new Error('字幕时间轴不正确。');
    return { id, start, end, text };
  });
  return { videoId: input.videoId, title: String(input.title || input.videoId).slice(0, 500), track, cues };
}

function publicTask(entry, includeResult = false) {
  const record = entry.record;
  const result = {
    id: record.id,
    state: record.state,
    total: record.cues.length,
    translatedCount: record.state === 'complete' ? record.cues.length : 0,
    videoId: record.videoId,
    title: record.title,
    track: { ...record.track },
    targetLanguage: record.targetLanguage,
    model: record.model,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cached: entry.cached === true,
  };
  if (record.error) result.error = record.error;
  if (includeResult && record.state === 'complete') {
    result.cues = record.cues.map(cue => ({ ...cue }));
    result.translations = record.translations.map(row => ({ ...row }));
  }
  return result;
}

/** Owns whole-track request identity, persistence and background task lifecycle.
 * A start returns immediately after local persistence. Page ownership and
 * current settings changes never cancel the snapshotted translation request.
 */
export class TrackTaskService {
  constructor({ storage, loadSettings, hasPermission, fetchImpl = fetch, timeoutMs = 600_000, now = Date.now }) {
    Object.assign(this, { storage, loadSettings, hasPermission, fetchImpl, timeoutMs, now });
    this.entries = new Map();
    this.starting = new Map();
    this.queue = Promise.resolve();
    this.ready = this.restore();
    this.ready.catch(() => {});
  }

  async restore() {
    let saved;
    try { saved = await this.storage.get(null); }
    catch { throw new Error('无法读取已保存的字幕，请检查扩展存储后重试。'); }
    for (const [key, value] of Object.entries(saved)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      try {
        if (value?.version !== 1 || key !== `${STORAGE_PREFIX}${value.id}` || !/^[a-f0-9]{64}$/.test(value.id) || !TASK_STATES.has(value.state) || typeof value.configFingerprint !== 'string' || typeof value.model !== 'string' || typeof value.targetLanguage !== 'string') continue;
        const source = normalizedRequest(value);
        // Whitelist persisted fields, even when local storage was edited.
        const record = {
          version: 1, id: value.id, ...source,
          configFingerprint: value.configFingerprint,
          model: value.model, targetLanguage: value.targetLanguage,
          createdAt: Number(value.createdAt) || this.now(),
          updatedAt: Number(value.updatedAt) || this.now(),
          state: value.state,
        };
        if (record.state === 'complete') {
          record.translations = parseTranslations(JSON.stringify({ translations: value.translations }), record.cues);
        } else if (ACTIVE_STATES.has(record.state)) {
          record.state = 'failed';
          record.error = '上次 Firefox 退出时翻译尚未完成，请重新翻译。';
          record.updatedAt = this.now();
        } else if (record.state === 'failed') {
          record.error = '上次翻译未完成，请重新翻译。';
        }
        const entry = { record, cached: record.state === 'complete', persistence: Promise.resolve() };
        this.entries.set(record.id, entry);
      } catch { /* A damaged record must not hide other saved videos. */ }
    }
  }

  async configIdentity(settings) {
    return fingerprint([completionEndpoint(settings.apiBaseUrl), settings.model, settings.targetLanguage]);
  }

  async start(input) {
    await this.ready;
    const source = normalizedRequest(input);
    // Credentials are held only by the live entry, never by its record.
    const settings = { ...validateSettings(await this.loadSettings()) };
    const configFingerprint = await this.configIdentity(settings);
    const id = await fingerprint([source.videoId, trackIdentity(source.track), configFingerprint, source.cues]);
    if (this.starting.has(id)) return this.starting.get(id);
    const pending = this.startPrepared(id, source, settings, configFingerprint, input.force === true);
    this.starting.set(id, pending);
    try { return await pending; }
    finally { if (this.starting.get(id) === pending) this.starting.delete(id); }
  }

  async startPrepared(id, source, settings, configFingerprint, force) {
    const prior = this.entries.get(id);
    if (prior && ACTIVE_STATES.has(prior.record.state)) return publicTask(prior, true);
    if (prior?.record.state === 'complete' && !force) {
      prior.cached = true;
      return publicTask(prior, true);
    }
    if (!await this.hasPermission(settings)) throw new Error('尚未授权访问翻译接口，请打开设置页保存并授权。');
    const time = this.now();
    const entry = {
      record: { version: 1, id, ...source, configFingerprint, model: settings.model, targetLanguage: settings.targetLanguage, createdAt: time, updatedAt: time, state: 'queued' },
      settings,
      controller: new AbortController(),
      cached: false,
      persistence: Promise.resolve(),
    };
    await this.persist(entry, entry.record);
    this.entries.set(id, entry);
    this.queue = this.queue.catch(() => {}).then(() => this.run(entry));
    return publicTask(entry, true);
  }

  persist(entry, record) {
    const value = structuredClone(record);
    const pending = entry.persistence.catch(() => {}).then(async () => {
      try { await this.storage.set({ [`${STORAGE_PREFIX}${value.id}`]: value }); }
      catch { throw new Error('无法保存完整字幕或译文，请检查扩展存储空间后重试。'); }
    });
    entry.persistence = pending;
    return pending;
  }

  async run(entry) {
    if (entry.controller.signal.aborted) return;
    try {
      entry.record = { ...entry.record, state: 'translating', updatedAt: this.now() };
      const translations = await translateTrack(entry.settings, entry.record.cues, { fetchImpl: this.fetchImpl, signal: entry.controller.signal, timeoutMs: this.timeoutMs });
      if (entry.controller.signal.aborted) return;
      const complete = { ...entry.record, state: 'complete', updatedAt: this.now(), translations };
      // Completion means the complete validated translation is durable.
      await this.persist(entry, complete);
      if (!entry.controller.signal.aborted) entry.record = complete;
    } catch (error) {
      if (entry.controller.signal.aborted) return;
      entry.record = { ...entry.record, state: 'failed', updatedAt: this.now(), error: error.message || '翻译失败，请重试。' };
      try { await this.persist(entry, entry.record); } catch { /* Preserve visible failure when storage is unavailable. */ }
    } finally {
      entry.settings = null;
    }
  }

  async status(id) {
    await this.ready;
    const entry = this.entry(id);
    return publicTask(entry, true);
  }

  entry(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !this.entries.has(id)) throw new Error('字幕任务不存在，请重新获取字幕。');
    return this.entries.get(id);
  }

  async lookup({ videoId, track }) {
    await this.ready;
    const wantedTrack = trackIdentity(normalizeTrack(track));
    const settings = validateSettings(await this.loadSettings());
    const configFingerprint = await this.configIdentity(settings);
    const eligible = [...this.entries.values()].filter(entry => entry.record.videoId === videoId
      && entry.record.configFingerprint === configFingerprint
      && JSON.stringify(trackIdentity(entry.record.track)) === JSON.stringify(wantedTrack)
      && (ACTIVE_STATES.has(entry.record.state) || entry.record.state === 'complete'));
    eligible.sort((a, b) => Number(ACTIVE_STATES.has(b.record.state)) - Number(ACTIVE_STATES.has(a.record.state)) || b.record.updatedAt - a.record.updatedAt);
    if (!eligible.length) return null;
    if (eligible[0].record.state === 'complete') eligible[0].cached = true;
    return publicTask(eligible[0], true);
  }

  async list() {
    await this.ready;
    return [...this.entries.values()].sort((a, b) => b.record.updatedAt - a.record.updatedAt).map(entry => publicTask(entry));
  }

  async cancel(id) {
    await this.ready;
    const entry = this.entry(id);
    if (ACTIVE_STATES.has(entry.record.state)) {
      entry.controller.abort();
      entry.settings = null;
      entry.record = { ...entry.record, state: 'cancelled', updatedAt: this.now() };
      await this.persist(entry, entry.record);
    }
    return publicTask(entry);
  }

  async clear() {
    await this.ready;
    await Promise.allSettled([...this.starting.values()]);
    const complete = [...this.entries.values()].filter(entry => entry.record.state === 'complete');
    try { await this.storage.remove(complete.map(entry => `${STORAGE_PREFIX}${entry.record.id}`)); }
    catch { throw new Error('无法清除已保存的译文，请检查扩展存储后重试。'); }
    for (const entry of complete) if (this.entries.get(entry.record.id) === entry) this.entries.delete(entry.record.id);
    return { cleared: complete.length };
  }

  async export(id, mode) {
    await this.ready;
    if (!['original', 'translated', 'bilingual'].includes(mode)) throw new Error('字幕导出模式不正确。');
    const { record } = this.entry(id);
    if (mode !== 'original' && record.state !== 'complete') throw new Error('请等待完整翻译并保存后再导出译文或双语字幕。');
    return {
      filename: srtFilename(record.title, record.videoId, record.track.language, record.targetLanguage, mode),
      content: exportSrt(record.cues, record.translations ?? [], mode),
    };
  }
}

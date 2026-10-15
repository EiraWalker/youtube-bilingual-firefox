import { completionEndpoint, validateSettings } from '../shared/settings.js';
import { exportSrt, srtFilename } from '../shared/srt.js';
import { bufferedSeconds, planSegment, PREFETCH_SECONDS, REFILL_SECONDS, WATCH_LEASE_MS } from '../shared/buffered.js';
import { parseTranslations, translateCues, validateBatch } from './translator.js';

const STORAGE_PREFIX = 'track:v1:';
const RETRYABLE = new Set(['network', 'timeout', 'rate-limit', 'server', 'validation']);
const trackIdentity = track => [track.language.toLowerCase(), track.automatic === true];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function normalizedRequest(input) {
  if (!input || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.videoId)) throw new Error('视频编号不正确。');
  if (!input.track || typeof input.track.language !== 'string' || !input.track.language.trim() || input.track.language.length > 60) throw new Error('源字幕轨道不正确。');
  const track = { id: String(input.track.id ?? '').slice(0, 160), language: input.track.language.trim(), automatic: input.track.automatic === true };
  validateBatch(input.cues);
  const cues = input.cues.map(({ id, start, end, text }) => {
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) throw new Error('字幕时间轴不正确。');
    return { id, start, end, text };
  });
  if (cues.some((cue, index) => index && cue.start < cues[index - 1].start)) throw new Error('字幕时间轴顺序不正确。');
  return { videoId: input.videoId, title: String(input.title || input.videoId).slice(0, 500), track, cues };
}
function partialRows(rows, cues) {
  if (!Array.isArray(rows)) throw new Error('缓存格式不正确。');
  const ids = new Set(rows.map(row => row?.id));
  return parseTranslations(JSON.stringify({ translations: rows }), cues.filter(cue => ids.has(cue.id)));
}
function publicTask(entry, includeResult = false) {
  const r = entry.record, segments = [...entry.segments.values()];
  return { id: r.id, state: r.state, videoId: r.videoId, title: r.title, track: { ...r.track },
    model: r.model, targetLanguage: r.targetLanguage, createdAt: r.createdAt, updatedAt: r.updatedAt,
    total: r.cues.length, translatedCount: r.translations.length, revision: r.revision,
    cached: entry.cachedCount > 0, cachedCount: entry.cachedCount, cachePath: entry.cachePath,
    legacy: entry.legacy, inFlightCount: segments.filter(s => s.state === 'inflight').length,
    retryingCount: segments.filter(s => s.state === 'retrying').length,
    canResume: ['paused', 'cancelled', 'failed'].includes(r.state),
    bufferedSeconds: bufferedSeconds(r.cues, new Set(r.translations.map(row => row.id)), entry.position, entry.rate),
    metrics: { ...entry.metrics },
    ...(includeResult ? { cues: structuredClone(r.cues), translations: structuredClone(r.translations) } : {}) };
}

/** Owns viewing leases, bounded requests and temporary translations. Disk writes are explicit snapshots only. */
export class TrackTaskService {
  constructor({ storage, loadSettings, hasPermission, cache = null, fetchImpl = fetch, timeoutMs = 600_000,
    now = Date.now, concurrency = 3, retryDelaysMs = [2000, 8000], jitter = () => Math.random() * 500,
    logger = event => console.warn('[YouTube bilingual]', event) }) {
    Object.assign(this, { storage, loadSettings, hasPermission, cache, fetchImpl, timeoutMs, now, concurrency, retryDelaysMs, jitter, logger });
    this.entries = new Map(); this.starting = new Map(); this.pools = new Map(); this.pages = new Map();
    this.ready = this.restore(); this.ready.catch(() => {});
  }
  makeEntry(record) {
    return { record, settings: null, running: false, legacy: false, cachedCount: 0, cachePath: '',
      controller: new AbortController(), segments: new Map(), demands: new Map(), nextSegment: 0,
      position: 0, rate: 1, latency: 20, startup: 3,
      metrics: { startedAt: 0, firstSavedAt: null, firstUsableAt: null, requestCount: 0, maxConcurrency: 0 } };
  }
  async restore() {
    const saved = await this.storage.get(null);
    for (const [key, value] of Object.entries(saved)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      try {
        if (![1, 2].includes(value?.version) || key !== STORAGE_PREFIX + value.id || !/^[a-f0-9]{64}$/.test(value.id)
          || typeof value.configFingerprint !== 'string' || typeof value.model !== 'string' || typeof value.targetLanguage !== 'string') continue;
        const source = normalizedRequest(value), translations = partialRows(value.translations, source.cues);
        const entry = this.makeEntry({ version: 3, id: value.id, ...source, configFingerprint: value.configFingerprint,
          model: value.model, targetLanguage: value.targetLanguage, translations, revision: Number(value.revision) || 0,
          createdAt: Number(value.createdAt) || this.now(), updatedAt: Number(value.updatedAt) || this.now(),
          state: translations.length === source.cues.length ? 'complete' : 'paused' });
        entry.legacy = true; entry.cachedCount = translations.length; this.entries.set(value.id, entry);
      } catch { /* A corrupt legacy record cannot hide another video's cache. */ }
    }
  }
  configIdentity(settings) { return fingerprint([completionEndpoint(settings.apiBaseUrl), settings.model, settings.targetLanguage]); }

  // Observe state before asynchronous source/config/cache loading. A later pause
  // or page exit invalidates pending starts as well as already attached demands.
  observe(input, pageId) {
    if (pageId === null || typeof input?.session !== 'string' || input.session.length > 120
      || !Number.isSafeInteger(input.sequence) || input.sequence < 0) return null;
    const prior = this.pages.get(pageId);
    if (prior?.retired.has(input.session) || (prior?.session === input.session && input.sequence < prior.sequence)) return null;
    if (prior?.session === input.session && input.sequence === prior.sequence) return prior;
    const retired = prior?.retired || new Set();
    if (prior && prior.session !== input.session) retired.add(prior.session);
    const state = { ...input, pageId, retired, seenAt: this.now(),
      filling: prior?.session === input.session && prior.view === input.view ? prior.filling : false };
    state.active = input.active === true && Number.isFinite(input.position) && input.position >= 0;
    state.rate = Number.isFinite(input.rate) && input.rate > 0 ? Math.min(input.rate, 16) : 1;
    for (const entry of this.entries.values()) entry.demands.delete(pageId);
    this.pages.set(pageId, state); return state;
  }
  attach(entry, state) {
    if (!state || state !== this.pages.get(state.pageId) || state.videoId !== entry.record.videoId) return;
    entry.demands.set(state.pageId, state); entry.position = state.position || 0; entry.rate = state.rate;
  }
  async start(input, pageId = null) {
    const source = normalizedRequest(input);
    const playback = { ...input.playback, videoId: source.videoId };
    this.observe(playback, pageId);
    await this.ready;
    const settings = { ...validateSettings(await this.loadSettings()) };
    const configFingerprint = await this.configIdentity(settings);
    const id = await fingerprint([source.videoId, trackIdentity(source.track), configFingerprint, source.cues]);
    if (!this.starting.has(id)) {
      const pending = this.prepare(id, source, settings, configFingerprint, input.force === true);
      this.starting.set(id, pending);
      pending.finally(() => { if (this.starting.get(id) === pending) this.starting.delete(id); }).catch(() => {});
    }
    const entry = await this.starting.get(id);
    const state = this.pages.get(pageId);
    if (state && state.session === playback.session && state.view === playback.view && state.videoId === source.videoId) this.attach(entry, state);
    this.pump(source.videoId); this.refreshState(entry); return publicTask(entry, true);
  }
  async prepare(id, source, settings, configFingerprint, force) {
    let entry = this.entries.get(id);
    const previousRevision = entry?.record.revision || 0;
    if (force && entry) { await this.cancel(id); this.entries.delete(id); entry = null; }
    if (!entry) {
      const time = this.now();
      entry = this.makeEntry({ version: 3, id, ...source, configFingerprint, model: settings.model,
        targetLanguage: settings.targetLanguage, translations: [], revision: force ? previousRevision + 1 : 0, createdAt: time, updatedAt: time, state: 'paused' });
      if (!force && this.cache) {
        try {
          const saved = await this.cache.read(id, settings.cacheFolder);
          if (saved && saved.id === id && saved.configFingerprint === configFingerprint
            && same(normalizedRequest(saved).cues, source.cues) && same(trackIdentity(saved.track), trackIdentity(source.track))
            && saved.videoId === source.videoId && saved.model === settings.model && saved.targetLanguage === settings.targetLanguage) {
            entry.record.translations = partialRows(saved.translations, source.cues);
            entry.record.revision = Math.max(0, Number(saved.revision) || 0);
            entry.cachedCount = entry.record.translations.length;
          }
        } catch { this.logger({ action: 'cache-read-failed', videoId: source.videoId }); }
      }
      this.entries.set(id, entry);
    }
    if (entry.record.translations.length !== source.cues.length && !await this.hasPermission(settings)) throw new Error('尚未授权访问翻译接口。');
    if (entry.controller.signal.aborted) entry.controller = new AbortController();
    for (const [key, segment] of entry.segments) {
      if (segment.state === 'failed') entry.segments.delete(key);
    }
    entry.settings = settings; entry.running = true; entry.metrics.startedAt ||= this.now();
    return entry;
  }
  async resume(id) {
    await this.ready;
    const entry = this.entry(id), settings = validateSettings(await this.loadSettings());
    if (await this.configIdentity(settings) !== entry.record.configFingerprint) throw new Error('翻译配置已改变，请从视频页面重新开启。');
    await this.prepare(id, normalizedRequest(entry.record), settings, entry.record.configFingerprint, false);
    this.pump(entry.record.videoId); this.refreshState(entry); return publicTask(entry, true);
  }
  async position(input, pageId = null) {
    const state = this.observe(input, pageId);
    await this.ready;
    const entry = input.id ? this.entries.get(input.id) : null;
    if (entry && entry.record.videoId === input.videoId) this.attach(entry, state);
    for (const candidate of this.entries.values()) { this.refreshState(candidate); this.pump(candidate.record.videoId); }
    return entry ? publicTask(entry) : null;
  }
  detach(pageId) {
    const state = this.pages.get(pageId);
    if (state) { state.active = false; state.seenAt = 0; }
    for (const entry of this.entries.values()) { entry.demands.delete(pageId); this.refreshState(entry); }
  }
  demands(entry) {
    return [...entry.demands.values()].filter(state => state.active && state === this.pages.get(state.pageId) && this.now() - state.seenAt < WATCH_LEASE_MS);
  }
  pool(videoId) {
    if (!this.pools.has(videoId)) this.pools.set(videoId, { active: 0, cursor: 0 });
    return this.pools.get(videoId);
  }
  chooseSegment(entry) {
    const demands = this.demands(entry);
    for (const [key, segment] of entry.segments) {
      if (segment.state !== 'inflight' && !demands.some(d => segment.cues.every(c => c.end > d.position && c.start < d.position + PREFETCH_SECONDS))) {
        clearTimeout(segment.timer); entry.segments.delete(key);
        // Restrict unsent work after a seek, retaining retry deadlines and
        // attempts for overlapping cues instead of bypassing provider backoff.
        const remaining = new Set(segment.ids);
        for (const demand of demands) {
          const cues = segment.cues.filter(c => remaining.has(c.id) && c.end > demand.position && c.start < demand.position + PREFETCH_SECONDS);
          if (!cues.length) continue;
          cues.forEach(c => remaining.delete(c.id));
          const child = { ...segment, id: `s${++entry.nextSegment}`, cues, ids: cues.map(c => c.id), timer: null };
          entry.segments.set(child.id, child);
          if (child.retryAt > this.now()) {
            child.timer = setTimeout(() => { this.pump(entry.record.videoId); this.refreshState(entry); }, child.retryAt - this.now());
            child.timer.unref?.();
          }
        }
      }
    }
    const saved = new Set(entry.record.translations.map(row => row.id));
    const occupied = new Set(saved);
    for (const segment of entry.segments.values()) if (segment.state === 'inflight') for (const id of segment.ids) occupied.add(id);
    for (const state of demands) {
      const buffer = bufferedSeconds(entry.record.cues, saved, state.position);
      if (buffer < REFILL_SECONDS || state.reason === 'seek') state.filling = true;
      if (buffer >= PREFETCH_SECONDS) state.filling = false;
      if (!state.filling) continue;
      const inside = cue => cue.end > state.position && cue.start < state.position + PREFETCH_SECONDS;
      for (const segment of entry.segments.values()) {
        if (['queued', 'retrying'].includes(segment.state) && segment.cues.every(inside)) {
          if (segment.retryAt > this.now()) continue;
          entry.position = state.position; entry.rate = state.rate; return segment;
        }
      }
      // Queued/retrying/failed IDs stay reserved until explicitly resumed. This
      // prevents backoff being bypassed by planning a second copy of a cue.
      const unavailable = new Set(occupied);
      for (const segment of entry.segments.values()) for (const id of segment.ids) unavailable.add(id);
      const cues = planSegment(entry.record.cues, unavailable, state.position, {
        windowEnd: state.position + PREFETCH_SECONDS,
        maxSeconds: entry.startup === 3 ? 30 : 60,
        maxChars: entry.startup === 3 ? 600 : Math.min(6000, Math.max(1200, entry.latency * state.rate * 60)),
      });
      if (!cues.length) continue;
      entry.position = state.position; entry.rate = state.rate;
      if (entry.startup > 0) entry.startup--;
      const segment = { id: `s${++entry.nextSegment}`, ids: cues.map(c => c.id), cues, state: 'queued', attempt: 0, retryAt: 0 };
      entry.segments.set(segment.id, segment); return segment;
    }
    return null;
  }
  pump(videoId) {
    const pool = this.pool(videoId);
    while (pool.active < this.concurrency) {
      const eligible = [...this.entries.values()].filter(e => e.record.videoId === videoId && e.running && !e.controller.signal.aborted && this.demands(e).length);
      let chosen;
      for (let step = 0; step < eligible.length; step++) {
        const index = (pool.cursor + step) % eligible.length, entry = eligible[index], segment = this.chooseSegment(entry);
        if (segment) { chosen = { entry, segment }; pool.cursor = (index + 1) % eligible.length; break; }
      }
      if (!chosen) break;
      pool.active++; chosen.segment.state = 'inflight';
      chosen.entry.metrics.maxConcurrency = Math.max(chosen.entry.metrics.maxConcurrency, pool.active);
      this.refreshState(chosen.entry); void this.runSegment(chosen.entry, chosen.segment, pool);
    }
  }
  refreshState(entry) {
    const segments = [...entry.segments.values()];
    if (entry.controller.signal.aborted) entry.record.state = 'cancelled';
    else if (entry.record.translations.length === entry.record.cues.length) entry.record.state = 'complete';
    else if (!entry.running) entry.record.state = 'failed';
    else if (!this.demands(entry).length) entry.record.state = 'paused';
    else if (segments.some(s => s.state === 'inflight')) entry.record.state = 'translating';
    else if (segments.some(s => s.state === 'retrying' && this.demands(entry).some(d => s.cues.every(c => c.end > d.position && c.start < d.position + PREFETCH_SECONDS)))) entry.record.state = 'retrying';
    else if (segments.some(s => s.state === 'failed' && this.demands(entry).some(d => s.cues.some(c => c.end > d.position && c.start < d.position + PREFETCH_SECONDS)))) entry.record.state = 'failed';
    else entry.record.state = 'buffered';
  }
  async runSegment(entry, segment, pool) {
    segment.attempt++; entry.metrics.requestCount++;
    const start = this.now(), controller = entry.controller;
    try {
      const rows = await translateCues(entry.settings, segment.cues, { fetchImpl: this.fetchImpl, signal: controller.signal, timeoutMs: this.timeoutMs });
      if (controller.signal.aborted || controller !== entry.controller) return;
      const merged = new Map(entry.record.translations.map(row => [row.id, row]));
      for (const row of rows) merged.set(row.id, row);
      entry.record.translations = entry.record.cues.filter(c => merged.has(c.id)).map(c => merged.get(c.id));
      entry.record.revision++; entry.record.updatedAt = this.now();
      entry.latency = .75 * entry.latency + .25 * (this.now() - start) / 1000;
      entry.metrics.firstSavedAt ??= this.now();
      const active = entry.record.cues.find(c => c.end > entry.position);
      if (active && merged.has(active.id)) entry.metrics.firstUsableAt ??= this.now();
      entry.segments.delete(segment.id);
    } catch (error) {
      if (controller.signal.aborted || controller !== entry.controller) return;
      const category = error.category || 'validation';
      if (category === 'length' && segment.cues.length > 1) {
        entry.segments.delete(segment.id);
        const mid = Math.ceil(segment.cues.length / 2);
        for (const cues of [segment.cues.slice(0, mid), segment.cues.slice(mid)]) {
          const child = { id: `s${++entry.nextSegment}`, ids: cues.map(c => c.id), cues, state: 'queued', attempt: 0, retryAt: 0 };
          entry.segments.set(child.id, child);
        }
      } else if (RETRYABLE.has(category) && segment.attempt <= this.retryDelaysMs.length) {
        const delay = Math.max(this.retryDelaysMs[segment.attempt - 1] + this.jitter(), error.retryAfterMs || 0);
        segment.state = 'retrying'; segment.retryAt = this.now() + delay;
        segment.timer = setTimeout(() => { this.pump(entry.record.videoId); this.refreshState(entry); }, delay);
        segment.timer.unref?.();
      } else { segment.state = 'failed'; if (category === 'config') entry.running = false; }
      this.logger({ videoId: entry.record.videoId, segment: segment.id, category, status: error.status, action: segment.state });
    } finally {
      pool.active--;
      if (controller.signal.aborted || controller !== entry.controller) entry.segments.delete(segment.id);
      this.pump(entry.record.videoId); this.refreshState(entry);
    }
  }
  entry(id) {
    if (!this.entries.has(id)) throw new Error('字幕任务不存在，请重新获取字幕。');
    return this.entries.get(id);
  }
  async status(id) { await this.ready; const entry = this.entry(id); this.refreshState(entry); return publicTask(entry, true); }
  async lookup({ videoId, track }) {
    await this.ready;
    const config = await this.configIdentity(validateSettings(await this.loadSettings()));
    const entries = [...this.entries.values()].filter(e => e.record.videoId === videoId && e.record.configFingerprint === config && same(trackIdentity(e.record.track), trackIdentity(track)));
    entries.sort((a, b) => b.record.updatedAt - a.record.updatedAt);
    return entries.length ? publicTask(entries[0], true) : null;
  }
  async list() { await this.ready; return [...this.entries.values()].map(e => { this.refreshState(e); return publicTask(e); }); }
  async cancel(id) {
    await this.ready; const entry = this.entry(id);
    entry.running = false; entry.controller.abort();
    for (const segment of entry.segments.values()) clearTimeout(segment.timer);
    entry.demands.clear(); this.refreshState(entry); return publicTask(entry, true);
  }
  async clear() {
    await this.ready;
    const legacy = [...this.entries.values()].filter(e => e.legacy && e.record.state === 'complete');
    await this.storage.remove(legacy.map(e => STORAGE_PREFIX + e.record.id));
    for (const entry of legacy) { entry.legacy = false; entry.cachedCount = 0; }
    return { cleared: legacy.length };
  }
  async snapshot(id) {
    await this.ready;
    if (!this.cache) throw new Error('缓存组件未连接。');
    const entry = this.entry(id), snapshot = structuredClone(entry.record);
    const settings = await this.loadSettings();
    const result = await this.cache.save(snapshot, settings.cacheFolder);
    entry.cachedCount = result.translatedCount; entry.cachePath = result.path;
    return { ...result, snapshotRevision: snapshot.revision };
  }
  async export(id, mode) {
    await this.ready;
    const { record } = this.entry(id);
    return { filename: srtFilename(record.title, record.videoId, record.track.language, record.targetLanguage, mode),
      content: exportSrt(record.cues, record.translations, mode) };
  }
}

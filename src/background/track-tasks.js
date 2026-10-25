import { completionEndpoint, enabledModels, validateSettings } from '../shared/settings.js';
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
function updateSegment(segment) {
  const requests = [...segment.requests.values()];
  segment.state = ['inflight', 'queued', 'retrying', 'failed'].find(state => requests.some(request => request.state === state)) || 'complete';
  const pending = requests.filter(request => ['queued', 'retrying'].includes(request.state));
  segment.retryAt = pending.length ? Math.min(...pending.map(request => request.retryAt)) : 0;
}
function publicTask(entry, includeResult = false) {
  const r = entry.record, segments = [...entry.segments.values()];
  const requests = segments.flatMap(segment => [...segment.requests.values()].map(request => ({ segment, request })));
  const active = requests.filter(({ request }) => request.state === 'inflight');
  return { id: r.id, state: r.state, videoId: r.videoId, title: r.title, track: { ...r.track },
    model: r.model, targetLanguage: r.targetLanguage, createdAt: r.createdAt, updatedAt: r.updatedAt,
    total: r.cues.length, translatedCount: r.translations.length, revision: r.revision,
    cached: entry.cachedCount > 0, cachedCount: entry.cachedCount, cachePath: entry.cachePath,
    legacy: entry.legacy, inFlightCount: active.length,
    inFlightSegmentCount: segments.filter(s => s.state === 'inflight').length,
    activeRequests: active.map(({ segment, request }) => ({
      ids: [...(request.currentIds || segment.ids)], startedAt: request.startedAt, attempt: request.attempt,
      ...(entry.models?.length > 1 ? { modelId: request.config.id } : {}),
    })),
    retryingCount: requests.filter(({ request }) => request.state === 'retrying').length,
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
    return { record, settings: null, models: [], priorities: new Map(), running: false, legacy: false, cachedCount: 0, cachePath: '',
      controller: new AbortController(), segments: new Map(), demands: new Map(), nextSegment: 0, requestHistory: new Map(),
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
  configIdentity(settings) {
    const models = enabledModels(settings);
    if (models.length === 1) return fingerprint([completionEndpoint(models[0].apiBaseUrl), models[0].model, settings.targetLanguage]);
    return fingerprint([models.map(model => [model.id, completionEndpoint(model.apiBaseUrl), model.model, model.priority])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))), settings.targetLanguage]);
  }

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
  async prepare(id, source, settings, configFingerprint, force, resetFailures = false) {
    let entry = this.entries.get(id);
    const models = structuredClone(enabledModels(settings));
    const previousRevision = entry?.record.revision || 0;
    if (force && entry) { await this.cancel(id); this.entries.delete(id); entry = null; }
    if (!entry) {
      const time = this.now();
      entry = this.makeEntry({ version: 3, id, ...source, configFingerprint, model: settings.model,
        targetLanguage: settings.targetLanguage, translations: [], revision: force ? previousRevision + 1 : 0, createdAt: time, updatedAt: time, state: 'paused' });
      entry.record.model = models.length === 1 ? models[0].model : `多模型（${models.length}）`;
      if (!force && this.cache) {
        try {
          const saved = await this.cache.read(id, settings.cacheFolder);
          if (saved && saved.id === id && saved.configFingerprint === configFingerprint
            && same(normalizedRequest(saved).cues, source.cues) && same(trackIdentity(saved.track), trackIdentity(source.track))
            && saved.videoId === source.videoId && saved.model === entry.record.model && saved.targetLanguage === settings.targetLanguage) {
            entry.record.translations = partialRows(saved.translations, source.cues);
            entry.record.revision = Math.max(0, Number(saved.revision) || 0);
            entry.cachedCount = entry.record.translations.length;
          }
        } catch { this.logger({ action: 'cache-read-failed', videoId: source.videoId }); }
      }
      this.entries.set(id, entry);
    }
    const needsTranslation = entry.record.translations.length !== source.cues.length
      || [...entry.requestHistory.values()].some(history => !history.complete);
    if (needsTranslation
      && !(await Promise.all(models.map(model => this.hasPermission(model)))).every(Boolean)) throw new Error('尚未授权访问翻译接口。');
    if (resetFailures) for (const history of entry.requestHistory.values()) {
      if (!history.complete) { history.failures = 0; history.retryAt = 0; }
    }
    if (entry.controller.signal.aborted) entry.controller = new AbortController();
    for (const segment of entry.segments.values()) {
      for (const request of segment.requests.values()) {
        if (request.state === 'inflight') continue;
        request.config = models.find(model => model.id === request.config.id) || request.config;
        this.refreshRequest(entry, segment, request);
      }
      updateSegment(segment);
    }
    entry.settings = settings; entry.models = models; entry.running = true; entry.metrics.startedAt ||= this.now();
    return entry;
  }
  async resume(id) {
    await this.ready;
    const entry = this.entry(id), settings = validateSettings(await this.loadSettings());
    if (await this.configIdentity(settings) !== entry.record.configFingerprint) throw new Error('翻译配置已改变，请从视频页面重新开启。');
    await this.prepare(id, normalizedRequest(entry.record), settings, entry.record.configFingerprint, false, true);
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
  makeSegment(entry, cues, models = entry.models) {
    const segment = { id: `s${++entry.nextSegment}`, ids: cues.map(cue => cue.id), cues, state: 'queued', retryAt: 0, active: false,
      requests: new Map(models.map(config => [config.id, { config, state: 'queued', attempt: 0, retryAt: 0 }])) };
    for (const request of segment.requests.values()) this.refreshRequest(entry, segment, request);
    updateSegment(segment);
    return segment;
  }
  // Segments may be discarded or resliced. These fields are projections of
  // durable cue eligibility, never the owner of retry/completion policy.
  refreshRequest(entry, segment, request) {
    const remaining = segment.cues.filter(cue => !this.cueHistory(entry, request.config.id, cue.id).complete);
    const next = request.config.model.startsWith('qwen-mt-') ? remaining.slice(0, 1) : remaining;
    request.retryAt = Math.max(0, ...next.map(cue => this.cueHistory(entry, request.config.id, cue.id).retryAt));
    request.state = !remaining.length ? 'complete' : !Number.isFinite(request.retryAt) ? 'failed'
      : request.retryAt > this.now() ? 'retrying' : 'queued';
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
          const child = this.makeSegment(entry, cues, [...segment.requests.values()].map(request => request.config));
          entry.segments.set(child.id, child);
          this.scheduleRetry(entry, child);
        }
      }
    }
    const saved = new Set(entry.record.translations.map(row => row.id));
    const pending = new Set([...entry.requestHistory].filter(([, history]) => !history.complete).map(([key]) => JSON.parse(key)[1]));
    const occupied = new Set([...saved].filter(id => !pending.has(id)));
    for (const segment of entry.segments.values()) if (segment.state === 'inflight') for (const id of segment.ids) occupied.add(id);
    for (const state of demands) {
      const inside = cue => cue.end > state.position && cue.start < state.position + PREFETCH_SECONDS;
      // Already planned retries/upgrades retain their own deadlines even if a
      // faster model has filled the usable buffer in the meantime.
      for (const segment of entry.segments.values()) {
        if (['queued', 'retrying'].includes(segment.state) && segment.cues.every(inside) && segment.retryAt <= this.now()) {
          entry.position = state.position; entry.rate = state.rate; return segment;
        }
      }
      const buffer = bufferedSeconds(entry.record.cues, saved, state.position);
      if (buffer < REFILL_SECONDS || state.reason === 'seek') state.filling = true;
      if (buffer >= PREFETCH_SECONDS) state.filling = false;
      if (!state.filling && !pending.size) continue;

      // Reservations bound planning; durable cue history owns retry eligibility.
      for (;;) {
        const unavailable = new Set(occupied);
        if (!state.filling) for (const cue of entry.record.cues) if (!pending.has(cue.id)) unavailable.add(cue.id);
        for (const segment of entry.segments.values()) for (const id of segment.ids) unavailable.add(id);
        const cues = planSegment(entry.record.cues, unavailable, state.position, {
          windowEnd: state.position + PREFETCH_SECONDS,
          maxSeconds: entry.startup === 3 ? 30 : 60,
          maxChars: entry.startup === 3 ? 600 : Math.min(6000, Math.max(1200, entry.latency * state.rate * 60)),
        });
        if (!cues.length) break;
        entry.position = state.position; entry.rate = state.rate;
        if (entry.startup > 0) entry.startup--;
        const segment = this.makeSegment(entry, cues);
        entry.segments.set(segment.id, segment);
        this.scheduleRetry(entry, segment);
        if (['queued', 'retrying'].includes(segment.state) && segment.retryAt <= this.now()) return segment;
      }
    }
    return null;
  }
  scheduleRetry(entry, segment) {
    clearTimeout(segment.timer);
    const retrying = [...segment.requests.values()].filter(request => request.state === 'retrying');
    if (!retrying.length) return;
    const deadline = Math.min(...retrying.map(request => request.retryAt));
    const delay = Math.max(0, deadline - this.now());
    segment.timer = setTimeout(() => {
      this.pump(entry.record.videoId); this.refreshState(entry);
      // Timers can precede the wall-clock deadline; retain a wake-up in that
      // case, but never spin after an elapsed deadline while viewing is paused.
      if (this.now() < deadline && entry.segments.get(segment.id) === segment) this.scheduleRetry(entry, segment);
    }, delay);
    segment.timer.unref?.();
  }
  pump(videoId) {
    const pool = this.pool(videoId);
    // A retry in an already active segment uses the same segment slot; it must
    // not wait for a different model's slow request to finish.
    for (const entry of this.entries.values()) {
      if (entry.record.videoId !== videoId || !entry.running || entry.controller.signal.aborted) continue;
      for (const segment of entry.segments.values()) {
        if (segment.active && this.demands(entry).some(d => segment.cues.every(c => c.end > d.position && c.start < d.position + PREFETCH_SECONDS))) {
          this.runSegment(entry, segment, pool);
        }
      }
    }
    while (pool.active < this.concurrency) {
      const eligible = [...this.entries.values()].filter(e => e.record.videoId === videoId && e.running && !e.controller.signal.aborted && this.demands(e).length);
      let chosen;
      for (let step = 0; step < eligible.length; step++) {
        const index = (pool.cursor + step) % eligible.length, entry = eligible[index], segment = this.chooseSegment(entry);
        if (segment) { chosen = { entry, segment }; pool.cursor = (index + 1) % eligible.length; break; }
      }
      if (!chosen) break;
      pool.active++; chosen.segment.active = true;
      chosen.entry.metrics.maxConcurrency = Math.max(chosen.entry.metrics.maxConcurrency, pool.active);
      this.runSegment(chosen.entry, chosen.segment, pool); this.refreshState(chosen.entry);
    }
  }
  refreshState(entry) {
    const segments = [...entry.segments.values()];
    if (entry.controller.signal.aborted) entry.record.state = 'cancelled';
    else if (entry.record.translations.length === entry.record.cues.length
      && !segments.some(s => ['queued', 'retrying', 'inflight'].includes(s.state))) entry.record.state = 'complete';
    else if (!entry.running) entry.record.state = 'failed';
    else if (!this.demands(entry).length) entry.record.state = 'paused';
    else if (segments.some(s => s.state === 'inflight')) entry.record.state = 'translating';
    else if (segments.some(s => s.state === 'retrying' && this.demands(entry).some(d => s.cues.every(c => c.end > d.position && c.start < d.position + PREFETCH_SECONDS)))) entry.record.state = 'retrying';
    else if (segments.some(s => s.state === 'failed' && this.demands(entry).some(d => s.cues.some(c => c.end > d.position && c.start < d.position + PREFETCH_SECONDS)))) entry.record.state = 'failed';
    else entry.record.state = 'buffered';
  }
  runSegment(entry, segment, pool) {
    for (const request of segment.requests.values()) {
      if (request.state === 'inflight') continue;
      this.refreshRequest(entry, segment, request);
      if (!['queued', 'retrying'].includes(request.state) || request.retryAt > this.now()) continue;
      request.config = entry.models.find(model => model.id === request.config.id) || request.config;
      request.state = 'inflight'; request.startedAt = this.now();
      updateSegment(segment); void this.runRequest(entry, segment, request, pool);
    }
  }
  // Keep dispatch history per model/cue across regrouping. A deliberate resume
  // restores only the failure budget, never the displayed dispatch count.
  cueHistory(entry, modelId, cueId) {
    const key = JSON.stringify([modelId, cueId]);
    if (!entry.requestHistory.has(key)) entry.requestHistory.set(key, { attempt: 0, failures: 0, retryAt: 0, complete: false });
    return entry.requestHistory.get(key);
  }
  cueHistories(entry, request) {
    return request.currentIds.map(id => this.cueHistory(entry, request.config.id, id));
  }
  acceptRows(entry, request, rows) {
    const merged = new Map(entry.record.translations.map(row => [row.id, row]));
    let changed = false;
    for (const row of rows) {
      this.cueHistory(entry, request.config.id, row.id).complete = true;
      if (merged.has(row.id) && request.config.priority >= (entry.priorities.get(row.id) ?? Infinity)) continue;
      merged.set(row.id, row); entry.priorities.set(row.id, request.config.priority); changed = true;
    }
    if (changed) {
      entry.record.translations = entry.record.cues.filter(c => merged.has(c.id)).map(c => merged.get(c.id));
      entry.record.revision++; entry.record.updatedAt = this.now();
      entry.metrics.firstSavedAt ??= this.now();
      const active = entry.record.cues.find(c => c.end > entry.position);
      if (active && merged.has(active.id)) entry.metrics.firstUsableAt ??= this.now();
    }
  }
  async runRequest(entry, segment, request, pool) {
    const start = request.startedAt, controller = entry.controller;
    try {
      const current = () => !controller.signal.aborted && controller === entry.controller;
      const source = segment.cues.filter(cue => !this.cueHistory(entry, request.config.id, cue.id).complete);
      if (!source.length) { request.state = 'complete'; return; }
      const rows = await translateCues(request.config, source, { fetchImpl: this.fetchImpl, signal: controller.signal, timeoutMs: this.timeoutMs,
        getSettings: () => entry.models.find(model => model.id === request.config.id) || request.config,
        canRequest: cues => current() && entry.running
          && cues.every(cue => { const history = this.cueHistory(entry, request.config.id, cue.id); return !history.complete && history.retryAt <= this.now(); })
          && this.demands(entry).some(d => cues.every(c => c.end > d.position && c.start < d.position + PREFETCH_SECONDS)),
        onRequest: cues => {
          request.currentIds = cues.map(cue => cue.id); request.startedAt = this.now();
          request.attempt = Math.max(...this.cueHistories(entry, request).map(history => ++history.attempt));
          entry.metrics.requestCount++;
        },
        onPartial: rows => { if (current()) this.acceptRows(entry, request, rows); },
      });
      if (controller.signal.aborted || controller !== entry.controller) return;
      this.acceptRows(entry, request, rows);
      entry.latency = .75 * entry.latency + .25 * (this.now() - start) / 1000;
      request.state = 'complete';
    } catch (error) {
      if (controller.signal.aborted || controller !== entry.controller) return;
      const category = error.category || 'validation';
      if (category === 'suspend') {
        this.refreshRequest(entry, segment, request);
      } else if (category === 'length' && request.currentIds?.length > 1) {
        request.state = 'complete';
        // Children own the remaining work; the parent must not redispatch it
        // when a sibling completes or deliberate resume refreshes projections.
        segment.requests.delete(request.config.id);
        const remaining = segment.cues.filter(cue => !this.cueHistory(entry, request.config.id, cue.id).complete);
        const mid = Math.ceil(remaining.length / 2);
        for (const cues of [remaining.slice(0, mid), remaining.slice(mid)].filter(part => part.length)) {
          const child = this.makeSegment(entry, cues, [request.config]);
          entry.segments.set(child.id, child);
        }
      } else {
        for (const history of this.cueHistories(entry, request)) {
          if (RETRYABLE.has(category) && ++history.failures <= this.retryDelaysMs.length) {
            const delay = Math.max(this.retryDelaysMs[history.failures - 1] + this.jitter(), error.retryAfterMs || 0);
            history.retryAt = this.now() + delay;
          } else history.retryAt = Infinity; // Only a deliberate resume renews eligibility.
        }
        if (category === 'config' && entry.models.length === 1) entry.running = false;
        this.refreshRequest(entry, segment, request);
      }
      this.logger({ videoId: entry.record.videoId, segment: segment.id, category, status: error.status, action: request.state });
    } finally {
      if (request.state === 'inflight') request.state = 'failed';
      updateSegment(segment);
      if (segment.active && ![...segment.requests.values()].some(r => r.state === 'inflight')) { segment.active = false; pool.active--; }
      clearTimeout(segment.timer);
      if (controller.signal.aborted || controller !== entry.controller || segment.state === 'complete') entry.segments.delete(segment.id);
      else this.scheduleRetry(entry, segment);
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

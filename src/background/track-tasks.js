import { completionEndpoint, validateSettings } from '../shared/settings.js';
import { exportSrt, srtFilename } from '../shared/srt.js';
import { bufferedSeconds, planSegment } from '../shared/buffered.js';
import { parseTranslations, translateCues, validateBatch } from './translator.js';

const STORAGE_PREFIX = 'track:v1:';
const ACTIVE_STATES = new Set(['queued', 'translating', 'retrying']);
const TASK_STATES = new Set([...ACTIVE_STATES, 'complete', 'paused', 'failed', 'cancelled']);
const RETRYABLE = new Set(['network', 'timeout', 'rate-limit', 'server', 'validation']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function normalizeTrack(track) {
  if (!track || typeof track.language !== 'string' || !track.language.trim() || track.language.length > 60) throw new Error('源字幕轨道不正确。');
  return { id: String(track.id ?? '').slice(0, 160), language: track.language.trim(), automatic: track.automatic === true };
}
function trackIdentity(track) { return [track.language.toLowerCase(), track.automatic]; }
function normalizedRequest(input) {
  if (!input || typeof input.videoId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.videoId)) throw new Error('视频编号不正确。');
  const track = normalizeTrack(input.track);
  validateBatch(input.cues);
  const cues = input.cues.map(({ id, start, end, text }) => {
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) throw new Error('字幕时间轴不正确。');
    return { id, start, end, text };
  });
  if (cues.some((cue, index) => index && cue.start < cues[index - 1].start)) throw new Error('字幕时间轴顺序不正确。');
  return { videoId: input.videoId, title: String(input.title || input.videoId).slice(0, 500), track, cues };
}
function partialRows(rows, cues) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const ids = new Set(rows.map(row => row?.id));
  return parseTranslations(JSON.stringify({ translations: rows }), cues.filter(cue => ids.has(cue.id)));
}
function publicTask(entry, includeResult = false) {
  const r = entry.record, segments = [...entry.segments.values()];
  const result = {
    id: r.id, state: r.state, total: r.cues.length, translatedCount: r.translations.length,
    videoId: r.videoId, title: r.title, track: { ...r.track }, targetLanguage: r.targetLanguage,
    model: r.model, createdAt: r.createdAt, updatedAt: r.updatedAt, cached: entry.cached === true,
    revision: r.revision, inFlightCount: segments.filter(s => s.state === 'inflight').length,
    retryingCount: segments.filter(s => s.state === 'retrying').length,
    canResume: !ACTIVE_STATES.has(r.state) && r.state !== 'complete',
    bufferedSeconds: bufferedSeconds(r.cues, new Set(r.translations.map(row => row.id)), entry.position, entry.rate),
    metrics: { ...entry.metrics },
  };
  if (includeResult) {
    result.cues = r.cues.map(cue => ({ ...cue }));
    result.translations = r.translations.map(row => ({ ...row }));
  }
  return result;
}

/** Durable partial translations, with three actual requests per video. */
export class TrackTaskService {
  constructor({ storage, loadSettings, hasPermission, fetchImpl = fetch, timeoutMs = 600_000,
    now = Date.now, concurrency = 3, retryDelaysMs = [2000, 8000], jitter = () => Math.random() * 500,
    logger = event => console.warn('[YouTube bilingual]', event) }) {
    Object.assign(this, { storage, loadSettings, hasPermission, fetchImpl, timeoutMs, now, concurrency, retryDelaysMs, jitter, logger });
    this.entries = new Map(); this.starting = new Map(); this.pools = new Map();
    this.ready = this.restore(); this.ready.catch(() => {});
  }
  makeEntry(record) {
    return { record, settings: null, running: false, cached: false, controller: new AbortController(),
      persistence: Promise.resolve(), segments: new Map(), nextSegment: 0, position: 0, rate: 1,
      owner: null, startup: 3, latency: 20, pendingSaves: new Map(), storageBlocked: false,
      metrics: { startedAt: 0, firstSavedAt: null, firstUsableAt: null, requestCount: 0, maxConcurrency: 0 } };
  }
  async restore() {
    let saved;
    try { saved = await this.storage.get(null); }
    catch { throw new Error('无法读取已保存的字幕，请检查扩展存储后重试。'); }
    for (const [key, value] of Object.entries(saved)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      try {
        if (![1, 2].includes(value?.version) || key !== `${STORAGE_PREFIX}${value.id}` || !/^[a-f0-9]{64}$/.test(value.id)
          || !TASK_STATES.has(value.state) || typeof value.configFingerprint !== 'string'
          || typeof value.model !== 'string' || typeof value.targetLanguage !== 'string') continue;
        const source = normalizedRequest(value);
        const translations = value.state === 'complete'
          ? parseTranslations(JSON.stringify({ translations: value.translations }), source.cues)
          : partialRows(value.translations, source.cues);
        const record = { version: 2, id: value.id, ...source, configFingerprint: value.configFingerprint,
          model: value.model, targetLanguage: value.targetLanguage, translations, segments: [],
          revision: Math.max(0, Number(value.revision) || 0), createdAt: Number(value.createdAt) || this.now(),
          updatedAt: Number(value.updatedAt) || this.now(), state: value.state === 'complete' ? 'complete' : 'paused' };
        const entry = this.makeEntry(record); entry.cached = record.state === 'complete';
        this.entries.set(record.id, entry);
      } catch { /* Corrupt records cannot hide other videos or initiate requests. */ }
    }
  }
  async configIdentity(settings) {
    return fingerprint([completionEndpoint(settings.apiBaseUrl), settings.model, settings.targetLanguage]);
  }
  async start(input, pageId = null) {
    await this.ready;
    const source = normalizedRequest(input);
    const settings = { ...validateSettings(await this.loadSettings()) };
    const configFingerprint = await this.configIdentity(settings);
    const id = await fingerprint([source.videoId, trackIdentity(source.track), configFingerprint, source.cues]);
    if (this.starting.has(id)) {
      await this.starting.get(id); this.updatePosition(this.entry(id), input.playback, pageId);
      return publicTask(this.entry(id), true);
    }
    const pending = this.startPrepared(id, source, settings, configFingerprint, input.force === true, input.playback, pageId);
    this.starting.set(id, pending);
    try { return await pending; }
    finally { if (this.starting.get(id) === pending) this.starting.delete(id); }
  }
  async startPrepared(id, source, settings, configFingerprint, force, playback, pageId) {
    const prior = this.entries.get(id);
    if (prior && ACTIVE_STATES.has(prior.record.state)) {
      this.updatePosition(prior, playback, pageId); this.pump(source.videoId); return publicTask(prior, true);
    }
    if (prior?.record.state === 'complete' && !force) {
      prior.cached = true; this.updatePosition(prior, playback, pageId); return publicTask(prior, true);
    }
    if (prior && !force && prior.record.translations.length === prior.record.cues.length) return this.activate(prior, null);
    if (!await this.hasPermission(settings)) throw new Error('尚未授权访问翻译接口，请打开设置页保存并授权。');
    if (prior && !force) { this.updatePosition(prior, playback, pageId); return this.activate(prior, settings); }
    if (prior) { await this.cancel(id); await prior.persistence; }
    const time = this.now();
    const entry = this.makeEntry({ version: 2, id, ...source, configFingerprint, model: settings.model,
      targetLanguage: settings.targetLanguage, createdAt: time, updatedAt: time, state: 'queued',
      translations: [], segments: [], revision: 0 });
    await this.write(entry.record); // No charge before the source is durable.
    this.entries.set(id, entry); this.updatePosition(entry, playback, pageId);
    return this.activate(entry, settings);
  }
  async activate(entry, settings) {
    if (entry.running) return publicTask(entry, true);
    if (entry.record.translations.length === entry.record.cues.length) {
      // A cancel/save race can leave every row durable under a cancelled
      // status. Recovery finalizes that status without another API call.
      await this.enqueue(entry, async () => {
        const next = { ...entry.record, state: 'complete', revision: entry.record.revision + 1, updatedAt: this.now() };
        await this.write(next); entry.record = next; entry.cached = true;
      });
      return publicTask(entry, true);
    }
    if (entry.controller.signal.aborted) {
      entry.controller = new AbortController();
      for (const [key, segment] of entry.segments) if (segment.state === 'inflight') entry.segments.delete(key);
    }
    entry.settings = { ...settings }; entry.cached = false; entry.storageBlocked = false;
    for (const [key, segment] of entry.segments) {
      if (['failed', 'retrying', 'queued'].includes(segment.state)) { clearTimeout(segment.timer); entry.segments.delete(key); }
    }
    entry.running = true; entry.startup = 3; entry.metrics.startedAt ||= this.now();
    entry.record = { ...entry.record, state: 'queued', updatedAt: this.now() };
    for (const [key, rows] of entry.pendingSaves) {
      await this.commitRows(entry, entry.segments.get(key), rows);
      if (entry.storageBlocked) return publicTask(entry, true);
    }
    this.pump(entry.record.videoId); return publicTask(entry, true);
  }
  async resume(id) {
    await this.ready;
    const entry = this.entry(id);
    if (entry.record.state === 'complete') return publicTask(entry, true);
    if (entry.record.translations.length === entry.record.cues.length) return this.activate(entry, null);
    const settings = { ...validateSettings(await this.loadSettings()) };
    if (await this.configIdentity(settings) !== entry.record.configFingerprint) throw new Error('翻译配置已改变，请从视频页面开启新的字幕任务。');
    if (!await this.hasPermission(settings)) throw new Error('尚未授权访问翻译接口。');
    return this.activate(entry, settings);
  }
  updatePosition(entry, playback, pageId) {
    if (!playback || !Number.isFinite(playback.position) || playback.position < 0) return;
    const reason = playback.reason || 'activate';
    const explicit = ['seek', 'play', 'ratechange', 'activate'].includes(reason);
    if (!explicit && entry.owner !== null && entry.owner !== pageId) return;
    if (explicit) { entry.owner = pageId; this.pool(entry.record.videoId).preferred = entry.record.id; }
    entry.position = playback.position;
    entry.rate = Number.isFinite(playback.rate) && playback.rate > 0 ? Math.min(playback.rate, 16) : 1;
    if (reason === 'seek') entry.startup = 3;
  }
  async position(input, pageId = null) {
    await this.ready;
    const entry = this.entry(input.id);
    if (input.videoId !== entry.record.videoId) throw new Error('视频与字幕任务不匹配。');
    this.updatePosition(entry, input, pageId); this.pump(entry.record.videoId);
    return { id: entry.record.id, bufferedSeconds: publicTask(entry).bufferedSeconds };
  }
  detach(pageId) { for (const entry of this.entries.values()) if (entry.owner === pageId) entry.owner = null; }
  pool(videoId) {
    if (!this.pools.has(videoId)) this.pools.set(videoId, { active: 0, cursor: 0 });
    return this.pools.get(videoId);
  }
  chooseSegment(entry) {
    const ready = [...entry.segments.values()].filter(s => s.state === 'queued');
    const saved = new Set(entry.record.translations.map(row => row.id)), unavailable = new Set(saved);
    for (const segment of entry.segments.values()) for (const id of segment.ids) unavailable.add(id);
    const buffered = bufferedSeconds(entry.record.cues, saved, entry.position, entry.rate), ahead = Math.max(30, 2 * entry.latency);
    const small = entry.startup > 0 || buffered < ahead;
    // Live measurement: the initial 1200-character request took 28 seconds.
    // A smaller first request buys usable subtitles while two larger startup
    // requests and subsequent substantial segments keep filling the buffer.
    const bounds = entry.startup === 3 ? { maxSeconds: 30, maxChars: 600 }
      : small ? { maxSeconds: 60, maxChars: 1200 }
      : { maxSeconds: buffered > 2 * ahead ? 300 : 180, maxChars: 6000 };
    const cues = planSegment(entry.record.cues, unavailable, entry.position, bounds);
    const distance = list => {
      const upcoming = list.find(cue => cue.end > entry.position);
      return upcoming ? Math.max(0, upcoming.start - entry.position) : 1e9 + list[0].start;
    };
    ready.sort((a, b) => distance(a.cues) - distance(b.cues));
    if (ready.length && (!cues.length || distance(ready[0].cues) <= distance(cues))) return ready[0];
    if (!cues.length) return null;
    if (entry.startup > 0) entry.startup--;
    const segment = { id: `s${++entry.nextSegment}`, ids: cues.map(c => c.id), cues, state: 'queued', attempt: 0, retryAt: 0 };
    entry.segments.set(segment.id, segment); return segment;
  }
  pump(videoId) {
    const pool = this.pool(videoId);
    while (pool.active < this.concurrency) {
      const eligible = [...this.entries.values()].filter(e => e.record.videoId === videoId && e.running && !e.storageBlocked && !e.controller.signal.aborted);
      const preferred = eligible.findIndex(entry => entry.record.id === pool.preferred);
      if (preferred >= 0) pool.cursor = preferred;
      pool.preferred = null;
      let chosen = null;
      for (let step = 0; step < eligible.length; step++) {
        const index = (pool.cursor + step) % eligible.length, entry = eligible[index], segment = this.chooseSegment(entry);
        if (segment) { chosen = { entry, segment }; pool.cursor = (index + 1) % eligible.length; break; }
        this.refreshState(entry);
      }
      if (!chosen) break;
      pool.active++; chosen.segment.state = 'inflight';
      chosen.entry.metrics.maxConcurrency = Math.max(chosen.entry.metrics.maxConcurrency, pool.active);
      this.refreshState(chosen.entry); void this.runSegment(chosen.entry, chosen.segment, pool);
    }
  }
  refreshState(entry) {
    if (entry.controller.signal.aborted) { entry.record.state = 'cancelled'; return; }
    if (entry.record.translations.length === entry.record.cues.length) { entry.record.state = 'complete'; entry.running = false; return; }
    if (!entry.running) return;
    const segments = [...entry.segments.values()];
    if (segments.some(s => ['inflight', 'saving', 'queued'].includes(s.state))) entry.record.state = 'translating';
    else if (segments.some(s => s.state === 'retrying')) entry.record.state = 'retrying';
    else {
      const occupied = new Set([...entry.record.translations.map(r => r.id), ...segments.flatMap(s => s.ids)]);
      if (entry.record.cues.some(cue => !occupied.has(cue.id))) entry.record.state = 'queued';
      else { entry.record.state = 'failed'; entry.running = false; }
    }
  }
  diagnose(entry, segment, error, action, durationMs = 0) {
    this.logger({ videoId: entry.record.videoId, segment: segment?.id, range: segment ? [segment.cues[0].start, segment.cues.at(-1).end] : [],
      attempt: segment?.attempt || 0, category: error?.category || 'storage',
      status: Number.isInteger(error?.status) ? error.status : null, action, durationMs });
  }
  async runSegment(entry, segment, pool) {
    segment.attempt++; entry.metrics.requestCount++;
    const start = this.now(), controller = entry.controller, settings = entry.settings;
    let rows, failure;
    try { rows = await translateCues(settings, segment.cues, { fetchImpl: this.fetchImpl, signal: controller.signal, timeoutMs: this.timeoutMs }); }
    catch (error) { failure = error; }
    pool.active--; // Persistence and retry waits must not occupy network slots.
    const duration = Math.max(0, this.now() - start);
    if (controller.signal.aborted || controller !== entry.controller) { segment.state = 'failed'; this.pump(entry.record.videoId); return; }
    if (rows) {
      entry.latency = 0.75 * entry.latency + 0.25 * duration / 1000;
      segment.state = 'saving'; entry.pendingSaves.set(segment.id, rows);
      this.pump(entry.record.videoId); await this.commitRows(entry, segment, rows);
    } else {
      const category = failure?.category || 'validation';
      if (category === 'length' && segment.cues.length > 1) {
        entry.segments.delete(segment.id);
        const mid = Math.ceil(segment.cues.length / 2);
        for (const cues of [segment.cues.slice(0, mid), segment.cues.slice(mid)]) {
          const child = { id: `s${++entry.nextSegment}`, ids: cues.map(c => c.id), cues, state: 'queued', attempt: 0, retryAt: 0 };
          entry.segments.set(child.id, child);
        }
        this.diagnose(entry, segment, failure, 'split', duration);
      } else if (RETRYABLE.has(category) && segment.attempt <= this.retryDelaysMs.length && entry.running) {
        const delay = Math.max(this.retryDelaysMs[segment.attempt - 1] + this.jitter(), failure?.retryAfterMs || 0);
        segment.state = 'retrying'; segment.retryAt = this.now() + delay;
        this.diagnose(entry, segment, failure, 'retry', duration);
        segment.timer = setTimeout(() => {
          if (!entry.running || entry.controller.signal.aborted || segment.state !== 'retrying') return;
          segment.state = 'queued'; this.pump(entry.record.videoId);
        }, delay);
      } else {
        segment.state = 'failed'; segment.category = category;
        if (category === 'config') { entry.running = false; entry.record.state = 'paused'; }
        this.diagnose(entry, segment, failure, category === 'config' ? 'pause' : 'exhausted', duration);
      }
      this.refreshState(entry); await this.saveState(entry);
    }
    this.refreshState(entry); this.pump(entry.record.videoId);
  }
  async write(record) {
    try { await this.storage.set({ [`${STORAGE_PREFIX}${record.id}`]: structuredClone(record) }); }
    catch { throw new Error('无法保存字幕或译文，请检查扩展存储空间后重试。'); }
  }
  enqueue(entry, operation) {
    const pending = entry.persistence.catch(() => {}).then(operation); entry.persistence = pending; return pending;
  }
  snapshotSegments(entry) {
    return [...entry.segments.values()].map(({ id, ids, state, attempt, retryAt, category }) => ({ id, ids, state, attempt, retryAt, ...(category ? { category } : {}) }));
  }
  async commitRows(entry, segment, rows) {
    return this.enqueue(entry, async () => {
      const map = new Map(entry.record.translations.map(row => [row.id, row]));
      for (const row of rows) map.set(row.id, row);
      const translations = entry.record.cues.filter(c => map.has(c.id)).map(c => map.get(c.id));
      for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
        const state = entry.controller.signal.aborted ? 'cancelled' : translations.length === entry.record.cues.length ? 'complete'
          : !entry.running ? entry.record.state : 'translating';
        const next = { ...entry.record, translations, state, segments: this.snapshotSegments(entry), revision: entry.record.revision + 1, updatedAt: this.now() };
        try {
          await this.write(next);
          if (entry.controller.signal.aborted) next.state = 'cancelled';
          entry.record = next; segment.state = 'complete'; entry.pendingSaves.delete(segment.id);
          entry.metrics.firstSavedAt ??= this.now();
          const active = entry.record.cues.find(c => c.start <= entry.position && c.end > entry.position) || entry.record.cues.find(c => c.start >= entry.position);
          if (active && map.has(active.id)) entry.metrics.firstUsableAt ??= this.now();
          entry.storageBlocked = false; this.refreshState(entry); return;
        } catch {
          this.diagnose(entry, segment, { category: 'storage' }, attempt < this.retryDelaysMs.length ? 'retry-save' : 'pause');
          entry.storageBlocked = true;
          if (attempt < this.retryDelaysMs.length) await sleep(this.retryDelaysMs[attempt] + this.jitter());
          else { entry.running = false; entry.record.state = entry.controller.signal.aborted ? 'cancelled' : 'paused'; }
        }
      }
    });
  }
  async saveState(entry) {
    return this.enqueue(entry, async () => {
      const next = { ...entry.record, segments: this.snapshotSegments(entry), updatedAt: this.now() };
      try { await this.write(next); }
      catch { this.diagnose(entry, null, { category: 'storage' }, 'state-save-failed'); }
    });
  }
  async status(id) { await this.ready; return publicTask(this.entry(id), true); }
  entry(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !this.entries.has(id)) throw new Error('字幕任务不存在，请重新获取字幕。');
    return this.entries.get(id);
  }
  async lookup({ videoId, track }) {
    await this.ready;
    const wanted = trackIdentity(normalizeTrack(track)), configFingerprint = await this.configIdentity(validateSettings(await this.loadSettings()));
    const eligible = [...this.entries.values()].filter(e => e.record.videoId === videoId && e.record.configFingerprint === configFingerprint
      && JSON.stringify(trackIdentity(e.record.track)) === JSON.stringify(wanted));
    eligible.sort((a, b) => Number(ACTIVE_STATES.has(b.record.state)) - Number(ACTIVE_STATES.has(a.record.state)) || b.record.updatedAt - a.record.updatedAt);
    if (!eligible.length) return null;
    eligible[0].cached = eligible[0].record.translations.length > 0; return publicTask(eligible[0], true);
  }
  async list() { await this.ready; return [...this.entries.values()].sort((a, b) => b.record.updatedAt - a.record.updatedAt).map(e => publicTask(e)); }
  async cancel(id) {
    await this.ready;
    const entry = this.entry(id);
    if (entry.record.state === 'complete') return publicTask(entry);
    entry.running = false; entry.controller.abort();
    for (const segment of entry.segments.values()) clearTimeout(segment.timer);
    entry.record.state = 'cancelled'; await this.saveState(entry); return publicTask(entry);
  }
  async clear() {
    await this.ready; await Promise.allSettled([...this.starting.values()]);
    const complete = [...this.entries.values()].filter(e => e.record.state === 'complete');
    try { await this.storage.remove(complete.map(e => `${STORAGE_PREFIX}${e.record.id}`)); }
    catch { throw new Error('无法清除已保存的译文，请检查扩展存储后重试。'); }
    for (const entry of complete) if (this.entries.get(entry.record.id) === entry) this.entries.delete(entry.record.id);
    return { cleared: complete.length };
  }
  async export(id, mode) {
    await this.ready;
    if (!['original', 'translated', 'bilingual'].includes(mode)) throw new Error('字幕导出模式不正确。');
    const { record } = this.entry(id);
    if (mode !== 'original' && record.state !== 'complete') throw new Error('请等待完整翻译并保存后再导出译文或双语字幕。');
    return { filename: srtFilename(record.title, record.videoId, record.track.language, record.targetLanguage, mode), content: exportSrt(record.cues, record.translations, mode) };
  }
}

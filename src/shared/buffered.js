// Cue times and playback position are in source seconds. Caller-owned sets may
// contain both persisted IDs and immutable in-flight IDs; neither is selected.
export const PREFETCH_SECONDS = 120;
export const REFILL_SECONDS = 60;
export const WATCH_LEASE_MS = 10_000;

export function planSegment(cues, unavailableIds, position, { maxSeconds = 60, maxChars = 1200, windowEnd = position + PREFETCH_SECONDS } = {}) {
  if (!cues.length) return [];
  const unavailable = unavailableIds instanceof Set || unavailableIds instanceof Map ? unavailableIds : new Set(unavailableIds || []);
  const at = Number.isFinite(position) ? Math.max(0, position) : 0;
  const first = cues.findIndex(cue => cue.end > at && cue.start < windowEnd && !unavailable.has(cue.id));
  if (first < 0) return [];
  const seconds = Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : 60;
  const chars = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 1200;
  const selected = [];
  let count = 0;
  for (let index = first; index < cues.length; index++) {
    const cue = cues[index];
    if (unavailable.has(cue.id) || cue.start >= windowEnd) break;
    if (selected.length && (cue.end - cues[first].start > seconds || count + cue.text.length > chars)) break;
    selected.push(cue);
    count += cue.text.length;
  }
  return selected;
}

// Only a contiguous available range counts as buffer. Known subtitle-free gaps
// are available, but an untranslated cue is always a boundary, even when later
// segments have already returned out of order.
export function bufferedSeconds(cues, translatedIds, position, rate = 1) {
  const translated = translatedIds instanceof Set || translatedIds instanceof Map ? translatedIds : new Set(translatedIds || []);
  const at = Number.isFinite(position) ? Math.max(0, position) : 0;
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
  let end = at;
  for (const cue of cues) {
    if (cue.end <= at) continue;
    if (!translated.has(cue.id)) return Math.max(0, cue.start - at) / speed;
    end = Math.max(end, cue.end);
  }
  return Math.max(0, end - at) / speed;
}

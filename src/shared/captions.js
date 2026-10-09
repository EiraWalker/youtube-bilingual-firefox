export const cleanText = (text) => String(text || '').replace(/\u200b/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export function normalizeCues(items) {
  const sorted = items.filter((item) => Number.isFinite(item.start) && item.start >= 0 && cleanText(item.text))
    .sort((a, b) => a.start - b.start);
  const unique = [];
  for (const item of sorted) {
    const text = cleanText(item.text);
    const previous = unique.at(-1);
    if (previous && previous.start === item.start && previous.text === text) continue;
    unique.push({ start: item.start, end: item.end, text });
  }
  return unique.map((item, index) => {
    const nextStart = unique[index + 1]?.start;
    let end = Number.isFinite(item.end) && item.end > item.start ? item.end : (nextStart ?? item.start + 4);
    // YouTube rolling captions overlap. Show the newest cue, never an expired older one.
    if (nextStart !== undefined && nextStart > item.start) end = Math.min(end, nextStart);
    return { id: String(index), start: item.start, end, text: item.text };
  }).filter((cue) => cue.end > cue.start);
}

export function parseJson3(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!Array.isArray(data?.events)) throw new Error('字幕 JSON3 格式不正确。');
  const cues = [];
  for (const event of data.events) {
    const text = (event.segs || []).map((segment) => segment.utf8 || '').join('');
    if (!cleanText(text) || !Number.isFinite(event.tStartMs)) continue;
    const start = event.tStartMs / 1000;
    const end = start + (Number(event.dDurationMs) || 0) / 1000;
    if (event.aAppend && cues.length) {
      cues.at(-1).text += text;
      cues.at(-1).end = Math.max(cues.at(-1).end, end);
    } else cues.push({ start, end, text });
  }
  return normalizeCues(cues);
}

function vttTime(value) {
  const parts = value.replace(',', '.').split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function parseVtt(input) {
  const cues = [];
  for (const block of input.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0 || /^(NOTE|STYLE|REGION)/.test(lines[0])) continue;
    const times = lines[index].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (!times) continue;
    const text = lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
    cues.push({ start: vttTime(times[1]), end: vttTime(times[2]), text });
  }
  return normalizeCues(cues);
}

export function parseCaptionPayload(input, Parser = globalThis.DOMParser) {
  if (typeof input !== 'string' || input.length > 8_000_000) throw new Error('字幕响应为空或过大。');
  const body = input.trim();
  if (!body) return [];
  if (body.startsWith('{')) return parseJson3(body);
  if (body.startsWith('WEBVTT')) return parseVtt(body);
  if (!Parser) throw new Error('无法解析该字幕格式。');
  const document = new Parser().parseFromString(body, 'text/xml');
  if (document.querySelector('parsererror')) throw new Error('字幕 XML 格式不正确。');
  const paragraphs = [...document.querySelectorAll('p')];
  const cues = paragraphs.length ? paragraphs.map((node) => ({
    start: Number(node.getAttribute('t')) / 1000,
    end: (Number(node.getAttribute('t')) + Number(node.getAttribute('d'))) / 1000,
    text: node.textContent,
  })) : [...document.querySelectorAll('text')].map((node) => ({
    start: Number(node.getAttribute('start')),
    end: Number(node.getAttribute('start')) + Number(node.getAttribute('dur')),
    text: node.textContent,
  }));
  return normalizeCues(cues);
}

export function activeCue(cues, time) {
  let left = 0, right = cues.length - 1, index = -1;
  while (left <= right) {
    const middle = (left + right) >> 1;
    if (cues[middle].start <= time) { index = middle; left = middle + 1; }
    else right = middle - 1;
  }
  const cue = cues[index];
  return cue && time < cue.end ? cue : null;
}

export function chooseTrack(tracks, preferred = 'auto', currentId = '') {
  if (!tracks.length) return null;
  if (preferred === 'auto') return tracks.find((track) => track.id === currentId) || tracks[0];
    const matches = tracks.filter((track) => track.language === preferred || track.language.split('-')[0] === preferred.split('-')[0]);
    return matches.find((track) => !track.automatic) || matches[0] || tracks[0];
}

export function translationBatch(cues, time, translations, pending = new Set()) {
  const upcoming = cues.filter((cue) => cue.end > time - 1 && cue.start < time + 75);
  const candidates = upcoming.filter((cue) => !translations.has(cue.id) && !pending.has(cue.id));
  const result = [];
  let length = 0;
  for (const cue of candidates) {
    if (result.length >= 12 || length + cue.text.length > 10_000) break;
    result.push(cue);
    length += cue.text.length;
  }
  return result;
}

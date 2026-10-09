const MODES = new Set(['original', 'translated', 'bilingual']);

function requireMode(mode) {
  if (!MODES.has(mode)) throw new Error('字幕导出模式不正确。');
}

function subtitleText(value) {
  if (typeof value !== 'string') throw new Error('字幕文字不正确。');
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\r\n');
  if (!text) throw new Error('字幕文字为空，无法导出。');
  return text;
}

function timestamp(milliseconds) {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Export the complete source timeline; missing translations fail instead of silently producing a partial file. */
export function exportSrt(cues, translations = [], mode = 'bilingual') {
  requireMode(mode);
  if (!Array.isArray(cues) || !cues.length) throw new Error('没有可导出的完整字幕。');
  const translated = new Map();
  if (mode !== 'original') {
    const entries = translations instanceof Map ? [...translations].map(([id, text]) => ({ id, text })) : translations;
    if (!Array.isArray(entries)) throw new Error('字幕译文格式不正确。');
    for (const entry of entries) {
      const id = String(entry?.id ?? '');
      if (!id || translated.has(id)) throw new Error('字幕译文编号为空或重复。');
      translated.set(id, subtitleText(entry.text));
    }
  }
  const ids = new Set();
  const blocks = cues.map((cue, index) => {
    const id = String(cue?.id ?? '');
    if (!id || ids.has(id)) throw new Error('源字幕编号为空或重复。');
    ids.add(id);
    const { start, end } = cue;
    const startMs = Math.round(start * 1000), endMs = Math.round(end * 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
        !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) {
      throw new Error('源字幕时间轴不正确，无法导出。');
    }
    const original = subtitleText(cue.text);
    if (mode !== 'original' && !translated.has(id)) throw new Error(`第 ${index + 1} 条字幕缺少译文，请等待完整翻译。`);
    const text = mode === 'original' ? original : mode === 'translated' ? translated.get(id) : `${original}\r\n${translated.get(id)}`;
    return `${index + 1}\r\n${timestamp(startMs)} --> ${timestamp(endMs)}\r\n${text}`;
  });
  if (mode !== 'original' && [...translated.keys()].some(id => !ids.has(id))) throw new Error('译文包含不属于源字幕的编号。');
  return blocks.join('\r\n\r\n') + '\r\n\r\n';
}

function filenamePart(value, fallback) {
  const part = String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ').replace(/\.\.+/g, '_').replace(/^[. ]+|[. ]+$/g, '').trim();
  const safe = part || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}

export function srtFilename(title, videoId, sourceLanguage, targetLanguage, mode = 'bilingual') {
  requireMode(mode);
  const label = { original: 'original', translated: 'translated', bilingual: 'bilingual' }[mode];
  const language = mode === 'original' ? filenamePart(sourceLanguage, 'source') :
    mode === 'translated' ? filenamePart(targetLanguage, 'target') : `${filenamePart(sourceLanguage, 'source')}-${filenamePart(targetLanguage, 'target')}`;
  const parts = [filenamePart(title, 'YouTube'), filenamePart(videoId, 'video'), language, label];
  const bounded = parts.map((part, index) => {
    let result = '';
    for (const character of part) {
      if (result.length + character.length > (index === 0 ? 100 : 24)) break;
      result += character;
    }
    return result;
  });
  return bounded.join('_').replace(/[. ]+$/g, '') + '.srt';
}

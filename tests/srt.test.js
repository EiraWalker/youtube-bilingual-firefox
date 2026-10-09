import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSrt, srtFilename } from '../src/shared/srt.js';

const cues = [
  { id: 'hello', start: 0.125, end: 2.75, text: 'Hello world.' },
  { id: 'later', start: 3723.004, end: 3725.001, text: 'Second line.\nAnother line.' },
];
const translations = [{ id: 'later', text: '第二句。\n下一行。' }, { id: 'hello', text: '你好，世界。' }];

test('SRT bilingual export preserves cue times and matches translations by ID with CRLF', () => {
  assert.equal(exportSrt(cues, translations), '1\r\n00:00:00,125 --> 00:00:02,750\r\nHello world.\r\n你好，世界。\r\n\r\n2\r\n01:02:03,004 --> 01:02:05,001\r\nSecond line.\r\nAnother line.\r\n第二句。\r\n下一行。\r\n\r\n');
});

test('SRT source and translated exports only contain the selected language', () => {
  const original = exportSrt(cues, [], 'original');
  assert.ok(original.includes('Hello world.'));
  assert.ok(!original.includes('你好'));
  const translated = exportSrt(cues, translations, 'translated');
  assert.ok(translated.includes('你好，世界。'));
  assert.ok(!translated.includes('Hello'));
  assert.equal(translated, exportSrt(cues, new Map(translations.map(item => [item.id, item.text])), 'translated'));
});

test('SRT incomplete, duplicate, unknown or empty translated rows fail visibly', () => {
  assert.throws(() => exportSrt(cues, translations.slice(0, 1)), /缺少译文/);
  assert.throws(() => exportSrt(cues, [...translations, translations[0]]), /重复/);
  assert.throws(() => exportSrt(cues, [...translations, { id: 'unknown', text: '额外' }]), /不属于/);
  assert.throws(() => exportSrt(cues, translations.map(item => ({ ...item, text: '' }))), /为空/);
  assert.throws(() => exportSrt(cues, translations, 'invalid'), /模式/);
  assert.throws(() => exportSrt([], [], 'original'), /没有/);
});

test('SRT invalid timestamps and repeated cue IDs cannot become corrupted files', () => {
  for (const [start, end] of [[-1, 2], [0, Infinity], [NaN, 2], [2, 2], [0.0001, 0.0002]]) {
    assert.throws(() => exportSrt([{ id: 'x', text: 'x', start, end }], [], 'original'), /时间轴/);
  }
  assert.throws(() => exportSrt([cues[0], cues[0]], [], 'original'), /编号/);
});

test('SRT cleans line endings and blank/control lines without changing subtitle content', () => {
  const result = exportSrt([{ id: 'a', start: 0, end: 1, text: ' A\r\n\r\nB\u0000 ' }], [], 'original');
  assert.equal(result, '1\r\n00:00:00,000 --> 00:00:01,000\r\nA\r\nB\r\n\r\n');
});

test('SRT filename removes path traversal and Windows-invalid characters and bounds length', () => {
  const name = srtFilename('../CON:<bad>/\\title', '../abc', 'en/..', 'zh:CN', 'bilingual');
  assert.ok(name.endsWith('.srt'));
  assert.ok(!/[<>:"/\\|?*]/.test(name));
  assert.ok(!name.includes('..'));
  assert.equal(srtFilename('CON', 'video', 'en', 'zh', 'original'), '_CON_video_en_original.srt');
  assert.ok(srtFilename('长'.repeat(1000), 'x'.repeat(100), 's'.repeat(100), 't'.repeat(100)).length <= 184);
  const unicodeName = srtFilename('😀'.repeat(1000), 'video', 'en', 'zh');
  assert.ok(unicodeName.length <= 184);
  assert.ok(!unicodeName.slice(0, -4).endsWith('\ud83d'));
  assert.ok(unicodeName.endsWith('_video_en-zh_bilingual.srt'));
  assert.equal(srtFilename('', '', '', '', 'translated'), 'YouTube_video_target_translated.srt');
});

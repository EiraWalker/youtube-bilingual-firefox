import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCue, chooseTrack, normalizeCues, parseCaptionPayload, parseJson3, parseVtt, translationBatch } from '../src/shared/captions.js';

test('rolling JSON3 captions normalize overlap, append and gaps without stale text', () => {
  const cues = parseJson3({ events: [
    { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'Next' }] },
    { tStartMs: 2500, dDurationMs: 500, aAppend: 1, segs: [{ utf8: ' line' }] },
    { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: 'Last' }] },
  ] });
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[0, 2, 'Hello world'], [2, 3, 'Next line'], [4, 5, 'Last']]);
  assert.equal(activeCue(cues, 2)?.text, 'Next line');
  assert.equal(activeCue(cues, 3.5), null);
  assert.equal(activeCue(cues, 4.9)?.text, 'Last');
  assert.equal(activeCue(cues, 0)?.text, 'Hello world'); // backward seek
  assert.equal(activeCue(cues, 5), null);
});

test('VTT handles hours, cue IDs, styling and escaped characters', () => {
  const cues = parseVtt('WEBVTT\n\ncue-1\n01:02:03.000 --> 01:02:05.000 align:start\n<b>A &amp; B</b>\nsecond line\n\nNOTE ignore\ncomment');
  assert.deepEqual(cues, [{ id: '0', start: 3723, end: 3725, text: 'A & B\nsecond line' }]);
});

test('normalization rejects invalid cues, removes duplicates and supplies missing durations', () => {
  const cues = normalizeCues([{ start: -1, text: 'bad' }, { start: 4, text: 'B' }, { start: 0, text: ' A ' }, { start: 0, text: 'A' }, { start: NaN, text: 'bad' }]);
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[0, 4, 'A'], [4, 8, 'B']]);
});

test('track selection honors the player and prefers manual source-language captions', () => {
  const tracks = [{ id: 'ja', language: 'ja', automatic: false }, { id: 'en-auto', language: 'en', automatic: true }, { id: 'en', language: 'en-US', automatic: false }];
  assert.equal(chooseTrack(tracks, 'auto', 'en-auto').id, 'en-auto');
  assert.equal(chooseTrack(tracks, 'en').id, 'en');
  assert.equal(chooseTrack([], 'en'), null);
});

test('translation window follows seeks, excludes completed cues and bounds API batches', () => {
  const cues = normalizeCues(Array.from({ length: 200 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, text: `Line ${i}` })));
  const done = new Map([['100', 'translated']]);
  const pending = new Set(['101']);
  const batch = translationBatch(cues, 500, done, pending);
  assert.equal(batch.length, 12);
  assert.equal(batch[0].id, '102');
  assert.ok(batch.every(c => c.start < 575 && c.start >= 500));
  assert.equal(translationBatch(cues, 5, new Map())[0].id, '1');
});

test('caption payload rejects malformed JSON and excessive input', () => {
  assert.throws(() => parseCaptionPayload('{"events":null}'), /JSON3/);
  assert.throws(() => parseCaptionPayload('x'.repeat(8_000_001)), /过大/);
  assert.deepEqual(parseCaptionPayload(''), []);
});

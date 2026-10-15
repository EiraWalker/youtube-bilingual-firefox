import test from 'node:test';
import assert from 'node:assert/strict';
import { bufferedSeconds, planSegment } from '../src/shared/buffered.js';

const cue = (id, start, end, text = `caption ${id}`) => ({ id, start, end, text });

test('segment planning keeps cue boundaries and enforces both timeline and text limits', () => {
  const source = [cue('a', 0, 5, '12345'), cue('b', 5, 10, '12345'), cue('c', 10, 15, '12345')];
  assert.deepEqual(planSegment(source, new Set(), 0, { maxSeconds: 10, maxChars: 100 }).map(row => row.id), ['a', 'b']);
  assert.deepEqual(planSegment(source, new Set(), 0, { maxSeconds: 100, maxChars: 9 }).map(row => row.id), ['a']);
  assert.deepEqual(planSegment([cue('a', 0, 100, 'x'.repeat(2000))], new Set(), 0).map(row => row.id), ['a']);
});

test('segment planning starts near playback, excludes occupied cues, and never wraps to earlier gaps', () => {
  const source = [cue('a', 0, 5), cue('b', 5, 10), cue('c', 10, 15), cue('d', 15, 20)];
  const unavailable = new Set(['a', 'c']);
  assert.deepEqual(planSegment(source, unavailable, 5).map(row => row.id), ['b']);
  assert.deepEqual(planSegment(source, unavailable, 12).map(row => row.id), ['d']);
  assert.deepEqual(planSegment(source, unavailable, 21), []);
  assert.deepEqual(planSegment(source, new Set(source.map(row => row.id)), 5), []);
  assert.deepEqual([...unavailable], ['a', 'c']);
});

test('parallel plans never duplicate an immutable in-flight range', () => {
  const source = Array.from({ length: 12 }, (_, index) => cue(String(index), index * 10, index * 10 + 10));
  const unavailable = new Set();
  const parts = [];
  for (let slot = 0; slot < 3; slot++) {
    const part = planSegment(source, unavailable, 0, { maxSeconds: 40, maxChars: 1200 });
    parts.push(part);
    for (const row of part) unavailable.add(row.id);
  }
  assert.deepEqual(parts.map(part => part.map(row => row.id)), [['0', '1', '2', '3'], ['4', '5', '6', '7'], ['8', '9', '10', '11']]);
  assert.equal(unavailable.size, 12);
});

test('sparse subtitle gaps count toward source duration while dense tracks remain text bounded', () => {
  const sparse = [cue('a', 0, 3), cue('b', 100, 103), cue('c', 104, 106)];
  assert.deepEqual(planSegment(sparse, new Set(), 0, { maxSeconds: 60 }).map(row => row.id), ['a']);
  assert.deepEqual(planSegment(sparse, new Set(['a']), 20, { maxSeconds: 60 }).map(row => row.id), ['b', 'c']);
  const dense = Array.from({ length: 10 }, (_, index) => cue(String(index), index, index + 1, 'x'.repeat(500)));
  assert.equal(planSegment(dense, new Set(), 0).length, 2);
});

test('buffer stops at the first untranslated cue regardless of later returned segments', () => {
  const source = [cue('a', 0, 5), cue('b', 5, 10), cue('c', 10, 15), cue('d', 15, 20)];
  assert.equal(bufferedSeconds(source, new Set(['a', 'c', 'd']), 0), 5);
  assert.equal(bufferedSeconds(source, new Set(['a', 'c', 'd']), 6), 0);
  assert.equal(bufferedSeconds(source, new Set(source.map(row => row.id)), 3, 2), 8.5);
});

test('known subtitle-free gaps remain usable and completed timeline ends at the last source cue', () => {
  const source = [cue('a', 0, 5), cue('b', 100, 105)];
  assert.equal(bufferedSeconds(source, new Set(['a']), 0), 100);
  assert.equal(bufferedSeconds(source, new Set(['a']), 50, 2), 25);
  assert.equal(bufferedSeconds(source, new Set(['a', 'b']), 50), 55);
  assert.equal(bufferedSeconds(source, new Set(['a', 'b']), 106), 0);
  assert.equal(bufferedSeconds([], new Set(), 0), 0);
});

test('overlapping untranslated cues still bound buffer and invalid playback rate falls back to normal speed', () => {
  const source = [cue('a', 0, 10), cue('b', 5, 12)];
  assert.equal(bufferedSeconds(source, new Set(['a']), 3), 2);
  assert.equal(bufferedSeconds(source, new Set(['a']), 6), 0);
  assert.equal(bufferedSeconds(source, new Set(['a', 'b']), 3, 0), 9);
  assert.equal(bufferedSeconds(source, new Set(['a', 'b']), 3, Infinity), 9);
});

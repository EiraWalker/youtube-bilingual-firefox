import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SubtitleCache } from '../src/background/subtitle-cache.js';
import { TrackTaskService } from '../src/background/track-tasks.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { nativePort } from './support/native-port.js';

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'subtitle-cache-test-'));
  const folder = path.join(parent, '中文 字幕缓存');
  // Only this invocation's exact temporary directory may be cleaned.
  t.after(() => {
    assert.equal(path.dirname(path.resolve(parent)), path.resolve(tmpdir()));
    assert.ok(path.basename(parent).startsWith('subtitle-cache-test-'));
    return rm(parent, { recursive: true, force: true });
  });
  const cache = new SubtitleCache(nativePort);
  return { parent, folder, cache };
}
const record = (changes = {}) => ({ version: 3, id: 'a'.repeat(64), videoId: 'fixture-video',
  title: '../CON:标题', configFingerprint: 'b'.repeat(64), model: 'fixture-model', targetLanguage: 'zh-CN',
  track: { id: 'en', language: 'en', automatic: false },
  cues: [{ id: '0', start: 0, end: 2, text: 'First' }, { id: '1', start: 10.125, end: 12, text: 'Second' }],
  translations: [{ id: '0', text: '第一条' }], revision: 1, createdAt: 1, updatedAt: 2, ...changes });

test('actual native host writes a partial snapshot and reusable files under a Unicode directory', async t => {
  const { cache, folder } = await fixture(t);
  assert.equal((await cache.validate(folder)).folder, folder);
  const saved = await cache.save(record(), folder);
  assert.equal(saved.complete, false); assert.equal(saved.translatedCount, 1);
  const files = await readdir(saved.path);
  assert.deepEqual(files.sort(), ['bilingual.partial.srt', 'original.srt', 'subtitles.json']);
  assert.match(await readFile(path.join(saved.path, 'bilingual.partial.srt'), 'utf8'), /First\r\n第一条/);
  assert.ok(!(await readFile(path.join(saved.path, 'bilingual.partial.srt'), 'utf8')).includes('Second'));
  const read = await new SubtitleCache(nativePort).read(record().id, folder);
  assert.equal(read.translations.length, 1); assert.equal(read.cues[1].start, 10.125);
  assert.equal(read.title, '../CON:标题');
});

test('smaller or older snapshots merge without losing newer rows and do not accumulate duplicate revisions', async t => {
  const { cache, folder } = await fixture(t);
  const full = record({ revision: 5, translations: [{ id: '0', text: '新译文' }, { id: '1', text: '第二条' }] });
  const first = await cache.save(full, folder);
  const saved = await cache.save(record(), folder);
  assert.equal(saved.complete, true); assert.equal(saved.translatedCount, 2);
  assert.equal((await cache.read(full.id, folder)).translations[0].text, '新译文');
  assert.equal((await readdir(path.dirname(first.path))).filter(name => name.startsWith('rev-')).length, 1);
  assert.match(await readFile(path.join(saved.path, 'bilingual.srt'), 'utf8'), /00:00:10,125 --> 00:00:12,000/);
});

test('zero-translation snapshots create only original SRT and remain explicitly partial', async t => {
  const { cache, folder } = await fixture(t);
  const saved = await cache.save(record({ translations: [] }), folder);
  assert.equal(saved.translatedCount, 0); assert.equal(saved.complete, false);
  assert.deepEqual((await readdir(saved.path)).sort(), ['original.srt', 'subtitles.json']);
});

test('large snapshots cross native message limits through verified chunks and read back intact', async t => {
  const { cache, folder } = await fixture(t);
  const source = Array.from({ length: 220 }, (_, i) => ({ id: String(i), start: i * 3, end: i * 3 + 2, text: '原文'.repeat(1000) }));
  const large = record({ cues: source, translations: source.map(c => ({ id: c.id, text: '译文'.repeat(1000) })) });
  await cache.save(large, folder);
  assert.deepEqual((await cache.read(large.id, folder)).translations, large.translations);
});

test('invalid records, corrupt cache and invalid directories cannot destroy the previous snapshot', async t => {
  const { cache, folder, parent } = await fixture(t);
  await cache.save(record(), folder);
  await assert.rejects(cache.save(record({ translations: [{ id: 'unknown', text: 'bad' }] }), folder));
  assert.equal((await cache.read(record().id, folder)).translations.length, 1);
  await assert.rejects(cache.save(record({ id: '../escape' }), folder));
  await assert.rejects(cache.validate('relative-directory'));
  const file = path.join(parent, 'not-a-directory'); await writeFile(file, 'retain');
  await assert.rejects(cache.validate(file)); assert.equal(await readFile(file, 'utf8'), 'retain');
  const pointer = path.join(folder, record().id, 'current.json');
  await writeFile(pointer, JSON.stringify({ revision: '../escape' }));
  await assert.rejects(cache.read(record().id, folder));
});

test('cache files omit unexpected sensitive fields and serialized saving preserves all partial results', async t => {
  const { cache, folder } = await fixture(t);
  await Promise.all([cache.save(record({ apiKey: 'must-not-persist' }), folder),
    cache.save(record({ translations: [{ id: '1', text: '第二条' }] }), folder)]);
  const saved = await cache.read(record().id, folder);
  assert.equal(saved.translations.length, 2); assert.ok(!JSON.stringify(saved).includes('must-not-persist'));
});

test('a symlink or junction at the cache identity cannot redirect writes outside the configured folder', async t => {
  const { cache, folder, parent } = await fixture(t);
  await cache.validate(folder);
  const other = path.join(parent, 'other-folder');
  await cache.validate(other);
  await symlink(other, path.join(folder, record().id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cache.save(record(), folder));
  assert.deepEqual(await readdir(other), []);
});

test('unconfigured or missing native component fails saving while an empty-folder read is harmless', async t => {
  const { cache } = await fixture(t);
  assert.equal(await cache.read(record().id, ''), null);
  await assert.rejects(cache.save(record(), ''));
  const unavailable = new SubtitleCache(() => { throw new Error('missing host'); });
  await assert.rejects(unavailable.save(record(), '/configured-folder'));
});

test('only an explicit snapshot survives a fresh service; later in-flight rows are not silently persisted', async t => {
  const { cache, folder } = await fixture(t);
  const settings = normalizeSettings({ apiBaseUrl: 'http://localhost/v1', model: 'fixture', cacheFolder: folder });
  const storage = { async get() { return {}; }, async set() { throw new Error('automatic persistence'); } };
  const calls = [];
  const create = () => new TrackTaskService({ cache, storage, loadSettings: async () => settings, hasPermission: async () => true,
    fetchImpl: (_url, options) => new Promise(resolve => calls.push(() => {
      const rows = JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
      resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: rows.map(c => ({ id: c.id, text: '译:' + c.text })) }) } }] })));
    })), logger: () => {} });
  const input = { videoId: 'fixture-video', title: 'Cache', track: record().track,
    cues: Array.from({ length: 50 }, (_, i) => ({ id: String(i), start: i * 10, end: i * 10 + 2, text: 'caption' })),
    playback: { session: 'page', sequence: 1, view: 1, active: true, position: 0, rate: 1 } };
  const service = create(); const task = await service.start(input, 1);
  t.after(() => service.cancel(task.id));
  calls[0](); await new Promise(resolve => setTimeout(resolve, 10));
  const saved = await service.snapshot(task.id), before = calls.length;
  assert.ok(saved.translatedCount > 0 && !saved.complete);
  for (const release of calls) release(); await new Promise(resolve => setTimeout(resolve, 10));
  const fresh = create(); t.after(() => fresh.cancel(task.id));
  const cached = await fresh.start({ ...input, playback: { ...input.playback, active: false } }, 2);
  assert.equal(cached.translatedCount, saved.translatedCount);
  assert.equal(calls.length, before);
  assert.equal((await fresh.list()).length, 1);
  assert.ok((await service.status(task.id)).translatedCount > cached.translatedCount);
});

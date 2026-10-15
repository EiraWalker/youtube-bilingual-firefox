const HOST = 'local.youtube_bilingual.cache';
const CHUNK_BYTES = 96 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const encode = bytes => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** A bounded, verified transfer per connection; the native host owns atomic snapshots and merging. */
export class SubtitleCache {
  constructor(connect = () => browser.runtime.connectNative(HOST)) { this.connect = connect; this.saves = new Map(); }
  async connection(folder, action) {
    if (!folder) throw new Error('请先配置缓存文件夹。');
    const port = this.connect(); let sequence = 0;
    const pending = new Map();
    const fail = () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('缓存组件未连接。')); } pending.clear(); };
    port.onDisconnect.addListener(fail);
    port.onMessage.addListener(message => {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.data); else waiter.reject(new Error('缓存操作未完成，请检查目录与缓存组件。'));
    });
    const request = (op, data = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('缓存组件响应超时。')); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      try { port.postMessage({ id, op, ...data }); } catch { clearTimeout(timer); pending.delete(id); reject(new Error('缓存组件未连接。')); }
    });
    try { const actual = await request('configure', { folder }); return await action(request, actual); }
    finally { port.disconnect(); fail(); }
  }
  validate(folder) { return this.connection(folder, async (_request, actual) => actual); }
  open(folder) { return this.connection(folder, request => request('open')); }
  async read(id, folder) {
    if (!folder) return null;
    return this.connection(folder, async request => {
      const meta = await request('read', { key: id });
      if (!meta) return null;
      if (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > MAX_BYTES) throw new Error('缓存过大。');
      const bytes = new Uint8Array(meta.size);
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const chunk = decode(await request('read-chunk', { offset, size: Math.min(CHUNK_BYTES, bytes.length - offset) }));
        if (chunk.length !== Math.min(CHUNK_BYTES, bytes.length - offset)) throw new Error('缓存传输不完整。');
        bytes.set(chunk, offset);
      }
      if (await digest(bytes) !== meta.sha256) throw new Error('缓存校验失败。');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    });
  }
  save(record, folder) {
    const key = `${folder}:${record.id}`;
    const pending = (this.saves.get(key) || Promise.resolve()).catch(() => {}).then(() => this.connection(folder, async request => {
      const bytes = new TextEncoder().encode(JSON.stringify(record));
      if (bytes.length > MAX_BYTES) throw new Error('缓存过大。');
      await request('write-begin', { size: bytes.length, sha256: await digest(bytes) });
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) await request('write-chunk', { data: encode(bytes.subarray(offset, offset + CHUNK_BYTES)) });
      return request('write-commit');
    }));
    this.saves.set(key, pending);
    pending.finally(() => { if (this.saves.get(key) === pending) this.saves.delete(key); }).catch(() => {});
    return pending;
  }
}

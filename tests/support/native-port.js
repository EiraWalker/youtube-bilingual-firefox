import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs the shipped host over its real length-prefixed protocol; no filesystem mock.
export function nativePort() {
  const process = spawn(processPython(), ['-I', '-X', 'utf8', fileURLToPath(new URL('../../native/subtitle_cache_host.py', import.meta.url))], { windowsHide: true });
  const listeners = new Set(), disconnected = new Set();
  let buffer = Buffer.alloc(0);
  process.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
      const size = buffer.readUInt32LE();
      const message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
      buffer = buffer.subarray(size + 4);
      for (const listener of listeners) listener(message);
    }
  });
  process.on('error', () => { for (const listener of disconnected) listener(); });
  process.on('exit', () => { for (const listener of disconnected) listener(); });
  return {
    onMessage: { addListener: listener => listeners.add(listener) },
    onDisconnect: { addListener: listener => disconnected.add(listener) },
    postMessage(message) {
      const body = Buffer.from(JSON.stringify(message)), size = Buffer.alloc(4);
      size.writeUInt32LE(body.length); process.stdin.write(Buffer.concat([size, body]));
    },
    disconnect() { process.stdin.end(); },
  };
}
function processPython() { return process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'); }

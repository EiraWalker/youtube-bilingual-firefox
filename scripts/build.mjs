import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'build', 'firefox');
await mkdir(destination, { recursive: true });
await cp(path.join(root, 'extension'), destination, { recursive: true });
for (const [name, entry] of Object.entries({
  background: 'background/main.js',
  content: 'content/main.js',
  'page-bridge': 'content/page-bridge.js',
  options: 'ui/options.js',
  popup: 'ui/popup.js',
})) {
  await build({
    entryPoints: [path.join(root, 'src', entry)],
    outfile: path.join(destination, `${name}.js`),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'firefox140',
    legalComments: 'none',
    sourcemap: false,
  });
}
console.log(`Built Firefox extension: ${destination}`);

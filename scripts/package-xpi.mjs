import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const base = path.join(root, 'dist', `youtube-bilingual-firefox-${version}`);
await copyFile(`${base}.zip`, `${base}.xpi`);
console.log(`XPI ready: ${base}.xpi`);

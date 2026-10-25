import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const cli = process.env.FIREFOX_NIGHTLY_AUTOMATION_CLI ?? 'E:\\AI Tools\\Website Dev Tools\\firefox-nightly-automation\\cli.mjs';
const xpi = path.join(root, 'dist', `youtube-bilingual-firefox-${version}.xpi`);
const child = spawn(process.execPath, [cli, 'install', '--xpi', xpi, ...process.argv.slice(2)], { windowsHide: true, stdio: 'inherit' });
child.once('error', () => { console.error('F_NIGHTLY_INSTALL_UNAVAILABLE'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });

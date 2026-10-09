import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

// A hidden-input wrapper keeps API credentials out of command arguments/files.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
const line = await new Promise(resolve => input.once('line', resolve));
input.close();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
process.stdin.pause();
JSON.parse(line);
const child = spawn('python', ['-X', 'utf8', 'scripts/test-firefox.py', '--live-only', '--real-api', '--video', 'qp0HIF3SfI4'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(line + '\n');
child.on('error', () => { console.error('Unable to start isolated Firefox test.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });

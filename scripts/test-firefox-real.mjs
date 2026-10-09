import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

// A hidden-input wrapper keeps API credentials out of command arguments/files.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
const line = await new Promise(resolve => input.once('line', resolve));
input.close();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
process.stdin.pause();
try {
  const config = JSON.parse(line);
  if (!config || typeof config !== 'object' || !config.apiBaseUrl || !config.model) throw new Error();
} catch {
  // JSON parser errors may contain the private input; never forward them.
  throw new Error('Provide valid API configuration JSON through hidden stdin.');
}
const cliArguments = process.argv.slice(2);
const flags = cliArguments.filter(value => value.startsWith('--'));
if (flags.some(value => value !== '--first-only' && !/^--runs=[1-9]$/.test(value))) throw new Error('Unknown real Firefox test option.');
const positional = cliArguments.filter(value => !value.startsWith('--'));
if (positional.length > 2) throw new Error('Expected a video ID and an optional report tag.');
const video = positional[0] || '6AgOfiZOWiY';
if (!/^[\w-]{11}$/.test(video)) throw new Error('Invalid YouTube video ID.');
const tag = positional[1] || `real-${video}`;
if (!/^[\w-]+$/.test(tag)) throw new Error('Invalid report tag.');
const runs = Number(flags.find(flag => flag.startsWith('--runs='))?.split('=')[1] || 1);
for (let run = 1; run <= runs; run++) {
  const runTag = runs === 1 ? tag : `${tag}-${run}`;
  const code = await new Promise(resolve => {
    const child = spawn('python', ['-X', 'utf8', 'scripts/test-firefox.py', '--live-only', '--real-api', '--video', video, '--report-tag', runTag,
      ...(flags.includes('--first-only') ? ['--first-only'] : [])], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(line + '\n');
    child.on('error', () => { console.error('Unable to start isolated Firefox test.'); resolve(1); });
    child.on('exit', result => resolve(result ?? 1));
  });
  if (code) { process.exitCode = code; break; }
}

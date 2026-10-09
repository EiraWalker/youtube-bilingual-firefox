import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { normalizeSettings, completionEndpoint } from '../src/shared/settings.js';
import { translateCues } from '../src/background/translator.js';

// Read credentials from stdin so they are absent from files and process arguments.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
const line = await new Promise(resolve => input.once('line', resolve));
input.close();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
process.stdin.pause();
const settings = normalizeSettings(JSON.parse(line));
const report = { endpoint: completionEndpoint(settings.apiBaseUrl), model: settings.model, passed: false };
try {
  report.translations = await translateCues(settings, [
    { id: 'one', text: 'Hello, welcome to this video.' },
    { id: 'two', text: 'Pause the video and read both subtitle lines.' },
  ]);
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
}
await mkdir('output', { recursive: true });
await writeFile('output/real-api.json', JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));

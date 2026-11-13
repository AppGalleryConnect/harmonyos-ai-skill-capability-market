// Explicit file arguments work on both cmd.exe and POSIX shells; no shell glob.
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const suites = { adapter: ['scripts/shared/test', 'scripts/maintenance/test'], scanner: ['scripts/scanner/test'] };
const requested = process.argv[2];
if (requested !== 'all' && !Object.hasOwn(suites, requested)) throw new Error('Specify all, adapter or scanner test suite');
const selected = requested === 'all' ? Object.keys(suites) : [requested];
process.exitCode = 0;
for (const name of selected) {
  console.log(`[tests] ${name}`);
  try {
    const files = [];
    for (const relative of suites[name]) {
      const directory = path.join(root, relative);
      files.push(...(await readdir(directory)).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join(directory, file)));
    }
    if (!files.length) throw new Error('No test files found');
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = requested === 'all' ? 1 : result.status ?? 1;
  } catch (error) {
    console.error(`[tests] ${name}`, error);
    process.exitCode = 1;
  }
}

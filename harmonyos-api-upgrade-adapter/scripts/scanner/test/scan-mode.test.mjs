import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execute, selectScanRules } from '../core/cli.mjs';
import { compileRules, loadDevEcoRules } from '../core/rules.mjs';
import { runDevEcoScan } from '../core/scan-runner.mjs';

for (const command of ['scan', 'inspect-rules']) test(`${command} rejects missing and retired modes before any input lookup or output`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scan-mode-中文 空格-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of [undefined, 'full', 'deprecated-only', 'unknown', '', true]) {
    const modeArgs = mode === undefined ? [] : mode === true ? ['--mode'] : ['--mode', mode];
    await assert.rejects(execute([command, ...modeArgs, '--project', path.join(root, 'missing-project'),
      '--sdk', path.join(root, 'missing-sdk'), '--output-dir', path.join(root, 'output')]), { code: 'SCAN_MODE_INVALID' });
    assert.deepEqual(await readdir(root), []);
  }
});

test('internal scan entrypoints require an explicit supported mode', async () => {
  for (const mode of [undefined, 'full', 'deprecated-only', 'unknown']) {
    const options = { mode };
    await assert.rejects(compileRules(options), { code: 'SCAN_MODE_INVALID' });
    await assert.rejects(loadDevEcoRules(null, null, null, mode), { code: 'SCAN_MODE_INVALID' });
    await assert.rejects(runDevEcoScan(options), { code: 'SCAN_MODE_INVALID' });
    assert.throws(() => selectScanRules([], mode), { code: 'SCAN_MODE_INVALID' });
  }
});

test('scan execution requires a batch identity and never falls back to root report files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scan-batch-required-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ['upgrade', 'deprecated']) for (const batchId of [undefined, 'invalid']) {
    await assert.rejects(runDevEcoScan({ mode, batchId, outputDirectory: root }), { code: 'SCAN_BATCH_INVALID' });
    assert.deepEqual(await readdir(root), []);
  }
});

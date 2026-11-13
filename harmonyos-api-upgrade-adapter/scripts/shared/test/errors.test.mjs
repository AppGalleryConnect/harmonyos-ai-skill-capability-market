import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeError } from '../platform/errors.mjs';

const execFileAsync = promisify(execFile);
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('serializes stack, command, stage, cause and diagnostic artifacts', () => {
  const cause = Object.assign(new Error('scanner failed'), { code: 'SCAN_FAILED', stage: 'RUN_DEVECO_SCAN' });
  const error = Object.assign(new Error('adapter failed', { cause }), {
    code: 'PREPARE_FAILED',
    stage: 'RESOLVE_SDK_REFERENCE',
    details: { file: 'D:/SDK/api/test.d.ts' },
    validationErrors: ['missing source'],
    artifactPaths: ['D:/project/diagnostics.json'],
  });
  const result = serializeError(error, { command: 'prepare' });
  assert.equal(result.command, 'prepare');
  assert.equal(result.stage, 'RESOLVE_SDK_REFERENCE');
  assert.match(result.stack, /adapter failed/);
  assert.equal(result.cause.code, 'SCAN_FAILED');
  assert.deepEqual(result.artifactPaths, ['D:/project/diagnostics.json']);
});

test('scanner CLI failures expose structured stacks', async () => {
  for (const script of ['scripts/scanner/bin/harmony-api-scan.mjs']) {
    await assert.rejects(execFileAsync(process.execPath, [path.join(skillRoot, script), 'unknown-command']), error => {
      const response = JSON.parse(error.stderr);
      assert.equal(response.ok, false);
      assert.equal(response.error.command, 'unknown-command');
      assert.match(response.error.stack, /Unknown command/);
      assert.ok(response.error.code);
      return true;
    });
  }
});

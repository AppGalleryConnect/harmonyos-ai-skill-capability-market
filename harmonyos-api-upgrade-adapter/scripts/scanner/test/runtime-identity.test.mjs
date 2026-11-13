import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { access, mkdtemp, mkdir, cp, readFile, realpath, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runtimeIdentity } from '../core/runtime-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('a skill copy without local docs and evaluations runs CLI and validation from another cwd with a stable fingerprint', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), '复制 skill 中文 space-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const target = path.join(workspace, 'harmonyos-api-upgrade-adapter');
  const cwd = path.join(workspace, 'business');
  await mkdir(cwd);
  const excluded = new Set(['.git', 'node_modules', '.cache', '.superpowers', '.api-change-output', 'evals', 'docs']);
  await cp(root, target, { recursive: true, filter: file => !excluded.has(path.basename(file)) });
  for (const directory of ['docs', 'evals'])
    await assert.rejects(access(path.join(target, directory)), { code: 'ENOENT' });
  const { runtimeIdentity: identify } = await import(pathToFileURL(path.join(target, 'scripts', 'scanner', 'core', 'runtime-identity.mjs')));
  const identity = await identify(target, { mode: 'deprecated' });
  assert.equal(identity.skillRoot, target);
  assert.equal(identity.implementationFingerprint, (await runtimeIdentity(root, { mode: 'deprecated' })).implementationFingerprint);
  await assert.rejects(identify(target, { mode: 'full' }), { code: 'SCAN_MODE_INVALID' });
  const run = (args, timeout = 30_000) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout });
    assert.ifError(result.error);
    return result;
  };
  const entry = path.join(target, 'scripts', 'scanner', 'bin', 'harmony-api-scan.mjs');
  const help = run([entry, 'help']);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(JSON.parse(help.stdout).ok, true);
  const initialized=run([entry,'init-task','--task-root',cwd,'--output-dir',path.join(workspace,'output')]);
  assert.equal(initialized.status,0,initialized.stderr);
  const task=JSON.parse(initialized.stdout).result;
  const scan = run([entry, 'scan', '--task',task.taskFile, '--mode', 'upgrade', '--project', cwd, '--sdk', path.join(workspace, 'missing-sdk'),
    '--from', '13', '--to', '26', '--output-dir', path.join(workspace, 'output')]);
  assert.equal(scan.status, 1);
  const error = JSON.parse(scan.stderr).error;
  assert.equal(error.stage, 'DISCOVER_TOOLCHAIN');
  const diagnostics = JSON.parse(await readFile(error.artifactPaths[0], 'utf8'));
  assert.equal(await realpath(diagnostics.runtime.skillRoot), await realpath(target));
  assert.equal(await realpath(diagnostics.options.referenceRoot), await realpath(path.join(target, 'references', 'changelogs')));
  const validation = run([path.join(target, 'scripts', 'maintenance', 'validation', 'validate-skill.mjs')]);
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(JSON.parse(validation.stdout).valid, true);
  assert.equal(JSON.parse(validation.stdout).evaluations.status, 'SKIPPED');
  // The nested adapter suite runs about 200 tests serially; it needs more than the single-command budget.
  const adapterTests = run([path.join(target, 'scripts', 'test-suite.mjs'), 'adapter'], 300_000);
  assert.equal(adapterTests.status, 0, adapterTests.stderr || adapterTests.stdout);
  const backendTests = run(['--test', '--test-name-pattern=runs the index backend|batch output keeps an empty scan table',
    path.join(target, 'scripts', 'scanner', 'test', 'scan-runner.test.mjs')]);
  assert.equal(backendTests.status, 0, backendTests.stderr || backendTests.stdout);
});

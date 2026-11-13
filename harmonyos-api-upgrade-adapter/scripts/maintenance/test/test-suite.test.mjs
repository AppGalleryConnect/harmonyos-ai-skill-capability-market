import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

async function fixture(t, failingSuite = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-suites-中文 空格'路径-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts', 'shared', 'test'), { recursive: true });
  await mkdir(path.join(root, 'scripts', 'maintenance', 'test'), { recursive: true });
  const runner = path.join(root, 'scripts', 'test-suite.mjs');
  await copyFile(fileURLToPath(new URL('../../test-suite.mjs', import.meta.url)), runner);
  for (const [suite, directory] of [['adapter', path.join(root, 'scripts', 'shared', 'test')],
    ['scanner', path.join(root, 'scripts', 'scanner', 'test')]]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'fixture with spaces.test.mjs'), `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      console.log(${JSON.stringify(`${suite.toUpperCase()}_RAN`)});
      test('fixture', () => assert.equal(${suite === failingSuite}, false));
    `);
  }
  return { root, runner };
}

function run(runner, suite) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner, suite], { env, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

for (const failingSuite of [null, 'adapter', 'scanner']) {
  test(`aggregate tests run both suites and ${failingSuite ? `fail when ${failingSuite} fails` : 'succeed only when both pass'}`, async t => {
    const { runner } = await fixture(t, failingSuite);
    const result = run(runner, 'all');
    assert.equal(result.status, failingSuite ? 1 : 0);
    assert.match(result.output, /ADAPTER_RAN[\s\S]*SCANNER_RAN/);
  });
}

test('aggregate tests still run scanner after adapter discovery fails', async t => {
  const { root, runner } = await fixture(t);
  await rm(path.join(root, 'scripts', 'shared', 'test'), { recursive: true });
  const result = run(runner, 'all');
  assert.equal(result.status, 1);
  assert.match(result.output, /ENOENT/);
  assert.match(result.output, /SCANNER_RAN/);
});

test('individual suite commands retain their selection and failure status', async t => {
  const { runner } = await fixture(t, 'adapter');
  const adapter = run(runner, 'adapter');
  assert.equal(adapter.status, 1);
  assert.match(adapter.output, /ADAPTER_RAN/);
  assert.doesNotMatch(adapter.output, /SCANNER_RAN/);
  const scanner = run(runner, 'scanner');
  assert.equal(scanner.status, 0);
  assert.match(scanner.output, /SCANNER_RAN/);
  assert.doesNotMatch(scanner.output, /ADAPTER_RAN/);
});

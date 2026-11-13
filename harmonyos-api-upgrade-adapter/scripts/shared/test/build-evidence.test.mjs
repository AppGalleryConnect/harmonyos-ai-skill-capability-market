import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath, utimes } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { runBuild } from '../../toolchain/build.mjs';

async function setup(t) {
  const project = await mkdtemp(path.join(os.tmpdir(), '取证 中文 &-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const environment = { result: { tools: { ohpm: { path: path.join(project, 'ohpm'), version: '26' },
    hvigorw: { path: path.join(project, 'hvigorw'), version: '6' } }, processEnvironment: { prependPath: [], JAVA_HOME: project, DEVECO_SDK_HOME: project } } };
  return { project, environment, evidenceDirectory: path.join(project, 'evidence'), args: ['assembleHar', '-p', 'module=中文@default'] };
}
for (const failure of [{ exitCode: 7 }, { exitCode: null, error: 'spawn EPERM' }, { exitCode: null, timedOut: true }])
  test(`installation failure never starts Hvigor: ${JSON.stringify(failure)}`, async t => {
    const options = await setup(t), calls = [];
    const result = await runBuild(options, { run: async (file, args) => { calls.push(args); return { stdout: 'full\n'.repeat(3000), stderr: 'failed', ...failure }; } });
    assert.deepEqual(calls, [['install']]); assert.equal(result.status, 'INSTALL_FAILED');
    assert.equal(result.receiptPath, path.join(result.directory, 'receipt.json'));
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
    assert.equal(receipt.receiptPath, result.receiptPath);
    assert.equal(receipt.build, null);
    assert.equal(receipt.install.exitCode, failure.exitCode);
    assert.equal((await readFile(path.join(result.directory, 'install.stdout.log'), 'utf8')).length, 15000);
  });
for (const buildExit of [0, 9]) test(`build evidence preserves actual exit ${buildExit} and independent attempts`, async t => {
  const options = await setup(t), calls = [];
  const run = async (file, args, processOptions) => { calls.push({ file, args, processOptions });
    return { exitCode: args[0] === 'install' ? 0 : buildExit, stdout: 'real output', stderr: 'real error' }; };
  const first = await runBuild(options, { run }), second = await runBuild(options, { run });
  assert.equal(first.status, buildExit === 0 ? 'BUILD_SUCCEEDED' : 'BUILD_FAILED'); assert.notEqual(first.directory, second.directory);
  assert.equal((await readdir(options.evidenceDirectory)).length, 2);
  assert.equal(first.receiptPath, path.join(first.directory, 'receipt.json'));
  assert.notEqual(first.receiptPath, second.receiptPath);
  const receipt = JSON.parse(await readFile(first.receiptPath, 'utf8'));
  assert.equal(receipt.build.exitCode, buildExit); assert.deepEqual(receipt.build.args, options.args);
  assert.equal(receipt.install.exitCode, 0);
  assert.equal(calls[0].processOptions.cwd, await realpath(options.project));
});

test('CLI captures a real failing child exit instead of a pipeline status', async t => {
  const options = await setup(t);
  await writeFile(path.join(options.project, 'install'), 'process.stdout.write("installation complete");');
  await writeFile(path.join(options.project, 'compile.cjs'), 'process.stdout.write("full output\\n".repeat(2000)); process.stderr.write("compiler failure"); process.exitCode=13;');
  options.environment.result.tools.ohpm.path = process.execPath;
  options.environment.result.tools.hvigorw.path = process.execPath;
  const environmentFile = path.join(options.project, 'environment.json');
  await writeFile(environmentFile, JSON.stringify(options.environment));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'toolchain', 'cli.mjs'), 'build', '--project', options.project,
    '--environment', environmentFile, '--evidence-dir', options.evidenceDirectory, '--', 'compile.cjs'], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout).result;
  assert.equal(receipt.receiptPath, path.join(receipt.directory, 'receipt.json'));
  assert.deepEqual(JSON.parse(await readFile(receipt.receiptPath, 'utf8')), receipt);
  assert.equal(receipt.install.exitCode, 0); assert.equal(receipt.build.exitCode, 13);
  assert.equal((await readFile(path.join(receipt.directory, 'build.stdout.log'), 'utf8')).length, 24000);
  assert.equal(await readFile(path.join(receipt.directory, 'build.stderr.log'), 'utf8'), 'compiler failure');
});

test('install output is readable before completion, flushed once and attached to a running receipt', async t => {
  const options = await setup(t);
  let installDirectory;
  const run = async (file, args, processOptions) => {
    if (args[0] === 'install') {
      installDirectory = path.join(options.evidenceDirectory, (await readdir(options.evidenceDirectory))[0]);
      await processOptions.onOutput('live 中文\n', 'stdout');
      assert.equal(await readFile(path.join(installDirectory, 'install.stdout.log'), 'utf8'), 'live 中文\n');
      const running = JSON.parse(await readFile(path.join(installDirectory, 'receipt.json'), 'utf8'));
      assert.equal(running.install.status, 'RUNNING');
      return { exitCode: 0, stdout: 'live 中文\n', stderr: '', pid: 42, events: [{ type: 'exit', at: 'now' }], stdoutBytes: Buffer.byteLength('live 中文\n') };
    }
    return { exitCode: 0, stdout: 'compiled', stderr: '' };
  };
  const receipt = await runBuild(options, { run });
  assert.equal(receipt.status, 'BUILD_SUCCEEDED');
  assert.equal(receipt.install.process.pid, 42);
  assert.equal(receipt.install.process.stdoutBytes, Buffer.byteLength('live 中文\n'));
  assert.equal(await readFile(path.join(installDirectory, 'install.stdout.log'), 'utf8'), 'live 中文\n');
});

test('log write failure preserves the failed attempt and never starts compilation', async t => {
  const options = await setup(t), calls = [];
  const receipt = await runBuild(options, {
    write() { throw new Error('disk full'); },
    run: async (file, args, settings) => { calls.push(args); settings.onOutput('partial', 'stdout'); return { exitCode: 0 }; },
  });
  assert.deepEqual(calls, [['install']]);
  assert.equal(receipt.status, 'INSTALL_FAILED');
  assert.equal(receipt.build, null);
  assert.equal(receipt.install.process.errorCode, 'OUTPUT_WRITE_FAILED');
  assert.match(receipt.install.error, /disk full/);
});

test('RNOH build receipt records the packaged RN bundle and flags business JS changed after it', async t => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rn-bundle-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const project = path.join(workspace, 'harmony'), rawfile = path.join(project, 'entry', 'src', 'main', 'resources', 'rawfile');
  await mkdir(rawfile, { recursive: true }); await mkdir(path.join(workspace, 'src', '__tests__'), { recursive: true });
  await mkdir(path.join(workspace, 'patches'));
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ dependencies: { '@react-native-oh/react-native-harmony': '0.72.53' } }));
  await writeFile(path.join(project, 'oh-package.json5'), '{ dependencies: { "@rnoh/react-native-openharmony": "0.72.53" } }');
  const at = async (file, seconds, text = 'x') => { await writeFile(file, text); await utimes(file, seconds, seconds); };
  const page = path.join(workspace, 'src', 'Page.tsx'), bundle = path.join(rawfile, 'bundle.harmony.js');
  await at(page, 1000); await at(path.join(workspace, 'src', '__tests__', 'Page.test.tsx'), 9000);
  await at(path.join(workspace, 'src', 'Page.test.tsx'), 9000); await at(bundle, 2000, 'bundle');
  await at(path.join(rawfile, 'config.json'), 100);
  const base = await setup(t), options = { ...base, project }, run = async () => ({ exitCode: 0, stdout: 'ok', stderr: '' });
  const fresh = await runBuild(options, { run });
  assert.equal(fresh.rnBundle.status, 'FRESH');
  assert.deepEqual(fresh.rnBundle.bundles.map(item => [item.path, item.bytes, item.newerSourceCount]), [['entry/src/main/resources/rawfile/bundle.harmony.js', 6, 0]]);
  assert.match(fresh.rnBundle.bundles[0].sha256, /^[0-9a-f]{64}$/);
  // 业务 JS 修改后未重新打 bundle：构建仍成功，但回执标出 bundle 过期及较新的源码。
  await utimes(page, 3000, 3000);
  const stale = await runBuild(options, { run });
  assert.deepEqual([stale.status, stale.rnBundle.status, stale.rnBundle.newerSources.map(item => item.path)], ['BUILD_SUCCEEDED', 'STALE', ['src/Page.tsx']]);
  assert.match(stale.rnBundle.message, /须重新生成 bundle/);
  assert.equal(JSON.parse(await readFile(stale.receiptPath, 'utf8')).rnBundle.status, 'STALE');
  // JS 层补丁（patches/*.patch）同样计入；拆包场景只有部分 bundle 过期时单独标出。
  await utimes(page, 1000, 1000); await at(path.join(workspace, 'patches', 'rn+0.72.patch'), 2500);
  await mkdir(path.join(rawfile, 'bundle')); await at(path.join(rawfile, 'bundle', 'home.harmony.bundle'), 4000);
  const partial = await runBuild(options, { run });
  assert.deepEqual([partial.rnBundle.status, partial.rnBundle.newerSources.map(item => item.path)], ['PARTIALLY_STALE', ['patches/rn+0.72.patch']]);
  await rm(path.join(rawfile, 'bundle'), { recursive: true }); await rm(bundle);
  assert.equal((await runBuild(options, { run })).rnBundle.status, 'MISSING');
  // 构建失败不做核对；非 RNOH 工程回执不含该字段。
  assert.equal((await runBuild(options, { run: async (file, args) => ({ exitCode: args[0] === 'install' ? 0 : 1 }) })).rnBundle, undefined);
  assert.equal((await runBuild(base, { run })).rnBundle, undefined);
});

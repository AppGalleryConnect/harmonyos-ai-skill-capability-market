import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectEnvironment } from '../core/environment.mjs';
import { resolveDevEcoHome } from '../../shared/platform/deveco-home.mjs';
import { execute } from '../core/cli.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(t, platform = 'darwin') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'DevEco 中文 空格-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'DevEco-Studio.app'), home = platform === 'darwin' ? path.join(app, 'Contents') : path.join(dir, 'DevEco Studio');
  const sdk = path.join(home, 'sdk');
  const files = [
    [path.join(sdk, 'default', 'sdk-pkg.json'), JSON.stringify({ data: { platformVersion: '26.0.0', apiVersion: '26', releaseType: 'Release' } })],
    [path.join(home, ...(platform === 'darwin' ? ['Resources'] : []), 'product-info.json'), JSON.stringify({ version: '26.0.0.821' })],
    [path.join(home, 'jbr', ...(platform === 'darwin' ? ['Contents', 'Home'] : []), 'bin', platform === 'win32' ? 'java.exe' : 'java'), 'java'],
    [path.join(home, 'tools', 'ohpm', 'bin', platform === 'win32' ? 'ohpm.cmd' : 'ohpm'),
      platform === 'win32' ? '@echo off\r\necho fixture-version\r\nexit /b 0\r\n' : 'ohpm'],
    [path.join(home, 'tools', 'hvigor', 'bin', platform === 'win32' ? 'hvigorw.bat' : 'hvigorw'),
      platform === 'win32' ? '@echo off\r\necho fixture-version\r\nexit /b 0\r\n' : 'hvigor'],
  ];
  for (const [file, contents] of files) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents); }
  return { dir, home, app, sdk };
}

test('app and Contents resolve to one physical installation; SDK default is normalized', async t => {
  const { home, app, sdk } = await fixture(t);
  for (const input of [app, home]) assert.equal(await resolveDevEcoHome(sdk, input, {}), await realpath(home));
  const shortAlias = path.join(path.dirname(app), 'DEVECO~1');
  await symlink(home, shortAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await resolveDevEcoHome(sdk, shortAlias, {}), await realpath(home));
  assert.equal(await resolveDevEcoHome(sdk, null, { DEVECO_HOME: app }), await realpath(home));
  const probes = [];
  const callerRoot = await realpath(process.cwd());
  const result = await inspectEnvironment({ sdkPath: path.join(sdk, 'default'), devecoHomePath: app, targetVersion: '26' }, {
    env: {}, platform: 'darwin', probe: async (file, args, options) => {
      probes.push({ file, args, options }); return { exitCode: 0, stdout: 'version 26', stderr: '' };
    },
  });
  assert.equal(result.contentsRoot, await realpath(home));
  assert.equal(result.sdkRoot, sdk);
  assert.equal(result.devecoCompatibility.status, 'COMPATIBLE');
  assert.equal(result.productInfo.version, '26.0.0.821');
  assert.equal(probes.length, 4);
  assert.ok(probes.every(p => p.options.timeoutMs === 10_000 && !p.args.includes('install')));
  assert.equal(result.tools.java.status, 'AVAILABLE');
  assert.ok(probes.every(p => p.options.cwd === callerRoot), 'probes use caller cwd, never IDE installation');
  const explicitRoot = await realpath(path.dirname(app));
  await inspectEnvironment({ sdkPath: sdk, devecoHomePath: app, projectPath: explicitRoot }, {
    env: {}, platform: 'darwin', probe: async (file, args, options) => {
      assert.equal(options.cwd, explicitRoot);
      return { exitCode: 0, stdout: 'version', stderr: '' };
    },
  });
});

test('Windows fixed layout and per-tool failure/timeout are reported independently in parallel', async t => {
  const { home, sdk } = await fixture(t, 'win32');
  await rm(path.join(home, 'tools', 'ohpm'), { recursive: true });
  let started = 0;
  const result = await inspectEnvironment({ sdkPath: sdk, devecoHomePath: home }, { env: {}, platform: 'win32',
    probe: async file => { started++; await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(started, 3);
      return file.endsWith('.bat') ? { timedOut: true, exitCode: null, stdout: '', stderr: '' }
        : { exitCode: 0, stdout: 'version', stderr: '' }; },
  });
  assert.equal(result.tools.ohpm.status, 'MISSING');
  assert.equal(result.tools.hvigorw.status, 'TIMED_OUT');
  assert.equal(result.tools.java.status, 'AVAILABLE');
  assert.equal(result.status, 'INCOMPLETE');
});

test('damaged IDE metadata is unresolved; probes neither load scanner rules nor infer an IDE version', async t => {
  const { home, sdk } = await fixture(t);
  await writeFile(path.join(home, 'Resources', 'product-info.json'), '{broken');
  const result = await inspectEnvironment({ sdkPath: sdk, devecoHomePath: home }, { env: {},
    probe: async () => ({ exitCode: 1, stdout: '', stderr: 'not available' }),
  });
  assert.equal(result.devecoCompatibility.status, 'UNRESOLVED');
  assert.equal(result.devecoCompatibility.message, undefined);
  assert.equal(result.productInfo.version, null);
  assert.equal(result.tools.java.status, 'FAILED');
  assert.equal(result.tools.java.version, null);
  assert.equal(result.tools.java.stderr, 'not available');
});

test('a newer IDE does not conceal an SDK that is too old for the selected target', async t => {
  const { home, sdk } = await fixture(t);
  await writeFile(path.join(sdk, 'default', 'sdk-pkg.json'), JSON.stringify({ data: { platformVersion: '6.1.1', apiVersion: '24', releaseType: 'Release' } }));
  const result = await inspectEnvironment({ sdkPath: sdk, devecoHomePath: home, targetVersion: '26' }, {
    probe: async () => ({ exitCode: 0, stdout: 'version', stderr: '' }),
  });
  assert.equal(result.devecoCompatibility.status, 'COMPATIBLE');
  assert.equal(result.devecoCompatibility.message, undefined);
  assert.equal(result.sdkCompatibility.status, 'TOO_OLD');
  assert.equal(result.status, 'INCOMPLETE');
});

test('environment inspection explains the IDE upgrade for API26 on an API24 installation', async t => {
  for (const platform of ['darwin', 'win32']) {
    const { home, sdk, dir } = await fixture(t, platform);
    const metadata = path.join(home, ...(platform === 'darwin' ? ['Resources'] : []), 'product-info.json');
    await writeFile(metadata, JSON.stringify({ version: '6.1.1.280' }));
    await writeFile(path.join(sdk, 'default', 'sdk-pkg.json'), JSON.stringify({
      data: { platformVersion: '6.1.1', apiVersion: '24', releaseType: 'Release' },
    }));
    const outputPath = path.join(dir, 'environment.json');
    const options = { sdkPath: sdk, devecoHomePath: home };
    const dependencies = { platform, env: {}, probe: async () => ({ exitCode: 0, stdout: 'version', stderr: '' }) };
    const result = await inspectEnvironment({ ...options, targetVersion: '26', outputPath }, dependencies);
    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.sdkCompatibility.status, 'TOO_OLD');
    assert.equal(result.devecoCompatibility.status, 'TOO_OLD');
    assert.equal(result.devecoCompatibility.installedVersion, '6.1.1.280');
    assert.equal(result.devecoCompatibility.requiredVersion, '26.0.0');
    assert.match(result.devecoCompatibility.message, /https:\/\/developer\.huawei\.com\/consumer\/cn\/download\//);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { ok: true, result });
    const matching = await inspectEnvironment({ ...options, targetVersion: '24' }, dependencies);
    assert.equal(matching.status, 'COMPLETE');
    assert.equal(matching.devecoCompatibility.message, undefined);
  }
});

test('environment output creates its parent and retains the existing JSON envelope; empty versions are null', async t => {
  const { home, sdk, dir } = await fixture(t);
  const outputPath = path.join(dir, 'new evidence', 'nested', 'environment.json');
  const result = await inspectEnvironment({ sdkPath: sdk, devecoHomePath: home, outputPath }, {
    probe: async () => ({ exitCode: 0, stdout: '', stderr: '', pid: 123, events: [] }),
  });
  assert.equal(result.tools.ohpm.version, null);
  assert.equal(result.tools.ohpm.process.pid, 123);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { ok: true, result });
  const actualOutput = path.join(dir, 'CLI output', 'environment.json');
  const actual = await execute(['inspect-environment', '--sdk', sdk, '--deveco-home', home, '--output', actualOutput]);
  assert.deepEqual(JSON.parse(await readFile(actualOutput, 'utf8')), { ok: true, result: actual });
});

test('environment SDK fallback accepts root, default and physical aliases without Python or metadata shell probes', async t => {
  const { sdk, home, dir } = await fixture(t);
  const alias = path.join(dir, 'SDK 别名');
  await symlink(sdk, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const input of [sdk, path.join(sdk, 'default'), alias]) {
    const commands = [];
    const result = await inspectEnvironment({}, { platform:'darwin', env:{ DEVECO_SDK_HOME:input, DEVECO_HOME:home },
      probe:async (command, args) => { commands.push({command,args}); return {exitCode:0,stdout:'version',stderr:''}; } });
    assert.equal(await realpath(result.sdkDefaultRoot), await realpath(path.join(sdk, 'default')));
    assert.equal(await realpath(result.sdkPackagePath), await realpath(path.join(sdk, 'default', 'sdk-pkg.json')));
    assert.equal(commands.length,4);
    assert.ok(commands.every(call => call.command === process.execPath || ['java','ohpm','hvigorw'].includes(path.basename(call.command))));
    assert.ok(commands.every(call => !call.args.includes('install')));
  }
});

test('explicit SDK wins over environment; missing and invalid explicit paths never fall back', async t => {
  const { sdk, dir } = await fixture(t), missing = path.join(dir, 'missing SDK');
  const probe = async () => ({exitCode:0,stdout:'version',stderr:''});
  const result = await inspectEnvironment({sdkPath:sdk}, {env:{DEVECO_SDK_HOME:missing},probe});
  assert.equal(result.sdkRoot,sdk);
  await assert.rejects(inspectEnvironment({sdkPath:missing}, {env:{DEVECO_SDK_HOME:sdk},probe}), {code:'SDK_ROOT_INVALID'});
  const outputPath = path.join(dir,'not-created','environment.json');
  await assert.rejects(inspectEnvironment({outputPath}, {env:{},probe}), error => {
    assert.equal(error.code,'SDK_PATH_REQUIRED'); assert.match(error.message,/--sdk/); assert.match(error.message,/DEVECO_SDK_HOME/); return true;
  });
  await assert.rejects(readFile(outputPath), {code:'ENOENT'});
  await assert.rejects(inspectEnvironment({sdkPath:''}, {env:{DEVECO_SDK_HOME:sdk},probe}), {code:'SDK_PATH_REQUIRED'});
});

test('CLI can inspect from DEVECO_SDK_HOME without a shell-expanded sdk argument', async t => {
  const { sdk, home, dir } = await fixture(t, process.platform);
  const entry = fileURLToPath(new URL('../bin/harmony-api-scan.mjs',import.meta.url));
  const output = path.join(dir,'新诊断','environment.json');
  const result = spawnSync(process.execPath,[entry,'inspect-environment','--deveco-home',home,'--output',output], {
    env:{...process.env,DEVECO_SDK_HOME:path.join(sdk,'default')},encoding:'utf8',shell:false,timeout:30000,
  });
  assert.equal(result.status,0,result.stderr);
  const saved = JSON.parse(await readFile(output,'utf8'));
  assert.deepEqual(saved,JSON.parse(result.stdout));
  assert.equal(saved.result.sdkPackagePath,path.join(sdk,'default','sdk-pkg.json'));
});

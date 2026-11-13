import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureNativeBuild } from '../native/native.mjs';

test('only the backend-selected Ninja gates scanning and ordinary source edits do not stale it', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'native-selected-context-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = path.join(root, 'native'), now = Date.now() / 1000;
  const ninja = mode => path.join(moduleRoot, '.cxx', 'default', 'default', mode, 'arm64-v8a', 'build.ninja');
  for (const mode of ['debug', 'release']) {
    await mkdir(path.dirname(ninja(mode)), { recursive: true });
    await writeFile(ninja(mode), 'rule cc\n');
    await utimes(ninja(mode), now + (mode === 'debug' ? 10 : -10), now + (mode === 'debug' ? 10 : -10));
  }
  const cmake = path.join(moduleRoot, 'CMakeLists.txt'), source = path.join(moduleRoot, 'main.cpp');
  await writeFile(cmake, 'project(test)'); await utimes(cmake, now, now);
  await writeFile(source, 'int value = 1;'); await utimes(source, now + 20, now + 20);
  const records = await ensureNativeBuild({
    project: { root, product: { name: 'default' }, modules: [{name:'native', root:moduleRoot, target:'default', hasNativeConfig:true}] },
    toolchain: { nativeContextSelection: { strategy: 'FIRST_NINJA_DFS', source: 'test backend' } }, mode: 'off',
  });
  assert.equal(records[0].selectedNinja, ninja('debug'));
  assert.deepEqual(records[0].unusedNinjaFiles, [ninja('release')]);
  assert.equal(records[0].buildMode, 'debug');
  assert.equal(records[0].abi, 'arm64-v8a');
  assert.equal(records[0].rebuilt, false);
});

test('runs compileNative with the selected module target when ninja is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-native-'));
  const moduleRoot = path.join(root, 'native');
  await mkdir(path.join(root, 'oh_modules'), { recursive: true });
  await mkdir(moduleRoot, { recursive: true });
  const calls = [];
  await ensureNativeBuild({
    project: {
      root,
      product: { name: 'default' },
      modules: [{ name: 'native', target: 'default', root: moduleRoot, hasNativeConfig: true }],
    },
    toolchain: { hvigorw: path.join(root, 'hvigorw'), ohpm: path.join(root, 'ohpm'), sdkRoot: path.join(root, 'sdk') },
    runCommand: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'install') return { code: 0, stdout: 'installed', stderr: '' };
      await mkdir(path.join(moduleRoot, '.cxx', 'default', 'arm64-v8a'), { recursive: true });
      await writeFile(path.join(moduleRoot, '.cxx', 'default', 'arm64-v8a', 'build.ninja'), 'rule cc\n');
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['install']);
  assert.ok(calls[1].args.includes('module=native@default'));
  assert.ok(calls[1].args.includes('compileNative'));
});

test('reports a capability error when a native rebuild needs missing Hvigor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-native-no-hvigor-'));
  const moduleRoot = path.join(root, 'native');
  await mkdir(path.join(root, 'oh_modules'), { recursive: true });
  await mkdir(moduleRoot);
  await assert.rejects(ensureNativeBuild({
    project: {
      root, product: { name: 'default' },
      modules: [{ name: 'native', target: 'default', root: moduleRoot, hasNativeConfig: true }],
    },
    toolchain: { hvigorw: null, sdkRoot: '/mock/sdk' },
  }), { code: 'NATIVE_BUILD_TOOL_UNAVAILABLE' });
});

test('installs dependencies with ohpm before a native rebuild', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-native-ohpm-'));
  const moduleRoot = path.join(root, 'native');
  await mkdir(moduleRoot, { recursive: true });
  const calls = [];
  const records = await ensureNativeBuild({
    project: {
      root, product: { name: 'default' },
      modules: [{ name: 'native', target: 'default', root: moduleRoot, hasNativeConfig: true }],
    },
    toolchain: { hvigorw: '/mock/hvigorw', ohpm: '/mock/ohpm', sdkRoot: '/mock/sdk' },
    runCommand: async (command, args, cwd, environment, timeoutMs) => {
      calls.push({ command, args, cwd, timeoutMs });
      if (command === '/mock/ohpm') {
        await mkdir(path.join(root, 'oh_modules'), { recursive: true });
        return { code: 0, stdout: 'installed', stderr: '' };
      }
      await mkdir(path.join(moduleRoot, '.cxx', 'default', 'arm64-v8a'), { recursive: true });
      await writeFile(path.join(moduleRoot, '.cxx', 'default', 'arm64-v8a', 'build.ninja'), 'rule cc\n');
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls[0].command, '/mock/ohpm');
  assert.deepEqual(calls[0].args, ['install']);
  assert.equal(calls[0].cwd, root);
  assert.ok(calls[0].timeoutMs >= 60_000);
  assert.equal(calls[1].command, '/mock/hvigorw');
  assert.equal(records.length, 1);
  assert.equal(records[0].rebuilt, true);
});

test('reports OHPM_INSTALL_FAILED when dependency installation fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-native-ohpm-fail-'));
  const moduleRoot = path.join(root, 'native');
  await mkdir(moduleRoot, { recursive: true });
  await mkdir(path.join(root, 'oh_modules'));
  const calls = [], completeLog = 'dependency failure\n'.repeat(1000);
  await assert.rejects(ensureNativeBuild({
    project: {
      root, product: { name: 'default' },
      modules: [{ name: 'native', target: 'default', root: moduleRoot, hasNativeConfig: true }],
    },
    toolchain: { hvigorw: '/mock/hvigorw', ohpm: '/mock/ohpm', sdkRoot: '/mock/sdk' },
    runCommand: async (command, args) => { calls.push(args); return { code: 1, stdout: completeLog, stderr: 'install failed' }; },
  }), error => {
    assert.equal(error.code, 'OHPM_INSTALL_FAILED');
    assert.match(error.message, /ohpm install failed for native module native/);
    assert.equal(error.details.stderr, 'install failed');
    assert.equal(error.details.stdout, completeLog);
    return true;
  });
  assert.deepEqual(calls, [['install']]);
});

test('reports OHPM_UNAVAILABLE when dependencies are missing without ohpm', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-native-no-ohpm-'));
  const moduleRoot = path.join(root, 'native');
  await mkdir(moduleRoot, { recursive: true });
  await assert.rejects(ensureNativeBuild({
    project: {
      root, product: { name: 'default' },
      modules: [{ name: 'native', target: 'default', root: moduleRoot, hasNativeConfig: true }],
    },
    toolchain: { hvigorw: '/mock/hvigorw', ohpm: null, sdkRoot: '/mock/sdk' },
  }), { code: 'OHPM_UNAVAILABLE' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalSourceFile, loadProject, locationInsideScanDirs } from '../core/project.mjs';

test('tool directories are pruned while backups and business sources remain unless explicitly excluded', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'source-exclusions-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'build-profile.json5'), '{app:{products:[{name:"default"}]},modules:[{name:"entry",srcPath:"entry"},{name:"registered",srcPath:".agents/registered"}]}');
  for (const module of ['entry', path.join('.agents', 'registered')]) {
    await mkdir(path.join(root, module, 'src', 'main'), { recursive: true });
    await writeFile(path.join(root, module, 'src', 'main', 'module.json5'), '{module:{type:"entry"}}');
  }
  for (const directory of ['entry', 'entry_bak', 'utils', 'AppScope', '.opencode', '.claude', '.codex', '.agents/skills', '.agents/registered']) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'A.ts'), 'export {};');
  }
  const baseline = await loadProject(root, 'default');
  assert.deepEqual(baseline.sourceFiles.map(file => path.relative(root, file)).sort(),
    ['entry/A.ts', 'entry_bak/A.ts', 'utils/A.ts', 'AppScope/A.ts', '.agents/registered/A.ts'].map(file => path.normalize(file)).sort());
  const alias = path.join(root, 'backup alias');
  await symlink(path.join(root, 'entry_bak'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const excluded = await loadProject(root, 'default', [], [], 'app', { excludeDirs: [alias] });
  assert.equal(excluded.sourceFiles.some(file => path.dirname(file) === path.join(root, 'entry_bak')), false);
  assert.equal(locationInsideScanDirs(excluded, 'entry_bak/A.ts:1'), false);
});

test('repeated source aliases use bounded physical lookups and preserve Windows path identity', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'source-path-index-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = path.join(root, 'sources'), alias = path.join(root, 'alias');
  await mkdir(sources);
  const files = Array.from({ length: 1000 }, (_, i) => path.join(sources, `A${i}.ts`));
  await Promise.all(files.map(file => writeFile(file, 'export {};')));
  await symlink(sources, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const project = { sourceFiles: files }, original = fs.realpathSync.native;
  let calls = 0;
  fs.realpathSync.native = (...args) => { calls++; return original(...args); };
  try {
    for (let i = 0; i < 1000; i++) assert.equal(canonicalSourceFile(project, path.join(alias, 'A0.ts')), files[0]);
  } finally { fs.realpathSync.native = original; }
  assert.ok(calls <= files.length + 2, `physical lookups: ${calls}`);
  const windowsFile = path.win32.join('D:', 'Work', 'Entry', 'A.ts');
  const windows = { sourceFiles: [windowsFile] };
  assert.equal(canonicalSourceFile(windows, windowsFile.split(path.win32.sep).join('/'), 'win32'), windowsFile);
});

test('loads full module context but restricts emitted locations to scan dirs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-scan-project-'));
  await writeFile(path.join(root, 'build-profile.json5'), `{
    app: { products: [{ name: 'default', compatibleSdkVersion: '12' }] },
    modules: [{ name: 'entry', srcPath: './entry' }, { name: 'feature', srcPath: './feature' }],
  }`);
  for (const module of ['entry', 'feature']) {
    await mkdir(path.join(root, module, 'src', 'main', 'ets'), { recursive: true });
    await writeFile(path.join(root, module, 'src', 'main', 'module.json5'), `{ module: { name: '${module}', type: 'har' } }`);
    await writeFile(path.join(root, module, 'src', 'main', 'ets', 'A.ets'), 'const value = 1;\n');
  }
  const project = await loadProject(root, 'default', ['entry']);
  assert.deepEqual(project.modules.map((item) => item.name), ['entry', 'feature']);
  assert.deepEqual(project.selectedModules.map((item) => item.name), ['entry']);
  assert.equal(locationInsideScanDirs(project, 'entry/src/main/ets/A.ets:1'), true);
  assert.equal(locationInsideScanDirs(project, 'feature/src/main/ets/A.ets:1'), false);
  assert.equal(locationInsideScanDirs(project, 'entry/src/main/ets/Missing.ets:1'), false);
});

test('dependency, build and test directories never enter source discovery or result scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmony-excluded-source-'));
  await writeFile(path.join(root, 'build-profile.json5'), '{app:{products:[{name:"default"}]},modules:[{name:"entry",srcPath:"entry"}]}');
  await mkdir(path.join(root, 'entry/src/main'), { recursive: true });
  await writeFile(path.join(root, 'entry/src/main/module.json5'), '{module:{type:"entry"}}');
  for (const directory of ['entry/src/main/ets', 'entry/oh_modules', 'entry/build', 'entry/src/ohosTest', 'node_modules']) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'A.ets'), 'oldGlobal();');
  }
  await writeFile(path.join(root, 'entry', 'BuildProfile.ets'), 'generatedBuildProfile();');
  const project = await loadProject(root, 'default');
  assert.equal(project.sourceFiles.length, 1);
  assert.equal(locationInsideScanDirs(project, 'entry/oh_modules/A.ets:1'), false);
  assert.equal(locationInsideScanDirs(project, 'entry/build/A.ets:1'), false);
});

test('module build profiles identify the missing project root without widening scope', async () => {
  const module = await mkdtemp(path.join(os.tmpdir(), 'module-only-'));
  await writeFile(path.join(module, 'build-profile.json5'), '{apiType:"stageMode",targets:[{name:"default"}]}');
  await assert.rejects(loadProject(module, 'default'), error => {
    assert.equal(error.code, 'PROJECT_ROOT_INVALID');
    assert.match(error.message, /--project/); assert.match(error.message, /--scan-module/);
    return true;
  });
});

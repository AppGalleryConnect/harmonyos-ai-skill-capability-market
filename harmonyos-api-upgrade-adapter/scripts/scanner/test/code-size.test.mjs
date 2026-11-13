import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createCodeSize, countSourceLines } from '../core/code-size.mjs';
import { loadProject } from '../core/project.mjs';
import { scanRnohImpacts } from '../rnoh/rnoh.mjs';

const lines = (physicalLines, codeLines) => ({ physicalLines, codeLines });
const catalog = { ts };

test('script counts use token locations and preserve physical newline conventions', () => {
  const count = text => countSourceLines('example.ts', text, 'arktsTs', catalog);
  assert.deepEqual(count(''), lines(0, 0));
  assert.deepEqual(count(' \r\n\r\n'), lines(2, 0));
  assert.deepEqual(count('// comment\r\n\r/** doc\n * next\r\n */\nexport const value = 1; // tail'), lines(6, 1));
  assert.deepEqual(count('/* comment */ export {};\r/* unterminated\ncomment'), lines(3, 1));
  const script = [
    'const url = "https://example.test/*"; // tail',
    'const re = /[/*]/;',
    'const template = `// template text',
    '   ',
    '/* still template text */',
    '${',
    '  // interpolation comment',
    '  1',
    '}`;',
  ].join('\n');
  assert.deepEqual(count(script), lines(9, 7));
  assert.deepEqual(countSourceLines('example.jsx',
    '// comment\nconst element = <View>\n  {/* JSX comment */}\n  // JSX text\n</View>;\n',
    'rnohBusinessJs', catalog), lines(5, 3));
});

test('native code recognizes block comments, continuations, literals and digit separators', () => {
  const source = [
    '/* block comment',
    ' */ #include <stdio.h>',
    'const char* url = "https://example.test/*";',
    "const int n = 1'000; /* multi-line comment",
    'still a comment */',
    'const auto raw = u8R"xyz(/* literal',
    '   ',
    '// literal',
    ')xyz"; // tail',
    '// continued comment \\',
    'still comment',
    '/* unterminated',
    'comment',
  ].join('\r\n');
  assert.deepEqual(countSourceLines('example.cpp', source, 'cpp'), lines(13, 6));
});

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

test('statistics follow the physical scan scope and partition module and RNOH totals', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'harmony-code-size-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harmony = path.join(root, 'harmony'), entry = path.join(harmony, 'entry');
  const library = path.join(root, 'packages', 'library'), nested = path.join(library, 'nested');
  for (const [name, moduleRoot] of [['entry', entry], ['library', library], ['nested', nested]]) {
    await put(path.join(moduleRoot, 'src', 'main', 'module.json5'), JSON.stringify({ module: { name, type: 'har' } }));
  }
  const alias = path.join(harmony, 'library alias');
  await symlink(library, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await put(path.join(harmony, 'build-profile.json5'), JSON.stringify({
    app: { products: [{ name: 'default' }] },
    modules: [
      { name: 'entry', srcPath: path.relative(harmony, entry) },
      { name: 'library', srcPath: path.relative(harmony, alias) },
      { name: 'nested', srcPath: path.relative(harmony, nested) },
    ],
  }));
  await put(path.join(root, 'package.json'), '{"dependencies":{"@react-native-oh/react-native-harmony":"0.84.5"}}');
  await put(path.join(harmony, 'oh-package.json5'), '{dependencies:{"@rnoh/react-native-openharmony":"0.84.5"}}');
  await put(path.join(harmony, 'Shared.ts'), 'export {};');
  await put(path.join(entry, 'src', 'main', 'Index.ets'), '// entry\nexport {};\n');
  await put(path.join(library, 'src', 'main', 'Index.ts'), '// library\nexport {};\n');
  await put(path.join(library, 'src', 'main', 'native.HPP'), '/* header */\nvoid api();\n');
  await put(path.join(nested, 'src', 'main', 'Index.ts'), 'export {};\n\n');
  await put(path.join(root, 'src', 'App.tsx'), '// app\nexport {};\n');
  const excluded = path.join(library, 'src', 'main', 'ignore');
  for (const directory of [excluded, ...['node_modules', 'oh_modules', 'build', 'dist', 'coverage', 'test', 'ohosTest',
    'tests', '__tests__', '__mocks__'].flatMap(name => [path.join(library, name), path.join(root, name)])]) {
    await put(path.join(directory, 'Extra.ts'), 'unexpected();\n');
  }
  const measure = async (scanDirs, scanModules, projectType) => {
    const args = [harmony, 'default', scanDirs, scanModules, projectType];
    const project = await loadProject(...args, { excludeDirs: [excluded] });
    const metrics = createCodeSize(project, catalog);
    const snapshot = await loadProject(...args, { excludeDirs: [excluded], onSourceSnapshotFile: metrics.addHarmony });
    assert.equal(snapshot.sourceSnapshot, project.sourceSnapshot);
    const rnoh = await scanRnohImpacts({ project, officialEntries: [] });
    await metrics.addRnoh(rnoh);
    return { codeSize: metrics.result(), rnoh };
  };
  const { codeSize } = await measure([], [], 'app');
  assert.deepEqual(codeSize.total, lines(11, 6));
  assert.deepEqual(codeSize.byLanguage, { arktsTs: lines(7, 4), cpp: lines(2, 1), rnohBusinessJs: lines(2, 1) });
  const group = name => codeSize.byModule.find(item => item.moduleName === name);
  assert.deepEqual(group('entry').total, lines(2, 1));
  assert.deepEqual(group('nested').total, lines(2, 1));
  assert.deepEqual(group('library').byLanguage, { arktsTs: lines(2, 1), cpp: lines(2, 1) });
  assert.deepEqual(codeSize.byModule.filter(item => item.moduleName === null).map(item => [item.sourceRoot, item.total]),
    [['.', lines(1, 1)], ['..', lines(2, 1)]]);

  const narrowed = await measure([path.join(alias, 'src', 'main'), entry], ['library'], 'har');
  assert.equal(narrowed.rnoh.summary.status, 'SKIPPED_RESTRICTED_SCOPE');
  assert.deepEqual(narrowed.codeSize, {
    total: lines(4, 2), byLanguage: { arktsTs: lines(2, 1), cpp: lines(2, 1) },
    byModule: [{ moduleName: 'library', sourceRoot: path.relative(harmony, library).split(path.sep).join('/'),
      total: lines(4, 2), byLanguage: { arktsTs: lines(2, 1), cpp: lines(2, 1) } }],
  });
});

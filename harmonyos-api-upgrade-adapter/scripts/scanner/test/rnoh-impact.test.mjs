import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { loadQueryCatalog, queryChanges } from '../../shared/platform/changelog-catalog.mjs';
import { bindRnohRules, codeLines, detectRnohProject, isRnohRuleId, loadRnohRules, scanRnohImpacts } from '../rnoh/rnoh.mjs';

const skillRoot = fileURLToPath(new URL('../../../', import.meta.url));
const catalog = await loadQueryCatalog(path.join(skillRoot, 'references', 'changelogs'));
const entriesFor = (from, to) => queryChanges(catalog, { from, to }).entries.map(entry => ({ ...entry, sourceReference: `${entry.document}:${entry.startLine}` }));

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(t, { rnoh = true, debug = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rnoh-impact-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harmony = path.join(root, 'harmony');
  await put(path.join(harmony, 'oh-package.json5'), rnoh ? '{dependencies:{"@rnoh/react-native-openharmony":"0.84.5"}}' : '{dependencies:{}}');
  const host = path.join(harmony, 'entry', 'src', 'main', 'ets', 'Index.ets');
  await put(host, 'struct Index {\n  build() { RNApp({}) }\n}\n');
  if (rnoh) {
    const native = path.join(harmony, 'oh_modules', '.ohpm', '@rnoh+react-native-openharmony@0.84.5', 'oh_modules', '@rnoh', 'react-native-openharmony');
    await put(path.join(native, 'oh-package.json5'), '{name:"@rnoh/react-native-openharmony",version:"0.84.5"}');
    if (debug) {
      await put(path.join(native, 'src', 'main', 'cpp', 'ImageNode.cpp'), '// NODE_IMAGE_AUTO_RESIZE in comment\n/* NODE_IMAGE_AUTO_RESIZE\n */\nsetAttr(NODE_IMAGE_AUTO_RESIZE);\n');
      await put(path.join(native, 'src', 'main', 'cpp', 'third-party', 'Skip.cpp'), 'NODE_IMAGE_AUTO_RESIZE\n');
    } else await put(path.join(native, 'libs', 'arm64-v8a', 'librnoh.so'), 'binary');
    await put(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.84.0', '@react-native-oh/react-native-harmony': '0.84.5' } }));
    const js = path.join(root, 'node_modules', '@react-native-oh', 'react-native-harmony');
    await put(path.join(js, 'package.json'), JSON.stringify({ version: '0.84.5' }));
    await put(path.join(js, 'Libraries', 'Components', 'ScrollView', 'ScrollViewNativeComponentDelegate.harmony.ts'), 'export const config = {\n  validAttributes: {},\n};\n');
    await put(path.join(root, 'src', 'App.tsx'), 'export const App = () => <Image resizeMethod="resize" />;\n');
    await put(path.join(root, 'node_modules', 'other', 'index.js'), 'resizeMethod\n');
  }
  const project = { root: harmony, modules: [{ root: path.join(harmony, 'entry') }], sourceFiles: [host], sourceScope: {} };
  return { root, harmony, project };
}

test('bundled RNOH rules each bind to exactly one official changelog entry', async () => {
  const rules = await loadRnohRules();
  const { bound } = bindRnohRules(rules, entriesFor('5.0.0(12)', '26.0.0(26)'));
  assert.deepEqual(bound.map(item => item.rule.id).sort(), rules.map(rule => rule.id).sort());
  assert.ok(rules.every(rule => isRnohRuleId(`RNOH-${rule.id}`)));
});

test('non-RNOH projects produce no RNOH detection or findings', async t => {
  const { project } = await fixture(t, { rnoh: false });
  assert.equal(await detectRnohProject(project), null);
  assert.equal(await scanRnohImpacts({ project, officialEntries: entriesFor('5.0.0(12)', '26.0.0(26)') }), null);
});

test('RNOH scan lists only RN business JS rows and keeps framework source as read-only evidence', async t => {
  const { project } = await fixture(t);
  const result = await scanRnohImpacts({ project, officialEntries: entriesFor('5.0.0(12)', '26.0.0(26)') });
  assert.equal(result.summary.status, 'COMPLETE');
  assert.equal(result.summary.jsRoot, '..');
  assert.deepEqual(result.summary.coverage, { native: 'SCANNED', rnohJs: 'SCANNED', business: 'SCANNED', host: 'SCANNED' });
  assert.deepEqual(result.summary.gaps, []);
  const locations = result.findings.map(item => `${item['Rule ID']} ${item['Code Location']}`);
  assert.deepEqual(locations, ['RNOH-image-auto-resize-default ../src/App.tsx:1']);
  assert.ok(result.findings.every(item => item['Source Scope'] === 'business' && item.includedInCsv));
  const rule = id => result.summary.rules.find(item => item.ruleId === `RNOH-${id}`);
  assert.equal(rule('image-auto-resize-default').framework.status, 'CONFIRMED');
  assert.deepEqual(rule('image-auto-resize-default').framework.locations.map(item => item.location),
    ['oh_modules/.ohpm/@rnoh+react-native-openharmony@0.84.5/oh_modules/@rnoh/react-native-openharmony/src/main/cpp/ImageNode.cpp:4']);
  assert.equal(rule('page-exit-about-to-disappear').status, 'FRAMEWORK_ONLY');
  assert.equal(rule('shadow-blur-radius-zero').status, 'FRAMEWORK_NOT_AFFECTED');
  assert.equal(rule('scroll-back-to-top-default').status, 'FRAMEWORK_NOT_AFFECTED');
  // 无规则条目带上 Kit 和类别，供 U04a 按 Kit 成组过滤；已绑定 RNOH 规则的条目不在其中。
  assert.ok(result.summary.uncoveredEntries.length > 0);
  assert.ok(result.summary.uncoveredEntries.every(entry => entry.title && entry.kit && entry.category && entry.sourceReference));
  assert.ok(!result.summary.uncoveredEntries.some(entry => entry.title === rule('image-auto-resize-default').title));
});

test('test, spec, story and e2e files are not reported as business impact', async t => {
  const { root, project } = await fixture(t);
  const usage = 'export const A = () => <Image resizeMethod="resize" />;\n';
  for (const file of ['src/App.test.tsx', 'src/App.spec.ts', 'src/App.stories.tsx', 'e2e/flow.ts', 'tests/helper.js', 'src/__snapshots__/a.js'])
    await put(path.join(root, ...file.split('/')), usage);
  await put(path.join(root, 'src', 'latest.tsx'), usage);
  const result = await scanRnohImpacts({ project, officialEntries: entriesFor('5.0.0(12)', '26.0.0(26)') });
  assert.deepEqual(result.findings.map(item => item['Code Location']), ['../src/App.tsx:1', '../src/latest.tsx:1']);
});

test('business usage is not listed when the installed RNOH framework does not carry the change', async t => {
  const { root, project } = await fixture(t);
  await put(path.join(root, 'src', 'List.tsx'), 'export const L = () => <ScrollView />;\n');
  const result = await scanRnohImpacts({ project, officialEntries: entriesFor('5.0.0(12)', '26.0.0(26)') });
  assert.ok(!result.findings.some(item => item['Rule ID'] === 'RNOH-scroll-back-to-top-default'));
});

test('target intervals that skip a rule leave it unbound, and release HARs are reported as gaps', async t => {
  const { project } = await fixture(t, { debug: false });
  const result = await scanRnohImpacts({ project, officialEntries: entriesFor('20', '26.0.0(26)') });
  assert.equal(result.summary.coverage.native, 'RELEASE_BINARY');
  assert.match(result.summary.gaps.join('\n'), /预编译产物/);
  assert.equal(result.summary.rules.find(item => item.ruleId === 'RNOH-image-auto-resize-default').framework.status, 'UNVERIFIED');
  assert.ok(!result.findings.some(item => item['Rule ID'] === 'RNOH-scroll-back-to-top-default'));
  assert.ok(result.findings.some(item => item['Rule ID'] === 'RNOH-image-auto-resize-default'));
});

test('restricted HAR or module scans skip RNOH layers explicitly', async t => {
  const { project } = await fixture(t);
  project.sourceScope = { scanModules: ['entry'] };
  const result = await scanRnohImpacts({ project, officialEntries: entriesFor('5.0.0(12)', '26.0.0(26)') });
  assert.equal(result.summary.status, 'SKIPPED_RESTRICTED_SCOPE');
  assert.deepEqual(result.findings, []);
});

test('codeLines blanks comments but keeps line numbers', () => {
  assert.deepEqual(codeLines('a\n// b\n/* c\nd */ e\n'), ['a', '', '', ' e', '']);
});

test('RN JS project beside the harmony project is found; unsearched business JS is never reported as no match', async t => {
  const { root, project } = await fixture(t), entries = entriesFor('5.0.0(12)', '26.0.0(26)');
  await rm(path.join(root, 'package.json')); await rm(path.join(root, 'src'), { recursive: true });
  const status = (result, id) => result.summary.rules.find(item => item.ruleId === `RNOH-${id}`).status;
  // 没有 JS 工程：有业务写法的规则标为未检索，缺口提示可用的参数。
  const missing = await scanRnohImpacts({ project, officialEntries: entries });
  assert.deepEqual([missing.summary.jsRoot, missing.summary.coverage.business, missing.findings.length], [null, 'JS_PROJECT_NOT_FOUND', 0]);
  assert.equal(status(missing, 'image-auto-resize-default'), 'BUSINESS_NOT_SCANNED');
  assert.equal(status(missing, 'page-exit-about-to-disappear'), 'FRAMEWORK_ONLY');
  assert.ok(!missing.summary.rules.some(rule => rule.status === 'NO_MATCH'));
  assert.ok(missing.summary.gaps.some(gap => /未找到 RN JS 工程[\s\S]*--rn-js-root/.test(gap)));
  // harmony 工程与 JS 工程平级放置，JS 工程未声明 RNOH JS 包：按 react-native 依赖和 metro 配置识别。
  const app = path.join(root, 'SampleProject', 'MainProject');
  await put(path.join(app, 'package.json'), JSON.stringify({ name: 'SampleProject', dependencies: { 'react-native': '0.72.5' } }));
  await put(path.join(app, 'metro.config.js'), 'module.exports = {};\n');
  await put(path.join(app, 'src', 'App.tsx'), 'export const App = () => <Image resizeMethod="resize" />;\n');
  await put(path.join(root, 'SampleProject', 'react-native-harmony', 'package.json'),
    JSON.stringify({ name: '@react-native-oh/react-native-harmony', devDependencies: { 'react-native': '0.72.5' } }));
  await put(path.join(root, 'tools', 'package.json'), JSON.stringify({ devDependencies: { 'react-native': '0.72.5' } }));
  const found = await scanRnohImpacts({ project, officialEntries: entries });
  assert.equal(found.summary.jsRoot, '../SampleProject/MainProject');
  assert.deepEqual([found.summary.js.packageName, found.summary.js.reactNativeVersion, found.summary.coverage.business], [null, '0.72.5', 'SCANNED']);
  assert.deepEqual(found.findings.map(item => item['Code Location']), ['../SampleProject/MainProject/src/App.tsx:1']);
  assert.equal(status(found, 'image-auto-resize-default'), 'MATCHED');
  // 候选不唯一时不猜：列出候选，由 --rn-js-root 指定。
  const other = path.join(root, 'Another');
  await put(path.join(other, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.72.5' } }));
  await put(path.join(other, 'app.json'), '{}');
  const ambiguous = await scanRnohImpacts({ project, officialEntries: entries });
  assert.equal(ambiguous.summary.jsRoot, null);
  assert.ok(ambiguous.summary.gaps.some(gap => /找到多个可能的 RN JS 工程（\.\.\/Another、\.\.\/SampleProject\/MainProject）[\s\S]*--rn-js-root/.test(gap)));
  const chosen = await scanRnohImpacts({ project: { ...project, rnJsRoot: app }, officialEntries: entries });
  assert.equal(chosen.summary.jsRoot, '../SampleProject/MainProject');
  await assert.rejects(scanRnohImpacts({ project: { ...project, rnJsRoot: path.join(root, 'tools', 'none') }, officialEntries: entries }), /--rn-js-root 指向的目录不是 RN JS 工程/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { discoverDevEco, validateTargetCoverage } from '../core/deveco.mjs';
import { execute } from '../core/cli.mjs';
import { buildSdkCatalog } from '../core/sdk-deprecations.mjs';
import { compileRules, loadDevEcoRules } from '../core/rules.mjs';
import { assertUpgradeRange, parseVersion } from '../../shared/platform/version.mjs';
import { DEPRECATED_HEADERS, parseCsv, UPGRADE_HEADERS } from '../../shared/format/csv.mjs';
import { readTask } from '../../shared/platform/task-context.mjs';

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const fileName = Buffer.from(name);
    const content = Buffer.from(value);
    const compressed = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    locals.push(local, fileName, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24); central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

async function fixture({ scannerName = 'api-change-scan.js', scannerSource = '--startVersion --endVersion --modulePaths --sdkPath --apiModifiedPath --outputPath', resourceMode = 'directory', ideVersion = '26.0.0.821',
  sdkData = { platformVersion: '26.0.0', apiVersion: '26', releaseType: 'Release' }, archiveRules = [] } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'scanner-windows-home-')));
  const home = path.join(root, 'DevEco Studio');
  const sdk = path.join(root, 'Harmony SDK');
  const files = [
    [path.join(sdk, 'default/sdk-pkg.json'), JSON.stringify({ data: sdkData })],
    [path.join(home, 'product-info.json'), JSON.stringify({ name: 'DevEco Studio', version: ideVersion })],
    [path.join(sdk, 'default/openharmony/ets/build-tools/ets-loader/node_modules/typescript/lib/typescript.js'), 'parser'],
    [path.join(sdk, 'default/hms/ets/api/@hms.test.d.ts'), 'export {};'],
    [path.join(home, `plugins/harmony/arkanalyzer-apiscan/${scannerName}`), scannerSource],
    [path.join(home, 'jbr/bin/java.exe'), 'java'],
    [path.join(home, 'tools/hvigor/bin/hvigorw.bat'), 'hvigor'],
    [path.join(home, 'tools/ohpm/bin/ohpm.cmd'), 'ohpm'],
  ];
  for (const [file, content] of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  if (['directory', 'mixed', 'modern-directory'].includes(resourceMode)) {
    const resource = path.join(home,
      `plugins/harmony/arkanalyzer-apiscan/resources/apiChange/${resourceMode === 'directory'
        ? 'HarmonyOS_26.0.0(26)_Release.json' : 'HarmonyOS_26.0.0_Release.json'}`);
    await mkdir(path.dirname(resource), { recursive: true });
    await writeFile(resource, '[]');
  }
  if (resourceMode === 'jar' || resourceMode === 'mixed') {
    const archive = path.join(home, 'plugins/harmony/lib/project-api-change-assistant-26.0.0.361.jar');
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, zip([
      ['apiChange/HarmonyOS_26.0.0(26)_Beta1.json', '[]'],
      ['apiChange/HarmonyOS_26.0.0(26)_Release.json', resourceMode === 'mixed' ? 'invalid duplicate' : '[]'],
      ...archiveRules,
    ]));
  }
  return { root, home, sdk };
}

test('upgrade excludes only the proven Stage entry before invoking DevEco', async t => {
  const { root, home, sdk } = await fixture({
    resourceMode: 'modern-directory',
    ideVersion: '26.0.1.411',
    sdkData: { platformVersion: '26.0.1', apiVersion: '26', releaseType: 'Release' },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const rnRoot = path.join(root, 'rn');
  const project = path.join(rnRoot, 'harmony');
  const alias = path.join(root, 'project-alias');
  const analyzer = path.join(home, 'plugins', 'harmony', 'arkanalyzer-apiscan');
  const pack = path.join(analyzer, 'resources', 'apiChange');
  const received = path.join(analyzer, 'received.json');
  const stageId = 'CH2026010615012';
  const beta = '26.0.0(26) Beta1';
  const release = '26.0.0(26) Release';
  const typeScript = createRequire(import.meta.url).resolve('typescript');
  const loader = path.join(sdk, 'default', 'openharmony', 'ets', 'build-tools', 'ets-loader');
  await writeFile(path.join(loader, 'node_modules', 'typescript', 'lib', 'typescript.js'), `
    const ts = require(${JSON.stringify(typeScript)});
    module.exports = { ...ts, ScriptKind: { ...ts.ScriptKind, ETS: ts.ScriptKind.TS },
      isStructDeclaration: () => false, isEtsComponentExpression: () => false };
  `);
  await writeFile(path.join(loader, 'tsconfig.json'), '{"compilerOptions":{"lib":["es2020"]}}');

  const api = name => ({ implementLanguage: 'typeScript', completePath: 'component/test.d.ts',
    className: 'Test', interfaceType: 'method', interfaceName: name, methodDefinition: `${name}(): void` });
  const entry = (id, sdkVersion, changeTitle, changeType, affectedApis) => ({
    interfaceChanges: { id, sdkVersion, changeTitle, changeType, apiEffectiveVersion: 'NOT_ISOLATED' },
    affectedApis,
  });
  const shared = api('shared');
  const stage = entry(stageId, '7.0.0(26) Beta1', 'ArkUI接口新增仅支持Stage模型的约束', '接口定义变更',
    [shared, api('stageOnly')]);
  const resource = entry(383, '6.0.0(20) Beta1', '文本与输入、信息展示、按钮与选择、滚动与滑动、图形绘制组件接口支持Resource类型',
    '接口行为变更', [shared]);
  const other = entry('CH2026031846233', beta, '表单类组件触摸热区最小高度变更', 'UX交互行为变更', [api('other')]);
  await writeFile(path.join(pack, 'HarmonyOS_26.0.0(26)_Beta1.json'), JSON.stringify([stage, other]));
  await writeFile(path.join(pack, 'HarmonyOS_6.0.0(20)_Beta1.json'), JSON.stringify([resource]));
  for (const name of ['HarmonyOS_26.0.1_Beta1.json', 'HarmonyOS_26.0.1_Release.json', 'HarmonyOS_26.1.0_Beta1.json']) {
    await writeFile(path.join(pack, name), '[]');
  }
  await writeFile(path.join(pack, 'HarmonyOS_26.1.0_Release.json'), JSON.stringify([
    entry('future', '26.1.0 Release', '未来版本变更', '接口行为变更', [api('futureApi')]),
  ]));

  const faConfig = path.join(project, 'entry', 'src', 'main', 'config.json');
  const mutate = path.join(analyzer, 'mutate');
  await writeFile(path.join(analyzer, 'api-change-scan.js'), `
    // --startVersion --endVersion --modulePaths --sdkPath --apiModifiedPath --outputPath
    const { existsSync, readFileSync, writeFileSync } = require('node:fs');
    const path = require('node:path');
    const get = flag => process.argv[process.argv.indexOf(flag) + 1];
    const changes = JSON.parse(readFileSync(get('--apiModifiedPath'), 'utf8'));
    writeFileSync(${JSON.stringify(received)}, JSON.stringify(changes));
    if (existsSync(${JSON.stringify(mutate)})) writeFileSync(${JSON.stringify(faConfig)}, '{}');
    const header = 'Api Definition,Language,Changed in SDK,Affected Versions,Title,Code Location,Fixed,Change Type,ChangeId';
    const rows = changes.map(item => 'api(): void,ArkTS,26.0.0(26),ALL,test,entry/src/main/ets/A.ets:1,Unfixed,API Behavior Change,' + item.interfaceChanges.id);
    writeFileSync(path.join(get('--outputPath'), 'report.csv'), [header, ...rows, ''].join('\\n'));
  `);

  await mkdir(path.join(project, 'AppScope'), { recursive: true });
  const appConfig = path.join(project, 'AppScope', 'app.json5');
  await writeFile(appConfig, '{app:{bundleName:"com.example.stage"}}');
  await writeFile(path.join(project, 'build-profile.json5'), JSON.stringify({
    app: { products: [{ name: 'default' }] }, modules: ['entry', 'library'].map(name => ({ name, srcPath: name })),
  }));
  for (const name of ['entry', 'library']) {
    const main = path.join(project, name, 'src', 'main');
    await mkdir(path.join(main, 'ets'), { recursive: true });
    await writeFile(path.join(main, 'module.json5'), JSON.stringify({ module: { name, type: name === 'entry' ? 'entry' : 'har' } }));
    await writeFile(path.join(main, 'ets', 'A.ets'), 'api();');
  }
  await symlink(project, alias, 'junction');

  async function scan(task, args = [], from = '5.1.1(19) Release', mode = 'upgrade') {
    return execute(['scan', '--task', task.taskFile, '--project', alias, '--sdk', sdk, '--deveco-home', home,
      '--from', from, '--to', release, '--mode', mode, ...args]);
  }
  const newTask = () => execute(['init-task', '--task-root', root, '--output-dir', path.join(root, 'output')]);
  const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
  const readInputNames = async () => (await readJson(received)).map(item => item.affectedApis[0].interfaceName).sort();
  const ruleInspection = await execute(['inspect-rules', '--sdk', sdk, '--deveco-home', home,
    '--from', '5.1.1(19) Release', '--to', '26', '--mode', 'upgrade']);
  assert.equal(ruleInspection.coverage.status, 'COMPLETE');
  assert.equal(ruleInspection.coverage.includedRuleCount, 3);
  assert.equal(ruleInspection.coverage.devecoVersionNames[release], 'HarmonyOS_26.0.0_Release');

  const stageScan = await scan(await newTask());
  assert.deepEqual(await readInputNames(), ['other', 'shared']);
  const csv = parseCsv(await readFile(stageScan.outputCsv, 'utf8'));
  assert.deepEqual(csv.headers, UPGRADE_HEADERS);
  assert.deepEqual(csv.rows.map(row => row['Rule ID']).sort(), ['383', other.interfaceChanges.id]);
  const scanJson = await readJson(stageScan.scanJson);
  const coverage = await readJson(stageScan.coverageJson);
  const indexSource = coverage.upgrade.sources.find(source => path.basename(source.file) === 'changelogs-index.json');
  assert.equal(path.basename(path.dirname(indexSource.file)), 'changelogs');
  assert.deepEqual(scanJson.codeSize.total, { physicalLines: 2, codeLines: 2 });
  assert.equal(Object.hasOwn(coverage, 'codeSize'), false);
  assert.equal(Object.hasOwn(await readJson(stageScan.diagnosticsJson), 'codeSize'), false);
  const status = scanJson.officialComparison.entries.find(item => item.ruleIds.includes(stageId));
  assert.equal(status.status, 'RULE_AVAILABLE');
  assert.equal(status.projectStatus, 'EXCLUDED_BY_PROJECT_APPLICABILITY');
  assert.ok(!scanJson.officialComparison.missing.some(item => item.id === status.id));
  assert.deepEqual(coverage.projectApplicability, scanJson.projectApplicability);
  assert.equal(coverage.includedRuleCount, 2);
  const [excluded] = scanJson.projectApplicability.excluded;
  assert.equal(scanJson.projectApplicability.excludedRuleCount, 1);
  assert.equal(excluded.ruleId, stageId);
  assert.equal(excluded.reason, 'STAGE_MODEL_CONFIRMED');
  assert.deepEqual(excluded.applicabilityProof.modules, ['entry', 'library']);
  assert.ok(excluded.applicabilityProof.configurations.some(input => input.file === appConfig));

  for (const [file, content] of [
    [faConfig, '{}'],
    [path.join(project, 'library', 'build-profile.json5'), '{apiType:"faMode"}'],
    [path.join(project, 'unknown.ets'), 'api();'],
    [path.join(project, 'entry', 'src', 'main', 'ets', 'nested', 'build-profile.json5'), '{}'],
  ]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    const nestedSource = path.basename(path.dirname(file)) === 'nested' ? path.join(path.dirname(file), 'Nested.ets') : null;
    if (nestedSource) await writeFile(nestedSource, 'api();');
    const result = await scan(await newTask());
    assert.equal((await readJson(result.scanJson)).projectApplicability.excludedRuleCount, 0);
    assert.deepEqual(await readInputNames(), ['other', 'shared', 'stageOnly']);
    await rm(file);
    if (nestedSource) await rm(nestedSource);
  }
  const har = await scan(await newTask(), ['--project-type', 'har', '--scan-module', 'library']);
  assert.equal((await readJson(har.scanJson)).projectApplicability.excludedRuleCount, 0);
  assert.deepEqual(await readInputNames(), ['other', 'shared', 'stageOnly']);

  await rm(received);
  await writeFile(path.join(project, 'oh-package.json5'), '{dependencies:{"@rnoh/react-native-openharmony":"0.84.5"}}');
  await writeFile(path.join(rnRoot, 'package.json'), '{"dependencies":{"@react-native-oh/react-native-harmony":"0.84.5"}}');
  await writeFile(path.join(rnRoot, 'App.jsx'), '// RN app\nexport default <View />;\n');
  const outside = await scan(await newTask(), [], beta);
  const outsideJson = await readJson(outside.scanJson);
  assert.equal(outsideJson.projectApplicability.excludedRuleCount, 0);
  assert.deepEqual(outsideJson.findings, []);
  assert.deepEqual(outsideJson.codeSize.byLanguage.rnohBusinessJs, { physicalLines: 2, codeLines: 1 });
  assert.deepEqual(outsideJson.codeSize.total, { physicalLines: 4, codeLines: 3 });
  await assert.rejects(readFile(received), { code: 'ENOENT' });

  const customReferences = path.join(root, 'custom-changelogs');
  await cp(path.dirname(indexSource.file), customReferences, { recursive: true });
  const customIndex = await readJson(path.join(customReferences, 'changelogs-index.json'));
  const unrelatedDoc = customIndex.documents.find(document => document.path.startsWith('5.0.1(13)/'));
  const documentFile = path.join(customReferences, unrelatedDoc.path);
  await writeFile(documentFile, (await readFile(documentFile, 'utf8')) + '\n正文被修改。\n');
  const customArgs = ['--references', customReferences];
  await assert.rejects(scan(await newTask(), customArgs), /官方正文哈希不一致/);
  await rm(documentFile);
  await assert.rejects(scan(await newTask(), customArgs), { code: 'ENOENT', stage: 'COMPARE_OFFICIAL_CHANGELOG' });

  const missingReferences = ['--references', path.join(root, 'missing-changelogs')];
  const inspection = await execute(['inspect-rules', '--sdk', sdk, '--deveco-home', home,
    '--from', beta, '--to', release, '--mode', 'deprecated', ...missingReferences]);
  assert.equal(inspection.coverage.status, 'COMPLETE');

  const sdkApi = path.join(sdk, 'default', 'openharmony', 'ets', 'api');
  await mkdir(sdkApi, { recursive: true });
  await writeFile(path.join(sdkApi, '@ohos.test.d.ts'),
    '/**\n * @deprecated since 15\n * @useinstead replacement\n */\nexport declare function old(): void;');
  const editedSource = path.join(project, 'entry', 'src', 'main', 'ets', 'A.ets');
  await writeFile(editedSource, 'import { old } from "@ohos.test";\nold();');
  const deprecatedTask = await newTask();
  const initial = await scan(deprecatedTask, missingReferences, beta, 'deprecated');
  const initialJson = await readJson(initial.scanJson);
  assert.deepEqual(initialJson.codeSize.total, { physicalLines: 3, codeLines: 3 });
  assert.deepEqual(initialJson.findings.map(finding => finding['Code Location']),
    ['entry/src/main/ets/A.ets:1', 'entry/src/main/ets/A.ets:2']);
  for (const finding of initialJson.findings) {
    assert.equal(finding['Detection Source'], 'SDK_STATE');
    assert.equal(finding['Replacement API'], 'replacement');
  }
  assert.equal(Object.hasOwn(await readJson(initial.coverageJson), 'behaviorPolicy'), false);
  assert.equal(Object.hasOwn(initialJson.codeSize.byLanguage, 'rnohBusinessJs'), false);
  const deprecatedCsv = parseCsv(await readFile(initial.outputCsv, 'utf8'));
  assert.deepEqual(deprecatedCsv.headers, DEPRECATED_HEADERS);
  assert.deepEqual(deprecatedCsv.rows.map(row => row.Title), ['old：API 废弃', 'old：API 废弃']);
  await writeFile(editedSource, '// added comment\napi();\n\n');
  const rescan = await scan(deprecatedTask, [...missingReferences, '--scan-purpose', 'rescan'], beta, 'deprecated');
  const rescanJson = await readJson(rescan.scanJson);
  assert.deepEqual(rescanJson.codeSize.total, { physicalLines: 4, codeLines: 2 });
  assert.deepEqual(rescanJson.findings, []);
  assert.deepEqual((await readJson(initial.scanJson)).codeSize, initialJson.codeSize);
  await writeFile(editedSource, 'api();');

  await writeFile(mutate, '');
  const task = await newTask();
  await assert.rejects(scan(task), { code: 'SOURCE_CHANGED_DURING_SCAN', stage: 'VERIFY_PROJECT_RULE_APPLICABILITY', details: [faConfig] });
  const state = await readTask(task.taskFile);
  const [attempt] = state.participants[0].attempts;
  assert.equal(attempt.status, 'FAILED');
  assert.equal((await readJson(attempt.diagnosticsPath)).status, 'FAILED');
  assert.equal(state.participants[0].initialBatchId, null);
});

test('discovers the Windows analyzer when the SDK and DevEco home are separate', async () => {
  const { home, sdk } = await fixture();
  const result = await discoverDevEco(sdk, home, { platform: 'win32', env: {} });
  assert.equal(result.contentsRoot, path.resolve(home));
  assert.equal(result.ohpm,path.join(home,'tools/ohpm/bin/ohpm.cmd'));
  assert.equal(result.sdkRoot, path.resolve(sdk));
  assert.equal(result.java, path.join(home, 'jbr/bin/java.exe'));
  assert.equal(result.hvigorw, path.join(home, 'tools/hvigor/bin/hvigorw.bat'));
  assert.equal(result.apiChangeBackend, 'integrated');
  assert.equal(result.projectApiChangeJar, null);
});

test('detects a renamed integrated scanner by its CLI contract', async () => {
  const { home, sdk } = await fixture({ scannerName: 'windows-api-compatibility.js' });
  const result = await discoverDevEco(sdk, home, { platform: 'win32', env: {} });
  assert.equal(result.apiChangeBackend, 'integrated');
  assert.equal(result.apiChangeScan, path.join(home, 'plugins/harmony/arkanalyzer-apiscan/windows-api-compatibility.js'));
});

test('detects the index backend without treating it as the integrated CLI', async () => {
  const { home, sdk } = await fixture({
    scannerName: 'index.js',
    scannerSource: '--startVersion --endVersion --modulePaths --sdkPath --outputPath '
      + '--configPath --scanFilePaths --apiModifiedPath --outPath --tmpPath '
      + '__webpack_require__.s = "./src/collector/api/MainSrc.ts"',
  });
  const result = await discoverDevEco(sdk, home, { platform: 'win32', env: {} });
  assert.equal(result.apiChangeBackend, 'index');
  assert.equal(result.apiChangeScan, path.join(home, 'plugins/harmony/arkanalyzer-apiscan/index.js'));
  assert.equal(result.cApiScanJar, null);
});

test('index family markers do not imply scanFilePaths support; help overrides incidental source strings',async()=>{
  const scannerSource=`// __webpack_require__.s = "./src/collector/api/MainSrc.ts"
if(process.argv.includes('--help'))console.log('Usage: index --configPath --apiModifiedPath --outPath --tmpPath');
else if(process.argv.includes('--scanFilePaths'))throw new Error('unknown option');`;
  const {sdk,home}=await fixture({scannerSource});
  const result=await discoverDevEco(sdk,home,{platform:'win32',env:{}});
  assert.equal(result.apiChangeBackend,'index');assert.equal(result.fileScanSupported,false);
  assert.equal(result.moduleScanSupported,true);
});

test('reports unsupported layouts with inspected scanner candidates', async () => {
  const { home, sdk } = await fixture({ scannerName: 'windows-scan.js', scannerSource: '--unknown-option' });
  await assert.rejects(discoverDevEco(sdk, home, { platform: 'win32', env: {} }), error => {
    assert.equal(error.code, 'UNSUPPORTED_DEVECO_SCANNER_LAYOUT');
    assert.ok(error.details.scannerCandidates.some(candidate => candidate.file.endsWith('windows-scan.js')));
    assert.equal(error.details.scannerCandidates.at(-1).contract, 'unknown');
    return true;
  });
});

test('probes help output when a bundle contains both CLI marker sets', async () => {
  const markers = [
    '--startVersion', '--endVersion', '--modulePaths', '--sdkPath', '--apiModifiedPath', '--outputPath',
    '--configPath', '--scanFilePaths', '--outPath', '--tmpPath',
  ].join(' ');
  const { home, sdk } = await fixture({
    scannerName: 'windows-bundle.js',
    scannerSource: `// ${markers}\nif (process.argv.includes('--help')) console.log('--configPath --scanFilePaths --apiModifiedPath --outPath --tmpPath');\n`,
  });
  const result = await discoverDevEco(sdk, home, { platform: 'win32', env: {} });
  assert.equal(result.apiChangeBackend, 'index');
});

test('uses API change rules packaged only inside the project assistant JAR', async () => {
  const { root, home, sdk } = await fixture({
    scannerName: 'index.js',
    scannerSource: '__webpack_require__.s = "./src/collector/api/MainSrc.ts"',
    resourceMode: 'jar',
  });
  const result = await discoverDevEco(sdk, home, { platform: 'win32', env: {} });
  assert.equal(result.apiChangeResourceRoot, null);
  assert.match(result.apiChangeResourceArchive, /project-api-change-assistant-26\.0\.0\.361\.jar$/);
  const referenceRoot = path.join(root, 'references');
  await mkdir(referenceRoot);
  const rules = await loadDevEcoRules(result, referenceRoot,
    assertUpgradeRange('5.0.0(12)', '26.0.0(26) Beta1'), 'upgrade');
  assert.deepEqual(rules.errors, []);
});

test('fills missing directory rule versions from the project assistant JAR', async () => {
  const { root, home, sdk } = await fixture({ resourceMode: 'mixed' });
  const result = await discoverDevEco(sdk, home, { platform: 'win32', env: {} });
  assert.match(result.apiChangeResourceRoot, /resources[/\\]apiChange$/);
  assert.match(result.apiChangeResourceArchive, /project-api-change-assistant-26\.0\.0\.361\.jar$/);
  const referenceRoot = path.join(root, 'references');
  await mkdir(referenceRoot);
  const rules = await loadDevEcoRules(result, referenceRoot,
    assertUpgradeRange('5.0.0(12)', '26.0.0(26) Release'), 'upgrade');
  assert.deepEqual(rules.errors, []);
  assert.equal(rules.versionNames['26.0.0(26) Release'], 'HarmonyOS_26.0.0_Release');
});

test('accepts API 26 rule names without a repeated API level', async () => {
  const { root, home, sdk } = await fixture({ resourceMode: 'modern-directory' });
  const result = await discoverDevEco(sdk, home, { platform: 'win32', env: {} });
  const referenceRoot = path.join(root, 'references');
  await mkdir(referenceRoot);
  const rules = await loadDevEcoRules(result, referenceRoot,
    assertUpgradeRange('5.0.0(12)', '26.0.0(26) Release'), 'upgrade');
  assert.deepEqual(rules.errors, []);
});

test('newer DevEco archives retain API 26 coverage with nonempty future rules', async t => {
  const futureRule = JSON.stringify([{
    interfaceChanges: { id: 'future', changeType: '接口废弃变更', apiEffectiveVersion: 'NOT_ISOLATED' },
    affectedApis: [{ implementLanguage: 'c', interfaceName: 'futureApi' }],
  }]);
  const range = assertUpgradeRange('5.0.0(12)', '26.0.0(26) Release');
  for (const [ideVersion, platformVersion, apiVersion, resourceMode] of [
    ['26.1.0', '26.1.0', '26', 'jar'],
    ['27.0.0', '27.0.0', '27', 'mixed'],
    ['28.10.0.200', '28.10.0', '28', 'jar'],
  ]) {
    const { root, home, sdk } = await fixture({
      ideVersion, resourceMode,
      sdkData: { platformVersion, apiVersion, releaseType: 'Release' },
      archiveRules: [
        [path.posix.join('apiChange', `HarmonyOS_${platformVersion}_Beta1.json`), futureRule],
        [path.posix.join('apiChange', `HarmonyOS_${platformVersion}_Release.json`), '[]'],
      ],
    });
    t.after(() => rm(root, { recursive: true, force: true }));
    const toolchain = await discoverDevEco(sdk, home, { targetVersion: '26' });
    validateTargetCoverage(toolchain, range.end);
    const { rules, coverage, ruleInventory } = await compileRules({ toolchain, range, mode: 'deprecated' });
    assert.equal(coverage.status, 'COMPLETE', ideVersion);
    assert.deepEqual(rules, []);
    assert.deepEqual(ruleInventory, []);
    assert.equal(coverage.devecoVersionNames['26.0.0(26) Release'],
      resourceMode === 'mixed' ? 'HarmonyOS_26.0.0_Release' : 'HarmonyOS_26.0.0(26)_Release');
  }
});

test('later rule resources do not hide a missing target or malformed in-range rules', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-rule-range-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'HarmonyOS_26.0.0(26)_Release.json');
  const check = (to = '26.0.0(26) Release') => compileRules({
    toolchain: { apiChangeResourceRoot: root },
    range: assertUpgradeRange('5.0.0(12)', to),
    mode: 'deprecated',
  });
  await writeFile(path.join(root, 'HarmonyOS_26.0.0(26)_Beta2.json'), '[]');
  const unknownLevel = path.join(root, 'HarmonyOS_26.0.1_Beta1.json');
  await writeFile(unknownLevel, '[]');
  await assert.rejects(check, {
    code: 'INCOMPLETE_RULE_COVERAGE',
    details: [{ sourceReference: root, message: 'DevEco rule pack does not cover target HarmonyOS_26.0.0(26)_Release' }],
  });

  await writeFile(target, '[]');
  const unknown = path.join(root, 'HarmonyOS_27.0.0_Preview.json');
  await writeFile(unknown, '[]');
  await assert.rejects(check, { code: 'INCOMPLETE_RULE_COVERAGE',
    details: [{ sourceReference: unknown, message: 'Unsupported SDK version: HarmonyOS_27.0.0_Preview' }] });
  await rm(unknown);

  await writeFile(target, '{');
  await assert.rejects(check, SyntaxError);
  await writeFile(target, '[]');

  const nextTarget = path.join(root, 'HarmonyOS_26.0.1(26)_Release.json');
  await writeFile(nextTarget, '[]');
  await assert.rejects(() => check('26.0.1(26) Release'), { code: 'INCOMPLETE_RULE_COVERAGE',
    details: [{ sourceReference: unknownLevel,
      message: 'SDK API level is required for unknown version: HarmonyOS_26.0.1_Beta1' }] });
});

test('a recognized newer target loads its rules while comparing later platforms numerically', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-rule-next-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'HarmonyOS_26.2.0(26)_Release.json'), JSON.stringify([{
    interfaceChanges: { id: 'new-target', changeType: '接口废弃变更', apiEffectiveVersion: 'NOT_ISOLATED' },
    affectedApis: [{ implementLanguage: 'c', interfaceName: 'newTargetApi' }],
  }]));
  await writeFile(path.join(root, 'HarmonyOS_26.10.0_Beta1.json'), '[]');
  const { rules, coverage } = await compileRules({
    toolchain: { apiChangeResourceRoot: root },
    range: assertUpgradeRange('26.0.0(26) Release', '26.2.0(26) Release'),
    mode: 'deprecated',
  });
  assert.equal(coverage.status, 'COMPLETE');
  assert.deepEqual(rules.map(rule => [rule.ruleId, rule.changedInSdk]), [['new-target', '26.2.0(26) Release']]);
});

test('newer SDK covers an older target while a real parser remains required', async t => {
  const historical = await fixture({ sdkData: { platformVersion: '6.1.1', apiVersion: '24', releaseType: 'Release' } });
  t.after(() => rm(historical.root, { recursive: true, force: true }));
  const toolchain = await discoverDevEco(historical.sdk, historical.home, { targetVersion: '24' });
  assert.equal(toolchain.devecoCompatibility.status, 'COMPATIBLE');
  assert.equal(toolchain.devecoCompatibility.requiredVersion, '6.1.1');
  assert.doesNotThrow(() => validateTargetCoverage(toolchain, parseVersion('24')));
  const newer = await fixture();
  t.after(() => rm(newer.root, { recursive: true, force: true }));
  const substituted = await discoverDevEco(newer.sdk, newer.home, { targetVersion: '24' });
  assert.doesNotThrow(()=>validateTargetCoverage(substituted,parseVersion('24')));
  await assert.rejects(buildSdkCatalog(substituted, parseVersion('24')), { code: 'ARKTS_PARSER_UNAVAILABLE' });
});

test('a historical IDE is accepted for its matching target instead of requiring IDE 26', async t => {
  const { root, home, sdk } = await fixture({ ideVersion: '6.1.1.280',
    sdkData: { platformVersion: '6.1.1', apiVersion: '24', releaseType: 'Release' } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolchain = await discoverDevEco(sdk, home, { targetVersion: '6.1.1(24)' });
  assert.equal(toolchain.devecoCompatibility.status, 'COMPATIBLE');
  validateTargetCoverage(toolchain, parseVersion('24'));
});

test('missing and damaged product metadata block discovery with environment repair guidance', async t => {
  const { root, home, sdk } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = path.join(home, 'product-info.json');
  await rm(metadata);
  await assert.rejects(discoverDevEco(sdk, home), { code: 'DEVECO_VERSION_UNRESOLVED' });
  await writeFile(metadata, '{broken');
  await assert.rejects(discoverDevEco(sdk, home), error => {
    assert.equal(error.code, 'DEVECO_VERSION_UNRESOLVED');
    assert.equal(error.details.metadataPath, metadata);
    return true;
  });
});

test('both scan modes and rule inspection reject old or unknown IDEs before probing the backend', async t => {
  for (const [ideVersion, code] of [['6.1.1.280', 'DEVECO_TARGET_NOT_COVERED'], ['invalid', 'DEVECO_VERSION_UNRESOLVED']]) {
    const { root, home, sdk } = await fixture({ ideVersion,
      sdkData: { platformVersion: '6.1.1', apiVersion: '24', releaseType: 'Release' }, scannerSource:
      '// --startVersion --endVersion --modulePaths --sdkPath --apiModifiedPath --outputPath --configPath --scanFilePaths --outPath --tmpPath\n'
      + 'require("node:fs").writeFileSync(require("node:path").join(__dirname, "backend-started"), "started");\n' });
    t.after(() => rm(root, { recursive: true, force: true }));
    const output = path.join(root, 'output');
    const task=await execute(['init-task','--task-root',root,'--output-dir',output]);
    for (const mode of ['upgrade', 'deprecated']) {
      await assert.rejects(execute(['scan', '--task',task.taskFile,'--project', path.join(root, 'project'), '--sdk', sdk, '--deveco-home', home,
        '--from', '13', '--to', '26', '--mode', mode, '--output-dir', output]), { code, stage: 'VALIDATE_DEVECO_VERSION' });
    }
    let inspectionMessage;
    await assert.rejects(execute(['inspect-rules', '--mode', 'upgrade', '--sdk', sdk, '--deveco-home', home, '--from', '13', '--to', '26']), error => {
      assert.equal(error.code, code);
      inspectionMessage = error.message;
      return true;
    });
    const directories=(await readdir(output)).filter(name=>/^\d{14}(?:-\d+)?$/.test(name));
    assert.equal(directories.length,1);
    const {readTask}=await import('../../shared/platform/task-context.mjs');
    const state=await readTask(task.taskFile);
    for (const project of state.participants) {
      const diagnostics = JSON.parse(await readFile(project.attempts[0].diagnosticsPath,'utf8'));
      await assert.rejects(readdir(path.join(task.taskDirectory,project.mode,project.projectKey)), {code:'ENOENT'});
      assert.deepEqual(await readdir(path.dirname(project.attempts[0].diagnosticsPath)),['diagnostics.json']);
      assert.equal(diagnostics.error.code, code);
      assert.equal(diagnostics.error.stage, 'VALIDATE_DEVECO_VERSION');
      assert.equal(diagnostics.error.details.installedVersion, ideVersion);
      assert.equal(diagnostics.error.message, inspectionMessage);
      const downloadUrl = 'https://developer.huawei.com/consumer/cn/download/';
      assert.equal(diagnostics.error.message.includes(downloadUrl), code === 'DEVECO_TARGET_NOT_COVERED');
    }
    assert.equal((await readdir(path.join(home, 'plugins/harmony/arkanalyzer-apiscan'))).includes('backend-started'), false);
  }
});

test('scanner canonicalizes default and probes an ambiguous backend only once', async t => {
  const { root, sdk, home } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const count = path.join(root, 'help-calls.txt');
  const source = '// --startVersion --endVersion --modulePaths --sdkPath --outputPath --configPath --apiModifiedPath --outPath --tmpPath\n'
    + `require('node:fs').appendFileSync(${JSON.stringify(count)},'help\\n');\n`
    + "console.log('--configPath --apiModifiedPath --outPath --tmpPath --scanFilePaths');\n";
  await writeFile(path.join(home, 'plugins/harmony/arkanalyzer-apiscan/api-change-scan.js'), source);
  for (const input of [sdk, path.join(sdk, 'default')]) {
    const toolchain = await discoverDevEco(input, home);
    assert.equal(toolchain.sdkRoot, sdk);
    assert.equal(toolchain.sdkLocation.packagePath, path.join(sdk, 'default/sdk-pkg.json'));
    assert.equal(toolchain.fileScanSupported, true);
  }
  assert.equal(await readFile(count, 'utf8'), 'help\n');
});

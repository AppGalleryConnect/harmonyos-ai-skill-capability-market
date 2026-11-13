import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEPRECATED_HEADERS, hyperlink, parseCsv, SCANNER_HEADERS, titleText, UPGRADE_HEADERS } from '../../shared/format/csv.mjs';
import { sha256 } from '../../shared/io/fs-utils.mjs';
import { createScanBatch } from '../../shared/platform/artifact-layout.mjs';
import { runScanInBatch } from './helpers/scan-batch.mjs';
import { createCodeSize } from '../core/code-size.mjs';
import cppCompat from '../bin/deveco-cpp-compat.cjs';
import {
  compareFindings,
  collectCppTextCandidates,
  cppEnhancement,
  cppScanBudget,
  ideCppClasspath,
  interpretDevEcoOutput,
  probeIdeCpp,
  retryCppCommitFailure,
  normalizeCodeLocation,
  normalizeFinding,
  rulesForProject,
  runDevEcoScan,
} from '../core/scan-runner.mjs';

const verifiedBuild = cppCompat.supportedBuilds['26.0.0.821'];

for (const source of ['SDK_STATE', 'BUILD_LOG']) test(`${source} deprecated CSV decodes Title and retains identities and duplicate display rows`, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sdk-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'entry/A.ets');
  await mkdir(path.dirname(file));
  await writeFile(file, 'old(); old();');
  const project = { root, modules: [{ name: 'entry', root: path.dirname(file), relativeRoot: 'entry' }], sourceFiles: [file], sourceSnapshot: 'snapshot', scanDirs: [{ absolute: root }] };
  const findings = [1, 8].map(Column => ({
    'Api Definition': 'old(): void', Language: 'ArkTS', 'Changed in SDK': '', 'Deprecated Since': 9,
    'Code Location': 'entry/A.ets:1', Column, 'Rule ID': 'sdk-old', 'Change Type': 'Deprecated API',
    'Change Operation': 'API_DEPRECATED', 'API Symbol ID': 'api-old',
    Title: hyperlink('https://example.test/sdk-old', '旧API,"标题"\n第二行'), 'Detection Source': source,
    occurrenceId: `old-${Column}`, includedInCsv: true, disposition: 'REQUIRES_REVIEW', filterReason: null,
  }));
  const directory=path.join(root,'20261023123456');await mkdir(directory);
  const layout=await createScanBatch(root,directory,{mode:'deprecated'});
  const options={project,toolchain:{},rules:[],range:{},outputDirectory:directory,
    mode:'deprecated',batchId:layout.batchId,
    ...(source === 'SDK_STATE' ? { deprecations:{findings,unresolved:[],coverage:{status:'COMPLETE'}} }
      : { buildLogImport:{findings,warnings:[],audit:{status:'VERIFIED_LOG'}} })};
  const deprecated=await runDevEcoScan(options);
  assert.equal(deprecated.findings.length,2);
  assert.ok((await readFile(deprecated.validationCsv,'utf8')).includes('Title'));
  const scan=JSON.parse(await readFile(deprecated.scanJson,'utf8'));
  assert.equal(scan.schemaVersion,4);assert.deepEqual(scan.findings.map(item=>item.Column),[1,8]);
  assert.equal(scan.mode,'deprecated');
  assert.equal(deprecated.outputCsv,layout.rawCsv);assert.equal(deprecated.scanJson,layout.scanJson);
  assert.equal(deprecated.validationCsv,layout.validationCsv);
  const csv = parseCsv(await readFile(deprecated.outputCsv,'utf8'));
  assert.deepEqual(csv.headers,DEPRECATED_HEADERS);
  assert.equal(csv.rows.length,2);
  assert.deepEqual(csv.rows[0],csv.rows[1]);
  assert.equal(csv.rows[0].Title, '旧API,"标题"\n第二行');
  for (const finding of scan.findings) {
    assert.equal(finding.Title, findings[0].Title);
    assert.equal(finding['Detection Source'], source);
    assert.equal(finding['API Symbol ID'],'api-old');
    assert.equal(finding['Deprecated Since'],9);
    assert.equal(finding.findingId,`finding-${sha256(SCANNER_HEADERS.map(header=>finding[header]).join('\u0000')).slice(0,20)}`);
  }
  assert.equal(JSON.parse(await readFile(layout.scanJson,'utf8')).batchId,layout.batchId);
  assert.deepEqual((await readdir(directory)).sort(),['.internal','deprecated']);
  await writeFile(deprecated.outputCsv, 'previous report');
  await assert.rejects(runDevEcoScan({...options, verifyInputs:async()=>{throw new Error('input changed');}}), /input changed/);
  assert.equal(await readFile(deprecated.outputCsv,'utf8'),'previous report');
});

test('an unresponsive C++ backend is bounded and still publishes the ArkTS report', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpp-watchdog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = path.join(root, 'entry');
  await mkdir(moduleRoot);
  const cpp = path.join(moduleRoot, 'main.cpp');
  await writeFile(cpp, 'int main() {}');
  const fake = path.join(root, 'hang.mjs');
  await writeFile(fake, 'setInterval(() => {}, 1000);');
  const result = await runScanInBatch('upgrade', {
    toolchain: { apiChangeScan: fake, analyzerRoot: root, sdkRoot: '/sdk', java: process.execPath,
      cApiScanJar: '/fake/c-apiscan.jar' },
    project: { root, sourceFiles: [cpp], modules: [{ name: 'entry', root: moduleRoot, relativeRoot: 'entry' }], scanDirs: [{ absolute: root }], sourceSnapshot: 'snapshot' },
    rules: [{ ruleId: 'cpp', rawEntry: { affectedApis: [{ implementLanguage: 'c', methodDefinition: 'void OH_Run()' }], interfaceChanges: {} } }],
    range: { start: { platformVersion: '5.0.0', apiLevel: 12, channel: 'release' }, end: { platformVersion: '26.0.0', apiLevel: 26, channel: 'release' } },
    outputDirectory: root, cppPassTimeoutMs: 50,
  });
  assert.equal(result.diagnostics.cppStatus, 'TIMED_OUT');
  assert.equal(result.diagnostics.nativePasses[0].timeoutSource, 'SKILL_WATCHDOG');
  assert.equal(result.diagnostics.nativePasses[0].watchdogMs, 50);
  assert.ok(result.diagnostics.warnings.some(warning => warning.includes('C++扫描超时')));
  assert.equal(result.findings.length, 0);
  assert.ok(await readFile(result.outputCsv, 'utf8'));
});

test('native deprecated hits enter the primary CSV across independent module passes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpp-modules-中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = ['first', 'second'].map(name => ({ name, root: path.join(root, name), relativeRoot: name }));
  for (const module of modules) { await mkdir(module.root); await writeFile(path.join(module.root, 'main.cpp'), 'void run() {}'); }
  const calls = path.join(root, 'calls.jsonl'), fake = path.join(root, 'backend.mjs');
  const skipped = path.join(modules[0].root, 'skipped file.cpp');
  await writeFile(skipped, 'void skipped() {}');
  await writeFile(fake, `import {mkdir,writeFile,appendFile,readFile} from 'node:fs/promises';
    import path from 'node:path';
    const value = name => process.argv[process.argv.indexOf(name)+1];
    const modules = value('--modulePaths').split(',');
    await appendFile(${JSON.stringify(calls)}, JSON.stringify(modules)+'\\n');
    if (modules.length !== 1) process.exit(3);
    const out=value('--outputPath');await mkdir(out,{recursive:true});
    const [rule] = JSON.parse(await readFile(value('--apiModifiedPath'),'utf8'));
    if (path.basename(modules[0]) === 'first') console.error(${JSON.stringify(cppCompat.skippedPrefix)} + JSON.stringify([${JSON.stringify(skipped)}]));
    await writeFile(path.join(out,'result.csv'),'Api Definition,Language,ChangeId,Code Location\\n'
      + 'void run(),C++,' + rule.interfaceChanges.id + ',' + path.join(modules[0],'main.cpp') + ':1\\n');`);
  const options = { project: {root,modules,sourceFiles:[...modules.map(m=>path.join(m.root,'main.cpp')), skipped],
    scanDirs:[{absolute:root}],sourceSnapshot:'snapshot'},
    toolchain:{apiChangeScan:fake,analyzerRoot:root,sdkRoot:root,cApiScanJar:fake,java:process.execPath},
    rules:[{provider:'DEVECO',ruleId:'native',changeType:'Deprecated API',changeOperation:'API_DEPRECATED',
      title:'废弃原生接口',sourceReference:path.join(root,'native-rules.json'),
      rawEntry:{affectedApis:[{implementLanguage:'c',methodDefinition:'void run()'}],interfaceChanges:{}}}],
    range:{start:{platformVersion:'6.0.0',apiLevel:20,channel:'release'},end:{platformVersion:'26.0.0',apiLevel:26,channel:'release'}},outputDirectory:root };
  options.verifyInputs = async () => {
    const metrics = createCodeSize(options.project);
    for (const file of options.project.sourceFiles) metrics.addHarmony(file, await readFile(file));
    return metrics.result();
  };
  await assert.rejects(runScanInBatch('deprecated', { ...options, cppModuleTimeoutSeconds: 900 }), { code:'CPP_MODULE_TIMEOUT_UNSUPPORTED' });
  const result = await runScanInBatch('deprecated', options);
  assert.deepEqual((await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),modules.map(m=>[m.root]));
  assert.deepEqual(result.diagnostics.nativePasses.map(p=>p.modules),[['first'],['second']]);
  assert.deepEqual(result.diagnostics.nativePasses.map(p=>p.status),['PARTIAL','COMPLETE']);
  assert.equal(result.diagnostics.cppStatus, 'PARTIAL');
  assert.deepEqual(result.findings.map(row => row['Code Location']).sort(), ['first/main.cpp:1','second/main.cpp:1']);
  const saved = JSON.parse(await readFile(result.scanJson, 'utf8'));
  assert.deepEqual(saved.scanCoverage.nativePasses[0].skippedFiles, [skipped]);
  assert.deepEqual(saved.codeSize.byLanguage.cpp, { physicalLines: 3, codeLines: 3 });
  assert.equal(saved.filteredFindingCount, 0);
  assert.ok(saved.findings.every(finding => finding['Source Reference'] === options.rules[0].sourceReference));
  const csv = parseCsv(await readFile(result.outputCsv, 'utf8'));
  assert.equal(csv.rows.length, 2);
  assert.ok(csv.rows.every(row => row.Title === '废弃原生接口' && row.Language === 'C'));
});

test('an unverified DevEco build keeps ArkTS and sibling results when its native C++ scan falls back to grep', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpp-unverified-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = ['first', 'second'].map(name => ({ name, root: path.join(root, name), relativeRoot: name }));
  for (const module of modules) { await mkdir(module.root); await writeFile(path.join(module.root, 'main.cpp'), 'void run() {}'); }
  const fake = path.join(root, 'backend.mjs');
  await writeFile(fake, `import {mkdir,writeFile,readFile} from 'node:fs/promises';
    import path from 'node:path';
    const value = name => process.argv[process.argv.indexOf(name)+1];
    const module = value('--modulePaths');
    const out=value('--outputPath');await mkdir(out,{recursive:true});
    const [rule] = JSON.parse(await readFile(value('--apiModifiedPath'),'utf8'));
    if (path.basename(module) === 'first') console.log('Falling back to grep scan...');
    await writeFile(path.join(out,'result.csv'),'Api Definition,Language,ChangeId,Code Location\\n'
      + 'void run(),C++,' + rule.interfaceChanges.id + ',' + path.join(module,'main.cpp') + ':1\\n');`);
  const options = { project: {root,modules,sourceFiles:modules.map(m=>path.join(m.root,'main.cpp')),
    scanDirs:[{absolute:root}],sourceSnapshot:'snapshot'},
    toolchain:{apiChangeBackend:'integrated',apiChangeScan:fake,analyzerRoot:root,sdkRoot:root,cApiScanJar:fake,java:process.execPath,
      productInfo:{version:'26.0.0.900'},hashes:{apiChangeScan:'unverified'}},
    rules:[{provider:'DEVECO',ruleId:'native',rawEntry:{affectedApis:[{implementLanguage:'c',methodDefinition:'void run()'}],interfaceChanges:{}}}],
    range:{start:{platformVersion:'6.0.0',apiLevel:20,channel:'release'},end:{platformVersion:'26.0.0',apiLevel:26,channel:'release'}},outputDirectory:root };
  const result = await runScanInBatch('upgrade', options);
  assert.deepEqual(result.diagnostics.nativePasses.map(p=>p.status),['FAILED','COMPLETE']);
  assert.equal(result.diagnostics.nativePasses[0].failureReason, 'UNVERIFIED_BUILD_FALLBACK');
  assert.equal(result.diagnostics.cppStatus, 'PARTIAL');
  assert.deepEqual(result.findings.map(row => row['Code Location']), ['second/main.cpp:1']);
  assert.ok(result.diagnostics.warnings.some(warning => warning.includes('26.0.0.900') && warning.includes('外层预算 240 秒')));
});

const bundle = [
  'const CPP_SCAN_TIMEOUT_SECONDS = 60;',
  'function scanCppFiles(options, tempDir, mergedApiChangeList) {',
  '  const cppStart = 0;',
  '  const cppScanOptions = {',
  '    sdkPaths: getCppSdkPath(),',
  '    timeout: 60',
  '  };',
  '  return scanCppByPaths(tempDir, mergedApiChangeList, cppScanOptions, cppStart);',
  '}',
  'function getCppSdkPath() { return []; }',
  'function scanCppByPaths(tempDir, mergedApiChangeList, options) { return options; }',
  'const options = scanCppFiles();',
  'const javaPayload = { timeout: CPP_SCAN_TIMEOUT_SECONDS, modules: [] };',
  'const JAR_SCAN_TIMEOUT_MS = ((options === null || options === void 0 ? void 0 : options.timeout) || CPP_SCAN_TIMEOUT_SECONDS) * 1000;',
  'function runChunk() { setTimeout(() => { /* Java timeout */ }, JAR_SCAN_TIMEOUT_MS); }',
  'function javaExit(code, stderr, stdout = "") { console.error(`Java process exited with code ${code}`); }',
  'function readJavaResult(stdout, stderr) { const result = JSON.parse(stdout.trim()); return result; }',
  'function emit(jarResult) { console.log(`Scanning ${jarResult.failedFiles.length} failed files with grep...`);',
  'const grepResults = []; for (const failedFile of jarResult.failedFiles) { grepResults.push(failedFile); }',
  'return { csvContent: jarResult.csvContent + generateCsvFromLineApiChangeInfo(grepResults), failedFiles: jarResult.failedFiles }; }',
  'function jar() { const jarPath = findCapiscanJar(); return jarPath; }',
  'function* java() { const javaExe = yield findJavaExe(); return javaExe; }',
  'function ninjaPath() { const ninja = findNinja(modulePath); return ninja; }',
  "function spawnArguments(jsonString) { const spawnArgs = ['com.huawei.deveco.programanalysis.apiscan.capiscan.CAPIScanner', jsonString]; return spawnArgs; }",
  "function vendorFailure(e) { console.log('Falling back to grep scan...'); }",
  'function scanCppByJar(modulePaths, apiChangeItems, tmpPath, options) {',
  '  const baseJsonData = "", singleChunkJson = "";',
  '  const BASE_JSON_SIZE = baseJsonData.length;',
  '  const CMD_LINE_LIMIT = 29000;',
  '  if (singleChunkJson.length <= CMD_LINE_LIMIT) return BASE_JSON_SIZE;',
  '}',
  'return { javaPayload, emit, runChunk, javaExit, readJavaResult };',
].join('\n');

test('DevEco long scan changes the module timer and preserves the Java file timer and semantic output', async () => {
  const toolchain = { apiChangeBackend: 'integrated', apiChangeScan: path.join(os.tmpdir(), 'api-change-scan.js'),
    hashes: { apiChangeScan: verifiedBuild.cli } };
  const backendJar = { file: path.join(os.tmpdir(), 'lib', 'c-apiscan.jar'), sha256: verifiedBuild.nativeJar };
  const fingerprint = async file => { assert.equal(file, backendJar.file); return backendJar.sha256; };
  assert.deepEqual(await cppScanBudget(toolchain, undefined, 240_000, fingerprint),
    { jarTimeoutSeconds: 900, fileTimeoutSeconds: 60, watchdogMs: 930_000, backendJar });
  assert.equal((await cppScanBudget(toolchain, 600, 240_000, fingerprint)).watchdogMs, 630_000);
  assert.deepEqual(await cppScanBudget({}, undefined, 240_000), { jarTimeoutSeconds: null, fileTimeoutSeconds: null, watchdogMs: 240_000 });
  await assert.rejects(cppScanBudget(toolchain, 900, 240_000, async () => 'changed'), { code: 'CPP_MODULE_TIMEOUT_UNSUPPORTED' });
  await assert.rejects(cppScanBudget({ ...toolchain, productInfo: { version: '26.0.0.851' }, hashes: { apiChangeScan: 'other' } }, 900, 240_000),
    error => error.code === 'CPP_MODULE_TIMEOUT_UNSUPPORTED' && error.message.includes('26.0.0.851'));
  const calls = [], logs = [];
  const compat = new Function('Date', 'setTimeout', 'console', cppCompat.adaptSource(bundle, 900))(
    { now: () => calls.length ? 60_010 : 10 }, (_callback, delay) => calls.push(delay), { error: line => logs.push(line) });
  compat.runChunk(); compat.runChunk();
  assert.deepEqual(calls, [900_000, 840_000]);
  assert.equal(compat.javaPayload.timeout, 60);
  const partial = { csvContent: 'semantic hits', failedFiles: ['not parsed.cpp'] };
  assert.equal(compat.emit(partial), partial);
  assert.equal(interpretDevEcoOutput({ code: 0, stdout: '', stderr: logs[0] }).cppStatus, 'PARTIAL');
  compat.javaExit(1, 'native failure details');
  assert.equal(logs.at(-1), 'native failure details');
  compat.javaExit(1, '', 'os::commit_memory failed (DOS error/errno=1455)');
  assert.equal(interpretDevEcoOutput({ code: 0, stdout: '', stderr: logs.at(-1) }, { nativePass: true }).failureReason, 'JAR_COMMITMENT_LIMIT');
  compat.readJavaResult('{"fileNum":0}', 'no native coverage');
  assert.equal(logs.at(-1), 'no native coverage');
  assert.throws(() => cppCompat.adaptSource(bundle.replace('  const cppStart = 0;', '  const cppScanOptions = {};\n  const cppStart = 0;'), 900), /anchor/);
  const scoped = [];
  const modern = new Function('Date', 'setTimeout', 'console', 'ide', cppCompat.adaptSource(bundle, 900, true))(
    Date, setTimeout, { error: line => logs.push(line) }, { scopedFailures: () => ['allowed.cpp'],
      keepSemanticRows: (content, hits) => { scoped.push(...hits); return content; } });
  assert.equal(modern.emit(partial).csvContent, 'semantic hits');
  assert.deepEqual(scoped, ['allowed.cpp']);
  assert.equal(modern.javaPayload.timeout, 60);
});

test('matches complete integer literals in the DevEco C++ entry and JAR functions', () => {
  for (const [timeout, limit] of [[600, 17001], [3600, 20000], [75, 48310]]) {
    const changed = bundle.replace('timeout: 60', `timeout: ${timeout}`).replace('CMD_LINE_LIMIT = 29000', `CMD_LINE_LIMIT = ${limit}`);
    const source = `const other = { timeout: 60 };\nconst CMD_LINE_LIMIT = 19;\n${changed}`;
    assert.deepEqual(cppCompat.probe(source), { timeout: true, ide: true });
    assert.deepEqual(cppCompat.probe(`eval(${JSON.stringify(`{\n${source}\n}`)});`), { timeout: true, ide: true });
    const adapted = cppCompat.adaptSource(source, 900, true);
    assert.match(adapted, /timeout: 900\n/);
    assert.match(adapted, /const other = \{ timeout: 60 \};/);
    assert.match(adapted, /const CMD_LINE_LIMIT = 19;/);
    assert.match(adapted, /CMD_LINE_LIMIT = Infinity;/);
    assert.doesNotMatch(adapted, /timeout: 9000/);
  }
  assert.equal(cppCompat.probe(bundle.replace('timeout: 60', 'timeout: 60 * 10')).timeout, false);
  assert.deepEqual(cppCompat.probe(bundle.replace('CMD_LINE_LIMIT = 29000', 'CMD_LINE_LIMIT = limit()')), { timeout: false, ide: false });
  assert.equal(cppCompat.probe(bundle.replace('CMD_LINE_LIMIT = 29000;', 'CMD_LINE_LIMIT = 29000;\n  const CMD_LINE_LIMIT = 20000;')).ide, false);
  assert.equal(cppCompat.probe(bundle.replace('singleChunkJson.length <= CMD_LINE_LIMIT', 'true')).ide, false);
  assert.equal(cppCompat.probe(bundle.replace('CPP_SCAN_TIMEOUT_SECONDS = 60', 'CPP_SCAN_TIMEOUT_SECONDS = 90')).timeout, false);
});

test('an unlisted DevEco build enables the C++ enhancement only when every anchor matches', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpp-anchored-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'arkanalyzer-apiscan', 'api-change-scan.js'), jar = path.join(path.dirname(cli), 'lib', 'c-apiscan.jar');
  await mkdir(path.dirname(jar), { recursive: true });
  await writeFile(cli, bundle);
  await writeFile(jar, 'jar');
  const toolchain = { apiChangeBackend: 'integrated', apiChangeScan: cli, productInfo: { version: '27.0.0.100' }, hashes: { apiChangeScan: sha256(bundle) } };
  const enhancement = await cppEnhancement(toolchain);
  assert.deepEqual(enhancement, { tier: 'ANCHOR_MATCHED', ide: true });
  assert.deepEqual(await cppScanBudget(toolchain, 600, 240_000, undefined, enhancement), { jarTimeoutSeconds: 600, fileTimeoutSeconds: 60,
    watchdogMs: 630_000, backendJar: { file: jar, sha256: sha256('jar') }, enhancement: 'ANCHOR_MATCHED' });
  assert.equal(await ideCppClasspath({ ...toolchain, cApiScanJar: jar, java: process.execPath }, undefined, enhancement), null);
  assert.equal((await cppEnhancement({ ...toolchain, hashes: { apiChangeScan: verifiedBuild.cli } })).tier, 'NATIVE');
  assert.equal((await cppEnhancement({ ...toolchain, hashes: { apiChangeScan: sha256('stale') } })).tier, 'NATIVE');
  const argv = process.argv;
  t.after(() => { process.argv = argv; });
  assert.doesNotThrow(() => cppCompat.run(cli, 900, [], undefined, `${sha256(bundle)},${sha256('jar')}`));
  assert.throws(() => cppCompat.run(cli, 900, [], undefined, `${sha256(bundle)},${sha256('other')}`), /changed after capability detection/);
  assert.throws(() => cppCompat.run(cli, 900, [], undefined, `${sha256('other')},${sha256('jar')}`), /changed after capability detection/);
  assert.throws(() => cppCompat.run(cli, 900, [], undefined, undefined), /changed after capability detection/);
  const changed = bundle.replace('const javaExe = yield findJavaExe();', 'const javaExe = yield alternateJava();');
  await writeFile(cli, changed);
  assert.deepEqual(await cppEnhancement({ ...toolchain, hashes: { apiChangeScan: sha256(changed) } }), { tier: 'ANCHOR_MATCHED', ide: false });
  const unmatched = bundle.replace('timeout: 60', 'timeout: 61.5');
  await writeFile(cli, unmatched);
  const native = { ...toolchain, hashes: { apiChangeScan: sha256(unmatched) } };
  assert.deepEqual(await cppEnhancement(native), { tier: 'NATIVE', ide: false });
  await assert.rejects(cppScanBudget(native, 600, 240_000, undefined, await cppEnhancement(native)), { code: 'CPP_MODULE_TIMEOUT_UNSUPPORTED' });
});

test('selects the IDE engine only for the verified bundle and records dependency hashes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ide-cpp-classpath-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'arkanalyzer-apiscan', 'api-change-scan.js'), library = path.join(root, 'lib');
  const json = path.join(path.dirname(cli), 'lib', 'fastjson2-2.0.60.jar');
  await mkdir(path.dirname(json), { recursive: true });
  await mkdir(library);
  await writeFile(json, 'json');
  const engine = path.join(library, 'c-apiscan.jar'), eclipse = path.join(library, 'org.eclipse.example.jar');
  await writeFile(eclipse, 'eclipse');
  await writeFile(path.join(library, 'unrelated.jar'), 'other');
  const toolchain = { apiChangeBackend: 'integrated', apiChangeScan: cli, cApiScanJar: engine, java: process.execPath,
    productInfo: { version: '26.0.0.821' }, hashes: { apiChangeScan: verifiedBuild.cli, cApiScanJar: verifiedBuild.ideJar } };
  const fingerprint = async file => file === json ? verifiedBuild.jsonJar : sha256(await readFile(file));
  assert.deepEqual(await ideCppClasspath(toolchain, fingerprint), [
    { file: engine, sha256: verifiedBuild.ideJar }, { file: json, sha256: verifiedBuild.jsonJar }, { file: eclipse, sha256: sha256('eclipse') },
  ]);
  assert.deepEqual(await ideCppClasspath({ ...toolchain, productInfo: { version: 'future-build' } }, fingerprint),
    await ideCppClasspath(toolchain, fingerprint));
  assert.equal(await ideCppClasspath(toolchain, async () => 'changed'), null);
});

test('IDE C++ self-check requires a working Java entry and its dependency marker', async () => {
  const toolchain = { java: process.execPath, analyzerRoot: os.tmpdir() };
  const classpath = [{ file: path.join(os.tmpdir(), '有空格 engine.jar') }];
  const launch = async (command, args, options) => {
    assert.equal(command, toolchain.java);
    assert.equal(args.at(-1), '--probe');
    assert.equal(args[3], classpath[0].file);
    assert.equal(options.timeoutMs, 15_000);
    return { exitCode: 0, stdout: 'HARMONY_CPP_IDE_READY\r\n' };
  };
  assert.equal(await probeIdeCpp(toolchain, classpath, launch), true);
  assert.equal(await probeIdeCpp(toolchain, classpath, async () => ({ exitCode: 1, stdout: '', stderr: 'cannot find CAPIScanner.run' })), false);
  assert.equal(await probeIdeCpp(toolchain, classpath, async () => ({ exitCode: 0, stdout: '' })), false);
});

test('large C++ module inputs stay in the Java config file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'C++ 空格 输入-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const argv = process.argv;
  t.after(() => { process.argv = argv; });
  const cli = path.join(root, 'api-change-scan.js');
  const config = path.join(root, 'ide-cpp.json');
  const capture = path.join(root, 'java-args.json');
  const engine = path.join(root, 'engine.jar'), json = path.join(root, 'json.jar');
  await writeFile(engine, 'engine');
  await writeFile(json, 'json');
  await writeFile(config, JSON.stringify({ java: process.execPath,
    classpath: [{ file: engine, sha256: sha256('engine') }, { file: json, sha256: sha256('json') }] }));
  const modules = Array.from({ length: 500 }, (_, i) => ({ path: path.join(root, 'native', 'long-directory-name'.repeat(4), `${i}.cpp`) }));
  const payload = JSON.stringify({ modules });
  assert.ok(payload.length > 32767);
  const source = `${bundle.slice(0, bundle.lastIndexOf('return { javaPayload'))}\n`
    + `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(spawnArguments(${JSON.stringify(payload)})));`;
  await writeFile(cli, source);
  cppCompat.run(cli, 900, [], config, sha256(source));
  const args = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(args[3], [engine, json].join(path.delimiter));
  assert.equal(args.at(-1), path.join(root, 'java-input.json'));
  assert.ok(args.join(' ').length < 32767);
  assert.equal(await readFile(args.at(-1), 'utf8'), payload);
});

test('Windows commitment limit retries once within the module budget and honors JVM options', async () => {
  const processResult = { code: 1, stdout: 'os::commit_memory failed (DOS error/errno=1455)', stderr: '' };
  const interpretation = interpretDevEcoOutput(processResult, { nativePass: true });
  assert.equal(interpretation.failureReason, 'JAR_COMMITMENT_LIMIT');
  assert.equal(interpretation.discardRows, true);
  const budget = { jarTimeoutSeconds: 900, watchdogMs: 930_000 };
  const first = { interpretation, processResult, budget, durationMs: 125_020, rows: [] };
  let calls = 0;
  const retry = async (actualBudget, options) => {
    calls++;
    assert.deepEqual(actualBudget, { jarTimeoutSeconds: 774, watchdogMs: 804_000 });
    assert.equal(options, '-Xmx1g -Xms256m');
    return { durationMs: 1234, interpretation: { cppStatus: 'COMPLETE', warnings: [] }, rows: [{ id: 'second' }] };
  };
  const finished = await retryCppCommitFailure(first, retry, { platform: 'win32', env: {} });
  assert.equal(calls, 1);
  assert.deepEqual(finished.rows, [{ id: 'second' }]);
  assert.deepEqual(finished.budget, budget);
  assert.equal(finished.memoryRetry.status, 'COMPLETE');
  assert.equal(finished.memoryRetry.first.stdout, processResult.stdout);
  assert.equal(finished.durationMs, first.durationMs + 1234);
  for (const key of ['java_tool_options', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS']) {
    assert.equal(await retryCppCommitFailure(first, retry, { platform: 'win32', env: { [key]: '-Xmx8g' } }), first);
  }
  assert.equal(await retryCppCommitFailure(first, retry, { platform: 'darwin', env: {} }), first);
  const exhausted = { ...first, durationMs: 850_000 };
  assert.equal(await retryCppCommitFailure(exhausted, retry, { platform: 'win32', env: {} }), exhausted);
  const heapFailure = { ...first, interpretation: { failureReason: 'JAR_OUT_OF_MEMORY' } };
  assert.equal(await retryCppCommitFailure(heapFailure, retry, { platform: 'win32', env: {} }), heapFailure);
  assert.equal(calls, 1);
  const legacy = { ...first, budget: { jarTimeoutSeconds: null, watchdogMs: 240_000 } };
  const failed = await retryCppCommitFailure(legacy, async actualBudget => {
    calls++;
    assert.deepEqual(actualBudget, { jarTimeoutSeconds: null, watchdogMs: 114_980 });
    return { ...first, durationMs: 100 };
  }, { platform: 'win32', env: {} });
  assert.equal(failed.memoryRetry.status, 'FAILED');
  assert.equal(failed.memoryRetry.failureReason, 'JAR_COMMITMENT_LIMIT');
  assert.equal(calls, 2);
});

test('C++ text candidates use only in-scope failed files and active rule bindings', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cpp-candidates-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = { name: 'first', root: path.join(root, 'first') }, second = { name: 'second', root: path.join(root, 'second') };
  const valid = path.join(first.root, 'main.cpp'), other = path.join(second.root, 'other.cpp');
  await mkdir(first.root);
  await mkdir(second.root);
  await writeFile(valid, 'fstat();');
  await writeFile(other, 'fstat();');
  const alias = path.join(first.root, 'alias');
  await symlink(second.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(cppCompat.scopedFailures([valid, other, path.join(alias, 'other.cpp'), 'relative.cpp'], [valid]), [valid]);
  assert.deepEqual(cppCompat.scopedFailures([other], [valid]), []);
  const project = { root, modules: [first, second], sourceFiles: [valid, other], scanDirs: [{ absolute: root }] };
  const bindings = new Map([['active', { bindings: [{ rule: { ruleId: 'CH1' }, api: { methodDefinition: 'fstat()' } }] }]]);
  const hit = { scanId: 'active', file: valid, line: 1 };
  const passes = [{ modules: ['first'], textHits: [hit, hit, { ...hit, file: other }, { ...hit, scanId: 'unknown' }] }];
  assert.deepEqual(collectCppTextCandidates(project, bindings, passes), [
    { module: 'first', ruleId: 'CH1', api: 'fstat()', location: 'first/main.cpp:1' },
  ]);
});

test('a native pass with zero scanned files or a Java error records a coverage failure', () => {
  const output = { code: 0, stdout: 'C++ scan completed: 0 files, 62000 ms', stderr: '' };
  assert.equal(interpretDevEcoOutput(output).cppStatus, 'COMPLETE');
  assert.equal(interpretDevEcoOutput(output, { nativePass: true }).failureReason, 'NO_SCANNED_FILES');
  const failure = interpretDevEcoOutput({ ...output, stderr: 'Java process exited with code 1' }, { nativePass: true });
  assert.equal(failure.cppStatus, 'FAILED');
  assert.equal(failure.failureReason, 'JAR_EXECUTION_FAILED');
  const oom = interpretDevEcoOutput({ ...output, stderr: '警告: module exception Java heap space in src' }, { nativePass: true });
  assert.equal(oom.cppStatus, 'FAILED');
  assert.equal(oom.failureReason, 'JAR_OUT_OF_MEMORY');
});

test('normalizes DevEco rows into the scanner CSV contract', () => {
  const finding = normalizeFinding({
    'Api Definition': 'run(): void', Language: 'ArkTS', 'Changed in SDK': '6.0.0(20) Beta1',
    'Affected Versions': 'ALL', Title: 'title', 'Code Location': 'entry\\A.ets:2',
  }, {
    ruleId: 'r1', changedInSdk: '6.0.0(20) Beta1', affectedVersions: 'N/A (compile-time)',
    changeType: 'Deprecated API', changeOperation: 'API_DEPRECATED', sourceReference: 'a.md:2',
    title: 'API废弃', url: 'https://example.test/deprecated',
    replacementApi: 'ohos.arkui.UIContext.UIContext#getHostContext',
    replacementSource: '/sdk/component/common.d.ts:10',
  }, null, 'deprecated');
  assert.equal(finding.Fixed, 'Unfixed');
  assert.equal(finding['Code Location'], 'entry/A.ets:2');
  assert.equal(finding['Rule ID'], 'r1');
  assert.equal(finding['Replacement API'], 'ohos.arkui.UIContext.UIContext#getHostContext');
  assert.equal(finding['Replacement Source'], '/sdk/component/common.d.ts:10');
  assert.equal(finding.includedInCsv, true);
  assert.equal(finding.disposition, 'REQUIRES_REVIEW');
  assert.equal(finding.filterReason, null);
});

test('deprecated DevEco findings enter the CSV even with obsolete document filtering metadata', () => {
  const finding = normalizeFinding({
    'Api Definition': 'run(): void', Language: 'ArkTS', 'Code Location': 'entry/A.ets:2',
  }, {
    ruleId: 'compatible', changedInSdk: '6.0.0(20) Beta1', affectedVersions: 'N/A (compile-time)',
    changeType: 'Deprecated API', changeOperation: 'API_DEPRECATED', sourceReference: 'a.md:2',
    title: '兼容变更', url: '', reportDisposition: 'FILTERED_COMPATIBLE', filterReason: 'DOCUMENTED_NO_ADAPTATION',
  }, null, 'deprecated');
  assert.equal(finding.includedInCsv, true);
  assert.equal(finding.disposition, 'REQUIRES_REVIEW');
  assert.equal(finding.filterReason, null);
});

test('uses a deterministic finding order', () => {
  const base = { 'Changed in SDK': '6.0.0(20)', 'Rule ID': 'r', Language: 'ArkTS', 'Api Definition': 'a' };
  const first = { ...base, 'Change Type': 'API Behavior Change', 'Code Location': 'entry/A.ets:2' };
  const second = { ...base, 'Change Type': 'Deprecated API', 'Code Location': 'entry/A.ets:1' };
  assert.ok(compareFindings(first, second) < 0);
});

test('keeps C++ timeout non-blocking but rejects grep fallback', () => {
  const timeout = interpretDevEcoOutput({
    code: 0,
    stdout: 'CSV saved',
    stderr: 'error[20004] C++ JAR scan timed out, marking as failed\nJava process exited with code 143',
  });
  assert.equal(timeout.cppStatus, 'TIMED_OUT');
  assert.match(timeout.warnings[0], /结果可能不完整/);
  assert.throws(() => interpretDevEcoOutput({
    code: 0,
    stdout: 'Falling back to grep scan',
    stderr: '',
  }), /inaccurate fallback/);
});

test('converts absolute C++ locations inside the project to portable relative paths', () => {
  assert.equal(
    normalizeCodeLocation({ root: '/work/app', modules: [] }, '/work/app/entry/src/main/cpp/main.cpp:42'),
    'entry/src/main/cpp/main.cpp:42',
  );
  assert.equal(
    normalizeCodeLocation({
      root: '/work/app',
      modules: [{ name: 'native', root: '/work/app/components/native' }],
    }, '/work/app/components/native/src/main/cpp/main.cpp:7'),
    'native/src/main/cpp/main.cpp:7',
  );
});

test('does not send C rules to DevEco for a pure ArkTS scan scope', () => {
  const rules = [{ rawEntry: { affectedApis: [
    { implementLanguage: 'typeScript', interfaceName: 'run' },
    { implementLanguage: 'c', interfaceName: 'OH_Run' },
  ] } }];
  const selected = rulesForProject(rules, { sourceFiles: ['/work/A.ets'] });
  assert.equal(selected.hasCpp, false);
  assert.deepEqual(selected.entries[0].affectedApis.map((item) => item.interfaceName), ['run']);
});

test('groups duplicate affected APIs under one scan id and preserves all owning rules', () => {
  const api = {
    implementLanguage: 'typeScript', completePath: '/sdk/a.d.ts', className: 'A',
    interfaceType: 'method', interfaceName: 'run', methodDefinition: 'run(): void',
  };
  const rules = ['behavior', 'deprecated'].map((id, index) => ({
    ruleId: id,
    rawEntry: {
      affectedApis: [{ ...api, methodDefinition: `${api.methodDefinition}${index ? ';' : ''}` }],
      interfaceChanges: { id },
    },
  }));
  const selected = rulesForProject(rules, { sourceFiles: ['/work/A.ets'] });
  assert.equal(selected.arkTsEntries.length, 1);
  const scanId = selected.arkTsEntries[0].interfaceChanges.id;
  assert.deepEqual(selected.scanRuleMap.get(scanId).rules.map((rule) => rule.ruleId), ['behavior', 'deprecated']);
});

for (const prefix of ['scanner-timeout-project-', "scanner-timeout-中文 空格'路径-"]) {
test(`generates a report when the DevEco C++ backend times out${prefix.includes('中文') ? ' with a Chinese, spaced and quoted path' : ''}`, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = path.join(root, 'entry');
  const output = path.join(root, 'output');
  await mkdir(moduleRoot, { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(moduleRoot, 'A.ets'), 'run();\n');
  await writeFile(path.join(moduleRoot, 'main.cpp'), 'int main() { return 0; }\n');
  const fake = path.join(root, 'fake-scan.mjs');
  await writeFile(fake, `
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const value = (name) => process.argv[process.argv.indexOf(name) + 1];
    if (value('--startVersion') !== 'start-from-resource' || value('--endVersion') !== 'end-from-resource') process.exit(2);
    const out = value('--outputPath');
    const changes = JSON.parse(await readFile(value('--apiModifiedPath'), 'utf8'));
    const change = changes[0];
    const api = change.affectedApis[0];
    const language = api.implementLanguage === 'c' ? 'C' : 'ArkTS';
    const location = language === 'C' ? ${JSON.stringify(`${path.join(moduleRoot, 'main.cpp')}:1`)} : 'entry/A.ets:1';
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'result.csv'), '\\ufeffApi Definition,Language,ChangeId,Changed in SDK,Affected Versions,Title,Code Location,Change Type\\r\\n' + api.methodDefinition + ',' + language + ',' + change.interfaceChanges.id + ',5.0.1(13) Release,ALL,title,' + location + ',接口行为变更\\r\\n');
    console.error('error[20004] C++ JAR scan timed out, marking as failed');
  `);
  const rule = {
    ruleId: 'r1', changedInSdk: '5.0.1(13) Release', affectedVersions: 'ALL',
    changeType: 'API Behavior Change', changeOperation: 'API_BEHAVIOR', sourceReference: 'a.md:1',
    title: '行为变更', url: 'https://example.test/behavior',
    rawEntry: { affectedApis: [
      { implementLanguage: 'typeScript', methodDefinition: 'run(): void' },
      { implementLanguage: 'c', methodDefinition: 'int OH_Run(void)' },
    ] },
  };
  const result = await runScanInBatch('upgrade', {
    toolchain: {
      apiChangeScan: fake, analyzerRoot: root, cApiScanJar: path.join(root, 'fake', 'c.jar'), sdkRoot: path.join(root, 'fake', 'sdk'),
      contentsRoot: root, java: path.join(root, 'jbr', 'bin', 'java'),
    },
    project: {
      root,
      modules: [{ name: 'entry', root: moduleRoot, relativeRoot: 'entry' }],
      selectedModules: [{ name: 'entry', root: moduleRoot, relativeRoot: 'entry' }],
      scanDirs: [{ absolute: root, relative: '.' }],
      sourceFiles: [path.join(moduleRoot, 'A.ets'), path.join(moduleRoot, 'main.cpp')],
      sourceSnapshot: 'snapshot',
    },
    range: {
      start: { platformVersion: '5.0.0', apiLevel: 12, channel: 'release', channelNumber: 0 },
      end: { platformVersion: '5.0.1', apiLevel: 13, channel: 'release', channelNumber: 0 },
    },
    rules: [rule],
    devecoVersionNames: {
      '5.0.0(12) Release': 'start-from-resource',
      '5.0.1(13) Release': 'end-from-resource',
    },
    outputDirectory: output,
  });
  assert.equal(result.findings.length, 2);
  const locations = findings => findings.map(finding => [finding.Language, finding['Code Location']]).sort();
  const expected = [['ArkTS', 'entry/A.ets:1'], ['C', 'entry/main.cpp:1']];
  assert.deepEqual(locations(result.findings), expected);
  assert.deepEqual(locations(parseCsv(await readFile(result.outputCsv, 'utf8')).rows), expected);
  assert.deepEqual(locations(JSON.parse(await readFile(result.scanJson, 'utf8')).findings), expected);
  assert.equal(result.diagnostics.cppStatus, 'TIMED_OUT');
  assert.match(result.diagnostics.warnings[0], /需人工复核/);
});
}

for (const mode of ['upgrade', 'deprecated']) test(`${mode} DevEco CSV projects titles without changing JSON evidence`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-filter-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = path.join(root, 'entry');
  const output = path.join(root, 'output');
  await mkdir(moduleRoot, { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(moduleRoot, 'A.ets'), 'run();\n');
  const fake = path.join(root, 'fake-scan.mjs');
  await writeFile(fake, `
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const value = (name) => process.argv[process.argv.indexOf(name) + 1];
    const out = value('--outputPath');
    const changes = JSON.parse(await readFile(value('--apiModifiedPath'), 'utf8'));
    await mkdir(out, { recursive: true });
    const rows = changes.map((change) => {
      const api = change.affectedApis[0];
      return [api.methodDefinition, 'ArkTS', change.interfaceChanges.id, '6.0.0(20) Beta1', 'ALL', 'title', 'entry/A.ets:1', '接口定义变更'].join(',');
    });
    await writeFile(path.join(out, 'result.csv'), '\\ufeffApi Definition,Language,ChangeId,Changed in SDK,Affected Versions,Title,Code Location,Change Type\\r\\n' + rows.join('\\r\\n') + '\\r\\n');
  `);
  const api = {
    implementLanguage: 'typeScript', completePath: '/sdk/a.d.ts', className: 'A',
    interfaceType: 'method', interfaceName: 'run', methodDefinition: 'run(): void',
  };
  const makeRule = (ruleId, reportDisposition, filterReason, applicabilityProof = null) => ({
    provider: 'DEVECO', ruleId, changedInSdk: '6.0.0(20) Beta1', affectedVersions: 'ALL',
    changeType: mode === 'upgrade' ? 'API Behavior Change' : 'Deprecated API',
    changeOperation: mode === 'upgrade' ? 'API_BEHAVIOR' : 'API_DEPRECATED', sourceReference: `${ruleId}.md:1`,
    title: `${ruleId},"中文"\n下一行`, url: 'https://example.test/doc#CH1', reportDisposition, filterReason, applicabilityProof,
    rawEntry: { affectedApis: [api], interfaceChanges: { id: ruleId } },
  });
  const options = {
    toolchain: {
      apiChangeScan: fake, analyzerRoot: root, cApiScanJar: '/fake/c.jar', sdkRoot: '/fake/sdk',
      contentsRoot: root, java: path.join(root, 'jbr', 'bin', 'java'),
    },
    project: {
      root,
      modules: [{ name: 'entry', root: moduleRoot, relativeRoot: 'entry' }],
      selectedModules: [{ name: 'entry', root: moduleRoot, relativeRoot: 'entry' }],
      scanDirs: [{ absolute: root, relative: '.' }],
      sourceFiles: [path.join(moduleRoot, 'A.ets')],
      sourceSnapshot: 'snapshot',
    },
    range: {
      start: { platformVersion: '5.0.0', apiLevel: 12, channel: 'release', channelNumber: 0 },
      end: { platformVersion: '6.0.0', apiLevel: 20, channel: 'beta', channelNumber: 1 },
    },
    rules: [
      makeRule('review', 'REQUIRES_REVIEW', null),
      makeRule('compatible', mode === 'upgrade' ? 'FILTERED_COMPATIBLE' : 'REQUIRES_REVIEW', 'DOCUMENTED_NO_ADAPTATION', {
        kind: 'DOCUMENTED_NO_ADAPTATION', sourceReference: 'compatible.md:1',
        sectionField: '适配指导', statement: '默认行为变更，无需适配。',
      }),
    ],
    outputDirectory: output,
  };
  const result = await runScanInBatch(mode, options);
  if (mode === 'upgrade') assert.equal(result.validationCsv,null);
  const csv = parseCsv(await readFile(result.outputCsv,'utf8'));
  assert.deepEqual(csv.headers,mode === 'upgrade' ? UPGRADE_HEADERS : DEPRECATED_HEADERS);
  assert.equal(csv.rows.length,2);
  const scan=JSON.parse(await readFile(result.scanJson,'utf8'));
  assert.equal(scan.findings.length,2);assert.equal(scan.filteredFindingCount,0);
  assert.ok(scan.findings.every(finding=>finding.includedInCsv && finding.disposition==='REQUIRES_REVIEW'));
  const projected = mode === 'upgrade' ? scan.findings : scan.actionGroups.map(g => g.occurrences[0]);
  assert.deepEqual(csv.rows.map(r => r.Title), projected.map(r => mode === 'upgrade' ? r.Title : titleText(r.Title)));
  assert.ok(scan.findings.every(finding => finding.Title.startsWith('=HYPERLINK(')));
  assert.equal(path.basename(path.dirname(result.scanJson)),'scanner');
});

test('runs the index backend without placing the project file list on the command line', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'index-backend-project-'));
  const moduleRoot = path.join(root, 'entry');
  const output = path.join(root, 'output');
  const source = path.join(moduleRoot, 'A.ets');
  await mkdir(moduleRoot, { recursive: true });
  await mkdir(output);
  await writeFile(source, 'run();\n');
  const fake = path.join(root, 'renamed-index.mjs');
  await writeFile(path.join(root, 'worker.js'), `
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage('ready');
  `);
  await writeFile(fake, `
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { Worker } from 'node:worker_threads';
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    const value = (name) => process.argv[process.argv.indexOf(name) + 1];
    if (process.argv.includes('--scanFilePaths')) throw new Error('source paths must stay out of the command line');
    const worker = new Worker(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ApiScan.worker.ts'));
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const out = value('--outPath');
    const config = JSON.parse(await readFile(value('--configPath'), 'utf8'));
    if (!config.projectPath || !Array.isArray(config.sdks) || config.sdks.length !== 2) throw new Error('invalid scanner config');
    const changes = JSON.parse(await readFile(value('--apiModifiedPath'), 'utf8'));
    await mkdir(out, { recursive: true });
    const header = 'Api Name,Api Type,Api File Path,Api Prefix,Api Params,API Args,Invoke Method,Invoke Location,Api Key,Invoke Instance,ChangeId,MethodDefinition\\r\\n';
    const row = (location) => 'run,method,a.d.ts,A,,,run,' + location + ',key,,"' + changes[0].interfaceChanges.id + '","run(): void"\\r\\n';
    await writeFile(path.join(out, 'raw.csv'), header + row('entry/A.ets:1:1') + row('entry/Outside.ets:1:1'));
  `);
  const api = {
    implementLanguage: 'typeScript', completePath: '/sdk/a.d.ts', className: 'A',
    interfaceType: 'method', interfaceName: 'run', methodDefinition: 'run(): void',
  };
  const rule = {
    provider: 'DEVECO', ruleId: 'index-rule', changedInSdk: '6.0.0(20) Beta1', affectedVersions: 'ALL',
    changeType: 'API Behavior Change', changeOperation: 'API_BEHAVIOR', sourceReference: 'a.md:1',
    title: 'index backend rule', url: '', rawEntry: { affectedApis: [api], interfaceChanges: { id: 'source-id' } },
  };
  const result = await runScanInBatch('upgrade', {
    toolchain: {
      apiChangeBackend: 'index', apiChangeScan: fake, analyzerRoot: root, sdkRoot: '/fake/sdk',
      sdkFamilies: { openharmony: '/fake/sdk/default/openharmony/ets', hms: '/fake/sdk/default/hms/ets' },
    },
    project: {
      root, modules: [{ name: 'entry', root: moduleRoot, relativeRoot: 'entry' }],
      selectedModules: [{ name: 'entry', root: moduleRoot, relativeRoot: 'entry' }],
      scanDirs: [{ absolute: root, relative: '.' }],
      sourceFiles: [source, ...Array.from({ length: 10_000 }, (_, index) => path.join(
        moduleRoot, 'generated', 'long-source-directory', `File${index}.ets`,
      ))],
      sourceSnapshot: 'snapshot',
    },
    range: {
      start: { platformVersion: '5.0.0', apiLevel: 12, channel: 'release', channelNumber: 0 },
      end: { platformVersion: '6.0.0', apiLevel: 20, channel: 'beta', channelNumber: 1 },
    },
    rules: [rule], outputDirectory: output,
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]['Rule ID'], 'index-rule');
  assert.equal(result.findings[0]['Code Location'], 'entry/A.ets:1');
  assert.equal(result.diagnostics.backend, 'index');
});

test('reports an explicit capability error when the index backend is asked to scan C++', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'index-cpp-backend-'));
  const moduleRoot = path.join(root, 'entry');
  const source = path.join(moduleRoot, 'main.cpp');
  await mkdir(moduleRoot);
  await writeFile(source, 'int main() { return 0; }\n');
  await assert.rejects(runScanInBatch('upgrade', {
    toolchain: { apiChangeBackend: 'index', apiChangeScan: '/fake/index.js', layoutDiagnostics: { scannerCandidates: [] } },
    project: {
      root, modules: [{ name: 'entry', root: moduleRoot, relativeRoot: 'entry' }],
      selectedModules: [{ name: 'entry', root: moduleRoot, relativeRoot: 'entry' }],
      scanDirs: [{ absolute: root, relative: '.' }], sourceFiles: [source], sourceSnapshot: 'snapshot',
    },
    range: {}, outputDirectory: root,
    rules: [{ provider: 'DEVECO', ruleId: 'cpp', rawEntry: { affectedApis: [
      { implementLanguage: 'c', methodDefinition: 'int OH_Run(void)' },
    ], interfaceChanges: {} } }],
  }), { code: 'C_CPP_BACKEND_UNAVAILABLE' });
});

test('batch output keeps an empty scan table and its JSON bound to the same ID',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'batch-scan-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const batchId='abcdef012345';
  const result=await runScanInBatch('upgrade', {project:{root,modules:[],sourceFiles:[],sourceSnapshot:'empty',scanDirs:[]},
    toolchain:{},rules:[],range:{},outputDirectory:root,batchId,mode:'upgrade'});
  assert.equal(path.basename(result.outputCsv),`scan-results-${batchId}.csv`);
  assert.equal(result.outputCsv,path.join(root,'upgrade','project',`scan-results-${batchId}.csv`));
  assert.equal(result.validationCsv,null);
  assert.equal(result.scanJson,path.join(root,'.internal','upgrade','project','scans',batchId,'scanner',`scan-results-${batchId}.scan.json`));
  await assert.rejects(readFile(path.join(root,`scan-results-${batchId}.validation.csv`)),{code:'ENOENT'});
  assert.equal(JSON.parse(await readFile(result.scanJson,'utf8')).batchId,batchId);
  assert.ok((await readFile(result.outputCsv,'utf8')).includes('Api Definition'));
  assert.deepEqual(parseCsv(await readFile(result.outputCsv,'utf8')), {headers:UPGRADE_HEADERS,rows:[]});
  assert.deepEqual((await readdir(root)).sort(),['.internal','upgrade']);
});

test('empty deprecated scans still publish the eight-column table and complete JSON', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'empty-deprecated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runScanInBatch('deprecated', {
    project: { root, modules: [], sourceFiles: [], sourceSnapshot: 'empty', scanDirs: [] },
    toolchain: {}, rules: [], range: {}, outputDirectory: root,
    deprecations: { findings: [], unresolved: [], coverage: { status: 'COMPLETE' } },
  });
  assert.deepEqual(parseCsv(await readFile(result.outputCsv, 'utf8')), { headers: DEPRECATED_HEADERS, rows: [] });
  const scan = JSON.parse(await readFile(result.scanJson, 'utf8'));
  assert.equal(scan.schemaVersion, 4);
  assert.deepEqual(scan.findings, []);
  assert.deepEqual(scan.actionGroups, []);
});

for (const mode of ['upgrade', 'deprecated']) test(`${mode} rechecks the feature directory before publishing scan bytes`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-delivery-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'scanner-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const directory = path.join(root, '20261027172821');
  await mkdir(directory);
  const layout = await createScanBatch(root, directory, { mode });
  await assert.rejects(runScanInBatch(mode, {
    project: { root, modules: [], sourceFiles: [], sourceSnapshot: 'empty', scanDirs: [] },
    toolchain: {}, rules: [], range: {}, outputDirectory: directory, batchId: layout.batchId,
    verifyInputs: async () => {
      await rm(layout.deliveryDirectory, { recursive: true });
      await symlink(outside, layout.deliveryDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    },
  }), { code: 'SCAN_BATCH_INVALID' });
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(readFile(layout.scanJson), { code: 'ENOENT' });
});

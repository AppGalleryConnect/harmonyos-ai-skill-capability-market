import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, ensureDir, exists, portableRelative, sha256, sha256File } from '../../shared/io/fs-utils.mjs';
import { DEPRECATED_HEADERS, hyperlink, hyperlinkUrl, parseCsv, SCANNER_HEADERS, stringifyCsv, titleText, UPGRADE_HEADERS } from '../../shared/format/csv.mjs';
import { canonicalHarmonyVersion as canonicalVersion, compareHarmonyVersions as compareVersions, devecoVersionName, parseVersion } from '../../shared/platform/version.mjs';
import { locationInsideScanDirs, canonicalSourceFile } from './project.mjs';
import {
  classifyDeprecatedFindings,
  VALIDATION_HEADERS,
} from '../deprecated/result-groups.mjs';
import { runProcess } from '../../shared/platform/process.mjs';
import { ruleDocumentLink } from '../../shared/platform/document-links.mjs';
import { retryFileOperation } from '../../shared/platform/fs.mjs';
import { inside } from '../../shared/platform/source-scope.mjs';
import { batchArtifactPaths, ensureBatchDirectory } from '../../shared/platform/artifact-layout.mjs';
import { requireScanMode } from '../../shared/platform/scan-mode.mjs';
import { parseCodeLocation } from '../../shared/platform/paths.mjs';
import { errorWithCode } from '../../shared/platform/errors.mjs';
import cppCompat from '../bin/deveco-cpp-compat.cjs';
import { listZipEntries } from '../../shared/format/zip.mjs';
import { scanRnohImpacts, verifyRnohInputs } from '../rnoh/rnoh.mjs';

const TYPE_RANK = new Map([
  ['API Behavior Change', 0],
  ['UX Interaction Behavior Change', 1],
  ['UX Visual Layout Change', 2],
  ['Deprecated API', 3],
  ['API Definition Change', 4],
]);

const devecoWorkerCompat = fileURLToPath(new URL('../bin/deveco-worker-compat.cjs', import.meta.url));
const devecoCppCompat = fileURLToPath(new URL('../bin/deveco-cpp-compat.cjs', import.meta.url));

const IDE_CPP_ENGINE_CLASS = 'com/huawei/deveco/programanalysis/apiscan/capiscan/CAPIScanner.class';

// VERIFIED: the build is in the manually verified table. ANCHOR_MATCHED: an unlisted build whose CLI source
// still carries every adaptation anchor exactly once. NATIVE: run DevEco's own C/C++ scan unadapted.
export async function cppEnhancement(toolchain) {
  const native = { tier: 'NATIVE', ide: false };
  if (toolchain.apiChangeBackend !== 'integrated' || !toolchain.hashes?.apiChangeScan) return native;
  const bytes = await readFile(toolchain.apiChangeScan).catch(() => null);
  if (!bytes || sha256(bytes) !== toolchain.hashes.apiChangeScan) return native;
  const applies = cppCompat.probe(bytes.toString('utf8'));
  if (applies.ide && cppCompat.buildForCli(toolchain.hashes.apiChangeScan)) return { tier: 'VERIFIED', ide: true };
  return applies.timeout ? { tier: 'ANCHOR_MATCHED', ide: applies.ide } : native;
}

async function anchoredIdeClasspath(toolchain, fingerprint) {
  if (!toolchain.cApiScanJar || !toolchain.java) return null;
  const library = path.join(path.dirname(toolchain.apiChangeScan), 'lib');
  const candidates = (await readdir(library).catch(() => [])).filter(name => /^fastjson2-\d[\w.]*\.jar$/.test(name));
  if (candidates.length !== 1) return null;
  const entries = await listZipEntries(toolchain.cApiScanJar).catch(() => []);
  if (!entries.includes(IDE_CPP_ENGINE_CLASS)) return null;
  const json = path.join(library, candidates[0]);
  return { json, build: { ideJar: toolchain.hashes?.cApiScanJar ?? await fingerprint(toolchain.cApiScanJar), jsonJar: await fingerprint(json) } };
}

export async function ideCppClasspath(toolchain, fingerprint = sha256File, enhancement = null) {
  if (enhancement?.tier === 'NATIVE') return null;
  let build = cppCompat.buildForCli(toolchain.hashes?.apiChangeScan);
  let json;
  if (enhancement?.tier === 'ANCHOR_MATCHED') {
    const anchored = enhancement.ide ? await anchoredIdeClasspath(toolchain, fingerprint) : null;
    if (!anchored) return null;
    ({ json, build } = anchored);
  } else {
    if (toolchain.apiChangeBackend !== 'integrated' || !build
      || toolchain.hashes?.apiChangeScan !== build.cli || toolchain.hashes?.cApiScanJar !== build.ideJar
      || !toolchain.cApiScanJar || !toolchain.java) return null;
    json = path.join(path.dirname(toolchain.apiChangeScan), 'lib', build.jsonJarName);
    if (!await exists(json) || await fingerprint(json) !== build.jsonJar) return null;
  }
  const library = path.dirname(toolchain.cApiScanJar);
  const dependencies = (await readdir(library)).filter(name => /^(?:org\.eclipse\.|org\.osgi\.service\.prefs|osgi\.annotation).*\.jar$/.test(name)).sort();
  return [{ file: toolchain.cApiScanJar, sha256: build.ideJar }, { file: json, sha256: build.jsonJar },
    ...await Promise.all(dependencies.map(async name => {
      const file = path.join(library, name);
      return { file, sha256: await fingerprint(file) };
    }))];
}

export async function probeIdeCpp(toolchain, classpath, launch = runProcess) {
  const result = await launch(toolchain.java, cppCompat.ideJavaArgs(classpath, '--probe'), {
    cwd: toolchain.analyzerRoot, timeoutMs: 15_000,
  });
  return result.exitCode === 0 && !result.error && !result.timedOut
    && result.stdout.split(/\r?\n/).includes('HARMONY_CPP_IDE_READY');
}

export async function cppScanBudget(toolchain, requestedSeconds, legacyWatchdogMs, fingerprint = sha256File, enhancement = null) {
  const build = toolchain.apiChangeBackend === 'integrated' && enhancement?.tier !== 'NATIVE'
    ? cppCompat.buildForCli(toolchain.hashes?.apiChangeScan) : null;
  const anchored = !build && enhancement?.tier === 'ANCHOR_MATCHED';
  if (build || anchored) {
    const file = cppCompat.nativeJarPath(toolchain.apiChangeScan);
    const sha = await fingerprint(file).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    });
    if (sha && (anchored || sha === build.nativeJar)) {
      const jarTimeoutSeconds = requestedSeconds ?? 900;
      return { jarTimeoutSeconds, fileTimeoutSeconds: 60, watchdogMs: (jarTimeoutSeconds + 30) * 1000, backendJar: { file, sha256: sha },
        ...(anchored ? { enhancement: 'ANCHOR_MATCHED' } : {}) };
    }
  }
  if (requestedSeconds !== undefined)
    throw errorWithCode(`当前 DevEco Studio ${toolchain.productInfo?.version ?? '未知版本'} 不在 C/C++ 增强扫描的已验证构建内，其 CLI 也与增强补丁不匹配，`
      + '无法指定 C/C++ 模块超时。请去掉 --cpp-module-timeout-seconds 后重试，或改用已验证构建。', 'CPP_MODULE_TIMEOUT_UNSUPPORTED',
      { installedBuild: toolchain.productInfo?.version ?? null, verifiedBuilds: Object.keys(cppCompat.supportedBuilds) });
  return { jarTimeoutSeconds: null, fileTimeoutSeconds: null, watchdogMs: legacyWatchdogMs };
}

async function execute(command, args, options, timeoutMs = null, isolateFailure = false) {
  const result = await runProcess(command, args, { ...options, timeoutMs });
  if (result.error && !isolateFailure) throw new Error(result.error);
  return {
    code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    error: result.error,
  };
}

export function interpretDevEcoOutput(processResult, { nativePass = false } = {}) {
  const combined = `${processResult.stdout}\n${processResult.stderr}`;
  if (nativePass && !processResult.timedOut && /\b(?:DOS error(?:\/errno)?\s*[:=]?\s*1455|ERROR_COMMITMENT_LIMIT)\b/i.test(combined)) {
    return { cppStatus: 'FAILED', failureReason: 'JAR_COMMITMENT_LIMIT', skippedFiles: [], discardRows: true,
      warnings: ['C++ JAR 遇到 Windows 内存提交限制（1455）'] };
  }
  if (processResult.code !== 0) {
    const error = new Error(`DevEco API scan exited with code ${processResult.code}`);
    error.code = 'DEVECO_SCAN_FAILED';
    error.details = { stdout: processResult.stdout.slice(-12000), stderr: processResult.stderr.slice(-12000) };
    throw error;
  }
  const cppTimeoutCount = [...combined.matchAll(/error\[20004\]/gi)].length;
  if (/falling back to grep|with grep|error\[2000(?:1|2|3|5)\]/i.test(combined)) {
    const error = new Error('DevEco scanner reported a semantic failure or requested an inaccurate fallback');
    error.code = 'DEVECO_SCAN_DEGRADED';
    error.details = { stdout: processResult.stdout.slice(-12000), stderr: processResult.stderr.slice(-12000) };
    throw error;
  }
  const count = nativePass && processResult.stdout.match(/C\+\+ scan completed: (\d+) files,/);
  const scannedFileCount = count ? Number(count[1]) : null;
  const javaFailure = nativePass && /Java process exited with code|Failed to parse C\+\+ JAR output/i.test(combined);
  const skippedFiles = new Set();
  for (const line of processResult.stderr.split(/\r?\n/)) {
    if (!line.startsWith(cppCompat.skippedPrefix)) continue;
    const files = JSON.parse(line.slice(cppCompat.skippedPrefix.length));
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !file.trim()))
      throw errorWithCode('Invalid DevEco C++ skipped file evidence', 'DEVECO_SCAN_DEGRADED');
    for (const file of files) skippedFiles.add(file);
  }
  const warnings = [];
  if (cppTimeoutCount) warnings.push(`C++扫描超时${cppTimeoutCount}次，已继续生成报告；C++结果可能不完整，需人工复核`);
  if (skippedFiles.size) warnings.push(`C++语义扫描跳过 ${skippedFiles.size} 个文件，已保留完成的语义结果`);
  if (processResult.stderr.includes('HARMONY_CPP_CANDIDATES_FAILED ')) warnings.push('C++ 文本候选未能保存，已保留语义结果及覆盖缺口');
  const emptyScan = scannedFileCount === 0 && !skippedFiles.size;
  const heapExhausted = /Java heap space|java\.lang\.OutOfMemoryError/i.test(processResult.stderr);
  const failureReason = cppTimeoutCount || !(javaFailure || emptyScan) ? null
    : heapExhausted ? 'JAR_OUT_OF_MEMORY' : javaFailure ? 'JAR_EXECUTION_FAILED' : 'NO_SCANNED_FILES';
  if (failureReason === 'JAR_OUT_OF_MEMORY') warnings.push('C++ JAR 堆内存耗尽，已保留其他可验证的扫描结果');
  if (failureReason === 'JAR_EXECUTION_FAILED') warnings.push('C++ JAR 执行失败，已保留其他可验证的扫描结果');
  if (failureReason === 'NO_SCANNED_FILES') warnings.push('C++后端回报已扫描 0 个文件，覆盖未取得');
  return {
    cppStatus: cppTimeoutCount ? 'TIMED_OUT' : failureReason ? 'FAILED' : skippedFiles.size ? 'PARTIAL' : 'COMPLETE',
    skippedFiles: [...skippedFiles],
    scannedFileCount,
    failureReason,
    timeoutSource: cppTimeoutCount ? processResult.timedOut ? 'SKILL_WATCHDOG' : 'DEVECO_JAR' : null,
    warnings,
  };
}

function interpretNativePass(processResult, isolateFailure, enhanced) {
  try { return interpretDevEcoOutput(processResult, { nativePass: true }); }
  catch (error) {
    // The unadapted CLI mixes grep hits into its rows. Drop this module's C++ rows and keep every other result.
    if (!enhanced && error.code === 'DEVECO_SCAN_DEGRADED')
      return { cppStatus: 'FAILED', failureReason: 'UNVERIFIED_BUILD_FALLBACK', skippedFiles: [],
        warnings: ['DevEco 原生 C/C++ 扫描退回了文本匹配，已丢弃该模块的 C/C++ 结果并保留其他结果'], discardRows: true };
    if (!isolateFailure || !['DEVECO_SCAN_FAILED', 'DEVECO_SCAN_DEGRADED'].includes(error.code)) throw error;
    return { cppStatus: 'FAILED', failureReason: /Java heap space|java\.lang\.OutOfMemoryError/i.test(processResult.stderr)
      ? 'JAR_OUT_OF_MEMORY' : 'JAR_EXECUTION_FAILED', skippedFiles: [], warnings: ['C++ IDE 引擎执行失败，已保留其他模块结果'], discardRows: true };
  }
}

export async function retryCppCommitFailure(first, retry, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || first.interpretation.failureReason !== 'JAR_COMMITMENT_LIMIT'
    || Object.entries(env).some(([key, value]) => /^(JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i.test(key) && value?.trim())) return first;

  const budget = first.budget;
  const remainingMs = (budget.jarTimeoutSeconds ? budget.jarTimeoutSeconds * 1000 : budget.watchdogMs) - first.durationMs;
  const remainingSeconds = Math.floor(remainingMs / 1000);
  if (remainingSeconds < 60) return first;
  const retryBudget = budget.jarTimeoutSeconds
    ? { ...budget, jarTimeoutSeconds: remainingSeconds, watchdogMs: (remainingSeconds + 30) * 1000 }
    : { ...budget, watchdogMs: remainingMs };
  const javaToolOptions = '-Xmx1g -Xms256m';
  const second = await retry(retryBudget, javaToolOptions);
  const memoryRetry = { reason: 'JAR_COMMITMENT_LIMIT', javaToolOptions,
    budget: { jarTimeoutSeconds: retryBudget.jarTimeoutSeconds, watchdogMs: retryBudget.watchdogMs },
    first: { code: first.processResult.code, durationMs: first.durationMs,
      stdout: first.processResult.stdout.slice(-8000), stderr: first.processResult.stderr.slice(-8000) },
    status: second.interpretation.cppStatus, failureReason: second.interpretation.failureReason ?? null, durationMs: second.durationMs };
  return { ...second, budget, memoryRetry, durationMs: first.durationMs + second.durationMs, interpretation: { ...second.interpretation,
    warnings: [`C++ JAR 因 Windows 内存提交限制（1455）使用小堆重试，结果 ${memoryRetry.status}`, ...second.interpretation.warnings] } };
}

function normalizeCodeLocation(project, location) {
  const fallback = String(location).replaceAll('\\', '/');
  let parsed;
  try { parsed = parseCodeLocation(location); } catch { return fallback; }
  let file = path.normalize(parsed.file);
  if (!path.isAbsolute(file)) {
    const segments = file.split(path.sep);
    const owner = project.modules?.find(candidate => candidate.name === segments[0] || path.basename(candidate.root) === segments[0]);
    file = owner ? path.join(owner.root, ...segments.slice(1)) : path.resolve(project.root, file);
    if (!project.sourceFiles) return fallback;
  }
  const actual = canonicalSourceFile(project, file);
  if (project.sourceFiles && !actual) return fallback;
  file = actual ?? file;
  const suffix = `:${parsed.line}${parsed.column ? `:${parsed.column}` : ''}`;
  const module = project.modules?.find((candidate) => {
    const relation = path.relative(candidate.root, file);
    return relation !== '' && !relation.startsWith('..') && !path.isAbsolute(relation);
  });
  if (module) {
    return `${module.name}/${portableRelative(module.root, file)}${suffix}`;
  }
  const relative = portableRelative(project.root, file);
  if (relative.startsWith('../') || relative === '..') return fallback;
  return `${relative}${suffix}`;
}

function normalizeFinding(row, rule, project = null, mode) {
  requireScanMode(mode);
  const originalUrl = hyperlinkUrl(row.Title);
  const link = ruleDocumentLink(rule, originalUrl, { requireEntry: mode === 'upgrade' });
  return {
    'Api Definition': row['Api Definition'],
    Language: row.Language === 'C++' ? 'C' : row.Language,
    'Changed in SDK': rule.changedInSdk || row['Changed in SDK'],
    'Affected Versions': rule.affectedVersions ?? row['Affected Versions'],
    Title: hyperlink(link.url, rule.title),
    documentLink: link,
    'Code Location': project
      ? normalizeCodeLocation(project, row['Code Location'])
      : String(row['Code Location']).replaceAll('\\', '/'),
    Fixed: 'Unfixed',
    ...(mode === 'upgrade' && row.Column !== undefined ? { Column: row.Column } : {}),
    'Change Type': rule.changeType,
    'Rule ID': String(rule.ruleId),
    'Change Operation': rule.changeOperation,
    'Source Reference': rule.sourceReference,
    'Replacement API': rule.replacementApi ?? '',
    'Replacement Source': rule.replacementSource ?? '',
    includedInCsv: true,
    disposition: 'REQUIRES_REVIEW',
    filterReason: null,
    applicabilityProof: null,
  };
}

function normalizeApiDefinition(value) {
  return String(value).replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
}

function compareFindings(left, right) {
  const level = finding => finding['Deprecated Since'] !== undefined && finding['Deprecated Since'] !== ''
    ? Number(finding['Deprecated Since']) : finding['Changed in SDK'] ? parseVersion(finding['Changed in SDK']).apiLevel : 0;
  const leftLevel = level(left);
  const rightLevel = level(right);
  const versionRank = !left['Changed in SDK'] || !right['Changed in SDK']
    ? (leftLevel ?? 0) - (rightLevel ?? 0)
    : compareVersions(left['Changed in SDK'], right['Changed in SDK']);
  const values = [
    versionRank,
    (TYPE_RANK.get(left['Change Type']) ?? 99) - (TYPE_RANK.get(right['Change Type']) ?? 99),
    left['Rule ID'].localeCompare(right['Rule ID']),
    left.Language.localeCompare(right.Language),
    left['Code Location'].localeCompare(right['Code Location'], undefined, { numeric: true }),
    Number(left.Column ?? 0) - Number(right.Column ?? 0),
    left['Api Definition'].localeCompare(right['Api Definition']),
  ];
  return values.find((value) => value !== 0) ?? 0;
}

function deduplicate(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = row.occurrenceId ?? [row['Rule ID'], row['Api Definition'], row.Language, row['Code Location'], row.Column ?? ''].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function collectCppTextCandidates(project, scanRuleMap, passes) {
  const candidates = new Map();
  for (const pass of passes) for (const hit of pass.textHits ?? []) {
    const record = scanRuleMap.get(hit.scanId);
    const module = project.modules.find(item => item.name === pass.modules[0]);
    if (!record || !module || typeof hit.file !== 'string' || !path.isAbsolute(hit.file) || !inside(module.root, hit.file)
      || !Number.isSafeInteger(hit.line) || hit.line < 1) continue;
    const location = normalizeCodeLocation(project, `${hit.file}:${hit.line}`);
    if (!locationInsideScanDirs(project, location)) continue;
    for (const { rule, api } of record.bindings) {
      const candidate = { module: module.name, ruleId: String(rule.ruleId), api: api.methodDefinition, location };
      candidates.set(JSON.stringify(candidate), candidate);
    }
  }
  return [...candidates.values()].sort((a, b) => a.module.localeCompare(b.module) || a.location.localeCompare(b.location, undefined, { numeric: true })
    || a.ruleId.localeCompare(b.ruleId) || a.api.localeCompare(b.api));
}

async function findOfficialCsv(directory) {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.csv')).sort();
  if (files.length !== 1) throw new Error(`Expected one DevEco CSV, found ${files.length}`);
  return path.join(directory, files[0]);
}

async function readCsvOutputs(directory) {
  const files = (await readdir(directory)).filter(name => name.endsWith('.csv')).sort();
  if (files.length === 0) throw new Error('DevEco scanner did not produce a CSV');
  const parsed = await Promise.all(files.map(async file => parseCsv(await readFile(path.join(directory, file), 'utf8'))));
  return {
    headers: [...new Set(parsed.flatMap(item => item.headers))],
    rows: parsed.flatMap(item => item.rows),
  };
}

function normalizeIndexRow(row) {
  const location = String(row['Invoke Location'] ?? '');
  const withColumn = location.match(/^(.*?:\d+):(\d+)$/);
  return {
    'Api Definition': row.MethodDefinition ?? row['Api Name'] ?? '',
    Language: 'ArkTS',
    ChangeId: row.ChangeId,
    'Code Location': withColumn ? withColumn[1] : location,
    Column: withColumn ? Number(withColumn[2]) : undefined,
  };
}

export function rulesForProject(rules, project) {
  const hasArkTs = project.sourceFiles.some((file) => /\.(?:ets|ts)$/i.test(file));
  const hasCpp = project.sourceFiles.some((file) => /\.(?:c|cc|cpp|cxx)$/i.test(file));
  const groups = { typescript: new Map(), c: new Map() };
  const scanRuleMap = new Map();
  for (const rule of rules) {
    for (const api of rule.rawEntry.affectedApis) {
      const language = String(api.implementLanguage).toLowerCase();
      if (language === 'typescript' && !hasArkTs) continue;
      if (language === 'c' && !hasCpp) continue;
      if (!(language in groups)) continue;
      const identity = [
        rule.provider ?? 'UNKNOWN', language, api.completePath, api.className, api.interfaceType, api.interfaceName,
        normalizeApiDefinition(api.methodDefinition), api.invokeInstance ?? '',
      ].join('\u0000');
      let scanId = groups[language].get(identity);
      if (!scanId) {
        scanId = `scan-${sha256(identity).slice(0, 20)}`;
        groups[language].set(identity, scanId);
        scanRuleMap.set(scanId, { api, provider: rule.provider ?? 'UNKNOWN', rules: [], bindings: [] });
      }
      const record = scanRuleMap.get(scanId);
      if (!record.rules.some((candidate) => candidate.ruleId === rule.ruleId)) record.rules.push(rule);
      if (!record.bindings.some((binding) => binding.rule.ruleId === rule.ruleId)) record.bindings.push({ rule, api });
    }
  }
  const toEntries = (language) => [...groups[language].values()].map((scanId) => {
    const record = scanRuleMap.get(scanId);
    const source = record.rules[0].rawEntry;
    return {
      ...source,
      __provider: record.provider,
      affectedApis: [record.api],
      interfaceChanges: { ...source.interfaceChanges, id: scanId },
    };
  });
  const arkTsEntries = toEntries('typescript');
  const cppEntries = toEntries('c');
  return {
    entries: [...arkTsEntries, ...cppEntries],
    arkTsEntries,
    cppEntries,
    scanRuleMap,
    hasArkTs,
    hasCpp,
  };
}

export async function cleanupScanDirectory(directory, remove = rm) {
  try {
    await retryFileOperation(() => remove(directory, { recursive: true, force: true }));
    return null;
  } catch (error) {
    return { code: 'SCAN_TEMP_CLEANUP_FAILED', path: directory, errorCode: error.code, message: error.message };
  }
}

export async function runDevEcoScan({ toolchain, project, range, rules, outputDirectory, batchId, outputLayout=null, deprecations = null,
  buildLogImport = null, devecoVersionNames = {}, runtime = null, mode, officialComparison = null, projectApplicability = null,
  verifyInputs = async () => {}, verifyNativeInputs = async () => {}, nativeBuilds = [], cppModuleTimeoutSeconds, cppPassTimeoutMs = 240_000, removeTemporary = rm }) {
  requireScanMode(mode);
  const layout = outputLayout ?? batchArtifactPaths(outputDirectory, batchId, mode);
  await ensureBatchDirectory(layout, layout.scannerDirectory);
  await ensureBatchDirectory(layout, layout.deliveryDirectory);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'harmony-api-scan-'));
  const startedAt = Date.now();
  const projectRules = rulesForProject(rules, project);
  let result, failure;
  try {
    const selectedModules = project.selectedModules ?? project.modules;
    const cppModules = selectedModules.filter((module) => project.sourceFiles.some((file) => {
      if (!/\.(?:c|cc|cpp|cxx)$/i.test(file)) return false;
      const relation = path.relative(module.root, file);
      return relation !== '' && !relation.startsWith('..') && !path.isAbsolute(relation);
    }));
    if (toolchain.apiChangeBackend === 'index' && projectRules.cppEntries.length > 0 && cppModules.length > 0) {
      const error = new Error('The discovered DevEco index backend cannot scan C/C++ API changes');
      error.code = 'C_CPP_BACKEND_UNAVAILABLE';
      error.details = toolchain.layoutDiagnostics;
      throw error;
    }
    const hasNativePass = projectRules.cppEntries.length && cppModules.length;
    const enhancement = hasNativePass ? await cppEnhancement(toolchain) : null;
    const candidateClasspath = hasNativePass && nativeBuilds.length ? await ideCppClasspath(toolchain, sha256File, enhancement) : null;
    const classpath = candidateClasspath && await probeIdeCpp(toolchain, candidateClasspath) ? candidateClasspath : null;
    const ideBudget = cppModuleTimeoutSeconds ?? 900;
    const buildContexts = new Map(nativeBuilds.map(record => [record.module, record.selectedNinja]));
    const legacyBudget = hasNativePass && (!classpath || cppModules.some(module => !buildContexts.get(module.name)))
      ? await cppScanBudget(toolchain, cppModuleTimeoutSeconds, cppPassTimeoutMs, sha256File, enhancement) : null;
    const installedBuild = `当前 DevEco Studio ${toolchain.productInfo?.version ?? '未知版本'} 不在 C/C++ 增强扫描的已验证构建（${Object.keys(cppCompat.supportedBuilds).join('、')}）内，`;
    const cppBuildNotice = [];
    if (hasNativePass && toolchain.apiChangeBackend === 'integrated') {
      if (!classpath && !legacyBudget?.jarTimeoutSeconds)
        cppBuildNotice.push(`DevEco ${toolchain.productInfo?.version ?? '未知版本'} 的 C/C++ 增强扫描结构或依赖未通过检查，已使用原生扫描，外层预算 ${cppPassTimeoutMs / 1000} 秒`);
      else if (enhancement.tier === 'ANCHOR_MATCHED')
        cppBuildNotice.push(`${installedBuild}已按 CLI 结构匹配启用增强扫描，实际引擎和预算见 nativePasses`);
    }
    if (hasNativePass && enhancement.ide && nativeBuilds.length && !candidateClasspath)
      cppBuildNotice.push('DevEco IDE C/C++ 引擎的 JAR 或依赖未通过检查，改用 CLI 扫描，预算见 nativePasses');
    if (candidateClasspath && !classpath) cppBuildNotice.push('DevEco IDE C/C++ 引擎的 JBR 入口或依赖自检失败，改用 CLI 扫描，预算见 nativePasses');
    const runPassAttempt = async (name, entries, modules, files, recovery = null) => {
      if (entries.length === 0 || modules.length === 0 || files?.length === 0) {
        return { rows: [], processResult: { stdout: '', stderr: '' }, interpretation: { cppStatus: 'NOT_APPLICABLE', warnings: [] } };
      }
      const isCpp = name.startsWith('cpp-');
      if (isCpp) await verifyNativeInputs();
      const passRoot = path.join(temporary, name);
      const officialOutput = path.join(passRoot, 'official');
      const apiChangesPath = path.join(passRoot, 'api-changes.json');
      await ensureDir(officialOutput);
      await writeFile(apiChangesPath, `${JSON.stringify(entries)}\n`);
      if (toolchain.apiChangeBackend === 'index') {
        const tmpPath = path.join(passRoot, 'tmp');
        const logPath = path.join(passRoot, 'APIScan.log');
        const configPath = path.join(passRoot, 'scanner-config.json');
        await ensureDir(tmpPath);
        await writeFile(configPath, `${JSON.stringify({
          projectPath: project.sourceScope ? modules.map(module => module.root) : project.root,
          sdks: Object.entries(toolchain.sdkFamilies ?? {}).map(([family, etsRoot]) => ({
            name: family === 'openharmony' ? 'ohos' : family,
            path: etsRoot,
          })),
          outPath: officialOutput,
        }, null, 2)}\n`);
        const processResult = await execute(process.execPath, [
          '--require', devecoWorkerCompat,
          toolchain.apiChangeScan,
          '--configPath', configPath,
          '--apiModifiedPath', apiChangesPath,
          '--outPath', officialOutput,
          '--tmpPath', tmpPath,
          '--logPath', logPath,
          '--batchSize', '1000',
          ...(files ? ['--scanFilePaths', files.join(',')] : []),
        ], {
          cwd: passRoot,
          env: { ...process.env, DEVECO_HOME: toolchain.contentsRoot, DEVECO_SDK_HOME: toolchain.sdkRoot },
        });
        if (await exists(logPath)) processResult.stderr += `\n${await readFile(logPath, 'utf8')}`;
        const interpretation = interpretDevEcoOutput(processResult);
        const csv = await readCsvOutputs(officialOutput);
        return { rows: csv.rows.map(normalizeIndexRow), headers: ['ChangeId'], processResult, interpretation };
      }
      const ninja = isCpp && buildContexts.get(modules[0].name);
      const ide = Boolean(ninja && classpath);
      const budget = recovery?.budget ?? (ide ? { jarTimeoutSeconds: ideBudget, fileTimeoutSeconds: 60, watchdogMs: (ideBudget + 30) * 1000,
        backendJar: classpath[0], engine: 'DEVECO_IDE', dependencies: classpath.slice(1),
        ...(enhancement.tier === 'ANCHOR_MATCHED' ? { enhancement: 'ANCHOR_MATCHED' } : {}) } : legacyBudget);
      const jar = isCpp && budget.backendJar ? budget.backendJar.file : toolchain.cApiScanJar;
      if (isCpp && (!jar || !toolchain.java)) {
        const error = new Error('DevEco C/C++ scanner components are unavailable');
        error.code = 'C_CPP_BACKEND_UNAVAILABLE';
        error.details = toolchain.layoutDiagnostics;
        throw error;
      }
      const args = [
        toolchain.apiChangeScan,
        '--startVersion', devecoVersionNames[canonicalVersion(range.start)] ?? devecoVersionName(range.start),
        '--endVersion', devecoVersionNames[canonicalVersion(range.end)] ?? devecoVersionName(range.end),
        ...(files ? [name.startsWith('cpp-') ? '--cppFiles' : '--arkTsFiles', files.join(',')]
          : ['--modulePaths', modules.map(module => module.root).join(',')]),
        '--sdkPath', toolchain.sdkRoot,
        '--apiModifiedPath', apiChangesPath,
        '--outputPath', officialOutput,
      ];
      if (jar) args.push('--cApiScanJarPath', jar);
      if (isCpp && budget.jarTimeoutSeconds) {
        const prefix = [devecoCppCompat, toolchain.apiChangeScan, String(budget.jarTimeoutSeconds)];
        if (toolchain.hashes?.apiChangeScan) prefix.push('--expect', `${toolchain.hashes.apiChangeScan},${ide ? '' : budget.backendJar.sha256}`);
        if (ide) {
          const config = path.join(passRoot, 'ide-cpp.json');
          const allowedFiles = (files ?? project.sourceFiles).filter(file => inside(modules[0].root, file));
          await writeFile(config, JSON.stringify({ java: toolchain.java, ninja, classpath, allowedFiles }));
          prefix.push('--ide-config', config);
        }
        args.splice(0, 1, ...prefix);
      }
      const started = performance.now();
      const isolateFailure = ide || Boolean(recovery);
      const processResult = await execute(process.execPath, args, {
        detached: isCpp,
        cwd: toolchain.analyzerRoot,
        env: {
          ...process.env,
          DEVECO_HOME: toolchain.contentsRoot,
          DEVECO_SDK_HOME: toolchain.sdkRoot,
          ...(toolchain.java ? { JAVA_HOME: path.dirname(path.dirname(toolchain.java)) } : {}),
          ...(recovery ? { JAVA_TOOL_OPTIONS: recovery.javaToolOptions } : {}),
        },
      }, isCpp ? budget.watchdogMs : null, isolateFailure);
      const durationMs = Math.round(performance.now() - started);
      if (processResult.timedOut) {
        processResult.code = 0;
        processResult.stderr += `\nerror[20004] C++ semantic pass exceeded ${budget.watchdogMs}ms; process group terminated; completed rows only\n`;
        const interpretation = interpretNativePass(processResult, isolateFailure, Boolean(budget.jarTimeoutSeconds));
        const files = (await readdir(officialOutput)).filter(file => file.endsWith('.csv'));
        let csv = { rows: [], headers: [] };
        if (!interpretation.discardRows && files.length === 1) {
          try { csv = parseCsv(await readFile(path.join(officialOutput, files[0]), 'utf8')); }
          catch { interpretation.warnings.push('C++超时导致未完成CSV损坏，已跳过该批次；ArkTS结果继续生成'); }
        }
        return { rows: csv.rows, headers: csv.headers, processResult, interpretation, durationMs, budget };
      }
      if (isolateFailure && processResult.error && processResult.code === 0) processResult.code = null;
      const interpretation = isCpp ? interpretNativePass(processResult, isolateFailure, Boolean(budget.jarTimeoutSeconds)) : interpretDevEcoOutput(processResult);
      if (interpretation.discardRows) return { rows: [], headers: [], processResult, durationMs, budget, interpretation };
      const csv = parseCsv(await readFile(await findOfficialCsv(officialOutput), 'utf8'));
      const textFile = path.join(passRoot, 'text-candidates.json');
      const textHits = ide && await exists(textFile) ? JSON.parse(await readFile(textFile, 'utf8')) : [];
      return { rows: csv.rows, headers: csv.headers, processResult, interpretation, durationMs, budget, textHits };
    };
    const runPass = async (name, entries, modules, files = null) => {
      const first = await runPassAttempt(name, entries, modules, files);
      return retryCppCommitFailure(first, (budget, javaToolOptions) =>
        runPassAttempt(`${name}-memory-retry`, entries, modules, files, { budget, javaToolOptions }));
    };
    const groupedPasses = async (language, entries, modules) => {
      const exclusions = project.sourceScope?.excludedDirectories ?? project.sourceScope?.excludeDirs ?? [];
      modules = modules.filter(module => !exclusions.some(directory => inside(directory, module.root)));
      const providers = [...new Set(entries.map((entry) => entry.__provider))].sort();
      const passes = [];
      const narrowed = Boolean(project.sourceScope?.scanDirs.length) && modules.some(module =>
        !project.sourceScope.scanDirs.some(directory => inside(directory,module.root)))
        || modules.some(module => exclusions.some(directory => inside(module.root, directory)));
      const fileMode = narrowed || toolchain.apiChangeBackend === 'index' && project.sourceScope?.restricted && toolchain.fileScanSupported !== false;
      if (fileMode && toolchain.fileScanSupported === false) {
        const error = new Error('This DevEco backend cannot scan the requested file scope');
        error.code = 'SCAN_SCOPE_UNSUPPORTED'; throw error;
      }
      for (const provider of providers) {
        const selectedEntries = entries.filter(entry => entry.__provider === provider);
        if (!fileMode) {
          // The native backend owns a fixed per-invocation timeout. Keep module
          // results independent so a slow CDT parse does not erase sibling results.
          const batches = language === 'cpp' ? modules.map(module => [module]) : [modules];
          for (const [index, batch] of batches.entries())
            passes.push({ ...await runPass(`${language}-${String(provider).toLowerCase()}-${index}`, selectedEntries, batch),
              modules: batch.map(module => module.name) });
          continue;
        }
        for (const module of modules) {
          const files = project.sourceFiles.filter(file => {
            const relative = path.relative(module.root, file);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
              && (language === 'arkts' ? /\.(ets|ts)$/i : /\.(c|cc|cpp|cxx|h|hpp)$/i).test(file);
          });
          let batch = [], bytes = 0, index = 0;
          const flush = async () => {
            if (batch.length) passes.push({ ...await runPass(`${language}-${String(provider).toLowerCase()}-${index++}-${modules.indexOf(module)}`, selectedEntries, [module], batch),
              modules: [module.name] });
            batch = []; bytes = 0;
          };
          for (const file of files) {
            const size = Buffer.byteLength(file, 'utf8') + 1;
            if (file.includes(',') || size > 16000) {
              const error = new Error('DevEco cannot represent this source path in its file scope');
              error.code = 'SCAN_SCOPE_UNSUPPORTED'; throw error;
            }
            if (bytes + size > 16000) await flush();
            batch.push(file); bytes += size;
          }
          await flush();
        }
      }
      return passes;
    };
    const arkTsPasses = await groupedPasses('arkts', projectRules.arkTsEntries, selectedModules);
    const cppPasses = await groupedPasses('cpp', projectRules.cppEntries, cppModules);
    const nativePasses = cppPasses.map(pass => ({ modules: pass.modules, status: pass.interpretation.cppStatus,
      durationMs: pass.durationMs, ...pass.budget, timeoutSource: pass.interpretation.timeoutSource,
      scannedFileCount: pass.interpretation.scannedFileCount, failureReason: pass.interpretation.failureReason,
      skippedFiles: pass.interpretation.skippedFiles, ...(pass.memoryRetry ? { memoryRetry: pass.memoryRetry } : {}) }));
    const cppStatus = !nativePasses.length ? 'NOT_APPLICABLE' : nativePasses.some(pass => pass.status === 'TIMED_OUT') ? 'TIMED_OUT'
      : nativePasses.every(pass => pass.status === 'FAILED') ? 'FAILED'
        : nativePasses.some(pass => pass.status !== 'COMPLETE') ? 'PARTIAL' : 'COMPLETE';
    const textCandidates = collectCppTextCandidates(project, projectRules.scanRuleMap, cppPasses);
    const scanCoverage = { arkts: 'COMPLETE', cpp: cppStatus, nativePasses,
      ...(textCandidates.length ? { textCandidates } : {}) };
    const allPasses = [...arkTsPasses, ...cppPasses];
    const officialRows = allPasses.flatMap((pass) => pass.rows);
    const idHeader = allPasses.flatMap((pass) => pass.headers ?? []).includes('ChangeId')
      ? 'ChangeId' : 'Rule ID';
    const unresolved = [];
    const findings = [...(deprecations?.findings ?? []), ...(buildLogImport?.findings ?? [])];
    for (const row of officialRows) {
      const record = projectRules.scanRuleMap?.get(String(row[idHeader] ?? ''));
      if (!record) {
        unresolved.push({ changeId: row[idHeader] ?? '', title: row.Title, location: row['Code Location'] });
        continue;
      }
      for (const binding of record.bindings) {
        const finding = normalizeFinding({ ...row, 'Api Definition': binding.api.methodDefinition }, binding.rule, project, mode);
        if (locationInsideScanDirs(project, finding['Code Location'])) findings.push(finding);
      }
    }
    // RNOH projects add framework/JS impacts that DevEco cannot see because dependency directories are excluded.
    const rnoh = mode === 'upgrade' && officialComparison
      ? await scanRnohImpacts({ project, officialEntries: officialComparison.entries ?? [] }) : null;
    if (rnoh) findings.push(...rnoh.findings);
    if (unresolved.length) {
      const error = new Error(`DevEco results contain ${unresolved.length} unresolved rule identifiers`);
      error.code = 'UNRESOLVED_SCAN_RESULTS';
      error.details = unresolved.slice(0, 20);
      throw error;
    }
    const rawFindings = deduplicate(findings).sort(compareFindings);
    const classified = mode === 'upgrade'
      ? { findings: rawFindings.map(finding => ({ ...finding, includedInCsv: true, disposition: 'REQUIRES_REVIEW', filterReason: null })),
        actionRows: rawFindings, actionGroups: [], validationRows: [], validationGroups: [] }
      : classifyDeprecatedFindings(rawFindings);
    const allFindings = classified.findings;
    const reportedFindings = classified.actionRows;
    const filteredFindings = allFindings.filter((finding) => !finding.includedInCsv);
    const filterSummary = Object.fromEntries([...filteredFindings.reduce((counts, finding) => {
      counts.set(finding.filterReason, (counts.get(finding.filterReason) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
    const outputCsv = layout.rawCsv;
    const validationCsv = mode === 'upgrade' ? null : layout.validationCsv;
    const scanJson = layout.scanJson;
    const codeSize = await verifyInputs(rnoh);
    await verifyRnohInputs(rnoh);
    for (const item of classpath ?? []) {
      if (await sha256File(item.file) !== item.sha256)
        throw errorWithCode(`DevEco C++ engine input changed before report publication: ${item.file}`, 'SOURCE_CHANGED_DURING_SCAN');
    }
    await ensureBatchDirectory(layout, layout.deliveryDirectory);
    await ensureBatchDirectory(layout, layout.scannerDirectory);
    await ensureBatchDirectory(layout, path.dirname(outputCsv));
    const csvFindings = mode === 'deprecated'
      ? reportedFindings.map(finding => ({ ...finding, Title: titleText(finding.Title) })) : reportedFindings;
    await atomicWrite(outputCsv, stringifyCsv(mode === 'upgrade' ? UPGRADE_HEADERS : DEPRECATED_HEADERS, csvFindings));
    if (validationCsv) await atomicWrite(validationCsv, stringifyCsv(VALIDATION_HEADERS, classified.validationRows));
    await atomicWrite(scanJson, `${JSON.stringify({
      schemaVersion: 4,
      batchId,
      mode,
      runtime,
      versionResolution:{scanFromSdkVersion:range.start ? canonicalVersion(range.start) : null,scanToSdkVersion:range.end ? canonicalVersion(range.end) : null,
        compileSdkVersion:toolchain.sdkVersion ? canonicalVersion(toolchain.sdkVersion) : null},
      sourceSnapshot: project.sourceSnapshot,
      sourceScope: project.sourceScope ?? null,
      ...(mode === 'upgrade' && officialComparison ? {officialComparison} : {}),
      ...(mode === 'upgrade' && projectApplicability ? {projectApplicability} : {}),
      ...(rnoh ? { rnoh: rnoh.summary } : {}),
      scanCoverage,
      scannedFiles: project.sourceFiles.map(file => path.relative(project.root, file).split(path.sep).join('/')),
      ...(codeSize ? { codeSize } : {}),
      buildProfileHash: project.buildProfileHash,
      findingCount: allFindings.length,
      totalFindingCount: allFindings.length,
      reportedFindingCount: reportedFindings.length,
      filteredFindingCount: filteredFindings.length,
      filterSummary,
      deprecationCoverage: deprecations?.coverage ?? null,
      deprecationCatalog: deprecations?.catalogCoverage ?? null,
      unresolved: deprecations?.unresolved ?? [],
      resolutionWarnings: deprecations?.resolutionWarnings ?? [],
      buildLogImport: buildLogImport?.audit ?? null,
      actionGroups: classified.actionGroups,
      validationGroups: classified.validationGroups,
      findings: allFindings.map((finding) => ({
        findingId: `finding-${sha256(SCANNER_HEADERS.map((header) => finding[header]).join('\u0000')).slice(0, 20)}`,
        ...finding,
      })),
    }, null, 2)}\n`);
    const warnings = [
      ...cppBuildNotice,
      ...allPasses.flatMap((pass) => pass.interpretation.warnings),
      ...(deprecations?.resolutionWarnings?.some(item => item.reason === 'UNUSED_SDK_IMPORT_NOT_RESOLVED')
        ? ['SDK 存在未使用的缺失导出，已通过工程符号影响分析；详见扫描 JSON 的 resolutionWarnings'] : []),
      ...(deprecations?.resolutionWarnings?.some(item => item.reason !== 'UNUSED_SDK_IMPORT_NOT_RESOLVED')
        ? [`${deprecations.resolutionWarnings.filter(item => item.reason !== 'UNUSED_SDK_IMPORT_NOT_RESOLVED').length}处非系统模块导入未解析；相关类型证据不完整`] : []),
      ...(buildLogImport?.warnings ?? []),
    ];
    const scannerStdout = allPasses.map((pass, index) => pass.processResult.stdout
      ? `[pass-${index + 1}]\n${pass.processResult.stdout}` : '').filter(Boolean).join('\n');
    const scannerStderr = allPasses.map((pass, index) => pass.processResult.stderr
      ? `[pass-${index + 1}]\n${pass.processResult.stderr}` : '').filter(Boolean).join('\n');
    result = {
      outputCsv,
      validationCsv,
      scanJson,
      findings: reportedFindings,
      allFindings,
      filteredFindings,
      actionGroups: classified.actionGroups,
      validationGroups: classified.validationGroups,
      diagnostics: {
        durationMs: Date.now() - startedAt,
        totalFindingCount: allFindings.length,
        reportedFindingCount: reportedFindings.length,
        filteredFindingCount: filteredFindings.length,
        filterSummary,
        cppStatus,
        nativePasses,
        languages: { arkts: projectRules.hasArkTs, cpp: projectRules.hasCpp },
        warnings: [...warnings, ...(rnoh?.summary.gaps ?? []).map(gap => `RNOH：${gap}`)],
        ...(rnoh ? { rnoh: { status: rnoh.summary.status, findingCount: rnoh.findings.length } } : {}),
        backend: toolchain.apiChangeBackend ?? 'integrated',
        stdout: scannerStdout.slice(-12000),
        stderr: scannerStderr.slice(-12000),
      },
    };
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const warning = await cleanupScanDirectory(temporary, removeTemporary);
    if (warning && result) {
      result.diagnostics.cleanupWarning = warning;
      result.diagnostics.warnings.push(`${warning.code}: ${warning.path}: ${warning.message}`);
    } else if (warning && failure) failure.cleanupWarning = warning;
  }
}

export { compareFindings, normalizeCodeLocation, normalizeFinding };

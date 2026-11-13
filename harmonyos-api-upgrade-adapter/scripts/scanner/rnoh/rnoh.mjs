import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson5 } from '../../shared/format/json5.mjs';
import { hyperlink } from '../../shared/format/csv.mjs';
import { canonicalHarmonyVersion } from '../../shared/platform/version.mjs';
import { sha256 } from '../../shared/io/fs-utils.mjs';
import { inside } from '../../shared/platform/source-scope.mjs';

export const RNOH_RULE_PREFIX = 'RNOH-';
export const RNOH_LAYERS = Object.freeze({ native: 'RNOH 原生框架', rnohJs: 'RNOH JS 层', business: 'RN 业务 JS', host: '宿主 ArkTS' });
export const defaultRnohRules = fileURLToPath(new URL('../data/rnoh-impact-rules.json', import.meta.url));
export const isRnohRuleId = value => String(value ?? '').startsWith(RNOH_RULE_PREFIX);

const NATIVE_PACKAGE = '@rnoh/react-native-openharmony';
const NATIVE_STORE_PREFIX = '@rnoh+react-native-openharmony@';
const JS_PACKAGES = ['@react-native-oh/react-native-harmony', '@rnoh/react-native-harmony'];
const NATIVE_SKIP = new Set(['third-party', 'tests', 'test', '__tests__', '__mocks__', 'stubs', 'stub', 'patches', 'mock', 'mocks']);
const BUSINESS_SKIP = new Set(['node_modules', 'harmony', 'android', 'ios', 'build', 'dist', 'coverage',
  '__tests__', '__mocks__', '__snapshots__', '__fixtures__', 'test', 'tests', 'e2e']);
// Test, spec and story files never ship in the bundle, so their RN usage is not a business impact.
const BUSINESS_TEST_FILE = /\.(?:test|spec|stories|story)\.(?:js|jsx|ts|tsx)$/i;
const extensions = {
  native: /\.(?:cpp|cc|c|h|hpp|ets|ts)$/i,
  rnohJs: /\.harmony\.(?:js|jsx|ts|tsx)$/i,
  business: /\.(?:js|jsx|ts|tsx)$/i,
  host: /\.(?:ets|ts)$/i,
};
const languageOf = file => /\.(?:cpp|cc|c|h|hpp)$/i.test(file) ? 'C' : /\.ets$/i.test(file) ? 'ArkTS'
  : /\.tsx?$/i.test(file) ? 'TypeScript' : 'JavaScript';

async function readJson(file, json5 = false) {
  try {
    const text = (await readFile(file, 'utf8')).replace(/^﻿/, '');
    return json5 ? parseJson5(text) : JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw new Error(`无法解析 ${file}：${error.message}`);
  }
}

async function isDirectory(file) {
  return stat(file).then(info => info.isDirectory(), error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  });
}

// Walk without following symlinks so ohpm/npm links cannot create loops or leave the scanned tree.
async function walk(directory, accept, skipDirectory) {
  const files = [];
  const visit = async current => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) { if (!skipDirectory(entry.name, file)) await visit(file); }
      else if (entry.isFile() && accept(file)) files.push(file);
    }
  };
  await visit(directory);
  return files;
}

const declaredSpec = json => ['dependencies', 'devDependencies', 'overrides']
  .map(key => json?.[key]?.[NATIVE_PACKAGE]).find(value => typeof value === 'string') ?? null;
const allDependencies = json => ({ ...json?.dependencies, ...json?.devDependencies });
const JS_SEARCH_SKIP = new Set(['node_modules', 'oh_modules', 'build', 'dist', 'android', 'ios']);
const jsDependency = json => {
  const all = { ...json?.dependencies, ...json?.devDependencies };
  return JS_PACKAGES.find(name => typeof all[name] === 'string') ?? null;
};

/**
 * Detect React Native for OpenHarmony from real dependency evidence. Returns null for other projects.
 * @param {{root: string, modules?: Array<{root: string}>}} project Loaded HarmonyOS project.
 */
export async function detectRnohProject(project, { jsRoot = project.rnJsRoot ?? null } = {}) {
  const declared = [];
  for (const directory of [project.root, ...(project.modules ?? []).map(module => module.root)]) {
    const file = path.join(directory, 'oh-package.json5'), spec = declaredSpec(await readJson(file, true));
    if (spec) declared.push({ file: path.relative(project.root, file).split(path.sep).join('/'), spec });
  }
  const store = path.join(project.root, 'oh_modules', '.ohpm'), native = [];
  let storeEntries = [];
  try { storeEntries = await readdir(store, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  for (const entry of storeEntries.filter(item => item.isDirectory() && item.name.startsWith(NATIVE_STORE_PREFIX))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const packageRoot = path.join(store, entry.name, 'oh_modules', ...NATIVE_PACKAGE.split('/'));
    const metadata = await readJson(path.join(packageRoot, 'oh-package.json5'), true);
    if (!metadata) continue;
    const sourceRoot = path.join(packageRoot, 'src', 'main');
    const debug = await isDirectory(path.join(sourceRoot, 'cpp')) || await isDirectory(path.join(sourceRoot, 'ets'));
    native.push({ version: String(metadata.version ?? ''), directory: packageRoot, sourceRoot: debug ? sourceRoot : null,
      form: debug ? 'DEBUG_SOURCE' : 'RELEASE_BINARY' });
  }
  if (!declared.length && !native.length) return null;
  // The RNOH JS package may be installed without being declared (local path, workspace); fall back to what node_modules holds.
  const describe = async (candidate, manifest) => {
    const root = await realpath(candidate);
    let packageName = jsDependency(manifest), installed = null;
    for (const name of packageName ? [packageName] : JS_PACKAGES) {
      installed = await readJson(path.join(root, 'node_modules', ...name.split('/'), 'package.json'));
      if (installed) { packageName = name; break; }
    }
    const reactNative = await readJson(path.join(root, 'node_modules', 'react-native', 'package.json'));
    return { root, packageName, declaredVersion: packageName ? allDependencies(manifest)[packageName] ?? null : null,
      installedVersion: installed?.version ?? null, packageRoot: installed ? path.join(root, 'node_modules', ...packageName.split('/')) : null,
      reactNativeVersion: reactNative?.version ?? allDependencies(manifest)['react-native'] ?? null };
  };
  const isRnProject = manifest => Boolean(manifest) && !JS_PACKAGES.includes(manifest.name)
    && (Boolean(jsDependency(manifest)) || typeof allDependencies(manifest)['react-native'] === 'string');
  let js = null, jsCandidates = [];
  if (jsRoot) {
    const candidate = path.resolve(project.root, jsRoot), manifest = await readJson(path.join(candidate, 'package.json'));
    if (!isRnProject(manifest)) throw Object.assign(new Error(`--rn-js-root 指向的目录不是 RN JS 工程（需要 package.json 且依赖 react-native）：${candidate}`), { code: 'RN_JS_ROOT_INVALID' });
    js = await describe(candidate, manifest);
  } else {
    const parent = path.dirname(project.root), projectRoot = await realpath(project.root);
    // Standard layout first: <JS project>/harmony or one level deeper, declaring the RNOH JS package.
    for (const candidate of [parent, path.dirname(parent)]) {
      const manifest = await readJson(path.join(candidate, 'package.json'));
      if (jsDependency(manifest)) { js = await describe(candidate, manifest); break; }
    }
    if (!js) {
      // Non-standard layout: the JS project sits beside the harmony project, up to two levels below their common parent.
      const found = [];
      const consider = async candidate => {
        const manifest = await readJson(path.join(candidate, 'package.json'));
        if (!isRnProject(manifest)) return;
        const app = await Promise.all(['metro.config.js', 'metro.config.ts', 'app.json'].map(name =>
          stat(path.join(candidate, name)).then(info => info.isFile(), () => false)));
        found.push({ candidate, manifest, tier: jsDependency(manifest) ? 0 : app.some(Boolean) ? 1 : 2 });
      };
      const children = async directory => (await readdir(directory, { withFileTypes: true }).catch(() => []))
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !JS_SEARCH_SKIP.has(entry.name))
        .map(entry => path.join(directory, entry.name)).sort();
      await consider(parent);
      for (const child of await children(parent)) {
        if (await realpath(child) === projectRoot) continue;
        await consider(child);
        for (const grandchild of await children(child)) if (await realpath(grandchild) !== projectRoot) await consider(grandchild);
      }
      const best = found.filter(item => item.tier === Math.min(...found.map(other => other.tier)));
      if (best.length === 1) js = await describe(best[0].candidate, best[0].manifest);
      else jsCandidates = best.map(item => item.candidate);
    }
  }
  return { packageName: NATIVE_PACKAGE, declared, native, js, jsCandidates };
}

/** Load and structurally validate the bundled RNOH impact rules. */
export async function loadRnohRules(file = defaultRnohRules) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data.schemaVersion !== 2 || !Array.isArray(data.rules)) throw new Error('RNOH 影响规则格式不受支持');
  const ids = new Set();
  for (const rule of data.rules) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id ?? '') || ids.has(rule.id)) throw new Error(`RNOH 规则 ID 无效或重复：${rule.id}`);
    ids.add(rule.id);
    if (!rule.binding?.platformVersion || !rule.binding?.title) throw new Error(`RNOH 规则缺少官方条目绑定：${rule.id}`);
    if (!Array.isArray(rule.framework) || !rule.framework.length) throw new Error(`RNOH 规则缺少框架依据：${rule.id}`);
    for (const layer of rule.framework) {
      if (!['native', 'rnohJs', 'host'].includes(layer.layer) || !layer.api || !layer.pattern) throw new Error(`RNOH 规则框架依据无效：${rule.id}`);
      new RegExp(layer.pattern); if (layer.files) new RegExp(layer.files);
    }
    if (rule.business !== undefined && (!Array.isArray(rule.business) || !rule.business.length
      || rule.business.some(item => !item.api || !item.pattern))) throw new Error(`RNOH 规则业务触发写法无效：${rule.id}`);
    for (const item of rule.business ?? []) new RegExp(item.pattern);
  }
  return data.rules;
}

/** Bind rules to the frozen official interval; unplaced entries are never bound. */
export function bindRnohRules(rules, officialEntries = []) {
  const placed = officialEntries.filter(entry => entry.status !== 'INTERVAL_UNRESOLVED');
  const bound = [], unbound = [];
  for (const rule of rules) {
    const matches = placed.filter(entry => entry.platformVersion === rule.binding.platformVersion && entry.title === rule.binding.title);
    if (matches.length > 1) throw new Error(`RNOH 规则绑定到多个官方条目：${rule.id}`);
    if (matches.length) bound.push({ rule, entry: matches[0] });
  }
  const boundEntries = new Set(bound.map(item => item.entry));
  for (const entry of placed) if (!boundEntries.has(entry))
    // Kit and category let U04a exclude whole unrelated groups (e.g. ArkWeb, ArkTS runtime) without guessing from titles.
    unbound.push({ title: entry.title, ...(entry.kit ? { kit: entry.kit } : {}), ...(entry.category ? { category: entry.category } : {}),
      changedInSdk: canonicalHarmonyVersion(entry.version), sourceReference: entry.sourceReference ?? `${entry.document}:${entry.startLine}` });
  return { bound, unbound };
}

// Blank comments while keeping line numbers, so commented-out code is not reported as an impact.
export function codeLines(text) {
  let block = false;
  return text.replace(/\r\n?/g, '\n').split('\n').map(raw => {
    let line = '', i = 0;
    while (i < raw.length) {
      if (block) { const end = raw.indexOf('*/', i); if (end < 0) { i = raw.length; break; } block = false; i = end + 2; continue; }
      const start = raw.indexOf('/*', i);
      if (start < 0) { line += raw.slice(i); break; }
      line += raw.slice(i, start); block = true; i = start + 2;
    }
    return /^\s*\/\//.test(line) ? '' : line;
  });
}

/** RN business JS that ships in the bundle: same file set for impact scanning and bundle freshness checks. */
export function rnBusinessSources(jsRoot, harmonyRoot) {
  return walk(jsRoot, file => extensions.business.test(file) && !file.endsWith('.d.ts') && !BUSINESS_TEST_FILE.test(file),
    (name, directory) => name.startsWith('.') || BUSINESS_SKIP.has(name) || inside(harmonyRoot, directory));
}

async function layerFiles(detection, project) {
  const files = { native: [], rnohJs: [], business: [], host: [] }, coverage = {};
  const sources = detection.native.filter(item => item.sourceRoot);
  for (const item of sources)
    files.native.push(...await walk(item.sourceRoot, file => extensions.native.test(file) && !file.endsWith('.d.ts'), name => NATIVE_SKIP.has(name)));
  coverage.native = sources.length ? 'SCANNED' : detection.native.length ? 'RELEASE_BINARY' : 'NOT_INSTALLED';
  if (detection.js?.packageRoot) {
    files.rnohJs = await walk(detection.js.packageRoot, file => extensions.rnohJs.test(file),
      name => name === 'node_modules' || name.startsWith('.') || NATIVE_SKIP.has(name));
    coverage.rnohJs = 'SCANNED';
  } else coverage.rnohJs = detection.js ? 'NOT_INSTALLED' : 'JS_PROJECT_NOT_FOUND';
  if (detection.js) {
    files.business = await rnBusinessSources(detection.js.root, project.root);
    coverage.business = 'SCANNED';
  } else coverage.business = 'JS_PROJECT_NOT_FOUND';
  files.host = (project.sourceFiles ?? []).filter(file => extensions.host.test(file));
  coverage.host = 'SCANNED';
  return { files, coverage };
}

/**
 * Produce CSV rows only for RN business JS locations whose behavior changes through the RNOH framework.
 * RNOH framework source is read-only evidence (gate); non-RNOH projects return null and get no RNOH content.
 */
export async function scanRnohImpacts({ project, officialEntries, rulesFile = defaultRnohRules, detection = null }) {
  const detected = detection ?? await detectRnohProject(project);
  if (!detected) return null;
  const scope = project.sourceScope ?? {};
  const relative = file => path.relative(project.root, file).split(path.sep).join('/');
  const summary = { schemaVersion: 1, packageName: detected.packageName, declared: detected.declared,
    native: detected.native.map(item => ({ version: item.version, form: item.form, directory: relative(item.directory) })),
    js: detected.js ? { root: relative(detected.js.root) || '.', packageName: detected.js.packageName, declaredVersion: detected.js.declaredVersion,
      installedVersion: detected.js.installedVersion, reactNativeVersion: detected.js.reactNativeVersion } : null,
    jsRoot: detected.js ? relative(detected.js.root) || '.' : null, gaps: [] };
  if (scope.projectType === 'har' || scope.scanDirs?.length || scope.scanModules?.length) {
    summary.status = 'SKIPPED_RESTRICTED_SCOPE';
    summary.gaps.push('本次为 HAR 或指定模块/目录扫描，未执行 RNOH 框架层与 JS 层检索');
    return { summary, findings: [], files: [] };
  }
  const versions = [...new Set(detected.native.map(item => item.version).filter(Boolean))];
  if (versions.length > 1) summary.gaps.push(`检测到多个 RNOH 原生 HAR 版本：${versions.join('、')}`);
  if (detected.js?.installedVersion && versions.length === 1 && detected.js.installedVersion !== versions[0])
    summary.gaps.push(`RNOH JS 包 ${detected.js.installedVersion} 与原生 HAR ${versions[0]} 版本不一致`);
  const { files, coverage } = await layerFiles(detected, project);
  summary.coverage = coverage;
  if (coverage.native === 'RELEASE_BINARY') summary.gaps.push('RNOH 原生 HAR 为预编译产物，无法核对框架是否传递变更，相关规则按可能受影响输出业务位置');
  if (coverage.native === 'NOT_INSTALLED') summary.gaps.push('未找到已安装的 RNOH 原生 HAR，需先执行 ohpm install');
  if (coverage.rnohJs !== 'SCANNED') summary.gaps.push('未找到已安装的 RNOH JS 包，RNOH JS 层依据未核对');
  if (coverage.business !== 'SCANNED') summary.gaps.push(detected.jsCandidates?.length
    ? `找到多个可能的 RN JS 工程（${detected.jsCandidates.map(relative).join('、')}），RN 业务 JS 未检索；用 --rn-js-root <目录> 指定后重新扫描`
    : '未找到 RN JS 工程，RN 业务 JS 未检索；JS 工程不在 harmony 目录的上级或同级时，用 --rn-js-root <目录> 指定后重新扫描');
  const { bound, unbound } = bindRnohRules(await loadRnohRules(rulesFile), officialEntries);
  const texts = new Map(), hashes = new Map();
  const read = async file => {
    if (!texts.has(file)) {
      const bytes = await readFile(file);
      hashes.set(file, sha256(bytes));
      texts.set(file, codeLines(bytes.toString('utf8')));
    }
    return texts.get(file);
  };
  const matches = async (candidates, pattern, filter = null) => {
    const found = [], regex = new RegExp(pattern);
    for (const file of candidates.filter(item => !filter || filter.test(item.split(path.sep).join('/')))) {
      const lines = await read(file);
      for (let index = 0; index < lines.length; index++) if (regex.test(lines[index])) found.push({ file, line: index + 1 });
    }
    return found;
  };
  const findings = [], rules = [];
  for (const { rule, entry } of bound) {
    const url = entry.officialEntryUrl ?? entry.sourceUrl ?? '';
    const sourceReference = entry.sourceReference ?? `${entry.document}:${entry.startLine}`;
    // Framework source is read only as evidence that this RNOH version carries the change to RN pages; it never becomes a CSV row.
    const evidence = [];
    let unverified = false;
    for (const layer of rule.framework) {
      if (coverage[layer.layer] !== 'SCANNED') { unverified = true; continue; }
      for (const hit of await matches(files[layer.layer], layer.pattern, layer.files ? new RegExp(layer.files) : null))
        evidence.push({ layer: layer.layer, api: layer.api, location: `${relative(hit.file)}:${hit.line}` });
    }
    const frameworkStatus = evidence.length ? 'CONFIRMED' : unverified ? 'UNVERIFIED' : 'NOT_USED';
    const framework = { status: frameworkStatus, count: evidence.length, locations: evidence.slice(0, 10) };
    const base = { ruleId: `${RNOH_RULE_PREFIX}${rule.id}`, title: entry.title, changedInSdk: canonicalHarmonyVersion(entry.version), sourceReference, framework };
    if (frameworkStatus === 'NOT_USED') { rules.push({ ...base, businessCount: 0, status: 'FRAMEWORK_NOT_AFFECTED' }); continue; }
    if (!rule.business) { rules.push({ ...base, businessCount: 0, status: 'FRAMEWORK_ONLY' }); continue; }
    // Without a JS project nothing was searched: never report that as "no match".
    if (coverage.business !== 'SCANNED') { rules.push({ ...base, businessCount: 0, status: 'BUSINESS_NOT_SCANNED' }); continue; }
    let businessCount = 0;
    for (const item of rule.business) for (const hit of await matches(files.business, item.pattern)) {
      businessCount++;
      findings.push({
        'Api Definition': item.api,
        Language: languageOf(hit.file),
        'Changed in SDK': canonicalHarmonyVersion(entry.version),
        'Affected Versions': '',
        Title: hyperlink(url, entry.title),
        documentLink: { url, source: 'OFFICIAL_CHANGELOG' },
        'Code Location': `${relative(hit.file)}:${hit.line}`,
        Fixed: 'Unfixed',
        'Change Type': rule.changeType,
        'Rule ID': `${RNOH_RULE_PREFIX}${rule.id}`,
        'Change Operation': 'RNOH_BEHAVIOR_IMPACT',
        'Source Reference': sourceReference,
        'Replacement API': '',
        'Replacement Source': '',
        'Detection Source': 'RNOH_STATIC_RULE',
        'Source Scope': 'business',
        rnohLayer: 'business',
        rnohFramework: { status: frameworkStatus, locations: evidence.slice(0, 5) },
        includedInCsv: true, disposition: 'REQUIRES_REVIEW', filterReason: null, applicabilityProof: null,
      });
    }
    rules.push({ ...base, businessCount, status: businessCount ? 'MATCHED' : 'NO_MATCH' });
  }
  summary.status = 'COMPLETE';
  summary.rules = rules;
  summary.uncoveredEntries = unbound;
  summary.findingCount = findings.length;
  summary.fileCount = texts.size;
  summary.fingerprint = sha256(JSON.stringify([...hashes].map(([file, hash]) => [relative(file), hash]).sort()));
  return { summary, findings, files: [...hashes].map(([file, hash]) => ({ file, hash })),
    ...(coverage.business === 'SCANNED' ? { businessSource: { root: detected.js.root, files: files.business } } : {}) };
}

/** Re-hash scanned RNOH files before publication so the CSV matches the inputs it was derived from. */
export async function verifyRnohInputs(result) {
  for (const item of result?.files ?? [])
    if (sha256(await readFile(item.file)) !== item.hash) throw Object.assign(new Error(`RNOH 检索输入在扫描期间变化：${item.file}`), { code: 'SOURCE_CHANGED_DURING_SCAN' });
}

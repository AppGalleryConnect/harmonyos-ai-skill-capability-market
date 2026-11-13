import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { exists, sha256, sha256File } from '../../shared/io/fs-utils.mjs';
import { canonicalHarmonyVersion as canonicalVersion, compareHarmonyVersions as compareVersions, parseVersion } from '../../shared/platform/version.mjs';
import { listZipEntries } from '../../shared/format/zip.mjs';
import { resolveSdkRoot } from '../../shared/platform/sdk-layout.mjs';
import { runProcess } from '../../shared/platform/process.mjs';
import { assertDevEcoCompatibility, inspectDevEcoCompatibility } from '../../shared/platform/deveco-version.mjs';
import { resolveDevEcoHome, readProductInfo, executableNames, firstExisting, discoverDevEcoTools } from '../../shared/platform/deveco-home.mjs';

const INTEGRATED_CLI_MARKERS = [
  '--startVersion', '--endVersion', '--modulePaths', '--sdkPath', '--apiModifiedPath', '--outputPath',
];
const INDEX_CLI_MARKERS = ['--configPath', '--apiModifiedPath', '--outPath', '--tmpPath'];
const capabilityCache = new Map();
const helpCache = new Map();
async function scannerHelp(file) {
  const info = await stat(file), key = `${file}:${info.size}:${info.mtimeMs}`;
  if (!helpCache.has(key)) helpCache.set(key, runProcess(process.execPath, [file, '--help'], {
    cwd: path.dirname(file), timeoutMs: 5000, detached: true, terminationGraceMs: 500,
  }));
  return helpCache.get(key);
}

async function scannerCapabilities(scanner, probeHelp) {
  if (!scanner) return {moduleScanSupported:false,fileScanSupported:false};
  const info=await stat(scanner.file),key=`${scanner.file}:${info.size}:${info.mtimeMs}:${probeHelp}`;
  if (!capabilityCache.has(key)) capabilityCache.set(key,(async()=>{
    const text=await readFile(scanner.file,'utf8');
    const flag=scanner.contract==='index'?'--scanFilePaths':'--arkTsFiles';
    const help=probeHelp ? await scannerHelp(scanner.file) : null;
    const output=help ? `${help.stdout}\n${help.stderr}` : '';
    const verified=help?.exitCode===0 && /--(?:configPath|modulePaths)/.test(output);
    const declared=new RegExp(`\\.option\\(\\s*['"\x60]${flag}(?:[\\s<]|['"\x60])`).test(text);
    const start = text.indexOf('function findNinja(modulePath)'), end = text.indexOf('exports.findNinja', start);
    const selector = start >= 0 && end > start ? text.slice(start, end) : '';
    const firstNinja = scanner.contract === 'integrated'
      && selector.includes('readdirSync(dir, { withFileTypes: true })')
      && selector.includes('for (const entry of entries)') && selector.includes("entry.name === 'build.ninja'")
      && selector.includes('return fullPath;') && selector.includes('findNinjaRecursive(fullPath)')
      && selector.includes('return result;') && !/\.sort\s*\(|\.reverse\s*\(/.test(selector);
    return {moduleScanSupported:true,fileScanSupported:verified ? output.includes(flag) : declared,
      nativeContextSelection: { strategy: firstNinja ? 'FIRST_NINJA_DFS' : 'UNKNOWN', source: scanner.file, sha256: sha256(text) },
      capabilityEvidence:{source:verified?'CLI_HELP':'SOURCE_OPTIONS',file:scanner.file,helpExitCode:help?.exitCode ?? null}};
  })());
  return capabilityCache.get(key);
}

async function listFiles(root, predicate, maxDepth = 3) {
  const results = [];
  async function visit(directory, depth) {
    if (!(await exists(directory)) || depth > maxDepth) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && predicate(target)) results.push(target);
    }
  }
  await visit(root, 0);
  return results.sort();
}

async function newestMatching(roots, pattern, maxDepth = 1) {
  const files = [];
  for (const root of roots) files.push(...await listFiles(root, file => pattern.test(path.basename(file)), maxDepth));
  return files.sort().at(-1) ?? null;
}

async function scannerContract(file, probeHelp = true) {
  try {
    const text = await readFile(file, 'utf8');
    if (text.includes('__webpack_require__.s = "./src/collector/api/ApiChangeMain.ts"')) return 'integrated';
    if (text.includes('__webpack_require__.s = "./src/collector/api/MainSrc.ts"')) return 'index';
    const integrated = INTEGRATED_CLI_MARKERS.every(marker => text.includes(marker));
    const index = INDEX_CLI_MARKERS.every(marker => text.includes(marker));
    if (integrated && !index) return 'integrated';
    if (index && !integrated) return 'index';
    if (integrated && index) {
      if (!probeHelp) return 'unknown';
      const help = await scannerHelp(file);
      const output = `${help.stdout}\n${help.stderr}`;
      if (/--startVersion/.test(output) && /--modulePaths/.test(output)) return 'integrated';
      if (/--configPath/.test(output) && /--apiModifiedPath/.test(output)) return 'index';
    }
  } catch {
    // The candidate is recorded in layout diagnostics below.
  }
  return 'unknown';
}

async function analyzerRoots(contentsRoot) {
  const roots = [];
  const add = (candidate) => {
    const normalized = path.resolve(candidate);
    if (!roots.includes(normalized)) roots.push(normalized);
  };
  if (/arkanalyzer|api.*scan|scan.*api/i.test(path.basename(contentsRoot))) add(contentsRoot);
  for (const pluginFamily of ['harmony', 'openharmony']) {
    const familyRoot = path.join(contentsRoot, 'plugins', pluginFamily);
    if (!(await exists(familyRoot))) continue;
    add(path.join(familyRoot, 'arkanalyzer-apiscan'));
    async function visit(directory, depth) {
      if (!(await exists(directory)) || depth > 2) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const target = path.join(directory, entry.name);
        if (/arkanalyzer|api.*scan|scan.*api/i.test(entry.name)) add(target);
        await visit(target, depth + 1);
      }
    }
    await visit(familyRoot, 0);
  }
  const existing = [];
  for (const root of roots) if (await exists(root)) existing.push(root);
  return existing;
}

export async function discoverSdkLayout(sdkRoot) {
  const location = await resolveSdkRoot(sdkRoot, { required: false });
  const root = location?.root ?? path.resolve(sdkRoot);
  const defaultRoot = location?.defaultRoot ?? path.join(root, 'default');
  const families = {};
  const candidates = [];
  if (await exists(defaultRoot)) {
    for (const entry of await readdir(defaultRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const familyRoot = path.join(defaultRoot, entry.name);
      const etsRoot = path.join(familyRoot, 'ets');
      if (!(await exists(etsRoot))) continue;
      const parser = path.join(etsRoot, 'build-tools', 'ets-loader', 'node_modules', 'typescript', 'lib', 'typescript.js');
      const record = { name: entry.name, root: familyRoot, etsRoot, parserPath: await exists(parser) ? parser : null };
      candidates.push(record);
      if (entry.name.toLowerCase() === 'hms') families.hms = etsRoot;
      if (record.parserPath) families.openharmony = etsRoot;
    }
  }
  if (!families.openharmony) {
    const preferred = candidates.find(item => ['openharmony', 'harmonyos', 'ohos'].includes(item.name.toLowerCase()));
    if (preferred) families.openharmony = preferred.etsRoot;
  }
  const system = candidates.find(item => item.etsRoot === families.openharmony) ?? null;
  return {
    root,
    defaultRoot,
    families,
    parserPath: system?.parserPath ?? null,
    candidates,
  };
}

export async function inspectDevEcoLayout(contentsRoot, sdkRoot, platform = process.platform, { targetVersion = null } = {}) {
  const root = await resolveDevEcoHome(path.join(contentsRoot, 'sdk'), contentsRoot);
  if (!(await exists(root))) return null;
  const productInfo = await readProductInfo(root, platform);
  const probeHelp = !targetVersion || inspectDevEcoCompatibility(productInfo, targetVersion, root).status === 'COMPATIBLE';
  const sdkLayout = sdkRoot ? await discoverSdkLayout(sdkRoot) : null;
  const roots = await analyzerRoots(root);
  const scannerCandidates = [];
  for (const analyzerRoot of roots) {
    const files = await listFiles(analyzerRoot, file => /\.(?:c?js|mjs)$/i.test(file), 1);
    for (const file of files) scannerCandidates.push({ file, analyzerRoot, contract: await scannerContract(file, probeHelp) });
  }
  const scanner = scannerCandidates.find(item => item.contract === 'integrated')
    ?? scannerCandidates.find(item => item.contract === 'index') ?? null;
  const analyzerRoot = scanner?.analyzerRoot ?? roots[0] ?? null;
  const resourceCandidates = roots.map(candidate => path.join(candidate, 'resources', 'apiChange'));
  for (const candidate of roots) {
    const ruleFiles = await listFiles(candidate, file => /^HarmonyOS_.+\.json$/i.test(path.basename(file)), 3);
    for (const file of ruleFiles) {
      const directory = path.dirname(file);
      if (!resourceCandidates.includes(directory)) resourceCandidates.push(directory);
    }
  }
  let apiChangeResourceRoot = null;
  for (const candidate of resourceCandidates) {
    if (!(await exists(candidate))) continue;
    const files = await readdir(candidate, { withFileTypes: true });
    if (files.some(entry => entry.isFile() && /^HarmonyOS_.+\.json$/i.test(entry.name))) {
      apiChangeResourceRoot = candidate;
      break;
    }
  }
  const harmonyLibRoots = [
    path.join(root, 'plugins', 'harmony', 'lib'),
    path.join(root, 'plugins', 'openharmony', 'lib'),
  ];
  const cApiScanJar = await newestMatching([
    ...roots.map(candidate => path.join(candidate, 'lib')),
    ...harmonyLibRoots,
  ], /^(?:c[-_]?api[-_]?scan|capiscan)(?:-.*)?\.jar$/i);
  const projectApiChangeJar = await newestMatching(harmonyLibRoots,
    /^project[-_]?api[-_]?change[-_]?assistant(?:-.*)?\.jar$/i);
  let apiChangeResourceArchive = null;
  let archiveEntries = [];
  let archiveError = null;
  if (projectApiChangeJar) {
    try {
      archiveEntries = (await listZipEntries(projectApiChangeJar))
        .filter(name => /^apiChange\/.+\.json$/i.test(name));
      if (archiveEntries.length > 0) apiChangeResourceArchive = projectApiChangeJar;
    } catch (error) {
      archiveError = error.message;
    }
  }
  const components = {
    ...await discoverDevEcoTools(root, productInfo, platform),
    hdc: sdkLayout ? await firstExisting(sdkLayout.candidates.flatMap(family => executableNames('hdc', platform)
      .map(name => path.join(family.root, 'toolchains', name)))) : null,
    apiChangeScan: scanner?.file ?? null,
    apiChangeBackend: scanner?.contract ?? null,
    ...await scannerCapabilities(scanner,probeHelp),
    apiChangeResourceRoot,
    apiChangeResourceArchive,
    projectApiChangeJar,
    cApiScanJar,
    parserPath: sdkLayout?.parserPath ?? null,
    sdkFamilies: sdkLayout?.families ?? {},
  };
  return {
    root,
    analyzerRoot,
    components,
    productInfo,
    diagnostics: {
      analyzerRoots: roots,
      scannerCandidates,
      resourceCandidates,
      projectApiChangeJar,
      archiveEntries,
      archiveError,
      sdkLayout,
    },
  };
}

export async function discoverDevEco(sdkPath, devecoHomePath = null, {
  platform = process.platform,
  env = process.env,
  targetVersion = null,
} = {}) {
  const sdkLocation = await resolveSdkRoot(sdkPath);
  const { root: sdkRoot, packagePath: sdkPackage } = sdkLocation;
  const sdkMetadata = JSON.parse(await readFile(sdkPackage, 'utf8'));
  const contentsRoot = await resolveDevEcoHome(sdkRoot, devecoHomePath, env);
  const rawVersion = `${sdkMetadata.data.platformVersion}(${sdkMetadata.data.apiVersion}) ${sdkMetadata.data.releaseType}`;
  const sdkVersion = parseVersion(rawVersion);
  const productInfo = await readProductInfo(contentsRoot, platform);
  const devecoCompatibility = inspectDevEcoCompatibility(productInfo, targetVersion ?? sdkVersion, contentsRoot);
  assertDevEcoCompatibility(devecoCompatibility);
  const layout = await inspectDevEcoLayout(contentsRoot, sdkRoot, platform);
  const required = [
    ['compatible API scan CLI', layout?.components.apiChangeScan],
    ['API change resources', layout?.components.apiChangeResourceRoot
      ?? layout?.components.apiChangeResourceArchive],
    ['target SDK ArkTS parser', layout?.components.parserPath],
  ];
  const missing = required.filter(([, target]) => !target).map(([name]) => name);
  if (missing.length) {
    const error = new Error(`DevEco scanner layout is unsupported or incomplete: ${missing.join(', ')}`);
    error.code = 'UNSUPPORTED_DEVECO_SCANNER_LAYOUT';
    error.details = { contentsRoot, ...(layout?.diagnostics ?? {}) };
    throw error;
  }
  const components = layout.components;
  const hashes = {
    apiChangeScan: await sha256File(components.apiChangeScan),
    sdkPackage: await sha256File(sdkPackage),
  };
  if (components.projectApiChangeJar) hashes.projectApiChangeJar = await sha256File(components.projectApiChangeJar);
  if (components.cApiScanJar) hashes.cApiScanJar = await sha256File(components.cApiScanJar);
  return {
    sdkRoot,
    sdkLocation,
    contentsRoot,
    analyzerRoot: layout.analyzerRoot,
    apiChangeScan: components.apiChangeScan,
    apiChangeBackend: components.apiChangeBackend,
    fileScanSupported: components.fileScanSupported,
    moduleScanSupported: components.moduleScanSupported,
    capabilityEvidence:components.capabilityEvidence,
    nativeContextSelection: components.nativeContextSelection,
    apiChangeResourceRoot: components.apiChangeResourceRoot,
    apiChangeResourceArchive: components.apiChangeResourceArchive,
    projectApiChangeJar: components.projectApiChangeJar,
    cApiScanJar: components.cApiScanJar,
    java: components.java,
    hvigorw: components.hvigorw,
    ohpm: components.ohpm,
    parserPath: components.parserPath,
    sdkFamilies: components.sdkFamilies,
    productInfo: layout.productInfo,
    devecoCompatibility,
    layoutDiagnostics: layout.diagnostics,
    sdkMetadata,
    sdkVersion,
    hashes,
  };
}

export function validateTargetCoverage(toolchain, target) {
  assertDevEcoCompatibility(inspectDevEcoCompatibility(toolchain.productInfo, target, toolchain.contentsRoot));
  if (compareVersions(toolchain.sdkVersion, target) < 0) {
    const error = new Error(
      `Installed SDK ${toolchain.sdkMetadata.data.platformVersion} ${toolchain.sdkMetadata.data.releaseType} `
      + `does not cover target ${target.raw ?? target}`,
    );
    error.code = 'SDK_TARGET_NOT_COVERED';
    error.details = { installed: canonicalVersion(toolchain.sdkVersion), target: canonicalVersion(target) };
    throw error;
  }
}

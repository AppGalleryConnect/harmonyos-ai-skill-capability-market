import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { statSync, realpathSync } from 'node:fs';
import { exists, listFiles, portableRelative, sha256 } from '../../shared/io/fs-utils.mjs';
import { parseJson5 } from '../../shared/format/json5.mjs';
import { projectModules, createSourceScope, sourceInScope, sourceDirectoryAllowed, sourceLocation, SOURCE_EXCLUDED } from '../../shared/platform/source-scope.mjs';
import { errorWithCode } from '../../shared/platform/errors.mjs';
import { normalizeComparablePath } from '../../shared/platform/paths.mjs';
import { isSourceFile } from '../../shared/platform/source-types.mjs';

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

export async function loadProject(projectPath, productName, requestedScanDirs = [], requestedScanModules = [], projectType = 'app',
  { onSourceSnapshotFile, ...exclusions } = {}) {
  const root = await realpath(path.resolve(projectPath));
  const buildProfilePath = path.join(root, 'build-profile.json5');
  if (!(await exists(buildProfilePath))) throw new Error(`HarmonyOS build profile not found: ${buildProfilePath}`);
  const buildProfileText = await readFile(buildProfilePath, 'utf8');
  const buildProfile = parseJson5(buildProfileText);
  const products = buildProfile.app?.products ?? [];
  if (!products.length) throw errorWithCode('Product 配置不存在；--project 应指向含 app.products 和模块注册的根工程，模块范围使用 --scan-module/--scan-dir；未自动切换或扩大范围', 'PROJECT_ROOT_INVALID');
  let product = productName ? products.find((item) => item.name === productName) : null;
  if (!product && !productName && products.length === 1) product = products[0];
  if (!product) throw new Error(`Product ${productName || '<unspecified>'} not found or is ambiguous`);
  const allModules = await projectModules(root, buildProfile);
  const sourceScope = await createSourceScope(root, allModules, { scanDirs: requestedScanDirs, scanModules: requestedScanModules, projectType, ...exclusions });
  const selectedModules = allModules.filter(module => sourceScope.selectedModules.includes(module.name));
  const scanDirs = (sourceScope.scanDirs.length ? sourceScope.scanDirs : sourceScope.roots)
    .map(absolute => ({ absolute, relative: portableRelative(root, absolute) || '.' }));
  const roots = [...new Set([root, ...allModules.map(module => module.root)])];
  const excludedDirectories = new Set(sourceScope.excludeDirs);
  const visitDirectory = directory => {
    const allowed = sourceDirectoryAllowed(root, directory, sourceScope);
    if (!allowed && !SOURCE_EXCLUDED.has(path.basename(directory))) excludedDirectories.add(realpathSync.native(directory));
    return allowed;
  };
  const sourceFiles = [...new Set((await Promise.all(roots.map(directory => listFiles(directory, file =>
    isSourceFile(file) && !['hvigorfile.ts', 'BuildProfile.ets'].includes(path.basename(file))
    && sourceInScope(root, file, sourceScope), visitDirectory)))).flat())].sort();
  sourceScope.excludedDirectories = [...excludedDirectories].sort();
  delete sourceScope.fingerprint;
  sourceScope.fingerprint = sha256(JSON.stringify(sourceScope));
  if (sourceScope.restricted && !sourceFiles.length) throw errorWithCode('The selected scope contains no scannable source files', 'SCAN_SCOPE_EMPTY');
  const snapshotParts = [];
  for (const file of sourceFiles) {
    const bytes = await readFile(file);
    snapshotParts.push(`${portableRelative(root, file)}\0${sha256(bytes)}`);
    onSourceSnapshotFile?.(file, bytes);
  }
  return {
    root,
    buildProfilePath,
    buildProfile,
    buildProfileHash: sha256(buildProfileText),
    product,
    modules: allModules,
    selectedModules,
    scanDirs,
    sourceScope,
    sourceFiles,
    sourceFileSet: new Set(sourceFiles),
    sourceSnapshot: sha256(snapshotParts.join('\n')),
  };
}

const sourceIndexes = new WeakMap();
function addCandidate(map, key, file) {
  const candidates = map.get(key);
  if (candidates) candidates.push(file);
  else map.set(key, [file]);
}

function sourceIndex(project, platform) {
  let indexes = sourceIndexes.get(project);
  if (!indexes) { indexes = new Map(); sourceIndexes.set(project, indexes); }
  let index = indexes.get(platform);
  if (index?.files === project.sourceFiles && index.size === project.sourceFiles.length) return index;
  const api = platform === 'win32' ? path.win32 : path.posix;
  index = { files: project.sourceFiles, size: project.sourceFiles.length, original: new Set(project.sourceFiles), exact: new Map(), comparable: new Map(),
    physical: new Map(), results: new Map(), physicalIndex: null, api };
  for (const file of project.sourceFiles) {
    addCandidate(index.exact, api.resolve(file), file);
    addCandidate(index.comparable, normalizeComparablePath(file, platform), file);
  }
  indexes.set(platform, index);
  return index;
}

export function canonicalSourceFile(project, absolute, platform = process.platform) {
  if (!project.sourceFiles) return absolute;
  const index = sourceIndex(project, platform), normalized = index.api.resolve(absolute);
  if (index.original.has(absolute)) return absolute;
  if (index.results.has(normalized)) return index.results.get(normalized);
  const exact = index.exact.get(normalized);
  if (exact?.length === 1) { index.results.set(normalized, exact[0]); return exact[0]; }
  const physical = file => {
    if (!index.physical.has(file)) {
      let identity = null;
      try { if (statSync(file).isFile()) identity = normalizeComparablePath(realpathSync.native(file), platform); }
      catch { /* Missing or inaccessible paths cannot identify a registered source. */ }
      index.physical.set(file, identity);
    }
    return index.physical.get(file);
  };
  const actual = physical(normalized);
  let candidates = index.comparable.get(normalizeComparablePath(normalized, platform));
  if (actual && !candidates) {
    if (!index.physicalIndex) {
      index.physicalIndex = new Map();
      for (const file of index.files) {
        const identity = physical(file);
        if (identity) addCandidate(index.physicalIndex, identity, file);
      }
    }
    candidates = index.physicalIndex.get(actual);
  }
  const matches = actual ? (candidates ?? []).filter(file => physical(file) === actual) : [];
  const result = matches.length === 1 ? matches[0] : null;
  index.results.set(normalized, result);
  return result;
}

export function locationInsideScanDirs(project, codeLocation) {
  try {
    const { absolutePath } = sourceLocation(project.root, project.modules, codeLocation);
    return (project.sourceScope ? sourceInScope(project.root, absolutePath, project.sourceScope)
      : project.scanDirs.some(directory => overlaps(absolutePath, directory.absolute)))
      && canonicalSourceFile(project, absolutePath) !== null;
  } catch { return false; }
}

import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseJson5 } from '../format/json5.mjs';
import { errorWithCode } from './errors.mjs';
import { parseCodeLocation } from './paths.mjs';

export const SOURCE_EXCLUDED = new Set(['.git', 'oh_modules', 'node_modules', 'build', 'build-tools', '.hvigor', '.cxx',
  '.test', '.preview', 'test', 'ohosTest', '.api-change-output', 'api-change-output', 'api-upgrade-runs']);
const TOOL_DIRECTORIES = new Set(['.opencode', '.claude', '.agents', '.codex']);
export const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
export const overlaps = (left, right) => inside(left, right) || inside(right, left);
export const relativeSource = (root, file) => path.relative(root, file).split(path.sep).join('/');

// Existing paths and parents of new helpers are checked physically, including junctions.
function physical(file) {
  let parent = path.resolve(file), tail = [];
  while (!existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) return path.resolve(file);
    tail.unshift(path.basename(parent)); parent = next;
  }
  return path.join(realpathSync.native(parent), ...tail);
}

export function resolveSourcePath(root, file, scope = null) {
  const resolved = path.resolve(root, file), actual = physical(resolved);
  const roots = [root, ...(scope?.modules ?? []).map(module => module.root)];
  if (!roots.some(directory => inside(physical(directory), actual)))
    throw errorWithCode(`Source path is outside the project and registered modules: ${file}`, 'SOURCE_PATH_OUTSIDE_PROJECT');
  return resolved;
}

export async function projectModules(root, profile) {
  const modules = [];
  for (const item of profile.modules ?? []) {
    if (typeof item.name !== 'string' || typeof item.srcPath !== 'string') continue;
    const declared = path.resolve(root, item.srcPath);
    let moduleRoot, json;
    try {
      moduleRoot = await realpath(declared);
      json = parseJson5(await readFile(path.join(moduleRoot, 'src/main/module.json5'), 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let build = {};
    try { build = parseJson5(await readFile(path.join(moduleRoot, 'build-profile.json5'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    modules.push({ name: item.name, root: moduleRoot, relativeRoot: relativeSource(root, moduleRoot),
      type: json.module?.type ?? null, deviceTypes: json.module?.deviceTypes ?? [],
      target: build.targets?.find(target => target.name === 'default')?.name ?? build.targets?.[0]?.name ?? 'default',
      hasNativeConfig: typeof build.buildOption?.externalNativeOptions?.path === 'string' });
  }
  return modules;
}

export async function createSourceScope(root, modules, { scanDirs = [], scanModules = [], projectType = 'app', excludeDirs = [], exclusionPolicy = 'tooling-v1' } = {}) {
  if (!['app', 'har'].includes(projectType)) throw errorWithCode('project-type must be app or har', 'INVALID_PROJECT_TYPE');
  if (projectType === 'har' && !scanDirs.length && !scanModules.length)
    throw errorWithCode('HAR requires --scan-module or --scan-dir', 'HAR_SCAN_SCOPE_REQUIRED');
  for (const name of scanModules) if (modules.filter(module => module.name === name).length !== 1)
    throw errorWithCode(`Unknown or ambiguous scan module: ${name}`, 'SCAN_MODULE_INVALID');
  const directories = [];
  for (const directory of scanDirs) {
    const absolute = resolveSourcePath(root, directory, { modules });
    if (!(await stat(absolute)).isDirectory()) throw errorWithCode(`Not a scan directory: ${directory}`, 'SCAN_DIRECTORY_INVALID');
    directories.push(await realpath(absolute));
  }
  const exclusions = [];
  for (const directory of excludeDirs) {
    const absolute = resolveSourcePath(root, directory, { modules });
    if (!(await stat(absolute)).isDirectory()) throw errorWithCode(`Not an excluded directory: ${directory}`, 'SCAN_DIRECTORY_INVALID');
    exclusions.push(await realpath(absolute));
  }
  const selected = modules.filter(module => (!scanModules.length || scanModules.includes(module.name))
    && (!directories.length || directories.some(directory => overlaps(module.root, directory))));
  if (!selected.length) throw errorWithCode('No HarmonyOS modules intersect the requested scan scope', 'SCAN_SCOPE_EMPTY');
  if (projectType === 'har' && selected.some(module => module.type !== 'har'))
    throw errorWithCode('HAR scan scope must contain only HAR modules', 'HAR_SCAN_SCOPE_INVALID');
  const roots = scanModules.length || projectType === 'har' ? selected.map(module => module.root)
    : [root, ...selected.filter(module => !inside(root, module.root)).map(module => module.root)];
  const scope = { projectType, modules, scanModules: [...new Set(scanModules)].sort(),
    excludeDirs: [...new Set(exclusions)].sort(), exclusionPolicy,
    scanDirs: [...new Set(directories)].sort(), roots: [...new Set(roots)].sort(),
    selectedModules: selected.map(module => module.name).sort(), restricted: Boolean(scanDirs.length || scanModules.length || exclusions.length || projectType === 'har') };
  scope.fingerprint = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  return scope;
}

export function sourceDirectoryAllowed(root, target, scope) {
  const absolute = physical(target);
  if (scope?.excludeDirs?.some(directory => inside(directory, absolute))) return false;
  const parts = path.relative(root, absolute).split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    if (SOURCE_EXCLUDED.has(parts[i])) return false;
    if (scope?.exclusionPolicy !== 'legacy' && TOOL_DIRECTORIES.has(parts[i].toLowerCase())) {
      const directory = path.resolve(root, ...parts.slice(0, i + 1));
      if (!scope?.modules?.some(module => inside(directory, module.root) && overlaps(module.root, absolute))) return false;
    }
  }
  return true;
}

export function sourceInScope(root, file, scope) {
  if (!scope) return inside(root, path.resolve(root, file));
  let absolute;
  try { absolute = physical(resolveSourcePath(root, file, scope)); } catch { return false; }
  return scope.roots.some(directory => inside(directory, absolute))
    && (!scope.scanDirs.length || scope.scanDirs.some(directory => inside(directory, absolute)))
    && sourceDirectoryAllowed(root, absolute, scope);
}

export function sourceLocation(root, modules, location) {
  let parsed;
  try { parsed = parseCodeLocation(location); }
  catch { throw errorWithCode(`Invalid Code Location: ${location}`, 'SOURCE_LOCATION_INVALID'); }
  const normalized = parsed.file.replaceAll('\\', '/'), first = normalized.split('/')[0];
  const exact = modules.filter(module => module.name === first);
  const candidates = exact.length ? exact : modules.filter(module => path.basename(module.root) === first);
  if (candidates.length > 1) throw errorWithCode(`Ambiguous module in Code Location: ${location}`, 'SOURCE_LOCATION_AMBIGUOUS');
  const file = candidates.length ? path.join(candidates[0].root, ...normalized.split('/').slice(1)) : path.resolve(root, normalized);
  const absolutePath = resolveSourcePath(root, file, { modules });
  const owners = modules.filter(module => inside(module.root, absolutePath)).sort((a,b) => b.root.length-a.root.length);
  return { absolutePath, projectRelative: relativeSource(root, absolutePath), moduleName: owners[0]?.name ?? null,
    line: parsed.line, column: parsed.column };
}

export function sourceDiscoveryRoots(root, scope) {
  return [...new Set([root, ...(scope?.modules ?? []).map(module => module.root).filter(directory => !inside(root, directory))])].sort();
}

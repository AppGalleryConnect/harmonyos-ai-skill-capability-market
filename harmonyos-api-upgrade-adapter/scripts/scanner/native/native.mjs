import { readdir, stat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { exists, sha256, sha256File } from '../../shared/io/fs-utils.mjs';
import { runProcess } from '../../shared/platform/process.mjs';
import { samePath } from '../../shared/platform/paths.mjs';
import { parseJson5 } from '../../shared/format/json5.mjs';
import { errorWithCode } from '../../shared/platform/errors.mjs';

async function findNinja(directory) {
  if (!(await exists(directory))) return [];
  const results = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    // Preserve the integrated backend's first-match DFS order, including readdir order.
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name === 'build.ninja') results.push(target);
    }
  }
  await visit(directory);
  return results;
}

async function run(command, args, cwd, environment = process.env, timeoutMs = null) {
  const result = await runProcess(command, args, { cwd, env: environment, timeoutMs });
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, error: result.error, timedOut: result.timedOut };
}

// CMake's regeneration rule lists configuration inputs, not ordinary compilation inputs.
function generationInputs(text, directory) {
  const logical = text.replace(/\$\r?\n[ \t]*/g, '');
  const rule = logical.split(/\r?\n/).find(line => /^build\s+.*:\s+RERUN_CMAKE\b/.test(line));
  if (!rule) return [];
  const tokens = [], input = rule.replace(/^build\s+.*:\s+RERUN_CMAKE\b/, '');
  let token = '';
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '$' && [' ', ':', '$'].includes(input[i + 1])) {
      const escaped = input[++i]; token += escaped === '$' ? '\0' : escaped;
    }
    else if (/\s/.test(input[i])) { if (token) tokens.push(token); token = ''; }
    else token += input[i];
  }
  if (token) tokens.push(token);
  return tokens.filter(file => !['|', '||'].includes(file)).map(file => {
    if (file.includes('$')) throw errorWithCode(`Unresolved Ninja generation input: ${file}`, 'NATIVE_CONTEXT_UNRESOLVED', { directory });
    return path.resolve(directory, file.replaceAll('\0', '$'));
  });
}

async function samePhysicalPath(left, right) {
  try { return samePath(await realpath(left), await realpath(right)); }
  catch { return false; }
}

async function nativeContext(project, module, toolchain) {
  const ninjaFiles = await findNinja(path.join(module.root, '.cxx'));
  if (!ninjaFiles.length) return { ninjaFiles, selectedNinja: null, stale: true, configurationSources: [] };
  const selection = toolchain.nativeContextSelection;
  if (ninjaFiles.length > 1 && selection?.strategy !== 'FIRST_NINJA_DFS')
    throw errorWithCode(`Cannot determine the backend-selected Ninja for ${module.name}`, 'NATIVE_CONTEXT_UNRESOLVED', { ninjaFiles, selection });
  const selectedNinja = await realpath(ninjaFiles[0]), directory = path.dirname(selectedNinja);
  const text = await readFile(selectedNinja, 'utf8');
  const parts = path.relative(path.join(module.root, '.cxx'), selectedNinja).split(path.sep);
  const layout = parts.length === 5 && !parts.includes('..');
  const buildMode = layout ? parts[2] : null, abi = layout ? parts[3] : null;
  if (layout && (parts[0] !== project.product.name || parts[1] !== module.target))
    throw errorWithCode(`Selected Ninja product/target does not match ${module.name}`, 'NATIVE_CONTEXT_UNRESOLVED', { selectedNinja, product: project.product.name, target: module.target });
  const cacheFile = path.join(directory, 'CMakeCache.txt');
  const cacheText = await exists(cacheFile) ? await readFile(cacheFile, 'utf8') : null;
  const cache = Object.fromEntries((cacheText ?? '').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([^#/:][^:=]*)(?::[^=]*)?=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
  const profileFile = path.join(module.root, 'build-profile.json5');
  const profile = await exists(profileFile) ? parseJson5(await readFile(profileFile, 'utf8')) : {};
  const cmake = profile.buildOption?.externalNativeOptions?.path;
  const sourceRoot = typeof cmake === 'string' ? path.dirname(path.resolve(module.root, cmake)) : null;
  const mismatch = cache.CMAKE_CACHEFILE_DIR && !await samePhysicalPath(cache.CMAKE_CACHEFILE_DIR, directory)
    || sourceRoot && cache.CMAKE_HOME_DIRECTORY && !await samePhysicalPath(cache.CMAKE_HOME_DIRECTORY, sourceRoot)
    || abi && cache.OHOS_ARCH && cache.OHOS_ARCH !== abi
    || ['debug', 'release'].includes(buildMode) && cache.CMAKE_BUILD_TYPE && cache.CMAKE_BUILD_TYPE.toLowerCase() !== buildMode;
  if (mismatch) throw errorWithCode(`Selected CMake context does not match ${module.name}`, 'NATIVE_CONTEXT_UNRESOLVED', { selectedNinja, cacheFile, sourceRoot });
  const inputs = generationInputs(text, directory);
  for (const file of [project.buildProfilePath ?? path.join(project.root, 'build-profile.json5'), profileFile,
    path.join(module.root, 'src', 'main', 'module.json5'),
    typeof cmake === 'string' ? path.resolve(module.root, cmake) : path.join(module.root, 'CMakeLists.txt')])
    if (file && await exists(file)) inputs.push(file);
  const configurationSources = [], ninjaTime = (await stat(selectedNinja)).mtimeMs;
  let stale = cacheText !== null && (await stat(cacheFile)).mtimeMs > ninjaTime;
  for (const file of [...new Set(inputs)].sort()) {
    // CMakeCache is a generated output. Its identity is checked separately below.
    if (samePath(file, cacheFile)) {
      if (cacheText === null) { stale = true; configurationSources.push({ file, hash: null }); }
      continue;
    }
    if (!await exists(file)) { stale = true; configurationSources.push({ file, hash: null }); continue; }
    const bytes = await readFile(file);
    configurationSources.push({ file, hash: sha256(bytes) });
    if ((await stat(file)).mtimeMs > ninjaTime) stale = true;
  }
  const state = { ninjaFiles, selectedNinja, unusedNinjaFiles: ninjaFiles.slice(1),
    selection: selection ?? { strategy: 'UNIQUE_NINJA' }, buildMode, abi, sourceRoot: cache.CMAKE_HOME_DIRECTORY ?? sourceRoot,
    ninjaSha256: sha256(text), cacheSha256: cacheText === null ? null : sha256(cacheText), configurationSources, stale };
  state.contextSha256 = sha256(JSON.stringify([state.selectedNinja, state.ninjaSha256, state.cacheSha256, configurationSources]));
  return state;
}

export async function verifyNativeContexts({ project, toolchain, records }) {
  for (const record of records) {
    const module = (project.selectedModules ?? project.modules).find(item => item.name === record.module);
    const current = await nativeContext(project, module, toolchain);
    if (current.contextSha256 !== record.contextSha256
      || record.selection?.sha256 && await sha256File(record.selection.source) !== record.selection.sha256)
      throw errorWithCode(`Native scan context changed for ${record.module}`, 'NATIVE_CONTEXT_CHANGED', { selectedNinja: record.selectedNinja, currentNinja: current.selectedNinja });
  }
}

export async function ensureNativeBuild({ project, toolchain, mode = 'auto', runCommand = run }) {
  const nativeModules = (project.selectedModules ?? project.modules).filter((module) => module.hasNativeConfig);
  const records = [];
  for (const module of nativeModules) {
    let context = await nativeContext(project, module, toolchain);
    let rebuilt = false;
    let dependencyInstall = null;
    let build = null;
    if (context.stale && mode === 'auto') {
      if (!toolchain.hvigorw) {
        const error = new Error(`Hvigor is unavailable for native module ${module.name}`);
        error.code = 'NATIVE_BUILD_TOOL_UNAVAILABLE';
        throw error;
      }
      if (!toolchain.ohpm) {
        const error = new Error(`ohpm is unavailable for native module ${module.name}; cannot install dependencies before build`);
        error.code = 'OHPM_UNAVAILABLE';
        throw error;
      }
      if (context.selectedNinja && !context.buildMode)
        throw errorWithCode(`Cannot determine buildMode for ${context.selectedNinja}`, 'NATIVE_CONTEXT_UNRESOLVED');
      const install = await runCommand(toolchain.ohpm, ['install'], project.root,
        { ...process.env, DEVECO_SDK_HOME: toolchain.sdkRoot }, 10 * 60_000);
      dependencyInstall = { command: toolchain.ohpm, args: ['install'], cwd: project.root, ...install };
      if (install.code !== 0 || install.error || install.timedOut) {
        const error = new Error(`ohpm install failed for native module ${module.name}`);
        error.code = 'OHPM_INSTALL_FAILED';
        error.details = {
          ...dependencyInstall,
        };
        throw error;
      }
      const args = [
        '--mode', 'module',
        '-p', `module=${module.name}@${module.target}`,
        '-p', `product=${project.product.name}`,
        ...(context.buildMode ? ['-p', `buildMode=${context.buildMode}`] : []),
        'compileNative', '--analyze=normal', '--no-daemon',
      ];
      const result = await runCommand(toolchain.hvigorw, args, project.root,
        { ...process.env, DEVECO_SDK_HOME: toolchain.sdkRoot }, 30 * 60_000);
      build = { command: toolchain.hvigorw, args, cwd: project.root, ...result };
      if (result.code !== 0 || result.error || result.timedOut) {
        const error = new Error(`Hvigor native build failed for ${module.name}`);
        error.code = 'NATIVE_BUILD_FAILED';
        error.details = build;
        throw error;
      }
      rebuilt = true;
      const before = context;
      try { context = await nativeContext(project, module, toolchain); }
      catch (error) {
        error.details = { ...error.details, dependencyInstall, build };
        throw error;
      }
      for (const item of before.configurationSources) {
        if (item.hash !== null && (!await exists(item.file) || await sha256File(item.file) !== item.hash))
          throw errorWithCode(`Native configuration changed during build for ${module.name}`, 'NATIVE_CONTEXT_CHANGED', { file: item.file, dependencyInstall, build });
      }
    }
    if (!context.selectedNinja || context.stale && !rebuilt || context.configurationSources.some(item => item.hash === null)) {
      throw errorWithCode(`build.ninja is missing or stale for native module ${module.name}`, 'NATIVE_CONTEXT_STALE', { ...context, dependencyInstall, build });
    }
    const { stale, ...evidence } = context;
    records.push({ module: module.name, ...evidence, rebuilt, dependencyInstall, build });
  }
  return records;
}

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { detectRnohProject, rnBusinessSources } from '../scanner/rnoh/rnoh.mjs';
import { sha256 } from '../shared/io/fs-utils.mjs';

const SKIP = new Set(['node_modules', 'oh_modules', 'build', '.hvigor', '.git', '.idea', '.cxx']);
// Common RNOH bundle outputs: bundle.harmony.js, *.harmony.bundle, hermes_bundle.hbc, split bundles under rawfile/bundle/.
const BUNDLE = /(?:\.bundle|\.jsbundle|\.hbc|\.harmony\.js|bundle[^/]*\.js)$/i;
const slash = file => file.split(path.sep).join('/');

async function rawfileBundles(root) {
  const found = [];
  const visit = async (directory, depth, inRawfile) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (inRawfile) await visit(file, depth + 1, true);
        else if (depth < 8 && !SKIP.has(entry.name)) await visit(file, depth + 1, /\/src\/[^/]+\/resources\/rawfile$/.test(slash(file)));
      } else if (inRawfile && entry.isFile() && BUNDLE.test(entry.name)) found.push(file);
    }
  };
  await visit(root, 0, false);
  return found;
}

/**
 * Hvigor packages whatever bundle already sits in rawfile; it never compiles RN business JS.
 * Record which bundle this build packaged and whether business JS or JS patches changed after it was generated.
 * Returns null for non-RNOH projects. Comparison uses modification time, so the result is a prompt, not proof.
 */
export async function inspectRnBundle(projectRoot) {
  const detected = await detectRnohProject({ root: projectRoot, modules: [] });
  if (!detected) return null;
  const relative = file => slash(path.relative(projectRoot, file));
  const bundles = [];
  for (const file of await rawfileBundles(projectRoot)) {
    const info = await stat(file);
    bundles.push({ path: relative(file), bytes: info.size, modifiedAt: info.mtime.toISOString(), mtimeMs: info.mtimeMs,
      sha256: sha256(await readFile(file)) });
  }
  const result = { status: null, basis: 'MTIME', jsRoot: detected.js ? relative(detected.js.root) || '.' : null, bundles, message: '' };
  if (!bundles.length) {
    return { ...result, status: 'MISSING',
      message: '工程 rawfile 中未找到 RN bundle，本次构建产物不含业务 JS（可能由 Metro 或外部下发加载）；业务 JS 修改未被本次构建验证' };
  }
  if (!detected.js) {
    for (const item of bundles) delete item.mtimeMs;
    return { ...result, status: 'JS_PROJECT_NOT_FOUND', message: '未找到 RN JS 工程，无法判断 bundle 是否由当前业务 JS 生成' };
  }
  const sources = await rnBusinessSources(detected.js.root, projectRoot);
  try {
    for (const entry of await readdir(path.join(detected.js.root, 'patches'), { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith('.patch')) sources.push(path.join(detected.js.root, 'patches', entry.name));
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  const times = [];
  for (const file of sources) times.push({ file, mtimeMs: (await stat(file)).mtimeMs });
  times.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of bundles) { item.newerSourceCount = times.filter(source => source.mtimeMs > item.mtimeMs).length; delete item.mtimeMs; }
  const stale = bundles.filter(item => item.newerSourceCount > 0);
  const oldest = Math.min(...bundles.map(item => Date.parse(item.modifiedAt)));
  result.sourceCount = times.length;
  result.newerSources = times.filter(source => source.mtimeMs > oldest).slice(0, 10)
    .map(source => ({ path: slash(path.relative(detected.js.root, source.file)), modifiedAt: new Date(source.mtimeMs).toISOString() }));
  result.status = !stale.length ? 'FRESH' : stale.length === bundles.length ? 'STALE' : 'PARTIALLY_STALE';
  result.message = result.status === 'FRESH' ? 'rawfile 中的 RN bundle 均晚于业务 JS 与 patches 的最后修改时间'
    : `${stale.length}/${bundles.length} 个 RN bundle 早于业务 JS 或 patches 的最后修改时间；Hvigor 不编译业务 JS，须重新生成 bundle 后再构建，否则 JS 修改未进入本次产物`;
  return result;
}

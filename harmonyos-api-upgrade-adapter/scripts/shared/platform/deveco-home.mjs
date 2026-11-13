import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../io/fs-utils.mjs';

export async function resolveDevEcoHome(sdkRoot, supplied = null, env = process.env) {
  let root = path.resolve(supplied || env.DEVECO_HOME || path.dirname(sdkRoot));
  if (/\.app$/i.test(path.basename(root)) && await exists(path.join(root, 'Contents')))
    root = path.join(root, 'Contents');
  try { return await realpath(root); }
  catch (error) { if (error.code === 'ENOENT') return root; throw error; }
}

export async function readProductInfo(root, platform = process.platform) {
  for (const file of [path.join(root, 'product-info.json'), path.join(root, 'Resources', 'product-info.json'), path.join(root, 'bin', 'product-info.json')]) {
    if (!await exists(file)) continue;
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      const os = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
      const launch = Array.isArray(data.launch) ? data.launch.find(item => item.os === os) ?? data.launch[0] : null;
      return { file, name: data.name ?? null, version: data.version ?? null, buildNumber: data.buildNumber ?? null,
        java: launch?.javaExecutablePath ? path.resolve(path.dirname(file), launch.javaExecutablePath) : null };
    } catch { return { file, name: null, version: null, buildNumber: null, java: null }; }
  }
  return null;
}

export function executableNames(base, platform) {
  if (platform !== 'win32') return [base];
  return ['java', 'hdc', 'Emulator'].includes(base) ? [`${base}.exe`, base] : [`${base}.cmd`, `${base}.bat`, `${base}.exe`, base];
}

export async function firstExisting(candidates) {
  for (const file of candidates.filter(Boolean)) if (await exists(file)) return file;
  return null;
}

export async function discoverDevEcoTools(root, productInfo, platform = process.platform) {
  const tool = (directory, base) => firstExisting(executableNames(base, platform).map(name => path.join(root, directory, name)));
  return {
    java: await firstExisting([productInfo?.java,
      ...executableNames('java', platform).map(name => path.join(root, 'jbr', 'Contents', 'Home', 'bin', name)),
      ...executableNames('java', platform).map(name => path.join(root, 'jbr', 'bin', name))]),
    hvigorw: await tool(path.join('tools', 'hvigor', 'bin'), 'hvigorw'),
    ohpm: await tool(path.join('tools', 'ohpm', 'bin'), 'ohpm'),
    emulator: await tool(path.join('tools', 'emulator'), 'Emulator'),
  };
}

import { access } from 'node:fs/promises';
import path from 'node:path';
import { errorWithCode } from './errors.mjs';

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

export async function resolveSdkRoot(input, { required = true } = {}) {
  const inputPath = path.resolve(input);
  let root = inputPath;
  const checkedPaths = [path.join(root, 'default', 'sdk-pkg.json')];
  if (!await exists(checkedPaths[0])) {
    if ((process.platform === 'win32' ? path.basename(inputPath).toLowerCase() : path.basename(inputPath)) === 'default') {
      checkedPaths.push(path.join(inputPath, 'sdk-pkg.json'));
      if (await exists(checkedPaths[1])) root = path.dirname(inputPath);
      else root = null;
    } else root = null;
  }
  if (!root) {
    if (!required) return null;
    throw errorWithCode(`DevEco SDK metadata not found: ${inputPath}。请选择 SDK 根目录或其 default 目录。`,
      'SDK_ROOT_INVALID', { inputPath, checkedPaths, hint: 'SDK 根目录应包含 default/sdk-pkg.json' });
  }
  return { root, inputPath, defaultRoot: path.join(root, 'default'), packagePath: path.join(root, 'default', 'sdk-pkg.json') };
}

import { mkdir, readFile, realpath, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { relativePathInside } from '../shared/platform/paths.mjs';
import { sha256 } from '../shared/io/fs-utils.mjs';
import { requireValue } from './contracts.mjs';

export const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
export async function writeJson(file, data, exclusive = false) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
}
export async function inside(root, relative) {
  requireValue(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), '必须为归档相对路径');
  const file = path.resolve(root, relative);
  requireValue(relativePathInside(root, file) !== null, '归档路径越界');
  const base = await realpath(root);
  let parent = file;
  for (;;) {
    try { requireValue(relativePathInside(base, await realpath(parent)) !== null, '归档物理路径越界'); break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; parent = path.dirname(parent); }
  }
  return file;
}
export async function fingerprint(file) {
  requireValue((await stat(file)).isFile(), `不是文件: ${file}`);
  return sha256(await readFile(file));
}

import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../platform/fs.mjs';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(file) {
  return sha256(await readFile(file));
}

export async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export function portableRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

export function resolveInside(root,file) {
  const base=path.resolve(root),target=path.resolve(base,file),relative=path.relative(base,target);
  if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error(`Path escapes project root: ${file}`);
  return target;
}

export async function listFiles(root, predicate = () => true, visitDirectory = () => true, { allowMissing = false } = {}) {
  if (allowMissing && !await pathExists(root)) return [];
  const results = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && visitDirectory(target)) await visit(target);
      else if (entry.isFile() && predicate(target)) results.push(target);
    }
  }
  await visit(root);
  return results;
}

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
}

export async function atomicWrite(target, content) {
  await atomicWriteFile(target, content, { ensureDirectory: ensureDir });
}

export async function pathExists(file) {
  try { await access(file); return true; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}

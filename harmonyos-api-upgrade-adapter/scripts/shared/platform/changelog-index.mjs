import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../io/fs-utils.mjs';

export async function loadChangelogIndex(referenceRoot) {
  const file = path.resolve(referenceRoot, 'changelogs-index.json');
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { documents: [], overview: [] };
    throw error;
  }
  const index = JSON.parse(bytes.toString('utf8'));
  if (index.schemaVersion !== 1 || !Array.isArray(index.documents) || !Array.isArray(index.overview))
    throw new Error(`Invalid changelog index: ${file}`);
  const paths = new Map();
  for (const document of index.documents) {
    const value = document?.path;
    if (typeof value !== 'string' || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..'))
      throw new Error(`Invalid changelog document path: ${value}`);
    const key = value.replaceAll('\\', '/').toLowerCase();
    if (paths.has(key)) throw new Error('Duplicate changelog document path');
    paths.set(key, document);
    document.path = value.replaceAll('\\', '/');
  }
  return { ...index, source: { file, hash: sha256(bytes) } };
}

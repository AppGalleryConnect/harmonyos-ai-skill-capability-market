// Canonical text hashes used by official source regression tests.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {sha256,sha256File} from '../../shared/io/fs-utils.mjs';
const textExtensions=new Set(['.md','.json','.json5','.txt','.csv','.tsv']);
export const isTextReference=file=>textExtensions.has(path.extname(file).toLowerCase());
export async function referenceDigest(file) {
  return isTextReference(file)?sha256((await readFile(file,'utf8')).replace(/^\ufeff/,'').replace(/\r\n?/g,'\n')):sha256File(file);
}

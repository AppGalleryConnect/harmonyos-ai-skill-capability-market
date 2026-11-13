import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { samePath } from './paths.mjs';

// Node resolves module URLs physically, while argv may retain installation links or 8.3 paths.
export function isMainModule(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try { return samePath(realpathSync.native(fileURLToPath(moduleUrl)), realpathSync.native(entry)); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) return false;
    throw error;
  }
}

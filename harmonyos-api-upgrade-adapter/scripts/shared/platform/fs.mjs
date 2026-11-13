import { randomUUID } from 'node:crypto';
import { chmod, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RETRYABLE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function retryFileOperation(operation, { maxRetries = 4, retryDelayMs = 25 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(error.code) || attempt === maxRetries) throw error;
      await wait(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

async function existingMode(target) {
  try { return (await stat(target)).mode; } catch { return null; }
}

export async function replaceStagedPath(staged, target, { platform = process.platform } = {}) {
  let replacementError = null;
  try {
    await retryFileOperation(() => rename(staged, target));
    return;
  } catch (error) {
    const directoryReplacement = error.code === 'EEXIST' || error.code === 'ENOTEMPTY';
    const windowsReplacement = platform === 'win32' && RETRYABLE_CODES.has(error.code);
    if (!directoryReplacement && !windowsReplacement) throw error;
    replacementError = error;
  }
  try { await stat(target); } catch { throw replacementError; }
  const backup = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.bak`);
  let movedOriginal = false;
  try {
    await retryFileOperation(() => rename(target, backup));
    movedOriginal = true;
    await retryFileOperation(() => rename(staged, target));
    await rm(backup, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
  } catch (error) {
    if (movedOriginal) {
      await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
      try { await retryFileOperation(() => rename(backup, target)); } catch { /* Preserve the original error. */ }
    }
    throw error;
  }
}

export async function atomicWriteFile(target, content, {
  ensureDirectory,
  platform = process.platform,
} = {}) {
  if (ensureDirectory) await ensureDirectory(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const mode = await existingMode(target);
  try {
    await writeFile(temporary, content);
    if (mode !== null) await chmod(temporary, mode);
    await replaceStagedPath(temporary, target, { platform });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    throw error;
  }
}

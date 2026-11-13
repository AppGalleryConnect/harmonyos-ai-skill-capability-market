import { errorWithCode } from './errors.mjs';

export function requireScanMode(mode) {
  if (!['upgrade', 'deprecated'].includes(mode))
    throw errorWithCode('--mode must be explicitly set to upgrade or deprecated', 'SCAN_MODE_INVALID');
  return mode;
}

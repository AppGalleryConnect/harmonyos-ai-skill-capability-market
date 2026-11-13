import path from 'node:path';

export function parseCodeLocation(value) {
  const match = String(value).match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!match || !match[1] || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1
    || (match[3] && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) < 1)))
    throw new Error(`Invalid Code Location: ${value}`);
  return { file: match[1], line: Number(match[2]), column: match[3] ? Number(match[3]) : null };
}

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function normalizeComparablePath(value, platform = process.platform) {
  const api = pathApi(platform);
  const normalized = api.normalize(api.resolve(String(value)));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(left, right, platform = process.platform) {
  return normalizeComparablePath(left, platform) === normalizeComparablePath(right, platform);
}

export function portablePath(value) {
  return String(value).replaceAll('\\', '/');
}

export function relativePathInside(root, file, platform = process.platform) {
  const api = pathApi(platform);
  const relative = api.relative(api.resolve(root), api.resolve(file));
  if (relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return null;
  return portablePath(relative);
}

export function comparableCodeLocation(value, root = null, platform = process.platform) {
  const match = String(value).match(/^(.*?)(:\d+(?::\d+)?)?$/);
  let file = match[1];
  if (root && pathApi(platform).isAbsolute(file)) file = relativePathInside(root, file, platform) ?? file;
  file = portablePath(file);
  return (platform === 'win32' ? file.toLowerCase() : file) + (match[2] ?? '');
}

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { relativePathInside } from '../shared/platform/paths.mjs';
import { readTask } from '../shared/platform/task-context.mjs';

const host = '127.0.0.1';
const expiresInSeconds = 300;
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'], ['.md', 'text/plain; charset=utf-8'], ['.txt', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'], ['.pdf', 'application/pdf'],
]);

async function respond(request, response, root, address) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (request.headers.host !== address) { response.writeHead(403).end(); return; }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let parts;
  try {
    const requestPath = request.url.split('?', 1)[0];
    if (!requestPath.startsWith('/')) { response.writeHead(400).end(); return; }
    parts = requestPath.slice(1).split('/').map(decodeURIComponent);
  } catch { response.writeHead(400).end(); return; }
  if (parts.some(part => part === '.' || part === '..' || /[/\\\x00]/.test(part)
    || (process.platform === 'win32' && part.includes(':')))) {
    response.writeHead(403).end();
    return;
  }
  const target = path.resolve(root, ...parts);
  if (relativePathInside(root, target) === null) { response.writeHead(403).end(); return; }
  try {
    const file = await realpath(target);
    if (relativePathInside(root, file) === null) { response.writeHead(403).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': types.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
      'Content-Length': info.size });
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(file), response);
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) response.destroy();
    else response.writeHead(['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 403).end();
  }
}

export async function startReportPreview({ taskFile, html }) {
  const { physicalDirectory: root } = await readTask(taskFile);
  const file = await realpath(html), relative = relativePathInside(root, file);
  if (!relative || path.extname(file).toLowerCase() !== '.html' || !(await stat(file)).isFile())
    throw new Error('预览需要任务目录内的实际 HTML 文件');

  const server = createServer((request, response) => {
    void respond(request, response, root, `${host}:${server.address()?.port}`).catch(() => response.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const close = () => new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  const timer = setTimeout(() => void close(), expiresInSeconds * 1000);
  server.once('close', () => clearTimeout(timer));
  const encoded = relative.split('/').map(encodeURIComponent).join('/');
  return { url: `http://${host}:${server.address().port}/${encoded}`, expiresInSeconds, close };
}

import { readFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, sha256 } from '../io/fs-utils.mjs';
import { samePath } from './paths.mjs';

export async function physicalOutput(file) {
  let current = path.resolve(file);
  const tail = [];
  for (;;) {
    try { return path.join(await realpath(current), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current)); current = parent;
    }
  }
}

// Only replace bytes that are still owned by a previous successful generation.
// Unknown or user-edited files are preserved, including physical path aliases.
// An optional fingerprint groups equivalent renders, while ownership uses the exact bytes.
export async function saveGeneratedOutput(target, content, previous = {}, protectedFiles = [], { fingerprint } = {}) {
  const bytes = Buffer.from(content), hash = sha256(bytes), requested = path.resolve(target);
  const contentKey = fingerprint ? fingerprint(bytes) : hash;
  const identity = await physicalOutput(requested);
  for (const file of protectedFiles) if (samePath(identity, await physicalOutput(file)))
    throw new Error(`不能覆盖来源文件：${file}`);
  for (let attempt = 0; ; attempt++) {
    const ext = path.extname(requested);
    const output = attempt ? path.join(path.dirname(requested), `${path.basename(requested, ext)}-${contentKey.slice(0,12)}${attempt > 1 ? `-${attempt}` : ''}${ext}`) : requested;
    let old = null;
    try { old = await readFile(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (old?.equals(bytes)) return { output, sha256: hash };
    const oldHash = old && sha256(old);
    const registered = old && previous.file && previous.sha256 && (fingerprint || oldHash === previous.sha256)
      && samePath(await physicalOutput(previous.file), attempt ? await physicalOutput(output) : identity);
    const owned = registered && previous.sha256 === oldHash;
    if (old && fingerprint && (!registered || owned) && fingerprint(old) === contentKey) return { output, sha256: oldHash };
    await mkdir(path.dirname(output), { recursive: true });
    if (!old) {
      try { await writeFile(output, bytes, { flag: 'wx' }); return { output, sha256: hash }; }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    }
    if (!attempt && owned) {
      if (sha256(await readFile(output)) !== previous.sha256) continue;
      await atomicWrite(output, bytes);
      return { output, sha256: hash };
    }
  }
}

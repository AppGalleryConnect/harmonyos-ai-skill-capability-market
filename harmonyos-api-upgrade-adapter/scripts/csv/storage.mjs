import { readFile, writeFile, mkdir, rmdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { ensureBatchDirectory } from '../shared/platform/artifact-layout.mjs';
import { checkSnapshot } from '../shared/platform/group-results.mjs';
import { sha256 } from '../shared/io/fs-utils.mjs';

export async function jsonInput(file) {
  const bytes = await readFile(file);
  return { value: JSON.parse(bytes.toString('utf8').replace(/^\ufeff/, '')),
    snapshot: { file: path.resolve(file), hash: sha256(bytes) }, bytes };
}

export async function exclusive(file, bytes) {
  try { await writeFile(file, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!Buffer.from(await readFile(file)).equals(Buffer.from(bytes))) throw new Error(`文件已存在且不同，请另存：${file}`);
  }
}

export async function withReceiptOutput(command, file, operation) {
  const output = path.resolve(file);
  await mkdir(path.dirname(output), { recursive: true });
  const exists = await lstat(output).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (exists) throw new Error(`回执输出已存在，请另存：${output}`);

  const result = await operation();
  try {
    await writeFile(output, JSON.stringify({ ok: true, result }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (cause) {
    const committed = command !== 'verify';
    const state = committed ? '操作已提交。请先回读分组或进度，再判断是否需要重试' : '只读核对已完成。请使用新的回执路径';
    throw Object.assign(new Error(`${state}。回执写入失败：${output}（${cause.message}）`, { cause }), {
      code: 'RECEIPT_WRITE_FAILED', details: { command, output, committed, result },
    });
  }
  return result;
}

export async function locked(layout, operation) {
  await ensureBatchDirectory(layout, layout.deliveryDirectory);
  const lock = path.join(layout.deliveryDirectory, '.results-write.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('分组或进度正在写入，请等待唯一写入者完成；不要并发更新');
  }
  try { return await operation(); }
  finally { await rmdir(lock); }
}

export async function unchanged(state, extra = []) {
  for (const snapshot of [...state.snapshots, ...extra]) await checkSnapshot(snapshot);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, exists, pathExists, listFiles } from '../io/fs-utils.mjs';

test('shared traversal preserves strict scanner and optional maintenance missing-directory behavior', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shared-files-中文 空格-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = path.join(root, 'missing');
  await assert.rejects(listFiles(missing), { code: 'ENOENT' });
  assert.deepEqual(await listFiles(missing, () => true, () => true, { allowMissing: true }), []);
  assert.equal(await exists(missing), false);
  assert.equal(await pathExists(missing), false);
  assert.equal(await exists(null), false);
  await assert.rejects(pathExists(null), TypeError);
  await mkdir(path.join(root, 'excluded'));
  await writeFile(path.join(root, 'a.txt'), 'a');
  await writeFile(path.join(root, 'excluded', 'b.txt'), 'b');
  assert.deepEqual(await listFiles(root, file => file.endsWith('.txt'), directory => path.basename(directory) !== 'excluded'), [path.join(root, 'a.txt')]);
});

test('shared atomic writes replace an existing file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shared-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'existing.txt');
  await writeFile(file, 'before');
  await atomicWrite(file, 'after');
  assert.equal(await readFile(file, 'utf8'), 'after');
});

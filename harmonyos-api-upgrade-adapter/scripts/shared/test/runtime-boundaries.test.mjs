import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { identifier, validatePlan } from '../../runtime/contracts.mjs';
import { inside } from '../../runtime/io.mjs';
import { fixture } from './fixtures/runtime/plan.mjs';

test('所有平台都拒绝Windows设备名和大小写冲突，避免相同物理输出身份', () => {
  for (const id of ['CON', 'aux', 'NUL', 'PRN', 'com1', 'LPT9']) assert.throws(() => identifier(id));
  const p = fixture(); p.cases.cases.push({ ...structuredClone(p.cases.cases[0]), id: 'c1' });
  assert.throws(() => validatePlan(p), /重复|大小写/);
  const q = fixture(); q.cases.cases[0].capturePoints = [{ id: 'P1', assertionIds: ['A1'] }, { id: 'p1', assertionIds: ['A1'] }];
  assert.throws(() => validatePlan(q), /重复|大小写/);
});
test('归档路径拒绝词法越界及junction/符号链接指向外部，兼容中文空格', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'runtime 路径-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root'), outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inside(root, path.join('..', 'outside', 'a')), /越界/);
  await assert.rejects(inside(root, path.join('link', 'a')), /越界/);
  assert.equal(await inside(root, path.join('正常', '文件.json')), path.join(root, '正常', '文件.json'));
});

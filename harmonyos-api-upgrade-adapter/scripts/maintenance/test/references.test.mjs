import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {referenceDigest} from '../references/references.mjs';

test('reference text hashes are stable across BOM and line endings', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adapter-reference-hash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lf = path.join(root, 'lf.md');
  const crlf = path.join(root, 'crlf.md');
  await writeFile(lf, '标题\n内容\n');
  await writeFile(crlf, '\ufeff标题\r\n内容\r\n');
  assert.equal(await referenceDigest(lf), await referenceDigest(crlf));
});

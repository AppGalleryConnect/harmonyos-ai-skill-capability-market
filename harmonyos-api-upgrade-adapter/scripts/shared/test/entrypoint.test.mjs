import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../../../', import.meta.url));
test('all guarded CLIs execute through physical and installation-link paths', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), '入口 中文-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alias = path.join(directory, 'SKILL~1');
  await symlink(await realpath(root), alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const cli of ['csv', 'runtime', 'report', 'toolchain']) {
    const file = path.join('scripts', cli, 'cli.mjs');
    const run = base => spawnSync(process.execPath, [path.join(base, file), 'help'], { encoding: 'utf8', shell: false });
    const direct = run(root), linked = run(alias);
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(linked.status, 0, linked.stderr);
    assert.ok(linked.stdout.trim(), `${cli} must not silently exit through a link`);
    assert.equal(linked.stdout, direct.stdout);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Python fake-driver验证唯一目标、断言、完整采集和空脚本拒绝，不需要真实设备/Hypium', () => {
  const python = process.env.RUNTIME_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const directory = fileURLToPath(new URL('../../runtime/python', import.meta.url));
  const r = spawnSync(python, ['-B', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py'], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr);
});

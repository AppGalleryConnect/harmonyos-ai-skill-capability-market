import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { passwordInputPlan } from './fixtures/runtime/passwordinput-plan.mjs';
import { validatePlan } from '../../runtime/contracts.mjs';

test('107行原始扫描保持分母，完整确定、防连点与普通清空分开，未消费组件不冒充已测', async () => {
  const app = await readFile(new URL('./fixtures/runtime/scan-app.csv', import.meta.url));
  const lib = await readFile(new URL('./fixtures/runtime/scan-library.csv', import.meta.url));
  const p = passwordInputPlan(app, lib, [{ path: 'Index.ets', startLine: 1, endLine: 1, text: '夹具仅验证范围映射，不证明真实源码阅读' }]);
  assert.equal(validatePlan(p).selectedRows, 107);
  assert.equal(p.sources[0].sha256, '29e1cfe24ae111ddf928d289649815efa20f3e315ca236285856870b492a040d');
  assert.equal(p.sources[1].sha256, 'e0fea6c362135de46a03c96560651b0b28cdcd12c62f40380a90a8780434c982');
  const byPoint = id => p.spec.points.find(x => x.id === id).rowRefs.filter(r => r.sourceId === 'app').map(r => Number(r.rowId.split(':').at(-1)));
  assert.ok(byPoint('full-confirm').includes(7) && byPoint('full-confirm').includes(22));
  assert.ok(byPoint('debounce').includes(9) && byPoint('debounce').includes(24));
  assert.ok(!byPoint('clear').includes(9)); assert.ok(!byPoint('confirm').includes(7));
  assert.equal(p.spec.gaps.length, 4);
  p.cases.cases = p.cases.cases.filter(c => c.id !== 'debounce');
  assert.throws(() => validatePlan(p), /debounce/);
});

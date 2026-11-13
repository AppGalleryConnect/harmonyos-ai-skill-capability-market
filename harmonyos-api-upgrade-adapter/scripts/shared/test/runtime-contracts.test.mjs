import test from 'node:test';
import assert from 'node:assert/strict';
import { createSource, validatePlan } from '../../runtime/contracts.mjs';
import { fixture, bytes } from './fixtures/runtime/plan.mjs';

test('CSV身份保留重复行，跨来源不丢失，选择必须明确', () => {
  const s = createSource(bytes, 'app', 'all');
  assert.equal(s.rows.length, 2); assert.notEqual(s.rows[0].rowId, s.rows[1].rowId);
  assert.equal(createSource(bytes, 'library', 'all').rows[0].rowId, s.rows[0].rowId);
  assert.throws(() => createSource(bytes, 'app'), /选择/);
  assert.throws(() => createSource(bytes, 'app', ['foreign:1']), /未知/);
});
test('每个选中行保留完整测试点关联，不能用同页其他分支代替', () => {
  const p = fixture(); assert.equal(validatePlan(p).selectedRows, 2);
  p.spec.points.push({ ...p.spec.points[0], id: 'debounce', trigger: '500ms内再次点击' });
  assert.throws(() => validatePlan(p), /debounce/);
  p.spec.gaps.push({ pointId: 'debounce', rowRefs: p.spec.points[1].rowRefs, reason: '缺少连续操作能力' });
  assert.equal(validatePlan(p).selectedRows, 2);
});
test('不接受范围外行、错误路由、无判据、无复位和缺证据计划', () => {
  for (const mutate of [
    p => { p.cases.cases[0].assertions[0].rowRefs[0].rowId = 'unknown:1'; },
    p => { p.spec.points[0].routeId = 'missing'; },
    p => { delete p.cases.cases[0].assertions[0].afterExpected; },
    p => { p.cases.cases[0].preconditions.reset = ''; },
    p => { p.cases.cases[0].assertions[0].kind = 'visual'; },
    p => { p.sources[0].rows[0].selected = false; },
  ]) { const p = fixture(); mutate(p); assert.throws(() => validatePlan(p)); }
});

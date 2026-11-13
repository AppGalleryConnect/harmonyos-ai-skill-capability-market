import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRows } from '../../runtime/report.mjs';
import { fixture } from './fixtures/runtime/plan.mjs';
import { formatUpgradeResults } from '../format/upgrade-results.mjs';
import { parseCsv } from '../format/csv.mjs';

test('行级必测项取交集，失败算实测但不是通过，前后共同失败可比', () => {
  const p = fixture(), phases = { before: { C1: { valid: true, dataVerified: true, observations: { A1: 'FAIL' }, visuals: {}, captures: [] } },
    after: { C1: { valid: true, dataVerified: true, observations: { A1: 'FAIL' }, visuals: {}, captures: [] } } };
  const rows = aggregateRows(p, phases, 'COMPARE');
  assert.equal(rows[0].before.functional, 'FAIL'); assert.equal(rows[0].after.functional, 'FAIL');
  assert.equal(rows[0].comparable, true); assert.equal(rows[0].coverage, 'COMPLETE');
  p.spec.points.push({ ...p.spec.points[0], id: 'debounce' });
  p.spec.gaps.push({ pointId: 'debounce', rowRefs: p.spec.points[1].rowRefs, reason: '防连点未验证' });
  const partial = aggregateRows(p, phases, 'COMPARE');
  assert.equal(partial[0].coverage, 'PARTIAL'); assert.equal(partial[0].comparable, false);
  phases.before.C1.observations.A1 = 'PASS'; phases.after.C1.observations.A1 = 'PASS';
  assert.equal(aggregateRows(p, phases, 'COMPARE')[0].after.functional, 'UNVERIFIED');
});
test('视觉未验证不变成功，非视觉无需图片，未选行不进入实测分母', () => {
  const p = fixture(); p.cases.cases[0].assertions[0].kind = 'visual';
  const r = aggregateRows(p, {}, 'COMPARE');
  assert.equal(r[0].before.visual, 'UNVERIFIED'); assert.equal(r[0].before.functional, 'NOT_REQUIRED');
  p.sources[0].rows[1].selected = false;
  assert.equal(aggregateRows(p, {}, 'COMPARE').length, 1);
});
test('异常回执中的残留PASS不能进入任何断言或视觉通过统计', () => {
  const p = fixture(); p.cases.cases[0].assertions.push({ ...p.cases.cases[0].assertions[0], id: 'V', kind: 'visual' });
  const phase = { C1: { valid: false, observations: { A1: 'PASS' }, visuals: { V: { status: 'PASS' } }, captures: [] } };
  const row = aggregateRows(p, { before: phase, after: phase }, 'COMPARE')[0];
  assert.equal(row.after.functional, 'UNVERIFIED'); assert.equal(row.after.visual, 'UNVERIFIED');
  assert.equal(row.after.assertions.every(a => a.status === 'UNVERIFIED'), true);
});
test('多采集点必须全部取得，不能以一个采集点充当完整覆盖', () => {
  const p = fixture(), c = p.cases.cases[0]; c.assertions[0].kind = 'visual';
  c.capturePoints = [{ id: 'P1', assertionIds: ['A1'] }, { id: 'P2', assertionIds: ['A1'] }];
  const phase = { C1: { valid: true, dataVerified: true, observations: {}, visuals: {}, captures: [{ captureId: 'P1' }] } };
  const row = aggregateRows(p, { before: phase, after: phase }, 'COMPARE')[0];
  assert.equal(row.coverage, 'PARTIAL'); assert.equal(row.comparable, false);
});
test('单阶段视觉通过但前后差异未判定时，不计已完成对比', () => {
  const p = fixture(), c = p.cases.cases[0]; c.assertions[0].kind = 'visual';
  c.capturePoints = [{ id: 'P1', assertionIds: ['A1'] }];
  const phase = { C1: { valid: true, dataVerified: true, observations: {}, visuals: { A1: {status:'PASS',difference:'UNVERIFIED'} }, captures: [{captureId:'P1'}] } };
  const row = aggregateRows(p, {before:phase,after:phase},'COMPARE')[0];
  assert.equal(row.comparable,true); assert.equal(row.compared,false); assert.equal(row.visualDifference,'UNVERIFIED');
});
test('CSV按顺序输出评估与处理结论并保留可选截图', () => {
  const s = fixture().sources[0], bytes = Buffer.from(s.csvBase64, 'base64');
  const decisions = s.rows.map(r => ({ rowId: r.rowId, 处理结论: '无需适配', 处理说明: '正常功能', 后续事项: '' }));
  const plain = parseCsv(formatUpgradeResults(bytes, decisions));
  assert.deepEqual(plain.headers.slice(-4), ['评估结论', '处理结论', '处理说明', '后续事项']);
  assert.equal(plain.rows[0]['评估结论'], '待分类');
  const shots = { [s.rows[0].rowId]: 'before/C1/P1: evidence/before.png\nafter/C1/P1: evidence/after.png' };
  const csv = parseCsv(formatUpgradeResults(bytes, decisions, { screenshots: shots }));
  assert.equal(csv.headers.at(-1), '测试截图'); assert.equal(csv.rows[0]['测试截图'], shots[s.rows[0].rowId]);
  assert.equal(csv.rows[1]['测试截图'], '');
  assert.throws(() => formatUpgradeResults(bytes, decisions, { screenshots: { 'unknown:1': 'fake.png' } }), /未知/);
});

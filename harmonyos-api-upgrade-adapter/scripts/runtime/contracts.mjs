import { readScanInput } from '../shared/format/scan-input.mjs';
import { sha256 } from '../shared/io/fs-utils.mjs';

export const rowKey = ref => JSON.stringify([ref.sourceId, ref.rowId]);
export const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export const textValue = value => typeof value === 'string' && value.trim().length > 0;
export function caseTimeoutMs(testCase) {
  const value = testCase.timeoutMs === undefined ? 120_000 : testCase.timeoutMs;
  requireValue(Number.isInteger(value) && value >= 1 && value <= 600_000, `${testCase.id} timeoutMs必须为1到600000的整数`);
  return value;
}
export function identifier(value) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value), `非法标识: ${value}`);
  requireValue(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value), `Windows保留设备名不能作为标识: ${value}`);
  return value;
}
function unique(items, label) {
  requireValue(Array.isArray(items), `${label} 必须为数组`);
  const result = new Map(), physicalNames = new Set();
  for (const item of items) {
    identifier(item.id); requireValue(!physicalNames.has(item.id.toLowerCase()), `${label} 重复/大小写冲突: ${item.id}`);
    physicalNames.add(item.id.toLowerCase()); result.set(item.id, item);
  }
  return result;
}
export function createSource(bytes, sourceId, selection, {encoding} = {}) {
  identifier(sourceId);
  requireValue(Buffer.isBuffer(bytes), '扫描输入必须为原始Buffer');
  requireValue(selection === 'all' || Array.isArray(selection), '必须明确测试选择: all 或 rowId数组');
  requireValue(encoding === undefined || ['utf-8','gb18030'].includes(encoding), 'runtime 来源必须使用确定的 utf-8/gb18030 编码');
  const csv = readScanInput(bytes, {encoding});
  requireValue(csv.headers.includes('Code Location') && new Set(csv.headers).size === csv.headers.length, '扫描表缺少Code Location或表头重复');
  const digest = sha256(bytes), selected = new Set(selection === 'all' ? [] : selection);
  requireValue(selection === 'all' || selected.size === selection.length, '测试选择中有重复行');
  const rows = csv.rows.map((cells, i) => ({ rowId: `${digest}:${i + 1}`, logicalRow: i + 1,
    codeLocation: cells['Code Location'], ruleId: cells['Rule ID'] ?? '', cells,
    selected: selection === 'all' || selected.has(`${digest}:${i + 1}`) }));
  for (const id of selected) requireValue(rows.some(r => r.rowId === id), `测试选择含未知行: ${id}`);
  return { sourceId, sha256: digest, csvBase64: bytes.toString('base64'), rows, ...(encoding===undefined?{}:{encoding:csv.encoding}) };
}
export function assertSourceMatches(source, raw) {
  requireValue(source.sha256 === raw.sha256 && (source.encoding ?? 'utf-8') === raw.encoding
    && JSON.stringify(source.rows.map(row=>row.cells)) === JSON.stringify(raw.rows), 'runtime 来源与任务原扫描字节或解码解释不一致');
}
export function validatePlan(plan) {
  requireValue(plan.schemaVersion === 1, '不支持的测试计划版本');
  requireValue(Array.isArray(plan.sources) && plan.sources.length > 0, '缺少CSV来源');
  const sourceIds = new Set(), selected = new Map();
  for (const s of plan.sources) {
    identifier(s.sourceId); requireValue(!sourceIds.has(s.sourceId), 'sourceId重复'); sourceIds.add(s.sourceId);
    const rebuilt = createSource(Buffer.from(s.csvBase64, 'base64'), s.sourceId, s.rows.filter(r => r.selected).map(r => r.rowId), {encoding:s.encoding});
    requireValue(JSON.stringify(rebuilt) === JSON.stringify(s), `来源被修改: ${s.sourceId}`);
    for (const row of s.rows.filter(r => r.selected)) selected.set(rowKey({ sourceId: s.sourceId, rowId: row.rowId }), row);
  }
  function refs(items, label, allowed = selected) {
    requireValue(Array.isArray(items) && items.length > 0, `${label} 缺少逐行来源`);
    const keys = items.map(rowKey);
    requireValue(new Set(keys).size === keys.length && keys.every(k => allowed.has(k)), `${label} 含重复/未知/未选行`);
    return new Map(keys.map(k => [k, true]));
  }
  for (const name of ['routeMap', 'spec', 'cases']) requireValue(plan[name]?.schemaVersion === 1, `${name}版本缺失`);
  const routes = unique(plan.routeMap.routes, '路由'), points = unique(plan.spec.points, '测试点');
  const cases = unique(plan.cases.cases, '用例');
  for (const r of routes.values()) {
    refs(r.rowRefs, r.id);
    requireValue(Array.isArray(r.sourceEvidence) && r.sourceEvidence.length > 0, `${r.id} 缺少白盒源码证据`);
    for (const e of r.sourceEvidence) requireValue(textValue(e.path) && Number.isInteger(e.startLine) && e.startLine > 0 &&
      Number.isInteger(e.endLine) && e.endLine >= e.startLine && textValue(e.text), `${r.id} 源码范围/内容缺失`);
    requireValue(Array.isArray(r.steps), `${r.id}缺少步骤`);
    requireValue(r.blockedReason ? textValue(r.blockedReason) && !r.steps.length : r.steps.length > 0 && r.steps[0].action === 'launch', `${r.id}必须从launch开始或明确不可执行`);
    for (const step of r.steps) requireValue(['launch', 'tap', 'input', 'swipe', 'back', 'wait'].includes(step.action), `${r.id} 未知导航动作`);
  }
  const required = new Map(), planned = new Set(), gapped = new Set();
  const classified = new Set();
  for (const classification of plan.spec.classifications ?? []) {
    refs(classification.rowRefs, '分类');
    requireValue(['无需适配', '可选适配', '必须适配', '待分类', '范围外'].includes(classification.category), '测试分类非法');
    for (const ref of classification.rowRefs) { const key = rowKey(ref); requireValue(!classified.has(key), '测试分类重复'); classified.add(key); }
  }
  for (const p of points.values()) {
    refs(p.rowRefs, p.id); const r = routes.get(p.routeId);
    requireValue(r, `${p.id} 缺少路由 ${p.routeId}`); refs(p.rowRefs, p.id, new Map(r.rowRefs.map(r => [rowKey(r), true])));
    requireValue([p.trigger, p.observable, p.expectationSource].every(textValue), `${p.id}缺少触发条件、观测或预期来源`);
    for (const ref of p.rowRefs) required.set(JSON.stringify([p.id, rowKey(ref)]), true);
  }
  for (const gap of plan.spec.gaps ?? []) {
    refs(gap.rowRefs, '缺口'); requireValue(textValue(gap.reason), '缺口原因为空');
    if (gap.pointId) {
      const point = points.get(gap.pointId); requireValue(point, '缺口指向未知测试点');
      refs(gap.rowRefs, gap.pointId, new Map(point.rowRefs.map(r => [rowKey(r), true])));
      for (const r of gap.rowRefs) gapped.add(JSON.stringify([gap.pointId, rowKey(r)]));
    }
  }
  for (const c of cases.values()) {
    requireValue(routes.has(c.routeId) && !routes.get(c.routeId).blockedReason, `${c.id} 路由不可执行`);
    const pre = c.preconditions;
    requireValue(pre && pre.startAnchor && Object.hasOwn(pre, 'state') && [pre.data, pre.reset].every(textValue), `${c.id}前置数据/复位缺失`);
    requireValue(Array.isArray(c.steps) && c.steps.length > 0, `${c.id}缺少操作`);
    for (const field of ['phaseLocators', 'phaseActions']) if (c[field]) {
      for (const [name, declaration] of Object.entries(c[field])) {
        identifier(name);
        requireValue(textValue(declaration.source) && Object.hasOwn(declaration, 'before') && Object.hasOwn(declaration, 'after'), `${c.id}/${name}阶段差异必须预先声明两阶段和来源`);
      }
    }
    const assertions = unique(c.assertions, c.id + '断言'), captures = unique(c.capturePoints, c.id + '采集点');
    requireValue(assertions.size > 0, `${c.id}缺少断言`);
    for (const a of assertions.values()) {
      const p = points.get(a.pointId); requireValue(p && p.routeId === c.routeId, `${c.id}/${a.id}测试点路由不一致`);
      refs(a.rowRefs, a.id, new Map(p.rowRefs.map(r => [rowKey(r), true])));
      requireValue(['functional', 'visual'].includes(a.kind) && Object.hasOwn(a, 'beforeExpected') && Object.hasOwn(a, 'afterExpected'), `${a.id}缺少阶段判据`);
      for (const r of a.rowRefs) planned.add(JSON.stringify([p.id, rowKey(r)]));
      if (a.kind === 'visual') requireValue([...captures.values()].some(cp => cp.assertionIds.includes(a.id)), `${a.id}缺少视觉采集点`);
    }
    for (const cp of captures.values()) requireValue(Array.isArray(cp.assertionIds) && cp.assertionIds.length && cp.assertionIds.every(a => assertions.has(a)), `${cp.id}证据引用错误`);
  }
  for (const key of required.keys()) requireValue(planned.has(key) || gapped.has(key), `必测分支缺少用例/具名缺口: ${key}`);
  for (const key of selected.keys()) requireValue([...points.values()].some(p => p.rowRefs.some(r => rowKey(r) === key)) ||
    (plan.spec.gaps ?? []).some(g => g.rowRefs.some(r => rowKey(r) === key)), `选中行无测试点/缺口: ${key}`);
  return { selectedRows: selected.size, points: points.size, cases: cases.size };
}

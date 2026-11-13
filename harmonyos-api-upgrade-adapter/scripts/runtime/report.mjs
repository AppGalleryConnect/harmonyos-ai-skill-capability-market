import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runProcess } from '../shared/platform/process.mjs';
import { atomicWrite } from '../shared/io/fs-utils.mjs';
import { rowKey, requireValue } from './contracts.mjs';
import { fingerprint, inside, readJson } from './io.mjs';
import { caseFile, toolWorkingDirectory, verifyRun, workerArgs } from './runs.mjs';
import { packageIdentity, checkInstalled } from './package-identity.mjs';
import { renderTestReport } from './report-html.mjs';

const status = values => !values.length ? 'NOT_REQUIRED' : values.includes('FAIL') ? 'FAIL' : values.every(v => v === 'PASS') ? 'PASS' : 'UNVERIFIED';
export function aggregateRows(plan, phases, mode) {
  const phaseNames = mode === 'COMPARE' ? ['before', 'after'] : ['after'];
  return plan.sources.flatMap(s => s.rows.filter(r => r.selected).map(row => {
    const key = rowKey({ sourceId: s.sourceId, rowId: row.rowId });
    const points = plan.spec.points.filter(p => p.rowRefs.some(r => rowKey(r) === key));
    const gaps = (plan.spec.gaps ?? []).filter(g => g.rowRefs.some(r => rowKey(r) === key));
    const bindings = plan.cases.cases.flatMap(c => c.assertions.filter(a => a.rowRefs.some(r => rowKey(r) === key)).map(a => ({ c, a })));
    const result = { sourceId: s.sourceId, rowId: row.rowId, logicalRow: row.logicalRow, codeLocation: row.codeLocation,
      category: (plan.spec.classifications ?? []).find(c => c.rowRefs.some(r => rowKey(r) === key))?.category ?? '未提供分类',
      ruleId: row.ruleId, pointIds: points.map(p => p.id), gaps: gaps.map(g => g.reason), cases: [...new Set(bindings.map(b => b.c.id))] };
    let complete = points.length > 0 && gaps.length === 0;
    for (const phase of phaseNames) {
      const relevant = bindings.map(({ c, a }) => ({ ...a, caseId: c.id, record: phases[phase]?.[c.id] }));
      const covered = points.every(p => relevant.some(a => a.pointId === p.id && a.record?.valid)) && relevant.every(a =>
        a.record?.valid && (a.kind !== 'functional' || ['PASS', 'FAIL'].includes(a.record.observations[a.id])) &&
          plan.cases.cases.find(c => c.id === a.caseId).capturePoints.filter(cp => cp.assertionIds.includes(a.id))
            .every(cp => a.record.captures.some(actual => actual.captureId === cp.id)));
      complete &&= covered;
      result[phase] = { functional: status(relevant.filter(a => a.kind === 'functional').map(a => a.record?.valid ? a.record.observations[a.id] ?? 'UNVERIFIED' : 'UNVERIFIED')),
        visual: status(relevant.filter(a => a.kind === 'visual').map(a => a.record?.valid ? a.record.visuals[a.id]?.status ?? 'UNVERIFIED' : 'UNVERIFIED')),
        assertions: relevant.map(a => ({ caseId: a.caseId, assertionId: a.id, kind: a.kind,
          expected: phase === 'before' ? a.beforeExpected : a.afterExpected,
          actual: a.record?.valid ? a.kind === 'visual' ? a.record.visuals[a.id]?.reason : a.record.actuals?.[a.id] : undefined,
          status: !a.record?.valid ? 'UNVERIFIED' : a.kind === 'functional' ? a.record.observations[a.id] ?? 'UNVERIFIED' : a.record.visuals[a.id]?.status ?? 'UNVERIFIED',
          reason: a.kind === 'visual' ? a.record?.visuals[a.id]?.reason ?? '未取得有效视觉判定' : a.record?.reason ?? '未取得有效执行证据' })),
        screenshots: relevant.flatMap(a => (a.record?.valid ? a.record.captures : []).filter(cp => cCapture(plan, a.caseId, cp.captureId)?.assertionIds.includes(a.id))
          .map(cp => ({ caseId: a.caseId, ...cp }))) };
      if (gaps.length || !points.every(p => relevant.some(a => a.pointId === p.id))) {
        for (const dimension of ['functional', 'visual']) if (result[phase][dimension] === 'PASS') result[phase][dimension] = 'UNVERIFIED';
        if (!relevant.length) result[phase].functional = result[phase].visual = 'UNVERIFIED';
      }
    }
    result.coverage = complete ? 'COMPLETE' : bindings.some(b => phaseNames.some(p => phases[p]?.[b.c.id]?.valid)) ? 'PARTIAL' : 'NOT_RUN';
    result.comparable = mode === 'COMPARE' && complete && bindings.every(b => phaseNames.every(p => phases[p]?.[b.c.id]?.dataVerified));
    const visualChecks = bindings.filter(b => b.a.kind === 'visual').map(b => phases.after?.[b.c.id]?.visuals[b.a.id]);
    result.compared = result.comparable && phaseNames.every(p => !['functional', 'visual'].some(d => result[p][d] === 'UNVERIFIED')) &&
      visualChecks.every(j => ['SAME', 'ALLOWED_CHANGE', 'REGRESSION'].includes(j?.difference));
    result.difference = !result.comparable ? 'UNVERIFIED' : result.before.functional === 'PASS' && result.after.functional === 'FAIL' ? 'REGRESSION' :
      result.before.functional === 'FAIL' && result.after.functional === 'FAIL' ? 'BOTH_FAIL' : 'SEE_ASSERTIONS';
    result.visualDifference = !result.compared ? 'UNVERIFIED' : visualChecks.some(j => j?.difference === 'REGRESSION') ? 'REGRESSION' :
      visualChecks.some(j => j?.difference === 'ALLOWED_CHANGE') ? 'ALLOWED_CHANGE' : visualChecks.every(j => j?.difference === 'SAME') ? 'SAME' : 'SEE_ASSERTIONS';
    return result;
  }));
}
const cCapture = (plan, caseId, captureId) => plan.cases.cases.find(c => c.id === caseId)?.capturePoints.find(cp => cp.id === captureId);

export async function auditRun(root, { invoke = runProcess } = {}) {
  const { manifest: m, plan } = await verifyRun(root), phases = {}, problems = [];
  const python = process.env.RUNTIME_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const execution = await readJson(await inside(root, 'execution.json')).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  problems.push(...(m.packageIssues ?? []));
  if (execution?.status === 'BLOCKED') problems.push('执行阻断: ' + execution.reason);
  if (execution) {
    requireValue(execution.runId === m.runId && execution.mode === m.mode, '执行记录不属于本轮');
    const starts = execution.events.filter(e => e.type === 'phase-start').map(e => e.phase);
    requireValue(JSON.stringify(starts) === JSON.stringify((m.mode === 'COMPARE' ? ['before', 'after'] : ['after']).slice(0, starts.length)), '阶段执行顺序错误');
    if (starts.includes('after') && m.mode === 'COMPARE') {
      const beforeEnd = execution.events.findIndex(e => e.type === 'phase-end' && e.phase === 'before');
      const reset = execution.events.findIndex(e => e.type === 'reset');
      const afterStart = execution.events.findIndex(e => e.type === 'phase-start' && e.phase === 'after');
      requireValue(beforeEnd >= 0 && reset > beforeEnd && afterStart > reset, '未完成before或未记录复位即开始after');
    }
  }
  let judgments = null;
  try {
    judgments = await readJson(path.join(root, 'judgments.json'));
    requireValue(judgments.runId === m.runId && judgments.planSha256 === m.hashes['inputs/plan.json'] && Array.isArray(judgments.checks), '视觉判定来源已过期');
  } catch (error) { if (error.code !== 'ENOENT') problems.push('视觉未验证: ' + error.message); judgments = null; }
  const phaseNames = m.mode === 'COMPARE' ? ['before', 'after'] : ['after'];
  for (const phase of phaseNames) {
    phases[phase] = {};
    for (const c of plan.cases.cases) {
      const record = phases[phase][c.id] = { valid: false, dataVerified: false, observations: {}, actuals: {}, captures: [], visuals: {} };
      try {
        const entry = execution?.phases[phase]?.cases[c.id]; requireValue(entry, '本阶段未执行该例');
        const dir = await inside(root, entry.directory), r = await readJson(await inside(dir, 'result.json'));
        const frozen = m.hashes[caseFile(c.id, m.caseFormat)];
        requireValue(entry.status === 'EXECUTED' && r.status === 'EXECUTED' && r.runId === m.runId && r.phase === phase && r.caseId === c.id &&
          typeof frozen === 'string' && r.scriptSha256 === frozen, '缺少本轮有效执行回执');
        const installed = execution.events.find(e => e.type === 'installed' && e.phase === phase);
        requireValue(installed && r.startedAt * 1000 >= installed.time && r.finishedAt >= r.startedAt, '执行早于实际安装或缺少时间');
        const pkg = m.packages[phase];
        const identities = await Promise.all(pkg.artifacts.map(async a => packageIdentity(await inside(root, a.path), pkg.module)));
        const primary = identities.filter(i => i.primary); requireValue(primary.length === 1, '归档主模块身份不唯一');
        checkInstalled(installed.packageInfo, primary[0]);
        requireValue(r.dataState && isDeepStrictEqual(r.dataState.actual, c.preconditions.state) && isDeepStrictEqual(r.dataState.expected, c.preconditions.state), '前置数据复位没有实际验证');
        record.dataVerified = true;
        for (const obs of r.observations) {
          const a = c.assertions.find(a => a.id === obs.assertionId && a.kind === 'functional');
          requireValue(a && !Object.hasOwn(record.observations, a.id), '未知或重复功能断言');
          const expected = phase === 'before' ? a.beforeExpected : a.afterExpected;
          requireValue(isDeepStrictEqual(obs.expected, expected), '执行使用了不同预期');
          const observed = isDeepStrictEqual(obs.actual, expected) ? 'PASS' : 'FAIL';
          requireValue(obs.status === observed, '功能状态与实际值矛盾');
          record.observations[a.id] = observed; record.actuals[a.id] = obs.actual;
        }
        record.valid = true; record.reason = r.reason ?? '';
        const seen = new Set();
        for (const cp of r.captures) {
          try {
          requireValue(cCapture(plan, c.id, cp.captureId) && !seen.has(cp.captureId) && cp.runId === m.runId && cp.phase === phase &&
            cp.caseId === c.id && cp.attempt === r.attempt && cp.time >= r.startedAt && cp.time <= r.finishedAt, '采集点身份/时间错误'); seen.add(cp.captureId);
          const image = await inside(dir, cp.screenshot), tree = await inside(dir, cp.layoutTree);
          requireValue(await fingerprint(image) === cp.screenshotSha256 && await fingerprint(tree) === cp.layoutSha256, '证据哈希漂移');
          const layout = await readJson(tree); requireValue(layout && !Array.isArray(layout) && typeof layout === 'object', '布局树无效');
          const check = await invoke(python, workerArgs('image', image), { cwd: toolWorkingDirectory, timeoutMs: 30_000 });
          requireValue(check.exitCode === 0 && !check.timedOut && !check.error && !check.signal, '图片不能完整解码');
          record.captures.push({ ...cp, screenshot: path.relative(root, image), layoutTree: path.relative(root, tree) });
          } catch (error) { problems.push(`${phase}/${c.id}/${cp.captureId}: ${error.message}`); }
        }
        for (const a of c.assertions.filter(a => a.kind === 'visual')) {
          try {
          const checks = judgments?.checks.filter(j => j.phase === phase && j.caseId === c.id && j.assertionId === a.id) ?? [];
          if (checks.length !== 1) continue;
          const j = checks[0];
          requireValue(['PASS', 'FAIL', 'UNVERIFIED'].includes(j.status) && typeof j.reason === 'string' && j.reason.trim(), '视觉结论/理由缺失');
          requireValue(['SAME', 'ALLOWED_CHANGE', 'REGRESSION', 'UNVERIFIED'].includes(j.difference), '视觉差异结论缺失');
          if (j.difference === 'ALLOWED_CHANGE') requireValue(Array.isArray(a.allowedDifferences) && a.allowedDifferences.length > 0, '没有获批差异声明');
          const expected = c.capturePoints.filter(cp => cp.assertionIds.includes(a.id)).map(cp => cp.id);
          requireValue(Array.isArray(j.evidence) && expected.every(id => j.evidence.some(e => e.captureId === id)) &&
            j.evidence.every(e => record.captures.some(cp => cp.captureId === e.captureId && cp.screenshotSha256 === e.screenshotSha256 && cp.layoutSha256 === e.layoutSha256)), '视觉证据引用缺失/过期');
          record.visuals[a.id] = j;
          } catch (error) { problems.push(`${phase}/${c.id}/${a.id}视觉未验证: ${error.message}`); }
        }
      } catch (error) { record.valid = false; record.captures = []; record.reason = error.message; problems.push(`${phase}/${c.id}: ${error.message}`); }
    }
  }
  const rows = aggregateRows(plan, phases, m.mode);
  const summary = { schemaVersion: 1, runId: m.runId, mode: m.mode, device: m.device, packages: m.packages, executionStatus: execution?.status ?? 'NOT_RUN',
    sources: plan.sources.map(s => ({ sourceId: s.sourceId, sha256: s.sha256, totalRows: s.rows.length, selectedRows: s.rows.filter(r => r.selected).length })),
    counts: { selected: rows.length, complete: rows.filter(r => r.coverage === 'COMPLETE').length, comparable: rows.filter(r => r.comparable).length,
      compared: rows.filter(r => r.compared).length,
      afterPassed: rows.filter(r => r.after.functional === 'PASS').length, afterFailed: rows.filter(r => r.after.functional === 'FAIL').length,
      visuallyVerified: rows.filter(r => ['PASS', 'FAIL'].includes(r.after.visual)).length }, rows, phases, problems };
  await atomicWrite(await inside(root, 'audit.json'), JSON.stringify(summary, null, 2) + '\n'); return summary;
}

export async function writeReport(root, deliveryDirectory, options = {}) {
  const summary = await auditRun(root, options), screenshots = Object.create(null);
  for (const row of summary.rows) {
    screenshots[row.sourceId] ??= {};
    screenshots[row.sourceId][row.rowId] = [...new Set(['before', 'after'].flatMap(phase => (row[phase]?.screenshots ?? []).map(cp =>
      `${phase}/${cp.caseId}/${cp.captureId}: ${path.relative(deliveryDirectory, path.join(root, cp.screenshot))}`)))].join('\n');
  }
  await atomicWrite(await inside(root, 'screenshots-by-source.json'), JSON.stringify(screenshots, null, 2) + '\n');
  await atomicWrite(await inside(root, 'test-report.html'), await renderTestReport(root, summary));
  return summary;
}

import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readTask } from './task-context.mjs';
import { requireScanMode } from './scan-mode.mjs';
import { samePath, relativePathInside } from './paths.mjs';
import { ensureBatchDirectory } from './artifact-layout.mjs';
import { inspectScan } from './scan-inspection.mjs';
import { readSpecSource } from './spec-source.mjs';
import { readRuleGapReviews } from './rule-gap-reviews.mjs';
import { readRnohReviews } from './rnoh-reviews.mjs';
import { readScanInput } from '../format/scan-input.mjs';
import { atomicWrite, sha256 } from '../io/fs-utils.mjs';
import { assessmentCategories, resultOutcomes, assessmentFields, equalData, readAssessmentSource, checkResolution, assessmentError, activeDecision } from './assessment-source.mjs';

export { assessmentCategories, resultOutcomes };
const unresolved = new Set(['PENDING', 'DECISION_REQUIRED', 'EVIDENCE_GAP', 'OUT_OF_SCOPE']);
const display = outcome => outcome === 'NOT_IMPLEMENTED' ? '未实施' : outcome === 'MODIFIED' ? '已适配' : ['NO_CHANGE','OUT_OF_SCOPE'].includes(outcome) ? '无需适配' : '待决策';
export const unresolvedOutcome = (outcome, mode) => unresolved.has(outcome) && !(mode==='upgrade' && outcome==='OUT_OF_SCOPE');

function pendingFields(row, mode, reviews = new Set()) {
  return [unresolvedOutcome(row.outcome, mode) ? 'outcome' : null, row.next.trim() ? 'next' : null,
    reviews.has(row.rowId) ? 'review' : null,
    row.decisionOutdated ? 'decision' : null,
    mode === 'upgrade' && row.category === '待分类' ? 'category' : null].filter(Boolean);
}

export async function optionalJson(file) {
  try {
    const bytes = await readFile(file);
    const value = JSON.parse(bytes.toString('utf8').replace(/^\ufeff/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('根节点必须为 JSON 对象');
    return { value, hash: sha256(bytes), file };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { value: null, hash: null, file };
    throw new Error(`${file}：${error.message}`, { cause: error });
  }
}

export async function checkSnapshot(snapshot) {
  let hash = null;
  try { hash = sha256(await readFile(snapshot.file)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hash !== snapshot.hash) throw new Error(`进度或来源文件已变化，未覆盖：${snapshot.file}`);
}

export async function updateProgress(snapshot, value) {
  await checkSnapshot(snapshot);
  const data = JSON.stringify(value, null, 2) + '\n';
  if (snapshot.hash === null) await writeFile(snapshot.file, data, { flag: 'wx' });
  else await atomicWrite(snapshot.file, data);
}

function invalid(participant, file, rowId, field, actual, expected) {
  const error = new Error(`工程 ${participant.projectKey}；${file}；rowId=${rowId ?? '—'}；${field}=${JSON.stringify(actual)}；期望 ${expected}`);
  error.code = 'GROUP_RESULTS_INVALID';
  throw error;
}

export async function taskProject({ taskFile, projectPath, mode }) {
  requireScanMode(mode);
  const task = await readTask(path.resolve(taskFile)), physical = await realpath(path.resolve(projectPath));
  const candidates = task.participants.filter(p => p.mode === mode && samePath(p.physicalRoot, physical));
  if (candidates.length !== 1) throw new Error('工程未在任务中唯一登记');
  if (!candidates[0].outputLayout?.rawCsv) throw new Error('工程尚无初始原始扫描');
  return { task, participant: candidates[0] };
}

export async function readProjectScan(participant, mode) {
  const layout = participant.outputLayout, bytes = await readFile(layout.rawCsv);
  const attempt = participant.attempts.find(a => a.batchId === participant.initialBatchId);
  if (attempt?.source?.csv && !['utf-8','gb18030'].includes(attempt.source.csv.encoding)) throw new Error('导入来源没有确定的 CSV 编码');
  const raw = readScanInput(bytes, { encoding: attempt?.source?.csv?.encoding ?? 'utf-8' });
  if (attempt?.source?.csv?.interpretationSha256 && attempt.source.csv.interpretationSha256 !== raw.interpretationSha256)
    throw new Error('原始扫描表的解码解释已变化');
  if (attempt?.sha256 && attempt.sha256 !== raw.sha256) throw new Error(`工程 ${participant.projectKey} 原始扫描哈希不匹配`);
  let scan = await optionalJson(layout.scanJson), inspected = null;
  if (attempt?.scanJsonSha256 && scan.hash!==attempt.scanJsonSha256) throw new Error('初始扫描JSON来源已变化或缺失');
  if (!scan.value) {
    const candidates = [];
    for (const evidence of attempt?.source?.files ?? []) {
      if (path.extname(evidence.path).toLowerCase() !== '.json') continue;
      let content;
      const imported = await readFile(evidence.path);
      try { content = JSON.parse(imported.toString('utf8').replace(/^\ufeff/, '')); } catch { continue; }
      if (content?.mode !== mode || !Array.isArray(content.findings)) continue;
      if (sha256(imported) !== evidence.sha256) throw new Error(`导入扫描证据哈希不匹配：${evidence.path}`);
      try {
        const view = await inspectScan(bytes, { mode, projectPath: participant.projectRoot, scanJson: content, encoding: raw.encoding });
        candidates.push({ value: content, file: evidence.path, hash: evidence.sha256, view });
      } catch (error) { throw new Error(`导入扫描 JSON 与原表不匹配：${evidence.path}：${error.message}`); }
    }
    if (candidates.length > 1) throw new Error('存在多个可匹配的导入扫描 JSON，无法唯一确认来源');
    if (candidates.length === 1) { scan = candidates[0]; inspected = scan.view; }
  }
  inspected ??= await inspectScan(bytes, { mode, projectPath: participant.projectRoot, scanJson: scan.value, encoding: raw.encoding });
  return { bytes, raw, inspected, scanMetadata: scan.value, scanMetadataFile: scan.hash ? scan.file : null,
    snapshots: [{ file: layout.rawCsv, hash: raw.sha256 }, ...(scan.hash ? [{ file: scan.file, hash: scan.hash }] : [])] };
}

async function groupFile(layout, record) {
  const file = path.resolve(layout.deliveryDirectory, record);
  if (relativePathInside(layout.deliveryDirectory, file) === null) throw new Error(`分组路径越界：${record}`);
  try {
    if (relativePathInside(await realpath(layout.deliveryDirectory), await realpath(file)) === null)
      throw new Error(`分组物理路径越界：${record}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}

export function classificationMap(items, known, participant, file) {
  const map = new Map();
  if (!Array.isArray(items)) invalid(participant, file, null, 'rowClassifications', items, '分类数组');
  for (const item of items) {
    if (!item || typeof item !== 'object') invalid(participant, file, null, '分类条目', item, '包含 category/rowIds 的对象');
    if (!assessmentCategories.includes(item.category) || !Array.isArray(item.rowIds))
      invalid(participant, file, item.rowIds?.[0], '分类 category', item.category, assessmentCategories.join('/'));
    for (const id of item.rowIds) {
      if (!known.has(id)) invalid(participant, file, id, '分类含未知身份', id, '当前分组的已知 rowId');
      if (map.has(id)) invalid(participant, file, id, '分类重复', item.category, '每行至多一次分类');
      map.set(id, item.category);
    }
  }
  return map;
}

export async function readGroupResults(participant, mode, { strict = false, scan = null, allowPendingSpec = false } = {}) {
  scan ??= await readProjectScan(participant, mode);
  const layout = participant.outputLayout, progress = await optionalJson(layout.progressPath);
  if (progress.value?.source?.csv && (progress.value.source.csv.encoding !== scan.raw.encoding
    || progress.value.source.csv.interpretationSha256 !== scan.raw.interpretationSha256)) throw new Error('任务原始扫描解码解释与准备分组时不一致');
  const known = new Set(scan.raw.rowIds), canonical = new Map(), classifications = new Map(), gaps = [];
  const snapshots = [...scan.snapshots, progress], records = [];
  const specCache=new Map();
  const specSource = mode==='upgrade' ? await readSpecSource(layout,progress.value?.decisions?.repair,{allowPendingPublication:allowPendingSpec}) : null;
  if (specSource) snapshots.push(...specSource.snapshots);
  if (!progress.value) gaps.push(`进度文件缺失：${layout.progressPath}`);
  const references = progress.value?.groups ?? [];
  if (!Array.isArray(references)) invalid(participant, layout.progressPath, null, 'groups', references, '分组引用数组');
  for (const ref of references) {
    if (!ref || typeof ref.record !== 'string' || !ref.record) invalid(participant, layout.progressPath, null, '分组 record', ref?.record, '分组文件路径');
    const file = await groupFile(layout, ref.record), snapshot = await optionalJson(file);
    records.push({ file, reference: ref, value: snapshot.value }); snapshots.push(snapshot);
    if (!snapshot.value) {
      if (strict) invalid(participant, file, null, '分组文件缺失', null, '已登记且可读取的分组 JSON');
      gaps.push(`证据缺失：${file}`); continue;
    }
    const group = snapshot.value;
    if (group.changeSummary?.business !== undefined && typeof group.changeSummary.business !== 'string')
      invalid(participant, file, null, 'changeSummary.business', group.changeSummary.business, '字符串');
    if (mode==='upgrade' && group.reviewRowIds?.length) gaps.push(`重新评估后仍有${group.reviewRowIds.length}行处理/批准待复核：${file}`);
    if (group.sourceSha256 && group.sourceSha256 !== scan.raw.sha256)
      invalid(participant, file, null, 'sourceSha256', group.sourceSha256, scan.raw.sha256);
    const declared = new Set((group.files ?? []).flatMap(item => item.rowIds ?? []));
    for (const id of declared) if (!known.has(id)) invalid(participant, file, id, '文件关联身份', id, '本批原始行');
    const direct = scan.inspected.groups.find(g => g.identity && (group.identity === g.identity
      || group.identity?.ruleOrSymbol === (g.ruleId ?? g.sourceReference) && group.identity?.version === g.version));
    const owner = direct ? new Set(direct.rowIds) : declared.size ? declared : known;
    let assessment = null;
    if (mode === 'upgrade' && group.assessmentSource) {
      assessment = await readAssessmentSource(layout,group,owner,scan.raw.sha256);
      snapshots.push(assessment.snapshot);
    } else if (mode === 'upgrade') {
      const approvals=progress.value?.decisions?.repair?.approvedItems;
      if ((Array.isArray(approvals) && approvals.some(item=>item?.assessmentSha256 && item.groupId===(group.id ?? ref.id)))
        || (Array.isArray(group.rowResults) && group.rowResults.some(row=>row?.resolution)))
        throw assessmentError(file,null,'评估来源','已有处理或批准记录，不能退回无来源旧记录');
      gaps.push(`评估来源未建立：${file}；旧数据未核对原始评估复制一致性`);
    }
    for (const id of declared) if (!owner.has(id)) invalid(participant, file, id, '文件所属分组', id, '当前分组关联的行');
    const identities = new Set(scan.inspected.rows.filter(r => declared.has(r.rowId) && r.identity).map(r => r.identity));
    if (Array.isArray(group.rowResults) && group.identity?.ruleOrSymbol && !direct && identities.size)
      invalid(participant, file, group.rowResults[0]?.rowId, '分组身份', group.identity, '当前扫描中的准确身份及版本');
    if (identities.size > 1) invalid(participant, file, [...declared][0], '分组身份', group.identity, '一个准确变更/符号及精确版本');
    const local = classificationMap(group.rowClassifications ?? [], owner, participant, file);
    if (group.rowResults !== undefined && !Array.isArray(group.rowResults)) invalid(participant, file, null, 'rowResults', group.rowResults, '逐行判断数组');
    for (const row of group.rowResults ?? []) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid(participant, file, null, '逐行条目', row, '包含 rowId 的判断对象');
      const id = row.rowId;
      if (!known.has(id) || !owner.has(id)) invalid(participant, file, id, '逐行身份或所属分组', id, '本批且属于当前分组的 rowId');
      if (canonical.has(id)) invalid(participant, file, id, '逐行判断重复', id, '每行恰有一条判断');
      if (!resultOutcomes.includes(row.outcome)) invalid(participant, file, id, 'outcome', row.outcome, resultOutcomes.join('/'));
      if (mode!=='upgrade' && row.outcome==='NOT_IMPLEMENTED') invalid(participant,file,id,'outcome',row.outcome,'废弃流程的既有六类状态');
      if (mode === 'upgrade' && !assessmentCategories.includes(row.category)) invalid(participant, file, id, '分类 category', row.category, assessmentCategories.join('/'));
      for (const field of ['reason', 'compatibility', 'next']) if (typeof row[field] !== 'string') invalid(participant, file, id, field, row[field], '字符串');
      for (const field of ['changes', 'evidence']) if (!Array.isArray(row[field]) || row[field].some(v => typeof v !== 'string')) invalid(participant, file, id, field, row[field], '字符串数组');
      if (row.impact !== undefined && typeof row.impact !== 'string') invalid(participant, file, id, 'impact', row.impact, '字符串');
      if (row.reportSummary !== undefined && typeof row.reportSummary !== 'string') invalid(participant, file, id, 'reportSummary', row.reportSummary, '字符串');
      if (row.outcome !== 'PENDING' && !row.reason.trim()) invalid(participant, file, id, 'reason', row.reason, '具体业务判断理由');
      if (row.outcome === 'MODIFIED' && !row.changes.some(v => v.trim())) invalid(participant, file, id, 'changes', row.changes, '实际修改说明');
      if (assessment) {
        const original = assessment.rows.get(id);
        for (const field of assessmentFields) if (!original || !equalData(row[field],original[field]))
          throw assessmentError(file,id,field,'与原始评估不一致，处理更新不得重写评估');
        const spec=await checkResolution(row,original,group,progress.value,file,specCache);
        if (spec && !snapshots.some(snapshot=>snapshot.file===spec.file)) snapshots.push(spec);
      }
      if (local.has(id) && mode === 'upgrade' && local.get(id) !== row.category) invalid(participant, file, id, '旧分类与逐行分类冲突', local.get(id), row.category);
      canonical.set(id, row);
      if (mode === 'upgrade') local.set(id, row.category);
    }
    for (const [id, category] of local) {
      if (classifications.has(id)) invalid(participant, file, id, '跨分组分类重复', category, '每行一个来源');
      classifications.set(id, category);
    }
  }
  for (const id of known) if (!canonical.has(id)) {
    if (strict) invalid(participant, layout.progressPath, id, '缺少逐行判断', null, '在所属分组填写 rowResults；不能从文件级状态推断');
    gaps.push(`分组逐行判断缺失：${id}`);
  }
  for (const row of canonical.values()) {
    const repair=progress.value?.decisions?.repair;
    const decision=[...(repair?.approvedItems ?? []),...(repair?.declinedItems ?? [])].find(item=>item.id===row.resolution?.approvalId);
    if (decision && !activeDecision(decision,repair)) {
      canonical.set(row.rowId,{...row,decisionOutdated:true});
      gaps.push(`方案变化后需核对当前决定：${row.rowId}`);
    }
  }
  const reviewRowIds = new Set(records.flatMap(record=>record.value?.reviewRowIds ?? []));
  const pendingCount = [...canonical.values()].filter(row => pendingFields(row, mode, reviewRowIds).length).length;
  const pendingCounts = {
    unresolvedCount: [...canonical.values()].filter(row=>unresolvedOutcome(row.outcome,mode) || row.category==='待分类' || row.decisionOutdated).length,
    nextCount: [...canonical.values()].filter(row=>row.next.trim()).length,
    reviewCount: reviewRowIds.size,
  };
  return { ...scan, participant, mode, progress, records, snapshots, specSource, canonical, classifications, gaps, pendingCount, pendingCounts, reviewRowIds };
}

export function projectedResults(state, { partial = false } = {}) {
  return state.raw.rowIds.filter(id => !partial || state.canonical.has(id)).map(id => {
    const row = state.canonical.get(id);
    if (!row) invalid(state.participant, state.participant.outputLayout.progressPath, id, '缺少逐行判断', null, '完整 rowResults');
    const reason = (row.reason.trim() || '尚未评估')
      + (row.previousResolution?.reason ? `\n重评前处理记录：${row.previousResolution.reason}` : '')
      + (row.resolution?.reason ? `\n处理决定：${row.resolution.reason}` : '')
      + (row.resolution?.review?.reason ? `\n复核记录：${row.resolution.review.reason}` : '')
      + (row.resolution?.verification?.reason ? `\n验证说明：${row.resolution.verification.reason}` : '')
      + (row.changes.length ? `\n实际修改：${row.changes.join('；')}` : '');
    return { rowId: id, ...(state.mode === 'upgrade' ? { 评估结论: row.category } : {}),
      处理结论: state.mode === 'upgrade' ? row.decisionOutdated ? '待决策' : display(row.outcome) : row.outcome,
      处理来源: 'MODEL_ASSESSED', 业务影响: row.impact ?? '', 处理说明: reason,
      兼容性说明: row.compatibility, 变更文件: row.changes.join('\n'),
      验证证据: [...row.evidence,...(row.resolution?.evidence ?? []),...(row.resolution?.verification?.evidence ?? []),...(row.resolution?.review?.evidence ?? [])].join('\n'),
      后续事项: row.decisionOutdated ? '方案变化后待确认当前决定' : row.next || (unresolvedOutcome(row.outcome,state.mode) ? '待完成本行判断或补齐证据' : state.reviewRowIds.has(id) ? '重新评估后待复核方案与处理依据' : '') };
  });
}

export async function validateProjectGroups(options, settings = {}) {
  return (await diagnoseProjectGroups(options, settings)).result;
}

export async function diagnoseProjectGroups(options, { details = false } = {}) {
  const { participant } = await taskProject(options);
  const {readTaskView}=await import('./task-view.mjs');
  const state = await readTaskView(participant, options.mode, { strict: true });
  const projected=new Map(state.projectedRows.map(row=>[row.rowId,row]));
  const fields=row=>[...pendingFields(state.canonical.get(row.rowId) ?? row,options.mode,state.reviewRowIds),state.verificationPendingIds.has(row.rowId) ? 'verification' : null].filter(Boolean);
  const pendingGroups = [], owners = new Map();
  for (const entry of state.records) {
    const id = entry.value.id ?? entry.reference.id ?? path.basename(entry.file, '.json');
    const rows = entry.value.rowResults ?? [];
    const count = rows.filter(row => fields(row).length).length;
    if (count) pendingGroups.push({ id, record: entry.reference.record, rowCount: rows.length, pendingCount: count });
    for (const row of rows) owners.set(row.rowId, { groupId: id, record: entry.reference.record });
  }
  const result = { validationScope: 'STRUCTURE_ONLY', projectKey: participant.projectKey, rowCount: state.raw.rows.length, pendingCount: state.pendingCount, ...state.pendingCounts,
    groupCount: state.records.length, gapCount: state.gaps.length + state.inspected.statistics.unresolvedRowCount, pendingGroups,
    ...(state.ruleGaps?.counts ?? {}), ...(state.rnohReviews?.counts ?? {}) };
  if (details) result.pendingRows = state.raw.rowIds.flatMap(rowId => {
    const row = state.canonical.get(rowId), pending = fields(row);
    return pending.length ? [{ rowId, ...owners.get(rowId), category: row.category ?? null, outcome: row.outcome,
      next: state.verificationPendingIds.has(rowId) ? projected.get(rowId)['后续事项'] : row.next, pendingFields: pending }] : [];
  });
  return { result, state };
}

export async function inspectProjectGroups(options, groupId = null) {
  const { participant } = await taskProject(options);
  const state = await readGroupResults(participant, options.mode);
  const groups = state.inspected.groups.map(group => {
    const id = `group-${sha256(JSON.stringify([state.raw.sha256, group.identity, group.rowIds])).slice(0, 12)}`;
    const record = state.records.find(item => item.reference.id === id || item.value?.id === id
      || group.identity !== null && (item.reference.identity === group.identity
        || item.value?.identity?.ruleOrSymbol === (group.ruleId ?? group.sourceReference) && item.value?.identity?.version === group.version));
    return { ...group, id: record?.value?.id ?? record?.reference.id ?? id };
  });
  const base = { projectKey: participant.projectKey, mode: options.mode, sourceSha256: state.raw.sha256,
    encoding: state.raw.encoding, bom: state.raw.bom, statistics: state.inspected.statistics };
  if (options.mode==='upgrade') {
    const ruleGaps=await readRuleGapReviews(state.scanMetadata,state.progress.value ?? {});
    if (ruleGaps.known) {
      Object.assign(base, ruleGaps.counts, {
        ruleGapBasis: ruleGaps.basis,
        ruleGapReviewDecision: ruleGaps.decision,
        ruleGapDecisionRequired: ruleGaps.decisionRequired,
        ruleGapReviews: ruleGaps.entries,
      });
      state.snapshots.push(...ruleGaps.snapshots);
    }
    Object.assign(base, readRnohReviews(state.scanMetadata, state.progress.value ?? {})?.counts ?? {});
  }
  let result;
  if (groupId === null) result = { ...base, groups: groups.map(group => ({ id: group.id, identity: group.identity,
    ruleId: group.ruleId, version: group.version, sourceReference: group.sourceReference, titles: group.titles,
    rowCount: group.rowCount, files: group.files.map(file => ({ path: file.path, rowCount: file.rowIds.length })) })) };
  else {
    const group = groups.find(group => group.id === groupId);
    if (!group) throw new Error(`任务中不存在该分组：${groupId}`);
    const ids = new Set(group.rowIds);
    const entry=state.records.find(entry=>(entry.value?.id ?? entry.reference.id ?? path.basename(entry.file,'.json'))===group.id);
    // 单组输入由评估 agent 整份读入：未覆盖条目明细留在概要里，整组相同或为空的行字段不逐行重复。
    const { ruleGapReviews: _ruleGapReviews, ...groupBase } = base;
    // RNOH 组的评估要引用扫描给出的框架依据和版本基线；随组输入给出，评估者不必再去翻整份扫描 JSON。
    const rnohSummary = String(group.ruleId ?? '').startsWith('RNOH-') ? state.scanMetadata?.rnoh : null;
    const rnohRule = rnohSummary?.rules?.find(rule => rule.ruleId === group.ruleId) ?? null;
    const rnoh = rnohSummary ? { native: rnohSummary.native ?? [], js: rnohSummary.js ?? null, jsRoot: rnohSummary.jsRoot ?? null,
      coverage: rnohSummary.coverage ?? null, gaps: rnohSummary.gaps ?? [],
      framework: rnohRule?.framework ?? null, ruleStatus: rnohRule?.status ?? null } : null;
    result = { ...groupBase, groupSha256:entry ? state.snapshots.find(snapshot=>snapshot.file===entry.file)?.hash ?? null : null,
      assessmentSha256:entry?.value?.assessmentSource?.sha256 ?? null,
      group: { id: group.id, identity: group.identity, ruleId: group.ruleId, version: group.version,
      sourceReference: group.sourceReference, titles: group.titles, rowCount: group.rowCount,
      files: group.files.map(file => ({ path: file.path, rowCount: file.rowIds.length })) },
      ...(rnoh ? { rnoh } : {}),
      rows: state.inspected.rows.filter(row => ids.has(row.rowId)).map(row => ({ rowId: row.rowId,
        codeLocation: row.cells['Code Location'], apiDefinition: row.cells['Api Definition'] ?? '', physicalFile: row.physicalFile,
        line: row.line, ...(row.column === null || row.column === undefined ? {} : { column: row.column }),
        ...(row.version === group.version ? {} : { version: row.version }),
        ...(row.sourceReference === group.sourceReference ? {} : { sourceReference: row.sourceReference }),
        ...(row.gaps?.length ? { gaps: row.gaps } : {}) })) };
  }
  return { result, state };
}

export async function prepareProjectGroups(options) {
  const { task, participant } = await taskProject(options), mode = options.mode, layout = participant.outputLayout;
  const scan = await readProjectScan(participant, mode), progress = await optionalJson(layout.progressPath);
  const value = progress.value ?? { mode, taskFile: task.taskFile, projectKey: participant.projectKey, project: participant.projectRoot,
    batchId: participant.initialBatchId, versions: {}, decisions: {}, delivery: { directory: layout.deliveryDirectory, adaptedCsv: layout.adaptedCsv },
    source: { copyPath: layout.rawCsv, sha256: scan.raw.sha256, inputRows: scan.raw.rows.length }, groups: [], next: '完成分组评估与逐行判断' };
  if (value.source?.sha256 && value.source.sha256 !== scan.raw.sha256) throw new Error('进度原始扫描身份与当前输入不一致');
  if (!Array.isArray(value.groups)) throw new Error('进度 groups 必须为数组');
  if (value.source?.csv && (value.source.csv.encoding !== scan.raw.encoding
    || value.source.csv.interpretationSha256 !== scan.raw.interpretationSha256)) throw new Error('不能改变已准备任务的 CSV 解码解释');
  value.source = { ...value.source, csv: { encoding: scan.raw.encoding, bom: scan.raw.bom, interpretationSha256: scan.raw.interpretationSha256 } };
  const existing = [];
  for (const ref of value.groups) {
    const file = await groupFile(layout, ref.record), record = await optionalJson(file);
    if (!record.value) throw new Error(`已登记分组缺失，不能创建替代记录：${file}`);
    existing.push(record.value);
  }
  const directory = path.join(layout.deliveryDirectory, 'groups');
  await ensureBatchDirectory(layout, directory);
  for (const group of scan.inspected.groups) {
    const ids = new Set(group.rowIds);
    if (existing.some(record => [...(Array.isArray(record.rowResults) ? record.rowResults : []).map(row => row.rowId), ...(record.files ?? []).flatMap(file => file.rowIds ?? [])].some(id => ids.has(id)))) continue;
    const id = `group-${sha256(JSON.stringify([scan.raw.sha256, group.identity, group.rowIds])).slice(0, 12)}`;
    const record = path.join('groups', `${id}.json`), file = await groupFile(layout, record);
    const body = { id, sourceSha256: scan.raw.sha256, identity: { ruleOrSymbol: group.ruleId ?? group.sourceReference,
      version: group.version, reference: group.sourceReference }, overview: group.titles.join(' / '),
      files: group.files.map(item => ({ path: item.path, rowIds: item.rowIds, locations: item.codeLocations, plan: '' })),
      rowResults: group.rowIds.map(rowId => ({ rowId, ...(mode === 'upgrade' ? { category: '待分类' } : {}),
        outcome: 'PENDING', reason: '', changes: [], compatibility: '', evidence: [], next: '' })) };
    try { await writeFile(file, JSON.stringify(body, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = (await optionalJson(file)).value;
      if (prior.sourceSha256 !== scan.raw.sha256 || JSON.stringify(prior.rowResults?.map(r => r.rowId)) !== JSON.stringify(group.rowIds))
        throw new Error(`已有分组与当前扫描冲突，未覆盖：${file}`);
    }
    value.groups.push({ id, identity: group.identity, record, status: 'PENDING' });
  }
  value.statistics = { ...(value.statistics ?? {}), ...scan.inspected.statistics };
  await updateProgress(progress, value);
  return { projectKey: participant.projectKey, progress: layout.progressPath, groups: value.groups, rowCount: scan.raw.rows.length };
}

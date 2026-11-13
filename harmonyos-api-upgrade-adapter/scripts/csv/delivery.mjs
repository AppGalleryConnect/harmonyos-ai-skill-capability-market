import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { taskProject, checkSnapshot } from '../shared/platform/group-results.mjs';
import { readScanInput } from '../shared/format/scan-input.mjs';
import { checkUpgradeResultColumns, displayUpgradeAssessment, matchesUpgradeResult } from '../shared/format/upgrade-results.mjs';
import { sha256 } from '../shared/io/fs-utils.mjs';
import { samePath } from '../shared/platform/paths.mjs';
import { readTaskView } from '../shared/platform/task-view.mjs';
import { activeDecision } from '../shared/platform/assessment-source.mjs';

function configurationHash(progress) {
  const versions = progress?.versions ?? {};
  return sha256(JSON.stringify([versions.oldTarget ?? null, versions.target ?? null, versions.compatible ?? null,
    progress?.configurationImplementation ?? null]));
}

const oldCompatibleHash = progress => sha256(JSON.stringify(progress?.versions?.oldCompatible ?? null));

export function deliveryInputs(state) {
  return { files:state.snapshots.filter(s=>s.file!==state.progress.file).map(({file,hash})=>({file,hash})),
    csvInterpretation:{encoding:state.raw.encoding,sha256:state.raw.interpretationSha256},
    ...(state.mode==='upgrade' ? {testSuggestionsSha256:sha256(JSON.stringify(state.progress.value?.testSuggestions ?? [])),
      configurationSha256:configurationHash(state.progress.value), oldCompatibleSha256:oldCompatibleHash(state.progress.value)} : {}),
    ...(state.ruleGaps?.known ? {ruleGapReviewsSha256:sha256(JSON.stringify([state.progress.value?.ruleGapBasis ?? null,state.progress.value?.ruleGapReviews ?? []]))} : {}),
    ...(state.rnohReviews ? {rnohReviewSha256:sha256(JSON.stringify(state.progress.value?.rnohReview ?? null))} : {}),
    decisionsSha256:sha256(JSON.stringify(state.progress.value?.decisions ?? {})) };
}
export async function verifyDelivery(options) {
  const {participant}=await taskProject(options), layout=participant.outputLayout;
  const state=await readTaskView(participant,options.mode,{strict:true});
  const target=path.resolve(options.adapted ?? state.progress.value?.delivery?.adaptedCsv ?? layout.adaptedCsv), bytes=await readFile(target), adapted=readScanInput(bytes);
  const {raw}=state, expected=state.projectedRows;
  const fields=checkUpgradeResultColumns(raw, adapted);
  for (const [index, row] of expected.entries()) {
    const mismatch = fields.find(field => !matchesUpgradeResult(field, adapted.rows[index][field], row[field]));
    if (mismatch) throw new Error(`结果表CSV与当前逐行判断不一致：${mismatch}，rowId=${row.rowId}`);
  }
  const published=state.progress.value?.delivery, report=path.resolve(options.report ?? published?.report ?? layout.taskReportPath);
  const reportBytes=await readFile(report);
  if (published?.reportSha256 && sha256(reportBytes)!==published.reportSha256) throw new Error('报告文件已变化，不能沿用旧发布结果');
  let reportSourceStatus='LEGACY_UNVERIFIED';
  if (published?.reportInputs) {
    const source=published.reportInputs;
    if (source.csvInterpretation && (source.csvInterpretation.encoding!==state.raw.encoding
      || source.csvInterpretation.sha256!==state.raw.interpretationSha256)) throw new Error('报告来源 CSV 解码解释已变化');
    const physicalTarget=await realpath(target);
    const sourceFiles=await Promise.all(source.files.map(async file=>({...file,physical:await realpath(file.file)})));
    if (!samePath(await realpath(report),await realpath(published.report)) || !sourceFiles.some(file=>samePath(file.physical,physicalTarget) && file.hash===sha256(bytes)))
      throw new Error('报告来源结果表路径或字节已变化');
    if (source.decisionsSha256!==sha256(JSON.stringify(state.progress.value?.decisions ?? {}))) throw new Error('报告来源批准记录已变化');
    if (source.testSuggestionsSha256 && source.testSuggestionsSha256!==sha256(JSON.stringify(state.progress.value?.testSuggestions ?? [])))
      throw new Error('报告来源测试建议已变化，请重新生成报告');
    if ((source.configurationSha256 && source.configurationSha256 !== configurationHash(state.progress.value))
      || (source.oldCompatibleSha256 && source.oldCompatibleSha256 !== oldCompatibleHash(state.progress.value)))
      throw new Error('报告来源配置记录已变化，请重新生成报告');
    if (source.ruleGapReviewsSha256 && source.ruleGapReviewsSha256!==sha256(JSON.stringify([state.progress.value?.ruleGapBasis ?? null,state.progress.value?.ruleGapReviews ?? []])))
      throw new Error('报告来源补充评估已变化，请重新生成报告');
    if (source.rnohReviewSha256 && source.rnohReviewSha256!==sha256(JSON.stringify(state.progress.value?.rnohReview ?? null)))
      throw new Error('报告来源 RNOH 补充核对已变化，请重新生成报告');
    for (const file of source.files) try { await checkSnapshot(file); } catch { throw new Error(`报告来源已变化或过期：${file.file}`); }
    // A replaced/new group reference must not escape a previous report's manifest.
    for (const file of state.snapshots.filter(s=>s.file!==state.progress.file)) {
      const physical=await realpath(file.file);
      if (!sourceFiles.some(old=>samePath(old.physical,physical) && old.hash===file.hash)) throw new Error(`报告来源已变化：${file.file}`);
    }
    reportSourceStatus='MATCH';
  }
  for (const snapshot of state.snapshots) await checkSnapshot(snapshot);
  await checkSnapshot({file:target,hash:sha256(bytes)}); await checkSnapshot({file:report,hash:sha256(reportBytes)});
  const categoryCounts = {}, outcomeCounts = {}, categoryOutcomeCounts = {};
  const repair = state.progress.value?.decisions?.repair;
  const acceptanceIds = new Set((repair?.approvedItems ?? [])
    .filter(item => item?.action === 'ACCEPT_NEW_BEHAVIOR' && activeDecision(item, repair)).map(item => item.id));
  let acceptedNewBehaviorCount = 0;
  for (const row of state.canonical.values()) {
    const category = displayUpgradeAssessment(row.category ?? '未分类');
    const outcome = row.outcome;
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
    const breakdown = categoryOutcomeCounts[category] ??= {};
    breakdown[outcome] = (breakdown[outcome] ?? 0) + 1;
    if (outcome === 'NO_CHANGE' && !state.reviewRowIds.has(row.rowId) && acceptanceIds.has(row.resolution?.approvalId))
      acceptedNewBehaviorCount++;
  }
  const assessmentSourceRows=state.records.reduce((n,record)=>n+(record.value?.assessmentSource ? record.value.rowResults.length : 0),0);
  return {validationScope:'STRUCTURE_AND_PROJECTION',projectKey:participant.projectKey,rowCount:raw.rows.length,
    categoryCounts,outcomeCounts,categoryOutcomeCounts,acceptedNewBehaviorCount,pendingCount:state.pendingCount,...state.pendingCounts,
    assessmentSourceRows,unverifiedAssessmentRows:raw.rows.length-assessmentSourceRows,reportSourceStatus,gaps:state.gaps,
    ...(state.ruleGaps?.counts ?? {}),...(state.rnohReviews?.counts ?? {})};
}

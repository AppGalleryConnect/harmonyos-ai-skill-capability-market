import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { taskProject, readProjectScan, optionalJson, updateProgress } from '../shared/platform/group-results.mjs';
import { readRuleGapReviews, ruleGapBasis, ruleGapDecisionFor, hasRecordedRuleGapReviews, ruleGapProposal, emptyRuleGapReview } from '../shared/platform/rule-gap-reviews.mjs';
import { assessmentCategories, onlyKeys, strings } from '../shared/platform/assessment-source.mjs';
import { sha256 } from '../shared/io/fs-utils.mjs';
import { relativePathInside } from '../shared/platform/paths.mjs';
import { ensureBatchDirectory } from '../shared/platform/artifact-layout.mjs';
import { jsonInput, locked, unchanged, exclusive } from './storage.mjs';

async function context(options) {
  const {participant}=await taskProject(options), layout=participant.outputLayout;
  const progress=await optionalJson(layout.progressPath), evidence=await optionalJson(layout.scanJson);
  if (!progress.value) throw new Error('请先运行 csv prepare 初始化进度');
  const attempt=participant.attempts.find(item=>item.batchId===participant.initialBatchId);
  let scan;
  if (attempt?.scanJsonSha256) {
    if (evidence.hash!==attempt.scanJsonSha256) throw new Error('初始扫描JSON来源已变化或缺失');
    // Native evidence is already bound to the initial CSV by task publication.
    // Supplementary review needs its own facts, never the CSV assessments/rows.
    scan={scanMetadata:evidence.value,snapshots:[evidence,{file:layout.rawCsv,hash:attempt.sha256}]};
  } else scan=await readProjectScan(participant,'upgrade');
  const comparison=scan.scanMetadata?.officialComparison;
  if (!comparison) throw new Error('原始扫描没有可信的同区间规则包比对；请使用新扫描任务取得证据');
  const state={...scan,progress,snapshots:[...scan.snapshots,progress]};
  return {participant,layout,state,comparison};
}

function requireReviewChoice(progress, basis) {
  const decision = ruleGapDecisionFor(progress, basis);
  if (decision?.action === 'SKIP') throw new Error('用户已选择跳过补充评估');
  const legacyReview = progress.ruleGapBasis === basis && hasRecordedRuleGapReviews(progress.ruleGapReviews);
  if (!decision && !legacyReview) throw new Error('请先取得用户的补充评估决定并运行 record-rule-gap-decision');
}

export async function recordRuleGapDecision(options) {
  const {participant, layout, state, comparison} = await context(options);
  const {value: input, snapshot} = await jsonInput(options.input);
  onlyKeys(input, ['action', 'basis', 'answer', 'source'], options.input);
  const progress = state.progress.value;
  const value = {...progress, decisions: {...progress.decisions, ruleGapReview: input}};
  if (!ruleGapDecisionFor(value, ruleGapBasis(comparison))) throw new Error('补充评估的比对摘要已变化，请重新核对并确认');

  return locked(layout, async () => {
    await unchanged(state, [snapshot]);
    const view = await readRuleGapReviews(state.scanMetadata, value);
    if (!view.comparisonCurrent) throw new Error('官网声明或规则包来源已变化，需重新取得同区间比对');
    if (!view.entries.length) throw new Error('本工程没有确认未覆盖的条目，无需登记补充评估决定');
    await unchanged(state, [snapshot, ...view.snapshots]);
    await updateProgress(state.progress, value);
    return {projectKey: participant.projectKey, ruleGapReviewDecision: view.decision, ...view.counts};
  });
}

export async function prepareRuleGapReviews(options) {
  const {layout,state,comparison}=await context(options), previous=state.progress.value;
  // No uncovered entries means no extra assessment, approval or empty section.
  if (!comparison.missing.length && !previous.ruleGapReviews?.length) {
    const view=await readRuleGapReviews(state.scanMetadata,previous);
    if (!view.comparisonCurrent) throw new Error('官网声明或规则包来源已变化，需重新取得同区间比对');
    await unchanged(state,view.snapshots);
    return {required:false,...view.counts,entries:[]};
  }
  return locked(layout,async()=>{
    await unchanged(state);
    const basis=ruleGapBasis(comparison), same=previous.ruleGapBasis===basis;
    if (comparison.missing.length) requireReviewChoice(previous, basis);
    const value={...previous,ruleGapBasis:basis,
      ...(previous.ruleGapBasis && !same ? {previousRuleGapReviews:{basis:previous.ruleGapBasis,entries:previous.ruleGapReviews ?? []}} : {}),
      ruleGapReviews:same ? previous.ruleGapReviews : comparison.missing.map(entry=>emptyRuleGapReview(entry.id))};
    value.ruleGapReviews ??= comparison.missing.map(entry=>emptyRuleGapReview(entry.id));
    const view=await readRuleGapReviews(state.scanMetadata,value);
    if (!view.comparisonCurrent) throw new Error('官网声明或规则包来源已变化，需重新取得同区间比对');
    await unchanged(state,view.snapshots);
    await updateProgress(state.progress,value);
    return {required:view.entries.length>0,...view.counts,entries:view.entries.map(entry=>({...entry.fact,review:entry.review}))};
  });
}

export async function recordRuleGapReview(options) {
  const {layout,state,comparison}=await context(options), progress=state.progress.value;
  const basis = ruleGapBasis(comparison);
  requireReviewChoice(progress, basis);
  if (progress.ruleGapBasis!==basis) throw new Error('比对来源已变化或尚未准备；请运行 prepare-rule-gaps');
  const source=await jsonInput(options.input), input=source.value;
  onlyKeys(input,['id','category','reason','evidence','locations','proposal','files','next','decision','outcome','changes'],options.input);
  const prior=progress.ruleGapReviews?.find(review=>review.id===input.id);
  if (!prior || !comparison.missing.some(entry=>entry.id===input.id)) throw new Error('不存在该未覆盖条目');
  const review={...prior,...input}; delete review.files;
  for (const key of ['reason','next','proposal']) if(typeof review[key]!=='string') throw new Error(`${key}需要字符串`);
  for (const key of ['evidence','locations','changes']) strings(review[key],options.input,key);
  if (!assessmentCategories.includes(review.category) || review.category==='范围外') throw new Error('补充评估分类无效');
  if (review.category!=='待分类' && (!review.reason.trim() || !review.evidence.length)) throw new Error('补充评估需要独立依据和证据');
  const proposalSha256=ruleGapProposal(review);
  let approvedBytes = null;
  if (input.decision) {
    const decision=input.decision;
    onlyKeys(decision,['action','answer','source','plan'],options.input);
    if (!['APPLY_APPROVED_CHANGE','ACCEPT_NEW_BEHAVIOR','NOT_IMPLEMENTED'].includes(decision.action)
      || typeof decision.answer!=='string' || !decision.answer.trim() || typeof decision.source!=='string' || !decision.source.trim()
      || !review.proposal.trim()) throw new Error('补充决定需要明确方案、真实答复和来源');
    if (decision.action==='ACCEPT_NEW_BEHAVIOR' && review.category!=='可选适配') throw new Error('只有可选适配可以接受新行为');
    if (!['必须适配','可选适配'].includes(review.category)) throw new Error('当前条目没有待批准的修复方案');
    const plan=path.resolve(layout.deliveryDirectory,decision.plan ?? `spec-rule-gap-${review.id}.md`);
    if (relativePathInside(layout.deliveryDirectory,plan)===null
      || relativePathInside(await realpath(layout.deliveryDirectory),await realpath(plan))===null) throw new Error('补充方案必须位于当前交付目录');
    approvedBytes=await readFile(plan);
    const planSha256=sha256(approvedBytes), archive=path.join(layout.evidenceDirectory,'rule-gap-decisions',`${review.id}-${planSha256}.md`);
    review.decision={...decision,plan,planSha256,archive,proposalSha256};
  } else if (review.decision?.proposalSha256!==proposalSha256) {
    if (review.decision) review.previousDecision=review.decision;
    delete review.decision;
  }
  const decision=review.decision;
  if (input.outcome==='MODIFIED' && decision?.action!=='APPLY_APPROVED_CHANGE')
    throw new Error('补充已修改结论需要当前方案的明确批准');
  review.outcome=review.category==='无需适配'?'NO_CHANGE':decision?.action==='NOT_IMPLEMENTED'?'NOT_IMPLEMENTED'
    :decision?.action==='ACCEPT_NEW_BEHAVIOR'?'NO_CHANGE':decision?.action==='APPLY_APPROVED_CHANGE'
      ?(input.outcome ?? (prior.decision?.proposalSha256===proposalSha256?prior.outcome:'PENDING')):'DECISION_REQUIRED';
  if (review.category==='待分类') review.outcome='PENDING';
  if (review.outcome==='MODIFIED' && (!review.changes.length || decision?.action!=='APPLY_APPROVED_CHANGE'))
    throw new Error('补充已修改结论需要实际差异及当前方案批准');
  if (!['PENDING','DECISION_REQUIRED','NO_CHANGE','NOT_IMPLEMENTED','MODIFIED','EVIDENCE_GAP'].includes(review.outcome)) throw new Error('补充处理结论无效');
  const files=input.files ?? (prior.inputs ?? []).map(entry=>entry.file);
  strings(files,options.input,'files');
  review.inputs=[];
  for (const file of new Set([path.join(options.projectPath,'build-profile.json5'),...files].map(file=>path.resolve(options.projectPath,file))))
    review.inputs.push({file,hash:sha256(await readFile(file))});
  return locked(layout,async()=>{
    const planSnapshot=review.decision ? {file:review.decision.plan,hash:review.decision.planSha256}:null;
    await unchanged(state,[source.snapshot,...review.inputs,planSnapshot].filter(Boolean));
    if (approvedBytes) {
      await ensureBatchDirectory(layout,path.dirname(review.decision.archive));
      await exclusive(review.decision.archive,approvedBytes);
    }
    const value={...progress,ruleGapReviews:progress.ruleGapReviews.map(entry=>entry.id===review.id?review:entry)};
    const view=await readRuleGapReviews(state.scanMetadata,value);
    if (!view.comparisonCurrent) throw new Error('官网声明或规则包来源已变化，需重新取得同区间比对');
    await unchanged(state,view.snapshots);
    await updateProgress(state.progress,value);
    return {id:review.id,outcome:review.outcome,...view.counts};
  });
}

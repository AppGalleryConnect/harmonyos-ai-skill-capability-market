import { readFile } from 'node:fs/promises';
import { sha256 } from '../io/fs-utils.mjs';
import { assessmentCategories } from './assessment-source.mjs';

export const ruleGapBasis = comparison => sha256(JSON.stringify(comparison));
export const emptyRuleGapReview = id => ({id,category:'待分类',outcome:'PENDING',reason:'',evidence:[],locations:[],proposal:'',changes:[],next:''});
export const ruleGapProposal = review => sha256(JSON.stringify([review.category,review.proposal,review.locations]));

export function ruleGapDecisionFor(progress, basis) {
  const decision = progress.decisions?.ruleGapReview;
  if (decision == null) return null;
  if (!['REVIEW', 'SKIP'].includes(decision.action)
    || typeof decision.basis !== 'string' || !/^[a-f0-9]{64}$/.test(decision.basis)
    || ['answer', 'source'].some(field => typeof decision[field] !== 'string' || !decision[field].trim()))
    throw new Error('补充评估决定需要有效动作、比对摘要、实际答复和来源：action 取 SKIP（用户答「否」）或 REVIEW（答「是」），basis 填 csv inspect 返回的 ruleGapBasis（64 位十六进制），answer 与 source 为非空字符串');
  return decision.basis === basis ? decision : null;
}

export function hasRecordedRuleGapReviews(reviews = []) {
  return reviews.some(review => review.category !== '待分类' || review.outcome !== 'PENDING'
    || review.inputs?.length || review.reason || review.evidence?.length || review.locations?.length
    || review.proposal || review.decision || review.changes?.length || review.next);
}

export async function readRuleGapReviews(scanMetadata, progress = {}) {
  const comparison = scanMetadata?.officialComparison;
  if (!comparison) return {known:false,entries:[],counts:{},snapshots:[],
    gaps:progress.decisions?.ruleGapReview ? ['缺少同批次规则包比对来源，无法沿用补充评估决定'] : []};
  if (!Array.isArray(comparison.entries) || !Array.isArray(comparison.missing)) throw new Error('官方条目比对清单格式无效');
  const expected = comparison.entries.filter(entry=>entry.status==='MISSING_RULE');
  if (JSON.stringify(expected.map(entry=>entry.id))!==JSON.stringify(comparison.missing.map(entry=>entry.id))
    || new Set(expected.map(entry=>entry.id)).size!==expected.length) throw new Error('未覆盖条目清单身份不一致');
  const reviews = progress.ruleGapReviews ?? [], ids = new Set(expected.map(entry=>entry.id));
  if (!Array.isArray(reviews) || new Set(reviews.map(review=>review.id)).size!==reviews.length
    || reviews.some(review=>!ids.has(review.id))) throw new Error('补充评估包含未知或重复条目');
  const gaps = [], snapshots = [];
  const snapshot = async file => {
    let hash = null;
    try { hash=sha256(await readFile(file)); } catch(error) { if(error.code!=='ENOENT') throw error; }
    snapshots.push({file,hash}); return hash;
  };
  const basis = ruleGapBasis(comparison);
  let stale = reviews.length>0 && progress.ruleGapBasis!==basis, changedSources = 0;
  for (const source of comparison.sources ?? []) if (await snapshot(source.file)!==source.hash) {
    stale=true; changedSources++; gaps.push(`官网声明或规则包来源已变化：${source.file}`);
  }
  if (comparison.unresolvedCount) gaps.push(`官网条目与规则包仍有 ${comparison.unresolvedCount} 项映射或阶段待核对`);
  const comparisonCurrent = changedSources === 0;
  const decision = comparisonCurrent ? ruleGapDecisionFor(progress, basis) : null;
  const hasRecordedReviews = hasRecordedRuleGapReviews(reviews);
  const skipped = decision?.action === 'SKIP';
  if (skipped && hasRecordedReviews) throw new Error('已有补充评估或修复记录，无法登记整批跳过');
  const decisionRequired = comparisonCurrent && expected.length > 0 && !decision
    && !(progress.ruleGapBasis === basis && hasRecordedReviews);
  if (decisionRequired) gaps.push('DevEco 规则包未覆盖条目的补充评估待用户决定');
  const entries = [];
  for (const fact of expected) {
    const review = reviews.find(item=>item.id===fact.id) ?? emptyRuleGapReview(fact.id);
    if (!assessmentCategories.includes(review.category) || !Array.isArray(review.evidence) || !Array.isArray(review.changes)
      || !Array.isArray(review.locations) || ['reason','next','proposal'].some(key=>typeof review[key]!=='string'))
      throw new Error(`补充评估格式无效：${fact.id}`);
    if (review.outcome==='MODIFIED' && (review.decision?.action!=='APPLY_APPROVED_CHANGE' || !review.changes.length)
      || review.outcome==='NOT_IMPLEMENTED' && review.decision?.action!=='NOT_IMPLEMENTED'
      || review.outcome==='NO_CHANGE' && review.category!=='无需适配' && (review.category!=='可选适配' || review.decision?.action!=='ACCEPT_NEW_BEHAVIOR'))
      throw new Error(`补充处理缺少适用的明确决定或实际差异：${fact.id}`);
    if (review.decision && (!['APPLY_APPROVED_CHANGE','ACCEPT_NEW_BEHAVIOR','NOT_IMPLEMENTED'].includes(review.decision.action)
      || typeof review.decision.answer!=='string' || !review.decision.answer.trim()
      || typeof review.decision.source!=='string' || !review.decision.source.trim()
      || !review.decision.plan || !review.decision.archive || !review.proposal.trim()))
      throw new Error(`补充批准缺少实际答复、来源或方案：${fact.id}`);
    let outdated = stale;
    for (const input of review.inputs ?? []) if (await snapshot(input.file)!==input.hash) outdated=true;
    if (review.decision && review.decision.proposalSha256!==ruleGapProposal(review)) outdated=true;
    if (review.decision?.plan) {
      if (await snapshot(review.decision.plan)!==review.decision.planSha256) outdated=true;
      if (review.decision.archive && await snapshot(review.decision.archive)!==review.decision.planSha256) outdated=true;
    }
    const assessed = !outdated && review.category!=='待分类' && review.reason.trim() && review.evidence.length>0;
    const pending = !skipped && (!assessed || !['NO_CHANGE','MODIFIED','NOT_IMPLEMENTED'].includes(review.outcome) || Boolean(review.next.trim()));
    if (pending && (hasRecordedReviews || (comparisonCurrent && !decisionRequired)))
      gaps.push(`${fact.title}：${outdated?'补充评估证据已变化，需复核':review.next || '补充分析、决定或修复尚未完成'}`);
    entries.push({fact,review,outdated,assessed:Boolean(assessed),pending});
  }
  return {known:true,basis,comparison,comparisonCurrent,decision,decisionRequired,hasRecordedReviews,entries,gaps,snapshots,counts:{ruleGapCount:entries.length,
    ruleGapAssessedCount:entries.filter(entry=>entry.assessed).length,ruleGapPendingCount:entries.filter(entry=>entry.pending).length,
    ruleGapSkippedCount:skipped ? entries.length : 0,
    ruleComparisonPendingCount:comparison.unresolvedCount ?? 0,ruleComparisonSourceStale:!comparisonCurrent}};
}

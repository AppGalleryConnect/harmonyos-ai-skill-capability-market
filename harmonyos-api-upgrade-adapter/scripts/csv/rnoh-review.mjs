import { taskProject, optionalJson, updateProgress } from '../shared/platform/group-results.mjs';
import { onlyKeys, strings } from '../shared/platform/assessment-source.mjs';
import { readRnohReviews, rnohReviewTargets, rnohReviewBasis, RNOH_CONCLUSIONS, RNOH_EVIDENCE_LEVELS, RNOH_LIBRARY_PREFIX } from '../shared/platform/rnoh-reviews.mjs';
import { jsonInput, locked, unchanged } from './storage.mjs';

const text = (value, field, file) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${file}；${field} 需要非空字符串`);
  return value;
};

/**
 * 登记 U04a 的核对结论。可分多次提交：同一条目以最后一次为准，独立结论优先于成组排除。
 * 输入：{ excluded: [{ reason, entries: [条目 id] }], reviews: [{ id, conclusion, layer, condition, evidence, evidenceLevel, summary, proposal?, sharedItemId? }] }
 */
export async function recordRnohReview(options) {
  const { participant } = await taskProject(options), layout = participant.outputLayout;
  const progress = await optionalJson(layout.progressPath), evidence = await optionalJson(layout.scanJson);
  if (!progress.value) throw new Error('请先运行 csv prepare 初始化进度');
  const attempt = participant.attempts.find(item => item.batchId === participant.initialBatchId);
  if (attempt?.scanJsonSha256 && evidence.hash !== attempt.scanJsonSha256) throw new Error('初始扫描JSON来源已变化或缺失');
  const targets = rnohReviewTargets(evidence.value);
  if (!targets) throw new Error('当前工程的扫描结果没有已完成的 RNOH 检索，无需登记 RNOH 补充核对');
  const known = new Set(targets.map(target => target.id)), basis = rnohReviewBasis(targets);
  const { value: input, snapshot } = await jsonInput(options.input);
  onlyKeys(input, ['excluded', 'reviews'], options.input);
  const excluded = input.excluded ?? [], reviews = input.reviews ?? [];
  if (!Array.isArray(excluded) || !Array.isArray(reviews) || (!excluded.length && !reviews.length))
    throw new Error('RNOH 补充核对需要 excluded（成组排除）或 reviews（逐条结论）至少一项');
  const seen = new Set();
  const claim = id => {
    if (seen.has(id)) throw new Error(`同一次输入里条目重复出现：${id}。一个条目只能在一个排除组里，或有一条独立结论`);
    seen.add(id);
  };
  for (const group of excluded) {
    onlyKeys(group, ['reason', 'entries'], options.input);
    text(group.reason, 'excluded[].reason（本组共同的具体排除依据）', options.input);
    strings(group.entries, options.input, 'excluded[].entries');
    if (!group.entries.length) throw new Error('excluded[].entries 不能为空');
    for (const id of group.entries) {
      if (!known.has(id)) throw new Error(`excluded 含不在补充核对清单中的条目：${id}。条目 id 取扫描 JSON rnoh.uncoveredEntries[].sourceReference；FRAMEWORK_ONLY、BUSINESS_NOT_SCANNED 规则用它的 ruleId`);
      claim(id);
    }
  }
  for (const review of reviews) {
    onlyKeys(review, ['id', 'conclusion', 'layer', 'condition', 'evidence', 'evidenceLevel', 'summary', 'proposal', 'sharedItemId'], options.input);
    text(review.id, 'reviews[].id', options.input);
    const library = review.id.startsWith(RNOH_LIBRARY_PREFIX);
    if (!library && !known.has(review.id)) throw new Error(`reviews 含不在补充核对清单中的条目：${review.id}。三方 RN 鸿蒙库用 ${RNOH_LIBRARY_PREFIX}<库名>`);
    if (library && !review.id.slice(RNOH_LIBRARY_PREFIX.length).trim()) throw new Error('三方 RN 鸿蒙库条目需要库名');
    claim(review.id);
    if (!RNOH_CONCLUSIONS.includes(review.conclusion)) throw new Error(`${review.id}；conclusion 取值为 ${RNOH_CONCLUSIONS.join('、')}`);
    if (!RNOH_EVIDENCE_LEVELS.includes(review.evidenceLevel)) throw new Error(`${review.id}；evidenceLevel 取值为 ${RNOH_EVIDENCE_LEVELS.join('、')}`);
    for (const field of ['layer', 'condition', 'summary']) text(review[field], `${review.id} 的 ${field}`, options.input);
    strings(review.evidence, options.input, 'reviews[].evidence');
    if (review.conclusion !== 'EVIDENCE_GAP' && !review.evidence.length) throw new Error(`${review.id}；结论需要至少一条证据位置（文件与行号，或官方章节位置）`);
    if (review.conclusion === 'AFFECTED') text(review.proposal, `${review.id} 的 proposal（影响 RN 页面时写明方案和影响平台）`, options.input);
    else if (review.proposal !== undefined && typeof review.proposal !== 'string') throw new Error(`${review.id}；proposal 需要字符串`);
    if (review.sharedItemId !== undefined && !/^rnoh-/.test(text(review.sharedItemId, `${review.id} 的 sharedItemId`, options.input)))
      throw new Error(`${review.id}；sharedItemId 使用 rnoh- 前缀，与 spec 的 sharedItems 对应`);
  }
  const prior = progress.value.rnohReview?.basis === basis ? progress.value.rnohReview : { excluded: [], reviews: [] };
  const reviewed = new Set(reviews.map(review => review.id));
  const mergedReviews = [...prior.reviews.filter(review => !seen.has(review.id)), ...reviews];
  const keptReviewed = new Set(mergedReviews.map(review => review.id));
  // 独立结论优先：已有结论的条目不留在任何排除组里；重新成组排除的条目则撤下旧结论。
  const mergedGroups = [...prior.excluded.map(group => ({ reason: group.reason, entries: group.entries.filter(id => !seen.has(id)) })),
    ...excluded.map(group => ({ reason: group.reason.trim(), entries: group.entries.filter(id => !reviewed.has(id)) }))]
    .map(group => ({ reason: group.reason, entries: group.entries.filter(id => !keptReviewed.has(id)) })).filter(group => group.entries.length);
  const value = { ...progress.value, rnohReview: { basis, excluded: mergedGroups, reviews: mergedReviews } };
  const state = { snapshots: [evidence, progress] };
  return locked(layout, async () => {
    await unchanged(state, [snapshot]);
    await updateProgress(progress, value);
    const view = readRnohReviews(evidence.value, value), pending = view.entries.filter(entry => entry.pending);
    return { projectKey: participant.projectKey, ...view.counts, libraryCount: view.libraries.length,
      pending: pending.slice(0, 60).map(entry => ({ id: entry.id, kit: entry.kit ?? '', title: entry.title })),
      ...(pending.length > 60 ? { pendingTruncated: pending.length - 60 } : {}) };
  });
}

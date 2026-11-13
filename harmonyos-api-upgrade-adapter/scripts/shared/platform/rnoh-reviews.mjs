import { sha256 } from '../io/fs-utils.mjs';

export const RNOH_CONCLUSIONS = Object.freeze(['NOT_AFFECTED', 'AFFECTED', 'NEEDS_DEVICE_VERIFICATION', 'EVIDENCE_GAP']);
export const RNOH_EVIDENCE_LEVELS = Object.freeze(['实证', '推断', '需真机验证']);
export const RNOH_LIBRARY_PREFIX = 'lib:';
export const rnohConclusionLabels = Object.freeze({ NOT_AFFECTED: '不影响 RN 页面', AFFECTED: '影响 RN 页面',
  NEEDS_DEVICE_VERIFICATION: '需真机验证', EVIDENCE_GAP: '证据不足' });

/**
 * U04a 的核对对象：框架整体影响规则和没有 RNOH 规则的官方条目。非 RNOH 工程或未完成 RNOH 检索时返回 null。
 * 三方 RN 鸿蒙库无法由扫描枚举，用 lib:<库名> 作为可选的附加条目登记。
 */
export function rnohReviewTargets(scanMetadata) {
  const summary = scanMetadata?.rnoh;
  if (!summary || summary.status !== 'COMPLETE') return null;
  const targets = [];
  // 业务 JS 未检索的规则同样没有业务行，需要在补充核对里给出结论。
  for (const rule of summary.rules ?? []) if (rule.status === 'FRAMEWORK_ONLY' || rule.status === 'BUSINESS_NOT_SCANNED')
    targets.push({ id: rule.ruleId, kind: rule.status === 'FRAMEWORK_ONLY' ? 'FRAMEWORK_RULE' : 'UNSCANNED_RULE', title: rule.title, changedInSdk: rule.changedInSdk ?? '', sourceReference: rule.sourceReference ?? '' });
  for (const entry of summary.uncoveredEntries ?? [])
    targets.push({ id: entry.sourceReference, kind: 'ENTRY', title: entry.title, kit: entry.kit ?? '', changedInSdk: entry.changedInSdk ?? '', sourceReference: entry.sourceReference });
  if (targets.some(target => typeof target.id !== 'string' || !target.id) || new Set(targets.map(target => target.id)).size !== targets.length)
    throw new Error('RNOH 补充核对清单存在缺失或重复的条目身份');
  return targets;
}

export const rnohReviewBasis = targets => sha256(JSON.stringify(targets.map(target => target.id)));

/** 汇总 U04a 登记状态：每个条目要么在某个成组排除里，要么有一条独立结论，否则待核对。 */
export function readRnohReviews(scanMetadata, progress = {}) {
  const targets = rnohReviewTargets(scanMetadata);
  if (!targets) return null;
  const basis = rnohReviewBasis(targets), record = progress.rnohReview ?? null;
  const stale = Boolean(record) && record.basis !== basis;
  const groups = stale ? [] : record?.excluded ?? [], reviews = stale ? [] : record?.reviews ?? [];
  const excludedBy = new Map(), reviewBy = new Map(reviews.map(review => [review.id, review]));
  for (const group of groups) for (const id of group.entries) excludedBy.set(id, group.reason);
  const entries = targets.map(target => {
    const review = reviewBy.get(target.id) ?? null, excluded = review ? null : excludedBy.get(target.id) ?? null;
    return { ...target, review, excluded, pending: !review && excluded === null };
  });
  const libraries = reviews.filter(review => review.id.startsWith(RNOH_LIBRARY_PREFIX));
  const pending = entries.filter(entry => entry.pending).length, gaps = [];
  if (stale) gaps.push('RNOH 补充核对清单已变化，原登记结论不再沿用，需按当前扫描结果重新登记');
  if (pending) gaps.push(`RNOH 无规则条目补充核对（U04a）尚有 ${pending} 项未登记结论`);
  for (const review of reviews) if (['NEEDS_DEVICE_VERIFICATION', 'EVIDENCE_GAP'].includes(review.conclusion)) {
    const title = entries.find(entry => entry.id === review.id)?.title ?? review.id;
    gaps.push(`RNOH 补充核对 · ${title}：${rnohConclusionLabels[review.conclusion]}`);
  }
  return { basis, stale, entries, libraries, excludedGroups: groups, gaps,
    counts: { rnohReviewCount: entries.length, rnohReviewExcludedCount: entries.filter(entry => entry.excluded !== null).length,
      rnohReviewAssessedCount: entries.filter(entry => entry.review).length, rnohReviewPendingCount: pending, rnohReviewStale: stale } };
}

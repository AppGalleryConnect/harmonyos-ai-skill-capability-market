import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { equalData } from '../shared/platform/assessment-source.mjs';
import { relativePathInside } from '../shared/platform/paths.mjs';
import { sha256 } from '../shared/io/fs-utils.mjs';
import { findSpecOption } from '../shared/platform/spec-source.mjs';

export async function reportRepairDecisions(state, items, gaps) {
  const layout = state.participant.outputLayout, root = await realpath(layout.deliveryDirectory);
  const files = new Map();
  async function verifiedFile(file, hash) {
    if (typeof file !== 'string' || !/^[a-f0-9]{64}$/.test(hash ?? '')) return null;
    const absolute = path.resolve(file);
    if (relativePathInside(layout.deliveryDirectory, absolute) === null) return null;
    if (!files.has(absolute)) files.set(absolute, (async () => {
      try {
        if (relativePathInside(root, await realpath(absolute)) === null) return null;
        const bytes = await readFile(absolute);
        return { bytes, file: absolute, hash: sha256(bytes) };
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
        throw error;
      }
    })());
    const result = await files.get(absolute);
    return result?.hash === hash ? result : null;
  }
  const decisions = [], seen = new Set();
  for (const item of items) {
    if (seen.has(item.id) || !/^[a-f0-9]{64}$/.test(item.proposalSha256 ?? '') || !item.answer?.trim() || !item.source?.trim()
      || !['APPLY_APPROVED_CHANGE', 'ACCEPT_NEW_BEHAVIOR'].includes(item.action)) continue;
    const rowIds = [...new Set(item.rowIds ?? [])].filter(id => {
      const row = state.canonical.get(id);
      return !row?.decisionOutdated && !state.reviewRowIds.has(id)
        && (row?.category === '可选适配' || row?.category === '必须适配' && item.action === 'APPLY_APPROVED_CHANGE');
    });
    if (!rowIds.length) continue;
    const current = state.specSource?.source.sha256 === item.proposalSha256 ? state.specSource : null;
    const saved = current ? null : await verifiedFile(path.join(layout.evidenceDirectory, 'plans',
      `proposal-${item.proposalSha256}.json`), item.proposalSha256);
    const proposal = current?.proposal ?? (saved ? JSON.parse(saved.bytes) : null);
    const scope = findSpecOption(proposal,item.id)?.option;
    const archive = scope && await verifiedFile(item.plan, item.specSha256);
    if (!archive || !scope.description?.trim() || !['groupId', 'assessmentSha256', 'action', 'rowIds']
      .every(key => equalData(scope[key], item[key]))) {
      gaps.push(`无法核对用户决定的方案来源：${item.id}`);
      continue;
    }
    seen.add(item.id);
    for (const snapshot of [saved, archive]) if (snapshot && !state.snapshots.some(entry => entry.file === snapshot.file && entry.hash === snapshot.hash)) {
      state.snapshots.push({ file: snapshot.file, hash: snapshot.hash });
    }
    decisions.push({ ...item, rowIds, description: scope.description });
  }
  return decisions;
}

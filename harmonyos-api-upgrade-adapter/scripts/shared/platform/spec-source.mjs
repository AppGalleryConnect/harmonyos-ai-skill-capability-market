import { readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { relativePathInside } from './paths.mjs';
import { sha256 } from '../io/fs-utils.mjs';

const cell = value => String(value).replaceAll('|', '&#124;').replaceAll('\n', '<br>');

export function findSpecOption(proposal, id) {
  const item = proposal?.items.find(entry => entry.id === id || entry.alternative?.id === id);
  if (!item) return undefined;
  if (item.id === id) return { item, option: item };
  const { groupId, rowIds, assessmentSha256 } = item;
  return { item, option: { ...item.alternative, groupId, rowIds, assessmentSha256 } };
}

export function renderSpec(proposal, repair = {}, proposalHash) {
  const approved = [...(repair.approvedItems ?? []), ...(repair.approvedSharedItems ?? []),...(repair.declinedItems ?? []),...(repair.declinedSharedItems ?? [])]
    .filter(item => item.proposalSha256 === proposalHash);
  const selected = new Map(approved.map(item => [item.id, item]));
  const all = [...proposal.items, ...proposal.sharedItems];
  const declined=approved.filter(item=>item.decision==='NOT_IMPLEMENTED').length;
  const status = !all.length ? '评估完成，无需实施批准' : declined===all.length ? '不实施方案' : approved.length === all.length ? declined ? '决定已记录，部分实施' : '全部批准' : approved.length ? '部分决定已记录' : '待确认';
  let text = `# API 行为变更适配方案\n\n状态为${status}。\n\n${proposal.narrative.trim()}\n${proposal.assessmentOverview ?? ''}\n## 方案项与原始行范围\n`;
  for (const item of proposal.items) {
    text += `\n### ${cell(item.id)}\n\n`;
    if (item.alternative) {
      const alternative = item.alternative;
      text += `本组可任选一种做法。\n\n- 推荐做法 ${cell(item.id)}（${item.action}）。${cell(item.description)}\n`;
      text += `- 备选做法 ${cell(alternative.id)}（${alternative.action}）。${cell(alternative.description)}\n\n`;
    } else {
      text += `${item.description}\n\n动作为 ${item.action}。`;
    }
    text += `原始行 ${item.rowIds.length} 条，独立代码位置 ${item.locationCount} 个。\n\n`;
    text += '| 完整 rowId | 物理文件与调用位置 | API 定义 |\n| --- | --- | --- |\n';
    for (const row of item.rows) text += `| ${cell(row.rowId)} | ${cell(row.physicalFile)} · ${cell(row.codeLocation)} | ${cell(row.apiDefinition)} |\n`;
  }
  text += '\n## 共享修改\n';
  for (const item of proposal.sharedItems) text += `\n- ${cell(item.id)} ${item.description}\n`;
  text += '\n## 用户确认\n';
  for (const item of all) {
    const decision = selected.get(item.id) ?? selected.get(item.alternative?.id);
    text += `\n- ${cell(decision?.id ?? item.id)} ${decision ? `${decision.decision==='NOT_IMPLEMENTED'?'未实施':'已批准'}。实际答复 ${cell(decision.answer)}。来源 ${cell(decision.source)}` : '待确认'}\n`;
  }
  return text;
}

export async function readSpecSource(layout, repair, { allowPendingPublication = false } = {}) {
  const source = repair?.proposal;
  if (!source) return null;
  const file = path.resolve(layout.deliveryDirectory, source.record);
  const plan = path.resolve(source.plan);
  for (const target of [file, plan]) {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || relativePathInside(layout.deliveryDirectory, target) === null
      || relativePathInside(await realpath(layout.deliveryDirectory), await realpath(target)) === null)
      throw new Error(`方案来源越界或不是普通文件：${target}`);
  }
  const bytes = await readFile(file);
  if (sha256(bytes) !== source.sha256) throw new Error('方案来源已变化，需要重新生成方案并核对批准');
  const proposal = JSON.parse(bytes.toString('utf8'));
  const approvedSnapshots = new Map();
  for (const item of [...(repair.approvedItems ?? []), ...(repair.approvedSharedItems ?? []),...(repair.declinedItems ?? []),...(repair.declinedSharedItems ?? [])]) {
    if (item.proposalSha256 !== source.sha256 || approvedSnapshots.has(item.plan)) continue;
    const archived = path.resolve(item.plan);
    if (relativePathInside(layout.deliveryDirectory,archived) === null
      || relativePathInside(await realpath(layout.deliveryDirectory),await realpath(archived)) === null)
      throw new Error('批准方案快照路径越界');
    const hash = sha256(await readFile(archived));
    if (hash !== item.specSha256) throw new Error('批准方案快照已变化');
    approvedSnapshots.set(archived,{file:archived,hash});
  }
  const current = await readFile(plan), expected = renderSpec(proposal, repair, source.sha256);
  if (current.toString('utf8') !== expected) {
    const approved = [...(repair.approvedItems ?? []), ...(repair.approvedSharedItems ?? []),...(repair.declinedItems ?? []),...(repair.declinedSharedItems ?? [])];
    const pending = approved.some(item => item.proposalSha256 === source.sha256 && item.specSha256 === sha256(current));
    if (!allowPendingPublication || !pending) throw new Error(`方案 spec 已变化或确认区未同步：${plan}`);
  }
  return { proposal, expected, source, snapshots: [{file,hash:sha256(bytes)}, {file:plan,hash:sha256(current)}, ...approvedSnapshots.values()] };
}

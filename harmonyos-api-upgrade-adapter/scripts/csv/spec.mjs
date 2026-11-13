import path from 'node:path';
import { readGroupResults, taskProject } from '../shared/platform/group-results.mjs';
import { equalData, onlyKeys, strings } from '../shared/platform/assessment-source.mjs';
import { ensureBatchDirectory } from '../shared/platform/artifact-layout.mjs';
import { relativePathInside } from '../shared/platform/paths.mjs';
import { findSpecOption, renderSpec, readSpecSource } from '../shared/platform/spec-source.mjs';
import { atomicWrite, sha256 } from '../shared/io/fs-utils.mjs';
import { jsonInput, exclusive, locked, unchanged } from './storage.mjs';

export async function prepareSpec(options, io = {}) {
  const {participant} = await taskProject(options), layout = participant.outputLayout;
  const state = await readGroupResults(participant, 'upgrade', {strict:true});
  const source = await jsonInput(options.input), input = source.value;
  onlyKeys(input, ['narrative','items','sharedItems'], options.input);
  if (typeof input.narrative !== 'string' || !input.narrative.trim() || !Array.isArray(input.items))
    throw new Error('方案需要模型填写narrative和明确items');
  const seen = new Set(), selectedRows = new Map();
  const identify = item => {
    if (typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)
      || typeof item.description !== 'string' || !item.description.trim()) throw new Error('方案项ID缺失/重复或缺少具体说明');
    seen.add(item.id);
  };
  const items = input.items.map(item => {
    onlyKeys(item, ['id','description','groupId','rowIds','action','assessmentSha256','alternative'], options.input);
    identify(item); strings(item.rowIds, options.input, 'rowIds');
    const entry = state.records.find(record => record.value?.id === item.groupId);
    if (!entry?.value.assessmentSource || item.assessmentSha256 !== entry.value.assessmentSource.sha256)
      throw new Error('方案必须关联当前分组的原始评估来源');
    if (!item.rowIds.length) throw new Error(`方案项 ${item.id} 的 rowIds 为空，需列出该项覆盖的全部原始行`);
    if (new Set(item.rowIds).size !== item.rowIds.length) throw new Error(`方案项 ${item.id} 的 rowIds 内有重复，每个 rowId 只写一次`);
    if (!['ACCEPT_NEW_BEHAVIOR','APPLY_APPROVED_CHANGE'].includes(item.action))
      throw new Error(`方案项 ${item.id} 缺少 action 或取值无效，可用值为 ACCEPT_NEW_BEHAVIOR、APPLY_APPROVED_CHANGE`);
    const alternative = item.alternative;
    if (alternative !== undefined) {
      onlyKeys(alternative, ['id','action','description'], options.input);
      identify(alternative);
      const otherAction = item.action === 'ACCEPT_NEW_BEHAVIOR' ? 'APPLY_APPROVED_CHANGE' : 'ACCEPT_NEW_BEHAVIOR';
      if (alternative.action !== otherAction)
        throw new Error(`方案项 ${item.id} 与 ${alternative.id} 的互斥做法必须分别使用 ACCEPT_NEW_BEHAVIOR 和 APPLY_APPROVED_CHANGE 两种动作`);
    }
    const owned = new Set(entry.value.rowResults.map(row=>row.rowId));
    const rows = item.rowIds.map(id => {
      const row = state.inspected.rows.find(row=>row.rowId===id);
      if (!row) throw new Error(`方案项 ${item.id} 含当前扫描结果中不存在的rowId：${id}`);
      if (!owned.has(id)) throw new Error(`方案项 ${item.id} 的rowId不属于分组 ${item.groupId}：${id}`);
      if (selectedRows.has(id)) throw new Error(`rowId 已在方案项 ${selectedRows.get(id)} 中，不能再写入方案项 ${item.id}：${id}。每个原始行只属于一个方案项，同组的互斥做法用 alternative 表达`);
      selectedRows.set(id, item.id);
      const category = state.canonical.get(id).category;
      if (alternative && category !== '可选适配') throw new Error(`方案项 ${item.id} 的互斥做法只适用于可选适配行：${id}`);
      if (item.action === 'ACCEPT_NEW_BEHAVIOR' ? category !== '可选适配' : !['必须适配','可选适配'].includes(category))
        throw new Error(`方案动作不适用于本行评估分类：${id}`);
      return {rowId:id,physicalFile:row.physicalFile ?? '',codeLocation:row.cells['Code Location'],line:row.line,column:row.column,apiDefinition:row.cells['Api Definition'] ?? ''};
    });
    const locationCount = new Set(rows.map(row=>JSON.stringify([row.physicalFile,row.line ?? row.codeLocation,row.column]))).size;
    return {...item,rows,locationCount};
  });
  if (input.sharedItems !== undefined && !Array.isArray(input.sharedItems)) throw new Error('sharedItems必须为数组');
  const sharedItems = (input.sharedItems ?? []).map(item => {
    onlyKeys(item, ['id','description'], options.input); identify(item); return item;
  });
  const cell=value=>String(value).replaceAll('|','&#124;').replaceAll('\n','<br>');
  const assessmentOverview='\n## 当前评估\n'+state.records.map(entry=>{
    const group=entry.value, summary=group.changeSummary ?? {};
    return `\n### ${group.overview || group.id}\n\n变更前：${summary.before || '证据未补齐'}\n\n变更后：${summary.after || '证据未补齐'}\n\ntarget 隔离：${summary.targetIsolation || '证据未补齐'}\n\n方案与取舍：${summary.proposal || '见下列逐行依据'}\n\n| rowId | 评估结论 | 评估依据 | 兼容分析 |\n| --- | --- | --- | --- |\n`+group.rowResults.map(row=>`| ${cell(row.rowId)} | ${cell(row.category)} | ${cell(row.reason)} | ${cell(row.compatibility)} |`).join('\n')+'\n';
  }).join('');
  const proposal = {narrative:input.narrative,items,sharedItems,assessmentOverview};
  const bytes = JSON.stringify(proposal,null,2)+'\n', hash = sha256(bytes);
  const plan = path.resolve(options.output);
  if (relativePathInside(layout.deliveryDirectory,plan) === null) throw new Error('方案输出必须位于当前工程交付目录内');
  return locked(layout, async () => {
    await io.beforeWrite?.(); await unchanged(state,[source.snapshot]);
    const directory = path.join(layout.evidenceDirectory,'plans');
    await ensureBatchDirectory(layout,directory);
    const file = path.join(directory,`proposal-${hash}.json`);
    await exclusive(file,bytes);
    const repair = state.progress.value.decisions?.repair ?? {};
    await ensureBatchDirectory(layout,path.dirname(plan));
    try { await exclusive(plan,renderSpec(proposal,repair,hash)); }
    catch (error) {
      if (!String(error.message).startsWith('文件已存在且不同')) throw error;
      throw new Error(`该路径已有内容不同的 spec：${plan}。方案有实质变化时保留原文件不动，把 --output 换成同目录下的新文件名（如 spec-v2.md）重新生成，批准时 plan 填新路径；不要删除、移动或覆盖原 spec，已登记的方案记录仍引用它`);
    }
    await unchanged(state,[source.snapshot]);
    const progress = structuredClone(state.progress.value);
    const prior=await readSpecSource(layout,repair), superseded=new Set(repair.supersededItems ?? []);
    for (const decision of [...(repair.approvedItems ?? []),...(repair.declinedItems ?? [])]) {
      if (!items.some(item=>item.rowIds.some(id=>decision.rowIds.includes(id)))) continue;
      const old = findSpecOption(prior?.proposal,decision.id)?.option;
      const current = findSpecOption(proposal,decision.id)?.option;
      if (!current || current.description!==old?.description
        || !['groupId','assessmentSha256','action','rowIds'].every(key=>equalData(current[key],decision[key]))) superseded.add(decision.id);
    }
    progress.decisions = {...progress.decisions,repair:{...repair,plan,
      supersededItems:[...superseded],
      proposal:{record:path.relative(layout.deliveryDirectory,file),sha256:hash,plan}}};
    await atomicWrite(layout.progressPath,JSON.stringify(progress,null,2)+'\n');
    return {output:plan,proposalSha256:hash,itemCount:items.length,sharedItemCount:sharedItems.length,
      rowCount:items.reduce((count,item)=>count+item.rowIds.length,0)};
  });
}

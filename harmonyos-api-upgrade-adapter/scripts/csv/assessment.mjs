import { readFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { inspectProjectGroups, readGroupResults, taskProject, checkSnapshot } from '../shared/platform/group-results.mjs';
import { activeDecision, equalData, expandAssessment, onlyKeys, strings, assessmentError, readAssessmentSource, checkResolution } from '../shared/platform/assessment-source.mjs';
import { ensureBatchDirectory } from '../shared/platform/artifact-layout.mjs';
import { atomicWrite, sha256 } from '../shared/io/fs-utils.mjs';

const digest = value => sha256(JSON.stringify(value));
import { samePath } from '../shared/platform/paths.mjs';
import { findSpecOption, readSpecSource, renderSpec } from '../shared/platform/spec-source.mjs';
import { jsonInput, exclusive, locked, unchanged } from './storage.mjs';
const counts = rows => rows.reduce((result,row)=>{result[row.category]=(result[row.category]??0)+1;return result;},{});
function requireUpgrade(options) { if (options.mode !== 'upgrade') throw new Error('评估接收与处理更新仅支持upgrade'); }
async function context(options) {
  requireUpgrade(options);
  const {result,state} = await inspectProjectGroups(options,options.groupId);
  const entry = state.records.find(entry=>(entry.value?.id ?? entry.reference.id ?? path.basename(entry.file,'.json')) === options.groupId);
  if (!entry || !result.group) throw new Error('分组未在当前工程唯一登记');
  return {options,state,entry,layout:state.participant.outputLayout,ids:result.rows.map(row=>row.rowId)};
}
async function saveGroup(ctx,value) {
  await ensureBatchDirectory(ctx.layout,path.dirname(ctx.entry.file));
  const bytes = JSON.stringify(value,null,2)+'\n'; await atomicWrite(ctx.entry.file,bytes);
  if (await readFile(ctx.entry.file,'utf8') !== bytes) throw new Error('分组回读不一致');
  return sha256(bytes);
}
function identity(ctx,input) {
  if (input.groupId !== ctx.options.groupId || input.sourceSha256 !== ctx.state.raw.sha256)
    throw assessmentError(ctx.entry.file,null,'身份','必须匹配当前工程分组和原始CSV');
  const snapshot = ctx.state.snapshots.find(snapshot=>snapshot.file === ctx.entry.file);
  if (input.groupSha256 !== snapshot.hash) throw assessmentError(ctx.entry.file,null,'分组哈希','分组已变化，请重新读取，不覆盖现有判断');
}

function currentApproval(ctx, id) {
  const repair = ctx.state.progress.value?.decisions?.repair;
  const item = repair?.approvedItems?.find(approval => approval?.id === id);
  if (!item || !activeDecision(item, repair) || item.groupId !== ctx.options.groupId
    || item.assessmentSha256 !== ctx.entry.value.assessmentSource?.sha256)
    throw new Error('缺少对应的当前批准方案');
  if (!['ACCEPT_NEW_BEHAVIOR', 'APPLY_APPROVED_CHANGE'].includes(item.action)) throw new Error('批准动作无效');
  return item;
}

function approvalOutcome(item) {
  return item.action === 'ACCEPT_NEW_BEHAVIOR' ? 'NO_CHANGE' : 'MODIFIED';
}

export async function draftResolution(options) {
  const ctx = await context(options);
  if (!ctx.entry.value.assessmentSource) throw new Error('处理草稿需要当前原始评估来源');
  if (!options.review && options.approvalId === undefined) throw new Error('处理草稿需要指定 --approval');
  const item = options.approvalId === undefined ? null : currentApproval(ctx, options.approvalId);
  const rowIds = options.rowIds ?? item?.rowIds ?? [];
  strings(rowIds, options.output, 'rowIds');
  const owned = new Set((ctx.entry.value.rowResults ?? []).map(row => row.rowId));
  if (!rowIds.length || new Set(rowIds).size !== rowIds.length || rowIds.some(id => !owned.has(id)))
    throw new Error('草稿需要明确的当前分组 rowId，范围含未知、跨组或重复身份');
  if (item && rowIds.some(id => !item.rowIds.includes(id))) throw new Error('草稿不能扩大批准集合');
  const groupSha256 = ctx.state.snapshots.find(snapshot => snapshot.file === ctx.entry.file).hash;
  const patch = { rowIds, next: null, resolution: { reason: '', evidence: [] } };
  if (options.review) patch.reviewOnly = true;
  else {
    patch.approvalId = item.id;
    patch.outcome = approvalOutcome(item);
    if (patch.outcome === 'MODIFIED') patch.changes = [];
  }
  const draft = { groupId: options.groupId, sourceSha256: ctx.state.raw.sha256, groupSha256, updates: [patch] };
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await unchanged(ctx.state, item ? [{ file: item.plan, hash: item.specSha256 }] : []);
  await exclusive(output, JSON.stringify(draft, null, 2) + '\n');
  return { output, groupId: options.groupId, rowCount: rowIds.length, groupSha256 };
}

export async function draftAssessment(options) {
  const ctx = await context(options), snapshot = ctx.state.snapshots.find(s=>s.file===ctx.entry.file);
  const draft = {schemaVersion:1,groupId:options.groupId,sourceSha256:ctx.state.raw.sha256,groupSha256:snapshot.hash,
    knowledge:{sources:[]},changeSummary:{before:'',after:'',targetIsolation:'',proposal:'',business:''},
    items:[{rowIds:ctx.ids,category:'待分类',outcome:'PENDING',reason:'',reportSummary:'',compatibility:'',evidence:[],changes:[],next:''}]};
  const output = path.resolve(options.output);
  // Exclusive output never replaces an input, including aliases and user-edited drafts.
  await mkdir(path.dirname(output),{recursive:true}); await unchanged(ctx.state);
  await exclusive(output,JSON.stringify(draft,null,2)+'\n');
  return {output,groupId:options.groupId,rowCount:ctx.ids.length,groupSha256:snapshot.hash};
}

export async function checkAssessment(options) {
  const ctx = await context(options), source = await jsonInput(options.input);
  const rows = expandAssessment(source.value, {groupId:options.groupId,sourceSha256:ctx.state.raw.sha256,rowIds:ctx.ids,file:options.input});
  identity(ctx, source.value);
  await unchanged(ctx.state, [source.snapshot]);
  return {validationScope:'STRUCTURE_ONLY',groupId:options.groupId,rowCount:rows.length,
    assessmentSha256:source.snapshot.hash,categoryCounts:counts(rows)};
}

export async function importAssessment(options, io={}) {
  const ctx = await context(options), source = await jsonInput(options.input), group = ctx.entry.value;
  const rows = expandAssessment(source.value,{groupId:options.groupId,sourceSha256:ctx.state.raw.sha256,rowIds:ctx.ids,file:options.input});
  const receipt = hash => ({groupId:options.groupId,rowCount:rows.length,assessmentSha256:source.snapshot.hash,
    groupSha256:hash,categoryCounts:counts(rows)});
  if (group.assessmentSource?.sha256 === source.snapshot.hash) return receipt(ctx.state.snapshots.find(s=>s.file===ctx.entry.file).hash);
  if (group.assessmentSource && !options.reassess) throw new Error('已有不同评估，必须显式重新评估 --reassess --reason，不能普通重导入');
  if (!group.assessmentSource && group.rowResults.some(row=>row.outcome!=='PENDING') && !options.reassess)
    throw new Error('旧记录已有判断但缺评估来源，必须显式重新评估，不能自动补造来源');
  if (options.reassess && !options.reason?.trim()) throw new Error('重新评估必须注明 --reason 并重新核对spec和批准');
  identity(ctx,source.value);
  return locked(ctx.layout,async()=>{
    await io.beforeWrite?.(); await unchanged(ctx.state,[source.snapshot]);
    const directory = path.join(ctx.layout.evidenceDirectory,'assessments'); await ensureBatchDirectory(ctx.layout,directory);
    const archived = path.join(directory,`assessment-${source.snapshot.hash}.json`); await exclusive(archived,source.bytes);
    const value = structuredClone(group);
    value.assessmentSource = {record:path.relative(ctx.layout.deliveryDirectory,archived),sha256:source.snapshot.hash};
    if (source.value.knowledge !== undefined) {
      if (!source.value.knowledge || typeof source.value.knowledge !== 'object' || Array.isArray(source.value.knowledge)) throw new Error('knowledge必须为对象');
      value.knowledge=structuredClone(source.value.knowledge);
    }
    if (source.value.changeSummary !== undefined) value.changeSummary=structuredClone(source.value.changeSummary);
    value.rowResults = rows.map(row=>{
      if (!options.reassess) return row;
      const previous=ctx.state.canonical.get(row.rowId);
      const modified=previous.outcome==='MODIFIED';
      // Reassessment retains real changes, but its presentation must be reviewed afresh.
      delete row.reportSummary;
      return {...row,...(modified ? {outcome:previous.outcome,changes:previous.changes} : {}),
        ...((previous.resolution ?? previous.previousResolution) ? {previousResolution:previous.resolution ?? previous.previousResolution} : {}),
        next:[...new Set([previous.next,row.next].filter(Boolean))].join('；')};
    });
    delete value.rowClassifications;
    if (options.reassess) { value.reviewRowIds=[...ctx.ids]; value.reassessmentReason=options.reason; }
    const original=await readAssessmentSource(ctx.layout,value,new Set(ctx.ids),ctx.state.raw.sha256);
    await unchanged(ctx.state,[source.snapshot,original.snapshot]);
    return receipt(await saveGroup(ctx,value));
  });
}

export async function recordApproval(options, io={}) {
  requireUpgrade(options);
  const {participant}=await taskProject(options), state=await readGroupResults(participant,'upgrade',{strict:true,allowPendingSpec:true});
  const source=await jsonInput(options.input), input=source.value, layout=participant.outputLayout;
  onlyKeys(input,['plan','answer','source','approvedItems','approvedItemIds','approvedSharedItems','declinedItems','declinedSharedItems'],options.input);
  for (const field of ['plan','answer','source']) if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error(`批准记录缺少实际${field}`);
  const hasItemIds = Object.hasOwn(input, 'approvedItemIds');
  if (hasItemIds && Object.hasOwn(input, 'approvedItems')) throw new Error('approvedItemIds 与 approvedItems 必须二选一');
  const approvedItemIds = hasItemIds ? input.approvedItemIds : [];
  strings(approvedItemIds, options.input, 'approvedItemIds');
  const explicitItems = input.approvedItems ?? [];
  if (!Array.isArray(explicitItems) || (!explicitItems.length && !approvedItemIds.length && !input.approvedSharedItems?.length && !input.declinedItems?.length && !input.declinedSharedItems?.length)) throw new Error('决定必须明确方案项和rowIds，空集合不表示全部批准');
  const plan=path.resolve(layout.deliveryDirectory,input.plan), planBytes=await readFile(plan), seen=new Set();
  const repair = state.progress.value.decisions?.repair ?? {};
  const spec = await readSpecSource(layout,repair,{allowPendingPublication:true});
  if (!spec || !samePath(await realpath(spec.source.plan),await realpath(plan))) throw new Error('新批准需要先用prepare-spec生成明确方案');
  const directory = path.join(layout.evidenceDirectory,'plans');
  const archived = path.join(directory,`approved-spec-${sha256(planBytes)}.md`);
  function approvalSource(item, proposed, previous) {
    if (!proposed || ['groupId','action','assessmentSha256'].some(key=>!equalData(item[key],proposed[key]))
      || item.rowIds && (item.rowIds.length!==proposed.rowIds.length || item.rowIds.some(id=>!proposed.rowIds.includes(id))))
      throw new Error(`批准范围或动作与方案明细不一致：${item.id}`);
    if (item.rowIds) item={...item,rowIds:proposed.rowIds};
    const prior = previous.find(old=>old?.id===item.id);
    if (prior) {
      if (prior.proposalSha256!==spec.source.sha256 || prior.answer!==input.answer || prior.source!==input.source
        || Object.keys(item).some(key=>!equalData(prior[key],item[key]))) throw new Error('已有方案项ID内容不同，不扩大旧批准');
      return prior;
    }
    return {...item,plan:archived,specSha256:sha256(planBytes),answer:input.answer,source:input.source,proposalSha256:spec.source.sha256};
  }
  const rowItemFields = ['id','groupId','rowIds','action','assessmentSha256'];
  const selectedItems = hasItemIds ? approvedItemIds.map(id => {
    const proposed = findSpecOption(spec.proposal,id)?.option;
    if (!proposed) throw new Error(`未知行方案项：${id}`);
    return Object.fromEntries(rowItemFields.map(key => [key, proposed[key]]));
  }) : explicitItems;
  const items=selectedItems.map(item=>{
    onlyKeys(item,rowItemFields,options.input);
    if (typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) throw new Error('批准方案项ID缺失或重复'); seen.add(item.id);
    strings(item.rowIds,options.input,'rowIds');
    const entry=state.records.find(entry=>entry.value?.id===item.groupId);
    if (!entry?.value.assessmentSource || item.assessmentSha256!==entry.value.assessmentSource.sha256) throw new Error('批准必须关联当前原始评估来源');
    const owned=new Set(entry.value.rowResults.map(row=>row.rowId));
    if (!item.rowIds.length || new Set(item.rowIds).size!==item.rowIds.length || item.rowIds.some(id=>!owned.has(id))) throw new Error('批准范围含未知、重复或跨组rowId');
    if (!['ACCEPT_NEW_BEHAVIOR','APPLY_APPROVED_CHANGE'].includes(item.action)) throw new Error('批准动作必须明确接受新行为或实施修改');
    for (const id of item.rowIds) {
      const category=state.canonical.get(id).category;
      if (item.action==='ACCEPT_NEW_BEHAVIOR' ? category!=='可选适配' : !['可选适配','必须适配'].includes(category))
        throw assessmentError(entry.file,id,'批准动作','不能将未触发/未评估行混入处理范围');
    }
    return approvalSource(item,findSpecOption(spec.proposal,item.id)?.option,repair.approvedItems ?? []);
  });
  strings(input.approvedSharedItems ?? [],options.input,'approvedSharedItems');
  const shared = (input.approvedSharedItems ?? []).map(id=>{
    if (seen.has(id)) throw new Error('批准方案项ID重复'); seen.add(id);
    const proposed=spec.proposal.sharedItems.find(item=>item.id===id);
    return approvalSource({id},proposed,repair.approvedSharedItems ?? []);
  });
  strings(input.declinedItems ?? [],options.input,'declinedItems');
  strings(input.declinedSharedItems ?? [],options.input,'declinedSharedItems');
  const decline = (id, shared) => {
    if (seen.has(id)) throw new Error('决定方案项ID重复'); seen.add(id);
    const rowOption = shared ? null : findSpecOption(spec.proposal,id);
    const proposed = shared ? spec.proposal.sharedItems.find(item=>item.id===id) : rowOption?.item;
    if (!proposed) throw new Error(`未知方案项：${id}`);
    if (proposed.id!==id) throw new Error(`不实施决定作用于整组，请使用方案项 ${proposed.id} 的 ID`);
    if (!shared) for (const rowId of proposed.rowIds) {
      const row=state.canonical.get(rowId);
      if (row.outcome==='MODIFIED' || row.changes.length) throw new Error('不实施决定不能撤销已实施修改');
      const entry=state.records.find(entry=>entry.value.id===proposed.groupId);
      if (entry?.value.assessmentSource?.sha256!==proposed.assessmentSha256) throw new Error('不实施决定需要当前评估来源');
    }
    const fields=shared ? {id} : Object.fromEntries(rowItemFields.map(key=>[key,proposed[key]]));
    return {...approvalSource(fields,proposed,shared ? repair.declinedSharedItems ?? [] : repair.declinedItems ?? []),decision:'NOT_IMPLEMENTED'};
  };
  const declinedItems=(input.declinedItems ?? []).map(id=>decline(id,false));
  const declinedSharedItems=(input.declinedSharedItems ?? []).map(id=>decline(id,true));
  const rowDecisions = [...items,...declinedItems];
  const previousRowDecisions = [...(repair.approvedItems ?? []),...(repair.declinedItems ?? [])];
  for (const scope of spec.proposal.items) {
    if (!scope.alternative) continue;
    const selected = rowDecisions.filter(item=>item.id===scope.id || item.id===scope.alternative.id);
    if (selected.length > 1) throw new Error(`方案项 ${scope.id} 与 ${scope.alternative.id} 互斥，同一组只登记一个决定`);
    const decision = selected[0];
    if (decision && previousRowDecisions.some(old=>old.id!==decision.id && activeDecision(old,repair)
      && old.assessmentSha256===decision.assessmentSha256 && old.rowIds.some(id=>decision.rowIds.includes(id))))
      throw new Error(`互斥方案项 ${scope.id} 已有有效决定，请生成新版本并重新确认`);
  }
  for (const item of [...items,...shared,...declinedItems,...declinedSharedItems]) {
    const opposite=item.decision ? [...(repair.approvedItems ?? []),...(repair.approvedSharedItems ?? [])] : [...(repair.declinedItems ?? []),...(repair.declinedSharedItems ?? [])];
    if (opposite.some(old=>old.id===item.id && activeDecision(old,repair))) throw new Error('方案项已有相反决定，请使用新方案ID明确改变决定');
  }
  return locked(layout,async()=>{
    await io.beforeWrite?.(); await unchanged(state,[source.snapshot,{file:plan,hash:sha256(planBytes)}]);
    await ensureBatchDirectory(layout,directory); await exclusive(archived,planBytes);
    const progress=structuredClone(state.progress.value), approved=[...(repair.approvedItems ?? [])];
    for (const item of items) {
      const prior=approved.find(old=>old?.id===item.id);
      if (prior && !equalData(prior,item)) throw new Error('已有方案项ID内容不同，重新确认后使用新的批准ID，不扩大旧批准');
      if (!prior) approved.push(item);
    }
    const approvedSharedItems=[...(repair.approvedSharedItems ?? [])];
    for (const item of shared) if (!approvedSharedItems.some(old=>old.id===item.id)) approvedSharedItems.push(item);
    const merge=(old,next)=>[...(old ?? []),...next.filter(item=>!(old ?? []).some(prior=>prior.id===item.id))];
    progress.decisions={...progress.decisions,repair:{...repair,plan,answer:input.answer,source:input.source,approvedItems:approved,approvedSharedItems,
      declinedItems:merge(repair.declinedItems,declinedItems),declinedSharedItems:merge(repair.declinedSharedItems,declinedSharedItems)}};
    await atomicWrite(layout.progressPath,JSON.stringify(progress,null,2)+'\n');
    await io.afterProgress?.();
    for (const entry of state.records) {
      const selected=declinedItems.filter(item=>item.groupId===entry.value.id);
      if (!selected.length) continue;
      await checkSnapshot(state.snapshots.find(snapshot=>snapshot.file===entry.file));
      const group=structuredClone(entry.value);
      for (const item of selected) for (const row of group.rowResults.filter(row=>item.rowIds.includes(row.rowId))) {
        delete row.reportSummary;
        row.outcome='NOT_IMPLEMENTED'; row.next='';
        row.resolution={reason:`用户选择不实施：${item.answer}`,evidence:[item.source],approvalId:item.id,
          approvalSha256:digest(item),assessmentSha256:item.assessmentSha256};
      }
      await atomicWrite(entry.file,JSON.stringify(group,null,2)+'\n');
    }
    await checkSnapshot({file:plan,hash:sha256(planBytes)});
    await atomicWrite(plan,renderSpec(spec.proposal,progress.decisions.repair,spec.source.sha256));
    await readSpecSource(layout,progress.decisions.repair);
    return {projectKey:participant.projectKey,approvedItems:items.length,approvedSharedItems:shared.length,declinedItems:declinedItems.length,declinedSharedItems:declinedSharedItems.length,
      rowCount:[...items,...declinedItems].reduce((n,item)=>n+item.rowIds.length,0),plan};
  });
}

export async function updateResolution(options, io={}) {
  const ctx=await context(options), source=await jsonInput(options.input), input=source.value;
  onlyKeys(input,['groupId','sourceSha256','groupSha256','updates','summaryOnly','business'],options.input); identity(ctx,input);
  if (input.summaryOnly !== undefined && typeof input.summaryOnly !== 'boolean') throw new Error('summaryOnly必须为boolean');
  if (input.summaryOnly === true) {
    if (!Array.isArray(input.updates) || (!input.updates.length && input.business === undefined)) throw new Error('简述更新需要明确updates或business');
    if (input.business !== undefined && typeof input.business !== 'string') throw new Error('business必须为字符串');
    const value=structuredClone(ctx.entry.value), rows=new Map((value.rowResults ?? []).map(row=>[row.rowId,row])), seen=new Set();
    for (const patch of input.updates) {
      onlyKeys(patch,['rowIds','reportSummary'],options.input);
      strings(patch.rowIds,options.input,'rowIds');
      if (!patch.rowIds.length || typeof patch.reportSummary !== 'string') throw new Error('简述更新需要非空rowIds和字符串reportSummary');
      for (const id of patch.rowIds) {
        if (!rows.has(id) || !ctx.ids.includes(id) || seen.has(id)) throw assessmentError(ctx.entry.file,id,'范围','未知、跨组或重复rowId');
        seen.add(id); rows.get(id).reportSummary=patch.reportSummary;
      }
    }
    if (input.business !== undefined) value.changeSummary={...value.changeSummary,business:input.business};
    return locked(ctx.layout,async()=>{
      await io.beforeWrite?.(); await unchanged(ctx.state,[source.snapshot]);
      return {groupId:options.groupId,updatedRows:seen.size,summaryOnly:true,groupSha256:await saveGroup(ctx,value)};
    });
  }
  if (input.business !== undefined) throw new Error('business仅允许在summaryOnly更新');
  if (!ctx.entry.value.assessmentSource || !Array.isArray(input.updates)) throw new Error('处理更新必须有当前原始评估和明确updates');
  const value=structuredClone(ctx.entry.value), rows=new Map(value.rowResults.map(row=>[row.rowId,row])), seen=new Set(), extra=[];
  for (const patch of input.updates) {
    onlyKeys(patch,['rowIds','approvalId','outcome','changes','next','resolution','verificationOnly','reviewOnly','reportSummary'],options.input);
    if (patch.reportSummary !== undefined && typeof patch.reportSummary !== 'string') throw new Error('reportSummary必须为字符串');
    if (patch.verificationOnly!==undefined && typeof patch.verificationOnly!=='boolean') throw new Error('verificationOnly必须为boolean');
    if (patch.reviewOnly!==undefined && typeof patch.reviewOnly!=='boolean') throw new Error('reviewOnly必须为boolean');
    if (patch.reviewOnly && patch.verificationOnly) throw new Error('reviewOnly和verificationOnly不能同时使用');
    const reviewOnly = patch.reviewOnly === true || patch.verificationOnly === true;
    strings(patch.rowIds,options.input,'rowIds'); if (!patch.rowIds.length) throw new Error('处理范围不能为空');
    onlyKeys(patch.resolution,['reason','evidence'],options.input);
    if (typeof patch.resolution.reason!=='string' || !patch.resolution.reason.trim()) throw new Error('需要实际处理/验证说明');
    strings(patch.resolution.evidence,options.input,'resolution.evidence');
    if (patch.next!==undefined && typeof patch.next!=='string') throw new Error('next必须为字符串，省略时保留');
    if (patch.changes!==undefined) strings(patch.changes,options.input,'changes');
    if (patch.reviewOnly && (typeof patch.next !== 'string' || !patch.resolution.evidence.some(value=>value.trim())))
      throw new Error('复核更新必须明确next和实际复核证据');
    if (reviewOnly) {
      if (patch.outcome!==undefined || patch.changes!==undefined || patch.approvalId!==undefined) throw new Error('复核或验证更新不能修改处理状态或实际差异');
    }
    const item = reviewOnly ? null : currentApproval(ctx, patch.approvalId);
    if (item) { const bytes=await readFile(item.plan); if (sha256(bytes)!==item.specSha256) throw new Error('批准spec已变化'); extra.push({file:item.plan,hash:item.specSha256}); }
    for (const id of patch.rowIds) {
      const row=rows.get(id);
      if (!row || seen.has(id)) throw assessmentError(ctx.entry.file,id,'范围','未知或重复rowId'); seen.add(id);
      if (!reviewOnly) {
        if (!item.rowIds.includes(id)) throw assessmentError(ctx.entry.file,id,'批准范围','不能扩大批准集合');
        const expected = approvalOutcome(item);
        if (patch.outcome!==expected || row.outcome==='MODIFIED' && expected==='NO_CHANGE') throw new Error('处理状态与获批动作不一致，不自动撤销已实施修改');
        const changes=patch.changes ?? row.changes;
        if (expected==='NO_CHANGE' && changes.length) throw new Error('接受新行为不能记录未获批准的实际差异');
        if (expected==='MODIFIED' && !changes.some(text=>text.trim())) throw new Error('MODIFIED必须有本行实际差异');
        delete row.reportSummary;
        row.outcome=patch.outcome; if (patch.changes!==undefined) row.changes=structuredClone(patch.changes);
        row.resolution={...row.resolution,...patch.resolution,approvalId:item.id,approvalSha256:digest(item),assessmentSha256:value.assessmentSource.sha256};
      } else row.resolution={...row.resolution,[patch.reviewOnly ? 'review' : 'verification']:{...patch.resolution,assessmentSha256:value.assessmentSource.sha256}};
      if (patch.next!==undefined) row.next=patch.next;
      if (patch.reportSummary!==undefined) row.reportSummary=patch.reportSummary;
    }
  }
  value.reviewRowIds=(value.reviewRowIds ?? []).filter(id=>!seen.has(id) || rows.get(id).outcome==='MODIFIED' && !rows.get(id).resolution?.approvalId);
  return locked(ctx.layout,async()=>{
    await io.beforeWrite?.(); await unchanged(ctx.state,[source.snapshot,...extra]);
    const original=await readAssessmentSource(ctx.layout,value,new Set(ctx.ids),ctx.state.raw.sha256), specCache=new Map();
    for (const row of value.rowResults) await checkResolution(row,original.rows.get(row.rowId),value,ctx.state.progress.value,ctx.entry.file,specCache);
    await unchanged(ctx.state,[source.snapshot,...extra]);
    return {groupId:options.groupId,updatedRows:seen.size,groupSha256:await saveGroup(ctx,value)};
  });
}

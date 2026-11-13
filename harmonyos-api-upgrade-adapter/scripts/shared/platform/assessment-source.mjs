import { readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../io/fs-utils.mjs';
import { relativePathInside } from './paths.mjs';

export const assessmentCategories = ['必须适配', '可选适配', '无需适配', '待分类', '范围外'];
export const resultOutcomes = ['PENDING', 'MODIFIED', 'NO_CHANGE', 'DECISION_REQUIRED', 'EVIDENCE_GAP', 'OUT_OF_SCOPE', 'NOT_IMPLEMENTED'];
export const assessmentFields = ['category', 'reason', 'compatibility', 'evidence'];
export const equalData = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export const activeDecision = (item, repair) => !(repair?.supersededItems ?? []).includes(item.id);
export function changeSummary(value, file) {
  onlyKeys(value, ['before','after','targetIsolation','keyDecision','proposal','business'], file);
  for (const [key, text] of Object.entries(value)) if (typeof text !== 'string')
    throw assessmentError(file,null,`changeSummary/${key}`,'需要字符串');
  return value;
}
export function assessmentError(file, rowId, field, message) {
  return Object.assign(new Error(`${file}；rowId=${rowId ?? '—'}；${field}：${message}`), {code:'ASSESSMENT_INVALID',details:{file,rowId,field,jsonPath:`/${field}`}});
}
export function onlyKeys(value, keys, file, rowId=null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw assessmentError(file,rowId,'结构','需要对象');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw assessmentError(file,rowId,key,`字段不允许在当前操作中修改；本操作可用字段：${keys.join('、')}`);
}
export function strings(value, file, field, rowId=null) {
  if (!Array.isArray(value) || value.some(item=>typeof item !== 'string')) throw assessmentError(file,rowId,field,'需要字符串数组');
}
export function expandAssessment(input, { groupId, sourceSha256, rowIds, file }) {
  onlyKeys(input,['schemaVersion','groupId','sourceSha256','groupSha256','items','knowledge','changeSummary'],file);
  if (input.changeSummary !== undefined) changeSummary(input.changeSummary,file);
  if (input.schemaVersion !== 1 || input.groupId !== groupId || input.sourceSha256 !== sourceSha256
    || !/^[a-f0-9]{64}$/.test(input.groupSha256)) throw assessmentError(file,null,'评估身份/哈希','必须匹配当前工程、分组和原始CSV');
  if (!Array.isArray(input.items)) throw assessmentError(file,null,'items','需要明确rowId集合');
  if (input.knowledge !== undefined) {
    const knowledge = input.knowledge;
    if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge))
      throw assessmentError(file,null,'knowledge','需要顶层对象；多个来源放入knowledge.sources数组');
    if (knowledge.sources !== undefined && (!Array.isArray(knowledge.sources)
      || knowledge.sources.some(source=>!source || typeof source!=='object' || Array.isArray(source))))
      throw assessmentError(file,null,'knowledge/sources','需要对象数组，完整保留多个来源');
  }
  const expected = new Set(rowIds), rows = new Map();
  for (const [index, item] of input.items.entries()) {
    try {
      onlyKeys(item,['rowIds',...assessmentFields,'outcome','changes','next','reportSummary'],file);
      strings(item.rowIds,file,'rowIds');
      if (!item.rowIds.length) throw assessmentError(file,null,'rowIds','集合不能为空');
      const first = item.rowIds[0];
      if (!assessmentCategories.includes(item.category)) throw assessmentError(file,first,'category',assessmentCategories.join('/'));
      if (!resultOutcomes.includes(item.outcome) || ['MODIFIED','NOT_IMPLEMENTED'].includes(item.outcome)) throw assessmentError(file,first,'outcome','只读评估不能代替实施或用户决定');
      if (item.outcome === 'NO_CHANGE' && ['必须适配','可选适配','待分类'].includes(item.category))
        throw assessmentError(file,first,'outcome','本分类不能在只读评估中直接关闭，需明确用户决定');
      for (const key of ['reason','compatibility','next']) if (typeof item[key] !== 'string') throw assessmentError(file,first,key,'需要字符串');
      if (item.reportSummary !== undefined && typeof item.reportSummary !== 'string') throw assessmentError(file,first,'reportSummary','需要字符串');
      if (item.outcome !== 'PENDING' && !item.reason.trim()) throw assessmentError(file,first,'reason','需要具体评估理由或缺口');
      strings(item.evidence,file,'evidence',first); strings(item.changes,file,'changes',first);
      if (item.changes.length) throw assessmentError(file,first,'changes','评估阶段不填写实际修改');
      for (const rowId of item.rowIds) {
        if (!expected.has(rowId) || rows.has(rowId)) throw assessmentError(file,rowId,'rowId','未知、跨组或重复身份');
        const {rowIds:ignored,...fields} = item;
        rows.set(rowId,{rowId,...structuredClone(fields)});
      }
    } catch (error) {
      if (error.details) error.details.jsonPath = `/items/${index}${error.details.jsonPath}`;
      throw error;
    }
  }
  for (const rowId of rowIds) if (!rows.has(rowId)) throw assessmentError(file,rowId,'覆盖','缺少明确评估，不允许用默认值补齐');
  return rowIds.map(rowId=>rows.get(rowId));
}

export async function readAssessmentSource(layout, group, owner, sourceSha256) {
  const source = group.assessmentSource;
  if (!source || typeof source.record!=='string' || !/^[a-f0-9]{64}$/.test(source.sha256)) throw assessmentError(group.id,null,'评估来源','缺少有效路径和哈希');
  const file = path.resolve(layout.deliveryDirectory,source.record);
  if (relativePathInside(layout.deliveryDirectory,file) === null) throw assessmentError(file,null,'来源路径','越界');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || relativePathInside(await realpath(layout.deliveryDirectory),await realpath(file)) === null)
    throw assessmentError(file,null,'来源路径','必须是本工程内的普通文件');
  const bytes = await readFile(file), hash = sha256(bytes);
  if (hash !== source.sha256) throw assessmentError(file,null,'评估来源哈希','来源已变化');
  const input=JSON.parse(bytes.toString('utf8').replace(/^\ufeff/,''));
  const rows = expandAssessment(input, {groupId:group.id,sourceSha256,rowIds:[...owner],file});
  // Business prose is editable presentation; the original behavior and proposal remain protected.
  const behavior = summary => Object.fromEntries(Object.entries(summary ?? {}).filter(([key]) => key !== 'business'));
  if (input.changeSummary!==undefined && !equalData(behavior(group.changeSummary),behavior(input.changeSummary))) throw assessmentError(file,null,'changeSummary','与原始评估不一致');
  return { rows:new Map(rows.map(row=>[row.rowId,row])), snapshot:{file,hash} };
}

export async function checkResolution(row, original, group, progress, file, specCache=new Map()) {
  const resolution = row.resolution;
  if (group.reviewRowIds?.includes(row.rowId)) return;
  const processingChanged = row.outcome !== original.outcome || !equalData(row.changes,original.changes);
  if (processingChanged && !resolution?.approvalId) throw assessmentError(file,row.rowId,'resolution','处理状态变更缺少获批决定');
  if (!resolution) return;
  for (const kind of ['review','verification']) {
    const update = resolution[kind];
    if (!update) continue;
    if (typeof update.reason !== 'string' || !update.reason.trim() || update.assessmentSha256 !== group.assessmentSource.sha256)
      throw assessmentError(file,row.rowId,`resolution.${kind}`,'验证说明或评估来源不匹配');
    strings(update.evidence,file,`resolution.${kind}.evidence`,row.rowId);
  }
  if (!resolution.approvalId) return;
  const repair = progress?.decisions?.repair;
  const item = [...(repair?.approvedItems ?? []),...(repair?.declinedItems ?? [])].find(item=>item && item.id === resolution.approvalId);
  if (!item || !Array.isArray(item.rowIds) || !item.rowIds.includes(row.rowId) || item.groupId !== group.id
    || item.assessmentSha256 !== group.assessmentSource.sha256 || resolution.assessmentSha256 !== group.assessmentSource.sha256
    || sha256(JSON.stringify(item)) !== resolution.approvalSha256)
    throw assessmentError(file,row.rowId,'批准范围/来源','当前决定不匹配已批准方案');
  if (!['ACCEPT_NEW_BEHAVIOR','APPLY_APPROVED_CHANGE'].includes(item.action) || !item.answer?.trim() || !item.source?.trim())
    throw assessmentError(file,row.rowId,'批准记录','缺少明确动作和真实答复来源');
  if (!specCache.has(item.plan)) specCache.set(item.plan,{file:item.plan,hash:sha256(await readFile(item.plan))});
  const spec=specCache.get(item.plan);
  if (spec.hash !== item.specSha256) throw assessmentError(file,row.rowId,'批准方案','spec已变化，需要重新核对');
  if (typeof resolution.reason !== 'string' || !resolution.reason.trim()) throw assessmentError(file,row.rowId,'resolution.reason','需要处理说明');
  strings(resolution.evidence,file,'resolution.evidence',row.rowId);
  if (item.decision === 'NOT_IMPLEMENTED' ? row.outcome !== 'NOT_IMPLEMENTED' || row.changes.length
    : item.action === 'ACCEPT_NEW_BEHAVIOR' && (row.category !== '可选适配' || row.outcome !== 'NO_CHANGE')
      || item.action === 'APPLY_APPROVED_CHANGE' && (!['可选适配','必须适配'].includes(row.category) || row.outcome !== 'MODIFIED'))
    throw assessmentError(file,row.rowId,'resolution/outcome','处理动作、评估分类与状态不一致');
  return spec;
}

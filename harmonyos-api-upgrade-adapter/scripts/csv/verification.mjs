import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { taskProject, readGroupResults, updateProgress } from '../shared/platform/group-results.mjs';
import { readVerification, verificationBasis } from '../shared/platform/task-view.mjs';
import { onlyKeys, strings } from '../shared/platform/assessment-source.mjs';
import { sha256 } from '../shared/io/fs-utils.mjs';
import { jsonInput, locked, unchanged } from './storage.mjs';

export async function recordVerification(options) {
  const {participant}=await taskProject(options), layout=participant.outputLayout;
  const state=await readGroupResults(participant,options.mode,{strict:true});
  const source=options.value ? {value:options.value,snapshot:null} : await jsonInput(options.input), input=source.value;
  onlyKeys(input,['kind','record','sourceId','rowIds','name','details'],options.input);
  if (typeof input.record!=='string' || !input.record.trim()) throw new Error('验证引用缺少 record 路径');
  strings(input.rowIds,options.input,'rowIds');
  if (new Set(input.rowIds).size!==input.rowIds.length || input.rowIds.some(id=>!state.canonical.has(id))) throw new Error('验证范围含未知或重复行');
  for (const key of ['name','details']) if(input[key]!==undefined && typeof input[key]!=='string') throw new Error(`${key}必须为字符串`);
  if (input.rowIds.some(id=>state.canonical.get(id).outcome==='NOT_IMPLEMENTED')) throw new Error('不实施行不安排修复验收');
  const reference={...input,record:path.resolve(layout.deliveryDirectory,input.record),basisSha256:verificationBasis(state,input.rowIds)};
  const actual=await readVerification(state,reference);
  reference.sha256=actual.snapshots[0].hash; reference.files=actual.snapshots.slice(1);
  reference.inputs=[];
  const files=new Set(state.inspected.rows.filter(row=>input.rowIds.includes(row.rowId)).map(row=>row.physicalFile).filter(Boolean));
  files.add(path.join(participant.projectRoot,'build-profile.json5'));
  for (const file of files) reference.inputs.push({file,hash:sha256(await readFile(file))});
  return locked(layout,async()=>{
    await unchanged(state,[source.snapshot,...actual.snapshots,...reference.inputs].filter(Boolean));
    const previous=state.progress.value.verificationSources ?? [];
    const references=previous.filter(old=>!(old.kind===reference.kind && old.sourceId===reference.sourceId
      && JSON.stringify(old.rowIds)===JSON.stringify(reference.rowIds)));
    await updateProgress(state.progress,{...state.progress.value,verificationSources:[...references,reference]});
    return {kind:reference.kind,status:actual.status,rowCount:input.rowIds.length,record:reference.record};
  });
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readGroupResults, projectedResults } from './group-results.mjs';
import { activeDecision } from './assessment-source.mjs';
import { sha256 } from '../io/fs-utils.mjs';
import { readRuleGapReviews } from './rule-gap-reviews.mjs';
import { readRnohReviews } from './rnoh-reviews.mjs';
import { readScanReportEvidence } from './scan-report-evidence.mjs';

export function verificationBasis(state, rowIds) {
  return sha256(JSON.stringify(rowIds.map(id=>{
    const row=state.canonical.get(id);
    return [id,row.category,row.outcome,row.changes,row.resolution?.approvalId];
  })));
}

export async function readVerification(state, reference) {
  const layout=state.participant.outputLayout;
  const file=path.resolve(layout.deliveryDirectory,reference.record), bytes=await readFile(file);
  const value=JSON.parse(bytes.toString('utf8').replace(/^\ufeff/,''));
  const snapshots=[{file,hash:sha256(bytes)}], evidence=[file];
  let status, screenshots=null;
  if (reference.kind==='build') {
    const passed=stage=>stage?.status==='SUCCEEDED' && stage.exitCode===0 && !stage.error && !stage.signal && !stage.timedOut;
    status=value.status==='BUILD_SUCCEEDED' && passed(value.install) && passed(value.build) ? 'PASS'
      : ['INSTALL_FAILED','BUILD_FAILED'].includes(value.status) ? 'FAIL' : 'UNVERIFIED';
    for (const stage of [value.install,value.build].filter(Boolean)) for (const stream of ['stdout','stderr']) {
      if (typeof stage[stream]!=='string') { status='UNVERIFIED'; continue; }
      const log=path.resolve(path.dirname(file),stage[stream]);
      snapshots.push({file:log,hash:sha256(await readFile(log))}); evidence.push(log);
    }
  } else if (reference.kind==='runtime') {
    const source=value.sources?.find(source=>source.sourceId===reference.sourceId);
    if (!source || source.sha256!==state.raw.sha256) throw new Error('runtime 审计来源与当前原始扫描不一致');
    const rows=(value.rows ?? []).filter(row=>row.sourceId===reference.sourceId && reference.rowIds.includes(row.rowId));
    const complete=rows.length>0 && rows.length===reference.rowIds.length && rows.every(row=>row.coverage==='COMPLETE');
    status=rows.some(row=>row.after?.functional==='FAIL' || row.after?.visual==='FAIL') ? 'FAIL'
      : complete && !value.problems?.length && rows.every(row=>['functional','visual'].every(key=>['PASS','NOT_REQUIRED'].includes(row.after?.[key]))
        && ['functional','visual'].some(key=>row.after?.[key]==='PASS') && (value.mode!=='COMPARE' || row.compared)) ? 'PASS' : 'UNVERIFIED';
    const index=path.join(path.dirname(file),'screenshots-by-source.json');
    const imageBytes=await readFile(index); snapshots.push({file:index,hash:sha256(imageBytes)});
    const byRow=JSON.parse(imageBytes.toString('utf8'))[reference.sourceId] ?? {};
    screenshots=Object.fromEntries(reference.rowIds.filter(id=>Object.hasOwn(byRow,id)).map(id=>[id,byRow[id]]));
    for (const row of rows) for (const phase of ['before','after']) for (const capture of row[phase]?.screenshots ?? []) {
      for (const key of ['screenshot','layoutTree']) if (capture[key]) {
        const target=path.resolve(path.dirname(file),capture[key]);
        snapshots.push({file:target,hash:sha256(await readFile(target))});
      }
    }
  } else throw new Error('验证引用 kind 必须为 build 或 runtime');
  if (reference.sha256 && reference.sha256!==snapshots[0].hash) throw new Error(`验证证据已变化：${file}`);
  for (const snapshot of reference.files ?? []) {
    if (sha256(await readFile(snapshot.file))!==snapshot.hash) throw new Error(`验证证据已变化：${snapshot.file}`);
  }
  let stale=reference.basisSha256 && reference.basisSha256!==verificationBasis(state,reference.rowIds);
  for (const snapshot of reference.inputs ?? []) {
    let hash=null; try { hash=sha256(await readFile(snapshot.file)); } catch (error) { if(error.code!=='ENOENT') throw error; }
    if (hash!==snapshot.hash) stale=true;
    snapshots.push({file:snapshot.file,hash});
  }
  return {status:stale?'STALE':status,snapshots,evidence,screenshots:stale?null:screenshots};
}

export async function readTaskView(participant, mode, settings={}) {
  const state=await readGroupResults(participant,mode,settings);
  const scanEvidence = await readScanReportEvidence(state);
  state.gaps.push(...scanEvidence.gaps.map(gap => gap.summary));
  state.snapshots.push(...scanEvidence.snapshots);
  const projected=projectedResults(state,{partial:!settings.strict}), rows=new Map(projected.map(row=>[row.rowId,row]));
  const progress=state.progress.value ?? {}, versions=progress.versions ?? {}, verification=[], verificationPendingIds=new Set();
  let screenshots;
  for (const reference of progress.verificationSources ?? []) {
    if (!Array.isArray(reference.rowIds) || new Set(reference.rowIds).size!==reference.rowIds.length
      || reference.rowIds.some(id=>!state.canonical.has(id))) throw new Error('验证引用包含未知或重复 rowId');
    try {
      const actual=await readVerification(state,reference);
      state.snapshots.push(...actual.snapshots);
      verification.push({name:reference.name ?? (reference.kind==='build'?'编译构建':'设备运行'),status:actual.status,
        details:reference.details ?? '',evidence:actual.evidence});
      if (actual.status!=='PASS') state.gaps.push(`${reference.kind} 验证 ${actual.status}：${reference.record}`);
      if (actual.screenshots) screenshots={...(screenshots ?? {}),...actual.screenshots};
      for (const id of reference.rowIds) {
        const row=rows.get(id);
        row['处理说明']+=`\n验证说明：${reference.name ?? reference.kind} ${actual.status}${reference.details ? `；${reference.details}` : ''}`;
        if (actual.status!=='PASS' && row['处理结论']!=='未实施') {
          verificationPendingIds.add(id);
          row['后续事项']=[row['后续事项'],`${reference.kind} 验证${actual.status==='STALE'?'已过期，需重新执行':'未通过或证据不足'}`].filter(Boolean).join('；');
        }
      }
    } catch (error) {
      // Missing/changed evidence is a visible gap, never an inherited PASS.
      state.gaps.push(error.message);
      for (const target of [path.resolve(participant.outputLayout.deliveryDirectory,reference.record),...(reference.files ?? []).map(item=>item.file)]) {
        try { state.snapshots.push({file:target,hash:sha256(await readFile(target))}); }
        catch (failure) { if (failure.code!=='ENOENT') throw failure; state.snapshots.push({file:target,hash:null}); }
      }
      verification.push({name:reference.name ?? reference.kind,status:'UNVERIFIED',details:error.message,evidence:[]});
      for (const id of reference.rowIds) if(rows.get(id)['处理结论']!=='未实施') {
        verificationPendingIds.add(id);
        rows.get(id)['后续事项']=[rows.get(id)['后续事项'],'验证证据缺失或变化，需补齐'].filter(Boolean).join('；');
      }
    }
  }
  if (!verification.length) verification.push({name:'编译构建 / 设备运行',status:'NOT_RUN',details:'没有当前验证证据；不表示验证通过',evidence:[]});
  const repair=progress.decisions?.repair ?? {};
  const ruleGaps=mode==='upgrade'?await readRuleGapReviews(state.scanMetadata,progress):null;
  if (ruleGaps) { state.gaps.push(...ruleGaps.gaps); state.snapshots.push(...ruleGaps.snapshots); }
  // RNOH 工程的 U04a 结论没有 rowId，单独登记；未登记完的数量计入遗留事项。非 RNOH 工程为 null。
  const rnohReviews=mode==='upgrade'?readRnohReviews(state.scanMetadata,progress):null;
  if (rnohReviews) state.gaps.push(...rnohReviews.gaps);
  const changes=state.inspected.groups.map(group=>{
    const record=state.records.find(entry=>entry.value?.rowResults?.some(row=>group.rowIds.includes(row.rowId)));
    const summary=record?.value?.changeSummary ?? {};
    return {identity:group.identity,ruleId:group.ruleId,version:group.version,rowIds:group.rowIds,...summary,
      business:mode==='upgrade' ? summary.business : group.rowIds.map(id=>state.canonical.get(id)?.reason).filter(Boolean).join('\n'),
      compatibility:[...new Set(group.rowIds.map(id=>state.canonical.get(id)?.compatibility).filter(Boolean))].join('\n'),
      gaps:group.rowIds.map(id=>rows.get(id)?.['后续事项']).filter(Boolean).join('\n')};
  });
  const noImplementation=[...(repair.declinedItems ?? []),...(repair.declinedSharedItems ?? [])].some(item=>activeDecision(item,repair))
    && ![...(repair.approvedItems ?? []),...(repair.approvedSharedItems ?? [])].some(item=>activeDecision(item,repair));
  const data={projectKey:participant.projectKey,configuration:{oldTarget:versions.oldTarget ?? '',target:versions.target ?? '',compatible:versions.compatible ?? '',
    implementation:progress.configurationImplementation ?? (noImplementation?'用户选择不实施，源码与配置保持原状':mode==='upgrade'?'':'未登记配置实施事实')},changes,verification,nextSteps:[]};
  const pendingIds=new Set(projected.filter(row=>row['后续事项'].trim() || row['处理结论']==='待决策').map(row=>row.rowId));
  for (const row of state.canonical.values()) if(row.category==='待分类' || row.decisionOutdated) pendingIds.add(row.rowId);
  for (const id of state.reviewRowIds) pendingIds.add(id);
  state.pendingCount=pendingIds.size;
  state.pendingCounts.nextCount=[...state.canonical.values()].filter(row=>row.next.trim() || verificationPendingIds.has(row.rowId)).length;
  return {...state,projectedRows:projected,screenshots,reportData:data,verificationPendingIds,ruleGaps,rnohReviews,scanEvidence};
}

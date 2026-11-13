import { caseSnapshot } from './fixtures/runtime/plan.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main as csv } from '../../csv/cli.mjs';
import { initTask, importTaskCsv } from '../platform/task-context.mjs';
import { UPGRADE_HEADERS, stringifyCsv, parseCsv } from '../format/csv.mjs';
import { singleLineUpgradeDescription } from '../format/upgrade-results.mjs';
import { sha256 } from '../io/fs-utils.mjs';
import { prepareReport } from '../../report/prepare.mjs';
import { renderReport } from '../../report/render.mjs';
import { importAssessment, recordApproval } from '../../csv/assessment.mjs';
import { withReceiptOutput } from '../../csv/storage.mjs';
import { main as reportCli } from '../../report/cli.mjs';
import { readTaskView } from '../platform/task-view.mjs';
import { taskProject } from '../platform/group-results.mjs';
import { renderSpec } from '../platform/spec-source.mjs';
import { fixture as runtimePlan } from './fixtures/runtime/plan.mjs';
import { createSource } from '../../runtime/contracts.mjs';
import { freezeRun } from '../../runtime/runs.mjs';
import { taskForOutput, writeTaskRuntimeCsv } from '../../runtime/task-csv.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t, { legacy = false, rowCount = 116, toastCount = 14, task: jointTask, projectName = 'app' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), '评估接收 中文 &-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const project = path.join(root, projectName);
  await mkdir(path.join(project, 'entry', 'src', 'main'), {recursive:true});
  await writeFile(path.join(project,'build-profile.json5'), '{modules:[{name:"entry",srcPath:"entry"}]}');
  await writeFile(path.join(project,'entry','src','main','module.json5'), '{module:{type:"entry"}}');
  await writeFile(path.join(project,'entry','src','A.ets'), 'source');
  const toastEnd = 101 + toastCount;
  const rows = Array.from({length:rowCount}, (_,i) => ({
    'Rule ID':'CHM', 'Changed in SDK':'26.0.0(26) Beta1', Title:'材质变化',
    'Api Definition':i < 101 ? 'Text("a,b")' : i < toastEnd ? 'showToast({message:"a,b"})' : 'openCustomDialog()',
    'Code Location':`entry/src/A.ets:${i < 101 ? i+1 : i < toastEnd ? 201+(i-101)%(toastCount-2) : 300}`,
  }));
  const headers = [...UPGRADE_HEADERS];
  if (legacy) headers.splice(headers.indexOf('Code Location') + 1, 0, 'Fixed');
  const input = path.join(root,'input.csv'); await writeFile(input,stringifyCsv(headers,rows));
  const task = jointTask ?? await initTask(root,{projects:[project]});
  const {outputLayout:layout} = await importTaskCsv(task.taskFile,{projectPath:project,mode:'upgrade',inputCsv:input});
  const args = ['--task',task.taskFile,'--project',project,'--mode','upgrade'];
  const prepared = await csv(['prepare',...args]);
  if (!prepared.groups.length) return {root,project,task,layout,args,ids:[],draft:{items:[]}};
  const groupId = prepared.groups[0].id, groupFile = path.join(layout.deliveryDirectory,prepared.groups[0].record);
  const draftFile = path.join(root,'assessment.json');
  await csv(['draft-assessment',...args,'--group',groupId,'--output',draftFile]);
  const draft = await json(draftFile), ids = draft.items[0].rowIds;
  const value = (rowIds,category,outcome,reason) => ({rowIds,category,outcome,reason,compatibility:'target26',evidence:['源码和官方章节已读'],changes:[],next:''});
  draft.items = [value(ids.slice(0,101),'无需适配','NO_CHANGE','普通Text未启用选择菜单'),
    value(ids.slice(101,toastEnd),'可选适配','DECISION_REQUIRED','Toast无背景覆盖，新材质有视觉变化，\n保留原体验或接受新行为'),
    value(ids.slice(toastEnd),'无需适配','NO_CHANGE','Dialog已有背景色覆盖，不触发新材质')];
  await writeFile(draftFile,JSON.stringify(draft,null,2));
  return {root,project,task,layout,args,groupId,groupFile,draftFile,draft,ids};
}
async function imported(t, options) {
  const f = await fixture(t, options);
  f.received = await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile]);
  return f;
}
async function proposal(f, items, sharedItems=[], name=`spec-${items[0]?.id ?? 'config'}.md`) {
  const file=path.join(f.root,'proposal.json');
  await writeFile(file,JSON.stringify({narrative:'明确方案，保留Dialog背景覆盖，逐调用评估见原始来源。',items,sharedItems}));
  const output=path.join(f.layout.deliveryDirectory,name);
  await csv(['prepare-spec',...f.args,'--input',file,'--output',output]);
  return output;
}
async function approval(f, rowIds=f.ids.slice(101,115), id='accept-toast') {
  const item={id,groupId:f.groupId,rowIds,action:'ACCEPT_NEW_BEHAVIOR',assessmentSha256:f.received.assessmentSha256};
  const plan=await proposal(f,[{...item,description:'12处Toast对应14条原始行，接受其新材质。'}]);
  const file=path.join(f.root,'approval.json');
  await writeFile(file,JSON.stringify({plan,answer:'Toast接受新材质',source:'conversation:reply-1',approvedItems:[item]}));
  await csv(['record-approval',...f.args,'--input',file]);
}
async function resolution(f, changes={}) {
  const file = path.join(f.root,'resolution.json');
  await writeFile(file,JSON.stringify({groupId:f.groupId,sourceSha256:f.draft.sourceSha256,
    groupSha256:sha256(await readFile(f.groupFile)),updates:[{
      rowIds:f.ids.slice(101,115),approvalId:'accept-toast',outcome:'NO_CHANGE',
      resolution:{reason:'用户明确接受新材质，不是未触发',evidence:['conversation:reply-1']},...changes,
    }]}));
  return file;
}
async function report(f, io={}) {
  await csv(['write',...f.args]);
  const file = path.join(f.root,'report-data.json');
  await prepareReport({taskFile:f.task.taskFile,mode:'upgrade',output:file});
  const data = await json(file);
  Object.assign(data.projects[0].changes[0],{before:'旧材质',after:'新材质',targetIsolation:'target26'});
  await writeFile(file,JSON.stringify(data));
  return renderReport({taskFile:f.task.taskFile,mode:'upgrade',data,dataSnapshot:{file,hash:sha256(await readFile(file))}},io);
}

test('prepare-spec names the offending item when alternatives reuse a row or omit the action', async t => {
  const f = await imported(t), rowIds = f.ids.slice(101,115);
  const item = {groupId:f.groupId,rowIds,assessmentSha256:f.received.assessmentSha256,description:'12处Toast对应14条原始行。'};
  await assert.rejects(proposal(f,[{...item,id:'toast-keep-old',action:'APPLY_APPROVED_CHANGE'},{...item,id:'toast-accept',action:'ACCEPT_NEW_BEHAVIOR'}]),
    /已在方案项 toast-keep-old 中，不能再写入方案项 toast-accept.*alternative/s);
  await assert.rejects(proposal(f,[{...item,id:'toast-accept'}]), /方案项 toast-accept 缺少 action/);
  await assert.rejects(proposal(f,[{...item,id:'toast-accept',action:'ACCEPT_NEW_BEHAVIOR',rowIds:[]}]), /方案项 toast-accept 的 rowIds 为空/);
});

test('prepare-spec validates the shared scope and the distinct IDs and actions of a Toast choice', async t => {
  const f = await imported(t), rowIds = f.ids.slice(101,115);
  const item = {id:'toast-keep',action:'APPLY_APPROVED_CHANGE',description:'保留旧材质',groupId:f.groupId,
    rowIds,assessmentSha256:f.received.assessmentSha256};
  const alternative = {id:'toast-accept',action:'ACCEPT_NEW_BEHAVIOR',description:'接受新材质'};
  await assert.rejects(proposal(f,[{...item,alternative:{...alternative,rowIds}}]),/rowIds.*字段不允许/);
  await assert.rejects(proposal(f,[{...item,alternative:{...alternative,id:item.id}}]),/ID.*重复/);
  await assert.rejects(proposal(f,[{...item,alternative}],[{id:alternative.id,description:'共享配置'}]),/ID.*重复/);
  await assert.rejects(proposal(f,[{...item,alternative:{...alternative,action:item.action}}]),/互斥.*动作/);
  await assert.rejects(proposal(f,[{...item,rowIds:[f.ids[0]],alternative}]),/互斥.*可选适配/);
});

test('legacy spec rendering retains the original draft and approved bytes', () => {
  const proposal = {narrative:'旧版方案',items:[{
    id:'toast',description:'接受新材质',action:'ACCEPT_NEW_BEHAVIOR',rowIds:['scan:235'],locationCount:1,
    rows:[{rowId:'scan:235',physicalFile:'entry/A.ets',codeLocation:'entry/A.ets:10',apiDefinition:'showToast()'}],
  }],sharedItems:[{id:'sdk',description:'升级SDK'}]};
  const hash = 'old-proposal';
  const repair = {approvedItems:[{id:'toast',proposalSha256:hash,answer:'同意接受',source:'reply-1'}]};
  assert.equal(sha256(renderSpec(proposal,{},hash)),'fd56ee04ff8ed63dd98888b495f5f71e25e812f15892bba0844c215159768083');
  assert.equal(sha256(renderSpec(proposal,repair,hash)),'89baed241423b9dbec6146296e64884ffabb4f5dbe82b22b8811cd818e4d0ac6');
});

test('33 Toast rows can approve either choice or decline in one spec with auditable evidence', async t => {
  for (const choice of ['toast-keep', 'toast-accept', 'decline']) await t.test(choice, async t => {
    const f = await imported(t,{rowCount:135,toastCount:33}), rowIds = f.ids.slice(101,134);
    const scope = {groupId:f.groupId,rowIds,assessmentSha256:f.received.assessmentSha256};
    const primary = {id:'toast-keep',action:'APPLY_APPROVED_CHANGE',description:'保留旧材质'};
    const alternative = {id:'toast-accept',action:'ACCEPT_NEW_BEHAVIOR',description:'接受新材质'};
    const plan = await proposal(f,[{...scope,...primary,alternative}],[],'spec.md');
    const original = await readFile(plan,'utf8');
    assert.match(original,/toast-keep.*保留旧材质[\s\S]*toast-accept.*接受新材质/);
    assert.match(original,/原始行 33 条/);
    const details = original.split('## 方案项与原始行范围')[1].split('## 共享修改')[0];
    for (const id of rowIds) assert.equal(details.split(id).length,2);
    assert.equal((await csv(['validate',...f.args])).pendingCount,33);

    const input = path.join(f.root,'decision.json');
    const request = {plan,answer:`选择 ${choice}`,source:'conversation:toast-choice'};
    const submit = async (fields, command='record-approval') => {
      await writeFile(input,JSON.stringify({...request,...fields}));
      return csv([command,...f.args,'--input',input]);
    };
    const before = await readFile(f.layout.progressPath);
    await assert.rejects(submit({approvedItemIds:[primary.id,alternative.id]}),/互斥/);
    await assert.rejects(submit({approvedItemIds:[alternative.id],declinedItems:[primary.id]},'record-decision'),/互斥/);
    await assert.rejects(submit({declinedItems:[alternative.id]},'record-decision'),/不实施.*整组.*toast-keep/);
    const {description,...explicit} = alternative;
    await assert.rejects(submit({approvedItems:[{...scope,...explicit,rowIds:rowIds.slice(1)}]}),/范围/);
    assert.deepEqual(await readFile(f.layout.progressPath),before);
    assert.equal(await readFile(plan,'utf8'),original);

    const decision = choice==='decline' ? {declinedItems:[primary.id]} : {approvedItemIds:[choice]};
    const command = choice==='decline' ? 'record-decision' : 'record-approval';
    assert.equal((await submit(decision,command)).rowCount,33);
    assert.equal((await submit(decision,command)).rowCount,33);
    if (choice===alternative.id) assert.equal((await submit({approvedItems:[{...scope,...explicit}]})).rowCount,33);
    const repair = (await json(f.layout.progressPath)).decisions.repair;
    const decisions = choice==='decline' ? repair.declinedItems : repair.approvedItems;
    assert.equal(decisions.length,1);
    const [saved] = decisions;
    const selected = choice===alternative.id ? alternative : primary;
    assert.equal(saved.id,selected.id);
    assert.equal(saved.action,selected.action);
    assert.deepEqual(saved.rowIds,rowIds);
    assert.equal(saved.specSha256,sha256(Buffer.from(original)));
    assert.equal(await readFile(saved.plan,'utf8'),original);
    const confirmed = (await readFile(plan,'utf8')).split('## 用户确认')[1];
    assert.match(confirmed,new RegExp(`- ${saved.id} ${choice==='decline' ? '未实施' : '已批准'}`));
    assert.doesNotMatch(confirmed,/待确认/);
    assert.deepEqual((await readdir(f.layout.deliveryDirectory)).filter(name=>/^spec.*\.md$/.test(name)),['spec.md']);

    const progress = await readFile(f.layout.progressPath);
    await assert.rejects(submit({approvedItemIds:[choice===alternative.id ? primary.id : alternative.id]}),/互斥/);
    assert.deepEqual(await readFile(f.layout.progressPath),progress);
    if (choice!=='decline') {
      const apply = choice===primary.id;
      const change = await resolution(f,{rowIds,approvalId:saved.id,outcome:apply?'MODIFIED':'NO_CHANGE',
        changes:apply?['显式关闭应用材质']:[],next:''});
      await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',change]);
    }
    const delivered = await reportCli(['render','--task',f.task.taskFile,'--mode','upgrade']);
    const html = await readFile(delivered.output,'utf8');
    const verified = await csv(['verify',...f.args]);
    assert.equal(verified.reportSourceStatus,'MATCH');
    assert.equal(verified.acceptedNewBehaviorCount,choice===alternative.id ? 33 : 0);
    assert.equal(verified.pendingCount,0);
    const metric = choice===primary.id ? '获批修复' : '接受新行为';
    if (choice==='decline') assert.match(html,/明确不实施 33 行/);
    else assert.match(html,new RegExp(`metric-decisions">${metric} 33 行`));
    assert.doesNotMatch(html,/无法核对用户决定的方案来源/);

    if (choice===alternative.id) {
      const replacement = await proposal(f,[{...scope,...primary,id:'toast-keep-v2'}],[],'spec-v2.md');
      const updated = (await json(f.layout.progressPath)).decisions.repair;
      assert.deepEqual(updated.supersededItems,[alternative.id]);
      assert.equal(updated.plan,replacement);
      assert.equal((await submit({plan:replacement,approvedItemIds:['toast-keep-v2'],answer:'改为保留旧材质'})).rowCount,33);
      assert.equal(await readFile(saved.plan,'utf8'),original);
      assert.match(await readFile(plan,'utf8'),/toast-accept 已批准/);
    }
  });
});

test('116 rows retain original assessments while 14 rows of 12 Toast calls accept a decision', async t => {
  const f = await imported(t), assessed = await json(f.groupFile);
  assert.equal(f.received.rowCount,116);
  const inspected=await csv(['inspect',...f.args,'--group',f.groupId]);
  assert.equal(inspected.groupSha256,sha256(await readFile(f.groupFile)));
  assert.equal(inspected.assessmentSha256,f.received.assessmentSha256);
  assert.equal(assessed.rowResults.filter(r=>r.category==='可选适配').length,14);
  assert.deepEqual(await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile]),f.received);
  await approval(f);
  const output = path.join(f.root, 'accepted-draft.json');
  const request = ['draft-resolution', ...f.args, '--group', f.groupId, '--approval', 'accept-toast', '--output', output];
  const drafted = await csv(request), draft = await json(output);
  const submit = ['update-resolution', ...f.args, '--group', f.groupId, '--input', output];
  assert.equal(drafted.rowCount, 14);
  assert.equal(draft.groupSha256, inspected.groupSha256);
  assert.deepEqual(draft.updates[0].rowIds, f.ids.slice(101,115));
  assert.equal(draft.updates[0].outcome, 'NO_CHANGE');
  assert.deepEqual(await json(f.groupFile), assessed);
  await assert.rejects(csv(submit), /说明|next/);
  draft.updates[0].next = '';
  draft.updates[0].resolution = { reason: '用户明确接受新材质', evidence: ['conversation:reply-1'] };
  await writeFile(output, JSON.stringify(draft));
  await assert.rejects(csv(request), /已存在|另存/);
  await csv(submit);
  await assert.rejects(csv(submit), /分组已变化/);
  const actual = await json(f.groupFile);
  for (const [i,row] of actual.rowResults.entries())
    for (const key of ['category','reason','evidence','compatibility']) assert.deepEqual(row[key],assessed.rowResults[i][key]);
  assert.ok(actual.rowResults.every(r=>r.outcome==='NO_CHANGE'));
  assert.equal(actual.rowResults.at(-1).reason,'Dialog已有背景色覆盖，不触发新材质');
  const delivered = await report(f), verified = await csv(['verify',...f.args]);
  assert.equal(verified.rowCount,116); assert.equal(verified.categoryCounts['可选适配'],14);
  assert.equal(verified.outcomeCounts.NO_CHANGE,116);
  assert.deepEqual(verified.categoryOutcomeCounts, { 无需适配: { NO_CHANGE: 102 }, 可选适配: { NO_CHANGE: 14 } });
  assert.equal(verified.acceptedNewBehaviorCount, 14);
  const rows = parseCsv(await readFile(f.layout.adaptedCsv,'utf8')).rows;
  assert.equal(rows.length,116);
  assert.equal(rows[101]['评估结论'], '可选适配');
  assert.equal(rows[101]['处理结论'], '无需适配');
  assert.match(rows[101]['处理说明'],/Toast无背景覆盖[\s\S]*用户明确接受/);
  assert.match(await readFile(delivered.output,'utf8'),/可选适配<span class="metric-decisions">接受新行为 14 行<\/span><\/dt><dd>14/);
});

test('an assessment with a UTF-8 BOM remains readable from its exact archived bytes', async t => {
  const f=await fixture(t);
  await writeFile(f.draftFile,'\ufeff'+JSON.stringify(f.draft));
  await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile]);
  await csv(['validate',...f.args]);
  const archived=(await json(f.groupFile)).assessmentSource;
  assert.deepEqual(await readFile(path.resolve(f.layout.deliveryDirectory,archived.record)),await readFile(f.draftFile));
});

test('resolution drafts enforce the selected approval or review scope', async t => {
  const f = await imported(t);
  const item = { id: 'apply-toast', groupId: f.groupId, rowIds: f.ids.slice(101,103),
    action: 'APPLY_APPROVED_CHANGE', assessmentSha256: f.received.assessmentSha256 };
  const plan = await proposal(f, [{ ...item, description: '仅修改两个获批调用' }]);
  const approvalFile = path.join(f.root, 'approval.json');
  await writeFile(approvalFile, JSON.stringify({ plan, answer: '批准这两个调用', source: 'reply', approvedItems: [item] }));
  await csv(['record-approval', ...f.args, '--input', approvalFile]);
  const output = path.join(f.root, 'apply-draft.json');
  const args = ['draft-resolution', ...f.args, '--group', f.groupId, '--output', output];
  await assert.rejects(csv(args), /approval/);
  await assert.rejects(csv([...args, '--review']), /rowId/);
  await assert.rejects(csv([...args, '--review', '--row-id', 'foreign:1']), /rowId/);
  await assert.rejects(csv([...args, '--approval', item.id, '--row-id', f.ids[115]]), /批准集合/);
  await assert.rejects(csv([...args, '--approval', item.id, '--row-ids', f.ids[101]]), /参数无效/);
  await assert.rejects(csv([...args, '--review', '--row-id', f.ids[101], '--row-id', f.ids[101]]), /重复/);
  await csv([...args, '--approval', item.id, '--row-id', f.ids[101]]);
  const draft = await json(output);
  assert.deepEqual(draft.updates[0], { rowIds: [f.ids[101]], next: null, resolution: { reason: '', evidence: [] },
    approvalId: item.id, outcome: 'MODIFIED', changes: [] });
  Object.assign(draft.updates[0], { next: '', resolution: { reason: '已实施', evidence: ['fixture diff'] }, changes: ['本行修改'] });
  await writeFile(output, JSON.stringify(draft));
  const update = await csv(['update-resolution', ...f.args, '--group', f.groupId, '--input', output]);
  const reviewPath = path.join(f.root, 'review-draft.json');
  await csv(['draft-resolution', ...f.args, '--group', f.groupId, '--output', reviewPath,
    '--review', '--approval', item.id, '--row-id', f.ids[101]]);
  const review = await json(reviewPath);
  assert.equal(review.groupSha256, update.groupSha256);
  assert.deepEqual(review.updates[0], { rowIds: [f.ids[101]], next: null, resolution: { reason: '', evidence: [] }, reviewOnly: true });
  Object.assign(review.updates[0], { next: '', resolution: { reason: '静态复核完成', evidence: ['fixture review'] } });
  await writeFile(reviewPath, JSON.stringify(review));
  await csv(['update-resolution', ...f.args, '--group', f.groupId, '--input', reviewPath]);
  const group = await json(f.groupFile);
  assert.equal(group.rowResults[101].resolution.review.reason, '静态复核完成');
  assert.equal(group.rowResults[102].outcome, 'DECISION_REQUIRED');
});

test('assessment import rejects omissions, duplicates, foreign IDs, aliases and stale input without writes', async t => {
  const f = await fixture(t), before = await readFile(f.groupFile), input = path.join(f.root,'bad.json');
  for (const mutate of [d=>d.items[1].rowIds.pop(),d=>d.items[0].rowIds.push(d.items[1].rowIds[0]),
    d=>{d.items[0].rowIds[0]='foreign:1';},d=>{d.items[0].category='NO_CHANGE';},
    d=>{d.items[0].outcome='no_action_needed';},d=>{d.groupSha256='0'.repeat(64);},d=>{d.sourceSha256='0'.repeat(64);}]) {
    const bad = structuredClone(f.draft); mutate(bad); await writeFile(input,JSON.stringify(bad));
    await assert.rejects(csv(['import-assessment',...f.args,'--group',f.groupId,'--input',input]));
    assert.deepEqual(await readFile(f.groupFile),before);
  }
  const link = path.join(f.root,'source alias');
  await symlink(path.dirname(f.groupFile),link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(csv(['draft-assessment',...f.args,'--group',f.groupId,'--output',path.join(link,path.basename(f.groupFile))]),/覆盖|存在/);
});

test('resolution rejects scope expansion and assessment edits, and preserves omitted follow-ups', async t => {
  const f = await imported(t); await approval(f,f.ids.slice(101,113));
  const before = await readFile(f.groupFile);
  await assert.rejects(csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f)]),/批准|范围/);
  assert.deepEqual(await readFile(f.groupFile),before);
  await approval(f,f.ids.slice(101,115),'accept-all-toast');
  const file = await resolution(f,{approvalId:'accept-all-toast',category:'无需适配'});
  await assert.rejects(csv(['update-resolution',...f.args,'--group',f.groupId,'--input',file]),/category|评估/);
  await assert.rejects(csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{approvalId:'accept-all-toast',changes:['未获批准的源码改动']})]),/接受|差异/);
  const patch = await resolution(f,{approvalId:'accept-all-toast'});
  const request = await json(patch); request.groupSha256='0'.repeat(64); await writeFile(patch,JSON.stringify(request));
  await assert.rejects(csv(['update-resolution',...f.args,'--group',f.groupId,'--input',patch]),/变化|哈希/);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{approvalId:'accept-all-toast'})]);
});

test('linked assessments detect context tampering before CSV or HTML publication', async t => {
  const f = await imported(t), group = await json(f.groupFile), good = await readFile(f.groupFile);
  for (const key of ['category','reason','evidence','compatibility']) {
    const bad = structuredClone(group); bad.rowResults.at(-1)[key] = key==='evidence' ? ['被模板覆盖'] : key==='category'?'可选适配':'被模板覆盖';
    await writeFile(f.groupFile,JSON.stringify(bad));
    await assert.rejects(csv(['write',...f.args]),error=>{assert.match(error.message,/rowId|评估/);return true;});
    await assert.rejects(report(f));
  }
  await writeFile(f.groupFile,good);
  await writeFile(path.resolve(f.layout.deliveryDirectory,group.assessmentSource.record),'{}');
  await assert.rejects(csv(['validate',...f.args]),/来源|哈希/);
});

test('a group with recorded approval cannot silently lose its assessment source', async t => {
  const f=await imported(t); await approval(f);
  const group=await json(f.groupFile); delete group.assessmentSource;
  await writeFile(f.groupFile,JSON.stringify(group));
  await assert.rejects(csv(['write',...f.args]),/评估来源/);
});

test('explicit reassessment retains previous source and marks decisions for review', async t => {
  const f = await imported(t), original = (await json(f.groupFile)).assessmentSource;
  const file = path.join(f.root,'reassessed.json');
  await csv(['draft-assessment',...f.args,'--group',f.groupId,'--output',file]);
  const next = await json(file); next.items = structuredClone(f.draft.items); next.items[2].reason='补充新证据后的排除依据';
  await writeFile(file,JSON.stringify(next));
  await assert.rejects(csv(['import-assessment',...f.args,'--group',f.groupId,'--input',file]),/重新评估/);
  await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',file,'--reassess','--reason','评估者补充证据']);
  assert.ok(await readFile(path.resolve(f.layout.deliveryDirectory,original.record)));
  assert.equal((await json(f.groupFile)).reviewRowIds.length,116);
  assert.equal((await csv(['validate',...f.args])).reviewCount,116);
});

async function reassess(f, edit) {
  const file=path.join(f.root,'reassessment.json');
  await csv(['draft-assessment',...f.args,'--group',f.groupId,'--output',file]);
  const draft=await json(file); draft.items=structuredClone(f.draft.items); edit(draft);
  await writeFile(file,JSON.stringify(draft));
  f.received=await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',file,'--reassess','--reason','补查实际背景和验证范围']);
}

test('reassessment can close previously unresolved rows without a new repair approval', async t => {
  const f=await imported(t);
  await reassess(f,draft=>Object.assign(draft.items[1],{category:'无需适配',outcome:'NO_CHANGE',reason:'新证据确认背景有效覆盖'}));
  const updated=(await json(f.groupFile)).rowResults[101];
  assert.equal(updated.outcome,'NO_CHANGE');
  const file=await resolution(f,{rowIds:[f.ids[101]],next:'',resolution:{reason:'已复核此行无需修复',evidence:['fixture']}});
  const patch=await json(file); delete patch.updates[0].approvalId; delete patch.updates[0].outcome; patch.updates[0].verificationOnly=true;
  await writeFile(file,JSON.stringify(patch));
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',file]);
  await csv(['write',...f.args]);
});

test('renewed decisions after reassessment do not inherit obsolete verification', async t => {
  const f=await imported(t); await approval(f);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f)]);
  const file=await resolution(f,{next:'',resolution:{reason:'旧评估的验证依据',evidence:['old-fixture']}}), patch=await json(file);
  delete patch.updates[0].approvalId; delete patch.updates[0].outcome; patch.updates[0].verificationOnly=true;
  await writeFile(file,JSON.stringify(patch));
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',file]);
  await reassess(f,draft=>{draft.items[1].reason='新评估确认仍影响材质';});
  await approval(f,f.ids.slice(101,115),'renewed-accept');
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{approvalId:'renewed-accept'})]);
  const row=(await json(f.groupFile)).rowResults[101];
  assert.equal(row.outcome,'NO_CHANGE');
  assert.equal(row.resolution.approvalId,'renewed-accept');
  assert.equal(row.resolution.verification,undefined);
  assert.equal(row.previousResolution.verification.reason,'旧评估的验证依据');
  assert.equal(row.next,'');
  await csv(['write',...f.args]);
});

test('delivery verification parses embedded commas/newlines and detects changed report sources', async t => {
  const f = await imported(t, { legacy: true }); const rendered = await report(f);
  assert.equal((await csv(['verify',...f.args])).rowCount,116);
  const original = await readFile(f.layout.adaptedCsv), parsed = parseCsv(original.toString());
  const source = parseCsv(await readFile(f.layout.rawCsv, 'utf8'));
  assert.ok(source.headers.includes('Fixed'));
  assert.ok(!parsed.headers.includes('Fixed'));
  parsed.rows[0]['评估结论'] = '必须适配';
  await writeFile(f.layout.adaptedCsv, stringifyCsv(parsed.headers, parsed.rows));
  await assert.rejects(csv(['verify',...f.args]), /评估结论/);
  parsed.rows[0]['评估结论'] = '无需适配';
  parsed.rows[0]['处理说明']='被更改'; await writeFile(f.layout.adaptedCsv,stringifyCsv(parsed.headers,parsed.rows));
  await assert.rejects(csv(['verify',...f.args]),/CSV|结果表/);
  await writeFile(f.layout.adaptedCsv,original);
  const savedProgress=await readFile(f.layout.progressPath), legacy=JSON.parse(savedProgress);
  delete legacy.delivery.reportInputs; await writeFile(f.layout.progressPath,JSON.stringify(legacy));
  const legacyRows = parseCsv(original.toString()).rows.map((row, index) => ({ ...row, Fixed: source.rows[index].Fixed }));
  const legacyHeaders = [...source.headers, '处理结论', '处理说明', '后续事项'];
  await writeFile(f.layout.adaptedCsv, stringifyCsv(legacyHeaders, legacyRows));
  assert.equal((await csv(['verify', ...f.args])).rowCount, 116);
  await writeFile(f.layout.adaptedCsv, stringifyCsv([...legacyHeaders, '旧明细'], legacyRows));
  assert.equal((await renderReport({ taskFile: f.task.taskFile, mode: 'upgrade',
    data: await json(path.join(f.root, 'report-data.json')), output: path.join(f.root, 'legacy.html') })).rowCount, 116);
  await writeFile(f.layout.adaptedCsv,stringifyCsv([...parsed.headers,'额外列'],parseCsv(original.toString()).rows));
  await assert.rejects(csv(['verify',...f.args]),/CSV|结果表/);
  await writeFile(f.layout.adaptedCsv,original);
  await writeFile(f.layout.progressPath,savedProgress);
  const group = await json(f.groupFile); group.rowResults[0].next='报告生成后增加待办';
  await writeFile(f.groupFile,JSON.stringify(group)); await csv(['write',...f.args]);
  await assert.rejects(csv(['verify',...f.args]),/来源|变化|过期/);
  assert.ok(await readFile(rendered.output));
});

test('omitted next stays pending; verification-only updates keep the decision and assessment', async t => {
  const f=await fixture(t); f.draft.items[1].next='待本轮编译'; await writeFile(f.draftFile,JSON.stringify(f.draft));
  f.received=await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile]);
  await approval(f); await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f)]);
  assert.ok((await json(f.groupFile)).rowResults.slice(101,115).every(row=>row.next==='待本轮编译'));
  const file=path.join(f.root,'verify-update.json'), group=await json(f.groupFile);
  await writeFile(file,JSON.stringify({groupId:f.groupId,sourceSha256:f.draft.sourceSha256,groupSha256:sha256(await readFile(f.groupFile)),updates:[{
    rowIds:f.ids.slice(101,115),verificationOnly:true,next:'',resolution:{reason:'本地夹具的本轮验证记录已核对',evidence:['fixture-receipt']},
  }]}));
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',file]);
  const current=await json(f.groupFile);
  assert.equal(current.rowResults[101].resolution.approvalId,group.rowResults[101].resolution.approvalId);
  assert.equal((await csv(['validate',...f.args])).pendingCount,0);
});

test('MODIFIED needs an explicit related difference and never spreads to other rows of one file', async t => {
  const f=await imported(t);
  const item={id:'apply-one',groupId:f.groupId,rowIds:[f.ids[101]],action:'APPLY_APPROVED_CHANGE',assessmentSha256:f.received.assessmentSha256};
  const plan=await proposal(f,[{...item,description:'对一个明确调用实施获批修复'}]);
  const approvalFile=path.join(f.root,'apply-approval.json');
  await writeFile(approvalFile,JSON.stringify({plan,answer:'批准这个调用',source:'reply:2',approvedItems:[{
    id:'apply-one',groupId:f.groupId,rowIds:[f.ids[101]],action:'APPLY_APPROVED_CHANGE',assessmentSha256:f.received.assessmentSha256,
  }]}));
  await csv(['record-approval',...f.args,'--input',approvalFile]);
  const bad=await resolution(f,{rowIds:[f.ids[101]],approvalId:'apply-one',outcome:'MODIFIED',changes:[]});
  await assert.rejects(csv(['update-resolution',...f.args,'--group',f.groupId,'--input',bad]),/实际差异/);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{
    rowIds:[f.ids[101]],approvalId:'apply-one',outcome:'MODIFIED',changes:['fixture：此调用的显式修改'],
  })]);
  const rows=(await json(f.groupFile)).rowResults;
  assert.equal(rows.filter(row=>row.outcome==='MODIFIED').length,1);
  assert.equal(rows.filter(row=>row.outcome==='DECISION_REQUIRED').length,13);
});

test('stale snapshots and simultaneous writers cannot overwrite newer group data', async t => {
  const f=await fixture(t), changed=await json(f.groupFile); changed.rowResults[0].reason='用户并发批注';
  await assert.rejects(importAssessment({taskFile:f.task.taskFile,projectPath:f.project,mode:'upgrade',groupId:f.groupId,input:f.draftFile},{
    beforeWrite:()=>writeFile(f.groupFile,JSON.stringify(changed)),
  }),/变化/);
  assert.equal((await json(f.groupFile)).rowResults[0].reason,'用户并发批注');
  const g=await imported(t); await approval(g);
  const first=await json(await resolution(g)), files=['one','two'].map(name=>path.join(g.root,`${name}.json`));
  await Promise.all(files.map((file,i)=>{const request=structuredClone(first);request.updates[0].resolution.reason=`真实决定${i}`;return writeFile(file,JSON.stringify(request));}));
  const results=await Promise.allSettled(files.map(file=>csv(['update-resolution',...g.args,'--group',g.groupId,'--input',file])));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(new Set((await json(g.groupFile)).rowResults.slice(101,115).map(row=>row.resolution.reason)).size,1);
});

test('report provenance uses physical aliases and rejects spec changes during publication', async t => {
  const f=await imported(t); await approval(f);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f)]);
  const rendered=await report(f), alias=path.join(f.root,'report alias'), csvAlias=path.join(f.root,'csv alias');
  await symlink(path.dirname(rendered.output),alias,process.platform==='win32'?'junction':'dir');
  await symlink(f.layout.deliveryDirectory,csvAlias,process.platform==='win32'?'junction':'dir');
  await csv(['verify',...f.args,'--report',path.join(alias,path.basename(rendered.output)),'--adapted',path.join(csvAlias,path.basename(f.layout.adaptedCsv))]);
  const dataFile=path.join(f.root,'report-data.json'), dataBytes=await readFile(dataFile);
  await writeFile(dataFile,Buffer.concat([dataBytes,Buffer.from(' ')]));
  await rm(dataFile);
  assert.equal((await csv(['verify',...f.args])).reportSourceStatus,'MATCH');
  const manifest=(await json(f.layout.progressPath)).delivery.reportInputs.files;
  const archived=manifest.find(entry=>path.basename(entry.file).startsWith('report-input-'));
  await writeFile(archived.file,'{}');
  await assert.rejects(csv(['verify',...f.args]),/来源|过期/);
  await writeFile(dataFile,dataBytes);
  const g=await imported(t);await approval(g);await csv(['update-resolution',...g.args,'--group',g.groupId,'--input',await resolution(g)]);
  await assert.rejects(report(g,{beforePublish:async()=>writeFile((g.taskPlan ?? (await json(g.layout.progressPath)).decisions.repair.plan),'发布途中被修改的方案')}),/变化|方案|来源/);
});


test('read-only assessment checking locates misplaced knowledge and preserves every source', async t => {
  const f=await fixture(t), before=await readFile(f.groupFile);
  f.draft.items[0].knowledge={originalReference:'second source'};
  await writeFile(f.draftFile,JSON.stringify(f.draft));
  await assert.rejects(csv(['check-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile]),error=>{
    assert.equal(error.details.jsonPath,'/items/0/knowledge'); return true;
  });
  assert.deepEqual(await readFile(f.groupFile),before);
  delete f.draft.items[0].knowledge;
  f.draft.knowledge={sources:[{originalReference:'first',readRanges:[1,10]},{originalReference:'second',readRanges:[11,30]}]};
  await writeFile(f.draftFile,JSON.stringify(f.draft));
  const draftBytes=await readFile(f.draftFile);
  assert.equal((await csv(['check-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile])).rowCount,116);
  assert.deepEqual(await readFile(f.groupFile),before);
  assert.deepEqual(await readFile(f.draftFile),draftBytes);
  await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile]);
  assert.deepEqual((await json(f.groupFile)).knowledge,f.draft.knowledge);
});

test('156 pending rows require explicit closeout; scoped-out records remain independent', async t => {
  const f=await fixture(t,{rowCount:156});
  const item=(rowIds,category,outcome,next)=>({rowIds,category,outcome,next,reason:'fixture逐行核查依据',evidence:['fixture'],compatibility:'target26',changes:[]});
  f.draft.items=[item(f.ids.slice(0,43),'无需适配','NO_CHANGE','无剩余动作'),
    item(f.ids.slice(43,70),'范围外','OUT_OF_SCOPE','不在本变更范围'),
    item(f.ids.slice(70),'可选适配','DECISION_REQUIRED','等待用户确认')];
  await writeFile(f.draftFile,JSON.stringify(f.draft));
  f.received=await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile]);
  const initial=await csv(['validate',...f.args]);
  assert.equal(initial.pendingCount,156); assert.equal(initial.unresolvedCount,86);
  await approval(f,f.ids.slice(70));
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{rowIds:f.ids.slice(70),next:''})]);
  const input=await resolution(f,{rowIds:f.ids.slice(0,70),reviewOnly:true,next:'',resolution:{reason:'逐行复核，本轮无后续动作',evidence:['fixture spec 与调用上下文']}});
  const patch=await json(input); delete patch.updates[0].approvalId; delete patch.updates[0].outcome;
  await writeFile(input,JSON.stringify(patch));
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',input]);
  const diagnostic=await csv(['validate',...f.args,'--details']);
  assert.equal(diagnostic.pendingCount,0); assert.equal(diagnostic.nextCount,0);
  await csv(['write',...f.args]);
  const rows=parseCsv(await readFile(f.layout.adaptedCsv,'utf8')).rows;
  assert.equal(rows[43]['评估结论'],'无需适配'); assert.equal(rows[43]['处理结论'],'无需适配');
  assert.equal((await json(f.groupFile)).rowResults[43].category, '范围外');
  assert.ok(rows.slice(70).every(row=>row['评估结论']==='可选适配'));
});

test('review-only closeout needs evidence and cannot modify a decision or protected assessment', async t => {
  const f=await imported(t);
  await reassess(f,d=>{d.items[0].reason='补充证据';});
  const before=await readFile(f.groupFile);
  const input=await resolution(f,{rowIds:[f.ids[0]],reviewOnly:true,next:'',resolution:{reason:'复核完成',evidence:['fixture']}});
  const patch=await json(input); delete patch.updates[0].approvalId; delete patch.updates[0].outcome;
  for (const change of [{next:undefined},{resolution:{reason:'复核',evidence:[]}},{outcome:'NO_CHANGE'},{category:'可选适配'}]) {
    const invalid=structuredClone(patch); Object.assign(invalid.updates[0],change); await writeFile(input,JSON.stringify(invalid));
    await assert.rejects(csv(['update-resolution',...f.args,'--group',f.groupId,'--input',input]));
    assert.deepEqual(await readFile(f.groupFile),before);
  }
  await writeFile(input,JSON.stringify(patch));
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',input]);
  const after=await json(f.groupFile);
  assert.equal(after.reviewRowIds.length,115);
  assert.equal(after.rowResults[0].resolution.review.reason,'复核完成');
  assert.equal((await csv(['validate',...f.args])).reviewCount,115);
});

test('a generated spec shows full IDs, rejects approval expansion and keeps approved snapshots', async t => {
  const f=await imported(t);
  const item={id:'toast',groupId:f.groupId,rowIds:f.ids.slice(101,113),action:'ACCEPT_NEW_BEHAVIOR',assessmentSha256:f.received.assessmentSha256};
  const plan=await proposal(f,[{...item,description:'仅接受这十二条原始行'}]);
  const file=path.join(f.root,'approval-exact.json');
  const request={plan,answer:'批准toast',source:'conversation:actual',approvedItems:[{...item,rowIds:f.ids.slice(101,115)}]};
  await writeFile(file,JSON.stringify(request));
  const before=await readFile(f.layout.progressPath);
  await assert.rejects(csv(['record-approval',...f.args,'--input',file]),/范围|明细/);
  assert.deepEqual(await readFile(f.layout.progressPath),before);
  request.approvedItems=[item]; await writeFile(file,JSON.stringify(request));
  await csv(['record-approval',...f.args,'--input',file]);
  const approved=(await json(f.layout.progressPath)).decisions.repair.approvedItems[0];
  assert.notEqual(approved.plan,plan);
  const snapshot=await readFile(approved.plan);
  assert.equal(sha256(snapshot),approved.specSha256);
  const text=await readFile(plan,'utf8');
  assert.match(text,/全部批准/); assert.match(text,/conversation:actual/);
  for (const id of item.rowIds) assert.ok(text.includes(id));
  await csv(['record-approval',...f.args,'--input',file]);
  assert.deepEqual(await readFile(approved.plan),snapshot);
  await writeFile(plan,text+'业务方案被修改');
  await assert.rejects(csv(['write',...f.args]),/方案|spec/);
});

test('configuration-only approvals publish confirmation and recover a failed confirmation write', async t => {
  const f=await imported(t), plan=await proposal(f,[],[{id:'target',description:'target升级至26，compatible升级至20'}]);
  const file=path.join(f.root,'config-approval.json');
  await writeFile(file,JSON.stringify({plan,answer:'批准target',source:'reply-config',approvedItems:[],approvedSharedItems:['target']}));
  const options={taskFile:f.task.taskFile,projectPath:f.project,mode:'upgrade',input:file};
  await assert.rejects(recordApproval(options,{afterProgress:()=>{throw new Error('fixture确认写入中断');}}),/中断/);
  await assert.rejects(csv(['write',...f.args]),/未同步/);
  await csv(['record-approval',...f.args,'--input',file]);
  assert.match(await readFile(plan,'utf8'),/全部批准/);
  assert.equal((await json(f.layout.progressPath)).decisions.repair.approvedSharedItems.length,1);
  await csv(['write',...f.args]);
});

test('spec approval accepts physical path aliases and reordered IDs without losing immutable evidence', async t => {
  const f=await imported(t);
  const item={id:'toast-alias',groupId:f.groupId,rowIds:f.ids.slice(101,115),action:'ACCEPT_NEW_BEHAVIOR',assessmentSha256:f.received.assessmentSha256};
  const plan=await proposal(f,[{...item,description:'重复扫描行分别批准'}]);
  assert.match(await readFile(plan,'utf8'),/原始行 14 条，独立代码位置 12 个/);
  const alias=path.join(f.root,'方案 中文别名');
  await symlink(path.dirname(plan),alias,process.platform==='win32'?'junction':'dir');
  const file=path.join(f.root,'alias-approval.json');
  await writeFile(file,JSON.stringify({plan:path.join(alias,path.basename(plan)),answer:'批准',source:'alias-reply',approvedItems:[{...item,rowIds:[...item.rowIds].reverse()}]}));
  await csv(['record-approval',...f.args,'--input',file]);
  const repair=(await json(f.layout.progressPath)).decisions.repair;
  assert.deepEqual(repair.approvedItems[0].rowIds,item.rowIds);
  await writeFile(repair.approvedItems[0].plan,'被改写的批准快照');
  await assert.rejects(csv(['validate',...f.args]),/快照已变化/);
});

test('approval publication preserves an external spec edit after progress has been saved', async t => {
  const f=await imported(t), plan=await proposal(f,[],[{id:'target',description:'target配置修改'}]);
  const file=path.join(f.root,'config-edit.json');
  await writeFile(file,JSON.stringify({plan,answer:'批准',source:'reply',approvedItems:[],approvedSharedItems:['target']}));
  const edited='用户在批准写入期间编辑了方案';
  await assert.rejects(recordApproval({taskFile:f.task.taskFile,projectPath:f.project,mode:'upgrade',input:file},
    {afterProgress:()=>writeFile(plan,edited)}),/变化/);
  assert.equal(await readFile(plan,'utf8'),edited);
});


test('a report never projects an obsolete assessment approval as the current decision', async t => {
  const f=await imported(t); await approval(f);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f)]);
  await reassess(f,draft=>{draft.items[1].reason='实际新证据要求重新判断';});
  const delivered=await report(f), html=await readFile(delivered.output,'utf8');
  assert.ok(!html.includes('accept-toast ACCEPT_NEW_BEHAVIOR'));
  assert.match(html,/决定过期或待复核/);
});

async function unifiedFixture(t,{allNoChange=false,rowCount=3,...options}={}) {
  const f=await fixture(t,{rowCount,...options});
  f.draft.changeSummary={before:'旧材质',after:'新材质',targetIsolation:'target26',keyDecision:'明确选择是否保留旧体验',proposal:'显式设置材质或接受新行为'};
  f.draft.items=f.ids.map((rowId,index)=>({rowIds:[rowId],category:allNoChange || index===2?'无需适配':index===0?'必须适配':'可选适配',
    outcome:allNoChange || index===2?'NO_CHANGE':'DECISION_REQUIRED',reason:`调用 ${index} 的准确评估`,compatibility:'实际target隔离',evidence:['fixture源码和官方章节'],changes:[],next:''}));
  if (f.groupId) {
    await writeFile(f.draftFile,JSON.stringify(f.draft));
    f.received=await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile]);
  }
  f.items=allNoChange?[]:f.ids.slice(0,2).map((rowId,index)=>({id:`item-${index}`,description:`修复调用 ${index}`,groupId:f.groupId,
    rowIds:[rowId],action:'APPLY_APPROVED_CHANGE',assessmentSha256:f.received.assessmentSha256}));
  f.plan=await proposal(f,f.items);
  f.render=()=>reportCli(['render','--task',f.task.taskFile,'--mode','upgrade']);
  return f;
}
const escapeHtml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
async function assertUnified(f) {
  const progress=await json(f.layout.progressPath), rows=parseCsv(await readFile(progress.delivery.adaptedCsv,'utf8')).rows;
  const html=await readFile(progress.delivery.report,'utf8');
  const {participant}=await taskProject({taskFile:f.task.taskFile,projectPath:f.project,mode:'upgrade'});
  const view=await readTaskView(participant,'upgrade',{strict:true});
  for (const [index,row] of rows.entries()) {
    const table=html.match(new RegExp(`<tr data-source="app" data-row-id="${f.ids[index]}">([\\s\\S]*?)</tr>`))?.[1];
    assert.ok(table,`missing row ${index}`);
    const description=view.projectedRows[index]['处理说明'];
    assert.equal(row['处理说明'],singleLineUpgradeDescription(description));
    assert.ok(table.includes(escapeHtml(description)),'HTML完整依据');
    for (const key of ['评估结论','处理结论','后续事项']) if(row[key]) assert.ok(table.includes(escapeHtml(row[key])),key);
  }
  assert.equal((await csv(['verify',...f.args])).reportSourceStatus,'MATCH');
  return {progress,rows,html};
}

test('explicit no-implementation delivers spec, CSV and HTML from one source without touching project files',async t=>{
  const f=await unifiedFixture(t), source=path.join(f.project,'entry','src','A.ets'), config=path.join(f.project,'build-profile.json5');
  const before=await Promise.all([source,config,f.layout.rawCsv].map(file=>readFile(file)));
  const decision=path.join(f.root,'decline.json');
  await writeFile(decision,JSON.stringify({plan:f.plan,answer:'只看评估方案，全部不实施',source:'conversation:no-implementation',declinedItems:f.items.map(item=>item.id)}));
  await csv(['record-decision',...f.args,'--input',decision]);
  await csv(['record-decision',...f.args,'--input',decision]);
  await f.render(); const {rows,html}=await assertUnified(f);
  assert.deepEqual(rows.map(row=>row['处理结论']),['未实施','未实施','无需适配']);
  assert.deepEqual(rows.map(row=>row['评估结论']),['必须适配','可选适配','无需适配']);
  assert.match(html,/明确不实施 2 行/); assert.match(html,/无需修复批准 1 行/);
  assert.match(await readFile(f.plan,'utf8'),/不实施方案/); assert.match(html,/NOT_RUN/);
  assert.ok(html.includes(f.draft.changeSummary.proposal));
  assert.deepEqual(await Promise.all([source,config,f.layout.rawCsv].map(file=>readFile(file))),before);
  assert.equal((await csv(['validate',...f.args])).pendingCount,0);
  const verification=path.join(f.root,'unwanted-verification.json');
  await writeFile(verification,JSON.stringify({kind:'build',record:'missing-receipt.json',rowIds:[f.ids[0]]}));
  await assert.rejects(csv(['record-verification',...f.args,'--input',verification]),/不实施/);
});

test('partial implementation, declined items and pending answers retain independent row states',async t=>{
  const f=await unifiedFixture(t), file=path.join(f.root,'mixed.json');
  await writeFile(file,JSON.stringify({plan:f.plan,answer:'修第一项，第二项不实施',source:'reply:mixed',approvedItemIds:['item-0'],declinedItems:['item-1']}));
  const receiptFile = path.join(f.root, '决定回执.json');
  const decision = await csv(['record-decision',...f.args,'--input',file,'--receipt-output',receiptFile]);
  assert.deepEqual(await json(receiptFile), { ok: true, result: decision });
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{rowIds:[f.ids[0]],approvalId:'item-0',outcome:'MODIFIED',changes:['本行显式修复'],reportSummary:'已按方案保留原体验',next:'待真实构建'})]);
  await f.render(); const {rows,html}=await assertUnified(f);
  assert.match(html,/已批准实施 1 行/); assert.match(html,/明确不实施 1 行/); assert.match(html,/无需修复批准 1 行/);
  assert.match(html,/必须适配<span class="metric-decisions">获批修复 1 行<\/span><\/dt><dd>1/);
  assert.match(html,/可选适配<\/dt><dd>1/);
  const card = html.match(/<section class="panel" aria-labelledby="key-decisions-title">([\s\S]*?)<\/section>/)[1];
  assert.match(card,/关键决策点 <span class="caption">· 1 项/);
  assert.match(card,/item-0 · 修复调用 0[\s\S]*item-1 · 修复调用 1[\s\S]*item-0 · 已批准实施 1 行[\s\S]*item-1 · 明确不实施 1 行/);
  assert.match(card,/reply:mixed/);
  assert.doesNotMatch(card,/明确选择是否保留旧体验|无需修复批准/);
  assert.match(html, /实际改动 · 1 项<\/h3>[\s\S]*?已适配 1 行<p class="caption">已按方案保留原体验/);
  assert.match(html, /待处理原始行 1 条 · 遗留事项/);
  assert.doesNotMatch(html, /本工程本次命中的评估与修复结果|各项可能重叠/);
  assert.deepEqual(rows.map(row=>row['处理结论']),['已适配','未实施','无需适配']);
  assert.equal(rows[0]['后续事项'],'待真实构建'); assert.equal(rows[1]['后续事项'],'');
  const g=await unifiedFixture(t), pending=path.join(g.root,'partial.json');
  await writeFile(pending,JSON.stringify({plan:g.plan,answer:'第一项不实施，第二项暂未决定',source:'reply:partial',declinedItems:['item-0']}));
  await csv(['record-decision',...g.args,'--input',pending]); await g.render();
  const pendingReport=await assertUnified(g);
  assert.deepEqual(pendingReport.rows.map(row=>row['处理结论']),['未实施','待决策','无需适配']);
  assert.match(pendingReport.html,/待批准：1 行未取得明确批准/);
  const pendingCard = pendingReport.html.match(/aria-labelledby="key-decisions-title">([\s\S]*?)<\/section>/)[1];
  assert.match(pendingCard,/item-0 · 明确不实施 1 行/);
  assert.doesNotMatch(pendingCard,/item-1|待批准/);
});

test('相同变更与 rowId 在联合报告按工程核对用户答复', async t => {
  const f = await unifiedFixture(t);
  const g = await unifiedFixture(t, {task:f.task, projectName:'other'});
  assert.deepEqual(f.ids, g.ids);
  const item = { ...f.items[0], id:'approved-change', description:'修复 <样式> & 保留视觉' };
  const plan = await proposal(f, [item, f.items[1]], [{id:'sdk', description:'共享配置修改'}]);
  const answer = path.join(f.root, 'decision.json');
  await writeFile(answer, JSON.stringify({plan, answer:'同意', source:'reply:app', approvedItemIds:[item.id], approvedSharedItems:['sdk']}));
  await csv(['record-decision', ...f.args, '--input', answer]);
  await csv(['record-decision', ...f.args, '--input', answer]);
  await f.render();
  const {html} = await assertUnified(f);
  const card = html.match(/aria-labelledby="key-decisions-title">([\s\S]*?)<\/section>/)[1];
  assert.match(card, /关键决策点 <span class="caption">· 1 项[\s\S]*修复 &lt;样式&gt; &amp; 保留视觉[\s\S]*reply:app/);
  assert.doesNotMatch(card, /other|item-1|共享配置修改/);
  assert.match(html, /必须适配<span class="metric-decisions">获批修复 1 行<\/span><\/dt><dd>2/);
  assert.match(html, /可选适配<\/dt><dd>2/);
});

test('UTF-8 receipts carry 75 imported rows and 42 approved updates through delivery', async t => {
  const f = await fixture(t, { rowCount: 75 });
  const item = (rowIds, category, outcome) => ({ ...f.draft.items[0], rowIds, category, outcome });
  f.draft.items = [item(f.ids.slice(0,40), '可选适配', 'DECISION_REQUIRED'),
    item(f.ids.slice(40,42), '必须适配', 'DECISION_REQUIRED'),
    item(f.ids.slice(42,48), '无需适配', 'NO_CHANGE'),
    item(f.ids.slice(48), '范围外', 'OUT_OF_SCOPE')];
  f.draft.changeSummary = { before: '旧行为', after: '新行为', targetIsolation: 'target26' };
  await writeFile(f.draftFile, JSON.stringify(f.draft));
  const receipts = path.join(f.root, '中文 回执');
  const run = async (args, name) => {
    const output = path.join(receipts, name);
    const result = await csv([...args, '--receipt-output', output]);
    assert.deepEqual(await json(output), { ok: true, result });
    return result;
  };
  const imported = await run(['import-assessment', ...f.args, '--group', f.groupId, '--input', f.draftFile], '接收.json');
  assert.equal(imported.rowCount, 75);
  assert.equal(imported.categoryCounts['范围外'], 27);
  const items = ['optional', 'required'].map((id, index) => ({ id, groupId: f.groupId,
    rowIds: index ? f.ids.slice(40,42) : f.ids.slice(0,40), description: `获批方案 ${id}`,
    action: 'APPLY_APPROVED_CHANGE', assessmentSha256: imported.assessmentSha256 }));
  const plan = await proposal(f, items);
  const approvalFile = path.join(f.root, '批准.json');
  await writeFile(approvalFile, JSON.stringify({ plan, answer: '批准两项', source: 'reply:42', approvedItemIds: items.map(item => item.id) }));
  const approved = await run(['record-approval', ...f.args, '--input', approvalFile], '批准.json');
  assert.equal(approved.rowCount, 42);
  const progress = await json(f.layout.progressPath);
  assert.deepEqual(progress.decisions.repair.approvedItems.map(item => item.rowIds), items.map(item => item.rowIds));
  const updateFile = path.join(f.root, '更新.json');
  await writeFile(updateFile, JSON.stringify({ groupId: f.groupId, sourceSha256: f.draft.sourceSha256, groupSha256: imported.groupSha256,
    updates: items.map(item => ({ rowIds: item.rowIds, approvalId: item.id, outcome: 'MODIFIED', changes: ['实际获批修改'],
      next: '', resolution: { reason: '按批准实施', evidence: ['fixture diff'] } })) }));
  const updated = await run(['update-resolution', ...f.args, '--group', f.groupId, '--input', updateFile], '更新.json');
  assert.equal(updated.updatedRows, 42);
  await reportCli(['render', '--task', f.task.taskFile, '--mode', 'upgrade']);
  const verified = await run(['verify', ...f.args], '交付.json');
  assert.equal(verified.reportSourceStatus, 'MATCH');
  assert.deepEqual(verified.categoryOutcomeCounts, { 可选适配: { MODIFIED: 40 }, 必须适配: { MODIFIED: 2 }, 无需适配: { NO_CHANGE: 6, OUT_OF_SCOPE: 27 } });
});

test('receipt preflight protects existing evidence and a post-commit collision preserves both results', async t => {
  const f = await fixture(t), args = ['import-assessment', ...f.args, '--group', f.groupId, '--input', f.draftFile];
  const before = await readFile(f.groupFile);
  const alias = path.join(f.root, '分组别名');
  await symlink(path.dirname(f.groupFile), alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const existing of [f.task.taskFile, f.draftFile, f.layout.rawCsv, path.join(alias, path.basename(f.groupFile))]) {
    const bytes = await readFile(existing);
    await assert.rejects(csv([...args, '--receipt-output', existing]), /回执输出已存在/);
    assert.deepEqual(await readFile(existing), bytes);
  }
  assert.deepEqual(await readFile(f.groupFile), before);
  const output = path.join(f.root, '回执.json');
  await assert.rejects(withReceiptOutput('import-assessment', output, async () => {
    const result = await csv(args);
    await writeFile(output, '其他写入者的数据');
    return result;
  }), error => {
    assert.equal(error.code, 'RECEIPT_WRITE_FAILED');
    assert.equal(error.details.committed, true);
    assert.equal(error.details.result.rowCount, 116);
    assert.match(error.message, /先回读分组或进度/);
    return true;
  });
  assert.equal(await readFile(output, 'utf8'), '其他写入者的数据');
  assert.ok((await json(f.groupFile)).assessmentSource);
});

test('approval IDs reject ambiguous, unknown, duplicate, conflicting and stale selections', async t => {
  const f = await unifiedFixture(t), input = path.join(f.root, '批准选择.json');
  const submit = async selection => {
    await writeFile(input, JSON.stringify({ plan: f.plan, answer: '实际答复', source: 'reply:ids', ...selection }));
    return csv(['record-decision', ...f.args, '--input', input]);
  };
  const before = await readFile(f.layout.progressPath);
  await assert.rejects(submit({ approvedItemIds: [] }), /空集合/);
  await assert.rejects(submit({ approvedItemIds: ['item-0'], approvedItems: [] }), /二选一/);
  await assert.rejects(submit({ approvedItemIds: ['未知'] }), /未知行方案项/);
  await assert.rejects(submit({ approvedItemIds: ['item-0', 'item-0'] }), /重复/);
  await assert.rejects(submit({ approvedItemIds: ['item-0'], declinedItems: ['item-0'] }), /重复/);
  assert.deepEqual(await readFile(f.layout.progressPath), before);
  await submit({ declinedItems: ['item-0'] });
  await assert.rejects(submit({ approvedItemIds: ['item-0'] }), /相反决定/);
  await reassess(f, draft => { draft.items[1].reason = '新证据改变评估依据'; });
  await assert.rejects(submit({ approvedItemIds: ['item-1'] }), /当前原始评估来源/);
});

test('analysis-only and zero-row tasks generate pure assessment specs without invented modifications',async t=>{
  for (const rowCount of [3,0]) {
    const f=await unifiedFixture(t,{allNoChange:true,rowCount});
    assert.match(await readFile(f.plan,'utf8'),/无需实施批准/);
    await f.render(); assert.equal((await assertUnified(f)).rows.length,rowCount);
  }
});

test('测试建议读取工程进度，不改变同源逐行结果与待办统计，变化后要求重新发布',async t=>{
  for (const rowCount of [3,0]) {
    const f=await unifiedFixture(t,{allNoChange:true,rowCount});
    const initial=await json(f.layout.progressPath);
    initial.versions={oldTarget:'20',target:'26',compatible:'20'};
    initial.configurationImplementation='已回读工程配置';
    await writeFile(f.layout.progressPath,JSON.stringify(initial));
    await f.render();
    const first=await assertUnified(f), before=await csv(['validate',...f.args]);
    assert.match(first.html,/未记录遗留事项；不代表验证通过/);
    assert.match(first.html,/尚未提供针对性测试建议/);
    const progress=await json(f.layout.progressPath);
    progress.testSuggestions=['搜索页：在phone API 20以上切换搜索态与非搜索态，截图确认 <阴影> & 文本完整'];
    await writeFile(f.layout.progressPath,JSON.stringify(progress));
    await assert.rejects(csv(['verify',...f.args]),/测试建议已变化/);
    await f.render();
    const second=await assertUnified(f), after=await csv(['validate',...f.args]);
    assert.deepEqual(second.rows,first.rows);
    for (const key of ['pendingCount','unresolvedCount','nextCount','reviewCount']) assert.equal(after[key],before[key]);
    assert.equal(after.pendingCount,0);
    assert.match(second.html,/搜索页：在phone API 20以上/);
    assert.match(second.html,/&lt;阴影&gt; &amp; 文本完整/);
    assert.match(second.html,/NOT_RUN/);
    assert.equal(second.progress.delivery.reportStatus,'DELIVERED');
    assert.deepEqual(second.progress.testSuggestions,progress.testSuggestions);
  }
});

test('a single verification reference feeds CSV and HTML and changed evidence cannot retain PASS',async t=>{
  const f=await unifiedFixture(t,{allNoChange:true}), directory=path.join(f.layout.evidenceDirectory,'fixture-build');
  await mkdir(directory,{recursive:true});
  const stage={status:'SUCCEEDED',exitCode:0,stdout:'stdout.log',stderr:'stderr.log'};
  for (const name of ['stdout.log','stderr.log']) await writeFile(path.join(directory,name),'fixture complete log');
  const receipt=path.join(directory,'receipt.json'); await writeFile(receipt,JSON.stringify({status:'BUILD_SUCCEEDED',install:stage,build:stage}));
  const input=path.join(f.root,'verification.json'); await writeFile(input,JSON.stringify({kind:'build',record:receipt,rowIds:f.ids,name:'编译构建',details:'fixture真实回执读取'}));
  const groupBefore=await readFile(f.groupFile);
  await csv(['record-verification',...f.args,'--input',input]); await f.render();
  const first=await assertUnified(f); assert.ok(first.rows.every(row=>row['处理说明'].includes('编译构建 PASS')));
  assert.match(first.html,/编译构建：PASS/); assert.deepEqual(await readFile(f.groupFile),groupBefore);
  await writeFile(receipt,JSON.stringify({status:'BUILD_FAILED',install:stage,build:{...stage,exitCode:2,status:'FAILED'}}));
  await assert.rejects(csv(['verify',...f.args]),/变化|来源|不一致/);
  await f.render(); const second=await assertUnified(f); assert.match(second.html,/UNVERIFIED/);
  assert.ok(second.rows.every(row=>!row['处理说明'].includes('编译构建 PASS')));
  const remaining=second.html.slice(second.html.indexOf('<section class="panel" aria-labelledby="follow-up-title">'));
  assert.match(remaining,/验证证据缺失或变化，需补齐/);
  for (const id of f.ids) assert.ok(remaining.includes(id));
  // Keep the assessment immutable: configuration is also part of the recorded verification inputs.
  await writeFile(path.join(f.project,'build-profile.json5'),'{modules:[{name:"entry",srcPath:"entry"}],app:{products:[]}}');
  await csv(['record-verification',...f.args,'--input',input]);
  await f.render(); const failed=await assertUnified(f);
  assert.match(failed.html,/编译构建：FAIL/);
  assert.match(failed.html.slice(failed.html.indexOf('id="follow-up-title"')),/build 验证未通过或证据不足/);
  await writeFile(path.join(f.project,'build-profile.json5'),'{modules:[{name:"entry",srcPath:"entry"}]}');
  await f.render(); const stale=await assertUnified(f);
  assert.match(stale.html,/编译构建：STALE/);
  assert.match(stale.html.slice(stale.html.indexOf('id="follow-up-title"')),/build 验证已过期，需重新执行/);
});

test('user-edited CSV and HTML are preserved and all consumers follow the generated alternative paths',async t=>{
  const f=await unifiedFixture(t,{allNoChange:true});
  const renderAt = (iso, io = {}) => renderReport({taskFile:f.task.taskFile,mode:'upgrade'}, {now:() => new Date(iso), ...io});
  const first = await renderAt('2026-11-11T16:59:00Z');
  const initial=await assertUnified(f);
  assert.equal(first.sha256, sha256(initial.html));
  assert.match(initial.html, /id="follow-up-title"[\s\S]*<footer class="footer" data-time-sha256="[0-9a-f]{64}">报告生成时间 <time datetime="2026-11-11T16:59:00.000Z">2026-11-12 00:59:00（北京时间）<\/time><\/footer><\/main>/);
  assert.equal((initial.html.match(/<time datetime=/g) ?? []).length, 1);
  assert.deepEqual(await renderAt('2026-11-11T17:00:00Z'), first);
  const edited = initial.html.replace('2026-11-11T16:59:00.000Z', '2026-11-11T16:55:00.000Z').replace('00:59:00（北京时间）', '00:55:00（北京时间）');
  await writeFile(first.output, edited);
  await assert.rejects(csv(['verify',...f.args]), /报告文件已变化/);
  await writeFile(initial.progress.delivery.adaptedCsv,'用户 CSV');
  let retainedOutput;
  await assert.rejects(renderAt('2026-11-11T17:01:00Z', {updateProgress:async () => { throw new Error('模拟文件占用'); }}), error => {
    assert.equal(error.code, 'REPORT_PROGRESS_SYNC_FAILED');
    retainedOutput = error.details.output;
    return true;
  });
  const retained = await readFile(retainedOutput, 'utf8');
  const retry = await renderAt('2026-11-11T17:02:00Z');
  const next=await assertUnified(f);
  assert.equal(retry.output, retainedOutput);
  assert.equal(next.html, retained);
  assert.equal(retry.sha256, sha256(retained));
  assert.match(next.html, /datetime="2026-11-11T17:01:00.000Z"/);
  assert.notEqual(next.progress.delivery.adaptedCsv,initial.progress.delivery.adaptedCsv);
  assert.notEqual(next.progress.delivery.report,initial.progress.delivery.report);
  assert.equal(await readFile(initial.progress.delivery.adaptedCsv,'utf8'),'用户 CSV');
  assert.equal(await readFile(initial.progress.delivery.report,'utf8'),edited);
  assert.ok(next.progress.delivery.reportInputs.files.some(file=>file.file===f.plan));
  assert.doesNotMatch(next.html,/<summary>来源、缺口与后续事项/);
  assert.equal((await f.render()).output,next.progress.delivery.report);
  next.progress.testSuggestions = ['补测入口'];
  await writeFile(f.layout.progressPath, JSON.stringify(next.progress));
  const changed = await renderAt('2026-11-11T17:03:00Z');
  assert.notEqual(changed.output, retry.output);
  const latest = await assertUnified(f);
  assert.match(latest.html, /datetime="2026-11-11T17:03:00.000Z"/);
  assert.match(latest.html, /补测入口/);
});

test('unified publication rejects changed input snapshots and legacy narratives cannot override current facts',async t=>{
  const f=await unifiedFixture(t,{allNoChange:true});
  await assert.rejects(renderReport({taskFile:f.task.taskFile,mode:'upgrade'},{beforeWrite:async()=>writeFile(f.groupFile,(await readFile(f.groupFile,'utf8'))+' ')}),/变化/);
  const {participant}=await taskProject({taskFile:f.task.taskFile,projectPath:f.project,mode:'upgrade'});
  const view=await readTaskView(participant,'upgrade',{strict:true});
  await csv(['write',...f.args]);
  const data={projects:[structuredClone(view.reportData)]}; data.projects[0].changes[0].before='旧报告错误说明';
  await assert.rejects(renderReport({taskFile:f.task.taskFile,mode:'upgrade',data}),/冲突/);
});

test('runtime task CSV needs no decisions JSON, keeps current classifications and survives final publication',async t=>{
  const f=await unifiedFixture(t,{allNoChange:true}), plan=runtimePlan();
  const source=createSource(await readFile(f.layout.rawCsv),'app','all'), refs=source.rows.map(row=>({sourceId:'app',rowId:row.rowId}));
  plan.sources=[source];
  for (const items of [plan.routeMap.routes,plan.spec.points,plan.cases.cases[0].assertions]) for (const item of items) item.rowRefs=refs;
  plan.spec.classifications=[{category:'必须适配',rowRefs:refs}];
  const runDirectory=await freezeRun(path.join(f.root,'runtime'),plan,{packagesDirectory:path.join(f.root,'missing-packages'),mode:'AFTER_ONLY',scripts:{C1:caseSnapshot},
    device:{serial:'SERIAL',api:'26',kind:'emulator',instance:'fixture'},python:'python3',runId:'no-packages'});
  const context=await taskForOutput(f.layout.adaptedCsv); assert.equal(context.projectPath,f.project);
  const legacy=f.ids.map(rowId=>({rowId,评估结论:'必须适配',处理结论:'已适配',处理说明:'错误旧数据',后续事项:''}));
  await assert.rejects(writeTaskRuntimeCsv({...context,runDirectory,sourceId:'app',legacyResults:legacy}),/冲突/);
  await writeTaskRuntimeCsv({...context,runDirectory,sourceId:'app'});
  await f.render(); const {rows,progress,html}=await assertUnified(f);
  const headers=parseCsv(await readFile(progress.delivery.adaptedCsv,'utf8')).headers;
  assert.equal(headers.at(-1),'测试截图'); assert.ok(rows.every(row=>row['评估结论']==='无需适配' && row['测试截图']===''));
  assert.match(html,/UNVERIFIED/); assert.doesNotMatch(html,/设备运行：PASS/);
});

test('replacement proposals supersede only overlapping decisions and reject reuse of the old action',async t=>{
  const f=await unifiedFixture(t), old={...f.items[1],id:'old-accept',action:'ACCEPT_NEW_BEHAVIOR',description:'接受新材质'};
  const plan=await proposal(f,[old,f.items[0]]), input=path.join(f.root,'old-decisions.json');
  const fields=item=>Object.fromEntries(Object.entries(item).filter(([key])=>key!=='description'));
  await writeFile(input,JSON.stringify({plan,answer:'批准这两个方案',source:'reply:old',approvedItems:[fields(f.items[0]),fields(old)]}));
  await csv(['record-decision',...f.args,'--input',input]);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{rowIds:[f.ids[1]],approvalId:'old-accept',outcome:'NO_CHANGE',next:''})]);
  const replacement={...f.items[1],id:'new-apply',description:'改为保留原体验'};
  await proposal(f,[replacement]);
  const repair=(await json(f.layout.progressPath)).decisions.repair;
  assert.deepEqual(repair.supersededItems,['old-accept']);
  await assert.rejects(csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{rowIds:[f.ids[1]],approvalId:'old-accept',outcome:'NO_CHANGE'})]),/当前批准/);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{rowIds:[f.ids[0]],approvalId:'item-0',outcome:'MODIFIED',changes:['独立方案的真实修改'],next:'待编译'})]);
  await f.render(); const {rows,html}=await assertUnified(f);
  assert.equal(rows[0]['处理结论'],'已适配'); assert.equal(rows[1]['处理结论'],'待决策');
  assert.doesNotMatch(html,/old-accept ACCEPT_NEW_BEHAVIOR/);
  assert.match(html,/决定过期或待复核 1 行/);
  const card = html.match(/aria-labelledby="key-decisions-title">([\s\S]*?)<\/section>/)[1];
  assert.match(card,/item-0 · 修复调用 0[\s\S]*reply:old/);
  assert.doesNotMatch(card,/old-accept|new-apply/);
  assert.doesNotMatch(html,/metric-decisions">接受新行为/);
  assert.equal((await csv(['validate',...f.args])).unresolvedCount,1);
});

async function updateSummaries(f, updates, business) {
  const file=path.join(f.root,'summaries.json');
  await writeFile(file,JSON.stringify({groupId:f.groupId,sourceSha256:f.draft.sourceSha256,
    groupSha256:sha256(await readFile(f.groupFile)),summaryOnly:true,updates,...(business===undefined?{}:{business})}));
  return file;
}

test('评估接收简述可选且类型明确，业务概括只保存一次',async t=>{
  const f=await fixture(t,{rowCount:3});
  f.draft.items=f.draft.items.filter(item=>item.rowIds.length);
  f.draft.changeSummary={before:'旧',after:'新',business:'本组三处普通Text未启用复制，不触发选择菜单。'};
  f.draft.items[0].reportSummary='普通Text未启用复制，无需修改。';
  await writeFile(f.draftFile,JSON.stringify(f.draft));
  await csv(['import-assessment',...f.args,'--group',f.groupId,'--input',f.draftFile]);
  const group=await json(f.groupFile); assert.ok(group.rowResults.every(row=>row.reportSummary===f.draft.items[0].reportSummary));
  const {participant}=await taskProject({taskFile:f.task.taskFile,projectPath:f.project,mode:'upgrade'});
  const view=await readTaskView(participant,'upgrade',{strict:true});
  assert.equal(view.reportData.changes[0].business,f.draft.changeSummary.business);
  const bad=await fixture(t,{rowCount:1}); bad.draft.items[0].reportSummary=42;
  bad.draft.items=bad.draft.items.filter(item=>item.rowIds.length);
  await writeFile(bad.draftFile,JSON.stringify(bad.draft));
  await assert.rejects(csv(['check-assessment',...bad.args,'--group',bad.groupId,'--input',bad.draftFile]),/reportSummary/);
});

test('summaryOnly仅修改展示文案，CSV字节、批准、待办及原始评估保持不变',async t=>{
  const f=await unifiedFixture(t,{allNoChange:true}); await f.render();
  const first=await assertUnified(f), original=await json(f.groupFile), progress=await readFile(f.layout.progressPath), source=await readFile(path.join(f.layout.deliveryDirectory,original.assessmentSource.record));
  const csvBefore=await readFile(first.progress.delivery.adaptedCsv), before=await csv(['validate',...f.args]);
  const file=await updateSummaries(f,[{rowIds:f.ids,reportSummary:'普通Text未启用复制，保持 <旧体验> & 原调用。'}],'三处普通Text不触发选择菜单，无需修改。');
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',file]);
  const after=await json(f.groupFile);
  assert.deepEqual(after.rowResults.map(({reportSummary,...row})=>row),original.rowResults);
  assert.deepEqual(after.assessmentSource,original.assessmentSource);
  assert.deepEqual(await readFile(f.layout.progressPath),progress);
  assert.deepEqual(await readFile(path.join(f.layout.deliveryDirectory,original.assessmentSource.record)),source);
  await f.render(); const second=await assertUnified(f);
  assert.deepEqual(await readFile(second.progress.delivery.adaptedCsv),csvBefore);
  assert.match(second.html,/<span class="row-report-summary">普通Text未启用复制，保持 &lt;旧体验&gt; &amp; 原调用。<\/span>/);
  assert.equal((second.html.match(/<summary>完整依据<\/summary>/g)??[]).length,3);
  assert.match(second.html,/三处普通Text不触发选择菜单，无需修改。/);
  const counts=await csv(['validate',...f.args]);
  for (const key of ['pendingCount','unresolvedCount','nextCount','reviewCount']) assert.equal(counts[key],before[key]);
});

test('summaryOnly拒绝状态篡改、错误行和过期哈希，不关闭复核标记',async t=>{
  const f=await unifiedFixture(t,{allNoChange:true}), group=await json(f.groupFile);
  group.reviewRowIds=[f.ids[0]]; await writeFile(f.groupFile,JSON.stringify(group));
  const before=await readFile(f.groupFile);
  for (const updates of [
    [{rowIds:[f.ids[0]],reportSummary:'简述',outcome:'NO_CHANGE'}],
    [{rowIds:['foreign'],reportSummary:'简述'}],
    [{rowIds:[f.ids[0],f.ids[0]],reportSummary:'简述'}],
    [{rowIds:[f.ids[0]],reportSummary:42}],
  ]) {
    const file=await updateSummaries(f,updates);
    await assert.rejects(csv(['update-resolution',...f.args,'--group',f.groupId,'--input',file]));
    assert.deepEqual(await readFile(f.groupFile),before);
  }
  const file=await updateSummaries(f,[{rowIds:[f.ids[0]],reportSummary:'已评估简述'}]);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',file]);
  assert.deepEqual((await json(f.groupFile)).reviewRowIds,[f.ids[0]]);
  await assert.rejects(csv(['update-resolution',...f.args,'--group',f.groupId,'--input',file]),/哈希/);
  await f.render(); const {html}=await assertUnified(f);
  assert.doesNotMatch(html,/<span class="row-report-summary">已评估简述/);
});

test('处理更新和重新评估清除过期简述，获批更新可同时提供当前简述',async t=>{
  const f=await imported(t); await approval(f);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await updateSummaries(f,[{rowIds:f.ids.slice(101,115),reportSummary:'尚未批准，待选择方案。'}])]);
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f)]);
  assert.ok((await json(f.groupFile)).rowResults.slice(101,115).every(row=>row.reportSummary===undefined));
  await csv(['update-resolution',...f.args,'--group',f.groupId,'--input',await resolution(f,{reportSummary:'已获批接受新材质，保留原调用。'})]);
  assert.ok((await json(f.groupFile)).rowResults.slice(101,115).every(row=>row.reportSummary==='已获批接受新材质，保留原调用。'));
  await reassess(f,draft=>{draft.items[1].reason='补充证据后重评';});
  assert.ok((await json(f.groupFile)).rowResults.every(row=>row.reportSummary===undefined));
});

test('configuration-only no-implementation is an explicit completed decision without a fake row repair',async t=>{
  const f=await unifiedFixture(t,{allNoChange:true}), source=path.join(f.root,'configuration-proposal.json'), plan=path.join(f.layout.deliveryDirectory,'spec-target.md');
  await writeFile(source,JSON.stringify({narrative:'仅提出target升级配置方案',items:[],sharedItems:[{id:'target',description:'target升至26，compatible保持'}]}));
  await csv(['prepare-spec',...f.args,'--input',source,'--output',plan]);
  const input=path.join(f.root,'decline-target.json');
  await writeFile(input,JSON.stringify({plan,answer:'不实施配置方案',source:'reply:no-target-change',declinedSharedItems:['target']}));
  await csv(['record-decision',...f.args,'--input',input]); await f.render();
  assert.match(await readFile(plan,'utf8'),/不实施方案/);
  const {rows,html}=await assertUnified(f); assert.ok(rows.every(row=>row['处理结论']==='无需适配'));
  assert.doesNotMatch(html,/配置实施|<h3>共享修改批准<\/h3>/);
});

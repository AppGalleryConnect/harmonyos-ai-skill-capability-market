import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,readdir,readFile,writeFile,rm,rename,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {execute} from '../core/cli.mjs';
import {sha256} from '../../shared/io/fs-utils.mjs';
import {parseCsv} from '../../shared/format/csv.mjs';
import {initTask,readTask,beginTaskScan,completeTaskScan,importTaskCsv} from '../../shared/platform/task-context.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'联合任务 中文-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const projects=['ohos-hardemo','ohos_library'].map(name=>path.join(root,name));
  for(const project of projects) await mkdir(project);
  return {root,projects};
}

test('scan without a task refuses output before SDK discovery',async t=>{
  const {root,projects}=await fixture(t);
  await assert.rejects(execute(['scan','--mode','upgrade','--project',projects[0],'--sdk',path.join(root,'missing-sdk'),'--from','22','--to','26']),
    {code:'TASK_CONTEXT_REQUIRED'});
  await assert.rejects(readdir(path.join(projects[0],'.api-change-output')),{code:'ENOENT'});
});

test('one initialized task retains two failed scans and both engineering deliveries',async t=>{
  const {root,projects}=await fixture(t);
  const task=await execute(['init-task','--task-root',root,'--project',projects[0],'--project',projects[1]]);
  const fixtureRoot=new URL('./fixtures/delivery/',import.meta.url);
  const sample=JSON.parse(await readFile(new URL('passwordinput-task.json',fixtureRoot),'utf8'));
  for(const config of sample.projects) await assert.rejects(execute(['scan','--mode','upgrade','--task',task.taskFile,
    '--project',path.join(root,config.projectKey),'--project-type',config.projectType,'--scan-module',config.module,
    '--sdk',path.join(root,'missing-sdk'),'--from','22','--to','26']),{code:'SDK_ROOT_INVALID'});
  const originals=[];
  for(const config of sample.projects) {
    const project=path.join(root,config.projectKey),bytes=await readFile(new URL(config.sourceCsv,fixtureRoot));
    assert.equal(sha256(bytes),config.sha256);
    assert.equal(parseCsv(bytes.toString('utf8').replace(/^\ufeff/, '')).rows.length,config.records);
    const csv=path.join(root,config.sourceCsv);await writeFile(csv,bytes);
    const result=await importTaskCsv(task.taskFile,{projectPath:project,mode:'upgrade',inputCsv:csv,
      projectType:config.projectType,scanModules:[config.module]});
    assert.equal(result.outputLayout.batchId,result.batchId);
    assert.equal(result.outputLayout.taskDirectory,task.taskDirectory);
    assert.equal(path.basename(result.outputLayout.deliveryDirectory),path.basename(project));
    assert.deepEqual(await readFile(result.outputCsv),bytes);originals.push(result);
  }
  assert.notEqual(originals[0].batchId,originals[1].batchId);
  const state=await readTask(task.taskFile);
  assert.equal(state.participants.length,2);
  assert.ok(state.participants.every(project=>project.attempts.length===2));
  assert.equal(originals[0].outputLayout.taskReportPath,originals[1].outputLayout.taskReportPath);
  assert.equal(originals[0].outputLayout.taskReportPath,path.join(task.taskDirectory,'upgrade','api-adapt-report.html'));
  assert.equal((await readdir(task.outputRoot)).filter(name=>/^\d{14}/.test(name)).length,1);
  for(const project of projects) await assert.rejects(readdir(path.join(project,'.api-change-output')),{code:'ENOENT'});
});

test('an absolute task context pins output after entering a child project',async t=>{
  const {root,projects}=await fixture(t),task=await initTask(root,{outputRoot:'custom output'});
  const entry=fileURLToPath(new URL('../bin/harmony-api-scan.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[entry,'scan','--task',task.taskFile,'--mode','upgrade','--project',projects[0],
    '--sdk',path.join(root,'missing-sdk'),'--from','22','--to','26'],{cwd:projects[1],encoding:'utf8',timeout:30000});
  assert.ifError(result.error);assert.equal(result.status,1);
  const error=JSON.parse(result.stderr).error;assert.equal(error.code,'SDK_ROOT_INVALID');
  assert.ok(error.artifactPaths[0].startsWith(task.taskDirectory+path.sep));
  assert.equal(task.outputRoot,path.join(root,'custom output'));
  for(const project of projects)await assert.rejects(readdir(path.join(project,'.api-change-output')),{code:'ENOENT'});
  const before=await readFile(task.taskFile);
  await assert.rejects(beginTaskScan(task.taskFile,{mode:'upgrade',projectPath:projects[0],outputRoot:'another output'}),{code:'TASK_OUTPUT_CONFLICT'});
  assert.deepEqual(await readFile(task.taskFile),before);
});

test('parallel projects, same-name projects and product scopes keep distinct project directories',async t=>{
  const {root}=await fixture(t),a=path.join(root,'a','Project'),b=path.join(root,'b','project');
  await mkdir(a,{recursive:true});await mkdir(b,{recursive:true});
  const task=await initTask(root),csv=path.join(root,'input.csv');await writeFile(csv,'Title\nrecord\n');
  const results=await Promise.all([a,b].map(projectPath=>importTaskCsv(task.taskFile,{mode:'upgrade',projectPath,inputCsv:csv})));
  assert.notEqual(results[0].outputLayout.projectKey.toLowerCase(),results[1].outputLayout.projectKey.toLowerCase());
  const next=await importTaskCsv(task.taskFile,{mode:'upgrade',projectPath:a,productName:'other',inputCsv:csv});
  assert.notEqual(next.outputLayout.projectKey,results[0].outputLayout.projectKey);
  assert.equal((await readTask(task.taskFile)).participants.length,3);
  await assert.rejects(importTaskCsv(task.taskFile,{mode:'upgrade',projectPath:a,inputCsv:csv}),{code:'TASK_BASELINE_EXISTS'});
});

test('deprecated rescans and physical project aliases preserve the initial CSV',async t=>{
  const {root,projects}=await fixture(t),task=await initTask(root),csv=path.join(root,'input.csv');
  await writeFile(csv,'\ufeffTitle\r\noriginal\r\n');
  const original=await importTaskCsv(task.taskFile,{mode:'deprecated',projectPath:projects[0],inputCsv:csv});
  const alias=path.join(root,'project alias');await symlink(projects[0],alias,process.platform==='win32'?'junction':'dir');
  await writeFile(csv,'Title\nrescan\n');
  const rescan=await importTaskCsv(task.taskFile,{mode:'deprecated',projectPath:alias,inputCsv:csv,scanPurpose:'rescan'});
  assert.equal(rescan.outputLayout.projectKey,original.outputLayout.projectKey);
  assert.equal(rescan.outputLayout.adaptedCsv,null);assert.notEqual(rescan.batchId,original.batchId);
  assert.ok(rescan.outputCsv.startsWith(path.join(task.taskDirectory,'.internal')+path.sep));
  assert.equal(await readFile(original.outputCsv,'utf8'),'\ufeffTitle\r\noriginal\r\n');
  assert.equal((await readTask(task.taskFile)).participants.length,1);
  await assert.rejects(beginTaskScan(task.taskFile,{mode:'upgrade',projectPath:projects[0],scanPurpose:'rescan'}),{code:'SCAN_PURPOSE_INVALID'});
});

test('pending participants and failed attempts remain visible and do not create another timestamp',async t=>{
  const {root,projects}=await fixture(t),task=await initTask(root,{projects});
  for (const project of projects) await assert.rejects(readdir(path.join(task.taskDirectory, 'upgrade', path.basename(project))), {code:'ENOENT'});
  const layout=await beginTaskScan(task.taskFile,{mode:'upgrade',projectPath:projects[0]});
  await assert.rejects(readdir(layout.deliveryDirectory), {code:'ENOENT'});
  await assert.rejects(beginTaskScan(task.taskFile,{mode:'upgrade',projectPath:projects[0]}),{code:'TASK_SCAN_BUSY'});
  await completeTaskScan(task.taskFile,layout.batchId,{error:Object.assign(new Error('IDE unavailable'),{code:'DEVECO_VERSION_UNRESOLVED'})});
  const state=await readTask(task.taskFile);
  assert.deepEqual(state.participants.map(item=>item.status),['SCAN_FAILED','NOT_STARTED']);
  await assert.rejects(readdir(layout.deliveryDirectory), {code:'ENOENT'});
  assert.equal((await readdir(task.outputRoot)).filter(name=>/^\d{14}/.test(name)).length,1);
});

test('interrupted publication retains internal bytes and never overwrites user files',async t=>{
  const {root,projects}=await fixture(t),task=await initTask(root);
  const layout=await beginTaskScan(task.taskFile,{mode:'upgrade',projectPath:projects[0]});
  await mkdir(path.dirname(layout.workRawCsv),{recursive:true});await writeFile(layout.workRawCsv,'Title\nrecord\n');
  await assert.rejects(completeTaskScan(task.taskFile,layout.batchId,{writeIndex:async()=>{throw new Error('interrupted');}}),/interrupted/);
  await assert.rejects(readFile(layout.rawCsv),{code:'ENOENT'});
  assert.equal(await readFile(layout.workRawCsv,'utf8'),'Title\nrecord\n');
  await writeFile(layout.rawCsv,'user bytes');
  await assert.rejects(completeTaskScan(task.taskFile,layout.batchId),{code:'EEXIST'});
  assert.equal(await readFile(layout.rawCsv,'utf8'),'user bytes');
});

test('task and batch metadata tampering or internal junction replacement are rejected',async t=>{
  const {root,projects}=await fixture(t),task=await initTask(root);
  const layout=await beginTaskScan(task.taskFile,{mode:'upgrade',projectPath:projects[0]});
  await writeFile(layout.batchMetadataPath,'{}');
  await assert.rejects(completeTaskScan(task.taskFile,layout.batchId,{error:new Error('failed')}),{code:'TASK_CONTEXT_INVALID'});
  const outside=await mkdtemp(path.join(os.tmpdir(),'outside-task-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await rename(path.join(task.taskDirectory,'.internal'),path.join(task.taskDirectory,'internal-backup'));
  await symlink(outside,path.join(task.taskDirectory,'.internal'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(readTask(task.taskFile),{code:'TASK_CONTEXT_INVALID'});
  assert.deepEqual(await readdir(outside),[]);
});

test('historical batch metadata remains byte-identical when its recorded scan completes',async t=>{
  const {root,projects}=await fixture(t);
  for(const legacyVersion of [5,6]) {
    const task=await initTask(root);
    const layout=await beginTaskScan(task.taskFile,{mode:'upgrade',projectPath:projects[0]});
    const metadata={...JSON.parse(await readFile(layout.batchMetadataPath,'utf8')),schemaVersion:legacyVersion};
    const bytes=Buffer.from(JSON.stringify(metadata,null,2)+'\n');
    // Reconstruct a previously recorded task and its exact metadata fingerprint.
    await writeFile(layout.batchMetadataPath,bytes);
    const state=await readTask(task.taskFile);
    state.participants[0].attempts[0].batchMetadataSha256=sha256(bytes);
    await writeFile(task.taskFile,JSON.stringify(state,null,2)+'\n');
    await mkdir(path.dirname(layout.workRawCsv),{recursive:true});
    await writeFile(layout.workRawCsv,'Title\nlegacy input\n');
    const result=await completeTaskScan(task.taskFile,layout.batchId);
    assert.equal(result.taskReportPath,path.join(task.taskDirectory,'upgrade','api-adapt-report.html'));
    assert.equal(await readFile(result.rawCsv,'utf8'),'Title\nlegacy input\n');
    assert.deepEqual(await readFile(layout.batchMetadataPath),bytes);
    assert.equal((await readTask(task.taskFile)).schemaVersion,1);
  }
});

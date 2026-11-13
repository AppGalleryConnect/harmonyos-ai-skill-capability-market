import { caseSnapshot } from './fixtures/runtime/plan.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { decodeCsvBuffer, readScanInput } from '../format/scan-input.mjs';
import { stringifyCsv, parseCsv, UPGRADE_HEADERS, hyperlink } from '../format/csv.mjs';
import { formatUpgradeResults } from '../format/upgrade-results.mjs';
import { formatDeprecatedResults } from '../format/deprecated-results.mjs';
import { initTask, importTaskCsv, readTask } from '../platform/task-context.mjs';
import { main as csv } from '../../csv/cli.mjs';
import { main as report } from '../../report/cli.mjs';
import { main as runtime } from '../../runtime/cli.mjs';
import { createSource, validatePlan, assertSourceMatches } from '../../runtime/contracts.mjs';
import { fixture as runtimePlan } from './fixtures/runtime/plan.mjs';
import { freezeRun, verifyRun } from '../../runtime/runs.mjs';
import { sha256 } from '../io/fs-utils.mjs';

const title='中文，标题', gbTitle=Buffer.from('d6d0cec4a3acb1eacce2','hex');
const gbEncode=text=>Buffer.concat(text.split(title).flatMap((part,i)=>i?[gbTitle,Buffer.from(part)]:[Buffer.from(part)]));
const row={'Api Definition':'call("a,b")\nnext','Language':'ArkTS','Changed in SDK':'5.1.0(18) Release',
  Title:hyperlink('https://developer.huawei.com/doc/test',title),'Code Location':'entry/src/A.ets:1','Rule ID':'174'};
const text=stringifyCsv(UPGRADE_HEADERS,[row,row],{bom:false}), bytes=gbEncode(text);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const decisions=readScanInput(bytes,{encoding:'gb18030'}).rowIds.map(rowId=>({rowId,评估结论:'无需适配',处理结论:'无需适配',处理说明:'核实无需修改',后续事项:''}));

test('strict encoding detection preserves logical cells, four-byte characters and original-byte IDs',()=>{
  const decoded=readScanInput(bytes,{encoding:'auto'}),utf=readScanInput(Buffer.from(text));
  assert.equal(decoded.encoding,'gb18030');assert.deepEqual(decoded.rows,utf.rows);
  assert.equal(decoded.interpretationSha256,utf.interpretationSha256);
  assert.equal(decoded.rowIds[0],`${sha256(bytes)}:1`);assert.notEqual(decoded.rowIds[0],decoded.rowIds[1]);
  assert.notEqual(decoded.sha256,utf.sha256);
  assert.equal(decodeCsvBuffer(Buffer.from('9534b235','hex'),'gb18030').text,'𠮷');
  assert.equal(decodeCsvBuffer(Buffer.from('\ufeff中文'),'auto').bom,true);
  assert.equal(decodeCsvBuffer(Buffer.from('ascii'),'auto').encoding,'utf-8');
  assert.throws(()=>readScanInput(bytes),/UTF-8/);
});
test('invalid bytes and conflicting BOMs never become replacement characters or alternate-encoding successes',()=>{
  for(const [value,encoding] of [[Buffer.from([0x81]),'gb18030'],[Buffer.from([0x81]),'auto'],
    [Buffer.from([0xef,0xbb,0xbf,0x81]),'auto'],[Buffer.from([0xff,0xfe,0,0]),'auto'],
    [Buffer.from([0,0,0xfe,0xff]),'auto'],[Buffer.from('\ufeffa'),'gb18030'],[bytes,'gbk']])
    assert.throws(()=>decodeCsvBuffer(value,encoding));
});
test('both result formatters write UTF-8 while preserving source cells, multiplicity and raw IDs',()=>{
  const result=formatUpgradeResults(bytes,decisions,{sourceEncoding:'gb18030',screenshots:{[decisions[0].rowId]:'after/C1.png'}});
  assert.ok(result.startsWith('\ufeff'));assert.match(result,/\r\n/);
  const parsed=readScanInput(Buffer.from(result));
  assert.equal(parsed.rows[0].Title,row.Title);assert.equal(parsed.rows.length,2);assert.equal(parsed.headers.at(-1),'测试截图');
  const deprecated=decisions.map(item=>({...item,处理结论:'NO_CHANGE',处理来源:'MODEL_ASSESSED',业务影响:'',兼容性说明:'',变更文件:'',验证证据:''}));
  const output=formatDeprecatedResults(bytes,deprecated,{sourceEncoding:'gb18030'});
  assert.ok(output.startsWith('\ufeff'));assert.equal(parseCsv(output).rows[0].Title,title);
  assert.equal(parseCsv(output).rows[1]['Row ID'],decisions[1].rowId);
  assert.throws(()=>formatUpgradeResults(bytes,decisions),/UTF-8/);
});

async function taskFixture(t,mode='upgrade') {
  const root=await mkdtemp(path.join(os.tmpdir(),'编码 中文 &-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=path.join(root,'app');await mkdir(path.join(project,'entry','src','main'),{recursive:true});
  await writeFile(path.join(project,'build-profile.json5'),'{modules:[{name:"entry",srcPath:"entry"}]}');
  await writeFile(path.join(project,'entry','src','main','module.json5'),'{module:{type:"entry"}}');
  await writeFile(path.join(project,'entry','src','A.ets'),'source');
  const input=path.join(root,'input.csv');await writeFile(input,bytes);
  const task=await initTask(root,{projects:[project],mode});
  const imported=await importTaskCsv(task.taskFile,{projectPath:project,mode,inputCsv:input});
  const args=['--task',task.taskFile,'--project',project,'--mode',mode];
  const prepared=await csv(['prepare',...args]);
  return {root,project,input,task,imported,args,prepared,layout:imported.outputLayout};
}
test('GB historical import reaches assessment, same-source CSV/HTML publication and verify without rewriting bytes',async t=>{
  const f=await taskFixture(t),groupId=f.prepared.groups[0].id,draftFile=path.join(f.root,'draft.json');
  assert.equal(f.imported.csv.encoding,'gb18030');assert.deepEqual(await readFile(f.layout.rawCsv),bytes);
  assert.equal((await csv(['inspect',...f.args])).encoding,'gb18030');
  await csv(['draft-assessment',...f.args,'--group',groupId,'--output',draftFile]);
  const draft=await json(draftFile);assert.equal(draft.schemaVersion,1);
  Object.assign(draft.changeSummary,{before:'原行为',after:'新行为',targetIsolation:'已核实门槛',keyDecision:'',proposal:'无需修改'});
  Object.assign(draft.items[0],{category:'无需适配',outcome:'NO_CHANGE',reason:'调用未触发变化',compatibility:'实际参数覆盖支持范围',evidence:['entry/src/A.ets:1']});
  await writeFile(draftFile,JSON.stringify(draft));
  await csv(['import-assessment',...f.args,'--group',groupId,'--input',draftFile]);
  await report(['render','--task',f.task.taskFile,'--mode','upgrade']);
  const verified=await csv(['verify',...f.args]);assert.equal(verified.reportSourceStatus,'MATCH');assert.equal(verified.rowCount,2);
  assert.ok((await readFile(f.layout.adaptedCsv,'utf8')).startsWith('\ufeff'));
  assert.deepEqual(await readFile(f.layout.rawCsv),bytes);
  await assert.rejects(csv(['inspect',...f.args,'--encoding','utf-8']),/确定编码/);
  const progress=await json(f.layout.progressPath);progress.source.csv.encoding='utf-8';await writeFile(f.layout.progressPath,JSON.stringify(progress));
  await assert.rejects(csv(['validate',...f.args]),/解码解释/);
});
test('GB deprecated tasks retain their existing assessment and HTML delivery path',async t=>{
  const f=await taskFixture(t,'deprecated');
  const file=path.join(f.layout.deliveryDirectory,f.prepared.groups[0].record),group=await json(file);
  for(const item of group.rowResults)Object.assign(item,{outcome:'NO_CHANGE',reason:'已核实',compatibility:'最低版本已满足',evidence:['准确声明']});
  await writeFile(file,JSON.stringify(group));
  await report(['render','--task',f.task.taskFile,'--mode','deprecated']);
  const result=await readFile(f.layout.adaptedCsv,'utf8');assert.ok(result.startsWith('\ufeff'));
  assert.equal(parseCsv(result).rows[0].Title,title);assert.deepEqual(await readFile(f.layout.rawCsv),bytes);
});
test('standalone CLI detects explicit auto encoding and does not reinterpret a task later',async t=>{
  const f=await taskFixture(t),output=path.join(f.root,'standalone.csv'),results=path.join(f.root,'results.json');
  await writeFile(results,JSON.stringify(decisions));
  const inspected=await csv(['inspect','--mode','upgrade','--project',f.project,'--scan',f.input,'--encoding','auto']);
  assert.equal(inspected.rows[0].title,title);
  await csv(['write','--mode','upgrade','--scan',f.input,'--results',results,'--output',output,'--encoding','gb18030']);
  assert.equal(readScanInput(await readFile(output)).rows[0].Title,row.Title);
  const index=await readTask(f.task.taskFile);index.participants[0].attempts[0].source.csv.encoding='utf-8';
  await writeFile(f.task.taskFile,JSON.stringify(index));
  await assert.rejects(csv(['inspect',...f.args]),/UTF-8|解码/);
});

function gbPlan() {
  const plan=runtimePlan(),source=createSource(bytes,'app','all',{encoding:'gb18030'});
  const ids=new Map(plan.sources[0].rows.map((row,i)=>[row.rowId,source.rows[i].rowId]));
  const remap=value=>{if(Array.isArray(value))return value.map(remap);if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='rowId'?ids.get(v)??v:remap(v)]));return value;};
  const result=remap(plan);result.sources=[source];return result;
}
test('runtime GB sources freeze and rebuild with their encoding; legacy UTF-8 objects retain their shape',async t=>{
  const plan=gbPlan();assert.equal(validatePlan(plan).selectedRows,2);assertSourceMatches(plan.sources[0],readScanInput(bytes,{encoding:'gb18030'}));
  const old=runtimePlan();assert.equal(Object.hasOwn(old.sources[0],'encoding'),false);assert.equal(validatePlan(old).selectedRows,2);
  const f=await taskFixture(t),config=path.join(f.root,'sources-config.json'),out=path.join(f.root,'runtime');
  await writeFile(config,JSON.stringify({sources:[{sourceId:'app',scanCsv:f.input,selection:'all',encoding:'gb18030'}]}));
  await runtime(['sources',config,out]);assert.deepEqual((await json(path.join(out,'sources.json')))[0],plan.sources[0]);
  const run=await freezeRun(f.root,plan,{packagesDirectory:path.join(f.root,'missing'),mode:'AFTER_ONLY',scripts:{C1:caseSnapshot},
    device:{serial:'SERIAL',api:'26',kind:'emulator',instance:'API26Phone'},python:'python3',runId:'encoded'});
  assert.equal((await verifyRun(run)).plan.sources[0].encoding,'gb18030');
  const results=path.join(f.root,'runtime-results.json'),output=path.join(f.root,'runtime.csv');await writeFile(results,JSON.stringify(decisions));
  await runtime(['csv',run,'app',results,output]);assert.equal(parseCsv(await readFile(output,'utf8')).rows[0].Title,row.Title);
  await runtime(['csv',run,'app','--task',f.task.taskFile,'--project',f.project]);
  assert.equal(parseCsv(await readFile(f.layout.adaptedCsv,'utf8')).rows[0].Title,row.Title);
  assert.equal(parseCsv(await readFile(f.layout.adaptedCsv,'utf8')).headers.at(-1),'测试截图');
});
test('same bytes with different valid decoding cannot be linked to a task by SHA alone',()=>{
  const both=Buffer.concat([Buffer.from('Code Location,Title\na,'),Buffer.from([0xc2,0xa9]),Buffer.from('\n')]);
  const source=createSource(both,'app','all',{encoding:'utf-8'}),raw=readScanInput(both,{encoding:'gb18030'});
  assert.equal(source.sha256,raw.sha256);assert.notDeepEqual(source.rows[0].cells,raw.rows[0]);
  assert.throws(()=>assertSourceMatches(source,raw),/解码解释/);
  assert.throws(()=>createSource(bytes,'app','all',{encoding:'auto'}),/确定/);
});

test('a failed encoding import retains internal raw evidence and never publishes a successful baseline',async t=>{
  const f=await taskFixture(t),second=await initTask(f.root,{projects:[f.project]}),bad=path.join(f.root,'invalid.csv');
  const invalid=Buffer.from([0xef,0xbb,0xbf,0x81]);await writeFile(bad,invalid);
  await assert.rejects(importTaskCsv(second.taskFile,{projectPath:f.project,mode:'upgrade',inputCsv:bad}),/严格解码/);
  const index=await readTask(second.taskFile),participant=index.participants[0];
  assert.equal(participant.attempts[0].status,'FAILED');assert.equal(participant.initialBatchId,null);
  const diagnostic=participant.attempts[0].diagnosticsPath;
  const rawDir=path.join(path.dirname(path.dirname(diagnostic)),'raw');
  const files=await readdir(rawDir);assert.equal(files.length,1);assert.deepEqual(await readFile(path.join(rawDir,files[0])),invalid);
});

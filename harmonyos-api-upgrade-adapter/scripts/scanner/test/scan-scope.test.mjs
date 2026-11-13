import { runScanInBatch } from './helpers/scan-batch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProject } from '../core/project.mjs';
import { cleanupScanDirectory } from '../core/scan-runner.mjs';
import { serializeError } from '../../shared/platform/errors.mjs';

async function setup(backend, directories) {
  const root=await mkdtemp(path.join(os.tmpdir(),'backend-scope-'));
  await writeFile(path.join(root,'build-profile.json5'),JSON.stringify({app:{products:[{name:'default'}]},
    modules:['entry','library'].map(name=>({name,srcPath:name}))}));
  for(const name of ['entry','library']) {
    await mkdir(path.join(root,name,'src/main/ets/keep'),{recursive:true});
    await writeFile(path.join(root,name,'src/main/module.json5'),JSON.stringify({module:{type:name==='library'?'har':'entry'}}));
    await writeFile(path.join(root,name,'src/main/ets/keep/A.ts'),'api(1);');
    await writeFile(path.join(root,name,'src/main/ets/Outside.ts'),'api(1);');
  }
  const project=await loadProject(root,'default',directories?['library/src/main/ets/keep']:[],['library'],'har');
  const fake=path.join(root,'scanner.mjs'), captured=path.join(root,'captured.jsonl');
  await writeFile(fake,`
import {mkdir,writeFile,readFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2),get=flag=>args[args.indexOf(flag)+1];
await appendFile(${JSON.stringify(captured)},JSON.stringify(args)+'\\n');
const backend=${JSON.stringify(backend)},files=args.includes('--scanFilePaths')?get('--scanFilePaths'):
 args.includes('--arkTsFiles')?get('--arkTsFiles'):null;
if(files && Buffer.byteLength(files)>16000) throw new Error('file arguments exceed safe command-line budget');
if(${directories} && !files) throw new Error('directory selection requires a file-level backend call');
if(files && args.includes('--modulePaths')) throw new Error('module paths override precise file selection');
if(files && files.split(',').some(file=>path.relative(${JSON.stringify(root)},file).split(path.sep)[0]==='entry')) throw new Error('entry entered the scan');
if(args.includes('--modulePaths') && get('--modulePaths').split(',').some(file=>path.basename(file)!=='library')) throw new Error('unexpected module');
const out=get(backend==='index'?'--outPath':'--outputPath');
const changes=JSON.parse(await readFile(get(backend==='index'?'--apiModifiedPath':'--apiModifiedPath'),'utf8'));
if(backend==='index') {
 const config=JSON.parse(await readFile(get('--configPath'),'utf8'));
 if(!Array.isArray(config.projectPath)||config.projectPath.some(file=>path.basename(file)!=='library'))throw new Error('wrong index module context');
}
await mkdir(out,{recursive:true});
const location='library/src/main/ets/keep/A.ts:1';
if(backend==='index') await writeFile(path.join(out,'report.csv'),'Api Name,Api Type,Api File Path,Api Prefix,Api Params,API Args,Invoke Method,Invoke Location,Api Key,Invoke Instance,ChangeId,MethodDefinition\\n'+
 'api,method,a.d.ts,A,,,api,'+location+',key,,"'+changes[0].interfaceChanges.id+'","api(): void"\\n');
else await writeFile(path.join(out,'report.csv'),'Api Definition,Language,Changed in SDK,Affected Versions,Title,Code Location,Fixed,Change Type,ChangeId\\n'+
 'api(): void,ArkTS,6.1.0(23),ALL,scope,'+location+',Unfixed,API Behavior Change,'+changes[0].interfaceChanges.id+'\\n');
`);
  const api={implementLanguage:'typeScript',completePath:'/sdk/a.d.ts',className:'A',interfaceType:'method',interfaceName:'api',methodDefinition:'api(): void'};
  const rule={provider:'DEVECO',ruleId:'scope-rule',changedInSdk:'6.1.0(23)',affectedVersions:'ALL',changeType:'API Behavior Change',
    changeOperation:'API_BEHAVIOR',sourceReference:'a.md:1',title:'scope',url:'',rawEntry:{id:'scope-rule',affectedApis:[api],interfaceChanges:{id:'scope-id'}}};
  return {root,project,captured,rule,toolchain:{apiChangeScan:fake,apiChangeBackend:backend,analyzerRoot:root,sdkRoot:'/sdk',
    sdkFamilies:{openharmony:'/sdk/ohos',hms:'/sdk/hms'},fileScanSupported:true}};
}

const range={start:{platformVersion:'6.0.2',apiLevel:22,channel:'release',channelNumber:0},
  end:{platformVersion:'26.0.0',apiLevel:26,channel:'release',channelNumber:0}};

test('an index without file filtering scans only selected whole modules and rejects narrow directories',async()=>{
  const f=await setup('index',false);f.toolchain.fileScanSupported=false;
  await runScanInBatch('upgrade', {...f,rules:[f.rule],range,mode:'upgrade',outputDirectory:f.root});
  const commands=(await readFile(f.captured,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(commands.length,1);assert.ok(!commands[0].includes('--scanFilePaths'));
  const narrow=await setup('index',true);narrow.toolchain.fileScanSupported=false;
  await assert.rejects(runScanInBatch('upgrade', {...narrow,rules:[narrow.rule],range,outputDirectory:narrow.root}),{code:'SCAN_SCOPE_UNSUPPORTED'});
  f.project.sourceScope.scanDirs=[f.project.selectedModules[0].root];
  await runScanInBatch('upgrade', {...f,rules:[f.rule],range,mode:'upgrade',outputDirectory:f.root});
});

test('module and directory selections reach both DevEco backends without scanning entry',async()=>{
  for(const backend of ['integrated','index']) for(const directories of [false,true]) {
    const f=await setup(backend,directories);
    const result=await runScanInBatch('upgrade', {...f,rules:[f.rule],range,mode:'upgrade',outputDirectory:f.root});
    const commands=(await readFile(f.captured,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(commands.length,1);assert.equal(result.findings.length,1);
    const expected=backend==='index'?'--scanFilePaths':directories?'--arkTsFiles':'--modulePaths';
    assert.ok(commands[0].includes(expected));
    assert.equal(result.findings[0]['Code Location'],'library/src/main/ets/keep/A.ts:1');
  }
});

test('precise file scopes are batched and unsupported file backends never widen the scope',async()=>{
  const f=await setup('index',true), module=f.project.selectedModules[0];
  f.project.sourceFiles.push(...Array.from({length:500},(_,i)=>path.join(module.root,'src/main/ets/keep',`VeryLongFileName${'x'.repeat(60)}${i}.ts`)));
  await runScanInBatch('upgrade', {...f,rules:[f.rule],range,mode:'upgrade',outputDirectory:f.root});
  const commands=(await readFile(f.captured,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(commands.length>1);
  for(const args of commands)assert.ok(Buffer.byteLength(args[args.indexOf('--scanFilePaths')+1])<=16000);
  const unsupported=await setup('integrated',true);unsupported.toolchain.fileScanSupported=false;
  await assert.rejects(runScanInBatch('upgrade', {...unsupported,rules:[unsupported.rule],range,outputDirectory:unsupported.root}),{code:'SCAN_SCOPE_UNSUPPORTED'});
});

test('temporary cleanup retries locks and never replaces a scan result or its original error',async()=>{
  let calls=0;
  assert.equal(await cleanupScanDirectory('temporary',async()=>{
    if(++calls<3)throw Object.assign(new Error('busy'),{code:'EBUSY'});
  }),null);
  assert.equal(calls,3);
  const f=await setup('integrated',false);
  const removeTemporary=async()=>{throw Object.assign(new Error('locked'),{code:'EPERM'});};
  const result=await runScanInBatch('upgrade', {...f,rules:[f.rule],range,mode:'upgrade',outputDirectory:f.root,removeTemporary});
  assert.equal(result.findings.length,1);
  assert.equal(result.diagnostics.cleanupWarning.code,'SCAN_TEMP_CLEANUP_FAILED');
  assert.ok(result.diagnostics.warnings.some(value=>value.includes('locked')));
  await assert.rejects(runScanInBatch('upgrade', {...f,rules:[f.rule],range,outputDirectory:f.root,removeTemporary,
    verifyInputs:async()=>{throw Object.assign(new Error('original scan error'),{code:'SOURCE_CHANGED'});}}),error=>{
    assert.equal(error.code,'SOURCE_CHANGED');
    assert.equal(serializeError(error).cleanupWarning.errorCode,'EPERM');
    return true;
  });
});

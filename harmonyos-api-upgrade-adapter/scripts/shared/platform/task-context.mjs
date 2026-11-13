import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {link,lstat,mkdir,readFile,realpath,rmdir,writeFile,unlink} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicWrite,pathExists,sha256} from '../io/fs-utils.mjs';
import {samePath,normalizeComparablePath} from './paths.mjs';
import {errorWithCode} from './errors.mjs';
import {requireScanMode} from './scan-mode.mjs';
import {readScanInput} from '../format/scan-input.mjs';
import {batchArtifactPaths,createScanBatch,ensureBatchDirectory,assertBatchDirectory} from './artifact-layout.mjs';

const invalid=details=>errorWithCode('任务上下文无效或目录已变化','TASK_CONTEXT_INVALID',details);
const json=file=>readFile(file,'utf8').then(JSON.parse);
const writeJson=async(file,data)=>{
  const content=JSON.stringify(data,null,2)+'\n';await atomicWrite(file,content);
  if(await readFile(file,'utf8')!==content)throw invalid({file,reason:'任务索引回读不一致'});
};
const rootLayout=directory=>({scanDirectory:directory});

async function publishExclusive(file,bytes) {
  const staged=path.join(path.dirname(file),`.scan-${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(staged,bytes,{flag:'wx'});
  try {await link(staged,file);}
  finally {await unlink(staged);}
}

export function runTimestamp(now=new Date()) {
  const pad=value=>String(value).padStart(2,'0');
  return `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function createRunOutputDirectory(root) {
  await mkdir(root,{recursive:true});
  const base=runTimestamp();
  for(let i=1;;i++) {
    const directory=path.join(root,i===1?base:`${base}-${i}`);
    try {await mkdir(directory);return {directory,stamp:path.basename(directory)};}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
}

async function physicalCandidate(file) {
  try {return await realpath(file);}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    const parent=path.dirname(file);
    if(parent===file)throw error;
    return path.join(await physicalCandidate(parent),path.basename(file));
  }
}

function directoryKey(name) {
  let key=name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'') || 'project';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(key))key='_'+key;
  return key;
}

export async function initTask(taskRoot,{outputRoot=null,projects=[],mode='upgrade'}={}) {
  if (!taskRoot) throw errorWithCode('init-task 必须提供任务启动根目录','TASK_ROOT_REQUIRED');
  requireScanMode(mode);
  taskRoot=path.resolve(taskRoot);
  const physicalRoot=await realpath(taskRoot);
  const output=outputRoot?path.resolve(taskRoot,outputRoot):path.join(taskRoot,'.api-change-output');
  await mkdir(output,{recursive:true});
  const physicalOutput=await realpath(output),{directory}=await createRunOutputDirectory(output);
  const taskFile=path.join(directory,'.internal','task.json');
  await ensureBatchDirectory(rootLayout(directory),path.dirname(taskFile));
  const task={schemaVersion:1,taskId:randomBytes(6).toString('hex'),taskRoot,physicalRoot,outputRoot:output,physicalOutput,
    taskDirectory:directory,physicalDirectory:await realpath(directory),taskFile,createdAt:new Date().toISOString(),participants:[]};
  for(const project of projects) await participant(task,{projectPath:path.resolve(taskRoot,project),mode},true);
  await writeFile(taskFile,JSON.stringify(task,null,2)+'\n',{flag:'wx'});
  return task;
}

export async function readTask(taskFile) {
  if(!taskFile)throw errorWithCode('scan 必须提供 --task；请先 init-task','TASK_CONTEXT_REQUIRED');
  taskFile=path.resolve(taskFile);
  const directory=path.dirname(path.dirname(taskFile));
  try {
    await assertBatchDirectory(rootLayout(directory),path.dirname(taskFile));
    const info=await lstat(taskFile);
    if(!info.isFile() || info.isSymbolicLink())throw invalid({taskFile});
    const task=await json(taskFile);
    if(task.schemaVersion!==1 || !/^[a-f0-9]{12}$/.test(task.taskId) || !Array.isArray(task.participants)
      || !samePath(task.taskFile,taskFile) || !samePath(task.taskDirectory,directory)
      || !samePath(task.outputRoot,path.dirname(directory)) || !samePath(task.physicalDirectory,await realpath(directory))
      || !samePath(task.physicalOutput,await realpath(task.outputRoot)) || !samePath(task.physicalRoot,await realpath(task.taskRoot)))
      throw invalid({taskFile});
    return task;
  } catch(error){if(error.code==='TASK_CONTEXT_INVALID')throw error;throw invalid({taskFile,reason:error.message});}
}

async function locked(taskFile,action) {
  const task=await readTask(taskFile),lock=path.join(task.taskDirectory,'.internal','.task-lock');
  for(let i=0;;i++) {
    try {await mkdir(lock);break;}
    catch(error){if(error.code!=='EEXIST')throw error;if(i===199)throw errorWithCode('任务索引正在更新','TASK_BUSY');await delay(25);await readTask(taskFile);}
  }
  try {return await action(await readTask(taskFile));}
  finally {await rmdir(lock);}
}

async function participant(task,options,declared=false) {
  const {mode}=options;requireScanMode(mode);
  const projectRoot=path.resolve(options.projectPath),physicalRoot=await physicalCandidate(projectRoot);
  if(task.participants.some(item=>item.mode===mode && samePath(item.projectRoot,projectRoot) && !samePath(item.physicalRoot,physicalRoot)))
    throw errorWithCode('已登记工程的物理目录已变化','TASK_PROJECT_CHANGED');
  const inputs={projectRoot:normalizeComparablePath(physicalRoot),product:options.productName ?? 'default',projectType:options.projectType ?? 'app',
    scanModules:[...new Set(options.scanModules ?? [])].sort(),
    scanDirs:[...new Set(await Promise.all((options.scanDirs ?? []).map(async dir=>normalizeComparablePath(await physicalCandidate(path.resolve(projectRoot,dir))))))].sort()};
  const identity=sha256(JSON.stringify(inputs));
  let item=task.participants.find(item=>item.mode===mode && (declared?samePath(item.physicalRoot,physicalRoot)
    :item.identity===identity || item.identity===null && samePath(item.physicalRoot,physicalRoot)));
  if (item) {
    if(!declared){item.identity=identity;item.inputs=inputs;}
    return item;
  }
  const base=directoryKey(path.basename(projectRoot));
  let projectKey=base;
  if(task.participants.some(item=>item.mode===mode && item.projectKey.toLowerCase()===projectKey.toLowerCase())) projectKey=`${base}-${identity.slice(0,8)}`;
  if(task.participants.some(item=>item.mode===mode && item.projectKey.toLowerCase()===projectKey.toLowerCase()))
    throw errorWithCode('工程目录短标识冲突','TASK_PROJECT_CONFLICT');
  item={mode,projectRoot,physicalRoot,projectKey,identity:declared?null:identity,inputs:declared?null:inputs,
    initialBatchId:null,status:'NOT_STARTED',attempts:[]};
  task.participants.push(item);return item;
}

function layoutFor(task,item,attempt) {
  return batchArtifactPaths(task.taskDirectory,attempt.batchId,item.mode,{projectKey:item.projectKey,scanPurpose:attempt.scanPurpose,
    taskFile:task.taskFile,projectRoot:item.projectRoot});
}

export async function registerTaskProject(taskFile,options) {
  return locked(taskFile,async task=>{
    const item=await participant(task,options,true);await writeJson(task.taskFile,task);
    return {taskFile:task.taskFile,taskDirectory:task.taskDirectory,projectKey:item.projectKey,
      deliveryDirectory:path.join(task.taskDirectory,item.mode,item.projectKey),taskReportPath:path.join(task.taskDirectory,item.mode,'api-adapt-report.html')};
  });
}

export async function beginTaskScan(taskFile,options) {
  const purpose=options.scanPurpose ?? 'initial';
  if(!['initial','rescan'].includes(purpose) || purpose==='rescan' && options.mode!=='deprecated')
    throw errorWithCode('仅废弃流程支持 rescan','SCAN_PURPOSE_INVALID');
  return locked(taskFile,async task=>{
    if(options.outputRoot && !samePath(path.resolve(task.taskRoot,options.outputRoot),task.outputRoot))
      throw errorWithCode('输出根与任务上下文冲突','TASK_OUTPUT_CONFLICT');
    const item=await participant(task,options);
    if(purpose==='initial' && item.initialBatchId) throw errorWithCode('已有初始扫描；继续使用原表，废弃复扫请指定 rescan','TASK_BASELINE_EXISTS');
    if(purpose==='rescan' && !item.initialBatchId)throw errorWithCode('复扫需要已完成的初始扫描','TASK_BASELINE_REQUIRED');
    let exclusionOptions = { excludeDirs: options.excludeDirs ?? [], exclusionPolicy: 'tooling-v1' };
    if (purpose === 'rescan' && options.origin !== 'IMPORTED_CSV') {
      const scan = await json(item.outputLayout.scanJson).catch(error => {
        if (error.code === 'ENOENT') throw errorWithCode('旧基线没有可核实的扫描范围；请新建扫描任务', 'SCAN_SCOPE_UNKNOWN');
        throw error;
      });
      if (scan.batchId !== item.initialBatchId || scan.mode !== item.mode || !scan.sourceScope)
        throw errorWithCode('旧基线扫描范围无法核实；请新建扫描任务', 'SCAN_SCOPE_UNKNOWN');
      const baseline = item.attempts.find(attempt => attempt.batchId === item.initialBatchId);
      if (baseline?.scopeSha256 && sha256(JSON.stringify(scan.sourceScope)) !== baseline.scopeSha256)
        throw errorWithCode('初始扫描范围证据已变化', 'SCAN_SCOPE_CHANGED');
      const prior = scan.sourceScope;
      const normalize = async directories => [...new Set(await Promise.all(directories.map(async directory =>
        normalizeComparablePath(await physicalCandidate(path.resolve(item.projectRoot, directory))))))].sort();
      if (options.excludeDirs !== undefined && JSON.stringify(await normalize(options.excludeDirs)) !== JSON.stringify(await normalize(prior.excludeDirs ?? [])))
        throw errorWithCode('复扫不能改变初始基线的排除目录；请新建扫描任务', 'SCAN_SCOPE_CHANGED');
      exclusionOptions = { excludeDirs: prior.excludeDirs ?? [], exclusionPolicy: prior.exclusionPolicy ?? 'legacy' };
    }
    for(const old of item.attempts.filter(old=>old.status==='RUNNING')) {
      try {process.kill(old.pid,0);throw errorWithCode('同一工程已有扫描正在执行','TASK_SCAN_BUSY');}
      catch(error){if(error.code!=='ESRCH')throw error;old.status='INTERRUPTED';}
    }
    const layout=await createScanBatch(task.outputRoot,task.taskDirectory,{mode:options.mode,projectKey:item.projectKey,
      scanPurpose:purpose,taskFile:task.taskFile,projectRoot:item.projectRoot});
    item.attempts.push({batchId:layout.batchId,batchMetadataSha256:layout.batchMetadataSha256,
      scanPurpose:purpose,origin:options.origin ?? 'SCANNER',status:'RUNNING',pid:process.pid,
      createdAt:layout.createdAt,diagnosticsPath:layout.diagnosticsJson});
    if(purpose==='initial')item.status='SCANNING';
    await writeJson(task.taskFile,task);return {...layout,exclusionOptions,taskRoot:task.taskRoot,outputRoot:task.outputRoot,taskId:task.taskId};
  });
}

export async function completeTaskScan(taskFile,batchId,{error=null,source=null,writeIndex=writeJson}={}) {
  return locked(taskFile,async task=>{
    const item=task.participants.find(item=>item.attempts.some(attempt=>attempt.batchId===batchId));
    const attempt=item?.attempts.find(attempt=>attempt.batchId===batchId);
    if(!attempt || attempt.status!=='RUNNING')throw errorWithCode('扫描尝试不存在或已经结束','TASK_SCAN_INVALID');
    const layout=layoutFor(task,item,attempt);
    await assertBatchDirectory(layout,layout.batchDirectory);
    const metadata=await lstat(layout.batchMetadataPath);
    if(!metadata.isFile() || metadata.isSymbolicLink() || sha256(await readFile(layout.batchMetadataPath))!==attempt.batchMetadataSha256)
      throw invalid({path:layout.batchMetadataPath,reason:'扫描批次元数据已变化'});
    let published=null;
    try {
      if(error) {
        attempt.status='FAILED';attempt.error={code:error.code ?? 'SCAN_FAILED',message:error.message};
        if(attempt.scanPurpose==='initial')item.status='SCAN_FAILED';
      } else {
        await assertBatchDirectory(layout,path.dirname(layout.workRawCsv));
        const info=await lstat(layout.workRawCsv);
        if(!info.isFile() || info.isSymbolicLink())throw invalid({path:layout.workRawCsv});
        const bytes=await readFile(layout.workRawCsv);
        if(attempt.scanPurpose==='initial') {
          if(item.initialBatchId)throw errorWithCode('初始扫描已发布','TASK_BASELINE_EXISTS');
          await ensureBatchDirectory(layout,layout.deliveryDirectory);
          await publishExclusive(layout.rawCsv,bytes);
          published=sha256(bytes);
          if(sha256(await readFile(layout.rawCsv))!==sha256(bytes))throw errorWithCode('原始扫描发布回读失败','SCAN_READBACK_FAILED');
          item.initialBatchId=batchId;item.status=attempt.origin==='IMPORTED_CSV'?'IMPORTED':'SCANNED';item.outputLayout=layout;
        }
        if (attempt.origin === 'SCANNER' && await pathExists(layout.scanJson)) {
          const scanBytes = await readFile(layout.scanJson), scan = JSON.parse(scanBytes.toString('utf8'));
          attempt.scanJsonSha256 = sha256(scanBytes);
          if (scan.sourceScope) attempt.scopeSha256 = sha256(JSON.stringify(scan.sourceScope));
        }
        attempt.status='SUCCEEDED';attempt.rawCsv=layout.rawCsv;attempt.sha256=sha256(bytes);
        if(source)attempt.source=source;
      }
      attempt.completedAt=new Date().toISOString();await writeIndex(task.taskFile,task);
      return {...layout,taskRoot:task.taskRoot,outputRoot:task.outputRoot,taskId:task.taskId};
    } catch(failure) {
      const current=await json(task.taskFile).catch(()=>null);
      const indexed=current?.participants?.some(project=>project.initialBatchId===batchId);
      if(published && !indexed && await pathExists(layout.rawCsv)) {
        try {
          if(sha256(await readFile(layout.rawCsv))===published)await unlink(layout.rawCsv);
        } catch(cleanupError){failure.cleanupWarning={path:layout.rawCsv,message:cleanupError.message};}
      }
      throw failure;
    }
  });
}

export async function importTaskCsv(taskFile,{inputCsv,evidenceFiles=[],encoding='auto',...options}) {
  const layout=await beginTaskScan(taskFile,{...options,origin:'IMPORTED_CSV'});
  try {
    const original=path.resolve(inputCsv),bytes=await readFile(original),parsed=path.parse(original),files=[];
    await ensureBatchDirectory(layout,path.dirname(layout.workRawCsv));await writeFile(layout.workRawCsv,bytes,{flag:'wx'});
    const decoded=readScanInput(bytes,{encoding});
    const csv={encoding:decoded.encoding,bom:decoded.bom,interpretationSha256:decoded.interpretationSha256};
    const candidates=[path.join(parsed.dir,`${parsed.name}.scan.json`),path.join(parsed.dir,`${parsed.name}.validation.csv`),
      path.join(parsed.dir,'coverage.json'),path.join(parsed.dir,'diagnostics.json'),path.join(parsed.dir,'scan-batch.json')];
    for(const file of evidenceFiles) {
      const absolute=path.resolve(file);
      if(!await pathExists(absolute))throw errorWithCode('指定导入证据不存在','IMPORT_EVIDENCE_MISSING',{path:absolute});
      candidates.push(absolute);
    }
    for(const file of new Set(candidates)) if(await pathExists(file)) {
      const directory=path.join(layout.batchDirectory,'imported');await ensureBatchDirectory(layout,directory);
      const content=await readFile(file),copy=path.join(directory,`${files.length+1}-${path.basename(file)}`);await writeFile(copy,content,{flag:'wx'});
      if(sha256(await readFile(copy))!==sha256(content))throw errorWithCode('导入证据回读失败','SCAN_READBACK_FAILED');
      files.push({original:file,path:copy,sha256:sha256(content)});
    }
    const outputLayout=await completeTaskScan(taskFile,layout.batchId,{source:{originalPath:original,sha256:sha256(bytes),files,csv}});
    return {outputCsv:outputLayout.rawCsv,batchId:layout.batchId,outputLayout,csv};
  } catch(error){await completeTaskScan(taskFile,layout.batchId,{error});throw error;}
}

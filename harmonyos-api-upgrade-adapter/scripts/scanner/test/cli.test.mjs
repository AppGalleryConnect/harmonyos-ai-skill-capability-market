import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {readTask} from '../../shared/platform/task-context.mjs';
import {
  createRunOutputDirectory,
  execute,
  resolveScanTargetVersion,
  runTimestamp,
  selectScanRules,
} from '../core/cli.mjs';

test('uses an explicit scan target before the exact toolchain channel', () => {
  assert.deepEqual(resolveScanTargetVersion('26.0.0(26) Beta1', { sdkVersion: { raw: '26.0.0(26) Beta2' } }),
    { version: '26.0.0(26) Beta1', source: 'to' });
  assert.deepEqual(resolveScanTargetVersion(null, { sdkVersion: { raw: '26.0.0(26) Beta2' } }),
    { version: '26.0.0(26) Beta2', source: 'toolchain' });
});

test('rejects unsupported batch sizes instead of pretending they are applied', async () => {
  await assert.rejects(() => execute([
    'scan', '--mode', 'upgrade', '--project', '/project', '--sdk', '/sdk', '--from', '5.0.0(12)', '--to', '5.0.1(13)',
    '--batch-size', '500',
  ]), /supports --batch-size 1000 only/);
});

test('validates the C++ module budget before starting a scan', async () => {
  for (const seconds of ['59', '1801', '90.5']) await assert.rejects(() => execute([
    'scan', '--mode', 'upgrade', '--project', os.tmpdir(), '--sdk', os.tmpdir(), '--from', '6.0.0(20)',
    '--cpp-module-timeout-seconds', seconds,
  ]), /--cpp-module-timeout-seconds/);
});

test('rejects unsupported scan modes', async () => {
  await assert.rejects(() => execute([
    'scan', '--project', '/project', '--sdk', '/sdk', '--from', '5.0.0(12)', '--to', '5.0.1(13)',
    '--mode', 'behavior-only',
  ]), { code: 'SCAN_MODE_INVALID' });
});

test('deprecated mode keeps only deprecated rules for the DevEco backend', () => {
  const rules = [
    { ruleId: 'behavior', changeType: 'API Behavior Change', changeOperation: 'API_BEHAVIOR', affectedApis: [{ implementLanguage: 'typescript' }] },
    { ruleId: 'definition', changeType: 'API Definition Change', changeOperation: 'API_DEFINITION_CHANGED', affectedApis: [{ implementLanguage: 'typescript' }] },
    { ruleId: 'deprecated-arkts', changeType: 'Deprecated API', changeOperation: 'API_DEPRECATED', affectedApis: [{ implementLanguage: 'typescript' }] },
    { ruleId: 'deprecated-cpp', changeType: 'Deprecated API', changeOperation: 'API_DEPRECATED', affectedApis: [{ implementLanguage: 'c' }] },
  ];
  assert.deepEqual(selectScanRules(rules, 'deprecated').map(rule => rule.ruleId), ['deprecated-cpp']);
  assert.throws(() => selectScanRules(rules, 'full'), {code:'SCAN_MODE_INVALID'});
});

test('run timestamps use local YYYYMMDDHHmmss and increment on collision', async () => {
  const now = new Date(2026, 6, 29, 8, 23, 50);
  assert.equal(runTimestamp(now), '20260729082350');
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-run-dir-'));
  const first = await createRunOutputDirectory(root);
  const second = await createRunOutputDirectory(root);
  assert.match(first.stamp, /^\d{14}$/);
  assert.equal(second.stamp, `${first.stamp}-2`);
  const nested = await readdir(path.join(root, first.stamp));
  assert.deepEqual(nested, []);
});

test('scan failures identify the pipeline stage in the error and diagnostics', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  await mkdir(output, { recursive: true });
  const task=await execute(['init-task','--task-root',root,'--output-dir',output]);
  await assert.rejects(execute([
    'scan', '--task', task.taskFile, '--mode', 'upgrade', '--project', path.join(root, 'project'), '--sdk', path.join(root, 'missing-sdk'),
    '--from', '5.0.0(12)', '--to', '26.0.0(26) Beta1', '--output-dir', output,
  ]), error => {
    assert.equal(error.stage, 'DISCOVER_TOOLCHAIN');
    return true;
  });
  const runDirectories = (await readdir(output)).filter(name => /^\d{14}(?:-\d+)?$/.test(name));
  assert.equal(runDirectories.length, 1);
  const state=await readTask(task.taskFile);
  const diagnostics = JSON.parse(await readFile(state.participants[0].attempts[0].diagnosticsPath, 'utf8'));
  assert.equal(diagnostics.error.stage, 'DISCOVER_TOOLCHAIN');
  const skillRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  assert.equal(diagnostics.runtime.skillRoot, skillRoot);
  assert.equal(diagnostics.options.referenceRoot, path.join(skillRoot, 'references', 'changelogs'));
});

for(const mode of ['upgrade','deprecated']) test(`${mode} CLI reserves a feature batch before backend discovery`,async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'scanner-batch-'));
  const task=await execute(['init-task','--task-root',root,'--output-dir',root]);
  t.after(()=>rm(root,{recursive:true,force:true}));
  try {
    await execute(['scan','--task',task.taskFile,'--project',path.join(root,'project'),'--sdk',path.join(root,'missing-sdk'),
      '--from','22','--to','26','--mode',mode,'--output-dir',root]);
    assert.fail('missing SDK must fail');
  } catch(error) { assert.equal(error.code,'SDK_ROOT_INVALID'); }
  const folders=(await readdir(root)).filter(name=>/^\d{14}(?:-\d+)?$/.test(name));
  assert.equal(folders.length,1);
  const scan=path.join(root,folders[0]);
  const state=await readTask(task.taskFile),attempt=state.participants[0].attempts[0];
  const metadata=JSON.parse(await readFile(path.join(scan,'.internal',mode,'project','scans',attempt.batchId,'scan-batch.json'),'utf8'));
  assert.equal(metadata.taskFile,task.taskFile);
  assert.equal(metadata.mode,mode);
  if(mode==='deprecated') assert.equal(metadata.scanStamp,folders[0]);
  await assert.rejects(readdir(path.join(scan, mode)), {code:'ENOENT'});
  assert.match(metadata.batchId,/^[a-f0-9]{12}$/);
  const diagnostics=JSON.parse(await readFile(attempt.diagnosticsPath,'utf8'));
  assert.equal(diagnostics.error.code,'SDK_ROOT_INVALID');
  assert.equal(diagnostics.runtime.featureMode,mode);
  assert.equal(diagnostics.error.artifactPaths[0],attempt.diagnosticsPath);
  await assert.rejects(readFile(path.join(scan,'diagnostics.json')),{code:'ENOENT'});
});

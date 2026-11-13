import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { caseSnapshot, fixture } from './fixtures/runtime/plan.mjs';
import { archivePackage, freezeRun, verifyRun } from '../../runtime/runs.mjs';
import { executeRun } from '../../runtime/execute.mjs';
import { installHap } from '../../runtime/install.mjs';
import { writeJson } from '../../runtime/io.mjs';
import { writeReport } from '../../runtime/report.mjs';
import { createSource } from '../../runtime/contracts.mjs';
import { hap } from './fixtures/runtime/hap.mjs';
import { packageIdentity, checkInstalled, checkDeclaration } from '../../runtime/package-identity.mjs';
import { auditRun } from '../../runtime/report.mjs';
import { fingerprint } from '../../runtime/io.mjs';
import { runProcess } from '../platform/process.mjs';

const localPython = process.env.RUNTIME_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

async function runFixture(t, plan = fixture()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "runtime 中文 '&-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifact = path.join(dir, 'app-unsigned.hap'), source = path.join(dir, 'source.json5'), log = path.join(dir, 'build.log');
  await writeFile(artifact, hap(22)); await writeFile(source, 'target=22'); await writeFile(log, 'BUILD SUCCESSFUL');
  const packages = path.join(dir, 'packages');
  const info = { original: true, product: 'default', module: 'entry', package: 'example.app', ability: 'Ability',
    target: '22', compatible: '22', sourceDescription: '原始工作区，修改前归档', inputs: [source],
    artifacts: [{ path: artifact, signed: false }], build: { command: 'hvigorw assembleApp', cwd: dir, log, exitCode: 0 } };
  await archivePackage(packages, 'before', { ...info, phase: 'before' });
  await writeFile(artifact, hap(26));
  await archivePackage(packages, 'after', { ...info, original: false, phase: 'after', target: '26' });
  const root = await freezeRun(dir, plan, { packagesDirectory: packages, mode: 'COMPARE', scripts: { C1: caseSnapshot },
    device: { serial: 'SERIAL', api: '26', kind: 'emulator', instance: 'API26Phone' }, python: localPython, runId: 'R1' });
  return { dir, root, packages, info };
}
async function reseal(root, manifest) {
  const file = path.join(root, 'manifest.json');
  await writeJson(file, manifest);
  await writeJson(path.join(root, 'manifest-digest.json'), { sha256: await fingerprint(file) });
}

test('本地命令限制冻结解释器和HDC，重算归档哈希不能扩大执行范围', async t => {
  const { root } = await runFixture(t), { manifest } = await verifyRun(root);
  let calls = 0;
  const invoke = async () => { calls++; };
  for (const key of ['python', 'hdc']) {
    await reseal(root, { ...manifest, [key]: path.join(root, 'archive-executable') });
    await assert.rejects(executeRun(root, { python: localPython, invoke }), /本地指定的Python\/HDC/);
  }
  assert.equal(calls, 0);
});

test('真实worker在安装或连接设备前拒绝未知操作', async t => {
  const { root } = await runFixture(t), { manifest } = await verifyRun(root);
  const relative = path.join('scripts', 'C1.json'), file = path.join(root, relative);
  await writeJson(file, { ...JSON.parse(caseSnapshot), scenarios: [{ op: '__class__' }] });
  manifest.hashes[relative] = await fingerprint(file);
  await reseal(root, manifest);
  const commands = [];
  const result = await executeRun(root, { python: localPython, invoke: async (command, args, options) => {
    commands.push({ command, args, cwd: options.cwd });
    return args.includes('check') ? runProcess(command, args, options) : { exitCode: 1, stderr: 'unexpected command' };
  } });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /未知设备操作/);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, localPython);
  assert.deepEqual(commands[0].args.slice(0, 4), [
    '-I', '-B', fileURLToPath(new URL('../../runtime/python/worker.py', import.meta.url)), 'check',
  ]);
  assert.equal(commands[0].cwd, path.dirname(commands[0].args[2]));
});
test('冻结拒绝关闭计时器及其他非法用例超时', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [i, timeoutMs] of [0, -1, 0.5, 600_001, Infinity, NaN, '100', null].entries()) {
    const plan = fixture();
    plan.cases.cases[0].timeoutMs = timeoutMs;
    await assert.rejects(freezeRun(directory, plan, { packagesDirectory: path.join(directory, 'missing'), mode: 'AFTER_ONLY',
      scripts: { C1: caseSnapshot }, device: { serial: 'SERIAL', api: '26', kind: 'emulator', instance: 'API26' },
      python: 'python3', runId: 'timeout-' + i }), /timeoutMs/);
  }
});
test('执行前复核已冻结用例的超时，归档重算哈希后仍拒绝零超时', async t => {
  const { root } = await runFixture(t), { manifest, plan } = await verifyRun(root);
  const file = path.join(root, 'inputs', 'plan.json');
  plan.cases.cases[0].timeoutMs = 0;
  await writeJson(file, plan);
  manifest.hashes['inputs/plan.json'] = await fingerprint(file);
  await reseal(root, manifest);
  await assert.rejects(executeRun(root, { python: localPython, invoke: async () => {
    assert.fail('无效超时不得启动进程');
  } }), /timeoutMs/);
});
test('阶段包只归档一次，冻结内容和包字节独立保留并检查漂移', async t => {
  const f = await runFixture(t), run = await verifyRun(f.root);
  assert.equal((await packageIdentity(path.join(f.root, run.manifest.packages.before.artifacts[0].path), 'entry')).target, 22);
  await assert.rejects(archivePackage(f.packages, 'before', { ...f.info, phase: 'before' }));
  await writeFile(path.join(f.root, 'scripts', 'C1.json'), 'changed');
  await assert.rejects(verifyRun(f.root), /冻结/);
});
test('执行按before→复位→after，未签名模拟器不进入签名工具', async t => {
  const { root } = await runFixture(t), commands = []; let phaseTarget = 22;
  const invoke = async (command, args) => {
    commands.push([command, ...args].join(' '));
    if (args.includes('run')) {
      const req = JSON.parse(await readFile(args.at(-1), 'utf8'));
      await writeJson(path.join(req.output, 'result.json'), { schemaVersion: 1, runId: 'R1', phase: req.phase,
        caseId: 'C1', attempt: 1, status: 'EXECUTED', observations: [], captures: [], startedAt: Date.now()/1000, finishedAt: Date.now()/1000 });
    }
    if (args.includes('install')) phaseTarget = args.at(-1).includes(path.join('packages','after')) ? 26 : 22;
    const info = JSON.stringify({ name: 'example.app', versionCode: 1, applicationInfo: { apiTargetVersion: phaseTarget, apiCompatibleVersion: 22 }, hapModuleInfos: [{name:'entry',mainElementName:'Ability'}] });
    return { exitCode: 0, stdout: args.includes('targets') ? 'SERIAL' : args.includes('get') ? '26' : args.includes('dump') ? info : 'example.app Ability install bundle successfully', stderr: '' };
  };
  await executeRun(root, { python: localPython, invoke });
  const events = JSON.parse(await readFile(path.join(root, 'execution.json'), 'utf8')).events;
  assert.deepEqual(events.filter(e => ['phase-start', 'reset', 'phase-end'].includes(e.type)).map(e => e.type + ':' + e.phase),
    ['phase-start:before', 'phase-end:before', 'reset:after', 'phase-start:after', 'phase-end:after']);
  assert.doesNotMatch(commands.join('\n'), /sign-app|sign-profile|keytool/);
});
test('设备/安装失败停止对比且不静默切换after-only', async t => {
  const { root } = await runFixture(t);
  const result = await executeRun(root, { python: localPython, invoke: async () => ({ exitCode: 1, stdout: '', stderr: 'offline' }) });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.events.some(e => e.phase === 'after'), false);
  assert.equal((await verifyRun(root)).manifest.mode, 'COMPARE');
});
test('安装双路回执冲突时阻断设备用例并保存完整输出', async t => {
  const { root, dir } = await runFixture(t), calls = [];
  const stdout = 'install bundle successfully', stderr = '[Fail] install bundle failed';
  const invoke = async (_command, args) => {
    calls.push(args);
    if (args.includes('install')) return { exitCode: 0, stdout, stderr };
    return { exitCode: 0, stdout: args.includes('targets') ? 'SERIAL' : args.includes('get') ? '26' : '', stderr: '' };
  };
  const run = await executeRun(root, { python: localPython, invoke });
  assert.equal(run.status, 'BLOCKED');
  assert.match(run.reason, /失败回执/);
  const install = run.events.find(event => event.type === 'command' && event.args.includes('install'));
  assert.deepEqual([install.exitCode, install.stdout, install.stderr], [0, stdout, stderr]);
  assert.equal(run.events.some(event => event.type === 'installed' || event.type === 'case-process'), false);

  const hapPath = path.join(dir, 'app-unsigned.hap');
  const result = await installHap({ hdc: process.execPath, serial: 'SERIAL', hap: hapPath,
    sha256: await fingerprint(hapPath), evidenceDir: path.join(dir, 'evidence') }, { invoke });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /失败回执/);
  const receipt = JSON.parse(await readFile(result.receipt, 'utf8'));
  assert.deepEqual(receipt.commands.find(command => command.args.includes('install')).output, { exitCode: 0, stdout, stderr });
  assert.equal(calls.some(args => args.includes('dump') || args.includes('run')), false);
});
test('缺原包仍可交付具名阻断和完整分母，不启动设备或补造before', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runtime-missing-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const p = fixture(), old = p.sources[0].sourceId;
  p.sources[0] = createSource(Buffer.from(p.sources[0].csvBase64, 'base64'), 'constructor', 'all');
  for (const group of [p.routeMap.routes, p.spec.points, p.cases.cases[0].assertions])
    for (const item of group) for (const ref of item.rowRefs) if (ref.sourceId === old) ref.sourceId = 'constructor';
  const root = await freezeRun(dir, p, { packagesDirectory: path.join(dir, 'missing'), mode: 'COMPARE', scripts: { C1: caseSnapshot },
    device: { serial: 'SERIAL', api: '26', kind: 'emulator', instance: 'API26Phone' }, python: 'python3', runId: 'missing' });
  let invoked = false;
  const execution = await executeRun(root, { python: 'python3', invoke: async () => { invoked = true; throw new Error('不应调用'); } });
  assert.equal(invoked, false); assert.equal(execution.status, 'BLOCKED');
  const summary = await writeReport(root, dir);
  assert.equal(summary.counts.selected, 2); assert.equal(summary.counts.complete, 0);
  const projection = JSON.parse(await readFile(path.join(root, 'screenshots-by-source.json'), 'utf8'));
  assert.ok(Object.hasOwn(projection, 'constructor'));
  assert.equal(summary.problems.some(p => p.includes('before')), true);
});

test('设备返回旧target时不能凭包名相同当作安装正确', () => {
  const expected = { bundle:'example.app',target:26,compatible:22,versionCode:1,module:'entry',ability:'Ability' };
  const info = JSON.stringify({ name:'example.app',versionCode:1,applicationInfo:{apiTargetVersion:22,apiCompatibleVersion:22},hapModuleInfos:[{name:'entry',mainElementName:'Ability'}] });
  assert.throws(() => checkInstalled(info, expected), /不一致/);
  assert.throws(() => checkDeclaration({targetApi:26,compatibleApi:22},{target:'6.0.2(22)',compatible:'6.0.2(22)'}), /不一致/);
});
test('阶段清单还在但HAP附件缺失时仍保留可报告的阻断run', async t => {
  const f = await runFixture(t);
  await rm(path.join(f.packages, 'before', '0-app-unsigned.hap'));
  const root = await freezeRun(f.dir, fixture(), {packagesDirectory:f.packages,mode:'COMPARE',scripts:{C1:caseSnapshot},
    device:{serial:'SERIAL',api:'26',kind:'emulator',instance:'API26Phone'},python:'python3',runId:'broken-attachment'});
  assert.equal((await verifyRun(root)).manifest.packageIssues.some(x => x.includes('before')), true);
  const result = await executeRun(root, { python: 'python3', invoke: async () => { throw Error('缺包不能启动设备'); } });
  assert.equal(result.status,'BLOCKED');
});
test('历史归档仍可报告，使用本地解码器并保留损坏截图对应的业务FAIL', async t => {
  const p = fixture(); p.cases.cases[0].capturePoints = [{id:'bad',assertionIds:['A1']}];
  const {root} = await runFixture(t,p); let target = 22;
  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
  const invoke = async (cmd,args) => {
    if (args.includes('install')) target = args.at(-1).includes(path.join('packages','after')) ? 26 : 22;
    if (args.includes('run')) {
      const req = JSON.parse(await readFile(args.at(-1),'utf8')), now = Date.now()/1000;
      const shot = path.join(req.output,'bad.png'), tree = path.join(req.output,'bad.json');
      await writeFile(shot, req.phase === 'before' ? validPng : 'truncated'); await writeFile(tree,'{}');
      await writeJson(path.join(req.output,'result.json'),{schemaVersion:1,runId:'R1',phase:req.phase,caseId:'C1',attempt:1,status:'EXECUTED',
        scriptSha256:await fingerprint(req.script),startedAt:now,finishedAt:now,dataState:{actual:{},expected:{}},
        observations:[{assertionId:'A1',actual:'wrong',expected:req.case.assertions[0][req.phase==='before'?'beforeExpected':'afterExpected'],status:'FAIL'}],
        captures:[{runId:'R1',phase:req.phase,caseId:'C1',attempt:1,captureId:'bad',time:now,screenshot:'bad.png',layoutTree:'bad.json',screenshotSha256:await fingerprint(shot),layoutSha256:await fingerprint(tree)}]});
    }
    const info=JSON.stringify({name:'example.app',versionCode:1,applicationInfo:{apiTargetVersion:target,apiCompatibleVersion:22},hapModuleInfos:[{name:'entry',mainElementName:'Ability'}]});
    return {exitCode:0,stdout:args.includes('targets')?'SERIAL':args.includes('get')?'26':args.includes('dump')?info:'install bundle successfully',stderr:''};
  };
  await executeRun(root, { python: localPython, invoke });
  const { manifest } = await verifyRun(root);
  delete manifest.caseFormat;
  manifest.python = path.join(root, 'archive-executable');
  const relative = path.join('scripts', 'C1.py'), script = path.join(root, relative);
  await writeFile(script, 'raise RuntimeError("归档旧用例不得执行")\n');
  manifest.hashes[relative] = await fingerprint(script);
  const archivedWorker = path.join('inputs', 'runtime', 'worker.py');
  await writeFile(path.join(root, archivedWorker), 'raise RuntimeError("归档worker不得执行")\n');
  manifest.hashes[archivedWorker] = await fingerprint(path.join(root, archivedWorker));
  for (const phase of ['before', 'after']) {
    const file = path.join(root, phase, 'cases', 'C1', 'attempts', '1', 'result.json');
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    await writeJson(file, { ...receipt, scriptSha256: manifest.hashes[relative] });
  }
  await reseal(root, manifest);
  const commands = [];
  const runLocal = async (command, args, options) => {
    commands.push({ command, args, cwd: options.cwd });
    return runProcess(command, args, options);
  };
  await assert.rejects(executeRun(root, { python: localPython, invoke: runLocal }), /历史Python用例只供报告/);
  assert.equal(commands.length, 0);
  const audited = await writeReport(root, root, { invoke: runLocal });
  assert.equal(commands.length, 2);
  for (const { command, args, cwd } of commands) {
    assert.equal(command, localPython);
    assert.deepEqual(args.slice(0, 4), [
      '-I', '-B', fileURLToPath(new URL('../../runtime/python/worker.py', import.meta.url)), 'image',
    ]);
    assert.equal(cwd, path.dirname(args[2]));
  }
  assert.match(await readFile(path.join(root, 'test-report.html'), 'utf8'), /scripts\/C1\.py/);
  assert.equal(audited.counts.afterFailed,2); assert.equal(audited.counts.complete,0);
  assert.equal(audited.rows[0].before.screenshots.length, 1);
  assert.equal(audited.rows[0].after.screenshots.length,0); assert.ok(audited.problems.some(x=>x.includes('图片')));
});

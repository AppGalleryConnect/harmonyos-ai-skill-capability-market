import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../platform/process.mjs';
import { prependPath } from '../platform/process.mjs';
import { compareTool } from '../../maintenance/regression/windows-tools.mjs';

test('Windows PATH keeps the original search path with exactly one case-insensitive key', () => {
  const original={Path:'C:\\Windows',OTHER:'kept'};
  const env=prependPath(original,['D:\\工具 空格'],'win32');
  assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='path'),['Path']);
  assert.equal(env.Path,'D:\\工具 空格;C:\\Windows');
  assert.equal(original.Path,'C:\\Windows');
  assert.equal(prependPath({Path:'old',PATH:'explicit'},['tools'],'win32').Path,'tools;explicit');
  assert.deepEqual(prependPath({Path:'unrelated',PATH:'/bin'},['/tools'],'darwin'),{Path:'unrelated',PATH:'/tools:/bin'});
});

test('output callbacks preserve stream arrival order, and spawn failure is explicit', async () => {
  const output=[];
  const result=await runProcess(process.execPath,['-e',"process.stdout.write('中文');setTimeout(()=>process.stderr.write('error'),30);setTimeout(()=>process.stdout.write('done'),60)"],
    {onOutput:(chunk,stream)=>output.push([chunk,stream]),timeoutMs:3000});
  assert.equal(result.exitCode,0);
  assert.equal(output.filter(([,stream])=>stream==='stdout').map(([chunk])=>chunk).join(''),result.stdout);
  assert.equal(output.filter(([,stream])=>stream==='stderr').map(([chunk])=>chunk).join(''),result.stderr);
  assert.equal(result.stdout,'中文done');assert.equal(result.stderr,'error');
  const missing=await runProcess(path.join(os.tmpdir(),'missing-adapter-executable'),[],{timeoutMs:1000});
  assert.equal(missing.exitCode,null);assert.match(missing.error,/ENOENT/);
});

test('a timeout terminates the spawned process tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adapter-process-tree-'));
  const marker = path.join(root, 'orphan-marker.txt');
  const grandchild = path.join(root, 'grandchild.mjs');
  const parent = path.join(root, 'parent.mjs');
  await writeFile(grandchild, `
    import { writeFile } from 'node:fs/promises';
    setTimeout(() => writeFile(process.argv[2], 'orphaned'), 500);
    setInterval(() => {}, 1000);
  `);
  await writeFile(parent, `
    import { spawn } from 'node:child_process';
    spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `);
  const result = await runProcess(process.execPath, [parent, grandchild, marker], {
    detached: true,
    timeoutMs: 75,
    terminationGraceMs: 100,
  });
  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await assert.rejects(readFile(marker, 'utf8'), /ENOENT/);
});

test('a departed parent cannot leave inherited pipes waiting beyond the drain bound', async () => {
  const descendant = 'setTimeout(()=>process.stdout.write("late"),1000)';
  const parent = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:["ignore","inherit","inherit"]});process.exit(0)`;
  const result = await runProcess(process.execPath, ['-e', parent], {
    detached: true, timeoutMs: 5000, stdioCloseTimeoutMs: 80, terminationGraceMs: 50,
  });
  const exitedAt = Date.parse(result.events.find(event => event.type === 'exit').at);
  assert.ok(Date.now() - exitedAt < 800, 'drain bound starts at exit, independent of Windows startup speed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.errorCode, 'STDIO_CLOSE_TIMEOUT');
  assert.ok(result.events.some(event => event.type === 'exit'));
  assert.ok(result.termination);
});

test('tree termination permits POSIX evidence flushing and records Windows termination without a platform skip', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'termination-evidence-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const marker = path.join(directory, 'flushed');
  const source = 'process.on("SIGTERM",()=>setTimeout(()=>{require("node:fs").writeFileSync(process.argv[1],"flushed");process.exit(0)},80));process.stdout.write("READY");setInterval(()=>{},1000)';
  const result = await runProcess(process.execPath, ['-e', source, marker], {
    detached: true, timeoutMs: 5000, terminationGraceMs: 500,
    onOutput() { throw new Error('stop after ready'); },
  });
  assert.equal(result.errorCode, 'OUTPUT_WRITE_FAILED');
  assert.equal(result.termination.method, process.platform === 'win32' ? 'taskkill' : 'process-group');
  if (process.platform !== 'win32') assert.equal(await readFile(marker, 'utf8'), 'flushed');
  assert.ok(result.events.some(event => event.type === 'exit'));
});

test('timeout cleanup output still reaches a healthy log sink during the grace period', async () => {
  const chunks = [];
  const source = 'process.on("SIGTERM",()=>{process.stdout.write("final-evidence");process.exit(0)});process.stdout.write("ready");setInterval(()=>{},1000)';
  const result = await runProcess(process.execPath, ['-e', source], {
    detached:true, timeoutMs:500, terminationGraceMs:500, onOutput: chunk => chunks.push(chunk),
  });
  assert.equal(result.timedOut,true);
  if (process.platform !== 'win32') assert.match(chunks.join(''), /final-evidence/);
  assert.ok(result.events.some(event => event.type === 'exit'));
});

test('Windows controlled processes never detach, and diagnostics describe actual captured bytes', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("中文");process.stderr.write("err")'], {
    platform: 'win32', detached: true, timeoutMs: 2000,
  });
  assert.equal(result.detached, false);
  assert.equal(result.stdoutBytes, Buffer.byteLength('中文'));
  assert.equal(result.stderrBytes, 3);
  assert.equal(result.invocation.command, process.execPath);
  assert.ok(result.pid > 0);
  assert.deepEqual(result.events.map(event => event.type), ['spawn', 'exit', 'close']);
});

test('output sink failures terminate the process and remain failures even with exit zero', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("data");setInterval(()=>{},100)'], {
    detached: true, timeoutMs: 2000, onOutput() { throw new Error('log disk unavailable'); },
  });
  assert.match(result.error, /log disk unavailable/);
  assert.equal(result.errorCode, 'OUTPUT_WRITE_FAILED');
});

test('diagnostic comparison captures both raw detached settings without installing anything', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'process comparison-'));
  const results = await compareTool(process.execPath, ['-e', 'process.stdout.write("offline")'], { directory, cwd: directory });
  assert.deepEqual(results.map(r => r.actual.detached), [false, true]);
  assert.ok(results.every(r => r.actual.events.at(-1).type === 'close' && r.runner.exitCode === 0));
  assert.equal(await readFile(path.join(directory, 'attached.stdout.log'), 'utf8'), 'offline');
});

test('Windows command wrappers preserve spaces, Unicode, and shell metacharacters', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adapter cmd 中文-'));
  const capture = path.join(root, 'capture.mjs');
  const wrapper = path.join(root, 'capture args.cmd');
  await writeFile(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  await writeFile(wrapper, '@echo off\r\n"%NODE_PATH%" "%~dp0capture.mjs" %*\r\n');
  const expected = ['plain', 'space value', '中文 参数', 'a&b', 'caret^value', 'pipe|value', 'percent%value', 'bang!value'];
  const result = await runProcess(wrapper, expected, { detached: true, timeoutMs: 5000, env: { ...process.env, NODE_PATH: process.execPath } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.detached, false);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

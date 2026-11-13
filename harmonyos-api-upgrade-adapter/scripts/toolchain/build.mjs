import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { openSync, closeSync, writeSync } from 'node:fs';
import path from 'node:path';
import { runProcess, prependPath, processDiagnostics } from '../shared/platform/process.mjs';
import { atomicWrite } from '../shared/io/fs-utils.mjs';
import { inspectRnBundle } from './rn-bundle.mjs';

const passed = result => result.exitCode === 0 && !result.error && !result.timedOut && !result.signal;

export async function runBuild({ project, environment, evidenceDirectory, args }, { run = runProcess, write = writeSync } = {}) {
  if (!Array.isArray(args) || !args.length || args.some(a => typeof a !== 'string' || /[\0\r\n]/.test(a)))
    throw new Error('必须通过 -- 后的独立参数提供真实 Hvigor 构建命令');
  const info = environment.result ?? environment;
  for (const name of ['ohpm', 'hvigorw']) if (typeof info.tools?.[name]?.path !== 'string' || !path.isAbsolute(info.tools[name].path))
    throw new Error(`环境文件缺少 ${name} 绝对路径`);
  const cwd = await realpath(path.resolve(project));
  const source = info.processEnvironment ?? {};
  const settings = { JAVA_HOME: source.JAVA_HOME ?? null, DEVECO_SDK_HOME: source.DEVECO_SDK_HOME ?? null, prependPath: source.prependPath ?? [] };
  if (!Array.isArray(settings.prependPath) || settings.prependPath.some(item => typeof item !== 'string')) throw new Error('环境 PATH 前缀必须为路径数组');
  const env = prependPath({ ...process.env, ...(settings.JAVA_HOME ? { JAVA_HOME: settings.JAVA_HOME } : {}),
    ...(settings.DEVECO_SDK_HOME ? { DEVECO_SDK_HOME: settings.DEVECO_SDK_HOME } : {}) }, settings.prependPath ?? []);
  await mkdir(path.resolve(evidenceDirectory), { recursive: true });
  const directory = await mkdtemp(path.join(path.resolve(evidenceDirectory), 'build-'));
  const receiptPath = path.join(directory, 'receipt.json');
  const receipt = { status: 'RUNNING', directory, receiptPath, cwd, createdAt: new Date().toISOString(),
    versions: Object.fromEntries(Object.entries(info.tools ?? {}).map(([key, tool]) => [key, tool.version ?? null])),
    sdk: info.sdkMetadata?.data ?? null, deveco: info.productInfo?.version ?? null,
    processEnvironment: settings, install: null, build: null };
  const save = () => atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  await save();
  async function execute(stage, command, argv, timeoutMs) {
    const startedAt = new Date().toISOString();
    const record = { status: 'RUNNING', command, args: argv, cwd, startedAt,
      stdout: `${stage}.stdout.log`, stderr: `${stage}.stderr.log` };
    receipt[stage] = record; await save();
    const descriptors = {}, bytes = { stdout: 0, stderr: 0 };
    let result, logError = null;
    const output = (chunk, stream) => {
      try {
        const buffer = Buffer.from(chunk);
        let offset = 0;
        while (offset < buffer.length) {
          const count = write(descriptors[stream], buffer, offset, buffer.length - offset);
          if (!count) throw new Error('日志写入未取得进展');
          offset += count; bytes[stream] += count;
        }
      } catch (error) { logError = error; throw error; }
    };
    try {
      for (const stream of ['stdout', 'stderr']) descriptors[stream] = openSync(path.join(directory, record[stream]), 'wx');
      result = await run(command, argv, { cwd, env, timeoutMs, detached: process.platform !== 'win32', terminationGraceMs: 500,
        captureStdout: false, captureStderr: false, onOutput: output });
      // Injected/older runners may only return completed output; never duplicate streamed bytes.
      for (const stream of ['stdout', 'stderr']) if (!bytes[stream] && result[stream]) output(result[stream], stream);
    } catch (error) { result = { exitCode: null, error: error.message, errorCode: logError ? 'OUTPUT_WRITE_FAILED' : 'BUILD_EXECUTION_FAILED' }; }
    finally {
      for (const descriptor of Object.values(descriptors)) try { closeSync(descriptor); } catch (error) { logError ??= error; }
    }
    if (logError) result = { ...result, error: logError.message, errorCode: 'OUTPUT_WRITE_FAILED' };
    Object.assign(record, { status: passed(result) ? 'SUCCEEDED' : 'FAILED', completedAt: new Date().toISOString(),
      exitCode: result.exitCode ?? null, signal: result.signal ?? null, timedOut: result.timedOut ?? false,
      error: result.error ?? null, process: { ...processDiagnostics(result), stdoutBytes: bytes.stdout, stderrBytes: bytes.stderr } });
    await save();
    return passed(record);
  }
  if (!await execute('install', info.tools.ohpm.path, ['install'], 10 * 60_000)) receipt.status = 'INSTALL_FAILED';
  else receipt.status = await execute('build', info.tools.hvigorw.path, args, 30 * 60_000) ? 'BUILD_SUCCEEDED' : 'BUILD_FAILED';
  // RNOH only: Hvigor packages the existing bundle and never compiles business JS, so record which bundle went in.
  if (receipt.status === 'BUILD_SUCCEEDED') {
    try { const bundle = await inspectRnBundle(cwd); if (bundle) receipt.rnBundle = bundle; }
    catch (error) { receipt.rnBundle = { status: 'CHECK_FAILED', bundles: [], message: `RN bundle 核对失败：${error.message}` }; }
  }
  receipt.completedAt = new Date().toISOString();
  await save();
  return receipt;
}

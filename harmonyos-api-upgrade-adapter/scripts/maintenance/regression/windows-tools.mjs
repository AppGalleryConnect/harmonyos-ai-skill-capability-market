import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runProcess, prependPath } from '../../shared/platform/process.mjs';
import { isMainModule } from '../../shared/platform/entrypoint.mjs';
import { parseArgs, requireString } from '../../shared/format/args.mjs';

export async function compareTool(command, args, { directory, cwd, env = process.env, timeoutMs = 12_000 }) {
  await mkdir(directory, { recursive: true });
  const worker = fileURLToPath(new URL('./windows-probe-worker.mjs', import.meta.url)), comparisons = [];
  for (const detached of [false, true]) {
    const stem = detached ? 'detached' : 'attached', trace = path.join(directory, `${stem}.json`);
    const result = await runProcess(process.execPath, [worker, JSON.stringify({ command, args, detached, trace })], {
      cwd, env, detached: true, timeoutMs,
    });
    for (const stream of ['stdout', 'stderr']) await writeFile(path.join(directory, `${stem}.${stream}.log`), result[stream] ?? '');
    let actual;
    try { actual = JSON.parse(await readFile(trace, 'utf8')); } catch (error) { actual = { error: error.message }; }
    comparisons.push({ detached, actual, runner: result });
  }
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify(comparisons, null, 2) + '\n');
  return comparisons;
}

async function main(argv) {
  if (!argv.length || argv.includes('--help')) return { usage: '--environment <环境JSON> --output <新诊断目录>；只运行离线夹具与 ohpm -v，不安装依赖' };
  if (process.platform !== 'win32') throw new Error('真实工具对照须在原 Windows 机器执行');
  const args = parseArgs(argv), data = JSON.parse(await readFile(requireString(args, 'environment'), 'utf8'));
  const info = data.result ?? data, root = path.resolve(requireString(args, 'output'));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'windows-probe-'));
  const settings = info.processEnvironment ?? {};
  const env = prependPath({ ...process.env, PROBE_NODE: process.execPath,
    ...(settings.JAVA_HOME ? { JAVA_HOME: settings.JAVA_HOME } : {}),
    ...(settings.DEVECO_SDK_HOME ? { DEVECO_SDK_HOME: settings.DEVECO_SDK_HOME } : {}) }, settings.prependPath ?? []);
  const wrapper = path.join(directory, '离线 wrapper.cmd');
  await writeFile(path.join(directory, 'echo.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write("fixture-stderr");\n');
  await writeFile(wrapper, '@echo off\r\n"%PROBE_NODE%" "%~dp0echo.mjs" %*\r\n');
  const cwd = path.resolve(info.tools.ohpm.cwd ?? process.cwd());
  await compareTool(wrapper, ['中文 参数', 'a&b', 'percent%value'], { directory: path.join(directory, 'offline'), cwd, env });
  await compareTool(info.tools.ohpm.path, ['-v'], { directory: path.join(directory, 'ohpm-version'), cwd, env });
  return { directory, note: '对照结果是诊断事实；不自动认定 detached、网络或缓存为根因' };
}
if (isMainModule(import.meta.url)) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });

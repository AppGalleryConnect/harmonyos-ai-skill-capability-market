import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../shared/platform/process.mjs';
import { caseTimeoutMs, requireValue, textValue } from './contracts.mjs';
import { inside, readJson, writeJson } from './io.mjs';
import { CASE_FORMAT, caseFile, toolWorkingDirectory, verifyRun, workerArgs } from './runs.mjs';
import { installAndVerify, requireCommandSuccess } from './install.mjs';

export async function executeRun(root, { python, hdc = 'hdc', invoke = runProcess } = {}) {
  root = path.resolve(root);
  const { manifest: m, plan } = await verifyRun(root);
  requireValue(m.caseFormat === CASE_FORMAT, '历史Python用例只供报告，请生成并冻结新的JSON用例');
  requireValue(textValue(python) && python === m.python && hdc === m.hdc, '本地指定的Python/HDC必须与冻结配置一致');
  const cases = plan.cases.cases.map(c => {
    const relative = caseFile(c.id, m.caseFormat);
    requireValue(Object.hasOwn(m.hashes, relative), '清单缺少冻结用例: ' + c.id);
    return { c, relative, scriptSha256: m.hashes[relative], timeoutMs: caseTimeoutMs(c) };
  });
  const result = { schemaVersion: 1, runId: m.runId, mode: m.mode, status: 'RUNNING', events: [], phases: {} };
  const executionFile = path.join(root, 'execution.json');
  await writeJson(executionFile, result, true); // 新run；绝不覆盖旧执行或自动继承通过。
  async function event(type, data = {}) {
    result.events.push({ type, time: Date.now(), ...data }); await writeJson(executionFile, result);
  }
  async function commandResult(executable, args, phase = 'preflight', timeoutMs = 60_000) {
    const output = await invoke(executable, args, { cwd: toolWorkingDirectory, timeoutMs });
    await event('command', { phase, executable, args, ...output });
    return output;
  }
  async function command(executable, args) {
    const output = await commandResult(executable, args);
    requireCommandSuccess(output, executable);
    return output.stdout;
  }
  try {
    requireValue(!(m.packageIssues?.length), m.packageIssues?.join('; '));
    requireValue(plan.cases.cases.length > 0, '零可执行用例，不启动设备；按缺口交付报告');
    const planFile = await inside(root, path.join('inputs', 'plan.json'));
    for (const { c, relative, scriptSha256 } of cases)
      await command(python, workerArgs('check', await inside(root, relative), scriptSha256, planFile, c.id));
    await command(python, workerArgs('environment'));
    const targets = await command(hdc, ['list', 'targets']);
    requireValue(targets.split(/\s+/).includes(m.device.serial), '指定设备不在线');
    const api = await command(hdc, ['-t', m.device.serial, 'shell', 'param', 'get', 'const.ohos.apiversion']);
    requireValue(api.trim() === m.device.api, '设备系统API不一致');
    for (const phase of m.mode === 'COMPARE' ? ['before', 'after'] : ['after']) {
      const pkg = m.packages[phase];
      if (phase === 'after' && m.mode === 'COMPARE') await event('reset', { phase, method: '每例按冻结用例重新建立相同数据；无隐式卸载/清数据' });
      await event('phase-start', { phase });
      result.phases[phase] = { status: 'RUNNING', cases: {} };
      const artifacts = [];
      for (const a of pkg.artifacts) {
        requireValue(m.device.kind !== 'physical' || a.signed, '真机缺少已有签名产物；不会自动签名');
        artifacts.push(await inside(root, a.path));
      }
      const installed = await installAndVerify({ hdc, serial: m.device.serial, artifacts, expected: pkg.rawIdentity,
        command: (executable, args) => commandResult(executable, args, phase) });
      await event('installed', { phase, artifacts: pkg.artifacts, ...installed });
      for (const { c, relative, scriptSha256, timeoutMs } of cases) {
        const attempt = 1, output = await inside(root, path.join(phase, 'cases', c.id, 'attempts', String(attempt)));
        await mkdir(path.dirname(output), { recursive: true });
        await mkdir(output);
        const script = await inside(root, relative);
        const request = { runId: m.runId, phase, attempt, output, script, scriptSha256, case: c, package: pkg, device: m.device };
        const requestFile = path.join(output, 'request.json'); await writeJson(requestFile, request, true);
        const process = await invoke(python, workerArgs('run', requestFile), { cwd: toolWorkingDirectory, timeoutMs });
        await event('case-process', { phase, caseId: c.id, ...process });
        let record;
        try {
          record = await readJson(path.join(output, 'result.json'));
          requireValue(record.runId === m.runId && record.phase === phase && record.caseId === c.id &&
            ['EXECUTED', 'BLOCKED'].includes(record.status), '用例结果身份不匹配');
          requireValue(!process.timedOut && !process.error && [0, 2].includes(process.exitCode), '用例进程未正常结束');
        } catch (error) {
          record = { schemaVersion: 1, runId: m.runId, phase, caseId: c.id, attempt, status: 'BLOCKED',
            reason: String(error.message), observations: [], captures: [] };
          await writeJson(path.join(output, 'process-failure.json'), record, true);
        }
        result.phases[phase].cases[c.id] = { status: record.status, directory: path.relative(root, output), reason: record.reason ?? '' };
        await event('case-end', { phase, caseId: c.id, status: record.status });
      }
      result.phases[phase].status = 'FINISHED'; await event('phase-end', { phase });
      // 切包前再次核对冻结输入，防止执行中替换产物或用例。
      await verifyRun(root);
    }
    result.status = 'FINISHED';
  } catch (error) {
    result.status = 'BLOCKED'; result.reason = error.message;
    await event('blocked', { reason: error.message });
  }
  result.finishedAt = new Date().toISOString(); await writeJson(executionFile, result);
  return result;
}

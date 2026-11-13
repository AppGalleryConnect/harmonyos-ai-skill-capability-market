import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../shared/platform/process.mjs';
import { atomicWrite } from '../shared/io/fs-utils.mjs';
import { requireValue } from './contracts.mjs';
import { fingerprint } from './io.mjs';
import { checkInstalled, packageIdentity } from './package-identity.mjs';

const hdcFailure = /\[(?:Fail|Error)\]|\binstall[^\r\n]*\bfailed\b|\bfailed to install\b/i;
const installSuccess = /\binstall bundle successfully\b|\bsuccessfully installed\b/i;

export function requireCommandSuccess(output, executable) {
  requireValue(output.exitCode === 0 && !output.timedOut && !output.signal && !output.error && !output.errorCode,
    `命令失败: ${executable}: ${output.error || output.errorCode || output.stderr || output.stdout || `退出码 ${output.exitCode}`}`);
}

function hdcOutput(output, hdc) {
  requireCommandSuccess(output, hdc);
  const text = `${output.stdout}\n${output.stderr}`;
  requireValue(!hdcFailure.test(text), 'HDC 返回失败回执，详见 stdout 和 stderr');
  return text;
}

export async function installAndVerify({ hdc, serial, artifacts, expected, command }) {
  for (const file of artifacts) {
    const output = await command(hdc, ['-t', serial, 'install', '-r', await realpath(file)]);
    requireValue(installSuccess.test(hdcOutput(output, hdc)), '安装未取得成功回执');
  }
  const dump = await command(hdc, ['-t', serial, 'shell', 'bm', 'dump', '-n', expected.bundle]);
  requireCommandSuccess(dump, hdc);
  requireValue(!hdcFailure.test(dump.stderr) && !hdcFailure.test(dump.stdout.split('{', 1)[0]), '读取安装包信息失败');
  return { identity: checkInstalled(dump.stdout, expected), packageInfo: dump.stdout };
}

export async function installHap({ hdc, serial, hap, sha256, evidenceDir }, { invoke = runProcess } = {}) {
  await mkdir(evidenceDir, { recursive: true });
  const directory = await mkdtemp(path.join(await realpath(evidenceDir), 'install-'));
  const receiptPath = path.join(directory, 'receipt.json');
  const receipt = { schemaVersion: 1, status: 'RUNNING', serial, hdc: path.resolve(hdc), hap: path.resolve(hap),
    expectedSha256: sha256, startedAt: new Date().toISOString(), commands: [] };
  const save = () => atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  async function command(executable, args) {
    const options = { cwd: directory, timeoutMs: 60_000 };
    const entry = { executable, args, ...options };
    receipt.commands.push(entry);
    await save();
    entry.output = await invoke(executable, args, options);
    await save();
    return entry.output;
  }
  await save();
  try {
    requireValue(/^[a-f\d]{64}$/i.test(sha256), '需要本次 HAP 的 SHA-256');
    requireValue(/^\S+$/.test(serial), '需要明确指定一个设备序列号');
    receipt.hap = await realpath(hap);
    requireValue(path.extname(receipt.hap).toLowerCase() === '.hap', '单次安装需要 HAP 文件');
    receipt.sha256 = await fingerprint(receipt.hap);
    requireValue(receipt.sha256 === sha256.toLowerCase(), 'HAP SHA-256 与本次构建证据不一致');
    const expected = await packageIdentity(receipt.hap);
    requireValue([expected.bundle, expected.module, expected.ability].every(name => typeof name === 'string' && name.trim()),
      'HAP 缺少包名、模块或入口 Ability');
    receipt.expectedIdentity = expected;
    const executable = await realpath(hdc);
    receipt.hdc = executable;
    const targets = await command(executable, ['list', 'targets']);
    hdcOutput(targets, executable);
    requireValue(targets.stdout.split(/\s+/).includes(serial), '指定设备不在线');
    const api = await command(executable, ['-t', serial, 'shell', 'param', 'get', 'const.ohos.apiversion']);
    hdcOutput(api, executable);
    requireValue(/^\d+$/.test(api.stdout.trim()), '设备未返回可核对的系统 API');
    receipt.api = api.stdout.trim();
    requireValue(await fingerprint(receipt.hap) === receipt.sha256, 'HAP 在安装前已变化');
    const installed = await installAndVerify({ hdc: executable, serial, artifacts: [receipt.hap], expected, command });
    requireValue(await fingerprint(receipt.hap) === receipt.sha256, 'HAP 在安装期间已变化');
    Object.assign(receipt, installed);
    receipt.status = 'SUCCEEDED';
  } catch (error) {
    receipt.status = 'BLOCKED';
    receipt.reason = error.message;
  }
  receipt.finishedAt = new Date().toISOString();
  await save();
  return { status: receipt.status, receipt: receiptPath, ...(receipt.reason ? { reason: receipt.reason } : {}) };
}

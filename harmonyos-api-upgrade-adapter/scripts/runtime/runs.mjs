import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../shared/io/fs-utils.mjs';
import { caseTimeoutMs, identifier, requireValue, textValue, validatePlan } from './contracts.mjs';
import { fingerprint, inside, readJson, writeJson } from './io.mjs';
import { packageIdentity, checkDeclaration } from './package-identity.mjs';

export const CASE_FORMAT = 'operations-v1';
export const caseFile = (id, format) => path.join('scripts', id + (format === CASE_FORMAT ? '.json' : '.py'));
const installedWorker = fileURLToPath(new URL('./python/worker.py', import.meta.url));
export const toolWorkingDirectory = path.dirname(installedWorker);
export const workerArgs = (...args) => ['-I', '-B', installedWorker, ...args];

// 调用时机由U06控制；归档副本只写一次，不负责构建或签名。
export async function archivePackage(directory, phase, input) {
  requireValue(['before', 'after'].includes(phase), '未知阶段');
  requireValue(input.phase === phase && input.build?.exitCode === 0 && textValue(input.build.command) &&
    textValue(input.build.cwd) && textValue(input.product) && textValue(input.module) && textValue(input.package) &&
    textValue(input.ability) && textValue(input.target) && textValue(input.compatible) &&
    textValue(input.sourceDescription) && Array.isArray(input.inputs) && input.inputs.length > 0, '阶段包缺少真实构建/源码身份');
  if (phase === 'before') requireValue(input.original === true, 'before必须声明原始源码/配置，不接受target回退对照包');
  await mkdir(directory, { recursive: true });
  const dest = await inside(directory, phase); await mkdir(dest, { recursive: false });
  const inputs = [];
  for (const entry of input.inputs) inputs.push({ path: entry, sha256: await fingerprint(entry) });
  const files = [];
  let rawIdentity;
  requireValue(Array.isArray(input.artifacts) && input.artifacts.length > 0, '阶段包集合为空');
  for (const [i, artifact] of input.artifacts.entries()) {
    const identity = await packageIdentity(artifact.path, input.module);
    if (identity.primary) { requireValue(!rawIdentity, '阶段包包含多个同名主模块'); rawIdentity = identity; }
    const source = await readFile(artifact.path), name = `${i}-${path.basename(artifact.path)}`;
    const out = await inside(directory, path.join(phase, name));
    await copyFile(artifact.path, out, 1);
    requireValue(await fingerprint(out) === sha256(source), '归档复制不一致');
    files.push({ path: path.join(phase, name), sha256: sha256(source), signed: artifact.signed === true });
  }
  requireValue(rawIdentity?.bundle === input.package && rawIdentity.ability === input.ability, '归档主包身份与声明不一致');
  checkDeclaration(rawIdentity, input);
  const buildLog = await readFile(input.build.log);
  await copyFile(input.build.log, path.join(dest, 'build.log'), 1);
  const result = { ...input, rawIdentity, inputs, artifacts: files, build: { ...input.build, log: path.join(phase, 'build.log'), logSha256: sha256(buildLog) },
    archivedAt: new Date().toISOString() };
  await writeJson(path.join(dest, 'package.json'), result, true);
  return result;
}
export async function freezeRun(directory, plan, { scripts, packagesDirectory, mode, device, python, hdc = 'hdc', runId = randomUUID() }) {
  validatePlan(plan); identifier(runId);
  requireValue(['COMPARE', 'AFTER_ONLY'].includes(mode), '测试方式必须明确');
  requireValue(device && textValue(device.serial) && textValue(device.api) && textValue(device.instance) &&
    ['emulator', 'physical'].includes(device.kind) && textValue(python) && textValue(hdc), '缺少明确设备/运行环境');
  for (const c of plan.cases.cases) {
    caseTimeoutMs(c);
    const source = scripts[c.id];
    requireValue(typeof source === 'string' && Buffer.byteLength(source) <= 256 * 1024, `缺少用例或用例超过256 KiB: ${c.id}`);
    const program = JSON.parse(source);
    requireValue(program?.schemaVersion === 1, `需要版本1的JSON用例: ${c.id}`);
  }
  await mkdir(directory, { recursive: true });
  const root = await inside(directory, path.join('runs', runId));
  await mkdir(path.dirname(root), { recursive: true });
  await inside(directory, path.join('runs', runId));
  await mkdir(root, { recursive: false });
  const hashes = {}, packages = {}, packageIssues = [];
  async function save(name, bytes) {
    const file = await inside(root, name); await mkdir(path.dirname(file), { recursive: true });
    await import('node:fs/promises').then(fs => fs.writeFile(file, bytes, { flag: 'wx' })); hashes[name] = sha256(bytes);
  }
  await save('inputs/plan.json', Buffer.from(JSON.stringify(plan, null, 2) + '\n'));
  for (const name of ['runtime.py', 'worker.py', 'case_data.py']) await save(path.join('inputs', 'runtime', name), await readFile(new URL('./python/' + name, import.meta.url)));
  for (const c of plan.cases.cases) {
    await save(caseFile(c.id, CASE_FORMAT), Buffer.from(scripts[c.id]));
  }
  for (const phase of mode === 'COMPARE' ? ['before', 'after'] : ['after']) {
    let pkg;
    try { pkg = await readJson(path.join(packagesDirectory, phase, 'package.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      packageIssues.push(`${phase}: 缺少已归档的真实阶段包，禁止执行/补造`); continue;
    }
    requireValue(pkg.phase === phase && (phase !== 'before' || pkg.original === true), '阶段包身份错误');
    try {
    const items = []; let rawIdentity;
    for (const artifact of pkg.artifacts) {
      const file = await inside(packagesDirectory, artifact.path), bytes = await readFile(file);
      requireValue(sha256(bytes) === artifact.sha256, '阶段包哈希漂移');
      const identity = await packageIdentity(file, pkg.module);
      if (identity.primary) { requireValue(!rawIdentity, '多个主模块'); rawIdentity = identity; }
      const name = path.join('packages', phase, path.basename(file)); await save(name, bytes); items.push({ ...artifact, path: name });
    }
    const log = await inside(packagesDirectory, pkg.build.log), logBytes = await readFile(log);
    requireValue(sha256(logBytes) === pkg.build.logSha256, '构建日志发生变化');
    const logName = path.join('packages', phase, 'build.log'); await save(logName, logBytes);
    requireValue(rawIdentity?.bundle === pkg.package && rawIdentity.ability === pkg.ability, '冻结包身份与声明不一致');
    checkDeclaration(rawIdentity, pkg);
    packages[phase] = { ...pkg, rawIdentity, artifacts: items, build: { ...pkg.build, log: logName } };
    } catch (error) {
      packageIssues.push(`${phase}: 阶段包附件/身份无效: ${error.message}`);
    }
  }
  const manifest = { schemaVersion: 1, caseFormat: CASE_FORMAT, runId, mode, device, python, hdc, packages, packageIssues, hashes, createdAt: new Date().toISOString() };
  await writeJson(path.join(root, 'manifest.json'), manifest, true);
  await writeJson(path.join(root, 'manifest-digest.json'), { sha256: await fingerprint(path.join(root, 'manifest.json')) }, true);
  return root;
}
export async function verifyRun(root) {
  const seal = await readJson(await inside(root, 'manifest-digest.json'));
  const manifestFile = await inside(root, 'manifest.json');
  const source = await readFile(manifestFile);
  requireValue(sha256(source) === seal.sha256, '冻结manifest发生变化');
  const manifest = JSON.parse(source);
  requireValue(manifest.schemaVersion === 1, '运行版本错误');
  requireValue(manifest.caseFormat === undefined || manifest.caseFormat === CASE_FORMAT, '未知冻结用例格式');
  for (const [name, hash] of Object.entries(manifest.hashes)) requireValue(await fingerprint(await inside(root, name)) === hash, `冻结输入发生变化: ${name}`);
  const plan = await readJson(await inside(root, 'inputs/plan.json')); validatePlan(plan);
  return { manifest, plan };
}

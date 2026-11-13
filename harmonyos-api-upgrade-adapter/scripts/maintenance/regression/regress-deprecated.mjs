import { finished } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, requireString, stringList } from '../../shared/format/args.mjs';
import { discoverDevEco } from '../../scanner/core/deveco.mjs';
import { buildSdkCatalog } from '../../scanner/core/sdk-deprecations.mjs';
import { loadProject } from '../../scanner/core/project.mjs';
import { atomicWrite, exists, sha256 } from '../../shared/io/fs-utils.mjs';
import { compareDeprecated } from './compare-deprecated.mjs';
import { runProcess, prependPath } from '../../shared/platform/process.mjs';

const scannerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scanner');
const args = parseArgs(process.argv.slice(2));
const projects = stringList(args.project);
const refs = stringList(args.ref);
if (!projects.length || refs.length !== projects.length) throw new Error('Pass matching repeated --project and --ref arguments');
const toolchain = await discoverDevEco(requireString(args, 'sdk'));
for (const name of ['java', 'ohpm', 'hvigorw']) if (!toolchain[name]) throw new Error(`Build tool is missing: ${name}`);
const output = path.resolve(args['output-dir'] || await mkdtemp(path.join(os.tmpdir(), 'deprecated-regression-')));
await mkdir(output, { recursive: true });
const environment = prependPath({ ...process.env, DEVECO_SDK_HOME: toolchain.sdkRoot, JAVA_HOME: path.dirname(path.dirname(toolchain.java)) },
  [path.dirname(process.execPath), path.dirname(toolchain.ohpm), path.dirname(toolchain.hvigorw), path.dirname(toolchain.java)]);
async function run(command, argv, cwd, logPath = null) {
  const stream = logPath ? createWriteStream(logPath) : null;
  const complete = stream ? finished(stream) : Promise.resolve();
  let streamError = null, text = '';
  complete.catch(error => { streamError = error; });
  try {
    const result = await runProcess(command, argv, { cwd, env: environment, detached: true, timeoutMs: 30 * 60_000,
      onOutput(chunk) { text += chunk; if (streamError) throw streamError; stream?.write(chunk); } });
    if (result.error) throw new Error(result.error);
    return { code: result.timedOut ? 124 : result.exitCode ?? 1, text };
  } finally {
    stream?.end();
    await complete;
  }
}
const cases = [];
for (const [index, original] of projects.entries()) {
  const name = path.basename(original);
  const caseRoot = path.join(output, name);
  const checkout = path.join(caseRoot, 'project');
  await mkdir(caseRoot, { recursive: true });
  if (await exists(checkout)) {
    if (!args['reuse-checkouts']) throw new Error(`Checkout already exists: ${checkout}; choose a new output directory or --reuse-checkouts`);
    const origin = await run('git', ['remote', 'get-url', 'origin'], checkout);
    const head = await run('git', ['rev-parse', 'HEAD'], checkout);
    const desired = await run('git', ['rev-parse', refs[index]], checkout);
    if (origin.text.trim() !== original || head.text !== desired.text) throw new Error('Refusing to reuse a different checkout');
  } else {
    const clone = await run('git', ['clone', '--no-hardlinks', '--no-checkout', original, checkout], output);
    if (clone.code) throw new Error(clone.text);
    const checkoutResult = await run('git', ['checkout', '--detach', refs[index]], checkout);
    if (checkoutResult.code) throw new Error(checkoutResult.text);
  }
  if (args['use-project-build-profile']) await cp(path.join(original, 'build-profile.json5'), path.join(checkout, 'build-profile.json5'));
  const project = await loadProject(checkout, 'default');
  for (const relative of ['oh_modules', ...project.modules.map(item => `${item.relativeRoot}/oh_modules`),
    ...project.modules.map(item => `${item.relativeRoot}/src/main/resources/rawfile`)]) {
    const source = path.join(original, relative);
    if (await exists(source)) await cp(source, path.join(checkout, relative), { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: false });
  }
  for (const [command, argv] of [[toolchain.java, ['-version']], [process.execPath, ['-v']],
    [toolchain.ohpm, ['-v']], [toolchain.hvigorw, ['-v']]]) {
    const result = await run(command, argv, checkout);
    if (result.code) throw new Error(`Environment check failed: ${command}\n${result.text}`);
  }
  if (!environment.DEVECO_SDK_HOME) throw new Error('DEVECO_SDK_HOME missing');
  console.log(`${name}: isolated checkout ready; non-incremental assembleApp`);
  const logPath = path.join(caseRoot, 'build.log');
  const before = await loadProject(checkout, 'default');
  const build = await run(toolchain.hvigorw, ['--mode', 'project', '-p', 'product=default', 'assembleApp', '--analyze=normal', '--parallel', '--no-incremental', '--no-daemon'], checkout, logPath);
  const after = await loadProject(checkout, 'default');
  const catalog = await buildSdkCatalog(toolchain);
  const record = { name, original, revision: refs[index], checkout,
    buildProfileSource: args['use-project-build-profile'] ? 'CURRENT_PROJECT_CONFIG' : 'GIT_BASELINE_CONFIG', buildProfileHash: after.buildProfileHash,
    buildExitCode: build.code, buildSourceStable: before.sourceSnapshot === after.sourceSnapshot && before.buildProfileHash === after.buildProfileHash };
  cases.push(record);
  await atomicWrite(path.join(output, 'regression.json'), JSON.stringify({ cases }, null, 2));
  if (build.code || !record.buildSourceStable) { console.log(`${name}: build/input verification failed; see ${logPath}`); continue; }
  const evidencePath = path.join(caseRoot, 'build-evidence.json');
  await atomicWrite(evidencePath, JSON.stringify({ schemaVersion: 1, projectRoot: after.root, product: 'default',
    logHash: sha256(await readFile(logPath)), sourceSnapshot: after.sourceSnapshot, sdkSnapshot: catalog.snapshot,
    buildProfileHash: after.buildProfileHash,
    targetSdk: catalog.coverage.targetSdk, nonIncremental: true, status: 'PASSED' }, null, 2));
  const scanResults = [];
  for (const round of [1, 2]) {
    const destination = path.join(caseRoot, `scan-${round}`);
    console.log(`${name}: scan ${round}/2`);
    const initialized=await run(process.execPath,[path.join(scannerRoot,'bin/harmony-api-scan.mjs'),'init-task',
      '--task-root',caseRoot,'--output-dir',destination],scannerRoot);
    if(initialized.code!==0)throw new Error(initialized.text);
    const taskFile=JSON.parse(initialized.text).result.taskFile;
    const result = await run(process.execPath, [path.join(scannerRoot, 'bin/harmony-api-scan.mjs'), 'scan', '--task',taskFile,'--mode', 'deprecated', '--project', checkout,
      '--sdk', toolchain.sdkRoot, '--from', args.from || '5.0.0(12)', '--to', args.to || catalog.coverage.targetSdk,
      '--product', 'default', '--native-build', 'off', '--output-dir', destination], scannerRoot, path.join(caseRoot, `scan-${round}.log`));
    const report = result.code === 0 ? JSON.parse(result.text).result : null;
    scanResults.push({ code: result.code, destination, outputCsv: report?.outputCsv, scanJson: report?.scanJson });
  }
  record.scanExitCodes = scanResults.map(item => item.code);
  if (scanResults.every(item => item.code === 0)) {
    const comparison = await compareDeprecated({ project: checkout, buildLog: logPath,
      scanJson: scanResults[0].scanJson, buildProjectRoot: after.root, buildEvidence: evidencePath });
    await atomicWrite(path.join(caseRoot, 'comparison.json'), JSON.stringify(comparison, null, 2));
    record.projectGoldCount = comparison.projectGoldCount;
    record.projectMissingCount = comparison.projectMissingCount;
    record.scannerOnlyCount = comparison.scannerOnlyCount;
    record.csvIdentical = sha256(await readFile(scanResults[0].outputCsv)) === sha256(await readFile(scanResults[1].outputCsv));
    const scans = await Promise.all(scanResults.map(item => readFile(item.scanJson, 'utf8')));
    const snapshots = scans.map(text => { const { batchId, ...snapshot } = JSON.parse(text); return JSON.stringify(snapshot); });
    record.scanJsonIdentical = snapshots[0] === snapshots[1];
    record.deprecatedCount = JSON.parse(scans[0]).findings.filter(item => item['Change Operation'] === 'API_DEPRECATED').length;
    console.log(`${name}: project gold ${record.projectGoldCount}, missing ${record.projectMissingCount}, deprecated ${record.deprecatedCount}, deterministic ${record.csvIdentical && record.scanJsonIdentical}`);
  }
  await atomicWrite(path.join(output, 'regression.json'), JSON.stringify({ cases }, null, 2));
}
const passed = cases.length === projects.length && cases.every(item => item.buildExitCode === 0 && item.buildSourceStable
  && item.scanExitCodes?.every(code => code === 0) && item.projectMissingCount === 0 && item.csvIdentical && item.scanJsonIdentical);
await atomicWrite(path.join(output, 'regression.json'), JSON.stringify({ status: passed ? 'PASSED' : 'FAILED', cases }, null, 2));
console.log(`Regression ${passed ? 'PASSED' : 'FAILED'}: ${output}`);
if (!passed) process.exitCode = 1;

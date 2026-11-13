import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveSdkRoot } from '../../shared/platform/sdk-layout.mjs';
import { resolveDevEcoHome, readProductInfo, discoverDevEcoTools } from '../../shared/platform/deveco-home.mjs';
import { inspectDevEcoCompatibility } from '../../shared/platform/deveco-version.mjs';
import { runProcess, prependPath, processDiagnostics } from '../../shared/platform/process.mjs';
import { atomicWrite } from '../../shared/io/fs-utils.mjs';
import { compareHarmonyVersions } from '../../shared/platform/version.mjs';
import { errorWithCode } from '../../shared/platform/errors.mjs';

export async function inspectEnvironment({ sdkPath, devecoHomePath = null, projectPath = null, targetVersion = null, outputPath = null }, {
  platform = process.platform, env = process.env, probe = runProcess,
} = {}) {
  const selectedSdk = sdkPath ?? env.DEVECO_SDK_HOME;
  if (typeof selectedSdk !== 'string' || !selectedSdk.trim())
    throw errorWithCode('请通过 --sdk 指定SDK根/default目录，或设置 DEVECO_SDK_HOME', 'SDK_PATH_REQUIRED');
  const sdk = await resolveSdkRoot(selectedSdk);
  const contentsRoot = await resolveDevEcoHome(sdk.root, devecoHomePath, env);
  const productInfo = await readProductInfo(contentsRoot, platform);
  const sdkMetadata = JSON.parse(await readFile(sdk.packagePath, 'utf8'));
  const data = sdkMetadata.data;
  const target = targetVersion ?? `${data.platformVersion}(${data.apiVersion}) ${data.releaseType}`;
  const devecoCompatibility = inspectDevEcoCompatibility(productInfo, target, contentsRoot);
  const sdkCompatibility = { status: compareHarmonyVersions(`${data.platformVersion}(${data.apiVersion}) ${data.releaseType}`, target) < 0
    ? 'TOO_OLD' : 'COMPATIBLE', targetVersion: target };
  const paths = { node: process.execPath, ...await discoverDevEcoTools(contentsRoot, productInfo, platform) };
  const cwd = await realpath(path.resolve(projectPath ?? process.cwd()));
  const javaHome = paths.java ? path.dirname(path.dirname(paths.java)) : env.JAVA_HOME;
  const environment = prependPath({ ...env, DEVECO_SDK_HOME: sdk.root, ...(javaHome ? { JAVA_HOME: javaHome } : {}) },
    [paths.node, paths.java, paths.ohpm, paths.hvigorw].filter(Boolean).map(file => path.dirname(file)), platform);
  const tools = Object.fromEntries(await Promise.all(['node', 'java', 'ohpm', 'hvigorw'].map(async name => {
    const file = paths[name], args = name === 'node' ? ['--version'] : name === 'java' ? ['-version'] : ['-v'];
    if (!file) return [name, { path: null, status: 'MISSING', args }];
    try {
      const result = await probe(file, args, { cwd, env: environment, platform, timeoutMs: 10_000, detached: platform !== 'win32', terminationGraceMs: 500 });
      return [name, { path: file, args, cwd, status: result.timedOut ? 'TIMED_OUT' : result.exitCode === 0 && !result.error ? 'AVAILABLE' : 'FAILED',
        exitCode: result.exitCode ?? null, version: result.exitCode === 0 && !result.timedOut && !result.error
          ? (result.stdout?.trim() || result.stderr?.trim() || null) : null,
        stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ?? null, process: processDiagnostics(result) }];
    } catch (error) { return [name, { path: file, args, cwd, status: 'FAILED', version: null, error: error.message }]; }
  })));
  const result = { status: devecoCompatibility.status === 'COMPATIBLE' && sdkCompatibility.status === 'COMPATIBLE'
      && Object.values(tools).every(t => t.status === 'AVAILABLE') ? 'COMPLETE' : 'INCOMPLETE',
    contentsRoot, sdkRoot: sdk.root, sdkDefaultRoot: sdk.defaultRoot, sdkPackagePath: sdk.packagePath,
    sdkMetadata, productInfo, devecoCompatibility, sdkCompatibility, tools,
    processEnvironment: { JAVA_HOME: javaHome ?? null, DEVECO_SDK_HOME: sdk.root,
      prependPath: [...new Set([paths.node, paths.java, paths.ohpm, paths.hvigorw].filter(Boolean).map(file => path.dirname(file)))] },
    optionalTools: { emulator: paths.emulator } };
  if (outputPath !== null) await atomicWrite(path.resolve(outputPath), JSON.stringify({ ok: true, result }, null, 2) + '\n');
  return result;
}

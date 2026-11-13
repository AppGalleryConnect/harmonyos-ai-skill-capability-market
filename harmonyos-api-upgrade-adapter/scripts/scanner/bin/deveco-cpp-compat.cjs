const { createHash } = require('node:crypto');
const { readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { compileFunction } = require('node:vm');

const skippedPrefix = 'HARMONY_CPP_SKIPPED_FILES ';
// Manually verified DevEco Studio integrated CLI builds, keyed by the product-info version.
// Other builds are adapted only when every adaptSource anchor matches exactly once; the scan then reports ANCHOR_MATCHED.
const supportedBuilds = Object.freeze({
  '26.0.0.821': Object.freeze({
    cli: '735e6e33fb088302e698200cdcef199680928bd5da0f2fcf114905b61b9f8317',
    nativeJar: '13a3a4d78e74068edc1ca0777c6316f73d3692b93ead87cfd53a1199243a25b3',
    ideJar: '6845b76c76d582aa763d7172dc63d12a3ac51492eb135bd82e187f841d35432b',
    jsonJar: '43d2795c54e1f21c8bf4da03c6473d263bc08f47c4931aa5488deb38c9148d21',
    jsonJarName: 'fastjson2-2.0.60.jar',
  }),
  '26.0.1.412': Object.freeze({
    cli: '53f7d84f773e2f320fd617c378f8cc8fc54f9e3781ae987463cd406f3fe6dfa2',
    nativeJar: '13a3a4d78e74068edc1ca0777c6316f73d3692b93ead87cfd53a1199243a25b3',
    ideJar: '6845b76c76d582aa763d7172dc63d12a3ac51492eb135bd82e187f841d35432b',
    jsonJar: '43d2795c54e1f21c8bf4da03c6473d263bc08f47c4931aa5488deb38c9148d21',
    jsonJarName: 'fastjson2-2.0.60.jar',
  }),
});
const buildForCli = cliHash => Object.values(supportedBuilds).find(build => build.cli === cliHash) ?? null;
const nativeJarPath = entry => path.join(path.dirname(entry), 'lib', 'c-apiscan.jar');

function replaceOnce(source, marker, replacement) {
  const index = source.indexOf(marker);
  if (index < 0 || source.indexOf(marker, index + marker.length) >= 0)
    throw new Error('DevEco C++ CLI compatibility anchor is missing or ambiguous');
  return source.slice(0, index) + replacement + source.slice(index + marker.length);
}

// The vendor bundle stores source in JSON strings, so whitespace includes escaped newlines.
const whitespace = String.raw`(?:\s|\\[rnt])*`;
const cppOptions = new RegExp(String.raw`(\bconst cppScanOptions = \{${whitespace}sdkPaths: getCppSdkPath\(\),${whitespace}timeout: )([1-9]\d*)(,?${whitespace}\};)`);
const commandLimit = new RegExp(String.raw`(\bconst BASE_JSON_SIZE = baseJsonData\.length;${whitespace}const CMD_LINE_LIMIT = )([1-9]\d*)(;)`);

function replaceInteger(source, functionName, declaration, pattern, usage, value) {
  const lineBreak = String.raw`(?:\r?\n|\\n)`;
  const functions = [...source.matchAll(new RegExp(String.raw`(?:^|${lineBreak})function ${functionName}\([^()]*\) \{[\s\S]*?${lineBreak}\}`, 'g'))];
  const body = functions[0]?.[0];
  const match = body && pattern.exec(body);
  if (functions.length !== 1 || !body.includes(usage) || [...body.matchAll(declaration)].length !== 1
    || !match || !Number.isSafeInteger(Number(match[2])))
    throw new Error('DevEco C++ CLI compatibility anchor is missing or ambiguous');
  if (value === undefined) return source;
  return replaceOnce(source, body, replaceOnce(body, match[0], `${match[1]}${value}${match[3]}`));
}

function adaptSource(source, seconds, useIde = false) {
  // The entry option controls the Node-side timer. Keep the Java payload's 60 s file limit.
  if ([...source.matchAll(/(?:^|\s|\\n)const CPP_SCAN_TIMEOUT_SECONDS\b/g)].length !== 1
    || !source.includes('const CPP_SCAN_TIMEOUT_SECONDS = 60;') || !source.includes('timeout: CPP_SCAN_TIMEOUT_SECONDS,'))
    throw new Error('DevEco C++ CLI file timeout contract changed');
  source = replaceInteger(source, 'scanCppFiles', /\bconst cppScanOptions\b/g, cppOptions,
    'scanCppByPaths(tempDir, mergedApiChangeList, cppScanOptions, cppStart)', seconds);
  // Source-launcher config is read from a file, so the Java command-line limit does not require rescanning each file per rule chunk.
  source = replaceInteger(source, 'scanCppByJar', /\bconst CMD_LINE_LIMIT\b/g, commandLimit,
    'singleChunkJson.length <= CMD_LINE_LIMIT', useIde ? 'Infinity' : undefined);
  const timer = 'const JAR_SCAN_TIMEOUT_MS = ((options === null || options === void 0 ? void 0 : options.timeout) || CPP_SCAN_TIMEOUT_SECONDS) * 1000;';
  source = replaceOnce(source, timer, `${timer} const moduleDeadline = Date.now() + JAR_SCAN_TIMEOUT_MS;`);
  source = replaceOnce(source, '}, JAR_SCAN_TIMEOUT_MS);', '}, Math.max(1, moduleDeadline - Date.now()));');
  const javaExit = 'console.error(`Java process exited with code ${code}`);';
  source = replaceOnce(source, javaExit, `${javaExit} if (stderr) console.error(stderr.slice(-8000)); if (stdout) console.error(stdout.slice(-8000));`);
  const javaResult = 'const result = JSON.parse(stdout.trim());';
  source = replaceOnce(source, javaResult, `${javaResult} if (!result.fileNum && stderr) console.error(stderr.slice(-8000));`);
  const fallback = 'console.log(`Scanning ${jarResult.failedFiles.length} failed files with grep...`);';
  const evidence = `console.error('${skippedPrefix}' + JSON.stringify(jarResult.failedFiles));`;
  if (!useIde) return replaceOnce(source, fallback, `${evidence} return jarResult;`);

  source = replaceOnce(source, 'const jarPath = findCapiscanJar();', 'const jarPath = ide.engine;');
  source = replaceOnce(source, 'const javaExe = yield findJavaExe();', 'const javaExe = ide.java;');
  source = replaceOnce(source, 'const ninja = findNinja(modulePath);', 'const ninja = ide.ninja;');
  source = replaceOnce(source, "const spawnArgs = ['com.huawei.deveco.programanalysis.apiscan.capiscan.CAPIScanner', jsonString];",
    'const spawnArgs = ide.javaArgs(jsonString);');
  source = replaceOnce(source, "console.log('Falling back to grep scan...');", 'throw e;');
  source = replaceOnce(source, fallback, evidence);
  source = replaceOnce(source, 'for (const failedFile of jarResult.failedFiles) {', 'for (const failedFile of ide.scopedFailures(jarResult.failedFiles)) {');
  return replaceOnce(source, 'csvContent: jarResult.csvContent + generateCsvFromLineApiChangeInfo(grepResults),',
    'csvContent: ide.keepSemanticRows(jarResult.csvContent, grepResults),');
}

// Which adaptations apply to this CLI source. Anchors that are missing or ambiguous disable the adaptation.
function probe(source) {
  const applies = useIde => { try { adaptSource(source, 900, useIde); return true; } catch { return false; } };
  return { timeout: applies(false), ide: applies(true) };
}

function comparable(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function scopedFailures(failedFiles, allowedFiles) {
  const allowed = new Set(allowedFiles.map(file => comparable(path.resolve(file))));
  const scoped = new Set();
  for (const file of failedFiles) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
    let physical;
    try { physical = realpathSync.native(file); }
    catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) continue; throw error; }
    if (allowed.has(comparable(physical))) scoped.add(physical);
  }
  return [...scoped];
}

function ideJavaArgs(classpath, input) {
  return ['--source', '17', '--class-path', classpath.map(item => item.file).join(path.delimiter),
    path.join(__dirname, 'DevEcoCppBridge.java'), input];
}

function loadIde(configFile, hash, build) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const [engine, json] = config.classpath;
  if (!engine || !json || (build && (engine.sha256 !== build.ideJar || json.sha256 !== build.jsonJar))
    || config.classpath.some(item => hash(readFileSync(item.file)) !== item.sha256))
    throw new Error('DevEco IDE C++ engine or dependencies changed after capability detection');
  const input = path.join(path.dirname(configFile), 'java-input.json');
  const candidates = path.join(path.dirname(configFile), 'text-candidates.json');
  return {
    engine: engine.file, java: config.java, ninja: config.ninja,
    javaArgs(payload) {
      writeFileSync(input, payload, { flag: 'wx' });
      return ideJavaArgs(config.classpath, input);
    },
    scopedFailures: failedFiles => scopedFailures(failedFiles, config.allowedFiles),
    keepSemanticRows(content, hits) {
      try {
        writeFileSync(candidates, JSON.stringify(hits.map(hit => ({
          scanId: hit.apiChangeItem.interfaceChanges.id, file: hit.filePath, line: hit.lineNumber,
        }))), { flag: 'wx' });
      } catch (error) { console.error('HARMONY_CPP_CANDIDATES_FAILED ' + error.message); }
      return content;
    },
  };
}

function run(entry, seconds, args, configFile, expected) {
  const bytes = readFileSync(entry);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const cliHash = hash(bytes);
  const build = buildForCli(cliHash);
  // The caller passes the hashes it saw at capability detection; a verified build may rely on the table instead.
  const [expectedCli, expectedJar] = expected ? expected.split(',') : [build?.cli, build?.nativeJar];
  if (!expectedCli || cliHash !== expectedCli || (build && expectedCli !== build.cli)
    || (!configFile && hash(readFileSync(nativeJarPath(entry))) !== (build?.nativeJar ?? expectedJar)))
    throw new Error('DevEco C++ CLI or bundled JAR changed after capability detection');
  const ide = configFile ? loadIde(configFile, hash, build) : null;
  const filename = path.resolve(entry);
  process.argv = [process.execPath, filename, ...args];
  const vendor = { exports: {}, filename };
  const execute = compileFunction(adaptSource(bytes.toString('utf8'), seconds, Boolean(ide)),
    ['exports', 'require', 'module', '__filename', '__dirname', 'ide'], { filename });
  execute(vendor.exports, createRequire(filename), vendor, filename, path.dirname(filename), ide);
}

if (require.main === module) {
  const [entry, seconds, ...args] = process.argv.slice(2);
  const budget = Number(seconds);
  if (!Number.isInteger(budget) || budget < 60 || budget > 1800) throw new Error('Invalid DevEco C++ module timeout');
  const take = flag => args[0] === flag ? args.splice(0, 2)[1] : undefined;
  const expected = take('--expect');
  run(entry, budget, args, take('--ide-config'), expected);
}

module.exports = { adaptSource, probe, run, skippedPrefix, supportedBuilds, buildForCli, nativeJarPath, scopedFailures, ideJavaArgs };

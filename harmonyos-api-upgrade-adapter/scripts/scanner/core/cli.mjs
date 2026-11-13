import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertBatchDirectory, ensureBatchDirectory } from '../../shared/platform/artifact-layout.mjs';
import {initTask,beginTaskScan,completeTaskScan,importTaskCsv,registerTaskProject} from '../../shared/platform/task-context.mjs';
export {runTimestamp,createRunOutputDirectory} from '../../shared/platform/task-context.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs, integerArg, requireString, stringList } from '../../shared/format/args.mjs';
import { discoverDevEco, validateTargetCoverage } from './deveco.mjs';
import { assertUpgradeRange, canonicalHarmonyVersion as canonicalVersion } from '../../shared/platform/version.mjs';
import { auditDeprecationRules, compileRules } from './rules.mjs';
import { loadProject } from './project.mjs';
import { createCodeSize } from './code-size.mjs';
import { ensureNativeBuild, verifyNativeContexts } from '../native/native.mjs';
import { runDevEcoScan } from './scan-runner.mjs';
import { atomicWrite, exists, sha256 } from '../../shared/io/fs-utils.mjs';
import { buildSdkCatalog } from './sdk-deprecations.mjs';
import { scanArkTsDeprecations } from '../deprecated/arkts-deprecations.mjs';
import { importDeprecatedBuildLog } from '../deprecated/build-log.mjs';
import { serializeError } from '../../shared/platform/errors.mjs';
import { runtimeIdentity } from './runtime-identity.mjs';
import { prepareOfficialComparison } from '../behavior/upgrade-coverage.mjs';
import { applyProjectRuleExclusions, verifyProjectRuleExclusions } from '../behavior/project-applicability.mjs';
import { findingStatistics } from '../../shared/platform/scan-statistics.mjs';
import { discoverScanVersions, resolveScanVersion } from '../../shared/platform/scan-versions.mjs';
import { requireScanMode } from '../../shared/platform/scan-mode.mjs';
import { inspectEnvironment } from './environment.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultReferenceRoot = path.resolve(packageRoot, '..', '..', 'references', 'changelogs');

export function usage() {
  return `HarmonyOS API compatibility scanner

Commands:
  inspect-environment [--sdk <path>] [--deveco-home <path>] [--project <path>] [--to <version>] [--output <environment.json>]
  init-task --task-root <launch-directory> [--output-dir <output-root>] [--project <path>] [--mode upgrade|deprecated]
  register-project --task <taskFile> --project <path> --mode upgrade|deprecated
  scan --task <taskFile> --project <path> --sdk <path> --from <version> [--to <version>]
       [--deveco-home <path>]
       [--product <name>] [--scan-dir <path>] [--scan-module <name>] [--exclude-dir <path>] [--project-type app|har] [--native-build auto|off]
       [--rn-js-root <RN JS 工程目录>]
       [--batch-size <count>] [--references <path>] [--output-dir <path>]
       [--cpp-module-timeout-seconds <60–1800>]
       [--build-log <path>] [--build-evidence <path>]
       [--scan-purpose initial|rescan]
       --mode upgrade|deprecated
  import-csv --task <taskFile> --project <path> --mode upgrade|deprecated --csv <path> [--encoding auto|utf-8|gb18030]
       [--product <name>] [--scan-dir <path>] [--scan-module <name>] [--project-type app|har] [--scan-purpose initial|rescan] [--evidence <path>]
  inspect-rules --sdk <path> --from <version> [--to <version>]
       --mode upgrade|deprecated [--deveco-home <path>] [--references <path>] [--allow-incomplete]
  inspect-environment uses DEVECO_SDK_HOME only when --sdk is omitted.
`;
}

function scanOptions(args) {
  const mode = requireScanMode(args.mode);
  const projectPath = path.resolve(requireString(args, 'project'));
  const cppModuleTimeoutSeconds = integerArg(args['cpp-module-timeout-seconds'], undefined, 'cpp-module-timeout-seconds');
  if (cppModuleTimeoutSeconds !== undefined && (cppModuleTimeoutSeconds < 60 || cppModuleTimeoutSeconds > 1800))
    throw new Error('--cpp-module-timeout-seconds must be between 60 and 1800');
  return {
    projectPath,
    sdkPath: path.resolve(requireString(args, 'sdk')),
    devecoHome: args['deveco-home'] ? path.resolve(requireString(args, 'deveco-home')) : null,
    from: requireString(args, 'from'),
    to: typeof args.to === 'string' ? args.to : null,
    productName: typeof args.product === 'string' ? args.product : 'default',
    scanDirs: stringList(args['scan-dir']),
    scanModules: stringList(args['scan-module']),
    rnJsRoot: args['rn-js-root'] === undefined ? null : path.resolve(requireString(args, 'rn-js-root')),
    excludeDirs: args['exclude-dir'] === undefined ? undefined : [args['exclude-dir']].flat()
      .map(directory => requireString({'exclude-dir':directory},'exclude-dir')),
    projectType: args['project-type'] || 'app',
    nativeBuild: args['native-build'] ?? 'auto',
    cppModuleTimeoutSeconds,
    batchSize: integerArg(args['batch-size'], 1000, 'batch-size'),
    mode,
    referenceRoot: path.resolve(args.references || defaultReferenceRoot),
    outputRoot: typeof args['output-dir']==='string'?args['output-dir']:null,
    taskFile:typeof args.task==='string'?path.resolve(args.task):null,
    scanPurpose:args['scan-purpose'] ?? 'initial',
    buildLog: args['build-log'] ? path.resolve(requireString(args, 'build-log')) : null,
    buildEvidence: args['build-evidence'] ? path.resolve(requireString(args, 'build-evidence')) : null,
  };
}

export function resolveScanTargetVersion(to, toolchain, versions = undefined) {
  const selected = to || toolchain?.sdkVersion;
  if (!selected) {
    const error = new Error('Target SDK version is missing and cannot be inferred from the selected toolchain');
    error.code = 'TARGET_SDK_UNRESOLVED';
    throw error;
  }
  const value = typeof selected === 'object' && !Array.isArray(selected) && !selected.key
    ? selected.raw : selected;
  const input = typeof value === 'object' ? canonicalVersion(value) : value;
  return { version: resolveScanVersion(input,{endpoint:'to',compileSdkVersion:toolchain?.sdkVersion?.raw ?? toolchain?.sdkVersion,versions}), source: to ? 'to' : 'toolchain' };
}

async function inspectRules(args) {
  const mode = requireScanMode(args.mode);
  const sdkPath = path.resolve(requireString(args, 'sdk'));
  const referenceRoot = path.resolve(args.references || defaultReferenceRoot);
  const devecoHome = args['deveco-home'] ? path.resolve(requireString(args, 'deveco-home')) : null;
  const toolchain = await discoverDevEco(sdkPath, devecoHome, { targetVersion: typeof args.to === 'string' ? args.to : null });
  const versions = await discoverScanVersions(toolchain);
  const target = resolveScanTargetVersion(typeof args.to === 'string' ? args.to : null, toolchain, versions);
  const range = assertUpgradeRange(resolveScanVersion(requireString(args,'from'),{endpoint:'from',versions}), target.version);
  validateTargetCoverage(toolchain, range.end);
  const compiled = await compileRules({ toolchain, referenceRoot, range, strict: args['allow-incomplete'] !== true, mode });
  const catalog = await buildSdkCatalog(toolchain, range.end);
  const deprecationValidation = mode === 'upgrade' ? { status: 'NOT_APPLICABLE' } : await auditDeprecationRules(toolchain, compiled.rules, catalog);
  const { excluded, errors, ...summary } = compiled.coverage;
  return {
    sdk: toolchain.sdkMetadata.data,
    toolchain: {
      deveco: toolchain.productInfo,
      devecoCompatibility: toolchain.devecoCompatibility,
      backend: toolchain.apiChangeBackend,
      scanner: toolchain.apiChangeScan,
      resources: toolchain.apiChangeResourceRoot,
      resourceArchive: toolchain.apiChangeResourceArchive,
      parser: toolchain.parserPath,
      cApiScanJar: toolchain.cApiScanJar,
    },
    coverage: { ...summary, deprecationValidation, deprecationCatalog: catalog.coverage },
    errorSample: errors.slice(0, 20),
    excludedSample: excluded.slice(0, 20),
  };
}

export function selectScanRules(rules, mode) {
  requireScanMode(mode);
  if (mode === 'upgrade') return rules.filter(rule => rule.provider === 'DEVECO' && rule.changeType !== 'Deprecated API');
  const scoped = rules.filter(rule => rule.changeType === 'Deprecated API');
  return scoped.filter(rule => rule.changeOperation !== 'API_DEPRECATED'
    || rule.affectedApis[0]?.implementLanguage.toLowerCase() !== 'typescript');
}

async function scan(args) {
  const options = scanOptions(args);
  if (!['auto', 'off'].includes(options.nativeBuild)) throw new Error('--native-build must be auto or off');
  if (options.batchSize !== 1000) {
    throw new Error('The DevEco v1 backend supports --batch-size 1000 only');
  }
  const outputLayout = await beginTaskScan(options.taskFile,options);
  const exclusions = outputLayout.exclusionOptions;
  const outputDirectory=outputLayout.taskDirectory;
  options.outputRoot=outputLayout.outputRoot;
  await ensureBatchDirectory(outputLayout, outputLayout.scannerDirectory);
  const coverageJson = outputLayout.coverageJson;
  const diagnosticsJson = outputLayout.diagnosticsJson;
  let runtime = null;
  let diagnostics = { schemaVersion: 1, status: 'FAILED', runtime, options: { ...options, projectPath: options.projectPath } };
  let stage = 'READ_TOOL_IDENTITY';
  try {
    runtime=await runtimeIdentity(path.resolve(packageRoot,'..','..'),{mode:options.mode});diagnostics.runtime=runtime;
    stage='DISCOVER_TOOLCHAIN';
    const toolchain = await discoverDevEco(options.sdkPath, options.devecoHome, { targetVersion: options.to });
    options.sdkPath = toolchain.sdkRoot;
    const versions = await discoverScanVersions(toolchain);
    const rawInputs = {from:options.from,to:options.to};
    const target = resolveScanTargetVersion(options.to, toolchain, versions);
    options.from = resolveScanVersion(options.from,{endpoint:'from',versions});
    options.to = target.version;
    options.versionResolution = {rawInputs,scanFromSdkVersion:options.from,scanToSdkVersion:options.to,
      compileSdkVersion:canonicalVersion(toolchain.sdkVersion)};
    options.targetVersionSource = target.source;
    const range = assertUpgradeRange(options.from, options.to);
    stage = 'VALIDATE_TARGET_COVERAGE';
    validateTargetCoverage(toolchain, range.end);
    stage = 'LOAD_PROJECT';
    const project = await loadProject(options.projectPath, options.productName, options.scanDirs, options.scanModules, options.projectType, exclusions);
    // RNOH only: explicit JS project location for layouts the automatic lookup cannot resolve.
    if (options.rnJsRoot) project.rnJsRoot = options.rnJsRoot;
    stage = 'COMPILE_RULES';
    const compiled = await compileRules({ toolchain, referenceRoot: options.referenceRoot, range, strict: true, mode: options.mode });
    let applicabilityInputs = [];
    if (options.mode === 'upgrade') {
      stage = 'COMPARE_OFFICIAL_CHANGELOG';
      compiled.coverage.upgrade = await prepareOfficialComparison({toolchain,referenceRoot:options.referenceRoot,range,compiled});
      stage = 'CHECK_PROJECT_RULE_APPLICABILITY';
      const applicability = await applyProjectRuleExclusions(compiled.rules, project, compiled.coverage.upgrade);
      compiled.rules = applicability.rules;
      applicabilityInputs = applicability.inputs;
      compiled.coverage.projectApplicability = applicability.audit;
      compiled.coverage.includedRuleCount = compiled.rules.length;
      compiled.coverage.excludedRuleCount += applicability.audit.excludedRuleCount;
      compiled.coverage.excluded.push(...applicability.audit.excluded.map(({ applicabilityProof, ...entry }) => entry));
    }
    stage = 'BUILD_SDK_CATALOG';
    const catalog = await buildSdkCatalog(toolchain, range.end);
    stage = 'AUDIT_DEPRECATION_RULES';
    const deprecationValidation = options.mode === 'upgrade' ? { status: 'NOT_APPLICABLE' } : await auditDeprecationRules(toolchain, compiled.rules, catalog);
    if (catalog.coverage.status !== 'COMPLETE') {
      const error = new Error('Target SDK declaration catalog is incomplete');
      error.code = 'SDK_CATALOG_INCOMPLETE'; error.details = catalog.coverage.errors; throw error;
    }
    stage = 'SCAN_ARKTS_DEPRECATIONS';
    const deprecations = options.mode === 'upgrade'
      ? { findings: [], unresolved: [], analyzedFiles: [], coverage: { status: 'NOT_APPLICABLE' } }
      : await scanArkTsDeprecations({ project, catalog });
    deprecations.catalogCoverage = catalog.coverage;
    if (deprecations.unresolved.length) {
      await assertBatchDirectory(outputLayout, outputLayout.scannerDirectory);
      await atomicWrite(outputLayout.scanJson, `${JSON.stringify({
        schemaVersion: 3, sourceSnapshot: project.sourceSnapshot, status: 'INCOMPLETE',
        deprecationCatalog: catalog.coverage, deprecationCoverage: deprecations.coverage,
        unresolved: deprecations.unresolved, resolutionWarnings: deprecations.resolutionWarnings,
        findings: deprecations.findings,
      }, null, 2)}\n`);
      const error = new Error(`${deprecations.unresolved.length} unresolved SDK/source references prevent a complete scan`);
      error.code = 'UNRESOLVED_DEPRECATION_REFERENCES'; error.details = deprecations.unresolved.slice(0, 30); throw error;
    }
    stage = 'IMPORT_BUILD_LOG';
    const buildLogImport = options.mode === 'upgrade' ? null : await importDeprecatedBuildLog({ project, catalog, logPath: options.buildLog, evidencePath: options.buildEvidence });
    const ruleSnapshot = sha256(catalog.snapshot + JSON.stringify(compiled.rules.map((rule) => ({
      ruleId: rule.ruleId,
      changedInSdk: rule.changedInSdk,
      changeOperation: rule.changeOperation,
      reportDisposition: rule.reportDisposition ?? 'REQUIRES_REVIEW',
      filterReason: rule.filterReason ?? null,
      applicabilityProof: rule.applicabilityProof ?? null,
      replacementApi: rule.replacementApi ?? null,
      replacementSource: rule.replacementSource ?? null,
      sourceReference: rule.sourceReference,
      affectedApis: rule.affectedApis,
    }))));
    stage = 'WRITE_INITIAL_COVERAGE';
    await assertBatchDirectory(outputLayout, outputLayout.scannerDirectory);
    await atomicWrite(coverageJson, `${JSON.stringify({
      ...compiled.coverage,
      ruleSnapshot,
      deprecationValidation,
      deprecationCatalog: catalog.coverage,
    }, null, 2)}\n`);
    stage = 'NATIVE_BUILD';
    const nativeBuilds = await ensureNativeBuild({
      project,
      toolchain,
      mode: options.nativeBuild,
    });
    const verifyNativeInputs = () => verifyNativeContexts({ project, toolchain, records: nativeBuilds });
    stage = 'RUN_DEVECO_SCAN';
    const result = await runDevEcoScan({
      toolchain,
      project,
      range,
      rules: selectScanRules(compiled.rules, options.mode),
      outputDirectory,
      outputLayout:{...outputLayout,rawCsv:outputLayout.workRawCsv},
      batchId: outputLayout.batchId,
      deprecations,
      buildLogImport,
      mode: options.mode,
      devecoVersionNames: compiled.coverage.devecoVersionNames,
      runtime,
      verifyNativeInputs,
      nativeBuilds,
      cppModuleTimeoutSeconds: options.cppModuleTimeoutSeconds,
      officialComparison: compiled.coverage.upgrade ?? null,
      projectApplicability: compiled.coverage.projectApplicability,
      verifyInputs: async (rnoh) => {
        await verifyNativeInputs();
        for (const source of compiled.coverage.upgrade?.sources ?? [])
          if (sha256(await readFile(source.file)) !== source.hash) throw new Error(`官方条目或规则包来源已变化：${source.file}`);
        const codeSize = createCodeSize(project, catalog);
        const afterProject = await loadProject(options.projectPath, options.productName, options.scanDirs, options.scanModules, options.projectType,
          { ...exclusions, onSourceSnapshotFile: codeSize.addHarmony });
        const afterCatalog = await buildSdkCatalog(toolchain, range.end);
        const changed = [];
        if (afterProject.sourceSnapshot !== project.sourceSnapshot) changed.push('project sources');
        if (afterProject.sourceScope.fingerprint !== project.sourceScope.fingerprint) changed.push('source scope');
        if (afterProject.buildProfileHash !== project.buildProfileHash) changed.push('build-profile.json5');
        if (afterCatalog.snapshot !== catalog.snapshot) changed.push('SDK declarations/parser');
        for (const item of deprecations.analyzedFiles) {
          if (sha256(await readFile(item.file)) !== item.hash) changed.push(item.file);
        }
        if (changed.length) {
          const error = new Error('Scan input changed before report publication');
          error.code = 'SOURCE_CHANGED_DURING_SCAN'; error.details = changed; throw error;
        }
        await codeSize.addRnoh(rnoh);
        return codeSize.result();
      },
    });
    stage = 'VERIFY_SOURCE_SNAPSHOT';
    const after = await loadProject(options.projectPath, options.productName, options.scanDirs, options.scanModules, options.projectType, exclusions);
    if (after.sourceSnapshot !== project.sourceSnapshot || after.sourceScope.fingerprint !== project.sourceScope.fingerprint) {
      const error = new Error('Project source changed during the scan');
      error.code = 'SOURCE_CHANGED_DURING_SCAN';
      throw error;
    }
    const warnings = [...result.diagnostics.warnings];
    if (compiled.coverage.upgrade) {
      const hitRules = new Set(result.allFindings.map(finding => finding['Rule ID']));
      for (const entry of compiled.coverage.upgrade.entries) if (entry.status === 'RULE_AVAILABLE' && !entry.projectStatus)
        entry.projectStatus = entry.ruleIds.some(id => hitRules.has(id)) ? 'HIT' : 'NOT_RELATED_TO_PROJECT';
    }
    if (compiled.coverage.upgrade?.missingRuleCount) warnings.push(
      `当前加载的 DevEco ${toolchain.productInfo?.version ?? '未知版本'} 插件规则包未覆盖官方文档中 ${compiled.coverage.upgrade.missingRuleCount} 条变更：`
      + compiled.coverage.upgrade.missing.map(entry => `${entry.title}（${entry.changedInSdk}；${entry.sourceUrl ?? entry.sourceReference}）`).join('、')
      + `；官方规则覆盖为 INCOMPLETE，详见 ${coverageJson}`);
    if (options.mode === 'upgrade') {
      const missingLinks = [...new Map(result.allFindings.filter(finding => !finding.documentLink?.url)
        .map(finding => [finding['Rule ID'], finding])).values()];
      if (missingLinks.length) warnings.push(`以下命中缺少唯一条目链接，Title 保留纯文本：${missingLinks.map(finding => finding['Rule ID']).join('、')}`);
    }
    const scanStatistics = { loadedRuleCount: compiled.coverage.devecoRuleCount, raw: findingStatistics(result.findings) };
    const coverage = {
      ...compiled.coverage,
      ruleSnapshot,
      deprecationValidation,
      deprecationCatalog: catalog.coverage,
      scanCoverage: {
        arkts: 'COMPLETE',
        deprecations: deprecations.coverage,
        cpp: result.diagnostics.cppStatus,
        nativePasses: result.diagnostics.nativePasses,
      },
      scanStatistics,
    };
    stage = 'WRITE_RESULTS';
    await assertBatchDirectory(outputLayout, outputLayout.scannerDirectory);
    await atomicWrite(coverageJson, `${JSON.stringify(coverage, null, 2)}\n`);
    stage = 'VERIFY_PROJECT_RULE_APPLICABILITY';
    await verifyProjectRuleExclusions(applicabilityInputs);
    stage = 'WRITE_RESULTS';
    diagnostics = {
      schemaVersion: 1,
      runtime,
      status: warnings.length ? 'COMPLETE_WITH_WARNINGS' : 'COMPLETE',
      inputs: {
        project: project.root,
        sdk: toolchain.sdkRoot,
        devecoHome: toolchain.contentsRoot,
        from: options.from,
        to: options.to,
        targetSdkVersionSource: options.targetVersionSource,
        product: project.product.name,
        scanDirs: project.scanDirs.map((item) => item.relative),
        scanModules: project.sourceScope.scanModules,
        excludeDirs: project.sourceScope.excludeDirs,
        exclusionPolicy: project.sourceScope.exclusionPolicy,
        projectType: options.projectType,
        nativeBuild: options.nativeBuild,
        cppModuleTimeoutSeconds: options.cppModuleTimeoutSeconds,
        mode: options.mode,
        batchSize: options.batchSize,
        buildLog: options.buildLog,
        buildEvidence: options.buildEvidence,
      },
      sourceSnapshot: project.sourceSnapshot,
      sourceScope: project.sourceScope,
      scannedFiles: project.sourceFiles.map(file => path.relative(project.root, file).split(path.sep).join('/')),
      ruleSnapshot,
      deprecationCatalog: catalog.coverage,
      deprecationCoverage: deprecations.coverage,
      toolchain: {
        sdk: toolchain.sdkMetadata.data,
        deveco: toolchain.productInfo,
        devecoCompatibility: toolchain.devecoCompatibility,
        backend: toolchain.apiChangeBackend,
        scanCapabilities:{moduleScope:toolchain.moduleScanSupported,fileScope:toolchain.fileScanSupported,evidence:toolchain.capabilityEvidence},
        paths: {
          home: toolchain.contentsRoot,
          analyzer: toolchain.analyzerRoot,
          scanner: toolchain.apiChangeScan,
          resources: toolchain.apiChangeResourceRoot,
          resourceArchive: toolchain.apiChangeResourceArchive,
          parser: toolchain.parserPath,
          cApiScanJar: toolchain.cApiScanJar,
        },
        hashes: toolchain.hashes,
      },
      nativeBuilds,
      nativePasses: result.diagnostics.nativePasses,
      findingCount: result.findings.length,
      scanStatistics,
      totalFindingCount: result.allFindings.length,
      filteredFindingCount: result.filteredFindings.length,
      actionGroupCount: result.actionGroups.length,
      validationGroupCount: result.validationGroups.length,
      filterSummary: result.diagnostics.filterSummary,
      durationMs: result.diagnostics.durationMs,
      backend: toolchain.apiChangeBackend,
      deveco: toolchain.productInfo,
      devecoCompatibility: toolchain.devecoCompatibility,
      warnings,
      scannerOutput: {
        ...(result.diagnostics.cleanupWarning ? { cleanupWarning: result.diagnostics.cleanupWarning } : {}),
        stdout: result.diagnostics.stdout,
        stderr: result.diagnostics.stderr,
      },
    };
    await atomicWrite(diagnosticsJson, `${JSON.stringify(diagnostics, null, 2)}\n`);
    const publishedLayout=await completeTaskScan(options.taskFile,outputLayout.batchId);
    return {
      outputCsv: publishedLayout.rawCsv,
      outputLayout:publishedLayout, batchId: outputLayout.batchId,
      scanStatistics,
      ...(compiled.coverage.upgrade ? { officialCoverage: { status: compiled.coverage.upgrade.status,
        missingRuleCount: compiled.coverage.upgrade.missingRuleCount, missing: compiled.coverage.upgrade.missing,
        rulePack: compiled.coverage.upgrade.rulePack } } : {}),
      validationCsv: result.validationCsv,
      scanJson: result.scanJson,
      coverageJson,
      diagnosticsJson,
      findingCount: result.findings.length,
      totalFindingCount: result.allFindings.length,
      filteredFindingCount: result.filteredFindings.length,
      actionGroupCount: result.actionGroups.length,
      validationGroupCount: result.validationGroups.length,
      filterSummary: result.diagnostics.filterSummary,
      durationMs: result.diagnostics.durationMs,
      warnings,
      ruleSnapshot,
      resolvedTargetSdkVersion: options.to,
      compileSdkVersion: canonicalVersion(toolchain.sdkVersion),
      ...(compiled.coverage.upgrade ? { officialCoverageStatus: compiled.coverage.upgrade.status } : {}),
      targetSdkVersionSource: options.targetVersionSource,
      runtime,
    };
  } catch (error) {
    if (error && typeof error === 'object') error.stage ??= stage;
    if (error && typeof error === 'object') error.code ??= 'SCAN_FAILED';
    if (error && typeof error === 'object') error.artifactPaths ??= [diagnosticsJson];
    diagnostics = {
      ...diagnostics,
      error: serializeError(error, { command: 'scan', stage }),
    };
    await assertBatchDirectory(outputLayout, outputLayout.scannerDirectory);
    await atomicWrite(diagnosticsJson, `${JSON.stringify(diagnostics, null, 2)}\n`);
    try {await completeTaskScan(options.taskFile,outputLayout.batchId,{error});}
    catch(updateError){error.taskUpdateError={code:updateError.code,message:updateError.message};}
    throw error;
  }
}

export async function execute(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'inspect-environment': return inspectEnvironment({ sdkPath: args.sdk === undefined ? undefined : requireString(args, 'sdk'),
      devecoHomePath: args['deveco-home'] === undefined ? null : requireString(args, 'deveco-home'),
      projectPath: args.project === undefined ? null : requireString(args, 'project'),
      targetVersion: args.to === undefined ? null : requireString(args, 'to'),
      outputPath: args.output === undefined ? null : requireString(args, 'output') });
    case 'init-task': return initTask(requireString(args,'task-root'),{outputRoot:args['output-dir'] ?? null,
      projects:args.project===undefined?[]:Array.isArray(args.project)?args.project:[args.project],mode:args.mode ?? 'upgrade'});
    case 'register-project': return registerTaskProject(args.task,{projectPath:path.resolve(requireString(args,'project')),mode:requireScanMode(args.mode)});
    case 'import-csv': return importTaskCsv(typeof args.task==='string'?path.resolve(args.task):null,{
      projectPath:path.resolve(requireString(args,'project')),mode:requireScanMode(args.mode),inputCsv:requireString(args,'csv'),
      productName:args.product ?? 'default',projectType:args['project-type'] ?? 'app',scanDirs:stringList(args['scan-dir']),
      scanModules:stringList(args['scan-module']),scanPurpose:args['scan-purpose'] ?? 'initial',outputRoot:args['output-dir'] ?? null,
      encoding:args.encoding===undefined?'auto':requireString(args,'encoding'),
      evidenceFiles:args.evidence===undefined?[]:Array.isArray(args.evidence)?args.evidence:[args.evidence]});
    case 'scan': return scan(args);
    case 'inspect-rules': return inspectRules(args);
    case 'help':
    case '--help':
    case '-h':
    case undefined: return { usage: usage() };
    default: throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

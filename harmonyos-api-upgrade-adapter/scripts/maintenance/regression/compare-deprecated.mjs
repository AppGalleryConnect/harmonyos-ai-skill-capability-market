import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDeprecatedBuildLog } from '../../scanner/deprecated/build-log.mjs';
import { parseJson5 } from '../../shared/format/json5.mjs';
import { parseArgs, requireString } from '../../shared/format/args.mjs';
import { sha256 } from '../../shared/io/fs-utils.mjs';
import { fileURLToPath } from 'node:url';
import { relativePathInside, samePath, comparableCodeLocation, portablePath } from '../../shared/platform/paths.mjs';

export async function compareDeprecated({ project, buildLog, scanJson, buildProjectRoot = project, buildEvidence = null, platform = process.platform }) {
  const profile = parseJson5(await readFile(path.join(project, 'build-profile.json5'), 'utf8'));
  const modules = profile.modules.map(item => ({ name: item.name, directory: portablePath(item.srcPath).replace(/^\.\//, '') }));
  const scan = JSON.parse(await readFile(scanJson, 'utf8'));
  const logText = await readFile(buildLog, 'utf8');
  const gold = parseDeprecatedBuildLog(logText);
  function location(relative) {
    const module = modules.find(item => comparableCodeLocation(relative, null, platform).startsWith(`${comparableCodeLocation(item.directory, null, platform)}/`));
    return module ? module.name + relative.slice(module.directory.length) : relative;
  }
  const rows = scan.findings.filter(item => item['Change Operation'] === 'API_DEPRECATED');
  const records = gold.map(item => {
    const relative = item.file ? relativePathInside(buildProjectRoot, item.file, platform) : null;
    if (!relative) return { ...item, outcome: 'UNMAPPED_LOCATION' };
    const codeLocation = `${location(relative)}:${item.line}`;
    const matched = rows.find(row => comparableCodeLocation(row['Code Location'], null, platform) === comparableCodeLocation(codeLocation, null, platform) && Number(row.Column) === item.column
      && [row.sdkEvidence?.name, row.sourceSymbol, row.compilerEvidence?.symbol].includes(item.symbol));
    return { ...item, codeLocation, sourceScope: relative.split('/').includes('oh_modules') ? 'DEPENDENCY' : 'PROJECT',
      outcome: matched ? 'MATCHED' : relative.split('/').includes('oh_modules') ? 'DEPENDENCY_EXCLUDED' : 'MISSING',
      occurrenceId: matched?.occurrenceId ?? null };
  });
  const matchedIds = new Set(records.map(item => item.occurrenceId).filter(Boolean));
  const evidence = buildEvidence ? JSON.parse(await readFile(buildEvidence, 'utf8')) : null;
  const verified = evidence?.sourceSnapshot === scan.sourceSnapshot && evidence?.sdkSnapshot === scan.deprecationCoverage?.sdkSnapshot
    && evidence?.buildProfileHash === scan.buildProfileHash
    && evidence?.nonIncremental === true && evidence?.status === 'PASSED' && evidence?.logHash === sha256(logText)
    && evidence?.targetSdk === scan.deprecationCatalog?.targetSdk && typeof evidence?.projectRoot === 'string'
    && samePath(evidence.projectRoot, buildProjectRoot, platform);
  return { schemaVersion: 1, evidenceStatus: verified ? 'MATCHED_BUILD_SNAPSHOT' : 'UNVERIFIED_HISTORICAL_LOG',
    goldCount: records.length, projectGoldCount: records.filter(item => item.sourceScope === 'PROJECT').length,
    dependencyGoldCount: records.filter(item => item.sourceScope === 'DEPENDENCY').length,
    matchedCount: records.filter(item => item.outcome === 'MATCHED').length,
    projectMissingCount: records.filter(item => item.outcome === 'MISSING').length,
    unmappedCount: records.filter(item => item.outcome === 'UNMAPPED_LOCATION').length,
    scannerOnlyCount: rows.filter(item => !matchedIds.has(item.occurrenceId)).length,
    // Compiler silence is not a negative label; these require declaration evidence, not deletion.
    scannerOnly: rows.filter(item => !matchedIds.has(item.occurrenceId)).map(item => ({
      codeLocation: item['Code Location'], column: item.Column, sdkEvidence: item.sdkEvidence, outcome: 'SCANNER_ONLY_NOT_AUTOMATICALLY_FALSE_POSITIVE' })),
    records };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = await compareDeprecated({ project: requireString(args, 'project'), buildLog: requireString(args, 'build-log'),
    scanJson: requireString(args, 'scan-json'), buildProjectRoot: args['build-project-root'] || args.project, buildEvidence: args['build-evidence'] || null });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.projectMissingCount || result.unmappedCount) process.exitCode = 1;
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../shared/io/fs-utils.mjs';
import { deprecatedDocUrl } from '../core/sdk-deprecations.mjs';
import { hyperlink } from '../../shared/format/csv.mjs';
import { relativePathInside, comparableCodeLocation } from '../../shared/platform/paths.mjs';

export function parseDeprecatedBuildLog(text) {
  const diagnostics = [];
  let location = null;
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/File:\s*(.+?):(\d+):(\d+)/);
    if (match) location = { file: match[1].replaceAll('\\', '/'), line: Number(match[2]), column: Number(match[3]) };
    const deprecated = line.match(/'([^']+)' has been deprecated\./);
    if (deprecated) diagnostics.push({ ...location, symbol: deprecated[1], logLine: index + 1, located: location !== null });
    if (/^(?:>|WARN:|ERROR:)/.test(line) && !match && !deprecated) location = null;
  }
  return [...new Map(diagnostics.map(item => [[item.file, item.line, item.column, item.symbol].join('\0'), item])).values()];
}

export async function importDeprecatedBuildLog({ project, catalog, logPath = null, evidencePath = null }) {
  if (!logPath && evidencePath) throw new Error('--build-evidence requires --build-log');
  if (!logPath) return { findings: [], warnings: [], audit: null };
  const text = await readFile(logPath, 'utf8');
  const diagnostics = parseDeprecatedBuildLog(text);
  if (!evidencePath) return { findings: [], warnings: ['编译日志缺少配套快照证据，仅用于对比，不导入主CSV'], audit: {
    status: 'UNVERIFIED_LOG', logHash: sha256(text), diagnostics, importedCount: 0,
  } };
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const expected = { schemaVersion: 1, logHash: sha256(text), sourceSnapshot: project.sourceSnapshot,
    buildProfileHash: project.buildProfileHash, sdkSnapshot: catalog.snapshot, targetSdk: catalog.coverage.targetSdk, product: project.product.name, nonIncremental: true, status: 'PASSED' };
  const errors = Object.entries(expected).filter(([key, value]) => evidence[key] !== value).map(([key]) => key);
  const platform = catalog.platform ?? process.platform;
  const api = platform === 'win32' ? path.win32 : path;
  if (typeof evidence.projectRoot !== 'string' || !api.isAbsolute(evidence.projectRoot)) errors.push('projectRoot');
  if (errors.length) {
    const error = new Error(`Build evidence does not match this scan: ${errors.join(', ')}`);
    error.code = 'BUILD_EVIDENCE_MISMATCH'; error.details = errors; throw error;
  }
  const findings = [];
  const records = [];
  for (const diagnostic of diagnostics) {
    const relative = diagnostic.file ? relativePathInside(evidence.projectRoot, diagnostic.file, platform) : null;
    if (!relative || relative.split('/').includes('..')) { records.push({ ...diagnostic, reason: 'UNMAPPED_LOCATION' }); continue; }
    if (!relative.split('/').includes('oh_modules')) { records.push({ ...diagnostic, reason: 'PROJECT_DIAGNOSTIC_RECONCILIATION_ONLY' }); continue; }
    const binding = evidence.apiBindings?.find(item => comparableCodeLocation(item.file, null, platform) === comparableCodeLocation(relative, null, platform)
      && item.line === diagnostic.line && item.column === diagnostic.column && item.symbol === diagnostic.symbol);
    const entry = binding ? catalog.deprecatedEntries.find(item => item.symbolId === binding.symbolId) : null;
    if (binding && (!entry || entry.name !== diagnostic.symbol)) {
      const error = new Error(`Invalid SDK symbol binding in build evidence: ${relative}:${diagnostic.line}`);
      error.code = 'BUILD_API_BINDING_MISMATCH'; throw error;
    }
    const occurrenceId = `compiler-${sha256([relative, diagnostic.line, diagnostic.column, diagnostic.symbol].join('\0')).slice(0, 24)}`;
    findings.push({
      'Api Definition': entry?.declaration ?? `${diagnostic.symbol} (compiler deprecation warning)`, Language: 'ArkTS',
      'Changed in SDK': '', 'Affected Versions': 'N/A (compile-time)', Title: hyperlink(deprecatedDocUrl(entry), `${diagnostic.symbol}：第三方依赖废弃告警`),
      'Code Location': `${relative}:${diagnostic.line}`, Fixed: 'Unfixed', 'Change Type': 'Deprecated API',
      'Rule ID': entry ? `sdk-deprecated-${entry.symbolId.slice(4)}` : occurrenceId, 'Change Operation': 'API_DEPRECATED',
      'Source Reference': `${path.resolve(logPath)}:${diagnostic.logLine}`,
      'Replacement API': entry?.replacementApi ?? '', 'Replacement Source': entry ? `${entry.file}:${entry.line}` : '',
      'API Symbol ID': entry?.symbolId ?? '', Column: diagnostic.column, 'Deprecated Since': entry?.deprecatedSince ?? '',
      'Detection Source': 'BUILD_LOG', 'Source Scope': 'DEPENDENCY',
      includedInCsv: true, disposition: 'REQUIRES_REVIEW', filterReason: null, applicabilityProof: null,
      occurrenceId, evidenceStatus: entry ? 'SDK_BOUND' : 'COMPILER_ONLY', autoEditAllowed: false,
      sdkEvidence: entry ? { ...entry, sdkSnapshot: catalog.snapshot, targetSdk: catalog.coverage.targetSdk } : null,
      compilerEvidence: { ...diagnostic, logHash: evidence.logHash },
    });
    records.push({ ...diagnostic, reason: entry ? 'IMPORTED_SDK_BOUND_DEPENDENCY' : 'IMPORTED_DEPENDENCY_REQUIRES_CONFIRMATION' });
  }
  return { findings, warnings: [], audit: { status: 'VERIFIED_LOG', importedCount: findings.length, logHash: evidence.logHash, diagnostics: records } };
}

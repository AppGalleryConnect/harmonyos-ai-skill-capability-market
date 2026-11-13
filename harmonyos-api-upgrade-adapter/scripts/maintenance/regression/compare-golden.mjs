#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, requireString } from '../../shared/format/args.mjs';
import { parseCsv, titleText } from '../../shared/format/csv.mjs';
import { canonicalHarmonyVersion as canonicalVersion } from '../../shared/platform/version.mjs';
import { comparableCodeLocation } from '../../shared/platform/paths.mjs';

function normalizeLocation(value, projectRoot) {
  return comparableCodeLocation(value, projectRoot);
}

function normalizeVersion(value) {
  try {
    return canonicalVersion(String(value));
  } catch {
    return String(value).trim();
  }
}

function normalizedKey(row, projectRoot) {
  return [
    String(row['Api Definition']).replace(/\s+/g, ' ').trim(),
    row.Language,
    normalizeVersion(row['Changed in SDK']),
    titleText(row.Title),
    normalizeLocation(row['Code Location'], projectRoot),
    row['Change Type'],
  ].join('\u0000');
}

function multiset(rows, projectRoot, keyOf = normalizedKey) {
  const result = new Map();
  for (const row of rows) {
    const key = keyOf(row, projectRoot);
    const record = result.get(key) ?? { count: 0, row };
    record.count += 1;
    result.set(key, record);
  }
  return result;
}

function difference(left, right) {
  const rows = [];
  for (const [key, value] of left) {
    const remaining = value.count - (right.get(key)?.count ?? 0);
    for (let index = 0; index < Math.max(0, remaining); index += 1) rows.push(value.row);
  }
  return rows;
}

function isDevEcoRule(row) {
  if (row['Detection Source'] && row['Detection Source'] !== 'DEVECO') return false;
  if (!('Rule ID' in row)) return true;
  return !isAdditionalDocumentRule(row);
}

function isAdditionalDocumentRule(row) {
  return String(row['Source Reference']).replaceAll('\\', '/').includes('/API变更清单/');
}

const args = parseArgs(process.argv.slice(2));
const goldenPath = path.resolve(requireString(args, 'golden'));
const actualPath = path.resolve(requireString(args, 'actual'));
const projectRoot = args.project ? path.resolve(args.project) : null;
const outputPath = args.output ? path.resolve(args.output) : null;
const scanJsonPath = args['scan-json'] ? path.resolve(args['scan-json']) : null;
const golden = parseCsv(await readFile(goldenPath, 'utf8')).rows;
const actualCsv = parseCsv(await readFile(actualPath, 'utf8'));
const scan = scanJsonPath ? JSON.parse(await readFile(scanJsonPath, 'utf8')) : null;
if (!scan && actualCsv.headers.includes('Replacement API') && !actualCsv.headers.includes('Rule ID'))
  throw new Error('Reduced deprecated CSV requires --scan-json for source and symbol identities');
const fullFindings = scan ? scan.findings : actualCsv.rows;
const allActual = scan?.mode === 'deprecated' && Array.isArray(scan.actionGroups)
  ? scan.actionGroups.map(group => ({
    ...group.occurrences[0],
    'Action Type': group.actionType, 'Policy ID': group.policyId,
    'Occurrence Count': group.occurrenceCount, 'Trigger Evidence': group.triggerEvidence,
  }))
  : scan ? fullFindings.filter(finding => finding.includedInCsv !== false) : actualCsv.rows;
if (scan) {
  const visibleKey = (decodeTitles = false) => row => JSON.stringify(actualCsv.headers.map(header => {
    if (header === 'Code Location') return normalizeLocation(row[header], projectRoot);
    if (header === 'Changed in SDK') return normalizeVersion(row[header] ?? '');
    if (decodeTitles && scan.mode === 'deprecated' && header === 'Title') return titleText(row[header]);
    return String(row[header] ?? '');
  }));
  const csvRows = multiset(actualCsv.rows, projectRoot, visibleKey(true));
  const reportedRows = multiset(allActual, projectRoot, visibleKey(true));
  // Historical formulas must still match their source URL; only plain labels omit it.
  const linkedRows = actualCsv.rows.filter(row => titleText(row.Title) !== row.Title);
  const linkedMismatch = scan.mode === 'deprecated' && difference(multiset(linkedRows, projectRoot, visibleKey()),
    multiset(allActual, projectRoot, visibleKey())).length;
  if (difference(csvRows, reportedRows).length || difference(reportedRows, csvRows).length || linkedMismatch)
    throw new Error('Actual CSV does not match reported scan JSON rows: visible fields or multiplicity differ');
}
const actual = allActual.filter(isDevEcoRule);
const fullActual = fullFindings.filter(isDevEcoRule);
const deprecated = allActual.filter((row) => row['Change Operation'] === 'API_DEPRECATED' || row['Change Type'] === 'Deprecated API');
const goldenSet = multiset(golden, projectRoot);
const actualSet = multiset(actual, projectRoot);
const fullActualSet = multiset(fullActual, projectRoot);
const missing = difference(goldenSet, fullActualSet);
const notReported = difference(goldenSet, actualSet);
const extra = difference(actualSet, goldenSet);
const matched = golden.length - missing.length;
const report = {
  schemaVersion: scanJsonPath ? 2 : 1,
  goldenPath,
  actualPath,
  scanJsonPath,
  projectRoot,
  goldenRows: golden.length,
  actualDevEcoRows: fullActual.length,
  reportedDevEcoRows: actual.length,
  filteredGoldenRows: Math.max(0, notReported.length - missing.length),
  actualAdditionalDocumentRules: allActual.filter(isAdditionalDocumentRule).length,
  actualDeprecatedRows: deprecated.length,
  actualDistinctDeprecatedApis: new Set(deprecated.map((row) => row['API Symbol ID']
    || [row['Rule ID'] ?? '', row['Api Definition']].join('\u0000'))).size,
  matchedRows: matched,
  missingRows: missing.length,
  extraRows: extra.length,
  recall: golden.length === 0 ? 1 : matched / golden.length,
  precision: actual.length === 0 ? (golden.length === 0 ? 1 : 0) : (actual.length - extra.length) / actual.length,
  missingSample: missing.slice(0, 100),
  extraSample: extra.slice(0, 100),
};
if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readScanInput } from '../format/scan-input.mjs';
import { parseJson5 } from '../format/json5.mjs';
import { hyperlinkUrl, titleText } from '../format/csv.mjs';
import { projectModules, sourceLocation } from './source-scope.mjs';
import { normalizeComparablePath } from './paths.mjs';
import { requireScanMode } from './scan-mode.mjs';

export { titleText } from '../format/csv.mjs';

function evidenceRows(scan, mode, headers, rows) {
  if (!scan) return rows;
  if (scan.mode !== mode) throw new Error('扫描 JSON 模式与 --mode 不匹配');
  const projected = mode === 'deprecated' && Array.isArray(scan.actionGroups)
    ? scan.actionGroups.map(group => ({ ...group.occurrences?.[0], 'Action Type': group.actionType,
      'Policy ID': group.policyId, 'Occurrence Count': group.occurrenceCount, 'Trigger Evidence': group.triggerEvidence }))
    : scan.findings?.filter(row => row.includedInCsv !== false);
  if (!Array.isArray(projected) || projected.length !== rows.length) throw new Error('CSV 与扫描 JSON 导出行数不匹配');
  // Scanner preserves upgrade finding order and deprecated actionGroups order.
  for (let i = 0; i < rows.length; i++) if (headers.some(h => String(projected[i][h] ?? '') !== rows[i][h]
    && !(mode === 'deprecated' && h === 'Title' && titleText(projected[i][h]) === rows[i][h])))
    throw new Error(`CSV 与扫描 JSON 可见字段或重复行序不匹配: 逻辑行 ${i + 1}`);
  return projected;
}

export async function inspectScan(scanBytes, { mode, projectPath, scanJson = null, encoding = 'utf-8' }) {
  requireScanMode(mode);
  const input = readScanInput(scanBytes, { encoding });
  for (const header of ['Code Location', 'Title', 'Changed in SDK'])
    if (!input.headers.includes(header)) throw new Error(`原始扫描表缺少 ${header} 列`);
  const root = await realpath(path.resolve(projectPath));
  const profile = parseJson5(await readFile(path.join(root, 'build-profile.json5'), 'utf8'));
  const modules = await projectModules(root, profile);
  // RNOH business/JS-layer findings live in the sibling JS project recorded by the scanner.
  const rnohRoot = typeof scanJson?.rnoh?.jsRoot === 'string'
    ? await realpath(path.resolve(root, scanJson.rnoh.jsRoot)).catch(() => null) : null;
  const locationModules = rnohRoot ? [...modules, { name: '', root: rnohRoot, relativeRoot: scanJson.rnoh.jsRoot }] : modules;
  const evidence = evidenceRows(scanJson, mode, input.headers, input.rows);
  const groups = new Map(), physicalFiles = new Set(), workUnits = new Set();
  const locations = new Set();
  const rows = [];
  for (let i = 0; i < input.rows.length; i++) {
    const cells = input.rows[i], source = evidence[i], rowId = input.rowIds[i];
    const ruleId = source['Rule ID'] || null, sourceReference = source['Source Reference'] || null;
    const version = cells['Changed in SDK'];
    const identity = (ruleId || sourceReference) && version ? JSON.stringify([ruleId || sourceReference, version]) : null;
    const item = { rowId, logicalRow: i + 1, cells, evidence: scanJson ? source : null, title: titleText(cells.Title),
      titleUrl: hyperlinkUrl(cells.Title) ?? hyperlinkUrl(source.Title),
      ruleId, sourceReference, version, identity, physicalFile: null, line: null, column: null, gaps: [] };
    if (!identity) item.gaps.push('缺少可验证的规则身份或精确版本');
    try {
      const loc = sourceLocation(root, locationModules, cells['Code Location']);
      item.line = loc.line; item.column = loc.column;
      item.physicalFile = await realpath(loc.absolutePath);
      if (!(await stat(item.physicalFile)).isFile()) throw new Error('代码位置不是文件');
      const key = normalizeComparablePath(item.physicalFile);
      physicalFiles.add(key);
      locations.add(JSON.stringify([key, item.line, item.column]));
      if (identity) workUnits.add(JSON.stringify([identity, key]));
    } catch (error) {
      item.physicalFile = null;
      item.gaps.push(`代码位置无法解析到物理文件: ${error.code ?? error.message}`);
      locations.add(cells['Code Location']);
    }
    const groupKey = identity ?? `unknown:${rowId}`;
    const group = groups.get(groupKey) ?? { identity, ruleId, sourceReference, version,
      titles: [], rowIds: [], rowCount: 0, files: new Map() };
    if (!group.titles.includes(item.title)) group.titles.push(item.title);
    group.rowIds.push(rowId); group.rowCount++;
    if (item.physicalFile) {
      const key = normalizeComparablePath(item.physicalFile);
      const file = group.files.get(key) ?? { path: item.physicalFile, rowIds: [], codeLocations: [] };
      file.rowIds.push(rowId);
      if (!file.codeLocations.includes(cells['Code Location'])) file.codeLocations.push(cells['Code Location']);
      group.files.set(key, file);
    }
    groups.set(groupKey, group); rows.push(item);
  }
  const fileGap = rows.some(row => !row.physicalFile), identityGap = rows.some(row => !row.identity);
  return { mode, sha256: input.sha256, encoding: input.encoding, bom: input.bom, headers: input.headers, rows,
    statistics: { rowCount: rows.length, codeLocationCount: locations.size,
      physicalFileCount: fileGap ? null : physicalFiles.size, ruleCount: identityGap ? null : groups.size,
      workUnitCount: fileGap || identityGap ? null : workUnits.size, unresolvedRowCount: rows.filter(r => r.gaps.length).length },
    groups: [...groups.values()].map(g => ({ ...g, files: [...g.files.values()] })) };
}

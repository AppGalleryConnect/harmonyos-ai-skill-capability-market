import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringifyCsv, parseCsv, UPGRADE_HEADERS, DEPRECATED_HEADERS, hyperlink, titleText } from '../format/csv.mjs';
import { sha256 } from '../io/fs-utils.mjs';
import { inspectScan } from '../platform/scan-inspection.mjs';
import { formatDeprecatedResults } from '../format/deprecated-results.mjs';
import { writeResults } from '../../csv/cli.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const row = { 'Api Definition': 'test("a,b")\n续行', Language: 'ArkTS', 'Changed in SDK': '26.0.0(26) Beta1',
  Title: hyperlink('https://example.test/doc', '标题,"引号"'), 'Code Location': 'registered/src/A.ets:12',
  Fixed: 'Unfixed', 'Change Type': 'API Behavior Change', 'Rule ID': 'CH1' };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "CSV 中文 ' & 路径-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'actual', 'src', 'main'), { recursive: true });
  await writeFile(path.join(dir, 'build-profile.json5'), JSON.stringify({ modules: [{ name: 'registered', srcPath: './actual' }] }));
  await writeFile(path.join(dir, 'actual', 'src', 'main', 'module.json5'), '{module:{type:"entry"}}');
  await writeFile(path.join(dir, 'actual', 'src', 'A.ets'), 'source');
  return dir;
}
const decision = (bytes, i, extra = {}) => ({ rowId: `${sha256(bytes)}:${i}`, 处理结论: 'NO_CHANGE',
  处理来源: 'MODEL_ASSESSED', 业务影响: '', 处理说明: '实际理由', 兼容性说明: '', 变更文件: '', 验证证据: '', 后续事项: '', ...extra });

test('inspect uses actual columns, module mapping, exact versions and physical files without merging duplicate rows', async t => {
  const dir = await fixture(t);
  const rows = [row, row, { ...row, 'Code Location': 'registered/src/A.ets:13:2' },
    { ...row, 'Changed in SDK': '26.0.0(26) Release' }];
  const bytes = Buffer.from(stringifyCsv(UPGRADE_HEADERS, rows));
  const inspected = await inspectScan(bytes, { mode: 'upgrade', projectPath: dir });
  assert.deepEqual(inspected.headers, UPGRADE_HEADERS);
  assert.deepEqual(inspected.statistics, { rowCount: 4, codeLocationCount: 2, physicalFileCount: 1, ruleCount: 2, workUnitCount: 2, unresolvedRowCount: 0 });
  assert.equal(inspected.rows[0].title, '标题,"引号"');
  assert.equal(inspected.rows[0].physicalFile, await realpath(path.join(dir, 'actual', 'src', 'A.ets')));
  assert.notEqual(inspected.rows[0].rowId, inspected.rows[1].rowId);
  assert.equal(inspected.groups[0].rowCount, 3);
  assert.equal(inspected.groups[0].files[0].rowIds.length, 3);
  assert.equal(inspected.rows[2].column, 2);
});

test('deprecated scan JSON follows the exported action projection, including duplicate multiplicity', async t => {
  const dir = await fixture(t), bytes = Buffer.from(stringifyCsv(DEPRECATED_HEADERS, [row, row]));
  const scanJson = { mode: 'deprecated', findings: [{ ...row, 'Rule ID': 'filtered', includedInCsv: false }],
    actionGroups: [{ occurrences: [row] }, { occurrences: [row] }] };
  const inspected = await inspectScan(bytes, { mode: 'deprecated', projectPath: dir, scanJson });
  assert.equal(inspected.statistics.ruleCount, 1);
  assert.equal(inspected.rows[1].ruleId, 'CH1');
  assert.equal(inspected.rows[1].evidence['Rule ID'], 'CH1');
  await assert.rejects(inspectScan(bytes, { mode: 'deprecated', projectPath: dir,
    scanJson: { ...scanJson, actionGroups: scanJson.actionGroups.slice(1) } }), /匹配|行数/);
  await assert.rejects(inspectScan(bytes, { mode: 'upgrade', projectPath: dir, scanJson }), /模式/);
  await assert.rejects(inspectScan(bytes, { mode: 'deprecated', projectPath: dir,
    scanJson: { ...scanJson, actionGroups: [{ occurrences: [{ ...row, Title: '其他批次' }] }, { occurrences: [row] }] } }), /匹配/);
  const unknown = await inspectScan(bytes, { mode: 'deprecated', projectPath: dir });
  assert.equal(unknown.statistics.ruleCount, null);
  assert.equal(unknown.rows[0].identity, null);
  assert.match(unknown.rows[0].gaps.join(' '), /身份/);
  const plainBytes = Buffer.from(stringifyCsv(DEPRECATED_HEADERS, [row, row].map(r => ({ ...r, Title: titleText(r.Title) }))));
  const plain = await inspectScan(plainBytes, { mode: 'deprecated', projectPath: dir, scanJson });
  assert.equal(plain.rows[0].title, '标题,"引号"');
  assert.equal(plain.rows[0].titleUrl, 'https://example.test/doc');
  assert.equal(plain.rows[1].rowId, `${sha256(plainBytes)}:2`);
  await assert.rejects(inspectScan(plainBytes, { mode: 'upgrade', projectPath: dir,
    scanJson: { mode: 'upgrade', findings: [row, row] } }), /匹配/);
});

test('inspect canonicalizes source aliases and retains zero-row headers', async t => {
  const dir = await fixture(t);
  await symlink(path.join(dir, 'actual'), path.join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const bytes = Buffer.from(stringifyCsv(UPGRADE_HEADERS, [row, { ...row, 'Code Location': 'alias/src/A.ets:12' }]));
  const inspected = await inspectScan(bytes, { mode: 'upgrade', projectPath: dir });
  assert.equal(inspected.statistics.physicalFileCount, 1);
  assert.equal(inspected.statistics.codeLocationCount, 1);
  assert.equal(inspected.statistics.workUnitCount, 1);
  const zero = await inspectScan(Buffer.from(stringifyCsv(UPGRADE_HEADERS, [])), { mode: 'upgrade', projectPath: dir });
  assert.deepEqual(zero.headers, UPGRADE_HEADERS);
  assert.equal(zero.statistics.rowCount, 0);
  assert.equal(zero.statistics.ruleCount, 0);
});

test('inspection reports missing files and rejects missing or duplicate required headers', async t => {
  const dir = await fixture(t);
  const bytes = Buffer.from(stringifyCsv(UPGRADE_HEADERS, [{ ...row, 'Code Location': 'registered/missing.ets:1' }]));
  const inspected = await inspectScan(bytes, { mode: 'upgrade', projectPath: dir });
  assert.equal(inspected.statistics.physicalFileCount, null);
  assert.equal(inspected.statistics.unresolvedRowCount, 1);
  await assert.rejects(inspectScan(Buffer.from('File Path,Title\na,b\n'), { mode: 'upgrade', projectPath: dir }), /Code Location/);
  await assert.rejects(inspectScan(Buffer.from('Title,Title,Code Location\na,b,c\n'), { mode: 'upgrade', projectPath: dir }), /重复表头/);
});

for (const bom of [false, true]) for (const newline of ['\n', '\r\n']) {
  test(`deprecated writer decodes only Title and preserves raw identities and six statuses (${bom}, ${JSON.stringify(newline)})`, () => {
    const states = ['PENDING', 'MODIFIED', 'NO_CHANGE', 'DECISION_REQUIRED', 'EVIDENCE_GAP', 'OUT_OF_SCOPE'];
    const bytes = Buffer.from(stringifyCsv(DEPRECATED_HEADERS, states.map(() => row), { bom, newline }));
    const output = formatDeprecatedResults(bytes, states.map((s, i) => decision(bytes, i + 1, { 处理结论: s })).reverse());
    const csv = parseCsv(output);
    assert.deepEqual(csv.rows.map(r => r['处理结论']), states);
    assert.deepEqual(csv.rows.map(r => Object.fromEntries(DEPRECATED_HEADERS.map(h => [h, r[h]]))),
      parseCsv(bytes.toString()).rows.map(r => ({ ...r, Title: titleText(r.Title) })));
    assert.equal(output.startsWith('\ufeff'), bom);
    assert.ok(output.endsWith(newline));
    assert.equal(csv.rows[1]['Row ID'], `${sha256(bytes)}:2`);
  });
}

test('deprecated titles retain plain text, escaped quotes, commas and cell newlines without touching other formulas', () => {
  const title = '中文,"引号"\n第二行\r\n末行';
  const rows = [title, hyperlink('https://example.test/doc?q="x"', title), hyperlink('https://example.test/doc', title)]
    .map(Title => ({ ...row, Title, 'Replacement API': hyperlink('https://example.test/api', '原值') }));
  const bytes = Buffer.from(stringifyCsv(DEPRECATED_HEADERS, rows));
  const csv = parseCsv(formatDeprecatedResults(bytes, rows.map((_, i) => decision(bytes, i + 1)).reverse()));
  assert.deepEqual(csv.rows.map(r => r.Title), [title, title, title]);
  assert.deepEqual(csv.rows.map(r => r['Row ID']), rows.map((_, i) => `${sha256(bytes)}:${i + 1}`));
  assert.ok(csv.rows.every(r => r['Replacement API'] === rows[0]['Replacement API']));
});

test('deprecated writer validates row identity, reason, source and historical column prefixes', () => {
  const bytes = Buffer.from(stringifyCsv(DEPRECATED_HEADERS, [row, row]));
  assert.throws(() => formatDeprecatedResults(bytes, [decision(bytes, 1)]), /缺少/);
  assert.throws(() => formatDeprecatedResults(bytes, [decision(bytes, 1), decision(bytes, 1)]), /重复/);
  assert.throws(() => formatDeprecatedResults(bytes, [decision(bytes, 1), decision(bytes, 3)]), /未知/);
  for (const invalid of [{ 处理结论: '已适配' }, { 处理说明: ' ' }, { 处理来源: 'AUTO' }])
    assert.throws(() => formatDeprecatedResults(bytes, [decision(bytes, 1, invalid), decision(bytes, 2)]));
  const legacy = Buffer.from(stringifyCsv([...DEPRECATED_HEADERS, '处理结论'], [{ ...row, 处理结论: '旧值' }]));
  assert.throws(() => formatDeprecatedResults(legacy, [decision(legacy, 1)]), /前缀/);
  const csv = parseCsv(formatDeprecatedResults(legacy, [decision(legacy, 1)], { columnPrefix: 'run1' }));
  assert.equal(csv.rows[0]['处理结论'], '旧值');
  assert.equal(csv.rows[0]['run1 处理结论'], 'NO_CHANGE');
  assert.equal(parseCsv(formatDeprecatedResults(Buffer.from(stringifyCsv(DEPRECATED_HEADERS, [])), [])).rows.length, 0);
});

test('fixed CLI writes both modes, rejects input aliases and preserves existing output on lock', async t => {
  const dir = await fixture(t), scan = path.join(dir, '原扫描.csv'), results = path.join(dir, '逐行.json'), output = path.join(dir, '结果.csv');
  for (const mode of ['upgrade', 'deprecated']) {
    const bytes = Buffer.from(stringifyCsv(mode === 'upgrade' ? UPGRADE_HEADERS : DEPRECATED_HEADERS, [row]));
    await writeFile(scan, bytes);
    await writeFile(results, '\ufeff' + JSON.stringify([decision(bytes, 1, { 处理结论: mode === 'upgrade' ? '无需适配' : 'NO_CHANGE' })]));
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'csv', 'cli.mjs'), 'write', '--mode', mode,
      '--scan', scan, '--results', results, '--output', output], { encoding: 'utf8', shell: false });
    assert.equal(run.status, 0, run.stderr);
    const original = await readFile(output);
    await assert.rejects(writeResults({ mode, scan, results, output: scan }), /覆盖/);
    await assert.rejects(writeResults({ mode, scan, results, output: results }), /覆盖/);
    const alias = path.join(dir, `${mode}-alias`);
    await symlink(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writeResults({ mode, scan, results, output: path.join(alias, path.basename(scan)) }), /覆盖/);
    await assert.rejects(writeResults({ mode, scan, results, output }, { atomicWrite: async () => {
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    } }), /关闭.*原路径重试/);
    assert.deepEqual(await readFile(output), original);
    assert.deepEqual(await readFile(scan), bytes);
  }
});

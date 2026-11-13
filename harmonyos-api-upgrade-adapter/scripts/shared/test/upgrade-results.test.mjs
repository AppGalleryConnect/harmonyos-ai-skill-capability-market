import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, stringifyCsv, UPGRADE_HEADERS } from '../format/csv.mjs';
import { formatUpgradeResults, matchesUpgradeResult } from '../format/upgrade-results.mjs';
import { sha256 } from '../io/fs-utils.mjs';

const addedHeaders = ['评估结论', '处理结论', '处理说明', '后续事项'];
const scanRow = {
  'Api Definition': 'run(value: "中文,参数"): void\n声明续行', Language: 'ArkTS',
  'Changed in SDK': '26.0.0(26) Beta1', 'Affected Versions': 'ALL',
  Title: '=HYPERLINK("https://example.test/a,b","标题""引号")',
  'Code Location': 'entry/中文 空格/A.ets:12',
  'Change Type': 'API Behavior Change', 'Rule ID': 'CH123',
};

function result(bytes, index, conclusion = '无需适配') {
  return { rowId: `${sha256(bytes)}:${index}`, '处理结论': conclusion,
    '处理说明': '具体理由,中文\n含"引号"及 C:\\工程 空格\\A.ets', '后续事项': '' };
}

for (const bom of [false, true]) for (const newline of ['\n', '\r\n']) {
  test(`upgrade results preserve cells and duplicate rows from bom=${bom}, newline=${JSON.stringify(newline)}`, () => {
    const input = Buffer.from(stringifyCsv(UPGRADE_HEADERS, [scanRow, scanRow, scanRow], { bom, newline }));
    const before = Buffer.from(input);
    const results = ['无需适配', '已适配', '待决策'].map((conclusion, i) => result(input, i + 1, conclusion));
    results[0]['评估结论'] = '可选适配';
    results[1]['评估结论'] = '必须适配';
    results[1]['处理说明'] = '已按批准修改 metadata，保留旧视觉';
    results[1]['后续事项'] = '需人工验证；设备验证未选择';
    results[2]['后续事项'] = '证据不足，补齐实际调用后再判断';
    const output = formatUpgradeResults(input, [...results].reverse());
    const parsed = parseCsv(output);
    assert.ok(output.startsWith('\ufeff'));
    assert.ok(output.endsWith('\r\n'));
    assert.deepEqual(parsed.headers, [...UPGRADE_HEADERS, ...addedHeaders]);
    assert.equal(parsed.headers.length, 12);
    assert.deepEqual(parsed.rows.map(row => Object.fromEntries(UPGRADE_HEADERS.map(header => [header, row[header]]))),
      [scanRow, scanRow, scanRow]);
    assert.deepEqual(parsed.rows.map(row => row['处理结论']), ['无需适配', '已适配', '待决策']);
    assert.deepEqual(parsed.rows.map(row => row['评估结论']), ['可选适配', '必须适配', '待分类']);
    assert.equal(parsed.rows[0]['处理说明'], '具体理由,中文 · 含"引号"及 C:\\工程 空格\\A.ets');
    assert.equal(parsed.rows[1]['后续事项'], results[1]['后续事项']);
    assert.deepEqual(input, before);
    assert.equal(results[0].rowId, `${sha256(input)}:1`);
  });
}

test('历史结果只接受原范围外标签及等价的单行处理说明', () => {
  const bytes = Buffer.from(stringifyCsv(UPGRADE_HEADERS, [scanRow]));
  const description = '确认原调用\r\n\r\n处理决定：保留\r验证说明：PASS';
  const input = { ...result(bytes, 1), 评估结论: '范围外', 处理说明: description };
  const [output] = parseCsv(formatUpgradeResults(bytes, [input], { screenshots: { [input.rowId]: '截图.png' } })).rows;
  assert.equal(output['评估结论'], '无需适配');
  assert.equal(output['处理说明'], '确认原调用 · 处理决定：保留 · 验证说明：PASS');
  assert.equal(output['测试截图'], '截图.png');
  assert.equal(input['评估结论'], '范围外');
  assert.equal(input['处理说明'], description);
  assert.ok(matchesUpgradeResult('评估结论', '范围外', '范围外'));
  assert.ok(!matchesUpgradeResult('评估结论', '范围外', '无需适配'));
  assert.ok(matchesUpgradeResult('处理说明', output['处理说明'], description));
  assert.ok(!matchesUpgradeResult('处理说明', '确认原调用 · 处理决定：保留', description));
});

test('zero-row scans keep the original headers and all four result headers', () => {
  const bytes = Buffer.from(stringifyCsv(UPGRADE_HEADERS, []));
  assert.deepEqual(parseCsv(formatUpgradeResults(bytes, [])), { headers: [...UPGRADE_HEADERS, ...addedHeaders], rows: [] });
});

test('historical scan bytes retain their row IDs while the result omits Fixed', () => {
  const headers = [...UPGRADE_HEADERS, 'Fixed', 'Source Reference'];
  const row = { ...scanRow, Fixed: 'Unfixed', 'Source Reference': '26.0.0/source.md:3', 'Code Location': 'C:\\工程 空格\\A.ets:12' };
  const bytes = Buffer.from(stringifyCsv(headers, [row]));
  const output = parseCsv(formatUpgradeResults(bytes, [{ ...result(bytes, 1), '处理来源': 'MODEL_ASSESSED', evidence: '日志' }]));
  assert.deepEqual(output.headers, [...UPGRADE_HEADERS, 'Source Reference', ...addedHeaders]);
  assert.equal(parseCsv(bytes.toString('utf8')).rows[0].Fixed, 'Unfixed');
  assert.equal(output.rows[0]['Source Reference'], row['Source Reference']);
  assert.equal(output.rows[0]['Code Location'], row['Code Location']);
  assert.ok(!output.headers.includes('rowId'));
  assert.ok(!output.headers.includes('处理来源'));
});

test('missing, duplicate and foreign row identities fail instead of merging equal scan rows', () => {
  const bytes = Buffer.from(stringifyCsv(UPGRADE_HEADERS, [scanRow, scanRow]));
  assert.throws(() => formatUpgradeResults(bytes, [result(bytes, 1)]), /缺少.*rowId/);
  assert.throws(() => formatUpgradeResults(bytes, [result(bytes, 1), result(bytes, 1)]), /重复.*rowId/);
  assert.throws(() => formatUpgradeResults(bytes, [result(bytes, 1), result(bytes, 3)]), /未知.*rowId/);
  const other = Buffer.from(stringifyCsv(UPGRADE_HEADERS, [scanRow, scanRow], { bom: false }));
  assert.throws(() => formatUpgradeResults(bytes, [result(other, 1), result(other, 2)]), /未知.*rowId/);
});

test('invalid results and malformed scan input fail before producing a CSV', () => {
  const bytes = Buffer.from(stringifyCsv(UPGRADE_HEADERS, [scanRow]));
  for (const conclusion of ['NO_CHANGE', 'MODIFIED', 'DECISION_REQUIRED', 'EVIDENCE_GAP', 'PENDING', 'OUT_OF_SCOPE', '', undefined])
    assert.throws(() => formatUpgradeResults(bytes, [{ ...result(bytes, 1), '处理结论': conclusion }]), /处理结论/);
  assert.throws(() => formatUpgradeResults(bytes, [{ ...result(bytes, 1), 评估结论: '已适配' }]), /评估结论/);
  for (const explanation of ['', ' \r\n ', null])
    assert.throws(() => formatUpgradeResults(bytes, [{ ...result(bytes, 1), '处理说明': explanation }]), /处理说明/);
  assert.throws(() => formatUpgradeResults(bytes, [{ ...result(bytes, 1), '后续事项': null }]), /后续事项/);
  assert.throws(() => formatUpgradeResults(bytes, [null]), /rowId/);
  assert.throws(() => formatUpgradeResults(bytes, null), /数组/);
  assert.throws(() => formatUpgradeResults(bytes.toString(), []), /Buffer/);
  assert.throws(() => formatUpgradeResults(Buffer.alloc(0), []), /表头/);
  assert.throws(() => formatUpgradeResults(Buffer.from([0xff]), []), /UTF-8/);
  assert.throws(() => formatUpgradeResults(Buffer.from('a,b\r\n1\r\n'), []), /Malformed CSV/);
  assert.throws(() => formatUpgradeResults(Buffer.from('a\r\n"unterminated'), []), /Malformed CSV/);
});

test('duplicate headers and result column collisions require the original scan table', () => {
  assert.throws(() => formatUpgradeResults(Buffer.from('Title,Title\r\na,b\r\n'), []), /重复表头/);
  for (const header of addedHeaders) {
    const bytes = Buffer.from(stringifyCsv([...UPGRADE_HEADERS, header], [{ ...scanRow, [header]: '旧结果' }]));
    assert.throws(() => formatUpgradeResults(bytes, []), /原始扫描表/);
  }
});

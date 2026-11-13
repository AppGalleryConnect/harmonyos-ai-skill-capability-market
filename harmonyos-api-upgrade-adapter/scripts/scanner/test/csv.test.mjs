import test from 'node:test';
import assert from 'node:assert/strict';
import { DEPRECATED_HEADERS, parseCsv, SCANNER_HEADERS, stringifyCsv, UPGRADE_HEADERS } from '../../shared/format/csv.mjs';

test('mode-specific CSV projections preserve duplicate rows, escaping and hyperlinks', () => {
  assert.deepEqual(UPGRADE_HEADERS, ['Api Definition', 'Language', 'Changed in SDK', 'Affected Versions',
    'Title', 'Code Location', 'Change Type', 'Rule ID']);
  assert.deepEqual(DEPRECATED_HEADERS, ['Api Definition', 'Language', 'Changed in SDK',
    'Title', 'Code Location', 'Fixed', 'Change Type', 'Replacement API']);
  for (const headers of [UPGRADE_HEADERS, DEPRECATED_HEADERS]) {
    const row = Object.fromEntries(headers.map(header => [header, '']));
    row['Api Definition'] = 'run("a,b"): void\nnext';
    row.Title = '=HYPERLINK("https://example.test/a","标题,一")';
    const text = stringifyCsv(headers, [{ ...row, Column: 1 }, { ...row, Column: 8 }]);
    assert.ok(text.startsWith('\ufeff'));
    assert.ok(text.endsWith('\r\n'));
    assert.deepEqual(parseCsv(text), { headers, rows: [row, row] });
    assert.deepEqual(parseCsv(stringifyCsv(headers, [])), { headers, rows: [] });
  }
});

test('round trips BOM, CRLF, hyperlink formulas and scanner metadata', () => {
  const row = Object.fromEntries(SCANNER_HEADERS.map((header) => [header, '']));
  row['Api Definition'] = 'run(value: string, count: number): void';
  row.Language = 'ArkTS';
  row.Title = '=HYPERLINK("https://example.test/a","标题,一")';
  row['Code Location'] = 'entry/src/main/ets/A.ets:3';
  row.Fixed = 'Unfixed';
  row['Change Type'] = 'API Behavior Change';
  row['Rule ID'] = 'rule-1';
  const encoded = stringifyCsv(SCANNER_HEADERS, [row]);
  assert.ok(encoded.startsWith('\ufeff'));
  assert.ok(encoded.includes('\r\n'));
  assert.deepEqual(parseCsv(encoded), { headers: SCANNER_HEADERS, rows: [row] });
});

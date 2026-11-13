import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { runProcess } from '../../shared/platform/process.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPRECATED_HEADERS, stringifyCsv, UPGRADE_HEADERS, hyperlink, titleText } from '../../shared/format/csv.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function run(command, args) {
  const result = await runProcess(command, args, { timeoutMs: 30_000, detached: true });
  return { ...result, code: result.exitCode };
}

test('counts documented no-adaptation rows as covered through scan JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-golden-audit-'));
  const golden = path.join(root, 'golden.csv');
  const actual = path.join(root, 'actual.csv');
  const scanJson = path.join(root, 'apiChange.scan.json');
  const base = {
    'Api Definition': 'run(): void', Language: 'ArkTS', 'Changed in SDK': '6.0.0(20) Beta1',
    'Affected Versions': 'ALL', Fixed: 'Unfixed', 'Change Type': 'API Behavior Change',
  };
  const reported = { ...base, Title: '需要适配', 'Code Location': 'entry/A.ets:1', 'Rule ID': 'r1', 'Change Operation': 'API_BEHAVIOR', 'Source Reference': 'behavior.md:1' };
  const filtered = { ...base, Title: '无需适配', 'Code Location': 'entry/A.ets:2', 'Rule ID': 'r2', 'Change Operation': 'API_BEHAVIOR', 'Source Reference': 'behavior.md:2', includedInCsv: false, disposition: 'FILTERED_COMPATIBLE', filterReason: 'DOCUMENTED_NO_ADAPTATION' };
  const headers = ['Api Definition', 'Language', 'Changed in SDK', 'Affected Versions', 'Title', 'Code Location', 'Fixed', 'Change Type'];
  await writeFile(golden, stringifyCsv(headers, [reported, filtered]));
  await writeFile(actual, stringifyCsv(UPGRADE_HEADERS, [reported]));
  await writeFile(scanJson, `${JSON.stringify({ findings: [{ ...reported, includedInCsv: true }, filtered] })}\n`);

  const result = await run(process.execPath, [
    path.join(packageRoot, 'regression', 'compare-golden.mjs'),
    '--golden', golden,
    '--actual', actual,
    '--scan-json', scanJson,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.matchedRows, 2);
  assert.equal(report.missingRows, 0);
  assert.equal(report.filteredGoldenRows, 1);
  assert.equal(report.reportedDevEcoRows, 1);
  assert.equal(report.recall, 1);
});

for (const mode of ['upgrade', 'deprecated']) {
  test(`${mode} golden comparison checks reduced CSV multiplicity and uses complete JSON identities`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reduced-golden-中文 '));
    t.after(() => rm(root, { recursive: true, force: true }));
    const golden = path.join(root, 'golden.csv'), actual = path.join(root, 'actual.csv'), scanJson = path.join(root, 'scan.json');
    const headers = mode === 'upgrade' ? UPGRADE_HEADERS : DEPRECATED_HEADERS;
    const findings = [1, 8].map(Column => ({
      'Api Definition': 'old(): void', Language: 'ArkTS', 'Changed in SDK': '6.0.0(20) Beta1',
      'Affected Versions': 'ALL', Title: hyperlink('https://example.test/change', '变更,"中文"\n第二行'), 'Code Location': 'entry/A.ets:1', Fixed: 'Unfixed',
      'Change Type': mode === 'upgrade' ? 'API Behavior Change' : 'Deprecated API',
      'Rule ID': 'same-rule', 'Source Reference': 'behavior.md:1', 'Replacement API': 'new()',
      'API Symbol ID': `symbol-${Column}`, 'Detection Source': mode === 'upgrade' ? 'DEVECO' : 'SDK_STATE',
      Column, includedInCsv: true,
    }));
    const rows = [...findings].reverse();
    const scan = { mode, findings, ...(mode === 'deprecated' ? { actionGroups: rows.map(row => ({ occurrences: [row] })) } : {}) };
    await writeFile(golden, stringifyCsv(headers, mode === 'upgrade' ? findings : []));
    await writeFile(actual, stringifyCsv(headers, rows));
    await writeFile(scanJson, JSON.stringify(scan));
    const compare = () => run(process.execPath, [path.join(packageRoot, 'regression', 'compare-golden.mjs'),
      '--golden', golden, '--actual', actual, '--scan-json', scanJson]);
    const result = await compare();
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.reportedDevEcoRows, mode === 'upgrade' ? 2 : 0);
    assert.equal(report.actualDeprecatedRows, mode === 'deprecated' ? 2 : 0);
    assert.equal(report.actualDistinctDeprecatedApis, mode === 'deprecated' ? 2 : 0);
    assert.equal(report.actualAdditionalDocumentRules, 0);
    assert.equal(report.missingRows, 0);
    if (mode === 'deprecated') {
      await writeFile(actual, stringifyCsv(headers, rows.map(r => ({ ...r, Title: titleText(r.Title) }))));
      const plainResult = await compare();
      assert.equal(plainResult.code, 0, plainResult.stderr);
      assert.equal(JSON.parse(plainResult.stdout).actualDistinctDeprecatedApis, 2);
      const missingJson = await run(process.execPath, [path.join(packageRoot, 'regression', 'compare-golden.mjs'),
        '--golden', golden, '--actual', actual]);
      assert.equal(missingJson.code, 1);
      assert.match(missingJson.stderr, /requires --scan-json/);
    }
    for (const invalid of [[rows[0]], [...rows, rows[0]], [{ ...rows[0], Title: '错误标题' }, rows[1]],
      [{ ...rows[0], Title: hyperlink('https://example.test/wrong', titleText(rows[0].Title)) }, rows[1]]]) {
      await writeFile(actual, stringifyCsv(headers, invalid));
      const mismatch = await compare();
      assert.equal(mismatch.code, 1);
      assert.match(mismatch.stderr, /CSV does not match reported scan JSON/);
    }
  });
}

test('golden comparison strips a native absolute project root and preserves line and column',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'golden spaces 中文-'));
  const golden=path.join(root,'golden.csv'),actual=path.join(root,'actual.csv');
  const row={'Api Definition':'api(): void',Language:'ArkTS','Changed in SDK':'26',Title:'变更','Code Location':'entry/A.ets:12:4','Change Type':'API Behavior Change'};
  const absolute=path.join(root,'entry/A.ets')+':12:4';
  await writeFile(golden,stringifyCsv(Object.keys(row),[{...row,'Code Location':process.platform==='win32'?absolute.toUpperCase():absolute}]));
  await writeFile(actual,stringifyCsv(Object.keys(row),[row]));
  const result=await run(process.execPath,[path.join(packageRoot,'regression/compare-golden.mjs'),'--golden',golden,'--actual',actual,'--project',root]);
  assert.equal(result.code,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.missingRows,0);assert.equal(report.extraRows,0);
});

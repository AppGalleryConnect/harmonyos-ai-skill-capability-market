// Corpus and documentation contracts only; these do not certify model reading or business applicability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../shared/format/csv.mjs';
import { loadQueryCatalog } from '../../shared/platform/changelog-catalog.mjs';
import { canonicalHarmonyVersion, compareHarmonyVersions } from '../../shared/platform/version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const references = path.join(root, 'references');
const changelogs = path.join(references, 'changelogs');
const expected = [
  ['CH2026010615012', 966],
  ['CH2026031846233', 36],
  ['CH2026032761266', 146],
  ['CH2026032801249', 87],
];

test('four-change fixture resolves current local headings and exact versions', async () => {
  const { rows } = parseCsv(await readFile(new URL('./fixtures/behavior/local-sources.csv', import.meta.url), 'utf8'));
  const { entries } = await loadQueryCatalog(changelogs);
  assert.deepEqual(rows.map(row => row['Rule ID']), expected.map(([id]) => id));
  assert.equal(new Set(rows.map(row => row['Source Reference'])).size, 4);
  for (const [i, row] of rows.entries()) {
    const [id, line] = expected[i];
    const source = row['Source Reference'];
    const relative = source.replace(/:\d+$/, '');
    assert.ok(source.endsWith(`:${line}`));
    const matches = entries.filter(entry => entry.document === relative && entry.startLine === line
      && entry.title === row.Title && compareHarmonyVersions(entry.version, row['Changed in SDK']) === 0);
    assert.equal(matches.length, 1, `${id}: exact official identity`);
    assert.equal(new URL(matches[0].officialEntryUrl).hash, `#${id.toLowerCase()}`);
    assert.equal(compareHarmonyVersions(matches[0].version, '26.0.0(26) Beta2'), -1);
    assert.equal(compareHarmonyVersions(matches[0].version, '26.0.0(26) Release'), -1);
    assert.equal(canonicalHarmonyVersion(row['Changed in SDK']), '26.0.0(26) Beta1');
  }
});

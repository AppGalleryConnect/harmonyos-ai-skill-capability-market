import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDeprecatedFindings } from '../deprecated/result-groups.mjs';

test('deprecated occurrences retain separate columns, original annotations and stable grouping', () => {
  const findings = [1, 8].map(Column => ({
    'Change Type': 'Deprecated API', 'Rule ID': 'sdk-old', 'Code Location': 'entry/A.ets:1',
    occurrenceId: 'old-' + Column, Column, includedInCsv: true,
  }));
  const result = classifyDeprecatedFindings(findings);
  assert.equal(result.actionGroups.length, 2);
  assert.deepEqual(result.actionGroups.flatMap(group => group.occurrences.map(item => item.Column)).sort((a,b)=>a-b), [1,8]);
  assert.ok(result.actionRows.every(row => row['Occurrence Count'] === 1 && row['Action Type'] === 'CODE_REVIEW_REQUIRED'));
  assert.deepEqual(result.validationGroups, []); assert.deepEqual(result.validationRows, []);
  assert.deepEqual(result.findings.map(item => item.occurrenceId), ['old-1','old-8']);
});

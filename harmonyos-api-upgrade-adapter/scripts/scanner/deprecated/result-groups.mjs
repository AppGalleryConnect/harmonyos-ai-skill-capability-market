import { sha256 } from '../../shared/io/fs-utils.mjs';

export const VALIDATION_HEADERS = [
  'Policy ID', 'Changed in SDK', 'Title', 'Change Type', 'Validation Type',
  'Activation Condition', 'Occurrence Count', 'Affected Files', 'Sample Locations',
  'Validation Guidance', 'Source Reference',
];

function sourceFile(location) {
  return String(location ?? '').replace(/:\d+(?::\d+)?$/, '');
}

function groupActions(findings) {
  const groups = new Map();
  for (const finding of findings.filter(item => item.includedInCsv)) {
    const key = ['OCCURRENCE', finding.occurrenceId ?? finding.findingId ?? sha256(JSON.stringify(finding))].join('\0');
    const group = groups.get(key) ?? {
      actionGroupId: `action-${sha256(key).slice(0, 20)}`,
      actionType: finding.actionType ?? 'CODE_REVIEW_REQUIRED',
      policyId: finding.policyId ?? '',
      ruleId: finding['Rule ID'],
      sourceFile: sourceFile(finding['Code Location']),
      triggerEvidence: finding.triggerEvidence ?? '',
      occurrences: [],
    };
    group.occurrences.push(finding);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    occurrenceCount: group.occurrences.length,
  })).sort((left, right) => left.actionGroupId.localeCompare(right.actionGroupId));
}

function actionRows(groups) {
  return groups.map(group => ({
    ...group.occurrences[0],
    'Action Type': group.actionType,
    'Policy ID': group.policyId,
    'Occurrence Count': group.occurrenceCount,
    'Trigger Evidence': group.triggerEvidence,
    actionGroupId: group.actionGroupId,
  }));
}

export function classifyDeprecatedFindings(findings) {
  const annotated = findings.map(finding => ({
    ...finding,
    actionType: finding.actionType ?? 'CODE_REVIEW_REQUIRED',
    policyId: finding.policyId ?? '',
    triggerEvidence: finding.triggerEvidence ?? '',
  }));
  const actionGroups = groupActions(annotated);
  return { findings: annotated, actionGroups, actionRows: actionRows(actionGroups), validationGroups: [], validationRows: [] };
}

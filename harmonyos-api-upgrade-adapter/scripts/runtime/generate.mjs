import { identifier } from './contracts.mjs';

export function generateCaseTemplate(testCase) {
  identifier(testCase.id);
  return JSON.stringify({
    schemaVersion: 1,
    verify_preconditions: [],
    navigate: [],
    verify_target: [],
    scenarios: [],
  }, null, 2) + '\n';
}

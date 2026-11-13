import { createSource } from '../../../../runtime/contracts.mjs';
import { stringifyCsv } from '../../../format/csv.mjs';
export const bytes = Buffer.from(stringifyCsv(['Code Location', 'Rule ID'], [
  { 'Code Location': 'entry/中文 页面.ets:12', 'Rule ID': 'CH1' },
  { 'Code Location': 'entry/中文 页面.ets:12', 'Rule ID': 'CH1' },
]));
export const caseSnapshot = JSON.stringify({
  schemaVersion: 1,
  verify_preconditions: [{ op: 'data_ready', args: [{}] }],
  navigate: [],
  verify_target: [{ op: 'require_visible', args: [{ text: '1234' }], save: 'target' }],
  scenarios: [{ op: 'check', args: ['A1', { $ref: ['target', 'attributes', 'text'] }] }],
});
export function fixture() {
  const source = createSource(bytes, 'app', 'all');
  const refs = source.rows.map(r => ({ sourceId: source.sourceId, rowId: r.rowId }));
  return { schemaVersion: 1, sources: [source],
    routeMap: { schemaVersion: 1, routes: [{ id: 'home', rowRefs: refs,
      sourceEvidence: [{ path: 'entry/中文 页面.ets', startLine: 10, endLine: 14, text: 'Button().onClick(confirm)' }],
      steps: [{ action: 'launch', target: 'EntryAbility' }] }] },
    spec: { schemaVersion: 1, points: [{ id: 'confirm', rowRefs: refs, routeId: 'home',
      trigger: '点击确定', observable: '密码结果', expectationSource: '已批准spec：结果显示输入密码' }], gaps: [] },
    cases: { schemaVersion: 1, cases: [{ id: 'C1', routeId: 'home',
      preconditions: { startAnchor: { text: '确定', type: 'Button' }, state: {}, data: '输入1234', reset: '重新启动后输入相同数据' },
      steps: ['输入1234', '点击确定'], assertions: [{ id: 'A1', pointId: 'confirm', rowRefs: refs,
        kind: 'functional', beforeExpected: '1234', afterExpected: '1234' }], capturePoints: [] }] } };
}

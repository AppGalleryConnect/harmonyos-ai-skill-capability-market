import { readScanInput } from './scan-input.mjs';
import { stringifyCsv, titleText } from './csv.mjs';

const fields = ['Row ID', '处理结论', '处理来源', '业务影响', '处理说明', '兼容性说明', '变更文件', '验证证据', '后续事项'];
const states = new Set(['PENDING', 'MODIFIED', 'NO_CHANGE', 'DECISION_REQUIRED', 'EVIDENCE_GAP', 'OUT_OF_SCOPE']);

export function formatDeprecatedResults(scanBytes, results, { columnPrefix = '', sourceEncoding = 'utf-8' } = {}) {
  const { headers, rows, rowIds, encoding, bom, newline } = readScanInput(scanBytes, { encoding: sourceEncoding });
  if (!Array.isArray(results)) throw new TypeError('results 必须为逐行结果数组');
  const collision = fields.some(h => headers.includes(h));
  if (typeof columnPrefix !== 'string' || (collision && !columnPrefix.trim()))
    throw new Error('原表已有处理列，需要提供本轮列前缀 --column-prefix');
  const added = fields.map(h => columnPrefix ? `${columnPrefix} ${h}` : h);
  if (added.some(h => headers.includes(h))) throw new Error('本轮前缀仍与原表列名冲突');
  const expected = new Set(rowIds), byId = new Map();
  for (const result of results) {
    if (!result || !expected.has(result.rowId)) throw new Error(`未知结果 rowId: ${result?.rowId}`);
    if (byId.has(result.rowId)) throw new Error(`重复结果 rowId: ${result.rowId}`);
    if (!states.has(result['处理结论'])) throw new Error(`非法废弃处理结论: ${result.rowId}`);
    if (result['处理来源'] !== 'MODEL_ASSESSED') throw new Error(`处理来源必须为 MODEL_ASSESSED: ${result.rowId}`);
    for (const field of fields.slice(3)) if (typeof result[field] !== 'string') throw new Error(`${field}必须为字符串: ${result.rowId}`);
    if (!result['处理说明'].trim()) throw new Error(`处理说明必须包含具体理由: ${result.rowId}`);
    byId.set(result.rowId, result);
  }
  if (byId.size !== rows.length) throw new Error('缺少扫描行对应的结果 rowId');
  return stringifyCsv([...headers, ...added], rows.map((row, i) => {
    const result = byId.get(rowIds[i]);
    return { ...row, Title: titleText(row.Title),
      ...Object.fromEntries(fields.map((h, j) => [added[j], h === 'Row ID' ? rowIds[i] : result[h]])) };
  }), { bom: encoding === 'gb18030' || bom, newline: encoding === 'gb18030' ? '\r\n' : newline });
}

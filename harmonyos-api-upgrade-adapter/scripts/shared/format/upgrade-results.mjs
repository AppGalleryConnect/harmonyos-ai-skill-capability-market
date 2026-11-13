import { stringifyCsv } from './csv.mjs';
import { readScanInput } from './scan-input.mjs';
import { assessmentCategories } from '../platform/assessment-source.mjs';

const legacyResultHeaders = ['处理结论', '处理说明', '后续事项'];
const resultHeaders = ['评估结论', ...legacyResultHeaders];
const conclusions = new Set(['无需适配', '已适配', '待决策', '未实施']);
const upgradeSourceHeaders = headers => headers.filter(header => header !== 'Fixed');

export function displayUpgradeAssessment(category) {
  return category === '范围外' ? '无需适配' : category;
}

export function singleLineUpgradeDescription(description) {
  const breaks = /\r\n|[\r\n\u2028\u2029]/u;
  if (!breaks.test(description)) return description;
  return description.split(breaks).map(part => part.trim()).filter(Boolean).join(' · ');
}

export function matchesUpgradeResult(field, actual, expected) {
  if (actual === expected) return true;
  if (field === '评估结论') return actual === displayUpgradeAssessment(expected);
  if (field === '处理说明' && typeof expected === 'string') return actual === singleLineUpgradeDescription(expected);
  return false;
}

export function checkUpgradeResultColumns(raw, adapted) {
  const layouts = [
    { source: upgradeSourceHeaders(raw.headers), results: resultHeaders },
    { source: raw.headers, results: legacyResultHeaders },
  ];
  const screenshots = adapted.headers.at(-1) === '测试截图' ? ['测试截图'] : [];
  const layout = layouts.find(({ source, results }) => {
    const headers = [...source, ...results, ...screenshots];
    return headers.length === adapted.headers.length && headers.every((header, index) => header === adapted.headers[index]);
  });
  if (!layout) throw new Error('结果CSV表头与行为适配结果格式不一致');
  if (adapted.rows.length !== raw.rows.length
    || raw.rows.some((row, index) => layout.source.some(header => row[header] !== adapted.rows[index][header])))
    throw new Error('结果CSV原列、行序或重复记录与原表不一致');
  return layout.results;
}

/**
 * Format model-assessed results without changing source cells or deciding business outcomes.
 * @param {Buffer} scanBytes Original scan bytes, including any BOM.
 * @param {Array<{rowId: string, 评估结论?: string, 处理结论: string, 处理说明: string, 后续事项: string}>} results
 *   One result per SHA-256:logical-row identity; input order is immaterial.
 * @param {{screenshots?: Record<string,string>, sourceEncoding?: string}} options Audited screenshot projection and input encoding.
 * @returns {string} CSV with four result columns and an optional screenshot column, UTF-8 BOM and CRLF records.
 */
export function formatUpgradeResults(scanBytes, results, options = {}) {
  if (!Buffer.isBuffer(scanBytes)) throw new TypeError('scanBytes 必须是原始扫描字节 Buffer');
  if (!Array.isArray(results)) throw new TypeError('results 必须是逐行结果数组');
  const { headers, rows, rowIds } = readScanInput(scanBytes, { encoding: options.sourceEncoding });
  if ([...resultHeaders, '测试截图'].some(header => headers.includes(header)))
    throw new Error('输入已包含处理列，请使用原始扫描表，不要传入 adapted-results');

  const expected = new Set(rowIds);
  const withScreenshots = Object.hasOwn(options, 'screenshots');
  if (withScreenshots) {
    if (!options.screenshots || typeof options.screenshots !== 'object' || Array.isArray(options.screenshots)) throw new Error('截图索引必须为逐行对象');
    for (const [id, value] of Object.entries(options.screenshots)) {
      if (!expected.has(id)) throw new Error(`截图含未知行: ${id}`);
      if (typeof value !== 'string') throw new Error(`截图路径必须是字符串: ${id}`);
    }
  }
  const byId = new Map();
  for (const result of results) {
    if (!result || !expected.has(result.rowId)) throw new Error(`未知结果 rowId: ${result?.rowId}`);
    if (byId.has(result.rowId)) throw new Error(`重复结果 rowId: ${result.rowId}`);
    const category = result['评估结论'] === undefined ? '待分类' : result['评估结论'];
    if (!assessmentCategories.includes(category)) throw new Error(`非法评估结论: ${result.rowId}`);
    if (!conclusions.has(result['处理结论'])) throw new Error(`处理结论必须为无需适配、已适配、待决策或未实施: ${result.rowId}`);
    if (typeof result['处理说明'] !== 'string' || !result['处理说明'].trim())
      throw new Error(`处理说明必须包含具体理由: ${result.rowId}`);
    if (typeof result['后续事项'] !== 'string') throw new Error(`后续事项必须为字符串，无待办时留空: ${result.rowId}`);
    byId.set(result.rowId, { ...result, 评估结论: displayUpgradeAssessment(category),
      处理说明: singleLineUpgradeDescription(result['处理说明']) });
  }
  if (byId.size !== rows.length) throw new Error('缺少扫描行对应的结果 rowId');
  return stringifyCsv([...upgradeSourceHeaders(headers), ...resultHeaders, ...(withScreenshots ? ['测试截图'] : [])], rows.map((row, index) => {
    const result = byId.get(rowIds[index]);
    return { ...row, ...Object.fromEntries(resultHeaders.map(header => [header, result[header]])),
      ...(withScreenshots ? { '测试截图': options.screenshots[rowIds[index]] ?? '' } : {}) };
  }));
}

import { TextDecoder } from 'node:util';
import { parseCsv } from './csv.mjs';
import { sha256 } from '../io/fs-utils.mjs';

export function decodeCsvBuffer(bytes, encoding = 'utf-8') {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('scanBytes 必须是原始扫描字节 Buffer');
  if (!['utf-8', 'gb18030', 'auto'].includes(encoding)) throw new Error(`不支持的 CSV 编码：${encoding}`);
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) || bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))
    || bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) throw new Error('CSV 不支持 UTF-16/UTF-32 编码');
  if (bom && encoding === 'gb18030') throw new Error('CSV 的 UTF-8 BOM 与指定编码 gb18030 冲突');
  const candidates = bom ? ['utf-8'] : encoding === 'auto' ? ['utf-8', 'gb18030'] : [encoding];
  let cause;
  for (const candidate of candidates) {
    try {
      const text = new TextDecoder(candidate, { fatal: true }).decode(bytes);
      return { text, encoding: candidate, bom, newline: text.match(/\r\n|\r|\n/)?.[0] ?? '\r\n' };
    } catch (error) { cause = error; }
  }
  throw new Error(encoding === 'utf-8' ? '原始扫描表必须使用 UTF-8 编码'
    : `CSV 无法按 ${candidates.join('/')} 严格解码；请检查编码及 Node ICU 支持`, { cause });
}

export function readScanInput(bytes, { encoding = 'utf-8' } = {}) {
  const { text, ...decoded } = decodeCsvBuffer(bytes, encoding);
  const { headers, rows } = parseCsv(text);
  if (!headers.length || headers.some(h => !h.trim())) throw new Error('原始扫描表缺少有效表头');
  if (new Set(headers).size !== headers.length) throw new Error('原始扫描表包含重复表头');
  const hash = sha256(bytes);
  return { headers, rows, sha256: hash, rowIds: rows.map((_, i) => `${hash}:${i + 1}`), ...decoded,
    interpretationSha256: sha256(JSON.stringify({ headers, rows })) };
}

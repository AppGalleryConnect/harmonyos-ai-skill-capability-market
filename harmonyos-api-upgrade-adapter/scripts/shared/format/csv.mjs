export const BASE_HEADERS = [
  'Api Definition', 'Language', 'Changed in SDK', 'Affected Versions',
  'Title', 'Code Location', 'Fixed', 'Change Type',
];

// Full internal identity fields; independent of the exported CSV projection.
export const SCANNER_HEADERS = [
  ...BASE_HEADERS, 'Rule ID', 'Change Operation', 'Source Reference',
  'Replacement API', 'Replacement Source',
  'API Symbol ID', 'Column', 'Deprecated Since', 'Detection Source', 'Source Scope',
];

export const UPGRADE_HEADERS = [...BASE_HEADERS.filter(header => header !== 'Fixed'), 'Rule ID'];
export const DEPRECATED_HEADERS = [
  ...BASE_HEADERS.filter(header => header !== 'Affected Versions'), 'Replacement API',
];

export function parseCsv(text) {
  const source = text.replace(/^\ufeff/, '');
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      record.push(field);
      if (record.some((value) => value !== '')) records.push(record);
      record = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('Malformed CSV: unterminated quoted field');
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0];
  const rows = records.slice(1).map((values, index) => {
    if (values.length !== headers.length) {
      throw new Error(`Malformed CSV row ${index + 2}: expected ${headers.length} fields, received ${values.length}`);
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
  return { headers, rows };
}

function encode(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function stringifyCsv(headers, rows, { bom = true, newline = '\r\n' } = {}) {
  const lines = [headers.map(encode).join(',')];
  for (const row of rows) lines.push(headers.map((header) => encode(row[header])).join(','));
  return `${bom ? '\ufeff' : ''}${lines.join(newline)}${newline}`;
}

export function hyperlink(url, title) {
  if (!url) return title;
  const escape = (value) => String(value).replaceAll('"', '""');
  return `=HYPERLINK("${escape(url)}","${escape(title)}")`;
}

export function titleText(value) {
  const text = String(value ?? '');
  const match = text.match(/^=HYPERLINK\("(?:[^"]|"")*","((?:[^"]|"")*)"\)$/i);
  return match ? match[1].replaceAll('""', '"') : text;
}

export function hyperlinkUrl(value) {
  const match = String(value ?? '').match(/^=HYPERLINK\("((?:[^"]|"")*)","(?:[^"]|"")*"\)$/i);
  if (!match) return null;
  try {
    const url = new URL(match[1].replaceAll('""', '"'));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$-]/;

export function parseJson5(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (/\s|\ufeff/.test(character)) {
      index += 1;
    } else if (character === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) throw new Error(`Unterminated JSON5 comment at offset ${index}`);
      index = end + 2;
    } else if (character === '"' || character === "'") {
      const quote = character;
      let value = '';
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\') {
          index += 1;
          const escaped = text[index];
          value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[escaped] ?? escaped;
        } else value += text[index];
        index += 1;
      }
      if (text[index] !== quote) throw new Error('Unterminated JSON5 string');
      tokens.push({ type: 'value', value });
      index += 1;
    } else if ('{}[]:,'.includes(character)) {
      tokens.push({ type: 'punctuation', value: character });
      index += 1;
    } else if (IDENTIFIER_START.test(character)) {
      const start = index++;
      while (index < text.length && IDENTIFIER_PART.test(text[index])) index += 1;
      tokens.push({ type: 'identifier', value: text.slice(start, index) });
    } else if (/[+\-.0-9]/.test(character)) {
      const start = index++;
      while (index < text.length && /[A-Fa-fxX0-9eE+\-.]/.test(text[index])) index += 1;
      tokens.push({ type: 'number', value: text.slice(start, index) });
    } else throw new Error(`Unexpected JSON5 character ${JSON.stringify(character)} at offset ${index}`);
  }
  let cursor = 0;
  const current = () => tokens[cursor];
  function consume(value) {
    const token = current();
    if (!token || (value !== undefined && token.value !== value)) throw new Error(`Expected ${value ?? 'token'} at token ${cursor}`);
    cursor += 1;
    return token;
  }
  function value() {
    const token = current();
    if (!token) throw new Error('Unexpected end of JSON5 input');
    if (token.value === '{') return object();
    if (token.value === '[') return array();
    cursor += 1;
    if (token.type === 'value') return token.value;
    if (token.type === 'number') return Number(token.value);
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    throw new Error(`Unexpected JSON5 value: ${token.value}`);
  }
  function object() {
    const result = {};
    consume('{');
    while (current()?.value !== '}') {
      const key = consume().value;
      consume(':');
      result[key] = value();
      if (current()?.value === ',') consume(',');
    }
    consume('}');
    return result;
  }
  function array() {
    const result = [];
    consume('[');
    while (current()?.value !== ']') {
      result.push(value());
      if (current()?.value === ',') consume(',');
    }
    consume(']');
    return result;
  }
  const result = value();
  if (cursor !== tokens.length) throw new Error(`Unexpected trailing JSON5 token ${cursor}`);
  return result;
}

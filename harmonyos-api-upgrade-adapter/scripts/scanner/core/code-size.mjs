import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { portableRelative, sha256 } from '../../shared/io/fs-utils.mjs';
import { errorWithCode } from '../../shared/platform/errors.mjs';
import { normalizeComparablePath } from '../../shared/platform/paths.mjs';
import { inside, SOURCE_EXCLUDED } from '../../shared/platform/source-scope.mjs';
import { isArkTsSource } from '../../shared/platform/source-types.mjs';

const excludedDirectories = new Set([...SOURCE_EXCLUDED, 'dist', 'coverage', 'tests', '__tests__', '__mocks__']
  .map(name => name.toLowerCase()));

function directoryExcluded(root, file) {
  return path.relative(root, path.dirname(file)).split(path.sep)
    .some(name => excludedDirectories.has(name.toLowerCase()));
}

function markScriptTokens(text, file, { ts, etsOptions }, mark) {
  const kind = { '.ets': ts.ScriptKind.ETS, '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX,
    '.js': ts.ScriptKind.JSX, '.jsx': ts.ScriptKind.JSX }[path.extname(file).toLowerCase()];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind,
    { etsAnnotationsEnable: true, ets: etsOptions });
  const pending = [source];
  while (pending.length) {
    const node = pending.pop();
    if (ts.isJSDoc(node) || node.kind === ts.SyntaxKind.EndOfFileToken
      || ts.isJsxExpression(node) && !node.expression) continue;
    const children = node.getChildren(source);
    if (children.length) {
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
      continue;
    }
    // JSX text can start with comment delimiters that are ordinary text.
    const start = node.kind === ts.SyntaxKind.JsxText ? node.getFullStart() : node.getStart(source);
    mark(start, node.getEnd());
  }
}

function markNativeTokens(text, mark) {
  const tokens = new RegExp([
    /\/\/(?:\\(?:\r\n?|\n)|[^\r\n])*/.source,
    /\/\*[\s\S]*?(?:\*\/|$)/.source,
    /\b(?:u8|[uUL])?R"([^\s()\\]{0,16})\(/.source,
    /"(?:\\(?:\r\n?|\n|[^\r\n])|[^"\\\r\n])*"?/.source,
    /'(?:\\(?:\r\n?|\n|[^\r\n])|[^'\\\r\n])*'?/.source,
    /\d(?:[eEpP][+-]|[\w.]|'[\w])*/.source,
    /\w+|\S/.source,
  ].join('|'), 'g');
  let token;
  while ((token = tokens.exec(text))) {
    if (token[0].startsWith('//') || token[0].startsWith('/*')) continue;
    if (token[1] !== undefined) {
      const delimiter = ')' + token[1] + '"';
      const end = text.indexOf(delimiter, tokens.lastIndex);
      tokens.lastIndex = end < 0 ? text.length : end + delimiter.length;
    }
    mark(token.index, tokens.lastIndex);
  }
}

export function countSourceLines(file, source, language, catalog) {
  const text = source.replace(/^\uFEFF/, '');
  const starts = text ? [0] : [];
  for (const newline of text.matchAll(/\r\n?|\n/g)) {
    const next = newline.index + newline[0].length;
    if (next < text.length) starts.push(next);
  }
  const code = new Uint8Array(starts.length);
  let line = 0;
  const mark = (start, end) => {
    if (start >= end) return;
    // Token spans arrive in source order. Multi-line tokens contribute once to each nonblank line.
    while (starts[line + 1] <= start) line++;
    for (let i = line; starts[i] < end; i++) {
      if (code[i]) continue;
      const segment = text.slice(Math.max(starts[i], start), Math.min(starts[i + 1] ?? text.length, end));
      if (/\S/.test(segment)) code[i] = 1;
    }
  };
  if (language === 'cpp') markNativeTokens(text, mark);
  else markScriptTokens(text, file, catalog, mark);
  return { physicalLines: starts.length, codeLines: code.reduce((sum, value) => sum + value, 0) };
}

const zero = () => ({ physicalLines: 0, codeLines: 0 });
function add(target, lines) {
  target.physicalLines += lines.physicalLines;
  target.codeLines += lines.codeLines;
}

export function createCodeSize(project, catalog) {
  const total = zero(), byLanguage = { arktsTs: zero(), cpp: zero() };
  const groups = new Map(), seen = new Set();
  const modules = [...project.modules].sort((a, b) => b.root.length - a.root.length || a.name.localeCompare(b.name));
  const record = (file, bytes, language, moduleName, root) => {
    const identity = normalizeComparablePath(file);
    if (seen.has(identity)) return;
    seen.add(identity);
    const sourceRoot = portableRelative(project.root, root) || '.';
    const key = JSON.stringify([sourceRoot, moduleName]);
    if (!groups.has(key)) groups.set(key, { moduleName, sourceRoot, total: zero(), byLanguage: {} });
    const group = groups.get(key);
    const lines = countSourceLines(file, bytes.toString('utf8'), language, catalog);
    add(group.byLanguage[language] ??= zero(), lines);
    add(group.total, lines);
    add(byLanguage[language], lines);
    add(total, lines);
  };
  return {
    // Discovery starts at physical project and module roots and only walks regular directory entries.
    addHarmony(file, bytes) {
      if (directoryExcluded(project.root, file)) return;
      const owner = modules.find(module => inside(module.root, file));
      record(file, bytes, isArkTsSource(file) ? 'arktsTs' : 'cpp', owner?.name ?? null, owner?.root ?? project.root);
    },
    async addRnoh(rnoh) {
      if (!rnoh?.businessSource) return;
      const { root, files } = rnoh.businessSource;
      byLanguage.rnohBusinessJs = zero();
      const hashes = new Map(rnoh.files.map(({ file, hash }) => [file, hash]));
      const explicit = project.sourceScope?.excludedDirectories ?? project.sourceScope?.excludeDirs ?? [];
      for (const file of files) {
        if (directoryExcluded(root, file) || explicit.some(directory => inside(directory, file))) continue;
        const physical = await realpath(file);
        if (!inside(root, physical) || normalizeComparablePath(file) !== normalizeComparablePath(physical)) {
          throw errorWithCode('RNOH 业务源码路径在扫描期间变化：' + file, 'SOURCE_CHANGED_DURING_SCAN');
        }
        if (seen.has(normalizeComparablePath(physical))) continue;
        const bytes = await readFile(physical);
        if (hashes.has(file) && sha256(bytes) !== hashes.get(file))
          throw errorWithCode('RNOH 检索输入在扫描期间变化：' + file, 'SOURCE_CHANGED_DURING_SCAN');
        record(physical, bytes, 'rnohBusinessJs', null, root);
      }
    },
    result() {
      return { total, byLanguage, byModule: [...groups.keys()].sort().map(key => groups.get(key)) };
    },
  };
}

import { compareConfigurationVersions } from '../../shared/platform/version.mjs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { exists, portableRelative, sha256, sha256File } from '../../shared/io/fs-utils.mjs';
import { compareHarmonyVersions as compareVersions, canonicalHarmonyVersion as canonicalVersion } from '../../shared/platform/version.mjs';
import { normalizeComparablePath } from '../../shared/platform/paths.mjs';

const require = createRequire(import.meta.url);

export function loadArkTsParser(toolchain) {
  const parserPath = toolchain.parserPath ?? path.join(toolchain.sdkRoot, 'default/openharmony/ets/build-tools/ets-loader/node_modules/typescript/lib/typescript.js');
  try {
    const ts = require(parserPath);
    if (ts.ScriptKind.ETS === undefined || typeof ts.isStructDeclaration !== 'function') throw new Error('Not an ArkTS parser');
    return ts;
  } catch (cause) {
    const error = new Error(`Target SDK ArkTS parser unavailable: ${parserPath}`, { cause });
    error.code = 'ARKTS_PARSER_UNAVAILABLE';
    throw error;
  }
}

export function normalizedSignature(text) {
  return String(text).replace(/\b(?:export|declare)\s+/g, '').replace(/\s+/g, ' ').replace(/\s*([():,;<>|?{}\[\]])\s*/g, '$1').replace(/;$/, '').trim();
}

export function sdkLocationKey(file, start, platform = process.platform) {
  return `${normalizeComparablePath(file, platform)}\0${start}`;
}

function commentText(comment) {
  return typeof comment === 'string' ? comment : comment?.map(part => part.text ?? part.getText?.() ?? '').join('') ?? '';
}

function nodeKind(ts, node) {
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isStructDeclaration(node)) return 'struct';
  if (ts.isAnnotationDeclaration?.(node)) return 'annotation';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isEnumDeclaration(node)) return 'enum_class';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isCallSignatureDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) return 'method';
  if (ts.isEnumMember(node)) return 'enum_instance';
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isAnnotationPropertyDeclaration?.(node) || ts.isVariableDeclaration(node) || ts.isTypeAliasDeclaration(node)) return 'field';
  return null;
}

const PUBLIC_API_REFERENCE_BASE = 'https://developer.huawei.com/consumer/cn/doc/harmonyos-references';

export function deprecatedDocUrl(entry) {
  if (!entry || entry.family !== 'openharmony') return '';
  const moduleName = String(entry.relativePath ?? '').replaceAll('\\', '/')
    .match(/^api\/@ohos\.([a-z0-9]+)\.d\.(?:ets|ts)$/i)?.[1];
  return moduleName ? `${PUBLIC_API_REFERENCE_BASE}/js-apis-${moduleName}` : '';
}

export function indexSdkFile(ts, sourceFile, family, relativePath) {
  const declarations = [];
  const errors = [];
  const fileHash = sha256(sourceFile.text);
  function visit(node, scope) {
    const kind = nodeKind(ts, node);
    const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(sourceFile).replace(/^['"]|['"]$/g, '') ?? (ts.isCallSignatureDeclaration(node) ? 'call' : null);
    if (kind && name && node.end > node.getStart(sourceFile)) {
      const tags = ts.getJSDocTags(node) ?? [];
      const deprecated = ts.getJSDocDeprecatedTag(node);
      const deprecatedText = deprecated ? commentText(deprecated.comment) : null;
      const match = deprecatedText?.match(/\bsince\s+(?:\d+\.\d+\.\d+\((\d+)\)|(\d+))/i);
      const since = match ? Number(match[1] ?? match[2]) : null;
      if (deprecated && since === null) errors.push({ file: sourceFile.fileName, name: [...scope, name].join('.'), reason: 'UNPARSEABLE_DEPRECATED_VERSION', text: deprecatedText });
      // Select the replacement from the same JSDoc block as @deprecated.
      const replacement = deprecated?.parent?.tags?.find(tag => tag?.tagName?.text === 'useinstead');
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const declarationText = ['class', 'interface', 'struct', 'annotation', 'namespace', 'enum_class'].includes(kind)
        ? `${kind} ${name}${node.heritageClauses?.map(clause => ` ${clause.getText(sourceFile)}`).join('') ?? ''}`
        : node.getText(sourceFile);
      const qualifiedName = [...scope, name].join('.');
      const signature = normalizedSignature(declarationText);
      const isStatic = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false;
      declarations.push({
        symbolId: `api-${sha256([family, relativePath, qualifiedName, kind, isStatic, signature].join('\0')).slice(0, 24)}`,
        family, relativePath, file: sourceFile.fileName, fileHash,
        name, owner: scope.join('.'), qualifiedName, kind, isStatic, signature,
        declaration: declarationText, line: position.line + 1, column: position.character + 1,
        parameters: (node.parameters ?? []).map(parameter => ({ name: parameter.name.getText(sourceFile),
          type: parameter.type?.getText(sourceFile) ?? null, optional: Boolean(parameter.questionToken),
          rest: Boolean(parameter.dotDotDotToken) })),
        returnType: node.type?.getText(sourceFile) ?? null,
        start: node.getStart(sourceFile), end: node.end, deprecatedSince: since,
        deprecatedText, replacementApi: replacement ? commentText(replacement.comment).trim() : null,
        throws: tags.filter(tag => tag?.tagName?.text === 'throws').map(tag => tag.getText(sourceFile)),
        heritage: node.heritageClauses?.flatMap(clause => clause.types.map(type => type.getText(sourceFile))) ?? [],
      });
    }
    const nested = kind && name && ['class', 'interface', 'struct', 'annotation', 'namespace', 'enum_class'].includes(kind) ? [...scope, name] : scope;
    ts.forEachChild(node, child => visit(child, nested));
  }
  visit(sourceFile, []);
  return { declarations, errors };
}

export function readSdkCompilerConfiguration(ts, configPath) {
  const sources = new Map(), diagnostics = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    readDirectory: () => [],
    readFile(file) {
      const text = ts.sys.readFile(file);
      if (text !== undefined) sources.set(file, { file, hash: sha256(text) });
      return text;
    },
    onUnRecoverableConfigFileDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  diagnostics.push(...(parsed?.errors ?? []));
  const options = Object.fromEntries(['lib', 'types', 'typeRoots', 'noLib']
    .filter(key => parsed?.options[key] !== undefined).map(key => [key, parsed.options[key]]));
  return { options, sources: [...sources.values()].sort((a, b) => a.file.localeCompare(b.file)),
    errors: diagnostics.filter(item => ![18002, 18003].includes(item.code))
      .map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), configPath };
}

export async function buildSdkCatalog(toolchain, targetVersion = toolchain.sdkVersion) {
  if (targetVersion && (!toolchain.sdkVersion || compareConfigurationVersions(toolchain.sdkVersion, targetVersion) < 0)) {
    const error = new Error('Compile SDK must be at least the requested target SDK');
    error.code = !toolchain.sdkVersion ? 'TARGET_SDK_UNRESOLVED' : 'SDK_TARGET_NOT_COVERED';
    throw error;
  }
  toolchain = { ...toolchain, sdkRoot: await realpath(toolchain.sdkRoot) };
  const ts = loadArkTsParser(toolchain);
  const parserPath = toolchain.parserPath ?? path.join(toolchain.sdkRoot, 'default/openharmony/ets/build-tools/ets-loader/node_modules/typescript/lib/typescript.js');
  const parserConfigPath = path.resolve(path.dirname(parserPath), '../../../tsconfig.json');
  const parserConfiguration = ts.readConfigFile(parserConfigPath, ts.sys.readFile);
  if (parserConfiguration.error) throw Object.assign(new Error(`SDK compiler configuration: ${parserConfigPath}: ${ts.flattenDiagnosticMessageText(parserConfiguration.error.messageText, '\n')}`), { code: 'SDK_COMPILER_OPTIONS_INVALID' });
  const parserConfig = parserConfiguration.config;
  const compilerConfiguration = readSdkCompilerConfiguration(ts, parserConfigPath);
  const etsOptions = { ...parserConfig.compilerOptions?.ets, libs: [] };
  const parserHash = await sha256File(parserPath);
  const sourceFiles = new Map();
  const declarations = [];
  const errors = [];
  for (const family of ['openharmony', 'hms']) {
    const etsRoot = toolchain.sdkFamilies?.[family]
      ?? path.join(toolchain.sdkRoot, 'default', family, 'ets');
    async function visit(directory) {
      if (!(await exists(directory))) return;
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && /\.d\.(?:ts|ets)$/.test(file)) {
          const text = await readFile(file, 'utf8');
          const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ets') ? ts.ScriptKind.ETS : ts.ScriptKind.TS, { etsAnnotationsEnable: true, ets: etsOptions });
          sourceFiles.set(file, sourceFile);
          if (sourceFile.parseDiagnostics.length) errors.push(...sourceFile.parseDiagnostics.map(d => ({ file, reason: 'SDK_PARSE_ERROR', start: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') })));
          const indexed = indexSdkFile(ts, sourceFile, family, portableRelative(etsRoot, file));
          declarations.push(...indexed.declarations);
          errors.push(...indexed.errors);
        }
      }
    }
    for (const directory of ['api', 'arkts', 'component', 'kits']) await visit(path.join(etsRoot, directory));
  }
  if (sourceFiles.size === 0) errors.push({ reason: 'SDK_DECLARATIONS_EMPTY' });
  const level = targetVersion?.apiLevel ?? Infinity;
  const deprecatedEntries = declarations.filter(entry => entry.deprecatedSince !== null && entry.deprecatedSince <= level);
  const byLocation = new Map(declarations.map(entry => [`${entry.file}\0${entry.start}`, entry]));
  const platform = process.platform;
  const byComparableLocation = new Map(declarations
    .map(entry => [sdkLocationKey(entry.file, entry.start, platform), entry]));
  const snapshot = sha256(parserHash + JSON.stringify(etsOptions) + JSON.stringify(compilerConfiguration) + '\n' + [...sourceFiles].map(([file, sf]) => `${portableRelative(toolchain.sdkRoot, file)}\0${sha256(sf.text)}`).sort().join('\n'));
  return { ts, etsOptions, toolchain, targetVersion, sourceFiles, declarations, deprecatedEntries,
    sdkCompilerOptions: compilerConfiguration.options, compilerConfiguration,
    byLocation, byComparableLocation, platform, snapshot, coverage: {
    status: errors.length ? 'INCOMPLETE' : 'COMPLETE', sdkSnapshot: snapshot,
    targetSdk: targetVersion ? canonicalVersion(targetVersion) : null,
    compileSdk: toolchain.sdkVersion ? canonicalVersion(toolchain.sdkVersion) : null, parserVersion: ts.version, parserHash,
    fileCount: sourceFiles.size, declarationCount: declarations.length, deprecatedDeclarationCount: deprecatedEntries.length, errors,
  } };
}

export function resolveRuleDeclarations(catalog, api) {
  let relative = api.completePath?.replace(/^\/interface\/sdk-js\//, '').replace(/^api\/@internal\/component\/ets\//, 'component/');
  if (!relative) return [];
  const owner = api.className === 'unnamed' || !api.className ? '' : api.className;
  const types = new Set(['class', 'interface', 'struct', 'namespace', 'enum_class']);
  return catalog.declarations.filter(entry => {
    if (entry.relativePath !== relative || entry.name !== api.interfaceName) return false;
    if (types.has(api.interfaceType)) return entry.kind === api.interfaceType && (!owner || entry.owner === owner || entry.qualifiedName === owner || entry.owner.endsWith(`.${owner}`));
    if (owner && entry.owner !== owner && !entry.owner.endsWith(`.${owner}`)) return false;
    return !api.methodDefinition || entry.signature === normalizedSignature(api.methodDefinition);
  });
}

export function catalogEntry(catalog, node) {
  if (!node) return null;
  const original = catalog.ts.getOriginalNode(node);
  const originalFile = original?.getSourceFile?.() ?? node.getSourceFile?.();
  if (!originalFile) return null;
  const file = originalFile.fileName;
  const entryAt = (targetFile, start) => catalog.byLocation.get(`${targetFile}\0${start}`)
    ?? catalog.byComparableLocation?.get(sdkLocationKey(targetFile, start, catalog.platform));
  const direct = entryAt(file, original.getStart(originalFile));
  if (direct) return direct;
  if (node.end > node.getStart(node.getSourceFile())) return null;
  // ArkTS creates zero-width constructor attributes for SDK structs. Resolve only
  // through the exact declaring SDK container, never through a global member name.
  let parent = node.parent;
  while (parent) {
    const owner = entryAt(file, parent.getStart(parent.getSourceFile()));
    if (owner && ['struct', 'class', 'interface'].includes(owner.kind)) {
      const name = node.name?.getText().replace(/^['"]|['"]$/g, '');
      const fileIdentity = normalizeComparablePath(file, catalog.platform);
      const matches = catalog.declarations.filter(entry => normalizeComparablePath(entry.file, catalog.platform) === fileIdentity
        && entry.owner === owner.qualifiedName && entry.name === name);
      return matches.length === 1 ? matches[0] : null;
    }
    parent = parent.parent;
  }
  return null;
}

export function declarationEvidence(entry, catalog) {
  return { ...entry, sdkSnapshot: catalog.snapshot, targetSdk: catalog.coverage.targetSdk, compileSdk: catalog.coverage.compileSdk };
}

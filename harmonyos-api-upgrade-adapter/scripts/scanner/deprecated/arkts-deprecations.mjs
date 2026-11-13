import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseJson5 } from '../../shared/format/json5.mjs';
import { sha256, portableRelative } from '../../shared/io/fs-utils.mjs';
import { catalogEntry, declarationEvidence, deprecatedDocUrl } from '../core/sdk-deprecations.mjs';
import { hyperlink } from '../../shared/format/csv.mjs';
import { canonicalHarmonyVersion as canonicalVersion } from '../../shared/platform/version.mjs';
import { normalizeComparablePath } from '../../shared/platform/paths.mjs';
import { isArkTsSource } from '../../shared/platform/source-types.mjs';

function realFile(file) {
  return existsSync(file) ? realpathSync.native(file) : file;
}

export function compilerPathIdentity(file, platform = process.platform) {
  return normalizeComparablePath(file, platform);
}

export function projectModuleForFile(project, file, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  return project.modules.find((module) => {
    const relation = api.relative(module.root, file);
    return relation !== '' && relation !== '..'
      && !relation.startsWith(`..${api.sep}`) && !api.isAbsolute(relation);
  });
}

export function createArkTsProgram(project, catalog, { overlays = new Map(), compilerOptions = {}, builder = false } = {}) {
  const { ts, toolchain } = catalog;
  const options = { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2021,
    ...catalog.sdkCompilerOptions,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, allowNonTsExtensions: true, etsAnnotationsEnable: true, ets: catalog.etsOptions, ...compilerOptions };
  if (options.noLib) delete options.lib;
  const configurationErrors = [...(catalog.compilerConfiguration?.errors ?? [])];
  if (!options.noLib && !Array.isArray(options.lib)) configurationErrors.push('SDK must explicitly specify lib or noLib:true');
  if (!options.noLib && Array.isArray(options.lib)) {
    const libraryRoot = path.dirname(ts.getDefaultLibFilePath(options));
    for (const lib of options.lib) {
      try { readFileSync(path.resolve(libraryRoot, lib)); }
      catch (error) { configurationErrors.push(`${lib}: ${error.message}`); }
    }
  }
  if (configurationErrors.length) throw Object.assign(new Error(`SDK compiler configuration ${catalog.compilerConfiguration?.configPath ?? '<catalog>'}: ${configurationErrors.join('; ')}`),
    { code: 'SDK_COMPILER_OPTIONS_INVALID' });
  const host = ts.createCompilerHost(options);
  host.getCanonicalFileName = file => compilerPathIdentity(file);
  const overlayFiles = new Map([...overlays].map(([file, text]) => [host.getCanonicalFileName(file), { file, text }]));
  const originalExists = host.fileExists.bind(host);
  host.fileExists = file => overlayFiles.has(host.getCanonicalFileName(file)) || originalExists(file);
  const canonicalFiles = new Map([...project.sourceFiles, ...catalog.sourceFiles.keys()]
    .map(file => [host.getCanonicalFileName(file), file]));
  const sdkSourceFiles = new Map([...catalog.sourceFiles]
    .map(([file, sourceFile]) => [host.getCanonicalFileName(file), sourceFile]));
  const packageCache = new Map();
  const manifestHashes = new Map();
  const unresolvedImports = [];
  function packageJson(directory) {
    if (!packageCache.has(directory)) {
      const file = path.join(directory, 'oh-package.json5');
      const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (text !== null) manifestHashes.set(file, sha256(text));
      packageCache.set(directory, text !== null ? parseJson5(text) : null);
    }
    return packageCache.get(directory);
  }
  function resolveFile(candidate) {
    for (const suffix of ['', '.ets', '.ts', '.d.ets', '.d.ts']) {
      const file = candidate + suffix;
      if (isArkTsSource(file) && host.fileExists(file) && !requireDirectory(file)) {
        const actual = realFile(file);
        if (!isArkTsSource(actual)) continue;
        return canonicalFiles.get(host.getCanonicalFileName(actual)) ?? actual;
      }
    }
    const pkg = packageJson(candidate);
    for (const main of [pkg?.types, pkg?.main, 'Index.ets', 'index.ets', 'index.d.ts', 'index.ts'].filter(Boolean)) {
      const file = path.join(candidate, main);
      if (isArkTsSource(file) && host.fileExists(file) && !requireDirectory(file)) {
        const actual = realFile(file);
        if (!isArkTsSource(actual)) continue;
        return canonicalFiles.get(host.getCanonicalFileName(actual)) ?? actual;
      }
    }
    return null;
  }
  // statSync is avoided in the hot path except for existing candidates.
  function requireDirectory(file) {
    try { return ts.sys.directoryExists(file); } catch { return false; }
  }
  function resolveModule(name, containing) {
    if (/^@(kit|ohos|hms|arkts|system)\./.test(name)) {
      for (const family of ['openharmony', 'hms']) {
        const category = name.startsWith('@kit.') ? 'kits' : name.startsWith('@arkts.') ? 'arkts' : 'api';
        const modulePath = name.startsWith('@ohos.inner.') ? name.slice('@ohos.inner.'.length).replaceAll('.', '/') : name;
        const etsRoot = toolchain.sdkFamilies?.[family]
          ?? path.join(toolchain.sdkRoot, 'default', family, 'ets');
        const file = resolveFile(path.join(etsRoot, category, modulePath));
        if (file) return file;
      }
      return null;
    }
    if (name.startsWith('.')) return resolveFile(path.resolve(path.dirname(containing), name));
    let directory = path.dirname(containing);
    while (directory !== path.dirname(directory)) {
      const pkg = packageJson(directory);
      const dependency = pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name];
      if (typeof dependency === 'string' && dependency.startsWith('file:')) {
        const local = resolveFile(path.resolve(directory, dependency.slice(5)));
        if (local) return local;
      }
      const installed = resolveFile(path.join(directory, 'oh_modules', name));
      if (installed) return installed;
      directory = path.dirname(directory);
    }
    const module = project.modules.find(item => item.name === name || packageJson(item.root)?.name === name);
    const resolved = module ? resolveFile(module.root) : ts.resolveModuleName(name, containing, options, host).resolvedModule?.resolvedFileName;
    if (!resolved || !isArkTsSource(resolved)) return null;
    const actual = realFile(resolved);
    return isArkTsSource(actual) ? canonicalFiles.get(host.getCanonicalFileName(actual)) ?? actual : null;
  }
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError) => {
    if (!isArkTsSource(file)) return undefined;
    const identity = host.getCanonicalFileName(file);
    const overlay = overlayFiles.get(identity);
    if (overlay) return ts.createSourceFile(overlay.file, overlay.text, languageVersion, true,
      overlay.file.endsWith('.ets') ? ts.ScriptKind.ETS : ts.ScriptKind.TS, options);
    file = canonicalFiles.get(identity) ?? file;
    const sdkFile = sdkSourceFiles.get(identity);
    if (sdkFile) return sdkFile;
    if (existsSync(file)) return ts.createSourceFile(file, readFileSync(file, 'utf8'), languageVersion, true, path.extname(file).toLowerCase() === '.ets' ? ts.ScriptKind.ETS : ts.ScriptKind.TS, options);
    return getSourceFile(file, languageVersion, onError);
  };
  host.resolveModuleNames = (names, containing) => names.map(name => {
    const file = resolveModule(name, containing);
    if (!file) {
      unresolvedImports.push({ file: containing, module: name, reason: 'MODULE_NOT_RESOLVED' });
      return undefined;
    }
    return { resolvedFileName: file, extension: file.endsWith('.d.ets') ? ts.Extension.Dets : file.endsWith('.ets') ? ts.Extension.Ets : file.endsWith('.d.ts') ? ts.Extension.Dts : ts.Extension.Ts };
  });
  const roots = [...new Set([...project.sourceFiles, ...overlays.keys()])].filter(isArkTsSource);
  const globals = [...catalog.sourceFiles].filter(([file, sf]) => isArkTsSource(file) && file.includes(`${path.sep}component${path.sep}`) && !ts.isExternalModule(sf)).map(([file]) => file);
  if (builder) {
    const originalSource = host.getSourceFile;
    host.getSourceFile = (...args) => {
      const source = originalSource(...args);
      if (source) source.version = sha256(source.text);
      return source;
    };
  }
  const builderProgram = builder ? ts.createSemanticDiagnosticsBuilderProgram([...roots, ...globals], options, host) : null;
  const program = builderProgram?.getProgram() ?? ts.createProgram([...roots, ...globals], options, host);
  return { program, builderProgram, checker: program.getTypeChecker(), unresolvedImports, roots, manifestHashes,
    sdkSourceFileIdentities: new Set(sdkSourceFiles.keys()), resolveModule };
}

// Follow only declarations and exported names actually used by project code.
// Merely loading an SDK barrel (or a global component library) does not make all
// of its exports relevant to the project's type evidence.
export function classifySdkImportImpact({ program, checker, roots, unresolvedImports,
  sdkSourceFileIdentities, resolveModule }, catalog) {
  const { ts } = catalog;
  const needed = new Set();
  const visitedNodes = new Set();
  const visitedExports = new Set();
  const importKey = (file, module) => `${compilerPathIdentity(file)}\0${module}`;
  const unresolvedKeys = new Set(unresolvedImports.map(item => importKey(item.file, item.module)));
  const sourceFor = file => program.getSourceFile(file)
    ?? program.getSourceFiles().find(source => compilerPathIdentity(source.fileName) === compilerPathIdentity(file));
  function followExport(file, name) {
    const key = `${compilerPathIdentity(file)}\0${name}`;
    if (visitedExports.has(key)) return;
    visitedExports.add(key);
    const source = sourceFor(file);
    if (!source) return;
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
      const module = statement.moduleSpecifier.text;
      const elements = statement.exportClause?.elements;
      const selected = elements?.filter(item => name === '*' || item.name.text === name);
      if (elements && !selected.length) continue;
      const resolved = resolveModule(module, source.fileName);
      if (!resolved) {
        needed.add(importKey(source.fileName, module));
      } else if (!elements) followExport(resolved, name);
      else for (const item of selected) followExport(resolved, item.propertyName?.text ?? item.name.text);
    }
  }
  function declaration(node) {
    if (!node || visitedNodes.has(node)) return;
    visitedNodes.add(node);
    const source = node.getSourceFile?.();
    if (!source) return;
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) {
      let owner = node;
      while (owner && !ts.isImportDeclaration(owner)) owner = owner.parent;
      if (owner?.moduleSpecifier) {
        const module = owner.moduleSpecifier.text;
        const resolved = resolveModule(module, source.fileName);
        if (!resolved) needed.add(importKey(source.fileName, module));
        else followExport(resolved, ts.isNamespaceImport(node) ? '*' : node.propertyName?.text ?? node.name?.text ?? 'default');
      }
    }
    if (ts.isExportSpecifier(node)) {
      const owner = node.parent?.parent;
      if (owner?.moduleSpecifier) {
        const module = owner.moduleSpecifier.text;
        const resolved = resolveModule(module, source.fileName);
        if (!resolved) needed.add(importKey(source.fileName, module));
        else followExport(resolved, node.propertyName?.text ?? node.name.text);
      }
    }
    if (sdkSourceFileIdentities.has(compilerPathIdentity(source.fileName))) {
      function visit(child) {
        if (ts.isIdentifier(child) || ts.isStringLiteral(child)) symbol(checker.getSymbolAtLocation(child));
        ts.forEachChild(child, visit);
      }
      visit(node);
    }
  }
  function symbol(value) {
    for (const node of value?.declarations ?? []) declaration(node);
    if (value?.flags & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(value);
      if (target !== value) for (const node of target?.declarations ?? []) declaration(node);
    }
  }
  for (const root of roots) {
    const source = sourceFor(root);
    if (!source) continue;
    function visit(node) {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          const resolved = resolveModule(node.moduleSpecifier.text, source.fileName);
          if (resolved) {
            if (node.exportClause?.elements) for (const exported of node.exportClause.elements) followExport(resolved, exported.propertyName?.text ?? exported.name.text);
            else followExport(resolved, '*');
          }
        }
        return;
      }
      if (ts.isIdentifier(node) || ts.isStringLiteral(node)) symbol(checker.getSymbolAtLocation(node));
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) declaration(checker.getResolvedSignature(node)?.declaration);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return unresolvedImports.map(item => {
    const sdk = sdkSourceFileIdentities.has(compilerPathIdentity(item.file));
    const system = /^@(kit|ohos|hms|arkts|system)\./.test(item.module);
    const affected = !sdk ? system : needed.has(importKey(item.file, item.module));
    return { ...item, blocking: affected,
      reason: sdk && !affected ? 'UNUSED_SDK_IMPORT_NOT_RESOLVED' : item.reason,
      impactEvidence: sdk ? { usedDeclarationAnalysis: true, requiredImport: affected,
        inspectedMissingImport: unresolvedKeys.has(importKey(item.file, item.module)) } : undefined };
  });
}

function actualSymbol(ts, checker, node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

function symbolEntries(catalog, symbol) {
  const entries = symbol?.declarations?.map(node => catalogEntry(catalog, node)).filter(Boolean) ?? [];
  return [...new Map(entries.map(entry => [entry.symbolId, entry])).values()];
}

const PLATFORM_BY_LEVEL = new Map([[12, '5.0.0'], [13, '5.0.1'], [14, '5.0.2'], [15, '5.0.3'], [16, '5.0.4'], [17, '5.0.5'], [18, '5.1.0'], [19, '5.1.1'], [20, '6.0.0'], [21, '6.0.1'], [22, '6.0.2'], [23, '6.1.0'], [24, '6.1.1'], [26, '26.0.0']]);

export async function scanArkTsDeprecations({ project, catalog }) {
  const { ts } = catalog;
  const context = createArkTsProgram(project, catalog);
  const { program, checker, roots, manifestHashes } = context;
  const active = new Set(catalog.deprecatedEntries.map(entry => entry.symbolId));
  const unresolved = [];
  const findings = [];
  const seen = new Set();
  const isCallLike = node => ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isEtsComponentExpression(node);
  function typedMember(typeNode, name, visited = new Set()) {
    if (!typeNode || visited.has(typeNode)) return [];
    visited.add(typeNode);
    if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode))
      return typeNode.types.flatMap(type => typedMember(type, name, visited));
    if (ts.isParenthesizedTypeNode(typeNode)) return typedMember(typeNode.type, name, visited);
    let declarations = [];
    if (ts.isTypeLiteralNode(typeNode)) declarations = [typeNode];
    else {
      const symbol = actualSymbol(ts, checker, typeNode.typeName ?? typeNode.expression ?? typeNode);
      declarations = (symbol?.declarations ?? []).filter(node => catalogEntry(catalog, node));
      const local = declarations.filter(node => compilerPathIdentity(node.getSourceFile().fileName)
        === compilerPathIdentity(typeNode.getSourceFile().fileName));
      if (local.length) declarations = local;
    }
    return declarations.flatMap(declaration => {
      if (ts.isTypeAliasDeclaration(declaration)) return typedMember(declaration.type, name, visited);
      const members = (declaration.members ?? []).filter(member => member.name?.getText().replace(/^['"]|['"]$/g, '') === name);
      if (members.length) return members.map(member => catalogEntry(catalog, member)).filter(Boolean);
      return (declaration.heritageClauses ?? []).flatMap(clause => clause.types.flatMap(type => typedMember(type, name, visited)));
    });
  }
  function emit(node, entry, related = [], call = null) {
    if (!active.has(entry.symbolId)) return;
    const sf = node.getSourceFile();
    const start = node.getStart(sf);
    const position = sf.getLineAndCharacterOfPosition(start);
    const module = projectModuleForFile(project, sf.fileName);
    const relative = module ? `${module.name}/${portableRelative(module.root, sf.fileName)}` : portableRelative(project.root, sf.fileName);
    const occurrenceId = `occurrence-${sha256([relative, start, node.end, entry.symbolId].join('\0')).slice(0, 24)}`;
    if (seen.has(occurrenceId)) return;
    seen.add(occurrenceId);
    const platform = PLATFORM_BY_LEVEL.get(entry.deprecatedSince);
    findings.push({
      'Api Definition': entry.declaration, Language: 'ArkTS',
      'Changed in SDK': platform ? canonicalVersion(`${platform}(${entry.deprecatedSince})`) : '',
      'Affected Versions': 'N/A (compile-time)', Title: hyperlink(deprecatedDocUrl(entry), `${entry.qualifiedName}：API 废弃`),
      'Code Location': `${relative}:${position.line + 1}`, Fixed: 'Unfixed',
      'Change Type': 'Deprecated API', 'Rule ID': `sdk-deprecated-${entry.symbolId.slice(4)}`,
      'Change Operation': 'API_DEPRECATED', 'Source Reference': `${entry.file}:${entry.line}`,
      'Replacement API': entry.replacementApi ?? '', 'Replacement Source': `${entry.file}:${entry.line}`,
      'API Symbol ID': entry.symbolId, Column: position.character + 1, 'Deprecated Since': entry.deprecatedSince,
      'Detection Source': 'SDK_STATE', 'Source Scope': 'PROJECT',
      includedInCsv: true, disposition: 'REQUIRES_REVIEW', filterReason: null, applicabilityProof: null,
      occurrenceId, sourceSymbol: node.text, sourceFileHash: sha256(sf.text), sourceRange: { start, end: node.end },
      callRange: call ? { start: call.getStart(sf), end: call.end } : null,
      sdkEvidence: declarationEvidence(entry, catalog),
      relatedDeclarations: related.map(item => declarationEvidence(item, catalog)), documentReferences: [],
    });
  }
  for (const file of roots) {
    const sf = program.getSourceFile(file);
    if (!sf) { unresolved.push({ file, reason: 'SOURCE_NOT_PARSED' }); continue; }
    unresolved.push(...sf.parseDiagnostics.map(d => ({ file, reason: 'SOURCE_PARSE_ERROR', start: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') })));
    function visit(node) {
      if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
        const parent = node.parent;
        const declarationName = parent.name === node && !ts.isPropertyAccessExpression(parent) && !ts.isPropertyAssignment(parent) && !ts.isShorthandPropertyAssignment(parent);
        const importName = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent);
        if (!declarationName && !importName) {
          let entries = symbolEntries(catalog, actualSymbol(ts, checker, node));
          let callee = node;
          if (ts.isPropertyAccessExpression(parent) && parent.name === node) callee = parent;
          if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) callee = parent;
          const call = callee.parent && isCallLike(callee.parent) && callee.parent.expression === callee ? callee.parent : null;
          const receiverCall = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node && parent.parent && isCallLike(parent.parent) && parent.parent.expression === parent ? parent.parent : null;
          if (call) {
            const signatureEntry = catalogEntry(catalog, checker.getResolvedSignature(call)?.declaration);
            if (ts.isElementAccessExpression(callee) && !signatureEntry && !ts.isStringLiteral(node)) {
              const receiver = checker.getTypeAtLocation(callee.expression);
              if (symbolEntries(catalog, receiver.symbol ?? receiver.aliasSymbol).length && !checker.getIndexInfoOfType(receiver, ts.IndexKind.String)) unresolved.push({ file, start: node.getStart(sf), api: call.getText(sf), reason: 'SDK_DYNAMIC_MEMBER_NOT_RESOLVED' });
            }
            if (!signatureEntry && entries.some(entry => entry.kind === 'method')) unresolved.push({ file, start: node.getStart(sf), api: call.getText(sf), reason: 'SDK_CALL_SIGNATURE_NOT_RESOLVED' });
            if (ts.isNewExpression(call)) {
              const typeEntry = entries.find(entry => ['class', 'struct', 'interface'].includes(entry.kind));
              entries = typeEntry && active.has(typeEntry.symbolId) ? [typeEntry] : signatureEntry ? [signatureEntry] : [];
              if (entries[0]) emit(node, entries[0], signatureEntry ? [signatureEntry] : [], call);
              entries = [];
            } else entries = signatureEntry ? [signatureEntry] : entries.filter(entry => entry.kind !== 'method');
          }
          if (ts.isPropertyAssignment(parent) && parent.name === node) {
            const object = parent.parent;
            const contextual = checker.getContextualType(object)?.getProperty(node.text);
            entries = symbolEntries(catalog, contextual);
            if (entries.length > 1 && isCallLike(object.parent)) {
              const signature = checker.getResolvedSignature(object.parent)?.declaration;
              const index = object.parent.arguments?.indexOf(object) ?? -1;
              const type = signature?.parameters[index]?.type;
              const exact = typedMember(type, node.text);
              if (exact.length) entries = [...new Map(exact.map(entry => [entry.symbolId, entry])).values()];
            }
            // ArkUI struct initializers are not regular TS constructor parameter objects.
            if (!entries.length && isCallLike(object.parent)) {
              const component = actualSymbol(ts, checker, object.parent.expression);
              const componentEntry = symbolEntries(catalog, component).find(entry => entry.kind === 'struct');
              if (componentEntry) entries = catalog.declarations.filter(entry => entry.file === componentEntry.file && entry.owner === componentEntry.qualifiedName && entry.name === node.text);
            }
          }
          if (entries.length > 1 && ts.isPropertyAccessExpression(parent) && parent.name === node
            && isCallLike(parent.expression)) {
            const exact = typedMember(checker.getResolvedSignature(parent.expression)?.declaration?.type, node.text);
            if (exact.length) entries = [...new Map(exact.map(entry => [entry.symbolId, entry])).values()];
          }
          if (entries.length > 1 && entries.some(entry => active.has(entry.symbolId))) {
            unresolved.push({ file, start: node.getStart(sf), api: parent.getText(sf), reason: 'AMBIGUOUS_MERGED_DECLARATION',
              candidates: entries.map(entry => ({ symbolId: entry.symbolId, file: entry.file, declaration: entry.declaration })) });
            entries = [];
          }
          for (const entry of entries) emit(node, entry, [], call ?? receiverCall);
          if (!entries.length && ts.isPropertyAccessExpression(parent) && parent.name === node && !checker.getSymbolAtLocation(node)) {
            let base = parent.expression;
            while (ts.isPropertyAccessExpression(base)) base = base.expression;
            const receiverType = checker.getTypeAtLocation(parent.expression);
            const sdkType = symbolEntries(catalog, receiverType.symbol ?? receiverType.aliasSymbol).length > 0;
            const indexed = checker.getIndexInfoOfType(receiverType, ts.IndexKind.String);
            if (!indexed && (sdkType || symbolEntries(catalog, actualSymbol(ts, checker, base)).length)) unresolved.push({ file, start: node.getStart(sf), api: parent.getText(sf), reason: 'SDK_MEMBER_NOT_RESOLVED' });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  // Triggered module resolution includes SDK and dependency declarations, not just roots.
  const importImpact = classifySdkImportImpact(context, catalog);
  unresolved.push(...importImpact.filter(item => item.blocking));
  const resolutionWarnings = importImpact.filter(item => !item.blocking);
  const uniqueUnresolved = [...new Map(unresolved.map(item => [JSON.stringify(item), item])).values()];
  findings.sort((a, b) => a['Code Location'].localeCompare(b['Code Location'], undefined, { numeric: true }) || a.Column - b.Column || a['API Symbol ID'].localeCompare(b['API Symbol ID']));
  const analyzedFiles = [...program.getSourceFiles().map(sf => ({ file: sf.fileName, hash: sha256(sf.text) })), ...[...manifestHashes].map(([file, hash]) => ({ file, hash }))];
  return { findings, unresolved: uniqueUnresolved, resolutionWarnings, analyzedFiles, coverage: { status: uniqueUnresolved.length ? 'INCOMPLETE' : 'COMPLETE', scannedFileCount: roots.length, findingCount: findings.length, unresolvedCount: uniqueUnresolved.length, projectImportWarningCount: resolutionWarnings.length, sdkSnapshot: catalog.snapshot,
    analysisSnapshot: sha256(analyzedFiles.map(item => `${item.file}\0${item.hash}`).sort().join('\n')) } };
}

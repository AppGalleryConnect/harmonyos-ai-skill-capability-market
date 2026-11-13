import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { buildSdkCatalog, catalogEntry, indexSdkFile, readSdkCompilerConfiguration, resolveRuleDeclarations, sdkLocationKey } from '../core/sdk-deprecations.mjs';
import { compilerPathIdentity, createArkTsProgram, projectModuleForFile, scanArkTsDeprecations } from '../deprecated/arkts-deprecations.mjs';
import { loadProject } from '../core/project.mjs';
import { parseVersion } from '../../shared/platform/version.mjs';

const parserPath = process.env.HARMONYOS_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript/lib/typescript.js';
const available = existsSync(parserPath);

test('merged SDK option interfaces follow the selected API declaration instead of another component', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sdk-merged-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parser = { ...ts, isStructDeclaration: () => false, isAnnotationDeclaration: () => false,
    isAnnotationPropertyDeclaration: () => false, isEtsComponentExpression: () => false };
  const file = path.join(root, 'Main.ts');
  await writeFile(file, "declare const tabs: SubTabBarStyle; tabs.indicator({color:'red'});\n"
    + "declare const swiper: SwiperAttribute; swiper.indicatorStyle({color:'red'});");
  const definitions = [
    ['tab_content.d.ts', 'interface IndicatorStyle { color?: string; } type TabOptions = IndicatorStyle; declare class SubTabBarStyle { indicator(value: TabOptions): void; }'],
    ['swiper.d.ts', '/** @deprecated since 10 */ interface IndicatorStyle {\n/** @deprecated since 10 */\ncolor?: string; } declare class SwiperAttribute { indicatorStyle(value: IndicatorStyle): void; }'],
  ];
  const sourceFiles = new Map(definitions.map(([name, text]) => {
    const sdkFile = path.join(root, 'component', name);
    return [sdkFile, ts.createSourceFile(sdkFile, text, ts.ScriptTarget.Latest, true)];
  }));
  const declarations = [...sourceFiles.values()].flatMap(source => indexSdkFile(parser, source, 'openharmony', path.basename(source.fileName)).declarations);
  const catalog = { ts: parser, sourceFiles, declarations, deprecatedEntries: declarations.filter(entry => entry.deprecatedSince !== null),
    byLocation: new Map(declarations.map(entry => [`${entry.file}\0${entry.start}`, entry])), toolchain: { sdkRoot: root },
    sdkCompilerOptions: { noLib: true }, etsOptions: {}, snapshot: 'merged-options', coverage: {} };
  const result = await scanArkTsDeprecations({ project: { root, modules: [], sourceFiles: [file] }, catalog });
  const colors = result.findings.filter(row => row.sdkEvidence.name === 'color');
  assert.deepEqual(colors.map(row => row['Code Location']), ['Main.ts:2']);
  assert.equal(result.unresolved.length, 0);
});

test('SDK standard libraries keep Canvas calls bound to SDK declarations without ambient DOM', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sdk-canvas-libraries-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Main.ts'), sdkFile = path.join(root, 'component', 'canvas.d.ts');
  const config = path.join(root, 'tsconfig.json');
  await writeFile(path.join(root, 'base.json'), JSON.stringify({ compilerOptions: { lib: ['es2021'], types: [], typeRoots: [] } }));
  await writeFile(config, JSON.stringify({ extends: './base.json' }));
  await writeFile(file, 'declare const context: CanvasRenderingContext2D; context.drawImage({sdkImage:true}, 1, 2);');
  const declaration = ts.createSourceFile(sdkFile,
    'declare class CanvasRenderer { drawImage(image: {sdkImage:boolean}, x:number, y:number): void; }\n'
    + 'declare class CanvasRenderingContext2D extends CanvasRenderer {}', ts.ScriptTarget.Latest, true);
  const catalog = { ts, toolchain: { sdkRoot: root }, etsOptions: {}, sourceFiles: new Map([[sdkFile, declaration]]),
    compilerConfiguration: readSdkCompilerConfiguration(ts, config) };
  catalog.sdkCompilerOptions = catalog.compilerConfiguration.options;
  const { program, checker } = createArkTsProgram({ root, modules: [], sourceFiles: [file] }, catalog);
  assert.equal(program.getSourceFiles().some(source => path.basename(source.fileName) === 'lib.dom.d.ts'), false);
  const call = program.getSourceFile(file).statements[1].expression;
  assert.equal(checker.getResolvedSignature(call)?.declaration.getSourceFile().fileName, sdkFile);
});

test('compiler path identity treats Windows parser and filesystem separators as the same file', () => {
  assert.equal(
    compilerPathIdentity('D:\\SDK\\api\\@ohos.promptAction.d.ts', 'win32'),
    compilerPathIdentity('d:/sdk/api/@ohos.promptAction.d.ts', 'win32'),
  );
});

test('catalog lookup normalizes Windows separators for SDK declaration locations', () => {
  const indexedFile = 'D:/SDK/api/@ohos.promptAction.d.ts';
  const originalFile = { fileName: 'D:\\SDK\\api\\@ohos.promptAction.d.ts' };
  const cloneFile = { fileName: originalFile.fileName };
  const original = { getSourceFile: () => originalFile, getStart: () => 42 };
  const clone = { getSourceFile: () => cloneFile, getStart: () => 42, end: 50 };
  const entry = { symbolId: 'api-show-toast' };
  const catalog = {
    platform: 'win32',
    ts: { getOriginalNode: () => original },
    byLocation: new Map([[`${indexedFile}\0${original.getStart()}`, entry]]),
    byComparableLocation: new Map([[sdkLocationKey(indexedFile, original.getStart(), 'win32'), entry]]),
  };

  assert.equal(catalogEntry(catalog, clone), entry);
});

test('maps parser-normalized Windows source paths back to their project module', () => {
  const module = projectModuleForFile({ modules: [{
    name: 'module_transition',
    root: 'D:\\Work\\News\\components\\module_transition',
  }] }, 'D:/Work/News/components/module_transition/src/main/ets/Utils.ets', 'win32');

  assert.equal(module?.name, 'module_transition');
});

test('SDK indexing ignores nameless JSDoc tags without losing known tags', () => {
  const no = () => false;
  const sourceFile = {
    fileName: 'sdk.d.ts',
    text: 'declare function legacy(): void;',
    name: { getText: () => 'legacy' },
    end: 32,
    getStart: () => 0,
    getText() { return this.text; },
    getLineAndCharacterOfPosition: () => ({ line: 0, character: 0 }),
  };
  const deprecated = {
    comment: 'since 26',
    parent: { tags: [{}, { tagName: { text: 'useinstead' }, comment: 'modern' }] },
  };
  const ts = {
    isClassDeclaration: no,
    isStructDeclaration: no,
    isAnnotationDeclaration: no,
    isInterfaceDeclaration: no,
    isEnumDeclaration: no,
    isModuleDeclaration: no,
    isConstructorDeclaration: no,
    isFunctionDeclaration: node => node === sourceFile,
    isMethodDeclaration: no,
    isMethodSignature: no,
    isCallSignatureDeclaration: no,
    isGetAccessor: no,
    isSetAccessor: no,
    isEnumMember: no,
    isPropertyDeclaration: no,
    isPropertySignature: no,
    isAnnotationPropertyDeclaration: no,
    isVariableDeclaration: no,
    isTypeAliasDeclaration: no,
    getJSDocTags: () => [{}, { tagName: { text: 'throws' }, getText: () => '@throws Error' }],
    getJSDocDeprecatedTag: () => deprecated,
    forEachChild: () => {},
    SyntaxKind: { StaticKeyword: 126 },
  };

  const result = indexSdkFile(ts, sourceFile, 'openharmony', 'api/sdk.d.ts');

  assert.equal(result.declarations.length, 1);
  assert.equal(result.declarations[0].replacementApi, 'modern');
  assert.deepEqual(result.declarations[0].throws, ['@throws Error']);
});

async function fixture(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deprecated-semantics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdkRoot = path.join(root, 'sdk');
  const ets = path.join(sdkRoot, 'default/openharmony/ets');
  const files = {
    'build-profile.json5': '{app:{products:[{name:"default"}]},modules:[{name:"entry",srcPath:"./entry"},{name:"shared",srcPath:"./shared"}]}',
    'entry/src/main/module.json5': '{module:{type:"entry"}}',
    'shared/src/main/module.json5': '{module:{type:"har"}}',
    'shared/oh-package.json5': '{name:"shared",main:"Index.ets"}',
    'shared/Index.ets': 'export { getView } from "./View";',
    'shared/View.ets': 'import { modern } from "@kit.TestKit"; export function getView(): modern.View { return new modern.View(); }',
    'entry/oh-package.json5': '{dependencies:{shared:"file:../shared"}}',
    'entry/src/main/ets/A.ets': source,
    'oh_modules/unused/A.ets': 'oldGlobal(1);',
  };
  for (const [f, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await writeFile(path.join(root, f), text);
  }
  await mkdir(path.join(ets, 'api'), { recursive: true });
  await mkdir(path.join(ets, 'kits'), { recursive: true });
  await mkdir(path.join(ets, 'component'), { recursive: true });
  await writeFile(path.join(ets, 'component/global.d.ts'), '/** @deprecated since 18\n * @useinstead modern.View.convert\n */ declare function oldGlobal(value: number): number;');
  await writeFile(path.join(ets, 'kits/@kit.TestKit.d.ts'), 'export { legacy, modern, Alert, Animator } from "../api/@ohos.test";');
  await writeFile(path.join(ets, 'api/@ohos.test.d.ts'), `
export namespace legacy {
  /** @deprecated since 20\n   * @useinstead modern.View\n   */ export class Format {
    /** @deprecated since 20\n     * @useinstead modern.View.convert\n     */ format(value: number): number;
    formatMatcher: string;
  }
  export class Decoder {
    /** @deprecated since 9\n     * @useinstead decodeToString\n     */ decode(value: string): string;
    decodeToString(value: string): string;
  }
}
export namespace modern { export class View { convert(value: number): number; } }
/** @deprecated since 26\n * @useinstead modern.View\n */ export class Alert {
  /** @deprecated since 18\n   * @useinstead modern.View.convert\n   */ static show(value: number): void;
}
export class Animator {
  /** @deprecated since 18\n   * @useinstead modern.View\n   */ static create(value: number): void;
  static create(value: string): void;
  /** @deprecated since 30 */ static future(): void;
}
`);
  const toolchain = { sdkRoot, parserPath, sdkVersion: parseVersion('26.0.0(26) Release'), sdkMetadata: { data: { apiVersion: '26', platformVersion: '26.0.0', releaseType: 'Release' } } };
  const catalog = await buildSdkCatalog(toolchain, parseVersion('26.0.0(26) Release'));
  const project = await loadProject(root, 'default');
  return { root, project, catalog, toolchain, ets };
}

test('SDK identity is namespace and overload exact; replacement never matches substrings', { skip: !available }, async (t) => {
  const { catalog } = await fixture(t, '');
  const declarations = resolveRuleDeclarations(catalog, { completePath: '/interface/sdk-js/api/@ohos.test.d.ts', className: 'Format', interfaceName: 'format', interfaceType: 'method', methodDefinition: 'format(value: number): number;' });
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].qualifiedName, 'legacy.Format.format');
  assert.equal(declarations[0].replacementApi, 'modern.View.convert');
  assert.equal(catalog.deprecatedEntries.some(e => e.name === 'future'), false);
});

test('unrelated missing SDK exports warn, but a project use of that export blocks coverage', { skip: !available }, async t => {
  const { project, catalog, ets } = await fixture(t, 'oldGlobal(1);');
  const file = path.join(ets, 'api/@ohos.test.d.ts');
  const { readFile } = await import('node:fs/promises');
  await writeFile(file, `${await readFile(file, 'utf8')}\nexport { Missing } from './missing-in-sdk';\n`);
  const updated = await buildSdkCatalog(catalog.toolchain, catalog.targetVersion);
  const unrelated = await scanArkTsDeprecations({ project, catalog: updated });
  assert.equal(unrelated.coverage.status, 'COMPLETE');
  assert.ok(unrelated.resolutionWarnings.some(item => item.module === './missing-in-sdk'
    && item.reason === 'UNUSED_SDK_IMPORT_NOT_RESOLVED'));
  await writeFile(project.sourceFiles.find(file => file.endsWith('/A.ets')),
    'import { Missing } from "@ohos.test"; let value: Missing; oldGlobal(1);');
  const used = await scanArkTsDeprecations({ project, catalog: updated });
  assert.equal(used.coverage.status, 'INCOMPLETE');
  assert.ok(used.unresolved.some(item => item.module === './missing-in-sdk'));
});

test('deprecated titles use SDK module links and keep SDK declaration evidence', { skip: !available }, async (t) => {
  const { project, catalog } = await fixture(t, `import { legacy } from '@kit.TestKit';
const f = new legacy.Format(); f.format(1);
oldGlobal(1);`);
  const { findings } = await scanArkTsDeprecations({ project, catalog });
  const format = findings.find(f => f.sdkEvidence.qualifiedName === 'legacy.Format.format');
  assert.equal(format.Title, '=HYPERLINK("https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-test","legacy.Format.format：API 废弃")');
  assert.deepEqual(format.documentReferences, []);
  assert.equal(format['Source Reference'], format['Replacement Source']);
  const globalRows = findings.filter(f => f.sdkEvidence.name === 'oldGlobal');
  assert.ok(globalRows.length > 0 && globalRows.every(f => !String(f.Title).startsWith('=')));
});

test('resolves old APIs, constructors, inheritance, aliases, reexports and exact overloads', { skip: !available }, async (t) => {
  const { project, catalog } = await fixture(t, `import { legacy as l, Alert, Animator } from '@kit.TestKit';
import { getView } from 'shared';
const f = new l.Format(); f.format(1);
const d = new l.Decoder(); d.decode('x');
class Derived extends l.Decoder {} new Derived().decode('x');
Alert.show(1); Animator.create(1); Animator.create('x'); Animator.future();
getView().convert(1); const fake = { oldGlobal(x: number) { return x; } }; fake.oldGlobal(1);
oldGlobal(
  oldGlobal(1)); oldGlobal(2); oldGlobal(3);
`);
  const result = await scanArkTsDeprecations({ project, catalog });
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.findings.length, 11);
  assert.equal(result.findings.filter(f => f['Deprecated Since'] === 9).length, 2);
  assert.equal(result.findings.filter(f => f.sdkEvidence.qualifiedName === 'Animator.create').length, 1);
  assert.equal(result.findings.filter(f => f.sdkEvidence.qualifiedName === 'Alert').length, 1);
  assert.equal(result.findings.filter(f => f.sdkEvidence.qualifiedName === 'Alert.show').length, 1);
  const alert = result.findings.filter(f => f.sdkEvidence.qualifiedName.startsWith('Alert'));
  assert.deepEqual(alert[0].callRange, alert[1].callRange);
  assert.equal(result.findings.filter(f => f.sdkEvidence.name === 'oldGlobal').length, 4);
  assert.equal(new Set(result.findings.map(f => f.occurrenceId)).size, 11);
  assert.ok(result.findings.every(f => f.Column > 0 && f['Source Scope'] === 'PROJECT'));
  const again = await scanArkTsDeprecations({ project, catalog });
  assert.deepEqual(again.findings, result.findings);
});

test('ArkUI component initializer fields resolve to the SDK struct, not a same-name object', { skip: !available }, async (t) => {
  const fixtureData = await fixture(t, `import Card from '@ohos.card';
@Builder function render() { Card({ callback: () => {} }); }
const own = { callback: () => {} }; own.callback();`);
  await writeFile(path.join(fixtureData.ets, 'api/@ohos.card.d.ets'), `
declare struct Card {
 /** @deprecated since 19\n  * @useinstead Card.onResult\n  */ callback: () => void;
 onResult: () => void;
 build(): void;
}
export default Card;`);
  const catalog = await buildSdkCatalog(fixtureData.toolchain);
  const project = await loadProject(fixtureData.root, 'default');
  const result = await scanArkTsDeprecations({ project, catalog });
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].sdkEvidence.qualifiedName, 'Card.callback');
});

test('missing SDK imports are explicit unresolved evidence', { skip: !available }, async (t) => {
  const { project, catalog } = await fixture(t, 'import { unknown } from "@kit.MissingKit"; unknown.run();');
  const result = await scanArkTsDeprecations({ project, catalog });
  assert.ok(result.unresolved.some(e => e.reason === 'MODULE_NOT_RESOLVED'));
});

test('typed SDK receivers with missing methods fail resolution rather than silently completing', { skip: !available }, async (t) => {
  const { project, catalog } = await fixture(t, 'import { modern } from "@kit.TestKit"; const ui = new modern.View(); ui.missing(1); ui.toString();');
  const result = await scanArkTsDeprecations({ project, catalog });
  assert.ok(result.unresolved.some(item => item.api === 'ui.missing' && item.reason === 'SDK_MEMBER_NOT_RESOLVED'));
  assert.equal(result.unresolved.some(item => item.api === 'ui.toString'), false);
});

test('computed SDK calls still resolve the selected overload', { skip: !available }, async (t) => {
  const { project, catalog } = await fixture(t, `import { legacy, Animator } from '@kit.TestKit';
const decoder = new legacy.Decoder(); decoder['decode']('x');
Animator['create'](1); Animator['create']('x');`);
  const result = await scanArkTsDeprecations({ project, catalog });
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings.map(item => item.sdkEvidence.qualifiedName), ['legacy.Decoder.decode', 'Animator.create']);
});

test('case-insensitive imports use the discovered source spelling', { skip: !available }, async (t) => {
  const f = await fixture(t, 'import { run } from "./utils"; run();');
  await mkdir(path.join(f.root, 'entry/src/main/ets/utils'));
  await writeFile(path.join(f.root, 'entry/src/main/ets/utils/index.ets'), 'export function run() { oldGlobal(1); }');
  const project = await loadProject(f.root, 'default');
  const result = await scanArkTsDeprecations({ project, catalog: f.catalog });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]['Code Location'], 'entry/src/main/ets/utils/index.ets:1');
});

test('a newer compile SDK keeps its real snapshot and filters deprecations by requested target', { skip: !available }, async (t) => {
  const { toolchain } = await fixture(t, '');
  const full=await buildSdkCatalog(toolchain,parseVersion('26'));
  const older=await buildSdkCatalog(toolchain,parseVersion('20'));
  assert.equal(older.snapshot,full.snapshot);
  assert.equal(older.coverage.compileSdk,'26.0.0(26) Release');
  assert.equal(older.coverage.targetSdk,'6.0.0(20) Release');
  assert.ok(older.deprecatedEntries.every(entry=>entry.deprecatedSince<=20));
  assert.ok(older.declarations.every(entry=>entry.file.startsWith(older.toolchain.sdkRoot)));
  await assert.rejects(buildSdkCatalog({...toolchain,sdkVersion:parseVersion('19')},parseVersion('20')),{code:'SDK_TARGET_NOT_COVERED'});
});

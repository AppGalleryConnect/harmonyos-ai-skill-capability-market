import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { auditDeprecationRules } from '../core/rules.mjs';

const parserPath = process.env.HARMONYOS_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript/lib/typescript.js';

test('audits declarations when the Windows parser normalizes source file separators', async () => {
  const parserFile = 'D:/SDK/api/@ohos.legacy.d.ts';
  const filesystemFile = 'D:\\SDK\\api\\@ohos.legacy.d.ts';
  const text = '/** @deprecated since 26 */\ndeclare function legacy(): void;';
  const declaration = {
    symbolId: 'api-legacy',
    relativePath: 'api/@ohos.legacy.d.ts',
    file: parserFile,
    line: 2,
    start: text.indexOf('declare'),
    name: 'legacy',
    owner: '',
    kind: 'method',
    deprecatedSince: 26,
    replacementApi: null,
    declaration: 'declare function legacy(): void;',
  };
  const catalog = {
    declarations: [declaration],
    sourceFiles: new Map([[filesystemFile, { fileName: parserFile, text }]]),
  };
  const rule = {
    ruleId: 'deprecated-legacy',
    changeOperation: 'API_DEPRECATED',
    affectedApis: [{
      implementLanguage: 'typeScript',
      completePath: '/interface/sdk-js/api/@ohos.legacy.d.ts',
      className: 'unnamed',
      interfaceName: 'legacy',
      interfaceType: 'method',
    }],
  };

  const result = await auditDeprecationRules({}, [rule], catalog);

  assert.equal(result.targetSdkTagged, 1);
  assert.match(rule.replacementDeclaration, /@deprecated since 26/);
});

test('enriches deprecated rules with the target SDK useinstead declaration', { skip: !existsSync(parserPath) }, async () => {
  const sdkRoot = await mkdtemp(path.join(os.tmpdir(), 'scanner-deprecated-sdk-'));
  const declarationFile = path.join(sdkRoot, 'default', 'openharmony', 'ets', 'component', 'common.d.ts');
  await mkdir(path.dirname(declarationFile), { recursive: true });
  await writeFile(declarationFile, `/**
 * Returns the context.
 * @deprecated since 18
 * @useinstead ohos.arkui.UIContext.UIContext#getHostContext
 */
declare function getContext(component?: Object): Context;
`);
  const rule = {
    ruleId: 'deprecated-get-context',
    changeOperation: 'API_DEPRECATED',
    affectedApis: [{
      implementLanguage: 'typeScript',
      completePath: '/interface/sdk-js/api/@internal/component/ets/common.d.ts',
      interfaceName: 'getContext',
      methodDefinition: 'declare function getContext(component?: Object): Context;',
    }],
  };

  const result = await auditDeprecationRules({ sdkRoot, parserPath }, [rule]);

  assert.equal(result.targetSdkTagged, 1);
  assert.equal(result.replacementCount, 1);
  assert.equal(rule.replacementApi, 'ohos.arkui.UIContext.UIContext#getHostContext');
  assert.equal(rule.replacementSource, `${await realpath(declarationFile)}:6`);
  assert.match(rule.replacementDeclaration, /@useinstead[\s\S]*declare function getContext/);
});

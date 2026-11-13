import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { rm } from 'node:fs/promises';
import { compileRules } from '../core/rules.mjs';
import { selectScanRules, createRunOutputDirectory } from '../core/cli.mjs';
import { assertUpgradeRange } from '../../shared/platform/version.mjs';
import { normalizeFinding } from '../core/scan-runner.mjs';

test('upgrade only uses plugin rules, keeps no-adaptation hits and never parses additional API diff or deprecated guidance', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'scanner-upgrade-')),resource=path.join(root,'resources'),refs=path.join(root,'references');
  await mkdir(resource);await mkdir(refs);await mkdir(path.join(refs,'API变更清单'));
  await writeFile(path.join(refs,'guide.md'),'---\nsource: https://example.test/change\n---\n\n## 测试行为\n\n**适配指导**\n\n无需适配。\n');
  await writeFile(path.join(refs,'API变更清单','bad.md'),'| 不支持的操作 | 无法解析 | 无法解析 | missing.d.ts |\n');
  const entry={affectedApis:[{implementLanguage:'typescript',methodDefinition:'api(): void',className:'global',completePath:'api',interfaceType:'method',interfaceName:'api'}],
    interfaceChanges:{id:'1',changeTitle:'测试行为',changeType:'接口行为变更',apiEffectiveVersion:'NOT_ISOLATED',sdkVersion:'5.0.2(14) Release',apiVersion:'14'}};
  await writeFile(path.join(resource,'HarmonyOS_5.0.2(14)_Release.json'),JSON.stringify([entry,{...entry,interfaceChanges:{...entry.interfaceChanges,id:'2',changeTitle:'没有文档的废弃项',changeType:'接口废弃变更'}}]));
  const result=await compileRules({toolchain:{apiChangeResourceRoot:resource},referenceRoot:refs,range:assertUpgradeRange(13,14),mode:'upgrade'});
  assert.equal(result.rules.length,1);assert.equal(result.rules[0].provider,'DEVECO');
  assert.equal(result.rules[0].reportDisposition,'REQUIRES_REVIEW');assert.equal(result.rules[0].filterReason,null);
  assert.deepEqual(selectScanRules([...result.rules,{provider:'UNSUPPORTED',changeType:'API Definition Change'},{provider:'DEVECO',changeType:'Deprecated API'}],'upgrade'),result.rules);
});

test('API12 baselines need no deleted source and from=12 still includes API13 changes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-api13-中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resource = path.join(root, 'resources'), refs = path.join(root, 'changelogs');
  await mkdir(resource); await mkdir(path.join(refs, '5.0.1(13)'), { recursive: true });
  await writeFile(path.join(refs, '5.0.1(13)', 'release-os-api-behavior-changes.md'),
    '## API13变更\n**适配指导**\n检查真实调用。\n');
  const entry = (id, version, title) => ({
    affectedApis: [{ implementLanguage: 'typescript', interfaceType: 'method', interfaceName: 'api' }],
    interfaceChanges: { id, changeTitle: title, changeType: '接口行为变更',
      apiEffectiveVersion: 'NOT_ISOLATED', sdkVersion: version },
  });
  await writeFile(path.join(resource, 'HarmonyOS_5.0.0(12)_Release.json'),
    JSON.stringify([entry('baseline', '5.0.0(12) Release', '已删除的API12变更')]));
  await writeFile(path.join(resource, 'HarmonyOS_5.0.1(13)_Release.json'),
    JSON.stringify([entry('api13', '5.0.1(13) Release', 'API13变更')]));
  for (const from of [12, '5.0.0(12) Beta3']) {
    const range = assertUpgradeRange(from, 13);
    const result = await compileRules({ toolchain: { apiChangeResourceRoot: resource }, referenceRoot: refs, range, mode: 'upgrade' });
    assert.equal(result.coverage.status, 'COMPLETE');
    assert.deepEqual(result.rules.map(rule => rule.ruleId), ['api13']);
    const baselineCount = typeof from === 'number' ? 0 : 1;
    assert.equal(result.coverage.behaviorBaseline.excludedRuleCount, baselineCount);
    assert.deepEqual(result.coverage.behaviorBaseline, { apiLevel: 12, policy: 'ALREADY_ADAPTED',
      reason: 'BEHAVIOR_BASELINE_ALREADY_ADAPTED', excludedRuleCount: baselineCount });
  }
});

test('concurrent timestamp output allocation never shares a directory',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'upgrade-output-'));
  const results=await Promise.all([createRunOutputDirectory(root),createRunOutputDirectory(root)]);
  assert.notEqual(results[0].directory,results[1].directory);
});

test('upgrade preserves plugin columns to distinguish same-line occurrences',()=>{
  const rule={ruleId:'r',title:'调用变更',changedInSdk:'5.0.2(14)',url:'https://example.test/change',changeType:'API Behavior Change',sourceReference:'doc.md:1'};
  const findings=[1,12].map(Column=>normalizeFinding({'Api Definition':'api()','Code Location':'entry/A.ets:1',Language:'ArkTS',Column},rule,null,'upgrade'));
  assert.deepEqual(findings.map(finding=>finding.Column),[1,12]);
});

test('official entry links resolve by identity and unique source; supplied links survive normalization', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'scanner-links-')),resource=path.join(root,'resources'),refs=path.join(root,'references');
  await mkdir(resource);await mkdir(path.join(refs,'5.0.2(14)'),{recursive:true});
  const guide=path.join(refs,'5.0.2(14)/guide.md'), overview=path.join(refs,'5.0.2(14)/overview.md');
  await writeFile(guide,'---\nsource: https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/test\n---\n## 文档标题\n**适配指导**\n需核对调用。\n');
  const entry={affectedApis:[{implementLanguage:'typescript',methodDefinition:'api(): void',interfaceType:'method',interfaceName:'api'}],
    interfaceChanges:{id:'CH123',changeTitle:'文档标题',changeType:'接口行为变更',apiEffectiveVersion:'NOT_ISOLATED',sdkVersion:'5.0.2(14) Release',apiVersion:'14'}};
  await writeFile(path.join(resource,'HarmonyOS_5.0.2(14)_Release.json'),JSON.stringify([entry]));
  const load=async()=> (await compileRules({toolchain:{apiChangeResourceRoot:resource},referenceRoot:refs,range:assertUpgradeRange(13,14),mode:'upgrade'})).rules[0];
  await writeFile(overview,'| [另一个标题](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/test#ch123) |\n');
  let rule=await load();assert.equal(rule.url,'https://developer.huawei.com/consumer/cn/doc/doccenter-release-notes/test#ch123');
  assert.equal(rule.documentLink.source,'OFFICIAL_OVERVIEW');
  const original='https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/test/#scan-fake';
  const finding=normalizeFinding({Title:`=HYPERLINK("${original}","原始标题")`,'Code Location':'entry/A.ts:1'},rule,null,'upgrade');
  assert.equal(finding.Title,`=HYPERLINK("${rule.url}","文档标题")`);assert.equal(finding.documentLink.rejectedReason,'SYNTHETIC_SCAN_ANCHOR');
  entry.interfaceChanges.url='test#ch123';await writeFile(path.join(resource,'HarmonyOS_5.0.2(14)_Release.json'),JSON.stringify([entry]));
  assert.equal((await load()).documentLink.source,'DEVECO_RULE');delete entry.interfaceChanges.url;
  await writeFile(path.join(resource,'HarmonyOS_5.0.2(14)_Release.json'),JSON.stringify([entry]));
  await writeFile(overview,'| [文档标题](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/test#one) | [文档标题](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/test#two) |\n');
  rule=await load();assert.equal(rule.url,'');assert.equal(rule.documentLink.reason,'AMBIGUOUS_DOCUMENT_LINK');
});

test('flattened documents resolve plugin aliases and official anchors from the directory index without overview files', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'scanner-flat-中文 ')),resource=path.join(root,'resources'),refs=path.join(root,'changelogs');
  await mkdir(resource);await mkdir(path.join(refs,'5.0.2(14)'),{recursive:true});
  const file=path.posix.join('5.0.2(14)','Beta1-正文.md');
  const page='https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/test';
  await writeFile(path.join(refs,file),`---\nsource: ${page}\n---\n## 文档标题\n**适配指导**\n需核对调用。\n`);
  await writeFile(path.join(refs,'changelogs-index.json'),JSON.stringify({schemaVersion:1,
    documents:[{path:file}],
    overview:[{version:'5.0.2(14)',row:`| [文档标题](${page}#ch123) | phone | 全部生效 |`},
      {version:'26.0.0',row:`| [文档标题](${page}#other-version) |`}]}));
  const entry={affectedApis:[{implementLanguage:'typescript',methodDefinition:'api(): void',interfaceType:'method',interfaceName:'api'}],
    interfaceChanges:{id:'CH123',changeTitle:'插件中的别名',changeType:'接口行为变更',apiEffectiveVersion:'NOT_ISOLATED',sdkVersion:'5.0.2(14) Release',apiVersion:'14'}};
  await writeFile(path.join(resource,'HarmonyOS_5.0.2(14)_Release.json'),JSON.stringify([entry]));
  const result=await compileRules({toolchain:{apiChangeResourceRoot:resource},referenceRoot:refs,range:assertUpgradeRange(13,14),mode:'upgrade'});
  assert.equal(result.rules.length,1);
  assert.equal(result.rules[0].sourceReference,`${file}:4`);
  assert.equal(result.rules[0].url,'https://developer.huawei.com/consumer/cn/doc/doccenter-release-notes/test#ch123');
  assert.equal(result.rules[0].documentLink.source,'OFFICIAL_OVERVIEW');
});

test('fallback plugin rule identities use the current source path when the plugin supplies no change id', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'scanner-flat-identity-')),resource=path.join(root,'resources');
  const before=path.join(root,'before'),after=path.join(root,'after');
  await mkdir(resource);
  const oldPath=path.posix.join('5.0.2(14)','OS平台能力','正文.md'),newPath=path.posix.join('5.0.2(14)','正文.md');
  const text='---\nsource: https://example.test/change\n---\n## 测试行为\n**适配指导**\n需核对调用。\n';
  for(const [refs,file]of [[before,oldPath],[after,newPath]]) {
    await mkdir(path.dirname(path.join(refs,file)),{recursive:true});await writeFile(path.join(refs,file),text);
  }
  await writeFile(path.join(after,'changelogs-index.json'),JSON.stringify({schemaVersion:1,
    documents:[{path:newPath}],overview:[]}));
  const entry={affectedApis:[{implementLanguage:'typescript',methodDefinition:'api(): void',interfaceType:'method',interfaceName:'api'}],
    interfaceChanges:{changeTitle:'测试行为',changeType:'接口行为变更',apiEffectiveVersion:'NOT_ISOLATED',sdkVersion:'5.0.2(14) Release',apiVersion:'14'}};
  await writeFile(path.join(resource,'HarmonyOS_5.0.2(14)_Release.json'),JSON.stringify([entry]));
  const load=referenceRoot=>compileRules({toolchain:{apiChangeResourceRoot:resource},referenceRoot,range:assertUpgradeRange(13,14),mode:'upgrade'});
  const original=(await load(before)).rules[0],moved=(await load(after)).rules[0];
  assert.notEqual(moved.ruleId,original.ruleId);assert.equal(moved.sourceReference,`${newPath}:4`);
  assert.equal((await load(after)).rules[0].ruleId,moved.ruleId);
});

test('each mode loads only its rule types before resolving unrelated document headings', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'scanner-rule-modes-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const resource=path.join(root,'resources');await mkdir(resource);
  const types=['接口行为变更','视觉布局变更','UX交互行为变更','接口定义变更','接口废弃变更'];
  const entries=types.map((changeType,i)=>({affectedApis:[{implementLanguage:i===4?'c':'typescript',
    methodDefinition:'api(): void',interfaceType:'method',interfaceName:'api'}],
    interfaceChanges:{id:String(i),changeTitle:`标题${i}`,changeType,apiEffectiveVersion:'NOT_ISOLATED',
      sdkVersion:'26.0.0(26) Release',apiVersion:'26'}}));
  await writeFile(path.join(resource,'HarmonyOS_26.0.0(26)_Release.json'),JSON.stringify(entries));
  for(const mode of ['upgrade','deprecated']) {
    const referenceRoot = path.join(root,mode);
    if (mode === 'upgrade') {
      await mkdir(referenceRoot);
      await writeFile(path.join(referenceRoot,'guide.md'), types.slice(0,4)
        .flatMap((_,i) => [`## 标题${i}`, '**适配指导**', '需核对调用。']).join('\n'));
    }
    const result=await compileRules({toolchain:{apiChangeResourceRoot:resource},referenceRoot,range:assertUpgradeRange(24,26),mode});
    assert.equal(result.rules.length,mode==='upgrade'?4:1);
    assert.ok(result.rules.every(rule=>mode==='upgrade'?rule.changeType!=='Deprecated API':rule.changeType==='Deprecated API'));
    assert.equal(result.coverage.errorCount,0);
    assert.ok(!Object.hasOwn(result.coverage,'apiDiffRuleCount'));assert.ok(!Object.hasOwn(result.coverage,'operations'));
    if (mode === 'deprecated') {
      assert.equal(selectScanRules(result.rules, mode).length, 1);
      assert.equal(result.rules[0].sourceReference, path.join(resource, 'HarmonyOS_26.0.0(26)_Release.json'));
      assert.equal(result.rules[0].reportDisposition, 'REQUIRES_REVIEW');
      assert.equal(result.rules[0].filterReason, null);
    }
  }
});

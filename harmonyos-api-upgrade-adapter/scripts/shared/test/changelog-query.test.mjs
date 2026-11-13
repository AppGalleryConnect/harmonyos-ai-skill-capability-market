import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256 } from '../io/fs-utils.mjs';
import { loadQueryCatalog, queryChanges, resolveQueryVersion } from '../platform/changelog-catalog.mjs';
import { execute, renderQuery } from '../../changelog/cli.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const catalog=await loadQueryCatalog(path.join(root,'references','changelogs'));
test('queries the complete declared corpus and treats versions without entries as zero changes',()=>{
  const result=queryChanges(catalog,{from:'12',to:'26'});
  assert.equal(result.total,196);
  assert.equal(result.coverage.unknownChannelCount,7);
  assert.deepEqual(result.coverage.missingVersions,[]);
  assert.equal(new Set(result.entries.map(entry=>`${entry.document}:${entry.startLine}`)).size,196);
  assert.ok(result.entries.every(entry=>entry.endLine>=entry.startLine && entry.sourceUrl.startsWith('https://developer.huawei.com/')));
  assert.doesNotMatch(renderQuery(result),/未收录正文/);
  assert.match(renderQuery(result),/未推定为 Release/);
});
test('platform queries exclude the entire start platform, while single-version queries retain all channels',()=>{
  const result=queryChanges(catalog,{from:'13',to:'20'});
  assert.equal(result.total,123);
  assert.ok(result.entries.every(entry=>entry.apiLevel>13 && entry.apiLevel<=20));
  assert.equal(queryChanges(catalog,{version:'18'}).total,26);
  assert.ok(queryChanges(catalog,{version:'18'}).entries.some(entry=>entry.title.includes('按钮默认值')));
  assert.ok(queryChanges(catalog,{version:'14'}).entries.every(entry=>entry.channel==='Beta1'));
  assert.equal(queryChanges(catalog,{version:'24'}).total,0);
  const release=queryChanges(catalog,{version:'6.0.0 Release'});
  assert.equal(release.total,0);assert.deepEqual(release.coverage.missingStages,[]);
});
test('precise ranges retain channel boundaries and only leave uncertain boundary entries unplaced',()=>{
  const exact=queryChanges(catalog,{from:'5.0.1 Beta3',to:'5.0.1 Release'});
  assert.ok(exact.total>0);assert.ok(exact.entries.every(entry=>entry.channel==='Release'));
  const boundary=queryChanges(catalog,{from:'6.1.0 Beta1',to:'26.0.0 Release'});
  assert.equal(boundary.unplacedEntries.length,7);
  const interior=queryChanges(catalog,{from:'6.0.0 Beta1',to:'26.0.0 Release'});
  assert.equal(interior.unplacedEntries.length,0);
  assert.equal(interior.entries.filter(entry=>entry.apiLevel===23).length,7);
  const upperRelease=queryChanges(catalog,{from:'6.0.0 Beta1',to:'6.1.0 Release'});
  assert.equal(upperRelease.entries.filter(entry=>entry.apiLevel===23).length,7);assert.equal(upperRelease.unplacedEntries.length,0);
  const lowerRelease=queryChanges(catalog,{from:'6.1.0 Release',to:'26.0.0 Release'});
  assert.equal(lowerRelease.entries.filter(entry=>entry.apiLevel===23).length,0);assert.equal(lowerRelease.unplacedEntries.length,0);
  assert.equal(queryChanges(catalog,{version:'6.1.0 Beta1'}).unplacedEntries.length,7);
  const empty=queryChanges(catalog,{from:'6.1.0 Beta1',to:'6.1.0 Beta1'});
  assert.equal(empty.total,0);assert.deepEqual(empty.unplacedEntries,[]);
});
test('version ambiguity, descending ranges, conflicting arguments and unknown Kits fail explicitly',async()=>{
  assert.equal(resolveQueryVersion('26.0').apiLevel,26);
  assert.equal(resolveQueryVersion('7.0.0(26)').platformVersion,'26.0.0');
  assert.equal(resolveQueryVersion('HarmonyOS_26.0.0(26)_Beta2').channel,'Beta2');
  assert.equal(queryChanges(catalog,{from:'6.1.0(23)_Beta1',to:'26.0.0(26)_Release'}).unplacedEntries.length,7);
  assert.throws(()=>resolveQueryVersion('5.0'),/候选/);
  assert.throws(()=>resolveQueryVersion('25'),/版本/);
  assert.throws(()=>resolveQueryVersion('20 Beta4'),/未核实的版本阶段/);
  assert.throws(()=>resolveQueryVersion('5.0.1(20)'),/未核实/);
  for(const options of [{from:'20',to:'13'},{from:'13',to:'20 Release'},{version:'18',from:'13'},{from:'13'},
    {version:'18',kit:'imaginary'}])assert.throws(()=>queryChanges(catalog,options));
  const filtered=queryChanges(catalog,{version:'18',kit:'UX 视觉/交互'});
  assert.ok(filtered.total>0);assert.ok(filtered.entries.every(entry=>entry.category==='ux'));
  await assert.rejects(execute(['query','--from','13','--to','20','--output','unexpected']),/未知/);
});

async function fixture(t,{crlf=false}={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'查询 中文 &-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const refs=path.join(dir,'changelogs'), rel=path.posix.join('5.1.0(18)','ux-style-and-effect-changes.md');
  await mkdir(path.join(refs,'5.1.0(18)'),{recursive:true});
  const text='---\nsource: https://developer.huawei.com/doc/test\n---\n# 文档\n## 一|标题\n内容\n```ts\n## 假标题\n```\n~~~md\n## 另一假标题\n~~~\n## 二标题\n正文\n';
  await writeFile(path.join(refs,rel),crlf?'\ufeff'+text.replaceAll('\n','\r\n'):text);
  const index={schemaVersion:1,documents:[{path:rel,sha256:sha256(text)}],overview:[{version:'5.1.0(18)',
    row:'| [一标题](https://developer.huawei.com/doc/test#section1) | 5.1.0(18) Release |'}]};
  await writeFile(path.join(refs,'changelogs-index.json'),JSON.stringify(index));
  return {dir,refs,rel,text,index};
}
test('entry boundaries ignore fenced headings, verify normalized hashes and reject changed sources',async t=>{
  const f=await fixture(t,{crlf:true}), parsed=await loadQueryCatalog(f.refs);
  assert.equal(parsed.entries.length,2);assert.equal(parsed.entries[0].endLine,12);
  assert.equal(parsed.entries[0].channel,'Release');
  assert.match(renderQuery(queryChanges(parsed,{version:'18'})),/一&#124;标题/);
  await writeFile(path.join(f.refs,f.rel),f.text+'change');
  await assert.rejects(loadQueryCatalog(f.refs),/哈希/);
});
test('catalog refuses a physical source outside the reference root',async t=>{
  const f=await fixture(t), outside=path.join(f.dir,'outside');await mkdir(outside);
  await writeFile(path.join(outside,path.basename(f.rel)),f.text);
  await rm(path.join(f.refs,'5.1.0(18)'),{recursive:true});
  await symlink(outside,path.join(f.refs,'5.1.0(18)'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(loadQueryCatalog(f.refs),/物理路径越界/);
});
test('conflicting official channel evidence remains unknown rather than guessing Release',async t=>{
  const f=await fixture(t);
  f.index.overview.push({...f.index.overview[0],row:f.index.overview[0].row.replace('Release','Beta1')});
  await writeFile(path.join(f.refs,'changelogs-index.json'),JSON.stringify(f.index));
  const parsed=await loadQueryCatalog(f.refs);assert.equal(parsed.entries[0].channel,null);assert.equal(parsed.warnings.length,1);
});
test('installed CLI works from another cwd and leaves it empty',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'query-cwd-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const run=spawnSync(process.execPath,[path.join(root,'scripts','changelog','cli.mjs'),'query','--version','18','--format','json'],{cwd:dir,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.total,26);
  assert.deepEqual(await readdir(dir),[]);
  const listed=await execute(['list','--format','json']);
  assert.ok(listed.result.versions.some(item=>item.apiLevel===12 && item.coverage==='NO_CHANGES'));
  assert.ok(listed.result.versions.some(item=>item.apiLevel===20 && item.channel==='Release' && item.coverage==='NO_CHANGES'));
});

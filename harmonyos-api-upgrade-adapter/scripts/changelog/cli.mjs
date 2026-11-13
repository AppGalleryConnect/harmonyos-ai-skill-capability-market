#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs, requireString } from '../shared/format/args.mjs';
import { isMainModule } from '../shared/platform/entrypoint.mjs';
import { loadQueryCatalog, listQueryVersions, queryChanges } from '../shared/platform/changelog-catalog.mjs';

const referenceRoot=fileURLToPath(new URL('../../references/changelogs/',import.meta.url));
const help=`只读查询内置官方快照（不是工程扫描）
  list [--format markdown|json]
  query --from <版本/API等级> --to <版本/API等级> [--kit <Kit>] [--format markdown|json]
  query --version <版本/API等级> [--kit <Kit>] [--format markdown|json]
纯平台区间为 (from,to]；阶段区间两端均须明确通道。无条目表示无声明行为变更；阶段归属未定仍单列。`;
const cell=value=>String(value??'').replaceAll('|','&#124;').replace(/[\r\n]+/g,' ');
const table=(headers,rows)=>'| '+headers.join(' | ')+' |\n| '+headers.map(()=>'---').join(' | ')+' |\n'
  +rows.map(row=>'| '+row.map(cell).join(' | ')+' |').join('\n');

export function renderQuery(result) {
  if(result.versions)return '# 内置版本与正文覆盖\n\n'+table(['平台版本','API','通道','条目数','覆盖'],result.versions.map(row=>
    [row.platformVersion,row.apiLevel,row.channel??'未标明',row.count,row.coverage==='NO_CHANGES'?'无声明行为变更':row.coverage==='CHANNEL_UNRESOLVED'?'阶段归属未定':'官网声明变更']))
    +'\n\n依据仓库完整收录的官网变更声明；不代表工程命中。\n';
  const summary=new Map();
  for(const entry of result.entries)summary.set(entry.version,(summary.get(entry.version)??0)+1);
  let text=`# 版本变更查询\n\n范围：${result.from} → ${result.to}（${result.interval}）。内置官方快照，不能替代工程扫描。\n\n`
    +table(['版本/阶段','条目数'],[...summary])+'\n\n确定包含 **'+result.total+'** 项变更。\n\n'
    +table(['变更版本','Kit','标题','官方文档'],result.entries.map(entry=>[entry.version,entry.kit,entry.title,entry.sourceUrl?`[官网](${entry.officialEntryUrl ?? entry.sourceUrl})`:'未提供']))+'\n';
  if(result.coverage.unknownChannelCount)text+='\n包含 '+result.coverage.unknownChannelCount+' 项通道未标明的条目，未推定为 Release。\n';
  if(result.unplacedEntries.length)text+='\n## 区间归属未定\n\n'+table(['版本','标题','文档'],result.unplacedEntries.map(entry=>[entry.version,entry.title,entry.document]))+'\n';
  for(const warning of result.warnings)text+='\n说明：'+warning+'。\n';
  return text;
}

export async function execute(argv,{root=referenceRoot}={}) {
  const [command,...rest]=argv;
  if(!command || ['help','--help','-h'].includes(command))return {format:'markdown',usage:help};
  if(!['list','query'].includes(command))throw new Error(`未知命令：${command}`);
  const args=parseArgs(rest),allowed=command==='list'?['_','format']:['_','format','from','to','version','kit'];
  if(args._.length || Object.keys(args).some(key=>!allowed.includes(key)))throw new Error('存在未知查询参数');
  for(const key of Object.keys(args).filter(key=>key!=='_'))requireString(args,key);
  const format=args.format??'markdown';
  if(!['markdown','json'].includes(format))throw new Error('--format 必须为 markdown 或 json');
  const catalog=await loadQueryCatalog(root);
  const result=command==='list'?{scope:'LOCAL_OFFICIAL_SNAPSHOT',versions:listQueryVersions(catalog)}
    :queryChanges(catalog,{from:args.from,to:args.to,version:args.version,kit:args.kit});
  return {format,result};
}
if(isMainModule(import.meta.url))execute(process.argv.slice(2)).then(({format,result,usage})=>
  console.log(usage??(format==='json'?JSON.stringify({ok:true,result},null,2):renderQuery(result))))
  .catch(error=>{console.error(JSON.stringify({ok:false,error:{message:error.message}}));process.exitCode=1;});

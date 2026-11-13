import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadChangelogIndex } from './changelog-index.mjs';
import { normalizeDocumentUrl } from './document-links.mjs';
import { relativePathInside } from './paths.mjs';
import { sha256 } from '../io/fs-utils.mjs';
import { API_PLATFORM, parseHarmonyVersion, compareHarmonyVersions, compareConfigurationVersions } from './version.mjs';
import { bundledScanVersions } from './scan-versions.mjs';

const phasePattern = /\s+(Beta\d+|Release|Canary\d+)$/i;
const label = value => value[0].toUpperCase() + value.slice(1).toLowerCase();
const platforms = [...API_PLATFORM].map(([apiLevel, platformVersion]) => ({apiLevel, platformVersion}));
const knownStages = ['5.0.0(12) Release',...bundledScanVersions];

export function resolveQueryVersion(input, catalog = {entries:[]}) {
  const raw = String(input).trim().replace(/^HarmonyOS_/i,'').replaceAll('_',' '), phase = raw.match(phasePattern)?.[1];
  const base = raw.replace(phasePattern, '');
  let version;
  try { version = parseHarmonyVersion(base); } catch { /* Try a unique platform prefix. */ }
  if (!version) {
    const candidates = platforms.filter(item => item.platformVersion.startsWith(base));
    if (candidates.length !== 1) throw new Error(`无法唯一识别版本 ${raw}；候选：${(candidates.length?candidates:platforms).map(item=>item.platformVersion).join('、')}`);
    version = parseHarmonyVersion(candidates[0].platformVersion);
  }
  if (!platforms.some(item=>item.platformVersion===version.platformVersion && item.apiLevel===version.apiLevel))
    throw new Error(`未核实的版本：${raw}`);
  const channel = phase ? label(phase) : null;
  const exact=`${version.platformVersion}(${version.apiLevel})${channel?' '+channel:''}`;
  if(channel && ![...knownStages,...catalog.entries.filter(entry=>entry.channel).map(entry=>entry.version)]
    .some(value=>compareHarmonyVersions(value,exact)===0))throw new Error(`未核实的版本阶段：${raw}；请使用 list 查看内置资料，并核对精确阶段`);
  return {platformVersion:version.platformVersion, apiLevel:version.apiLevel, channel,
    version:exact};
}

export async function loadQueryCatalog(referenceRoot, index, { includeText = false } = {}) {
  index ??= await loadChangelogIndex(referenceRoot);
  if (!index.documents.length) throw new Error('缺少官方 changelog 索引或正文清单');
  const root = await realpath(referenceRoot);
  const entries = [], warnings = [], snapshots = [];
  for (const document of index.documents) {
    const file = path.join(root, ...document.path.split('/'));
    if (relativePathInside(root,await realpath(file))===null) throw new Error(`官方正文物理路径越界：${document.path}`);
    const bytes = await readFile(file);
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r\n?/g,'\n');
    if (sha256(text)!==document.sha256) throw new Error(`官方正文哈希不一致：${document.path}`);
    if (includeText) snapshots.push({file,hash:sha256(bytes)});
    const lines=text.split('\n'), sourceUrl=text.match(/^---\n[\s\S]*?^source:\s*(https?:\/\/\S+)/m)?.[1] ?? '';
    const version=resolveQueryVersion(document.path.split('/')[0]);
    const category=path.basename(file).includes('ux-style')?'ux':'os';
    const filePhase=path.basename(file).match(/^(beta\d+|release|canary\d+)-/i)?.[1];
    const overviewPhases=new Set();
    for (const record of index.overview) {
      if (record.version!==document.path.split('/')[0]) continue;
      const matches=[...record.row.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g)];
      if (!matches.some(match=>normalizeDocumentUrl(match[1],{fragment:false})===normalizeDocumentUrl(sourceUrl,{fragment:false}))) continue;
      const cell=record.row.split('|').map(value=>value.trim()).find(value=>/^\d+\.\d+\.\d+/.test(value));
      const phase=cell?.match(phasePattern)?.[1];
      if (phase) overviewPhases.add(label(phase));
    }
    let channel=filePhase?label(filePhase):overviewPhases.size===1?[...overviewPhases][0]:null;
    if (overviewPhases.size>1 || channel && [...overviewPhases].some(phase=>phase!==channel)) {
      channel=null; warnings.push(`通道证据冲突：${document.path}`);
    }
    const headings=[]; let fence=null, kit='';
    for (const [i,line] of lines.entries()) {
      const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) { if(marker && marker[1][0]===fence[0] && marker[1].length>=fence.length && line.trim()===marker[1]) fence=null; continue; }
      if (marker) {fence=marker[1];continue;}
      const heading=line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
      if (!heading) continue;
      const level=heading[1].length;
      if(level===2) kit=heading[2];
      headings.push({startLine:i+1,level,title:heading[2],kit});
    }
    for(const [i,heading] of headings.entries()) {
      if(heading.level!==(category==='ux'?2:3))continue;
      const endLine=(headings.slice(i+1).find(next=>next.level<=heading.level)?.startLine ?? lines.length+1)-1;
      const titleKey=value=>String(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
      const urls=[...new Set(index.overview.filter(record=>record.version===document.path.split('/')[0])
        .flatMap(record=>[...record.row.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)])
        .filter(match=>titleKey(match[1])===titleKey(heading.title)
          && normalizeDocumentUrl(match[2],{fragment:false})===normalizeDocumentUrl(sourceUrl,{fragment:false})).map(match=>match[2]))];
      const changeIds=[...new Set((urls.length===1?urls:[]).flatMap(url=>{
        const id=decodeURIComponent(new URL(url).hash.slice(1)).toLowerCase();
        return id?[id,id.replace(/^section/,'')]:[];
      }))];
      entries.push({title:heading.title,kit:category==='ux'?'UX 视觉/交互':heading.kit,category,
        document:document.path,startLine:heading.startLine,endLine,documentSha256:document.sha256,sourceUrl,
        officialEntryUrl:urls.length===1?urls[0]:null,changeIds,
        ...(includeText ? {text:lines.slice(heading.startLine,endLine).join('\n')} : {}),
        ...version,channel,version:`${version.platformVersion}(${version.apiLevel})${channel?' '+channel:''}`});
    }
  }
  entries.sort((a,b)=>compareConfigurationVersions(a.version,b.version)
    || (a.channel && b.channel?compareHarmonyVersions(a.version,b.version):a.channel?-1:b.channel?1:0)
    || a.document.localeCompare(b.document) || a.startLine-b.startLine);
  return {entries,warnings,indexSource:index.source,...(includeText ? {snapshots} : {})};
}

export function listQueryVersions(catalog) {
  return platforms.flatMap(platform=>{
    const entries=catalog.entries.filter(entry=>entry.platformVersion===platform.platformVersion);
    const channels=[...new Set([...knownStages.filter(value=>parseHarmonyVersion(value).platformVersion===platform.platformVersion)
      .map(value=>value.match(phasePattern)[1]),...entries.map(entry=>entry.channel)])];
    return (channels.length?channels:[null]).map(channel=>({...platform,channel,
      count:entries.filter(entry=>entry.channel===channel).length,
      coverage:entries.some(entry=>entry.channel===channel)?'LOCAL_SNAPSHOT'
        :entries.some(entry=>!entry.channel)?'CHANNEL_UNRESOLVED':'NO_CHANGES'}));
  });
}

export function queryChanges(catalog,{from,to,version,kit}={}) {
  if (version!==undefined ? from!==undefined || to!==undefined : from===undefined || to===undefined)
    throw new Error('使用 --from/--to 或 --version，不能混用');
  const start=resolveQueryVersion(version ?? from,catalog), end=resolveQueryVersion(version ?? to,catalog);
  if(version===undefined && Boolean(start.channel)!==Boolean(end.channel)) throw new Error('阶段区间的两端都必须明确 Beta/Release 通道');
  const compare=start.channel?compareHarmonyVersions:compareConfigurationVersions;
  if(compare(start.version,end.version)>0)throw new Error('查询起点不能晚于终点');
  const kits=[...new Set(catalog.entries.map(entry=>entry.kit))];
  const selectedKit=kit===undefined?null:kits.find(value=>value.toLowerCase()===String(kit).trim().toLowerCase());
  if(kit!==undefined && !selectedKit)throw new Error(`未知 Kit：${kit}；可用值：${kits.join('、')}`);
  const entries=[],unplacedEntries=[];
  for(const entry of catalog.entries) {
    if(version===undefined && compare(start.version,end.version)===0)continue;
    if(selectedKit && entry.kit!==selectedKit)continue;
    const lower=compareConfigurationVersions(entry.version,start.version), upper=compareConfigurationVersions(entry.version,end.version);
    if(version!==undefined ? lower!==0 : lower<0 || upper>0)continue;
    if(!start.channel) {
      if(version!==undefined || lower>0 && upper<=0)entries.push(entry);
    } else if(!entry.channel) {
      if(version===undefined && lower===0 && start.channel==='Release')continue;
      if(version===undefined && lower>0 && (upper<0 || upper===0 && end.channel==='Release'))entries.push(entry);
      else unplacedEntries.push(entry);
    } else if(version!==undefined ? compare(entry.version,start.version)===0
      : compare(entry.version,start.version)>0 && compare(entry.version,end.version)<=0)entries.push(entry);
  }
  // The bundled corpus is the complete declared change set. Missing index files
  // fail during loading; an absent version/stage is not evidence of missing data.
  const missingVersions=[],missingStages=[];
  return {scope:'LOCAL_OFFICIAL_SNAPSHOT',interval:version!==undefined?'SINGLE_VERSION':'(from,to]',from:start.version,to:end.version,
    kit:selectedKit,total:entries.length,entries,unplacedEntries,coverage:{missingVersions,missingStages,unknownChannelCount:entries.filter(entry=>!entry.channel).length},
    warnings:[...catalog.warnings,
      ...(unplacedEntries.length?['部分条目缺少通道证据，无法确定区间归属']:[])]};
}

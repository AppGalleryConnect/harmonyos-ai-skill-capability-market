import { compareHarmonyVersions as compareVersions } from '../../shared/platform/version.mjs';
import { compareConfigurationVersions, canonicalHarmonyVersion } from '../../shared/platform/version.mjs';
import { loadQueryCatalog, queryChanges } from '../../shared/platform/changelog-catalog.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../shared/io/fs-utils.mjs';

export function compareRulePackEntries(query, inventory) {
  const compare = entry => {
    const sourceReference = `${entry.document}:${entry.startLine}`;
    const sameVersion = item => (entry.channel ? compareVersions : compareConfigurationVersions)(item.changedInSdk, entry.version) === 0;
    const sameId = item => {
      const id=String(item.changeId).toLowerCase();
      return entry.changeIds?.includes(id) && query.entries.filter(other=>other.changeIds?.includes(id)
        && (other.channel?compareVersions:compareConfigurationVersions)(item.changedInSdk,other.version)===0).length===1;
    };
    const matches = inventory.filter(item => sameVersion(item) && (item.sourceReference === sourceReference || !item.sourceReference && sameId(item)));
    const uncertain = inventory.filter(item => !item.sourceReference && sameVersion(item)
      && (item.candidates?.includes(sourceReference) || item.title===entry.title || !entry.changeIds?.length && !item.candidates?.length));
    const status = matches.length ? matches.every(item => item.changeType === 'Deprecated API') ? 'EXCLUDED_DEPRECATED'
      : matches.some(item => item.hasAffectedApis) ? 'RULE_AVAILABLE' : 'RULE_PRESENT_NO_STATIC_APIS'
      : uncertain.length ? 'MAPPING_UNRESOLVED' : 'MISSING_RULE';
    return { ...entry,sourceUrl:entry.officialEntryUrl ?? entry.sourceUrl,
      id: `official-${sha256(JSON.stringify([sourceReference,entry.version])).slice(0,16)}`,
      sourceReference, changedInSdk: entry.version, status,
      ruleIds: matches.map(item => String(item.changeId ?? '')).filter(Boolean) };
  };
  const entries = query.entries.map(compare);
  entries.push(...query.unplacedEntries.map(entry => ({...compare(entry),status:'INTERVAL_UNRESOLVED'})));
  const missing = entries.filter(entry => entry.status === 'MISSING_RULE');
  const unresolved = entries.filter(entry => ['MAPPING_UNRESOLVED','INTERVAL_UNRESOLVED'].includes(entry.status));
  return { status: missing.length || unresolved.length ? 'INCOMPLETE' : 'COMPLETE', interval:query.interval,
    from:query.from,to:query.to,officialChangeCount:query.total,entries,missing,missingRuleCount:missing.length,
    unresolvedCount:unresolved.length,warnings:query.warnings };
}

export async function prepareOfficialComparison({toolchain,referenceRoot,range,compiled}) {
  const catalog = await loadQueryCatalog(referenceRoot, compiled.changelogIndex);
  const query = queryChanges(catalog, {
    from:canonicalHarmonyVersion(range.start),to:canonicalHarmonyVersion(range.end),
  });
  const comparison = compareRulePackEntries(query,compiled.ruleInventory);
  const sources = [...compiled.rulePackSources, catalog.indexSource];
  for (const entry of new Map([...query.entries,...query.unplacedEntries].map(entry=>[entry.document,entry])).values()) {
    const file = path.join(referenceRoot,...entry.document.split('/')), bytes = await readFile(file);
    if (sha256(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r\n?/g,'\n')) !== entry.documentSha256)
      throw new Error(`官方正文在比对期间变化：${file}`);
    sources.push({file,hash:sha256(bytes)});
  }
  return {...comparison,sources,rulePack:{version:toolchain.productInfo?.version ?? null,
    resources:toolchain.apiChangeResourceRoot,archive:toolchain.apiChangeResourceArchive}};
}

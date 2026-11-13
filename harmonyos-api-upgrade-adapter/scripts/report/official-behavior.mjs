import { loadChangelogIndex } from '../shared/platform/changelog-index.mjs';
import { loadQueryCatalog } from '../shared/platform/changelog-catalog.mjs';
import { compareConfigurationVersions, compareHarmonyVersions } from '../shared/platform/version.mjs';

const titleKey = value => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const sameVersion = (entry, version, allowUnknownChannel = false) => {
  try {
    const compare = allowUnknownChannel && !entry.channel ? compareConfigurationVersions : compareHarmonyVersions;
    return compare(entry.version, version) === 0;
  }
  catch { return false; }
};

function officialFields(section) {
  const fields = new Map(), prose = [];
  let excerpt, fence, scenario, inline = false;
  for (const line of section.split('\n')) {
    const marker = line.match(/^\s*([\x60~])\1{2,}/)?.[1];
    if (fence || marker) {
      excerpt?.push(line);
      if (marker && (!fence || marker === fence)) fence = fence ? null : marker;
      continue;
    }
    const heading = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{3,6}\s+)?(?:\*\*)?(变更前|变更后|变更影响|变更原因|说明|起始\s*API\s*Level|变更的接口\/组件|适配指导)(?:\*\*)?\s*(?:[：:]\s*(?:\*\*)?(.*)|$)/i);
    const scene = line.match(/^\s*\*\*(场景[^*\n]+)\*\*\s*$/)?.[1];
    if (heading) {
      const field = heading[1];
      if (/^(?:起始\s*API\s*Level|变更的接口\/组件|适配指导)$/i.test(field)) break;
      excerpt = null;
      inline = Boolean(heading[2]);
      if (/^变更[前后]$/.test(field)) {
        excerpt = [];
        if (scenario) excerpt.push(scenario);
        if (heading[2]) excerpt.push(heading[2]);
        if (!fields.has(field)) fields.set(field, []);
        fields.get(field).push(excerpt);
      }
    } else if (scene) {
      scenario = scene;
      excerpt = null;
    } else if (excerpt && (!inline || line.trim() || /[:：]$/.test(excerpt.at(-1)?.trim() ?? ''))) {
      if (!/^\s*!\[/.test(line)) excerpt.push(line);
      else if (inline) excerpt = null;
    } else {
      excerpt = null;
    }
    prose.push(line);
  }
  const get = name => fields.get(name)?.map(lines => lines.join('\n').trim()).filter(Boolean).join('\n\n') || '';
  const before = get('变更前'), after = get('变更后');
  const leading = prose.join('\n');
  const thresholds = [...new Set([...leading.matchAll(/仅在[^。；\n]*?targetSdkVersion\s*(?:设置为\s*)?(?:大于等于|大于或等于|>=|≥)\s*(\d+(?:\.\d+){0,2}(?:\(\d+\))?)\s*时生效/gi)].map(match => match[1]))];
  const isolated = /已(?:做|进行)版本隔离/.test(leading) || thresholds.length > 0;
  const unisolated = /(?:未(?:做|进行|采用)|不(?:做|进行|涉及))版本隔离/.test(leading);
  let target = '官方未说明版本隔离';
  if (unisolated && !isolated) target = '未做版本隔离';
  if (isolated && !unisolated) target = thresholds.length === 1
    ? '官方已做版本隔离，仅在 targetSdkVersion ≥ ' + thresholds[0] + ' 时生效'
    : '官方已做版本隔离，生效门槛待核对';
  const comparisonTable = leading.match(/^\|[^\n]*变更前[^|\n]*\|[^\n]*变更后[^\n]*\n(?:\|[^\n]*(?:\n|$))+/m)?.[0].trim();
  return { before, after, comparisonTable, target };
}

export function createOfficialBehaviorReader(root) {
  let indexed;
  const catalogs = new Map();
  async function catalogFor(document) {
    indexed ??= loadChangelogIndex(root).catch(() => null);
    const index = await indexed;
    const indexedDocument = index?.documents.find(item => item.path === document);
    if (!indexedDocument) return null;
    if (!catalogs.has(document)) {
      catalogs.set(document, loadQueryCatalog(root, { ...index, documents: [indexedDocument] }, { includeText: true }).catch(() => null));
    }
    return catalogs.get(document);
  }
  return async (group, record, comparison) => {
    const mapped = (comparison?.entries ?? []).filter(entry => entry.ruleIds?.includes(group.ruleId)
      && sameVersion(entry, group.version, true));
    const references = [...new Set([group.sourceReference, ...mapped.map(entry => entry.sourceReference)]
      .filter(reference => /\.md:\d+$/.test(reference ?? '')))];
    const reference = references.length ? references.length === 1 && references[0] : record?.identity?.reference;
    const match = typeof reference === 'string' && reference.match(/^(.+\.md):(\d+)$/);
    if (!match) return null;
    const [, document, line] = match;
    const catalog = await catalogFor(document);
    const entry = catalog?.entries.find(item => item.startLine === Number(line) && sameVersion(item, group.version,
      mapped.some(candidate => candidate.sourceReference === reference && candidate.documentSha256 === item.documentSha256)));
    if (!entry || (!mapped.length && !group.titles.some(title => titleKey(title) === titleKey(entry.title)))) return null;
    return { ...officialFields(entry.text), url: entry.officialEntryUrl,
      snapshots: [catalog.indexSource, ...catalog.snapshots] };
  };
}

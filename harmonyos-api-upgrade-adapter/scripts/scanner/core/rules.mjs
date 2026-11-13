import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSdkCatalog, resolveRuleDeclarations } from './sdk-deprecations.mjs';
import { listFiles, portableRelative, sha256 } from '../../shared/io/fs-utils.mjs';
import { API_PLATFORM, canonicalHarmonyVersion as canonicalVersion, compareHarmonyVersions as compareVersions, devecoVersionName, parseVersion } from '../../shared/platform/version.mjs';
import { readZipTextEntries } from '../../shared/format/zip.mjs';
import { normalizeDocumentUrl, entryUrl } from '../../shared/platform/document-links.mjs';
import { loadChangelogIndex } from '../../shared/platform/changelog-index.mjs';
import { requireScanMode } from '../../shared/platform/scan-mode.mjs';

const CHANGE_TYPE_MAP = new Map([
  ['接口行为变更', ['API Behavior Change', 'API_BEHAVIOR']],
  ['接口行为变更（API变更）', ['API Behavior Change', 'API_BEHAVIOR']],
  ['UX视觉布局变更', ['UX Visual Layout Change', 'UX_VISUAL']],
  ['视觉布局变更', ['UX Visual Layout Change', 'UX_VISUAL']],
  ['UX交互行为变更', ['UX Interaction Behavior Change', 'UX_INTERACTION']],
  ['接口定义变更', ['API Definition Change', 'API_DEFINITION']],
  ['接口废弃变更', ['Deprecated API', 'API_DEPRECATED']],
]);

const BEHAVIOR_BASELINE_API_LEVEL = 12;
const BEHAVIOR_CHANGE_TYPES = new Set([
  'API Behavior Change',
  'UX Visual Layout Change',
  'UX Interaction Behavior Change',
]);
const BEHAVIOR_BASELINE_REASON = 'BEHAVIOR_BASELINE_ALREADY_ADAPTED';

const CHANGE_TITLE_OVERRIDES = new Map([
  ['CH2026042864213', '通过ohos.permission.READ_IMAGEVIDEO权限可读取的媒体库文件的范围变更'],
]);

function ruleId(parts) {
  return `rule-${sha256(parts.join('\u0000')).slice(0, 20)}`;
}

function normalizeTitle(value) {
  return String(value).toLowerCase().replaceAll('\\', '').replace(/[^\p{L}\p{N}]+/gu, '');
}

async function buildHeadingIndex(referenceRoot, changelogIndex) {
  const files = await listFiles(referenceRoot, (file) => file.endsWith('.md'));
  const byTitle = new Map();
  const byNormalizedTitle = new Map();
  const linkedTitlesByChangeId = new Map();
  const titlesBySourceReference = new Map();
  const documentSources = new Map();
  const links = [];
  for (const file of files) {
    const relative = portableRelative(referenceRoot, file);
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    documentSources.set(relative, lines.find(line => /^source:\s*https?:\/\//.test(line))?.replace(/^source:\s*/, '').trim());
    let fenced = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim().startsWith('```')) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const heading = lines[index].match(/^#{2,6}\s+(.+?)\s*$/);
      if (!heading) continue;
      titlesBySourceReference.set(`${relative}:${index + 1}`, heading[1]);
      const entries = byTitle.get(heading[1]) ?? [];
      entries.push(`${relative}:${index + 1}`);
      byTitle.set(heading[1], entries);
      const normalized = normalizeTitle(heading[1]);
      const normalizedEntries = byNormalizedTitle.get(normalized) ?? [];
      normalizedEntries.push(`${relative}:${index + 1}`);
      byNormalizedTitle.set(normalized, normalizedEntries);
    }
    for (const line of lines) {
      for (const match of line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)#]+#([^)]+))\)/g)) {
        const id = decodeURIComponent(match[3]).toLowerCase();
        links.push({ title: match[1], url: match[2], id, version: relative.split('/')[0] });
        const titles = linkedTitlesByChangeId.get(id) ?? [];
        titles.push(match[1]);
        linkedTitlesByChangeId.set(id, titles);
      }
    }
  }
  for (const record of changelogIndex.overview) {
    for (const match of record.row.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)#]+#([^)]+))\)/g)) {
      const id = decodeURIComponent(match[3]).toLowerCase();
      links.push({ title: match[1], url: match[2], id, version: record.version });
      const titles = linkedTitlesByChangeId.get(id) ?? [];
      titles.push(match[1]);
      linkedTitlesByChangeId.set(id, titles);
    }
  }
  return { byTitle, byNormalizedTitle, linkedTitlesByChangeId, titlesBySourceReference, documentSources, links };
}

function documentLink(change, sourceReference, index) {
  const file = sourceReference.replace(/:\d+$/, ''), versionRoot = file.split('/')[0];
  const page = normalizeDocumentUrl(index.documentSources.get(file), { fragment: false });
  const candidates = index.links.filter(link => link.version === versionRoot
    && normalizeDocumentUrl(link.url, { fragment: false }) === page);
  const byId = candidates.filter(link => link.id === String(change.id).toLowerCase());
  const heading = index.titlesBySourceReference.get(sourceReference);
  const matched = byId.length ? byId : candidates.filter(link => normalizeTitle(link.title) === normalizeTitle(heading ?? change.changeTitle));
  const urls = [...new Set(matched.map(link => entryUrl(link.url)).filter(Boolean))];
  let provided = null;
  try { provided = entryUrl(new URL(change.url, 'https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/').href); } catch { /* No plugin URL. */ }
  if (provided && (urls.length === 1 && provided === urls[0] || !urls.length
    && normalizeDocumentUrl(provided, { fragment: false }) === page
    && new URL(provided).hash.toLowerCase() === `#${String(change.id).toLowerCase()}`))
    return { url: provided, source: 'DEVECO_RULE' };
  return urls.length === 1 ? { url: urls[0], source: 'OFFICIAL_OVERVIEW' }
    : { url: '', source: null, reason: urls.length ? 'AMBIGUOUS_DOCUMENT_LINK' : 'DOCUMENT_LINK_NOT_FOUND' };
}

function affectedVersionRange(change, endVersion) {
  if (['NOT_ISOLATED', 'COULD_NOT_ISOLATED'].includes(change.apiEffectiveVersion)) return 'ALL';
  const apiText = String(change.apiVersion ?? '');
  const apiLevel = /^\d+$/.test(apiText) ? Number(apiText) : parseVersion(apiText).apiLevel;
  const platform = API_PLATFORM.get(apiLevel);
  const start = platform ? `${platform}(${apiLevel})` : apiText;
  return `${start} - ${endVersion.platformVersion}(${endVersion.apiLevel})`;
}

function ruleResourceVersion(name) {
  return parseVersion(path.basename(name, '.json'));
}

function isRuleFromLaterPlatform(name, target) {
  const match = name.match(/^HarmonyOS_(\d+)\.(\d+)\.(\d+)_(?:Canary\d*|Beta\d*|Release)\.json$/i);
  if (!match) return false;
  const platform = match.slice(1).map(Number);
  if (platform[0] < 26 || !platform.every(Number.isSafeInteger)) return false;
  const targetPlatform = [target.major, target.minor, target.patch];
  const firstDifference = platform.findIndex((part, index) => part !== targetPlatform[index]);
  return firstDifference !== -1 && platform[firstDifference] > targetPlatform[firstDifference];
}

function ruleResourceKey(name) {
  try {
    const version = ruleResourceVersion(name);
    return ['version', version.platformVersion, version.apiLevel, version.channel, version.channelNumber].join(':');
  } catch {
    return `file:${path.basename(name).toLowerCase()}`;
  }
}

export async function loadDevEcoRules(toolchain, referenceRoot, range, mode) {
  requireScanMode(mode);
  const changelogIndex = mode === 'upgrade' ? await loadChangelogIndex(referenceRoot) : null;
  const headingIndex = changelogIndex && await buildHeadingIndex(referenceRoot, changelogIndex);
  const resourcesByVersion = new Map();
  if (toolchain.apiChangeResourceRoot) {
    const files = await listFiles(toolchain.apiChangeResourceRoot, file => file.endsWith('.json'));
    const directoryResources = await Promise.all(files.map(async file => ({
      name: path.basename(file),
      sourceReference: file,
      text: await readFile(file, 'utf8'),
    })));
    for (const resource of directoryResources) resourcesByVersion.set(ruleResourceKey(resource.name), resource);
  }
  if (toolchain.apiChangeResourceArchive) {
    const archiveResources = (await readZipTextEntries(toolchain.apiChangeResourceArchive,
      name => /^apiChange\/.+\.json$/i.test(name) && !resourcesByVersion.has(ruleResourceKey(name)))).map(entry => ({
      name: path.basename(entry.name),
      sourceReference: `${toolchain.apiChangeResourceArchive}!/${entry.name}`,
      text: entry.text,
    }));
    for (const resource of archiveResources) resourcesByVersion.set(ruleResourceKey(resource.name), resource);
  }
  const resources = [...resourcesByVersion.values()];
  const rules = [];
  const excluded = [];
  const errors = [];
  const versionNames = {};
  const inventory = [], resourceSnapshots = new Map();
  const ruleSource = [toolchain.apiChangeResourceRoot, toolchain.apiChangeResourceArchive].filter(Boolean).join(' | ');
  if (!resources.some((resource) => {
    try { return compareVersions(ruleResourceVersion(resource.name), range.end) === 0; }
    catch { return false; }
  })) {
    errors.push({
      sourceReference: ruleSource,
      message: `DevEco rule pack does not cover target ${devecoVersionName(range.end)}`,
    });
  }
  for (const resource of resources) {
    let version;
    try {
      version = ruleResourceVersion(resource.name);
      versionNames[canonicalVersion(version)] = path.basename(resource.name, '.json');
    } catch (error) {
      if (isRuleFromLaterPlatform(resource.name, range.end)) continue;
      errors.push({ sourceReference: resource.sourceReference, message: error.message });
      continue;
    }
    if (compareVersions(version, range.start) <= 0 || compareVersions(version, range.end) > 0) continue;
    const resourceFile = resource.sourceReference.includes('!/') ? toolchain.apiChangeResourceArchive : resource.sourceReference;
    if (!resourceSnapshots.has(resourceFile)) resourceSnapshots.set(resourceFile, {file:resourceFile,hash:sha256(await readFile(resourceFile))});
    const entries = JSON.parse(resource.text);
    for (const entry of entries) {
      const change = entry.interfaceChanges ?? {};
      const affectedApis = Array.isArray(entry.affectedApis) ? entry.affectedApis : [];
      const mapped = CHANGE_TYPE_MAP.get(change.changeType);
      const initialSources = headingIndex?.byTitle.get(change.changeTitle)
        ?? headingIndex?.byNormalizedTitle.get(normalizeTitle(change.changeTitle)) ?? [];
      const inventoryEntry = { changeId: change.id ?? null, title: change.changeTitle ?? '',
        changedInSdk: change.sdkVersion || canonicalVersion(version), changeType: mapped?.[0] ?? change.changeType ?? '',
        sourceReference: initialSources.length === 1 ? initialSources[0] : null,
        candidates: initialSources, hasAffectedApis: affectedApis.length > 0 };
      inventory.push(inventoryEntry);
      if (mode === 'upgrade' && mapped?.[0] === 'Deprecated API') {
        excluded.push({ changeId: change.id, title: change.changeTitle, reason: 'UPGRADE_EXCLUDES_DEPRECATED' });
        continue;
      }
      if (mode === 'deprecated' && mapped?.[0] !== 'Deprecated API') {
        excluded.push({ changeId: change.id, title: change.changeTitle, reason: 'DEPRECATED_EXCLUDES_NON_DEPRECATED' });
        continue;
      }
      if (mapped && BEHAVIOR_CHANGE_TYPES.has(mapped[0])
        && parseVersion(change.sdkVersion || canonicalVersion(version)).apiLevel <= BEHAVIOR_BASELINE_API_LEVEL) {
        excluded.push({ ruleId: change.id ? String(change.id) : null,
          changedInSdk: change.sdkVersion || canonicalVersion(version), changeType: mapped[0],
          title: change.changeTitle ?? '', sourceReference: null, reason: BEHAVIOR_BASELINE_REASON });
        continue;
      }
      let sources = headingIndex ? headingIndex.byTitle.get(change.changeTitle) ?? [] : [resource.sourceReference];
      if (sources.length !== 1) {
        sources = headingIndex.byNormalizedTitle.get(normalizeTitle(change.changeTitle)) ?? [];
      }
      if (sources.length !== 1 && change.id !== undefined && change.id !== null) {
        const idCandidates = [String(change.id).toLowerCase(), `section${String(change.id).toLowerCase()}`];
        const linkedTitles = idCandidates.flatMap((id) => headingIndex.linkedTitlesByChangeId.get(id) ?? []);
        const linkedSources = linkedTitles.flatMap((title) => headingIndex.byTitle.get(title)
          ?? headingIndex.byNormalizedTitle.get(normalizeTitle(title)) ?? []);
        if (linkedSources.length === 1) sources = linkedSources;
      }
      if (sources.length !== 1) {
        const overrideTitle = CHANGE_TITLE_OVERRIDES.get(String(change.id));
        if (overrideTitle) {
          sources = headingIndex.byTitle.get(overrideTitle)
            ?? headingIndex.byNormalizedTitle.get(normalizeTitle(overrideTitle)) ?? [];
        }
      }
      if (!mapped || affectedApis.length === 0) {
        inventoryEntry.sourceReference = sources.length === 1 ? sources[0] : null;
        inventoryEntry.candidates = sources;
        excluded.push({
          sourceReference: sources.length === 1 ? sources[0] : null,
          changeId: change.id ?? null,
          title: change.changeTitle ?? '',
          reason: affectedApis.length === 0 ? 'NO_AFFECTED_APIS' : `UNSUPPORTED_CHANGE_TYPE:${change.changeType ?? ''}`,
        });
        continue;
      }
      if (sources.length !== 1) {
        inventoryEntry.candidates = sources;
        errors.push({
          changeId: change.id ?? null,
          title: change.changeTitle ?? '',
          message: sources.length === 0 ? 'changelog heading not found' : 'ambiguous changelog heading',
          candidates: sources,
        });
        continue;
      }
      const fallbackIdentity = headingIndex ? [sources[0]] : [resource.name, JSON.stringify(affectedApis)];
      const id = String(change.id || ruleId([change.sdkVersion ?? canonicalVersion(version), change.changeTitle, ...fallbackIdentity]));
      inventoryEntry.sourceReference = sources[0];
      inventoryEntry.candidates = sources;
      const link = headingIndex ? documentLink(change, sources[0], headingIndex) : null;
      rules.push({
        provider: 'DEVECO',
        ruleId: id,
        changeOperation: mapped[1],
        changeType: mapped[0],
        changedInSdk: change.sdkVersion || canonicalVersion(version),
        affectedVersions: affectedVersionRange(change, range.end),
        title: change.changeTitle ?? '',
        url: link?.url ?? '',
        ...(link ? { documentLink: link } : {}),
        sourceReference: sources[0],
        affectedApis,
        reportDisposition: 'REQUIRES_REVIEW',
        filterReason: null,
        applicabilityProof: null,
        rawEntry: entry,
      });
    }
  }
  return { rules, excluded, errors, versionNames, inventory, changelogIndex, resourceSnapshots: [...resourceSnapshots.values()] };
}

export async function compileRules({ toolchain, referenceRoot, range, strict = true, mode }) {
  requireScanMode(mode);
  const deveco = await loadDevEcoRules(toolchain, referenceRoot, range, mode);
  // loadDevEcoRules already excludes baseline behavior entries before matching changelog headings.
  const rules = deveco.rules;
  const baselineExcludedCount = deveco.excluded.filter(entry => entry.reason === BEHAVIOR_BASELINE_REASON).length;
  const errors = deveco.errors;
  const coverage = {
    status: errors.length === 0 ? 'COMPLETE' : 'INCOMPLETE',
    includedRuleCount: rules.length,
    devecoRuleCount: rules.length,
    excludedRuleCount: deveco.excluded.length,
    behaviorBaseline: { apiLevel: BEHAVIOR_BASELINE_API_LEVEL, policy: 'ALREADY_ADAPTED', reason: BEHAVIOR_BASELINE_REASON,
      excludedRuleCount: baselineExcludedCount },
    devecoVersionNames: deveco.versionNames,
    errorCount: errors.length,
    excluded: [...deveco.excluded],
    errors,
  };
  if (strict && errors.length) {
    const error = new Error(`Rule coverage is incomplete: ${errors.length} rule errors`);
    error.code = 'INCOMPLETE_RULE_COVERAGE';
    error.details = errors.slice(0, 20);
    throw error;
  }
  return { rules, coverage, ruleInventory: deveco.inventory, rulePackSources: deveco.resourceSnapshots, changelogIndex: deveco.changelogIndex };
}

export async function auditDeprecationRules(toolchain, rules, catalog = null) {
  catalog ??= await buildSdkCatalog(toolchain);
  const sourceFilesByParserName = new Map(
    [...catalog.sourceFiles.values()].map(sourceFile => [sourceFile.fileName, sourceFile]),
  );
  let targetSdkTagged = 0;
  let replacementCount = 0;
  let legacyChangelogSignature = 0;
  const legacySamples = [];
  for (const rule of rules.filter(item => item.changeOperation === 'API_DEPRECATED')) {
    const api = rule.affectedApis[0];
    const matches = api.implementLanguage.toLowerCase() === 'typescript'
      ? resolveRuleDeclarations(catalog, api).filter(entry => entry.deprecatedSince !== null)
      : [];
    if (matches.length === 1) {
      const entry = matches[0];
      rule.replacementApi = entry.replacementApi;
      rule.replacementSource = `${entry.file}:${entry.line}`;
      const sf = catalog.sourceFiles.get(entry.file) ?? sourceFilesByParserName.get(entry.file);
      if (!sf) {
        const error = new Error(`SDK declaration source is unavailable: ${entry.file}`);
        error.code = 'SDK_DECLARATION_SOURCE_MISSING';
        error.details = { ruleId: rule.ruleId, symbolId: entry.symbolId, file: entry.file };
        throw error;
      }
      const commentStart = sf.text.lastIndexOf('/**', entry.start);
      rule.replacementDeclaration = `${commentStart >= 0 ? sf.text.slice(commentStart, entry.start) : ''}${entry.declaration}`;
      targetSdkTagged += 1;
      if (entry.replacementApi) replacementCount += 1;
    } else {
      rule.replacementApi = null;
      rule.replacementSource = null;
      legacyChangelogSignature += 1;
      if (legacySamples.length < 20) legacySamples.push({
        ruleId: rule.ruleId, sourceReference: rule.sourceReference,
        apiDefinition: api.methodDefinition,
        reason: matches.length > 1 ? 'SDK_DECLARATION_AMBIGUOUS' : 'EXACT_SDK_DECLARATION_NOT_FOUND',
      });
    }
  }
  return { targetSdkTagged, replacementCount, legacyChangelogSignature, legacySamples };
}

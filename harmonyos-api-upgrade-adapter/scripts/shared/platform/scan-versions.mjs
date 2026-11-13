import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseHarmonyVersion, compareHarmonyVersions, canonicalHarmonyVersion } from './version.mjs';
import { errorWithCode } from './errors.mjs';
import { listZipEntries } from '../format/zip.mjs';

const catalog = JSON.parse(readFileSync(new URL('./scan-version-catalog.json', import.meta.url), 'utf8'));
if (createHash('sha256').update(JSON.stringify(catalog.versions)).digest('hex') !== catalog.versionsSha256)
  throw errorWithCode('Bundled scan version catalog checksum differs', 'SCAN_VERSION_CATALOG_INVALID');
export const bundledScanVersions = Object.freeze([...catalog.versions]);
export const scanVersionCatalogSource = Object.freeze(catalog.source);
export async function discoverScanVersions(toolchain = {}) {
  const analyzer = toolchain.analyzer ?? toolchain;
  const versions = new Set(bundledScanVersions);
  const add = name => {
    try { versions.add(canonicalHarmonyVersion(parseHarmonyVersion(path.basename(name, '.json')))); }
    catch { /* Other resource files do not declare a version. */ }
  };
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.json')) add(entry.name);
    }
  }
  if (analyzer.apiChangeResourceRoot) await visit(analyzer.apiChangeResourceRoot);
  if (analyzer.apiChangeResourceArchive) for (const name of await listZipEntries(analyzer.apiChangeResourceArchive))
    if (/^apiChange\/.*\.json$/i.test(name)) add(name);
  return [...versions].sort(compareHarmonyVersions);
}

export function resolveScanVersion(input, { endpoint, compileSdkVersion = null, versions = bundledScanVersions } = {}) {
  const parsed = parseHarmonyVersion(input);
  const explicit = /(?:\s|_)(?:Beta\d*|Release|Canary\d*)$/i.test(String(input).trim());
  // API12 is the existing behavior baseline; it has no scan rule resource.
  const known = [...new Set(['5.0.0(12) Release', ...versions].map(value => canonicalHarmonyVersion(value)))];
  let candidates = known.filter(value => {
    const version = parseHarmonyVersion(value);
    return version.apiLevel === parsed.apiLevel && version.platformVersion === parsed.platformVersion;
  }).sort(compareHarmonyVersions);
  if (explicit) candidates = candidates.filter(value => compareHarmonyVersions(value, parsed) === 0);
  if (!candidates.length) throw errorWithCode(`No verified scan version for ${input}`, 'SCAN_VERSION_UNKNOWN', { input, endpoint });
  if (endpoint === 'to' && compileSdkVersion) candidates = candidates.filter(value => compareHarmonyVersions(value, compileSdkVersion) <= 0);
  if (!candidates.length) throw errorWithCode(`Scan endpoint ${input} exceeds compile SDK ${compileSdkVersion}`,
    'SCAN_TARGET_NOT_COVERED', { input, compileSdkVersion });
  return endpoint === 'from' ? candidates[0] : candidates.at(-1);
}

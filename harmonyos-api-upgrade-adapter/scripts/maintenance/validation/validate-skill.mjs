#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists } from '../../shared/io/fs-utils.mjs';
import { skillFrontmatter } from './skill-frontmatter.mjs';
import { validateEvaluations, validateGuideLinks, validateReportTemplates } from './skill-content.mjs';
import { bundledScanVersions, scanVersionCatalogSource } from '../../shared/platform/scan-versions.mjs';
import { loadQueryCatalog } from '../../shared/platform/changelog-catalog.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const skillFile = path.join(skillRoot, 'SKILL.md');
const { text, lines } = skillFrontmatter(await readFile(skillFile, 'utf8'));
if (bundledScanVersions.length !== 30 || scanVersionCatalogSource.directoryVersionNamesSha256 !== scanVersionCatalogSource.archiveVersionNamesSha256)
  throw new Error('Bundled exact SDK version catalog is incomplete or its source inventories disagree');
const topLevelKeys = lines
  .filter((line) => /^[A-Za-z0-9_-]+:/.test(line))
  .map((line) => line.slice(0, line.indexOf(':')));
const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);
const unknown = topLevelKeys.filter((key) => !allowed.has(key));
if (unknown.length > 0) throw new Error(`Non-standard frontmatter fields: ${unknown.join(', ')}`);
const nameLine = lines.find((line) => line.startsWith('name:'));
const name = nameLine?.slice(nameLine.indexOf(':') + 1).trim();
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name ?? '') || name !== path.basename(skillRoot)) {
  throw new Error('Skill name must be lowercase hyphenated and match its directory');
}
const description = lines.find((line) => line.startsWith('description:'))?.split(':').slice(1).join(':').trim() ?? '';
if (description.length === 0 || description.length > 1024) throw new Error('Skill description must contain 1-1024 characters');
if (text.includes('!`')) throw new Error('Provider-specific dynamic command syntax is not allowed');
const scannerRoot = path.join(skillRoot, 'scripts', 'scanner');
const packageJson = JSON.parse(await readFile(path.join(skillRoot, 'package.json'), 'utf8'));
const skillVersion = lines.find((line) => /^\s+version:/.test(line))?.split(':').slice(1).join(':').trim().replaceAll('"', '');
if (packageJson.version !== skillVersion) {
  throw new Error(`Skill package version ${packageJson.version} does not match metadata version ${skillVersion}`);
}
const scannerPackage = JSON.parse(await readFile(path.join(scannerRoot, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(scannerPackage.version ?? '')) throw new Error(`Unsupported bundled scanner version: ${scannerPackage.version}`);
await loadQueryCatalog(path.join(skillRoot, 'references', 'changelogs'));
for (const resource of ['harmony-api-scan.mjs', 'deveco-worker-compat.cjs']) {
  if (!(await pathExists(path.join(scannerRoot, 'bin', resource)))) {
    throw new Error(`Bundled scanner runtime is missing: ${resource}`);
  }
}
for (const resource of ['process.mjs', 'fs.mjs', 'paths.mjs', 'deveco-home.mjs', 'deveco-version.mjs','version.mjs','source-types.mjs','scan-versions.mjs','scan-version-catalog.json','sdk-layout.mjs','artifact-layout.mjs','task-context.mjs','changelog-index.mjs','scan-mode.mjs','scan-inspection.mjs']) {
  if (!(await pathExists(path.join(skillRoot, 'scripts', 'shared', 'platform', resource)))) {
    throw new Error(`Shared platform resource is missing: ${resource}`);
  }
}
if (!(await pathExists(path.join(skillRoot, 'scripts', 'shared', 'format', 'upgrade-results.mjs'))))
  throw new Error('Shared upgrade result formatter is missing');
for (const resource of ['scripts/csv/cli.mjs', 'scripts/changelog/cli.mjs', 'scripts/shared/platform/changelog-catalog.mjs', 'scripts/shared/format/scan-input.mjs', 'scripts/shared/format/deprecated-results.mjs', 'scripts/scanner/core/environment.mjs'])
  if (!await pathExists(path.join(skillRoot, resource))) throw new Error(`Bundled deterministic tool is missing: ${resource}`);
for (const resource of ['scripts/shared/platform/entrypoint.mjs', 'scripts/report/cli.mjs', 'scripts/report/render.mjs', 'scripts/toolchain/cli.mjs', 'scripts/toolchain/build.mjs', 'templates/adapt-report-data.json'])
  if (!await pathExists(path.join(skillRoot, resource))) throw new Error(`Bundled delivery tool is missing: ${resource}`);
for (const resource of ['scripts/shared/platform/group-results.mjs', 'scripts/report/prepare.mjs', 'scripts/report/publication.mjs'])
  if (!await pathExists(path.join(skillRoot, resource))) throw new Error(`Bundled row projection resource is missing: ${resource}`);
for(const resource of ['agents/upgrade-assess-change.md','agents/upgrade-fix-file.md','templates/upgrade-spec.md','templates/upgrade-test-report.html','references/upgrade/upgrade-workflow.md','references/deprecated/deprecated-api-adaptation.md','references/common/verification.md','references/common/troubleshooting.md','templates/progress.md','templates/results.md','templates/upgrade-report.html','templates/deprecated-report.html','references/common/arkts-coding-standards.md'])
  if(!await pathExists(path.join(skillRoot,resource)))throw new Error(`Document-driven Skill resource is missing: ${resource}`);
for (const resource of ['cli.mjs', 'contracts.mjs', 'runs.mjs', 'io.mjs', 'generate.mjs', 'execute.mjs', 'report.mjs', 'report-html.mjs', 'package-identity.mjs',
  'python/runtime.py', 'python/worker.py', 'python/case_data.py', 'requirements.txt', 'requirements-lock.txt']) {
  if (!await pathExists(path.join(skillRoot, 'scripts', 'runtime', resource))) throw new Error(`Runtime resource is missing: ${resource}`);
}
const evaluations = await validateEvaluations(skillRoot, name);
const guideLinks = await validateGuideLinks(skillRoot);
const reportTemplates = await validateReportTemplates(skillRoot);
process.stdout.write(`${JSON.stringify({ valid: true, name, evaluations, guideLinks, reportTemplates }, null, 2)}\n`);

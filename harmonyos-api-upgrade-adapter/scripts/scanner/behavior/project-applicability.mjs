import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseJson5 } from '../../shared/format/json5.mjs';
import { sha256 } from '../../shared/io/fs-utils.mjs';
import { entryUrl } from '../../shared/platform/document-links.mjs';
import { errorWithCode } from '../../shared/platform/errors.mjs';
import { samePath } from '../../shared/platform/paths.mjs';
import { inside } from '../../shared/platform/source-scope.mjs';
import { compareHarmonyVersions } from '../../shared/platform/version.mjs';

const exclusions = [{
  ruleId: 'ch2026010615012',
  version: '26.0.0(26) Beta1',
  url: 'https://developer.huawei.com/consumer/cn/doc/doccenter-release-notes/changelogs-for-all-apps-7001#ch2026010615012',
  prove: proveStageApplication,
}];

async function configuration(file, readContent) {
  try { await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!readContent) return { file };
  const physicalPath = await realpath(file);
  const bytes = await readFile(physicalPath);
  return { file, physicalPath, hash: sha256(bytes), text: bytes.toString('utf8') };
}

async function proveStageApplication(project) {
  if (project.sourceScope.projectType !== 'app') return null;
  const inputs = new Map();
  async function requireAbsent(file) {
    if (inputs.has(file)) return inputs.get(file).snapshot === null;
    const snapshot = await configuration(file, false);
    inputs.set(file, { file, readContent: false, snapshot });
    return snapshot === null;
  }
  async function readConfig(root, file, optional = false) {
    const config = await configuration(file, true);
    if (config && !inside(root, config.physicalPath)) throw new Error('Configuration outside its registered root');
    if (!config && !optional) throw new Error('Required Stage configuration missing');
    const snapshot = config && { file, physicalPath: config.physicalPath, hash: config.hash };
    inputs.set(file, { file, readContent: true, snapshot });
    return config ? parseJson5(config.text) : {};
  }

  try {
    const profile = await readConfig(project.root, project.buildProfilePath);
    if (inputs.get(project.buildProfilePath).snapshot.hash !== project.buildProfileHash) return null;
    const registrations = profile.modules ?? [];
    if (registrations.length !== project.modules.length
      || new Set(project.modules.map(module => module.name)).size !== registrations.length) return null;
    const entries = project.modules.filter(module => module.type === 'entry' && registrations.some(item =>
      item.name === module.name && (item.targets === undefined || item.targets.some(target =>
        target.applyToProducts === undefined
        || Array.isArray(target.applyToProducts) && target.applyToProducts.includes(project.product.name)))));
    if (!entries.length) return null;
    const app = await readConfig(project.root, path.join(project.root, 'AppScope', 'app.json5'));
    if (typeof app?.app?.bundleName !== 'string' || !app.app.bundleName.trim()) return null;
    const checkedModules = new Set([...entries, ...project.selectedModules]);
    const ancestors = new Set();
    async function hasIndependentProject(directory, root) {
      for (; !samePath(directory, root); directory = path.dirname(directory)) {
        if (ancestors.has(directory)) break;
        ancestors.add(directory);
        if (!await requireAbsent(path.join(directory, 'build-profile.json5'))
          || !await requireAbsent(path.join(directory, 'AppScope', 'app.json5'))
          || !await requireAbsent(path.join(directory, 'src', 'main', 'config.json'))) return true;
      }
      return false;
    }
    for (const module of checkedModules) {
      const main = path.join(module.root, 'src', 'main');
      const moduleProfile = await readConfig(module.root, path.join(module.root, 'build-profile.json5'), true);
      const descriptor = await readConfig(module.root, path.join(main, 'module.json5'));
      if (!moduleProfile || typeof moduleProfile !== 'object' || Array.isArray(moduleProfile)
        || (moduleProfile.apiType !== undefined && moduleProfile.apiType !== 'stageMode')
        || descriptor?.module?.name !== module.name || descriptor.module.type !== module.type
        || !['entry', 'feature', 'har', 'shared'].includes(module.type)
        || !await requireAbsent(path.join(main, 'config.json'))) return null;
      if (!samePath(module.root, project.root)
        && (!await requireAbsent(path.join(module.root, 'AppScope', 'app.json5'))
          || inside(project.root, module.root) && await hasIndependentProject(path.dirname(module.root), project.root))) return null;
    }
    for (const file of project.sourceFiles.filter(file => /\.(ets|ts)$/i.test(file))) {
      const physicalPath = await realpath(file);
      const owners = project.modules.filter(module => inside(module.root, physicalPath));
      if (owners.length !== 1 || !project.selectedModules.includes(owners[0])) return null;
      if (await hasIndependentProject(path.dirname(physicalPath), owners[0].root)) return null;
    }
    return {
      inputs: [...inputs.values()],
      evidence: {
        kind: 'STAGE_MODEL_CONFIRMED',
        product: project.product.name,
        modules: project.sourceScope.selectedModules,
        sourceScopeFingerprint: project.sourceScope.fingerprint,
        configurations: [...inputs.values()].filter(input => input.snapshot).map(input => input.snapshot),
      },
    };
  } catch {
    // The existing scan remains usable when model evidence cannot be established.
    return null;
  }
}

export async function applyProjectRuleExclusions(rules, project, officialComparison) {
  const kept = [], excluded = [], proofs = new Map();
  for (const rule of rules) {
    const policy = rule.provider === 'DEVECO' && exclusions.find(entry =>
      entry.ruleId === rule.ruleId.toLowerCase()
      && compareHarmonyVersions(entry.version, rule.changedInSdk) === 0
      && entry.url === entryUrl(rule.url)?.toLowerCase());
    if (policy && !proofs.has(policy.prove)) proofs.set(policy.prove, await policy.prove(project));
    const proof = policy && proofs.get(policy.prove);
    if (proof) {
      excluded.push({ ruleId: rule.ruleId, changedInSdk: rule.changedInSdk, title: rule.title,
        changeType: rule.changeType, sourceReference: rule.sourceReference, url: rule.url,
        reason: proof.evidence.kind, applicabilityProof: proof.evidence });
    } else kept.push(rule);
  }
  for (const entry of officialComparison.entries) {
    const mapsToEntry = rule => entry.sourceReference === rule.sourceReference
      && compareHarmonyVersions(entry.changedInSdk, rule.changedInSdk) === 0;
    if (entry.status === 'RULE_AVAILABLE' && excluded.some(mapsToEntry) && !kept.some(mapsToEntry))
      entry.projectStatus = 'EXCLUDED_BY_PROJECT_APPLICABILITY';
  }
  return { rules: kept, audit: { excludedRuleCount: excluded.length, excluded },
    inputs: [...proofs.values()].flatMap(proof => proof?.inputs ?? []) };
}

export async function verifyProjectRuleExclusions(inputs) {
  const changed = [];
  for (const { file, readContent, snapshot } of inputs) {
    const actual = await configuration(file, readContent).catch(() => ({ unreadable: true }));
    if (snapshot === null ? actual !== null
      : !actual?.physicalPath || !samePath(snapshot.physicalPath, actual.physicalPath) || snapshot.hash !== actual.hash)
      changed.push(file);
  }
  if (changed.length)
    throw errorWithCode('Project applicability inputs changed before scan publication', 'SOURCE_CHANGED_DURING_SCAN', changed);
}

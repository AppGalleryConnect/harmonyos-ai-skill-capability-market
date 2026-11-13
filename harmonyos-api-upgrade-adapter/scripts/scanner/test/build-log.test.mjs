import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDeprecatedBuildLog, importDeprecatedBuildLog } from '../deprecated/build-log.mjs';
import { sha256 } from '../../shared/io/fs-utils.mjs';
import { compareDeprecated } from '../../maintenance/regression/compare-deprecated.mjs';

const log = `WARN: ArkTS:WARN File: /baseline/entry/A.ets:2:4
 'getContext' has been deprecated.
WARN: ArkTS:WARN File: /baseline/oh_modules/vendor/A.ets:3:5
 'create' has been deprecated.
WARN: ArkTS:WARN File: /baseline/oh_modules/vendor/A.ets:3:5
 'create' has been deprecated.
`;

test('compiler warning parser preserves columns and deduplicates repeated messages', () => {
  const parsed = parseDeprecatedBuildLog(log);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].column, 5);
  assert.equal(parseDeprecatedBuildLog("'create' has been deprecated.")[0].located, false);
});

test('Windows logs and historical comparisons match case variants while rejecting other roots and tampering',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'windows-build-log-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const logPath=path.join(root,'build.log'),evidencePath=path.join(root,'evidence.json'),scanJson=path.join(root,'scan.json');
  const text="WARN: ArkTS:WARN File: d:\\harmony\\APP\\oh_modules\\vendor\\A.ets:3:5\n 'create' has been deprecated.\n";
  const project={sourceSnapshot:'source',buildProfileHash:'profile',product:{name:'default'}};
  const catalog={platform:'win32',snapshot:'sdk',coverage:{targetSdk:'26'},deprecatedEntries:[]};
  const evidence={schemaVersion:1,projectRoot:'D:\\Harmony\\App',sourceSnapshot:'source',buildProfileHash:'profile',sdkSnapshot:'sdk',
    targetSdk:'26',product:'default',logHash:sha256(text),nonIncremental:true,status:'PASSED'};
  await writeFile(logPath,text);await writeFile(evidencePath,JSON.stringify(evidence));
  const result=await importDeprecatedBuildLog({project,catalog,logPath,evidencePath});
  assert.equal(result.findings.length,1);
  await writeFile(path.join(root,'build-profile.json5'),'{"modules":[{"name":"entry","srcPath":"entry"}]}');
  await writeFile(scanJson,JSON.stringify({sourceSnapshot:'source',buildProfileHash:'profile',deprecationCoverage:{sdkSnapshot:'sdk'},deprecationCatalog:{targetSdk:'26'},findings:[]}));
  const comparison=await compareDeprecated({project:root,buildLog:logPath,scanJson,buildProjectRoot:'d:/harmony/app',buildEvidence:evidencePath,platform:'win32'});
  assert.equal(comparison.evidenceStatus,'MATCHED_BUILD_SNAPSHOT');assert.equal(comparison.unmappedCount,0);
  for(const wrong of ['E:\\Harmony\\App','D:\\Harmony\\Application']) {
    await writeFile(evidencePath,JSON.stringify({...evidence,projectRoot:wrong}));
    assert.equal((await importDeprecatedBuildLog({project,catalog,logPath,evidencePath})).findings.length,0);
  }
  await writeFile(evidencePath,JSON.stringify({...evidence,sourceSnapshot:'tampered'}));
  await assert.rejects(importDeprecatedBuildLog({project,catalog,logPath,evidencePath}),{code:'BUILD_EVIDENCE_MISMATCH'});
});

test('only verified logs import dependencies; absent or mismatched evidence is not trusted', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deprecated-build-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'build.log'), evidencePath = path.join(root, 'build-evidence.json');
  await writeFile(logPath, log);
  const project = { sourceSnapshot: 'source', buildProfileHash: 'config', product: { name: 'default' } };
  const catalog = { snapshot: 'sdk', coverage: { targetSdk: '26.0.0(26) Release' }, deprecatedEntries: [] };
  const untrusted = await importDeprecatedBuildLog({ project, catalog, logPath });
  assert.equal(untrusted.findings.length, 0);
  assert.equal(untrusted.audit.status, 'UNVERIFIED_LOG');
  const evidence = { schemaVersion: 1, projectRoot: '/baseline', sourceSnapshot: 'source', buildProfileHash: 'config', sdkSnapshot: 'sdk',
    targetSdk: '26.0.0(26) Release', product: 'default', logHash: sha256(log), nonIncremental: true, status: 'PASSED' };
  await writeFile(evidencePath, JSON.stringify(evidence));
  const trusted = await importDeprecatedBuildLog({ project, catalog, logPath, evidencePath });
  assert.equal(trusted.findings.length, 1);
  assert.equal(trusted.findings[0]['Source Scope'], 'DEPENDENCY');
  assert.equal(trusted.findings[0].evidenceStatus, 'COMPILER_ONLY');
  assert.equal(trusted.findings[0].autoEditAllowed, false);
  await writeFile(evidencePath, JSON.stringify({ ...evidence, sourceSnapshot: 'old' }));
  await assert.rejects(importDeprecatedBuildLog({ project, catalog, logPath, evidencePath }), { code: 'BUILD_EVIDENCE_MISMATCH' });
});

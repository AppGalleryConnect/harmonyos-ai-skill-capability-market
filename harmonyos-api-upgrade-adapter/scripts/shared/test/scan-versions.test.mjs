import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundledScanVersions, resolveScanVersion } from '../platform/scan-versions.mjs';
import { compareConfigurationVersions, compareHarmonyVersions } from '../platform/version.mjs';

test('version guide lists exactly the thirty supported API13+ versions in chronological order', async () => {
  const guide = await readFile(new URL('../../../references/common/sdk-versions.md', import.meta.url), 'utf8');
  const listed = [...guide.matchAll(/^\| \d+ \| `([^`]+)` \|/gm)].map(match => match[1]);
  assert.deepEqual(listed, [...bundledScanVersions].sort(compareHarmonyVersions));
  assert.equal(listed.length, 30);
  assert.doesNotMatch(guide, /API\s*12|5\.0\.0\(12\)/i);
});

test('verified catalog chooses earliest starts, latest bounded ends and preserves explicit channels',()=>{
  assert.equal(bundledScanVersions.length,30);
  for (const [input,expected] of [['13','5.0.1(13) Beta3'],['16','5.0.4(16) Release'],['22','6.0.2(22) Beta1'],['23','6.1.0(23) Beta1']])
    assert.equal(resolveScanVersion(input,{endpoint:'from'}),expected);
  assert.equal(resolveScanVersion('20',{endpoint:'to',compileSdkVersion:'6.0.0(20) Beta5'}),'6.0.0(20) Beta5');
  for(const channel of ['Beta1','Beta2','Release']) {
    assert.equal(compareConfigurationVersions(`26.0.0 ${channel}`,'26.0.0'),0);
  }
  assert.equal(resolveScanVersion('6.1.0(23) Beta2',{endpoint:'from'}),'6.1.0(23) Beta2');
  assert.throws(()=>resolveScanVersion('26.0.0(26) Release',{endpoint:'to',compileSdkVersion:'26.0.0 Beta1'}),{code:'SCAN_TARGET_NOT_COVERED'});
  assert.throws(()=>resolveScanVersion('6.0.0(20) Beta4',{endpoint:'from'}),{code:'SCAN_VERSION_UNKNOWN'});
});

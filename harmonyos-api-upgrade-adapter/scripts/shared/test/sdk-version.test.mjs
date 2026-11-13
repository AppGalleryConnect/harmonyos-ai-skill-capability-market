import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertUpgradeRange,
  compareHarmonyVersions as compareVersions,
  devecoVersionName,
} from '../platform/version.mjs';

test('orders beta channels before release and validates an exclusive-inclusive range', () => {
  assert.equal(devecoVersionName('26.0.0(26) Release'), 'HarmonyOS_26.0.0(26)_Release');
  assert.ok(compareVersions('26.0.0(26) Canary1', '26.0.0(26) Beta') < 0);
  assert.ok(compareVersions('26.0.0(26) Beta', '26.0.0(26) Beta1') < 0);
  assert.ok(compareVersions('26.0.0(26) Beta1', '26.0.0(26) Beta2') < 0);
  assert.ok(compareVersions('26.0.0(26) Beta2', '26.0.0(26) Release') < 0);
  assert.equal(assertUpgradeRange('5.0.0(12)', '6.1.1(24)').end.apiLevel, 24);
  assert.throws(() => assertUpgradeRange('6.1.1(24)', '6.1.1(24)'), /must be lower/);
});

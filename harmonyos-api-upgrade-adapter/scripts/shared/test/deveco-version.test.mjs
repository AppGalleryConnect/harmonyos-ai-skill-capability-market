import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDevEcoCompatibility, inspectDevEcoCompatibility } from '../platform/deveco-version.mjs';

test('DevEco minimum follows the target API mapping and compares numeric version components', () => {
  for (const [version, target, status, required] of [
    ['26.0.0', '26', 'COMPATIBLE', '26.0.0'],
    ['26.0.0.821', '26.0.0(26) Beta2', 'COMPATIBLE', '26.0.0'],
    ['6.1.1.280', '24', 'COMPATIBLE', '6.1.1'],
    ['6.1.1', '6.1.1(24)', 'COMPATIBLE', '6.1.1'],
    ['26.0.0.821', '24', 'COMPATIBLE', '6.1.1'],
    ['6.1.1.999', '26', 'TOO_OLD', '26.0.0'],
    ['6.1.0.999', '24', 'TOO_OLD', '6.1.1'],
    ['6.0.9', '24', 'TOO_OLD', '6.1.1'],
    ['6.10.0', '24', 'COMPATIBLE', '6.1.1'],
    ['5.0.1.100', '13', 'COMPATIBLE', '5.0.1'],
  ]) {
    const result = inspectDevEcoCompatibility({ version }, target);
    assert.equal(result.status, status, `${version} -> ${target}`);
    assert.equal(result.requiredVersion, required);
    assert.equal(result.installedVersion, version);
  }
});

test('missing or malformed IDE versions never fall back to SDK or build numbers', () => {
  for (const version of [undefined, null, 26, '', '26', '26.0', '26.0.0.1.2', '26.0.0 Beta1', 'invalid', '9007199254740992.0.0']) {
    const result = inspectDevEcoCompatibility({ version, buildNumber: '26.0.0.821', file: '/IDE/product-info.json' }, '26', '/IDE');
    assert.equal(result.status, 'UNRESOLVED');
    assert.throws(() => assertDevEcoCompatibility(result), error => {
      assert.equal(error.code, 'DEVECO_VERSION_UNRESOLVED');
      assert.equal(error.stage, 'VALIDATE_DEVECO_VERSION');
      assert.equal(error.details.metadataPath, '/IDE/product-info.json');
      assert.match(error.message, /修复本地环境/);
      return true;
    });
  }
});

test('old IDE errors preserve the actual version and actionable target requirements', () => {
  const result = inspectDevEcoCompatibility({ version: '6.1.1.280' }, '26');
  assert.match(result.message, /6\.1\.1\.280/);
  assert.match(result.message, /26\.0\.0 或更高版本/);
  assert.match(result.message, /https:\/\/developer\.huawei\.com\/consumer\/cn\/download\//);
  assert.throws(() => assertDevEcoCompatibility(result), error => {
    assert.equal(error.code, 'DEVECO_TARGET_NOT_COVERED');
    assert.equal(error.details.installedVersion, '6.1.1.280');
    assert.equal(error.details.requiredVersion, '26.0.0');
    assert.equal(error.message, result.message);
    return true;
  });
  assert.doesNotThrow(() => assertDevEcoCompatibility(inspectDevEcoCompatibility({ version: '26.0.0.821' }, '26')));
});

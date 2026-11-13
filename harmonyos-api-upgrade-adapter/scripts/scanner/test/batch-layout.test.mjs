import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { batchArtifactPaths, createScanBatch, ensureBatchDirectory } from '../../shared/platform/artifact-layout.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), '批次 中文 space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '20261027172821-2');
  await mkdir(directory);
  return { root, directory };
}

for (const mode of ['upgrade', 'deprecated']) {
  test(`${mode} allocates delivery paths and creates the directory only when publishing`, async t => {
    const { root, directory } = await fixture(t);
    const batch = await createScanBatch(root, directory, { mode });
    assert.equal(batch.deliveryDirectory, path.join(directory, mode, 'project'));
    assert.equal(batch.taskReportPath, path.join(directory, mode, 'api-adapt-report.html'));
    const stem = mode === 'upgrade' ? `scan-results-${batch.batchId}` : `apiChange_${path.basename(directory)}`;
    assert.equal(batch.rawCsv, path.join(directory, mode, 'project', `${stem}.csv`));
    assert.equal(batch.adaptedCsv, path.join(directory, mode, 'project', `adapted-results-${batch.batchId}.csv`));
    assert.equal(batch.scanJson, path.join(batch.batchDirectory, 'scanner', `${stem}.scan.json`));
    const metadata = JSON.parse(await readFile(batch.batchMetadataPath, 'utf8'));
    assert.equal(metadata.batchId, batch.batchId);
    assert.equal(metadata.mode, mode);
    assert.equal(metadata.projectKey, batch.projectKey);
    assert.equal(metadata.scanPurpose, batch.scanPurpose);
    assert.deepEqual(await readdir(directory), ['.internal']);
    const original = Buffer.from('\ufeffTitle,Fixed\r\n"重复,调用",Unfixed\r\n"重复,调用",Unfixed\r\n');
    await ensureBatchDirectory(batch, batch.deliveryDirectory);
    await writeFile(batch.rawCsv, original);
    await writeFile(batch.adaptedCsv, '独立评估\r\n');
    assert.deepEqual(await readFile(batch.rawCsv), original);
    const variant = path.join(directory, mode.toUpperCase(), 'PROJECT');
    let sameDirectory = false;
    try { sameDirectory = await realpath(variant) === await realpath(batch.deliveryDirectory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (sameDirectory) await ensureBatchDirectory(batch, variant);
    assert.equal(batchArtifactPaths(directory, batch.batchId, mode).adaptedCsv, batch.adaptedCsv);
  });

  test(`${mode} supports drive and UNC paths and rejects invalid batch identities`, () => {
    for (const directory of ['D:\\中文 工程\\20261027172821-2', '\\\\server\\共享\\20261027172821-2']) {
      const batch = batchArtifactPaths(directory, 'abcdef012345', mode);
      assert.equal(batch.deliveryDirectory, path.win32.join(directory, mode, 'project'));
      assert.equal(batch.taskReportPath, path.win32.join(directory, mode, 'api-adapt-report.html'));
      assert.equal(batch.adaptedCsv, path.win32.join(directory, mode, 'project', 'adapted-results-abcdef012345.csv'));
      assert.equal(batch.batchMetadataPath, path.win32.join(directory, '.internal', mode, 'project', 'scans', 'abcdef012345', 'scan-batch.json'));
    }
    assert.throws(() => batchArtifactPaths('20261027172821', '../outside', mode), { code: 'SCAN_BATCH_INVALID' });
    assert.throws(() => batchArtifactPaths('20261027172821', 'abcdef012345', 'other'), { code: 'SCAN_BATCH_INVALID' });
    if (mode === 'deprecated') assert.throws(() => batchArtifactPaths('invalid-stamp', 'abcdef012345', mode), { code: 'SCAN_BATCH_INVALID' });
  });

  test(`${mode} resolves concurrent ID collisions and stops after the collision budget`, async t => {
    const { root, directory } = await fixture(t);
    const second = path.join(root, '20261027172822');
    await mkdir(second);
    let a = 0, b = 0;
    const batches = await Promise.all([
      createScanBatch(root, directory, { mode, idFactory: () => a++ ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa' }),
      createScanBatch(root, second, { mode, idFactory: () => b++ ? 'cccccccccccc' : 'aaaaaaaaaaaa' }),
    ]);
    assert.notEqual(batches[0].batchId, batches[1].batchId);
    const third = path.join(root, '20261027172823');
    await mkdir(third);
    let calls = 0;
    await assert.rejects(createScanBatch(root, third, { mode, idFactory: () => { calls++; return 'aaaaaaaaaaaa'; } }), { code: 'SCAN_BATCH_COLLISION' });
    assert.equal(calls, 32);
  });

  test(`${mode} creation rejects linked feature and internal directories outside the batch`, async t => {
    const { root, directory } = await fixture(t);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'outside-batch-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    for (const name of [mode, '.internal']) {
      await rm(path.join(directory, '.internal'), { recursive: true, force: true });
      const link = path.join(directory, name);
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(createScanBatch(root, directory, { mode }), { code: 'SCAN_BATCH_INVALID' });
      await rm(link, { recursive: true });
      assert.deepEqual(await readdir(outside), []);
    }
  });
}

test('a linked batch registry cannot publish outside the chosen output root', async t => {
  const { root, directory } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'outside-registry-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, '.batch-ids'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createScanBatch(root, directory), { code: 'SCAN_BATCH_INVALID' });
  assert.deepEqual(await readdir(outside), []);
});

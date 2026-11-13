import { randomBytes, createHash } from 'node:crypto';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorWithCode } from './errors.mjs';
import { relativePathInside } from './paths.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function batchArtifactPaths(directory, batchId, mode = 'upgrade', {projectKey='project',scanPurpose='initial',taskFile=null,projectRoot=null} = {}) {
  if (!/^[a-f0-9]{12}$/.test(batchId)) throw errorWithCode('扫描批次 ID 必须为 12 位小写十六进制', 'SCAN_BATCH_INVALID');
  if (!['upgrade', 'deprecated'].includes(mode)) throw errorWithCode('扫描批次模式无效', 'SCAN_BATCH_INVALID');
  const api = /^[a-z]:[\\/]|^\\\\/i.test(directory) ? path.win32 : path;
  const scanDirectory = api.resolve(directory);
  if (!projectKey || projectKey==='.' || projectKey==='..' || /[<>:"/\\|?*\x00-\x1f]/.test(projectKey)
    || /[. ]$/.test(projectKey) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(projectKey))
    throw errorWithCode('工程目录键无效','SCAN_BATCH_INVALID');
  if (!['initial','rescan'].includes(scanPurpose) || mode==='upgrade' && scanPurpose==='rescan')
    throw errorWithCode('仅废弃流程支持 rescan','SCAN_PURPOSE_INVALID');
  const internalDirectory = api.join(scanDirectory, '.internal');
  const batchDirectory = api.join(internalDirectory, mode, projectKey, 'scans', batchId);
  const scannerDirectory = api.join(batchDirectory, 'scanner');
  const deliveryDirectory = api.join(scanDirectory, mode, projectKey);
  const scanStamp = api.basename(scanDirectory);
  if (mode === 'deprecated' && !/^\d{14}(?:-[2-9]\d*|-1\d+)?$/.test(scanStamp))
    throw errorWithCode('废弃 API 批次目录必须使用扫描时间戳', 'SCAN_BATCH_INVALID');
  const stem = mode === 'deprecated' ? `apiChange_${scanStamp}` : `scan-results-${batchId}`;
  const workRawCsv = api.join(batchDirectory,'raw',`${stem}.csv`);
  return {
    batchId, mode, scanDirectory, taskDirectory:scanDirectory, internalDirectory, batchDirectory,
    scannerDirectory, deliveryDirectory, projectKey, projectRoot, scanPurpose, taskFile,
    taskReportPath:api.join(scanDirectory,mode,'api-adapt-report.html'),
    progressPath:api.join(deliveryDirectory,'progress.json'),specPath:api.join(deliveryDirectory,'spec.md'),
    evidenceDirectory:api.join(deliveryDirectory,'evidence'),workRawCsv,
    ...(mode === 'deprecated' ? { scanStamp } : {}),
    batchMetadataPath: api.join(batchDirectory, 'scan-batch.json'),
    rawCsv: scanPurpose==='initial'?api.join(deliveryDirectory, `${stem}.csv`):workRawCsv,
    adaptedCsv: scanPurpose==='initial'?api.join(deliveryDirectory, `adapted-results-${batchId}.csv`):null,
    scanJson: api.join(scannerDirectory, `${stem}.scan.json`),
    validationCsv: mode === 'deprecated' ? api.join(scannerDirectory, `${stem}.validation.csv`) : null,
    coverageJson: api.join(scannerDirectory, 'coverage.json'),
    diagnosticsJson: api.join(scannerDirectory, 'diagnostics.json'),
  };
}

export async function assertBatchDirectory(layout, directory) {
  if (relativePathInside(layout.scanDirectory, directory) === null
    || relativePathInside(await realpath(layout.scanDirectory), await realpath(directory)) === null
    || !(await stat(directory)).isDirectory())
    throw errorWithCode('内部目录越过扫描批次边界或不是目录', 'SCAN_BATCH_INVALID', { path: directory });
}

// Check each existing parent before creating children, including Windows junctions.
export async function ensureBatchDirectory(layout, directory) {
  const relative = relativePathInside(layout.scanDirectory, directory);
  if (relative === null) throw errorWithCode('内部目录越过扫描批次边界', 'SCAN_BATCH_INVALID', { path: directory });
  let current = layout.scanDirectory;
  await assertBatchDirectory(layout, current);
  for (const part of relative.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await assertBatchDirectory(layout, current);
  }
}

export async function createScanBatch(outputRoot, directory, { idFactory = () => randomBytes(6).toString('hex'), mode = 'upgrade',...options } = {}) {
  if (!['upgrade', 'deprecated'].includes(mode)) throw errorWithCode('扫描批次模式无效', 'SCAN_BATCH_INVALID');
  const registry = path.join(outputRoot, '.batch-ids');
  await mkdir(registry, { recursive: true });
  if (relativePathInside(await realpath(outputRoot), await realpath(registry)) === null
    || relativePathInside(await realpath(outputRoot), await realpath(directory)) === null)
    throw errorWithCode('扫描批次目录越过输出边界', 'SCAN_BATCH_INVALID');
  for (let attempt = 0; attempt < 32; attempt++) {
    const paths = batchArtifactPaths(directory, idFactory(), mode, options);
    // Preserve junction/boundary checks without materializing a delivery directory.
    let destination = paths.scanDirectory;
    for (const part of path.relative(paths.scanDirectory, paths.deliveryDirectory).split(path.sep).filter(Boolean)) {
      destination = path.join(destination, part);
      try { await assertBatchDirectory(paths, destination); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    await ensureBatchDirectory(paths, paths.internalDirectory);
    await ensureBatchDirectory(paths, paths.batchDirectory);
    const content = JSON.stringify({ batchId: paths.batchId, mode,
      projectKey:paths.projectKey,projectRoot:paths.projectRoot,scanPurpose:paths.scanPurpose,taskFile:paths.taskFile,
      ...(mode === 'deprecated' ? { scanStamp: paths.scanStamp } : {}), createdAt: new Date().toISOString() }, null, 2) + '\n';
    try { await writeFile(path.join(registry, paths.batchId), content, { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    await writeFile(paths.batchMetadataPath, content, { flag: 'wx' });
    return { ...paths, createdAt: JSON.parse(content).createdAt, batchMetadataSha256: digest(content) };
  }
  throw errorWithCode('扫描批次 ID 连续冲突，请重试', 'SCAN_BATCH_COLLISION');
}

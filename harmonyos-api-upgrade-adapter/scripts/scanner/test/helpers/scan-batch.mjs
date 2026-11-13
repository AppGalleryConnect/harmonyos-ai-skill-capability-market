import { createRunOutputDirectory } from '../../core/cli.mjs';
import { createScanBatch } from '../../../shared/platform/artifact-layout.mjs';
import { runDevEcoScan } from '../../core/scan-runner.mjs';

export async function runScanInBatch(mode, options) {
  if (options.batchId) return runDevEcoScan({ ...options, mode });
  const { directory } = await createRunOutputDirectory(options.outputDirectory);
  const layout = await createScanBatch(options.outputDirectory, directory, { mode });
  return runDevEcoScan({ ...options, mode, outputDirectory: directory, batchId: layout.batchId });
}

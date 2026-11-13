import { lstat } from 'node:fs/promises';
import { assertBatchDirectory } from './artifact-layout.mjs';
import { optionalJson } from './group-results.mjs';

async function readLegacyEvidence(layout, file) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  await assertBatchDirectory(layout, layout.scannerDirectory);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`扫描证据不是批次内的普通文件：${file}`);
  return optionalJson(file);
}

export async function readScanReportEvidence(state) {
  const { participant, scanMetadata } = state;
  const layout = participant.outputLayout;
  const attempt = participant.attempts.find(item => item.batchId === participant.initialBatchId);
  let coverage = scanMetadata?.scanCoverage, applicability = scanMetadata?.projectApplicability;
  const sources = state.scanMetadataFile ? [state.scanMetadataFile] : [];
  const snapshots = [];
  if (!coverage && attempt?.origin === 'SCANNER') {
    const legacy = await readLegacyEvidence(layout, layout.coverageJson);
    const diagnostics = await readLegacyEvidence(layout, layout.diagnosticsJson);
    coverage = { cpp: legacy?.value?.scanCoverage?.cpp, nativePasses: diagnostics?.value?.nativePasses };
    applicability ??= legacy?.value?.projectApplicability;
    for (const snapshot of [legacy, diagnostics].filter(item => item?.value)) {
      snapshots.push({ file: snapshot.file, hash: snapshot.hash });
      sources.push(snapshot.file);
    }
  }
  const incomplete = ['TIMED_OUT', 'PARTIAL', 'FAILED'];
  const passes = Array.isArray(coverage?.nativePasses) ? coverage.nativePasses : [];
  const gaps = passes.filter(pass => incomplete.includes(pass.status));
  if (!gaps.length && incomplete.includes(coverage?.cpp)) gaps.push({ status: coverage.cpp });
  const summary = pass => {
    const modules = pass.modules?.length ? pass.modules.join('、') : '模块未知';
    const status = pass.status === 'TIMED_OUT' ? '超时' : pass.status === 'PARTIAL' ? '部分完成' : '未完成';
    const skipped = pass.skippedFiles?.length ? `，跳过 ${pass.skippedFiles.length} 个文件` : '';
    const reason = {
      NO_SCANNED_FILES: '，后端回报已扫描 0 个文件',
      JAR_EXECUTION_FAILED: '，JAR 执行失败',
      JAR_OUT_OF_MEMORY: '，JAR 堆内存耗尽',
      JAR_COMMITMENT_LIMIT: '，Windows 内存提交失败（1455）',
      UNVERIFIED_BUILD_FALLBACK: '，当前 DevEco 构建未经验证且退回了文本匹配',
    }[pass.failureReason] ?? '';
    return `${modules} 的 C/C++ 语义扫描${status}${skipped}${reason}，覆盖不完整`;
  };
  return { cpp: coverage?.cpp, gaps: gaps.map(pass => ({ ...pass, summary: summary(pass) })),
    textCandidates: Array.isArray(scanMetadata?.scanCoverage?.textCandidates) ? scanMetadata.scanCoverage.textCandidates : [],
    exclusions: Array.isArray(applicability?.excluded) ? applicability.excluded : [],
    rnoh: scanMetadata?.rnoh && typeof scanMetadata.rnoh === 'object' ? scanMetadata.rnoh : null, sources, snapshots };
}

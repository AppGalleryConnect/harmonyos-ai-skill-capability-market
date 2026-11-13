import { optionalJson, checkSnapshot, updateProgress } from '../shared/platform/group-results.mjs';

export async function publishProgress(projects, output, hash, { updateProgress: write = updateProgress } = {}) {
  const failures = [], updated = [], time = new Date().toISOString();
  for (const project of projects) {
    try {
      const snapshot = project.progressSnapshot;
      if (!snapshot?.value) throw new Error('进度文件缺失，请先 report prepare');
      await checkSnapshot(snapshot);
      const before = snapshot.value;
      const todo = project.gaps.length || project.pendingCount || (project.input.nextSteps ?? []).length;
      const unchanged = before.delivery?.report === output && before.delivery?.reportSha256 === hash;
      const value = { ...before, delivery: { ...before.delivery, report: output, reportSha256: hash,
        ...(project.generatedCsv ? {adaptedCsv:project.generatedCsv.output,adaptedCsvSha256:project.generatedCsv.sha256} : {}),
        reportPublishedAt: unchanged ? before.delivery.reportPublishedAt ?? time : time,
        reportStatus: todo ? 'DELIVERED_WITH_GAPS' : 'DELIVERED', reportInputs: project.reportInputs ?? null },
        next: todo ? '报告已交付，仍有待办；详见报告中的逐行判断、缺口与后续事项' : '报告已交付；本轮交付步骤已完成，验证范围及结论见报告' };
      await write(snapshot, value);
      const actual = await optionalJson(snapshot.file);
      if (actual.value?.delivery?.reportSha256 !== hash || actual.value?.delivery?.report !== output)
        throw new Error('进度发布回读不一致');
      updated.push(project.projectKey);
    } catch (error) { failures.push({ projectKey: project.projectKey, reason: error.message }); }
  }
  if (failures.length) {
    const error = new Error(`报告已保留，但进度同步失败：${failures.map(f => `${f.projectKey}（${f.reason}）`).join('；')}`);
    error.code = 'REPORT_PROGRESS_SYNC_FAILED'; error.details = { output, updated, unsynced: failures };
    throw error;
  }
  return updated;
}

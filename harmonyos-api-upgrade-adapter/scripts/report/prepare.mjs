import { writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readTask } from '../shared/platform/task-context.mjs';
import { requireScanMode } from '../shared/platform/scan-mode.mjs';
import { ensureBatchDirectory } from '../shared/platform/artifact-layout.mjs';
import { optionalJson, readProjectScan, updateProgress } from '../shared/platform/group-results.mjs';

export async function prepareReport({ taskFile, mode, output }) {
  requireScanMode(mode);
  const task = await readTask(path.resolve(taskFile)), projects = [];
  const participants = task.participants.filter(item => item.mode === mode);
  if (!participants.length) throw new Error('任务中没有该功能的工程');
  for (const participant of participants) {
    const directory = path.join(task.taskDirectory, mode, participant.projectKey);
    const progressPath = participant.outputLayout?.progressPath ?? path.join(directory, 'progress.json');
    const snapshot = await optionalJson(progressPath);
    if (!snapshot.value) {
      await ensureBatchDirectory({ scanDirectory: task.taskDirectory }, directory);
      await updateProgress(snapshot, { mode, projectKey: participant.projectKey, project: participant.projectRoot,
        delivery: { directory }, groups: [], next: '完成评估与交付' });
    }
    const progress = snapshot.value ?? {}, versions = progress.versions ?? {};
    const rawPath = participant.outputLayout?.rawCsv;
    const available = rawPath ? await stat(rawPath).then(info => info.isFile()).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }) : false;
    const scan = available ? await readProjectScan(participant, mode) : null;
    projects.push({ projectKey: participant.projectKey,
      configuration: { oldTarget: versions.oldTarget ?? '', target: versions.target ?? '', compatible: versions.compatible ?? '', implementation: '' },
      changes: (scan?.inspected.groups ?? []).map(group => ({ identity: group.identity, ruleId: group.ruleId, version: group.version, ...(!group.identity ? { rowIds: group.rowIds } : {}),
        before: '', after: '', ...(mode === 'upgrade' ? { targetIsolation: '' } : {}), business: '', approval: '', compatibility: '', gaps: '' })),
      verification: [{ name: '编译构建', status: '待核对', details: '', evidence: [] }, { name: '设备运行', status: '待核对', details: '', evidence: [] }],
      nextSteps: [] });
  }
  const target = path.resolve(output);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({ title: mode === 'upgrade' ? 'API版本升级适配报告' : '废弃 API 迁移报告', projects }, null, 2) + '\n', { flag: 'wx' });
  return { output: target, projectCount: projects.length };
}

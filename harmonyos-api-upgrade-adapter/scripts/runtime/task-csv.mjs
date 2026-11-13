import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readTask } from '../shared/platform/task-context.mjs';
import { taskProject } from '../shared/platform/group-results.mjs';
import { physicalOutput } from '../shared/platform/generated-output.mjs';
import { samePath } from '../shared/platform/paths.mjs';
import { readTaskView } from '../shared/platform/task-view.mjs';
import { matchesUpgradeResult } from '../shared/format/upgrade-results.mjs';
import { writeProjectCsv } from '../csv/project.mjs';
import { recordVerification } from '../csv/verification.mjs';
import { writeReport } from './report.mjs';
import { verifyRun } from './runs.mjs';
import { assertSourceMatches } from './contracts.mjs';

export async function taskForOutput(output) {
  const physical=await physicalOutput(output);
  for (let directory=path.dirname(physical); ; directory=path.dirname(directory)) {
    const taskFile=path.join(directory,'.internal','task.json');
    try {
      const index=JSON.parse(await readFile(taskFile,'utf8'));
      if (typeof index.taskFile!=='string' || !samePath(await physicalOutput(index.taskFile),await physicalOutput(taskFile))) throw new Error('任务上下文路径不一致');
      const task=await readTask(index.taskFile);
      for (const participant of task.participants) if(participant.mode==='upgrade' && participant.outputLayout
        && samePath(await physicalOutput(participant.outputLayout.deliveryDirectory),path.dirname(physical)))
        return {taskFile:task.taskFile,projectPath:participant.projectRoot};
      return null;
    } catch (error) { if(error.code!=='ENOENT') throw error; }
    if (directory===path.dirname(directory)) return null;
  }
}

export async function writeTaskRuntimeCsv({runDirectory,sourceId,taskFile,projectPath,output,legacyResults}) {
  const options={taskFile,projectPath,mode:'upgrade'}, {participant}=await taskProject(options);
  const view=await readTaskView(participant,'upgrade',{strict:true}), {plan}=await verifyRun(runDirectory);
  const source=plan.sources.find(item=>item.sourceId===sourceId);
  if (!source || source.sha256!==view.raw.sha256) throw new Error('runtime 来源与当前任务原扫描不一致');
  assertSourceMatches(source,view.raw);
  const selected=source.rows.filter(row=>row.selected).map(row=>row.rowId);
  if (selected.some(id=>view.canonical.get(id)?.outcome==='NOT_IMPLEMENTED')) throw new Error('不实施行不安排修复验收');
  if (legacyResults) {
    if (!Array.isArray(legacyResults) || legacyResults.length!==view.projectedRows.length) throw new Error('旧逐行输入与当前分组覆盖不一致');
    const byId=new Map(legacyResults.map(row=>[row.rowId,row]));
    if (byId.size!==legacyResults.length) throw new Error('旧逐行输入包含重复行');
    for (const row of view.projectedRows) {
      const supplied = byId.get(row.rowId);
      for (const key of ['评估结论','处理结论','处理说明','后续事项']) {
        if (supplied && key === '评估结论' && supplied[key] === undefined) continue;
        if (!supplied || !matchesUpgradeResult(key, supplied[key], row[key]))
          throw new Error(`旧逐行输入与当前分组冲突：${row.rowId} ${key}`);
      }
    }
  }
  const target=output ?? view.progress.value.delivery?.adaptedCsv ?? participant.outputLayout.adaptedCsv;
  await writeReport(runDirectory,path.dirname(target));
  await recordVerification({...options,value:{kind:'runtime',record:path.join(path.resolve(runDirectory),'audit.json'),sourceId,rowIds:selected,name:'设备运行'}});
  const current=await readTaskView(participant,'upgrade',{strict:true});
  return writeProjectCsv(current,{output:target});
}

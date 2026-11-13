import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { formatUpgradeResults } from '../shared/format/upgrade-results.mjs';
import { formatDeprecatedResults } from '../shared/format/deprecated-results.mjs';
import { projectedResults, checkSnapshot, optionalJson, updateProgress } from '../shared/platform/group-results.mjs';
import { saveGeneratedOutput } from '../shared/platform/generated-output.mjs';

export async function writeProjectCsv(state,{output,screenshots=state.screenshots,columnPrefix='',track=true}={}) {
  const layout=state.participant.outputLayout, delivery=state.progress.value?.delivery ?? {};
  const target=path.resolve(output ?? delivery.adaptedCsv ?? layout.adaptedCsv);
  for (const snapshot of state.snapshots) await checkSnapshot(snapshot);
  const rows=state.projectedRows ?? projectedResults(state);
  const sourceEncoding=state.raw.encoding;
  const bytes=state.mode==='upgrade' ? formatUpgradeResults(state.bytes,rows,{sourceEncoding,...(screenshots===undefined?{}:{screenshots})})
    : formatDeprecatedResults(state.bytes,rows,{columnPrefix,sourceEncoding});
  const result=await saveGeneratedOutput(target,bytes,{file:delivery.adaptedCsv,sha256:delivery.adaptedCsvSha256},
    state.snapshots.map(snapshot=>snapshot.file));
  for (const snapshot of state.snapshots) await checkSnapshot(snapshot);
  if (track) {
    await updateProgress(state.progress,{...state.progress.value,delivery:{...delivery,adaptedCsv:result.output,adaptedCsvSha256:result.sha256}});
    const current=await optionalJson(state.progress.file);
    state.snapshots=state.snapshots.map(snapshot=>snapshot.file===state.progress.file?current:snapshot); state.progress=current;
  }
  if (!(await readFile(result.output)).equals(Buffer.from(bytes))) throw new Error('CSV 输出回读不一致');
  return {...result,rowCount:rows.length,pendingCount:state.pendingCount};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initTask, importTaskCsv } from '../platform/task-context.mjs';
import { UPGRADE_HEADERS, DEPRECATED_HEADERS, stringifyCsv, parseCsv } from '../format/csv.mjs';
import { prepareProjectGroups, validateProjectGroups } from '../platform/group-results.mjs';
import { main as csv } from '../../csv/cli.mjs';
import { prepareReport } from '../../report/prepare.mjs';
import { renderReport } from '../../report/render.mjs';

async function setup(t, mode = 'upgrade', count = 5) {
  const root = await mkdtemp(path.join(os.tmpdir(), '逐行判断 中文 # &-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'app');
  await mkdir(path.join(project, 'entry', 'src', 'main'), { recursive: true });
  await writeFile(path.join(project, 'build-profile.json5'), '{modules:[{name:"entry",srcPath:"entry"}]}');
  await writeFile(path.join(project, 'entry', 'src', 'main', 'module.json5'), '{module:{type:"entry"}}');
  await writeFile(path.join(project, 'entry', 'src', 'A.ets'), 'source');
  const task = await initTask(root, { projects: [project], mode });
  const raw = Buffer.from(stringifyCsv(mode === 'upgrade' ? UPGRADE_HEADERS : [...DEPRECATED_HEADERS, 'Rule ID'],
    Array.from({ length: count }, (_, i) => ({ 'Code Location': `entry/src/A.ets:${i + 1}`, Title: '实际变更', 'Rule ID': 'CH1', 'Changed in SDK': '26.0.0(26) Beta1' }))));
  const input = path.join(root, 'input.csv'); await writeFile(input, raw);
  const { outputLayout: layout } = await importTaskCsv(task.taskFile, { mode, projectPath: project, inputCsv: input });
  return { root, project, task, layout, raw, mode };
}
async function prepared(t, mode = 'upgrade', count = 5) {
  const f = await setup(t, mode, count);
  const result = await prepareProjectGroups({ taskFile: f.task.taskFile, projectPath: f.project, mode });
  const progress = JSON.parse(await readFile(f.layout.progressPath, 'utf8'));
  const groupPath = progress.groups[0] ? path.join(f.layout.deliveryDirectory, progress.groups[0].record) : null;
  return { ...f, result, progress, groupPath };
}
async function assess(f) {
  const group = JSON.parse(await readFile(f.groupPath, 'utf8'));
  group.files[0].outcome = 'MODIFIED'; // This aggregate must never become five modified rows.
  for (const [i, row] of group.rowResults.entries()) Object.assign(row, { category: i === 0 ? '可选适配' : '无需适配',
    outcome: i === 0 ? 'MODIFIED' : 'NO_CHANGE', reason: `逐行理由 ${i}`, changes: i === 0 ? ['只修改第一个调用'] : [], next: '' });
  await writeFile(f.groupPath, JSON.stringify(group));
  return group;
}

for (const mode of ['upgrade', 'deprecated']) test(`${mode}: scaffold, validate and project five calls with only one MODIFIED`, async t => {
  const f = await prepared(t, mode);
  const before = await readFile(f.groupPath);
  const defaultState = await validateProjectGroups({ taskFile: f.task.taskFile, projectPath: f.project, mode });
  assert.equal(defaultState.pendingCount, 5);
  await prepareProjectGroups({ taskFile: f.task.taskFile, projectPath: f.project, mode });
  assert.deepEqual(await readFile(f.groupPath), before);
  await assess(f);
  const ownedProgress = JSON.parse(await readFile(f.layout.progressPath, 'utf8'));
  ownedProgress.decisions = { repair: { answer: '原有批准记录' } };
  ownedProgress.verification = { compile: '原有验证事实', runtime: 'NOT_RUN' };
  await writeFile(f.layout.progressPath, JSON.stringify(ownedProgress));
  const written = await csv(['write', '--task', f.task.taskFile, '--project', f.project, '--mode', mode]);
  const rows = parseCsv(await readFile(written.output, 'utf8')).rows;
  assert.deepEqual(rows.map(r => r['处理结论']), mode === 'upgrade' ? ['已适配', ...Array(4).fill('无需适配')] : ['MODIFIED', ...Array(4).fill('NO_CHANGE')]);
  assert.deepEqual(await readFile(f.layout.rawCsv), f.raw);
  const output = path.join(f.root, 'report.json');
  await prepareReport({ taskFile: f.task.taskFile, mode, output });
  const data = JSON.parse(await readFile(output, 'utf8'));
  assert.ok(!Object.hasOwn(data.projects[0], 'rowClassifications'));
  const report = await renderReport({ taskFile: f.task.taskFile, mode, data });
  const html = await readFile(report.output, 'utf8');
  assert.equal((html.match(/data-row-id=/g) ?? []).length, 5);
  assert.equal((html.match(/<td>已适配<\/td>/g) ?? []).length, mode === 'upgrade' ? 1 : 0);
  const delivered = JSON.parse(await readFile(f.layout.progressPath, 'utf8'));
  assert.equal(delivered.delivery.report, report.output);
  assert.equal(delivered.delivery.reportSha256, report.sha256);
  assert.match(delivered.next, /报告已交付/);
  assert.deepEqual(delivered.decisions, ownedProgress.decisions);
  assert.deepEqual(delivered.verification, ownedProgress.verification);
  const retry = await renderReport({ taskFile: f.task.taskFile, mode, data });
  assert.equal(retry.sha256, report.sha256);
});

test('group diagnostics reject classification confusion, wrong membership, duplicates and missing rows', async t => {
  const f = await prepared(t); const group = await assess(f), original = structuredClone(group);
  const validate = () => validateProjectGroups({ taskFile: f.task.taskFile, projectPath: f.project, mode: 'upgrade' });
  for (const mutate of [g => { g.rowResults[0].category = '已适配'; }, g => g.rowResults.push(g.rowResults[0]),
    g => { g.rowResults[0].rowId = 'foreign:1'; }, g => { g.rowResults.pop(); },
    g => { g.rowClassifications = [{ category: '无需适配', rowIds: [g.rowResults[0].rowId] }]; },
    g => { g.identity.ruleOrSymbol = 'OTHER-CHANGE'; }, g => { g.rowResults[0] = null; }]) {
    const bad = structuredClone(original); mutate(bad); await writeFile(f.groupPath, JSON.stringify(bad));
    await assert.rejects(validate(), error => { assert.match(error.message, /app/); assert.match(error.message, /rowId|分类|逐行/); return true; });
  }
});

test('report rejects stale duplicate classification and stale CSV; pending delivery never claims verification', async t => {
  const f = await prepared(t); const group = await assess(f);
  await csv(['write', '--task', f.task.taskFile, '--project', f.project, '--mode', f.mode]);
  const output = path.join(f.root, 'report.json'); await prepareReport({ taskFile: f.task.taskFile, mode: f.mode, output });
  const data = JSON.parse(await readFile(output, 'utf8'));
  data.projects[0].rowClassifications = [{ category: '无需适配', rowIds: [group.rowResults[0].rowId] }];
  await assert.rejects(renderReport({ taskFile: f.task.taskFile, mode: f.mode, data }), /分类与分组冲突/);
  delete data.projects[0].rowClassifications;
  group.rowResults[1].outcome = 'PENDING'; group.rowResults[1].reason = ''; group.rowResults[1].category = '待分类';
  await writeFile(f.groupPath, JSON.stringify(group));
  await assert.rejects(renderReport({ taskFile: f.task.taskFile, mode: f.mode, data }), /CSV.*分组.*冲突/);
  await csv(['write', '--task', f.task.taskFile, '--project', f.project, '--mode', f.mode]);
  const report = await renderReport({ taskFile: f.task.taskFile, mode: f.mode, data });
  const progress = JSON.parse(await readFile(f.layout.progressPath, 'utf8'));
  assert.match(progress.next, /仍有待办/); assert.equal(progress.delivery.reportStatus, 'DELIVERED_WITH_GAPS');
  assert.equal(progress.verification, undefined);
  assert.ok(report.gapCount > 0);
});

test('an assessed row with explicit next steps keeps delivery pending', async t => {
  const f = await prepared(t); const group = await assess(f);
  group.rowResults[0].next = '待补充本任务已要求的验证';
  await writeFile(f.groupPath, JSON.stringify(group));
  await csv(['write', '--task', f.task.taskFile, '--project', f.project, '--mode', f.mode]);
  const output = path.join(f.root, 'report.json'); await prepareReport({ taskFile: f.task.taskFile, mode: f.mode, output });
  const report = await renderReport({ taskFile: f.task.taskFile, mode: f.mode, data: JSON.parse(await readFile(output, 'utf8')) });
  assert.ok(report.gapCount > 0);
  assert.match(JSON.parse(await readFile(f.layout.progressPath, 'utf8')).next, /仍有待办/);
});

test('zero-row scaffolds remain empty; JSON and symlink paths cannot overwrite unrelated files', async t => {
  const f = await prepared(t, 'upgrade', 0);
  assert.equal((await validateProjectGroups({ taskFile: f.task.taskFile, projectPath: f.project, mode: 'upgrade' })).rowCount, 0);
  assert.equal(f.progress.groups.length, 0);
  const other = path.join(f.root, 'outside'); await mkdir(other);
  const link = path.join(f.layout.deliveryDirectory, 'groups');
  await rm(link, { recursive: true, force: true });
  await symlink(other, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareProjectGroups({ taskFile: f.task.taskFile, projectPath: f.project, mode: 'upgrade' }), /越界|越过/);
});

test('imported reduced deprecated CSV uses its registered companion JSON for identities', async t => {
  const f = await setup(t, 'deprecated');
  const rows = parseCsv(f.raw.toString()).rows;
  const input = path.join(f.root, 'compact.csv'), evidence = path.join(f.root, 'source.scan.json');
  await writeFile(input, stringifyCsv(DEPRECATED_HEADERS, rows));
  await writeFile(evidence, JSON.stringify({ mode: 'deprecated', findings: rows, actionGroups: rows.map(row => ({ occurrences: [row] })) }));
  const task = await initTask(f.root, { projects: [f.project], mode: 'deprecated' });
  const { outputLayout: layout } = await importTaskCsv(task.taskFile, { projectPath: f.project, mode: 'deprecated', inputCsv: input, evidenceFiles: [evidence] });
  const prepared = await prepareProjectGroups({ taskFile: task.taskFile, projectPath: f.project, mode: 'deprecated' });
  assert.equal(prepared.groups.length, 1);
  const group = JSON.parse(await readFile(path.join(layout.deliveryDirectory, prepared.groups[0].record), 'utf8'));
  assert.equal(group.identity.ruleOrSymbol, 'CH1'); assert.equal(group.rowResults.length, 5);
});

test('report prepare keeps a project with missing scan output visible as partial delivery', async t => {
  const f = await prepared(t);
  await rm(f.layout.rawCsv);
  const output = path.join(f.root, 'report.json');
  await prepareReport({ taskFile: f.task.taskFile, mode: f.mode, output });
  const report = await renderReport({ taskFile: f.task.taskFile, mode: f.mode, data: JSON.parse(await readFile(output, 'utf8')) });
  assert.ok(report.gapCount > 0);
  const html = await readFile(report.output, 'utf8');
  assert.match(html, /原始行数未知/); assert.match(html, /尚未取得原始扫描/);
});

test('publication conflict and failed progress writes preserve HTML and support an unchanged retry', async t => {
  const f = await prepared(t); await assess(f);
  await csv(['write', '--task', f.task.taskFile, '--project', f.project, '--mode', f.mode]);
  const output = path.join(f.root, 'report.json'); await prepareReport({ taskFile: f.task.taskFile, mode: f.mode, output });
  const data = JSON.parse(await readFile(output, 'utf8'));
  const args = { taskFile: f.task.taskFile, mode: f.mode, data, output: path.join(f.root, 'report.html') };
  await assert.rejects(renderReport(args, { now: () => new Date('2026-11-11T16:59:00Z'), beforePublish: async () => {
    const p = JSON.parse(await readFile(f.layout.progressPath, 'utf8')); p.userNote = '并发修改'; await writeFile(f.layout.progressPath, JSON.stringify(p));
  } }), /同步.*app|进度.*变化/);
  const preserved = await readFile(args.output, 'utf8');
  assert.match(preserved, /报告生成时间 <time datetime="2026-11-11T16:59:00.000Z">2026-11-12 00:59:00（北京时间）<\/time>/);
  assert.equal(JSON.parse(await readFile(f.layout.progressPath, 'utf8')).userNote, '并发修改');
  const now = () => new Date('2026-11-12T01:00:00Z');
  await assert.rejects(renderReport(args, { now, updateProgress: async () => { throw new Error('模拟文件占用'); } }), /同步.*app/);
  const report = await renderReport(args, { now });
  assert.equal(report.rowCount, 5);
  assert.equal(await readFile(report.output, 'utf8'), preserved);
  await writeFile(report.output, '<html>用户改动</html>');
  await assert.rejects(renderReport(args, { now }), /已存在|另存/);
});

test('task inspection joins every duplicate row to its exact source and keeps originals read-only', async t => {
  const f = await prepared(t);
  const args = ['inspect', '--task', f.task.taskFile, '--project', f.project, '--mode', f.mode];
  const summary = await csv(args);
  assert.equal(summary.statistics.rowCount, 5);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.rows, undefined);
  const group = await csv([...args, '--group', summary.groups[0].id]);
  assert.equal(group.rows.length, 5);
  assert.equal(new Set(group.rows.map(r => r.rowId)).size, 5);
  assert.deepEqual(group.rows.map(r => r.codeLocation), Array.from({length:5}, (_,i) => `entry/src/A.ets:${i+1}`));
  assert.equal(group.group.version, '26.0.0(26) Beta1');
  // 整组相同的版本、来源只写在 group 上，空的 column/gaps 不逐行输出，未覆盖条目明细只在概要里。
  assert.ok(group.rows.every(r => r.physicalFile && Number.isInteger(r.line)
    && !['version','sourceReference','gaps','column','logicalRow'].some(key => Object.hasOwn(r, key))));
  assert.deepEqual(group.group.files.map(file => Object.keys(file)), [['path','rowCount']]);
  assert.equal(group.ruleGapReviews, undefined);
  const output = path.join(f.root, 'packet', 'group.json');
  const saved = await csv([...args, '--group', summary.groups[0].id, '--output', output]);
  assert.equal(saved.output, output);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {ok:true, result:group});
  await assert.rejects(csv([...args, '--group', 'foreign-group']), /分组/);
  await assert.rejects(csv([...args, '--output', f.layout.rawCsv]), /覆盖/);
  await assert.rejects(csv([...args, '--output', f.groupPath]), /覆盖/);
  const state = await csv(['validate', '--task', f.task.taskFile, '--project', f.project, '--mode', f.mode]);
  assert.equal(state.validationScope, 'STRUCTURE_ONLY');
  assert.deepEqual(await readFile(f.layout.rawCsv), f.raw);
});

test('inspection retains identical rows even when file locations are deduplicated', async t => {
  const f = await setup(t);
  const rows = parseCsv(f.raw.toString()).rows;
  rows[1]['Code Location'] = rows[0]['Code Location'];
  rows[2]['Code Location'] = rows[0]['Code Location'];
  const input = path.join(f.root, 'duplicates.csv'); await writeFile(input, stringifyCsv(UPGRADE_HEADERS, rows));
  const task = await initTask(f.root, {projects:[f.project]});
  await importTaskCsv(task.taskFile, {projectPath:f.project, mode:'upgrade', inputCsv:input});
  const options = ['--task', task.taskFile, '--project', f.project, '--mode', 'upgrade'];
  const prepared = await csv(['prepare', ...options]);
  const result = await csv(['inspect', ...options, '--group', prepared.groups[0].id]);
  assert.deepEqual(result.rows.slice(0,3).map(r => r.codeLocation), Array(3).fill('entry/src/A.ets:1'));
  assert.equal(new Set(result.rows.map(r => r.rowId)).size,5);
  assert.equal(result.statistics.rowCount,5);
});

test('unknown identities retain independent groups and explicit gaps in task inspection', async t => {
  const f = await setup(t, 'upgrade', 2), rows = parseCsv(f.raw.toString()).rows;
  for (const row of rows) row['Rule ID'] = '';
  const input = path.join(f.root, 'unknown.csv'); await writeFile(input, stringifyCsv(UPGRADE_HEADERS, rows));
  const task = await initTask(f.root, {projects:[f.project]});
  await importTaskCsv(task.taskFile, {projectPath:f.project, mode:'upgrade', inputCsv:input});
  const options = ['--task', task.taskFile, '--project', f.project, '--mode', 'upgrade'];
  await csv(['prepare', ...options]);
  const summary = await csv(['inspect', ...options]);
  assert.equal(new Set(summary.groups.map(g => g.id)).size,2);
  for (const group of summary.groups) {
    const packet = await csv(['inspect', ...options, '--group', group.id]);
    assert.equal(packet.rows.length,1);
    assert.ok(packet.rows[0].gaps.length > 0);
  }
});

test('validation diagnoses 2+15 pending rows without PENDING literals and exports immutable evidence', async t => {
  const f = await setup(t,'upgrade',20), rows = parseCsv(f.raw.toString()).rows;
  for (const [index,row] of rows.entries()) row['Rule ID'] = index < 2 ? 'CH1' : 'CH2';
  rows[1]['Code Location'] = rows[0]['Code Location'];
  const input = path.join(f.root,'two-groups.csv'); await writeFile(input,stringifyCsv(UPGRADE_HEADERS,rows));
  const task = await initTask(f.root,{projects:[f.project]});
  const {outputLayout:layout} = await importTaskCsv(task.taskFile,{projectPath:f.project,mode:'upgrade',inputCsv:input});
  const args = ['--task',task.taskFile,'--project',f.project,'--mode','upgrade'];
  const prepared = await csv(['prepare',...args]);
  const groupFiles = prepared.groups.map(ref => path.join(layout.deliveryDirectory,ref.record));
  for (const [index,file] of groupFiles.entries()) {
    const group = JSON.parse(await readFile(file,'utf8'));
    group.rowResults.forEach((row,i) => Object.assign(row,{
      category:'可选适配',outcome:index === 0 || i < 15 ? 'DECISION_REQUIRED' : 'NO_CHANGE',
      reason:'已有逐行判断，等待实际业务决定',next:'',changes:[],
    }));
    await writeFile(file,JSON.stringify(group,null,2));
  }
  const sources = [task.taskFile,layout.rawCsv,layout.progressPath,...groupFiles];
  const before = await Promise.all(sources.map(file => readFile(file)));
  const summary = await csv(['validate',...args]);
  assert.equal(summary.pendingCount,17);
  assert.deepEqual(summary.pendingGroups,prepared.groups.map((ref,index) => ({
    id:ref.id,record:ref.record,rowCount:index === 0 ? 2 : 18,pendingCount:index === 0 ? 2 : 15,
  })));
  assert.equal(summary.pendingRows,undefined);
  const detailed = await csv(['validate',...args,'--details']);
  assert.equal(detailed.pendingRows.length,17);
  assert.equal(new Set(detailed.pendingRows.map(row => row.rowId)).size,17);
  assert.ok(detailed.pendingRows.every(row => row.outcome === 'DECISION_REQUIRED' && row.category === '可选适配'
    && row.next === '' && row.pendingFields.join() === 'outcome' && row.groupId && row.record));
  const output = path.join(layout.deliveryDirectory,'evidence','只读诊断 #.json');
  const saved = await csv(['validate',...args,'--details','--output',output]);
  assert.equal(saved.pendingCount,17);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),{ok:true,result:detailed});
  await csv(['validate',...args,'--details','--output',output]);
  for (const source of [...sources,path.join(f.project,'entry','src','A.ets')])
    await assert.rejects(csv(['validate',...args,'--details','--output',source]),/覆盖/);
  const alias = path.join(f.root,'delivery alias');
  await symlink(layout.deliveryDirectory,alias,process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(csv(['validate',...args,'--output',path.join(alias,path.basename(layout.rawCsv))]),/覆盖/);
  assert.deepEqual(await Promise.all(sources.map(file => readFile(file))),before);
  await writeFile(output,'用户保留内容');
  await assert.rejects(csv(['validate',...args,'--details','--output',output]),/另存/);
  assert.equal(await readFile(output,'utf8'),'用户保留内容');
  const bad = JSON.parse(await readFile(groupFiles[0],'utf8')); bad.rowResults.push(bad.rowResults[0]);
  await writeFile(groupFiles[0],JSON.stringify(bad));
  const invalidOutput = path.join(f.root,'invalid-output.json');
  await assert.rejects(csv(['validate',...args,'--details','--output',invalidOutput]),{code:'GROUP_RESULTS_INVALID'});
  await assert.rejects(readFile(invalidOutput),{code:'ENOENT'});
});

for (const mode of ['upgrade','deprecated']) test(`${mode} diagnostics preserve zero and independent follow-up causes in LF/CRLF JSON`, async t => {
  const f = await prepared(t,mode), group = await assess(f);
  const args = ['--task',f.task.taskFile,'--project',f.project,'--mode',mode];
  const clear = await csv(['validate',...args,'--details']);
  assert.equal(clear.pendingCount,0); assert.deepEqual(clear.pendingGroups,[]); assert.deepEqual(clear.pendingRows,[]);
  await assert.rejects(csv(['validate',...args,'--details=invalid']),/boolean/);
  Object.assign(group.rowResults[0],{outcome:'NO_CHANGE',changes:[],next:'待核对本轮编译'});
  if (mode === 'upgrade') group.rowResults[1].category = '待分类';
  for (const newline of ['\n','\r\n']) {
    await writeFile(f.groupPath,JSON.stringify(group,null,2).replaceAll('\n',newline));
    const before = await readFile(f.groupPath);
    const diagnostic = await csv(['validate',...args,'--details']);
    assert.equal(diagnostic.pendingCount,mode === 'upgrade' ? 2 : 1);
    assert.deepEqual(diagnostic.pendingRows[0].pendingFields,['next']);
    if (mode === 'upgrade') assert.deepEqual(diagnostic.pendingRows[1].pendingFields,['category']);
    assert.deepEqual(await readFile(f.groupPath),before);
  }
  group.rowResults[0].outcome = 'EVIDENCE_GAP';
  if (mode === 'upgrade') group.rowResults[0].category = '待分类';
  await writeFile(f.groupPath,JSON.stringify(group));
  const combined = await csv(['validate',...args,'--details']);
  assert.equal(combined.pendingCount,mode === 'upgrade' ? 2 : 1);
  assert.deepEqual(combined.pendingRows[0].pendingFields,mode === 'upgrade' ? ['outcome','next','category'] : ['outcome','next']);
});

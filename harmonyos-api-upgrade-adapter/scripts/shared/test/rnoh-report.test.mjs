import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initTask, beginTaskScan, completeTaskScan } from '../platform/task-context.mjs';
import { stringifyCsv, UPGRADE_HEADERS } from '../format/csv.mjs';
import { renderReport } from '../../report/render.mjs';
import { main as csv } from '../../csv/cli.mjs';

const base = { 'Changed in SDK': '26.0.0(26) Release', 'Affected Versions': '', Language: 'ArkTS', 'Change Type': 'Behavior Change', 'Replacement API': '', 'Replacement Source': '' };
const nativeRow = { ...base, 'Api Definition': 'Image.autoResize', Title: '原生变更', 'Code Location': 'entry/src/main/ets/A.ets:1', 'Rule ID': 'CH1', 'Source Reference': 'x.md:1' };
const rnohRow = { ...base, 'Api Definition': 'Image resizeMethod', Title: 'Image组件autoResize默认值变更', 'Code Location': '../src/App.tsx:1',
  'Rule ID': 'RNOH-image-auto-resize-default', 'Source Reference': 'changelogs/26.md:10', Language: 'TypeScript' };

async function report(t, rows, rnoh) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rnoh-report-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harmony = path.join(root, 'harmony');
  await mkdir(path.join(harmony, 'entry', 'src', 'main', 'ets'), { recursive: true });
  await writeFile(path.join(harmony, 'build-profile.json5'), '{modules:[{name:"entry",srcPath:"./entry"}]}');
  await writeFile(path.join(harmony, 'entry', 'src', 'main', 'module.json5'), '{module:{type:"entry"}}');
  await writeFile(path.join(harmony, 'entry', 'src', 'main', 'ets', 'A.ets'), 'source');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'App.tsx'), '<Image resizeMethod="resize" />');
  const mode = 'upgrade', task = await initTask(root, { projects: [harmony], mode });
  const layout = await beginTaskScan(task.taskFile, { projectPath: harmony, mode });
  await mkdir(path.dirname(layout.workRawCsv), { recursive: true });
  await mkdir(layout.scannerDirectory, { recursive: true });
  await writeFile(layout.workRawCsv, stringifyCsv(UPGRADE_HEADERS, rows));
  await writeFile(layout.scanJson, JSON.stringify({ mode, batchId: layout.batchId, findings: rows, ...(rnoh ? { rnoh } : {}) }));
  await completeTaskScan(task.taskFile, layout.batchId);
  const args = ['--task', task.taskFile, '--project', harmony, '--mode', mode];
  const prepared = await csv(['prepare', ...args]);
  for (const group of prepared.groups) {
    const draftFile = path.join(root, `draft-${group.id}.json`);
    await csv(['draft-assessment', ...args, '--group', group.id, '--output', draftFile]);
    const draft = JSON.parse(await readFile(draftFile, 'utf8'));
    draft.items = [{ rowIds: draft.items[0].rowIds, category: '无需适配', outcome: 'NO_CHANGE', reason: '未触发变更条件',
      compatibility: 'target26', evidence: ['源码已读'], changes: [], next: '' }];
    await writeFile(draftFile, JSON.stringify(draft));
    await csv(['import-assessment', ...args, '--group', group.id, '--input', draftFile]);
  }
  const progress = JSON.parse(await readFile(layout.progressPath, 'utf8'));
  await writeFile(layout.progressPath, JSON.stringify({ ...progress, versions: { oldTarget: '12', target: '26', compatible: '12' } }));
  const result = await renderReport({ taskFile: task.taskFile, mode });
  const html = await readFile(result.output, 'utf8');
  const start = html.indexOf('<section class="panel" aria-labelledby="project-0">');
  return { result, html, args, groups: prepared.groups, project: html.slice(start, html.indexOf('<section class="panel" aria-labelledby="follow-up-title">')) };
}

const headings = body => [...body.matchAll(/<h3[^>]*>([^<]+)<span class="caption">/g)].map(match => match[1].trim());

test('non-RNOH reports contain no RNOH chapter or wording', async t => {
  const { project, html } = await report(t, [nativeRow]);
  assert.deepEqual(headings(project), ['1. DevEco 规则包覆盖条目', '2. 独立验证']);
  assert.doesNotMatch(html, /RNOH/);
});

test('RNOH reports move RNOH rows into a separate chapter with framework summary', async t => {
  const rnoh = { schemaVersion: 1, status: 'COMPLETE', jsRoot: '..',
    native: [{ version: '0.84.5', form: 'DEBUG_SOURCE', directory: 'oh_modules/x' }],
    js: { root: '..', packageName: '@react-native-oh/react-native-harmony', installedVersion: '0.84.5', reactNativeVersion: '0.84.0' },
    coverage: { native: 'SCANNED', rnohJs: 'SCANNED', business: 'SCANNED', host: 'SCANNED' }, gaps: ['示例缺口 <&>'],
    rules: [{ ruleId: 'RNOH-image-auto-resize-default', title: 'Image组件autoResize默认值变更', changedInSdk: '26.0.0(26) Release', businessCount: 1, status: 'MATCHED',
      framework: { status: 'CONFIRMED', count: 1, locations: [{ layer: 'native', api: 'NODE_IMAGE_AUTO_RESIZE', location: 'oh_modules/x/ImageNode.cpp:4' }] } },
      { ruleId: 'RNOH-jsvm-jit-default-off', title: 'JIT默认关闭', changedInSdk: '5.1.0(18) Release', businessCount: 0, status: 'FRAMEWORK_ONLY',
        framework: { status: 'CONFIRMED', count: 1, locations: [{ layer: 'native', api: 'OH_JSVM_Init', location: 'oh_modules/x/JSVM.cpp:9' }] } }],
    uncoveredEntries: [{ title: '无规则条目', changedInSdk: '26.0.0(26) Release', sourceReference: 'changelogs/26.md:20' }] };
  const { project, result, args, groups } = await report(t, [nativeRow, rnohRow], rnoh);
  assert.equal(result.rowCount, 2);
  // RNOH 组的只读输入自带框架依据和版本基线，原生组不带任何 RNOH 字段。
  const packets = await Promise.all(groups.map(group => csv(['inspect', ...args, '--group', group.id])));
  const rnohPacket = packets.find(packet => packet.group.ruleId === 'RNOH-image-auto-resize-default');
  assert.deepEqual(rnohPacket.rnoh, { native: rnoh.native, js: rnoh.js, jsRoot: '..', coverage: rnoh.coverage, gaps: rnoh.gaps,
    framework: rnoh.rules[0].framework, ruleStatus: 'MATCHED' });
  assert.ok(packets.filter(packet => packet !== rnohPacket).every(packet => !Object.hasOwn(packet, 'rnoh')));
  assert.doesNotMatch(project, /代码位置无法解析/);
  assert.deepEqual(headings(project), ['1. DevEco 规则包覆盖条目', '2. RNOH 业务影响分析', '3. 独立验证']);
  assert.match(project, /<details class="report-fold"><summary><h3 id="rnoh-0">2\. RNOH 业务影响分析 <span class="caption">· 业务位置 1 行/);
  const main = project.slice(project.indexOf('1. DevEco'), project.indexOf('2. RNOH'));
  const section = project.slice(project.indexOf('2. RNOH'), project.indexOf('3. 独立验证'));
  assert.match(main, /entry\/src\/main\/ets\/A\.ets:1/);
  assert.doesNotMatch(main, /App\.tsx|RNOH-/);
  assert.match(section, /0\.84\.5（源码）/);
  assert.match(section, /react-native 0\.84\.0/);
  assert.match(section, /RN 业务 JS 受影响位置[\s\S]*1 行，涉及 1 项变更/);
  assert.match(section, /框架整体影响（无对应业务代码位置）[\s\S]*RNOH-jsvm-jit-default-off[\s\S]*JSVM\.cpp:9/);
  assert.doesNotMatch(section, /<tr[^>]*>[\s\S]*?oh_modules[\s\S]*?<\/tr>/);
  assert.match(section, /示例缺口 &lt;&amp;&gt;/);
  // 未登记 U04a 结论时：框架整体影响规则和无规则条目都标为待核对，并计入遗留事项。
  assert.match(section, /RNOH-jsvm-jit-default-off[\s\S]*?<strong>待核对<\/strong>/);
  assert.match(section, /逐条核对 0 项，成组排除 0 项，待核对 2 项[\s\S]*待核对 · 1 项[\s\S]*无规则条目/);
  assert.equal((await csv(['validate', ...args])).rnohReviewPendingCount, 2);
  const root = path.dirname(path.dirname(args[3])), put = async (name, value) => {
    const file = path.join(root, name); await writeFile(file, JSON.stringify(value)); return file;
  };
  const record = async (name, value) => csv(['record-rnoh-review', ...args, '--input', await put(name, value)]);
  const jit = { id: 'RNOH-jsvm-jit-default-off', conclusion: 'NOT_AFFECTED', layer: 'RNOH 原生框架', condition: '未隔离',
    evidence: ['oh_modules/x/JSVM.cpp:9'], evidenceLevel: '实证', summary: '默认使用 Hermes，JIT 关闭不影响 RN 页面' };
  await assert.rejects(record('bad-id.json', { excluded: [{ reason: '依据', entries: ['changelogs/unknown.md:1'] }] }), /不在补充核对清单中/);
  await assert.rejects(record('bad-dup.json', { excluded: [{ reason: '依据', entries: ['RNOH-jsvm-jit-default-off'] }], reviews: [jit] }), /重复出现/);
  await assert.rejects(record('bad-affected.json', { reviews: [{ ...jit, conclusion: 'AFFECTED' }] }), /proposal/);
  await assert.rejects(record('bad-field.json', { reviews: [{ ...jit, verdict: 'x' }] }), /本操作可用字段/);
  const first = await record('exclude.json', { excluded: [{ reason: '属于方舟运行时变更，业务 JS 运行于 Hermes，不涉及', entries: ['changelogs/26.md:20', 'RNOH-jsvm-jit-default-off'] }] });
  assert.deepEqual([first.rnohReviewExcludedCount, first.rnohReviewPendingCount], [2, 0]);
  // 之后提交独立结论：同一条目以最后一次为准，并从排除组里移除；三方库用 lib: 前缀附加登记。
  const second = await record('review.json', { reviews: [jit, { id: 'lib:@react-native-oh-tpl/x', conclusion: 'NEEDS_DEVICE_VERIFICATION', layer: '三方 RN 鸿蒙库',
    condition: 'target ≥ 26', evidence: ['oh-package.json5:12'], evidenceLevel: '需真机验证', summary: 'release HAR，无法静态核对' }] });
  assert.deepEqual([second.rnohReviewAssessedCount, second.rnohReviewExcludedCount, second.rnohReviewPendingCount, second.libraryCount], [1, 1, 0, 1]);
  assert.equal((await csv(['inspect', ...args])).rnohReviewPendingCount, 0);
  const rendered = await readFile((await renderReport({ taskFile: args[1], mode: 'upgrade' })).output, 'utf8');
  assert.match(rendered, /RNOH-jsvm-jit-default-off[\s\S]*?<strong>不影响 RN 页面<\/strong>（实证）：默认使用 Hermes/);
  assert.match(rendered, /逐条核对 1 项，成组排除 1 项，待核对 0 项/);
  assert.match(rendered, /已排除 · 1 项 · 属于方舟运行时变更[\s\S]*无规则条目/);
  assert.match(rendered, /三方 RN 鸿蒙库<\/h4>[\s\S]*@react-native-oh-tpl\/x[\s\S]*需真机验证/);
  assert.match(rendered, /RNOH 补充核对 · lib:@react-native-oh-tpl\/x：需真机验证/);
  assert.match(section, /id="r0-g0"[\s\S]*\.\.\/src\/App\.tsx:1/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { initTask, importTaskCsv, registerTaskProject, beginTaskScan, completeTaskScan } from '../platform/task-context.mjs';
import { parseCsv, stringifyCsv, UPGRADE_HEADERS, DEPRECATED_HEADERS, hyperlink } from '../format/csv.mjs';
import { formatUpgradeResults } from '../format/upgrade-results.mjs';
import { formatDeprecatedResults } from '../format/deprecated-results.mjs';
import { sha256 } from '../io/fs-utils.mjs';
import { renderReport, validateReportHtml } from '../../report/render.mjs';
import { prepareReport } from '../../report/prepare.mjs';
import { main as csvTool } from '../../csv/cli.mjs';
import { compareRulePackEntries } from '../../scanner/behavior/upgrade-coverage.mjs';
import { createOfficialBehaviorReader } from '../../report/official-behavior.mjs';

const row = { 'Code Location': 'entry/src/A.ets:1', Title: '原始 <标题>', 'Changed in SDK': '26.0.0(26) Release', 'Rule ID': 'CH1' };

for (const kind of ['historical timeout', 'partial scan', 'partial scan with candidates']) test(`report displays ${kind} and separate Stage exclusions`, async t => {
  const legacy = kind === 'historical timeout';
  const candidates = kind === 'partial scan with candidates';
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'report-scan-evidence-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'build-profile.json5'), '{modules:[]}');
  const mode = 'upgrade', task = await initTask(root, { projects: [root], mode });
  const layout = await beginTaskScan(task.taskFile, { projectPath: root, mode });
  await mkdir(path.dirname(layout.workRawCsv), { recursive: true });
  await mkdir(layout.scannerDirectory, { recursive: true });
  const raw = stringifyCsv(UPGRADE_HEADERS, []);
  const status = legacy ? 'TIMED_OUT' : 'PARTIAL';
  const nativePasses = [{ modules: ['ar_measure'], status, durationMs: 3000,
    ...(legacy ? {} : { skippedFiles: ['ar_measure/src/slow<&>.cpp'] }) }];
  const textCandidates = candidates ? [{ module: 'ar_measure', ruleId: 'CH-CANDIDATE', api: 'fstat<T>()', location: 'ar_measure/src/slow<&>.cpp:17' }] : [];
  const applicability = { excluded: [{ title: 'ArkUI接口新增仅支持Stage模型的约束', ruleId: 'CH2026010615012',
    url: 'https://developer.huawei.com/example#ch2026010615012', reason: 'STAGE_MODEL_CONFIRMED',
    applicabilityProof: { modules: ['ar_measure'], configurations: [{ file: path.join(root, 'AppScope', 'app.json5') }] } }] };
  await writeFile(layout.workRawCsv, raw);
  await writeFile(layout.scanJson, JSON.stringify({ mode, batchId: layout.batchId, findings: [],
    ...(legacy ? {} : { scanCoverage: { cpp: status, nativePasses, textCandidates }, projectApplicability: applicability,
      codeSize: { total: { physicalLines: 31, codeLines: 21 }, byLanguage: {}, byModule: [] } }) }));
  if (legacy) {
    await writeFile(layout.coverageJson, JSON.stringify({ scanCoverage: { cpp: status }, projectApplicability: applicability }));
    await writeFile(layout.diagnosticsJson, JSON.stringify({ nativePasses }));
  }
  await completeTaskScan(task.taskFile, layout.batchId);
  await writeFile(layout.progressPath, JSON.stringify({ groups: [], decisions: {}, delivery: {},
    versions: { oldTarget: '20', target: '26', compatible: '20' } }));
  const report = await renderReport({ taskFile: task.taskFile, mode });
  const html = await readFile(report.output, 'utf8');
  assert.match(html, legacy ? /ar_measure 的 C\/C\+\+ 语义扫描超时/ : /ar_measure 的 C\/C\+\+ 语义扫描部分完成，跳过 1 个文件/);
  assert.match(html, /按工程适用性排除[\s\S]*CH2026010615012[\s\S]*已确认采用 Stage 模型。适用范围 ar_measure/);
  assert.doesNotMatch(html, /配置依据|AppScope\/app.json5/);
  assert.doesNotMatch(html, /代码量|physicalLines|codeLines/);
  const followUpStart = html.indexOf('<section class="panel" aria-labelledby="follow-up-title">');
  const projectBody = html.slice(html.indexOf('<section class="panel" aria-labelledby="project-0">'), followUpStart);
  const followUp = html.slice(followUpStart);
  assert.deepEqual([...projectBody.matchAll(/<h3[^>]*>([^<]+)<span class="caption">/g)].map(match => match[1].trim()),
    ['1. 按工程适用性排除', '2. DevEco 规则包覆盖条目', '3. 独立验证']);
  assert.doesNotMatch(projectBody, /扫描覆盖|配置实施|扫描证据/);
  if (candidates) {
    assert.match(projectBody, /DevEco 规则包覆盖条目[\s\S]*<details><summary>C\/C\+\+ 文本候选 · 1 条（待人工核对）<\/summary>[\s\S]*CH-CANDIDATE[\s\S]*fstat&lt;T&gt;\(\)[\s\S]*slow&lt;&amp;&gt;\.cpp:17[\s\S]*独立验证/);
  } else assert.doesNotMatch(projectBody, /C\/C\+\+ 文本候选/);
  assert.match(followUp, /<summary id="follow-up-issues-0">遗留事项 · 1 条<\/summary>/);
  assert.match(followUp, /<li>ar_measure 的 C\/C\+\+ 语义扫描[^<]*覆盖不完整 <span class="caption">· 扫描证据 <a href="[^"]+\.scan\.json">[^<]+<\/a>/);
  assert.doesNotMatch(followUp, /<summary>扫描覆盖|DevEco 规则包覆盖：|<summary>跳过文件|耗时 3.0 秒|C\/C\+\+ 文本候选|CH-CANDIDATE/);
  assert.equal((followUp.match(/覆盖不完整/g) ?? []).length, 1);
  assert.equal(report.gapCount, 1);
  assert.equal(report.rowCount, 0);
  assert.equal(await readFile(layout.rawCsv, 'utf8'), raw);
  const verify = ['verify', '--task', task.taskFile, '--project', root, '--mode', mode];
  assert.equal((await csvTool(verify)).reportSourceStatus, 'MATCH');
  if (legacy) {
    assert.match(html, /diagnostics\.json/);
    await writeFile(layout.diagnosticsJson, JSON.stringify({ nativePasses: [] }));
    await assert.rejects(csvTool(verify), /报告来源已变化/);
  }
});

async function setup(t, mode, rows = [row, row]) {
  const root = await mkdtemp(path.join(os.tmpdir(), '适配报告 中文 # &-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'app'), module = path.join(project, 'entry');
  await mkdir(path.join(module, 'src', 'main'), { recursive: true });
  await writeFile(path.join(project, 'build-profile.json5'), '{modules:[{name:"entry",srcPath:"./entry"}]}');
  await writeFile(path.join(module, 'src', 'main', 'module.json5'), '{module:{type:"entry"}}');
  await writeFile(path.join(module, 'src', 'A.ets'), 'source');
  const task = await initTask(root, { projects: [project], mode });
  const raw = Buffer.from(stringifyCsv(mode === 'upgrade' ? UPGRADE_HEADERS : DEPRECATED_HEADERS, rows));
  const input = path.join(root, 'input.csv'); await writeFile(input, raw);
  const imported = await importTaskCsv(task.taskFile, { projectPath: project, inputCsv: input, mode });
  const layout = imported.outputLayout;
  const decisions = rows.map((_, i) => ({ rowId: `${sha256(raw)}:${i + 1}`, 评估结论: i === 0 ? '可选适配' : '待分类',
    处理结论: mode === 'upgrade' ? '无需适配' : 'NO_CHANGE',
    处理来源: 'MODEL_ASSESSED', 业务影响: '本行业务影响', 处理说明: '<script>alert("x")</script> & 理由', 兼容性说明: '本行兼容依据', 变更文件: '', 验证证据: '真实证据标识', 后续事项: '' }));
  const csv = mode === 'upgrade' ? formatUpgradeResults(raw, decisions) : formatDeprecatedResults(raw, decisions);
  await writeFile(layout.adaptedCsv, csv);
  await mkdir(path.join(layout.deliveryDirectory, 'groups'));
  await writeFile(path.join(layout.deliveryDirectory, 'groups', 'actual.json'), JSON.stringify({ files: [{ rowIds: decisions.map(d => d.rowId) }],
    rowClassifications: decisions.length ? [{ category: '可选适配', rowIds: [decisions[0].rowId] }] : [] }));
  await writeFile(layout.progressPath, JSON.stringify({ groups: [{ record: 'groups/actual.json' }, { record: 'groups/missing.json' }] }));
  const pending = path.join(root, 'pending'); await mkdir(pending);
  await registerTaskProject(task.taskFile, { projectPath: pending, mode });
  await prepareReport({ taskFile: task.taskFile, mode, output: path.join(root, 'prepared-report.json') });
  const data = { title: '真实报告 <&>', projects: [{ projectKey: 'app', configuration: { oldTarget: '22', target: '26', compatible: '19' },
    rowClassifications: rows.length ? [{ category: '可选适配', rowIds: [decisions[0].rowId] }] : [],
    changes: [{ ruleId: 'CH1', version: row['Changed in SDK'], before: '原行为', after: '新行为', targetIsolation: 'target26',
      business: '实际业务', approval: '接受新行为', compatibility: '保持', gaps: '无新增' }],
    verification: [{ name: '编译', status: '未执行', details: '没有本轮真实回执', evidence: ['missing.log'] }] }] };
  return { root, task, layout, decisions, data, raw };
}

test('uncovered rules follow the user choice and report independently of CSV rows', async t => {
  const f = await setup(t, 'upgrade', []);
  const entry = { document:'26.0.0/release.md',startLine:1,endLine:5,documentSha256:'source',
    title:'独立变更',version:'26.0.0(26) Release',channel:'Release',sourceUrl:'https://example.test/change' };
  const query = {entries:[entry],unplacedEntries:[],warnings:[],total:1,interval:'(from,to]',from:'6.1.0(23) Release',to:entry.version};
  const inventory = [{sourceReference:'26.0.0/release.md:1',changedInSdk:entry.version,hasAffectedApis:false,changeId:'present'}];
  const options = ['--task',f.task.taskFile,'--project',path.join(f.root,'app'),'--mode','upgrade'];
  const ruleSource = path.join(f.root, 'rule-source.json');
  const decisionInput = path.join(f.root, 'rule-gap-decision.json');
  const decisionReceipt = path.join(f.root, 'rule-gap-decision-receipt.json');
  const decisionCommand = ['record-rule-gap-decision', ...options, '--input', decisionInput];
  const saveDecision = (basis, action, answer) =>
    writeFile(decisionInput, JSON.stringify({basis, action, answer, source: '用户答复 #1'}));
  const saveComparison = async (inventory, unplacedEntries = []) => {
    const officialComparison = {
      ...compareRulePackEntries({...query, unplacedEntries}, inventory),
      sources: [{file: ruleSource, hash: sha256(await readFile(ruleSource))}],
    };
    await mkdir(path.dirname(f.layout.scanJson),{recursive:true});
    await writeFile(f.layout.scanJson,JSON.stringify({mode:'upgrade',batchId:f.layout.batchId,findings:[],officialComparison}));
  };
  const render = async () => {
    const report = await renderReport({taskFile: f.task.taskFile, mode: 'upgrade'});
    assert.equal(report.rowCount, 0);
    return readFile(report.output, 'utf8');
  };
  await writeFile(f.layout.progressPath,JSON.stringify({groups:[],decisions:{},delivery:{}}));
  assert.equal((await csvTool(['inspect', ...options])).ruleGapBasis, undefined);
  await writeFile(ruleSource, 'original rule source');
  await saveComparison(inventory);
  assert.equal((await csvTool(['prepare-rule-gaps',...options])).required,false);
  const covered = await csvTool(['inspect', ...options]);
  assert.equal(covered.ruleGapDecisionRequired, false);
  assert.equal(covered.ruleGapCount, 0);
  await saveDecision(covered.ruleGapBasis, 'SKIP', '否');
  await assert.rejects(csvTool(decisionCommand), /没有确认未覆盖的条目/);
  assert.doesNotMatch(await render(), /id="rule-gap-/);

  const unplacedEntries = [{...entry, startLine: 7, title: '阶段待核对'}];
  await saveComparison([], unplacedEntries);
  const pending = await csvTool(['inspect', ...options]);
  assert.equal(pending.ruleGapDecisionRequired, true);
  assert.equal(pending.ruleGapPendingCount, 1);
  assert.equal(pending.ruleComparisonPendingCount, 1);
  await assert.rejects(csvTool(['prepare-rule-gaps', ...options]), /先取得用户/);
  assert.match(await render(), /共 1 项。待用户决定是否补充评估。/);
  await saveDecision(pending.ruleGapBasis, 'SKIP', '');
  await assert.rejects(csvTool(decisionCommand), /实际答复/);
  await saveDecision(pending.ruleGapBasis, 'SKIP', '否，跳过补充评估');
  const skipped = await csvTool([...decisionCommand, '--receipt-output', decisionReceipt]);
  assert.equal(skipped.ruleGapSkippedCount, 1);
  assert.deepEqual(JSON.parse(await readFile(decisionReceipt, 'utf8')).result, skipped);
  assert.deepEqual(skipped.ruleGapReviewDecision, {basis: pending.ruleGapBasis, action: 'SKIP', answer: '否，跳过补充评估', source: '用户答复 #1'});
  assert.equal(JSON.parse(await readFile(f.layout.progressPath, 'utf8')).ruleGapReviews, undefined);
  await assert.rejects(csvTool(['prepare-rule-gaps', ...options]), /用户已选择跳过/);
  await assert.rejects(csvTool(['record-rule-gap-review', ...options, '--input', decisionInput]), /用户已选择跳过/);
  await assert.rejects(csvTool(['verify', ...options]), /报告来源批准记录已变化/);

  const skippedHtml = await render();
  assert.match(skippedHtml, /共 1 项。用户选择跳过补充评估。/);
  assert.doesNotMatch(skippedHtml, /独立变更|独立评估依据|补充分析、决定或修复尚未完成/);
  assert.match(skippedHtml, /仍有 1 项映射或阶段待核对/);
  for (const command of ['validate', 'verify']) {
    const result = await csvTool([command, ...options]);
    assert.equal(result.ruleGapCount, 1);
    assert.equal(result.ruleGapSkippedCount, 1);
    assert.equal(result.ruleGapAssessedCount, 0);
    assert.equal(result.ruleGapPendingCount, 0);
    assert.equal(result.pendingCount, 0);
    assert.equal(result.ruleComparisonPendingCount, 1);
    assert.equal(result.rowCount, 0);
  }
  assert.deepEqual(await readFile(f.layout.rawCsv), f.raw);

  await writeFile(ruleSource, 'updated rule source');
  const stale = await csvTool(['inspect', ...options]);
  assert.equal(stale.ruleComparisonSourceStale, true);
  assert.equal(stale.ruleGapReviewDecision, null);
  assert.equal(stale.ruleGapDecisionRequired, false);
  assert.equal(stale.ruleGapSkippedCount, 0);
  await assert.rejects(csvTool(decisionCommand), /规则包来源已变化/);
  const staleHtml = await render();
  assert.match(staleHtml, /比对来源已变化，需重新核对/);
  assert.doesNotMatch(staleHtml, /用户选择跳过补充评估/);

  await saveComparison([], unplacedEntries);
  const current = await csvTool(['inspect', ...options]);
  assert.notEqual(current.ruleGapBasis, pending.ruleGapBasis);
  assert.equal(current.ruleGapDecisionRequired, true);
  await assert.rejects(csvTool(decisionCommand), /比对摘要已变化/);
  await saveDecision(current.ruleGapBasis, 'REVIEW', '是');
  assert.equal((await csvTool(decisionCommand)).ruleGapReviewDecision.action, 'REVIEW');
  const prepared = await csvTool(['prepare-rule-gaps',...options]);
  assert.equal(prepared.required,true); assert.equal(prepared.ruleGapCount,1);
  const input = path.join(f.root,'review.json');
  await writeFile(input,JSON.stringify({id:prepared.entries[0].id,category:'无需适配',reason:'直接核对当前源码，未使用该能力',
    evidence:['SDK 与当前工程核验'],files:[path.join(f.root,'app','entry','src','A.ets')]}));
  await csvTool(['record-rule-gap-review',...options,'--input',input]);
  await saveDecision(current.ruleGapBasis, 'SKIP', '否');
  await assert.rejects(csvTool(decisionCommand), /已有补充评估或修复记录/);
  const historical = JSON.parse(await readFile(f.layout.progressPath, 'utf8'));
  delete historical.decisions.ruleGapReview;
  await writeFile(f.layout.progressPath, JSON.stringify(historical));
  assert.equal((await csvTool(['inspect', ...options])).ruleGapDecisionRequired, false);
  const html = await render();
  assert.match(html,/DevEco 规则包未覆盖条目补充处理/);
  assert.match(html, /id="rule-gap-0">[^<]+<span class="caption">· 1 项 · 未完成 0 项<\/span><\/h3><\/summary><article/);
  assert.doesNotMatch(html, /共 1 项，已评估 1 项，未完成 0 项/);
  assert.match(html,/直接核对当前源码/);
  const verified = await csvTool(['verify',...options]);
  assert.equal(verified.ruleGapAssessedCount, 1);
  assert.equal(verified.ruleGapSkippedCount, 0);
  assert.equal(verified.ruleGapPendingCount, 0);
  await writeFile(path.join(f.root,'app','entry','src','A.ets'),'changed source');
  await assert.rejects(csvTool(['verify',...options]),/变化|过期/);
});

for (const mode of ['upgrade', 'deprecated']) test(`${mode} report keeps template styles, duplicate rows, gaps and separate classifications`, async t => {
  const { task, layout, decisions, data, raw } = await setup(t, mode);
  const result = await renderReport({ taskFile: task.taskFile, mode, data });
  const html = await readFile(result.output, 'utf8');
  assert.match(html, /<title>真实报告 &lt;&amp;&gt;<\/title>/);
  assert.match(html, /<h1>真实报告 &lt;&amp;&gt;<\/h1>/);
  assert.match(html, /<head>[\s\S]*<style>[\s\S]*<\/style>[\s\S]*<\/head>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; 理由/);
  assert.doesNotMatch(html, /<script\b|模板预览|待填写/);
  assert.match(html, /pending/); assert.match(html, /原始行数未知/); assert.match(html, /data-label="工程"/); assert.match(html, /groups[/\\]missing.json/);
  assert.match(html, /证据缺失/); assert.match(html, /未执行/);
  if (mode === 'upgrade') {
    assert.equal((html.match(/id="follow-up-title"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<summary>来源、缺口与后续事项/);
    assert.match(html, /app（仅导入 CSV，范围未核实）<\/strong>/);
    assert.match(html, /pending（未扫描）<\/strong><span>· target 未知 → 未知<\/span><span>· 最低兼容 未知<\/span>/);
    assert.match(html, /1\. CSV 导入条目/);
    assert.match(html, /配置记录待补齐：原 target、目标 target、compatible<\/li>/);
  } else {
    assert.match(html, /<summary>来源、缺口与后续事项/);
    assert.doesNotMatch(html, /id="follow-up-title"/);
  }
  assert.equal(result.rowCount, 2);
  for (const d of decisions) assert.equal(html.split(`data-row-id="${d.rowId}"`).length - 1, 1);
  if (mode === 'upgrade') { assert.match(html, /可选适配/); assert.match(html, /待分类/); }
  else { assert.match(html, /本行兼容依据/); assert.match(html, /本行业务影响/); assert.match(html, /真实证据标识/); assert.match(html, /MODEL_ASSESSED/); }
  assert.equal((await renderReport({ taskFile: task.taskFile, mode, data })).sha256, result.sha256);
  assert.deepEqual(await readFile(layout.rawCsv), raw);
});

test('行为报告首屏按已记录扫描范围和版本生成，限定目录与模块取交集', async t => {
  const { root, task, layout } = await setup(t, 'upgrade', []);
  const project = await realpath(path.join(root, 'app'));
  const entry = path.join(project, 'entry');
  await writeFile(layout.progressPath, JSON.stringify({ groups: [], versions: {
    oldTarget: 'API 17', target: 'API 26', compatible: 'API 17 → API 20',
  } }));
  await mkdir(path.dirname(layout.scanJson), { recursive: true });
  const cases = [
    { roots: [project], scanDirs: [], label: 'app' },
    { roots: [entry], scanDirs: [], label: 'app（entry）' },
    { roots: [entry, path.join(project, 'other')],
      scanDirs: [path.join(entry, 'src', '目录 & 示例'), path.join(project, 'tools')],
      label: 'app（entry/src/目录 &amp; 示例）' },
    { roots: [entry], scanDirs: [project], label: 'app（entry）' },
  ];
  for (const { roots, scanDirs, label } of cases) {
    await writeFile(layout.scanJson, JSON.stringify({ mode: 'upgrade', batchId: layout.batchId,
      findings: [], sourceScope: { roots, scanDirs } }));
    const result = await renderReport({ taskFile: task.taskFile, mode: 'upgrade' });
    const html = await readFile(result.output, 'utf8');
    const hero = html.match(/<header class="hero">([\s\S]*?)<\/header>/)?.[1] ?? '';
    assert.match(html, /<title>API版本升级适配报告<\/title>/);
    assert.match(hero, /<h1>API版本升级适配报告<\/h1>/);
    assert.match(hero, /class="hero-status"/);
    assert.equal((hero.match(/class="hero-subtitle"/g) ?? []).length, 2);
    assert.ok(hero.includes(`<strong>${label}</strong><span>· target API 17 → API 26</span><span>· 最低兼容 API 17 → API 20</span>`));
  }
});

test('zero-row reports retain zero counts, and final HTML missing style tags is rejected', async t => {
  const { task, data } = await setup(t, 'upgrade', []);
  const result = await renderReport({ taskFile: task.taskFile, mode: 'upgrade', data });
  assert.equal(result.rowCount, 0);
  const html = await readFile(result.output, 'utf8');
  assert.doesNotThrow(() => validateReportHtml(html, []));
  assert.throws(() => validateReportHtml(html.replace(/<\/?style>/g, ''), []), /样式/);
  assert.throws(() => validateReportHtml(html.replace('<main', '<script>bad()</script><main'), []), /脚本/);
  assert.doesNotThrow(() => validateReportHtml(html.replace('</main>', '<p>onerror= 仅文本 &lt;script&gt;</p></main>'), []));
});

test('历史版本对象在页头与总览同源展示，配置变更使已交付报告过期', async t => {
  const { root, task, layout } = await setup(t, 'upgrade', []);
  const progress = { groups: [], versions: { oldTarget: '6.0.0(20)', target: '26.0.0',
    compatible: { old: '5.0.0(12)', current: '6.0.0(20)', note: '已回读 <&>' } },
    configurationImplementation: '已实施，实际 target 为 26.0.0' };
  await writeFile(layout.progressPath, JSON.stringify(progress));
  const result = await renderReport({ taskFile: task.taskFile, mode: 'upgrade' });
  const html = await readFile(result.output, 'utf8');
  assert.match(html, /最低兼容 5\.0\.0\(12\) → 6\.0\.0\(20\)<\/span>/);
  assert.match(html, /data-label="compatible">5\.0\.0\(12\) → 6\.0\.0\(20\)<\/td>/);
  assert.match(html, /data-label="target升级">6\.0\.0\(20\) → 26\.0\.0<\/td>/);
  assert.doesNotMatch(html, /\[object Object\]|配置实施|已实施，实际 target 为 26\.0\.0|已回读 &lt;&amp;&gt;/);
  const verify = ['verify', '--task', task.taskFile, '--project', path.join(root, 'app'), '--mode', 'upgrade'];
  assert.equal((await csvTool(verify)).reportSourceStatus, 'MATCH');
  const published = JSON.parse(await readFile(layout.progressPath, 'utf8'));
  assert.equal(published.configurationImplementation, progress.configurationImplementation);
  published.versions.compatible.note = '补充配置回读';
  await writeFile(layout.progressPath, JSON.stringify(published));
  await assert.rejects(csvTool(verify), /配置记录已变化/);
});

test('精简带说明的兼容版本，单值使用旧兼容记录并核对其来源', async t => {
  const { root, task, layout } = await setup(t, 'upgrade', []);
  const cases = [
    { compatible: '原值 6.0.0(20) → 计划 6.1.1(24)（API24，用户确认升级）', expected: '6.0.0(20) → 6.1.1(24)' },
    { oldCompatible: '5.0.0(12)', compatible: '6.0.0(20)', expected: '5.0.0(12) → 6.0.0(20)' },
    { oldCompatible: '6.0.0(20)', compatible: '6.0.0(20)', expected: '6.0.0(20)' },
    { oldCompatible: 'API 20', compatible: '6.0.0(20)', expected: '6.0.0(20)' },
    { oldCompatible: '6.0.0(20)', compatible: '等待用户决定', expected: '未知' },
  ];
  for (const { expected, ...values } of cases) {
    await writeFile(layout.progressPath, JSON.stringify({ groups: [], versions: { oldTarget: '20', target: '26', ...values } }));
    const report = await renderReport({ taskFile: task.taskFile, mode: 'upgrade' });
    const html = await readFile(report.output, 'utf8');
    assert.ok(html.includes(`最低兼容 ${expected}</span>`));
    assert.ok(html.includes(`data-label="compatible">${expected}</td>`));
  }
  const verify = ['verify', '--task', task.taskFile, '--project', path.join(root, 'app'), '--mode', 'upgrade'];
  const current = JSON.parse(await readFile(layout.progressPath, 'utf8'));
  current.versions.compatible = '6.1.1(24)';
  await writeFile(layout.progressPath, JSON.stringify(current));
  await renderReport({ taskFile: task.taskFile, mode: 'upgrade' });
  assert.equal((await csvTool(verify)).reportSourceStatus, 'MATCH');
  const published = JSON.parse(await readFile(layout.progressPath, 'utf8'));
  published.versions.oldCompatible = '5.0.0(12)';
  await writeFile(layout.progressPath, JSON.stringify(published));
  await assert.rejects(csvTool(verify), /配置记录已变化/);
});

test('deprecated reports accept plain and historical linked titles while rejecting label changes', async t => {
  const title = '中文,"引号"\n下一行';
  const linked = hyperlink('https://example.test/deprecated', title);
  const { task, layout, data, raw } = await setup(t, 'deprecated', [{ ...row, Title: linked }, { ...row, Title: linked }]);
  const result = await renderReport({ taskFile: task.taskFile, mode: 'deprecated', data });
  const html = await readFile(result.output, 'utf8');
  assert.ok(html.includes('href="https://example.test/deprecated"'));
  assert.ok(html.includes('中文,&quot;引号&quot;\n下一行'));
  assert.equal(result.rowCount, 2);
  const adapted = parseCsv(await readFile(layout.adaptedCsv, 'utf8'));
  assert.deepEqual(adapted.rows.map(r => r.Title), [title, title]);
  for (const r of adapted.rows) r.Title = linked;
  await writeFile(layout.adaptedCsv, stringifyCsv(adapted.headers, adapted.rows));
  assert.equal((await renderReport({ taskFile: task.taskFile, mode: 'deprecated', data })).rowCount, 2);
  adapted.rows[1].Title = '错误标题';
  await writeFile(layout.adaptedCsv, stringifyCsv(adapted.headers, adapted.rows));
  await assert.rejects(renderReport({ taskFile: task.taskFile, mode: 'deprecated', data }), /原列|对应/);
  assert.deepEqual(await readFile(layout.rawCsv), raw);
});

test('report publication rejects result mismatch and unknown or duplicate classifications', async t => {
  const { task, layout, data, decisions } = await setup(t, 'upgrade');
  data.projects[0].rowClassifications.push({ category: '无需适配', rowIds: [decisions[0].rowId] });
  await assert.rejects(renderReport({ taskFile: task.taskFile, mode: 'upgrade', data }), /分类重复/);
  data.projects[0].rowClassifications = [{ category: '无需适配', rowIds: ['foreign:1'] }];
  await assert.rejects(renderReport({ taskFile: task.taskFile, mode: 'upgrade', data }), /未知/);
  data.projects[0].rowClassifications = [];
  const original = await readFile(layout.adaptedCsv, 'utf8');
  const csv = parseCsv(original);
  csv.rows[0]['评估结论'] = '必须适配';
  await writeFile(layout.adaptedCsv, stringifyCsv(csv.headers, csv.rows));
  await assert.rejects(renderReport({ taskFile: task.taskFile, mode: 'upgrade', data }), /评估结论与分组分类冲突/);
  await writeFile(layout.adaptedCsv, original.replace('原始 <标题>', '错误标题'));
  await assert.rejects(renderReport({ taskFile: task.taskFile, mode: 'upgrade', data }), /原列|对应/);
});

test('two projects with identical scan bytes retain separate row coverage and unique HTML IDs', async t => {
  const { root, task, layout, raw, decisions, data } = await setup(t, 'upgrade');
  const other = path.join(root, 'other'); await cp(path.join(root, 'app'), other, { recursive: true });
  await registerTaskProject(task.taskFile, { projectPath: other, mode: 'upgrade' });
  const imported = await importTaskCsv(task.taskFile, { projectPath: other, mode: 'upgrade', inputCsv: path.join(root, 'input.csv') });
  await writeFile(imported.outputLayout.adaptedCsv, formatUpgradeResults(raw, decisions.map(decision => ({
    ...decision, 评估结论: '待分类',
  }))));
  await writeFile(imported.outputLayout.progressPath, '{"groups":[]}');
  data.projects[0].changes[0].keyDecision = '工程A评估方案';
  data.projects[0].changes[0].approval = '工程A批准方案A';
  const progress = JSON.parse(await readFile(layout.progressPath, 'utf8'));
  progress.testSuggestions = ['工程A：在phone上打开搜索页，确认阴影符合旧体验'];
  await writeFile(layout.progressPath, JSON.stringify(progress));
  await writeFile(imported.outputLayout.progressPath, JSON.stringify({ groups: [], testSuggestions: ['工程B：在tablet上展开菜单，确认文字完整'] }));
  data.projects.push({ ...data.projects[0], projectKey: 'other', changes: data.projects[0].changes.map(change => ({ ...change, keyDecision: '工程B评估方案', approval: '工程B暂不批准' })) });
  const result = await renderReport({ taskFile: task.taskFile, mode: 'upgrade', data });
  assert.equal(result.rowCount, 4);
  const html = await readFile(result.output, 'utf8');
  assert.equal(html.match(/data-row-id=/g).length, 4);
  assert.doesNotMatch(html, /id="key-decisions-title"|class="metric-decisions"|工程A评估方案|工程B评估方案/);
  const followUp = html.match(/<section class="panel" aria-labelledby="follow-up-title">([\s\S]*)<\/main>/)?.[1] ?? '';
  assert.ok(html.indexOf('id="project-2"') < html.indexOf('id="follow-up-title"'));
  const projects = followUp.split('<section class="follow-up-project"').slice(1);
  assert.equal(projects.length, 3);
  assert.ok(projects[0].includes('工程A：') && !projects[0].includes('工程B：'));
  assert.ok(projects[1].includes('pending') && projects[1].includes('尚未提供针对性测试建议'));
  assert.ok(projects[2].includes('工程B：') && !projects[2].includes('工程A：'));
});

test('旧报告 JSON 可继续读取，关键决策只来自登记的明确答复', async t => {
  const url = 'https://example.test/change#CH1';
  const { task, data } = await setup(t, 'upgrade', [{ ...row, Title: `=HYPERLINK("${url}","同名 <变更>")` }]);
  data.projects[0].changes[0].keyDecision = '方案A <保持>；方案B & 接受';
  data.projects[0].changes[0].approval = '用户批准方案A；答复来源：本轮确认';
  const result = await renderReport({ taskFile: task.taskFile, mode: 'upgrade', data });
  const html = await readFile(result.output, 'utf8');
  assert.ok(html.includes(`href="${url}"`) && html.includes('CH1') && html.includes('同名 &lt;变更&gt;'));
  assert.doesNotMatch(html, /id="key-decisions-title"|class="metric-decisions"|方案A &lt;保持&gt;/);
  assert.equal(result.rowCount, 1);
  assert.equal((html.match(/data-row-id=/g) ?? []).length, 1);
  assert.doesNotMatch(html, /统计仅包含已取得的 CSV|全部工程原始行数已核对|范围外 0 行/);
  assert.ok(html.includes('原始行数未知'));
});

for (const mode of ['upgrade', 'deprecated']) test(`${mode} prepare省略已退役的报告选择字段`, async t => {
  const { root } = await setup(t, mode);
  const prepared = JSON.parse(await readFile(path.join(root, 'prepared-report.json'), 'utf8'));
  for (const change of prepared.projects[0].changes) {
    assert.ok(!Object.hasOwn(change, 'keyDecision'));
  }
});

test('DevEco 报告展示官方前后对照，只有变更影响时保留官网链接与隔离状态', async t => {
  const rows = [
    { ...row, 'Rule ID': '274', 'Changed in SDK': '5.0.2(14) Beta1', Title: 'Navigation的menus接口、NavDestination的title和menus接口支持Resource类型资源' },
    { ...row, 'Rule ID': 'CH2025050827493', 'Changed in SDK': '5.0.1(13) Release', Title: 'NavDestination的Dialog模式默认支持系统动画' },
    { ...row, 'Rule ID': 'rich-editor', 'Changed in SDK': '5.0.2(14) Beta1',
      Title: 'RichEditor（富文本）在光标处于文本起始位置情况时向前删除空文本onWillChange回调变更' },
    row,
  ];
  const { task, layout, data, decisions } = await setup(t, 'upgrade', rows);
  await mkdir(path.dirname(layout.scanJson), { recursive: true });
  const references = ['5.0.2(14)/os-api-behavior-changes.md:722', '5.0.1(13)/release-ux-style-and-effect-changes.md:139',
    '5.0.2(14)/os-api-behavior-changes.md:546', 'unknown.md:1'];
  await writeFile(layout.scanJson, JSON.stringify({ mode: 'upgrade', batchId: layout.batchId,
    findings: rows.map((source, index) => ({ ...source, 'Source Reference': references[index] })) }));
  await writeFile(path.join(layout.deliveryDirectory, 'groups', 'actual.json'), JSON.stringify({
    identity: JSON.stringify([rows[0]['Rule ID'], rows[0]['Changed in SDK']]),
    files: [{ rowIds: [decisions[0].rowId] }], rowClassifications: data.projects[0].rowClassifications,
  }));
  const html = await readFile((await renderReport({ taskFile: task.taskFile, mode: 'upgrade', data })).output, 'utf8');
  assert.match(html, /274 · Navigation[^<]*<span[^\n]*<a class="change-link" href="https:\/\/developer\.huawei\.com\/[^"]+#navigation[^"]*">官方变更说明<\/a><\/p><div class="behavior-summary"><p>target 隔离：官方未说明版本隔离<\/p><\/div>\s*<details class="detail-fold"><summary>逐行依据与处理明细/);
  assert.doesNotMatch(html, /由于NavigationMenuItem变量类型变更为|官方未单列变更前后|此变更涉及应用适配。/);
  assert.match(html, /<p class="official-excerpt">\| 组件 \| 变更前 \| 变更后 \|\n\| --- \| --- \| --- \|\n\| RichEditorController构造的富文本 \|[^\n]*\[-1, -1\][^\n]*\[0, 0\]/);
  assert.match(html, /变更前：NavDestination的Dialog模式，无系统默认动画。/);
  assert.match(html, /变更后：NavDestination的Dialog模式，默认带有系统转场动画。/);
  assert.match(html, /target 隔离：官方已做版本隔离，仅在 targetSdkVersion ≥ 5\.0\.1\(13\) 时生效/);
  assert.match(html, /<p>官方原文待核对<\/p>/);
  assert.doesNotMatch(html, /变更前：原行为|target 隔离：target26/);
  const progress = JSON.parse(await readFile(layout.progressPath, 'utf8'));
  for (const name of ['os-api-behavior-changes.md', 'release-ux-style-and-effect-changes.md', 'changelogs-index.json']) {
    const snapshot = progress.delivery.reportInputs.files.find(file => path.basename(file.file) === name);
    assert.equal(snapshot?.hash, sha256(await readFile(snapshot.file)));
  }
});

test('官方原文保留同一变更的多组前后对照并核对通道', async () => {
  const root = fileURLToPath(new URL('../../../references/changelogs/', import.meta.url));
  const read = createOfficialBehaviorReader(root);
  const group = { ruleId: 'CH2026032801249', version: '26.0.0(26) Beta1',
    sourceReference: '26.0.0/beta1-ux-style-and-effect-changes.md:87', titles: ['内置文本的组件文本样式优化'] };
  const entry = await read(group);
  for (const excerpt of [entry.before, entry.after]) {
    assert.match(excerpt, /场景一：孤字换行优化[\s\S]*场景二：小语种行高优化[\s\S]*场景三/);
  }
  assert.equal(await read({ ...group, version: '26.0.0(26) Release' }), null);
});

test('只有官方明确表述时显示未做版本隔离，正文哈希不符时不引用', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'official-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '26.0.0(26) Beta1', name = 'beta1-ux-style-and-effect-changes.md';
  const document = '26.0.0/' + name, file = path.join(root, '26.0.0', name);
  await mkdir(path.dirname(file));
  const source = '## 变更示例\n\n**说明**\n\n此变更未做版本隔离。\n\n变更前：旧行为。\n\n变更后：新行为。\n';
  await writeFile(file, source);
  await writeFile(path.join(root, 'changelogs-index.json'), JSON.stringify({
    schemaVersion: 1, documents: [{ path: document, sha256: sha256(source) }], overview: [],
  }));
  const group = { ruleId: 'fixture', version, sourceReference: document + ':1', titles: ['变更示例'] };
  assert.equal((await createOfficialBehaviorReader(root)(group)).target, '未做版本隔离');
  await writeFile(file, source.replace('未做', '已做'));
  assert.equal(await createOfficialBehaviorReader(root)(group), null);
});

test('范围外评估归并到首页和逐行的无需适配，保留历史 CSV 读取', async t => {
  const { task, layout, data, decisions, raw } = await setup(t, 'upgrade');
  data.projects[0].rowClassifications = [];
  await writeFile(path.join(layout.deliveryDirectory, 'groups', 'actual.json'), JSON.stringify({ files: [{ rowIds: decisions.map(item => item.rowId) }],
    rowClassifications: [{ category: '范围外', rowIds: [decisions[0].rowId] }] }));
  decisions[0]['评估结论'] = '范围外';
  const adapted = parseCsv(formatUpgradeResults(raw, decisions));
  assert.equal(adapted.rows[0]['评估结论'], '无需适配');
  adapted.rows[0]['评估结论'] = '范围外';
  await writeFile(layout.adaptedCsv, stringifyCsv(adapted.headers, adapted.rows));
  const result = await renderReport({ taskFile: task.taskFile, mode: 'upgrade', data });
  const html = await readFile(result.output, 'utf8');
  assert.equal(result.rowCount, 2);
  assert.match(html, /<dt>无需适配<\/dt><dd>1<\/dd>/);
  assert.match(html, /评估：无需适配 1 行/);
  assert.match(html, /<td>无需适配<\/td><td>无需适配<\/td>/);
  assert.doesNotMatch(html, /<dt>范围外<\/dt>|<td>范围外<\/td>/);
  assert.doesNotMatch(html, /<div class="supplement">/);
  assert.equal((html.match(/data-row-id=/g) ?? []).length, 2);
  adapted.rows[1]['评估结论'] = '范围外';
  await writeFile(layout.adaptedCsv, stringifyCsv(adapted.headers, adapted.rows));
  await assert.rejects(renderReport({ taskFile: task.taskFile, mode: 'upgrade', data }), /评估结论与分组分类冲突/);
});

test('遗留卡片合并旧nextSteps与逐行待办，去除完全重复内容且保留完整行身份', async t => {
  const { task, layout, data, decisions, raw } = await setup(t, 'upgrade');
  decisions[0]['后续事项'] = '确认搜索态 <阴影> & 菜单';
  await writeFile(layout.adaptedCsv, formatUpgradeResults(raw, decisions));
  const item = `逐行后续事项：${decisions[0].rowId}：${decisions[0]['后续事项']}`;
  data.projects[0].nextSteps = [item, '存量告警：后续治理', '存量告警：后续治理'];
  const progress = JSON.parse(await readFile(layout.progressPath, 'utf8'));
  progress.testSuggestions = ['  搜索页：切换 <搜索态> & 返回，确认阴影正常；phone API 20以上  ', ''];
  await writeFile(layout.progressPath, JSON.stringify(progress));
  const result = await renderReport({ taskFile: task.taskFile, mode: 'upgrade', data });
  const html = await readFile(result.output, 'utf8');
  const card = html.slice(html.indexOf('<section class="panel" aria-labelledby="follow-up-title">'));
  assert.equal(card.split('存量告警：后续治理').length - 1, 1);
  assert.equal(card.split(`逐行后续事项：${decisions[0].rowId}`).length - 1, 1);
  assert.ok(card.includes('确认搜索态 &lt;阴影&gt; &amp; 菜单'));
  assert.ok(card.includes('搜索页：切换 &lt;搜索态&gt; &amp; 返回'));
  assert.doesNotMatch(card, /<a\b|原始扫描<\/a>|分组 actual/);
  assert.equal((card.match(/<details open>/g) ?? []).length, 0);
  assert.match(card, /<details><summary id="follow-up-issues-0">遗留事项/);
  assert.match(card, /<summary>测试建议 · 1 条<\/summary>/);
  assert.equal(result.rowCount, 2);
});

test('工程摘要限制实际改动及待处理条数，查看入口指向可见章节', async t => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ ...row, 'Rule ID': `CH${index + 1}` }));
  const { task, layout, data, decisions, raw } = await setup(t, 'upgrade', rows);
  for (const decision of decisions) decision['处理结论'] = '已适配';
  await writeFile(layout.adaptedCsv, formatUpgradeResults(raw, decisions));
  const groups = [];
  for (const [index, { rowId }] of decisions.entries()) {
    const record = `groups/summary-${index}.json`;
    groups.push({ record });
    await writeFile(path.join(layout.deliveryDirectory, record), JSON.stringify({ files: [{ rowIds: [rowId] }],
      rowClassifications: index === 0 ? [{ category: '可选适配', rowIds: [rowId] }] : [] }));
  }
  await writeFile(layout.progressPath, JSON.stringify({ groups }));
  data.projects[0].nextSteps = ['需确认设备', '需准备用例', '需补截图', '需记录差异'];
  const result = await renderReport({ taskFile: task.taskFile, mode: 'upgrade', data });
  const html = await readFile(result.output, 'utf8');
  const overview = html.match(/<div class="overview-notes">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(overview, /实际改动 · 6 项/);
  assert.equal((overview.split('<details>')[0].match(/已适配 1 行/g) ?? []).length, 5);
  assert.match(overview, /<summary>查看其余 1 项改动<\/summary>/);
  assert.equal((overview.split('<h3>待处理事项</h3>')[1].match(/<li>/g) ?? []).length, 3);
  assert.match(overview, /href="#follow-up-issues-0"/);
  assert.match(html, /<summary><h3 id="csv-assessment-0">1\. CSV 导入条目/);
  assert.equal(result.rowCount, 6);
});

test('测试建议字段拒绝非字符串数组，缺省继续兼容旧输入', async t => {
  const { task, layout, data } = await setup(t, 'upgrade');
  const progress = JSON.parse(await readFile(layout.progressPath, 'utf8'));
  for (const invalid of [null, '建议', [42], {}]) {
    await writeFile(layout.progressPath, JSON.stringify({ ...progress, testSuggestions: invalid }));
    await assert.rejects(renderReport({ taskFile: task.taskFile, mode: 'upgrade', data }), /progress\.testSuggestions.*字符串数组/);
  }
  await writeFile(layout.progressPath, JSON.stringify(progress));
  const result = await renderReport({ taskFile: task.taskFile, mode: 'upgrade', data });
  assert.match(await readFile(result.output, 'utf8'), /尚未提供针对性测试建议/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderTestReport, reportResourceUrl } from '../../runtime/report-html.mjs';
import { aggregateRows } from '../../runtime/report.mjs';
import { main } from '../../runtime/cli.mjs';
import { freezeRun } from '../../runtime/runs.mjs';
import { validatePlan } from '../../runtime/contracts.mjs';
import { parseCsv } from '../format/csv.mjs';
import { caseSnapshot, fixture } from './fixtures/runtime/plan.mjs';

test('scripts命令生成JSON骨架并保留已填写的操作清单', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-scripts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(fixture()));
  await main(['scripts', root]);
  const file = path.join(root, 'scripts', 'C1.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    schemaVersion: 1, verify_preconditions: [], navigate: [], verify_target: [], scenarios: [],
  });
  await writeFile(file, caseSnapshot);
  await main(['scripts', root]);
  assert.equal(await readFile(file, 'utf8'), caseSnapshot);
});

async function setup(t, mode = 'COMPARE', failed = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), '报告 中文 # &-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = fixture();
  plan.cases.cases[0].steps = ['输入 <script>alert("x")</script> & 确认'];
  const phases = {};
  for (const phase of mode === 'COMPARE' ? ['before', 'after'] : ['after']) {
    phases[phase] = { C1: { valid: true, dataVerified: true, observations: { A1: failed ? 'FAIL' : 'PASS' },
      actuals: { A1: failed ? '<img src=x onerror=alert(1)>' : '1234' }, captures: [], visuals: {} } };
  }
  const rows = aggregateRows(plan, phases, mode);
  const summary = { runId: 'R1', mode, device: { serial: '设备 <&>', api: '26' }, packages: {}, executionStatus: 'FINISHED',
    counts: { selected: 2, complete: 2, comparable: mode === 'COMPARE' ? 2 : 0, compared: mode === 'COMPARE' ? 2 : 0,
      afterPassed: failed ? 0 : 2, afterFailed: failed ? 2 : 0, visuallyVerified: 0 },
    sources: [{ sourceId: 'app', totalRows: 2, selectedRows: 2, sha256: plan.sources[0].sha256 }], rows, phases, problems: [] };
  await mkdir(path.join(root, 'inputs'));
  await writeFile(path.join(root, 'inputs', 'plan.json'), JSON.stringify(plan));
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ createdAt: '2026-10-31T00:00:00Z', packages: {} }));
  await writeFile(path.join(root, 'audit.json'), JSON.stringify(summary));
  return { root, plan, summary };
}

test('HTML保留重复行、失败断言与两阶段事实，并转义不可信文本', async t => {
  const { root, plan, summary } = await setup(t);
  const screenshot = path.join(root, '截图 # &.png');
  await writeFile(screenshot, 'fixture');
  summary.rows[0].after.screenshots.push({ caseId: 'C1', captureId: 'P1', screenshot: path.basename(screenshot) });
  const html = await renderTestReport(root, summary, path.dirname(root));
  assert.match(html, /<style>[\s\S]*--canvas:/);
  for (const row of plan.sources[0].rows) assert.ok(html.includes(row.rowId));
  assert.match(html, /data-phase="before"/);
  assert.match(html, /data-phase="after"/);
  assert.match(html, /存在失败/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script\b|<img src=x|待填写|模板预览|test-report\.md/);
  assert.match(html, /%E6%88%AA%E5%9B%BE%20%23%20%26\.png/);
  assert.equal((html.match(/class="result"/g) ?? []).length, 2);
});

test('仅修改后验证不产生before或比较字段，完整覆盖才能显示通过', async t => {
  const { root, summary } = await setup(t, 'AFTER_ONLY', false);
  let html = await renderTestReport(root, summary);
  assert.doesNotMatch(html, /data-phase="before"|修改前|具备对比条件|已完成有效对比/);
  assert.match(html, /仅修改后验证/);
  assert.match(html, /class="hero-status"[^>]*>通过</);
  summary.rows[0].coverage = 'PARTIAL'; summary.counts.complete = 1;
  html = await renderTestReport(root, summary);
  assert.match(html, /class="hero-status"[^>]*>部分完成</);
});

test('零选中和具名阻断不能显示通过，缺失资源不生成伪链接', async t => {
  const { root, summary } = await setup(t);
  summary.rows = []; summary.counts = { selected: 0, complete: 0, comparable: 0, compared: 0, afterPassed: 0, afterFailed: 0, visuallyVerified: 0 };
  summary.executionStatus = 'NOT_RUN';
  let html = await renderTestReport(root, summary);
  assert.match(html, /class="hero-status"[^>]*>未执行</);
  assert.doesNotMatch(html, /href="[^"]*execution\.json/);
  summary.executionStatus = 'BLOCKED'; summary.problems = ['before: 缺少阶段包'];
  html = await renderTestReport(root, summary);
  assert.match(html, /class="hero-status"[^>]*>受阻</);
  assert.match(html, /before: 缺少阶段包/);
});

test('资源URL兼容中文、盘符和UNC，同盘链接编码特殊字符，跨盘不伪造相对路径', () => {
  for (const root of ['C:\\中文 # 空格', '\\\\server\\共享\\中文']) {
    const report = path.win32.join(root, '交付'), image = path.win32.join(root, '证据', 'a #&.png');
    assert.equal(reportResourceUrl(report, image, 'win32'), '../%E8%AF%81%E6%8D%AE/a%20%23%26.png');
  }
  assert.equal(reportResourceUrl('C:\\交付', 'D:\\证据\\a.png', 'win32'), null);
  assert.equal(reportResourceUrl(path.join('目录', '交付'), path.join('目录', '证据', "a'\"#.png")), '../%E8%AF%81%E6%8D%AE/a%27%22%23.png');
});

test('功能通过不能掩盖视觉失败或未验证，缺图片保留原因而不是断链', async t => {
  const { root, summary } = await setup(t, 'AFTER_ONLY', false);
  summary.rows[0].after.visual = 'FAIL'; summary.counts.visuallyVerified = 1;
  let html = await renderTestReport(root, summary);
  assert.match(html, /class="hero-status"[^>]*>存在失败</);
  summary.rows[0].after.visual = 'UNVERIFIED'; summary.counts.visuallyVerified = 0;
  summary.rows[0].after.screenshots.push({ caseId: 'C1', captureId: '缺图', screenshot: 'missing.png' });
  html = await renderTestReport(root, summary);
  assert.match(html, /class="hero-status"[^>]*>部分完成</);
  assert.match(html, /缺图：未生成或已缺失/);
  assert.doesNotMatch(html, /src="[^"]*missing\.png/);
});

test('覆盖统计同时保留未提供分类和显式待分类的原始行', async t => {
  const { root, plan, summary } = await setup(t, 'AFTER_ONLY', false);
  plan.spec.classifications = [{ category: '待分类', rowRefs: plan.sources[0].rows.map(row => ({ sourceId: 'app', rowId: row.rowId })) }];
  validatePlan(plan);
  await writeFile(path.join(root, 'inputs', 'plan.json'), JSON.stringify(plan));
  const html = await renderTestReport(root, summary);
  assert.equal(html.match(/未选 \/ 待分类（原始行）<\/dt><dd><code>(.*?)<\/code>/)?.[1], '0 / 2');
  plan.spec.classifications[0].category = '无需适配';
  await writeFile(path.join(root, 'inputs', 'plan.json'), JSON.stringify(plan));
  assert.equal((await renderTestReport(root, summary)).match(/未选 \/ 待分类（原始行）<\/dt><dd><code>(.*?)<\/code>/)?.[1], '0 / 0');
});

test('report命令实际交付HTML，保留旧文件并另存，内部存档链接基于各自目录', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'HTML交付 中文 # &-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await freezeRun(directory, fixture(), { packagesDirectory: path.join(directory, '缺包'), mode: 'AFTER_ONLY',
    scripts: { C1: caseSnapshot }, device: { serial: 'SERIAL', api: '26', kind: 'emulator', instance: 'API26' }, python: 'python3', runId: 'R1' });
  const delivery = path.join(directory, '交付');
  t.mock.method(console, 'log', () => {});
  await main(['report', root, delivery]);
  const first = path.join(delivery, 'test-report.html');
  const delivered = await readFile(first, 'utf8'), archived = await readFile(path.join(root, 'test-report.html'), 'utf8');
  assert.match(delivered, /受阻|未执行/);
  assert.match(delivered, /\.\.\/runs\/R1\/audit\.json/);
  assert.match(archived, /href="audit\.json"/);
  assert.doesNotMatch(delivered, /待填写|模板预览/);
  await assert.rejects(access(path.join(delivery, 'test-report.md')), { code: 'ENOENT' });
  await writeFile(path.join(delivery, 'test-report.md'), '历史 Markdown 保留');
  await writeFile(first, '用户编辑');
  await main(['report', root, delivery]);
  assert.equal(await readFile(first, 'utf8'), '用户编辑');
  assert.equal(await readFile(path.join(delivery, 'test-report.md'), 'utf8'), '历史 Markdown 保留');
  assert.match(await readFile(path.join(delivery, 'test-report-R1.html'), 'utf8'), /API 行为适配测试报告/);
});

test('runtime CSV uses frozen classifications for older inputs and preserves current explicit assessments', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), '截图评估 CSV-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = fixture();
  const source = plan.sources[0];
  plan.spec.classifications = [{ category: '可选适配', rowRefs: source.rows.map(row => ({ sourceId: source.sourceId, rowId: row.rowId })) }];
  const run = await freezeRun(directory, plan, { packagesDirectory: path.join(directory, '缺包'), mode: 'AFTER_ONLY',
    scripts: { C1: caseSnapshot }, device: { serial: 'SERIAL', api: '26', kind: 'emulator', instance: 'API26Phone' }, python: 'python3', runId: 'R1' });
  const decisions = path.join(directory, 'decisions.json'), output = path.join(directory, 'result.csv');
  const results = source.rows.map(({ rowId }) => ({ rowId, 处理结论: '无需适配', 处理说明: '接受新行为', 后续事项: '' }));
  results[1]['评估结论'] = '无需适配';
  await writeFile(decisions, JSON.stringify(results));
  t.mock.method(console, 'log', () => {});
  await main(['csv', run, source.sourceId, decisions, output]);
  const csv = parseCsv(await readFile(output, 'utf8'));
  assert.deepEqual(csv.headers.slice(-5), ['评估结论', '处理结论', '处理说明', '后续事项', '测试截图']);
  assert.deepEqual(csv.rows.map(row => row['评估结论']), ['可选适配', '无需适配']);
});

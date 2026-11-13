import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, readJson } from './io.mjs';
import { requireValue } from './contracts.mjs';
import { CASE_FORMAT, caseFile } from './runs.mjs';

const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'upgrade-test-report.html');
const h = value => String(value ?? '未记录').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const value = item => item === undefined ? '未记录' : typeof item === 'string' ? item : JSON.stringify(item);
const code = item => `<code>${h(value(item))}</code>`;
const labels = { PASS: '通过', FAIL: '失败', UNVERIFIED: '未验证', NOT_REQUIRED: '不适用', COMPLETE: '完整实测', PARTIAL: '部分实测', NOT_RUN: '未执行',
  SAME: '一致', ALLOWED_CHANGE: '获批差异', REGRESSION: '回归', BOTH_FAIL: '两阶段均失败', SEE_ASSERTIONS: '见实际断言' };
const badge = status => `<span class="state" data-tone="${status === 'PASS' ? 'success' : status === 'FAIL' ? 'error' : ['UNVERIFIED', 'PARTIAL'].includes(status) ? 'warning' : 'neutral'}">${h(labels[status] ?? status)}</span>`;
const facts = pairs => `<dl class="detail-grid">${pairs.map(([label, text]) => `<div><dt>${h(label)}</dt><dd>${code(text)}</dd></div>`).join('')}</dl>`;
const details = (title, content) => `<details><summary>${h(title)}</summary><div class="detail-body">${content}</div></details>`;
const panel = (id, title, content, caption = '') => `<section class="panel" aria-labelledby="${id}"><div class="section-heading"><h2 id="${id}">${h(title)}</h2><span class="caption">${h(caption)}</span></div>${content}</section>`;

export function reportResourceUrl(reportDirectory, target, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const relative = api.relative(api.resolve(reportDirectory), api.resolve(target));
  if (api.isAbsolute(relative)) return null;
  return relative.split(api.sep).map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

// 只投影 auditRun 已核对的事实；不执行测试，也不重新计算业务断言。
export async function renderTestReport(root, summary, reportDirectory = root) {
  const [template, plan, manifest, execution] = await Promise.all([
    readFile(templatePath, 'utf8'),
    inside(root, path.join('inputs', 'plan.json')).then(readJson),
    inside(root, 'manifest.json').then(readJson),
    inside(root, 'execution.json').then(readJson).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
  ]);
  const phases = summary.mode === 'COMPARE' ? ['before', 'after'] : ['after'];
  const phaseLabel = phase => phase === 'before' ? '修改前' : '修改后';
  async function resource(relative, label, image = false) {
    const target = await inside(root, relative);
    const exists = await stat(target).then(info => info.isFile()).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
      throw error;
    });
    if (!exists) return `<span class="caption">${h(label)}：未生成或已缺失</span>`;
    const url = reportResourceUrl(reportDirectory, target);
    if (url === null) return `<span class="caption">${h(label)}：${h(target)}（跨盘路径）</span>`;
    return image ? `<figure><img class="evidence-image" loading="lazy" src="${h(url)}" alt="${h(label)}"><figcaption class="caption">${h(label)}</figcaption></figure>`
      : `<a href="${h(url)}">${h(label)}</a>`;
  }
  const total = summary.sources.reduce((n, source) => n + source.totalRows, 0);
  const planned = summary.rows.filter(row => row.cases.length > 0).length;
  const executed = summary.rows.filter(row => phases.some(phase => row.cases.some(id => summary.phases[phase]?.[id]?.valid))).length;
  const failed = summary.rows.filter(row => phases.some(phase => ['functional', 'visual'].some(kind => row[phase]?.[kind] === 'FAIL'))).length;
  const unverified = summary.rows.filter(row => phases.some(phase => ['functional', 'visual'].some(kind => row[phase]?.[kind] === 'UNVERIFIED'))).length;
  const unclassified = plan.sources.flatMap(source => source.rows.map(row => ({ sourceId: source.sourceId, rowId: row.rowId })))
    .filter(ref => !(plan.spec.classifications ?? []).some(item => item.category !== '待分类' && item.rowRefs.some(r => r.sourceId === ref.sourceId && r.rowId === ref.rowId))).length;
  const overall = failed ? '存在失败' : summary.executionStatus === 'BLOCKED' ? '受阻' : !summary.counts.selected || !executed ? '未执行'
    : summary.problems.length || summary.counts.complete !== summary.counts.selected || unverified || summary.mode === 'COMPARE' && summary.counts.compared !== summary.counts.selected ? '部分完成' : '通过';
  const tone = overall === '通过' ? 'success' : overall === '存在失败' ? 'error' : ['受阻', '部分完成'].includes(overall) ? 'warning' : 'neutral';
  let body = `<div class="template-note"><strong>HarmonyOS · API 适配</strong><span>运行 ${h(summary.runId)} · ${h(manifest.createdAt ?? '时间未记录')}</span></div>
    <header class="hero"><div class="hero-top"><div><p class="eyebrow">FUNCTIONAL &amp; VISUAL VERIFICATION</p><h1>API 行为适配测试报告</h1></div><span class="hero-status" data-tone="${tone}">${overall}</span></div>
    <p class="hero-subtitle">${h(summary.mode === 'COMPARE' ? '前后对比' : '仅修改后验证')} · 设备 ${h(summary.device.serial)} · 系统 API ${h(summary.device.api)}</p>
    <p class="hero-note">归档、实测、功能、视觉与覆盖分别记录；完整实测不代表业务通过。</p></header>
    <dl class="metrics">${[['选中行', summary.counts.selected], ['完整实测', summary.counts.complete], ['修改后功能通过', summary.counts.afterPassed], ['修改后功能失败', summary.counts.afterFailed]]
      .map(([label, count]) => `<div class="metric"><dt>${label}</dt><dd>${count}</dd></div>`).join('')}</dl>
    <div class="supplement"><span>原始逻辑行 ${total}</span><span>已规划行 ${planned}（至少一个用例）</span><span>已执行行 ${executed}（至少一个有效记录）</span><span>视觉已验证 ${summary.counts.visuallyVerified}</span>
    ${summary.mode === 'COMPARE' ? `<span>具备对比条件 ${summary.counts.comparable} / 已完成有效对比 ${summary.counts.compared}</span>` : ''}</div>`;
  const renderedRows = await Promise.all(summary.rows.map(async (row, index) => {
    const assertions = phases.flatMap(phase => (row[phase]?.assertions ?? []).map(assertion => `<tr data-phase="${phase}"><td>${phaseLabel(phase)} / ${h(assertion.caseId)} / ${h(assertion.assertionId)}<br>${h(assertion.kind)}</td><td>${code(assertion.expected)}</td><td>${code(assertion.actual)}</td><td>${badge(assertion.status)}<br>${h(assertion.reason)}</td></tr>`)).join('');
    const cases = await Promise.all(row.cases.map(async id => {
      const c = plan.cases.cases.find(item => item.id === id);
      const route = plan.routeMap.routes.find(item => item.id === c.routeId);
      return details(`用例 ${id} · 前置条件与操作`, facts([
        ['前置条件 / 数据复位', c.preconditions], ['操作步骤', c.steps], ['路线与源码依据', route],
        ['用例与预期来源', plan.spec.points.filter(point => row.pointIds.includes(point.id))],
        ['实际前置数据核对', Object.fromEntries(phases.map(phase => [phase, summary.phases[phase]?.[id]?.dataVerified ?? false]))],
      ]) + `<p>${await resource(caseFile(id, manifest.caseFormat), manifest.caseFormat === CASE_FORMAT ? '冻结操作清单' : '历史脚本快照')}</p>`);
    }));
    const pictures = await Promise.all(phases.flatMap(phase => (row[phase]?.screenshots ?? []).map(async cp =>
      `<div>${await resource(cp.screenshot, `${phaseLabel(phase)} / ${cp.caseId} / ${cp.captureId}`, true)}<p class="caption">采集时间 ${h(cp.time ?? '未记录')} · ${cp.layoutTree ? await resource(cp.layoutTree, '实际布局树') : '布局树未记录'}</p>${facts([['图片 / 布局身份', { screenshotSha256: cp.screenshotSha256, layoutSha256: cp.layoutSha256 }]])}</div>`)));
    const logs = await Promise.all(phases.flatMap(phase => row.cases.map(async id => {
      const entry = execution?.phases?.[phase]?.cases?.[id];
      return entry?.directory ? resource(path.join(entry.directory, 'result.json'), `${phaseLabel(phase)} / ${id} 执行回执`) : '';
    })));
    return `<article class="result" id="row-${index + 1}"><div class="result-heading"><span class="category">${h(row.category)}</span><div class="result-copy"><h3>${h(row.ruleId || '未提供规则')}</h3><p class="path">${h(row.codeLocation)}</p><p class="summary-text">${h(row.sourceId)} · 逻辑行 ${row.logicalRow} · ${h(row.gaps.join('；') || '必测项与实际结果见详情')}</p>
      <dl class="phase-grid">${phases.map(phase => `<div class="phase" data-phase="${phase}"><dt>${phaseLabel(phase)}</dt><dd>功能 ${badge(row[phase].functional)} · 视觉 ${badge(row[phase].visual)}</dd></div>`).join('')}</dl></div>${badge(row.coverage)}</div>
      ${details('原始行、实际断言与证据', facts([
        ['完整来源身份', { sourceId: row.sourceId, logicalRow: row.logicalRow, rowId: row.rowId }], ['必测点 / 用例', { points: row.pointIds, cases: row.cases }],
        ['覆盖与缺口', { coverage: row.coverage, gaps: row.gaps }],
        ...(summary.mode === 'COMPARE' ? [['可比性 / 有效对比 / 差异', { comparable: row.comparable, compared: row.compared, functional: labels[row.difference] ?? row.difference, visual: labels[row.visualDifference] ?? row.visualDifference }]] : []),
      ]) + `<table class="assertion-table"><caption>实际断言</caption><thead><tr><th scope="col">阶段 / 断言</th><th scope="col">业务预期</th><th scope="col">实际值</th><th scope="col">结果与依据</th></tr></thead><tbody>${assertions || '<tr><td colspan="4">未取得有效断言，不能据此判定通过。</td></tr>'}</tbody></table>`
        + cases.join('') + logs.filter(Boolean).map(link => `<p>${link}</p>`).join('') + (pictures.length ? `<div class="evidence-grid">${pictures.join('')}</div>` : '<p class="caption">无有效截图；非视觉项无需截图，视觉项以实际判定和缺口为准。</p>'))}</article>`;
  }));
  body += panel('results-title', '测试结果', renderedRows.join('') || '<p class="summary-text">本次没有选中行，未执行测试，不构成业务验收通过。</p>', '逐原始逻辑行保留，重复行不合并');
  body += panel('coverage-title', '覆盖与未完成项', facts([
    ['未选 / 待分类（原始行）', `${total - summary.counts.selected} / ${unclassified}`],
    ['未执行 / 未验证（选中行）', `${summary.counts.selected - executed} / ${unverified}`],
    ['任一阶段失败（选中行）', failed], ...(summary.mode === 'COMPARE' ? [['不可比（选中行）', summary.counts.selected - summary.counts.comparable]] : []),
  ]) + details('来源身份与冻结输入', facts(summary.sources.map(source => [source.sourceId, source])) + `<p>${await resource(path.join('inputs', 'plan.json'), '原始 CSV 字节、选择、路线、规格及完整用例快照')}</p>`));
  const stages = await Promise.all(phases.map(async phase => {
    const pkg = summary.packages[phase];
    if (!pkg) return `<div data-phase="${phase}"><h3>${phaseLabel(phase)}</h3><p class="summary-text">缺少有效归档阶段包，不能推断安装或实测通过。</p></div>`;
    const artifacts = await Promise.all(pkg.artifacts.map(async artifact => `<li>${await resource(artifact.path, artifact.path)} · SHA-256 ${h(artifact.sha256)} · signed=${h(artifact.signed)}</li>`));
    const installed = execution?.events?.find(event => event.type === 'installed' && event.phase === phase);
    return `<div data-phase="${phase}"><h3>${phaseLabel(phase)}</h3>${facts([
      ['源码 / 配置来源与归档时间', { source: pkg.sourceDescription, archivedAt: pkg.archivedAt, inputs: pkg.inputs }],
      ['包身份 / product / 模块', { bundle: pkg.package, ability: pkg.ability, product: pkg.product, module: pkg.module }],
      ['声明配置与实际包身份', { target: pkg.target, compatible: pkg.compatible, rawIdentity: pkg.rawIdentity }],
      ['构建命令 / cwd / 退出码', { command: pkg.build.command, cwd: pkg.build.cwd, exitCode: pkg.build.exitCode }],
      ['实际安装与设备', installed ? { time: installed.time, packageInfo: installed.packageInfo, device: summary.device } : '未取得实际安装回执；归档不表示已运行'],
      ['宿主 / ABI', { host: pkg.host ?? '归档凭据未提供', abi: pkg.abi ?? '归档凭据未提供' }],
    ])}<ul>${artifacts.join('')}</ul><p>${await resource(pkg.build.log, '冻结构建日志')}</p></div>`;
  }));
  body += details('阶段包、构建与执行环境', facts([['设备与执行状态', { device: summary.device, executionStatus: summary.executionStatus }]]) + stages.join(''));
  const resources = await Promise.all([
    resource('audit.json', '结构化审计'), resource('execution.json', '实际执行与阶段顺序'), resource('manifest.json', '阶段包与冻结身份'),
    resource('judgments.json', '视觉判定'), resource('screenshots-by-source.json', '逐来源截图索引'),
  ]);
  body += panel('next-title', '待办与交付', `<ul class="todo-list">${summary.problems.map(problem => `<li>${h(problem)}</li>`).join('') || '<li>未发现执行完整性问题；业务与视觉结论以上述实际断言为准。</li>'}
    ${failed ? '<li>处理失败断言后重建最终包，并重新测试受影响用例。</li>' : ''}${unverified || summary.counts.complete < summary.counts.selected ? '<li>补齐尚未执行或未验证的必测项，再核对完整覆盖。</li>' : ''}
    <li>实例清理由主流程按授权执行；本运行工具不提供清理成功回执，不能据此填写已清理。</li></ul>
    <div class="resources">${resources.map(link => `<div>${link}</div>`).join('')}</div>`);
  body += `<footer class="footer"><span>运行 ${h(summary.runId)} · 原始逻辑行 ${total}，选中 ${summary.counts.selected}</span><span>统计与断言来自本次结构化审计</span></footer>`;
  const start = '<!-- runtime:report -->', end = '<!-- /runtime:report -->';
  requireValue(template.split(start).length === 2 && template.split(end).length === 2 && template.indexOf(start) < template.indexOf(end), '测试 HTML 模板缺少唯一内容区域');
  return template.replace(/<!-- runtime:report -->[\s\S]*?<!-- \/runtime:report -->/, () => body)
    .replace(/<title>[\s\S]*?<\/title>/, () => '<title>API 行为适配测试报告</title>')
    .replace(/<!--[\s\S]*?-->/g, '');
}

import { readFile, writeFile, mkdir, open, unlink, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readTask } from '../shared/platform/task-context.mjs';
import { requireScanMode } from '../shared/platform/scan-mode.mjs';
import { readScanInput } from '../shared/format/scan-input.mjs';
import { titleText } from '../shared/format/csv.mjs';
import { checkUpgradeResultColumns, displayUpgradeAssessment, matchesUpgradeResult } from '../shared/format/upgrade-results.mjs';
import { portablePath, relativePathInside, samePath } from '../shared/platform/paths.mjs';
import { sha256 } from '../shared/io/fs-utils.mjs';
import { classificationMap, optionalJson, checkSnapshot, unresolvedOutcome } from '../shared/platform/group-results.mjs';
import { publishProgress } from './publication.mjs';
import { ensureBatchDirectory } from '../shared/platform/artifact-layout.mjs';
import { deliveryInputs } from '../csv/delivery.mjs';
import { readTaskView } from '../shared/platform/task-view.mjs';
import { physicalOutput, saveGeneratedOutput } from '../shared/platform/generated-output.mjs';
import { writeProjectCsv } from '../csv/project.mjs';
import { activeDecision, equalData } from '../shared/platform/assessment-source.mjs';
import { entryUrl } from '../shared/platform/document-links.mjs';
import { compareConfigurationVersions } from '../shared/platform/version.mjs';
import { isRnohRuleId, RNOH_LAYERS } from '../scanner/rnoh/rnoh.mjs';
import { rnohConclusionLabels } from '../shared/platform/rnoh-reviews.mjs';
import { createOfficialBehaviorReader } from './official-behavior.mjs';
import { reportRepairDecisions } from './repair-decisions.mjs';

const skillRoot = fileURLToPath(new URL('../../', import.meta.url));
const reportTimeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function reportTimeFooter(date) {
  const iso = date.toISOString();
  return `<footer class="footer" data-time-sha256="${sha256(iso)}">报告生成时间 <time datetime="${iso}">${reportTimeFormat.format(date)}（北京时间）</time></footer>`;
}

function reportFingerprint(bytes) {
  const html = bytes.toString('utf8');
  const footer = html.match(/<footer class="footer" data-time-sha256="[0-9a-f]{64}">报告生成时间 <time datetime="([^"]+)">[^<]+<\/time><\/footer>(?=<\/main>)/);
  if (!footer || !bytes.equals(Buffer.from(html))) return sha256(bytes);
  const date = new Date(footer[1]);
  // Only ignore a tool-generated time, even after progress points to an alternative file.
  if (!Number.isFinite(date.getTime()) || reportTimeFooter(date) !== footer[0]) return sha256(bytes);
  return sha256('upgrade-report\0' + html.replace(footer[0], ''));
}

const categories = ['必须适配', '可选适配', '无需适配', '待分类'];
const deprecatedStates = ['PENDING', 'MODIFIED', 'NO_CHANGE', 'DECISION_REQUIRED', 'EVIDENCE_GAP', 'OUT_OF_SCOPE'];
const deprecatedFacts = ['处理来源', '业务影响', '兼容性说明', '变更文件', '验证证据'];
const labels = { PENDING: '未处理', MODIFIED: '已修改', NO_CHANGE: '无需修改', DECISION_REQUIRED: '待决策', EVIDENCE_GAP: '证据不足', OUT_OF_SCOPE: '范围外' };
const h = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const decode = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const exists = async file => stat(file).then(info => info.isFile()).catch(error => {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
  throw error;
});
const counts = values => Object.fromEntries([...new Set(values)].map(value => [value, values.filter(v => v === value).length]));
const countText = values => Object.entries(counts(values)).map(([key, value]) => `${labels[key] ?? key} ${value} 行`).join('；') || '0 行';
const text = value => value === undefined || value === null || value === '' ? '未提供，需补充依据' : value;
const assessmentLabel = (project, rowId) => displayUpgradeAssessment(project.classifications.get(rowId) ?? '待分类');
const facts = entries => `<dl class="detail-grid">${entries.map(([key, value]) => `<div><dt>${h(key)}</dt><dd>${h(text(value))}</dd></div>`).join('')}</dl>`;
const panel = (id, title, body) => `<section class="panel" aria-labelledby="${id}"><div class="section-heading"><h2 id="${id}">${h(title)}</h2></div>${body}</section>`;
const narrativeFor = (input, group) => (input.changes ?? []).find(item => group.identity && item.identity === group.identity
  || group.ruleId && item.ruleId === group.ruleId && item.version === group.version
  || !group.identity && Array.isArray(item.rowIds) && item.rowIds.length === group.rowIds.length && group.rowIds.every(id => item.rowIds.includes(id)));

function scanDirectoryLabel(participant, scope, hasScan) {
  const root = participant.physicalRoot ?? participant.projectRoot;
  const name = path.basename(participant.projectRoot) || participant.projectRoot;
  const roots = scope?.roots ?? [];
  const limits = scope?.scanDirs ?? [];
  // The scanner applies the directory limits and the module roots together.
  const directories = limits.length ? roots.flatMap(base => limits.flatMap(limit => {
    if (relativePathInside(base, limit) !== null) return [limit];
    return relativePathInside(limit, base) !== null ? [base] : [];
  })) : roots;
  if (directories.length) {
    const labels = [...new Set(directories.map(directory => relativePathInside(root, directory) ?? portablePath(directory)))];
    return labels.length === 1 && labels[0] === '' ? name : `${name}（${labels.map(label => label || '工程根目录').join('、')}）`;
  }
  const scanStatus = { NOT_STARTED: '未扫描', SCANNING: '扫描中', SCAN_FAILED: '扫描失败' };
  const status = hasScan
    ? participant.status === 'IMPORTED' ? '仅导入 CSV，范围未核实' : '扫描范围未核实'
    : scanStatus[participant.status] ?? '扫描结果缺失';
  return `${name}（${status}）`;
}

function versionText(value) {
  const label = typeof value === 'string' || Number.isFinite(value) ? String(value).trim() : '';
  return ['未知', '—'].includes(label) ? '' : label;
}

function compatibleVersion(value) {
  const label = versionText(value);
  // Keep the recorded version and API level when a historical entry has a label or a note.
  const match = label.match(/^(?:(?:原值|计划|目标|当前|保持)\s*[:：]?\s*)?((?:\d+\.\d+\.\d+(?:\(\d+(?:\.\d+\.\d+)?\))?|API\s*\d+|\d+)(?:\s+(?:Canary|Beta|Release)\d*)?)(?:\s*(?:（[^）]*）|\([^()]*\)))?$/iu);
  return match?.[1] ?? '';
}

function compatibleText(value, oldValue) {
  let old, current;
  if (value && typeof value === 'object') {
    old = compatibleVersion(value.old);
    current = compatibleVersion(value.current);
  } else {
    const parts = versionText(value).split(/\s*(?:→|->)\s*/u);
    if (parts.length > 2) return '';
    current = compatibleVersion(parts.at(-1));
    if (parts.length === 2) {
      old = compatibleVersion(parts[0]);
      if (!old) return '';
    }
  }
  if (!current) return '';
  old ||= compatibleVersion(oldValue);
  if (!old || old === current) return current;
  try {
    if (compareConfigurationVersions(old.replace(/^API\s*/i, ''), current.replace(/^API\s*/i, '')) === 0) return current;
  } catch {
    // Historical API labels may lack a platform mapping; show both recorded values.
  }
  return `${old} → ${current}`;
}

function upgradeConfiguration(project) {
  const progress = project.progressSnapshot.value ?? {};
  const versions = progress.versions ?? {};
  const config = project.configuration;
  const oldTarget = versionText(config.oldTarget) || versionText(versions.oldTarget);
  const target = versionText(config.target) || versionText(versions.target);
  const compatible = compatibleText(config.compatible, versions.oldCompatible)
    || compatibleText(versions.compatible, versions.oldCompatible);
  const missing = [['原 target', oldTarget], ['目标 target', target], ['compatible', compatible]]
    .filter(([, value]) => !value).map(([label]) => label);
  if (missing.length) project.gaps.push(`配置记录待补齐：${missing.join('、')}`);
  return { targetUpgrade: `${oldTarget || '未知'} → ${target || '未知'}`, compatible: compatible || '未知' };
}

function renderUpgradeSubtitles(projects) {
  return projects.map(({ scanDirectory, versionDisplay }) =>
    `<p class="hero-subtitle"><strong>${h(scanDirectory)}</strong><span>· target ${h(versionDisplay.targetUpgrade)}</span><span>· 最低兼容 ${h(versionDisplay.compatible)}</span></p>`).join('');
}

const changeTitle = group => [group.ruleId, ...group.titles].filter(Boolean).join(' · ');

function changeHeading(group, rows) {
  const url = rows.find(row => row.titleUrl)?.titleUrl;
  const title = changeTitle(group);
  return url ? `<a class="change-link" href="${h(url)}">${h(title)}</a>` : h(title);
}

function groupApproval(project, group, narrative) {
  if (project.mode!=='upgrade' || !project.rowStates.size) return narrative?.approval || '未取得明确批准';
  const covered=new Set(), summaries=new Map();
  const add=(label,count)=>summaries.set(label,(summaries.get(label) ?? 0)+count);
  const outdated=id=>project.rowStates.get(id)?.decisionOutdated || project.reviewRowIds.has(id);
  for (const item of project.approvedItems) {
    const ids=group.rowIds.filter(id=>item.rowIds.includes(id) && !covered.has(id) && !outdated(id));
    if (!ids.length) continue;
    ids.forEach(id=>covered.add(id));
    add(item.decision==='NOT_IMPLEMENTED'?'明确不实施':item.action==='ACCEPT_NEW_BEHAVIOR'?'已批准接受新行为':'已批准实施',ids.length);
  }
  const stale=group.rowIds.filter(outdated);
  stale.forEach(id=>covered.add(id));
  if (stale.length) add('决定过期或待复核',stale.length);
  const unneeded=group.rowIds.filter(id=>!covered.has(id) && ['无需适配','范围外'].includes(project.classifications.get(id))
    && ['NO_CHANGE','OUT_OF_SCOPE'].includes(project.rowStates.get(id)?.outcome));
  unneeded.forEach(id=>covered.add(id));
  if (unneeded.length) add('无需修复批准',unneeded.length);
  const pending=group.rowIds.length-covered.size;
  const result=[...summaries].map(([label,count])=>`${label} ${count} 行`);
  if (pending) result.push(`待批准：${pending} 行未取得明确批准`);
  return result.join('；');
}

function approvalEvidence(project, group) {
  const selected=project.approvedItems.filter(item=>item.rowIds?.some(id=>group.rowIds.includes(id)));
  return decisionEvidence(selected);
}

function decisionEvidence(items) {
  return items.length ? `<details class="approval-evidence"><summary>决定答复与来源</summary><div class="detail-body">${items.map(item=>`<p>${h(item.id)}。实际答复 ${h(item.answer)}。来源 ${h(item.source)}</p>`).join('')}</div></details>` : '';
}

function renderKeyDecisions(projects) {
  const rows = [];
  for (const project of projects) {
    if (!project.repairDecisions.length) continue;
    for (const group of project.groups) {
      const ids = new Set(group.rowIds);
      const selected = project.repairDecisions.filter(item => item.rowIds.some(id => ids.has(id)));
      if (!selected.length) continue;
      const proposals = selected.map(item => `<p>${h(item.id)} · ${h(item.description)}</p>`).join('');
      const decisions = selected.map(item => {
        const label = item.decision === 'NOT_IMPLEMENTED' ? '明确不实施'
          : item.action === 'ACCEPT_NEW_BEHAVIOR' ? '已批准接受新行为' : '已批准实施';
        return `<p>${h(item.id)} · ${label} ${item.rowIds.filter(id => ids.has(id)).length} 行</p>`;
      }).join('');
      rows.push(`<tr><td data-label="变更条目">${changeHeading(group, project.rows.filter(row => ids.has(row.rowId)))}<p class="caption">${h(project.projectKey)}</p></td><td data-label="提交的方案">${proposals}</td><td data-label="用户决定">${decisions}${decisionEvidence(selected)}</td></tr>`);
    }
  }
  if (!rows.length) return '';
  return `<section class="panel" aria-labelledby="key-decisions-title"><details class="report-fold"><summary><h2 id="key-decisions-title">关键决策点 <span class="caption">· ${rows.length} 项</span></h2></summary><table class="decision-table"><colgroup><col style="width:28%"><col style="width:36%"><col style="width:36%"></colgroup><thead><tr><th scope="col">变更条目</th><th scope="col">提交的方案</th><th scope="col">用户决定</th></tr></thead><tbody>${rows.join('')}</tbody></table></details></section>`;
}

function upgradeMetrics(projects) {
  const totals = new Map(categories.map(category => [category, { rows: 0, repair: 0, accepted: 0 }]));
  for (const project of projects) {
    const approved = new Map();
    for (const item of project.repairDecisions) if (item.decision !== 'NOT_IMPLEMENTED') {
      for (const id of item.rowIds) approved.set(id, item.action);
    }
    for (const row of project.rows) {
      const metric = totals.get(assessmentLabel(project, row.rowId));
      if (!metric) continue;
      metric.rows++;
      const action = approved.get(row.rowId);
      if (action === 'APPLY_APPROVED_CHANGE') metric.repair++;
      if (action === 'ACCEPT_NEW_BEHAVIOR') metric.accepted++;
    }
  }
  return categories.map(label => {
    const { rows, repair, accepted } = totals.get(label);
    return [label, rows, [repair && `获批修复 ${repair} 行`, accepted && `接受新行为 ${accepted} 行`].filter(Boolean)];
  });
}

const uniqueNotes = items => [...new Set(items.map(item => item.trim()).filter(Boolean))];
const followUpItems = project => uniqueNotes([...project.gaps, ...(project.input.nextSteps ?? [])]);

function renderOverviewNotes(projects) {
  return projects.map((project, index) => {
    const rowsById = new Map(project.rows.map(row => [row.rowId, row]));
    const changes = [];
    for (const group of project.groups) {
      const modified = group.rowIds.filter(id => rowsById.get(id)?.result['处理结论'] === '已适配');
      if (!modified.length) continue;
      const chapter = rnohGroup(project, group) ? 'rnoh' : 'csv-assessment';
      const descriptions = new Set(modified.map(id => project.rowStates.get(id)?.reportSummary?.trim()));
      const [description] = descriptions;
      const brief = descriptions.size === 1 && description && description.length <= 120 && !/[\r\n]/.test(description)
        && modified.every(id => !project.reviewRowIds.has(id)) ? description : '';
      changes.push(`<li><a href="#${chapter}-${index}">${h(changeTitle(group))}</a> · 已适配 ${modified.length} 行${brief ? `<p class="caption">${h(brief)}</p>` : ''}</li>`);
    }
    for (const { fact, review, outdated } of project.ruleGaps?.entries ?? []) {
      if (!outdated && review.outcome === 'MODIFIED')
        changes.push(`<li><a href="#rule-gap-${index}">${h(fact.title)}</a> · 已修改 1 项（补充评估）</li>`);
    }
    const pending = [];
    if (project.pendingCounts.unresolvedCount) pending.push(`业务未决 ${project.pendingCounts.unresolvedCount} 行`);
    if (project.ruleGaps?.decisionRequired) pending.push('DevEco 规则包未覆盖条目的补充评估待用户决定');
    if (project.pendingCounts.reviewCount) pending.push(`待复核 ${project.pendingCounts.reviewCount} 行`);
    const notes = followUpItems(project);
    const pendingPreview = uniqueNotes([...pending, ...(project.scanEvidence?.gaps ?? []).map(gap => gap.summary), ...notes])
      .filter(item => item.length <= 140).slice(0, 3);
    const hasPending = project.pendingCount || notes.length;
    const name = projects.length > 1 ? `${h(project.projectKey)} · ` : '';
    const changeList = changes.length ? `<ul class="todo-list">${changes.slice(0, 5).join('')}</ul>` : '<p class="caption">当前无已记录的改动</p>';
    const remaining = changes.length > 5 ? `<details><summary>查看其余 ${changes.length - 5} 项改动</summary><ul class="todo-list">${changes.slice(5).join('')}</ul></details>` : '';
    const pendingList = pendingPreview.length ? `<ul class="todo-list">${pendingPreview.map(item => `<li>${h(item)}</li>`).join('')}</ul>` : '';
    const pendingLabel = hasPending ? `待处理原始行 ${project.pendingCount} 条 · 遗留事项 ${notes.length} 条` : '当前无已记录的待处理事项';
    return `<div class="overview-notes"><h3>${name}实际改动 · ${changes.length} 项</h3>${changeList}${remaining}<h3>待处理事项</h3><p class="caption">${pendingLabel}</p>${pendingList}${hasPending ? `<a class="caption" href="#follow-up-issues-${index}">查看全部遗留事项</a>` : ''}</div>`;
  }).join('');
}

function renderFollowUp(projects) {
  const list = (title, items, empty, renderItem = h, id) => {
    const unique = uniqueNotes(items);
    const content=unique.length ? `<ul class="todo-list">${unique.map(item => `<li>${renderItem(item)}</li>`).join('')}</ul>` : `<p class="caption">${empty}</p>`;
    return `<details><summary${id ? ` id="${id}"` : ''}>${title} · ${unique.length} 条</summary><div class="detail-body">${content}</div></details>`;
  };
  const body = projects.map((project, index) => {
    const suggestions = project.progressSnapshot.value?.testSuggestions;
    if (suggestions !== undefined && (!Array.isArray(suggestions) || suggestions.some(item => typeof item !== 'string')))
      throw new Error(`工程 ${project.projectKey}：progress.testSuggestions 必须为字符串数组`);
    const scanGaps = new Set(project.scanEvidence?.gaps.map(gap => gap.summary.trim()) ?? []);
    const links = project.scanEvidence?.links.join(' · ');
    const scanEvidence = links ? ` <span class="caption">· 扫描证据 ${links}</span>` : '';
    const renderGap = item => h(item) + (scanGaps.has(item) ? scanEvidence : '');
    return `<section class="follow-up-project" aria-labelledby="follow-up-${index}"><h3 id="follow-up-${index}">${h(project.projectKey)}</h3><div class="follow-up-grid">
      ${list('遗留事项',followUpItems(project), '未记录遗留事项；不代表验证通过。', renderGap, `follow-up-issues-${index}`)}
      ${list('测试建议',suggestions ?? [], '尚未提供针对性测试建议。')}
    </div></section>`;
  }).join('');
  return panel('follow-up-title', '遗留事项与测试建议', `<p class="caption follow-up-note">测试建议供后续安排，实际验证结果见各工程“独立验证”。</p>${body}`);
}

export function validateReportHtml(html, expectedRows = null) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
  if (!head || !/<style\b[^>]*>\s*\S[\s\S]*?<\/style>/i.test(head)) throw new Error('最终 HTML 缺少完整内联样式');
  if (/<script\b/i.test(html) || [...html.matchAll(/<[a-z][^>]*>/gi)].some(([tag]) => /\son\w+\s*=|(?:href|src)\s*=\s*["']?javascript:/i.test(tag)))
    throw new Error('最终 HTML 不能包含执行脚本');
  if (/<link\b[^>]*rel=["']stylesheet["']/i.test(html)) throw new Error('最终 HTML 不能依赖外部样式');
  for (const tag of ['html', 'head', 'body', 'main']) {
    if ((html.match(new RegExp(`<${tag}(?:\\s|>)`, 'gi')) ?? []).length !== 1
      || (html.match(new RegExp(`</${tag}>`, 'gi')) ?? []).length !== 1) throw new Error(`最终 HTML 的 ${tag} 结构不完整`);
  }
  if (/模板预览|待填写/.test(html)) throw new Error('最终 HTML 仍有模板残留');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => decode(m[1]));
  if (new Set(ids).size !== ids.length) throw new Error('最终 HTML 包含重复 ID');
  if (expectedRows) {
    const actual = [...html.matchAll(/<tr data-source="([^"]+)" data-row-id="([^"]+)"/g)]
      .map(m => JSON.stringify([decode(m[1]), decode(m[2])]));
    const expected = expectedRows.map(row => JSON.stringify([row.projectKey, row.rowId]));
    if (new Set(actual).size !== actual.length || actual.length !== expected.length || expected.some(key => !actual.includes(key)))
      throw new Error('最终 HTML 的逐行覆盖不完整或重复');
  }
}

async function collectProject(participant, input, mode, reportDirectory, taskDirectory, {state:providedState=null,generatedCsv=null,officialBehavior}={}) {
  const layout = participant.outputLayout, gaps = [], links = [];
  async function resource(file, label, required = true) {
    if (!file || !await exists(file)) {
      if (required) gaps.push(`证据缺失：${file ?? label}`);
      return h(`${label}（证据缺失）`);
    }
    const relative = path.relative(reportDirectory, file);
    if (path.isAbsolute(relative)) { gaps.push(`证据跨盘，未生成相对链接：${file}`); return h(`${label}：${file}`); }
    return `<a href="${h(relative.split(path.sep).map(encodeURIComponent).join('/'))}">${h(label)}</a>`;
  }
  const model = { mode, projectKey: participant.projectKey, input, gaps, rows: [], groups: [], classifications: new Map(), links,
    configuration: { ...input.configuration }, verification: [], statistics: null, status: participant.status,
    progressSnapshot: await optionalJson(layout?.progressPath ?? path.join(taskDirectory, mode, participant.projectKey, 'progress.json')),
    snapshots: [], pendingCount: 0, pendingCounts: {}, approvedItems: [], approvedSharedItems: [], repairDecisions: [],
    officialBehavior: new Map(), rowStates: new Map(), reviewRowIds: new Set() };
  for (const entry of input.verification ?? []) {
    const evidence = [];
    for (const file of entry.evidence ?? []) evidence.push(await resource(path.resolve(layout?.deliveryDirectory ?? participant.projectRoot, file), path.basename(file)));
    model.verification.push({ ...entry, evidence });
  }
  if (!layout || !await exists(layout.rawCsv)) {
    gaps.push(`原始扫描未取得：${participant.status}`);
    if (mode === 'upgrade') {
      model.scanDirectory = scanDirectoryLabel(participant, null, false);
      model.snapshots.push(model.progressSnapshot);
    }
    return model;
  }
  const state = providedState ?? await readTaskView(participant, mode), { raw, inspected } = state;
  if (mode === 'upgrade') {
    model.scanDirectory = scanDirectoryLabel(participant, state.scanMetadata?.sourceScope, true);
    model.csvOnly = participant.status === 'IMPORTED' && !state.scanMetadata;
  }
  if (!providedState) {
    const authoritative=state.reportData;
    for (const key of ['oldTarget','target','compatible']) if(authoritative.configuration[key]) {
      if (input.configuration?.[key] && !equalData(input.configuration[key], authoritative.configuration[key])) throw new Error(`旧报告配置与当前进度冲突：${key}`);
      model.configuration[key]=authoritative.configuration[key];
    }
    if (state.progress.value?.configurationImplementation) {
      if (input.configuration?.implementation && input.configuration.implementation!==authoritative.configuration.implementation) throw new Error('旧报告配置实施说明与当前进度冲突');
      model.configuration.implementation=authoritative.configuration.implementation;
    }
    for (const group of inspected.groups) {
      const current=narrativeFor(authoritative,group), supplied=narrativeFor(input,group);
      for (const key of ['before','after','targetIsolation']) if(current?.[key]) {
        if (supplied?.[key] && supplied[key]!==current[key]) throw new Error(`旧报告说明与当前分组冲突：${key}`);
        if (supplied) supplied[key]=current[key];
        else { input.changes ??= []; input.changes.push(current); break; }
      }
      const linked=state.records.some(entry=>entry.value?.assessmentSource && entry.value.rowResults.some(row=>group.rowIds.includes(row.rowId)));
      if (linked && supplied) {
        for (const key of ['business','compatibility','gaps']) {
          if (key==='business' && current[key]===undefined) continue;
          if (supplied[key] && supplied[key]!==current[key]) throw new Error(`旧报告说明与当前分组冲突：${key}`);
          supplied[key]=current[key];
        }
        // Explicit decisions are authoritative; legacy prose cannot invent approval.
        supplied.approval='';
      }
    }
    if (state.progress.value?.verificationSources?.length) {
      for (const old of input.verification ?? []) {
        const current=authoritative.verification.find(item=>item.name===old.name);
        if (current && old.status && old.status!=='待核对' && old.status!==current.status) throw new Error('旧报告验证结论与真实证据冲突');
      }
      model.verification=[];
      for (const entry of authoritative.verification) model.verification.push({...entry,evidence:await Promise.all(entry.evidence.map(file=>resource(file,path.basename(file))))});
    }
  }
  model.progressSnapshot = state.progress; model.snapshots = state.snapshots; model.pendingCount = state.pendingCount;
  model.rowStates=state.canonical; model.reviewRowIds=state.reviewRowIds;
  model.ruleGaps = state.ruleGaps;
  model.rnohReviews = state.rnohReviews;
  model.scanEvidence = { ...state.scanEvidence,
    links: await Promise.all(state.scanEvidence.sources.map(file => resource(file, path.basename(file)))) };
  model.pendingCounts=state.pendingCounts;
  const repair=state.progress.value?.decisions?.repair;
  model.approvedItems=[...(repair?.approvedItems ?? []),...(repair?.declinedItems ?? [])].filter(item=>activeDecision(item,repair) && state.records.some(record=>
    record.value?.id===item.groupId && record.value?.assessmentSource?.sha256===item.assessmentSha256));
  if (mode === 'upgrade' && model.approvedItems.length)
    model.repairDecisions = await reportRepairDecisions(state, model.approvedItems, gaps);
  model.approvedSharedItems=[...(repair?.approvedSharedItems ?? []),...(repair?.declinedSharedItems ?? [])].filter(item=>activeDecision(item,repair) && item.proposalSha256===repair?.proposal?.sha256);
  model.classifications = new Map(state.classifications); gaps.push(...state.gaps);
  const projected = new Map(state.projectedRows.map(result => [result.rowId, result]));
  model.rows = inspected.rows; model.groups = inspected.groups; model.statistics = inspected.statistics;
  for (const row of inspected.rows) for (const gap of row.gaps) gaps.push(`${row.rowId}：${gap}`);
  links.push(await resource(layout.rawCsv, '原始扫描'), await resource(repair?.plan ?? layout.specPath, '方案 spec', false));
  const adaptedPath=generatedCsv?.output ?? state.progress.value?.delivery?.adaptedCsv ?? layout.adaptedCsv;
  const prefix = input.resultColumnPrefix ? `${input.resultColumnPrefix} ` : '';
  let adapted = null;
  let hasAssessmentColumn = false;
  if (await exists(adaptedPath)) {
    const bytes = await readFile(adaptedPath);
    adapted = readScanInput(bytes);
    model.snapshots.push({file:adaptedPath,hash:sha256(bytes)});
    if (mode === 'upgrade' && adapted.headers.includes('评估结论') && !raw.headers.includes('评估结论')) {
      checkUpgradeResultColumns(raw, adapted);
      hasAssessmentColumn = true;
    } else {
      if (adapted.rows.length !== raw.rows.length || raw.headers.some((header, i) => adapted.headers[i] !== header)
        || raw.rows.some((row, i) => raw.headers.some(header => row[header] !== adapted.rows[i][header]
          && !(mode === 'deprecated' && header === 'Title' && titleText(row[header]) === adapted.rows[i][header]))))
        throw new Error(`结果 CSV 原列与原始行不对应：${participant.projectKey}`);
      const required = ['处理结论', '处理说明', '后续事项', ...(mode === 'deprecated' ? ['Row ID', ...deprecatedFacts] : [])];
      if (required.some(header => !adapted.headers.includes(prefix + header) || raw.headers.includes(prefix + header)))
        throw new Error(`结果列缺失或与原列冲突，请明确 resultColumnPrefix：${participant.projectKey}`);
    }
    links.push(await resource(adaptedPath, '逐行结果'));
  } else gaps.push(`结果 CSV 缺失：${adaptedPath}`);
  if (generatedCsv) model.generatedCsv=generatedCsv;
  const legacy = classificationMap(input.rowClassifications ?? [], new Set(raw.rowIds), participant, '报告 JSON');
  for (const [id, category] of legacy) {
    if (model.classifications.has(id) && model.classifications.get(id) !== category)
      throw new Error(`工程 ${participant.projectKey}；报告 JSON；rowId=${id}；分类与分组冲突：${category}，期望 ${model.classifications.get(id)}`);
    if (!model.classifications.has(id)) gaps.push(`报告分类尚无分组依据：${id}，保持待分类`);
  }
  for (const [i, row] of model.rows.entries()) {
    if (mode === 'upgrade' && !model.classifications.has(row.rowId)) gaps.push(`分类依据缺失：${row.rowId}`);
    if (mode === 'upgrade' && model.classifications.get(row.rowId) === '待分类') gaps.push(`分类尚未明确：${row.rowId}`);
    const values = adapted?.rows[i];
    if (hasAssessmentColumn && !matchesUpgradeResult('评估结论', values['评估结论'], model.classifications.get(row.rowId) ?? '待分类'))
      throw new Error(`工程 ${participant.projectKey}；${layout.adaptedCsv}；rowId=${row.rowId}；CSV评估结论与分组分类冲突`);
    const fields = ['处理结论', '处理说明', '后续事项', ...(mode === 'deprecated' ? deprecatedFacts : [])], expected = projected.get(row.rowId);
    if (values && expected && fields.some(key => mode === 'upgrade'
      ? !matchesUpgradeResult(key, values[prefix + key], expected[key]) : values[prefix + key] !== expected[key]))
      throw new Error(`工程 ${participant.projectKey}；${layout.adaptedCsv}；rowId=${row.rowId}；CSV处理结论或说明与分组逐行判断冲突`);
    row.result = expected ?? (values ? Object.fromEntries(fields.map(key => [key, values[prefix + key]]))
      : { 处理结论: mode === 'upgrade' ? '待决策' : 'EVIDENCE_GAP', 处理说明: '结果表缺失，本行尚无可核对结论', 后续事项: '补齐逐行结果' });
    if (state.canonical.has(row.rowId) && unresolvedOutcome(state.canonical.get(row.rowId).outcome, mode))
      gaps.push(`逐行判断尚有待办：${row.rowId}`);
    const next = mode === 'upgrade' ? row.result['后续事项'] : state.canonical.get(row.rowId)?.next;
    if (next?.trim()) gaps.push(`逐行后续事项：${row.rowId}：${next}`);
    const allowed = mode === 'upgrade' ? ['无需适配', '已适配', '待决策','未实施'] : deprecatedStates;
    if (!allowed.includes(row.result['处理结论']) || !row.result['处理说明']?.trim()) throw new Error(`非法逐行结果：${row.rowId}`);
    if (mode === 'deprecated' && values && (values[prefix + 'Row ID'] !== row.rowId || values[prefix + '处理来源'] !== 'MODEL_ASSESSED'))
      throw new Error(`废弃结果身份或处理来源不匹配：${row.rowId}`);
  }
  if (state.progress.value) {
    for (const group of state.progress.value.groups ?? []) {
      if (!group.record) continue;
      const file = path.resolve(layout.deliveryDirectory, group.record);
      if (relativePathInside(layout.deliveryDirectory, file) === null) throw new Error('进度分组路径越界');
      links.push(await resource(file, `分组 ${group.id ?? group.record}`));
    }
  } else gaps.push(`进度文件缺失：${layout.progressPath}`);
  for (const item of input.classificationEvidence ?? []) links.push(await resource(path.resolve(layout.deliveryDirectory, item), '分类依据'));
  for (const group of model.groups) {
    if (mode === 'upgrade' && !model.csvOnly && !isRnohRuleId(group.ruleId)) {
      const record = state.records.find(({ value }) => value?.rowResults?.some(row => group.rowIds.includes(row.rowId)))?.value;
      const official = await officialBehavior(group, record, state.scanMetadata?.officialComparison);
      if (official) {
        model.officialBehavior.set(group.identity ?? group.rowIds[0], official);
        for (const snapshot of official.snapshots) if (!state.snapshots.some(entry => entry.file === snapshot.file && entry.hash === snapshot.hash))
          state.snapshots.push(snapshot);
      } else gaps.push(`官方原文待核对：${group.ruleId ?? group.titles.join(' / ')}`);
      continue;
    }
    const narrative = narrativeFor(input, group);
    if (!narrative || !narrative.before || !narrative.after || mode === 'upgrade' && !narrative.targetIsolation)
      gaps.push(`变更业务说明缺失：${group.ruleId ?? group.titles.join(' / ')}`);
  }
  model.reportInputs=deliveryInputs(state);
  model.gaps = [...new Set(gaps)];
  return model;
}

function renderOfficialBehavior(official) {
  if (!official) return '<p>官方原文待核对</p>';
  const comparison = official.before && official.after
    ? `<p class="official-excerpt">变更前：${h(official.before)}</p><p class="official-excerpt">变更后：${h(official.after)}</p>`
    : official.comparisonTable ? `<p class="official-excerpt">${h(official.comparisonTable)}</p>` : '';
  return comparison + `<p>target 隔离：${h(official.target)}</p>`;
}

function renderScanCoverage(evidence) {
  const { cpp, gaps, links } = evidence;
  const status = { COMPLETE: '完整', NOT_APPLICABLE: '不适用', TIMED_OUT: '超时', PARTIAL: '部分完成', FAILED: '未完成' }[cpp] ?? '未知';
  let html = !gaps.length ? `<p>C/C++ 语义扫描覆盖：${status}</p>` : '';
  for (const gap of gaps) {
    const timing = [Number.isFinite(gap.durationMs) ? `耗时 ${(gap.durationMs / 1000).toFixed(1)} 秒` : '',
      gap.jarTimeoutSeconds ? `模块预算 ${gap.jarTimeoutSeconds} 秒` : '',
      gap.timeoutSource === 'SKILL_WATCHDOG' ? '触发 Skill 外层超时' : gap.timeoutSource === 'DEVECO_JAR' ? '触发 DevEco JAR 超时' : ''].filter(Boolean);
    html += `<p>${h([gap.summary, ...timing].join('。'))}</p>`;
    if (gap.skippedFiles?.length) html += '<details><summary>跳过文件</summary><ul>'
      + gap.skippedFiles.map(file => `<li><code>${h(file)}</code></li>`).join('') + '</ul></details>';
  }
  if (links.length) html += `<p>扫描证据 ${links.join(' · ')}</p>`;
  return html;
}

function renderApplicabilityExclusions({ exclusions }) {
  const items = exclusions.map(item => {
    const url = entryUrl(item.url), title = h(item.title), proof = item.applicabilityProof;
    const reason = item.reason === 'STAGE_MODEL_CONFIRMED' ? '已确认采用 Stage 模型' : item.reason;
    return `<li>${url ? `<a href="${h(url)}">${title}</a>` : title} · <code>${h(item.ruleId)}</code> · ${h(reason)}`
      + (proof?.modules?.length ? `。适用范围 ${h(proof.modules.join('、'))}` : '') + '</li>';
  });
  return `<ul>${items.join('')}</ul>`;
}

function renderCsvAssessment(project, mode, index, options = {}) {
  const key = project.projectKey, input = project.input;
  const groups = options.groups ?? project.groups, rows = options.rows ?? project.rows, idPrefix = options.idPrefix ?? 'p';
  let body = '';
  if (!rows.length && options.summary !== false) {
    const empty = mode === 'upgrade' ? '原始扫描 0 行。' : '原始扫描 0 行；保留扫描覆盖边界。';
    body += `<p class="summary-text">${project.statistics ? empty : '未开始、失败或尚未取得原始扫描。'}</p>`;
  }
  for (const [g, group] of groups.entries()) {
    const id = `${idPrefix}${index}-g${g}`, selected = rows.filter(row => group.rowIds.includes(row.rowId));
    const narrative = narrativeFor(input, group) ?? {};
    const classifications = selected.map(row => assessmentLabel(project, row.rowId));
    const results = selected.map(row => row.result['处理结论']);
    const tableRows = selected.map(row => {
      const extra = mode === 'deprecated' ? `<details><summary>迁移、兼容与验证依据</summary>${deprecatedFacts.map(field => `<p><strong>${h(field)}：</strong>${h(row.result[field] || '未提供')}</p>`).join('')}</details>` : '';
      const state=project.rowStates.get(row.rowId);
      const summary=mode==='upgrade' && !state?.decisionOutdated && !project.reviewRowIds.has(row.rowId) ? state?.reportSummary?.trim() : '';
      const description=summary ? `<span class="row-report-summary">${h(summary)}</span><details class="row-evidence"><summary>完整依据</summary><div class="detail-body">${h(row.result['处理说明'])}</div></details>` : h(row.result['处理说明']);
      return `<tr data-source="${h(key)}" data-row-id="${h(row.rowId)}"><td><span class="logical-row">逻辑行 ${row.logicalRow}</span><code class="full-row-id">${h(row.rowId)}</code></td><td><code class="path">${h(row.cells['Code Location'])}</code></td>${mode === 'upgrade' ? `<td>${h(assessmentLabel(project, row.rowId))}</td>` : ''}<td>${h(row.result['处理结论'])}</td><td>${description}${extra}</td><td>${h(row.result['后续事项'] || '—')}</td></tr>`;
    }).join('');
    const official = options.useOfficial ? project.officialBehavior.get(group.identity ?? group.rowIds[0]) : null;
    const summary = options.useOfficial ? renderOfficialBehavior(official)
      : `<p>变更前：${h(text(narrative.before))}</p><p>变更后：${h(text(narrative.after))}</p>${mode === 'upgrade' ? `<p>target 隔离：${h(text(narrative.targetIsolation))}</p>` : ''}`;
    const detail = `<div class="behavior-summary">${summary}</div>
      <details${mode === 'upgrade' ? ' class="detail-fold"' : ''}><summary>逐行依据与处理明细 · ${selected.length} 行</summary><div class="detail-body"><div class="rows-table-scroll" role="region" tabindex="0" aria-labelledby="${id}"><table class="rows-table">${mode === 'upgrade' ? '<colgroup><col style="width:20%"><col style="width:18%"><col style="width:7%"><col style="width:7%"><col style="width:32%"><col style="width:16%"></colgroup>' : ''}<thead><tr><th>完整 rowId</th><th>代码位置</th>${mode === 'upgrade' ? '<th>评估分类</th>' : ''}<th>处理结论</th><th>处理说明</th><th>后续事项</th></tr></thead><tbody>${tableRows}</tbody></table></div>
      <div class="change-summary">${facts([['业务与触发', narrative.business], ...(narrative.proposal ? [['评估方案与取舍',narrative.proposal]] : []), ['批准与决定', groupApproval(project,group,narrative)], ['兼容分析', narrative.compatibility], ['缺口与下一步', narrative.gaps]])}${approvalEvidence(project,group)}</div></div></details>`;
    if (mode === 'upgrade') {
      const url = selected.find(row => row.titleUrl)?.titleUrl ?? official?.url;
      const source = url ? `<p class="caption"><a class="change-link" href="${h(url)}">官方变更说明</a></p>` : '';
      body += `<article class="result"><details class="report-fold change-fold"><summary><h4 id="${id}">${h(changeTitle(group))}<span class="fold-status">评估：${h(countText(classifications))} · 修复：${h(countText(results))}</span></h4></summary>${source}${detail}</details></article>`;
    } else {
      body += `<article class="result"><h3 id="${id}">${changeHeading(group, selected)}</h3><div class="result-meta"><p>修复：${h(countText(results))}</p></div>${detail}</article>`;
    }
  }
  return body;
}

function renderRuleGapAssessment({ counts, entries, comparisonCurrent, decisionRequired, hasRecordedReviews }) {
  if (counts.ruleGapSkippedCount)
    return `<p>共 ${counts.ruleGapCount} 项。用户选择跳过补充评估。</p>`;
  if (!hasRecordedReviews && !comparisonCurrent)
    return `<p>原比对确认 ${counts.ruleGapCount} 项。比对来源已变化，需重新核对。</p>`;
  if (!hasRecordedReviews && decisionRequired)
    return `<p>共 ${counts.ruleGapCount} 项。待用户决定是否补充评估。</p>`;
  let body = '';
  for (const {fact,review,outdated,pending} of entries) {
    const source = fact.sourceUrl ? `<a href="${h(fact.sourceUrl)}">官方变更说明</a> · ` : '';
    const assessment = outdated ? '证据已变化，需复核' : displayUpgradeAssessment(review.category);
    const outcome = outdated ? '待复核' : review.outcome === 'NOT_IMPLEMENTED' ? '未实施' : labels[review.outcome] ?? review.outcome;
    const noChange=review.category==='无需适配';
    body += `<article class="result"><details class="report-fold change-fold"><summary><h4>${h(fact.title)}<span class="fold-status">评估：${h(assessment)} · 处理：${h(outcome)}</span></h4></summary><p>${source}<code>${h(fact.id)}</code> · ${h(fact.changedInSdk)} · ${h(fact.sourceReference)}</p>`
      + facts([['独立评估依据',review.reason],['代码位置',review.locations.join('\n') || (noChange?'无具体调用位置，见独立评估依据':'待核实')],
        ['补充方案',review.proposal || (noChange?'无需修改，不需要修复方案':'尚未形成修复方案')],
        ['批准与决定',review.decision?`${review.decision.action}；答复 ${review.decision.answer}；来源 ${review.decision.source}`:noChange?'无需修改，不要求修复批准':'未取得修复批准'],
        ['实际修改',review.changes.join('\n') || '未修改'],['证据',review.evidence.join('\n')],['下一步',review.next || (pending?'待完成本条评估、处理或复核':'无')]])+'</details></article>';
  }
  return body;
}

function renderCppTextCandidates(candidates = []) {
  if (!candidates.length) return '';
  const byModule = new Map();
  for (const candidate of candidates) {
    if (!byModule.has(candidate.module)) byModule.set(candidate.module, []);
    byModule.get(candidate.module).push(candidate);
  }
  const details = [...byModule].map(([module, rows]) => `<p><strong>${h(module)}</strong></p><ul>`
    + rows.map(row => `<li><code>${h(row.ruleId)}</code> · <code>${h(row.api)}</code> · <code class="path">${h(row.location)}</code></li>`).join('')
    + '</ul>').join('');
  return `<details><summary>C/C++ 文本候选 · ${candidates.length} 条（待人工核对）</summary><div class="detail-body">${details}</div></details>`;
}

const rnohGroup = (project, group) => isRnohRuleId(group.ruleId)
  || group.rowIds.length > 0 && group.rowIds.every(id => isRnohRuleId(project.rows.find(row => row.rowId === id)?.cells['Rule ID']));

function splitRnoh(project) {
  const groups = project.groups.filter(group => rnohGroup(project, group));
  if (!groups.length) return null;
  const ids = new Set(groups.flatMap(group => group.rowIds));
  return { groups, rows: project.rows.filter(row => ids.has(row.rowId)),
    mainGroups: project.groups.filter(group => !groups.includes(group)), mainRows: project.rows.filter(row => !ids.has(row.rowId)) };
}

const frameworkLabels = { CONFIRMED: '框架已确认传递', UNVERIFIED: '框架源码无法核对', NOT_USED: '当前版本框架未使用' };

function renderRnohAnalysis(project, split, index) {
  const summary = project.scanEvidence?.rnoh;
  const rows = split?.rows ?? [];
  const native = summary?.native?.length ? summary.native.map(item => `${item.version}（${item.form === 'RELEASE_BINARY' ? 'HAR 二进制' : item.form === 'DEBUG_SOURCE' ? '源码' : item.form}）`).join('、') : '未识别';
  const coverage = summary?.coverage ? Object.entries(summary.coverage).filter(([layer]) => layer !== 'business')
    .map(([layer, value]) => `${RNOH_LAYERS[layer] ?? layer}：${value}`).join('；') : '';
  const rules = Array.isArray(summary?.rules) ? summary.rules : [];
  const frameworkOnly = rules.filter(rule => rule.status === 'FRAMEWORK_ONLY');
  const unscanned = rules.filter(rule => rule.status === 'BUSINESS_NOT_SCANNED'), businessScanned = !summary?.coverage || summary.coverage.business === 'SCANNED';
  const classifications = rows.map(row => assessmentLabel(project, row.rowId));
  let body = '<p class="caption">列出 RNOH 框架受行为变更影响后、会改变 RN 业务 JS 表现的代码位置；RNOH 框架源码只作为只读依据，不列为逐行条目。</p>';
  body += facts([['RNOH 原生框架版本', native],
    ['RNOH JS 包', summary?.js ? `${summary.js.packageName ?? ''} ${summary.js.installedVersion ?? summary.js.declaredVersion ?? ''}`.trim() + (summary.js.reactNativeVersion ? `；react-native ${summary.js.reactNativeVersion}` : '') : '未识别'],
    ['扫描状态', summary?.status ?? '未提供'], ['框架依据核对', coverage],
    ['RN 业务 JS 受影响位置', businessScanned ? `${rows.length} 行，涉及 ${split?.groups.length ?? 0} 项变更` : '未检索（未找到 RN JS 工程）'], ['评估分类', countText(classifications)]]);
  if (summary?.gaps?.length) body += `<ul class="todo-list">${summary.gaps.map(gap => `<li>${h(typeof gap === 'string' ? gap : gap.summary ?? JSON.stringify(gap))}</li>`).join('')}</ul>`;
  if (split) body += renderCsvAssessment(project, 'upgrade', index, { groups: split.groups, rows: split.rows, idPrefix: 'r', summary: false });
  else body += businessScanned ? '<p class="summary-text">RN 业务 JS 中未发现受影响位置。</p>'
    : '<p class="summary-text">RN 业务 JS 未检索：未找到 RN JS 工程，下列规则是否影响业务页面未经检索确认。</p>';
  const review = project.rnohReviews ?? null, reviewOf = id => review?.entries.find(entry => entry.id === id) ?? null;
  const verdict = entry => !review ? '' : entry?.review
    ? ` · <strong>${h(rnohConclusionLabels[entry.review.conclusion] ?? entry.review.conclusion)}</strong>（${h(entry.review.evidenceLevel)}）：${h(entry.review.summary)}`
    : entry?.excluded != null ? ` · <strong>已排除</strong>：${h(entry.excluded)}` : ' · <strong>待核对</strong>';
  const ruleLine = rule =>
    `<li><code>${h(rule.ruleId)}</code> · ${h(rule.changedInSdk)} · ${h(rule.title)} · ${h(frameworkLabels[rule.framework?.status] ?? '')}${rule.framework?.locations?.length ? `：<code class="path">${h(rule.framework.locations.slice(0, 3).map(item => item.location).join('、'))}</code>` : ''}${verdict(reviewOf(rule.ruleId))}</li>`;
  if (frameworkOnly.length) body += `<h4>框架整体影响（无对应业务代码位置）</h4><ul>${frameworkOnly.map(ruleLine).join('')}</ul>`;
  if (unscanned.length) body += `<h4>业务 JS 未检索的规则（有业务触发写法，但未找到 RN JS 工程）</h4><ul>${unscanned.map(ruleLine).join('')}</ul>`;
  if (rules.length) body += `<details><summary>RNOH 规则核对 · ${rules.length} 条</summary><div class="detail-body"><ul>${rules.map(rule => {
    const result = rule.status === 'FRAMEWORK_ONLY' ? '框架整体影响' : rule.status === 'FRAMEWORK_NOT_AFFECTED' ? '不影响业务' : rule.status === 'BUSINESS_NOT_SCANNED' ? '业务 JS 未检索' : `业务位置 ${rule.businessCount ?? 0} 行`;
    return `<li><code>${h(rule.ruleId)}</code> · ${h(rule.changedInSdk)} · ${h(rule.title)} · ${h(frameworkLabels[rule.framework?.status] ?? '')}${rule.framework?.count ? ` ${rule.framework.count} 处` : ''} · ${h(result)}</li>`;
  }).join('')}</ul></div></details>`;
  const uncovered = Array.isArray(summary?.uncoveredEntries) ? summary.uncoveredEntries : [];
  const entryLine = entry => `${h(entry.changedInSdk ?? '')}${entry.kit ? ` · ${h(entry.kit)}` : ''} · ${h(entry.title ?? '')} · <code>${h(entry.sourceReference ?? '')}</code>`;
  if (review && (uncovered.length || review.libraries.length)) {
    const { counts } = review, assessed = review.entries.filter(entry => entry.kind === 'ENTRY' && entry.review);
    const detail = entry => `<li>${entryLine(entry)}<br><strong>${h(rnohConclusionLabels[entry.review.conclusion] ?? entry.review.conclusion)}</strong>（${h(entry.review.evidenceLevel)}） · ${h(entry.review.layer)} · 生效条件：${h(entry.review.condition)}<br>${h(entry.review.summary)}${entry.review.proposal ? `<br>方案：${h(entry.review.proposal)}${entry.review.sharedItemId ? `（<code>${h(entry.review.sharedItemId)}</code>）` : ''}` : ''}${entry.review.evidence.length ? `<br><span class="caption">证据：${h(entry.review.evidence.join('；'))}</span>` : ''}</li>`;
    body += `<h4>无 RNOH 规则条目补充核对</h4><p class="summary-text">共 ${counts.rnohReviewCount} 项（含 RNOH 规则 ${frameworkOnly.length + unscanned.length} 项）：逐条核对 ${counts.rnohReviewAssessedCount} 项，成组排除 ${counts.rnohReviewExcludedCount} 项，待核对 ${counts.rnohReviewPendingCount} 项。${review.stale ? '清单已变化，原登记结论未沿用。' : ''}</p>`;
    if (assessed.length) body += `<ul>${assessed.map(detail).join('')}</ul>`;
    if (review.libraries.length) body += `<h4>三方 RN 鸿蒙库</h4><ul>${review.libraries.map(item => detail({ title: item.id.slice(4), review: item })).join('')}</ul>`;
    for (const group of review.excludedGroups) {
      const members = review.entries.filter(entry => entry.excluded !== null && group.entries.includes(entry.id));
      if (members.length) body += `<details><summary>已排除 · ${members.length} 项 · ${h(group.reason)}</summary><div class="detail-body"><ul>${members.map(entry => `<li>${entryLine(entry)}</li>`).join('')}</ul></div></details>`;
    }
    const pending = review.entries.filter(entry => entry.kind === 'ENTRY' && entry.pending);
    if (pending.length) body += `<details><summary>待核对 · ${pending.length} 项</summary><div class="detail-body"><ul>${pending.map(entry => `<li>${entryLine(entry)}</li>`).join('')}</ul></div></details>`;
  } else if (uncovered.length) body += `<details><summary>无 RNOH 规则的变更条目 · ${uncovered.length} 项</summary><div class="detail-body"><ul>${uncovered.map(entry => `<li>${entryLine(entry)}</li>`).join('')}</ul></div></details>`;
  return body;
}

function renderProject(project, mode, index) {
  const key = project.projectKey, input = project.input, config = project.configuration;
  const verification = project.verification.map(item => `<p>${h(item.name)}：${h(text(item.status))}；${h(item.details)} ${item.evidence.join(' · ')}</p>`).join('')
    || '<p>未提供当前验证事实，不能推断通过。</p>';
  const split = mode === 'upgrade' ? splitRnoh(project) : null;
  const csv = renderCsvAssessment(project, mode, index, {
    ...(split ? { groups: split.mainGroups, rows: split.mainRows } : {}),
    useOfficial: mode === 'upgrade' && !project.csvOnly,
  });
  if (mode === 'upgrade') {
    const chapters = [];
    if (project.scanEvidence?.exclusions.length)
      chapters.push([`applicability-${index}`, '按工程适用性排除', `${project.scanEvidence.exclusions.length} 项`, renderApplicabilityExclusions(project.scanEvidence)]);
    const csvTitle = project.csvOnly ? 'CSV 导入条目' : 'DevEco 规则包覆盖条目';
    const csvSummary = project.statistics ? `${(split?.mainGroups ?? project.groups).length} 项 · ${(split?.mainRows ?? project.rows).length} 行` : '未取得扫描结果';
    chapters.push([`csv-assessment-${index}`, csvTitle, csvSummary, csv
      + renderCppTextCandidates(project.scanEvidence?.textCandidates)]);
    if (split || project.scanEvidence?.rnoh)
      chapters.push([`rnoh-${index}`, 'RNOH 业务影响分析', `业务位置 ${split?.rows.length ?? 0} 行`, renderRnohAnalysis(project, split, index)]);
    if (project.ruleGaps?.entries.length) {
      const { counts, comparisonCurrent, decisionRequired, hasRecordedReviews } = project.ruleGaps;
      let status = `未完成 ${counts.ruleGapPendingCount} 项`;
      if (counts.ruleGapSkippedCount) status = '已跳过';
      else if (!hasRecordedReviews && !comparisonCurrent) status = '待复核';
      else if (!hasRecordedReviews && decisionRequired) status = '待决定';
      chapters.push([`rule-gap-${index}`, 'DevEco 规则包未覆盖条目补充处理', `${counts.ruleGapCount} 项 · ${status}`, renderRuleGapAssessment(project.ruleGaps)]);
    }
    const statuses = uniqueNotes(project.verification.map(item => String(item.status ?? '')));
    chapters.push([`verification-${index}`, '独立验证', statuses.join(' · ') || '未提供证据', verification]);
    const body = chapters.map(([id, title, status, content], number) =>
      `<section class="project-chapter" aria-labelledby="${id}"><details class="report-fold"><summary><h3 id="${id}">${number + 1}. ${title} <span class="caption">· ${h(status)}</span></h3></summary>${content}</details></section>`).join('');
    return panel(`project-${index}`, `${key} · 评估与修复`, body);
  }
  let body = facts([['target 升级', `${text(config.oldTarget)} → ${text(config.target)}`], ['compatible', config.compatible], ['配置实施', config.implementation]]);
  if (project.scanEvidence) {
    body += '<h3>扫描覆盖</h3>' + renderScanCoverage(project.scanEvidence);
    if (project.scanEvidence.exclusions.length) body += '<h3>按工程适用性排除</h3>' + renderApplicabilityExclusions(project.scanEvidence);
  }
  if (project.approvedSharedItems.length) {
    body += '<h3>共享修改批准</h3><ul>' + project.approvedSharedItems.map(item=>
      `<li>${h(item.id)}。${item.decision==='NOT_IMPLEMENTED'?'未实施。':''}实际答复 ${h(item.answer)}。来源 ${h(item.source)}</li>`).join('') + '</ul>';
  }
  body += csv + '<h3>独立验证</h3>' + verification;
  body += `<details><summary>来源、缺口与后续事项</summary><div class="detail-body"><p>${project.links.join(' · ')}</p><ul class="todo-list">${[...project.gaps, ...(input.nextSteps ?? [])].map(item => `<li>${h(item)}</li>`).join('') || '<li>未发现输入结构缺口；业务结论以实际评估和验证证据为准。</li>'}</ul></div></details>`;
  return panel(`project-${index}`, `${key} · 评估与修复`, body);
}

export async function renderReport({ taskFile, mode, data, output = null, dataSnapshot = null }, io = {}) {
  requireScanMode(mode);
  const unified=data===undefined || data===null;
  if (!unified && !Array.isArray(data.projects)) throw new Error('报告 JSON 必须包含 projects 数组');
  if (dataSnapshot) {
    await checkSnapshot(dataSnapshot);
    if (JSON.stringify(JSON.parse((await readFile(dataSnapshot.file,'utf8')).replace(/^\ufeff/,'')))!==JSON.stringify(data))
      throw new Error('报告输入数据与来源JSON不一致');
  }
  const taskSnapshot={file:path.resolve(taskFile),hash:sha256(await readFile(path.resolve(taskFile)))};
  const task = await readTask(path.resolve(taskFile));
  await checkSnapshot(taskSnapshot);
  const participants = task.participants.filter(item => item.mode === mode);
  if (!participants.length) throw new Error('任务中没有该功能的参与工程');
  const views=new Map(), generated=new Map();
  if (unified) {
    data={projects:[]};
    for (const participant of participants) {
      if (!participant.outputLayout || !await exists(participant.outputLayout.rawCsv)) {
        // Prepare only the missing progress record for an unstarted participant.
        const file=participant.outputLayout?.progressPath ?? path.join(task.taskDirectory,mode,participant.projectKey,'progress.json');
        const snapshot=await optionalJson(file);
        if (!snapshot.value) { await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,JSON.stringify({groups:[],delivery:{},decisions:{}}),{flag:'wx'}); }
        data.projects.push({projectKey:participant.projectKey}); continue;
      }
      const view=await readTaskView(participant,mode,{strict:true});
      view.snapshots.push(taskSnapshot);
      views.set(participant.projectKey,view); data.projects.push(view.reportData);
    }
    await io.beforeWrite?.();
    for (const view of views.values()) for (const snapshot of view.snapshots) await checkSnapshot(snapshot);
    for (const [key,view] of views) generated.set(key,await writeProjectCsv(view,{track:false}));
  }
  const keys = new Set(participants.map(item => item.projectKey)), inputs = new Map();
  for (const item of data.projects) {
    if (!keys.has(item.projectKey) || inputs.has(item.projectKey)) throw new Error(`未知或重复报告工程：${item.projectKey}`);
    inputs.set(item.projectKey, item);
  }
  let target = path.resolve(output ?? path.join(task.taskDirectory, mode, 'api-adapt-report.html'));
  const projects = [];
  const officialBehavior = createOfficialBehaviorReader(path.join(skillRoot, 'references', 'changelogs'));
  for (const participant of participants) projects.push(await collectProject(participant, inputs.get(participant.projectKey) ?? {}, mode, path.dirname(target), task.taskDirectory,
    {state:views.get(participant.projectKey),generatedCsv:generated.get(participant.projectKey),officialBehavior}));
  if (dataSnapshot) for (const project of projects) {
    project.snapshots.push(dataSnapshot);
    if (project.reportInputs) {
      const layout = task.participants.find(item=>item.projectKey===project.projectKey).outputLayout;
      const directory = path.join(layout.evidenceDirectory,'reports');
      await ensureBatchDirectory(layout,directory);
      const file = path.join(directory,`report-input-${dataSnapshot.hash}.json`), bytes = await readFile(dataSnapshot.file);
      if (sha256(bytes)!==dataSnapshot.hash) throw new Error('报告输入在归档前已变化');
      try { await writeFile(file,bytes,{flag:'wx'}); }
      catch (error) { if (error.code!=='EEXIST') throw error; if (!(await readFile(file)).equals(bytes)) throw new Error('报告输入归档已变化'); }
      const archived = {file,hash:dataSnapshot.hash};
      project.snapshots.push(archived);
      project.reportInputs.files.push(archived);
    }
  }
  if (mode === 'upgrade') {
    for (const project of projects) project.versionDisplay = upgradeConfiguration(project);
  }
  const rowCount = projects.reduce((n, project) => n + project.rows.length, 0);
  const gapCount = projects.reduce((n, project) => n + project.gaps.length, 0);
  const metricValues = mode === 'upgrade' ? upgradeMetrics(projects)
    : deprecatedStates.map(state => [labels[state], projects.reduce((n, p) => n + p.rows.filter(row => row.result['处理结论'] === state).length, 0)]);
  const customTitle = mode === 'upgrade' && data.title === 'API 行为变更适配报告' ? undefined : data.title;
  const title = customTitle ?? (mode === 'upgrade' ? 'API版本升级适配报告' : '废弃 API 迁移报告');
  const unknownProjects = projects.filter(p => !p.statistics).length;
  const subtitle = mode === 'upgrade' ? renderUpgradeSubtitles(projects)
    : `<p class="hero-note">参与工程 ${projects.length} · 已取得原始逻辑行 ${rowCount} · 验证状态见各工程实际证据</p>`;
  let body = `<main class="report"><header class="hero"><div class="hero-top"><h1>${h(title)}</h1><span class="hero-status">${gapCount ? '部分完成 · 存在证据缺口' : h(data.status ?? '逐行结果已整理')}</span></div>${subtitle}</header>
    <dl class="metrics${mode === 'deprecated' ? ' six' : ''}">${metricValues.map(([label, value, decisions]) => `<div class="metric"><dt>${h(label)}${decisions?.length ? `<span class="metric-decisions">${h(decisions.join(' · '))}</span>` : ''}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
  if (mode === 'deprecated') body += `\n    <div class="supplement"><span>统计仅包含已取得的 CSV；${unknownProjects ? `${unknownProjects} 个工程的原始行数未知` : '全部工程原始行数已核对'}。</span></div>`;
  body += panel('projects-title', '工程总览', `<table class="project-table"><thead><tr><th>工程</th><th>target升级</th><th>compatible</th><th>原始扫描结果</th><th>适配情况</th><th>编译构建</th><th>运行情况</th></tr></thead><tbody>${projects.map(p => {
    const config = p.configuration, build = p.verification.filter(v => /编译|构建/.test(v.name)).map(v => v.status).join('；'), runtime = p.verification.filter(v => /运行|设备/.test(v.name)).map(v => v.status).join('；');
    const target = p.versionDisplay
      ? h(p.versionDisplay.targetUpgrade)
      : `${h(text(config.oldTarget))} → ${h(text(config.target))}`;
    const cells = [['工程', h(p.projectKey)], ['target升级', target], ['compatible', h(p.versionDisplay?.compatible ?? text(config.compatible))],
      ['原始扫描结果', p.statistics ? `${p.rows.length} 行 / ${p.statistics.physicalFileCount ?? '未知'} 文件 / ${p.statistics.workUnitCount ?? '未知'} 单元` : mode === 'upgrade' ? `原始行数未知（${h(p.status)}）` : h(p.status)],
      ['适配情况', p.statistics ? h(countText(p.rows.map(r => r.result['处理结论']))) : '尚无可统计的原始行'], ['编译构建', h(build || '未提供证据')], ['运行情况', h(runtime || '未提供证据')]];
    return `<tr>${cells.map(([label, value]) => `<td data-label="${h(label)}">${value}</td>`).join('')}</tr>`;
  }).join('')}</tbody></table>${mode === 'upgrade' ? renderOverviewNotes(projects) : ''}`);
  if (mode === 'upgrade') body += renderKeyDecisions(projects);
  body += projects.map((project, index) => renderProject(project, mode, index)).join('');
  const fingerprint = mode === 'upgrade' ? reportFingerprint : undefined;
  if (mode === 'upgrade') body += renderFollowUp(projects) + reportTimeFooter(io.now?.() ?? new Date());
  body += '</main>';
  const template = await readFile(path.join(skillRoot, 'templates', mode === 'upgrade' ? 'upgrade-report.html' : 'deprecated-report.html'), 'utf8');
  const start = '<!-- adapter:report -->', end = '<!-- /adapter:report -->';
  if (template.split(start).length !== 2 || template.split(end).length !== 2) throw new Error('报告模板缺少唯一内容区域');
  const html = template.replace(/<!-- adapter:report -->[\s\S]*?<!-- \/adapter:report -->/, () => body)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${h(title)}</title>`);
  const expectedRows = projects.flatMap(project => project.rows.map(row => ({ projectKey: project.projectKey, rowId: row.rowId })));
  validateReportHtml(html, expectedRows);
  for (const project of projects) for (const snapshot of project.snapshots) await checkSnapshot(snapshot);
  await mkdir(path.dirname(target), { recursive: true });
  const prior=projects.find(project=>project.progressSnapshot.value?.delivery?.report)?.progressSnapshot.value.delivery;
  let hash = sha256(html);
  if (unified) {
    const saved=await saveGeneratedOutput(target,html,{file:prior?.report,sha256:prior?.reportSha256},
      projects.flatMap(project=>project.snapshots.map(snapshot=>snapshot.file)), { fingerprint });
    target=saved.output;
    hash=saved.sha256;
  } else {
    const previous = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous) {
      const previousHash = sha256(previous);
      if (previousHash !== hash) {
        const unchanged = fingerprint && fingerprint(previous) === fingerprint(Buffer.from(html));
        const edited = unchanged && prior?.reportSha256 && prior.reportSha256 !== previousHash
          && samePath(await physicalOutput(prior.report), await physicalOutput(target));
        if (!unchanged || edited)
          throw new Error(`报告已存在且内容不同，请使用 --output 另存：${target}`);
      }
      hash = previousHash;
    } else {
      const handle = await open(target, 'wx');
      try { await handle.writeFile(html); }
      catch (error) { await handle.close(); await unlink(target); throw error; }
      await handle.close();
    }
  }
  await io.beforePublish?.();
  for (const project of projects) for (const snapshot of project.snapshots)
    if (snapshot.file !== project.progressSnapshot.file) await checkSnapshot(snapshot);
  const published = await readFile(target);
  if (sha256(published) !== hash) throw new Error(`报告文件已变化，未发布：${target}`);
  validateReportHtml(published.toString('utf8'), expectedRows);
  const progressUpdated = await publishProgress(projects, target, hash, io);
  return { output: target, rowCount, projectCount: projects.length, gapCount, sha256: hash, progressUpdated,
    pending:projects.map(project=>({projectKey:project.projectKey,pendingCount:project.pendingCount,...project.pendingCounts})) };
}

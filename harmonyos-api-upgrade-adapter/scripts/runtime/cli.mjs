#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMainModule } from '../shared/platform/entrypoint.mjs';
import { caseTimeoutMs, createSource, validatePlan, requireValue } from './contracts.mjs';
import { readJson, writeJson } from './io.mjs';
import { archivePackage, CASE_FORMAT, caseFile, freezeRun } from './runs.mjs';
import { generateCaseTemplate } from './generate.mjs';
import { executeRun } from './execute.mjs';
import { installHap } from './install.mjs';
import { writeReport } from './report.mjs';
import { renderTestReport } from './report-html.mjs';
import { formatUpgradeResults } from '../shared/format/upgrade-results.mjs';
import { parseArgs, requireString } from '../shared/format/args.mjs';
import { taskForOutput, writeTaskRuntimeCsv } from './task-csv.mjs';

const help = `CSV功能验收（语义内容由模型依据原始CSV、源码和获批spec填写）
  sources <来源配置JSON> <runtime目录>         原始CSV→行身份和明确选择
  assemble <runtime目录>                     校验sources/route-map/test-spec/test-cases并生成plan.json
  scripts <runtime目录>                      生成待填写JSON操作清单，不覆盖已有文件
  archive <packages目录> <before|after> <构建凭据JSON>
  freeze <runtime目录> <执行配置JSON>          保存用例/脚本/包完整快照
  run <run目录> --python <本地Python> [--hdc <本地HDC>]  Hypium执行固定阶段顺序
  install --hdc <HDC路径> --serial <设备> --hap <本次HAP> --sha256 <哈希> --evidence-dir <证据目录>
  report <run目录> <交付目录>                 审计、生成逐行HTML报告和截图索引
  csv <run目录> <sourceId> --task <taskFile> --project <工程> [--output <输出CSV>]
  csv <run目录> <sourceId> <旧逐行处理JSON> <输出CSV>  兼容独立输入；任务内核对当前分组
配置格式见 references/common/runtime-contracts.md；工具不执行修复或自动签名。`;

async function deliver(file, data, runId) {
  await mkdir(path.dirname(file), { recursive: true });
  const ext = path.extname(file);
  for (let i = 0; ; i++) {
    const target = i === 0 ? file : path.join(path.dirname(file), path.basename(file, ext) + '-' + runId + (i === 1 ? '' : '-' + i) + ext);
    try { await writeFile(target, data, { flag: 'wx' }); return target; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
export async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help') { console.log(help); return; }
  if (command === 'install') {
    const options = parseArgs(args);
    const result = await installHap({ hdc: requireString(options, 'hdc'), serial: requireString(options, 'serial'),
      hap: requireString(options, 'hap'), sha256: requireString(options, 'sha256'), evidenceDir: requireString(options, 'evidence-dir') });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'BLOCKED') process.exitCode = 2;
    return;
  }
  const [first, second, third, fourth] = args;
  requireValue(first, '缺少参数；运行 help 查看格式');
  if (command === 'sources') {
    const config = await readJson(first), sources = [];
    for (const s of config.sources) sources.push(createSource(await readFile(s.scanCsv), s.sourceId, s.selection, {encoding:s.encoding}));
    await writeJson(path.join(second, 'sources.json'), sources, true);
  } else if (command === 'assemble') {
    const plan = { schemaVersion: 1, sources: await readJson(path.join(first, 'sources.json')),
      routeMap: await readJson(path.join(first, 'route-map.json')), spec: await readJson(path.join(first, 'test-spec.json')),
      cases: await readJson(path.join(first, 'test-cases.json')) };
    const counts = validatePlan(plan);
    for (const c of plan.cases.cases) caseTimeoutMs(c);
    console.log(counts); await writeJson(path.join(first, 'plan.json'), plan);
  } else if (command === 'scripts') {
    const plan = await readJson(path.join(first, 'plan.json')); validatePlan(plan);
    await mkdir(path.join(first, 'scripts'), { recursive: true });
    for (const c of plan.cases.cases) {
      try { await writeFile(path.join(first, caseFile(c.id, CASE_FORMAT)), generateCaseTemplate(c), { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  } else if (command === 'archive') console.log(await archivePackage(first, second, await readJson(third)));
  else if (command === 'freeze') {
    const plan = await readJson(path.join(first, 'plan.json')), config = await readJson(second), scripts = Object.create(null);
    validatePlan(plan);
    for (const c of plan.cases.cases) scripts[c.id] = await readFile(path.join(first, caseFile(c.id, CASE_FORMAT)), 'utf8');
    console.log(await freezeRun(first, plan, { ...config, scripts }));
  } else if (command === 'run') {
    const options = parseArgs(args.slice(1));
    const python = requireString(options, 'python'), hdc = options.hdc === undefined ? 'hdc' : requireString(options, 'hdc');
    const result = await executeRun(first, { python, hdc }); console.log(result.status);
    if (result.status === 'BLOCKED') { console.error(result.reason); process.exitCode = 2; }
  } else if (command === 'report') {
    const summary = await writeReport(first, second);
    console.log(await deliver(path.join(second, 'test-report.html'), await renderTestReport(first, summary, second), summary.runId));
    console.log(summary.counts);
  } else if (command === 'csv') {
    if (third?.startsWith('--')) {
      const options=parseArgs(args.slice(2));
      console.log(await writeTaskRuntimeCsv({runDirectory:first,sourceId:second,taskFile:requireString(options,'task'),projectPath:requireString(options,'project'),
        output:options.output===undefined?undefined:requireString(options,'output')}));
      return;
    }
    const context=await taskForOutput(fourth);
    if (context) {
      console.log(await writeTaskRuntimeCsv({...context,runDirectory:first,sourceId:second,output:fourth,legacyResults:await readJson(third)}));
      return;
    }
    const summary = await writeReport(first, path.dirname(fourth)), plan = await readJson(path.join(first, 'inputs', 'plan.json'));
    const source = plan.sources.find(s => s.sourceId === second); requireValue(source, '未知sourceId');
    const screenshots = (await readJson(path.join(first, 'screenshots-by-source.json')))[second] ?? {};
    const classifications = new Map();
    for (const { category, rowRefs } of plan.spec.classifications ?? []) {
      for (const ref of rowRefs) if (ref.sourceId === second) classifications.set(ref.rowId, category);
    }
    const decisions = await readJson(third);
    requireValue(Array.isArray(decisions), 'results 必须是逐行结果数组');
    const results = decisions.map(row => row && row['评估结论'] === undefined
      ? { ...row, 评估结论: classifications.get(row.rowId) } : row);
    const csv = formatUpgradeResults(Buffer.from(source.csvBase64, 'base64'), results, { screenshots, sourceEncoding:source.encoding });
    console.log(await deliver(fourth, csv, summary.runId));
  } else throw new Error('未知命令: ' + command);
}
if (isMainModule(import.meta.url))
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

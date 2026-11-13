#!/usr/bin/env node
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMainModule } from '../shared/platform/entrypoint.mjs';
import { parseArgs, requireString, booleanArg } from '../shared/format/args.mjs';
import { formatUpgradeResults } from '../shared/format/upgrade-results.mjs';
import { formatDeprecatedResults } from '../shared/format/deprecated-results.mjs';
import { inspectScan } from '../shared/platform/scan-inspection.mjs';
import { requireScanMode } from '../shared/platform/scan-mode.mjs';
import { samePath } from '../shared/platform/paths.mjs';
import { atomicWrite } from '../shared/io/fs-utils.mjs';
import { taskProject, prepareProjectGroups, diagnoseProjectGroups, checkSnapshot, inspectProjectGroups } from '../shared/platform/group-results.mjs';
import { prepareSpec } from './spec.mjs';
import { draftAssessment, checkAssessment, importAssessment, recordApproval, draftResolution, updateResolution } from './assessment.mjs';
import { verifyDelivery } from './delivery.mjs';
import { readTaskView } from '../shared/platform/task-view.mjs';
import { writeProjectCsv } from './project.mjs';
import { decodeCsvBuffer } from '../shared/format/scan-input.mjs';
import { recordVerification } from './verification.mjs';
import { prepareRuleGapReviews, recordRuleGapDecision, recordRuleGapReview } from './rule-gaps.mjs';
import { recordRnohReview } from './rnoh-review.mjs';
import { withReceiptOutput } from './storage.mjs';

const help = `固定 CSV 工具（只读取、统计和格式化，不判断适配语义）
  record-rule-gap-decision --task <taskFile> --project <工程> --mode upgrade --input <补充评估决定JSON>
  prepare-rule-gaps --task <taskFile> --project <工程> --mode upgrade
  record-rule-gap-review --task <taskFile> --project <工程> --mode upgrade --input <独立补充评估JSON>
  record-rnoh-review --task <taskFile> --project <工程> --mode upgrade --input <RNOH补充核对JSON>
  draft-assessment --task <taskFile> --project <工程> --mode upgrade --group <ID> --output <评估草稿JSON>
  check-assessment --task <taskFile> --project <工程> --mode upgrade --group <ID> --input <评估草稿JSON>
  import-assessment --task <taskFile> --project <工程> --mode upgrade --group <ID> --input <模型评估JSON> [--reassess --reason <原因>]
  prepare-spec --task <taskFile> --project <工程> --mode upgrade --input <方案JSON> --output <spec.md>
  record-approval --task <taskFile> --project <工程> --mode upgrade --input <明确批准JSON>
  record-decision --task <taskFile> --project <工程> --mode upgrade --input <批准或不实施决定JSON>
  record-verification --task <taskFile> --project <工程> --mode upgrade --input <真实验证引用JSON>
  draft-resolution --task <taskFile> --project <工程> --mode upgrade --group <ID> --output <处理草稿JSON> [--approval <批准ID>] [--review] [--row-id <完整rowId> ...]
  update-resolution --task <taskFile> --project <工程> --mode upgrade --group <ID> --input <处理更新JSON>
  verify --task <taskFile> --project <工程> --mode upgrade [--adapted <结果CSV>] [--report <报告HTML>]
  prepare --task <taskFile> --project <工程> --mode upgrade|deprecated
  validate --task <taskFile> --project <工程> --mode upgrade|deprecated [--details] [--output <只读诊断JSON>]
  inspect --task <taskFile> --project <工程> --mode upgrade|deprecated [--group <分组ID>] [--output <只读输入JSON>]
  write --task <taskFile> --project <工程> --mode upgrade|deprecated [--output <另存CSV>] [--column-prefix <废弃本轮ID>]
  inspect --mode upgrade|deprecated --scan <原CSV> --project <工程> [--scan-json <同批JSON>]
  write --mode upgrade|deprecated --scan <原CSV> --results <逐行JSON> --output <结果CSV> [--column-prefix <废弃本轮ID>]
独立 inspect/write 可追加 --encoding auto|utf-8|gb18030（默认 utf-8）；任务模式复用导入编码。
import-assessment、record-approval、record-decision、record-rule-gap-decision、record-rnoh-review、update-resolution、verify 可追加 --receipt-output <新回执JSON>。
截图列使用 runtime csv 命令重新审计后输出。`;
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\ufeff/, ''));
const receiptCommands = new Set(['import-assessment', 'record-approval', 'record-decision', 'record-rule-gap-decision', 'record-rnoh-review', 'update-resolution', 'verify']);

async function physical(file) {
  let current = path.resolve(file), tail = [];
  while (true) {
    try { return path.join(await realpath(current), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current)); current = parent;
    }
  }
}

async function saveTaskJson({ result, state }, options, outputPath) {
  const output = path.resolve(outputPath), target = await physical(output);
  const protectedFiles = new Set([options.taskFile, ...state.snapshots.map(item => item.file),
    ...state.inspected.rows.map(row => row.physicalFile).filter(Boolean)]);
  for (const file of protectedFiles) if (samePath(await physical(file), target)) throw new Error('不能覆盖任务、原始扫描、分组或源码输入');
  for (const snapshot of state.snapshots) await checkSnapshot(snapshot);
  const bytes = JSON.stringify({ ok: true, result }, null, 2) + '\n';
  await mkdir(path.dirname(output), { recursive: true });
  try { await writeFile(output, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(output, 'utf8') !== bytes) throw new Error(`输出已存在且内容不同，请另存：${output}`);
  }
  return { output, projectKey: result.projectKey, rowCount: result.rowCount ?? result.group?.rowCount ?? result.statistics.rowCount,
    ...(result.statistics ? { groupId: result.group?.id ?? null } : {}),
    ...(typeof result.pendingCount === 'number' ? { pendingCount: result.pendingCount } : {}) };
}

export async function writeResults({ mode, scan, results, output, columnPrefix = '', encoding = 'utf-8' }, io = { atomicWrite }) {
  requireScanMode(mode);
  const target = await physical(output);
  for (const input of [scan, results]) if (samePath(await physical(input), target)) throw new Error('不能覆盖原始扫描表或逐行结果输入');
  const bytes = await readFile(scan), decisions = await readJson(results);
  const sourceEncoding=decodeCsvBuffer(bytes,encoding).encoding;
  const csv = mode === 'upgrade' ? formatUpgradeResults(bytes, decisions, {sourceEncoding})
    : formatDeprecatedResults(bytes, decisions, { columnPrefix, sourceEncoding });
  try { await io.atomicWrite(path.resolve(output), csv); }
  catch (error) {
    if (['EACCES', 'EBUSY', 'EPERM'].includes(error.code))
      throw Object.assign(new Error(`写入失败 ${error.code}；请关闭 Excel/WPS 等占用程序后按原路径重试：${output}`, { cause: error }), { code: error.code });
    throw error;
  }
  return { output: path.resolve(output), rowCount: decisions.length, encoding:sourceEncoding };
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) return { usage: help };
  const operations={'prepare-rule-gaps':prepareRuleGapReviews,'record-rule-gap-decision':recordRuleGapDecision,'record-rule-gap-review':recordRuleGapReview,'record-rnoh-review':recordRnohReview,'draft-assessment':draftAssessment,'check-assessment':checkAssessment,'import-assessment':importAssessment,'prepare-spec':prepareSpec,'record-approval':recordApproval,'record-decision':recordApproval,'record-verification':recordVerification,'draft-resolution':draftResolution,'update-resolution':updateResolution,verify:verifyDelivery};
  if (!Object.hasOwn(operations, command) && !['inspect', 'write', 'prepare', 'validate'].includes(command)) throw new Error(command === 'report'
    ? '未知命令: report。报告由独立入口生成：node "<skill-root>/scripts/report/cli.mjs" render --task <taskFile> --mode upgrade|deprecated'
    : `未知命令: ${command}`);
  const args = parseArgs(rest), mode = requireScanMode(args.mode);
  if (args.encoding !== undefined && (args.task || !['inspect','write'].includes(command))) throw new Error('--encoding 仅用于独立 inspect/write；任务使用导入时的确定编码');
  const encoding=args.encoding===undefined?'utf-8':requireString(args,'encoding');
  if (args.details !== undefined && command !== 'validate') throw new Error('--details 仅用于 validate');
  if (args['receipt-output'] !== undefined && !receiptCommands.has(command))
    throw new Error(`--receipt-output 仅用于 ${[...receiptCommands].join('、')}；${command} 的结果直接从标准输出读取，去掉该参数后重试`);
  if (Object.hasOwn(operations, command)) {
    if (mode!=='upgrade') throw new Error('新的评估与交付核对操作仅支持upgrade，旧废弃接口保持');
    const options={taskFile:requireString(args,'task'),projectPath:requireString(args,'project'),mode};
    if (['draft-assessment','check-assessment','import-assessment','draft-resolution','update-resolution'].includes(command)) options.groupId=requireString(args,'group');
    if (['draft-assessment','prepare-spec','draft-resolution'].includes(command)) options.output=requireString(args,'output');
    if (['record-rule-gap-decision','record-rule-gap-review','record-rnoh-review','check-assessment','import-assessment','prepare-spec','record-approval','record-decision','record-verification','update-resolution'].includes(command)) options.input=requireString(args,'input');
    if (command==='import-assessment') { options.reassess=booleanArg(args.reassess); options.reason=args.reason===undefined?'':requireString(args,'reason'); }
    if (command==='draft-resolution') {
      const supported = ['_', 'task', 'project', 'mode', 'group', 'output', 'approval', 'review', 'row-id'];
      if (args._.length || Object.keys(args).some(key => !supported.includes(key)))
        throw new Error('draft-resolution 参数无效，请核对 --approval、--review 和 --row-id');
      options.approvalId = args.approval === undefined ? undefined : requireString(args,'approval');
      options.review = booleanArg(args.review);
      if (args['row-id'] !== undefined) options.rowIds = [args['row-id']].flat();
    }
    if (command==='verify') { options.adapted=args.adapted===undefined?undefined:requireString(args,'adapted');options.report=args.report===undefined?undefined:requireString(args,'report'); }
    const run = () => operations[command](options);
    return args['receipt-output'] === undefined ? run() : withReceiptOutput(command, requireString(args, 'receipt-output'), run);
  }
  if (args.task || ['prepare', 'validate'].includes(command)) {
    if (args.scan || args.results) throw new Error('--task 模式不能同时提供 --scan/--results');
    const options = { taskFile: requireString(args, 'task'), projectPath: requireString(args, 'project'), mode };
    if (command === 'prepare') return prepareProjectGroups(options);
    if (command === 'validate') {
      const diagnostic = await diagnoseProjectGroups(options, { details: booleanArg(args.details) });
      return args.output === undefined ? diagnostic.result : saveTaskJson(diagnostic, options, requireString(args, 'output'));
    }
    if (command === 'inspect') {
      const { result, state } = await inspectProjectGroups(options, args.group === undefined ? null : requireString(args, 'group'));
      if (args.output === undefined) return result;
      return saveTaskJson({ result, state }, options, requireString(args, 'output'));
    }
    if (command !== 'write') throw new Error('--task 仅用于 prepare/validate/write');
    const { participant } = await taskProject(options), state = await readTaskView(participant, mode, { strict: true });
    return writeProjectCsv(state,{output:args.output===undefined?undefined:requireString(args,'output'),columnPrefix:args['column-prefix'] ?? ''});
  }
  if (args.group !== undefined || args.output !== undefined && command === 'inspect') throw new Error('--group/inspect --output 需要 --task');
  const scan = path.resolve(requireString(args, 'scan'));
  if (command === 'write') return writeResults({ mode, scan, results: path.resolve(requireString(args, 'results')),
    output: path.resolve(requireString(args, 'output')), columnPrefix: args['column-prefix'] ?? '', encoding });
  const scanJson = args['scan-json'] ? await readJson(requireString(args, 'scan-json')) : null;
  const batch = path.basename(scan).match(/^scan-results-([a-f0-9]{12})\.csv$/);
  if (batch && scanJson?.batchId && batch[1] !== scanJson.batchId) throw new Error('CSV 与扫描 JSON 批次不匹配');
  return inspectScan(await readFile(scan), { mode, projectPath: requireString(args, 'project'), scanJson, encoding });
}

if (isMainModule(import.meta.url))
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify({ ok: true, result }, null, 2)))
    .catch(error => { console.error(JSON.stringify({ ok: false, error: { code: error.code, message: error.message, ...(error.details ? {details:error.details} : {}) } }, null, 2)); process.exitCode = 1; });

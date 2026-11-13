#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs, requireString } from '../shared/format/args.mjs';
import { isMainModule } from '../shared/platform/entrypoint.mjs';
import { renderReport } from './render.mjs';
import { prepareReport } from './prepare.mjs';
import { startReportPreview } from './preview.mjs';
import path from 'node:path';
import { sha256 } from '../shared/io/fs-utils.mjs';

const usage = 'render --task <taskFile> --mode upgrade|deprecated [--output <HTML>]\npreview --task <taskFile> --html <实际交付HTML>\n同一次任务读取共同生成 CSV 与 HTML，无需报告 JSON。\n兼容旧调用：prepare --task <taskFile> --mode upgrade|deprecated --output <旧报告JSON>；render 可继续传 --data，但不得覆盖当前权威数据。';
export async function main(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) return { usage };
  if (!['render', 'prepare', 'preview'].includes(argv[0])) throw new Error('未知报告命令');
  const args = parseArgs(argv.slice(1));
  if (argv[0] === 'preview') {
    const { url, expiresInSeconds } = await startReportPreview({ taskFile: requireString(args, 'task'), html: requireString(args, 'html') });
    return { url, expiresInSeconds };
  }
  if (argv[0] === 'prepare') return prepareReport({ taskFile: requireString(args, 'task'), mode: requireString(args, 'mode'), output: requireString(args, 'output') });
  const file=args.data===undefined?null:path.resolve(requireString(args,'data')), bytes=file?await readFile(file):null;
  return renderReport({ taskFile: requireString(args, 'task'), mode: requireString(args, 'mode'),
    data: bytes?JSON.parse(bytes.toString('utf8').replace(/^\ufeff/, '')):null, dataSnapshot:bytes?{file,hash:sha256(bytes)}:null,
    output: args.output === undefined ? null : requireString(args, 'output') });
}
if (isMainModule(import.meta.url)) main(process.argv.slice(2)).then(result => console.log(JSON.stringify({ ok: true, result }, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });

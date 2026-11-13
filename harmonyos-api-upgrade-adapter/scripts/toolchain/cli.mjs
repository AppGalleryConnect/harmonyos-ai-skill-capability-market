#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs, requireString } from '../shared/format/args.mjs';
import { isMainModule } from '../shared/platform/entrypoint.mjs';
import { runBuild } from './build.mjs';

const usage = 'build --project <工程> --environment <inspect-environment输出JSON> --evidence-dir <目录> -- <Hvigor独立参数>\n先安装依赖，成功后才构建；完整日志和真实退出码写入独立取证目录。成功仅代表进程完成，仍须核对当前产物。RNOH 工程的回执另含 rnBundle：status 不是 FRESH 时，业务 JS 修改未被本次构建验证。';
export async function main(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) return { usage };
  if (argv[0] !== 'build') throw new Error('未知构建取证命令');
  const separator = argv.indexOf('--');
  if (separator < 0) throw new Error('需要 -- 分隔 Hvigor 参数');
  const args = parseArgs(argv.slice(1, separator));
  const environment = JSON.parse((await readFile(requireString(args, 'environment'), 'utf8')).replace(/^\ufeff/, ''));
  return runBuild({ project: requireString(args, 'project'), environment,
    evidenceDirectory: requireString(args, 'evidence-dir'), args: argv.slice(separator + 1) });
}
if (isMainModule(import.meta.url)) main(process.argv.slice(2)).then(result => {
  console.log(JSON.stringify({ ok: !result.status || result.status === 'BUILD_SUCCEEDED', result }, null, 2));
  if (result.status && result.status !== 'BUILD_SUCCEEDED') process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });

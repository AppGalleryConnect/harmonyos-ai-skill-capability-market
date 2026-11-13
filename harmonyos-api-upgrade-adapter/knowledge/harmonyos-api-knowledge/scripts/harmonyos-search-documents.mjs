#!/usr/bin/env node
/**
 * HarmonyOS 开发者知识服务 · searchDocuments(API 变更适配场景 harmonyos-api-adapter)
 *
 * 功能: 在 harmonyos-api-adapter 场景下检索 HarmonyOS API 变更知识(行为变更、UX 变更、接口废弃),返回文本片段和文档标识符。
 * 参数: query(必填) / sceneName(可选,不传则用默认值)
 *
 * 用法:
 *   node harmonyos-search-documents.mjs "<查询关键词>"
 *   node harmonyos-search-documents.mjs "<查询关键词>" --scene-name harmonyos-sdk
 *   node harmonyos-search-documents.mjs -q "<查询关键词>" --json
 *   node harmonyos-search-documents.mjs "<查询关键词>" --timeout 60
 *
 * 选项:
 *   -q, --query <text>        检索关键词(也可直接作为位置参数传入)
 *   -s, --scene-name <name>   知识场景名;不传时用顶部 DEFAULT_SCENE_NAME,
 *                             可用环境变量 HARMONYOS_KNOWLEDGE_SERVICE_SCENE 覆盖
 *                             (如 harmonyos-sdk / harmonyos-atomic / harmonyos-developer-docs)
 *       --json                输出原始 JSON,便于管道或程序处理
 *       --base-url <url>      MCP 端点,默认取环境变量 HARMONYOS_KNOWLEDGE_SERVICE_BASE_URL,再回退内置地址
 *       --timeout <seconds>   请求超时秒数(默认 30)
 *   -v, --verbose             在 stderr 打印请求细节
 *   -h, --help                显示帮助
 *
 * 说明:
 *   单文件零依赖,只用 Node 内置 fetch(需 Node >= 18),
 *   可直接复制到任意位置使用。检索结果输出到 stdout,提示与错误输出到 stderr,方便管道捕获。
 *   退出码: 0 成功 / 1 请求失败 / 2 参数错误
 *
 * 灰度:
 *   把下方 GRAY_ENABLED 改成 true,请求就会带上 x-gray-flag: 1 接入灰度知识库;
 *   也可用环境变量临时覆盖、无需改文件:HARMONYOS_KNOWLEDGE_SERVICE_GRAY=1
 *
 * 默认场景名:
 *   把下方 DEFAULT_SCENE_NAME 改成想要的场景名,调用方不传 --scene-name 时自动使用;
 *   也可用环境变量覆盖、无需改文件:HARMONYOS_KNOWLEDGE_SERVICE_SCENE=<场景名>
 *   优先级:显式传参 > 环境变量 > DEFAULT_SCENE_NAME(留空则不加 sceneName 头)
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL =
  "https://connect-api.cloud.huawei.com/api/developerknowledge/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;
const TOOL_NAME = "searchDocuments";

// ---------------------------------------------------------------------------
// 灰度开关 —— 只改这一个值即可
// ---------------------------------------------------------------------------

/** 改成 true:每次请求都附加 x-gray-flag: 1,接入灰度知识库 */
const GRAY_ENABLED = false;

/** 环境变量临时覆盖,不用改文件:设为 1/true/on 开启,0/false/off 关闭;不设置则用上面的常量 */
const GRAY_ENV = "HARMONYOS_KNOWLEDGE_SERVICE_GRAY";

function isGrayEnabled() {
  const raw = process.env[GRAY_ENV];
  if (raw === undefined || raw.trim() === "") return GRAY_ENABLED;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

function grayHeaders() {
  return isGrayEnabled() ? { "x-gray-flag": "1" } : {};
}

// ---------------------------------------------------------------------------
// 默认场景名 —— 只改这一个值即可
// ---------------------------------------------------------------------------

/** 调用方没传 --scene-name 时使用;留空字符串则不加 sceneName 头(检索官方文档) */
const DEFAULT_SCENE_NAME = "harmonyos-api-adapter";

/** 环境变量覆盖,不用改文件;显式传 --scene-name 时以传参为准 */
const SCENE_ENV = "HARMONYOS_KNOWLEDGE_SERVICE_SCENE";

/** 优先级:显式传参 > 环境变量 > 上面的常量 */
function resolveSceneName(cliValue) {
  const fromCli = cliValue?.trim();
  if (fromCli) return fromCli;
  const fromEnv = process.env[SCENE_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_SCENE_NAME.trim() || undefined;
}

// ---------------------------------------------------------------------------
// 自身路径(帮助与提示里的命令按脚本实际位置推导,复制到任意目录都正确)
// ---------------------------------------------------------------------------

const SELF_NAME = "harmonyos-search-documents.mjs";
const SIBLING_NAME = "harmonyos-get-documents.mjs";
const SELF_PATH = fileURLToPath(import.meta.url);

/** 路径尽量短且可直接粘贴:能相对 cwd 表示就用相对路径,否则用绝对路径 */
function displayPath(absPath) {
  const rel = relative(process.cwd(), absPath);
  const shown = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absPath;
  const portable = shown.replace(/\\/g, "/");
  return portable.includes(" ") ? `"${portable}"` : portable;
}

/** 脚本路径;文件不存在(比如只手抄了单个脚本)时退回裸文件名 */
function scriptPath(absPath, fallbackName) {
  return existsSync(absPath) ? displayPath(absPath) : fallbackName;
}

const SELF_CMD = scriptPath(SELF_PATH, SELF_NAME);
const GET_DOCS_CMD = scriptPath(join(dirname(SELF_PATH), SIBLING_NAME), SIBLING_NAME);

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function need(argv, i, flag) {
  const value = argv[i];
  if (value === undefined || value === "") {
    throw new UsageError(`${flag} 需要一个参数值`);
  }
  return value;
}

function parseArgs(argv) {
  const opts = {
    query: undefined,
    sceneName: undefined,
    baseUrl: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    verbose: false,
    help: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "-v" || arg === "--verbose") {
      opts.verbose = true;
    } else if (arg === "-q" || arg === "--query") {
      opts.query = need(argv, ++i, arg);
    } else if (arg === "-s" || arg === "--scene-name" || arg === "--sceneName") {
      opts.sceneName = need(argv, ++i, arg);
    } else if (arg === "--base-url" || arg === "--baseUrl") {
      opts.baseUrl = need(argv, ++i, arg);
    } else if (arg === "--timeout") {
      const seconds = Number(need(argv, ++i, arg));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new UsageError("--timeout 需要一个正数(秒)");
      }
      opts.timeoutMs = seconds * 1000;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`未知选项: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  // 位置参数整体作为 query;显式 --query 优先
  opts.query = (opts.query ?? positional.join(" ")).trim() || undefined;
  if (opts.sceneName !== undefined) opts.sceneName = opts.sceneName.trim() || undefined;
  return opts;
}

function help() {
  return `HarmonyOS 开发者知识服务 · searchDocuments(sceneName: ${DEFAULT_SCENE_NAME || "未设置"})

用法:
  node ${SELF_CMD} <query> [选项]

示例:
  node ${SELF_CMD} "<查询关键词>"
  node ${SELF_CMD} "<查询关键词>" --scene-name harmonyos-sdk
  node ${SELF_CMD} -q "<查询关键词>" --json

选项:
  -q, --query <text>        检索关键词(也可直接作为位置参数传入)
  -s, --scene-name <name>   知识场景名;不传时用默认值
                            ${DEFAULT_SCENE_NAME || "(未设置,不加 sceneName 头)"}
                            (环境变量 ${SCENE_ENV} 可覆盖)
      --json                输出原始 JSON
      --base-url <url>      MCP 端点(默认环境变量 HARMONYOS_KNOWLEDGE_SERVICE_BASE_URL 或内置地址)
      --timeout <seconds>   请求超时秒数(默认 30)
  -v, --verbose             在 stderr 打印请求细节
  -h, --help                显示本帮助

提示:
  identifier 可直接交给 getDocumentsById 读取全文,例如:
    node ${GET_DOCS_CMD} <identifier> [identifier...]
`;
}

// ---------------------------------------------------------------------------
// MCP 调用
// ---------------------------------------------------------------------------

/** 端点可能返回 SSE 帧而非裸 JSON */
function unwrapSse(raw) {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("data:") && !trimmed.startsWith("event:")) return raw;
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("");
}

async function callMcpTool({ baseUrl, name, args, headers = {}, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      // 端点只接受 application/json 时会返回 406,必须同时声明 event-stream
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...grayHeaders(),
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `${name} 请求失败: ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }

    const payload = JSON.parse(unwrapSse(await res.text()));
    if (payload.error) {
      throw new Error(`${name} 错误 [${payload.error.code}]: ${payload.error.message}`);
    }

    const text = payload.result?.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new Error(`${name} 返回内容为空`);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${name} 返回内容格式异常`);
    }

    const failed =
      payload.result?.isError ||
      (data.code !== undefined && data.code !== 0 && String(data.code) !== "0");
    if (failed) {
      throw new Error(`${name} 调用失败 [${data.code ?? "unknown"}]: ${data.message ?? ""}`);
    }

    return data;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`${name} 请求超时(${timeoutMs / 1000}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 把命中结果格式化为文本 */
function formatHits(query, hits) {
  if (hits.length === 0) return `No documents found for "${query}".`;
  const listing = hits
    .map((hit, i) => {
      const lines = [`${i + 1}. identifier: ${hit.parent ?? "(unknown document)"}`];
      if (hit.content?.trim()) lines.push("summary: " + hit.content.trim());
      return lines.join("\n");
    })
    .join("\n\n");
  return `${listing}\n\nUse getDocumentsById with the document identifiers above to read the full documents.`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(help());
    return 0;
  }
  if (!opts.query) {
    process.stderr.write("错误: query 不能为空\n\n" + help());
    return 2;
  }

  const baseUrl =
    opts.baseUrl ??
    process.env.HARMONYOS_KNOWLEDGE_SERVICE_BASE_URL ??
    DEFAULT_BASE_URL;

  // 场景名:显式传参 > 环境变量 > 脚本默认
  const sceneName = resolveSceneName(opts.sceneName);

  if (opts.verbose) {
    process.stderr.write(
      `[searchDocuments] ${baseUrl}\n` +
        `[searchDocuments] query: ${opts.query}\n` +
        `[searchDocuments] 灰度: ${isGrayEnabled() ? "on" : "off"}\n` +
        `[searchDocuments] sceneName: ${sceneName ?? "(未设置)"}\n`,
    );
  }

  const headers = {};
  if (sceneName) headers.sceneName = sceneName;

  const data = await callMcpTool({
    baseUrl,
    name: TOOL_NAME,
    args: { SearchDocumentsReq: { query: opts.query } },
    headers,
    timeoutMs: opts.timeoutMs,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }

  const hits = data.resultList ?? [];
  process.stdout.write(formatHits(opts.query, hits) + "\n");

  if (hits.length > 0) {
    // 只给占位示例,不回显具体 identifier;路径按脚本实际位置推导
    process.stderr.write(
      `\n提示: 读取全文用 getDocumentsById 脚本,例如:\n` +
        `  node ${GET_DOCS_CMD} <identifier> [identifier...]\n`,
    );
  }
  return 0;
}

// 只设置 exitCode 而不调用 process.exit(),避免 Windows 上管道 stdout 未刷新导致的异常退出码
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof UsageError) {
      process.stderr.write(`错误: ${err.message}\n\n` + help());
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });

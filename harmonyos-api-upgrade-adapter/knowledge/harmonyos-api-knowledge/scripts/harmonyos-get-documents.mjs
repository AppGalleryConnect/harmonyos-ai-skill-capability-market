#!/usr/bin/env node
/**
 * HarmonyOS 开发者知识服务 · getDocumentsById
 *
 * 功能: 按文档标识符获取 HarmonyOS 开发者知识服务的文档全文。
 * 参数: names(文档标识符数组,单次最多 10 个)
 *
 * 用法:
 *   node harmonyos-get-documents.mjs <identifier>
 *   node harmonyos-get-documents.mjs <identifier> <identifier>
 *   node harmonyos-get-documents.mjs --names <identifier>,<identifier>
 *   node harmonyos-search-documents.mjs "<查询关键词>" | node harmonyos-get-documents.mjs --stdin
 *
 * 选项:
 *   <id...>                   位置参数,一个或多个文档标识符
 *       --names <a,b,c>       逗号分隔的文档标识符(可重复出现,与位置参数累加)
 *       --stdin               从 stdin 读取标识符(每行一个,或 "identifier: xxx" 形式)
 *       --json                输出原始 JSON,便于管道或程序处理
 *       --base-url <url>      MCP 端点,默认取环境变量 HARMONYOS_KNOWLEDGE_SERVICE_BASE_URL,再回退内置地址
 *       --timeout <seconds>   请求超时秒数(默认 30)
 *   -v, --verbose             在 stderr 打印请求细节
 *   -h, --help                显示帮助
 *
 * 说明:
 *   单文件零依赖,只用 Node 内置 fetch(需 Node >= 18),
 *   可直接复制到任意位置使用。文档正文输出到 stdout,提示与错误输出到 stderr,方便管道捕获。
 *   退出码: 0 成功 / 1 请求失败 / 2 参数错误
 *
 * 灰度:
 *   把下方 GRAY_ENABLED 改成 true,请求就会带上 x-gray-flag: 1 接入灰度知识库;
 *   也可用环境变量临时覆盖、无需改文件:HARMONYOS_KNOWLEDGE_SERVICE_GRAY=1
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL =
  "https://connect-api.cloud.huawei.com/api/developerknowledge/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;
const TOOL_NAME = "getDocumentsById";
const MAX_DOCUMENTS = 10;

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
// 自身路径(帮助与提示里的命令按脚本实际位置推导,复制到任意目录都正确)
// ---------------------------------------------------------------------------

const SELF_NAME = "harmonyos-get-documents.mjs";
const SIBLING_NAME = "harmonyos-search-documents.mjs";
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
const SEARCH_CMD = scriptPath(join(dirname(SELF_PATH), SIBLING_NAME), SIBLING_NAME);

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
    names: [],
    fromStdin: false,
    baseUrl: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "-v" || arg === "--verbose") {
      opts.verbose = true;
    } else if (arg === "--stdin") {
      opts.fromStdin = true;
    } else if (arg === "-n" || arg === "--names" || arg === "--name") {
      opts.names.push(...need(argv, ++i, arg).split(","));
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
      opts.names.push(arg);
    }
  }

  opts.names = opts.names.map((n) => n.trim()).filter(Boolean);
  return opts;
}

function help() {
  return `HarmonyOS 开发者知识服务 · getDocumentsById

用法:
  node ${SELF_CMD} <id...> [选项]

示例:
  node ${SELF_CMD} <identifier>
  node ${SELF_CMD} <identifier> <identifier>
  node ${SELF_CMD} --names <identifier>,<identifier>
  node ${SEARCH_CMD} "<查询关键词>" | node ${SELF_CMD} --stdin

选项:
  <id...>                   位置参数,一个或多个文档标识符
      --names <a,b,c>       逗号分隔的文档标识符(可重复,与位置参数累加)
      --stdin               从 stdin 读取标识符(每行一个,或 "identifier: xxx" 形式)
      --json                输出原始 JSON
      --base-url <url>      MCP 端点(默认环境变量 HARMONYOS_KNOWLEDGE_SERVICE_BASE_URL 或内置地址)
      --timeout <seconds>   请求超时秒数(默认 30)
  -v, --verbose             在 stderr 打印请求细节
  -h, --help                显示本帮助

说明:
  单次最多传入 ${MAX_DOCUMENTS} 个标识符。
  标识符取自 searchDocuments 返回结果的 identifier 字段,形如 <分段>/<分段>/<文档名>。
`;
}

/** 从 stdin 提取标识符:支持每行一个,或 "identifier: xxx" / "1. identifier: xxx" 形式 */
function extractIdentifiers(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/identifier:\s*(\S+)/);
      return match ? match[1] : line.trim();
    })
    .filter((line) => line && !line.includes(" "));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
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

/** 把文档结果格式化为文本 */
function formatDocuments(names, docs) {
  if (docs.length === 0) return `No documents found for: ${names.join(", ")}`;
  return docs
    .map((doc, i) => {
      const head = [
        `${i + 1}. ${doc.name ?? ""}`,
        `- title: ${doc.title ?? ""}`,
        doc.uri?.trim() ? `- url: ${doc.uri.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const content = doc.content?.trim();
      return content ? `${head}\n\n${content}` : head;
    })
    .join("\n\n---\n\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(help());
    return 0;
  }

  if (opts.fromStdin) {
    const found = extractIdentifiers(await readStdin());
    if (found.length === 0) {
      process.stderr.write("错误: --stdin 未读取到任何文档标识符\n");
      return 2;
    }
    opts.names.push(...found);
  }

  // 去重但保留顺序
  opts.names = [...new Set(opts.names)];

  if (opts.names.length === 0) {
    process.stderr.write("错误: 至少需要一个文档标识符(names)\n\n" + help());
    return 2;
  }
  if (opts.names.length > MAX_DOCUMENTS) {
    process.stderr.write(
      `错误: 单次最多 ${MAX_DOCUMENTS} 个文档标识符,当前 ${opts.names.length} 个\n`,
    );
    return 2;
  }

  const baseUrl =
    opts.baseUrl ??
    process.env.HARMONYOS_KNOWLEDGE_SERVICE_BASE_URL ??
    DEFAULT_BASE_URL;

  if (opts.verbose) {
    process.stderr.write(
      `[getDocumentsById] ${baseUrl}\n` +
        `[getDocumentsById] 灰度: ${isGrayEnabled() ? "on" : "off"}\n` +
        `[getDocumentsById] names (${opts.names.length}):\n` +
        opts.names.map((n) => `  - ${n}`).join("\n") +
        "\n",
    );
  }

  const data = await callMcpTool({
    baseUrl,
    name: TOOL_NAME,
    args: { GetDocumentsByIdRequest: { names: opts.names } },
    timeoutMs: opts.timeoutMs,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(formatDocuments(opts.names, data.resultList ?? []) + "\n");
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

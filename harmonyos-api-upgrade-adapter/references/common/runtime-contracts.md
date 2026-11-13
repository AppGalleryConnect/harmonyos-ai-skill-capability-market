# 功能验收产物与工具契约

行为测试产物位于实际执行工程的 outputLayout.evidenceDirectory/runtime。完整命令入口：`node "<skill-root>/scripts/runtime/cli.mjs" help`。所有路径使用真实本机路径，命令参数分开传递，不手拼shell命令。各JSON版本为schemaVersion=1。

## 运行环境

设备执行使用独立 Python 环境，安装内置 scripts/runtime/requirements.txt。已验收的完整依赖版本保存在 requirements-lock.txt。Python 基础 fake-driver 测试不依赖 Hypium。测试和报告使用本地环境的 RUNTIME_PYTHON，未指定时 Windows 用 python，其他平台用 python3。报告校验 JPEG 需要所选解释器已安装 Pillow。设备运行使用命令行明确指定的独立环境 Python。

设备调用采用Hypium 6.1.0.210 Driver模式；环境预检验证精确版本及Pillow。截图接口实际使用JPEG，并校验完整格式；图片存在不证明有效。已有HDC只承担设备身份、安装和包信息核对，不作为业务动作备用引擎。

## 来源、白盒和规格

先运行`sources <来源配置JSON> <runtime目录>`，配置示例：

```json
{"sources":[{"sourceId":"app","scanCsv":"实际原扫描CSV路径","selection":"all"}]}
```

selection也可为已确认的完整rowId数组；分类选择先依据逐行分类展开，不因NO_CHANGE省略。sources.json由工具生成，保留原始CSV字节base64、SHA-256、各逻辑行和准确选择，不手改。

来源配置可增加 `encoding:"utf-8"` 或 `encoding:"gb18030"`，使用导入回执或任务 inspect 的确定编码，不传 auto。GBK 历史输入按 gb18030 解析，原字节与 rowId 不变；该编码随来源冻结并用于重建、独立 CSV 及截图投影。旧配置和旧 sources.json 未提供 encoding 时仍按 UTF-8，旧对象不自动补字段。关联工程任务时还核对编码和全部逻辑行内容，原字节哈希相同不能替代解码解释一致。

模型按白盒分析依次生成以下文件：

```json
{
  "schemaVersion":1,
  "routes":[{
    "id":"home",
    "rowRefs":[{"sourceId":"app","rowId":"原字节sha256:1"}],
    "sourceEvidence":[{"path":"entry/src/main/ets/pages/Index.ets","startLine":10,"endLine":15,"text":"实际读取的源码片段"}],
    "steps":[{"action":"launch","target":"真实Ability"},{"action":"tap","locator":{"text":"真实入口"}}]
  }]
}
```

此为route-map.json。不可执行时steps为空并填写blockedReason。源代码应在修改前读取；记录完整必要函数/组件和直接调用关系，不用事后猜测补造。

test-spec.json：

```json
{"schemaVersion":1,"points":[{"id":"confirm","rowRefs":[{"sourceId":"app","rowId":"原字节sha256:1"}],"routeId":"home","trigger":"实际触发条件","observable":"具体结果出口","expectationSource":"官方章节与获批spec的具体位置"}],"gaps":[]}
```

gaps每项为`{pointId?,rowRefs,reason}`；分支缺口必须写pointId。每个选中行至少有测试点或明确缺口，每个测试点的每个行关联都要有用例断言或该点缺口。

已有业务分类从U05原评估复制到spec.classifications数组，每项为`{category,rowRefs}`，按原始行保存且不重复。分类使用无需适配/可选适配/必须适配/待分类/范围外。报告不从处理结论猜分类；旧输入未提供时明确显示未提供分类，不改变测试选择或分母。

test-cases.json：

```json
{"schemaVersion":1,"cases":[{
  "id":"C1","routeId":"home",
  "preconditions":{"startAnchor":{"text":"固定唯一首页锚点"},"state":{"input":""},"data":"测试数据与实际读取方法","reset":"本例复位动作及可观察结果"},
  "steps":["实际导航","建立数据并触发该分支"],
  "assertions":[{"id":"A1","pointId":"confirm","rowRefs":[{"sourceId":"app","rowId":"原字节sha256:1"}],"kind":"functional","beforeExpected":"1234","afterExpected":"1234"}],
  "capturePoints":[{"id":"result","assertionIds":["A1"]}]
}]}
```

kind 为 functional 或 visual，视觉必须有采集点。预期可以是 JSON 值。获批差异使用 allowedDifferences。phaseLocators/phaseActions 按名称保存 `{before,after,source}`，操作清单通过 locator/action 读取。标识使用 ASCII 字母数字、下划线、短横线，不得包含路径。可选的 timeoutMs 为 1 到 600000 的整数，默认 120000，用于限制整个用例进程。

执行 `assemble <runtime目录>` 生成 plan.json，再用 `scripts <runtime目录>` 生成 `scripts/<caseId>.json` 骨架。按[测试设计](runtime-case-generation.md#json-操作清单)填写四段操作，复核计划后 freeze，保存用例与操作清单的完整快照。运行后改动原计划不会改写历史证据。

## 阶段包

在U06修改前执行`archive <packages目录> before <真实构建凭据JSON>`；after在U07完成最终构建后归档。凭据必须来自真实工具操作：

```json
{
  "phase":"before","original":true,
  "product":"default","module":"entry","package":"实际bundleName","ability":"实际Ability",
  "target":"实际原target","compatible":"实际compatible",
  "sourceDescription":"原始源码/配置及HAR消费依据",
  "inputs":["实际源码文件","实际构建配置","实际消费的HAR文件"],
  "artifacts":[{"path":"实际本次HAP路径","signed":false}],
  "build":{"command":"真实完整构建命令","cwd":"真实工程根","log":"实际日志文件","exitCode":0}
}
```

工具保存输入哈希、构建日志和包副本，阶段目录只写一次；从包内module.json读取原始target/compatible/版本/模块/Ability，安装后与设备返回的原值核对，不按字符串猜打包编码。它不证明构建日志由谁执行、original声明是否真实；模型必须按U06实际时序归档，不能将after仅回退target声明为original。HAR文件不是可安装宿主。

## 冻结、执行与交付

执行配置：

```json
{"mode":"COMPARE","packagesDirectory":"实际packages目录","device":{"serial":"明确序列号","api":"实际API字符串","kind":"emulator","instance":"已核实的实例或真机归属"},"python":"独立环境Python绝对路径","hdc":"真实HDC路径"}
```

模式为 COMPARE 或 AFTER_ONLY，设备 kind 为 emulator 或 physical。运行 `freeze <runtime目录> <执行配置JSON>`，使用返回的绝对路径执行 `run <run目录> --python <本地Python> [--hdc <本地HDC>]`。两个可执行命令必须与冻结配置一致，省略 --hdc 时使用 hdc。已安装 worker 在连接设备前校验各例操作清单。缺少阶段包时保留具名 packageIssues 和可生成报告的快照，不启动设备、不补造 before。不得另行安装 after 抢跑。包级失败停止，单例受阻记录并继续独立例。

阶段安装使用[共用安装判据](verification.md#单次设备验证)，完整记录每件附件的 stdout 和 stderr。所有附件取得成功回执并核验阶段主包身份后才运行用例。

每例的前置操作必须实际复位、读取并调用 data_ready，与 state 比较，无法复位即受阻。进程记录功能断言、采集点、时间、清单和证据哈希。截图和布局树顺序采集，瞬态场景必须核对文件的实际内容。阶段结束与切包之间有顺序记录。

run 保存 inputs/plan.json、scripts、内置 Python 封装快照、阶段包与日志。before/after 各自保存用例 attempt 目录。新用例或重试使用新的 run，保留旧 attempt 和原始 before 归档。历史 Python 用例可用于生成报告，重新实测需填写 JSON 操作清单并重新冻结。报告和 CSV 取证使用当前安装的解码器，不执行归档中的代码。

先执行`report <run目录> <upgrade交付目录>`，由同一次审计生成audit.json、逐行test-report.html及screenshots-by-source.json；使用[测试 HTML 模板](../../templates/upgrade-test-report.html)的内联样式，直接填充实际正文，不生成 Markdown 或额外样式装配步骤。内部存档和交付 HTML 的证据链接按各自目录生成，未知/缺失资源保留原因。有视觉项时按[视觉判定](runtime-visual-judgment.md)读取图片提交judgments.json后重跑report。已有交付报告不覆盖，另存带runId版本；命令返回实际地址，主 agent 更新进度并在总报告引用该地址。缺少判定保留UNVERIFIED。

`csv <run目录> <sourceId> --task <taskFile> --project <工程> [--output <实际输出CSV>]`重新审计、登记runtime验证引用，直接读取当前分组投影并附加截图，不再传逐行处理JSON。冻结分类只表示当时测试范围，不能覆盖当前评估分类。用户明确不实施的行不安排修复验收。用户编辑过的输出自动另存，返回路径写入progress供后续报告和verify使用；U09再次生成保留同一审计截图，未选或无有效业务图留空。旧四位置参数保留独立输入兼容；任务目录内必须核对当前分组，冲突拒绝。

覆盖、功能、视觉、可比性分别统计。业务失败可属于完整实测，前后共同失败可以可比；必测点/分支有缺口则该行不完整。有效截图只关联其声明断言的行，不能把首页、诊断或相邻分支的图填到其他行。

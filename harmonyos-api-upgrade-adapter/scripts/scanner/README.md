# HarmonyOS API 兼容性扫描器

这是一个面向 macOS 和 Windows 10/11 x64 的确定性命令行工具。行为变更使用 DevEco 内置扫描能力；ArkTS 废弃 API 使用目标 SDK 自带的解析器、ArkUI 语法配置和类型检查器独立检测。它结合变更文档与真实 SDK 声明，输出稳定的 CSV 报告及机器可读的覆盖证据。Windows 在真实 DevEco 金标验收完成前保持实验状态。

本目录是扫描引擎的唯一开发源码，随 `harmonyos-api-upgrade-adapter` 一起维护、测试和发布。它保留独立 CLI 能力，但不再从其他仓库或目录同步代码，也不作为独立外部产品发布。

配套 Adapter 的 `--mode upgrade` 仅扫描 DevEco 插件的四类非废弃变更，保留逐位置与列信息；单独报告官方文档的规则缺失、无变更版本及工程相关性。两个模式均使用实际编译 SDK 声明，允许 compile SDK 高于 target；deprecated 保留既有报告与范围协议。

版本变更查询和 `upgrade` 使用 `references/changelogs/` 中的官方正文和 `changelogs-index.json`。索引登记相对路径、正文哈希和官方总览条目。自定义行为资料通过 `--references` 指定，索引与正文一起放在该目录内。

`deprecated` 的规则检查、扫描和复扫从目标 SDK 与 DevEco 废弃规则包取证。ArkTS 命中保留 SDK 声明和可关联的公开 API 参考页，C/C++ 命中记录规则包来源。废弃命中逐位置进入主 CSV，Title 为纯文本。

## 运行要求

- Node.js 20 或更高版本。
- 不低于目标 SDK 平台版本的 DevEco Studio，并已安装不低于目标的编译 SDK 和 API Change Assistant 组件。目标 API 26 要求 IDE 26.0.0+，目标 API 24／6.1.1(24) 要求 IDE 6.1.1+。
- 原生模块需要构建时，每次真实重建前，扫描器都会调用发现的 `ohpm` 执行 `ohpm install`（即使 `oh_modules` 已存在）（10 分钟超时）；`ohpm` 不可用时以 `OHPM_UNAVAILABLE` 失败。
- 显式 `--to` 时要求编译 SDK ≥ 该目标；省略 `--to` 时使用所选 SDK `sdk-pkg.json` 的版本。SDK26/target20 报告 compileSdk=26、targetSdk=20，声明来源与哈希均属于真实 SDK26；废弃项过滤上限为目标 API20。

`inspect-environment [--sdk <SDK>] [--deveco-home <IDE>] [--project <工程>] [--to <版本>] [--output <环境JSON>]` 为只读环境入口：省略--sdk时读取DEVECO_SDK_HOME，显式路径优先且无效不回退，两者都缺失返回SDK_PATH_REQUIRED。SDK 接受根或 default，IDE 接受 macOS .app/Contents 或 Windows 安装根；一次返回元数据、覆盖状态、工具路径及版本探测结果，sdkRoot/sdkDefaultRoot/sdkPackagePath分别给出SDK根、default目录和元数据文件，后续直接复用，不手动拼层级。Node/Java/ohpm/Hvigor 并行查询，每项10秒超时，返回独立缺失/失败/超时，不扫描源码、不读取规则、不安装依赖。--output自动创建父目录并保存与stdout兼容的完整JSON，空版本保留null；Windows受控探测不分离启动，进程诊断区分退出与管道关闭。显式 IDE 无效时不切换到其他安装；未传 IDE 时使用 DEVECO_HOME 或 SDK 所属安装。

`scan` 和 `inspect-rules` 必须显式传入 `--mode upgrade` 或 `--mode deprecated`；缺失模式、full 或未知模式以 `SCAN_MODE_INVALID` 拒绝，且不读取 SDK、不创建输出目录。有效请求在启动扫描后端前读取所选 IDE 的 `product-info.json`，按三段／四段数字版本的前三段比较最低门槛并保留完整版本。元数据缺失、损坏或版本无法识别时返回 `DEVECO_VERSION_UNRESOLVED`，请修复本地环境或通过 `--deveco-home` 指定有效安装。不能从 SDK 或目录名猜测 IDE 版本，命令行工具包中的 SDK 不替代 IDE 扫描组件。

IDE 过低时，`inspect-environment` 在 `devecoCompatibility.message` 返回升级指引，`scan` 和 `inspect-rules` 通过 `DEVECO_TARGET_NOT_COVERED` 返回同一提示。按提示下载满足最低要求的 DevEco Studio，安装覆盖目标的 SDK 后重新检查环境。[华为官方下载中心](https://developer.huawei.com/consumer/cn/download/)

## 执行扫描

```sh
node ./bin/harmony-api-scan.mjs init-task --task-root /absolute/task/root --mode upgrade --project /absolute/path/to/project
# 用返回的绝对 taskFile 替换占位符
node ./bin/harmony-api-scan.mjs scan \
  --task "<绝对taskFile>" \
  --mode upgrade \
  --project /absolute/path/to/project \
  --sdk /Applications/DevEco-Studio.app/Contents/sdk \
  --from '5.0.0(12)' \
  --to '26.0.0(26) Release' \
  --product default \
  --scan-dir . \
  --native-build auto \
  --batch-size 1000
```

先 init-task --task-root 固定宿主启动根，默认输出到该根的 .api-change-output；自定义 --output-dir 在初始化时解析。scan 必须使用返回的绝对 --task，后续切换 cwd 或 --project 不改变输出位置。一次任务只创建一个时间戳，所有工程和失败重试共享它，各工程的批次 ID 独立。--mode deprecated 仅处理废弃，--mode upgrade 处理行为变更，无默认扫描模式。详见[任务路径契约](../../references/common/task-output.md)。

SDK 与 DevEco Studio 根目录分离时增加 `--deveco-home <path>`。Windows PowerShell 示例：

```powershell
node .\bin\harmony-api-scan.mjs init-task --task-root "D:\Harmony Projects" --output-dir "D:\Harmony Output"
# 用返回的绝对 taskFile 替换占位符
node .\bin\harmony-api-scan.mjs scan `
  --task "<绝对taskFile>" `
  --mode upgrade `
  --project "D:\Harmony Projects\新闻应用" `
  --sdk "D:\Huawei\HarmonyOS-SDK" `
  --deveco-home "C:\Program Files\Huawei\DevEco Studio" `
  --from "5.0.0(12)" `
  --to "26.0.0(26) Release" `
  --product default `
  --scan-dir . `
  --native-build auto `
  --batch-size 1000
```

Windows 的 `.cmd`/`.bat`、超时进程树和含空格或中文的路径由共享平台层处理；不要在调用方另行拼接 shell 命令。
目标版本保留完整通道序号，`Beta`、`Beta1`、`Beta2` 和 `Release` 分别比较和选择规则资源。失败时终端 JSON 和 `diagnostics.json` 会记录 `command`、`stage`、`stack`、`cause` 和诊断产物路径。

扫描入口通过 CLI 契约识别，不依赖 `api-change-scan.js`、`index.js` 等固定文件名。综合后端支持 ArkTS 与 C/C++；仅发现 `index` 后端时支持 ArkTS，C/C++ 会以 `C_CPP_BACKEND_UNAVAILABLE` 失败并保留完整布局诊断。规则同时检查展开的 `resources/apiChange` 和 `project-api-change-assistant` JAR：按平台版本、API Level 和通道去重，同版本优先使用目录文件，目录缺失的版本直接从 JAR 读取。API 26 规则名可包含或省略 `(26)`，integrated 后端的起止版本参数使用选中文件的实际基名，无需在 DevEco 安装目录解压或重命名文件。

新版 DevEco 只要仍提供可识别的扫描后端和精确目标规则，就可继续扫描已有 SDK 区间。目录和 JAR 中尚未识别 API Level 的 `HarmonyOS_X.Y.Z_<通道>.json` 规则，若 `X ≥ 26` 且平台版本按数字比较严格晚于 `--to`，本轮跳过该文件。区间内规则版本无法识别、内容损坏或精确目标规则缺失时，严格扫描仍报错。

行为／UX 变更区间为 `(from, to]`，但 API 12 固定作为已适配基线，其规则不进入扫描后端并在 `coverage.json` 中记录排除原因。官方正文在哈希校验前将 CRLF／CR 统一为 LF。SDK 声明索引与 ArkTS compiler host 使用相同的平台文件身份，兼容 Windows 的分隔符和大小写差异。`index` 后端保留所选模块解析上下文；限定范围时使用 `--scanFilePaths`，按模块分组并按命令行长度分批。当 DevEco 入口请求缺失的 `ApiScan.worker.ts` 时，仅在子进程内将它定向同目录已安装的 `worker.js`。API 定义变更仍按 `(from, to]`；废弃 API 按目标 SDK 全量状态检测。可重复传入 `--scan-module <根配置模块名>` 或 `--scan-dir <目录>`。同类选择取并集，两类同时指定取交集；已注册的工程外模块受支持。模块扫描使用所选模块路径，目录扫描使用所选文件集合，不支持准确范围时返回 `SCAN_SCOPE_UNSUPPORTED`，不扩大到整个工程。目录内未被当前构建引用的源码也会报告；最终报告再次校验实际文件集合；`oh_modules`、`node_modules`、构建目录、`.hvigor`、测试目录及 Hvigor 构建脚本不作为应用扫描源码；依赖声明仅供类型解析。

SDK 声明无法解析、系统模块／接口未解析，或源码、构建配置、已分析依赖、SDK／解析器在发布前发生变化时，严格扫描失败。失败原因保存到 diagnostics／完整扫描 JSON，不得声称 `COMPLETE`。无关非系统模块的缺失导出记录为显式类型证据警告；不会按工程名绕过。C++ 超时仍为非阻断异常，明确标记结果可能不完整并允许后续流程继续。

C/C++ 增强扫描按三档启用，`diagnostics.warnings` 写明当前构建所处的档位：

| 档位 | 条件 | 行为 |
| --- | --- | --- |
| `VERIFIED` | CLI 和所用 JAR 指纹与 `bin/deveco-cpp-compat.cjs` 的实测组合一致（当前收录 26.0.0.821、26.0.1.412） | 启用增强扫描 |
| `ANCHOR_MATCHED` | 构建不在表中，但 `adaptSource` 的每个替换锚点在本地 CLI 源码中恰好出现一次 | 启用增强扫描，`nativePasses[].enhancement` 记为 `ANCHOR_MATCHED`，警告注明该构建未经人工验证 |
| `NATIVE` | 锚点缺失或重复，或后端不是 integrated | 使用 DevEco 原生 C/C++ 扫描 |

增强扫描使用每模块 900 秒的 C/C++ JAR 预算，外层多留 30 秒用于启动和收尾，JAR 单文件上限仍为 60 秒，可用 `--cpp-module-timeout-seconds` 指定 60–1800 的整数。`NATIVE` 档保留原有外层 240 秒和自身内部限制，显式指定预算且需要 C/C++ 扫描时返回 `CPP_MODULE_TIMEOUT_UNSUPPORTED`；原生扫描退回文本匹配时，该模块记为 `FAILED`（`UNVERIFIED_BUILD_FALLBACK`）并丢弃其 C/C++ 行，ArkTS 和其他模块的结果照常发布。诊断记录各模块的实际预算、耗时和覆盖状态，保留已完成的语义结果及 JAR 返回的跳过文件。

三档都以检测时取得的本地文件 SHA256 为准，打补丁前和发布结果前再次比对，文件中途变化即停止。人工核对过新构建后，可把它的指纹追加到 `supportedBuilds`，使其升为 `VERIFIED`。

模块超时和命令行上限分别在已识别的 C++ 入口和 JAR 扫描函数内匹配完整整数。具体数值和 IDE 显示版本可变化，声明及用途须唯一匹配。

IDE 语义扫描要求已核实的 Ninja、可用的引擎及依赖，并通过 JBR 的 Java 入口自检。通过后逐模块调用 `CAPIScanner.run`，Java 输入通过配置文件传递。`nativePasses` 记录实际 JAR 和依赖指纹。仅对范围内的失败文件使用 CLI 文本匹配器，`scanCoverage.textCandidates` 独立保留候选，原始 CSV 仅收录语义结果。

Windows C/C++ 扫描明确遇到系统内存提交错误 1455，且调用环境没有显式 JVM 选项时，scanner 在该模块剩余预算内以 `-Xmx1g -Xms256m` 重试一次。`nativePasses[].memoryRetry` 保留首次错误和重试结果。

默认保持工程根目录扫描，自动剪枝 .opencode、.claude、.agents、.codex 等工具目录并保护注册模块；不按备份后缀、old、copy或日期猜测排除。scan可重复传入 --exclude-dir "<目录>"，相对路径基于工程根，按物理目录排除且不支持glob。排除集合写入范围证据；复扫沿用基线策略，不允许改变排除目录缩小范围。排除涉及模块内部时必须使用后端准确文件范围，不支持则失败，不撤销排除扩大扫描。

行为扫描复用版本变更查询，按冻结的精确(from,to]与原始规则包条目比对，扫描JSON附加officialComparison。规则包中有条目但无affected APIs不等于缺规则。主 CSV 阶段结束后，用户决定是否对确认未覆盖项进行[补充评估](../../references/upgrade/rule-gap-review.md)。

SDK 内部缺失导出会按工程实际使用的声明和公开导出分析影响；证明无关时记为 `UNUSED_SDK_IMPORT_NOT_RESOLVED` 并保留证明，相关缺失仍阻断。不按模块名硬编码豁免。API Level 简写如 `--from 13` 由与 Adapter 共用的版本入口解析。
废弃分析从 SDK 的 ets-loader 配置继承 lib、types、typeRoots 和 noLib，使用 SDK 自带解析器转换，避免意外加载 DOM 声明；配置及继承来源纳入 SDK 快照。缺少明确的标准库选择、配置非法或指定库不可读时返回 SDK_COMPILER_OPTIONS_INVALID，不静默使用 TypeScript 默认库。路径匹配按工程快照建立规范路径索引和物理身份缓存，避免每条命中遍历全部源文件；报告仍保留原登记路径及全部行身份。

原生上下文跟随后端实际选用的 Ninja。已核实的 integrated 后端采用递归首个匹配，记录选中路径、哈希、buildMode、ABI 和未使用候选；多候选但选择策略不明时停止。仅对实际上下文核对 CMake 生成依赖和构建配置，普通源码更新不要求 build.ninja 更新时间；其他变体不作为过期门禁，也不代表其他 ABI 已扫描。自动重建先安装依赖，每模块本轮最多一次；需要重建但无法确认 buildMode 时保留缺口，不猜测。扫描前和发布前复核上下文，变化时拒绝发布可信成功结果。
废弃符号的目录键由同一原始 SDK AST 节点的 SourceFile 和起始位置组成；Windows 上的类型检查器克隆节点不会因另一种路径分隔符而脱离废弃目录。
目录另建平台规范化位置索引，在原始文件名仍为反斜杠时也能与正斜杠索引条目对齐。

输出文件（位于 `<输出根>/<时间戳>/`，`<ts>` 为本次运行时间戳）：

两类扫描通过 outputLayout 返回实际路径。deliveryDirectory 为 <任务目录>/<mode>/<工程键>；原始扫描成功后按原字节发布，结果表仍为 adapted-results-<batchId>.csv。taskReportPath 为 <任务目录>/<mode>/api-adapt-report.html，由主 agent 按全部参与工程汇总。扫描事实 JSON 使用 schemaVersion=4，行为扫描附加工程排除证据 `projectApplicability`。

实际扫描的 `scan-results-<batchId>.scan.json` 记录 `codeSize`。`total` 为总量，`byLanguage` 按 ArkTS/TS（`arktsTs`）和 C/C++（`cpp`）汇总，`byModule` 记录每个模块的总量与语言明细。模块按最深的注册根归属，工程公共源码和 RNOH 业务根分别使用 `moduleName: null` 并以 `sourceRoot` 区分。行为扫描执行 RNOH 业务检索时，`rnohBusinessJs` 统计业务 JS/JSX/TS/TSX，重叠的 TS 文件按 HarmonyOS 模块归属。

`physicalLines` 包含空行和注释行，`codeLines` 统计含代码的物理行。统计以本批次源码清单为基础，额外排除 dist、coverage、tests、__tests__ 和 __mocks__，独立于 API 命中和后端完成状态。代码量只记录在扫描事实 JSON 中。

新行为扫描 CSV 有 8 列，依次为 Api Definition、Language、Changed in SDK、Affected Versions、Title、Code Location、Change Type、Rule ID。

所有 metadata、JSON、验证 CSV、coverage、diagnostics 和失败尝试在 .internal/<mode>/<工程键>/scans/<batchId>/，不创建额外时间戳。--scan-purpose 默认 initial，成功基线存在时拒绝覆盖；deprecated 修改后复扫使用 rescan，只返回内部原表、adaptedCsv=null。历史交付保持原样，导入用 import-csv --task，显式 --evidence 保留旧伴随文件及来源。参与工程可通过 init-task 的重复 --project 或 register-project 预先登记；--project指向含app.products及模块注册的根工程，模块使用--scan-module/--scan-dir限定。登记和扫描开始不预建空交付目录，首次写入CSV、进度或证据时才创建；未开始和失败项在索引及报告中仍保留。

`SDK_STATE` 行由真实接收者及选中的重载决定，不会把现代 UIContext 或业务同名方法当成旧全局 API；完整 JSON 中的 `Source Reference` 可直接指向 SDK 声明。替代方案从同一准确声明的 `@deprecated` 注释块获取，禁止串用其他成员／重载。SDK 废弃状态不会被同名 API 的扩参等兼容性变更抵消。

## 可选编译日志导入

扫描不遍历第三方依赖源码。提供 `--build-log <path> --build-evidence <path>` 时，才允许导入该日志中的 `oh_modules` 告警。配套 JSON 必须包含：

```json
{
  "schemaVersion": 1,
  "projectRoot": "/absolute/build/project",
  "product": "default",
  "status": "PASSED",
  "nonIncremental": true,
  "logHash": "SHA256 of build log",
  "sourceSnapshot": "matching source snapshot",
  "buildProfileHash": "matching build-profile hash",
  "sdkSnapshot": "matching SDK catalog snapshot",
  "targetSdk": "26.0.0(26) Release"
}
```

导入行标记 `BUILD_LOG`、`DEPENDENCY`，禁止自动修改第三方代码。可选 `apiBindings` 用文件、行、列、告警符号和 `symbolId` 关联准确 SDK 声明；未绑定的依赖告警保留为 `COMPILER_ONLY`，需升级依赖／人工确认。没有配套证据的历史日志只用于对比，不导入主 CSV；证据不匹配直接拒绝。

## 行为规则的工程适用性

`upgrade` 根据工程配置确认本次应用及扫描范围采用 Stage 模型后，从本轮 DevEco 后端输入中排除 `CH2026010615012`。遇到 FA 配置、归属不明或独立 HAR 时保留该规则。扫描 JSON 和 coverage 的 `projectApplicability` 记录规则、原因、产品、模块及配置哈希。官方比对继续保留规则包覆盖结论，工程状态为 `EXCLUDED_BY_PROJECT_APPLICABILITY`。Resource 类型扩展（`383`）以及其他插件实际命中继续交由模型结合原文和工程评估。

废弃 API 的 `Replacement API` 提供替代提示，准确的 `Replacement Source` 和目标 SDK `@useinstead` 证据从完整 JSON 读取，供后续 skill 完成代码迁移和验证。

可使用 `inspect-rules` 在不扫描应用工程的情况下校验规则覆盖情况。

跨平台比较前必须核对 `diagnostics.json` 的 `sourceSnapshot`、目标 SDK 版本和 `deprecationCatalog.sdkSnapshot`。废弃 API 依据目标 SDK 声明全量状态检测，因此 Beta 与 Release 快照的行数差异不是平台差异。输入快照一致时，应读取完整 JSON，按 `API Symbol ID + Code Location + Column` 比较并归一化主机绝对路径。

可使用 `node scripts/maintenance/regression/compare-golden.mjs --golden <official.csv> --actual <apiChange.csv> --scan-json <apiChange.scan.json> --project <project>` 比较 DevEco 规则完整覆盖率。精简废弃CSV必须传入扫描JSON，旧的完整CSV仍支持单独比较。传入扫描 JSON 时先核对实际 CSV 全部可见字段和重复计数，再从 JSON 取得完整来源、符号和过滤记录；不匹配直接报错。比较历史产物时，scan JSON 中按文档过滤的金标条目仍计入覆盖。

废弃金标使用 `node scripts/maintenance/regression/compare-deprecated.mjs --project <project> --build-log <log> --scan-json <json> [--build-project-root <original root>] [--build-evidence <json>]`，按准确行／列／符号对齐。编译没有告警不是负例：仅扫描器发现的记录保留声明证据，不自动删除。没有匹配快照的旧日志明确标为未验证。

`node scripts/maintenance/regression/regress-deprecated.mjs --sdk <sdk> --output-dir <new temporary directory> --project <repo> --ref <revision>` 可重复指定工程／版本：建立隔离副本、复制现有依赖与缺失 rawfile 资源、不复制构建缓存，执行环境自检、非增量 assembleApp、两次完整扫描及金标对比。`--use-project-build-profile` 仅在副本中采用当前工程配置，并记录来源／哈希；`--reuse-checkouts` 仅复用 origin 和 HEAD 均匹配的已有副本。不得用历史日志冒充此次全量构建证据。

## 开发与发布约定

每次代码修改完成后，必须同步更新 `CHANGELOG.md` 和 `package.json` 中的语义化版本号，完成相关测试与产物校验，并在对应本地 Git 仓库提交修改。未发布内容先记录在变更日志的“未发布”章节，发布时再移动到带日期的版本章节。

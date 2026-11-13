# 真实验证与工具操作

本页提供环境、检查、构建、产物和设备操作方法，由所选功能主流程确定执行时机、授权与完成判据。工具提供事实，模型组织任务和解释结果；固定构建取证入口仅顺序执行已选定命令并保存真实回执，不负责适配判断或选择任务。每次验证记录完整参数、cwd、所用版本、退出码、日志和对应输入/产物。

## 环境与依赖

### 找到并核对工具

已有用户SDK路径或DEVECO_SDK_HOME时，立即运行内置环境检查。显式--sdk优先，省略时直接读取DEVECO_SDK_HOME；两者均缺失则按SDK_PATH_REQUIRED提示补路径，显式路径无效不回退。不要先用ls/cat猜build.txt、sdk-pkg.json或sdk/hms位置，也不遍历磁盘猜版本。IDE独立安装时使用已知DEVECO_HOME或显式--deveco-home。

```console
node "<skill-root>/scripts/scanner/bin/harmony-api-scan.mjs" inspect-environment --project "<工程>" --output "<环境JSON>"
```

以上调用适用于已设置 `DEVECO_SDK_HOME` 的环境。用户另给路径时传 `--sdk "<实际SDK路径>"`。`--to` 使用已确认的精确扫描终点，仅知道目标 API 等级时可先传等级检查 IDE 门槛，SDK 覆盖按实际扫描终点核对。后续复用返回的 `sdkRoot`、`sdkDefaultRoot`、`sdkPackagePath` 和 `contentsRoot`，分别对应 SDK 根、default 目录、SDK 元数据文件和 IDE 实际根。保存的环境 JSON 绝对路径可传给主 agent 和子 agent。

目标未定时省略 --to，仅以实际编译 SDK 检查工具链覆盖，不因此替用户确定 target。IDE 可传 macOS .app 或 Contents，以及 Windows 安装根；SDK 可传根或 default。命令只读固定元数据/工具候选，并行查询 Node、Java、ohpm、Hvigor 版本，每项最多10秒，返回路径、原始输出、退出码及 AVAILABLE/MISSING/FAILED/TIMED_OUT；不加载规则、不扫描源码、不执行 install。优先复用该结果，同一工具链不重复多轮查找；未传 --project 时使用调用者 cwd，不默认进入 IDE 安装目录。失败或成功但空输出时 version 为 null，异常在 stderr/error 中保存。--output 由工具创建父目录并写入与标准输出相同的完整 JSON，后续构建直接复用，不通过 shell 重定向或反复探测生成。SDK根及default目录按scanner真实help支持输入；API26需实际能覆盖目标的IDE26+，API24需6.1.1+。Node20+，Java17+。编译SDK可以高于配置target，二者分别记录。

`devecoCompatibility.status` 为 `TOO_OLD` 时展示 `message` 中的当前版本、最低要求和下载地址。例如 IDE 6.1.1 无法覆盖目标 API26，请安装 DevEco Studio 26.0.0 或更高版本以及覆盖目标的 SDK，再选定新安装和 SDK 路径重新检查环境。下载入口见[华为官方下载中心](https://developer.huawei.com/consumer/cn/download/)。

常见安装位置仅用于定位候选，执行前必须确认文件实际存在：

| 工具 | macOS DevEco安装内候选 | Windows安装内候选 |
| --- | --- | --- |
| Java | `jbr/Contents/Home/bin/java` | `jbr/bin/java.exe` |
| Hvigor | `tools/hvigor/bin/hvigorw` | `tools/hvigor/bin/hvigorw.bat` |
| ohpm | `tools/ohpm/bin/ohpm` | `tools/ohpm/bin/ohpm.bat` |
| HDC | 实际SDK的toolchains内hdc | 实际SDK的toolchains内hdc.exe |

由 inspect-environment 在工程目录检查 Node、真实Java、ohpm和Hvigor版本；记录DEVECO_SDK_HOME，并将选定Java/ohpm/Node目录放入本次进程PATH、设置对应JAVA_HOME，不永久改用户环境。路径带中文/空格/引号时使用参数数组与node:path，不拼接shell命令；Windows .bat/.cmd可复用保留的platform/process安全封装，不能把JSON.stringify当shell转义。

scanner 的 index 后端不必然支持 scanFilePaths；无法准确限定请求目录时停止并报告范围不受支持，不删除参数扩大扫描。

IDE 内构建与命令行构建分别核对实际 SDK 路径/元数据、编译器及构建工具版本，确认是配套工具链且与任务目标一致。不能因命令名称相同或 IDE 已升级，就推断流水线/终端也切换了 SDK；设置环境后回读实际使用路径与构建日志。此配套要求提炼自 2026-08-28 [官方工具链升级指导](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/upgrade-tool-chain)，不固定沿用其中面向 API20 的旧安装版本。

每次真实构建由内置 build 在对应工程真实根执行一次 ohpm install，即使 oh_modules 已存在也执行；源码、依赖清单或本地 HAR 更新后必须重新安装。版本查询不属于构建。保存完整安装输出与退出码，安装失败立即停止该工程构建；不自动安装或下载新的开发工具/MCP，不改签名、证书或依赖源码。ohpm 参数以实际 help 为准，确认前只用基本 install；只有工具明确支持 keep-lockfile 时才考虑保留锁文件的清理，不擅自丢锁或换依赖。锁文件变化要说明是否由真实安装产生；安装失败不能继续假称构建通过。网络/环境问题归排错，不算源码修复尝试。更多Hvigor选项见[工具手册](../toolchain/hvigor.md)。

## 通用静态复核

按当前主流程核对实际diff、原始行及SDK声明，理解准确接收者、参数、重载、返回/回调、默认值与官方行为触发条件。此节承担代码及语法/类型正确性；行为另按[target升级兼容](../upgrade/upgrade-compatibility.md#记录与验证边界)复核新旧行为语义，不新增通用接口版本可用性匹配任务。

修改ArkTS/ArkUI前按[编码规范](arkts-coding-standards.md)复核必要差异，不开展无关风格整改。检查公开接口、可空来源、异常/Promise、回调次数与同身份on/off、资源释放和生命周期；原生按准确头文件、真实ABI、宏与构建上下文检查。

回读实际product配置，保持原compatible；例如API26配置写26.0.0，精确扫描终点使用26.0.0(26) Release，两者不混写。SDK/IDE可用检查执行后保留真实命令/输出、历史与新增诊断；新增错误为0不等于全工程检查通过，缺工具不写自动通过。真实编译错误依所属流程修复，不把诊断自动扩展成通用接口可用性迁移；必要的跨系统行为处理仍按行为专题复核。

行为任务对本次新增或替换的SDK调用，按[新增调用规则](arkts-coding-standards.md#新增调用的废弃状态)逐项核对准确声明、废弃标记、替代接口及获取链，不引入废弃API。将新增废弃告警与实际diff对应；构建成功或仅无新增错误不能代替核查。原有无关废弃调用和历史告警单独记录，不扩展为全量迁移；缺少满足原compatible的替代或无法确认时保留缺口/待决策，评估时记录在已有 reason/evidence；修复后按 U07 追加 resolution.review 及验证结果，不覆盖原评估。

## 废弃迁移兼容复核

废弃任务另按[兼容指南](compatibility.md)逐准确接收者/重载核对接口与参数since、辅助链、真实版本保护和回退，不用错误码或跨平台标签代替since。同步复核通用静态检查、成对on/off与未保护残留。模型评估、SDK检查、编译与设备结论分开记录，不以消除诊断替代语义安全。

## 完整构建与产物

每轮源码或构建配置修改后必须执行真实完整构建，验证本轮最终输入。构建后相关源码、配置或SDK再次变化时，旧相关通过标为待复核，必须重新构建。缺工具可保留有依据的修改，但进度、结果说明及报告只能标部分完成/待编译；编译失败保留实际原因。MODIFIED、模型检查、提示性扫描、废弃复扫或旧产物不能关闭本轮编译待办。

在所选构建工程目录、明确工具环境下调用内置 build。工具确认本次 ohpm install 成功后启动 Hvigor；before/after、HAP/HAR及原生构建均遵守此顺序。占位符必须替换为已核实的实际路径与product；模块target按根注册和模块build-profile读取，不以模块目录名猜测。

```console
node "<skill-root>/scripts/scanner/bin/harmony-api-scan.mjs" inspect-environment --project "<工程>" --output "<环境JSON>"
node "<skill-root>/scripts/toolchain/cli.mjs" build --project "<工程>" --environment "<环境JSON>" --evidence-dir "<本阶段取证目录>" -- --mode project -p product=<product> assembleApp --analyze=normal --parallel --no-incremental --no-daemon
```

内置工具使用环境 JSON 中的真实 ohpm/Hvigor 路径，先安装，再构建；RNOH 工程构建成功后回执另含 `rnBundle`，说明包内 RN bundle 是否晚于业务 JS，见[RNOH 构建与验证](../upgrade/rnoh-upgrade.md#构建与验证)；安装失败、启动失败、超时均停止后续阶段。-- 后按参数数组传入已核实任务；HAR 改为 --mode module、module=<模块>@<target> 和 assembleHar。每次创建独立 build-* 目录，标准输出的 `result.receiptPath` 指向本次实际 `receipt.json`，安装或构建失败时同样返回。回执保存两阶段真实退出码/异常/超时、命令、cwd 和版本，完整输出运行中持续保存到 install/build 的 stdout/stderr.log；回执分别记录真实启动参数、PID、spawn/exit/close 时间、输出字节数和终止结果。日志写入失败停止构建，安装和构建各自保留 RUNNING/SUCCEEDED/FAILED。不得用 `| tail`、`| grep` 后的 `$?` 代替构建退出码，也不以分号无条件串联安装与构建。工具整体非零退出表示安装或构建失败；BUILD_SUCCEEDED 仅表示这两个进程成功，仍要按下文核对本次产物。

Windows关闭daemon；不要等待长期运行的守护/模拟器启动进程退出。HAP完整项目构建使用assembleApp；库与宿主的组织顺序由实际功能流程及其专题确定。原生需要时使用工程真实compileNative/Ninja上下文，不改变ABI以躲避失败。

构建前记录当前源码diff/必要配置、目标模块和既有产物情况。构建后读取完整输出特别是ANSI错误后的日志尾部，核对真实退出码、任务是否执行及本次实际生成的产物，不能仅看前段成功任务/WARN或目录中存在旧包。

HAP/HAR一般在模块 `build/<product>/outputs/<target>/`，以真实工程输出为准。多入口、多target、多产物必须明确选择，核对AppScope/module身份、大小和SHA-256，保存可回读副本与构建日志。按实际目标选择包：模拟器直接安装明确的未签名HAP；真机使用已有有效签名HAP。不得因模拟器产物未签名而生成证书或自动签名，是否可安装以实际回执为准。相同产物字节可能来自确定性重构建，仍须有本次生成/构建证据；没有产物或仅旧包不能通过。

分别记录编译、产物、签名/安装、库和宿主结果。真实新增编译问题修复后重跑必要步骤，依赖/签名/超时等按[排错](troubleshooting.md)。构建失败保留当前源码，不自动回滚；不得将根本没启动Hvigor写为编译失败或成功。

## 单次设备验证

只在废弃主流程收到用户明确要求时执行；使用本次构建的当前HAP，不要求原包、修改前采集或基线决定。未要求写未执行，不主动启动或安装。

用实际 HDC 核对设备序列号、系统、连接与实例归属。真机使用已有有效签名的当前 HAP。把已核对的构建产物路径和 SHA-256 传给独立安装入口。该入口只需 Node 和 HDC。

```console
node "<skill-root>/scripts/runtime/cli.mjs" install --hdc "<HDC路径>" --serial "<已确认设备>" --hap "<本次HAP>" --sha256 "<已核对哈希>" --evidence-dir "<证据目录>"
```

每次尝试在证据目录中保存独立 `receipt.json`，包含设备系统 API、HAP 哈希、命令、退出状态、双路输出和包身份核验。只有进程正常结束、取得明确安装成功回执、stdout 和 stderr 都无失败标记，且 `bm dump` 的包名、版本、target、compatible、模块与 Ability 均匹配本次 HAP，才允许启动。输出流中有失败标记时优先按失败处理，即使退出码为 0 或另一输出流报成功。手动安装采用同一判据，Windows 本地路径保持原生，设备端路径保持设备格式。

安装成功后在同一设备执行用户要求的真实功能、返回/回调/异常用例，按[通用功能取证](runtime-functional-tests.md#通用功能取证)保存证据。安装受阻时保存回执并交付实际结论。仅当请求覆盖低版本业务时按[废弃设备范围](runtime-functional-tests.md#废弃单次设备验证)记录实际覆盖及未验收项。

先持久保存hilog、布局、截图和原始行关联，再只清理本次启动的模拟器；已有实例/真机保留，清理失败单列，不覆盖业务事实。具体子命令先读真实help，布局/截图保留原格式，HDC远端路径不转成本地路径。

## 行为前后对比

行为主流程 U02 依次展示“仅编译构建，不运行设备测试（推荐）”“修改后设备验证（Beta）”“前后对比验证（Beta）”，说明两个设备选项处于试用阶段。已有明确选择时沿用，按真实答复映射为不运行、仅修改后验证或前后对比；U05 仅在选择设备测试时随 spec 确认分类范围。仅选择对比时在 U06 任何相关源码、target、配置或测试辅助源码修改前，使用原源码/原配置真实构建并归档 before 包；不要求此时就操作设备或执行用例。仅修改后验证不构建 before，不运行则不操作设备，修复后仍完整构建。

归档使用[完整构建与产物](#完整构建与产物)的方法：保存本次真实命令、cwd、工具链、product/模块、日志/退出码、原源码/配置基线、包身份/实际安装条件及 SHA-256，并使用[阶段包契约](runtime-contracts.md#阶段包)保存可核对的日志和输入身份。原包复制到本批次 evidence 中不会被构建覆盖的位置，单 HAP 使用 before.hap，最终修改包使用 after.hap；多模块以 before/after 阶段目录保留实际包集合和身份清单，避免重名覆盖。路径按 node:path 构造。来源不明的旧包、仅目录中存在产物或未证明的签名不能作为有效基线。

HAR 归档原库、宿主实际消费依据和可运行宿主 HAP；HAR 文件本身不能代替宿主。联合任务先归档共同原始基线，再实施会影响它的共享修改。原包构建、签名或归档不足以支持对比时，暂停相关修改并等待补齐条件或用户明确改为仅修改后验证/不运行；不能自行降级。有效原包已归档后，设备暂时不可用只阻塞设备验收，不阻塞获批修复。

U07 对修改后的真实输入完整构建并归档 after，不覆盖 before。U08 可在修复后依据 spec 预期生成用例，先测试归档 before 包，复位约定数据后再测试 after 包；同设备/系统、同语义用例及可复位数据才可比较。先核对两个包都支持测试方式，不能假定原包具有新增测试入口或埋点。包归档、包测试、业务断言和有效对比分别记录。

按[功能取证](runtime-functional-tests.md#行为前后对比)生成 test-report.html；缺包、换系统、零用例、不可复位数据、入口不兼容或模型中断均保留具体缺口。两个阶段表现相同仍要分别满足业务预期。源码/配置变化后重建 after 并重测受影响用例，before 归档保持不变，不回退源码补造。已有授权覆盖多个系统时分别记录，不将异系统运行当作同系统 before/after 对比，不自动增加最低设备或接口可用性验收。

清理与现场保存采用单次设备操作相同方法，测试报告使用[行为测试模板](../../templates/upgrade-test-report.html)。

## Windows 命令超时与同机对照

受控工具在 Windows 不分离启动，仍通过 cmd.exe 执行原厂 .bat/.cmd；macOS 保留进程组清理。超时收尾有界，父进程退出但后代占用管道记为 STDIO_CLOSE_TIMEOUT；退出码0不能覆盖该失败。默认版本查询10秒、安装10分钟、构建30分钟保持不变。零字节日志不能单独证明管道断裂，registry、缓存与 detached 仅按真实对照记录归因。

使用实际后台任务返回的 ID；查询不到时回读本次 receipt.json、完整日志及任务输出，不因延迟通知重复启动构建。失败尝试保留原件，环境修正后仍通过固定构建入口重试，成功使用新回执，不能以手动命令输出覆盖旧 INSTALL_FAILED。

在原 Windows 机器保存环境后执行以下只读工具对照（只在新目录生成离线夹具和诊断，不执行 install）：

```console
node "<skill-root>/scripts/maintenance/regression/windows-tools.mjs" --environment "<环境JSON>" --output "<诊断输出根>"
```

工具分别对离线 .cmd→Node 夹具及同一路径 ohpm -v 比较 detached=false/true，固定 cwd、参数和环境，保留原始事件、两路输出及时间。真实安装/构建随后使用上述固定取证入口；记录缓存是否相同，不自动更换 registry 或清缓存。尚无该机器对照结果时，明确 Windows 实机未验收，不把 macOS 或模拟结果写为已证实根因。

## Windows 临时命令与诊断边界

应用适配中的环境检查、CSV/JSON读取及待处理统计使用内置Node入口，主/子agent复用同一环境JSON与实际分组输入路径，不运行临时Python或内联脚本重建这些事实；这不移除设备runtime及开发测试的真实Python需求。Windows Store的python3别名不可执行时，不为上述读取任务修改别名、全局PATH或安装解释器。

排错仅保存实际失败调用的完整参数、cwd、stdout/stderr及真实退出码。分号后的命令不受前段&&失败阻断；空目录的ls通常返回0；被截断的命令、被隐藏的stderr或整体退出码不能证明具体失败位置。现有记录未提供完整计数表达式，CRLF归因仍未证实；不为此清洗原件或更改Git换行设置。

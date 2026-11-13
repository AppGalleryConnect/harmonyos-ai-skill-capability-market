# RNOH 工程行为适配专题

本页供行为流程处理 React Native for OpenHarmony（RNOH）工程。U01 识别工程并记录框架基线，U03 扫描以 RNOH 框架源码为只读依据、输出受影响的 RN 业务 JS 位置，U04 与原生行一样逐组评估，[U04a](upgrade-workflow.md#u04a-rnoh-无规则条目补充核对)补充核对框架整体影响和无规则条目，U05 纳入 spec，U06/U07 实施并构建，U09 报告单列“RNOH 业务影响分析”章节。非 RNOH 工程不产生任何 RNOH 行、字段或章节。设备行为边界与 target 隔离按[target 升级兼容](upgrade-compatibility.md)处理；RNOH 原生核心以 HAR 形式被宿主消费，宿主 target 判断沿用[HAR 宿主专题](har-upgrade.md#宿主-target-与初始化)。

## 识别与基线

满足下列任一项即按本专题处理，仍以真实文件为准：

| 依据 | 位置 |
| --- | --- |
| 依赖 `@rnoh/react-native-openharmony` | harmony 工程根及模块 oh-package.json5 的 dependencies/overrides，或 `oh_modules/.ohpm/@rnoh+react-native-openharmony@<版本>` |
| 依赖 `@react-native-oh/react-native-harmony` 或旧包名 `@rnoh/react-native-harmony` | JS 工程 package.json |
| EntryAbility 继承 `RNAbility`，页面使用 `RNApp`/`RNSurface` | harmony 工程 ets 源码 |

扫描和构建的工程根是 harmony 工程目录（HAP）。JS 工程通常是它的上级目录，scanner 按下面的顺序查找：

1. harmony 目录的上一级、上两级，package.json 声明了 RNOH JS 包；
2. harmony 目录的同级目录及其下一层，package.json 依赖 react-native。候选不止一个时优先取声明了 RNOH JS 包的，其次取带 `metro.config.js` 或 `app.json` 的；仍不唯一时不猜测。

U01 先确认 JS 工程的实际位置。它不在上述范围内，或同级有多个 RN 工程时，U03 扫描命令加 `--rn-js-root <JS 工程目录>` 指定。同一任务只接受一次初始扫描，所以要在扫描前确认好。扫描后才看到“未找到 RN JS 工程”或“找到多个可能的 RN JS 工程”时，不要带着缺口往下走：新建任务（init-task），加上该参数重新扫描。工程确实没有 JS 源码（只有外部下发的 bundle）时才记为缺口。

U01 在进度中记录：

- JS 工程目录，以及是否需要 `--rn-js-root`。

- react-native 版本、RNOH JS 包名与版本、原生 HAR 实际解析版本；两者必须同版本，不一致时记为缺口，不按任一方推断另一方。
- 原生 HAR 形态：debug 版在 `src/main/cpp`、`src/main/ets` 含源码，release 版只有预编译 .so，无法逐调用核对时记 EVIDENCE_GAP。
- 架构：CAPI（C++ 通过 ArkUI C API 创建节点）或 ArkTS 架构组件（早期版本，基于 LazyForEach）；JS 引擎（`USE_HERMES` 默认开启，关闭时为 JSVM）。
- 窗口：EntryAbility 是否继承 RNAbility、是否重写 `onWindowSetup`。
- 混合架构：是否由 ArkTS 的 Router、Navigation 或 NavDestination 承载多个 RN 页面。
- 三方 RN 鸿蒙库（如 `@react-native-oh-tpl/*`、`@react-native-ohos/*`）及其 HAR 形态。

RNOH npm 包中的 `scripts/resources/build-profile_project.json5` 只说明框架自身的打包配置，不代表宿主 target，也不能证明框架已适配宿主目标版本。

## 扫描边界

本专题的目标是找出升级 targetSdkVersion 后 **RN 业务 JS 中受影响的位置**。RNOH 框架和宿主承载代码不作为评估对象，也不列为 CSV 行。

scanner 的通用源码范围仍排除 `oh_modules` 和 `node_modules`。upgrade 模式识别到 RNOH 后，按内置规则（`scripts/scanner/data/rnoh-impact-rules.json`）分两步检索：

1. **框架依据（只读）。** 读取已安装的 RNOH 原生 HAR 源码、RNOH JS 层和宿主承载代码，确认当前版本确实把该变更传到 RN 页面：命中为“已确认”，release HAR 等无法读取时为“无法核对”，源码可读但未使用为“未使用”。依据只记在扫描 JSON 的 `rnoh.rules[].framework` 和行的 `rnohFramework`，供评估引用。
2. **业务位置（CSV 行）。** 框架依据为“已确认”或“无法核对”时，在 harmony 平级的 JS 工程中检索对应 RN 组件与属性写法，每处写入 CSV；“未使用”时不输出。

| 字段 | RNOH 行取值 |
| --- | --- |
| Rule ID | `RNOH-<规则名>`，与原生规则区分 |
| Api Definition | 触发该变更的 RN 组件或属性写法 |
| Source Reference / Title | 绑定的官方 changelog 章节与标题；只绑定冻结区间内的条目 |
| Code Location | RN 业务 JS 位置，以 `../` 开头，由扫描 JSON 的 `rnoh.jsRoot` 解析 |

没有业务触发写法的规则（如 JIT 默认关闭、页面退出删除前移、UI Input NDK 行为）属于框架整体影响，状态为 `FRAMEWORK_ONLY`，只进入报告的“框架整体影响”列表和 U04a。有业务触发写法但没找到 JS 工程时，规则状态为 `BUSINESS_NOT_SCANNED`（业务 JS 未检索），它不等于没有命中；这些规则同样进入 U04a，逐条给出结论。检索跳过注释、`node_modules`、harmony/android/ios 目录、测试目录（`__tests__`、`__mocks__`、`__snapshots__`、`__fixtures__`、`test`、`tests`、`e2e`）以及 `*.test.*`、`*.spec.*`、`*.stories.*` 文件，这些不进入发布的 bundle。U03 读取 `rnoh` 摘要，把 release HAR、未安装依赖、JS 包与 HAR 版本不一致等缺口写入 scanEvidence.gaps；HAR 或指定模块/目录扫描时状态为 `SKIPPED_RESTRICTED_SCOPE`。零命中不代表不受影响，三方 RN 鸿蒙库仍在 U04a 核对。

## 代码层与适用变更

| 层 | 位置 | 运行与渲染 | 判断要点 |
| --- | --- | --- | --- |
| RN 业务 JS | JS 工程 src、index.js | Hermes 执行；RNOH 编译 Hermes 时关闭 Intl | 方舟运行时变更（async 函数类型判定、lastIndexOf、lazy import、幂运算等）和 Intl 格式化变更不影响；业务 JS 不能直接调用 ArkTS API，只能经 RN 组件属性间接触发原生行为 |
| RNOH JS 层 | `node_modules/<RNOH 包>/Libraries/**/*.harmony.*` | Hermes | 视图配置白名单 validAttributes、组件首次挂载时的默认调用 |
| RNOH 原生框架 | `oh_modules/.ohpm/@rnoh+react-native-openharmony@<版本>/oh_modules/@rnoh/react-native-openharmony/src/main` | C++ 经 ArkUI C API 设置节点属性，布局由 Yoga 计算；ArkTS 部分运行于方舟运行时 | 受节点属性默认值、窗口与系统栏、Dialog、文本排版、ArkTS 生命周期等变更影响；源码未实际使用时，ArkUI Row/Column/Flex 布局、List/Swiper/NodeAdapter、组件复用与冻结等变更不涉及 |
| 宿主 harmony 工程 | entry 及自有模块 | 方舟运行时与原生 | 由 scanner 和主流程处理 |
| 三方 RN 鸿蒙库 | oh_modules、node_modules | 依实现而定 | 逐库核对 HAR 源码；release 或字节码 HAR 记缺口 |

按层排除必须写明具体依据，例如“业务 JS 运行于 Hermes”，不能用“RN 是跨平台框架”笼统排除。

## 补充评估方法

RNOH 行在 U04 按分组评估，各 `RNOH-` 组交给同一个 agent：评估对象是 RN 业务 JS 位置，框架依据只引用扫描给出的位置，不逐行评估 RNOH 框架。评估者阅读官方章节，按下列 2、5、6、9 判断生效条件、属性能否传到原生和证据等级，逐行确认业务写法是否真正触发。U04a 先对 `uncoveredEntries` 整体执行步骤 2、3 成组排除，再对剩余条目、`FRAMEWORK_ONLY` 规则和三方 RN 鸿蒙库执行步骤 4–9，结论写成对 RN 页面的影响。

1. **取区间条目。** 使用 U02 冻结的精确区间，按[版本变更查询](../common/changelog-query.md)取得全部条目；U04a 以扫描 JSON 的 `uncoveredEntries` 为待核对清单，每条带标题、`kit`、`category`、版本和来源位置。
2. **判断生效条件。** 区分 target 隔离门槛、未隔离的系统侧变更、由编译 SDK 触发的编译期变更（接口删除、必填参数、类型收窄）和仅影响开发工具的变更。原 target 到目标 target 之间跨过的全部门槛都会生效，不能只看目标版本。
3. **按层过滤。** 依上表排除明显不涉及的层，记录依据。
4. **关键字检索框架与 JS 层。** 每条整理 ArkTS 接口名、C API 名（`OH_ArkUI_*`、`NODE_*`、`ARKUI_NODE_*`）、枚举、字符串常量（如 `usual.event.*`）及错误码；排除 tests、stubs、third-party 目录。排除同名不同模块（`httpRequest.on('dataReceive')` 与 Share Kit 的同名事件，RN 的 fetch 与 RCP 的 fetch）、仅出现在注释中的匹配，以及只用于映射的常量（无障碍角色映射里的 `ARKUI_NODE_LIST`/`ARKUI_NODE_GRID` 并不创建节点）。
5. **默认值变更反向检索。** 受影响的是**未显式设置**该属性的节点，直接搜接口名找不到。改为检索创建该类节点的位置，核对是否设置了对应属性。
6. **追踪属性传递链。** 业务 JS 属性 → RNOH JS 视图配置 validAttributes（Bridgeless 模式优先使用 JS 静态配置）→ 原生 ComponentJSIBinder 与 ComponentInstance 读取的 rawProps → ArkUI 节点属性。任一环缺失时，业务侧设置无效。
7. **检索业务 JS。** 在 src 中查找受影响的 RN 组件与属性用法（见下文已核实事实中的对应关系），逐处记录文件和行号。
8. **核对三方 RN 鸿蒙库。** 对 debug HAR 源码执行同样检索；只有 release 或字节码产物时记缺口。
9. **标注证据等级。** 实证：当前工程实际版本源码的文件与行号；推断：参照其他版本或同类实现；需真机验证：静态无法确认，例如属性能否传到原生、动画期间的显示效果。下文“已核实事实”只用于定位，必须对当前工程实际版本复核，不继承结论。

## 记录与方案

RNOH 原始行的评估、批准、修复和报告与原生行一致：结论写入所属分组的 rowResults，方案项进入 items，报告自动把 `RNOH-` 分组放入“RNOH 业务影响分析”章节，并展示版本、框架依据核对、业务位置、框架整体影响、缺口和无规则条目。U04a 的补充结果没有 rowId，不写入 rowResults，不增加 CSV 分母，不伪造原始行：

- 核对结论用 `record-rnoh-review` 登记，报告据此在“RNOH 业务影响分析”章节逐条展示，并统计已核对、已排除和待核对数量。
- spec 方案 JSON 的 narrative 增加“RNOH 无规则条目补充核对”段落，只写概述；需要修改或决策的条目写成 [sharedItems](../../templates/spec-results.md)，ID 使用 `rnoh-` 前缀，批准通过 approvedSharedItems 登记。
- 未评估范围和 release HAR 这类整体缺口写入 scanEvidence.gaps；针对性测试建议在 U09 写入 progress.testSuggestions。

登记命令和输入：

```console
node "<skill-root>/scripts/csv/cli.mjs" record-rnoh-review --task "<绝对taskFile>" --project "<工程>" --mode upgrade --input "<补充核对JSON>" --receipt-output "<新回执JSON>"
```

```json
{
  "excluded": [
    { "reason": "属于方舟运行时变更，业务 JS 运行于 Hermes，不涉及", "entries": ["<条目的 sourceReference>", "<条目的 sourceReference>"] }
  ],
  "reviews": [
    { "id": "<条目的 sourceReference，或 FRAMEWORK_ONLY 规则的 ruleId，或 lib:<三方库名>>",
      "conclusion": "AFFECTED", "layer": "RNOH 原生框架", "condition": "target ≥ 18",
      "evidence": ["oh_modules/.ohpm/…/ScrollViewComponentInstance.cpp:120"], "evidenceLevel": "实证",
      "summary": "一句话结论", "proposal": "方案和影响平台", "sharedItemId": "rnoh-scroll-back-to-top" }
  ]
}
```

- `excluded` 用于第一轮成组排除：一组一条共同依据，`entries` 列出组内条目。`reviews` 用于逐条结论。
- 条目 id：无规则条目取扫描 JSON `rnoh.uncoveredEntries[].sourceReference`，框架整体影响规则取 `ruleId`，三方 RN 鸿蒙库写 `lib:<库名>`。
- `conclusion` 取 `NOT_AFFECTED`（不影响 RN 页面）、`AFFECTED`（影响，须写 `proposal`）、`NEEDS_DEVICE_VERIFICATION`（需真机验证）、`EVIDENCE_GAP`（证据不足，如 release HAR）；
- 结论只看变更是否到达 RN 页面并改变显示或行为，不看变化是好是坏。框架里有承载该变更的代码路径、条件也满足时记 `AFFECTED`，显示优化和修复性变更也一样，`proposal` 写“接受新行为，无需修改”和建议回归的页面或语言；有办法保留旧行为时一并写出，交用户决定。`NOT_AFFECTED` 只用于变更到不了 RN 页面的情况：框架没有对应的调用或节点、生效条件不满足、对应引擎或模块没有编入。到达与否静态判断不了时记 `NEEDS_DEVICE_VERIFICATION`。例如 ICU 换行能力升级：RN 文本经系统排版引擎断行，变更会到达页面，记 `AFFECTED` 并接受新行为；JIT 默认关闭：工程使用 Hermes，JSVM 未编入，记 `NOT_AFFECTED`。
- `evidenceLevel` 取 实证、推断、需真机验证。除 `EVIDENCE_GAP` 外至少给一条证据位置。
- 可以分多次提交，同一条目以最后一次为准，逐条结论优先于成组排除。重新扫描后清单变化，旧登记失效，需要重新登记。
- 需真机验证和证据不足的条目、尚未核对的条目由工具写入报告遗留事项，不必再手工写进 scanEvidence.gaps。

修改位置决定影响范围，方案须写明影响的平台：

| 修改位置 | 影响范围 | 要求 |
| --- | --- | --- |
| harmony 工程源码与配置 | 仅鸿蒙 | 按主流程最小修改 |
| RNOH 或三方库的 JS 层补丁 | 仅鸿蒙 | 属于依赖修改，须作为 sharedItems 获批；建议用 patch-package 固化并反馈上游，重新安装依赖后核对补丁仍生效 |
| RNOH 原生框架 | 仅鸿蒙 | 需要 debug HAR 源码并重建 HAR，或升级 RNOH 版本线；记 DECISION_REQUIRED 由用户决定，不擅自修改 oh_modules |
| 共享 JS 业务代码 | iOS、Android、鸿蒙 | 只为迁就鸿蒙差异时用 `Platform.OS === 'harmony'`、`Platform.select` 或 `.harmony.js` 文件隔离；修正为各端都正确的行为时可统一修改 |

滚动组件 backToTop 默认开启（target ≥18）对多数页面属于与 iOS 一致的体验优化，默认按可选适配、接受新行为处理；只排查倒序列表（`inverted`）、滚动位置即用户状态（阅读、编辑、表单）、依赖 onScroll 的联动逻辑和同页多个竖向滚动区域，排查出需要关闭的页面才形成 `rnoh-` 方案项。RNOH 当前版本无法仅靠业务 JS 关闭（见下文已核实事实），方案须包含 JS 白名单补丁或原生补丁。

例如：共享代码中统一写 `scrollsToTop={false}` 会关闭 iOS 原有的点击状态栏回顶；全屏页面显式 `<StatusBar hidden />` 在各端都合理；RN 自带 `SafeAreaView` 在 Android 上不生效。升级 RNOH 版本线是可选方案，JS 包与原生 HAR 须同版本，升级后按新版本源码重新评估。

## 构建与验证

- JS 修改后清理 Metro 缓存并重新生成 bundle（含 HBC），再按主流程完整构建 harmony 工程；构建证据只对当前 bundle 与 HAR 有效。生成命令以工程 package.json 的脚本为准，没有现成脚本或环境无法执行时向用户说明，不自行拼凑命令。
- Hvigor 只把 rawfile 里现有的 bundle 打进包，不编译业务 JS。内置构建入口在构建成功后把 rawfile 中的 bundle（路径、大小、SHA-256、修改时间）记入回执的 `rnBundle`，并与业务 JS、`patches/*.patch` 的修改时间比较：`FRESH` 表示 bundle 晚于全部源码；`STALE`、`PARTIALLY_STALE` 表示有源码在 bundle 之后改过，`newerSources` 列出这些文件；`MISSING` 表示包内没有 bundle（由 Metro 或外部下发加载）；`JS_PROJECT_NOT_FOUND` 表示找不到 JS 工程。只有 `FRESH` 时 JS 修改行才能引用本次构建作为验证。
- 这项比较依据文件修改时间，只是提示：刚检出的代码可能误报过期，手工改过 bundle 时间也会漏报。有疑问时以重新生成 bundle 为准。
- ohpm install 前核对 oh-package.json5 中 `@rnoh/react-native-openharmony` 的指向（版本号，或 `file:` 指向 npm 包内的 HAR，并在工程级 overrides 统一）。仓库中不存在该版本时 ohpm 报 00617101，改用 npm 包内同版本 HAR，不自行更换版本。
- RN 页面以 JS 驱动，设备用例按页面操作与预期结果组织。混合架构返回动画、横屏状态栏、点击状态栏回顶、属性能否传到原生等须真机验证。

## 已核实的 RNOH 实现事实

以下事实来自 RNOH 0.72.53、0.77.59、0.82.35、0.84.5 的 debug HAR 源码和 0.86.2 仓库源码，0.84.5 与 0.86.2 在下列条目上一致。只用于定位检索方向，评估时必须对当前工程实际版本复核：

- 表中结论只对列出的**精确版本**成立，不代表整条版本线。同一版本线的小版本之间可能有较大差异（例如 0.72.53 与 0.72.147），修复也可能被移植到旧版本线。
- 相邻两列结论不同时，变化点只能确定落在两者之间的区间，例如原生层开始处理 scrollsToTop、Image 淡入改用 animateTo 都发生在 (0.77.59, 0.82.35]，不能据此认定 0.77 全部小版本不支持或 0.82 全部小版本支持。
- 当前工程版本不在表中时，以实际源码为准，结论标为实证；无法取得源码（如 release HAR）时只能引用最接近的已核实版本，标为推断并在 scanEvidence.gaps 记录，不写成实证。
- 核对了新版本后，在评估证据中记录版本、文件与行号；需要沉淀为本表时补充新列，不覆盖已有版本的结论。

| 主题与生效条件 | 0.72.53 | 0.77.59 | 0.82.35 | 0.84.5 | 关键位置 |
| --- | --- | --- | --- | --- | --- |
| View 节点与架构 | StackNode，另含 ArkTS 架构组件 | CustomNode，仅 CAPI | 同 0.77 | 同 0.77 | ViewComponentInstance.h |
| 滚动组件 backToTop 默认开启（≥18） | 原生不处理 scrollsToTop | 原生不处理 | 原生按 scrollsToTop 设置 NODE_SCROLL_BACK_TO_TOP | 同 0.82 | ScrollViewComponentInstance.cpp、ScrollNode::setBackToTop |
| scrollsToTop 的 JS 传递 | — | validAttributes 缺失 | 缺失 | 缺失，真机实测 `scrollsToTop={false}` 无效，补入白名单后可传到原生 | ScrollViewNativeComponentDelegate.harmony.ts |
| setSpecificSystemBarEnabled 横屏行为（未隔离） | 使用 | 使用 | 使用 | 使用；JS 层 StatusBar 首次挂载即调用 setHidden(false) | StatusBarTurboModule.ts、StatusBarDelegate.harmony.ts |
| 页面退出时 aboutToDisappear 提前（≥18） | 销毁或挂起 Surface | 同 | 同 | 同；仅影响混合架构 | RNSurface.ets |
| 转场中禁止更新消失节点（≥13） | Modal 转场；Image fadeDuration 用 NODE_OPACITY_TRANSITION | 同 0.72 | Modal 转场；Image 淡入改用 animateTo | 同 0.82 | ModalHostViewComponentInstance.cpp、ImageNode.cpp |
| 平板 Display orientation（≥14） | 不发送方向事件 | 发送 namedOrientationDidChange | 同 | 同 | DeviceInfoTurboModule.ts |
| Image 圆角动态修改、zIndex 与 3D 透视（≥14） | NODE_BORDER_RADIUS、NODE_Z_INDEX、NODE_TRANSFORM | 同 | 同 | 同 | ArkUINode.cpp |
| Image autoResize | `resizeMethod` 不为 `scale` 时开启 | 同 | 同 | 同 | ImageNode.cpp |
| 阴影、Alert | NODE_CUSTOM_SHADOW；showAlertDialog | 同 | 同 | 同；Modal 使用 NativeDialog 自定义样式且无遮罩 | ArkUINode.cpp、AlertManagerTurboModule.ts、ArkUIDialogHandler.cpp |
| sigaction SA_RESETHAND | 无信号处理 | 无 | 崩溃处理器设置该标志 | 同 0.82 | ExceptionStackHandler.cpp |
| 键盘或无障碍点击来源 | 仅来源为 KEY 时处理 | 非触屏且非鼠标时处理 | 同 0.77 | 同 0.77 | StackNode.cpp |
| 窗口与安全区 | RNAbility 默认 setWindowLayoutFullScreen(true)；RNApp 扩展键盘安全区 | 同 | 同 | 同；StatusBar.setTranslucent 不支持 | RNAbility.ets、RNApp.ets |

0.84.5/0.86.2 的其他已核实点：Text 用属性字符串与占位符排版并显式设置换行策略（`textBreakStrategy` 为 simple 时 BREAK_ALL，否则 BREAK_WORD，不使用 HYPHENATION）；JSVM 初始化传入多个启动参数时存在 vector 扩容导致指针失效的缺陷；JS 层 SafeAreaView 显式设置 paddingTop 时实际取 paddingBottom。四个版本均未使用 NodeAdapter、drawModifier、组件复用与冻结、LocationButton、bindSheet、Canvas、RichEditor、鼠标 rawDelta、Want 文件授权 flag 及 CustomDialogController 字面量初始化。

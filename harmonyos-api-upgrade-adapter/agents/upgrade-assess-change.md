# 单个行为变更的只读评估

由[行为主流程 U04](../references/upgrade/upgrade-workflow.md#u04-按变更条目评估)调用。

**本说明自足。** 评估所需的规则已全部写在这里，按本说明即可完成评估，无需再打开主流程、兼容专题、草稿格式或编码规范。只有下文明确写出“读取”的文件才需要读：主 agent 给出的官方章节、命中的案例正文、分组输入和草稿、工程源码与 SDK 声明，以及适用时的 HAR／原生／RNOH 专题。

<!-- 维护：下列内容摘自其他文件，修改规则时两处同步。
     通用原则、官方资料定位、分类与记录 ← references/upgrade/upgrade-workflow.md
     行为版本与 target 隔离 ← references/upgrade/upgrade-compatibility.md
     草稿格式 ← templates/assessment-results.md#评估草稿与接收
     新增调用 ← references/common/arkts-coding-standards.md#新增调用的废弃状态 -->

**职责。** 一个 agent 完整负责一个准确变更条目及其全部关联文件和调用点，自己读完、自己判断。条目再大也由本 agent 逐个处理完。

主 agent 可能把几个只有几行的小条目一起交给你。这时逐个条目完整走一遍下面的步骤：每个条目用它自己的草稿、只读输入和官方章节，各自运行 check-assessment，返回时分条目列出结果。一个条目的证据只在它确实适用于另一个条目时才复用（例如已核实的应用级配置）。

**可写范围。** 只编辑主 agent 提供的独立评估草稿。工程源码、配置、共享分组、spec、进度和报告对本任务只读；草稿经固定工具由主 agent 接收。

## 三条原则

1. **证据分层。** 扫描命中只说明存在需要评估的调用候选；你读完官方章节和源码后的判断是模型评估结论（MODEL_ASSESSED），附 reason/evidence。构建和设备验证是另外的证据层，本任务没有执行，如实写明。原因：用户依据报告决定是否发布，把低层证据写成高层结论会让未验证的行为进入线上。
2. **每个原始行恰有一条结论。** 每个 rowId 在草稿中恰好出现一次，重复的扫描行各自保留。原因：逐行对应是用户核对“每条扫描结果去哪了”的唯一依据。
3. **任务数据经内置工具读写，缺口如实保留。** 行身份、路径和哈希直接取自主 agent 给的输入和草稿，用原生文件编辑工具修改草稿。自写的 shell 循环或临时 Python/Node 脚本绕过工具的校验，得到的结果无法与交付件对账。信息不足时按下表记录具体缺口，证据充分的独立部分照常完成。

| 情况 | outcome |
| --- | --- |
| 来源、触发条件、默认值或源码无法确认 | EVIDENCE_GAP |
| 需要产品或业务决定 | DECISION_REQUIRED |
| 尚未阅读或处理 | PENDING |

## 输入

- 变更名称、规则身份、准确来源和保留 Beta/Release 的精确版本。
- 本地官方章节路径及起始位置；必要时提供扫描 JSON 和原始行以核对身份。
- 案例命中情况：命中时给出案例正文路径，未命中时注明。主 agent 未说明时，自行查[案例索引](../references/upgrade/upgrade-examples.md#案例索引)。
- 由 draft-assessment 生成的独立评估草稿绝对路径，完整保留工具给出的分组/原表哈希。
- 当前分组只读输入 JSON 的绝对路径（由 csv inspect --task --group --output 生成）。从它的 result.rows 直接读取完整 rowId、物理文件、调用位置和 API 定义。版本与来源写在 result.group 上，行里只在与本组不同时才出现 version、sourceReference；行里出现 gaps 表示这一行有待核对的缺口，没有这个字段就是没有。输入应包含全部关联物理文件、调用位置和范围外说明。
- 工程/product/模块范围、真实 SDK 路径、已取得的环境 JSON 绝对路径与返回的 SDK 根/default/元数据路径、原/目标 target、原 compatible；HAR 另有宿主和历史基线信息。SDK 路径和环境信息直接复用这份环境 JSON。
- 业务目标及已知约束；默认尽量保持升级前的功能、视觉和交互体验。

使用输入时：

- rowId 与文件、调用的对应关系以 result.rows 为准。
- 已核实的共同配置/模型证据可以关联多行，返回时仍列出全部原始行的归属。尚未阅读的行保持 PENDING。
- 输入有缺失时先指出具体缺口。证据充分的独立文件照常评估；未知取值记为缺口。

## 评估步骤

1. **读取完整官方章节。** 核对本条的标题、来源和保留 Beta/Release 的精确版本（Beta1、Beta2、Release 是三个不同版本）。从起始行读到代码围栏外下一个同级或更高级标题，读完原因、影响、生效条件、接口清单、指导和代码示例，记录工具实际读取的范围。本 agent 需要自己读原文；同一任务内已读过的原文可以复用，主 agent 的摘要和链接用于定位。仅在本地缺失、歧义或与真实 SDK 冲突时补充官方网页，并记录原因、准确 URL、实际阅读范围、补充内容及差异。无法唯一确认章节或身份冲突时，保留原行并记录 EVIDENCE_GAP。

2. **逐文件核对全部调用点。** 阅读相关文件的完整上下文及必要调用链，核对实际组件/接收者、重载、实参、默认值、生命周期和业务用途；必要时读准确 SDK 声明，位置见下文[SDK 声明的位置与检索](#sdk-声明的位置与检索)。
   - 先确认接收者确实是 SDK 对象。业务代码里可能有同名封装。
   - 属性未显式书写时，查明它的默认值再判断是否触发。
   - 调用行号可能过期，以真实代码为准；无法唯一定位时保留缺口。

3. **判断影响并提出方案。**
   - 命中案例时，在分类前读完该案例正文，并核对它的实际触发/排除条件；只读命中的案例。单列的漏扫排错入口由真实错误/异常触发，正常扫描命中时不读。
   - 结合完整官方章节、实际配置和源码落实触发/排除条件。先核对应用级前提，再核对调用级差异。
   - 按下文[分类依据](#分类依据)逐调用分类，在 reason/evidence 写清条件成立、不成立或具体缺口及证据。判断某项配置为关闭时需要配置或默认值的正面证据；搜索无结果时记为缺口。
   - 按下文[行为版本与 target 隔离](#行为版本与-target-隔离)区分设备行为边界、target 隔离和接口起始版本。原显式参数已足够时沿用原写法。
   - 默认提出保持旧体验的最小方案。只有该调用的实际效果会变化时才提出修改；默认值变化但本调用不受影响的，分类为无需适配。

4. **识别依赖和验证要求。** 列出共享配置/helper、跨文件影响、方案取舍、预期业务行为和需要的用例。
   - 候选方案新增或替换 SDK 调用时，按下文[方案中的新增调用](#方案中的新增调用)核对。
   - 迁移范围限于本次候选方案，原有的无关废弃调用保持原样。
   - 专题（仅在适用时读取）：HAR 读[宿主专题](../references/upgrade/har-upgrade.md)，C/C++ 读[原生专题](../references/common/native-adaptation.md)。RNOH 工程中的入口、自定义 TurboModule、Fabric 组件或混合页面读[RNOH 专题](../references/upgrade/rnoh-upgrade.md)，方案涉及共享 JS 时写明影响平台。
   - 无法确认来源/默认值/封装、失败契约，或替代能力不满足原 compatible 时，保留证据缺口及取舍。需要产品决定的记 DECISION_REQUIRED。方案里只使用已核实可用的 API。
   - 仅当本组 Rule ID 以 `RNOH-` 开头时（这类组通常一起交给你，RNOH 专题、版本基线和属性传递链只需读取和核对一次，各组共用）：每行都是 RN 业务 JS 位置（`../` 开头，位于 harmony 平级的 JS 工程），评估对象是该业务写法。分组只读输入的 `result.rnoh` 给出本组的框架依据（`framework.status` 与 `framework.locations`）、RNOH 原生 HAR 版本与形态、JS 包与 react-native 版本、各层核对情况（`coverage`）和缺口（`gaps`），框架位置作为只读依据引用，无需再打开整份扫描 JSON。`framework.status` 为 UNVERIFIED 或原生 HAR 为 RELEASE_BINARY 时，属性能否传到原生无法实证，按证据等级标为推断或需真机验证。按[RNOH 补充评估方法](../references/upgrade/rnoh-upgrade.md#补充评估方法)核对生效门槛、属性传递链（业务 JS → RNOH JS validAttributes → 原生 rawProps → ArkUI 属性）和证据等级。方案写明修改位置及影响平台（共享业务 JS 会影响 iOS/Android）；修改依赖目录或 RNOH 原生框架记待决策。

5. **核对覆盖并返回。** 所有关联文件和调用点都有结果或具体未完成原因；重复 rowIds 的原始行关联完整保留。评估结论标为模型评估。失败或中断时，列出实际已处理与剩余范围。

## SDK 声明的位置与检索

需要读 SDK 声明时，从环境 JSON 返回的 sdkDefaultRoot 出发，直接打开下表的目录或文件。SDK 目录很大，含编译工具和 node_modules，从根目录递归查找文件可能要几十分钟，按下表定位只需几秒。

| 要找的声明 | 位置 |
| --- | --- |
| ArkUI 组件及其属性 | `<sdkDefaultRoot>/openharmony/ets/component/<组件名小写>.d.ts`，如 button.d.ts、image.d.ts |
| 通用属性与通用事件 | `<sdkDefaultRoot>/openharmony/ets/component/common.d.ts` |
| OpenHarmony 接口（`@ohos.*`） | `<sdkDefaultRoot>/openharmony/ets/api/` |
| Kit 导出（`@kit.*`） | `<sdkDefaultRoot>/openharmony/ets/kits/`、`<sdkDefaultRoot>/hms/ets/kits/` |
| HarmonyOS 专有接口 | `<sdkDefaultRoot>/hms/ets/api/` |
| C/C++ 头文件 | `<sdkDefaultRoot>/openharmony/native/sysroot/usr/include/`、`<sdkDefaultRoot>/hms/native/sysroot/usr/include/` |

- 不确定声明在哪个文件时，用系统自带的 grep 在上表的某一个目录内检索，例如 `grep -rn "ButtonOptions" "<sdkDefaultRoot>/openharmony/ets/component"`。
- `openharmony/ets/build-tools/` 下是编译工具使用的声明副本，评估以上表目录中的声明为准。
- ripgrep（rg）等第三方命令不一定已安装。检索命令保留错误输出，这样能区分“命令不存在”和“没有匹配”；输出为空时先确认命令本身可用，再记为未找到。
- 上表目录不存在时（SDK 布局不同），先列出 sdkDefaultRoot 下一两层确认实际结构，再在实际目录内检索。

## 分类依据

| 分类 | 依据 | 评估阶段的 outcome |
| --- | --- | --- |
| 无需适配 | 未触发、已符合指导、原调用满足要求或仅需重编译，有具体源码和官方依据 | NO_CHANGE |
| 可选适配 | 接受新行为或保留旧体验均符合已知业务要求；默认提出保留旧体验的方案并说明成本，交由 spec 确认 | DECISION_REQUIRED |
| 必须适配 | 已有证据表明会破坏所需业务、契约或编译正确性，需要具体修复；分类之后仍需用户批准才实施 | PENDING；方案需业务取舍时 DECISION_REQUIRED |
| 范围外 | 该行不属于本条变更或本次工程范围，写明依据 | OUT_OF_SCOPE 或 NO_CHANGE |
| 待分类 | 尚未阅读，或证据、决定不足 | PENDING、EVIDENCE_GAP 或 DECISION_REQUIRED |

- 分类以调用为单位：同一变更的不同文件、同一文件的不同调用可以分类不同。
- 条件未触发时分类为无需适配并写明依据。“接受新行为”只用于条件已触发且由用户选择接受的情况，这个决定由用户在 spec 上做出，评估阶段把这类行列为可选适配。
- 证据或决定不足时使用缺口状态，前三类只用于依据充分的行。

## 行为版本与 target 隔离

分别记录以下事实，它们各有用途：

| 事实 | 用途 |
| --- | --- |
| 接口起始版本 | 说明接口何时存在；行为变化的门槛另看下一行 |
| 行为变更版本与触发条件 | 判断设备是否具有该变化，以及当前业务是否受影响 |
| 官方 target 隔离门槛 | 仅在官方明确隔离时，结合真实应用或宿主 target 选择语义 |
| compatible 与设备 API | 确认仍需支持哪些系统，以及当前设备实际采用的行为 |

对明确按 target 隔离的变更：

| 设备和 target 条件 | 应理解的行为 |
| --- | --- |
| 设备早于行为变更版本 | 设备保留旧行为；提高 target 不会使旧设备获得新实现 |
| 设备已有变更，真实 target 低于隔离门槛 | 按官方隔离规则采用旧语义 |
| 设备已有变更，真实 target 达到隔离门槛 | 在满足官方触发条件的调用上采用新语义 |

- 未按 target 隔离的变更按设备行为版本和具体影响范围判断，保持旧 target 无法规避它。隔离状态未明确时保留证据缺口。
- 例：接口自 API12 存在，API14 发生行为变化，target 升至 26 而 compatible 保持 13。需要判断的是 API13 设备上的旧行为与 API14 及以后设备上的新行为；接口的 since12 和目标 26 都不是这条行为的门槛。
- 原接口已支持的显式参数能在整个支持范围内保持所需效果时，优先直接设置。只有新旧行为需要不同业务处理时，才提出按准确设备边界分支的方案，回调、订阅/取消、初始化及清理跨越同一行为时保持分支一致。
- 方案确需版本分支时，写明行为边界版本和需要的判断，并说明所用的版本查询接口自身满足原 compatible。`apiAvailable`、`sdkMinorApiVersion`、`sdkPatchApiVersion` 自 26.0.0 引入，`@Available` 自 API22，`@SuppressWarnings` 自 API23，compatible 低于这些版本时它们不能用于公共判断路径。具体写法需要时再读[兼容专题](../references/upgrade/upgrade-compatibility.md#arkts-与-c-行为分支)；版本证据不足时保留 EVIDENCE_GAP，compatible 保持原值。

## 方案中的新增调用

仅当候选方案要新增或替换 SDK 调用时核对，范围是本次方案涉及的调用和获取链：

- 核对准确接收者、声明/重载的 `@deprecated`、`@useinstead`、替代接口及整条获取链的 since，包括新 helper 和准备复制的示例代码。官方旧文档中的示例同样核验后再用。
- 选用满足工程原 compatible 的非废弃接口，保持参数、单位、返回形态、异常及生命周期。找不到满足条件的替代或来源不明时，保留 EVIDENCE_GAP/DECISION_REQUIRED 及已核验事实，compatible 和告警配置保持原样。
- UIContext 取自当前组件/窗口：组件内从自身有效生命周期取得，工具函数或 HAR 沿已有调用链传入。绘图上下文（CanvasRenderingContext2D）是另一种对象。
- 核对同步抛错、Promise 拒绝、获取失败及回调失败，明确有效处理边界和业务失败出口，把必要改动纳入方案及 reason/evidence。已有外层处理可复用；确认为不抛异常的同步 API 直接调用。

## 草稿格式

草稿是直接的 JSON 对象。schemaVersion、groupId、sourceSha256、groupSha256 由工具提供，保持原值。items 初始已列出该组全部完整 rowId，状态为待分类/PENDING。读完全部调用后，可以把评估相同的行合并为一项或拆分，每个 rowId 恰好出现一次。

```json
{
  "schemaVersion": 1,
  "groupId": "<工具提供>",
  "sourceSha256": "<原始CSV哈希>",
  "groupSha256": "<当前分组哈希>",
  "knowledge": {"sources": [{"originalReference": "<原始来源>", "localReference": "<核实路径>", "readRanges": ["<实际阅读范围>"]}]},
  "changeSummary": {"before": "", "after": "", "targetIsolation": "", "proposal": ""},
  "items": [{
    "rowIds": ["<完整原始rowId>"],
    "category": "可选适配",
    "outcome": "DECISION_REQUIRED",
    "reason": "本调用已核实的触发条件、具体影响和拟议方案",
    "compatibility": "实际跨系统分析或具体缺口",
    "evidence": ["真实源码、SDK、官方章节及阅读范围"],
    "changes": [],
    "next": "等待用户决定是否保留旧体验"
  }]
}
```

| 字段 | 填写规则 |
| --- | --- |
| category | 必须适配、可选适配、无需适配、待分类、范围外 |
| outcome | 按[分类依据](#分类依据)的对应列填写。MODIFIED、NOT_IMPLEMENTED 属于后续阶段，由主 agent 写入 |
| reason、compatibility、next | 字符串。reason/evidence 保存实际实参/默认值、触发判断、SDK 和源码位置，只写与本条相关的内容 |
| evidence、changes | 字符串数组。评估阶段 changes 为空数组 |
| next | 只写本任务实际剩余的动作，没有时填空字符串。未选择的设备验证、可选的后续建议写入 evidence |
| reportSummary（逐行可选） | 一两句概括本行核心理由 |
| changeSummary（顶层） | before/after/targetIsolation/proposal 各为字符串，供评估与方案使用；可选 business 用一至三句概括本变更在当前业务中的触发条件与影响。DevEco 报告摘要由工具引用官方原文，关键决策读取方案和实际答复 |
| knowledge（顶层） | 多个来源完整放入 knowledge.sources。originalReference 保留扫描 JSON 或历史 CSV 的 Source Reference 原值，缺失时留空；localReference 为核实后的当前章节路径及行号；rawVersion/version 为原始/规范化精确版本；readRanges 只登记真实读取的范围；补充官方网页时在 supplements 记录 reason/url/readRange/content/difference。knowledge 只放在顶层 |

**校验与提交。** 提交前运行（参数由主 agent 提供）：

```console
node "<skill-root>/scripts/csv/cli.mjs" check-assessment --task "<taskFile>" --project "<工程>" --mode upgrade --group "<实际ID>" --input "<评估JSON>"
```

check-assessment 只读校验身份、字段与覆盖，通过不代表业务语义正确。报错时依据 details.jsonPath 用原生文件编辑修正，再次校验。import-assessment 由主 agent 运行，分类和理由以本草稿为准。

## 返回内容

评估给出分类和方案。接受新行为、实施修复或不实施由用户在 spec 上决定。

以下内容保留在草稿的 reason/evidence/knowledge 或返回说明中：

| 部分 | 包含 |
| --- | --- |
| 变更 | 名称、规则/来源/精确版本、官方旧新行为、触发条件与 target 隔离 |
| 每个文件/调用 | 物理路径、实际位置和全部 rowIds、分类或缺口、reason、源码/SDK/原文 evidence |
| 建议 | 最小修改或无需修改依据、跨系统处理、保留旧体验的成本与替代方案 |
| 协调事项 | 共享修改、跨文件依赖、与其他变更可能冲突的方案、待决策项 |
| 验证 | 可执行的业务预期、功能/视觉用例建议、尚未验证的边界 |
| 覆盖 | 实际已评估与未完成文件/调用点，具体下一步 |

向主 agent 的返回说明保持简短：分类统计、核心结论、缺口/待办、check-assessment 结果。详细内容已在草稿里，无需重复。

主 agent 据此生成 spec，取得批准后进入独立的修复阶段。分类为必须适配的条目同样在修复阶段处理。

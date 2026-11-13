# DevEco规则包未覆盖条目的补充处理

本步骤位于U06主CSV评估及获批修复之后、U07最终复核构建之前。输入是同区间官网声明、实际DevEco规则包比对结果、当前源码/配置及真实SDK，不读取或复用CSV对应规则的评估结论。

## 核对比对并登记决定

扫描器通过现有版本查询能力取得冻结的精确(from,to]条目，与规则包原始条目清单按准确来源、官网ID和版本比对，扫描JSON的officialComparison保留清单及文件哈希。规则包中有条目但不能静态检测，不等于缺规则；阶段或身份匹配不确定时单列待核对，不直接当缺规则。

完成主 CSV 阶段后，先读取每个工程的比对结果。

```console
node "<skill-root>/scripts/csv/cli.mjs" inspect --task "<绝对taskFile>" --project "<工程>" --mode upgrade
```

若 `ruleGapDecisionRequired` 为 true，按 [U06a](upgrade-workflow.md#u06a-按需处理deveco规则包未覆盖条目)展示各工程的 `ruleGapCount` 并等待明确答复。沿用有效的 `ruleGapReviewDecision`。已开始补充评估的历史任务保留已有记录，按剩余事项继续。零行 CSV、全无需修改或仅评估任务也按实际比对结果处理。

缺少比对字段时记为覆盖情况未知。来源变化时，`ruleComparisonSourceStale` 为 true，重新取得可信比对后再确认。映射或阶段待核对项由 `ruleComparisonPendingCount` 单独记录。确认未覆盖数量为零时直接继续。

取得答复后，按工程将 `action`（「否」用 `SKIP`，「是」用 `REVIEW`）、`basis`（inspect 返回的 `ruleGapBasis`）、`answer`（实际答复）和 `source`（可定位的对话来源）写入决定 JSON。决定 JSON 只有这四个字段，补充说明并入 `answer`：

```json
{
  "action": "SKIP",
  "basis": "<inspect 返回的 ruleGapBasis>",
  "answer": "否（推荐）",
  "source": "<可定位的对话来源>"
}
```

```console
node "<skill-root>/scripts/csv/cli.mjs" record-rule-gap-decision --task "<绝对taskFile>" --project "<工程>" --mode upgrade --input "<决定JSON>" --receipt-output "<新回执JSON>"
```

决定保存在 `progress.decisions.ruleGapReview`。明确跳过适用于尚未开始逐条评估的工程。若需中止已开始的评估，保留已有结果和剩余事项，按当前进度交付。用户尚未答复时保留待决定。

## 独立评估

用户选择「是」后，运行准备命令，按返回的独立 ID 逐条处理。

```console
node "<skill-root>/scripts/csv/cli.mjs" prepare-rule-gaps --task "<绝对taskFile>" --project "<工程>" --mode upgrade
```

逐条完整阅读返回的document/startLine/endLine及官网正文，核对生效条件、当前代码、配置和真实SDK。SDK 声明按[评估说明的定位表](../../agents/upgrade-assess-change.md#sdk-声明的位置与检索)直接打开对应目录或文件。分类沿用无需适配、可选适配、必须适配；证据不足保留待分类及具体next。不新增自定义扫描规则，不把检索命中当必须修改，也不把主CSV已经修改当前文件当本条已解决。

主agent准备独立JSON并使用record-rule-gap-review接收；id来自工具，不包含rowId。首次记录示例：

```json
{
  "id": "<工具返回的official-ID>",
  "category": "无需适配",
  "reason": "<官方触发条件与当前工程核对结果>",
  "evidence": ["<实际阅读的官方章节与SDK声明/检索依据>"],
  "locations": ["<实际文件及调用位置>"],
  "files": ["<实际核验的源码、配置及SDK声明文件>"],
  "proposal": "",
  "next": ""
}
```

```console
node "<skill-root>/scripts/csv/cli.mjs" record-rule-gap-review --task "<绝对taskFile>" --project "<工程>" --mode upgrade --input "<独立评估JSON>"
```

files支持工程相对路径或绝对路径，工具保存当前字节哈希；包含所有相关的实际输入，证据文字不能代替文件核对。无需适配不要求批准；有修复计划时在proposal写明业务方案、文件及共享影响，不能只写“已评估”。记录集中在progress.ruleGapReviews，工具不替模型判断语义。

检索工程使用事实时，先限定本轮源码与配置范围。调用 grep 或 glob 前设置路径与排除范围，遍历从源码目录开始，并排除 build、oh_modules 和其他生成目录。

## 按需批准与修复

确需修改时，主agent在交付目录保存该条独立方案spec-rule-gap-<完整ID>.md并向用户展示。仅对新增或实质改变的范围取得实际答复，原CSV方案和仍有效的批准不重复询问。向record-rule-gap-review提交同一id和decision，包含action、answer、source及可选plan；action为APPLY_APPROVED_CHANGE、ACCEPT_NEW_BEHAVIOR或NOT_IMPLEMENTED，接受新行为仅适用于可选适配。默认plan为该条独立方案，工具归档批准时原文并绑定当前proposal、分类和位置。

获批后按U06同样的编码、SDK失败契约和最小修改规则修复，再提交outcome=MODIFIED、非空changes、实际files和剩余next；已修改不表示构建或设备验收通过。方案实质变化必须重新展示受影响部分；不能只改outcome绕过批准。明确不实施或仅评估时沿用原真实答复与来源，不新询问修复授权；保留分类和未实施结论，不构建修复包。

对比方式继续使用主流程在任何相关修改前归档的before包，不在CSV修改后补造原包。补充修改完成后统一进入U07/U08；额外设备范围仍需已有授权，不伪造CSV身份来生成设备用例。

## 交付与继续

存在确认未覆盖条目时，report render 在 HTML 单列「DevEco 规则包未覆盖条目补充处理」。用户选择跳过时，章节只显示未覆盖数量和跳过摘要。validate/verify 返回 `ruleGapCount`、`ruleGapAssessedCount`、`ruleGapPendingCount`、`ruleGapSkippedCount` 和 `ruleComparisonPendingCount`。已跳过项计入 `ruleGapSkippedCount`，原 `pendingCount` 仍只统计原始 CSV 行。

ruleComparisonPendingCount只统计映射或阶段未定条目，不混入文件数量；规则包或官网来源变化另以ruleComparisonSourceStale=true及gaps表达，不因条目计数为零而认定比对仍有效。

补充完成不修改规则包本身的覆盖事实。官网/规则包来源变化后重新准备并评估，旧记录保留但不继承成功；相关输入或方案变化后重新核对，更新真实当前依据后再发布。U07同时检查补充修改的实际差异、异常处理、批准与剩余事项，全部结论以最终构建及实际验证范围为准。

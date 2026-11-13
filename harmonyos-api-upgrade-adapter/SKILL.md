---
name: harmonyos-api-upgrade-adapter
description: 用于查询 HarmonyOS（鸿蒙） 版本间 API 变更，以及废弃 API 扫描与迁移、API 行为变更扫描与适配。询问版本差异/changelog、升级 targetSdkVersion、调整 compatibleSdkVersion、处理扫描 CSV、ArkTS/ArkUI API 兼容或 HAR/原生行为变更时使用。纯查询只读内置官方快照，无需工程或 SDK；适配由模型依据官方知识、真实 SDK 和工程上下文逐文件完成最小修改、兼容分析、真实检查与业务报告。scanner 提供扫描事实，轻量文件保存进度。支持 HAP；HAR 与 C/C++ 行为按真实构建和宿主场景处理；RNOH（React Native for OpenHarmony）工程追加框架层与 JS 层补充评估。
metadata:
  version: "1.0.0"
  keywords: "HarmonyOS, 鸿蒙, 版本差异, changelog, API 行为变更, 废弃 API 扫描与迁移, targetSdkVersion, compatibleSdkVersion, 扫描 CSV, ArkTS/ArkUI API 兼容, HAR, C/C++, RNOH"
---

# HarmonyOS API 升级适配

## 先判断请求类型

| 请求 | 做法 |
| --- | --- |
| 只询问版本间变更、版本差异或 changelog | 按[版本变更查询](references/common/changelog-query.md)调用内置只读工具并直接回答。这条路径只读内置快照，无需 taskFile、SDK 或工程 |
| 要求扫描、适配或迁移工程 | 按下文选择一条完整流程 |
| 两者都有 | 查询部分直接回答；工程部分走完整流程，工程命中以实际扫描行为准 |

references/changelogs 完整收录官网声明的变更，支持范围内无条目的版本表示无声明行为变更。查询结果说明版本间有哪些变更，某个工程是否命中需要扫描才能确定。

## 工程适配的起步

1. 进入任何子工程前，先记录宿主会话的任务启动根目录。
2. 按[任务根目录与联合交付](references/common/task-output.md)初始化一次任务、登记计划工程并保存绝对 taskFile。两条流程、子工程扫描、导入及重试都复用这个 taskFile。输出根由 taskFile 决定；scanner 缺少任务上下文时会停止，此时回到本步骤初始化。
3. 确定功能，完整阅读对应主流程，然后按它执行。

分工：模型负责业务判断、修改与任务组织；scanner、SDK、Hvigor 及设备工具提供真实结果。条件步骤记录执行、跳过或阻断的原因。

## 选择完整流程

| 用户需求 | 唯一主流程 | 适用范围 |
| --- | --- | --- |
| API行为变更 | [行为完整流程](references/upgrade/upgrade-workflow.md)，U01–U09 | HAP、明确模块/目录的HAR及相关C/C++；RNOH工程以harmony目录为HAP，扫描附带受影响的RN业务JS位置，报告单列RNOH章节 |
| 废弃API迁移 | [废弃完整流程](references/deprecated/deprecated-api-adaptation.md)，D01–D11 | 应用入口，可限定注册模块/目录；独立HAR入口不在支持范围 |

只加载当前功能的主流程；公共资料在流程指定的节点按路径读取。每条流程自己完整定义范围与版本、扫描/导入、评估与批准、修改、验证、失败返回和交付。目标选择、方案批准与设备授权以该流程为准，已明确的选择直接沿用。

两条流程的差别：

| | 行为变更 | 废弃 API |
| --- | --- | --- |
| 评估与修复 | 先按变更条目分派只读评估，汇总 spec.md，用户确认后修复。少量文件由主 agent 处理，较多时按物理文件分派 | 编辑 prepare 生成的 rowResults，方案获批后迁移 |
| 默认取向 | 尽量保持升级前体验 | 保留低版本兼容 |
| compatible | 保持原值 | 按流程核对最低兼容版本 |
| 复扫 | 只扫描一次 | 修复后复扫，核对残留调用 |
| 设备验证 | 按用户选择：不运行、修改后验证、前后对比 | 仅在用户明确要求时做单次验证 |
| 范围外 | 通用接口版本可用性匹配 | 修改前后对比 |

**规则包未覆盖的官方条目（仅行为）。** scanner 将本轮行为区间的官方条目与 DevEco 规则包比对。主 CSV 评估和获批修复结束后，若有效比对确认有未覆盖条目，由用户选择是否[补充评估](references/upgrade/rule-gap-review.md)，推荐选「否」。用户选择「是」后，依据官方正文、源码和 SDK 独立评估，确需修改时另行取得批准。选择「否」时，HTML 记录未覆盖数量和跳过决定。

## 使用内置工具

任务数据的读取、统计和写入统一经内置工具完成。这些工具同时校验原表哈希、行身份和批准范围，所以它们的结果能与交付件对账；需要某个统计或数据时，先在下表找对应入口。

| 需要 | 使用 |
| --- | --- |
| 环境与 SDK 路径 | inspect-environment。已有 DEVECO_SDK_HOME 时可省略 --sdk。直接复用返回的 sdkRoot/sdkDefaultRoot/sdkPackagePath |
| 原始 CSV 读取、统计、完整分组只读输入、结果写入 | [内置 CSV 工具](scripts/csv/cli.mjs) |
| 行为评估 | 评估 agent 编辑固定工具生成的独立草稿，check-assessment 只读校验，错误退回原评估者修正；主 agent 按[评估接收契约](templates/assessment-results.md)接收明确 rowId 集合 |
| 方案与批准 | prepare-spec 生成方案明细与同组互斥做法；主 agent 将用户明确选择的做法 ID 填入 approvedItemIds |
| 操作回执 | 导入、批准、处理更新和交付核对使用 --receipt-output 保存 UTF-8 回执，再用文件读取工具打开。其他命令（如 record-verification）不接受这个参数，结果直接从标准输出读取 |
| 处理状态 | 批准后用 draft-resolution 生成处理草稿，填写实际差异及剩余 next，经固定入口更新；说明性待办用 reviewOnly 核实关闭 |
| 待处理统计 | csv validate 的 pendingGroups；逐行定位用 --details --output 保存诊断 |
| 报告 | [内置报告工具](scripts/report/cli.mjs)的 render（省略 --data），同一次读取共同生成 CSV 与 HTML。它是独立入口，不是 CSV 工具的子命令 |
| 构建 | 内置构建取证入口：在对应工程根安装依赖，成功后启动 Hvigor，保存完整日志和真实退出码 |

数据只存一处：变更级背景和方案保存在 group.changeSummary，逐行结论保存在 rowResults，progress 登记决定、配置事实和验证引用。报告和结果表都从这三处生成，因此没有单独的报告 JSON 或 runtime 逐行结果 JSON 需要维护。判断由做出评估的 agent 写入草稿，主 agent 原样接收。具体参数与例外边界见下列公共资料。

## 公共资料的使用

公共资料只维护一份，提供知识和方法；步骤顺序由主流程编排。

- [版本契约](references/common/sdk-versions.md)：统一配置/打包字段、设备API家族与扫描版本。
- [API保护与告警](references/common/compatibility.md)服务废弃迁移；[target升级兼容](references/upgrade/upgrade-compatibility.md)服务行为流程，HAR追加[宿主专题](references/upgrade/har-upgrade.md)，RNOH工程追加[RNOH专题](references/upgrade/rnoh-upgrade.md)。行为评估先查[案例索引](references/upgrade/upgrade-examples.md#案例索引)，命中时在分类前沿链接读完该案例的独立正文并核对实际触发/排除条件；只需读命中的案例。
- [编码规范](references/common/arkts-coding-standards.md)、[原生知识](references/common/native-adaptation.md)：按实际修改场景读取。
- [真实验证方法](references/common/verification.md)、[功能取证](references/common/runtime-functional-tests.md)、[排错与继续](references/common/troubleshooting.md)：主流程决定何时执行、如何批准及返回哪里。
- [通用进度](templates/progress.md)、[逐行结果格式](templates/results.md)：共享文件布局和基础字段；功能记录及报告组织由当前主流程定义。

## 同时处理两类任务

**各自独立。** 两类任务分别保存输入身份、原始行、批准范围、进度和报告，各自给出业务结论。

**共同基线。** 修改前记录两条任务共同的原 target/compatible 和源码基线。两条任务的“原值”都取这份基线，与执行先后无关。共享源码/配置的必要修改纳入全部受影响方案的实际批准范围，获批后实施。联合展示方案时分别记录答复及批准范围，批准粒度是方案项。

**before 包。** 仅当行为任务选择前后对比时需要：

1. 先真实构建并归档原源码/原配置的 before 包。
2. 再实施影响基线的源码/配置修改，包括废弃任务的共享修改。
3. 设备测试可在修复后依次执行 before/after。

原包构建或归档受阻时，按行为主流程等待用户的明确决定。有效原包已归档后，设备阻断只影响测试，修复照常进行。废弃单独任务没有修改前基线的要求。

**共享构建证据。** 最终源码、配置、SDK、product/target 与库消费关系一致时，两类任务可关联同一次真实完整构建证据。之后任一相关修改都会使受影响的旧验证待复核。废弃真实复扫、行为适用性与分类、设备用例和两类报告各自核对，每个功能的通过结论只适用于它自己。

## 全程约束与交付

**证据。** 判断基于准确的官方知识、SDK 声明和工程上下文。语义正确需要这些依据共同支撑；扫描命中、文件变化和编译通过各自只证明自己那一层（见行为流程的[通用原则](references/upgrade/upgrade-workflow.md#通用原则)）。真实工具结果保存命令、cwd、版本、退出码、日志与当前产物。模型自检、未执行、失败、证据不足分别表达。修改后取得真实完整构建成功才算完成，否则按部分完成交付；相关输入变化后重新验证。额外设备范围按当前功能与实际要求记录。

**保真。** 保留原始扫描字节、全部逻辑行/重复行、SDK、依赖源码、官方原件及任务外改动。废弃按准确 since 和版本家族处理迁移；行为按官方触发条件和 target 隔离理解变化。修改保留返回/回调、异常传播和生命周期。

**工具边界。** 可信的静态工作只依赖本 skill 自带的脚本和资料。当前架构是文档驱动加确定性工具：内置 runtime 工具负责测试身份、快照、设备执行和证据审计，适配修复由模型完成。历史上的适配 CLI、自动语义审计、事务账本和旧状态恢复已退役，遇到相关旧记录时只读核对。用户明确要求撤销时，按实际差异逐处安全撤销。

**交付目录。**

- 本任务只有一个时间戳。upgrade/ 或 deprecated/ 按真实工程分目录，保存原始扫描、adapted-results-<独立批次ID>.csv、轻量进度和实际证据。
- 各功能根部有且仅有一份 api-adapt-report.html，首页汇总全部参与工程，正文按工程展开。
- 内部资料在任务 .internal 下按功能、工程和扫描尝试隔离。
- 行为另交付 spec.md 和按需生成的 test-report.html。

**报告与结果表。**

- D11/U09 直接调用内置固定报告工具，从任务当前状态共同生成 CSV 和 HTML，保留模板完整样式并从 CSV 生成明细。U08 由 runtime 依据同一次审计直接生成 HTML。三类报告都以 HTML 交付，方法见[HTML 报告](templates/html-reports.md)。
- 新行为扫描及结果 CSV 去掉 Fixed。行为结果依次追加评估结论、处理结论、处理说明、后续事项，设备截图置于末尾。评估结论与报告同源，详细证据保留在进度、分组和报告。

**各种结局都交付。** 零行、全无需修改、待批准、部分完成和停止，都完成本功能的覆盖核对与实际文件交付。用户只查看 spec 并选择不实施时：保留评估分类，处理结论为未实施，源码和配置保持原样，交付完整评估文件；此路径没有修复构建和设备验收。旧记录只读核对，结论在本轮重新取得。

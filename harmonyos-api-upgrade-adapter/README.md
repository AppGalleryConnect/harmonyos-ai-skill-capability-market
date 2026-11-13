# HarmonyOS API 升级适配 Skill

查询和扫描 HarmonyOS API 行为变更，或扫描废弃调用；需要适配时，确认方案后实施，交付逐行结果与 HTML 报告。

## 1 功能概览

| 功能 | 用途 | 适用范围 |
| --- | --- | --- |
| 行为变更 | 查询版本差异，升级 targetSdkVersion 并适配接口、交互和视觉变化 | 查询无需工程和 SDK；适配支持 HAP、指定模块或目录的 HAR，以及相关 C/C++；RNOH 工程额外列出受 RNOH 框架变更影响的 RN 业务 JS 位置，报告单列 RNOH 章节 |
| 废弃 API | 迁移废弃接口，保留低版本兼容 | HAP 及注册模块或目录，不支持独立 HAR 入口 |

建议将行为变更和废弃 API 分开使用，每次明确一种功能及处理范围。Skill 会先评估并展示方案，确认后再修复，也支持只评估不实施。实施修复时，优先推荐仅编译构建，不运行设备测试。完成后提供逐行结果、报告和待办事项。

## 2 环境依赖

| 依赖 | 要求 |
| --- | --- |
| 操作系统 | macOS 或 Windows 10/11 x64 |
| Node.js | 20 或以上 |
| DevEco Studio 与 HarmonyOS SDK | 工具链覆盖目标版本；API26 需 DevEco 26.0.0+，API24 需 6.1.1+。 |
| 设备测试（按需） | 需要模拟器或真机，HAR 还需可运行的宿主工程。行为自动化测试需要 Python 和 Hypium。按仓库锁定的依赖安装时，最低需要 Python 3.12。 |

版本查询仅需 Node.js。

## 3 安装

将完整 Skill 目录复制到开发工具的 skills 目录。扫描器和只读查询工具随 Skill 分发，无需单独安装。以下以 OpenCode 为例。

全局安装，在下载目录的父目录执行：

```sh
mkdir -p ~/.config/opencode/skills
cp -r harmonyos-api-upgrade-adapter ~/.config/opencode/skills/
```

项目级安装，在 HarmonyOS 工程根目录执行：

```sh
mkdir -p .opencode/skills
cp -r "<下载目录>/harmonyos-api-upgrade-adapter" .opencode/skills/
```

| 开发工具 | 全局目录 | 项目级目录 |
| --- | --- | --- |
| OpenCode | ~/.config/opencode/skills/ | <工程>/.opencode/skills/ |
| Codex | ~/.agents/skills/ | <工程>/.agents/skills/ |
| Claude Code | ~/.claude/skills/ | <工程>/.claude/skills/ |

## 4 行为变更

行为变更支持先查询版本差异，再按需扫描和适配工程。只想了解变更时，可直接说“查询 API13 到 API20 有哪些变更”，无需工程或 SDK；结果会标明内置官方快照的覆盖范围。查询边界与示例见[版本变更查询](references/common/changelog-query.md)。

```text
使用harmonyos-api-upgrade-adapter，扫描并适配API行为变更，将targetSdkVersion升级到API26，仅编译构建，不运行设备测试。
```

### 4.1 交互流程

1. 确认工程和目标版本，选择验证方式（见下表）。
2. 扫描或导入 CSV，评估各项变更对业务的影响。
3. 展示 spec.md，确认全部修改、指定部分或暂不修改；需要设备测试时同时确认测试范围。
4. 按批准方案修改。选择前后对比时，先归档修改前的原包。
5. DevEco 规则包有确认未覆盖的条目时，选择是否补充评估，推荐选「否」。选择跳过后，HTML 报告展示未覆盖数量和跳过摘要。
6. 按确认范围完成构建和设备测试，交付结果和未完成项。

| 顺序 | 验证方式 |
| --- | --- |
| 1 | 仅编译构建，不运行设备测试（推荐） |
| 2 | 修改后设备验证（Beta） |
| 3 | 前后对比验证（Beta） |

两个设备验证选项处于试用阶段；已有明确选择时沿用你的要求。只有前后对比验证需要归档修改前的原包。

默认尽量保留升级前体验，compatibleSdkVersion 保持不变；行为流程不复扫。详见[行为完整流程](references/upgrade/upgrade-workflow.md)。

### 4.2 输出文件

| 文件 | 内容 |
| --- | --- |
| `scan-results-<批次ID>.csv` | 原始扫描结果 |
| `adapted-results-<批次ID>.csv` | 逐行评估结论、处理结论、理由与后续事项 |
| `spec.md` | 修改方案与批准范围 |
| `api-adapt-report.html` | 各工程的评估、修改、验证与待办汇总 |
| `test-report.html`（按需） | 设备测试结果、截图及未验证项 |
| `progress.json`、`groups/`、`evidence/` | 进度、详细判断和实际证据 |

api-adapt-report.html 位于 upgrade/ 根部，其余文件位于各工程目录。结果表分开显示评估结论和处理结论。处理结论包括「无需适配」「已适配」「待决策」。设备测试截图附在表末。

## 5 废弃 API

```text
使用harmonyos-api-upgrade-adapter，扫描并迁移废弃API，仅编译构建，不运行设备测试。
```

### 5.1 交互流程

1. 确认应用范围和目标 SDK，核对最低兼容版本。
2. 扫描或导入 CSV，分析替代接口及低版本兼容方案。
3. 展示迁移方案，确认全部修改、指定部分或暂不修改。
4. 实施获批迁移，完整构建并复扫，核对残留调用。
5. 交付结果；仅在你明确要求时验证当前产物，不做修改前后对比。

详见[废弃 API 完整流程](references/deprecated/deprecated-api-adaptation.md)。

### 5.2 输出文件

| 文件 | 内容 |
| --- | --- |
| `apiChange_<任务时间戳>.csv` | 原始废弃 API 扫描结果 |
| `adapted-results-<批次ID>.csv` | 逐行迁移结论、说明与后续事项 |
| `api-adapt-report.html` | 各工程的迁移、构建、复扫与待办汇总 |
| `progress.json`、`groups/`、`evidence/` | 进度、详细判断和实际证据 |

api-adapt-report.html 位于 deprecated/ 根部，其余文件位于各工程目录。

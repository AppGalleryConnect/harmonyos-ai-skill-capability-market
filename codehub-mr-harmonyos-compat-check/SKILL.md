---
name: codehub-mr-harmonyos-compat-check
description: |
  鸿蒙HarmonyOS API兼容性检查技能。提取变更代码（MR变更 review-assets/mr.patch 或本地新增/变更代码 git diff）中使用的
  ArkUI组件方法、API函数，对照SDK声明文件中的 @since 版本，判断是否符合项目设定的最低兼容SDK版本要求。
  当用户输入"使用skill codehub-mr-harmonyos-compat-check 检视代码"、"使用skill codehub-mr-harmonyos-compat-check"、
  "用 codehub-mr-harmonyos-compat-check 检视"、"codehub-mr-harmonyos-compat-check" 等包含本技能名称的指令时，
  必须提取本技能并立即执行（检视当前分支/工作区代码的API兼容性并输出 harmonyos_compat_check_reviews.json）。
  当用户要求"看本地新增代码"、"检视本地新增"、"只看本地变更"时，使用本地新增代码模式（git diff HEAD + 未跟踪新增文件），
  不依赖 review-assets/mr.patch。
  当用户提到"兼容性"、"兼容性检查"、"API兼容"、"SDK版本兼容"、"HarmonyOS兼容"、"函数版本检查"、"compat check"、
  "检查MR兼容性"、"API level检查"、"since版本检查"时触发此技能。
  当用户提供MR变更并需要验证其中使用的API是否符合兼容性要求时，也应触发此技能。
  即使用户未明确提到"兼容性"，只要涉及HarmonyOS API版本与项目兼容版本的比较分析场景，都应使用此技能。
metadata:
  author: AppGallery
  version: 1.1.0
  granularity: functional
  category: code-quality
  tags: harmonyos api-compat since compat-check codehub mr-review
---

# HarmonyOS API 兼容性检查技能

## 概述

本技能用于检查 HarmonyOS 项目中变更代码使用的 API 是否符合项目设定的最低兼容 SDK 版本（`compatibleSdkVersion`）。如果 API 的 `@since` 版本高于兼容版本，则需检查代码中是否有对应的 API Level 守卫判断。

支持两种变更来源（检视模式）：

1. **MR 检视模式**（默认）：读取 `review-assets/mr.patch` 获取 MR 变更内容
2. **本地新增代码模式**：通过 git 获取当前工作区未提交的新增/变更代码。当用户明确要求"看本地新增代码"，或 `review-assets/mr.patch` 缺失但 git 仓库存在未提交变更时使用

## 输入

本技能无需外部输入参数。技能在当前代码仓的当前分支上执行，自动从代码仓配置中获取 SDK 版本信息：

- 变更内容来源（二选一）：
  - `review-assets/mr.patch`（MR 检视模式）
  - git 本地变更：`git diff HEAD` + `git ls-files --others`（本地新增代码模式）
- 通过读取代码仓下 `.cloudbuild/build_config.json` 获取 SDK 版本
- 通过 SDK 版本映射表（`sdk_version_mapping.yaml`）找到本地 SDK 声明文件目录

## 工作流程

```
Step 1: 获取项目兼容版本 + 定位 SDK 声明文件
    ↓
Step 2: 获取变更内容（MR 检视：review-assets/mr.patch；本地新增代码：git diff HEAD + 未跟踪文件）
    ↓
Step 3: 从新增行中提取系统 API 使用（6 类场景 + 过滤非系统 API）
    ↓
Step 4: 在 SDK 声明文件中查找 @since 版本
    ↓
Step 5: 兼容性判断（版本比较 + 上下文守卫检查）
    ↓
Step 6: 输出 harmonyos_compat_check_reviews.json
```

### 步骤 1：获取项目兼容版本与定位 SDK 声明文件

#### 1.1 获取 compatibleSdkVersion

在项目根目录及子模块中查找 `build-profile.json5` 文件，提取 `app.products[].compatibleSdkVersion` 字段。

该字段格式为 `M.S.F(X)`，例如 `5.0.1(13)`，其中括号内的数字 `13` 即为 API Level。

同时提取 `runtimeOS` 字段判断工程类型：
- `runtimeOS: "HarmonyOS"` → 闭源工程，支持开源和闭源两种守卫函数
- `runtimeOS: "OpenHarmony"` → 开源工程，仅支持开源守卫函数

取所有 product 中的最小 API Level 作为兼容性基准。

**文件缺失处理**：如果找不到 `build-profile.json5` 文件，或文件中无 `compatibleSdkVersion` 字段 → 终止检查，报错"无法获取 compatibleSdkVersion，缺少 build-profile.json5 或该文件中无 compatibleSdkVersion 字段"

#### 1.2 获取 SDK_VERSION 并定位 SDK 声明文件

在代码仓根目录查找 `.cloudbuild/build_config.json` 文件，提取以下字段：

1. `buildEnvPrepare.SDK_VERSION` — SDK 版本标识，格式如 `NEXTSDK26.0.0.30_SP30C00`
2. `commandline_tools_version` — command-line-tools 版本号（顶层字段，可能不存在）

**SDK 声明文件目录定位逻辑**：

本地 SDK 声明文件存放在 `/sfs/harmony/sdk-versions/` 下，按 command-line-tools 版本号命名目录。定位顺序：

1. **优先使用 `commandline_tools_version`**：如果 `build_config.json` 中存在 `commandline_tools_version` 字段，且 `/sfs/harmony/sdk-versions/<commandline_tools_version>/` 目录存在，则使用该目录
2. 读取技能目录下的 `sdk_version_mapping.yaml` 映射表（即与 SKILL.md 同目录），用 `SDK_VERSION` 值查找对应的 `sdk_dir`，检查 `/sfs/harmony/sdk-versions/<sdk_dir>/` 目录是否存在
3. **Fallback**：如果以上都失败，使用 `sdk_version_mapping.yaml` 中的 `fallback_sdk_dir`（默认 `6.1.0.760`）

最终 SDK 声明文件路径为：`/sfs/harmony/sdk-versions/<版本目录>/command-line-tools/sdk/default/`

该路径下包含 `openharmony/ets/{component,api,kits}/` 和 `hms/ets/{api,kits}/` 子目录，存放 `.d.ts` / `.d.ets` 声明文件。

> **映射表维护**：`sdk_version_mapping.yaml` 文件记录了 `SDK_VERSION` → `sdk_dir` 的映射关系，当有新的 SDK 版本时，只需更新该文件即可，无需修改技能代码。

### 步骤 2：获取变更内容（MR 检视或本地新增代码）

按以下顺序确定变更来源：

1. **用户明确要求"看本地新增代码"** → 直接使用本地新增代码模式（见下文 2.2），跳过 mr.patch
2. **MR 检视模式**：从当前执行目录下的 `review-assets/mr.patch` 文件读取 MR 变更差异（见下文 2.1）
3. **本地新增代码模式**：`review-assets/mr.patch` 缺失时，如果 git 仓库存在未提交变更，回退到本地新增代码模式（见下文 2.2），不终止检查

#### 2.1 MR 检视模式（review-assets/mr.patch）

`mr.patch` 为标准 unified diff 格式，解析规则：

1. 从 `--- a/` 和 `+++ b/` 行提取变更文件路径（去掉 `a/` 或 `b/` 前缀）。新增文件的 `---` 行为 `/dev/null`，路径以 `+++ b/` 为准
2. 从 `@@ -旧起始,旧行数 +新起始,新行数 @@` 提取差异块行号映射
3. 提取**新增行**（以 `+` 开头的行），行号从差异块头的 `+新起始` 开始递增

仅关注 `.ets` 和 `.ts` 文件的变更，其他文件类型跳过。新增行是本次 MR 引入的代码变更，也是兼容性检查的范围。

**文件缺失处理**：`review-assets/mr.patch` 缺失时，**不直接终止检查**，先检查 git 仓库是否存在未提交变更（`git status --short` 输出非空），存在则切换到本地新增代码模式（2.2）；不存在未提交变更时才终止检查，报错"缺少核心输入 review-assets/mr.patch，且无本地未提交变更"

#### 2.2 本地新增代码模式（git 本地变更）

当用户要求"看本地新增代码"，或 mr.patch 缺失但有本地未提交变更时，使用此模式。变更内容通过 git 命令获取，无需生成 mr.patch 文件：

1. 执行 `git diff HEAD -- '*.ets' '*.ts'` 获取**已跟踪文件**的本地修改（包含 staged + 未 staged 的改动，即相对最近一次 commit 的所有变更；新增文件也包含在内）
2. 执行 `git ls-files --others --exclude-standard` 获取**未跟踪文件**列表，过滤出 `.ets` / `.ts` 文件（如测试文件、新增源码），这些是全新文件，整体视为新增行
3. 合并以上两部分得到本地变更集。变更行号以 git diff 输出的差异块头 `@@ -旧起始,旧行数 +新起始,新行数 @@` 为准（新增行行号从 `+新起始` 递增）；未跟踪文件整体为新增，行号即文件实际行号
4. 仅关注 `.ets` 和 `.ts` 文件的变更，其他文件类型跳过

**检视范围**：只检视本地新增/变更代码，不检视已提交的既有代码。

**守卫判断**：读取 API 调用所在文件的完整内容分析守卫上下文时，以当前工作区文件内容为准（守卫可能在未提交的其它修改中，diff 行号以 git diff 输出为准）。

### 步骤 3：从新增行中提取系统 API 使用

从 diff 的新增行中提取所有 HarmonyOS 系统 API 的使用，分为「识别 API 使用场景」和「过滤非系统 API」两步。

#### 3.1 识别 API 使用场景

根据官方 IDE 的检查范围，需覆盖以下 6 类场景：

1. **API 调用场景**：直接调用方法/函数
   - ArkUI 组件链式调用：`.fontSize(`、`.fontColor(`、`.fallbackLineSpacing(`
   - Modifier 方式调用：`this.textModifier.fallbackLineSpacing(true)`
   - `@ohos.*` 模块方法：`bundleManager.getBundleInfo(...)`

2. **类型注解场景**：将高版本 API 类型用作类型注解
   - 如 `let x: HighVersionType`、`@State modifier: TextModifier`

3. **枚举值场景**：使用高版本引入的枚举值
   - 如 `FontStyle.NewValue`、`ScrollState.Idle`

4. **组件调用场景**：使用高版本引入的 ArkUI 组件
   - 如 `NewComponent({ ... })`、`SubHeaderV2Title({ ... })`

5. **装饰器场景**：使用高版本引入的装饰器
   - 如 `@NewDecorator`
   - 在 SDK 声明文件中搜索装饰器名称，查找其 `@since` 声明。如果装饰器是 ArkUI 框架内置的（如 `@Component`、`@State`），在 `component/common.d.ts` 或 `api/arkui/` 目录下查找

6. **对象字面量属性场景**：在对象字面量或构造函数参数中，使用高版本 API **类型**的实例作为属性值
   - 如 `new SubHeaderV2Title({ primaryTitleModifier: this.modifier })`（`primaryTitleModifier` 属性本身 `@since` 高于兼容版本）
   - 注意：此场景检查的是**属性定义**的 @since，而非 API 返回值的传递。返回值作为参数传递的风险评估见步骤 5.2

#### 3.2 过滤非系统 API

从 3.1 提取结果中，按 API 来源过滤，**不检查**以下来源：
- `@hw-ae-*` 开头的导入（项目内部模块）
- `@hw-ae-business/sdk-facade` 等第三方 SDK 导入（如 `OnScrollListener`、`FlowListController`）
- 项目内部封装方法（如 `Logger.info()`）
- **字符串字面量传递 API 名称**：当高版本 API 名称仅作为字符串字面量出现（如权限名 `'ohos.permission.kernel.SUPPORT_PLUGIN'` 传递给 `grantUriPermission()`），而非实际调用该 API 时，不产出意见。字符串字面量在低版本设备上不会触发运行时错误
- **导入语句本身**：`import { xxx } from '@ohos.xxx'` 语句本身不产生兼容性问题，只有导入的符号被**使用**时才检查。导入高版本 API 但未使用不构成兼容性风险

**需要检查**的系统 API 来源：
- `@kit.*` 导入（如 `@kit.ArkUI`、`@kit.AbilityKit`）— 覆盖场景 1（API 调用）、2（类型注解）、4（组件调用）、6（对象字面量属性）
- `@ohos.*` 导入（如 `@ohos.settings`、`@ohos.bundle.bundleManager`）— 覆盖场景 1（API 调用）、2（类型注解）
- ArkUI 全局类型和枚举（如 `ScrollState`、`FontWeight`、`TextOverflow`）— 覆盖场景 2（类型注解）、3（枚举值）
- ArkUI 组件内置方法（如 `.fontSize()`、`.bindTips()`、`.accessibilityStateDescription()`）— 覆盖场景 1（API 调用）
- ArkUI 组件构造调用（如 `SubHeaderV2Title({ ... })`）— 覆盖场景 4（组件调用）、6（对象字面量属性）

> **注意**：`DeviceInfo.getHarmonyApiLevel()` 是项目内部封装的 API Level 查询方法，不作为被检查的 API，但它是合法的守卫函数（见步骤 5.3）。

### 步骤 4：在 SDK 声明文件中查找 @since 版本

使用步骤 1.2 确定的 SDK 声明文件路径，在其中查找步骤 3 提取的每个 API 的 `@since` 版本。

#### 4.1 查找策略

| API 来源 | 查找位置 | 示例 |
|---|---|---|
| ArkUI 组件方法（`.xxx()`） | `component/` 目录下对应 `.d.ts` | `.fallbackLineSpacing()` → `component/text.d.ts` |
| 通用组件方法 | `component/common.d.ts` | `.bindTips()`、`.accessibilityStateDescription()` |
| `@ohos.*` 模块方法 | `api/@ohos.*.d.ts` | `Settings.openNetworkManagerSettings()` → `api/@ohos.settings.d.ts` |
| `@kit.*` 导入的符号 | 先查 `kits/@kit.*.d.ts` 的 export，再追到 `api/` 中的实际声明 | `TextModifier` from `@kit.ArkUI` → `api/arkui/TextModifier.d.ts` |
| 全局枚举/类型 | `component/` 或 `api/` 目录下对应 `.d.ts` | `ScrollState` → `component/list.d.ts`；`FontWeight` → `component/enum.d.ts` |

> 闭源 API 可能在 HMS SDK 中，查找时同时检查 `hms/ets/{api,kits}/` 目录。

#### 4.2 @since 解析规则

每个方法/属性声明前可能有多个 JSDoc 注释块，每个块对应不同 API 版本的声明。解析规则：

1. **重载 @since 匹配（优先）**：一个方法可能有多个重载声明，每个重载有不同的 `@since` 值。此时**不能取最大值**，而应按以下步骤匹配：
   - 分析调用处的参数数量和参数类型，确定实际调用的是哪个重载
   - 取匹配重载的 `@since` 值作为该 API 的引入版本
   - 示例：`getUIContext()` 在 SDK 中有3个声明（@since 11、@since 12、@since 18），无参数调用应匹配最低 @since（11或12），而非取最大值18
   - 示例：`accessibilityGroup(isGroup)` @since 14，`accessibilityGroup(isGroup, accessibilityOptions)` @since 23 — 根据调用处参数数量匹配
2. **无重载时取唯一 @since**：方法只有一个声明时，直接取该声明的 `@since`
3. **属性 @since**：接口/类的属性有自己的 `@since`，独立于类本身的 `@since`
4. **Modifier 继承**：Modifier 类（如 `TextModifier`）继承自 `TextAttribute`，其方法 `@since` 在父类声明中查找
5. **重载无法匹配时的保守策略**：如果无法确定调用处匹配哪个重载，取所有重载中**最低**的 `@since` 值（保守策略，避免误报）

#### 4.3 API 未在 SDK 声明文件中找到的处理

当在 SDK 声明文件中未找到某个 API 的 `@since` 声明时，按以下策略处理：

1. **枚举值/常量**：如果 API 是枚举值或常量（如 `BundleFlag.GET_BUNDLE_INFO_WITH_COMMON_CLONE`），SDK 中可能未公开 → 严重度最高为 **suggestion**，置信度 0.7
2. **系统内部 API**：如果 API 属于系统内部模块（如 `account_osAccount` 的某些方法），SDK 未公开 → 严重度最高为 **suggestion**，置信度 0.65
3. **HMS 闭源模块方法**：`@hms.*` 模块的方法未在 SDK 中找到 → 严重度最高为 **suggestion**，置信度 0.65
4. **命名空间存在但方法缺失**：如 `uriPermissionManager` 命名空间 @since 10 但 `grantUriPermission()` 方法未在本地 SDK 中声明 → 严重度最高为 **suggestion**，置信度 0.65
5. **完全无法确定 @since**：API 不在 SDK 中且无法推断版本 → 严重度最高为 **suggestion**，置信度 0.6

> **注意**：如果 API 未找到且有 try-catch 包裹，则按步骤 5.3 的 try-catch 完全守卫规则，不产出意见。

### 步骤 5：兼容性判断（结合代码仓上下文）

对步骤 3 提取的每个系统 API，按以下流程判断。守卫判断时需读取完整文件内容分析上下文，不能仅依赖 diff 新增行。

**执行顺序**：5.1 版本比较（含应急 API 格式转换）→ 5.2 使用场景风险评估 → 5.3 上下文守卫检查 → 5.4 判定结论

> **顺序说明**：先评估使用场景（5.2），再检查守卫（5.3）。因为字符串字面量场景无需检查守卫，枚举值/间接使用场景的严重度上限在守卫检查之前就应确定。应急 API 的 @since 格式转换在 5.1 中统一处理。

#### 5.1 版本比较

**应急 API 格式转换**：如果 `@since` 值为闭源版本号格式（如 `5.0.4(16)`），先提取括号内的 API Level 数字（`16`），再进行比较。

> **应急 API 守卫特殊规则**：对于应急 API，闭源工程中开源守卫函数（`deviceInfo.sdkApiVersion`）和闭源守卫函数（`deviceInfo.distributionOSApiVersion`）中**任意一个**匹配即可消除告警。这与普通 API 不同（普通 API 的 `distributionOSApiVersion` 仅适用于闭源工程）。

- 如果 `@since` <= 兼容版本（API Level）→ **兼容，无需处理**
- 如果 `@since` > 兼容版本 → **进入步骤 5.2 评估使用场景**

#### 5.2 使用场景风险评估

不同 API 使用场景在低版本设备上的风险不同，需根据场景调整严重度上限：

| 使用场景 | 低版本行为 | 风险等级 | 严重度上限 |
|---|---|---|---|
| **直接调用**（方法/函数调用） | 运行时 TypeError 崩溃 | 高 | major/fatal |
| **枚举值使用** | 枚举值被忽略，使用默认行为，**不崩溃** | 低 | minor |
| **类型注解** | 类型在运行时不存在，但编译后类型信息被擦除 | 低 | minor |
| **间接 API 使用**（高版本 API 返回值作为参数传递给其他函数） | 接收方可能处理 undefined，风险被间接消解 | 中 | minor |
| **字符串字面量**（API 名称作为字符串传递） | 不触发 API 调用，**无风险** | 无 | 不产出意见 |

> **枚举值场景说明**：使用高版本引入的枚举值（如 `HitTestMode.BLOCK_HIERARCHY` @since 20）在低版本设备上不会导致崩溃，该枚举值会被忽略或使用默认值。因此枚举值场景的严重度最高为 **minor**，不应标记为 major 或 fatal。

> **间接 API 使用说明**：当高版本 API 的返回值仅作为参数传递给其他函数（如 `this.getUIContext()` 传入 `calTitleWidth()`），而非直接调用其方法时，接收函数可能对 undefined 返回值做了容错处理，运行时崩溃风险被间接消解。此类场景严重度最高为 **minor**。

> **场景判定后**：如果场景为"字符串字面量"→ 不产出意见，流程终止。其余场景进入 5.3 检查守卫。

#### 5.3 上下文守卫检查

**不能仅依赖 diff 中的新增行判断守卫**，必须读取完整文件内容，分析 API 调用点的上下文。

**检查步骤**：

1. 读取 API 调用所在文件的完整内容（使用 `read` 工具）
2. 定位 API 调用的行号
3. **向上搜索守卫模式**：检查 API 调用是否在某个守卫条件块内（if 条件、try 块等）
4. **检查同文件内调用链**（最多追溯 2 层）：如果 API 调用所在的函数（如 `aboutToAppear()`）被同文件内其他函数调用，且该 API 调用本身不在守卫块内，则检查调用方函数是否在守卫块内调用此函数。若调用方有守卫 → 通过；若调用方也无守卫 → 报告问题。**追溯深度限制为 2 层**，避免无限递归追溯
5. **检查同文件非调用链守卫**：如果同文件中存在对同一 API 或同类 API 的 API Level 守卫（如文件开头已声明 `if (deviceInfo.sdkApiVersion >= 18)` 并在其中调用了同一 API），即使该守卫不在当前调用链上，记录此信息供 5.4 判定结论使用

> **跨文件守卫限制**：本技能仅检查同文件内的守卫，不检查跨文件守卫（如公共工具类中定义的 `isApiLevelAbove(18)` 函数）。如果守卫在另一个文件中，本技能可能产生误报。在 `suggestion` 中可提示"如已在其他文件中做 API Level 判断，请在此调用点补充守卫"。

**合法守卫模式**（根据官方 IDE 的告警消除机制）：

| 守卫模式 | 适用工程 | 示例 |
|---|---|---|
| `deviceInfo.sdkApiVersion >= X` | 开源 + 闭源 | `if (deviceInfo.sdkApiVersion >= 23)` |
| `deviceInfo.distributionOSApiVersion >= N` | 仅闭源 | `if (deviceInfo.distributionOSApiVersion >= 50004)` |
| `DeviceInfo.getHarmonyApiLevel() >= X` | 项目封装（等效开源） | `if (DeviceInfo.getHarmonyApiLevel() >= 23)` |
| `xxx != undefined` / `xxx !== undefined` | 通用 | `if (someApi.newMethod !== undefined)` |
| `try { ... } catch (e) { ... }` | 通用（完全守卫，不产出意见） | `try { highApi() } catch (e) {}` |
| `canIUse('SystemCapability.xxx')` | 通用 | `if (canIUse('SystemCapability.ArkUI.ArkUI.Full'))` |

**守卫有效性判断**：

1. **版本号匹配**：守卫条件中的版本号必须 >= API 的 `@since` 值
2. **覆盖范围**：守卫必须覆盖高版本 API 的使用点本身。如果守卫只保护了部分调用（如保护了方法调用但未保护属性传递），未覆盖部分仍存在兼容性问题
3. **闭源大整数计算**：`distributionOSApiVersion` 的值需要将 API Level 转换为闭源大整数进行比较。闭源版本号格式为 `M.S.F`，对应大整数为 `M*10000 + S*100 + F*1`。例如 API Level 16 对应闭源版本号 `5.0.4`，计算为 `5*10000 + 0*100 + 4 = 50004`。开源工程使用 `distributionOSApiVersion` **不消除**告警
4. **守卫边界条件**：守卫条件中的版本号可以是数字字面量或变量。若为变量，需追溯变量赋值处确认其值是否 >= `@since`
5. **try-catch 完全守卫**：如果高版本 API 调用被 `try { ... } catch (e) { ... }` 包裹，则视为**完全有效守卫**，兼容性检查通过，**不产出检视意见**。try-catch 能捕获低版本设备上的运行时异常（TypeError 等），防止应用崩溃，因此等效于显式 API Level 守卫

#### 5.4 判定结论

- **字符串字面量传递 API 名称** → ✅ 无运行时风险，不产出意见
- **有正确守卫**（含 try-catch 包裹及其他合法守卫模式通过） → ✅ 兼容性检查通过，不产出意见
- **守卫存在但版本号不匹配**（如守卫 `>= 15` 但 API `@since 18`） → ⚠️ 严重度 suggestion，建议修正守卫版本号
- **同文件存在非调用链守卫** → ⚠️ 严重度降低一级，建议补充当前调用点守卫
- **枚举值使用**（无守卫） → ⚠️ 严重度最高 minor，报告兼容性问题
- **间接 API 使用**（无守卫） → ⚠️ 严重度最高 minor，报告兼容性问题
- **类型注解**（无守卫） → ⚠️ 严重度最高 minor，报告兼容性问题
- **直接调用**（无守卫） → ⚠️ 严重度 major/fatal，报告兼容性问题

### 步骤 6：输出 harmonyos_compat_check_reviews.json

将兼容性检查结果写入 `review-assets/harmonyos_compat_check_reviews.json`，格式遵循 codehub-mr-review 的 ReviewItem 协议。

**写入流程**：

1. 为每个兼容性问题构造 ReviewItem，分配递增 ID（R1, R2, R3, ...）
2. 构造核心字段：
   - `claim`：包含 API 名、`@since` 值、兼容版本、使用场景类型（直接调用/枚举值/间接使用/类型注解）、守卫状态
   - `impact`：描述在低版本设备上的具体后果（运行时崩溃 / 功能不可用 / 属性被忽略）
   - `suggestion`：给出具体守卫代码方案，包含应修改的位置和守卫模式
3. 从 mr.patch 提取 diff_chunk：以 API 调用行为中心，向上向下各取 2-3 行上下文，标记每段代码的 `type`（`added`/`removed`/`context`）
4. 为每条意见构建 evidence_chain（EvidenceItem[]），证据 ID 格式为 `{意见ID}-E{序号}`
5. 写入 `review-assets/harmonyos_compat_check_reviews.json`（纯 JSON 数组）

**审查无问题时写入空数组 `[]`。**

## 输出格式

### harmonyos_compat_check_reviews.json 协议

检视结果写入 `review-assets/harmonyos_compat_check_reviews.json`，顶层结构为 `Array<ReviewItem>`，纯 JSON 数组。

```json
[
  {
    "id": "R1",
    "new_path": "presentation/entry/entryHar/src/default/ets/cards/GuideCard/view.ets",
    "line": 90,
    "claim": "Settings.openNetworkManagerSettings() 方法 @since 18，高于项目兼容版本 API Level 13，代码中未对该调用做 API Level 守卫判断",
    "severity": "major",
    "category": "compatibility",
    "dimension": "D14",
    "impact": "在 API Level 13-17 的设备上调用此方法会导致运行时错误或功能不可用，影响用户在低版本设备上的正常使用",
    "suggestion": "在调用 Settings.openNetworkManagerSettings() 前添加 API Level 守卫：if (deviceInfo.sdkApiVersion >= 18) { Settings.openNetworkManagerSettings(); }",
    "confidence": 0.95,
    "diff_chunk": [
      {
        "file_path": "presentation/entry/entryHar/src/default/ets/cards/GuideCard/view.ets",
        "line_start": 88,
        "line_end": 92,
        "parent_function": "GuideCard.build",
        "type": "added",
        "content": [
          "    .onClick(() => {",
          "      Settings.openNetworkManagerSettings();",
          "      bundleManager.getBundleNameByUid(uid);",
          "    })"
        ]
      }
    ],
    "evidence_chain": [
      {
        "id": "R1-E1",
        "file_path": "presentation/entry/entryHar/src/default/ets/cards/GuideCard/view.ets",
        "line_start": 90,
        "line_end": 90,
        "parent_function": "GuideCard.build",
        "reason": "新增代码直接调用 Settings.openNetworkManagerSettings()，该方法 @since 18",
        "expected_evidence": "diff 中该行为新增行（+号），SDK 声明文件 api/@ohos.settings.d.ts 中该方法标注 @since 18"
      },
      {
        "id": "R1-E2",
        "file_path": "presentation/entry/entryHar/src/default/ets/cards/GuideCard/view.ets",
        "line_start": 85,
        "line_end": 95,
        "parent_function": "GuideCard.build",
        "reason": "向上搜索未发现 deviceInfo.sdkApiVersion >= 18 或其他守卫模式",
        "expected_evidence": "该函数体内无 API Level 守卫判断，调用点未被条件块包裹"
      },
      {
        "id": "R1-E3",
        "file_path": "SDK: openharmony/ets/api/@ohos.settings.d.ts",
        "line_start": 145,
        "line_end": 150,
        "reason": "SDK 声明文件中该方法的 JSDoc 标注 @since 18",
        "expected_evidence": "@ohos.settings.d.ts 中 openNetworkManagerSettings 方法的 JSDoc 包含 @since 18"
      }
    ]
  }
]
```

### 字段说明

**ReviewItem**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 递增编号（R1, R2, R3, ...） |
| `new_path` | string | ✅ | 意见所在的文件路径 |
| `line` | integer | ✅ | 意见所在的目标行号 |
| `claim` | string | ✅ | 问题断言；包含 API 名、`@since` 值、兼容版本、守卫状态 |
| `severity` | string | ❌ | 严重级别，默认 `suggestion`。枚举值：fatal / major / minor / suggestion |
| `category` | string | ✅ | 固定为 `compatibility` |
| `dimension` | string | ✅ | 固定为 `D14`（API 契约稳定性） |
| `impact` | string | ✅ | 业务影响；描述低版本设备上的具体后果 |
| `suggestion` | string | ✅ | 修复建议；给出具体守卫代码方案 |
| `confidence` | float | ✅ | 置信度 0~1 |
| `diff_chunk` | DiffChunk[] | ✅ | 关联代码片段列表 |
| `evidence_chain` | EvidenceItem[] | ✅ | 结构化证据链列表 |

**DiffChunk**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | ✅ | 代码片段所在文件路径 |
| `line_start` | integer | ✅ | 片段起始行号 |
| `line_end` | integer | ✅ | 片段结束行号 |
| `parent_function` | string | ❌ | 归属方法/函数名；方法内代码不可省略 |
| `type` | string | ✅ | `added` / `removed` / `context` |
| `content` | string[] | ❌ | 代码片段实际内容，按行存储 |

**EvidenceItem**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 证据唯一标识，前缀为所属意见 ID（如 `R1-E1`） |
| `file_path` | string | ✅ | 证据所在文件路径 |
| `line_start` | integer | ✅ | 证据起始行号 |
| `line_end` | integer | ✅ | 证据结束行号 |
| `parent_function` | string | ❌ | 归属方法/函数名；方法内代码不可省略 |
| `reason` | string | ✅ | 该证据与问题的关系说明 |
| `expected_evidence` | string | ✅ | 预期可观察到的具体内容，用于验证证据真实性 |

### 严重等级判定

| 等级 | 条件 | 合入决策 |
|------|------|----------|
| **fatal** | API 在低版本设备上必定崩溃且无降级可能（仅限直接调用场景） | 阻塞合入 |
| **major** | API 在低版本设备上功能不可用或可能崩溃，无守卫保护（仅限直接调用场景） | 强烈建议合入前解决 |
| **minor** | API 在低版本设备上可能被忽略（如枚举值、可选属性）；或间接 API 使用（返回值作为参数传递），风险被间接消解 | 建议改进 |
| **suggestion** | 守卫存在但条件不完全匹配，风险极低；或 API 未在 SDK 声明文件中找到，无法确定 @since 版本 | 仅供参考 |

> **场景严重度上限**：
> - 枚举值使用场景：严重度最高为 **minor**（低版本不崩溃，枚举值被忽略）
> - 间接 API 使用场景（返回值作为参数传递）：严重度最高为 **minor**（接收函数可能容错 undefined）
> - 类型注解场景：严重度最高为 **minor**（运行时类型信息被擦除）
> - 字符串字面量场景：**不产出意见**（无 API 调用，无运行时风险）
> - API 未找到时：严重度最高为 **suggestion**（无法确认实际引入版本，误报风险高）

### 约束规则

1. 每个文件的每行代码只能绑定一个检视意见；若一行有多个问题，合并后提交
2. 每条意见的 `id` 全局递增不重复；每条证据的 `id` 前缀必须为所属意见 ID
3. `diff_chunk` 中的代码行必须从 `mr.patch` 提取，`type` 按该片段在 diff 中的角色标记
4. `diff_chunk` 或 `evidence_chain` 中代码片段位于方法内时，`parent_function` 不可省略

## 关键注意事项

- **检查范围**：仅检查 diff 新增行中使用的系统 API，不检查原有代码
- **可选属性也需检查**：即使属性是可选的（`?:` 类型），如果 `@since` > 兼容版本，仍应报告为兼容性问题
- **构造函数参数传递**：在构造函数中传递高版本属性（如 `new SubHeaderV2Title({ primaryTitleModifier: ... })`）同样需要检查守卫

# target 升级后的行为兼容

本页供行为流程 U02、U04、U05、U06、U07、U09 使用：应用升级 `targetSdkVersion`，而 `compatibleSdkVersion` 仍覆盖较低系统时，按官方行为边界保留各系统所需业务。配置与版本背景见[版本契约](../common/sdk-versions.md)，HAR 追加[宿主专题](har-upgrade.md)，具体业务修改示例见[行为代码示例](upgrade-examples.md)。

本页提炼自 2026-08-28 [升级 target 兼容低版本指导](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/app-compatibility-upgrade)及[兼容性关键信息](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/app-compatibility-influence-factor)。适配依据是命中条目的完整官方说明和真实工程，不因 target 高于 compatible 就给所有调用增加分支。

## 行为版本与 target 隔离

分别记录以下事实，不能相互替代：

| 事实 | 用途 |
| --- | --- |
| 接口起始版本 | 说明接口何时存在；不作为行为变化的门槛 |
| 行为变更版本与触发条件 | 判断设备是否具有该变化，以及当前业务是否受影响 |
| 官方 target 隔离门槛 | 仅在官方明确隔离时，结合真实应用或宿主 target 选择语义 |
| compatible 与设备 API | 确认仍需支持哪些系统，以及当前设备实际采用的行为 |

对明确按 target 隔离的变更：

| 设备和 target 条件 | 应理解的行为 |
| --- | --- |
| 设备早于行为变更版本 | 设备保留旧行为；提高 target 不会使旧设备获得新实现 |
| 设备已有变更，真实 target 低于隔离门槛 | 按官方隔离规则采用旧语义 |
| 设备已有变更，真实 target 达到隔离门槛 | 在满足官方触发条件的调用上采用新语义 |

未按 target 隔离的变更，不能靠保持旧 target 规避；仍按设备行为版本和具体影响范围判断。隔离状态未明确时保留证据缺口，不假设存在隔离。

例如接口自API12存在，API14发生行为变化，target升至26而compatible保持13：需要判断的是API13设备上的旧行为与API14及以后设备上的新行为，不能按接口since12统一执行新方案，也不能把行为门槛统一写成目标26。若某条另有target门槛，继续按它的官方条件及实际宿主判断。

## 先判断是否需要版本分支

若原接口已支持的显式参数可以在整个支持范围内保持所需效果，优先直接设置，不增加无意义分支。例如大图确需保留原图解码时显式 `autoResize(false)`；固定小图未触发默认值变化时可无需修改。

只有新旧行为需要不同业务处理时，才按准确设备边界保留原低版本逻辑，并将方案纳入 U05 汇总批准。回调、订阅/取消、初始化及清理跨越同一行为时保持分支和资源身份一致，不能仅保护其中一个调用。

这属于本次行为的跨系统处理，不恢复废弃流程中的通用接口可用性匹配或最低设备任务。保持原 compatible，不新增行为复扫；真实语法、类型和完整构建仍须执行。

## ArkTS 与 C 行为分支

以下片段仅说明**旧格式API14行为边界**，两侧注释须接入工程真实业务。API家族由准确声明和SDK来源确认，判断阈值取该条行为变化版本，而非接口since。

### OpenHarmony 底座接口

确认查询接口本身满足工程最低版本后，ArkTS 使用 `sdkApiVersion`，C 使用 `OH_GetSdkApiVersion()`：

```ts
import { deviceInfo } from '@kit.BasicServicesKit';

if (deviceInfo.sdkApiVersion >= 14) {
  // 执行官方指导要求的 API14 及以后业务处理。
} else {
  // 保留此调用原有的低版本业务。
}
```

```c
#include <deviceinfo.h>

void HandleBaseBehavior(void) {
    if (OH_GetSdkApiVersion() >= 14) {
        // 执行该行为变化后的业务处理。
    } else {
        // 保留原业务。
    }
}
```

### HarmonyOS 专有接口

旧格式 `5.0.2(14)` 的平台版本数值为 `50002`。ArkTS 使用 `distributionOSApiVersion`，C 使用 `OH_GetDistributionOSApiVersion()`：

```ts
import { deviceInfo } from '@kit.BasicServicesKit';

if (deviceInfo.distributionOSApiVersion >= 50002) {
  // 执行该专有接口在 5.0.2(14) 变化后的业务处理。
} else {
  // 保留原业务。
}
```

```c
#include <deviceinfo.h>

void HandleDistributionBehavior(void) {
    if (OH_GetDistributionOSApiVersion() >= 50002) {
        // 执行该行为变化后的业务处理。
    } else {
        // 保留原业务。
    }
}
```

`50002` 不是 API Level14，不能与 `sdkApiVersion` 互换。设备属性只解释设备行为；HAR 的宿主 target 仍按[宿主专题](har-upgrade.md#宿主-target-与初始化)另行取得。

### API26 及以后的机制选择

先核对行为版本的粒度、实际SDK属性的含义及工程最低版本。不能把旧平台编码、只比较主版本或旧 `targetVersion % 100` 当作适用于后续所有版本的规则；同一主版本内的变化尤其不能只看主版本。

`sdkMinorApiVersion`、`sdkPatchApiVersion` 自身也从26.0.0引入，不能直接加到compatible13的公共判断路径中。新增版本查询属性与查询函数一样，先核对其自身门槛。

本流程新增 `apiAvailable`、`@Available`、`@SuppressWarnings` 时，同样要求 compatible 满足各自起始版本（分别为26.0.0、API22、API23），并核对配套工具链。compile/target=26、compatible=13时，不能直接调用 `apiAvailable` 来判断设备，也不能用它保护自身。使用最低版本已支持且能准确表达行为边界的属性或既有判断；没有足够版本证据时保留 EVIDENCE_GAP，不猜公式、不提高 compatible。上述机制的完整语法只在[API 保护专题](../common/compatibility.md#先检查保护机制自身的版本)维护，行为无需整体加载废弃迁移规则。

C/C++ 的设备行为判断也不消除高版本符号的加载风险；不因行为任务自动启用弱引用或改写链接方案。若新方案依赖额外高版本能力，先明确能否在当前支持范围实施，存在缺口时调整方案或保留具体问题，不能把版本 `if` 当作加载安全证明。

## 记录与验证边界

U04 在现有 reason/evidence 中评估行为版本、target隔离、实际设备范围和分支必要性；U05汇总spec并取得批准，U06实施，U07复核两侧语义、真实target及compatible未变。无需分支时说明显式参数或原调用为何覆盖所需业务。

U09使用现有 `files.compatibility` 和报告记录完整兼容结论；行为CSV只在处理说明中写相关修改、作用及理由，未解决或待人工验证的事项写入后续事项，不追加兼容性说明列或新状态。存在跨系统差异时写清已处理内容与尚缺证据；没有相关差异时不强制逐API生成兼容性清单。

设备操作继续使用用户已选范围和授权。只做高版本设备验证时，低版本运行写未验证；未选设备不启动或安装。已有授权明确覆盖行为边界时，分别保存各系统实际结果；同设备同系统的before/after对比只证明该系统上的变化，不能代替跨系统覆盖，也不为此自动增加最低系统矩阵。

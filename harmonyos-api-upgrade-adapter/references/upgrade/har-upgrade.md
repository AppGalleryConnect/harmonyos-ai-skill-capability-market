# HAR 行为适配与宿主集成

本页供行为流程处理三方 HAR 被不同宿主集成时的特殊性。U01/U02确定库范围和扫描基线，U04/U05分析宿主差异并确认spec，U06归档所选原包及修复，U07/U08组织库、宿主构建及功能证据。通用设备行为边界与分支选择见[target 升级兼容](upgrade-compatibility.md)，本页不重复 API 保护机制或建立通用接口可用性匹配任务。

## 范围与版本

读取含products和模块注册的真实工程，确认HAR类型；scanner使用project-type har和明确scan-module/scan-dir，同类选择并集、不同类型交集，可支持已注册工程外模块。没有授权不扩大到宿主源码，联合升级分别保存原始输入、范围、计划和结果。

库历史已适配from显式提供，可早于当前构建target；已target26可用原from20补齐行为，不回退配置。真实编译SDK、库target、宿主target、扫描基线与实际运行系统分别记录，不将其中任一项代替其余事实。

## 宿主 target 与初始化

HAR 合入应用后使用真实宿主 target。即使库构建 target=14，宿主 target=13 与14也可能使同一条已隔离行为呈现不同语义；库构建 target不证明已触发变化，历史已适配from也不能代替宿主target。若库公开契约要求一致行为，优先由库对实际宿主差异进行归一；不能无条件把新行为处理套给旧语义。无法在库内完成时明确应用侧所需调整及授权范围。

需要运行时查询时，从真实 `getBundleInfoForSelf` 返回的 `BundleInfo.targetVersion` 取得值。例如以下片段只获取原始target，失败由Promise向调用方传播：

```ts
import { bundleManager } from '@kit.AbilityKit';

async function readHostTargetVersion(): Promise<number> {
  const info = await bundleManager.getBundleInfoForSelf(
    bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION
  );
  return info.targetVersion;
}
```

读取接口和标志本身按实际SDK及最低版本核对。复用库内已有初始化，在首次消费前等待完成，并按工程约定协调并发初始化和缓存。查询失败保留公开失败/恢复契约，不能将未就绪0或猜测target带入业务判断。按真实SDK返回编码解释门槛，不硬编码26，也不把官方旧样例的 `targetVersion % 100` 当成通用解码。

设备具备新行为与宿主target达到隔离门槛分别判断，不能只查其中一项。通过新旧宿主测试归一结果时，也须满足[target 升级兼容](upgrade-compatibility.md#行为版本与-target-隔离)中的设备条件。

## 集成版本约束

以下规则提炼自 2026-08-28 [三方 HAR 兼容指导](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/app-compatibility-third-har)，集成时回读库元数据、宿主配置和真实工具链：

| 信息 | 需要核对的约束 |
| --- | --- |
| 源码 HAR 的 compile | 应用编译 SDK 不低于库编译 SDK |
| 字节码 HAR 的 compile | 不套用源码 HAR 的同一版本比较限制；仍核对实际字节码、工具链和原生 ABI 要求 |
| compatible | 应用 compatible 不低于库声明的 compatible；库内部版本分支不能消除打包约束 |
| target | 合入后的行为按真实宿主 target 判断，不能用库 target 替代 |

例如应用compatible12、库compatible13时，不能仅加一个运行时 `if` 解决集成错误。保持库/宿主原compatible，说明真实冲突和支持范围；需要调整依赖或配置时纳入获批方案，不自动提高应用compatible或无依据把库改成12。缺少依赖源码时保留边界，不擅自修改第三方包。

集成态HSP只作为现有依赖关系知识，不新增独立扫描入口；其包可有独立target，不能一律套宿主值。实际包关系见[集成态 HSP 官方说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/app-compatibility-share-hsp)。

## 构建与宿主消费

1. 每次构建（含 before/after）先在库工程根执行 ohpm install，成功后 U07 按真实注册target对所选库assembleHar，保留本次产物、日志和退出码，纯库不运行assembleApp。
2. 核对根/模块oh-package及实际解析依赖；源码依赖证明物理位置是本次库，HAR文件依赖核对路径与字节哈希，再按授权同步本地副本。不能只改声明却继续消费旧oh_modules内容。
3. 更新并核对 HAR 后，在宿主工程根重新执行 ohpm install，即使 oh_modules 已存在也执行；安装失败不启动宿主构建。明确唯一宿主product/entry及实际安装条件（模拟器无需签名流程，真机使用已有签名产物），真实构建宿主HAP，分别保存库/宿主输入状态、命令、日志及产物。宿主编译成功不自动证明实际消费本次库。
4. 已选择设备验证时安装当前宿主包，核对真实业务调用/返回/回调到库的路径并关联rowIds；有多个已授权宿主组合时分别记录target、设备和结果，不用同页截图泛称覆盖，不自动增加最低系统矩阵。

多入口明确实际选择，独立宿主由用户提供或真实依赖确定，不猜相邻Demo。缺宿主仍可交付库构建事实及未执行范围，依赖/签名/安装失败与库已编译分别表达。

## 行为对比与联合任务

只有行为任务选择对比才在修改前真实构建并归档原库及实际消费它的宿主 before 包，不能用 HAR 文件代替可运行宿主。修改前从CSV调用点保留白盒路径和源码事实，修复后生成并冻结规格、用例和脚本，先测试归档 before，再复位数据测试 after；库消费关系、同设备系统、同语义用例和可复位数据须可核对，缺基线不回退工程补造。取证方法见[行为对比](../common/runtime-functional-tests.md#行为前后对比)。

共用工程/product时协调原配置与源码基线，影响行为基线的修改须等待原包有效归档或用户明确改为其他验证方式；原包已归档后设备不可用只影响测试，不再阻塞修复。实际一次宿主测试可分别关联库/应用，但须说明具体消费关系、阶段与原始行，不恢复自动联动状态机或构建缓存。

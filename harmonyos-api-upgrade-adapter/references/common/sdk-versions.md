# SDK 版本与扫描参数

## 配置、设备与打包字段

| 信息 | 工程字段 | 打包字段 | 判断用途 |
| --- | --- | --- | --- |
| 编译 SDK | `compileSdkVersion` | `compileSdkVersion` | 提供声明与工具链；核对实际使用的 SDK，不能仅看配置 |
| 目标版本 | `targetSdkVersion` | `targetAPIVersion` | 系统对明确按 target 隔离的行为选择新旧语义 |
| 最低兼容版本 | `compatibleSdkVersion` | `minAPIVersion` | 安装门槛；设备 API 低于包中最低要求时不能安装 |
| 设备 API | 不属于工程配置 | 不由应用包设定 | 当前系统实际提供的能力与行为版本 |

保持 `compatible ≤ target ≤ 实际编译 SDK`，按实际 API 版本顺序比较，不比较版本字符串的字典序。回读所选 product 和最终包，确认没有采用其他 product 或默认值。升级编译 SDK 不要求同步抬高 target；按主流程保留未要求改变的 compatible，不降低原 target/compatible。降低安装门槛不能补齐旧系统缺失的能力。

API26 起采用 `X.Y.Z` 语义化格式；此前 HarmonyOS 常用 `X.Y.Z(N)`，OpenHarmony 常用 API Level `N`。例如 `26.0.0` 晚于 `6.1.1(24)`，不能把 `6` 与 `26` 当成同一家族主版本直接比较。配置值与下文 scanner 的精确阶段表达式分别处理。

## API 家族与设备查询

按准确声明及 SDK 所属路径区分 OpenHarmony 底座与 HarmonyOS 专有接口。旧格式下，底座 `since N` 对应 `deviceInfo.sdkApiVersion`；专有 `since X.Y.Z(N)` 对应 `distributionOSApiVersion` 的平台版本。旧平台数值按 `X * 10000 + Y * 100 + Z` 编码，例如 `5.0.2` 对应 `50002`，不能与 API Level `14` 直接比较。此编码仅用于已核实采用该定义的字段和旧格式，不推广到 API26 及以后的字段或返回值。

设备“设置 → 关于本机”应查 **API 版本**，也可对明确设备使用 HDC 查询 `const.ohos.apiversion`、`const.product.os.dist.apiname`、`const.product.os.dist.apiversion`，或读取真实 deviceInfo 属性。面向消费者的 ROM 版本以及 `distributionOSVersion`、`displayVersion`、设备型号不能证明 API 版本。查询接口本身也须在工程最低版本可用。

废弃迁移的调用保护见[API 兼容保护](compatibility.md)；行为变化及设备边界见[target 升级兼容](../upgrade/upgrade-compatibility.md)，行为门槛不能从接口 since 推导。设备支持范围结合实际业务和设备证据决定；[设备支持查询](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/support-device)与[设备 API 分布查询](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/sdk-version-percentage)只作当次参考，记录查询时间。

以上版本背景提炼自 2026-08-28 官方快照：[兼容性介绍](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/app-compatibility-intro)、[兼容性关键信息](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/app-compatibility-influence-factor)、[API26 版本格式](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/version-number-26)。具体属性和工具能力仍核对实际 SDK。

## 配置与扫描

配置版本不含 SDK 通道。SDK 26.0.0 Beta1、Beta2、Release 均可写入 `targetSdkVersion: "26.0.0"`。配置覆盖、宿主覆盖和运行范围不得用 Beta/Release 排序拒绝同平台 target。

扫描参数包含精确通道。同 API 默认起点按 Beta 数字升序后 Release；终点反向选择，并受工具链真实 SDK 上限约束。显式完整 from/to 不自动重选，超出 SDK 上限则拒绝扫描，不能静默降级。

| SDK | 用户输入 | 配置 target | 精确 from | 精确 to |
|---|---|---|---|---|
| 26.0.0 Beta1 | 22 → 26 | 26.0.0 | 6.0.2(22) Beta1 | 26.0.0(26) Beta1 |
| 26.0.0 Beta2 | 23 → 26 | 26.0.0 | 6.1.0(23) Beta1 | 26.0.0(26) Beta2 |
| 26.0.0 Release | 23 → 26 | 26.0.0 | 6.1.0(23) Beta1 | 26.0.0(26) Release |

内置目录来自 DevEco 26.0.0.821 的规则目录和 project-api-change-assistant JAR，两份版本清单一致，共 30 个精确版本，来源清单和版本数据均带 SHA256。运行时合并当前工具链目录及 JAR 发现的版本。API13 从 Beta3 开始，API20 包含 Beta5；不能编造 Beta4 或当前目录没有的 API25。目录不代表全部历史 SDK 发版。

运行记录和报告分别保留 `configuredTargetSdkVersion`、`scanFromSdkVersion`、`scanToSdkVersion`、`compileSdkVersion`、原始输入和解析依据。HAR 已配置 target26 时仍可提供原适配基线 `--from 22`，无需回退工程配置；通道展开后的 from 必须小于 to。

## 可选扫描版本列表

下表按时间顺序列出内置规则目录支持的 30 个精确版本，供 `--from`、`--to` 使用。扫描区间为 `(from,to]`；配置 target 不带通道，扫描终点仍受本机实际 SDK 和规则包覆盖限制。运行时还会发现当前工具链提供的版本。

| 序号 | 精确扫描版本 | 说明 |
| --- | --- | --- |
| 1 | `5.0.1(13) Beta3` | API 13 Beta3 |
| 2 | `5.0.1(13) Release` | API 13 Release |
| 3 | `5.0.2(14) Beta1` | API 14 Beta1 |
| 4 | `5.0.2(14) Release` | API 14 Release |
| 5 | `5.0.3(15) Beta1` | API 15 Beta1 |
| 6 | `5.0.3(15) Beta2` | API 15 Beta2 |
| 7 | `5.0.3(15) Release` | API 15 Release |
| 8 | `5.0.4(16) Release` | API 16 Release |
| 9 | `5.0.5(17) Beta1` | API 17 Beta1 |
| 10 | `5.0.5(17) Release` | API 17 Release |
| 11 | `5.1.0(18) Release` | API 18 Release |
| 12 | `5.1.1(19) Beta1` | API 19 Beta1 |
| 13 | `5.1.1(19) Release` | API 19 Release |
| 14 | `6.0.0(20) Beta1` | API 20 Beta1 |
| 15 | `6.0.0(20) Beta2` | API 20 Beta2 |
| 16 | `6.0.0(20) Beta3` | API 20 Beta3 |
| 17 | `6.0.0(20) Beta5` | API 20 Beta5 |
| 18 | `6.0.0(20) Release` | API 20 Release |
| 19 | `6.0.1(21) Beta1` | API 21 Beta1 |
| 20 | `6.0.1(21) Release` | API 21 Release |
| 21 | `6.0.2(22) Beta1` | API 22 Beta1 |
| 22 | `6.0.2(22) Release` | API 22 Release |
| 23 | `6.1.0(23) Beta1` | API 23 Beta1 |
| 24 | `6.1.0(23) Beta2` | API 23 Beta2 |
| 25 | `6.1.0(23) Release` | API 23 Release |
| 26 | `6.1.1(24) Beta1` | API 24 Beta1 |
| 27 | `6.1.1(24) Release` | API 24 Release |
| 28 | `26.0.0(26) Beta1` | API 26 Beta1 |
| 29 | `26.0.0(26) Beta2` | API 26 Beta2 |
| 30 | `26.0.0(26) Release` | API 26 Release |

# API 兼容性保护与告警屏蔽

废弃 API 迁移按本页选择接口保护、告警处理和低版本回退；target 升级引起的行为差异见[升级兼容专题](../upgrade/upgrade-compatibility.md)。本页不编排行为适配步骤。配置字段、版本格式、API 家族和设备查询统一见[版本契约](sdk-versions.md)。

本页提炼自 2026-08-28 官方兼容性指导快照。机制的起始版本以准确 SDK 声明为准，编译器与 IDE 须配套；样例只表达保护方式，业务回退必须替换为工程原有的真实处理。

## 先检查保护机制自身的版本

本流程新增使用兼容性 API 和源码注解时，**compatibleSdkVersion 必须达到该机制自身的起始版本**，并且实际编译 SDK、编译器和 IDE 均支持。仅 compile/target 达到 API23 或 API26 不满足选用条件；不能为了使用保护机制提高 compatible。

| 机制 | 自身起始版本及本流程 compatible 门槛 | 其他条件与作用 |
| --- | --- | --- |
| `deviceInfo.apiAvailable` | `26.0.0`，compatible ≥ `26.0.0` | 真实设备版本判断；核对 SDK 声明和编译器识别范围 |
| `@Available` | API22，compatible ≥ API22 | 源码级版本声明，参与编辑/编译检查，不生成运行时分支 |
| `@SuppressWarnings`、`SuppressWarningsType.COMPATIBILITY` | API23，compatible ≥ API23 | 兼容告警屏蔽还要求支持该能力的工具链；快照为 DevEco Studio 6.1.0 Beta2 起 |

上表是本流程的选用约束；源码注解的编译检查作用与运行时能力分开理解。C/C++ 的 `APIAVAILABLE` 宏、弱引用和弱库按下文的编译器与加载规则选择，不统一套用 ArkTS API 的门槛。

例如 compile/target=26、compatible=13 时，不新增 `apiAvailable`、`@Available` 或 `@SuppressWarnings` 来保护 API18。应按准确家族使用最低版本已支持的 `sdkApiVersion` 或 `distributionOSApiVersion`，分别核验查询属性自身的 since，保留旧业务。不能用 `apiAvailable` 调用自身来证明它在旧设备可用，也不能用屏蔽告警替代实际保护。

## ArkTS 接口保护

### compatible 较低时使用已有版本属性

底座接口按 `deviceInfo.sdkApiVersion` 判断；旧格式 HarmonyOS 专有接口按 `deviceInfo.distributionOSApiVersion` 判断，家族与编码见[版本契约](sdk-versions.md#api-家族与设备查询)。以下以已经核实属于底座、API18 起可用的替代能力为例，适用于查询属性已满足工程最低版本的场景：

```ts
import { deviceInfo } from '@kit.BasicServicesKit';

if (deviceInfo.sdkApiVersion >= 18) {
  // 执行已核实 API18 起可用的替代调用。
} else {
  // 保留工程原有的低版本业务。
}
```

### apiAvailable 的参数与识别边界

仅在上表门槛满足时使用 `deviceInfo.apiAvailable(version: string | number): boolean`。入参是**被保护能力的版本**，与该查询 API 自身的起始版本是两项事实。

| 被保护版本 | 参数示例与限制 |
| --- | --- |
| API26 及以后 | `'26.0.0'`；语义化 `X.Y.Z`，`0 ≤ Y,Z ≤ 99`，OpenHarmony 要求 `X ≥ 26` |
| API26 前 OpenHarmony 底座 | 整数字面量，如 `22`，范围 `0 < X < 26`；不把整数 `26` 当通用写法 |
| API26 前 HarmonyOS 专有接口 | 如 `'5.0.1'` 或 `'5.0.1(13)'`；主版本小于26时须是工具链支持的 HarmonyOS 版本 |

下例仅展示 compatible ≥ 26.0.0 且工具链支持时的直接 `if` 写法：

```ts
import { deviceInfo } from '@kit.BasicServicesKit';

if (deviceInfo.apiAvailable('26.0.0')) {
  // 执行该版本可用的能力。
} else {
  // 按业务保留必要的回退。
}
```

快照中的告警消除只识别直接传版本字面量的 `if`，不识别变量版本参数、缓存布尔结果、自定义封装、三元表达式或 `&&`、`||`、`!` 复合条件。例如：

```ts
const available: boolean = deviceInfo.apiAvailable('26.0.0');
if (available) {
  // 不能据此声称编译器已识别保护。
}
```

这是兼容检查的识别限制，不等于普通布尔运算无效；变量版本参数还可能触发编译诊断。需要业务条件时先直接判断版本，再在分支内判断业务，并执行实际检查。

依据：[ArkTS API 兼容保护](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/arkts-api-compatibility-warning-elim)、[apiAvailable 参考](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-device-info#deviceinfoapiavailable)。

## 版本注解与告警屏蔽

### @Available 声明约束

仅在 compatible ≥ API22 且工具链支持时新增此注解。它将最低版本约束传给调用方，不执行运行时分支或生成回退。下面只展示源码声明：

```ts
import { Available } from '@kit.BasicServicesKit';

@Available({ minApiVersion: 'OpenHarmony 22' })
class Feature22 {}
```

可标注变量、类型、函数、命名空间、注解声明及 struct/class/interface 成员，不能标注任意 `if`、调用等非声明语句。HarmonyOS 工程支持如 `'22'`、`'OpenHarmony 22'`、`'HarmonyOS 6.0.2'`；API26 语义格式如 `'26.0.0'` 还须核对工具链支持。OpenHarmony 工程不能标为 HarmonyOS。注解参数表示被标注声明的最低可用版本，不改变工程 compatible，也不证明调用方设备安全。

### 局部屏蔽告警

只有已有充分保护但工具不能识别时，才按上表 API23 门槛和配套工具能力选择屏蔽，并记录局部理由。屏蔽只改变诊断，不补齐 API 或业务回退；不能批量屏蔽后宣称适配完成。

声明注解写法：

```ts
import { SuppressWarnings, SuppressWarningsType } from '@kit.BasicServicesKit';

@SuppressWarnings({ rules: [SuppressWarningsType.COMPATIBILITY] })
function protectedBusiness(): void {
  // 此处必须已有真实保护；注解不替代它。
}
```

非声明元素使用告警行上方的单行注释，不能把注解表达式原样当作单行屏蔽语法：

```ts
// @SuppressWarnings compatibility
```

将该指令紧贴实际告警调用行的上方。它是工具指令，不是运行时 API；本流程同样仅在 compatible ≥ API23 且支持该屏蔽能力时新增。不得为了屏蔽而扩大声明范围或删除告警所提示的业务分支。

依据：[ArkTS 注解说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/arkts-api-compatibility-warning-elim)、[兼容性告警屏蔽](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/compatibility-warning-suppress)。

## UI 自定义组件隔离

版本相关的装饰器和状态管理需要隔离组件实现，在**创建组件的位置**选择，不能只保护同一个高版本组件内部的方法调用。

例如 API18 的 `@ReusableV2` 方案兼容 API12：分别提供高版本 `ReuseComponentV2` 与低版本 `V1Component`，在 `LazyForEach` 的创建处按真实底座 API 选择。以下为创建片段，两个组件由工程按对应声明实现：

```ts
if (deviceInfo.sdkApiVersion >= 18) {
  ReuseComponentV2({ num: item })
} else {
  V1Component({ num: item })
}
```

公共显示可抽取复用；低版本路径自身不能依赖不支持的装饰器、状态模型或初始化。分别检查两侧的显示、状态更新、复用与生命周期；编译通过或页面可打开不能替代这些证据。

依据：[UI 自定义组件兼容指导](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/app-compatibility-ui-component)。

## 迁移调用的版本与回退

旧接口 since、deprecated since、替代接口 since 分别核对到接收者、成员、参数及重载。不能因旧接口在API18废弃，就给实际自API10/11可用的替代链统一加18分支；错误码、atomicservice、crossplatform 标签不代替 since。

替代调用及每个新增获取链、参数类型、枚举、回调能力分别核实最低版本，组合路径满足全部实际门槛。高于 compatible 时选择最低版本可用的保护机制，保留原有非空业务回退，不提高 compatible 或删除仍支持设备的逻辑。

订阅、取消及读取按同一生命周期核对接收者、回调身份和保护分支，不只保护一半。合法低版本回退可能仍被扫描命中，按废弃流程解释，不能为清零删除。模型复核、真实检查和设备事实分别记录，方法见[验证](verification.md#废弃迁移兼容复核)和[单次设备验证](runtime-functional-tests.md#废弃单次设备验证)。

## 原生低版本兼容参考

以下知识用于废弃迁移涉及的原生调用保护；行为任务的 C/C++ 版本分支见[target 升级兼容](../upgrade/upgrade-compatibility.md#arkts-与-c-行为分支)，不因行为适配自动启用弱引用。

### 加载与符号保护

版本概念按[版本契约](sdk-versions.md)。下面的原生规则提炼自 2026-08-28 官方快照，工具链条件必须在真实 SDK/IDE 上核实。

默认 C API 引用为强引用。动态加载器可能在库加载时就解析符号，旧设备缺少符号会在业务分支执行前中止应用；仅在强引用调用外加设备版本 `if` 不能消除加载风险。

#### 显式加载与查询

`dlopen` 检查库是否成功加载，`dlsym` 检查准确符号是否存在，再通过与 SDK 声明完全一致的函数指针调用。库不存在和符号不存在都保留原业务回退；不能在其他初始化或调用点继续强引用同一高版本符号。

下面是基于官方定位接口的加载片段，类型、头文件和 `requestConfig` 来自真实 SDK 与工程；失败分支须接入实际回退，不可直接复制空处理：

```c
void *handle = dlopen("liblocation_ndk.so", RTLD_LAZY);
if (handle != NULL) {
    typedef Location_ResultCode (*StartLocating)(const Location_RequestConfig *);
    StartLocating startLocating = (StartLocating)dlsym(handle, "OH_Location_StartLocating");
    if (startLocating != NULL) {
        Location_ResultCode result = startLocating(requestConfig);
        // 按原契约处理 result，并保存 handle 的所有权。
    } else {
        // 符号缺失：执行既有低版本方案。
    }
} else {
    // 库加载失败：执行既有低版本方案。
}
```

句柄须活到最后一次函数指针调用及相关异步操作/回调完成，随后由明确的所有者 `dlclose`；失败路径也须释放已取得且不再使用的句柄。不能查完符号立即关闭库，或把临时指针保存到已卸载库之外。符号存在仍需满足权限、设备能力及接口业务前置条件。

依据：[C API 兼容保护](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/c-api-compatibility-warning-elim)。

#### 弱引用、弱库与 APIAVAILABLE

SDK API22 起的快照方案允许配套编译器启用 C API 弱引用，未解析的弱符号可以为空，因此仍须用准确的可用性保护和回退。弱符号解决“库中缺符号”；当整个依赖库在旧设备上不存在时，还要核对弱库机制。快照明确 **API22 以下设备不支持弱库**，这不是所有弱符号方案的统一设备下限；支持更低设备时应评估显式加载等可用方案。

快照中的 Hvigor 配套条件如下，不能据此假定后续 IDE 都沿用同样参数：

| DevEco Studio 条件 | 快照中的配置要求 |
| --- | --- |
| 大于 `6.0.2.640 Release`，且不是 `6.1.0.830` | 模块 `build-profile.json5` 的原生编译参数传入 `-DOHOS_COMPATIBLE_SDK_VERSION=x.x.x` |
| `6.1.0.830` | 自动根据工程 compatible 开启；已有显式参数必须同步 compatible，或在确认支持后移除 |

上述旧格式 `HarmonyOS X.Y.Z(N)` 或 OpenHarmony `N` 将最低兼容版本传为 `N.0.0`，如 `6.0.2(22)` 对应 `22.0.0`。该映射不作为 API26 及以后编码的通用规则；检查真实构建参数，避免工程 compatible 已变而 LLVM 目标仍旧。

`APIAVAILABLE` 是 `__builtin_available` 的封装。从真实 SDK 引入提供它的头文件，确认宏与编译器可用后，按准确接口版本使用，例如以下 API22 门槛片段：

```c
if (APIAVAILABLE(22, 0, 0)) {
    // 调用已核实在此门槛可用的新接口。
} else {
    // 保留低版本业务。
}
```

按真实头文件的家族与版本映射选阈值，不能把行为变更版本当接口 since，也不能自行复制宏冒充工具链支持。

依赖库必须完整：

- 系统旧版本已有库但缺少新符号时，仍在 `target_link_libraries` 配置该 API 的真实依赖，不能只启用弱引用。
- 整库在旧系统不存在且设备支持弱库时，同时配置真实链接依赖及 `-Wl,--ohos-weak-library=libxxx.so`；库名按 SDK 确认，不只加 weak 标记。
- 弱引用可能掩盖漏配依赖。按真实构建能力临时关闭弱化检查链接，确认依赖齐全后恢复配置；这一步不能代替设备上实际调用验证。

非 Hvigor（如 Bazel）构建同样须把 compatible 传到 LLVM，并核对 `-Wunguarded-availability` 和 `libdeviceinfo_ndk.z.so` 依赖。快照的 `--target=aarch64-linux-ohosx.x.x` 只是单 ABI 示例，其中旧版本映射同上；按工程各 ABI 的真实目标三元组处理，不固定 aarch64，不丢弃其他 ABI。保存 `compile_commands`/`build.ninja` 等实际传参证据。

依据：[C API 兼容保护高阶用法](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/c-api-compatibility-warning)。

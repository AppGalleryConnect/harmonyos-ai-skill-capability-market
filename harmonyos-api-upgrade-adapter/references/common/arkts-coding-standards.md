# ArkTS 编码规范

修改 ArkTS 或 ArkUI 前阅读，修改后按实际差异复核。按当前主流程指定范围使用本页；已有无关风格问题不扩大整改。真实编译要求见[完整构建与产物](verification.md#完整构建与产物)。

## 项目约定与作用域

- 先读取工程 AGENTS、formatter/linter 配置及邻近实现，保留公开接口、框架规定名称和现有依赖边界。项目具体约定优先于下面的通用格式；兼容性与真实验证仍须满足主流程要求。
- 生产源码检查命名、格式、类型、API 安全、资源、常量、日志与异常。ohosTest 和本地测试同样保持类型与 API 安全，但不机械提取等待时间、断言值或夹具数据，不开展无关颜色整改。
- 所选 SDK 声明、ArkTSCheck 和构建输出决定接口、类型与语法是否可用。不用普通 TypeScript 工具通过代替目标 SDK 的检查，也不要求安装其他 Skill 或新工具才能阅读规则。

## 命名与格式

- 类、接口、枚举、组件及类型使用 PascalCase；变量、字段、函数和参数使用 camelCase；常量及枚举值使用 UPPER_SNAKE_CASE；自定义组件 id 使用 kebab-case。遵守项目及框架已有的必要例外，不改名破坏消费者。
- 名称表达业务意图；布尔值使用 is/has/can/should 等明确前缀，避免拼音、无上下文缩写和双重否定。
- 优先遵循工程 formatter 与邻近代码。没有规定时，默认空格缩进2格、续行4格、单引号、120列；URL、命令和不可拆分的错误信息可例外。
- 对象属性超过4个时逐项换行；不在同一行声明多个变量。控制语句使用大括号，保持 `} else {`、`} catch {`，运算符与逗号留适当空格，不手工用连续空格对齐。
- 注释解释版本限制、生命周期或业务原因；修改行为时更新失效注释，不复制与实现不符的迁移说明。

## 类型、语法与 ArkUI

- 使用所选 SDK 支持的准确类型、参数和返回形态，保持强类型；普通数组优先 `T[]`。只有真实互操作边界需要时才使用 SDK 允许的 any/ESObject，并说明边界，不能用宽泛类型或不安全断言消除真实错误。
- 对可空值先核对来源并在有效控制流中收窄，不以非空断言、虚构空对象或默认成功值掩盖获取失败。
- 构造器按 SDK 支持的显式字段声明和赋值处理，不直接套用 TypeScript 参数属性；新增函数、helper、IIFE 和异步返回须符合实际 ArkTS 检查要求。
- 保持原 ArkUI 状态管理范式、数据所有权和组件生命周期，不为迁移一处 API 整体切换 V1/V2。
- 不在条件表达式中赋值；使用 `Number.isNaN` 判断 NaN。`finally` 不引入会覆盖原结果或异常的 return、break、continue、throw。
- 转换、过滤、查找优先考虑 map/filter/find/some；索引、提前结束或性能要求更明确时保留循环，不为形式统一重写有效业务。

## 资源、常量与日志

- 本次新增或修改的 UI 优先复用真实存在的语义颜色资源和项目 token，核对文本、图标、背景、边框用途；不虚构 SDK 资源，不顺带替换整页配色。
- 对重复或承载业务/布局含义的数字提取有意义常量。简单0/1、哨兵值与合理测试夹具可保留，不机械给每个字面量命名。
- 新日志先查已有 Logger/hilog、domain、tag 和安全错误格式化函数，按真实签名复用。不得新增 console、无关日志模块或依赖。

## 异常、异步与 API 迁移

- 修改前从准确 SDK 声明、实际检查输出及调用上下文确认 throws、Promise 和废弃状态。已有有效异常处理可保留，不因担心而为每个调用增加 catch。
- 新增获取链、调用或同步转异步时，按最小且语义完整的边界处理失败，保留原返回值、reject/resolve、回调次数及同身份 on/off。
- await 流程可沿用语义一致的外层 try/catch；未 await 的 Promise 必须有明确的失败传播或处理。catch 应明确恢复、记录后继续或重抛，不吞错、不返回猜测的成功值。
- 复用项目错误记录方式，保留必要错误信息；不通过强制类型转换假定未知错误形态，不添加空 catch 或无业务作用的捕获后原样重抛。
- 新调用的类型、参数和返回契约按真实SDK声明核对；废弃迁移的接口保护按[API保护指南](compatibility.md)；行为跨系统差异按[target升级兼容](../upgrade/upgrade-compatibility.md)选择必要分支，不扩展为通用接口可用性匹配。

### 新增调用的废弃状态

- 行为修复本次新增或替换的 SDK 调用不得引入废弃 API。按实际 diff 核对准确接收者、声明/重载的 `@deprecated`、`@useinstead`、替代接口及整条获取链的 since，覆盖新 helper 和复制的示例代码；官方旧文档的行为指导不代表其中 API 仍适合当前 SDK。
- 选用满足工程原 compatible 的非废弃接口，保持参数、单位、返回形态、异常及生命周期。无法找到满足条件的替代或来源不明时，保留 EVIDENCE_GAP/DECISION_REQUIRED 及已核验事实，不擅自提高 compatible、屏蔽告警或先用废弃调用占位。
- UIContext 必须属于当前组件/窗口。组件内从自身有效生命周期取得；工具函数或 HAR 沿已有调用链传入匹配实例，不把 CanvasRenderingContext2D、HostContext 强转成 UIContext，不通过废弃获取接口补出新链路，也不新建全局 ContextProvider。
- 只约束本次新增、替换及新增获取链；原有无关废弃代码不顺带迁移。按真实声明区分业务同名函数与 SDK API，不能按名称黑名单替换。行为流程仍不执行全量废弃扫描或复扫。

例如，官方归档的 drawImage 单位变更示例使用全局 `px2vp`；本机 API26 SDK 的该声明已标记 `@deprecated since 18`，替代 `UIContext.px2vp` 为 since12。以下仅展示有效 ArkUI 组件回调内、最低版本满足真实声明时的非废弃写法，pixelmap 和 imageInfo 沿用已核实的业务来源：

```ts
const uiContext = this.getUIContext();
const width = uiContext.px2vp(imageInfo.size.width);
const height = uiContext.px2vp(imageInfo.size.height);
this.context.drawImage(pixelmap, 0, 0, width, height, 50, 50, 250, 200);
```

`this.context` 仍是绘图上下文。是否需要 px→vp 转换，先核对 PixelMap、九参数重载、target 隔离及原始单位；已是 vp 或其他重载时不照搬转换。非组件调用使用传入的 UIContext，不直接套用 this.getUIContext。原归档代码中的其他获取调用同样要核验，不整段复制进工程。

### 迁移中的表达式与失败出口

- 等价替换未扩大风险时，保留有效原catch、原异常传播与后续业务，不因SDK有throws就给每次UI调用复制try/catch；继承风险单独说明。新增获取链、可空来源或不同异常形态仍独立核对。
- 在完整语义边界处理失败。void函数只在原允许结束的失败路径return；正常调用后还有业务语句时不新增return。原函数返回false、枚举或其他失败结果时保留既有出口，不制造空串、undefined、零值或ArrayBuffer/void联合来绕过类型错误。
- 保留参数求值、await、可选链及回调顺序。同一语句多个替换先判断能否安全合成；只有变量需要跨try/catch或版本分支使用时，才拆成准确类型局部变量，不引入无返回类型IIFE或额外控制层。
- Promise迁移同时核对所有消费者。原await/then的结果、外层return/resolve/reject与回调次数须连续保留；不能替换成只在内部处理却让外层Promise悬空的调用。未await的Promise不能由外层同步try/catch单独处理拒绝，空catch、默认成功和重复无效日志不算失败处理。

## 修改后的复核

检查实际差异是否满足以上适用规则，再执行可用 SDK/IDE 检查与真实完整构建。逐项核对新增调用的废弃状态并检查相关新增废弃告警；构建成功、没有新增错误或告警被抑制均不证明没有引入废弃 API。把准确声明、替代选择、失败契约及实际处理位置写入当前流程的已有记录；行为评估写 reason/evidence，修复后按 U07 追加 resolution.review 和验证记录，不覆盖原评估。区分历史告警与本次引入的问题，不扩大到无关代码。源码、配置或 SDK 再变更时重新验证；模型复核、提示性扫描与日志文件存在不能关闭编译待办。缺工具或编译失败时保留可信修改与原因，按[部分交付](troubleshooting.md#部分交付)报告。

官方入口：[ArkTS 编码规范](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-coding-style-guide)。具体 API 与语法仍以本次工程真实使用的 SDK 和工具链核实。

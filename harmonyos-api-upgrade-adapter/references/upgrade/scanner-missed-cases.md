# Scanner 可能漏报的编译与工程案例

本页用于出现真实 build error，或用户明确报告混淆失效、发布包异常时按线索查阅。它不是扫描后的主动核查清单；正常扫描、CSV 零行、构建成功且没有异常报告时，不自动通读或逐项检查。官方目录存在某项变更也不代表接口匹配式 scanner 能发现工程里的具体用法；不同工具版本的覆盖以真实结果为准。

## 按错误或异常检索

| 错误/异常特征 | 对应案例 | 匹配限制 |
| --- | --- | --- |
| The V1 decorator … cannot be applied to a Function-type variable | [状态管理 V1 函数字段](#状态管理-v1-函数字段) | 必须确认诊断中的装饰器、字段及真实函数类型 |
| The service widget file contains one or more references to HSPs | [卡片引用 HSP](#卡片引用-hsp) | 结合卡片入口和直接/传递依赖，普通应用使用 HSP 不等于该问题 |
| Property 'getState' is missing … CustomDialogController | [控制器字面量初始化](#customdialogcontroller-字面量初始化) | 其他类型的同名缺失属性不能套用 |
| 用户报告依赖混淆开关失效、升级后发布包混淆结果或运行行为变化 | [依赖混淆规则合并](#依赖混淆规则合并) | 无固定 build error；不能只因发布失败或包变大就认定 |

## 使用方法

1. 保存真实命令、工具版本、退出码和完整日志，提取具体错误主句、符号/类型、文件位置及前置上下文；只有 BUILD FAILED、任务名或退出码不足以匹配。
2. 按错误的稳定短语/符号检索本页索引，只读相关案例。错误中的装饰器、字段名或路径可不同，但必须核对完整语义，不按一个关键词自动定因。
3. 回读对应官方完整说明、准确 SDK、实际源码/配置与依赖链，区分升级变化、本次引入错误、既有问题和工具/签名等环境故障。未匹配或证据不足时继续[常规排错](../common/troubleshooting.md#定位与停止)，不强行套用。
4. 核对获批方案和实际修改范围；同一获批方案的必要实现修正可继续，新增业务方案、共享配置或范围变化需更新 spec 并取得相关批准。匹配案例本身不是修复授权。
5. 按真实差异记录诊断、依据、修复与重建结果。没有 CSV 对应行的错误保存在编译日志和现有进度/报告说明，不伪造扫描记录、rowId 或分类统计，不新增补充项协议。正常构建与设备测试沿用当前流程，失败次数不因查到案例而重置。

## 状态管理 V1 函数字段

**来源与条件**：[6.1.0(23) 官方完整章节](../changelogs/6.1.0(23)/changes-for-all-apps.md#新增状态管理v1校验报错)。该条增加编译校验：自定义组件 struct 中，状态管理 V1 装饰器不能装饰 Function/函数签名类型字段。按真实编译器诊断确认，不拿装饰器自身 since 或 target 隔离推定是否报错。

**错误特征**：

```text
The V1 decorator '@State' cannot be applied to a Function-type variable 'callback'.
```

装饰器和字段名以实际日志为准。官方范围包括 State、Prop、Link、Provide、Consume、StorageLink、LocalStorageLink、StorageProp、LocalStorageProp、ObjectLink；Watch 是状态观察机制，不能当作可统一替换的另一种函数状态字段。

**确认影响**：定位字段声明及推导类型，核对类型别名、初始化、赋值与调用者。诊断为非函数类型错误、方法参数或无关对象时不能套用本例；没有 V1 函数字段时不据此迁移整个状态管理体系。

下例是明确的错误用法：

```ts
@State callback: (input: number) => void = (input: number): void => {};
```

如果它是本组件普通回调，移除不受支持的状态装饰器，保留函数签名和业务体。下面只展示修复后的组件字段及调用：

```ts
@Entry
@Component
struct CallbackExample {
  @State value: number = 0;
  private callback: (input: number) => void = (input: number): void => {
    this.value = input;
  };

  build() {
    Button('调用回调')
      .onClick(() => {
        this.callback(1);
      })
  }
}
```

**边界与验证**：Prop/Link、父子绑定、存储同步或外部重新赋值的字段不能只删装饰器就认定语义等价，须重新确认回调传递和更新方案；不将函数字段与 V2 的方法装饰器混为一谈，不强制全量迁移 V2。重新完整构建，验证初始化、调用次数、参数、父组件更新后调用的实际函数及资源清理；编译通过不单独证明父子语义保留。

## 卡片引用 HSP

**来源与条件**：[官方构建变更条目](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/ide-changelogs-501#section162648113588)。以实际 DevEco/Hvigor 的校验及对应版本说明为准，不把 API target 当工具版本门槛，不无依据硬编码精确 IDE 起点。

**错误特征**（须与真实日志核对）：

```text
The service widget file contains one or more references to HSPs.
```

**确认影响**：沿编译器指出的文件回查真实卡片配置、入口页面、import/导出、模块元数据和解析依赖。检查直接引用，以及如下传递依赖；不能只看卡片页面没有 HSP import 就排除。

```text
卡片页面 → 公共 HAR → HSP
```

没有卡片，或卡片实际依赖闭包不包含 HSP 时，不套用本例。不要与“卡片调用未标识卡片能力的 API”这一运行时能力限制混为一谈。

**最小方案**：已有满足卡片能力的 HAR 时改用真实 HAR 依赖；HSP 同时供普通页面使用时，优先抽取卡片可用的公共 HAR，让卡片依赖闭包不再包含 HSP，原应用入口按原契约使用 HSP。按真实 module.json5、模块注册、Hvigor 插件、oh-package 及消费产物核对方案，不给出“只在 build-profile.json5 把 type 改成 har”即完成迁移的通用步骤。

```text
卡片页面 → 卡片公共 HAR（依赖闭包不含 HSP）
应用普通页面 → 原 HSP → 可复用的公共 HAR
```

第三方 HAR 间接依赖 HSP 时，不改 oh_modules 或第三方二进制冒充修复；评估可用的库版本/替代实现，缺源码或卡片能力不明时保留缺口。模块拆分和其他入口影响须纳入批准范围。

**验证**：真实完整构建，确认具体诊断消失及实际依赖/产物确已变化；按授权回归卡片渲染、刷新、点击跳转及依赖初始化，普通入口和原 HSP 也保留回归范围。只改 import 文本或改配置字段不能证明实际消费已切换。

## CustomDialogController 字面量初始化

**来源与条件**：[6.0.0(20) Beta1 官方完整章节](../changelogs/6.0.0(20)/beta1-os-api-behavior-changes.md#使用字面量初始化customdialogcontroller类实例导致的编译行为变更)。类新增成员后，原先 `{ open() {}, close() {} }` 形式不能满足真实类声明；根据当前 SDK 与诊断判断，不用运行时版本分支掩盖编译类型错误。

**错误特征**：

```text
Property 'getState' is missing in type '{ open(): void; close(): void; }' but required in type 'CustomDialogController'.
```

核对接收者确为 SDK CustomDialogController。无关接口也缺 getState、普通业务对象或真实 SDK 与文档不一致时，不自动套用。

**最小方案**：使用真实构造器并保留原 builder、取消回调和显示配置。下面是具有 builder 的最小示例，而不是无参 new 或补空 getState：

```ts
@CustomDialog
struct ExampleDialog {
  controller: CustomDialogController;

  build() {
    Column() {
      Text('示例弹窗')
      Button('关闭')
        .onClick(() => {
          this.controller.close();
        })
    }
  }
}

@Entry
@Component
struct DialogExample {
  private dialogController: CustomDialogController = new CustomDialogController({
    builder: ExampleDialog()
  });

  build() {
    Button('打开')
      .onClick(() => {
        this.dialogController.open();
      })
  }
}
```

**误匹配与验证**：不要给对象补空 getState、伪造返回值或强转为类来消除报错；也不能将原本的测试替身/业务接口强行变成真实 UI 弹窗，应按该场景重设类型边界。构建后核对打开、关闭、取消、重复打开和原生命周期/资源清理，不因使用构造器而覆盖原弹窗配置。

## 依赖混淆规则合并

**来源与条件**：[5.1.0(18) 官方完整章节](../changelogs/5.1.0(18)/os-api-behavior-changes.md#默认不合并依赖混淆规则变更说明)。以真实编译工具链规则为准，不能把章节中的接口起始 API10 当行为门槛，也不能仅凭 target 值判断混淆合并规则。

**异常特征**：没有固定编译报错。这项变化可能在构建通过后改变发布产物的混淆效果；仅在用户明确报告相关异常时查阅，不因没有 error 就认定不受影响，也不为本例编造错误码。

**确认影响**：核对本次构建模式、模块是否实际启用混淆、实际加载的当前模块规则，以及依赖 HAR 的 consumer 规则/三方库导出规则。变更前合并依赖的所有混淆配置，变更后默认只合并依赖的保留选项；当前模块自己的开关不因此消失。依赖没有相关开关、混淆未启用或产物并非本次构建时，不能直接断言是本条原因。

下面的依赖规则包含开关与保留项，二者需要分开看：

```text
-enable-property-obfuscation
-keep-property-name
publicName
```

**方案一：显式保留需要的混淆效果。** 已核实业务需要属性混淆且其他依赖开关不应继承时，在当前编译模块实际加载的规则文件中显式配置所需选项；其余业务保留项不删除。例如：

```text
-enable-property-obfuscation
```

**方案二：恢复全部依赖开关合并。** 确实需要旧合并行为且已审查依赖开关影响时，按官方指导在当前编译模块的 obfuscation-rules.txt 增加：

```text
-enable-lib-obfuscation-options
```

此开关会恢复依赖的全部混淆选项，不只是某一个缺失选项。官方变更本就为避免三方库开关意外影响应用，不能机械地对所有模块加该开关，也不能为保留原业务而引入依赖中的非预期配置。只修改实际获批的工程规则，不改第三方原件。

**验证**：使用真实启用混淆的发布构建，保存版本、模式、有效规则和本次产物，核对目标开关效果与依赖保留名；按授权验证导出接口、反射/动态访问和实际运行。Debug 构建通过、HAP 体积增大或字符串变化只能提供线索，不能单独定因或证明已修复。多模块按真实消费和各自规则分别核验，不把一个模块的设置当全工程生效。

# Context与UIContext废弃接口迁移

仅由废弃流程D05/D07在命中上下文或全局UI接口迁移时加载；完整任务顺序见[废弃主流程](deprecated-api-adaptation.md)。先读准确旧/替代SDK声明，再按下面顺序选择来源。通用[异常与异步规则](../common/arkts-coding-standards.md#异常异步与-api-迁移)、[版本保护](../common/compatibility.md#迁移调用的版本与回退)只维护在公共专题。

阅读顺序：[类型与选择](#类型与迁移选择顺序) → [四种来源](#四种上下文来源) → [接口对照](#全局接口到uicontext接口) → [迁移代码](#按场景迁移代码) → [约束复核](#迁移后的约束复核)。没有对应来源时保留具体缺口，不能因为普通类没有this就直接跳过。

## 类型与迁移选择顺序

| 类型 | 来源及用途 | 不能推断的事实 |
| --- | --- | --- |
| `common.Context` | 文件目录、资源等所需的最小宿主能力；UIContext.getHostContext可返回undefined | 不证明是UIAbilityContext，也不提供UI窗口归属 |
| `common.UIAbilityContext` | 真实UIAbility实例的this.context；用于Ability专有操作 | 不能从普通HostContext强制转换获得 |
| `UIContext` | 实际组件或Window所属的UI实例；执行路由、弹窗等UI操作 | 不能当作普通Ability Context，也不能套用到任意窗口 |

选择顺序：组件自身UIContext → 已有参数/成员/真实Window → 完整内部调用链传入最小Context或值 → 仅在已有依赖及归属/生命周期可证明时使用受控服务。每个来源核对准确SDK、可空性和初始化时机，不为统一模式增加模块、依赖或全局服务。

组件getUIContext自API11起可用；ComponentV2装饰器自12起。Window.getUIContext自10起，WindowStage.getMainWindowSync自9起；UIContext.getHostContext自12起且可空。它们是不同声明，不能统一标API12，更不能把deprecated18当作替代起点。完整调用链门槛还包含所用组件/下游方法；真实任务始终重新核对所选SDK。

## 四种上下文来源

### 组件实例

@Component或@ComponentV2实例方法和词法this箭头回调中可使用this.getUIContext；普通function回调、静态方法及早期字段初始化不能据此推断安全。同文件有UIContext不证明每个函数拥有该实例。

### 已有Window或WindowStage

优先复用调用路径已有、具SDK类型和生命周期证据的Window；WindowStage先取得真实主窗口。公开类可复用已有窗口而不改签名，PUBLIC_API只阻止破坏公开签名的注入。不要将WindowStage当作Window，也不要到处复制AppStorage的WindowStage获取链。

### 内部调用链参数传递

仅在全部调用点可静态核对且不破坏公开HAR/HSP消费者时追加参数；声明、构造器/普通调用及所有相关文件同时处理。只需filesDir等值时传common.Context或最小值，不先注入UIContext再断言HostContext非空。保留可选/默认参数与位置；可选参数后增加必需参数时逐项调整调用，不遗漏需要补undefined的旧参数。可空函数类型的括号不改变。

### 既有依赖内的受控服务

前三种来源不能满足且Ability/窗口/初始化归属可证明时才考虑。优先已有公共模块及最短已声明依赖链，不覆盖现有ContextUtils，不在各模块复制Provider。可用带Ability/窗口键的现有服务时优先使用，不能把多窗口变成“最后激活窗口”。下面代码只适用于已核实单个活动Ability、单主窗口的场景，不作为多实例通用方案。

## 全局接口到UIContext接口

表中接收者均为先前获取的真实`uiContext`。版本列只表示该UIContext成员的准确since，不替代获取链、返回对象方法、参数/重载的独立门槛核查；不是对所有同名全局调用的自动替换证明。

| 原入口/调用 | UIContext成员 | 成员起始版本 | 差异/边界 |
| --- | --- | --- | --- |
| `@ohos.animator` | `uiContext.createAnimator(...)` | 10；18 | AnimatorOptions起点10；SimpleAnimatorOptions重载18 |
| `@ohos.arkui.componentSnapshot` | `uiContext.getComponentSnapshot(...)` | 12 | 再核对返回对象的get等具体重载 |
| `@ohos.arkui.componentUtils` | `uiContext.getComponentUtils(...)` | 10 | 按返回对象操作，不混用实例 |
| `@ohos.arkui.dragController` | `uiContext.getDragController(...)` | 11 | 按返回对象的具体方法核对参数 |
| `@ohos.arkui.inspector` | `uiContext.getUIInspector(...)` | 10 | 按实际观察器成员迁移 |
| `@ohos.arkui.observer` | `uiContext.getUIObserver(...)` | 11 | 订阅与取消保持实例/回调身份 |
| `@ohos.font` | `uiContext.getFont(...)` | 10 | 字体注册等使用返回对象 |
| `@ohos.measure` | `uiContext.getMeasureUtils(...)` | 12 | measureText返回宽度；measureTextSize返回尺寸，不能混换 |
| `@ohos.mediaquery` | `uiContext.getMediaQuery(...)` | 10 | 保留查询条件和监听生命周期 |
| `@ohos.promptAction` | `uiContext.getPromptAction(...)` | 10 | showToast/showDialog/openCustomDialog/closeCustomDialog/showActionMenu仍核对各自签名 |
| `@ohos.router` | `uiContext.getRouter(...)` | 10 | 保留路由参数、返回值与异步形态 |
| `AlertDialog.show` | `uiContext.showAlertDialog(...)` | 10 | 保留按钮和用户回调 |
| `ActionSheet.show` | `uiContext.showActionSheet(...)` | 10 | 保留选项及选择回调 |
| `CalendarPickerDialog.show` | 待具体接口核验 | —（未提供直接替代） | 本条不提供可直接套用的UIContext替代；不等价替成DatePickerDialog，查具体控件/SDK并留证据缺口 |
| `DatePickerDialog.show` | `uiContext.showDatePickerDialog(...)` | 10 | 保留日期参数和回调 |
| `TimePickerDialog.show` | `uiContext.showTimePickerDialog(...)` | 10 | 保留时间参数和回调 |
| `TextPickerDialog.show` | `uiContext.showTextPickerDialog(...)` | 10；20 | 基础重载10；TextPickerDialogOptionsExt重载20 |
| `ContextMenu` | `uiContext.getContextMenuController(...)` | 12 | 以实际旧成员（如close）及返回控制器成员配对 |
| `focusControl` | `uiContext.getFocusController(...)` | 12 | 保留请求焦点的真实目标 |
| `cursorControl` | `uiContext.getCursorController(...)` | 12 | 保留光标相关参数 |
| `getContext` | `uiContext.getHostContext(...)` | 12 | 返回common.Context或undefined；不能据此强转UIAbilityContext |
| `LocalStorage.getShared` | `uiContext.getSharedLocalStorage(...)` | 12 | 返回LocalStorage或undefined，保留原存储身份 |
| `animateTo` | `uiContext.animateTo(...)` | 10 | 保留动画参数和同步闭包 |
| `animateToImmediately` | `uiContext.animateToImmediately(...)` | 23 | 提供对应UIContext成员，since23 |
| `vp2px` | `uiContext.vp2px(...)` | 12 | 保留单位及数值，不用一项转换代替另一项 |
| `px2vp` | `uiContext.px2vp(...)` | 12 | 保留单位及数值，不用一项转换代替另一项 |
| `fp2px` | `uiContext.fp2px(...)` | 12 | 保留单位及数值，不用一项转换代替另一项 |
| `px2fp` | `uiContext.px2fp(...)` | 12 | 保留单位及数值，不用一项转换代替另一项 |
| `lpx2px` | `uiContext.lpx2px(...)` | 12 | 保留单位及数值，不用一项转换代替另一项 |
| `px2lpx` | `uiContext.px2lpx(...)` | 12 | 保留单位及数值，不用一项转换代替另一项 |

## 按场景迁移代码

代码在各自适用场景使用，不把互不相干片段拼成同一函数。只展示支持版本上的接口迁移；最低版本保护按公共兼容指南实施。导入、Logger/hilog、TAG及失败出口沿用实际工程，不复制空catch或虚构默认成功。

### 组件UIContext与HostContext

迁移前（组件原有点击回调）：

```ts
import { promptAction } from '@kit.ArkUI';

Button('保存').onClick(() => {
  promptAction.showToast({ message: '保存成功' });
});
```

迁移后（相同组件/业务回调）：

```ts
Button('保存').onClick(() => {
  this.getUIContext().getPromptAction().showToast({ message: '保存成功' });
});
```

getContext迁到HostContext时，保留实际消费者及可空处理。例如在原本允许失败后结束的void实例方法中：

```ts
const context = this.getUIContext().getHostContext();
if (!context) {
  hilog.error(0x0000, 'ContextMigration', 'Host context is unavailable');
  return;
}
const filesDir = context.filesDir;
```

filesDir继续交给原消费者，不改为cacheDir；原函数需返回false/枚举等失败值时沿用那个出口，不能复制上述void return掩盖契约。

### 已有Window与WindowStage

```ts
import { UIContext, window } from '@kit.ArkUI';

function fromWindow(currentWindow: window.Window): UIContext {
  return currentWindow.getUIContext();
}

function fromWindowStage(stage: window.WindowStage): UIContext {
  return stage.getMainWindowSync().getUIContext();
}
```

两种来源分别核对异常声明及调用方既有边界，不为了复制示例吞掉获取失败。它们代表真实已有对象，不表示应新增全局窗口查找链。

### 参数注入与最小上下文

迁移前：

```ts
import { promptAction } from '@kit.ArkUI';

function showSaved(message: string): void {
  promptAction.showToast({ message });
}
```

迁移后：

```ts
import { common } from '@kit.AbilityKit';
import { UIContext } from '@kit.ArkUI';

function showSaved(message: string, uiContext: UIContext): void {
  uiContext.getPromptAction().showToast({ message });
}

function makePath(filename: string, context: common.Context): string {
  return context.filesDir + '/' + filename;
}
```

组件调用点使用showSaved('保存成功', this.getUIContext())；makePath只接收已判空的真实Context。构造器注入用显式字段/赋值，覆盖全部new调用，不用ArkTS不支持的参数属性简写；动态调用或公开消费者无法证明时，不破坏签名。

### 受控ContextUtils与同归属清理

以下单份服务置于真实已有共享模块，类名仅示例。AbilityContext来自真实Ability，UIContext由已确认loadContent加载的入口组件注册；getter保持可空，旧页面令牌不能清除新页面注册。

```ts
import { common, UIAbility } from '@kit.AbilityKit';
import { UIContext } from '@kit.ArkUI';

export class ContextUtils {
  private static owner: UIAbility | undefined = undefined;
  private static ability: common.UIAbilityContext | undefined = undefined;
  private static ui: UIContext | undefined = undefined;
  private static nextToken: number = 1;
  private static currentToken: number = 0;

  static registerAbility(owner: UIAbility, context: common.UIAbilityContext): void {
    if (ContextUtils.owner && ContextUtils.owner !== owner) {
      throw new Error('Context service requires a single active Ability');
    }
    ContextUtils.owner = owner;
    ContextUtils.ability = context;
  }

  static setUIContext(uiContext: UIContext): number {
    if (!ContextUtils.owner) {
      throw new Error('Ability context is not registered');
    }
    const token = ContextUtils.nextToken++;
    ContextUtils.ui = uiContext;
    ContextUtils.currentToken = token;
    return token;
  }

  static clearUIContext(token: number): void {
    if (ContextUtils.currentToken === token) {
      ContextUtils.ui = undefined;
      ContextUtils.currentToken = 0;
    }
  }

  static clearWindow(owner: UIAbility): void {
    if (ContextUtils.owner === owner) {
      ContextUtils.ui = undefined;
      ContextUtils.currentToken = 0;
    }
  }

  static clearAbility(owner: UIAbility): void {
    if (ContextUtils.owner === owner) {
      ContextUtils.clearWindow(owner);
      ContextUtils.ability = undefined;
      ContextUtils.owner = undefined;
    }
  }

  static get globalContext(): common.Context | undefined {
    return ContextUtils.ability;
  }

  static get globalUIAbilityContext(): common.UIAbilityContext | undefined {
    return ContextUtils.ability;
  }

  static get globalUIContext(): UIContext | undefined {
    return ContextUtils.ui;
  }
}
```

在真实UIAbility.onCreate首句调用ContextUtils.registerAbility(this, this.context)，原生命周期逻辑继续保留；onWindowStageDestroy调用clearWindow(this)，onDestroy调用clearAbility(this)。不要把HostContext强转成UIAbilityContext，也不要只登记UIContext就伪造AbilityContext。

已核实的入口组件使用同一份ContextUtils，保存注册令牌；导入从实际已有模块路径取得：

```ts
private contextToken: number = 0;

aboutToAppear(): void {
  this.contextToken = ContextUtils.setUIContext(this.getUIContext());
}

aboutToDisappear(): void {
  ContextUtils.clearUIContext(this.contextToken);
}
```

消费者按可空结果及原失败出口处理，不使用as、非空断言或空字符串/零值消除缺失。不把请求/事件/页面临时对象缓存到服务。多Ability、specified模式或多窗口无法证明归属时，使用显式参数/窗口键方案，不套用本例。

公共模块需要跨已有依赖导出时，仅沿实际存在的依赖链转发唯一符号；例如已有phone→business_mine→module_feedback，可由module_feedback导出带模块名的ContextUtils，business_mine再转发。不要增加新依赖或重复创建Provider。

### 单位转换与组件截图

旧px2vp(10)对应uiContext.px2vp(10)，返回值继续交给原消费者：

```ts
const uiContext = this.getUIContext();
const logicalWidth = uiContext.px2vp(10);
```

旧componentSnapshot.get的接收者迁为当前实例，保留同一id、回调与图像消费者：

```ts
import { UIContext } from '@kit.ArkUI';
import { image } from '@kit.ImageKit';
import { AsyncCallback } from '@kit.BasicServicesKit';

function capture(uiContext: UIContext, id: string, callback: AsyncCallback<image.PixelMap>): void {
  uiContext.getComponentSnapshot().get(id, callback);
}
```

callback使用原有实现，保留实际错误处理、PixelMap消费者与释放顺序；文本测量分别使用getMeasureUtils().measureText和measureTextSize，按所需的宽度或尺寸选择，保留真实返回类型。

## 迁移后的约束复核

- 组件this绑定、原窗口、早期字段初始化、Ability/页面令牌及生命周期分别核实；只有aboutToAppear不证明早期字段可改。
- 保留公开HAR/HSP接口和已有依赖，不能仅为统一形式新增服务或复制WindowStage链。
- 真实获取/替代链门槛逐项核对，不能由弃用版本反推since；完整兼容处理见公共兼容指南。
- 可空返回使用已有失败契约，表达式求值顺序、参数、同步/异步和返回形态保持；通用规则见公共编码规范。
- 调用位置、原始行、真实修改与未解决项按废弃主流程记录；设备取证/清理由既有公共验证专题承担，不在此重复定义。

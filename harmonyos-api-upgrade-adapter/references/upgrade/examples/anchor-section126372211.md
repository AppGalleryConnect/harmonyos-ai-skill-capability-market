# section126372211-沉浸光感新增生效约束

## 来源与版本

身份：官方章节锚点 `section126372211`；当前规则包未提供扫描Rule ID。

身份是官方锚点 `section126372211`，当前没有扫描RuleID，本地title-to-changeid映射也未收录；不得伪造为扫描ID或把policyId当RuleID。[完整官方章节](../../changelogs/26.0.0/release-changes-for-all-apps.md#沉浸光感新增生效约束)位于26.0.0 Release，说明这些接口在26.0.0 Beta新增，约束仅在targetSdkVersion≥26.0.0生效。

本机准确SDK26.0.0.105 Release：`common.d.ts` 的systemMaterial、`@ohos.arkui.uiMaterial.d.ts` 的uiMaterial.ImmersiveMaterial/ImmersiveStyle.THIN、`tabs.d.ts` 的barFloatingStyle及其systemMaterial成员均标since26.0.0。Navigation.title支持CustomBuilder；Tabs.vertical(false)为横向，barPosition用BarPosition.End。声明能力不表示任意组件、任意位置都允许材质生效。

## 旧新行为

旧为支持开启沉浸光感的组件开启后生效。新为：除以下完整例外清单外，其他组件仅在Navigation/NavDestination标题栏，或横向Tabs且barPosition=BarPosition.End的底部TabBar内生效，其他区域设置无效果。

仍可在页面全部区域生效、未发生本条收窄的清单：

- 弹窗类组件：AlertDialog、ActionSheet、CustomDialog、CalendarPickerDialog、DatePickerDialog、TimePickerDialog、TextPickerDialog、SelectionMenu、AlphabetIndexer弹窗、Text设置copyOption后长按或双击触发的文本菜单。
- 弹窗类接口：PromptAction、ArkUI_NativeDialog、@ohos.promptAction（弹窗）、Popup控制、Tips控制、菜单控制、半模态转场。
- 按钮与选择类组件：Slider、Toggle、Select。

不能把“按钮与选择类”概括成所有Button，也不能把Text菜单例外扩展为普通正文Text。

## 影响条件与工程核查

定位systemMaterial、ImmersiveMaterial、barFloatingStyle.systemMaterial及封装来源，核对实际组件类型与区域归属，再按完整例外清单排除。需要读取builder的真实挂载点、Navigation/NavDestination.title、TabContent.tabBar、Tabs.vertical与barPosition及动态分支。屏幕上靠近顶部/底部、自定义容器取名title/tabBar，不等于位于官方支持区域。

普通Column在正文区开启沉浸光感会失效；同一builder通过标题栏或真实底部TabBar挂载则需按区域分别判断。布局位置、组件类型或最终材质对象不明时保留证据缺口。材质还影响背景、边框与阴影，已有属性覆盖和设备渲染能力需区分取证，不能看到无模糊就只归因于本条。

## 受影响与不受影响示例

下面为原页面已有材质属性，放在正文Column时满足范围外条件；`uiMaterial`由 `@kit.ArkUI` 导入：

```ts
Column() { /* 原内容 */ }
  .systemMaterial(new uiMaterial.ImmersiveMaterial({
    style: uiMaterial.ImmersiveStyle.THIN
  }))
```

若该builder语义本来就是标题，可按官方示例经 `Navigation().title(this.customTitle, { barStyle: BarStyle.STACK })` 的自定义标题挂载；底部导航则经横向 `Tabs({ barPosition: BarPosition.End })` 内的 `TabContent().tabBar(...)` 或受支持的barFloatingStyle设置。上述是挂载位置说明，不是可单独运行的完整页面。

Slider/Toggle/Select及完整例外清单不需要因本条迁入标题栏；已经在真实标题栏或横向底部TabBar的普通组件也不因本条改变位置。竖向Tabs即使End也不能据此认定支持，正文自绘底栏同样不等价。

## 最小方案与边界

先确认业务需要保留的功能和视觉。确属标题/导航内容且允许位置归属调整时，局部接入真实标题栏或横向底部TabBar，并保留事件、无障碍和布局。正文业务不适合迁移时，说明该位置已无同接口恢复效果的保证，给出保持功能/采用普通视觉的待决策方案，不擅自把正文卡片搬到标题栏、换成Slider或声称仅加属性就能绕过约束。

接口since26.0.0与target隔离分开处理；当前SDK声明未证明低版本可用，已有兼容分支应保留并核对真实运行系统，不编造“API20/23可用”。

## 验证与证据缺口

在实际目标系统比较正文普通组件、真实标题栏、横向End底部TabBar、竖向Tabs以及例外组件；验证材质、布局、点击与滚动联动，不只编译。记录设备能力及相关背景/边框/阴影覆盖。真实编译、设备材质渲染和截图均未执行，不能因缺扫描RuleID就宣称本条不适用。

[返回案例索引](../upgrade-examples.md#案例索引)。

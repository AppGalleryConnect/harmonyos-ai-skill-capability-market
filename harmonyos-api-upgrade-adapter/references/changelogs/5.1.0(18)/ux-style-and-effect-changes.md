---
title: UX样式或效果的变更
source: https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/changelogs-ux-5101
category: harmonyos-releases
downloaded_at: 2026-09-03
---

# UX样式或效果的变更

## 按钮默认值变更为新增圆角矩形类型

**变更原因**

原有默认类型按钮是胶囊按钮，在适老化场景下字体过大，在多行等场景下胶囊按钮文字易超出其圆角范围。不符合简单易用及高端精致原则，因此新增圆角矩形类型按钮，默认值变为新增的圆角矩形类型。

**变更影响**

此变更涉及应用适配。

**说明**

此变更已做版本隔离，变更仅在应用的targetSdkVersion设置为大于等于5.1.0(18)时生效。

变更前：ButtonOptions中type的默认值为ButtonType.Capsule。

变更后：ButtonOptions中type的默认值为ButtonType.ROUNDED\_RECTANGLE。

![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/fc/v3/JBuJpYvoTfC-GqvJyB5xZA/zh-cn_image_0000002295507629.png?HW-CC-KV=V1&HW-CC-Date=20260903T083915Z&HW-CC-Expire=86400&HW-CC-Sign=DDF11A459DA6B53627586610BE370FBA00D5774853C19C9E676C00A019E86464)

**起始API Level**

9

**变更的接口/组件**

Button组件中ButtonOptions对象的type属性默认值。

**适配指导**

开发者在使用Button组件时，按钮的默认类型会从Capsule类型变更为ROUNDED\_RECTANGLE类型，两个类型对应的圆角大小存在差异，如果应用期望保持变更之前的圆角大小，需要手动添加type属性并指定为Capsule类型。

```
@Entry
@Component
struct ButtonExample {
  build() {
    Flex({ direction: FlexDirection.Column, alignItems: ItemAlign.Start, justifyContent: FlexAlign.SpaceBetween }) {
      Text('Capsule button with rounded corners by default.').fontSize(9).fontColor(0xCCCCCC)
      Flex({ alignItems: ItemAlign.Center, justifyContent: FlexAlign.SpaceBetween }) {
        Button('Capsule')
          .type(ButtonType.Capsule)
          .backgroundColor(0x317aff)
          .height(60)
          .controlSize(ControlSize.NORMAL)
          .width(180)
      }
      Text('Rounded rectangle button with rounded corners by default.').fontSize(9).fontColor(0xCCCCCC)
      Flex({ alignItems: ItemAlign.Center, justifyContent: FlexAlign.SpaceBetween }) {
        Button('Rounded rectangle')
          .type(ButtonType.ROUNDED_RECTANGLE)
          .backgroundColor(0x317aff)
          .controlSize(ControlSize.NORMAL)
          .height(60)
          .width(180)
      }
    }.height(400).padding({ left: 35, right: 35, top: 35 })
  }
}
```

## 修复Popup高级组件宽度限制计算错误的问题

**变更原因**

目前宽度最大限制不符合ux规范，在手机屏幕场景下，会出现Popup高级组件无法撑满屏幕的情况，影响体验。

**变更影响**

此变更不涉及应用适配。

变更前：屏幕宽度小于400vp时，Popup高级组件最大宽度为当前屏幕宽度-80vp。

变更后：屏幕宽度小于400vp时，Popup高级组件最大宽度为当前屏幕宽度。

| 变更前 | 变更后 |
| --- | --- |
| ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/0b/v3/agd3QqEwR52LiafT4TTV2Q/zh-cn_image_0000002295394577.png?HW-CC-KV=V1&HW-CC-Date=20260903T083915Z&HW-CC-Expire=86400&HW-CC-Sign=3E17043C62C459DC4354C01661862E3D1B8E77C9F4ECFE1191335211E0E8C3F9) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/bc/v3/2ArkD234S06zS2hxMvJv7w/zh-cn_image_0000002260714472.png?HW-CC-KV=V1&HW-CC-Date=20260903T083915Z&HW-CC-Expire=86400&HW-CC-Sign=98DA84422B97E2E7BD2A89ECAEB7C9ED7ED1FCCF6541C7C9913C38BD44B4C0AB) |

**起始API Level**

11

**变更的接口/组件**

Popup高级组件。

**适配指导**

如果用户原来没有自定义Popup高级组件的宽度，且内容宽度大于320vp，变更前按320vp显示，变更后，Popup高级组件会变宽；如不符合预期，可以手动修改为想要的宽度。

## 半模态底部样式最大高度默认避让状态栏安全区

**变更原因**

UX规格变更。

半模态底部样式最大高度默认避让状态栏安全区。

**变更影响**

此变更不涉及应用适配。

**说明**

此变更已做版本隔离，变更仅在应用的targetSdkVersion设置为大于等于5.1.0(18)时生效。

场景1：竖屏下，状态栏隐藏时，半模态底部样式最大高度也需要避让状态栏安全区。

-   变更前：状态栏隐藏时，半模态底部样式最大高度距离屏幕上边界8vp，未避让状态栏安全区。
-   变更后：API version 18及以后，状态栏隐藏时，半模态底部样式最大高度距离状态栏下边界8vp，避让状态栏安全区。该样式的最大高度为屏幕高度 - (窗口状态栏安全区高度 + 安全间距8vp)。

| 变更前 | 变更后 |
| --- | --- |
| ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/d9/v3/O-g7QQv5SDqPwS0KgxsrRg/zh-cn_image_0000002260714476.png?HW-CC-KV=V1&HW-CC-Date=20260903T083915Z&HW-CC-Expire=86400&HW-CC-Sign=B425CB76F5C7AB78903FA2773F70552005A85F10DBE86539992553A36A7CB0DF) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/c5/v3/tjE-uWuxTcKTnur4dt6G1Q/zh-cn_image_0000002260817554.png?HW-CC-KV=V1&HW-CC-Date=20260903T083915Z&HW-CC-Expire=86400&HW-CC-Sign=1CAA0873E955583B401365BA6D0DC811FD857C5B35ACFA6493B12F6C3D96AF5C) |

场景2：横屏下，状态栏不隐藏时，半模态底部样式最大高度也需要避让状态栏安全区。

-   变更前：状态栏不隐藏时，半模态底部样式最大高度距离屏幕上边界8vp，未避让状态栏安全区，且与状态栏区域重合。
-   变更后：API version 18及以后，状态栏不隐藏时，半模态底部样式最大高度距离状态栏下边界8vp，避让状态栏安全区。该样式的最大高度为屏幕高度 - (窗口状态栏安全区高度 + 安全间距8vp)。

| 变更前 | 变更后 |
| --- | --- |
| ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/e9/v3/BblujiH8Rp2jBtrYuxoXkA/zh-cn_image_0000002295507637.jpg?HW-CC-KV=V1&HW-CC-Date=20260903T083915Z&HW-CC-Expire=86400&HW-CC-Sign=3551AA6AF580D63F6FB818DD560F7B4E066A9510307C47868C35D36D1DF94E91) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/cd/v3/m5KKlPPpQFOjNL4AyfzLpw/zh-cn_image_0000002295394585.jpg?HW-CC-KV=V1&HW-CC-Date=20260903T083915Z&HW-CC-Expire=86400&HW-CC-Sign=C39EDEB8D17D467605744CED923CF4DC68F3DF6B7C9A46673874F3C7A5F8B365) |

**起始API Level**

11

**变更的接口/组件**

bindSheet的LARGE属性

**适配指导**

若开发者自定义的builder面板内容是固定高度，建议使用100%布局，变更后自定义的内容也可以自动撑满半模态面板。

若按变更前的最大高度规格限制的builder内容，需要变更为新规格计算。
---
title: UX样式或效果的变更
source: https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/changelogs-ux-b106
category: harmonyos-releases
downloaded_at: 2026-09-03
---

# UX样式或效果的变更

## QRCode深浅色适配修改

**变更原因**

QRCode在深色模式下使用默认颜色生成的二维码无法被正常识别。

**变更影响**

此变更涉及应用适配。

变更前:在深色模式下，QRCode生成的二维码背景颜色为黑色，图案颜色为白色。

变更后:在深色模式下，QRCode生成的二维码背景颜色为白色，图案颜色为黑色，与浅色模式相同。

**起始API Level**

12

**变更的接口/组件**

QRcode组件

**适配指导**

默认效果变更，按需适配。若需反色二维码（背景颜色为黑色，图案颜色为白色），请自定义设置color、backgroundColor实现。

## 属性动画onFinish结束回调在UIAbility退后台时因有限循环动画被终止而提前触发

**变更原因**

属性动画在UIAbility退后台时不会停止而是继续步进，此时动画不显示但持续请求Vsync，造成了不必要的功耗浪费，故而需要变更动画行为。变更为，在UIAbility退后台时，其包含的有限循环动画会立即结束，无限循环动画依旧不结束。

**变更影响**

此变更涉及应用适配。

变更前：onFinish接口在相应属性动画结束时触发回调。动画不感知UIAbility的前后台状态，UIAbility退后台后，动画仍按照所设时长和循环次数步进至完成，并触发结束回调。

变更后：onFinish接口在相应属性动画结束时触发回调。动画感知UIAbility的前后台状态，UIAbility退后台时，如果此时有限循环动画还未结束，该动画会被停止至终点态并触发onFinish结束回调。无限循环动画不受退后台影响，不会停止。

**起始API Level**

7

**变更的接口/组件**

AnimateParam和KeyframeAnimateParam的onFinish接口。

**适配指导**

默认行为变更，应注意变更后的行为是否对整体应用逻辑产生影响。

## TextInput组件在非标准字体场景下showCounter接口布局变更

**变更原因**

在大字体时，showCounter所属的TextInput组件的下侧Margin空间不足。

**变更影响**

此变更涉及应用适配。

变更前：在设置showCounter后，TextInput组件的下侧Margin大小为固定的22vp，showCounter的垂直偏移量为字体高度。

变更后：在设置showCounter后，标准字体下，TextInput组件的下侧Margin以及垂直偏移量和变更前保持一致。非标准字体设置下，TextInput组件的下侧Margin大小为16vp加上showCounter的字体高度，垂直偏移量为8vp。

设置非标准字体时，变更前后对比效果如下图所示：

| 变更前 | 变更后 |
| --- | --- |
| ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/90/v3/ehAqssKSTFOw1RGJ8xaudg/zh-cn_image_0000002117643785.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=2210D97434955E348954434D211608631A965108675D8BC45F13EC29F3A53DE4) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/d4/v3/xoKYO-w1QcurHcg9z2KvOg/zh-cn_image_0000002117728853.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=7316CC284336D153BD0D0DEBA932FCBEE699D5E85BA35471AAF4217D2A9BB160) |

示例：

```
@Entry
@Component
struct Index {
  @State message: string = 'Hello World';

  build() {
    Column() {
      TextInput({text: "输入文字1"})
        .showCounter(true)
        .maxLength(10)
      TextInput({text: "输入文字2"})
    }
    .height('100%')
    .width('100%')
  }
}
```

**起始API Level**

11

**变更的接口/组件**

TextInput组件showCounter接口。

**适配指导**

默认效果变更，无需适配，但应注意变更后的默认效果是否符合开发者预期，如不符合则应自定义修改效果控制变量以达到预期。

## MenuItem组件在非PC/2in1设备上超长文本布局由缩略显示变更为换行显示

**变更原因**

对于使用超长文本的MenuItem组件场景，默认布局效果优化，UX体验更佳。

**变更影响**

此变更不涉及应用适配。

**说明**

此变更已做版本隔离，变更仅在应用的targetSdkVersion设置为大于等于5.0.1(13)时生效。

变更前：MenuItem组件含有超长文本时，文本缩略显示。

变更后：API13开始，MenuItem组件含有超长文本时，在PC/2in1设备上不换行，其余设备无限换行。

| 变更前长文本缩略 | 变更后非PC/2in1设备长文本换行 |
| --- | --- |
| ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/41/v3/T87jTC-VQOqkJ39htd7Ftw/zh-cn_image_0000002082049838.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=B334BC1F26726981415E905A8BCB9EDB2D1C9BEF6945CF826FC5A700578B093C) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/ab/v3/3UpnAuo6TFeKpeLZ2RZG9A/zh-cn_image_0000002082204590.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=E9D5C5442BDC2CE7A50BB924B426145CE3E8DB681C699D0ABBD5F035C6A7C49F) |

**起始API Level**

11

**变更的接口/组件**

MenuItem组件。

**适配指导**

MenuItem UX默认布局效果变更，应用无需适配。

## Tabs组件barOverlap接口默认效果变更

**变更原因**

优化Tabs组件barOverlap属性设置为true时，TabBar的模糊效果和渲染性能。

**变更影响**

此变更涉及应用适配。

变更前：设置barOverlap属性为true时，TabBar默认背景色修改为'#F2F1F3F5'并添加模糊效果。

变更后：设置barOverlap属性为true时，TabBar默认模糊材质的BlurStyle值修改为'BlurStyle.COMPONENT\_THICK'。

| 变更前 | 变更后 |
| --- | --- |
| ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/98/v3/yuATTkGOSNiUymNP0HyKNQ/zh-cn_image_0000002117643789.jpg?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=DAB8587FB35B6B18377C3D0B47AA3B9A9BEA8409C7D07AA8BE2C3603EDA064B1) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/8d/v3/J_5aKd_2TLiSTgUcdLsraw/zh-cn_image_0000002117728857.jpg?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=6A4EB6846242E2DDCDC2BEB70CF9939F9415A6FC6DFB050A2E7ABB85B8279ED0) |

**起始API Level**

10

**变更的接口/组件**

barOverlap接口

**适配指导**

当barOverlap设置为true时，开发者若期望无模糊效果，设置barBackgroundBlurStyle为BlurStyle.NONE。示例如下：

```
@Entry
@Component
struct barHeightTest {
  @State arr: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  build() {
    Column() {
      Tabs({ barPosition: BarPosition.End }) {
        TabContent() {
          Column() {
            List({ space: 10 }) {
              ForEach(this.arr, (item: number) => {
                ListItem() {
                  Text("item" + item).width('80%').height(200).fontSize(16).textAlign(TextAlign.Center).backgroundColor('#fff8b81e')
                }
              }, (item: string) => item)
            }.width('100%').height('100%')
            .lanes(2).alignListItem(ListItemAlign.Center)
          }.width('100%').height('100%')
          .backgroundColor(Color.Pink)
        }
        .tabBar(new BottomTabBarStyle($r('sys.media.ohos_icon_mask_svg'), "测试0"))

        TabContent() {
          Column() {
            List({ space: 10 }) {
              ForEach(this.arr, (item: number) => {
                ListItem() {
                  Text("item" + item).width('80%').height(200).fontSize(16).textAlign(TextAlign.Center).backgroundColor('#fff8b81e')
                }
              }, (item: string) => item)
            }.width('100%').height('100%')
            .lanes(2).alignListItem(ListItemAlign.Center)
          }.width('100%').height('100%')
          .backgroundColor(Color.Blue)
        }
        .tabBar(new BottomTabBarStyle($r('sys.media.ohos_icon_mask_svg'), "测试1"))
      }
      .barOverlap(true)
      .barBackgroundBlurStyle(BlurStyle.NONE) // 关闭TabBar模糊效果
    }
  }
}
```
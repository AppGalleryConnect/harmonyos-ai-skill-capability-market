---
title: UX样式或效果的变更
source: https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/changelogs-ux-b112
category: harmonyos-releases
downloaded_at: 2026-09-03
---

# UX样式或效果的变更

## Tabs组件底部页签默认高度由52vp变更为48vp

**变更原因**

Tabs组件底部页签默认高度由52vp调整到48vp，优化用户体验。

**变更影响**

此变更涉及应用适配。

变更前：设置BottomTabBarStyle样式且vertical属性为false时，barHeight的默认值为52vp。

变更后：设置BottomTabBarStyle样式且vertical属性为false时，barHeight的默认值为48vp。

| 变更前 | 变更后 |
| --- | --- |
| ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/7a/v3/6Zqs9860SgmKcRTBL5ZIMA/zh-cn_image_0000002411206108.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=16333B512FD74BF78F65F3E56EC44F273AEA0D460974D8B0184581637B9CA476) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/fd/v3/nzM1kxsfSzeAJQ0vkOXLlQ/zh-cn_image_0000002444645301.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=41B6F2D300501E1CD4A754E1C580B1FC4B69C8FB7E3661FD12DBC405CB5326C6) |

**起始API Level**

11

**变更的接口/组件**

barHeight

**适配指导**

若发现组件高度变化导致界面内容出现留白，可通过修改内容区高度或自适应内容区高度。

若组件高度发生变化，开发者期望保持原有高度样式。示例如下：

```
@Entry
@Component
struct barHeightTest {
  build() {
    Column() {
      Tabs() {
        TabContent() {
          Column().width('100%').width('100%').height('100%').backgroundColor(Color.Pink)
        }
        .tabBar(new BottomTabBarStyle($r('sys.media.ohos_app_icon'), "Pink"))

        TabContent() {
          Column().width('100%').width('100%').height('100%').backgroundColor(Color.Green)
        }
        .tabBar(new BottomTabBarStyle($r('sys.media.ohos_app_icon'), "Green"))
      }
      .barHeight(52)
    }
  }
}
```

## 画布组件在绘制文本时设置globalCompositeOperation、fillStyle和globalAlpha属性的效果变更

**变更原因**

使用画布组件（CanvasRenderingContext2D和OffscreenCanvasRenderingContext2D）进行文本绘制时，设置globalCompositeOperation属性和pattern样式的fillStyle属性无效；设置带透明度颜色的fillStyle属性，同时设置globalAlpha属性，文本的透明度仅由globalAlpha决定，不考虑fillStyle属性的颜色透明度。导致绘制效果与W3C标准存在差异，因此需要变更绘制行为。

**变更影响**

**说明**

此变更已做版本隔离，变更仅在应用的targetSdkVersion设置为大于等于5.0.1(13)时生效。

变更前：CanvasRenderingContext2D和OffscreenCanvasRenderingContext2D的globalCompositeOperation属性与fillStyle属性设置的pattern样式在绘制文本时不生效；fillStyle属性设置带透明度颜色并设置globalAlpha属性时，fillText绘制文本的透明度为globalAlpha属性值。

变更后：CanvasRenderingContext2D和OffscreenCanvasRenderingContext2D的globalCompositeOperation属性与fillStyle属性设置的pattern样式在绘制文本时生效；fillStyle属性设置带透明度颜色并设置globalAlpha属性时，fillText绘制文本的透明度为颜色透明度×globalAlpha。

| 使用场景 | 变更前 | 变更后 |
| --- | --- | --- |
| globalCompositeOperation与fillText组合使用 | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/64/v3/SwdQnBB4Q3qXb406GRIbIQ/zh-cn_image_0000002444645289.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=DC2EC54D49C33235FAD7AA1677576067FC9F5FFFF650F779C0271A19359D095F) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/ad/v3/sfubKVUASg6kHQYEc61QRw/zh-cn_image_0000002444725405.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=54251BD9318AB02FFD9934CA5C1DE2B839DCCE489596C3F6AEA89985D4EEE910) |
| fillStyle设置pattern样式与fillText组合使用 | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/e8/v3/tyXbE296Q5GL-sgktRs0vw/zh-cn_image_0000002411046260.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=69DA05C7E77EFB306D9D442208CEB6C23ED1836BD2CEEB9CEDF6E14279C1A94F) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/ee/v3/KLlIrvlmSfKsY9X38qQeyA/zh-cn_image_0000002444725461.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=14622EF2F8457D4A63E48CED1DB2EB83290DB013B018ADD4419712A55D19A491) |
| globalAlpha设置透明度，fillStyle设置带透明度颜色，与fillText组合使用 | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/9b/v3/q7JxagoIT4-A4NTUM3J7LQ/zh-cn_image_0000002411046304.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=5B7D640596AED1364BDACE30D8F7DAC35AA77A39AAE87568341FADE7CCC2DC11) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/99/v3/2SQD7-RcSGWNN8-6ZRi2bA/zh-cn_image_0000002411206180.png?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=2326F6F953EDC06C5637E66001150371636D32C6570D5DFA207639BF688DE486) |

**起始API Level**

8

**变更的接口/组件**

CanvasRenderingContext2D和OffscreenCanvasRenderingContext2D的fillText和strokeText接口。

**适配指导**

若希望在绘制文本时globalCompositeOperation属性保持默认值，需在fillText/strokeText方法前声明context.globalCompositeOperation = 'source-over'；若希望pattern样式在绘制文本时不生效，需在fillText方法前指定所需的fillStyle；若希望文本透明度不受fillStyle颜色透明度的影响，需将fillStyle设置为不透明颜色。

示例：

```
// xxx.ets
@Entry
@Component
struct FillText {
  private settings: RenderingContextSettings = new RenderingContextSettings(true)
  private context: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings)
  private img:ImageBitmap = new ImageBitmap("common/images/icon.jpg")
  build() {
    Flex({ direction: FlexDirection.Column, alignItems: ItemAlign.Center, justifyContent: FlexAlign.Center }) {
      Canvas(this.context)
        .width('100%')
        .height('100%')
        .onReady(() =>{
          this.context.font = '30vp sans-serif'
          this.context.fillStyle = 'rgb(227, 248, 249)'
          this.context.fillRect(0, 0, 150, 150)
          this.context.fillStyle = 'rgb(39, 135, 217)'
          this.context.globalCompositeOperation = 'xor' // 设置globalCompositeOperation为'xor'模式
          this.context.fillText('Hello World', 50, 50) // 生效'xor'模式
          this.context.globalCompositeOperation = 'source-over' // 设置globalCompositeOperation为默认值
          this.context.fillText('Hello World', 50, 150) // 生效'source-over'模式
          let pattern = this.context.createPattern(this.img, 'repeat')
          if (pattern) {
            this.context.fillStyle = pattern // 设置fillStyle为pattern样式
          }
          this.context.fillText('Hello World', 50, 250) // 生效pattern样式
          this.context.fillStyle = '#88FF0000' // 设置fillStyle为带透明度颜色
          this.context.globalAlpha = 0.5 // 设置画布透明度
          this.context.fillText('Hello World', 50, 350) // 透明度为颜色透明度×globalAlpha
        })
    }
    .width('100%')
    .height('100%')
  }
}
```

## NavDestination的Dialog模式默认支持系统动画

**变更原因**

NavDestination的Dialog模式支持系统动画。

**变更影响**

**说明**

此变更已做版本隔离，变更仅在应用的targetSdkVersion设置为大于等于5.0.1(13)时生效。

变更前：NavDestination的Dialog模式，无系统默认动画。

变更后：NavDestination的Dialog模式，默认带有系统转场动画。

| 变更前 | 变更后 |
| --- | --- |
| ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/b4/v3/BRNj3Qz2QDq8vQV_G9ik1Q/zh-cn_image_0000002430747862.gif?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=B8B57E1803CFE47059AF313AD4F7BCF509F1B6E37D5280410778F15DC69F1F21) | ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/47/v3/N5aYO7DgQI6idlqWi692Yw/zh-cn_image_0000002464114981.gif?HW-CC-KV=V1&HW-CC-Date=20260903T083919Z&HW-CC-Expire=86400&HW-CC-Sign=7D7FF89DCA3F0BB274071E1890312FF97793DAA7B221C7F58F8BA93D28C93A8D) |

**起始API Level**

9

**变更的接口/组件**

NavDestination

**适配指导**

开发者可以通过在pop与push接口中设置false关闭NavDestination的系统默认动画。

示例：

```
@Entry
@Component

struct NavigationDemo {
	@State pageInfos: NavPathStack = new NavPathStack();

	@Builder
	pageOneTmp() {
		NavDestination() {
          Text("This is a sample")
            .fontSize(50)
		}
		.title("PageOne")
		.mode(NavDestinationMode.DIALOG)
    .backgroundColor(Color.Blue)
	}

	@Builder
	PageMap(name: string, param: object) {
		if (name === 'pageOne') {
			this.pageOneTmp()
		}
	}

	build() {
		Column({ space: 10 }) {
			Button('Pop Dialog')
			.onClick(() => {
				// Set true to enable system animations, or set false to disable system animations.
				this.pageInfos.pop(true)
			})
			Button('Push Dialog')
			.onClick(() => {
				// Set true to enable system animations, or set false to disable system animations.
				this.pageInfos.pushPath({ name: 'pageOne' }, true)
			})
			Navigation(this.pageInfos) {
				Column({ space: 10 }) {
					Text("This is navigation").fontSize(60).align(Alignment.Center)
				}
			}
			.height(500)
			.backgroundColor(Color.Grey)
			.navDestination(this.PageMap)
		}.height(50)
	}
}
```
# 按Kit分类的废弃API迁移说明与样例

由废弃流程D05/D07按准确命中接口读取。Context/UIContext的获取、注入、服务及全局UI接口替换集中于[Context迁移专题](context-migration.md)。

以下代码分别展示迁移前后模块或函数，只表示已满足替代版本前提的接口变化；完整低版本处理引用[兼容指南](../common/compatibility.md#迁移调用的版本与回退)，异常/Promise/失败传播引用[编码规范](../common/arkts-coding-standards.md#异常异步与-api-迁移)。表中版本对应准确接口与重载，不能将废弃版本当作替代起点。片段不表示设备验证通过。

| Kit | 接口条目 |
| --- | --- |
| ImageKit | [ImagePacker编码](#imagepacker编码) |
| AudioKit | [音量订阅与取消](#音量订阅与取消)、[音量读取](#音量读取) |
| LocalizationKit | [Intl日期格式化](#intl日期格式化)、[ResourceManager媒体资源](#resourcemanager媒体资源) |

## ImageKit

### ImagePacker编码

#### 接口说明

适用：ImagePacker对PixelMap编码的Promise重载。

| 旧接口 | 替代接口 | 版本信息 |
| --- | --- | --- |
| `packing(source: PixelMap, option: PackingOption): Promise<ArrayBuffer>` | `packToData(source: PixelMap, options: PackingOption): Promise<ArrayBuffer>` | 旧since8、deprecated13，新since13 |

ImageSource另有对应Promise重载（新since13）；旧callback重载不能只换方法名，须按真实消费者另行迁移。`packing(Picture, ...)`不是本条旧PixelMap重载，不据同名批量替换。

#### 迁移前

```ts
import { image } from '@kit.ImageKit';

function encodeImage(packer: image.ImagePacker, source: image.PixelMap): Promise<ArrayBuffer> {
  const options: image.PackingOption = { format: 'image/jpeg', quality: 1 };
  return packer.packing(source, options);
}
```

#### 迁移后

```ts
import { image } from '@kit.ImageKit';

function encodeImage(packer: image.ImagePacker, source: image.PixelMap): Promise<ArrayBuffer> {
  const options: image.PackingOption = { format: 'image/jpeg', quality: 1 };
  return packer.packToData(source, options);
}
```

#### 接口差异

此重载仍返回Promise<ArrayBuffer>；编码参数、源PixelMap、返回数据和调用方的await/then/外层返回契约保持。packer由调用方持有，释放顺序不因替换改变；不在异步编码完成前释放PixelMap。新声明存在准确throws，按公共规范及原调用边界核对，不能把名字替换当异常等价证明。

## AudioKit

### 音量订阅与取消

#### 接口说明

适用接收者均为`audio.AudioVolumeManager`，不是AudioVolumeGroupManager。

| 旧接口 | 替代接口 | 版本信息 |
| --- | --- | --- |
| `on('volumeChange', Callback<VolumeEvent>)` | `on('streamVolumeChange', StreamUsage, Callback<StreamVolumeEvent>)` | 旧since9、deprecated20，新since20 |
| `off('volumeChange', Callback<VolumeEvent>?)` | `off('streamVolumeChange', Callback<StreamVolumeEvent>?)` | 旧since12、deprecated20，新since20 |

#### 迁移前

```ts
import { audio } from '@kit.AudioKit';
import { Callback } from '@kit.BasicServicesKit';

function watchVolume(manager: audio.AudioVolumeManager, consume: (volume: number) => void): () => void {
  const changed: Callback<audio.VolumeEvent> = (event: audio.VolumeEvent): void => {
    consume(event.volume);
  };
  manager.on('volumeChange', changed);
  return (): void => {
    manager.off('volumeChange', changed);
  };
}
```

#### 迁移后

```ts
import { audio } from '@kit.AudioKit';
import { Callback } from '@kit.BasicServicesKit';

function watchVolume(manager: audio.AudioVolumeManager, consume: (volume: number) => void): () => void {
  const changed: Callback<audio.StreamVolumeEvent> = (event: audio.StreamVolumeEvent): void => {
    consume(event.volume);
  };
  manager.on('streamVolumeChange', audio.StreamUsage.STREAM_USAGE_MUSIC, changed);
  return (): void => {
    manager.off('streamVolumeChange', changed);
  };
}
```

#### 接口差异

示例只适用于原业务需要媒体流音量的场景；具体usage按业务选择。订阅新增StreamUsage，取消接口不接受该参数。返回的清理函数继续使用同一manager、同一回调对象；调用方在原生命周期调用它，不能另建回调取消。旧事件与新事件是不同类型，不用断言互转。原有handleVolumeProgressChange、音量归一化和UI更新留在consume或其原位置，音量归一化使用原业务规则，不统一除以固定值。枚举选择非废弃的STREAM_USAGE_MUSIC，不新增已废弃STREAM_USAGE_MEDIA。

### 音量读取

#### 接口说明

适用：原默认音量组中的媒体音量，可以按真实业务改为媒体usage读取；自定义音量组或其他AudioVolumeType不能机械套用。

| 旧接口与接收者 | 替代接口与接收者 | 版本信息 |
| --- | --- | --- |
| `AudioVolumeGroupManager.getVolumeSync(AudioVolumeType): number` | `AudioVolumeManager.getVolumeByStream(StreamUsage): number` | 旧since10、deprecated20，新since20 |

#### 迁移前

```ts
import { audio } from '@kit.AudioKit';

async function readMusicVolume(manager: audio.AudioVolumeManager): Promise<number> {
  const group = await manager.getVolumeGroupManager(audio.DEFAULT_VOLUME_GROUP_ID);
  return group.getVolumeSync(audio.AudioVolumeType.MEDIA);
}
```

#### 迁移后

```ts
import { audio } from '@kit.AudioKit';

async function readMusicVolume(manager: audio.AudioVolumeManager): Promise<number> {
  return manager.getVolumeByStream(audio.StreamUsage.STREAM_USAGE_MUSIC);
}
```

#### 接口差异

新方法放在AudioVolumeManager上，不加到旧group接收者。两个读取方法自身都同步返回number；此示例保留外部函数原有Promise<number>契约，不强制改变全部调用者。其他同步调用位置仍保持同步形态，不为了复用本例额外异步化。原音量值消费者和失败传播继续保留。

## LocalizationKit

### Intl日期格式化

#### 接口说明

适用：现有静态缓存用`zh-CN`、`weekday: 'short'`并调用format的具体日期格式化场景。旧Kit导出intl，新接口属于语言内置Intl，不能从Kit导入另一个同名对象。

| 旧接口 | 替代接口 | 版本信息 |
| --- | --- | --- |
| `new intl.DateTimeFormat(locale, options)` | `new Intl.DateTimeFormat(locales, options)` | 旧有参构造since6、deprecated20；替代为语言内置Intl.DateTimeFormat |

语言内置Intl不使用同一HarmonyOS @since标注，不能假定统一的API起始版本。[OpenHarmony4.1上游runtime具体用例](https://raw.githubusercontent.com/openharmony/arkcompiler_ets_runtime/OpenHarmony-4.1-Release/ecmascript/builtins/tests/builtins_date_time_format_first_test.cpp)仅支持此限定用法的证据分析，不冒充商业API13最低设备验收；当前SDK声明及编译也不替代最低设备运行。

#### 迁移前

```ts
import { intl } from '@kit.LocalizationKit';

class WeekFormatter {
  private static formatter: intl.DateTimeFormat =
    new intl.DateTimeFormat('zh-CN', { weekday: 'short' });

  static format(date: Date): string {
    return WeekFormatter.formatter.format(date);
  }
}
```

#### 迁移后

```ts
class WeekFormatter {
  private static formatter: Intl.DateTimeFormat =
    new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });

  static format(date: Date): string {
    return WeekFormatter.formatter.format(date);
  }
}
```

#### 接口差异

缓存身份、初始化时机、locale/options、输入日期及字符串消费者不变。移除该具体场景不必要的探测函数、双缓存、weekdayMap或仍使用小写intl的旧回退；不泛化到其他locale、options、Intl接口或加载方式。商业最低设备仍列待验收，未知版本事实不伪造。

### ResourceManager媒体资源

#### 接口说明

适用于将Resource参数重载迁移为资源ID重载的媒体资源读取；原已使用数字ID的调用无需重复修改。

| 旧接口 | 替代接口 | 版本信息 |
| --- | --- | --- |
| `getMediaContent(resource: Resource): Promise<Uint8Array>` | `getMediaContent(resId: number): Promise<Uint8Array>` | 两者since9；旧deprecated20，新非废弃 |
| `getMediaContent(resource, density): Promise<Uint8Array>` | `getMediaContent(resId, density): Promise<Uint8Array>` | 两者since10；旧deprecated20，新 |
| 对应Resource+callback重载 | 对应resId+callback重载 | 无density两者since9，带density两者since10；保持原callback形态 |

#### 迁移前

```ts
import { resourceManager } from '@kit.LocalizationKit';

function readMedia(manager: resourceManager.ResourceManager, media: Resource): Promise<Uint8Array> {
  return manager.getMediaContent(media);
}
```

#### 迁移后

```ts
import { resourceManager } from '@kit.LocalizationKit';

function readMedia(manager: resourceManager.ResourceManager, media: Resource): Promise<Uint8Array> {
  return manager.getMediaContent(media.id);
}
```

#### 接口差异

原Resource对应同一个Resource.id，不能改成其他业务对象的ID；manager、资源选择和Uint8Array消费者保持。带density及callback的调用保留原density、回调、错误边界和返回形态，不改成Promise或丢参数。跨bundle/module的Resource不能只丢弃定位信息：确认当前manager能解析该ID，否则改用实际匹配资源管理器或保留待决策/缺口，不机械抽取id。准确Resource和参数类型以SDK及真实调用为准。

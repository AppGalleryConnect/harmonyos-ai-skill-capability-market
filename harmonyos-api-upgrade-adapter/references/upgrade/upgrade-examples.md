# 行为变更的常见适配案例

本页维护30个独立变更的索引与通用判断规则，正文按变更身份独立保存。扫描命中不等于必须修改；默认尽量保持升级前的功能、视觉和交互。

## 如何定位和阅读

1. 按真实变更ID、完整名称、精确版本和来源核对下列主案例索引。名称不缩写，接口大小写和完整描述保留；不能只用关键词或policyId哈希当作扫描Rule ID。
2. 准确命中时，分类前读取链接指向的**独立案例全文**，再核对完整官方章节、准确SDK及真实源码/配置。索引的判断重点只是导航，不能代替正文；没有命中或身份冲突时回到官方资料定位，不为套案例猜造身份。
3. 有扫描Rule ID时用真实ID；当前规则包未提供扫描ID时，以准确官网章节锚点补位并明确标注。官方锚点不证明scanner已经覆盖，原始Rule ID/Source Reference及精确通道仍保留原值，不从案例回填扫描事实。
4. 独立正文仅按已准确匹配的路径读取，不用通配符或整目录批量载入未命中案例；不逐项回答无关问题。跨系统处理见[target升级兼容](upgrade-compatibility.md)，HAR另读[宿主专题](har-upgrade.md)。

标题统一为“变更ID-变更条目完整名称”。版本、身份来源与官方章节在正文单独保留；旧主题锚点只作为索引入口。版本别名按[版本契约](../common/sdk-versions.md)核对，不能丢失Beta/Release或把原始版本全部改为目标版本。

## 案例索引

| 变更身份及完整名称 | 变更版本 | 主要判断与检索线索 |
| --- | --- | --- |
| <a id="参数扩展与重编译"></a>[383-文本与输入、信息展示、按钮与选择、滚动与滑动、图形绘制组件接口支持Resource类型](examples/383.md) | 6.0.0(20) Beta1 | 原实参与派生类型；新增Resource能力不强制替换原参数 |
| <a id="arkui-仅支持-stage-模型"></a>[CH2026010615012-ArkUI接口新增仅支持Stage模型的约束](examples/ch2026010615012.md) | 26.0.0 Beta1 | FA/Stage应用和注册模块；独立应用、HAR宿主不能互代 |
| <a id="text-选择菜单"></a><a id="dialog-与-toast-材质"></a>[CH2026032761266-Dialog、Toast、AlphabetIndexer和文本选择菜单默认开启沉浸式系统材质](examples/ch2026032761266.md) | 26.0.0 Beta1 | 有效背景等覆盖、Text.copyOption；局部与应用级材质取舍 |
| <a id="button-热区"></a>[CH2026031846233-表单类组件触摸热区最小高度变更](examples/ch2026031846233.md) | 26.0.0 Beta1 | SMALL/类按钮、自定义高度或热区、Chip能力限制 |
| [252-Image组件的borderRadius接口支持动态修改](examples/252.md) | 5.0.2(14) Beta1 | borderRadius实参是否随状态改变；保留状态用途 |
| <a id="button-默认圆角与适老化"></a>[174-按钮默认值变更为新增圆角矩形类型](examples/174.md) | 5.1.0(18) Release | 未配置默认不跟随系统字体、实际放大场景、原有类型样式 |
| [CH2025062517095-CanvasRenderer的font接口支持自定义字体行为变更](examples/ch2025062517095.md) | 6.0.0(20) Beta2 | Canvas字体family与完整font表达式，保留字号字重 |
| [CH2025042447120-ArkUI双指长按行为变更](examples/ch2025042447120.md) | 5.1.0(18) Release | 实际双指长按业务、fingers最少手指数及系统接管 |
| [153-属性动画onFinish结束回调在UIAbility退后台时因有限循环动画被终止而提前触发](examples/153.md) | 5.0.1(13) Beta3 | 有限动画退后台、onFinish业务副作用与时序 |
| [198-修复zIndex接口会影响组件在3D变换中的透视效果的错误行为](examples/198.md) | 5.0.2(14) Beta1 | zIndex层叠与实际3D透视依赖 |
| <a id="无限循环动画"></a>[CH2025051459281-动画接口在播放次数为无限循环时的行为变更](examples/ch2025051459281.md) | 5.0.1(13) Release | iterations=-1与首次布局同步回调，勿混入有限动画变化 |
| [CH2025050827493-NavDestination的Dialog模式默认支持系统动画](examples/ch2025050827493.md) | 5.0.1(13) Release | Dialog模式、push/pop动画实参与原target基线 |
| [CH2025040590071-播放器所使用的内存归属变更](examples/ch2025040590071.md) | 6.0.0(20) Beta1 | 同时工作实例、真实生命周期、后台内存与业务用途 |
| [159-CanvasRenderingContext2D方法传NaN和Infinity值后执行的其他绘制方法由不绘制变更为正常绘制](examples/159.md) | 5.1.0(18) Release | NaN/Infinity来源、准确Canvas方法及后续绘制依赖 |
| [CH2026022422576-组件的阴影模糊半径规格变更](examples/ch2026022422576.md) | 26.0.0 Beta1 | 完整阴影接口清单、radius/偏移组合与textShadow排除 |
| <a id="页面退出与组件释放"></a>[337-页面退出场景自定义组件删除前移](examples/337.md) | 5.1.0(18) Release | 默认退出动画、aboutToDisappear节点操作与复用时机 |
| <a id="消失节点的转场属性"></a>[CH2025051729493-禁止在转场动画过程中，更新消失节点的属性。](examples/ch2025051729493.md) | 5.0.1(13) Beta3 | 节点开始消失前的属性更新与数据有效期 |
| <a id="内置文本布局"></a>[CH2026032801249-内置文本的组件文本样式优化](examples/ch2026032801249.md) | 26.0.0 Beta1 | 内置文本组件范围、系统语言、长文案与固定约束 |
| <a id="gridrow--gridcol显式保留断点补全结果"></a>[CH2025040702131-GridRow组件columns参数和GridCol组件span参数默认值变更](examples/ch2025040702131.md) | 6.0.0(20) Beta1 | 启用断点、columns/span补全与真实窗口宽度 |
| [CH2026032364747-List组件onScrollVisibleContentChange事件行为变更](examples/ch2026032364747.md) | 26.0.0 Beta2 | 有数据转空、start/end.index消费及有效索引校验 |
| [CH2025092048488-Progress组件color属性设置渐变色规格变更](examples/ch2025092048488.md) | 6.1.0(23) | Linear/Capsule与真实LinearGradient参数 |
| <a id="heif-与-heic-mime"></a>[238-image接口Heif格式类型变更](examples/238.md) | 5.0.2(14) Beta1 | 六类接口、参数/返回消费与已兼容结构体 |
| [263-bindSheet半模态面板视觉样式增加](examples/263.md) | 5.0.2(14) Beta1 | 实际窗口宽度、preferType与面板布局意图 |
| [393-bindSheet在2in1设备中默认避让窗口安全区](examples/393.md) | 6.0.0(20) Beta1 | 2in1形态、安全区/标题栏、面板样式与内容约束 |
| [373-修复blendMode接口离屏模式会影响组件设置的不透明度的问题](examples/373.md) | 5.1.0(18) Release | OFFSCREEN与opacity组合、局部补偿的子树影响 |
| [372-XComponent设置为Texture模式使用blendMode接口的行为由不生效变更为正常生效](examples/372.md) | 5.1.0(18) Release | Texture模式、blendMode取值与原渲染需求 |
| <a id="video-拖入播放"></a>[283-Video组件不再默认解析并自动播放拖拽信息中的视频资源](examples/283.md) | 5.0.1(13) Release | Video拖入数据、准备后启动、失败/取消/切源意图清理 |
| <a id="list-首次定位"></a>[279-List组件首次创建布局时，Scroller控制器的跳转方法优先级变更为高于initialIndex的优先级](examples/279.md) | 5.0.2(14) Beta1 | initialIndex与首次布局前Scroller定位的竞争 |
| [section126372211-沉浸光感新增生效约束](examples/anchor-section126372211.md)（官方锚点） | 26.0.0 Release | 沉浸光感完整例外清单、标题栏/底部TabBar区域 |
| <a id="imageautoresize显式保留所需解码策略"></a>[ch2026082810311-Image组件autoResize属性默认行为变更](examples/anchor-ch2026082810311.md)（官方锚点） | 26.0.0 Release | 5000万像素门槛、动态图片、画质与内存取舍 |

## 条件判断与最小方案

- 先区分设备行为版本、官方target隔离和业务触发条件，再核对应用/模块配置与调用级参数。原显式配置已覆盖变化时说明具体依据，不统一添加参数或版本分支。
- 未触发或已满足指导时记录无需适配，不写成“接受新行为”；受影响也不等于必须修改。已有证据破坏所需业务、契约或编译时才判必须适配，业务选择与证据缺口分别保留。
- 搜索无结果、没写某属性、一个数值或一张截图不能单独证明条件未触发。沿资源引用、共享样式、状态及调用链核对；不明时在现有reason/evidence写清缺口和下一步。
- 能力扩展不强制替换原有实参；官方只要求重编译时记录真实构建需求，不制造源码差异。案例补充简略指导，遇到SDK、官方原文和案例冲突时保留差异并核实，不机械套用。

每个独立案例统一为“来源与版本、旧新行为、影响条件与工程核查、受影响与不受影响示例、最小方案与边界、验证与证据缺口”六部分。结构统一但不要求篇幅相同，也不为无需修改场景制造适配代码。

## 漏扫案例的排错入口

以下4项由[漏扫案例](scanner-missed-cases.md#按错误或异常检索)维护，**不属于上表的正常命中阅读路由**。只有真实build error或用户明确报告对应混淆/发布包异常时，按错误线索查阅；正常扫描、CSV零行或构建成功且无异常时不主动逐项排查，不向原CSV补行。

| 变更身份及完整名称 | 查阅条件与唯一正文 |
| --- | --- |
| CH2025071721132-使用字面量初始化CustomDialogController类实例导致的编译行为变更 | [真实控制器类型缺成员/字面量初始化诊断](scanner-missed-cases.md#customdialogcontroller-字面量初始化) |
| section1025661813478-新增状态管理V1校验报错（官方锚点） | [V1装饰器用于函数字段的准确诊断](scanner-missed-cases.md#状态管理-v1-函数字段) |
| section162648113588-编译构建对卡片引用HSP增加校验（官方锚点） | [卡片入口及直接/传递HSP依赖诊断](scanner-missed-cases.md#卡片引用-hsp) |
| 339-默认不合并依赖混淆规则变更说明 | [用户明确报告依赖混淆/发布异常](scanner-missed-cases.md#依赖混淆规则合并) |

## 修改结果与代码证据

MODIFIED必须关联本行真实业务差异，不能把日志、格式、根target或同文件无关变化算作API修复。NO_CHANGE写清实际取值及未触发/已满足指导的理由。分类不等于批准，编译错误查到案例也不证明scanner命中，不改变原始行和分类分母。

代码片段须合入已有组件和业务上下文，不是统一替换模板。按[编码规范](../common/arkts-coding-standards.md)保留返回、回调、异常和生命周期，模型评估、真实构建、功能和视觉结果分别记录；构建通过不能替代设备语义验证。

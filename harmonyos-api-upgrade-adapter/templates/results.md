# 逐行结果与统计模板

在当前主流程解析后建立，每文件处理后更新，交付时回读核对。两类结果均保存为功能目录中的新文件adapted-results-<批次ID>.csv，以outputLayout.adaptedCsv为准；复用扫描批次的12位随机ID，继续任务保持同名，不再新建results.csv。原始扫描表单独保留在同一功能目录，字节保持原样。结果表保留逻辑行序和全部重复记录。目录、导入与历史输入规则见[进度模板](progress.md#建议目录)。

## 推荐数据流：直接从分组输出

```console
node "<skill-root>/scripts/csv/cli.mjs" prepare --task "<绝对taskFile>" --project "<工程>" --mode upgrade
node "<skill-root>/scripts/csv/cli.mjs" inspect --task "<绝对taskFile>" --project "<工程>" --mode upgrade
node "<skill-root>/scripts/csv/cli.mjs" inspect --task "<绝对taskFile>" --project "<工程>" --mode upgrade --group "<实际分组ID>" --output "<分组只读输入JSON>"
node "<skill-root>/scripts/csv/cli.mjs" validate --task "<绝对taskFile>" --project "<工程>" --mode upgrade
node "<skill-root>/scripts/csv/cli.mjs" write --task "<绝对taskFile>" --project "<工程>" --mode upgrade
```

废弃流程将 mode 改为 deprecated。prepare 依据同批原始扫描及已登记的扫描JSON证据生成分组骨架、完整rowId与进度引用，不覆盖已有判断；废弃由模型编辑[分组逐行记录](progress.md#分组示例)；行为按[固定评估接收与处理更新](assessment-results.md)生成草稿、接收评估、记录明确批准、更新处理，不编写临时JS/Python生成判断数据，也不另派更新agent。评估完成及处理结果更新后运行validate，再write。validate返回validationScope=STRUCTURE_ONLY，只证明身份、归属、字段和覆盖结构一致；pendingCount=0不证明每个调用已经实际阅读或语义正确。默认pendingGroups仅列待处理分组的id、record、rowCount和pendingCount；零待处理时为空数组。write默认使用outputLayout.adaptedCsv，另存可传--output，废弃历史列前缀仍传--column-prefix。

待处理非零时用固定入口保存明细，不写shell计数或临时Python：

```console
node "<skill-root>/scripts/csv/cli.mjs" validate --task "<绝对taskFile>" --project "<工程>" --mode upgrade --details --output "<只读诊断JSON>"
```

--details增加pendingRows，按原始CSV顺序逐行列出完整rowId、groupId、record、category、outcome、next和pendingFields。pendingFields为outcome/next/category中实际触发计数的字段名，可能同时有多个，但同一行只计一次；废弃没有分类时category为null。未解决状态、非空next、行为待分类均可导致待处理，NO_CHANGE也可能因next非空被计数，不是只统计字面PENDING，不是缓存。诊断只说明事实，不自动清字段、改分类或替业务作决定。

--output自动创建父目录，文件为{ok,result}完整JSON，stdout返回含output、rowCount、pendingCount的简短回执；保护任务/原始扫描/分组/源码输入，相同内容可重试，不同内容另存，规则与inspect只读导出一致。不扫描目录中额外的-input/-eval等文件作为判断来源，只读取progress登记的分组。

rowResults中的outcome按既有规则映射结论；处理说明保留原reason、resolution处理/验证说明和实际changes，后续事项来自next，尚未评估明确待办。文件级outcome和报告中的旧分类均不作为替代来源。工具校验原始行身份、所属分组、重复和完整覆盖；category/outcome混用及跨来源矛盾报错到工程、文件、rowId及允许值。

行为指定分组inspect另返回当前groupSha256和已接收的assessmentSha256，后续操作复用真实返回值，不用内联脚本自行计算。

任务inspect默认返回分组概要、文件与行数，不返回整表原始数据。--group使用prepare/inspect返回的实际ID，返回该组完整rows，逐项含rowId、codeLocation、apiDefinition、physicalFile、line；精确版本与来源写在result.group上，行里只在与本组不同时才出现version、sourceReference，column和gaps只在有值时出现；单组结果不带规则包未覆盖条目明细，明细从不带--group的概要读取；`RNOH-` 分组另带 result.rnoh（本组框架依据、RNOH 版本与形态、各层核对情况和缺口），其他分组没有这个字段；重复位置仍有独立行，未知身份保留独立分组。调用位置必须按原始rowId关联，不将files.locations去重数组与rowResults按顺序拼接。--output自动创建父目录，文件为完整{ok,result}JSON，stdout只返回文件回执；不覆盖任务、原扫描、分组或源码输入，已有相同内容复用，不同内容另存。评估agent直接读取该文件的result，不再现场写shell循环或读取整批分组来重建身份。

原--scan/--results格式化接口继续服务独立/历史数据；任务主流程不再手工准备一份重复的逐行结果JSON。以下格式化契约和兼容调用保持。

## 扫描输入列与完整证据

### 历史 CSV 编码

`import-csv` 支持 `--encoding auto|utf-8|gb18030`，默认 auto：有 UTF-8 BOM 时严格按 UTF-8，无 BOM 时先严格 UTF-8，再严格 GB18030（兼容 GBK）。非法字节、损坏的 BOM 内容及不支持的 UTF-16/UTF-32 BOM 会报错，不用替换字符继续。两种编码均合法时优先 UTF-8，已知原编码时显式指定。GB 解码需要 Node 的 ICU 支持；工具使用真实字节解码，缺能力时明确报错。

导入回执的 csv 保存确定编码、BOM 和解析摘要；原件及 rowId 仍使用原始字节。任务的 inspect 返回 encoding/bom，后续评估、CSV/HTML 和 runtime 复用确定编码，不重新猜测；分组准备后改变解码解释会拒绝。仅兼容编码，不翻译或猜测表头。纯 CSV 缺少 Rule ID/来源的身份缺口仍按原流程保留。

独立 `csv inspect/write --scan` 默认严格 UTF-8，可追加 `--encoding auto|utf-8|gb18030`；任务模式不能覆盖编码。行为结果统一 UTF-8 BOM＋CRLF；废弃的 UTF-8 输入延续现有 BOM/换行，GB 输入则转为 UTF-8 BOM＋CRLF。所有结果表按 UTF-8 回读，原件不转码。

新行为扫描表有 8 列，依次为 Api Definition、Language、Changed in SDK、Affected Versions、Title、Code Location、Change Type、Rule ID。新废弃扫描表有 8 列，依次为 Api Definition、Language、Changed in SDK、Title、Code Location、Fixed、Change Type、Replacement API。历史导入表保留全部原始字节。

废弃扫描及适配 CSV 的 Title 输出纯文本标题；历史输入中的 HYPERLINK 仅在生成适配表时提取显示文字，仍按输入原始字节计算 rowId，其他字段、行序和重复记录保持。来源 URL 从同批扫描 JSON 和真实声明证据取得；只有纯文本 CSV 时补查准确 SDK，不从标题猜链接。对应检查及报告兼容历史超链接标题和纯文本标题，行为 CSV 的超链接保持原格式。

详细来源、列号、符号、废弃时间和替代依据从同批次扫描 JSON 读取；核对批次、模式、可见字段及重复计数。rowId 仍由原始字节哈希和逻辑行序号产生，行为只在内部进度、分组和报告中保存，废弃继续保留 CSV 的 Row ID 列；不用精简后的显示值去重。仅有 CSV 时按当前功能补证，无法唯一确认则记录证据缺口。

<a id="行为结果只追加三列"></a>

## 行为结果与可选测试截图

行为结果表从原始扫描表投影，去掉 `Fixed`，保留其余原列、字段值、行序和重复记录。末尾依次追加下表四列，常规结果为 12 列。设备测试通过本轮 runtime 审计投影将 `测试截图` 放到最后，共 13 列。内部行 ID 和详细证据保存在进度、分组及报告中。

| 列 | 内容 |
| --- | --- |
| 评估结论 | 按行 ID 读取分组 `rowResults.category`，显示无需适配、可选适配、必须适配或待分类。内部分组的范围外在交付时归入无需适配 |
| 处理结论 | 无需适配、已适配、待决策、未实施 |
| 处理说明 | 必填本调用的具体理由。已适配同时说明实际修改及其作用。CSV 导出将单元格内换行合成单行，HTML 保留完整依据的段落 |
| 后续事项 | 待答复、待补证据、编译或人工验证的具体事项；没有待办时留空 |

内部状态与 CSV 展示分别维护，模型完成逐行判断后按下表提供结果；格式化函数不推断业务结论。

历史 CSV 可保留原多行说明。核对时接受原文或当前单行形式，范围外旧标签仅在内部分类同为范围外时匹配。审批、待办和设备测试选择读取内部分类。

| 内部状态 | 行为CSV处理结论 | 说明要求 |
| --- | --- | --- |
| NO_CHANGE | 无需适配 | 已核实未触发、已符合要求、仅需重编译，或用户明确接受新行为 |
| MODIFIED | 已适配 | 已实施本行相关的获批修改；根target或无关改动不计入；不代表编译或设备通过 |
| NOT_IMPLEMENTED | 未实施 | 用户明确选择不实施，保留原评估分类和真实答复，不安排修复验收 |
| OUT_OF_SCOPE | 无需适配 | 已确定范围外，保留原因；真实待办仍列出 |
| PENDING / DECISION_REQUIRED / EVIDENCE_GAP | 待决策 | 说明未评估、待答复、证据不足或其他未完成原因，并写清下一步 |

已适配但未编译、编译失败或所需验证未完成时，在后续事项明确记录；总报告仍为部分完成。设备验证未选择时如实说明未执行，不冒充验收通过，也不擅自扩大范围。MODEL_ASSESSED、rowId、业务影响、兼容分析、变更文件和详细证据保留在进度、分组及报告中；必要的修改理由写入处理说明，未解决事项写入后续事项，不因删列丢失事实。三类适配必要性与内部处理状态分别统计，不能从四个展示值反推。

### 测试截图列

任务设备测试使用runtime csv的--task/--project入口读取当前分组，不提供逐行处理JSON；内部使用formatUpgradeResults(scanBytes, results, {screenshots})。screenshots是当前来源的rowId到多行字符串映射，由runtime的screenshots-by-source.json生成。每行列出before/after、caseId/captureId和实际业务图片相对路径；未执行、非视觉或未选行留空，不用诊断图补齐。建议直接使用[测试工具](../references/common/runtime-contracts.md)的csv命令重新审计后输出。结果表保留评估与处理两种结论，截图列位于末尾。

### 格式化接口与文件调用

复用 [formatUpgradeResults](../scripts/shared/format/upgrade-results.mjs)：`formatUpgradeResults(scanBytes, results, {sourceEncoding})` 返回 CSV 文本。scanBytes 必须是直接 readFile 得到的原始 Buffer，sourceEncoding 默认 utf-8，历史 GB 输入传入已确定的 gb18030；results 是对象数组，每项含 `rowId`、`处理结论`、`处理说明`、`后续事项`，可另提供 `评估结论`。独立写表缺少 `评估结论` 时填待分类。rowId 为该 Buffer 的完整 SHA-256 加 `:` 和从1开始的逻辑数据行序号。结果输入可以乱序，输出始终跟随扫描行序；重复扫描行仍需不同 rowId。缺失、重复、未知身份、非法结论、空理由、重复表头或已有同名处理列均报错，不能加前缀生成更多列。

兼容独立输入时，模型可提供 UTF-8 JSON 数组（可带 BOM）；任务模式直接从分组投影，无需另写该数组。直接运行内置 [CSV 工具](../scripts/csv/cli.mjs)，无需在任务目录创建格式化脚本，不使用临时 Python/Node 脚本猜列名或统计文件。

```console
node "<skill-root>/scripts/csv/cli.mjs" inspect --mode upgrade --scan "<原扫描CSV>" --project "<工程>" --scan-json "<同批扫描JSON>"
node "<skill-root>/scripts/csv/cli.mjs" write --mode upgrade --scan "<原扫描CSV>" --results "<逐行结果JSON>" --output "<outputLayout.adaptedCsv>"
```

`inspect` 返回真实 headers、原始 cells、完整 rowId、展示标题及链接、规则/精确版本分组、物理文件分布和 statistics。文件从 Code Location 的文件部分解析（支持 :行号 和 :行号:列号），按根注册映射模块名，不能读取不存在的 File Path 列，也不能将每个调用位置算作一个文件。重复行保留独立 rowId；规则身份优先 Rule ID，缺失时用可验证 Source Reference，均与 Changed in SDK 组合。缺文件、路径越界及身份不明保留逐行 gaps，对应无法确认的总数为 null，不能把未知算零。

同批 JSON 按 upgrade findings 行序或 deprecated actionGroups 导出顺序核对全部可见字段、行数和重复次数；批次可从标准扫描文件名核对。仅 CSV 时仍返回行和文件事实，缺少身份的行独立保留，等待补证。`inspect` 不作业务评估，也不替代废弃的准确 SDK 符号归组。

`write` 只校验并序列化模型提供的结果；输入路径不能与输出为同一物理身份。使用原子写入和短暂占用重试，持续占用提示关闭 Excel/WPS 后按原路径重试；保留原输入与旧结果，不换批次ID、不宣称写入成功。任务模式只更新仍与上次生成哈希一致的自有结果；用户修改或未知来源文件自动另存，progress.delivery.adaptedCsv记录真实路径，报告和verify随之读取。行为统一 UTF-8 BOM 和 CRLF，原扫描字节不改；设备截图继续使用 runtime csv 命令重新审计后输出，不接受手填截图索引。

## 废弃结果：保留原有新增列

| 列 | 内容 |
| --- | --- |
| Row ID | 输入原始CSV实际SHA-256 + 从1开始的逻辑数据行序号，不含表头 |
| 处理结论 | PENDING / MODIFIED / NO_CHANGE / DECISION_REQUIRED / EVIDENCE_GAP / OUT_OF_SCOPE |
| 处理来源 | MODEL_ASSESSED；不是自动SDK或语义证明 |
| 业务影响 | 本业务中的具体变化 |
| 处理说明 | 实际修改、无需修改理由或缺什么 |
| 兼容性说明 | 废弃迁移的接口保护 |
| 变更文件 | 实际相关差异，不把根target更新当每条API修复 |
| 验证证据 | 真实命令日志、复扫、包信息或用例/截图路径；未执行写明 |
| 后续事项 | 业务决定、证据缺口或未完成验证 |

废弃逐行 JSON 每项使用 rowId 和上表除 Row ID 外的全部中文字段，处理来源必须为 MODEL_ASSESSED，处理说明必填具体理由，其他文本字段无内容时用空字符串。Row ID 由工具根据输入原始字节生成。

```console
node "<skill-root>/scripts/csv/cli.mjs" inspect --mode deprecated --scan "<原扫描CSV>" --project "<工程>" --scan-json "<同批扫描JSON>"
node "<skill-root>/scripts/csv/cli.mjs" write --mode deprecated --scan "<原扫描CSV>" --results "<逐行结果JSON>" --output "<outputLayout.adaptedCsv>"
```

废弃输入已存在同名结果列时，write 增加 `--column-prefix "<本轮ID>"`，所有新增列统一为“本轮ID 空格 原列名”；已有同一前缀仍报错，不能覆盖旧列。重复表头、格式不完整时报告并保留原件，不让Object映射静默吞列。CSV含引号、逗号、单元格换行和HYPERLINK时使用可靠解析器，可复用scripts/shared/format/csv.mjs；不要按行号拆文本或split(',')。废弃输出保持原BOM/换行格式或明确记录可验证的格式转换，语义和行序不变。

## 内部状态与废弃CSV结论规则

- MODIFIED：模型完成与该行相关的实质修改，有具体差异及兼容理由；仅表示已修改，不表示已验证完成。只有格式/日志/根配置变化不算该API修复。
- NO_CHANGE：已读准确来源与真实代码，说明未触发、已符合指导或仅需重编译；不是省略用户要求的功能验证。
- DECISION_REQUIRED：具体业务取舍、方案和影响等待决定。
- EVIDENCE_GAP：缺来源/声明/源码/上下文或真实工具证据，说明已检查和下一步。
- PENDING：尚未处理或相关证据/文件变化后待复核；不能用旧通过补齐。
- OUT_OF_SCOPE：其他功能、区间或选择范围之外，明确原因，不删行。

## 核对与口径

输出逻辑行数必须等于输入，内部 rowId 唯一，原列逐行对应；废弃另核对 CSV 的 Row ID 列，行为不导出该列。选中范围的每行恰有当前结果，不遗漏重复行、不代填未知行。使用内置 inspect 读取和统计；行为格式化函数只校验和序列化已评估结果，不承担适配状态、业务判断或报告执行。

扫描外发现另列修改位置、批准和证据，不挤占扫描表分母、不伪造rowId，也不能仅因行号不相同就忽略与真实调用有关的共享修改。810行全NO_CHANGE且另有1处扫描外修改时，原表仍为810行无需适配，扫描外1处单列；是否属于同一调用链依据代码关联判断。

分别报告原始行、选中行、已评估行、待处理/待决策/缺口、范围外行、去重Code Location、唯一物理文件、准确变更数和变更文件工作单元。已评估包括有明确决定或缺口的行，但问题解决数不能把这些行算成功。唯一文件按实际物理路径归一，工作单元按变更身份/版本+物理文件；注册名与srcPath不一致时按实际根配置映射。

各功能只记录当前职责要求的验证状态，行为记录必要的跨系统处理及证据缺口，不新增复扫、通用接口版本匹配或自动最低设备待办；废弃无阶段比较字段。

报告首页概括按CSV逻辑行统计，重复行分别计数；具体业务分类、批准记录和报告组织由所选功能主流程定义。处理结论与业务分类分别记录，行为使用评估结论列，不从MODIFIED/NO_CHANGE猜造适配必要性。

零命中仍写表头与报告，编译/运行没执行就是NOT_RUN。622行可移植案例的口径为613位置、161文件、286单元、19变更；数据夹具只验证口径，不证明其所有业务适配正确。

除设备测试的测试截图列外，不额外增加CSV字段：行为使用处理说明和后续事项，详细编码/兼容复核及验证证据保留在分组和报告；废弃继续使用处理说明、验证证据和后续事项。有源码或构建配置修改而未成功编译时，说明部分完成/待编译或失败原因；后续源码、配置或SDK变化后，相关旧验证标待复核并安排重新构建。使用当前主流程指定的报告模板。

未选择设备验证的行保留原评估结论并说明NOT_RUN，不改为OUT_OF_SCOPE。未答复的拟修复行保留DECISION_REQUIRED；用户明确不实施的方案行通过record-decision写NOT_IMPLEMENTED及真实答复，不因未获授权推定无需修复；具体批准与继续条件由当前主流程负责。

行为固定报告发布后运行csv verify核对当前原表/分组/结果表和报告来源。字段保护、单一写入者、完整rowId集合、旧来源兼容和重新评估规则见[评估接收契约](assessment-results.md)，不以pendingCount归零或原始行总数相等替代逐行一致性。

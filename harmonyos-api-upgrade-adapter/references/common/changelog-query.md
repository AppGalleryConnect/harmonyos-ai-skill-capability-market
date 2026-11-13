# 版本变更查询（只读）

仅询问版本差异、changelog 或某版本引入的变更时，调用[内置查询工具](../../scripts/changelog/cli.mjs)。无需工程、SDK 或 taskFile；不初始化适配任务、不写文件。references/changelogs已完整收录官网声明的变更，查询结果不代表工程命中。

## 查询入口

```console
node "<skill-root>/scripts/changelog/cli.mjs" list
node "<skill-root>/scripts/changelog/cli.mjs" query --from 13 --to 20
node "<skill-root>/scripts/changelog/cli.mjs" query --version "26.0.0 Beta2"
node "<skill-root>/scripts/changelog/cli.mjs" query --version 18 --kit "UX 视觉/交互" --format json
```

默认输出 Markdown，`--format json` 返回完整 `{ok,result}`。query 必须选择 `--from/--to` 或 `--version`，不能混用。版本支持 API 等级、完整版本号或唯一平台前缀；多命中列出候选，由用户明确版本。Kit 按查询返回的真实名称过滤；不将 OS/UX 文档类别当作扫描变更类型。

## 区间与资料覆盖

- 不带通道的区间按平台版本 `(from,to]` 查询：13→20 排除 API13 的全部阶段，纳入 API14 至20的已收录条目。与工程扫描默认展开到精确阶段的方式分别处理，不改变扫描参数。
- 指定通道时两端必须都明确 Beta/Release 等阶段，再按阶段顺序比较。倒序报错；相同端点为空区间，不能用它查询单版。
- `--version 20` 列出该平台所有已收录阶段；带阶段则只列确定匹配项。
- 正文文件名未标阶段时，结合对应官方总览核对；无法确认不默认 Release。阶段未知仅在影响边界归属时列入 `unplacedEntries`；严格位于两端平台之间，或其平台高于起点且终点为本平台 Release 时可以确定纳入。本平台 Release 起点之后则不会再包含该平台条目。这些区间判断不为正文补造通道。
- 支持范围内无条目表示该版本没有声明行为变更，例如API24返回零条目，不显示资料缺失。`missingVersions`和`missingStages`为兼容旧调用保留为空数组。`unknownChannelCount`表示已纳入条目中仍未标阶段的数量；已有条目但阶段无法确认时显示阶段归属未定，不冒充零条目。

向用户展示版本/阶段统计、条目标题、Kit、官方链接及确有条目的阶段未定信息。索引引用的正文丢失或哈希异常时停止查询并报告真实错误。查询保留可唯一核实的官网条目链接和ID供规则包比对；不进行工程业务适用性判断。

用户进一步要求工程适配时，按对应完整流程初始化任务、扫描或导入原 CSV，逐调用读取完整官方章节和工程；查询结果不能转成原始扫描行。

行为扫描使用本任务冻结的精确(from,to]查询并与实际DevEco同区间规则包条目比对，结果保存在扫描JSON的officialComparison。规则包已有条目但无affected APIs与确实缺规则分开，不能按CSV是否命中判定覆盖。主 CSV 阶段结束后，用户决定是否对确认未覆盖的条目做[补充评估](../upgrade/rule-gap-review.md)。

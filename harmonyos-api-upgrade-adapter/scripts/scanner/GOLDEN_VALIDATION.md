# 金标验证记录

跨平台金标只在工程 `sourceSnapshot`、目标 SDK 版本与 `deprecationCatalog.sdkSnapshot` 相同时比较。Beta 与 Release SDK 的声明和废弃标记可以不同，不将其行数差异视为平台差异。输入快照一致后，废弃 API 使用 `API Symbol ID + Code Location + Column` 对齐，并归一化主机绝对路径。

## Scanner 0.5.0 废弃 API 验收 - 2026-09-16

目标 SDK：HarmonyOS 26.0.0 Release（26.0.0.105）。四工程在隔离副本中执行非增量 `assembleApp`，保持 Git 基线业务源码，采用原工程当前构建配置以匹配已安装依赖；补齐现有缺失 rawfile 资源，不复制构建缓存。原工程和业务代码不修改，不启动模拟器。

每次构建日志关联 SDK、源码、配置和日志哈希，使用 `compare-deprecated.mjs` 按真实文件名、行、列及 SDK 符号对齐。第三方 `oh_modules` 不扫描，也不计入自有代码漏扫。

| 工程 | 自有代码编译金标 | 漏扫 | SDK 废弃引用 | 仅扫描器发现 | 两次 CSV / 完整 JSON |
| --- | ---: | ---: | ---: | ---: | --- |
| ComprehensiveNews1.0.2 | 208 | 0 | 217 | 9 | 完全一致 |
| ComprehensiveTool1.0.7 | 301 | 0 | 319 | 18 | 完全一致 |
| ComprehensiveMall1.0.4 | 86 | 0 | 94 | 8 | 完全一致 |
| Recipes | 53 | 0 | 57 | 4 | 完全一致 |
| 合计 | 648 | 0 | 687 | 39 | 通过 |

仅扫描器发现的引用均保留准确 SDK 声明证据，不能仅因构建未引用源码或编译没有告警而删除。编译金标只提供正例，不是全部扫描目录的负例。C/C++ 沿用现有后端；本表不宣称 C++ 编译金标覆盖已验证。C++ 卡死的外层超时和非阻断报告流程另有通用测试覆盖。

业务源码基线：News `5f686d1`、Tool `1234fa7`、Mall `3fdbcd1`、Recipes `f791656`。回归脚本、配置来源和完整结果见本机 `/tmp/harmony-scanner-050-regression-20260915/regression.json`，各子目录包含 `build.log`、`build-evidence.json`、`comparison.json` 和两轮报告。临时目录不提交。

## Scanner 0.4.0 历史文档 CSV 验证

验证日期：2026-09-09

全部比较使用 `scripts/compare-golden.mjs` 并传入 `--scan-json`。比较器结合主 CSV 与包含过滤记录的扫描 JSON 核对 DevEco 完整覆盖，再单独报告来自变更文档的待评估项。因兼容、工程不适用或文档明确无需适配而从主 CSV 排除的记录，仍保留在 `apiChange.scan.json`，并附过滤原因与适用性证明。

| 工程 | 版本区间 | 金标行数 | 匹配 | 缺失 | 额外 | 主 CSV 行数 | 已报告 DevEco 行数 | 已过滤金标行数 | 已报告文档行数 | 全部过滤行数 | 废弃行数 | 耗时 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ComprehensiveMall1.0.4 | API 12 至 API 26 Beta2 | 3,134 | 3,134 | 0 | 0 | 1,133 | 916 | 2,218 | 217 | 3,570 | 91 | 67.5 s |
| ComprehensiveNews1.0.2 | API 12 至 API 26 Release | 3,561 | 3,561 | 0 | 0 | 1,276 | 968 | 2,593 | 308 | 4,397 | 205 | 71.6 s |
| ComprehensiveTool1.0.7 | API 12 至 API 26 Release | 8,361 | 8,361 | 0 | 0 | 3,925 | 2,727 | 5,634 | 1,198 | 8,958 | 284 | 114.6 s |
| Recipes | API 12 至 API 26 Beta2 | 1,424 | 1,424 | 0 | 0 | 633 | 518 | 906 | 115 | 1,423 | 53 | 66.3 s |

Tool 金标 CSV 包含 38 个模块，不包含 `ar_measure`；比较采用相同模块范围。生成的报告包含一条 C 记录，执行完成且未超时。扩大范围的扫描可能包含有效的 `ar_measure` 记录，但这些记录不属于金标范围。

提供的金标 CSV 不包含完整废弃 API 数据集。生成的 CSV 通过 `Change Type = Deprecated API` 和 `Change Operation = API_DEPRECATED` 明确标识此类记录；目标 SDK 声明了 `@useinstead` 时，该行还包含 `Replacement API` 和 `Replacement Source`。兼容、工程不适用及文档明确无需适配的记录仅从主 CSV 省略；扫描 JSON 保留全部记录，以及 `includedInCsv`、`disposition`、`filterReason` 和可取得的 `applicabilityProof`。

## 可重复性与性能

`ComprehensiveNews1.0.2` 在 API 12 至 API 26 Release 区间执行两次扫描，分别使用独立包与 Skill 内置包。两次均从 5,673 条记录中报告 1,276 行，并过滤相同的 4,397 条，其中包括 2,396 条 Stage 模型约束和 132 条源码兼容的签名变更。输出字节完全一致：CSV SHA-256 为 `d151d89f69e7c6e1093eca63bd8cd6ba1e5fba2ba72d36a48ea02886a815e64c`，扫描 JSON SHA-256 为 `e3baf7784edfdd8d49f7ca0dfcc9a698db7d83e7b99e11de4f1d827657feb2b5`。两次耗时分别为 71.6 秒与 73.6 秒。

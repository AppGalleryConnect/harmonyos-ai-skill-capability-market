# 任务根目录与联合交付

本页只规定路径、参与工程索引和文件归属，业务评估、修复批准及验证由各主流程决定。

## 启动根目录与一次任务

进入任何子工程或改变工具 cwd 前，从宿主会话起始工作目录记录绝对 taskRoot。不能用 --project、模块路径、最近的 Git 根或当前子工程 cwd 替代。启动根目录无法可靠确定时先询问用户。用户指定输出根目录在初始化时解析并固定，相对路径基于 taskRoot。

一次独立适配请求只初始化一次任务；HAR/HAP、同任务的两个功能、扫描失败重试、导入和断点继续均复用绝对 taskFile。明确开始新的独立任务时才 init-task。不能查找“最近时间戳”自动恢复，也不能通过新目录重置已停止的问题。同秒独立任务通过 -2 等后缀隔离。

```console
node "<skill-root>/scripts/scanner/bin/harmony-api-scan.mjs" init-task --task-root "<启动根目录>" --mode upgrade --project "<HAR工程>" --project "<HAP工程>"
```

回读 JSON result.taskFile、taskDirectory 和 outputRoot，后续全部引用真实返回值。默认 outputRoot 是 taskRoot 下的 .api-change-output；--output-dir 只在初始化时选择其他输出根。--project 指向含app.products和模块注册的真实根工程，同一工程内的entry/HAR模块不是独立参与工程，模块范围用--scan-module/--scan-dir表达。--project 可重复用于登记全部计划工程，确保暂未开始的工程也能出现在汇总报告中；--mode 选择这些登记项的功能。另一功能或后续追加工程通过 register-project 登记，不重新 init-task。

```console
node "<skill-root>/scripts/scanner/bin/harmony-api-scan.mjs" register-project --task "<绝对taskFile>" --mode upgrade --project "<追加工程>"
node "<skill-root>/scripts/scanner/bin/harmony-api-scan.mjs" scan --task "<绝对taskFile>" --mode upgrade --project "<工程>" --sdk "<SDK>" --from "<起点>" --to "<终点>" --product "<产品>"
```

登记和扫描开始仅维护内部索引/诊断，不预建空交付目录；首次发布CSV、写进度或保存证据时才创建对应目录。失败和未开始工程仍在索引及报告中出现，不以目录是否存在推断完成。

scan 缺少 --task 时在创建输出前停止；遗留 --output-dir 若与固定根目录冲突则拒绝。所有工具即使从子工程、临时目录或其他 cwd 执行，也只使用上下文中的输出根。两个同名工程、大小写冲突及不同 product/范围使用稳定唯一工程键，不能覆盖别的工程。物理身份使用 native/异步 realpath，Windows 短路径和 junction 不产生第二份工程身份。

## 目录结构与路径字段

```text
<启动根目录>/.api-change-output/<任务时间戳>/
  .internal/
    task.json
    upgrade/<工程键>/scans/<扫描ID>/
      scan-batch.json
      scanner/                       # 扫描JSON、coverage、diagnostics
      raw/                           # 本次扫描的原始字节，失败尝试不公开为基线
      imported/                      # 仅导入时：原来源证据的副本
  upgrade/
    api-adapt-report.html               # 该功能唯一汇总报告
    ohos-hardemo/
      scan-results-<HAP扫描ID>.csv
      adapted-results-<HAP扫描ID>.csv
      progress.json
      spec.md
      groups/
      evidence/
    ohos_library/
      scan-results-<HAR扫描ID>.csv
      adapted-results-<HAR扫描ID>.csv
      progress.json
      spec.md
      groups/
      evidence/
```

deprecated 同样按工程分目录，原表仍为 apiChange_<任务时间戳>.csv。结果名复用该工程初始扫描的独立 12 位 batchId。单工程也采用同样布局；同一时间戳可有 upgrade 和 deprecated，各功能保留自己的汇总报告。设备报告只在实际选择并执行或受阻时生成，保存在实际执行工程目录；库引用真实宿主的证据，不复制为第二次测试通过。

outputLayout 提供 taskFile、taskDirectory、projectKey、deliveryDirectory、batchId、rawCsv、adaptedCsv、taskReportPath、batchMetadataPath、scannerDirectory 和 evidenceDirectory。文件路径使用实际返回值，不按旧层级或时间戳猜测，也不通过版本编号推断目录。扫描事实 JSON 的 schemaVersion=4、任务索引的 schemaVersion=1 属于各自的数据格式，继续保留。

.internal/task.json 仅由路径工具更新，保存参与工程、扫描来源、尝试和原表位置；模型在各工程 progress.json 保存批准与业务进度，不把路由索引当作自动适配或验收凭据。成功初始扫描以原始字节发布一次；源码或配置变化后的业务判断、构建和验证仍由主流程负责。

## 导入、失败重试与复扫

历史 CSV 编码按[编码契约](../../templates/results.md#历史-csv-编码)处理：import-csv 默认自动探测，也可显式指定 --encoding；回执返回确定编码。导入原件不转码，后续任务读取复用该解释。

```console
node "<skill-root>/scripts/scanner/bin/harmony-api-scan.mjs" import-csv --task "<绝对taskFile>" --mode upgrade --project "<工程>" --csv "<原始CSV>" --evidence "<实际扫描JSON>"
```

导入复制原始 CSV 字节并记录原件、SHA-256 和证据来源。存在同目录伴随文件时保留副本；位于旧 .internal 或其他位置的证据用重复 --evidence 显式指定，缺失的指定证据会报错。旧元数据只存入 imported，不覆盖当前 scan-batch.json，不把旧 ID 改成本次 ID，也不冒充重新扫描。CSV_ONLY、旧 SDK/源码、未知覆盖等边界由模型核对后保留。

失败尝试的诊断留在本工程 scans/<ID>，重试 initial 不新建外层时间戳。已有成功初始扫描时拒绝重复 initial，不覆盖原表。废弃 D10 使用同一 taskFile、product/范围与 --scan-purpose rescan；结果只在内部目录，adaptedCsv=null，不替换 D03 基线。行为流程不复扫。中断保留索引和内部字节，继续前核对真实工具退出及证据，不因索引状态自动继承业务成功。

## 一份功能汇总报告

主 agent 在 taskReportPath 写入一份 api-adapt-report.html，子 agent 不并发写报告。复制所选功能 HTML 模板、保留内联 CSS，仅填写正文，不另外生成 Markdown 报告。按照 task.json 的本功能全部参与工程逐项核对各自 progress、分组、原 CSV、方案和真实证据。未开始、扫描失败、缺文件及只有 CSV 的工程必须出现，不能仅汇总成功工程。索引的 SCANNED/IMPORTED 只表示来源状态，不能表示适配、构建或业务验收完成。

报告首页列工程清单、配置原值→目标及实施状态、各工程批次 ID、行数、适配、构建与运行状态和文件链接；随后按工程完整展开当前功能模板。全局原始行数按各表相加，重复行不合并，行身份以工程/来源加 rowId 归属，不能混淆相同 CSV 字节的不同工程。共享构建或宿主运行证据引用一次，分别说明覆盖了哪些库和应用。

代码适配、库构建、宿主构建、业务运行及有效对比分开汇总，保留失败和缺口；不能用库编译通过覆盖宿主失败，也不能把 5/6 测试通过写成全部通过。适配报告由模型据事实撰写，不拼接历史报告或设置自动业务判定；测试报告由 runtime 从实际审计生成。核心结果默认展示，完整依据、原始行和证据折叠保留。最后回读 HTML 和全部实际资源链接；用户改过的报告按原件保护另存版本，并把实际地址更新到进度和最终答复。

历史目录保持原样，不搬动、合并或改写既有交付；历史 CSV 需要继续工作时作为普通输入导入新任务，不恢复旧账本或继承成功。

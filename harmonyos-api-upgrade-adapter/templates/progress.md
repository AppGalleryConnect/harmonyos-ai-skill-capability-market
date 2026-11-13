# 通用轻量进度格式

在所选功能主流程要求的节点初始化和更新，供逐文件记录、核对交付及断点继续使用。本页只定义共用布局和基础字段；业务决策、分类、特定证据字段与完成判据由各主流程定义。总览保持简短，当前分组按需读取；没有运行脚本、冻结协议或自动可信账本。

## 建议目录

先按[任务输出契约](../references/common/task-output.md)初始化任务。全部工程、失败重试与导入共享一个任务时间戳，各工程独立 batchId；输出根固定为启动目录下的 .api-change-output 或初始化时明确选择的根，不能根据扫描工程或切换后的 cwd 重算。

```text
<任务目录>/
  .internal/task.json
  .internal/<功能>/<工程键>/scans/<ID>/ # 元数据、扫描/导入证据和失败尝试
  upgrade/                            # deprecated使用同级deprecated/
    api-adapt-report.html                # 本功能唯一汇总报告
    <工程键>/
      scan-results-<批次ID>.csv         # deprecated原表为apiChange_<任务时间戳>.csv
      adapted-results-<批次ID>.csv
      progress.json
      groups/b001.json
      spec.md                          # 行为修复批准依据
      test-report.html                   # 按需生成，宿主实际执行时库引用它
      evidence/runtime/
```

扫描和导入均使用 outputLayout 实际返回的 taskFile、deliveryDirectory、rawCsv、adaptedCsv、taskReportPath 和 evidenceDirectory。两类结果名复用本工程初始扫描 ID，继续任务不重新命名；行为仍通过[格式化函数](results.md#格式化接口与文件调用)输出四列逐行结果，设备测试另在末尾追加截图列。scanner 不预填模型结果，原始行身份和业务结论格式不变。

导入通过 import-csv --task 使用同一任务，原 CSV 字节和伴随来源保持；旧内部资料只进入本次扫描目录的 imported/，不覆盖新元数据、不恢复旧状态。成功初始原表只发布一次，失败尝试和废弃复扫只保存为内部证据，不另起时间戳或覆盖基线。历史目录不自动移动、重命名或迁移；已有交付被用户修改时另存版本并记录实际路径，不改扫描 ID 冒充原任务。

任务索引仅由路径工具维护；当前工程的业务批准、验证和下一步写入本 progress。每轮源码或配置修改后，编译回到 NOT_RUN，旧通过按真实输入变化重新核对；仅模型写过完成不构成证明。跨工程共享批准或构建/宿主证据写明关联范围，功能总报告回读全部参与工程，包括未开始或失败项。

## 总览示例

```json
{
  "mode": "<当前功能>",
  "batchId": "<本工程初始扫描12位随机ID>",
  "taskFile": "<返回的绝对taskFile>",
  "projectKey": "<实际工程目录键>",
  "delivery": {
    "directory": "<任务目录>/<功能>/<工程键>",
    "adaptedCsv": "<任务目录>/<功能>/<工程键>/adapted-results-<批次ID>.csv",
    "report": "<任务目录>/<功能>/api-adapt-report.html"
  },
  "project": "<真实工程绝对路径>",
  "product": "default",
  "scope": {
    "modules": [],
    "directories": []
  },
  "source": {
    "originalPath": "<原件>",
    "copyPath": "<字节副本>",
    "sha256": "<实际计算>",
    "inputRows": 0
  },
  "versions": {
    "oldTarget": "<旧值>",
    "oldCompatible": "<有依据时记录原最低兼容版本>",
    "compatible": "<最低>",
    "target": "<目标>",
    "from": "<精确起点>",
    "to": "<精确终点>",
    "compileSdk": "<真实版本或未知>"
  },
  "decisions": {
    "target": {
      "answer": null
    },
    "repair": {
      "plan": "<本次汇总方案位置>",
      "answer": null,
      "approvedItems": []
    },
    "runtime": {
      "mode": "<当前主流程确定的方式或未要求>",
      "answer": null,
      "scope": []
    }
  },
  "scanEvidence": {
    "origin": "IMPORTED_CSV",
    "coverage": "UNKNOWN",
    "files": [],
    "gaps": []
  },
  "groups": [
    {
      "id": "b001",
      "identity": "<准确规则和版本或SDK符号>",
      "record": "groups/b001.json",
      "status": "PENDING"
    }
  ],
  "statistics": {
    "records": 0,
    "locations": 0,
    "physicalFiles": 0,
    "workUnits": 0,
    "changes": 0
  },
  "verification": {
    "static": "NOT_RUN",
    "compile": "NOT_RUN",
    "runtime": "NOT_RUN"
  },
  "next": "<下一具体步骤或缺口>"
}
```

0与占位字符串必须换成真实事实。scanEvidence保存实际来源、coverage/diagnostics路径与超时/缺规则/CSV_ONLY边界；官方规则缺口与业务待办分开。

行为流程在 `csv prepare` 完成后、配置修改前登记 `versions.oldTarget`、`versions.target` 和 `versions.compatible`。已核实的原最低兼容版本写入 `versions.oldCompatible`，`compatible` 写本次确认的版本值。前后变化字符串和历史 `{old, current, note}` 对象继续可读。实施后以 `configurationImplementation` 记录实际配置回读与实施状态。报告顶部和工程总览共用版本字段，最低兼容显示前后版本或单值，缺少依据时显示未知并记录版本缺项。

RNOH 工程的 `rnohReview`（U04a 补充核对结论）由 record-rnoh-review 写入和合并，不手工编辑。

所有decisions记录真实答复和可定位对话来源，null为未取得，不能补造。repair.plan指向本次汇总方案；行为使用实际spec.md路径，declinedItems/declinedSharedItems只记录真实不实施决定，全部变更评估任务返回后由主agent合并冲突再写入。行为approvedItems通过record-approval保存id/groupId/完整rowIds/action/assessmentSha256及实际answer/source/spec依据；不得把调用计数当作选择集合。approvedItems只列确已批准条目及必要共享修改，空数组不表示批准全部。未批准项、验证未选/未要求、当前功能实际要求的缺口分别保存，不改写成范围外或已解决。必要功能字段和验证范围格式见当前主流程。

行为报告另支持可选的 `testSuggestions` 字符串数组，由主agent在U09写入当前工程progress，供“遗留事项与测试建议”卡片直接展示。例如：

```json
{
  "testSuggestions": [
    "阴影视觉回归：在本工程支持的目标设备上切换实际受影响页面的搜索态与非搜索态，对比升级前后截图，确认无非预期阴影。"
  ]
}
```

实际填写须匹配本工程的页面、操作、预期结果及适用设备或版本，不照搬示例。缺省或空数组表示未提供针对性建议，不表示无需测试或验证通过。建议不是待办或验收状态，不加入rowResults.next、pendingCount或设备授权；已有真实缺口仍保留。修改建议后重新生成并verify，报告来源摘要会核对该字段；历史输入缺少字段继续兼容，不恢复报告JSON。

## 分组示例

行为HTML可选使用`rowResults.reportSummary`保存一两句逐行核心说明，`changeSummary.business`保存一次本组业务概括；详细reason、evidence和CSV处理说明保持完整。两字段只影响展示，主agent用[简述更新](assessment-results.md#仅更新html简述)补充，不为排版重评估、不清next或复核标记。真实处理变化后更新简述，决定过期/待复核时回退全文。

使用内置 `csv prepare --task … --project … --mode …` 从原始扫描生成骨架和进度引用，废弃仍由模型编辑实际判断；行为用[固定接收](assessment-results.md)将评估者的独立草稿接收到分组。已有分组不覆盖。`rowResults` 是每个原始逻辑行的唯一判断来源，分类、处理状态、理由及证据不在其他JSON重复维护；行为保留的原始评估是只读输入依据，不是第二套可修改分类。分组changeSummary保存一次变更级旧新行为、target隔离和方案取舍；progress.configurationImplementation保存配置实施事实，verificationSources登记真实验证引用，不重复维护报告JSON。分组assessmentSource保存其record/sha256，评估字段更新与处理结果resolution分离。文件级 `outcome` 仅作历史摘要，不能把整个文件的修改扩散到未修改调用。

```json
{
  "id": "<工具生成>",
  "sourceSha256": "<原始CSV完整SHA256>",
  "identity": { "ruleOrSymbol": "<准确身份>", "version": "<精确版本>", "reference": "<官方章节或声明位置>" },
  "overview": "<当前变更及业务影响>",
  "files": [{ "path": "<物理文件>", "rowIds": ["<输入sha256>:1"], "locations": ["<Code Location>"], "plan": "<方案与验证安排>" }],
  "rowResults": [
    {
      "rowId": "<输入sha256>:1",
      "category": "待分类",
      "outcome": "PENDING",
      "reason": "",
      "changes": [],
      "compatibility": "",
      "evidence": [],
      "next": ""
    }
  ]
}
```

`category` 仅行为流程使用，允许必须适配、可选适配、无需适配、待分类和范围外；`outcome` 沿用PENDING/MODIFIED/NO_CHANGE/DECISION_REQUIRED/EVIDENCE_GAP/OUT_OF_SCOPE；行为增加NOT_IMPLEMENTED，表示用户明确不实施。MODIFIED 必须提供本行的实际修改 changes，非 PENDING 须有具体 reason。changes/evidence 为字符串数组，compatibility/next 为字符串；废弃可另填字符串 impact 作为业务影响，缺省为空。PENDING 默认输出待处理说明，不代填无需适配。

同一文件的5个命中若只修改1个调用，只有对应rowId记MODIFIED，其余分别判断。旧rowClassifications若保留，必须与rowResults分类一致；不能自动把旧文件状态转换成每行结论。旧记录只读核对后，由模型依据spec和差异补齐。

统一生成CSV/HTML成功回读后，工具合并更新delivery.adaptedCsv/adaptedCsvSha256及delivery.report/reportSha256/reportPublishedAt/reportStatus和next，保留其他字段；reportInputs保存本次发布来源摘要（不是语义可信账本），包含当前结果表与相关决定，供verify检查源文件是否变化；旧报告不补造摘要。报告已交付不等于构建或设备验收通过。仍有判断、证据或rowResults.next及报告nextSteps声明的后续事项时保留待办；同步失败时保留HTML、非零退出并列出工程，相同输入与HTML可直接重试补同步，用户改过的HTML另存。

同一准确符号/变更与物理文件构成一个工作单元，一个文件多变更分别登记，原始重复行各自保留。按真实物理文件核对路径与范围。文件状态可为PENDING/PROCESSING/REVIEWED；REVIEWED只表示当前已评估，DECISION_REQUIRED/EVIDENCE_GAP仍未解决。组内不同结果分别记录，不用整组一次修改替代每行结论。

rowResults.reason记录真实判断，evidence关联实际读到的声明/资料/源码或工具结果，尚未处理保持PENDING。涉及特定分类或取材时按当前功能流程补充，不在本通用格式中预填。

逐文件记录真实差异和必要前后哈希/片段来源供安全继续，不复制整工程或建立blob/head/签名回执。attempts按[排错方法](../references/common/troubleshooting.md#定位与停止)保留同一错误的实质失败方案及环境阻断，不通过换组/目录重置次数。输入、源码、配置、SDK或包变化后核对影响，旧结论保留历史说明并标待复核，不继承通过。

行为评估agent只编辑独立评估草稿，修复agent返回实际差异；主agent统一调用接收/批准/处理工具更新本进度与分组，不另派更新agent。进入确认和交付前等待所有任务返回，避免并发覆盖。已有resolution记录处理决定，原category/reason/evidence不因接受新行为而改写。行为设备验证另以runtime记录sourceId/rowId选择、原始白盒事实和实际run路径，结构见[测试契约](../references/common/runtime-contracts.md)。包归档与设备实测证据分别保存在evidence并关联实际路径/哈希，before归档成功不表示before测试通过；修复后变化仅重建after并重测受影响用例，不覆盖原before。

按功能补充验证状态：行为可记录所选对比及原包归档受阻时的baselineDecision，跨系统处理与缺口使用现有compatibility和reason/evidence，不创建复扫或自动最低设备状态；废弃记录真实rescan及明确要求的单次runtime，不创建比较方式、阶段基线或降级字段。已退役项不生成NOT_RUN待办，历史记录只读，按当前动作与范围核对后继续。

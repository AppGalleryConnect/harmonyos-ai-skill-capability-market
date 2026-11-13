# 行为评估接收与获批处理更新

本页只定义模型结果的接收、字段一致性和明确范围更新；不执行源码适配，不推导API业务分类，不建立源码事务或自动可信账本。仅支持upgrade，废弃流程保留既有接口。

## 读取命令回执

`import-assessment`、`record-approval`、`record-decision`、`update-resolution` 和 `verify` 可用 `--receipt-output` 指定新文件。工具在操作成功后写入完整的 `{ok,result}` UTF-8 JSON，stdout 继续返回相同结果。用文件读取工具打开指定路径，再使用其中的行数、哈希、批准范围和统计。批量处理时，每次调用使用独立路径并检查本次结果。逐组用 draft-resolution 生成处理草稿，更新回执的 updatedRows 只统计本次提交，交付总数从 verify 读取。

工具在执行前检查目标，已有文件须另存。收到 `RECEIPT_WRITE_FAILED` 时读取 `error.details.committed` 和 `error.details.result`。`committed=true` 表示操作已提交。以 error.details.result 作为本次结果，回读分组或进度确认后继续流程。需要新的核对文件时，分组用 `inspect --output`，交付用 `verify --receipt-output`，分别指定新路径。再次写入处理状态前先确认确有待处理的变更。

## 评估草稿与接收

先完成csv prepare和指定分组的inspect，再生成独立草稿：

```console
node "<skill-root>/scripts/csv/cli.mjs" draft-assessment --task "<taskFile>" --project "<工程>" --mode upgrade --group "<实际ID>" --output "<评估JSON>"
node "<skill-root>/scripts/csv/cli.mjs" check-assessment --task "<taskFile>" --project "<工程>" --mode upgrade --group "<实际ID>" --input "<评估JSON>"
node "<skill-root>/scripts/csv/cli.mjs" import-assessment --task "<taskFile>" --project "<工程>" --mode upgrade --group "<实际ID>" --input "<评估JSON>" --receipt-output "<接收回执JSON>"
```

草稿为直接JSON对象，无ok/result外层；schemaVersion、groupId、sourceSha256、groupSha256由工具提供，不猜造。items初始显式列出该组全部完整rowId，状态待分类/PENDING，不预填业务结论。评估agent只用原生文件编辑工具修改自己的草稿，读取全部调用后可拆分或合并相同评估的显式集合，不写临时Python/Node生成判断脚本：

```json
{
  "schemaVersion": 1,
  "groupId": "<工具提供>",
  "sourceSha256": "<原始CSV哈希>",
  "groupSha256": "<当前分组哈希>",
  "knowledge": {"sources": [{"originalReference": "<原始来源>", "localReference": "<核实路径>", "readRanges": ["<实际阅读范围>"]}]},
  "items": [{
    "rowIds": ["<完整原始rowId>"],
    "category": "可选适配",
    "outcome": "DECISION_REQUIRED",
    "reason": "本调用已核实的触发条件、具体影响和拟议方案",
    "compatibility": "实际跨系统分析或具体缺口",
    "evidence": ["真实源码、SDK、官方章节及阅读范围"],
    "changes": [],
    "next": "等待用户决定是否保留旧体验"
  }]
}
```

顶层 changeSummary 填写 before/after/targetIsolation/proposal 字符串，供评估与方案使用。可选 business 用一至三句概括当前业务中的触发条件与影响。工具为 DevEco 覆盖条目引用已核对的官方原文，从实际答复及对应方案生成关键决策。逐行可选 reportSummary 用一两句概括本行核心理由与处理，详细判断保留在 reason/evidence，CSV 继续输出完整说明。报告直接读取这些来源。

category允许必须适配/可选适配/无需适配/待分类/范围外；outcome使用既有内部状态，评估阶段不能填MODIFIED、NOT_IMPLEMENTED或实际changes；必须/可选适配不能直接填NO_CHANGE，接受新行为必须经过明确决定。reason/compatibility/next为字符串，evidence/changes为字符串数组。next只记录本任务实际剩余动作；没有待办时填空字符串，未安排构建或设备等范围说明写入证据，不作为待办。可选knowledge为顶层对象；多个来源完整保存在knowledge.sources对象数组中。草稿已提供该结构，items内禁止增加knowledge。

每个原始rowId必须恰好出现一次，重复扫描记录不合并；缺失、重复、跨组、哈希不符、非法枚举和非规范字段均拒绝，不接受按API类型或剩余行补默认结论。check-assessment只读校验身份、字段与覆盖，错误details.jsonPath定位到如/items/0/knowledge，成功不证明业务语义。格式错误连同完整路径返回原评估者，通过原生文件编辑工具修正并重新校验；主agent不搬运、截取或丢弃知识记录。主agent不另派更新agent重建判断。

工具按原始CSV顺序展开items，直接保存模型字段并返回真实分类统计；输入summary不能替代逐行记录。原始评估字节副本保存于当前工程evidence/assessments，group.assessmentSource记录路径和哈希；这仅用于核对复制一致性。当前rowResults仍是CSV/报告唯一投影来源，评估文件不并行维护第二套可修改结论。

相同输入重复接收不重置后续状态。已有不同评估须显式--reassess --reason：保存新来源并保留旧文件，未实施修改的行采用新评估状态；已实施的实际changes和MODIFIED保留并标待复核。复核标记保存于reviewRowIds，不向next拼接机器说明。原处理和验证记录放入previousResolution，不作为本次通过依据。主agent回U04/U05核对新方案；原答复仍适用时可沿用真实依据，实质方案改变时重新确认。旧判断没有评估来源时不会自动补接可信来源，需明确重新评估。

## 明确批准范围

全部评估任务返回并完成接收后，主agent按[固定方案明细](spec-results.md)填写模型正文和明确集合，通过prepare-spec生成spec。每个方案列完整rowId集合、物理调用位置和原始行数；调用数有明确证据才另列，不能以数量代替选择集合。14条原始行若确实对应12处Toast，应完整列出14个rowId；不明则保留歧义，不能混入带背景Dialog。

主agent核实实际答复后保存批准JSON，再调用record-approval；工具不从自然语言推断批准范围：

```json
{
  "plan": "<实际spec.md绝对路径>",
  "answer": "<用户实际答复>",
  "source": "<可定位对话/工具答复来源>",
  "approvedSharedItems": ["<确已批准的共享方案ID，可省略>"],
  "approvedItemIds": ["toast-accept-1"]
}
```

plan 指向 prepare-spec 返回的实际展示方案。approvedItemIds 列出用户明确选择的行方案 ID，工具从已校验方案提取动作、分组、完整 rowIds 和 assessmentSha256。已有输入可继续使用 approvedItems，每项只含 id、groupId、rowIds、action、assessmentSha256。两种行批准输入二选一。工具核对范围并归档批准时的方案快照，再同步展示文件确认区。动作使用ACCEPT_NEW_BEHAVIOR或APPLY_APPROVED_CHANGE。后者对应获批实施方案，不是已修复证明；未触发/未评估行不能混入。记录到现有progress.decisions.repair.approvedItems，带实际答复、spec字节哈希和评估来源。已有ID不允许扩大或换义；新的真实决定使用新ID，其他批准项不覆盖。

有 `alternative` 时，主方案和备选共用一组原始行。批准输入只填用户明确选择的做法 ID，选择备选时填备选 ID。工具拒绝同组双选及已有有效决定后直接换选。首轮选择用原 spec；变更已登记决定时按[方案替换规则](spec-results.md)重新确认。

```console
node "<skill-root>/scripts/csv/cli.mjs" record-approval --task "<taskFile>" --project "<工程>" --mode upgrade --input "<批准JSON>" --receipt-output "<批准回执JSON>"
```

## 处理更新与原评估分离

先按明确范围生成处理草稿，再用原生文件编辑工具填写本次实际差异、证据和剩余动作。

```console
node "<skill-root>/scripts/csv/cli.mjs" draft-resolution --task "<taskFile>" --project "<工程>" --mode upgrade --group "<实际ID>" --approval "<获批方案ID>" --output "<处理草稿JSON>"
node "<skill-root>/scripts/csv/cli.mjs" draft-resolution --task "<taskFile>" --project "<工程>" --mode upgrade --group "<实际ID>" --review --row-id "<实际完整rowId>" --output "<复核草稿JSON>"
```

草稿预填原表哈希、当前分组哈希、完整行身份及适用的批准 ID 和 outcome。`--approval` 选择当前有效批准的全部行。可重复传入 `--row-id` 选择该批准项的明确子集。`--review` 以 `--row-id` 或 `--approval` 选择复核范围，草稿仅包含复核字段。同一集合中实际差异或证据不同的行，按实际情况拆为多个明确更新项。生成文件内的 `next: null` 是待填写值，提交前改为实际剩余动作或空字符串；同时补齐说明、适用的差异及证据。哈希过期时另存新草稿并重新核对。

直接读取 inspect 或 import/update 的 JSON 回执时，当前分组哈希在 `result.groupSha256`，原始评估哈希在指定组 inspect 的 `result.assessmentSha256`。填写后的处理输入如下。

```json
{
  "groupId": "<实际ID>",
  "sourceSha256": "<原始CSV哈希>",
  "groupSha256": "<当前分组哈希>",
  "updates": [{
    "rowIds": ["<明确选中rowId>"],
    "approvalId": "toast-accept-1",
    "outcome": "NO_CHANGE",
    "resolution": {"reason": "用户明确接受本调用的新材质", "evidence": ["实际答复来源"]}
  }]
}
```

```console
node "<skill-root>/scripts/csv/cli.mjs" update-resolution --task "<taskFile>" --project "<工程>" --mode upgrade --group "<ID>" --input "<处理JSON>" --receipt-output "<更新回执JSON>"
```

工具只处理明确集合，校验每行属于当前评估和对应批准。接受新行为保持category=可选适配、原reason/evidence/compatibility不变，只更新outcome=NO_CHANGE并追加resolution；实施获批修复使用MODIFIED，必须提供本行实际changes。category、原reason/evidence等评估字段不能放入处理补丁，格式别名不自动转换。

changes和next未提供时保持原值。获批动作完成后，主agent逐条核对原待办并明确填写next：本任务已无动作时填空字符串，仍有真实缺口时写具体事项。resolution.reason为必填处理说明，evidence为字符串数组（无新证据用明确空数组）；不把根配置修改当作每行API修复。并发更新或旧分组哈希直接拒绝，主agent等待当前唯一写入者结束后重新读取。

仅核对既有验证安排的待办时可使用verificationOnly=true，明确rowIds、next和resolution说明/证据，不提供approvalId、outcome或changes。该操作只追加verification记录、保留既有处理决定，不改变评估或实施状态，也不为无需修复行额外请求修复批准；主agent仍须核实真实验证事实，工具不自动证明业务通过。

关闭说明性待办、完成重新评估后的方案复核，或在 U07 记录本次改动的新增调用复核时，用同一update-resolution入口提交reviewOnly=true、明确rowIds、实际剩余next及resolution.reason/evidence。新增调用复核引用实际 diff、准确 SDK 失败契约与废弃状态、处理位置及复用或新增方式；遗漏返回 U06，依据不足保留具体待办。evidence至少包含一条实际依据。该操作保留分类、原评估、outcome、changes及原批准引用，追加resolution.review，已有resolution批准字段和previousResolution按原值保留，并关闭所选行的reviewRowIds。重新评估操作由--reassess保存旧处理到previousResolution。不得同时提供approvalId/outcome/changes/verificationOnly。省略next或证据不完整会拒绝。

```json
{
  "groupId": "<实际ID>",
  "sourceSha256": "<原始CSV哈希>",
  "groupSha256": "<当前分组哈希>",
  "updates": [{
    "rowIds": ["<已实际复核的完整rowId>"],
    "reviewOnly": true,
    "next": "",
    "resolution": {"reason": "已核对本行原待办和当前方案，本任务没有剩余动作", "evidence": ["<实际方案、调用上下文或回执位置>"]}
  }]
}
```

仅清理说明性next通过reviewOnly完成。真实业务判断变化才使用--reassess；未选择的设备验证和后续建议写入证据/报告。已确定OUT_OF_SCOPE保留范围外分类，处理结论为无需适配；存在next时继续计入待办。

## 发布核对

### 仅更新HTML简述

主agent在交付前核对当前处理状态，需要精简展示时仍使用update-resolution，输入根节点设置summaryOnly=true，可选business更新本组业务概括，updates仅列明确rowIds与reportSummary：

```json
{
  "groupId": "<实际ID>",
  "sourceSha256": "<原始CSV哈希>",
  "groupSha256": "<当前分组哈希>",
  "summaryOnly": true,
  "business": "本组普通Text未启用复制，不触发文本选择菜单，无需修改。",
  "updates": [{"rowIds": ["<完整rowId>"], "reportSummary": "普通Text未启用复制，保持原调用。"}]
}
```

同组多行确实同义时可共用一个明确集合；混合结果分别写简述。仅改business时updates可为空，空字符串清除对应简述。该模式只更新group.changeSummary.business和选中行reportSummary，不接受批准、outcome、changes、next或resolution，不关闭reviewRowIds，不为排版使用--reassess；没有旧评估来源的记录仍明确保留原缺口。业务背景、分类、原reason/evidence及批准不能借简述更新改写。

正常处理/复核更新的每个patch也可携带reportSummary；实施、接受新行为、不实施或重新评估后不沿用旧简述，交付前根据当前事实补充。决定过期或尚待复核时，HTML回退完整依据。简述只能由模型据事实组织，不能按句号或字符数机械截断。HTML默认显示简述，同单元格“完整依据”保留处理说明全文和段落；旧任务缺少简述回退全文，业务概括缺少时如实提示，不重复拼接逐行理由。来源校验允许修改business展示文案，其余changeSummary原始评估字段仍受保护。

全部接收和更新完成、后台写入者已结束后，运行固定report render（无需--data，共同生成CSV与HTML）再csv verify。csv write可用于评估阶段单独预览。CSV 评估结论从原评估分类投影。处理说明组合原评估理由、处理决定、验证说明和实际差异。报告分别统计评估分类与处理状态。

```console
node "<skill-root>/scripts/csv/cli.mjs" verify --task "<taskFile>" --project "<工程>" --mode upgrade --receipt-output "<核对回执JSON>"
```

verify可靠解析逻辑行、引号、逗号和单元格换行，核对原字段、行序、重复行与评估和处理四列。按需要支持--adapted和--report实际路径，物理别名按同一身份核对。报告发布记录原表、分组、原始评估、结果表、相关spec/批准及兼容调用的报告输入JSON及真实验证引用的来源摘要，发布后变化会报错，不能通过手写split统计或口头解释放行。

对已关联评估来源的记录，validate/write/report/verify都会核对受保护评估字段，指出不一致的分组、rowId和字段。旧记录没有来源仍可读取，但明确列出未建立来源核对的缺口；旧报告没有摘要返回LEGACY_UNVERIFIED，不补造。verify的STRUCTURE_AND_PROJECTION和哈希匹配只表示字段及交付一致，pendingCount、缺口和业务验收仍分别报告。

validate和verify的pendingCount为各类待处理行的并集。unresolvedCount为业务未决行数，nextCount为非空后续事项行数，reviewCount为重新评估待复核行数，三者可能重叠。交付时逐项报告这些数量与真实缺口；MATCH仅表示交付来源一致。

关闭待办前读取validate --details的全部pendingGroups/pendingRows，逐组处理所有实际需关闭的行。reviewCount只是pendingCount并集中的一部分；如156行中70行带复核标记、86行已处理但next未关闭，应分别覆盖70行的复核和86行的原待办，不能只处理3个复核分组就宣称全部关闭。已核实完成的修复、用户已作出的决定与仍需执行的验证分别写明。

## 明确不实施

record-decision兼容record-approval的批准输入，并增加declinedItems和declinedSharedItems，数组只列实际方案ID。用户明确对互斥方案整组不实施时，在 declinedItems 填主方案 ID；用户仅未选择其中一个做法时，按实际答复登记其选择或保留待决定。示例：

```json
{"plan":"<实际spec绝对路径>","answer":"只看方案，全部不实施","source":"<真实答复来源>","approvedItems":[],"declinedItems":["<行方案ID>"],"declinedSharedItems":["<配置方案ID>"]}
```

同一输入可重试；不得混入已实施的差异，也不得把不实施当作接受新行为。工具保存决定快照、更新所选行NOT_IMPLEMENTED和spec确认区，原category/reason/evidence不变。未列出的方案保持待答复，部分批准只实施获批范围。方案替代时使用新ID，受影响的旧决定待核对；无关批准保留。零行和全部无需修改时，prepare-spec允许items/sharedItems为空，不编造修改。

## 工程级验证引用

真实工具事实只登记一次。构建引用直接使用 build 返回的 `result.receiptPath`。使用csv record-verification --task <taskFile> --project <工程> --mode upgrade --input <引用JSON>。引用只包含kind（build/runtime）、record（真实receipt.json或audit.json路径）、完整rowIds、可选name/details；runtime另有sourceId，不填写通过/失败状态。工具读取回执与日志、保存证据摘要和当前覆盖输入；progress.verificationSources是唯一登记处。

```json
{"kind":"build","record":"<真实receipt.json绝对路径>","rowIds":["<完整rowId>"],"name":"编译构建","details":"本轮构建覆盖说明"}
```

CSV与HTML读取同一回执状态，按覆盖行投影验证说明和未完成事项。证据变化、缺失或相关源码/处理状态变化时显示UNVERIFIED/STALE，不继承PASS。不实施行拒绝登记修复验收。旧verificationOnly保留兼容；新流程不要再逐行重复填写工程级通过事实。真实业务待办仍由主agent通过update-resolution维护，成功构建不自动证明所有业务待办已完成。

交付摘要读取 `csv verify` 的 `categoryOutcomeCounts`，按展示分类与实际 outcome 逐项呈现。`acceptedNewBehaviorCount` 只统计有当前有效接受批准引用的 NO_CHANGE 行。`categoryCounts` 和 `outcomeCounts` 分别用于全局总数。

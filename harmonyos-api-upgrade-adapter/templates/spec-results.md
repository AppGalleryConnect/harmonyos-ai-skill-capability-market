# 固定方案明细与批准

U05 由主 agent 用原生文件编辑工具填写方案 JSON，再运行 prepare-spec。模型负责正文和方案取舍，工具从当前逐行评估补充完整 rowId、准确物理文件、调用位置和 API 定义。原始行数与去重代码位置数分别展示，代码位置数不自动等于业务调用数。

```json
{
  "narrative": "本次旧新版本、覆盖、官方触发条件、方案成本、共享影响、验证安排和真实缺口。使用 Markdown 段落组织正文。",
  "items": [{
    "id": "toast-keep-1",
    "description": "关闭应用级系统材质，保留这些 Toast 的旧视觉。需核对对其他组件的影响。",
    "groupId": "<实际分组ID>",
    "assessmentSha256": "<接收回执的原始评估哈希>",
    "rowIds": ["<完整原始rowId>"],
    "action": "APPLY_APPROVED_CHANGE",
    "alternative": {
      "id": "toast-accept-1",
      "action": "ACCEPT_NEW_BEHAVIOR",
      "description": "接受这些 Toast 的新材质，无需修改代码。"
    }
  }],
  "sharedItems": [{
    "id": "sdk-configuration",
    "description": "根 build-profile.json5 的 targetSdkVersion 升至26.0.0，保持原compatibleSdkVersion，实际product和其他受影响范围已核对。"
  }]
}
```

```console
node "<skill-root>/scripts/csv/cli.mjs" prepare-spec --task "<taskFile>" --project "<工程>" --mode upgrade --input "<方案JSON>" --output "<工程交付目录/spec.md>"
```

items 列出每组完整原始行和推荐动作，动作使用 ACCEPT_NEW_BEHAVIOR 或 APPLY_APPROVED_CHANGE。每个原始行只属于一个方案项。可选适配行可在该项填写一个 `alternative`，只含 id、action 和 description，继承主方案的完整 rowIds、groupId 和 assessmentSha256。两种做法分别使用上述两个动作，说明各自的成本和影响。主方案、备选和共享方案的 ID 全部唯一。纯评估或全部无需修改允许 items=[]、sharedItems=[]，状态为评估完成且无需实施批准。仅修改配置的任务可以 items=[]，在 sharedItems 写明配置和影响。无需适配行的依据放在正文，逐行依据继续由已接收评估提供。

工具从 group 自动补充变更背景与逐行评估，narrative 只写跨组约束和方案协调，不重抄评估或处理结论。工具保存只读方案来源并生成明细与确认区。主 agent 回读文件后向用户展示，按[评估接收契约](assessment-results.md#明确批准范围)将实际答复映射到对应做法 ID。同一组首轮选择任一已展示做法都沿用该 spec。每组只登记一个决定，推荐做法仍需用户明确选择。共享修改使用 approvedSharedItems，只有共享修改获批时直接填写该集合。旧输入 approvedItems 仍支持，行集合、动作、分组和评估来源须与方案明细完全对应。

方案正文与批准提示按顺序使用“仅编译构建，不运行设备测试（推荐）”“修改后设备验证（Beta）”“前后对比验证（Beta）”，说明两个设备选项处于试用阶段。已有选择时展示实际答复并沿用；尚未明确时等待选择，不把推荐当批准。登记时映射到 U02 的现有内部方式；仅选设备验证时确认用例范围，只有对比模式要求修改前归档原包。

record-approval 保存批准时所见 spec 的字节快照与哈希，再用同一批准记录更新展示方案的确认区。每个条目的真实答复、来源、原始行范围均保留。报告的批准说明也直接引用这些记录。确认区写入中断时，相同批准输入可重试同步；收到未同步错误后先完成重试，再更新处理结果或交付。工具不从自然语言或摘要计数推测批准集合。

方案正文、明细或确认区被手工修改会停止后续写入或发布。做法内容有实质变化或用户更改已登记的决定时，使用新输入、新输出路径和新的批准 ID，重新确认受影响部分。替换互斥方案时为受影响组的两种做法分配新 ID。新输出路径取同目录下的新文件名，例如第二版写到 spec-v2.md；已登记的方案记录仍引用原 spec.md，删除或移动它会让后续 prepare-spec 报找不到文件。最终答复里说明哪一版是生效方案。既有批准的快照保持可核验。旧批准记录仍可读取，新记录使用 prepare-spec。

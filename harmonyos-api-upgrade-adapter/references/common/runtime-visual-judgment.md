# 宿主视觉判定

本能力只消费固定判据和有效证据，不操作设备、不修改用例、不代替功能断言。

先读取run的manifest.json、inputs/plan.json和audit.json，确认明确的runId、包身份、设备、caseId和采集点。逐个读取实际before/after图片及对应布局树，核对被测页面、容器、操作时刻与断言；未成功读取的图不能标通过。

逐阶段判断是否满足该阶段业务预期，再解释前后变化是否落在allowedDifferences内。不把两张图相同等同业务正确，不以像素相等替代语义判断；布局树、实际分辨率和系统信息用于核对对象及尺度。非视觉功能无需制造截图。

将结果写入run目录judgments.json：

```json
{
  "schemaVersion": 1,
  "runId": "实际runId",
  "planSha256": "manifest.hashes中的inputs/plan.json哈希",
  "reviewer": "实际宿主与模型",
  "checks": [{
    "phase": "before",
    "caseId": "C1",
    "assertionId": "V1",
    "status": "PASS",
    "reason": "实际观察的对象、位置与满足判据的具体事实",
    "difference": "SAME",
    "evidence": [{"captureId": "dialog-open", "screenshotSha256": "实际图片哈希", "layoutSha256": "实际布局树哈希"}]
  }]
}
```

status只使用PASS/FAIL/UNVERIFIED；difference使用SAME/ALLOWED_CHANGE/REGRESSION/UNVERIFIED。after的差异结论须同时读取对应before证据，获批变化须说明来源。一个视觉断言声明的全部采集点都必须引用，不按文件名猜证据。完成后重新运行report审计，旧run或不同哈希的判定不得关联本轮。

宿主没有视觉能力、工具中断或图片打不开时，不生成虚假PASS，保留UNVERIFIED及原因；不自动配置外部模型服务，不将工具失败称为产品视觉缺陷。

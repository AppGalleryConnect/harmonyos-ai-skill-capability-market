# CSV驱动的测试设计与脚本编写

测试对象来自冻结的选中行、白盒事实、官方变化条件和获批spec。README、布局树及截图可辅助理解，不能自行产生新的测试范围，也不能改变业务预期来源。

## 先规格，再用例

1. 读取sources.json和route-map.json，为每个选中调用点的必要触发条件建立测试点，写test-spec.json；一行可关联多个点，同一物理调用的多规则或重复行可共享测试点，但保留全部原行身份。
2. 每个点写明trigger、observable和expectationSource。无法到达/观测的行或分支写具名gaps，不缩小分母。无需适配项设计正常功能检查，不制造差异。
3. 按测试点生成test-cases.json，明确前置数据的实际期望state、复位方法、导航、目标身份、动作、功能/视觉断言和采集点。每个断言关联pointId和准确rowRefs；不能用一次按钮点击关联全部回调。
4. 前后默认保持相同业务语义；获批变化使用beforeExpected、afterExpected和allowedDifferences。文案/导航/定位差异预先写入phaseLocators/phaseActions及来源，不能运行中临时改写。
5. 执行assemble校验后才生成脚本；校验只保证身份与计划完整，不证明模型理解或实际代码行覆盖。

## JSON 操作清单

使用 `scripts <runtime目录>` 生成 `scripts/<caseId>.json`。保留 `schemaVersion: 1` 和四段操作数组 `verify_preconditions`、`navigate`、`verify_target`、`scenarios`。目标即起点时 `navigate` 可留空，其余必须填写。已安装的 worker 固定持有唯一 driver，负责唤醒、重启、记录和关闭。

每步包含 `op` 和可选的 `args` 数组，按表中顺序传参。返回结果的操作可用 `save` 保存，名称以字母开头，仅含字母、数字、下划线或短横线，且不能重复。后续参数中的 `{"$ref":["名称","字段",0]}` 依次读取已保存的结果、对象字段和数组下标。字段路径必须来自实际布局树或冻结声明。每例最多 256 步、256 KiB。

| 接口 | 目的 |
| --- | --- |
| require_visible(locator, scope=null) / wait_visible(locator, scope=null, timeout=8) | 验证唯一、可见、非零面积目标，返回真实节点。等待必须大于 0 且最多 30 秒 |
| tree() | 取得实际布局树，供业务读取字段 |
| click(locator, scope=null) / input(locator, text, scope=null) | 对核实后的目标点击或输入，随后验证业务结果 |
| repeat_click(locator, count=2, interval=0.05, scope=null) | 在同一进程内连续操作 2 到 5 次，间隔 0 到 1 秒，记录实际耗时 |
| locator(name) / action(name) | 返回本例在冻结 phaseLocators/phaseActions 中声明的当前阶段值 |
| back() / wait(seconds) | 收起键盘等操作或最多30秒有界等待 |
| data_ready(actual) | 比较实际前置数据与 preconditions.state，在前置阶段执行一次 |
| check(assertionId, actual) | 记录实际值并与当前阶段预期比较，失败保留 FAIL |
| capture(captureId) | 保存预先声明的截图与布局树，校验图像并登记哈希与时间 |

以下清单示例读取页面的实际初始值和操作后结果。用例须事先声明功能断言 `A1`、采集点 `result` 及与实测对应的初始状态。

```json
{
  "schemaVersion": 1,
  "verify_preconditions": [
    {"op": "require_visible", "args": [{"key": "initial-status"}], "save": "initial"},
    {"op": "data_ready", "args": [{"status": {"$ref": ["initial", "attributes", "text"]}}]}
  ],
  "navigate": [],
  "verify_target": [{"op": "require_visible", "args": [{"key": "confirm"}]}],
  "scenarios": [
    {"op": "click", "args": [{"key": "confirm"}]},
    {"op": "wait_visible", "args": [{"key": "confirmation-output"}, null, 3], "save": "result"},
    {"op": "check", "args": ["A1", {"$ref": ["result", "attributes", "text"]}]},
    {"op": "capture", "args": ["result"]}
  ]
}
```

locator使用key/text/type/hint，必要时在scope中限定唯一容器。contains可描述有源码和实际布局依据的最小容器。重复目标禁止取第一个；定位与操作均记录实际节点。默认共享定位；阶段差异读取本例已冻结的phaseLocators/phaseActions。不能给after补ID再假设before具备，也不能改产品源码来迎合测试。

每例先恢复测试所需状态并实际读取值，调用 data_ready。每个功能断言和采集点各声明一次。实际值来自设备观测，不能照抄预期。视觉断言由采集点和宿主判定完成。现有操作无法观察或建立的状态写成具名缺口。

Toast 或防连点操作在 scenarios 内连续完成并及时 capture。功能失败与采集失败分开报告。缺少观测出口时报告缺口，不添加未经批准的测试入口或埋点。

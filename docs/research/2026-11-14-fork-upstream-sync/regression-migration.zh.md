# Fork 同步回归迁移

官方基线为 `9b2c15a8cbb321ae4e36d48849676e14d90eba24`，fork 比较基线为 `31c780e76ff3275f3697cde01374dc04608e0bd1`。普通 Native 内容证明的撤下依据 `report:2026-11-08-agent-managed-workflow-content`，由 Agent 平台执行普通检查的依据为 `report:2026-11-10-agent-platform-execution`。原报告、登记和测试正文保存在本目录。当前测试覆盖接替的业务契约。

| 原案例                                               | 当前验证                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `native-sdk-configured-input-exclusions`             | 保留配置更新、任务配置继承、排除文件过滤和交付前拒绝暂存排除文件的断言。普通 Native 由 Agent 判断检查适用性，不再为全项目采集候选收据。 |
| `native-codegraph-cache-input-drift`                 | 通过生成的 Native Runtime 验证普通编辑不会触发旧内容证明，实际检查结果与 Run 保留。多仓交付另外验证缓存与源代码的交付范围。             |
| `native-task-result-retry-after-formal-review`       | 原 Builder claim 与 Shape 批准仍可继续，修改后的真实失败保留。旧的正式材料指纹、自动拒绝和复核交互已撤下。                              |
| `native-formal-review-restored-approved-bytes`       | Agent 判断编辑后保留原 SDK 所有权和状态，真实失败继续阻止归档。旧复核提案无当前执行入口，历史记录不用于审批新材料。                     |
| `native-verify-resume-after-input-exclusions-change` | 拒绝旧快照命令，现行修订流程要求完整新验收。交付对象或目标变化后需要新的组合检查。旧的 Verifier 排除范围恢复请求已撤下。                |
| `native-verify-ignore-checkpoint-temporary-file`     | 旧受管快照入口退役。检查点恢复保留原候选、审批和 Verifier，业务流程可继续，不产生额外受管检查。                                         |
| `native-successor-checks-after-checkpoint-recovery`  | 检查点恢复保留原业务历史。修订后的候选用 Agent 实际执行的结果进行新验证，旧检查不得自动重放。                                           |
| `native-verify-ignore-codegraph-daemon-files`        | 生成 Runtime 不启动内容证明。多仓交付校验实际 Git 内容，排除缓存不会把同目录其他源码一并排除。                                          |

这些映射保留了事务、审批与恢复结果。原测试对进程、旧受管检查回执、快照比较和自动失效的断言只供历史查阅。新增映射需要通过其中的精确 Vitest 选择器验证，不作为真实模型或平台执行的证据。

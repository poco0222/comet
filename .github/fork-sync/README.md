# Fork 上游同步

这组文件只维护 `poco0222/comet`，不修改 Comet 产品行为。

- `fork-upstream-sync.yml` 在 GitHub 每六小时检查 `rpamis/comet:master`，并响应手动运行及候选 CI 完成事件。
- 无更新时结束；冲突时记录路径并保持 `feat/native-multi-repo-workspace` 不变。
- 无冲突时创建独立候选分支，显式启动 `fork-ci.yml` 的完整非 macOS 检查。
- 待办保存在 `automation/upstream-state` 分支的 `state.json`。Mac 关机时该记录不会过期，也不占用等待中的 GitHub runner。
- 本机定时任务只读取待办，在普通 clone 中验证指定候选。全部 macOS 检查通过后，由账户 `poco0222` 给该候选发布 `fork-sync/macos=success` commit status，再手动触发同步工作流。
- GitHub 核对全部 26 个云端 job、同一个候选 SHA、本机报告账户、双方历史及功能分支是否前进，然后进行非强制快进更新。失败、跳过或尚未完成均不能合入。

macOS 范围为当前 CI 的 Runtime smoke、Core regressions、SDK contracts 和 Package install；真实模型 Eval 与全局安装不在范围内。断电中断时只接受已完整记录的成功分组，未完成分组在开机后的下一次本地定时运行重跑。候选改变时旧证据全部失效。

`ci-source.sha256` 绑定已核对的产品 CI 定义。若上游修改该文件，停止并要求重新核对非 macOS 工作流与本机检查映射，不沿用过期清单。`expected-jobs.json` 要求每一个云端 job 成功，不能只看总 run 为绿色。

CI 失败后的人工补跑仍须针对原候选；补跑完成会再次触发同步。冲突需在功能分支解决或等待新的上游提交，自动任务不会选择 ours/theirs。`master` 仅承载这些维护文件，不能将它整体合入功能分支代替官方 `master`。

GitHub schedule 可能延迟；公开仓库长期无活动时 GitHub 可能禁用计划。本机任务可以恢复仅因 inactivity 自动停用的这两个工作流，但不得恢复用户手动停用的工作流。Dot 专属消息通路另行关联；这里使用 GitHub 运行记录和本聊天任务结果。

本地检查维护逻辑：

```sh
python3 -m unittest discover -s .github/fork-sync -p 'test_*.py' -v
```

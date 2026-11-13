# Codex Hook 本机兼容性验收

来源：`report:2026-11-11-codex-hook-compatibility`。本次修复共享平台解析器，未启动或恢复用户工作流，未修改用户的 Codex 配置或全局 Comet 安装。

## 原因与修改

[Codex 官方 Hook 契约](https://learn.chatgpt.com/docs/hooks#pretooluse)规定，`apply_patch` 的补丁位于 `tool_input.command`。0.5.2 对应提交 `a61a2e5b4766e1ad62377dec598e402560a259b6` 和本次比较基线 `9acbeb1099dc2f056e8a435d34aa8cee1fd2c141` 均只读取其他补丁字段，导致真实请求没有写入目标，Guard 未执行对应保护。

修复仅在工具名归一化为 `apply_patch` 时读取 `command`，复用现有补丁目标与拟写内容解析。普通 shell 命令仍按原契约处理。补丁解析同时纳入 `*** Move to:` 目标，避免仅检查移动前路径。

## 确定性回归

相同新增断言在旧源码及旧 Router 下有 4 项失败、1 项通过：命令字段目标和写入提案丢失、移动目标遗漏、真实格式未被 Router 拦截；shell 命令反例通过。修复后 3 个定向测试文件共 98 项通过。随后加强 shell 反例，使用独立行补丁头，重新执行登记案例。

相邻 Native/Classic Guard、edit-review、工作区归属及符号链接测试：177 项通过、3 项 Windows 专属用例在 macOS 跳过。

## 真实 Codex 平台对照

环境：2026-11-11，macOS 27.2 arm64，Node 24.22.2，Codex CLI 0.167.0 的真实 `app-server`。项目范围安装本次构建产物；临时协调目录包含 backend/frontend/mobile 三个 Git 仓库及 task-a/task-b 两组 worktree。

测试使用独立 HOME、CODEX_HOME 和 COMET_DATA_DIR。仅在该临时 Codex 配置中信任测试项目和已读取的确切 Hook 哈希。模型传输指向本机 127.0.0.1 固定响应服务，每轮 10 个响应驱动 9 次真实 `apply_patch`，真实模型调用为 0。

为保存实际输入，测试 Hook 命令包装器逐字转交 stdin 给已安装的 Router，原样转发 stdout、stderr 和退出码。实际输入逐条核对 `tool_name=apply_patch`、`tool_input.command` 与补丁一致、`session_id` 与实际 thread ID 一致。每轮观察到 9 次 `hook/started` 和 9 次 `hook/completed`。首个合法写入自动将会话绑定到 task-a；未预先手工绑定。

同一临时项目先执行旧 Router，再恢复全部被测文件初始内容并执行新 Router：

| 实际补丁                            | 旧 Router | 修复后       | 修复后的磁盘结果       |
| ----------------------------------- | --------- | ------------ | ---------------------- |
| 新增自己的 `specs/platform/spec.md` | 放行      | 放行，exit 0 | 文档创建成功           |
| 修改该文档                          | 放行      | 放行，exit 0 | 内容为预期的 `updated` |
| 写 task-b 源码                      | 放行      | 拦截，exit 2 | 文件不存在             |
| 写协调目录原始源码                  | 放行      | 拦截，exit 2 | 文件不存在             |
| Shape 阶段新增 task-a 源码          | 放行      | 拦截，exit 2 | 文件不存在             |
| 将合法文档移动到源码路径            | 放行      | 拦截，exit 2 | 原文档保留，目标不存在 |
| Shape 阶段删除源码                  | 放行      | 拦截，exit 2 | 原文件及内容保留       |
| Shape 阶段修改源码                  | 放行      | 拦截，exit 2 | 原内容保留             |
| 一次补丁混合合法文档和源码新增      | 放行      | 拦截，exit 2 | 两个新文件均不存在     |

旧版本 9 次全部返回 0，禁止的修改实际发生；新版本返回 `[0, 0, 2, 2, 2, 2, 2, 2, 2]`，全部文件断言通过。初次试跑曾误用不允许的自定义 `platform-note.md` 作为正例，故整轮拒绝；该结果不计入验收，改用正式允许的 Spec 文档后才得到上述通过结果。

产物 SHA-256：

- 旧 Router：`d97673b894393163140739951e212eea0c03744d51529c688d1922ae5aa88863`
- 新 Router：`a3b4b1cec2b810ebe6d54a3809c79740a27427aeb5b02a859560fe40448abfd9`
- 解析器源码：`85b8e932e16a6ccb35ed51a761ac7464cbdf51481f4e6ce5dc4bda188305388a`
- 本地平台验证脚本：`29a180d772b0c5caa1a2950d2b9a894264fb5bf2575c5aa664fa697bd68fdbf2`

原始事件、Hook stdin/退出码、前后文件快照和清理回执保存在本次聊天的 `outputs/codex-hook-evidence.zip`。被测旧/新会话分别为 `01a1c815-b33e-7191-99b2-24eba2550c30`、`01a1c815-b8ff-7650-8f37-7ad47b959db6`。

## 复跑入口与范围

```sh
pnpm build
pnpm test:core-regressions --case codex-hook-command-payload
pnpm test:core-regressions --case codex-hook-patch-move-destination
pnpm check:generated
```

以上登记用例验证解析器及打包 Router，不代替真实平台验收。平台复跑需在隔离配置和临时项目中安装生成物，信任该项目及确切 Hook，使用本地固定响应驱动上述 9 项补丁，并同时核对实际 Hook 事件与磁盘结果。

测试进程已退出，临时项目、worktree、Runtime 数据及独立 Codex 配置已删除，未新增测试工具。未执行真实模型 Eval，未证明模型自主遵循工作流。上述本机验收完成时尚未提交、推送或重跑全量 CI，也未替换全局安装；后续提交与 CI 结果另行记录。

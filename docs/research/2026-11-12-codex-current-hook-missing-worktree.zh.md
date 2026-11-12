# Codex Hook 处理缺失的旧工作树

来源为 `report:2026-11-12-sam-current-hook-missing-worktree`。SAM 当前需求记录的隔离方式为 `current`。旧 Router 枚举同一协调目录的登记时，会重新读取每个工作树的目录身份，以定位其 Runtime。工作树父目录缺失后，这一步以 `ENOENT` 中止，当前需求的写入也无法到达 Guard。

修复后，Router 根据登记的工作区身份定位旧 Runtime。请求指向某个旧工作树时，仍会校验它的实际归属。用新旧 Router 对 SAM 当前 Build 目录执行模拟写入请求，旧版本返回 2，新版本返回 0。该检查只运行 Hook，未写入 SAM 项目。

## 真实 Codex 对照

2026-11-12 在 macOS arm64、Codex CLI `0.167.0` 上执行。隔离项目有三个 Git 子仓、一个当前目录需求和一个独立 worktree 任务。将 worktree 父目录移走，保留登记与外部 Runtime。通过项目范围安装 Hook，复用本地固定响应服务，让真实 Codex `app-server` 分别向旧、新 Router 发出相同的四次 `apply_patch`。每轮都核对了四条 `hook/started` 和 `hook/completed` 事件、实际补丁、会话 ID 和磁盘结果。真实模型调用为 0。

| 实际补丁                       | 旧 Router | 新 Router | 新 Router 磁盘结果 |
| ------------------------------ | --------- | --------- | ------------------ |
| 新增当前需求的 Shape Spec      | 2         | 0         | 写入成功           |
| 新增当前目录的业务源码         | 2         | 2         | 文件不存在         |
| 写入缺失的旧 worktree          | 2         | 2         | 文件不存在         |
| 写入旧 worktree 保留的 Runtime | 2         | 2         | 文件不存在         |

- 旧构建 `ee407b4` 的 Guard SHA-256 为 `0a55720d4d63e711c59df47a81e86bf29846fff568746d3fe5343c31bf6572eb`，对照会话为 `01a1cea5-d00b-7471-99b7-b77bba84222a`。
- 修复构建的 Guard SHA-256 为 `7ae73a4950022eb37eb42ff080b41b2edce3fa8dbef1b94c5ef6e049ec8d95f4`，对照会话为 `01a1cea5-d2fd-7823-9cf6-a7414c21391e`。

测试结束后清理了临时项目、Runtime 和 Codex 配置。此验收覆盖真实平台的 Hook 路由及写入结果。

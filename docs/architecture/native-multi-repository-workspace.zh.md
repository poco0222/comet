# Native SDK 多仓工作区

来源：`report:2026-11-10-native-multi-repository-workspace`。

一个普通目录可以协调多个独立 Git 仓库。Native 为每个任务创建独立目录，在其中分别建立各仓的 worktree，用一个 SDK Run 管理 Shape、Build、Verify 和 Archive。父目录不需要初始化 Git，子仓也不需要转换成 submodule。

## 配置与创建

从未登记子仓的非 Git 父目录请求创建工作树时，`native new --isolation worktree` 会检查直接子目录，并在找到独立 Git 仓库时列出建议的登记条目。`--dry-run` 也会给出同样的提示。确认哪些仓库参与后，将对应条目加入配置，再重试原命令。发现过程不修改配置，也不创建分支或工作树。

在父目录现有的 `.comet/config.yaml` 中增加项目级配置，保留其他字段：

```yaml
repositories:
  - path: backend
    target_branch: main
  - path: frontend
    target_branch: main
  - path: mobile
    target_branch: main
```

`path` 是相对父目录的独立 Git 根，不能重叠或经过符号链接。省略 `target_branch` 时使用该仓当前附着的本地分支。全局配置不能声明项目仓库。

`native.artifact_root` 必须位于子仓之外，例如父目录的 `docs`，不能与声明的仓库路径重叠。当前版本不支持把多仓任务的正式材料根放进其中一个子仓。

```sh
comet native new task-a --isolation worktree --dry-run --json
comet native new task-a --isolation worktree --plan-hash <预检返回的哈希> --json
comet native new task-b --isolation worktree --json
```

父目录为 `project` 时，默认在旁边的 `project-worktrees/task-a` 中建立 `backend`、`frontend`、`mobile` 三个 worktree，分别使用各仓的 `comet/task-a` 分支。任务自己的 `.comet/config.yaml` 和 `docs/comet` 位于这个任务目录。`task-b` 有另一组独立目录和 Run。

自定义 `--worktree-path` 也必须与其他任务根分离，不能把新任务放进已有任务。预检和实际创建都会检查同一协调目录中已登记或部分创建的任务，避免预检后另一个任务占用目录。

预检固定各仓的基线、目标分支、路径和物理身份。创建按同一计划恢复，原仓未提交的文件留在原地。任务开始前保存并复制父目录的 canonical Specs；恢复时不会覆盖已经修改的任务 Specs。每个任务目录仍只允许一个活跃 change，并行任务各有自己的目录和 Run。

父目录的 `status` 可以列出任务；命名的 `next`、`archive`、`deliver` 和 `cancel` 会定位对应任务。Agent 应在返回的任务根目录工作。Hook 将同任务内的跨仓写入交给同一个 Native Guard，拒绝跨任务写入和任务到原仓的写入。

会话停留在父目录时，首次指向任务的写入请求和 `next --session` 会绑定该会话的任务归属。此绑定只记录路由，不代表写入获准；Shape 等 Guard 仍执行原检查。同一会话后续不能通过更换目标路径写入另一任务或原仓，其他会话可以绑定不同任务。需要明确切换时使用平台实际传入的会话 ID：

```sh
comet native select task-b --session <actual-session> --json
```

该命令只切换指定会话。平台未提供会话 ID 时，写入工具必须在任务根或其子仓目录执行，或显式绑定任务根；父目录中的无会话写入不会猜测归属。绑定记录存放在父目录对应的外部 Runtime 中，以会话 ID 的哈希命名；读取上下文不创建绑定。任务登记缺失或损坏时停止路由，不能自动转到其他任务。

会话从已登记的原始子仓目录调用全局 Hook 时，也会查找父协调目录的绑定，执行同样的跨任务、原仓写入和阶段检查。此规则只匹配登记中身份一致的原始仓库，不改变旁边未登记 Git 项目的发现边界。

集成目录也登记到所属任务。全局 Hook 从集成根或其子仓执行时，继续核对原会话和任务归属，拒绝写入其他任务及原仓；符号链接不会改变目标归属。登记同时保存在协调目录与集成目录的外部 Runtime 中，不能通过普通写入工具修改。集成目录缺少归属登记时停止路由，可从所属任务根重新运行原 `deliver` 准备命令补齐；登记损坏或身份不匹配时需先检查记录。

## 本地环境准备

需要本地配置或依赖时，可以显式传入 JSON 清单；不传入时不会自动复制配置或安装依赖：

```json
{
  "copyFiles": ["backend/.env", "frontend/.env.local"],
  "checks": [
    {
      "id": "frontend-dependencies",
      "name": "Prepare frontend dependencies",
      "executable": "pnpm",
      "argv": ["install", "--frozen-lockfile"],
      "cwdRef": "frontend",
      "timeoutMs": 120000,
      "repeatable": true
    }
  ]
}
```

```sh
comet native new task-a --isolation worktree --setup setup.json --dry-run --json
comet native new task-a --isolation worktree --setup setup.json --plan-hash <预检哈希> --json
```

`copyFiles` 只接受声明子仓中的普通文件，而且必须未被 Git 跟踪并被忽略。它不是目录复制或通配符；`.git`、`.comet`、越界路径和符号链接均被拒绝。目标分支也必须保留对应忽略规则。预检核对工具是否可用、文件是否可读，仅把文件摘要和命令绑定到计划，不复制文件、不执行准备命令、不输出配置内容。

创建时先复制指定文件，再从任务目录执行准备命令，通过后才创建 SDK Run。本地配置以仅当前用户可读写的权限复制；任务目录也限制为当前用户访问。配置作为任务输入参与快照与候选校验，但保持 Git 忽略，不会因交付而加入提交。

准备命令必须声明 `repeatable: true`。每次执行都有进程、结果和日志收据；失败后处理实际环境错误，再运行相同的 `new` 命令继续，也可省略 `--setup` 复用原计划。已完成步骤不会重复执行，任务中已修改的配置不会被原仓副本覆盖。未知或仍运行的进程会阻止重试；日志损坏、已准备的配置缺失也会明确阻塞。成功后自行删除依赖或配置不等于撤销原收据，应先恢复所需环境。

集成目录会复制当前已验收的本地配置，并重新执行同一清单的准备命令，然后运行联合验收。准备命令用于依赖安装与环境检查；如果它改变集成源码或其他已绑定输入，交付会停止。命令运行在隔离目录，但不提供操作系统沙箱；清单中的命令仍须遵守项目的工具和安装授权边界。

## 验收与本地交付

结果接受和 Archive 保持原 SDK 流程。未接受、未归档或者候选内容已变化时，不能开始 Git 交付。Supervisor 子任务目前不支持多仓绑定。

```sh
comet native deliver task-a --commit-message "feat: add selected behavior" --json
```

准备阶段提交已绑定的任务代码，在独立集成目录中合并各仓当前目标分支，再运行原候选声明的可重复检查。没有变化的仓库不产生额外提交。全部检查通过前不更新原仓目标分支。

联合检查的集成源码必须与待交付 Git 提交一致。初次检查、失败重试和实际合并都会拒绝未提交的源码改动，包括已暂存修改和新增普通文件，不能用工作区中的修复让旧提交通过检查。已声明的检查输出和显式复制的忽略配置沿用原规则。检查失败后保全本地修改，通过原工作流重新验收候选，或在目标分支得到修复后刷新集成。

任务根目录中的检查脚本及其他已绑定输入也复制到集成目录，保留可执行权限；源文件、副本和新增文件均参与内容检查。运行时文件和已声明的检查输出沿用原快照排除规则，不因复制而成为候选。父目录没有 Git 历史，因此这些根目录材料保留在任务目录；Git 交付只更新声明的子仓，共享 Specs 按下述冲突检查发布。

响应返回绑定本次集成结果的命令：

```sh
comet native deliver task-a --apply <planHash> --json
```

执行时再次检查任务内容、集成目录、检查日志、目标分支和原仓是否干净。Git 没有跨仓原子合并，因此工具逐仓记录结果；中断后保留已完成的仓库，不回滚其他人的工作。重试同一个 `--apply` 继续未完成部分。

交付尚未全部完成时，即使某仓已经合并，其他任务继续推进该仓目标分支也会使本轮联合检查失效。此时旧 `--apply` 会停止，必须重新集成并检查。已完成交付的重复查询仍保留原结果，不因后续正常提交而重复合并。

目标分支更新时，使用错误响应中的 `refresh.commandArgs`，或读取 `status task-a --details --json` 中的 `workspace.delivery.id`：

```sh
comet native deliver task-a --refresh <deliveryId> --commit-message "feat: add selected behavior" --json
```

新轮次基于当前目标重新合并、重新检查，并保留旧集成目录和日志。任务候选必须保持不变；运行中的检查、未处理的目标改动和丢失的已交付提交会阻止刷新。Git 冲突保留在集成 worktree 中，解决后可以执行原准备命令。修改任务代码需要原工作流的重新验收，不能用刷新集成来接受新代码。

全部代码合并后再同步本任务涉及的 canonical Specs。工具对照创建时的基线，拒绝覆盖其他任务修改过的文件。此处阻塞时，响应明确标记 Git 已合并、Specs 尚未同步，并返回恢复命令。重复交付不会覆盖此后发布的规格版本。

任务目录、归档材料、检查日志和集成目录均保留。命令不推送远端，也不自动删除 worktree。依赖和本地配置可使用上述显式清单准备；数据库、服务端口等真实服务环境仍需按项目约定配置。

## 显式清理

代码和共享 Specs 都交付后，从父协调目录预览可清理的 worktree：

```sh
comet native deliver task-a --cleanup --json
comet native deliver task-a --cleanup --apply <交付 planHash> --json
```

仅删除身份、提交和目标分支祖先关系仍匹配的干净 worktree。每次清理及重试还会核对检出的分支：任务 worktree 必须保持原任务分支，集成 worktree 必须保持 detached HEAD；即使提交相同，切到其他分支也会保留。未提交文件、未跟踪文件、Git 忽略文件、当前命令所在目录以及无法证明已经合并的旧集成均会保留，响应逐项说明原因。特别是 `.env` 和 `node_modules` 不会因为 Git 显示干净就被删除；不自动搬运或清空这些文件。自行处理保留项后，可以重试相同清理命令。

删除意图先于 Git 操作记录，中断后继续原收据；已删除路径被重新使用时停止，不能删除新目录。任务根、正式归档、共享规格、检查日志和任务分支保留，不清空整个任务目录。清理开始前保存原 SDK Run 的只读状态投影，并绑定未改变的 Run；父目录和任务根的 `status task-a --details` 仍可查看历史及清理记录。此投影不用于恢复执行；已清理任务不能再次推进或重新交付。

部分或全部子仓清理后，在保留的任务根执行命名的 `status` 和相同 `deliver --cleanup` 重试，无须额外传入 `--project-root`。目录发现只定位已登记任务，具体命令继续核对原 Run 和清理收据；这不会放宽活跃成员缺失时的写入、会话切换或流程推进检查。

清理后可用原会话执行 `select task-b --session <actual-session>`。切换会核对原 Run、任务登记和清理收据，仅允许收据确认删除的成员缺席；活跃成员缺失、收据损坏、旧路径或 Git worktree 登记被重新占用时仍会停止。

创建时若在目录生成后、身份收据写入前崩溃，工具会保留目录并报告未登记身份。此类不确定目录必须先检查和保全，再恢复原路径上的创建；不会按目录名自动接管。部分创建中出现同名外来分支也会拒绝，即使提交恰好相同。

## 验证边界

- 基线 `a61a2e5b4766e1ad62377dec598e402560a259b6` 的自包含 Runtime 在相同非 Git 父目录返回 `Native branch and worktree isolation require an attached Git branch`。新入口在相同输入下创建三个 worktree。此对照测试需要对应 Git 历史；CI 使用完整历史检出。
- 创建测试覆盖三个临时仓、两个任务、原仓脏文件、部分创建恢复、只读预检及绑定漂移。
- 完整流程分别运行源码 CLI 和生成的 Runtime bundle，使用正常 SDK claim、outcome 和决定协议，执行真实检查并完成 Archive、本地合并及共享 Specs 冲突恢复。测试中的 Agent/User 是确定性模拟，不代表真实模型判断或生产需求验收。
- 临时 npm consumer 安装打包产物后，使用包内公开 CLI 和 SDK 再运行同一三仓流程，包括清理和历史查询。安装禁用 npm 生命周期脚本，临时 consumer、包和 npm 缓存在测试后删除；未替换全局安装。
- 交付测试覆盖脏目标、外部 Git 锁、部分合并重试、目标更新后的重新集成、候选及日志漂移，还有规格创建、修改、删除和后续更新保护。
- Hook 测试验证路由和 Guard，未验证真实 Agent 平台事件。没有启动真实模型 Eval，也没有修改业务项目或全局安装。

当前实现位于开发分支，尚未提交、推送或安装到业务项目。依赖准备的测试使用确定性 Node 命令；真实项目的依赖管理器、数据库、端口、Agent 平台 Hook 及其他操作系统仍需各自验证。

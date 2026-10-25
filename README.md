# Codex Desktop Task Orchestrator

将任务拆分到真正的 Codex Desktop 独立对话，由主对话负责文本调度、依赖跟踪和版本交接。适合包含图片、视频等媒体的多阶段工作。

## 工作方式

- 主对话接收目标和素材路径，默认不读取媒体内容；只接收文本状态、验证证据及文件链接。
- 子对话读取必要素材，执行明确阶段的任务并验证交付物。主对话使用 `🌟` 标识，子对话使用 `->` 标识。
- 默认按 4 个活动对话总预算派发：1 个主对话、最多 3 个业务子对话；独立监测和其他活动也占名额。其余任务在文本队列等待，有拥堵时减少新派发，恢复后逐步增加。这是保守起点，不是 Codex 的产品上限。
- 新阶段创建全新对话，只交接选定版本和仍有效的要求。同阶段历史过大也可在安全点换新；主对话通过“准备、接收确认、提交派发权”移交给新主对话，保留旧入口，防止重复工作。
- 区分执行完成、子对话验证、用户确认和自动推进授权，防止误用旧版本或重复提交状态未知的生成请求。
- 需要继续的空闲子对话可按需 compact，已经不再使用的会话无需额外压缩。主对话不能用空闲适配器压缩正在执行的自己。
- 默认主对话监测；可选独立监测对话只读观察和报告，由唯一总控执行恢复。离开当前回合后的持续监测需要另外创建并验证 heartbeat 自动化。

这套流程减少历史媒体在后续请求中的累积，不保证消除网络延迟、服务端排队或桌面内部阻塞。已有的图片不会因为提示词要求“忽略”就从上下文卸载。

## 安装 Skill

需要支持真实对话创建和进度跟踪工具的 Codex Desktop 环境。只有普通 CLI 或缺少这些工具的环境，不能用其他会话机制代替本 Skill 的独立桌面对话。

将仓库放到 Codex 的个人 skills 目录下，文件夹名使用 `desktop-task-orchestrator`。例如默认 Windows 路径：

```powershell
git clone https://github.com/Purextreme/codex-desktop-task-orchestrator.git "$HOME\.codex\skills\desktop-task-orchestrator"
```

如果设置了 `CODEX_HOME`，安装到该目录的 `skills/desktop-task-orchestrator`。已有同名安装时先检查并保留本地修改，不直接覆盖。

在新的主对话中提供任务目标、素材路径、交付要求及预算，并调用 `$desktop-task-orchestrator`。媒体可在子对话里查看和修改；主对话负责交接。仅讨论或修改 Skill 不会自动创建业务对话。

## 可选：desktop_compact MCP

`scripts/compact-thread.cjs` 是一个无第三方依赖的 Node.js stdio MCP 服务，也可从命令行调用。它只适用于本机 Windows Codex Desktop，通过现有 `codex-ipc` 命名管道提交压缩请求，不启动额外 app-server。

这是非官方的内部 IPC 适配器，应用更新后可能失效。它没有自动定时压缩功能，也不会自行查询聊天是否空闲。调用方必须先确认授权，并通过 `wait_threads` 确认目标无活动轮次。

在 Codex 配置中按本机实际 Node.js 和脚本位置添加以下配置；示例路径需要替换，已有同名配置应更新而非重复添加：

```toml
[mcp_servers.desktop_compact]
command = "node"
args = ["C:/path/to/desktop-task-orchestrator/scripts/compact-thread.cjs"]
```

若桌面进程无法通过 PATH 找到 Node.js，`command` 使用 `node.exe` 的绝对路径。安装 MCP 的方式和加载时机以当前 Codex 版本为准。

提供的工具是 `compact_thread`，参数为真实聊天 UUID 和 `idle_confirmed: true`。命令行等价入口：

```powershell
node ./scripts/compact-thread.cjs --thread-id <真实聊天UUID> --idle-confirmed
```

返回 `started` 仅表示已受理。必须继续用 `wait_threads` / `read_thread` 核实已完成的 `contextCompaction`；超时或结果未知时先检查，不盲目重试。压缩不保证清空全部旧图片，也不会卸载旧聊天的后台进程。

原生自动 compact 的 token 阈值属于 Codex 自身设置，本仓库不会修改它。图片字节量可能先于 token 用量快速膨胀，因此自动 compact 不能替代阶段隔离。

## 文件

- `SKILL.md`：完整编排、隔离、验收与版本交接规则。
- `agents/openai.yaml`：Skill 界面元数据。
- `scripts/compact-thread.cjs`：可选的 Windows compact MCP / CLI 适配器。
- `scripts/plan-dispatch.cjs`：无依赖的只读派发检查器，校验所有权、快照新鲜度、活动名额、依赖和资源占用，输出候选及异常，不执行任务。
- `references/session-lifecycle.md`：选择 compact 或换新，最小交接包与主对话接班协议。
- `references/scheduling-and-monitoring.md`：就绪队列、状态格式、退避、恢复与可选监测。
- `tests/plan-dispatch.test.cjs`：离线模拟队列、移交、拥堵及异常的测试。

长流程使用项目中的 `.orchestrator/<工作标识>/state.json` 保留当前状态，只有当前总控写入。根据最新工具结果刷新后运行：

```text
node scripts/plan-dispatch.cjs <state.json> <当前总控threadId> <generation>
node --test tests/plan-dispatch.test.cjs
```

检查器不连接 Desktop、不调用模型、不读取媒体；不是跨所有主对话的硬锁或后台服务。详细状态例子和执行前的核对要求见调度文档。并发数或检测阈值应随实际证据调整，不能用无进展计时器直接杀任务或重发付费请求。

发布前已检查 Skill 格式、Node.js 语法和 MCP 初始化、工具发现及无效参数拒绝行为。真实桌面交接与 compact 曾在本地环境验证；不代表所有版本和账号环境均兼容。仓库不包含用户素材、聊天记录、本机配置、凭据或运行日志。

# Codex Desktop Task Orchestrator

将任务拆分到真正的 Codex Desktop 独立对话，由主对话负责文本调度、依赖跟踪和版本交接。适合包含图片、视频等媒体的多阶段工作。

## 工作方式

- 主对话接收目标和素材路径，默认不读取媒体内容；只接收文本状态、验证证据及文件链接。
- 子对话读取必要素材，执行明确阶段的任务并验证交付物。主对话使用 `🌟` 标识，子对话使用 `->` 标识。
- 默认按 4 个活动对话总预算派发：1 个主对话、最多 3 个业务子对话；独立监测和其他活动也占名额。其余任务在文本队列等待，有拥堵时减少新派发，恢复后逐步增加。这是保守起点，不是 Codex 的产品上限。
- 图片密集工作从 2 个业务子对话起步；轻量任务可经分档回测再试升到 4 个，综合吞吐、最慢任务和控制响应决定。状态接口报错时改用低频串行读取，观测链路也不可靠时停止新增，不继续堆叠监测请求。
- 新阶段创建全新对话，只交接选定版本和仍有效的要求。同阶段历史过大也可在安全点换新；主对话通过“准备、接收确认、提交派发权”移交给新主对话，保留旧入口，防止重复工作。
- 区分执行完成、子对话验证、用户确认和自动推进授权，防止误用旧版本或重复提交状态未知的生成请求。
- 需要继续的空闲子对话可按需 compact，已经不再使用的会话无需额外压缩。主对话不能用空闲适配器压缩正在执行的自己。
- 使用轻量本地监测：未压缩 HTTP 请求体达到 20MB 提醒、25MB 在安全节点换新，仅携带选定版本和必要状态；选版不明确才询问用户。控制请求阻塞或观测失效时暂停新增，已有任务继续运行。
- 本地进程每 15 秒读取增量元数据，不占模型名额；总控负责交接和恢复。它不读取媒体、不删文件、不修改聊天数据库。回合结束后可继续写状态，但不会主动唤醒模型或通知用户；未来主动跟进需要另行安排 heartbeat。

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
- `scripts/local-monitor.py`、`scripts/start-monitor.ps1`：Python 标准库元数据监测与 Windows 隐藏进程启动器；每个工作目录单写者、原子状态输出、默认 8 小时退出。
- `scripts/monitor-policy.cjs`：health 校验及选定版本交接策略，不执行媒体读取或聊天创建。
- `references/local-monitor.md`：启动、停止、20/25MB 规则、阻塞恢复和观测限制。
- `references/session-lifecycle.md`：选择 compact 或换新，最小交接包与主对话接班协议。
- `references/scheduling-and-monitoring.md`：就绪队列、状态格式、退避、恢复与可选监测。
- `tests/plan-dispatch.test.cjs`：离线模拟队列、移交、拥堵及异常的测试。

长流程使用项目中的 `.orchestrator/<工作标识>/state.json` 保留当前状态，只有当前总控写入。根据最新工具结果刷新后运行：

```text
python scripts/local-monitor.py --state <state.json>
node scripts/plan-dispatch.cjs <state.json> <当前总控threadId> <generation>
node --test tests/plan-dispatch.test.cjs tests/monitor-policy.test.cjs
python -m unittest discover -s tests -p "test_*.py"
```

派发检查器不连接 Desktop、不调用模型、不读取媒体；它读取新鲜的本地 health，缺失时停止新增。长流程按本地监测文档启动 watch，不要每次重新扫描。HTTP 大小字段无法覆盖所有 WebSocket 请求，日志缓冲也可能延后发现；这不是发送前硬拦截或跨所有手工聊天的全局锁。阈值是工作流经验值，不是官方限制。不能用无进展计时器直接杀任务或重发付费请求。

发布前已检查 Skill 格式、Node.js 语法和 MCP 初始化、工具发现及无效参数拒绝行为。真实桌面交接与 compact 曾在本地环境验证；不代表所有版本和账号环境均兼容。仓库不包含用户素材、聊天记录、本机配置、凭据或运行日志。

# 本地请求体与阻塞监测

实际拆分派发时启用。监测器使用 Python 标准库，每 15 秒增量读取本机 `logs_2.sqlite` 的 HTTP 大小字段和 Desktop 文本日志的控制请求耗时，不调用模型、MCP、网络或桌面 IPC，不读取聊天正文和媒体。总控仍是唯一派发者；监测器只写自己的 `health.json` 与游标文件，不修改 `state.json`。

## 启动与使用

1. 在工作目录建立调度文档中的 `.orchestrator/<工作标识>/state.json`。只登记本工作当前 owner 和实际子对话 `thread_id`；历史 ID 放到别的字段，避免持续监测已被接班的上下文。总控创建或替换任务后更新映射，等下一份 health 覆盖新 scope 才继续派发。
2. 使用本机已有 Python 3.10+（优先已有虚拟环境），不安装依赖。先运行一次 `python <Skill>/scripts/local-monitor.py --state <state.json>`，检查同目录 `health.json`。默认读取 `CODEX_HOME` 或 `~/.codex`、Windows `%LOCALAPPDATA%/Codex/Logs`；非默认位置用 `--codex-home`、`--desktop-logs` 指定。
3. 长流程用 Windows 隐藏进程启动器，路径使用实际绝对路径：

   ```powershell
   & '<Skill>/scripts/start-monitor.ps1' -StatePath '<工作目录>/.orchestrator/<工作标识>/state.json' -PythonPath '<现有 Python>/python.exe'
   ```

   默认持续 8 小时，`-Hours` 可设 1–24；没有开机自启或自动续期。检查 health 中 PID、sampled_at 连续更新且无 source errors 才算启动成功。每个工作目录只有一个写入者；已有 watch 时读取其 health，不再并行执行一次性采样。写入同目录 `monitor.stop` 可温和结束本监测进程，保留文件；到期或异常退出后 health 超时会阻止新增。重启监测前检查停止原因，明确继续时只移除本目录的 stop 标记。
4. 每次创建、唤醒空闲任务、阶段接班或开始新一批读媒体前，检查 health 与当前任务映射。总控刷新活动状态后运行 `node <Skill>/scripts/plan-dispatch.cjs <state.json> <owner-thread-id> <generation>`。先执行返回的交接候选并更新占位，不能额外使用它已经预留的名额。
5. 给子对话提示词加入 health 的绝对路径与本轮 thread ID；子对话在每批媒体处理前、工具返回后的安全节点读取自己的行。达到 handoff 时停止扩展历史、返回短文本交接并结束本轮；不能为“确认已超标”重新打开图片。总控看到提醒就简短告知用户；相同事件不反复刷屏。

监测进程可以在模型回合结束后继续写本地状态；它不会唤醒模型、弹系统通知或主动创建聊天。自动交接与用户提醒由正在工作的总控/子对话在上述节点执行。用户另行要求离开后主动跟进时才设置 heartbeat。Skill 未参与的手工新聊天不受此协作规则约束。

## 大小规则

这里的 MB 是十进制字节，取 **未压缩 JSON 请求体** `pre_compression_bytes`；不是磁盘图片总大小、token 数、压缩后网络字节或官方限制。

| 观察结果 | 动作 |
| --- | --- |
| 达到 20,000,000 字节 | 一次提醒；减少重复媒体读取，准备版本与剩余工作交接 |
| 达到 25,000,000 字节 | 标记本对话必须在安全点换新；不再向其派发后续工作 |
| 尚无 HTTP 大小数据 | 明确 unknown；按阶段隔离，不据此证明轻量，也不自动停止全部工作 |

20MB 提醒与 25MB 交接标记保留到换新 thread ID，另记录 peak_http_bytes/peak_http_at；后续一个小请求不证明历史已清空，不能自动消除标记。总控记录已展示的提醒，同一越界不反复通知。不要求先 compact。已完成且不再继续的会话只保留，不为它额外创建空聊天或压缩。

`last_http_bytes` 是最近一次**已观测的 HTTP** 大小，不代表当前 WebSocket 请求大小。日志缓冲、版本差异、初次只回看每个线程最近 2000 条记录会造成盲区；首次过大请求可能已经发出。这是观察与派发协作机制，不能宣传成发送前硬拦截。

## 阻塞与恢复

- 只检查本地主机的 `thread/read`、`thread/list`、`thread/turns/list`、`mcpServerStatus/list`、`config/read`、`hooks/list`。不把正常长生成的总时长、等待用户批准或 `hostId=durable` 的重连当成本地控制链路阻塞。
- 一个控制请求耗时达到 30 秒、明确超时/拒绝，或 120 秒内两个控制请求分别达到 10 秒：锁定暂停新增派发。已有任务继续运行；接班创建也等待控制链路恢复。
- 恢复需要异常之后两次成功控制观测，各小于 5 秒，彼此至少相隔 15 秒；之后最近一次成功超过 120 秒仍需新观测。没有新错误、时间流逝和后台进程存活都不能证明恢复。
- Desktop 日志可能缓冲。总控实际进行的一次有界、串行状态读取可补充到 `state.control_probe = {"at":"带时区时间","duration_ms":实际耗时,"outcome":"ok/timeout/error"}`。只记录真实完成/超时，不伪造健康。普通空闲时缺少新日志可通过本来就需要的状态读取刷新；发生阻塞时按 15/30/60 秒有限退避，不为了绿色状态高频查询。
- health 超过 45 秒、来源读取失败、scope/owner/generation 不符时，派发检查器输出 hold。未知状态不算任务结束，也不释放其名额。只针对待开始的工作退避，不停止进程、不重启 Desktop、不重发生成请求。

进度逾期仍沿用调度器的 `last_progress_at` / `expected_progress_seconds`，只建议核查。日志中的控制耗时不是根因堆栈，监测器不会根据插件名称自动停用 MCP。

## 安全交接字段

总控核实旧子对话空闲后记录 `idle_confirmed_at`，需要继续时设 `continue_needed=true`。在 task.handoff 中保存以下必要文本；只从明确选定的版本填充，不按文件名猜“最新”：

```json
{
  "goal": "剩余阶段的目标",
  "authorization": "用户授权的范围与依据",
  "constraints": ["仍然有效的要求、预算和验收标准"],
  "next_steps": ["尚未完成的步骤"],
  "selected_version": {
    "status": "selected",
    "version": "v3",
    "path": "C:/project/selected_v3.png",
    "basis": "可核实的选版或自动推进依据"
  },
  "editable_sources": ["C:/project/source.blend"],
  "external_requests": [{"id":"既有请求ID","status":"pending","query":"查询方式"}]
}
```

没有未决外部请求时用空数组。`external_state=unknown` 时先核实原请求；已知 pending 只交接查询职责。缺少技术交接信息先向子对话补齐，选版确实不明确才问用户；已有明确选择和授权不重复确认。纯文本任务可用选定交付文本文件路径，也可将 selected_version 的 path 改为 text（最长 4096 字符的选定结果），不虚构媒体路径。

检查器输出 `handoffs`：等待安全节点、核实请求、询问版本、补齐文本或 `ready_for_fresh_chat`。`can_create=true` 只是本次名额与控制链路允许，实际创建仍由总控按接班协议执行并立即预留占位。ready 包只保留目标、约束、授权、选定路径、源文件、剩余步骤、外部请求 ID；忽略候选列表、原聊天和媒体数据。主对话超标按主对话接班协议先 draining，不能压缩正在运行的自己。

保留全部旧文件与对话，链接仍然可点击。清理的是新请求携带的历史，不能通过删除磁盘素材或编辑 Codex 内部会话库来实现。

## 验证

```text
python -m unittest discover -s tests -p "test_*.py"
node --test tests/plan-dispatch.test.cjs tests/monitor-policy.test.cjs
```

测试覆盖阈值、缺失/迟到数据、阻塞恢复、轮转、单写者、暂停派发及选版交接，不调用生成。实际日志回放可检验当前格式的识别能力；不能据此保证未来永不卡顿。

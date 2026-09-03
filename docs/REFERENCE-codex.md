# Codex CLI 参照研究（REFERENCE-codex）

> 2026-09-02 ｜ 研读对象：openai/codex（Apache-2.0）`e1d0ef9`（2026-09-02）｜ clone 在 `~/Documents/AI/codex`（不入本仓库，不需安装）
> 用途：为 SamePage 的 agent 层 / 任务层 / 配置层 / 步骤流 / 写前确认提供做法参照。每处三段：它的做法（含源码路径与行号）/ 可借鉴点 / 对应我们哪一层。末尾是可复用代码段清单（含许可要求）与八条排序借鉴。
> 与 `PLAN-v2.md` 的关系：八条借鉴里的 1/2/3/5/6/7 已进 PLAN-v2 的反向修订。

---

> 说明：本文所有路径为绝对路径，代码片段按仓库原样摘录（均 ≤30 行）并标注行号区间。SamePage 对应层记法见任务描述（渲染层 React / 主进程 agent 层 / 任务层 / 进程管理 / 配置 / 会话持久化）。

---

## 0. 仓库结构速览

Monorepo，两大主体：

- `codex-cli/`：npm 壳。`codex-cli/package.json` 里 `"name": "@openai/codex"`，`bin.codex → bin/codex.js`。`bin/codex.js` 只做一件事：按 `process.platform/arch` 映射到一个 target triple（如 `aarch64-apple-darwin`），再定位并 `spawn` 对应平台预编译的 Rust 二进制（`@openai/codex-darwin-arm64` 等平台包）。即：**JS 层零逻辑，纯分发器**——所有能力都在 Rust。
- `codex-rs/`：Rust 主体，约 120 个 crate（workspace）。关键 crate：
  - `core/`：agent 循环、会话、工具调度、沙箱、compaction（本研究主战场）。
  - `protocol/`：core↔前端的事件与类型定义（`EventMsg`、`AskForApproval`、`SandboxPolicy`…），用 `ts-rs` + `schemars` 导出 TS 类型与 JSON Schema。
  - `tui/`：Ratatui 终端 UI（步骤流、审批弹窗、状态栏、slash 命令）。
  - `app-server/` + `app-server-protocol/` + `app-server-transport/`：一个 JSON-RPC 服务端，把 core 暴露给"非 TUI 的宿主"（IDE 插件、GUI）——**这一层最接近 SamePage 的主进程↔渲染层 IPC**。
  - `rollout/`：会话落盘（JSONL）、列举、恢复、压缩。
  - `config/` + `config-schema/`：分层配置、requirements（托管/管理员下发）、schema。
  - `linux-sandbox/`、`sandboxing/`：seatbelt(.sbpl) / landlock / bwrap 沙箱。
  - `mcp-server/`、`rmcp-client/`、`codex-mcp/`：MCP 双向支持。
  - `exec/`、`exec-server/`：非交互 `codex exec` 与执行服务。

平台构建靠 Bazel（`MODULE.bazel`）+ pnpm workspace。`AGENTS.md`（22KB）是仓库自己的 agent 开发规范。

---

# 架构层

## 1. agent 循环与工具调度

### 1.1 turn 循环在哪、状态机怎么走

核心循环是 **`run_turn`**，在 `/Users/tansenpeng/Documents/AI/codex/codex-rs/core/src/session/turn.rs:155`。它的顶部注释把状态机说得很清楚（`turn.rs:141-153`）：

```rust
/// Takes initial turn input and runs a loop where, at each sampling request,
/// the model replies with either:
/// - requested function calls
/// - an assistant message
/// ...
/// - If the model requests a function call, we execute it and send the output
///   back to the model in the next sampling request.
/// - If the model sends only an assistant message, we record it in the
///   conversation history and consider the turn complete.
```

即一轮 turn = 一个 `loop { 采样 → 若有工具调用则执行并回填 → 否则结束 }`。循环体在 `turn.rs:312` 起。每次迭代：
1. 排空"挂起输入"（用户在模型运行时又输入的内容）——`can_drain_pending_input` 门控（`turn.rs:316`），turn 开头与刚 compaction 后**故意不排空**，保证新 turn input 先被采样。
2. 跑 hooks + 记录输入到历史。
3. 构建一次 `step_context`（这一步的上下文、可用工具、工具调用共享同一视图，`turn.rs:344`）。
4. 采样模型；处理返回项。
5. 检查 token 预算，必要时 auto-compact（见 1.3）。
6. 无后续工具调用（`!needs_follow_up`）→ 跑 stop hooks → `break`。

**没有硬编码的 maxTurns**。循环的上界由 token 预算 + auto-compaction 兜底（注释 `turn.rs:480`：只要 compaction 能把 token 压到远低于上限，就不担心无限循环）。这与 SamePage 用 SDK `maxTurns` 不同——Codex 是"预算驱动"而非"轮次驱动"。

任务被包装成 `SessionTask` trait（`core/src/tasks/mod.rs:197`），有 `Regular`（普通对话，`tasks/regular.rs` 调 `run_turn`）、`Compact`、`Review`、`UserShell` 等种类。`Session::spawn_task`（`tasks/mod.rs:270`）先 `abort_all_tasks(Replaced)` 再起新任务——**同一会话同时只有一个活动 turn**。

### 1.2 工具调用怎么并行/串行、结果怎么回填

调度器是 `ToolCallRuntime`，在 `/Users/tansenpeng/Documents/AI/codex/codex-rs/core/src/tools/parallel.rs`。核心是一把 **读写锁当"并行闸门"**：支持并行的工具拿读锁（可并发），不支持并行的工具拿写锁（独占串行）。见 `parallel.rs:116` 与 `parallel.rs:148-176`：

```rust
let supports_parallel = router.tool_supports_parallel(&call);
...
let mut dispatch_handle: AbortOnDropHandle<...> =
    AbortOnDropHandle::new(tokio::spawn(async move {
        if let Some(tool_runtime) = tool_runtime
            && let Some(readiness) = tool_runtime.wait_until_ready(&session) {
            readiness.await;
        }
        let _guard = if supports_parallel {
            Either::Left(lock.read().await)   // 并行：读锁
        } else {
            Either::Right(lock.write().await) // 串行：写锁，独占
        };
        router.dispatch_tool_call_with_terminal_outcome(...).await
    }));
```

每个工具调用是一个 `tokio::spawn` 任务，用 `AbortOnDropHandle` 包裹（句柄 drop 即 abort）。外层用 `tokio::select!` 同时等"调用完成"与"取消令牌"（`parallel.rs:180-207`），取消时若尚未产生终态就 `abort()` 并合成一个 `aborted_response` 回填给模型（见 §4）。工具结果作为 `ResponseInputItem` 回填进下一次采样的 history。

补充两个关键事实（`core/src/session/turn.rs`）：(1) **工具在流式过程中即被 spawn**，不等整条模型消息收完——`try_run_sampling_request`（`turn.rs:2228`）用 `FuturesOrdered<InFlightFuture>`（`turn.rs:2273`）承接在途工具（保序），模型每吐一个 `OutputItemDone` 就 `in_flight.push_back(...)`；流结束后 `drain_in_flight`（`turn.rs:2180-2203`）按序把每个结果 `record_annotated_conversation_items` 回填。请求头 `parallel_tool_calls: true`（`turn.rs:1362`）。(2) **默认串行**：`tool_supports_parallel` → `registry.supports_parallel_tool_calls(name).unwrap_or(false)`（`tools/router.rs:235`），即工具必须显式声明可并行，否则拿写锁独占——"默认安全"。

MCP 工具是否可并行由配置决定：`McpServerConfig.supports_parallel_tool_calls`（`config/src/mcp_types.rs:216`，"每个工具都声明为可并行"）。

### 1.3 token 预算与 compaction

- 预算/窗口计算在 `core/src/session/context_window.rs`：区分"完整活动上下文用量"与"计入 auto-compact 阈值的用量"（`context_window.rs:9-16`）。`token_limit_reached` 判定在 `context_window.rs:107`（`auto_compact_scope_tokens >= buffered_auto_compact_limit`），阈值来自 model_info 的 `auto_compact_token_limit()` 或 config 覆盖。
- 触发在 `run_turn` 里（`turn.rs:435-508`）：采样后读 `token_status`，`should_roll_over`（新窗口请求或达上限）时调 `run_auto_compact(..., CompactionReason::ContextLimit, CompactionPhase::MidTurn)`，然后 `continue`。还有 turn 前的 `run_pre_sampling_compact`（`turn.rs:～165`）。
- compaction 执行 `core/src/compact.rs`（`run_inline_auto_compact_task`，`compact.rs:116`）：向模型发一个"总结当前对话作为交接"的 prompt，把返回的 summary **替换**历史。提示词是常量 `SUMMARIZATION_PROMPT`（`core/src/compact.rs:59` → `prompts/src/compact.rs:1` → `prompts/templates/compact/prompt.md`）：

```
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

恢复时给下一个模型的前缀 `SUMMARY_PREFIX`（`prompts/templates/compact/summary_prefix.md`）："Another language model started to solve this problem and produced a summary… use this to build on the work already done and avoid duplicating work…"。`run_auto_compact`（`turn.rs:1219`）按 provider 能力分三种后端：`TokenBudget` feature → **直接开新 context window、不做模型总结**（`compact_token_budget.rs`）；`RemoteCompactionSupport::V2` → 服务端压缩；`Unsupported` → 本地总结（上面这套）。压缩用户消息上限 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`compact.rs:61`）。SamePage 借鉴本地总结那套即可。

**它的做法**：预算驱动的循环 + 自动交接式 compaction，替换而非追加历史。
**可借鉴点**：SamePage 目前靠 SDK 的上下文管理；若将来自建循环，可照搬"接近窗口上限→用交接 prompt 生成 summary→替换历史"的模式，并把 `SUMMARIZATION_PROMPT` 这段中文化后做成常量放进 `desktop/src/main/agent`。折叠步骤流时也可复用"探索类命令合并"的思路（见 §7）。
**对应我们哪一层**：主进程 agent 层（会话循环、上下文压缩）。

---

## 2. 会话/状态持久化 rollout

### 2.1 落盘格式

`rollout` crate 头注释直接给出格式（`/Users/tansenpeng/Documents/AI/codex/codex-rs/rollout/src/recorder.rs:1,77-83`）：

```
//! Persist Codex session rollouts (.jsonl) so sessions can be replayed or inspected later.
/// Rollouts are recorded as JSONL and can be inspected with tools such as:
/// $ jq -C . ~/.codex/sessions/rollout-2025-05-07T17-24-21-5973b6c0-...-2aeb6098ae0e.jsonl
```

**JSONL**，一行一个 JSON 对象。序列化结构 `RolloutLineRef{ timestamp: "YYYY-MM-DDTHH:MM:SS.mmmZ", ordinal: Option<u64>, #[serde(flatten)] item: &RolloutItem }`（`recorder.rs:1960-1996`），每行 `write_all` 后**立即 flush**。`RolloutItem` 枚举定义在 `history/src/lib.rs:106-122`，wire 用 `#[serde(tag="type", rename_all="snake_case")]`（`"type":"session_meta"` / `"response_item"` / `"compacted"` / `"event_msg"` / `"token_usage_record"` …）。首行是 `SessionMeta`。哪些 item 落盘由 `rollout/src/policy.rs:10` 的 `is_persisted_rollout_item(item, history_mode)` 决定。文件放在 `~/.codex/sessions/`，并按日期分目录 `sessions/YYYY/MM/DD/`（`recorder.rs:1628-1649`，常量 `SESSIONS_SUBDIR="sessions"` / `ARCHIVED_SESSIONS_SUBDIR="archived_sessions"`）。追加到别的进程写的文件前会先 `ensure_rollout_is_newline_terminated`（`recorder.rs:1941`）保证以 `\n` 结尾，防坏行。写入是异步单写者：有界 `mpsc::channel(256)`（`recorder.rs:936`）+ 后台 task 持文件句柄，命令枚举 `RolloutCmd{ AddItems, Persist, Flush, Shutdown }`。

### 2.2 会话 id 与文件名的关系

文件名解析在 `rollout/src/rollout_file_name.rs:38-58`：格式 `rollout-<timestamp>-<thread_id>.jsonl`；被 revert 的线程追加 `_<rollout_id>`：`rollout-<ts>-<thread_id>_<rollout_id>.jsonl`。普通情况 thread_id == rollout_id。

```rust
let core = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
let timestamp = core.get(..19)?;                    // 19 位时间戳
if core.get(19..20)? != "-" { return None; }
let ids = core.get(20..)?;
let (thread_id, rollout_id) = ids.split_once('_').unwrap_or((ids, ids));
```

写入是异步的：`RolloutRecorder` 用一个 channel + 后台 writer task（`RolloutCmd::AddItems/Flush/Shutdown`，`recorder.rs:126-130`），失败会 `mark_failed` 记住终态错误，`persist()`/`flush()` 可重试。

### 2.3 resume 与重放

`RolloutRecorder::resume(path)`（`recorder.rs:325`）读回文件；`get_rollout_history`（`recorder.rs:1091`）返回 `InitialHistory::Resumed(ResumedHistory{ conversation_id, history, rollout_path })`，历史整包（`Arc<Vec<RolloutItem>>`）交给 core 重放进新会话。`find_latest_thread_path`（`recorder.rs:747`）支持"接着上一次"。重放不是简单 append：`Session::reconstruct_history_from_rollout`（`core/src/session/rollout_reconstruction.rs:133`）**逆序找到最近一个带 `replacement_history` 的 `Compacted` checkpoint**，从它开始重放——compaction 的语义就是"用总结替换之前的上下文"，所以重建时也从最近的压缩点起，而非从头。遗留文件若 `Compacted.replacement_history` 为空则回退从头重建（`rollout_reconstruction.rs:379-388`）。

### 2.4 损坏/缺失怎么处理（对照 SamePage 的 resume-recovery）

`load_rollout_items`（`recorder.rs:1026-1090`）是**容错解析**的样板：逐行读，空行跳过；单行 JSON 解析失败**不中断**，只 `warn!` + `parse_errors += 1` 后 `continue`；解析成 `RolloutLine` 再失败也 `continue`；**用文件里第一个 `SessionMeta` 作为规范 thread_id**（后续 SessionMeta 可能来自 fork 历史，忽略）。

```rust
let mut value: Value = match serde_json::from_str(&line) {
    Ok(value) => value,
    Err(e) => { warn!("failed to parse line as JSON: {line:?}, error: {e}");
        parse_errors = parse_errors.saturating_add(1); continue; }
};
...
if thread_id.is_none()
    && let RolloutItem::SessionMeta(session_meta_line) = &item {
    thread_id = Some(session_meta_line.meta.id);
}
items.push(item);
...
if !saw_non_empty_line { return Err(IoError::other("empty session file")); }
```

只有"整文件无非空行"才报错（"empty session file"），其它坏行都被跳过并计数。另有 `reverse_jsonl_scanner.rs`（从文件尾部反向扫 JSONL，用于快速取最近 N 条而不读全文件）和 `compression.rs`（历史文件可 gzip，`open_rollout_line_reader` 透明解压）。

**它的做法**：JSONL 追加、首行 SessionMeta 定 id、逐行容错解析、坏行跳过计数、尾部反向扫描。
**可借鉴点**：SamePage 的 resume-recovery（SDK 会话文件丢了拿本地历史重开）可以把 electron-store 里的对话导出成同样的 JSONL，并采用"坏行跳过 + parse_errors 计数 + 空文件才失败"的策略，避免一条坏记录毁掉整段历史；反向扫描很适合 TaskDock 只要最近状态的场景。
**对应我们哪一层**：会话持久化层 + 主进程 agent 层（resume-recovery）。

---

## 3. 进程与沙箱管理

### 3.1 exec 子进程：启动、超时、进程组 kill、输出截断

exec 主体在 `/Users/tansenpeng/Documents/AI/codex/codex-rs/core/src/exec.rs`。关键常量：
- 超时退出码 `EXEC_TIMEOUT_EXIT_CODE = 124`（`exec.rs:68`，沿用 GNU timeout 约定）。
- 输出上限 `EXEC_OUTPUT_MAX_BYTES = DEFAULT_OUTPUT_BYTES_CAP`（`exec.rs:79`），增量流上限 `MAX_EXEC_OUTPUT_DELTAS_PER_CALL = 10_000`（`exec.rs:83`）。
- 截断：`append_capped`（`exec.rs:816`）与 `stdout_text.truncate(max_bytes)`（`exec.rs:718`），超限直接 `truncate`。

默认命令超时 `DEFAULT_EXEC_COMMAND_TIMEOUT_MS = 10_000`（`exec.rs:61`）。超时/取消统一建模为 `ExecExpiration`（`exec.rs:146-199`）：`Timeout` / `Cancellation(CancellationToken)` / `TimeoutOrCancellation`，`wait_with_outcome` 用 `tokio::select!` 在"到时"和"被取消"间竞争。真正的收尾在 `consume_output`（`exec.rs:942-1040`）里三路 select（`child.wait()` / 超时或取消 / `ctrl_c()`）：
- **超时**：`kill_child_process_group(&mut child)` 杀整组 → 再 `child.start_kill()` 杀直接子进程，合成退出码 124。
- **取消**：先 `terminate_process_group(pgid)` 发 **SIGTERM** 给 `CANCELLATION_TERMINATION_GRACE_PERIOD = 50ms` 宽限（`exec.rs:73`），到时仍没退再升级 SIGKILL 杀整组——**先礼后兵**。
- **Ctrl-C**：直接 killpg。

`IO_DRAIN_TIMEOUT_MS = 2_000`（`exec.rs`）防孙子进程持有管道导致 `read()` 永挂。

**进程组 kill** 是最值得抄的一段，独立在 `/Users/tansenpeng/Documents/AI/codex/codex-rs/utils/pty/src/process_group.rs`（被 `exec.rs:59` 引用为 `kill_child_process_group`）。子进程在 `pre_exec` 里 `setsid()`（`detach_from_tty`，`process_group.rs:49-59`）或 `setpgid(0,0)`（`set_process_group`，`process_group.rs:71-79`）自成进程组；Linux 还设 `PR_SET_PDEATHSIG`（父死子收 SIGTERM，`process_group.rs:26-38`）。杀的时候杀整组：

```rust
// process_group.rs:88-111
pub fn kill_process_group_by_pid(pid: u32) -> io::Result<()> {
    let pid = pid as libc::pid_t;
    let pgid = unsafe { libc::getpgid(pid) };
    if pgid == -1 { /* ESRCH/NotFound 视为已退出，Ok */ return Ok(()); }
    let result = unsafe { libc::killpg(pgid, libc::SIGKILL) };
    // 同样对 ESRCH/NotFound 宽容
    Ok(())
}
```

macOS 还有"先杀组、EPERM 时枚举成员逐个杀"的回退（`signal_process_group_with_member_fallback`，`process_group.rs:150+`）。这与 SamePage 的 Python inbox pipeline（detached 进程组、取消 `kill -pid`）思路完全一致，可直接对照移植。

### 3.2 macOS seatbelt 沙箱

策略是静态 `.sbpl` 文件 + 运行时注入可写根。基线 `/Users/tansenpeng/Documents/AI/codex/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`：

```
(version 1)
; start with closed-by-default
(deny default)
; child processes inherit the policy of their parent
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow file-write-data (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))
(allow sysctl-read (sysctl-name "hw.activecpu") ... )   ; 一长串只读 sysctl 白名单
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
```

默认拒绝一切，只放行进程 fork/exec、只读 sysctl（CPU/内核信息）、pty 等。**网络默认不放行**——只有开网时才追加 `seatbelt_network_policy.sbpl`（注释："when network access is enabled, these policies are added after those in base"），放行 `AF_SYSTEM` socket、DNS/TLS 相关 mach 服务与 `net.routetable` sysctl；具体代理 allow 规则由 codex-core 按环境注入。其它还有 `seatbelt_read_only_platform_defaults.sbpl`、`seatbelt_preferences_policy.sbpl`。可写根由 `SandboxPolicy` 决定（见下）。seatbelt 组装在 `sandboxing/src/seatbelt.rs`，通过 `sandbox-exec` 启动。

### 3.3 Linux landlock / bwrap

`sandboxing/src/landlock.rs`（LSM landlock 限制文件访问）+ `sandboxing/src/bwrap.rs`（bubblewrap 命名空间）+ 独立的 `codex-rs/linux-sandbox/` crate（编成单独可执行 `codex-linux-sandbox`，被主进程当 helper 调用）。统一入口 `sandboxing/src/manager.rs`，后端选择枚举 `SandboxType { None, MacosSeatbelt, LinuxSeccomp, WindowsRestrictedToken }`（`manager.rs:36`），`get_platform_sandbox()`（`manager.rs:62`）按平台映射。

Linux 网络禁用靠 **seccomp**（`linux-sandbox/src/landlock.rs:169-268`，`NetworkSeccompMode{Restricted, ProxyRouted}`）：Restricted 模式下 `socket`/`socketpair` **只放行 `AF_UNIX`**（`connect/bind/listen/sendto` 直接 deny），ProxyRouted 模式反过来只放行 `AF_INET/AF_INET6`（走本地 TCP 桥）；无条件 deny `ptrace/process_vm_readv/io_uring_*`。文件系统交给 bwrap：受限时 `--tmpfs /` 再逐个 `--ro-bind` 白名单、可写根 `--bind`、其下受保护子路径 `--ro-bind` 盖回、`--unshare-net` 隔离网络（`bwrap.rs:268-660`）。`should_install_network_seccomp` 保证 managed 网络即使 full-access 也 fail-closed。

### 3.4 SandboxPolicy 与网络开关

`/Users/tansenpeng/Documents/AI/codex/codex-rs/protocol/src/protocol.rs:1070`：

```rust
pub enum SandboxPolicy {
    #[serde(rename = "danger-full-access")] DangerFullAccess,
    #[serde(rename = "read-only")] ReadOnly { network_access: bool },   // 默认 false
    #[serde(rename = "external-sandbox")] ExternalSandbox { network_access: NetworkAccess },
    #[serde(rename = "workspace-write")] WorkspaceWrite {
        writable_roots: Vec<AbsolutePathBuf>,   // cwd 之外还可写的目录
        network_access: bool,                    // 默认 false
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    },
}
```

配套 `WritableRoot`（`protocol.rs:1126`）在可写根内**保留一批只读子路径与受保护元数据名**（`.codex`、`.git`、尤其 `.git/hooks`）防止提权：`is_path_writable`（`protocol.rs:1140`）先判是否在 root 下、再判是否落在只读子路径、再判是否命中受保护元数据名。

**它的做法**：默认拒绝 + 三档策略（只读 / workspace-write / full-access），网络单独开关，可写目录内仍保护 `.git/.git-hooks/.codex`。
**可借鉴点**：SamePage 的 write-guard 目前是"改文件前确认+备份+撤销"；可以在确认前先做一层"可写根 + 受保护路径"的静态判定（禁止 AI 直接写 `.git/hooks`、`.mcnai/` 管理员区、vault 配置），把 `WritableRoot::is_path_writable` 的三段判定逻辑抄成 TS。网络开关思路也可用于将来给 Python pipeline 加沙箱。
**对应我们哪一层**：进程管理 + 主进程 agent 层 write-guard。

---

## 4. 中断与恢复

### 4.1 abort 的传播路径

每个任务持有一个 `tokio_util::sync::CancellationToken`（`tasks/mod.rs:301` 创建，随 `run` 传入，`tasks/mod.rs:197-202`）。`SessionTask::run` 的文档明确要求实现方"监听令牌、一旦触发尽快结束"，并可选实现 `abort()` 做清理（`tasks/mod.rs:204-217`）。

链路：用户 Ctrl-C / `Op::Interrupt` → `Session::abort_all_tasks(reason)`（`tasks/mod.rs:511`）→ 取出活动 turn → `handle_task_abort`（`tasks/mod.rs:902`）。

### 4.2 取消中的工具怎么收尾、部分输出怎么保留

`handle_task_abort`（`tasks/mod.rs:902-970`）是"优雅中断"的样板：

```rust
task.cancellation_token.cancel();                 // 1. 先发取消信号
// (CodeMode 特性下还会 interrupt_active_cells)
select! {
    _ = task.done.notified() => {}                // 2a. 等任务自己收尾
    _ = tokio::time::sleep(Duration::from_millis(GRACEFULL_INTERRUPTION_TIMEOUT_MS)) => {
        warn!("task {sub_id} didn't complete gracefully after {}ms", ...);  // 2b. 超时
    }
}
task.handle.abort();                              // 3. 硬 abort tokio 任务
session_task.abort(...).await;                    // 4. 任务级清理钩子
if reason == TurnAbortReason::Interrupted && let Some(marker) = interrupted_turn_history_marker(...) {
    self.record_conversation_items(..., &[marker]).await;   // 5. 往历史写"被打断"标记
    // 保证 marker 在发 TurnAborted 前落盘（有的客户端收到 abort 会立即重读 rollout）
    if let Err(err) = self.flush_rollout().await { warn!(...); }
}
```

软超时常量 `GRACEFULL_INTERRUPTION_TIMEOUT_MS = 100`（`tasks/mod.rs:70`）。写进历史的"被打断"标记有专门的引导文案（`core/src/context/turn_aborted.rs:10-11`），明确告诉下一轮模型"上一轮是用户故意打断、unified exec 的后台进程可能还在跑、被中止的工具可能只执行了一半"：

```rust
pub(crate) const INTERRUPTED_GUIDANCE: &str = "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";
```

要点：**先软后硬**（取消令牌 + `done.notified()` 竞争 100ms 超时，超时才 `handle.abort()`）；**清理钩子**（`session_task.abort`）；**部分输出保留**——被打断的 turn 会写一条 `interrupted_turn_history_marker` 并**在发出 TurnAborted 事件前先 flush rollout**，因为有客户端会在收到 abort 时立即重读会话文件。单个工具层面，`parallel.rs:180-207` 的 `tokio::select!` 在取消时若工具尚未产生终态，会 `abort()` 后合成 `aborted_response`（`parallel.rs:246`，形如 "…aborted after N.Ns"）回填给模型，保证历史一致。清理完还会 `run_turn_interrupt_hooks`，并对 `Interrupted` 触发 `maybe_start_turn_for_pending_work`（`tasks/mod.rs:537`，把打断时排队的输入接上）。

**它的做法**：取消令牌广播 → 优雅超时 → 硬 abort → 清理钩子 → 写"打断"标记并抢先落盘 → 合成 aborted 工具结果保持历史一致。
**可借鉴点**：SamePage 的 abort 目前靠 SDK；可补两点：(1) 中断时也往对话历史写一条"已中断"标记并**先落盘再发中断事件**，避免 TaskDock/StepStream 与持久化不一致；(2) 给正在跑的工具设一个 `GRACEFULL_INTERRUPTION_TIMEOUT_MS` 式软超时，超时才强杀（对 Python pipeline 尤其有用）。
**对应我们哪一层**：主进程 agent 层（abort）+ 任务层（snapshot 权威、终态落盘）。

---

## 5. 配置分层

### 5.1 层级与优先级（含"管理员下发、本地只读"）

配置被建模成**一叠带 provenance 的层**，优先级用一个整数显式定义。`/Users/tansenpeng/Documents/AI/codex/codex-rs/config/src/config_layer_source.rs:5-51`：

```rust
pub enum ConfigLayerSource {
    PackagedDefaults { file },          // 随安装包
    Mdm { domain, key },                // MDM 下发
    System { file },                    // 主机级
    EnterpriseManaged { id, name },     // 企业云端 bundle 下发
    User { file, profile: Option<String> },
    Project { dot_codex_folder },       // 项目 .codex/
    SessionFlags,                       // 本次命令行覆盖
    LegacyManagedConfigTomlFromFile { file },
    LegacyManagedConfigTomlFromMdm,
}
impl ConfigLayerSource {
    pub fn precedence(&self) -> i16 {
        match self {
            PackagedDefaults{..} => -10, Mdm{..} => 0, System{..} => 10,
            EnterpriseManaged{..} => 15,
            User{profile} => if profile.is_some() {21} else {20},
            Project{..} => 25, SessionFlags => 30,
            LegacyManagedConfigTomlFromFile{..} => 40,
            LegacyManagedConfigTomlFromMdm => 50,   // 最高，压过一切
        }
    }
}
```

高优先级层覆盖低优先级层的同名字段（`PartialOrd` 由 `precedence` 决定）。注意 **legacy managed config（40/50）优先级最高**——这是老式"管理员强制"的入口。每层是 `ConfigLayer{ name, version, config: JsonValue, disabled_reason }`。

### 5.2 requirements：真正的"管理员下发、本地只读"机制（团队版关键）

**关键区分**：requirements 是一条**独立于 5.1 precedence 的管道**。5.1 那套是"高层覆盖低层的值"（管理员给默认值，用户仍可改）；requirements 是"管理员划定允许集合，用户只能在集合内选，越界直接**校验拒绝并报错**"（用户无法放宽）。这才是真正的"管理员下发、本地只读/受约束"。相关文件：`config/src/config_requirements.rs`、`config/src/constraint.rs`、`config/src/requirements_layers/`、`config/src/cloud_config_bundle.rs`、`cloud-config/` crate。

requirements 来源（`loader/mod.rs:94-107`，升序合并）：system `/etc/codex/requirements.toml`（Windows `%ProgramData%\OpenAI\Codex\requirements.toml`）、企业云 bundle、legacy `managed_config.toml`、以及 macOS MDM managed preferences（`config/src/loader/macos.rs`：application id `com.openai.codex`，key `requirements_toml_base64`，经 `CFPreferencesCopyAppValue` 读）。管理员写的 `requirements.toml` 字段是**白名单式**（`ConfigRequirementsToml`，`config_requirements.rs:981-1023`）：`allowed_login_methods`、`allowed_approval_policies`、`allowed_sandbox_modes`、`allowed_permission_profiles`、`default_permissions`、`allow_managed_hooks_only`、`mcp_servers`（限哪些 server/工具可用）、`rules`（exec policy）、`experimental_network`、`additional_developer_instructions` 等。

- 来源：`requirements.toml`（用户/项目/session）+ **企业云端 bundle**（`CloudConfigBundle`，`cloud_config_bundle.rs:27` 的 `requirements_toml`；`enterprise_managed_requirements: Vec<RequirementsLayerEntry>`，`cloud_config_bundle.rs:73`）。文档 `docs/config.md` 提到管理员可在 `requirements.toml` 设 `allow_managed_hooks_only = true`，忽略用户/项目/会话的 hook 配置、只保留托管 hook（且**只在 requirements.toml 生效，放 config.toml 无效**）。
- 校验模型 `Constrained<T>`（`constraint.rs:63-`）：一个值 + validator + 可选 normalizer；构造时就跑 validator，非法值直接 `Err`。违规错误枚举 `ConstraintError`（`constraint.rs:7-38`）带 `requirement_source`，如：

```rust
#[error("invalid value for `{field_name}`: `{candidate}` is not in the allowed set {allowed} (set by {requirement_source})")]
InvalidValue { field_name, candidate, allowed, requirement_source },
```

`normalizer` 用于"把值夹紧到满足约束"而不是报错。还有 `strict_config.rs`（严格模式）、`requirements_exec_policy.rs`（限制可执行命令）、`mcp_requirements.rs`（限制/校验 MCP server）、`auth_policy.rs`（认证限制）。

**这正是 SamePage 团队版最缺的一块**：一个"管理员下发 → 本地只读/受约束"的分层配置系统，能力远超简单的 config 合并。

### 5.3 profile 与 schema

- profile：`config/src/profile_toml.rs`，`User` 层带 `profile: Option<String>`（选中 profile 时优先级 21 > 无 profile 的 20）。
- schema/校验：`config-schema` crate + `config/src/schema.rs`；类型用 `schemars::JsonSchema` 自动导出 JSON Schema，配合 `ts-rs` 导出 TS。合并逻辑在 `config/src/merge.rs`，覆盖在 `overrides.rs`。

### 5.4 MCP server 配置

`config/src/mcp_types.rs:197` 的 `McpServerConfig`（`#[serde(flatten)] transport` + `auth`/`environment_id`/`enabled`/`required`/`supports_parallel_tool_calls`/`omit_tools_from`/启动超时）。transport 二选一（`mcp_types.rs:533-566`）：

```rust
pub enum McpServerTransportConfig {
    Stdio { command: String, args: Vec<String>, env, env_vars, cwd },
    StreamableHttp { url: String, bearer_token_env_var: Option<String>,
                     http_headers, env_http_headers, http_headers_helper },
}
```

即 stdio（本地子进程）或 streamable-http（远端），密钥走**环境变量名**（`bearer_token_env_var`）而非明文写配置。MCP 客户端在 `rmcp-client`/`codex-mcp`，运行时在 `core/src/session/mcp_runtime.rs`。

**它的做法**：带 provenance 的分层配置 + precedence 整数 + requirements 约束（可 allowed-set / 夹紧 / 严格模式）+ 企业云 bundle 下发 + MDM。
**可借鉴点**：(1) 把 SamePage 现有的 `config.json`（electron-store）/ `.mcnai/layout.json` / 隐藏管理员区，重构成"层 + precedence"模型，管理员区就是一个高优先级只读层；(2) 引入 `requirements` 式约束（如"团队成员的模型只能选 X"、"SCAN_LIMIT 不得改"、"某些目录禁止 AI 写"），用 `Constrained` 的 validator/normalizer 思路实现"非法即报错"或"夹紧"；(3) MCP 配置直接照抄 stdio/http 二选一 + 密钥走环境变量（SamePage 密钥现走 safeStorage，可让 MCP 配置只存变量名、值从 safeStorage 注入）。
**对应我们哪一层**：配置层（config.json + layout.json + 管理员区 + safeStorage）。

---

## 6. 事件协议

### 6.1 EventMsg：core → 前端的事件枚举

`/Users/tansenpeng/Documents/AI/codex/codex-rs/protocol/src/protocol.rs:1356` 的 `EventMsg`（`#[derive(Serialize, Deserialize, TS, JsonSchema)]`，snake_case 上线）。主要变体（节选）：

- 生命周期：`TurnStarted` / `TurnComplete`（`protocol.rs:1404,1417`；v1 线格式 `task_started/task_complete`，`alias` 接受 `turn_started/turn_complete` 做 v2 互通——**版本化就靠 serde rename+alias**）、`ContextCompacted`、`ThreadRolledBack`、`ShutdownComplete`。
- 文本流：`AgentMessage` / `AgentMessageContentDelta` / `AgentReasoning` / `AgentReasoningRawContent` / `AgentReasoningSectionBreak` / `ReasoningContentDelta`。
- 执行：`ExecCommandBegin` / `ExecCommandOutputDelta` / `ExecCommandEnd`（`protocol.rs` 约 1470-1480）。
- 补丁：`PatchApplyBegin` / `PatchApplyUpdated` / `PatchApplyEnd`、`TurnDiff`（本轮累计 diff）。
- 审批：`ExecApprovalRequest` / `ApplyPatchApprovalRequest` / `DynamicToolCallRequest`。
- MCP/工具：`McpToolCallBegin` / `McpToolCallEnd` / `McpStartupUpdate/Complete`、`WebSearchBegin/End`、`ViewImageToolCall`。
- 用量与错误：`TokenCount`（可选，None 表示未知→UI 不显示）、`Error` / `Warning` / `GuardianWarning` / `StreamError`、`ModelReroute` / `PlanUpdate`。

**Begin/Delta/End 三段式**是贯穿全协议的模式（exec、patch、mcp、agent message 都如此），前端据此显示 running→streaming→done。SamePage 的 `agent:stream` 可对齐这个粒度。

### 6.2 协议怎么版本化

三条腿（**没有单一整数 protocol_version**）：(a) 事件用 `#[serde(rename="task_started", alias="turn_started")]` 在同一枚举里兼容 v1/v2 线格式；(b) app-server-protocol 有独立的 `v1.rs` 与 `v2/` 两套投影（旧方法在 v1 如 `initialize`，新方法用 v2 类型如 `thread/start`）；(c) **experimental capability 协商**（`app-server-protocol/src/experimental_api.rs`）：客户端在 `initialize` 时用 `InitializeCapabilities.experimental_api: bool` 声明是否接收实验 API，否则标了 `#[experimental("...")]` 的方法/字段被拒；实验字段用 `inventory::collect!` 收集。客户端身份 `ClientInfo{name,title,version}`。所有面向前端的类型都用 `ts-rs`（`#[derive(TS)]`）导出 `.ts` 与 `schemars` 导出 JSON Schema（`export.rs`、`precomputed_exports.rs`），保证前端类型与 Rust 单一真相源同步。EventMsg 变体**禁止用 Option 字段**（`protocol.rs:1350` 注释，否则破坏代码生成）。core 的 `EventMsg` → 对外 `ServerNotification` 的翻译集中在 `event_mapping.rs`。

### 6.3 app-server 的 JSON-RPC 设计（对照 SamePage IPC + agent:stream）

在 `/Users/tansenpeng/Documents/AI/codex/codex-rs/app-server-protocol/`。基础类型 `rpc.rs`：`JSONRPCMessage`（untagged 枚举 Request/Notification/Response/Error）、`JSONRPCRequest{ id, method, params, trace: Option<W3cTraceContext> }`（`rpc.rs:44-56`，**带 W3C 分布式追踪上下文**）。注意头注释（`rpc.rs:1-2`）："We do not do true JSON-RPC 2.0, as we neither send nor expect the 'jsonrpc': '2.0' field"——刻意简化。

方法不是手写枚举，而是**声明宏批量生成**。`protocol/common.rs:212` 的 `client_request_definitions!` 宏，每个方法写 `Variant => "wireName" { params: T, serialization: ..., response: R }`，宏展开出：`enum ClientRequest`（`#[serde(tag="method", rename_all="camelCase")]`，每个变体带 `request_id` + `params`）、配套 `enum ClientResponse`、`method_name()`、`id()`、以及 `TryFrom<JSONRPCRequest>`（`common.rs:229-330`）。同样有 `server_request_definitions!`（`common.rs:1432`，服务端→客户端的请求，如审批）、`server_notification_definitions!`（`common.rs:1603`，`ServerNotification`，如流事件）、`client_notification_definitions!`。传输层在 `app-server-transport/`（可跑在 stdio / UDS）。

**它的做法**：单一 Rust 真相源 + 宏生成 JSON-RPC 方法枚举 + ts-rs/schemars 导出前端类型；事件 Begin/Delta/End 三段式；serde rename/alias 做版本兼容；请求带 trace 上下文。
**可借鉴点**：(1) SamePage 的 IPC 通道与 `agent:stream` 事件可定义成一个 TS 单一真相源（zod/ts-rs 类似物），主进程与渲染层共享类型，避免手写两边；(2) 采用 Begin/Delta/End 三段式事件，StepStream 直接映射 running→streaming→done；(3) 用 rename+alias 思路给事件留版本兼容位，桌面版跨版本升级时旧渲染层不崩。
**对应我们哪一层**：主进程↔渲染层 IPC + agent:stream（app-server 就是我们的 IPC 层的 Rust 版）。

---

# 交互层（codex-rs/tui）

> 本节大量结论来自对 `tui/` 的通读，路径与行号已核对。

## 7. 步骤流翻译与折叠

### 7.1 cell 抽象

统一显示单元是 `HistoryCell` trait（`/Users/tansenpeng/Documents/AI/codex/codex-rs/tui/src/history_cell/mod.rs:184-288`），一个 cell 既能表示"已提交历史"又能表示"流式中可原地变更的活动块"。三种视图：`display_lines`（主视口）、`raw_lines`（可复制纯文本）、`transcript_lines`（Ctrl+T 转写 overlay）。渲染模式 `HistoryRenderMode { Rich, Raw }`（`mod.rs:139-143`）。基础实现在 `history_cell/base.rs`：`PlainHistoryCell` / `PrefixedWrappedHistoryCell`（带首行/续行前缀的自动换行）/ `CompositeHistoryCell`（多子 cell 组合）。命令、审批、mcp、补丁、计划各有专属 cell 文件。

### 7.2 命令 cell：running/done + 折叠分组

`tui/src/exec_cell/model.rs`：`ExecCall`（`model.rs:63-79`，含 `call_id`/`command`/`parsed`/`output`/`start_time`/`duration`）与 `ExecCell{ calls: Vec<ExecCall> }`——**一个 cell 可容纳一组相关命令**。
- `is_active()`（`model.rs:167`）：任一 call `duration.is_none()` 即"运行中"。
- `is_exploring_call()`（`model.rs:201`）：非用户手动执行、且 parsed 全是 `Read/ListFiles/Search` → 归入"探索"分组。
- `add_call()`（`model.rs:89`）：只有当前是探索 cell 且新 call 也是探索类才合并，否则另起 cell。
- `complete_call()`（`model.rs:120`）：按 `call_id` 逆序匹配回填 output/duration，防止孤儿 end 事件错折叠。

### 7.3 摘要、状态位、折叠渲染

`tui/src/exec_cell/render.rs`。折叠上限：`TOOL_CALL_MAX_LINES = 5`（agent 命令），`USER_SHELL_TOOL_CALL_MAX_LINES = 50`（用户手动）（`render.rs:33-34`）。状态位就是圆点颜色 + 标题（`render.rs:352-374`）：

```rust
let bullet = match success {
    Some(true) => "•".green().bold(),
    Some(false) => "•".red().bold(),
    None => activity_marker(call.start_time, self.animations_enabled()),  // 运行中动画
};
let title = if is_interaction { "" }
    else if self.is_active() { "Running" }
    else if call.is_user_shell_command() { "You ran" }
    else { "Ran" };
```

探索分组把连续 `Read` 合并成一行 `Read a, b, c`（`render.rs:255-350`）。输出折叠取头 N 行 + 尾 N 行、中间省略（`output_lines()` `render.rs:103`），省略行文案（`render.rs:247`）：`"… +{omitted} lines (ctrl + t to view transcript)"`。真正按视口列宽的中段截断在 `truncate_lines_middle()`（`render.rs:528`），保证少数超长行不灌满屏。Ctrl+T 转写版每条命令 `$ ` 前缀 + 完整输出 + 结果行 `✓`/`✗ (code) • 时长`。

### 7.4 流式换行门控

`tui/src/markdown_stream.rs` 的 `MarkdownStreamCollector::commit_complete_source`（`markdown_stream.rs:87-96`）：**只在遇到换行时提交已完成前缀**，尾部半行留到下次——避免渲染语义未定的半行 markdown。上层 `tui/src/streaming/`（`controller.rs` drain 策略、`chunking.rs` 按队列压力自适应、`table_holdback.rs` 表格成块提交、`code_fence.rs` 代码围栏）。

**它的做法**：统一 HistoryCell 抽象 + 命令按 call_id 路由 + 只读命令合并成"探索"分组 + head/tail 折叠 + 换行边界提交流式文本。
**可借鉴点**：SamePage 的 StepStream 已把工具调用译成中文步骤并折叠成一行；可再借：(1) 把连续只读操作（读文件/搜索/列目录）合并成"探索 X, Y, Z"一行，减少噪音；(2) 输出用 head+tail+"…+N 行（点击查看完整）"折叠；(3) 流式回答按换行边界提交，避免半行 markdown 抖动；(4) 状态位用圆点颜色（绿/红/转圈）+ 动词标题（进行中/已完成/失败）。
**对应我们哪一层**：渲染层 StepStream + toast。

---

## 8. 写前确认与 diff

### 8.1 approval 策略枚举

`/Users/tansenpeng/Documents/AI/codex/codex-rs/protocol/src/protocol.rs:984-1007`：

```rust
pub enum AskForApproval {
    #[serde(rename = "untrusted")] UnlessTrusted,  // 未信任项目，除非 execpolicy 放行否则都问
    #[serde(alias = "on-failure")] #[default] OnRequest,  // 模型决定何时问
    Granular(GranularApprovalConfig),              // 细粒度开关
    Never,                                          // 从不问，失败直接回模型
}
```

`GranularApprovalConfig`（`protocol.rs:1009-1024`）分类开关：`sandbox_approval` / `rules` / `skill_approval` / `request_permissions` / `mcp_elicitations`——**按"哪一类请求"分别决定"问 / 自动拒"**。安全评估 `core/src/safety.rs`：`SafetyCheck { AutoApprove, AskUser, Reject{reason} }`（`safety.rs:19-23`），`assess_patch_safety()` 按 policy+沙箱能力决定（能真正启用沙箱才自动批准，否则回退问用户）。

### 8.2 确认弹窗信息结构 + "本会话全部允许"

TUI 事件模型 `tui/src/approval_events.rs`：`ExecApprovalRequestEvent`（含 command/cwd/reason/`proposed_execpolicy_amendment`/`available_decisions`/`network_approval_context`）、`ApplyPatchApprovalRequestEvent`（含 `changes: HashMap<PathBuf, FileChange>`/reason/grant_root）。弹窗聚合器 `tui/src/bottom_pane/approval_overlay.rs` 用 `current_request + queue` **串行处理多个请求**。选项标签是"本会话允许"的文案来源（`approval_overlay.rs:829-905`）：

```rust
CommandExecutionApprovalDecision::AcceptForSession => Some(ApprovalOption {
    label: if network_approval_context.is_some() { "Yes, and allow this host for this conversation" }
           else if additional_permissions.is_some() { "Yes, and allow these permissions for this session" }
           else { "Yes, and don't ask again for this command in this session" },
    ...
}),
```

补丁侧："Yes, proceed" / "Yes, and don't ask again for these files" / "No, and tell Codex what to do differently"。execpolicy 前缀记忆："Yes, and don't ask again for commands that start with `<prefix>`"。

决策枚举 `app-server-protocol/src/protocol/v2/item.rs:64-83`：

```rust
pub enum CommandExecutionApprovalDecision {
    Accept,
    AcceptForSession,                                   // 会话级缓存
    AcceptWithExecpolicyAmendment { execpolicy_amendment },  // 记住命令前缀，跨调用
    ApplyNetworkPolicyAmendment { network_policy_amendment },// 记住主机 allow/deny
    Decline,   // 拒绝但 turn 继续
    Cancel,    // 拒绝并立即中断 turn
}
```

`FileChangeApprovalDecision`（`item.rs:113-122`）同构。core 侧对应 `ReviewDecision`（`protocol.rs:4056`，含 `ApprovedForSession` / `ApprovedExecpolicyAmendment` / `ApprovedMcpPolicyAmendment` / `NetworkPolicyAmendment` / `Denied{rejection}` / `TimedOut` / `Abort`）。

### 8.3 会话级批准记忆的实现（关键，在 core 不在 UI）

`/Users/tansenpeng/Documents/AI/codex/codex-rs/core/src/tools/sandboxing.rs:70-116` 的 `with_cached_approval`：

```rust
let already_approved = {
    let store = services.tool_approvals.lock().await;
    keys.iter().all(|key| matches!(store.get(key), Some(ReviewDecision::ApprovedForSession)))
};
if already_approved { return ReviewDecision::ApprovedForSession; }
let decision = fetch().await;   // 弹窗
if matches!(decision, ReviewDecision::ApprovedForSession) {
    let mut store = services.tool_approvals.lock().await;
    for key in keys { store.put(key, ReviewDecision::ApprovedForSession); }
}
```

apply_patch 一次改多文件 → keys 是多个，后续触及任意子集都跳过。网络主机的会话批准另有 `session_approved_hosts: Mutex<HashSet<HostApprovalKey>>`（`core/src/tools/network_approval.rs:269`，按 environment 作用域 + 保留协议/端口）。MCP 工具会话批准在 `core/src/mcp_tool_call.rs:2003-2110`。

### 8.4 diff 模型与渲染 + 本轮累计 diff

`tui/src/diff_model.rs`（仅 21 行）：

```rust
pub(crate) enum FileChange {
    Add { content: String },
    Delete { content: String },
    Update { unified_diff: String, move_path: Option<PathBuf> },
}
```

渲染 `tui/src/diff_render.rs`（2559 行）：`create_diff_summary()`（`351`）→ 头行 `• N files (+X -Y)`，逐文件计数（`+X` 绿 `-Y` 红），逐行 diff 带明暗主题自适应（`DiffTheme` `123`）。本轮累计 diff 由 `core/src/turn_diff_tracker.rs` 的 `TurnDiffTracker`（`turn_diff_tracker.rs:49`）跟踪——**不重读文件系统**，只从已提交的 apply_patch 变更累计净 diff，`baseline_by_path`/`current_by_path` 双表 + 按 `DiffCacheKey` 缓存 + 处理重命名配对；`get_unified_diff()`（`turn_diff_tracker.rs:114`）供 `/diff` 用。

**它的做法**：多档 approval 策略 + 细粒度分类开关 + 会话级/前缀级/主机级三种"记住"粒度（记忆在 core，UI 只发决策）+ 串行弹窗队列 + 结构化 FileChange(Add/Delete/Update) + 不重读磁盘的本轮累计 diff。
**可借鉴点**：SamePage 的 WriteConfirm 可扩成：(1) 决策枚举加 `AcceptForSession`（本会话此文件/此类操作不再问）与 `AcceptForPathPrefix`（此目录下不再问），记忆放在主进程 agent 层的 store（对应 `tool_approvals`），而非 UI；(2) 多个待确认串成队列逐个弹（现在可能并发弹卡）；(3) FileChange 用 Add/Delete/Update(unified_diff, move_path) 三态建模，撤销/备份就按这三态处理；(4) 用 `TurnDiffTracker` 思路在主进程累计"本轮 AI 改了哪些文件的净 diff"，给 TaskDock 一个"本次任务改动总览"。
**对应我们哪一层**：渲染层 WriteConfirm + 主进程 agent 层 write-guard（批准缓存）。

---

## 9. 超时/取消/断网的呈现

### 9.1 重试退避与文案

指数退避 + 抖动，`/Users/tansenpeng/Documents/AI/codex/codex-rs/core/src/util.rs:86-91`：

```rust
pub fn backoff(attempt: u64) -> Duration {
    let exp = BACKOFF_FACTOR.powi(attempt.saturating_sub(1) as i32);
    let base = (INITIAL_DELAY_MS as f64 * exp) as u64;
    let jitter = rand::rng().random_range(0.9..1.1);
    Duration::from_millis((base as f64 * jitter) as u64)
}
```

`INITIAL_DELAY_MS = 200`、`BACKOFF_FACTOR = 2.0`（`util.rs:6-7`）。流重试主逻辑 `core/src/responses_retry.rs:44-129`，三档：
1. **连接失败无界重连**（`responses_retry.rs:58-83`）：`5s` 起 ×2 封顶 `60s`，文案 `"Reconnecting... waiting for network"`。
2. **切换传输**（WebSocket→HTTPS，`85-100`）：`"Falling back from WebSockets to HTTPS transport. {err}"`。
3. **普通重试**（`102-126`）：优先用服务器 `Retry-After`（`err.retry_delay()`）否则 `backoff(n)`；文案 `"Reconnecting... {retry_count}/{max_retries}"`；release 构建**隐藏第一次 websocket 重试通知**以减少瞬态噪音（`report_error = retry_count > 1 || debug || !websocket_enabled`）；重试用尽才冒泡错误。

### 9.2 中断/错误在 UI 的呈现

错误经 `ServerNotification::Error` 进 `tui/src/chatwidget/protocol.rs:126-138`；`will_retry` 时把文案写进**状态行**（不是历史 cell），保留 "Working" 动画（`tui/src/chatwidget/streaming.rs:302-312`：`remember_retry_status_header` + `set_status`）。**重试是短暂状态而非持久历史记录**——这点对 UI 干净很关键。中断串行化在 `tui/src/chatwidget/interrupts.rs`（`QueuedInterrupt` + `InterruptManager`，把 exec/patch 批准、elicitation、权限、用户输入等阻塞式提示排队逐个处理）。

### 9.3 rate limit 呈现

`tui/src/chatwidget/rate_limits.rs`（接收快照，达上限可弹切换提示）+ `tui/src/status/rate_limits.rs`（进度条 `[███░░]` `render_limit_progress_bar()` `361`，文案 `"{percent_remaining:.0}% left"` `374`）。

**它的做法**：指数退避+抖动+服务器 Retry-After 优先；连接失败无界重连、达上限切传输、普通重试有次数上限；重试文案进状态行不进历史；首次瞬态重试静默；中断请求串行排队。
**可借鉴点**：SamePage 的 toast/StepStream 对断网/超时可采用同款分档文案（"重连中… waiting for network" / "重连中 2/5"），并把这类瞬态状态放进 TaskDock 的任务条状态而非对话历史；首次瞬态错误静默 1 次再提示，减少闪烁；退避直接抄 `backoff()`（200ms×2^n + 0.9~1.1 抖动，且尊重服务端 Retry-After）。
**对应我们哪一层**：渲染层 toast + TaskDock 状态 + 主进程 agent 层（重试）。

---

## 10. 状态栏与用量

### 10.1 上下文用量百分比计算

`/Users/tansenpeng/Documents/AI/codex/codex-rs/tui/src/token_usage.rs:43-53`：

```rust
pub(crate) fn percent_of_context_window_remaining(&self, context_window: i64) -> i64 {
    if context_window <= BASELINE_TOKENS { return 0; }
    let effective_window = context_window - BASELINE_TOKENS;      // 先扣固定基线
    let used = (self.tokens_in_context_window() - BASELINE_TOKENS).max(0);
    let remaining = (effective_window - used).max(0);
    ((remaining as f64 / effective_window as f64) * 100.0).clamp(0.0, 100.0).round() as i64
}
```

`BASELINE_TOKENS = 12000`（`token_usage.rs:9`）——系统提示等固定基线**先从窗口扣掉**，剩余百分比按"有效窗口"算，避免刚开局就显示已用很多。`TokenUsage` 字段（`token_usage.rs:12-18`）：input/cached_input/output/reasoning_output/total；`blended_total()` = 非缓存输入 + 输出。

### 10.2 底部状态栏

`tui/src/bottom_pane/footer.rs:1033-1045` 的 `context_window_line`：有百分比显示 `"{percent}% context left"`，否则显示 `"{used} used"`，都没有则 `"100% context left"`（`.dim()` 弱化）。footer 自适应：宽度不够时截断左侧提示、优先保上下文。忙碌行（composer 上方）`tui/src/status_indicator_widget.rs`：动画 header（默认 "Working"）+ 时钟 + 中断提示 + 内联上下文（后台进程摘要）+ hook 活动；耗时格式 `fmt_elapsed_compact()`（`0s`/`1m 00s`/`2h 03m 09s`）。

### 10.3 /status 卡片

`tui/src/status/card.rs`（`330-360`）：汇总 model/provider、approval 策略、permissions、account、session_id、token 用量、上下文窗口、rate limits。`context_window_spans()`：`"{percent}% left (used / window)"`；`token_usage_spans()`：`"{total} total ({input} input + {output} output)"`。slash 里 `/status`（"show current session configuration and token usage"）与 `/usage`。

**它的做法**：上下文剩余按"扣掉固定基线后的有效窗口"算百分比；状态栏分"底部持久条（模型/上下文剩余）"与"忙碌行（动画/时钟/耗时）"；/status 汇总卡片。
**可借鉴点**：SamePage 可在对话工作台底部加一条"上下文剩余 X%"（用 `扣基线` 公式，别用裸 total/window），TaskDock 显示耗时用 `fmt_elapsed_compact` 风格；做一个 `/status` 式汇总（模型、approval 策略、SCAN_LIMIT、当前 vault、token 用量）。
**对应我们哪一层**：渲染层（对话工作台状态栏 + TaskDock）。

---

## 11. 其他值得记的

- **slash 命令**：`tui/src/slash_command.rs` 的 `SlashCommand` 枚举（`12-84`），**枚举顺序即弹窗顺序**（注释明确 "DO NOT ALPHA-SORT!"，高频在前），kebab-case + 别名（`/pwd`↔`cwd`、`/stop`↔`clean`）；约 60 条（Model/Permissions/Review/Compact/Diff/Status/Usage/Init/Fork/Resume/Skills/Hooks/Mcp…）。分发 `chatwidget/slash_dispatch.rs`。
- **@文件引用**：`tui/src/file_search.rs` 的 `FileSearchManager`，composer 改 `@token` 发 `AppEvent::StartFileSearch(query)`，持有单个 `codex-file-search` session（`file-search` crate 是复用的模糊搜索）；resume 改 cwd 时丢弃重建。弹窗 `bottom_pane/mentions_v2/`。
- **图片粘贴**：`tui/src/clipboard_paste.rs` 的 `paste_image_as_png()` 用 `arboard` 读剪贴板（优先 Finder 文件列表，否则原始图像），统一编码 PNG；错误分类 `ClipboardUnavailable/NoImage/EncodeFailed/IoError`。
- **桌面通知/声音**：`tui/src/notifications/mod.rs` 的 `DesktopNotificationBackend { Osc9, Bel }`，`Auto` 按终端能力选（`supports_osc9` 白名单 Ghostty/iTerm2/Kitty/Warp/WezTerm）；OSC9 写 `\x1b]9;{msg}\x07`，tmux 下用 DCS passthrough 包裹。SamePage 是 Electron，直接用系统通知 API 即可，但"完成才通知、失败才响铃"的触发策略可借。
- **更新提示**：`tui/src/updates.rs`（仅 release 编译）`get_upgrade_version()` 缓存超 20 小时才后台异步刷新（**不阻塞启动**，本次用旧缓存下次才显 banner），按安装方式（Homebrew/npm/bun/pnpm/standalone）查不同源；`updates_cache.rs` 存 `{latest_version, last_checked_at, dismissed_version}`，尊重用户 dismiss。
- **telemetry/日志**：会话回放日志 `tui/src/session_log.rs`（全局 `LOGGER`，JSON Lines，Unix 下 `mode(0o600)`，写失败只 warn 不崩）；指标走 `codex_otel`（OpenTelemetry），如 `core/src/tools/sandboxing.rs:99` 的计数器 `"codex.approval.requested"` 带 tool/approved 标签。

---

# 可复用代码段清单（Apache-2.0）

> 移植任一段都需在文件头保留 Apache-2.0 版权头，并在 SamePage 的 NOTICE/第三方声明里加入 "OpenAI Codex, Copyright 2025 OpenAI (Apache-2.0)"。这些多为 Rust，SamePage 是 TS/Electron，**主要借鉴算法与状态设计，按 TS 重写**（重写的思想借鉴通常不构成需保留版权头的"复制"，但整段翻译移植时仍建议在注释里注明来源与许可，稳妥且合规）。

1. **进程组 kill / setsid / PDEATHSIG** — `codex-rs/utils/pty/src/process_group.rs:1-170`（`detach_from_tty`/`set_process_group`/`kill_process_group_by_pid`/`set_parent_death_signal` + macOS 成员回退）。直接对照 SamePage Python pipeline 的 detached 进程组 + `kill -pid`。许可 Apache-2.0。
2. **JSONL rollout 容错解析** — `codex-rs/rollout/src/recorder.rs:1026-1090`（`load_rollout_items`：坏行跳过+parse_errors 计数+首个 SessionMeta 定 id+空文件才失败）。文件名方案 `rollout_file_name.rs:38-58`。
3. **优雅中断收尾** — `codex-rs/core/src/tasks/mod.rs:902-970`（`handle_task_abort`：cancel→软等超时→硬 abort→清理钩子→写打断标记→抢先 flush 落盘）。
4. **工具并行/串行读写闸门 + 取消合成 aborted 结果** — `codex-rs/core/src/tools/parallel.rs:116-207`。
5. **approval 策略枚举 + 决策枚举** — `codex-rs/protocol/src/protocol.rs:984-1024`（`AskForApproval`/`GranularApprovalConfig`）、`protocol.rs:4056-4100`（`ReviewDecision`）、`app-server-protocol/src/protocol/v2/item.rs:64-122`（`CommandExecutionApprovalDecision`/`FileChangeApprovalDecision`）。
6. **会话级批准缓存** — `codex-rs/core/src/tools/sandboxing.rs:70-116`（`with_cached_approval`）。
7. **配置分层 precedence** — `codex-rs/config/src/config_layer_source.rs:5-51`（`ConfigLayerSource` + `precedence()`）。
8. **requirements 约束模型** — `codex-rs/config/src/constraint.rs:7-116`（`ConstraintError` + `Constrained<T>` validator/normalizer）；企业下发 `config/src/cloud_config_bundle.rs`。
9. **compaction 交接提示词** — `codex-rs/prompts/templates/compact/prompt.md` 与 `summary_prefix.md`（可直接中文化后做常量）。
10. **上下文剩余百分比公式** — `codex-rs/tui/src/token_usage.rs:43-53`（扣 `BASELINE_TOKENS=12000` 后按有效窗口算）。
11. **指数退避+抖动 + 分档重试文案** — `codex-rs/core/src/util.rs:86-91`、`core/src/responses_retry.rs:44-129`。
12. **步骤流折叠规则** — `codex-rs/tui/src/exec_cell/model.rs`（探索分组判定）+ `render.rs:103-374`（head/tail 折叠、状态位、探索合并）。
13. **JSON-RPC 方法声明宏** — `codex-rs/app-server-protocol/src/protocol/common.rs:212-330`（`client_request_definitions!` 生成 enum + method_name + TryFrom）；基础类型 `app-server-protocol/src/rpc.rs`。
14. **seatbelt 默认拒绝策略模板** — `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl` + `seatbelt_network_policy.sbpl`（若将来给 Python pipeline 上 macOS 沙箱可直接用）。

---

# 对 SamePage 最有价值的 8 条借鉴（排序）

1. **requirements/管理员下发的"分层配置 + 只读约束"（config_layer_source.rs + constraint.rs + cloud_config_bundle.rs）** —— 团队版最缺的一块：管理员能强制"模型/SCAN_LIMIT/禁写目录"等且本地无法覆盖，比简单 config 合并高一个维度。
2. **会话级批准缓存放在主进程而非 UI（tools/sandboxing.rs with_cached_approval）** —— WriteConfirm 加"本会话此文件/此类不再问"，一次多文件补丁按 keys 逐个记，直接解决重复弹卡的体验痛点。
3. **优雅中断收尾 + 写"打断"标记并抢先落盘（tasks/mod.rs handle_task_abort）** —— 让 abort 时 StepStream/TaskDock 与持久化不再错位，部分输出可靠保留。
4. **进程组 kill + PDEATHSIG（utils/pty/process_group.rs）** —— 与 SamePage 现有 Python detached 进程组 kill 思路一致，补上"软超时→硬杀"和父死子收 SIGTERM，杜绝僵尸子进程。
5. **JSONL rollout 容错解析（recorder.rs load_rollout_items）** —— resume-recovery 采用"坏行跳过+计数+空文件才失败"，一条坏记录不再毁掉整段历史。
6. **步骤流"探索分组 + head/tail 折叠"（exec_cell）** —— 把连续读文件/搜索合并成一行、长输出头尾折叠，StepStream 噪音大幅下降。
7. **IPC/事件用单一真相源 + Begin/Delta/End 三段式 + rename/alias 版本兼容（app-server-protocol、EventMsg）** —— 主进程与渲染层共享类型，跨版本升级旧渲染层不崩，StepStream 直接映射 running→streaming→done。
8. **上下文剩余百分比"扣基线"公式 + 分档重试文案（token_usage.rs、responses_retry.rs）** —— 状态栏显示更真实的"上下文剩余 X%"，断网/限流文案分档且瞬态进状态行不进历史，界面更干净。

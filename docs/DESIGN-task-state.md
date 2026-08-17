# 设计方案：全局任务状态层（Task State Layer）

> 日期：2026-08-16 ｜ 关联：`docs/UX-AUDIT.md`（H-07~H-13、M-01/M-03/M-27）、`docs/HANDOFF.md`（bug#1 离线降级）
>
> **实施状态（2026-08-16）：一期、二期均已落地并通过验收**（见 HANDOFF §2-11 与 §2-14）。本文继续作为这一层的**设计依据**保留——改这层之前先读 §1.5 的真相源约定、§3.3 的「进行中永不落盘」、§5.1 的进程组 kill 与「不回滚」、§5.2 的三时机冲突检测。§6.3 的 13 条断言全部已写进 `desktop/e2e/walkthrough.mjs`；其中断言 7（取消 + 进程组无残留）按 §8 风险 1 的要求在**打包形态**下跑过。
> 实施中与本文的偏差只有两处，均已在正文标注：一是 §3.3 的 `agentDrafts` 落盘仍未做（H-09 用主进程内存里的 draft 就够了，重启补「（应用重启，本次回答已中断）」消息没做）；二是 sync 任务按 §1.3「绝大多数时候不可见」的要求**不进 TaskDock**，失败只由 `cloud.pendingSync` 表达。
> 约束（不可协商）：Electron 锁 **30.5.1**；渲染进程零 Node 能力；IPC 命名沿用现有 `域:事件` 风格；**不引入任何状态管理库**（React 自带 state/context/useSyncExternalStore + 现有 IPC 订阅体系解决）。
>
> **评审批注（2026-08-16 已批准，按一期实施）**
> 1. H-10 撞车采用**拒绝 + 提示**，toast 内附「停止当前生成」动作按钮 → 见 §5.3，属**二期**
> 2. TaskDock 出现/消失走**高度过渡**，避免侧栏底部跳动 → 见 §4.1
> 3. 一期内部顺序：**registry + Dock + inbox 迁移先行，agent draft 上移放最后**，中途任何一步可独立交付 → 见 §7.1
> 4. `syncQueue` 退避策略与 `ingested` 表主键需先写死 → 见 §3.4、§3.5

---

## 0. 为什么这些问题是同一个根因

审计里被分到「异步三态」「跨页面状态出口」「可逆性」三个不同维度的九条问题，代码上其实是同一句话造成的：

**「一个跨越时间的操作，它的状态被存在了发起它的那个 React 组件里。」**

| 问题 | 状态现在存在哪 | 组件一没了会怎样 |
|---|---|---|
| H-07 投递运行时其他页面无出口 | `useInbox` 挂在知识库页的 `Explorer` 内（[VaultPage.tsx:317](desktop/src/renderer/src/pages/VaultPage.tsx:317)） | 切页面 = 没有监听者，`inbox:event` 直接被丢弃 |
| H-08 回知识库页运行态丢失 | `const [running, setRunning] = useState(false)`（[VaultPage.tsx:137](desktop/src/renderer/src/pages/VaultPage.tsx:137)） | 重新挂载恒为 `false`，`inbox:lastRun` 只回放事件数组、不回放运行态（[ipc.ts:147](desktop/src/main/ipc.ts:147)） |
| H-09 停止生成丢半截回答 | `const [draft, setDraft] = useState('')`（[Workbench.tsx:43](desktop/src/renderer/src/pages/Workbench.tsx:43)） | draft 只在渲染层活着，主进程 abort 路径不发 assistant，屏幕一清就永远没了 |
| H-10 生成中切走可重复发送 | `const [streaming]`（[Workbench.tsx:42](desktop/src/renderer/src/pages/Workbench.tsx:42)）+ 按 `conv.id` 重置 | 切回来 streaming=false，再发一条 → 主进程 `this.live.set(sessionId, …)`（[agent/index.ts:198](desktop/src/main/agent/index.ts:198)）后来居上覆盖前一个 AbortController，第一个请求从此停不掉 |
| 产物入库无进度无结果 | 压根没有状态：`void inboxOrchestrator.enqueue([p])`（[artifacts.ts:37](desktop/src/main/agent/artifacts.ts:37)）发射后不管 | 用户点完「入库」只有一句 toast，之后再无音讯；重开应用也不知道哪些已经入过 |
| H-13 投递无法取消 | `child` 是 `run()` 里 Promise 内的局部变量（[orchestrator.ts:194](desktop/src/main/inbox/orchestrator.ts:194)） | 外面拿不到句柄，没有 kill 入口 |
| M-03 云同步失败无感知 | 没有状态：整个 try 包空 catch（[client.ts:93](desktop/src/main/knowledge/client.ts:93)） | 失败即蒸发，连"失败过"这件事都不存在 |
| M-27 编辑中外部改动静默覆盖 | 没有基线：`write()` 直接整篇覆盖（[vault/index.ts:122](desktop/src/main/vault/index.ts:122)） | 没有人记得"我读到的是哪个版本" |
| bug#1 离线降级 / M-01 登录无超时 | 没有"云端可达吗"这个变量 | 每处各自 try/catch，用户看到的是各种形态的卡住 |

所以修法不是九个补丁，是**把这些状态从渲染层搬到主进程，让主进程成为唯一真相源，渲染层退化成纯投影**。搬完之后，上面九条中的七条是同一段代码的自然结果，另两条（M-27 冲突、inbox 取消）是搬完之后才具备落点的功能。

**本方案不解决**：H-11（搜索空结果三态）、H-12（建库向导 busy 卡死）、M-25/M-26（性能）——它们是页面局部状态问题，与本层无关，各自单独修更便宜。

---

## 1. 状态模型

### 1.1 两个概念：Task 与 Condition

设计上必须先分开这两样，否则一定会做出一个「永远处于 running 的假任务」：

- **Task（任务）**：有明确起点、有终态、可能失败、可能可取消。投递批次、AI 生成、产物入库、单次云同步都是任务。
- **Condition（状况）**：长期存在、没有终态、只有"当前是什么样"。云端连接状态是 Condition，不是 Task。

把云端连接硬塞成 Task 会导致 UI 上永远挂着一条"云端同步中…"，这正是要避免的噪音。两者分开存、分开推、分开渲染。

### 1.2 Task 类型与公共字段

`src/main/tasks/types.ts`：

```ts
export type TaskKind = 'inbox' | 'agent' | 'ingest' | 'sync'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface TaskBase {
  /** `${kind}:${key}`，同一实体重跑复用同一个 id（不累积僵尸条目） */
  id: string
  kind: TaskKind
  /** 业务主键：inbox=vaultRoot，agent=conversationId，ingest=产物相对路径，sync=conversationId */
  key: string
  status: TaskStatus
  /** 全局条上显示的一句话，主进程生成好，渲染层不再拼文案 */
  title: string
  startedAt: number
  endedAt?: number
  /** 有确定分母才给；agent 这种不知道总量的不给 */
  progress?: { done: number; total: number; label: string }
  /** failed 时的人话（不是 stack） */
  error?: string
  cancelable: boolean
  /** 单调递增版本号：渲染层丢弃乱序/过期事件，也是 reload 后对账的依据 */
  seq: number
}
```

`title` 由主进程生成是刻意的：全局条、页面局部条、诊断日志三处要显示同一句话，文案分散在渲染层三处必然长歪。

### 1.3 四类任务的字段与生命周期

**① `inbox` 投递批次** — 同一时刻至多一个（orchestrator 本来就是串行 + `rerun` 合并）

```ts
interface InboxTask extends TaskBase {
  kind: 'inbox'
  files: string[]          // 本轮收到的文件名（现在的 runFiles）
  stages: InboxEvent[]     // 现在的 lastRun，原样搬过来
  pid?: number             // pipeline 子进程组 id，取消要用
  canceled?: 'user' | 'quit'
}
```
生命周期：`queued`（watcher 收到文件，3s 去抖窗口内）→ `running`（spawn pipeline）→ `succeeded` / `failed` / `canceled`。
终态后保留在 `recent` 里（见 1.5），面板上仍能看到「上一轮：6/6 完成」。

**② `agent` AI 生成会话** — 每个 conversationId 至多一个

```ts
interface AgentTask extends TaskBase {
  kind: 'agent'
  conversationId: string
  /** 主进程累积的流式正文——H-09/H-10 的关键：draft 不再只活在渲染层 */
  draft: string
  toolLine?: string
  sdkSessionId?: string
}
```
生命周期：`running`（`send()` 进入）→ `succeeded`（收到 result）/ `failed`（异常）/ `canceled`（用户 stop）。
**draft 上移是这一类的全部意义**：一旦 draft 在主进程，「切走再切回来看得见半截」「停止时把半截落成消息」「同一 session 已在跑就拒绝再发」三件事全都变成一行判断。

**③ `ingest` 产物入库** — 每个产物路径至多一个

```ts
interface IngestTask extends TaskBase {
  kind: 'ingest'
  artifactPath: string     // 90_产物/ 下的相对路径
  noteRel?: string         // 成功后落位的笔记路径，用于「打开笔记」
}
```
生命周期：`queued`（enqueue 进投递箱）→ `running`（被本轮 inbox run 覆盖到）→ `succeeded`（落位 md 且 cloud_sync 完成）/ `failed`。
注意它与 `inbox` 是**从属关系不是并列**：ingest 任务的 running 阶段实际由某个 inbox run 承载，`progress` 直接引用那个 inbox task 的进度。这样避免了两条进度条各说各话。

**④ `sync` 云同步** — 每次聊天保存触发一个，短命

```ts
interface SyncTask extends TaskBase {
  kind: 'sync'
  scope: 'conversation' | 'note'
  tries: number
  nextRetryAt?: number
}
```
生命周期：`running` →`succeeded`（多数情况几百毫秒内结束，UI 上根本来不及出现——这是对的）/ `failed`（进重试队列，见 3.3）。
只有 `failed` 且重试也失败时才在 UI 上冒头，否则全程静默。**这一类的设计目标是"绝大多数时候不可见"**，M-03 要的不是把成功也报出来，是失败别蒸发。

### 1.4 Condition：云端状态

```ts
export interface CloudState {
  reachable: boolean | null   // null = 还没探测过（启动首帧）
  loggedIn: boolean
  email?: string
  /** 最近一次失败原因，给「云端离线」条做副标题 */
  lastError?: string
  checkedAt: number
  /** 待重试的同步条数，>0 时全局条显示「N 条待同步」 */
  pendingSync: number
}
```
探测时机：启动、登录/登出、任何一次 `authedFetch` 失败或成功（顺带更新，不额外发请求）、离线时每 60s 退避重试。
`reachable=false` 时全应用行为一次性降级：登录门给「网络不可达」而不是"密码错"（M-01）、AI 检索静默回退本地时在工作台顶部挂说明条（M-28 顺带）、启动不再卡在会话恢复（bug#1）。

### 1.5 Registry 结构

`src/main/tasks/registry.ts`：

```ts
class TaskRegistry {
  private active = new Map<string, Task>()        // 未终态
  private recent: Task[] = []                     // 终态，环形，最多 20 条 / 保留 30 分钟
  private cloud: CloudState = { reachable: null, loggedIn: false, checkedAt: 0, pendingSync: 0 }
  private seq = 0

  start(t: Omit<Task,'seq'|'status'|'startedAt'>): Task
  patch(id: string, p: Partial<Task>): void        // seq++ 并 emit
  finish(id: string, status: 'succeeded'|'failed'|'canceled', error?: string): void
  cancel(id: string): Promise<boolean>             // 分发给各 kind 的 canceler
  snapshot(): { tasks: Task[]; cloud: CloudState } // active + recent
  setCloud(p: Partial<CloudState>): void
}
export const tasks = new TaskRegistry()
```

`active` 与 `recent` 分开的原因：全局条只看 `active`（有没有事在跑），面板要看 `recent`（刚才那件事成了没）。合在一个数组里，两处都得过滤，且"什么时候删"没有统一答案。

**不做的事**：不做任务队列调度器、不做优先级、不做并发上限。investigator 是串行的、agent 是按会话天然分片的，加调度器是过度设计。

---

## 2. 事件模型

### 2.1 新增统一通道 `task:event`

命名沿用现有 `vault:changed` / `inbox:event` / `artifact:created` 的 `域:事件` 风格。

```ts
type TaskEventPayload =
  | { type: 'snapshot'; tasks: Task[]; cloud: CloudState }
  | { type: 'upsert'; task: Task }
  | { type: 'remove'; id: string }
  | { type: 'cloud'; cloud: CloudState }
```

配套一个 invoke：`tasks:list` → `{ tasks, cloud }`，与 `snapshot` 同结构。

**push 尽力而为，snapshot 是权威。** 这条必须写死：`webContents.send` 在窗口 reload 期间发出的事件会静默丢失（现在 `inbox:event` 就是这么丢的），所以渲染层任何一次挂载都以 `tasks:list` 打底，push 只做增量。`seq` 用来丢弃迟到的 upsert（`incoming.seq <= known.seq` 直接忽略）。

### 2.2 高频 delta 不进 task:event

AI 逐字 delta 每 token 一条，如果每条都推一个完整 Task 对象，序列化开销与 GC 压力都不可接受。分工：

| 通道 | 频率 | 内容 | 用途 |
|---|---|---|---|
| `agent:stream`（**保留不动**） | 每 token | `{sessionId, kind:'delta', text}` | 当前正在看的会话逐字渲染 |
| `task:event` | 状态跃迁 / 阶段变化 / 每 ~500ms 节流一次 draft 长度 | 完整 Task | 全局条、切回会话时补基线、跨页面出口 |

切回一个正在生成的会话时的行为：先从 `tasks:list` 拿 `task.draft` 一次性补齐（这就是切走那段时间里流出来的字），再继续听 `agent:stream` 追加。用户看到的是连续的。

### 2.3 与现有通道的兼容/迁移

**`inbox:event` / `inbox:lastRun`：一期兼容，二期删。**

一期做法：orchestrator 内部的 `send()`（[orchestrator.ts:41](desktop/src/main/inbox/orchestrator.ts:41)）改为写 registry，registry 转发两路——新的 `task:event` 和旧的 `inbox:event`。知识库页的 `useInbox` 一期原样不动仍然能跑，新代码走新通道。二期把 `useInbox` 改成 `useTask('inbox')` 的薄封装，然后删掉 legacy 转发与 `inbox:lastRun` handler。

这样切分的好处：一期不需要在同一个 PR 里既改主进程又重写 `VaultPage` 的投递箱面板，回归面小一半。

**`agent:stream`：永久保留**，语义收窄为「高频增量」。不迁移。

**`artifact:created`：保留**，它是 vault 文件事件不是任务事件，语义上不属于本层。

### 2.4 渲染层订阅与消费

```
App.tsx
 └ <TasksProvider>            ← 全应用唯一订阅点，挂载即 tasks:list + 订阅 task:event
     ├ <TaskDock/>            ← 侧栏底部全局条
     ├ <OfflineBar/>          ← cloud.reachable===false 时的顶部条
     └ <main>
         ├ Workbench   → useAgentTask(conv.id)
         ├ VaultPage   → useTask('inbox')  /  useIngestTasks()
         └ Settings    → useCloud()
```

`src/renderer/src/hooks/useTasks.ts`：

```ts
// 一个模块级 store，用 useSyncExternalStore 订阅——React 18 自带，不是状态管理库
const store = { tasks: new Map<string, Task>(), cloud: initialCloud, listeners: new Set<() => void>() }
export function useTask(kind: TaskKind, key?: string): Task | undefined
export function useTasks(kind?: TaskKind): Task[]
export function useCloud(): CloudState
```

用 `useSyncExternalStore` 而不是 Context+useState 的理由：Context 一变全树重渲染，AI 生成时每 500ms 一次全树重渲染会拖慢逐字输出；`useSyncExternalStore` + selector 只重渲染真正订阅了那条任务的组件。它是 React 18 内置 API，不违反"不引入状态库"。

**页面组件不得自己 setState 维护任务态。** 唯一例外：`Workbench` 的逐字 draft 允许本地累积（性能），但每次挂载必须先用 `task.draft` 做基线。这条例外要在代码注释里写明，否则下一个人会照抄成"到处都能本地存"。

---

## 3. 恢复语义

三种场景，答案完全不同，必须分开写清楚。

### 3.1 页面切换（组件卸载/挂载）

**零成本，什么都不用做。** 订阅点在 `App` 层，页面切换不影响它。这就是 H-07/H-08 的解——不是"回来时去恢复"，而是"根本没丢过"。

### 3.2 渲染层刷新（Cmd+R / `render-process-gone` 后 `win.reload()`）

渲染层内存全没，主进程内存完好。`TasksProvider` 挂载 → `tasks:list` → 全量恢复。
**主进程内存是这一层的 source of truth，不需要任何落盘。**

一个现在就存在、本方案顺带修掉的洞：[main/index.ts:44](desktop/src/main/index.ts:44) 的 `render-process-gone` 会 `win.reload()`，而 reload 期间正在跑的投递进度事件全部丢失，回来后面板空白——这正是 H-08 在崩溃恢复路径上的另一个表现。

### 3.3 应用重启

主进程内存也没了。判据一句话：

> **「进行中」永不落盘，落盘的只有「终态结果」与「待办队列」。**

落了"进行中"，重启后必然出现一个永远不会结束的幽灵任务，且没有任何办法确认它死没死。按这条判据逐类过一遍：

| 类型 | 重启后 | 落盘什么 | 落在哪 |
|---|---|---|---|
| `inbox` | **不恢复 running**。pipeline 子进程随 app 退出被杀（见 5.1）；但投递箱目录里没处理完的文件还在，watcher 启动时 `ignoreInitial:false`（[orchestrator.ts:80](desktop/src/main/inbox/orchestrator.ts:80)）会自然重新拾起，起一个**新**的 run | 上一轮的结果摘要 `lastInboxRun: {endedAt, ok, files, stages}` | `electron-store` `tasks.json` |
| `agent` | **不恢复 running**（SDK query 已死，无法续）。启动时若发现有未完成 draft，把它作为一条尾标「（应用重启，本次回答已中断）」的 assistant 消息补进该对话 | 未完成的 `{conversationId, draft}` | `tasks.json`，写入节流 2s |
| `ingest` | 不恢复 running，但**「哪些产物已入库」必须持久化** | `ingested: { [artifactRel]: {at, noteRel, contentHash} }` | `tasks.json` |
| `sync` | **重试队列必须持久化并在启动后重试** | `syncQueue: [{convId, tries, lastError, at}]` | `tasks.json` |
| `cloud` | 不落盘，启动探测（落盘的"上次在线"是有害信息，会让离线用户以为在线） | — | — |

两条要点在 §3.4 / §3.5 里写死，不留解释空间。

> **一期实施偏差（已记录）**：`agentDrafts` 的落盘与「重启后补成中断消息」是同一个功能的两半，拆开做等于留一张没人读的死表。**两半一起放到二期**，与 H-09 的 draft 落消息共用同一段代码。一期的 agent draft 只活在主进程内存里——这已经足够解决"切走再切回看得见"（H-08 的对话版）。

### 3.4 `ingested` 表主键（写死）

**主键 = `(artifactRel, contentHash)` 复合键。**

落盘形态以路径为对象键、内容哈希为值内校验位：

```ts
ingested: Record<string /* artifactRel */, {
  contentHash: string   // sha256(文件内容)
  mtimeMs: number       // 快速门，见下
  size: number          // 快速门
  at: number
  noteRel?: string      // 落位笔记，用于「已入库 ✓ ›」点击跳转
}>
```

判定规则：**路径命中且 `contentHash` 相同 → 已入库；哈希不同 → 产物被重新生成过，视为未入库、允许重新入库。**

为什么不是单一键：

- **只用路径**：产物重新生成（同名新内容）会被永久误判为"已入库"，用户再也入不了库 —— 这是最坏的一种，因为它静默
- **只用哈希**：查询前必须先算哈希，且用户重命名产物后会显示"已入库"却指向对不上的笔记
- **复合键**：按路径 O(1) 定位，再比哈希确认身份，两种误判都堵住

**快速门**：回答"这个产物入库了吗"需要当前文件的哈希，而产物面板一次列 30 个、pptx 动辄几 MB，每次开面板全量算 sha256 是浪费。所以先比 `(mtimeMs, size)`——与存量一致就直接信任存量哈希，不重算；只有 mtime 或 size 变了才真去读文件算哈希。（rsync 的老办法，够用。）

**明确不做跨路径按哈希去重**：重命名产物会被视为新产物、可以重新入库。代价是云端多一条记录（云端按 `owner+file_path` 去重，见 migration 011）；收益是绝不会出现"显示已入库、点进去是另一篇笔记"。宁可多一条也不指错。

### 3.5 `syncQueue` 退避策略（写死）

```
失败第 1 次 → nextRetryAt = now + 1 分钟
失败第 2 次 → now + 5 分钟
失败第 3 次 → now + 30 分钟
失败第 4 次 → 停止自动重试，status='failed'，转手动
```

```ts
syncQueue: Array<{
  id: string          // `sync:${convId}`，同一会话只排一条（后来的覆盖前面的）
  convId: string
  tries: number       // 0..3
  lastError?: string
  at: number          // 首次失败时间
  nextRetryAt: number // 0 = 已转手动，不再自动重试
}>
```

三条配套规则：

- **同一会话只排一条**：聊天是持续追加的，同一个 `convId` 反复失败不该堆成几十条。后来的覆盖前面的，`tries` 累加。
- **转手动之后的出口**：Dock 上显示「N 条待同步 · 重试」，点击把整队 `tries` 归零并立即跑一轮。不给"永远重试"——离线一整天回来一次性打几百个请求，比失败本身更糟。
- **登录状态变化即清队**：登出时清空队列（那些记录属于上一个账号，不能带到下一个账号的 Supabase 里去）。

一期只做**入队与计数**（把失败落进队列、把条数暴露到 `cloud.pendingSync`、Dock 上显示出来），**真正的重试定时器与「重试」按钮在二期**——一期的目标是"失败别蒸发"，不是"自动修好"。

**`syncQueue` 就是 HANDOFF 里承诺过、代码里从来不存在的那个队列**（审计 M-03）。二期做完顺手把 HANDOFF 的措辞从"v2 待办"改回"已实现"。

---

## 4. UI 呈现

### 4.1 全局形态：侧栏底部常驻条 `TaskDock`

位置定在**侧栏底部、身份行上方**。理由是排除法：

- 右下角迷你指示 ❌ —— 那块已经被投递箱面板（`absolute bottom-4 right-4`，[VaultPage.tsx:190](desktop/src/renderer/src/pages/VaultPage.tsx:190)）和产物面板占了，再加一个必然打架
- 顶部条 ❌ —— 顶部要留给 `OfflineBar` 这类**状况**提示，且顶部条会挤压内容区、每次出现都造成布局跳动
- 侧栏底部 ✅ —— 三个页面都常驻可见、不与任何浮层重叠、身份行本来就在那儿（视觉上是同一块"状态区"）、宽度固定所以文案长度可控

形态规则：

| 活跃任务数 | 呈现 |
|---|---|
| 0，且 recent 里无失败 | **不出现**（这是默认状态，不能给用户长期噪音） |
| 0，但 recent 里有失败 | 一条可点掉的红字「入库失败 1 项 ›」，点开看详情 |
| 1 | 「投递箱处理中 3/6 ›」+ 细进度条，点击跳到对应页面并展开局部面板 |
| ≥2 | 「3 项进行中 ›」，点击弹出一个小列表（不是新页面，是 popover），每项可点进对应页面 |

**出现/消失走高度过渡**（批注 2）：Dock 是条件渲染的，直接挂载/卸载会让侧栏底部"跳"一下——身份行会被顶上去又落回来，眼睛很难不注意到。做法是外层常驻一个 `overflow-hidden` 容器，靠 `max-height` + `opacity` 过渡在 0 与内容高度之间切换（`--dur-base` + `--ease-out`），身份行的位置只是平滑上移。走查开着 `prefers-reduced-motion: reduce`，所以这条过渡必须一并进 `index.css` 的降级块（现有降级块只关了 `animation`，没关 `transition`——不补的话截图会糊在中间帧，正是二轮返工踩过的坑）。

`OfflineBar` 独立于 Dock：`cloud.reachable === false` 时在 `<main>` 顶部挂一条暖色说明条「云端离线，本地功能照常可用（知识库/投递箱）；AI 检索已降级为本地全文」。这一条同时兑现 bug#1 的正确行为描述和 M-28 的降级说明。

### 4.2 局部与全局的关系

**唯一真相源：主进程 registry。渲染层的 store 是它的镜像。页面上的一切都是投影。**

具体到三处局部呈现：

- 知识库页 `InboxPanel`：改为 `useTask('inbox')` 的消费者，删掉 `useInbox` 里的 `running`/`events` 本地 state。面板的"开/关"仍是页面局部状态（那是视图偏好，不是任务状态），但"跑没跑、跑到哪"一律来自全局。
- 工作台 streaming：`streaming` 布尔量改为 `useAgentTask(conv.id)?.status === 'running'`。这样 H-10 的"切回来没有进行中状态"自动消失。
- 产物卡片入库按钮：状态来自 `useTask('ingest', artifactPath)` + 持久化的 `ingested` 表。

局部面板**允许有全局条没有的细节**（阶段日志、逐字正文），但**不允许有与全局条矛盾的状态**。判据：任何一个布尔量如果全局条和局部面板都要用，它就必须只有一份，且在主进程。

---

## 5. 取消与冲突

### 5.1 `inbox:cancel` 与进程树 kill

问题的实质：`spawn(pipelineBin(), args)` 起的是 PyInstaller onedir 的引导程序，它内部会再 fork 出真正干活的 Python 进程。`child.kill()` 只杀直接子进程，孙子进程会变成孤儿继续跑——继续写 vault、继续烧 LLM 额度，而 UI 已经显示"已停止"。这是比不做取消更糟的状态。

方案：

1. spawn 时加 `detached: true`，让子进程成为**新进程组的组长**（组 id == child.pid）。不调 `unref()`——我们仍然要等它的 close 事件。
2. 取消时 `process.kill(-child.pid, 'SIGTERM')`：负号 = 杀整个进程组，孙子进程一并收到。
3. 起一个 3 秒定时器，若 `child` 仍未 close，升级为 `process.kill(-child.pid, 'SIGKILL')`。
4. `child` 从 `run()` 的局部变量提升为实例字段 `private child: ChildProcess | null`，并把 pid 写进 InboxTask，取消入口才拿得到句柄。
5. **`app.on('before-quit')` 里执行同一套 kill**（现在完全没做，退出应用会留下跑着的 pipeline——这是当前就存在的 bug，只是没人注意到）。

取消后的语义要说清楚并写进 UI 文案：

- **不做回滚**。pipeline 已经落位的 md、已经写的 `.done` 标记全部保留。回滚意味着删用户 vault 里的文件，风险远大于收益。
- 面板显示「已停止（本轮处理到 3/6，已完成的部分已保留）」，未处理的文件仍在投递箱里，下次「立即处理」会接着做。
- 取消是 `canceled` 状态不是 `failed`，颜色用中性灰不用红色——用户主动的操作不该看起来像出错。

### 5.2 M-27 编辑冲突：检测时机与交互

三个时机全做，但**只在两个点打断用户**：

| 时机 | 做什么 | 打断用户吗 |
|---|---|---|
| **(a) 进入编辑态** | 记基线 `{mtimeMs, sha256}`（需要新增 `vault:stat`，或让 `vault:readRaw` 一并返回） | 否 |
| **(b) 编辑期间收到 `vault:changed` 且路径==当前笔记 且 dirty** | 正文顶部挂一条非模态暖色条：「此文件已在外部被修改（Obsidian？）」+「查看对方版本」「用我的覆盖」 | **否**——用户正在打字，弹模态会吞掉击键、打断输入法组合，是更差的体验 |
| **(c) 点保存时** | 再算一次磁盘 hash，与基线比对（兜住 (b) 漏掉的窗口 / TOCTOU） | **是**——此刻用户已经决定要写盘了，打断是合理的 |

(c) 的模态给三个选项，措辞要说清后果：

- **覆盖**：用我的内容覆盖磁盘上的版本（对方的改动会丢失）
- **另存为副本**：写成 `笔记名 (冲突副本 2026-08-16 14-30).md`，两份都保住 ← **默认高亮项**
- **取消**：什么都不做，回到编辑态

"另存为副本"作默认是 Obsidian / Dropbox / 坚果云的通行做法，理由是它是**唯一零数据丢失的选项**。审计里 M-27 特别指出「Obsidian 同时编辑」是对外宣传的卖点，那么这条路径上的默认值就不能是"可能丢对方数据"。

注意 (b) 有个坑要在实现时留意：应用自己 `write()` 也会触发 `vault:changed`（[vault/index.ts:64](desktop/src/main/vault/index.ts:64) 的 `change` 事件），必须用"刚刚是不是我自己写的"来抑制自触发（写入时记一个 `{path, mtimeMs}` 白名单，watcher 事件命中就跳过），否则每次保存都会自己给自己报冲突。

### 5.3 顺带解决的 H-09 / H-10

有了主进程 draft，两条都退化成几行：

- **H-09 停止生成**：`stop(sessionId)` 时若 `task.draft` 非空，先 `emit({kind:'assistant', text: draft + '\n\n（已停止）'})` 再 abort。半截回答落进对话历史，可复制、可继续追问。
- **H-10 重复发送（批注 1 已定：拒绝 + 提示）**：`send()` 开头判 `tasks.get('agent:'+sessionId)?.status === 'running'` → **拒绝**，不 abort 旧的。理由是"我以为它没在跑"和"我想重来"是两回事，静默 abort 会误伤正在生成的长回答。AbortController 覆盖问题随之消失。
  提示形态：toast **带一个「停止当前生成」动作按钮**——光说"已有生成在进行中"等于把用户堵死在原地，得就地给出出口。这需要 `ui.toast` 支持可选的 `action: { label, onClick }`（现有 toast 只有纯文本，[ui.tsx:26](desktop/src/renderer/src/components/ui.tsx:26)），是二期的一个小前置改动；`ui.confirm/prompt` 不受影响。

---

## 6. 改动清单

### 6.1 文件

**新增（主进程）**
- `src/main/tasks/types.ts` — Task/Condition 类型
- `src/main/tasks/registry.ts` — TaskRegistry 单例、emit、snapshot
- `src/main/tasks/persist.ts` — `tasks.json`（lastInboxRun / ingested / syncQueue 三张表；agentDrafts 随 H-09 一起放二期，见 §3.3 的实施偏差）

**新增（渲染层）**
- `src/renderer/src/hooks/useTasks.ts` — 模块级 store + `useSyncExternalStore` + selector hooks
- `src/renderer/src/components/TaskDock.tsx` — 侧栏底部全局条 + popover
- `src/renderer/src/components/OfflineBar.tsx` — 云端离线说明条
- `src/renderer/src/components/ConflictBar.tsx` — 编辑冲突非模态提示条

**改（主进程）**
- `src/main/inbox/orchestrator.ts` — `send()` 改写 registry；`child` 提升为实例字段 + `detached:true`；新增 `cancel()`；`lastRun` 迁走
- `src/main/agent/index.ts` — `live` Map 并入 registry；累积 draft；`stop()` 落 assistant 消息；`send()` 加重复检查
- `src/main/agent/artifacts.ts` — 入库改为建 ingest 任务；写/读 `ingested` 表
- `src/main/knowledge/client.ts` — `syncConversation` 空 catch 改为建 sync 任务 + 失败进队列
- `src/main/auth/index.ts` — CloudState 探测、login 加 10s 超时与可取消（M-01）
- `src/main/vault/index.ts` — 新增 `stat(relPath)` 返回 `{mtimeMs, hash}`；`write()` 记自触发白名单
- `src/main/index.ts` — `before-quit` 里 kill 进程组
- `src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/src/api.d.ts` — 通道注册与类型

**改（渲染层）**
- `App.tsx` — 挂 TasksProvider / TaskDock / OfflineBar
- `pages/VaultPage.tsx` — `useInbox` → `useTask('inbox')`；InboxPanel 加「停止本轮」；NoteView 接冲突条
- `pages/Workbench.tsx` — `streaming`/`draft` 改为任务投影；产物卡片入库三态
- `pages/LoginGate.tsx` — 超时/可取消/区分「网络不可达」与「密码错」

### 6.2 IPC 通道增删改

| 动作 | 通道 | 方向 | 说明 |
|---|---|---|---|
| 增 | `tasks:list` | invoke | 返回 `{tasks, cloud}` 快照，挂载即拉 |
| 增 | `task:event` | push | 统一任务事件（snapshot/upsert/remove/cloud） |
| 增 | `inbox:cancel` | invoke | 取消当前投递批次，返回是否成功 |
| 增 | `artifacts:ingest` | invoke | 显式入库（现在是 `inbox:enqueue` 借道，没有任务身份） |
| 增 | `artifacts:ingested` | invoke | 已入库表，产物卡片初始化用 |
| 增 | `vault:stat` | invoke | `{mtimeMs, hash}`，冲突检测基线 |
| 增 | `vault:writeChecked` | invoke | 带基线 hash 的写入，服务端二次校验（5.2 的 (c)） |
| 改 | `auth:login` | invoke | 加超时；返回值区分 `network` / `credential` 两类错误 |
| 保留 | `agent:stream` | push | 高频 delta，语义收窄，**不迁移** |
| 保留 | `artifact:created` | push | 文件事件，不属于任务层 |
| 一期兼容→二期删 | `inbox:event` | push | 由 registry 转发，二期删 |
| 一期兼容→二期删 | `inbox:lastRun` | invoke | 被 `tasks:list` 取代，二期删 |

### 6.3 走查需要新增的断言

按铁律，每条修复都要在 `e2e/walkthrough.mjs` 里真点一次并断言结果状态。预计新增：

**一期**
1. 投递跑起来后**切到工作台页**，断言侧栏底部 Dock 出现且文案含进度（H-07）
2. 从工作台**切回知识库页**，断言进度条仍在、`running` 为真、日志不是上一轮的（H-08）
3. 触发 AI 生成 → 切到别的对话 → 切回，断言停止按钮仍在、屏幕上的半截正文与切走前连续（H-10 可见性 + draft 基线）
4. 产物卡片点「入库」，断言按钮进入「入库中」态，跑完变「已入库 ✓」并能点开落位笔记（产物入库反馈）
5. `win.reload()` 后断言 Dock 状态与 reload 前一致（3.2 恢复语义）
6. 断言 `tasks:list` 返回的 active 任务数与 UI 上 Dock 显示的条数一致（真相源一致性）

**二期**
7. 投递跑到一半点「停止本轮」，断言：UI 变 `canceled`、`ps` 查不到 pipeline 进程组残留、已落位的 md 仍在（H-13 + 5.1）
8. 生成中点「停止生成」，断言半截回答**留在对话里**且带「（已停止）」尾标，可复制（H-09）
9. 生成中再发一条，断言被拒绝且给出提示，第一个请求仍可停止（H-10 竞态）
10. 编辑笔记时用 Node 侧直接改磁盘上的同一文件，断言正文顶部出现冲突条且**没有弹模态**；再点保存，断言弹出三选一且默认高亮「另存为副本」（M-27）
11. 断网/指向不可达的 apiBaseUrl 启动，断言窗口正常出现、知识库可用、顶部有「云端离线」条（bug#1）
12. 同上环境点登录，断言 10s 内返回且文案是「网络不可达」而非「密码错」（M-01）
13. 制造一次同步失败，断言 `tasks.json` 的 `syncQueue` 有条目、Dock 显示「N 条待同步」、恢复网络后自动清空（M-03）

断言 7 需要在走查里 `ps -o pgid,command` 查进程组，这是 e2e 第一次做进程级断言，实现时留出调试时间。

---

## 7. 分期

一次做完的风险：同时改主进程四个模块 + 渲染层三个页面 + 删两个 IPC 通道，一旦回归很难二分定位。切成两期，**每期结束产品都处于可发布状态**。

### 7.1 一期内部顺序（批注 3）

一期本身也要能中途停下来交付，顺序按「风险从低到高」排，每一步做完都是一个可发布的点：

| 步 | 内容 | 独立交付后的状态 |
|---|---|---|
| **A** | `tasks/`（types + registry + persist 骨架）、`task:event` + `tasks:list`、preload/类型、`useTasks`、`TaskDock`、App 挂载 | 状态层通了但还没人上报，Dock 恒不出现 —— 纯增量，零行为变化 |
| **B** | inbox 迁移：orchestrator 上报 registry（legacy `inbox:event` 继续转发）、`VaultPage` 的面板改为消费 task、`lastInboxRun` 落盘 | **H-07 / H-08 解决**，Dock 开始有内容 |
| **C** | 产物入库：`artifacts:ingest` / `artifacts:ingested`、`ingested` 表、产物卡片三态 | 产物入库反馈解决 |
| **D** | 云端状况：CloudState 探测、`OfflineBar`、`syncQueue` 入队与计数 | bug#1 开窗与降级说明、M-03 可见性解决 |
| **E** | agent draft 上移：主进程累积 draft、`Workbench` 的 streaming/draft 改为任务投影 | H-10 的"看得见在跑"解决 |

**E 放最后**是刻意的：它是一期里唯一碰到高频路径（每 token）和用户最敏感界面（正在打字的对话）的一步，把它排在最后，前面四步的回归已经跑过一轮走查，出问题时二分范围最小。

### 一期：状态层 + 只读呈现（"看得见"）

**做**：`tasks/` 三个新文件、`task:event` + `tasks:list`、orchestrator/agent/artifacts/client 接入 registry（只上报，不改行为）、App 层订阅、TaskDock、三个页面改为消费者、`ingested` 持久化 + 产物入库三态、CloudState 探测 + OfflineBar。

**不做**：取消、draft 落消息、重复发送拒绝、冲突检测、登录超时。

**关键性质**：一期**只增不减**——legacy `inbox:event` / `inbox:lastRun` 全部保留并由 registry 转发，所以即使新 UI 有问题，旧路径仍然工作。这是"可发布"的底气。

**一期结束解决**：H-07、H-08、产物入库反馈、M-03 的可见性部分、bug#1 的开窗与降级说明、H-10 的"看得见在跑"部分。
**验收**：走查断言 1–6。

### 二期：可逆与冲突（"管得住"）

**做**：`inbox:cancel` + 进程组 kill + `before-quit` 清理、H-09 draft 落消息、H-10 重复发送拒绝、M-27 三时机冲突检测 + `vault:stat`/`vault:writeChecked`、M-01 登录超时与错误分类、`syncQueue` 真重试、删 legacy `inbox:event` / `inbox:lastRun` 并把 `useInbox` 收敛成薄封装。

**关键性质**：二期动的都是"行为改变"，风险集中在 kill 策略与冲突交互，但此时状态层已经稳定跑过一个版本，出问题的定位面小得多。

**二期结束解决**：H-09、H-10（完整）、H-13、M-01、M-03（完整）、M-27。
**验收**：走查断言 7–13 + 一期 1–6 全部回归。

**顺序不可颠倒**的理由：取消、冲突、重复发送拒绝这些能力，全都需要先有一个"这件事现在是什么状态"的可靠答案。没有一期，二期的每个功能都得自己再造一份状态。

---

## 8. 明确不做 / 已知风险

**明确不做**
- 不引入 Redux/Zustand/Jotai。`useSyncExternalStore` 是 React 18 内置 API，配一个模块级 Map 足够，且没有新依赖要跟着 Electron 30 的 Node 20 一起做兼容验证。
- 不把任务持久化进 SQLite。落盘的四张表都是几十条量级的 JSON，`electron-store` 够用；本地 SQLite 按 HANDOFF 是 v2 的事，不在这里提前引入。
- 不做多窗口/跨窗口任务同步。应用是单窗口，`registry.emit` 用 `BrowserWindow.getAllWindows()` 遍历只是防御性写法，不为多窗口做设计。
- 不做任务持久化恢复"继续跑"。重启后接着跑一个被杀掉的 pipeline 是伪需求——文件还在投递箱里，watcher 自然会重新处理。

**已知风险**
1. **`detached:true` 改变 spawn 行为**。macOS 上进程组语义与开发机一致，但打包后（PyInstaller onedir + asar unpack）路径与权限不同，取消功能必须在**打包形态**下回归一次（`MCNAI_APP_BIN=... node e2e/walkthrough.mjs`），不能只在 dev 形态验。
2. **draft 上移会增加 IPC 流量**。已用 500ms 节流 + delta 走旧通道两条措施压住，但长回答（万字级）时 Task 对象会变大，实现时给 `task.draft` 设一个上限（例如只保留最后 20KB，全文仍在渲染层累积），避免每次 snapshot 都搬一大坨。
3. **`vault:changed` 自触发抑制**是 5.2 的隐藏难点。白名单按 `{path, mtimeMs}` 匹配，若 chokidar 的 `awaitWriteFinish`（800ms，[vault/index.ts:50](desktop/src/main/vault/index.ts:50)）导致 mtime 与写入时记录的不一致，会漏抑制、误报冲突。实现时优先用内容 hash 比对而不是 mtime。
4. **Dock 的"0 活跃不出现"会造成布局跳动**（侧栏底部多出/少掉一条）。用固定高度占位或 `max-height` 过渡处理，走查里要有一张 Dock 出现前后的对比截图。
5. **一期的双通道并行期**，同一个投递事件会同时经 `inbox:event` 和 `task:event` 到达渲染层。若两处都触发面板自动展开，会出现闪烁。一期实现时明确：**自动展开只由新通道驱动**，legacy 通道只喂旧的 `useInbox`。

---

## 附：与现有约束的对账

| 约束 | 本方案如何满足 |
|---|---|
| Electron 锁 30.5.1 | 零新依赖；用到的 `process.kill(-pid)`、`detached`、`useSyncExternalStore` 在 Electron 30 / Node 20 / React 18 全部可用 |
| 渲染进程零 Node | 所有文件/进程/网络操作留在主进程；渲染层只经 preload 的 contextBridge 拿数据；新增通道全部走 `ipcRenderer.invoke` / `ipcRenderer.on` |
| IPC 命名风格一致 | 新通道 `tasks:list` / `task:event` / `inbox:cancel` / `artifacts:ingest` / `vault:stat` 全部沿用 `域:动作` 与 `域:事件` |
| 不引入状态管理库 | `useSyncExternalStore`（React 18 内置）+ 模块级 Map + 现有 IPC 订阅 |
| 产物统一写 `vault/90_产物/` | 不变；`ingested` 表只记路径与 hash，不改落位规则 |
| GUI 改动必跑走查 | §6.3 列了 13 条断言，按期分配 |

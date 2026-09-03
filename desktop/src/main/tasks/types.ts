import { INBOX_STAGES, stageLabel } from '../../renderer/src/config/stages'

/**
 * 全局任务状态层的类型定义（设计见 docs/DESIGN-task-state.md §1）。
 *
 * 两个概念必须分开，否则一定会做出「永远处于 running 的假任务」：
 *  - Task      有起点、有终态、可能失败、可能可取消（投递批次 / AI 生成 / 产物入库 / 云同步）
 *  - Condition 长期存在、没有终态，只有"当前是什么样"（云端连接状态）
 */

export type TaskKind = 'inbox' | 'agent' | 'ingest' | 'sync' | 'secret'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

/** 投递箱 pipeline 的阶段事件（原来定义在 orchestrator，搬来这里给任务对象共用） */
export interface InboxEvent {
  type: 'file-added' | 'run-start' | 'stage' | 'run-end'
  stage?: string
  status?: string
  message?: string
  pending?: number
  file?: string
  ok?: boolean
  /** pipeline 若在阶段行里报了 token 用量就原样带上（目前只有智能打标可能有），没有就是 undefined */
  usage?: unknown
  /** A-4：`convert_failures` 事件带的两张清单——转换失败的、格式不支持的 */
  failed?: string[]
  unsupported?: string[]
}

export interface TaskBase {
  /** `${kind}:${key}`，同一实体重跑复用同一个 id（不累积僵尸条目） */
  id: string
  kind: TaskKind
  /** 业务主键：inbox=vaultRoot，agent=conversationId，ingest=产物相对路径，sync=conversationId */
  key: string
  status: TaskStatus
  /** 全局条上显示的一句话。**主进程生成**——全局条/局部面板/诊断日志要显示同一句，
      文案散在渲染层三处必然长歪 */
  title: string
  startedAt: number
  endedAt?: number
  /** 有确定分母才给；agent 这种不知道总量的不给 */
  progress?: { done: number; total: number; label: string }
  /** failed 时的人话（不是 stack） */
  error?: string
  cancelable: boolean
  /** 单调递增版本号：渲染层丢弃乱序/迟到的 upsert，也是 reload 后对账的依据 */
  seq: number
}

export interface InboxTask extends TaskBase {
  kind: 'inbox'
  files: string[]
  stages: InboxEvent[]
  /** pipeline 子进程组 id（spawn detached:true，组 id == 组长 pid）。取消要用它 kill 整组 */
  pid?: number
  /** 谁停的：user=面板上点了「停止本轮」，quit=退出应用时清理，switch=换库时把上一库在跑的停掉（R2） */
  canceled?: 'user' | 'quit' | 'switch'
}

export interface AgentTask extends TaskBase {
  kind: 'agent'
  conversationId: string
  /** 主进程累积的流式正文——切走再切回来靠它补齐（二期的 H-09 也靠它） */
  draft: string
  toolLine?: string
  sdkSessionId?: string
}

export interface IngestTask extends TaskBase {
  kind: 'ingest'
  /** 90_产物/ 下的相对路径 */
  artifactPath: string
  /** 成功后落位的笔记路径，用于「已入库 ✓ ›」跳转 */
  noteRel?: string
}

export interface SyncTask extends TaskBase {
  kind: 'sync'
  scope: 'conversation' | 'note'
  tries: number
  /** 0 = 已转手动，不再自动重试 */
  nextRetryAt?: number
}

/**
 * 密钥落盘（M-29）。safeStorage 的首次调用会同步冻住主进程数秒到一分钟，
 * 所以写 key 不能挡在登录/保存按钮前面——它变成一条任务，界面照常可交互。
 */
export interface SecretTask extends TaskBase {
  kind: 'secret'
  /** 落盘字段名（encryptedApiKey / encryptedSession …） */
  field: string
}

export type Task = InboxTask | AgentTask | IngestTask | SyncTask | SecretTask

/** Condition：云端状况。不是任务，没有终态 */
export interface CloudState {
  /** null = 还没探测过（启动首帧） */
  reachable: boolean | null
  loggedIn: boolean
  email?: string
  /** 最近一次失败原因，给「云端离线」条做副标题 */
  lastError?: string
  checkedAt: number
  /** 待重试的同步条数，>0 时 Dock 显示「N 条待同步」 */
  pendingSync: number
  /**
   * N4：正在做的瞬态重试，一句话。**首次静默**（第一次重试 200ms 就过去了，
   * 报出来只是让界面闪一下），从第二次起才有值；成功或放弃即清空。
   * 它落在 TaskDock 那条上，**绝不进对话历史**——那是"这一次的运行状况"，不是 AI 说的话。
   */
  retrying?: string
}

export type TaskEventPayload =
  | { type: 'snapshot'; tasks: Task[]; cloud: CloudState }
  | { type: 'upsert'; task: Task }
  | { type: 'remove'; id: string }
  | { type: 'cloud'; cloud: CloudState }

/**
 * 投递箱主流程的阶段顺序。进度分母在主进程算，渲染层不再自己拼。
 *
 * **顺序与用户词都来自 `config/stages.ts`**（U3 #6）：它原来在这里写一份、
 * VaultPage 的 `STAGE_ZH` 又写一份，改一处必漏另一处。
 */
export const INBOX_FLOW: Array<[string, string]> = INBOX_STAGES.map((s) => [s, stageLabel(s)])

/**
 * 投递箱进度计算——**纯函数，抽出来是为了能零花费测**。
 *
 * 它原来是 `InboxOrchestrator` 的私有方法，于是唯一能验它的办法是真跑一轮真实打标
 * （几十分钟 + 真金白银）。结果就是那条 `label === '智能打标'` 的死判据从上线起
 * 没被任何测试碰过，直到 2026-08-21 花 ¥0.88 真跑 Jerry 的 166 个文件才暴露：
 * **界面整整 18 分钟停在「PII守卫 2/8」**，而后台一直在稳步打标。
 *
 * 教训：**只在真实调用下才走到的分支，要么抽成纯函数、要么就是没人测。**
 * "以后记得跑真调用"不是办法——它贵、慢，而且没人会为一行 label 去跑。
 *
 * @param stages   收到的阶段事件（只看 `type==='stage'` 且 `stage` 在 INBOX_FLOW 里的）
 * @param tagProgress 打标的篇级进度；有值就说明打标正在跑
 */
export function computeInboxProgress(
  stages: Array<{ type?: string; stage?: string }>,
  tagProgress: { done: number; total: number } | null
): { done: number; total: number; label: string } {
  let done = 0
  let label = ''
  for (const ev of stages) {
    if (ev.type !== 'stage' || !ev.stage) continue
    const i = INBOX_FLOW.findIndex(([k]) => k === ev.stage)
    if (i < 0) continue
    done = Math.max(done, i + 1)
    label = INBOX_FLOW[i][1]
  }
  if (tagProgress) {
    const i = INBOX_FLOW.findIndex(([k]) => k === 'tag_llm')
    // 打标已经过去了（后面的阶段事件到了）就别再顶回来
    if (i >= 0 && done <= i + 1) {
      done = Math.max(done, i + 1)
      // total 为 0 时不许说「第 1/0 篇」——那是句荒唐话，用户会以为出错了。
      // 这一格刚起步、还没数出总数的那一瞬间就是这个状态（断言逮到的）
      label = tagProgress.total > 0
        ? `${stageLabel('tag_llm')} · 第 ${Math.min(tagProgress.done + 1, tagProgress.total)}/${tagProgress.total} 篇`
        : stageLabel('tag_llm')
    }
  }
  return { done, total: INBOX_FLOW.length, label: label || '准备中' }
}

/** 打标补齐能不能开跑；不能跑时**必须说清为什么**（0.1.2） */
export type BackfillVerdict =
  /**
   * `ok:true` 是**跑完之后**才回的（IPC 一路 await 到子进程 close），
   * 所以渲染层可以直接拿它弹完成 toast，不用再订阅任务事件。
   * `canceled` / `failed` 也在这条路上回来——"跑完了"和"被停了"在用户那里是两句话。
   */
  | { ok: true; canceled?: boolean; failed?: string; done?: number }
  | { ok: false; reason: 'no-vault' | 'busy' | 'no-key' | 'nothing'; message: string }

/**
 * 补齐能不能开跑——**纯函数，抽出来是为了能零花费测**（见 `computeInboxProgress` 上面那条铁律）。
 *
 * 0.1.2 之前这段逻辑是 `runTagBackfill` 开头的**三行裸 return**：
 *
 * ```ts
 * if (!this.vaultRoot || this.running) return   // ①②
 * if (!getLlmKey()) return                      // ③
 * ```
 *
 * 一句日志都不落、一个事件都不发。用户看到「有 156 篇可以升级」点了「现在升级」，
 * 界面**没有任何变化**——真实客户就卡在这儿问我们是不是坏了。
 *
 * 而同一个文件里的 `run()` 遇到没 key 是**降级成 `--skip-llm` 照跑**的：
 * 同一个仓库两套处理，补齐这条选了最沉默的那种。
 */
export function judgeBackfill(s: {
  vaultRoot: string | null
  running: boolean
  hasKey: boolean
  staleCount: number
}): BackfillVerdict {
  if (!s.vaultRoot) return { ok: false, reason: 'no-vault', message: '还没有打开知识库' }
  if (s.running) return { ok: false, reason: 'busy', message: '投递箱正在处理，等它跑完再升级' }
  if (!s.hasKey)
    return { ok: false, reason: 'no-key', message: '还没有配置 AI 打标的密钥，请先登录或在设置里填写' }
  if (s.staleCount <= 0) return { ok: false, reason: 'nothing', message: '所有笔记的标签都是最新的' }
  return { ok: true }
}

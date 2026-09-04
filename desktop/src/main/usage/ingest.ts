import { routeOf } from './pricing'
import { tokensOf, type UsageRecord } from './index'

/**
 * 入库打标的记账（PLAN-v2 批 5 R8 / HANDOFF bug#8）。
 *
 * ## 为什么是一个纯函数
 *
 * 这段判断只有在**真跑一轮打标**时才走到：要有库、要有 key、要真花钱、要等几分钟。
 * desktop/CLAUDE.md 的铁律说得很直接——「这段逻辑要不要花钱/等几十分钟才能触发？
 * 要，就抽出来」。`computeProgress` 就是没抽出来才让一行死判据在线上活了几个月。
 * 抽在这里，`npm run smoke:usage` 喂合成事件几毫秒验完，零花费。
 *
 * ## 三条分支（缺一条账本就会说谎）
 *
 * 1. **pipeline 报了用量**（新冻结产物）→ 完全按它报的入账，一条 usage 事件一条记录。
 *    报了 `calls: 0` 就是"这一轮真的一次没调"，**不补记录**——补一条就是凭空记一笔没花的钱。
 * 2. **pipeline 一条都没报**（老冻结产物，或换库/退出把它杀在了半路）→ 退回旧行为
 *    「只记次数、不记 token」。老产物在客户机上还活着（不是所有人都会立刻升级），
 *    这条兜底没了的话，他们的打标会从"记了次数"变成"完全不记"，是**倒退**。
 * 3. 打标压根没跑（跳过/上游失败）→ 一条都不记。
 *
 * 判据是「报没报」，不是「有没有 token」：两者在 `calls: 0` 那一轮上分道扬镳，
 * 而那一轮恰恰是最容易被记成假账的一轮。
 */

/** pipeline 打上来的一行 `{stage, status:'usage', usage, calls, model}` */
export interface PipelineUsageEvent {
  stage: string
  /** 原样透传的 usage 对象（各家形状不一，归一化在 `tokensOf`） */
  usage?: unknown
  calls?: number
  /** pipeline 侧**实际用的**模型。从另一侧取，不在这里抄一份 store.llmModel */
  model?: string | null
}

export interface IngestUsageInput {
  /** 落账时刻 */
  ts: number
  /** 这一轮的任务 id（`inbox:<库根>`，R2 的快照值） */
  taskId: string
  /** 这一轮的库根（同样是快照值，不许读 this.vaultRoot） */
  vault: string | null
  startedAt: number
  endedAt: number
  /** 打标线路的 base url（`store.llmBaseUrl`）。计价按线路取单价，不按档位（B-2） */
  baseUrl: string | null
  /** 桌面端**要求** pipeline 用的模型（`store.llmModel`） */
  expectedModel: string | null
  /** 本轮收到的 usage 事件，按到达顺序 */
  events: PipelineUsageEvent[]
  /**
   * 本轮 `tag_llm` 阶段事件的 status，按到达顺序（`['skipped']` / `['ok']` / `['skipped','ok']`…）。
   * **传的是原始状态而不是一个算好的布尔**：这个判断本身踩过坑，得能在 smoke 里喂各种组合。
   */
  tagStages: string[]
}

/**
 * 打标到底跑没跑过。**只要出现过 skipped 就是没跑**——哪怕后面还跟着一条 ok。
 *
 * 老冻结产物在"本批为空"时会**同时**打出 `tag_llm skipped(empty_batch)` 与 `tag_llm ok`
 * （`run_stage` 不看内层已经 emit 过 skipped，照样补一条 ok；pipeline 侧 2026-09-04 已修，
 * 但客户机上的老产物还活着）。只看"有没有非 skipped 的 tag_llm"会被那条假 ok 骗过，
 * 于是一轮**一次 LLM 都没调**的入库，会在账本上凭空多一条"入库打标 1 次"。
 */
export function judgeTagRan(tagStages: string[]): boolean {
  return tagStages.length > 0 && !tagStages.includes('skipped')
}

export function buildIngestUsageRecords(i: IngestUsageInput): UsageRecord[] {
  const durationMs = Math.max(0, i.endedAt - i.startedAt)
  const route = routeOf(i.baseUrl)

  // 分支 1：pipeline 报过用量 —— 它说了算，一个字都不猜
  if (i.events.length > 0) {
    return i.events
      .filter((e) => {
        const t = tokensOf(e.usage)
        return (e.calls ?? 0) > 0 || t.input + t.cacheRead + t.cacheWrite + t.output > 0
      })
      .map((e) => ({
        ts: i.ts,
        sessionId: i.taskId,
        taskType: 'ingest-tag' as const,
        tier: null, // 入库打标不经档位层，走 llmBaseUrl/llmModel 那条独立线路
        route,
        expected_model: i.expectedModel,
        // **从另一侧取**（铁律第 1 条）：pipeline 回报它自己用的模型。
        // 相等只是当下的事实，不是保证——真有一天 env 没传进去，这里就会红出来
        resolved_model: e.model ?? null,
        degraded: !!(e.model && i.expectedModel && e.model !== i.expectedModel),
        durationMs,
        usage: e.usage ?? null,
        calls: e.calls ?? 0,
        attribution: {
          template: null, // 模板系统落地前恒 null（S2 预留位）
          taskId: i.taskId,
          vault: i.vault,
          stage: e.stage,
        },
      }))
  }

  // 分支 2：老冻结产物不报用量 —— 退回「只记次数」，比"因为没有 usage 就不记"诚实
  if (judgeTagRan(i.tagStages)) {
    return [
      {
        ts: i.ts,
        sessionId: i.taskId,
        taskType: 'ingest-tag',
        tier: null,
        route,
        expected_model: i.expectedModel,
        resolved_model: null,
        durationMs,
        usage: null,
        calls: 1,
        attribution: { template: null, taskId: i.taskId, vault: i.vault, stage: 'tag_llm' },
      },
    ]
  }

  // 分支 3：打标没跑
  return []
}

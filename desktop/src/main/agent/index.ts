import { spawn } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'
import { z } from 'zod'
import { agentEnv } from '../ai/provider'
import { resolveTierForRequest, normalizeTier, unconfiguredReason, DEFAULT_TIER, type TierId } from '../ai/tiers'
import { appendUsage, tokensOf, type UsageTaskType } from '../usage'
import { routeOf } from '../usage/pricing'
import { vaultManager } from '../vault'
import { searchCloud } from '../knowledge/client'
import { store } from '../store'
import { pipelineBin } from '../lib/pipeline'
import { log } from '../lib/logger'
import { broadcast, hasWindow } from '../lib/windows'
import { tasks } from '../tasks/registry'
import { attachmentNote, stageAttachments } from './attachments'
import type { AgentTask } from '../tasks/types'
import { conversationMessages, type ChatMessage } from './conversations'
import { buildRecoveryPrompt, isResumeLost } from './resume-recovery'
import { judgeWrite } from './write-guard'
import { buildSystemPrompt } from './system-prompt'
import { judgeTimeout, resolveTimeoutMs } from './timeout'
import { readVaultConfig } from '../vault/taxonomy'
import { backupBeforeWrite, takeUndoNotice } from './write-backup'
import {
  countToolResults,
  isStepWorthy,
  pickStepArgs,
  shortToolName,
  toolResultText,
  SCAN_CAP_MARK,
  type ToolStepEvent,
} from './steps'

export interface AgentStreamPayload {
  sessionId: string
  /** `notice` = 说一句就完的中性提示（不是错误、也不终结这一轮），渲染层弹 toast */
  kind: 'delta' | 'tool' | 'assistant' | 'done' | 'error' | 'notice'
  text?: string
  tool?: string
  /**
   * 过程可见性：这条 `tool` 事件对应的**步骤**。同一步骤会来三次
   * （start → args → result），靠 `step.id` 串起来。
   * `tool` 字段保留不动（TaskDock 的 toolLine 与既有走查断言都还在用它）。
   */
  step?: ToolStepEvent
  sdkSessionId?: string
  costUsd?: number
  /** 实际服务这轮的模型名（来自 result.modelUsage）。
      DeepSeek 官方端点遇到不认识的模型名会静默降级，只有这里能看出真相 */
  models?: string[]
  /** 这一轮用的档位；出错时渲染层据此给「切换到标准模式重试」的出口 */
  tier?: TierId
  /**
   * Q15：**服务端把模型换掉了**（`modelUsage` 里没有我们点名的那个）。
   * 这个结论原来只进主进程日志的一行 warn——用户为增强档付了钱，
   * 界面照常显示「增强」，没有任何地方告诉他这一轮其实不是。
   * 现在随事件上来，步骤流折叠行尾标「已按标准档执行」。
   */
  degraded?: boolean
  /**
   * B-6：回答里**没有依据**的引用。分两种，都在这里：
   * 库里根本没有这篇（纯编造），或库里有但这一轮从没读过它（张冠李戴）。
   * 提示词只要求"标注来源"，没有任何机制保证标的是对的——这就是那个机制。
   */
  unverifiedCitations?: string[]
  /**
   * 这一轮是「旧 session 已失效 → 放弃它、拼本地历史重开」之后跑出来的。
   * 界面不用它，**冒烟要用**：不标出来的话 `smoke:provider` 的多轮 resume 用例
   * 会靠拼回去的历史照样答对，resume 坏了也测不出来。
   */
  recovered?: boolean
  /** B4：这条 notice 对应一次 AI 写入，渲染层据此在 toast 上挂「撤销」 */
  writeUndoId?: string
  /** B4：被撤销的目标文件（toast 文案用） */
  writeRel?: string
}

/** 一轮对话的执行上下文。抽出来是因为「会话恢复失败」要拿同一份参数原样重跑一次 */
interface TurnCtx {
  sessionId: string
  taskId: string
  prompt: string
  resume?: string
  tier: TierId
  /** 本地历史快照（不含本轮提问），只在带 resume 进来时才需要 */
  history: ChatMessage[]
  /** 还允许降级重开吗。只降一次：重开那轮再失败就是别的毛病，再重开只是烧钱 */
  canRecover: boolean
  recovered?: boolean
}

/** SDK 的 CLI 是平台二进制；打包后 asar 内路径无法 spawn（ENOTDIR），显式指到真实位置 */
function claudeCliBin(): string | undefined {
  const pkg = `@anthropic-ai/claude-agent-sdk-darwin-${process.arch}`
  // unpacked 优先；主进程 fs 对 asar 内路径也返回存在，必须排除未解包的 asar 路径（spawn 不认 asar）
  const candidates = [
    join(process.resourcesPath ?? '', 'app.asar.unpacked', 'node_modules', pkg, 'claude'),
    join(app.getAppPath(), 'node_modules', pkg, 'claude'),
  ]
  for (const p of candidates) {
    if (!p) continue
    if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) continue
    if (existsSync(p)) return p
  }
  return undefined
}

interface LiveSession {
  abort: AbortController
}

/**
 * 一轮回答里最多允许几次文件系统扫描（Grep/Glob）。
 *
 * 真人实测的失控形态（2026-08-18）：同一个问题跑了 **188 秒**，模型在云端检索给了
 * 一堆没有出处的碎片之后（见 §3-13），转去 Grep **穷举猜路径**——
 * `my_script` / `script` / `40_带货/数据` / `20_公司管理/24_业务数据/` 一长串 0 命中瞎试。
 *
 * **提示词管不住这个**：它已经写着"检索够用即止"，模型照样猜。所以加一道主进程侧的硬闸，
 * 挂在 **PreToolUse 钩子**上（预授权工具照样触发），数着放行、超了直接拒，
 * 并在拒绝语里告诉它"拿已有材料作答、也别改用命令行"。
 *
 * **别再挪回 canUseTool**：第一版就是那么做的，为此把 Grep/Glob 移出了 `allowedTools`
 * （那是"免提示自动放行"的名单，在里面就不走 canUseTool）。结果适得其反——
 * 模型不用 Grep/Glob 了，改用 **Bash 调 grep**，而 Bash 从来没开放过，连撞 9 次拒绝，
 * 实测 **174 秒**，比不管还慢。闸门的位置和拒绝语的措辞一样重要。
 */
const SCAN_LIMIT = 5

/** B4：AI 写知识库的确认弹窗等多久。到点默认**拒**（见 askWrite 的注释） */
const WRITE_CONFIRM_TIMEOUT_MS = 60_000

/**
 * 给确认卡用的一句话改动摘要。
 * **不把整段新内容塞进弹窗**——模型一次可能写几千字，弹窗里滚不完也看不懂；
 * 用户真正要判断的是"改哪个文件、是新建还是改写、动了多少"。
 */
function summarizeWrite(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Edit') {
    const oldS = String(input.old_string ?? '')
    const newS = String(input.new_string ?? '')
    const head = oldS.replace(/\s+/g, ' ').slice(0, 40)
    return `替换一段文字（原文约 ${oldS.length} 字 → 新文约 ${newS.length} 字）${head ? `：「${head}…」` : ''}`
  }
  const content = String(input.content ?? '')
  return `写入全文，约 ${content.length} 字`
}


/**
 * 往渲染 spec 里注入库根。**由主进程注入，不是让模型填**：
 * 库内嵌图在笔记正文里是相对引用（`../../_assets/x/img01.png`），要变成能打开的路径
 * 得知道库根。指望模型自己换算是在赌它算得对——算错的表现是整页空图，
 * 而且从产物上根本看不出是路径错了还是图丢了。渲染器拿到 `vault` 就能自己解析（见
 * `render_pptx.resolve_image`）。JSON 坏了就原样传下去，让渲染器去报它自己的错。
 */
function withVault(specJson: string, root: string): string {
  try {
    const o = JSON.parse(specJson)
    if (o && typeof o === 'object') return JSON.stringify({ ...o, vault: root })
  } catch {
    /* 模型给的 JSON 有问题：交给渲染器报错，别在这儿把原文吞了 */
  }
  return specJson
}

export class AgentManager {
  private live = new Map<string, LiveSession>()
  /** 已被用户停掉、但 abort 还没传播到位的会话（见 stop 与消息循环开头的注释） */
  private stopped = new Set<string>()
  /** 测试观察口：无头冒烟不经 IPC 直接收事件 */
  tap: ((p: AgentStreamPayload) => void) | null = null

  /** 保留签名给调用方；下行事件走 broadcast（见 lib/windows.ts） */
  attachWindow(): void {}

  private emit(payload: AgentStreamPayload): void {
    this.tap?.(payload)
    broadcast('agent:stream', payload)
  }

  /** AbortController 不能序列化，所以留在 live 里；任务对象只承载可观测状态 */
  private taskId(sessionId: string): string {
    return `agent:${sessionId}`
  }

  /**
   * 这个会话是不是已经在流式中。`send()` 与 IPC 层都要问它——
   * 「我以为它没在跑」和「我想重来」是两回事，静默 abort 会误伤正在生成的长回答（H-10）
   */
  isStreaming(sessionId: string): boolean {
    const t = tasks.get(this.taskId(sessionId))
    return t?.status === 'running' || t?.status === 'queued'
  }

  /**
   * B4：等用户对一次 AI 写入表态。**60 秒不理默认拒**。
   *
   * 为什么必须有超时：这个 Promise 挂在 `canUseTool` 上，不 resolve 那一轮对话就永远卡着，
   * 而用户可能压根没看见弹窗（切到别的应用了 / 关了窗口）。默认拒是唯一安全的取向——
   * 超时放行等于"不看就同意"，那这道确认就白做了。
   *
   * 窗口不在（无头冒烟）时直接拒：没有人能点，等 60 秒毫无意义。
   */
  private writeWaiters = new Map<string, (d: { allow: boolean; reason?: string }) => void>()

  private askWrite(
    sessionId: string,
    info: { rel: string; tool: string; summary: string }
  ): Promise<{ allow: boolean; reason?: string }> {
    if (!hasWindow()) return Promise.resolve({ allow: false, reason: 'no-window' })
    const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    return new Promise((resolve) => {
      const done = (d: { allow: boolean; reason?: string }): void => {
        if (!this.writeWaiters.has(id)) return
        this.writeWaiters.delete(id)
        clearTimeout(timer)
        resolve(d)
      }
      const timer = setTimeout(() => done({ allow: false, reason: 'timeout' }), WRITE_CONFIRM_TIMEOUT_MS)
      this.writeWaiters.set(id, done)
      broadcast('agent:confirm-write', { id, sessionId, ...info })
    })
  }

  /** 渲染层点了允许/拒绝之后回到这里 */
  resolveWriteConfirm(id: string, allow: boolean): void {
    this.writeWaiters.get(id)?.({ allow, reason: allow ? undefined : 'denied' })
  }

  /**
   * 停止生成（H-09）：已经流出来的半截回答**落成一条 assistant 消息**再 abort。
   * 以前 abort 路径只发 done，屏幕一清那段文字就永远没了，连复制都来不及。
   */
  stop(sessionId: string): void {
    const taskId = this.taskId(sessionId)
    const t = tasks.get(taskId) as AgentTask | undefined
    const draft = t?.draft?.trim()
    if (draft) {
      // 先落消息再 abort：abort 会让 for-await 抛出、走 catch 分支发 done，
      // 渲染层收到 done 就清屏，顺序反了这段正文照样没
      this.emit({ sessionId, kind: 'assistant', text: `${draft}\n\n（已停止）`, sdkSessionId: t?.sdkSessionId })
      tasks.patch(taskId, { draft: '', toolLine: undefined } as Partial<AgentTask>)
    }
    this.stopped.add(sessionId)
    this.live.get(sessionId)?.abort.abort()
    this.live.delete(sessionId)
    tasks.patch(taskId, { title: '已停止生成' } as Partial<AgentTask>)
    tasks.finish(taskId, 'canceled')
  }

  /**
   * 这一轮算哪种任务：按**真的调过的渲染工具**判，不按用户说了什么。
   * "帮我做个 PPT" 说了但没产出的那种轮次，记成对话才是实情。
   */
  private taskTypeOf(tools: Set<string>): UsageTaskType {
    const has = (n: string): boolean => [...tools].some((t) => t.includes(n))
    if (has('render_pptx')) return 'make-ppt'
    if (has('render_document')) return 'make-docx'
    return 'chat'
  }

  /** 文件树的一级目录名，进 system prompt 的「顶层分区」 */
  private topDirs(): string[] {
    return vaultManager.tree().filter((n) => n.children).map((n) => n.name)
  }

  /**
   * 诊断口（IPC `agent:systemPrompt`）：当前库会拿到的 system prompt 原文。
   * 走查用它扫「通用库不许有 MCN 字眼」（R1），与真实发送走的是同一个函数、同一份配置。
   */
  async systemPromptForDiag(): Promise<string> {
    const root = vaultManager.currentRoot
    if (!root) return ''
    const cfg = await readVaultConfig(root)
    return buildSystemPrompt({ root, dirs: this.topDirs(), cfg, scanLimit: SCAN_LIMIT })
  }

  /**
   * 退出应用时把生成中的会话全部中止（PLAN-v2 R2 / 审计 Q4）。
   * 返回中止的个数，给 before-quit 打日志用。不落半截正文：进程马上就没了，渲染层收不到。
   */
  abortAll(reason: 'quit'): number {
    let n = 0
    for (const [sessionId, s] of this.live) {
      this.stopped.add(sessionId)
      s.abort.abort()
      const taskId = this.taskId(sessionId)
      if (tasks.get(taskId)) {
        tasks.patch(taskId, { title: '应用退出，已停止生成' } as Partial<AgentTask>)
        tasks.finish(taskId, 'canceled')
      }
      log('info', 'agent', `会话 ${sessionId} 随应用退出被中止（${reason}）`)
      n++
    }
    this.live.clear()
    return n
  }

  /**
   * 发送一轮对话；流式事件经 agent:stream 下行。
   * `tier` 是**会话级**的模型档位（标准/增强），由渲染层随每次发送带上——
   * 全局设置那套做不到"这个对话用增强、那个对话用标准"。
   */
  async send(
    sessionId: string,
    prompt: string,
    resumeSdkSessionId?: string,
    tierId: TierId = DEFAULT_TIER,
    /** 本轮附件（用户原始路径）。拷进临时目录后再把路径拼进 prompt，见 agent/attachments.ts */
    attachments: string[] = []
  ): Promise<void> {
    // H-10：同一 session 已在流式中就**拒绝**，不 abort 旧的。IPC 层已经先拦过一道并把
    // 「停止当前生成」的出口给了用户，这里是竞态兜底（拒绝之后 AbortController 覆盖问题随之消失）
    if (this.isStreaming(sessionId)) {
      log('warn', 'agent', `会话 ${sessionId} 已在生成中，拒绝重复发送`)
      return
    }
    // 任务对象在**第一个同步 tick** 就建起来：下面全是 await，任务建晚了这段窗口里
    // 第二条消息照样挤得进来，AbortController 又会被后来的覆盖（H-10 的老根因）
    const tier = normalizeTier(tierId)
    const taskId = this.taskId(sessionId)
    tasks.start({
      id: taskId,
      kind: 'agent',
      key: sessionId,
      title: 'AI 正在回答',
      cancelable: true,
      conversationId: sessionId,
      draft: '',
    })
    // 历史快照必须在这里（第一个同步 tick）拍：渲染层是「先 chat:send 再 chat:save」，
    // 晚一步读到的历史里就混进了本轮提问，重建上下文时会把它重复一遍
    const history = resumeSdkSessionId ? conversationMessages(sessionId) : []
    /**
     * 附件先落到临时目录再进 prompt。**注意拼的是 `prompt` 不是 ctx 的别处**：
     * 会话恢复重发（recover）会拿 `ctx.prompt` 重新组一遍上下文，附件说明就在里面，
     * 重发那一轮照样带得上。
     */
    const staged = await stageAttachments(sessionId, attachments)
    /**
     * 带不上的附件**必须报给用户**（B7）：格式不支持 / 文件损坏 / 超过 20MB。
     * 静默丢附件是最糟的形态——用户以为模型看过那份文件，模型其实没见过，
     * 之后的一切结论都建立在一个错误前提上（同 A-4「转换失败要说出来」那条教训）。
     */
    for (const f of staged.failed) {
      this.emit({ sessionId, kind: 'notice', text: `《${f.name}》没能带上：${f.reason}` })
    }
    /**
     * 上一轮被用户撤销掉的改动，**这一轮要明确告诉模型**——否则它上下文里still
     * 记着"我已经改好了"，用户再让它改就回「上一轮已全部替换完，无需再次操作」。
     * 取走即清：说一次就够。
     */
    const promptWithFiles = prompt + takeUndoNotice(sessionId) + attachmentNote(staged.paths, staged.names)
    await this.runTurn({
      sessionId,
      taskId,
      prompt: promptWithFiles,
      resume: resumeSdkSessionId,
      tier,
      history,
      canRecover: !!resumeSdkSessionId,
    })
  }

  /**
   * 旧 session 在 SDK 侧已经不存在了：**不报错**——放弃它，拿本地历史拼出上下文开新会话
   * 重发这条消息。本地那份始终是权威副本，SDK 侧掉了不代表内容没了（详见 resume-recovery.ts）。
   */
  private async recover(ctx: TurnCtx, reason: string): Promise<void> {
    // 用户在这个空档里点了「停止」：任务已经收成 canceled 了，别再自作主张重开一轮
    if (this.stopped.has(ctx.sessionId)) {
      log('info', 'agent', `会话 ${ctx.sessionId} 已被用户停止，不做恢复重发`)
      return
    }
    const built = buildRecoveryPrompt(ctx.history, ctx.prompt)
    log(
      'warn',
      'agent',
      `会话 ${ctx.resume} 在 SDK 侧已不存在，放弃旧会话并新开一个重发（带回历史 ` +
        `${built.kept}/${built.total} 条${built.truncated ? '，已截断' : ''}）：${reason}`
    )
    // 这一轮死在启动阶段，理论上还没有正文；仍清一次，免得半截草稿混进重开的那轮。
    // sdkSessionId 也一起抹掉：它已经被证伪了，别让它有机会再被写回对话
    tasks.patch(ctx.taskId, { draft: '', toolLine: undefined, sdkSessionId: undefined } as Partial<AgentTask>)
    if (built.truncated) {
      // 只在**真的丢了东西**时才说话。短对话能无损恢复，每次都弹一条等于制造噪音
      this.emit({
        sessionId: ctx.sessionId,
        kind: 'notice',
        text: '已开始新的会话，较早的上下文可能不被记住',
        tier: ctx.tier,
      })
    }
    return this.runTurn({ ...ctx, prompt: built.text, resume: undefined, canRecover: false, recovered: true })
  }

  private async runTurn(ctx: TurnCtx): Promise<void> {
    const { sessionId, taskId, prompt, tier } = ctx
    /** 预检不通过：这一轮压根没开始，任务直接撤掉（别在 Dock 上留一条红字） */
    const bail = (msg: string): void => {
      tasks.drop(taskId)
      this.emit({ sessionId, kind: 'error', text: msg, tier })
    }

    const root = vaultManager.currentRoot
    if (!root) return bail('请先在「个人知识库」打开一个库')
    // 档位层给出地址/模型/key：模型显式指定，绝不依赖端点的自动映射（见 ai/tiers.ts）
    // 地址或 key 缺一个都不发：文案对客户只说"找管理员"（线路是服务端下发的，用户自己填不了）
    const provider = resolveTierForRequest(tier)
    if (!provider.apiKey || !provider.baseUrl) return bail(unconfiguredReason(provider.label))

    // 这一轮真的调过哪些工具 → 决定用量记录里的任务类型（做 PPT / 做文档 / 纯对话）
    const toolsUsed = new Set<string>()
    /** 这一轮已经放行了几次文件系统扫描（见 SCAN_LIMIT） */
    let scanCalls = 0
    /**
     * B-6：这一轮**真正被摆到模型面前**的笔记路径。来源两处：
     * `search_knowledge` 返回的命中（我们自己的工具，直接记）、以及 `Read` 的入参。
     * 收尾时拿它校验回答里的每一条 `[[…]]`——引用了没看过的东西就是没有依据
     */
    const surfaced = new Set<string>()
    const noteKey = (p: string): string => p.replace(/\.md$/i, '').toLowerCase()
    const startedAt = Date.now()

    /**
     * 过程可见性的三段接力。**流式那条 tool_use 只给工具名**（入参还在一块块流），
     * 完整入参只有非流式 `assistant` 消息里才有，结果数只有 `user` 消息里的 tool_result 才有。
     * 所以一步棋分三次发，靠 stepId 串起来：
     *   content_block_start → start（步骤出现，转圈）
     *   assistant 消息      → args （补上检索词/文件名/扫描目标）
     *   user 消息 tool_result → result（回填结果数 / 失败标记）
     */
    // 步骤 id 里带上本轮的开始时刻：同一个对话连发两轮时 taskId 是同一个，
    // 只用序号的话第二轮的 #1 会和第一轮撞车（渲染层分组没事，但事件消费方会当成同一步）
    let stepSeq = 0
    /** 已经 start、还没等到入参的步骤（按出现顺序排队） */
    const awaitingArgs: Array<{ id: string; tool: string }> = []
    /** tool_use_id → 步骤，tool_result 回来时靠它找回是哪一步 */
    const stepByToolUse = new Map<string, { id: string; tool: string }>()
    const emitStep = (step: ToolStepEvent): void => {
      this.emit({ sessionId, kind: 'tool', tool: step.tool, step })
    }
    /** 扣住的错误型 result（见下面 result 分支）。子进程正常退出时由循环后面收尾 */
    let errorResult = ''

    // draft 上移主进程：切走再切回来能补齐这段时间流出的字（H-08 的对话版），
    // 也是「停止生成保留半截」（H-09）与「同一会话拒绝重复发送」（H-10）的前提
    const appendDraft = (text: string): void => {
      const t = tasks.get(taskId) as AgentTask | undefined
      if (!t) return
      // 长回答别把整坨正文塞进每次 snapshot：只留尾部，渲染层自己有完整副本
      const next = (t.draft + text).slice(-20_000)
      tasks.patch(taskId, { draft: next, toolLine: undefined } as Partial<AgentTask>, true)
    }

    const abort = new AbortController()
    this.live.set(sessionId, { abort })
    this.stopped.delete(sessionId) // 上一轮停止留下的标记，别把这一轮也掐了

    /**
     * 墙钟超时（PLAN-v2 R3）：软提醒 80% → 硬中断 100%，判据在 `agent/timeout.ts`（纯函数）。
     * 上限来自管理员区（`store.agentTimeoutMin`，0 = 关）；`MCNAI_E2E_AGENT_TIMEOUT` 只给走查造超时。
     *
     * **中断的顺序不能反**（同 H-09 停止生成）：先把已流出的半截正文落成带「（已超时中断）」的
     * assistant 消息 → 再 abort → 最后由 catch/循环出口发 `kind:'error'`。反过来渲染层收到 done 就清屏。
     * 超时是 **failed 不是 canceled**：用户没动手，是系统替他停的，Dock 上要红出来。
     */
    let timedOut: string | null = null
    let warned = false
    const limitMs = resolveTimeoutMs(store.get('agentTimeoutMin'), process.env.MCNAI_E2E_AGENT_TIMEOUT)
    const ticker = setInterval(() => {
      if (timedOut || abort.signal.aborted) return
      const v = judgeTimeout(startedAt, Date.now(), limitMs, warned)
      if (v.kind === 'warn') {
        warned = true
        this.emit({ sessionId, kind: 'notice', text: v.message, tier })
        return
      }
      if (v.kind !== 'abort') return
      timedOut = v.message
      log('warn', 'agent', `会话 ${sessionId} 超过墙钟上限 ${limitMs}ms，中断：${v.message}`)
      const t = tasks.get(taskId) as AgentTask | undefined
      const draft = t?.draft?.trim()
      if (draft) {
        this.emit({ sessionId, kind: 'assistant', text: `${draft}\n\n（已超时中断）`, sdkSessionId: t?.sdkSessionId })
        tasks.patch(taskId, { draft: '', toolLine: undefined } as Partial<AgentTask>)
      }
      abort.abort()
    }, 500)
    ticker.unref?.()
    /** 超时收尾：任务 failed + 错误气泡（带「重试」）。循环出口与 catch 两条路都可能到这里，只做一次 */
    const settleTimeout = (): void => {
      tasks.patch(taskId, { title: 'AI 回答超时中断' } as Partial<AgentTask>)
      tasks.finish(taskId, 'failed', timedOut ?? '超时')
      this.emit({ sessionId, kind: 'error', text: timedOut ?? '超时', tier })
    }

    try {
      const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')

      // 产物目录名吃 layout.json（R6）：以前写死 `90_产物`，库里改了名 AI 就写到旧目录、产物面板盯着新目录一片空白
      const cfg = await readVaultConfig(root)
      const artifactsDir = join(root, cfg.artifacts)
      await fs.mkdir(artifactsDir, { recursive: true })

      const knowledge = createSdkMcpServer({
        name: 'knowledge',
        version: '1.0.0',
        tools: [
          tool(
            'search_knowledge',
            '检索用户本地知识库的全文（标题/正文/标签），返回命中笔记的**相对路径**与片段——拿到路径就能直接 Read',
            { query: z.string().describe('检索词，中文') },
            async ({ query: q }) => {
              /**
               * **第一版：本地优先**（2026-08-19 裁决，开关见 `store.ts` 的 `searchBackend`）。
               *
               * 云端三层语义检索能力更强，但 `match_knowledge_chunks` 的 returns table
               * 里没有 `file_path`（列早就有、切片一直在写，只是 RPC 没 select 出来），
               * 模型只拿得到正文片段 → 猜路径 → Read 失败 → 再 Grep 找。
               * 本地这一支给的是 `[[标题]] (相对路径)`，模型可以直接 Read。
               *
               * **云端代码一行不删**：把 config 里的 `searchBackend` 改成 `'cloud'` 就切回去，
               * 上云与 embedding 照常在跑，切回来即刻有完整数据可查。
               */
              const cloud = store.get('searchBackend') === 'cloud' ? await searchCloud(q) : null
              if (cloud && cloud.length) {
                const LAYER: Record<string, string> = { platform: '平台', org: '公司', private: '我的' }
                const text = cloud
                  .map((m, i) => `${i + 1}. [${LAYER[m.visibility ?? 'org'] ?? m.visibility}] (${m.source_type}, 相关度${m.similarity.toFixed(2)})\n   ${m.content.slice(0, 200)}`)
                  .join('\n')
                return { content: [{ type: 'text', text }] }
              }
              const { hits, fuzzy } = await vaultManager.search(q)
              for (const h of hits) surfaced.add(noteKey(h.path))
              if (!hits.length) return { content: [{ type: 'text', text: '（无命中）' }] }
              const list = hits
                .slice(0, 6)
                .map((h, i) => `${i + 1}. [[${h.title}]] (${h.path})\n   ${h.snippet}`)
                .join('\n')
              // 模糊那一遍的结果必须**说出来**：模型分不清「精确命中」和「相近结果」时，
              // 会把相近的当成答案讲出去——陷阱题就是这么从假阴性变成假阳性的
              const text = fuzzy
                ? `（精确检索无命中，以下是**相近结果**，可能与问题无关；不要据此断定库里有这份资料）\n${list}`
                : list
              return { content: [{ type: 'text', text }] }
            }
          ),
          tool(
            'render_pptx',
            `把 outline JSON 渲染成 PPT 文件，写入 ${cfg.artifacts}/，返回文件路径`,
            {
              outline_json: z.string().describe('完整 outline JSON 字符串'),
              filename: z.string().describe('文件名（不含扩展名），中文可'),
            },
            async ({ outline_json, filename }) => {
              const safe = filename.replace(/[\\/:*?"<>|]/g, '').trim() || 'ppt'
              const day = new Date().toISOString().slice(0, 10)
              const outDir = join(artifactsDir, `${day}_${safe}`)
              await fs.mkdir(outDir, { recursive: true })
              const specPath = join(tmpdir(), `mcnai-spec-${Date.now()}.json`)
              await fs.writeFile(specPath, withVault(outline_json, root), 'utf-8')
              const outPath = join(outDir, `${safe}.pptx`)
              const result = await new Promise<string>((resolve) => {
                const child = spawn(pipelineBin(), ['render-pptx', specPath, outPath])
                let out = ''
                child.stdout.on('data', (d: Buffer) => (out += d.toString()))
                child.stderr.on('data', (d: Buffer) => (out += d.toString()))
                child.on('close', (code) => resolve(code === 0 ? `已生成 ${outPath}` : `渲染失败: ${out.slice(-500)}`))
                child.on('error', (e) => resolve(`渲染进程启动失败: ${e}`))
              })
              return { content: [{ type: 'text', text: result }] }
            }
          ),
          tool(
            'render_document',
            `把 spec JSON 渲染成 Word(docx)/Excel(xlsx)/PDF 文件，写入 ${cfg.artifacts}/，返回文件路径`,
            {
              format: z.enum(['docx', 'xlsx', 'pdf']).describe('输出格式'),
              spec_json: z.string().describe('spec JSON 字符串（docx/pdf 用 doc 结构，xlsx 用 sheets 结构）'),
              filename: z.string().describe('文件名（不含扩展名），中文可'),
            },
            async ({ format, spec_json, filename }) => {
              const safe = filename.replace(/[\\/:*?"<>|]/g, '').trim() || 'doc'
              const day = new Date().toISOString().slice(0, 10)
              const outDir = join(artifactsDir, `${day}_${safe}`)
              await fs.mkdir(outDir, { recursive: true })
              const specPath = join(tmpdir(), `mcnai-doc-${Date.now()}.json`)
              await fs.writeFile(specPath, withVault(spec_json, root), 'utf-8')
              const outPath = join(outDir, `${safe}.${format}`)
              const result = await new Promise<string>((resolve) => {
                const child = spawn(pipelineBin(), [`render-${format}`, specPath, outPath])
                let out = ''
                child.stdout.on('data', (d: Buffer) => (out += d.toString()))
                child.stderr.on('data', (d: Buffer) => (out += d.toString()))
                child.on('close', (code) => resolve(code === 0 ? `已生成 ${outPath}` : `渲染失败: ${out.slice(-500)}`))
                child.on('error', (e) => resolve(`渲染进程启动失败: ${e}`))
              })
              return { content: [{ type: 'text', text: result }] }
            }
          ),
        ],
      })

      const q = query({
        prompt,
        options: {
          abortController: abort,
          cwd: root,
          resume: ctx.resume,
          model: provider.model,
          systemPrompt: buildSystemPrompt({ root, dirs: this.topDirs(), cfg, scanLimit: SCAN_LIMIT }),
          allowedTools: [
            'Read', 'Grep', 'Glob',
            'mcp__knowledge__search_knowledge',
            'mcp__knowledge__render_pptx',
            'mcp__knowledge__render_document',
          ],
          /**
           * 扫描次数闸门（SCAN_LIMIT）**必须挂在 PreToolUse 上，不能挂 canUseTool**。
           *
           * 第一版就是挂 canUseTool 的，为此把 Grep/Glob 移出了 `allowedTools`
           * ——`allowedTools` 的语义是"免提示自动放行"，预授权的工具压根不走 canUseTool。
           * 结果适得其反（2026-08-18 实测）：模型不再用 Grep/Glob，改用 **Bash 调 grep**，
           * 而 Bash 从来没开放过 → 连撞 9 次拒绝 → **174 秒**，比不管还慢。
           * PreToolUse 对预授权工具照样触发，所以 Grep/Glob 可以留在 allowedTools 里
           * （用起来无摩擦），闸门另挂一层。
           */
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input: unknown) => {
                    const name = (input as { tool_name?: string }).tool_name
                    if (name !== 'Grep' && name !== 'Glob') return {}
                    if (scanCalls >= SCAN_LIMIT) {
                      log('warn', 'agent', `文件查找已达上限 ${SCAN_LIMIT} 次，拒绝本次 ${name}`)
                      return {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse' as const,
                          permissionDecision: 'deny' as const,
                          permissionDecisionReason:
                            `文件查找次数已达上限（${SCAN_LIMIT} 次）。不要再找了，也不要改用命令行——` +
                            `请基于已经检索到、已经读过的材料直接作答；没有依据的部分就说明没有，不要硬凑。`,
                        },
                      }
                    }
                    scanCalls++
                    return {}
                  },
                ],
              },
            ],
          },
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            /**
             * 写知识库：**从"一律拒"改成"确认后放行"**（2026-08-19，B4）。
             *
             * 老规则是只放行 `90_产物/`，于是用户让 AI 改自己的笔记，AI 只能回
             * 「环境限制文件写入」——对客户来说这就是产品残疾。防乱改是对的，
             * 但正确实现是**可以改、要点头、能撤销**，判定逻辑在 `write-guard.ts`。
             */
            if (toolName === 'Write' || toolName === 'Edit') {
              const verdict = judgeWrite(String(input.file_path ?? ''), vaultManager.currentRoot, artifactsDir)
              if (verdict.kind === 'allow-artifact') {
                return { behavior: 'allow' as const, updatedInput: input }
              }
              if (verdict.kind === 'deny') {
                return { behavior: 'deny' as const, message: verdict.reason }
              }
              // ask：问用户。**60 秒不理默认拒**——一轮对话不能无限期挂在一个弹窗上
              const root = vaultManager.currentRoot!
              const decision = await this.askWrite(sessionId, {
                rel: verdict.rel,
                tool: toolName,
                summary: summarizeWrite(toolName, input),
              })
              if (!decision.allow) {
                return {
                  behavior: 'deny' as const,
                  message:
                    decision.reason === 'timeout'
                      ? '用户没有在 60 秒内确认这次修改，已取消。可以把改动内容直接说给用户，让他自己改'
                      : '用户拒绝了这次修改。别再试同一个文件，可以把建议的改法说出来让他自己决定',
                }
              }
              // 放行前先备份原文，撤销出口挂在 toast 上
              const backupId = await backupBeforeWrite(sessionId, root, verdict.rel)
              this.emit({
                sessionId,
                kind: 'notice',
                text: `AI 修改了《${verdict.rel}》`,
                writeUndoId: backupId,
                writeRel: verdict.rel,
              })
              return { behavior: 'allow' as const, updatedInput: input }
            }
            // **拒绝要指路**：只说"未开放"的话模型会一直换姿势重试同一件事——
            // 实测它被挡在 Grep 外面后改用 Bash 调 grep，连撞 9 次、烧掉 174 秒
            return {
              behavior: 'deny' as const,
              message:
                `工具 ${toolName} 未开放，别再试它了。查资料只有这几条路：` +
                `search_knowledge 检索、Grep 找内容、Glob 找文件名、Read 读全文；命令行是关着的。`,
            }
          },
          mcpServers: { knowledge },
          // 30 轮做 PPT 偶尔不够（deepseek-v4-pro 爱反复检索，实测 4 轮冒烟里挂过 1 次
          // 「Reached maximum number of turns」，产物直接没生成）。提到 40 留余量，
          // 另配系统提示词第 7 条「检索最多 3 次」压住反复检索——两手一起才不容易再撞
          maxTurns: 40,
          includePartialMessages: true,
          pathToClaudeCodeExecutable: claudeCliBin(),
          executable: process.execPath as never,
          env: agentEnv({
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.model,
            fastModel: provider.fastModel,
          }),
        },
      })

      for await (const message of q) {
        // abort 传播需要时间，SDK 往往还会再吐一条 result 出来。半截回答此刻已经带着
        // 「（已停止）」落进对话了，再补一条完整答案等于根本没停成（H-09）
        if (this.stopped.has(sessionId) || timedOut) break
        if (message.type === 'system' && message.subtype === 'init') {
          const tools = (message as { tools?: string[] }).tools ?? []
          console.log(
            `[agent] provider=${provider.id} model=${provider.model} 可用工具:`,
            tools.filter((t) => t.includes('knowledge')).join(', ') || tools.length
          )
          continue
        }
        if (message.type === 'stream_event') {
          const ev = message.event as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; name?: string } }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            appendDraft(ev.delta.text)
            this.emit({ sessionId, kind: 'delta', text: ev.delta.text })
          } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            const name = ev.content_block.name
            if (name) toolsUsed.add(name)
            tasks.patch(taskId, { toolLine: name } as Partial<AgentTask>)
            const tool = shortToolName(name ?? '')
            if (isStepWorthy(tool)) {
              const id = `${taskId}#${startedAt}.${++stepSeq}`
              awaitingArgs.push({ id, tool })
              emitStep({ id, tool, phase: 'start' })
            }
          }
          continue
        }
        // tool_result 回来了：回填这一步的结果数（"核对了 N 份…"、"检索到 N 条"）。
        // 数不出来就不带 count——渲染层据此只显示"已核对"，不编一个数字出来
        if (message.type === 'user') {
          const blocks = (message as { message?: { content?: unknown[] } }).message?.content ?? []
          for (const b of blocks as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
            if (b?.type !== 'tool_result') continue
            const st = stepByToolUse.get(String(b.tool_use_id ?? ''))
            if (!st) continue
            const resultText = toolResultText(b.content)
            const counted = countToolResults(st.tool, resultText)
            // 被自家护栏拦下的那一步：不算失败，单独标出来（见 SCAN_LIMIT）
            const capped = resultText.includes(SCAN_CAP_MARK)
            emitStep({
              id: st.id,
              tool: st.tool,
              phase: 'result',
              count: capped ? undefined : counted?.count,
              unit: capped ? undefined : counted?.unit,
              approx: capped ? undefined : counted?.approx,
              failed: !capped && b.is_error === true,
              capped: capped || undefined,
            })
          }
          continue
        }
        // 非流式的 assistant 消息带着 tool_use 的**完整入参**——流式那条只给工具名。
        // Read 读了哪个文件只能从这里拿到（B-6 的第二个来源）
        if (message.type === 'assistant') {
          const blocks = (message as { message?: { content?: unknown[] } }).message?.content ?? []
          for (const b of blocks as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
            if (b?.type !== 'tool_use') continue
            const fp = b.input?.file_path ?? b.input?.path
            if (typeof fp === 'string' && fp) {
              surfaced.add(noteKey(fp.startsWith(root) ? fp.slice(root.length).replace(/^\/+/, '') : fp))
            }
            // 认领流式那边先开好的步骤：**按工具名配对**，不是无脑 shift()。
            // 名字对不上说明两条路错位了（模型违反"每轮一个工具"时会出现），
            // 那就现开一步，宁可多一条步骤，也不要把检索词安到阅读步骤上
            const tool = shortToolName(b.name ?? '')
            if (!isStepWorthy(tool)) continue
            const i = awaitingArgs.findIndex((s) => s.tool === tool)
            const st = i >= 0 ? awaitingArgs.splice(i, 1)[0] : { id: `${taskId}#${startedAt}.${++stepSeq}`, tool }
            if (i < 0) emitStep({ id: st.id, tool, phase: 'start' })
            if (b.id) stepByToolUse.set(b.id, st)
            emitStep({ id: st.id, tool, phase: 'args', args: pickStepArgs(tool, b.input, root) })
          }
          continue
        }
        if (message.type === 'result') {
          // 错误型 result（`error_during_execution` 等）**先扣住不发**。
          // 它有可能是「这个 session 已经不存在了」的讣告，那样的话这一轮马上会重开、
          // 这条讣告不该落进对话。旧代码把它当正常回答画成「出错：error_during_execution」，
          // 于是一次会话恢复失败在界面上留下两条报错——第一条就是它。
          // 真的要展示时走 `kind:'error'`（过 zhError + 气泡里有「重试」），不再当成 AI 说的话。
          if (message.subtype !== 'success') {
            const errs = ((message as { errors?: string[] }).errors ?? []).map((e) => e.trim()).filter(Boolean)
            errorResult = errs.join('; ') || `出错：${message.subtype}`
            continue
          }
          const res = message as { is_error?: boolean; api_error_status?: number | null }
          /**
           * T-02：**`subtype:'success'` 但 `is_error:true`** —— 上游 401 / 403 / 额度不足
           * 这类失败长的就是这个样子，`result` 字段里装的是**英文原文**
           * （`Failed to authenticate. API Error: 401 …`）。旧代码把它当正常回答画进对话，
           * 紧接着 for-await 又抛出、再落一条 ⚠️：同一次失败说两遍，第一条还是纯英文
           * （截图 41c/41d/45d 里看得很清楚）。现在与 `subtype !== 'success'` 同等对待——
           * 扣住不发，最终走 `kind:'error'`（过 zhError 出中文 + 气泡里有「重试」），
           * **英文原文只进日志**。
           *
           * 判据**只认 `is_error`，不认 `api_error_status`**：后者在记账那边的语义是
           * "存疑就别计费"（宁可少记一条，代价为零），搬到显示上却会把一条**真回答**
           * 判成错误、连正文一起丢掉——两边的容错方向正好相反，不能图省事合成一个条件。
           */
          if (res.is_error) {
            const raw = (message.result ?? '').trim()
            log('error', 'agent', `上游返回错误结果（原文只进日志，界面走中文映射）：${raw.slice(0, 500)}`)
            errorResult = raw || '出错：上游返回了一个错误结果'
            continue
          }
          const text = message.result
          // 服务端实际用的模型：对不上就是被端点静默换掉了（诊断日志留一行 + 记进用量）
          const modelUsage = (message as { modelUsage?: Record<string, unknown> }).modelUsage ?? {}
          const models = Object.keys(modelUsage)
          const degraded = models.length > 0 && !models.includes(provider.model)
          /**
           * 「这一轮实际是谁服务的」= 主模型在不在里面。
           * 不能直接取 `models[0]`：一轮里往往同时出现主模型与轻量模型（起标题、压上下文），
           * key 的顺序是服务端给的，实测标准档那一轮排在前面的是 flash——记成 flash 就等于
           * 报告"我要 pro，实际用了 flash"，看着像被降级了，其实 pro 就在同一个 modelUsage 里
           * （2026-08-17 真实调用对账时抓到）。被真降级时 models 里没有主模型，这里自然落到实际那个。
           */
          const resolved = models.includes(provider.model) ? provider.model : (models[0] ?? null)
          if (degraded) {
            log('warn', 'agent', `模型被服务端替换：要的是 ${provider.model}，实际 ${models.join('/')}`)
          }
          const costUsd = 'total_cost_usd' in message ? message.total_cost_usd : undefined
          // 用量记账：**只记跑成功的那一轮**。失败的轮次（鉴权失败、线路挂了）token 通常是 0，
          // 记进去只会让「本月对话 N 次」把失败也算成用量——用户看这个数是为了估消耗，不是查故障。
          // 失败在 Dock 与诊断日志里各有出口，不靠这里。**不挑字段、原样存**，归一化留给汇总侧。
          //
          // **`subtype === 'success'` 一条守不住**（B-2 补丁，2026-08-18）：SDK 的
          // `SDKResultSuccess` 自带 `is_error` 与 `api_error_status` 字段——上游报 403 时它照样
          // 发 `subtype: 'success'`，只是 `is_error: true`、token 全 0。实测中转站余额耗尽那轮，
          // 8 个失败请求全被记进了 jsonl。所以还要看 `is_error`，并且要求这一轮真的产生过 token。
          // （T-02 之后 `is_error` 在这里恒为 false——上面已经把它挡掉了。条件保留不删：
          //  这是记账自己的判据，不该依赖上游某个分支的存在顺序。）
          const hasTokens = tokensOf({ usage: (message as { usage?: unknown }).usage, modelUsage }).output > 0
          if (message.subtype === 'success' && !res.is_error && !res.api_error_status && hasTokens) {
            appendUsage({
              ts: Date.now(),
              sessionId,
              taskType: this.taskTypeOf(toolsUsed),
              tier,
              route: routeOf(provider.baseUrl),
              expected_model: provider.model,
              resolved_model: resolved,
              models,
              degraded,
              durationMs: Date.now() - startedAt,
              usage: {
                usage: (message as { usage?: unknown }).usage ?? null,
                modelUsage: models.length ? modelUsage : null,
              },
              costUsd: costUsd ?? null,
            })
          }
          // B-6：校验回答里的每一条 `[[…]]`。两种没有依据的情况都算：
          //   ① 库里根本没有这篇  ② 库里有，但这一轮从没被检索到也没被读过
          // **只报不改**：不自动删引用——模型有可能是从 MOC 的列表里看到的标题，
          // 误删会把对的也删掉；把可疑的指出来，让人自己判断
          const cited = [...new Set([...text.matchAll(/\[\[([^\]\[]+?)\]\]/g)].map((m) => m[1].split('|')[0].split('#')[0].trim()))]
          const unverified = cited.filter((c) => {
            const resolved = vaultManager.resolveLink(c)
            return !resolved || !surfaced.has(noteKey(resolved))
          })
          if (unverified.length) {
            log('warn', 'agent', `回答引用了没有依据的笔记：${unverified.join('、')}（本轮看过 ${surfaced.size} 篇）`)
          }
          /**
           * **失败的轮次不许留下 sdkSessionId**（2026-08-18）。
           * 这个 id 会被渲染层落盘、被后面每一次发送拿去 resume。首轮就失败时（403 余额、
           * 线路挂了）那个 session 很可能压根没在 CLI 侧落过盘，于是这个对话此后**每次**
           * 发消息都必然报「No conversation found」——一个失败的轮次把整个对话废掉了。
           * 上面的降级重开能兜住表现，但病根在这里：只认跑成功那一轮给出的 id。
           */
          const usable = !res.is_error && !res.api_error_status ? message.session_id : undefined
          // 正文已经作为一条完整消息落进对话，草稿使命结束
          tasks.patch(taskId, { draft: '', toolLine: undefined, sdkSessionId: usable } as Partial<AgentTask>)
          this.emit({
            sessionId,
            kind: 'assistant',
            unverifiedCitations: unverified.length ? unverified : undefined,
            text,
            sdkSessionId: usable,
            costUsd,
            models,
            // Q15：只在真被换掉时才带上，别给每一轮都挂一个 false
            degraded: degraded || undefined,
            tier,
            recovered: ctx.recovered,
          })
        }
      }
      // 扣住的错误型 result：到这里还没抛异常，说明子进程正常退出了，该由这里收尾。
      // 是「会话已不存在」就转降级重开，不当错误报出去
      if (timedOut) return settleTimeout()
      if (errorResult) {
        if (ctx.canRecover && isResumeLost(errorResult)) return await this.recover(ctx, errorResult)
        tasks.patch(taskId, { title: 'AI 回答出错' } as Partial<AgentTask>)
        tasks.finish(taskId, 'failed', errorResult)
        this.emit({ sessionId, kind: 'error', text: errorResult, tier })
        return
      }
      tasks.finish(taskId, 'succeeded')
      this.emit({ sessionId, kind: 'done', recovered: ctx.recovered })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      if (timedOut) {
        settleTimeout()
      } else if (abort.signal.aborted) {
        tasks.finish(taskId, 'canceled')
        this.emit({ sessionId, kind: 'done' })
      } else if (ctx.canRecover && isResumeLost(raw)) {
        // 常走的就是这条：CLI 以非零码退出，SDK 把退出错误换成
        // `Claude Code returned an error result: No conversation found with session ID: …` 抛出来
        return await this.recover(ctx, raw)
      } else {
        log('error', 'agent', err instanceof Error ? err : String(err))
        tasks.patch(taskId, { title: 'AI 回答出错' } as Partial<AgentTask>)
        tasks.finish(taskId, 'failed', raw)
        // 增强档失败时把"还有一条路可走"说出来：光报错等于把用户堵在原地（同 §5.3 的原则）
        const hint = tier === 'enhanced' ? '（增强模式线路异常，可切换到标准模式重试）' : ''
        this.emit({ sessionId, kind: 'error', text: `${String(err)}${hint}`, tier })
      }
    } finally {
      clearInterval(ticker)
      this.live.delete(sessionId)
      this.stopped.delete(sessionId)
    }
  }
}

export const agentManager = new AgentManager()

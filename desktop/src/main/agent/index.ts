import { spawn } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { agentEnv } from '../ai/provider'
import { resolveTierForRequest, normalizeTier, DEFAULT_TIER, type TierId } from '../ai/tiers'
import { appendUsage, tokensOf, type UsageTaskType } from '../usage'
import { routeOf } from '../usage/pricing'
import { vaultManager } from '../vault'
import { searchCloud } from '../knowledge/client'
import { pipelineBin } from '../lib/pipeline'
import { log } from '../lib/logger'
import { tasks } from '../tasks/registry'
import { attachmentNote, stageAttachments } from './attachments'
import type { AgentTask } from '../tasks/types'
import { conversationMessages, type ChatMessage } from './conversations'
import { buildRecoveryPrompt, isResumeLost } from './resume-recovery'
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

/** PPT 版式速查（源自 render_pptx.py 的设计系统，注入系统提示词） */
const PPT_GUIDE = `render_pptx 的 outline JSON 格式：
{"title":"标题","subtitle":"副标题","slides":[
 {"title":"页标题","bullets":["要点",{"pre":"铺垫：","hl":"重点"}]},
 {"title":"章节","section":true,"num":"一","quote":"章节金句"},
 {"type":"vs","title":"对比","left":{"label":"错误","lines":["…"]},"right":{"label":"正确","lines":["…"]}},
 {"type":"quote","title":"小标","text":"大字金句","sub":"补充"},
 {"type":"checklist","title":"清单","items":["条目"]},
 {"type":"bars","title":"数据","items":[{"label":"A","value":100}]},
 {"type":"steps","title":"流程","items":["步骤"],"footer":"金句"},
 {"type":"matrix","title":"矩阵","items":["项"],"highlight":[0],"cols":4},
 {"type":"timeline","title":"轴","nodes":[{"time":"0天","label":"阶段","status":"状态"}]},
 {"type":"bignum","title":"看板","cards":[{"num":"¥199","label":"名","lines":["说明"],"style":"accent"}]},
 {"type":"image","title":"配图页","images":["/绝对路径/图.png"],"caption":"图注"},
 {"type":"chart","chart":"bar|line|pie","title":"数据图","categories":["1月","2月"],"series":[{"name":"系列名","values":[100,200]}]}]}
版式选择：对比→vs；观点→quote；行动项→checklist；流程→steps；多选一→matrix；阶段→timeline；价格→bignum。
整份至少混用 3 种版式，同一版式禁止连续超过 2 页，禁止全篇 bullets；内容必须来自检索到的库内资料，不得编造。

**图（image 版式）**：两个来源都能用——① 用户本轮附件（路径在【本轮附件】里，原样填）；
② 库内笔记里的嵌图（正文里形如 \`![](_assets/…/img01.png)\` 的引用，把它换算成绝对路径填进来）。
一页最多 4 张。没有图就别用这个版式，不要编路径。

**数据用 chart 不用 bars**：只要数字来自库内表格（GMV、场次、占比、月度趋势…），
一律用 \`chart\`——它生成的是真的 PPT 图表对象，能点开改数据。\`bars\` 只用于没有真实数据的
观感对比（比如"你以为 100 / 实际 50"）。categories 与每个 series 的 values 必须等长。

render_document 的 spec JSON（Word/PDF 用 doc 结构，Excel 用 sheets 结构）：
doc:  {"title":"标题","subtitle":"副标题","sections":[{"heading":"小节","paragraphs":["段落"],"bullets":["要点"],"images":["/绝对路径/图.png"],"table":{"headers":["列"],"rows":[["值"]]}}]}
xlsx: {"title":"名","sheets":[{"name":"表名","headers":["列1"],"rows":[["值"]],"widths":[16]}]}`

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
  private win: BrowserWindow | null = null
  private live = new Map<string, LiveSession>()
  /** 已被用户停掉、但 abort 还没传播到位的会话（见 stop 与消息循环开头的注释） */
  private stopped = new Set<string>()
  /** 测试观察口：无头冒烟不经 IPC 直接收事件 */
  tap: ((p: AgentStreamPayload) => void) | null = null

  attachWindow(win: BrowserWindow): void {
    this.win = win
  }

  private emit(payload: AgentStreamPayload): void {
    this.tap?.(payload)
    this.win?.webContents.send('agent:stream', payload)
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

  private buildSystemPrompt(): string {
    const root = vaultManager.currentRoot
    const tree = vaultManager.tree()
    const dirs = tree.filter((n) => n.children).map((n) => n.name).join('、')
    return `你是 SamePage——MCN 公司与带货达人的 AI 工作台，工作语言中文。
用户的个人知识库在 ${root ?? '(未打开)'}，顶层分区：${dirs || '(空库)'}。

规则：
1. 回答任何与用户业务/资料相关的问题前，必须先用 search_knowledge 检索库；回答中的每个关键结论句末标注来源，格式 [[笔记名]]。不许编造。
1b. **只许引用你这一轮真正看过的文件**：检索命中并读过、或用 Read 打开过的。没读过就别标它的名字——哪怕你觉得内容对得上。结论出自哪一篇就标哪一篇，不要把 A 的内容标成 B 的来源。检索结果里只看到标题没看到内容的，要么先 Read 再引，要么不引。
2. **检索词写成 2-4 个空格分开的短关键词，不要把整句话丢进去**。检索器是关键词匹配，整句查询（如「公司今年的年度目标是什么」）会因为夹带虚词而命中不到；正确写法是「年度目标」或「年度目标 进展」。空结果时**换更短的词**再试，不要换同义词反复兜圈子。
3. **顺序不能反：任何与库内资料相关的问题，第一个动作必须是 search_knowledge**，不许一上来就 Grep/Glob/Read 扫文件系统。
3b. **检索有命中就先把命中用足**：该 Read 就 Read，把读到的内容榨干；读完仍然不够，再按规则 4 去找。命中的内容里通常已经有答案，或者有能直接用的线索（确切的笔记名）。
4. **找东西只有这三个工具：Grep（找内容）、Glob（找文件名）、Read（读全文）。命令行是关着的，别用 Bash 去 grep/find/ls——那条路一定被拒。**
   用它们的时机有两种：① 检索没命中，要确认"库里真的没有"（检索返回空 ≠ 库里没有）；② 已经拿到明确线索——确切的文件名、确切的目录，或用户问题里出现的专名（人名/产品名/项目名）。
   **别猜**：不要拿检索结果里的内部字段名（my_script、source_type 这类）当关键词，不要猜目录路径，不要把同一个意思换几种写法反复试。**一次 0 命中说明线索不对——该换的是思路，不是再猜一个路径。**
   用户问题里的专名（比如达人名、产品名）就是最好的关键词，一次 Grep 通常就够。
5. 用户要"做成PPT/课件"时：先检索资料，再构造 outline JSON 调 render_pptx 工具；要 Word/Excel/PDF 时：先检索资料，构造 spec JSON 调 render_document 工具（format 选 docx/xlsx/pdf）。用户要求生成文件时必须真的调用渲染工具产出文件，不许只在回答里给内容。${PPT_GUIDE}
6. 写文件只允许写入 90_产物/ 目录。用户指名要 PPT/Word/Excel/PDF 时，必须调用对应渲染工具（render_pptx / render_document）产出该格式的文件，禁止用 Write 写 markdown 代替。
7. 回答简洁直接，重要结论在前。
8. 重要：每轮只调用一个工具，严禁在同一轮里并行调用多个工具（网关不支持并行 tool_use，会直接报错）。需要多次检索就分多轮串行进行。
9. 检索够用即止：同一个任务里 search_knowledge 最多调 3 次。素材够写就立刻动手产出（该调 render_pptx / render_document 就调），不要为了"再全一点"反复检索——轮次是有上限的，耗光了文件就产不出来。三次检索仍无命中就转规则 4 的 Grep/Glob 兜底，别继续换词再搜。
9b. **文件查找（Grep/Glob）一轮最多 ${SCAN_LIMIT} 次，系统强制**，超了直接拒。所以每一次都要花在有线索的地方；额度用完就**拿已有材料作答**，没有依据的部分直说没有，不要硬凑，更不要改用别的工具绕过去。
10. **回答里不许出现你的工作机制**：工具名、子代理、任务编排、"我调用了…"、"子代理卡住了"这类内容一律不写。用户要的是结论与来源，不是过程日志。遇到障碍就说人话，不要暴露内部实现。（用人话提一句"检索了资料库""查阅了档案"是可以的，不算暴露机制。）
10b. **一旦说到检索过程，就必须与事实一致**。用户是**一边看界面上的过程步骤、一边读你的正文**的，两边对不上，在他眼里就是产品自己打自己。
   - 检索**有结果、但你判断不相关**时，**不许说成"无结果／无命中／没找到"**。要说与事实相符的话，例如「检索到的内容与问题不直接相关，我改为直接查阅相关档案」。
   - 凡是界面会展示的客观事实——**命中条数、文件名**——正文里的转述不得与它矛盾。拿不准就别提数字，只说做了什么。
   - 检索返回的是「相近结果」而你最终判定库里没有时，**用一句话交代这些相近结果的去向**（例如「检索到的相近内容与霍格沃茨无关」）。界面上明明写着"相近结果 6 条"，正文却只字不提，用户会以为你漏看了。
11. **敏感信息只用不说**：人事档案、财务表、达人信息表这类文件**可以读、可以作为结论依据、可以标注来源**，但**回答里不许复述个人字段**——身份证号、银行卡/收款账户、手机号等联系方式、员工与达人的真实姓名，一律不写进回答。提到人一律用**艺名**（达人）或**姓氏+职务**（员工，如"陈经理""李主管"）。用户明确要求看某个具体字段时，告诉他在哪个文件里自己打开看，不要代为复述。`
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
    const promptWithFiles = prompt + attachmentNote(staged)
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
    const provider = resolveTierForRequest(tier)
    if (!provider.apiKey) return bail(`「${provider.label}」线路还没配置密钥，请联系管理员`)
    if (!provider.baseUrl) return bail(`「${provider.label}」线路还没配置地址，请联系管理员`)

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

    try {
      const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')

      const artifactsDir = join(root, '90_产物')
      await fs.mkdir(artifactsDir, { recursive: true })

      const knowledge = createSdkMcpServer({
        name: 'knowledge',
        version: '1.0.0',
        tools: [
          tool(
            'search_knowledge',
            '检索用户的个人知识库（标题/正文/标签），返回最相关的笔记路径与片段',
            { query: z.string().describe('检索词，中文') },
            async ({ query: q }) => {
              // 登录后走云端三层检索（平台爆款/公司共享/个人层，带语义与加权）；未登录回退本地全文
              const cloud = await searchCloud(q)
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
            '把 outline JSON 渲染成 PPT 文件，写入 90_产物/，返回文件路径',
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
            '把 spec JSON 渲染成 Word(docx)/Excel(xlsx)/PDF 文件，写入 90_产物/，返回文件路径',
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
          systemPrompt: this.buildSystemPrompt(),
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
            // Write 只放行 90_产物；其余未预授权工具一律拒绝
            if (toolName === 'Write' || toolName === 'Edit') {
              const p = String(input.file_path ?? '')
              if (p.startsWith(artifactsDir) || p.startsWith('90_产物')) {
                return { behavior: 'allow' as const, updatedInput: input }
              }
              return { behavior: 'deny' as const, message: '只允许写入 90_产物/ 目录' }
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
        if (this.stopped.has(sessionId)) break
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
            tier,
            recovered: ctx.recovered,
          })
        }
      }
      // 扣住的错误型 result：到这里还没抛异常，说明子进程正常退出了，该由这里收尾。
      // 是「会话已不存在」就转降级重开，不当错误报出去
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
      if (abort.signal.aborted) {
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
      this.live.delete(sessionId)
      this.stopped.delete(sessionId)
    }
  }
}

export const agentManager = new AgentManager()

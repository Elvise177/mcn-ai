import { spawn } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { agentEnv } from '../ai/provider'
import { resolveTierForRequest, normalizeTier, DEFAULT_TIER, type TierId } from '../ai/tiers'
import { appendUsage, type UsageTaskType } from '../usage'
import { vaultManager } from '../vault'
import { searchCloud } from '../knowledge/client'
import { pipelineBin } from '../lib/pipeline'
import { log } from '../lib/logger'
import { tasks } from '../tasks/registry'
import type { AgentTask } from '../tasks/types'

export interface AgentStreamPayload {
  sessionId: string
  kind: 'delta' | 'tool' | 'assistant' | 'done' | 'error'
  text?: string
  tool?: string
  sdkSessionId?: string
  costUsd?: number
  /** 实际服务这轮的模型名（来自 result.modelUsage）。
      DeepSeek 官方端点遇到不认识的模型名会静默降级，只有这里能看出真相 */
  models?: string[]
  /** 这一轮用的档位；出错时渲染层据此给「切换到标准模式重试」的出口 */
  tier?: TierId
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
 {"type":"bignum","title":"看板","cards":[{"num":"¥199","label":"名","lines":["说明"],"style":"accent"}]}]}
版式选择：对比→vs；观点→quote；行动项→checklist；数字→bars；流程→steps；多选一→matrix；阶段→timeline；价格→bignum。
整份至少混用 3 种版式，同一版式禁止连续超过 2 页，禁止全篇 bullets；内容必须来自检索到的库内资料，不得编造。

render_document 的 spec JSON（Word/PDF 用 doc 结构，Excel 用 sheets 结构）：
doc:  {"title":"标题","subtitle":"副标题","sections":[{"heading":"小节","paragraphs":["段落"],"bullets":["要点"],"table":{"headers":["列"],"rows":[["值"]]}}]}
xlsx: {"title":"名","sheets":[{"name":"表名","headers":["列1"],"rows":[["值"]],"widths":[16]}]}`

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
    return `你是 mcn-ai——MCN 公司与带货达人的 AI 工作台，工作语言中文。
用户的个人知识库在 ${root ?? '(未打开)'}，顶层分区：${dirs || '(空库)'}。

规则：
1. 回答任何与用户业务/资料相关的问题前，必须先用 search_knowledge 检索库；回答中的每个关键结论句末标注来源，格式 [[笔记名]]。不许编造。
2. **检索词写成 2-4 个空格分开的短关键词，不要把整句话丢进去**。检索器是关键词匹配，整句查询（如「公司今年的年度目标是什么」）会因为夹带虚词而命中不到；正确写法是「年度目标」或「年度目标 进展」。空结果时**换更短的词**再试，不要换同义词反复兜圈子。
3. **检索返回空 ≠ 库里没有**。断言"库里没有"之前，必须先用 Grep/Glob 直接扫一遍库（工作目录即库根，Grep 找内容、Glob 找文件名），扫完仍无才能说没有。需要读全文时用 Read。
4. 用户要"做成PPT/课件"时：先检索资料，再构造 outline JSON 调 render_pptx 工具；要 Word/Excel/PDF 时：先检索资料，构造 spec JSON 调 render_document 工具（format 选 docx/xlsx/pdf）。用户要求生成文件时必须真的调用渲染工具产出文件，不许只在回答里给内容。${PPT_GUIDE}
5. 写文件只允许写入 90_产物/ 目录。用户指名要 PPT/Word/Excel/PDF 时，必须调用对应渲染工具（render_pptx / render_document）产出该格式的文件，禁止用 Write 写 markdown 代替。
6. 回答简洁直接，重要结论在前。
7. 重要：每轮只调用一个工具，严禁在同一轮里并行调用多个工具（网关不支持并行 tool_use，会直接报错）。需要多次检索就分多轮串行进行。
8. 检索够用即止：同一个任务里 search_knowledge 最多调 3 次。素材够写就立刻动手产出（该调 render_pptx / render_document 就调），不要为了"再全一点"反复检索——轮次是有上限的，耗光了文件就产不出来。三次检索仍无命中就转规则 3 的 Grep/Glob 兜底，别继续换词再搜。
9. **回答里不许出现你的工作机制**：工具名、子代理、任务编排、检索轮次、"我调用了…"、"子代理卡住了"这类内容一律不写。用户要的是结论与来源，不是过程日志。遇到障碍就说人话（如"这份资料库里没有"），不要暴露内部实现。
10. **敏感信息只用不说**：人事档案、财务表、达人信息表这类文件**可以读、可以作为结论依据、可以标注来源**，但**回答里不许复述个人字段**——身份证号、银行卡/收款账户、手机号等联系方式、员工与达人的真实姓名，一律不写进回答。提到人一律用**艺名**（达人）或**姓氏+职务**（员工，如"陈经理""李主管"）。用户明确要求看某个具体字段时，告诉他在哪个文件里自己打开看，不要代为复述。`
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
    tierId: TierId = DEFAULT_TIER
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
    const startedAt = Date.now()

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
              const { hits } = await vaultManager.search(q)
              const text = hits.length
                ? hits.slice(0, 6).map((h, i) => `${i + 1}. [[${h.title}]] (${h.path})\n   ${h.snippet}`).join('\n')
                : '（无命中）'
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
              await fs.writeFile(specPath, outline_json, 'utf-8')
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
              await fs.writeFile(specPath, spec_json, 'utf-8')
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
          resume: resumeSdkSessionId,
          model: provider.model,
          systemPrompt: this.buildSystemPrompt(),
          allowedTools: [
            'Read', 'Grep', 'Glob',
            'mcp__knowledge__search_knowledge',
            'mcp__knowledge__render_pptx',
            'mcp__knowledge__render_document',
          ],
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            // Write 只放行 90_产物；其余未预授权工具一律拒绝
            if (toolName === 'Write' || toolName === 'Edit') {
              const p = String(input.file_path ?? '')
              if (p.startsWith(artifactsDir) || p.startsWith('90_产物')) {
                return { behavior: 'allow' as const, updatedInput: input }
              }
              return { behavior: 'deny' as const, message: '只允许写入 90_产物/ 目录' }
            }
            return { behavior: 'deny' as const, message: `工具 ${toolName} 未开放` }
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
            if (ev.content_block.name) toolsUsed.add(ev.content_block.name)
            tasks.patch(taskId, { toolLine: ev.content_block.name } as Partial<AgentTask>)
            this.emit({ sessionId, kind: 'tool', tool: ev.content_block.name })
          }
          continue
        }
        if (message.type === 'result') {
          const text = message.subtype === 'success' ? message.result : `出错：${message.subtype}`
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
          // 失败在 Dock 与诊断日志里各有出口，不靠这里。**不挑字段、原样存**，归一化留给汇总侧
          if (message.subtype === 'success') {
            appendUsage({
              ts: Date.now(),
              sessionId,
              taskType: this.taskTypeOf(toolsUsed),
              tier,
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
          // 正文已经作为一条完整消息落进对话，草稿使命结束
          tasks.patch(taskId, { draft: '', toolLine: undefined, sdkSessionId: message.session_id } as Partial<AgentTask>)
          this.emit({
            sessionId,
            kind: 'assistant',
            text,
            sdkSessionId: message.session_id,
            costUsd,
            models,
            tier,
          })
        }
      }
      tasks.finish(taskId, 'succeeded')
      this.emit({ sessionId, kind: 'done' })
    } catch (err) {
      if (!abort.signal.aborted) {
        log('error', 'agent', err instanceof Error ? err : String(err))
        tasks.patch(taskId, { title: 'AI 回答出错' } as Partial<AgentTask>)
        tasks.finish(taskId, 'failed', err instanceof Error ? err.message : String(err))
        // 增强档失败时把"还有一条路可走"说出来：光报错等于把用户堵在原地（同 §5.3 的原则）
        const hint = tier === 'enhanced' ? '（增强模式线路异常，可切换到标准模式重试）' : ''
        this.emit({ sessionId, kind: 'error', text: `${String(err)}${hint}`, tier })
      } else {
        tasks.finish(taskId, 'canceled')
        this.emit({ sessionId, kind: 'done' })
      }
    } finally {
      this.live.delete(sessionId)
      this.stopped.delete(sessionId)
    }
  }
}

export const agentManager = new AgentManager()

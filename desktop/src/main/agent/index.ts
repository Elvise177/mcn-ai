import { spawn } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { store, getApiKey } from '../store'
import { vaultManager } from '../vault'
import { searchCloud } from '../knowledge/client'
import { pipelineBin } from '../lib/pipeline'

export interface AgentStreamPayload {
  sessionId: string
  kind: 'delta' | 'tool' | 'assistant' | 'done' | 'error'
  text?: string
  tool?: string
  sdkSessionId?: string
  costUsd?: number
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
  /** 测试观察口：无头冒烟不经 IPC 直接收事件 */
  tap: ((p: AgentStreamPayload) => void) | null = null

  attachWindow(win: BrowserWindow): void {
    this.win = win
  }

  private emit(payload: AgentStreamPayload): void {
    this.tap?.(payload)
    this.win?.webContents.send('agent:stream', payload)
  }

  stop(sessionId: string): void {
    this.live.get(sessionId)?.abort.abort()
    this.live.delete(sessionId)
  }

  private buildSystemPrompt(): string {
    const root = vaultManager.currentRoot
    const tree = vaultManager.tree()
    const dirs = tree.filter((n) => n.children).map((n) => n.name).join('、')
    return `你是 mcn-ai——MCN 公司与带货达人的 AI 工作台，工作语言中文。
用户的个人知识库在 ${root ?? '(未打开)'}，顶层分区：${dirs || '(空库)'}。

规则：
1. 回答任何与用户业务/资料相关的问题前，必须先用 search_knowledge 检索库；回答中的每个关键结论句末标注来源，格式 [[笔记名]]。检索不到就明说，不许编造。
2. 需要读全文时用 Read/Grep/Glob（工作目录即库根）。
3. 用户要"做成PPT/课件"时：先检索资料，再构造 outline JSON 调 render_pptx 工具；要 Word/Excel/PDF 时：先检索资料，构造 spec JSON 调 render_document 工具（format 选 docx/xlsx/pdf）。用户要求生成文件时必须真的调用渲染工具产出文件，不许只在回答里给内容。${PPT_GUIDE}
4. 写文件只允许写入 90_产物/ 目录。用户指名要 PPT/Word/Excel/PDF 时，必须调用对应渲染工具（render_pptx / render_document）产出该格式的文件，禁止用 Write 写 markdown 代替。
5. 回答简洁直接，重要结论在前。
6. 重要：每轮只调用一个工具，严禁在同一轮里并行调用多个工具（网关不支持并行 tool_use，会直接报错）。需要多次检索就分多轮串行进行。`
  }

  /** 发送一轮对话；流式事件经 agent:stream 下行 */
  async send(sessionId: string, prompt: string, resumeSdkSessionId?: string): Promise<void> {
    const root = vaultManager.currentRoot
    if (!root) {
      this.emit({ sessionId, kind: 'error', text: '请先在「个人知识库」打开一个库' })
      return
    }
    const apiKey = getApiKey() || process.env.ANTHROPIC_AUTH_TOKEN
    if (!apiKey) {
      this.emit({ sessionId, kind: 'error', text: '请先在「设置」里配置 API Key' })
      return
    }

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
            const hits = await vaultManager.search(q)
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

    const abort = new AbortController()
    this.live.set(sessionId, { abort })

    try {
      const q = query({
        prompt,
        options: {
          abortController: abort,
          cwd: root,
          resume: resumeSdkSessionId,
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
          maxTurns: 30,
          includePartialMessages: true,
          pathToClaudeCodeExecutable: claudeCliBin(),
          executable: process.execPath as never,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            ANTHROPIC_BASE_URL: store.get('relayBaseUrl'),
            ANTHROPIC_AUTH_TOKEN: apiKey,
          },
        },
      })

      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') {
          const tools = (message as { tools?: string[] }).tools ?? []
          console.log('[agent] 可用工具:', tools.filter((t) => t.includes('knowledge')).join(', ') || tools.length)
          continue
        }
        if (message.type === 'stream_event') {
          const ev = message.event as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; name?: string } }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            this.emit({ sessionId, kind: 'delta', text: ev.delta.text })
          } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            this.emit({ sessionId, kind: 'tool', tool: ev.content_block.name })
          }
          continue
        }
        if (message.type === 'result') {
          const text = message.subtype === 'success' ? message.result : `出错：${message.subtype}`
          this.emit({
            sessionId,
            kind: 'assistant',
            text,
            sdkSessionId: message.session_id,
            costUsd: 'total_cost_usd' in message ? message.total_cost_usd : undefined,
          })
        }
      }
      this.emit({ sessionId, kind: 'done' })
    } catch (err) {
      if (!abort.signal.aborted) {
        this.emit({ sessionId, kind: 'error', text: String(err) })
      } else {
        this.emit({ sessionId, kind: 'done' })
      }
    } finally {
      this.live.delete(sessionId)
    }
  }
}

export const agentManager = new AgentManager()

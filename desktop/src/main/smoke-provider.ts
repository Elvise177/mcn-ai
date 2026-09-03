/**
 * 模型线路冒烟：同一套 Agent 链路，对每条线路各跑一遍关键能力。
 *
 * 覆盖：单轮对话 / 多轮 resume / abort / 工具调用(search_knowledge) / 流式输出 / make-ppt 全流程
 *
 * 线路以**档位**的形式配置（档位层是对话链路的唯一取数口，见 ai/tiers.ts）：
 * deepseek（出厂）/ inferera / custom 三条落在标准档，enhanced（inferera + claude-opus-5，出厂）落在增强档。
 *
 * 运行（在 desktop/ 下）：
 *   npm run smoke:provider
 * 等价于：
 *   npm run build && SMOKE_VAULT=/tmp/mcnai-e2e-vault \
 *   SMOKE_DEEPSEEK_KEY=<deepseek key> SMOKE_ENHANCED_KEY=<中转站key> \
 *   ./node_modules/.bin/electron out/main/smoke-provider.js
 * 只想跑一条：加 SMOKE_ONLY=deepseek（或 enhanced / inferera / custom）
 * 只想跑几项：SMOKE_CASES=single,abort,tools（可选 single/resume/abort/tools/ppt/env）
 *   —— **控制真实调用成本**用的：新增线路只需要验"能不能通、模型有没有被换掉、
 *      能不能停、工具能不能调"，没改动的链路靠既有基线，不为仪式感跑全套
 * 自定义线路：SMOKE_CUSTOM_BASE=… SMOKE_CUSTOM_KEY=… SMOKE_CUSTOM_MODEL=…
 *
 * 必须以**完整 Electron app** 运行（不是 ELECTRON_RUN_AS_NODE）：Agent SDK 的
 * claudeCliBin() 要用 app.getAppPath()，electron-store 也要 app 环境。
 * key 直接从环境变量注入 provider 层的内存缓存，不碰 safeStorage——冒烟没必要写
 * Keychain，写了还会撞上 M-29 的首调冻结。
 */
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

process.env.MCNAI_USER_DATA = process.env.MCNAI_USER_DATA || '/tmp/mcnai-smoke-provider'

// 静默死掉是最坏的冒烟结果（看着"跑完了"其实只跑了一半）：把每一种退出路径都喊出来
process.on('uncaughtException', (e) => {
  console.error('SMOKE 崩溃（uncaughtException）:', e)
  process.exitCode = 1
})
process.on('unhandledRejection', (e) => {
  console.error('SMOKE 崩溃（unhandledRejection）:', e)
  process.exitCode = 1
})
process.on('beforeExit', (code) => console.error(`SMOKE 事件循环空了（beforeExit=${code}）——有一轮对话既没结束也没报错`))

interface Case {
  id: string
  label: string
  /** 这条线路挂在哪个档位下（标准/增强） */
  tier: 'standard' | 'enhanced'
  /** 明文 key 写进哪个槽位（冒烟只塞内存缓存，不碰 Keychain） */
  field: 'encryptedApiKey' | 'encryptedLlmKey' | 'encryptedCustomKey' | 'encryptedAihubmixKey'
  baseUrl: string
  key: string
  model: string
  fastModel: string
}

/** 可选跑哪几项；不给就是全跑 */
const WANTED = (process.env.SMOKE_CASES || '').split(',').map((s) => s.trim()).filter(Boolean)
const wants = (name: string): boolean => !WANTED.length || WANTED.includes(name)

const VAULT = process.env.SMOKE_VAULT || '/tmp/mcnai-e2e-vault'
/** 单轮对话的硬超时（make-ppt 那轮最久，实测 60s 上下） */
const ROUND_TIMEOUT_MS = Number(process.env.SMOKE_ROUND_TIMEOUT_MS || 240_000)

function cases(): Case[] {
  const all: Case[] = []
  if (process.env.SMOKE_INFERERA_KEY) {
    all.push({
      id: 'inferera',
      label: 'inferera 中转站（标准档）',
      tier: 'standard',
      field: 'encryptedApiKey',
      baseUrl: process.env.SMOKE_INFERERA_BASE || 'https://api.inferera.com',
      key: process.env.SMOKE_INFERERA_KEY,
      model: process.env.SMOKE_MODEL || 'deepseek-v4-pro',
      fastModel: process.env.SMOKE_FAST_MODEL || 'deepseek-v4-flash',
    })
  }
  if (process.env.SMOKE_DEEPSEEK_KEY) {
    all.push({
      id: 'deepseek',
      label: 'DeepSeek 官方（标准档出厂映射）',
      tier: 'standard',
      field: 'encryptedLlmKey',
      baseUrl: process.env.SMOKE_DEEPSEEK_BASE || 'https://api.deepseek.com/anthropic',
      key: process.env.SMOKE_DEEPSEEK_KEY,
      model: process.env.SMOKE_MODEL || 'deepseek-v4-pro',
      fastModel: process.env.SMOKE_FAST_MODEL || 'deepseek-v4-flash',
    })
  }
  if (process.env.SMOKE_ENHANCED_KEY) {
    all.push({
      id: 'enhanced',
      label: '增强档（inferera 中转站 + claude-opus-5，出厂映射）',
      tier: 'enhanced',
      field: 'encryptedAihubmixKey',
      baseUrl: process.env.SMOKE_ENHANCED_BASE || 'https://api.inferera.com',
      key: process.env.SMOKE_ENHANCED_KEY,
      // 增强档的模型串是钉死的：这条断言（result.modelUsage 必须原样返回它）
      // 就是"真路由到 opus 而不是被中转站换成别的"的唯一证据
      model: process.env.SMOKE_ENHANCED_MODEL || 'claude-opus-5',
      fastModel: process.env.SMOKE_ENHANCED_FAST_MODEL || 'claude-opus-5',
    })
  }
  if (process.env.SMOKE_CUSTOM_KEY && process.env.SMOKE_CUSTOM_BASE) {
    all.push({
      id: 'custom',
      label: '自定义线路（标准档）',
      tier: 'standard',
      field: 'encryptedCustomKey',
      baseUrl: process.env.SMOKE_CUSTOM_BASE,
      key: process.env.SMOKE_CUSTOM_KEY,
      model: process.env.SMOKE_CUSTOM_MODEL || 'deepseek-v4-pro',
      fastModel: process.env.SMOKE_CUSTOM_FAST_MODEL || process.env.SMOKE_CUSTOM_MODEL || 'deepseek-v4-flash',
    })
  }
  const only = process.env.SMOKE_ONLY
  return only ? all.filter((c) => c.id === only) : all
}

type Result = { name: string; ok: boolean; ms: number; note: string }

async function runCase(c: Case): Promise<Result[]> {
  const { store } = await import('./store')
  const { agentEnv } = await import('./ai/provider')
  const { setTierConfig } = await import('./ai/tiers')
  const { keyVault } = await import('./store')
  const { vaultManager } = await import('./vault')
  const { agentManager } = await import('./agent')

  // 档位层照常配置，但 key 走内存缓存（不碰 Keychain——冒烟没必要写，写了还会撞 M-29 的首调冻结）
  setTierConfig(c.tier, {
    baseUrl: c.baseUrl,
    model: c.model,
    fastModel: c.fastModel,
    keyField: c.field,
  })
  keyVault.preload(c.field, c.key)
  store.set('vaultPath', VAULT)
  await vaultManager.open(VAULT)

  const results: Result[] = []
  const run = async (id: string, name: string, fn: () => Promise<string>): Promise<void> => {
    if (!wants(id)) {
      console.log(`  ⏭  ${name}（SMOKE_CASES 未选中，跳过）`)
      return
    }
    const t0 = Date.now()
    try {
      const note = await fn()
      results.push({ name, ok: true, ms: Date.now() - t0, note })
      console.log(`  ✅ ${name}（${Date.now() - t0}ms）${note}`)
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e)
      results.push({ name, ok: false, ms: Date.now() - t0, note })
      console.log(`  ❌ ${name}（${Date.now() - t0}ms）${note}`)
    }
  }

  /** 收集一轮对话的全部事件；deltas>0 即证明流式生效 */
  const ask = (
    sessionId: string,
    prompt: string,
    resume?: string,
    onDelta?: (n: number) => void
  ): Promise<{
    text: string
    deltas: number
    tools: string[]
    sdkSessionId?: string
    models: string[]
    error?: string
    recovered?: boolean
  }> =>
    new Promise((resolve) => {
      let text = ''
      let deltas = 0
      const tools: string[] = []
      let sdkSessionId: string | undefined
      let models: string[] = []
      let error: string | undefined
      /** 这一轮是不是走了「旧 session 失效 → 拼历史重开」的降级（见下面 resume 用例的断言） */
      let recovered = false
      // 单轮硬超时：一轮既不 done 也不 error 时，事件循环会空掉、进程静默退出（看着像"跑完了"）
      const guard = setTimeout(() => {
        agentManager.tap = null
        resolve({ text, deltas, tools, sdkSessionId, models, recovered, error: `单轮超时（${ROUND_TIMEOUT_MS}ms 无终结事件）` })
      }, ROUND_TIMEOUT_MS)
      agentManager.tap = (p) => {
        if (p.sessionId !== sessionId) return
        if (p.kind === 'delta') {
          deltas++
          onDelta?.(deltas)
        }
        if (p.kind === 'tool' && p.tool) tools.push(p.tool)
        if (p.recovered) recovered = true
        if (p.kind === 'assistant') {
          text = p.text ?? ''
          sdkSessionId = p.sdkSessionId
          models = p.models ?? []
        }
        if (p.kind === 'error') error = p.text
        if (p.kind === 'done' || p.kind === 'error') {
          clearTimeout(guard)
          agentManager.tap = null
          resolve({ text, deltas, tools, sdkSessionId, models, error, recovered })
        }
      }
      void agentManager.send(sessionId, prompt, resume, c.tier)
    })

  // ① 单轮对话 + ② 流式输出 + ③ 模型没被静默换掉（同一轮里一起断言）
  await run('single', '单轮对话+流式+模型钉死', async () => {
    const r = await ask('smoke-1', '只回复四个字：冒烟通过。不要检索知识库，不要调用任何工具。')
    if (r.error) throw new Error(r.error)
    if (!r.text.includes('冒烟')) throw new Error(`回答不含期望内容：${r.text.slice(0, 80)}`)
    if (r.deltas < 1) throw new Error('没有收到任何流式 delta')
    // 这是整个 provider 解耦最关键的一条：服务端**实际用的**模型必须是我们点名的那个。
    // DeepSeek 官方端点对不认识的模型名是 HTTP 200 + 静默降级到 flash，只有这里能拆穿
    if (r.models.length && !r.models.includes(c.model))
      throw new Error(`模型被服务端换掉了：要 ${c.model}，实际 ${r.models.join('/')}`)
    return `deltas=${r.deltas} 实际模型=${r.models.join('/') || '(未上报)'} 「${r.text.replace(/\s+/g, ' ').slice(0, 24)}」`
  })

  // ③ 多轮 resume：第二轮必须记得第一轮说过的数字
  await run('resume', '多轮 resume', async () => {
    const a = await ask('smoke-2', '记住这个数字：4271。只回复"记住了"，不要调用任何工具。')
    if (a.error) throw new Error(a.error)
    if (!a.sdkSessionId) throw new Error('第一轮没有拿到 sdkSessionId，无法 resume')
    const b = await ask('smoke-2', '刚才让你记的数字是多少？只回数字本身。', a.sdkSessionId)
    if (b.error) throw new Error(b.error)
    // 会话恢复失败时主进程会自动拼历史开新会话（`agent/resume-recovery.ts`）——那条兜底
    // 会让下面这句"记住了数字"照样成立，**resume 真坏了也测不出来**。所以先否掉降级
    if (b.recovered) throw new Error('resume 失败并走了降级重开：这一轮验的是 resume 本身，不认兜底结果')
    if (!b.text.includes('4271')) throw new Error(`resume 后没记住上下文：${b.text.slice(0, 80)}`)
    return `第二轮回「${b.text.replace(/\s+/g, ' ').slice(0, 20)}」`
  })

  // ④ abort：流式吐字后立刻停止，必须能停下来且不再有新字
  await run('abort', 'abort 可停止', async () => {
    let stopped = false
    const p = ask('smoke-3', '写一篇 800 字的短文，主题随意，直接开始写。', undefined, (n) => {
      if (n >= 3 && !stopped) {
        stopped = true
        agentManager.stop('smoke-3')
      }
    })
    const r = await Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('abort 后 60s 仍未结束')), 60_000)),
    ])
    if (!stopped) throw new Error('压根没吐出足够的流式内容，abort 没被触发')
    return `停在第 ${r.deltas} 个 delta`
  })

  // ⑤ 工具调用：必须真的调到 search_knowledge
  await run('tools', '工具调用 search_knowledge', async () => {
    const r = await ask('smoke-4', '检索一下我的知识库里跟"达人"有关的资料，用 search_knowledge 工具，然后一句话总结。')
    if (r.error) throw new Error(r.error)
    const hit = r.tools.find((t) => t.includes('search_knowledge'))
    if (!hit) throw new Error(`没有调用 search_knowledge，实际调用：${JSON.stringify(r.tools)}`)
    return `tools=${JSON.stringify(r.tools)}`
  })

  // ⑥ make-ppt 全流程：必须真的落出 pptx 文件
  await run('ppt', 'make-ppt 产出 pptx', async () => {
    const r = await ask(
      'smoke-5',
      '把知识库里关于达人运营的内容做成一个 3 页的 PPT，文件名用 smoke冒烟课件。必须调用 render_pptx 工具真的生成文件。'
    )
    if (r.error) throw new Error(r.error)
    const day = new Date().toISOString().slice(0, 10)
    const out = join(VAULT, '90_产物', `${day}_smoke冒烟课件`, 'smoke冒烟课件.pptx')
    if (!existsSync(out)) throw new Error(`产物没生成：${out}（tools=${JSON.stringify(r.tools)}）`)
    return out
  })

  // 环境隔离自检：子进程里不能残留开发机自己的 ANTHROPIC_* 变量
  await run('env', '子进程环境隔离', async () => {
    const env = agentEnv({ baseUrl: c.baseUrl, apiKey: c.key, model: c.model, fastModel: c.fastModel })
    if (env.ANTHROPIC_BASE_URL !== c.baseUrl) throw new Error('base URL 没生效')
    if (env.ANTHROPIC_MODEL !== c.model) throw new Error('主模型没显式下发')
    if (env.ANTHROPIC_SMALL_FAST_MODEL !== c.fastModel) throw new Error('轻量模型没显式下发')
    const leaked = Object.keys(env).filter(
      (k) => k.startsWith('ANTHROPIC_') && !['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'].includes(k)
    )
    if (leaked.length) throw new Error(`继承来的 ANTHROPIC_* 没清干净：${leaked.join(',')}`)
    return `model=${c.model} fast=${c.fastModel}`
  })

  return results
}

async function main(): Promise<void> {
  const list = cases()
  if (!list.length) {
    console.error(
      'SMOKE FAIL: 一条线路的 key 都没给（SMOKE_DEEPSEEK_KEY / SMOKE_ENHANCED_KEY / SMOKE_INFERERA_KEY / SMOKE_CUSTOM_KEY）'
    )
    app.exit(1)
    return
  }
  if (!existsSync(VAULT)) {
    console.error(`SMOKE FAIL: 知识库不存在 ${VAULT}（用 SMOKE_VAULT 指定）`)
    app.exit(1)
    return
  }

  const all: Array<{ c: Case; rs: Result[] }> = []
  for (const c of list) {
    console.log(`\n=== ${c.label}（${c.baseUrl}，模型 ${c.model} / ${c.fastModel}）===`)
    all.push({ c, rs: await runCase(c) })
  }

  console.log('\n=== 冒烟汇总 ===')
  let bad = 0
  for (const { c, rs } of all) {
    const fail = rs.filter((r) => !r.ok)
    bad += fail.length
    console.log(
      `${fail.length ? '❌' : '✅'} ${c.label}：${rs.length - fail.length}/${rs.length} 通过` +
        (fail.length ? `　失败项：${fail.map((f) => f.name).join('、')}` : '')
    )
    for (const r of rs) console.log(`    ${r.ok ? '·' : '!'} ${r.name} ${r.ms}ms ${r.note}`)
  }
  app.exit(bad ? 1 : 0)
}

app.whenReady().then(main)

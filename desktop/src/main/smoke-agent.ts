/**
 * M0 冒烟：验证 Agent SDK 能在 Electron 的 Node 运行时里跑通中转站调用。
 * 运行：npm run smoke:agent（要求 env 或 store 里有 key）
 * 打包后验证：ELECTRON_RUN_AS_NODE=1 <App>/Contents/MacOS/mcn-ai out/main/smoke-agent.js
 */
async function main(): Promise<void> {
  // SDK 是纯 ESM 包，CJS 主进程里必须用动态 import 加载
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic'
  const key = process.env.ANTHROPIC_AUTH_TOKEN
  if (!key) {
    console.error('SMOKE FAIL: 未设置 ANTHROPIC_AUTH_TOKEN')
    process.exit(1)
  }
  // B-7：模型必须**显式下发**。这里原来既不给 options.model 也不注入 ANTHROPIC_MODEL，
  // SDK 就用自己的默认串（claude-sonnet-4-5-… + claude-haiku-4-5-…）打到中转站上——
  // 2026-08-18 的账单对账里这两个模型各出现 1 次，就是这条路径漏出去的。
  // 金额可忽略（$0.0002），但它是静默降级防线上的针眼：默认串在 DeepSeek 官方端点
  // 会被 HTTP 200 静默降级成 flash（§4-17），冒烟就永远测不出真实模型
  const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro'
  const fastModel = process.env.ANTHROPIC_SMALL_FAST_MODEL || 'deepseek-v4-flash'

  process.env.ANTHROPIC_BASE_URL = baseUrl
  process.env.ANTHROPIC_MODEL = model
  process.env.ANTHROPIC_SMALL_FAST_MODEL = fastModel

  const start = Date.now()
  let gotText = ''
  try {
    for await (const message of query({
      prompt: '只回复四个字：冒烟通过',
      options: {
        allowedTools: [],
        maxTurns: 1,
        model,
        // Electron 打包环境无系统 node：SDK 子进程用 Electron 自身以 Node 模式运行
        executable: process.execPath as never,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        gotText = message.result
        // 拆穿静默降级：服务端实际用的模型必须就是我们钉死的那个
        const used = Object.keys((message as { modelUsage?: Record<string, unknown> }).modelUsage ?? {})
        if (used.length && !used.includes(model)) {
          console.error(`SMOKE FAIL: 期望模型 ${model}，服务端实际用了 ${used.join('/')}`)
          process.exit(3)
        }
      }
    }
  } catch (err) {
    console.error('SMOKE FAIL:', err)
    process.exit(1)
  }

  console.log(`SMOKE OK (${Date.now() - start}ms):`, gotText)
  process.exit(gotText.includes('冒烟') ? 0 : 2)
}

main()

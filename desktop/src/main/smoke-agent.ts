/**
 * M0 冒烟：验证 Agent SDK 能在 Electron 的 Node 运行时里跑通中转站调用。
 * 运行：npm run smoke:agent（要求 env 或 store 里有 key）
 * 打包后验证：ELECTRON_RUN_AS_NODE=1 <App>/Contents/MacOS/mcn-ai out/main/smoke-agent.js
 */
async function main(): Promise<void> {
  // SDK 是纯 ESM 包，CJS 主进程里必须用动态 import 加载
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.inferera.com'
  const key = process.env.ANTHROPIC_AUTH_TOKEN
  if (!key) {
    console.error('SMOKE FAIL: 未设置 ANTHROPIC_AUTH_TOKEN')
    process.exit(1)
  }

  process.env.ANTHROPIC_BASE_URL = baseUrl

  const start = Date.now()
  let gotText = ''
  try {
    for await (const message of query({
      prompt: '只回复四个字：冒烟通过',
      options: {
        allowedTools: [],
        maxTurns: 1,
        // Electron 打包环境无系统 node：SDK 子进程用 Electron 自身以 Node 模式运行
        executable: process.execPath as never,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        gotText = message.result
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

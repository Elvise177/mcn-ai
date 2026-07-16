/**
 * M3 冒烟：真实 Agent 链路（问库→search_knowledge→引用回答→可选 PPT）。
 * 运行: ANTHROPIC_AUTH_TOKEN=<key> ./node_modules/.bin/electron out/main/smoke-chat.js <vault> ["提示词"]
 * 注意：必须以完整 Electron app 运行（electron-store/safeStorage 依赖 app 环境）。
 */
import { app } from 'electron'
import { vaultManager } from './vault'
import { agentManager } from './agent'

app.setPath('userData', '/tmp/mcnai-smoke-userdata')

app.whenReady().then(async () => {
  const vault = process.argv[2]
  const prompt = process.argv[3] || '灰太太是谁？她最近的数据怎么样？'
  if (!vault) {
    console.error('用法: smoke-chat.js <vault路径> [提示词]')
    app.exit(1)
    return
  }
  await vaultManager.open(vault)

  const tools: string[] = []
  let finalText = ''
  let failed = false

  agentManager.tap = (p) => {
    if (p.kind === 'tool' && p.tool) {
      tools.push(p.tool)
      console.log('  [工具]', p.tool)
    } else if (p.kind === 'assistant' && p.text) {
      finalText = p.text
    } else if (p.kind === 'error') {
      failed = true
      console.error('  [错误]', p.text)
    }
  }

  const t0 = Date.now()
  await agentManager.send('smoke', prompt)
  console.log(`\n=== 回答（${Math.round((Date.now() - t0) / 1000)}s）===\n${finalText.slice(0, 800)}`)
  console.log('\n工具调用:', tools.join(' → ') || '(无)')
  const cited = /\[\[.+?\]\]/.test(finalText)
  console.log('带引用:', cited)
  app.exit(failed || !finalText ? 1 : 0)
})

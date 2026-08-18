import {
  HISTORY_BUDGET,
  PER_MESSAGE_CAP,
  buildRecoveryPrompt,
  isResumeLost,
} from './agent/resume-recovery'
import type { ChatMessage } from './agent/conversations'

/**
 * 会话恢复降级的**纯逻辑冒烟**：识别串与上下文重建，零网络、零 token。
 *
 * 跑法：`npm run smoke:resume`
 *
 * 为什么单独一个入口：这两件事一旦错了，故障形态是"没识别出来 → 原样报错给客户"或
 * "识别过头 → 好端端的报错被吞掉、闷头重开一轮烧钱"，两种都不该拿真实调用去试。
 * 真链路那一条（伪造 session id 真发一条消息）在 `e2e/walkthrough.mjs` 的 46 步。
 */

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n【1】识别串：CLI 二进制里的原文必须全部认出来')
// 逐条来自 `strings claude`，改 SDK 版本后若这里挂了，先去二进制里核对新文案
for (const s of [
  'Claude Code returned an error result: No conversation found with session ID: 0d4924db-1f97-41d5-a36e-884a372f37b2',
  'No conversation found to continue',
  'Session 0d4924db not found in project directory for /Users/x/MyBrain',
  'Session 0d4924db not found (no projects directory)',
  'Error: Session 0d4924db not found. It may have been archived or expired.',
]) {
  check(s.slice(0, 56), isResumeLost(s))
}

console.log('\n【2】不许误伤：这些是别的故障，认成"上下文过期"会闷头重开一轮')
for (const s of [
  'API Error: 403 Your account balance is insufficient',
  'Failed to authenticate. 401 unauthorized',
  'session not found on server (code 404)', // 远程 teleport，与本地会话无关
  'Reached maximum number of turns (40)',
  'fetch failed',
  'ENOTFOUND api.deepseek.com',
]) {
  check(s.slice(0, 56), !isResumeLost(s))
}

console.log('\n【3】上下文重建')
const msg = (role: ChatMessage['role'], text: string, error?: boolean): ChatMessage => ({ role, text, error })

const short = buildRecoveryPrompt(
  [msg('user', '我们公司的年度目标是什么'), msg('assistant', '目标是 GMV 破亿。'), msg('user', '拆到每个季度呢')],
  '那第三季度重点抓什么'
)
check('短对话整段带回，不算截断', short.kept === 3 && short.total === 3 && !short.truncated, JSON.stringify(short).slice(0, 120))
check('本轮提问在末尾且只出现一次', short.text.endsWith('那第三季度重点抓什么') && short.text.split('那第三季度重点抓什么').length === 2)
check('历史逐条在内', short.text.includes('用户：我们公司的年度目标是什么') && short.text.includes('助手：目标是 GMV 破亿。'))

const withErr = buildRecoveryPrompt(
  [msg('user', '在吗'), msg('assistant', '⚠️ AI 服务余额不足，请联系管理员充值', true), msg('user', '现在呢')],
  '继续'
)
// 喂回去会让模型以为自己上一轮真说过"余额不足"
check('错误气泡被跳过', !withErr.text.includes('余额不足') && withErr.kept === 2)

const long = buildRecoveryPrompt(
  Array.from({ length: 200 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `第${i}轮`.padEnd(300, '内容'))),
  '最后一问'
)
check('超预算会截断并标记', long.truncated && long.kept < long.total && long.kept > 0, `kept=${long.kept}/${long.total}`)
check('截断后不超预算', long.text.length < HISTORY_BUDGET + 1000, `len=${long.text.length}`)
// 丢的必须是最早那几轮：最近说过的话才是接得上下文的关键
check('保留的是最近的轮次', long.text.includes('第199轮') && !long.text.includes('第0轮'))

const huge = buildRecoveryPrompt([msg('user', 'X'.repeat(9000)), msg('assistant', '收到')], '继续')
check('单条超长被单独截断，不吃光预算', huge.truncated && huge.kept === 2 && huge.text.includes('内容过长已截断'))
check('单条截断按 PER_MESSAGE_CAP', !huge.text.includes('X'.repeat(PER_MESSAGE_CAP + 1)))

const empty = buildRecoveryPrompt([], '第一句话')
check('空历史 = 原样发，不加任何前言', empty.text === '第一句话' && !empty.truncated)

console.log(failed ? `\n✗ ${failed} 条不通过\n` : '\n✓ 全部通过\n')
process.exit(failed ? 1 : 0)

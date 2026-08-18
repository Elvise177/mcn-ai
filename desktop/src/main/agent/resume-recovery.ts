import type { ChatMessage } from './conversations'

/**
 * 会话恢复（`options.resume`）失败的识别与降级重建。
 *
 * ## 为什么需要它
 *
 * SDK 的会话是**落盘在 CLI 那一侧**的：`~/.claude/projects/<cwd 转义>/<session-id>.jsonl`。
 * 我们把 `sdkSessionId` 存在对话里长期复用，于是只要那个文件没了，这个对话**每一次**发消息
 * 都会撞上同一个错误，而且用户自己解不开（界面上没有"忘掉旧上下文"这种按钮）。
 * 2026-08-18 用户实测撞到的就是这个：`No conversation found with session ID: 0d4924db-…`。
 *
 * ## 文件是怎么没的（都够得着，不是极端情况）
 *
 * 1. **换库**——目录名由 `cwd` 决定，而 `cwd` 就是 vault root。换一次库，
 *    所有历史对话的 `sdkSessionId` 当场全部失效
 * 2. **闲置过期**——CLI 有 transcript 保留期清理（`cleanupPeriodDays`，出厂 30 天）
 * 3. **换机器 / 清过 `~/.claude`**——本地对话还在（electron-store 里），SDK 侧的没了
 *
 * 注意**进程重启本身不会丢**（文件在盘上），所以别把它当成唯一场景去验证。
 *
 * ## 降级策略
 *
 * 旧 session 直接放弃，用本地历史拼一段上下文开新会话重发。历史在预算内就整段带上
 * （用户无感，只落一条降级日志）；超预算才截到最近若干条并弹提示条——
 * 短对话（绝大多数）明明能无损恢复，没必要每次都打扰人。
 */

/**
 * CLI 二进制里的原文，逐条核对过（`strings claude | grep -i "not found"`）：
 *   - `No conversation found with session ID: <id>`   ← `--resume=<id>` 找不到
 *   - `No conversation found to continue`             ← `--continue`
 *   - `Session <id> not found in project directory for <dir>`
 *   - `Session <id> not found (no projects directory)`
 *   - `Session <id> not found. It may have been archived or expired.`
 *
 * 排除 `session not found on server (code 404)`——那是远程 teleport 的串，与本地会话无关，
 * 误判会让"服务端 404"被当成"上下文过期"，把排查方向带偏（同 `lib/err.ts` 的原则）。
 */
const RESUME_LOST_RE =
  /No conversation found (?:with session ID|to continue)|Session\b(?![^\n]{0,40}\bon server\b)[^\n]{0,80}?\bnot found\b/i

export function isResumeLost(text: string): boolean {
  return RESUME_LOST_RE.test(text)
}

/**
 * 拼进新会话的历史预算（字符）。中文约 1~1.5 字/token，12000 字符 ≈ 1 万 token 上下，
 * 对 128k 上下文是安全值，也远够装下一轮正常对话——**绝大多数会话根本不会被截**。
 */
export const HISTORY_BUDGET = 12_000
/** 单条上限：把一整份文档粘进来的那种，别让它一个人吃光预算，后面的轮次全被挤掉 */
export const PER_MESSAGE_CAP = 2_000

export interface RecoveryPrompt {
  /** 直接当 prompt 发出去的完整文本 */
  text: string
  /** 有内容被丢掉或截断 → 界面要给提示条（用户得知道 AI 可能不记得早先说过的话） */
  truncated: boolean
  /** 带回了几条（日志用） */
  kept: number
  /** 本来有几条 */
  total: number
}

const ROLE_ZH: Record<ChatMessage['role'], string> = { user: '用户', assistant: '助手' }

/**
 * 用本地历史拼一段"复述"式上下文。
 *
 * 拼成**一条 user 消息里的引文**，而不是伪造多轮：SDK 的输入流只接受 user 消息，
 * 假装 assistant 说过话做不到，也没必要——模型看引文一样能接上。
 *
 * 跳过错误气泡（`error:true`）：那些是我们自己画的 ⚠️，喂回去只会让模型以为
 * 它上一轮真说过"AI 服务余额不足"。
 */
export function buildRecoveryPrompt(history: ChatMessage[], prompt: string): RecoveryPrompt {
  const usable = history.filter((m) => !m.error && m.text.trim())
  const lines: string[] = []
  let budget = HISTORY_BUDGET
  let clipped = false

  // 从最近往回收：上下文不够时，该丢的是最早那几轮
  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i]
    let body = m.text.trim()
    if (body.length > PER_MESSAGE_CAP) {
      body = `${body.slice(0, PER_MESSAGE_CAP)}…（内容过长已截断）`
      clipped = true
    }
    const line = `${ROLE_ZH[m.role]}：${body}`
    if (line.length > budget) break
    budget -= line.length
    lines.unshift(line)
  }

  const truncated = clipped || lines.length < usable.length
  const head = lines.length
    ? `【以下是这个对话此前的记录，供你恢复上下文。不要在回答里提到这段记录、也不要复述它】\n${lines.join('\n')}\n\n【用户当前的问题】\n`
    : ''
  return { text: `${head}${prompt}`, truncated, kept: lines.length, total: usable.length }
}

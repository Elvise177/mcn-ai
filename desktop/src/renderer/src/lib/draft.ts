/**
 * 输入框草稿的按会话持久化（F2）。
 *
 * ## 病症
 *
 * 输入框内容只活在组件的 `useState` 里：切一下对话、点一下知识库、或者按 Cmd+R
 * 重载界面，**刚打了一半的长提示词就没了**。这是每天都会撞到的那一类损失——
 * 而且没有任何提示，用户只会觉得"这软件把我的东西吃了"。
 *
 * ## 为什么是 localStorage 而不是主进程
 *
 * 草稿是**这台机器上这个人的临时输入**，不该进 `conversations`（那份会上云）。
 * 它也不值得为它开一条 IPC：每敲一个字都写一次主进程既慢又没必要。
 *
 * ## 键与清理
 *
 * 键是 `draft.<convId>`。删对话时同步删草稿（`clearDraft`），
 * 另外启动时按现存会话清一遍孤儿（`pruneDrafts`）——不清的话，用了两年之后
 * localStorage 里会躺着几百条属于早就删掉的对话的半截话。
 */

const PREFIX = 'draft.'

const key = (convId: string): string => `${PREFIX}${convId}`

/** 读草稿。localStorage 在隐私模式/配额满时会抛，读不到就当没有 */
export function readDraft(convId: string): string {
  try {
    return localStorage.getItem(key(convId)) ?? ''
  } catch {
    return ''
  }
}

/** 写草稿。**空串等于删**：留一个空条目只会让 `pruneDrafts` 多扫一条 */
export function writeDraft(convId: string, text: string): void {
  try {
    if (text) localStorage.setItem(key(convId), text)
    else localStorage.removeItem(key(convId))
  } catch {
    /* 配额满：草稿丢了不该让发送这条主路径挂掉 */
  }
}

export function clearDraft(convId: string): void {
  writeDraft(convId, '')
}

/**
 * 清掉不属于任何现存会话的草稿（启动时跑一次）。
 * 返回清掉的条数，纯粹为了能断言——不返回的话这个函数没法零花费验。
 */
export function pruneDrafts(liveConvIds: string[]): number {
  const live = new Set(liveConvIds)
  let n = 0
  try {
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith(PREFIX)) continue
      if (!live.has(k.slice(PREFIX.length))) stale.push(k)
    }
    for (const k of stale) {
      localStorage.removeItem(k)
      n++
    }
  } catch {
    /* 读不到就算了：清理是锦上添花，不该在这儿抛 */
  }
  return n
}

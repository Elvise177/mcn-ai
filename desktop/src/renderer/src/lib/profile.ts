/**
 * 用户身份显示规则（只在渲染层，不碰 IPC/主进程）。
 *
 * 后端 auth:state 只给 email，而客户的账号邮箱前缀常常是一串 QQ 号数字
 * （如 604056836@qq.com），直接拿它当称呼就成了「早上好，604056836」。
 * 规则：昵称由用户在设置里自己填（存 localStorage），有昵称才带称呼，
 * 没有就只显示问候语本身，永远不把用户 ID 数字甩到脸上。
 */
const NICK_KEY = 'profile.nickname'

export function getNickname(): string | undefined {
  const v = localStorage.getItem(NICK_KEY)?.trim()
  return v || undefined
}

export function setNickname(v: string): void {
  const t = v.trim()
  if (t) localStorage.setItem(NICK_KEY, t)
  else localStorage.removeItem(NICK_KEY)
}

/** 按时段的问候语 */
export function greetingOf(date = new Date()): string {
  const h = date.getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/** 首页问候：有昵称 =「早上好，昵称」，无昵称 = 只有问候语 */
export function greetingLine(nickname?: string, date = new Date()): string {
  const g = greetingOf(date)
  return nickname ? `${g}，${nickname}` : g
}

/** 侧栏底部身份行：优先昵称，其次完整邮箱，本地模式下什么都不显示 */
export function identityLabel(nickname?: string, email?: string): string | undefined {
  return nickname || email || undefined
}

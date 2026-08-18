/**
 * IPC 抛回渲染层的错误长这样：
 * `Error: Error invoking remote method 'vault:write': Error: EACCES: permission denied`
 * 直接 toast 出去全是噪音，这里只留最后那句人话。
 */
export function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const tail = raw.split(/Error:\s*/).filter(Boolean).pop()
  return zhError((tail ?? raw).trim() || raw)
}

/**
 * 上游英文报错 → 中文人话（B-5 / T-02）。
 *
 * 起因是一次真实事故：中转站余额耗尽时，客户机上原样弹出
 * `Failed to authenticate. API Error: 403 Your account balance is insufficient`
 * ——开头那句 "Failed to authenticate" 会把人直接引到「是不是密码错了」上去查账号，
 * 而真正的问题是**余额**。文案错一个词，排查方向就整个错了。
 *
 * 规则：**只翻译能确定含义的**，翻不了的原样保留并附一句"把这句发给管理员"。
 * 猜着翻比不翻更危险。
 */
const PATTERNS: Array<[RegExp, string]> = [
  /**
   * 会话恢复失败。**正常情况下用户看不到这条**——主进程会自动放弃过期会话、
   * 拼本地历史开新会话重发（`agent/resume-recovery.ts`）。这里兜的是"连重开那一轮也没成"。
   * 排在最前面是因为原文里带 session ID，落到最后那条英文兜底分支就会把
   * `0d4924db-…` 和「把这句发给管理员」一起端到客户脸上——那串 id 对用户毫无意义。
   */
  [/No conversation found|Session\b(?![^\n]{0,40}\bon server\b)[^\n]{0,80}?\bnot found\b/i, '之前的对话上下文已经过期了，点「重试」会重新开始一段对话；早先聊过的内容可能需要你再说一遍'],
  [/balance is insufficient|insufficient balance|insufficient_quota/i, 'AI 服务余额不足，请联系管理员充值（不是密码问题）'],
  [/rate.?limit|429|too many requests/i, 'AI 服务请求过于频繁，稍等一会儿再试'],
  [/401|unauthorized|invalid api key|authentication_error/i, 'AI 服务的密钥无效或已过期，请在设置里重新获取服务端配置'],
  [/403(?!.*balance)|permission denied.*api|forbidden/i, 'AI 服务拒绝了这次请求（权限或配额问题），请联系管理员'],
  [/model .*(not found|cannot be routed)|invalid model/i, '这条线路不支持当前模型，请在管理员区检查模型串'],
  [/timeout|timed out|ETIMEDOUT/i, '请求超时，检查网络后重试'],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, '连不上服务器，请检查网络'],
  [/ECONNREFUSED/i, '服务器拒绝连接，请检查设置里的服务器地址'],
  [/fetch failed|network error|Failed to fetch/i, '网络请求失败，请检查网络连接'],
  [/EACCES|permission denied/i, '没有权限读写这个文件，请检查文件权限'],
  [/ENOSPC/i, '磁盘空间不足'],
  [/Reached maximum number of turns/i, 'AI 的处理轮次用完了，请把要求拆小一点再试'],
]

export function zhError(raw: string): string {
  for (const [re, zh] of PATTERNS) {
    if (re.test(raw)) return zh
  }
  // 整句都是英文且没匹配到 → 原样留着，但告诉用户该拿它做什么。
  // 猜着翻译比不翻译更危险：翻错了会把排查方向整个带偏（那正是这个模块的由来）
  if (/^[\x00-\x7F\s]+$/.test(raw) && /[a-zA-Z]{4,}/.test(raw)) {
    return `${raw}（这是上游返回的原文，可把这句发给管理员排查）`
  }
  return raw
}

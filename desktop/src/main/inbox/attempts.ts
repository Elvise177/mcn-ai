/**
 * 投递箱的**失败次数账**（PLAN-v2 批 5 F11 / 审计 Q10）。
 *
 * ## 要防的那个循环
 *
 * 某个阶段抛异常 → `cli.py` 后续全 skip、**原件不归档**（还躺在投递箱里）→
 * 应用重启，watcher 以 `ignoreInitial:false` 重新拾起它 → 整条链再跑一遍 → 再崩。
 * 一个坏文件能让每次启动都白跑一轮，**而打标是要花钱的**。
 * 审计原话：「坏文件每次启动重跑整条链、反复烧额度」。
 *
 * ## 判据抽在这里的理由
 *
 * 要真造出这个循环得先弄坏一个阶段、再反复重启应用，每轮还要等 pipeline 跑完——
 * 属于「花钱/等几十分钟才触发」那一类（desktop/CLAUDE.md 铁律），所以判据抽成纯函数，
 * `smoke:guards` 喂合成状态几毫秒验完。orchestrator 只负责读盘、搬文件、写盘。
 *
 * ## 一条刻意的选择：**只数"跑完还留在投递箱里"**
 *
 * 不去区分"哪个阶段失败了"——阶段失败的形态太多（转换崩、打标崩、归档崩），
 * 而用户在意的事实只有一个：**这个文件反复进不去**。留在投递箱 = 没进去。
 * 成功进了 `.done` 的文件下一轮自然不在清单里，计数随之清零（见 `judgeAttempts`）。
 */

/** 同一个文件连着几轮没能入库就不再自动重跑。3 = 两次重试的机会，够覆盖"当时被占用"这类一次性故障 */
export const MAX_ATTEMPTS = 3

export interface AttemptRecord {
  count: number
  lastAt: number
  lastReason?: string
}

/** 投递箱相对路径 → 失败记录。落盘在 `<投递箱>/.failed/attempts.json` */
export type Attempts = Record<string, AttemptRecord>

export interface AttemptsVerdict {
  /** 写回盘上的新账本 */
  next: Attempts
  /** 这一轮达到上限、该搬进 `.failed/` 的文件（投递箱相对路径） */
  giveUp: string[]
}

/**
 * @param prev        盘上的旧账
 * @param stillThere  这一轮跑完之后**仍然留在投递箱里**的文件（相对路径）
 * @param reason      这一轮的失败原因（写进 `失败原因.txt`），跑成功了就传 undefined
 * @param now         时间戳（传进来而不是内部取，测试才好写）
 */
export function judgeAttempts(
  prev: Attempts,
  stillThere: string[],
  reason: string | undefined,
  now: number
): AttemptsVerdict {
  const here = new Set(stillThere)
  const next: Attempts = {}
  const giveUp: string[] = []

  // **先清账**：上一轮记过、这一轮已经不在投递箱里的，说明它进去了——记录直接丢掉。
  // 不清的话，一个文件今天失败两次、下个月又失败一次就会被判"连续三次"，
  // 而它中间明明成功过。"连续"这个词得当真。
  for (const rel of stillThere) {
    const p = prev[rel]
    const count = (p?.count ?? 0) + 1
    if (count >= MAX_ATTEMPTS) {
      giveUp.push(rel)
      continue // 搬走了就不再留账，免得它在 attempts.json 里长住
    }
    next[rel] = { count, lastAt: now, lastReason: reason ?? p?.lastReason }
  }
  return { next, giveUp }
}

/** 搬进 `.failed/` 时写给用户看的那句话。**要说清"为什么不再自动重试"**，不然像是被吞了 */
export function giveUpReason(rec: AttemptRecord | undefined, lastReason?: string): string {
  const why = lastReason ?? rec?.lastReason
  return (
    `连续 ${MAX_ATTEMPTS} 轮都没能入库，已经停止自动重试（避免每次启动都重跑一遍）。` +
    (why ? `\n    最近一次的情况：${why}` : '') +
    `\n    修好之后可以在投递箱的失败清单里点「全部重试」。`
  )
}

/**
 * 解析 `.failed/<日期>/失败原因.txt`，得到「文件名 → 原因」。
 *
 * **这个函数是补一个从没成立过的解析**（2026-09-04 做 F11 时发现）：
 * 盘上那份是 pipeline 写的，格式是
 *
 *     · 工作-执行类/直播脚本1.md
 *         原因：暂不支持 .md 格式
 *
 * 而 `failedList()` 原来按 `文件名 —— 原因` 去 split，两种破折号一个都不在文件里——
 * **判据永远不成立，于是 `reason` 恒为 undefined**：原因老老实实写进了磁盘，
 * 界面上的失败清单却只有一串光秃秃的文件名。0.1.2 特意修过"把原因整个扔掉"那次，
 * 修的是 pipeline 那一半，读的这一半没跟上。
 *
 * 按**文件名（basename）**索引：原件搬进 `.failed/` 时是 `shutil.move(f, dir/f.name)`，
 * 盘上只有 basename，而清单里写的是相对路径。
 */
export function parseFailReasons(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  let cur: string | null = null
  for (const line of raw.split('\n')) {
    const item = line.match(/^\s*[·•\-*]\s*(.+?)\s*$/)
    if (item) {
      // 相对路径 → basename（盘上的文件名）；两边都记，谁匹配上算谁
      const rel = item[1]
      cur = rel.split('/').pop() ?? rel
      continue
    }
    const why = line.match(/^\s+(?:原因|reason)\s*[：:]\s*(.+?)\s*$/)
    if (why && cur) {
      out[cur] = out[cur] ? `${out[cur]} ${why[1]}` : why[1]
      continue
    }
    // 原因的续行（缩进但没有「原因：」前缀）：接到上一条后面。
    // `giveUpReason` 就是多行的，丢掉续行等于把"下一步怎么办"那句话吞了
    if (cur && out[cur] && /^\s{2,}\S/.test(line)) out[cur] = `${out[cur]} ${line.trim()}`
  }
  // 兼容老格式 `文件名 —— 原因`（没在盘上见过，但删掉它没有好处）
  for (const line of raw.split('\n')) {
    const p = line.split(/\s+—+\s+|\s+--\s+/)
    if (p.length >= 2 && p[0].trim() && !out[p[0].trim()]) out[p[0].trim()] = p.slice(1).join(' ').trim()
  }
  return out
}

/** 坏掉的 attempts.json 不该让整条链停摆：解析不了就当没有账，从头数 */
export function parseAttempts(raw: string): Attempts {
  try {
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: Attempts = {}
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const r = v as Partial<AttemptRecord>
      if (typeof r?.count === 'number' && r.count > 0) {
        out[k] = {
          count: Math.floor(r.count),
          lastAt: typeof r.lastAt === 'number' ? r.lastAt : 0,
          ...(typeof r.lastReason === 'string' ? { lastReason: r.lastReason } : {}),
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

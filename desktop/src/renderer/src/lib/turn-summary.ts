/**
 * 一轮跑完之后那句折叠摘要的**全部算法**（Q7 / Q15 / N9，PLAN-v2 批 2）。
 *
 * **为什么单独一个文件**：这里每一条判据都只有在真实调用下才走得到——
 * 产物轮要真做一个 PPT、失败步要真挂一次工具、`degraded` 更是想造都造不出来
 * （得让服务端偷偷把模型换掉）。按 desktop/CLAUDE.md 的铁律，这类逻辑必须能零花费断言，
 * 而 `step-stream.ts` 里有 `window.api` 与 useSyncExternalStore，主进程侧的
 * `smoke:steps` 编译不过去。所以算法住这儿：**不碰 DOM、不碰 window、不用全局类型**。
 */

/** 与全局的 `TierId` 同值；这里不引全局声明，才好被主进程侧的冒烟直接 import */
export type TurnTier = 'standard' | 'enhanced'

/** 摘要只关心步骤的这几个字段（`StepItem` 是它的超集） */
export interface SummaryStep {
  id: string
  tool: string
  args: Record<string, string>
  status: 'running' | 'done' | 'failed'
  count?: number
  unit?: 'file' | 'match'
  capped?: boolean
}

/** 这一轮实际怎么跑的（Q15）：档位 + 有没有被服务端换掉模型 */
export interface TurnMeta {
  tier?: TurnTier
  degraded?: boolean
}

/**
 * 「检索了 N 份资料」里的 N：**这一轮真正被摆到眼前的资料份数**。
 *
 * 口径（走查按同一套算法独立重算一遍对账）：
 *  - 只算**份**（`unit==='file'`）：Grep 的 content 模式吐的是一篇里的几十行命中，
 *    把那个数加进来，"检索了 42 份资料"就成了瞎报——实际只翻了一篇
 *  - **失败的步骤不算**：那一步什么都没摆到眼前
 *  - **同一篇只算一次**：模型撞墙时会把同一篇读三遍
 *  - 生成产物、写文件这类动作不是"资料"，不计
 *
 * 仍然做不到的：检索与扫描之间、以及几次检索之间的**重复命中去不掉**——
 * 工具只回条数，回不了路径。所以这个数是"命中条目数"，不是"不重复的笔记数"。
 */
export function resourceCount(steps: SummaryStep[]): number {
  let n = 0
  /** 同一篇被读了三遍（模型撞墙重试时很常见）只能算一份 */
  const readOnce = new Set<string>()
  for (const s of steps) {
    // 失败的、以及被护栏拦下的那一步，什么都没摆到眼前，不能算进"检索了 N 份资料"
    if (s.status === 'failed' || s.capped) continue
    if (s.tool === 'Read') {
      const k = s.args.file ?? s.id
      if (readOnce.has(k)) continue
      readOnce.add(k)
      n += 1
    } else if (s.tool === 'search_knowledge' || s.tool === 'Grep' || s.tool === 'Glob') {
      if (s.unit === 'file') n += s.count ?? 0
    }
  }
  return n
}

/**
 * 这一轮**做出东西来了没有**（Q7）。
 *
 * 判据只认"成功落地的产物类步骤"：生成 PPT/文档，或往库里写过文件。
 * 失败的那一步不算——它什么都没落下来。
 */
export function producedArtifact(steps: SummaryStep[]): boolean {
  return steps.some(
    (s) =>
      s.status === 'done' &&
      (s.tool === 'render_pptx' || s.tool === 'render_document' || s.tool === 'Write' || s.tool === 'Edit')
  )
}

/** 这一轮有几步是真失败的（被护栏拦下的不算——那是我们自己踩的刹车，不是出错） */
export function failedCount(steps: SummaryStep[]): number {
  return steps.filter((s) => s.status === 'failed' && !s.capped).length
}

/**
 * 折叠行尾的档位说明（Q15）。
 *
 * 「档位静默降级只 warn + 记 degraded」是审计里的原话：用户选了增强档、付了增强档的钱，
 * 界面上却照常显示「增强」，**唯一知道真相的地方是主进程日志**。
 * 这里把结论摆到他眼前——降级时说的是"实际按什么跑的"，不是"你选了什么"。
 */
export function tierNote(tier?: TurnTier, degraded?: boolean): string {
  if (degraded) return '已按标准档执行'
  if (tier === 'enhanced') return '增强档'
  if (tier === 'standard') return '标准档'
  return ''
}

/**
 * 折叠成一行的那句摘要。句法 = **动词 + 数量 + 失败数**（N9）。
 *
 * **第三分支是 Q7**：纯产物轮（"把 XX 做成 PPT"，一次检索都没有）以前落到
 * 「核对完成，未找到相关资料」——正文里 PPT 明明已经生成好了，摘要却在自打脸。
 * 三种收场各说各的：检索到了 / 只做了产物 / 真的什么都没找到。
 *
 * **失败数也必须进这一行**：折叠之后失败的那几步就藏起来了，
 * 「检索了 5 份资料」与「试了 8 次挂了 3 次、检索到 5 份」在界面上原来长得一模一样。
 */
export function summaryText(steps: SummaryStep[], elapsedMs?: number, meta?: TurnMeta): string {
  const n = resourceCount(steps)
  const secs = elapsedMs ? `${(elapsedMs / 1000).toFixed(1)}s` : '—'
  const made = producedArtifact(steps)
  const head =
    n > 0
      ? made
        ? `检索了 ${n} 份资料 · 已生成产物`
        : `检索了 ${n} 份资料`
      : made
        ? '已生成产物'
        : '核对完成，未找到相关资料'
  const bad = failedCount(steps)
  const note = tierNote(meta?.tier, meta?.degraded)
  return [head, bad ? `${bad} 步没成功` : '', `用时 ${secs}`, note].filter(Boolean).join(' · ')
}

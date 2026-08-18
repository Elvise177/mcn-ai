/**
 * 过程可见性 · 主进程侧：把 SDK 的 tool_use / tool_result 提炼成「步骤事件」。
 *
 * 四条刻意的设计：
 *  1. **只透传够用的入参，不透传整个 input**：模型给 Grep 的 `-A/-B/output_mode`、
 *     给 render_pptx 的整份 outline JSON 都没有呈现价值，而 outline 动辄几 KB——
 *     整包塞进流式事件等于给每次工具调用加一条大 payload。
 *  2. **不在这一层翻译成中文**：主进程只给「工具名 + 参数 + 结果数」，
 *     业务语言（"正在检索资料库：…"）全部在渲染层的 config/steps.ts 里。
 *     否则文案改一个字都要动主进程，还得跨进程对齐。
 *  3. **结果数要带上单位**：Grep 的 `Found 7 files` 是**七份笔记**，而 content 模式
 *     吐出来的是**若干行命中**，两者混成一个数字，"检索了 N 份资料"就成了瞎报。
 *     数不出来就回 undefined——**宁可不显示数字，也不显示一个编出来的数字**。
 *  4. **基础设施工具不进步骤流**（见 NOISE_TOOLS）。
 */

/** 结果条数的单位：份（笔记）还是处（行内命中） */
export type ResultUnit = 'file' | 'match'

/** 一条工具步骤在流式事件里的形态。三个阶段共用一个 id 串起来 */
export interface ToolStepEvent {
  id: string
  /** 原始工具名（已去掉 `mcp__xxx__` 前缀）。**只用于查映射表，渲染层不显示** */
  tool: string
  /**
   * start = tool_use 块开始（此刻只有工具名，入参还在流）
   * args  = 完整 assistant 消息到达，入参齐了
   * result= tool_result 回来了，回填结果数
   */
  phase: 'start' | 'args' | 'result'
  /** phase='args'：精简后的入参（检索词 / 文件名 / 扫描目标 / 产物类型） */
  args?: Record<string, string>
  /** phase='result'：这一步拿回来几条结果；数不出来就不给（别编数字） */
  count?: number
  /** phase='result'：`count` 的单位 */
  unit?: ResultUnit
  /**
   * phase='result'：这些结果是**相近结果**，不是精确命中。
   *
   * 两个来源：本地检索的模糊回退（文本里带"相近结果"警示），以及**云端语义检索**
   * ——它压根没有相关度闸门（`012_fix_ranking.sql` 只有 order+limit），
   * 恒定返回 top-6，0.41 的噪声和精确命中长得一模一样（§3-13）。
   * 条数照实报（与返回给模型的内容严格一致），但必须标出来它是"相近"，
   * 否则界面说"检索到 6 份"而正文说"没找到"，用户只会觉得有一边在撒谎。
   */
  approx?: boolean
  /** phase='result'：工具自己报错了（tool_result 的 is_error） */
  failed?: boolean
  /**
   * phase='result'：这一步是被**扫描次数护栏**拦下的，不是失败。
   * 画成红色的「这一步没成功」会让人以为出了故障，而它其实是我们自己有意踩的刹车。
   */
  capped?: boolean
}

/**
 * **不进步骤流的工具**：它们是 SDK 自己的基础设施，不是用户要的活儿。
 *
 * `Skill` 是踩出来的（2026-08-18 走查现场）：SDK 没关内置技能（`options.skills` 没配 →
 * 走 CLI 默认），模型每轮开头会调一次 `Skill` 去翻内置技能清单，秒回、什么也没产出，
 * 于是步骤流第一条永远是一个莫名其妙的「正在处理」。而**这个产品的产物是
 * `render_pptx` / `render_document` 出的**（系统提示词第 5 条钉死），
 * `resources/skills/` 里也只有一个 `.gitkeep`——`Skill` 在这里注定产不出东西。
 *
 * 注意这跟「未映射工具兜底『正在处理』」不冲突：兜底管的是**没见过的活儿**，
 * 这张表管的是**明确不算活儿的东西**。
 */
const NOISE_TOOLS = new Set(['Skill', 'TodoWrite', 'SlashCommand', 'ExitPlanMode'])

/** 工具名去前缀：`mcp__knowledge__search_knowledge` → `search_knowledge` */
export function shortToolName(name: string): string {
  return name.replace(/^mcp__\w+__/, '')
}

/** 这个工具该不该在步骤流里露面 */
export function isStepWorthy(tool: string): boolean {
  return !NOISE_TOOLS.has(shortToolName(tool))
}

/** 入参里的字符串字段：空白丢弃，超长截断（步骤行是一行字，塞不下也没人看） */
function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s ? s.slice(0, 120) : undefined
}

/**
 * 路径**相对库根**。模型给的是绝对路径，直接透出去会变成
 * 「mcnai-e2e-vault 里含「灰太太」的笔记」——把库目录自己的名字当成了分区名。
 * 正好是库根本身就返回空（"整个库"没有名字可说）。
 */
function relToRoot(p: string | undefined, root: string): string | undefined {
  if (!p) return undefined
  if (!root || !p.startsWith(root)) return p
  const rel = p.slice(root.length).replace(/^[/\\]+/, '')
  return rel || undefined
}

/**
 * 从工具入参里挑出**有呈现价值**的那几个字段。
 * 白名单式：没列出来的工具回空对象（渲染层走兜底文案「正在处理」，仍然不露工具原名）。
 */
export function pickStepArgs(tool: string, input: Record<string, unknown> = {}, root = ''): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (k: string, v?: string): void => {
    if (v) out[k] = v
  }
  const path = (v: unknown): string | undefined => relToRoot(str(v), root)
  switch (shortToolName(tool)) {
    case 'search_knowledge':
      put('query', str(input.query))
      break
    case 'Read':
      put('file', path(input.file_path) ?? path(input.path))
      break
    case 'Grep':
      put('pattern', str(input.pattern))
      put('path', path(input.path))
      put('glob', str(input.glob))
      break
    case 'Glob':
      put('pattern', str(input.pattern))
      put('path', path(input.path))
      break
    case 'Bash':
      put('command', str(input.command))
      break
    case 'render_pptx':
      put('filename', str(input.filename))
      break
    case 'render_document':
      put('filename', str(input.filename))
      put('format', str(input.format))
      break
    case 'Write':
    case 'Edit':
      put('file', path(input.file_path))
      break
    default:
      break
  }
  return out
}

/** 护栏拒绝语的指纹（与 agent/index.ts 的 PreToolUse 钩子里那句对齐） */
export const SCAN_CAP_MARK = '文件查找次数已达上限'

/** tool_result 的 content 可能是字符串，也可能是 `[{type:'text',text}]` */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('\n')
  }
  return ''
}

/**
 * 这一步拿回来几条结果，**以及那个数字的单位**。数不出来回 undefined。
 *
 * - `search_knowledge` 是我们自己的工具，返回格式固定（编号列表 / 「（无命中）」）→ 份
 * - Grep 的 `Found N files` → 份；Glob 吐一串路径 → 份
 * - Grep 的 content 模式吐的是**逐行命中**（同一篇里可能几十行）→ 处，不能当份数
 */
export function countToolResults(
  tool: string,
  text: string
): { count: number; unit: ResultUnit; approx?: boolean } | undefined {
  const t = text.trim()
  const short = shortToolName(tool)
  if (short === 'search_knowledge') {
    if (!t || t.includes('（无命中）')) return { count: 0, unit: 'file' }
    // 「相近」的两种形态：本地模糊回退自己会说；云端那条**不会说**，
    // 只能靠它的格式认（`1. [我的] (my_script, 相关度0.42)`）——它没有阈值，全都是相近
    const approx = t.includes('相近结果') || /相关度\s*[\d.]/.test(t)
    return { count: (t.match(/^\s*\d+\.\s/gm) ?? []).length, unit: 'file', approx }
  }
  if (short === 'Grep' || short === 'Glob') {
    if (!t) return { count: 0, unit: 'file' }
    const m = t.match(/Found\s+(\d+)\s+files?/i)
    if (m) return { count: Number(m[1]), unit: 'file' }
    if (/^No (?:files|matches|content) found/i.test(t)) return { count: 0, unit: 'file' }
    const lines = t.split('\n').filter((l) => l.trim())
    // Glob 只会吐路径 → 份；Grep 走到这里说明不是 files_with_matches → 逐行命中 → 处
    return { count: lines.length, unit: short === 'Glob' ? 'file' : 'match' }
  }
  return undefined
}

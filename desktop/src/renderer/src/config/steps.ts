/**
 * 过程可见性 · 步骤文案映射表（渲染层唯一真相源）。
 *
 * 主进程只给「工具名 + 入参 + 结果数」，翻译成业务语言全在这里——
 * 文案要改一个字不该动主进程，更不该让两个进程各存一份说法。
 *
 * **铁律：这里产出的任何一句话都不许出现工具原名。**
 * 未映射的工具走 `FALLBACK`（「正在处理」），宁可说得笼统，也不把 `Grep` 甩给用户看。
 */

export type StepKind = 'search' | 'read' | 'scan' | 'verify' | 'artifact' | 'file' | 'other'

export interface StepPhrase {
  /** 供 e2e / 样式区分用的语义分类（**不是**工具名，DOM 上不会泄漏英文工具名） */
  kind: StepKind
  text: string
}

export interface StepCtx {
  /** 这一步是「验证性扫描」：上一次检索 0 命中，模型在确认库里是真的没有 */
  verify?: boolean
  /** 结果数（tool_result 回填）。undefined = 数不出来，那就别显示数字 */
  count?: number
  /** `count` 的单位：份（笔记）还是处（行内命中）。两者混着说就是瞎报 */
  unit?: 'file' | 'match'
  /** 相近结果（非精确命中）：条数照实报，但要标出来 */
  approx?: boolean
  /** 被扫描次数护栏拦下：说清楚是"到上限了"，不是"出错了" */
  capped?: boolean
  /** 已经拿到结果了（进行中 / 已完成两套文案） */
  done?: boolean
  /**
   * 这一步自己报错了（N9 的「失败数」在单步这一级的形态）。
   *
   * 以前这句话是**组件里拼的**（StepStream 里一段 `（这一步没成功）`），
   * 于是"文案唯一真相源在 config/steps.ts"这条约定有一个例外——而且是最该说清楚的那一句。
   * 收回来之后，走查扫"步骤文案里不许有工具原名"这类断言才真的覆盖得到它。
   */
  failed?: boolean
  /**
   * 产物类任务的历史耗时中位数（毫秒），来自 usage jsonl 的 `byType.medianMs`。
   * **禁止写死时长**：机器快慢、模型、资料量都不一样，写死的数字第一天就是错的。
   */
  medianMs?: number
}

// ---- 参数清洗 ----

/** `20_公司管理/25_达人档案/灰太太.md` → `灰太太` */
function fileTitle(p?: string): string {
  if (!p) return ''
  const base = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
  return base.replace(/\.[a-z0-9]+$/i, '').trim()
}

/** 单个分支：把正则/通配符符号剥掉，留下人能读的那部分 */
function cleanAlt(p: string): string {
  return p
    .replace(/\*\*?[/\\]/g, '') // `**/`
    .replace(/\.[*+]/g, ' ') // `灰太太.*GMV` 里的「.*」= 中间随便什么 → 读成空格
    .replace(/\\./g, '') // 转义符
    .replace(/[*?[\]{}()^$\\+]/g, '')
    .replace(/\.(md|txt|docx?|pdf|xlsx?|pptx?)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    // 关键词写成路径的（模型爱这么猜：`20_公司管理/24_业务数据/`）只留末级目录名，
    // 整条路径摆在步骤行里既长又像内部实现
    .replace(/^.*[/\\]([^/\\]+)[/\\]?$/, '$1')
}

/**
 * 纯技术串：检索结果里的内部字段名（`my_script` / `source_type` / `hot_script`）。
 * 模型会把它们当关键词去扫库（§3-13 的铁证），扫出来的步骤行就成了技术黑话。
 * 这类词**不摆给用户看**——判据取 snake_case，普通英文词（GMV / Hogwarts）不误伤。
 */
const TECHY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

/**
 * 把 Grep 的 pattern 变成人话：`**\/*达人*.md` → `达人`。
 *
 * **多关键词必须分隔开**（真人验收 2026-08-18 指出）：模型爱写
 * `灰太太.*GMV|灰太太.*出单`，老写法把 `|` 和 `.` 一并抹掉，糊成
 * 「灰太太.GMV灰太太.出单」——句点黏连，读起来像乱码。现在按 `|` 拆开、
 * 逐个清洗、用顿号连起来。
 */
function cleanPattern(p?: string): string {
  if (!p) return ''
  const alts = p.split('|').map(cleanAlt).filter(Boolean).filter((a) => !TECHY.test(a))
  if (!alts.length) return ''
  // 关键词太多时只报前几个：步骤行是一行字，十几个词铺开就没法读了
  const shown = alts.slice(0, 4).join('、')
  return alts.length > 4 ? `${shown} 等 ${alts.length} 个词` : shown
}

/**
 * 扫描目标：给「正在逐份核对{目标}」里的那个目标。
 *
 * 三种形态，因为它们的量词完全不同：
 *  - 指到**一篇笔记**（path 带扩展名）→ 逐行找，说「命中 N 处」
 *  - 指到**一个目录** → 逐份翻，说「核对了 N 份」
 *  - 什么都没指 → 整个库
 * 目标为空的话「正在逐份核对」就成了半句话，所以兜底也要给一个说法。
 */
export function scanTarget(a: Record<string, string>): {
  /** 数「份」时用：一批笔记的说法，如「20_公司管理 里含「年度目标」的笔记」 */
  text: string
  /** 数「处」时用：翻的是哪儿，如「《年框合作》」「产品」「库」 */
  where: string
  /** 找的是什么词（可能没有） */
  kw: string
  /** 目标是单独一篇笔记（逐行找），不是一批 */
  note: boolean
} {
  const kw = cleanPattern(a.pattern) || cleanPattern(a.glob)
  const raw = (a.path ?? '').replace(/[/\\]+$/, '')
  const base = raw && raw !== '.' ? (raw.split(/[/\\]/).pop() ?? '') : ''
  // 库根在主进程那侧已经剥掉了（relToRoot），所以 base 要么是分区名要么是笔记名
  if (base && /\.[a-z0-9]+$/i.test(base)) {
    const title = `《${base.replace(/\.[a-z0-9]+$/i, '')}》`
    return { text: kw ? `${title}里的「${kw}」` : title, where: title, kw, note: true }
  }
  const where = base || '库'
  if (base && kw) return { text: `${base} 里含「${kw}」的笔记`, where, kw, note: false }
  if (base) return { text: `${base} 里的笔记`, where, kw, note: false }
  if (kw) return { text: `含「${kw}」的笔记`, where, kw, note: false }
  return { text: '库中笔记', where, kw, note: false }
}

/** 产物类型：给「正在生成{产物类型}」里的那个类型 */
function artifactLabel(tool: string, a: Record<string, string>): string {
  if (tool === 'render_pptx') return 'PPT'
  const f = (a.format ?? '').toLowerCase()
  if (f === 'xlsx') return 'Excel 表格'
  if (f === 'pdf') return 'PDF'
  if (f === 'docx') return 'Word 文档'
  return '文档'
}

/** 产物类任务归到哪个用量类型（medianMs 从那一格取） */
export function artifactUsageType(tool: string): 'make-ppt' | 'make-docx' | null {
  if (tool === 'render_pptx') return 'make-ppt'
  if (tool === 'render_document') return 'make-docx'
  return null
}

/**
 * 时长提示。**只有两种形态，都不写死秒数**：
 *  - 有历史数据 → 「通常约 X 秒」（X 来自本机 usage jsonl 的中位数）
 *  - 没有历史数据（新装机 / 第一次做产物）→ 「内容较多时需要几分钟」
 * 阈值取 1 秒：中位数小于 1 秒说明样本是脏的（失败轮/空轮），当没有更诚实。
 */
export function durationHint(medianMs?: number): string {
  if (!medianMs || medianMs < 1000) return '内容较多时需要几分钟'
  return `通常约 ${Math.round(medianMs / 1000)} 秒`
}

// ---- 映射表 ----

type Phraser = (a: Record<string, string>, c: StepCtx) => StepPhrase

export const STEP_MAP: Record<string, Phraser> = {
  search_knowledge: (a, c) => {
    const q = a.query?.trim()
    const kw = q ? `：${q}` : ''
    if (!c.done) return { kind: 'search', text: `正在检索资料库${kw}` }
    // 条数与"返回给模型的内容"严格一致，但**相近结果必须标出来**：
    // 云端语义检索没有相关度闸门，恒定返回 top-6（§3-13）。不标的话界面说"检索到 6 份"、
    // 正文说"没找到"，用户只会觉得有一边在撒谎——而两边都没撒谎
    const n = c.count === undefined ? '' : c.approx ? `（相近结果 ${c.count} 条）` : `（${c.count} 条）`
    return { kind: 'search', text: `检索了资料库${kw}${n}` }
  },

  Read: (a, c) => {
    const t = fileTitle(a.file)
    const what = t ? `《${t}》` : '笔记'
    return { kind: 'read', text: c.done ? `阅读了${what}` : `正在阅读${what}` }
  },

  Grep: (a, c) => scanPhrase('Grep', a, c),
  Glob: (a, c) => scanPhrase('Glob', a, c),

  // pipeline / 产物类命令：命令行本身对用户毫无意义，只说在干什么
  Bash: (_a, c) => ({ kind: 'file', text: c.done ? '处理完文件' : '正在处理文件' }),

  render_pptx: (a, c) => artifactPhrase('render_pptx', a, c),
  render_document: (a, c) => artifactPhrase('render_document', a, c),

  Write: (_a, c) => ({ kind: 'file', text: c.done ? '写入了产物' : '正在写入产物' }),
  Edit: (_a, c) => ({ kind: 'file', text: c.done ? '修改了产物' : '正在修改产物' }),
}

/** 未映射的工具：说得笼统，但**绝不露工具原名** */
export const FALLBACK: Phraser = (_a, c) => ({ kind: 'other', text: c.done ? '已处理' : '正在处理' })

function scanPhrase(tool: string, a: Record<string, string>, c: StepCtx): StepPhrase {
  const { text: target, where, kw, note } = scanTarget(a)
  /**
   * 完成态：量词跟着单位走——「份」是笔记，「处」是行内命中。
   * 数「处」的时候不能沿用数「份」那句话：「核对了产品 里含「灰太太」的笔记，命中 11 处」
   * 把"一批笔记"和"多少行"叠在一起说，读着别扭；改成「核对了产品里的「灰太太」，命中 11 处」。
   */
  const doneText = (): string => {
    if (c.count === undefined) return `核对了${target}`
    if (note || c.unit === 'match') {
      return kw ? `核对了${where}里的「${kw}」，命中 ${c.count} 处` : `核对了${where}，命中 ${c.count} 处`
    }
    return `核对了 ${c.count} 份${target}`
  }
  /**
   * 验证性扫描：检索已经 0 命中，这一遍是在"确认库里真的没有"（系统提示词第 4 条）。
   * 说成"正在逐份核对"会让人以为还在找资料，其实结论多半是"没有"。
   *
   * **必须带上确认目标**（真人对照截图指出，2026-08-18）：三次扫的是不同的东西
   * （Grep 翻正文、Glob 比文件名、换个词再扫一遍），却都显示成一模一样的
   * 「已确认库中没有相关记录」，连着三条读起来像复读机，也看不出它到底查过哪些地方。
   */
  if (c.verify) {
    const field = tool === 'Glob' ? '文件名' : '正文'
    // 指到某一篇/某个分区时把范围也说出来；整库扫就不必画蛇添足说"库的"
    // 分区名前后留空格：「已确认20_公司管理 的正文里…」挤在一起不好读
    const scope = note ? where : where && where !== '库' ? ` ${where} 的` : ''
    const what = kw ? `「${kw}」` : tool === 'Glob' ? '匹配' : '相关记录'
    if (!c.done) return { kind: 'verify', text: `正在确认${scope}${field}里有没有${what}` }
    if (!c.count) return { kind: 'verify', text: `已确认${scope}${field}里没有${what}` }
    return { kind: 'scan', text: doneText() }
  }
  if (!c.done) return { kind: 'scan', text: note ? `正在逐行核对${target}` : `正在逐份核对${target}` }
  return { kind: 'scan', text: doneText() }
}

function artifactPhrase(tool: string, a: Record<string, string>, c: StepCtx): StepPhrase {
  const what = artifactLabel(tool, a)
  // 「正在生成PPT」挤在一起不好读，中西文之间补个空格；纯中文的「文档」就不补
  const sep = /^[A-Za-z]/.test(what) ? ' ' : ''
  if (c.done) return { kind: 'artifact', text: `已生成${sep}${what}` }
  return { kind: 'artifact', text: `正在生成${sep}${what}（${durationHint(c.medianMs)}）` }
}

/**
 * 查表出文案。工具名进得来、出不去——返回值里只有中文业务语言。
 *
 * N9 的句法：**动词 + 数量 + 失败数**。前两截由各自的 phraser 给，
 * 最后一截在这里统一补——「没成功」四个字不该有三种写法。
 */
export function describeStep(tool: string, args: Record<string, string>, ctx: StepCtx): StepPhrase {
  // 护栏拦下的那一步：它没去找、也没出错，说成「核对了…」或「没成功」都是假话
  if (ctx.capped) return { kind: 'other', text: '已达本轮文件查找上限，改用已有材料作答' }
  const p = (STEP_MAP[tool] ?? FALLBACK)(args ?? {}, ctx)
  // 失败态复用"进行中"的动词会说成「正在检索…（没成功）」，读起来自相矛盾；
  // phraser 拿到的 done 由调用方保证（失败也算"这一步结束了"）
  return ctx.failed ? { ...p, text: `${p.text}（没成功）` } : p
}

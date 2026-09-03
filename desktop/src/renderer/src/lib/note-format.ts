/**
 * 笔记正文的展示前处理：模板类笔记里大量「只有表头没有数据」的表格和
 * 「字段名后面空着」的行，直接渲染出来就是一片空框子和悬空冒号。
 * 这里在 markdown 层面统一收拾，FastMarkdown 与 ReactMarkdown 两条渲染路径共用。
 */

export const EMPTY_MARK = '—'
export const EMPTY_TABLE_TEXT = '暂无数据'

const isSeparatorRow = (line: string): boolean =>
  line.includes('-') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line)
const isTableRow = (line: string): boolean => line.trim().startsWith('|')
const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

/** 只有表头（或数据行全空）的表格 → 折叠成「暂无数据」占位，不渲染空表格 */
function collapseEmptyTables(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!isTableRow(lines[i]) || !lines[i + 1] || !isSeparatorRow(lines[i + 1])) {
      out.push(lines[i])
      continue
    }
    let j = i + 2
    const dataRows: string[] = []
    while (j < lines.length && isTableRow(lines[j])) {
      dataRows.push(lines[j])
      j++
    }
    if (dataRows.some((r) => cellsOf(r).some((c) => c.length > 0))) {
      out.push(...lines.slice(i, j))
    } else {
      // 保留表头文字当说明，省得用户不知道这张表原本要记什么
      const cols = cellsOf(lines[i]).filter(Boolean).join(' / ')
      out.push(cols ? `${EMPTY_TABLE_TEXT}（${cols}）` : EMPTY_TABLE_TEXT)
    }
    i = j - 1
  }
  return out
}

/**
 * 「字段名：」后面空着的补破折号。
 * 一行多段的分隔符半角 | 与全角 ｜ 都要认（达人档案模板用的是全角）；
 * 行尾冒号后面紧跟列表/表格的属于「小节标题」，不算空字段，不补。
 */
function markEmptyValues(lines: string[]): string[] {
  const fill = /([：:])([ \t]*)(?=[|｜]|$)/g
  const fillBeforePipeOnly = /([：:])([ \t]*)(?=[|｜])/g
  return lines.map((line, i) => {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return line // 标题不动
    if (isTableRow(line)) return line
    if (!/[：:]/.test(line)) return line
    const next = lines.slice(i + 1).find((l) => l.trim())
    const isListItem = /^\s*([-*+]|\d+\.)\s/.test(line)
    const isSectionLabel =
      !isListItem && /[：:][ \t]*$/.test(line) && !!next && /^\s*([-*+]|\d+\.|\|)/.test(next)
    return line.replace(isSectionLabel ? fillBeforePipeOnly : fill, `：${EMPTY_MARK}$2`)
  })
}

export function formatNoteBody(md: string): string {
  // 代码块内原样保留：先按围栏切段，只处理非代码段
  const chunks: { fence: boolean; lines: string[] }[] = []
  let cur: { fence: boolean; lines: string[] } = { fence: false, lines: [] }
  let fenceOpen = false
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (fenceOpen) {
        cur.lines.push(line)
        chunks.push(cur)
        cur = { fence: false, lines: [] }
      } else {
        if (cur.lines.length) chunks.push(cur)
        cur = { fence: true, lines: [line] }
      }
      fenceOpen = !fenceOpen
      continue
    }
    cur.lines.push(line)
  }
  if (cur.lines.length) chunks.push(cur)

  return chunks
    .flatMap((c) => (c.fence ? c.lines : markEmptyValues(collapseEmptyTables(c.lines))))
    .join('\n')
}

/** frontmatter 属性值的展示：空值统一给破折号 */
export function formatFrontmatterValue(v: unknown, key?: string): string {
  if (v == null) return EMPTY_MARK
  // 裸 `true`/`false` 是给机器看的（附录 B #1）：用户读到的应该是「是 / 否」
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (Array.isArray(v)) {
    const items = v.map((x) => String(x).trim()).filter(Boolean)
    return items.length ? items.join(' / ') : EMPTY_MARK
  }
  const s = String(v).trim()
  if (!s) return EMPTY_MARK
  // 值本身也可能是英文枚举（`entity_kind: partner`）
  return (key && FM_VALUE[key]?.[s]) ?? s
}

// ---- U3 #1：frontmatter 属性卡的中文映射 ----
//
// 病症（PRODUCT-AUDIT 附录 B #1，严重度最高的一条）：属性卡直接显示英文技术键
// `doc_type / entity_kind / entities_talent / rule_tagged / sub_category` 与裸 `true`，
// **几乎每篇笔记可见**。用户打开自己的笔记，第一眼看到的是我们的内部字段名。
//
// 三条处理：键名映射成中文、值里的英文枚举一并映射、只有系统才关心的字段折进「更多字段」。

/** 键名 → 用户词。映射不到的一律进「更多字段」，宁可折起来也不摆一个英文标识符 */
export const FM_LABEL: Record<string, string> = {
  doc_type: '类型',
  category: '分类',
  sub_category: '子分类',
  summary: '摘要',
  tags: '标签',
  entity_name: '名称',
  entity_kind: '身份',
  entities_talent: '涉及达人',
  entities_product: '涉及产品',
  entities_partner: '涉及合作方',
  sensitive: '敏感资料',
  source: '来源',
  created: '创建时间',
  updated: '更新时间',
  title: '标题',
  aliases: '别名',
}

/** 值也是英文枚举的那几个字段 */
const FM_VALUE: Record<string, Record<string, string>> = {
  entity_kind: { talent: '达人', product: '产品', partner: '合作方' },
}

/**
 * 只有系统内部才关心的字段。**不是"没用"，是"不该占着第一屏"**——
 * 用户需要它们的时候（排查为什么这篇没被打上标签）展开「更多字段」就看得到。
 */
const FM_INTERNAL = new Set(['rule_tagged', 'ai_tagged', 'schema_rev', 'auto_hash', 'doc_id', 'id', 'rev'])

/**
 * 属性卡分两段：认识的键按 `FM_LABEL` 的顺序摆在上面，其余（内部字段 + 没见过的键）
 * 折进「更多字段」。
 *
 * **顺序必须是稳定的**：`Object.entries` 给的是文件里的书写顺序，同一类笔记
 * 由不同阶段写出来就会长得不一样（附录 B #13 chips 锁序同一个病）。
 */
export function splitFrontmatter(
  fm: Record<string, unknown>
): { shown: Array<[string, unknown]>; more: Array<[string, unknown]> } {
  const order = Object.keys(FM_LABEL)
  const entries = Object.entries(fm)
  const known = entries.filter(([k]) => k in FM_LABEL && !FM_INTERNAL.has(k))
  known.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
  return { shown: known, more: entries.filter(([k]) => !(k in FM_LABEL) || FM_INTERNAL.has(k)) }
}

/** 键名的展示写法：认识的给中文，不认识的原样（它只会出现在「更多字段」里） */
export const fmLabel = (k: string): string => FM_LABEL[k] ?? k

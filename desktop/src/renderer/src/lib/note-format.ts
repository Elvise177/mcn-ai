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
export function formatFrontmatterValue(v: unknown): string {
  if (v == null) return EMPTY_MARK
  if (Array.isArray(v)) {
    const items = v.map((x) => String(x).trim()).filter(Boolean)
    return items.length ? items.join(' / ') : EMPTY_MARK
  }
  const s = String(v).trim()
  return s || EMPTY_MARK
}

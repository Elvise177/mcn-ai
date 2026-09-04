import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export const WIKI_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g
const PURIFY_CFG = {
  // 默认会剥掉自定义协议，放行 wiki: 供库内跳转、mcnai-asset: 供库内图片
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|wiki|mcnai-asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:|^\/\//i

/** 把 `a/b/../c` 这类拍平成 `a/c`；越过库根（`..` 太多）返回 null —— 越界的不给出链接 */
function normalizeRel(p: string): string | null {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.length ? out.join('/') : null
}

/**
 * 笔记里的图片引用 → 可加载的 URL。
 *
 * `02_convert` 抽出来的嵌图落在 `<vault>/_assets/<笔记名>/`，正文里写的是**相对笔记的**
 * 路径（`../../_assets/x/img01.png`）。相对路径在渲染进程里会按文档 URL 解析
 * （dev 是 http://localhost，prod 是 out/renderer/index.html），跟 vault 毫无关系 → 必然 404。
 * 所以这里统一换算成库根相对路径，再交给主进程的 `mcnai-asset` 协议（见 main/vault/assets.ts）。
 *
 * `baseDir` = 这篇笔记所在目录（库根相对）。聊天气泡没有归属目录，只认库根相对的写法。
 */
export function assetUrl(src: string, baseDir?: string): string | null {
  if (!src || HAS_SCHEME.test(src)) return null // 已经带协议（http/data/mcnai-asset）就别动
  if (!IMG_EXT.test(src.split(/[?#]/)[0])) return null
  const rel = normalizeRel(baseDir ? `${baseDir}/${src}` : src)
  if (!rel) return null
  /**
   * **先解码再编码，不能直接 encode**（实测踩到）：两条渲染路径喂进来的 src 编码状态不一样——
   * `FastMarkdown` 是在 marked 出完 HTML 之后改写的，中文早被 marked percent-encode 过；
   * `ReactMarkdown` 的 urlTransform 拿到的是 markdown 源里的原文。直接 encode 的话，
   * 前者会把 `%` 再编一次变成 `%25E5%25B8…`，路径对不上、图静默加载不出来（naturalWidth=0）。
   */
  const enc = rel
    .split('/')
    .map((seg) => {
      let s = seg
      try {
        s = decodeURIComponent(seg)
      } catch {
        /* 坏编码就按原文处理 */
      }
      return encodeURIComponent(s)
    })
    .join('/')
  return `mcnai-asset://v/${enc}`
}

/**
 * 给每个代码块套一层带「复制」的壳（F9）。
 *
 * **必须放在 sanitize 之后**：加进去的是我们自己的标签，不该再过一遍消毒
 * （DOMPurify 默认会把 `data-*` 之类留着，但顺序反了就等于让用户内容有机会伪造这颗按钮）。
 *
 * 为什么值得做：AI 给的脚本/表格/JSON 是要**拿去用**的，而在气泡里手动框选一段代码
 * 极容易连行号、连前后文一起选中。整段复制这件事本身就是这个功能的目的。
 */
function wrapCodeBlocks(html: string): string {
  return html
    .replace(/<pre>/g, '<div class="code-block"><button type="button" data-code-copy title="复制代码">复制</button><pre>')
    .replace(/<\/pre>/g, '</pre></div>')
}

/** 改写 HTML 里所有 `<img src>`。**放在 sanitize 之后**：改完就是我们自己的协议，不再经用户内容 */
function rewriteImages(html: string, baseDir?: string): string {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, (m, pre, src, post) => {
    const u = assetUrl(src, baseDir)
    return u ? `${pre}${u}${post}` : m
  })
}

/** marked 快速渲染 + DOMPurify 消毒 + 事件委托链接点击（大文件与聊天流共用） */
export function FastMarkdown({
  body,
  onLink,
  baseDir,
}: {
  body: string
  onLink: (href: string) => void
  /** 这篇笔记所在目录（库根相对），用来把相对图片路径换算成库根相对 */
  baseDir?: string
}) {
  const html = useMemo(() => {
    const pre = body.replace(WIKI_RE, (_m, target: string, alias?: string) =>
      `[${alias || target}](wiki:${encodeURIComponent(target.trim())})`
    )
    return wrapCodeBlocks(
      rewriteImages(
        DOMPurify.sanitize(marked.parse(pre, { gfm: true, breaks: false, async: false }), PURIFY_CFG),
        baseDir
      )
    )
  }, [body, baseDir])

  return (
    <div
      className="md-article"
      onClick={(e) => {
        const el = e.target as HTMLElement
        // F9 代码块复制：事件委托，不给每个块挂一个 React 组件（正文可能有几十个块）
        const copy = el.closest('[data-code-copy]')
        if (copy) {
          e.preventDefault()
          const code = copy.parentElement?.querySelector('pre')?.innerText ?? ''
          if (code) {
            void navigator.clipboard.writeText(code)
            copy.textContent = '已复制'
            setTimeout(() => {
              copy.textContent = '复制'
            }, 1500)
          }
          return
        }
        const a = el.closest('a')
        if (a) {
          e.preventDefault()
          const href = a.getAttribute('href')
          if (href) onLink(href)
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

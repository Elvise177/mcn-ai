import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export const WIKI_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g
const PURIFY_CFG = {
  // 默认会剥掉自定义协议，放行 wiki: 供库内跳转
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|wiki):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
}

/** marked 快速渲染 + DOMPurify 消毒 + 事件委托链接点击（大文件与聊天流共用） */
export function FastMarkdown({ body, onLink }: { body: string; onLink: (href: string) => void }) {
  const html = useMemo(() => {
    const pre = body.replace(WIKI_RE, (_m, target: string, alias?: string) =>
      `[${alias || target}](wiki:${encodeURIComponent(target.trim())})`
    )
    return DOMPurify.sanitize(marked.parse(pre, { gfm: true, breaks: false, async: false }), PURIFY_CFG)
  }, [body])

  return (
    <div
      className="md-article"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
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

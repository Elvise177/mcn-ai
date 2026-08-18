import { protocol, net } from 'electron'
import { resolve, sep, extname } from 'path'
import { pathToFileURL } from 'url'
import { vaultManager } from './index'
import { log } from '../lib/logger'

/**
 * 库内图片的自定义协议（A-3 图片能力）。
 *
 * **为什么非要一个协议**：`02_convert` 把嵌图抽到 `<vault>/_assets/…`，笔记正文里留的是
 * 相对引用（`../../_assets/x/img01.png`）。这条引用在渲染进程里有三重死法：
 * ① 相对路径按**渲染进程文档的 URL**解析（dev 是 http://localhost，prod 是
 *    out/renderer/index.html），跟 vault 一点关系没有 → 404；
 * ② 改写成 `file://` 也不行，`Markdown.tsx` 的 DOMPurify 白名单只放行 https?/mailto/wiki，
 *    `file:` 会被整个剥掉；
 * ③ 就算放行，dev 形态下 http 页面加载 file:// 资源会被 webSecurity 拦
 *    （关 webSecurity 换渲染一张图，不划算）。
 * 注册一条自己的协议是唯一在 dev 与打包两种形态下都成立的路。
 *
 * **安全边界**：只服务当前 vault 根之下的图片扩展名文件。路径穿越（`..`）在渲染层
 * 归一时就挡了一道，这里再挡一道——渲染层那道是给正常内容用的，这道是给恶意内容用的
 * （笔记内容可能来自客户自己拖进来的文件，不能假定它善良）。
 */
export const ASSET_SCHEME = 'mcnai-asset'

/** 只放行图片。**不放行 .md/.pdf 等**：那些有自己的打开路径，从这里出去等于开了一个任意读文件的口子 */
const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'])

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
}

/**
 * 必须在 `app.whenReady()` **之前**调用（Electron 的硬性要求）。
 * `standard: true` 让它按标准 URL 解析（否则 host/path 切不开），
 * `supportFetchAPI` + `stream` 让渲染进程能正常当图片资源加载。
 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

/** 在 app ready 之后调用 */
export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (req) => {
    const root = vaultManager.currentRoot
    if (!root) return new Response('未打开知识库', { status: 404 })
    let rel: string
    try {
      rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '')
    } catch {
      return new Response('bad url', { status: 400 })
    }
    const abs = resolve(root, rel)
    const rootAbs = resolve(root)
    // 路径穿越：必须严格落在库根之下（`startsWith(root)` 单独用是不够的——
    // `/vault-evil` 也 startsWith `/vault`，所以要带上分隔符）
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      log('warn', 'assets', `拒绝越界读取：${rel}`)
      return new Response('forbidden', { status: 403 })
    }
    const ext = extname(abs).toLowerCase()
    if (!ALLOWED.has(ext)) return new Response('forbidden', { status: 403 })
    try {
      const res = await net.fetch(pathToFileURL(abs).toString())
      if (!res.ok) return new Response('not found', { status: 404 })
      // net.fetch 拿 file:// 时不给 Content-Type，浏览器会按 sniff 处理；显式给上更稳
      return new Response(res.body, { status: 200, headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

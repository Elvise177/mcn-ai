import { promises as fs, rmSync } from 'fs'
import { join, basename, extname } from 'path'
import { spawn } from 'child_process'
import { app, dialog, nativeImage, type BrowserWindow } from 'electron'
import { pipelineBin } from '../lib/pipeline'
import { log } from '../lib/logger'

/**
 * 对话附件（A-3 图片能力 B'）：用户在输入框挑图片 → 随这条消息提供给 agent →
 * make-ppt / make-docx 可以把它编排进产物。
 *
 * **本单只做「图随消息走」**：附件不进消息模型、不落库（缩略图是内存态 dataURL，
 * 与步骤流同一条原则）。「翻历史对话把当时的附件再拿出来」需要附件进消息模型并落盘，
 * 属结构改动，另立项（见 HANDOFF roadmap）。
 */

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']
/**
 * 文档附件（B7，2026-08-19）：**仅本次对话参考，不入库**。
 *
 * 与图片的区别只有一处——发送前要先转成 markdown（模型读不了二进制 docx）。
 * 其余边界一律照旧：不打标、不建卡、不上云、不进投递箱，会话结束随临时目录清掉。
 * 用户真想长期保存，那条路是把文件拖进窗口（投递箱），提示里会说这句话。
 */
const DOC_EXT = ['docx', 'pdf', 'xlsx', 'pptx', 'md', 'txt']
/** 超过这个体积就别走"临时参考"这条路了——转换慢、上下文也塞不下，提示改走入库 */
const DOC_MAX_BYTES = 20 * 1024 * 1024

export interface PickedAttachment {
  /** 用户原始文件路径。**不直接交给 agent**——见 stageAttachments */
  path: string
  name: string
  size: number
  /** 输入框与气泡里显示的缩略图（小尺寸 dataURL，只在内存里活着）。文档没有缩略图 */
  thumb: string
  /** 'image' | 'doc'：文档要先转 markdown 才能给模型（B7） */
  kind: 'image' | 'doc'
  /** 超过 20MB 的文档：选是能选，但发送时会被挡下并提示改走入库 */
  tooBig?: boolean
}

/** 缩略图边长。够看清是哪张图就行——它要经 IPC 过一次、还要塞进 React state */
const THUMB_EDGE = 160

export async function pickAttachments(win: BrowserWindow | null): Promise<PickedAttachment[]> {
  const r = await dialog.showOpenDialog(win ?? undefined!, {
    title: '选择要随这条消息发送的图片或文档',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '图片或文档', extensions: [...IMG_EXT, ...DOC_EXT] },
      { name: '图片', extensions: IMG_EXT },
      { name: '文档', extensions: DOC_EXT },
    ],
  })
  if (r.canceled || !r.filePaths.length) return []
  const out: PickedAttachment[] = []
  for (const p of r.filePaths.slice(0, 8)) {
    try {
      const st = await fs.stat(p)
      // 缩略图走 Electron 自带的 nativeImage：不引新依赖，也不用把原图整个 base64
      // 塞过 IPC（一张 5MB 的照片编出来 6.7MB 字符串，够卡一下渲染进程）
      const img = nativeImage.createFromPath(p)
      const thumb = img.isEmpty()
        ? ''
        : img.resize({ width: Math.min(THUMB_EDGE, img.getSize().width), quality: 'good' }).toDataURL()
      const ext = extname(p).toLowerCase().slice(1)
      const kind: 'image' | 'doc' = IMG_EXT.includes(ext) ? 'image' : 'doc'
      out.push({
        path: p,
        name: basename(p),
        size: st.size,
        thumb: kind === 'image' ? thumb : '',
        kind,
        tooBig: kind === 'doc' && st.size > DOC_MAX_BYTES,
      })
    } catch (e) {
      log('warn', 'attach', `读不了 ${p}：${e}`)
    }
  }
  return out
}

/**
 * 把附件拷进本轮的临时目录，返回拷贝后的路径。
 *
 * **为什么不直接把用户的原路径给 agent**：这一轮可能跑好几分钟，期间用户完全可能把
 * 那张图删了、改名了、或者从 U 盘里拔走了——那样渲染工具读到一半才失败，
 * 而失败点离原因已经很远。拷一份进临时目录，这一轮就自洽了。
 */
export interface StagedAttachments {
  /** 交给 agent 的路径：图片是拷贝后的原图，文档是**转换出来的 md** */
  paths: string[]
  /** 每个路径对应的原始文件名（气泡与提示词里用它称呼，别让用户看到 attach3.md） */
  names: string[]
  /** 没能带上的：文件名 + 人话原因。**必须报给用户**，静默丢附件是最糟的（同 A-4 那条教训） */
  failed: Array<{ name: string; reason: string }>
}

export async function stageAttachments(sessionId: string, paths: string[]): Promise<StagedAttachments> {
  if (!paths.length) return { paths: [], names: [], failed: [] }
  const dir = join(app.getPath('temp'), 'mcnai-attach', sessionId.replace(/[^\w-]/g, '_'))
  await fs.mkdir(dir, { recursive: true })
  const out: string[] = []
  const names: string[] = []
  const failed: Array<{ name: string; reason: string }> = []

  for (const [i, p] of paths.entries()) {
    const name = basename(p)
    const ext = extname(p).toLowerCase().slice(1)
    const isImg = IMG_EXT.includes(ext)
    try {
      const st = await fs.stat(p)
      if (!isImg && st.size > DOC_MAX_BYTES) {
        failed.push({
          name,
          reason: `超过 ${Math.round(DOC_MAX_BYTES / 1024 / 1024)}MB。这么大的文件建议拖进窗口入库，之后随时可以问它`,
        })
        continue
      }
      if (isImg) {
        const dest = join(dir, `attach${i + 1}.${ext || 'png'}`)
        await fs.copyFile(p, dest)
        out.push(dest)
        names.push(name)
        continue
      }
      // md/txt 本来就是文本，直接拷；其余四种走 pipeline 的 convert-one 转成 markdown
      if (ext === 'md' || ext === 'txt') {
        const dest = join(dir, `attach${i + 1}.md`)
        await fs.copyFile(p, dest)
        out.push(dest)
        names.push(name)
        continue
      }
      const converted = await convertDoc(p, join(dir, `doc${i + 1}`))
      if (converted.ok) {
        out.push(converted.path)
        names.push(name)
      } else {
        failed.push({ name, reason: converted.reason })
      }
    } catch (e) {
      log('warn', 'attach', `处理失败 ${p}：${e}`)
      failed.push({ name, reason: '读不了这个文件（可能已被移动或没有权限）' })
    }
  }
  return { paths: out, names, failed }
}

/**
 * 单个文档 → markdown（B7）。走冻结 pipeline 的 `convert-one` 子命令，
 * **不在这边复制转换逻辑**——docx/pdf/xlsx/pptx 四条路各有各的坑（老 macOS 的 pyexpat
 * 那次就是其中之一），抄一份必然走样。
 *
 * 转出来的 md 落在本轮临时目录里：**不打标、不建卡、不上云、不进投递箱**，
 * 会话结束随目录一起清掉。
 */
async function convertDoc(src: string, outDir: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const child = spawn(pipelineBin(), ['convert-one', src, outDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    child.stdout.on('data', (d: Buffer) => (buf += d.toString()))
    child.on('error', (e) => resolve({ ok: false, reason: `转换程序起不来（${e.message}）` }))
    child.on('close', () => {
      for (const line of buf.split('\n')) {
        if (!line.trim().startsWith('{')) continue
        try {
          const ev = JSON.parse(line)
          if (ev.stage !== 'convert_one') continue
          if (ev.status === 'ok' && ev.out) return resolve({ ok: true, path: String(ev.out) })
          if (ev.status === 'error') return resolve({ ok: false, reason: String(ev.message ?? '转换失败') })
        } catch {
          /* 不是我们要的那行 */
        }
      }
      resolve({ ok: false, reason: '转换没有产出内容' })
    })
  })
}

/**
 * **退出时用这个同步版**（B7 实测逼出来的）。
 *
 * `before-quit` 里 `void clearAttachments()` 是 fire-and-forget——进程在 `rm` 完成之前
 * 就退了，目录原样留着。走查断言「退出后临时目录已清空」当场逮到。
 * 而这里面躺的是**用户的真实文档**（转出来的 md 就是全文），多留一次都不应该。
 */
export function clearAttachmentsSync(): void {
  try {
    rmSync(join(app.getPath('temp'), 'mcnai-attach'), { recursive: true, force: true })
  } catch {
    /* 删不掉就算了，开机那次还会再清一遍 */
  }
}

/** 换会话/开机时清掉。失败不报错——临时目录本来就归系统回收 */
export async function clearAttachments(sessionId?: string): Promise<void> {
  const base = join(app.getPath('temp'), 'mcnai-attach')
  const target = sessionId ? join(base, sessionId.replace(/[^\w-]/g, '_')) : base
  await fs.rm(target, { recursive: true, force: true }).catch(() => void 0)
}

/**
 * 拼进 prompt 的那段说明。**给的是绝对路径**，因为渲染工具要靠它读图；
 * 但步骤流不展示工具入参里的路径（`agent/steps.ts` 的白名单只放行文件名/检索词），
 * 所以这段不会漏到界面上。
 */
export function attachmentNote(paths: string[], names: string[] = []): string {
  if (!paths.length) return ''
  const list = paths.map((p, i) => `${i + 1}. ${names[i] ? `《${names[i]}》 → ` : ''}${p}`).join('\n')
  return (
    `\n\n【本轮附件】用户随这条消息提供了 ${paths.length} 份材料，路径如下：\n${list}\n` +
    `图片：需要放进产物时把路径**原样**填进渲染工具的图片字段，不要复制、改名或猜别的路径。\n` +
    `文档：已转成 markdown，用 Read 读那个路径即可。**这些是本轮临时参考，不在知识库里**——` +
    `引用时称呼它的原始文件名（书名号里那个），不要说成"库里的笔记"，也不要去检索它。`
  )
}

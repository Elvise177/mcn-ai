import { promises as fs } from 'fs'
import { join, basename, extname } from 'path'
import { app, dialog, nativeImage, type BrowserWindow } from 'electron'
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

export interface PickedAttachment {
  /** 用户原始文件路径。**不直接交给 agent**——见 stageAttachments */
  path: string
  name: string
  size: number
  /** 输入框与气泡里显示的缩略图（小尺寸 dataURL，只在内存里活着） */
  thumb: string
}

/** 缩略图边长。够看清是哪张图就行——它要经 IPC 过一次、还要塞进 React state */
const THUMB_EDGE = 160

export async function pickAttachments(win: BrowserWindow | null): Promise<PickedAttachment[]> {
  const r = await dialog.showOpenDialog(win ?? undefined!, {
    title: '选择要随消息发送的图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: IMG_EXT }],
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
      out.push({ path: p, name: basename(p), size: st.size, thumb })
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
export async function stageAttachments(sessionId: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return []
  const dir = join(app.getPath('temp'), 'mcnai-attach', sessionId.replace(/[^\w-]/g, '_'))
  await fs.mkdir(dir, { recursive: true })
  const out: string[] = []
  for (const [i, p] of paths.entries()) {
    try {
      const dest = join(dir, `attach${i + 1}${extname(p).toLowerCase() || '.png'}`)
      await fs.copyFile(p, dest)
      out.push(dest)
    } catch (e) {
      log('warn', 'attach', `拷贝失败 ${p}：${e}`)
    }
  }
  return out
}

/** 退出/换会话时清掉。失败不报错——临时目录本来就归系统回收 */
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
export function attachmentNote(paths: string[]): string {
  if (!paths.length) return ''
  const list = paths.map((p, i) => `${i + 1}. ${p}`).join('\n')
  return (
    `\n\n【本轮附件】用户随这条消息提供了 ${paths.length} 张图片，路径如下：\n${list}\n` +
    `需要把图片放进产物时，把上面的路径**原样**填进渲染工具的图片字段，不要复制、改名或猜别的路径。`
  )
}

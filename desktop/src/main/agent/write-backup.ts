import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'
import { log } from '../lib/logger'

/**
 * AI 写入前的原文备份 + 撤销（2026-08-19，B4 的第三层）。
 *
 * 放行 AI 改知识库的前提是**改错了能一键回去**。备份放在 `userData/ai-backups/`
 * 而**不是库里**——库是用户的资料，我们不该往里塞产品的内部文件（同硬禁区那条原则：
 * `.mcnai/` 之外不制造新的内部目录），而且备份进了库还会被 watcher 收进索引、被检索到。
 *
 * 保留 30 天，启动时清一次。每条记录够回答两件事：改的哪个文件、改之前长什么样。
 */

const KEEP_MS = 30 * 24 * 60 * 60 * 1000

interface BackupEntry {
  id: string
  /** 哪一轮对话改的——撤销之后要告诉**那个会话**的模型（见 takeUndoNotice） */
  sessionId: string
  /** 库根 + 相对路径：撤销时要写回同一个地方 */
  root: string
  rel: string
  /** 改之前的原文；文件原本不存在时为 null（撤销 = 删掉这个新建的文件） */
  before: string | null
  at: number
}

const mem = new Map<string, BackupEntry>()
/** 被撤销过、还没告诉模型的文件（按会话）。取走即清——同一件事不重复念叨 */
const undone = new Map<string, string[]>()

/**
 * 取出并清空"这个会话有哪些改动被撤销了"。发送前调一次，拼进 prompt。
 * **取走即清**：说一次就够，每轮都重复会污染上下文、也会让模型以为反复被撤销。
 */
export function takeUndoNotice(sessionId: string): string {
  const list = undone.get(sessionId)
  if (!list?.length) return ''
  undone.delete(sessionId)
  return (
    `\n\n【重要】用户**撤销**了你上一次对以下文件的修改，磁盘上已恢复成修改前的样子：\n` +
    list.map((r) => `· ${r}`).join('\n') +
    `\n所以你之前那些"已经改好了"的结论**对这些文件不再成立**。` +
    `如果用户要你再改一次，就当作从没改过、重新执行，不要说"上一轮已经改完了"。`
  )
}

function dir(): string {
  try {
    return join(app.getPath('userData'), 'ai-backups')
  } catch {
    // `ELECTRON_RUN_AS_NODE` 下没有 app（冒烟就跑在这个形态）。
    // 落到临时目录——冒烟要能真备份、真撤销、真比对内容，不能因为拿不到 userData 就跳过
    return join(tmpdir(), 'mcnai-ai-backups')
  }
}

/** 写入前调用。返回备份 id，撤销时拿它回滚 */
export async function backupBeforeWrite(sessionId: string, root: string, rel: string): Promise<string> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let before: string | null = null
  try {
    before = await fs.readFile(join(root, rel), 'utf-8')
  } catch {
    before = null // 文件本来不存在 = 这是一次新建，撤销就是删掉它
  }
  const entry: BackupEntry = { id, sessionId, root, rel, before, at: Date.now() }
  mem.set(id, entry)
  try {
    await fs.mkdir(dir(), { recursive: true })
    await fs.writeFile(join(dir(), `${id}.json`), JSON.stringify(entry), 'utf-8')
  } catch (e) {
    // 落盘失败不挡写入：内存里那份仍然能撑住"这一次运行内的撤销"
    log('warn', 'ai-write', `备份落盘失败（撤销仍可用到重启前）：${String(e)}`)
  }
  return id
}

/**
 * 撤销一次 AI 写入。
 * `before === null` 表示那是一次新建 → 撤销就是把文件删掉（**删到废纸篓，不硬删**，
 * 同笔记删除的口径：删错了还能捞回来）。
 */
export async function undoWrite(id: string): Promise<{ ok: boolean; error?: string }> {
  let e = mem.get(id)
  if (!e) {
    try {
      e = JSON.parse(await fs.readFile(join(dir(), `${id}.json`), 'utf-8')) as BackupEntry
    } catch {
      return { ok: false, error: '找不到这次修改的备份（可能已超过 30 天）' }
    }
  }
  const abs = join(e.root, e.rel)
  try {
    if (e.before === null) {
      /**
       * 本来就不存在的文件 → 撤销 = 移除它。**走废纸篓**，与笔记删除同一口径（删错了能捞回来）。
       *
       * `shell.trashItem` 在 `ELECTRON_RUN_AS_NODE` 下**是 undefined**（冒烟就跑在那个形态），
       * 而 `undefined.trashItem(...)` 是**同步抛 TypeError**——`.catch()` 接不住它。
       * 第一版就是这么写的，`smoke:write` 当场逮到。所以这里用 try/catch 包住取用与调用两步。
       */
      let trashed = false
      try {
        const { shell } = await import('electron')
        if (typeof shell?.trashItem === 'function') {
          await shell.trashItem(abs)
          trashed = true
        }
      } catch {
        /* 拿不到 Electron 上下文，或废纸篓不可用：落到下面的硬删 */
      }
      if (!trashed) await fs.rm(abs, { force: true })
    } else {
      await fs.mkdir(dirname(abs), { recursive: true })
      await fs.writeFile(abs, e.before, 'utf-8')
    }
    log('info', 'ai-write', `已撤销 AI 对 ${e.rel} 的修改`)
    /**
     * **撤销之后必须告诉模型**（2026-08-19 真人实测逼出来的）。
     *
     * 撤销发生在主进程，而对话上下文里那一轮的工具结果仍然写着"我已经把 X 换成 Y 了"。
     * 于是用户撤销后再让它改一遍，它会回：「已经在上一轮全部替换完了，无需再次操作」
     * ——**模型没说谎，是它看到的世界和磁盘上的不一致了**。
     * 这里登记下来，下一次发送时随 prompt 带一句给它。
     */
    const list = undone.get(e.sessionId) ?? []
    if (!list.includes(e.rel)) list.push(e.rel)
    undone.set(e.sessionId, list)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** 启动时清一次过期备份（30 天） */
export async function pruneBackups(): Promise<void> {
  try {
    const names = await fs.readdir(dir())
    const now = Date.now()
    for (const n of names) {
      const f = join(dir(), n)
      const st = await fs.stat(f).catch(() => null)
      if (st && now - st.mtimeMs > KEEP_MS) await fs.rm(f, { force: true })
    }
  } catch {
    /* 目录还不存在：没什么可清的 */
  }
}

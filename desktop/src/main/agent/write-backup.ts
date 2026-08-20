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
  /** 库根 + 相对路径：撤销时要写回同一个地方 */
  root: string
  rel: string
  /** 改之前的原文；文件原本不存在时为 null（撤销 = 删掉这个新建的文件） */
  before: string | null
  at: number
}

const mem = new Map<string, BackupEntry>()

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
export async function backupBeforeWrite(root: string, rel: string): Promise<string> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let before: string | null = null
  try {
    before = await fs.readFile(join(root, rel), 'utf-8')
  } catch {
    before = null // 文件本来不存在 = 这是一次新建，撤销就是删掉它
  }
  const entry: BackupEntry = { id, root, rel, before, at: Date.now() }
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

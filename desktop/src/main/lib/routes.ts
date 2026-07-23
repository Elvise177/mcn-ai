import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { log } from './logger'

/**
 * 投递箱分流配置：vault/.mcnai/layout.json 的「投递箱分流」段。
 * 设置界面读写这里；pipeline（mcn-ingest）运行时读同一配置执行分流。
 * 内置规则「参考资料 → 70_外部资料」始终存在，不可删除。
 */
export interface InboxRoute {
  /** 投递箱下的子文件夹名 */
  name: string
  /** 落位目录（vault 相对路径） */
  dest: string
  builtin?: boolean
}

const BUILTIN: InboxRoute = { name: '参考资料', dest: '70_外部资料', builtin: true }

function layoutPath(vaultRoot: string): string {
  return join(vaultRoot, '.mcnai', 'layout.json')
}

async function readLayout(vaultRoot: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(layoutPath(vaultRoot), 'utf-8'))
  } catch {
    return {}
  }
}

export async function getRoutes(vaultRoot: string): Promise<InboxRoute[]> {
  const layout = await readLayout(vaultRoot)
  const raw = (layout['投递箱分流'] ?? {}) as Record<string, { 落位?: string; dest?: string }>
  const out: InboxRoute[] = [BUILTIN]
  for (const [name, cfg] of Object.entries(raw)) {
    if (name === BUILTIN.name) continue
    out.push({ name, dest: String(cfg?.落位 ?? cfg?.dest ?? '70_外部资料') })
  }
  return out
}

export async function setRoutes(vaultRoot: string, routes: Array<{ name: string; dest: string }>): Promise<void> {
  const layout = await readLayout(vaultRoot)
  const section: Record<string, { 落位: string; 标签: string[] }> = {}
  for (const r of routes) {
    const name = r.name.trim().replace(/[\\/:*?"<>|.]/g, '')
    const dest = r.dest.trim().replace(/^\/+|\/+$/g, '')
    if (!name || !dest || name === BUILTIN.name) continue
    section[name] = { 落位: dest, 标签: ['外部资料', name] }
  }
  layout['投递箱分流'] = section
  await fs.mkdir(join(vaultRoot, '.mcnai'), { recursive: true })
  await fs.writeFile(layoutPath(vaultRoot), JSON.stringify(layout, null, 2), 'utf-8')
  await ensureRouteFolders(vaultRoot)
}

/** 确保每条分流规则的投递入口文件夹存在（含内置规则）；开库与保存配置时调用 */
export async function ensureRouteFolders(vaultRoot: string): Promise<void> {
  try {
    const inboxName = existsSync(join(vaultRoot, '95_待入库')) ? '95_待入库' : '00_投递箱'
    const inbox = join(vaultRoot, inboxName)
    if (!existsSync(inbox)) return
    for (const r of await getRoutes(vaultRoot)) {
      await fs.mkdir(join(inbox, r.name), { recursive: true })
    }
  } catch (e) {
    log('warn', 'routes', String(e))
  }
}

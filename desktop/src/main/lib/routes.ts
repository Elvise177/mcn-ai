import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { log } from './logger'
import { readRawLayout, readVaultConfig } from '../vault/taxonomy'

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

/**
 * 内置分流规则。落位目录走库配置（`externalRefs`）——原来这里和 `cli.py` 各写死一份
 * `70_外部资料`，改一处漏一处就是"设置里显示落到 A、实际落到 B"。
 */
async function builtin(vaultRoot: string): Promise<InboxRoute> {
  return { name: '参考资料', dest: (await readVaultConfig(vaultRoot)).externalRefs, builtin: true }
}
const BUILTIN_NAME = '参考资料'

function layoutPath(vaultRoot: string): string {
  return join(vaultRoot, '.mcnai', 'layout.json')
}

/** 原文读取只走 taxonomy 一个入口——分流段是 layout.json 的一部分，不许再开第二个 parse */
const readLayout = readRawLayout

export async function getRoutes(vaultRoot: string): Promise<InboxRoute[]> {
  const layout = await readLayout(vaultRoot)
  const fallbackDest = (await readVaultConfig(vaultRoot)).externalRefs
  const raw = (layout['投递箱分流'] ?? {}) as Record<string, { 落位?: string; dest?: string }>
  const out: InboxRoute[] = [await builtin(vaultRoot)]
  for (const [name, cfg] of Object.entries(raw)) {
    if (name === BUILTIN_NAME) continue
    out.push({ name, dest: String(cfg?.落位 ?? cfg?.dest ?? fallbackDest) })
  }
  return out
}

export async function setRoutes(vaultRoot: string, routes: Array<{ name: string; dest: string }>): Promise<void> {
  const layout = await readLayout(vaultRoot)
  const section: Record<string, { 落位: string; 标签: string[] }> = {}
  for (const r of routes) {
    const name = r.name.trim().replace(/[\\/:*?"<>|.]/g, '')
    const dest = r.dest.trim().replace(/^\/+|\/+$/g, '')
    if (!name || !dest || name === BUILTIN_NAME) continue
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
    /**
     * **投递箱名必须走配置**（2026-08-21 修）。这里原来是
     * `existsSync('95_待入库') ? … : '00_投递箱'`——**压根不读 layout.json**，
     * 于是库里把投递箱改了名，分流子文件夹就建到一个没人看的目录里去，
     * 用户往「参考资料」里放文件永远不会被处理。
     */
    const inbox = join(vaultRoot, (await readVaultConfig(vaultRoot)).inbox)
    if (!existsSync(inbox)) return
    for (const r of await getRoutes(vaultRoot)) {
      await fs.mkdir(join(inbox, r.name), { recursive: true })
    }
  } catch (e) {
    log('warn', 'routes', String(e))
  }
}

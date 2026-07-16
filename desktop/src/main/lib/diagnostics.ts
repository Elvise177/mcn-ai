import { app, shell } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { store, getApiKey, getLlmKey } from '../store'
import { vaultManager } from '../vault'
import { logFilePath } from './logger'

/** 脱敏：任何形似密钥/令牌的串一律打码 */
function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/g, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, 'eyJ***')
}

/** 一键诊断报告 → 桌面（脱敏后的环境信息 + 配置状态 + 最近日志），用户直接发给客服 */
export async function exportDiagnostics(): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
  const out = join(app.getPath('desktop'), `mcn-ai诊断_${stamp}.txt`)

  let recentLog = '(无日志)'
  try {
    const raw = await fs.readFile(logFilePath(), 'utf-8')
    recentLog = raw.split('\n').slice(-300).join('\n')
  } catch {
    /* noop */
  }

  const report = `mcn-ai 诊断报告  ${new Date().toLocaleString('zh-CN')}
==================================================
应用版本: ${app.getVersion()}
系统: ${process.platform} ${process.arch} / Electron ${process.versions.electron} / Node ${process.versions.node}
打包运行: ${app.isPackaged}

配置状态（不含任何密钥明文）:
- 知识库: ${store.get('vaultPath') ?? '(未设置)'}（当前${vaultManager.currentRoot ? '已' : '未'}打开）
- 服务器: ${store.get('apiBaseUrl')}
- 中转站: ${store.get('relayBaseUrl')}（key ${getApiKey() ? '已配置' : '未配置'}${store.get('manualApiKey') ? '·手动' : '·下发'}）
- 打标模型: ${store.get('llmBaseUrl')} ${store.get('llmModel')}（key ${getLlmKey() ? '已配置' : '未配置'}）

最近日志（末 300 行，已脱敏）:
--------------------------------------------------
${redact(recentLog)}
`
  await fs.writeFile(out, report, 'utf-8')
  shell.showItemInFolder(out)
  return out
}

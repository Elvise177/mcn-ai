import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'fs'
import { join } from 'path'

/** 轻量日志：userData/logs/main.log，2MB 滚动一档；error 级同时进控制台 */
let file: string | null = null

function target(): string {
  if (!file) {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
  }
  return file
}

export function log(level: 'info' | 'warn' | 'error', tag: string, msg: unknown): void {
  const text = msg instanceof Error ? `${msg.message}\n${msg.stack ?? ''}` : typeof msg === 'string' ? msg : JSON.stringify(msg)
  const line = `${new Date().toISOString()} [${level}] [${tag}] ${text}\n`
  try {
    const f = target()
    try {
      if (statSync(f).size > 2_000_000) renameSync(f, f + '.1')
    } catch {
      /* 首次无文件 */
    }
    appendFileSync(f, line)
  } catch {
    /* 日志失败不影响主流程 */
  }
  if (level === 'error') console.error(`[${tag}]`, msg)
}

export function logFilePath(): string {
  return target()
}

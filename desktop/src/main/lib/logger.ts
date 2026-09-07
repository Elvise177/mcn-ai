import { appendFileSync, mkdirSync, statSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** 轻量日志：userData/logs/main.log，2MB 滚动一档；error 级同时进控制台 */
let file: string | null = null

/**
 * **惰性取 electron**（与 `vault/embedder.ts` 同一个写法、同一个理由）。
 *
 * 这个文件原来是 `import { app } from 'electron'`——静态 import。包内用
 * `ELECTRON_RUN_AS_NODE=1` 跑冒烟时 `require('electron')` 会抛 MODULE_NOT_FOUND
 * （asar 里没有那个 npm 包），于是**凡是间接引到 logger 的入口在包里都起不来**。
 * 2026-09-06 实测栽的就是这一下：`smoke-embed` 加了索引生命周期一节 →
 * 引 `vault/embed-index` → 引 logger → 整个包内冒烟报 MODULE_NOT_FOUND，
 * 而开发形态一切正常（dev 下 electron 是真装着的）。第三单在 embedder 里治过一次，
 * 病根其实在这儿。
 *
 * 拿不到 app 就落到临时目录：**日志写哪儿都比"整个进程起不来"强**。
 */
function userDataDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = (require('electron') as { app?: { getPath?: (n: string) => string } }).app?.getPath?.('userData')
    if (p) return p
  } catch {
    /* 非 Electron 上下文（包内冒烟、纯 node 脚本） */
  }
  return join(tmpdir(), 'mcnai-standalone')
}

function target(): string {
  if (!file) {
    const dir = join(userDataDir(), 'logs')
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

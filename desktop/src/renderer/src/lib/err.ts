/**
 * IPC 抛回渲染层的错误长这样：
 * `Error: Error invoking remote method 'vault:write': Error: EACCES: permission denied`
 * 直接 toast 出去全是噪音，这里只留最后那句人话。
 */
export function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const tail = raw.split(/Error:\s*/).filter(Boolean).pop()
  return (tail ?? raw).trim() || raw
}

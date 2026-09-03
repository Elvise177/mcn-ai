/**
 * 只留尾部的文本缓冲（PLAN-v2 R4，2026-09-02）。
 *
 * 用途：pipeline 子进程的 stderr。以前是 `child.stderr.on('data', () => void 0)`——整条丢弃，
 * 于是 PyInstaller 引导程序找不到模块、Python 段错误、`NameError` 这类**没来得及打 JSON 事件**的
 * 崩溃在界面上只剩一句「投递箱处理失败」，原因为空，日志里也没有（审计 b4 / Q1）。
 *
 * 为什么不整条存：打标阶段每篇一行日志，长批次几十 KB；诊断只需要**最后那几行 traceback**。
 * 上限 2KB，超出从头丢，纯字符串操作，零依赖——`smoke:guards` 验边界。
 */
export class TailBuffer {
  private buf = ''
  constructor(private readonly limit = 2048) {}

  push(chunk: string | Buffer): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    if (this.buf.length > this.limit) this.buf = this.buf.slice(-this.limit)
  }

  /** 去掉首尾空白后的全部内容（≤ limit） */
  text(): string {
    return this.buf.trim()
  }

  /** 最后一行非空内容——任务 `error` 字段里放这一句就够人看懂 */
  lastLine(): string {
    const lines = this.text().split('\n').map((l) => l.trim()).filter(Boolean)
    return lines[lines.length - 1] ?? ''
  }

  get length(): number {
    return this.buf.length
  }
}

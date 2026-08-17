/**
 * 走查用：模拟「别的程序（Obsidian）在外部改了这个文件」。
 * 必须是**外部脚本真的写盘**——从应用内部改的话会命中自触发抑制（vault:changed 带 self=true），
 * 那样测到的是抑制逻辑而不是冲突检测（M-27）。
 * 用法：node e2e/external-edit.mjs <绝对路径> [追加的文本]
 */
import { appendFileSync } from 'fs'

const [, , file, text] = process.argv
if (!file) {
  console.error('用法: node e2e/external-edit.mjs <file> [text]')
  process.exit(1)
}
appendFileSync(file, text ?? '\n\n这一行是外部程序（模拟 Obsidian）写进去的。\n', 'utf-8')
console.log('external-edit ok →', file)

#!/usr/bin/env node
/**
 * 一条命令跑完全部验收，**出一份总报告**（`npm run verify`）。
 *
 * ## 为什么要有它
 *
 * 2026-08-19 真人吐槽的原话：「还是这样一个一个的试，太慢了」。
 * 当时的做法是手动一条条跑，**停在第一个红上**——三轮走查 45 分钟，
 * 每轮只暴露一个问题，其中两次还是断言前提过期而不是产品坏了。
 *
 * 这个脚本按**从快到慢**排：秒级的静态/逻辑检查先跑，跑完立刻能看到一批结论；
 * 分钟级的 GUI 走查放最后。**任何一条红都不中断后面的**，最后一次性列出来。
 *
 * ## 分层（前面的越快越该先跑）
 *
 *   L0 静态：typecheck / IPC 契约            —— 秒级
 *   L1 逻辑：steps / cards / resume / write   —— 秒级，零 token
 *   L2 引擎：pipeline 冒烟                    —— 1 秒，真跑冻结产物
 *   L3 界面：走查 / a1-enqueue / 附件 / 资产  —— 分钟级
 *   L4 真实调用：fresh-install / provider     —— 要钱，默认**不跑**，加 --paid 才跑
 *
 * 跑法：
 *   npm run verify           # L0–L3，零花费
 *   npm run verify -- --paid # 连 L4 一起（会真花钱，先自己心里有数）
 *   npm run verify -- --fast # 只跑 L0–L2（改完代码想先看一眼有没有低级错误）
 */
import { spawnSync } from 'child_process'

const args = process.argv.slice(2)
const PAID = args.includes('--paid')
const FAST = args.includes('--fast')

const JOBS = [
  { level: 'L0', name: 'typecheck', cmd: ['npm', ['run', 'typecheck']] },
  { level: 'L0', name: 'IPC 契约', cmd: ['npm', ['run', 'smoke:ipc']] },
  { level: 'L1', name: 'smoke:steps', cmd: ['npm', ['run', 'smoke:steps']] },
  { level: 'L1', name: 'smoke:cards', cmd: ['npm', ['run', 'smoke:cards']] },
  { level: 'L1', name: 'smoke:resume', cmd: ['npm', ['run', 'smoke:resume']] },
  { level: 'L1', name: 'smoke:write（AI 写权限）', cmd: ['npm', ['run', 'smoke:write']] },
  { level: 'L1', name: 'smoke:taxonomy（库配置 · TS↔Py 契约）', cmd: ['npm', ['run', 'smoke:taxonomy']] },
  { level: 'L2', name: 'pipeline 冒烟（分流/转换/归档/convert-one）', cmd: ['npm', ['run', 'smoke:pipeline']] },
  { level: 'L3', name: '主走查（本地模式）', cmd: ['node', ['e2e/walkthrough.mjs']] },
  { level: 'L3', name: 'a1-enqueue（投递链路）', cmd: ['node', ['e2e/a1-enqueue.mjs']] },
  { level: 'L3', name: '附件（含 B7 文档附件）', cmd: ['node', ['e2e/attachments.mjs']] },
  { level: 'L3', name: '资产协议（库内图片）', cmd: ['node', ['e2e/assets-render.mjs']] },
  { level: 'L4', name: 'fresh-install（真实调用 ≈¥0.4）', cmd: ['node', ['e2e/fresh-install.mjs']], paid: true },
  { level: 'L4', name: 'upgrade-path（老 userData 接管）', cmd: ['node', ['e2e/upgrade-path.mjs']] },
]

const picked = JOBS.filter((j) => {
  if (FAST) return j.level <= 'L2'
  if (j.paid && !PAID) return false
  if (j.level === 'L4' && !PAID) return false
  return true
})

console.log(`\n验收总控：共 ${picked.length} 项${PAID ? '（含真实调用）' : '（零花费；加 --paid 跑 L4）'}\n`)

const results = []
for (const j of picked) {
  const t0 = Date.now()
  process.stdout.write(`[${j.level}] ${j.name} … `)
  const r = spawnSync(j.cmd[0], j.cmd[1], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const pass = r.status === 0 && !/❌|✗ /.test(out)
  console.log(pass ? `✅ ${secs}s` : `❌ ${secs}s`)
  results.push({ ...j, pass, secs, out })
}

console.log('\n' + '='.repeat(72))
const failed = results.filter((r) => !r.pass)
if (!failed.length) {
  console.log(`✅ 全部通过（${results.length} 项，共 ${results.reduce((n, r) => n + Number(r.secs), 0).toFixed(0)} 秒）`)
} else {
  console.log(`❌ ${failed.length}/${results.length} 项未通过——**一次列全，不用一条条重跑**：\n`)
  for (const f of failed) {
    console.log(`─── [${f.level}] ${f.name} ${'─'.repeat(Math.max(0, 50 - f.name.length))}`)
    /**
     * 摘失败相关的行。**必须带上堆栈里的定位**（`at file:///…:行号`）——
     * 第一版只摘 `❌/Error:` 那一行，结果拿到 `locator.click: Timeout 30000ms exceeded`
     * 却不知道是哪一步的哪个选择器，还得单独重跑一次白等两分钟（2026-08-19 踩过）。
     */
    const lines = f.out.split('\n')
    const isHit = (l) => /❌|✗ |Error:|失败|throw|at file:|waiting for|Call log|locator/.test(l)
    const idx = lines.findIndex((l) => /❌|Error:/.test(l))
    // 从第一处失败往后取一段（错误上下文通常紧跟其后），再补上最后几行
    const window = idx >= 0 ? lines.slice(idx, idx + 20).filter(isHit) : []
    const hits = (window.length ? window : lines.filter(isHit)).slice(0, 14)
    console.log((hits.length ? hits : lines.slice(-10)).map((l) => '  ' + l.trimEnd()).join('\n'))
    console.log()
  }
}
console.log('='.repeat(72) + '\n')
process.exit(failed.length ? 1 : 0)

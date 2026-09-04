import { join } from 'path'
import { homedir } from 'os'
import { judgeTimeout, resolveTimeoutMs, humanDuration, DEFAULT_AGENT_TIMEOUT_MIN, WARN_RATIO } from './agent/timeout'
import { TailBuffer } from './lib/tail-buffer'
import { pipelineArgs, pipelineEnv } from './lib/pipeline'
import { isSafeVaultRoot } from './vault/wizard'
import { judgeNotify, NOTIFY_MIN_MS } from './lib/notify'

/**
 * 批 1「架构止血」里那些**只在真实调用 / 真实故障下才走到**的判据，抽成纯函数后在这儿零花费验
 * （`npm run smoke:guards`，PLAN-v2 批 1）。desktop/CLAUDE.md 铁律：
 * 「这段逻辑要不要花钱/等几十分钟才能触发？要，就抽出来。」
 *
 *  · R3 `judgeTimeout`   —— 真造一次超时要等 15 分钟
 *  · R4 `TailBuffer`     —— 真造一次 pipeline 崩溃要弄坏冻结产物
 *  · R5 `pipelineArgs`   —— 「argv 不含 key」不能靠本地模式没 key 碰巧成立
 *  · N6 `isSafeVaultRoot`—— 真选家目录当库会扫几十万文件
 *
 * 接线对不对（定时器真的挂上了、stderr 真的接进任务 error、护栏真的拦在 IPC 上）由走查负责。
 */

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n【1】judgeTimeout：软提醒 80% → 硬中断 100%（R3）')
{
  const T0 = 1_000_000
  const LIMIT = 10 * 60_000
  check('上限 0 = 关：永远 ok', judgeTimeout(T0, T0 + 99 * 60_000, 0, false).kind === 'ok')
  check('上限负数/NaN 也当关', judgeTimeout(T0, T0 + 1, -5, false).kind === 'ok' && judgeTimeout(T0, T0 + 1, NaN, false).kind === 'ok')
  check('79% → ok', judgeTimeout(T0, T0 + LIMIT * 0.79, LIMIT, false).kind === 'ok')
  const w = judgeTimeout(T0, T0 + LIMIT * WARN_RATIO, LIMIT, false)
  check('80% → warn 一次', w.kind === 'warn', w.kind)
  check('warn 文案含已运行时长与剩余时长', w.kind === 'warn' && /已运行 8 分钟/.test(w.message) && /2 分钟后/.test(w.message), w.kind === 'warn' ? w.message : '')
  check('提醒过之后 80%~100% 之间不再 warn', judgeTimeout(T0, T0 + LIMIT * 0.9, LIMIT, true).kind === 'ok')
  const a = judgeTimeout(T0, T0 + LIMIT, LIMIT, true)
  check('100% → abort', a.kind === 'abort', a.kind)
  check('abort 文案含「超过上限」与分钟数', a.kind === 'abort' && /超过上限 10 分钟/.test(a.message) && /已自动中断/.test(a.message), a.kind === 'abort' ? a.message : '')
  check('没提醒过也照样 abort（不许因为没 warn 就漏 abort）', judgeTimeout(T0, T0 + LIMIT * 1.5, LIMIT, false).kind === 'abort')
  check('时钟倒退当 0 秒处理', judgeTimeout(T0, T0 - 5000, LIMIT, false).kind === 'ok')
  // e2e 造超时用的 3 秒：同一判据
  const e2e = judgeTimeout(T0, T0 + 3000, 3000, false)
  check('3 秒上限 → 3 秒即 abort（走查开关走的就是这条）', e2e.kind === 'abort' && /3 秒/.test(e2e.message), e2e.kind === 'abort' ? e2e.message : e2e.kind)
}

console.log('\n【2】resolveTimeoutMs：管理员配置 + e2e 覆盖')
{
  check(`出厂 ${DEFAULT_AGENT_TIMEOUT_MIN} 分钟`, resolveTimeoutMs(undefined, undefined) === DEFAULT_AGENT_TIMEOUT_MIN * 60_000)
  check('配 20 → 20 分钟', resolveTimeoutMs(20, undefined) === 20 * 60_000)
  check('配 0 → 0（关）', resolveTimeoutMs(0, undefined) === 0)
  check('配脏值 → 出厂', resolveTimeoutMs('abc', undefined) === DEFAULT_AGENT_TIMEOUT_MIN * 60_000)
  check('MCNAI_E2E_AGENT_TIMEOUT=3000 覆盖为 3 秒', resolveTimeoutMs(15, '3000') === 3000)
  check('e2e 开关是垃圾值时忽略', resolveTimeoutMs(15, 'x') === 15 * 60_000)
  check('humanDuration 90s → 1.5 分钟', humanDuration(90_000) === '1.5 分钟', humanDuration(90_000))
  check('humanDuration 45s → 45 秒', humanDuration(45_000) === '45 秒', humanDuration(45_000))
}

console.log('\n【3】TailBuffer：只留尾部 2KB（R4）')
{
  const b = new TailBuffer(16)
  b.push('0123456789')
  check('未满时原样', b.text() === '0123456789')
  b.push('abcdefghij')
  check('超出后只留最后 16 个字符', b.text() === '456789abcdefghij', b.text())
  check('length 不超上限', b.length === 16)
  const t = new TailBuffer(2048)
  t.push(Buffer.from('Traceback (most recent call last):\n  File "x"\nNameError: cannot access free variable \'shutil\'\n'))
  check('Buffer 输入 + lastLine 是最后一行非空', t.lastLine() === "NameError: cannot access free variable 'shutil'", t.lastLine())
  check('空缓冲 lastLine 为空串', new TailBuffer().lastLine() === '')
  const big = new TailBuffer(2048)
  big.push('x'.repeat(5000) + '\nEND')
  check('5000 字符 → 2048 且尾部完整', big.length === 2048 && big.text().endsWith('END'))
}

console.log('\n【4】pipelineArgs / pipelineEnv：key 只走 env 不走 argv（R5）')
{
  const key = 'sk-secret-should-not-appear-in-argv'
  const args = pipelineArgs({ root: '/v', llmKey: key, llmBaseUrl: 'https://api.deepseek.com', llmModel: 'deepseek-v4-flash', sensitiveAllowAi: false })
  check('有 key：argv 不含 key 明文', !args.join(' ').includes(key), args.join(' '))
  check('有 key：argv 不含 --llm-key 开关', !args.includes('--llm-key'))
  check('有 key：带 base-url 与 model，不带 --skip-llm', args.includes('--llm-base-url') && args.includes('--llm-model') && !args.includes('--skip-llm'))
  const noKey = pipelineArgs({ root: '/v', llmKey: null, llmBaseUrl: 'u', llmModel: 'm', sensitiveAllowAi: true })
  check('无 key：--skip-llm', noKey.includes('--skip-llm') && !noKey.includes('--llm-base-url'))
  check('A-8 开关照常进 argv', noKey.includes('--sensitive-allow-ai') && !args.includes('--sensitive-allow-ai'))
  check('argv 以 --vault <root> 开头', args[0] === '--vault' && args[1] === '/v')
  const env = pipelineEnv({ PATH: '/bin', LLM_API_KEY: 'stale-dev-key' }, key)
  check('有 key：env.LLM_API_KEY = key', env.LLM_API_KEY === key)
  check('保留其它环境变量', env.PATH === '/bin')
  const envNo = pipelineEnv({ PATH: '/bin', LLM_API_KEY: 'stale-dev-key' }, null)
  check('无 key：开发机 shell 里挂的 LLM_API_KEY 被清掉（不许悄悄替客户付账）', !('LLM_API_KEY' in envNo))
}

console.log('\n【5】isSafeVaultRoot：家目录 / 磁盘根 / 外接卷根 / iCloud 根 拒（N6）')
{
  const home = homedir()
  const bad = (p: string, why: string): void => {
    const v = isSafeVaultRoot(p)
    check(`拒 ${why}：${p}`, !v.ok && !!(v as { reason?: string }).reason, JSON.stringify(v))
  }
  bad('/', '磁盘根')
  bad(home, '家目录')
  bad(home + '/', '家目录（带尾斜杠）')
  bad(join(home, 'Library', 'Mobile Documents'), 'iCloud 根')
  bad('/Volumes/外接盘', '外接卷根')
  bad('/Volumes', '/Volumes 本身')
  bad('/Users', '/Users')
  const ok = (p: string): void => check(`放行：${p}`, isSafeVaultRoot(p).ok, JSON.stringify(isSafeVaultRoot(p)))
  ok(join(home, 'Documents', '我的知识库'))
  ok(join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', '知识库'))
  ok('/Volumes/外接盘/知识库')
  ok('/tmp/mcnai-e2e-vault')
  const r = isSafeVaultRoot(home)
  check('拒绝理由是人话（含「家目录」与下一步建议）', !r.ok && /家目录/.test(r.reason) && /文件夹/.test(r.reason), r.ok ? '' : r.reason)
}

console.log('\n【6】judgeNotify：完成才通知 · 失败才响铃 · 眼前不打扰（F10）')
{
  const j = (p: Parameters<typeof judgeNotify>[0]) => judgeNotify(p)
  // 界面就在眼前：一条都不发（他正看着呢，再弹一条只是打扰）
  check('聚焦时不发', !j({ focused: true, kind: 'inbox-done', elapsedMs: 999_999 }).notify)
  check('聚焦时连"需要确认"也不发（弹窗就在他面前）', !j({ focused: true, kind: 'confirm' }).notify)
  // 完成类：跑得够久才值得打断
  check('两秒就完的入库不通知', !j({ focused: false, kind: 'inbox-done', elapsedMs: 2000 }).notify)
  check(`超过 ${NOTIFY_MIN_MS / 1000} 秒才通知`, j({ focused: false, kind: 'inbox-done', elapsedMs: NOTIFY_MIN_MS }).notify)
  check('完成是静音的（"你可以回来看了"不必占用听觉）', j({ focused: false, kind: 'inbox-done', elapsedMs: 60_000 }).silent)
  check('没给耗时就当很短，不通知', !j({ focused: false, kind: 'inbox-done' }).notify)
  // 失败才响铃
  const bad = j({ focused: false, kind: 'inbox-failed', elapsedMs: 1000 })
  check('失败必通知且响铃（哪怕只跑了一秒）', bad.notify && !bad.silent)
  // 需要确认：60 秒不理默认拒，切走了根本不知道有件事在等他
  const ask = j({ focused: false, kind: 'confirm' })
  check('需要确认必通知且响铃', ask.notify && !ask.silent)
  check('产物完成：给足耗时就通知、且静音', j({ focused: false, kind: 'artifact', elapsedMs: 60_000 }).notify)
}

console.log(failed ? `\n❌ ${failed} 条不通过\n` : '\n✅ 全部通过\n')
process.exit(failed ? 1 : 0)

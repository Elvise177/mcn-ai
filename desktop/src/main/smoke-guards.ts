import { join } from 'path'
import { homedir } from 'os'
import { judgeTimeout, resolveTimeoutMs, humanDuration, DEFAULT_AGENT_TIMEOUT_MIN, WARN_RATIO } from './agent/timeout'
import { TailBuffer } from './lib/tail-buffer'
import { pipelineArgs, pipelineEnv } from './lib/pipeline'
import { isSafeVaultRoot } from './vault/wizard'
import { judgeNotify, NOTIFY_MIN_MS } from './lib/notify'
import { giveUpReason, judgeAttempts, parseAttempts, parseFailReasons, MAX_ATTEMPTS } from './inbox/attempts'
import { judgeVaultBack, judgeVaultLost, resolveProbeMs, DEFAULT_PROBE_MS } from './vault/lost'

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

console.log('\n【7】judgeAttempts：连着几轮进不去的文件停掉自动重跑（F11 / 审计 Q10）')
{
  const T = 1_700_000_000_000
  // 循环形态：某阶段崩 → 原件不归档 → 重启 watcher 重拾 → 整条链再跑一遍 → 再崩。**打标是花钱的**
  let a = judgeAttempts({}, ['坏文件.docx'], '转换崩了', T)
  check('第 1 轮：记一笔，不搬走', a.next['坏文件.docx']?.count === 1 && a.giveUp.length === 0)
  a = judgeAttempts(a.next, ['坏文件.docx'], '转换崩了', T + 1)
  check('第 2 轮：累计到 2，还给它机会', a.next['坏文件.docx']?.count === 2 && a.giveUp.length === 0)
  a = judgeAttempts(a.next, ['坏文件.docx'], '转换崩了', T + 2)
  check(`第 ${MAX_ATTEMPTS} 轮：搬进 .failed`, a.giveUp.length === 1 && a.giveUp[0] === '坏文件.docx')
  check('搬走之后不再留账（别让它在 attempts.json 里长住）', !a.next['坏文件.docx'])

  /**
   * **「连续」这个词得当真**：中间成功过一次就清零。
   * 不清的话，一个文件今天失败两次、下个月又失败一次，会被判成"连续三次"停掉自动重试，
   * 而它中间明明进去过——用户看到的是一个好文件莫名其妙不再被处理。
   */
  let b = judgeAttempts({}, ['时好时坏.xlsx'], '当时被占用', T)
  b = judgeAttempts(b.next, ['时好时坏.xlsx'], '当时被占用', T + 1)
  check('失败两轮：账上是 2', b.next['时好时坏.xlsx']?.count === 2)
  b = judgeAttempts(b.next, [], undefined, T + 2) // 这一轮它进去了 → 不在投递箱里
  check('成功一次账就清零', !b.next['时好时坏.xlsx'] && b.giveUp.length === 0, JSON.stringify(b.next))
  b = judgeAttempts(b.next, ['时好时坏.xlsx'], '又崩了', T + 3)
  check('清零后重新从 1 数起（不是接着 3）', b.next['时好时坏.xlsx']?.count === 1)

  // 跑成功的那一轮投递箱是空的：既不记账也不搬东西
  const clean = judgeAttempts({ 'x.md': { count: 2, lastAt: T } }, [], undefined, T)
  check('投递箱清空 → 旧账全清、无人被搬走', Object.keys(clean.next).length === 0 && clean.giveUp.length === 0)

  // 多个文件各记各的
  const multi = judgeAttempts({ 'a.docx': { count: 2, lastAt: T }, 'b.pdf': { count: 1, lastAt: T } }, ['a.docx', 'b.pdf'], '崩了', T)
  check('多文件各算各的：a 到上限被搬走、b 继续记', multi.giveUp.join() === 'a.docx' && multi.next['b.pdf']?.count === 2)

  // 原因要说清"为什么不再自动重试"，否则用户看着像被吞了
  const why = giveUpReason({ count: 3, lastAt: T, lastReason: '转换崩了' })
  check('给用户的原因写明了上限与出口', /连续 3 轮/.test(why) && /停止自动重试/.test(why) && /全部重试/.test(why), why.replace(/\n/g, ' '))

  // 坏账本不该让整条链停摆
  check('attempts.json 坏了 → 当没有账，从头数', Object.keys(parseAttempts('{不是 json')).length === 0)
  check('数组 / null 也当没有账', Object.keys(parseAttempts('[1,2]')).length === 0 && Object.keys(parseAttempts('null')).length === 0)
  check('脏字段被剔掉（count 不是正数的不算）', Object.keys(parseAttempts('{"a":{"count":"3"},"b":{"count":0},"c":{"count":2}}')).join() === 'c')

  /**
   * `失败原因.txt` 的解析。**这是补一个从没成立过的判据**：盘上的格式是
   * pipeline 写的「· 名字 / 缩进 原因：…」，而读的那一半按 `名字 —— 原因` split，
   * 两种破折号一个都不在文件里 → reason 恒为 undefined，界面上的失败清单
   * 只有一串光秃秃的文件名。0.1.2 修过"把原因扔掉"的写那一半，读这一半没跟上。
   * 下面这段是**从真实产物里抄回来的原样文本**，别改格式。
   */
  const real = [
    '这些文件没能进知识库，原件原样保留在这个文件夹里。',
    '',
    '· 工作-执行类/直播脚本/直播脚本1.md',
    '    原因：暂不支持 .md 格式',
    '· 扫描件.pdf',
    '    原因：扫描件/纯图 PDF（12 页整本零文字），需 OCR 才能入库',
    '',
    '能支持的格式：.docx .doc .pdf .xlsx .pptx .md .txt',
  ].join('\n')
  const parsed = parseFailReasons(real)
  check('按 basename 索引（盘上只有文件名，清单里写的是相对路径）', parsed['直播脚本1.md'] === '暂不支持 .md 格式', JSON.stringify(parsed))
  check('第二条也解析到，且原因没被截断', /需 OCR/.test(parsed['扫描件.pdf'] ?? ''), JSON.stringify(parsed))
  check('末尾那句「能支持的格式」不会被当成一条记录', !Object.keys(parsed).some((k) => k.includes('能支持的格式')), Object.keys(parsed).join('|'))

  // F11 写的原因是**多行**的，续行不许被吞掉——「下一步怎么办」就在续行里
  const multiLine = parseFailReasons(['· 坏文件.docx', `    原因：${giveUpReason({ count: 3, lastAt: 0, lastReason: '转换崩了' })}`].join('\n'))
  check('多行原因的续行接上了（"全部重试"那句在第三行）', /全部重试/.test(multiLine['坏文件.docx'] ?? ''), multiLine['坏文件.docx'] ?? '')
  check('空文件 / 垃圾内容不炸', Object.keys(parseFailReasons('')).length === 0 && Object.keys(parseFailReasons('随便一句话')).length === 0)
}

console.log('\n【8】judgeVaultLost：库目录被拔掉/移走要顶一条，别静默失效（R16）')
{
  const OK = { exists: true, readable: true }
  /**
   * 要接住的静默失效：库在外接盘/网盘上，盘被拔了之后 chokidar 从此不报事件，
   * 而应用一点反应都没有——文件树还画着旧快照、检索还在旧索引上命中，
   * 点开笔记才报「找不到文件」。用户以为库好好的，实际每次写入都写去了不存在的路径。
   */
  const gone = judgeVaultLost({ kind: 'unlinkDir', rel: '' }, { exists: false, readable: false })
  check('根目录没了 → lost', gone.lost && /移动|磁盘|网盘/.test(gone.reason ?? ''), JSON.stringify(gone))
  const noPerm = judgeVaultLost({ kind: 'error', message: 'EACCES' }, { exists: true, readable: false })
  check('目录还在但打不开 → lost，且理由是权限那一种', noPerm.lost && /权限|网盘/.test(noPerm.reason ?? ''), JSON.stringify(noPerm))
  check('两种理由不是同一句（下一步动作不一样）', gone.reason !== noPerm.reason)

  /**
   * **光有 error 事件不算丢**：chokidar 的 error 大多是单个文件的瞬时问题
   * （正在被写、被别的程序锁着）。见 error 就顶一条吓人的横幅比不报还坏，
   * 所以一律以磁盘探测为准。
   */
  check('error 但磁盘好好的 → 不算丢', !judgeVaultLost({ kind: 'error', message: 'EBUSY 某个文件' }, OK).lost)
  // 有些同步盘会"删了又立刻建回来"，事件是真的、状态却已经恢复
  check('unlinkDir 但磁盘好好的 → 不算丢（删了又建回来）', !judgeVaultLost({ kind: 'unlinkDir', rel: '' }, OK).lost)
  // 子目录被删是正常操作，压根不该走到这条判据（orchestrator 只在 rel 为空串时才问）
  check('子目录的 unlinkDir 也以磁盘为准', !judgeVaultLost({ kind: 'unlinkDir', rel: '80_资料库/旧' }, OK).lost)

  // 盘插回来要能自己撤掉顶条，不能逼用户重启（同 Q11 离线重探的教训）
  check('judgeVaultBack：两项都好才算回来', judgeVaultBack(OK))
  check('judgeVaultBack：只在但读不了不算回来', !judgeVaultBack({ exists: true, readable: false }))
  check('judgeVaultBack：不在就不算回来', !judgeVaultBack({ exists: false, readable: true }))

  // 心跳间隔：走查调快，生产不读；垃圾值一律回出厂
  check(`出厂 ${DEFAULT_PROBE_MS / 1000} 秒`, resolveProbeMs(undefined) === DEFAULT_PROBE_MS)
  check('MCNAI_E2E_VAULT_PROBE=800 覆盖为 0.8 秒', resolveProbeMs('800') === 800)
  check('垃圾值 / 负数 / 过小值一律回出厂', resolveProbeMs('x') === DEFAULT_PROBE_MS && resolveProbeMs('-5') === DEFAULT_PROBE_MS && resolveProbeMs('10') === DEFAULT_PROBE_MS)
}

console.log(failed ? `\n❌ ${failed} 条不通过\n` : '\n✅ 全部通过\n')
process.exit(failed ? 1 : 0)

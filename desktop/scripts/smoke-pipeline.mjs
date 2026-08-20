#!/usr/bin/env node
/**
 * 冻结 pipeline 的快速冒烟（约 10 秒，零 LLM、零网络，`npm run smoke:pipeline`）。
 *
 * ## 为什么要有它
 *
 * 2026-08-19 我在 `cli.py` 的一个 `if` 块里写了 `import tempfile, shutil`，
 * 于是 `shutil` 变成整个 `main()` 的局部变量，**投递箱分流与归档当场全废**
 * （`NameError: cannot access free variable 'shutil'`）。
 *
 * 这个 bug：typecheck 管不到（是 Python）、`convert-one` 自己那条路好好的、
 * `count-stale` 也没事——**只有真跑一轮投递才炸得出来**。
 * 而当时逮到它的是 15 分钟的 GUI 走查，红在第 3000 行。
 *
 * 这个脚本拿一个 3 文件的固定小库跑一遍真的投递，**10 秒内给出同样的结论**。
 * 改过 pipeline 就先跑它，别拿走查当第一道闸。
 *
 * ## 覆盖的阶段
 *
 * 分流（参考资料 → 70_外部资料）／转换／归档（原件进 .done）／
 * 打标只打本批（`--files`，方案 C）／`convert-one` 三条路径／`--count-stale`。
 */
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ROOT = process.cwd()
const BIN = join(ROOT, 'resources/pipeline/mcn-ingest')
const SAMPLE = join(ROOT, 'e2e/sample.docx')

let bad = 0
const ok = (m, d = '') => console.log(`  ✓ ${m}${d ? ` — ${d}` : ''}`)
const fail = (m, d = '') => {
  bad++
  console.log(`  ✗ ${m}${d ? ` — ${d}` : ''}`)
}

if (!existsSync(BIN)) {
  console.log(`❌ 找不到冻结产物 ${BIN}\n   在 pkb-pipeline 里 pyinstaller 之后：cp -R dist/mcn-ingest/. desktop/resources/pipeline/`)
  process.exit(1)
}

/** 跑一次 mcn-ingest，返回 {code, lines(JSON 事件), raw} */
function run(args) {
  try {
    const out = execFileSync(BIN, args, { encoding: 'utf8', timeout: 120_000 })
    return { code: 0, raw: out, events: parse(out) }
  } catch (e) {
    const out = String(e.stdout ?? '')
    return { code: e.status ?? 1, raw: out + String(e.stderr ?? ''), events: parse(out) }
  }
}
const parse = (out) =>
  out
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })

const V = join(tmpdir(), `mcnai-pipe-smoke-${Date.now()}`)

console.log('\npipeline 快速冒烟（零 LLM）')
console.log(`  固定小库：${V}\n`)

// —— 备料：一份走分流线、一份走业务线、一份必然转换失败 ——
mkdirSync(join(V, '00_投递箱/参考资料'), { recursive: true })
mkdirSync(join(V, '80_Library'), { recursive: true })
copyFileSync(SAMPLE, join(V, '00_投递箱/参考资料/参考书.docx'))
copyFileSync(SAMPLE, join(V, '00_投递箱/业务文件.docx'))
writeFileSync(join(V, '00_投递箱/损坏的.docx'), '这不是真的 docx')

console.log('【1】一轮真投递：分流 / 转换 / 归档')
{
  const r = run(['--vault', V, '--skip-llm'])
  const stage = (n) => r.events.find((e) => e.stage === n)
  const errs = r.events.filter((e) => e.status === 'error')

  // 这一条就是 shutil 那个 bug 的正面拦截：它当时报的正是 route_参考资料 error
  stage('route_参考资料')?.status === 'ok'
    ? ok('分流阶段 ok')
    : fail('分流阶段失败', JSON.stringify(stage('route_参考资料') ?? r.raw.slice(-200)))
  stage('convert')?.status === 'ok' ? ok('转换阶段 ok') : fail('转换阶段失败', JSON.stringify(stage('convert')))
  stage('archive')?.status === 'ok' ? ok('归档阶段 ok') : fail('归档阶段失败', JSON.stringify(stage('archive')))
  errs.length === 0 ? ok('整轮零 error 事件') : fail(`有 ${errs.length} 个阶段报 error`, JSON.stringify(errs.slice(0, 2)))

  existsSync(join(V, '70_外部资料/参考书.md'))
    ? ok('分流产物落到 70_外部资料')
    : fail('分流产物没落位', readdirSync(V).join(','))
  const done = existsSync(join(V, '00_投递箱/.done')) ? readdirSync(join(V, '00_投递箱/.done')).length : 0
  done > 0 ? ok('原件已归档进 .done') : fail('原件没进 .done')
  // A-4：转换失败的原件要进 .failed，不许静默吞掉
  existsSync(join(V, '00_投递箱/.failed')) ? ok('损坏文件进了 .failed（A-4）') : fail('损坏文件没进 .failed')
}

console.log('\n【2】打标只打本批（方案 C 的核心）')
{
  // 不给 key 时打标会 skip；这里只验参数链路没炸、且**没有**去扫全库
  const r = run(['--vault', V, '--skip-llm'])
  const tag = r.events.find((e) => e.stage === 'tag_llm')
  tag ? ok(`打标阶段有事件（${tag.status}）`, tag.reason ?? '') : fail('打标阶段没有任何事件')
}

console.log('\n【3】--count-stale：不调 LLM、不写盘')
{
  const r = run(['--vault', V, '--count-stale', '--skip-llm'])
  const e = r.events.find((x) => x.stage === 'tag_stale')
  e && typeof e.stale === 'number' ? ok(`回了 JSON（stale=${e.stale} / total=${e.total}）`) : fail('没有回 tag_stale 事件', r.raw.slice(-200))
}

console.log('\n【4】convert-one：成功 / 损坏 / 不支持')
{
  const out1 = join(V, '_tmp1')
  const r1 = run(['convert-one', SAMPLE, out1])
  const e1 = r1.events.find((x) => x.stage === 'convert_one')
  e1?.status === 'ok' && existsSync(String(e1.out)) ? ok('正常 docx → md') : fail('正常 docx 转换失败', JSON.stringify(e1))

  const brokenP = join(V, 'broken.docx')
  writeFileSync(brokenP, 'x')
  const r2 = run(['convert-one', brokenP, join(V, '_tmp2')])
  const e2 = r2.events.find((x) => x.stage === 'convert_one')
  r2.code !== 0 && e2?.status === 'error' && /损坏|无法解析/.test(String(e2.message))
    ? ok('损坏文件 → 非 0 退出 + 人话原因')
    : fail('损坏文件的处理不对', JSON.stringify({ code: r2.code, e2 }))

  const zipP = join(V, 'x.zip')
  writeFileSync(zipP, 'x')
  const r3 = run(['convert-one', zipP, join(V, '_tmp3')])
  const e3 = r3.events.find((x) => x.stage === 'convert_one')
  e3?.status === 'error' && /不支持/.test(String(e3.message))
    ? ok('不支持的格式 → 说清楚是格式问题')
    : fail('不支持格式的处理不对', JSON.stringify(e3))
}

rmSync(V, { recursive: true, force: true })
console.log(bad === 0 ? '\n✅ pipeline 冒烟全部通过\n' : `\n❌ ${bad} 条不通过\n`)
process.exit(bad === 0 ? 0 : 1)

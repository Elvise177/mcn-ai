import { judgeWrite, FORBIDDEN } from './agent/write-guard'
import { join } from 'path'

/**
 * B4 写权限判定的纯逻辑冒烟（零 token，`npm run smoke:write`）。
 *
 * **为什么要单独一条**：硬禁区是这套设计里唯一"用户点不到"的防线——
 * 确认卡可以被诱导点同意，硬禁区不行。所以它必须有断言守着，
 * 而且要能在不起界面的情况下跑（走查里那几条验的是 UI，这条验的是判据本身）。
 */

const ROOT = '/tmp/fake-vault'
const ART = join(ROOT, '90_产物')

let bad = 0
const ok = (m: string): void => console.log(`  ✓ ${m}`)
const fail = (m: string, got: unknown = ''): void => {
  bad++
  console.log(`  ✗ ${m} —— 实得 ${JSON.stringify(got)}`)
}
const expect = (label: string, p: string, want: 'allow-artifact' | 'ask' | 'deny', root = ROOT): void => {
  const v = judgeWrite(p, root, ART)
  v.kind === want ? ok(`${label}：${want}`) : fail(`${label} 应为 ${want}`, v)
}

console.log('\n【1】产物目录：一直放行，不打扰用户')
expect('相对路径 90_产物', '90_产物/周报.docx', 'allow-artifact')
expect('绝对路径 90_产物', join(ART, '2026', 'x.pptx'), 'allow-artifact')

console.log('\n【2】库内普通笔记：要问用户')
expect('库内 md', join(ROOT, '80_Library', '笔记.md'), 'ask')
expect('相对路径的库内 md', '80_Library/笔记.md', 'ask')
expect('新建到库内子目录', join(ROOT, '20_公司管理', '新的.md'), 'ask')

console.log('\n【3】硬禁区：永远拒，连确认卡都不弹')
for (const seg of FORBIDDEN.segments) {
  expect(`目录段 ${seg}`, join(ROOT, seg, 'x.md'), 'deny')
  expect(`深层的 ${seg}`, join(ROOT, '80_Library', seg, 'x.md'), 'deny')
}
for (const f of FORBIDDEN.files) {
  expect(`内部文件 ${f}`, join(ROOT, '80_Library', f), 'deny')
}
expect('任何 . 开头的文件', join(ROOT, '.env'), 'deny')
expect('投递箱的 .done', join(ROOT, '00_投递箱', '.done', '20260819', 'a.docx'), 'deny')

console.log('\n【4】沙箱边界：库外一律拒')
expect('库外绝对路径', '/etc/hosts', 'deny')
expect('用户主目录', '/Users/someone/Desktop/x.md', 'deny')
expect('../ 穿越', join(ROOT, '..', '别人的库', 'x.md'), 'deny')
expect('../../ 多级穿越', join(ROOT, '80_Library', '..', '..', 'x.md'), 'deny')

console.log('\n【5】没开库时')
{
  const v = judgeWrite('80_Library/x.md', null, ART)
  v.kind === 'deny' ? ok('没开库 → deny') : fail('没开库应 deny', v)
  // 产物目录在没开库时仍然放行：它不依赖 vaultRoot
  const v2 = judgeWrite(join(ART, 'x.docx'), null, ART)
  v2.kind === 'allow-artifact' ? ok('没开库但写产物 → 放行') : fail('产物应放行', v2)
}

console.log('\n【6】空路径 / 垃圾输入')
{
  const v = judgeWrite('', ROOT, ART)
  v.kind === 'deny' ? ok('空路径 → deny') : fail('空路径应 deny', v)
}

/**
 * 【7】备份与撤销：**真建文件、真改、真撤销、真比对内容**。
 *
 * 放开 AI 写权限的三层里，这是最后一道——"改错了能一键回去"。
 * 光有代码不算数：撤销恢复路径必须实测一次（用户点名要求的）。
 */
async function undoTests(): Promise<void> {
  const { promises: fs } = await import('fs')
  const { tmpdir } = await import('os')
  const { backupBeforeWrite, undoWrite } = await import('./agent/write-backup')

  const root = join(tmpdir(), `mcnai-undo-${Date.now()}`)
  await fs.mkdir(join(root, '80_Library'), { recursive: true })

  console.log('\n【7】备份与撤销（真文件）')

  // 7a 改写已有文件 → 撤销应恢复原文，一字不差
  {
    const rel = '80_Library/原有笔记.md'
    const original = '# 原文\n\n这段话必须能原样回来。\n'
    await fs.writeFile(join(root, rel), original, 'utf-8')
    const id = await backupBeforeWrite('smoke-session', root, rel)
    await fs.writeFile(join(root, rel), '被 AI 改掉了', 'utf-8')
    const r = await undoWrite(id)
    const now = await fs.readFile(join(root, rel), 'utf-8')
    r.ok && now === original ? ok('改写后撤销 → 原文一字不差地回来了') : fail('改写撤销失败', { r, now })
  }

  // 7b 新建文件 → 撤销应把它删掉（本来就不存在，恢复 = 不该留下）
  {
    const rel = '80_Library/AI新建的.md'
    const id = await backupBeforeWrite('smoke-session', root, rel) // 此刻文件还不存在
    await fs.writeFile(join(root, rel), '新建内容', 'utf-8')
    const r = await undoWrite(id)
    const gone = !(await fs.stat(join(root, rel)).catch(() => null))
    r.ok && gone ? ok('新建后撤销 → 文件被移除') : fail('新建撤销失败', { r, gone })
  }

  // 7c 同一个 id 撤销两次：第二次不该把别的东西弄坏
  {
    const rel = '80_Library/幂等.md'
    await fs.writeFile(join(root, rel), 'A', 'utf-8')
    const id = await backupBeforeWrite('smoke-session', root, rel)
    await fs.writeFile(join(root, rel), 'B', 'utf-8')
    await undoWrite(id)
    await undoWrite(id)
    const now = await fs.readFile(join(root, rel), 'utf-8')
    now === 'A' ? ok('重复撤销幂等（内容仍是 A）') : fail('重复撤销把内容弄坏了', now)
  }

  // 7c2 **撤销之后要能告诉模型**（2026-08-19 真人实测逼出来的洞）：
  //     撤销发生在主进程，而对话上下文里模型仍记着"我已经改好了"，
  //     于是用户撤销后再让它改，它回「上一轮已全部替换完，无需再次操作」。
  {
    const { takeUndoNotice } = await import('./agent/write-backup')
    const rel = '80_Library/要被撤销的.md'
    await fs.writeFile(join(root, rel), '原文', 'utf-8')
    const id = await backupBeforeWrite('sess-A', root, rel)
    await fs.writeFile(join(root, rel), '改过的', 'utf-8')
    await undoWrite(id)
    const notice = takeUndoNotice('sess-A')
    notice.includes(rel) && /撤销/.test(notice)
      ? ok('撤销后能生成给模型的告知（含文件名）')
      : fail('撤销后没有生成告知', JSON.stringify(notice))
    takeUndoNotice('sess-A') === ''
      ? ok('告知取走即清（不会每轮重复念叨）')
      : fail('告知没有被清空，会重复污染上下文')
    takeUndoNotice('sess-B') === '' ? ok('不串会话（B 会话拿不到 A 的告知）') : fail('告知串会话了')
  }

  // 7d 找不到的备份 id：报错而不是崩
  {
    const r = await undoWrite('根本不存在的id')
    !r.ok && !!r.error ? ok('未知备份 id → 返回错误而不是抛异常') : fail('未知 id 应返回错误', r)
  }

  await fs.rm(root, { recursive: true, force: true })
}

// 打包目标是 CJS，不支持顶层 await——包一层
void undoTests().then(() => {
  console.log(bad === 0 ? '\n✅ 写权限判据 + 备份撤销全部通过\n' : `\n❌ ${bad} 条未通过\n`)
  process.exit(bad === 0 ? 0 : 1)
})

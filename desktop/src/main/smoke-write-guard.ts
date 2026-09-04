import { approvalKey, judgeWrite, isPathWritable, FORBIDDEN } from './agent/write-guard'
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
/** 布尔断言（本文件原来只有 ok/fail 两个打印器，没有"判一下"的入口） */
const check = (label: string, cond: boolean, got: unknown = ''): void => {
  cond ? ok(label) : fail(label, got)
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
 * 【6b】产物目录吃配置（PLAN-v2 R6）。
 * 以前 `90_产物` 写死在两处（agent 建目录 + 这里的相对路径判断），库里把产物目录改名
 * （layout.json `artifacts: "产物区"`）之后：AI 写到旧名目录、产物面板盯新名目录 → 面板一片空白。
 * 这组断言用一个改了名的产物目录跑同一套判据，落对地方才算过。
 */
console.log('\n【6b】改名产物目录后写入落对地方（R6）')
{
  const ART2 = join(ROOT, '产物区')
  const v1 = judgeWrite('产物区/周报.docx', ROOT, ART2)
  v1.kind === 'allow-artifact' ? ok('改名后：相对路径 产物区/ → 放行') : fail('改名后相对路径应放行', v1)
  const v2 = judgeWrite(join(ART2, '2026', 'x.pptx'), ROOT, ART2)
  v2.kind === 'allow-artifact' ? ok('改名后：绝对路径 产物区/ → 放行') : fail('改名后绝对路径应放行', v2)
  // 旧名不再是产物目录：它现在只是一个普通库内目录，要问用户（不许再靠写死的 90_产物 放行）
  const v3 = judgeWrite('90_产物/周报.docx', ROOT, ART2)
  v3.kind === 'ask' ? ok('改名后：旧名 90_产物/ 退化成普通目录 → ask') : fail('旧名 90_产物 不该再被放行', v3)
  // 产物目录名是别的目录名的前缀时不能误放（`产物区2/` ≠ `产物区/`）
  const v4 = judgeWrite('产物区2/x.md', ROOT, ART2)
  v4.kind === 'ask' ? ok('前缀相似的目录不误放（产物区2/ → ask）') : fail('产物区2/ 被当成产物目录放行了', v4)
}

/**
 * 【6c】三段判定 `isPathWritable`（PLAN-v2 N5）：可写根 → 受保护前缀 → 受保护文件。
 * 单独导出是为了让写入方之外的调用者（将来的批准缓存 F24）也走同一份判据。
 */
console.log('\n【6c】isPathWritable 三段判定（N5）')
{
  const w = (p: string): ReturnType<typeof isPathWritable> => isPathWritable(ROOT, p)
  w('80_Library/笔记.md').ok ? ok('普通笔记 → 可写') : fail('普通笔记应可写', w('80_Library/笔记.md'))
  !w('.mcnai/layout.json').ok ? ok('.mcnai/layout.json → 拒（布局配置）') : fail('.mcnai 应拒')
  !w('.obsidian/app.json').ok ? ok('.obsidian/ → 拒') : fail('.obsidian 应拒')
  !w(join(ROOT, '.git', 'HEAD')).ok ? ok('.git/HEAD → 拒') : fail('.git 应拒')
  !w('80_Library/node_modules/x.js').ok ? ok('深层 node_modules → 拒（不带点也在名单上）') : fail('node_modules 应拒')
  !w('../别人的库/x.md').ok ? ok('../ 穿越 → 拒（不在可写根内）') : fail('穿越应拒')
  !w(ROOT).ok ? ok('库根本身 → 拒（不能当文件写）') : fail('库根应拒')
  const rel = w(join(ROOT, '20_公司管理', '新的.md'))
  rel.ok && rel.rel === join('20_公司管理', '新的.md') ? ok('通过时给出相对路径') : fail('相对路径不对', rel)
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

console.log('\n【7b】approvalKey：「本会话此目录不再问」的批准粒度（F24）')
{
  // 键 = 动作类 + **目录前缀**，不是具体文件：用户点头的心理契约是
  // 「这个目录里的东西你可以改」；按文件记的话，改同目录第二个文件又要问一遍 = 这一档等于没有
  check(
    '同目录不同文件是同一个键',
    approvalKey('Write', '80_资料库/工作/a.md') === approvalKey('Edit', '80_资料库/工作/b.md')
  )
  check(
    '不同目录必须是不同的键（不许一次点头放开整个库）',
    approvalKey('Write', '80_资料库/工作/a.md') !== approvalKey('Write', '20_公司管理/a.md')
  )
  check(
    '父子目录也不是同一个键（点头的是这一层，不是它下面所有层）',
    approvalKey('Write', '80_资料库/a.md') !== approvalKey('Write', '80_资料库/工作/a.md')
  )
  check(
    'Write 与 Edit 归同一类（对用户是同一件事，不该点两次头）',
    approvalKey('Write', 'x/a.md') === approvalKey('Edit', 'x/a.md')
  )
  check('库根下的文件有自己的键', approvalKey('Write', '欢迎.md') === 'write:')
}

// 打包目标是 CJS，不支持顶层 await——包一层
void undoTests().then(() => {
  console.log(bad === 0 ? '\n✅ 写权限判据 + 备份撤销全部通过\n' : `\n❌ ${bad} 条未通过\n`)
  process.exit(bad === 0 ? 0 : 1)
})

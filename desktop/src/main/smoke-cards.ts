import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildEntityCards, canon, prefixSame, stripNote } from './vault/entity-cards'

/**
 * 实体建卡器的**纯逻辑冒烟**：归一、阈值、敏感继承、增量与冲突、文档侧双链。
 * 零网络、零 token（没有打标 key → LLM 仲裁那一步整步跳过，只走规则）。
 *
 * 跑法：`npm run smoke:cards`
 *
 * 为什么值得单独一个入口：建卡这一层错了**不会报错**，只会悄悄错合并
 * （两个人并成一张卡）或者悄悄漏建。而"宁可两张卡，不可错合"这条边界
 * 只能靠反例断言守——正例跑通不证明它不会错合。
 *
 * 真链路那一条（真实打标产出的 entities、图谱上真的连起来）在 Maggie 全量重跑里。
 */

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const LIB = '80_资料库'

/** 造一篇库内笔记 */
async function note(
  root: string,
  rel: string,
  fm: {
    talent?: string[]
    product?: string[]
    partner?: string[]
    sensitive?: boolean
    contract?: boolean
    /** 自定义正文——验"实体抽不出来但正文里提了"那条路（反向扫描） */
    body?: string
  }
): Promise<void> {
  const abs = join(root, LIB, rel)
  await fs.mkdir(join(abs, '..'), { recursive: true })
  const lines = [
    '---',
    'doc_type: 其他',
    `entities_talent: ${JSON.stringify(fm.talent ?? [])}`,
    `entities_product: ${JSON.stringify(fm.product ?? [])}`,
    `entities_partner: ${JSON.stringify(fm.partner ?? [])}`,
    ...(fm.sensitive ? ['sensitive: true'] : []),
    ...(fm.contract ? ['is_contract: true'] : []),
    '---',
    '',
    fm.body ?? '正文若干。',
  ]
  await fs.writeFile(abs, lines.join('\n'), 'utf-8')
}

async function readCard(root: string, kind: string, name: string): Promise<string | null> {
  const dir = { talent: '30_实体/达人', product: '30_实体/产品', partner: '30_实体/合作方' }[kind]!
  try {
    return await fs.readFile(join(root, dir, `${name}.md`), 'utf-8')
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  console.log('\n【1】归一的三条规则（纯函数）')
  check('R1 全角/尾标点归一', canon('灰太太 ．') === '灰太太' && canon('ＬｕＬｕ.') === 'LuLu')
  check('R2 括号备注剥离', stripNote('灰太太(孙芳兵)') === '灰太太' && stripNote('小熊饼干（日常版）') === '小熊饼干')
  check('R2 缺右括号也剥（源数据里真有）', stripNote('长卿子（带货版') === '长卿子')
  check('R2 剥完只剩一个字就不剥', stripNote('王（老板）') === '王（老板）')
  check('R3 分号拼接归一', prefixSame('霞飞双层高光粉', '霞飞双层高光粉；定轴半年抛'))
  check('R3 两字前缀不许吃长名（否则合作方会吞掉产品）', !prefixSame('霞飞', '霞飞双层高光粉'))
  check('R3 没有分隔符的不算', !prefixSame('小飞蛾', '小飞蛾计划'))

  const root = join(tmpdir(), `mcnai-smoke-cards-${process.pid}`)
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(join(root, '.mcnai'), { recursive: true })
  await fs.writeFile(
    join(root, '.mcnai', 'layout.json'),
    JSON.stringify({ library: LIB, entities: { talent: '30_实体/达人', product: '30_实体/产品', partner: '30_实体/合作方' } })
  )

  // 灰太太：三种写法散在三篇里 → 必须收成一张卡
  await note(root, '作业评改灰太太.md', { talent: ['灰太太(孙芳兵)'], product: ['罗小曼卧蚕盘'] })
  await note(root, '复盘.md', { talent: ['灰太太 '], product: ['霞飞双层高光粉；定轴半年抛'] })
  await note(root, '课件.md', { talent: ['灰太太'] })
  // 只被一篇提到的达人 → 不该建卡（阈值 ≥2）
  await note(root, '单篇提及.md', { talent: ['只出现一次的人'] })
  // 不错合反例：字形相近但是两个人
  await note(root, 'a.md', { talent: ['小飞蛾'] })
  await note(root, 'b.md', { talent: ['小飞蛾'] })
  await note(root, 'c.md', { talent: ['小飞象'] })
  await note(root, 'd.md', { talent: ['小飞象'] })
  // 合同：三类实体齐全，且是敏感文档
  await note(root, '年框.md', {
    partner: ['霞飞'],
    talent: ['灰太太', '皮蛋'],
    product: ['霞飞双层高光粉'],
    sensitive: true,
    contract: true,
  })
  // 仅由敏感文档支撑的达人 → 敏感继承
  await note(root, '达人信息表.md', { talent: ['只在敏感表里的人'], sensitive: true })
  await note(root, '目标管理总表.md', { talent: ['只在敏感表里的人'], sensitive: true })

  /**
   * 合同枢纽的真实形态：敏感文档走规则打标，规则层认不出自由文本 PII 块里的达人，
   * 于是 entities 是空的，但**正文里提了 82 次**（2026-08-18 全量重跑实测）。
   * 只按 entities 建链的话这份合同一条达人链都没有，图谱上不成其为枢纽。
   */
  await note(root, '年框-实体抽不出来.md', {
    partner: ['霞飞'],
    sensitive: true,
    contract: true,
    body: '达人信息：抖音名：灰太太 抖音号：xxx；抖音名：皮蛋 抖音号：yyy。主推霞飞双层高光粉。',
  })

  const st = await buildEntityCards(root, LIB)

  console.log('\n【2】归一与阈值')
  check('灰太太三种写法收成一张卡', (await readCard(root, 'talent', '灰太太')) !== null)
  check('带备注的写法没有单独成卡', (await readCard(root, 'talent', '灰太太(孙芳兵)')) === null)
  const hui = (await readCard(root, 'talent', '灰太太')) ?? ''
  check('aliases 记下被归进来的写法（可审计、可人工拆）', /aliases: \[.*孙芳兵.*\]/.test(hui), hui.split('\n')[4])
  check('分号拼接的产品并进主名', (await readCard(root, 'product', '霞飞双层高光粉')) !== null &&
    (await readCard(root, 'product', '霞飞双层高光粉；定轴半年抛')) === null)
  check('R4 跨类不合并：霞飞是合作方、霞飞双层高光粉是产品，两张卡',
    (await readCard(root, 'partner', '霞飞')) !== null && (await readCard(root, 'product', '霞飞双层高光粉')) !== null)
  check('达人阈值 ≥2：只被一篇提到的不建卡', (await readCard(root, 'talent', '只出现一次的人')) === null)
  check('合作方阈值 ≥1：一份年框就成卡', (await readCard(root, 'partner', '霞飞')) !== null)
  check('不错合：小飞蛾 / 小飞象 两张卡（无 key 时仲裁跳过 = 不合并）',
    (await readCard(root, 'talent', '小飞蛾')) !== null && (await readCard(root, 'talent', '小飞象')) !== null)

  console.log('\n【3】敏感继承与内容边界')
  const only = (await readCard(root, 'talent', '只在敏感表里的人')) ?? ''
  check('仅敏感文档支撑 → 卡继承 sensitive', /^sensitive: true$/m.test(only))
  check('敏感卡进 sensitivePaths（主进程靠它拦上云，不靠内存索引）',
    st.sensitivePaths.some((p) => p.includes('只在敏感表里的人')), JSON.stringify(st.sensitivePaths))
  check('普通卡不带 sensitive 标记', !/^sensitive: true$/m.test(hui))
  check('普通卡不写敏感来源的文件名（只报数）——链接文字也是内容，会上云',
    !hui.includes('年框') && !hui.includes('达人信息表') && /另有 \d+ 份敏感文档/.test(hui))
  check('敏感卡可以列全链接（它本身不上云）', only.includes('[[') && only.includes('仅本地'))

  console.log('\n【4】文档侧双链（合同=图谱枢纽）')
  const contract = await fs.readFile(join(root, LIB, '年框.md'), 'utf-8')
  check('段落标记与 07_sensitive_enrich 逐字相同', contract.includes('## 🔗 关联'))
  for (const [kind, name] of [['达人', '灰太太'], ['产品', '霞飞双层高光粉'], ['合作方', '霞飞']]) {
    check(`合同连到${kind}卡`, contract.includes(`[[30_实体/${kind}/${name}|`), contract.split('## 🔗 关联')[1])
  }
  check('建卡器报出了补写的双链条数', st.links > 0, String(st.links))

  console.log('\n【4b】反向正文扫描（合同枢纽的命根）')
  {
    const c = await fs.readFile(join(root, LIB, '年框-实体抽不出来.md'), 'utf-8')
    check('entities 为空但正文提到 → 照样连上达人卡', c.includes('30_实体/达人/灰太太|'), c.split('## 🔗 关联')[1])
    check('产品也连上（长名优先，不会被「霞飞」吃掉）', c.includes('30_实体/产品/霞飞双层高光粉|'))
    check('建卡器报出回扫补的提及数', st.scanLinks > 0, String(st.scanLinks))
    // 回扫只补"提及"，不该让一个蹭到的字符串够格建卡
    check('回扫不参与建卡阈值：只在正文出现过的名字不成卡',
      (await readCard(root, 'talent', '只出现一次的人')) === null)
  }

  console.log('\n【5】增量：重复入库不重建')
  const st2 = await buildEntityCards(root, LIB)
  check('第二轮全部 unchanged', st2.created === 0 && st2.updated === 0 && st2.unchanged === st.entities,
    JSON.stringify({ created: st2.created, updated: st2.updated, unchanged: st2.unchanged, entities: st.entities }))
  check('第二轮不重复追加双链', (await fs.readFile(join(root, LIB, '年框.md'), 'utf-8')).split('## 🔗 关联').length === 2)

  console.log('\n【6】冲突：用户手工改过的卡不许被覆盖')
  const cardPath = join(root, '30_实体/达人', '灰太太.md')
  const edited = (await fs.readFile(cardPath, 'utf-8')).replace('## 相关文档', '## 相关文档（我手动改过这里）')
  await fs.writeFile(cardPath, edited, 'utf-8')
  await note(root, '新增一篇提到灰太太.md', { talent: ['灰太太'] })
  const st3 = await buildEntityCards(root, LIB)
  const after = await fs.readFile(cardPath, 'utf-8')
  check('冲突计数报出来了（不许静默）', st3.conflicted === 1, JSON.stringify({ conflicted: st3.conflicted }))
  check('用户那句话还在', after.includes('我手动改过这里'))
  check('新内容进「待合并」而不是覆盖', after.includes('待合并'))
  check('待合并段不重复堆叠', (await (async () => {
    await buildEntityCards(root, LIB)
    return fs.readFile(cardPath, 'utf-8')
  })()).split('待合并').length === 2)

  await fs.rm(root, { recursive: true, force: true })
  console.log(failed ? `\n❌ ${failed} 条不通过\n` : '\n✅ 全部通过\n')
  process.exit(failed ? 1 : 0)
}

void main()

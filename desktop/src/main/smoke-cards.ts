import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import fg from 'fast-glob'
import { buildEntityCards, canon, prefixSame, stripNote } from './vault/entity-cards'
import { hasSensitiveMark } from './lib/sensitive'

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

  console.log('\n【6b】升级库的旧卡：同名实体已有卡 → 跳过新建、在旧卡上补关联段（不自动合并）')
  {
    const up = join(tmpdir(), `mcnai-smoke-cards-up-${process.pid}`)
    await fs.rm(up, { recursive: true, force: true })
    await fs.mkdir(join(up, '.mcnai'), { recursive: true })
    await fs.writeFile(
      join(up, '.mcnai', 'layout.json'),
      JSON.stringify({ library: LIB, entities: { talent: '30_实体/达人', product: '30_实体/产品', partner: '30_实体/合作方' } })
    )
    // 老 pipeline 写的实体页：在**资料库外面**的分区里，只有 doc_type、没有 entity_kind
    const oldCard = join(up, '20_公司管理/合作方/霞飞.md')
    await fs.mkdir(join(oldCard, '..'), { recursive: true })
    await fs.writeFile(oldCard, ['---', 'doc_type: 合作方', 'tags: ["合作方"]', '---', '', '# 霞飞', '', '这段是用户/旧 pipeline 写的正文，一个字都不许动。'].join('\n'), 'utf-8')
    // 提到霞飞的文档（合作方阈值 ≥1，一篇就够建卡）
    await note(up, '年框.md', { partner: ['霞飞'], contract: true })

    const s1 = await buildEntityCards(up, LIB)
    const newCardPath = join(up, '30_实体/合作方/霞飞.md')
    const newCardExists = await fs.readFile(newCardPath, 'utf-8').then(() => true).catch(() => false)
    const patched = await fs.readFile(oldCard, 'utf-8')
    check('没有在标准目录另建一张同名卡', !newCardExists)
    check('统计里报了「复用已有卡」（不许静默）', s1.reused === 1, JSON.stringify({ reused: s1.reused, created: s1.created }))
    check('旧卡被补上了关联段', patched.includes('## 相关文档') && patched.includes('年框'))
    check('**不自动合并**：旧卡原正文原样保留', patched.includes('这段是用户/旧 pipeline 写的正文，一个字都不许动。'))
    // 身份字段是**新增**的：图谱的 kindOf() 只认 entity_kind，不补的话升级库里
    // 这些实体会掉回灰色 doc（2026-08-19 实测：走查库达人 169 → 34）
    check('已有 frontmatter 字段一个不动', /^---\ndoc_type: 合作方\ntags: \["合作方"\]\n/.test(patched))
    check('补上了 entity_kind / entity_name（图谱角色靠它）',
      /^entity_kind: partner$/m.test(patched) && /^entity_name: 霞飞$/m.test(patched))
    check('身份字段不重复补第二遍', (patched.match(/^entity_kind:/gm) ?? []).length === 1)
    check('文档侧双链指向旧卡、不是幽灵路径',
      (await fs.readFile(join(up, LIB, '年框.md'), 'utf-8')).includes('[[20_公司管理/合作方/霞飞|'))

    // 幂等：再跑一轮什么都不该动
    const s2 = await buildEntityCards(up, LIB)
    check('第二轮 unchanged（老卡路径也幂等）', s2.reused === 1 && s2.updated === 0 && s2.unchanged === 1,
      JSON.stringify({ reused: s2.reused, updated: s2.updated, unchanged: s2.unchanged }))
    check('第二轮没把关联段堆成两份', (await fs.readFile(oldCard, 'utf-8')).split('## 相关文档').length === 2)

    // 用户改了老卡的自动区 → 保用户版，新内容进「待合并」
    const edited = (await fs.readFile(oldCard, 'utf-8')).replace('## 相关文档', '## 相关文档（我手动改过）')
    await fs.writeFile(oldCard, edited, 'utf-8')
    await note(up, '又一篇年框.md', { partner: ['霞飞'], contract: true })
    const s3 = await buildEntityCards(up, LIB)
    const after = await fs.readFile(oldCard, 'utf-8')
    check('老卡上的手工修改不被覆盖', after.includes('我手动改过'), JSON.stringify({ conflicted: s3.conflicted }))
    check('新内容进「待合并」', after.includes('待合并'))
    await fs.rm(up, { recursive: true, force: true })
  }

  console.log('\n【7】A-8 上云闸门：敏感判据不许被 frontmatter 长度绕过')
  // 2026-08-18 发布前自测抓到的真洞：旧判据只看前 800 字符，而 A-3 之后
  // `entities_talent` 这类长数组会把最后写的 `sensitive: true` 顶出窗口，
  // 于是达人信息表/收支利润表/年框合作这几篇最该拦的反而判成非敏感、照常上云。
  // 走查库的 frontmatter 最长才 313 字符，够不着这个窗口 —— 所以只能在这里守。
  const longFm = (chars: number): string =>
    ['---', 'doc_type: 数据表', `entities_talent: ["${'达'.repeat(chars)}"]`, 'rule_tagged: true', 'sensitive: true', '---', '正文'].join('\n')
  check('短 frontmatter：敏感认得出', hasSensitiveMark(longFm(10)))
  check('长 frontmatter（>800，实测形态）：敏感照样认得出', hasSensitiveMark(longFm(2000)))
  check('极长 frontmatter（>1.5 万）也不许漏', hasSensitiveMark(longFm(15_000)))
  check('非敏感不误伤', !hasSensitiveMark('---\ndoc_type: 数据表\nsensitive: false\n---\n正文'))
  check('无 frontmatter 不误伤', !hasSensitiveMark('# 标题\nsensitive: true\n'))
  check('正文里的同名行不算（只认 frontmatter 块内）', !hasSensitiveMark('---\na: 1\n---\n\nsensitive: true\n'))
  check('frontmatter 不闭合 → 解析不了就当敏感', hasSensitiveMark('---\na: 1\nsensitive: true\n没有闭合'))

  await fs.rm(root, { recursive: true, force: true })

  /**
   * 【8】**真实升级库**上的旧卡探测（合成用例证明不了这条）。
   *
   * 跑法：先备一份真库的 md 骨架、把 `30_实体/` 删掉（= A-3 建卡器还没跑过的形态），
   * 再 `SMOKE_UPGRADE_VAULT=<path> SMOKE_UPGRADE_LIB=<库目录名> npm run smoke:cards`。
   * 不给这个变量就跳过——它依赖本机有一份真库，不该成为常规 smoke 的硬前置。
   */
  const upVault = process.env.SMOKE_UPGRADE_VAULT
  if (upVault) {
    console.log('\n【8】真实升级库：旧卡在，建卡器不许再造第二张')
    const upLib = process.env.SMOKE_UPGRADE_LIB || '80_Library'
    const st = await buildEntityCards(upVault, upLib)
    const found = await fg('**/霞飞.md', { cwd: upVault, ignore: ['**/node_modules/**'], dot: false })
    check(`霞飞只剩一张卡（实得 ${found.length}：${found.join(' | ')}）`, found.length === 1)
    check('留下的是那张旧卡（在标准目录之外）', found[0]?.startsWith('20_') === true, found.join(' | '))
    check('统计里报了复用', st.reused > 0, JSON.stringify({ reused: st.reused, created: st.created }))
    const card = found[0] ? await fs.readFile(join(upVault, found[0]), 'utf-8') : ''
    check('旧卡原有的「相关合作文件」段没被抹掉', card.includes('## 相关合作文件'))
    check('旧卡被补上了自动区', card.includes('mcnai:auto:start'))
    console.log(`   参考：本轮 复用 ${st.reused} / 新建 ${st.created} / 更新 ${st.updated} / 未变 ${st.unchanged}`)
  } else {
    console.log('\n【8】真实升级库：未给 SMOKE_UPGRADE_VAULT，跳过')
  }

  console.log(failed ? `\n❌ ${failed} 条不通过\n` : '\n✅ 全部通过\n')
  process.exit(failed ? 1 : 0)
}

void main()

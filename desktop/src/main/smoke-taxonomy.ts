/**
 * 库配置读取的**契约测试**（`npm run smoke:taxonomy`）。
 *
 * 两件事：
 *
 * 【A】TS 侧的兜底逻辑对不对（纯逻辑，零依赖）
 * 【B】**TS 与 Python 两份实现给出的结果逐字相同**
 *
 * 【B】才是重点。desktop 与 pipeline 各有一份配置解析器（运行时不共享代码），
 * A-3 那次翻车就是两边各写一套实体路径、悄悄漂开，双链从 352 掉到 2。
 * 所以这里把同一批 fixture 分别喂给两边，比对紧凑排序 JSON——**一个字不一样就红**。
 *
 * Python 侧位置：`$PKB_PIPELINE/taxonomy.py`，默认 `~/Documents/AI/pkb-pipeline`。
 * 找不到时【B】跳过并**大声说明**（不是静默通过——那正是这套测试要防的事）。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { spawnSync } from 'child_process'
import { resolveConfig, resolveEntityScanDirs, MCN_PRESET, hasFeature, type VaultConfig } from './vault/taxonomy'
import { createVault } from './vault/wizard'

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++
  console.log(`   ${ok ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`)
}

/** 递归按键排序 → 与 Python 的 `sort_keys=True` 对齐，才能逐字比 */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]))
  }
  return v
}
const dump = (v: unknown): string => JSON.stringify(canon(v))

/** 每个 fixture：一份 layout.json 原文 + 可选的磁盘形态（老库目录） */
interface Fixture {
  name: string
  raw: unknown
  /** 要在临时库里真建出来的目录（老库探测靠它） */
  dirs?: string[]
  expect?: (c: VaultConfig) => void
}

const FIXTURES: Fixture[] = [
  {
    name: '空配置 + 空库 → 全出厂值',
    raw: {},
    expect: (c) => {
      check('投递箱', c.inbox === '00_投递箱', c.inbox)
      check('资料库', c.library === '80_资料库', c.library)
      check('角色设定', c.persona.role === MCN_PRESET.persona.role)
      check('顶层分类 3 个', c.categories.top.length === 3, String(c.categories.top.length))
      check('bizdata 开关跟着 MCN persona 开着', hasFeature(c, 'bizdata'))
    },
  },
  {
    name: '空配置 + 磁盘上有 95_待入库 → 认老库投递箱',
    raw: {},
    dirs: ['95_待入库'],
    expect: (c) => check('投递箱 = 95_待入库', c.inbox === '95_待入库', c.inbox),
  },
  {
    name: '空配置 + 磁盘上有 80_Library → 认老库资料库',
    raw: {},
    dirs: ['80_Library'],
    expect: (c) => check('资料库 = 80_Library', c.library === '80_Library', c.library),
  },
  {
    /**
     * **这条是本批唯一一处刻意的行为变更，单独立断言。**
     *
     * 改造前 `orchestrator` 把老库探测写在 catch 里：layout.json 读得到、
     * 但里面没有 `inbox` 字段时，它落 `00_投递箱`；而 pipeline 的 `cli.py`
     * 会先探测 `95_待入库`。同一个库两边认的投递箱不是同一个——
     * 文件投进去没人处理，或者 watcher 盯着一个空目录。
     * 统一按 cli.py 的顺序（配置 → 探测 → 出厂），这条断言守住它不被改回去。
     */
    name: '有配置但缺 inbox 字段 + 磁盘有 95_待入库 → 仍认老库（修掉两边不一致）',
    raw: { library: '80_Library' },
    dirs: ['95_待入库', '80_Library'],
    expect: (c) => {
      check('投递箱 = 95_待入库（不是 00_投递箱）', c.inbox === '95_待入库', c.inbox)
      check('资料库按配置走', c.library === '80_Library', c.library)
    },
  },
  {
    name: '真实老库形态（0 号用户的 layout.json）→ 缺的段落逐字段落回出厂值',
    raw: {
      inbox: '00_投递箱',
      library: '80_资料库',
      artifacts: '90_产物',
      talents: '20_公司管理/25_达人档案',
      scripts: '40_带货/41_脚本库',
      concepts: '30_课程/31_方法论',
      entities: { talent: '30_实体/达人', product: '30_实体/产品', partner: '30_实体/合作方' },
    },
    expect: (c) => {
      check('没有 persona 段也拿到 MCN 角色', c.persona.role === MCN_PRESET.persona.role)
      check('没有 categories 段也拿到三分类', c.categories.top.length === 3)
      check('version 落出厂值', c.version === MCN_PRESET.version, String(c.version))
    },
  },
  {
    name: '实体只配了一半 → 逐字段兜底，不是整段丢掉',
    raw: { entities: { talent: '客户/人物' } },
    expect: (c) => {
      check('配了的用配置', c.entities.talent === '客户/人物', c.entities.talent)
      check('没配的用出厂值', c.entities.product === '30_实体/产品', c.entities.product)
    },
  },
  {
    name: '通用模板（去 MCN 化后的形态）',
    raw: {
      persona: { id: 'general', role: '这家公司的资料管理员', features: [] },
      categories: {
        top: [
          { name: '管理', desc: '经营、目标、复盘、制度' },
          { name: '业务', desc: '具体业务的执行与产出' },
        ],
        subExamples: ['财务人事', '团队培训'],
      },
    },
    expect: (c) => {
      check('角色换成中性口吻', c.persona.role === '这家公司的资料管理员', c.persona.role)
      check('bizdata 入口关掉', !hasFeature(c, 'bizdata'))
      check('分类换成客户自己的两类', dump(c.categories.top.map((x) => x.name)) === dump(['管理', '业务']))
      check('目录仍落出厂值（本批不动目录）', c.library === '80_资料库', c.library)
    },
  },
  {
    name: '脏数据：类型全错 → 一律落出厂值，不许抛',
    raw: { inbox: 123, library: null, entities: [], persona: 'mcn', categories: 7, scope: '乱写', version: 'x' },
    expect: (c) => {
      check('inbox 落出厂值', c.inbox === '00_投递箱', c.inbox)
      check('entities 落出厂值', c.entities.talent === '30_实体/达人', c.entities.talent)
      check('persona 落出厂值', c.persona.id === 'mcn', c.persona.id)
      check('scope 非法值 → vault', c.scope === 'vault', c.scope)
    },
  },
  {
    name: '分类里有没名字的条目 → 丢掉那条，其余保留',
    raw: { categories: { top: [{ name: '管理', desc: 'a' }, { desc: '没名字' }, { name: '', desc: '空名字' }] } },
    expect: (c) => check('只剩 1 条', c.categories.top.length === 1 && c.categories.top[0].name === '管理',
      dump(c.categories.top)),
  },
  {
    name: '分类整段都没名字 → 落回出厂三分类（不许变成空数组）',
    raw: { categories: { top: [{ desc: 'x' }], subExamples: [] } },
    expect: (c) => {
      check('顶层分类 3 个', c.categories.top.length === 3, String(c.categories.top.length))
      check('二级示例非空', c.categories.subExamples.length > 0)
    },
  },
  {
    name: '团队版预留位：scope=org 原样保留',
    raw: { scope: 'org' },
    expect: (c) => check('scope = org', c.scope === 'org', c.scope),
  },
  { name: '空目录名（全空格）→ 当没配', raw: { inbox: '   ', library: '' } },
  { name: 'null 配置', raw: null },
]

async function main(): Promise<void> {
  const root = join(tmpdir(), `mcnai-taxonomy-${process.pid}`)

  console.log('\n【A】TS 侧兜底逻辑')
  const resolved: Array<{ name: string; cfg: VaultConfig; dir: string | null }> = []
  for (const f of FIXTURES) {
    const dir = f.dirs?.length ? join(root, f.name.replace(/[^\w一-龥]/g, '_')) : null
    if (dir) for (const d of f.dirs!) await fs.mkdir(join(dir, d), { recursive: true })
    const cfg = resolveConfig(f.raw, dir)
    resolved.push({ name: f.name, cfg, dir })
    if (f.expect) {
      console.log(`  · ${f.name}`)
      f.expect(cfg)
    }
  }

  /**
   * 【A2】建库只建**目录字段**。
   *
   * 加 `persona` / `categories` 之前，`layoutDirs` 是"递归收集所有字符串叶子"——
   * 配置里只有目录时它对，加了业务字段的那一刻就会 mkdir 出「mcn」
   * 「美妆带货MCN公司的资料管理员」「bizdata」「个人生活类」一堆垃圾目录。
   * 这条断言把"结构靠约定不靠形状"钉住。
   */
  console.log('\n【A2】建库只建目录，不把 persona/分类名当目录')
  {
    const v = join(root, 'wizard')
    await createVault(v)
    const got = (await fs.readdir(v, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    const want = ['.mcnai', '00_投递箱', '20_公司管理', '30_实体', '30_课程', '40_带货', '80_资料库', '90_产物']
    check('顶层目录与预期一致', dump(got) === dump(want), dump(got))
    for (const bad of ['mcn', 'bizdata', '个人生活类', MCN_PRESET.persona.role, 'vault']) {
      check(`没有把「${bad}」建成目录`, !got.includes(bad))
    }
    const written = JSON.parse(await fs.readFile(join(v, '.mcnai', 'layout.json'), 'utf-8'))
    check('写进库的配置能被自己读回来（往返一致）', dump(resolveConfig(written, v)) === dump(MCN_PRESET))
  }

  /**
   * 【A3】**扫描**用的实体目录（`07_sensitive_enrich` 建链靠它）。
   *
   * 这一路的兜底值**故意不是** `30_实体/*` 而是老库路径——读与写要的不一样。
   * 实测 Maggie 库：老目录 177 篇实体、`30_实体/` 只有 59 篇（A-3 之后新建的）。
   * 扫描端改用 `30_实体/*` 兜底就少认 177 篇 → 双链重演 A-3（当年从 352 掉到 2）。
   * 这几条断言就是钉住"别好心把两套值统一了"。
   */
  console.log('\n【A3】扫描用实体目录：读认老库、写落中性区')
  {
    const noCfg = resolveEntityScanDirs({})
    check('没配置 → 达人落老库路径', noCfg.talent === '20_公司管理/25_达人档案', noCfg.talent)
    check('没配置 → 产品落老库路径', noCfg.product === '40_带货/产品', noCfg.product)
    check('课程只在扫描侧存在', noCfg.program === '30_课程/课程计划', noCfg.program)
    check('扫描兜底 ≠ 写入兜底（别统一）',
      noCfg.talent !== MCN_PRESET.entities.talent, `${noCfg.talent} vs ${MCN_PRESET.entities.talent}`)
    const partial = resolveEntityScanDirs({ entities: { talent: '客户/人物' } })
    check('配了的用配置', partial.talent === '客户/人物', partial.talent)
    check('没配的逐键落老库（不是整段丢）', partial.product === '40_带货/产品', partial.product)
    const jerry = resolveEntityScanDirs({ entities: MCN_PRESET.entities })
    check('配全三类的库：课程仍落老库路径', jerry.program === '30_课程/课程计划', jerry.program)
    check('配全三类的库：达人走配置', jerry.talent === '30_实体/达人', jerry.talent)
  }

  /**
   * 【A4】**打标提示词的黄金母本**（0.2.0 批 2）。
   *
   * `03_tag_llm.py` 的 SYSTEM_PROMPT 原来是一整段写死的文本——开头「你是美妆带货MCN
   * 公司的资料管理员」、写死的三选一分类枚举、末尾写死的公司名「OMG美妆」。
   * 第二个客户（管理咨询）的库里，每篇笔记的摘要都由一位"美妆带货MCN资料管理员"写出来。
   *
   * 改成从配置生成之后，**唯一能证明"老库打标口径没漂"的办法就是逐字节比对**：
   * `e2e/golden/tag-prompt-mcn.txt` 是从 pkb-pipeline 改造前的源码里原样抠出来的 968 字节。
   * 这条红了不是测试坏了，是那条线被碰了。
   *
   * 跨仓库：黄金母本存在 mcn-ai，生成方在 pkb-pipeline。两边任何一侧动了模板都会被逮到。
   */
  const pipe = process.env.PKB_PIPELINE || join(homedir(), 'Documents/AI/pkb-pipeline')
  const py = join(pipe, 'taxonomy.py')
  let hasPy = false
  try {
    await fs.access(py)
    hasPy = true
  } catch {
    /* 下面大声说明 */
  }

  console.log('\n【A4】打标提示词：MCN 配置生成的结果 = 改造前原文')
  if (hasPy) {
    const goldenPath = join(process.cwd(), 'e2e', 'golden', 'tag-prompt-mcn.txt')
    let golden = ''
    try {
      golden = await fs.readFile(goldenPath, 'utf-8')
    } catch {
      /* 下面报 */
    }
    if (!golden) {
      failed++
      console.log(`   ❌ 找不到黄金母本 ${goldenPath}`)
    } else {
      await fs.mkdir(root, { recursive: true })
      const fx = join(root, 'preset.json')
      // 空配置 → MCN 预设；这正是老库（没有 persona 段）的形态
      await fs.writeFile(fx, '{}', 'utf-8')
      const r = spawnSync('python3', [py, '--prompt', fx], { encoding: 'utf-8' })
      const built = r.stdout ?? ''
      check(`长度 ${built.length} = 母本 ${golden.length}`, built.length === golden.length)
      if (built !== golden) {
        const a = golden.split('\n')
        const b = built.split('\n')
        const i = a.findIndex((l, n) => l !== b[n])
        check('逐字节相同', false, `\n        第 ${i + 1} 行\n        母本=${a[i]}\n        生成=${b[i]}`)
      } else {
        check('逐字节相同', true)
      }
      // 换成通用 persona：MCN 那几处字眼必须全部消失
      await fs.writeFile(fx, JSON.stringify({
        persona: { id: 'general', role: '这家公司的资料管理员', features: [] },
        categories: { top: [{ name: '管理', desc: '经营、目标、复盘' }, { name: '业务', desc: '执行与产出' }], subExamples: ['财务人事'] },
      }), 'utf-8')
      const g = spawnSync('python3', [py, '--prompt', fx], { encoding: 'utf-8' }).stdout ?? ''
      check('通用模板：不再自称美妆带货MCN', !g.includes('美妆带货MCN'), g.split('\n')[0].slice(0, 30))
      check('通用模板：不再出现 OMG美妆', !g.includes('OMG美妆'))
      check('通用模板：分类换成客户自己的', g.includes('"管理|业务 二选一"'),
        g.split('\n').find((l) => l.includes('category')))
      check('通用模板：带上分类释义', g.includes('分类含义：管理=经营、目标、复盘；业务=执行与产出'))
    }
  } else {
    failed++
    console.log('   ❌ 没有 Python 侧，黄金母本比对跳过（见下）')
  }

  console.log('\n【B】TS ↔ Python 逐字比对')
  if (!hasPy) {
    failed++
    console.log(`   ❌ 找不到 ${py}`)
    console.log('      这条**不是可选项**：两份实现漂开正是 A-3 翻车的原因。')
    console.log('      给 PKB_PIPELINE=<pkb-pipeline 路径> 再跑。')
  } else {
    await fs.mkdir(root, { recursive: true })
    for (const { name, cfg, dir } of resolved) {
      const fx = join(root, 'fx.json')
      await fs.writeFile(fx, JSON.stringify(FIXTURES.find((f) => f.name === name)!.raw ?? null), 'utf-8')
      const r = spawnSync('python3', [py, '--resolve', fx, dir ?? ''], { encoding: 'utf-8' })
      const out = (r.stdout ?? '').trim()
      if (r.status !== 0 || !out) {
        check(name, false, `python 侧失败：${(r.stderr ?? '').trim().split('\n').pop()}`)
        continue
      }
      const same = out === dump(cfg)
      check(name, same, same ? '' : `\n        ts =${dump(cfg)}\n        py =${out}`)

      // 扫描目录是**另一条解析路径**，两边一样会漂——同一批 fixture 也过一遍
      const rs = spawnSync('python3', [py, '--scan-dirs', fx], { encoding: 'utf-8' })
      const sOut = (rs.stdout ?? '').trim()
      const sTs = dump(resolveEntityScanDirs(FIXTURES.find((f) => f.name === name)!.raw))
      if (rs.status !== 0 || !sOut) {
        check(`${name} · 扫描目录`, false, `python 侧失败：${(rs.stderr ?? '').trim().split('\n').pop()}`)
      } else {
        check(`${name} · 扫描目录`, sOut === sTs, sOut === sTs ? '' : `\n        ts =${sTs}\n        py =${sOut}`)
      }
    }
  }

  await fs.rm(root, { recursive: true, force: true })
  console.log(failed ? `\n❌ ${failed} 条不通过\n` : '\n✅ 全部通过\n')
  process.exit(failed ? 1 : 0)
}

void main()

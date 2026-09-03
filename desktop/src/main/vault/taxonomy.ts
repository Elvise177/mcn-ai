import { promises as fs, existsSync } from 'fs'
import { join } from 'path'

/**
 * 库配置的**唯一读取入口**（`vault/.mcnai/layout.json`）。
 *
 * ## 为什么要有它
 *
 * 2026-08-21 排查「第二个客户的库长着一张 MCN 的脸」时发现：同一份 layout.json，
 * desktop 里有 **4 处**各自 `JSON.parse` + 各自兜底（投递箱名 ×2、分流、实体目录），
 * pipeline 里还有第 5 处。四套默认值互相不知道对方存在，已经漂出两个真 bug：
 *
 * · `routes.ensureRouteFolders` **根本不读 layout**，直接 `95_待入库 ?? 00_投递箱`——
 *   库里把投递箱改了名，分流子文件夹就建到一个没人看的目录里去。
 * · orchestrator 只在 **catch 分支**里探测 `95_待入库`；layout.json 存在但缺 `inbox`
 *   字段时它落到 `00_投递箱`，而 pipeline 的 `cli.py` 会探测老库名。同一个库，
 *   两边认的投递箱不是同一个。
 *
 * 这正是 A-3 那次的形状（`07_sensitive_enrich` 与 layout 各写一套实体路径 →
 * 双链从 352 掉到 2）。**所以：读配置只许走这里，兜底逻辑只许写一遍。**
 *
 * ## 与 pipeline 的关系
 *
 * `pkb-pipeline/taxonomy.py` 是这个文件的**逐条镜像**。两边必须给出相同的解析结果，
 * 靠 `npm run smoke:taxonomy` 的跨语言契约测试守住——它拿同一批 fixture 分别喂给
 * TS 与 Python，逐字段比对。改这里**必须**同时改 py，否则那条 smoke 会红。
 */

export type EntityKind = 'talent' | 'product' | 'partner'

/** 一个顶层分类：名字 + 语义描述（进 prompt，模型靠它判断） + 示例文件名 */
export interface Category {
  name: string
  desc: string
  examples?: string[]
}

/**
 * 库的业务身份。**打标提示词的角色设定从这里生成**，不再写死
 * 「你是美妆带货MCN公司的资料管理员」——那句话会污染每一篇笔记的摘要口吻。
 *
 * `features` 是跟着 persona 走的功能开关（拍板：别写死成第二个 MCN 假设）。
 * 目前只有 `bizdata`（抖音经营数据）——通用模板下整个入口隐藏，
 * 因为对管理咨询客户，侧栏里一个空的「抖音经营数据」比一个空目录更突兀。
 */
export interface Persona {
  /** 模板 id：`mcn` | `general` | `custom` */
  id: string
  /** 角色设定，直接进 SYSTEM_PROMPT，如「美妆带货MCN公司的资料管理员」 */
  role: string
  /**
   * 用户自己公司的名字。打标提示词里有一句「合作方…不要把公司自己（OMG美妆）写进去」——
   * 那个括号里的名字原来是**写死的**，第二个客户的库里凭空冒出一家美妆 MCN。
   * 没配就退化成不带括号的「不要把公司自己写进去」。
   */
  company?: string
  /**
   * **对话**的身份句（PLAN-v2 R1），进 `agent/system-prompt.ts` 的第一行
   * 「你是 SamePage——{prompt}」。MCN 预设 = 「MCN 公司与带货达人的 AI 工作台」。
   * 与 `role`（打标提示词的角色）分开：一个是"资料管理员"的口吻，一个是"工作台"的自述，
   * 两句话面向的对象不同，硬合成一个字段两边都别扭。没配时按 `id` 取预设默认句。
   */
  prompt?: string
  /** 该 persona 下启用的业务功能开关 */
  features: string[]
}

export interface Taxonomy {
  /** 顶层分类候选集（平铺投递的文件由模型在这几个里选） */
  top: Category[]
  /** 二级分类的示例（模型可自拟，这些只是给它找感觉） */
  subExamples: string[]
}

export interface VaultConfig {
  /** 配置格式版本。加字段不涨，改语义才涨 */
  version: number
  /**
   * 配置的归属。**团队版的预留位**（拍板 2g）：
   * `vault` = 这一份库自己的配置；`org` = 随主库下发、全公司统一、仅管理员可改。
   * 本版只读不写 `org`，真正的下发链路在团队版做——**格式先留好，免得到时候动数据**。
   */
  scope: 'vault' | 'org'
  inbox: string
  library: string
  artifacts: string
  talents: string
  scripts: string
  concepts: string
  /**
   * 投递箱内置分流「参考资料 →」的落位目录。
   * 名字本身不带 MCN 味，但**它在 pipeline 和 desktop 各写死了一份**，
   * 改一处漏一处就是分流落到两个地方（同 A-3 的形状）。
   */
  externalRefs: string
  entities: Record<EntityKind, string>
  persona: Persona
  categories: Taxonomy
}

/**
 * 出厂预设 = **现行 MCN 版**，逐字段等于改造前写死的那些值。
 * 批 1 的硬要求是「老库行为一个字都不许漂」，所以这里的每一个值都必须
 * 与它替换掉的那个常量完全相同。
 */
export const MCN_PRESET: VaultConfig = {
  version: 2,
  scope: 'vault',
  inbox: '00_投递箱',
  library: '80_资料库',
  artifacts: '90_产物',
  talents: '20_公司管理/25_达人档案',
  scripts: '40_带货/41_脚本库',
  concepts: '30_课程/31_方法论',
  externalRefs: '70_外部资料',
  /**
   * 实体卡落位（A-3）。**中性的 `30_实体/`**，不复用 0 号用户那套
   * （`20_公司管理/25_达人档案` 是她自己的语义，对别的客户不成立）。
   */
  entities: {
    talent: '30_实体/达人',
    product: '30_实体/产品',
    partner: '30_实体/合作方',
  },
  persona: {
    id: 'mcn',
    role: '美妆带货MCN公司的资料管理员',
    company: 'OMG美妆',
    // 对话身份句，逐字等于改造前 `agent/index.ts` 写死的那半句（老库对话口径不漂）
    prompt: 'MCN 公司与带货达人的 AI 工作台',
    features: ['bizdata'],
  },
  /**
   * 三个名字与 `03_tag_llm.py` 原来写死的枚举逐字相同。
   *
   * **`desc` 在 MCN 预设里刻意留空**：原提示词里就没有分类释义，
   * 补上一段等于改提示词、等于打标口径可能漂——而这一批的验收线是
   * 「老库口径一个字不许变」。`desc` 是给**自定义分类**用的
   * （客户拿它向模型解释「管理」「业务」各指什么），MCN 预设不需要。
   * 由 `smoke:taxonomy` 的黄金母本断言守着：MCN 配置生成的提示词
   * 必须与改造前的原文**逐字节相同**。
   */
  categories: {
    top: [{ name: '个人生活类', desc: '' }, { name: '工作-管理类', desc: '' }, { name: '工作-执行类', desc: '' }],
    subExamples: ['业务-内容经纪', '课程教学', '达人管理', '财务人事', '脚本创作'],
  },
}

/**
 * **通用模板**——给不是 MCN 的客户（0.2.0 批 3）。
 *
 * 与 MCN 预设的差别只在"业务身份"那几项：角色设定中性、没有公司名、
 * 关掉 `bizdata`、分类换成任何行业都成立的三类。**目录字段保持一致**——
 * 目录名是不是「80_资料库」跟行业无关，客户想改自己去配（`library` 是可配字段）。
 *
 * 分类的 `desc` 这里**是写满的**，与 MCN 预设相反：MCN 那套要跟改造前的提示词
 * 逐字节一致所以留空，通用这套是新写的，本来就该把每一类是什么说清楚——
 * 平铺投递的文件全靠它判断。
 */
export const GENERAL_PRESET: VaultConfig = {
  ...MCN_PRESET,
  persona: {
    id: 'general',
    role: '这家公司的资料管理员',
    features: [],
  },
  categories: {
    top: [
      { name: '管理', desc: '公司经营、目标、复盘、制度、人事财务' },
      { name: '业务', desc: '具体业务的执行与产出' },
      { name: '个人', desc: '与公司业务无关的个人事务' },
    ],
    subExamples: ['财务人事', '团队培训', '客户项目', '内部制度'],
  },
}

/** 建库模板。`custom` 不是第三份预设——它是"先拿通用起步，建完自己去改配置" */
export const PRESETS = { general: GENERAL_PRESET, mcn: MCN_PRESET, custom: GENERAL_PRESET } as const
export type PresetId = keyof typeof PRESETS

/** 老库探测：这两个目录名是 0 号用户库的历史形态，全仓库只在这里判一次 */
const LEGACY_INBOX = '95_待入库'
const LEGACY_LIBRARY = '80_Library'

/**
 * 实体卡的**扫描**种类。比 `entities`（写入种类）多一个 `program`——
 * 课程只被 `07_sensitive_enrich` 读来建链，没有建卡器往里写，所以它只出现在扫描侧。
 */
export type ScanKind = EntityKind | 'program'

/**
 * 老库里实体卡实际所在的目录。
 *
 * **这套值和 `MCN_PRESET.entities` 是故意不同的，别去"统一"它们**——
 * 读与写要的东西不一样：
 *
 * · **写**（`entities`，建卡器用）→ 中性的 `30_实体/`。老库那套
 *   `20_公司管理/25_达人档案` 是 0 号用户自己的语义，对别的客户不成立。
 * · **读**（这里，扫描器用）→ 必须认老库目录。实测 Maggie 库：
 *   `20_公司管理/25_达人档案` 158 篇、`40_带货/产品` 13 篇、`30_课程/课程计划` 4 篇、
 *   `20_公司管理/合作方` 2 篇，而 `30_实体/` 只有 A-3 之后新建的 59 篇。
 *   扫描端要是改用 `30_实体/*` 兜底，老库一下子少认 177 篇实体
 *   → **双链当场重演 A-3**（当年就是从 352 掉到 2）。
 *
 * 有 layout.json 配了 entities 的库（Jerry 那种）走配置，这套值用不上。
 */
export const LEGACY_ENTITY_DIRS: Record<ScanKind, string> = {
  talent: '20_公司管理/25_达人档案',
  product: '40_带货/产品',
  partner: '20_公司管理/合作方',
  program: '30_课程/课程计划',
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback
}

function categories(v: unknown): Taxonomy {
  const raw = (v ?? {}) as { top?: unknown; subExamples?: unknown }
  const top = Array.isArray(raw.top)
    ? raw.top
        .map((c) => {
          const o = (c ?? {}) as { name?: unknown; desc?: unknown; examples?: unknown }
          return {
            name: str(o.name, ''),
            desc: str(o.desc, ''),
            ...(Array.isArray(o.examples) ? { examples: o.examples.filter((x) => typeof x === 'string') } : {}),
          }
        })
        // 没名字的条目直接丢——它进了 prompt 只会让模型输出空 category
        .filter((c) => c.name)
    : []
  const subExamples = Array.isArray(raw.subExamples)
    ? raw.subExamples.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : []
  return {
    top: top.length ? top : MCN_PRESET.categories.top,
    subExamples: subExamples.length ? subExamples : MCN_PRESET.categories.subExamples,
  }
}

function persona(v: unknown): Persona {
  /**
   * **persona 缺整段时整段回落**，不逐字段兜底——这一条与其它字段不同，理由：
   *
   * 老库（0 号用户）的 layout.json 里根本没有 persona 段。要是逐字段兜底，
   * `company` 就会取不到值（它没有出厂兜底，见下），于是老库的提示词从
   * 「不要把公司自己（OMG美妆）写进去」变成「不要把公司自己写进去」——
   * **老库口径当场就漂了**，而这一批的验收线正是"一个字不许变"。
   *
   * 反过来，persona 段**存在**就说明这个库明确表达过身份（批 3 的模板会写全），
   * 那时 `company` 没给就是真没有，不许兜底成「OMG美妆」——
   * 否则别家客户的提示词里会凭空出现一家美妆 MCN。
   */
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...MCN_PRESET.persona }
  const o = v as { id?: unknown; role?: unknown; company?: unknown; prompt?: unknown; features?: unknown }
  const company = typeof o.company === 'string' && o.company.trim() ? o.company : undefined
  // prompt 与 company 同一套规矩：persona 段存在就不兜底，没给就是没给（默认句由 id 决定，见 system-prompt.ts）
  const prompt = typeof o.prompt === 'string' && o.prompt.trim() ? o.prompt : undefined
  return {
    id: str(o.id, MCN_PRESET.persona.id),
    role: str(o.role, MCN_PRESET.persona.role),
    ...(company ? { company } : {}),
    ...(prompt ? { prompt } : {}),
    features: Array.isArray(o.features)
      ? o.features.filter((x): x is string => typeof x === 'string')
      : MCN_PRESET.persona.features,
  }
}

/**
 * 把一份**已读到的** layout.json 解析成完整配置。
 *
 * `root` 只用于老库探测（`95_待入库` / `80_Library` 在不在磁盘上）；
 * 传 null 就跳过探测，直接用出厂值——纯逻辑测试走这条路，不碰文件系统。
 *
 * 逐字段兜底，**不是整份兜底**：老库的 layout.json 里只有 inbox/library 几个键，
 * 缺的那些必须落到出厂值，而不是因为"这份配置不完整"就整个丢掉。
 */
export function resolveConfig(raw: unknown, root: string | null): VaultConfig {
  const o = (raw ?? {}) as Record<string, unknown>
  const has = (p: string): boolean => !!root && existsSync(join(root, p))
  const ent = (o.entities ?? {}) as Partial<Record<EntityKind, string>>
  return {
    version: typeof o.version === 'number' ? o.version : MCN_PRESET.version,
    scope: o.scope === 'org' ? 'org' : 'vault',
    /**
     * 投递箱与资料库的三段式：**配置 → 老库探测 → 出厂值**。
     *
     * 探测放在"配置没给"之后（而不是只在读文件失败时才做）——这是与改造前
     * `orchestrator` 的一处**刻意不同**：它把探测写在 catch 里，于是
     * 「layout.json 存在但没有 inbox 字段」的老库会被判成 `00_投递箱`，
     * 而 pipeline 判成 `95_待入库`，两边认的投递箱不是同一个。
     * 这里统一按 `cli.py` 的顺序来（它是对的），并由 smoke 断言守住。
     */
    inbox: str(o.inbox, has(LEGACY_INBOX) ? LEGACY_INBOX : MCN_PRESET.inbox),
    library: str(o.library, has(LEGACY_LIBRARY) ? LEGACY_LIBRARY : MCN_PRESET.library),
    artifacts: str(o.artifacts, MCN_PRESET.artifacts),
    talents: str(o.talents, MCN_PRESET.talents),
    scripts: str(o.scripts, MCN_PRESET.scripts),
    concepts: str(o.concepts, MCN_PRESET.concepts),
    externalRefs: str(o.externalRefs, MCN_PRESET.externalRefs),
    entities: {
      talent: str(ent.talent, MCN_PRESET.entities.talent),
      product: str(ent.product, MCN_PRESET.entities.product),
      partner: str(ent.partner, MCN_PRESET.entities.partner),
    },
    persona: persona(o.persona),
    categories: categories(o.categories),
  }
}

/**
 * **扫描**用的实体目录（`07_sensitive_enrich` 建链靠它）：
 * layout.json 配了哪个键就用哪个，没配的落**老库路径**（不是 `30_实体/*`，理由见
 * `LEGACY_ENTITY_DIRS`）。逐键兜底——只配了一个键的库，另外三个也得能工作。
 */
export function resolveEntityScanDirs(raw: unknown): Record<ScanKind, string> {
  const ent = ((raw ?? {}) as { entities?: Partial<Record<ScanKind, string>> }).entities ?? {}
  return Object.fromEntries(
    (Object.keys(LEGACY_ENTITY_DIRS) as ScanKind[]).map((k) => [k, str(ent[k], LEGACY_ENTITY_DIRS[k])])
  ) as Record<ScanKind, string>
}

/** 读一份库的原始 layout.json。读不到/坏了都回空对象——由 resolveConfig 逐字段兜底 */
export async function readRawLayout(root: string): Promise<Record<string, unknown>> {
  try {
    const t = await fs.readFile(join(root, '.mcnai', 'layout.json'), 'utf-8')
    const v = JSON.parse(t)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 库配置：**全仓库唯一入口**。任何地方要知道"投递箱叫什么/实体卡放哪"都走这里 */
export async function readVaultConfig(root: string): Promise<VaultConfig> {
  return resolveConfig(await readRawLayout(root), root)
}

/** 该 persona 下这个业务功能开不开（如 `bizdata`） */
export function hasFeature(cfg: VaultConfig, name: string): boolean {
  return cfg.persona.features.includes(name)
}

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
    features: ['bizdata'],
  },
  categories: {
    // 三个名字与 `03_tag_llm.py` 原来写死的枚举逐字相同
    top: [
      { name: '个人生活类', desc: '与公司业务无关的个人事务' },
      { name: '工作-管理类', desc: '公司经营、目标、复盘、制度、人事财务' },
      { name: '工作-执行类', desc: '具体业务的执行与产出' },
    ],
    subExamples: ['业务-内容经纪', '课程教学', '达人管理', '财务人事', '脚本创作'],
  },
}

/** 老库探测：这两个目录名是 0 号用户库的历史形态，全仓库只在这里判一次 */
const LEGACY_INBOX = '95_待入库'
const LEGACY_LIBRARY = '80_Library'

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
  const o = (v ?? {}) as { id?: unknown; role?: unknown; features?: unknown }
  return {
    id: str(o.id, MCN_PRESET.persona.id),
    role: str(o.role, MCN_PRESET.persona.role),
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
    entities: {
      talent: str(ent.talent, MCN_PRESET.entities.talent),
      product: str(ent.product, MCN_PRESET.entities.product),
      partner: str(ent.partner, MCN_PRESET.entities.partner),
    },
    persona: persona(o.persona),
    categories: categories(o.categories),
  }
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

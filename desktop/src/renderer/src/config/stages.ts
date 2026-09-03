/**
 * 投递箱阶段名的**用户词**（U3 #6 / PRODUCT-AUDIT 附录 B）——全应用唯一一份。
 *
 * ## 病症
 *
 * 界面上原来摆的是我们自己的阶段代号：`转换 / PII守卫 / 智能打标 / 规则打标 /
 * 实体建链 / 索引重建 / 实体建卡 / 归档 / 上云`。用户往投递箱丢了几个文件，
 * 界面上依次闪过九个他没听过的词。「PII守卫」尤其糟——既像英文缩写又像出了安全问题；
 * 而 0.1.2 那次客户报障的原话正是「停在 **PII守卫 2/8** 十分钟没变」。
 *
 * ## 改法
 *
 * 不是"换个好听的名字"，是**按用户关心的粒度分组**：他要知道的只有
 * 「读取文件 → 检查 → 整理 → 建立关联 → 建立索引 → 收尾 → 同步云端」。
 * 几个相邻阶段合用一个词是**故意的**（`tag_llm`/`tag_rules` 都叫「整理中」），
 * 进度分母照旧按真实阶段数走，只是名字不再逐个报给用户。
 *
 * ## 为什么在这里
 *
 * 它原来有**两份**：`tasks/types.ts` 的 `INBOX_FLOW`（Dock 进度标签）与
 * `pages/VaultPage.tsx` 的 `STAGE_ZH`（投递箱面板）。两处各写各的，
 * 同一个阶段在 Dock 上叫「智能打标」、在面板里也叫「智能打标」纯属它们碰巧一致——
 * 改一处必漏另一处（0.1.2 的「支持列表散在四处」是同一个病）。现在只有这一份，
 * 主进程与渲染层都从这儿取（`config/steps.ts` 已经是同样的用法）。
 *
 * **阶段代号一个都没改**：日志、失败清单、`.checkpoint.jsonl` 照旧用 `stage` 的英文 id，
 * 这里只管"摆给用户看的那个词"。
 */

/** 主流程阶段的顺序（进度分母 = 它的长度）。改顺序要同步 pipeline 的实际执行次序 */
export const INBOX_STAGES = [
  'convert',
  'pii_guard',
  'tag_llm',
  // 敏感文件走这一步：零模型的规则打标，补上 AI 打标跳过的那批的 frontmatter（A-2）。
  // 必须排在实体建链之前——07 没有 frontmatter 就写不进结构摘要
  'tag_rules',
  'sensitive_enrich',
  'gen_moc',
  // 实体建卡（A-3）：**跑在 pipeline 之后的主进程里**，不是 pipeline 阶段
  // （拍板理由：冻结体积与 spec 漏项风险，且增量卡片该由持库者管理）。
  // 它在 flow 里排在上云之前——新卡也要上云，而敏感卡要在上云前被拦下
  'build_cards',
  'cloud_sync',
] as const

export type InboxStage = (typeof INBOX_STAGES)[number]

/** 阶段代号 → 用户词。包含主流程之外的几个（面板里也会显示） */
export const STAGE_LABEL: Record<string, string> = {
  init: '准备中',
  spawn: '准备中',
  enqueue: '收取文件',
  convert: '读取文件',
  pii_guard: '检查中',
  tag_llm: '整理中',
  tag_rules: '整理中',
  convert_failures: '读取结果',
  sensitive_enrich: '建立关联',
  gen_moc: '建立索引',
  build_cards: '建立关联',
  archive: '收尾',
  cloud_sync: '同步云端',
  done: '完成',
}

/** 查不到就原样回代号——**宁可露一次代号，也不许显示空白**（空白等于"这一步不存在"） */
export const stageLabel = (stage: string): string => STAGE_LABEL[stage] ?? stage

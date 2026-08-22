/**
 * 首页快捷指令（chips）配置。
 * 单独成文件是为将来的「任务模板系统」留位置：以后一条 chip = 一个任务模板
 * （可带提示词/所需输入/产物类型），现在先只用 label + prompt 两个字段。
 */
export interface Chip {
  /** 稳定标识，将来对应任务模板 id */
  id: string
  /** 按钮文案 */
  label: string
  /** 点击后填进输入框的起始文本 */
  prompt: string
  /**
   * 只在某个模板下出现。不填 = 所有库都显示。
   *
   * 2026-08-21：做批 3 的"干净新库"截图时才发现这一处——顶层目录、打标口吻、
   * 功能开关全去 MCN 化了，首页却还挂着「写种草脚本」「达人复盘」。
   * 管理咨询客户开软件第一眼看到的就是这两个词，跟 `40_带货` 目录一样突兀。
   * **界面上每一处直接对用户说话的地方都要过一遍这个筛子**，不只是目录和提示词。
   */
  personas?: string[]
}

const ALL: Chip[] = [
  { id: 'seeding-script', label: '写种草脚本', prompt: '写种草脚本：', personas: ['mcn'] },
  { id: 'creator-review', label: '达人复盘', prompt: '达人复盘：', personas: ['mcn'] },
  { id: 'course-ppt', label: '做课件 PPT', prompt: '做课件 PPT：' },
  { id: 'weekly-report', label: '生成周报', prompt: '生成周报：' },
  { id: 'meeting-notes', label: '整理会议纪要', prompt: '整理会议纪要：', personas: ['general', 'custom'] },
  { id: 'search-vault', label: '检索我的库', prompt: '检索我的库：' },
]

/** 该 persona 下该显示哪些 chip；拿不到 persona（还没开库）时按通用给 */
export function chipsFor(personaId: string | null | undefined): Chip[] {
  const id = personaId || 'general'
  return ALL.filter((c) => !c.personas || c.personas.includes(id))
}

/** 兼容旧引用；新代码一律用 `chipsFor(persona)` */
export const CHIPS = ALL

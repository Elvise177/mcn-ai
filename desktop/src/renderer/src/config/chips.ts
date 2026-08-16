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
}

export const CHIPS: Chip[] = [
  { id: 'seeding-script', label: '写种草脚本', prompt: '写种草脚本：' },
  { id: 'course-ppt', label: '做课件 PPT', prompt: '做课件 PPT：' },
  { id: 'weekly-report', label: '生成周报', prompt: '生成周报：' },
  { id: 'creator-review', label: '达人复盘', prompt: '达人复盘：' },
  { id: 'search-vault', label: '检索我的库', prompt: '检索我的库：' },
]

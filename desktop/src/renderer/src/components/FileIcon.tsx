import { File, FileSpreadsheet, FileText, FileType, Presentation } from 'lucide-react'

/**
 * 文件类型图标：ppt/docx/xlsx/pdf 各自一个图标 + 一个颜色 token，
 * 让产物卡片扫一眼就知道是什么东西（颜色值全在 styles/theme.css）。
 */
export type FileKind = 'ppt' | 'doc' | 'xls' | 'pdf' | 'md' | 'other'

const EXT_KIND: Record<string, FileKind> = {
  pptx: 'ppt', ppt: 'ppt', key: 'ppt',
  docx: 'doc', doc: 'doc', rtf: 'doc',
  xlsx: 'xls', xls: 'xls', csv: 'xls',
  pdf: 'pdf',
  md: 'md', markdown: 'md', txt: 'md',
}

// 静态映射：Tailwind 只扫描源码里出现过的完整类名，不能拼字符串
const KIND_CLASS: Record<FileKind, string> = {
  ppt: 'text-file-ppt',
  doc: 'text-file-doc',
  xls: 'text-file-xls',
  pdf: 'text-file-pdf',
  md: 'text-file-md',
  other: 'text-file-other',
}

const KIND_ICON = {
  ppt: Presentation,
  doc: FileText,
  xls: FileSpreadsheet,
  pdf: FileType,
  md: FileText,
  other: File,
}

export function fileKind(name: string): FileKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return EXT_KIND[ext] ?? 'other'
}

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const kind = fileKind(name)
  const Icon = KIND_ICON[kind]
  return <Icon size={size} className={`shrink-0 ${KIND_CLASS[kind]}`} />
}

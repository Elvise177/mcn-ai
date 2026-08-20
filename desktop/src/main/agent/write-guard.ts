import { join, resolve, sep } from 'path'

/**
 * AI 写入知识库的权限判定（2026-08-19，B4）。
 *
 * ## 为什么改
 *
 * 原来的规则是「`Write`/`Edit` 只放行 `90_产物/`，其余一律拒」。用户让 AI 改一篇自己的笔记，
 * AI 回一句「环境限制文件写入」——**对客户来说这就是产品残疾**。
 * 「防止 AI 乱改知识库」是对的，但正确实现是**可以改、但要用户点头、看得见、能撤销**，
 * 不是一刀切。
 *
 * ## 三层
 *
 * 1. **硬禁区**（本文件）：内部文件永远拒，**连确认卡都不弹**。用户点不到 = 不可能被诱导点同意
 * 2. **确认卡**（`agent/index.ts` 的 canUseTool → IPC → 渲染层）：库内其它路径要用户点允许，60 秒不理默认拒
 * 3. **可撤销**（`agent/backup.ts`）：放行的写入先备份原文，toast 给「撤销」
 *
 * ## 硬禁区为什么是这几条
 *
 * 都是**产品自己的内部状态**，被改坏的后果用户看不懂也修不回来：
 * - `.mcnai/`：库的布局配置（`layout.json`），改坏了投递箱落位全乱
 * - `.checkpoint.jsonl`：打标断点。删/改会导致整库重打标（烧钱），或该重打的不重打（漏字段）
 * - `00_投递箱/.done/`、`.failed/`：投递箱的处理标记，改了会重复入库或漏件
 * - 任何 `.` 开头的文件/目录：同上，一律当内部状态
 * - **库外**：绝对不许——这是沙箱边界，不是策略
 */

/** 库内这些位置永不放行，连确认卡都不弹 */
const FORBIDDEN_SEGMENTS = ['.mcnai', '.done', '.failed', '.git', '.obsidian', 'node_modules']
const FORBIDDEN_FILES = ['.checkpoint.jsonl', '.concepts_ckpt.jsonl']

export type WriteVerdict =
  | { kind: 'allow-artifact' } // 产物目录：一直就放行的，不打扰用户
  | { kind: 'ask'; rel: string } // 库内其它位置：要用户点头
  | { kind: 'deny'; reason: string } // 硬禁区 / 库外

/**
 * @param filePath  工具给的路径（可能是绝对路径，也可能是相对库根的）
 * @param vaultRoot 当前库根；没开库时传 null
 * @param artifactsDir 产物目录绝对路径
 */
export function judgeWrite(
  filePath: string,
  vaultRoot: string | null,
  artifactsDir: string
): WriteVerdict {
  const p = String(filePath ?? '').trim()
  if (!p) return { kind: 'deny', reason: '没有给文件路径' }

  // 产物目录：老规矩不变（AI 做 PPT/Word 本来就往这儿写，每次都问会烦死人）
  const abs = p.startsWith(sep) ? resolve(p) : resolve(vaultRoot ?? '', p)
  if (abs === resolve(artifactsDir) || abs.startsWith(resolve(artifactsDir) + sep)) {
    return { kind: 'allow-artifact' }
  }
  if (p.startsWith('90_产物')) return { kind: 'allow-artifact' }

  if (!vaultRoot) return { kind: 'deny', reason: '还没有打开知识库' }

  // 库外一律拒。**这是沙箱边界**：用 resolve 之后再比前缀，`../` 那类穿越自然就被挡住了
  const root = resolve(vaultRoot)
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { kind: 'deny', reason: '只能改知识库里的文件' }
  }

  const rel = abs.slice(root.length + 1)
  const segments = rel.split(sep)
  // 任何 `.` 开头的段：内部状态，一律硬拒（`.mcnai/` `.done/` `.checkpoint.jsonl` 都在此列）
  if (segments.some((s) => s.startsWith('.'))) {
    return { kind: 'deny', reason: '这是知识库的内部文件，不能修改' }
  }
  if (segments.some((s) => FORBIDDEN_SEGMENTS.includes(s))) {
    return { kind: 'deny', reason: '这是知识库的内部目录，不能修改' }
  }
  if (FORBIDDEN_FILES.includes(segments[segments.length - 1])) {
    return { kind: 'deny', reason: '这是知识库的内部文件，不能修改' }
  }

  return { kind: 'ask', rel }
}

/** 走查/冒烟要拿这张表做断言，所以导出 */
export const FORBIDDEN = { segments: FORBIDDEN_SEGMENTS, files: FORBIDDEN_FILES }

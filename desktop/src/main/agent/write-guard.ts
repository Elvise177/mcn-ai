import { basename, relative, resolve, sep } from 'path'

/**
 * AI 写入知识库的权限判定（2026-08-19，B4；2026-09-02 PLAN-v2 R6 + N5 改）。
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
 * 1. **硬禁区**（本文件 `isPathWritable`）：内部文件永远拒，**连确认卡都不弹**。用户点不到 = 不可能被诱导点同意
 * 2. **确认卡**（`agent/index.ts` 的 canUseTool → IPC → 渲染层）：库内其它路径要用户点允许，60 秒不理默认拒
 * 3. **可撤销**（`agent/write-backup.ts`）：放行的写入先备份原文，toast 给「撤销」
 *
 * ## 硬禁区的三段判定（N5，借 Codex 沙箱策略的形状）
 *
 * ① **静态可写根**：必须落在库根之内（resolve 之后比前缀，`../` 穿越自然被挡）——这是沙箱边界，不是策略
 * ② **受保护前缀**：`.mcnai/`（布局配置，改坏了投递箱落位全乱）、`.git/`、`.obsidian/`、
 *    `node_modules/`、投递箱的 `.done/` `.failed/`（处理标记，改了会重复入库或漏件）——以及任何 `.` 开头的段
 * ③ **受保护文件**：`.checkpoint.jsonl`（打标断点：删/改会导致整库重打标烧钱，或该重打的不重打）等
 *
 * ## 产物目录（R6）
 *
 * 一直就放行、不打扰用户（AI 做 PPT/Word 本来就往这儿写）。**目录名吃 `layout.json` 的 `artifacts`**：
 * 以前这里写死了 `90_产物`，库里把产物目录改了名，AI 写出来的文件就落到旧名目录、产物面板盯着新名目录一片空白。
 */

/** 库内这些目录段永不放行，连确认卡都不弹 */
const PROTECTED_SEGMENTS = ['.mcnai', '.done', '.failed', '.git', '.obsidian', 'node_modules']
/** 这些文件名永不放行（在任何目录下） */
const PROTECTED_FILES = ['.checkpoint.jsonl', '.concepts_ckpt.jsonl']

export type WritableVerdict = { ok: true; rel: string } | { ok: false; reason: string }

/**
 * 三段判定：在可写根内 → 不在受保护前缀 → 不是受保护文件。
 *
 * @param root 库根（绝对路径）
 * @param p    要写的路径：绝对路径或相对库根的相对路径
 */
export function isPathWritable(root: string, p: string): WritableVerdict {
  const r = resolve(root)
  const abs = p.startsWith(sep) ? resolve(p) : resolve(r, p)
  // ① 静态可写根
  if (abs !== r && !abs.startsWith(r + sep)) return { ok: false, reason: '只能改知识库里的文件' }
  const rel = abs === r ? '' : abs.slice(r.length + 1)
  if (!rel) return { ok: false, reason: '不能把知识库根目录当文件写' }
  const segments = rel.split(sep)
  // ② 受保护前缀：任何 `.` 开头的段 = 内部状态，一律硬拒；显式名单另守一遍（node_modules 不带点）
  if (segments.some((s) => s.startsWith('.'))) return { ok: false, reason: '这是知识库的内部文件，不能修改' }
  if (segments.some((s) => PROTECTED_SEGMENTS.includes(s))) return { ok: false, reason: '这是知识库的内部目录，不能修改' }
  // ③ 受保护文件
  if (PROTECTED_FILES.includes(basename(rel))) return { ok: false, reason: '这是知识库的内部文件，不能修改' }
  return { ok: true, rel }
}

export type WriteVerdict =
  | { kind: 'allow-artifact' } // 产物目录：一直就放行的，不打扰用户
  | { kind: 'ask'; rel: string } // 库内其它位置：要用户点头
  | { kind: 'deny'; reason: string } // 硬禁区 / 库外

/**
 * @param filePath  工具给的路径（可能是绝对路径，也可能是相对库根的）
 * @param vaultRoot 当前库根；没开库时传 null
 * @param artifactsDir 产物目录绝对路径（= 库根 + layout.json 的 `artifacts`）
 */
export function judgeWrite(
  filePath: string,
  vaultRoot: string | null,
  artifactsDir: string
): WriteVerdict {
  const p = String(filePath ?? '').trim()
  if (!p) return { kind: 'deny', reason: '没有给文件路径' }

  // 产物目录：老规矩不变（AI 做 PPT/Word 本来就往这儿写，每次都问会烦死人）
  const art = resolve(artifactsDir)
  const abs = p.startsWith(sep) ? resolve(p) : resolve(vaultRoot ?? '', p)
  if (abs === art || abs.startsWith(art + sep)) {
    return { kind: 'allow-artifact' }
  }
  // 相对路径形态：`<产物目录名>/...`。目录名从 artifactsDir 算，不再写死 `90_产物`（R6）
  if (vaultRoot) {
    const artRel = relative(resolve(vaultRoot), art)
    if (artRel && !artRel.startsWith('..') && (p === artRel || p.startsWith(artRel + sep) || p.startsWith(artRel + '/'))) {
      return { kind: 'allow-artifact' }
    }
  }

  if (!vaultRoot) return { kind: 'deny', reason: '还没有打开知识库' }

  const v = isPathWritable(vaultRoot, p)
  if (!v.ok) return { kind: 'deny', reason: v.reason }
  return { kind: 'ask', rel: v.rel }
}

/** 走查/冒烟要拿这张表做断言，所以导出 */
export const FORBIDDEN = { segments: PROTECTED_SEGMENTS, files: PROTECTED_FILES }
export const PROTECTED = FORBIDDEN

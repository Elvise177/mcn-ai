/**
 * 拖入结果 → 用户看得懂的一句话（A-1，2026-08-18）。
 *
 * 抽出来是因为**有两个拖入口**（工作台、知识库页），文案分两处写必然漂移——
 * 而这条文案的全部意义就是「让用户知道到底进来了几个、为什么有的没进来」。
 * 修复前知识库页那条路径是完全静默的：整包拖进去，界面一点反应都没有。
 */

/** 提示语 + toast 类型。一个都没进来时用 error 色——那是个需要用户改做法的结果，不是普通回执 */
/**
 * 拖入结果 → 一条提示。
 * **「未发现可入库的文件」归琥珀（warn）不归红（error）**：用户没做错什么、系统也没坏，
 * 只是这一拖没有可处理的东西——报红会让人以为出故障了（品牌二期语义色裁决，
 * 见 docs/DESIGN-color-semantics.md）。真正的失败（enqueue 抛错）仍然是红。
 */
export function enqueueMessage(r: EnqueueResult): { text: string; type: 'ok' | 'warn' } {
  const notes: string[] = []
  if (r.skippedUnsupported > 0) notes.push(`已跳过 ${r.skippedUnsupported} 个不支持的格式`)
  // 隐藏文件/空文件只在「它是唯一原因」时才提——平时提了只是噪音
  if (r.skippedJunk > 0 && (r.added === 0 ? r.skippedUnsupported === 0 : false))
    notes.push(`已跳过 ${r.skippedJunk} 个隐藏或空文件`)
  if (r.truncated) notes.push('单次最多 500 个，剩下的请分批拖入')
  if (r.depthExceeded > 0) notes.push(`有 ${r.depthExceeded} 个目录层级过深未收入`)

  const tail = notes.length ? `（${notes.join('；')}）` : ''
  return r.added > 0
    ? { text: `已送入投递箱 ${r.added} 个文件${tail}，可在「个人知识库」看处理进度`, type: 'ok' }
    : { text: `未发现可入库的文件${tail}`, type: 'warn' }
}

/** 支持的格式，给空态提示用（真相源见 `main/inbox/orchestrator.ts` 的 `SUPPORTED_EXT`） */
export const SUPPORTED_HINT = 'md / txt / docx / pdf / xlsx / pptx'

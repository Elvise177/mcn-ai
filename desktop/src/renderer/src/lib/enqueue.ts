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

// （原来这里有一份 `SUPPORTED_HINT` 抄件，没人引用且已落后于真值——支持列表只从 `settings.supportedExt` 读，R7）

/**
 * 拖放来的 `File` → 磁盘路径。**两个拖入口共用这一个，别各写各的。**
 *
 * `window.api.files.pathFor` 内部是 `webUtils.getPathForFile`（在 preload 里调，
 * 渲染层拿不到 electron 模块）。**这是生产环境唯一有效的那条**——
 * `File.path` 在 Electron 32 被移除，2026-08-19 从 30.5.1 升到 43.4.1 跨过这个断点，
 * 所有拖放入库当场全废且**静默**，客户报的就是"拖进去没有任何反应"。
 *
 * 后面那条 `f.path` **只为走查存在**：合成 DragEvent 里的 File 不是真拖进来的，
 * `getPathForFile` 拿不到路径，走查靠 `Object.defineProperty(f,'path',…)` 造一个。
 * 而那个自定义属性**过不了 contextBridge 边界**（跨界时被丢掉），所以这条回退
 * 必须留在**渲染层**、不能放进 preload——第一版就是放错了地方，H-01 当场红。
 *
 * **它在真机上是死代码**（`'path' in new File([''],'x')` === false，实测），
 * 所以不会掩盖真实故障。真正的护栏是调用方那句「取不到路径就弹错」。
 */
export function pathOfDropped(f: File): string {
  return window.api.files.pathFor(f) || (f as File & { path?: string }).path || ''
}

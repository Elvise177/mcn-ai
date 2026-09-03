/**
 * 能入库 / 能当对话附件的扩展名——**desktop 侧唯一的一份**（PLAN-v2 R7，2026-09-02）。
 *
 * 此前这张表散在 6 处：TS 两份（`inbox/orchestrator.ts` 的 SUPPORTED_EXT、
 * `agent/attachments.ts` 的 DOC_EXT）+ pipeline 四处。0.1.2 加 `.doc` 时就踩过一次：
 * 走查那份抄件没跟上，报成「整包拖入没有全部入队」，方向完全指错。
 *
 * 真相源仍是 pipeline 的 `02_convert.py`（`CONVERTERS` 键集 + `.md`/`.txt` 直接拷）：
 * 这里是它在 desktop 侧的**唯一**副本，由 `smoke:taxonomy`【A6】跨语言契约测试守着——
 * `taxonomy.py --supported-ext` 打出 py 侧的集合，与这里逐字比，差一个就红。
 *
 * 顺序有意义：渲染层的空态提示与 pipeline 的「能支持的格式」文案都按这个顺序列。
 */
export const SUPPORTED_EXT_LIST = ['.md', '.txt', '.doc', '.docx', '.pdf', '.xlsx', '.pptx'] as const

export const SUPPORTED_EXT: ReadonlySet<string> = new Set<string>(SUPPORTED_EXT_LIST)

/** 不带点的形态（`dialog.showOpenDialog` 的 filters 要这种） */
export const SUPPORTED_EXT_BARE: string[] = SUPPORTED_EXT_LIST.map((e) => e.slice(1))

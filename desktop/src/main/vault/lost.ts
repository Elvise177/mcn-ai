/**
 * 「知识库目录还在不在」的判据（PLAN-v2 批 5 R16）。
 *
 * ## 要接住的那个静默失效
 *
 * 库放在外接盘 / iCloud / 网络盘上，盘被拔了、目录被改名或移走——
 * chokidar 从此再也不报事件，而应用**一点反应都没有**：文件树还画着内存里那份旧快照、
 * 检索还在旧索引上命中、点开笔记才报「找不到文件」。用户以为库好好的，
 * 实际每一次写入都在往一个不存在的路径上写。
 *
 * 这是 Condition 不是 Task：它没有终态，只有"当前是什么样"（同「云端离线」）。
 *
 * ## 判据抽出来的理由
 *
 * 真造这个状态要在跑的时候拔盘 / `chmod 000` / 把目录 mv 走，还得让 chokidar
 * 真的冒出那个事件——属于"很难在走查里稳定复现"的一类，所以判据留在纯函数里，
 * `smoke:guards` 喂合成信号验完；接线（真的挂上了、真的顶了那条）交给走查。
 *
 * ## 一条刻意的取舍：**光有 error 事件不算丢**
 *
 * chokidar 的 `error` 大多数时候是**单个文件**的瞬时问题（正在被写、被别的程序锁着）。
 * 见 error 就把整条「知识库目录不可访问」顶上去，会让一次无关紧要的抖动
 * 变成一条吓人的横幅——比不报还坏。所以一律**以磁盘探测为准**：
 * 目录还在、还读得动，就只记日志不改状态。
 */

/** watcher 那边冒出来的信号 */
export type WatcherSignal =
  | { kind: 'error'; message: string }
  /** 目录被删。`rel` 为空串 = 库根自己 */
  | { kind: 'unlinkDir'; rel: string }

/** 对库根做的一次磁盘探测（调用方现场取，别缓存——缓存的探测结果没有意义） */
export interface RootProbe {
  exists: boolean
  /** 能不能读（`fs.access(root, R_OK)`）。目录还在但权限没了也是"不可访问" */
  readable: boolean
}

export interface LostVerdict {
  lost: boolean
  /** 顶条的副标题。**要说清是哪一种**——"被移走"和"没权限"的下一步动作完全不同 */
  reason?: string
}

export function judgeVaultLost(sig: WatcherSignal, probe: RootProbe): LostVerdict {
  if (!probe.exists) {
    return { lost: true, reason: '目录不在了，可能被移动、改名，或者它所在的磁盘/网盘断开了' }
  }
  if (!probe.readable) {
    // 顶条会把它接在「知识库目录不可访问：」后面，所以这句自己别再用冒号起头（两个冒号连着读着别扭）
    return { lost: true, reason: '多半是权限没了，或者网盘没挂上（目录还在，但打不开）' }
  }
  /**
   * 探测说"好好的"，那就不是丢了。
   *
   * `unlinkDir ''` 也走这里：目录被删又立刻重建（有些同步盘就是这么干的）时，
   * 事件是真的，状态却已经恢复——照着事件报警就是一条假警报。
   * **事件只是"去看一眼"的触发器，结论一律以磁盘为准。**
   */
  return { lost: false }
}

/** 库恢复可访问之后要不要撤掉顶条：判据同上，只是入口不同（定时重探用） */
export function judgeVaultBack(probe: RootProbe): boolean {
  return probe.exists && probe.readable
}

/** 心跳间隔（毫秒）。30 秒够快，又不至于让一次 stat 变成常驻负载 */
export const DEFAULT_PROBE_MS = 30_000

/**
 * 心跳间隔，走查可以调快。
 *
 * **为什么光靠 watcher 事件不够**：macOS 上外接盘被拔掉时，fsevents 往往是
 * **直接不吭声**——既不报 error 也不报 unlinkDir。只等事件的话，那台机器上
 * 这条顶条永远不会出现，而这恰恰是最该被接住的场景。所以事件只当"提前触发"，
 * 真正兜底的是这个心跳。
 *
 * `MCNAI_E2E_VAULT_PROBE` 只给走查用（同 `MCNAI_E2E_AGENT_TIMEOUT` 的判据）：
 * 生产不读，真造一次"盘被拔掉"要在跑的时候拔线。垃圾值一律回出厂值。
 */
export function resolveProbeMs(e2e: string | undefined): number {
  const n = Number(e2e)
  return Number.isFinite(n) && n >= 100 ? n : DEFAULT_PROBE_MS
}

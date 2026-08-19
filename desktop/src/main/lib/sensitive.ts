/**
 * A-8 的敏感判据：一篇笔记的 frontmatter 里有没有 `sensitive: true`。
 *
 * 单独成模块是为了**能被零 token 的冒烟直接断言**（`smoke:cards`）——
 * 它原来长在 `inbox/orchestrator.ts` 的闭包里，那里跑不了纯逻辑断言，
 * 于是下面这个洞在产品里躺了一段时间没人发现。
 *
 * ## 必须把整块 frontmatter 都看完，不能只截前 N 个字符
 *
 * 2026-08-18 发布前自测查出的真洞。旧写法是 `readFile(...).slice(0, 800)` 再跑正则。
 * A-3 上线后 frontmatter 会带 `entities_talent` / `entities_product` /
 * `entities_partner` 这类长数组，而 `sensitive` 是 `03b`/`09` **最后**写的一行。
 * Maggie 全量实测：`【带货MCN】达人信息表.md` 的 frontmatter 有 1588 字符，
 * 光 `entities_talent` 就 ~1200 字符，`sensitive: true` 落在第 1569 字符
 * ——**被 800 的窗口整行切掉**，于是判成非敏感、照常上云。同批中招的还有
 * 「2026年收支利润表」「OMG美妆x向日花年框合作」「签约-2026年度目标管理总表」，
 * 全是 A-8 最该拦的那几篇。
 *
 * 走查库测不出来：它的 frontmatter 最长才 313 字符，够不着这个窗口。
 * 截断本来也没省到 I/O——`readFile` 已经把整份读进内存了，`slice` 只是少跑一段正则。
 *
 * ## 两条取向
 *
 * - **判定只在 frontmatter 块内做**：正文里出现同名行不算（代码块里写一行
 *   `sensitive: true` 不该让整篇笔记停在本地）
 * - **解析不了就当敏感**：开头是 `---` 却找不到闭合分隔符 = 这文件形状不对，
 *   不赌，按敏感处理。同 `orchestrator` 里"读不到就当敏感"的取向——
 *   宁可少传一篇，不可误传一篇
 */
export function hasSensitiveMark(text: string): boolean {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text // 去 BOM
  if (!/^---\r?\n/.test(body)) return false // 没有 frontmatter 就没有标记
  const end = /\r?\n---\s*(\r?\n|$)/.exec(body.slice(4))
  if (!end) return true // 开头像 frontmatter 却不闭合：解析不了，按敏感处理
  return /^sensitive:\s*true\s*$/m.test(body.slice(4, 4 + end.index))
}

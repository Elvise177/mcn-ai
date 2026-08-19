import { useEffect, useState } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'

/**
 * 用量页。数据来自主进程按月落的 jsonl（见 main/usage/index.ts），这里只做展示。
 *
 * 页面的重点不是"好看的图表"，而是**成本透明**：两档并排放在一起，用户一眼能看出
 * 增强档一次抵标准档多少次。所以档位对比区在页面上的分量高于任何一张图。
 */

/** 将来按量计费启用：配额进度条的组件位先留出来，接上服务端配额接口即可点亮 */
const QUOTA_ENABLED = false

function QuotaBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  return (
    <div data-testid="usage-quota" className="mb-6 max-w-3xl rounded-xl border border-line bg-card p-5">
      <div className="mb-2 flex items-center justify-between text-md">
        <span>本月配额</span>
        <span className="text-muted">
          {used} / {total}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const fmt = (n: number): string => n.toLocaleString('zh-CN')
const shortDay = (d: string): string => d.slice(5).replace('-', '/')

/**
 * 钱一律显示人民币。单价与汇率是运维配置（管理员区），页面上只出现算好的结果——
 * 让老板看美元单价再自己乘汇率，等于没做这件事。
 * 不足一分钱不写成 ¥0.00：那看着像"免费"，实际只是很便宜。
 */
const money = (cny: number): string => (cny > 0 && cny < 0.01 ? '¥<0.01' : `¥${cny.toFixed(2)}`)
/** 「约 ¥X.XX · N tokens」——人民币在前，tokens 退居佐证 */
const costTokens = (cny: number, tokens: number): string =>
  tokens > 0 ? `约 ${money(cny)} · ${fmt(tokens)} tokens` : '—'

export default function UsagePage({ onBack }: { onBack: () => void }) {
  // 金额默认不给客户看：现在算的是**成本价**，摆出来等于把进货价摊开，
  // 而商业化定价还没定。计价能力完整保留（jsonl / usage-report 照常），
  // 管理员区可以打开（settings.showCost）
  const [showCost, setShowCost] = useState(false)
  const [data, setData] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  /** 柱状图上鼠标停在第几根柱子（仅悬停明细用，不影响任何数据口径） */
  const [hover, setHover] = useState<number | null>(null)

  /**
   * 每次刷新都把 `showCost` 一起重新读一遍。
   *
   * 这里漏过一次：`showCost` 只有 `useState(false)`，从来没读过设置——
   * 管理员区那个开关写进了配置，用量页却永远拿不到，金额被永久隐藏。
   * 类型检查抓不到（状态本来就是 boolean），走查断言才抓得到，所以两件事都放在 `load` 里。
   */
  const load = (): void => {
    setLoading(true)
    void window.api.settings.get().then((s) => setShowCost(!!s.showCost))
    void window.api.usage
      .summary()
      .then(setData)
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const maxDaily = Math.max(1, ...(data?.daily ?? []).map((d) => d.count))

  return (
    <div className="h-full overflow-auto p-10">
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={onBack}
          title="返回设置"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-muted hover:bg-hover hover:text-ink"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">用量</h2>
          <p className="text-md text-muted">{data?.month ?? ''} · 本机记录</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm text-muted hover:text-accent"
        >
          <RefreshCw size={12} /> 刷新
        </button>
      </div>

      {QUOTA_ENABLED && <QuotaBar used={data?.totalCount ?? 0} total={1000} />}

      {loading && !data ? (
        <div className="thinking-dots pt-6">
          <span />
          <span />
          <span />
        </div>
      ) : data?.empty ? (
        // 空态：别只写"暂无数据"——告诉用户什么动作会让这里有东西
        <div
          data-testid="usage-empty"
          className="max-w-3xl rounded-xl border border-line bg-card px-8 py-12 text-center"
        >
          <div className="text-lg font-medium">本月还没有用量记录</div>
          <div className="mt-2 text-md leading-6 text-muted">
            回到对话工作台问一个问题，或让 AI 做一份课件，这里就会开始统计。
            <br />
            记录只存在本机，不会上传。
          </div>
        </div>
      ) : (
        data && (
          <>
            {/* 顶部大数字：次数 / 产物 / 花费。花费是这一屏里唯一"老板真正想知道"的数 */}
            <div className="mb-6 grid max-w-3xl grid-cols-3 gap-4">
              <div data-testid="usage-chat-count" className="rounded-xl border border-line bg-card p-6">
                <div className="text-sm text-muted">本月对话</div>
                <div className="mt-1 text-3xl font-semibold">{fmt(data.chatCount)}</div>
                <div className="text-sm text-muted">次</div>
              </div>
              <div data-testid="usage-artifact-count" className="rounded-xl border border-line bg-card p-6">
                <div className="text-sm text-muted">本月产物</div>
                <div className="mt-1 text-3xl font-semibold">{fmt(data.artifactCount)}</div>
                <div className="text-sm text-muted">个（PPT / 文档）</div>
              </div>
              {showCost && (
              <div data-testid="usage-cost" className="rounded-xl border border-line bg-card p-6">
                <div className="text-sm text-muted">本月估算花费</div>
                <div className="mt-1 text-3xl font-semibold">约 {money(data.costCny)}</div>
                <div className="text-sm text-muted">估算值（成本价）</div>
              </div>
              )}
            </div>

            {/*
              最近 14 天柱状图：纯 CSS 柱条，不为一张小图引一整个图表库。
              **整张卡走深色仪表盘**（`.chart-dark` 就地改写 token，同 .sidebar-dark 的手法）：
              页面其余部分维持暖白纸面，深色只做**一个**视觉焦点——两块深色就没有焦点了。
            */}
            <div className="chart-dark mb-6 max-w-3xl rounded-xl bg-card p-6 text-ink">
              <div className="text-md font-medium">最近 14 天</div>
              {/* 提示放到底部图例那一行，不放标题右侧——悬停气泡是从柱子顶上弹出来的，
                  放在标题行会被它盖住（拍验收图时就撞上了） */}
              <div className="mb-4 mt-1 text-2xs text-muted">峰值 {maxDaily} 次/天</div>
              {/* 柱区与日期轴**分成两行**：柱子的百分比高度要有一个"确定高度"的父级才算得出来。
                  一开始把日期塞进同一列里，那一列在 `items-end` 的行里高度由内容决定（= 只有日期
                  那行字那么高），于是所有柱子都算成 0——页面上是一整片空白（走查截图抓到的） */}
              {/* 同柱堆叠：下段标准档（浅橙）、上段增强档（深橙）。
                  只画总次数的话，"20 次全标准"和"20 次里 5 次增强"长得一模一样，
                  而两者的钱差一个数量级——这张图的意义就在这个差别上 */}
              <div className="relative">
                {/* 网格线：只给柱高一个参照，暗灰细线，不该被看成内容 */}
                <div aria-hidden className="pointer-events-none absolute inset-0">
                  {[0, 0.25, 0.5, 0.75, 1].map((p) => (
                    <div key={p} className="absolute inset-x-0 border-t border-line" style={{ bottom: `${p * 100}%` }} />
                  ))}
                </div>
                {/* 悬停明细：日期 + 两档次数。**不用原生 title**——原生提示是系统样式，
                    在深色卡上是另一套观感，而且要等一秒才出，仪表盘上显得迟钝 */}
                {hover != null && data.daily[hover] && (
                  <div
                    data-testid="usage-bar-tooltip"
                    className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-surface px-2.5 py-1.5 text-2xs leading-4 text-ink shadow-pop"
                    /* 靠边的柱子要**把气泡夹回卡片里**：一律居中对齐的话，
                       悬停最左/最右那根时气泡会探出卡片外，看着像飞出去的浮层 */
                    style={{
                      left: `${((hover + 0.5) / data.daily.length) * 100}%`,
                      transform:
                        (hover + 0.5) / data.daily.length > 0.75
                          ? 'translateX(-100%)'
                          : (hover + 0.5) / data.daily.length < 0.25
                            ? 'translateX(0)'
                            : 'translateX(-50%)',
                      bottom: '100%',
                      marginBottom: 6,
                    }}
                  >
                    <div className="font-medium">{data.daily[hover].date}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-muted">
                      <span className="flex items-center gap-1">
                        <i className="inline-block h-2 w-2 rounded-sm bg-tier-standard" />
                        标准 {data.daily[hover].standard} 次
                      </span>
                      <span className="flex items-center gap-1">
                        <i className="inline-block h-2 w-2 rounded-sm bg-tier-enhanced" />
                        增强 {data.daily[hover].enhanced} 次
                      </span>
                    </div>
                  </div>
                )}
                <div data-testid="usage-daily" className="relative flex h-28 gap-1.5">
                  {data.daily.map((d, i) => {
                    const h = d.count > 0 ? Math.max(8, (d.count / maxDaily) * 100) : 4
                    const enhPct = d.count > 0 ? d.enhanced / d.count : 0
                    return (
                      <div
                        key={d.date}
                        className="flex min-w-0 flex-1 flex-col justify-end"
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover((v) => (v === i ? null : v))}
                      >
                        <div
                          data-count={d.count}
                          data-standard={d.standard}
                          data-enhanced={d.enhanced}
                          // 0 也留一点底座：整行空白会让人以为图没渲染出来
                          className={`flex w-full flex-col overflow-hidden rounded-sm transition-opacity ${
                            d.count > 0 ? '' : 'bg-surface'
                          } ${hover != null && hover !== i ? 'opacity-70' : ''}`}
                          style={{ height: `${h}%` }}
                        >
                          {d.enhanced > 0 && (
                            <div data-seg="enhanced" className="w-full bg-tier-enhanced" style={{ height: `${enhPct * 100}%` }} />
                          )}
                          {d.standard > 0 && <div data-seg="standard" className="w-full flex-1 bg-tier-standard" />}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                {data.daily.map((d) => (
                  <div key={d.date} className="min-w-0 flex-1 truncate text-center text-2xs text-muted-soft">
                    {shortDay(d.date)}
                  </div>
                ))}
              </div>
              {/* 两色图例：柱子分段了就必须说清哪段是什么，否则用户只会觉得"颜色深浅是随机的" */}
              <div data-testid="usage-daily-legend" className="mt-3 flex items-center gap-4 text-2xs text-muted">
                <span data-legend="standard" className="flex items-center gap-1.5">
                  <i className="inline-block h-2.5 w-2.5 rounded-sm bg-tier-standard" /> 标准模式
                </span>
                <span data-legend="enhanced" className="flex items-center gap-1.5">
                  <i className="inline-block h-2.5 w-2.5 rounded-sm bg-tier-enhanced" /> 增强模式
                </span>
                <span className="ml-auto">悬停看当天明细</span>
              </div>
            </div>

            {/* 按档位消耗对比：这一块是成本透明化的核心 */}
            <div className="mb-6 max-w-3xl rounded-xl border border-line bg-card p-6">
              <div className="mb-1 text-md font-medium">按模式对比</div>
              <div className="mb-4 text-sm leading-5 text-muted">
                同样一次提问，增强模式的消耗远高于标准模式；这里把两边的次数与 tokens 并排放，方便判断值不值。
              </div>
              <div data-testid="usage-by-tier" className="grid grid-cols-2 gap-4">
                {data.byTier.map((t) => (
                  <div key={t.tier} data-testid={`usage-tier-${t.tier}`} className="rounded-lg bg-bg p-4">
                    <div className="text-base font-medium">{t.label}</div>
                    {/* 次数 / tokens / 花费 三列并排：一眼就能比出"同样几次，钱差多少" */}
                    <div className={`mt-3 grid gap-2 ${showCost ? 'grid-cols-3' : 'grid-cols-2'}`}>
                      <div>
                        <div className="text-xl font-semibold">{fmt(t.count)}</div>
                        <div className="text-xs text-muted">次</div>
                      </div>
                      <div>
                        <div className="text-xl font-semibold">{t.total > 0 ? fmt(t.total) : '—'}</div>
                        <div className="text-xs text-muted">tokens</div>
                      </div>
                      {showCost && (
                        <div>
                          <div className="text-xl font-semibold">约 {money(t.costCny)}</div>
                          <div className="text-xs text-muted">估算花费</div>
                        </div>
                      )}
                    </div>
                    {/* 缓存读单列出来：它在总量里常占大头，但计价按线路折扣率单独算，
                        不说明的话「tokens 很多但花费不高」看着像算错了（B-2） */}
                    <div className="mt-3 border-t border-line pt-2 text-sm text-muted">
                      输入 {fmt(t.input)} · 缓存读 {fmt(t.cacheRead)} · 输出 {fmt(t.output)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 按任务类型细分 */}
            <div className="mb-6 max-w-3xl rounded-xl border border-line bg-card p-6">
              <div className="mb-4 text-md font-medium">按任务类型</div>
              <table data-testid="usage-by-type" className="w-full text-base">
                <thead>
                  <tr className="bg-table-head text-sm text-muted">
                    <th className="rounded-l-md px-3 py-2 text-left font-normal">类型</th>
                    <th className="px-3 py-2 text-right font-normal">次数</th>
                    <th className="px-3 py-2 text-right font-normal">{showCost ? '花费 · tokens' : 'tokens'}</th>
                    <th className="rounded-r-md px-3 py-2 text-right font-normal">耗时中位数</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byType.map((r) => (
                    <tr key={r.type} className="border-b border-line last:border-0">
                      <td className="px-3 py-2">{r.label}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.count)}</td>
                      <td className="px-3 py-2 text-right">
                        {showCost ? costTokens(r.costCny, r.tokens) : r.tokens > 0 ? `${fmt(r.tokens)} tokens` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">{r.medianMs > 0 ? `${(r.medianMs / 1000).toFixed(1)}s` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div data-testid="usage-token-note" className="mt-3 text-sm leading-5 text-muted">
                tokens 含输入、缓存读与输出；入库打标由后台程序调用，拿不到 token 数，只记次数（显示为「—」）。
              </div>
            </div>

            {/* 全页脚注：别让人拿这个数去对账 */}
            {showCost && (
              <div data-testid="usage-cost-note" className="mb-6 max-w-3xl text-sm leading-5 text-muted">
                费用为估算值（成本价，非客户报价），以实际账单为准。
                <span data-testid="usage-cache-note">
                  重复内容命中缓存后按折扣价计费（折扣按模型不同），所以 tokens 多不等于花费高。
                </span>
                单价按实际线路取——同一个模型走不同线路可能差好几倍。
                {/* 这条得写明白：拿不到 token 就没法计价，这笔钱确实不在上面那个数里面。
                    实测过一天：入库打标那条线的花费能盖过对话，只看上面的数会严重低估 */}
                <span data-testid="usage-scope-note" className="mt-1 block">
                  上面的花费<b>只含对话与做文档</b>；入库打标拿不到 token，没有计入——
                  批量入库当月，实际账单会明显高于这里的估算。
                </span>
                <span data-testid="usage-offpeak-note" className="mt-1 block">
                  DeepSeek 官方存在分时计价（同一模型不同时段单价实测差一倍），这里按固定单价估，两个方向都会有偏差。
                </span>
              </div>
            )}
          </>
        )
      )}
    </div>
  )
}

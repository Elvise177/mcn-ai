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
      <div className="h-2 overflow-hidden rounded-full bg-sidebar">
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
  const [data, setData] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const load = (): void => {
    setLoading(true)
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
              <div data-testid="usage-cost" className="rounded-xl border border-line bg-card p-6">
                <div className="text-sm text-muted">本月估算花费</div>
                <div className="mt-1 text-3xl font-semibold">约 {money(data.costCny)}</div>
                <div className="text-sm text-muted">估算值</div>
              </div>
            </div>

            {/* 最近 14 天柱状图：纯 CSS 柱条，不为一张小图引一整个图表库 */}
            <div className="mb-6 max-w-3xl rounded-xl border border-line bg-card p-6">
              <div className="mb-4 text-md font-medium">最近 14 天</div>
              {/* 柱区与日期轴**分成两行**：柱子的百分比高度要有一个"确定高度"的父级才算得出来。
                  一开始把日期塞进同一列里，那一列在 `items-end` 的行里高度由内容决定（= 只有日期
                  那行字那么高），于是所有柱子都算成 0——页面上是一整片空白（走查截图抓到的） */}
              <div data-testid="usage-daily" className="flex h-28 gap-1.5">
                {data.daily.map((d) => (
                  <div key={d.date} className="flex min-w-0 flex-1 flex-col justify-end">
                    <div
                      data-count={d.count}
                      title={`${d.date}：${d.count} 次`}
                      className={`w-full rounded-sm ${d.count > 0 ? 'bg-accent' : 'bg-sidebar'}`}
                      // 0 也留一点底座：整行空白会让人以为图没渲染出来
                      style={{ height: `${d.count > 0 ? Math.max(8, (d.count / maxDaily) * 100) : 4}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex gap-1.5">
                {data.daily.map((d) => (
                  <div key={d.date} className="min-w-0 flex-1 truncate text-center text-2xs text-muted-soft">
                    {shortDay(d.date)}
                  </div>
                ))}
              </div>
            </div>

            {/* 按档位消耗对比：这一块是成本透明化的核心 */}
            <div className="mb-6 max-w-3xl rounded-xl border border-line bg-card p-6">
              <div className="mb-1 text-md font-medium">按模式对比</div>
              <div className="mb-4 text-sm leading-5 text-muted">
                同样一次提问，增强模式的花费远高于标准模式；这里把两边的次数、tokens 与估算花费并排放，方便判断值不值。
              </div>
              <div data-testid="usage-by-tier" className="grid grid-cols-2 gap-4">
                {data.byTier.map((t) => (
                  <div key={t.tier} data-testid={`usage-tier-${t.tier}`} className="rounded-lg bg-bg p-4">
                    <div className="text-base font-medium">{t.label}</div>
                    {/* 次数 / tokens / 花费 三列并排：一眼就能比出"同样几次，钱差多少" */}
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <div>
                        <div className="text-xl font-semibold">{fmt(t.count)}</div>
                        <div className="text-xs text-muted">次</div>
                      </div>
                      <div>
                        <div className="text-xl font-semibold">{t.total > 0 ? fmt(t.total) : '—'}</div>
                        <div className="text-xs text-muted">tokens</div>
                      </div>
                      <div>
                        <div className="text-xl font-semibold">约 {money(t.costCny)}</div>
                        <div className="text-xs text-muted">估算花费</div>
                      </div>
                    </div>
                    <div className="mt-3 border-t border-line pt-2 text-sm text-muted">
                      输入 {fmt(t.input)} · 输出 {fmt(t.output)}
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
                    <th className="px-3 py-2 text-right font-normal">花费 · tokens</th>
                    <th className="rounded-r-md px-3 py-2 text-right font-normal">耗时中位数</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byType.map((r) => (
                    <tr key={r.type} className="border-b border-line last:border-0">
                      <td className="px-3 py-2">{r.label}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.count)}</td>
                      <td className="px-3 py-2 text-right">{costTokens(r.costCny, r.tokens)}</td>
                      <td className="px-3 py-2 text-right">{r.medianMs > 0 ? `${(r.medianMs / 1000).toFixed(1)}s` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div data-testid="usage-token-note" className="mt-3 text-sm leading-5 text-muted">
                tokens 含输入与输出，不同线路统计口径可能有差异；入库打标由后台程序调用，多数情况下拿不到
                token 数，只记次数（显示为「—」）。
              </div>
            </div>

            {/* 全页脚注：别让人拿这个数去对账 */}
            <div data-testid="usage-cost-note" className="mb-6 max-w-3xl text-sm leading-5 text-muted">
              费用为估算值，以实际账单为准。
            </div>
          </>
        )
      )}
    </div>
  )
}

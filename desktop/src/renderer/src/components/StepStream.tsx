import { useEffect, useState } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronRight, Loader2, RotateCcw } from 'lucide-react'
import { describeStep, artifactUsageType } from '../config/steps'
import { summaryText, toggleStepGroup, type StepGroup, type StepItem } from '../lib/step-stream'

/**
 * 过程可见性 · 步骤流。
 *
 * 干活期间逐条出现（当前步骤转圈），回答开始输出就折叠成一行
 * 「检索了 N 份资料 · 用时 Xs」，点一下展开看明细。
 *
 * **DOM 上不出现任何英文工具名**：`data-*` 放的是语义分类与结果数
 * （kind=search/read/scan/verify/…、count/unit/retry/verify），不是工具名——
 * 工具原名止步于 config/steps.ts 的查表入参，走查有正则守着这条。
 */

/**
 * 产物类步骤的「通常约 X 秒」从本机 usage jsonl 的 `byType.medianMs` 取。
 * **每轮开始时重新拉一次**：第一次做 PPT 时本来没有历史（走"内容较多时需要几分钟"），
 * 做完就有了，下一轮必须换成真实秒数——缓存在挂载那一刻的话永远换不过来。
 */
export function useArtifactMedians(turnKey: number): Record<string, number> {
  const [medians, setMedians] = useState<Record<string, number>>({})
  useEffect(() => {
    void window.api.usage
      .summary()
      .then((s) => {
        const m: Record<string, number> = {}
        for (const r of s.byType) m[r.type] = r.medianMs
        setMedians(m)
      })
      .catch(() => {
        /* 用量读不出来只影响一句提示语，不该让步骤流报错 */
      })
  }, [turnKey])
  return medians
}

function StepRow({ step, medians }: { step: StepItem; medians: Record<string, number> }) {
  const usageType = artifactUsageType(step.tool)
  const failed = step.status === 'failed'
  const phrase = describeStep(step.tool, step.args, {
    verify: step.verify,
    count: step.count,
    unit: step.unit,
    approx: step.approx,
    capped: step.capped,
    done: step.status !== 'running',
    failed,
    medianMs: usageType ? medians[usageType] : undefined,
  })
  // `data-verify` 单独给一个属性，**不能拿 data-kind 反推**：验证性扫描要是真扫到了东西，
  // 文案必须回到「核对了 N 份」（kind='scan'），继续说"已确认没有"就成了假话
  return (
    <div
      data-testid="step-item"
      data-kind={phrase.kind}
      data-status={step.status}
      data-count={step.count ?? ''}
      data-unit={step.unit ?? ''}
      data-retry={step.retry ? '1' : ''}
      data-verify={step.verify ? '1' : ''}
      data-capped={step.capped ? '1' : ''}
      className={`flex items-start gap-1.5 py-0.5 text-sm leading-5 ${failed ? 'text-warning' : 'text-muted'}`}
    >
      <span className="mt-0.5 shrink-0">
        {step.status === 'running' ? (
          <Loader2 size={12} className="animate-spin text-accent" />
        ) : failed ? (
          <AlertCircle size={12} />
        ) : (
          <Check size={12} />
        )}
      </span>
      <span className="min-w-0">
        {/* 重试标出来：同一件事做了两遍，不说的话用户只会觉得"怎么绕来绕去" */}
        {step.retry && (
          <span
            data-testid="step-retry"
            className="mr-1 inline-flex items-center gap-0.5 rounded-full border border-line px-1.5 text-2xs"
          >
            <RotateCcw size={9} /> 重试
          </span>
        )}
        {/* 「没成功」由 describeStep 统一补（N9）：文案的唯一真相源是 config/steps.ts */}
        {phrase.text}
      </span>
    </div>
  )
}

export function StepStream({
  sessionId,
  group,
  medians,
}: {
  sessionId: string
  group: StepGroup
  medians: Record<string, number>
}) {
  if (!group.steps.length) return null
  const summary = summaryText(group.steps, group.elapsedMs, { tier: group.tier, degraded: group.degraded })
  const toggle = (): void => toggleStepGroup(sessionId, group.id)

  if (group.collapsed) {
    return (
      <button
        data-testid="steps-summary"
        // Q15：档位结论也上 data-*，走查断言"界面说的档 = 主进程给的档"时不必去解析中文
        data-tier={group.tier ?? ''}
        data-degraded={group.degraded ? '1' : ''}
        onClick={toggle}
        className="mb-1 inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-sm text-muted hover:bg-hover hover:text-ink"
      >
        <ChevronRight size={12} /> {summary}
      </button>
    )
  }

  return (
    <div
      data-testid="step-list"
      // 展开态的成因（live=还在跑 / pinned=用户手点过）：这两个不摆出来的话，
      // 走查里"该折叠却没折叠"只能靠猜——2026-08-18 为这个白跑过一轮
      data-live={group.live ? '1' : ''}
      data-pinned={group.pinned ? '1' : ''}
      data-tier={group.tier ?? ''}
      data-degraded={group.degraded ? '1' : ''}
      className="mb-1.5"
    >
      {/* 收尾之后才给头部：跑到一半就出一个"收起"按钮，等于鼓励用户把正在看的东西关掉 */}
      {group.elapsedMs !== undefined && (
        <button
          data-testid="steps-summary-open"
          onClick={toggle}
          className="mb-0.5 inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-sm text-muted hover:bg-hover hover:text-ink"
        >
          <ChevronDown size={12} /> {summary}
        </button>
      )}
      {/* 左边线走橙：品牌二期把"进行中"的语义统一到基准线那支橙上（步骤流左边线 /
          投递箱进度条 / 云端降级条同一支），成功绿·失败红·取消灰这些终态色不动 */}
      <div className="border-l border-accent-line pl-2.5">
        {group.steps.map((s) => (
          <StepRow key={s.id} step={s} medians={medians} />
        ))}
      </div>
    </div>
  )
}

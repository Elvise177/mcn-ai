import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ui } from './ui'
import { errText } from '../lib/err'

/** 建库引导（两分支）：首跑 onboarding 与知识库页共用 */
export function VaultWizard({
  onReady,
  onSkip,
  skipLabel = '暂时跳过，之后可在「知识库」里建',
}: {
  onReady: (v: { path: string; noteCount: number }) => void
  onSkip?: () => void
  /** 换库入口复用本组件，退出口的文案不是「跳过」而是「返回当前库」 */
  skipLabel?: string
}) {
  // 哪张卡在忙（不是单纯的 boolean）：忙态文案要贴着被点的那张卡说话
  const [busy, setBusy] = useState<'create' | 'existing' | null>(null)
  /**
   * 建库分两步：先选模板，再弹系统保存框。
   *
   * 加这一步是因为**模板决定了这个库"是谁的"**——角色设定、分类候选集、
   * 业务功能开关全从它来。0.2.0 之前只有一套写死的 MCN 模板，于是第二个客户
   * （管理咨询）打开软件第一眼看到的是 `20_公司管理` `30_课程` `40_带货`，
   * 每篇笔记的摘要还是由一位"美妆带货MCN资料管理员"写的。
   */
  const [step, setStep] = useState<'pick' | 'template'>('pick')
  /**
   * H-12：以前 `pick()` 既没有 try 也没有 finally——`vault:createNew` 一抛错，
   * `setBusy(false)` 就永远不会执行，两张卡片半透明不可点、也没有任何报错，只能重启应用。
   */
  const pick = async (create: boolean, preset?: 'general' | 'mcn' | 'custom'): Promise<void> => {
    setBusy(create ? 'create' : 'existing')
    try {
      const v = create ? await window.api.vault.createNew(preset) : await window.api.vault.pickExisting()
      // v === null = 用户在 Finder 选择框点了取消，不是错误，安静回到可点状态
      if (v) {
        // R2：换库时上一库的投递还在跑、已被主进程停掉——要说出来，否则用户以为换库把入库弄丢了
        if (v.stoppedInbox) ui.toast('已停止上一库的入库（已完成的部分已保留，回到那个库后可点「立即处理」接着做）', 'info')
        onReady(v)
      }
    } catch (e) {
      ui.toast(`${create ? '新建知识库' : '打开知识库'}失败：${errText(e)}`, 'error')
    } finally {
      setBusy(null)
      // 失败/取消都退回第一步：停在模板页上会让人以为库已经建了一半
      setStep('pick')
    }
  }

  /** 三套模板。`custom` 先按通用起步，建完在设置里改——不是第三份预设 */
  const TEMPLATES = [
    { id: 'general' as const, name: '通用', desc: '适合大多数公司。分类为「管理 / 业务 / 个人」，可随时改' },
    { id: 'mcn' as const, name: '美妆带货 MCN', desc: '达人 / 产品 / 合作方实体卡，含脚本库与经营数据' },
    { id: 'custom' as const, name: '自定义', desc: '先按通用建，建好后在设置里改成你自己的分区与分类' },
  ]
  /** 大库首次索引要扫全盘，几十秒很正常——不给文案就会被当成卡死而反复点 */
  const cardBody = (mine: 'create' | 'existing', title: string, desc: string): JSX.Element =>
    busy === mine ? (
      <>
        <div className="mb-1 flex items-center gap-1.5 font-medium text-accent">
          <Loader2 size={14} className="animate-spin" />
          {mine === 'create' ? '正在创建/索引…' : '正在打开/索引…'}
        </div>
        <div className="text-sm text-muted">大库首次索引可能要几十秒，请稍候</div>
      </>
    ) : (
      <>
        <div className="mb-1 font-medium">{title}</div>
        <div className="text-sm text-muted">{desc}</div>
      </>
    )
  if (step === 'template') {
    return (
      <div className="fade-up flex flex-col items-center" data-testid="wizard-templates">
        <h1 className="mb-2 text-3xl font-semibold">你的知识库放什么内容？</h1>
        <p className="mb-10 text-md text-muted">决定分类方式与 AI 的理解口径，之后随时能改</p>
        <div className="flex gap-6">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              data-testid={`wizard-template-${t.id}`}
              disabled={!!busy}
              onClick={() => void pick(true, t.id)}
              className="w-64 rounded-xl border border-line bg-card p-6 text-left transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-60"
            >
              {busy === 'create' ? (
                cardBody('create', t.name, t.desc)
              ) : (
                <>
                  <div className="mb-1 font-medium">{t.name}</div>
                  <div className="text-sm text-muted">{t.desc}</div>
                </>
              )}
            </button>
          ))}
        </div>
        <button
          data-testid="wizard-template-back"
          onClick={() => setStep('pick')}
          className="mt-8 text-sm text-muted underline underline-offset-4 hover:text-accent"
        >
          返回
        </button>
      </div>
    )
  }

  return (
    <div className="fade-up flex flex-col items-center">
      {/* 衬线只留给首页问候语，这里跟全局一样走黑体 */}
      <h1 className="mb-2 text-3xl font-semibold">建立你的知识库</h1>
      <p className="mb-10 text-md text-muted">一个普通的 markdown 文件夹，数据永远在你自己手里</p>
      <div className="flex gap-6">
        {/* 两张卡同为中性样式，靠 hover（描边转强调色 + 浅底）给明确反馈 */}
        <button
          data-testid="wizard-create"
          disabled={!!busy}
          onClick={() => setStep('template')}
          className="w-64 rounded-xl border border-line bg-card p-6 text-left transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-60"
        >
          {cardBody('create', '新建知识库', '选一套模板，建一个干净的库——只有投递箱和资料库')}
        </button>
        <button
          data-testid="wizard-existing"
          disabled={!!busy}
          onClick={() => pick(false)}
          className="w-64 rounded-xl border border-line bg-card p-6 text-left transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-60"
        >
          {cardBody('existing', '使用已有知识库', '指向现有 Obsidian vault 或任何 markdown 文件夹')}
        </button>
      </div>
      {/* 同样是真入口，给下划线链接样式，别混进说明文字里 */}
      {onSkip && (
        <button
          onClick={onSkip}
          className="mt-8 text-sm text-muted underline underline-offset-4 hover:text-accent"
        >
          {skipLabel}
        </button>
      )}
    </div>
  )
}

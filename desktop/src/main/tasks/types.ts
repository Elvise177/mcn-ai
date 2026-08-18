/**
 * 全局任务状态层的类型定义（设计见 docs/DESIGN-task-state.md §1）。
 *
 * 两个概念必须分开，否则一定会做出「永远处于 running 的假任务」：
 *  - Task      有起点、有终态、可能失败、可能可取消（投递批次 / AI 生成 / 产物入库 / 云同步）
 *  - Condition 长期存在、没有终态，只有"当前是什么样"（云端连接状态）
 */

export type TaskKind = 'inbox' | 'agent' | 'ingest' | 'sync' | 'secret'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

/** 投递箱 pipeline 的阶段事件（原来定义在 orchestrator，搬来这里给任务对象共用） */
export interface InboxEvent {
  type: 'file-added' | 'run-start' | 'stage' | 'run-end'
  stage?: string
  status?: string
  message?: string
  pending?: number
  file?: string
  ok?: boolean
  /** pipeline 若在阶段行里报了 token 用量就原样带上（目前只有智能打标可能有），没有就是 undefined */
  usage?: unknown
  /** A-4：`convert_failures` 事件带的两张清单——转换失败的、格式不支持的 */
  failed?: string[]
  unsupported?: string[]
}

export interface TaskBase {
  /** `${kind}:${key}`，同一实体重跑复用同一个 id（不累积僵尸条目） */
  id: string
  kind: TaskKind
  /** 业务主键：inbox=vaultRoot，agent=conversationId，ingest=产物相对路径，sync=conversationId */
  key: string
  status: TaskStatus
  /** 全局条上显示的一句话。**主进程生成**——全局条/局部面板/诊断日志要显示同一句，
      文案散在渲染层三处必然长歪 */
  title: string
  startedAt: number
  endedAt?: number
  /** 有确定分母才给；agent 这种不知道总量的不给 */
  progress?: { done: number; total: number; label: string }
  /** failed 时的人话（不是 stack） */
  error?: string
  cancelable: boolean
  /** 单调递增版本号：渲染层丢弃乱序/迟到的 upsert，也是 reload 后对账的依据 */
  seq: number
}

export interface InboxTask extends TaskBase {
  kind: 'inbox'
  files: string[]
  stages: InboxEvent[]
  /** pipeline 子进程组 id（spawn detached:true，组 id == 组长 pid）。取消要用它 kill 整组 */
  pid?: number
  /** 谁停的：user=面板上点了「停止本轮」，quit=退出应用时清理 */
  canceled?: 'user' | 'quit'
}

export interface AgentTask extends TaskBase {
  kind: 'agent'
  conversationId: string
  /** 主进程累积的流式正文——切走再切回来靠它补齐（二期的 H-09 也靠它） */
  draft: string
  toolLine?: string
  sdkSessionId?: string
}

export interface IngestTask extends TaskBase {
  kind: 'ingest'
  /** 90_产物/ 下的相对路径 */
  artifactPath: string
  /** 成功后落位的笔记路径，用于「已入库 ✓ ›」跳转 */
  noteRel?: string
}

export interface SyncTask extends TaskBase {
  kind: 'sync'
  scope: 'conversation' | 'note'
  tries: number
  /** 0 = 已转手动，不再自动重试 */
  nextRetryAt?: number
}

/**
 * 密钥落盘（M-29）。safeStorage 的首次调用会同步冻住主进程数秒到一分钟，
 * 所以写 key 不能挡在登录/保存按钮前面——它变成一条任务，界面照常可交互。
 */
export interface SecretTask extends TaskBase {
  kind: 'secret'
  /** 落盘字段名（encryptedApiKey / encryptedSession …） */
  field: string
}

export type Task = InboxTask | AgentTask | IngestTask | SyncTask | SecretTask

/** Condition：云端状况。不是任务，没有终态 */
export interface CloudState {
  /** null = 还没探测过（启动首帧） */
  reachable: boolean | null
  loggedIn: boolean
  email?: string
  /** 最近一次失败原因，给「云端离线」条做副标题 */
  lastError?: string
  checkedAt: number
  /** 待重试的同步条数，>0 时 Dock 显示「N 条待同步」 */
  pendingSync: number
}

export type TaskEventPayload =
  | { type: 'snapshot'; tasks: Task[]; cloud: CloudState }
  | { type: 'upsert'; task: Task }
  | { type: 'remove'; id: string }
  | { type: 'cloud'; cloud: CloudState }

/** 投递箱主流程的阶段顺序。进度分母在主进程算，渲染层不再自己拼 */
export const INBOX_FLOW: Array<[string, string]> = [
  ['convert', '转换'],
  ['pii_guard', 'PII守卫'],
  ['tag_llm', '智能打标'],
  // 敏感文件走这一步：零模型的规则打标，补上 AI 打标跳过的那批的 frontmatter（A-2）。
  // 必须排在实体建链之前——07 没有 frontmatter 就写不进结构摘要
  ['tag_rules', '规则打标'],
  ['sensitive_enrich', '实体建链'],
  ['gen_moc', '索引重建'],
  // 实体建卡（A-3）：**跑在 pipeline 之后的主进程里**，不是 pipeline 阶段
  // （拍板理由：冻结体积与 spec 漏项风险，且增量卡片该由持库者管理）。
  // 它在 flow 里排在上云之前——新卡也要上云，而敏感卡要在上云前被拦下
  ['build_cards', '实体建卡'],
  ['cloud_sync', '上云'],
]

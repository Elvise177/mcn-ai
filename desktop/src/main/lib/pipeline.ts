import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/** 冻结版 pipeline 路径：兼容 打包态 / dev / 脚本直启（smoke）三种启动方式 */
export function pipelineBin(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'resources', 'pipeline', 'mcn-ingest'),
    join(app.getAppPath(), 'resources', 'pipeline', 'mcn-ingest'),
    join(app.getAppPath(), '..', '..', 'resources', 'pipeline', 'mcn-ingest'),
    join(process.cwd(), 'resources', 'pipeline', 'mcn-ingest'),
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return candidates[0]
}

/**
 * 一轮投递 pipeline 的 **argv**（纯函数，PLAN-v2 R5）。
 *
 * **key 不在这里**：打标 key 走环境变量（见 `pipelineEnv`）。以前 `--llm-key <明文>` 挂在 argv 上，
 * `ps -ef` 里任何本机用户都看得见（审计 b5）；`cli.py` 的 `--llm-key` 默认值本来就是
 * `os.environ["LLM_API_KEY"]`，冻结产物一行不用改。抽成纯函数是为了让 `smoke:guards`
 * 断言「argv 里没有 key」而不必真起一个子进程。
 */
export function pipelineArgs(o: {
  root: string
  llmKey: string | null
  llmBaseUrl: string
  llmModel: string
  sensitiveAllowAi: boolean
  maxCost?: number
}): string[] {
  const args = ['--vault', o.root, '--max-cost', String(o.maxCost ?? 10)]
  // A-8 三态：默认敏感文件只走本地规则打标；用户在设置里明示后才允许发给模型
  if (o.sensitiveAllowAi) args.push('--sensitive-allow-ai')
  if (o.llmKey) args.push('--llm-base-url', o.llmBaseUrl, '--llm-model', o.llmModel)
  else args.push('--skip-llm')
  return args
}

/**
 * pipeline 子进程的环境：只在有 key 时注入 `LLM_API_KEY`（R5）。
 * 不给 key 就**主动删掉**这个变量——万一开发机 shell 里挂着一把，别让它悄悄替客户付账
 * （同 `agentEnv` 先清 `ANTHROPIC_*` 再注入的理由）。
 */
export function pipelineEnv(base: NodeJS.ProcessEnv, llmKey: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.LLM_API_KEY
  if (llmKey) env.LLM_API_KEY = llmKey
  return env
}

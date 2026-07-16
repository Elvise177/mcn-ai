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

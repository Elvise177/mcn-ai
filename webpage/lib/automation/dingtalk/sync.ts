/**
 * 自动化中心 · 钉钉表格同步管道
 *
 * 通用模式：拉源表（如抖音数据总表）→ 逐行转换/过滤 → 增量写入目标分表。
 * 增量语义：目标表以 uniqueField 为幂等键——已存在则更新，不存在则插入，
 * 源表里没有的目标行不动（保护协同者手工加的行）。
 *
 * 芮思派场景的字段映射（douyinToDetail）目前是占位实现，
 * 等拿到客户抖音数据表的真实字段清单后按实际调整。
 */
import { listRecords, insertRecords, updateRecords, sendGroupMessage } from './client';

export interface SyncJobConfig {
  /** AI 表格文件 id（表格 URL 里的 base id） */
  baseId: string;
  /** 源工作表名称或 id（如：抖音数据总表） */
  sourceSheet: string;
  /** 目标工作表名称或 id（如：执行明细） */
  targetSheet: string;
  /** 幂等键字段名——源/目标行都用它对齐（如：视频ID / 视频链接） */
  uniqueField: string;
  /** 行转换：源记录 fields → 目标记录 fields；返回 null 表示跳过该行 */
  transform: (source: Record<string, unknown>) => Record<string, unknown> | null;
}

export interface SyncResult {
  pulled: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** 执行一次同步（幂等，可重复跑） */
export async function runSyncJob(cfg: SyncJobConfig): Promise<SyncResult> {
  const res: SyncResult = { pulled: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };

  const sourceRows = await listRecords(cfg.baseId, cfg.sourceSheet);
  res.pulled = sourceRows.length;

  // 目标表现状：uniqueField → 记录 id 的映射，用于判定插入还是更新
  const targetRows = await listRecords(cfg.baseId, cfg.targetSheet);
  const targetIndex = new Map<string, string>();
  for (const row of targetRows) {
    const key = String(row.fields?.[cfg.uniqueField] ?? '');
    if (key && row.id) targetIndex.set(key, row.id);
  }

  const toInsert: Array<Record<string, unknown>> = [];
  const toUpdate: Array<{ id: string; fields: Record<string, unknown> }> = [];

  for (const row of sourceRows) {
    try {
      const key = String(row.fields?.[cfg.uniqueField] ?? '');
      if (!key) {
        res.skipped++;
        continue;
      }
      const mapped = cfg.transform(row.fields ?? {});
      if (!mapped) {
        res.skipped++;
        continue;
      }
      const existingId = targetIndex.get(key);
      if (existingId) toUpdate.push({ id: existingId, fields: mapped });
      else toInsert.push({ ...mapped, [cfg.uniqueField]: key });
    } catch (e) {
      res.errors.push(String(e).slice(0, 200));
    }
  }

  if (toInsert.length) res.inserted = await insertRecords(cfg.baseId, cfg.targetSheet, toInsert);
  if (toUpdate.length) res.updated = await updateRecords(cfg.baseId, cfg.targetSheet, toUpdate);
  return res;
}

/**
 * 芮思派 · 抖音数据 → 执行明细 的字段映射（占位版）。
 * 【联调时按客户真实字段清单改这里】：左边 = 抖音数据表字段名，右边 = 执行明细表字段名。
 */
export function douyinToDetail(src: Record<string, unknown>): Record<string, unknown> | null {
  // 没有视频链接的行视为无效数据，跳过
  if (!src['视频链接'] && !src['视频ID']) return null;
  return {
    视频链接: src['视频链接'] ?? '',
    账号名: src['账号名'] ?? src['达人昵称'] ?? '',
    发布日期: src['发布时间'] ?? src['发布日期'] ?? '',
    播放量: src['播放量'] ?? 0,
    点赞: src['点赞数'] ?? src['点赞'] ?? 0,
    评论: src['评论数'] ?? src['评论'] ?? 0,
    GMV: src['GMV'] ?? src['成交金额'] ?? 0,
    数据更新时间: new Date().toISOString().slice(0, 10),
  };
}

/** 跑完整的每日同步并推送结果到钉钉群 */
export async function runDailySync(baseId: string): Promise<SyncResult> {
  const result = await runSyncJob({
    baseId,
    sourceSheet: process.env.DINGTALK_SOURCE_SHEET ?? '抖音数据',
    targetSheet: process.env.DINGTALK_TARGET_SHEET ?? '执行明细',
    uniqueField: process.env.DINGTALK_UNIQUE_FIELD ?? '视频链接',
    transform: douyinToDetail,
  });

  const status = result.errors.length ? '部分成功 ⚠️' : '完成 ✅';
  await sendGroupMessage(
    'mcn-ai 数据同步',
    `### 抖音数据同步${status}\n\n拉取 ${result.pulled} 行 · 新增 ${result.inserted} · 更新 ${result.updated} · 跳过 ${result.skipped}` +
      (result.errors.length ? `\n\n错误 ${result.errors.length} 条：${result.errors[0]}` : '') +
      `\n\n> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · mcn-ai 自动化`,
  );
  return result;
}

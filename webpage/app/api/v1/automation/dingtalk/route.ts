/**
 * 自动化中心 · 钉钉表格同步触发端点
 *
 * GET  ?baseId=xxx          探测：列出工作表 + 源表前 3 行样例（联调用，不写任何数据）
 * POST { baseId }           执行一次每日同步（幂等）
 *
 * 鉴权：Authorization: Bearer <AUTOMATION_SECRET>（Vercel 环境变量，防止公网滥触发）。
 * 定时：Vercel Cron 或任何调度器每天定点 POST 本端点（抖音数据更新后 1 小时）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { listSheets, listRecords } from '@/lib/automation/dingtalk/client';
import { runDailySync } from '@/lib/automation/dingtalk/sync';

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  // AUTOMATION_SECRET 供手动 curl；CRON_SECRET 是 Vercel Cron 的约定（配置后 Cron 请求自动带 Bearer）
  const auth = req.headers.get('authorization');
  const secrets = [process.env.AUTOMATION_SECRET, process.env.CRON_SECRET].filter(Boolean);
  return secrets.some((s) => auth === `Bearer ${s}`);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const baseId = req.nextUrl.searchParams.get('baseId') ?? process.env.DINGTALK_BASE_ID;
  if (!baseId) return NextResponse.json({ error: '缺少 baseId' }, { status: 400 });
  // Vercel Cron 只发 GET：带 run=1 时执行同步（与 POST 等价）
  if (req.nextUrl.searchParams.get('run') === '1') {
    try {
      const result = await runDailySync(baseId);
      return NextResponse.json({ ok: true, result });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }
  try {
    const sheets = await listSheets(baseId);
    const sourceSheet = process.env.DINGTALK_SOURCE_SHEET ?? '抖音数据';
    let sample: unknown[] = [];
    try {
      sample = (await listRecords(baseId, sourceSheet, { pageSize: 3, maxTotal: 3 })).map(
        (r) => r.fields,
      );
    } catch {
      /* 源表名不对时 sheets 列表足够定位问题 */
    }
    return NextResponse.json({ ok: true, sheets, sourceSheet, sample });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { baseId?: string };
  const baseId = body.baseId ?? process.env.DINGTALK_BASE_ID;
  if (!baseId) return NextResponse.json({ error: '缺少 baseId' }, { status: 400 });
  try {
    const result = await runDailySync(baseId);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

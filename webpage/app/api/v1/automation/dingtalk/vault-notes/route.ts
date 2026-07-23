/**
 * 经营数据 → 知识库笔记：把钉钉 AI 表格的抖音数据聚合成 markdown，
 * 桌面端定时拉取写入 vault（40_带货/抖音经营数据/），供 AI 问答引用。
 *
 * GET /api/v1/automation/dingtalk/vault-notes
 * 鉴权：Authorization: Bearer <supabase access_token>（桌面端登录态）
 * 返回：{ notes: [{ path, content }] } —— path 为 vault 相对路径
 */
import { NextRequest, NextResponse } from 'next/server';
import { authBearerUser } from '@/lib/auth/bearer';
import { listRecords } from '@/lib/automation/dingtalk/client';

export const maxDuration = 300;

const BRANDS = [
  'POPY', 'W+CDhai', 'babi', 'f21', 'heavenpink', 'inc洁颜蜜', 'lazyfun', 'pinkbear',
  '万花镜', '健美创研', '兰瑟', '春汀', '木柯诗', '玛丽黛佳',
  '向日花', '加亮', '柳丝木', '霞飞', '白日梦醒家', 'bh', '罗小曼', 'utour', 'yoolens',
];

interface Row {
  brand: string;
  talent: string;
  product: string;
  date: string; // YYYY-MM-DD
  month: string;
  gmv: number;
  deals: number;
  ad: number;
  link: string;
}

function pick(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in (v as Record<string, unknown>)) {
    return String((v as { name: unknown }).name ?? '');
  }
  return v == null ? '' : String(v);
}

function day(ms: unknown): string {
  const n = Number(ms);
  if (!n) return '';
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function findBrand(title: string): string | null {
  const t = title.toLowerCase();
  for (const b of [...BRANDS].sort((x, y) => y.length - x.length)) {
    const bl = b.toLowerCase();
    if (/^[a-z0-9+&.\- ]+$/.test(bl)) {
      if (new RegExp(`(?<![a-z0-9])${bl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(t)) return b;
    } else if (t.includes(bl)) return b;
  }
  return null;
}

const fmtW = (n: number): string => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : `${Math.round(n)}`);

export async function GET(req: NextRequest) {
  const user = await authBearerUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const baseId = process.env.DINGTALK_BASE_ID;
  if (!baseId) return NextResponse.json({ error: '服务端未配置 DINGTALK_BASE_ID' }, { status: 500 });

  try {
    const records = await listRecords(baseId, 'EaE7bV0', { maxTotal: 10000 });
    // 去重（同链接留最新采数）并结构化
    const byLink = new Map<string, { ts: number; row: Row }>();
    for (const r of records) {
      const f = r.fields ?? {};
      const link = pick(f['视频链接']).trim() || `row-${r.id}`;
      const ts = Number(f['采数时间'] ?? 0);
      const prev = byLink.get(link);
      if (prev && ts <= prev.ts) continue;
      const title = pick(f['商品名称']);
      const date = day(f['发布时间']);
      byLink.set(link, {
        ts,
        row: {
          brand: findBrand(title) ?? '其他',
          talent: pick(f['账号名称']),
          product: title,
          date,
          month: date.slice(0, 7),
          gmv: Number(f['GMV'] ?? 0),
          deals: Number(f['成交数'] ?? 0),
          ad: Number(f['投放金额'] ?? 0),
          link: link.startsWith('http') ? link : '',
        },
      });
    }
    const rows = Array.from(byLink.values()).map((x: { ts: number; row: Row }) => x.row);
    const updated = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

    // 总览笔记：按品牌汇总（全周期）
    const byBrand = new Map<string, Row[]>();
    for (const r of rows) {
      if (!byBrand.has(r.brand)) byBrand.set(r.brand, []);
      byBrand.get(r.brand)!.push(r);
    }
    const brandLines = Array.from(byBrand.entries())
      .map(([b, list]: [string, Row[]]) => ({
        b,
        n: list.length,
        gmv: list.reduce((a, x) => a + x.gmv, 0),
        ad: list.reduce((a, x) => a + x.ad, 0),
      }))
      .sort((a: {gmv:number}, b: {gmv:number}) => b.gmv - a.gmv)
      .map((x: {b:string;n:number;gmv:number;ad:number}) => `| ${x.b} | ${x.n} | ${fmtW(x.gmv)} | ${fmtW(x.ad)} | ${x.ad ? (x.gmv / x.ad).toFixed(2) : '-'} |`);

    const notes: Array<{ path: string; content: string }> = [];
    notes.push({
      path: '40_带货/抖音经营数据/经营数据总览.md',
      content: `---
tags: [经营数据, 抖音]
数据更新: ${updated}
来源: 钉钉数据服务（自动同步，勿手改）
---

# 抖音经营数据总览

共 ${rows.length} 条视频。

| 品牌 | 视频数 | GMV | 投流 | ROI |
|---|---|---|---|---|
${brandLines.join('\n')}
`,
    });

    // 各品牌笔记：月度统计 + TOP 视频
    for (const [brand, list] of Array.from(byBrand.entries())) {
      if (brand === '其他' || list.length < 3) continue;
      const byMonth = new Map<string, Row[]>();
      for (const r of list) {
        if (!r.month) continue;
        if (!byMonth.has(r.month)) byMonth.set(r.month, []);
        byMonth.get(r.month)!.push(r);
      }
      const monthLines = Array.from(byMonth.entries())
        .sort()
        .map(([m, ls]: [string, Row[]]) => {
          const gmv = ls.reduce((a, x) => a + x.gmv, 0);
          const ad = ls.reduce((a, x) => a + x.ad, 0);
          return `| ${m} | ${ls.length} | ${fmtW(gmv)} | ${fmtW(ad)} | ${ad ? (gmv / ad).toFixed(2) : '-'} |`;
        });
      const top = [...list]
        .sort((a, b) => b.gmv - a.gmv)
        .slice(0, 8)
        .map(
          (r, i) =>
            `${i + 1}. **${r.talent}**｜${r.date}｜GMV ${fmtW(r.gmv)}｜成交 ${r.deals}｜${r.product.slice(0, 30)}`,
        );
      notes.push({
        path: `40_带货/抖音经营数据/${brand.replace(/[\\/:*?"<>|]/g, '')}.md`,
        content: `---
tags: [经营数据, 抖音, ${brand}]
数据更新: ${updated}
来源: 钉钉数据服务（自动同步，勿手改）
---

# ${brand} · 抖音经营数据

## 月度趋势

| 月份 | 视频数 | GMV | 投流 | ROI |
|---|---|---|---|---|
${monthLines.join('\n')}

## GMV TOP 视频

${top.join('\n')}
`,
      });
    }

    return NextResponse.json({ notes, count: rows.length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

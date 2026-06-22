/**
 * MCN AI 剪辑 worker — 部署在国内服务器，与 VectCutAPI 同机运行。
 *
 * 流程：轮询 Supabase 认领任务 → 取转写+视频信息 → 检索剪辑模板
 *      → LLM 产出剪辑决策 JSON → 调 VectCutAPI 生成剪映草稿 → 回写任务状态。
 *
 * 注意：VectCutAPI 的具体端点以实际部署版本为准
 * （https://github.com/sun-guannan/VectCutAPI），buildDraft() 中的调用
 * 是按其 HTTP API 约定写的脚手架，首次联调时请对照其文档核对。
 */
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const required = (name) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
};

const supabase = createClient(
  required('SUPABASE_URL'),
  required('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const openai = new OpenAI({
  apiKey: required('AIHUBMIX_API_KEY'),
  baseURL: 'https://aihubmix.com/v1',
});

const VECTCUT_BASE_URL = process.env.VECTCUT_BASE_URL || 'http://127.0.0.1:9001';
const WORKER_ID = process.env.WORKER_ID || 'worker-1';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const CUT_PLAN_MODEL = process.env.CUT_PLAN_MODEL || 'claude-sonnet-4-6';

async function setStatus(jobId, fields) {
  await supabase
    .from('edit_jobs')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', jobId);
}

/** 1. 取任务上下文：转写 + 视频信息 + 模板 */
async function loadContext(job) {
  const { data: transcript } = await supabase
    .from('video_transcripts')
    .select('transcript')
    .eq('id', job.transcript_id)
    .maybeSingle();

  const { data: video } = await supabase
    .from('imported_videos')
    .select(
      'aweme_id, video_desc, play_url, duration_seconds, product_title, product_category_l2, like_count',
    )
    .eq('id', job.imported_video_id)
    .maybeSingle();

  if (!transcript?.transcript) throw new Error('转写内容不存在');
  if (!video?.play_url) throw new Error('视频播放地址缺失（可能已过期，请重新导入）');

  let template = null;
  if (job.template_id) {
    const { data } = await supabase
      .from('editing_templates')
      .select('name, description, template')
      .eq('id', job.template_id)
      .maybeSingle();
    template = data;
  }

  return { transcript: transcript.transcript, video, template };
}

/** 2. LLM 产出剪辑决策 JSON */
async function generateCutPlan(job, ctx) {
  const systemPrompt = `你是美妆带货短视频的剪辑决策引擎。根据口播转写和剪辑要求，输出 JSON 剪辑方案。
输出格式（只输出 JSON，不要其他文字）：
{
  "segments": [{ "start": 秒, "end": 秒, "label": "钩子|痛点|卖点|促单", "keep": true|false, "reason": "取舍理由" }],
  "subtitles": [{ "start": 秒, "end": 秒, "text": "字幕文本" }],
  "pacing_notes": "节奏建议",
  "bgm_suggestion": "BGM 风格建议"
}
原则：黄金 3 秒必须保住钩子；去掉口误、停顿、重复段落；总时长控制在 30-60 秒。`;

  const userPrompt = [
    `视频时长：${ctx.video.duration_seconds ?? '未知'} 秒`,
    `视频描述：${ctx.video.video_desc ?? '无'}`,
    `商品：${ctx.video.product_title ?? '无'}（${ctx.video.product_category_l2 ?? ''}）`,
    ctx.template
      ? `剪辑模板「${ctx.template.name}」：${ctx.template.description ?? ''}\n模板规则：${JSON.stringify(ctx.template.template)}`
      : null,
    job.instruction ? `用户剪辑要求：${job.instruction}` : null,
    `\n口播转写：\n${ctx.transcript}`,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await openai.chat.completions.create({
    model: CUT_PLAN_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 4000,
  });

  const raw = response.choices[0]?.message?.content ?? '';
  const jsonText = raw.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
  return JSON.parse(jsonText);
}

async function vectcut(path, payload) {
  const res = await fetch(`${VECTCUT_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`VectCutAPI ${path} 失败 ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** 3. 调 VectCutAPI 按剪辑决策生成剪映草稿（端点名首次联调时核对） */
async function buildDraft(ctx, cutPlan) {
  const draft = await vectcut('/create_draft', { width: 1080, height: 1920 });
  const draftId = draft.output?.draft_id ?? draft.draft_id;
  if (!draftId) throw new Error('VectCutAPI 未返回 draft_id');

  let timelineStart = 0;
  for (const seg of cutPlan.segments ?? []) {
    if (!seg.keep) continue;
    await vectcut('/add_video', {
      draft_id: draftId,
      video_url: ctx.video.play_url,
      start: seg.start,
      end: seg.end,
      target_start: timelineStart,
    });
    timelineStart += seg.end - seg.start;
  }

  for (const sub of cutPlan.subtitles ?? []) {
    await vectcut('/add_subtitle', {
      draft_id: draftId,
      text: sub.text,
      start: sub.start,
      end: sub.end,
    });
  }

  const saved = await vectcut('/save_draft', { draft_id: draftId });
  return saved.output?.draft_url ?? saved.draft_url ?? `draft:${draftId}`;
}

async function processJob(job) {
  console.log(`[${WORKER_ID}] 处理任务 ${job.id}`);
  try {
    await setStatus(job.id, { status: 'analyzing' });
    const ctx = await loadContext(job);

    const cutPlan = await generateCutPlan(job, ctx);
    await setStatus(job.id, { status: 'drafting', cut_plan: cutPlan });

    const draftUrl = await buildDraft(ctx, cutPlan);
    await setStatus(job.id, { status: 'done', draft_url: draftUrl, error_message: null });
    console.log(`[${WORKER_ID}] 任务 ${job.id} 完成：${draftUrl}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${WORKER_ID}] 任务 ${job.id} 失败：${message}`);
    await setStatus(job.id, { status: 'failed', error_message: message });
  }
}

async function loop() {
  console.log(`[${WORKER_ID}] 启动，轮询间隔 ${POLL_INTERVAL_MS}ms`);
  for (;;) {
    try {
      const { data: jobs, error } = await supabase.rpc('claim_next_edit_job', {
        p_worker_id: WORKER_ID,
      });
      if (error) {
        console.error('认领任务失败:', error.message);
      } else if (jobs && jobs.length > 0) {
        await processJob(jobs[0]);
        continue; // 有任务时立即尝试下一个
      }
    } catch (e) {
      console.error('轮询异常:', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

loop();

/**
 * 压力 / 并发冒烟测试（需 dev server 运行在 BASE_URL）
 * Usage: npm run stress-test
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env.local' });

import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';

import { createScriptAdminClient } from './lib/supabase-admin';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const EMAIL = process.env.STRESS_EMAIL ?? 'tan779520069@gmail.com';
const PASSWORD = process.env.STRESS_PASSWORD ?? '123456';
/** 可选：抖音分享文案/链接，用于压测 POST 解析（依赖 TikHub 外网） */
const STRESS_SHARE_URL = process.env.STRESS_SHARE_URL?.trim() ?? '';
const IMPORT_TIMEOUT_MS = 90_000;
const TRANSCRIBE_TIMEOUT_MS = 300_000;

type Result = { name: string; ok: boolean; ms: number; detail?: string };

const results: Result[] = [];

function record(name: string, ok: boolean, ms: number, detail?: string) {
  results.push({ name, ok, ms, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag} ${name} (${ms}ms)${detail ? ` — ${detail}` : ''}`);
}

async function withAuthFetch(
  cookieHeader: string,
  path: string,
  init: RequestInit = {},
  timeoutMs?: number,
) {
  const headers = new Headers(init.headers);
  headers.set('Cookie', cookieHeader);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const start = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - start };
}

function parseApiError(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: string };
    return body.error?.slice(0, 120) ?? text.slice(0, 120);
  } catch {
    return text.slice(0, 120);
  }
}

async function loginAndGetCookies(): Promise<string> {
  const cookieStore = new Map<string, string>();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return Array.from(cookieStore.entries()).map(([name, value]) => ({
            name,
            value,
          }));
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            if (value) cookieStore.set(name, value);
            else cookieStore.delete(name);
          }
        },
      },
    },
  );

  const { error } = await supabase.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });
  if (error) throw new Error(`Login failed: ${error.message}`);

  return Array.from(cookieStore.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function testHealth() {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE}/api/v1/health`);
    const body = await res.json();
    record(
      'health',
      res.status === 200 && body.status === 'ok',
      Date.now() - start,
      `status=${res.status}`,
    );
  } catch (e) {
    record('health', false, Date.now() - start, String(e));
  }
}

async function testAuthenticatedApis(cookie: string) {
  const endpoints = [
    '/api/v1/profile',
    '/api/v1/roles',
    '/api/v1/conversations',
    '/api/v1/admin/me',
    '/api/v1/admin/dashboard',
    '/api/v1/admin/roles',
    '/api/v1/admin/users',
    '/api/v1/admin/stats?range=7d',
    '/api/v1/admin/system',
  ];

  for (const path of endpoints) {
    const { status, ms } = await withAuthFetch(cookie, path);
    record(`GET ${path}`, status === 200, ms, `status=${status}`);
  }
}

async function testConcurrentReads(cookie: string, n = 30) {
  const start = Date.now();
  const tasks = Array.from({ length: n }, () =>
    withAuthFetch(cookie, '/api/v1/conversations'),
  );
  const settled = await Promise.allSettled(tasks);
  const ok = settled.filter(
    (r) => r.status === 'fulfilled' && r.value.status === 200,
  ).length;
  const fail = n - ok;
  record(
    `concurrent-read x${n}`,
    fail === 0,
    Date.now() - start,
    `${ok}/${n} ok`,
  );
}

async function testRapidConversationCreates(cookie: string, roleId: string) {
  const start = Date.now();
  const tasks = Array.from({ length: 10 }, (_, i) =>
    withAuthFetch(cookie, '/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ roleId }),
    }).then((r) => ({ ...r, i })),
  );
  const settled = await Promise.allSettled(tasks);
  const ok = settled.filter(
    (r) => r.status === 'fulfilled' && r.value.status === 200,
  ).length;
  const ids: string[] = [];
  const roleIds = new Map<string, string>();
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value.status === 200) {
      try {
        const body = JSON.parse(r.value.text) as {
          id: string;
          role_id: string | null;
        };
        ids.push(body.id);
        if (body.role_id) roleIds.set(body.id, body.role_id);
      } catch {
        // ignore
      }
    }
  }
  record(
    'concurrent-create x10',
    ok === 10,
    Date.now() - start,
    `${ok}/10 ok`,
  );
  return { ids, roleIds };
}

async function testConcurrentMessageLoads(
  cookie: string,
  conversationIds: string[],
) {
  const start = Date.now();
  const tasks = conversationIds.map((id) =>
    withAuthFetch(cookie, `/api/v1/conversations/${id}`),
  );
  const settled = await Promise.allSettled(tasks);
  const ok = settled.filter(
    (r) => r.status === 'fulfilled' && r.value.status === 200,
  ).length;
  record(
    `concurrent-msg-load x${conversationIds.length}`,
    ok === conversationIds.length,
    Date.now() - start,
    `${ok}/${conversationIds.length} ok`,
  );
}

async function testChatStream(cookie: string, conversationId: string, roleId: string) {
  const start = Date.now();
  try {
    const { status, text } = await withAuthFetch(cookie, '/api/v1/chat', {
      method: 'POST',
      body: JSON.stringify({
        conversationId,
        roleId,
        message: '压力测试：请回复 OK',
      }),
    });
    const hasContent = text.includes('data:') || text.length > 0;
    record(
      'chat-stream',
      status === 200 && hasContent,
      Date.now() - start,
      `status=${status} bytes=${text.length}`,
    );
  } catch (e) {
    record('chat-stream', false, Date.now() - start, String(e));
  }
}

async function testImportApis(cookie: string): Promise<string> {
  const history = await withAuthFetch(cookie, '/api/v1/videos/import?limit=30');
  record(
    'GET /api/v1/videos/import',
    history.status === 200,
    history.ms,
    `status=${history.status}`,
  );

  const start = Date.now();
  const tasks = Array.from({ length: 15 }, () =>
    withAuthFetch(cookie, '/api/v1/videos/import?limit=10'),
  );
  const settled = await Promise.allSettled(tasks);
  const ok = settled.filter(
    (r) => r.status === 'fulfilled' && r.value.status === 200,
  ).length;
  record(
    'concurrent-import-history x15',
    ok === 15,
    Date.now() - start,
    `${ok}/15 ok`,
  );

  let awemeId = '';
  try {
    const list = JSON.parse(history.text) as Array<{ aweme_id?: string }>;
    awemeId = list[0]?.aweme_id ?? '';
  } catch {
    // ignore
  }

  if (awemeId) {
    const detail = await withAuthFetch(cookie, `/api/v1/videos/${awemeId}`);
    record(
      `GET /api/v1/videos/${awemeId.slice(0, 8)}…`,
      detail.status === 200,
      detail.ms,
      `status=${detail.status}`,
    );
  } else {
    record('GET /api/v1/videos/[aweme_id]', true, 0, 'skip — no import history');
  }

  return awemeId;
}

/** TikHub 解析 + AssemblyAI 转写（外网依赖，失败不中断其余用例） */
async function testImportPipeline(cookie: string, historyAwemeId: string) {
  console.log('\n--- Import pipeline (TikHub + AssemblyAI) ---\n');

  let awemeId = historyAwemeId;

  if (STRESS_SHARE_URL) {
    console.log('POST import (TikHub parse)...');
    const importRes = await withAuthFetch(
      cookie,
      '/api/v1/videos/import',
      {
        method: 'POST',
        body: JSON.stringify({ share_url: STRESS_SHARE_URL }),
      },
      IMPORT_TIMEOUT_MS,
    );
    const importOk = importRes.status === 200;
    record(
      'POST /api/v1/videos/import',
      importOk,
      importRes.ms,
      importOk
        ? 'parsed'
        : `status=${importRes.status} ${parseApiError(importRes.text)}`,
    );
    if (importOk) {
      try {
        const body = JSON.parse(importRes.text) as {
          video?: { aweme_id?: string };
        };
        awemeId = body.video?.aweme_id ?? awemeId;
      } catch {
        // ignore
      }
    }
  } else {
    record(
      'POST /api/v1/videos/import',
      true,
      0,
      'skip — set STRESS_SHARE_URL in .env.local to test TikHub',
    );
  }

  if (!awemeId) {
    record(
      'POST /api/v1/videos/[aweme_id]/transcribe',
      false,
      0,
      'skip — no aweme_id (parse a video first)',
    );
    return;
  }

  if (!process.env.ASSEMBLYAI_API_KEY?.trim()) {
    record(
      'POST /api/v1/videos/[aweme_id]/transcribe',
      false,
      0,
      'skip — ASSEMBLYAI_API_KEY not set',
    );
    return;
  }

  console.log(`POST transcribe (AssemblyAI) aweme_id=${awemeId}...`);
  const transcribeRes = await withAuthFetch(
    cookie,
    `/api/v1/videos/${awemeId}/transcribe`,
    { method: 'POST' },
    TRANSCRIBE_TIMEOUT_MS,
  );
  const transcribeOk = transcribeRes.status === 200;
  let detail = `status=${transcribeRes.status}`;
  if (transcribeOk) {
    try {
      const body = JSON.parse(transcribeRes.text) as {
        cached?: boolean;
        transcript?: string;
      };
      const len = body.transcript?.length ?? 0;
      detail = `${body.cached ? 'cached' : 'fresh'}, ${len} chars`;
    } catch {
      detail = 'ok';
    }
  } else {
    detail += ` ${parseApiError(transcribeRes.text)}`;
  }

  record(
    'POST /api/v1/videos/[aweme_id]/transcribe',
    transcribeOk,
    transcribeRes.ms,
    detail,
  );
}

async function testBootstrapIdempotent(cookie: string) {
  const start = Date.now();
  const before = await withAuthFetch(cookie, '/api/v1/profile');
  const boot1 = await withAuthFetch(cookie, '/api/v1/auth/bootstrap', {
    method: 'POST',
  });
  const boot2 = await withAuthFetch(cookie, '/api/v1/auth/bootstrap', {
    method: 'POST',
  });
  const after = await withAuthFetch(cookie, '/api/v1/profile');

  let beforeRole = '';
  let afterRole = '';
  try {
    beforeRole = (JSON.parse(before.text) as { role: string }).role;
    afterRole = (JSON.parse(after.text) as { role: string }).role;
  } catch {
    // ignore
  }

  const ok =
    boot1.status === 200 &&
    boot2.status === 200 &&
    beforeRole === afterRole &&
    beforeRole === 'super_admin';

  record(
    'bootstrap-idempotent',
    ok,
    Date.now() - start,
    `role ${beforeRole} → ${afterRole}`,
  );
}

async function cleanupConversations(ids: string[]) {
  const admin = createScriptAdminClient();
  if (ids.length === 0) return;
  await admin.from('conversations').delete().in('id', ids);
}

async function main() {
  console.log(`\n=== MCN AI Stress Test @ ${BASE} ===\n`);

  await testHealth();

  let cookie: string;
  try {
    const start = Date.now();
    cookie = await loginAndGetCookies();
    record('login', true, Date.now() - start, EMAIL);
  } catch (e) {
    record('login', false, 0, String(e));
    printSummary();
    process.exit(1);
  }

  await testAuthenticatedApis(cookie);
  await testConcurrentReads(cookie, 30);
  const historyAwemeId = await testImportApis(cookie);
  await testImportPipeline(cookie, historyAwemeId);
  await testBootstrapIdempotent(cookie);

  const rolesRes = await withAuthFetch(cookie, '/api/v1/roles');
  let roleId = '';
  try {
    const roles = JSON.parse(rolesRes.text) as Array<{ id: string }>;
    roleId = roles[0]?.id ?? '';
  } catch {
    // ignore
  }

  if (!roleId) {
    record('resolve-role', false, 0, 'no roles');
    printSummary();
    process.exit(1);
  }

  const { ids: createdIds, roleIds } = await testRapidConversationCreates(
    cookie,
    roleId,
  );
  await testConcurrentMessageLoads(cookie, createdIds.slice(0, 5));

  const firstId = createdIds[0];
  const chatRoleId = (firstId && roleIds.get(firstId)) || roleId;
  if (firstId) {
    await testChatStream(cookie, firstId, chatRoleId);
  }

  console.log('\nCleaning up stress-test conversations...');
  await cleanupConversations(createdIds);

  printSummary();
}

function printSummary() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Summary: ${passed}/${results.length} passed ===`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.detail ?? ''}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

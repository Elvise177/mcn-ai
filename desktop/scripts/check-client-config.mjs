// 用法（在 desktop/ 下）：node scripts/check-client-config.mjs [https://www.makeupai.top]  —— 核生产 client-config 契约形状，key 打码
// 用 e2e 测试账号登录 Supabase 拿 access_token，打本地 dev server 的 /api/v1/client-config，
// 只打印契约形状（key 值全部打码），验证契约 v2 的输出。
import { createClient } from '../../webpage/node_modules/@supabase/supabase-js/dist/index.mjs'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync(new URL('../../webpage/.env.local', import.meta.url), 'utf-8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')])
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { data, error } = await sb.auth.signInWithPassword({ email: 'mcnai-test-a@example.com', password: 'McnAi-Test-2026!' })
if (error) throw error
const base = process.argv[2] || 'http://localhost:3000'
const res = await fetch(`${base}/api/v1/client-config`, { headers: { authorization: `Bearer ${data.session.access_token}` } })
const body = await res.json()
const mask = (v) => (typeof v === 'string' && v.length > 8 ? `${v.slice(0, 4)}…(${v.length})` : v)
const shape = JSON.parse(JSON.stringify(body), (k, v) => (/apikey|ApiKey/i.test(k) ? mask(v) : v))
console.log(res.status, JSON.stringify(shape, null, 2))
await sb.auth.signOut()

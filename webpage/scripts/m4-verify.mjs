/**
 * M4 全链路验收（迁移 010/011 执行后运行）：
 *   node scripts/m4-verify.mjs      —— 需要 webpage dev server 在 localhost:3000 跑着
 *
 * 覆盖：建两个测试号 → A 私人层入库 → A 检索命中 → B 检索不到 A 的私人层（隔离）
 *      → 哈希去重跳过 → A 写聊天记录（RLS）
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env.local'), 'utf-8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
const API = process.env.API_BASE || 'http://localhost:3000'
const admin = createClient(URL_, SERVICE)

const PWD = 'McnAi-Test-2026!'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function ensureUser(email) {
  const { data: list } = await admin.auth.admin.listUsers()
  const existing = list.users.find((u) => u.email === email)
  const user =
    existing ??
    (await admin.auth.admin.createUser({ email, password: PWD, email_confirm: true })).data.user
  // 确保 profile 有组织（复用库里第一个组织）
  const { data: org } = await admin.from('organizations').select('id').limit(1).single()
  await admin
    .from('user_profiles')
    .upsert({ id: user.id, organization_id: org.id, role: 'member', is_active: true, display_name: email.split('@')[0] })
  return user
}

async function tokenOf(email) {
  const sb = createClient(URL_, ANON)
  const { data, error } = await sb.auth.signInWithPassword({ email, password: PWD })
  if (error) throw new Error(`登录失败 ${email}: ${error.message}`)
  return { token: data.session.access_token, sb, userId: data.user.id }
}

const post = (path, token, body) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

const SECRET = `观音桥暗号${Date.now()}`
const NOTE = `# 测试笔记\n\n我的独家话术是：${SECRET}。这是 A 用户的私人层内容，用于验证三层隔离，长度凑一凑再凑一凑。`

async function main() {
  console.log('1️⃣ 准备测试账号…')
  const a = await ensureUser('mcnai-test-a@example.com')
  await ensureUser('mcnai-test-b@example.com')
  const A = await tokenOf('mcnai-test-a@example.com')
  const B = await tokenOf('mcnai-test-b@example.com')
  check('测试账号就绪', true, `A=${a.id.slice(0, 8)}…`)

  console.log('2️⃣ A 私人层入库…')
  const hash = 'testhash-' + Date.now()
  let r = await post('/api/v1/knowledge/personal/ingest', A.token, {
    content: NOTE,
    filePath: '40_带货/41_脚本库/测试笔记.md',
    contentHash: hash,
  })
  let j = await r.json()
  check('入库成功', r.ok && j.ok, JSON.stringify(j))

  console.log('3️⃣ 哈希去重…')
  r = await post('/api/v1/knowledge/personal/ingest', A.token, {
    content: NOTE,
    filePath: '40_带货/41_脚本库/测试笔记.md',
    contentHash: hash,
  })
  j = await r.json()
  check('同哈希跳过（不重复扣 embedding）', r.ok && j.skipped === true, JSON.stringify(j))

  console.log('4️⃣ A 三层检索…')
  r = await post('/api/v1/knowledge/personal/search', A.token, { query: '独家话术 暗号' })
  j = await r.json()
  const aHit = r.ok && j.matches?.some((m) => m.content.includes(SECRET))
  check('A 命中自己的私人层', !!aHit, `命中 ${j.matches?.length ?? 0} 条`)
  const privHit = j.matches?.find((m) => m.content.includes(SECRET))
  check('命中项标记为 private', privHit?.visibility === 'private', `visibility=${privHit?.visibility}`)

  console.log('5️⃣ B 隔离验证…')
  r = await post('/api/v1/knowledge/personal/search', B.token, { query: '独家话术 暗号' })
  j = await r.json()
  const bLeak = j.matches?.some((m) => m.content.includes(SECRET))
  check('B 看不到 A 的私人层', r.ok && !bLeak, `B 命中 ${j.matches?.length ?? 0} 条（无 A 内容）`)

  console.log('6️⃣ 聊天记录直写（RLS）…')
  const convId = crypto.randomUUID()
  const { error: cErr } = await A.sb.from('conversations').insert({ id: convId, user_id: A.userId, title: 'M4验收对话' })
  const { error: mErr } = await A.sb.from('messages').insert({ conversation_id: convId, role: 'user', content: '验收消息' })
  check('conversations/messages 直写成功', !cErr && !mErr, cErr?.message ?? mErr?.message ?? '')
  const { data: bRead } = await B.sb.from('conversations').select('id').eq('id', convId)
  check('B 读不到 A 的会话（RLS）', !bRead || bRead.length === 0)

  // 清理测试切片与会话
  await admin.from('knowledge_chunks').delete().eq('owner_user_id', A.userId)
  await admin.from('conversations').delete().eq('id', convId)

  const failed = results.filter((x) => !x.ok)
  console.log(`\n=== M4 验收：${results.length - failed.length}/${results.length} 通过 ===`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('验收脚本异常:', e)
  process.exit(1)
})

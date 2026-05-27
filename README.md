# MCN AI（美妆带货 AI 操作台）

面向 MCN / 带货团队的 AI 对话 SaaS：多角色对话、会话管理、管理员后台、审计日志与用量统计。V1.0 基于 Next.js 14 + Supabase + AIHubMix。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Next.js 14 (App Router)、React 18、TypeScript、Tailwind CSS、shadcn/ui |
| 后端 | Next.js Route Handlers (`/app/api/v1/`) |
| 数据库 / 认证 | Supabase (PostgreSQL + Auth + RLS) |
| AI | AIHubMix（OpenAI 兼容 API） |
| 图表 | Recharts |
| 数据获取 | SWR（管理后台） |

## 本地开发

### 1. 克隆与安装

```bash
git clone <your-repo-url> mcn-ai
cd mcn-ai
npm install
```

### 2. 配置环境变量

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`，填入 Supabase 与 AIHubMix 密钥（见下方「环境变量」）。

### 3. 初始化 Supabase

在 [Supabase Dashboard](https://supabase.com/dashboard) → SQL Editor 中依次执行：

1. `supabase/migrations/001_initial_schema.sql`（或 `supabase/RUN_THIS_IN_SUPABASE.sql`）
2. `supabase/migrations/002_system_settings.sql`
3. 若注册报错，执行 `supabase/FIX_HANDLE_NEW_USER_NOW.sql`

### 4. 种子数据（可选）

```bash
npm run seed-roles      # 创建 5 个默认 AI 角色 + Prompt
npm run create-user admin@example.com YourPassword123 super_admin  # 手动创建管理员
```

### 5. 启动开发服务器

```bash
npm run dev
```

访问 [http://localhost:3000](http://localhost:3000)

- 用户端：`/login` → `/chat`
- 管理后台：`/admin`（需 `super_admin` / `org_admin` / `org_editor`）

### 6. 其他常用命令

```bash
npm run build           # 生产构建
npm run lint            # ESLint
npm run verify-models   # 验证 AIHubMix 模型
npm run check-costs     # 统计本月 AI 成本
```

---

## 环境变量

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | 是 | Supabase 项目 URL（Settings → API） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 是 | Supabase anon / publishable key（可暴露给浏览器） |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | Supabase service role / secret key（**仅服务端**，切勿泄露） |
| `AIHUBMIX_API_KEY` | 是 | [AIHubMix](https://aihubmix.com) API Key |
| `ANTHROPIC_API_KEY` | 否 | V2+ 直连 Anthropic 预留 |
| `OPENAI_API_KEY` | 否 | V2+ 直连 OpenAI 预留 |

> 本地开发复制 `.env.local.example` 即可。生产环境在 Vercel 项目 Settings → Environment Variables 中配置相同变量名。

---

## 部署步骤

### A) 推送代码到 GitHub

```bash
# 在项目根目录
git init   # 若尚未初始化
git add .
git commit -m "Initial production-ready release"
git branch -M main
git remote add origin https://github.com/<your-username>/mcn-ai.git
git push -u origin main
```

确保 `.env.local` 未被提交（已在 `.gitignore` 中）。

### B) 在 Vercel 导入项目

1. 登录 [Vercel](https://vercel.com)
2. **Add New → Project**
3. 选择 GitHub 仓库 `mcn-ai`
4. Framework Preset：**Next.js**（自动检测）
5. Root Directory：`.`（默认）
6. Build Command：`npm run build`（默认）
7. 先不要点 Deploy，先配置环境变量（步骤 C）

### C) Vercel 环境变量

在 **Settings → Environment Variables** 中为 **Production**（建议 Preview 也配一份）添加：

| 变量名 | 说明 | 示例来源 |
|--------|------|----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 匿名公钥 | Supabase → Settings → API → anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端密钥 | Supabase → Settings → API → service_role / secret key |
| `AIHUBMIX_API_KEY` | AIHubMix 密钥 | AIHubMix 控制台 |

配置完成后点击 **Deploy**。

### D) Supabase URL Allowlist

部署成功后 Vercel 会分配域名，例如 `https://mcn-ai.vercel.app`。

在 Supabase Dashboard：

1. **Authentication → URL Configuration**
2. **Site URL**：设为生产域名，如 `https://mcn-ai.vercel.app`
3. **Redirect URLs** 添加：
   - `https://mcn-ai.vercel.app/auth/callback`
   - `https://mcn-ai.vercel.app/**`（或按需添加 preview 域名）
4. 若有自定义域名，一并加入上述列表

### E) 部署后验证清单

| 检查项 | 方法 | 预期 |
|--------|------|------|
| 健康检查 | 访问 `https://<域名>/api/v1/health` | `{"status":"ok","version":"1.0.0",...}` |
| 首页 | 访问 `/` | 正常加载 |
| 登录 | `/login` 用管理员账号登录 | 跳转 `/chat` |
| 对话 | 发送一条消息 | 流式 AI 回复 |
| 管理后台 | `/admin` | 仪表盘有数据或空状态正常 |
| 环境变量 | Vercel 部署日志 | 无 `Missing env` / Zod 校验错误 |

本地也可先跑 `npm run build && npm start` 做生产模式冒烟测试。

---

## 运维脚本

| 命令 | 说明 |
|------|------|
| `npm run create-user <email> <password> [role]` | 命令行创建用户（默认 role: `member`） |
| `npm run check-costs` | 统计本月消息 Token 与成本 |
| `npm run seed-roles` | 初始化 5 个默认 AI 角色 |
| `npm run verify-models` | 验证 AIHubMix 模型可用性 |

脚本依赖 `.env.local` 中的 Supabase 与 AI 密钥。

---

## 项目结构（简要）

```
app/
  (auth)/login/          # 登录
  (main)/chat/           # 用户对话
  (admin)/admin/         # 管理后台 8 模块
  api/v1/                # REST + SSE API
components/              # UI 与业务组件
lib/                     # Supabase、AI、事件总线、审计
scripts/                 # 运维脚本
supabase/migrations/     # 数据库迁移 SQL
```

详细架构见 [docs/architecture.md](./docs/architecture.md)。

---

## 常见问题

### 注册 / 登录 500

- 在 Supabase 执行 `supabase/FIX_HANDLE_NEW_USER_NOW.sql` 修复 `handle_new_user` 触发器
- 开发环境可在 Authentication → Providers 关闭 **Confirm email**

### 登录后 `/chat` 无角色

```bash
npm run seed-roles
```

### AI 回复失败

- 检查 `AIHUBMIX_API_KEY` 是否有效：`npm run verify-models`
- 查看 Vercel Function 日志或本地终端报错

### 管理后台 403 / 跳回 `/chat`

用户 `user_profiles.role` 需为 `super_admin`、`org_admin` 或 `org_editor`：

```bash
npm run create-user admin@company.com Passw0rd123 super_admin
```

### `cost_usd` 字段含义

AIHubMix 的 `calculateCost` 返回**人民币**单价，写入 DB 字段名仍为 `cost_usd`。`npm run check-costs` 输出仅供参考，请以管理后台统计为准。

### Vercel 部署后 Auth 回调失败

- 确认 Supabase Redirect URLs 已包含 `https://<vercel-domain>/auth/callback`
- Site URL 与生产域名一致

---

## License

Private — 内部项目

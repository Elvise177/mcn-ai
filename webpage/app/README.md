# app/

Next.js 14 App Router 入口。

## 路由组

| 路径 | 说明 |
|------|------|
| `(auth)/login` | 登录页，Supabase Auth |
| `(main)/chat` | 主对话界面 |
| `(main)/settings` | 用户设置 |
| `(admin)/admin` | 管理后台 |
| `api/v1/*` | 版本化 REST API |

## 约定

- 页面组件默认 Server Component，交互逻辑抽到 `components/`
- API 路由只做请求校验与编排，业务逻辑放 `lib/`

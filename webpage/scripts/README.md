# scripts/

开发与运维脚本（非 Next.js 运行时）。运行前需配置 `.env.local`。

| 脚本 | npm 命令 | 说明 |
|------|----------|------|
| `verify-models.ts` | `npm run verify-models` | 验证 AIHubMix 模型真实性 |
| `create-user.ts` | `npm run create-user <email> <password> [role]` | 命令行创建用户 |
| `check-costs.ts` | `npm run check-costs` | 统计本月 Token / 成本 |
| `seed-roles.ts` | `npm run seed-roles` | 初始化 5 个默认 AI 角色 |

示例：

```bash
npm run create-user ops@company.com 'SecurePass123' org_admin
npm run check-costs
npm run seed-roles
```

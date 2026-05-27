# config/

集中式应用配置。

- `lib/utils/env.ts`：Zod 校验 `process.env`，导出 `env`
- `index.ts`：基于 `env` 组装 `config`（AI、Supabase、limits、features）
- 业务代码**禁止**直接读取 `process.env`，统一使用 `@/config` 或 `@/lib/utils/env`

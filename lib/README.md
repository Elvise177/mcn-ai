# lib/

服务端与客户端共享的核心逻辑，**不**放 React 组件。

## 子目录

| 目录 | 用途 |
|------|------|
| `ai/` | AI Provider 抽象、Prompt 模板 |
| `supabase/` | 数据库与认证客户端 |
| `events/` | 事件总线（`bus.ts`）与 handler 注册（`register.ts`） |
| `usage/` | 按日使用量统计（`tracker.ts`） |
| `utils/` | 通用工具（`cn`、`env` 校验等） |
| `audit/` | 审计日志（`logger.ts`） |

## 约定

- 新增 AI Provider 时实现 `ai/providers/base.ts` 中的接口
- 敏感操作通过 `eventBus.emit` 触发，由 `register.ts` 写入 `audit_logs`

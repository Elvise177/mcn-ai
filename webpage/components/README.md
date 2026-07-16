# components/

可复用 UI 与业务组件。

## 子目录

| 目录 | 用途 |
|------|------|
| `ui/` | shadcn/ui 基础组件（Button、Dialog 等） |
| `chat/` | 对话列表、消息气泡、输入框 |
| `admin/` | 管理后台专用组件 |
| `shared/` | 跨模块共享（Header、Loading 等） |

## 约定

- `ui/` 仅放 shadcn 生成/维护的组件，不混入业务逻辑
- 业务组件通过 `@/components/ui` 引用基础组件

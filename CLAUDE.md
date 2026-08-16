# mcn-ai 仓库通用规则

## 必读

- 接手任何任务前，先读 `docs/HANDOFF.md`：项目全貌、已知 bug、技术决策都在里面

## 仓库结构（monorepo）

- `webpage/` — Next.js 网页版（聊天 + 知识库 API 的宿主，桌面版云端接口在这）
- `desktop/` — Electron 桌面版（开发与验收规则见 `desktop/CLAUDE.md`，改 GUI 必须遵守）
- `supabase/` — 数据库 migrations
- `worker/` — 视频线 worker（未开工，勿动）

## 禁令

- 禁止触碰 `~/Documents/AI/omg-dingtalk-automation`（独立交付项目，不属于本仓库）
- Electron 版本锁死 **30.5.1**：任何依赖升级（含根目录 npm update / lockfile 变动）都不得连带升级它。原因：macOS XProtect 误杀 31+，开发者签名公证完成前不解锁
- 钉钉自动化相关代码（webpage/app/api/v1/automation/dingtalk、vercel.json 的 crons）
  涉及 OMG 客户在线业务，任何改动必须先向我确认，不得顺手清理

## 约定

- 产物统一写 `vault/90_产物/<日期>_<名称>/`
- 大任务收尾时更新 `docs/HANDOFF.md`（进度、bug 清单、新决策）


# mcn-ai

面向 MCN 公司与个体达人的 AI 工作操作系统。双形态：桌面客户端（本地能力）+ 网页版（获客与管理）。

## 目录结构

```
mcn-ai/
├── webpage/            # 网页版：Next.js + Supabase（现有 SaaS，部署 Vercel）
├── desktop/            # 桌面版：Tauri + Claude Agent SDK（规划中，见 desktop/README.md）
├── supabase/           # 共享：数据库迁移（两端同一套 Supabase）
├── worker/             # 共享：剪辑任务 worker（部署国内服务器，对接 VectCutAPI）
├── docs/               # 架构文档
└── project-document/   # 历史产品文档（docx）
```

## 开发

```bash
# 网页版
cd webpage && npm run dev
```

⚠️ Vercel 部署注意：仓库改为 monorepo 后，Vercel 项目设置里 **Root Directory 必须改为 `webpage`**，否则部署失败。

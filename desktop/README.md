# mcn-ai Desktop（桌面版）

面向 MCN 公司与个体达人的 AI 工作操作系统 · 桌面客户端。

产品文档见 `~/Desktop/mcn-ai产品文档-v2.docx`（评审版）与 vault 内《mcn-ai桌面软件产品规划》。

## 架构（Electron，2026-07-16 开工）

```
desktop/
├── src/main/        # 主进程：agent(SDK)/vault(md库)/inbox(投递箱编排)/ai(平移)/auth/store
├── src/preload/     # contextBridge——唯一 IPC 边界，渲染进程零 Node 能力
├── src/renderer/    # React 前端：对话工作台(默认) / 个人知识库 / 设置
└── resources/       # extraResources：pipeline(PyInstaller 冻结产物) + skills
```

开发：`npm run dev`　类型检查：`npm run typecheck`　打包：`npm run dist`
Agent SDK 冒烟：`ANTHROPIC_AUTH_TOKEN=<key> npm run smoke:agent`

完整实施计划：`~/Desktop/mcn-ai开发计划-v1.docx`（M0 骨架 → M1 知识库 → M2 投递箱 → M3 工作台 → M4 云端）

## 关键决策（2026-07 已定）

- 桌面壳 = **Electron**（Agent SDK 是 Node 库，主进程直跑，无 sidecar 打包坑）
- 底层引擎 = **Claude Agent SDK**（Claude Code 库形态），MVP 直连中转站 api.inferera.com（网关 P1）
- 首发仅 macOS（arm64）
- 默认首页 = 对话工作台（问库 + 文档生成合并，产物面板类 Artifacts）
- UI 借鉴 Claude Desktop：暖米白 + 浅色侧栏，玫瑰粉点缀
- 个人库 = 本地 markdown 文件夹，Obsidian 格式兼容；知识库不设私人区
- 云端沿用根目录 `supabase/`（三层 RAG，迁移 010）与 `worker/`（剪辑队列）

## MVP 里程碑

1. 迁移 010 执行（Supabase SQL Editor）
2. Tauri 壳 + 建库向导
3. pkb-pipeline 移植为内置引擎
4. 对话工作台（Agent SDK 接入）
5. 0 号用户实测两周 → 学员内测

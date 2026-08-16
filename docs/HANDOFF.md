# mcn-ai 产品交接文档（HANDOFF）

> 更新：2026-08-16 ｜ 范围：mcn-ai 产品线（桌面版 + 云端），不含 OMG 钉钉自动化定制项目（那是独立仓库 `~/Documents/AI/omg-dingtalk-automation`，有自己的 README 和交付文档）
> 当前阶段：MVP（M0–M4）全部完成并交付 0 号用户实测；下一步是与大头（Maggie）对接正式 AI 需求

---

## 1. 项目架构与技术栈

### 总体形态

```
Electron App（macOS arm64，v0.1.0）
├ 渲染进程：React 18 + TypeScript + Tailwind（Claude Desktop 风暖米白主题）
│   三大界面：对话工作台（默认）｜ 个人知识库（含投递箱二级入口）｜ 设置
├ preload/contextBridge = 唯一 IPC 边界（渲染进程零 Node 能力）
│   请求响应：ipcMain.handle（vault:* / inbox:* / auth:* …）
│   流式下行：webContents.send（agent:stream:{id} / inbox:progress / artifact:created）
└ 主进程（Node）
    ├ agent/      Claude Agent SDK：query() 会话管理（resume 多轮/abort），流式转 IPC
    ├ vault/      本地 md 库：fast-glob 扫描 + gray-matter frontmatter + chokidar 增量
    │             + 双链/标签正则 → 内存索引 → 关系图（react-force-graph-2d, canvas）
    ├ inbox/      投递箱编排：chokidar(awaitWriteFinish 2s) → p-queue(并发1)
    │             → spawn 冻结版 pipeline → 按行解析 JSON 进度 → .done/.failed
    ├ ai/         从 webpage/lib/ai 平移的 provider 层（去 server-only，配置注入）
    ├ knowledge/  云端私人知识层 ingest/search 的 fetch 客户端
    └ auth/       supabase-js signInWithPassword + safeStorage 加密存 session

本地数据：原文件 + md 100% 本地（Obsidian 兼容 vault，0号用户 vault = ~/Documents/MyBrain）
云端数据：Supabase（pgvector 知识切片/向量 + conversations/messages 聊天记录）
```

### 技术栈清单

| 层 | 选型 | 备注 |
|---|---|---|
| 壳 | Electron **30.5.1（锁死）** + electron-vite + electron-builder | 见决策 §4-2，勿升级到 31+ |
| 前端 | React 18 / TypeScript / Tailwind | 聊天组件从 webpage 直搬 |
| Agent | Claude Agent SDK（主进程直跑） | `ELECTRON_RUN_AS_NODE=1` + `options.executable=process.execPath` + SDK asarUnpack |
| LLM 接入 | 中转站 api.inferera.com（`ANTHROPIC_BASE_URL`），key 用 safeStorage 加密存储 | 网关是 P1，见 §4-3 |
| 知识入库 pipeline | Python（pkb-pipeline 仓库），PyInstaller **onedir** 冻结，随 app 分发于 resources/pipeline | cli.py：`mcn-ingest --file --vault --layout --llm-key`，串联 02→09→03→07→04 |
| 云端 | Supabase：Auth + Postgres + pgvector + RLS | 项目 id：`yqozqfrmdddmfrpavrsn`（免费版，有暂停坑，见 §3-2） |
| 向量 | text-embedding-3-small | 成本敏感选型 |
| 本地检索 | minisearch（占位） | 语义检索已切云端 search，接口不变 |
| 产物生成 | skills：make-ppt（移植 make-ppt-v2 快速模式）+ make-docx；对话内另有 Word/Excel/PDF 生成工具 | 产物统一写 `vault/90_产物/<日期>_<名称>/` |

### 云端接线（M4 落定的架构）

- 私人知识层**不直调 Supabase RPC**，走 webpage 的 API：`webpage/app/api/v1/knowledge/personal/{ingest,search}/route.ts`，`Authorization: Bearer <supabase access_token>` → 服务端 `admin.auth.getUser(token)` 拿可信 user_id → 复用 `ingestKnowledge/searchKnowledge`（layers=['platform','org','private']）
- 迁移 010（personal knowledge 层）+ 011（knowledge_chunks 加 file_path/content_hash，去重=同 owner+file_path 先删后插）均已执行
- 聊天记录：主进程 authenticated supabase-js 直写 conversations/messages（RLS 已配），失败进 electron-store 队列重试；本地 SQLite 是 v2 计划
- 桌面登录与网页版同账号，会话在网页版列表可见

---

## 2. 已完成的功能（M0–M4 + 增补，全部验收过）

1. **M0 骨架**：dmg 安装（arm64，ad-hoc 签名）、三栏壳、设置页 key 加密保存重启不丢；Agent SDK 打包冒烟通过
2. **M1 知识库**：建库向导两分支（指向已有 Obsidian vault / 模板新建 + `vault/.mcnai/layout.json`）；文件树 + md 预览（react-markdown + wiki-link，frontmatter 属性卡片）+ 关系图谱（点击跳文件）+ minisearch 全文检索；Obsidian 同时编辑 2 秒内刷新
3. **M2 投递箱**：拖文件/丢 `00_投递箱/` → 队列串行处理 → md 落位 + MOC 更新 + 图谱新节点；文件×五阶段进度条；失败进 `.failed/` 可重试不静默丢件；批量初始化导入与增量同队列；**分区投递**（拖入窗口按投递线分区：业务线+动态分流线，e2e 已覆盖）；投递箱分流规则可在设置页自助管理
4. **M3 对话工作台**：问库带引用（search_knowledge 工具，云端语义检索）；make-ppt/make-docx skills（"把X做成PPT"→产物面板出卡片→Keynote 打开）；可停止；多会话不串台；产物面板监听 90_产物
5. **M4 云端**：登录（网页同账号）、私人层入库/检索（RLS 隔离验证过：admin 可见、他人不可见）、聊天记录云端同步；投递编排追加"上云"第 6 阶段
6. **增补**：对话内 Word/Excel/PDF 生成工具；知识入库设置（产物自动入库开关 + 产物卡片入库按钮）；经营数据自动入库（同步默认关闭）
7. **验收基线**：Maggie vault 全量数据「批量导入→问库→生成PPT→回看产物」闭环通过；e2e 走查脚本 `desktop/e2e/walkthrough.mjs` + 截图基线 `desktop/e2e/shots/`（GUI 改动必须跑走查看截图再交付——用户铁律）

---

## 3. 已知 bug 与未解决问题

### bug（按优先级）

1. **无离线降级（P0，2026-08-16 实测踩坑）**：云端（Supabase）连不上时，应用启动卡在登录/会话恢复，窗口不出现，体感"打不开"。正确行为：照常开窗 + 本地功能（知识库/投递箱）可用 + 顶部"云端离线"提示。auth 启动链路在 `desktop/src/main/auth/index.ts`
2. **Supabase 免费版 7 天闲置自动暂停**：暂停后项目域名直接 NXDOMAIN（连 DNS 都没了），叠加 bug#1 = 应用完全打不开。恢复：Dashboard → Restore project（域名先回、服务后起，全程约 5-15 分钟，中途 Cloudflare 521 属正常）。**防复发方案已议未做**：阿里云服务器加每日保活 cron（或升 Pro $25/月）——待用户拍板
3. **supabase-js 的 Node 20 弃用警告**：启动时打 deprecation warning。根因是 Electron 30 内置 Node 20，而 Electron 版本被 XProtect 问题锁死（见 §4-2），升级链条：拿到开发者签名 → 升 Electron → 消除此警告。短期无害

### 未解决/未做（按计划属 P1+）

- **网关**：MVP 直连中转站，客户端 key 理论可提取（缓解：低配额专用 key + 用量告警；根治=P1 网关）
- **开发者签名/公证**：现为 ad-hoc 签名，0 号用户右键打开绕 Gatekeeper；扩散前必须买 Apple Developer ID（同时解锁 Electron 升级）
- **Windows 版**：未做（首发 macOS-only 是拍板项）
- **本地 SQLite 聊天库**：v2；当前聊天记录只在云端
- **仓库卫生**：`desktop/` 有一批未提交的工作区改动（vault/index.ts、reader.ts、VaultPage.tsx、e2e 截图等，属分区投递之后的迭代），接手先 `git status` 看一眼，该提交提交
- **client.ts 死代码**：`webpage/lib/automation/dingtalk/client.ts` 现在只有 `listRecords` 有调用方（vault-notes），`listSheets/insertRecords/updateRecords/deleteRecords/sendGroupMessage` 全部无人调用（钉钉剥离的遗留，见 §4-13）。留着无害，后续收拾
- **客户机兼容预检**：发新客户前用 yara 本机预检 Electron 是否会被 XProtect 误杀；老 macOS 的 pyexpat 坑已用 lxml 修掉（docx2md），但同类"编译目标过新"问题在 pipeline 其他依赖上仍可能出现

---

## 4. 重要技术决策及原因

1. **Electron 而非 Tauri**：Claude Agent SDK 是 Node 库，Electron 主进程可直跑，Tauri 需要额外进程桥接。Agent SDK 打包冒烟是 M0 第一天做的（风险前置）
2. **Electron 锁 30.5.1**：macOS XProtect 会误杀 Electron 31+ 的应用（客户机实测），降到 30 规避。**根治路径 = 买开发者签名做公证**，在那之前不升级。连带效应：内置 Node 停在 20（见 bug#3）
3. **MVP 直连 inferera 中转站，网关放 P1**：快速验证优先（用户核心决策哲学），key 泄漏风险用低配额 key + safeStorage 缓解
4. **私人知识层走 webpage API 而非客户端直调 RPC**：RPC 是 security definer，`p_user_id` 必须由服务端从 Bearer token 解出才可信；embedding key 也不能下发客户端。这是 M4 的安全边界设计
5. **pipeline 用 PyInstaller onedir（非 onefile）冻结**：onefile 启动解压慢且易触发杀软；PDF/xlsx/pptx 三条转换路径先冒烟再集成；07/08 脚本的目录写死改为读 layout.json 参数化（默认=Maggie 结构保回归）
6. **docx 解析用 lxml 替代标准库**：pyexpat 编译目标 macOS 15，客户机系统更旧直接崩；lxml 自带解析器绕开系统 expat
7. **session 存 safeStorage 而非 keytar**：少一个原生依赖，Electron 自带够用
8. **产物统一落 `vault/90_产物/`**：产物即笔记，天然进 vault 被图谱和检索覆盖；产物面板靠 watcher 监听该目录
9. **IPC 一次定死**：请求响应与流式下行两类通道在 M0 就冻结命名，后续里程碑零返工
10. **视频线选型（未开工，已拍板）**：剪映草稿 + VectCutAPI；worker 部署国内服务器
11. **嵌入模型 text-embedding-3-small**：成本敏感（用户明确要求），效果对个人知识库够用
12. **聊天组件直搬 webpage**：ChatMain/ChatInput/MessageBubble/RoleSelector 零耦合平移，状态机提炼为 `useChatSession.ts`（SSE fetch 换 IPC 订阅，乐观更新/AbortController 保留）
13. **钉钉自动化 webpage 侧剥离收尾（2026-08-16 完成）**：钉钉每日同步 2026-07-24 已分叉到独立仓库 `~/Documents/AI/omg-dingtalk-automation`（国内服务器 crontab：`run.js` 每日 03:00 ＋ `hourly.js` 每小时，已确认在跑、run.log 到 8/16 每日成功），并持续演进到"任务驱动"新口径。webpage 侧那份停在 07-20 的占位实现和 Vercel Cron 一直没摘，会在同一时间点按旧口径往同一张「执行明细」表建行 → 已删除 `app/api/v1/automation/dingtalk/route.ts` 与 `lib/automation/dingtalk/sync.ts`、清空 `vercel.json` 的 crons（commit a477591）。**保留** `dingtalk/vault-notes/route.ts` 和 `lib/automation/dingtalk/client.ts`——桌面端经营数据自动入库（`desktop/src/main/knowledge/bizdata.ts`）在用，别顺手删。独立仓库本身按禁令未触碰

---

## 5. 文件结构说明

### 仓库总览（monorepo：`~/Documents/AI/mcn-ai`）

```
mcn-ai/
├ webpage/     Next.js 网页版（聊天 + 知识库 API 的宿主）
│   ├ lib/ai/                    provider 层（桌面版 ai/ 的源头）
│   ├ lib/knowledge/{ingest,search}.ts   切片/嵌入/检索核心（M4 API 复用它）
│   └ app/api/v1/knowledge/personal/     桌面版云端接口（Bearer 鉴权）
├ desktop/     Electron 桌面版（本文档主角）
├ supabase/    migrations/（010=私人层，011=file_path/content_hash 去重）
└ worker/      视频线 worker（未开工）
```

### desktop/ 内部

```
desktop/
├ src/
│   ├ main/            主进程
│   │   ├ agent/       Agent SDK 会话管理、流式转发
│   │   ├ vault/       index.ts(索引) reader.ts(扫描/解析) watcher graph
│   │   ├ inbox/       orchestrator（队列/进度/落位/分区投递）
│   │   ├ ai/          provider（从 webpage 平移）
│   │   ├ knowledge/   云端 ingest/search 客户端
│   │   └ auth/        index.ts（supabase-js、anon key 三级来源：env > electron-store > 内置默认）
│   ├ preload/         contextBridge：全部 IPC 通道定义
│   └ renderer/src/
│       ├ pages/       VaultPage / 对话 / 设置
│       ├ components/  聊天四组件（直搬）+ 产物面板 + 图谱
│       └ hooks/useChatSession.ts   聊天状态机
├ resources/
│   ├ pipeline/        PyInstaller 冻结的 mcn-ingest（extraResources 分发）
│   └ skills/          make-ppt / make-docx
├ e2e/
│   ├ walkthrough.mjs  E2E 走查脚本（改 GUI 必跑）
│   └ shots/           截图基线（中文命名，按流程编号）
├ release/             构建产物（dmg/zip；「已重签」dmg 是 ad-hoc 重签版）
├ scripts/             构建辅助
└ electron-builder.yml / electron.vite.config.ts
```

### 相关外部路径

| 路径 | 用途 |
|---|---|
| `~/Documents/MyBrain` | 0 号用户（Maggie/大头）的 Obsidian vault，验收基准数据 |
| `~/Documents/AI/pkb-pipeline` | Python 入库 pipeline 源仓库（02_convert.py 是冻结风险核心） |
| `~/Documents/AI/omg-dingtalk-automation` | 钉钉定制项目（独立业务线，勿混入产品仓库） |
| `~/Desktop/mcn-ai产品文档-v2.docx`、`mcn-ai开发计划-v1.docx` | 产品定稿与实施计划 |
| `/Applications/mcn-ai.app` | 已安装的 0.1.0；用户数据在 `~/Library/Application Support/mcn-ai-desktop` |

---

## 接手人第一天检查清单

1. `cd desktop && git status`——处理未提交的工作区改动
2. 确认 Supabase 项目未暂停（打不开 app 先怀疑这个：`nslookup yqozqfrmdddmfrpavrsn.supabase.co`，NXDOMAIN=被暂停了，去 Dashboard Restore）；顺手把保活 cron 的决策落掉
3. 改任何 GUI 前先跑 `e2e/walkthrough.mjs` 建立基线，改完再跑对比截图——这是用户的验收铁律，未验证的交付零容忍
4. 第一个该修的东西：离线降级（bug#1），入口在 `src/main/auth/index.ts` 的启动链路
5. 下一阶段需求由大头（Maggie）对接，她是 0 号用户兼客户方 AI 需求负责人

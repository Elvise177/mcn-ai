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
│   请求响应：ipcMain.handle（vault:* / inbox:* / auth:* / tasks:list …）
│   流式下行：webContents.send（agent:stream / task:event / vault:changed / artifact:created）
└ 主进程（Node）
    ├ agent/      Claude Agent SDK：query() 会话管理（resume 多轮/abort），流式转 IPC
    ├ vault/      本地 md 库：fast-glob 扫描 + gray-matter frontmatter + chokidar 增量
    │             + 双链/标签正则 → 内存索引 → 关系图（react-force-graph-2d, canvas）
    ├ inbox/      投递箱编排：chokidar(awaitWriteFinish 2s) → p-queue(并发1)
    │             → spawn 冻结版 pipeline → 按行解析 JSON 进度 → .done/.failed
    ├ ai/         provider 层：线路（中转站/DeepSeek官方/自定义）+ 模型显式下发
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
| LLM 接入 | provider 层三选一（`src/main/ai/provider.ts`）：inferera 中转站 ／ DeepSeek 官方 Anthropic 兼容端点 ／ 自定义 base URL；主模型 `deepseek-v4-pro`、轻量 `deepseek-v4-flash` **显式下发** | 见 §4-17；key 用 safeStorage 加密存储（读写规则见 §4-18），网关是 P1（§4-3） |
| 知识入库 pipeline | Python（pkb-pipeline 仓库），PyInstaller **onedir** 冻结，随 app 分发于 resources/pipeline | cli.py：`mcn-ingest --file --vault --layout --llm-key`，串联 02→09→03→07→04 |
| 云端 | Supabase：Auth + Postgres + pgvector + RLS | 项目 id：`yqozqfrmdddmfrpavrsn`（免费版，有暂停坑，见 §3-2） |
| 向量 | text-embedding-3-small | 成本敏感选型 |
| 本地检索 | minisearch（占位） | 语义检索已切云端 search，接口不变 |
| 产物生成 | skills：make-ppt（移植 make-ppt-v2 快速模式）+ make-docx；对话内另有 Word/Excel/PDF 生成工具 | 产物统一写 `vault/90_产物/<日期>_<名称>/` |

### 云端接线（M4 落定的架构）

- 私人知识层**不直调 Supabase RPC**，走 webpage 的 API：`webpage/app/api/v1/knowledge/personal/{ingest,search}/route.ts`，`Authorization: Bearer <supabase access_token>` → 服务端 `admin.auth.getUser(token)` 拿可信 user_id → 复用 `ingestKnowledge/searchKnowledge`（layers=['platform','org','private']）
- 迁移 010（personal knowledge 层）+ 011（knowledge_chunks 加 file_path/content_hash，去重=同 owner+file_path 先删后插）均已执行
- 聊天记录：主进程 authenticated supabase-js 直写 conversations/messages（RLS 已配）。**同步失败当前是静默丢弃**（`knowledge/client.ts` 的 `syncConversation` 整个 try 包空 catch，本地 electron-store 是权威副本，云端那份就少了这次）；**一期已把失败落进 `tasks.json` 的 `syncQueue`（退避 1m/5m/30m→转手动）、条数上全局条，但真正的重试定时器仍在二期**（本地 SQLite 聊天库另属 v2）。UX 审计 M-03 记的就是这条
- 桌面登录与网页版同账号，会话在网页版列表可见

---

## 2. 已完成的功能（M0–M4 + 增补，全部验收过）

1. **M0 骨架**：dmg 安装（arm64，ad-hoc 签名）、三栏壳、设置页 key 加密保存重启不丢；Agent SDK 打包冒烟通过
2. **M1 知识库**：建库向导两分支（指向已有 Obsidian vault / 模板新建 + `vault/.mcnai/layout.json`）；文件树 + md 预览（react-markdown + wiki-link，frontmatter 属性卡片）+ 关系图谱（点击跳文件）+ minisearch 全文检索；Obsidian 同时编辑 2 秒内刷新
3. **M2 投递箱**：拖文件/丢 `00_投递箱/` → 队列串行处理 → md 落位 + MOC 更新 + 图谱新节点；文件×五阶段进度条；失败进 `.failed/` 可重试不静默丢件；批量初始化导入与增量同队列；**分区投递**（拖入窗口按投递线分区：业务线+动态分流线，e2e 已覆盖）；投递箱分流规则可在设置页自助管理
4. **M3 对话工作台**：问库带引用（search_knowledge 工具，云端语义检索）；make-ppt/make-docx skills（"把X做成PPT"→产物面板出卡片→Keynote 打开）；可停止；多会话不串台；产物面板监听 90_产物
5. **M4 云端**：登录（网页同账号）、私人层入库/检索（RLS 隔离验证过：admin 可见、他人不可见）、聊天记录云端同步；投递编排追加"上云"第 6 阶段
6. **增补**：对话内 Word/Excel/PDF 生成工具；知识入库设置（产物自动入库开关 + 产物卡片入库按钮）；经营数据自动入库（同步默认关闭）
7. **渲染层视觉重构（2026-08-16）**：只动样式/文案/渲染层组件，未碰业务逻辑、IPC、主进程。十项改动：问候语去用户 ID（昵称在设置页填，存 localStorage）＋侧栏身份行改「昵称/邮箱 · 版本号」；主色降级（粉色只留发送键/光标/选中态，新对话改描边、登录键改深色实心）；字体统一系统黑体栈+行高 1.65，衬线只留首页问候语（拉丁字体排最前，数字英文不落衬线）；侧栏导航加 lucide 图标+8px 圆角 hover，「最近对话」分组标题降级；问候区上移到 `--home-top`(22vh)＋输入框下方「最近产物/最近对话」卡片区（各最多 6，无数据不出现）；输入框 14px 圆角/60px 高/左侧附件占位；chips 抽到 `config/chips.ts`（为任务模板系统留位）；知识库空态引导「拖入你的第一份资料试试」＋指向投递箱入口；产物卡片重做（文件类型分色图标、hover 出打开/入库、`source_draft_id` 占位注释「v2 产物回流用」）；等待态巡检（流式光标、投递箱六阶段进度条+日志自动滚底+跑完面板不再瞬间消失、页面切换淡入、`cloud_sync` 中文化）。design tokens 全部集中在 `desktop/src/renderer/src/styles/theme.css`，Tailwind 只做语义类名映射，canvas 取色走 `src/renderer/src/theme.ts`，组件里已无硬编码色值
8. **视觉重构第二轮（2026-08-16 用户验收后返工）**：截图基线清理（删掉 7 月残留，走查收尾会列出「本次未刷新」的 png 报警；`00b/11/12` 归 login-provision.mjs，脚本里有归属表）；走查统一注入 `prefers-reduced-motion:reduce`（此前截图糊在淡入中间帧，看着像对比度坏了）；建库两张卡片改中性同款、hover 才高亮；笔记头部只留「编辑」，重命名/删除进 ··· 菜单，删除二次确认弹窗显示文件路径 + 删除后 toast 提示可在废纸篓找回；搜索摘要在 search-worker 里做纯文本清洗（跳过 frontmatter、剥双链括号/表格竖线与分隔行）；首页产物面板默认收起（与「最近产物」卡片区去重），仅对话中产生新产物才自动展开；笔记空值渲染（frontmatter 与正文空字段给「—」，只有表头的表格折叠成「暂无数据（列名…）」）；分区投递两个区静态同款，只有文件悬停在哪个区才高亮那个区；登录门「暂不登录」与建库「暂时跳过」改成可识别的按钮/链接样式
9. **UI 精修第二轮（2026-08-16，只动样式层）**：① 关系图配色融入主题——节点色换成以主玫瑰为起点的暖调谱系（玫瑰/陶土橙/赭黄/暖棕/灰绿/藕紫/砖红），边线换低饱和暖灰，取色仍走 `theme.ts` 读 CSS 变量；② 右侧产物面板卡片减重为无框列表项（图标+文件名+时间一行，hover 才出「打开/入库/预览」），与首页「最近产物」同一种轻量观感；③ 知识库三栏：文件树默认宽 288→220px，栏与栏之间加可拖拽分隔线（5px 命中区/1px 视觉线），宽度记忆到 localStorage `vault.treeWidth` / `vault.graphWidth`；④ 文件树顶部整理：搜索框独占一行，下一行「N 篇」居左、投递箱/新建/图谱/换库居右（按钮加了 title，e2e 用 `button[title="新建笔记"]` 选中，「＋新建」文案改「新建」）；⑤ markdown 表格与卡片风格统一：圆角外框（`border-collapse: separate` + `width: max-content` 贴列收边）、表头暖灰底 `--color-table-head`（笔记属性卡片的键列共用它）、行 hover 微高亮；⑥ 首页问候语 34→38px。**踩坑记录**：`font-weight: 500` 对中文衬线（Songti SC / Noto Serif SC）完全无效——无 medium 字面、系统也不合成，只有拉丁昵称吃得到，问候语"轻飘"只能靠字号解决（探针验证过 400/500/600 三档中文字形完全一致）
10. **UX 审计 P0 修复批次（2026-08-16，见 `docs/UX-AUDIT.md` 的 H-01~H-06）**：① **H-01 拖文件炸应用**——主进程 `will-navigate` 拦截（同 URL 放行，不挡 reload）＋ `main.tsx` 全局 `dragover/drop` preventDefault，工作台页拖入改走 `inbox.enqueue`（与知识库页同一条链路）并给「松手即入库」覆盖层；② **H-02 换库回不去**——`VaultPage` 加 `switching` 态（原库留在 state，主进程 currentRoot 本来就没变），向导传 `onSkip` + `skipLabel="返回当前库"`，换库前二次确认并显示当前库路径；③ **H-03 对话删除**——`ui.confirm`（带对话标题）+ 删除后 toast，与笔记删除对齐；④ **H-04 未保存丢改动**——`dirty` 从 `NoteView` 提到 `Explorer`（`NoteView` 是 `key={current}` 挂载的，换笔记就整个销毁），`openNote`/关笔记/换库前统一走 `confirmDiscard()`；⑤ **H-05 保存静默**——`save()` 加 try/catch，成功轻 toast、失败保留编辑态与草稿；⑥ **H-06 key 下发失败=死路**——设置页 AI 卡片补手填 API Key 输入框（复用 `settings.setKey`，safeStorage 存）＋「重新获取服务端配置」按钮（新 IPC `auth:provision` / `auth:provisionError` / `auth:provision-failed` 事件），`provisionKeys` 不再静默 catch。**踩坑记录**：macOS 上 `safeStorage.encryptString` 会阻塞主进程好几秒（实测 ~6s，走查里 Playwright 的 click 因此超时——主进程一卡 CDP 也跟着停），所以手填 key 的保存按钮必须有忙态，e2e 里这一步也单独放宽超时；`login-provision.mjs` 原来固定等 4s 判断 key 是否下发，同样因为这个改成了轮询。**（这条踩坑的结论在 2026-08-16 被推翻并修掉了：贵的不是 encryptString，而是进程内对 safeStorage 的第一次调用，读也一样贵——见下面第 12 条与 §4-18；走查里那个 10 分钟超时已经改回 20s）**
11. **全局任务状态层 · 一期（2026-08-16，设计见 `docs/DESIGN-task-state.md`）**：把「跨越时间的操作」的状态从渲染层搬到主进程，渲染层退化成纯投影。新增 `src/main/tasks/{types,registry,persist}.ts`（Task=有终态的任务：inbox/agent/ingest/sync；Condition=没有终态的云端状况）＋ 统一推送通道 `task:event` ＋ 权威快照 `tasks:list`；渲染层 `hooks/useTasks.ts` 用 `useSyncExternalStore`（React 18 内置，未引入状态库）在 App 层订阅一次，`components/TaskDock.tsx` 侧栏底部全局条 ＋ `components/OfflineBar.tsx` 云端离线条。**解决**：H-07（投递跑着切页面看得见）、H-08（切回来运行态不丢）、产物入库三态（未入库/入库中/已入库✓，已入库落盘、可点开落位笔记）、M-03 可见性（同步失败进 `syncQueue`，退避 1m/5m/30m→转手动，条数上全局条）、bug#1（云端连不上照常开窗＋顶部降级说明条）、H-10 的"看得见在跑"部分（agent draft 上移主进程，切走再切回半截正文接得上）。
    **一期的边界**：只上报不改行为——不含取消、H-09 停止留半截、H-10 主进程拒绝重复发送、M-27 冲突检测、M-01 登录超时、syncQueue 真重试，这些是二期。legacy `inbox:event`/`inbox:lastRun` 一期继续转发（只增不减，新 UI 出问题旧路径仍可用），二期删。
    **关键约定**（改这层前必读）：① 主进程 registry 是唯一真相源，页面组件不得自己 setState 维护任务态，唯一例外是 Workbench 的逐字 draft 允许本地累积但每次挂载先用 `task.draft` 做基线；② **「进行中」永不落盘**，落盘的只有终态结果与待办队列（`tasks.json` 三张表），否则重启后必然出现永不结束的幽灵任务；③ push 尽力而为、snapshot 才是权威——`webContents.send` 在窗口 reload 期间会静默丢事件，所以渲染层每次挂载都先 `tasks:list` 打底，`seq` 用来丢弃迟到事件；④ 高频 delta 不进 `task:event`，仍走 `agent:stream`，任务里的 draft 每 500ms 节流推一次
    **踩坑记录**：① 「已入库」要指向落位笔记，**不能按原文件名 `resolveLink` 去猜**——开了智能打标时 pipeline 会按内容给笔记重新命名，按文件名找必然扑空（本地模式没 LLM key 走 `--skip-llm` 不改名，所以只有 `E2E_CHAT=1` 那轮才暴露出来）。现在改成"入库前拍一次笔记全集快照、跑完做差集"，名字对得上的优先、本批只有一个产物且只新增一篇时就认那篇；② TaskDock 的进度条一开始复用了 `.inbox-bar-fill` 类名，导致走查里 `.inbox-bar-fill` 同时命中两根条、strict mode 直接报错——全局条改用 `.task-bar-fill`，`.inbox-bar-fill` 仍然只指投递箱面板那一根；③ 两轮 pipeline 之间有 3 秒去抖窗口，那一刻确实没有活跃任务、Dock 本就该收起，所以走查里凡是断言 Dock 的地方都必须轮询而不是采样一次
12. **模型 provider 解耦 + M-29 密钥链路健康化（2026-08-16）**：对话链路的地址/模型/key 全部收口到 `src/main/ai/provider.ts`，设置页「模型线路」卡片可在 **inferera 中转站 ／ DeepSeek 官方（`https://api.deepseek.com/anthropic`）／ 自定义 base URL**（为 Kimi/智谱留口）之间切换，base URL 与主模型/轻量模型都显式可见可改；`agentEnv()` 会先把继承来的 `ANTHROPIC_*` 清空再注入本次的 `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL/SMALL_FAST_MODEL`（否则开发机自己的环境变量会串进子进程）。同一单里把 M-29 做掉：密钥读写收口到 `src/main/secrets.ts`，**写前指纹判重（零 Keychain 触碰）＋ 只读不解密 ＋ 写入转 `kind:'secret'` 后台任务**，登录页/设置页给等待态文案。两个 provider 的行为差异见 §4-17，M-29 的实测数据与方案取舍见 §4-18 和 `docs/UX-AUDIT.md` 的 M-29 条目。同一单里还顺手把 make-ppt 耗光轮次的老毛病修了（系统提示词第 7 条「检索最多 3 次」＋ `maxTurns` 30→40，见 §3 bug#3）。**冒烟**：`npm run smoke:provider`（覆盖单轮/多轮 resume/abort/工具调用/流式/make-ppt 六项，逐 provider 跑）
13. **验收基线**：Maggie vault 全量数据「批量导入→问库→生成PPT→回看产物」闭环通过；e2e 走查脚本 `desktop/e2e/walkthrough.mjs` + 截图基线 `desktop/e2e/shots/`（GUI 改动必须跑走查看截图再交付——用户铁律）。2026-08-16 新增走查步骤：空库引导（独立空库实例）＋首页卡片区＋chips 填充＋输入框 60px/附件位＋流式光标（E2E_CHAT=1 真实流式时截行尾光标）＋投递箱六阶段进度条＋产物卡片 hover/打开/入库/预览＋最近对话卡片点开＋建库卡片 hover＋笔记 ··· 菜单/删除二次确认/新建→删除全链路＋搜索摘要洁净度＋空值与空表格＋分区投递静态同款与悬停高亮＋首页产物面板默认收起；UI 精修第二轮再加：文件树默认宽 220 断言＋三栏分隔线真拖（tree +90 / graph +80，断言宽度变化与 localStorage 落盘，重载后复查记忆）＋关系图配色特写（扫 canvas 像素定位节点团中心 → 滚轮放大 → 裁中间一块，配色需人工看这张确认）＋markdown 表格样式（临时造一篇带表格的笔记，断言圆角与行 hover 变色）。**跑法**：`node e2e/walkthrough.mjs`（本地模式）或 `E2E_CHAT=1 node e2e/walkthrough.mjs`（用测试账号登录跑真实 AI，01d/01d3/01e 只有这样才刷得到）；再跑 `node e2e/login-provision.mjs` 刷 00b/11/12，跑完看收尾那段「未刷新」清单。UX 审计 P0 批次新增走查步骤：笔记编辑→保存成功 toast＋落盘断言（20/20b）、编辑中切笔记的未保存确认（取消留在原地且草稿不丢 / 放弃后磁盘内容不变，21/21b/21c）、换库二次确认＋向导「返回当前库」（22/22b/22c）、设置页手填 key 保存＋「重新获取服务端配置」反馈（10b/10c）、侧栏删除对话的二次确认＋toast（23/23b）、**真拖一个文件到工作台页**（合成带真实 `File.path` 的 DragEvent，断言覆盖层出现、没发生导航、侧栏与输入框还在、文件确实进了投递箱目录，24/24b）。**任务层一期再加**：投递跑着切到工作台断言全局条仍在（25）、切回知识库断言运行态与进度条还在（26）、**趁任务活着 reload** 断言主进程快照与 Dock 都还在（27——必须在任务活跃那一刻刷新，等它跑完再刷测到的是"收起"那条分支）、Dock 高度过渡属性、Dock 条数与 `tasks:list` 活跃数一致（**两轮 pipeline 之间有 3 秒去抖窗口，那一刻确实没有活跃任务、Dock 本就该收起，所以这两条必须轮询、不能采样一次**）、产物入库三态 29/30/31/32（含 reload 后「已入库」仍在、点「已入库」跳落位笔记）、云端离线降级 33（独立实例把服务器地址指到 127.0.0.1:9 再重启，断言照常开窗+离线条+知识库可用）、E2E_CHAT 下的 H-10 切走切回（28，断言半截正文接得上）。**provider 解耦 + M-29 再加**：模型线路卡片三条线路可见并真切一次到 DeepSeek 官方（断言 base URL 变 `…/anthropic`、主模型 `deepseek-v4-pro`、主进程认账，再切回，10e/10f）、手填 key 的点击必须 20s 内返回（旧版是 10 分钟超时）＋ 出等待态文案（10d，冷调用快时可能一闪而过，所以「看到文案」与「任务层留下 secret 任务」二选一）＋ **同一把 key 再存一次断言 `outcome==='unchanged'` 且不新增 secret 任务**；E2E_CHAT 下额外断言连续两次 `auth.provision()` 的第二次 `wrote` 为空（= 老用户重复登录零写入）。**引擎冒烟**：`npm run smoke:provider`（需 `SMOKE_INFERERA_KEY`/`SMOKE_DEEPSEEK_KEY`，逐 provider 跑单轮/多轮 resume/abort/工具调用/流式/make-ppt 六项，并用 `result.modelUsage` 断言服务端实际用的就是钉死的模型）

---

## 3. 已知 bug 与未解决问题

### bug（按优先级）

1. **无离线降级（P0，2026-08-16 实测踩坑）**：云端（Supabase）连不上时，应用启动卡在登录/会话恢复，窗口不出现，体感"打不开"。正确行为：照常开窗 + 本地功能（知识库/投递箱）可用 + 顶部"云端离线"提示。auth 启动链路在 `desktop/src/main/auth/index.ts`
2. **Supabase 免费版 7 天闲置自动暂停**：暂停后项目域名直接 NXDOMAIN（连 DNS 都没了），叠加 bug#1 = 应用完全打不开。恢复：Dashboard → Restore project（域名先回、服务后起，全程约 5-15 分钟，中途 Cloudflare 521 属正常）。**防复发方案已议未做**：阿里云服务器加每日保活 cron（或升 Pro $25/月）——待用户拍板
3. ~~**make-ppt 偶发撞上 `maxTurns: 30`**~~ ✅ **2026-08-16 已修**：deepseek-v4-pro 很爱反复检索（同一个问题实测连调 4–5 次 `search_knowledge`），做 PPT 那条链路上偶尔把 30 轮预算耗光，SDK 直接返回 `Reached maximum number of turns (30)`、产物不生成（修前统计：DeepSeek 官方 2/2 轮全过，inferera 3/4 轮全过）。**两手一起改**：系统提示词加第 7 条「同一任务 search_knowledge 最多 3 次，素材够就立刻产出，轮次有上限」＋ `agent/index.ts` 的 `maxTurns` 30→40。**验证**：DeepSeek 线路连跑 3 轮，每轮 6/6 全过，make-ppt 分别 43s / 50s / 46s（修前失败那次是跑满 75s 才耗光轮次）
4. **supabase-js 的 Node 20 弃用警告**：启动时打 deprecation warning。根因是 Electron 30 内置 Node 20，而 Electron 版本被 XProtect 问题锁死（见 §4-2），升级链条：拿到开发者签名 → 升 Electron → 消除此警告。短期无害

### 未解决/未做（按计划属 P1+）

- **网关**：MVP 直连中转站，客户端 key 理论可提取（缓解：低配额专用 key + 用量告警；根治=P1 网关）
- **开发者签名/公证**：现为 ad-hoc 签名，0 号用户右键打开绕 Gatekeeper；扩散前必须买 Apple Developer ID（同时解锁 Electron 升级）
- **Windows 版**：未做（首发 macOS-only 是拍板项）
- **本地 SQLite 聊天库**：v2；当前聊天记录只在云端
- **仓库卫生**：`desktop/` 有一批未提交的工作区改动（vault/index.ts、reader.ts、VaultPage.tsx、e2e 截图等，属分区投递之后的迭代），接手先 `git status` 看一眼，该提交提交
- **client.ts 死代码**：`webpage/lib/automation/dingtalk/client.ts` 现在只有 `listRecords` 有调用方（vault-notes），`listSheets/insertRecords/updateRecords/deleteRecords/sendGroupMessage` 全部无人调用（钉钉剥离的遗留，见 §4-16）。留着无害，后续收拾
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
13. **样式只走 design token（2026-08-16）**：数值真相源是 `desktop/src/renderer/src/styles/theme.css` 的 CSS 变量，`tailwind.config.js` 只做「语义类名 → var(--token)」映射，组件里不再出现色值/px 字面量；canvas（关系图）这类没法用 class 的地方走 `src/renderer/src/theme.ts` 的 `token()` 读同一份变量。注意 Tailwind 的透明度修饰符（`bg-x/60`）对 `var()` 颜色无效，要淡色就另开一个 token
14. **首页问候语的衬线栈把拉丁字体排在最前**（`--font-serif` = Helvetica Neue → Noto Serif SC → Songti SC）：字体是按字符 fallback 的，这样中文才落衬线、数字与英文仍是无衬线，避免"英文突然变衬线"的廉价感。**衍生结论（2026-08-16 精修二轮实测）**：想让中文衬线"更有份量"只能加字号，`font-weight` 无效（中文衬线字体没有 medium/semibold 字面，macOS 也不给合成，400/500/600 渲染出来一模一样）
15. **e2e 截 hover 态必须走 CDP 抓屏**：Playwright 的 `page.screenshot()` 会把 `:hover` 清掉（截出来永远是非 hover 态，之后对 hover 才出现的按钮点击也会失败）。`walkthrough.mjs` 里的 `snapHover()` 用 `Page.captureScreenshot` 绕开，产物卡片 hover 操作就靠它验收
16. **钉钉自动化 webpage 侧剥离收尾（2026-08-16 完成）**：钉钉每日同步 2026-07-24 已分叉到独立仓库 `~/Documents/AI/omg-dingtalk-automation`（国内服务器 crontab：`run.js` 每日 03:00 ＋ `hourly.js` 每小时，已确认在跑、run.log 到 8/16 每日成功），并持续演进到"任务驱动"新口径。webpage 侧那份停在 07-20 的占位实现和 Vercel Cron 一直没摘，会在同一时间点按旧口径往同一张「执行明细」表建行 → 已删除 `app/api/v1/automation/dingtalk/route.ts` 与 `lib/automation/dingtalk/sync.ts`、清空 `vercel.json` 的 crons（commit a477591）。**保留** `dingtalk/vault-notes/route.ts` 和 `lib/automation/dingtalk/client.ts`——桌面端经营数据自动入库（`desktop/src/main/knowledge/bizdata.ts`）在用，别顺手删。独立仓库本身按禁令未触碰

17. **模型必须显式指定，两个 provider 的行为差异（2026-08-16 实测，curl 逐个打过）**：

    | 发过去的模型名 | inferera 中转站 | DeepSeek 官方 `/anthropic` |
    |---|---|---|
    | `deepseek-v4-pro` / `-flash` | 原样服务 | 原样服务（**只认这两个**） |
    | `claude-sonnet-4-5-20250929`（Agent SDK 的默认值） | 真路由到 Claude Sonnet 4.5 | **HTTP 200，静默降级成 `deepseek-v4-flash`** |
    | `claude-3-5-haiku-20241022` | 映射到 `claude-haiku-4-5` | 同上，静默降级 |
    | 不存在的名字 | 400「cannot be routed」 | 400，且报文里会列出它支持的名字 |
    | `deepseek-chat` | 404 | 200（降级到 flash） |

    所以**不能靠自动映射**：`options.model` 与 `ANTHROPIC_MODEL/ANTHROPIC_SMALL_FAST_MODEL` 一律显式下发。为了能拆穿静默降级，`agent:stream` 的 `assistant` 事件多带一个 `models` 字段（取自 SDK `result.modelUsage` 的 key，即**服务端实际用的模型**），对不上会在日志里打 warn，冒烟脚本直接拿它做断言。
    **默认线路暂保持 inferera 中转站**（2026-08-16 拍板）：DeepSeek 官方那条已经跑通并保留在设置页里，但默认不切——切换的前置条件是 make-ppt 修复（见 §3 bug#3）在 DeepSeek 线路上稳定，验完再由用户拍板执行切换。切换动作本身只有一处：`ai/provider.ts` 里 store 默认值 `aiProvider`（老用户已有配置不受影响，需要另配迁移逻辑或让他们自己在设置页切）。
    其他实测差异：① DeepSeek 官方会返回 `thinking` 内容块，而我们的流式只转发 `text_delta`，所以首字延迟比 inferera 明显（实测单轮 10.6s vs 4.4s，make-ppt 60s vs 55s）；② inferera 那轮的 `modelUsage` 会同时出现 pro 与 flash（轻量子任务真的走了 `ANTHROPIC_SMALL_FAST_MODEL`）；③ 两边都跑通了工具调用与 make-ppt 全流程。
18. **M-29 的方案取舍：三条缓解，不上助手进程（2026-08-16）**：贵的是「进程内对 safeStorage 的**第一次调用**」（读写都算），实测 8ms～60s 不等，取决于 securityd 的签名校验缓存冷热；**utilityProcess 里没有 safeStorage**（实测只暴露 `net`/`systemPreferences`），所以"整个挪进 worker"在 Electron 30.5.1 下不成立。剩下能彻底不阻塞的只有"常驻第二个 Electron 实例当加密助手"，代价是多一个主进程与多一条打包/公证路径；权衡后**一期不做**，改用指纹判重（不写就不冻）＋ 只读不解密 ＋ 写入转后台任务。根因是 ad-hoc 签名，本来就在「买开发者签名」那条路上，签名后要复测一次再决定要不要上助手进程。

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
│   │   ├ secrets.ts   密钥保险箱（指纹判重/内存缓存/后台落盘，M-29 的全部实现）
│   │   ├ ai/          provider.ts：对话线路（inferera/DeepSeek官方/自定义）与模型显式下发
│   │   ├ agent/       Agent SDK 会话管理、流式转发
│   │   ├ vault/       index.ts(索引) reader.ts(扫描/解析) watcher graph
│   │   ├ inbox/       orchestrator（队列/进度/落位/分区投递）
│   │   ├ ai/          provider（从 webpage 平移）
│   │   ├ knowledge/   云端 ingest/search 客户端
│   │   ├ tasks/       registry.ts(任务真相源) types.ts persist.ts(tasks.json 三张表)
│   │   └ auth/        index.ts（supabase-js、anon key 三级来源：env > electron-store > 内置默认）
│   ├ preload/         contextBridge：全部 IPC 通道定义
│   └ renderer/src/
│       ├ pages/       VaultPage / 对话 / 设置
│       ├ components/  聊天四组件（直搬）+ 产物面板 + 图谱 + TaskDock/OfflineBar
│       ├ hooks/useChatSession.ts   聊天状态机
│       └ hooks/useTasks.ts         任务层渲染镜像（useSyncExternalStore）
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

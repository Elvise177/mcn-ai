# mcn-ai 产品交接文档（HANDOFF）

> 更新：2026-08-17 ｜ 范围：mcn-ai 产品线（桌面版 + 云端），不含 OMG 钉钉自动化定制项目（那是独立仓库 `~/Documents/AI/omg-dingtalk-automation`，有自己的 README 和交付文档）
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
    ├ ai/         档位层 tiers.ts（标准/增强 → 线路+模型，运维可改映射）+ health.ts（线路探测）
    │             provider.ts 退化为历史配置读口 + agentEnv（子进程环境构造）
    ├ usage/      用量记录：userData/usage/YYYY-MM.jsonl（原样存 usage，归一化在汇总侧）
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
| LLM 接入 | **会话级档位**（`src/main/ai/tiers.ts`）：标准=DeepSeek 官方 `deepseek-v4-pro/flash`，增强=aihubmix `claude-opus-5`；模型串**显式下发**，映射（地址/模型/key）在设置页管理员区可改 | 见 §4-17/§4-23；key 用 safeStorage 加密存储（读写规则见 §4-18），网关是 P1（§4-3） |
| 知识入库 pipeline | Python（pkb-pipeline 仓库），PyInstaller **onedir** 冻结，随 app 分发于 resources/pipeline | cli.py：`mcn-ingest --file --vault --layout --llm-key`，串联 02→09→03→07→04 |
| 云端 | Supabase：Auth + Postgres + pgvector + RLS | 项目 id：`yqozqfrmdddmfrpavrsn`（免费版，有暂停坑，见 §3-2） |
| 向量 | text-embedding-3-small | 成本敏感选型 |
| 本地检索 | minisearch（占位） | 语义检索已切云端 search，接口不变 |
| 产物生成 | skills：make-ppt（移植 make-ppt-v2 快速模式）+ make-docx；对话内另有 Word/Excel/PDF 生成工具 | 产物统一写 `vault/90_产物/<日期>_<名称>/` |

### 云端接线（M4 落定的架构）

- 私人知识层**不直调 Supabase RPC**，走 webpage 的 API：`webpage/app/api/v1/knowledge/personal/{ingest,search}/route.ts`，`Authorization: Bearer <supabase access_token>` → 服务端 `admin.auth.getUser(token)` 拿可信 user_id → 复用 `ingestKnowledge/searchKnowledge`（layers=['platform','org','private']）
- 迁移 010（personal knowledge 层）+ 011（knowledge_chunks 加 file_path/content_hash，去重=同 owner+file_path 先删后插）均已执行
- 聊天记录：主进程 authenticated supabase-js 直写 conversations/messages（RLS 已配）。本地 electron-store 始终是权威副本。**同步失败不再静默丢弃，队列重试已实现**（审计 M-03 收口）：失败落进 `tasks.json` 的 `syncQueue`，`knowledge/sync-queue.ts` 每 30 秒扫一轮到期条目，退避 **1m / 5m / 30m → 转手动**，同一会话只排一条、登出即清队；转手动之后的出口是 Dock 上的「重试同步」（`sync:retry`，整队 tries 归零并立刻跑一轮）。**注意**：Postgres 拒绝一行（约束/RLS）不算"云端不可达"，只有传输层失败才点亮全局「云端离线」条——否则用户会去查网络而真正的问题在数据里（本地 SQLite 聊天库仍属 v2）
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
    **一期的边界**：只上报不改行为——不含取消、H-09 停止留半截、H-10 主进程拒绝重复发送、M-27 冲突检测、M-01 登录超时、syncQueue 真重试。**这些已在二期全部做掉，见下面第 14 条**；legacy `inbox:event`/`inbox:lastRun` 也已在二期删除。
    **关键约定**（改这层前必读）：① 主进程 registry 是唯一真相源，页面组件不得自己 setState 维护任务态，唯一例外是 Workbench 的逐字 draft 允许本地累积但每次挂载先用 `task.draft` 做基线；② **「进行中」永不落盘**，落盘的只有终态结果与待办队列（`tasks.json` 三张表），否则重启后必然出现永不结束的幽灵任务；③ push 尽力而为、snapshot 才是权威——`webContents.send` 在窗口 reload 期间会静默丢事件，所以渲染层每次挂载都先 `tasks:list` 打底，`seq` 用来丢弃迟到事件；④ 高频 delta 不进 `task:event`，仍走 `agent:stream`，任务里的 draft 每 500ms 节流推一次
    **踩坑记录**：① 「已入库」要指向落位笔记，**不能按原文件名 `resolveLink` 去猜**——开了智能打标时 pipeline 会按内容给笔记重新命名，按文件名找必然扑空（本地模式没 LLM key 走 `--skip-llm` 不改名，所以只有 `E2E_CHAT=1` 那轮才暴露出来）。现在改成"入库前拍一次笔记全集快照、跑完做差集"，名字对得上的优先、本批只有一个产物且只新增一篇时就认那篇；② TaskDock 的进度条一开始复用了 `.inbox-bar-fill` 类名，导致走查里 `.inbox-bar-fill` 同时命中两根条、strict mode 直接报错——全局条改用 `.task-bar-fill`，`.inbox-bar-fill` 仍然只指投递箱面板那一根；③ 两轮 pipeline 之间有 3 秒去抖窗口，那一刻确实没有活跃任务、Dock 本就该收起，所以走查里凡是断言 Dock 的地方都必须轮询而不是采样一次
12. **模型 provider 解耦 + M-29 密钥链路健康化（2026-08-16）**：对话链路的地址/模型/key 全部收口到 `src/main/ai/provider.ts`，设置页「模型线路」卡片可在 **inferera 中转站 ／ DeepSeek 官方（`https://api.deepseek.com/anthropic`）／ 自定义 base URL**（为 Kimi/智谱留口）之间切换，base URL 与主模型/轻量模型都显式可见可改；`agentEnv()` 会先把继承来的 `ANTHROPIC_*` 清空再注入本次的 `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL/SMALL_FAST_MODEL`（否则开发机自己的环境变量会串进子进程）。同一单里把 M-29 做掉：密钥读写收口到 `src/main/secrets.ts`，**写前指纹判重（零 Keychain 触碰）＋ 只读不解密 ＋ 写入转 `kind:'secret'` 后台任务**，登录页/设置页给等待态文案。两个 provider 的行为差异见 §4-17，M-29 的实测数据与方案取舍见 §4-18 和 `docs/UX-AUDIT.md` 的 M-29 条目。同一单里还顺手把 make-ppt 耗光轮次的老毛病修了（系统提示词第 7 条「检索最多 3 次」＋ `maxTurns` 30→40，见 §3 bug#3）。**冒烟**：`npm run smoke:provider`（覆盖单轮/多轮 resume/abort/工具调用/流式/make-ppt 六项，逐 provider 跑）
14. **全局任务状态层 · 二期「管得住」（2026-08-16，设计见 `docs/DESIGN-task-state.md` §5–§7）**：一期只上报不改行为，二期把「能不能停下来 / 会不会冲掉别人的东西」补齐。
    - **H-13 投递箱取消**：`child` 从 `run()` 里的局部变量提升为实例字段，`spawn` 加 `detached:true` 让子进程成为**新进程组的组长**，`inbox:cancel` 走 `process.kill(-pid,'SIGTERM')`、3 秒不退升级 `SIGKILL`。面板运行态出「停止本轮」。**取消是 `canceled` 不是 `failed`**（中性灰，不报红，不进 Dock 的失败列表），**不做回滚**——已落位的 md 与 `.done` 标记全保留，未处理的文件仍在投递箱里，点「立即处理」接着做
    - **顺带修掉一个当时就存在的 bug**：退出应用会留下跑着的 pipeline（孤儿进程继续写 vault、烧 LLM 额度）。`before-quit` 里 `preventDefault()` → 同一套 kill → 走完再 `app.exit(0)`
    - **H-09 停止生成保留半截**：`stop()` 先把主进程累积的 draft 落成一条尾标「（已停止）」的 assistant 消息再 abort。另有 `stopped` 集合：abort 传播需要时间，SDK 往往还会再吐一条 result 出来，不拦住的话等于根本没停成
    - **H-10 重复发送拒绝**：`chat:send` 在主进程侧判「同 session 已在流式中」→ 拒绝（**不 abort 旧的**）。渲染层不再静默吞掉这次按键，而是弹一条**带「停止当前生成」动作按钮**的提示（`ui.toast` 因此支持了可选 `action`），输入框内容原样留着。`tasks.start()` 挪到 `send()` 的第一个同步 tick——任务建晚了，那几个 await 的窗口里第二条消息照样挤得进来（这正是 AbortController 被覆盖的老根因）
    - **M-27 编辑冲突**：进编辑记内容 hash 基线（`vault:stat`）；编辑中收到**非自触发**的 `vault:changed` 且 hash 变了 → 挂**非模态**暖色提示条（用户在打字，弹模态会吞击键）；保存走 `vault:writeChecked` 二次校验，冲突则弹**三选一**，默认高亮「另存为副本」（唯一零数据丢失的选项）。自触发抑制**按内容 hash 不按 mtime**——chokidar 的 `awaitWriteFinish` 会让 mtime 对不上，漏抑制就是每次保存都自己给自己报冲突
    - **M-01 登录**：10 秒超时 + 可取消 + 错误分三类（`network` / `credential` / `timeout`），文案分别对应。Supabase 被暂停时报「密码不对」是最坏的误导——用户会一遍遍改密码
    - **删 legacy**：`inbox:event` / `inbox:lastRun` 通道与转发代码全部移除，投递箱状态只剩任务层一条路
    **踩坑记录**：① 取消断言极易变成"空过"——`waitForPipelinePid` 抓到的可能是**上一轮马上要结束**的 pid，点下去按钮已经变回「立即处理」了；走查里必须先 `waitInboxIdle`（连续 4.5 秒无活跃，跨过 3 秒去抖窗口）再投文件，并且点击失败要能重试整轮；② 验"登录超时"不能拿不可达 IP（`192.0.2.1` 实测 fetch **9ms** 就报 ENETUNREACH，压根走不到超时分支），得起一个**只收不答的黑洞 socket**；③ 走查里 `.streaming-body` 不能用 `waitFor(visible)`——检索阶段 draft 可能只有一个换行，元素在但高度为 0，Playwright 判定 hidden 会一直等到超时，改轮询 `textContent`；④ 换行符经 shell 传参会变成字面量 `\n`，外部改文件的走查脚本别传文本、用脚本里的默认值
16. **UX 审计批次三 · 精选包（2026-08-16，老板路径高概率项，见 `docs/UX-AUDIT.md` 的 H-11/H-12/M-02/M-04/M-05/M-11/M-13/L-03）**：都是"页面局部状态"的洞，与任务层无关，各自单独修（审计 §5 的判断）。
    - **H-11 + M-13 搜索三态**：`vault:search` 改返回 `{ hits, total }`（worker 里取截断前的命中数），渲染层按 `query.trim()` 分三态——未搜索→文件树／检索中→「检索中…」加载态／有词零命中→「没找到「X」」+ 清空按钮；有结果时头部显示「N / 共 M 条」。旧代码 `hits.length > 0 ? 结果 : <Tree/>` 把"没找到"和"没搜索"画成同一个状态，搜一个库里没有的词看到的是整棵树
    - **H-12 建库向导**：`pick()` 补 `try/finally` + 错误 toast，busy 时卡片文案换「正在创建/索引…」+ spinner，另一张卡同时禁用。旧代码 `vault:createNew` 一抛错 `setBusy(false)` 就永远不执行，两张卡半透明不可点、也没有报错，只能重启
    - **M-02 笔记读不出来**：toast + 正文区错误态（文件名 + 原因 + 「重试」/「关闭」）。watcher 触发的重读走静默分支——投递箱跑批时文件被反复重写，不静默就是一串没人看得懂的报错
    - **M-04 / M-05 打不开就说话**：`vault.openFile` 返回 false → 「找不到文件：<路径>」；`artifacts.open` 改返回 `{ok,error}`（先 `fs.access` 再 `shell.openPath`，两种失败都回原因），toast 附**「在 Finder 中显示」**兜底（新 IPC `artifacts:reveal`）
    - **M-11 AI 出错可重试**：错误消息带 `error:true`，气泡内常驻「重试」，复用**上一条 user 消息**重发并把错误气泡就地撤掉（提问不复制成两条）；前面没有可复用的提问时不给这颗按钮
    - **L-03 toast**：同屏最多 3 条（挤掉最老的）、点击立刻关、悬停暂停倒计时（剩余时间跨暂停累计）
    **顺带修掉两个走查现场抓到的真 bug**：① **`UiHost` 以前挂在主界面布局里**，于是首跑的登录门/建库引导那几屏根本没有 toast 宿主，`ui.toast` 静默空转——建库失败连报错都弹不出来（H-12 第一轮走查就是卡在这），现已提到 `main.tsx` 根部；② **发出去的提问会被同步返回的错误整条盖掉**：`activeRef.current` 要等 React 提交下一帧才更新，而主进程的预检失败（没配 key / 没开库）是在 `chat:send` 回执之前就 emit 的，那一下 `appendMessage` 拿到的是没有这条提问的旧快照 → 历史里只剩一条 ⚠️、侧栏标题都成了错误文案。修法：`upsert` 里**同步**更新 `activeRef.current`，`handleSend` 改成「发送前快照 + 我这条提问 + 等待期间到达的消息」拼接，不再整条覆盖
    **E2E_CHAT 全量轮又抓到两条（都已修）**：① **重试只撤掉了 ⚠️ 那一条**——SDK 出错时往往**先吐一条原始错误正文（英文 result）再抛异常**，只删 ⚠️ 的话每重试一次就多堆一条；改成回退到「最后一条提问」重发（撤掉这一轮失败留下的全部内容），断言也从「数提问 / 数按钮」换成**「重试前后消息条数必须相等」**（旧断言正是因为太窄才漏掉的）；② 失败的 agent 任务会在 Dock 上挂 30 分钟（`RECENT_TTL_MS`），**按钮文案里失败优先于「N 条待同步」**，于是新加的出错测试把后面 M-03 的可见性断言挡掉了——走查改成「端点恢复后再点一次重试、真的拿到回答」收尾，任务落成 succeeded，顺带把「重试真能救回来」也验了（41e）。
    **走查新增断言**：建库失败分支用 `MCNAI_E2E_VAULT_FAIL=<卡住毫秒数>` 触发（系统保存框一弹起来 Playwright 就没法继续，只能这样验，走查专用、生产不读，同 §4-21 的 `MCNAI_SUPABASE_URL`）——断言 busy 文案+spinner+另一张卡禁用（40）、失败 toast（40b）、失败后两张卡都恢复可点且能再发起一次；搜索三态用**探针先跑、随后再输入**的写法断言"有搜索词时左栏一次都不许再出现文件树叶子"+ 必须出现过「检索中…」（05）、零命中态与清空按钮真点（05b/05c）、计数「N / 共 M 条」与列表条数对账；笔记读取失败用 **chmod 000** 造真实读失败（文件还在树里，只是读不了）→ toast + 错误态 + 修回权限点「重试」正文真出来（42/42b）；断链附件点击出「找不到文件：…」（43）；产物「打开」前先把磁盘上那份删掉 → 「打不开产物」+「在 Finder 中显示」出口（44）；M-11 用**切到 custom 线路**（默认没 base URL 也没 key）造确定失败，断言提问仍在历史里、点重试后用 MutationObserver 抓到"错误气泡被撤掉过"且提问没被复制成两条（41/41b）；L-03 连点 5 次附件按钮断言同屏 3 条、悬停 5 秒不消失、点击立刻少一条（40c/40d）。**E2E_CHAT 专属**：M-11 的**异步出错**分支——用一个**秒回 401 的本地 http 桩**当端点（key 是好的、过得了预检，错误在请求发出去之后才到，正是「提问被错误盖掉」那条竞态最宽的窗口；**不要用连接被拒的端口 9**，SDK 会一路重试退避，实测单次 2~4 分钟，第一版走查就是这么超时的），断言提问仍在、重试不堆叠、恢复后重试成功（41c/41d/41e）。另外把 `walkthrough.mjs` 收尾改成 `catch` 先打印失败原因再 `finally` 关应用，且 `app.close()` 加 20 秒竞速——close 挂住时抛出去的错会被一起埋掉，看着像「卡死在某一步」，实测被坑过一次。H-10 切走切回那段也加了防空过：先等正文吐够 24 字再切走；切换间隙回答就结束了的话补发一条长回答的提问重试一次；并且只有主进程说「这条 agent 任务还在跑」时才要求界面有进行中状态

17. **会话级模型档位 + 设置页分组重构 + 用量记录（2026-08-17）**：一单三件事，决策与踩坑见 §4-23/§4-24/§4-25。
    - **A 会话级档位**：输入框内（附件位右侧，落点参照 Claude Desktop 的 composer 左下角）加档位选择器 `components/TierSelector.tsx`，两档「标准（推荐）／增强」，**界面不出现供应商名与模型名**，悬停 tooltip 只说能力与消耗差异。档位存在 conversation 上随对话落盘，`chat:send` 多一个 `tier` 参数，新会话默认标准。增强档接线路健康检查（`ai/health.ts`，`max_tokens:1` 探一次、结果缓存 5 分钟、只探增强档），不可用时选择器里置灰 +「暂时不可用」；会话进行中失败走原有错误重试路径，气泡里额外给「切换到标准模式重试」。静默降级防线沿用并加强：`result.modelUsage` 与档位期望模型比对，不一致打 warn **并记进用量**（`degraded:true`）。老用户迁移见 §4-23。
    - **B 设置页分组重构**（不改任何设置项的行为）：四组卡片 账号／模型服务／知识库／用量。模型服务在普通模式只有一行「AI 服务：已就绪 ✓」，异常时换成「服务异常 + 重新连接」。线路 base URL、档位映射、各线路 API Key 手填、「重新获取服务端配置」、服务器地址**全部移进隐藏管理员区**——设置页底部版本号连续点 7 次解锁，解锁态存内存（放在 App 而不是设置页组件里，去用量页看一眼再回来不至于又锁上），重启复位，区顶标「运维配置，请勿改动」。「导出诊断报告」仍是页面底部独立区域。样式沿用现有 token，没新造。
    - **A′ 返工（2026-08-17 验收后）**：档位选择器从**输入框内部**移到**输入框下沿的控制条右侧**（挨着发送键那一侧，形态参照 Claude Desktop 的模型选择器：无边框文字胶囊「标准 ⌄」，向上弹菜单）。输入框内部恢复为只有附件位——档位是"这一轮怎么跑"的元信息，不是输入内容的一部分，塞在正文行里既挤横向空间又不合语义。**消耗差异的说明从 tooltip 挪进菜单里的灰色小字**：差几十倍这种事得让人在"选之前"看见，悬停两秒才看见等于没说。控制条留成了以后放别的轮次开关的位置。
    - **C 用量记录与用量页**：`usage/index.ts` 每次成功 result 追加写 `userData/usage/YYYY-MM.jsonl`（时间戳/sessionId/任务类型/档位/expected_model/resolved_model/耗时/**原样的完整 usage 对象**）；投递箱的智能打标拿不到 token 就只记次数。设置页用量卡片「本月对话 N 次 · 产物 M 个」→ 用量页 `pages/UsagePage.tsx`：顶部大数字、最近 14 天纯 CSS 柱条、**按档位消耗对比**（成本透明化的核心，两档次数与 token 并排）、按任务类型细分表（次数/tokens/耗时中位数）、tokens 口径脚注、空态引导、顶部预留隐藏的配额进度条组件位（`QUOTA_ENABLED=false`，注释标了「将来按量计费启用」）。消息气泡不加任何用量显示。开发者侧另有 `scripts/usage-report.mjs`（读全部月份，按月/类型/档位/实际模型出 token 与估算成本，单价常量在脚本顶部，deepseek 与 claude-opus-5 分开配；只走控制台，不进 UI）。
    - **C′ 返工：人民币化（2026-08-17 验收后）**：页面上的钱一律是人民币，**美元单价与汇率下沉到管理员区**（各档 输入/输出 每百万 token 的美元价 + USD/CNY 汇率，默认 7.2）。让老板看着美元单价自己乘汇率，等于这件事没做。顶部大数字从两项变三项（对话次数 / 产物数 / **本月估算花费 约 ¥N**）；档位对比区升级成 **次数 / tokens / ¥花费 三列并排**；类型表的 tokens 列改成「约 ¥X.XX · N tokens」（人民币在前，tokens 退居佐证）；页面底部加脚注「费用为估算值，以实际账单为准」。**单价只有一份真相**：`usage/pricing.ts` 的 `getPricing()` 会把默认值补齐**落进 store**，`scripts/usage-report.mjs` 直接读 `userData/config.json` 的 `pricing`，读不到才用内置兜底并在表头打印"计价来源"——这样"页面一个价、脚本另一个价"不可能发生。计价按**档位**而不是模型名：档位才是用户看得见的东西，模型串是运维可以换掉的。
    - **顺带删掉的**：设置页的 provider 选择器与 `ai:providers`/`ai:setProvider`/`ai:setProviderConfig` 三个 IPC（被档位映射取代），`ai/provider.ts` 里随之失效的 `listProviders/setProvider/setProviderOverrides/resolveForRequest`。
15. **验收基线**：Maggie vault 全量数据「批量导入→问库→生成PPT→回看产物」闭环通过；e2e 走查脚本 `desktop/e2e/walkthrough.mjs` + 截图基线 `desktop/e2e/shots/`（GUI 改动必须跑走查看截图再交付——用户铁律）。2026-08-16 新增走查步骤：空库引导（独立空库实例）＋首页卡片区＋chips 填充＋输入框 60px/附件位＋流式光标（E2E_CHAT=1 真实流式时截行尾光标）＋投递箱六阶段进度条＋产物卡片 hover/打开/入库/预览＋最近对话卡片点开＋建库卡片 hover＋笔记 ··· 菜单/删除二次确认/新建→删除全链路＋搜索摘要洁净度＋空值与空表格＋分区投递静态同款与悬停高亮＋首页产物面板默认收起；UI 精修第二轮再加：文件树默认宽 220 断言＋三栏分隔线真拖（tree +90 / graph +80，断言宽度变化与 localStorage 落盘，重载后复查记忆）＋关系图配色特写（扫 canvas 像素定位节点团中心 → 滚轮放大 → 裁中间一块，配色需人工看这张确认）＋markdown 表格样式（临时造一篇带表格的笔记，断言圆角与行 hover 变色）。**跑法**：`node e2e/walkthrough.mjs`（本地模式）或 `E2E_CHAT=1 node e2e/walkthrough.mjs`（用测试账号登录跑真实 AI，01d/01d3/01e 只有这样才刷得到）；再跑 `node e2e/login-provision.mjs` 刷 00b/11/12，跑完看收尾那段「未刷新」清单。UX 审计 P0 批次新增走查步骤：笔记编辑→保存成功 toast＋落盘断言（20/20b）、编辑中切笔记的未保存确认（取消留在原地且草稿不丢 / 放弃后磁盘内容不变，21/21b/21c）、换库二次确认＋向导「返回当前库」（22/22b/22c）、设置页手填 key 保存＋「重新获取服务端配置」反馈（10b/10c）、侧栏删除对话的二次确认＋toast（23/23b）、**真拖一个文件到工作台页**（合成带真实 `File.path` 的 DragEvent，断言覆盖层出现、没发生导航、侧栏与输入框还在、文件确实进了投递箱目录，24/24b）。**任务层一期再加**：投递跑着切到工作台断言全局条仍在（25）、切回知识库断言运行态与进度条还在（26）、**趁任务活着 reload** 断言主进程快照与 Dock 都还在（27——必须在任务活跃那一刻刷新，等它跑完再刷测到的是"收起"那条分支）、Dock 高度过渡属性、Dock 条数与 `tasks:list` 活跃数一致（**两轮 pipeline 之间有 3 秒去抖窗口，那一刻确实没有活跃任务、Dock 本就该收起，所以这两条必须轮询、不能采样一次**）、产物入库三态 29/30/31/32（含 reload 后「已入库」仍在、点「已入库」跳落位笔记）、云端离线降级 33（独立实例把服务器地址指到 127.0.0.1:9 再重启，断言照常开窗+离线条+知识库可用）、E2E_CHAT 下的 H-10 切走切回（28，断言半截正文接得上）。**provider 解耦 + M-29 再加**：~~模型线路卡片三条线路可见并真切一次到 DeepSeek 官方（10e/10f）~~ —— **2026-08-17 起这两步被"管理员区的档位映射"取代（10g/10h），10e/10f 两张截图已删**；手填 key 的点击必须 20s 内返回（旧版是 10 分钟超时）＋ 出等待态文案（10d，冷调用快时可能一闪而过，所以「看到文案」与「任务层留下 secret 任务」二选一）＋ **同一把 key 再存一次断言 `outcome==='unchanged'` 且不新增 secret 任务**；E2E_CHAT 下额外断言连续两次 `auth.provision()` 的第二次 `wrote` 为空（= 老用户重复登录零写入）。**引擎冒烟**：`npm run smoke:provider`（需 `SMOKE_INFERERA_KEY`/`SMOKE_DEEPSEEK_KEY`/`SMOKE_AIHUBMIX_KEY`，逐条线路跑单轮/多轮 resume/abort/工具调用/流式/make-ppt 六项，并用 `result.modelUsage` 断言服务端实际用的就是钉死的模型；`SMOKE_ONLY=<线路>` 与 `SMOKE_CASES=single,abort,tools` 可精确裁剪，**新增线路只跑最小集**即可，见 desktop/CLAUDE.md 的验收铁律）。
    **任务层二期再加**（设计 §6.3 断言 7–13）：投递跑到一半真点「停止本轮」→ 断言任务是 `canceled` 且不带 error、面板文案含「已停止/已完成的部分」、进度条中性灰、**`ps -eo pgid,pid,command` 查该进程组零残留**、已落位的笔记一篇不少（34/34b）；退出应用后同样查一次进程组，验 `before-quit` 不留孤儿；生成中直接调 `chat.send` 断言被拒（`reason:'busy'`）＋界面敲 Enter 出带「停止当前生成」按钮的提示且输入不清空（35）；点那颗按钮 → 半截回答带「（已停止）」留在对话里、之后**不会再补一条完整答案**（36）；**外部脚本真改文件**触发冲突条（断言不弹模态、草稿不变）→「查看对方版本」展开磁盘那版 →保存弹三选一（断言默认高亮「另存为副本」）→ 选副本后**磁盘上两份都在**（37/37b/37c/37d），并单独验一次"应用自己保存不算冲突"；登录页黑洞 socket 验可取消 + 10s 超时文案（38/38b），端口 9 验「网络不可达」不是「密码错」（38c）；syncQueue 用真实 Supabase 约束失败造队列，断言退避 1m→5m→30m→转手动、Dock 出「N 条待同步」+「重试同步」、点重试真跑一轮（tries 4→1）、换成合法内容再存一次即自动清队（39）。**增强档回落再加（2026-08-17）**：新增独立实例**模拟老用户升级机**（大头那台的形态）——第一次启动把 vaultPath 落盘，改 config 抹掉 `tierMigrated` 再启一次 → 走 `migrateTiers` 的老用户分支（**这条之前只在真机上验过，现在进走查了**），断言标准档 `keyField` 搬成 `encryptedApiKey`、base URL 变 inferera；然后只配这一把 key，断言增强档 `hasKey=true` / `usingSharedKey=true` / 选择器里**不再置灰**（45e）/ 管理员区标出「复用中转站密钥」/ **`logs/main.log` 里出现回落日志且写明回落到哪把**。真机侧另跑了一次「拿真实 userData 的副本起应用」的验证：真实网络探测 `ok:true`、菜单可选、回落日志落下。**返工后再加（2026-08-17 验收）**：档位选择器**位置**断言——必须在 `composer-bar` 里、**输入框那一行内不得再有档位控件**、控制条在输入行下方且 `justify-content:flex-end`、按钮上不许再挂 tooltip、菜单必须**向上**弹（比 `getBoundingClientRect`）；管理员区计价配置（默认单价 0.28/1.1、15/75、汇率 7.2）与**落盘**断言（脚本靠这一份）；用量页人民币化——「本月估算花费 约 ¥N」大数字、增强档换算落在 ¥4.5 上下（桩数据反推）、档位对比区三列齐全、类型表「约 ¥X.XX · N tokens」格式、**整页不许出现美元单价**、费用脚注含「估算值/实际账单」。新增截图 10i（计价配置）。
    **档位 + 设置页分组 + 用量再加（2026-08-17）**：档位选择器就位与新会话默认标准（45）＋ **tooltip 与菜单里禁止出现供应商名/模型名**（正则扫 deepseek|claude|opus|aihubmix|inferera）＋ 增强档置灰与「暂时不可用」（45b，独立实例 `MCNAI_E2E_TIER_HEALTH=down`，并断言 `disabled` 真生效、强点也切不过去）＋ 真切到增强档（45c）＋ 增强档失败时的「切换到标准模式重试」出口（45d）＋ **档位按会话记忆**（新对话回标准、切回旧会话仍是增强、`chat.list()` 里 `tier` 真落盘）；设置页四组卡片齐全 + 管理员区默认不可见 + 模型服务卡片在普通模式里不许出现线路/模型串（10）＋ 版本号点 6 次不解锁、第 7 次才解锁（10g）＋ 管理员区两档映射的地址与模型串断言（10h：标准 `api.deepseek.com` / `deepseek-v4-pro` / `deepseek-v4-flash`，增强 `aihubmix.com` / `claude-opus-5`）＋「检测线路」真点一次并要求界面落结论；手填 key 与 M-29 那组断言原样搬到管理员区（10b/10c/10d，testid 改成 `tier-key-input-<档位>`/`tier-key-save-<档位>`），并加一条**「保存后普通模式那行必须跟着变成已就绪 ✓」**（两处说法不一致是最容易糊弄过去的洞）；用量空态引导（47）＋ **桩数据直写 `userData/usage/YYYY-MM.jsonl`** 验读取链路（47b/47c：对话/产物大数字各 +1、两档 token 分开归一、入库打标只记次数且 token 显示「—」、14 根柱子、口径脚注、配额进度条本期不显示）；E2E_CHAT 下额外验**写入链路**——一轮真实对话后 jsonl 必须落一条字段齐全的记录且 `degraded` 为假。
    **走查与真实调用对账抓到的坑（已修，五个）**：① `resolveTierForRequest` 原来会兜底吃 `ANTHROPIC_AUTH_TOKEN`，开发机上常年挂着这个变量，于是"增强档没配 key"那条预检分支在走查里根本触发不到——请求真的发了出去。改成**只有无窗口时（无头冒烟）才吃 env**；② 同一轮发现失败的那两次也被记进了用量，于是把记账收窄到 `subtype === 'success'`；③ **`resolved_model` 记成了轻量模型**（2026-08-17 真实调用对账时抓到）：旧写法取 `Object.keys(modelUsage)[0]`，而一轮里往往同时出现主模型与轻量模型（起标题、压上下文），key 的顺序由服务端给——标准档那一轮排在前面的正好是 `deepseek-v4-flash`，于是记录里写着"要 pro，实际 flash"，看着像被降级，其实 pro 就在同一个 modelUsage 里。改成"主模型在里面就记主模型，不在才记实际那个"（`degraded` 的判据本来就是"主模型在不在"，两者现在一致了）。④ **产物入库跑完了，界面还停在「入库中」**（间歇性，跑第四轮才复现）：`IngestButton` 旧写法要求"亲眼看到 running→succeeded 那一次跃迁"（`was` 有值才认），于是任何"挂载时任务已经是终态"的情况——切页面回来、列表刷新导致重挂、事件在窗口刷新期间被丢——都不会去拉一次已入库表。落盘表里其实早就有记录（走查失败时 dump 出来的三边对账证实了这点）。改成"现在是 succeeded 且上次不是就拉一次"（refresh 幂等），并把走查的失败信息从"只打主进程任务"扩成**主进程任务 / 落盘已入库表 / 渲染层拿到的表三边一起打**——只打一边的话，"主进程说成了但界面没动"和"主进程压根没成"长得一模一样。⑤ **用量页的 14 天柱状图渲染出来是一整片空白**——柱子和日期标签原本挤在同一列里，那一列在 `items-end` 的行里高度由内容决定（只有日期那行字那么高），百分比高度于是全算成 0。**这条是靠人看截图发现的，断言完全没拦住**（`14 根 div 在` 照样通过），所以顺手把断言从"数 div"改成**量像素**（`getBoundingClientRect().height`，最高柱 < 20px 即判失败），并把日期轴拆成独立一行。教训写在这里：结构性断言对"算出来是 0"这类布局塌陷是瞎的。
    **截图可读性**：管理员区与用量页的类型表都在首屏之下，截图前必须 `scrollIntoViewIfNeeded()`，否则两张图长得一模一样、人工看截图等于白看；用量页截图前还要等前面几步的 toast 自己散掉（它们会糊在页头上）。
    **取消与 before-quit 两条必须在打包形态下跑**：`MCNAI_APP_BIN=release/mac-arm64/mcn-ai.app/Contents/MacOS/mcn-ai node e2e/walkthrough.mjs`（设计 §8 风险 1，dev 形态验过不算数）

---

## 3. 已知 bug 与未解决问题

### bug（按优先级）

1. **无离线降级（P0，2026-08-16 实测踩坑）**：云端（Supabase）连不上时，应用启动卡在登录/会话恢复，窗口不出现，体感"打不开"。正确行为：照常开窗 + 本地功能（知识库/投递箱）可用 + 顶部"云端离线"提示。auth 启动链路在 `desktop/src/main/auth/index.ts`
2. **Supabase 免费版 7 天闲置自动暂停**：暂停后项目域名直接 NXDOMAIN（连 DNS 都没了），叠加 bug#1 = 应用完全打不开。恢复：Dashboard → Restore project（域名先回、服务后起，全程约 5-15 分钟，中途 Cloudflare 521 属正常）。**防复发方案已议未做**：阿里云服务器加每日保活 cron（或升 Pro $25/月）——待用户拍板
3. ~~**make-ppt 偶发撞上 `maxTurns: 30`**~~ ✅ **2026-08-16 已修**：deepseek-v4-pro 很爱反复检索（同一个问题实测连调 4–5 次 `search_knowledge`），做 PPT 那条链路上偶尔把 30 轮预算耗光，SDK 直接返回 `Reached maximum number of turns (30)`、产物不生成（修前统计：DeepSeek 官方 2/2 轮全过，inferera 3/4 轮全过）。**两手一起改**：系统提示词加第 7 条「同一任务 search_knowledge 最多 3 次，素材够就立刻产出，轮次有上限」＋ `agent/index.ts` 的 `maxTurns` 30→40。**验证**：DeepSeek 线路连跑 3 轮，每轮 6/6 全过，make-ppt 分别 43s / 50s / 46s（修前失败那次是跑满 75s 才耗光轮次）
4. **supabase-js 的 Node 20 弃用警告**：启动时打 deprecation warning。根因是 Electron 30 内置 Node 20，而 Electron 版本被 XProtect 问题锁死（见 §4-2），升级链条：拿到开发者签名 → 升 Electron → 消除此警告。短期无害

5. **【2026-08-17 QA 回归批次，共 8 条，全部未修】**：用 Maggie 源数据在隔离环境重跑并批跑问答，抓到的问题清单见
   `docs/QA-REPORT-diff.md` §9（A-1~A-8）与 `docs/QA-REPORT-qa.md` §4/§5（B 组）。本次**零产品代码改动**。按严重度：

   | 编号 | 严重度 | 问题 | 位置 |
   |---|---|---|---|
   | B-1 | **高** | `search_knowledge` 对「整句话」查询必然返回空：bigram 分词 + `combineWith:'AND'`，跨词边界的二元组缺一个就整条归零。实测「公司年度目标」0 命中，「公司 年度目标」5 命中。标准档 10 轮里 7 轮因此答「库里没有」，而资料就在库里 | `src/main/vault/search-worker.ts` |
   | A-8 | **高** | `09_pii_guard` 只挡 LLM 打标、**不挡上云**：`cloudSync` 无敏感标记检查，登录后 37 篇 HR/财务 PII 照样进 Supabase | `src/main/inbox/orchestrator.ts:372` |
   | A-1 | **高** | 整包拖入递归 0 文件、静默返回 `n=0`：`enqueue` 对目录只 `readdir` 一层，新客户拖整个文件夹进去界面毫无反应 | `src/main/inbox/orchestrator.ts:317` |
   | A-2 | **高** | `03b_tag_rules.py` 不在 `cli.py` 链上 → 敏感文件零 frontmatter（本次 37/92 篇，占 40%），无 doc_type/category/tags/summary | pkb-pipeline `cli.py` |
   | B-2 | 中 | ~~用量页系统性高估花费~~ ✅ **2026-08-18 已修**（三处，都是被真实账单打出来的）：① 缓存 token 分开计价，折扣率挂**模型**不挂线路（原按全价计进 input，实测 ¥153.83 vs ¥49.79，**高估 3.1 倍**）；② 计价改按**线路 × 模型**（同一个 `deepseek-v4-pro` 官方 ¥4.5、中转站 ≈¥12.2，差 **2.7 倍**）；③ 官方线路改**人民币原生计价**并修正单价——原值是美元倒推的，输入 **低估 2.23×**、输出低估 1.70×、缓存倍率 0.1 应为 **1/30**。加 `PRICING_REV` 让老机器上的错价存档会被重置。三方对账见 `QA-REPORT-qa.md` §9 | `src/main/usage/pricing.ts` + `scripts/usage-report.mjs` |
   | A-3 | 中 | 双链 352 → 2 条：`07` 建链依赖 `20_公司管理/25_达人档案`、`40_带货/产品`、`30_课程/课程计划` 三张实体清单，模板新建库里前者空、后两者目录都不存在 | `07_sensitive_enrich.py` + `vault/wizard.ts` |
   | A-4 | 中 | 转换失败与格式不支持在界面上完全不可见：6 个文件没产出笔记，六阶段进度条全绿、终态 succeeded、原件照样归档进 `.done` | `inbox` 面板 |
   | A-7 | 中 | 批量导入上云只推前 50 篇（`changed.slice(0,50)`），剩下的静默丢弃且不提示 | `src/main/inbox/orchestrator.ts:372` |
   | B-3 | 低 | 内部机制泄漏进回答：模型把子代理编排讲给用户听（「之前启动的两个子代理中，PDF提取那个卡住了」），系统提示词无相关约束 | `src/main/agent/index.ts` 提示词 |
   | A-5 / A-6 | 低 | `Library_MOC` 断链（`04_gen_moc` 引用但不生成）；`05_qc_sample` 不在链上 | pipeline |

   **A-2 + A-8 的修复原则已拍板**（合并为一个修复大单，四条）：① 敏感标记笔记不进 `cloudSync`，本地检索与问答引用照常可用；
   ② `03b` 接回链，敏感文件默认规则打标，标签与结构化摘要必须有且零外发；③ 设置页「知识入库」组加三态选项
   （仅本地规则打标（默认）／允许 AI 打标（明示会发给模型）／与普通文件相同（含云端同步））；④ 文案说清真实边界——
   「敏感文件不离开你的电脑，AI 回答时仍可引用」。

   **回归结论（好的那一半）**：落位一致率 92/92 = 100%；AI 打标质量与旧版持平（每篇标签 5.14 → 5.22）；
   转换失败清单与旧版逐条一致；MOC/主题索引正确刷新。旧库 372 篇里约 270 篇来自 `06_concepts`/`08_table_to_cards`
   等**不在桌面版链上**的阶段，属能力边界不是回归。

6. **【运维风险 · aihubmix key 多方共用且无余额告警】（2026-08-18 实测踩坑，未解决）**：
   测试跑批把中转站余额打穿，8 轮请求连续报 `403 Your account balance is insufficient`。
   而按 §3 已查实的结论，这把 `CLIENT_RELAY_API_KEY` **就是网页版的 `AIHUBMIX_API_KEY`**，
   同时供着网页版的向量与聊天；老用户（含大头那台）的标准档也被 `migrateTiers` 指在这条线上。
   **余额见底 = 桌面版 + 网页版一起挂，而第一个感知渠道是客户报障。**
   - 这是 §3「过渡期缓解：aihubmix 保持低余额、滚动充值」这个策略的直接代价——策略本身没问题，缺的是告警
   - **网关单落地前的人工兜底：每周查一次 aihubmix 余额**（网关方案会把 key 收到服务端，那时顺带做配额监控）
   - 连带发现见 `docs/PLAN-fix-batch.md` §5c：B-4（`max_tokens:1` 健康探针探不出余额不足）、
     B-5（错误文案 "Failed to authenticate" 把人引去查密码）、失败轮仍被计入用量
   - **线路纪律**（同 PLAN §5b）：DeepSeek 一律官方直连 `api.deepseek.com`，aihubmix 只给增强档 `claude-opus-5`；
     测试隔离实例的 config 必须显式写 `tierMigrated:true` + 出厂档位映射，否则 `migrateTiers` 会判成老用户把标准档搬回中转站
     （`e2e/walkthrough.mjs` 已加永久断言守这条）

7. **【已知限制】规则打标的笔记零双链（2026-08-18）**：`03b_tag_rules` 只产出 frontmatter
   （标签/分类/结构摘要），**不生成 `[[…]]` 双链**。所以敏感文件那一批（本次 Maggie 全量里 37 篇：
   人事档案、财务表、达人信息表）在图谱上只有 MOC 那一条目录型连接，彼此之间没有关联。
   这是刻意选的——规则层没有语义理解，硬造双链只会造出错误关联。
   **与 A-3（`08_table_to_cards` 达人卡进链）关联：A-3 立项时一并评估敏感笔记的关联怎么补**，
   不要各修各的（`docs/PLAN-fix-batch.md` §5f-1）

8. **【账本缺口 · 入库打标的花费完全不入账（P1，2026-08-18 三方对账查出，未修）】**：
   `UsageRecord` 对 pipeline 打标那条链只记 `{"usage":null,"calls":1}`——**一个 token 都不记**。
   拿 DeepSeek 官方账单比对当天：v4-flash 账单上有 278,629 纯 input / 232,064 缓存读 / 157,914 输出，
   账本里只有 4,302 / 0 / 1,467，**98.7% 的打标花费在用量页上看不见**（当天 ≈ ¥1.13 对 ¥0.0146）。
   flash 正是打标用的模型，所以这笔账归属很明确。
   - **本批只做了「说实话」**：用量页金额下加了「上面的花费只含对话与做文档；入库打标拿不到 token，没有计入」
   - **要补上得两侧一起改**：Python pipeline 回传 token 用量 → 主进程落账。列为下一批 P1
   - 关联：这也是为什么这轮**逐笔正向对账做不到**——账单按天聚合，当天同一把 key 上还混着
     44 条没有 `route` 字段的老记录（第 2 批加 `route` 之前跑的）。详见 `docs/QA-REPORT-qa.md` §9

9. **【已知误差 · 计价（2026-08-18，本批不修）】**：
   - **混用模型按 `resolved_model` 一口价**：一次会话里 flash 子调用被按 pro 计价，实测 **+0.77%**
     （¥3.4246 vs 精确 ¥3.3985）。方向偏高，量级远小于下一条
   - **DeepSeek 分时计价**：账单里同一天同一模型出现过 **2 倍**差价（08-16 的 flash：输入 ¥1.5 与 ¥3，
     缓存倍率都还是 1/30 → 同一套价目的两个时段档）。产品按固定单价估，误差 **±100%**。
     不内建时段表是有意的：计价是运维项，跟着官方调价手动改一次即可。
     **哪一档是高峰没查清**，所以界面上只说「存在分时计价」，不说「按高峰价估」

### roadmap · 商业化备忘（2026-08-18 记）

- **用量页的金额对客户默认隐藏**（`showCost`，管理员区可开）。原因：现在算出来的是**成本价**，
  摆给客户看等于把进货价摊开，而按量计费的定价还没谈。页面只留次数 / 档位对比 / token 数；
  **计价能力完整保留**——jsonl 照常记、`scripts/usage-report.mjs` 照常出成本表（给我们自己看）
- **将来按量计费时，加成逻辑落在网关侧**（服务端记账出账），不要放进客户端：
  客户端的数只是估算，而且能被改配置改掉。届时用量页按**谈定的客户价**显示，
  账本**区分成本价 / 客户价两列**——毛利要看得见，且不能靠客户端自觉
- **查云硬验证待补**：A-8 的「敏感篇不上云」目前是按**构造与计数**验证的
  （cloudSync 报告拦下 37 篇，与独立扫 frontmatter 的数一致），**没有直接查云端库确认**。
  `preload` 里没有查云入口，不为测试新开产品 IPC。**网关落地后服务端具备查询入口时，顺手补一次查云硬确认**

### 未解决/未做（按计划属 P1+）

- **网关（安全待办 · 已定方向，2026-08-17 拍板）**：MVP 直连中转站，**客户端 key 理论可提取**，而且 2026-08-17 查实这把 key 的分量比原先以为的重得多——服务端下发给每台客户机的 `CLIENT_RELAY_API_KEY` **就是网页版在用的 `AIHUBMIX_API_KEY` 主 key**（哈希一致），它同时供着网页版的向量与聊天。任何一台客户机被扒出 key，网页版全线得跟着轮换。
    - **触发时间**：本单交付稳定后**立即排期**，作为下一个大单
    - **方案要点**：key 不再下发客户端。桌面版改为把对话请求打到自己的服务端网关（webpage 侧新增路由），网关用 Bearer 鉴权认出用户 → 服务端持 key 转发上游 → 流式原样回传。客户端此后**一把上游 key 都不存**，`client-config` 退化为只下发网关地址；档位层的 base URL 换成网关地址即可，模型串仍然显式下发（静默降级那道防线不变）
    - **顺带解决**：按用户配额与限流（现在客户端直连，服务端看不到也拦不住）、用量的服务端口径（现在只有客户机本地 jsonl）
    - **过渡期缓解（当前采用）**：**aihubmix 保持低余额、滚动充值**——上限用余额兜，而不是用子 key 的额度。原计划的"换一把限额子 key"于 2026-08-17 取消：既然网关很快就上，多轮换一次 key 只是多一次运维动作
- ~~**低配额专用 key**~~：`client-config` 路由注释里那句「中转站低配额专用子 key（勿用主 key）」是**愿望不是现状**，实际配的就是主 key。不再单独修，直接由网关方案覆盖
- **开发者签名/公证**：现为 ad-hoc 签名，0 号用户右键打开绕 Gatekeeper；扩散前必须买 Apple Developer ID（同时解锁 Electron 升级）
- **Windows 版**：未做（首发 macOS-only 是拍板项）
- **本地 SQLite 聊天库**：v2；当前聊天记录只在云端
- ~~**仓库卫生**：`desktop/` 有一批未提交的工作区改动~~ ✅ 2026-08-17 随档位单一并提交，工作区已干净；接手仍建议先 `git status` 看一眼
- **client.ts 死代码**：`webpage/lib/automation/dingtalk/client.ts` 现在只有 `listRecords` 有调用方（vault-notes），`listSheets/insertRecords/updateRecords/deleteRecords/sendGroupMessage` 全部无人调用（钉钉剥离的遗留，见 §4-16）。留着无害，后续收拾
- **pipeline 仓库卫生规则（2026-08-18 定）**：`~/Documents/AI/pkb-pipeline` 曾有两个月的
  **已发布但未提交**的改动（docx 的 lxml 修复、外部资料文件名兜底打标）——线上跑的代码比仓库新，
  出了问题连"当时发的是哪一版"都查不到。已于 2026-08-18 补录（commit `c64820f`）。
  **自此定规矩：冻结发布 = 必须同时提交源码，不允许产物比仓库新。**
  冻结命令：`.venv/bin/python -m PyInstaller mcn-ingest.spec --noconfirm --clean`，
  产物拷进 `desktop/resources/pipeline/`
- **新增 pipeline 阶段脚本必须同时加进 `mcn-ingest.spec` 的 `datas`**：`cli.py` 用
  `SourceFileLoader` 从 `sys._MEIPASS` 取阶段脚本，没进 `datas` 的脚本冻结后运行时才报找不到，
  而 **dev 形态从脚本同目录取、永远正常** —— 2026-08-18 接 `03b_tag_rules` 时就踩在这上面，
  只有打包形态实测能发现（同 §4-5 的原则）
- **客户机兼容预检**：发新客户前用 yara 本机预检 Electron 是否会被 XProtect 误杀；老 macOS 的 pyexpat 坑已用 lxml 修掉（docx2md），但同类"编译目标过新"问题在 pipeline 其他依赖上仍可能出现

### 已知未验项（2026-08-17 档位单收尾时明确留下的）

> **2026-08-17 真实调用验收结果**（最小集，共 4 次单轮请求，成本 ≈ ¥14）：
> - 标准档 `SMOKE_ONLY=deepseek SMOKE_CASES=single` → 1/1 通过，`result.modelUsage` = `deepseek-v4-flash / deepseek-v4-pro`（主模型 pro 在里面，轻量子任务真的走了 flash），`degraded=false`
> - 增强档 `SMOKE_ONLY=aihubmix SMOKE_CASES=single,abort,tools` → 3/3 通过，三轮的 `modelUsage` 全部**只有 `claude-opus-5`**（= aihubmix 真路由，没有静默换模型），abort 停在第 3 个 delta，`search_knowledge` 真调到
> - 用量 jsonl 三条记录字段齐全，`usage-report.mjs` 对账：增强 2 次 ¥13.98 / 标准 1 次 ¥0.06 —— **两档的钱差在真实数据上就是这个量级**，用量页的对比区要的就是让人看见这个
>
> 仍未验的：

- **make-ppt 在 `claude-opus-5`（增强档）上的表现未验**：本单只对新增线路做了最小真实调用集（单轮 / abort / 工具调用），make-ppt 那条链路的 skills 层零改动，没有为它跑真实产出。风险点是 §3 bug#3 的老毛病（爱反复检索 → 撞 `maxTurns`）在换模型后行为不同——opus 检索次数通常更少，理论上更安全，但没有实测数据。**要验的话**：`SMOKE_ONLY=aihubmix SMOKE_CASES=ppt npm run smoke:provider`，一次调用的量级
- **增强档的轻量模型串暂时也是 `claude-opus-5`**：aihubmix 上只有它做过真路由验证。等验过一个便宜模型名（如 haiku 系）之后，在管理员区把增强档的「轻量模型」换掉即可省一大笔——这是个明确的待办省钱开关，不是设计终点
- ~~**服务端 `client-config` 还没有下发 `aihubmixApiKey`**~~ ✅ **2026-08-17 作废**：查实 `api.inferera.com` 就是 aihubmix 的备用域名、`CLIENT_RELAY_API_KEY` 就是 aihubmix 的 key，所以**根本不需要下发第二把**。增强档改为「独立槽位优先、空则回落到中转站那把」（见 §4-26），登录过的机器天然可用。`provisionKeys` 里认 `aihubmixApiKey` 的那段保留——将来真要给增强档单独配一把限额 key，服务端补上字段就能直接用

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

17. **模型必须显式指定，两个 provider 的行为差异（2026-08-16 实测，curl 逐个打过）**
    > **2026-08-17 更正**：`api.inferera.com` **是 aihubmix 的备用域名**，不是另一家中转站——用同一把 key 打两个域名都返回 `claude-opus-5`（`model` 字段原样），且服务端 `CLIENT_RELAY_API_KEY` 与网页版 `AIHUBMIX_API_KEY` 哈希一致（同一把）。所以桌面版从 M0 起就一直在用 aihubmix，只是挂在 `inferera` 这个名字下。下表的行为差异仍然成立（那是端点行为，与域名叫什么无关）。
    ：

    | 发过去的模型名 | inferera 中转站 | DeepSeek 官方 `/anthropic` |
    |---|---|---|
    | `deepseek-v4-pro` / `-flash` | 原样服务 | 原样服务（**只认这两个**） |
    | `claude-sonnet-4-5-20250929`（Agent SDK 的默认值） | 真路由到 Claude Sonnet 4.5 | **HTTP 200，静默降级成 `deepseek-v4-flash`** |
    | `claude-3-5-haiku-20241022` | 映射到 `claude-haiku-4-5` | 同上，静默降级 |
    | 不存在的名字 | 400「cannot be routed」 | 400，且报文里会列出它支持的名字 |
    | `deepseek-chat` | 404 | 200（降级到 flash） |

    所以**不能靠自动映射**：`options.model` 与 `ANTHROPIC_MODEL/ANTHROPIC_SMALL_FAST_MODEL` 一律显式下发。为了能拆穿静默降级，`agent:stream` 的 `assistant` 事件多带一个 `models` 字段（取自 SDK `result.modelUsage` 的 key，即**服务端实际用的模型**），对不上会在日志里打 warn，冒烟脚本直接拿它做断言；2026-08-17 起还会把这次不一致**记进用量记录**（`degraded:true`），`scripts/usage-report.mjs` 收尾会把降级次数单列出来。
    ~~**默认线路暂保持 inferera 中转站**~~ ✅ **2026-08-17 已落地**：档位层上线后，新装机的「标准档」出厂映射就是 DeepSeek 官方（`https://api.deepseek.com/anthropic` + `deepseek-v4-pro/flash`），这条备忘作废。老用户不受影响——迁移会把升级前生效的线路原样搬成标准档映射（见 §4-23）。
    其他实测差异：① DeepSeek 官方会返回 `thinking` 内容块，而我们的流式只转发 `text_delta`，所以首字延迟比 inferera 明显（实测单轮 10.6s vs 4.4s，make-ppt 60s vs 55s）；② inferera 那轮的 `modelUsage` 会同时出现 pro 与 flash（轻量子任务真的走了 `ANTHROPIC_SMALL_FAST_MODEL`）；③ 两边都跑通了工具调用与 make-ppt 全流程。
18. **M-29 的方案取舍：三条缓解，不上助手进程（2026-08-16）**：贵的是「进程内对 safeStorage 的**第一次调用**」（读写都算），实测 8ms～60s 不等，取决于 securityd 的签名校验缓存冷热；**utilityProcess 里没有 safeStorage**（实测只暴露 `net`/`systemPreferences`），所以"整个挪进 worker"在 Electron 30.5.1 下不成立。剩下能彻底不阻塞的只有"常驻第二个 Electron 实例当加密助手"，代价是多一个主进程与多一条打包/公证路径；权衡后**一期不做**，改用指纹判重（不写就不冻）＋ 只读不解密 ＋ 写入转后台任务。根因是 ad-hoc 签名，本来就在「买开发者签名」那条路上，签名后要复测一次再决定要不要上助手进程。
19. **取消投递必须杀「进程组」而不是子进程，且不做回滚（2026-08-16，设计 §5.1）**：`spawn` 起的是 PyInstaller onedir 的引导程序，真正干活的 Python 是它 fork 出来的**孙子进程**。`child.kill()` 只杀得掉直接子进程，孙子会变成孤儿继续写 vault、继续烧 LLM 额度，而 UI 已经显示"已停止"——这比不做取消更糟。所以 `spawn` 加 `detached:true`（子进程成为新进程组组长，组 id == pid，**不调 `unref()`**，我们还要等它的 close），取消时 `process.kill(-pid)`。**不回滚**是刻意的：回滚意味着删用户 vault 里的文件，风险远大于收益；已落位的部分保留、未处理的文件留在投递箱，下次接着做。同一套 kill 也挂在 `before-quit` 上（顺带修掉"退出应用留孤儿 pipeline"这个当时就存在的 bug）。**这条必须在打包形态下回归**——打包后路径与权限都不一样，dev 形态验过不算数。
20. **冲突检测用内容 hash，不用 mtime（2026-08-16，设计 §5.2 / §8 风险 3）**：应用自己 `write()` 也会让 watcher 冒 `change` 事件，不区分的话每次保存都自己给自己报冲突。抑制表按**内容 hash** 匹配：chokidar 的 `awaitWriteFinish`(800ms) 会让事件里的 mtime 与写入那一刻记录的对不上，用 mtime 必漏抑制。`vault:changed` 因此多带一个 `self` 标记。三个时机里**只在保存那一刻打断用户**——编辑期间弹模态会吞掉击键、打断输入法组合，比不提示还差。
21. **`MCNAI_SUPABASE_URL` 只给 e2e 用（2026-08-16）**：验 M-01 的"云端不可达"分支需要把 Supabase 指到别处。踩过的坑：指一个**不可达 IP** 不行（`192.0.2.1` 实测 fetch 9ms 就报 ENETUNREACH，走不到 10s 超时那条分支），要验超时得起一个**连得上但只收不答的黑洞 socket**；验"连不上"才用 `127.0.0.1:9`。生产不读这个变量以外的任何来源，默认值仍写死在 `auth/index.ts`。
22b. **跑走查前先清场：别的 mcn-ai 实例不能盯着同一个库（2026-08-17 踩坑）**。`npm run dev` 起的实例如果 vaultPath 恰好也是走查库（`/tmp/mcnai-e2e-vault`），两边的投递箱 watcher 会抢着起 pipeline。表现极具误导性：走查跑到**最后一条**（before-quit 孤儿检查）才失败，报「有孤儿进程」，而那个进程属于另一个实例、本来就该活着——12 分钟才撞到，结论还完全指错方向。现在 `walkthrough.mjs` 开头会扫 `ps`，发现有 `mcn-ingest` 挂在这个库上就**第一秒拒跑并打印是谁**。
22. **走查专用开关一览（只给 e2e，生产不读）**：`MCNAI_USER_DATA` / `MCNAI_VAULT`（隔离实例）、`MCNAI_APP_BIN`（打包形态回归）、`MCNAI_SUPABASE_URL`（§4-21）、`MCNAI_E2E_VAULT_FAIL=<毫秒>`（让 `vault:createNew` 先卡住再抛错，验 H-12 的失败分支——系统保存框一弹起来 Playwright 就没法继续，这条路只能这么走）、`MCNAI_E2E_TIER_HEALTH=up|down`（强制档位线路探测的结论：`down` 验"增强档置灰+暂时不可用"，`up` 让走查能在没有 aihubmix key 的机器上真的选到增强档——真造这两个分支得把线路打挂或断网）。加新开关的判据：**这条分支在界面上必须能验，而真实触发它需要造只读盘/断网/改系统设置这类走查里做不到的环境**；能用真实故障造出来的（如 M-02 用 chmod 000、M-05 删文件）一律不给开关。
23. **会话级档位：语义写死、映射留运维口（2026-08-17）**。用户看到的只有「标准（推荐）／增强」两档与"能力/消耗"的差别，**界面上不出现供应商名与模型名**——老板要判断的是"这次值不值得多花钱"，不是"这条线后面挂的是谁"。出厂映射：标准=DeepSeek 官方 `deepseek-v4-pro/flash`，增强=aihubmix `claude-opus-5`。映射（base URL / 主模型串 / 轻量模型串 / 各线路 key）全部下沉到设置页的隐藏管理员区，定位是**运维应急**（换模型串、临时切备用线路如 inferera）。
    - **档位是会话级的**：存在 conversation 对象上随对话落盘，新会话一律回到标准档。做成全局设置的话，"上次开了增强"会一直粘着，是最容易把钱烧掉又没人察觉的形态。
    - **增强档的轻量串也钉死 `claude-opus-5`**：aihubmix 上只有它做过真路由验证（响应 model 字段原样返回）。写一个没验过的便宜模型名进去，赌输的形态恰好是"静默降级"，正是这层要防的东西。真要省，管理员区把轻量串换成验过的名字即可（**这是一个明确的省钱开关，验过就该拧**）。
    - **老用户迁移**（`ai/tiers.ts` 的 `migrateTiers`，只跑一次）：机器上配过库或落过任意一把 key = 老用户 → 把升级前生效的那条线路（`describeProvider()`）原样搬成标准档映射，升级不改变现有行为；全新安装才走出厂映射。另有 `ensureStandardUsable()`：标准档一把 key 都没有而中转站那把还在时，自动把标准档指向中转站并**打一条 warn**（不是静默兜底）——覆盖"服务端只下发了 relayApiKey"的新装机。
    - **`resolveTierForRequest` 只在无窗口时才吃 `ANTHROPIC_AUTH_TOKEN`**（走查现场抓到的坑）：开发机上常年挂着自己的 key，有窗口时也吃的话，"这一档没配密钥"那条预检分支在走查里永远触发不到——实测增强档明明没 key，请求还是真的发了出去。无头冒烟（smoke-chat/smoke-agent）没有窗口，照旧从 env 取。
24. **线路健康检查：只探增强档、缓存 5 分钟、`max_tokens:1`（2026-08-17）**。标准档是兜底线路，探它没有意义——它挂了也没有"另一档"可退，只会在每次开应用时多一次请求。增强档不可用时选择器里**直接置灰**，而不是让人选了之后在发送时才撞一鼻子灰。探测用一次 `max_tokens:1` 的 messages 请求而不是 ping 根路径：key 过期这种最常见的失效形态，只 ping 地址压根测不出来。会话进行中失败仍走原有错误重试路径，气泡里额外给一颗「切换到标准模式重试」——只给「重试」的话，用户会在同一条挂掉的线路上反复撞。
25. **用量记录：写入侧不挑字段，归一化全放汇总侧（2026-08-17）**。三条线的 usage 口径都不一样（snake_case vs camelCase、有没有 cache_* 分项、有没有 modelUsage），在写入侧归一化等于把"当时以为对的口径"腌进历史数据，以后想换算法只能重跑。所以 jsonl 里存的是原样的完整 usage 对象，缺则 null；`summarize()` 与 `scripts/usage-report.mjs` 各自归一（两边同一套正则，改一处要改两处）。另外两条：**只记跑成功的那一轮**（失败轮 token 基本是 0，记进去会让「本月对话 N 次」把故障也算成用量）；**写失败静默降级**（记账挡不住主流程）。pipeline 的智能打标拿不到 token，就只记次数（`calls:1`，页面显示「—」）。
26. **增强档的 key：独立槽位优先，空则回落到中转站那把（2026-08-17，返工方案①）**。依据是当天查实的两件事：**`api.inferera.com` 是 aihubmix 的备用域名**、**`CLIENT_RELAY_API_KEY` 与网页版的 `AIHUBMIX_API_KEY` 是同一把**（哈希一致）。也就是说**任何登录过的机器硬盘上早就躺着一把能开 `claude-opus-5` 的 key**，再下发第二把纯属多余，还多一处要维护的密钥——所以 webpage 侧那条"加 `aihubmixApiKey` 下发"的改动直接取消了。
    - 实现在 `ai/tiers.ts` 的 `FALLBACK_KEY_FIELD`：增强档 → `encryptedApiKey`。`describeTier` 里 **`keyField` 始终是这一档自己的槽位**（管理员区那颗「保存」写的是它），回落只影响 `hasKey` 与 `resolveTierForRequest` 读哪一把——否则给增强档填 key 会把中转站那把覆盖掉
    - **回落打日志，不做静默兜底**：`「增强」未配独立密钥，回落到共享密钥 encryptedApiKey（https://aihubmix.com）`，一个进程只打一次（它挂在发消息与线路探测两条高频路径上）。"钱从哪把 key 上扣的"必须查得到
    - 管理员区那一档标「复用中转站密钥」，与「key 已配置 / 未配置 key」并列成三态
    - **将来换限额子 key 零改动**：在管理员区给增强档填一把，`usingSharedKey` 自动变 false，回落不再发生
    - **踩坑**：走查里验这条时第一版挂住了——我用 `evaluate` **直接调 IPC** 写 key，却去等界面那颗保存按钮才会弹的 toast，180 秒白等。直接调 IPC 的路径上没有 toast，要断言就轮询 `ai.tiers()`（明文立刻进内存缓存，`hasKey` 马上翻真）

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
│   │   ├ ai/          tiers.ts(档位→线路映射/老用户迁移) health.ts(线路探测,5min缓存)
│   │   │              provider.ts(历史配置读口 + agentEnv)
│   │   ├ usage/       index.ts：jsonl 落盘 + 汇总（tokensOf 归一化只在这一侧）
│   │   ├ agent/       Agent SDK 会话管理、流式转发
│   │   ├ vault/       index.ts(索引) reader.ts(扫描/解析) watcher graph
│   │   ├ inbox/       orchestrator（队列/进度/落位/分区投递/取消：detached 进程组 + kill）
│   │   ├ ai/          provider（从 webpage 平移）
│   │   ├ knowledge/   云端 ingest/search 客户端 + sync-queue.ts（聊天同步重试器）
│   │   ├ tasks/       registry.ts(任务真相源) types.ts persist.ts(tasks.json 三张表)
│   │   └ auth/        index.ts（supabase-js、anon key 三级来源：env > electron-store > 内置默认）
│   ├ preload/         contextBridge：全部 IPC 通道定义
│   └ renderer/src/
│       ├ pages/       VaultPage / 对话 / 设置（四组卡片+管理员区）/ UsagePage
│       ├ components/  聊天四组件（直搬）+ 产物面板 + 图谱 + TaskDock/OfflineBar/ConflictBar
│       │              + TierSelector（输入框内的档位选择器）
│       ├ hooks/useChatSession.ts   聊天状态机
│       └ hooks/useTasks.ts         任务层渲染镜像（useSyncExternalStore）
├ resources/
│   ├ pipeline/        PyInstaller 冻结的 mcn-ingest（extraResources 分发）
│   └ skills/          make-ppt / make-docx
├ e2e/
│   ├ walkthrough.mjs    E2E 走查脚本（改 GUI 必跑）
│   ├ login-provision.mjs「登录即用」端到端（产出 00b/11/12）
│   ├ external-edit.mjs  模拟「别的程序改了这个文件」（M-27 冲突检测用，必须是外部进程写盘）
│   └ shots/             截图基线（中文命名，按流程编号）
├ release/             构建产物（dmg/zip；「已重签」dmg 是 ad-hoc 重签版）
├ scripts/             构建辅助 + usage-report.mjs（开发者用量/成本汇总，不进 UI）
└ electron-builder.yml / electron.vite.config.ts
```

### 相关外部路径

| 路径 | 用途 |
|---|---|
| `~/Documents/AI/maggie-personal-data` | Maggie 的**源文档**（98 个 docx/xlsx/pdf/pptx，558 MB），回归重跑的输入 |
| `~/Documents/AI/maggie-vault` | Maggie 的旧版产出 vault（372 篇 md，git 仓库，9 个阶段叠出来的），**回归对比基准** |
| `~/Documents/MyBrain` | 开发者本人的 Obsidian vault（求职/刷题），**与 Maggie 无关**——旧版文档误标成「0 号用户 vault」，2026-08-17 更正 |
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

# SamePage 产品审计（PRODUCT-AUDIT）

> 日期：2026-09-02 ｜ 性质：**纯只读调研，未改任何产品代码** ｜ 基线：`main@0965dbb`（0.1.2 已发、0.2.0 批 1–3 已提交未发）
> 目的：系统性对照 Claude Desktop / WorkBuddy 一类成熟产品，摸清架构与功能层面的差距，为 `PLAN-v2.md` 提供事实底座。
> 方法：五路并行实读源码（主进程 / pipeline+云端+更新 / 渲染层 / 五条主链路 / UI 数值统计）+ 逐张检视 142 张截图基线。所有结论带 `文件:行号`，无法从源码确证的标「推断」。
> 参照物缺口：任务书要求对照 `docs/DESIGN-team-edition.md`，**该文件在仓库与本机均不存在**；本文以 `HANDOFF.md` §0-新b「团队版衔接设计」（`scope:'org'`/`version`）与 §3「网关」方案作为团队版目标口径。

---

## 卷一 · 架构审计

### 1.1 真实架构图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 渲染进程  React 18 · sandbox:true · contextIsolation:true · 零 Node           │
│   pages: Workbench / VaultPage(1975 行) / UsagePage / LoginGate / Settings(在 App.tsx 内) │
│   模块级 store: useTasks(任务投影) · step-stream(步骤流) · bus(两条逃生舱)        │
│   localStorage 只存 UI 偏好（昵称/栏宽/localMode/vaultSkipped/artifacts 展开）    │
└────────────▲────────────────────────────────────────┬────────────────────────┘
     invoke（请求响应 ~60 通道）                  send（流式下行）
     settings:* vault:* inbox:* auth:* chat:*     agent:stream · task:event · vault:changed
     ai:* usage:* artifacts:* update:* diag:*     artifact:created · update:ready · agent:confirm-write
┌────────────┴────────────────────────────────────────┴────────────────────────┐
│ preload/index.ts  唯一 IPC 边界（api.d.ts 是契约的单一声明，手工维护）          │
└────────────▲─────────────────────────────────────────────────────────────────┘
┌────────────┴──────────────────── 主进程 Node · Electron 43.4.1 ──────────────┐
│ index.ts 窗口/菜单/生命周期 · before-quit 关 3 个 watcher + 杀 pipeline 进程组   │
│ ipc.ts   handle 注册总线（含 openVault 开库编排等业务逻辑，见越界表）             │
│ ┌ agent/ ─────────────┐ ┌ inbox/ ───────────────┐ ┌ vault/ ────────────────┐ │
│ │ AgentManager        │ │ orchestrator (956行)  │ │ VaultManager 单例       │ │
│ │ SDK query/resume/   │ │ chokidar→debounce 3s  │ │ 内存索引 Map(path 主键)  │ │
│ │ abort · MCP tools   │ │ →spawn pipeline(detached)│ chokidar 增量 800ms    │ │
│ │ write-guard/backup  │ │ →stdout JSON 进度      │ │ searcher→worker 线程    │ │
│ │ steps · attachments │ │ →build_cards→cloudSync │ │ graph · taxonomy ·      │ │
│ │ resume-recovery     │ └──────────┬────────────┘ │ entity-cards(897行)     │ │
│ └──────────┬──────────┘ onRunEnd → artifacts.ts   └────────────────────────┘ │
│ ┌ ai/ ─────┴─┐ ┌ usage/ ──┐ ┌ knowledge/ ───────┐ ┌ tasks/ ──────────────┐   │
│ │ tiers      │ │ jsonl    │ │ client(webpage API)│ │ registry 内存真相源   │   │
│ │ provider   │ │ pricing  │ │ sync-queue         │ │ persist tasks.json    │   │
│ │ health     │ └──────────┘ │ bizdata(钉钉线)     │ │ types 纯函数进度      │   │
│ └────────────┘              └───────────────────┘ └──────────────────────┘   │
│ store.ts(electron-store config.json) · secrets.ts(safeStorage) · auth/(supabase-js 直连) │
│ lib/ logger pipeline routes sensitive diagnostics dingtalk · updater.ts        │
└──────┬────────────────────┬────────────────────────┬──────────────┬───────────┘
   spawn ELECTRON_RUN_AS_NODE  spawn detached 进程组   fetch            electron-updater
       ▼                        ▼                       ▼                ▼
┌──────────────┐  ┌───────────────────────┐  ┌───────────────────┐  阿里云 OSS 公共读 bucket
│ agent 子进程  │  │ pipeline 子进程        │  │ 云端两条腿          │  samepage-updates
│ Claude Agent │  │ mcn-ingest (PyInstaller│  │ ① Supabase 直连：   │  latest-mac.yml → zip
│ SDK CLI      │  │  onedir, 89MB)         │  │   auth / 聊天 upsert│  单渠道 latest · 仅 arm64
│ cwd=vault根  │  │ cli.py 同进程串 02→09  │  │ ② webpage API：     │  无鉴权 · 无回滚
│ transcript 在│  │  →03→03b→07→04→archive │  │   client-config 下发 key │
│ ~/.claude    │  │ 阶段间靠文件系统传状态  │  │   knowledge ingest/search │
│              │  │ key 走 argv（ps 可见）  │  │   (service role, RLS 由服务端解 Bearer) │
└──────────────┘  └───────────────────────┘  └───────────────────┘
```

**各层职责边界与已知越界耦合**

| 层 | 应有职责 | 实际越界 / 耦合（`文件:行`） |
|---|---|---|
| 渲染层 | 纯投影 | 干净。会话列表整份由渲染层持有并回写（`App.tsx:73-95`），是刻意设计但不是任务层的一部分（见 2.3 c3）。 |
| preload | 唯一 IPC 边界 | 干净。`api.d.ts` 与 `tasks/types.ts` 的 Task 联合类型是**手工双份**（`api.d.ts:65,116`）。 |
| ipc.ts | 转发 | **业务逻辑泄漏**：`currentPersonaId/currentLibraryName`（`ipc.ts:32-41`）与 `openVault`（`:360-374`）在这里编排 vault/inbox/artifacts/routes/bizdata 的开库序列；「当前库路径」有三处真相竞争（`store.vaultPath` / `MCNAI_VAULT` / `vaultManager.currentRoot`，`ipc.ts:33/38/55/313/317/351` 重复拼接）。 |
| agent | 对话与工具编排 | 直接碰 vault 文件系统（`agent/index.ts:481` mkdir `90_产物`）、直接 spawn pipeline 渲染器（`:543,570`）、直接调云端 `searchCloud`（`:504`）、直接读 store（`:504`）。 |
| inbox | 投递编排 | 直接调云端 `ingestNote`（`orchestrator.ts:786`）与 `getAccessToken`（`:718`）；直接建实体卡（`:688-708`）；产物入库靠 `onRunEnd` 回调反向耦合到 `artifacts.ts:43`。 |
| vault | 本地 md 真相 | 全局单例（`vault/index.ts:312`），agent/inbox/knowledge/assets/diagnostics/ipc 全部直接 import。 |
| store / tasks | 配置 / 状态 | 两个**星形中心**：`store` 被 12 个模块直接 `get`；`tasks/registry` 被 8 个模块直接写。无运行时循环依赖（已逐条核对）。 |
| pipeline | 转换/打标/建链 | `01/05/06/08` 四个脚本不在 `cli.py` 链上、也不在 `mcn-ingest.spec:23` 冻结清单里，README 仍按老链描述（`pkb-pipeline/README.md:5-39`）。 |

### 1.2 架构债逐项清单

标注：**影响面**（用户/开发/运维）｜**演进阻碍**（模板系统 · 团队版 · 移动端：挡路 / 加成本 / 不挡）｜**修复成本**（小 <1 天 / 中 1–3 天 / 大 >3 天）。

#### (a) 写死假设

| # | 债 | 证据 | 影响面 | 模板 · 团队 · 移动 | 成本 |
|---|---|---|---|---|---|
| a1 | **对话 system prompt 写死 MCN 身份**，完全绕过 taxonomy/persona 配置。打标那条线已走 persona，唯独用户天天面对的对话没走 | `agent/index.ts:290`「你是 SamePage——MCN 公司与带货达人的 AI 工作台」、`:314` 规则 11「达人用艺名」；`taxonomy.ts:49` persona.role 已存在 | 用户（管理咨询客户一开口就穿帮） | **挡路** · 挡路 · 不挡 | 小 |
| a2 | 产物目录 `90_产物` 写死在 agent 与 write-guard，未走 `layout.json.artifacts` | `agent/index.ts:481`、`write-guard.ts:56`；而 `artifacts.ts:58` 已走配置——同一概念两套读法 | 用户/开发 | 挡路 · 不挡 · 不挡 | 小 |
| a3 | **supportedExt 散在 6 处**：TS 两份 + pipeline 四处 | `orchestrator.ts:37`、`attachments.ts:27`、`02_convert.py:335`、`cli.py:384/107/473`、`04_gen_moc.py:17`（0.1.2 加 `.doc` 时已踩过一次） | 开发/用户 | 加成本 · 加成本 · 加成本 | 小 |
| a4 | `INBOX_FLOW` 八阶段与 pipeline 阶段名双份镜像 | `tasks/types.ts:116-130` | 开发 | 不挡 | 小 |
| a5 | 模型串在 tiers / provider / pricing 三处各写一份 | `tiers.ts:47-66`、`provider.ts:40-68`、`pricing.ts:126-146` | 开发/运维 | 不挡 | 小 |
| a6 | **taxonomy 的兜底真相是 MCN 而非中性**：任何字段缺失 → 回落 `MCN_PRESET`（`40_带货`、「OMG美妆」、bizdata feature） | `taxonomy.ts:228-229,246,284-296`；`taxonomy.py:42` 镜像；`GENERAL_PRESET` 只是 MCN 的字段改写（`:151`） | 用户（非 MCN 库缺字段时长出 MCN 目录） | 加成本（模板必须写全 12 字段） · 加成本 · 不挡 | 中（牵动「老库一字不漂」红线 + py 镜像 + 黄金母本） |
| a7 | **taxonomy TS/Python 两侧手写镜像**，靠 `smoke:taxonomy` 契约测试守 | `taxonomy.py:1-9`、`taxonomy.ts:22-27` | 开发 | 加成本 · **大**（下发配置时这层必须还在或收成一份） · 大（第三个运行时=第三份镜像） | 中～大 |
| a8 | 实体种类 talent/product/partner 写死贯穿建卡/图谱/taxonomy/pipeline frontmatter 契约 | `entity-cards.ts:30-36`、`taxonomy.ts:29,198`、`graph.ts:11-13`、`07_sensitive_enrich.py` | 用户/开发 | **挡路**（别的行业没有「达人」） · 不挡 · 不挡 | 大 |
| a9 | 实体读/写目录故意不对称：写卡到 `30_实体/*`，扫描建链读老库 `20_公司管理/25_达人档案` | `taxonomy.ts:113,198`、`taxonomy.py:33` | 实体建链质量 | 加成本 · 加成本 · 不挡 | 中 |
| a10 | 经营数据落位路径由服务端下发、persona feature 门控，桌面端无从校验 | `bizdata.ts:19,31-33`、`ipc.ts:372` | 用户/运维 | 加成本（跨仓库） | 中 |
| a11 | embedding 模型与 1536 维写死在迁移与常量里，换模型=全量重灌 | `010:59`、`012:12`、`embeddings.ts:12-13` | 运维 | 不挡（但成本恒高，团队版数据量放大后更贵） | 大 |
| a12 | 云端 layers `['platform','org','private']` 桌面端只写 private；org 层 schema 就绪、写入链路空 | `search/route.ts:32`、`ingest/route.ts:47` | — | 不挡 · **大**（org 层是团队版主战场） · 不挡 | 中 |
| a13 | client-config 契约漂移：客户端读 `aihubmixApiKey`，服务端从不返回；注释写「低配额子 key」实际是主 key | `auth/index.ts:188,203` vs `client-config/route.ts:16-22,8` | 运维 | 加成本（网关会重写） | 小 |
| a14 | 文档漂移：`updater.ts:23` 与 HANDOFF §0 待办 #7 仍写占位 `.invalid`，而 `electron-builder.yml:72` 已是真实 OSS 地址，判据恒假 | 同左 | 开发（误导接手人） | 不挡 | 小（改文档） |

**已收口、不再是债的**（复查确认）：`layout.json` 5 处读取（taxonomy 收口）、`apiBaseUrl`（store 单一真相）、版本号（`app.getVersion()`）、Supabase URL/anon key 三级来源、组件层颜色字面量（实测 0 处）。

#### (b) 单点脆弱

| # | 债 | 证据 | 影响面 | 模板 · 团队 · 移动 | 成本 |
|---|---|---|---|---|---|
| b1 | **inbox `run()` 串行守卫在「换库 mid-pipeline」下失配**（HANDOFF §3-10 未查清机制的源码级最可能路径，**推断**）：`stop()` 只关 watcher、不杀 child、不重置 `running`；`run()` 尾段读 `this.vaultRoot/taskId`，换库后 buildCards/cloudSync 对**新库**执行；`hasChild()` 只认最新 `this.child`，旧 child 成孤儿——与观察到的「两个 mcn-ingest / before-quit 只杀一个」吻合 | `orchestrator.ts:333-337, 508, 817, 899-944` | 运维/用户（孤儿写旧库、烧额度、退不掉） | 不挡 · **挡路**（服务端化前并发模型必须理清） · 不挡 | 中（stop 加 kill+reset；尾段快照局部变量；换库时 running 则先 cancel） |
| b2 | agent 一轮**无墙钟超时**，只有 `maxTurns:40` + `SCAN_LIMIT:5` | `agent/index.ts:689,120` | 用户/运维 | 加成本（网关要有硬超时/配额） | 小 |
| b3 | before-quit 只杀 inbox pipeline，**不 abort agent 的 SDK CLI 子进程**（推断孤儿） | `index.ts:157-189` | 运维 | 不挡 | 小 |
| b4 | pipeline stderr 整条丢弃，崩溃无 traceback；`.failed/失败原因.txt` 是 archive 阶段产物，崩溃时到不了 | `orchestrator.ts:883` | 用户/运维（不可诊断） | 不挡 | 小 |
| b5 | 上游 LLM key 以**命令行参数**下发 pipeline，`ps` 可见（cli.py 收到后才转 env） | `orchestrator.ts:832,447` → `cli.py:140,179` | 安全 | 不挡 · **挡路**（多用户服务器上=直接泄漏） · 不挡 | 小（改 env 传）；根治靠网关 |
| b6 | 冻结产物 sha 不随阶段脚本变，无法用二进制哈希做版本指纹；hiddenimports 漏项只有打包形态才炸；pipeline **零单测**、LLM 阶段无桩 | `mcn-ingest.spec:11-23`；`03_tag_llm.py:56` 直接 urllib | 发版可靠性 | 不挡 | 小～中 |
| b7 | `.doc` 转换硬依赖 macOS `textutil` | `02_convert.py:333,339` | 跨平台 | 不挡 · 加成本（pipeline 搬 Linux 服务端） · 加成本 | 中 |
| b8 | Supabase 免费版 7 天暂停 → NXDOMAIN → 登录链路体感「打不开」；保活已议未做 | HANDOFF §3 bug#2 | 全部云功能 | 不挡 | 小 |
| b9 | 更新源单点：单公共 bucket、无鉴权、单渠道、仅 arm64、无回滚 | `electron-builder.yml:70-73`、RELEASE.md §C | 所有客户升级通道 | 不挡 · 加成本（按 org 灰度） | 中 |
| b10 | agent draft 只在内存，崩溃/强杀整轮半截回答丢失，无中断提示 | `agent/index.ts:466-472` | 用户 | 不挡 | 小 |
| b11 | search-worker 崩溃只 `console.error`，不重建、不通知，此后检索静默回空 | `searcher.ts:29,99-102` | 用户 | 不挡 | 小 |
| b12 | vault 目录被外部改名/移动/iCloud 抽走 → chokidar 静默停摆，界面显示旧索引 | `vault/index.ts`（无 watcher error/unlinkDir 处理） | 用户（MCN 场景常用同步盘） | 不挡 | 中 |

#### (c) 状态一致性

| # | 三份真相 | 现状 | 失步窗口 / 对账 | 模板 · 团队 · 移动 | 成本 |
|---|---|---|---|---|---|
| c1 | **内存索引 ↔ 磁盘 md ↔ 云端 knowledge_chunks** | 内存靠 open() 全扫 + chokidar 800ms 增量 + 索引就绪闸门；磁盘→云只在 `cloudSync` 按 mtime 挑变更推（`orchestrator.ts:716-813`），单篇按 `(owner, file_path)` 先删后插（`ingest.ts:79-85`） | **无对账、无删除同步**：本地删/改名/移动后旧 `file_path` 切片永远留在云端；`deleteNote`（`vault/index.ts:271`）不通知云端。R-02「敏感篇不再 ingest 就删不掉旧切片」是它的一个特例。`searchBackend=local` 出厂暂时回避 | 不挡 · **挡路**（云端转主后放大成脏数据） · 加成本 | 大（删除/改名协议跨 desktop/webpage/DB） |
| c2 | tasks registry 内存 ↔ `tasks.json` | 「进行中」永不落盘，snapshot 权威 + seq | 健壮，无失步 | — | — |
| c3 | electron-store conversation ↔ 云端 conversations/messages | 本地权威（`client.ts:91`），云端 upsert 尽力；重试只补最后两条，可能重复一条 | 权威清晰；团队版要反转成「服务端权威」时这条整条重写 | 不挡 · 加成本 · 加成本 | 中 |
| c4 | `sdkSessionId`(对话) ↔ transcript(`~/.claude/projects/<cwd>`) | cwd=vault root，换库即全部失效，靠 resume-recovery 降级重开 | 表现已兜住；**耦合本身是架构性的** | 不挡 · **挡路**（多用户共享主库时 cwd/transcript 绑本地路径不成立） · 挡路 | 大 |
| c5 | checkpoint `.checkpoint.jsonl` ↔ 实际笔记 | 按 (path, rev) 判重，只增不减 | 改名后旧 path 成僵尸行，无害但累积 | 不挡 | 小 |
| c6 | cloudSync 判敏感必须**读盘**不读内存（建卡刚写完、800ms 内索引没有它） | `orchestrator.ts:743-767` | 已修，但属「不能赌时序」的既有脆弱点 | — | 已修 |

#### (d) 可测性盲区

**只有真实 LLM / 真实网络 / 打包形态才走到的分支：**

| 分支 | 位置 | 已抽纯函数？ |
|---|---|---|
| agent result 处理：modelUsage 降级检测、T-02 `is_error+subtype:success`、记账 hasTokens 门、B-6 未验证引用 | `agent/index.ts:791-869` | **否**，靠 `smoke:provider` 花钱验 |
| `resume-recovery.isResumeLost` | `resume-recovery.ts:43` | 是（`smoke:resume`） |
| `ai/health.probe` | `health.ts:45-97` | 否，靠 `MCNAI_E2E_TIER_HEALTH` 开关 |
| `updater.ts` 整个（`app.isPackaged` 门、feedUrl、autoUpdater 事件） | `updater.ts:75` | 否，**不可本地测**；0.1.2「卡在正在重启」正是没测出来 |
| `client.cloudSync/ingestNote/searchCloud`、`auth.provisionKeys/probeCloud/login` | — | 否，真实 webpage/Supabase |
| `secrets` safeStorage 冷调用 | `secrets.ts:123-144` | 否，真机 Keychain |
| pipeline `03_tag_llm` 打标输出（frontmatter 字段、成本、熔断）、`07/04` 建链与 MOC 正确性 | pipeline | 否，`smoke:pipeline` 只覆盖 `--skip-llm` 那半条 |
| 打标 token 回传 | `03_tag_llm.py:220` 只写 checkpoint 从不 emit，`_tag()` 返回 None（`cli.py:403`） | **通道本身不存在**——bug#8「98.7% 打标花费不入账」的代码级根因 |

**已抽成纯函数、零成本可测的**：`computeInboxProgress/judgeBackfill`（`tasks/types.ts:146,200`）、`hasSensitiveMark`、write-guard `judgeWrite`、taxonomy `resolveConfig`、entity-cards 归一、usage `tokensOf`/`costCny`、steps `pickStepArgs/countToolResults`、search-worker `cleanQuery/runSearch`。

盲区评级：**agent result 处理**与**更新链路**最大；pipeline 的 LLM 阶段次之。

#### (e) 扩展阻力：加一样东西各要动几层

| 要加的东西 | 要动的层与文件 | 阻力 |
|---|---|---|
| **一个建库模板** | `vault/taxonomy.ts` 新 PRESET + `PRESETS`/`PresetId`；`preload/index.ts:59` + `api.d.ts:383` 联合类型；渲染层向导；`taxonomy.py` 镜像；`smoke:taxonomy` 黄金母本 | 低（架构已为此设计），但 5 处 |
| **一种文件类型**（.epub / OCR PDF） | TS：`orchestrator.ts:37`、`attachments.ts:27`；pipeline：`02_convert.py:335` CONVERTERS、`cli.py:384/107/473`、`04_gen_moc.py:17`；OCR 还要依赖与冻结体积 | 中（6 处扩展名 + 跨仓库） |
| **一个连接器**（飞书/钉钉文档） | `knowledge/<connector>.ts`（参照 bizdata，但 bizdata 直接 `fs.writeFile` 绕过 watcher 自触发抑制会自报冲突，`bizdata.ts:37`）+ `ipc.ts` 开关 + `store` 字段 + `taxonomy` feature 门控 + webpage 路由 | 中～大（跨仓库，且写 vault 的一致性要处理） |
| **一个 agent 工具** | `agent/index.ts:484-580` tools 数组 + `:591` allowedTools + `:290` prompt；`steps.ts:103,179,68`；渲染层 `config/steps.ts` 文案；写工具还要过 `write-guard.judgeWrite` | 中（集中在一个 928 行文件） |
| **一种任务类型进 TaskDock** | `tasks/types.ts:9,49,94` + `api.d.ts:65,116` **手工镜像** + 产生方 + TaskDock 渲染分支 + （可选）persist | 中（types/api.d.ts 双份是主要摩擦） |
| **换 embedding 模型** | 迁移维度 + 全量重灌 + `embeddings.ts` | 大 |
| **非 Supabase 存储后端** | `lib/knowledge/*` 直接 `createAdminClient().rpc(...)`（`search.ts:45`），无抽象层 | 大（重写知识层） |

### 1.3 对照团队版：走向服务端化要重做什么

团队版目标（HANDOFF §0-新b + §3 网关）：主库上服务器 · 分类配置随主库下发仅管理员可改（`scope:'org'`）· key 不下发客户端走网关 · 按用户配额限流 · 服务端记账。

| 模块 | 平移 / 重做 / 拆 | 依据 |
|---|---|---|
| `ai/tiers` | **拆**：base URL 换网关即可（架构已预留）；key 回落/迁移逻辑（`tiers.ts:90,175-248`）整套作废；`agentEnv` 注入网关短 token | `provider.ts:107` |
| `ai/health` | **重做**：探测改打网关，可用性语义随配额变 | `health.ts:68` |
| `usage` | **拆/重做**：现只在客户机 jsonl（`usage/index.ts:59,75`），服务端记账后退化为本地镜像；pricing 全部上移 | — |
| `auth` | **拆**：只有 email/password（`auth/index.ts:105`），无组织/角色；session 存储可平移 | — |
| `vault` 索引 | **重做**：以本地 fs 相对路径为主键（`vault/types.ts:2`，graph/searcher/双链全绑 path）；主库上服务器后要换稳定 doc id | — |
| `agent` cwd/transcript | **拆**：cwd=vault root（`agent/index.ts:588`）+ transcript 落 `~/.claude`；多用户共享主库时会话恢复模型整体换服务端存储 | `resume-recovery.ts:5-27` |
| `knowledge/client` | **平移**：私人层已走 webpage API + Bearer（`client.ts:22-37`），本就是网关雏形 | — |
| `taxonomy` 下发 | **格式已预留，链路要做**：`scope:'org'` 只在格式里（`taxonomy.ts:73-77`），服务端下发 + 客户端只读 + 管理员 UI 全没有 | — |
| `inbox/pipeline` | **拆/重做**：留客户端则上云主键要带 org、敏感判定要服务端复核（现纯客户端 `store.sensitiveAllowCloud` 说了算）、key 经网关；搬服务端则 `textutil` 不可用、冻结形态改常驻服务、进度从 stdout 改 HTTP/WS 流。**建议短期留客户端 + 网关持 key，中期把打标（唯一花钱触网的阶段）搬服务端** | `orchestrator.ts:742` |
| knowledge 主键 | **不够**：`(owner_user_id, file_path)` 是私人层语义；共享库需 `(organization_id, file_path)` + 编辑者字段 + RLS/RPC org 共享分支（RLS org 可见性已在 `010:43-46`，RPC org 分支已在 `012:49-51`，缺的是桌面端从不写 org visibility） | `ingest.ts:83-84`、`011:8-9` |
| IPC 契约里假设本地 FS 的点 | **要审**：`vault:*` 全套（read/write/writeChecked/createNote/deleteNote/reveal/openFile，`ipc.ts:212-232`）、`inbox:enqueue`（拷进本地投递箱）、`artifacts:open/reveal`（`shell.openPath`）、`files.pathFor` | — |
| 更新链路 | **建议分渠道**：按 org 灰度 + 私有 bucket/签名 URL，与网关鉴权同一条基础设施 | `electron-builder.yml:73` |

**「现在不改、团队版时会更贵」的点（按贵的程度排序）：**

1. **vault 索引 path 作主键**（`types.ts:2`）——现在换稳定 id 便宜；图谱/双链/云端 `file_path` 全绑 path 之后再换面积成倍。
2. **云端切片只增不删、无对账**（c1）——团队共享库会累积成检索污染，团队版前必须先有删除/改名协议。
3. **agent cwd=vault root 绑 transcript**（`agent/index.ts:588`）——多用户共享主库时会话恢复模型整体换。
4. **knowledge 按 owner 灌满存量**——团队版迁移要动存量数据，比现在改 schema 贵得多。
5. **对话 system prompt 写死 MCN**（a1）——多组织多行业下每个客户都撞。
6. **usage 只有本地 jsonl + 打标 token 无回传**——服务端记账要新造整条链路 + pipeline 先 emit usage。
7. **key 走 argv**（b5）+ 每加一处 key 回落逻辑都是网关后要删的债。
8. **taxonomy 双镜像**（a7）——再加一个运行时就是第三份。
9. **搜索 file_path 缺失导致 `searchBackend` 钉在 local**（HANDOFF §3-13）——团队版必须走云端语义检索，不修则问库体验直接退化。
10. **embedding 维度写死**（a11）——团队版数据量更大，届时重灌成本指数级。

### 1.4 卷一结论：最重要的 8 条

1. 对话 prompt 写死 MCN（a1）——去 MCN 化的最大漏网，修复成本小、演进价值最高。
2. 换库 mid-pipeline 的孤儿进程路径（b1）——bug#10 的源码级解释，孤儿写旧库烧额度。
3. 三份真相无删除同步（c1）——团队版最贵的一笔。
4. path 主键 + cwd 绑 transcript（c4 / 团队版 1、3）——两条深植的本地文件系统假设。
5. 打标 token 无回传通道（d）——bug#8 根因，服务端记账依赖它。
6. agent 无墙钟超时 + result 分支不可测（b2 / d）——最易出问题的逻辑恰是最难测的。
7. key 走 argv（b5）——当下就存在的泄漏出口。
8. supportedExt 六处 + taxonomy 双镜像（a3 / a7）——每次扩展都在同一个坑上。

---

## 卷二 · 功能审计

### 2.1 逐场景功能层缺陷

每条标：**撞上时刻**（用户在什么时候撞上它）。凡 `docs/UX-AUDIT.md` 已标 P2/P3 未排期而至今未动的，注「UX-审计已记」。

#### 首跑 / 登录

| 缺陷 | 证据 | 撞上时刻 |
|---|---|---|
| 邮箱框回车不提交（只有密码框绑了） | `LoginGate.tsx:52-58` 无 onKeyDown | 填完账号习惯性按回车，什么都不发生（UX-审计 M-23） |
| 本地/降级模式下没有「重连云端」入口，只能退出登录再走登录门 | `App.tsx:125,1178` | 家里网络恢复后想用云端功能，得先登出（推断） |
| LLM（入库/嵌入）key 下发失败无手填/重取入口；`settings.setLlmKey` 主进程有、渲染层零调用 | `api.d.ts:44`、`AdminZone App.tsx:1028` | provision 没下发成 LLM key 时入库打标静默降级，设置页无补救（H-06 的同类洞） |

#### 对话工作台

| 缺陷 | 证据 | 撞上时刻 |
|---|---|---|
| **草稿输入框内容不持久**：切会话即清空，崩溃/退出全丢 | `Workbench.tsx:93-97` | 打了半段长提示词，顺手点了侧栏另一个对话 |
| **用户消息不能复制、不能编辑重发** | `Workbench.tsx:336-366` | 想改一个词重发只能全文重打（UX-审计 L-12） |
| **成功回答无「重新生成」**，retry 只在错误气泡 | `Workbench.tsx:170,390` | 回答没错但不满意（对标清单 P1） |
| 代码块无「复制代码」按钮 | `components/Markdown.tsx` | 让 AI 写脚本后只想复制代码块 |
| 产物「预览」展开后无收起入口 | `Workbench.tsx:846-853` | 预览一篇后想收起（UX-审计 L-04） |
| 产物面板硬截断 30 条、无「打开产物目录」出口 | `agent/artifacts.ts:113`、`Workbench.tsx:808-861` | 用久了旧产物从界面消失（UX-审计 M-12） |
| **对话无重命名 / 置顶 / 归档 / 导出 / 内容搜索**，侧栏只有删除 | `App.tsx:400-445` | 对话一多，18 字自动标题的列表管不了（对标清单 P1） |
| 附件重启后只剩文件名，无「翻历史取回附件」 | `App.tsx:79-84` | 刻意取舍，已知 |
| 一轮的 token/耗时/花费在对话里不显示；**档位静默降级只进日志**，界面照常显示「增强」 | `App.tsx:554` 注释；HANDOFF §2-17 `degraded` | 为增强档付费却无法确认拿到没拿到 |
| 产物轮的折叠摘要说「未找到相关资料」 | `step-stream.ts:289-292`（R-09） | 生成了 PPT 却被告知没找到资料 |
| 步骤流与正文上下分离而非按时间交织 | roadmap 备忘 | 步骤说检索到了、正文说没找到时矛盾感最强 |

#### 知识库

| 缺陷 | 证据 | 撞上时刻 |
|---|---|---|
| **无多选、无批量操作**（删除/入库/重命名都是单个） | `VaultPage.tsx:1219` Tree 无多选态 | 想一次删一批旧笔记 |
| **失败件无应用内批量重试**，只有「打开 .failed 目录」 | `VaultPage.tsx:331-361` | 30 个 PDF 有 8 个失败，只能去 Finder 重拖 |
| 失败清单无常驻页，只在本轮任务 stages 与 `.failed/失败原因.txt` | 同上 | 过几天想回看上次哪些没进来 |
| 文件不能拖拽移动/排序、无「移动到」 | `api.d.ts` 无 move 通道 | 想把笔记从 A 目录挪到 B |
| 搜索只有当前库全文：无标签/frontmatter 筛选、无反向链接面板、无图谱内搜索 | `vault.search(q)`；对标清单 P1 | 想看「所有 #达人 笔记」或「谁链到这篇」 |
| 搜索框无键盘能力（Esc/Enter/上下键/Cmd+F 聚焦） | `VaultPage.tsx:925-930` | 高频搜索离不开鼠标（UX-审计 M-24） |
| 文件树无虚拟化，`countNotes` 渲染期调两次 | `VaultPage.tsx:1219,525,932` | 几千篇的库展开顶层掉帧（UX-审计 M-25） |
| 关系图无节点上限、`autoPauseRedraw={false}` 持续重绘 | `VaultPage.tsx:1936,1970` | 563 节点的 Maggie 库开图谱风扇起飞（UX-审计 M-26） |
| 笔记头部 ··· 重命名失败吐 `String(e)`，右键重命名走 `errText` | `VaultPage.tsx:1535` vs `:715` | 同一操作两套错误文案（UX-审计 L-07） |
| 升级过的库同一实体两个同名节点（旧目录 vs `30_实体`） | HANDOFF §2-20 数据事实 | 图谱上两个「霞飞」颜色还不一样 |

#### 设置与管理员区

| 缺陷 | 证据 | 撞上时刻 |
|---|---|---|
| **导出诊断报告静默失败**：无 try/catch、无 busy、无条件 toast「已导出」 | `App.tsx:1214-1222` | 客服排查的最后抓手在满盘/无权限时失明（UX-审计 M-08） |
| **分流规则 ✕ 一点即删、即时落盘、无确认无撤销** | `App.tsx:710-717` | 以为只是隐藏一条规则（UX-审计 M-17/18） |
| 分流规则表单回车不提交 | `App.tsx:722-734` | UX-审计 L-08 |
| 昵称 / 服务器地址 onBlur 保存、无反馈、切页丢输入 | `App.tsx:1189,1110` | 改完直接点侧栏切页，改动丢失（UX-审计 M-09） |
| **敏感资料档位升到「与普通文件相同」（=上云）无二次确认** | `App.tsx:640-643` | 误点即开始把人事/财务上云（推断） |
| 钉钉设置无界面，而 store 默认 `notifyInbox` 开 | `settings.setDingtalk`/`dingtalk.test` 渲染层零调用 | UX-审计 L-10 |
| 五条 `settings.set*` / `ai.setTierConfig` 返回 `{ok}` 但渲染层丢弃、无成败反馈 | `App.tsx:593,642,772,893,1110` | 改了没生效也不知道 |

#### 用量页

| 缺陷 | 证据 | 撞上时刻 |
|---|---|---|
| 只能看当月，无月份切换；`usage.months()` 主进程有、界面不调 | `UsagePage.tsx:61-68` | 想看上个月花了多少 |
| 打标花费不入账（98.7% 看不见），页面只加了一句「未计入」 | bug#8 | 用量页金额与账单对不上 |

#### 全局

| 缺陷 | 证据 | 撞上时刻 |
|---|---|---|
| **无 React ErrorBoundary**：一次渲染异常整屏白屏，无重载/诊断出口 | `main.tsx:19-28` | 一条脏 frontmatter 就白屏（UX-审计 M-15） |
| **快捷键只有 Cmd+N**：无 Cmd+K/F（搜索）、Cmd+,（设置）、Cmd+W、Esc（退出编辑/关笔记）、上下键选会话 | `main/index.ts:103`、`App.tsx:132-137` | 从 Claude Desktop/Obsidian 过来的用户天天撞（UX-审计 L-11/M-22） |
| 窗口尺寸/位置不记忆；深色模式不跟随系统 | 对标清单 P1/P2 | 每次开都是默认尺寸 |
| 对话生成中崩溃/强杀 → 半截正文随进程丢，重开只见提问 | HANDOFF T-01 未做 | AI 写到一半应用崩了 |

**「主进程实现了但没 UI 入口」5 条**：`settings.setLlmKey`、`settings.setDingtalk`、`dingtalk.test`、`usage.months`、`inbox.pending`。前三条是真缺口。**「UI 调了主进程静默无 handler」：0 条**（逐通道核对）。

#### 状态管理体检

- `App.tsx` 1246 行：应用壳只占前 ~494 行，其余全是设置页构件（可拆 `pages/SettingsPage.tsx`）；`VaultPage.tsx` 1975 行承担约 10 类职责，`Explorer` 一个函数内 `useState/useRef` 逾 20 个。
- 会话数据整份由渲染层持有并回写（`App.tsx:73-95`），跨设备同步拉下来的记录渲染层不会知道（推断）。
- 各设置子组件各自 `settings.get()` 后 `useState` 缓存，彼此不共享。
- localStorage 7 个键全是 UI 偏好，无业务真相源，健康。任务/步骤流/云端状况已在主进程或模块级 store，符合 DESIGN-task-state 约定。

### 2.2 核心链路健壮性：失败模式与「静默」

五条链路的完整失败模式表（触发条件 × 当前处理 × 用户看到什么 × 数据后果）见附录 A；这里只列**静默全清单**（目标：全部消灭）与恢复矩阵。

#### 静默全清单

| # | 静默点 | 后果 | 最小可见化做法 | 成本 |
|---|---|---|---|---|
| Q1 | pipeline stderr 整条丢弃（`orchestrator.ts:883`） | 崩溃无原因，不可诊断 | 缓存 stderr 末 2KB，close code≠0 时写进任务 `error` + 主日志 | 小 |
| Q2 | **入库笔记 `ingestNote` 失败文案称「已进重试队列」，实际 syncQueue 只服务聊天，无笔记重试队列**（`orchestrator.ts:803` 文案 vs `sync-queue.ts` 只处理 `syncConversation`） | 失败笔记永不重传，云端静默缺篇 + 文案说谎 | 真建笔记重试队列（复用 syncQueue 机制），或文案改「M 篇未上云，下次入库自动重试」并让下轮 cloudSync 覆盖 | 中 |
| Q3 | 换库/退出时 `stop()` 不杀在跑 pipeline、不重置 running（`orchestrator.ts:333-337`，bug#10） | 孤儿写旧库、烧额度 | `stop()` 里 `killGroup` + 重置 running | 小 |
| Q4 | agent SDK CLI 子进程退出时不清理（`index.ts:157-189`，推断） | 生成中退出留孤儿 | before-quit 里 `abortAll()` | 小 |
| Q5 | vault 被外部改名/移动/iCloud 抽走 → chokidar 静默停摆 | 界面显示旧索引，投递/保存静默失效 | 监听 watcher error / root unlinkDir → Condition「知识库已失联」顶条 | 中 |
| Q6 | search-worker 崩溃不重建（`searcher.ts:29`） | 此后检索全静默回空 | 重建 worker + 一次性提示 | 小 |
| Q7 | 产物轮折叠摘要「未找到相关资料」（`step-stream.ts:292`，R-09） | 界面自打脸 | summaryText 加第三分支「已生成产物」 | 小 |
| Q8 | `unverifiedCitations` 主进程只 `log.warn`（`agent/index.ts:868`） | 错误引用是否呈现取决渲染层（待确认） | 气泡角标「N 处引用存疑」 | 小 |
| Q9 | `quitAndInstall` 抛错只 `log.error`（`updater.ts:183`） | 卡「正在重启」无下文 | push `update:state{phase:error}` | 小 |
| Q10 | convert 崩溃 → 原件滞留投递箱 → 重启 watcher `ignoreInitial:false` 重拾（`cli.py:453`、`orchestrator.ts:309`） | 坏文件每次启动重跑整条链、反复烧额度（推断） | 连续失败 N 次的文件移入 `.failed` 并记原因 | 中 |
| Q11 | `probeCloud` 无周期重探（`auth/index.ts:234`，R-05） | 网络恢复后离线条滞留 | 离线态 60s 退避重探（设计 §1.4 本就写了） | 小 |
| Q12 | 后台例行查更新失败只 log（`updater.ts:163`） | 刻意静默，理由成立 | 保留；只在「手动检查更新」入口报错 | — |
| Q13 | `diag.export` 无 catch、无条件 toast 成功（`App.tsx:1214`） | 导出失败被说成成功 | try/catch + busy 态 | 小 |
| Q14 | 五条 `settings.set*` 返回值被丢弃（`App.tsx:593,642,772,893,1110`） | 保存失败无反馈 | 统一 toast 成败 | 小 |
| Q15 | 档位静默降级只 warn + 记 `degraded` | 用户以为用了增强档 | 气泡或步骤流角标「本轮实际按标准档计」 | 小 |

Q2 / Q3 / Q5 / Q10 是真数据或状态缺口，优先。

#### 恢复能力矩阵

| 场景 | 入库 | 问答 | 生成 | 同步 | 更新 |
|---|---|---|---|---|---|
| 渲染崩溃（`render-process-gone`→reload） | Dock 从 `tasks:list` 补齐，无损 | draft 在主进程，无损 | 无损 | 无影响 | `update:state` 补齐 |
| 应用被强杀 | 投递箱残留文件重启被 watcher 重拾；被杀瞬间 detached 组可能残留（推断） | **内存 draft 丢**，本地历史在，resume 重开 | pending 集合丢，靠 ingested 表判 | syncQueue 落盘，重启补跑 | 缓存包在，重启秒出提示 |
| 正常退出 | before-quit 杀进程组等 close | live map 未显式 abort（Q4） | 同上 | 落盘 | autoInstallOnAppQuit；**inbox 有活 + 3s 超时 → `app.exit(0)` 跳过安装**，下次启动仍旧版 |
| 断网 | 本地阶段照跑；cloudSync 报 error | local 检索不依赖网；LLM 失败中文气泡+重试 | 本地渲染无损；入库上云进「假重试队列」（Q2） | 入队、离线条亮；恢复后条滞留（Q11） | 下载态报错 / 查更新态静默 |
| 断电 | = 强杀 + `fs.writeFile` 非原子可能半截 md（推断） | = 强杀 | = 强杀 | 可能丢最后一条失败记录（推断） | 重启重下 |

**幽灵态**：bug#10 孤儿 pipeline（最实在）；Q4 agent 子进程（推断）；强杀后短暂孤儿。「永不结束的假任务」这一条被「进行中不落盘」的设计守住了。

### 2.3 卷二结论：最痛的 12 条（用户撞上概率 × 后果）

1. 无 ErrorBoundary → 整屏白屏（`main.tsx:19`）
2. 草稿输入框切会话/崩溃即丢（`Workbench.tsx:93`）
3. 入库上云失败「假重试队列」，云端静默缺篇（Q2）
4. 换库/连续拖入产生孤儿 pipeline 写旧库烧额度（Q3 / b1）
5. 对话无重命名/搜索/置顶/导出（`App.tsx:400`）
6. 失败件无应用内批量重试（`VaultPage.tsx:331`）
7. 分流规则删除无确认、即时不可逆（`App.tsx:711`）
8. 敏感档升「上云」无确认（`App.tsx:640`）
9. 导出诊断报告静默失败（`App.tsx:1214`）
10. 快捷键近乎为零（`main/index.ts:103`）
11. vault 被同步盘抽走静默停摆（Q5）
12. 档位是否真跑了增强、单轮花了多少不透明（Q15）

---

## 卷三 · UI 审计（简版）

### 3.1 截图基线检视

对 `desktop/e2e/shots/` 142 张截图逐张检视，合并去重后约 28 条缺陷，分布：**文案 11**、空态/错误态/toast 语义 6、视觉一致性 3、信息层级 3、微交互 1、可访问性 1（另有橙实心块白字 3.58:1 未达 AA 一条，HANDOFF 已声明，不计）。总体印象：错误态/空态/确认弹窗/降级与冲突处理是最强项（几乎每个错误都带原因+出口，终态语义色正确）；问题集中在**文案层**（技术词与库内实现细节向用户透出）。Top 15 与六种控件横向对比见 **附录 B**。

**两条需先核实再定性的**（源码与截图不一致，按「实测优先」原则如实记）：
- 截图里成功 toast 是偏绿底（`20b/24b/37d`），但 `components/ui.tsx:65` 的 `TOAST_BOX` 已是 `bg-ink` 炭黑、成功只走绿勾图标——**疑为截图基线未随三期 toast 重构刷新**，需重跑走查确认，不按回归处理。
- 截图里登录态页面版本号 `v0.1.0`、未登录页 `v0.1.2` 并存；`ipc.ts:90` 已改读 `app.getVersion()`——同样疑为基线过期。若重跑后仍并存，则是渲染层某处仍有写死常量。

### 3.2 硬编码数值分布（量化证据）

脚本：`desktop/scripts/audit/ui-hardcode-stats.mjs`（零依赖，只读，不进走查；`node desktop/scripts/audit/ui-hardcode-stats.mjs` 直接出 markdown）。扫描 `desktop/src/renderer/src/` 34 个文件。

| 类别 | 总命中 | 走 token | 裸值 | 裸值占比 | 不同值个数 | 说明 |
|---|---|---|---|---|---|---|
| 间距 padding/margin/gap | 560 | 0 | 560 | **100%** | 74 | `tailwind.config.js` 的 spacing 只 extend 了几个具名尺寸，从未覆盖数字刻度；同一量级并存四种半步写法（`py-1.5`/`px-2.5`/`gap-1.5`/`py-0.5` 合计 87 次） |
| 字号 | 243 | 238 | 5 | 2.1% | 9 token | 干净；裸值是 markdown 的 4 处 `em` 相对字号 + 1 处 `text-[10px]` |
| 圆角 | 153 | 151 | 2 | 1.3% | 7 token | 干净；裸值是 `50%` 头像与 `1px` 光标 |
| 阴影 | 9 | 7 | 2 | 22% | 2 token + `shadow-lg` | 「模态/右键菜单」这一档没有专属 token，蹭 Tailwind 默认 |
| 行高 | 31 | 4 | 27 | 87% | — | `leading-5`(18) / `leading-6`(5) 无对应 token |
| 字重 | 61 | 0 | 61 | 100% | 400/500/600 | 数值规范但无中间层 |
| 动效时长 | 39 | 7 | 32 | 82% | — | 23 处是「未写 duration 吃 Tailwind 隐式 150ms」；`duration-300` 1 处；`1.2s/0.9s` 两处循环动画属合理例外 |
| 颜色字面量 | — | — | **0** | — | — | HANDOFF「组件里已无硬编码色值」核实为真 |
| inline `style={{}}` | 13 处 / 4 文件 | | | | | VaultPage 6、UsagePage 5 |
| `!important` | 0 | | | | | |

硬编码密度最高的文件：`styles/index.css`（29.4/百行）、`UsagePage.tsx`（27.8）、`WriteConfirm.tsx`（19.1）、`ConflictBar.tsx`（17.5）、`LoginGate.tsx`（17.1）。

**结论**：字号/圆角/颜色三类已经是干净的 token 系统，**真正的缺口只有一个：间距**（其次行高/字重/动效的隐式默认）。刻度表（`DESIGN-scale.md`）只需为间距建栅格、为行高/阴影补两三档、为动效写明隐式默认的归属，而不是重造一套。

---

## 附录 A · 五条链路失败模式表

### A.1 入库

| 失败模式 | 当前处理 | 用户看到 | 数据后果 |
|---|---|---|---|
| pipeline OOM/segfault/非 JSON 崩溃 | 报错无原因：stderr 丢弃（`orchestrator.ts:883`）；close≠0→failed 但 error 为空 | 「投递箱处理失败」无原因 | 半截：已 convert 的在库，原件仍在投递箱 |
| 单阶段抛异常 | `run_stage` 捕获发 error（`cli.py:247-261`）→ 后续全 skip、原件不归档（`cli.py:453`） | 某阶段红 | 原件滞留→重启重拾→潜在重跑循环（Q10） |
| 磁盘满/写盘失败 | 阶段报错；enqueue copyFile 抛→send error（`:655-657`） | 阶段红字 | 半截笔记 |
| 0 字节文件经 enqueue / 直接丢投递箱 | skippedJunk 计数（`:609`）/ `.failed`+原因（`cli.py:465-475`） | 正确 | 无 |
| 同一文件重复拖入 | copyFile 覆盖（`:623`）；pipeline 按内容命名→可能重复笔记（推断） | 可能多一篇 | 潜在重复 |
| vault 被外部改名/移动/iCloud | **静默**（Q5） | 无 | 界面显示旧索引 |
| 换库时 pipeline 在跑 | **静默孤儿**（Q3） | 无 | 写旧库、烧额度 |
| 连续 enqueue 同库两个 pipeline | 守卫可绕（b1） | 无 | 双写；before-quit 只杀一个 |
| build_cards 失败 | catch 发 error（`:705-707`） | 面板红字 | 卡未建 |
| 用户改过的卡被覆盖 | 冲突不覆盖，进「待合并」+warn（`:701-702`） | 「N 张你改过的卡未覆盖」 | 保用户版 |

### A.2 问答

| 失败模式 | 当前处理 | 用户看到 | 数据后果 |
|---|---|---|---|
| 上游 401/403/余额不足 | T-02 扣住→`kind:error`+zhError（`agent/index.ts:786-810,895-901`） | 一条中文错误气泡+重试 | 无 |
| resume 失效（换库/过期/幽灵 id） | recover() 拿本地历史重开（`:387-413`） | 无感；截断才提示 | 无 |
| 流式中点停止 | 半截落成「（已停止）」再 abort（`:258-273`） | 半截可复制 | 无 |
| 同会话生成中再发 | 拒绝 + 「停止当前生成」出口 | toast | 无 |
| 模型猜路径反复 Grep | PreToolUse 硬闸 SCAN_LIMIT=5（`:607-632`） | 步骤显示 capped | 无 |
| 引用没读过的笔记 | **只报不改**：unverifiedCitations 只 log.warn（Q8） | 取决渲染层 | 回答含错误引用 |
| 索引未就绪窗口查询 | whenIndexed 闸门最多 20s（`searcher.ts:43-60`） | 等待 | 无 |
| search-worker 崩溃 | **静默**（Q6） | 之后检索回空 | 检索失效到重启 |
| 渲染子进程启动失败 | error 文本回给模型（`:543-576`） | 模型转述 | 无产物 |
| 退出时生成在跑 | **静默孤儿**（Q4，推断） | 无 | 子进程残留 |
| 一轮跑很久 | 无墙钟超时（b2） | 一直转 | 烧额度 |

### A.3 生成产物

| 失败模式 | 当前处理 | 用户看到 | 数据后果 |
|---|---|---|---|
| 入库时投递箱本轮失败 | ingest 任务 failed（`artifacts.ts:155-158`） | 卡片红字 | 未入库 |
| 落位笔记找不到（打标改名） | 6 次重试后 noteRel undefined 但**仍标 succeeded**（`:169-178`） | 「已入库 ✓」但打不开笔记 | 记录不完整 |
| 产物重生成/被删 | 复合主键判未入库 / stat ENOENT 不算已入库（`:210-220`） | 正确 | 无 |
| shell.openPath 失败 | 返回 error + reveal 兜底（`:230-246`） | toast + Finder | 无 |
| 纯产物轮折叠摘要 | 「未找到相关资料」（Q7） | 自相矛盾 | 无 |

### A.4 同步

| 失败模式 | 当前处理 | 用户看到 | 数据后果 |
|---|---|---|---|
| 聊天 syncConversation 失败 | syncQueue 退避 1m/5m/30m→手动 | Dock「N 条待同步」 | 云端暂缺 |
| 上云第 40/61 篇断网 | 失败计入 failed，文案「已进重试队列」（Q2） | 假承诺 | **数据缺 + 文案说谎** |
| token 过期正好在同步 | autoRefreshToken；失败则提前 return（`client.ts:103`） | 无 | 暂不同步 |
| Supabase 暂停/断网登录 | 三分类 network/credential/timeout（`auth/index.ts:96-142`） | 「网络不可达」 | 无 |
| key 下发失败 | `auth:provision-failed` | 提示去设置页手填 | 无 key 不能问答 |
| 网络恢复离线条不下 | 无周期重探（Q11） | 条滞留 | 显示滞后 |
| RLS/约束拒一行 | looksOffline 只认传输层（`client.ts:85-88`） | 不误报离线 | 该条不同步 |
| 敏感篇上云 | 已修（读全文 + 读盘）；**云端存量 R-02、MOC 泄漏面 R-03 未清** | — | 云端已有身份证号存量 |
| 两实例同开同库 | running 进程内，跨进程不互斥 | 无 | 重复消息（可接受） |

### A.5 更新

| 失败模式 | 当前处理 | 用户看到 | 数据后果 |
|---|---|---|---|
| 下载中失败（sha/断网/满盘） | error 上界面（`updater.ts:153-160`） | 「更新失败」红条 | 保留旧版 |
| 后台查更新失败 | 只 log（Q12，刻意） | 无 | 无 |
| 就绪 + Cmd+Q 无 inbox 活 | autoInstallOnAppQuit | 下次启动新版 | 无 |
| 就绪 + inbox 有活 + 3s 超时 | `app.exit(0)` 兜底**跳过安装**（`index.ts:186-188`） | 下次仍旧版、秒出同一提示 | 更新未装 |
| quitAndInstall 抛错 | 只 log.error（Q9） | 卡「正在重启」 | 未更新无提示 |
| update:ready 在 reload 期丢 | 挂载先 `update:state` 打底 | 补齐 | 无 |

---

## 附录 B · 截图基线逐张检视

逐张观察记录（142 行）在会话 scratchpad `audit/A6-ui-shots.md`；这里只留控件对比与 Top 15。

### B.1 六种控件横向对比

| 控件 | 变体数 | 形态与出现处 |
|---|---|---|
| 按钮 | 6 | 炭黑实心（登录键）· 橙实心圆/胶囊（发送、保存、模态主按钮、⟳重试）· 红实心（删除笔记/对话、放弃修改）· 描边/幽灵胶囊（暂不登录、取消/关闭/重试同步、chips、产物操作、投递箱 pill）· 橙描边（气泡内重试）· 纯文本链接（暂时跳过、返回）。几何自洽，但「重试」同时存在橙实心与橙描边两种 |
| 卡片 | 各角色一套 | 建库分支卡 · 模板三卡 · 用量 stat 卡 · 产物无框列表项 · 最近产物/对话行卡 · 空态大卡 · frontmatter 属性卡 · 深色仪表盘卡（唯一深色） |
| 输入框 | 1 套 + 高度分档 | 橙聚焦环统一；主聊天 60px/14px；搜索/模态/设置/登录为常规高 |
| 列表项 | 5 | 文件树项 · 搜索结果（标题+2 行摘要）· 产物面板项 · 最近行卡 · 用量表行 |
| 弹窗 | 1 套 | 居中白底圆角 + × + 标题 + 说明 + 取消/主按钮组（新建笔记、删除确认×2、换库、冲突三选一、AI 写入确认） |
| toast / 常驻条 | 瞬时 4 类 + 持续 4 类 | 瞬时：信息炭黑无图标 · 警告炭黑+金⚠ · 错误炭黑+红✕ · 成功（截图偏绿底，源码炭黑，待核）；持续：云端降级条（浅橙）· 编辑冲突条（浅金）· 错误气泡（红左边+淡红底）· 答案警告条（浅金 + **橙**竖条与橙链接，语义掺混）；另有 Dock 浮窗与侧栏底全局任务条 |

### B.2 Top 15 缺陷（跨页面次数 × 严重度）

| # | 缺陷 | 严重度 | 一句话改法 |
|---|---|---|---|
| 1 | 笔记 frontmatter 属性卡直接显示英文技术键（doc_type / entity_kind / entities_talent / rule_tagged / sub_category…）与裸 `true`，几乎每篇可见 | 高 | 键名中文映射表，未知键折进「更多字段」，布尔渲染「是/否」 |
| 2 | 版本号 v0.1.0 / v0.1.2 并存（**疑基线过期**，见 3.1） | 高→待核 | 重跑走查；仍并存则找渲染层写死处 |
| 3 | 成功 toast 偏绿底（**疑基线过期**，见 3.1） | 高→待核 | 重跑走查核对 `TOAST_BOX` |
| 4 | 「库」称呼五套混用：问你的库 / 检索了资料库 / 个人知识库 / 使用已有库 / 把资料拖进来 | 中 | 全局统一一个用户词，占位与步骤文案一并收口 |
| 5 | 内部路径泄漏：产物面板标题「90_产物/」、设置「仅保存 90_产物/」、换库弹窗绝对路径、AI 答案内嵌全路径 | 中 | 只显友好名，路径折进 tooltip 或「在 Finder 显示」 |
| 6 | 投递箱阶段名 jargon：PII守卫 / 智能打标 / 规则打标 / 实体建链 / 索引重建 / 归档 / 上云 | 中 | 阶段名改用户话（检查中 / 整理中 / 建立关联 / 收尾 / 同步云端），jargon 收进详情 |
| 7 | 建库「新建库」卡文案两套且互相矛盾（「干净的库·只有投递箱和资料库」vs「按 MCN 模板·含投递箱与产物目录」） | 中 | 文案抽到一处常量 |
| 8 | 库内文件夹名中英混排：`00_投递箱/00_Inbox`、`80_资料库/80_Library` 同层并存 | 中 | 模板统一命名；英文系统文件夹做显示名映射 |
| 9 | 文件树/笔记标题充斥裸 slug（`mcnai-rearm-1787370678803`，部分为测试产物） | 中 | 落位笔记标题取 summary/首个中文标题，禁止内部 id 当可见标题 |
| 10 | 答案底部警告条（浅金）左竖条与引用链接用橙色，与「警告=金琥珀」语义掺混 | 中 | 竖条/链接改金琥珀系，橙只留进行中/降级 |
| 11 | toast 生命周期过长、不随状态解除消失（换库错误跨 3 屏；重试成功后错误 toast 仍在），且与 Dock/内联同文重复 | 低 | 状态解除即撤；常驻条已表达的事件不再弹 toast |
| 12 | 进度分母跳变：准备「0/6」→ 处理「1/8」；Dock「/8」与正文「还有 10 个文件」不一致 | 低 | 统一以最终待处理总数为分母，准备阶段显「计数中」 |
| 13 | 首屏 chips 集合与顺序不稳定（00d 与 01/11 不同） | 低 | `config/chips.ts` 锁定排序 |
| 14 | 运维配置区 toast 叠放压住表单控件；档位下拉浮层压住问候语 | 低 | toast 落点避让主表单；下拉加偏移/翻转 |
| 15 | 图谱标签在视口右缘硬截断；CJK–Latin 空格时有时无（「AI 服务」vs「保存API Key」）；基线分辨率不统一（2000 vs 1440） | 低 | 标签边缘淡出；统一 CJK↔Latin 间距规则；走查固定 DPR |

---

## 附录 C · 调研原始产物索引

| 产物 | 位置 |
|---|---|
| 主进程架构审计 A1 | 会话 scratchpad `audit/A1-arch-main.md`（本文卷一 1.1–1.3 的来源） |
| 外围链路审计 A2 | `audit/A2-arch-pipeline-cloud.md` |
| 渲染层功能审计 A3 | `audit/A3-func-renderer.md` |
| 五链路失败模式 A4 | `audit/A4-chains.md` |
| UI 数值统计 A5 | `audit/A5-ui-stats.md`；脚本已入仓 `desktop/scripts/audit/ui-hardcode-stats.mjs` |

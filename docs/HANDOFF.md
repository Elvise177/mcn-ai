# mcn-ai 产品交接文档（HANDOFF）

> 更新：2026-08-20（**0.1.1 已签名公证，待上传更新源**）｜ 范围：mcn-ai 产品线（桌面版 + 云端），不含 OMG 钉钉自动化定制项目（那是独立仓库 `~/Documents/AI/omg-dingtalk-automation`，有自己的 README 和交付文档）
> 当前阶段：MVP（M0–M4）+ QA 修复大单四批完成 + A-3 实体层收官 +
> **首个正式签名版 0.1.0 已交付客户，0.1.1 修复版已出包**（见下方 §0-新）

---

## 0-新g. PLAN-v2 批 2 + 批 3（2026-09-03/04 执行，随 0.1.3 出）

> 方案 `docs/PLAN-v2.md`（批 2「静默消灭 + 透明度」、批 3「高频功能补齐」），事实底座 `docs/PRODUCT-AUDIT.md`。
> 与 §0-新d（批 0+1）、§0-新f（档位线路契约 v2）合并成 **0.1.3** 一起发。

### 批 2 · 静默消灭 + 透明度（提交 `d147c24` / `d50e816` / `e7447cd` / `0329ab0`）

| 项 | 落点 | 一句话 |
|---|---|---|
| F1 白屏保护 | `components/ErrorBoundary.tsx`；`CrashProbe` + `MCNAI_E2E_THROW` | 组件抛异常时 React 卸整棵树 = 白窗；现在给「重新加载 / 导出诊断」两个出口，组件栈进日志 |
| Q7 摘要第三分支 | `lib/turn-summary.ts` | 纯产物轮以前落到「未找到相关资料」，正文里 PPT 明明已经生成好了 |
| Q8 引用存疑 | `ChatMessage.unverified` + 气泡角标 | 原来把 `> ⚠️ …` **拼进正文**：复制走的是掺了提示语的版本，重建上下文时还会喂回模型 |
| Q9 更新安装失败 | `updater.failInstall()` + UpdateBar | `quitAndInstall` 在 setImmediate 里抛错只有一行 log，界面永远停在「正在重启…」 |
| Q11 离线周期重探 | `auth.scheduleReprobe()` 60s→8m | 网回来了那条「云端离线」还挂着（`offline-recovery.mjs` 就是为它写的，此前故意红） |
| Q13 诊断导出 | `DiagnosticsCard` | 原来**无条件报成功**：满盘/无权限时把失败说成"已导出" |
| Q14 设置项保存反馈 | `lib/save.ts` 的 `saveWithToast` | 五处 `settings.set*` 返回值被 void 扔了，成功与失败长得一模一样 |
| Q15 档位实际生效 | `agent:stream` 加 `degraded` → 折叠行尾 | 服务端换了模型只进日志一行 warn，用户付了增强档的钱、界面照常显示「增强」 |
| N4 退避重试 | `lib/backoff.ts` + client/health | 200ms×2ⁿ + 0.9–1.1 抖动 + 尊重 `Retry-After`；重试落 TaskDock，**首次静默、不进对话历史** |
| N9 步骤句法 | `config/steps.ts` + 折叠行失败数 | 「没成功」从组件收回文案真相源；折叠之后失败步骤原来是**看不见的** |
| F17 半 轮内状态行 | Workbench 输入框上方 | `用时 12s · 3 步 · 标准档`，零新 IPC |
| F3 笔记上云重试队列 | `noteSyncQueue` + `lib/retry-ladder.ts` | 那句「已进重试队列」**以前是假话**——队列只服务聊天记录，笔记永不重传、云端静默缺篇 |
| U3 #1/#4/#5/#6 | frontmatter 中文映射 / 「知识库」统一 / 路径不泄漏 / 阶段名用户词 | 阶段名与 `INBOX_FLOW` **两份抄件收成一份**（`config/stages.ts`） |
| 挂账销账 | `smoke-provider.shutdown()` | 汇总后挂 11 分钟＝Electron 43 的 watcher 不关退不掉；关 watcher + abort + 5s 硬超时 |

### 批 3 · 高频功能（提交 `42ff065` / `1b10c1e` / `7d745dd` / `5ac4a13` / `241824b`）

- **F2 草稿按会话持久**（`lib/draft.ts`）：切页面/重载都不丢。**最疼的一格是新对话**——它在发出第一句话之前没落过盘，每次重载换 id，草稿被当孤儿清掉（走查逮到，改成记住待用 id）
- **F5 + F8 命令面板 Cmd+K**：搜对话（标题 + 正文）/ 搜笔记 / 敲命令一个入口；会话右键重命名·置顶·删除；列表 ↑↓ 选、Enter 开
- **会话内查找 Cmd+F**（用户点名）：命中滚过去 + 描边 + 「第 n/N 条」；知识库页的 Cmd+F 是聚焦搜索框
- **Cmd+N 多窗口**：先修了一个架构洞——五个管理器各存一个 `this.win`，开第二扇窗把第一扇**覆盖成聋子**；下行事件统一走 `lib/windows.ts` 的 `broadcast()`
- **F9 消息操作**：提问复制 / 编辑重发（预填原文、Enter 重发、撤掉其后内容）/ 回答重新生成（**不撤旧答案**，两个并排让人挑）/ 代码块复制
- **F10 通知 + Dock 角标 + 关窗不退**：完成才通知、失败才响铃、眼前不打扰、几秒的活儿不通知；角标 = **有几件事在等你**（等确认 + 失败 + 待同步）
- **F7 不可逆操作**：分流规则删除确认 + 撤销；敏感档升「上云」二次确认；昵称改完即存
- **F6 失败件批量重投**：`.failed/` 清单**从盘上读**（常驻），一键整批重投，进队后清理避免重复入队
- **F24 本会话此目录不再问**：HANDOFF 原来记「故意不做」，理由是没有安全的记忆位置；现在有了——主进程内存 + 按会话 + **按目录**，重启即失效、换库即清
- **F25 窗口尺寸记忆 + 缩放**：判据在 `lib/window-bounds.ts`，最要命的分支是**副屏拔掉后窗口开在屏幕外**（Dock 有图标、屏幕上什么都没有）

### 走查里逮到的两个真缺陷（不在单子上）

1. **Dock 的多任务列表从写出来那天起就点不到**：`.task-dock` 为了 max-height 过渡挂着 `overflow: hidden`，而那个列表是 `absolute bottom-full`——画在 Dock 上方，像素被整片裁掉。DOM 在、Playwright 也报 "visible"，点下去命中的是底下的「最近对话」。**只断言"看得见"会把这类缺陷整个放过去**，所以补了一次 `elementFromPoint` 命中测试。
2. **安装失败却说「稍后会自动重试」**：包已经下好了，没有任何东西会自动再装一次；失败态还把唯一出口（再点一次「立即重启」）藏了、按钮停在禁用的「正在重启…」——0.1.2 修的是 `void install()` 那一半，这是剩下的另一半。

### 走查里改掉的四类"把碰巧成立的前提当成保证"

| 断言 | 把什么碰巧当成了保证 | 改法 |
|---|---|---|
| Dock 唤回浮窗 | 「Dock 出现了」= 有在跑的投递任务（其实 Dock 上还挂着 R3 那条 failed 的对话） | 从**任务层**问形态，再决定点外层还是点列表里那一行 |
| 同一处 | 本地模式一批文件几秒跑完，等我们点到时任务早没了 | 投 6 个把窗口拉宽；没了就补投、最多三轮 |
| 阶段日志 message | 面板在 run-end 后 4 秒自动收起，而建卡/上云跑在 pipeline **之后** | 采不到就重开面板再采（面板读的是同一份 stages） |
| 带数字的核对步骤 | 模型一定会去 Grep 且一定扫得到 | **大声跳过**（同 53 步的处理）；文案本身有 12 条零花费断言守着 |

另外四处断言按布局类名 `justify-end` 数提问气泡，F9 把气泡改成纵向布局后立刻红在无关的地方——**断言该认语义（`data-role`），不认布局类名**。

### 验收

- `npm run verify` **14/14 全绿**（新把 `offline-recovery.mjs` 提进 L3——Q11 之前它是故意红的）
- `smoke:steps` 从 ~120 条涨到 ~230 条；`smoke:guards` +9（通知判据）；`smoke:write` +5（批准粒度）
- 走查截图 116 → 134 张；新增 18 张全部逐张过目
- **E2E_CHAT 实花 ¥3.66**（三轮：¥0.89 + ¥1.01 + ¥1.76）。原报 ¥2，超 83%，
  中途在 ¥1.90 处报备并获批加跑一轮。三轮都被**我自己的过期断言**中断过，三条都已修：
  ① 失败步骤文案（N9 收短了措辞）② 带数字的核对步骤（靠模型肯 Grep，改成大声跳过）
  ③ cloud_sync 等待门槛（本地是 `skipped` 秒到，登录态是真上传要好几分钟——
  `waitInboxIdle` 的注释里早写着，我没照做）

### 挂账（2026-09-04，用户裁决"不跑第四轮"）

| 挂的什么 | 现状 | 下次怎么销 |
|---|---|---|
| 截图 `39-Dock-待同步与重试入口.png` | 仍是 2026-08-19 的旧 UI（早于本批侧栏改名与 TaskDock 改动） | 下次 E2E_CHAT 自然刷到 |
| F3 `noteSyncQueue` 的**接线**断言 | 判据（1m/5m/30m→转手动、库归属闸门、`pendingSync` = 两队列之和）已有 8 条零花费断言；**IPC 到界面那一段没跑到**（它在 syncQueue 块里，需要登录态造真实上云失败） | 同上；断言已经写好等在 `walkthrough.mjs` 里 |

三轮里**新断言全部验到过**：Q15 折叠行档位 ✓、F17 轮内状态行 ✓、
M-11 三条错误分支 ✓、46 会话恢复降级 ✓、H-09/H-10 ✓；
7 张停在 08-19 的对话页截图刷新了 6 张。

---

## 0-新f. 档位线路跟服务端走（client-config 契约 v2，2026-09-03，未发版，随下一版出）

**起因**：Jerry 机器日志 `「增强」未配独立密钥，回落到共享密钥 encryptedApiKey（https://aihubmix.com）`。
查实：**不是配置问题**——`client-config` 从不下发增强档任何字段（PRODUCT-AUDIT a13），所有机器的增强档都长这样
（我本机同一行 08-21 起 5 次）；地址是 `tiers.ts` 写死的 `aihubmix.com`、key 是服务端下发的中转站那把，
客户机上 aihubmix.com 走不通。本机实测中转站 key 打 `aihubmix.com` 与 `api.inferera.com` 都 200 且 model 原样回
`claude-opus-5`，"走不通"是客户机网络侧的现象。用户拍板：**出厂 = 备用域名 inferera，aihubmix 从所有默认值/兜底/断言清除**。

### 拍板（四条）

1. 用量线路键 `aihubmix` **保留键名**（jsonl 已落盘的 `route` 值，历史账不能断），只把界面标签改成「中转站」。
2. 迁移覆盖清理**只清 v1 迁移写入的那份**（四字段形态与 `describeProvider()` 逐一相等，或线路自愈的两字段形态），管理员手改的保留——大头那台靠它。
3. Vercel 变量：列出名与值（key 占位），**改前先读出当前生产值存档**，没有改前值不许改。
4. 增强档 key 第一版复用中转站那把（服务端回落 `CLIENT_RELAY_API_KEY`），限额子 key 记进网关单一并做。

### 契约 v2（`webpage/app/api/v1/client-config/route.ts`）

- 新增 `contractVersion: 2` 与 `tiers.standard / tiers.enhanced`，各含 `baseUrl / model / fastModel / apiKey`，
  值来自 `CLIENT_TIER_<STANDARD|ENHANCED>_<BASE_URL|MODEL|FAST_MODEL|API_KEY>`，缺省写在路由里
  （标准 = `https://api.deepseek.com/anthropic` + `deepseek-v4-pro/flash`，回落 `CLIENT_LLM_API_KEY`；
  增强 = `https://api.inferera.com` + `claude-opus-5`，回落 `CLIENT_RELAY_API_KEY`）。**所有登录用户同一份，没有按账号的配置。**
- **v1 字段保留**（`relayBaseUrl/relayApiKey/llmBaseUrl/llmModel/llmApiKey`）：0.1.2 及更早客户端只认这几个；`llm*` 三项此外仍是投递箱打标配置。
  **废弃时机**：用户本人 / 大头 / Jerry 三台都升到含契约 v2 的版本之后，再删 `relay*` 两项（`llm*` 因打标继续保留）。
- **部署顺序**：先部署 webpage，再发桌面版。新客户端遇到 v1 服务端会明示「服务端配置版本过旧，未下发对话线路」，不猜线路。

### 客户端（`desktop/src/main/ai/tiers.ts` 重写）

- `TIER_PRESETS` **没有 base URL**；地址 = `tierOverrides`（运维覆盖）> `tierProvision`（服务端下发）> 空。模型串留语义兜底，下发的优先。
- `ResolvedTier` 新增 `configured / unavailableReason / provisioned`，删 `usingSharedKey`；`FALLBACK_KEY_FIELD`、`ensureStandardUsable` 整段删除——每档只认自己那把 key，**没有任何回落**。
- 未配齐的统一文案 `unconfiguredReason()`：「增强线路未配置，请联系管理员」——发送预检、探测原因、选择器说明栏、管理员区四处同一句（走查 45e 逐处断言一致）。
- 迁移 v2（`migrateTiersV2`，`tierMigrated2` 只跑一次）：清 v1 写入的标准档覆盖并打 warn；手改形态打 info 保留；没跑过 v1 的机器直接标两个 flag、什么都不写。
- `provisionKeys`：认 `cfg.tiers`，`setTierProvision` **整份替换**（服务端不再下发某档 = 那档未配置），每档 key 写进自己槽位（标准档 = `encryptedLlmKey`，与打标共用，`manualLlmKey` 仍尊重），之后 `invalidateTierHealth()`。标准档没配齐 → provision 失败并通知；只缺增强档 → warn 不算失败。
- `health.ts`：**两档同一口径真探**（此前标准档只看有没有 key）；`configured=false` 直接回未配置原因。`MCNAI_E2E_TIER_HEALTH` 开关**优先于一切**（含配没配齐）——走查主实例没有增强档 key，靠 `up` 打开选择器验"能选/能记住/失败有出口"，第一版把 configured 判在开关前面，主实例 45c 立刻红。
- 界面：管理员区标「服务端下发」/「未下发线路」/「已被运维改过」，未配齐时原样摆那句话（`tier-unconfigured-<id>`）；base URL 输入框 placeholder 改「等待服务端下发」；`aiReady` = 标准档 `configured`。

### 服务端改前存档（2026-09-03，用测试账号真实登录读生产 `https://www.makeupai.top/api/v1/client-config`，key 打码）

```json
{ "relayBaseUrl": "https://api.inferera.com", "relayApiKey": "sk-8…(51 位)",
  "llmBaseUrl": "https://api.deepseek.com", "llmModel": "deepseek-v4-flash", "llmApiKey": "sk-d…(35 位)" }
```

= 生产只配了 `CLIENT_RELAY_API_KEY` 与 `CLIENT_LLM_API_KEY` 两个变量，地址三项全走路由缺省；**生产两把 key 与本地 `.env.local` 里的不是同一把**（前缀 `sk-8/sk-d` vs `sk-f/sk-e`）。
契约 v2 的缺省链回落到这两个既有变量，所以**首版不需要新增任何 Vercel 变量**，只需重新部署；本地 dev server 用同一账号实测输出已含 `contractVersion:2` + `tiers.*`。

### 验收

- 走查：所有隔离实例起前 `seedProvision()` 种"服务端已下发"形态（值与路由缺省一致，路由是真相源）；10h 断言增强档 `api.inferera.com` + 两档标「服务端下发」+ 不含 aihubmix；45b 先把增强档配齐再验"探测失败置灰"；**45e 改写**：v1 形态覆盖被清（含 config 落盘与 warn 日志）→ 增强档无 key 不回落、四处同一句话、日志无回落 → 手改覆盖保留（第三次启动）。截图 `45e-老用户机-增强线路未配置` 替换旧的 `45e-老用户机-增强档回落可用`。
- `login-provision.mjs` / `fresh-install.mjs`：登录后断言两档 `configured && provisioned` 且地址正确；`upgrade-path.mjs`【6】改成迁移 v2 两种合法状态各断言。**这三条要服务端部署契约 v2 后才会绿。**
- `smoke:provider`：用例 `aihubmix` 改名 `enhanced`（`SMOKE_ENHANCED_KEY/BASE`，缺省 inferera）。
- 装机：`docs/RELEASE.md` §1b「开账号检查清单」（线路/模型/key 三项逐档核对 + 两档各点一次「检测线路」）。

### 本轮实测结果（2026-09-03）

- 主走查本地模式**全绿**（第五轮；前四轮红在：探测 configured 判在 e2e 开关之前 → 主实例 45c 红；45e 独立实例误带 `up` 开关；R3 用"写回原值"还原地址在新模型下成了同值覆盖 → 10h「已被运维改过」，产品侧改成"填的等于下发值不算覆盖"）。10h/45b/45e 截图人眼看过。
- `upgrade-path.mjs`（拷本机真实 userData）：迁移 v2 三条 ✓（v1 覆盖已清、`tierMigrated2` 落盘、标准档不再是覆盖）；"两档线路已下发"两条 ❌ = 生产服务端还是 v1，**部署后应绿**。这就是"用户本人机器"的改前/改后：改前 `tierOverrides.standard = {inferera, v4-pro/flash, encryptedApiKey}`，改后清空、等下发。
- `smoke:provider` 标准档最小集 `SMOKE_ONLY=deepseek SMOKE_CASES=single,abort,tools` **3/3 通过**（16.5s / 4.8s / 31.3s，`modelUsage` 含 `deepseek-v4-pro`，工具真调 3 次），花费按上次口径 ≈¥0.5。
- **增强档真实调用未跑**：单轮 ≈¥7（RELEASE-CHECK §1.2），超出本批 ¥1 预算，待拍板。线路层已用中转站 key 做过 `max_tokens:1` 探测（200、model 原样回 `claude-opus-5`），走查 10h 的「检测线路」在主实例也真点过一次。
### Vercel 生产构建连红两次（ace0d38 / cd824b0），已修

route.ts 里 `export const CLIENT_CONFIG_CONTRACT_VERSION` 触发 Next.js App Router 的 "not a valid Route export field"——
**route.ts 只允许导出 HTTP 方法与固定配置字段**，`next dev` 不查、只有 `next build` 才报。常量挪到
`webpage/lib/client-config/contract.ts`，route.ts 改 import。**新规矩进了根 CLAUDE.md：webpage 改动 push 前必须本地 `npm run build` 通过。**

### 收口（2026-09-03 晚，用户裁决）

- 代码已提交 `ace0d38` 并 **push**（此前本地领先 origin 20 个提交，从 2e92dd0 起都没推过——push 触发 Vercel 自动部署）。
- **0.1.3 不单独发**：改为与 PLAN-v2 批 2/3 合并后一起发，`desktop/release/SamePage-0.1.3-arm64.dmg` 已签名公证订票（sha256 前缀 `81adfe305fa544cc`）留作备用；**OSS 上传推迟到批 3 完成**。上传时按 RELEASE §B5：zip/blockmap 先、yml 最后带 `max-age=60`。本机**没有 ossutil 与 OSS 凭据**（上一版应是控制台手传），要么 `brew install ossutil && ossutil config` 由用户输 AK，要么控制台手传。
- **硬约束不变**：OSS 上传必须在生产 client-config 已是契约 v2 之后——否则老客户端自动更新到新版会撞旧服务端，两档全不可用。
- ✅ **生产已核（2026-09-03，ec25bbf 部署 Ready 后用测试账号真实读取）**：`contractVersion: 2`；`tiers.standard` = `https://api.deepseek.com/anthropic` / `deepseek-v4-pro` / `deepseek-v4-flash` / key `sk-d…(35)`（= 生产 `CLIENT_LLM_API_KEY`）；`tiers.enhanced` = `https://api.inferera.com` / `claude-opus-5` / `claude-opus-5` / key `sk-8…(51)`（= 生产 `CLIENT_RELAY_API_KEY`）；v1 五字段原样保留。**没有新增任何 Vercel 变量**，全走路由缺省 + 既有两把 key。OSS 上传的硬约束（生产须先是 v2）自此满足，剩下只等批 3。**客户端侧也验了**：`node e2e/login-provision.mjs` 对生产真实登录一遍全绿——两把 key 下发、两档线路下发（标准官方直连 / 增强 inferera）、零配置对话 5s 出答（≈¥0.01）；顺带把 §0-新d 挂账的 `00b/11/12` 登录态基线刷到 0.1.3。复核法：在 `desktop/` 下 `node scripts/check-client-config.mjs https://www.makeupai.top`（supabase-js 用 e2e 测试账号 signInWithPassword 取 token → GET 路由 → key 打码打印），或直接跑 `node e2e/login-provision.mjs`（已含两档下发断言）。
- **挂账**：`smoke:provider` 跑完汇总后 `app.exit()` 不退出，进程挂了 11 分钟（本单没动它的退出逻辑，疑与 Electron 43 的 `before-quit`/watcher 那条同源，见 §0-新 R2），下次跑要盯着或加硬超时。

---

## 0-新d. PLAN-v2 批 0 + 批 1「架构止血」（2026-09-02 执行，未发版）

> 方案见 `docs/PLAN-v2.md`（已批准），事实底座 `docs/PRODUCT-AUDIT.md`。本批全是底层改动，**随下一版一起出**。
> 真实调用 ¥0（R3 用开关造超时）。

### 做了什么（对照 PLAN-v2 批 1 表）

| 项 | 落点 | 验收 |
|---|---|---|
| R1 对话 prompt 读 persona | `agent/system-prompt.ts`（纯函数）；`persona.prompt` 新字段（TS+py 镜像）；MCN 身份句进 `MCN_PRESET.persona.prompt`；规则 4/6/11 去「达人」「90_产物」写死 | `smoke:taxonomy`【A5】通用预设不含 MCN/达人/OMG美妆/带货；走查 40g 通用新库经诊断口 `chat.systemPrompt()` 扫、主实例老库反向验含「带货」 |
| R2 换库/退出杀 pipeline | `stop('switch'\|'quit')` 关 watcher → kill 进程组 → 等退 → 重置 running；`run()` 快照 `{root, taskId, gen}`，尾段只认快照；`openVault` 回 `stoppedInbox` → 向导 toast；`before-quit` 调 `agentManager.abortAll()` | 走查新段（34b 之后）：换库 mid-pipeline → toast「已停止上一库的入库」（**新图 22d**）、`ps` 零残留、旧库任务 `canceled:'switch'` 且 `pid` 空、新库不多出 running |
| R3 agent 墙钟超时 | `agent/timeout.ts` 的 `judgeTimeout`（80% warn / 100% abort）+ `resolveTimeoutMs`；`runTurn` 500ms 定时器；中断顺序 = 半截正文落盘 →abort → error；`store.agentTimeoutMin`（出厂 15，0 关）+ 管理员区一行 + IPC `settings:setAgentTimeout`；`MCNAI_E2E_AGENT_TIMEOUT` 只给走查 | `smoke:guards`【1】【2】；走查 41f：黑洞端点 + 3 秒上限 → SDK 子进程出现→错误气泡含「超时」→子进程 ≤6s 消失→任务 failed；10i 后管理员区改 20/清空=关/回 15 都落盘 |
| R4 stderr 尾 2KB | `lib/tail-buffer.ts`；非零退出且非自杀时最后一行进任务 error（stage `pipeline`）、整段进 main.log | `smoke:guards`【3】；`smoke:pipeline`【5】未知参数崩溃 → stderr 有原因、stdout 零事件 |
| R5 key 走 env | `lib/pipeline.ts` 的 `pipelineArgs`/`pipelineEnv`（纯函数）：argv 不带 `--llm-key`，`LLM_API_KEY` 进 env（无 key 时主动删掉开发机的）；`cli.py` 本就读 env | `smoke:guards`【4】argv 不含 key；`smoke:pipeline`【6】env 传 key 跑通 `--count-stale` 且不回显 |
| R6 `90_产物` 走 layout | `agent/index.ts` 读 `readVaultConfig(root).artifacts`；工具说明与规则 6 用它；`write-guard` 相对路径按 `artifactsDir` 算 | `smoke:write`【6b】改名为「产物区」后：新名放行、旧名退化为 ask、前缀相似不误放 |
| R7 supportedExt 单一真相 | `lib/supported-ext.ts`（orchestrator 转出口、attachments 引用、删渲染层死抄件 `SUPPORTED_HINT`）；pipeline `cli.py` 三处改从 `02_convert.CONVERTERS` 派生；`taxonomy.py --supported-ext` | `smoke:taxonomy`【A6】TS 集合 = py 集合逐字 |
| N5 write-guard 三段判定 | `isPathWritable(root, p)`：可写根 → 受保护前缀（`.mcnai/.git/.obsidian/node_modules/.done/.failed` + 任何 `.` 段）→ 受保护文件 | `smoke:write`【6c】8 条 |
| N6 建库护栏 | `vault/wizard.ts` 的 `isSafeVaultRoot`：拒 `/`、`~`、`~/Library`、iCloud 根、`/Volumes/<卷>`、`/Users` 等；挂在 `vault:pickExisting`/`createNew` | `smoke:guards`【5】；走查 40 系拒家目录 toast + 仍在向导（**新图 40h**）、磁盘根同拒 |
| 刻度表 token | `theme.css`：`--space-1/2/3/4/6/8/12`（删 5/10）、`--leading-snug`、`--shadow-modal`；`tailwind.config.js`：数字 spacing extend 指 token（零视觉变化）、`leading-snug`、`shadow-modal`、`fontWeight` 整体覆盖排除 700 | 存量 560 处替换 + 整体覆盖 + 白名单断言 + 全量重拍 = 批 4 |

**新增验收入口**：`npm run smoke:guards`（进 `verify` L1）。pipeline 源码改动已在 pkb-pipeline 提交并**重新冻结**（`pyinstaller mcn-ingest.spec`），`resources/pipeline/` 已更新、`smoke:pipeline` 在冻结形态全绿。

### 批 0 结论

- **R20**：`updater.ts` 头注释与 §0 待办 #7 更正为「已接 OSS」；§5 补 `docs/` 索引；`pkb-pipeline/README.md` 链路描述按 `cli.py` 重写（01/05/06/08 不在链上）。
- **R21**：embedding 锁定记入 §4-28。
- **U0**：重跑走查核实——**两条都是基线过期**。成功 toast 现为炭黑底 + 绿勾（20b/24b/37d 已刷新）；版本号：本地模式各屏统一 `v0.1.2`，而 `11/12` 两张登录态截图停在 2026-08-18（早于 08-19 的 `app.getVersion()` 修复），它们归 `login-provision.mjs`（要登录 + 一轮真实对话），**本批 ¥0 不重拍，随批 2 的 E2E_CHAT 轮刷新**。
- **U0 顺带抓到一颗走查时间炸弹**：VaultPage 的「知识库可以升级一下」确认模态由 `--count-stale` 子进程往返时间决定何时弹、每次 reload 重问一次；34 步取消测试转出的无标签笔记把篇数推过阈值，18b reload 后模态在 02e 期间弹出，19 步点笔记被遮罩挡住超时——红在与真因无关的地方、且只在子进程慢一点时才红。已加 `armUpgradeGuard`（MutationObserver 自动点「以后再说」并计数，每次 reload 后重装）+ 失败现场截图 `ZZ-失败现场.png`。这条提示自身的断言挂账。

### 走查里踩的坑（写给下一个改走查的人）

- **标准档的 keyField 就是打标的 key**（`encryptedLlmKey`）。R3 第一版给标准档塞了一把假 key 造超时，
  结果后面整轮投递真去打标、卡在「智能打标 第 1/1 篇」五分钟、退出时 `kill EPERM`。
  走查里要给对话线路造 key，一律用**增强档**（`encryptedAihubmixKey`，与打标无关）。
- 换库到空库 B 后文件树里也会有 `00_投递箱`（开库 mkdir 投递箱），判"切没切过去"要拿走查库独有的目录。
- 通用新库路径 `/tmp/mcnai-e2e-cleanvault` 会撞旧名正则 `mcn[-\s]?ai`，扫 prompt 前先抠环境串（同 `assertNoOldBrand`）。
- R3 步在本地模式留下一条 failed 的 agent 任务在 Dock（没有真 key 修不好它）；本地模式后面没有看 Dock 失败文案的断言，CHAT 模式整段跳过。

### 销账 / 挂账

- §3 bug#10「短时间连续 enqueue 同库两个 pipeline」：机制 = `stop()` 不杀 child + `run()` 尾段 getter 读到新库（R2），**已修**，走查 R2 段守着。
- 挂账：升级提示的专项断言；`11/12` 基线刷新；批 4 刻度表存量替换。

---

## 0-新. 0.1.1 状态（2026-08-20）

**产品名已统一为 SamePage**（Dock / Finder / 菜单栏 / dmg 文件名）。
Electron 版本锁已解除（签名公证到位后不再需要靠降版规避 XProtect）。

### 这一版修了什么

| # | 问题 | 来源 |
|---|---|---|
| 1 | 拖文件进外部资料块**毫无反应** | 客户报障；Electron 32 移除 `File.path`，改用 `webUtils.getPathForFile()` |
| 2 | AI 说"环境限制文件写入"，**根本没有写权限** | 客户报障；新增写入确认卡 + 备份 + 撤销（B4） |
| 3 | 附件只能传图片，**docx/pdf/xlsx/pptx 传不了** | 客户报障；B7 文档附件 |
| 4 | 上传 14 个文件卡在守卫不动 | 索引就绪闸门缺失 |
| 5 | 关系图/文件树刷新过频，一直在动 | 加防抖（3000ms / 1000ms） |
| 6 | 莫名多出上百篇"旧笔记"要重打标 | 提示文案软化 + 只对真正过期的重打 |
| 7 | 右键菜单只有全局新建，**不能右键文件夹操作** | 文件树右键菜单（新建/重命名/删除） |
| 8 | **界面版本号写死 `v0.1.0`** | 装了 0.1.1 还显示 0.1.0；改为读 `app.getVersion()` |

### 验收体系：从"一条条试"改成一条命令

`npm run verify` 分 L0–L4 五层，**从快到慢排、任何红都不中断后面的、最后一次列全**。
起因是 2026-08-19 真人原话「还是这样一个一个的试，太慢了」。
详见 `docs/RELEASE.md` §B.2；人工自测清单在 §B.2b。

### 未做完 / 待办

- **0.1.1 还没上传 OSS**（`latest-mac.yml` 一旦上传即对全部客户生效，务必**最后**传）
- M-29 冷调用性能：两次都是 0ms（securityd 已热），**没测出结论**，要重启后跑
  `e2e/probe-safestorage.mjs`
- 「本会话全部允许」AI 写入：本版**故意不做**，每次都确认（已记 roadmap）
- SamePage 商标检索（名字已进 dmg / app 名，优先级上调）
- 云端语义检索：`match_knowledge_chunks` 返回表缺 `file_path`（数据本身在，不用回填）

---

## 0-新c. 0.1.2（2026-08-22 发版）——全是真实客户正在疼的 bug

**发版顺序拍板**：0.2.0 的批 1–3 已提交但**不发版**，先出 0.1.2。
理由：0.1.2 全是客户此刻在疼的东西、Jerry 装机等着它；0.2.0 批 4/5 不阻塞任何人。

| # | 问题 | 根因（都实测确认过，不是推断） |
|---|---|---|
| 1 | 打标时界面 **18 分钟一动不动** | `label === '智能打标'` 是**死判据**：篇级进度事件刻意不进 `stages`，label 一直停在上一格「PII守卫」。客户报过一次，当时"修好了"，修的正是这行死代码 |
| 2 | 更新卡在「正在重启…」 | 渲染层 `void install()` 把 `{ok,error}` 扔了 + `before-quit` 用 `app.exit(0)` **绕过 electron-updater 的安装** |
| 3 | 下载全程零显示 | 只有 `ready` 一个布尔，227MB 在慢网络下十几分钟全黑 |
| 4 | 补齐点击无反应 | 三处裸 `return` + IPC 的 `void` + 渲染层的 `void`，全链路吞掉 |
| 5 | `.doc` 传不了 | 不在支持列表；改用 **macOS 自带 `textutil`**（不是 soffice——它本机没有、客户机更不会有，跟包要 700MB）。**只在 macOS 成立** |
| 6 | 扫描件被说成"文件损坏" | 抽不出文字就判失败。实测那三份 PDF 文件头 `%PDF-1.7`、能打开能数页，只是每页一张整图 |
| 7 | 失败件仍被复制进资料库 | 进循环就先 `copy2`，失败的也躺在库里、旁边没有 `.md`——**制造入库成功的假象** |
| 8 | 失败清单面板一关就没 | 数据其实一直落盘（`stages` 里），缺的是**原因**（被 `split(" (")[0]` 切掉了）和**常驻入口** |

### 这一批留下的两条通用规则（已进 desktop/CLAUDE.md 铁律）

1. **只在真实调用下才走到的分支，必须抽成纯函数**，否则它就是没人测。
   第 1 条正是这么漏的：本地模式 `--skip-llm` 跳过整个 `tag_llm`，
   那条路径只在花钱的时候存在——不是"忘了写断言"，是**写不出来**。
   抽成 `computeInboxProgress` 之后几毫秒验完，而且当场又逮到「第 1/0 篇」。
2. **要验的东西必须从另一侧取**。支持列表散在四处，走查那份是抄件；
   0.1.2 加 `.doc` 后它算出的期望比生产少一个，报成「整包拖入没有全部入队」——
   听着像丢文件，其实是抄件过期。改成运行时读 `settings.supportedExt`。

### roadmap 挂账

**OCR 支持**：三份扫描 PDF 指向一个真实需求——客户的设计稿 PDF 全是这种。
不进 0.1.2/0.2.0，记账待排。

---

## 0-新b. 分类体系配置化（0.2.0 在建，2026-08-21 开工）

### 为什么做

第二个客户（Jerry，管理咨询）预检暴露：**这个库长着一张 MCN 的脸**。

先纠正一个流传的错误诊断——「客户文件全落兜底区、分类表不认识他的业务」**不成立**。
实测他的目录结构（`管理/` 115 篇、`业务/` 50 篇）**一层不差地保留下来了**，
因为 `03_tag_llm.py:111` 的口径是「category 优先取文件路径，用户亲自分的类 100% 准确」。

真正的病灶是另外四条：

| 现象 | 根因 |
|---|---|
| 顶层 `20_公司管理`/`30_课程`/`40_带货` 全空 | MCN 专用目录出厂就建，对别的客户是纯噪音 |
| 客户真实分类被埋在 `80_资料库/` 下一层 | `library` 是唯一落位区，用户的一级目录降成二级 |
| 摘要口吻不对 | `03_tag_llm.py:42` 写死「你是美妆带货MCN公司的资料管理员」 |
| 平铺投递分类离谱 | `03_tag_llm.py:50` 写死三选一枚举 |

### 拍板结论

- **先去 MCN 化，暂缓"智能规划"**。LLM 从文件名反推分类，对有目录结构的客户
  最好也只是复述用户已有的目录，最坏给出更差的分类——而且它有个**安全洞**：
  整包文件名清单在 `09_pii_guard` 判定敏感**之前**就出网，绕过 A-8 边界
  （`XX绩效.xlsx`、`员工身份证扫描件.pdf` 这类文件名本身就是敏感内容）。
  留 roadmap，**实现前提 = 文件名级敏感过滤先行**。
- 不新建第三份配置文件，**扩展已有的 `.mcnai/layout.json`**
- 版本切分：0.1.2 = bug 修复批；分类体系走 **0.2.0**，动 pipeline 遵守冻结纪律

### 团队版衔接设计（预留，本版不实现）

分类配置最终要**随主库上服务器、仅管理员角色可改、全公司统一**——
本次配置化就是这件事的前置工程。格式里已经留好两个位：

- `scope: "vault" | "org"` —— `vault` 是这一份库自己的配置；`org` 表示"随主库下发、
  本地只读"。**本版只读不写 `org`**，真正的下发链路在团队版做，格式先留好免得到时候动数据。
- `version: number` —— 加字段不涨，改语义才涨；服务端下发时靠它判断客户端认不认得

### 批 1 已完成（2026-08-21）

**配置格式 + 统一读取器**，行为不变。

排查时发现的结构问题：同一份 layout.json 在 desktop 有 **4 处**各自 `JSON.parse` +
各自兜底，pipeline 第 5 处，四套默认值互不知情——**已经漂出两个真 bug**：

1. `routes.ensureRouteFolders` **根本不读 layout**，直接 `95_待入库 ?? 00_投递箱`。
   库里把投递箱改了名，分流子文件夹就建到没人看的目录去，用户往「参考资料」
   放文件永远不会被处理。
2. `orchestrator` 只在 **catch 分支**探测老库名；layout.json 存在但缺 `inbox`
   字段时它落 `00_投递箱`，而 `cli.py` 探测 `95_待入库`——同一个库两边认的
   投递箱不是同一个。**已统一按 cli.py 的顺序（配置 → 探测 → 出厂）**，
   这是本批唯一一处刻意的行为变更，有专门断言守着。

交付：`desktop/src/main/vault/taxonomy.ts` + `pkb-pipeline/taxonomy.py`（互为镜像），
5 处读取全部收口；`npm run smoke:taxonomy` 是**跨语言契约测试**——同一批 fixture
分别喂给 TS 与 Python，逐字比对紧凑排序 JSON，一个字不一样就红。
A-3 那次（两边各写一套实体路径，双链从 352 掉到 2）就是这套测试要防的事。

---

## 0. 当前状态与待办排序（2026-08-18 收官）

### 修复大单：四批 + 一次补做，**高严重度全部清零**

用 Maggie 源数据在隔离环境重跑 + 批跑问答，抓到的问题分四批处理，第 3 批漏掉的 A-1 已补：

| 批次 | 提交 | 内容 |
|---|---|---|
| 第 0 批 | `29e564c` | 提示词层：检索分词指引、Grep 兜底、禁暴露内部机制、敏感只用不说 + 线路纪律断言 |
| 第 1 批 | `5d47f63` | B-1 检索器：虚词清洗 + 三道闸模糊回退 + 检索优先约束 |
| 第 2 批 | `8d5bf94` | A-2/A-8/A-4：敏感不上云、`03b` 接回链、三态开关、失败可见、冻结产物更新 |
| 第 3 批 | `20aef24` | B-2 计价对齐真实账单、A-7 上云不再截断、B-6 引用校验、B-7 幽灵模型、B-5 错误中文化、`showCost` |
| 补做 | 见 `git log` | **A-1 整包拖入递归**（第 3 批漏做，2026-08-18 收官核实时发现并补上） |

**逐条状态：高严重度已全部清零。**

| 已修 | 未修 |
|---|---|
| **B-1 高 · A-8 高 · A-2 高 · A-1 高** · A-4 中 · B-2 中 · A-7 中 · B-3 低 · B-5 · B-6 · B-7 | A-3 中 · A-5/A-6 低 · B-4（已归档，由网关方案覆盖） |

**第 3 批的计价修正值得单记**：拿到 DeepSeek 官方账单导出后做三方对账，查出**出厂单价本身是错的**——
v4-pro 输入低估 **2.23 倍**、输出低估 1.70 倍，缓存读倍率 0.1 实为 **1/30**（那个 0.1 代码里本来就标着
「未验证的假设」）。已改为官方线路人民币原生计价并加 `PRICING_REV`（否则修复到不了已装机器）。
详见 `docs/QA-REPORT-qa.md` §9。

### 云端基线已建

`mcnai-test` 测试账号（Supabase）+ 隔离 userData，走**官方直连**（`api.deepseek.com/anthropic`）跑通：

- 10 题问答批 **10/10 成功**，`route=deepseek` 全部落账
- 全量入库上云：**61 篇非敏感上云、37 篇敏感按设置仅存本地**，进度事件 `20/61 → 40/61 → 60/61`（A-7 的 50 篇截断已解）
- 三方对账 **①②③ 一致**（账本 = 用量页 = usage-report = ¥3.4246）

> 线路纪律（永久）：DeepSeek 一律官方直连 `api.deepseek.com`；增强档 `claude-opus-5` 走中转站 `api.inferera.com`（2026-09-03 起 aihubmix.com 从所有默认值清除，见 §0-新f）。
> 真实调用前必须打印 `ai.tiers()` 的实际 base URL 核对，走查里有永久断言守这条。

### 发布前全面自测（2026-08-19，报告见 `docs/RELEASE-CHECK.md`）

苹果证书到手、准备打第一个正式签名版之前做的一轮只查不改（高严重度当场修）。
**全量测试体系跑到全绿**：本地主走查 / **打包形态主走查** / a1-enqueue / smoke steps·cards·resume /
login-provision / **E2E_CHAT 全量（跑到终点，零红）** / smoke:provider 最小集。
E2E_CHAT 那 20 张旧配色基线**本轮已自然刷新，该条已知状态销账**。

**抓到一个阻断级的真洞（已修）**：`cloudSync` 判敏感只读前 800 字符，
而 A-3 之后 frontmatter 带 `entities_talent` 长数组，把最后写的 `sensitive: true`
顶出了窗口 → **达人信息表 / 收支利润表 / 两份年框合作 / 目标管理总表照常上云**。
判据抽成 `src/main/lib/sensitive.ts` 改为整块 frontmatter 都看；647 篇真实笔记对照零不一致；
`smoke:cards` 加 7 条断言守住。**后果已坐实**：测试账号云端 private 层里检出了达人信息表的
原始表格行（含身份证号）——存量清理与「大头那台要不要查」待用户裁决。

新增三个专项脚本（都进 `e2e/`）：`fresh-install.mjs`（全新装机全链路，
**「新建模板库」这条路以前零 e2e 覆盖**，A-3 的双链哨兵现在长在这里）、
`upgrade-path.mjs`（拿真实 userData 副本验覆盖安装，七件事全绿）、
`offline-recovery.mjs`（**R-05 未修前它是故意红的**）。

> ### 🔴 发版后第一优先：把大头升级到含 A-8 的版本（2026-08-19）
>
> **她那台当前跑的是 A-8 修复之前的构建。** A-8 的洞（`cloudSync` 判敏感只读前 800 字符，
> 被 A-3 之后的长 frontmatter 顶出窗口）在她机器上**仍然活着**——
> **她本地只要再触发一次全量同步（重新入库 / 批量改写笔记 / 换库重扫），
> 那几个敏感文件就会被重新推上云**，2026-08-19 刚清掉的 398 条切片会重新长回来。
>
> 所以云端清理**不是一次性的事**：不升级，清了还会再脏。
> 「尽快给她升级」因此从可选项**升为发版后第一优先动作**，指引写在 `docs/RELEASE.md` §0。
> 升级前告诉她**先别做批量重新入库**。

**第二轮裁决已落地（2026-08-19，详见 `RELEASE-CHECK.md` §6c）**：
- **R-02 云端敏感存量**：测试账号 `mcnai-test-a` 的 private 层 **3019 → 0**，
  按判据用产品自己的检索接口验过（private 命中 0、PII 模式 0）。
  **大头账号已按拍板代清**（2026-08-19）：private **3581 → 3183**，那 4 个文件的切片清零、
  全量 PII 扫描 **0 处**；其它账号一条未动。原先的清单是 **4 个文件 / 398 条切片**
  （`OMG美妆x霞飞年框合作` 325 条含 144 个手机号、`内容-2026年度目标管理总表` 71 条含 2 个身份证号），
  清单在 `/tmp/maggie-cloud-sensitive.json`，处置方式待拍板。
  **⚠️ 一个坑**：让她重新全量同步**清不掉**已有的敏感切片——去重只按 `file_path` 先删后插，
  而敏感篇这次根本不会 ingest，旧切片会原地留着，必须显式删。
- **R-03 MOC 泄漏**：`04_gen_moc` 对 `sensitive: true` 的笔记只列链接不写摘要
  （pkb-pipeline `bf07070`，已冻结并同步提交源码）。升级库实测：摘要泄漏 74 条 → 0，链接 74 条全保留。
  **另记**：`mcn-ingest` 二进制的 sha256 不随阶段脚本变化（脚本是 `_internal/` 的数据文件），
  校验阶段脚本改动要比对 `_internal/` 里的 `.py`，别拿二进制哈希当版本指纹。
- **存量双卡清理**：建卡器补上"两边都有卡 → 旧卡为准、关联段并回旧卡、标准位置那张进废纸篓"。
  删之前要求那张卡是纯机器生成（有自动区 + `auto_hash` 对得上 + 自动区外无用户内容），
  任何一条不满足就两张都留着只报数。真实库实测 **118 组同名 → 0**，角色分布无退化。

**三条裁决已落地（2026-08-19，详见 `RELEASE-CHECK.md` §6b）**：
- **更名**：~~`productName` 不改~~ → **2026-08-19 晚再次复议后改为 SamePage**，见 §4-27
- **升级库不再双卡**：建卡器加旧卡探测——同名实体在任意目录已有卡则跳过新建、
  在旧卡上补关联段，**不自动合并**；复用时只补 `entity_kind`/`entity_name` 两个字段
  （不补的话图谱角色会退化，实测达人 169 → 34）。走查库端到端：
  **同名实体卡重复从 137 对降到 0**，达人 170 / doc 占比 58%，图谱没退化
- **空库引导**：工作台空库时换文案 + 一行指向，不做浮层；完整 onboarding 记 roadmap

### 待办排序

0. **先看 `docs/RELEASE-CHECK.md` §6 那五条**——有两条是发版前要你拍板的（敏感存量、MOC 泄漏面）
1. ~~**过程可见性**~~ ✅ **2026-08-18 完成**（见 §2-18）：agent 干活期间逐条出中文步骤（带真实参数），回答开始输出就折叠成一行摘要
2. ~~**A-3 达人卡进链 + 图片能力**~~ ✅ **2026-08-18 收官（用户过目 PPT 后判决：当前版本接受，
   后续真实使用发现问题按 bug 追改）**。实体层（三类卡 + 归一 + 敏感继承 + 合同枢纽）与图片能力
   （嵌图落盘/渲染、附件直供、原生 chart）已上线并冻结；双链 2 → **400**（旧库基线 352）。
   建卡器按拍板放在 TS 侧（`vault/entity-cards.ts`），`08_table_to_cards` 不接回链、不在冻结产物里。
   **验收做到哪一步、哪两项没做完，见 §3「未解决/未做」的 A-3 条目——收官不等于全验过**
3. **SamePage 商标检索（2026-08-18 更名时记，未做）**：9 类（软件）/ 42 类（SaaS）近似查询待办。
   **已知风险点**：美国曾有 `Samepage.io`（团队协作产品，Kerio 出品）——同名同类，
   海外扩张或应用商店上架时可能撞。国内注册可行性要专业检索，不要凭搜索引擎结论下判断。
   在检索出结果之前，**不要把 SamePage 印到对外物料/合同上**（界面用没问题，改名成本已经付过一次）。
   **⚠️ 2026-08-19 晚的改名把暴露面往外推了一格**：现在 dmg 文件名、.app 包名、Dock 显示名
   都是 SamePage——客户的下载目录与「应用程序」文件夹里会留下这个名字。
   界面内使用与文件名使用的性质接近（都不是商标性使用），**但商标检索这条待办的优先级
   因此上调**：真要撞上 `Samepage.io`，现在要改的东西比只改界面时多了 dmg 名与包名。
4. ~~**苹果证书四合一**~~ ✅ **2026-08-19 完成**：Developer ID 签名 + 公证（`.app` 与 `.dmg` 都签都公证都订票）
   → 客户双击直接开、不用右键、不用 `xattr`；Electron 锁一并解到 **43.4.1**（Node 24，supabase-js 的
   Node 20 弃用警告随之消失）；XProtect 误杀的根治路径走完。发版手册见 `docs/RELEASE.md`，
   升级抓到的两条回归见 §4-2
5. **发版后第一优先：把大头升级到含 A-8 的版本**（指引 `docs/RELEASE.md` §0），
   顺带把她的标准档从中转站切回官方直连（成本 2.7 倍）
6. **云端语义检索修复单**（§3-13 裁决之后的收尾）：`match_knowledge_chunks` 的
   `returns table` 加 `file_path` → webpage `KnowledgeMatch` → 桌面端 `CloudMatch` 与格式串，
   顺带补相关度阈值 / 相近结果警示。做完把 `searchBackend` 从 `local` 切回 `cloud`。
   **数据不用补录**（列早就有、切片一直在写）。**排在第 5 条之后**
7. ~~**自动更新源接真实地址**~~ ✅ **已接阿里云 OSS**（2026-08-19，`docs/RELEASE.md` §C；
   本条 2026-09-02 审计 a14 发现文档漂移才更正——`updater.ts` 里的 `.invalid` 判据在正式包里恒为假，
   只保护占位地址打出来的包）。**剩下的待办**：客户超过 5 家时升级为私有 bucket 或网关鉴权（PLAN-v2 R20 渠道部分，C 档）
8. **M-29 冷调用复测**：签名后要在**重启机器之后第一件事**跑 `e2e/probe-safestorage.mjs`
   才量得到真冷态（本轮 securityd 缓存已烘热，新旧包都 0ms，**没测出结论**）
9. **网关**：key 不再下发客户端（§3「未解决/未做」有完整方案）

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
| 壳 | Electron **43.4.1**（Node 24.18.1 / Chromium 150）+ electron-vite + electron-builder | 2026-08-19 从锁死的 30.5.1 升上来，解锁条件（签名公证）已达成，见决策 §4-2 |
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
18. **过程可见性 · 对话步骤流（2026-08-18）**：agent 干活期间让用户看懂它在干什么。此前只有一张 8 条的「工具名→中文」平表，画在正文上方一行（`检索知识库…`），没有参数、没有结果、没有历史。
    - **主进程链路**（`agent/steps.ts` + `agent/index.ts`）：`tool_use` 分三拍发同一个 `stepId`——`start`（步骤出现）→ `args`（**完整 assistant 消息才有的入参**，流式那条只给工具名）→ `result`（`user` 消息里的 `tool_result` 回填结果数与失败标记）。入参**白名单提取**（检索词 / 文件名 / 扫描目标 / 产物格式），outline JSON 这类大字段一律不带。**事件字段扩展（`AgentStreamPayload.step`），复用 `agent:stream`，零新增 IPC**。
    - **渲染层**：映射表独立在 `renderer/src/config/steps.ts`（未映射工具兜底「正在处理」，**产出的任何一句话都不含工具原名**）；步骤流状态在 `renderer/src/lib/step-stream.ts` 的模块级 store（`useSyncExternalStore`，切页面不丢、**不落库**）；`components/StepStream.tsx` 逐条 spinner / 折叠摘要 / 点击展开 / 失败与重试标记。样式全走既有 token，没新造。
    - **文案**：`正在检索资料库：{关键词}` ／ `正在阅读《{文件名}》` ／ `正在逐份核对{目标}`→`核对了 N 份{目标}` ／ `正在确认库中没有相关记录`（验证性扫描）／ `正在生成 Word 文档（通常约 X 秒）`。**时长禁止写死**：X 取本机 `usage` jsonl 的 `byType.medianMs`，没有历史时说「内容较多时需要几分钟」。
    - **折叠**：回答开始输出 → 收成一行 `检索了 N 份资料 · 用时 Xs`，点开看明细；**新步骤到达会再摊开**（模型常"说两句→再调一次工具"，第一句话就折死等于把后面的活儿全藏起来）。
    - **对位不猜**：分组挂在**哪条消息**上由 App 落消息那一刻告诉 store（`anchorStepGroup(sessionId, messageIndex)`）。原来打算"最后 K 个分组对最后 K 条回答"，但只要中间插进一条**没有过程的** assistant 消息（预检失败的 ⚠️ 气泡就是），后面全部错一位。
    - **走查现场抓到并修掉的四个**（都不是构建能发现的）：① **`Skill` 每轮开头刷一条「已处理」**——`options.skills` 没配 → 走 CLI 默认，模型会去翻 SDK 内置技能清单，秒回、零产出；而本产品的产物是 `render_pptx`/`render_document` 出的、`resources/skills/` 只有 `.gitkeep`，所以 `Skill`/`TodoWrite` 这类基础设施工具进 `NOISE_TOOLS`，不进步骤流（**与「未映射工具兜底」不冲突**：兜底管没见过的活儿，这张表管明确不算活儿的东西）；② **绝对路径没剥库根** → 说成「mcnai-e2e-vault 里含…的笔记」，把库目录名当成了分区名，改在主进程侧相对化；③ **数字口径混用**——Grep 的 `Found N files` 是**七份笔记**，而 content 模式吐的是**一篇里的几十行**，混成一个数就是「检索了 42 份资料」的瞎报。结果数因此带 `unit`（份/处），量词跟着单位走，摘要**只累加「份」**，并去掉失败步骤、同一篇只算一次；④ 目录 + 逐行命中时「核对了产品 里含「灰太太」的笔记，命中 11 处」把"一批笔记"和"多少行"叠着说，改成「核对了产品里的「灰太太」，命中 11 处」。
    - **兜底收口（根因未查清，如实记）**：走查里出现过一次「一轮跑完了，步骤流还停在展开态、折叠摘要那颗药丸从没出现」（`01e` 截图是现场证据）。用单轮探针复现两次——干净路径、以及 H-10 切走切回路径——**都没能重现**，所以根因没查清。做法是按本仓库既有的约定补一道兜底而不是猜：`agent:stream` 是**尽力而为的推送**（任务层那条约定明写着"push 尽力而为、snapshot 才是权威"，窗口刷新期间 `webContents.send` 会静默丢事件），丢的要是收尾那一下，步骤流就会永远转着圈。所以 Workbench 里加了一条以**任务层为准**的收口：主进程说这条 agent 任务已经不在跑、而步骤流还挂着 live 分组 → 就地收口。`step-list` 上另外挂了 `data-live` / `data-pinned`，走查等不到折叠摘要时会把这两个连同各元素计数一起 dump——不然"分组还活着"和"用户点开过"长得一模一样，只能靠猜（为这个白跑过一轮）。**再遇到就从这两个属性入手**。
    - **仍然做不到的**：检索与扫描之间、几次检索之间的**重复命中去不掉**——工具只回条数、回不了路径。所以摘要那个 N 是「命中条目数」，不是「不重复的笔记数」，口径写在 `resourceCount` 的注释里。
19. **检索策略收紧 + 扫描护栏 + 表述规范（2026-08-18，真人验收第二~四轮逼出来的）**：过程可见性把问题照出来了——同一个问题跑 **188 秒**，步骤流上全是 `my_script` / `script` / `40_带货/数据` 这类 0 命中的猜测式 Grep。
    - **提示词**：规则 3 拆出 3b「检索有命中就先把命中用足，再去找」；规则 4 改成**先点名可用工具**（Grep 找内容 / Glob 找文件名 / Read 读全文，并明说命令行是关着的），再讲两种正当时机与「别猜」，末尾给一句「用户问题里的专名就是最好的关键词，一次 Grep 通常就够」。
    - **硬护栏 `SCAN_LIMIT = 5`**：挂在 **`PreToolUse` 钩子**上，数着放行、超了直接拒。
      **踩坑（重要，别再挪回去）**：第一版挂在 `canUseTool` 上，为此把 Grep/Glob 移出了 `allowedTools`——那是「免提示自动放行」名单，在里面就不走 `canUseTool`。结果**适得其反**：模型不用 Grep/Glob 了，改用 **Bash 调 grep**，而 Bash 从来没开放过，连撞 9 次拒绝，实测 **174 秒，比不管还慢**。`PreToolUse` 对预授权工具照样触发，所以 Grep/Glob 可以留在名单里（无摩擦），闸门另挂一层。
      **拒绝语必须指路**：只说「工具 X 未开放」等于鼓励它换个姿势重试同一件事；现在会告诉它可用的几条路、以及命令行是关着的。
    - **步骤流侧**：被护栏拦下的那一步显示「已达本轮文件查找上限，改用已有材料作答」，**不画成失败、也不计入「检索了 N 份资料」**——它是我们自己踩的刹车，不是故障。
    - **验证性扫描要说清"确认的是哪儿"（2026-08-18 真人对照截图指出）**：三条扫的其实是不同的东西（Grep 翻正文、Glob 比文件名、换个词再来一遍），却都显示成一模一样的「已确认库中没有相关记录」，连着三条读起来像复读机，也看不出它到底查过哪些地方。改成按工具与范围出文案：`已确认正文里没有「霍格沃茨」` / `已确认文件名里没有「霍格沃茨」` / `已确认 20_公司管理 的正文里没有「X」`；没有关键词时文件名说"没有匹配"、正文说"没有相关记录"。走查加了**复读机回归**（多条验证性扫描文案不许全都相同）。
    - **表述规范（规则 10b）**：用户是**一边看步骤流一边读正文**的。模型此前把「检索到了但不相关」说成「三次检索均无命中」，与步骤流的「相近结果 6 条」直接打架，观感是产品自己打自己。现在明令：有结果但判断不相关**不许说成无命中**，要说「检索到的内容与问题不直接相关，我改为直接查阅相关档案」；**凡步骤流会展示的客观事实（命中数、文件名），正文转述不得与之矛盾**。规则 10 同时放宽——用人话提一句"检索/查阅"不算暴露机制，否则它只能含糊其辞。**补充一条**：检索给的是「相近结果」而最终判定库里没有时，正文要用一句话交代这些相近结果的去向（例如「检索到的相近内容与霍格沃茨无关」）——界面写着"相近结果 6 条"、正文只字不提，用户会以为模型漏看了。
    - **实测（同一问题「灰太太最近的数据怎么样」）**：188s 猜路径 → 174s 撞 Bash（改错那版）→ **93.6s / 7 步 / 文件查找 3 次 / 0 猜测 / 0 Bash**，正文与步骤流不再矛盾。**60 秒没达标**：剩下的时间是"读原始大表 + 生成汇总答案"，不是瞎试——**与 §3-13 同一个根**（云端检索给不出可引用出处，模型只能自己读表汇总）。压到 60 秒的三个杠杆（修云端检索 / 限 Read / 压回答长度）里，只有第一个不牺牲答案质量。

    - **验收**：`npm run smoke:steps`（纯逻辑，零 token，71 条断言：参数提取 / 结果计数与单位 / 文案映射 / 兜底 / **十种工具 × 四种阶段一个英文工具名都不许漏**）＋ 走查 48–53（见下）。

20. **品牌视觉二期：更名「拉齐」＋ 新 logo ＋ 配色体系切换（2026-08-18）**。只动渲染层样式/文案 + 图标产物，
    业务逻辑、IPC、主进程链路零改动（主进程只改了窗口标题/菜单/诊断报告标题这几处字符串）。
    - **logo（方向：对齐线）**：三条长短不一的横线（y=7/12/17，右端齐 x=15，线宽 2）+ 一条橙色垂直基准线
      （x=19，y=4~20，线宽 **2.5**，圆角线帽）。**横线右端与基准线之间刻意留一道气口**——基准线是"尺"，
      不是把横线焊死的框。实现为内联 SVG 组件 `renderer/src/components/Logo.tsx`（不是位图，三个落点同一份几何）。
      **小尺寸规则（≤20px 走 dense）：横线 ×1.15、基准线 ×1.24**，两个系数是 16×16 光栅化后逐像素挑出来的，
      不是估的：同比 ×1.28 会把气口吃到 0.75px 糊成一块；只加粗横线则橙线反而比横线细、主次倒挂。
      **改这两个系数必须重跑一次 16px 像素复验。**
    - **三个落点**：侧栏 20px + 「拉齐」文字标；登录页 72px（替换原来的粉花 `assets/logo.png`——
      那个文件**不要删**，走查拿它当附件样本图，见 `walkthrough.mjs` 里的注释）；macOS 图标
      `scripts/gen-icon.mjs` 出 icns 全尺寸套件（深底 #1E1C1A + 浅线条 + 提亮橙）。
      **小图标专门放大标记占比**：按标准 1024 栅格算，16px 上标记只剩约 8px 高，三条线加两道缝挤不下（实测糊成一团），
      所以 ≤32px 减小内缩、放大标记（`ratios()`）。跑法 `node scripts/gen-icon.mjs`（要本机 Chrome + 系统 iconutil）。
    - **配色**：炭黑侧栏 `#211F1C` + 暖白纸面 `#FAF9F6` + 信号橙 `#E8590C`（深底上提亮到 `#FF8A47`），
      玫瑰主色全部角色被替换。**深色侧栏的做法是在容器上就地改写同名 token（`.sidebar-dark`）**，
      不新造一套类名——侧栏里的组件全部走 `text-ink`/`text-muted`/`bg-hover`/`border-line`，
      换变量值就整体变深，组件一行不用改。**代价与禁忌**：任何从侧栏"飞出去"的浮层（模态/toast）
      都不能挂在这个容器下，否则会连带吃到深色 token。
    - **两个新 token 是这次的关键**（改配色前先看懂这两条，否则会踩回去）：
      ① **`--color-accent-ink`**：Tailwind 的 `text-accent` 单独映到它。`#E8590C` 当正文色压在纸面上
      只有 **3.40:1**，达不到 AA；`#C2500C` 是 4.5:1，肉眼仍是同一支橙。「面」（发送键/进度条/选中底/图谱高亮）
      仍用足量的 `--color-accent`。② **`--color-surface`**：用户气泡、代码块、空态框这些"比纸略深一档的底"
      以前复用的是 `--color-sidebar`（那时侧栏也是浅灰），侧栏改炭黑后**必须分家**，否则对话气泡和代码块整块变黑。
    - **橙 = 基准线母题**：步骤流左边线、投递箱/TaskDock 进度条、云端降级条（`--color-warn` 并进橙系）统一表示
      "进行中/降级中"；**成功绿 / 失败红 / 取消灰这些终态语义色一律不动**（走查 34b 那张就是证据：
      取消后的进度条仍是中性灰）。图谱只动 group-1：原玫瑰 `#cf5b7a` 与信号橙同屏发冲，挪到陶红 `#d2613c`，
      其余六支保留（藕紫是谱系里唯一的冷调支点，去掉图谱会糊成一片橙）。
    - **已知未达 AA 的一处（如实记，不是遗漏）**：橙色**实心块上的白字**（发送键、笔记「保存」、
      弹窗主按钮）是 **3.58:1**，低于 4.5。与上一版玫瑰实心块（3.4:1）持平、不是回归；要过 AA 只能把实心底
      压到 `#B8490A` 那一档的褐橙，品牌观感损失大于收益，所以维持现状。**深色侧栏那一整套是逐项过了 AA 的**
      （走查每轮真算，见下）。
    - **不改的东西（拍板，见 §4-27；其中 `productName` 与 dmg 名已在 2026-08-19 晚改为 SamePage）**：包名 / bundleId / userData 目录名 / 钉钉群消息文案。
    - **走查新增**：`assertNoOldBrand(页面)` —— 扫可见文本 ＋ `title/placeholder/aria-label` ＋ `document.title`，
      大小写不敏感，**登录门/工作台/知识库/设置/用量五个页面各扫一次**（只在首页扫等于没扫）；
      `assertSidebarLogo()`（在侧栏、16–20px、4 条线、基准线颜色不等于横线颜色且是橙、字标是「拉齐」）；
      `assertSidebarContrast()` —— **在渲染态真算对比度**（文字色多半是 rgba，先合成到实际压着的底上再算，
      拿设计稿十六进制对会比眼睛看到的好看得多），逐项卡 WCAG AA 4.5，测不到 5 项就判选择器失效。
      新增截图 `01i-侧栏-深色hover态`（hover 态只有 CDP 抓屏截得到，见 §4-15）。`login-provision.mjs`
      也加了同一组登录页品牌断言（那一屏动过，光留基线图只能说明"长这样"、说明不了"换对了没有"）。
    - **验收（2026-08-18）**：`node e2e/walkthrough.mjs` 全量绿（本地模式，零 AI 调用）＋
      `node e2e/login-provision.mjs` 通过（该脚本自带一轮真实标准档对话，约 ¥0.01）；截图逐张看过。
      **E2E_CHAT 本轮未跑**（纯视觉层、流式逻辑零改动，用户拍板不跑），所以 48–53 那批步骤流截图仍是上一轮的基线。
    - **收尾总单（2026-08-18 同日，真人过目后一并做掉的五件事）**：
      1. **关系图配色重做（推翻"黄改棕"的修补路线）**。丑的根源不是某支颜色，是
         `hash(doc_type) % 7` 让 500+ 个节点**每一个都在抢颜色**。现在按**角色**取色
         （主进程 `vault/graph.ts` 的 `kindOf` 算好下发，渲染层不猜路径）：普通文档统一暖灰
         `#B8B0A4` 当背景组织，只有三类实体卡有颜色（达人=品牌橙 / 产品=灰绿 / 合作方=藕紫），
         枢纽（MOC/主题索引/`is_contract`）用**深炭 + 半径 ×1.4**——用重量区分不用颜色。
         选中/悬停不再换填色**只加橙环**（先描一圈纸色再描橙，否则达人卡本身是橙的、环和点糊成一坨），
         一度邻居放大 1.15 倍、其余压到 12%（不是全隐——整图的形状还得在）。图谱左下角常驻图例。
         **走查断言**：五种角色必须**全都存在**（走查库里产品卡阈值从来没够过，所以脚本会
         临时造一张产品卡再删掉——否则绿色分支永远没被验过，而图例上却写着「产品」）；
         `doc` 占比 <50% 判红（"多数安静"是设计前提不是修辞）；图例五项的色点必须**等于**对应 token 值；
         旧的 `--color-group-1..7` 一支都不许残留。
      2. **toast 语义色成体系 + 几何统一**（真人点名"同屏两条长得不像一家人"）：
         `info(炭黑,默认) / ok(绿) / error(红) / warn(琥珀) / running(橙)` 五类，
         **只有底色随语义变**——宽度 380 / 圆角 12 / 字号 13 / 内边距 10·16 全部收在 `ui.tsx` 的
         `TOAST_BOX` 一处，动作按钮在五种底色上是同一颗描边胶囊。
      3. **管理员区解锁提示归信息类**（中性炭黑）：解锁是"告知发生了什么"，不是任务成功。
         同批把「未发现可入库的文件」从**红改琥珀**——系统没坏、用户也没做错，报红会让人去查日志。
      4. **旧玫瑰残留清扫**：源码里已经一支都不剩（token 层切换时连根拔了）。补的是**运行时断言**
         `assertNoRose()`：五个页面各扫一次全部元素的 color/background/border/outline/fill/stroke，
         精确黑名单（旧主色与它的淡色/线色变体）+ 色相兜底（H 300–355 且有饱和度）。
         唯一白名单是关系图图例里的藕紫，**按 DOM 位置给不按色值给**（按色值等于把整段紫色区间放行）。
      5. **语义色对照表进档**：`docs/DESIGN-color-semantics.md` + `docs/assets/色彩语义对照表.png`。
         每一格都是**产品里真实组件的截图**（从 shots 裁的），不是色板示意——色板会骗人，
         同一支橙画成大方块都好看，落到 4px 高的进度条上是另一回事。以后新组件对色照这张表。
    - **收尾总单里踩到的一个真问题（我引入的，已修）**：toast 从"按内容自适应宽"改成固定 380px 后，
      它在窗口顶端横跨的范围变宽，**正好压住笔记头部那排按钮**；而 toast 悬停会暂停倒计时，
      于是鼠标往按钮移过去的路上就把它自己钉死了，按钮永远点不到（走查现场：`编辑` 点击 30 秒超时，
      报 `toast intercepts pointer events`）。修法是把 toast 落点从贴顶下移到标题栏以下（`top-14`）。
      **教训**：固定宽度这类"看起来只是变好看"的改动会连带改变它**遮住什么**，别只看截图好不好看。
    - **三期最终收尾（2026-08-18 同日，用户看过二期截图后推翻两处、并入四项新活）**：
      1. **toast 体系重构：一种底色，语义靠图标**。二期"按语义整条铺底"被推翻——
         三条琥珀「未发现可入库的文件」堆一起是三条大黄横幅，刺眼且抢戏。
         现在**全部炭黑底**，成功=绿勾 / 错误=红叉 / 警告=金琥珀叹号 / 信息=无图标；
         语义底色只留给**持续性状态条**（云端降级条橙、编辑冲突条浅金、错误气泡红边）——
         那些是"一直在的状态"，值得占着颜色，toast 是"说一声就走"。
         宽度从写死等宽改回**按文案自适应 + 上限 420px**（写死等宽正是二期压住笔记头部按钮的根因）。
      2. **琥珀改金琥珀 `#B8761F → #D97706`**（旧值压在暖白纸面上发芥末）；
         新增浅金一套 `--color-gold-soft/-ink/-line` 给编辑冲突条：**浅底深字，不实心深底**。
      3. **更名 SamePage**（二期的「拉齐」用了不到一天）：主名是拉丁字符，单开
         `--font-brand`（`-apple-system`/SF Pro/Inter）——中文栈渲染拉丁字母字重偏轻、
         字距偏松，配中文副标压不住。**logo 不动**（对齐线图形与名字无绑定）。
         走查的旧名扫描升级成同时扫 `mcn-ai` 与「拉齐」。
      4. **关系图：品牌橙从节点常态色退出**。二期把达人卡定成品牌橙，169 个达人节点
         等于图谱里最大的一团在跟界面主色抢戏；而"橙"在产品里已经指派给"进行中/焦点"了。
         达人卡改**陶土红棕 `#A85D48`**，产品灰绿 / 合作方藕紫 / 枢纽深炭 / 文档暖灰不变，
         **橙只留给交互态**（选中悬停的高亮环）。走查加硬约束：`--color-graph-*` 一支都不许等于
         `--color-accent`。边线降到 **0.6px** + 颜色再淡一档 + **透明度随缩放联动**
         （缩得越远越淡，`fadeLink()`）。
      5. **用量页 14 天柱图按档位堆叠**：下段标准档浅橙 `#F4B896`、上段增强档深橙 `#C2500C`，
         下方两色图例，数据来自 jsonl 的 `tier`（老记录没有这个字段 → 计入标准档，
         那时只有一条线路，归标准是符合事实的）。**断言量像素不数 div**——分段高度算成 0 时
         "两个 div 都在"照样通过（14 天柱图第一版就是这么漏过去的）。
      - **真人复看后的两条返工（三期收尾）**：
        ① **达人卡再降一档到灰陶土 `#9A6B5C` + 半径 ×0.88**；合作方/产品卡反过来 ×1.2。
        原则写进注释了：**数量最大的类别必须最安静，显眼度让给数量少的**。
        （这支色被推翻两次：品牌橙 → 陶土红棕 #A85D48 → 灰陶土。判据不是"这个色好不好看"，
        是"121 张铺开会不会成片"。）
        ② **标签分级 + 碰撞剔除**（真人点名"放大图里标签互相压字"）。标签从
        `nodeCanvasObject` 搬到 **`onRenderFramePost`**——逐节点回调做不到这件事，
        先画的已经落在画布上、盖不掉了。现在每帧收尾时按优先级（枢纽 > 合作方/产品 > 达人 > 文档，
        同级看连接数）统一排一遍，占位登记矩形，相交的直接不画；悬停节点与一度邻居永远优先且必显。
        缩放阈值 hub 0.4 / 合作方·产品 0.5 / 达人 0.8 / 文档 1.8（本库 fit 后 k≈0.65，
        所以枢纽在远景就有名字——否则整张图没有一个地标）。
        **字号改成屏幕恒定 11px**：旧写法 `min(11/k, 6)` 有上限，缩小时字跟着缩，
        远景标签只有 4px 高＝一堆看不清的斑点；现在字不变小，放不下的交给碰撞剔除（Obsidian 的做法）。
      - **用量页视觉微调（2026-08-18 收尾后追加，纯样式）**：「最近 14 天」单独做成
        **深色仪表盘卡片**（`.chart-dark`，同 .sidebar-dark 的就地改写 token 手法）——
        **只此一张卡是深色**，页面其余部分维持暖白纸面：两块深色就没有焦点了，走查有断言守这条。
        柱色随之提亮（标准 `#F5A623` / 增强 `#C2500C`，深底上不提亮就立不住，两段明度差是这张图的
        全部意义）；加暗灰网格线、暖灰坐标轴、峰值标注；悬停出**自绘** tooltip（日期 + 两档次数），
        没用原生 `title`——系统提示在深卡上是另一套观感，还要等一秒才出。
        两处小坑都是拍验收图时撞出来的：气泡在最右那根柱子上会**探出卡片**（按位置夹回来了）、
        气泡会**盖住标题行的提示文案**（提示挪到底部图例那一行）。
        还有一条**看不见的坑**：日期轴用 `text-muted-soft`，而 `.chart-dark` 一开始没定义这个变量——
        它继承了 `:root` 的浅色值，在深底上碰巧也能看。**碰巧不是设计**，已显式写进 `.chart-dark`（对比度 5.46）。
      - **拍图踩的坑（写给下一个改图谱的人）**：Playwright 的 `mouse.move` 是**瞬移**，
        直接跳到画布外不会在 canvas 里产生 mousemove，force-graph 就不重算 hover——
        于是"整图"那张拍出来是**悬停压暗态**（大半张灰）。清 hover 必须在**画布内**再动一次鼠标。
        02d/02e 两处都补了这个抖动。
      - **顺带查实的一条数据事实（不是配色 bug，别照着改颜色）**：升级过的库里
        **同一个实体会有两个同名节点** —— 旧 pipeline 写在 `20_公司管理/合作方/霞飞.md`
        （只有 `doc_type: 合作方`，没有 `entity_kind`），A-3 之后的建卡器写在
        `30_实体/合作方/霞飞.md`（`entity_kind: partner`）。前者按角色判定归 `doc`（灰），
        后者是 `partner`（藕紫），于是图谱上出现两个「霞飞」、颜色还不一样。
        **取色是对的**：角色只认 `entity_kind`（卡片），不认 `doc_type`——
        `doc_type: 达人档案` 有 325 篇，都当成达人卡的话"多数安静"当场破产。
        要收拾的是**数据层的重复实体页**（旧目录该清理或合并），不是渲染层。
      - **踩坑（边线调过头）**：透明度下限第一版给 0.35，叠上已经调淡的线色之后整张图的边
        几乎看不见——毛毡感是消了，**团块之间怎么连的也一起没了**。0.55 是目测定的那一档。
    - **E2E_CHAT 专属那 20 张截图本单不重拍**（拍板）：它们的画面仍是品牌二期之前的旧配色，
      属**已知状态不是残留**，走查收尾的归属表里已标注「待下次 E2E_CHAT 轮自然刷新」。
      顺带删掉了一张真·孤儿 `full-重跑后图谱.png`（不属任何脚本，走查每轮都在报它）。
    - **走查现场抓到的两条（都不是产品 bug，是走查自己的假设过期）**：① 产物卡片 hover 断言采样一次就判死——
      光标停着不动时列表被 watcher 刷新一次就可能把光标底下那个节点换掉，而 `:hover` 要等下一次鼠标移动才重算
      （隔离脚本怎么都复现不出来）。改成移开→重新 hover→轮询，**失败时 dump 现场**（`:hover` 命中与否 / 按钮列表）；
      ② 「产物入库→已入库」的等待上限 320 秒不够，实测入库在超时后 **18 秒**才落地——这一步排在投递箱用例后面，
      入库任务常常在排队，而 A-3 之后每轮 pipeline 末尾还要给全库跑实体建卡。上限提到 600 秒并每 30 秒打一次任务状态。
      **教训与 `waitInboxIdle` 那次同源：pipeline 变慢会把一批"当时刚好够用"的等待上限逐个变成假红。**

15. **验收基线**：Maggie vault 全量数据「批量导入→问库→生成PPT→回看产物」闭环通过；e2e 走查脚本 `desktop/e2e/walkthrough.mjs` + 截图基线 `desktop/e2e/shots/`（GUI 改动必须跑走查看截图再交付——用户铁律）。2026-08-16 新增走查步骤：空库引导（独立空库实例）＋首页卡片区＋chips 填充＋输入框 60px/附件位＋流式光标（E2E_CHAT=1 真实流式时截行尾光标）＋投递箱六阶段进度条＋产物卡片 hover/打开/入库/预览＋最近对话卡片点开＋建库卡片 hover＋笔记 ··· 菜单/删除二次确认/新建→删除全链路＋搜索摘要洁净度＋空值与空表格＋分区投递静态同款与悬停高亮＋首页产物面板默认收起；UI 精修第二轮再加：文件树默认宽 220 断言＋三栏分隔线真拖（tree +90 / graph +80，断言宽度变化与 localStorage 落盘，重载后复查记忆）＋关系图配色特写（扫 canvas 像素定位节点团中心 → 滚轮放大 → 裁中间一块，配色需人工看这张确认）＋markdown 表格样式（临时造一篇带表格的笔记，断言圆角与行 hover 变色）。**跑法**：`node e2e/walkthrough.mjs`（本地模式）或 `E2E_CHAT=1 node e2e/walkthrough.mjs`（用测试账号登录跑真实 AI，01d/01d3/01e 只有这样才刷得到）；再跑 `node e2e/login-provision.mjs` 刷 00b/11/12，跑完看收尾那段「未刷新」清单。UX 审计 P0 批次新增走查步骤：笔记编辑→保存成功 toast＋落盘断言（20/20b）、编辑中切笔记的未保存确认（取消留在原地且草稿不丢 / 放弃后磁盘内容不变，21/21b/21c）、换库二次确认＋向导「返回当前库」（22/22b/22c）、设置页手填 key 保存＋「重新获取服务端配置」反馈（10b/10c）、侧栏删除对话的二次确认＋toast（23/23b）、**真拖一个文件到工作台页**（合成带真实 `File.path` 的 DragEvent，断言覆盖层出现、没发生导航、侧栏与输入框还在、文件确实进了投递箱目录，24/24b）。**任务层一期再加**：投递跑着切到工作台断言全局条仍在（25）、切回知识库断言运行态与进度条还在（26）、**趁任务活着 reload** 断言主进程快照与 Dock 都还在（27——必须在任务活跃那一刻刷新，等它跑完再刷测到的是"收起"那条分支）、Dock 高度过渡属性、Dock 条数与 `tasks:list` 活跃数一致（**两轮 pipeline 之间有 3 秒去抖窗口，那一刻确实没有活跃任务、Dock 本就该收起，所以这两条必须轮询、不能采样一次**）、产物入库三态 29/30/31/32（含 reload 后「已入库」仍在、点「已入库」跳落位笔记）、云端离线降级 33（独立实例把服务器地址指到 127.0.0.1:9 再重启，断言照常开窗+离线条+知识库可用）、E2E_CHAT 下的 H-10 切走切回（28，断言半截正文接得上）。**provider 解耦 + M-29 再加**：~~模型线路卡片三条线路可见并真切一次到 DeepSeek 官方（10e/10f）~~ —— **2026-08-17 起这两步被"管理员区的档位映射"取代（10g/10h），10e/10f 两张截图已删**；手填 key 的点击必须 20s 内返回（旧版是 10 分钟超时）＋ 出等待态文案（10d，冷调用快时可能一闪而过，所以「看到文案」与「任务层留下 secret 任务」二选一）＋ **同一把 key 再存一次断言 `outcome==='unchanged'` 且不新增 secret 任务**；E2E_CHAT 下额外断言连续两次 `auth.provision()` 的第二次 `wrote` 为空（= 老用户重复登录零写入）。**引擎冒烟**：`npm run smoke:provider`（需 `SMOKE_INFERERA_KEY`/`SMOKE_DEEPSEEK_KEY`/`SMOKE_AIHUBMIX_KEY`，逐条线路跑单轮/多轮 resume/abort/工具调用/流式/make-ppt 六项，并用 `result.modelUsage` 断言服务端实际用的就是钉死的模型；`SMOKE_ONLY=<线路>` 与 `SMOKE_CASES=single,abort,tools` 可精确裁剪，**新增线路只跑最小集**即可，见 desktop/CLAUDE.md 的验收铁律）。
    **任务层二期再加**（设计 §6.3 断言 7–13）：投递跑到一半真点「停止本轮」→ 断言任务是 `canceled` 且不带 error、面板文案含「已停止/已完成的部分」、进度条中性灰、**`ps -eo pgid,pid,command` 查该进程组零残留**、已落位的笔记一篇不少（34/34b）；退出应用后同样查一次进程组，验 `before-quit` 不留孤儿；生成中直接调 `chat.send` 断言被拒（`reason:'busy'`）＋界面敲 Enter 出带「停止当前生成」按钮的提示且输入不清空（35）；点那颗按钮 → 半截回答带「（已停止）」留在对话里、之后**不会再补一条完整答案**（36）；**外部脚本真改文件**触发冲突条（断言不弹模态、草稿不变）→「查看对方版本」展开磁盘那版 →保存弹三选一（断言默认高亮「另存为副本」）→ 选副本后**磁盘上两份都在**（37/37b/37c/37d），并单独验一次"应用自己保存不算冲突"；登录页黑洞 socket 验可取消 + 10s 超时文案（38/38b），端口 9 验「网络不可达」不是「密码错」（38c）；syncQueue 用真实 Supabase 约束失败造队列，断言退避 1m→5m→30m→转手动、Dock 出「N 条待同步」+「重试同步」、点重试真跑一轮（tries 4→1）、换成合法内容再存一次即自动清队（39）。**增强档回落再加（2026-08-17）**：新增独立实例**模拟老用户升级机**（大头那台的形态）——第一次启动把 vaultPath 落盘，改 config 抹掉 `tierMigrated` 再启一次 → 走 `migrateTiers` 的老用户分支（**这条之前只在真机上验过，现在进走查了**），断言标准档 `keyField` 搬成 `encryptedApiKey`、base URL 变 inferera；然后只配这一把 key，断言增强档 `hasKey=true` / `usingSharedKey=true` / 选择器里**不再置灰**（45e）/ 管理员区标出「复用中转站密钥」/ **`logs/main.log` 里出现回落日志且写明回落到哪把**。真机侧另跑了一次「拿真实 userData 的副本起应用」的验证：真实网络探测 `ok:true`、菜单可选、回落日志落下。**返工后再加（2026-08-17 验收）**：档位选择器**位置**断言——必须在 `composer-bar` 里、**输入框那一行内不得再有档位控件**、控制条在输入行下方且 `justify-content:flex-end`、按钮上不许再挂 tooltip、菜单必须**向上**弹（比 `getBoundingClientRect`）；管理员区计价配置（默认单价 0.28/1.1、15/75、汇率 7.2）与**落盘**断言（脚本靠这一份）；用量页人民币化——「本月估算花费 约 ¥N」大数字、增强档换算落在 ¥4.5 上下（桩数据反推）、档位对比区三列齐全、类型表「约 ¥X.XX · N tokens」格式、**整页不许出现美元单价**、费用脚注含「估算值/实际账单」。新增截图 10i（计价配置）。
    **档位 + 设置页分组 + 用量再加（2026-08-17）**：档位选择器就位与新会话默认标准（45）＋ **tooltip 与菜单里禁止出现供应商名/模型名**（正则扫 deepseek|claude|opus|aihubmix|inferera）＋ 增强档置灰与「暂时不可用」（45b，独立实例 `MCNAI_E2E_TIER_HEALTH=down`，并断言 `disabled` 真生效、强点也切不过去）＋ 真切到增强档（45c）＋ 增强档失败时的「切换到标准模式重试」出口（45d）＋ **档位按会话记忆**（新对话回标准、切回旧会话仍是增强、`chat.list()` 里 `tier` 真落盘）；设置页四组卡片齐全 + 管理员区默认不可见 + 模型服务卡片在普通模式里不许出现线路/模型串（10）＋ 版本号点 6 次不解锁、第 7 次才解锁（10g）＋ 管理员区两档映射的地址与模型串断言（10h：标准 `api.deepseek.com` / `deepseek-v4-pro` / `deepseek-v4-flash`，增强 `aihubmix.com` / `claude-opus-5`）＋「检测线路」真点一次并要求界面落结论；手填 key 与 M-29 那组断言原样搬到管理员区（10b/10c/10d，testid 改成 `tier-key-input-<档位>`/`tier-key-save-<档位>`），并加一条**「保存后普通模式那行必须跟着变成已就绪 ✓」**（两处说法不一致是最容易糊弄过去的洞）；用量空态引导（47）＋ **桩数据直写 `userData/usage/YYYY-MM.jsonl`** 验读取链路（47b/47c：对话/产物大数字各 +1、两档 token 分开归一、入库打标只记次数且 token 显示「—」、14 根柱子、口径脚注、配额进度条本期不显示）；E2E_CHAT 下额外验**写入链路**——一轮真实对话后 jsonl 必须落一条字段齐全的记录且 `degraded` 为假。
    **走查与真实调用对账抓到的坑（已修，五个）**：① `resolveTierForRequest` 原来会兜底吃 `ANTHROPIC_AUTH_TOKEN`，开发机上常年挂着这个变量，于是"增强档没配 key"那条预检分支在走查里根本触发不到——请求真的发了出去。改成**只有无窗口时（无头冒烟）才吃 env**；② 同一轮发现失败的那两次也被记进了用量，于是把记账收窄到 `subtype === 'success'`；③ **`resolved_model` 记成了轻量模型**（2026-08-17 真实调用对账时抓到）：旧写法取 `Object.keys(modelUsage)[0]`，而一轮里往往同时出现主模型与轻量模型（起标题、压上下文），key 的顺序由服务端给——标准档那一轮排在前面的正好是 `deepseek-v4-flash`，于是记录里写着"要 pro，实际 flash"，看着像被降级，其实 pro 就在同一个 modelUsage 里。改成"主模型在里面就记主模型，不在才记实际那个"（`degraded` 的判据本来就是"主模型在不在"，两者现在一致了）。④ **产物入库跑完了，界面还停在「入库中」**（间歇性，跑第四轮才复现）：`IngestButton` 旧写法要求"亲眼看到 running→succeeded 那一次跃迁"（`was` 有值才认），于是任何"挂载时任务已经是终态"的情况——切页面回来、列表刷新导致重挂、事件在窗口刷新期间被丢——都不会去拉一次已入库表。落盘表里其实早就有记录（走查失败时 dump 出来的三边对账证实了这点）。改成"现在是 succeeded 且上次不是就拉一次"（refresh 幂等），并把走查的失败信息从"只打主进程任务"扩成**主进程任务 / 落盘已入库表 / 渲染层拿到的表三边一起打**——只打一边的话，"主进程说成了但界面没动"和"主进程压根没成"长得一模一样。⑤ **用量页的 14 天柱状图渲染出来是一整片空白**——柱子和日期标签原本挤在同一列里，那一列在 `items-end` 的行里高度由内容决定（只有日期那行字那么高），百分比高度于是全算成 0。**这条是靠人看截图发现的，断言完全没拦住**（`14 根 div 在` 照样通过），所以顺手把断言从"数 div"改成**量像素**（`getBoundingClientRect().height`，最高柱 < 20px 即判失败），并把日期轴拆成独立一行。教训写在这里：结构性断言对"算出来是 0"这类布局塌陷是瞎的。
    **过程可见性再加（2026-08-18，48–53，全部 `E2E_CHAT` 专属——本地模式没有 AI 就没有步骤流）**：断言**一律到参数层**，把主进程发出来的原始步骤事件收进 `window.__steps`，再拿它比对界面上的那句话，不接受「有一条检索步骤」这种弱断言。
    步骤逐条出现且**当前步骤在转圈**（48，轮询而不是采样——单条工具可能 100ms 就回来，采样必然空过）；回答开始输出后折叠成一行、**摘要数字用同一套口径独立重算一遍对账**、必须带「用时 Xs」（49）；点摘要真展开看明细（50）；检索步骤含**真实检索词**、阅读步骤含**书名号真实文件名**、核对步骤含**目标 + 数字且量词与单位对得上**（数字还必须能在原始事件里查到出处）；**整个步骤流区域正则扫一遍，一个英文工具名都不许有**。
    验证性扫描（51）：**把 `apiBaseUrl` 临时指到一个 404 前缀**逼 `searchCloud` 回 null，走产品自己的「回退本地全文检索」，本地检索一个库里没有的词才真是 0 命中——**登录态下云端语义检索没有相似度阈值**（migration 012 的 RPC 只有 order+limit），库里只要有东西就必回 6 条，问什么都不会是 0。用 404 而不是黑洞地址：传输层失败会点亮「云端离线」条，糊在后面每一张截图上。
    **这一步的问法踩了两次**：检索 0 命中好造，难的是**紧接着那一遍扫描也得是 0**——模型会把问题拆成 `A|B|C` 做 Grep，只要有一个词库里真有（「南极科考队后勤预算」拆出**后勤**、「磷虾捕捞配额」拆出**配额**），那一步就**正确地**回到「核对了 1 份…」，`已确认库中没有相关记录` 就出不来。最终用**拆不开的专名**（霍格沃茨）。断言认 `data-verify` 而不是 `kind==='verify'`——扫到东西时 kind 会（正确地）变回 scan。
    产物时长两形态（52/52b）：走查是全新 userData，第一份文档天然没有历史 →「内容较多时需要几分钟」；跑完落下真实 `durationMs`，第二份就变成「通常约 X 秒」，且**断言 X 等于走查自己从 jsonl 算出来的中位数**（实测 63981ms → 64 秒），确保不是写死的。
    失败步骤（53）：让它打开一个不存在的文件，断言那一行标出「（这一步没成功）」。这条**抓不到只报警不判失败**（靠模型肯照做），但「阅读《文件名》」与「核对 N 份」两条参数层断言在整轮结束时**硬性要求至少各验到一次**。
    **截图可读性**：管理员区与用量页的类型表都在首屏之下，截图前必须 `scrollIntoViewIfNeeded()`，否则两张图长得一模一样、人工看截图等于白看；用量页截图前还要等前面几步的 toast 自己散掉（它们会糊在页头上）。
    **取消与 before-quit 两条必须在打包形态下跑**：`MCNAI_APP_BIN=release/mac-arm64/mcn-ai.app/Contents/MacOS/mcn-ai node e2e/walkthrough.mjs`（设计 §8 风险 1，dev 形态验过不算数）

---

## 3. 已知 bug 与未解决问题

### bug（按优先级）

1. **无离线降级（P0，2026-08-16 实测踩坑）**：云端（Supabase）连不上时，应用启动卡在登录/会话恢复，窗口不出现，体感"打不开"。正确行为：照常开窗 + 本地功能（知识库/投递箱）可用 + 顶部"云端离线"提示。auth 启动链路在 `desktop/src/main/auth/index.ts`
2. **Supabase 免费版 7 天闲置自动暂停**：暂停后项目域名直接 NXDOMAIN（连 DNS 都没了），叠加 bug#1 = 应用完全打不开。恢复：Dashboard → Restore project（域名先回、服务后起，全程约 5-15 分钟，中途 Cloudflare 521 属正常）。**防复发方案已议未做**：阿里云服务器加每日保活 cron（或升 Pro $25/月）——待用户拍板
3. ~~**make-ppt 偶发撞上 `maxTurns: 30`**~~ ✅ **2026-08-16 已修**：deepseek-v4-pro 很爱反复检索（同一个问题实测连调 4–5 次 `search_knowledge`），做 PPT 那条链路上偶尔把 30 轮预算耗光，SDK 直接返回 `Reached maximum number of turns (30)`、产物不生成（修前统计：DeepSeek 官方 2/2 轮全过，inferera 3/4 轮全过）。**两手一起改**：系统提示词加第 7 条「同一任务 search_knowledge 最多 3 次，素材够就立刻产出，轮次有上限」＋ `agent/index.ts` 的 `maxTurns` 30→40。**验证**：DeepSeek 线路连跑 3 轮，每轮 6/6 全过，make-ppt 分别 43s / 50s / 46s（修前失败那次是跑满 75s 才耗光轮次）
4. **supabase-js 的 Node 20 弃用警告**：启动时打 deprecation warning。根因是 Electron 30 内置 Node 20，而 Electron 版本被 XProtect 问题锁死（见 §4-2），升级链条：拿到开发者签名 → 升 Electron → 消除此警告。短期无害

5. **【2026-08-17 QA 回归批次】**：用 Maggie 源数据在隔离环境重跑并批跑问答，抓到的问题清单见
   `docs/QA-REPORT-diff.md` §9（A-1~A-8）与 `docs/QA-REPORT-qa.md` §4/§5（B 组）。抓取阶段**零产品代码改动**；
   修复分四批 + 一次补做完成，**逐条状态见 §0**（**高严重度已全部清零**；未修的只剩 A-3、A-5/A-6）。按严重度：

   | 编号 | 严重度 | 问题 | 位置 |
   |---|---|---|---|
   | B-1 | **高** | `search_knowledge` 对「整句话」查询必然返回空：bigram 分词 + `combineWith:'AND'`，跨词边界的二元组缺一个就整条归零。实测「公司年度目标」0 命中，「公司 年度目标」5 命中。标准档 10 轮里 7 轮因此答「库里没有」，而资料就在库里 | `src/main/vault/search-worker.ts` |
   | A-8 | **高** | `09_pii_guard` 只挡 LLM 打标、**不挡上云**：`cloudSync` 无敏感标记检查，登录后 37 篇 HR/财务 PII 照样进 Supabase | `src/main/inbox/orchestrator.ts:372` |
   | A-1 | **高** | ~~整包拖入递归 0 文件、静默返回 `n=0`~~ ✅ **2026-08-18 补做**：`enqueue` 改递归并**逐条保留相对子路径**（落位全靠它——pipeline 用 `rel.parts[0]/[1]` 推 `category/sub_category`，拍平就是全部「未分类」）；护栏 深度 10 / 单次 500 / 跳过隐藏与垃圾目录 / 不跟随符号链接；返回值从 `number` 改成结构化结果，两个拖入口都给明确提示。**验收**：`e2e/a1-enqueue.mjs`（Maggie 全量、零 LLM）——96/96 入箱、相对路径逐条相同、落位一致率 **100%**（92 命中 0 不一致） | `src/main/inbox/orchestrator.ts` |
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

10. ~~**【潜在风险 · 短时间连续 enqueue 会让同库上并发两个 pipeline（P2，2026-08-18，机制未查清）】**~~ ✅ **2026-09-02 已修（PLAN-v2 R2，见 §0-新d / §4-30）**：机制 = `stop()` 只关 watcher不杀 child、`run()` 尾段用 getter 读到换库后的新 taskId。原文保留作案卷：
   补做 A-1 时把验收断言内联在主走查里，那段连着做了 5 次 `enqueue`，结果同一个
   `/tmp/mcnai-e2e-vault` 上同时活着**两个 `mcn-ingest`**，退出应用时 `before-quit` 只杀得掉
   `this.child` 跟踪的那一个，另一个成了孤儿（2/2 复现）。
   - **归因做完了，机制没查清**：纯 HEAD ＋ 原样主走查绿、A-1 产品改动 ＋ 原样主走查也绿，
     只有叠上那段内联断言才复现 → **不是存量问题，也不是 A-1 产品改动引入**。
     断言挪进 `e2e/a1-enqueue.mjs` 之后不再复现
   - **但触发条件在产品里是够得着的**：用户连着拖几个文件夹就是同一个形状。
     `run()` 的串行守卫是同步的（`if (this.running) { rerun = true; return }`），
     理论上防得住两个并发，**我没找到它是怎么被绕过的**——所以这里只记事实，不写机制
   - 要查的话从两处入手：`settle` 只在 `close`/`error` 触发（进程还活着不该放掉 `running`），
     以及 `stop()`（换库时关 watcher 但**不杀在跑的 pipeline、也不重置 `running`**）

11. **【2026-08-18 真人探索测试三条，已修】**：用户自己点出来的，都是"不崩但别扭"那一类。

   | 现象 | 真因 | 修法 |
   |---|---|---|
   | 文件拖出窗口后分区投递覆盖层不消失 | `onDragLeave` 用 `currentTarget === target` 判定。覆盖层一出现指针就压在它的子元素上，拖出窗口时最后一次 `dragleave` 的 `target` 是子元素、不是容器，条件永不成立 | 抽出 `hooks/useDragOver.ts` 做**进出计数**（`dragenter` +1 / `dragleave` -1，归零才隐藏，下限钳 0），两个拖入口共用 |
   | 右下角出现「多次上云」 | **呈现问题，不是真重复**（证据见下） | 阶段日志渲染 `ev.message`（原来只画阶段名，把「20/61 篇」丢了），并把**连续同阶段折成一行**就地更新 |
   | 浮窗关掉后点 Dock 没反应 | Dock 只 `setPage('vault')`；人本来就在知识库页 = 什么都没发生。另外面板可见性是 `showInbox \|\| inboxRunning`，跑批期间点 ✕ 会被 `inboxRunning` 顶回来，"关闭"是摆设 | `lib/bus.ts` 加 `inboxPanel` 唤回通道（订阅 + pending 双路，覆盖"目标页已挂载/未挂载"）；可见性收敛到 `showInbox` 一个源 |

   **「多次上云」的证据**（96 个文件一次整包拖入，隔离实例实测）：**1 轮 pipeline、1 次 `cloudSync`、1 条 inbox 任务**。
   判据是 stages 数组被重置几次（`send('run-start')` 里会 `this.stages = []`），实测重置 0 次。
   而 `cloudSync` 每 20 篇发一条带 `20/61 篇` 的 `stage: cloud_sync` 事件（登录态那轮实测
   `20/61 → 40/61 → 60/61`，见 §0），面板却只画 `STAGE_ZH[stage]`＝「上云」两个字 ——
   于是屏幕上是四行一模一样的「上云」。**流量没有浪费，也没有重复写。**

   顺带加固：`dropPaths` 容忍 `dataTransfer` 为 null（合成事件会让它抛 TypeError 冒到 `window.onerror`）。

   **关于云端 embedding 成本：这一批不改变任何消耗，下次对账不要期待它下降。**
   本批只动了呈现，没动同步逻辑。同步机制本身是**增量 + 去重**的：
   - `cloudSync` 只扫 `mtimeMs > sinceMs - 60_000` 的 md，**只推本轮动过的文件**，
     不是每轮全量重推
   - `ingestNote` 有 `skipped` 回执，服务端按 `content_hash` / `file_path` 去重
     （migration 011），内容没变的笔记重复入库不产生新 embedding

   **⚠️ 表述更正（2026-08-18，A-3 之后）**：原文这里写的是「增量+去重，**没有可省的量**」，
   那句话现在会误导人。准确说法是——**增量与去重都成立，但"批量改写笔记"的操作会产生
   一次性同步波峰**，那是预期行为，不是泄漏、也不是同步坏了：
   - 实例：实体建卡首次铺开时，建卡器给上百篇笔记补写 `## 🔗 关联` 段 → 这些笔记
     `mtimeMs` 变化 → 被 `cloudSync` 正确地判为"本轮变更" → 一次推上百篇
     （走查实测 **`上云·20/125篇`**，一轮跑好几分钟）
   - **它是一次性的**：链接内容没变就不落盘（`entity-cards.ts` 的 `linkDocs` 里
     `if (next === text) continue`），下一轮触及的笔记数掉回个位数
   - 将来任何同类操作（批量重打标、批量补字段、概念层铺开）都会有同样的波峰，
     **对账时看到这种尖峰先确认是不是刚做过批量改写**，别当成同步逻辑坏了去查
   
   所以对账时**云端消耗与本批之前持平才是正常的**；真出现明显下降或上升，说明是别的原因，
   别记到这一批头上。

12. **【2026-08-18 会话恢复失败把上游报错抛给了用户，已修】**：用户在历史对话里发消息，界面上原样弹出
   `Error: Claude Code returned an error result: No conversation found with session ID: 0d4924db-…`。

   **成因链**（`agent/resume-recovery.ts` 头部有完整版）：SDK 的会话是落盘在 **CLI 那一侧**的
   （`~/.claude/projects/<cwd 转义>/<session-id>.jsonl`），我们把 `sdkSessionId` 存在对话里长期复用。
   那个文件一旦没了，这个对话**每一次**发消息都撞同一个错，而且用户自己解不开（界面上没有
   "忘掉旧上下文"这种按钮）。**注意进程重启本身不会丢**（文件在盘上）——真正够得着的是这三条：
   - **换库**：目录名由 `cwd` 决定，而 `cwd` 就是 vault root。换一次库，所有历史对话的 id 当场全部失效
   - **闲置过期**：CLI 有 transcript 保留期清理（`cleanupPeriodDays`，出厂 30 天）
   - **幽灵 id**（顺带查出的真 bug，本批一并修）：**失败的轮次也会把 `session_id` 写进对话**。
     首轮就失败时（403 余额、线路挂）那个 session 很可能压根没落过盘，于是这个对话此后必然每次都报错——
     一个失败的轮次把整个对话废掉了。现在只认 `!is_error && !api_error_status` 那一轮给出的 id

   **修法**：`agent/index.ts` 的 `send()` 拆成 `send`（建任务 + 拍历史快照）+ `runTurn`（跑一轮，可重入）。
   识别到会话恢复失败就**放弃旧 session、拿本地历史拼上下文开新会话重发**，用户无感、只落一条降级日志。
   历史在预算内整段带回（12000 字符 / 单条 2000 字符），超预算才截到最近若干条并弹提示条
   「已开始新的会话，较早的上下文可能不被记住」——短对话（绝大多数）能无损恢复，每次都弹等于制造噪音。
   只降级一次：重开那轮再失败就是别的毛病，再重开只是烧钱。

   **顺带修掉的**：错误型 result（`error_during_execution`）以前被当成正常回答画成「出错：error_during_execution」，
   于是一次恢复失败在界面上留下**两条**报错。现在错误型 result **先扣住不发**（它可能就是"会话已不存在"
   的讣告），真要展示时走 `kind:'error'`（过 `zhError` + 气泡里有「重试」），不再当成 AI 说的话。
   `zhError` 也补了这一类的中文映射（兜"连重开都没成"），文案里不出现 session ID。

   **踩坑记录**：① `smoke:provider` 的多轮 resume 用例会被这条兜底**悄悄架空**——拼回去的历史让它照样
   答得出那个数字，**resume 真坏了也测不出来**。所以事件里带了 `recovered` 标记，那一条用例先否掉降级
   再判内容；② 走查第一版断言假失败在"取最后一条 assistant 消息"上——伪造那条是绕过渲染层直接
   `chat.send` 的，不产生 user 气泡，取到的是**上一轮**那句「记住了」。必须以发之前的条数为基线等新消息。

   **验收**：`npm run smoke:resume`（纯逻辑，零 token：识别串逐条来自 `strings claude`，另有 6 条
   "不许误伤"的反例——403 余额 / 401 / 远程 teleport 的 `session not found on server` / 轮次耗尽等）；
   走查第 46 步（`E2E_CHAT=1`）真发一条带伪造 id 的消息，断言**不报错 + 上下文真接上了**
   （先让它记 4271 再问，答得出才算数）+ 短对话不弹提示 + 日志里有降级痕迹。

13. **【2026-08-18 T-02 收口：一次 AI 失败只出一条中文气泡，已修】**：
   上游 401/403/额度不足这类错误，SDK 发的是 **`subtype: 'success'` + `is_error: true`**，
   `result` 字段里装着英文原文（`Failed to authenticate. API Error: 401 …`）。旧代码把它当
   正常回答画进对话，紧接着 `for await` 又抛出、再落一条 ⚠️——同一次失败说两遍，第一条纯英文。
   现在与错误型 result 同等对待：扣住不发 → `kind:'error'` → 过 `zhError` 出中文，**原文只进日志**。
   - **判据上有一处刻意的不对称，别顺手"统一"**：显示只认 `is_error`，**不认** `api_error_status`。
     后者在记账那边是"存疑就别计费"（少记一条代价为零），搬到显示上却会把一条**真回答**
     判成错误、连正文一起丢掉——两边的容错方向相反
   - **§0 表里第 3 批那行原来写着「B-5+T-02 错误中文化」，那是记多了**：`20aef24` 只做了 B-5
     的中文映射，T-02 说的"两条气泡"一直还在（这次的 45d 截图就是现场证据）。已更正为 B-5
   - T-02 的另一半（`subtype !== 'success'`）在会话恢复那单 `8d23345` 就做掉了。
     `docs/UX-AUDIT.md` §六 T-02 已销账并注明**无余量**
   - **走查断言**：45c/41 那步——一次失败在对话里有且只有一条 assistant 消息、必须带 `error`
     标记、正文里不许出现连续 5 个以上英文字母（本地模式走预检 bail、E2E_CHAT 走 401 桩，同一条
     断言两种模式都跑）。另加**爆炸半径守卫**：成功那一轮必须有 `assistant` 事件、不许有 `error`
     事件、且真的调过工具（挂流式事件收集器数出来的）

14. **【2026-08-19 发布前自测：敏感文件上云（P0，已修）＋ 五条待裁决】**
   完整清单与证据在 `docs/RELEASE-CHECK.md`，这里只留索引：
   - **R-01 敏感判据被长 frontmatter 绕过（已修）**：只读前 800 字符 → A-3 之后
     `sensitive: true` 被顶出窗口 → 4 篇 PII/财务文件照常上云。判据抽到
     `src/main/lib/sensitive.ts`，`smoke:cards` 加 7 条断言。
     **改这块前先读那个文件的注释，别再把窗口截回去**
   - **R-02 云端已有存量（待裁决）**：测试账号 private 层实测检出达人信息表原始行（含身份证号）
   - **R-03 MOC 泄漏面（待裁决）**：`_主题索引`/`_MOC_*` 不带敏感标记却摘录了敏感文件的
     人名/职级/合同状态，正常上云。推荐改 pipeline `04_gen_moc`
   - **R-05 离线条不会自己下去**：`probeCloud()` 只在启动与登录后跑，无周期重探。
     实测网络恢复后等 90s 纹丝不动、重启才下去（`e2e/offline-recovery.mjs` 是它的凭证）
   - **R-09 产物轮的折叠摘要说「未找到相关资料」**：`step-stream.ts` 的 `summaryText` 只有两个分支，
     而产物步骤按设计不算"资料"——两条对的规则撞出一个自相矛盾的界面
   - **R-10 升级不把老用户挪回官方直连**：`tierMigrated=true` 正确地阻止二次迁移，
     所以 2.7 倍成本的线路原样保留，**给大头装新版时要手动改**

13. **【云端语义检索没有相关度闸门，把本地检索整个架空了（P0，2026-08-18 查实，未修，待拍板）】**：
   真人验收过程可见性时提的问题——步骤流显示「检索了资料库：灰太太（6 条）」，模型正文却说
   「三次检索均无结果」转去 Grep 全库。**两边都没说谎，是工具返回本身有问题。**

   **实测证据**（在 `search_knowledge` 里临时打点，跑一轮真实对话后取原文，用完已删）：

   ```
   query=灰太太 cloudLen=6 sims=[0.424,0.414,0.412,0.410,0.406,0.406]
   types=["my_script","my_script","my_script","my_script","my_script","my_script"]
   返回给模型的原文：
   1. [我的] (my_script, 相关度0.42)
      制此链接，打开Dou音搜索，直接观看视频！ | 224.0 | 5.0 | 是 | 311.23 | 0.71972496224657 | …
   ```

   三个问题，**根子在服务端 RPC 没有阈值**（`012_fix_ranking.sql` 只有 `order by … limit match_count`）：

   - **① 永远返回 6 条，与相关度无关**。相似度全是 0.41 上下（text-embedding-3-small 的噪声水平），
     对「灰太太」这种专名如果真命中该远高于此。于是 `search_knowledge` 里那句
     `if (cloud && cloud.length)` **恒真**——**登录态下本地检索这条分支永远走不到**，
     B-1 为本地检索做的那套分词/三道闸模糊回退等于白做
   - **② 返回的碎片没有出处**：云端分支只给 `[层] (source_type, 相关度X)` + 200 字内容，
     **没有笔记名/ file_path**。而系统提示词第 1 条要求每条结论标 `[[笔记名]]`、第 1b 条要求
     "只引用真正看过的文件"——模型拿到 6 段无法引用的碎片，理性反应就是当作不可用、
     转规则 4 的 Grep 兜底。**铁证**：步骤流里出现 `核对了 0 份含「my_script」的笔记`
     ——模型把 `source_type` 当成关键词去全库 Grep，它在替这些碎片找出处（两次走查都出现）
   - **③ 切片是表格拦腰截断**：xlsx 转出来的表被切成 200 字，没有表头也没有行边界，
     模型看不出这是谁的数据。而且**云端分支没有"相近结果"警示**——本地分支模糊回退时会明说
     「（精确检索无命中，以下是相近结果，可能与问题无关）」（B-1 特意加的），云端这条完全没有

   ---

   ### ✅ 已裁决（2026-08-19）：**第一版检索口径 = 本地，云端语义检索本版不启用**

   **做法**：`search_knowledge` 在登录态下也走**本地全文检索**那一支——因为它是唯一
   把 `(相对路径)` 交给模型的分支，拿到路径就能直接 Read。云端那一支**代码一行不删**，
   靠一个配置开关切换。

   | 项 | 内容 |
   |---|---|
   | **开关** | `store.ts` 的 `searchBackend: 'local' \| 'cloud'`，**出厂 `local`** |
   | **切回怎么做** | `~/Library/Application Support/mcn-ai-desktop/config.json` 里加 `"searchBackend": "cloud"`。**改完立刻生效，不用重启**（每次调用现读） |
   | **闸门在哪** | `agent/index.ts` 的 `store.get('searchBackend') === 'cloud' ? await searchCloud(q) : null` —— 一行，好查好改 |
   | **云同步没关** | **上云与 embedding 照常跑**，只是"查"暂时不走它。云端修好后切回来即刻有完整数据，**不用补录** |
   | **工具描述** | 已改成与实际一致的本地措辞（原文写着"返回最相关的笔记路径与片段"，那句只对本地分支成立） |
   | **引用校验** | 本地分支 `for (const h of hits) surfaced.add(noteKey(h.path))` 对全部命中登记，**本来就对**，本次只做确认 |

   **这一版顺手解掉的**：上面 ①②③ 三个问题在本地口径下都不存在——本地分支有分词与三道闸模糊回退（①）、
   给 `[[标题]] (路径)`（②）、模糊回退时明说「以下是相近结果」（③）。

   **云端修复单的工期依据（2026-08-19 只读查证，别再查一遍）**：

   | 查证项 | 结果 |
   |---|---|
   | `knowledge_chunks.file_path` 列 | ✅ **存在**（`011_desktop_sync.sql`，切片一直在写这个字段） |
   | `match_knowledge_chunks` RPC 的 `returns table` | ❌ **不含 file_path**（当前版 `012_fix_ranking.sql`：id / content / source_type / metadata / similarity / visibility） |
   | `webpage` 的 `KnowledgeMatch` 接口 | ❌ 跟着 RPC，也没有（`lib/knowledge/search.ts`） |
   | 桌面端 `CloudMatch` 接口 | ❌ 同上（`knowledge/client.ts`） |

   所以云端修复 = **一条新 migration（RPC 的 returns table 加 `file_path`，select 出来）
   + webpage 的 `KnowledgeMatch` + 桌面端 `CloudMatch` 与格式串**，顺带把相关度阈值/相近结果警示一起做掉。
   **数据不用补录**——列早就有。**排期：大头升级之后**。

   ---

   **原先的三选一（留档，说明为什么选了现在这条）**：
   - **主修「工具返回」（推荐，P0）**：服务端 search 把 `file_path` 一起 select 出来（migration 011
     已经有这个字段）→ 云端结果带笔记名可引用；加相关度阈值或对齐本地分支加「以下是相近结果」警示；
     切片带上笔记标题/表头。**这条要 webpage 侧一起改，跨仓库**
   - **次修「计数」（本单范围内可立刻做）**：在阈值落地前，步骤流的「（N 条）」是**误导性指标**——
     用户看到"检索到 6 份"、正文却说"没找到"。可改成对云端分支不报条数，或标成"相近结果 N 条"
   - **不建议改提示词**：模型的行为是**对的**——拿到无法引用的碎片就转兜底，正是规则 4 的设计意图。
     改提示词让它"相信"这些结果，只会把 B-6 那类张冠李戴的引用重新制造出来

### roadmap · 商业化备忘（2026-08-18 记）

- **步骤流与正文按时间交织展示（真人验收 2026-08-18 提出，本单不做）**：现在是「步骤一坨 + 正文一坨」
  上下分离，读起来矛盾感强（尤其是步骤说检索到了、正文说没找到的时候）。目标形态参照 Claude Desktop：
  过程与正文按发生时间穿插。**这会动到消息模型**——现在一轮只落一条 assistant 消息，
  交织需要把"文本段"和"步骤段"作为同级片段按序存下来，属于结构改动，单独立项

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
- **【已裁决 · 嵌图降采样：默认全降 + 豁免】（2026-08-18）**：长边 >1600px 或 >800KB 的嵌图
  压到长边 1600 / JPEG q85（带透明通道的只缩不换格式，否则 logo 会长出黑底；动图不动）。
  豁免名单**真相源是 `layout.json` 的「图片原图豁免」**（取值为相对路径前缀或 `.扩展名`），
  `--images-keep-full` 只作命令行覆盖；**管理员区的配置入口尚未接**（见下"仍缺"）。
  - 走这条路的依据（实测，非估算）：sha1 去重只省 14/215 张、`<20KB` 阈值全库只筛掉 1 张，
    **这两条杠杆都无效**，office 那批均 1.6MB/张全是高清照片，只有降采样有效
  - **全量实测**（Maggie 98 文件 / 558MB，2026-08-18）：**161 张 / 56.9MB，降采样前 145.3MB，省 61%**；
    整个转换阶段 29 秒。另有 39 张撞每篇 50 张上限未抽（集中在一份 89 图的课程 pptx）
  - **已知边界**：pptx 里作为**幻灯片背景填充**存在的图取不到（python-pptx 不把它当 shape 暴露）。
    全量召回 **161/171 = 94%**，缺口集中在单个文件（`星母计划【第一课】-谈大头.pptx` 差 10 张）。
    不为它加 XML 兜底——投入产出比不成立，记在这里备查
- **【A-3 + 图片大单 · 2026-08-18 收官（✅ 用户过目 PPT 后接受）】**
  代码与冻结产物都到位、核心交付真跑验过；**两项验收没做完**，接手前先看清这张表再决定信任到哪一层。

  **已做且已验**（提交：pkb-pipeline `edcb4c1`/`ee477bc`，mcn-ai `441e133`/`8413713`/`f1b7302`/`0eb0384`/`35b4099`）：
  - 实体层：`03_tag_llm` 三类实体并进现有那一次调用 + `is_contract` + checkpoint 改 `(path, rev)` 判重；
    `03b_tag_rules` 规则级实体（逐 Sheet 表头认达人 149 个 / 文件名认合作方）；
    TS 侧建卡器 `vault/entity-cards.ts`（归一 R1–R5、阈值 达人产品≥2 合作方≥1、敏感继承、
    自动区锚注释 + `auto_hash` 冲突保用户版、反向正文扫描、关联段整段重写、按稀缺度截断）；
    `07` 三个实体目录改读 `layout.json` 的 `entities` 段（`30_实体/`）；`INBOX_FLOW` 加「实体建卡」
  - 图片：`02_convert` 抽 docx/pptx 嵌图（**PDF 刻意不做**）+ 默认降采样 + `layout.json` 豁免名单；
    `mcnai-asset` 协议让库内嵌图在应用里真渲染；输入框附件直供（缩略图内存态、不落库）；
    `render_pptx` 原生 chart（柱/折/饼）与 image 版式、`render_docs` docx 插图；
    图片路径由渲染器解析（主进程注入库根），不让模型自己拼绝对路径
  - `cloudSync` 敏感判定**改读盘**（不改就是 A-8 回归，见 `docs/PLAN-entity-image.md` §0-3）
  - **Maggie 全量重跑（跑在冻结产物上，2026-08-18）**：双链 **旧库 352 / 修前 2 / 现在 400**；
    图谱 节点 289 / 边 1347（QA 那轮新版是 98/151）；卡 达人 184 / 产品 4 / 合作方 5（**含霞飞、向日花**）；
    两份年框各连 37 达人 + 1~2 产品 + 1~2 合作方（三类齐 = 合同枢纽成立）；frontmatter 齐全 92/92；
    嵌图 161 张 / 57.2MB；打标 55 次 **¥1.015**
  - 本地验收：`npm run smoke:cards`（34 条）、`node e2e/assets-render.mjs`（6 条）、
    `node e2e/attachments.mjs`（10 条）、`node e2e/a1-enqueue.mjs`（落位 100%、卡名零撞车）

  **冻结产物**：`desktop/resources/pipeline/mcn-ingest` = pkb-pipeline `ee477bc`，
  2026-08-18 15:42 冻结，sha256 前缀 `c123c6f68dccbb03`。spec 清单逐项核对过
  （`cli.py` 里 `load_module` 的 8 个脚本全在 `datas`；`xlsxwriter` 进 `hiddenimports`——
  `pptx/chart/data.py` 在模块级 import 它，缺了**只有打包形态才炸**，已用 `find_spec` 反证）。
  该目录按设计 gitignore（96MB），规矩是「冻结发布 = 同步提交源码」。

  **make-ppt 真跑 ✅（2026-08-18，用户人工过目通过）**：一次成功、95.5 秒、¥0.36。
  产物 `90_产物/2026-08-18_灰太太月度复盘/灰太太月度复盘.pptx`（243,690 字节），
  用 python-pptx 逐页反读校验——不是"文件生成了"就算数：
  - 第 3 页是**原生 `COLUMN_CLUSTERED` 图表对象**（可点开改数据），类目 1–6 月，
    系列「GMV（元）」= 2466.6 / 4576.1 / 4018.5 / 8747.5 / 4002.9 / 5443.9，数字取自库内真实表格
  - 第 4 页是**用户附件图**（11.73×4.16in，原宽高比未被压扁）
  - 第 5 页是**库内笔记的嵌图**（7.76×4.50in，从星母计划课件抽出来那张）
  → 证明 `xlsxwriter` 那条依赖在**冻结产物**里真的生效了。复现脚本 `e2e/make-ppt.mjs`
  （手动跑，约 ¥0.4/次，不进常规走查）

  **⚠️ 收官时仍未跑完的两项（用户判决"接受，后续按 bug 追改"，但接手要知情）**：
  - **E2E_CHAT 全量走查没有跑到终点**。最后一轮（补完四处断言修正后）通过了
    登录/投递箱/步骤流/验证性扫描/产物时长/失败步骤等全部前段断言，**红在末尾
    「取消断言」的前置等待**：`waitInboxIdle` 上限 5 分钟不够（原因见下条一次性同步波峰），
    已把上限提到 10 分钟，**但没有再花预算重跑验证**。截图基线因此**停在 `f1b7302` 那一轮**，
    没跑完的几轮刷出来的图**刻意没有提交**（半截基线不该钉进历史）
  - **Q4 / Q7 复跑从没跑过**：**"实体卡对检索的贡献"目前没有任何数据**。
    将来跑出来也要标注「待真实使用积累后复评」——单次问答不足以证明检索改善

  **一次性同步波峰（预期行为，不是 bug）**：建卡器首次铺开会给上百篇笔记补 `## 🔗 关联` 段，
  mtime 随之变化 → `cloudSync` 正确地判为本轮变更 → 一次推上百篇（实测 `上云·20/125篇`）。
  详见 §3-11 的表述更正。

  预算：本单实花约 **¥10–12**（原报 ¥8 + 用户追加 ¥4）。超支主因是 E2E_CHAT 走查连红七轮，
  其中**只有一轮红在产品 bug**（`call_0` 泄漏），其余是断言假红与我引入的两处
  （写死 `6/6`、旧 checkpoint 每轮触发重打标）。教训：**改了 `INBOX_FLOW` 阶段数、
  改了 checkpoint 判据这类"横跨产品与走查"的东西，先把走查里对应的假设找一遍再跑**，
  一轮走查 ≈¥1.8，靠跑来发现假设过期太贵
- **【roadmap · PDF 抽图】**：本单**刻意不做**。实测三份宣传册 PDF 吐 1018 张 / 131.8MB
  （42 页 337 张、26 页 410 张、31 页 271 张 —— 每页约 10 张是版面渲染碎片，不是内容图），
  抽出来的东西对"笔记里看得见原图"这个目标基本无用。要做的话正确形态是**按页渲染**而不是逐图抽取
- **【roadmap · 从对话回溯附件】**：本单只做"图随消息走 + make-ppt 可用"（A+B'），
  附件缩略图是 dataURL 内存态、不落库（与步骤流同原则）。"翻历史对话把当时的附件再拿出来"
  需要附件进消息模型并落盘，属结构改动，单独立项

### 已知未验项（2026-08-17 档位单收尾时明确留下的）

> **2026-08-17 真实调用验收结果**（最小集，共 4 次单轮请求，成本 ≈ ¥14）：
> - 标准档 `SMOKE_ONLY=deepseek SMOKE_CASES=single` → 1/1 通过，`result.modelUsage` = `deepseek-v4-flash / deepseek-v4-pro`（主模型 pro 在里面，轻量子任务真的走了 flash），`degraded=false`
> - 增强档 `SMOKE_ONLY=aihubmix SMOKE_CASES=single,abort,tools` → 3/3 通过，三轮的 `modelUsage` 全部**只有 `claude-opus-5`**（= aihubmix 真路由，没有静默换模型），abort 停在第 3 个 delta，`search_knowledge` 真调到
> - 用量 jsonl 三条记录字段齐全，`usage-report.mjs` 对账：增强 2 次 ¥13.98 / 标准 1 次 ¥0.06 —— **两档的钱差在真实数据上就是这个量级**，用量页的对比区要的就是让人看见这个
>
> 仍未验的：

- **make-ppt 在 `claude-opus-5`（增强档）上的表现未验**：本单只对新增线路做了最小真实调用集（单轮 / abort / 工具调用），make-ppt 那条链路的 skills 层零改动，没有为它跑真实产出。风险点是 §3 bug#3 的老毛病（爱反复检索 → 撞 `maxTurns`）在换模型后行为不同——opus 检索次数通常更少，理论上更安全，但没有实测数据。**要验的话**：`SMOKE_ONLY=aihubmix SMOKE_CASES=ppt npm run smoke:provider`，一次调用的量级
- **增强档的轻量模型串暂时也是 `claude-opus-5`**：aihubmix 上只有它做过真路由验证。等验过一个便宜模型名（如 haiku 系）之后，在管理员区把增强档的「轻量模型」换掉即可省一大笔——这是个明确的待办省钱开关，不是设计终点
- ~~**服务端 `client-config` 还没有下发 `aihubmixApiKey`**~~ ✅ **2026-09-03 按契约 v2 下发**：`tiers.enhanced.apiKey`（第一版回落 `CLIENT_RELAY_API_KEY`），回落设计整条作废，见 §0-新f

---

## 4. 重要技术决策及原因

1. **Electron 而非 Tauri**：Claude Agent SDK 是 Node 库，Electron 主进程可直跑，Tauri 需要额外进程桥接。Agent SDK 打包冒烟是 M0 第一天做的（风险前置）
2. ~~**Electron 锁 30.5.1**~~ → **2026-08-19 已解锁到 43.4.1**。
   原决策：macOS XProtect 会误杀 Electron 31+ 的应用（客户机实测），降到 30 规避，
   **根治路径 = 买开发者签名做公证**，在那之前不升级。那条路已经走完（见 `docs/RELEASE.md` 发版手册），
   所以锁一并解掉。连带好处：内置 Node 20 → **24.18.1**，bug#3 那条 supabase-js 的弃用警告随之消失。

   **跨 13 个大版本抓到两条真回归，都修在产品层，改这一层前必读**：

   ① **`before-quit` 必须显式关 chokidar watcher，否则进程退不掉。**
   打开过知识库的实例（vault / 投递箱 / 产物三个 watcher）调 `app.quit()` 会挂住，进程一直活着。
   Electron 30 上不关也能退。二分证据：不开库秒退（157ms）／开一个空库必挂（10s 超时进程仍活）；
   与 `window-all-closed` **无关**——最小 Electron 应用复刻同样的 macOS「关窗不退出」行为照样秒退。
   表现是走查在第 3 个实例处永久卡死，**没有任何报错**，只是不动了。

   ② **`vault/searcher.ts` 的索引就绪闸门：开库瞬间的查询不许回 0 条。**
   `open()` 的顺序是**先置 root → await 扫全库 → 最后才 rebuild 索引**，中间那段
   「库已打开、索引还空着」的窗口里查询会被 worker 拿空索引秒回 0，界面照三态画成
   「没找到「X」」——**产品在说谎**，正踩在 §2-19 规则 10b 那条规矩上。
   **这不是 Electron 的 bug，是它把一个一直都在的窗口撑开了**：30 上扫得快、走查从没撞上，
   43 上每轮必现（前 1~2 条查询归零，且失败条数不稳定——这个"总是最前面几条"的形状
   正是判定它是时序而非引擎故障的依据）。修法是 `search()` 等 `rebuild()` 投出去
   （worker 消息保序），`close()` 里 `reset()` 就绪位防换库串味，`vaultManager.search()`
   加空库短路。走查里有**索引就绪哨兵**（B-1 最前面、不等任何东西地搜一次）守住。

   顺带把 `playwright-core` 升到 1.62.1（**不是它的锅**——1.61.1 与 1.62.1 表现一致，
   排查过程里试过，既然装了就留着）。
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
23. **会话级档位：语义写死、映射留运维口（2026-08-17）**。用户看到的只有「标准（推荐）／增强」两档与"能力/消耗"的差别，**界面上不出现供应商名与模型名**——老板要判断的是"这次值不值得多花钱"，不是"这条线后面挂的是谁"。出厂映射：标准=DeepSeek 官方 `deepseek-v4-pro/flash`，增强=~~aihubmix~~ **中转站 `api.inferera.com`** `claude-opus-5`（**2026-09-03 起地址不再写在客户端，全部由 client-config 契约 v2 下发**，见 §0-新f）。映射（base URL / 主模型串 / 轻量模型串 / 各线路 key）全部下沉到设置页的隐藏管理员区，定位是**运维应急**（换模型串、临时切线路），覆盖优先于下发。
    - **档位是会话级的**：存在 conversation 对象上随对话落盘，新会话一律回到标准档。做成全局设置的话，"上次开了增强"会一直粘着，是最容易把钱烧掉又没人察觉的形态。
    - **增强档的轻量串也钉死 `claude-opus-5`**：aihubmix 上只有它做过真路由验证（响应 model 字段原样返回）。写一个没验过的便宜模型名进去，赌输的形态恰好是"静默降级"，正是这层要防的东西。真要省，管理员区把轻量串换成验过的名字即可（**这是一个明确的省钱开关，验过就该拧**）。
    - **老用户迁移**（`ai/tiers.ts` 的 `migrateTiers`，只跑一次）：机器上配过库或落过任意一把 key = 老用户 → 把升级前生效的那条线路（`describeProvider()`）原样搬成标准档映射，升级不改变现有行为；全新安装才走出厂映射。另有 `ensureStandardUsable()`：标准档一把 key 都没有而中转站那把还在时，自动把标准档指向中转站并**打一条 warn**（不是静默兜底）——覆盖"服务端只下发了 relayApiKey"的新装机。
    - **`resolveTierForRequest` 只在无窗口时才吃 `ANTHROPIC_AUTH_TOKEN`**（走查现场抓到的坑）：开发机上常年挂着自己的 key，有窗口时也吃的话，"这一档没配密钥"那条预检分支在走查里永远触发不到——实测增强档明明没 key，请求还是真的发了出去。无头冒烟（smoke-chat/smoke-agent）没有窗口，照旧从 env 取。
24. **线路健康检查：只探增强档、缓存 5 分钟、`max_tokens:1`（2026-08-17）**。标准档是兜底线路，探它没有意义——它挂了也没有"另一档"可退，只会在每次开应用时多一次请求。增强档不可用时选择器里**直接置灰**，而不是让人选了之后在发送时才撞一鼻子灰。探测用一次 `max_tokens:1` 的 messages 请求而不是 ping 根路径：key 过期这种最常见的失效形态，只 ping 地址压根测不出来。会话进行中失败仍走原有错误重试路径，气泡里额外给一颗「切换到标准模式重试」——只给「重试」的话，用户会在同一条挂掉的线路上反复撞。
25. **用量记录：写入侧不挑字段，归一化全放汇总侧（2026-08-17）**。三条线的 usage 口径都不一样（snake_case vs camelCase、有没有 cache_* 分项、有没有 modelUsage），在写入侧归一化等于把"当时以为对的口径"腌进历史数据，以后想换算法只能重跑。所以 jsonl 里存的是原样的完整 usage 对象，缺则 null；`summarize()` 与 `scripts/usage-report.mjs` 各自归一（两边同一套正则，改一处要改两处）。另外两条：**只记跑成功的那一轮**（失败轮 token 基本是 0，记进去会让「本月对话 N 次」把故障也算成用量）；**写失败静默降级**（记账挡不住主流程）。pipeline 的智能打标拿不到 token，就只记次数（`calls:1`，页面显示「—」）。
26. ~~**增强档的 key：独立槽位优先，空则回落到中转站那把（2026-08-17，返工方案①）**~~ **2026-09-03 整条作废（§0-新f）**：回落被 Jerry 机器证明是坏形态（key 是中转站的、地址却钉在代码里的老域名），现在每档只认自己那把 key、线路由服务端按档下发，"未配独立密钥"明示「增强线路未配置，请联系管理员」。下面保留作历史记录。依据是当天查实的两件事：**`api.inferera.com` 是 aihubmix 的备用域名**、**`CLIENT_RELAY_API_KEY` 与网页版的 `AIHUBMIX_API_KEY` 是同一把**（哈希一致）。也就是说**任何登录过的机器硬盘上早就躺着一把能开 `claude-opus-5` 的 key**，再下发第二把纯属多余，还多一处要维护的密钥——所以 webpage 侧那条"加 `aihubmixApiKey` 下发"的改动直接取消了。
    - 实现在 `ai/tiers.ts` 的 `FALLBACK_KEY_FIELD`：增强档 → `encryptedApiKey`。`describeTier` 里 **`keyField` 始终是这一档自己的槽位**（管理员区那颗「保存」写的是它），回落只影响 `hasKey` 与 `resolveTierForRequest` 读哪一把——否则给增强档填 key 会把中转站那把覆盖掉
    - **回落打日志，不做静默兜底**：`「增强」未配独立密钥，回落到共享密钥 encryptedApiKey（https://aihubmix.com）`，一个进程只打一次（它挂在发消息与线路探测两条高频路径上）。"钱从哪把 key 上扣的"必须查得到
    - 管理员区那一档标「复用中转站密钥」，与「key 已配置 / 未配置 key」并列成三态
    - **将来换限额子 key 零改动**：在管理员区给增强档填一把，`usingSharedKey` 自动变 false，回落不再发生
    - **踩坑（增强档 key 回落）**：走查里验这条时第一版挂住了——我用 `evaluate` **直接调 IPC** 写 key，却去等界面那颗保存按钮才会弹的 toast，180 秒白等。直接调 IPC 的路径上没有 toast，要断言就轮询 `ai.tiers()`（明文立刻进内存缓存，`hasKey` 马上翻真）

27. **更名只改"看得见的"，`productName`/包名留给苹果签名那一单（2026-08-18 拍板）**。
    界面上的旧名全部换成 **SamePage**（侧栏标题、登录页、窗口标题、macOS 菜单的"关于/退出"、
    界面异常弹框、诊断报告标题与文件名、建库向导写进 vault 的欢迎笔记、系统提示词里 AI 的自称），
    但 **`productName` / dmg 名 / npm 包名 / bundleId / userData 目录名一律不动**。
    - ~~**原因**：改 `productName` 会让 macOS 把它当成**另一个应用** —— `app.getPath('userData')` 跟着变
      （`~/Library/Application Support/mcn-ai-desktop` → 新目录），落在里面的加密 session 与 key 全部读不到，
      **所有已装机器强制重新登录**；ad-hoc 签名下 Keychain 条目也认不回来。~~
    - **⚠️ 上面这条原因在 2026-08-19 被实测推翻了（结论仍然"当时别改"，但理由是错的）**：
      打包形态实测 `app.getName()` = **`mcn-ai-desktop`**，取的是 **`package.json` 的 `name`**——
      因为打进 asar 的那份 `package.json` **根本没有 `productName` 字段**（`productName` 只写在
      `electron-builder.yml` 里，它决定的是 `CFBundleName` / .app 包名 / dmg 名）。
      与磁盘对得上：userData 目录是 `mcn-ai-desktop`、Keychain 条目是 `mcn-ai-desktop Safe Storage`。
      **所以只改 `electron-builder.yml` 的 `productName` 不会换 userData、不会换 Keychain、
      老用户不会被强制重登**；真正会把人踢去重登的是改 `package.json` 的 `name`
      或给它加 `productName`——**那两件事不要做**。
      探针：`e2e/probe-name.mjs`；完整实测表见 `docs/RELEASE-CHECK.md` §2.3。
    - ~~**⚠️ 2026-08-19 复议结论：`productName` 仍然不改**~~ —— **同日晚再次推翻，已改成 SamePage**。
      当时不改的理由是"收益太小、不值得在第一个正式签名版上引入变量"；用户复议后判定
      **名字不一致是客户直接看得见的东西，值得现在收掉**。
      `electron-builder.yml` 的 `productName: SamePage` 已落地，改名后复验：
      `CFBundleName`/可执行文件 = `SamePage`，而 `app.getName()` 仍是 `mcn-ai-desktop`
      → **userData 与 Keychain 服务名一个字没变**（`e2e/probe-name.mjs` 打包形态实测），
      `upgrade-path.mjs` 拿真实 userData 副本让 `SamePage.app` 接管，七件事全绿、
      **会话真解了密、不要求重新登录**。
    - **🔴 改名带来的唯一实操代价：覆盖安装不成立。**
      旧版是 `mcn-ai.app`、新版是 `SamePage.app`，**两个不同的文件**——拖进「应用程序」
      不会覆盖，会变成两个都在，客户很可能点到旧的那个（还是 A-8 修复前的版本，
      敏感文件照样上云）。装机必须**手动把旧的 `mcn-ai.app` 拖进废纸篓**。
      **删 app 不动数据**：userData 在 `~/Library/Application Support/mcn-ai-desktop/`，
      与 app 文件是两回事，**那个目录千万别删**。步骤写在 `docs/RELEASE.md` §2。
    - **红线不变**：`package.json` 的 `name` 一个字不能改、也不能给它加 `productName` 字段——
      那两件事才会换 userData 目录，等于把所有已装机器的配置、会话、密钥全甩掉。
    - **触发条件（到点一起做，不要单独做）**：**买到 Apple Developer ID、做签名与公证的那一单**。
      那次本来就会换签名主体、用户本来就要经历一次重登与"应用是新的"提示，两个代价合并成一次。
      届时一并改：`productName`、`build.appId`、dmg 名，并**在发版说明里写明"需要重新登录一次"**。
    - **同一天改了两次名**（mcn-ai → 拉齐 → SamePage）。之所以只花了几分钟：界面名从一开始
      就没有和 `productName`/包名/userData 目录绑在一起，改的全是字符串与一处字体栈。
      **这条边界本身比名字值钱**——下次再改名同理。走查的旧名扫描现在同时守 `mcn-ai` 与「拉齐」。
    - 顺带一条边界：**钉钉群消息里的旧名不在本次范围内**（那是发到客户群的外发文案，不是界面），
      要改得先确认。日志前缀与 `MCNAI_*` 环境变量属内部标识，同样不动。

28. **embedding 模型锁定 `text-embedding-3-small` / 1536 维（2026-09-02 记档，PLAN-v2 R21）**。
    决策本身是 M4 时定的（§4-11：成本敏感），这里补记**为什么现在不换、换要付什么**：
    维度写死在迁移 `010`（pgvector 列 1536）与 `012`、`webpage/lib/knowledge/embeddings.ts`；
    换模型 = 改列维度 + **全量重灌所有 owner 的切片**（团队版数据量放大后成本指数级，审计 a11）。
    所以：**团队版上线前不换**；真要换的触发条件只有两个——检索质量在真实问答里被证明不够
    （先修 §3-13 `file_path` 缺失那条再下结论，别把 RPC 缺列误判成模型不行），或 OpenAI 下线该模型。
    换的时候按「新列并行写 → 后台重灌 → 切读 → 删旧列」四步，不做原地改维。

29. **agent 一轮墙钟超时：软提醒 80% → 硬中断 100%，先落盘再发事件（2026-09-02，PLAN-v2 R3）**。
    此前只有 `maxTurns:40` 和扫描闸门，模型卡在上游慢响应/重试退避时一轮可以无限期转下去。
    上限出厂 15 分钟（`store.agentTimeoutMin`，管理员区可改，0 = 关）；判据是纯函数
    `agent/timeout.ts` 的 `judgeTimeout`（`smoke:guards` 零花费验），走查用 `MCNAI_E2E_AGENT_TIMEOUT=<ms>` 造超时。
    **中断顺序不能反**：先把已流出的半截正文落成带「（已超时中断）」的 assistant 消息 → 再 abort →
    最后发 `kind:'error'`；反过来渲染层收到 done 就清屏，半截正文就没了（同 H-09 的教训）。
    超时是 **failed 不是 canceled**（用户没动手，是系统替他停的，要红出来）。

30. **换库 / 退出时在跑的 pipeline 必须跟着停（2026-09-02，PLAN-v2 R2，销掉 §3 bug#10）**。
    `stop('switch')` 现在会 kill 进程组并等它退（≤4s）再重置 `running`；`run()` 开头快照
    `{root, taskId, gen}`，尾段（建卡/上云/记账/run-end）全部用快照——此前 run-end 走的是
    getter，换库后会打到**新库**的任务上，这正是 bug#10「两个 mcn-ingest / before-quit 只杀一个」的机制。
    换库成功时向导 toast「已停止上一库的入库（已完成的部分已保留）」，任务 `canceled:'switch'`。
    `before-quit` 同时 `agentManager.abortAll()`，SDK 子进程不再随退出成孤儿。

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
├ worker/      视频线 worker（未开工）
└ docs/        见下表
```

### docs/ 索引（2026-09-02 补，PLAN-v2 R20）

| 文档 | 内容 | 状态 |
|---|---|---|
| `HANDOFF.md` | 本文：项目全貌 / bug / 决策，接手必读 | 持续更新 |
| `RELEASE.md` · `RELEASE-CHECK.md` | 发版手册（签名/公证/OSS 更新源）· 发版前全面自测报告 | 现行 |
| `DESIGN-task-state.md` · `DESIGN-color-semantics.md` | 全局任务状态层设计 · 颜色语义规则 | 现行 |
| `UX-AUDIT.md` · `QA-REPORT-qa.md` | 2026-08 UX 审计（H/M/L 编号的来源）· QA 修复大单报告（含计价三方对账） | 已消化 |
| `PRODUCT-AUDIT.md` | 2026-09-02 产品审计三卷（架构债 a/b/c/d、静默清单 Q1–Q15、UI 附录 B） | 事实底座 |
| `REFERENCE-codex.md` · `REFERENCE-products.md` | Codex CLI 源码参照 · Claude Desktop / WorkBuddy 对照与「明确不做」清单 | 参照 |
| `DESIGN-scale.md` | 设计刻度表（间距 8 点栅格 7 档 / 行高 / 阴影 / 字重）；token 已定义，存量替换在批 4 | 草案→token 已落 |
| `PLAN-v2.md` | 补课方案 v2，批 0–7；**已批准，批 0+1 于 2026-09-02 执行** | 现行 |
| `architecture.md` | webpage 侧早期架构 | 早期 |

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

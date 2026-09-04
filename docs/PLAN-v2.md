# SamePage 补课方案 v2（PLAN-v2）

> 2026-09-02 ｜ 状态：**已批准。批 0 + 批 1 已执行（2026-09-02，见 HANDOFF §0-新d）；批 2 + 批 3 已执行（2026-09-03/04，见 HANDOFF §0-新g），随 0.1.3 发；批 5 整批完成（2026-09-04，见 HANDOFF §0-新h，未发版）。下一步：批 4 刻度表，之后批 6/7**
> 输入：`PRODUCT-AUDIT.md`（阶段一）→ v1；`REFERENCE-codex.md` / `REFERENCE-products.md` / `DESIGN-scale.md`（阶段二）→ 反向修订 → v2。
> 排序原则（任务书原话）：架构债里「挡团队版/模板系统路的」最先；功能卷按价值高 × 成本小；UI 卷刻度表第一批（地基），其余在模板系统形态定型后。
> 档位记法：**A** = 成本小/中 × 感知或演进价值高（先做）；**B** = 成本中 × 价值中，或成本大 × 价值高（排期做）；**C** = 价值低或团队版才有意义（挂账）。

---

## 第一部分 · v1（据阶段一）

### 架构卷

| # | 项 | 来源 | 成本 | 价值 | 档 |
|---|---|---|---|---|---|
| R1 | 对话 system prompt 读 `persona`，去 MCN 写死 | 审计 a1 | 小 | 模板系统挡路 | **A** |
| R2 | `stop()`/换库时杀在跑 pipeline + 重置 running；`run()` 尾段快照 vaultRoot/taskId；before-quit abort agent 子进程 | b1/b3/Q3/Q4 | 中 | 孤儿进程、烧额度 | **A** |
| R3 | agent 一轮墙钟超时（AbortController 定时器） | b2 | 小 | 长任务失控 | **A** |
| R4 | pipeline stderr 尾 2KB 进任务 error | b4/Q1 | 小 | 可诊断性 | **A** |
| R5 | pipeline key 改走 env 不走 argv | b5 | 小 | 泄漏面 | **A** |
| R6 | `90_产物` 走 layout.json（agent + write-guard） | a2 | 小 | 模板系统挡路 | **A** |
| R7 | supportedExt 收成一份真相（TS 两处合一 + py 侧由 TS 生成或契约测试扩到扩展名） | a3 | 小 | 扩展阻力 | **A** |
| R8 | 打标 token 回传：`03_tag_llm` emit 聚合 usage → orchestrator 落账 | d / bug#8 | 中（两仓） | 账本 98.7% 缺口；服务端记账前置 | **A** |
| R9 | agent result 处理（降级检测/T-02/记账门/引用校验）抽纯函数 + 桩测试 | d | 中 | 可测性最大盲区 | **A** |
| R10 | 本地→云端删除/改名协议 + 一次性对账脚本 | c1 | 大 | 团队版挡路 | **B**（团队版前置） |
| R11 | vault 索引主键从 path 换稳定 doc id（frontmatter `id` 或 hash） | c4 / 团队版 1 | 大 | 团队版挡路 | **B**（团队版前置，越晚越贵） |
| R12 | taxonomy 兜底基线改中性（MCN 降为可选 preset） | a6 | 中 | 模板系统 | **B** |
| R13 | 实体种类从写死改为 taxonomy 声明（kind 表驱动建卡/图谱/frontmatter） | a8 | 大 | 模板系统挡路 | **B**（模板系统形态定型后） |
| R14 | `tasks/types.ts` ↔ `api.d.ts` 单一真相（从主进程类型导出） | e5 | 小 | 扩展阻力 | **B** |
| R15 | `ipc.ts` 里的 openVault 编排下沉到 vault/orchestration 层；「当前库路径」三处真相收一 | 越界表 | 中 | 可维护性 | **B** |
| R16 | search-worker 崩溃重建；vault 失联检测（watcher error / root unlinkDir → Condition） | Q5/Q6 | 中 | 静默失效 | **B** |
| R17 | 网关：key 不落客户端 | 团队版 7 | 大 | 团队版前置 | **B**（HANDOFF 已定方向，单独立项） |
| R18 | knowledge 主键加 org 维度、桌面端写 org visibility | a12 / 团队版 4 | 中 | 团队版 | **C**（团队版） |
| R19 | taxonomy 双镜像收一（TS 生成 py 常量或 JSON schema 共享） | a7 | 中 | 移动端/服务端 | **C** |
| R20 | 更新链路：分渠道 + 私有 bucket；文档漂移修正（`updater.ts:23` 占位判据、HANDOFF §0 #7） | b9/a14 | 小（文档）/ 中（渠道） | 运维 | 文档 **A**，渠道 **C** |
| R21 | embedding 模型锁定决策记档 | a11 | 小 | 避免日后重灌 | **B** |

### 功能卷

| # | 项 | 来源 | 成本 | 价值 | 档 |
|---|---|---|---|---|---|
| F1 | React ErrorBoundary + 错误页（重载 / 导出诊断） | 卷二 1 | 小 | 白屏 | **A** |
| F2 | 草稿输入框按会话持久（localStorage `draft.<convId>`） | 卷二 2 | 小 | 每日高频 | **A** |
| F3 | 入库上云失败：真建笔记重试队列或改文案 + 下轮覆盖 | Q2 | 中 | 数据缺 + 说谎 | **A** |
| F4 | 静默消灭批：Q7 摘要第三分支、Q8 引用存疑角标、Q9 更新错误态、Q11 离线重探、Q13 诊断导出 try/catch、Q14 settings 保存反馈、Q15 档位实际生效角标 | 静默清单 | 小×7 | 透明度 | **A** |
| F5 | 对话重命名 / 置顶 / 侧栏搜索 | 卷二 5 | 小～中 | 高频 | **A** |
| F6 | 失败件应用内批量重试（读 `.failed/` 清单 → 重新 enqueue）+ 失败清单常驻入口 | 卷二 6 | 中 | 批量导入尾场景 | **A** |
| F7 | 分流规则删除确认 + 撤销；敏感档升「上云」二次确认；昵称/服务器地址保存反馈 | 卷二 7/8 | 小 | 不可逆误操作 | **A** |
| F8 | 快捷键：Cmd+K 搜索/命令面板、Cmd+F、Cmd+,、Esc、Cmd+W、上下键选会话、邮箱框回车 | 卷二 10 | 中 | 对标用户天天撞 | **A** |
| F9 | 用户消息复制 / 编辑重发 / 重新生成 / 代码块复制 | 参照 1.1 | 小 | 高频 | **A** |
| F10 | 系统通知：入库完成 / 产物完成 / 需要确认 + Dock 角标 + 关窗不退 | 参照 1.7 | 小 | 长任务 | **A** |
| F11 | Q10 连续失败件移 `.failed`（防重跑循环） | 静默清单 | 中 | 烧额度 | **B** |
| F12 | 步骤流与正文按时间交织（消息模型改为片段序列） | roadmap / 参照 | 中～大 | 矛盾感最强处 | **B** |
| F13 | 产物面板去 30 条截断 + 打开目录 + 预览可收起 | 卷二 | 小 | 中 | **B** |
| F14 | 文件树多选 + 批量删除/入库；拖拽移动 | 卷二 | 中 | 中 | **B** |
| F15 | 反向链接面板 / 标签浏览 | 对标清单 P1 | 小～中 | 中 | **B** |
| F16 | 大库：文件树虚拟化；图谱节点上限 + 空闲暂停重绘 | 卷二 9 | 中 | 563 节点已疼 | **B** |
| F17 | 用量页月份切换；单轮耗时角标 | 卷二 | 小 | 中 | **B** |
| F18 | LLM key 手填入口；钉钉设置面板（或删默认开的通知） | 卷二 | 小 | 中 | **B** |
| F19 | 库级自定义指令 UI（persona 已有格式） | 参照 1.4 | 小 | 中 | **B** |
| F20 | 定时入库 / 定时产物（Automation 最小形态） | 参照 1.10 | 中 | 高 | **B** |
| F21 | agent draft 周期落盘（崩溃保半截） | b10 | 小 | 低中 | **C** |
| F22 | 对话导出 / 归档 | 卷二 | 小 | 低 | **C** |
| F23 | OCR | roadmap | 大 | 高 | **B**（单独立项） |
| F24 | 「本会话允许写入」一档 | 参照 1.3 | 小 | 中 | **B** |
| F25 | 窗口尺寸记忆 / 缩放 / 深色模式 | 参照 1.6 | 小 / 小 / 中 | 中 | 前两项 **A**，深色 **B**（刻度表后） |

### UI 卷

| # | 项 | 来源 | 成本 | 价值 | 档 |
|---|---|---|---|---|---|
| U1 | 刻度表落地：spacing 整体覆盖 + `--space-*`、`--leading-snug`、`--shadow-modal`、字重语义映射、隐式 150ms 归属；560 处 spacing 类脚本化替换；走查加 spacing 白名单断言 | DESIGN-scale | 中 | 地基 | **A**（第一批） |
| U0 | 先重跑走查核实两条疑似基线过期项（成功 toast 底色、版本号并存，附录 B #2/#3）；仍在则修 | 卷三 3.1 | 小 | 高 | **A**（与批 0 同做） |
| U2 | 附录 B 视觉类：「重试」橙实心/橙描边二选一、答案警告条竖条与链接改金琥珀（#10）、toast 落点避让与下拉翻转（#14）、图谱标签边缘淡出（#15） | 卷三 | 小～中 | 中 | **B**（模板系统形态定型后） |
| U3 | 文案层（附录 B 缺陷最多的一类，11 条）：frontmatter 键名中文映射（#1）、「库」统一称呼（#4）、路径不泄漏（#5）、投递箱阶段名用户话（#6）、建库卡文案单一来源（#7）、chips 锁序（#13）、CJK–Latin 空格规则（#15） | 卷三 | 小 | 中高（几乎每屏可见） | **A**（#1/#4/#5/#6 并入批 2 静默消灭批，同属「透明度」；其余 B） |
| U4 | toast 生命周期随状态解除（#11）、进度分母统一（#12）、文件夹中英混排映射（#8）、落位标题禁用内部 id（#9，pipeline 侧） | 卷三 | 小 | 中 | **B** |
| U5 | 可访问性：<12px 文字、纯色表意、焦点环 | 卷三 | 小 | 低中 | **C** |

---

## 第二部分 · 反向修订（据阶段二）

### 被参照推翻或降级

| 项 | 原判 | 修订 | 依据 |
|---|---|---|---|
| F12 步骤流交织 | B（成本中大） | **保持 B，但形态定死**：按 Codex 的 HistoryCell 思路——消息 = 片段序列（text / step-group / artifact），探索类步骤（Grep/Glob/Read 连续）合并成一行「查阅了 A、B、C」，长输出 head+tail 折叠 | REFERENCE-codex §7 |
| F5 对话管理 | A | **A，并入 Cmd+K**：侧栏搜索与命令面板同一入口，少做一个控件 | Claude Desktop 侧栏搜索 + Command Palette |
| R3 墙钟超时 | A 简单定时器 | **A，形态改为「软超时→硬 abort→写中断标记先落盘再发事件」** | Codex `handle_task_abort` |
| F24 本会话允许 | B | **升 A**：批准缓存放主进程（`with_cached_approval` 思路），按 (路径, 操作类) 记 keys；WriteConfirm 三档「允许一次 / 本会话此目录不再问 / 拒绝」。HANDOFF「故意不做」是因为没有安全的记忆位置，现在有了做法 | Codex §8.3 |
| F10 通知 | A | **A，加触发策略**：完成才通知、失败才响铃、需要输入常驻 Dock 角标 | Codex §11 通知 + WorkBuddy taskPending/taskCompleted |
| U2 一致性收敛 | B | **保持 B，但输入框下沿定为「本轮参数栏」**：档位 + 写入许可 + 附件统一放这里，不再各自散落 | WorkBuddy/Claude composer 下沿 |
| F17 单轮用量 | B | **拆两半**：「轮内状态行（耗时 · 步骤数 · 档位实际生效）」升 **A**（成本极低，Claude 底部一行）；「上下文剩余 %」暂不做（SDK 不暴露窗口） | Claude 状态行；Codex 扣基线公式留待自建循环时用 |
| 内置终端 / Computer Use / 沙箱 / 插件市场 / 多语言 / 语音 | 未列 | **明确不做**，写进 REFERENCE-products §2 | 垂直定位 |
| R17 网关 | B | **B，但前置到 R10/R11 之前**：Codex requirements 模型说明「管理员下发只读约束」必须以服务端持 key 为前提；团队版三件套顺序 = 网关 → 删除协议 → 主键 | Codex §5.2 |

### 新增借鉴（阶段一没有、阶段二加进来的）

| # | 项 | 来源 | 档 |
|---|---|---|---|
| N1 | 配置层模型：`config.json` / `layout.json` / 管理员区 / 未来 org 下发，重构为「层 + precedence + provenance」，requirements 式 `allowed_*` 约束（团队版「管理员划定集合、本地越界即拒」） | Codex §5 | **B**（团队版设计稿先出，实现随 R17） |
| N2 | 会话 JSONL 导出 + 容错解析（坏行跳过、计数、空文件才失败），resume-recovery 改吃它 | Codex §2.4 | **B** |
| N3 | agent:stream 事件改 Begin/Delta/End 三段式 + rename/alias 版本位；IPC 类型单一真相源（zod schema 导出两侧） | Codex §6 | **B**（与 R14 合并） |
| N4 | 退避重试：200ms×2^n + 0.9–1.1 抖动 + 尊重 Retry-After；瞬态重试进 TaskDock 状态而非对话历史，首次静默 | Codex §9 | **A**（小，与 F4 同批） |
| N5 | write-guard 静态可写根 + 受保护路径（`.mcnai/`、`.git/`、`.obsidian/`）三段判定 | Codex §3.4 | **A**（小，与 F24 同批） |
| N6 | 建库向导拒绝家目录 / 磁盘根 / iCloud 根 | Claude Desktop 文件夹护栏 | **A**（小） |
| N7 | 外链打开确认 | Claude Desktop | **B** |
| N8 | 重置应用数据 / 清缓存重启 / 复制诊断 ID | Claude + WorkBuddy 帮助菜单 | **B** |
| N9 | 步骤行句法收短：「动词 + 数量 + 失败数 ›」 | Claude 步骤行 | **A**（文案，与 F4 同批） |
| N10 | 用量告警常驻条（本月估算超阈值） | Claude 用量黄条 + 色彩语义规则 | **B** |

### 被刻度表一次性解决的

- 卷三里凡属「间距不一致 / 行高不一致 / 阴影蹭默认 / 过渡时长不一」的条目（附录 B 视觉一致性类的大部分）——由 U1 一次性归并，不单列。
- 「toast 几何」「输入框 60px/14px」「首页问候语字号」已有决策，刻度表明确保留，不动。

---

## 第三部分 · v2 实施批次

每批独立可验收；工作量按人日估；走查影响面指 `e2e/walkthrough.mjs` 需要新增/重拍的断言与截图。
预算口径遵循「报整轮成本」：凡涉及真实 AI 调用的验收单独标 ¥。

### 批 0 · 文档纠偏（0.5 天，无走查影响）

- R20 文档：`updater.ts:23` 占位判据注释 + HANDOFF §0 待办 #7 更正为「已接 OSS」；HANDOFF §5 表里补 `docs/PRODUCT-AUDIT.md` 等五份文档索引；`pkb-pipeline/README.md` 链路描述更正。
- R21：embedding 锁定 `text-embedding-3-small/1536` 记进 HANDOFF §4 决策。
- U0：`npm run build && node e2e/walkthrough.mjs` 重拍一轮，核实成功 toast 底色与版本号是否只是基线过期；是则本批只提交刷新后的基线，否则转批 2 修。
- 验收：文档 diff 人工过目 + 刷新后截图逐张看。

### 批 1 · 架构止血（挡团队版/模板路的小成本项）（3 天）

| 项 | 做法 | 验收 |
|---|---|---|
| R1 | `buildSystemPrompt` 读 `readVaultConfig(root).persona`，MCN 句子进 `MCN_PRESET.persona.prompt`；PPT_GUIDE 保留 | `smoke:taxonomy` 加「general 库 prompt 不含 MCN/达人」断言；走查 `assertNoOldBrand` 同款扫一次 prompt |
| R2 | `stop()` → `killGroup('switch')` + `running=false`；`run()` 开头快照 `{root, taskId}` 传尾段；before-quit 遍历 `live` abort；换库时 running 则先 cancel 并 toast「已停止上一库的入库」 | 打包形态走查：换库 mid-pipeline 后 `ps -eo pgid` 零残留（已有 34/34b 模式扩一条）；本地断言 `stop()` 后 `hasChild()===false` |
| R3 | `query()` 外挂 AbortController 定时器（默认 15 min，管理员区可改），超时走与 stop 相同的「写中断标记 → 落盘 → 发事件」 | 纯函数 `judgeTimeout` + 走查用 `MCNAI_E2E_AGENT_TIMEOUT=3000` 造超时（同 §4-22 开关判据） |
| R4 | stderr 环形缓冲 2KB → task.error + main.log | `smoke:pipeline` 喂一个必崩文件断言 error 非空 |
| R5 | `--llm-key` 改 env `LLM_API_KEY`（cli.py 已读 env） | `smoke:pipeline` 断言 argv 不含 key；pkb-pipeline 同步提交源码 + 重新冻结 |
| R6 | `agent/index.ts:481`、`write-guard.ts:56` 改读 `artifacts` 字段 | `smoke:write` 加「改名产物目录后写入落对地方」 |
| R7 | `SUPPORTED_EXT` 单一导出；`attachments.ts` 引用它；`smoke:taxonomy` 扩一组 fixture 比对 py `CONVERTERS` 键集 | 契约测试红/绿 |
| N5 | write-guard 加 `isPathWritable(root, rel)`：受保护前缀表 | `smoke:write` 加 5 条 |
| N6 | 建库向导 `pick()` 拒绝 `~`、`/`、`/Volumes/*` 根、`~/Library/Mobile Documents` 根 | 走查 40 系加一条 |

走查影响：新增约 6 条断言、1 张截图（换库停止提示）。真实调用：R3 用开关造，¥0。

### 批 2 · 静默消灭 + 透明度（2.5 天）　—— **已完成 2026-09-03**

| 项 | 做法 |
|---|---|
| F3 | `cloudSync` 失败篇写入 `tasks.json` 新表 `noteSyncQueue`（复用 syncQueue 退避），Dock 计数并入「待同步」；文案改实话 |
| F4 全部七条 | Q7 summaryText 第三分支；Q8 气泡角标；Q9 update error 态；Q11 离线 60s 退避重探；Q13 diag try/catch+busy；Q14 settings 统一 `saveWithToast`；Q15 步骤流折叠行尾「· 标准档」（degraded 时标「已按标准档执行」） |
| N4 | `knowledge/client.ts` 与 `health.ts` 的重试统一走 `backoff(n)`；瞬态重试只更新 TaskDock 条文案 |
| N9 | `config/steps.ts` 文案按「动词+数量+失败数」模板重写；验证性扫描保留现有分范围文案 |
| F17 半 | Workbench 输入框上方一行：`用时 Xs · N 步 · 标准档`（数据全来自任务层与步骤流，零新 IPC） |
| F1 | `main.tsx` 包 ErrorBoundary，错误页两颗按钮：重载 / 导出诊断报告 |
| U3 前四条 | frontmatter 键名中文映射表 + 未知键折叠；「库」统一称呼（建议「知识库」）；产物面板/设置/换库弹窗不显内部路径；投递箱阶段名改用户话（`STAGE_ZH` 一处改） |

走查影响：F4 每条一张截图（约 7 张）；F3 需 E2E_CHAT 登录态造一次上云失败（404 前缀法，同 51 步），≈ ¥0.5；F1 用 `MCNAI_E2E_THROW=1` 造渲染异常。

**并入批 2 的挂账（2026-09-03，来自档位线路契约 v2 那单，HANDOFF §0-新f）**：`smoke:provider` 跑完汇总后 `app.exit()` 不退出，进程挂 11 分钟（标准档 3/3 早已通过）。疑与 Electron 43 的 `before-quit`/chokidar watcher 同源；修法二选一：汇总后先 `vaultManager.close()`/`agentManager.abortAll()` 再 exit，或加 30s 硬超时 `process.exit`。零真实调用可验（`SMOKE_CASES=env` 只跑环境隔离那项）。

### 批 3 · 高频功能补齐（4 天）　—— **已完成 2026-09-04**（另加用户点名的两条：会话内搜索 Cmd+F、Cmd+N 新窗口）

| 项 | 做法 |
|---|---|
| F2 | `draft.<convId>` 落 localStorage，切回恢复，发送后清 |
| F5 + F8 | Cmd+K 命令面板（搜对话 / 搜笔记 / 命令：新对话、打开设置、切库）；侧栏对话右键：重命名/置顶/删除；Cmd+F 聚焦搜索；Esc 关笔记/退编辑；Cmd+, 设置；上下键选会话；邮箱框 form submit |
| F9 | 用户气泡 hover：复制 / 编辑重发（编辑态 Enter 保存 Esc 取消，同 WorkBuddy）；assistant 气泡加「重新生成」（复用 retry 路径但不撤气泡，追加新轮）；Markdown `<pre>` 加复制按钮 |
| F7 | 分流规则删除 `ui.confirm` + 5 秒撤销 toast；敏感档升级 confirm 写明「人事/财务将同步到云端」；昵称/地址改 onChange 防抖保存 + 「已保存」轻 toast |
| F10 | `Notification` 三类 + `app.dock.setBadge`；`window-all-closed` 不退出（macOS 惯例）；菜单「退出」保留 before-quit 链 |
| F25 前两项 | 窗口 bounds 落 store；Cmd+/- 缩放 |
| F24 | WriteConfirm 三档；主进程 `approvals: Map<key, 'session'>`，key = `${kind}:${dirPrefix}`；会话结束清 |

走查影响：约 12 条新断言、8 张截图；F9 重新生成需 E2E_CHAT 一轮 ≈ ¥0.3。

### 批 4 · UI 地基：刻度表落地（2 天）

- U1 全部；脚本化替换后 `npm run build` + 全量走查重拍基线，**逐张过目**（铁律）。
- 验收：`ui-hardcode-stats.mjs` 间距裸值占比从 100% → 0（白名单类除外）；toast 几何比对不变；对比度断言不变。
- 走查影响：全部 142 张基线重拍；新增 spacing 白名单断言。
- 排在批 3 之后的原因：批 3 会新增控件，先做地基再加控件会返工两次。

### 批 5 · 可测性与账本（3 天，跨 pkb-pipeline）　—— ✅ **整批完成 2026-09-04**（见 HANDOFF §0-新h，未发版）

| 项 | 做法 |
|---|---|
| R8 ✅ | `03_tag_llm` 累加 usage 并打一行 `{stage:'tag_llm', status:'usage', usage, calls, model}`；orchestrator 单独接走 → `usage/ingest.ts` 落账；用量页脚注改按 `summary.ingest.unmetered` 说话；三方对账一次（实花 ¥0.23）。**与原计划两处不同**：① 用独立的 `status:'usage'` 行而不是挂在 `tag_llm` ok 事件上——挂上去的话撞熔断线/抛异常那两条路径的花费会丢，而且会出现"阶段事件"与"账本"两份真相；② `cli.py` 侧不再返回聚合（返回值会被 `run_stage` 并进 ok 事件 = 同一笔记两遍），只补了分流轻管线 `route_*` 的主题打标用量——那笔以前完全没人记 |
| S2 ✅ | 用量记录加 `attribution{template,taskId,vault,stage}`（模板系统落地前 `template` 恒 null）；对账脚本加「按归因」表 |
| R9 ✅ | `agent/result.ts` 的 `judgeResult(msg, expectedModel)` → `{kind, error, models, degraded, resolvedModel, billable, sessionUsable}`；`smoke:steps` +17 条 fixture。**四条判据方向各不相同，刻意不合并**：显示只认 `is_error`，记账还要求真产生过 token，会话续接认 `is_error \|\| api_error_status` |
| F11 ✅ | `inbox/attempts.ts` 的 `judgeAttempts`：连着 3 轮仍留在投递箱的文件移入 `.failed/` 并写原因；`smoke:guards` +13 条。**顺带补了一个从没成立过的解析**——读 `失败原因.txt` 原来按 `名字 —— 原因` split，而盘上是 pipeline 写的「· 名字 / 缩进 原因：…」，reason 恒为 undefined |
| R16 ✅ | search-worker `error`/`exit` 就地重建（带 `lastDocs` 重灌 + 重建封顶）；库根可访问性做成 **Condition `vault-lost`** + 顶条。**判据以磁盘探测为准、以心跳为主力**：macOS 上外接盘被拔时 fsevents 往往直接不吭声，只等 watcher 事件的话那台机器上永远不会报 |

原表里 R9/F11/R16 的做法与落地的差别，都写在上面这三行里。

验收：R8 真跑一轮打标对账 ≈ ¥1；其余零花费。走查影响：2 张截图（vault-lost 条、失败件移入）。

**收尾（2026-09-04，整批关账）**：
- R8/S2：新增 `smoke:usage`（L1，40+ 条零花费，含"应用侧 vs 对账脚本"跨实现比对）、
  `smoke:pipeline` 第 7 节（本机 http 桩验冻结产物真回传）、`e2e/usage-reconcile.mjs`（真实入库三方对账，实花 ¥0.23）。
  走查用量页断言从「打标不该有 token」翻转成「打标的 token 必须进账 + 缓存拆分不许算胀」
- R9/F11/R16：`smoke:steps` +17、`smoke:guards` +30，全部零花费；走查 +2 张截图
  （`73-失败件-清单带原因`、`74-知识库目录不可访问-顶条`），与本批预估的 2 张一致
- `npm run verify` 15/15 全绿。**真实调用合计 ¥0.23**，原估 ≈¥1

### 批 6 · 团队版前置三件套（大单，各自立项；顺序固定）

1. **R17 网关**（HANDOFF 已定方向）：webpage 新路由转发上游 + Bearer；`tiers.ts` base URL 改网关、删 key 回落逻辑（a13 契约漂移一并清）；R5 的 env 传 key 随之作废。→ 单独 PLAN。
2. **R10 删除/改名协议**：`vault:deleteNote/rename` 通知 `knowledge/client` 发 delete；一次性对账脚本清孤儿切片（R-02 存量一起清）。
3. **R11 稳定 doc id**：frontmatter `id`（无则按内容 hash 生成并写回）；索引 Map 双键过渡；云端 `file_path` 旁加 `doc_id`。
4. **N1 配置层模型**：设计稿先出（层 + precedence + requirements），实现挂 `scope:'org'` 下发那一单。
5. R18 / R19 随团队版主单。

### 批 7 · 模板系统形态定型后

- R12 兜底中性、R13 实体种类表驱动、F19 库级指令 UI、U2/U3/U4 一致性与文案、F25 深色模式、F12 步骤流交织（消息模型改动，与模板系统的「任务模板」一起定消息片段格式）、F20 定时任务、N10 用量告警条。

### 挂账（C 档）

F21 draft 落盘、F22 导出归档、U5 可访问性、N7 外链确认、N8 重置数据、F23 OCR（单独立项，价值高但成本大）。

---

## 第四部分 · 总览与预算

| 批 | 内容 | 人日 | 真实调用 | 走查影响 |
|---|---|---|---|---|
| 0 | 文档纠偏 | 0.5 | ¥0 | 无 |
| 1 | 架构止血 9 项 | 3 | ¥0 | +6 断言 +1 图 |
| 2 | 静默消灭 + 透明度 | 2.5 | ≈¥0.5 | +7 图 |
| 3 | 高频功能 7 组 | 4 | ≈¥0.3 | +12 断言 +8 图 |
| 4 | 刻度表落地 | 2 | ¥0 | 全量重拍 142 图 |
| 5 | 可测性与账本 | 3 | ≈¥1 | +2 图 |
| 6 | 团队版前置三件套 | 各自立项 | — | — |
| 7 | 模板系统后 | 待定 | — | — |

批 0–5 合计约 **15 人日**，真实调用合计 **≈¥2**（不含每批收尾的整轮 `verify` 与走查；E2E_CHAT 全量一轮 ≈¥1.8，按批 2/3/5 各跑一次计 ≈¥5.5）。

**批准后的第一步**：批 0 + 批 1 合并成一个实施单，先出 R1/R2/R3 三条的 e2e 断言草案再动代码（desktop/CLAUDE.md 铁律：横跨产品与走查的改动先把走查假设找一遍）。

---

## 附：v1 → v2 变更摘要

- 升档：F24（B→A）、F17 半（B→A）、N4/N5/N6/N9（新增即 A）
- 降档 / 不做：内置终端、Computer Use、沙箱、插件市场、多语言、语音输入、revert（参照产品有但与垂直定位无关）
- 形态定死：F12（片段序列 + 探索合并）、R3（软硬两段 + 先落盘）、F24（主进程批准缓存）、U2（输入框下沿 = 本轮参数栏）
- 顺序变化：R17 网关前置到 R10/R11 之前；批 4 刻度表移到批 3 之后
- 被刻度表吸收：卷三视觉一致性类大部分条目

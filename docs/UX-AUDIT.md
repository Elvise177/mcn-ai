# mcn-ai 桌面版 UX 审计（交互设计缺陷清单）

> 日期：2026-08-16 ｜ 范围：`desktop/` 渲染层 + 与之直接相关的主进程链路 ｜ 性质：**只读审计，未改任何代码**
> 方法：从代码出发，遍历渲染层所有会触发主进程异步操作的交互，逐个核对「进行中 / 成功 / 失败+重试」三态；再按状态覆盖、可达性与可逆性、一致性、键盘效率四个维度扫一遍全部页面与组件。
> **状态（2026-08-16 更新）**：H-01 ~ H-06 已修复并跑完 GUI 走查（见 `docs/HANDOFF.md` §2-10），本文其余条目仍未动。
> 未复核（按要求跳过）：**产物入库后工作台无进度反馈**（已有修复方案待执行）。
> 关联已知问题：**无离线降级（HANDOFF bug#1，P0）** 不重复分析，但下文 M-01 记录了它在登录界面的一个未被 bug#1 覆盖的表现（无超时/无取消）。

## 汇总

| 严重度 | 条数 | 集中在哪 |
|---|---|---|
| 高 | 13 | 数据丢失（3）、界面陷阱（2）、跨页面状态出口（3）、异步三态断裂（5） |
| 中 | 29 | 静默失败（9）、状态覆盖缺口（7）、一致性（4）、键盘（4）、性能与规模（5） |
| 低 | 12 | 超长内容、快捷键、不可达设置项、细节反馈 |

严重度判据：**高** = 会丢数据 / 让界面进入回不去的状态 / 用户完全看不到系统在做什么；**中** = 操作失败或成功都没反馈，用户会误判，但能自己绕开；**低** = 打磨项，不影响任务完成。

---

## 一、高严重度（13 条）

### H-01 拖文件到「对话工作台」或「设置」页，整个应用被那个文件替换
- **现象**：在首页（对话工作台）把 Word/PDF 拖进窗口 —— 界面直接跳成那个文件的内容或一片空白，侧栏没了，只能退出重开。首页输入框的附件按钮点了还提示「先把文件拖进窗口即可入库」，等于在主动引导这个动作。
- **根因**：只有知识库页的根 div 拦了拖放（[VaultPage.tsx:446](desktop/src/renderer/src/pages/VaultPage.tsx:446)–458）；[main/index.ts:15](desktop/src/main/index.ts:15) 的 `createWindow` 没有 `will-navigate` 拦截，[main.tsx:10](desktop/src/renderer/src/main.tsx:10) 也没有 document 级的 `dragover/drop` preventDefault。Electron 默认行为就是导航到 `file://`。
- **建议**：主进程加 `win.webContents.on('will-navigate', e => e.preventDefault())` 兜底，渲染层在 `main.tsx` 全局 preventDefault，同时让工作台页的拖入也走 `inbox.enqueue`。
- **维度**：3 可达性 ｜ **严重度：高**

### H-02 「换库」点了系统对话框的取消，就回不到原来的库
- **现象**：点「换库」→ 界面立刻变成建库向导 → 在 Finder 选择框点取消 → 停在向导页，没有「返回」，原来那个库像是丢了（其实主进程里还开着）。
- **根因**：[VaultPage.tsx:107](desktop/src/renderer/src/pages/VaultPage.tsx:107) 的 `onSwitch` 直接 `setVault(null)`；[VaultPage.tsx:104](desktop/src/renderer/src/pages/VaultPage.tsx:104) 渲染 `VaultWizard` 时没传 `onSkip`，向导在这个入口下没有任何退出口。
- **建议**：换库入口传 `onSkip` 回到当前库（`vaultManager.currentRoot` 还在），并给换库加一次确认。
- **维度**：3 可逆性 ｜ **严重度：高**

### H-03 删除对话：一次点击、无确认、无撤销、无提示
- **现象**：侧栏对话 hover 出一个 ✕，点下去对话立刻消失，没有确认弹窗，没有 toast，也没有任何找回方式。误点即永久丢失整段对话。
- **根因**：[App.tsx:222](desktop/src/renderer/src/App.tsx:222)–233 直接 `await window.api.chat.delete(c.id)` → `deleteConversation` 从 electron-store 硬删（[conversations.ts:33](desktop/src/main/agent/conversations.ts:33)）。对比笔记删除有 confirm + 废纸篓 + toast（[VaultPage.tsx:399](desktop/src/renderer/src/pages/VaultPage.tsx:399)–412），同类操作两套标准。
- **建议**：走 `ui.confirm` + 删除后 toast；或改软删除保留 7 天。
- **维度**：3 可逆性 / 4 一致性 ｜ **严重度：高**

### H-04 编辑笔记时切到另一篇，未保存内容静默丢失
- **现象**：进入编辑态改了几段，顺手在左侧树点了另一篇笔记 —— 改动无声消失，没有「未保存」提示。图谱点击、搜索结果点击、换库、关库同理。
- **根因**：`NoteView` 用 `key={current}` 挂载（[VaultPage.tsx:564](desktop/src/renderer/src/pages/VaultPage.tsx:564)–571），`dirty`/`draft` 是它的局部状态，换 key 就整个销毁。只有组件内的「取消」按钮做了放弃确认（[VaultPage.tsx:798](desktop/src/renderer/src/pages/VaultPage.tsx:798)）。
- **建议**：把 `dirty` 提到 `Explorer` 层，`openNote` / `onSwitch` / 关闭前统一走一次确认。
- **维度**：3 可逆性 ｜ **严重度：高**

### H-05 笔记保存失败是静默的，保存成功也没有任何反馈
- **现象**：点「保存」后按钮变灰、退出编辑态 —— 无论写入是否真的成功都长这样。磁盘只读、文件被 Obsidian 锁住、库被移走，用户都以为存上了。
- **根因**：[VaultPage.tsx:745](desktop/src/renderer/src/pages/VaultPage.tsx:745)–749 的 `save()` 无 try/catch，`vault:write` 拒绝时是一个未捕获 rejection（只会进诊断日志，见 [main.tsx:8](desktop/src/renderer/src/main.tsx:8)），而 `setDirty(false)`/`setEditing(false)` 已经先执行了。Cmd+S 走同一条路径。
- **建议**：try/catch，成功给轻 toast，失败保留编辑态并报错。
- **维度**：1 三态 ｜ **严重度：高**

### H-06 AI key 下发失败 = 死路（设置页根本没有手填 key 的入口）
- **现象**：登录成功，但发第一条消息时报「请先在『设置』里配置 API Key」；进设置页只看到一行「AI 服务：登录后自动配置」，没有任何可填的框，也没有「重新获取」按钮。用户到此为止。
- **根因**：`provisionKeys` 全程静默 catch（[auth/index.ts:93](desktop/src/main/auth/index.ts:93)），失败不通知渲染层；设置页只读展示 `hasKey`（[App.tsx:451](desktop/src/renderer/src/App.tsx:451)–458）；`settings.setKey` / `setLlmKey` 在 preload 有通道（[preload/index.ts:6](desktop/src/preload/index.ts:6)–7）却没有任何 UI 调用方。
- **建议**：设置页补「手动填写 key」输入框 +「重新获取服务端配置」按钮；provision 失败时给可见提示。
- **维度**：1 三态 / 3 可达性 ｜ **严重度：高**

### H-07 投递箱正在跑时，在工作台/设置页完全没有出口
- **现象**：批量导入几百个文件（可跑十几分钟），只要切到「对话工作台」，界面上没有任何在处理中的痕迹 —— 没有进度、没有角标、没有提示，用户以为导入没启动，或者重复再拖一次。
- **根因**：`useInbox` 只在知识库页的 `Explorer` 内挂载（[VaultPage.tsx:306](desktop/src/renderer/src/pages/VaultPage.tsx:306)），其他页面根本没有 `inbox:event` 的监听者，事件被丢弃。
- **建议**：inbox 运行态提到 `App` 层（与产物入库反馈的修复方案合并做），侧栏底部给一条常驻「投递箱处理中 3/6」条目，点开跳知识库页。
- **维度**：1 三态（跨页面状态出口）｜ **严重度：高**

### H-08 跑到一半切回知识库页：进度条不见了，看着像卡死
- **现象**：导入进行中离开知识库页，再回来 —— 面板不出现，或出现但显示的是上一轮的静态日志，没有「处理中…」和进度条；直到下一条阶段事件到来才动一下。
- **根因**：`useInbox` 的 `running` 初始值恒为 `false`（[VaultPage.tsx:126](desktop/src/renderer/src/pages/VaultPage.tsx:126)），恢复用的 `inbox:lastRun` 只回放事件数组、不回放运行态（[ipc.ts:143](desktop/src/main/ipc.ts:143)）；`showInbox` 也重置为 false。
- **建议**：`inbox:lastRun` 改返回 `{ events, running }`，`useInbox` 用它初始化。
- **维度**：1 三态 / 2 状态覆盖 ｜ **严重度：高**

### H-09 点「停止生成」，已经流出来的半截回答直接消失
- **现象**：AI 写了一大段，用户觉得够了点停止 —— 屏幕上那段文字瞬间清空，对话里什么都没留下，想要的内容也没法复制。
- **根因**：`done` 事件统一 `setDraft('')`（[Workbench.tsx:66](desktop/src/renderer/src/pages/Workbench.tsx:66)–70）；abort 路径下主进程不发 `assistant` 消息、只发 `done`（[agent/index.ts:270](desktop/src/main/agent/index.ts:270)–271），所以草稿既不入库也不留屏。
- **建议**：`stop` 时把当前 `draft` 落成一条 assistant 消息（尾部标「（已停止）」）再清空。
- **维度**：3 可逆性 / 1 三态 ｜ **严重度：高**

### H-10 生成中切走对话，回来后没有"进行中"状态，还能重复发送
- **现象**：AI 还在写，切到别的对话再切回来 —— 停止按钮没了、输入框可用、没有任何在生成的迹象；再发一条，主进程会用同一个 sessionId 起第二个 query，第一个请求从此停不掉。
- **根因**：`streaming` 是 `Workbench` 的局部状态且按 `conv.id` 重置（[Workbench.tsx:48](desktop/src/renderer/src/pages/Workbench.tsx:48)–53），非活跃会话的 delta 被过滤掉（[Workbench.tsx:57](desktop/src/renderer/src/pages/Workbench.tsx:57)）；主进程 `this.live.set(sessionId, …)` 后来居上覆盖前一个 AbortController（[agent/index.ts:197](desktop/src/main/agent/index.ts:197)–198）。
- **建议**：「哪些 session 正在流」提到 `App` 层由主进程事件驱动；`send` 时若该 session 已在跑则拒绝或先 abort。
- **维度**：1 三态 / 2 状态覆盖 ｜ **严重度：高**

### H-11 搜索没有结果时，直接显示完整文件树，没有「没找到」
- **现象**：在知识库搜一个库里没有的词，左栏显示的是整棵文件树 —— 和没搜一样，用户以为搜索框坏了或者没生效。
- **根因**：[VaultPage.tsx:535](desktop/src/renderer/src/pages/VaultPage.tsx:535) `hits.length > 0 ? 结果列表 : <Tree/>`，把「无结果」和「未搜索」画成了同一个状态；搜索期间也没有加载态（200ms 防抖 + worker 可能排队数秒，[searcher.ts:59](desktop/src/main/vault/searcher.ts:59)）。
- **建议**：按 `query.trim()` 是否为空分三态：未搜索→树；搜索中→骨架/「检索中…」；有词无结果→「没找到『X』」+ 清空按钮。
- **维度**：2 状态覆盖 ｜ **严重度：高**

### H-12 建库/选库失败或耗时长，向导会永久卡在灰掉的状态
- **现象**：点「新建库」，如果创建或首次索引出错，两张卡片就一直是半透明不可点，没有任何报错，只能重启。大库正常扫描时也只是 opacity-60，没有「正在索引…」，容易被当成卡死而反复点。
- **根因**：[VaultWizard.tsx:12](desktop/src/renderer/src/components/VaultWizard.tsx:12)–17 的 `pick()` 无 try/catch/finally，`vault:createNew` 抛错时 `setBusy(false)` 不会执行；busy 态也没有文案变化。
- **建议**：`try/finally` + 错误 toast；busy 时把卡片文案换成「正在创建/索引…」并给 spinner。
- **维度**：1 三态 / 2 状态覆盖 ｜ **严重度：高**

### H-13 投递箱任务开跑后无法取消
- **现象**：误拖了 200 个文件，或某一步在跑很久的 LLM 打标 —— 面板上只有「立即处理」和「✕ 关闭」，没有停止；唯一办法是退出应用（而且 spawn 出去的 pipeline 子进程未必跟着退）。
- **根因**：[orchestrator.ts:193](desktop/src/main/inbox/orchestrator.ts:193)–219 的 `child` 是 Promise 内的局部变量，没有对外的 kill 入口，IPC 也没有 `inbox:cancel`。
- **建议**：把 child 存成实例字段，暴露 `inbox:cancel`，面板加「停止本轮」；`app.on('before-quit')` 里也 kill 一次。
- **维度**：3 可逆性 ｜ **严重度：高**

---

## 二、中严重度（29 条）

### 静默失败（点了没反应 / 失败无提示）

**M-01 登录没有超时，也不能取消**
Supabase 暂停或断网时 `signInWithPassword` 会长时间挂起，按钮定格在「登录中…」（[LoginGate.tsx:17](desktop/src/renderer/src/pages/LoginGate.tsx:17)–25），没有超时、没有取消、没有「网络不通」的区分文案。属于已知 bug#1 的表现之一，但 bug#1 记的是启动链路，这一条在登录界面。**建议**：加 10s 超时 + 可取消 + 明确区分「网络不可达」和「账号密码错」。

**M-02 点了文件树里的笔记，读取失败时界面毫无反应**
[VaultPage.tsx:382](desktop/src/renderer/src/pages/VaultPage.tsx:382) `.catch(() => setNote(null))`，而正文区的渲染条件是 `current && note`（:562），所以读失败=什么都不出现，用户会反复点同一条。**建议**：catch 里 toast + 在正文区渲染错误态。

**M-03 云端同步失败完全无感知，且 HANDOFF 说的重试队列在代码里不存在**
`syncConversation` 整个 try 包一个空 catch（[client.ts:93](desktop/src/main/knowledge/client.ts:93)），设置页却写着「账号（云端同步：私人知识层 + 聊天记录）」。离线一整天，用户以为记录都在云上。**建议**：同步状态提到 UI（侧栏一个小圆点足够），失败落队列或至少给一次提示。

**M-04 打开库内附件（PDF 等）失败无提示**
`vault.openFile` 返回 boolean 表示是否找到文件，调用方直接丢弃（[VaultPage.tsx:773](desktop/src/renderer/src/pages/VaultPage.tsx:773)）。链接指向已移动的文件时，点了纯粹没反应。**建议**：`if (!ok) ui.toast('找不到文件：…','error')`。

**M-05 产物「打开」失败无提示**
`shell.openPath` 的返回值（失败时是错误字符串）被忽略（[artifacts.ts:64](desktop/src/main/agent/artifacts.ts:64)–67）。系统里没装 Keynote/Office 时点「打开」毫无反应。**建议**：把 openPath 的错误回传并 toast，附「在 Finder 中显示」兜底。

**M-06 拖拽入库失败是静默的**
`onDrop` 用 `void doEnqueue(e)`（[VaultPage.tsx:458](desktop/src/renderer/src/pages/VaultPage.tsx:458)），而 `enqueue` 在投递箱未就绪时直接 throw（[orchestrator.ts:109](desktop/src/main/inbox/orchestrator.ts:109)）。此时面板已经弹出并显示「把文件拖进窗口…」的空态，观感等于"收下了但没动静"。**建议**：try/catch + 错误 toast。

**M-07 「立即处理」在没有库时点了完全没反应**
[orchestrator.ts:176](desktop/src/main/inbox/orchestrator.ts:176) `if (!this.vaultRoot) return`，静默返回，按钮没有禁用态。**建议**：无库时禁用并给 title 说明。

**M-08 导出诊断报告：无加载态、失败无提示**
[App.tsx:477](desktop/src/renderer/src/App.tsx:477)–485 直接 `await` 后无条件 toast「已导出到桌面」；写盘失败时是未捕获 rejection，而 toast 甚至不会出现（await 抛出后续代码不执行），用户什么都看不到。这是给客服用的最后一根救命稻草，不能哑。**建议**：try/catch + 按钮 busy 态 + 失败给出路径原因。

**M-09 设置项 onBlur 保存：切页面会丢输入，且保存无任何反馈**
昵称（[App.tsx:443](desktop/src/renderer/src/App.tsx:443)–449）与服务器地址（[App.tsx:459](desktop/src/renderer/src/App.tsx:459)–467）只在 onBlur 提交。输入框在有焦点时被卸载（点侧栏切页）不会触发 blur，改动直接丢失；即使成功也没有任何"已保存"提示。**建议**：改 onChange 防抖保存 + 一条淡出的「已保存」。

### 状态覆盖缺口

**M-10 上次的库找不到了 → 一声不吭掉进建库向导，且与工作台状态不一致**
`vault:openStored` 内部 try/catch 返回 null（[ipc.ts:147](desktop/src/main/ipc.ts:147)–155），知识库页据此渲染向导（[VaultPage.tsx:99](desktop/src/renderer/src/pages/VaultPage.tsx:99)–106），不说明"库路径已失效"；与此同时 App 只看 `settings.get().vaultPath` 是否存在就判定 `vaultState='ready'`（[App.tsx:77](desktop/src/renderer/src/App.tsx:77)），工作台照常表现为有库。**建议**：openStored 返回失败原因，向导顶部给「上次的库（路径）打不开了」。

**M-11 AI 回答出错后没有重试入口**
错误只作为一条 `⚠️ …` 的 assistant 消息落进历史（[App.tsx:87](desktop/src/renderer/src/App.tsx:87)–89），用户要重试只能把刚才那段话重新打一遍。**建议**：错误气泡内附「重试」按钮，复用上一条 user 消息。

**M-12 产物列表被硬截断到 30 条，界面上看不出还有更多**
[artifacts.ts:61](desktop/src/main/agent/artifacts.ts:61) `.slice(0, 30)`，面板既没有"更多"，也没有"打开 90_产物 目录"的入口。用久了旧产物就从界面上消失了。**建议**：面板底部加「在 Finder 中打开 90_产物」。

**M-13 搜索结果同样静默截断到 20 条，且没有结果计数**
[search-worker.ts:90](desktop/src/main/vault/search-worker.ts:90) `.slice(0, 20)`；UI 也不显示"共 N 条"。**建议**：返回总数，列表头显示「20 / 137 条」。

**M-14 点开搜索结果，查询词被清空、结果列表消失，回不去**
`openNote` 里 `setQuery('')` + `setHits([])`（[VaultPage.tsx:368](desktop/src/renderer/src/pages/VaultPage.tsx:368)–369）。看完一条想看第二条，只能重新输入。**建议**：保留查询与结果，只高亮当前条。

**M-15 没有 React 错误边界，渲染异常 = 白屏**
[main.tsx:10](desktop/src/renderer/src/main.tsx:10)–14 直接 render，没有 ErrorBoundary。主进程只处理了 `render-process-gone`（进程级崩溃，[main/index.ts:36](desktop/src/main/index.ts:36)），JS 异常不在其中。一条脏 frontmatter 就可能白屏。**建议**：根部加 ErrorBoundary，出错给「界面出错了 / 重载 / 导出诊断」。

**M-16 设置页无加载态，字段先空后填**
[App.tsx:403](desktop/src/renderer/src/App.tsx:403)–408 异步填充，首帧「服务器」是空输入框、「AI 服务」显示未就绪，约一帧后才跳变。**建议**：加载中显示骨架或占位。

### 一致性

**M-17 「删除」有三套完全不同的交互**
笔记 = ··· 菜单 + 二次确认 + 废纸篓 + toast（[VaultPage.tsx:399](desktop/src/renderer/src/pages/VaultPage.tsx:399)）；对话 = hover ✕ 秒删无确认（[App.tsx:222](desktop/src/renderer/src/App.tsx:222)）；分流规则 = 常驻 ✕ 秒删无确认且立即写盘（[App.tsx:344](desktop/src/renderer/src/App.tsx:344)–350）。**建议**：统一「危险操作必须二次确认 + 结果 toast」。

**M-18 分流规则删除即时生效且不可逆**
同上，`save(routes.filter(...))` 直接落 `layout.json`（[routes.ts:43](desktop/src/main/lib/routes.ts:43)）。用户以为只是从列表里去掉。**建议**：加确认，说明「已投递的文件不受影响，新文件将不再分流」。

**M-19 ✕ 这个符号同时表示"关闭"和"删除"，而且有两套实现**
字符 `✕`：投递箱面板=关闭（[VaultPage.tsx:201](desktop/src/renderer/src/pages/VaultPage.tsx:201)）、对话=删除（[App.tsx:229](desktop/src/renderer/src/App.tsx:229)）、分流规则=删除（[App.tsx:344](desktop/src/renderer/src/App.tsx:344)）；lucide `<X/>`：产物面板/关系图/笔记/弹窗=关闭。同一个视觉符号语义相反，且两种画法混用。**建议**：关闭一律 lucide `X`，删除一律 `Trash2`，全局替换字符 ✕。

**M-20 投递箱面板与产物面板的操作栏形态不一致**
投递箱头部是文字链（「立即处理」「✕」），产物面板是图标按钮，知识库树头部又是一排纯文字按钮（[VaultPage.tsx:505](desktop/src/renderer/src/pages/VaultPage.tsx:505)–531）。三个同级面板三种按钮语言。**建议**：定一套「面板头部操作」的统一样式。

### 键盘

**M-21 Esc 关不掉确认弹窗，Enter 也不能确认**
`UiHost` 的键盘处理只写在 prompt 的 input 上（[ui.tsx:96](desktop/src/renderer/src/components/ui.tsx:96)–99）；confirm 模式没有输入框，所以整个弹窗不响应任何按键，只能鼠标点。**建议**：在 modal 容器上挂 keydown，Esc=取消、Enter=主按钮（危险操作可要求 Enter 落在已聚焦的主按钮上）。

**M-22 编辑模式下 Esc 不能退出**
只实现了 Cmd/Ctrl+S（[VaultPage.tsx:846](desktop/src/renderer/src/pages/VaultPage.tsx:846)–851）。**建议**：Esc → 走「取消」（含 dirty 确认）。

**M-23 登录页邮箱框回车不提交**
onKeyDown 只加在密码框上（[LoginGate.tsx:44](desktop/src/renderer/src/pages/LoginGate.tsx:44)），email 输入框（:34–40）没有。填完邮箱回车没反应。**建议**：改成 `<form onSubmit>`。

**M-24 知识库搜索框缺全部键盘能力**
[VaultPage.tsx:497](desktop/src/renderer/src/pages/VaultPage.tsx:497)–502：Esc 不清空、Enter 不跳首条、上下键不能选结果，也没有全局聚焦快捷键（Cmd+F/Cmd+K 都没有绑定）。这是高频入口。**建议**：至少补 Cmd+F 聚焦 + Esc 清空 + Enter 打开首条。

### 规模与性能

**M-25 文件树无虚拟化，几千文件全量渲染**
`Tree` 递归渲染全部展开节点（[VaultPage.tsx:614](desktop/src/renderer/src/pages/VaultPage.tsx:614)–659）；`countNotes(tree)` 每次渲染都递归整棵树，且在 JSX 里调用（[VaultPage.tsx:504](desktop/src/renderer/src/pages/VaultPage.tsx:504)）。大库展开顶层目录会明显掉帧。**建议**：笔记数 memo 化；节点数超阈值上虚拟列表。

**M-26 关系图无节点上限、持续重绘**
`autoPauseRedraw={false}` + `cooldownTime={8000}`（[VaultPage.tsx:1042](desktop/src/renderer/src/pages/VaultPage.tsx:1042)–1071），几百上千节点时风扇起飞；且每次 `vault:changed` 都重新全量拉图并重建邻接表（:960），投递箱跑批期间会被反复触发。**建议**：节点数超阈值时降级（只画一跳邻域 / 提示「节点过多，已简化」），`vault:changed` 的重建加防抖。

**M-27 编辑中外部改动会被静默覆盖，而「Obsidian 同时编辑」是宣传卖点**
watcher 触发时会重新 `read` 并 `setNote`（[VaultPage.tsx:355](desktop/src/renderer/src/pages/VaultPage.tsx:355)–361），但编辑态的 `draft` 是独立副本，保存时整篇覆盖（[VaultPage.tsx:745](desktop/src/renderer/src/pages/VaultPage.tsx:745)），没有任何冲突提示。**建议**：编辑期间检测到同文件外部变更就提示「此文件已在外部被修改」，提供「用我的覆盖 / 放弃我的」。

**M-28 未登录（本地模式）时，云端相关入口没有降级说明**
产物「入库」照常可点、`cloud_sync` 阶段只在日志里写一行「跳过」（[orchestrator.ts:145](desktop/src/main/inbox/orchestrator.ts:145)），AI 检索会静默从云端三层回退到本地全文（[agent/index.ts:126](desktop/src/main/agent/index.ts:126)–138），检索质量变化用户完全不知情。**建议**：本地模式在工作台顶部给一条常驻说明条。

**M-29 safeStorage 首次调用冻住主进程（2026-08-16 定位并修复，随模型 provider 解耦一并做）** ✅ 已修
**根因不是 `encryptString`，而是"一个进程里对 safeStorage 的第一次调用"**——它要去 Keychain 取「mcn-ai-desktop Safe Storage」那把 key，securityd 要校验调用方的代码签名（ad-hoc 签名的大 bundle 尤其贵），结果被系统缓存，缓存冷热决定耗时。用 Electron 30.5.1 实测（探针见 git log）：

| 首次调用的是谁 | 耗时 |
|---|---|
| `isEncryptionAvailable()` | 8.7s |
| `encryptString()`（系统缓存冷） | 60.4s |
| `decryptString()`（另一次冷启动） | 4.3s |
| 任意首调（系统缓存热） | 8ms |
| 首调之后的同进程调用 | 0–2ms |

也就是说 `isEncryptionAvailable`／`decryptString`／`encryptString` 谁先被调用谁付钱，**读也一样贵**——原来的 `settings:get` 每次都 `!!getApiKey()`（解密一次）就足以触发它。这笔调用是同步的，主进程一冻 IPC、窗口、CDP 全停。

**utilityProcess 这条路走不通（已实测）**：utilityProcess 里 `require('electron')` 只暴露 `net` 与 `systemPreferences`，没有 `safeStorage`，所以「把加密整个挪进 worker」在 Electron 30.5.1 下不成立。理论上还能起一个**长驻的第二个 Electron 实例**当加密助手（同一个二进制、`app.dock.hide()`、stdio 通信），它会在自己的进程里付这笔冷调用、主进程完全不受影响；代价是常驻多一个 Electron 主进程（内存约 100MB）＋ 打包/公证时多一条启动路径。**结论：一期不做**，因为下面三条缓解已经把用户能感知的冻结基本清零，而根因（ad-hoc 签名）本来就在「买开发者签名」那条路上；如果签名后复测仍然慢，再上助手进程。

一期落地（`src/main/secrets.ts` 是新的唯一入口）：
1. **写前判重用指纹，不用解密**：`HMAC-SHA256(每安装一份随机盐, 明文)` 存在 store 里，比对零 Keychain 触碰。`provisionKeys` 每次启动/登录都会重跑，值没变就一次都不写——**老用户的登录/启动冻结归零**
2. **读也不再乱触发**：`settings:get` 改用「密文在不在」回答 `hasApiKey`；明文有进程内内存缓存，一次进程最多解密一次
3. **首次写入不挡路**：明文先进内存（key 立刻可用），落盘登记成 `kind: 'secret'` 的任务并让出一次事件循环，再做那次同步加密。登录页/设置页因此有明确文案「正在安全保存密钥，首次可能需要较长时间」，TaskDock 上也看得见
4. 启动时的 `provisionKeys`/`probeCloud` 移到 `did-finish-load` 之后：真要冻，也得先把界面画出来

**残留**：一个进程里总还有"第一次真的要用明文"的那一刻——恢复登录会话（`getSession`）、发第一条消息（`resolveForRequest`）、投递箱起 pipeline（`getLlmKey`）——那次解密仍可能是冷调用。区别是：现在**一个进程最多一次**（有内存缓存）、发生在界面已经画出来之后、且都在用户明确发起某个动作的时候；不再有"什么都没干却冻住"的情况。要彻底消灭它，就是上面说的助手进程或开发者签名。

---

## 三、低严重度（12 条）

| # | 现象 | 位置 | 建议 |
|---|---|---|---|
| L-01 | 目录名过长会折行成多行（叶子节点有 truncate，目录节点没有） | [VaultPage.tsx:634](desktop/src/renderer/src/pages/VaultPage.tsx:634) | 加 `truncate` + `title` |
| L-02 | 深层目录缩进无上限，`8 + depth*14`，220px 栏里第 8 层几乎没有可读宽度 | [VaultPage.tsx:637](desktop/src/renderer/src/pages/VaultPage.tsx:637) | 缩进封顶或超深时折叠中间层 |
| L-03 | toast 固定 3.2s、点不掉、堆叠无上限，连点多次会糊满顶部 | [ui.tsx:44](desktop/src/renderer/src/components/ui.tsx:44)–48 | 点击关闭 + 最多 3 条 |
| L-04 | 产物「预览」展开后没有收起入口，只能预览另一篇来换掉 | [Workbench.tsx:435](desktop/src/renderer/src/pages/Workbench.tsx:435) | 按钮改切换态「预览 / 收起」 |
| L-05 | 附件按钮是假控件（点了 toast「即将支持」），且提示语引导了 H-01 的危险动作 | [Workbench.tsx:285](desktop/src/renderer/src/pages/Workbench.tsx:285)–291 | 改 disabled + tooltip，删掉"拖进窗口"的措辞 |
| L-06 | 新建笔记落在"当前打开笔记所在目录"，弹窗里不说落到哪 | [VaultPage.tsx:391](desktop/src/renderer/src/pages/VaultPage.tsx:391)–397 | 弹窗副标题显示目标目录 |
| L-07 | 重命名失败 toast 直接吐 `String(e)`，显示成「Error: 同名笔记已存在」 | [VaultPage.tsx:823](desktop/src/renderer/src/pages/VaultPage.tsx:823) | 取 `e.message` |
| L-08 | 分流规则表单里回车不提交，必须点「添加」 | [App.tsx:356](desktop/src/renderer/src/App.tsx:356)–382 | 两个输入框加 onKeyDown |
| L-09 | 无库时分流卡片是空列表，不说明"需要先打开知识库"，点添加才报错 | [App.tsx:309](desktop/src/renderer/src/App.tsx:309) | 无库时给空态说明并禁用表单 |
| L-10 | 钉钉通知（`settings.setDingtalk` / `dingtalk.test`）在 preload 有通道、store 里默认开启，界面上没有任何入口 | [preload/index.ts:9](desktop/src/preload/index.ts:9)、[store.ts:35](desktop/src/main/store.ts:35) | 补设置卡片或删除通道 |
| L-11 | 快捷键只有 Cmd+N；没有 Cmd+,（设置）、Cmd+K（搜索）、Cmd+W（关笔记） | [main/index.ts:60](desktop/src/main/index.ts:60)–70 | 菜单补几条高频项 |
| L-12 | 复制按钮只有 AI 消息有；用户消息不能复制，也不能编辑重发 | [Workbench.tsx:139](desktop/src/renderer/src/pages/Workbench.tsx:139)–147 | 用户气泡 hover 出「复制 / 编辑重发」 |

另：两处首屏加载画面（恢复会话 / 索引知识库）视觉完全相同（[App.tsx:127](desktop/src/renderer/src/App.tsx:127)–154），大库启动时用户分不清卡在哪一步；建议各给一行文案。

---

## 四、做得好的部分（避免返工时被误改）

- **弹窗体系统一**：全应用只有 `ui.confirm/prompt/toast` 一套，确认弹窗按钮顺序（取消在左、主操作在右）、危险色、遮罩点击关闭都是一致的（[ui.tsx](desktop/src/renderer/src/components/ui.tsx)）。
- **面板可逆性成对**：关系图 / 产物面板 / 投递箱面板关掉后都有明确的重新打开入口（图谱按钮、「产物 N」药丸、投递箱按钮），且状态记忆到 localStorage。
- **输入法安全**：发送与 prompt 都判了 `isComposing`（[Workbench.tsx:297](desktop/src/renderer/src/pages/Workbench.tsx:297)、[ui.tsx:97](desktop/src/renderer/src/components/ui.tsx:97)），中文输入回车不会误发。
- **笔记删除是完整范本**：二次确认带完整路径 + 移入废纸篓 + toast 告知可找回 —— 其他删除操作应向它看齐。
- **长内容与空值已处理**：正文超 60KB 降级到 marked（[VaultPage.tsx:20](desktop/src/renderer/src/pages/VaultPage.tsx:20)）、空正文/空字段/只有表头的表格都有专门渲染（[note-format.ts](desktop/src/renderer/src/lib/note-format.ts)）。
- **降级动效**：`prefers-reduced-motion: reduce` 已覆盖（[index.css:86](desktop/src/renderer/src/styles/index.css:86)）。

---

## 五、建议的修复批次

| 批次 | 内容 | 理由 |
|---|---|---|
| P0（一天内） | H-01、H-02、H-03、H-04、H-05 | 丢数据 / 炸应用 / 回不去，全是一次点击就触发 |
| P1（本轮迭代） | H-06 ~ H-13 + M-01 ~ M-09 | 异步三态与跨页面状态出口，建议与"产物入库反馈断裂"的既定方案合并做一次「全局任务状态层」 |
| P2 | M-10 ~ M-28 | 状态覆盖与一致性，可随各页面改动顺手带上 |
| 挂靠 | ~~M-29（safeStorage 阻塞主进程）~~ ✅ 2026-08-16 随模型 provider 解耦一并做掉（指纹判重 + 只读不解密 + 写入转后台任务） |
| P3 | L-01 ~ L-12 | 打磨 |

> 提醒：以上任何一条落地都属于 GUI 改动，按 `desktop/CLAUDE.md` 的验收铁律，必须 `npm run build && node e2e/walkthrough.mjs` 并逐张看截图后才能交付；新增交互（如取消投递、全局任务条）要往 `walkthrough.mjs` 里加对应步骤。

# desktop 开发规则

## 验收铁律（2026-07-16 起）

**「构建通过」不等于「功能可用」。任何 UI 相关改动，交付前必须跑 GUI 走查并逐张检视截图：**

```bash
npm run build && node e2e/walkthrough.mjs   # 截图在 e2e/shots/，AI 必须 Read 每张截图确认
```

- 走查完全隔离：独立 userData（/tmp/mcnai-e2e-userdata）+ maggie-vault 副本（/tmp/mcnai-e2e-vault），不碰真实数据
- **截图只证明"长这样"，不证明"能用"**：每个可点击的核心控件（新对话/发送/切换/删除…）必须在走查里真点一次并断言结果状态（2026-07-16 ＋新对话失效教训——截图全绿但按钮点了丢对话）
- 新功能必须往 walkthrough.mjs 里加对应步骤（新页面/新交互 = 新截图点）
- **改 `enqueue` / 投递链路（`src/main/inbox/`）：主走查之外必须另跑投递链路验收**

  ```bash
  node e2e/a1-enqueue.mjs   # 自带隔离库，用 Maggie 全量验递归/子路径/落位一致率
  ```

  验四件事：整包拖入递归收全、**相对子路径逐条保留**（落位全靠它——pipeline 用
  `rel.parts[0]/[1]` 推 category/sub_category，拍平就是全部「未分类」）、护栏计数、
  空目录与全不支持格式给明确提示。零 LLM 调用（隔离实例不写打标 key → `--skip-llm`）。
  **不要把这些断言并回 walkthrough.mjs**：enqueue 一写文件就会踢起一轮 pipeline，
  放在主走查中段会把后面按时序写的断言整体推偏（2026-08-18 实测：主走查跑到
  「投递箱进度条」时已经是 `上云 7/7`，紧接着 reload 断言就因任务已结束而失败）
- 引擎层改动跑对应 smoke：`smoke-vault.js <vault>`（索引/图谱/检索）、`smoke:agent`（AI 链路打包冒烟）、
  `smoke:provider`（**改模型/线路必跑**：逐条线路跑单轮/多轮 resume/abort/工具调用/流式/make-ppt，
  并断言服务端实际用的模型就是钉死的那个；需 `SMOKE_INFERERA_KEY` / `SMOKE_DEEPSEEK_KEY` /
  `SMOKE_AIHUBMIX_KEY`，线路以档位形式配置，见 `src/main/ai/tiers.ts`）
- 截图里发现的问题先修完再交付，不许把 GUI 验收留给用户
- **断言不许把"碰巧成立的前提"当成保证**（2026-08-19～21 连栽四次，全是同一个病）：

  | 断言 | 把什么碰巧当成了保证 | 红出来的样子 |
  | --- | --- | --- |
  | 界面版本号 | 界面写死 `v0.1.0`、断言也写死同一个数 | **一直是绿的**，真人装了 0.1.1 才发现 |
  | 附件/资产素材 | 某次会话的 scratchpad 目录还在 | `ENOENT`，像环境坏了 |
  | 取消后进度条中性灰 | 取消时恰好已完成 ≥1 个阶段 | `locator timeout`，像元素丢了 |
  | reload 后任务还在 | 一个文件的入库活得比 reload 久 | 「任务层没扛住刷新」，像产品坏了 |

  三条规矩：
  1. **验"界面的 X = 系统的 X"时，X 必须从另一侧取**，不许在断言里再抄一份常量
  2. **测试素材只许来自仓库**（跟着 git 走），不许指向临时目录或本机私有路径
  3. **时序类断言要把窗口拉宽到必然成立**（投 8 个文件而不是 1 个），
     不许靠 sleep 兜——sleep 只是把赌注换个地方押。
     真有两种合法状态就**两种都断言**（有进度条→验颜色；没有→必须是 done=0），
     不许 try/catch 一裹了事，那会把真回归一起吞掉
- **涉及真实 AI 调用的验收按改动裁剪**：只对本次改动的链路做最小真实调用验证（例如新增一条线路，
  就只验"单轮通不通 / 实际模型有没有被换掉 / 能不能停 / 工具能不能调"），未改动的链路靠本地断言
  与既有基线，不为仪式感跑全量 E2E_CHAT。`smoke:provider` 支持 `SMOKE_ONLY=<线路>` +
  `SMOKE_CASES=single,abort,tools` 精确裁剪；能本地验的（选择器状态、分组、空态、jsonl 读取链路）
  一律用桩数据本地验，别拿 token 换确定性

## 测试账号登录的前置条件（2026-08-18 核实）

自己起环境测「登录 / 上云 / 云端检索」时照这个清单核对，**别把环境问题当成产品故障**。

- **不需要本地 webpage dev server**。登录直连 Supabase
  （`https://yqozqfrmdddmfrpavrsn.supabase.co`），key 下发打的是 `store.apiBaseUrl`，
  出厂值就是生产 `https://www.makeupai.top`。（`e2e/login-provision.mjs` 的文件头
  原来写着「前置：dev server 在 localhost:3000」，**那句是错的**，已更正——
  代码里从来没有把 apiBaseUrl 指到本地的动作。）
- **Supabase 免费版闲置 7 天会自动暂停**，暂停后域名直接 NXDOMAIN，应用报的是
  **网络问题**而不是密码错（见 HANDOFF §3 bug#2）。先自查：

  ```bash
  curl -sI --max-time 8 https://yqozqfrmdddmfrpavrsn.supabase.co | head -1
  ```

  能回 HTTP 状态行就是醒着的（根路径 404 属正常）。不通就去 Dashboard → Restore project，
  域名先回、服务后起，全程 5–15 分钟，中途 Cloudflare 521 属正常。
- **别开错实例**。`/tmp/mcnai-e2e-offline` 那份 userData 的 `apiBaseUrl` 是
  `http://127.0.0.1:9`——那是离线降级走查**故意**配的黑洞地址，用它登录必然报网络不可达。
  确认当前实例打到哪：

  ```bash
  python3 -c "import json;print(json.load(open('/Users/\$USER/Library/Application Support/mcn-ai-desktop/config.json')).get('apiBaseUrl'))"
  ```

- 登录成败在主日志里有痕：成功会落一条 `[secrets] encryptedSession 已加密落盘`，
  失败分类（`network` / `credential` / `timeout`）也各有对应文案。日志在
  `~/Library/Application Support/mcn-ai-desktop/logs/main.log`

## 常用命令

- 开发：`npm run dev`　类型检查：`npm run typecheck`　打包：`npm run dist`
- pipeline 冻结（在 pkb-pipeline 仓库）：pyinstaller 命令见 git log；产物拷入 `resources/pipeline/`

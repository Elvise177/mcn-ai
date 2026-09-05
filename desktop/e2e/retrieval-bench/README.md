# 检索准确率基准（retrieval-bench）

后续所有检索优化的尺子：先有数字，再谈"提高"。基线数字与结论在 `docs/RETRIEVAL-BENCH.md`。

## 文件

| 文件 | 作用 |
|---|---|
| `bench.jsonl` | 45 道题（40 正题 + 5 陷阱），每行一题，字段见下 |
| `../../scripts/retrieval-bench.mjs` | 编排 + 汇总：建库副本 → 起无头执行端 → 判分 → 出表（`npm run bench:retrieval`） |
| `../../src/main/retrieval-bench.ts` | 执行端：跑在 Electron 主进程里，用**产品自己的对话链路**（`agentManager.send`）逐题作答；构建入口 `out/main/retrieval-bench.js`，与 `smoke-*` 同类，不被应用引用 |
| `runs/<时间戳>/` | 每次运行的产物（gitignored）：`job.json` / `results.jsonl` / `results.meta.json` / `summary.md`（含逐题判分理由）/ `summary.json` |

## 题目字段

```json
{"id":"M-K1","type":"keyword","vault":"maggie","question":"…","gold_points":["…"],"expected_files":["相对库根的路径.md"],"sensitive":true,"notes":"…"}
```

- `type`：`keyword` 关键词题 / `semantic` 语义题（问题用词不在文档里）/ `multi` 跨文档汇总题（答案要 ≥3 份文档拼）/ `sensitive` 敏感区题（答案在 `sensitive: true` 的文件里，只能走本地检索）/ `trap` 陷阱题（库里没有，正确行为是敢说没有）
- `vault`：`maggie`（源 `~/Documents/AI/maggie-vault`）或 `jerry`（源 `~/Downloads/我的知识库`）。运行时各复制一份到 `/tmp/mcnai-bench-{maggie,jerry}`（排除 `.git` / `_assets` / `.obsidian`），原库零写入
- `gold_points`：2-4 条事实要点，**由人读原文档写**，不许模型生成；不含个人字段（姓名/身份证/联系方式/个人薪资）
- `expected_files`：应命中的 1-5 个文件，运行前会逐个检查在库里存在，写错路径直接报错不跑
- `sensitive`：题型不是 `sensitive` 但答案文件带敏感标记时标出来（如 J-S3 报销制度在 Jerry 库里是敏感文件）

题目怎么来的：Maggie 库取她的课程、作业评改、孵化方案、资源包 SOP 等真实文档；Jerry 库取复盘、目标、年框结案、职能制度等真实文档。
**Maggie 复刻库（`/tmp/mcnai-qa-vault`）已清**，用 `~/Documents/AI/maggie-vault`（同一批源数据、完整派生层）替代；Jerry 预检库也已清，按单子用 `Downloads/我的知识库`。

## 判分口径（客户问"准确率怎么来的"时按这个解释）

| 指标 | 定义 | 数据来自哪 |
|---|---|---|
| 召回命中率 | 应命中文件里**被摆到模型面前**的比例，按题平均。"摆到面前" = `search_knowledge` 返回给模型的前 6 条 ∪ `Read` 打开过的文件 | 执行端把每一步 `search_knowledge` 的检索词**重放** `vaultManager.search()`（确定性），加上步骤流里 Read 的入参——与产品 B-6 引用校验的 `surfaced` 同口径 |
| 全命中率 | 应命中文件**全部**被摆到面前的题占比 | 同上 |
| 读到率 | 应命中文件真的被 Read 的比例（比"命中"更强：命中只说明标题在列表里） | 步骤流 |
| 要点覆盖率 | 每条要点 covered=1 / partial=0.5 / missing=0，按题平均。判分模型 = 标准档同一线路（deepseek-v4-pro），temperature 0，`max_tokens` 8000（它先吐推理块，给少了正文为空），每条附**理由 + 从回答里逐字摘的证据** | `results.jsonl` 的 `judge.points`；人工复核看 `summary.md` 明细 |
| 核心要点覆盖率 | 只算每题**前 2 条**要点。要点按"问题直接问的 → 顺带该讲的"排序，前 2 条就是问题本身的答案；全量覆盖率把"答对了但没多讲"和"答错"混在一起，这一列拆开 | 同上 |
| 引用正确率 | 回答里 `[[…]]` 能解析到库内文件的引用中，落在应命中集合内的比例（各题合并统计）；另报"解析不到的引用数" | `vaultManager.resolveLink`（与产品校验引用同一函数） |
| 中位/P90 耗时 | `agentManager.send` 的墙钟 | 执行端计时 |
| 陷阱题拒答率 | 判分认为"明确说了库里没有/未找到"且"没有编造具体事实"的比例 | `judge.refusal` |
| 实花 | 隔离 userData 的账本增量，用产品自己的 `tokensOf` + `costCny` 计价（与用量页同口径） | `usage/YYYY-MM.jsonl` |

判分的局限要说清：判分模型是同一档的 deepseek-v4-pro，它判"要点是否出现"很稳（对着原文逐字比），
但 `fabricated`（是否编造）对正题偏敏感——正题回答里多说一句库里真有的事实也会被标 true，所以
**编造标记只用于陷阱题**，正题只看要点与引用。所有理由与证据都落盘，可人工复核。

## 怎么跑

```bash
cd desktop
npm run bench:retrieval -- --dry-run            # 报题数与预算，不花钱
npm run bench:retrieval                          # 全量（实测 ≈¥12：对话 ¥10 + 判分 ¥2；约 65 分钟；跑前会打印估算）
npm run bench:retrieval -- --only M-K1,T-1       # 调试几题
npm run bench:retrieval -- --type sensitive      # 只跑一类
npm run bench:retrieval -- --from e2e/retrieval-bench/runs/<ts>/results.jsonl   # 只重汇总
npm run bench:retrieval -- --rejudge e2e/retrieval-bench/runs/<ts>/results.jsonl  # 同一份回答重判
npm run bench:retrieval -- --rejudge <results.jsonl> --rejudge-failed              # 只补判上次判分失败的题
```

key：默认用测试账号登录（服务端按契约 v2 下发标准档，与客户机同一条路；Supabase 得醒着，见 `desktop/CLAUDE.md`）；
或 `BENCH_API_KEY=… BENCH_BASE_URL=https://api.deepseek.com/anthropic` 直接注入（只进内存）。

## 改题的规矩

- 要点必须能在 `expected_files` 里逐字找到依据；写完用 grep 核一遍
- 不许把题改得迎合当前实现（比如把语义题的问法改成文档原词）——尺子改了，前后数字就不能比
- 加题就加，别删旧题：删题等于换尺子。真要淘汰一题，在 `notes` 里写原因并保留在文件里（加 `"retired": true`）

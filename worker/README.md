# 剪辑 Worker（国内服务器部署）

自动剪辑的执行端：轮询 Supabase 的 `edit_jobs` 队列，用 LLM 生成剪辑决策，调
[VectCutAPI](https://github.com/sun-guannan/VectCutAPI) 生成**剪映草稿**，剪辑师在剪映中打开微调后导出。

```
Vercel(创建任务) → Supabase edit_jobs 队列 → 本 worker(国内服务器)
                                              ├─ LLM 剪辑决策（AIHubMix）
                                              ├─ VectCutAPI 生成剪映草稿
                                              └─ 回写 draft_url / 状态
```

## 部署步骤（一台 2C4G 国内云服务器即可起步）

### 1. 部署 VectCutAPI

```bash
git clone https://github.com/sun-guannan/VectCutAPI.git
cd VectCutAPI
# 按其 README 安装依赖并启动（默认 HTTP 端口 9001）
```

### 2. 启动 worker

```bash
cd worker
cp .env.example .env   # 填入 Supabase / AIHubMix 密钥
npm install
npm start
```

建议用 pm2 守护：

```bash
npm i -g pm2
pm2 start index.mjs --name edit-worker
pm2 save
```

### 3. 数据库前置

确保已在 Supabase 执行 `supabase/migrations/009_auto_editing.sql`
（edit_jobs / editing_templates / claim_next_edit_job）。

## 首次联调清单

1. **核对 VectCutAPI 端点**：`index.mjs` 中 `buildDraft()` 使用
   `/create_draft` `/add_video` `/add_subtitle` `/save_draft`，
   以你部署版本的实际 API 文档为准调整字段名。
2. **验证剪映版本兼容**：用团队真实使用的剪映版本打开生成的草稿。
   剪映 6.x 起草稿格式加密，若打不开，锁定团队剪映版本或改用 CapCut。
3. **play_url 时效**：抖音播放地址带签名会过期。导入后尽快创建剪辑任务；
   过期报 403 时让用户重新导入刷新地址（后续可加素材转存到对象存储）。

## 兜底方案（FFmpeg 粗剪）

若剪映草稿兼容性被版本卡死，保留同一份 `cut_plan`，把 `buildDraft()`
替换为 FFmpeg 拼接：按 segments 切片合并、烧字幕或导出 SRT，产出 mp4
供剪辑师导入剪映精修。剪辑决策层不变，只换执行层。

## 多机扩容

`claim_next_edit_job` 用 `FOR UPDATE SKIP LOCKED` 原子认领，
多台 worker 直接复制部署、改 `WORKER_ID` 即可，不会抢到同一任务。

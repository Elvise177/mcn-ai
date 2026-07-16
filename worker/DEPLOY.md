# 自动剪辑（第三步）完整部署指南

剪映草稿路线，素材来源 = **公司达人原片（阿里云 OSS）**：

```
达人/运营上传原片 → 阿里云 OSS（按达人/日期分桶，私有读写）
   → 网站发起剪辑任务（选 OSS 原片 + 要求/模板）
   → 国内 ECS 上的 worker（与 OSS 同地域，内网拉取免流量）
       ① OSS 签名 URL
       ② 可选 AssemblyAI 转写口播（拉签名 URL）
       ③ LLM 出剪辑决策 JSON
       ④ VectCutAPI add_video(签名URL)+字幕 → save_draft（dfd_ 文件夹）
       ⑤ 打包 zip 传回 OSS → 写 draft_url
   → 剪辑师下载草稿 → 剪映打开 → 全画质导出（不重编码，无损）
```

> 注意：抖音导入/转写那套是给"爆款分析 + RAG 知识库"用的，素材来源是抖音 play_url；
> 自动剪辑处理的是**自己达人的原片（OSS）**，两套素材不要混。

## 画质说明

全程**零画质损失**：worker 只生成剪映工程文件、不渲染；最终由剪辑师在剪映导出，
画质 = 原片画质 = 剪映导出设置。OSS 签名 URL 直传，不二次压缩。

## 阿里云 OSS 配置

1. 开通 OSS，建 Bucket，地域**与 worker 服务器同地域**（如华东1·杭州）→ 内网拉取免流量费
2. 存储类型标准存储；权限私有（用签名 URL 访问）
3. 建 RAM 子账号，授该 Bucket 读写，拿 AccessKeyId/Secret（**仅 worker 用，不进前端**）
4. 达人/运营按 `达人名/日期/原片.mp4` 上传（控制台 / ossutil / OSS Browser）

OSS 成本：标准存储 ~¥0.12/GB/月（100GB≈¥12/月）；同地域内网流量免费；
外网下行 ~¥0.5/GB（草稿很小，原片不外发就便宜）。整体每月几十块。

---

## 0. 先做"生死验证"（投钱买服务器之前，1 小时）

整条路线唯一的硬风险：**VectCutAPI 生成的草稿，你们团队那个版本的剪映打不打得开**。
剪映 6.x 起草稿加密，VectCutAPI 用 `config.json` 的 `draft_profile` 控制导出格式，
可选 `capcut_legacy` / `jianying_legacy` / `jianying_pro_10`。

**先在任意一台机器（甚至本地 Mac）验证：**
1. 装好 VectCutAPI（见第 3 节），`config.json` 里 `draft_profile` 先试 `jianying_pro_10`
2. 用它的示例生成一个最简单草稿（一段视频 + 一句字幕）
3. 把生成的 `dfd_xxx` 文件夹拷到剪映草稿目录，用**剪辑师实际在用的剪映版本**打开
4. 打得开 → 继续整套部署；打不开 → 换 profile 再试；都不行 → 走第 8 节 FFmpeg 兜底

> 草稿目录参考（剪映）：
> - Windows：`C:\Users\<用户>\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft`
> - macOS：`~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft`

---

## 1. 服务器配置

| 项 | 最低 | 推荐 | 说明 |
|---|---|---|---|
| CPU/内存 | 2核4G | **4核8G** | 视频解码/合成吃 CPU 和内存 |
| 磁盘 | 50G SSD | **100G SSD** | 视频素材 + 草稿临时文件占空间 |
| 带宽 | 5Mbps | 10Mbps 或按量 | 要从抖音 CDN 下载素材 |
| 系统 | — | **Ubuntu 22.04 LTS** | ffmpeg / Python 生态最顺 |
| 地域 | — | 国内任意（如华东） | 下抖音素材快，连 AIHubMix 也快 |

**为什么放国内**：抖音 `play_url` 素材在国内下载快且稳；VectCutAPI 是自托管服务，本就该和 worker 同机。

---

## 2. 成本估算（人民币/月）

| 项目 | 测试期（按量） | 稳定期（包月） |
|---|---|---|
| 云服务器 4核8G | 阿里云/腾讯云 ECS 按量 ~¥1.2-2/小时，用完即停 | 轻量应用服务器 4核8G ~¥120-200/月 |
| 磁盘 100G SSD | 含在按量里 | ~¥30-50/月 |
| 带宽 | 按流量 ~¥0.8/GB（下素材，每条视频几十 MB） | 固定 10Mbps ~¥80-150/月 |
| LLM 剪辑决策 | 每条任务一次 claude-sonnet 调用，约 ¥0.05-0.2/条 | 同左，按量 |
| 口播转写 | AssemblyAI，已在用，约 $0.1-0.4/视频 | 同左 |

**结论**：
- **测试期**：买按量付费 4核8G，跑几天验证，**实际花费可能就几十块**，验证完就释放。
- **稳定期**：一台轻量 4核8G 大约 **¥200-350/月**全包（含带宽），能扛日常批量剪辑。
- 大头其实不是服务器，是 LLM + 转写的按量费用，但单条成本很低。

---

## 3. 部署 VectCutAPI

```bash
# 基础环境
sudo apt update && sudo apt install -y ffmpeg git python3-venv python3-pip

# 拉代码
git clone https://github.com/sun-guannan/VectCutAPI.git
cd VectCutAPI

# 虚拟环境 + 依赖（要求 Python 3.10+）
python3 -m venv venv-capcut
source venv-capcut/bin/activate
pip install -r requirements.txt

# 配置
cp config.json.example config.json
#  编辑 config.json，把 draft_profile 设为剪映对应格式：
#    "draft_profile": "jianying_pro_10"   # 新版剪映；打不开就试 jianying_legacy

# 启动 HTTP 服务（默认端口 9001）
python capcut_server.py
```

真实 HTTP 端点（已核对官方文档）：
- `POST /add_video` — 参数 `video_url, start, end, volume, transition`
- `POST /add_text` — 文字 `text, start, end, font, font_color, font_size, ...`
- `POST /add_subtitle` — 导入 SRT 字幕
- `POST /save_draft` — 生成草稿，产物是服务器目录下 `dfd_` 开头的**文件夹**（不是 URL）
- 另有 `create_draft`(width,height) / `add_audio` / `add_image` / `add_video_keyframe` / `get_video_duration`

> 注意：`save_draft` 产出的是本地草稿文件夹，需要送到剪辑师机器的剪映草稿目录。见第 6 节。

---

## 4. 数据库前置（已完成）

`supabase/migrations/009_auto_editing.sql` 已在 Supabase 执行：
`edit_jobs` / `editing_templates` / `claim_next_edit_job`。无需再做。

---

## 5. 部署 worker

把项目的 `worker/` 目录传到服务器（scp 或 git）。

```bash
# 装 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

cd worker
cp .env.example .env
vim .env
#   SUPABASE_URL=...                  （Supabase 项目 URL）
#   SUPABASE_SERVICE_ROLE_KEY=...     （service role 密钥）
#   AIHUBMIX_API_KEY=...
#   CUT_PLAN_MODEL=claude-sonnet-4-6
#   VECTCUT_BASE_URL=http://127.0.0.1:9001
#   WORKER_ID=worker-1
npm install

# pm2 守护（VectCutAPI 和 worker 都托管）
sudo npm i -g pm2
pm2 start "venv-capcut/bin/python capcut_server.py" --name vectcut --cwd ~/VectCutAPI
pm2 start index.mjs --name edit-worker --cwd ~/worker
pm2 save && pm2 startup   # 开机自启
```

---

## 6. 草稿如何到剪辑师手里（关键运维点）

`save_draft` 在服务器生成 `dfd_xxx` 文件夹，剪映要在**剪辑师本机**打开。三种做法：

1. **最简单**：worker 把 `dfd_xxx` 打包 zip，上传到对象存储（阿里云 OSS），把下载链接写进 `edit_jobs.draft_url`；剪辑师下载解压到剪映草稿目录。
2. **网盘同步**：服务器草稿目录挂到团队网盘，剪辑师本地同步。
3. **VectCutAPI 云预览**：它支持网页实时预览，可先看效果再决定是否下载。

> 当前 `worker/index.mjs` 是脚手架：素材取自抖音 play_url、`buildDraft()` 期望拿到 URL。
> 接入真实流程时要改成：① 从 OSS 签名 URL 取原片喂给 `add_video`；
> ② `save_draft` 产出的 `dfd_` 文件夹打包 zip 传回 OSS，再回写 `draft_url`。
> `edit_jobs` 也要加"OSS 素材来源"字段（替代 imported_video_id）。
> 这些等你服务器 + OSS 就绪、确认草稿能在剪映打开后，我一次性接通。

---

## 7. 联调验证顺序

1. `pm2 logs vectcut` 确认 9001 起来
2. 单测 VectCutAPI 生成草稿 → 剪映打开（即第 0 节验证）
3. 核对 `worker/index.mjs` `buildDraft()` 端点/字段与官方一致
4. 前端 `/edit-jobs` 或导入页发起一个任务 → `pm2 logs edit-worker` 看流转
   （状态：pending → analyzing → drafting → done）
5. 取 `draft_url`，剪辑师打开草稿验收

---

## 8. 兜底方案（剪映打不开草稿时）

保留同一份 `cut_plan`（LLM 已生成的剪辑决策 JSON），把 `buildDraft()` 换成 FFmpeg：
按 segments 切片合并 + 烧字幕，输出 mp4 + SRT，剪辑师导入剪映精修。
**剪辑决策层不变，只换执行层**，改动很小。

---

## 9. 多机扩容

`claim_next_edit_job` 用 `FOR UPDATE SKIP LOCKED` 原子认领，
多台 worker 复制部署、各改 `WORKER_ID` 即可，不会抢到同一任务。

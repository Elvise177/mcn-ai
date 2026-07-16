# 本地验证手册（macOS）：剪映能否打开 VectCutAPI 草稿

目的：**不花钱、不买服务器**，在你的 Mac 上验证整条剪辑路线唯一的硬风险——
你们团队用的剪映版本，能不能打开 VectCutAPI 生成的草稿。
能打开 → 整套路线可行；打不开 → 改走 FFmpeg 兜底。

预计耗时 30–60 分钟。

---

## 第 1 步：装前置依赖

打开"终端"(Terminal)，逐条执行：

```bash
# 1) 确认有 Homebrew（没有就先装）
brew --version || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2) 装 ffmpeg、git、python（VectCutAPI 要 Python 3.10+）
brew install ffmpeg git python@3.11

# 3) 确认 python 版本 ≥ 3.10
python3 --version
```

---

## 第 2 步：下载并启动 VectCutAPI

```bash
# 放桌面方便找
cd ~/Desktop
git clone https://github.com/sun-guannan/VectCutAPI.git
cd VectCutAPI

# 建虚拟环境 + 装依赖
python3 -m venv venv-capcut
source venv-capcut/bin/activate
pip install -r requirements.txt

# 配置：复制示例配置，并设置剪映草稿格式
cp config.json.example config.json
```

用任意编辑器打开 `config.json`，把草稿格式设为剪映新版：
```json
"draft_profile": "jianying_pro_10"
```
（打不开时再回来换 `jianying_legacy` 重试。）

启动服务（保持这个终端窗口开着）：
```bash
python capcut_server.py
```
看到监听 **9001** 端口就成功了。**不要关这个窗口**。

---

## 第 3 步：找到剪映草稿目录

**新开一个终端窗口**，先确认剪映把草稿存在哪：

```bash
# 国内剪映（剪映专业版 JianyingPro）
ls "$HOME/Movies/JianyingPro/User Data/Projects/com.lveditor.draft" 2>/dev/null && echo "↑ 这是剪映草稿目录"

# 若上面没输出，再试 CapCut（国际版）
ls "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft" 2>/dev/null && echo "↑ 这是 CapCut 草稿目录"

# 都没有就全盘搜（稍慢）
find "$HOME" -type d -name "com.lveditor.draft" 2>/dev/null
```

把能列出内容的那个路径记下来，下一步要用。下面假设是剪映专业版的路径。

---

## 第 4 步：一键生成测试草稿

在第二个终端里，把下面整段**改两个地方后**粘贴执行：
- `DRAFT_FOLDER`：换成第 3 步你记下的真实路径
- `VIDEO_URL`：换成一个能访问的 mp4（先用示例验证流程，之后可换达人原片/OSS 链接）

```bash
# ===== 改这两行 =====
DRAFT_FOLDER="$HOME/Movies/JianyingPro/User Data/Projects/com.lveditor.draft"
VIDEO_URL="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4"
# ===================

BASE=http://localhost:9001

# 1) 添加一段视频（不带 draft_id = 新建草稿），取回 draft_id
DRAFT_ID=$(curl -s -X POST "$BASE/add_video" \
  -H "Content-Type: application/json" \
  -d "{\"video_url\":\"$VIDEO_URL\",\"start\":0,\"end\":5,\"width\":1080,\"height\":1920}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['output']['draft_id'])")
echo "draft_id = $DRAFT_ID"

# 2) 加一句字幕（验证多轨）
curl -s -X POST "$BASE/add_subtitle" \
  -H "Content-Type: application/json" \
  -d "{\"draft_id\":\"$DRAFT_ID\",\"srt\":\"1\n00:00:00,000 --> 00:00:04,000\n这是自动剪辑测试字幕\",\"font_size\":8,\"font_color\":\"#FFFFFF\",\"track_name\":\"subtitle\"}" \
  > /dev/null && echo "字幕已加"

# 3) 保存草稿到剪映目录
curl -s -X POST "$BASE/save_draft" \
  -H "Content-Type: application/json" \
  -d "{\"draft_id\":\"$DRAFT_ID\",\"draft_folder\":\"$DRAFT_FOLDER\"}"
echo
echo "完成。draft_id=$DRAFT_ID"
```

> 说明：第 1 个 `/add_video` 不传 `draft_id` 就会新建草稿并返回 id；
> 后续调用都带这个 id；`save_draft` 把草稿写进 `draft_folder`。
> 若 `save_draft` 返回的是 `task_id`/`processing`，等几秒即可（它在后台落盘）。

---

---

## 方式 B（可选，更省事）：用 vectcut-skill 在 Claude Code 里驱动

如果你不想敲第 4 步的 curl，可以装官方的 Claude Code 技能，用自然语言生成草稿。
**前提**：第 1、2 步已完成、`capcut_server.py` 正在 9001 端口运行（skill 底层还是调它）。

### B-1 安装技能
```bash
# 建目标目录
mkdir -p ~/.claude/skills/public/vectcut-api

# 把仓库里的 skill 拷过去（路径按你 clone 的位置）
cp -r ~/Desktop/VectCutAPI/vectcut-skill/skill/* ~/.claude/skills/public/vectcut-api/

# 确认拷进去了
ls ~/.claude/skills/public/vectcut-api/
```

### B-2 重启 Claude Code
完全退出 Claude Code 再打开（让它加载新技能）。

### B-3 用自然语言生成草稿
在 Claude Code 里直接说（把视频地址和剪映目录换成你的）：
```
用 vectcut-api 技能创建一个 1080x1920 的剪映草稿：
视频用 https://……/test.mp4 的 0-5 秒，
加一句字幕"自动剪辑测试"，
保存到 ~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft
```
它会自动调 VectCutAPI 的接口生成草稿。

> 说明：方式 B 只是把第 4 步的 HTTP 调用换成自然语言驱动，**结果完全一样**——
> 都是让本地的 VectCutAPI 生成剪映草稿。验证的还是同一件事：剪映能不能打开。
> 我们正式的 worker 仍走 HTTP（方式 A 那套接口），skill 只是给你手动试玩/参考用。

技能自带 8+ 套工作流示例（文字转视频、多片混剪、字幕、关键帧、产品展示等），
之后我写 worker 的剪辑逻辑时也会参考它们。

---

## 第 5 步：在剪映里打开验证

1. **完全退出剪映再重新打开**（让它重新扫描草稿目录）
2. 在"草稿/我的草稿"列表里找最新的一个草稿，点开
3. 检查：
   - 能正常打开、不报错 ✅
   - 时间轴上有那段视频 + 那句字幕 ✅
   - 能正常预览播放 ✅

---

## 第 6 步：判定结果

| 现象 | 结论 | 下一步 |
|---|---|---|
| 草稿正常打开、轨道字幕都在 | ✅ 路线可行 | 开 ECS + 阿里云 OSS，告诉我，我接通正式流程 |
| 剪映报错/打不开/闪退 | 草稿格式不兼容 | 回第 2 步把 `draft_profile` 换成 `jianying_legacy` 重跑第 4 步再试 |
| 换了 profile 还是打不开 | 你们剪映版本加密较强 | 告诉我，直接切 FFmpeg 兜底方案（剪辑决策层不变） |

---

## 常见问题

- **`pip install` 报错**：多半是缺编译工具，先 `xcode-select --install`，再重试。
- **`add_video` 返回报错而不是 draft_id**：八成是 `VIDEO_URL` 不可访问（网络/被墙）。换一个能直接下载的 mp4，或用本地起的 http 服务。
- **剪映里看不到新草稿**：确认 `DRAFT_FOLDER` 路径对、且**重启了剪映**；或 `save_draft` 还在后台落盘，等几秒再看。
- **`draft_profile` 该填哪个**：剪映专业版近两年版本先试 `jianying_pro_10`，旧版用 `jianying_legacy`，国际版 CapCut 用 `capcut_legacy`。

验证完把结果（能开 / 报什么错）告诉我，我据此决定下一步。

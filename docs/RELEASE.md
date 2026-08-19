# 发版指引（第一个正式签名版）

> 建立：2026-08-19 ｜ 配套：`docs/RELEASE-CHECK.md`（发版前自测报告与定稿状态）
> 适用：Apple Developer 签名 + 公证之后的第一个正式版

---

## 0. 发版后第一优先动作：把大头（Maggie）升级到含 A-8 修复的版本

**这条排在所有事情前面，不是待办清单里的一项。**

### 为什么是第一优先

她那台机器上**当前跑的构建是 A-8 修复之前的版本**。A-8 的洞是：
`cloudSync` 判"这篇是不是敏感"时只读文件前 800 字符，而 A-3 之后 frontmatter 会带
`entities_talent` 这类长数组，把最后写的 `sensitive: true` 顶出窗口 → 敏感文件照常上云
（详见 `RELEASE-CHECK.md` R-01）。

后果是**会重新发生**的：

> **她本地只要再触发一次全量同步（重新入库、批量改写笔记、换库重扫），
> 那几个敏感文件就会被重新推上云。** 2026-08-19 刚清掉的 398 条切片会重新长回来。

也就是说，云端清理**不是一次性的事**——不升级，清了还会再脏。
升级到含 A-8 的版本之后，那些文件在她机器上就不会再被推上去，清理才真正生效。

### 怎么做

1. 把签名版装到她机器（覆盖安装，userData 不动——见 `RELEASE-CHECK.md` §2.2 的升级路径验收：
   配置无损、会话历史在、库路径在、两把 key 都在、不要求重新登录）
2. 装完**确认版本号**，并在设置页管理员区确认标准档 baseUrl（见下面第 1 条）
3. 升级完成之前，**告诉她先别做批量重新入库**——那正是会把敏感文件重新推上云的动作

### 顺带一起做（同一次上门/远程）

- **把她的标准档从中转站切回官方直连**：她那台被 `migrateTiers` 指在
  `https://api.inferera.com`，成本是官方直连的 **2.7 倍**。升级本身修不了它
  （`tierMigrated=true` 会正确地阻止二次迁移，这是对的），要在
  **设置页 → 版本号连点 7 次 → 管理员区**把标准档 baseUrl 改成
  `https://api.deepseek.com/anthropic`。见 `RELEASE-CHECK.md` R-10
- 升级后让她跑一次入库，确认 MOC 不再带敏感篇摘要（R-03 的修复随冻结产物一起发）

---

## 1. 装机前的检查

- **Supabase 未被暂停**：免费版闲置 7 天自动暂停，暂停后域名 NXDOMAIN。
  `curl -sI --max-time 8 https://yqozqfrmdddmfrpavrsn.supabase.co | head -1`
  能回状态行就是醒着的（根路径 404 属正常）
- **aihubmix 余额**：这把 key 同时供着网页版的向量与聊天，打穿 = 桌面版 + 网页版一起挂，
  而第一个感知渠道是客户报障（HANDOFF §3-6）。发版前查一次
- **老 macOS 兼容**：本轮全部验证跑在本机 arm64 上。发给系统更旧的客户机之前，
  用 yara 做一次 XProtect 预检（HANDOFF §4-2）

## 2. 已知的名字不一致（记账，不阻断）

`productName` 维持 `mcn-ai`（2026-08-19 拍板，见 HANDOFF §4-27）。所以：

| 用户看到的地方 | 显示 |
|---|---|
| 界面（侧栏 / 登录页 / 窗口标题 / 菜单项文案） | **SamePage** |
| Finder / 应用程序文件夹 / Dock / dmg 文件名 | **mcn-ai** |

客户装完之后 Dock 上是 `mcn-ai`、点开界面写 SamePage。**装机时主动说一句**，
免得客户以为装错了。真正的内部改名等"天然要求重登"的时机搭车（当前最可能是网关切换那一单）。

## 3. 发版后队列（不挡这一版）

按 `RELEASE-CHECK.md` §3 的编号：

| # | 内容 |
|---|---|
| R-05 | 离线条不会自己下去（`probeCloud` 无周期重探） |
| R-09 | 生成产物那一轮的折叠摘要说「未找到相关资料」，旁边却摆着刚生成的文档 |
| R-08 | 产物渲染的临时 spec JSON 不清理 |
| R-11 | 建库引导整屏没有品牌标识 |
| R-12 | 空库时 chips 仍写「检索我的库」 |

---

# 发版手册

> 这一段是**照着能做完**的操作手册，不是背景说明。每次发版从 §B 第 1 步走到最后一步。
> §A 是一次性的（换机器 / 证书到期才需要重做）。

## A. 一次性准备（证书与公证凭据）

做完一次就不用再做，除非换电脑或证书过期（Developer ID Application 证书有效期 5 年）。

### A.1 Developer ID Application 证书

> **先破一个常见误解**：本机系统 / iCloud 登的是哪个 Apple ID **完全不影响**这件事。
> 下面第 1 步（生成 CSR）不做任何身份认证——它只是拿本机新生成的一对密钥包一个请求文件，
> 里面的「用户电子邮件」是**纯备注**，Apple 签发时会丢掉它、按团队信息重写证书主体名。
> 私钥落在「登录」钥匙串里，绑的是**这个 macOS 用户**，与任何 Apple ID 无关。
> **真正要用开发者 Apple ID 的只有一处：浏览器里登 developer.apple.com**（以及 §A.2 的
> appstoreconnect.apple.com）——证书签给的是"你登进去那个账号所属的团队"。
> 不需要切系统 Apple ID、不需要退 iCloud、不需要装 Xcode 或在 Xcode 里登账号。

1. 本机生成 CSR（证书签名请求）。

   > **macOS 15 起「钥匙串访问」不在「实用工具」里了**，启动台翻不到、Spotlight 也不一定索引得到。
   > 直接开：
   > ```bash
   > open "/System/Library/CoreServices/Applications/Keychain Access.app"
   > ```

   - **「证书助理」在屏幕最顶上那条系统菜单栏里**，不在窗口内：
      苹果标志右边第一个菜单「**钥匙串访问**」→「**证书助理**」→「**从证书颁发机构请求证书…**」
     （不在「文件」菜单里——这是最容易卡住的一步）
   - 用户电子邮件地址：填哪个都行（只是备注）；常用名称：`SamePage Dev ID`
   - **CA 电子邮件地址留空**（填了会走"邮件发送"分支）
   - 选「**存储到磁盘**」+ 勾「**让我指定密钥对信息**」→ 继续 → **2048 位 / RSA** → 继续
   - 存成 `CertificateSigningRequest.certSigningRequest`
2. developer.apple.com（**开发者 Apple ID** 登录）→ 右上角 Account →
   左侧 **Certificates, Identifiers & Profiles** → 确认左栏选中 Certificates → 点标题旁的蓝色 `+`
3. 单选列表拉到 **Software** 那一组，选 **Developer ID Application**
   （**不是** `Developer ID Installer`，**不是** `Apple Development` / `Apple Distribution`）；
   问 Profile Type 就选默认的 **G2 Sub-CA (Xcode 11 or later)**
4. Choose File 上传那个 `.certSigningRequest` → Continue → **Download** 拿到 `developerID_application.cer`
5. **双击 .cer 装进钥匙串**（装到"登录"钥匙串）

   > ⚠️ Developer ID Application 证书**一个账号最多 5 张**，且不像开发证书那样能随手撤销重建。
   > 别连点几次生成一堆。

6. 验证——这一行必须能看到 `Developer ID Application: <你的名字> (TEAMID)`：

   ```bash
   security find-identity -v -p codesigning
   ```

> **别用「Xcode 自动管理」那条路**：它给的是 Development 证书，签出来的包只能在本机跑，
> 公证会直接拒。要的是 Developer ID Application 这一种。

### A.2 App Store Connect API Key（公证用）

用 API Key 而不是「App 专用密码」：密钥能单独吊销、不绑 Apple ID 的双因素、也不会
把 Apple ID 密码写进任何脚本。

1. **appstoreconnect.apple.com**（同样用开发者 Apple ID）→ **用户和访问 / Users and Access**
   → 顶部标签 **集成 / Integrations**（不是 People、不是 Sandbox）
   → 左栏 Keys 下的 **App Store Connect API** → 子标签选 **Team Keys**
   （第一次进要先同意一份条款）
2. `+` 新建密钥，名字如 `notary`，**Access 选 `Developer`**（公证需要，`App Manager` 也行）
3. 生成后（三样都要，缺一不可）：
   - 那一行最右边 **Download** 拿 `AuthKey_XXXXXXXXXX.p8` —— **只能下载一次**，关掉页面就没了
   - **KEY ID** = 那一行里的 10 位串（也在文件名里）
   - **Issuer ID** 在**表格上方**，是一串 UUID，形如 `69a6de7e-…`（不在那一行里，容易找错）
4. 放进 notarytool 会去找的标准位置（放别处也行，但下面的环境变量要跟着改）：

   ```bash
   mkdir -p ~/.appstoreconnect/private_keys && mv ~/Downloads/AuthKey_*.p8 ~/.appstoreconnect/private_keys/
   ```

5. **不要提交进仓库**。`.p8` 是私钥，泄漏等于别人能用你的身份公证软件。

### A.3 三个环境变量：收在 `~/.notarize.env`

三个**必须同时**设，少一个 electron-builder 会报
`Env vars APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER need to be set`；
**三个都不设则静默跳过公证**——这正是 §B 第 4 步那道验收存在的理由。

本机已经建好 `~/.notarize.env`（**刻意放在仓库外**，`chmod 600`）：

```bash
# ~/.notarize.env
export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"      # 就是 .p8 文件名里那 10 位
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

发版时：

```bash
source ~/.notarize.env && cd desktop && npm run dist
```

> **不写进 `~/.zshrc`** 是有意的：这三个变量只在发版时该存在。常驻环境里挂着，
> 万一哪天在别的项目里跑 electron-builder，会莫名其妙地去公证一个不该公证的东西。

### A.4 自查（先验凭据再打包）

```bash
source ~/.notarize.env
security find-identity -v -p codesigning | grep "Developer ID Application"
xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" | head
```

- 第一条要出 `1 valid identities found`
- 第二条**不报认证错**就是通的（新账号回 `No submission history.` 属正常）

**先验再打包**，不然要等构建 + 上传公证跑完十几分钟，才发现 Issuer ID 打错一个字符。

### A.5 首次配置踩过的四个坑（2026-08-19 实录，下次换机器照查）

| 症状 | 真因 | 怎么解 |
|---|---|---|
| 启动台 / Spotlight 搜「钥匙串」只出来**「密码」**这个 app，里面没有证书助理 | **macOS 15 把「钥匙串访问」移出了「实用工具」**，搜索还会被重定向到新的 Passwords.app | `open "/System/Library/CoreServices/Applications/Keychain Access.app"`；**证书助理在屏幕顶部系统菜单栏**的第一个菜单里，不在窗口内 |
| `.cer` 双击装了，`security find-identity -v -p codesigning` 仍报 **0 valid identities** | **缺 Apple 中间证书**。不带 `-v` 跑能看到证书在、私钥也配上了，但标着 `CSSMERR_TP_NOT_TRUSTED`——macOS 15 不再预装 `Developer ID Certification Authority (G2)` | 先看证书是哪张中间证书签的：<br>`security find-certificate -c "Developer ID Application" -p \| openssl x509 -noout -issuer`<br>再装对应那张：<br>`curl -fsSL -o /tmp/g2.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer && security import /tmp/g2.cer -k ~/Library/Keychains/login.keychain-db` |
| App Store Connect 的「集成 → App Store Connect API」页面上**没有 Team Keys**，只有一句「必须拥有权限才能访问」+「请求访问」按钮 | **API 访问是个总开关，第一次要自己打开** | 点「请求访问」→ 同意条款 → 页面才变成密钥列表，这时才有 `团队密钥` 子标签和 `+` |
| 公证提交上去被拒，报 `You must first sign the relevant contracts online` | **Apple Developer Program 许可协议更新后没接受**（App Store Connect 首页有黄色横幅提示） | 账户持有人登 `developer.apple.com/account` → Agreements → 接受最新协议。**发版前先扫一眼那条横幅**，比等公证回执快十几分钟 |

> 另外两条容易多花时间的：
> - **系统 / iCloud 登的是哪个 Apple ID 完全不影响**。生成 CSR 不做任何身份认证，
>   里面的邮箱与常用名称都是备注（Apple 签发时会整个覆盖掉）。只有**浏览器登
>   developer.apple.com / appstoreconnect.apple.com 时**必须是开发者 Apple ID
> - **Developer ID Application 证书一个账号最多 5 张**，别连点几次生成一堆

---

## B. 发版流程（每次照做）

### 1. 版本号

`desktop/package.json` 的 `version` 必须**比线上那版大**——electron-updater 是按它比的，
不涨版本号客户端永远收不到更新。

```bash
cd desktop && npm version patch --no-git-tag-version   # 0.1.0 → 0.1.1
```

### 2. 发版前自测（不能跳）

按 `desktop/CLAUDE.md` 的验收铁律，至少这几条全绿：

```bash
cd desktop && npm run typecheck && npm run build && node e2e/walkthrough.mjs
```

改过投递链路再加 `node e2e/a1-enqueue.mjs`；改过模型/线路再加 `npm run smoke:provider`。

### 3. 构建 + 签名 + 公证（一条命令）

```bash
source ~/.notarize.env && cd desktop && npm run dist
```

**`source` 那半截不能省**——三个环境变量都没设时 electron-builder **不报错、静默跳过公证**，
你会拿到一个签了名但没公证的 dmg，客户双击照样被 Gatekeeper 拦。

这一条里 electron-builder 会依次做完：编译 → 签名（Developer ID + Hardened Runtime +
`build/entitlements.mac.plist`）→ 上传 Apple 公证 → 等回执 → `stapler staple` 订票 →
出 `dmg` / `zip` / `latest-mac.yml`。

- 公证首次约 **5–15 分钟**（Apple 侧排队，跟包大小关系不大）
- **国内网络要挂代理**：上传公证走 Apple 服务器，断在这一步会报 `Failed to upload`
- 卡住时另开一个终端查队列：
  `xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"`
- 被 **Invalid** 拒了要看具体原因（多半是漏签了某个 Mach-O）：
  `xcrun notarytool log <submission-id> --key … --key-id … --issuer …`

### 4. 验收（硬断言，不看构建日志的绿字）

```bash
cd desktop && node scripts/verify-signing.mjs
```

**全绿才算数**：codesign 深度校验 / 签名主体是 Developer ID Application / Hardened Runtime 已开 /
entitlements 就是那三条 / `.app` 的 `spctl` accepted 且 `source=Notarized Developer ID` /
`stapler validate` 对 .app 与 .dmg 都过 / **`.dmg` 自己的 `spctl` 也 accepted** /
**包内每一个 Mach-O 都签了**。

> **两条是踩出来的，别删**：
> - **`.dmg` 的 spctl**（不能拿它的 `stapler validate` 顶替）。dmg 只公证不签名时
>   `stapler validate` 照样报 "worked"，而 `spctl` 判 `rejected / no usable signature`
>   ——公证票是按签名的 cdhash 校验的，没签名就对不上。客户撞到的是**打开 dmg**
>   那一步的拦截，而那一步看的正是 spctl。签名由 `scripts/notarize-dmg.cjs` 负责
> - **包内每个 Mach-O**，专门盯 `resources/pipeline/`（PyInstaller onedir，89MB、
>   几十个 `.dylib`/`.so`）。漏签它不会让构建失败，只会让公证判 Invalid，或者更坏——
>   公证过了但客户机上投递箱一个文件都不处理（`spawn` 报 EACCES，界面表现只是
>   "没有进度条"，这个症状 `RELEASE-CHECK.md` §6c 记过一次，排查花了 18 分钟）

**另外做一次隔离标记实测**（这才是"客户从微信/网盘收到"的真实形态；
上面的 spctl 是在没有 quarantine 的本地文件上跑的，比真实情况宽松）：

```bash
T=/tmp/gk-$$; mkdir -p "$T"; cp desktop/release/*.dmg "$T/收到的.dmg"
xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;" "$T/收到的.dmg"
spctl -a -vvv -t open --context context:primary-signature "$T/收到的.dmg"
MP=$(hdiutil attach "$T/收到的.dmg" -nobrowse -readonly | grep -o '/Volumes/.*' | head -1)
cp -R "$MP"/*.app "$T/" && hdiutil detach "$MP" -quiet
spctl -a -vvv -t exec "$T"/*.app
```

两处都要 `accepted`：dmg 那条对应"双击 dmg"，app 那条对应"拖进应用程序后双击"。

再拿**刚签好的那个包**跑一次全新装机冒烟（脚本自己会清出一份干净 userData，
等价于客户第一天；`MCNAI_APP_BIN` 指过去才是验"签名后的包"而不是 dev 形态）：

```bash
cd desktop && MCNAI_APP_BIN="$PWD/release/mac-arm64/mcn-ai.app/Contents/MacOS/mcn-ai" node e2e/fresh-install.mjs
```

### 5. 生成并上传更新源

`npm run dist` 已经在 `desktop/release/` 里出好了这三样，**一个都不能少**：

| 文件 | 干什么的 |
|---|---|
| `latest-mac.yml` | 版本清单，客户端每次查更新读的就是它 |
| `mcn-ai-<版本>-arm64-mac.zip` | **自动更新真正下载的包**（macOS 上 electron-updater 用 zip，不用 dmg） |
| `mcn-ai-<版本>-arm64-mac.zip.blockmap` | 差量下载用；缺了会退化成整包下载，不致命但白费流量 |

`dmg` 是给**新装机**用的（微信/网盘发给客户），不进更新源也行，放上去更方便。

上传到更新源根目录（当前是占位，切真实地址见 §C）：

```bash
# 阿里云 OSS 示例（ossutil 已配好 AK）
cd desktop/release
ossutil cp latest-mac.yml                    oss://<bucket>/mac/ -f
ossutil cp mcn-ai-*-arm64-mac.zip            oss://<bucket>/mac/ -f
ossutil cp mcn-ai-*-arm64-mac.zip.blockmap   oss://<bucket>/mac/ -f
ossutil cp mcn-ai-*-arm64.dmg                oss://<bucket>/mac/ -f
```

**上传顺序有讲究**：先传 zip 与 blockmap，**最后**传 `latest-mac.yml`。
反过来的话，客户端会在包还没传完的窗口里读到新版本号然后 404。

### 6. 验证更新源真的通了

```bash
curl -sI "<更新源URL>/latest-mac.yml" | head -1        # 要 200
curl -s  "<更新源URL>/latest-mac.yml"                  # version/path/sha512 要对得上刚发的包
```

`latest-mac.yml` 里的 `path` 是**相对**更新源根目录的文件名，所以 zip 必须和 yml **同一层**。

### 7. 客户端侧的表现（策略 = 提示后更新，不静默）

- 启动 20 秒后查一次，之后每 4 小时查一次（`src/main/updater.ts`）
- 查到新版本**后台静默下载**，下载期间界面上什么都不出
- 下完在正文区顶部挂一条：**「新版本 X.Y.Z 已就绪，重启生效」**＋「立即重启」＋可关闭
- 不点也不催；用户自己退出应用时也会装上（`autoInstallOnAppQuit`），所以那句「重启生效」是实话
- 更新失败（没网 / 源挂了）**只写日志、界面不出任何东西**——客户在内网照常干活，
  一条"查不到更新"的红条只会让他去查网络

---

## C. 更新源：占位 → 真实地址

**现在是占位状态。** `desktop/electron-builder.yml` 的 `publish.url` 写着
`https://samepage-updates.REPLACE-ME.invalid/mac/`，`src/main/updater.ts` 认出 `.invalid`
就整条跳过——占位期间客户机**不发任何更新请求**，日志里也不会堆一串 ENOTFOUND。

### 切换步骤（拿到阿里云 OSS 地址之后）

1. 改 `desktop/electron-builder.yml` 一行：

   ```yaml
   publish:
     provider: generic
     url: https://<bucket>.oss-cn-<region>.aliyuncs.com/samepage/mac/
     channel: latest
   ```

2. OSS 侧：bucket 读权限设为**公共读**，`latest-mac.yml` 的 `Content-Type` 建议
   `text/yaml`，并把它的缓存时间设短（`Cache-Control: max-age=60`）——
   CDN 把 yml 缓存住是这类更新源最常见的"发了但客户收不到"。
3. 重新 `npm run dist`（url 是**打包时**烧进 `resources/app-update.yml` 的，改了必须重打）
4. 按 §B 5–6 上传并验证
5. **验证真的切过来了**：新装一台，看日志里这一行：
   `[updater] 自动更新已启用，源：https://…`
   还写着「更新源是占位地址」就是没切成。

### ⚠️ 待办：更新源的鉴权（记账，不挡这一版）

当前方案是**不公开的 URL**（靠地址本身不外传），**不是访问控制**。够用的前提是客户少、
且 URL 不出现在任何对外物料里。**客户增多后必须升级**，两条路：

| 方案 | 做法 | 代价 |
|---|---|---|
| 私有 bucket + 签名 URL | OSS bucket 改私有读，客户端带临时签名访问 | 要有个发签名的服务端；签名过期要处理 |
| 网关鉴权 | 更新源走自己的网关，按登录态放行 | 与「key 不再下发客户端」那单的网关是同一条基础设施，**建议搭车做** |

触发升级的条件：**客户超过 5 家**，或更新包里开始含客户可识别信息，或 URL 有外泄迹象。

### 已知边界（如实记）

- **只出 arm64**。Intel Mac 客户机拿不到更新（也装不了当前的 dmg）。要支持得加 `x64`
  或 `universal` target，并重跑一遍签名公证验收
- **降级回滚没有做**。发错版本只能重新发一个更大的版本号盖过去，
  不能靠改 `latest-mac.yml` 把客户拽回旧版（electron-updater 默认不降级）
- **投递箱有活时退出走的是 `app.exit(0)`**，会跳过 install-on-quit。
  那种情况下更新包留在缓存里，下次启动秒出同一条提示，不会丢

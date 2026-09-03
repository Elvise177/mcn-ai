# 设计刻度表（DESIGN-scale · 草案）

> 2026-09-02 草案 ｜ 依据：`desktop/scripts/audit/ui-hardcode-stats.mjs` 对渲染层 34 个文件的实测分布（见 `PRODUCT-AUDIT.md` §3.2），不是凭空定的刻度。
> 数值真相源仍是 `desktop/src/renderer/src/styles/theme.css`；本文只定**有哪几档、现状各值归并到哪一档、哪些是刻意例外**。
> 与 `DESIGN-color-semantics.md` 的关系：那份管颜色语义，本文管几何与动效，两份互不覆盖。
> 状态：**token 已定义（2026-09-02，随 PLAN-v2 批 1 落地）**：`theme.css` 的 `--space-1/2/3/4/6/8/12`（删掉了原有未用的 5/10）、
> `--leading-snug`、`--shadow-modal`；`tailwind.config.js` 把 `p-1…p-12` 等数字刻度 **extend 指到 token**（值与默认逐像素相同，零视觉变化）、
> `fontWeight` 整体覆盖为 normal/medium/semibold（排除 700）。**560 处半步类替换 + spacing 整体覆盖 + 走查白名单断言 + 全量重拍**仍在批 4。

## 0. 结论先说

| 类别 | 现状 | 本文动作 |
|---|---|---|
| 字号 | 9 个 token 全接 `var(--text-*)`，裸值 2.1% | **不改值**，只分「核心 6 档 / 装饰例外」两层 |
| 圆角 | 7 个 token，裸值 1.3% | **不改值**，4 档 + 2 个产品级例外 |
| 颜色 | 组件层字面量 0 处 | 不在本文范围 |
| **间距** | **裸值 100%**（560 处、74 个不同值）：`tailwind.config.js` 从未覆盖数字刻度 | **本文唯一真缺口**：建 8 点栅格 7 档 |
| 行高 / 字重 | 裸值 87% / 100% | 补 2 个行高 token；字重加语义映射 |
| 阴影 | 2 个 token，「模态」档缺失 | 补第 3 档 |
| 动效 | 3 个时长 token 已有；23 处吃 Tailwind 隐式 150ms | 写明隐式默认归属，不逐处改 |

## 1. 间距：8 点栅格（7 档）

现状 560 处命中里出现最多的 20 个值天然落在 4 的倍数上（Tailwind 默认刻度的产物，不代表守规矩）。真正的问题是**同一量级并存多套写法**：轻间距这一档同时有 `py-1.5`(6px, 33 次)、`px-2.5`(10px, 22 次)、`gap-1.5`(6px, 15 次)、`py-0.5`(2px, 17 次) 四种半步值，合计 87 次，没有一张表告诉后来者该用哪个。

| token | 值 | 现状归并（→ 这一档，命中合计） |
|---|---|---|
| `--space-1` | 4px | `py-1`(22) `mt-1`(12) `mb-1`(11) `gap-1`(11) `p-1`(5) `px-1`(4) `pt-1`(2) 等；**2px 系半步**（`py-0.5`/`gap-0.5`/`mt-0.5`/`mb-0.5`/`mr-0.5`，27 次）就近并入——2px 太细已分不清意图 |
| `--space-2` | 8px | `gap-2`(43) `py-2`(23) `px-2`(10) `mb-2`(9) `mt-2`(8) `pb-2`(4) `p-2`(4) 等；**6px 系半步**（`py-1.5`/`gap-1.5`/`mb-1.5`/`mt-1.5`/`px-1.5`/`pb-1.5`，65 次）并入 |
| `--space-3` | 12px | `px-3`(49，单值最大量) `py-3`(10) `gap-3`(8) `space-y-3`(6) `mt-3`(6) 等 |
| `--space-4` | 16px | `px-4`(25) `mb-4`(6) `pt-4`(3) `p-4`(3) `mt-4`(3) `gap-4`(3) 等；**10px 系半步**（`px-2.5`/`py-2.5`/`gap-2.5`/`mt-2.5`/`pl-2.5`，42 次）并入 12 或 16，按控件逐个判 |
| `--space-6` | 24px | `p-6`(15) `mb-6`(11) `mt-6`(4) `gap-6`(3) 等；**20px 系**（`px-5`/`mb-5`/`mt-5`/`p-5`/`py-5`/`space-y-5`，9 次）并入 |
| `--space-8` | 32px | `px-8`(15) `mt-8`(3) `mb-8`(1) |
| `--space-12` | 48px | `py-12`(1) `mt-12`(1)；**40px 系**（`p-10`/`py-10`/`mb-10`/`pb-10`/`pt-10`，8 次）并入 |

Tailwind 接法：`tailwind.config.js` 的 `theme.spacing` **整体覆盖**（不是 extend）为 `{0, px, 1:var(--space-1), 2, 3, 4, 6, 8, 12}` + 现有具名尺寸（`sidebar`/`tree`/…）。覆盖后 `p-5`/`py-1.5` 这类类名直接不存在，typecheck 不会报但 Tailwind 会静默不生成——所以实施批次必须配一条走查断言：扫 class 属性里不在白名单的 spacing 类。

**明确保留、不归并的例外**

- `--size-input`=60px（输入框高）、`--radius-input`=14px：HANDOFF §2-7 记录的 2026-08-16 产品决策，两个值都不在序列里，**继续独立 token**。
- `--home-top`=22vh：视口相对单位，天然在栅格外。
- 10px 半步（42 次）本稿否掉单开一档：散在五种属性上，没有一处是「8/12 都不合适所以选 10」的记录。**但若实施时某个控件（如 badge 内边距）改 8/12 后视觉明显变松/变挤，那一处开例外 token，不强行套栅格**——留给实施阶段验证。
- `styles/index.css` 里 markdown 正文的 `em` 相对间距（`margin: 0.8em 0` 等 15 处）：相对父级字号是刻意的，不换成 px token，但建议收成 `--md-block-gap` 之类 2–3 个 em 变量。

## 2. 字号：核心 6 档 + 装饰例外（不改值）

| 层 | token | px | 命中 | 行高 | 字重 | 定位 |
|---|---|---|---|---|---|---|
| 核心 | `--text-2xs` | 10 | 10 | `--leading-tight`(1.35) | 500 | 徽标/角标 |
| 核心 | `--text-xs` | 11 | 35 | 1.35 | 400 | 次要说明 |
| 核心 | `--text-sm` | 12 | 84（最高频） | `--leading-snug`（新，见 §5） | 400/500 | 按钮/列表项 |
| 核心 | `--text-base` | 13 | 41 | `--leading-base`(1.65) | 400 | 正文默认 |
| 核心 | `--text-md` | 14 | 46 | 1.65 | 400/500 | 强调正文/输入框 |
| 核心 | `--text-xl` | 20 | 9 | 1.35 | 600 | 卡片标题 |
| 例外 | `--text-lg` | 15 | 3 | | | 与 14/20 区分度低；实施时复查这 3 处能否改 md/xl，不能就在 token 注释写明理由 |
| 例外 | `--text-2xl` | 24 | 0 | | | 定义了没人用，保留刻度 |
| 例外 | `--text-3xl` | 30 | 6 | 1.2 | 600 | 建库向导/登录页大标题 |
| 例外 | `--text-display` | 38 | 1 | 1.2 | 400 | 首页问候语专用；中文衬线字重无效只能靠字号（HANDOFF §4-14），**不与任何档合并** |

裸值 5 处：markdown 的 `1.5em/1.3em/1.15em/0.86em`（相对父级，刻意）+ `text-[10px]` 1 处（应改 `text-2xs`）。

## 3. 圆角：4 档 + 2 例外（不改值）

| token | px | 命中 | 用途 |
|---|---|---|---|
| `--radius-xs` | 4 | 7（裸类 `rounded`） | 小控件/图标按钮 |
| `--radius-md` | 8 | 27 | 输入控件/小卡片默认 |
| `--radius-lg` | 12 | 12 | 中卡片；**toast 圆角落在这一档**（DESIGN-color-semantics 写死 12px），改这个值前先看那份文档 |
| `--radius-xl` | 16 | 24 | 大卡片/弹层 |
| `--radius-full` | 999 | 63（最高频） | 胶囊/头像/圆点 |
| 例外 `--radius-sm` | 6 | 5 | 只在 UsagePage 表格一处场景；别处要 6px 直接复用，不新开 |
| 例外 `--radius-input` | 14 | 5 | 产品决策，独立 |

裸值 2 处（`50%` 圆形、`1px` 流式光标）是几何意义不是刻度，维持原样。

## 4. 阴影：3 档

| token | 用途 | 现状 |
|---|---|---|
| `--shadow-card` | 卡片静态投影 | 已有，0 处直接命中（实施时复核是否还需要） |
| `--shadow-pop` | 下拉/toast/浮窗 | 已有，7 处 |
| **`--shadow-modal`（新）** | 模态框/右键菜单等强遮挡浮层 | 现状 2 处蹭 Tailwind `shadow-lg`（`WriteConfirm.tsx:53`、`VaultPage.tsx:1198`）；值按 `--shadow-pop` 的暖灰配方加深一档，保持同一色相 |

## 5. 行高与字重

- 行高现有 `--leading-base`(1.65) / `--leading-tight`(1.35)，但组件里最常用的是 Tailwind 默认 `leading-5`(18 处) / `leading-6`(5 处)。**新增 `--leading-snug`**（≈1.45，对应 `leading-5` 场景：按钮/列表单行）；`leading-6` 归 `--leading-base`；`leading-4` 归 `--leading-tight`。`index.css` 的 `1.75`/`1.6` 两处并入 base。
- 字重不建变量表（400/500/600 已是行业惯例），但在 `tailwind.config.js` 显式 `fontWeight: {normal:400, medium:500, semibold:600}` 三个语义名，把 `font-bold`(700) 排除出可用集——中文系统黑体 700 与 600 差异小且发糊。

## 6. 动效：时长 3 档（已有）+ 缓动例外

| 现状 | 命中 | 归并 |
|---|---|---|
| 未写 duration 吃 Tailwind 隐式 150ms（`transition-colors/opacity/[width]`、裸 `transition`） | 23 | 视为 `--dur-fast`(140ms)。不逐处改（工程量大、无感差异），刻度表写明「裸 `transition-*` 等价 `--dur-fast`，新代码优先显式」 |
| `duration-300`（UpdateBar 进度条） | 1 | 改 `--dur-slow`(360ms) |
| `--dur-fast` 140 / `--dur-base` 220 / `--dur-slow` 360 + `--ease-out` | 7 | 保持 |
| `1.2s ease-in-out`（dotBounce）/ `0.9s linear`（stripeShift） | 2 | **保留为循环动画例外**：氛围动效比交互过渡慢一个量级，硬凑三档会变味 |
| `prefers-reduced-motion` 全局关动效 | 已有 | 保持（走查依赖它） |

## 7. 实施影响面（供 PLAN-v2 排批）

- 改 `tailwind.config.js` spacing 为整体覆盖 → 全部 34 个渲染层文件的 spacing 类名要过一遍（560 处，机械替换，可脚本化：`p-1.5→p-2`、`px-2.5→px-3`、`p-5→p-6`、`p-10→p-12`）。
- 新增 token：`--space-1..12`、`--leading-snug`、`--shadow-modal`；`theme.css` 加约 12 行。
- 走查新增断言：spacing 类白名单扫描；toast 几何比对已有。
- 截图影响：全部页面像素级微变，需整轮走查重拍基线并逐张过目（desktop/CLAUDE.md 铁律）。
- 与模板系统的关系：无耦合，可先行；但 UI 卷其余精修应等模板系统形态定型后再做，避免重拍两次基线。

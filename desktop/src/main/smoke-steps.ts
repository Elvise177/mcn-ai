import { countToolResults, isStepWorthy, pickStepArgs, shortToolName, toolResultText } from './agent/steps'
import { computeInboxProgress, judgeBackfill } from './tasks/types'
import { describeStep, durationHint, scanTarget } from '../renderer/src/config/steps'
import { failedCount, producedArtifact, summaryText, tierNote, type SummaryStep } from '../renderer/src/lib/turn-summary'
import { backoffMs, isTransient, retryNotice, shouldAnnounceRetry } from './lib/backoff'
import { nextRetryAt, notesForRoot, pickDue } from './lib/retry-ladder'
import { INBOX_STAGES, STAGE_LABEL } from '../renderer/src/config/stages'
import { fmLabel, formatFrontmatterValue, splitFrontmatter } from '../renderer/src/lib/note-format'

/**
 * 过程可见性的**纯逻辑冒烟**：参数提取、结果计数、中文文案映射。零网络、零 token。
 *
 * 跑法：`npm run smoke:steps`
 *
 * 为什么值得单独一个入口：这一层错了不会报错，只会"说错话"——
 * 检索步骤显示上一次的关键词、核对步骤显示一个编出来的数字、或者干脆把 `Grep`
 * 甩到用户脸上。真实调用只能证明"正常那一条路对了"，边角（数不出来 / 未映射工具 /
 * 没有历史耗时）拿 token 去试既慢又碰不全。
 *
 * 真链路那一条（真实检索词 / 真实文件名 / 真实数字进 DOM）在 `e2e/walkthrough.mjs`。
 */

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n【1】工具名去前缀')
check('mcp 前缀剥掉', shortToolName('mcp__knowledge__search_knowledge') === 'search_knowledge')
check('内置工具原样', shortToolName('Grep') === 'Grep')

console.log('\n【1b】基础设施工具不进步骤流（2026-08-18 走查现场抓到：Skill 每轮开头都来一条「正在处理」）')
check('Skill 被挡掉', !isStepWorthy('Skill'))
check('TodoWrite 被挡掉', !isStepWorthy('TodoWrite'))
check('真正干活的工具照常放行', isStepWorthy('mcp__knowledge__search_knowledge') && isStepWorthy('Grep'))
check('没见过的工具仍然放行（兜底文案归兜底，不能顺手一起挡）', isStepWorthy('WebFetch'))

console.log('\n【2】入参提取：只挑有呈现价值的字段')
check(
  '检索词',
  pickStepArgs('mcp__knowledge__search_knowledge', { query: '年度目标 进展' }).query === '年度目标 进展'
)
check(
  '阅读的文件',
  pickStepArgs('Read', { file_path: '/v/20_公司管理/灰太太.md', offset: 1 }).file ===
    '/v/20_公司管理/灰太太.md'
)
{
  const a = pickStepArgs('Grep', { pattern: '年度目标', path: '20_公司管理', output_mode: 'files_with_matches', '-n': true })
  check('扫描目标只留 pattern/path/glob', JSON.stringify(a) === JSON.stringify({ pattern: '年度目标', path: '20_公司管理' }), JSON.stringify(a))
}
{
  // outline JSON 动辄几 KB，绝不能整包塞进流式事件
  const a = pickStepArgs('render_pptx', { filename: '带货复盘', outline_json: 'x'.repeat(9000) })
  check('产物工具不带 outline', !('outline_json' in a) && a.filename === '带货复盘', JSON.stringify(a).slice(0, 80))
}
check('未列出的工具回空对象', Object.keys(pickStepArgs('WebFetch', { url: 'https://x' })).length === 0)
// 夹具必须是**真实形状**的长路径：纯 'aaa…' 没有分隔符也没有扩展名，会先被
// 「上游标识符不当文件名」那道闸门挡掉（见【10】），那样验的就不是截断了
check('超长入参截断到 120',
  (pickStepArgs('Read', { file_path: '很长的目录/'.repeat(60) + '笔记.md' }).file ?? '').length === 120)
// 走查现场抓到的：模型给的是绝对路径，不剥库根就会说成「mcnai-e2e-vault 里含…的笔记」
{
  const root = '/tmp/mcnai-e2e-vault'
  check('路径相对库根', pickStepArgs('Read', { file_path: `${root}/20_公司管理/灰太太.md` }, root).file === '20_公司管理/灰太太.md')
  check('指到库根本身 = 不说目录', pickStepArgs('Grep', { pattern: 'x', path: root }, root).path === undefined)
  check('库外路径原样留着', pickStepArgs('Read', { file_path: '/etc/hosts' }, root).file === '/etc/hosts')
}

console.log('\n【3】结果计数：数不出来就回 undefined，且数字必须带单位')
const cnt = (t: string, s: string): string => JSON.stringify(countToolResults(t, s) ?? null)
check('检索命中数（编号列表）', cnt('search_knowledge', '1. [[A]] (a.md)\n   片段\n2. [[B]] (b.md)\n   片段') === '{"count":2,"unit":"file","approx":false}')
check('检索无命中', cnt('search_knowledge', '（无命中）') === '{"count":0,"unit":"file"}')
check(
  '模糊回退那段前缀不算一条',
  cnt('search_knowledge', '（精确检索无命中，以下是**相近结果**…）\n1. [[A]] (a.md)\n2. [[B]] (b.md)') === '{"count":2,"unit":"file","approx":true}'
)
check('Grep 的 Found N files → 份', cnt('Grep', 'Found 7 files\n/v/a.md\n/v/b.md') === '{"count":7,"unit":"file"}')
check('Grep 零命中', cnt('Grep', 'No files found') === '{"count":0,"unit":"file"}')
// 这条是「检索了 42 份资料」瞎报的根源：content 模式吐的是一篇里的 42 行
check('Grep 逐行命中 → 处（不是份）', cnt('Grep', 'a.md:1:命中\na.md:2:命中\na.md:3:命中') === '{"count":3,"unit":"match"}')
check('Glob 逐行路径 → 份', cnt('Glob', '/v/a.md\n/v/b.md\n/v/c.md') === '{"count":3,"unit":"file"}')
check('Read 不给数字', countToolResults('Read', '# 标题\n正文') === undefined)
// 相近标注：云端语义检索没有相关度闸门，恒定返回 top-6，必须标出来（§3-13）
check(
  '云端结果标成相近（认「相关度」格式）',
  cnt('search_knowledge', '1. [我的] (my_script, 相关度0.42)\n   片段\n2. [我的] (my_script, 相关度0.41)\n   片段') ===
    '{"count":2,"unit":"file","approx":true}'
)
check(
  '本地模糊回退也算相近',
  cnt('search_knowledge', '（精确检索无命中，以下是**相近结果**…）\n1. [[A]] (a.md)').includes('"approx":true')
)
check(
  '精确命中不标相近',
  cnt('search_knowledge', '1. [[A]] (a.md)\n   片段').includes('"approx":false')
)
check('tool_result 的数组形态', toolResultText([{ type: 'text', text: 'Found 3 files' }]) === 'Found 3 files')

console.log('\n【4】扫描目标：拼出来必须是能读的一句话')
const tgt = (a: Record<string, string>): string => scanTarget(a).text
check('目录+关键词', tgt({ pattern: '年度目标', path: '20_公司管理' }) === '20_公司管理 里含「年度目标」的笔记')
check('只有目录', tgt({ path: '20_公司管理/' }) === '20_公司管理 里的笔记')
check('通配符剥干净', tgt({ pattern: '**/*达人*.md' }) === '含「达人」的笔记')
check('什么都没有也不留半句话', tgt({}) === '库中笔记')
// 真人验收 2026-08-18 指出的黏连：`灰太太.*GMV|灰太太.*出单` 老写法糊成
// 「灰太太.GMV灰太太.出单」，句点连着读像乱码
check(
  '多关键词用顿号分隔，不黏连',
  tgt({ pattern: '灰太太.*GMV|灰太太.*出单' }) === '含「灰太太 GMV、灰太太 出单」的笔记',
  tgt({ pattern: '灰太太.*GMV|灰太太.*出单' })
)
check(
  '关键词太多只报前几个',
  tgt({ pattern: 'a|b|c|d|e|f' }) === '含「a、b、c、d 等 6 个词」的笔记',
  tgt({ pattern: 'a|b|c|d|e|f' })
)
check('指到一篇笔记时换量词', scanTarget({ pattern: '灰太太', path: '80_Library/年框合作.md' }).note === true)
check('指到一篇笔记的目标文案', tgt({ pattern: '灰太太', path: '80_Library/年框合作.md' }) === '《年框合作》里的「灰太太」')
check('数「处」时用的位置说法', scanTarget({ pattern: '灰太太', path: '40_带货/产品' }).where === '产品')
// 真人验收 2026-08-18 第三轮：模型穷举猜路径/拿内部字段当关键词，界面上全是技术黑话
check('关键词写成路径的只留末级', tgt({ pattern: '20_公司管理/24_业务数据/' }) === '含「24_业务数据」的笔记', tgt({ pattern: '20_公司管理/24_业务数据/' }))
check('纯技术串不展示', tgt({ pattern: 'my_script' }) === '库中笔记', tgt({ pattern: 'my_script' }))
check('技术串混在多关键词里也剔掉', tgt({ pattern: '灰太太|source_type' }) === '含「灰太太」的笔记', tgt({ pattern: '灰太太|source_type' }))
check('普通英文词不误伤', tgt({ pattern: 'GMV|Hogwarts' }) === '含「GMV、Hogwarts」的笔记', tgt({ pattern: 'GMV|Hogwarts' }))
check('没指路径时位置就是「库」', scanTarget({ pattern: '灰太太' }).where === '库')

console.log('\n【5】中文文案：进得去工具名，出不来工具名')
const zh = (t: string, a: Record<string, string>, c: Parameters<typeof describeStep>[2] = {}): string =>
  describeStep(t, a, c).text
check('检索（进行中，带真实关键词）', zh('search_knowledge', { query: '年度目标' }) === '正在检索知识库：年度目标')
check('检索（完成，带命中数）', zh('search_knowledge', { query: '年度目标' }, { done: true, count: 5 }) === '检索了知识库：年度目标（5 条）')
check(
  '检索（完成，相近结果要标出来）',
  zh('search_knowledge', { query: '灰太太' }, { done: true, count: 6, approx: true }) === '检索了知识库：灰太太（相近结果 6 条）'
)
check('阅读用书名号', zh('Read', { file: '20_公司管理/灰太太.md' }) === '正在阅读《灰太太》')
check('核对（进行中）', zh('Grep', { pattern: '年度目标' }) === '正在逐份核对含「年度目标」的笔记')
check(
  '核对（完成，带数字与目标）',
  zh('Grep', { pattern: '年度目标' }, { done: true, count: 3, unit: 'file' }) === '核对了 3 份含「年度目标」的笔记'
)
check(
  '逐行命中说「处」不说「份」',
  zh('Grep', { pattern: '灰太太', path: '80_Library/年框合作.md' }, { done: true, count: 42, unit: 'match' }) ===
    '核对了《年框合作》里的「灰太太」，命中 42 处'
)
check('指到一篇笔记时说"逐行"', zh('Grep', { pattern: '灰太太', path: 'a/年框合作.md' }) === '正在逐行核对《年框合作》里的「灰太太」')
// 走查现场读出来的别扭句：「核对了产品 里含「灰太太」的笔记，命中 11 处」——
// 把"一批笔记"和"多少行"叠着说了。数「处」时改说位置
check(
  '目录 + 逐行命中：说位置不说"一批笔记"',
  zh('Grep', { pattern: '灰太太', path: '40_带货/产品' }, { done: true, count: 11, unit: 'match' }) ===
    '核对了产品里的「灰太太」，命中 11 处'
)
// 真人对照截图指出（2026-08-18）：三次扫的是不同的东西，却都显示成一模一样的
// 「已确认库中没有相关记录」，连着三条像复读机。确认文案必须带上"确认的是哪儿"
check(
  '验证性扫描（进行中，说清扫的是文件名）',
  zh('Glob', { pattern: '霍格沃茨' }, { verify: true }) === '正在确认文件名里有没有「霍格沃茨」',
  zh('Glob', { pattern: '霍格沃茨' }, { verify: true })
)
check(
  '验证性扫描（完成，文件名）',
  zh('Glob', { pattern: '霍格沃茨' }, { verify: true, done: true, count: 0 }) === '已确认文件名里没有「霍格沃茨」',
  zh('Glob', { pattern: '霍格沃茨' }, { verify: true, done: true, count: 0 })
)
check(
  '验证性扫描（完成，正文）',
  zh('Grep', { pattern: '霍格沃茨' }, { verify: true, done: true, count: 0 }) === '已确认正文里没有「霍格沃茨」',
  zh('Grep', { pattern: '霍格沃茨' }, { verify: true, done: true, count: 0 })
)
check(
  '同一个词、两种扫法，文案必须不同（这就是复读机那条的判据）',
  zh('Grep', { pattern: '霍格沃茨' }, { verify: true, done: true, count: 0 }) !==
    zh('Glob', { pattern: '霍格沃茨' }, { verify: true, done: true, count: 0 })
)
check(
  '验证性扫描带分区范围',
  zh('Grep', { pattern: '霍格沃茨', path: '20_公司管理' }, { verify: true, done: true, count: 0 }) ===
    '已确认 20_公司管理 的正文里没有「霍格沃茨」',
  zh('Grep', { pattern: '霍格沃茨', path: '20_公司管理' }, { verify: true, done: true, count: 0 })
)
check(
  '没有关键词时的兜底（文件名说"匹配"、正文说"相关记录"）',
  zh('Glob', {}, { verify: true, done: true, count: 0 }) === '已确认文件名里没有匹配' &&
    zh('Grep', {}, { verify: true, done: true, count: 0 }) === '已确认正文里没有相关记录',
  zh('Glob', {}, { verify: true, done: true, count: 0 }) + ' / ' + zh('Grep', {}, { verify: true, done: true, count: 0 })
)
check(
  '验证性扫描但真扫到了 → 回到核对口径',
  zh('Grep', { pattern: '达人' }, { verify: true, done: true, count: 2, unit: 'file' }) === '核对了 2 份含「达人」的笔记'
)
check('Bash 只说在处理文件', zh('Bash', { command: 'python cli.py --file x' }) === '正在处理文件')
check('产物（无历史）', zh('render_pptx', {}) === '正在生成 PPT（内容较多时需要几分钟）')
check('产物（有历史，秒数来自中位数）', zh('render_pptx', {}, { medianMs: 46_200 }) === '正在生成 PPT（通常约 46 秒）')
check('产物按 format 分类型', zh('render_document', { format: 'xlsx' }, { medianMs: 12_000 }) === '正在生成 Excel 表格（通常约 12 秒）')
check('未映射工具兜底', zh('WebFetch', {}) === '正在处理')
// 护栏拦下的那一步：既没去找也没出错，说成「核对了…」或「没成功」都是假话
check(
  '被护栏拦下说清楚是到上限',
  zh('Grep', { pattern: '灰太太' }, { done: true, capped: true }) === '已达本轮文件查找上限，改用已有材料作答'
)
check('中位数是脏数据（<1s）时按"没有历史"处理', durationHint(400) === '内容较多时需要几分钟')

console.log('\n【6】所有文案里不许出现工具原名')
{
  const TOOLS = ['search_knowledge', 'render_pptx', 'render_document', 'Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch']
  const args: Record<string, string> = { query: '年度目标', file: 'a/灰太太.md', pattern: '达人', command: 'ls', format: 'docx', filename: '复盘' }
  const bad: string[] = []
  for (const t of TOOLS) {
    for (const c of [{}, { done: true, count: 3 }, { verify: true }, { verify: true, done: true, count: 0 }]) {
      const text = zh(t, args, c)
      // 工具原名（含 mcp 前缀与下划线标识符）一个都不许漏出去
      if (new RegExp(`\\b${t}\\b`).test(text) || /mcp__|[a-z]+_[a-z]+/.test(text)) bad.push(`${t} → ${text}`)
    }
  }
  check('十种工具 × 四种阶段全部无工具名', bad.length === 0, bad.join(' | '))
}

console.log('\n【10】上游标识符不许被当成文件名（走查现场抓到「阅读了《call_0》」）')
{
  // DeepSeek 兼容端点给 tool_use 编的 id 就长 call_0 这样，上游把它塞进了 file_path
  for (const junk of ['call_0', 'call_12', 'toolu_01ABC', 'tool_use_1']) {
    check(`${junk} 不当文件名`, pickStepArgs('Read', { file_path: junk }).file === undefined)
    check(`${junk} → 兜底文案不露它`, !zh('Read', pickStepArgs('Read', { file_path: junk })).includes(junk))
  }
  // 真文件名照常认（别把这条闸门收得太紧）
  check('真文件名照常显示', pickStepArgs('Read', { file_path: '80_资料库/工作-管理类/年框.md' }).file ===
    '80_资料库/工作-管理类/年框.md')
  check('库根下的裸文件名也认', pickStepArgs('Read', { file_path: '欢迎.md' }).file === '欢迎.md')
}

/**
 * ---- 投递箱进度标签（0.1.2）----
 *
 * 为什么在这里：`computeInboxProgress` 原来是 orchestrator 的私有方法，
 * 唯一能验它的办法是真跑一轮真实打标（几十分钟 + 真金白银），
 * 于是那条 `label === '智能打标'` 的死判据从上线起没被任何测试碰过。
 * 2026-08-21 花 ¥0.88 真跑 Jerry 的 166 个文件才暴露：
 * **界面整整 18 分钟停在「PII守卫 2/8」**，而后台一直在稳步打标。
 *
 * 抽成纯函数之后，同样的场景在这里几毫秒就验完，一分钱不花。
 */
{
  console.log('\n【投递箱进度标签】')
  const stage = (s: string) => ({ type: 'stage' as const, stage: s })

  // ① 打标进行中：上一个**阶段事件**还停在 pii_guard（篇级进度刻意不进 stages），
  //    界面必须已经显示「智能打标 · 第 n/N 篇」，而不是停在「PII守卫」
  const running = computeInboxProgress([stage('convert'), stage('pii_guard')], { done: 3, total: 166 })
  check('打标中：标签切到打标那一格并带篇数（U3 #6 起用户词是「整理中」）', running.label === '整理中 · 第 4/166 篇', running.label)
  check('打标中：阶段推进到第 3 格', running.done === 3, String(running.done))

  // ② 没有篇级进度时按阶段事件走（老行为不变）
  const plain = computeInboxProgress([stage('convert'), stage('pii_guard')], null)
  check('无篇级进度：显示上一个阶段的用户词', plain.label === '检查中', plain.label)

  // ③ 打标已经过去：后面的阶段来了，不许被篇数标签顶回去
  const later = computeInboxProgress(
    [stage('convert'), stage('pii_guard'), stage('tag_llm'), stage('sensitive_enrich')],
    { done: 166, total: 166 }
  )
  check('打标之后：标签跟着后续阶段走', later.label === '建立关联', later.label)
  check('打标之后：进度不被拉回', later.done === 5, String(later.done))

  // ④ 一个文件都没有时不许出现「第 1/0 篇」这种话
  const zero = computeInboxProgress([stage('pii_guard')], { done: 0, total: 0 })
  check('总数为 0 时不显示荒唐篇数', !/\/0 篇/.test(zero.label), zero.label)
}


/**
 * ---- 打标补齐的开跑判据（0.1.2）----
 *
 * 原来是 `runTagBackfill` 开头的三行裸 return，一句日志都不落、一个事件都不发。
 * 用户看到「有 156 篇可以升级」点了「现在升级」，界面**没有任何变化**。
 * 抽成纯函数之后这四种拒绝理由在这里几毫秒验完，不用起应用、不用真打标。
 */
{
  console.log('\n【打标补齐判据】')
  const base = { vaultRoot: '/v', running: false, hasKey: true, staleCount: 156 }
  const ok = judgeBackfill(base)
  check('前提齐全 → 放行', ok.ok === true)
  for (const [name, patch, reason] of [
    ['没开库', { vaultRoot: null }, 'no-vault'],
    ['投递箱在跑', { running: true }, 'busy'],
    ['没有打标密钥', { hasKey: false }, 'no-key'],
    ['本来就没有待升级的', { staleCount: 0 }, 'nothing'],
  ] as const) {
    const v = judgeBackfill({ ...base, ...patch })
    check(`${name} → 拒绝且给出 ${reason}`, v.ok === false && v.reason === reason,
      v.ok ? 'ok' : v.reason)
    check(`${name} → 有能直接给用户看的话`, v.ok === false && v.message.length > 4,
      v.ok ? '' : v.message)
  }
  // 多个前提同时不满足时，**先报最根本的那个**：没开库就别说"没有密钥"
  const both = judgeBackfill({ vaultRoot: null, running: true, hasKey: false, staleCount: 0 })
  check('多个前提都不满足时报最根本的', both.ok === false && both.reason === 'no-vault',
    both.ok ? '' : both.reason)
}

/**
 * ---- 折叠摘要：Q7 第三分支 · N9 失败数 · Q15 档位（PLAN-v2 批 2）----
 *
 * 三条都是**只在真实调用下才走到**的判据：产物轮要真做一个 PPT、失败步要真挂一次工具、
 * 服务端换模型（degraded）更是想造都造不出来。抽成纯函数之后在这里几毫秒验完（铁律）。
 */
{
  console.log('\n【折叠摘要】Q7 产物轮 / N9 失败数 / Q15 档位')
  let seq = 0
  const step = (tool: string, p: Partial<SummaryStep> = {}): SummaryStep => ({
    id: `s${++seq}`,
    tool,
    args: {},
    status: 'done',
    ...p,
  })
  const search = (count: number): SummaryStep => step('search_knowledge', { count, unit: 'file' })

  // Q7：纯产物轮以前说的是「核对完成，未找到相关资料」——正文里 PPT 明明已经出来了
  const artifactOnly = [step('render_pptx')]
  check('Q7 纯产物轮不再自打脸', summaryText(artifactOnly, 4200) === '已生成产物 · 用时 4.2s', summaryText(artifactOnly, 4200))
  check('Q7 判据只认成功的产物步', !producedArtifact([step('render_pptx', { status: 'failed' })]))
  check('Q7 检索 + 产物两截都说', summaryText([search(3), step('render_document')], 1000).startsWith('检索了 3 份资料 · 已生成产物'))
  check('Q7 什么都没有仍是老那句', summaryText([search(0)], 1000) === '核对完成，未找到相关资料 · 用时 1.0s', summaryText([search(0)], 1000))

  // N9：折叠之后失败的那几步就藏起来了，摘要必须报出来
  check('N9 失败数进摘要', summaryText([search(5), step('Grep', { status: 'failed' })], 2000) === '检索了 5 份资料 · 1 步没成功 · 用时 2.0s',
    summaryText([search(5), step('Grep', { status: 'failed' })], 2000))
  check('N9 被护栏拦下的不算失败', failedCount([step('Grep', { status: 'failed', capped: true })]) === 0)
  check('N9 全成功时不出现「0 步没成功」', !summaryText([search(2)], 1000).includes('没成功'))
  check('N9 单步失败文案由 config/steps 统一给', zh('Grep', { pattern: '达人' }, { done: true, failed: true }).endsWith('（没成功）'),
    zh('Grep', { pattern: '达人' }, { done: true, failed: true }))
  check('N9 成功的步骤不带失败后缀', !zh('Grep', { pattern: '达人' }, { done: true, count: 1, unit: 'file' }).includes('没成功'))

  // Q15：档位与降级。degraded 只有真实调用才可能为真——这正是它必须在这里被验的理由
  check('Q15 标准档', tierNote('standard') === '标准档')
  check('Q15 增强档', tierNote('enhanced') === '增强档')
  check('Q15 降级时说的是「实际按什么跑的」', tierNote('enhanced', true) === '已按标准档执行', tierNote('enhanced', true))
  check('Q15 不知道档位就什么都不说', tierNote(undefined) === '')
  check(
    'Q15 档位挂在摘要末尾',
    summaryText([search(2)], 3000, { tier: 'enhanced' }) === '检索了 2 份资料 · 用时 3.0s · 增强档',
    summaryText([search(2)], 3000, { tier: 'enhanced' })
  )
  check(
    'Q15 降级 + 失败数同时出现时次序稳定',
    summaryText([search(2), step('Grep', { status: 'failed' })], 3000, { tier: 'enhanced', degraded: true }) ===
      '检索了 2 份资料 · 1 步没成功 · 用时 3.0s · 已按标准档执行',
    summaryText([search(2), step('Grep', { status: 'failed' })], 3000, { tier: 'enhanced', degraded: true })
  )
}

/**
 * ---- 退避重试（N4）----
 *
 * 429 / 503 / 网络抖动在走查里造不出来，抽成纯函数才有人测（铁律）。
 */
{
  console.log('\n【N4 退避重试】')
  const half = () => 0.5 // 抖动固定成中值：要测的是公式，不是掷骰子
  check('第 0 次 = 200ms', backoffMs(0, { rnd: half }) === 200, String(backoffMs(0, { rnd: half })))
  check('指数增长 200/400/800', [0, 1, 2].map((n) => backoffMs(n, { rnd: half })).join('/') === '200/400/800')
  check('封顶 30s', backoffMs(30, { rnd: half }) === 30_000, String(backoffMs(30, { rnd: half })))
  check('抖动落在 0.9–1.1 之间', backoffMs(3, { rnd: () => 0 }) === 1440 && backoffMs(3, { rnd: () => 0.999 }) === 1760,
    `${backoffMs(3, { rnd: () => 0 })}/${backoffMs(3, { rnd: () => 0.999 })}`)
  check('Retry-After（秒）优先于公式', backoffMs(0, { retryAfter: '5', rnd: half }) === 5000)
  check('Retry-After（HTTP-date）', backoffMs(0, { retryAfter: new Date(1_000_000 + 30_000).toUTCString(), now: 1_000_000 }) === 30_000)
  check('Retry-After 荒唐值封顶 60s', backoffMs(0, { retryAfter: '99999', rnd: half }) === 60_000)
  check('Retry-After 已过期 → 回落公式', backoffMs(1, { retryAfter: new Date(0).toUTCString(), now: 1_000_000, rnd: half }) === 400)
  check('Retry-After 认不出来 → 回落公式', backoffMs(1, { retryAfter: '稍后再试', rnd: half }) === 400)
  check('瞬态：429 / 500 / 503 / 408', [408, 429, 500, 503].every((s) => isTransient({ status: s })))
  check('非瞬态：401 / 403 / 404 / 422（重试只是把同一句拒绝听三遍）', ![401, 403, 404, 422].some((s) => isTransient({ status: s })))
  check('瞬态：网络层错误', isTransient({ error: new Error('fetch failed') }) && isTransient({ error: new Error('ECONNRESET') }))
  check('非瞬态：业务错误', !isTransient({ error: new Error('row violates row-level security policy') }))
  check('首次静默、第二次起才说话', !shouldAnnounceRetry(0) && shouldAnnounceRetry(1) && shouldAnnounceRetry(2))
  check('重试文案是人话且带次数', retryNotice('云端同步', 1, 3) === '云端同步没成功，正在重试（第 2/3 次）', retryNotice('云端同步', 1, 3))
}

/**
 * ---- 同步重试阶梯（F3：笔记上云失败真进队列）----
 *
 * 「第 4 次转手动」要等 36 分钟才走得到，「换库之后不重传别人家的笔记」要真换一次库，
 * 两条都是没人会为它跑一遍的分支——所以判据搬进了 `lib/retry-ladder.ts`。
 */
{
  console.log('\n【F3 同步重试阶梯】')
  const T = 1_000_000
  check('第 1 次失败 → 1 分钟后', nextRetryAt(1, T) === T + 60_000)
  check('第 2 次 → 5 分钟', nextRetryAt(2, T) === T + 5 * 60_000)
  check('第 3 次 → 30 分钟', nextRetryAt(3, T) === T + 30 * 60_000)
  check('第 4 次 → 0 = 转手动（出口只剩 Dock 上那颗「重试」）', nextRetryAt(4, T) === 0)
  check('tries 为 0/负数也当转手动，不许算出一个过去的时间', nextRetryAt(0, T) === 0 && nextRetryAt(-1, T) === 0)
  check(
    '到点的才取，转手动的（0）永远不进自动重试',
    JSON.stringify(pickDue([{ nextRetryAt: T - 1 }, { nextRetryAt: T + 1 }, { nextRetryAt: 0 }], T)) ===
      JSON.stringify([{ nextRetryAt: T - 1 }])
  )
  // 换库之后拿新库的根去读旧库的相对路径，读到的要么是别的文件、要么读不到——
  // 前一种会把**错内容真传上云**，这是这条闸门存在的全部理由
  const q = [
    { root: '/vault-a', rel: '80_资料库/年框.md' },
    { root: '/vault-b', rel: '80_资料库/年框.md' },
  ]
  check('只重传属于当前库的那些', JSON.stringify(notesForRoot(q, '/vault-a')) === JSON.stringify([q[0]]))
  check('没开库时一条都不重传', notesForRoot(q, null).length === 0)
}

/**
 * ---- U3 文案层（PLAN-v2 批 2 的前四条）----
 *
 * 这一批的验收判据是"界面上不许再出现某些词"，而那种事**只在真人看截图时才发现**——
 * 附录 B 那 11 条文案缺陷就是这么攒出来的。能用断言守的先守住。
 */
{
  console.log('\n【U3 文案层】阶段名用户词 / frontmatter 中文映射')
  // #6：阶段名不许再出现技术黑话。判据取"整张表"，加新阶段时也跑得到
  const JARGON = ['PII', '打标', '实体', 'MOC', '上云', '归档', 'guard', 'moc']
  for (const [id, label] of Object.entries(STAGE_LABEL)) {
    const bad = JARGON.find((w) => label.includes(w))
    check(`阶段「${id}」的用户词不含黑话`, !bad, `${label} 含「${bad}」`)
    check(`阶段「${id}」有中文用户词`, /[一-龥]/.test(label), label)
  }
  // 主流程八个阶段一个都不许漏映射（漏了就会在进度条上直接露出英文 stage id）
  for (const s of INBOX_STAGES) check(`主流程阶段 ${s} 有映射`, STAGE_LABEL[s] !== undefined)

  // #1：frontmatter 属性卡。真实键集来自走查库（doc_type/entity_kind/entities_*/rule_tagged…）
  const fm = {
    doc_type: '数据表',
    entity_kind: 'partner',
    entities_talent: ['灰太太', '皮蛋'],
    rule_tagged: true,
    sub_category: '年框',
    schema_rev: 1,
    某个没见过的键: 'x',
  }
  const split = splitFrontmatter(fm)
  const shownKeys = split.shown.map(([k]) => k)
  check('内部字段折进「更多字段」', !shownKeys.includes('rule_tagged') && !shownKeys.includes('schema_rev'))
  check('没见过的键也折起来（不摆一个英文标识符给用户）', !shownKeys.includes('某个没见过的键'))
  check('认识的键留在第一屏', shownKeys.includes('doc_type') && shownKeys.includes('entities_talent'))
  check('顺序稳定（不跟着文件里的书写顺序走）', shownKeys.indexOf('doc_type') < shownKeys.indexOf('sub_category'), shownKeys.join(','))
  check('键名给中文', fmLabel('doc_type') === '类型' && fmLabel('entities_talent') === '涉及达人')
  check('第一屏的键一个英文标识符都不许有', shownKeys.every((k) => /[一-龥]/.test(fmLabel(k))), shownKeys.map(fmLabel).join(','))
  check('值里的英文枚举也映射', formatFrontmatterValue('partner', 'entity_kind') === '合作方')
  check('裸 true/false 渲染成是/否', formatFrontmatterValue(true) === '是' && formatFrontmatterValue(false) === '否')
  check('数组照旧用斜杠连', formatFrontmatterValue(['灰太太', '皮蛋']) === '灰太太 / 皮蛋')
  check('空值仍是破折号', formatFrontmatterValue(null) === '—' && formatFrontmatterValue('  ') === '—')
}

console.log(failed ? `\n❌ ${failed} 条不通过\n` : '\n✅ 全部通过\n')
process.exit(failed ? 1 : 0)

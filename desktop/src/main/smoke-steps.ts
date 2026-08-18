import { countToolResults, isStepWorthy, pickStepArgs, shortToolName, toolResultText } from './agent/steps'
import { describeStep, durationHint, scanTarget } from '../renderer/src/config/steps'

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
check('超长入参截断到 120', (pickStepArgs('Read', { file_path: 'a'.repeat(500) }).file ?? '').length === 120)
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
check('检索（进行中，带真实关键词）', zh('search_knowledge', { query: '年度目标' }) === '正在检索资料库：年度目标')
check('检索（完成，带命中数）', zh('search_knowledge', { query: '年度目标' }, { done: true, count: 5 }) === '检索了资料库：年度目标（5 条）')
check(
  '检索（完成，相近结果要标出来）',
  zh('search_knowledge', { query: '灰太太' }, { done: true, count: 6, approx: true }) === '检索了资料库：灰太太（相近结果 6 条）'
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
check('验证性扫描（进行中）', zh('Glob', { pattern: '*.md' }, { verify: true }) === '正在确认库中没有相关记录')
check('验证性扫描（完成且真没有）', zh('Glob', { pattern: '*.md' }, { verify: true, done: true, count: 0 }) === '已确认库中没有相关记录')
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

console.log(failed ? `\n❌ ${failed} 条不通过\n` : '\n✅ 全部通过\n')
process.exit(failed ? 1 : 0)

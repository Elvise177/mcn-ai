/**
 * 本地 embedding 的打包形态冒烟（第三单，2026-09-05）。
 *
 * 它要验的是**原生模块在包里能不能起来**——onnxruntime-node 是 .node + dylib，必须在 asar.unpacked 里、
 * 必须被签名，这些只有打包形态才炸。所以这个入口既能在开发目录跑，也要能从 .app 里跑：
 *
 *   开发：  ELECTRON_RUN_AS_NODE=1 electron out/main/smoke-embed.js
 *   包内：  ELECTRON_RUN_AS_NODE=1 <App>/Contents/MacOS/SamePage <App>/Contents/Resources/app.asar/out/main/smoke-embed.js
 *
 * 断言：模型加载成功、4 段文本向量与选型实验（transformers.js 口径）的参考余弦逐位一致（≥0.9999）、
 * 同义句相似度高于无关句、960 篇量级批量耗时可接受。
 */
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Embedder, cosine, EMBED_DIM, MODEL_ID } from './vault/embedder'
import { EmbedIndex, embedIndexDir } from './vault/embed-index'
import { isCloudSyncSkipped } from './lib/sensitive'
import type { VaultNote } from './vault/types'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const e = new Embedder(Number(process.env.SMOKE_EMBED_THREADS || 1))
  console.log(`模型目录：${e.dir}`)
  const info = await e.load()
  check('模型加载', info.ok, info.reason)
  if (!info.ok) return
  console.log(`  加载 ${info.loadMs}ms`)

  const texts = [
    '社群VIP。美妆带货社群VIP课程包培训方案，含课程与实操模型',
    '付费社群里的学员总是潜水不动手，有什么办法逼她们发出第一条视频？',
    'OMG美妆x向日花年框合作 · 2026年中复盘会议纪要（半年度复盘）',
    'bge-small-zh test 123 ABC！',
  ]
  const t0 = Date.now()
  const vecs = await e.embed(texts)
  console.log(`  4 段文本 ${Date.now() - t0}ms，维度 ${vecs[0].length}`)
  check('维度 512', vecs[0].length === EMBED_DIM)
  check('已归一化', vecs.every((v) => Math.abs(cosine(v, v) - 1) < 1e-4))
  // 参考值来自 scratch 里 transformers.js 的 CLS+normalize 输出（2026-09-05）：前 3 维 × 4 段。任何一位漂了都说明分词或池化口径变了
  const REF = [
    [-0.05727, -0.00152, 0.01832],
    [-0.07199, 0.05581, 0.01269],
    [-0.00271, 0.0252, -0.00243],
    [-0.01582, 0.02944, 0.01775],
  ]
  const drift = vecs.map((v, i) => Math.max(...REF[i].map((r, k) => Math.abs(v[k] - r))))
  // 容差 0.005：onnxruntime 1.21 → 1.29 的 q8 内核有 ~0.002 的数值差（不影响名次），但分词/池化口径错了会差一个量级
  check('与 transformers.js 参考向量一致（前 3 维 |Δ|<0.005）', drift.every((d) => d < 0.005), drift.map((d) => d.toFixed(4)).join(','))
  const simRelated = cosine(vecs[0], vecs[1])
  const simUnrelated = cosine(vecs[0], vecs[3])
  check(`语义：社群VIP 摘要 vs 潜水问句 (${simRelated.toFixed(3)}) > vs 无关串 (${simUnrelated.toFixed(3)})`, simRelated > simUnrelated + 0.1)

  const many = Array.from({ length: 960 }, (_, i) => texts[i % 4] + i)
  const t1 = Date.now()
  for (let i = 0; i < many.length; i += 16) await e.embed(many.slice(i, i + 16))
  const ms = Date.now() - t1
  console.log(`  960 篇 ${ms}ms（${(ms / 960).toFixed(2)} ms/篇），RSS ${Math.round(process.memoryUsage().rss / 1048576)} MB`)
  check('960 篇 < 60 s（超了要改成分片续建）', ms < 60_000)
  if (process.env.SMOKE_EMBED_SKIP_UNLOAD !== '1') {
    await e.unload()
    check('卸载后 ready=false', !e.ready)
  }

  await indexLifecycle()
}

/**
 * ---- 索引生命周期（第四单，2026-09-06）----
 *
 * 语义索引是**一份能与库脱节的派生文件**，而它脱节的时候界面上没有任何异样：
 * 检索照常返回，只是把已经不存在的文件摆到模型面前，模型 Read 一下报"找不到"。
 * 这一段用 6 篇合成笔记 + 两个临时库把四件事钉死，全程零 LLM、零网络：
 *
 *   ① 语义命中：问法与文档**零共词**时能不能捞出该读的那一篇（这是整条通道存在的理由）
 *   ② 集合差增量：改一篇 → 只重算那一篇；删一篇 → 向量与 .bin 里都不许再有它
 *   ③ 重命名：旧名剔除、新名进索引（重命名 = unlink + add，向量重算一次）
 *   ④ 换库：索引跟着库走，上一个库的笔记**一条都不许**出现在新库的索引里
 *      （这条不是假想：`open()` 是"立即返回、后台接着算"的，没有换库代号闸门时
 *       旧库那一轮 build 会把向量写进新库的 meta——见 embed-index.ts 的 `gen`）
 *
 * 为什么放在 smoke:embed 而不是 smoke:vault：这些断言要真跑模型（几秒），
 * 而 smoke:vault 是纯索引/图谱层、要外部真实库当参数；这里已经把模型加载起来了。
 */
async function indexLifecycle(): Promise<void> {
  console.log('\n【索引生命周期】集合差增量 / 删除剔除 / 重命名 / 换库')
  const note = (path: string, summary: string): VaultNote => ({
    path,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    frontmatter: { summary },
    links: [],
    tags: [],
    mtimeMs: 0,
  })
  /** 6 篇：前 5 篇各说一件事，第 6 篇是"问法与它零共词"的那一篇（语义通道要救的正是这种） */
  const corpus: Array<[string, string]> = [
    ['80_资料库/年框合同.md', '与向日花的年度框架合作条款、结算周期与违约责任'],
    ['80_资料库/直播脚本.md', '双十一专场直播口播脚本，含开场、憋单与逼单话术'],
    ['80_资料库/报销制度.md', '差旅与办公用品的报销标准、审批链路与凭证要求'],
    ['80_资料库/新人培训.md', '新同事入职第一周的学习路径与带教安排'],
    ['30_实体/达人/灰太太.md', '达人档案：主营护肤测评，粉丝画像与历史合作记录'],
    ['80_资料库/社群VIP.md', '美妆带货社群VIP课程包培训方案，含课程与实操模型'],
  ]
  const mkNotes = (list: Array<[string, string]>): Map<string, VaultNote> =>
    new Map(list.map(([p, s]) => [p, note(p, s)]))
  const bodies = new Map<string, string>()

  const rootA = join(tmpdir(), `mcnai-embed-smoke-a-${process.pid}`)
  const rootB = join(tmpdir(), `mcnai-embed-smoke-b-${process.pid}`)
  await fs.rm(rootA, { recursive: true, force: true })
  await fs.rm(rootB, { recursive: true, force: true })
  await fs.mkdir(rootA, { recursive: true })
  await fs.mkdir(rootB, { recursive: true })

  const idx = new EmbedIndex()
  try {
    idx.open(rootA, mkNotes(corpus), bodies)
    const st = await idx.whenSettled()
    check(`首建：${corpus.length} 篇全部进索引`, st.state === 'ready' && st.count === corpus.length, `${st.state} ${st.count} ${st.reason ?? ''}`)

    // 索引文件落在 .mcnai/embeddings 里，而那整个目录是 cloudSync walk 跳过的（第三单【9】守着）
    check('索引落在 <库>/.mcnai/embeddings', existsSync(join(embedIndexDir(rootA), `${MODEL_ID}.bin`)))
    check('索引所在目录不进上传清单', isCloudSyncSkipped('.mcnai'))

    // ① 零共词的问法：「潜水的学员怎么逼她们动手」→ 《社群VIP》
    const hits = await idx.search('付费社群里学员总是潜水不动手怎么办', 3)
    check(
      '语义命中：零共词问句 top-3 里有《社群VIP》',
      hits.some((h) => h.path.endsWith('社群VIP.md')),
      hits.map((h) => `${h.path}:${h.score.toFixed(2)}`).join(' | ')
    )

    // ② 集合差增量：改一篇的摘要 → 只该重算这一篇；其余命中缓存
    const edited = corpus.map(([p, s]) => [p, p.endsWith('报销制度.md') ? s + '（2026 年新版，标准上调）' : s] as [string, string])
    const r1 = await idx.sync(mkNotes(edited), bodies)
    check('集合差：只重算改过的那一篇', r1.ok && r1.added === 1 && r1.removed === 0, JSON.stringify(r1))
    const r2 = await idx.sync(mkNotes(edited), bodies)
    check('集合差：内容没变就一篇都不算（不看 mtime）', r2.ok && r2.added === 0 && r2.removed === 0, JSON.stringify(r2))

    // ② 删除：集合里少一篇 → 索引剔掉，且**盘上那份也不许留**（否则重启后它又冒回来）
    const afterDelete = edited.filter(([p]) => !p.endsWith('直播脚本.md'))
    const r3 = await idx.sync(mkNotes(afterDelete), bodies)
    check('删除同步：剔掉 1 篇', r3.ok && r3.removed === 1 && r3.count === afterDelete.length, JSON.stringify(r3))
    const gone = await idx.search('双十一专场直播口播开场憋单逼单话术', 10)
    check('删掉的文件不会再从语义通道冒出来', !gone.some((h) => h.path.endsWith('直播脚本.md')), gone.map((h) => h.path).join(' | '))
    const metaRaw = JSON.parse(await fs.readFile(join(embedIndexDir(rootA), `${MODEL_ID}.json`), 'utf-8')) as {
      entries: Array<{ path: string }>
    }
    check('盘上的索引也不再含它（重启后不会复活）', !metaRaw.entries.some((x) => x.path.endsWith('直播脚本.md')))

    // ②b 单篇 remove（watcher 的 unlink 与 deleteNote 走的就是这条）：幂等，且立刻生效
    idx.remove('80_资料库/新人培训.md')
    idx.remove('80_资料库/新人培训.md') // 再删一次不许炸
    const afterRemove = await idx.search('入职第一周的学习路径与带教安排', 10)
    check('unlink 路径：remove 立刻生效且幂等', !afterRemove.some((h) => h.path.endsWith('新人培训.md')) && idx.status().count === afterDelete.length - 1)

    // ③ 重命名 = 旧名剔除 + 新名进索引（unlink + add）
    const renamed = afterDelete
      .filter(([p]) => !p.endsWith('新人培训.md'))
      .map(([p, s]) => [p.endsWith('年框合同.md') ? '80_资料库/向日花年框合同.md' : p, s] as [string, string])
    const r4 = await idx.sync(mkNotes(renamed), bodies)
    check('重命名：旧名剔除 + 新名入索引', r4.ok && r4.added === 1 && r4.removed === 1, JSON.stringify(r4))
    const nameHits = await idx.search('年度框架合作条款与结算周期', 10)
    check(
      '重命名后只认新名字',
      nameHits.some((h) => h.path.endsWith('向日花年框合同.md')) && !nameHits.some((h) => h.path === '80_资料库/年框合同.md'),
      nameHits.map((h) => h.path).join(' | ')
    )

    // ④ 换库：索引跟着库走，A 库的笔记一条都不许出现在 B 库里
    const bCorpus: Array<[string, string]> = [['90_产物/季度复盘.md', '第三季度业务复盘：达人产出、投放效率与下季度目标']]
    await idx.close()
    idx.open(rootB, mkNotes(bCorpus), bodies)
    const stB = await idx.whenSettled()
    check('换库：新库索引只有新库的篇数', stB.state === 'ready' && stB.count === bCorpus.length, `${stB.state} ${stB.count}`)
    const cross = await idx.search('年度框架合作条款与结算周期', 10)
    check('换库：上一个库的笔记一条都不许冒出来', cross.every((h) => h.path.startsWith('90_产物/')), cross.map((h) => h.path).join(' | '))
    check('换库：A 库的索引文件原地留着（回去还能直接读回）', existsSync(join(embedIndexDir(rootA), `${MODEL_ID}.bin`)))
    await idx.close()
  } finally {
    await fs.rm(rootA, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(rootB, { recursive: true, force: true }).catch(() => undefined)
  }
}

main()
  .then(async () => {
    console.log(failed ? `\n❌ ${failed} 条失败` : '\n✅ 全部通过')
    if (process.env.SMOKE_EMBED_NO_EXIT === '1') {
      process.exitCode = failed ? 1 : 0
      return
    }
    if (process.env.SMOKE_EMBED_EXIT_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_EMBED_EXIT_DELAY)))
    process.exit(failed ? 1 : 0)
  })
  .catch((err) => {
    console.error('SMOKE 崩溃：', err)
    process.exit(1)
  })

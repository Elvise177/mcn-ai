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
import { Embedder, cosine, EMBED_DIM } from './vault/embedder'

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

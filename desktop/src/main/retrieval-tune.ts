/**
 * 检索排名参数的**离线回归**（检索优化第二单）。零 LLM、零花费。
 *
 * 干什么：拿一份 bench 跑批结果里**模型真实用过的检索词**（`results.jsonl` 的 `searches[].query`），
 * 在改过引擎（dir 字段 / n−1 AND / 排名参数）的索引上逐条重放，看应命中文件有没有进前 N。
 * 每组参数跑一遍，出一张表；参数不拍脑袋，看表定。
 *
 * 口径：
 *  - 直接命中：应命中文件出现在任一检索词的前 N 条里
 *  - 经主题页命中：应命中文件没进前 N，但某个进了前 N 的 wiki 主题页的摘要区**列了它**——
 *    模型读主题页就能顺链接读到它。这是主题页存在的意义，单独报一列，不与直接命中混
 *  - T-1 守门：「珀莱雅 年框 结案」必须**不是**精确命中——要么 0，要么 dropped=珀莱雅 的放松命中
 *
 * 只在**调参集**（bench.jsonl 里 `split: tune`）上看；验证集留给真跑 bench 报数（用户拍板，2026-09-05）。
 *
 * 用法：MCNAI_USER_DATA=/tmp/mcnai-bench-userdata electron out/main/retrieval-tune.js <job.json>
 * job = { vaults, bench, results, grid: RankParams[], split: 'tune'|'validate'|'all', shown: 10 }
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

process.env.MCNAI_USER_DATA = process.env.MCNAI_USER_DATA || '/tmp/mcnai-bench-userdata'
app.setPath('userData', process.env.MCNAI_USER_DATA)

interface Q {
  id: string
  type: string
  vault: string
  question: string
  expected_files: string[]
  split?: string
}
interface Job {
  vaults: Record<string, string>
  bench: string
  results: string
  grid: Array<Record<string, number> | null>
  split: 'tune' | 'validate' | 'all'
  shown: number
  /** 探针：指定检索词下，若干目标文件的名次（看参数有没有真的把它们往前挪） */
  probes?: Array<{ vault: string; query: string; expect: string[] }>
}

const noteKey = (p: string): string => p.replace(/\.md$/i, '').toLowerCase()
const pct = (x: number | null): string => (x == null ? '—' : `${(x * 100).toFixed(0)}%`)

async function main(): Promise<void> {
  const job = JSON.parse(readFileSync(process.argv[2], 'utf-8')) as Job
  const { vaultManager } = await import('./vault')
  const { buildWikiPages } = await import('./vault/wiki-pages')
  const { readVaultConfig } = await import('./vault/taxonomy')

  const bench = readFileSync(job.bench, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Q)
  const qs = bench.filter((q) => job.split === 'all' || (q.split ?? 'tune') === job.split)
  const runs = readFileSync(job.results, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const queriesOf = new Map<string, string[]>()
  for (const r of runs) queriesOf.set(r.id, (r.searches ?? []).map((s: { query: string }) => s.query))

  // 主题页 → 它列了哪些文件（读自动区里的 [[链接]]）
  const wikiLinks = new Map<string, Set<string>>()
  const loadWiki = (root: string, dir: string): void => {
    wikiLinks.clear()
    const abs = join(root, dir)
    if (!existsSync(abs)) return
    for (const f of require('fs').readdirSync(abs) as string[]) {
      if (!f.endsWith('.md')) continue
      const text = readFileSync(join(abs, f), 'utf-8')
      const set = new Set<string>()
      for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) set.add(noteKey(m[1].trim()))
      wikiLinks.set(noteKey(join(dir, f)), set)
    }
  }

  type Row = { id: string; type: string; hit: number; via: number; exp: number; dropped: string[] }
  const grid = job.grid.length ? job.grid : [null]
  const tables: Array<{ params: Record<string, number> | null; rows: Row[]; guard: string }> = grid.map((g) => ({ params: g, rows: [], guard: '' }))

  const byVault = new Map<string, Q[]>()
  for (const q of qs) byVault.set(q.vault, [...(byVault.get(q.vault) ?? []), q])

  for (const [vault, list] of byVault) {
    const root = job.vaults[vault]
    const cfg = await readVaultConfig(root)
    const w = await buildWikiPages(root, cfg.library)
    console.log(`[tune] ${vault}: 主题页 ${w.topics}（敏感 ${w.sensitivePages}）`)
    loadWiki(root, w.dir)
    await vaultManager.open(root)
    await vaultManager.search('复盘')
    for (let gi = 0; gi < grid.length; gi++) {
      vaultManager.configureSearch(grid[gi])
      await new Promise((r) => setTimeout(r, 50))
      for (const q of list) {
        const exp = q.expected_files.map(noteKey)
        const seen = new Set<string>()
        const dropped: string[] = []
        for (const query of queriesOf.get(q.id) ?? []) {
          const r = await vaultManager.search(query)
          if (r.dropped) dropped.push(`${query}→去${r.dropped}`)
          for (const h of r.hits.slice(0, job.shown)) seen.add(noteKey(h.path))
        }
        const hit = exp.filter((f) => seen.has(f)).length
        const via = exp.filter((f) => !seen.has(f) && [...seen].some((s) => wikiLinks.get(s)?.has(f))).length
        if (process.env.TUNE_DEBUG === q.id) {
          console.log(`  [debug ${q.id}] exp=${JSON.stringify(exp)} seen=${JSON.stringify([...seen])} pages=${JSON.stringify([...wikiLinks.keys()].slice(0, 3))} link0=${JSON.stringify([...(wikiLinks.values().next().value ?? [])].slice(0, 2))}`)
        }
        tables[gi].rows.push({ id: q.id, type: q.type, hit, via, exp: exp.length, dropped })
      }
      for (const pr of (job.probes ?? []).filter((x) => x.vault === vault)) {
        const r = await vaultManager.search(pr.query)
        const ranks = pr.expect.map((e) => {
          const i = r.hits.findIndex((h) => noteKey(h.path) === noteKey(e) || noteKey(h.path).endsWith('/' + noteKey(e)))
          return `${e.split('/').pop()}=${i >= 0 ? i + 1 : r.total > r.hits.length ? '>' + r.hits.length : '无'}`
        })
        const pages = r.hits.slice(0, job.shown).filter((h) => h.path.includes('/主题/')).map((h) => h.title)
        console.log(`  [probe ${gi}] ${vault}「${pr.query}」共 ${r.total}${r.fuzzy ? ' 相近' : ''}${r.dropped ? ` 去「${r.dropped}」` : ''}：${ranks.join(' ')}${pages.length ? `  前${job.shown}里的主题页：${pages.join('、')}` : ''}`)
      }
      if (vault === 'maggie') {
        const g = await vaultManager.search('珀莱雅 年框 结案')
        tables[gi].guard = g.total === 0 ? '0 命中 ✓' : g.dropped ? `放松命中（去「${g.dropped}」）${g.dropped === '珀莱雅' ? ' ✓' : ' ✗'}` : g.fuzzy ? '相近结果 ✓' : `精确命中 ${g.total} 条 ✗`
      }
    }
  }

  const types = ['keyword', 'semantic', 'multi', 'sensitive']
  console.log(`\n参数 | ${types.map((t) => `${t} 召回/全命中(+主题页)`).join(' | ')} | T-1 守门`)
  for (const t of tables) {
    const cells = types.map((ty) => {
      const rows = t.rows.filter((r) => r.type === ty)
      if (!rows.length) return '—'
      const recall = rows.reduce((a, r) => a + r.hit / r.exp, 0) / rows.length
      const all = rows.filter((r) => r.hit === r.exp).length / rows.length
      const allVia = rows.filter((r) => r.hit + r.via === r.exp).length / rows.length
      const recallVia = rows.reduce((a, r) => a + (r.hit + r.via) / r.exp, 0) / rows.length
      return `${pct(recall)}/${pct(all)} (+页 ${pct(recallVia)}/${pct(allVia)})`
    })
    console.log(`${JSON.stringify(t.params ?? '出厂')} | ${cells.join(' | ')} | ${t.guard}`)
  }
  const best = tables[0]
  console.log('\n逐题（第一组参数）：')
  for (const r of best.rows) console.log(`  ${r.id} ${r.type} ${r.hit}/${r.exp}${r.via ? ` +页${r.via}` : ''}${r.dropped.length ? `  放松:${r.dropped.join(' ; ')}` : ''}`)
  await vaultManager.close()
  app.exit(0)
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('TUNE 失败：', e)
    app.exit(1)
  })
)

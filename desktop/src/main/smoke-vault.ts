/**
 * M1 冒烟：用真实 vault 无头验证索引/图谱/检索/双链解析。
 * 运行：ELECTRON_RUN_AS_NODE=1 electron out/main/smoke-vault.js <vault路径>
 */
import { VaultManager } from './vault'

async function main(): Promise<void> {
  const root = process.argv[2]
  if (!root) {
    console.error('用法: smoke-vault.js <vault路径>')
    process.exit(1)
  }
  const vm = new VaultManager()
  const t0 = Date.now()
  const { noteCount } = await vm.open(root)
  const tScan = Date.now() - t0

  const graph = vm.graph()
  // 检索索引在后台分片构建，等它完成再断言全量命中
  await new Promise((r) => setTimeout(r, 6000))
  const hits = await vm.search(process.argv[3] || '引流课')
  const resolved = vm.resolveLink('灰太太')
  const tree = vm.tree()
  const sample = noteCount > 0 ? await vm.read(graph.nodes[0].id) : null

  console.log(
    JSON.stringify(
      {
        noteCount,
        scanMs: tScan,
        graph: { nodes: graph.nodes.length, links: graph.links.length },
        topDirs: tree.filter((n) => n.children).map((n) => n.name),
        searchHits: hits.slice(0, 3).map((h) => h.title),
        resolveLink_灰太太: resolved,
        sampleRead: sample ? { title: sample.title, fmKeys: Object.keys(sample.frontmatter).length } : null,
      },
      null,
      2
    )
  )
  await vm.close()
  process.exit(noteCount > 0 && graph.links.length > 0 ? 0 : 2)
}

main()

#!/usr/bin/env node
/**
 * 拉取随包分发的本地 embedding 模型到 `resources/models/`（gitignored，同 resources/pipeline 的处置）。
 *
 * 模型：bge-small-zh-v1.5 的 q8 ONNX（Xenova 转换版），三个文件 ~24 MB。**sha256 逐个校验**——
 * 权重文件换了而没人知道，等于检索口径静默漂移（选型实验与 smoke:embed 的参考向量都会失效）。
 * 先试 hf-mirror.com（国内可达），再回 huggingface.co。已存在且校验通过的跳过。
 *
 * 跑法：node scripts/fetch-models.mjs   （打包前 `npm run dist` 之前跑一次；smoke:embed 会告诉你缺不缺）
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODEL = 'bge-small-zh-v1.5'
const REPO = 'Xenova/bge-small-zh-v1.5'
const DEST = join(ROOT, 'resources', 'models', MODEL)
const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']

/** 文件 → sha256（2026-09-05 从 HF 拉下来的那一版；换文件必须同步改这里并重跑选型实验） */
const FILES = {
  'onnx/model_quantized.onnx': { to: 'model_quantized.onnx', sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc' },
  'tokenizer.json': { to: 'tokenizer.json', sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
  'config.json': { to: 'config.json', sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

async function fetchFrom(path) {
  let lastErr
  for (const base of MIRRORS) {
    const url = `${base}/${REPO}/resolve/main/${path}`
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      lastErr = `${url}: ${e.message}`
      console.log(`  ${lastErr}，换源`)
    }
  }
  throw new Error(`两个源都拉不到 ${path}：${lastErr}`)
}

mkdirSync(DEST, { recursive: true })
let bad = 0
for (const [remote, { to, sha256 }] of Object.entries(FILES)) {
  const dest = join(DEST, to)
  if (existsSync(dest) && sha(readFileSync(dest)) === sha256) {
    console.log(`✓ ${to} 已存在且校验通过`)
    continue
  }
  console.log(`↓ ${remote}`)
  const buf = await fetchFrom(remote)
  const got = sha(buf)
  if (got !== sha256) {
    bad++
    console.log(`✗ ${to} sha256 不符：期望 ${sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…（未落盘）`)
    continue
  }
  writeFileSync(dest, buf)
  console.log(`✓ ${to} ${(buf.length / 1048576).toFixed(1)} MB`)
}
if (bad) {
  console.log(`\n❌ ${bad} 个文件校验失败——上游换了权重？先别打包，去 docs/PLAN-retrieval-embedding.md 看选型实验怎么重跑`)
  process.exit(1)
}
console.log(`\n✅ 模型就位：${DEST}`)

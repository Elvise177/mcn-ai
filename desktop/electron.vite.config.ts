import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'smoke-agent': resolve(__dirname, 'src/main/smoke-agent.ts'),
          'smoke-vault': resolve(__dirname, 'src/main/smoke-vault.ts'),
          'search-worker': resolve(__dirname, 'src/main/vault/search-worker.ts'),
          'smoke-chat': resolve(__dirname, 'src/main/smoke-chat.ts'),
          'smoke-provider': resolve(__dirname, 'src/main/smoke-provider.ts'),
          'smoke-resume': resolve(__dirname, 'src/main/smoke-resume.ts'),
          'smoke-steps': resolve(__dirname, 'src/main/smoke-steps.ts'),
          'smoke-cards': resolve(__dirname, 'src/main/smoke-cards.ts'),
          'smoke-write-guard': resolve(__dirname, 'src/main/smoke-write-guard.ts'),
          'smoke-taxonomy': resolve(__dirname, 'src/main/smoke-taxonomy.ts'),
          'smoke-guards': resolve(__dirname, 'src/main/smoke-guards.ts'),
          'smoke-usage': resolve(__dirname, 'src/main/smoke-usage.ts'),
          // 本地 embedding 的打包形态冒烟（第三单）：开发目录与 .app 内都要能跑
          'smoke-embed': resolve(__dirname, 'src/main/smoke-embed.ts'),
          // 检索准确率基准的无头驱动（scripts/retrieval-bench.mjs 调），与 smoke-* 同一类：不被应用引用
          'retrieval-bench': resolve(__dirname, 'src/main/retrieval-bench.ts'),
          // 检索排名参数的离线回归（零 LLM），同上
          'retrieval-tune': resolve(__dirname, 'src/main/retrieval-tune.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') },
    },
  },
})

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

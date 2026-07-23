#!/bin/bash
# 外部资料分流版 · 最终构建与验收（在用户终端运行）
set -e
cd "$(dirname "$0")/.."

echo "== 1/5 Electron 二进制检查 =="
if [ ! -f node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]; then
  Z=$(ls ~/Library/Caches/electron/*/electron-v31.7.7-darwin-arm64.zip 2>/dev/null | head -1)
  if [ -z "$Z" ]; then
    echo "缓存无 zip，用国内镜像下载..."
    (cd node_modules/electron && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js)
  else
    rm -rf node_modules/electron/dist && mkdir node_modules/electron/dist
    ditto -x -k "$Z" node_modules/electron/dist/
  fi
fi
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron -e "console.log('electron ok')"

echo "== 2/5 构建 =="
npm run build

echo "== 3/5 GUI 走查（含外部资料分流断言）=="
node e2e/walkthrough.mjs

echo "== 4/5 打 dmg =="
npm run dist
ls -lh release/*.dmg | tail -1

echo "== 5/5 打包形态回归 =="
MCNAI_APP_BIN="release/mac-arm64/mcn-ai.app/Contents/MacOS/mcn-ai" node e2e/walkthrough.mjs

echo ""
echo "✅ 全部通过：新 dmg 在 desktop/release/，含外部资料自动分流功能"

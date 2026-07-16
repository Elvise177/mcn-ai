# desktop 开发规则

## 验收铁律（2026-07-16 起）

**「构建通过」不等于「功能可用」。任何 UI 相关改动，交付前必须跑 GUI 走查并逐张检视截图：**

```bash
npm run build && node e2e/walkthrough.mjs   # 截图在 e2e/shots/，AI 必须 Read 每张截图确认
```

- 走查完全隔离：独立 userData（/tmp/mcnai-e2e-userdata）+ maggie-vault 副本（/tmp/mcnai-e2e-vault），不碰真实数据
- **截图只证明"长这样"，不证明"能用"**：每个可点击的核心控件（新对话/发送/切换/删除…）必须在走查里真点一次并断言结果状态（2026-07-16 ＋新对话失效教训——截图全绿但按钮点了丢对话）
- 新功能必须往 walkthrough.mjs 里加对应步骤（新页面/新交互 = 新截图点）
- 引擎层改动跑对应 smoke：`smoke-vault.js <vault>`（索引/图谱/检索）、`smoke:agent`（AI 链路）
- 截图里发现的问题先修完再交付，不许把 GUI 验收留给用户

## 常用命令

- 开发：`npm run dev`　类型检查：`npm run typecheck`　打包：`npm run dist`
- pipeline 冻结（在 pkb-pipeline 仓库）：pyinstaller 命令见 git log；产物拷入 `resources/pipeline/`

/**
 * make-ppt 真产出验收：**附件图 + 库内嵌图 + 原生 chart 三样齐**。
 * 运行: node e2e/make-ppt.mjs
 *
 * **手动跑，不进常规走查**：它是真实 LLM 调用，一次约 **¥0.4**、90 秒上下。
 * 常规走查里已有 make-docx 的产出断言，PPT 这条留给"改了 render_pptx / PPT_GUIDE /
 * 附件链路"时手动验一次。
 *
 * **前提**：`/tmp/mcnai-full-vault` + `/tmp/mcnai-full-userdata`（`e2e/full-rerun.mjs` 跑出来的，
 * 库里有实体卡与嵌图、userData 里有 key）。/tmp 重启会清，没有就先跑 full-rerun.mjs。
 *
 * **验收不能只看"文件生成了"**：跑完拿 python-pptx 逐页反读——chart 必须是真的图表对象
 * （`COLUMN_CLUSTERED` 且 series 数值与库内表格对得上）、图片必须是 PICTURE 且宽高比没被压扁。
 * 2026-08-18 实测：4→5 页，chart 六个月 GMV 真实数字，附件图 11.73×4.16in、嵌图 7.76×4.50in。
 */
import { _electron as electron } from 'playwright-core'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
const root='/Users/tansenpeng/Documents/AI/mcn-ai/desktop'
const VAULT='/tmp/mcnai-full-vault'
const PIC='/tmp/mcnai-attach-pic1.png'
const app=await electron.launch({executablePath:join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[root],
  env:{...process.env,MCNAI_USER_DATA:'/tmp/mcnai-full-userdata',MCNAI_VAULT:VAULT,NODE_ENV:'production'},timeout:60000})
const win=await app.firstWindow(); await win.waitForLoadState('domcontentloaded'); await win.waitForTimeout(3000)
const st=await win.evaluate(()=>window.api.settings.get())
console.log('线路自检:', JSON.stringify({aiReady:st.aiReady, 标准档:st.tiers?.find(t=>t.id==='standard')?.baseUrl}))
if(!st.aiReady){console.error('❌ 没有对话 key，跑不了');await app.close();process.exit(1)}
await app.evaluate(({dialog},f)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[f]})},PIC)
// full-rerun 那轮结束时是登出状态，重开会停在登录门
await win.click('text=暂不登录').catch(()=>{})
await win.waitForTimeout(800)
await win.click('text=新对话').catch(()=>{})
await win.waitForTimeout(800)
if(!(await win.locator('[data-testid="attach-btn"]').count())){
  const dump=await win.evaluate(()=>document.body.innerText.slice(0,300))
  console.error('界面上找不到附件按钮，当前页面文本：\n'+dump)
}
await win.click('[data-testid="attach-btn"]')
await win.locator('[data-testid="attach-strip"]').waitFor({timeout:8000})
console.log('附件已挂:', PIC)
const before=new Set(existsSync(join(VAULT,'90_产物'))?readdirSync(join(VAULT,'90_产物')):[])
await win.locator('textarea').first().fill(
  '把灰太太的带货数据做成一个 4 页 PPT，文件名用「灰太太月度复盘」。要求：'+
  '①其中一页必须是数据图表（chart，柱状），数据用库里查到的真实数字；'+
  '②把我这条消息里的附件图片单独放一页；'+
  '③再找一张库内笔记里的嵌图放进去。内容必须来自库里检索到的资料。')
const t0=Date.now()
await win.keyboard.press('Enter')
for(let i=0;i<180;i++){await win.waitForTimeout(5000)
  const t=await win.evaluate(()=>window.api.tasks.list())
  const ag=(t.tasks??t).filter?.(x=>x.kind==='agent')??[]
  if(ag.length&&!ag.some(x=>x.status==='running'||x.status==='queued')) break}
console.log('耗时秒:',((Date.now()-t0)/1000).toFixed(1))
const after=readdirSync(join(VAULT,'90_产物')).filter(n=>!before.has(n))
console.log('新增产物目录:',after)
for(const d of after){const p=join(VAULT,'90_产物',d)
  if(statSync(p).isDirectory()) for(const f of readdirSync(p)) console.log('  →',join(p,f))}
const msgs=await win.evaluate(async()=>{const l=await window.api.chat.list();return l[0]?.messages?.map(m=>({r:m.role,t:m.text.slice(0,200),err:!!m.error}))})
console.log('对话尾:',JSON.stringify(msgs?.slice(-2),null,1))
await Promise.race([app.close(),new Promise(r=>setTimeout(r,15000))])

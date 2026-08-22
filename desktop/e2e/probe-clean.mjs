import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
for (const [tpl, tag] of [['general','通用'],['mcn','MCN']]) {
  const UD=`/tmp/mcnai-clean-ud-${tpl}`, NEW=`/tmp/mcnai-clean-vault-${tpl}`
  rmSync(UD,{recursive:true,force:true}); rmSync(NEW,{recursive:true,force:true}); mkdirSync(UD,{recursive:true})
  const app = await electron.launch({ args:['.'], env:{ ...process.env, MCNAI_USER_DATA:UD, MCNAI_E2E_NEW_VAULT:NEW, MCNAI_VAULT:'' } })
  const win = await app.firstWindow(); await win.waitForTimeout(2500)
  await win.click('text=暂不登录').catch(()=>{})
  await win.waitForTimeout(1000)
  await win.click('[data-testid="wizard-create"]'); await win.waitForTimeout(500)
  if (tpl==='general') await win.screenshot({ path:'e2e/shots/B3-02-模板选择.png' })
  await win.click(`[data-testid="wizard-template-${tpl}"]`); await win.waitForTimeout(5000)
  await win.screenshot({ path:`e2e/shots/B3-03-${tag}模板-工作台.png` })
  await win.click('text=个人知识库').catch(()=>{}); await win.waitForTimeout(2500)
  await win.screenshot({ path:`e2e/shots/B3-04-${tag}模板-知识库.png` })
  const dirs = readdirSync(NEW,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort()
  const cfg = JSON.parse(readFileSync(join(NEW,'.mcnai/layout.json'),'utf-8'))
  const chips = await win.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.innerText.trim()))
  console.log(`【${tag}】目录 ${JSON.stringify(dirs)}`)
  console.log(`      persona=${cfg.persona.id} 分类=${cfg.categories.top.map(c=>c.name).join('/')}`)
  await app.close()
}
process.exit(0)

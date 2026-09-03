import { ui } from '../components/ui'
import { errText } from './err'

/**
 * 设置项落盘的统一收口（Q14）。
 *
 * 病症：设置页里五处 `settings.set*` 的返回值被 `void` 扔掉了——
 * 勾一个复选框、改一个地址，**成功和失败长得一模一样**（都是什么都不发生）。
 * 失败时用户以为存上了，下次启动发现没有，只会认为"这软件不记设置"。
 *
 * 两条取向：
 *  · **成功也说话**，但只说一句最短的（「已保存」）。设置项没有别的反馈渠道——
 *    复选框自己会变，但那是本地 state 变了，不代表落盘成功。
 *  · **失败必须带原因**，并且用 error 语义（红叉）——它需要用户处理。
 */
export async function saveWithToast<T extends { ok?: boolean; error?: string }>(
  what: string,
  run: () => Promise<T>
): Promise<T | null> {
  try {
    const r = await run()
    // 有些通道回的是 `{ ok:true }`，有些（如 setTierConfig）回的是带数据的对象、没有 ok 字段。
    // **只有显式 `ok:false` 才算失败**——把"没有 ok 字段"当失败会把好的也报成坏的
    if (r && r.ok === false) {
      ui.toast(`${what}保存失败：${r.error ?? '未知原因'}`, 'error')
      return null
    }
    ui.toast(`${what}已保存`, 'ok')
    return r
  } catch (e) {
    ui.toast(`${what}保存失败：${errText(e)}`, 'error')
    return null
  }
}

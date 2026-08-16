import { safeStorage } from 'electron'
import { createHmac, randomBytes } from 'crypto'
import { tasks } from './tasks/registry'
import { log } from './lib/logger'

/**
 * 密钥保险箱（UX 审计 M-29）。
 *
 * **实测结论（2026-08-16，Electron 30.5.1 / macOS 24.6）**：贵的不是 `encryptString`，
 * 而是**一个进程里对 safeStorage 的第一次调用**——它要去 Keychain 取「<appName> Safe Storage」
 * 那把 key，securityd 要校验调用方的代码签名。实测：
 *   isEncryptionAvailable() 首调 8.7s ／ encryptString 首调 60.4s ／ 另一次 decryptString 首调 4.3s ／
 *   系统缓存热的时候同样的首调只要 8ms。首调之后同进程内 encrypt/decrypt 都是 0–2ms。
 * 也就是说 `isEncryptionAvailable()`、`decryptString`、`encryptString` 谁先被调用谁付这笔钱，
 * 而这笔钱是同步的、会把主进程整个冻住（IPC、CDP、窗口一起停）。
 *
 * 所以这里的三条设计都是围绕「**能不碰 Keychain 就别碰**」：
 *  1. `has()` 只看密文在不在，零 Keychain 触碰（`settings:get` 每次都要问，不能让它触发冷调用）
 *  2. 写前判重用**指纹**比对而不是解密比对——解密同样会付冷调用的钱，判重就白判了。
 *     指纹 = HMAC-SHA256(每安装一份随机盐, 明文)，不可逆，只用来回答"值变了没有"
 *  3. 真要写的时候先把明文放进内存缓存并登记一条任务，让渲染层先拿到等待态，
 *     再让出一次事件循环，最后才做那次会冻住主进程的同步加密
 */

export interface SecretBackend {
  read(key: string): string | undefined
  write(key: string, value: string): void
  remove(key: string): void
}

export type WriteOutcome = 'unchanged' | 'written' | 'queued'

/** 全局串行：两次写挤在一起时后一次要等前一次的同步加密做完，否则事件循环让不出去 */
let chain: Promise<unknown> = Promise.resolve()

export class SecretVault {
  /** 明文内存缓存：本进程内解密/写入过的值。发消息优先用它，落盘慢不挡路 */
  private mem = new Map<string, string>()
  /** 正在排队等写盘的字段（渲染层等待态的真相源在 task registry，这里只做去重） */
  private pending = new Set<string>()

  constructor(
    private backend: SecretBackend,
    /** 任务标题里出现的人话，如「API Key」「登录状态」 */
    private label: string
  ) {}

  /** 零 Keychain 触碰：只回答"配没配过"。`settings:get` 这种高频只读路径必须走它 */
  has(key: string): boolean {
    return this.mem.has(key) || !!this.backend.read(key)
  }

  /** 拿明文。内存里有就直接给；没有才解密（可能付一次冷调用，但这时用户确实在等这把 key） */
  read(key: string): string | null {
    const cached = this.mem.get(key)
    if (cached !== undefined) return cached
    const enc = this.backend.read(key)
    if (!enc) return null
    try {
      const plain = safeStorage.decryptString(Buffer.from(enc, 'base64'))
      this.mem.set(key, plain)
      return plain
    } catch {
      return null
    }
  }

  /** 盐只用于给密钥算不可逆指纹，本身不是秘密，明文存 store 即可 */
  private salt(): string {
    const k = 'secretSalt'
    let s = this.backend.read(k)
    if (!s) {
      s = randomBytes(16).toString('hex')
      this.backend.write(k, s)
    }
    return s
  }

  private fp(plain: string): string {
    return createHmac('sha256', this.salt()).update(plain).digest('base64')
  }

  private fpKey(key: string): string {
    return `${key}Fp`
  }

  /** 现值与要写的值一样吗？纯 store 读 + 哈希，零 Keychain 触碰 */
  private unchanged(key: string, plain: string): boolean {
    // 密文不在就必须写：光有指纹说明落盘那半边被人为清掉了（或上次写盘失败）
    if (!this.backend.read(key)) return false
    const known = this.backend.read(this.fpKey(key))
    if (known) return known === this.fp(plain)
    // 老数据没有指纹（升级上来的用户）：有密文但指纹缺失，回填一次指纹再判
    // ——回填只能靠解密现值，这一步会付冷调用，但它一辈子只发生一次
    const cur = this.read(key)
    if (cur === null) return false
    this.backend.write(this.fpKey(key), this.fp(cur))
    return cur === plain
  }

  /**
   * 不挡路的写：
   *  - 值没变 → 直接 'unchanged'，一次 Keychain 都不碰（老用户每次启动的 provision 到这里归零）
   *  - 值变了 → 明文立刻进内存（发消息马上可用）＋ 登记 running 任务（渲染层出等待态）
   *            ＋ 让出一次事件循环让事件真的发出去，然后才做那次会冻主进程的加密
   */
  writeLater(key: string, plain: string): WriteOutcome {
    if (this.unchanged(key, plain)) return 'unchanged'
    this.mem.set(key, plain)
    if (this.pending.has(key)) return 'queued'
    this.pending.add(key)

    const taskId = `secret:${key}`
    tasks.start({
      id: taskId,
      kind: 'secret',
      key,
      title: `正在安全保存${this.label}`,
      cancelable: false,
      field: key,
    })

    chain = chain.then(async () => {
      // 先让事件循环转一圈：task:event 得先真正发出去，渲染层才有等待态可显示。
      // 下一行的 encryptString 是同步的，一旦开始，主进程在它返回前什么都做不了
      await new Promise((r) => setTimeout(r, 60))
      const t0 = Date.now()
      try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用（Keychain 未解锁？）')
        const latest = this.mem.get(key) ?? plain
        this.backend.write(key, safeStorage.encryptString(latest).toString('base64'))
        this.backend.write(this.fpKey(key), this.fp(latest))
        const ms = Date.now() - t0
        log('info', 'secrets', `${key} 已加密落盘（${ms}ms）`)
        tasks.finish(taskId, 'succeeded')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log('error', 'secrets', `${key} 落盘失败：${msg}`)
        tasks.patch(taskId, { title: `${this.label}保存失败` })
        tasks.finish(taskId, 'failed', msg)
      } finally {
        this.pending.delete(key)
      }
    })
    return 'queued'
  }

  /** 只塞内存不落盘：无窗口场景（冒烟脚本）用环境变量注入 key，不必碰 Keychain */
  preload(key: string, plain: string): void {
    this.mem.set(key, plain)
  }

  /** 写入是否还在排队（设置页/登录页的等待态兜底查询用） */
  isPending(key: string): boolean {
    return this.pending.has(key)
  }

  remove(key: string): void {
    this.mem.delete(key)
    this.backend.remove(key)
    this.backend.remove(this.fpKey(key))
  }
}

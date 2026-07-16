/** 必须最先 import：ES import 提升会让 store.ts 在 setPath 之前初始化，导致 e2e 读写真实 userData */
import { app } from 'electron'

if (process.env.MCNAI_USER_DATA) {
  app.setPath('userData', process.env.MCNAI_USER_DATA)
}

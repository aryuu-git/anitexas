/// <reference types="vite/client" />

/** 环境变量：
 *  VITE_USE_MOCK = '1' 启用 mock 桌（离线演示，无后端）；否则真实 REST + WS。
 *  VITE_WS_URL 可覆盖对局面 WS 地址（默认同源 <base>/ws，dev 走 vite 代理 → 8081）。 */
interface ImportMetaEnv {
  readonly VITE_USE_MOCK?: string
  readonly VITE_WS_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

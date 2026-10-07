import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 构建产物统一落在仓库根 data/ 下（gitignore），与 karuta 对称自包含约定一致。
// dev 代理到本机 Go 后端（cmd/server 默认 8081；8080 留给同机 karuta）：REST 走 /api，对局面走 /ws。
export default defineConfig({
  plugins: [react()],
  // 子路径部署基址：纯 IP 单端口（80）同机共存时挂 /anitexas/（dev 同样生效，
  // 页面与 API/WS 都在 /anitexas/ 前缀下，见 server.proxy 的剥前缀转发）。
  // HTML 资源引用、import.meta.env.BASE_URL 均以此为准；后端 API/WS 路径见 client.ts / RoomPage.tsx。
  base: '/anitexas/',
  build: {
    outDir: '../data/dist',
    emptyOutDir: true,
  },
  server: {
    // D13 同机共存：5173 被 karuta 开发服占用，AniTexas 开发端口钉死 5373 且不许漂移
    port: 5373,
    strictPort: true,
    proxy: {
      // dev 下 base=/anitexas/（见上）：真实模式请求以 /anitexas/api、/anitexas/ws 进来，
      // 需剥掉子路径前缀再转给后端（镜像 nginx 子路径部署的剥前缀行为）；
      // 裸 /api、/ws 直通保留（curl/脚本习惯路径）。
      '/anitexas/api': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/anitexas/, ''),
      },
      '/anitexas/ws': {
        target: 'http://localhost:8081',
        changeOrigin: false,
        ws: true,
        rewrite: (p) => p.replace(/^\/anitexas/, ''),
      },
      '/api': {
        target: 'http://localhost:8081',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:8081',
        changeOrigin: false,
        ws: true,
      },
    },
  },
})

import { Suspense, lazy } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'

/**
 * 应用路由：大厅（建房/加入）→ 对局桌。
 * v1 无账号（D9），房间码即入口。
 * 路由级 lazy（D15 性能约束）：大厅/对局桌各自成 chunk，首屏不背对局桌代码。
 */
const LobbyPage = lazy(() => import('./pages/LobbyPage'))
const RoomPage = lazy(() => import('./pages/RoomPage'))

export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
      <Suspense
        fallback={
          <div className="mx-auto max-w-content px-8 py-20 text-center font-serif text-tier-name text-gold-light">
            载入中…
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<LobbyPage />} />
          <Route path="/room/:code" element={<RoomPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

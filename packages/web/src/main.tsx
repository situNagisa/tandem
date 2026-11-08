import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { applyTheme, useUiStore } from './store/useUiStore'
import { useAppStore } from './store/useAppStore'
import { installFocusRing } from './lib/focusRing'
import { PublicSharePage } from './components/share/PublicSharePage'

// 分享页是独立只读页面：不加载 Host 列表、不连 WS、也不启用反馈工具。
const isSharePage = /^\/s\/[^/?#]+/.test(window.location.pathname)

if (!isSharePage && __TANDEM_DEBUG__) {
  // 反馈模式与轨迹采集只在调试版加载；发布版构建会连同模块一起剔除。
  const { installDebugTools } = await import('./lib/debugBootstrap')
  installDebugTools()
}
// 焦点环只跟键盘导航走：鼠标打开弹层后自动聚焦的输入框不出现焦点环。
// 分享页同样需要，保证键盘用户仍能看到焦点。
installFocusRing()

// 尽早应用主题、读取 Host 列表与 ?token=，避免首屏闪烁和路由被判为无效。
applyTheme(useUiStore.getState().theme)
if (!isSharePage) useAppStore.getState().initialize()

if (!isSharePage && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 本地非 HTTPS 或服务端未托管 sw.js 时忽略 */
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isSharePage ? <PublicSharePage /> : <App />}
  </StrictMode>,
)

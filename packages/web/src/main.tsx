import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { applyTheme, useUiStore } from './store/useUiStore'
import { useAppStore } from './store/useAppStore'

// 尽早应用主题、读取 Host 列表与 ?token=，避免首屏闪烁和路由被判为无效。
applyTheme(useUiStore.getState().theme)
useAppStore.getState().initialize()

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 本地非 HTTPS 或服务端未托管 sw.js 时忽略 */
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { applyTheme, useUiStore } from './store/useUiStore'
import { useAppStore } from './store/useAppStore'
import { installFeedbackErrorBuffer } from './lib/feedbackErrors'
import { installFeedbackHotkey } from './lib/feedbackHotkey'
import { installFeedbackTrace } from './lib/feedbackTrace'
import { PublicSharePage } from './components/share/PublicSharePage'

// 分享页是独立只读页面：不加载 Host 列表、不连 WS、也不启用反馈工具。
const isSharePage = /^\/s\/[^/?#]+/.test(window.location.pathname)

if (!isSharePage) {
  // 反馈模式依赖最早的错误缓冲，先于应用初始化安装。
  installFeedbackErrorBuffer()
  // 热键必须早于应用内所有 keydown 监听注册。
  installFeedbackHotkey()
  // 操作轨迹只采集不拦截，尽早安装以覆盖启动阶段。
  installFeedbackTrace()
}

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

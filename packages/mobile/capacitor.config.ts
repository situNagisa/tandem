import type { CapacitorConfig } from '@capacitor/cli'

// Web 客户端由 Host 托管在局域网 http 上，所以 WebView 内部也用 http scheme，
// 避免 https 页面请求 http Host 被混合内容策略拦截。
const config: CapacitorConfig = {
  appId: 'com.tandem.app',
  appName: 'Tandem',
  webDir: process.env.TANDEM_WEB_DIR ?? '../web/dist',
  server: {
    androidScheme: 'http',
  },
  android: {
    allowMixedContent: true,
  },
}

export default config

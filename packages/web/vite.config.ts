import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
const srcDir = path.dirname(fileURLToPath(import.meta.url))

// 构建风味：默认 debug（开发体验不变）；TANDEM_FLAVOR=release 时把调试专用模块替换为空实现。
const flavor = process.env.TANDEM_FLAVOR === 'release' ? 'release' : 'debug'

/** 发布版把两个调试 store 换成空实现；调试版按原样解析。 */
function releaseStubPlugin() {
  return {
    name: 'tandem-release-stubs',
    enforce: 'pre' as const,
    resolveId(source: string) {
      if (flavor !== 'release') return null
      if (/(^|\/)useFeedbackStore$/.test(source)) {
        return path.join(srcDir, 'src/lib/releaseStubs/useFeedbackStore.ts')
      }
      if (/(^|\/)useDemoStore$/.test(source)) {
        return path.join(srcDir, 'src/lib/releaseStubs/useDemoStore.ts')
      }
      if (/(^|\/)DemoDeviceStage$/.test(source)) {
        return path.join(srcDir, 'src/lib/releaseStubs/DemoDeviceStage.tsx')
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [releaseStubPlugin(), react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __TANDEM_FLAVOR__: JSON.stringify(flavor),
    __TANDEM_DEBUG__: JSON.stringify(flavor === 'debug'),
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7878', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:7878', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
})

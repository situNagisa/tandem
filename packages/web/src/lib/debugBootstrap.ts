// 调试专用：反馈模式的错误缓冲、快捷键与操作轨迹。发布版不会包含这个模块。
import { installFeedbackErrorBuffer } from './feedbackErrors'
import { installFeedbackHotkey } from './feedbackHotkey'
import { installFeedbackTrace } from './feedbackTrace'
import { installFeedbackDraftSync } from './feedbackDrafts'

export function installDebugTools(): void {
  // 反馈模式依赖最早的错误缓冲，先于应用初始化安装。
  installFeedbackErrorBuffer()
  // 热键必须早于应用内所有 keydown 监听注册。
  installFeedbackHotkey()
  // 操作轨迹只采集不拦截，尽早安装以覆盖启动阶段。
  installFeedbackTrace()
  // 草稿实时落盘：桌面调试版写磁盘目录，顺带清理超过 7 天的已导出草稿。
  installFeedbackDraftSync()
}

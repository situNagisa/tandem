import type {
  ContentBlock,
  DelegationStrategy,
  PermissionMode,
  ReasoningEffort,
  RoutePreference,
} from '@tandem/protocol'

export interface ComposerProps {
  /** 覆盖默认发送。返回 false（或 reject）时保留输入内容，其余返回视为成功并清空。 */
  onSubmit?: (content: ContentBlock[]) => unknown | Promise<unknown>
  /** 无会话模式：模型、权限模式由外部受控，running 也由外部提供。 */
  sessionless?: boolean
  model?: string
  profileId?: string
  groupId?: string
  permissionMode?: PermissionMode
  onModelChange?: (profileId: string, groupId: string | undefined, model: string) => void
  /** 无会话模式的取向；缺省跟随全局设置。 */
  routeBias?: RoutePreference
  onRouteBiasChange?: (bias: RoutePreference) => void
  /** 无会话模式的分工；会话内直接从 summary 读取。 */
  delegation?: DelegationStrategy
  onDelegationChange?: (strategy: DelegationStrategy) => void
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** 无会话模式的思考强度；缺省读上次使用值。 */
  effort?: ReasoningEffort
  onEffortChange?: (effort: ReasoningEffort) => void
  /** 文件补全与斜杠命令使用的 Host / 工作目录；缺省用当前会话。 */
  hostId?: string
  cwd?: string
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  className?: string
  /** 外部覆盖运行状态（新会话页首条消息提交后使用）。 */
  running?: boolean
  onStop?: () => void
  /** 窄窗格：工具栏收起为图标，避免发送按钮被挤出。 */
  compact?: boolean
}

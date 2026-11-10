import { formatTokens } from '../../lib/format'
import { ConfirmAction } from '../ui/ConfirmAction'

interface SwitchPick {
  profileId: string
  groupId?: string
  model: string
  tokens: number
}

interface ModelSwitchConfirmProps {
  pendingSwitch: SwitchPick | null
  switchLabel: (pick: SwitchPick) => string
  switchCost: (pick: SwitchPick) => number | undefined
  switchCostText: (cost: number | undefined) => string | null
  onConfirm: () => void
  onClose: () => void
}

export function ModelSwitchConfirm({
  pendingSwitch,
  switchLabel,
  switchCost,
  switchCostText,
  onConfirm,
  onClose,
}: ModelSwitchConfirmProps) {
  return (
    <ConfirmAction
      open={!!pendingSwitch}
      title="切换后提示缓存将失效"
      description="下一轮按完整上下文计费（缓存前缀已更换，需要重新写入）。"
      confirmLabel="切换"
      onConfirm={onConfirm}
      onClose={onClose}
      testId="model-switch-confirm"
    >
      {pendingSwitch && (
        <div className="space-y-1">
          <p className="font-mono text-[13px] tabular-nums text-text">
            约 ~{formatTokens(pendingSwitch.tokens)} tok
            {switchCost(pendingSwitch) !== undefined
              ? ` / ${switchCostText(switchCost(pendingSwitch))}`
              : ''}
          </p>
          <p className="text-[12px] leading-5 text-muted">切换为 {switchLabel(pendingSwitch)}</p>
        </div>
      )}
    </ConfirmAction>
  )
}

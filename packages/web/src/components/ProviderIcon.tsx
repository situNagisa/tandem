import type { ProviderPreset } from '../lib/presets'
import { PROVIDER_ICON_PATHS } from '../lib/provider-icon-paths'
import { cn } from '../lib/cn'

/** 服务商 logo：有品牌标识时用单色 SVG，否则用同尺寸、同色的字母标。 */
export function ProviderIcon({
  preset,
  name,
  size = 18,
  className,
}: {
  preset?: ProviderPreset | null
  /** 无预设时用于生成字母标 */
  name?: string
  size?: number
  className?: string
}) {
  const paths = preset ? PROVIDER_ICON_PATHS[preset.id] : undefined
  if (paths?.length) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden
        className={cn('shrink-0', className)}
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    )
  }
  const trimmed = (name ?? preset?.name ?? '').trim()
  const label = !trimmed ? '?' : /[a-zA-Z]/.test(trimmed[0]) ? trimmed[0].toUpperCase() : trimmed[0]
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center font-semibold', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
    >
      {label}
    </span>
  )
}

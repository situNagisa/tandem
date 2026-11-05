export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="512" height="512" rx="112" fill="var(--t-accent)" />
      <g fill="var(--t-on-accent)">
        <rect x="150" y="190" width="212" height="48" rx="24" />
        <rect x="150" y="272" width="162" height="48" rx="24" />
        <rect x="150" y="354" width="112" height="48" rx="24" />
      </g>
    </svg>
  )
}

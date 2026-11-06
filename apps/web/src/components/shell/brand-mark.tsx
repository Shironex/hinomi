import { cn } from '@/lib/utils'

/** The fire lookout tower with its lit bell, on the accent tile. */
export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        'grid shrink-0 place-items-center rounded-md bg-primary text-primary-foreground',
        className,
      )}
    >
      <svg
        width={Math.round(size * 0.58)}
        height={Math.round(size * 0.58)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path d="M6.5 8 12 3.2 17.5 8" />
        <rect x="8" y="8" width="8" height="5" rx=".6" />
        <path d="M9.2 13 6.6 21M14.8 13 17.4 21M7.9 17.2h8.2" />
        <circle cx="12" cy="10.5" r="1.25" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}

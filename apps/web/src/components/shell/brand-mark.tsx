import { cn } from '@/lib/utils'

// The small size cut of the brand mark (assets/brand/favicon.svg): no finial or railing slats,
// thicker legs, so it stays crisp in a 28 to 36 px tile. Keep the two in sync.
const TOWER =
  'M16 3c1.8 2.8 5.5 7.6 14 7l-2 2H4l-2-2c8.5.6 12.2-4.2 14-7z M8 11.7h2V18H8z M22 11.7h2V18h-2z M5 18h22v4H5z M7 21.7h4L7 30H2.5z M21 21.7h4l4.5 8.3H25z M6 24h20v2H6z'
const BELL = 'M16 13c-2.1 0-2.55 1.6-2.55 2.75L13 17.6h6l-.45-1.85c0-1.15-.45-2.75-2.55-2.75z'

/** The fire lookout tower with its lit ember bell, on the accent tile. */
export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  const mark = Math.round(size * 0.66)
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        'grid shrink-0 place-items-center rounded-md bg-primary text-primary-foreground',
        className,
      )}
    >
      <svg width={mark} height={mark} viewBox="2 2.5 28 28" fill="currentColor">
        <path d={TOWER} />
        {/* A shaded window so the bell reads as lit on either theme's accent. */}
        <rect x="10" y="12" width="12" height="6" fill="#000" opacity={0.3} />
        <path d={BELL} fill="#ffa746" />
      </svg>
    </span>
  )
}

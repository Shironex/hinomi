/** The fire lookout tower with its lit bell. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      className="shrink-0 text-accent-ink"
    >
      <path d="M6.5 8 12 3.2 17.5 8" />
      <rect x="8" y="8" width="8" height="5" rx=".6" />
      <path d="M9.2 13 6.6 21M14.8 13 17.4 21M7.9 17.2h8.2" />
      <circle cx="12" cy="10.5" r="1.25" fill="var(--sev-critical)" stroke="none" />
    </svg>
  )
}

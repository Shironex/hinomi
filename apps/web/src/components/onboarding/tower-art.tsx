/** The fire tower mark from the design's first run hero. */
export function TowerArt() {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
      className="hidden size-[132px] shrink-0 tab:block"
    >
      <rect
        x="1"
        y="1"
        width="118"
        height="118"
        rx="14"
        fill="var(--sidebar)"
        stroke="var(--border)"
      />
      <path d="M24 96h72" stroke="var(--input)" strokeWidth="1.5" strokeLinecap="round" />
      <g stroke="var(--accent-ink)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round">
        <path d="M42 40 60 24l18 16" />
        <rect x="47" y="40" width="26" height="17" rx="1.5" />
        <path d="M51 57l-8 39M69 57l8 39M47 72h26M45 84h30" />
      </g>
      <circle cx="60" cy="48.5" r="3.6" fill="var(--sev-critical)" />
      <g fill="var(--input)">
        <rect x="14" y="80" width="10" height="16" rx="1" />
        <rect x="88" y="74" width="12" height="22" rx="1" />
        <rect x="101" y="84" width="8" height="12" rx="1" />
      </g>
    </svg>
  )
}

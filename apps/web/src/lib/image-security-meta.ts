import type { ImageSecurity, ImageSecurityStatus } from '@hinomi/shared'

/** What each verdict of Coolify's image scan says, in words the chip and the panel share. */
export const IMAGE_SECURITY_INFO: Record<
  ImageSecurityStatus,
  {
    label: string
    tone: 'critical' | 'high' | 'moderate' | 'success' | 'outline' | 'blind'
    explain: string
  }
> = {
  update_now: {
    label: 'Update now',
    tone: 'critical',
    explain: 'The images carry a fixable advisory that is known to be exploited.',
  },
  update_available: {
    label: 'Update available',
    tone: 'high',
    explain: 'A newer image version fixes advisories in the current ones.',
  },
  no_fix: {
    label: 'No fix yet',
    tone: 'moderate',
    explain: 'The images have advisories and no fixed version exists yet.',
  },
  check_needed: {
    label: 'Check needed',
    tone: 'blind',
    explain: 'Coolify could not rate every image. Look at its Security page.',
  },
  ok: {
    label: 'Images ok',
    tone: 'success',
    explain: 'Coolify found nothing to act on in the images.',
  },
  not_checked: {
    label: 'Not checked',
    tone: 'outline',
    explain: 'Coolify has not scanned these images yet.',
  },
}

/** A value from the source is a link only when it parses as an http or https URL. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** Statuses worth a chip in a list: `ok` and `not_checked` are the quiet default. */
export function showsInList(s: ImageSecurity | null): s is ImageSecurity {
  return s !== null && s.status !== 'ok' && s.status !== 'not_checked'
}

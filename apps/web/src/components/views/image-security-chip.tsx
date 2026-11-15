import type { ImageSecurity } from '@hinomi/shared'
import { IconAlertOctagon, IconBox, IconCircleCheck, IconHelpCircle } from '@tabler/icons-react'
import type { Icon } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { IMAGE_SECURITY_INFO } from '@/lib/image-security-meta'

const ICON: Record<ImageSecurity['status'], Icon> = {
  update_now: IconAlertOctagon,
  update_available: IconBox,
  no_fix: IconBox,
  check_needed: IconHelpCircle,
  ok: IconCircleCheck,
  not_checked: IconHelpCircle,
}

/** Coolify's verdict on a deployment's images as a chip: an icon and the words, never color alone. */
export function ImageSecurityChip({ security }: { security: ImageSecurity }) {
  const info = IMAGE_SECURITY_INFO[security.status]
  const IconCmp = ICON[security.status]
  return (
    <Badge variant={info.tone} title={info.explain}>
      <IconCmp aria-hidden="true" stroke={2} />
      {info.label}
    </Badge>
  )
}

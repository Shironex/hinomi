import { IconDeviceDesktop, IconMoon, IconSun, type Icon } from '@tabler/icons-react'
import type { Theme } from '@/lib/theme'

export const THEME_ICON: Record<Theme, Icon> = {
  system: IconDeviceDesktop,
  light: IconSun,
  dark: IconMoon,
}

export const THEME_LABEL: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

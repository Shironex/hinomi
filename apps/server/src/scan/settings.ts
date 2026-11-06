import { z } from 'zod'
import type { SettingsRepository } from '../repository/index.js'

/** Settings keys the scan reads. Values are plain JSON booleans. */
export const SCAN_SETTING_KEYS = {
  /** Scan lockfiles against OSV.dev. Default on. */
  osvEnabled: 'scan.osvEnabled',
  /** Also scan every repo the GitHub token can see, for the everything-else view. Default off. */
  includeAccountRepos: 'scan.includeAccountRepos',
} as const

export interface ScanSettings {
  osvEnabled: boolean
  includeAccountRepos: boolean
}

export const DEFAULT_SCAN_SETTINGS: ScanSettings = { osvEnabled: true, includeAccountRepos: false }

export function readScanSettings(settings: SettingsRepository): ScanSettings {
  return {
    osvEnabled:
      settings.get(SCAN_SETTING_KEYS.osvEnabled, z.boolean()) ?? DEFAULT_SCAN_SETTINGS.osvEnabled,
    includeAccountRepos:
      settings.get(SCAN_SETTING_KEYS.includeAccountRepos, z.boolean()) ??
      DEFAULT_SCAN_SETTINGS.includeAccountRepos,
  }
}

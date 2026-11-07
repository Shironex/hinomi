import { IMAGE_SCAN_DEFAULT_MODE, imageScanModeSchema, type ImageScanMode } from '@hinomi/shared'
import { z } from 'zod'
import type { SettingsRepository } from '../repository/index.js'

/** Settings keys the scan reads. Values are plain JSON. */
export const SCAN_SETTING_KEYS = {
  /** Scan lockfiles against OSV.dev. Default on. */
  osvEnabled: 'scan.osvEnabled',
  /** Also scan every repo the GitHub token can see, for the everything-else view. Default off. */
  includeAccountRepos: 'scan.includeAccountRepos',
  /** Image scan of image only deployments: `off` (default) or `coolify`. */
  imageScan: 'scan.imageScan',
} as const

export interface ScanSettings {
  osvEnabled: boolean
  includeAccountRepos: boolean
  imageScan: ImageScanMode
}

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  osvEnabled: true,
  includeAccountRepos: false,
  imageScan: IMAGE_SCAN_DEFAULT_MODE,
}

export function readScanSettings(settings: SettingsRepository): ScanSettings {
  return {
    osvEnabled:
      settings.get(SCAN_SETTING_KEYS.osvEnabled, z.boolean()) ?? DEFAULT_SCAN_SETTINGS.osvEnabled,
    includeAccountRepos:
      settings.get(SCAN_SETTING_KEYS.includeAccountRepos, z.boolean()) ??
      DEFAULT_SCAN_SETTINGS.includeAccountRepos,
    imageScan:
      settings.get(SCAN_SETTING_KEYS.imageScan, imageScanModeSchema) ??
      DEFAULT_SCAN_SETTINGS.imageScan,
  }
}

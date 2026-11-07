export {
  createSupportIndex,
  daysUntilEol,
  isPastEol,
  lineCandidates,
  supportBasisOf,
  windowStateOf,
  type LineLookup,
  type LookupOptions,
  type SupportIndex,
} from './lookup.js'
export {
  SupportDataError,
  parseProductsFull,
  type ParsedSupportData,
  type SupportProduct,
  type SupportRelease,
} from './products.js'
export { normalizePurl, purlKey } from './purl.js'
export { readSupportWindowDays, SUPPORT_WINDOW_KEY } from './settings.js'

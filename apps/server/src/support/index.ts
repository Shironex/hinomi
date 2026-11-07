export {
  EOL_API_BASE,
  MAX_BODY_BYTES,
  fetchProductsFull,
  parseRetryAfter,
  type FetchProductsOptions,
  type FetchResult,
  type Validators,
} from './client.js'
export {
  IDLE_RECHECK_MS,
  PRODUCTS_FULL_KEY,
  REFRESH_INTERVAL_MS,
  createSupportData,
  type RefreshOutcome,
  type SupportData,
  type SupportDataOptions,
} from './data.js'
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
export {
  BEHIND_RELEASES_KEYS,
  readBehindReleases,
  readSupportWindowDays,
  SUPPORT_WINDOW_KEY,
} from './settings.js'

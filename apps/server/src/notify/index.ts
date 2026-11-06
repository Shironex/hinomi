// Discord, generic webhook and email notifications. The scheduler calls
// `handleScanFinished` after each scan and `sendDigest` once a day.
export { createNotifier, type Notifier, type NotifierOptions, type TestResult } from './notifier.js'
export {
  ChannelNotFoundError,
  ChannelValidationError,
  createChannelStore,
  maskWebhookUrl,
  CHANNEL_KINDS,
  type ChannelInput,
  type ChannelKind,
  type ChannelPatch,
  type ChannelStore,
  type ChannelView,
  type ResolvedEmail,
} from './channels.js'
export {
  SmtpError,
  createSmtpSender,
  emailContent,
  type MailMessage,
  type MailSender,
} from './email.js'
export { findingNotifications } from './history.js'
export { msUntilNextDigest } from './schedule.js'
export {
  DEFAULT_DIGEST_HOUR,
  NOTIFY_SETTING_KEYS,
  readNotifySettings,
  writeDigestHour,
  writePublicBaseUrl,
  type NotifySettings,
} from './settings.js'
export type { WebhookPayload } from './format.js'
export type { NotificationItem } from './items.js'

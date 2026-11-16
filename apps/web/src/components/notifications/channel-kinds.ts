import type { NotifyChannelKind } from '@hinomi/shared'
import {
  IconBellRinging,
  IconBrandDiscord,
  IconBrandSlack,
  IconBrandTelegram,
  IconDeviceMobileMessage,
  IconMail,
  IconWebhook,
} from '@tabler/icons-react'

/** How the settings show and ask for each kind of channel. */
export interface KindCopy {
  label: string
  /** The word in a sentence ("Discord and email on"). */
  word: string
  icon: typeof IconWebhook
  /** The default name of a new channel. */
  name: string
  namePlaceholder: string
  urlLabel: string
  urlPlaceholder: string
  urlHelp: string
  secretLabel: string
  secretHelp: string
}

const NO_URL = { urlLabel: '', urlPlaceholder: '', urlHelp: '' }
const NO_SECRET = { secretLabel: '', secretHelp: '' }

export const KIND_COPY: Record<NotifyChannelKind, KindCopy> = {
  discord: {
    label: 'Discord',
    word: 'Discord',
    icon: IconBrandDiscord,
    name: 'Discord',
    namePlaceholder: 'Discord #ops',
    urlLabel: 'Discord webhook URL',
    urlPlaceholder: 'https://discord.com/api/webhooks/...',
    urlHelp: 'Channel settings, Integrations, Webhooks, Copy webhook URL.',
    ...NO_SECRET,
  },
  slack: {
    label: 'Slack',
    word: 'Slack',
    icon: IconBrandSlack,
    name: 'Slack',
    namePlaceholder: 'Slack #security',
    urlLabel: 'Slack webhook URL',
    urlPlaceholder: 'https://hooks.slack.com/services/...',
    urlHelp: 'A Slack app with Incoming Webhooks on, then Add New Webhook to Workspace.',
    ...NO_SECRET,
  },
  ntfy: {
    label: 'ntfy',
    word: 'ntfy',
    icon: IconBellRinging,
    name: 'ntfy',
    namePlaceholder: 'Phone',
    urlLabel: 'Topic URL',
    urlPlaceholder: 'https://ntfy.sh/hinomi-alerts',
    urlHelp: 'The server and the topic. On ntfy.sh anyone who knows the topic can read it.',
    secretLabel: 'Access token',
    secretHelp: 'Optional, for a protected topic (tk_...).',
  },
  gotify: {
    label: 'Gotify',
    word: 'Gotify',
    icon: IconDeviceMobileMessage,
    name: 'Gotify',
    namePlaceholder: 'Gotify',
    urlLabel: 'Gotify server URL',
    urlPlaceholder: 'https://gotify.example.dev',
    urlHelp: 'The address of the server, without /message.',
    secretLabel: 'App token',
    secretHelp: 'Apps, Create application, then copy its token.',
  },
  telegram: {
    label: 'Telegram',
    word: 'Telegram',
    icon: IconBrandTelegram,
    name: 'Telegram',
    namePlaceholder: 'Ops chat',
    ...NO_URL,
    secretLabel: 'Bot token',
    secretHelp: 'From @BotFather, for example 123456789:AA...',
  },
  webhook: {
    label: 'Webhook',
    word: 'webhook',
    icon: IconWebhook,
    name: 'Webhook',
    namePlaceholder: 'Incident bot',
    urlLabel: 'Webhook URL',
    urlPlaceholder: 'https://hooks.example.dev/hinomi',
    urlHelp: 'Hinomi sends a JSON POST. See docs/notifications.md for the payload.',
    secretLabel: 'Signing secret',
    secretHelp: 'Optional. Signs every request in the X-Hinomi-Signature header.',
  },
  email: {
    label: 'Email',
    word: 'email',
    icon: IconMail,
    name: 'Email',
    namePlaceholder: 'Ops mailbox',
    ...NO_URL,
    ...NO_SECRET,
  },
}

/** The order of the type picker. */
export const KIND_ORDER: NotifyChannelKind[] = [
  'discord',
  'slack',
  'telegram',
  'ntfy',
  'gotify',
  'email',
  'webhook',
]

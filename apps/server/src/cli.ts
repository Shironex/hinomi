import { issueSetupCode } from './auth/index.js'
import { loadConfig } from './config.js'
import { openStorage } from './storage.js'
import { currentTime } from '@hinomi/shared'

/**
 * Login recovery from inside the container, where only the operator can run it:
 *
 *   node apps/server/dist/cli.mjs setup-code        a one time code to register a passkey
 *   node apps/server/dist/cli.mjs reset             remove every passkey and session, then a code
 *   node apps/server/dist/cli.mjs revoke-sessions   sign everyone out
 *
 * The code goes to this terminal only, never to the server log. See docs/auth.md.
 */

const USAGE = `Usage: node apps/server/dist/cli.mjs <command>

  setup-code       Print a one time code (15 minutes) to register a passkey on the login page
  reset            Remove every passkey and session, then print a setup code (a lost passkey)
  revoke-sessions  End every session; everyone signs in again
`

function main(argv: string[]): number {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return command ? 0 : 1
  }
  if (!['setup-code', 'reset', 'revoke-sessions'].includes(command)) {
    process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`)
    return 1
  }

  const config = loadConfig()
  const storage = openStorage(config)
  try {
    const { auth, audit, settings } = storage.repositories
    const now = currentTime()
    if (command === 'revoke-sessions') {
      const ended = auth.sessions.removeAll()
      audit.record({ action: 'session_revoked', actor: 'cli', detail: `${ended} sessions` }, now)
      process.stdout.write(`Ended ${ended} sessions.\n`)
      return 0
    }
    if (command === 'reset') {
      const passkeys = auth.passkeys.removeAll()
      const sessions = auth.sessions.removeAll()
      audit.record(
        {
          action: 'auth_reset',
          actor: 'cli',
          detail: `${passkeys} passkeys, ${sessions} sessions`,
        },
        now,
      )
      process.stdout.write(`Removed ${passkeys} passkeys and ended ${sessions} sessions.\n`)
    }
    const { code, expiresAt } = issueSetupCode(settings, now)
    // The expiry only: the code itself is never written anywhere but this terminal.
    audit.record(
      {
        action: 'setup_code_issued',
        actor: 'cli',
        detail: `valid until ${expiresAt.toISOString()}`,
      },
      now,
    )
    if (!config.auth) {
      process.stdout.write('Note: HINOMI_AUTH is off, so the login page is not shown yet.\n')
    }
    process.stdout.write(
      `Setup code: ${code}\nValid until ${expiresAt.toISOString()}, once. Open the login page, choose "Use a setup code" and register a passkey.\n`,
    )
    return 0
  } finally {
    storage.close()
  }
}

// A closed pipe (`| head`) is not an error worth a stack trace.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

process.exitCode = main(process.argv.slice(2))

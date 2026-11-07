import { builtinModules } from 'node:module'
import js from '@eslint/js'
import architecture from '@noctcore/eslint-plugin-architecture'
import asyncSafety from '@noctcore/eslint-plugin-async-safety'
import codeQuality from '@noctcore/eslint-plugin-code-quality'
import contracts from '@noctcore/eslint-plugin-contracts'
import monorepo from '@noctcore/eslint-plugin-monorepo'
import observability from '@noctcore/eslint-plugin-observability'
import noctcoreReact from '@noctcore/eslint-plugin-react'
import security from '@noctcore/eslint-plugin-security'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const TS = ['**/*.{ts,tsx}']
const WEB_SRC = ['apps/web/src/**/*.{ts,tsx}']
const TESTS = ['**/*.test.{ts,tsx}', '**/testing.ts', '**/test-db.ts', 'apps/web/src/test/**']

// Every error class Hinomi throws on purpose. A new error class joins this list
// in the same change that adds it, so the taxonomy stays a reviewed decision.
// DOMException is the AbortError that fetch and AbortSignal raise.
const ERROR_TAXONOMY = [
  'Error',
  'DOMException',
  'ApiError',
  'ChannelNotFoundError',
  'ChannelValidationError',
  'ConnectionTestFailed',
  'CoolifyError',
  'FindingTransitionError',
  'FixRunnerError',
  'FixPayloadError',
  'GitHubContentsError',
  'GithubError',
  'GithubRateLimitError',
  'HttpError',
  'InvalidCidrError',
  'OsvRequestError',
  'SchedulerClosedError',
  'SecretDecryptError',
  'SecretKeyMissingError',
  'UnsupportedLockfileError',
]

// Layers of apps/server/src. A folder may import only the folders listed for
// it; anything else is an upward or sideways dependency. Root modules (app,
// config, log, storage, index) compose the folders and are not restricted.
const SERVER_LAYERS = {
  access: [],
  crypto: [],
  db: [],
  sources: [],
  repository: ['crypto', 'db'],
  scan: ['db', 'repository', 'sources'],
  notify: ['crypto', 'db', 'repository', 'scan'],
  scheduler: ['db', 'notify', 'repository', 'scan'],
  api: ['access', 'crypto', 'db', 'notify', 'repository', 'scan', 'scheduler', 'sources'],
}
// Folders with an index.ts barrel are imported through it, never past it.
const SERVER_BARRELS = ['access', 'api', 'notify', 'repository', 'scan', 'scheduler']

const NODE_BUILTINS = {
  regex: `^(node:|(${builtinModules.join('|')})(/|$))`,
  message: 'Node built-ins are server only.',
}

function serverLayer(folder, allowed) {
  const others = Object.keys(SERVER_LAYERS).filter((f) => f !== folder && !allowed.includes(f))
  const patterns = []
  if (others.length > 0) {
    patterns.push({
      regex: `^(\\.\\./)+(${others.join('|')})(/|$)`,
      message: `apps/server/src/${folder} may import only: ${allowed.join(', ') || 'no other folder'}.`,
    })
  }
  const barrels = SERVER_BARRELS.filter((f) => f !== folder && allowed.includes(f))
  if (barrels.length > 0) {
    patterns.push({
      regex: `^(\\.\\./)+(${barrels.join('|')})/(?!index\\.js$)`,
      message: 'Import another server folder through its index.js barrel.',
    })
  }
  if (folder !== 'sources' && allowed.includes('sources')) {
    patterns.push({
      regex: '^(\\.\\./)+sources/[^/]+/(?!index\\.js$)',
      message: 'Import a source through its index.js barrel.',
    })
  }
  return {
    files: [`apps/server/src/${folder}/**/*.ts`],
    // Tests and their harnesses wire every layer together on purpose.
    ignores: TESTS,
    rules: { 'no-restricted-imports': ['error', { patterns }] },
  }
}

export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/dist-fixtures/',
    'showcase-out/',
    '**/coverage/',
    '**/node_modules/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['apps/server/**/*.ts', 'actions/**/*.ts', '**/*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: WEB_SRC,
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    // shadcn/ui components export variants next to the component by design.
    files: ['apps/web/src/components/ui/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },

  // The house presets, spread whole so a rule a new version adds arrives with
  // the bump instead of being missed. Tuning follows below, one reason each.
  ...[codeQuality, asyncSafety, contracts, security, observability, architecture, monorepo].map(
    (plugin) => ({ ...plugin.configs.recommended, files: TS }),
  ),
  { ...noctcoreReact.configs.recommended, files: WEB_SRC },
  {
    files: TS,
    rules: {
      'noctcore-contracts/restrict-throw-to-taxonomy': ['error', { allow: ERROR_TAXONOMY }],
      // Workspace packages are used through what their exports map publishes.
      'noctcore-monorepo/no-deep-package-imports': ['error', { scopes: ['@hinomi'] }],
      'noctcore-monorepo/no-unexported-subpath-import': ['error', { scopes: ['@hinomi'] }],
      // Off: Hinomi names zod schemas in zod's own camelCase idiom (`findingSchema`,
      // with `type Finding = z.infer<...>`). Moving 116 exported names of the API
      // contract to PascalCase is churn with no behaviour behind it.
      'noctcore-contracts/zod-schema-naming': 'off',
      // `code`, `status` and `ecosystem` mean different things in different
      // schemas: a source test failure code is a source error kind, not an API
      // error code; a deploy status is free text from Coolify, not a scan phase
      // status; OSV answers carry ecosystems Hinomi does not parse lockfiles for.
      'noctcore-contracts/schema-enum-field-consistency': [
        'error',
        { ignoreFields: ['code', 'status', 'ecosystem'] },
      ],
      // Server and lib modules are named after the concept they hold, so the
      // check runs on web components only (one component per file), see below.
      'noctcore-architecture/filename-matches-export': 'off',
    },
  },
  {
    files: ['apps/server/src/**/*.ts'],
    rules: {
      // src/index.ts is the process entrypoint tsdown builds, not a barrel.
      'noctcore-architecture/barrel-purity': ['error', { allow: ['**/apps/server/src/index.ts'] }],
      // The signal handlers in the entrypoint are the one place that ends the process.
      'noctcore-code-quality/no-process-exit': [
        'error',
        { allowIn: ['**/apps/server/src/index.ts'] },
      ],
      // config.ts is the typed, validated accessor every other module reads.
      'noctcore-contracts/no-direct-process-env': [
        'error',
        {
          configModule: './config.js',
          allowedFiles: ['**/apps/server/src/config.ts', '**/*.test.ts'],
        },
      ],
    },
  },
  {
    files: ['actions/fix-runner/src/**/*.ts'],
    rules: {
      // src/index.ts is the entry tsdown bundles into dist/index.mjs, not a barrel.
      'noctcore-architecture/barrel-purity': [
        'error',
        { allow: ['**/actions/fix-runner/src/index.ts'] },
      ],
      // The entry hands process.env to main(), which reads inputs from that one object; the
      // test harness gives git a fixed identity on top of the real environment.
      'noctcore-contracts/no-direct-process-env': [
        'error',
        {
          configModule: './main.js',
          allowedFiles: [
            '**/actions/fix-runner/src/index.ts',
            '**/actions/fix-runner/src/testing.ts',
            '**/*.test.ts',
          ],
        },
      ],
    },
  },
  {
    files: WEB_SRC,
    rules: {
      // Off: Hinomi keeps a component's state next to its markup and pulls shared
      // logic into hooks/ when two components need it. A `.hooks.ts` file per
      // component would add 26 files that only one component imports.
      'noctcore-react/no-state-in-component-body': 'off',
      // Off: lists render with an inline `.map` in JSX, the idiom React's own docs
      // use. The rule's docs name this preference as the case to disable it.
      'noctcore-react/no-jsx-computation': 'off',
      // The test setup clears jsdom storage between tests, where it cannot throw.
      'noctcore-react/no-unguarded-web-storage': [
        'error',
        {
          allowIn: [
            '**/*.test.*',
            '**/*.spec.*',
            '**/__tests__/**',
            '**/tests/**',
            '**/e2e/**',
            '**/apps/web/src/test/**',
          ],
        },
      ],
      // apps/web/src/components holds building blocks (form, states, findings
      // badges, dialogs) that every panel composes, next to the panels.
      'noctcore-architecture/no-cross-feature-imports': [
        'error',
        {
          featureRoot: 'components',
          alias: '@/components',
          sharedFeatures: [
            'ui',
            'form',
            'states',
            'findings',
            'shell',
            'split',
            'views',
            'confirm-dialog',
            'copy-command',
            'page-header',
            'access-callout',
          ],
        },
      ],
    },
  },
  {
    // SplitView is the list and detail layout every triage page shares. Its props
    // are render slots (row, lead, detail, group, header, footer) plus the URL
    // selection keys, not unrelated concerns; 15 is the whole layout contract.
    files: ['apps/web/src/components/split/split-view.tsx'],
    rules: { 'noctcore-react/max-props-per-component': ['error', { max: 15 }] },
  },
  {
    // Settings composes the notification and source forms by design: each
    // section is the settings home of another feature.
    files: ['apps/web/src/components/settings/**/*.{ts,tsx}'],
    rules: { 'noctcore-architecture/no-cross-feature-imports': 'off' },
  },
  {
    // One component per file, the file named after it. Pages under routes/ are
    // named after their URL segment instead.
    files: ['apps/web/src/components/**/*.tsx'],
    ignores: ['apps/web/src/components/ui/**'],
    rules: { 'noctcore-architecture/filename-matches-export': 'error' },
  },

  // Layers. Flat config replaces no-restricted-imports per block instead of
  // merging it, so the globs of these blocks never overlap.
  ...Object.entries(SERVER_LAYERS).map(([folder, allowed]) => serverLayer(folder, allowed)),
  {
    files: WEB_SRC,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@hinomi/server', '@hinomi/server/*'],
              message: 'The web app talks to the server over HTTP only.',
            },
            {
              regex: '(^|/)server/src(/|$)',
              message: 'The web app talks to the server over HTTP only.',
            },
            NODE_BUILTINS,
          ],
        },
      ],
    },
  },
  {
    // The fix runner action runs in a target repo's workflow, apart from the Hinomi server.
    // It shares the contract in @hinomi/shared and imports no app.
    files: ['actions/fix-runner/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@hinomi/server', '@hinomi/server/*', '@hinomi/web', '@hinomi/web/*'],
              message: 'The fix runner never imports an app; share code through @hinomi/shared.',
            },
            {
              regex: '(^|/)apps/',
              message: 'The fix runner never imports an app; share code through @hinomi/shared.',
            },
          ],
        },
      ],
    },
  },
  {
    // The shared contract runs in both apps, so it stays pure: zod and plain
    // TypeScript, no platform API, no I/O, no import from an app.
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@hinomi/server', '@hinomi/server/*', '@hinomi/web', '@hinomi/web/*'],
              message: 'packages/shared never imports an app.',
            },
            { regex: '(^|/)apps/', message: 'packages/shared never imports an app.' },
            NODE_BUILTINS,
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'process',
          'Buffer',
          'require',
          'module',
          '__dirname',
          '__filename',
          'global',
          'setImmediate',
          'window',
          'self',
          'document',
          'navigator',
          'location',
          'localStorage',
          'sessionStorage',
          'fetch',
          'XMLHttpRequest',
          'WebSocket',
        ].map((name) => ({
          name,
          message: 'packages/shared stays free of platform APIs and I/O.',
        })),
      ],
    },
  },
  prettier,
)

# Design

- [prototype.html](prototype.html): the interactive design prototype (open it in a browser). All demo data is fictional. It covers the exposure overview, all alerts, finding detail with the fix agent flow, deployments, fix runs, settings, first run onboarding and the planned drift guards.
- [tokens.css](tokens.css): the design tokens as a Tailwind CSS v4 `app.css` starting point (`:root`, `.dark`, `@theme inline`), using shadcn token names where they exist.

## Key decisions

- **Type:** Geist for UI, Geist Mono for packages, versions and ids. Sizes 12, 13, 14 (base), 16, 20, 26 px.
- **Color:** neutrals tinted toward indigo (hue 265), one indigo accent. Severity has its own hues, always paired with an icon and a word: critical (octagon), high (triangle), moderate (circle), low (info).
- **Shape:** 4 px badges, 6 px buttons and inputs, 10 px panels; 4 px spacing grid.
- **Icons:** Tabler outline icons (`@tabler/icons-react`).
- **Counts:** "Exposed" means critical or high, runtime, public and not verified fixed. "Needs action" means exposed with no snooze or accepted risk in force. Blind spots are counted separately. The sidebar badge shows "needs action".
- **Rank, never hide:** every row shows a four-box rank marker (severity, runtime, deployed, public); snoozes and accepted risks stay visible with their reason and expiry.
- **Keyboard:** j/k, Enter, g then a letter to switch views, / to search, x to select, f to run the fix agent, s to snooze, t for theme, ? for help.
- **Phone:** a bottom tab bar replaces the sidebar; from 761 to 1024 px the sidebar collapses to icons.

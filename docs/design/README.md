# Design

- [tokens.css](tokens.css): the Nightshade design tokens as a Tailwind CSS v4 starting point (`:root` light, `.dark`, `@theme inline`), using shadcn token names where they exist. The app's copy is `apps/web/src/index.css`.
- [fix-runner.md](fix-runner.md): design of the GitHub Actions fix runner that applies fix plans and opens one pull request per repo.
- [github-sources.md](github-sources.md): several GitHub sources, and which one reads and fixes each repo.
- [prototype.html](prototype.html): the first interactive prototype (open it in a browser), kept as history. It predates the Nightshade redesign; its layout and tokens are no longer current. All demo data is fictional.

## Direction

Split triage in the Nightshade theme: an icon rail, a ranked list on the left and the live detail of the selected item on the right, keyboard first. Every section uses the same list and detail split; below about 1100 px it becomes list, then detail.

## Key decisions

- **Theme:** dark first (plum surfaces, lilac ink, one violet accent). A light variant (lilac paper, the same violet at L 0.50) follows the system or the theme switch.
- **Type:** Instrument Sans for UI, JetBrains Mono for packages, versions, ids and keys. Sizes 13 (meta, the floor: nothing smaller), 13.5 (controls), 15 (base), 17 (section), 22 (detail title), 32 (page title), 64 (hero) px. Self-hosted from `@fontsource-variable`.
- **Surfaces:** sidebar (rail, key bar), page, panel, raised (hover, active item, group rows), border, border strong (controls), each a clear step apart.
- **Text:** three steps. Text for titles, values and package names; text 2 for body and labels; text 3 for meta lines, hints and column heads.
- **Severity reads without color:** each level has its own icon, word and fill weight. Critical is the only solid fill (octagon); high (triangle), moderate (circle) and low (info) are icon and word on no fill. Red means critical and nothing else.
- **Blind spots:** cyan with a hatch and an eye-off icon, never red.
- **Shape:** 6 px badges and kbd, 10 px buttons, inputs and rail items, 14 px panels; 4 px spacing grid.
- **Icons:** Tabler outline icons (`@tabler/icons-react`).
- **Counts:** "Exposed" means critical or high, runtime, public and not verified fixed. "Needs action" means exposed with no snooze or accepted risk in force; it is the badge on the rail. Blind spots are counted separately.
- **Rank, never hide:** every row shows why it ranks; snoozes and accepted risks stay visible with their reason and expiry.

## Shell

- **Icon rail** (88 px, from 761 px): Exposure (needs action badge), Deploys, Alerts, Fixes (badge while fix runs are in progress), Drift; Theme and Settings at the bottom, then the scan status dot. Other counts are in each item's tooltip.
- **Top bar:** breadcrumb, last scan, access status (from `/api/access`) and Scan now. On split views it sits over the detail pane.
- **Key hint bar** at the foot of the content or the detail pane, from 761 px. `?` opens all keys.
- **Phone** (up to 760 px): a header with the page name and icon buttons, and a bottom tab bar (Exposure, Deploys, Alerts, Fixes, More).

## Keyboard

j and k move, Enter opens the selected row (on a split view, the focus view), Esc goes back to the list, f runs the fix agent, s snoozes, a accepts the risk, / searches, g then a letter switches views (e, d, a, f, s), t switches the theme, ? lists all keys.

## Measured contrast

WCAG 2 contrast ratios of the final tokens, on the panel surface unless noted.

| Pair | Dark | Light |
| --- | --- | --- |
| Text | 15.51 | 17.25 |
| Text 2 | 10.84 | 10.47 |
| Text 3 (meta) | 7.63 | 7.11 |
| Text 3 on raised | 6.72 | 6.03 |
| Label on accent button | 9.42 | 6.20 |
| Accent ink | 10.20 | 7.62 |
| Accent ink on accent soft (rail badge) | 7.79 | 5.83 |
| Focus ring on page | 11.52 | 4.92 |
| Label on critical fill | 6.75 | 5.59 |
| High | 9.22 | 5.69 |
| Moderate | 12.51 | 5.90 |
| Low | 8.69 | 6.19 |
| Blind spot | 10.31 | 6.08 |
| Blind spot on its hatch | 8.00 | 5.20 |
| Success | 10.04 | 5.78 |
| Waiting | 10.47 | 5.81 |

Border strong (control outlines, WCAG 1.4.11 non-text, target 3:1) measures 3.64 (dark) and 3.62 (light) against the panel, 3.95 and 3.41 against the page, and 3.22 and 3.07 against raised.

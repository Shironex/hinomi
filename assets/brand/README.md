# Brand

The Hinomi mark is a fire lookout tower with a lit bell: the watchman looks for real smoke and only then rings. The tower is lilac on a deep night violet tile, and the bell is the only warm color.

## Files

| File | What it is |
|---|---|
| `mark.svg` | The tower alone. It takes `currentColor`, the bell stays ember. Use it on a tile or background you control. |
| `icon.svg` | The full app icon: tower on the rounded violet tile, with the glow behind the bell. README and PWA source. |
| `icon-maskable.svg` | Full bleed square version with the tower inside the maskable safe zone (the center 80 percent circle). Source for the maskable PWA icon and the apple touch icon. |
| `favicon.svg` | The small size cut for 16 to 48 px: no finial or railing slats, thicker legs, edges on the 16 px grid. Copied to `apps/web/public`. |
| `social-preview.html` | Source of the GitHub social preview (1280 x 640, text inside the 40 px safe border). |
| `social-preview.png` | Rendered social preview. Upload it in the repo settings under Social preview. |
| `render.js` | Renders every PNG below from the sources above. |

Rendered into `apps/web/public`: `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`.

The in app `BrandMark` (`apps/web/src/components/shell/brand-mark.tsx`) inlines the `favicon.svg` paths on the theme's accent tile. If you change the small cut, update both.

## Colors

| Role | Hex | OKLCH |
|---|---|---|
| Tile top | `#2e1c44` | `oklch(0.27 0.075 302)` |
| Tile bottom | `#190c28` | `oklch(0.19 0.055 302)` |
| Tower (lilac, the dark theme `--primary`) | `#d5a8f8` | `oklch(0.8 0.12 310)` |
| Bell (ember) | `#ffa746` | `oklch(0.8 0.15 65)` |

## Regenerate

Edit the SVG or HTML sources, then run from the repo root:

```sh
pnpm install   # the social preview loads Instrument Sans from apps/web/node_modules
pnpm brand
```

The script drives a headless Chromium directly, so it needs no npm package. It uses `CHROME_PATH` if set, then a Playwright headless shell download, then an installed Chrome or Edge. If none is found, run `pnpm dlx playwright install --only-shell chromium` once.

## Usage

- Minimum size: `icon.svg` and `mark.svg` from 48 px up; below that use `favicon.svg` or the in app `BrandMark`.
- Clear space: keep at least a quarter of the icon's width empty around it.
- Do not recolor the bell. It stays ember on every background; the tower may take any single color.
- Do not stretch, rotate, outline or add effects to the mark, and do not put the tower on a busy photo.

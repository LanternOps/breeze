# Astro 7 / Tailwind 4 / Vite 8 — visual regression baseline

Reference screenshots captured on a **pristine `origin/main` @ `cb79fbaf5`** tree
(Astro 6.4.7 + Tailwind 3.4 + `@astrojs/tailwind`), BEFORE any upgrade work.
Every later phase (Tailwind 4 portal, Tailwind 4 web, Astro 7) diffs against these.

Captured via the `worktree-stack` stack (`pnpm wt-stack up`) + Playwright, logged in as
`admin@breeze.local` / `BreezeAdmin123!`. Dark mode toggled exactly as the app does:
`localStorage['theme']='dark'` + `.dark` class on `<html>` (see `apps/web/public/theme-bootstrap.js`).

| File | Surface | Theme | Why it matters for the migration |
|---|---|---|---|
| `astro7base-01-dashboard-light.png` | Dashboard `/` | light | cards, stat tiles, borders, shadows |
| `astro7base-02-dashboard-dark.png` | Dashboard `/` | dark | dark-mode token swap (the `@custom-variant dark` risk) |
| `astro7base-03-devices-light.png` | Devices table `/devices` | light | data-table borders/rows (Tailwind 4 `currentColor` border default) |
| `astro7base-04-devices-dark.png` | Devices table `/devices` | dark | table in dark mode |
| `astro7base-05-scripts-monaco-light.png` | New Script `/scripts/new` | light | Monaco editor (white-editor regression risk) |
| `astro7base-06-scripts-monaco-dark.png` | New Script `/scripts/new` | dark | Monaco dark theme intact |
| `astro7base-07-alerts-light.png` | Alerts `/alerts` | light | status colors, badges |
| `astro7base-08-alerts-dark.png` | Alerts `/alerts` | dark | alerts in dark mode |
| `astro7base-09-portal-login-light.png` | Portal login `/portal/login` | light | portal theme tokens (no `info`/`font-sans` extension) |
| `astro7base-10-portal-login-dark.png` | Portal login `/portal/login` | dark | portal dark mode |

## Notes / gaps

- **No authenticated portal page**: the e2e seed creates no portal-contact credential, so the
  portal baseline is the login page only (light + dark). It still exercises the portal's full
  theme surface (logo, card, form inputs, button, links, footer) — adequate for the CSS swap.
- Focus areas when diffing (documented Tailwind 4 default changes): border colors
  (`gray-200` → `currentColor`), focus rings, shadow scale, rounded corners, removed
  `*-opacity-*` utilities.

## Plan-command corrections discovered during Phase 0

The plan's literal commands need these fixes (neither app defines an `astro` script;
web's `test` is watch-mode):

1. `pnpm --filter X astro check` → **`pnpm --filter X exec astro check`**
2. Web baseline/CI test → **`pnpm --filter @breeze/web exec vitest run`** (bare `test` = `vitest` watch)
3. CSP drift guard (Task 5) is the **`csp:guard`** npm script
   (`node --experimental-strip-types scripts/check-csp-violations.ts`), not `tsx scripts/...`.
4. The worktree needs the gitignored root `.env` copied in before `pnpm wt-stack up`.

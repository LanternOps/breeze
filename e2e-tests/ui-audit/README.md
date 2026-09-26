# UI audit

Screenshots every page of the web app and the customer portal at three
viewports (mobile 390, tablet 1024, desktop 1440) in light and dark, runs
mechanical detectors on each render, and writes a report plus a **triage
queue**: only the renders worth a model's (or a person's) attention.

The capture and detectors cost no model tokens. Models only see the queue.

## Run

```bash
pnpm wt-stack up                       # local seeded stack; writes .breeze-stack.json
cd e2e-tests && npm ci
npm run ui-audit                       # everything → ui-audit-out/<timestamp>/
npm run ui-audit -- --only /devices,/alerts --viewports mobile,desktop
npm run ui-audit -- --baseline ui-audit-out/<previous-run>   # + pixel diff
npm run ui-audit -- --from ui-audit-out/<run> --min-severity high  # re-derive report, no capture
npm run ui-audit -- --resume ui-audit-out/<run>                     # finish an interrupted run
```

If the stack dies mid-run, the run stops instead of recording error pages.
A document 502/503/504 plus a failed health check trips it. It exits 2 and
prints the `--resume` command. The dev `web` container can segfault under
amd64 emulation on Apple Silicon. If `docker restart` then loops on
"Another astro dev server is already running", delete the stale lock first:
`docker exec <project>-web-1 rm -f /app/apps/web/.astro/dev.json`.

A full run is about 200 routes × 6 renders, roughly 40 minutes on the
default 2 workers. More workers trip the dev stack's API rate limiter; a
route that sees a 429 is backed off and recaptured, not audited in its
degraded state. The tool refuses a non-localhost target unless you pass
`--allow-remote`: **never point it at production.** Same-origin writes are
blocked during capture and reported as `mutation-on-load`. Exceptions are
`/auth/*`, the realtime `ws-ticket`, read-only `…/search` and `…/query`
POSTs, and the report builder's live preview (`/reports/generate`). Blocked
writes are listed on each triage entry, so a model doesn't report the error
state they cause. Pass `--allow-mutations` to let everything through. All flags are
listed at the top of `run.ts`.

The capture strips its own artifacts: the first-run onboarding tour is
pre-dismissed, the Astro dev toolbar is removed, and pages wait for
spinners, skeletons and `aria-busy` regions to clear (up to 15s, otherwise
`stuck-loading`).

It needs `admin@breeze.local` (and `portal@breeze.local` for the portal, which
`e2e-tests/seed-fixtures.sql` seeds). It resets the `login:*` rate limiter
before logging in, which needs `REDIS_PASSWORD` in the root `.env`.

## Output

| File | What |
|---|---|
| `report.md` | Counts by kind, repeated visual findings, accessibility/runtime table by rule, failed/unresolved/skipped routes, worst routes, layout groups |
| `triage-queue.json` | Vision-model input, **layout findings only**. `shell`: the same finding (normalized selector and culprit) on 3+ routes, with one representative screenshot each. `items`: the remaining per-route findings at or above `--min-severity` (default medium), each with only the screenshots where they fired, a `crops` close-up for findings below the fold, and the `blocked` writes on that route |
| `non-visual.json` | axe, console, network and navigation findings grouped by rule, with route counts and the most frequent selectors or messages. These are exact already and need no model |
| `layout-groups.json` | Routes grouped by page shape (`table+tabs`, `form`, `plain`, …) for the critique tier |
| `results.json` | Everything, per route |
| `<app>/<route>/<viewport>-<theme>.png` | The renders. The app scrolls its main panel, not the document, so these show the viewport only |
| `<app>/<route>/<viewport>-<theme>-<n>.png` | Close-up of finding `n` when the render doesn't show it (medium+ findings below the fold; up to 8 per render) |

Dynamic routes (`/devices/[id]`) are filled from links found on the static
pages. Any the tool couldn't fill are listed in the report; pin them with
`--params params.json` (`{"/tickets/[id]": "/tickets/<uuid>"}`).

## Detectors

| Kind | Severity | Catches |
|---|---|---|
| `page-horizontal-overflow` | high | Page scrolls sideways; names the element that sticks out |
| `offscreen-control` | high | Control cut off by the viewport edge (closed off-canvas drawers are ignored) |
| `covered-control` | high | Control's centre hit-tests to an unrelated element (ignores scrolled-away and half-scrolled items) |
| `content-overflow` | medium | In-flow content spills out of its box (positioned popovers/badges ignored) |
| `clipped-text` | medium | Text cut by `overflow:hidden` with no ellipsis/line-clamp |
| `broken-image` | medium | `<img>` that failed to load |
| `small-target` | low | Tap target < 24×24 on mobile |
| axe rules (`color-contrast`, `label`, …) | by impact | WCAG 2.2 AA, desktop viewport, both themes (`--axe all` for every viewport) |
| `console-error`, `page-error`, `api-error` | medium / high | Runtime errors while loading the page |
| `redirected`, `http-error`, `stuck-loading` | medium / high | Page didn't render where or when expected |

Detector tests run real Chromium against fixture HTML: `npx vitest run ui-audit`.
CI doesn't run e2e-tests vitest, so run the tests locally when you change a
detector.

## Using models on the output (cheapest first)

1. **Bug triage (plus a few UX notes):** give each `triage-queue.json`
   `shell` entry and `items` entry, with its screenshots and close-ups, to an
   Opus-class model using `prompts/triage.md`. Batch 3–5 per call. **Not
   Haiku:** on the 2026-09-26 comparison it waved through real clipping and
   overlap bugs as "fits". The prompt has the numbers. Clean renders, axe
   findings and runtime errors never go to a model. On the last full run
   that left 71 of 1,044 renders.
2. **Accessibility and runtime:** work through `non-visual.json` by rule.
   Each top sample selector is usually one shared component.
3. **Design critique:** use `layout-groups.json` and `prompts/critique.md`.
   Run one top-tier critique (with the `impeccable` skill) per layout group on
   a representative page, then a cheap "what's different here" pass for the
   rest of the group.
4. **Regression:** re-run with `--baseline <previous-run>`. Changed renders
   join the queue even if no detector fired.

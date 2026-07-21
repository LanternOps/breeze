# Custom Astro Error Pages — Design

**Date:** 2026-06-12
**Status:** Approved
**Area:** `apps/web` (Astro SSR frontend)

## Problem

The web app (`apps/web`) runs Astro in SSR mode (`output: 'server'`, `@astrojs/node`
standalone adapter) and has **no custom error pages**. Unmatched routes and uncaught
server errors currently fall through to Astro/node's default, unbranded error output.
We want friendly, on-brand 404 and 500 pages consistent with the rest of the product.

## Goals

- A branded **404** page for unmatched routes.
- A branded **500** page for uncaught server errors, reporting the error to Sentry and
  surfacing a reference ID to the user.
- Theme-aware (light/dark), consistent with existing pages.
- Robust: render correctly even when client JS / hydration is broken.

## Non-Goals

- No 403/401/other status pages (Astro SSR only auto-routes 404 and 500; others would be
  unused manual components today — YAGNI).
- No interactive/React-island behavior on error pages.
- No middleware or `astro.config.mjs` changes.

## Design

### Components

1. **`src/layouts/ErrorLayout.astro`** — new, minimal, fully self-contained layout.
   - Own `<!DOCTYPE html>`, `<head>` with charset/viewport/favicon and the existing
     `/theme-bootstrap.js` external script (so theme class is set before paint).
   - **No `<ClientRouter />`** — error pages must not depend on view-transition JS.
   - Vertically + horizontally centered content area using Tailwind utilities.
   - Renders the Breeze breeze-lines SVG logo + "Breeze" wordmark (same mark as
     `AuthLayout.astro`).
   - Props: `title: string` (document title), `statusCode: number` (displayed large).
   - A `<slot>` for page-specific message + actions.
   - Theme-aware via existing CSS-variable Tailwind tokens: `bg-background`,
     `text-foreground`, `text-muted-foreground`, `text-primary`, `border-border`.
   - Deliberately not `DashboardLayout` (requires auth/data) nor `AuthLayout`
     (auth-card `max-w-md` shape).

2. **`src/pages/404.astro`** — uses `ErrorLayout`.
   - Frontmatter: `Astro.response.status = 404`.
   - Content: large "404", "Page not found" heading, one-line explanation, and two
     navigation links rendered as plain `<a>` tags: **Go to dashboard** (`/`) and
     **Sign in** (`/login`). No client JS.

3. **`src/pages/500.astro`** — uses `ErrorLayout`.
   - Frontmatter: `Astro.response.status = 500`.
   - Reads the thrown error from `Astro.props.error` (Astro passes it to `500.astro`
     in SSR).
   - Calls `Sentry.captureException(error)` from `@sentry/astro` (already a dependency,
     v10) inside a `try/catch` so the error page can never throw itself. `error` may be
     `undefined` (e.g. direct navigation to `/500`) — guard for that.
   - Displays "Something went wrong", a short message, the Sentry **event ID as a
     reference code** (only when one was produced), and the same two nav links.

### Data Flow

Astro's node SSR adapter automatically routes:
- any unmatched path → `src/pages/404.astro`
- any uncaught render/middleware error → `src/pages/500.astro`

No config, route, or middleware wiring required.

### Styling

- Tailwind utility classes only, matching existing page conventions.
- Light/dark handled automatically by `theme-bootstrap.js`.

### CSP

The strict hash-based CSP in `astro.config.mjs` already allows `/theme-bootstrap.js`
via `script-src 'self'`. The error pages add **no inline scripts**, so no new sha256
hashes are needed. `ErrorLayout` reuses only the already-permitted external script.

### Testing

Astro `.astro` pages are not currently unit-tested in this repo. Plan:
1. Confirm there's no existing `.astro` test harness.
2. Primary verification: `pnpm --filter @breeze/web build` succeeds with the new pages
   (smoke check that they compile and integrate with SSR routing).
3. If a lightweight test adds value without inventing a harness, add an Astro Container
   API render test asserting each page contains its status code and key copy. Otherwise
   rely on the build check rather than fabricating a bespoke harness.

## Files

| File | Change |
|---|---|
| `apps/web/src/layouts/ErrorLayout.astro` | new |
| `apps/web/src/pages/404.astro` | new |
| `apps/web/src/pages/500.astro` | new |
| `docs/superpowers/specs/web-ui/2026-06-12-custom-astro-error-pages-design.md` | new (this doc) |

## Risks / Notes

- `Astro.props.error` availability on `500.astro` is SSR-specific; the page must render
  fine when it's absent (e.g. direct `/500` navigation in tests).
- `@sentry/astro` server export must expose `captureException` in the node SSR runtime;
  verify during implementation that the import resolves server-side.

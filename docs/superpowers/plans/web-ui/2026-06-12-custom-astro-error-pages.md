# Custom Astro Error Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add branded, theme-aware 404 and 500 error pages to the Astro SSR web app, with the 500 page reporting to Sentry and showing the user a reference ID.

**Architecture:** Three new `.astro` files (a self-contained `ErrorLayout` plus `404.astro` and `500.astro` pages that Astro's node SSR adapter auto-routes to) and one pure TS helper (`captureRenderError`) that owns the only real logic — capturing a render error to Sentry and returning its event ID. The helper is unit-tested (TDD); the static markup is verified by the Astro build.

**Tech Stack:** Astro 5 SSR (`@astrojs/node` standalone), Tailwind, `@sentry/astro` v10, Vitest.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/lib/captureRenderError.ts` | Pure helper: capture an error to Sentry, return event ID or null. Never throws. |
| `apps/web/src/lib/captureRenderError.test.ts` | Unit tests for the helper (mocked Sentry). |
| `apps/web/src/layouts/ErrorLayout.astro` | Minimal standalone layout: branded, theme-aware, centered, big status number, slot. No `ClientRouter`, no client JS. |
| `apps/web/src/pages/404.astro` | Not-found page; sets status 404; uses ErrorLayout. |
| `apps/web/src/pages/500.astro` | Server-error page; sets status 500; captures error via helper; uses ErrorLayout. |

**Pre-work (run once in the worktree before Task 1):** this is a fresh worktree, so install deps. All `pnpm`/`vitest` commands assume the pinned Node from memory.

```bash
cd /Users/toddhebebrand/breeze/.claude/worktrees/custom-error-pages
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
```

---

### Task 1: `captureRenderError` helper (TDD)

**Files:**
- Create: `apps/web/src/lib/captureRenderError.ts`
- Test: `apps/web/src/lib/captureRenderError.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/captureRenderError.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const captureException = vi.fn();
vi.mock('@sentry/astro', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

import { captureRenderError } from './captureRenderError';

describe('captureRenderError', () => {
  beforeEach(() => {
    captureException.mockReset();
  });

  it('returns null and does not call Sentry when there is no error', () => {
    expect(captureRenderError(undefined)).toBeNull();
    expect(captureRenderError(null)).toBeNull();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('captures the error and returns the Sentry event id', () => {
    captureException.mockReturnValue('evt_123');
    const err = new Error('boom');
    expect(captureRenderError(err)).toBe('evt_123');
    expect(captureException).toHaveBeenCalledWith(err);
  });

  it('returns null when Sentry returns no event id', () => {
    captureException.mockReturnValue(undefined);
    expect(captureRenderError(new Error('boom'))).toBeNull();
  });

  it('returns null when Sentry itself throws (error page must never break)', () => {
    captureException.mockImplementation(() => {
      throw new Error('sentry down');
    });
    expect(captureRenderError(new Error('boom'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/lib/captureRenderError.test.ts
```
Expected: FAIL — cannot resolve `./captureRenderError` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/lib/captureRenderError.ts`:

```ts
import * as Sentry from '@sentry/astro';

/**
 * Capture a server render error to Sentry and return its event ID so the 500
 * page can show the user a reference code. Never throws — error reporting must
 * not be able to break the error page itself. Returns null when there is no
 * error to report or capture failed/produced no id.
 */
export function captureRenderError(error: unknown): string | null {
  if (error == null) return null;
  try {
    return Sentry.captureException(error) ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/lib/captureRenderError.test.ts
```
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/captureRenderError.ts apps/web/src/lib/captureRenderError.test.ts
git commit -m "feat(web): add captureRenderError helper for 500 page Sentry reporting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `ErrorLayout.astro`

**Files:**
- Create: `apps/web/src/layouts/ErrorLayout.astro`

- [ ] **Step 1: Create the layout**

Create `apps/web/src/layouts/ErrorLayout.astro`. Mirrors `AuthLayout.astro` branding but is centered for error display, takes a `statusCode`, and omits `ClientRouter` (no view-transition JS on error pages):

```astro
---
import '../styles/globals.css';

interface Props {
  title: string;
  statusCode: number;
}

const { title, statusCode } = Astro.props;
---

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Breeze RMM - Remote Monitoring and Management" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <!--
      Theme bootstrap is the same already-CSP-allowed external script used by
      Layout.astro; it sets the light/dark class before paint. No ClientRouter
      here on purpose — error pages must render without view-transition JS.
    -->
    <script is:inline src="/theme-bootstrap.js"></script>
    <title>{title} | Breeze RMM</title>
  </head>
  <body class="min-h-screen bg-background antialiased">
    <main class="flex min-h-screen flex-col items-center justify-center px-4 py-12 text-center">
      <div class="flex items-center gap-2 text-primary">
        <svg width="22" height="22" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M12 22C12 22 20 22 28 22C36 22 40 16 48 16C52 16 54 18 54 20C54 22 52 24 48 24C44 24 42 22 42 22" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M8 34C8 34 18 34 30 34C42 34 46 28 52 28C55 28 57 30 57 32C57 34 55 36 52 36C48 36 46 34 46 34" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M14 46C14 46 22 46 32 46C40 46 44 40 50 40C53 40 55 42 55 44C55 46 53 48 50 48C46 48 44 46 44 46" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="text-lg font-bold tracking-tight text-foreground">Breeze</span>
      </div>

      <p class="mt-10 text-7xl font-bold tracking-tight text-primary sm:text-8xl">{statusCode}</p>

      <div class="mt-4 w-full max-w-md space-y-6">
        <slot />
      </div>
    </main>
  </body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/layouts/ErrorLayout.astro
git commit -m "feat(web): add ErrorLayout for branded error pages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `404.astro`

**Files:**
- Create: `apps/web/src/pages/404.astro`

- [ ] **Step 1: Create the page**

Create `apps/web/src/pages/404.astro`:

```astro
---
import ErrorLayout from '../layouts/ErrorLayout.astro';

Astro.response.status = 404;
---

<ErrorLayout title="Page not found" statusCode={404}>
  <h1 class="text-2xl font-semibold tracking-tight text-foreground">Page not found</h1>
  <p class="text-sm text-muted-foreground">
    The page you&rsquo;re looking for doesn&rsquo;t exist or may have been moved.
  </p>
  <div class="flex items-center justify-center gap-3">
    <a
      href="/"
      class="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      Go to dashboard
    </a>
    <a
      href="/login"
      class="inline-flex h-10 items-center justify-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
    >
      Sign in
    </a>
  </div>
</ErrorLayout>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/404.astro
git commit -m "feat(web): add custom 404 page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `500.astro`

**Files:**
- Create: `apps/web/src/pages/500.astro`

- [ ] **Step 1: Create the page**

Create `apps/web/src/pages/500.astro`. Astro passes the thrown error as `Astro.props.error` in SSR; it may be absent (direct navigation), which the helper handles:

```astro
---
import ErrorLayout from '../layouts/ErrorLayout.astro';
import { captureRenderError } from '../lib/captureRenderError';

Astro.response.status = 500;

const { error } = Astro.props as { error?: unknown };
const referenceId = captureRenderError(error);
---

<ErrorLayout title="Something went wrong" statusCode={500}>
  <h1 class="text-2xl font-semibold tracking-tight text-foreground">Something went wrong</h1>
  <p class="text-sm text-muted-foreground">
    An unexpected error occurred on our end. Our team has been notified &mdash; please try
    again in a moment.
  </p>
  {referenceId && (
    <p class="text-xs text-muted-foreground">
      Reference ID:
      <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{referenceId}</code>
    </p>
  )}
  <div class="flex items-center justify-center gap-3">
    <a
      href="/"
      class="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      Go to dashboard
    </a>
    <a
      href="/login"
      class="inline-flex h-10 items-center justify-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
    >
      Sign in
    </a>
  </div>
</ErrorLayout>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/500.astro
git commit -m "feat(web): add custom 500 page with Sentry reference id

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Build verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Type-check + build the web app**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web build
```
Expected: build succeeds. `404` and `500` appear as prerendered/SSR routes in the
output with no TypeScript or Astro compile errors. If the build complains that
`Astro.props.error` is not typed, the `as { error?: unknown }` cast in `500.astro`
already resolves it — confirm no other type errors surfaced.

- [ ] **Step 2: Run the helper unit tests once more (regression)**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/lib/captureRenderError.test.ts
```
Expected: PASS — 4 tests.

- [ ] **Step 3: Manual dev smoke (optional but recommended)**

Start the dev server and visit an unknown route to see the 404:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web dev
```
Then open `http://localhost:4321/this-route-does-not-exist` — expect the branded 404
(big "404", logo, two links), correct in both light and dark themes. Stop the server
when done (Ctrl+C). Note: `theme-bootstrap.js` sets the theme; verify no CSP errors in
the browser console.

- [ ] **Step 4: No commit needed** — verification only. If Step 1 or 2 revealed a fix,
  amend the relevant task's commit rather than adding an empty one.

---

## Self-Review Notes

- **Spec coverage:** 404 page (Task 3), 500 page (Task 4), Sentry capture + reference ID
  (Task 1 helper + Task 4 wiring), shared ErrorLayout / theme-aware / no client JS
  (Task 2), build-based verification (Task 5). All spec sections map to a task.
- **No 403/other pages** — matches the spec's non-goals.
- **Type consistency:** helper exported as `captureRenderError(error: unknown): string | null`;
  imported and used identically in `500.astro`. `ErrorLayout` props `{ title, statusCode }`
  used consistently by both pages.
- **CSP:** only the pre-allowed external `/theme-bootstrap.js` is referenced; no new inline
  scripts, so no `astro.config.mjs` hash changes — consistent with the spec.

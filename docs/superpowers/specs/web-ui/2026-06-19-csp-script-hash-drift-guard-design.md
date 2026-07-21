# CSP `script-src` hash-drift: delete dead pins + real-browser drift guard

**Date:** 2026-06-19
**Issue:** [#1232](https://github.com/LanternOps/breeze/issues/1232) — "Hardcoded CSP `script-src` sha256 hashes drift from emitted inline scripts → blocked Astro hydration + React #418"
**Supersedes:** the fetch-based partial guard in draft PR #1342 (`fix/1232-csp-hash-drift`)

## Problem

`apps/web/astro.config.mjs` carries two **hand-maintained** sha256 hashes in
`security.csp.scriptDirective.resources`:

```js
"'sha256-dr7co1YqmJP1+caEJBfXkM/oHRwOVAknT+gDygo8nD0='",
"'sha256-6wgjuQN80bYuvy8C2/v+mFX1HAEgrfvSs+beElRyx+8='"
```

They were added (#618) to authorize an inline script associated with Astro's
`<ClientRouter>` view-transition **swap** path — content Astro's build-time CSP
hasher does not cover. Because the hash is constant *per Astro version*, an Astro
upgrade can change the emitted script, leaving the pinned hash stale. When that
happens the browser blocks the inline script **at runtime, after deploy** — the
build still succeeds, so nothing in CI catches it. The original report saw the
downstream symptom: blocked inline scripts plus `Minified React error #418`
(hydration mismatch). This is a silent, deploy-time landmine, fragile by
construction.

## Spike findings (2026-06-19)

A throwaway investigation resolved the two open questions — provenance of the
hashes, and whether they are still load-bearing — definitively:

1. **The hashes are not a locatable source literal.** Hashing all 387 string
   literals in Astro's `dist/transitions` + `dist/runtime/server`, plus our
   layout inline scripts, matched neither pin. (Our theme bootstrap is now an
   *external* script — `src="/theme-bootstrap.js"` — so it is hashed via `src`,
   not content.) Any "compute the hash from a source file at build time" approach
   is therefore not reliably implementable.

2. **The pins are stored as manual `scriptResources`, separate from Astro's
   auto-computed `scriptHashes`**, and Astro never regenerates them (confirmed in
   the built `dist/server` CSP config object). They are purely hand-supplied.

3. **Initial-load inline scripts do not need them.** Booting the production build
   and hashing every inline `<script>` across `/`, `/login`, `/forgot-password`,
   `/setup`, `/devices` produced three hashes — all of which are already in
   Astro's auto-generated `scriptHashes`. Neither pin reproduced (0/2).

4. **The pins are dead.** Removing both pins, rebuilding production, serving with
   CSP enforced, and driving a real Chromium through two `<ClientRouter>`
   view-transition swaps (`/login` → `/forgot-password` → `/login`) produced
   **zero CSP violations** (only expected API-404 console errors). On Astro
   6.4.7 the swap path emits no inline script requiring these hashes; the pins
   are harmless dead weight that browsers silently ignore.

**Residual caveat:** the browser spike reached only public auth-layout pages;
`DashboardLayout` routes need a backend + auth to render. The swap script is
page-agnostic, so the dead-pin conclusion holds — but deletion must be confirmed
against at least one **authenticated dashboard navigation** before/within the
implementing PR (covered by the e2e assertion below).

## Decision

Delete the dead pins and prevent the drift class from ever shipping silently
again with a **real-browser** guard, rather than a generator/derivation/nonce.

### Non-goals (ruled out, with reasons)

- **Per-request nonce** (the issue's headline suggestion): Astro 6.4.7's CSP
  implementation has **no nonce support** (`dist/core/csp` contains no nonce
  path). Not implementable without forking Astro.
- **Remove `<ClientRouter>` / view transitions:** load-bearing across all four
  layouts and the entire dashboard shell (`Sidebar`, `Header`, `AuthOverlay`,
  `AdminSessionManager`, `AiChatSidebar`, `HelpPanel`, `ToastContainer` all use
  `transition:persist`; `navigation.ts` calls `navigate()`). Removing it is a
  separate SPA-shell rearchitecture, not a fix for this.
- **Build-time hash generator:** no stable source literal to derive from (finding
  #1); the only reliable derivation is a headless-browser capture, at which point
  a *guard* is simpler than a *generator* that must rewrite and commit config.
- **Keep the fetch-based guard (#1342):** it cannot observe the runtime swap path
  (it only sees initial-GET HTML), which is the exact vector #1232 describes.

## Design

### Part 1 — Delete the dead pins

In `apps/web/astro.config.mjs`, `security.csp.scriptDirective.resources` becomes:

```js
resources: [
  "'self'",
  'https://static.cloudflareinsights.com',
]
```

Update the surrounding comment: explain that Astro auto-hashes all build-time
inline scripts, that no hand-pinned hashes are carried, and that the drift guard
(below) is the safety net for any future Astro version that introduces a
runtime-only inline script.

### Part 2 — Standalone web-only drift guard (primary CI gate)

A dedicated, lightweight check that does not require the API/DB:

- **Boots** the production web build (`node dist/server/entry.mjs`, the
  `@astrojs/node` standalone adapter) on a test port, CSP enforced (production
  mode is strict by default via `apps/web/src/middleware.ts`).
- **Drives Playwright** (already a repo dependency) through:
  - initial loads of representative public routes (`/`, `/login`,
    `/forgot-password`, `/setup`), and
  - **view-transition swaps** between them (click in-app links so `<ClientRouter>`
    performs a real swap — the path a fetch-based guard cannot see).
- **Listens for `securitypolicyviolation`** events (and console CSP-refusal
  errors) and **fails the job** if any inline script is blocked.
- Runs in the `build-web` CI job, replacing the fetch-based
  `apps/web/scripts/check-csp-hash-drift.ts` step.

This directly asserts the user-facing invariant ("no inline script is ever
CSP-blocked") under real runtime conditions, in both drift directions.

### Part 3 — Authenticated e2e assertion (dashboard coverage)

Bolt a CSP-violation listener onto the existing authenticated Playwright e2e
flow (`e2e-tests/`), which already logs in and reaches real `DashboardLayout`
pages with their islands and inline scripts. Register a `securitypolicyviolation`
handler at context/page setup and fail the relevant spec(s) if a violation fires
during an authenticated session that includes at least one in-app navigation
(view-transition swap) between dashboard pages.

This closes the residual caveat: it proves the pins are unnecessary on
authenticated routes too, and guards those routes going forward.

### Part 4 — Retire the fetch-based guard

Remove `apps/web/scripts/check-csp-hash-drift.ts`, its unit test
(`apps/web/src/__tests__/check-csp-hash-drift.test.ts`), and its `package.json`
script / CI wiring introduced by #1342. The browser guard supersedes it and
resolves its self-documented `UNVERIFIED` gap. Draft PR #1342 is closed in favor
of this work.

## Components & interfaces

| Unit | Responsibility | Depends on |
|---|---|---|
| `astro.config.mjs` (edit) | Carry no hand-pinned script hashes; rely on Astro auto-hash | Astro `security.csp` |
| Standalone guard (new script + CI step) | Boot prod web build, navigate + swap in Playwright, fail on CSP violation | built `dist/`, Playwright, web middleware CSP |
| e2e CSP assertion (edit to existing spec/fixture) | Fail authenticated e2e on any CSP violation incl. a dashboard swap | `e2e-tests/` harness, running stack |
| (removed) fetch guard + test | — | — |

## What the guard catches (failure modes)

- **Astro bump introduces a runtime inline script needing a hash** → swap
  navigation blocks it → `securitypolicyviolation` → **CI red** (vs. today's
  silent prod breakage). A human then adds the now-required hash (loud, only when
  actually needed) or revisits.
- **Any future hand-pinned hash goes stale / dead** → not silently carried,
  because the guard asserts real script execution rather than the presence of a
  hash string.
- **A new app inline script not covered by Astro auto-hash** → blocked on initial
  load → CI red.

## Testing

- **Standalone guard:** self-test it both ways during implementation — green on a
  correct build; red when an inline script is deliberately blocked (e.g. a
  temporary unhashed inline `<script>`), proving the assertion is load-bearing
  (the failure #1342 could not produce for the swap path).
- **e2e assertion:** confirm the authenticated flow stays green after pin
  deletion (this is the authenticated-dashboard re-verification) and goes red
  under an injected violation.
- **Existing web unit tests** (`apps/web/src/middleware.test.ts`,
  `src/lib/csp.test.ts`) must remain green; update any reference to the removed
  fetch guard.

## Rollout / verification

1. Implement in an isolated worktree off fresh `main` (per `issue-to-pr`).
2. Delete pins; run the standalone guard locally (build + boot + Playwright) →
   expect green with zero violations across initial loads and swaps.
3. Run the authenticated e2e flow with the new assertion against the full stack →
   confirm no CSP violation on a dashboard view-transition navigation. **This is
   the gate that authorizes deleting the pins.**
4. Open PR (`Closes #1232`), close #1342 as superseded.
5. UI-test hold applies: this is a user-facing CSP change; a human should
   exercise real navigations in a browser before merge.

## Open questions

None blocking. Route lists for the standalone guard are an implementation detail
(start with the four public routes exercised in the spike). If a future Astro
version legitimately requires a runtime hash, adding it back is a one-line,
CI-gated change — explicitly acceptable.

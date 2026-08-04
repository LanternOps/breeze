# Session-expiry polish (apps/web)

## Context

When a web session dies today, the user watches the sidebar evaporate (44/56 nav
items are permission-gated and `logout()` nulls `user` synchronously) while the
redirect to `/login` — if it happens at all — is an asynchronous reaction in a
different island (`AuthOverlay`). Four polish items, approved by Todd:

1. Make session death atomic and explicit: the `fetchWithAuth` give-up path must
   redirect itself (not just mutate state), and an overlay must mask the gutted
   UI during the transition.
2. Fix the `?returnTo=` / `?next=` mismatch so re-login returns to the deep link.
3. Use the 5-minute keepalive's result: a definitive auth failure logs the user
   out cleanly instead of waiting for the next click to 401.
4. Idle-timeout warning: a countdown modal ("You'll be signed out — stay signed
   in?") before the currently-silent idle logout, and an explanatory notice on
   the login page after any automatic sign-out.

Key existing machinery (verified against source):

- `apps/web/src/stores/auth.ts` — Zustand store. `fetchWithAuth` has two expiry
  paths: **Path A** (no token + refresh fails, ~L542–568) does
  `logout(); window.location.href = '/login?returnTo=…'; throw AuthSessionExpiredError`.
  **Path B** (request 401'd, refresh-and-replay failed, ~L606–624) does
  `logout()` **only** and returns the stale 401 Response.
- `requestTokenRefresh` (auth.ts ~L353) already distinguishes hard vs transient
  refresh failures internally (`refreshFetchOnce` returns
  `{tokens, raced, transient}`) but collapses everything to `Tokens | null` at
  the public surface. `restoreAccessTokenFromCookie` (~L426) returns `boolean`.
- `apps/web/src/lib/authScope.ts:37` — `loginPathWithNext()` builds
  `/login?next=<encoded current path+search+hash>`. This is the canonical
  emitter; `login.astro` reads **only** `?next=` (validated by
  `getSafeNext` in `lib/authNext.ts`).
- `apps/web/src/components/auth/AuthOverlay.tsx` — mounted in
  `DashboardLayout.astro` (`client:load transition:persist`). Once the initial
  fade completes (`fadeState === 'hidden'`) it returns `null` forever, so
  nothing masks a mid-session logout.
- `apps/web/src/components/auth/AdminSessionManager.tsx` — mounted alongside.
  30 s heartbeat: idle check (org/partner-configurable budget, 60 min default)
  → silent `apiLogout()` + `navigateTo('/login')`; then a 5-minute keepalive
  `restoreAccessTokenFromCookie()` whose return value is discarded.
- `apps/web/src/components/auth/LoginPage.tsx` — already maps
  `?error=<reason>` SSO bounces to notice copy (`ssoLoginErrorCopy`, ~L33–61);
  reads `next` prop from `login.astro`.
- Existing test expecting the old behavior: `apps/web/src/stores/auth.test.ts:399–403`
  asserts a `/login?returnTo=…` redirect — Task 1 intentionally changes this.

## Global Constraints

- **apps/web only.** No API (apps/api) changes. No new dependencies.
- **i18n:** every new user-facing string goes through `useTranslation` (`auth`
  namespace unless stated otherwise) and every new key MUST be added to ALL
  seven locales: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR}/`.
  A key-parity contract test reds CI if any locale is missing a key. Never
  write logic that compares a value against `i18n.t(...)` output.
- **Navigation on a dying session must be robust:** use
  `window.location.replace(...)` (full page load) for the expiry redirect, not
  `navigateTo` (dynamic `import('astro:transitions/client')` can fail
  mid-teardown). `loginPathWithNext()` from `lib/authScope.ts` is the only way
  to build the login URL with a return path; never hand-build `?next=`.
  Never redirect when `window.location.pathname` already starts with `/login`.
- **Reason codes** appended to the login URL are exactly `session-expired` and
  `idle` via query param `reason` (e.g.
  `/login?next=%2Fdevices&reason=session-expired`). Reuse this exact pair
  everywhere; no third value exists.
- Interactive elements added to the UI carry `data-testid` attributes
  (repo e2e convention).
- Tests are colocated with sources (vitest + jsdom). Run targeted:
  `pnpm --filter @breeze/web test -- <file> [...]`. Do not run the full suite
  per task.
- Do not modify `runAction.ts`, the Sidebar permission gating, or
  `requestTokenRefresh`'s retry/backoff/locking semantics.

## Task 1 — Central `handleSessionExpired` in the auth store; wire both fetchWithAuth paths

**Files:** `apps/web/src/stores/auth.ts`, `apps/web/src/stores/auth.test.ts`.

Add a single exported function in `auth.ts`:

```ts
export function handleSessionExpired(reason: 'session-expired' | 'idle' = 'session-expired'): void
```

Behavior:
- Idempotent: a module-level in-flight flag makes second and later calls no-ops
  (concurrent 401s from parallel requests must not double-redirect). The flag
  resets on `login()` (module-level flag + reset in the store's `login` action)
  so tests and future re-logins in the same JS context work.
- Sets a store field `sessionExpiredReason: 'session-expired' | 'idle' | null`
  (NOT persisted — exclude from `partialize`) **before** calling `logout()`, so
  UI (Task 2's overlay) can render a mask in the same tick the nav collapses.
  `login()` clears it back to `null`.
- Calls `logout()`.
- If `typeof window !== 'undefined'` and pathname does not start with `/login`:
  compute `const url = loginPathWithNext()`, append
  `(url.includes('?') ? '&' : '?') + 'reason=' + reason`, then
  `window.location.replace(url)`.
  (Import `loginPathWithNext` from `../lib/authScope` — check for import cycles;
  if `authScope` imports from `stores/auth`, move/duplicate the tiny helper
  rather than creating a cycle.)

Rewire:
- **Path A** (~L562–567): replace the `logout(); … returnTo …` block with
  `handleSessionExpired('session-expired')`, keeping the
  `throw new AuthSessionExpiredError()` after it.
- **Path B** (~L621–623): replace the bare `logout()` with
  `handleSessionExpired('session-expired')`. Still return the 401 response
  afterward (callers may inspect it; the page is navigating away).

Tests (update/add in `auth.test.ts`):
- Update the existing `returnTo` assertion (~L399–403) to expect
  `/login?next=<encoded>&reason=session-expired` via `location.replace`.
- New: Path B (401 + failed refresh + no newer sibling token) now triggers the
  redirect and sets `sessionExpiredReason`.
- New: idempotency — two concurrent expiries redirect exactly once.
- New: no redirect attempt when already on `/login`.
- New: `login()` resets the flag and clears `sessionExpiredReason`.

Note: `jsdom` doesn't allow assigning `window.location`; follow the existing
mocking pattern already used by the `returnTo` test in this file.

## Task 2 — Expiry mask in AuthOverlay + login-page notices + i18n keys

**Files:** `apps/web/src/components/auth/AuthOverlay.tsx`,
`apps/web/src/components/auth/LoginPage.tsx` (or `login.astro` if the reason
must be read server-side — prefer client-side `window.location.search` like the
existing SSO `?error=` handling), locale files, colocated tests.

**AuthOverlay:** subscribe to `sessionExpiredReason`. When it is non-null,
render a full-screen overlay (same visual pattern as the existing
"initializing" overlay: `fixed inset-0 z-50 … bg-background`, spinner) with the
text "Your session has expired — redirecting to sign in…" (i18n), EVEN IF
`fadeState === 'hidden'` — i.e. the `sessionExpiredReason` branch is checked
before the `fadeState === 'hidden'` early return. This masks the gutted
sidebar during the `window.location.replace` window. Do not disturb the
existing mount/fade lifecycle otherwise; the safety-net timer and CF-Access
bootstrap must keep working. Note `handleSessionExpired` fires
`window.location.replace` itself — the overlay is purely cosmetic masking, it
must NOT navigate (the existing `!isAuthenticated → redirectToLogin()` effect
will also fire; that's harmless/redundant but must not fight the reason param:
leave that effect as-is, `location.replace` wins).

**LoginPage:** read `reason` from `window.location.search` (mirror the
`?error=` pattern). Map to an informational notice (not error-styled — check
how `login.notices.registrationDisabled` renders and reuse that presentation):
- `session-expired` → "Your session expired. Please sign in again to continue."
- `idle` → "You were signed out due to inactivity."
Unknown values render nothing. The notice must not interfere with the existing
`?error=` SSO copy (if both present, error wins).

**i18n:** add the three new keys (overlay message + two notices) to ALL seven
locales with reasonable translations.

**Tests:** overlay renders mask when `sessionExpiredReason` set even after
fade-out; LoginPage shows each notice for its reason and nothing for unknown;
error-param precedence.

## Task 3 — Keepalive detects a dead session proactively

**Files:** `apps/web/src/stores/auth.ts`,
`apps/web/src/components/auth/AdminSessionManager.tsx`, colocated tests.

Surface the hard-vs-transient distinction that `refreshFetchOnce` already
computes. Suggested shape (implementer may adjust names, not semantics): add

```ts
export async function restoreAccessTokenFromCookieDetailed(): Promise<'restored' | 'auth-failed' | 'transient'>
```

- `'restored'` — tokens minted and stored (same as current `true`).
- `'auth-failed'` — the refresh endpoint reached a verdict and the session is
  unrecoverable (the `!transient && !raced` hard-failure path, including the
  raced-retry landing on a hard failure).
- `'transient'` — network/5xx path exhausted retries; NO verdict on the cookie.

This requires `requestTokenRefresh`/`requestTokenRefreshShared` to propagate an
outcome instead of bare `Tokens | null` — keep the existing public
`restoreAccessTokenFromCookie(): Promise<boolean>` as a thin wrapper
(`=== 'restored'`) so `AuthOverlay`/`bootstrapFromCfAccessRedirect`/
`fetchWithAuth` call sites are untouched. Do NOT alter retry counts, backoff,
the Web Locks serialization, or the raced-retry semantics.

**AdminSessionManager heartbeat:** the 5-minute keepalive switches to the
detailed variant:
- `'restored'` → stamp `lastRefreshAtRef` (as today).
- `'auth-failed'` → call `handleSessionExpired('session-expired')` and stop
  (set `idleLogoutInFlightRef.current = true` so the heartbeat stands down).
- `'transient'` → do nothing (do NOT stamp `lastRefreshAtRef`, so the next
  heartbeat retries; a user offline on a plane must NOT be logged out).

**Tests:** unit-test the detailed restore outcomes (mock fetch: 200, hard 401,
5xx-exhausted) and the three heartbeat reactions (fake timers; assert
`handleSessionExpired` fires only for `'auth-failed'`).

## Task 4 — Idle-timeout warning modal

**Files:** `apps/web/src/components/auth/AdminSessionManager.tsx` (+ a new
sibling component if cleaner, e.g. `IdleWarningDialog.tsx`), locale files,
colocated tests.

Behavior:
- Warning lead time: `IDLE_WARNING_LEAD_MS = 2 * 60_000`, but never more than
  half the effective idle budget: `lead = Math.min(2min, idleTimeoutMs / 2)`.
- The existing 30 s heartbeat decides state: when
  `idleMs >= idleTimeoutMs - lead` and the user is not yet logged out, show the
  modal with a **live countdown** (1 s tick while visible) of time remaining
  until `idleTimeoutMs`.
- While the modal is visible, **passive** activity (`mousemove`, `scroll`,
  `focus`, `visibilitychange`) must NOT extend the session or dismiss the
  modal. Deliberate interaction — `mousedown`, `keydown`, `touchstart`, or the
  modal's "Stay signed in" button (`data-testid="idle-warning-stay"`) —
  dismisses the modal, marks activity, and immediately calls the keepalive
  refresh (so the token is fresh again). Implementation hint: track
  "warning visible" in a ref the global `markActivity` handler consults; split
  the event list into passive vs deliberate.
- If the countdown reaches zero: keep the existing durable logout
  (`apiLogout()` — it revokes the refresh-token family server-side) but replace
  the bare `navigateTo('/login')` with
  `handleSessionExpired('idle')` AFTER `apiLogout()` resolves. (Order matters:
  `apiLogout` needs the Bearer/localStorage state that `logout()` clears.)
  The modal switches to a brief "Signing you out…" state during this.
- Modal styling: follow an existing in-repo overlay dialog (e.g. the confirm
  dialog in `apps/web/src/components/settings/EnrollmentKeyManager.tsx`) —
  `fixed inset-0 z-50` backdrop + centered card; `role="dialog"`,
  `aria-modal="true"`, `aria-labelledby`. There is no shared Dialog primitive;
  do not create one for this task.
- Copy (i18n, `auth` namespace, ALL seven locales): title
  "Are you still there?", body "You'll be signed out in {{countdown}} due to
  inactivity.", button "Stay signed in", plus the "Signing you out…" state.
  Countdown formatted m:ss.
- `AdminSessionManager` currently returns `null`; it now returns the modal
  when warning state is active. It stays mounted with
  `transition:persist` — verify the modal survives an Astro client-side
  navigation without duplicating listeners.

**Tests** (fake timers): modal appears at `idleTimeoutMs - lead`; passive
mousemove while visible does not dismiss; "Stay signed in" dismisses, marks
activity, and triggers a refresh; countdown expiry calls `apiLogout` then
`handleSessionExpired('idle')`; no modal when the user stays active.

## Verification (final)

- `pnpm --filter @breeze/web test` (full web suite, includes i18n key parity
  and no-silent-mutations contract tests).
- Typecheck via the web build path used in CI (`pnpm --filter @breeze/web build`
  or `astro check` if that's what CI runs — match CI).

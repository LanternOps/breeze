# Bootstrap Signup Flow — Trimmed Plan

**Date:** 2026-04-28
**Branch target:** `main`
**Scope:** Stop the OAuth-no-session dead-end. When Claude.ai (or any OAuth client) redirects an unauthenticated browser to `/oauth/consent`, that browser should land on a page where the user can either sign in or create an account, then return to consent.

**Out of scope (deferred to separate PRs):**
- Email verification (`email_verified_at` column, verify/resend routes, welcome email, banner)
- Forgot-password gate on verification status
- `/login` deprecation/rename

---

## What's Actually Broken

Today: Claude.ai → `/oauth/auth` → oidc-provider redirects to `/oauth/consent?uid=…`. `ConsentForm` calls `GET /api/v1/interaction/:uid`, gets 401, surfaces an error. There is no path forward for a user without an account.

This plan adds two things and fixes one bug:
1. A SaaS-mode self-service signup path (existing `register-partner` is gated on a setup-admin row that doesn't exist in SaaS).
2. A unified `/auth?next=` page (sign in + create account tabs) that the OAuth flow lands on.
3. ConsentForm: on 401, redirect to `/auth?next=<currentUrl>` instead of dead-ending.

Email verification, forgot-password tightening, and the `/login` rename are real concerns but unrelated to the dead-end. They go in a follow-up.

---

## Reference Anchors

| Symbol | Location |
|---|---|
| `POST /register-partner` handler | `apps/api/src/routes/auth/register.ts:78` |
| Setup-admin gate | `apps/api/src/routes/auth/register.ts:91-100` |
| `registerPartnerSchema` | `apps/api/src/routes/auth/schemas.ts:30` |
| `runWithSystemDbAccess` | `apps/api/src/routes/auth/helpers.ts:29` |
| `setRefreshTokenCookie` | `apps/api/src/routes/auth/helpers.ts:120` |
| `LoginPage.tsx` | `apps/web/src/components/auth/LoginPage.tsx` |
| `LoginForm.tsx` | `apps/web/src/components/auth/LoginForm.tsx` |
| `PartnerRegisterForm.tsx` | `apps/web/src/components/auth/PartnerRegisterForm.tsx` |
| `PartnerRegisterPage.tsx` | `apps/web/src/components/auth/PartnerRegisterPage.tsx` |
| `register-partner.astro` | `apps/web/src/pages/register-partner.astro` |
| `login.astro` | `apps/web/src/pages/login.astro` |
| `ConsentForm.tsx` | `apps/web/src/components/oauth/ConsentForm.tsx` |
| `navigateTo` | `apps/web/src/lib/navigation.ts:5` |
| `useAuthStore` | `apps/web/src/stores/auth.ts` |

---

## Architecture Decisions

**Reuse `register-partner`, don't fork a new `/signup` route.** The existing endpoint already does everything the OAuth flow needs (createPartner, token pair, refresh cookie, dispatchHook, audit). The only blocker is the setup-admin gate at `register.ts:91-100`, which exists for self-hosted bootstrap. In SaaS mode the partner-table-empty bootstrap problem doesn't apply. Drop the gate when `BREEZE_DEPLOYMENT_MODE === 'saas'` (or whatever the existing SaaS flag is — see how `mcpBootstrap` decides; reuse the same flag).

Forking a parallel `/signup` route would duplicate ~120 lines including the load-bearing `dispatchHook` status-update block. The duplication risk is real — billing hooks would silently miss one of the two paths.

**Unified `/auth?next=` page with tabs, not separate pages.** A single OAuth landing target is simpler than wiring `/login?next=…` and `/register-partner?next=…` separately and asking the user to navigate between them. The tabs UI is small (~30 lines) and reuses existing `LoginForm` and `PartnerRegisterForm`.

**OAuth-side fix is in `ConsentForm`, not `provider.ts`.** The cleanest place to detect "no session" is the React component that already calls the interaction API and gets the 401. No need to touch oidc-provider config.

**Don't rename `/login` to `/auth`.** Leave `/login` and `/register-partner` exactly as they are — they remain the canonical pages for direct navigation. `/auth` is the new OAuth-flow landing target only. This avoids the bookmark/redirect/CI-script audit. If we later want to consolidate, do it then.

**`next` param is a relative path only.** Reject anything that doesn't start with `/` (or a single specific allowlisted host) before navigating. Open redirect via `next=https://evil.example.com` is the obvious risk.

---

## File-by-File Change Spec

### Phase 1 — API: Drop setup-admin gate in SaaS mode

#### 1A. Modify: `apps/api/src/routes/auth/register.ts:91-100`

Wrap the setup-admin check in a SaaS-mode skip. Use whichever flag the codebase already uses (check `apps/api/src/modules/mcpBootstrap/` for the canonical SaaS feature flag — reuse the same one).

```ts
// Existing:
const [setupAdmin] = await db
  .select({ setupCompletedAt: users.setupCompletedAt })
  .from(users)
  .innerJoin(partnerUsers, eq(partnerUsers.userId, users.id))
  .where(sql`${users.setupCompletedAt} IS NOT NULL`)
  .limit(1);

if (!setupAdmin) {
  return c.json({ error: 'System setup is not yet complete. Contact your administrator.' }, 403);
}

// Becomes:
if (!IS_SAAS_MODE) {
  const [setupAdmin] = await db
    .select({ setupCompletedAt: users.setupCompletedAt })
    .from(users)
    .innerJoin(partnerUsers, eq(partnerUsers.userId, users.id))
    .where(sql`${users.setupCompletedAt} IS NOT NULL`)
    .limit(1);

  if (!setupAdmin) {
    return c.json({ error: 'System setup is not yet complete. Contact your administrator.' }, 403);
  }
}
```

That's the only API change. `acceptTerms` requirement stays — the new SignupForm just submits `acceptTerms: true` (the checkbox is shown to the user).

#### 1B. Test: `apps/api/src/routes/auth/register.test.ts`

Add one case: `register-partner in SaaS mode skips setup-admin gate, succeeds without any prior partner`. If `register.test.ts` doesn't exist, add it now with this single case.

---

### Phase 2 — Web: `next`-aware navigation hook

#### 2A. New file: `apps/web/src/lib/authNext.ts`

Tiny helper that validates and returns the safe `next` target:

```ts
export function getSafeNext(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  // Only allow relative paths (single leading slash, not //)
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  return raw;
}
```

This is the only safety check that matters here. Tested in `authNext.test.ts` with: empty, `/foo`, `//evil.com`, `https://evil.com`, `/oauth/consent?uid=abc`.

---

### Phase 3 — Web: `/auth` landing page

#### 3A. New file: `apps/web/src/pages/auth.astro`

```astro
---
import AuthLayout from '../layouts/AuthLayout.astro';
import AuthPage from '../components/auth/AuthPage';

const next = Astro.url.searchParams.get('next') ?? undefined;
---

<AuthLayout title="Sign in or create account">
  <AuthPage client:load next={next} />
</AuthLayout>
```

#### 3B. New file: `apps/web/src/components/auth/AuthPage.tsx`

Thin tab wrapper around the **existing** `LoginForm` and `PartnerRegisterForm`. No new form fields, no new validation, no new submit logic — just a tab switcher and a `next` prop forwarded to whichever child handles success.

```tsx
import { useState, useEffect } from 'react';
import LoginForm from './LoginForm';
import PartnerRegisterForm from './PartnerRegisterForm';
import { getSafeNext } from '../../lib/authNext';

interface AuthPageProps {
  next?: string;
}

function getInitialTab(): 'signin' | 'signup' {
  if (typeof window === 'undefined') return 'signin';
  return window.location.hash === '#signup' ? 'signup' : 'signin';
}

export default function AuthPage({ next }: AuthPageProps) {
  const [tab, setTab] = useState<'signin' | 'signup'>(getInitialTab);
  const safeNext = getSafeNext(next);

  useEffect(() => {
    const onHashChange = () => {
      setTab(window.location.hash === '#signup' ? 'signup' : 'signin');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleTabChange = (newTab: 'signin' | 'signup') => {
    window.location.hash = newTab;
    setTab(newTab);
  };

  return (
    <div data-testid="auth-page">
      <div className="mb-6 flex rounded-lg border bg-muted/40 p-1" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'signin'}
          data-testid="tab-signin"
          onClick={() => handleTabChange('signin')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'signin' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'signup'}
          data-testid="tab-signup"
          onClick={() => handleTabChange('signup')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'signup' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Create account
        </button>
      </div>

      {tab === 'signin' ? (
        <LoginForm next={safeNext} />
      ) : (
        <PartnerRegisterForm next={safeNext} />
      )}
    </div>
  );
}
```

#### 3C. Modify: `apps/web/src/components/auth/LoginForm.tsx`

Add an optional `next` prop. On successful login, navigate to `next` if provided, otherwise keep existing behavior.

Find the success branch (the place that calls `navigateTo('/')` or `navigateTo('/setup')`). Change:

```ts
await navigateTo(result.requiresSetup ? '/setup' : '/');
```

to:

```ts
const target = result.requiresSetup ? '/setup' : (next ?? '/');
await navigateTo(target);
```

If `next` itself is `/setup` and `requiresSetup` is true, the user still goes to `/setup` first — by design (setup must complete before any deeper navigation makes sense). That's fine; after setup completes, the post-setup flow already lands on `/`. The OAuth `next` is lost in the setup-required case, which is rare for fresh signups anyway.

The MFA verify branch needs the same treatment if it also calls `navigateTo`. Apply the same `next ?? '/'` pattern.

Backward compat: existing callers (`LoginPage` → `LoginForm`) don't pass `next`, so behavior is unchanged.

#### 3D. Modify: `apps/web/src/components/auth/PartnerRegisterForm.tsx`

Same pattern: add optional `next` prop, use it on success in place of the current default redirect target. If success currently calls `navigateTo('/')`, change to `navigateTo(next ?? '/')`.

---

### Phase 4 — Web: ConsentForm 401 redirect

#### 4A. Modify: `apps/web/src/components/oauth/ConsentForm.tsx`

Find the fetch that loads the interaction (`GET /api/v1/interaction/:uid`). On 401, redirect:

```tsx
if (res.status === 401) {
  const target = window.location.pathname + window.location.search;
  window.location.href = `/auth?next=${encodeURIComponent(target)}`;
  return;
}
```

Insert before any error-state setter. After redirect, the browser is on `/auth?next=/oauth/consent?uid=…`. After login or signup, `LoginForm`/`PartnerRegisterForm` calls `navigateTo(next)` and returns the user to consent.

---

### Phase 5 — Tests

#### 5A. New file: `apps/web/src/lib/authNext.test.ts`

Single file, ~5 cases for `getSafeNext`: null, `/foo`, `//evil.com`, `https://evil.com`, `/oauth/consent?uid=abc`.

#### 5B. New file: `apps/web/src/components/auth/AuthPage.test.tsx`

Three cases:
1. Renders Sign in tab by default.
2. Clicking "Create account" sets `window.location.hash = '#signup'` and renders signup form.
3. `window.location.hash = '#signup'` on mount → signup tab active.

Don't test the form submission paths — they're covered by existing `LoginForm` / `PartnerRegisterForm` tests.

#### 5C. Modify: `apps/api/src/routes/auth/register.test.ts`

Add one case: `register-partner in SaaS mode succeeds with no setup admin present`. Mock `IS_SAAS_MODE = true`, mock DB to return empty setup-admin row, assert 200 + token returned.

#### 5D. Manual smoke (in build sequence)

- `/auth` renders both tabs.
- Create account on `/auth?next=/devices` → after signup, lands on `/devices`.
- Sign in on `/auth?next=/oauth/consent?uid=abc` → lands on `/oauth/consent?uid=abc`.
- `/auth?next=https://evil.com` → after success, lands on `/` (open-redirect blocked).
- Initiate OAuth from Claude.ai with no Breeze session → browser ends on `/auth`, sign up, completes consent, token issued.

---

## Build Sequence

1. Identify the SaaS flag the codebase already uses (grep `mcpBootstrap` module). Use it in `register.ts` setup-admin gate. Run `pnpm test --filter=@breeze/api`.
2. Add `register.test.ts` SaaS case. Green.
3. Create `apps/web/src/lib/authNext.ts` + `.test.ts`. Run `pnpm test --filter=@breeze/web`.
4. Add `next` prop to `LoginForm.tsx` (success branch + MFA branch). Type-check.
5. Add `next` prop to `PartnerRegisterForm.tsx` (success branch). Type-check.
6. Create `AuthPage.tsx` + `auth.astro`. Type-check.
7. Modify `ConsentForm.tsx` — 401 → redirect to `/auth?next=…`.
8. Create `AuthPage.test.tsx`. Green.
9. Full test suite: `pnpm test`.
10. Manual smokes (5D above) including the Claude.ai end-to-end.

---

## Files to Create or Modify

| Action | File |
|---|---|
| MODIFY | `apps/api/src/routes/auth/register.ts` — wrap setup-admin gate in SaaS-mode skip |
| MODIFY | `apps/api/src/routes/auth/register.test.ts` — add SaaS-mode case (create file if missing) |
| CREATE | `apps/web/src/lib/authNext.ts` |
| CREATE | `apps/web/src/lib/authNext.test.ts` |
| MODIFY | `apps/web/src/components/auth/LoginForm.tsx` — accept `next` prop |
| MODIFY | `apps/web/src/components/auth/PartnerRegisterForm.tsx` — accept `next` prop |
| CREATE | `apps/web/src/components/auth/AuthPage.tsx` |
| CREATE | `apps/web/src/components/auth/AuthPage.test.tsx` |
| CREATE | `apps/web/src/pages/auth.astro` |
| MODIFY | `apps/web/src/components/oauth/ConsentForm.tsx` — 401 → `/auth?next=` |

**Total: 5 new files, 4 modified files. No DB migration. No new email templates. No new API routes.**

---

## What's Deferred (and Why)

- **Email verification.** The MCP bootstrap flow doesn't need it to work end-to-end. Verification is a real product feature (trust signal for billing, anti-abuse) but should be designed alongside Resend bounce-feedback (already noted in memory as the critical anti-abuse piece). Ship it as its own PR with a real spec.
- **Forgot-password gate on `email_verified_at`.** Tied to the above — can't gate on a column that doesn't exist yet.
- **`/login` rename.** No URL rename should ride along with a UX-fix PR. If `/auth` proves out, propose the rename in a follow-up after auditing CI scripts, agent-emitted URLs, and external docs.
- **Welcome email.** Same as verification — ship together when the verification flow lands.
- **Verification banner.** Same.

---

## Risks

- **SaaS-mode flag misuse.** If the flag isn't actually wired in production, `register-partner` will still 403. Mitigation: in step 1, confirm the flag is read at runtime and the value in production env is what we expect. If unclear, add a `console.log` of the flag value at module init temporarily.
- **`PartnerRegisterForm` redirect target after dispatchHook.** `register-partner` may return a `redirectUrl` from a billing hook; today the form likely uses it. The `next ?? '/'` fallback should preserve that — verify by reading `PartnerRegisterForm.tsx` before the change. If the hook redirect is meant to override `next` (e.g. billing onboarding must come first), keep the hook target as the priority; `next` is the post-billing destination, not a bypass.
- **OAuth interaction expiry.** `/oauth/consent?uid=…` carries an interaction UID with a TTL (oidc-provider default ~1 hour). If a user signs up and then idles past that, the redirect back to consent will 404. The existing ConsentForm presumably already handles that error state — no new work, just don't claim the flow is robust against arbitrary signup latency.

# Bootstrap Signup Flow — Implementation Plan

**Date:** 2026-04-28
**Branch target:** `main`
**Scope:** MCP bootstrap UX — `/auth?next=` unified login/signup page, email verification, OAuth redirect wiring

---

## Locked Design Decisions

1. `/auth?next=…` page with login/signup tabs. Single URL. Default tab = Sign in. Tab state in `window.location.hash` (`#signin` / `#signup`). Replaces `/login` as the OAuth interaction redirect destination.
2. Email verification is V1-deferred from being a hard gate. Send verification email at signup; auto-login immediately. Only `forgot-password` is gated on `email_verified_at IS NOT NULL`. No other gates in this PR.
3. Welcome email contains the verify-email link. One email at signup. Subject: "Welcome to Breeze — please verify your email".

---

## Reference Anchors

All paths are absolute. Line numbers are the current codebase state.

| Symbol | Location |
|---|---|
| `createPartner()` | `/Users/toddhebebrand/breeze/apps/api/src/services/partnerCreate.ts:39` |
| `registerPartnerSchema` | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/schemas.ts:30` |
| `POST /register-partner` handler | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/register.ts:78` |
| `runWithSystemDbAccess` wrapper | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:29` |
| `withSystemDbAccessContext` (tonight's pattern) | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/password.ts:122-137` |
| `setRefreshTokenCookie` | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:120` |
| `toPublicTokens` | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:246` |
| `resolveCurrentUserTokenContext` | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:359` |
| `writeAuthAudit` | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:459` |
| `getClientRateLimitKey` | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:42` |
| `forgotPasswordLimiter` | `/Users/toddhebebrand/breeze/apps/api/src/services/rate-limit.ts:82` |
| `getEmailService()` | `/Users/toddhebebrand/breeze/apps/api/src/services/email.ts:210` |
| `forgotPassword` — no-send pattern | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/password.ts:33-95` |
| `reset-password` token/Redis pattern | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/password.ts:98-160` |
| Auth route index (mount point) | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/index.ts` |
| `authRoutes` mounted in API | `/Users/toddhebebrand/breeze/apps/api/src/index.ts:15` |
| OAuth `interactions.url` | `/Users/toddhebebrand/breeze/apps/api/src/oauth/provider.ts:372-375` |
| `users` Drizzle schema | `/Users/toddhebebrand/breeze/apps/api/src/db/schema/users.ts:9` |
| `useAuthStore.login` | `/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:64` |
| `LoginPage.tsx` | `/Users/toddhebebrand/breeze/apps/web/src/components/auth/LoginPage.tsx` |
| `LoginForm.tsx` | `/Users/toddhebebrand/breeze/apps/web/src/components/auth/LoginForm.tsx` |
| `login.astro` | `/Users/toddhebebrand/breeze/apps/web/src/pages/login.astro` |
| `AuthLayout.astro` | `/Users/toddhebebrand/breeze/apps/web/src/layouts/AuthLayout.astro` |
| `navigateTo` | `/Users/toddhebebrand/breeze/apps/web/src/lib/navigation.ts:5` |
| `fetchAndApplyPreferences` | `/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts` (imported in LoginPage) |
| MCP bootstrap integration test | `/Users/toddhebebrand/breeze/apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts` |
| `nanoid` / `createHash` pattern | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/password.ts:18-19,67-68` |
| `dispatchHook` | `/Users/toddhebebrand/breeze/apps/api/src/services/partnerHooks.ts` |
| `ENABLE_REGISTRATION` (API) | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/schemas.ts:8` |
| `ENABLE_REGISTRATION` (web) | `/Users/toddhebebrand/breeze/apps/web/src/lib/featureFlags.ts:18` |
| `registrationDisabledResponse` | `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/helpers.ts:321` |

---

## Migration Check

`emailVerifiedAt` does NOT exist on the `users` table. Confirmed by reading `/Users/toddhebebrand/breeze/apps/api/src/db/schema/users.ts` — the column set ends with `updatedAt` at line 34. A migration is required.

### Migration spec

**File:** `apps/api/migrations/2026-04-28-users-email-verified-at.sql`

```sql
-- Add email_verified_at to users (nullable, pre-existing rows stay NULL).
-- Idempotent: ADD COLUMN IF NOT EXISTS.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;
```

No index needed — the only query on this column is a single-row SELECT by `users.id` (in forgot-password and verify-email routes); an index would not be used.

**Drizzle schema change** (same PR): add to `users` table definition in `/Users/toddhebebrand/breeze/apps/api/src/db/schema/users.ts` after `setupCompletedAt`:

```ts
emailVerifiedAt: timestamp('email_verified_at'),
```

Run `pnpm db:check-drift` after applying.

---

## Architecture Decision

**Rate-limiting for signup:** 3 attempts per hour per client key (same as `register-partner`). Signup is a resource-creation endpoint with email side-effects; 3/hr is tight enough to prevent abuse without blocking legitimate retries.

**Email send timing:** Synchronous within the `/signup` request. The email library (`getEmailService()`) already swallows send errors with a try/catch — the pattern in `forgot-password` (line 75-84) catches and logs, never fails the response. Adopt the identical pattern: if `emailService` is null (unconfigured) or throws, log a warning and continue. Signup succeeds regardless. Async fire-and-forget via BullMQ would be more resilient but adds queue dependency + job schema; not worth the complexity for a new auth flow. Revisit if Resend SLA becomes a concern.

**Verification token TTL:** 24 hours. Matches the spirit of the reset-password token (1 hour is too aggressive for a welcome verification; 7 days is too loose for an unverified account sitting open). Redis key: `email_verify:<sha256(token)>`.

**Resend-verification rate limit:** Separate limiter constant `resendVerificationLimiter` at 3/hour per client key — same window as `forgotPasswordLimiter` but separate key namespace (`resend-verify:…`) so they don't share the counter.

**Verification banner nag duration:** Show the "Please verify your email" banner for 7 days after signup. After 7 days, suppress silently. Implementation: compare `user.createdAt` against `Date.now() - 7 * 86400 * 1000` in the frontend; no new API field needed.

**`/login` backward compat:** Keep `login.astro`, change it to a static 302 redirect to `/auth`. Astro supports `return Astro.redirect('/auth', 302)`. Do not delete the file — bookmarks, CI smoke tests, and agent-emitted URLs still hit `/login`.

**OAuth `interactions.url`:** Change the single string in `provider.ts:373` from `/oauth/consent?uid=…` to `/auth?next=/oauth/consent?uid=…`. This is the minimal change: when oidc-provider needs login, it redirects to `/auth`, which handles login/signup. After login, `AuthPage` reads the `next` param and navigates there.

Wait — actually the current config at line 372-375 sets:
```ts
interactions: {
  url: (_ctx, interaction) =>
    `${OAUTH_CONSENT_URL_BASE}/oauth/consent?uid=${interaction.uid}`,
},
```
The consent page is a separate page from the login page. The `interactions.url` is where oidc-provider redirects when it needs user interaction (login _or_ consent). In the current flow, oidc-provider goes directly to the consent page. The consent page (`/oauth/consent`) contains `ConsentForm` which uses `authMiddleware` — a user without a session gets a 401 from the API and the consent UI breaks, rather than gracefully redirecting to login.

The correct fix is: `/oauth/consent` should detect no-session state and redirect to `/auth?next=/oauth/consent?uid=<uid>`. This is a frontend concern (the ConsentForm already gets a 401 from `GET /api/v1/interaction/:uid`). Alternatively, add a Astro server-side check in `consent.astro` to redirect unauthenticated users to `/auth?next=...`.

The simpler fix: In `consent.astro`, add Astro server-side cookie check. Since Breeze's auth cookie is HttpOnly, the Astro SSR layer cannot read it. The correct approach is to have `ConsentForm` detect a 401 from `GET /api/v1/interaction/:uid` and redirect to `/auth?next=<currentUrl>`.

**Decision:** Do not change `interactions.url` in `provider.ts`. Instead, handle the unauthenticated case in `ConsentForm.tsx`: when the interaction GET returns 401, set `window.location.href = '/auth?next=' + encodeURIComponent(window.location.pathname + window.location.search)`.

This requires a minimal change to `apps/web/src/components/oauth/ConsentForm.tsx` — one redirect on 401.

---

## File-by-File Change Spec

### Phase 1 — DB + Schema (prerequisite, no app changes yet)

#### 1A. New file: `apps/api/migrations/2026-04-28-users-email-verified-at.sql`

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;
```

No `BEGIN`/`COMMIT`. Idempotent. Filename sorts correctly after any existing 2026-04-27 migrations.

#### 1B. Modify: `apps/api/src/db/schema/users.ts`

After line 31 (`setupCompletedAt: timestamp('setup_completed_at'),`), insert:

```ts
emailVerifiedAt: timestamp('email_verified_at'),
```

RLS note: `emailVerifiedAt` is a user-scoped attribute on the `users` table. No new RLS policy needed — the existing `users` policy covers it. The column is not a tenancy axis.

---

### Phase 2 — API: Verification token helpers in schemas + rate-limit

#### 2A. Modify: `apps/api/src/routes/auth/schemas.ts`

Add two new Zod schemas and one new Redis key constant (append to end of file):

```ts
export const signupSchema = z.object({
  companyName: z.string().min(2).max(255),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(255),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

export const resendVerificationSchema = z.object({
  // body is intentionally empty — caller is already authenticated
});

export const EMAIL_VERIFY_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours
```

#### 2B. Modify: `apps/api/src/services/rate-limit.ts`

Append after `phoneConfirmLimiter` at line 112:

```ts
export const signupLimiter: RateLimitConfig = {
  limit: 3,
  windowSeconds: 60 * 60,
};

export const resendVerificationLimiter: RateLimitConfig = {
  limit: 3,
  windowSeconds: 60 * 60,
};
```

---

### Phase 3 — API: Email template `welcomeWithVerification`

#### 3A. Modify: `apps/api/src/services/email.ts`

Add interface (after `InviteEmailParams` interface at line 33):

```ts
export interface WelcomeWithVerificationEmailParams {
  to: string | string[];
  name?: string;
  verifyUrl: string;
  supportEmail?: string;
}
```

Add method to `EmailService` class (after `sendAlertNotification` at line 199):

```ts
async sendWelcomeWithVerification(params: WelcomeWithVerificationEmailParams): Promise<void> {
  const template = buildWelcomeWithVerificationTemplate(params);
  await this.sendEmail({
    to: params.to,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });
}
```

Add template builder function (append at end of file, before `alertSeverityPalette`):

```ts
function buildWelcomeWithVerificationTemplate(params: WelcomeWithVerificationEmailParams): EmailTemplate {
  const name = params.name?.trim() || 'there';
  const subject = 'Welcome to Breeze — please verify your email';
  const preheader = 'Verify your email to finish setting up your Breeze account.';
  const body = `
      <p style="${BODY_PARA}">Hi ${escapeHtml(name)},</p>
      <p style="${BODY_PARA}">Welcome to Breeze! You're all set — your account is ready and you can start managing your endpoints right away.</p>
      <p style="${BODY_PARA}">One last thing: please verify your email address to keep your account secure.</p>
      ${renderButton('Verify email address', params.verifyUrl)}
      <p style="${MUTED_PARA}">This link expires in 24 hours. If you didn't create a Breeze account, you can safely ignore this email.</p>
  `;
  const html = renderLayout({
    title: subject,
    preheader,
    heading: 'Welcome to Breeze',
    body,
    footer: supportFooter(params.supportEmail, 'Questions? Contact'),
  });

  const support = getSupportEmail(params.supportEmail);
  const text = [
    `Hi ${name},`,
    'Welcome to Breeze! Your account is ready.',
    'Please verify your email address to keep your account secure.',
    `Verify your email: ${params.verifyUrl}`,
    'This link expires in 24 hours.',
    support ? `Questions? Contact ${support}.` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}
```

---

### Phase 4 — API: `POST /auth/signup` route

#### 4A. New file: `apps/api/src/routes/auth/signup.ts`

Full structure (skeleton — implementer fills the bodies, following the pattern in `register.ts:78-255`):

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import * as dbModule from '../../db';
import { users, partners } from '../../db/schema';
import {
  hashPassword,
  isPasswordStrong,
  createTokenPair,
  rateLimiter,
  signupLimiter,
  getRedis,
} from '../../services';
import { getEmailService } from '../../services/email';
import { ENABLE_REGISTRATION, signupSchema, EMAIL_VERIFY_TOKEN_TTL_SECONDS } from './schemas';
import { dispatchHook } from '../../services/partnerHooks';
import { createPartner } from '../../services/partnerCreate';
import {
  runWithSystemDbAccess,
  getClientRateLimitKey,
  setRefreshTokenCookie,
  toPublicTokens,
  resolveCurrentUserTokenContext,  // not used here, but available
  writeAuthAudit,
  registrationDisabledResponse,
} from './helpers';
import { ENABLE_2FA } from './schemas';

const { db, withSystemDbAccessContext } = dbModule;

export const signupRoutes = new Hono();

signupRoutes.post('/signup', zValidator('json', signupSchema), async (c) => {
  if (!ENABLE_REGISTRATION) {
    return registrationDisabledResponse(c);
  }

  const { companyName, email, password, name } = c.req.valid('json');
  const rateLimitClient = getClientRateLimitKey(c);
  const normalizedEmail = email.toLowerCase();

  // 1. Redis availability check
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // 2. Rate limit — more aggressive than register-partner, no setup gate
  const rateCheck = await rateLimiter(redis, `signup:${rateLimitClient}`, signupLimiter.limit, signupLimiter.windowSeconds);
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many registration attempts. Try again later.' }, 429);
  }

  // 3. Password strength
  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  // 4. Dup-email check (pre-auth — system scope)
  return runWithSystemDbAccess(async () => {
    const existingUser = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (existingUser.length > 0) {
      // Anti-enumeration: return success shape, but no actual registration
      return c.json({ success: true, message: 'If registration can proceed, you will receive next steps shortly.' });
    }

    // 5. Hash password before transaction (CPU-bound, don't hold tx open)
    const passwordHash = await hashPassword(password);

    try {
      // 6. Atomic partner + user + org + site creation (identical to register-partner)
      //    NOTE: no setup-admin gate here — this is public self-service
      const result = await createPartner({
        orgName: companyName,
        adminEmail: normalizedEmail,
        adminName: name,
        passwordHash,
        origin: { mcp: false },
      });

      // 7. Fetch created rows (same pattern as register.ts:146-168)
      const [newPartner] = await db
        .select({ id: partners.id, name: partners.name, slug: partners.slug, plan: partners.plan, status: partners.status })
        .from(partners)
        .where(eq(partners.id, result.partnerId))
        .limit(1);

      const [newUser] = await db
        .select({ id: users.id, email: users.email, name: users.name, mfaEnabled: users.mfaEnabled })
        .from(users)
        .where(eq(users.id, result.adminUserId))
        .limit(1);

      if (!newPartner || !newUser) {
        throw new Error('Partner or user row missing after createPartner');
      }

      // 8. Issue tokens (same pattern as register.ts:176-185)
      const mfaSatisfied = !(ENABLE_2FA && newUser.mfaEnabled);
      const tokens = await createTokenPair({
        sub: newUser.id,
        email: newUser.email,
        roleId: result.adminRoleId,
        orgId: result.orgId,
        partnerId: newPartner.id,
        scope: 'partner',
        mfa: mfaSatisfied,
      });

      setRefreshTokenCookie(c, tokens.refreshToken);

      // 9. dispatchHook (same as register.ts:190-228 — supports billing hooks)
      const hookResponse = await dispatchHook('registration', newPartner.id, {
        email: newUser.email,
        partnerName: newPartner.name,
        plan: newPartner.plan,
      });
      // ... (copy hook status-update block verbatim from register.ts:196-228)

      // 10. Mint email verification token and send welcome email (SYNCHRONOUS)
      const verifyToken = nanoid(48);
      const verifyTokenHash = createHash('sha256').update(verifyToken).digest('hex');
      await redis.setex(`email_verify:${verifyTokenHash}`, EMAIL_VERIFY_TOKEN_TTL_SECONDS, newUser.id);

      const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
      const verifyUrl = `${appBaseUrl}/verify-email?token=${encodeURIComponent(verifyToken)}`;

      const emailService = getEmailService();
      if (emailService) {
        try {
          await emailService.sendWelcomeWithVerification({
            to: newUser.email,
            name: newUser.name,
            verifyUrl,
          });
        } catch (emailErr) {
          // Non-fatal: user is already auto-logged in. Log and continue.
          console.error('[signup] Failed to send welcome email:', emailErr instanceof Error ? emailErr.message : String(emailErr));
        }
      } else {
        console.warn('[signup] Email service not configured; welcome email was not sent');
      }

      // 11. Audit log
      writeAuthAudit(c, {
        action: 'user.signup',
        result: 'success',
        userId: newUser.id,
        email: newUser.email,
        name: newUser.name,
      });

      return c.json({
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          mfaEnabled: false,
        },
        partner: {
          id: newPartner.id,
          name: newPartner.name,
          slug: newPartner.slug,
          status: newPartner.status,
        },
        tokens: toPublicTokens(tokens),
        requiresEmailVerification: true,
      });
    } catch (err) {
      console.error('[signup] Registration error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Registration failed. Please try again.' }, 500);
    }
  });
});
```

---

### Phase 5 — API: `POST /auth/verify-email` and `POST /auth/resend-verification`

#### 5A. New file: `apps/api/src/routes/auth/verifyEmail.ts`

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import { rateLimiter, resendVerificationLimiter, getRedis } from '../../services';
import { authMiddleware } from '../../middleware/auth';
import { getEmailService } from '../../services/email';
import { nanoid } from 'nanoid';
import { verifyEmailSchema, EMAIL_VERIFY_TOKEN_TTL_SECONDS } from './schemas';
import { getClientRateLimitKey, writeAuthAudit } from './helpers';

const { db, withSystemDbAccessContext } = dbModule;

export const verifyEmailRoutes = new Hono();

// POST /verify-email — consume token, flip email_verified_at
// Public (no authMiddleware) — token is the credential
verifyEmailRoutes.post('/verify-email', zValidator('json', verifyEmailSchema), async (c) => {
  const { token } = c.req.valid('json');

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const userId = await redis.get(`email_verify:${tokenHash}`);

  if (!userId) {
    return c.json({ error: 'Invalid or expired verification link' }, 400);
  }

  // Pre-auth UPDATE — must use system scope (same pattern as password.ts:122-137)
  await withSystemDbAccessContext(async () =>
    db
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId))
  );

  // Single-use: delete token
  await redis.del(`email_verify:${tokenHash}`).catch((err: unknown) => {
    console.error('[verify-email] Failed to delete token:', err);
  });

  writeAuthAudit(c, {
    action: 'user.email.verified',
    result: 'success',
    userId,
  });

  return c.json({ success: true, message: 'Email verified successfully' });
});

// POST /resend-verification — requires auth, rate-limited
verifyEmailRoutes.post('/resend-verification', authMiddleware, async (c) => {
  const auth = c.get('auth');
  const rateLimitClient = getClientRateLimitKey(c);

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const rateCheck = await rateLimiter(
    redis,
    `resend-verify:${rateLimitClient}`,
    resendVerificationLimiter.limit,
    resendVerificationLimiter.windowSeconds,
  );
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  }

  // Check if already verified
  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (user.emailVerifiedAt) {
    return c.json({ success: true, message: 'Email is already verified' });
  }

  // Mint new token (overwrites any existing one for this user)
  const verifyToken = nanoid(48);
  const verifyTokenHash = createHash('sha256').update(verifyToken).digest('hex');
  await redis.setex(`email_verify:${verifyTokenHash}`, EMAIL_VERIFY_TOKEN_TTL_SECONDS, user.id);

  const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
  const verifyUrl = `${appBaseUrl}/verify-email?token=${encodeURIComponent(verifyToken)}`;

  const emailService = getEmailService();
  if (emailService) {
    try {
      await emailService.sendWelcomeWithVerification({ to: user.email, name: user.name, verifyUrl });
    } catch (emailErr) {
      console.error('[resend-verification] Email send failed:', emailErr instanceof Error ? emailErr.message : String(emailErr));
    }
  }

  return c.json({ success: true, message: 'Verification email sent' });
});
```

---

### Phase 6 — API: Gate `forgot-password` on `emailVerifiedAt`

#### 6A. Modify: `apps/api/src/routes/auth/password.ts`

Change the section starting at line 64 (`if (user) {`) to also check `emailVerifiedAt`. Read `emailVerifiedAt` from the SELECT:

Change line 57-62 (SELECT fields) from:
```ts
db.select({ id: users.id, email: users.email })
```
to:
```ts
db.select({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt })
```

Then wrap the inner block (currently `if (user) { ... }`) with an additional guard:

```ts
if (user) {
  if (!user.emailVerifiedAt) {
    // Unverified email — silently skip reset to prevent account takeover
    // on accounts that were never fully activated. Anti-enumeration: no
    // different response shape from the not-found branch.
    console.warn('[auth] forgot-password skipped — unverified email for user', user.id);
  } else {
    // existing logic: mint token, set Redis, send email
    const resetToken = nanoid(48);
    // ... (existing code unchanged)
  }
}
```

This is a 4-line change: expand the SELECT to include `emailVerifiedAt`, add an `if (!user.emailVerifiedAt)` guard around the existing email-send block, and add the log line.

---

### Phase 7 — API: Wire routes into auth index

#### 7A. Modify: `apps/api/src/routes/auth/index.ts`

Add two imports and two `.route()` mounts:

```ts
import { signupRoutes } from './signup';
import { verifyEmailRoutes } from './verifyEmail';

// existing mounts...
authRoutes.route('/', signupRoutes);
authRoutes.route('/', verifyEmailRoutes);
```

---

### Phase 8 — Web: `/auth.astro` page

#### 8A. New file: `apps/web/src/pages/auth.astro`

```astro
---
import AuthLayout from '../layouts/AuthLayout.astro';
import AuthPage from '../components/auth/AuthPage';

const next = Astro.url.searchParams.get('next') ?? undefined;
---

<AuthLayout title="Sign in">
  <AuthPage client:load next={next} />
</AuthLayout>
```

The `AuthLayout` is reused from `/Users/toddhebebrand/breeze/apps/web/src/layouts/AuthLayout.astro` — it's the centered single-column layout used by `consent.astro`, perfect for this page. Note: `login.astro` uses the two-column branded layout. The new `/auth` page uses the simpler centered layout. If the full branded layout is preferred, copy the HTML from `login.astro` and replace `<LoginPage client:load />` with `<AuthPage client:load next={next} />`.

---

### Phase 9 — Web: `AuthPage.tsx` component

#### 9A. New file: `apps/web/src/components/auth/AuthPage.tsx`

```tsx
import { useState, useEffect } from 'react';
import LoginPage from './LoginPage';
import SignupForm from './SignupForm';
import { useAuthStore, fetchAndApplyPreferences } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';

interface AuthPageProps {
  next?: string;
}

function getInitialTab(): 'signin' | 'signup' {
  if (typeof window === 'undefined') return 'signin';
  return window.location.hash === '#signup' ? 'signup' : 'signin';
}

export default function AuthPage({ next }: AuthPageProps) {
  const [tab, setTab] = useState<'signin' | 'signup'>(getInitialTab);
  const [verificationBanner, setVerificationBanner] = useState(false);

  const login = useAuthStore((s) => s.login);

  useEffect(() => {
    const onHashChange = () => {
      const newTab = window.location.hash === '#signup' ? 'signup' : 'signin';
      setTab(newTab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleTabChange = (newTab: 'signin' | 'signup') => {
    window.location.hash = newTab;
    setTab(newTab);
  };

  const handleSignupSuccess = (user: any, tokens: any) => {
    login(user, tokens);
    fetchAndApplyPreferences();
    setVerificationBanner(true);
    navigateTo(next ?? '/');
  };

  const handleLoginSuccess = (requiresSetup: boolean) => {
    fetchAndApplyPreferences();
    navigateTo(requiresSetup ? '/setup' : (next ?? '/'));
  };

  return (
    <div data-testid="auth-page">
      {verificationBanner && (
        <div
          data-testid="verification-banner"
          className="mb-6 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-200"
        >
          We sent a verification link to your email. Check your inbox to verify your account.
        </div>
      )}

      <div className="mb-6 flex rounded-lg border bg-muted/40 p-1">
        <button
          type="button"
          data-testid="tab-signin"
          onClick={() => handleTabChange('signin')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'signin'
              ? 'bg-background shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Sign in
        </button>
        <button
          type="button"
          data-testid="tab-signup"
          onClick={() => handleTabChange('signup')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'signup'
              ? 'bg-background shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Create account
        </button>
      </div>

      {tab === 'signin' ? (
        <LoginPage onExternalSuccess={handleLoginSuccess} />
      ) : (
        <SignupForm onSuccess={handleSignupSuccess} />
      )}
    </div>
  );
}
```

Note: `LoginPage` currently navigates itself. To allow `AuthPage` to intercept the navigation (so it can pass `next`), a small refactor of `LoginPage` is needed. Two options:

**Option A (preferred, minimal):** Add an optional `onExternalSuccess` callback prop to `LoginPage`. If provided, call it instead of `navigateTo`. If not provided, use the existing `navigateTo('/')` or `navigateTo('/setup')` behavior. This preserves backward compatibility — `login.astro` continues to work unchanged.

**Option B:** Pass `next` as a prop to `LoginPage` and use it in the `navigateTo` call.

Choose **Option A** because it avoids changing `login.astro` and LoginPage keeps its existing direct-navigation behavior when used standalone.

#### Modify `LoginPage.tsx`: add optional `onExternalSuccess` prop

```tsx
interface LoginPageProps {
  onExternalSuccess?: (requiresSetup: boolean) => void;
}

export default function LoginPage({ onExternalSuccess }: LoginPageProps = {}) {
  // ...existing state...

  const handleLogin = async (values: ...) => {
    // ...existing code...
    if (result.user && result.tokens) {
      login(result.user, result.tokens);
      if (onExternalSuccess) {
        onExternalSuccess(!!result.requiresSetup);
      } else {
        fetchAndApplyPreferences();
        await navigateTo(result.requiresSetup ? '/setup' : '/');
      }
      return;
    }
    // ...
  };

  // MFA verify also needs the onExternalSuccess path:
  const handleMfaVerify = async (code: string) => {
    // ...existing code...
    if (result.user && result.tokens) {
      login(result.user, result.tokens);
      if (onExternalSuccess) {
        onExternalSuccess(!!result.requiresSetup);
      } else {
        fetchAndApplyPreferences();
        await navigateTo(result.requiresSetup ? '/setup' : '/');
      }
      return;
    }
  };
```

---

### Phase 10 — Web: `SignupForm.tsx` component

#### 10A. New file: `apps/web/src/components/auth/SignupForm.tsx`

```tsx
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';

const signupSchema = z.object({
  companyName: z.string().min(2, 'Company name must be at least 2 characters'),
  name: z.string().min(1, 'Your name is required'),
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});
type SignupFormValues = z.infer<typeof signupSchema>;

interface SignupFormProps {
  onSuccess?: (user: any, tokens: any) => void;
}

export default function SignupForm({ onSuccess }: SignupFormProps) {
  const [error, setError] = useState<string>();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
  });

  const onSubmit = async (values: SignupFormValues) => {
    setError(undefined);
    try {
      const res = await fetch('/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Registration failed. Please try again.');
        return;
      }
      onSuccess?.(data.user, data.tokens);
    } catch {
      setError('Network error. Please check your connection and try again.');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" data-testid="signup-form">
      <div className="space-y-2">
        <label htmlFor="companyName" className="text-sm font-medium">Company / MSP name</label>
        <input
          id="companyName"
          type="text"
          autoComplete="organization"
          placeholder="Acme IT Services"
          data-testid="signup-company-input"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('companyName')}
        />
        {errors.companyName && <p className="text-sm text-destructive">{errors.companyName.message}</p>}
      </div>

      <div className="space-y-2">
        <label htmlFor="name" className="text-sm font-medium">Your name</label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          placeholder="Jane Smith"
          data-testid="signup-name-input"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('name')}
        />
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-2">
        <label htmlFor="signup-email" className="text-sm font-medium">Work email</label>
        <input
          id="signup-email"
          type="email"
          autoComplete="email"
          placeholder="jane@acme.com"
          data-testid="signup-email-input"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('email')}
        />
        {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
      </div>

      <div className="space-y-2">
        <label htmlFor="signup-password" className="text-sm font-medium">Password</label>
        <input
          id="signup-password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          data-testid="signup-password-input"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...register('password')}
        />
        {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
      </div>

      {error && (
        <div data-testid="signup-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        data-testid="signup-submit"
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? 'Creating account...' : 'Create account'}
      </button>

      <p className="text-center text-xs text-muted-foreground">
        By creating an account you agree to our{' '}
        <a href="/terms" className="underline hover:text-foreground">Terms of Service</a>.
      </p>
    </form>
  );
}
```

---

### Phase 11 — Web: `/verify-email.astro` page

#### 11A. New file: `apps/web/src/pages/verify-email.astro`

```astro
---
import AuthLayout from '../layouts/AuthLayout.astro';
import VerifyEmailPage from '../components/auth/VerifyEmailPage';

const token = Astro.url.searchParams.get('token') ?? undefined;
---

<AuthLayout title="Verify email">
  <VerifyEmailPage client:load token={token} />
</AuthLayout>
```

#### 11B. New file: `apps/web/src/components/auth/VerifyEmailPage.tsx`

```tsx
import { useState, useEffect } from 'react';

interface VerifyEmailPageProps {
  token?: string;
}

type State = 'loading' | 'success' | 'error' | 'no-token';

export default function VerifyEmailPage({ token }: VerifyEmailPageProps) {
  const [state, setState] = useState<State>(token ? 'loading' : 'no-token');
  const [resendSent, setResendSent] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch('/api/v1/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'include',
    })
      .then((r) => {
        setState(r.ok ? 'success' : 'error');
      })
      .catch(() => setState('error'));
  }, [token]);

  const handleResend = async () => {
    setResendLoading(true);
    try {
      const res = await fetch('/api/v1/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-breeze-csrf': '1' },
        credentials: 'include',
      });
      if (res.ok) setResendSent(true);
    } finally {
      setResendLoading(false);
    }
  };

  if (state === 'loading') {
    return <div data-testid="verify-loading" className="text-center text-sm text-muted-foreground">Verifying your email...</div>;
  }

  if (state === 'success') {
    return (
      <div data-testid="verify-success" className="text-center space-y-4">
        <h2 className="text-xl font-bold">Email verified</h2>
        <p className="text-sm text-muted-foreground">Your email address has been verified. You're all set.</p>
        <a href="/" className="text-sm text-primary hover:underline">Go to dashboard</a>
      </div>
    );
  }

  if (state === 'no-token') {
    return (
      <div data-testid="verify-no-token" className="text-center space-y-4">
        <h2 className="text-xl font-bold">Invalid verification link</h2>
        <p className="text-sm text-muted-foreground">This link is missing the verification token.</p>
      </div>
    );
  }

  // error state
  return (
    <div data-testid="verify-error" className="text-center space-y-4">
      <h2 className="text-xl font-bold">Link expired or invalid</h2>
      <p className="text-sm text-muted-foreground">
        This verification link has expired or has already been used.
      </p>
      {!resendSent ? (
        <button
          data-testid="resend-verification-btn"
          onClick={handleResend}
          disabled={resendLoading}
          className="text-sm text-primary hover:underline disabled:opacity-60"
        >
          {resendLoading ? 'Sending...' : 'Resend verification email'}
        </button>
      ) : (
        <p data-testid="resend-sent-confirmation" className="text-sm text-green-600">Verification email sent. Check your inbox.</p>
      )}
    </div>
  );
}
```

Note: `resend-verification` requires an authenticated session. If the user is not logged in, the 401 should be silently ignored (they can log in first). The `handleResend` does not surface the 401 — it just does not set `resendSent = true`. An improvement (V2) would detect 401 and redirect to `/auth`.

---

### Phase 12 — Web: `/login.astro` backward-compat redirect

#### 12A. Modify: `apps/web/src/pages/login.astro`

Replace the entire file content with a server-side redirect:

```astro
---
const next = Astro.url.searchParams.get('next');
const target = next ? `/auth?next=${encodeURIComponent(next)}` : '/auth';
return Astro.redirect(target, 302);
---
```

This preserves all existing bookmarks and agent-emitted `/login` URLs. The hash fragment (`#signin`) is lost in a server redirect — acceptable because the landing tab on `/auth` defaults to Sign in anyway.

---

### Phase 13 — Web: ConsentForm 401 redirect

#### 13A. Modify: `apps/web/src/components/oauth/ConsentForm.tsx`

Find the `useEffect` or `fetch` call that loads `GET /api/v1/interaction/:uid`. Add a 401 guard:

```tsx
// Somewhere in the interaction details fetch:
if (res.status === 401) {
  const currentUrl = window.location.pathname + window.location.search;
  window.location.href = `/auth?next=${encodeURIComponent(currentUrl)}`;
  return;
}
```

Exact insertion point depends on the current ConsentForm implementation. The pattern: any 401 from the interaction GET → redirect to `/auth?next=<current URL>`.

---

### Phase 14 — Tests

#### 14A. New file: `apps/api/src/routes/auth/signup.test.ts`

Test cases (Vitest, mock DB + Redis pattern matching `register.ts` tests if they exist):

1. `ENABLE_REGISTRATION=false` → 404
2. Rate limit exceeded → 429
3. Weak password → 400 with error message
4. Duplicate email → 200 with generic success message (anti-enumeration)
5. Happy path:
   - Response shape: `{ user: { id, email, name }, partner: { id, ... }, tokens: { accessToken, expiresInSeconds }, requiresEmailVerification: true }`
   - `emailVerifiedAt` is `null` on the created user row
   - Redis key `email_verify:<hash>` was set with 24h TTL
   - `sendWelcomeWithVerification` was called once
   - Refresh token cookie was set
6. Email service unavailable (null) → 200, email not sent, no error

Mock pattern for `createPartner`: `vi.mock('../../services/partnerCreate', () => ({ createPartner: vi.fn().mockResolvedValue({ partnerId: '...', adminUserId: '...', ... }) }))`. For DB queries in the route, mock `../../db` the same way other auth tests do.

#### 14B. New file: `apps/api/src/routes/auth/verify-email.test.ts`

Test cases:

1. Invalid token (not in Redis) → 400
2. Expired token → 400 (simulate by setting TTL=1 and waiting, or by checking Redis returns null)
3. Happy path:
   - Response: `{ success: true }`
   - `users.emailVerifiedAt` was set to a non-null date
   - Redis key was deleted (assert `redis.get(key)` returns null after call)
4. `POST /resend-verification` — unauthenticated → 401
5. `POST /resend-verification` — already verified → 200 with "already verified" message, no email sent
6. `POST /resend-verification` — rate limit → 429

#### 14C. Modify: `apps/api/src/routes/auth/password.test.ts`

Add test case: "forgot-password with unverified email returns 200 but does NOT call sendPasswordReset".

```ts
it('forgot-password silently skips unverified email', async () => {
  // Mock DB to return user with emailVerifiedAt: null
  // Assert sendPasswordReset was NOT called
  // Assert response is { success: true, message: 'If this email exists...' }
  // Assert console.warn was called with '[auth] forgot-password skipped'
});
```

#### 14D. New file: `apps/web/src/components/auth/AuthPage.test.tsx`

Test cases (Vitest + jsdom, mock `fetch`):

1. Renders with Sign in tab active by default
2. Clicking "Create account" tab switches to signup form, sets `window.location.hash = '#signup'`
3. `#signup` in hash on mount → signup tab active
4. Signup form submission: mocks `fetch('/api/v1/auth/signup')` returning success → `onSuccess` callback called with `(user, tokens)`
5. Verification banner renders after successful signup

#### 14E. Extend: `apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts`

Add a second `it.skipIf(!SHOULD_RUN)` block at the end:

```ts
it.skipIf(!SHOULD_RUN)('OAuth flow: POST /signup creates account then accesses /auth?next=/oauth/consent', async () => {
  // This test exercises that a user can sign up via POST /auth/signup and
  // then complete the OAuth consent flow, verifying the two features
  // integrate correctly. Steps:
  //
  //   1. POST /api/v1/auth/signup → {user, tokens, requiresEmailVerification: true}
  //   2. Assert DB user has emailVerifiedAt IS NULL
  //   3. GET /api/v1/interaction/:uid — using the JWT from step 1 as Bearer
  //      (asserts interaction endpoint is accessible to newly created user)
  //   4. Assert that the user can reach /api/v1/auth/verify-email with the
  //      token minted during signup (extract from Redis in test)
  //
  // Note: full browser-navigation chain (consent UI redirect) is covered by
  // E2E Playwright tests, not here. This integration test stays at the API layer.
});
```

---

### Phase 15 — Documentation

#### 15A. Modify: `apps/api/src/modules/mcpBootstrap/README.md`

Update "## What gets registered when enabled" to add a note below the routes list:

```
### Signup flow (V1)

As of 2026-04-28, Claude.ai forces OAuth as soon as `/.well-known/oauth-protected-resource`
is published. The original "unauthenticated create_tenant first" path does not work through
Claude.ai. The new flow is:

  Claude.ai triggers OAuth → redirected to /auth?next=/oauth/consent?uid=<uid>
       → user signs up via POST /api/v1/auth/signup
       → auto-logged in, navigates to /oauth/consent?uid=<uid>
       → completes consent → access token issued

  POST /api/v1/auth/signup    — self-service signup (no setup-admin gate)
  POST /api/v1/auth/verify-email  — consumes email verification token
  POST /api/v1/auth/resend-verification  — resends welcome email (auth required)
```

Add updated flow diagram (ASCII):

```
Claude.ai --OAuth--> /oauth/auth?client_id=...
                          |
                          v (no session)
                    /auth?next=/oauth/consent?uid=<uid>
                          |
               [Sign in] or [Create account]
                          |
                          v (on success)
                    /oauth/consent?uid=<uid>
                          |
                          v (user approves)
                    /oauth/token   →   access_token (JWT, EdDSA)
```

#### 15B. Note in `internal/mcp-bootstrap/specs/...`

Update the "User journey" section of `internal/mcp-bootstrap/specs/2026-04-20-mcp-agent-deployable-setup-design.md` to reflect the signup-first path (signal for implementer: this is an internal doc — check that it exists before editing; if it's outside the working tree, skip this step).

---

## Data Flow

### Signup happy path

```
Browser POST /api/v1/auth/signup
  → [rate limiter: 3/hr] → [password strength] → [dup-email check: system scope]
  → createPartner() [tx: system scope set_config inside tx]
    → INSERT partner, role, user, partnerUsers, org, site
    → UPDATE users SET setupCompletedAt, lastLoginAt
  → createTokenPair() → setRefreshTokenCookie()
  → nanoid(48) → SHA-256 → redis.setex(email_verify:<hash>, 86400, userId)
  → emailService.sendWelcomeWithVerification() [try/catch, non-fatal]
  → writeAuthAudit()
  → Response: { user, partner, tokens, requiresEmailVerification: true }
```

### Verify-email path

```
Browser GET /verify-email?token=<raw>
  → VerifyEmailPage (React) useEffect
  → POST /api/v1/auth/verify-email { token }
  → SHA-256(token) → redis.get(email_verify:<hash>)
  → if null: 400 "Invalid or expired"
  → withSystemDbAccessContext: UPDATE users SET emailVerifiedAt=now() WHERE id=userId
  → redis.del(email_verify:<hash>)
  → writeAuthAudit(user.email.verified)
  → Response: { success: true }
```

### Forgot-password gated path

```
POST /api/v1/auth/forgot-password { email }
  → [rate limiter] → SELECT user WHERE email = ?  [system scope]
  → if user AND emailVerifiedAt IS NULL:
      console.warn('forgot-password skipped — unverified email')
      return { success: true, message: '...' }  ← no email sent
  → if user AND emailVerifiedAt IS NOT NULL:
      [existing: mint token, redis.setex, sendPasswordReset]
  → return { success: true }
```

### OAuth no-session path

```
Claude.ai → GET /oauth/auth?... → oidc-provider → interactions.url
         → browser → /oauth/consent?uid=<uid>  [no session]
         → ConsentForm useEffect → GET /api/v1/interaction/<uid> → 401
         → window.location.href = /auth?next=/oauth/consent?uid=<uid>
         → AuthPage renders [Sign in / Create account] tabs
         → user logs in or signs up
         → navigateTo(next)  →  /oauth/consent?uid=<uid>
         → ConsentForm renders, user approves
         → POST /api/v1/interaction/<uid> → oidc-provider resumes → token endpoint
```

---

## Build Sequence (Numbered Checklist)

Each step keeps the test suite green at the end of that step.

1. Apply migration `apps/api/migrations/2026-04-28-users-email-verified-at.sql`. Run `pnpm db:check-drift` to confirm no drift.

2. Add `emailVerifiedAt: timestamp('email_verified_at')` to `users` table in `/Users/toddhebebrand/breeze/apps/api/src/db/schema/users.ts` (after line 31). No other schema changes. Run `pnpm db:check-drift` again.

3. Add `signupSchema`, `verifyEmailSchema`, `resendVerificationSchema`, and `EMAIL_VERIFY_TOKEN_TTL_SECONDS` to `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/schemas.ts`.

4. Add `signupLimiter` and `resendVerificationLimiter` to `/Users/toddhebebrand/breeze/apps/api/src/services/rate-limit.ts`.

5. Add `WelcomeWithVerificationEmailParams` interface, `sendWelcomeWithVerification` method, and `buildWelcomeWithVerificationTemplate` function to `/Users/toddhebebrand/breeze/apps/api/src/services/email.ts`. Run `pnpm test --filter=@breeze/api` — email unit tests should still pass.

6. Create `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/signup.ts` with `POST /signup` handler (full implementation per skeleton above). Gate with `ENABLE_REGISTRATION`. Run type-check: `cd apps/api && npx tsc --noEmit`.

7. Create `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/verifyEmail.ts` with `POST /verify-email` and `POST /resend-verification`. Run type-check.

8. Modify `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/index.ts` — add imports and `authRoutes.route('/', signupRoutes)`, `authRoutes.route('/', verifyEmailRoutes)`. Run type-check.

9. Modify `/Users/toddhebebrand/breeze/apps/api/src/routes/auth/password.ts` — gate forgot-password on `emailVerifiedAt`. Expand SELECT to include `emailVerifiedAt`; wrap email-send block with `if (user.emailVerifiedAt)`. Run `pnpm test --filter=@breeze/api`.

10. Write `apps/api/src/routes/auth/signup.test.ts` (all 6 cases). Run tests to green.

11. Write `apps/api/src/routes/auth/verify-email.test.ts` (all 6 cases). Run tests to green.

12. Extend `apps/api/src/routes/auth/password.test.ts` with the unverified-email case. Run tests to green.

13. Modify `/Users/toddhebebrand/breeze/apps/web/src/components/auth/LoginPage.tsx` — add optional `onExternalSuccess` prop; call it in `handleLogin` and `handleMfaVerify` when provided. Run `pnpm test --filter=@breeze/web`.

14. Create `/Users/toddhebebrand/breeze/apps/web/src/components/auth/SignupForm.tsx`. Run type-check: `cd apps/web && npx tsc --noEmit`.

15. Create `/Users/toddhebebrand/breeze/apps/web/src/components/auth/AuthPage.tsx`. Run type-check.

16. Create `/Users/toddhebebrand/breeze/apps/web/src/pages/auth.astro`.

17. Create `/Users/toddhebebrand/breeze/apps/web/src/components/auth/VerifyEmailPage.tsx`.

18. Create `/Users/toddhebebrand/breeze/apps/web/src/pages/verify-email.astro`.

19. Modify `/Users/toddhebebrand/breeze/apps/web/src/pages/login.astro` — replace content with `Astro.redirect` 302.

20. Modify `ConsentForm.tsx` — add 401 → redirect to `/auth?next=<currentUrl>` guard in the interaction-details fetch.

21. Write `apps/web/src/components/auth/AuthPage.test.tsx` (all 5 cases). Run `pnpm test --filter=@breeze/web` to green.

22. Extend `mcpBootstrap.integration.test.ts` with OAuth+signup chain test block.

23. Update `apps/api/src/modules/mcpBootstrap/README.md` with new flow diagram and signup route table.

24. Run full test suite: `pnpm test`. Fix any broken tests before PR.

25. Manual smoke test: visit `/auth` — confirm Sign in / Create account tabs render. Submit signup form. Confirm welcome email sent (check Resend dashboard or local mail catcher). Visit `/verify-email?token=<token>` — confirm "Email verified" state. Confirm `/login` redirects to `/auth`. Confirm OAuth consent flow: initiate from Claude.ai → lands on `/auth` → log in → completes consent.

---

## Open Questions

**Q1: Token TTL — 24h vs 7d?**
Plan chose 24h. Rationale: verification tokens in the wild (Resend's own emails, GitHub signup) are typically 24-48h. A 24h window is sufficient for a welcome flow where the user just signed up. If the account stays unverified past 24h, the Resend button on the `/verify-email` page lets them request a new one. Change `EMAIL_VERIFY_TOKEN_TTL_SECONDS` in `schemas.ts` if the product wants 7d.

**Q2: Welcome email copy — who reviews?**
Subject line and body copy in `buildWelcomeWithVerificationTemplate` are first drafts. Route to marketing/product before launch. The CTA text ("Verify email address") and the 24h expiry message are the two points most likely to need tuning.

**Q3: Keep `/login` as 302-redirect or eventually hard-delete?**
V1: keep as 302. Hard-delete is safe only after confirming no CI/CD scripts, agent installer scripts, or help-doc links still hard-code `/login`. Audit first; delete in a follow-up PR.

**Q4: Rate-limit tuning for signup (3/hr) vs resend-verification (3/hr)**
Both are set to 3 per hour. Signup is resource-creation so tight is correct. Resend-verification could be loosened to 5/hr — a user who doesn't receive their email on a flaky SMTP might try 3-4 times quickly. Open for product call.

**Q5: Verification banner nag — 7 days vs forever?**
Plan chose 7 days (compare `user.createdAt` to `Date.now() - 7*86400*1000` in a dashboard header/banner component — that component is not in scope for this PR). If the banner should appear on every page load until verified regardless of age, remove the date gate. "7 days then silent" is the friendlier default.

**Q6: `dispatchHook` in `/signup` — same or different hook name?**
Current plan reuses `dispatchHook('registration', ...)` — same hook name as `/register-partner`. If external billing hooks need to distinguish signup-from-OAuth vs. register-partner calls, add a `source` field to the hook payload or use a new hook name `'self-service-signup'`. For V1, reuse `'registration'` — no breaking change for existing hook consumers.

**Q7: `AuthPage` layout — two-column branded vs single-column?**
Plan uses `AuthLayout` (single-column centered) for `/auth`. The existing `/login` page uses the full two-column branded layout from `login.astro`. If `/auth` should also be branded, copy the `login.astro` outer HTML shell and slot `<AuthPage>` in place of `<LoginPage>`. This is a visual decision; no behavioral impact. The `/auth` page introduced here uses `AuthLayout` (simpler, already used by `/oauth/consent`).

**Q8: `createTokenPair` scope for signup**
Current plan uses `scope: 'partner'` (same as `/register-partner`). This is correct — the newly created user is a partner admin. No change needed.

**Q9: `acceptTerms` field**
`/register-partner` requires `acceptTerms: true` (see `registerPartnerSchema` at `schemas.ts:35`). The new `signupSchema` does not include it. Add it if legal requires checkbox acceptance before data creation. The current plan omits it for minimal surface area; add easily by extending `signupSchema`.

---

## Critical Implementation Notes

### System-scope wrap for all pre-auth DB operations

Every SELECT and UPDATE in `/signup` and `/verify-email` that runs without an established session context MUST use `withSystemDbAccessContext`. Specifically:

- Dup-email check in `/signup` — pre-auth SELECT on `users`
- `emailVerifiedAt` UPDATE in `/verify-email` — pre-auth UPDATE on `users`
- The `createPartner()` call sets its own system scope inside its transaction (see `partnerCreate.ts:44-51`) — no additional wrap needed around it, but the dup-email check before it must still be wrapped

The pattern is identical to `password.ts:56-62` (SELECT) and `password.ts:122-137` (UPDATE). Failing to wrap these causes silent RLS policy violations — the query appears to succeed but no rows are affected. This is the exact class of bug patched tonight in `password.ts` and `invite.ts`.

### `runWithSystemDbAccess` vs `withSystemDbAccessContext` directly

`runWithSystemDbAccess` (defined in `helpers.ts:29`) is a safe wrapper that calls `withSystemDbAccessContext` if it's a function, otherwise calls `fn()` directly. Use it in route handlers for cleaner code. Both ultimately call `withSystemDbAccessContext` — the helper just guards against the module not exporting it (shouldn't happen, but defensive).

### Token single-use enforcement

`POST /verify-email` must delete the Redis key after a successful UPDATE. The `POST /reset-password` endpoint at `password.ts:139` deletes after use. Mirror that exactly. If the `redis.del` call throws, log it but do not return an error to the client — the UPDATE already committed, and the token expiry (24h) is the safety net.

### Email send failure is non-fatal

Both `/signup` (welcome email) and `/resend-verification` must wrap `emailService.sendWelcomeWithVerification(...)` in a try/catch. Failing to send an email must never cause a 500. Pattern from `password.ts:75-84`:

```ts
try {
  await emailService.sendWelcomeWithVerification(...);
} catch (error) {
  console.error('[signup] Failed to send welcome email:', error instanceof Error ? error.message : String(error));
}
```

### No CSRF on `/signup` or `/verify-email`

`/signup` and `POST /verify-email` are public, unauthenticated endpoints — CSRF protection is not applicable (there is no session cookie to protect). `POST /resend-verification` IS authenticated (requires `authMiddleware`), but per the pattern in other auth routes, CSRF is only enforced by specific routes that opt in via `validateCookieCsrfRequest`. The resend endpoint does not need it — the authMiddleware Bearer token is sufficient.

### `dispatchHook` status-update block

The 35-line block in `register.ts:196-228` that applies `hookResponse.status` to the partner row must be copied verbatim into `/signup`. Do not abbreviate it — the hook contract is load-bearing for the billing integration.

---

## Files to Create or Modify (Summary)

| Action | File |
|---|---|
| CREATE | `apps/api/migrations/2026-04-28-users-email-verified-at.sql` |
| MODIFY | `apps/api/src/db/schema/users.ts` — add `emailVerifiedAt` column |
| MODIFY | `apps/api/src/routes/auth/schemas.ts` — add `signupSchema`, `verifyEmailSchema`, `resendVerificationSchema`, `EMAIL_VERIFY_TOKEN_TTL_SECONDS` |
| MODIFY | `apps/api/src/services/rate-limit.ts` — add `signupLimiter`, `resendVerificationLimiter` |
| MODIFY | `apps/api/src/services/email.ts` — add `WelcomeWithVerificationEmailParams`, `sendWelcomeWithVerification`, `buildWelcomeWithVerificationTemplate` |
| CREATE | `apps/api/src/routes/auth/signup.ts` — `POST /signup` |
| CREATE | `apps/api/src/routes/auth/verifyEmail.ts` — `POST /verify-email`, `POST /resend-verification` |
| MODIFY | `apps/api/src/routes/auth/index.ts` — mount `signupRoutes`, `verifyEmailRoutes` |
| MODIFY | `apps/api/src/routes/auth/password.ts` — gate forgot-password on `emailVerifiedAt` |
| CREATE | `apps/api/src/routes/auth/signup.test.ts` |
| CREATE | `apps/api/src/routes/auth/verify-email.test.ts` |
| MODIFY | `apps/api/src/routes/auth/password.test.ts` — add unverified-email case |
| MODIFY | `apps/web/src/components/auth/LoginPage.tsx` — add `onExternalSuccess` prop |
| CREATE | `apps/web/src/components/auth/SignupForm.tsx` |
| CREATE | `apps/web/src/components/auth/AuthPage.tsx` |
| CREATE | `apps/web/src/pages/auth.astro` |
| CREATE | `apps/web/src/components/auth/VerifyEmailPage.tsx` |
| CREATE | `apps/web/src/pages/verify-email.astro` |
| MODIFY | `apps/web/src/pages/login.astro` — replace with 302 redirect to `/auth` |
| MODIFY | `apps/web/src/components/oauth/ConsentForm.tsx` — 401 → redirect to `/auth?next=…` |
| CREATE | `apps/web/src/components/auth/AuthPage.test.tsx` |
| MODIFY | `apps/api/src/__tests__/integration/mcpBootstrap.integration.test.ts` — add OAuth+signup test block |
| MODIFY | `apps/api/src/modules/mcpBootstrap/README.md` — updated flow diagram |

Total: 10 new files, 13 modified files. No new database tables. One additive migration.

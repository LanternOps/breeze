# Partner Status Guard & Lifecycle Hooks Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic partner status enforcement system to the OSS repo and a lifecycle hook system that external services (like breeze-billing) can plug into — with zero billing-specific language in the OSS codebase.

**Architecture:** Server-side middleware checks `partner.status === 'active'` after auth, returning a structured 403 for inactive partners. A frontend interceptor catches these responses and shows a generic "account inactive" screen with a customizable message and optional action button. A lightweight webhook-based hook system lets external services (configured via env vars) customize registration, device limits, and status messages without any OSS code changes.

**Tech Stack:** Hono middleware (TypeScript), React component (Astro island), Astro page, partner `settings` JSONB for custom messages, HTTP webhook hooks.

---

## File Structure

### Server (apps/api/src/)
| File | Action | Responsibility |
|------|--------|----------------|
| `middleware/partnerGuard.ts` | Create | Check partner.status, return 403 PARTNER_INACTIVE |
| `services/partnerHooks.ts` | Create | Dispatch lifecycle hooks to external webhook URL |
| `routes/auth/register.ts` | Modify | Call post-registration hook |
| `routes/agents/enrollment.ts` | Modify | Call device-limit hook, include hook response in error |
| `routes/partner.ts` | Modify | Include statusMessage/actionUrl in /partner/me |
| `index.ts` | Modify | Mount partnerGuard middleware |
| `config/validate.ts` | Modify | Add PARTNER_HOOKS_URL optional env var |

### Frontend (apps/web/src/)
| File | Action | Responsibility |
|------|--------|----------------|
| `components/auth/AccountInactiveScreen.tsx` | Create | Generic inactive account UI with custom message + CTA |
| `stores/auth.ts` | Modify | Intercept PARTNER_INACTIVE in fetchWithAuth, redirect to /account/inactive |
| `pages/account/inactive.astro` | Create | Astro page wrapper for AccountInactiveScreen |
| `layouts/DashboardLayout.astro` | Modify | Add AccountInactiveGuard |
| `components/auth/AccountInactiveGuard.tsx` | Create | Check partner status, redirect to /account/inactive |

---

## Chunk 1: Server-Side Partner Status Guard

### Task 1: Partner guard middleware

**Files:**
- Create: `apps/api/src/middleware/partnerGuard.ts`

- [ ] **Step 1: Create the middleware**

```typescript
// apps/api/src/middleware/partnerGuard.ts
import { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';

/**
 * Generic partner status guard. Blocks non-active partners from API access.
 * Works for any deployment — self-hosted admins can suspend partners,
 * and external services can set custom status messages via the partner
 * settings JSONB column.
 *
 * Decodes the JWT payload to extract partnerId (without full verification —
 * authMiddleware handles that downstream per-route).
 */
export async function partnerGuard(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    await next();
    return;
  }

  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) {
    await next();
    return;
  }

  let partnerId: string | null = null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    partnerId = payload.partnerId ?? null;
  } catch {
    await next();
    return;
  }

  if (!partnerId) {
    await next();
    return;
  }

  const [partner] = await db
    .select({
      status: partners.status,
      settings: partners.settings,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!partner) {
    await next();
    return;
  }

  if (partner.status !== 'active') {
    const settings = (partner.settings ?? {}) as Record<string, unknown>;
    return c.json({
      error: 'Account inactive',
      code: 'PARTNER_INACTIVE',
      status: partner.status,
      message: (settings.statusMessage as string) ?? null,
      actionUrl: (settings.statusActionUrl as string) ?? null,
      actionLabel: (settings.statusActionLabel as string) ?? null,
    }, 403);
  }

  await next();
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/middleware/partnerGuard.ts
git commit -m "feat: add generic partner status guard middleware"
```

---

### Task 2: Mount guard in index.ts

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Add import**

Add after the last middleware import:
```typescript
import { partnerGuard } from './middleware/partnerGuard';
```

- [ ] **Step 2: Add middleware to API router**

Add as the first `api.use()` call, before the fallback audit middleware. Exempt auth routes, `/users/me`, and `/partner/me` so the frontend can check status:

```typescript
// Generic partner status guard — blocks non-active partners
api.use('*', async (c, next) => {
  const path = c.req.path;
  if (path.startsWith('/api/v1/auth')) { await next(); return; }
  if (path.startsWith('/api/v1/users/me')) { await next(); return; }
  if (path === '/api/v1/partner/me' || path.startsWith('/api/v1/partner/me/')) { await next(); return; }
  await partnerGuard(c, next);
});
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat: mount partner status guard in API middleware chain"
```

---

### Task 3: Enrich /partner/me with status metadata

**Files:**
- Modify: `apps/api/src/routes/partner.ts`

- [ ] **Step 1: Include settings in the partner/me response**

Update the select to include `settings`, then extract status metadata from the JSONB:

```typescript
// In the GET /me handler, change the select to:
const [partner] = await db
  .select({
    id: partners.id,
    name: partners.name,
    slug: partners.slug,
    status: partners.status,
    settings: partners.settings,
  })
  .from(partners)
  .where(eq(partners.id, partnerId))
  .limit(1);

// Change the return to:
const settings = (partner.settings ?? {}) as Record<string, unknown>;
return c.json({
  ...partner,
  settings: undefined, // Don't expose raw settings
  statusMessage: (settings.statusMessage as string) ?? null,
  statusActionUrl: (settings.statusActionUrl as string) ?? null,
  statusActionLabel: (settings.statusActionLabel as string) ?? null,
});
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/partner.ts
git commit -m "feat: include status metadata in partner/me response"
```

---

## Chunk 2: Frontend Account Inactive Screen

### Task 4: Intercept PARTNER_INACTIVE in fetchWithAuth

**Files:**
- Modify: `apps/web/src/stores/auth.ts`

- [ ] **Step 1: Add PARTNER_INACTIVE redirect after the 401 retry block**

In `fetchWithAuth`, after the `if (response.status === 401)` block (around line 305), add:

```typescript
  // If the partner is inactive, redirect to the account inactive page.
  // This catches any API call that hits the server-side partner guard.
  if (response.status === 403) {
    try {
      const cloned = response.clone();
      const body = await cloned.json();
      if (body?.code === 'PARTNER_INACTIVE') {
        const path = window.location.pathname;
        if (!path.startsWith('/account/') && !path.startsWith('/login')) {
          window.location.href = '/account/inactive';
        }
      }
    } catch {
      // Not JSON or parse failed — treat as normal 403
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/stores/auth.ts
git commit -m "feat: intercept PARTNER_INACTIVE responses in fetchWithAuth"
```

---

### Task 5: Create AccountInactiveScreen component


**Files:**
- Create: `apps/web/src/components/auth/AccountInactiveScreen.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/auth/AccountInactiveScreen.tsx
import { useEffect, useState } from 'react';
import { ShieldOff, LogOut } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';

interface StatusInfo {
  status: string;
  message: string | null;
  actionUrl: string | null;
  actionLabel: string | null;
}

const DEFAULT_MESSAGES: Record<string, string> = {
  pending: 'Your account is being set up. Please check back shortly.',
  suspended: 'Your account has been suspended. Please contact your administrator.',
  churned: 'Your account is no longer active. Please contact support.',
};

export default function AccountInactiveScreen() {
  const [info, setInfo] = useState<StatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    fetchWithAuth('/partner/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || data.status === 'active') {
          // Partner is active — shouldn't be on this page
          window.location.href = '/';
          return;
        }
        setInfo({
          status: data.status,
          message: data.statusMessage ?? DEFAULT_MESSAGES[data.status] ?? 'Your account is not active.',
          actionUrl: data.statusActionUrl,
          actionLabel: data.statusActionLabel,
        });
      })
      .catch(() => {
        setInfo({
          status: 'unknown',
          message: 'Unable to load account status. Please try again later.',
          actionUrl: null,
          actionLabel: null,
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = () => {
    logout();
    window.location.href = '/login';
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <ShieldOff className="h-8 w-8 text-muted-foreground" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Account Inactive</h1>
          <p className="text-muted-foreground">{info?.message}</p>
        </div>

        <div className="flex flex-col gap-3">
          {info?.actionUrl && (
            <a
              href={info.actionUrl}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
            >
              {info.actionLabel ?? 'Take Action'}
            </a>
          )}
          <button
            onClick={handleLogout}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/auth/AccountInactiveScreen.tsx
git commit -m "feat: add generic account inactive screen component"
```

---

### Task 6: Create Astro page and guard component

**Files:**
- Create: `apps/web/src/pages/account/inactive.astro`
- Create: `apps/web/src/components/auth/AccountInactiveGuard.tsx`
- Modify: `apps/web/src/layouts/DashboardLayout.astro`

- [ ] **Step 1: Create the Astro page**

```astro
---
// apps/web/src/pages/account/inactive.astro
import Layout from '../../layouts/Layout.astro';
import AccountInactiveScreen from '../../components/auth/AccountInactiveScreen';
import AuthOverlay from '../../components/auth/AuthOverlay';
---

<Layout title="Account Inactive">
  <AuthOverlay client:load />
  <AccountInactiveScreen client:load />
</Layout>
```

- [ ] **Step 2: Create the guard component**

This goes in DashboardLayout — it checks `/partner/me` and redirects to `/account/inactive` if the partner is not active:

```tsx
// apps/web/src/components/auth/AccountInactiveGuard.tsx
import { useEffect } from 'react';
import { useAuthStore, fetchWithAuth } from '../../stores/auth';

/**
 * Checks partner status on mount. If the partner is not active,
 * redirects to /account/inactive which shows the appropriate message.
 * This is a generic guard — no billing logic, just status enforcement.
 */
export default function AccountInactiveGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tokens = useAuthStore((s) => s.tokens);

  useEffect(() => {
    if (!isAuthenticated || !tokens?.accessToken) return;

    const path = window.location.pathname;
    if (path.startsWith('/account/') || path.startsWith('/login') || path.startsWith('/register')) {
      return;
    }

    let cancelled = false;

    fetchWithAuth('/partner/me')
      .then((res) => {
        if (cancelled || !res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (cancelled || !data) return;
        if (data.status && data.status !== 'active') {
          window.location.href = '/account/inactive';
        }
      })
      .catch(() => {
        // Best-effort check — server-side guard is the real enforcement.
      });

    return () => { cancelled = true; };
  }, [isAuthenticated, tokens?.accessToken]);

  return null;
}
```

- [ ] **Step 3: Add guard to DashboardLayout.astro**

Add import:
```typescript
import AccountInactiveGuard from '../components/auth/AccountInactiveGuard';
```

Add after `<AuthOverlay>`:
```astro
<AccountInactiveGuard client:load transition:persist />
```

- [ ] **Step 4: Verify the frontend builds**

Run: `cd apps/web && npx astro check 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/account/inactive.astro apps/web/src/components/auth/AccountInactiveGuard.tsx apps/web/src/layouts/DashboardLayout.astro
git commit -m "feat: add account inactive page and dashboard guard"
```

---

## Chunk 3: Partner Lifecycle Hooks

### Task 7: Create partner hooks service

**Files:**
- Create: `apps/api/src/services/partnerHooks.ts`
- Modify: `apps/api/src/config/validate.ts`

- [ ] **Step 1: Add PARTNER_HOOKS_URL to config validation**

In `apps/api/src/config/validate.ts`, add to the `envSchema` object:
```typescript
PARTNER_HOOKS_URL: z.string().url().optional(),
```

- [ ] **Step 2: Create the hooks service**

```typescript
// apps/api/src/services/partnerHooks.ts
import { getConfig } from '../config/validate';

interface HookPayload {
  event: string;
  partnerId: string;
  data: Record<string, unknown>;
}

interface HookResponse {
  // Registration hook
  status?: string;          // Override partner status (e.g. 'pending')
  redirectUrl?: string;     // Frontend redirect after registration

  // Device limit hook
  upgradeUrl?: string;      // URL for upgrade action

  // Status check hook
  message?: string;         // Custom status message
  actionUrl?: string;       // CTA button URL
  actionLabel?: string;     // CTA button label
}

/**
 * Dispatches a lifecycle hook to an external service via HTTP POST.
 * Returns the hook response if configured, or null if no hooks URL is set.
 *
 * Hook URL receives: POST {PARTNER_HOOKS_URL}/{event}
 * Body: { partnerId, data }
 *
 * Non-blocking on failure — hook errors never break core functionality.
 */
export async function dispatchHook(
  event: string,
  partnerId: string,
  data: Record<string, unknown> = {}
): Promise<HookResponse | null> {
  const config = getConfig();
  const baseUrl = config.PARTNER_HOOKS_URL;
  if (!baseUrl) return null;

  const url = `${baseUrl}/${event}`;
  const payload: HookPayload = { event, partnerId, data };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[PartnerHooks] ${event} returned ${res.status}`);
      return null;
    }

    return (await res.json()) as HookResponse;
  } catch (err) {
    console.warn(`[PartnerHooks] ${event} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/partnerHooks.ts apps/api/src/config/validate.ts
git commit -m "feat: add partner lifecycle hooks service with webhook dispatch"
```

---

### Task 8: Hook into registration flow

**Files:**
- Modify: `apps/api/src/routes/auth/register.ts`

- [ ] **Step 1: Import and call post-registration hook**

Add import:
```typescript
import { dispatchHook } from '../../services/partnerHooks';
```

After the transaction completes and tokens are created, but before returning the response, add:

```typescript
// Dispatch post-registration hook (external services can override status/redirect)
const hookResponse = await dispatchHook('registration', result.newPartner.id, {
  email: result.newUser.email,
  partnerName: result.newPartner.name,
  plan: result.newPartner.plan,
});

// If hook overrides the partner status (e.g. to 'pending'), apply it
if (hookResponse?.status && hookResponse.status !== result.newPartner.status) {
  await db
    .update(partners)
    .set({ status: hookResponse.status as any })
    .where(eq(partners.id, result.newPartner.id));
  result.newPartner.status = hookResponse.status as any;
}
```

Update the return to include the redirect URL if provided:

```typescript
return c.json({
  user: { ... },
  partner: { ... },
  tokens: toPublicTokens(tokens),
  mfaRequired: false,
  ...(hookResponse?.redirectUrl ? { redirectUrl: hookResponse.redirectUrl } : {}),
});
```

- [ ] **Step 2: Update PartnerRegisterPage.tsx to handle redirectUrl**

In `apps/web/src/components/auth/PartnerRegisterPage.tsx`, update the success handler:

```typescript
if (result.user && result.tokens) {
  login(result.user, result.tokens);
  await navigateTo(result.redirectUrl ?? '/');
  return;
}
```

And update `apiRegisterPartner` return type in `apps/web/src/stores/auth.ts`:

```typescript
// Add to the return type:
redirectUrl?: string;

// Add to the return value:
redirectUrl: data.redirectUrl,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/auth/register.ts apps/web/src/components/auth/PartnerRegisterPage.tsx apps/web/src/stores/auth.ts
git commit -m "feat: hook into registration flow for external service overrides"
```

---

### Task 9: Hook into device limit flow

**Files:**
- Modify: `apps/api/src/routes/agents/enrollment.ts`

- [ ] **Step 1: Import and call device-limit hook**

Add import:
```typescript
import { dispatchHook } from '../../services/partnerHooks';
```

In the device limit block (where `DEVICE_LIMIT_REACHED` is returned), call the hook and include its response:

```typescript
if (activeCount >= partner.maxDevices) {
  // Ask external service if there's an upgrade path
  const hookResponse = await dispatchHook('device-limit', org.partnerId, {
    currentDevices: activeCount,
    maxDevices: partner.maxDevices,
  });

  return c.json({
    error: 'Device limit reached',
    code: 'DEVICE_LIMIT_REACHED',
    currentDevices: activeCount,
    maxDevices: partner.maxDevices,
    ...(hookResponse?.upgradeUrl ? { upgradeUrl: hookResponse.upgradeUrl } : {}),
    ...(hookResponse?.message ? { message: hookResponse.message } : {}),
  }, 403);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/agents/enrollment.ts
git commit -m "feat: hook into device limit for external upgrade path"
```

---

## Chunk 4: Billing Service Hook Endpoints

### Task 10: Add hook handler routes to breeze-billing

**Files:**
- Create: `/Users/toddhebebrand/breeze-billing/src/routes/hooks.ts`
- Modify: `/Users/toddhebebrand/breeze-billing/src/index.ts`

- [ ] **Step 1: Create hook handler routes**

```typescript
// breeze-billing/src/routes/hooks.ts
import { Hono } from 'hono';
import { billingApiKeyAuth } from '../middleware/auth.js';
import { getConfig } from '../config/validate.js';

export const hookRoutes = new Hono();

// No auth — hooks are called server-to-server from the main app
// The PARTNER_HOOKS_URL is an internal service URL not exposed publicly

// POST /hooks/registration — called after a new partner registers
hookRoutes.post('/registration', async (c) => {
  const { partnerId, data } = await c.req.json<{
    event: string;
    partnerId: string;
    data: { email?: string; partnerName?: string; plan?: string };
  }>();

  const config = getConfig();

  return c.json({
    status: 'pending',
    redirectUrl: `${config.APP_BASE_URL}/billing/plans`,
  });
});

// POST /hooks/device-limit — called when a partner hits their device limit
hookRoutes.post('/device-limit', async (c) => {
  const { partnerId, data } = await c.req.json<{
    event: string;
    partnerId: string;
    data: { currentDevices?: number; maxDevices?: number };
  }>();

  const config = getConfig();

  return c.json({
    upgradeUrl: `${config.APP_BASE_URL}/billing/plans`,
    message: `You've reached your ${data.maxDevices}-device limit. Upgrade your plan to add more devices.`,
  });
});

// POST /hooks/status-check — called by the partner guard (optional, for dynamic messages)
hookRoutes.post('/status-check', async (c) => {
  // Not implemented yet — guard uses settings JSONB for now
  return c.json({});
});
```

- [ ] **Step 2: Mount in billing service index.ts**

```typescript
import { hookRoutes } from './routes/hooks.js';

// Mount hooks (internal service-to-service, no auth needed)
app.route('/hooks', hookRoutes);
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/toddhebebrand/breeze-billing && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /Users/toddhebebrand/breeze-billing
git add src/routes/hooks.ts src/index.ts
git commit -m "feat: add hook handler endpoints for partner lifecycle events"
```

---

### Task 11: Update billing webhook to set custom status message

**Files:**
- Modify: `/Users/toddhebebrand/breeze-billing/src/routes/stripeWebhooks.ts`
- Modify: `/Users/toddhebebrand/breeze-billing/src/services/partnerSync.ts`

- [ ] **Step 1: Update activatePartner to clear status message**

In `partnerSync.ts`, when activating a partner, clear any custom status message from settings:

```typescript
export async function activatePartner(partnerId: string): Promise<void> {
  const db = getDb();
  await db
    .update(partners)
    .set({
      status: 'active',
      // Clear status message when activated
      settings: sql`jsonb_set(
        COALESCE(${partners.settings}, '{}'::jsonb),
        '{statusMessage}', 'null'::jsonb
      )`,
    })
    .where(eq(partners.id, partnerId));
}
```

- [ ] **Step 2: Add helper to set status message on pending partners**

In `partnerSync.ts`:

```typescript
export async function setPartnerStatusMessage(
  partnerId: string,
  message: string,
  actionUrl?: string,
  actionLabel?: string
): Promise<void> {
  const db = getDb();
  let settings = sql`COALESCE(${partners.settings}, '{}'::jsonb)`;
  settings = sql`jsonb_set(${settings}, '{statusMessage}', ${JSON.stringify(message)}::jsonb)`;
  if (actionUrl) {
    settings = sql`jsonb_set(${settings}, '{statusActionUrl}', ${JSON.stringify(actionUrl)}::jsonb)`;
  }
  if (actionLabel) {
    settings = sql`jsonb_set(${settings}, '{statusActionLabel}', ${JSON.stringify(actionLabel)}::jsonb)`;
  }
  await db.update(partners).set({ settings }).where(eq(partners.id, partnerId));
}
```

- [ ] **Step 3: Call from the registration hook**

In `hooks.ts`, after returning `status: 'pending'`, also set the status message:

```typescript
import { setPartnerStatusMessage } from '../services/partnerSync.js';

// In the registration hook handler, after the return statement data is computed:
// Set a custom message for the pending partner
await setPartnerStatusMessage(
  partnerId,
  'Complete checkout to activate your account.',
  `${config.APP_BASE_URL}/billing/plans`,
  'Go to Checkout'
);
```

- [ ] **Step 4: Verify it compiles**

Run: `cd /Users/toddhebebrand/breeze-billing && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze-billing
git add src/routes/hooks.ts src/services/partnerSync.ts
git commit -m "feat: set custom status messages for pending partners via hooks"
```

---

## Chunk 5: Docker Compose & Environment Configuration

### Task 12: Update docker-compose billing override

**Files:**
- Modify: `/Users/toddhebebrand/breeze/docker-compose.override.yml.billing`

- [ ] **Step 1: Add PARTNER_HOOKS_URL to api service**

Under the `api` service `environment` section, add:

```yaml
PARTNER_HOOKS_URL: http://billing:3002/hooks
```

This tells the main API to dispatch lifecycle hooks to the billing service's `/hooks` endpoints.

- [ ] **Step 2: Commit**

```bash
git add docker-compose.override.yml.billing
git commit -m "feat: configure PARTNER_HOOKS_URL in billing docker-compose override"
```

---

### Task 13: Final verification

- [ ] **Step 1: Verify breeze API compiles**

Run: `cd /Users/toddhebebrand/breeze/apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Verify breeze-billing compiles**

Run: `cd /Users/toddhebebrand/breeze-billing && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify no billing-specific language in OSS**

Run: `grep -r 'billing\|checkout\|Stripe\|payment' apps/api/src/middleware/partnerGuard.ts apps/api/src/services/partnerHooks.ts apps/web/src/components/auth/AccountInactiveScreen.tsx apps/web/src/components/auth/AccountInactiveGuard.tsx`
Expected: No matches (all billing language is in breeze-billing only)

---

## Flow Summary

### Self-hosted (no hooks configured):
```
Register → status='active' → dashboard (no guard triggers)
Device limit → DEVICE_LIMIT_REACHED (no upgradeUrl)
Admin suspends partner → guard blocks with default message
```

### SaaS with billing (PARTNER_HOOKS_URL configured):
```
Register → hook returns status='pending' + redirectUrl
→ partner updated to 'pending', custom message set in settings JSONB
→ frontend redirects to /billing/plans (from hook response)
→ Stripe Checkout → webhook activates partner → guard passes

Device limit → hook returns upgradeUrl
→ frontend can show upgrade link

Suspended (past due) → billing sets status + message via DB
→ guard shows "Update billing info" with portal link
```

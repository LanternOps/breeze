# Signup Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** End-to-end registration → Stripe Checkout → account activation → simplified onboarding → first device enrolled.

**Architecture:** Registration creates a "pending" partner. Pending partners are blocked from all routes except auth/billing. Stripe Checkout Session handles payment. On `checkout.session.completed` webhook, the billing service activates the partner. Post-payment, a 2-step onboarding replaces the old 4-step wizard. Changes span both `breeze` (OSS) and `breeze-billing` (private).

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL, Stripe Checkout Sessions, React, Astro, Zustand

---

## Task 1: Add `partner_status` enum and `status` column to partners table

This is a DB schema change. Partners currently have no status column — all partners are implicitly active. We need a `partner_status` enum and column so we can distinguish pending (unpaid) from active (paid) partners.

**Files:**
- Modify: `apps/api/src/db/schema/orgs.ts:1-22`

**Step 1: Add the enum and column to the schema**

In `apps/api/src/db/schema/orgs.ts`, add a new `partnerStatusEnum` and a `status` column to the `partners` table:

```typescript
// After line 3 (after partnerTypeEnum):
export const partnerStatusEnum = pgEnum('partner_status', ['pending', 'active', 'suspended', 'churned']);
```

Update the `planTypeEnum` to include the new tier names:

```typescript
export const planTypeEnum = pgEnum('plan_type', ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited']);
```

Add `status` column to partners table (after the `plan` line):

```typescript
status: partnerStatusEnum('status').notNull().default('active'),
```

Default is `'active'` so existing partners are unaffected.

**Step 2: Generate a Drizzle migration**

Run:
```bash
cd apps/api && pnpm db:generate
```

This creates a migration file in `apps/api/drizzle/`. The migration should:
- Create `partner_status` enum
- Add `status` column to `partners` with default `'active'`
- Add `'starter'` and `'community'` to `plan_type` enum

**Step 3: Apply migration locally**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
docker exec -i breeze-postgres-dev psql -U breeze -d breeze < apps/api/drizzle/<new-migration-file>.sql
```

**Step 4: Verify type-check passes**

```bash
cd apps/api && npx tsc --noEmit
```

**Step 5: Update breeze-billing schema reference**

In `breeze-billing/src/db/schema/breeze.ts`, add the same `partnerStatusEnum` and `status` column to the read-only `partners` reference, and update `planTypeEnum`:

```typescript
export const partnerStatusEnum = pgEnum('partner_status', ['pending', 'active', 'suspended', 'churned']);
export const planTypeEnum = pgEnum('plan_type', ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited']);

export const partners = pgTable('partners', {
  // ... existing columns ...
  status: partnerStatusEnum('status').notNull().default('active'),
});
```

**Step 6: Verify billing service types**

```bash
cd /Users/toddhebebrand/breeze-billing && npx tsc --noEmit
```

**Step 7: Commit**

```bash
git add apps/api/src/db/schema/orgs.ts apps/api/drizzle/
git commit -m "feat: add partner_status enum and starter/community plan types to schema"
```

And in breeze-billing:
```bash
cd /Users/toddhebebrand/breeze-billing
git add src/db/schema/breeze.ts
git commit -m "feat: update breeze schema reference with partner_status and new plan types"
```

---

## Task 2: Set new partners to "pending" status on registration

Modify the register-partner endpoint so new partners start as `pending` instead of implicitly active.

**Files:**
- Modify: `apps/api/src/routes/auth/register.ts:174-189`
- Modify: `apps/web/src/components/auth/PartnerRegisterPage.tsx:35-39`
- Modify: `apps/web/src/stores/auth.ts:434-469`

**Step 1: Change partner creation to set status='pending'**

In `apps/api/src/routes/auth/register.ts`, update the partner insert (around line 177-185):

```typescript
const [newPartner] = await db
  .insert(partners)
  .values({
    name: companyName,
    slug,
    type: 'msp',
    plan: 'free',
    status: 'pending',
    billingEmail: email.toLowerCase(),
  })
  .returning();
```

Key changes:
- Added `status: 'pending'`
- Added `billingEmail` set to the registering user's email (needed for Stripe customer creation later)

**Step 2: Add `requiresCheckout` flag to the API response**

In the same file, update the response (around line 255-269) to include a checkout redirect hint:

```typescript
return c.json({
  user: {
    id: newUser.id,
    email: newUser.email,
    name: newUser.name,
    mfaEnabled: false
  },
  partner: {
    id: newPartner.id,
    name: newPartner.name,
    slug: newPartner.slug,
    status: newPartner.status,
  },
  tokens: toPublicTokens(tokens),
  mfaRequired: false,
  requiresCheckout: true,
});
```

**Step 3: Update frontend to redirect to billing checkout after registration**

In `apps/web/src/components/auth/PartnerRegisterPage.tsx`, change the post-registration redirect (around line 35-39):

```typescript
if (result.user && result.tokens) {
  login(result.user, result.tokens);
  // Pending partners must complete checkout before accessing the app
  if (result.requiresCheckout) {
    await navigateTo('/billing/plans');
  } else {
    await navigateTo('/');
  }
  return;
}
```

**Step 4: Update `apiRegisterPartner` return type**

In `apps/web/src/stores/auth.ts`, add `requiresCheckout` to the return type (around line 439-444):

```typescript
): Promise<{
  success: boolean;
  user?: User;
  partner?: Partner;
  tokens?: Tokens;
  error?: string;
  requiresCheckout?: boolean;
}> {
```

And in the success return (around line 460-465):

```typescript
return {
  success: true,
  user: data.user,
  partner: data.partner,
  tokens: data.tokens,
  requiresCheckout: data.requiresCheckout,
};
```

**Step 5: Verify type-check**

```bash
cd apps/api && npx tsc --noEmit
```

**Step 6: Commit**

```bash
git add apps/api/src/routes/auth/register.ts apps/web/src/components/auth/PartnerRegisterPage.tsx apps/web/src/stores/auth.ts
git commit -m "feat: set new partners to pending status, redirect to checkout after registration"
```

---

## Task 3: Add pending partner guard middleware

Block pending partners from accessing any API routes except auth and billing. This ensures unpaid accounts can't use the platform.

**Files:**
- Create: `apps/api/src/middleware/pendingGuard.ts`
- Modify: `apps/api/src/index.ts` (around line 544-598, add middleware before audit)

**Step 1: Create the pending guard middleware**

Create `apps/api/src/middleware/pendingGuard.ts`:

```typescript
import { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners, partnerUsers } from '../db/schema';

/**
 * Blocks requests from users whose partner is in "pending" status.
 * Allows through: auth routes, billing-related paths, and unauthenticated requests.
 */
export async function pendingPartnerGuard(c: Context, next: Next) {
  const auth = c.get('auth') as { user?: { id: string }; partnerId?: string | null } | undefined;

  // No auth context (unauthenticated request) — let other middleware handle it
  if (!auth?.partnerId) {
    await next();
    return;
  }

  const [partner] = await db
    .select({ status: partners.status })
    .from(partners)
    .where(eq(partners.id, auth.partnerId))
    .limit(1);

  if (partner?.status === 'pending') {
    return c.json({
      error: 'Account activation required',
      code: 'PARTNER_PENDING',
      message: 'Please complete checkout to activate your account.',
    }, 403);
  }

  await next();
}
```

**Step 2: Apply the guard in index.ts**

In `apps/api/src/index.ts`, import the guard and apply it to the `api` Hono instance. The guard should run after auth middleware but before route handlers. Since auth is applied per-route (not globally), we need to add the guard as a global `api.use()` that checks _after_ auth has run.

Find the existing `api.use('*', ...)` block (line 544) and add the pending guard BEFORE it:

```typescript
import { pendingPartnerGuard } from './middleware/pendingGuard';
```

Then before line 544:

```typescript
// Block pending partners from non-auth/billing routes
api.use('*', async (c, next) => {
  const path = c.req.path;
  // Allow auth routes (login, register, refresh, etc.)
  if (path.startsWith('/api/v1/auth')) {
    await next();
    return;
  }
  // Allow billing routes (agents/enroll is NOT allowed — enrollment requires active account)
  // Users and /users/me are allowed so frontend can check status
  if (path.startsWith('/api/v1/users/me')) {
    await next();
    return;
  }
  await pendingPartnerGuard(c, next);
});
```

**Step 3: Verify type-check**

```bash
cd apps/api && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add apps/api/src/middleware/pendingGuard.ts apps/api/src/index.ts
git commit -m "feat: add pending partner guard — blocks unpaid accounts from API access"
```

---

## Task 4: Create Stripe Checkout Session endpoint in breeze-billing

Add a new route that creates a Stripe Checkout Session for plan selection. This is where the actual payment happens via Stripe's hosted checkout page.

**Files:**
- Create: `breeze-billing/src/routes/checkout.ts`
- Modify: `breeze-billing/src/index.ts:32-36` (mount new route)
- Modify: `breeze-billing/src/services/stripeSync.ts:7-12` (add new plan prices)
- Modify: `breeze-billing/src/routes/portal.ts:35-61` (update pricing endpoint)

**Step 1: Define Starter and Community plan prices**

In `breeze-billing/src/services/stripeSync.ts`, update `PLAN_PRICES` (lines 7-12):

```typescript
const PLAN_PRICES: Record<string, { priceId: string; aiPriceId?: string }> = {
  // Populate from Stripe dashboard — these are Stripe Price IDs
  starter: { priceId: process.env.STRIPE_STARTER_PRICE_ID ?? 'price_starter' },
  community: { priceId: process.env.STRIPE_COMMUNITY_PRICE_ID ?? 'price_community' },
  pro: { priceId: process.env.STRIPE_PRO_PRICE_ID ?? 'price_pro', aiPriceId: process.env.STRIPE_PRO_AI_PRICE_ID },
  enterprise: { priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID ?? 'price_enterprise', aiPriceId: process.env.STRIPE_ENTERPRISE_AI_PRICE_ID },
};
```

Also rename `devicePriceId` to `priceId` throughout the file since Starter/Community aren't per-device — they're flat-rate with included devices.

**Step 2: Create the checkout route**

Create `breeze-billing/src/routes/checkout.ts`:

```typescript
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { jwtAuth } from '../middleware/auth.js';
import { getStripe } from '../config/stripe.js';
import { getDb } from '../db/index.js';
import { partners } from '../db/schema/breeze.js';
import { billingSubscriptions } from '../db/schema/billing.js';
import { createStripeCustomer } from '../services/stripeSync.js';
import { getConfig } from '../config/validate.js';

export const checkoutRoutes = new Hono();

checkoutRoutes.use('*', jwtAuth);

// POST /api/checkout/create-session
// Creates a Stripe Checkout Session for initial signup or plan change
checkoutRoutes.post('/create-session', async (c) => {
  const body = await c.req.json<{ partnerId: string; plan: string }>();
  const { partnerId, plan } = body;
  const stripe = getStripe();
  const db = getDb();
  const config = getConfig();

  if (!partnerId || !plan) {
    return c.json({ error: 'partnerId and plan are required' }, 400);
  }

  const validPlans = ['starter', 'community'];
  if (!validPlans.includes(plan)) {
    return c.json({ error: `Invalid plan. Must be one of: ${validPlans.join(', ')}` }, 400);
  }

  // Look up partner
  const [partner] = await db
    .select({ id: partners.id, name: partners.name, billingEmail: partners.billingEmail, status: partners.status })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!partner) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  // Get or create Stripe customer
  let customerId: string;
  const [existingSub] = await db
    .select({ stripeCustomerId: billingSubscriptions.stripeCustomerId })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.partnerId, partnerId))
    .limit(1);

  if (existingSub) {
    customerId = existingSub.stripeCustomerId;
  } else {
    const customer = await createStripeCustomer(partnerId);
    customerId = customer.id;
  }

  // Price IDs — these come from Stripe dashboard
  const priceMap: Record<string, string> = {
    starter: process.env.STRIPE_STARTER_PRICE_ID ?? 'price_starter',
    community: process.env.STRIPE_COMMUNITY_PRICE_ID ?? 'price_community',
  };

  const priceId = priceMap[plan];
  if (!priceId) {
    return c.json({ error: 'Price not configured for this plan' }, 500);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: {
      breeze_partner_id: partnerId,
      breeze_plan: plan,
    },
    subscription_data: {
      metadata: {
        breeze_partner_id: partnerId,
        breeze_plan: plan,
      },
    },
    success_url: `${config.APP_BASE_URL}/billing/?result=success`,
    cancel_url: `${config.APP_BASE_URL}/billing/plans?result=canceled`,
  });

  return c.json({ url: session.url });
});
```

**Step 3: Mount the checkout route**

In `breeze-billing/src/index.ts`, add after line 34:

```typescript
import { checkoutRoutes } from './routes/checkout.js';
```

And after the `api.route('/api/portal', portalRoutes);` line:

```typescript
app.route('/api/checkout', checkoutRoutes);
```

**Step 4: Update the pricing endpoint**

In `breeze-billing/src/routes/portal.ts`, update the `/pricing` response (lines 35-61):

```typescript
portalRoutes.get('/pricing', async (c) => {
  return c.json({
    plans: [
      {
        id: 'starter',
        name: 'Starter',
        maxDevices: 3,
        price: 20,
        interval: 'year',
        features: ['Up to 3 devices', 'Basic monitoring', 'Community support (forums/docs)'],
      },
      {
        id: 'community',
        name: 'Community',
        maxDevices: 250,
        price: 99,
        interval: 'month',
        features: ['Up to 250 devices', 'All monitoring features', 'AI assistant', 'Remote desktop', 'Community support'],
      },
    ],
  });
});
```

**Step 5: Verify type-check**

```bash
cd /Users/toddhebebrand/breeze-billing && npx tsc --noEmit
```

**Step 6: Commit**

```bash
cd /Users/toddhebebrand/breeze-billing
git add src/routes/checkout.ts src/index.ts src/services/stripeSync.ts src/routes/portal.ts
git commit -m "feat: add Stripe Checkout Session endpoint for signup payment"
```

---

## Task 5: Handle `checkout.session.completed` webhook to activate partner

When Stripe confirms payment, activate the partner account and create the billing subscription record.

**Files:**
- Modify: `breeze-billing/src/routes/stripeWebhooks.ts:29-37`
- Modify: `breeze-billing/src/services/partnerSync.ts:5-28`

**Step 1: Update plan device limits**

In `breeze-billing/src/services/partnerSync.ts`, update `PLAN_DEVICE_LIMITS` and the type signature:

```typescript
const PLAN_DEVICE_LIMITS: Record<string, number> = {
  free: 25,
  starter: 3,
  community: 250,
  pro: 500,
  enterprise: 5000,
  unlimited: 999999,
};

export async function updatePartnerPlan(
  partnerId: string,
  plan: 'free' | 'starter' | 'community' | 'pro' | 'enterprise' | 'unlimited'
): Promise<void> {
```

**Step 2: Add `activatePartner` function to partnerSync**

Append to `breeze-billing/src/services/partnerSync.ts`:

```typescript
export async function activatePartner(partnerId: string): Promise<void> {
  const db = getDb();

  await db
    .update(partners)
    .set({
      status: 'active',
      updatedAt: new Date(),
    })
    .where(eq(partners.id, partnerId));
}
```

**Step 3: Enhance `checkout.session.completed` webhook handler**

In `breeze-billing/src/routes/stripeWebhooks.ts`, replace the `checkout.session.completed` case (lines 30-37):

```typescript
case 'checkout.session.completed': {
  const session = event.data.object as Stripe.Checkout.Session;
  const partnerId = session.metadata?.breeze_partner_id;
  const plan = session.metadata?.breeze_plan;

  if (partnerId && plan) {
    // Activate the partner account
    await activatePartner(partnerId);

    // Set the plan and device limits
    await updatePartnerPlan(partnerId, plan as 'starter' | 'community' | 'pro' | 'enterprise' | 'unlimited');

    // Create/update billing subscription record
    if (session.subscription) {
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;

      const stripe = (await import('../config/stripe.js')).getStripe();
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      const [existingSub] = await db
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.partnerId, partnerId))
        .limit(1);

      if (existingSub) {
        await db
          .update(billingSubscriptions)
          .set({
            stripeSubscriptionId: subscriptionId,
            status: subscription.status,
            currentPeriodStart: new Date(subscription.current_period_start * 1000),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            updatedAt: new Date(),
          })
          .where(eq(billingSubscriptions.id, existingSub.id));
      } else {
        // Find customer ID from session
        const customerId = typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id ?? '';

        await db.insert(billingSubscriptions).values({
          partnerId,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          status: subscription.status,
          currentPeriodStart: new Date(subscription.current_period_start * 1000),
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        });
      }
    }

    await logEvent(partnerId, event);
  }
  break;
}
```

Add the import at the top of the file:

```typescript
import { activatePartner, updatePartnerPlan } from '../services/partnerSync.js';
```

**Step 4: Verify type-check**

```bash
cd /Users/toddhebebrand/breeze-billing && npx tsc --noEmit
```

**Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze-billing
git add src/routes/stripeWebhooks.ts src/services/partnerSync.ts
git commit -m "feat: activate partner on checkout.session.completed webhook"
```

---

## Task 6: Add stale pending account cleanup cron

Daily cron job that deletes partners (and their associated users/roles) that have been pending for more than 48 hours.

**Files:**
- Create: `breeze-billing/src/jobs/staleAccountCleanup.ts`
- Modify: `breeze-billing/src/index.ts` (add cron schedule)

**Step 1: Create the cleanup job**

Create `breeze-billing/src/jobs/staleAccountCleanup.ts`:

```typescript
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { partners } from '../db/schema/breeze.js';
import { billingSubscriptions } from '../db/schema/billing.js';

/**
 * Deletes partners stuck in "pending" status for more than 48 hours.
 * These are users who registered but never completed Stripe Checkout.
 *
 * Cleanup order matters for FK constraints:
 * 1. billing_subscriptions (if any partial records exist)
 * 2. partner_users
 * 3. roles (partner-scoped)
 * 4. users (if orphaned)
 * 5. partners
 */
export async function cleanupStaleAccounts(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

  // Find stale pending partners
  const stalePartners = await db
    .select({ id: partners.id })
    .from(partners)
    .where(
      and(
        eq(partners.status, 'pending'),
        sql`${partners.createdAt} < ${cutoff}`
      )
    );

  if (stalePartners.length === 0) {
    console.log('[StaleCleanup] No stale pending accounts found');
    return;
  }

  const partnerIds = stalePartners.map((p) => p.id);
  console.log(`[StaleCleanup] Found ${partnerIds.length} stale pending accounts, cleaning up...`);

  for (const partnerId of partnerIds) {
    try {
      // Delete in FK-safe order using raw SQL for tables not in billing schema
      await db
        .delete(billingSubscriptions)
        .where(eq(billingSubscriptions.partnerId, partnerId));

      // Use raw SQL for tables only in the main Breeze schema
      await db.execute(sql`DELETE FROM partner_users WHERE partner_id = ${partnerId}`);
      await db.execute(sql`DELETE FROM roles WHERE partner_id = ${partnerId}`);
      await db.execute(sql`
        DELETE FROM users WHERE id IN (
          SELECT u.id FROM users u
          WHERE NOT EXISTS (
            SELECT 1 FROM partner_users pu WHERE pu.user_id = u.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM organization_users ou WHERE ou.user_id = u.id
          )
          AND u.created_at < ${cutoff}
        )
      `);
      await db
        .delete(partners)
        .where(eq(partners.id, partnerId));

      console.log(`[StaleCleanup] Deleted stale partner ${partnerId}`);
    } catch (err) {
      console.error(`[StaleCleanup] Failed to clean up partner ${partnerId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[StaleCleanup] Cleaned up ${partnerIds.length} stale accounts`);
}
```

**Step 2: Schedule the cron**

In `breeze-billing/src/index.ts`, add the import and cron schedule:

```typescript
import { cleanupStaleAccounts } from './jobs/staleAccountCleanup.js';
```

Add after the grace period enforcer cron (after line 81):

```typescript
cron.schedule('0 3 * * *', async () => {
  console.log('[Cron] Running stale account cleanup...');
  await cleanupStaleAccounts().catch((err) => {
    console.error('[Cron] staleAccountCleanup failed:', err instanceof Error ? err.message : err);
  });
});
```

**Step 3: Verify type-check**

```bash
cd /Users/toddhebebrand/breeze-billing && npx tsc --noEmit
```

**Step 4: Commit**

```bash
cd /Users/toddhebebrand/breeze-billing
git add src/jobs/staleAccountCleanup.ts src/index.ts
git commit -m "feat: add daily cron to clean up stale pending accounts (48h+)"
```

---

## Task 7: Update enrollment guard to return `upgrade_required` error code

When a Starter user hits 3 devices, the enrollment response should include a structured error code so the frontend can show an upgrade modal.

**Files:**
- Modify: `apps/api/src/routes/agents/enrollment.ts:99-102`

**Step 1: Update the 403 response**

In `apps/api/src/routes/agents/enrollment.ts`, replace line 101:

```typescript
// Old:
return c.json({ error: 'Device limit reached for this partner' }, 403);

// New:
return c.json({
  error: 'Device limit reached for this partner',
  code: 'UPGRADE_REQUIRED',
  currentDevices: activeCount,
  maxDevices: partner.maxDevices,
}, 403);
```

**Step 2: Verify type-check**

```bash
cd apps/api && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add apps/api/src/routes/agents/enrollment.ts
git commit -m "feat: return upgrade_required error code when device limit reached"
```

---

## Task 8: Build the billing checkout page in the billing SPA

When a pending partner is redirected to `/billing/plans`, they should see a plan picker with Starter and Community options. Selecting a plan creates a Stripe Checkout Session and redirects to Stripe.

**Files:**
- Modify: `breeze-billing/ui/src/pages/Plans.tsx:1-77`
- Modify: `breeze-billing/ui/src/lib/types.ts` (update Plan type)
- Modify: `breeze-billing/ui/src/components/PlanCard.tsx` (update for new plan structure)

**Step 1: Update the Plan type**

In `breeze-billing/ui/src/lib/types.ts`, update the `Plan` interface to include interval:

```typescript
export interface Plan {
  id: string;
  name: string;
  maxDevices: number;
  price: number;
  interval: 'month' | 'year';
  features: string[];
}
```

Remove `pricePerDevice` if it exists, replace with `price` and `interval`.

**Step 2: Update PlanCard component**

In `breeze-billing/ui/src/components/PlanCard.tsx`, update to show the new pricing format:

- Display `$20/year` or `$99/month` instead of per-device pricing
- Show `Up to X devices` from the plan data
- Button text: "Get Started" for new users, "Current Plan" for active, "Upgrade" / "Downgrade" for plan changes

**Step 3: Update Plans page to use Stripe Checkout**

In `breeze-billing/ui/src/pages/Plans.tsx`, change `selectPlan` to create a Checkout Session instead of directly subscribing:

```typescript
const selectPlan = async (planId: string) => {
  if (!partnerId) return;
  setSubscribing(true);
  setError(null);
  try {
    const { url } = await apiFetch<{ url: string }>('/checkout/create-session', {
      method: 'POST',
      body: JSON.stringify({ partnerId, plan: planId }),
    });
    if (url) {
      window.location.href = url;
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to start checkout');
  } finally {
    setSubscribing(false);
  }
};
```

**Step 4: Add success/canceled handling on the Overview page**

In `breeze-billing/ui/src/pages/Overview.tsx`, detect `?result=success` query param and show a success banner:

```typescript
const params = new URLSearchParams(window.location.search);
const checkoutResult = params.get('result');

// Show success message if just completed checkout
{checkoutResult === 'success' && (
  <div className="rounded-lg border border-green-500 bg-green-500/10 p-4 text-sm text-green-700">
    Payment successful! Your account is now active.
  </div>
)}
```

**Step 5: Verify the billing SPA builds**

```bash
cd /Users/toddhebebrand/breeze-billing/ui && npm run build
```

**Step 6: Commit**

```bash
cd /Users/toddhebebrand/breeze-billing
git add ui/src/pages/Plans.tsx ui/src/pages/Overview.tsx ui/src/lib/types.ts ui/src/components/PlanCard.tsx
git commit -m "feat: billing checkout page with Stripe Checkout Session redirect"
```

---

## Task 9: Build simplified 2-step onboarding wizard

Replace the existing 4-step setup wizard with a focused 2-step flow: create org+site, then enroll first device.

**Files:**
- Modify: `apps/web/src/components/setup/SetupWizard.tsx` (rewrite)
- Modify: `apps/web/src/components/setup/OrganizationSetupStep.tsx` (combine org+site)
- Create: `apps/web/src/components/setup/EnrollDeviceStep.tsx`
- Modify: `apps/web/src/pages/setup.astro` (if needed)

**Step 1: Create the EnrollDeviceStep component**

Create `apps/web/src/components/setup/EnrollDeviceStep.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { Copy, Check, Monitor, Apple, Terminal as TerminalIcon } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

interface Props {
  orgId: string;
  siteId: string;
  onSkip: () => void;
}

export default function EnrollDeviceStep({ orgId, siteId, onSkip }: Props) {
  const [enrollmentKey, setEnrollmentKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [platform, setPlatform] = useState<'windows' | 'macos' | 'linux'>('windows');

  useEffect(() => {
    const createKey = async () => {
      try {
        const res = await fetchWithAuth('/enrollment-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orgId,
            siteId,
            name: 'Setup Wizard Key',
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setEnrollmentKey(data.key);
        }
      } catch {
        // enrollment key creation failed
      } finally {
        setLoading(false);
      }
    };
    createKey();
  }, [orgId, siteId]);

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const installCommands: Record<string, string> = {
    windows: `# Run in PowerShell as Administrator\nInvoke-WebRequest -Uri "https://your-domain/api/v1/agents/download/windows" -OutFile breeze-agent.exe; .\\breeze-agent.exe install --key ${enrollmentKey ?? '<key>'}`,
    macos: `# Run in Terminal\ncurl -fsSL "https://your-domain/api/v1/agents/download/macos" -o breeze-agent && chmod +x breeze-agent && sudo ./breeze-agent install --key ${enrollmentKey ?? '<key>'}`,
    linux: `# Run in Terminal\ncurl -fsSL "https://your-domain/api/v1/agents/download/linux" -o breeze-agent && chmod +x breeze-agent && sudo ./breeze-agent install --key ${enrollmentKey ?? '<key>'}`,
  };

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">Generating enrollment key...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Enroll Your First Device</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Install the Breeze agent on a device to start monitoring.
        </p>
      </div>

      {enrollmentKey && (
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Enrollment Key</label>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono">
                {enrollmentKey}
              </code>
              <button
                onClick={() => copyToClipboard(enrollmentKey)}
                className="rounded-md p-2 hover:bg-muted"
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <div className="flex gap-2 mb-3">
              {[
                { key: 'windows' as const, label: 'Windows', icon: Monitor },
                { key: 'macos' as const, label: 'macOS', icon: Apple },
                { key: 'linux' as const, label: 'Linux', icon: TerminalIcon },
              ].map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setPlatform(key)}
                  className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm ${
                    platform === key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
            <pre className="rounded-md bg-muted p-4 text-sm font-mono whitespace-pre-wrap overflow-x-auto">
              {installCommands[platform]}
            </pre>
            <button
              onClick={() => copyToClipboard(installCommands[platform])}
              className="mt-2 text-sm text-primary hover:underline"
            >
              {copied ? 'Copied!' : 'Copy command'}
            </button>
          </div>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <button
          onClick={onSkip}
          className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
        >
          I'll do this later
        </button>
        <button
          onClick={onSkip}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Go to Dashboard
        </button>
      </div>
    </div>
  );
}
```

**Step 2: Rewrite SetupWizard to 2 steps**

Rewrite `apps/web/src/components/setup/SetupWizard.tsx` to have just 2 steps:
1. Create Org + Site (reuse/simplify `OrganizationSetupStep`)
2. Enroll Device (new `EnrollDeviceStep`)

Keep the existing auth guard logic. Remove references to AccountSetupStep, ConfigReviewStep, and SetupSummaryStep. Store `orgId` and `siteId` in state to pass to step 2.

The wizard steps become:

```typescript
const STEPS = [
  { label: 'Organization' },
  { label: 'Enroll Device' },
];
```

**Step 3: Verify frontend builds**

```bash
cd apps/web && npx astro check
```

**Step 4: Commit**

```bash
git add apps/web/src/components/setup/
git commit -m "feat: simplified 2-step onboarding — create org/site + enroll device"
```

---

## Task 10: Add upgrade modal to device management UI

When enrollment fails with `UPGRADE_REQUIRED`, show a modal prompting the user to upgrade from Starter to Community.

**Files:**
- Create: `apps/web/src/components/devices/UpgradeModal.tsx`
- Modify: device enrollment UI or wherever enrollment errors are displayed

**Step 1: Create the UpgradeModal component**

Create `apps/web/src/components/devices/UpgradeModal.tsx`:

```typescript
import { useState } from 'react';
import { X, Zap } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

interface Props {
  currentDevices: number;
  maxDevices: number;
  onClose: () => void;
  onUpgraded: () => void;
}

export default function UpgradeModal({ currentDevices, maxDevices, onClose, onUpgraded }: Props) {
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async () => {
    setUpgrading(true);
    setError(null);
    try {
      // Get partner ID from auth store
      const authRaw = localStorage.getItem('breeze-auth');
      const partnerId = authRaw ? JSON.parse(authRaw)?.state?.partner?.id : null;
      if (!partnerId) throw new Error('Partner ID not found');

      // Create checkout session for Community plan
      const billingUrl = import.meta.env.PUBLIC_BILLING_URL || '';
      const res = await fetch(`${billingUrl}/api/checkout/create-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${JSON.parse(authRaw!)?.state?.accessToken}`,
        },
        body: JSON.stringify({ partnerId, plan: 'community' }),
      });

      if (!res.ok) throw new Error('Failed to create checkout session');
      const { url } = await res.json();
      if (url) window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upgrade failed');
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-yellow-500" />
            <h3 className="text-lg font-semibold">Device Limit Reached</h3>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          You're using {currentDevices} of {maxDevices} devices on your Starter plan.
          Upgrade to Community to manage up to 250 devices.
        </p>

        <div className="rounded-lg border bg-muted/50 p-4 mb-4">
          <div className="font-medium">Community Plan</div>
          <div className="text-2xl font-bold mt-1">$99<span className="text-sm font-normal text-muted-foreground">/month</span></div>
          <div className="text-sm text-muted-foreground mt-1">Up to 250 devices</div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive mb-4">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Not Now
          </button>
          <button
            onClick={handleUpgrade}
            disabled={upgrading}
            className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {upgrading ? 'Redirecting...' : 'Upgrade Now'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Wire up the modal**

Find where enrollment errors are displayed in the devices UI (likely in the enrollment key management or device list page). When an API response includes `code: 'UPGRADE_REQUIRED'`, show the `UpgradeModal` with the `currentDevices` and `maxDevices` from the response.

This depends on where device enrollment feedback surfaces in the UI. The modal should be importable from any page that might trigger enrollment.

**Step 3: Verify frontend builds**

```bash
cd apps/web && npx astro check
```

**Step 4: Commit**

```bash
git add apps/web/src/components/devices/UpgradeModal.tsx
git commit -m "feat: add upgrade modal shown when device limit reached"
```

---

## Task 11: Add `PUBLIC_BILLING_URL` env var to Breeze web app

The main Breeze web app needs to know the billing service URL for checkout redirects and upgrade flows.

**Files:**
- Modify: `apps/web/astro.config.mjs` or `.env` config (add `PUBLIC_BILLING_URL`)
- Modify: `docker-compose.override.yml.billing` (pass env var to web service)

**Step 1: Add env var to compose override**

In `docker-compose.override.yml.billing`, add to the web service (or api service if proxied):

```yaml
  web:
    environment:
      PUBLIC_BILLING_URL: ${PUBLIC_BILLING_URL:-http://localhost:3002}
```

**Step 2: Verify compose file syntax**

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml.billing config --quiet
```

**Step 3: Commit**

```bash
git add docker-compose.override.yml.billing
git commit -m "feat: add PUBLIC_BILLING_URL env var for billing service integration"
```

---

## Task 12: Frontend redirect guard for pending partners

When a pending partner user tries to access any page other than billing, redirect them to the checkout page.

**Files:**
- Modify: `apps/web/src/stores/auth.ts` (add partner status to store)
- Create: `apps/web/src/components/auth/PendingGuard.tsx`

**Step 1: Store partner status in auth state**

In `apps/web/src/stores/auth.ts`, ensure the `Partner` type includes `status` and that it's stored when login/register happens. The auth store's `login` function should accept and persist `partner.status`.

**Step 2: Create a PendingGuard component**

Create `apps/web/src/components/auth/PendingGuard.tsx`:

```typescript
import { useEffect } from 'react';
import { useAuthStore } from '../../stores/auth';

/**
 * Drop this component into any Astro page layout.
 * If the logged-in user's partner is "pending", redirect to billing checkout.
 */
export default function PendingGuard() {
  const partner = useAuthStore((s) => s.partner);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (partner?.status === 'pending') {
      // Don't redirect if already on billing pages
      if (!window.location.pathname.startsWith('/billing')) {
        window.location.href = '/billing/plans';
      }
    }
  }, [isAuthenticated, partner?.status]);

  return null;
}
```

**Step 3: Add PendingGuard to the main layout**

In the main Astro layout (wherever the sidebar and auth wrapper live), add:

```astro
<PendingGuard client:load />
```

This ensures any page load by a pending partner redirects to checkout.

**Step 4: Commit**

```bash
git add apps/web/src/components/auth/PendingGuard.tsx apps/web/src/stores/auth.ts
git commit -m "feat: frontend redirect guard for pending partners"
```

---

## Implementation Sequence

| Order | Task | Repo | Dependency |
|-------|------|------|------------|
| 1 | Partner status enum + schema | breeze + breeze-billing | None |
| 2 | Set partners to pending on registration | breeze | Task 1 |
| 3 | Pending partner guard middleware | breeze | Task 1 |
| 4 | Stripe Checkout Session endpoint | breeze-billing | Task 1 |
| 5 | Checkout webhook activates partner | breeze-billing | Task 4 |
| 6 | Stale account cleanup cron | breeze-billing | Task 1 |
| 7 | Enrollment upgrade_required error code | breeze | None |
| 8 | Billing checkout page (SPA) | breeze-billing | Task 4 |
| 9 | Simplified onboarding wizard | breeze | None |
| 10 | Upgrade modal | breeze | Task 7 |
| 11 | PUBLIC_BILLING_URL env var | breeze | None |
| 12 | Frontend pending guard | breeze | Task 2 |

Tasks 1-6 are the critical path. Tasks 7-12 can be done in parallel after Task 6.

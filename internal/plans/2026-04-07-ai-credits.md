# AI Credit System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add credit-based AI usage billing — Community plan gets 1,500 credits/month, purchasable top-up packs, hard block when depleted.

**Architecture:** Two new billing tables (`billing_credit_balances`, `billing_credit_transactions`) in the billing service. Internal API endpoints for Breeze core to check/deduct credits. Stripe Checkout for one-time credit pack purchases. Billing portal UI for balance display and purchasing. Breeze core's `checkBudget()` modified to call billing service instead of local budget table.

**Tech Stack:** Hono (billing API), Drizzle ORM + raw SQL (DB), Stripe Checkout (purchases), React (billing portal UI), Vitest (tests)

**Spec:** `internal/2026-04-07-ai-credits-design.md`

---

## File Structure

### Billing Service (`~/breeze-billing`)

| File | Action | Purpose |
|------|--------|---------|
| `src/db/schema/billing.ts` | Modify | Add `billingCreditBalances` and `billingCreditTransactions` tables |
| `src/config/validate.ts` | Modify | Add `AI_CREDITS_PER_MONTH`, `AI_CREDIT_RATE_CENTS`, `AI_CREDITS_CURRENCY_SYMBOL`, `AI_CREDITS_LOCALE` env vars |
| `src/services/creditService.ts` | Create | Core credit logic: check, deduct, add, reset |
| `src/routes/internal.ts` | Modify | Add `GET /partners/:id/ai-credits` and `POST /partners/:id/ai-credits/deduct` |
| `src/routes/credits.ts` | Create | User-facing: balance, transactions, purchase |
| `src/routes/stripeWebhooks.ts` | Modify | Handle `checkout.session.completed` for credit purchases |
| `src/jobs/creditReset.ts` | Create | Monthly credit reset cron job |
| `src/index.ts` | Modify | Mount credit routes, add cron job |
| `src/templates/creditsLow.ts` | Create | 80% usage email template |
| `src/templates/creditsEmpty.ts` | Create | 100% usage email template |
| `ui/src/lib/types.ts` | Modify | Add credit types |
| `ui/src/pages/Credits.tsx` | Create | Credits page with balance + transactions + purchase |
| `ui/src/App.tsx` | Modify | Add `/credits` route |

### Breeze Core (`~/breeze`)

| File | Action | Purpose |
|------|--------|---------|
| `apps/api/src/services/aiCostTracker.ts` | Modify | `checkBudget()` calls billing service for credit check; `recordUsageFromSdkResult()` calls deduct endpoint |

---

### Task 1: Database Schema — Credit Tables

**Files:**
- Modify: `~/breeze-billing/src/db/schema/billing.ts`

- [ ] **Step 1: Add credit balance and transaction tables to schema**

Add to the end of `~/breeze-billing/src/db/schema/billing.ts`:

```typescript
export const billingCreditBalances = pgTable('billing_credit_balances', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().unique(),
  includedBalance: integer('included_balance').notNull().default(0),
  purchasedBalance: integer('purchased_balance').notNull().default(0),
  lastResetAt: timestamp('last_reset_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const billingCreditTransactions = pgTable('billing_credit_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull(),
  amount: integer('amount').notNull(),
  type: varchar('type', { length: 50 }).notNull(),
  balanceAfter: integer('balance_after').notNull(),
  description: varchar('description', { length: 255 }),
  stripePaymentId: varchar('stripe_payment_id', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

- [ ] **Step 2: Create tables on EU managed database**

Run via SSH:

```bash
ssh root@164.90.237.99 "PGPASSWORD='REDACTED_AIVEN_PASSWORD' psql 'postgresql://doadmin@private-breeze-eu-db-do-user-227115-0.i.db.ondigitalocean.com:25060/breeze?sslmode=require' -c \"
CREATE TABLE IF NOT EXISTS billing_credit_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL UNIQUE,
  included_balance INTEGER NOT NULL DEFAULT 0,
  purchased_balance INTEGER NOT NULL DEFAULT 0,
  last_reset_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL,
  amount INTEGER NOT NULL,
  type VARCHAR(50) NOT NULL,
  balance_after INTEGER NOT NULL,
  description VARCHAR(255),
  stripe_payment_id VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_partner
  ON billing_credit_transactions (partner_id, created_at DESC);
\""
```

- [ ] **Step 3: Commit**

```bash
cd ~/breeze-billing
git add src/db/schema/billing.ts
git commit -m "feat: add credit balance and transaction tables"
```

---

### Task 2: Environment Configuration

**Files:**
- Modify: `~/breeze-billing/src/config/validate.ts`

- [ ] **Step 1: Add credit env vars to the Zod schema**

Add these fields to the `envSchema` object in `validate.ts`, after the `APP_BASE_URL` field:

```typescript
  AI_CREDITS_PER_MONTH: z
    .string()
    .default('1500')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(0)),

  AI_CREDIT_RATE_CENTS: z
    .string()
    .default('1')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(1)),

  AI_CREDITS_CURRENCY_SYMBOL: z.string().default('$'),

  AI_CREDITS_LOCALE: z.string().default('en-US'),
```

- [ ] **Step 2: Commit**

```bash
cd ~/breeze-billing
git add src/config/validate.ts
git commit -m "feat: add AI credit env vars with defaults"
```

---

### Task 3: Credit Service — Core Logic

**Files:**
- Create: `~/breeze-billing/src/services/creditService.ts`

- [ ] **Step 1: Create the credit service**

```typescript
import { eq } from 'drizzle-orm';
import { getDb, getPgClient } from '../db/index.js';
import { billingCreditBalances, billingCreditTransactions } from '../db/schema/billing.js';
import { partners } from '../db/schema/breeze.js';
import { getConfig } from '../config/validate.js';

const CREDIT_PACKS = {
  small:  { credits: 1000,  priceCents: 1500 },
  medium: { credits: 5000,  priceCents: 6000 },
  large:  { credits: 10000, priceCents: 10000 },
} as const;

export type CreditPackId = keyof typeof CREDIT_PACKS;

export function getCreditPacks() {
  return CREDIT_PACKS;
}

export function isValidPack(pack: string): pack is CreditPackId {
  return pack in CREDIT_PACKS;
}

/**
 * Get or create a credit balance for a partner.
 */
export async function getOrCreateBalance(partnerId: string) {
  const db = getDb();
  const config = getConfig();

  const [existing] = await db
    .select()
    .from(billingCreditBalances)
    .where(eq(billingCreditBalances.partnerId, partnerId))
    .limit(1);

  if (existing) return existing;

  // Check if partner is on a plan that gets credits
  const [partner] = await db
    .select({ plan: partners.plan })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  const includedBalance = partner?.plan === 'community' ? config.AI_CREDITS_PER_MONTH : 0;

  const [created] = await db
    .insert(billingCreditBalances)
    .values({
      partnerId,
      includedBalance,
      purchasedBalance: 0,
      lastResetAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();

  // Handle race condition — another request may have inserted first
  if (!created) {
    const [raced] = await db
      .select()
      .from(billingCreditBalances)
      .where(eq(billingCreditBalances.partnerId, partnerId))
      .limit(1);
    return raced!;
  }

  return created;
}

/**
 * Check if a partner can use AI and how many credits remain.
 */
export async function checkCredits(partnerId: string): Promise<{
  allowed: boolean;
  remainingCredits: number;
  includedBalance: number;
  purchasedBalance: number;
  plan: string;
}> {
  const db = getDb();

  const [partner] = await db
    .select({ plan: partners.plan })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  const plan = partner?.plan ?? 'free';

  // Only community (and above) get AI access
  if (!['community', 'pro', 'enterprise', 'unlimited'].includes(plan)) {
    return { allowed: false, remainingCredits: 0, includedBalance: 0, purchasedBalance: 0, plan };
  }

  const balance = await getOrCreateBalance(partnerId);
  const total = balance.includedBalance + balance.purchasedBalance;

  return {
    allowed: total > 0,
    remainingCredits: total,
    includedBalance: balance.includedBalance,
    purchasedBalance: balance.purchasedBalance,
    plan,
  };
}

/**
 * Deduct credits after an AI message. Uses included balance first, then purchased.
 * Returns the number of credits deducted and remaining balance.
 */
export async function deductCredits(
  partnerId: string,
  costCents: number,
  description: string = 'AI chat message'
): Promise<{ creditsDeducted: number; remainingCredits: number }> {
  const config = getConfig();
  const pg = getPgClient();
  const creditsToDeduct = Math.ceil(costCents / config.AI_CREDIT_RATE_CENTS);

  if (creditsToDeduct <= 0) {
    const balance = await getOrCreateBalance(partnerId);
    return { creditsDeducted: 0, remainingCredits: balance.includedBalance + balance.purchasedBalance };
  }

  // Atomic deduction: included first, then purchased
  const [result] = await pg`
    WITH current AS (
      SELECT id, included_balance, purchased_balance
      FROM billing_credit_balances
      WHERE partner_id = ${partnerId}::uuid
      FOR UPDATE
    ),
    deduction AS (
      SELECT
        LEAST(${creditsToDeduct}, included_balance) AS from_included,
        GREATEST(0, ${creditsToDeduct} - included_balance) AS from_purchased
      FROM current
    )
    UPDATE billing_credit_balances b
    SET
      included_balance = b.included_balance - d.from_included,
      purchased_balance = b.purchased_balance - d.from_purchased,
      updated_at = NOW()
    FROM deduction d
    WHERE b.partner_id = ${partnerId}::uuid
    RETURNING
      b.included_balance + b.purchased_balance AS remaining,
      d.from_included + d.from_purchased AS deducted
  `;

  const creditsDeducted = result?.deducted ?? 0;
  const remainingCredits = result?.remaining ?? 0;

  // Log transaction
  const db = getDb();
  await db.insert(billingCreditTransactions).values({
    partnerId,
    amount: -creditsDeducted,
    type: 'usage',
    balanceAfter: remainingCredits,
    description,
  });

  return { creditsDeducted, remainingCredits };
}

/**
 * Add purchased credits to a partner's balance.
 */
export async function addPurchasedCredits(
  partnerId: string,
  credits: number,
  stripePaymentId: string,
  description: string
): Promise<void> {
  const balance = await getOrCreateBalance(partnerId);
  const db = getDb();
  const pg = getPgClient();

  await pg`
    UPDATE billing_credit_balances
    SET purchased_balance = purchased_balance + ${credits},
        updated_at = NOW()
    WHERE partner_id = ${partnerId}::uuid
  `;

  const newTotal = balance.includedBalance + balance.purchasedBalance + credits;

  await db.insert(billingCreditTransactions).values({
    partnerId,
    amount: credits,
    type: 'purchase',
    balanceAfter: newTotal,
    description,
    stripePaymentId,
  });
}

/**
 * Reset included credits for a partner (monthly cycle).
 */
export async function resetIncludedCredits(partnerId: string): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const pg = getPgClient();

  await pg`
    UPDATE billing_credit_balances
    SET included_balance = ${config.AI_CREDITS_PER_MONTH},
        last_reset_at = NOW(),
        updated_at = NOW()
    WHERE partner_id = ${partnerId}::uuid
  `;

  const [balance] = await db
    .select()
    .from(billingCreditBalances)
    .where(eq(billingCreditBalances.partnerId, partnerId))
    .limit(1);

  const total = balance ? balance.includedBalance + balance.purchasedBalance : config.AI_CREDITS_PER_MONTH;

  await db.insert(billingCreditTransactions).values({
    partnerId,
    amount: config.AI_CREDITS_PER_MONTH,
    type: 'monthly_reset',
    balanceAfter: total,
    description: `Monthly credit reset (${config.AI_CREDITS_PER_MONTH} credits)`,
  });
}

/**
 * Get recent transactions for a partner.
 */
export async function getTransactions(partnerId: string, limit: number = 50) {
  const db = getDb();
  const rows = await db
    .select()
    .from(billingCreditTransactions)
    .where(eq(billingCreditTransactions.partnerId, partnerId))
    .orderBy(billingCreditTransactions.createdAt)
    .limit(limit);
  return rows;
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/breeze-billing
git add src/services/creditService.ts
git commit -m "feat: credit service — check, deduct, add, reset, transactions"
```

---

### Task 4: Internal API Endpoints (Service-to-Service)

**Files:**
- Modify: `~/breeze-billing/src/routes/internal.ts`

- [ ] **Step 1: Add credit check and deduct endpoints**

Add these imports at the top of `internal.ts`:

```typescript
import { checkCredits, deductCredits } from '../services/creditService.js';
```

Add these endpoints after the existing `/partners/:id/status` route:

```typescript
// GET /api/internal/partners/:id/ai-credits — check credit balance
internalRoutes.get('/partners/:id/ai-credits', async (c) => {
  const partnerId = c.req.param('id');
  const result = await checkCredits(partnerId);
  return c.json(result);
});

// POST /api/internal/partners/:id/ai-credits/deduct — deduct credits after AI message
internalRoutes.post('/partners/:id/ai-credits/deduct', async (c) => {
  const partnerId = c.req.param('id');
  const { costCents, description } = await c.req.json<{ costCents: number; description?: string }>();

  if (typeof costCents !== 'number' || costCents < 0) {
    return c.json({ error: 'costCents must be a non-negative number' }, 400);
  }

  const result = await deductCredits(partnerId, costCents, description);
  return c.json(result);
});
```

- [ ] **Step 2: Commit**

```bash
cd ~/breeze-billing
git add src/routes/internal.ts
git commit -m "feat: internal credit check and deduct API endpoints"
```

---

### Task 5: User-Facing Credit Routes (Billing Portal API)

**Files:**
- Create: `~/breeze-billing/src/routes/credits.ts`

- [ ] **Step 1: Create the credits routes**

```typescript
import { Hono } from 'hono';
import { jwtAuth } from '../middleware/auth.js';
import { getStripe } from '../config/stripe.js';
import { getConfig } from '../config/validate.js';
import {
  checkCredits,
  getTransactions,
  getCreditPacks,
  isValidPack,
  getOrCreateBalance,
} from '../services/creditService.js';

export const creditRoutes = new Hono();

creditRoutes.use('*', jwtAuth);

// GET /billing/api/credits/balance
creditRoutes.get('/balance', async (c) => {
  const payload = (c as any).get('jwtPayload') as { partnerId?: string };
  if (!payload?.partnerId) {
    return c.json({ error: 'Missing partnerId in token' }, 400);
  }

  const config = getConfig();
  const result = await checkCredits(payload.partnerId);
  const balance = await getOrCreateBalance(payload.partnerId);

  return c.json({
    includedBalance: result.includedBalance,
    purchasedBalance: result.purchasedBalance,
    totalRemaining: result.remainingCredits,
    includedTotal: config.AI_CREDITS_PER_MONTH,
    plan: result.plan,
    resetDate: balance.lastResetAt,
    allowed: result.allowed,
  });
});

// GET /billing/api/credits/transactions?limit=50
creditRoutes.get('/transactions', async (c) => {
  const payload = (c as any).get('jwtPayload') as { partnerId?: string };
  if (!payload?.partnerId) {
    return c.json({ error: 'Missing partnerId in token' }, 400);
  }

  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const transactions = await getTransactions(payload.partnerId, Math.min(limit, 200));
  return c.json({ transactions });
});

// GET /billing/api/credits/packs — available purchase packs
creditRoutes.get('/packs', async (c) => {
  const config = getConfig();
  const packs = getCreditPacks();
  return c.json({
    packs: Object.entries(packs).map(([id, p]) => ({
      id,
      credits: p.credits,
      priceCents: p.priceCents,
      currencySymbol: config.AI_CREDITS_CURRENCY_SYMBOL,
      locale: config.AI_CREDITS_LOCALE,
    })),
  });
});

// POST /billing/api/credits/purchase — buy a credit pack
creditRoutes.post('/purchase', async (c) => {
  const payload = (c as any).get('jwtPayload') as { partnerId?: string };
  if (!payload?.partnerId) {
    return c.json({ error: 'Missing partnerId in token' }, 400);
  }

  const { pack } = await c.req.json<{ pack: string }>();
  if (!pack || !isValidPack(pack)) {
    return c.json({ error: `Invalid pack. Must be one of: small, medium, large` }, 400);
  }

  const packs = getCreditPacks();
  const selected = packs[pack];
  const config = getConfig();
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: selected.priceCents,
        product_data: {
          name: `${selected.credits.toLocaleString()} AI Credits`,
          description: `Top-up pack for Breeze AI assistant`,
        },
      },
      quantity: 1,
    }],
    metadata: {
      type: 'credit_purchase',
      breeze_partner_id: payload.partnerId,
      pack,
      credits: String(selected.credits),
    },
    success_url: `${config.APP_BASE_URL}/billing/credits?result=success`,
    cancel_url: `${config.APP_BASE_URL}/billing/credits?result=canceled`,
  });

  return c.json({ url: session.url });
});
```

- [ ] **Step 2: Mount the route in index.ts**

Add import at top of `~/breeze-billing/src/index.ts`:

```typescript
import { creditRoutes } from './routes/credits.js';
```

Add route mounting after the existing `app.route('/billing/api/checkout', checkoutRoutes);` line:

```typescript
app.route('/billing/api/credits', creditRoutes);
```

- [ ] **Step 3: Commit**

```bash
cd ~/breeze-billing
git add src/routes/credits.ts src/index.ts
git commit -m "feat: user-facing credit routes — balance, transactions, purchase"
```

---

### Task 6: Stripe Webhook for Credit Purchases

**Files:**
- Modify: `~/breeze-billing/src/routes/stripeWebhooks.ts`

- [ ] **Step 1: Add credit purchase handling to checkout.session.completed**

Add import at top of `stripeWebhooks.ts`:

```typescript
import { addPurchasedCredits, isValidPack, getCreditPacks } from '../services/creditService.js';
```

In the `checkout.session.completed` handler, add this block **before** the existing subscription logic (the `if (session.mode === 'subscription')` block):

```typescript
    // Handle credit pack purchases
    if (session.metadata?.type === 'credit_purchase') {
      const partnerId = session.metadata.breeze_partner_id;
      const pack = session.metadata.pack;
      const credits = parseInt(session.metadata.credits ?? '0', 10);

      if (!partnerId || !credits) {
        console.error('[Webhook] credit_purchase missing partnerId or credits');
        return c.json({ received: true });
      }

      await addPurchasedCredits(
        partnerId,
        credits,
        session.payment_intent as string ?? session.id,
        `Purchased ${credits.toLocaleString()} credit pack`
      );

      await logEvent(partnerId, event);
      console.log(`[Webhook] Added ${credits} credits for partner ${partnerId}`);
      return c.json({ received: true });
    }
```

- [ ] **Step 2: Commit**

```bash
cd ~/breeze-billing
git add src/routes/stripeWebhooks.ts
git commit -m "feat: handle credit purchase webhook"
```

---

### Task 7: Monthly Credit Reset Job

**Files:**
- Create: `~/breeze-billing/src/jobs/creditReset.ts`
- Modify: `~/breeze-billing/src/index.ts`

- [ ] **Step 1: Create the reset job**

```typescript
import { getDb } from '../db/index.js';
import { billingCreditBalances } from '../db/schema/billing.js';
import { billingSubscriptions } from '../db/schema/billing.js';
import { partners } from '../db/schema/breeze.js';
import { eq, and, isNotNull, lte } from 'drizzle-orm';
import { resetIncludedCredits } from '../services/creditService.js';

/**
 * Resets included credit balances for partners whose billing cycle has renewed.
 * Runs daily at 1:00 AM. Checks if current_period_end has passed since last reset.
 */
export async function resetMonthlyCredits(): Promise<void> {
  const db = getDb();
  const now = new Date();

  // Find all community+ partners with active subscriptions
  // whose last credit reset is before their current period start
  const eligibleBalances = await db
    .select({
      partnerId: billingCreditBalances.partnerId,
      lastResetAt: billingCreditBalances.lastResetAt,
      periodStart: billingSubscriptions.currentPeriodStart,
    })
    .from(billingCreditBalances)
    .innerJoin(
      billingSubscriptions,
      eq(billingCreditBalances.partnerId, billingSubscriptions.partnerId)
    )
    .innerJoin(
      partners,
      eq(billingCreditBalances.partnerId, partners.id)
    )
    .where(
      and(
        eq(partners.plan, 'community'),
        isNotNull(billingSubscriptions.currentPeriodStart)
      )
    );

  let resetCount = 0;
  for (const row of eligibleBalances) {
    if (row.periodStart && row.lastResetAt < row.periodStart) {
      try {
        await resetIncludedCredits(row.partnerId);
        resetCount++;
      } catch (err) {
        console.error(`[CreditReset] Failed for partner ${row.partnerId}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (resetCount > 0) {
    console.log(`[CreditReset] Reset credits for ${resetCount} partners`);
  }
}
```

- [ ] **Step 2: Add the cron job to index.ts**

Add import at top of `~/breeze-billing/src/index.ts`:

```typescript
import { resetMonthlyCredits } from './jobs/creditReset.js';
```

Add this cron job after the existing `staleAccountCleanup` cron (before the server start):

```typescript
cron.schedule('0 1 * * *', async () => {
  console.log('[Cron] Running monthly credit reset...');
  await resetMonthlyCredits().catch((err) => {
    console.error('[Cron] creditReset failed:', err instanceof Error ? err.message : err);
  });
});
```

- [ ] **Step 3: Commit**

```bash
cd ~/breeze-billing
git add src/jobs/creditReset.ts src/index.ts
git commit -m "feat: daily cron for monthly credit reset"
```

---

### Task 8: Breeze Core Integration — Credit Check & Deduct

**Files:**
- Modify: `~/breeze/apps/api/src/services/aiCostTracker.ts`

- [ ] **Step 1: Add billing service credit check to checkBudget**

Add this helper function near the top of `aiCostTracker.ts` (after the imports):

```typescript
async function checkBillingCredits(orgId: string): Promise<string | null> {
  const billingUrl = process.env.BILLING_SERVICE_URL;
  const billingKey = process.env.BILLING_SERVICE_API_KEY;
  if (!billingUrl || !billingKey) return null; // No billing service configured — skip credit check

  // Resolve partnerId from org
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org?.partnerId) return null;

  try {
    const res = await fetch(`${billingUrl}/api/internal/partners/${org.partnerId}/ai-credits`, {
      headers: { 'Authorization': `Bearer ${billingKey}` },
    });

    if (!res.ok) return null; // Fail open if billing service is down

    const data = await res.json() as { allowed: boolean; remainingCredits: number; plan: string };

    if (!data.allowed) {
      if (['free', 'starter'].includes(data.plan)) {
        return 'AI assistant requires the Community plan.';
      }
      return 'You are out of AI credits. Purchase more credits to continue.';
    }

    return null; // Allowed
  } catch {
    return null; // Fail open
  }
}
```

- [ ] **Step 2: Call credit check inside checkBudget**

In the existing `checkBudget` function, add the billing credit check **before** the existing budget logic. Add this at the start of the function body (after the function signature):

```typescript
  // Check billing service credits first (if configured)
  const creditError = await checkBillingCredits(orgId);
  if (creditError) return creditError;
```

- [ ] **Step 3: Add credit deduction after AI message**

Add this helper function near `checkBillingCredits`:

```typescript
async function deductBillingCredits(orgId: string, costCents: number): Promise<void> {
  const billingUrl = process.env.BILLING_SERVICE_URL;
  const billingKey = process.env.BILLING_SERVICE_API_KEY;
  if (!billingUrl || !billingKey) return;

  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org?.partnerId) return;

  try {
    await fetch(`${billingUrl}/api/internal/partners/${org.partnerId}/ai-credits/deduct`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${billingKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ costCents }),
    });
  } catch (err) {
    console.error('[AI] Failed to deduct billing credits:', err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 4: Call deduction in recordUsageFromSdkResult**

In the `recordUsageFromSdkResult` function, add this line **after** the existing cost recording logic (after the daily/monthly upsert blocks):

```typescript
  // Deduct billing credits (if billing service configured)
  await deductBillingCredits(orgId, costCents);
```

- [ ] **Step 5: Ensure organizations import exists**

Verify that `organizations` is imported from the schema. If not, add to the imports at the top:

```typescript
import { organizations } from '../db/schema';
```

- [ ] **Step 6: Commit**

```bash
cd ~/breeze
git add apps/api/src/services/aiCostTracker.ts
git commit -m "feat: integrate billing credit check and deduct into AI cost tracker"
```

---

### Task 9: Billing Portal UI — Credits Page

**Files:**
- Modify: `~/breeze-billing/ui/src/lib/types.ts`
- Create: `~/breeze-billing/ui/src/pages/Credits.tsx`
- Modify: `~/breeze-billing/ui/src/App.tsx`

- [ ] **Step 1: Add credit types**

Add to the end of `~/breeze-billing/ui/src/lib/types.ts`:

```typescript
export interface CreditBalance {
  includedBalance: number;
  purchasedBalance: number;
  totalRemaining: number;
  includedTotal: number;
  plan: string;
  resetDate: string;
  allowed: boolean;
}

export interface CreditTransaction {
  id: string;
  amount: number;
  type: 'usage' | 'purchase' | 'monthly_reset';
  balanceAfter: number;
  description: string | null;
  createdAt: string;
}

export interface CreditPack {
  id: string;
  credits: number;
  priceCents: number;
  currencySymbol: string;
  locale: string;
}
```

- [ ] **Step 2: Create Credits page**

```typescript
import { useEffect, useState } from 'react';
import { Coins, Plus, ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import type { CreditBalance, CreditTransaction, CreditPack } from '@/lib/types';

export function Credits() {
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const params = new URLSearchParams(window.location.search);
  const purchaseResult = params.get('result');

  useEffect(() => {
    async function load() {
      try {
        const [b, t, p] = await Promise.all([
          apiFetch<CreditBalance>('/credits/balance'),
          apiFetch<{ transactions: CreditTransaction[] }>('/credits/transactions'),
          apiFetch<{ packs: CreditPack[] }>('/credits/packs'),
        ]);
        setBalance(b);
        setTransactions(t.transactions);
        setPacks(p.packs);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load credits');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const buyPack = async (packId: string) => {
    setPurchasing(true);
    setError(null);
    try {
      const { url } = await apiFetch<{ url: string }>('/credits/purchase', {
        method: 'POST',
        body: JSON.stringify({ pack: packId }),
      });
      if (url) window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start purchase');
    } finally {
      setPurchasing(false);
    }
  };

  if (loading) return <div className="text-center py-12 text-muted-foreground">Loading...</div>;

  const usedIncluded = balance ? balance.includedTotal - balance.includedBalance : 0;
  const usagePercent = balance ? Math.round((usedIncluded / balance.includedTotal) * 100) : 0;

  return (
    <div className="space-y-6">
      {purchaseResult === 'success' && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 text-sm text-green-700 dark:text-green-400">
          Credits added successfully!
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/5 p-4 text-sm text-destructive">{error}</div>
      )}

      {/* Balance Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Coins className="h-4 w-4" />
            Total Credits
          </div>
          <p className="text-3xl font-bold">{balance?.totalRemaining.toLocaleString() ?? 0}</p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <div className="text-sm text-muted-foreground mb-1">Monthly Included</div>
          <p className="text-2xl font-semibold">{balance?.includedBalance.toLocaleString() ?? 0} <span className="text-sm font-normal text-muted-foreground">/ {balance?.includedTotal.toLocaleString()}</span></p>
          <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(usagePercent, 100)}%` }} />
          </div>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <div className="text-sm text-muted-foreground mb-1">Purchased (never expire)</div>
          <p className="text-2xl font-semibold">{balance?.purchasedBalance.toLocaleString() ?? 0}</p>
        </div>
      </div>

      {/* Buy Packs */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Buy More Credits</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {packs.map((pack) => (
            <div key={pack.id} className="rounded-lg border bg-card p-6 flex flex-col">
              <p className="font-semibold text-lg">{pack.credits.toLocaleString()} credits</p>
              <p className="text-2xl font-bold mt-1">
                {pack.currencySymbol}{(pack.priceCents / 100).toFixed(0)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {pack.currencySymbol}{(pack.priceCents / pack.credits).toFixed(3)}/credit
              </p>
              <button
                onClick={() => buyPack(pack.id)}
                disabled={purchasing}
                className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <Plus className="inline h-4 w-4 mr-1" />
                {purchasing ? 'Processing...' : 'Buy'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Transaction History */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Transaction History</h2>
        {transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transactions yet.</p>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-left font-medium">Description</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id} className="border-t">
                    <td className="px-4 py-2">{new Date(tx.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-2">
                      {tx.type === 'usage' && <ArrowDown className="inline h-3 w-3 text-red-500 mr-1" />}
                      {tx.type === 'purchase' && <ArrowUp className="inline h-3 w-3 text-green-500 mr-1" />}
                      {tx.type === 'monthly_reset' && <RotateCcw className="inline h-3 w-3 text-blue-500 mr-1" />}
                      {tx.type}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{tx.description}</td>
                    <td className={`px-4 py-2 text-right font-medium ${tx.amount < 0 ? 'text-red-500' : 'text-green-500'}`}>
                      {tx.amount > 0 ? '+' : ''}{tx.amount.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right">{tx.balanceAfter.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add route to App.tsx**

Add import at top of `~/breeze-billing/ui/src/App.tsx`:

```typescript
import { Credits } from '@/pages/Credits';
```

Add route inside `<Routes>` after the invoices route:

```typescript
<Route path="/credits" element={<Credits />} />
```

- [ ] **Step 4: Add Credits nav link to Layout**

In `~/breeze-billing/ui/src/components/Layout.tsx`, add a Credits nav link after the Invoices link, following the same pattern (import `Coins` from lucide-react):

```typescript
<NavLink to="/credits" ...>
  <Coins className="h-4 w-4" />
  Credits
</NavLink>
```

- [ ] **Step 5: Commit**

```bash
cd ~/breeze-billing
git add ui/src/lib/types.ts ui/src/pages/Credits.tsx ui/src/App.tsx ui/src/components/Layout.tsx
git commit -m "feat: credits page — balance, packs, transaction history"
```

---

### Task 10: Email Notifications — Low & Empty Credits

**Files:**
- Create: `~/breeze-billing/src/templates/creditsLow.ts`
- Create: `~/breeze-billing/src/templates/creditsEmpty.ts`
- Modify: `~/breeze-billing/src/services/creditService.ts`

- [ ] **Step 1: Create low credits email template**

```typescript
import { baseTemplate } from './base.js';

export function creditsLowEmail(partnerName: string, used: number, total: number, buyUrl: string): string {
  return baseTemplate(`
    <h2>AI Credits Running Low</h2>
    <p>Hi ${partnerName},</p>
    <p>You've used <strong>${used.toLocaleString()}</strong> of your <strong>${total.toLocaleString()}</strong> included AI credits this month.</p>
    <p>To avoid interruption, you can purchase additional credits anytime.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${buyUrl}" style="background:#3b82f6;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:500">Buy More Credits</a>
    </p>
  `);
}
```

- [ ] **Step 2: Create empty credits email template**

```typescript
import { baseTemplate } from './base.js';

export function creditsEmptyEmail(partnerName: string, purchasedRemaining: number, buyUrl: string): string {
  const extra = purchasedRemaining > 0
    ? `<p>You still have <strong>${purchasedRemaining.toLocaleString()}</strong> purchased credits remaining.</p>`
    : `<p>Purchase more credits to keep using the AI assistant.</p>`;

  return baseTemplate(`
    <h2>Monthly AI Credits Used Up</h2>
    <p>Hi ${partnerName},</p>
    <p>Your included monthly AI credits have been used up.</p>
    ${extra}
    <p style="text-align:center;margin:24px 0">
      <a href="${buyUrl}" style="background:#3b82f6;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:500">Buy More Credits</a>
    </p>
  `);
}
```

- [ ] **Step 3: Add notification triggers to deductCredits**

In `~/breeze-billing/src/services/creditService.ts`, add imports at the top:

```typescript
import { sendEmail } from './email.js';
import { creditsLowEmail } from '../templates/creditsLow.js';
import { creditsEmptyEmail } from '../templates/creditsEmpty.js';
```

Add this block at the end of the `deductCredits` function, before the `return` statement:

```typescript
  // Send notifications at thresholds
  const config = getConfig();
  const includedTotal = config.AI_CREDITS_PER_MONTH;

  // Get partner info for emails
  const [partner] = await db
    .select({ name: partners.name, email: partners.billingEmail })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (partner?.email) {
    const buyUrl = `${config.APP_BASE_URL}/billing/credits`;
    const usedIncluded = includedTotal - Math.max(0, (result?.remaining ?? 0) - (await getOrCreateBalance(partnerId)).purchasedBalance);

    // 80% threshold — check if we just crossed it
    const threshold80 = Math.floor(includedTotal * 0.8);
    if (usedIncluded >= threshold80 && usedIncluded - creditsDeducted < threshold80) {
      sendEmail(partner.email, 'AI Credits Running Low', creditsLowEmail(partner.name, usedIncluded, includedTotal, buyUrl))
        .catch((err) => console.error('[Credits] Failed to send low credits email:', err instanceof Error ? err.message : String(err)));
    }

    // 100% included used
    if (usedIncluded >= includedTotal && usedIncluded - creditsDeducted < includedTotal) {
      const balance = await getOrCreateBalance(partnerId);
      sendEmail(partner.email, 'Monthly AI Credits Used Up', creditsEmptyEmail(partner.name, balance.purchasedBalance, buyUrl))
        .catch((err) => console.error('[Credits] Failed to send empty credits email:', err instanceof Error ? err.message : String(err)));
    }
  }
```

- [ ] **Step 4: Commit**

```bash
cd ~/breeze-billing
git add src/templates/creditsLow.ts src/templates/creditsEmpty.ts src/services/creditService.ts
git commit -m "feat: email notifications at 80% and 100% credit usage"
```

---

### Task 11: Deploy to EU

**Files:** None (deployment commands)

- [ ] **Step 1: Create credit tables on managed DB**

Run the SQL from Task 1 Step 2.

- [ ] **Step 2: Push billing service and rebuild**

```bash
cd ~/breeze-billing
git push origin main
ssh root@164.90.237.99 "cd /opt/breeze-billing && git pull && cd /opt/breeze && docker compose build --no-cache billing && docker compose up -d billing"
```

- [ ] **Step 3: Push Breeze core and patch API**

```bash
cd ~/breeze
git push origin main
# Patch the running API container (same process as before — extract index.cjs, patch, restart)
# OR tag a new release to get new GHCR images
```

- [ ] **Step 4: Smoke test**

```bash
# Check credit balance endpoint
curl -s https://eu.2breeze.app/billing/api/credits/packs | python3 -m json.tool

# Check internal credit endpoint (with API key)
curl -s -H "Authorization: Bearer $BILLING_API_KEY" \
  https://eu.2breeze.app/billing/api/internal/partners/<PARTNER_ID>/ai-credits | python3 -m json.tool
```

- [ ] **Step 5: Test purchase flow in browser**

Navigate to `https://eu.2breeze.app/billing/credits`, verify balance display, buy a small pack, verify credits added.

# Stripe Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let MSP partners authorize their own Stripe account and collect online card payment from their clients for invoices the engine produces, reconciling captured payments and reflected refunds back into the existing `invoice_payments` table.

**Architecture:** Stripe Connect **Standard** accounts via OAuth; **direct charges** on the connected account (`Stripe-Account: acct_xxx`); **no platform fee** (Breeze never holds funds). Clients pay through **Stripe Hosted Checkout** (redirect) from the customer portal. A signature-verified webhook reconciles into `invoice_payments` via the engine's single `recomputeInvoiceStatus()` path. Refunds are **reflect-only** (`charge.refunded`). The Stripe↔invoice link lives only in a mapping table — never a `stripe_*` column on core tables.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL (RLS as `breeze_app`), BullMQ/Redis, Vitest, `stripe@^22` (already installed).

**Spec:** `docs/superpowers/specs/billing/2026-06-15-stripe-payments-design.md`

**Working conventions for this repo (read once):**
- Node is pinned: prefix test/build commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- **Unit** tests (`test-api` job, **no** DATABASE_URL): `pnpm --filter @breeze/api exec vitest run <path>`.
- **Real-DB** tests MUST live in `apps/api/src/__tests__/integration/*.integration.test.ts` (the BLOCKING `Integration Tests` job; `breeze_app`; autoMigrate + TRUNCATE-per-test). Run locally with a real `DATABASE_URL`: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <path>`.
- Never edit a shipped migration; fix forward. Migrations are idempotent and wrapped in a transaction by the runner (no inner `BEGIN;`).
- Every tenant-scoped table: RLS enabled+forced+policies **in the creating migration**, allowlist entry in `rls-coverage.integration.test.ts`, and a functional `breeze_app` forge test — same PR.

---

## File Structure

**New files**
- `apps/api/src/db/schema/stripePayments.ts` — `stripeConnectAccounts` + `invoiceStripePayments` tables and enums.
- `apps/api/migrations/2026-06-16-stripe-payments.sql` — tables + RLS (idempotent). *(Use the next free `2026-06-NN` date at implementation time; it MUST sort after `2026-06-15-a-invoice-engine.sql` and the recurring-contracts migration. Verify with `autoMigrate.test.ts`.)*
- `apps/api/src/services/stripeClient.ts` — Stripe SDK factory (platform + connected-account clients).
- `apps/api/src/services/stripeConnectService.ts` — OAuth start/callback/status/deauthorize.
- `apps/api/src/services/stripeReconcile.ts` — `recordStripePayment` + `reflectStripeRefund` (system-context engine writes).
- `apps/api/src/services/stripeWebhook.ts` — verify + dispatch handlers.
- `apps/api/src/routes/stripeConnect/index.ts` — authed partner routes.
- `apps/api/src/routes/webhooks/stripe.ts` — unauthed, signature-verified webhook.
- Tests alongside each, plus `apps/api/src/__tests__/integration/stripe-payments-rls.integration.test.ts`.

**Modified files**
- `apps/api/src/db/schema/index.ts` — `export * from './stripePayments';`
- `apps/api/src/services/invoiceEvents.ts` — add `payment.failed` event type.
- `apps/api/src/services/encryptedColumnRegistry.ts` — register `stripe_connect_accounts.credentials`.
- `apps/api/src/config/validate.ts` — optional `STRIPE_*` env vars.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist both tables.
- `apps/api/src/services/tenantCascade.ts` + `apps/api/src/services/devices/core.ts` — cascade lists.
- `apps/api/src/routes/portal/invoices.ts` + `apps/api/src/routes/portal/index.ts` — portal `pay` route.
- `apps/api/src/index.ts` — mount stripe-connect (authed) + stripe webhook (unauthed).
- `apps/web/...` — partner billing-settings "Connect Stripe" control (Task 15).

---

## Phase A — Schema, migration, RLS

### Task 1: Drizzle schema for the two tables

**Files:**
- Create: `apps/api/src/db/schema/stripePayments.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Write the schema file**

```typescript
// apps/api/src/db/schema/stripePayments.ts
import {
  pgTable, uuid, text, varchar, boolean, numeric, jsonb, timestamp, char, pgEnum,
  index, uniqueIndex
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import { invoices, invoicePayments } from './invoices';

export const stripeConnectStatusEnum = pgEnum('stripe_connect_status', [
  'connected', 'disconnected'
]);

export const stripePaymentObjectTypeEnum = pgEnum('stripe_payment_object_type', [
  'checkout_session', 'payment_intent', 'charge'
]);

export const stripePaymentStatusEnum = pgEnum('stripe_payment_status', [
  'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'
]);

// Partner-axis (RLS shape 3). One connected Stripe account per partner.
export const stripeConnectAccounts = pgTable('stripe_connect_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  stripeAccountId: text('stripe_account_id').notNull(),
  // encrypted via secretCrypto; used only for deauthorize. Charges use platform key + Stripe-Account header.
  credentials: jsonb('credentials'),
  livemode: boolean('livemode').notNull().default(false),
  status: stripeConnectStatusEnum('status').notNull().default('connected'),
  scope: varchar('scope', { length: 50 }),
  connectedBy: uuid('connected_by').references(() => users.id),
  connectedAt: timestamp('connected_at').defaultNow().notNull(),
  disconnectedAt: timestamp('disconnected_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('stripe_connect_accounts_partner_uq').on(t.partnerId),
  uniqueIndex('stripe_connect_accounts_acct_uq').on(t.stripeAccountId)
]);

// Org-axis (RLS shape 1, direct org_id). Maps a Stripe object to the recorded payment row.
export const invoiceStripePayments = pgTable('invoice_stripe_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  invoicePaymentId: uuid('invoice_payment_id').references(() => invoicePayments.id, { onDelete: 'set null' }),
  stripeAccountId: text('stripe_account_id').notNull(),
  stripeObjectType: stripePaymentObjectTypeEnum('stripe_object_type').notNull(),
  stripeObjectId: text('stripe_object_id').notNull(),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  status: stripePaymentStatusEnum('status').notNull().default('pending'),
  lastEventAt: timestamp('last_event_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('invoice_stripe_payments_object_uq').on(t.stripeObjectId),
  index('invoice_stripe_payments_invoice_idx').on(t.invoiceId),
  index('invoice_stripe_payments_org_idx').on(t.orgId),
  index('invoice_stripe_payments_pi_idx').on(t.stripePaymentIntentId)
]);
```

- [ ] **Step 2: Re-export from the schema barrel**

Add to `apps/api/src/db/schema/index.ts` (next to the other `export *` lines, e.g. after `export * from './invoices';`):

```typescript
export * from './stripePayments';
```

- [ ] **Step 3: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS (no new errors referencing `stripePayments.ts`). Pre-existing errors in `agents.test.ts`/`apiKeyAuth.test.ts` are known and unrelated.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/stripePayments.ts apps/api/src/db/schema/index.ts
git commit -m "feat(billing): stripe payments schema — connect accounts + payment mapping tables"
```

---

### Task 2: Migration with RLS policies

**Files:**
- Create: `apps/api/migrations/2026-06-16-stripe-payments.sql`

- [ ] **Step 1: Write the migration (idempotent, no inner BEGIN/COMMIT)**

```sql
-- apps/api/migrations/2026-06-16-stripe-payments.sql
-- Stripe Payments (billing sub-project 4): connected accounts + payment mapping.

-- ── enums ──────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE stripe_connect_status AS ENUM ('connected', 'disconnected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stripe_payment_object_type AS ENUM ('checkout_session', 'payment_intent', 'charge');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stripe_payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── stripe_connect_accounts (partner-axis, RLS shape 3) ──────────────────────
CREATE TABLE IF NOT EXISTS stripe_connect_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  stripe_account_id TEXT NOT NULL,
  credentials JSONB,
  livemode BOOLEAN NOT NULL DEFAULT FALSE,
  status stripe_connect_status NOT NULL DEFAULT 'connected',
  scope VARCHAR(50),
  connected_by UUID REFERENCES users(id),
  connected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_accounts_partner_uq ON stripe_connect_accounts (partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_accounts_acct_uq ON stripe_connect_accounts (stripe_account_id);

ALTER TABLE stripe_connect_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_accounts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY stripe_connect_accounts_partner_access ON stripe_connect_accounts
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── invoice_stripe_payments (org-axis, RLS shape 1) ──────────────────────────
CREATE TABLE IF NOT EXISTS invoice_stripe_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_payment_id UUID REFERENCES invoice_payments(id) ON DELETE SET NULL,
  stripe_account_id TEXT NOT NULL,
  stripe_object_type stripe_payment_object_type NOT NULL,
  stripe_object_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  amount NUMERIC(12,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  status stripe_payment_status NOT NULL DEFAULT 'pending',
  last_event_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_stripe_payments_object_uq ON invoice_stripe_payments (stripe_object_id);
CREATE INDEX IF NOT EXISTS invoice_stripe_payments_invoice_idx ON invoice_stripe_payments (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_stripe_payments_org_idx ON invoice_stripe_payments (org_id);
CREATE INDEX IF NOT EXISTS invoice_stripe_payments_pi_idx ON invoice_stripe_payments (stripe_payment_intent_id);

ALTER TABLE invoice_stripe_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_stripe_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_stripe_payments;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_stripe_payments;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_stripe_payments;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_stripe_payments;
CREATE POLICY breeze_org_isolation_select ON invoice_stripe_payments
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_stripe_payments
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_stripe_payments
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_stripe_payments
  FOR DELETE USING (public.breeze_has_org_access(org_id));
```

- [ ] **Step 2: Apply migration locally + check drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsx src/db/autoMigrate.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```
Expected: migration applies cleanly; drift check reports no drift between schema and migrations.

- [ ] **Step 3: Verify isolation as `breeze_app` (manual forge)**

Run:
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c \
"INSERT INTO invoice_stripe_payments (org_id, invoice_id, stripe_account_id, stripe_object_type, stripe_object_id, amount, currency) \
 VALUES (gen_random_uuid(), gen_random_uuid(), 'acct_x', 'payment_intent', 'pi_forge', 1, 'USD');"
```
Expected: `ERROR: new row violates row-level security policy for table "invoice_stripe_payments"`.

- [ ] **Step 4: Confirm migration ordering regression test passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts`
Expected: PASS (filename sorts correctly after invoice-engine + contracts migrations).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-16-stripe-payments.sql
git commit -m "feat(billing): stripe payments migration — tables + RLS policies"
```

---

### Task 3: RLS-coverage allowlist + cascade lists

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/services/devices/core.ts`

- [ ] **Step 1: Add the partner-axis table to `PARTNER_TENANT_TABLES`**

In `rls-coverage.integration.test.ts`, add to the `PARTNER_TENANT_TABLES` map (alongside `catalog_items`):

```typescript
  ['stripe_connect_accounts', 'partner_id'],
```

(`invoice_stripe_payments` is org-axis with a direct `org_id` column and is auto-discovered — do **not** add it to a partner/keyed allowlist.)

- [ ] **Step 2: Add `invoice_stripe_payments` to the org-cascade order**

In `tenantCascade.ts`, find `ORG_CASCADE_DELETE_ORDER` and insert `invoice_stripe_payments` **before** `invoice_payments` and `invoices` (it FKs both). Match the existing entry style in that array. Then in `apps/api/src/services/devices/core.ts`, add `invoice_stripe_payments` to the org/device-delete table list following the existing billing entries (`invoice_payments`, `invoices`).

- [ ] **Step 3: Run the RLS-coverage contract test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts`
Expected: PASS — both new tables are covered (partner via allowlist, org via auto-discovery).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/devices/core.ts
git commit -m "feat(billing): cover stripe payments tables in RLS-coverage + org cascade"
```

---

### Task 4: Integration RLS forge tests

**Files:**
- Create: `apps/api/src/__tests__/integration/stripe-payments-rls.integration.test.ts`

- [ ] **Step 1: Write the forge tests (re-seed per test — never memoize the fixture)**

```typescript
// apps/api/src/__tests__/integration/stripe-payments-rls.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { stripeConnectAccounts, invoiceStripePayments } from '../../db/schema/stripePayments';
import { createPartner, createOrganization } from './helpers'; // mirror catalog-rls imports

function partnerCtx(partnerId: string): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [partnerId], userId: null };
}
function orgCtx(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const [acctA] = await db.insert(stripeConnectAccounts)
      .values({ partnerId: partnerA.id, stripeAccountId: `acct_${partnerA.id.slice(0, 8)}`, livemode: false })
      .returning();
    return { partnerA, orgA, partnerB, orgB, acctA };
  });
}

describe('stripe_connect_accounts RLS (breeze_app)', () => {
  it('partner B cannot read partner A connected account', async () => {
    const { acctA, partnerB } = await seed();
    const rows = await withDbAccessContext(partnerCtx(partnerB.id), () =>
      db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.id, acctA.id)));
    expect(rows).toHaveLength(0);
  });

  it('forged cross-partner insert is rejected', async () => {
    const { partnerA, partnerB } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(stripeConnectAccounts).values({
          partnerId: partnerA.id, // forged
          stripeAccountId: 'acct_forge', livemode: false
        }))
    ).rejects.toThrow(/violates row-level security policy/);
  });

  it('system scope can seed (existence probe — not vacuous)', async () => {
    const { acctA } = await seed();
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.id, acctA.id)));
    expect(rows).toHaveLength(1);
  });
});

describe('invoice_stripe_payments RLS (breeze_app)', () => {
  it('forged cross-org insert is rejected', async () => {
    const { orgA, orgB } = await seed();
    await expect(
      withDbAccessContext(orgCtx(orgB.id), () =>
        db.insert(invoiceStripePayments).values({
          orgId: orgA.id, // forged
          invoiceId: orgA.id, stripeAccountId: 'acct_x', stripeObjectType: 'payment_intent',
          stripeObjectId: 'pi_forge', amount: '1.00', currency: 'USD'
        }))
    ).rejects.toThrow(/violates row-level security policy/);
  });
});
```

> If `./helpers` does not export `createPartner`/`createOrganization`, copy the exact seed helpers used by `catalog-rls.integration.test.ts` (same directory) — match that file's imports verbatim.

- [ ] **Step 2: Run the forge tests against a real DB**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/stripe-payments-rls.integration.test.ts`
Expected: PASS — cross-tenant forges throw, system seed succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/stripe-payments-rls.integration.test.ts
git commit -m "test(billing): RLS forge tests for stripe payments tables"
```

---

## Phase B — Config & Stripe client

### Task 5: Optional STRIPE_* env vars

**Files:**
- Modify: `apps/api/src/config/validate.ts`
- Test: `apps/api/src/config/validate.test.ts`

- [ ] **Step 1: Write a failing test asserting the keys are accepted and optional**

Add to `validate.test.ts`:

```typescript
it('accepts optional Stripe Connect env vars', () => {
  const parsed = configSchema.parse({
    ...minimalValidEnv, // reuse the existing helper/base object in this file
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_CONNECT_CLIENT_ID: 'ca_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_x',
    STRIPE_OAUTH_REDIRECT_URL: 'https://app.example.com/partner/stripe/callback'
  });
  expect(parsed.STRIPE_SECRET_KEY).toBe('sk_test_x');
});

it('boots without any Stripe env (feature dormant)', () => {
  expect(() => configSchema.parse(minimalValidEnv)).not.toThrow();
});
```

> Match the existing test's schema object name (`configSchema` or the exported schema in `validate.ts`) and the base-env helper used by sibling tests.

- [ ] **Step 2: Run it to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/config/validate.test.ts`
Expected: FAIL — `STRIPE_SECRET_KEY` is stripped/undefined (key not in schema).

- [ ] **Step 3: Add the optional keys to the schema**

In `validate.ts`, add alongside the other optional integration vars:

```typescript
  // Stripe Connect payments (billing sub-project 4) — feature dormant unless set.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_OAUTH_REDIRECT_URL: z.string().optional(),
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/config/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts
git commit -m "feat(billing): optional STRIPE_* config (dormant unless set)"
```

---

### Task 6: Stripe client factory + encrypted-credentials registration

**Files:**
- Create: `apps/api/src/services/stripeClient.ts`
- Test: `apps/api/src/services/stripeClient.test.ts`
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts`

- [ ] **Step 1: Write a failing test**

```typescript
// apps/api/src/services/stripeClient.test.ts
import { describe, expect, it, vi } from 'vitest';
import { getStripe, getConnectedStripeOptions, StripeNotConfiguredError } from './stripeClient';

vi.mock('../config', () => ({ getConfig: () => ({ STRIPE_SECRET_KEY: 'sk_test_x' }) }));

describe('stripeClient', () => {
  it('returns a Stripe instance when configured', () => {
    expect(getStripe()).toBeTruthy();
  });
  it('builds connected-account request options', () => {
    expect(getConnectedStripeOptions('acct_123')).toEqual({ stripeAccount: 'acct_123' });
  });
});
```

Add a second test file or case asserting `StripeNotConfiguredError` is thrown when `STRIPE_SECRET_KEY` is absent (separate `vi.mock` returning `{}`).

- [ ] **Step 2: Run it to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the factory**

```typescript
// apps/api/src/services/stripeClient.ts
import Stripe from 'stripe';
import { getConfig } from '../config';

export class StripeNotConfiguredError extends Error {
  constructor() { super('Stripe is not configured (STRIPE_SECRET_KEY missing)'); }
}

let cached: Stripe | null = null;

/** Platform-level Stripe client. Acts on a connected account via `getConnectedStripeOptions`. */
export function getStripe(): Stripe {
  const key = getConfig().STRIPE_SECRET_KEY;
  if (!key) throw new StripeNotConfiguredError();
  if (!cached) cached = new Stripe(key, { apiVersion: '2025-03-31.basil' });
  return cached;
}

/** Request options that scope a call to the MSP's connected account (direct charges). */
export function getConnectedStripeOptions(stripeAccountId: string): Stripe.RequestOptions {
  return { stripeAccount: stripeAccountId };
}

export function isStripeConfigured(): boolean {
  return Boolean(getConfig().STRIPE_SECRET_KEY);
}
```

> Pin `apiVersion` to the version bundled with `stripe@^22` (check `node_modules/stripe/types/lib.d.ts` `LatestApiVersion`); adjust the string if tsc complains.

- [ ] **Step 4: Register the encrypted credentials column**

In `encryptedColumnRegistry.ts`, add next to the `psa_connections` entry:

```typescript
  { table: 'stripe_connect_accounts', column: 'credentials', kind: 'json', description: 'Stripe Connect OAuth token (deauthorize use)' },
```

- [ ] **Step 5: Run tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeClient.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/stripeClient.ts apps/api/src/services/stripeClient.test.ts apps/api/src/services/encryptedColumnRegistry.ts
git commit -m "feat(billing): stripe client factory + register connect-account credential encryption"
```

---

## Phase C — Connect onboarding

### Task 7: `stripeConnectService` (OAuth + status + disconnect)

**Files:**
- Create: `apps/api/src/services/stripeConnectService.ts`
- Test: `apps/api/src/services/stripeConnectService.test.ts`

- [ ] **Step 1: Write failing tests (mock Stripe + Redis + db)**

```typescript
// apps/api/src/services/stripeConnectService.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const oauthToken = vi.fn();
const oauthDeauthorize = vi.fn();
vi.mock('./stripeClient', () => ({
  getStripe: () => ({ oauth: { token: oauthToken, deauthorize: oauthDeauthorize } }),
  isStripeConfigured: () => true
}));
vi.mock('../config', () => ({ getConfig: () => ({
  STRIPE_CONNECT_CLIENT_ID: 'ca_test', STRIPE_OAUTH_REDIRECT_URL: 'https://app/cb'
}) }));

import { buildOAuthUrl, completeOAuth } from './stripeConnectService';

beforeEach(() => { oauthToken.mockReset(); oauthDeauthorize.mockReset(); });

describe('buildOAuthUrl', () => {
  it('includes client_id, scope, redirect_uri and the signed state', async () => {
    const { url } = await buildOAuthUrl({ partnerId: 'p1', userId: 'u1' });
    expect(url).toContain('client_id=ca_test');
    expect(url).toContain('scope=read_write');
    expect(url).toContain('redirect_uri=');
    expect(url).toContain('state=');
  });
});

describe('completeOAuth', () => {
  it('exchanges the code and returns the connected account id', async () => {
    oauthToken.mockResolvedValue({ stripe_user_id: 'acct_99', access_token: 'tok', livemode: false, scope: 'read_write' });
    const result = await completeOAuth({ code: 'ac_1', partnerId: 'p1', userId: 'u1' });
    expect(oauthToken).toHaveBeenCalledWith({ grant_type: 'authorization_code', code: 'ac_1' });
    expect(result.stripeAccountId).toBe('acct_99');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeConnectService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```typescript
// apps/api/src/services/stripeConnectService.ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { stripeConnectAccounts } from '../db/schema/stripePayments';
import { getConfig } from '../config';
import { getStripe } from './stripeClient';
import { getRedis } from './redis';
import { encryptSecret } from './secretCrypto';

const STATE_TTL_SECONDS = 600;
const STATE_PREFIX = 'stripe:oauth:state:';

function stateKey(state: string) { return `${STATE_PREFIX}${state}`; }

export async function buildOAuthUrl(input: { partnerId: string; userId: string }): Promise<{ url: string }> {
  const cfg = getConfig();
  if (!cfg.STRIPE_CONNECT_CLIENT_ID || !cfg.STRIPE_OAUTH_REDIRECT_URL) {
    throw new Error('Stripe Connect is not configured');
  }
  const state = randomBytes(24).toString('hex');
  // Bind state → partner in Redis (CSRF + partner pinning).
  await getRedis().set(stateKey(state), input.partnerId, 'EX', STATE_TTL_SECONDS);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.STRIPE_CONNECT_CLIENT_ID,
    scope: 'read_write',
    redirect_uri: cfg.STRIPE_OAUTH_REDIRECT_URL,
    state
  });
  return { url: `https://connect.stripe.com/oauth/authorize?${params.toString()}` };
}

export async function consumeState(state: string, partnerId: string): Promise<boolean> {
  const redis = getRedis();
  const stored = await redis.get(stateKey(state));
  await redis.del(stateKey(state));
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(partnerId);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function completeOAuth(input: { code: string; partnerId: string; userId: string }): Promise<{ stripeAccountId: string }> {
  const resp = await getStripe().oauth.token({ grant_type: 'authorization_code', code: input.code });
  const stripeAccountId = resp.stripe_user_id!;
  const credentials = JSON.stringify({ accessToken: encryptSecret(resp.access_token ?? null) });
  await withSystemDbAccessContext(async () => {
    await db.insert(stripeConnectAccounts).values({
      partnerId: input.partnerId,
      stripeAccountId,
      credentials: JSON.parse(credentials),
      livemode: Boolean(resp.livemode),
      status: 'connected',
      scope: resp.scope ?? 'read_write',
      connectedBy: input.userId,
      connectedAt: new Date(),
      disconnectedAt: null
    }).onConflictDoUpdate({
      target: stripeConnectAccounts.partnerId,
      set: { stripeAccountId, status: 'connected', livemode: Boolean(resp.livemode),
             connectedBy: input.userId, connectedAt: new Date(), disconnectedAt: null, updatedAt: new Date() }
    });
  });
  return { stripeAccountId };
}

export async function getConnection(partnerId: string) {
  const [row] = await db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  return row ?? null;
}

export async function disconnect(partnerId: string): Promise<void> {
  const cfg = getConfig();
  const [row] = await db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  if (!row || row.status === 'disconnected') return;
  try {
    await getStripe().oauth.deauthorize({ client_id: cfg.STRIPE_CONNECT_CLIENT_ID!, stripe_user_id: row.stripeAccountId });
  } catch { /* deauthorize is best-effort; we still mark disconnected locally */ }
  await db.update(stripeConnectAccounts)
    .set({ status: 'disconnected', disconnectedAt: new Date(), updatedAt: new Date() })
    .where(eq(stripeConnectAccounts.partnerId, partnerId));
}

/** Webhook-driven disconnect (MSP revoked from their own dashboard). System context. */
export async function markDisconnectedByAccount(stripeAccountId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.update(stripeConnectAccounts)
      .set({ status: 'disconnected', disconnectedAt: new Date(), updatedAt: new Date() })
      .where(eq(stripeConnectAccounts.stripeAccountId, stripeAccountId));
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeConnectService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/stripeConnectService.ts apps/api/src/services/stripeConnectService.test.ts
git commit -m "feat(billing): stripe connect OAuth service (authorize, exchange, status, disconnect)"
```

---

### Task 8: Partner Connect routes

**Files:**
- Create: `apps/api/src/routes/stripeConnect/index.ts`
- Test: `apps/api/src/routes/stripeConnect/index.test.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write failing route tests**

```typescript
// apps/api/src/routes/stripeConnect/index.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/stripeConnectService', () => ({
  buildOAuthUrl: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/oauth/authorize?x=1' }),
  getConnection: vi.fn().mockResolvedValue({ status: 'connected', stripeAccountId: 'acct_9', livemode: false }),
  consumeState: vi.fn().mockResolvedValue(true),
  completeOAuth: vi.fn().mockResolvedValue({ stripeAccountId: 'acct_9' }),
  disconnect: vi.fn().mockResolvedValue(undefined)
}));
// Stub auth middleware to inject a partner-scoped principal — mirror an existing route test in this repo.

import { stripeConnectRoutes } from './index';

describe('stripe-connect routes', () => {
  it('POST /oauth/start returns an authorize url', async () => {
    const res = await stripeConnectRoutes.request('/oauth/start', { method: 'POST' }, { /* injected auth */ });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: expect.stringContaining('connect.stripe.com') });
  });

  it('GET / returns connection status', async () => {
    const res = await stripeConnectRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'connected' });
  });
});
```

> Mirror auth-injection from an existing authed route test (e.g. `routes/invoices/invoices.test.ts`) so `c.get('auth')` carries `{ partnerId, userId, scope:'partner' }`.

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/stripeConnect/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes**

```typescript
// apps/api/src/routes/stripeConnect/index.ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeAuditLog } from '../../services/audit'; // match the helper used by externalServices.ts
import { buildOAuthUrl, getConnection, consumeState, completeOAuth, disconnect } from '../../services/stripeConnectService';

export const stripeConnectRoutes = new Hono();

stripeConnectRoutes.use('*', authMiddleware);

stripeConnectRoutes.post('/oauth/start',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    const { url } = await buildOAuthUrl({ partnerId: auth.partnerId, userId: auth.userId });
    return c.json({ url });
  });

// Callback is hit by Stripe's browser redirect carrying the user's session.
stripeConnectRoutes.get('/oauth/callback',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) throw new HTTPException(400, { message: 'Missing code/state' });
    if (!(await consumeState(state, auth.partnerId))) throw new HTTPException(400, { message: 'Invalid state' });
    const { stripeAccountId } = await completeOAuth({ code, partnerId: auth.partnerId, userId: auth.userId });
    await writeAuditLog({ actorType: 'user', actorId: auth.userId, action: 'stripe_connect.connected',
      partnerId: auth.partnerId, metadata: { stripeAccountId } });
    return c.json({ connected: true, stripeAccountId });
  });

stripeConnectRoutes.get('/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    const row = await getConnection(auth.partnerId);
    if (!row || row.status !== 'connected') return c.json({ status: 'disconnected' });
    return c.json({ status: 'connected', stripeAccountId: row.stripeAccountId, livemode: row.livemode });
  });

stripeConnectRoutes.delete('/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    await disconnect(auth.partnerId);
    await writeAuditLog({ actorType: 'user', actorId: auth.userId, action: 'stripe_connect.disconnected', partnerId: auth.partnerId });
    return c.json({ status: 'disconnected' });
  });
```

> Match `writeAuditLog`'s real signature in this repo (see `externalServices.ts` / `services/audit.ts`); adjust field names to compile.

- [ ] **Step 4: Mount the router (authed)**

In `apps/api/src/index.ts`, next to `api.route('/invoices', invoiceRoutes);`:

```typescript
import { stripeConnectRoutes } from './routes/stripeConnect';
// ...
api.route('/partner/stripe-connect', stripeConnectRoutes);
```

- [ ] **Step 5: Run tests + typecheck**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/stripeConnect/index.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: PASS / no new type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/stripeConnect apps/api/src/index.ts
git commit -m "feat(billing): partner stripe-connect routes (authorize/callback/status/disconnect)"
```

---

## Phase D — Recording into the engine

### Task 9: `recordStripePayment` + `payment.failed` event

**Files:**
- Create: `apps/api/src/services/stripeReconcile.ts`
- Test: `apps/api/src/services/stripeReconcile.test.ts`
- Modify: `apps/api/src/services/invoiceEvents.ts`

- [ ] **Step 1: Add the `payment.failed` event type**

In `invoiceEvents.ts`, extend the payment variant of the `InvoiceEvent` union so `type` accepts `'payment.failed'` alongside `'payment.recorded' | 'payment.voided'`. No other change.

- [ ] **Step 2: Write failing tests for `recordStripePayment` (mock db + invoiceService)**

```typescript
// apps/api/src/services/stripeReconcile.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const recompute = vi.fn();
const emit = vi.fn();
vi.mock('./invoiceService', () => ({ recomputeInvoiceStatus: recompute }));
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: emit }));
// db mock: see existing Drizzle mock pattern in invoiceService.test.ts; model insert().values().returning()
// and select().from().where() to drive the two branches below.

import { recordStripePayment } from './stripeReconcile';

beforeEach(() => { recompute.mockReset(); emit.mockReset(); });

describe('recordStripePayment', () => {
  it('inserts a card payment, links the mapping, recomputes, emits payment.recorded', async () => {
    // arrange: invoice balance 100.00, mapping row pending, no existing payment for this PI
    const res = await recordStripePayment({
      stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1',
      amount: '100.00', currency: 'USD'
    });
    expect(recompute).toHaveBeenCalledWith(res.invoiceId);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.recorded' }));
  });

  it('is idempotent: a second call for the same PI does not double-record', async () => {
    // arrange: mapping already has invoice_payment_id set
    await recordStripePayment({ stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1', amount: '100.00', currency: 'USD' });
    expect(recompute).not.toHaveBeenCalled();
  });

  it('rejects overpayment (amount > balance) without writing a payment', async () => {
    await expect(recordStripePayment({ stripeObjectId: 'cs_2', stripePaymentIntentId: 'pi_2', stripeAccountId: 'acct_1', amount: '999.00', currency: 'USD' }))
      .rejects.toThrow(/OVERPAYMENT|exceeds balance/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeReconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `recordStripePayment`**

```typescript
// apps/api/src/services/stripeReconcile.ts
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { invoices, invoicePayments } from '../db/schema/invoices';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { recomputeInvoiceStatus } from './invoiceService';
import { emitInvoiceEvent } from './invoiceEvents';

function toCents(v: string | number) { return Math.round(Number(v) * 100); }

interface CaptureInput {
  stripeObjectId: string;            // cs_… or pi_…
  stripePaymentIntentId: string;     // pi_…
  stripeAccountId: string;
  amount: string;                    // major units, e.g. "100.00"
  currency: string;
  receivedAt?: string;               // YYYY-MM-DD
}

/**
 * Reconcile a captured Stripe charge into the engine. System DB context (webhook is unauth).
 * Idempotent via the invoice_stripe_payments mapping (unique stripe_object_id) and the
 * mapping.invoice_payment_id guard. Single reconcile point: recomputeInvoiceStatus.
 */
export async function recordStripePayment(input: CaptureInput): Promise<{ invoiceId: string }> {
  return withSystemDbAccessContext(async () => {
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripeObjectId, input.stripeObjectId)).limit(1);
    if (!mapping) throw new Error(`No mapping for stripe object ${input.stripeObjectId}`);
    if (mapping.invoicePaymentId) return { invoiceId: mapping.invoiceId }; // already recorded — no-op

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, mapping.invoiceId)).limit(1);
    if (!inv) throw new Error(`Invoice ${mapping.invoiceId} not found`);
    if (inv.status === 'draft' || inv.status === 'void') {
      await markMapping(mapping.id, 'failed');
      throw new Error(`Cannot record payment on ${inv.status} invoice`);
    }
    if (toCents(input.amount) > toCents(inv.balance)) {
      await markMapping(mapping.id, 'failed');
      throw new Error('OVERPAYMENT: payment exceeds balance');
    }

    const [payment] = await db.insert(invoicePayments).values({
      invoiceId: inv.id, orgId: inv.orgId, amount: Number(input.amount).toFixed(2),
      method: 'card', reference: input.stripePaymentIntentId,
      receivedAt: input.receivedAt ?? new Date().toISOString().slice(0, 10), recordedBy: null, note: null
    }).returning();

    await db.update(invoiceStripePayments)
      .set({ invoicePaymentId: payment!.id, status: 'succeeded', stripePaymentIntentId: input.stripePaymentIntentId,
             lastEventAt: new Date(), updatedAt: new Date() })
      .where(eq(invoiceStripePayments.id, mapping.id));

    await recomputeInvoiceStatus(inv.id);
    await emitInvoiceEvent({ type: 'payment.recorded', invoiceId: inv.id, orgId: inv.orgId,
      partnerId: inv.partnerId, paymentId: payment!.id });

    const [updated] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
    if (updated?.status === 'paid') {
      await emitInvoiceEvent({ type: 'invoice.paid', invoiceId: inv.id, orgId: inv.orgId, partnerId: inv.partnerId });
    }
    return { invoiceId: inv.id };
  });
}

export async function markMapping(mappingId: string, status: 'failed' | 'refunded' | 'partially_refunded'): Promise<void> {
  await db.update(invoiceStripePayments)
    .set({ status, lastEventAt: new Date(), updatedAt: new Date() })
    .where(eq(invoiceStripePayments.id, mappingId));
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeReconcile.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/stripeReconcile.ts apps/api/src/services/stripeReconcile.test.ts apps/api/src/services/invoiceEvents.ts
git commit -m "feat(billing): recordStripePayment — idempotent system-context reconcile into invoice_payments"
```

---

### Task 10: Refund reflection

**Files:**
- Modify: `apps/api/src/services/stripeReconcile.ts`
- Test: `apps/api/src/services/stripeReconcile.test.ts`

- [ ] **Step 1: Write failing tests for full + partial reflection**

```typescript
describe('reflectStripeRefund', () => {
  it('full refund voids the linked payment and recomputes', async () => {
    // arrange: mapping with invoice_payment_id, payment.amount 100.00, refund amount_refunded 100.00
    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 10000, chargeAmountCents: 10000 });
    expect(recompute).toHaveBeenCalled();
    // payment row deleted; mapping status 'refunded'
  });

  it('partial refund reduces the payment amount and recomputes', async () => {
    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 4000, chargeAmountCents: 10000 });
    // payment.amount updated to 60.00; mapping status 'partially_refunded'
    expect(recompute).toHaveBeenCalled();
  });
});
```

Import `reflectStripeRefund` at the top of the test file.

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeReconcile.test.ts`
Expected: FAIL — `reflectStripeRefund` not exported.

- [ ] **Step 3: Implement `reflectStripeRefund`**

```typescript
// append to apps/api/src/services/stripeReconcile.ts
interface RefundInput {
  stripePaymentIntentId: string;
  amountRefundedCents: number; // cumulative refunded on the charge
  chargeAmountCents: number;   // original captured amount
}

/** Reflect a Stripe-side refund. No Breeze-initiated money movement. System context. */
export async function reflectStripeRefund(input: RefundInput): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, input.stripePaymentIntentId)).limit(1);
    if (!mapping || !mapping.invoicePaymentId) return; // nothing to reflect

    const full = input.amountRefundedCents >= input.chargeAmountCents;
    if (full) {
      // Full refund → void the payment row (mirrors voidPayment mechanics).
      await db.delete(invoicePayments).where(eq(invoicePayments.id, mapping.invoicePaymentId));
      await db.update(invoiceStripePayments)
        .set({ status: 'refunded', invoicePaymentId: null, lastEventAt: new Date(), updatedAt: new Date() })
        .where(eq(invoiceStripePayments.id, mapping.id));
    } else {
      // Partial refund → reduce the positive payment amount (stays > 0; respects the amount>0 CHECK).
      const remainingCents = input.chargeAmountCents - input.amountRefundedCents;
      await db.update(invoicePayments)
        .set({ amount: (remainingCents / 100).toFixed(2) })
        .where(eq(invoicePayments.id, mapping.invoicePaymentId));
      await db.update(invoiceStripePayments)
        .set({ status: 'partially_refunded', lastEventAt: new Date(), updatedAt: new Date() })
        .where(eq(invoiceStripePayments.id, mapping.id));
    }
    await recomputeInvoiceStatus(mapping.invoiceId);
    await emitInvoiceEvent({ type: 'payment.voided', invoiceId: mapping.invoiceId, orgId: mapping.orgId,
      partnerId: (await invoicePartnerId(mapping.invoiceId)), paymentId: mapping.invoicePaymentId ?? '' });
  });
}

async function invoicePartnerId(invoiceId: string): Promise<string> {
  const [inv] = await db.select({ partnerId: invoices.partnerId }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  return inv!.partnerId;
}
```

> If `payment.voided` requires a non-empty `paymentId`, emit it only on the full-refund branch (where the id is known) and skip the event on partial — adjust to match `InvoiceEvent`'s required fields so tsc passes.

- [ ] **Step 4: Run tests to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeReconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/stripeReconcile.ts apps/api/src/services/stripeReconcile.test.ts
git commit -m "feat(billing): reflect-only refunds — full voids, partial reduces, recompute"
```

---

## Phase E — Webhook

### Task 11: Webhook signature verification + route skeleton

**Files:**
- Create: `apps/api/src/services/stripeWebhook.ts`
- Create: `apps/api/src/routes/webhooks/stripe.ts`
- Test: `apps/api/src/services/stripeWebhook.test.ts`

- [ ] **Step 1: Write failing tests for verification**

```typescript
// apps/api/src/services/stripeWebhook.test.ts
import { describe, expect, it, vi } from 'vitest';

const constructEvent = vi.fn();
vi.mock('./stripeClient', () => ({ getStripe: () => ({ webhooks: { constructEvent } }), isStripeConfigured: () => true }));
vi.mock('../config', () => ({ getConfig: () => ({ STRIPE_WEBHOOK_SECRET: 'whsec_x' }) }));

import { verifyStripeEvent } from './stripeWebhook';

describe('verifyStripeEvent', () => {
  it('returns the event when the signature is valid', () => {
    constructEvent.mockReturnValue({ id: 'evt_1', type: 'payment_intent.succeeded', account: 'acct_1' });
    const ev = verifyStripeEvent('raw-body', 'sig-header');
    expect(ev.id).toBe('evt_1');
  });
  it('throws on an invalid signature', () => {
    constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    expect(() => verifyStripeEvent('raw-body', 'bad')).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeWebhook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement verification (delegate to Stripe SDK)**

```typescript
// apps/api/src/services/stripeWebhook.ts (part 1)
import type Stripe from 'stripe';
import { getStripe } from './stripeClient';
import { getConfig } from '../config';

export function verifyStripeEvent(rawBody: string, signatureHeader: string): Stripe.Event {
  const secret = getConfig().STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  // constructEvent enforces the t=/v1= scheme + 5-min replay tolerance.
  return getStripe().webhooks.constructEvent(rawBody, signatureHeader, secret);
}
```

- [ ] **Step 4: Implement the route skeleton (rate limit → verify → 202)**

```typescript
// apps/api/src/routes/webhooks/stripe.ts
import { Hono } from 'hono';
import { getTrustedClientIp } from '../../services/clientIp'; // match the helper used by emailWebhook
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { verifyStripeEvent } from '../../services/stripeWebhook';
import { handleStripeEvent } from '../../services/stripeWebhook';

export const stripeWebhookRoutes = new Hono();

const RATE_LIMIT = 240;
const RATE_WINDOW_SECONDS = 60;

stripeWebhookRoutes.post('/stripe/connect', async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const rate = await rateLimiter(getRedis(), `stripe-webhook:${ip}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!rate.allowed) return c.json({ error: 'Too Many Requests' }, 429);

  const sig = c.req.header('stripe-signature');
  const raw = await c.req.text(); // raw body required for signature verification
  if (!sig) return c.json({ error: 'Missing signature' }, 400);

  let event;
  try {
    event = verifyStripeEvent(raw, sig);
  } catch {
    return c.json({ error: 'Invalid signature' }, 400);
  }

  try {
    await handleStripeEvent(event);
  } catch (err) {
    console.error('[stripeWebhook] handler error', event.type, err instanceof Error ? err.message : String(err));
    // Return 500 so Stripe retries on transient errors; idempotency makes retries safe.
    return c.json({ error: 'Handler error' }, 500);
  }
  return c.json({ received: true }, 202);
});
```

> Confirm `getTrustedClientIp` import path against `emailWebhook.ts` (it may be `../../utils/...`). The raw-body read (`c.req.text()`) must happen before any body parsing; ensure no upstream middleware consumes the body for this route.

- [ ] **Step 5: Run verification tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeWebhook.test.ts`
Expected: PASS (verification tests). `handleStripeEvent` is implemented in Task 12.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/stripeWebhook.ts apps/api/src/routes/webhooks/stripe.ts apps/api/src/services/stripeWebhook.test.ts
git commit -m "feat(billing): stripe webhook signature verification + route skeleton"
```

---

### Task 12: Webhook dispatch handlers

**Files:**
- Modify: `apps/api/src/services/stripeWebhook.ts`
- Test: `apps/api/src/services/stripeWebhook.test.ts`

- [ ] **Step 1: Write failing tests for dispatch**

```typescript
const recordStripePayment = vi.fn();
const reflectStripeRefund = vi.fn();
const markDisconnectedByAccount = vi.fn();
vi.mock('./stripeReconcile', () => ({ recordStripePayment, reflectStripeRefund }));
vi.mock('./stripeConnectService', () => ({ markDisconnectedByAccount }));
// emitInvoiceEvent mock for payment.failed
const emit = vi.fn();
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: emit }));

import { handleStripeEvent } from './stripeWebhook';

describe('handleStripeEvent', () => {
  it('checkout.session.completed → records payment', async () => {
    await handleStripeEvent({ type: 'checkout.session.completed', account: 'acct_1',
      data: { object: { id: 'cs_1', payment_intent: 'pi_1', amount_total: 10000, currency: 'usd' } } } as any);
    expect(recordStripePayment).toHaveBeenCalledWith(expect.objectContaining({ stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1' }));
  });

  it('payment_intent.payment_failed → emits payment.failed, no record', async () => {
    await handleStripeEvent({ type: 'payment_intent.payment_failed', account: 'acct_1',
      data: { object: { id: 'pi_2' } } } as any);
    expect(recordStripePayment).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.failed' }));
  });

  it('charge.refunded → reflects refund', async () => {
    await handleStripeEvent({ type: 'charge.refunded', account: 'acct_1',
      data: { object: { payment_intent: 'pi_1', amount: 10000, amount_refunded: 4000 } } } as any);
    expect(reflectStripeRefund).toHaveBeenCalledWith({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 4000, chargeAmountCents: 10000 });
  });

  it('account.application.deauthorized → marks disconnected', async () => {
    await handleStripeEvent({ type: 'account.application.deauthorized', account: 'acct_1', data: { object: {} } } as any);
    expect(markDisconnectedByAccount).toHaveBeenCalledWith('acct_1');
  });

  it('ignores unrelated events', async () => {
    await handleStripeEvent({ type: 'customer.created', account: 'acct_1', data: { object: {} } } as any);
    expect(recordStripePayment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeWebhook.test.ts`
Expected: FAIL — `handleStripeEvent` not exported.

- [ ] **Step 3: Implement dispatch**

```typescript
// apps/api/src/services/stripeWebhook.ts (part 2 — append)
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { recordStripePayment, reflectStripeRefund } from './stripeReconcile';
import { markDisconnectedByAccount } from './stripeConnectService';
import { emitInvoiceEvent } from './invoiceEvents';

export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'payment_intent.succeeded': {
      const obj = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
      const isSession = event.type === 'checkout.session.completed';
      const stripeObjectId = obj.id;
      const paymentIntentId = isSession
        ? String((obj as Stripe.Checkout.Session).payment_intent ?? '')
        : (obj as Stripe.PaymentIntent).id;
      const amountCents = isSession
        ? Number((obj as Stripe.Checkout.Session).amount_total ?? 0)
        : Number((obj as Stripe.PaymentIntent).amount_received ?? 0);
      const currency = String((obj as { currency?: string }).currency ?? 'usd').toUpperCase();
      if (!paymentIntentId || amountCents <= 0) return;
      await recordStripePayment({
        stripeObjectId, stripePaymentIntentId: paymentIntentId, stripeAccountId: event.account ?? '',
        amount: (amountCents / 100).toFixed(2), currency
      });
      return;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      await withSystemDbAccessContext(async () => {
        const [m] = await db.select().from(invoiceStripePayments)
          .where(eq(invoiceStripePayments.stripePaymentIntentId, pi.id)).limit(1);
        if (m) {
          await db.update(invoiceStripePayments).set({ status: 'failed', lastEventAt: new Date(), updatedAt: new Date() })
            .where(eq(invoiceStripePayments.id, m.id));
          await emitInvoiceEvent({ type: 'payment.failed', invoiceId: m.invoiceId, orgId: m.orgId, partnerId: '', paymentId: '' });
        }
      });
      return;
    }
    case 'charge.refunded': {
      const ch = event.data.object as Stripe.Charge;
      if (!ch.payment_intent) return;
      await reflectStripeRefund({
        stripePaymentIntentId: String(ch.payment_intent),
        amountRefundedCents: Number(ch.amount_refunded ?? 0),
        chargeAmountCents: Number(ch.amount ?? 0)
      });
      return;
    }
    case 'account.application.deauthorized': {
      if (event.account) await markDisconnectedByAccount(event.account);
      return;
    }
    default:
      return; // ignore everything else
  }
}
```

> Adjust `payment.failed`'s required envelope fields (`partnerId`) to satisfy `InvoiceEvent` — fetch the partner id from the invoice if the union requires a non-empty value.

- [ ] **Step 4: Run tests to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeWebhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/stripeWebhook.ts apps/api/src/services/stripeWebhook.test.ts
git commit -m "feat(billing): stripe webhook dispatch — capture, fail, refund, deauthorize"
```

---

### Task 13: Mount the webhook (unauthenticated)

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Mount before/outside session auth, mirroring the email webhook**

In `apps/api/src/index.ts`, next to `api.route('/webhooks/tickets', emailWebhookRoutes);`:

```typescript
import { stripeWebhookRoutes } from './routes/webhooks/stripe';
// ...
// Stripe Connect webhook — no session auth, signature-verified. Must not be behind partnerGuard body parsing.
api.route('/webhooks', stripeWebhookRoutes);
```

> Verify the global `authMiddleware`/`partnerGuard` passes through requests with no `Authorization` header for this path (the email webhook relies on the same behavior). If a middleware consumes the body, register this route on the raw app before that middleware — match exactly how `emailWebhookRoutes` is wired.

- [ ] **Step 2: Typecheck + full webhook test**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeWebhook.test.ts
```
Expected: PASS / no new type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(billing): mount stripe webhook (unauthenticated, signature-verified)"
```

---

## Phase F — Portal pay

### Task 14: Portal `POST /invoices/:id/pay`

**Files:**
- Modify: `apps/api/src/routes/portal/invoices.ts`
- Test: `apps/api/src/routes/portal/invoices.test.ts`

- [ ] **Step 1: Write a failing test (mock stripe client + service + db)**

```typescript
it('POST /invoices/:id/pay creates a checkout session on the connected account', async () => {
  // arrange: portalAuth.user.orgId = org1; invoice status 'sent', balance 100.00, partner has active connection
  const create = vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
  // mock getStripe().checkout.sessions.create = create, with second arg { stripeAccount }
  const res = await portalInvoiceRoutes.request('/invoices/inv1/pay', { method: 'POST' }, { /* portalAuth */ });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ url: expect.stringContaining('checkout.stripe.com') });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'payment' }), { stripeAccount: 'acct_9' });
});

it('returns 409 when the partner has not connected Stripe', async () => {
  const res = await portalInvoiceRoutes.request('/invoices/inv2/pay', { method: 'POST' }, { /* portalAuth, no connection */ });
  expect(res.status).toBe(409);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/portal/invoices.test.ts`
Expected: FAIL — route 404.

- [ ] **Step 3: Implement the pay route**

Add to `apps/api/src/routes/portal/invoices.ts`:

```typescript
import { and, eq, ne } from 'drizzle-orm';
import { invoices } from '../../db/schema/invoices';
import { invoiceStripePayments } from '../../db/schema/stripePayments';
import { getConnection } from '../../services/stripeConnectService';
import { getStripe, getConnectedStripeOptions } from '../../services/stripeClient';
import { getConfig } from '../../config';

const PAYABLE = new Set(['sent', 'partially_paid', 'overdue']);

invoiceRoutes.post('/invoices/:id/pay', async (c) => {
  const auth = c.get('portalAuth');
  const id = c.req.param('id');

  const [inv] = await db.select().from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.orgId, auth.user.orgId), ne(invoices.status, 'draft')))
    .limit(1);
  if (!inv) return c.json({ error: 'Invoice not found' }, 404);
  if (!PAYABLE.has(inv.status)) return c.json({ error: 'Invoice is not payable' }, 409);
  if (Math.round(Number(inv.balance) * 100) <= 0) return c.json({ error: 'Nothing to pay' }, 409);

  const conn = await getConnection(inv.partnerId);
  if (!conn || conn.status !== 'connected') return c.json({ error: 'Online payment is not available' }, 409);

  const balanceCents = Math.round(Number(inv.balance) * 100);
  const cfg = getConfig();
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: inv.currencyCode.toLowerCase(),
        unit_amount: balanceCents,
        product_data: { name: `Invoice ${inv.invoiceNumber ?? inv.id}` }
      },
      quantity: 1
    }],
    success_url: `${cfg.PORTAL_BASE_URL}/invoices/${inv.id}?paid=1`,
    cancel_url: `${cfg.PORTAL_BASE_URL}/invoices/${inv.id}`,
    metadata: { invoice_id: inv.id, org_id: inv.orgId, partner_id: inv.partnerId, balance_cents: String(balanceCents) }
  }, getConnectedStripeOptions(conn.stripeAccountId));

  await db.insert(invoiceStripePayments).values({
    orgId: inv.orgId, invoiceId: inv.id, stripeAccountId: conn.stripeAccountId,
    stripeObjectType: 'checkout_session', stripeObjectId: session.id,
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    amount: (balanceCents / 100).toFixed(2), currency: inv.currencyCode, status: 'pending'
  });

  return c.json({ url: session.url });
});
```

> `cfg.PORTAL_BASE_URL` — use the existing portal base-url config key (grep `validate.ts`; it may be `PUBLIC_PORTAL_URL` or derived). Replace with the real key. The route runs under the portal org context, so the `invoices` SELECT and the mapping INSERT are RLS-safe as the customer's org.

- [ ] **Step 4: Run tests to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/portal/invoices.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/portal/invoices.ts apps/api/src/routes/portal/invoices.test.ts
git commit -m "feat(billing): portal pay route — hosted checkout on the MSP connected account"
```

---

## Phase G — Web UI

### Task 15: "Connect Stripe" control in partner billing settings

**Files:**
- Modify: the partner billing-settings React island (find it: `grep -rl "billing-settings\|BillingSettings\|invoiceFooter" apps/web/src`)
- Test: alongside the component (jsdom)

> This is React/Astro work; per repo convention UI runs in-session on the interactive model. Keep it minimal.

- [ ] **Step 1: Add a `StripeConnectCard` component**

Render connection state from `GET /api/v1/partner/stripe-connect`:
- Disconnected → "Connect Stripe" button → `POST /api/v1/partner/stripe-connect/oauth/start`, then `window.location.href = url`.
- Connected → show masked `acct_…` + livemode badge + "Disconnect" button → `DELETE /api/v1/partner/stripe-connect`.

All three mutations MUST go through `runAction` (`apps/web/src/lib/runAction.ts`) so success/failure is surfaced (the `no-silent-mutations` test guards this).

```tsx
// inside StripeConnectCard
const connect = () => runAction(async () => {
  const { url } = await api.post('/partner/stripe-connect/oauth/start');
  window.location.href = url;
}, { errorMessage: 'Could not start Stripe connection' });

const disconnect = () => runAction(async () => {
  await api.delete('/partner/stripe-connect');
  await refresh();
}, { successMessage: 'Stripe disconnected', errorMessage: 'Could not disconnect Stripe' });
```

> Match the actual `api` client + `runAction` option names used by a sibling settings component.

- [ ] **Step 2: Add a "Pay invoice" button to the customer portal invoice detail**

In the portal invoice-detail island, when `status ∈ {sent, partially_paid, overdue}` and `balance > 0`, render a "Pay now" button → `POST /portal/invoices/:id/pay` (via `runAction`) → redirect to the returned Checkout `url`.

- [ ] **Step 3: Typecheck web (astro check catches .astro)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(billing-web): connect-stripe control + portal pay button"
```

---

## Phase H — Verification

### Task 16: Full verification pass

- [ ] **Step 1: API unit suite (affected files, single-fork) + typecheck**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/stripeReconcile.test.ts src/services/stripeWebhook.test.ts src/services/stripeConnectService.test.ts src/services/stripeClient.test.ts src/routes/stripeConnect/index.test.ts src/routes/portal/invoices.test.ts src/config/validate.test.ts
```
Expected: PASS. (The full parallel `vitest run` is flaky on a pristine tree — verify via affected files, trust CI for the rest.)

- [ ] **Step 2: Real-DB integration (RLS + coverage + drift)**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/stripe-payments-rls.integration.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```
Expected: PASS / no drift.

- [ ] **Step 3: Manual smoke (Stripe test mode)**

With `STRIPE_*` test keys set and the Stripe CLI forwarding to `/api/v1/webhooks/stripe/connect`:
1. Connect a Stripe **test** account via the partner UI.
2. As a portal user, "Pay now" on a sent invoice; complete Checkout with `4242 4242 4242 4242`.
3. Confirm the webhook records the payment and the invoice flips to `paid` (`balance = 0`).
4. Refund the charge in the Stripe dashboard; confirm the invoice reopens (`partially_paid`/`overdue`).
5. Re-send the same webhook event via `stripe events resend`; confirm **no** duplicate payment (idempotency).

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin docs/2026-06-15-stripe-payments-spec
gh pr create --title "feat(billing): Stripe Payments — pay invoices online via MSP-connected Stripe (sub-project 4/4)" \
  --body "Implements docs/superpowers/specs/billing/2026-06-15-stripe-payments-design.md. Standard Connect + OAuth, direct charges on the MSP's own account, no platform fee. Hosted Checkout from the customer portal; signature-verified webhook reconciles into invoice_payments via recomputeInvoiceStatus; reflect-only refunds.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

> Trigger the `Integration Tests` job explicitly (it's skipped on `pull_request`): `gh workflow run ci.yml --ref docs/2026-06-15-stripe-payments-spec`.

---

## Self-review notes (for the implementer)

- **Idempotency is the highest-risk area.** Stripe redelivers; the `unique(stripe_object_id)` mapping + the `mapping.invoicePaymentId` guard are what prevent double-recording. Do not weaken either. Test resend explicitly (Task 16 Step 3.5).
- **System DB context is mandatory on every webhook DB write** (`withSystemDbAccessContext`). A bare `db` write here silently affects 0 rows under `breeze_app` RLS — the #1375 class of bug. Every reconcile/dispatch path in Tasks 9–12 already wraps writes; keep it that way.
- **Dual-cascade contract** (Task 3) is only caught by the `Integration Tests` job — don't skip Step 2 of Task 16.
- **livemode guard (spec §11):** in `handleStripeEvent` (Task 12), before recording a capture, load the connection for `event.account` and reject (log + return) when `event.livemode` disagrees with the stored connection's `livemode`. Prevents a test-mode event from mutating a live invoice and vice-versa. Add a dispatch test for the mismatch case.
- **Amounts:** Stripe is integer minor units; the engine stores major-unit `numeric(12,2)`. Convert at the boundary only (`/100`, `.toFixed(2)`), compare in integer cents. The partial-refund path keeps the payment row `> 0` (respects the existing CHECK); a full refund deletes the row.
- **`apiVersion`, `PORTAL_BASE_URL`, `getTrustedClientIp`, `writeAuditLog`, the portal seed helpers, and `runAction` option names** are the spots most likely to need a one-line adjustment to match the live code — each is flagged inline.

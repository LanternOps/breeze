# Quotes & Invoices — Seller Contact Info, Terms & Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seller/MSP "From" contact block and a combined "Terms & Conditions" block (payment terms + disclaimers) to quotes and invoices, snapshotted at issue and rendered across PDF, email HTML, web, and portal — reusing the existing memo (`notes`/`introNotes`) and footer (`terms`) columns.

**Architecture:** New partner-level contact fields are the editable source of truth. At issue time both documents snapshot the seller contact into a `sellerSnapshot` jsonb column and default `termsAndConditions` from the partner — mirroring the existing `billTo*` snapshot model. A single pure helper builds the snapshot; all renderers read the frozen snapshot (falling back to a live partner build for draft previews).

**Tech Stack:** PostgreSQL + Drizzle ORM, Hono + Zod (`@hono/zod-validator`), pdfkit, React (apps/web + apps/portal), Vitest.

**Spec:** `docs/superpowers/specs/billing/2026-06-19-quotes-invoices-contact-info-design.md`

## Global Constraints

- **Node:** prefix every pnpm/vitest command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- **Fresh worktree:** run `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install` once before building/testing (this worktree was created fresh).
- **API tests:** run a single file with `PATH=… pnpm --filter @breeze/api exec vitest run <path>` (the `test -- <file>` script runs the whole suite — do not use it).
- **Shared package:** has no build step; verify with `PATH=… pnpm --filter @breeze/shared exec vitest run <path>` and `pnpm --filter @breeze/shared typecheck`.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, idempotent (`ADD COLUMN IF NOT EXISTS`), no inner `BEGIN/COMMIT`, filename `2026-06-19-<slug>.sql`. Never edit a shipped migration.
- **No new tables → no RLS policy changes and no `rls-coverage` allowlist edits.** All three tables (`partners`, `invoices`, `quotes`) already have RLS.
- **Snapshot semantics:** seller contact + terms + footer are frozen at issue; never re-resolved from the partner afterwards.
- **Seller snapshot shape (canonical, used everywhere):**
  ```ts
  interface SellerSnapshot {
    name: string | null;
    address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null } | null;
    phone: string | null;
    email: string | null;
    website: string | null;
  }
  ```
  The `address` sub-object intentionally uses the **same keys** as `billToAddress` so the existing `addressLines()` helpers in both PDF renderers work unchanged.

---

### Task 1: DB schema + migration

**Files:**
- Modify: `apps/api/src/db/schema/orgs.ts:10-46` (partners)
- Modify: `apps/api/src/db/schema/invoices.ts:28-76` (invoices)
- Modify: `apps/api/src/db/schema/quotes.ts:21-63` (quotes)
- Create: `apps/api/migrations/2026-06-19-quotes-invoices-contact-fields.sql`

**Interfaces:**
- Produces: new columns `partners.billingCompanyName|billingPhone|billingWebsite|billingAddressLine1|billingAddressLine2|billingAddressCity|billingAddressRegion|billingAddressPostalCode|billingAddressCountry|billingTermsAndConditions`; `invoices.sellerSnapshot (jsonb)`, `invoices.termsAndConditions (text)`; `quotes.sellerSnapshot (jsonb)`, `quotes.termsAndConditions (text)`.

- [ ] **Step 1: Add partner columns to the Drizzle schema**

In `apps/api/src/db/schema/orgs.ts`, inside the `partners` table definition, immediately after `invoiceFooter: text('invoice_footer'),` (line 40) add:

```ts
  billingCompanyName: varchar('billing_company_name', { length: 255 }),
  billingPhone: varchar('billing_phone', { length: 40 }),
  billingWebsite: varchar('billing_website', { length: 255 }),
  billingAddressLine1: varchar('billing_address_line1', { length: 255 }),
  billingAddressLine2: varchar('billing_address_line2', { length: 255 }),
  billingAddressCity: varchar('billing_address_city', { length: 120 }),
  billingAddressRegion: varchar('billing_address_region', { length: 120 }),
  billingAddressPostalCode: varchar('billing_address_postal_code', { length: 40 }),
  billingAddressCountry: char('billing_address_country', { length: 2 }),
  billingTermsAndConditions: text('billing_terms_and_conditions'),
```

(`varchar`, `char`, `text` are already imported in this file — confirm at the top; the existing `organizations` table uses all three.)

- [ ] **Step 2: Add invoice columns**

In `apps/api/src/db/schema/invoices.ts`, in the `invoices` table after `terms: text('terms'),` (line 50) add:

```ts
  sellerSnapshot: jsonb('seller_snapshot'),
  termsAndConditions: text('terms_and_conditions'),
```

(`jsonb` and `text` are already imported — `billToAddress: jsonb(...)` exists at line 46.)

- [ ] **Step 3: Add quote columns**

In `apps/api/src/db/schema/quotes.ts`, in the `quotes` table after `terms: text('terms'),` (line 45) add:

```ts
  sellerSnapshot: jsonb('seller_snapshot'),
  termsAndConditions: text('terms_and_conditions'),
```

- [ ] **Step 4: Write the migration**

Create `apps/api/migrations/2026-06-19-quotes-invoices-contact-fields.sql`:

```sql
-- Seller "From" contact profile on partners + Terms & Conditions block.
-- Snapshot columns on invoices/quotes mirror the existing bill_to_* snapshot model.
-- No new tables → no RLS changes (partners/invoices/quotes already have RLS).

ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_company_name varchar(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_phone varchar(40);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_website varchar(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_line1 varchar(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_line2 varchar(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_city varchar(120);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_region varchar(120);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_postal_code varchar(40);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_country char(2);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_terms_and_conditions text;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_snapshot jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS terms_and_conditions text;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS seller_snapshot jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS terms_and_conditions text;
```

- [ ] **Step 5: Verify schema/migration drift is clean**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```
Expected: no drift reported (schema matches migrations). If drift is reported, reconcile column names/types until clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/orgs.ts apps/api/src/db/schema/invoices.ts apps/api/src/db/schema/quotes.ts apps/api/migrations/2026-06-19-quotes-invoices-contact-fields.sql
git commit -m "feat(billing): schema + migration for seller contact, T&C on quotes/invoices"
```

---

### Task 2: Seller snapshot helper

**Files:**
- Create: `apps/api/src/services/sellerSnapshot.ts`
- Test: `apps/api/src/services/sellerSnapshot.test.ts`

**Interfaces:**
- Consumes: a partner row (Drizzle `typeof partners.$inferSelect`, or any object with the `billing*`/`name` fields).
- Produces: `buildSellerSnapshot(partner): SellerSnapshot`, the `SellerSnapshot` type, and `sellerAddressLines(snapshot): string[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/sellerSnapshot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSellerSnapshot, sellerAddressLines } from './sellerSnapshot';

const base = {
  name: 'Acme MSP', billingCompanyName: null, billingEmail: null, billingPhone: null,
  billingWebsite: null, billingAddressLine1: null, billingAddressLine2: null,
  billingAddressCity: null, billingAddressRegion: null, billingAddressPostalCode: null,
  billingAddressCountry: null,
};

describe('buildSellerSnapshot', () => {
  it('falls back to partner.name when billingCompanyName is null', () => {
    expect(buildSellerSnapshot(base).name).toBe('Acme MSP');
  });

  it('prefers billingCompanyName over name', () => {
    expect(buildSellerSnapshot({ ...base, billingCompanyName: 'Acme MSP LLC' }).name).toBe('Acme MSP LLC');
  });

  it('maps contact + address fields', () => {
    const snap = buildSellerSnapshot({
      ...base, billingEmail: 'billing@acme.test', billingPhone: '+1 555 0100',
      billingWebsite: 'acme.test', billingAddressLine1: '1 Main St', billingAddressCity: 'Austin',
      billingAddressRegion: 'TX', billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    });
    expect(snap.email).toBe('billing@acme.test');
    expect(snap.phone).toBe('+1 555 0100');
    expect(snap.website).toBe('acme.test');
    expect(snap.address).toMatchObject({ line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' });
  });
});

describe('sellerAddressLines', () => {
  it('joins city/region/postal and drops empties', () => {
    const snap = buildSellerSnapshot({
      ...base, billingAddressLine1: '1 Main St', billingAddressCity: 'Austin',
      billingAddressRegion: 'TX', billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    });
    expect(sellerAddressLines(snap)).toEqual(['1 Main St', 'Austin, TX, 78701', 'US']);
  });

  it('returns [] for a null snapshot', () => {
    expect(sellerAddressLines(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/sellerSnapshot.test.ts`
Expected: FAIL — cannot find module `./sellerSnapshot`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/services/sellerSnapshot.ts`:

```ts
// Pure helpers for the seller "From" contact block. buildSellerSnapshot freezes
// a partner's billing-contact profile onto a document at issue time; renderers
// read the frozen snapshot. The address sub-object uses the SAME keys as
// billToAddress so the PDF renderers' existing addressLines() helper works for it.

export interface SellerSnapshot {
  name: string | null;
  address: {
    line1: string | null; line2: string | null; city: string | null;
    region: string | null; postalCode: string | null; country: string | null;
  } | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

interface PartnerContactFields {
  name?: string | null;
  billingCompanyName?: string | null;
  billingEmail?: string | null;
  billingPhone?: string | null;
  billingWebsite?: string | null;
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingAddressCity?: string | null;
  billingAddressRegion?: string | null;
  billingAddressPostalCode?: string | null;
  billingAddressCountry?: string | null;
}

export function buildSellerSnapshot(partner: PartnerContactFields | null | undefined): SellerSnapshot {
  return {
    name: partner?.billingCompanyName ?? partner?.name ?? null,
    address: {
      line1: partner?.billingAddressLine1 ?? null,
      line2: partner?.billingAddressLine2 ?? null,
      city: partner?.billingAddressCity ?? null,
      region: partner?.billingAddressRegion ?? null,
      postalCode: partner?.billingAddressPostalCode ?? null,
      country: partner?.billingAddressCountry ?? null,
    },
    phone: partner?.billingPhone ?? null,
    email: partner?.billingEmail ?? null,
    website: partner?.billingWebsite ?? null,
  };
}

export function sellerAddressLines(snapshot: SellerSnapshot | null | undefined): string[] {
  const a = snapshot?.address;
  if (!a) return [];
  const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(', ');
  return [a.line1, a.line2, cityLine, a.country].filter((s): s is string => !!s && s.trim().length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/sellerSnapshot.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/sellerSnapshot.ts apps/api/src/services/sellerSnapshot.test.ts
git commit -m "feat(billing): buildSellerSnapshot helper + tests"
```

---

### Task 3: Shared validators + inferred types

**Files:**
- Modify: `packages/shared/src/validators/invoices.ts` (partner billing settings, create/update invoice schemas)
- Modify: `packages/shared/src/validators/quotes.ts` (create/update quote schemas)
- Test: `packages/shared/src/validators/invoices.test.ts`, `packages/shared/src/validators/quotes.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `partnerBillingSettingsSchema` accepts the new partner contact fields + `billingTermsAndConditions`; `createManualInvoiceSchema`/`updateInvoiceSchema`/`createQuoteSchema`/`updateQuoteSchema` accept `termsAndConditions`. Inferred types (`PartnerBillingSettingsInput`, etc.) gain the new optional fields automatically.

- [ ] **Step 1: Write the failing validator tests**

Append to `packages/shared/src/validators/invoices.test.ts` (create the file with the standard header if it does not exist):

```ts
import { describe, it, expect } from 'vitest';
import { partnerBillingSettingsSchema, createManualInvoiceSchema, updateInvoiceSchema } from './invoices';

describe('partnerBillingSettingsSchema — contact fields', () => {
  it('accepts the new seller contact + T&C fields', () => {
    const parsed = partnerBillingSettingsSchema.parse({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingCompanyName: 'Acme MSP LLC', billingPhone: '+1 555 0100', billingWebsite: 'acme.test',
      billingAddressLine1: '1 Main St', billingAddressCity: 'Austin', billingAddressRegion: 'TX',
      billingAddressPostalCode: '78701', billingAddressCountry: 'US',
      billingTermsAndConditions: 'Net 30. Late fee 1.5%/mo.',
    });
    expect(parsed.billingCompanyName).toBe('Acme MSP LLC');
    expect(parsed.billingAddressCountry).toBe('US');
  });

  it('rejects a 3-letter country code', () => {
    expect(() => partnerBillingSettingsSchema.parse({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, billingAddressCountry: 'USA',
    })).toThrow();
  });
});

describe('invoice T&C field', () => {
  it('create accepts termsAndConditions', () => {
    const p = createManualInvoiceSchema.parse({ orgId: '00000000-0000-0000-0000-000000000000', termsAndConditions: 'Net 30' });
    expect(p.termsAndConditions).toBe('Net 30');
  });
  it('update accepts termsAndConditions', () => {
    const p = updateInvoiceSchema.parse({ termsAndConditions: 'Net 15' });
    expect(p.termsAndConditions).toBe('Net 15');
  });
});
```

Append to `packages/shared/src/validators/quotes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createQuoteSchema, updateQuoteSchema } from './quotes';

describe('quote T&C field', () => {
  it('create accepts termsAndConditions', () => {
    const p = createQuoteSchema.parse({ orgId: '00000000-0000-0000-0000-000000000000', termsAndConditions: 'Valid 30 days' });
    expect(p.termsAndConditions).toBe('Valid 30 days');
  });
  it('update accepts termsAndConditions (nullable to clear)', () => {
    expect(updateQuoteSchema.parse({ termsAndConditions: null }).termsAndConditions).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/invoices.test.ts src/validators/quotes.test.ts`
Expected: FAIL — unknown keys stripped / assertions fail (the schemas don't include the new fields yet).

- [ ] **Step 3: Extend the schemas**

In `packages/shared/src/validators/invoices.ts`, replace `partnerBillingSettingsSchema` (lines 75-81) with:

```ts
export const partnerBillingSettingsSchema = z.object({
  currencyCode: z.string().length(3),
  defaultTaxRate: taxRate.nullable().optional(),
  invoiceNumberPrefix: z.string().min(1).max(12),
  invoiceTermsDays: z.number().int().min(0).max(365),
  invoiceFooter: z.string().max(5000).nullable().optional(),
  // Seller "From" contact profile (snapshotted onto each document at issue).
  billingCompanyName: z.string().max(255).nullable().optional(),
  billingPhone: z.string().max(40).nullable().optional(),
  billingWebsite: z.string().max(255).nullable().optional(),
  billingAddressLine1: z.string().max(255).nullable().optional(),
  billingAddressLine2: z.string().max(255).nullable().optional(),
  billingAddressCity: z.string().max(120).nullable().optional(),
  billingAddressRegion: z.string().max(120).nullable().optional(),
  billingAddressPostalCode: z.string().max(40).nullable().optional(),
  billingAddressCountry: z.string().length(2).nullable().optional(),
  billingTermsAndConditions: z.string().max(20_000).nullable().optional(),
});
```

In the same file, add `termsAndConditions` to the invoice schemas:

```ts
export const createManualInvoiceSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid().optional(),
  notes: z.string().max(5000).optional(),
  termsAndConditions: z.string().max(20_000).optional()
});

export const updateInvoiceSchema = z.object({
  notes: z.string().max(5000).optional(),
  siteId: z.string().guid().nullable().optional(),
  dueDate: isoDate.optional(),
  termsAndConditions: z.string().max(20_000).nullable().optional()
});
```

In `packages/shared/src/validators/quotes.ts`, add `termsAndConditions` to both schemas:

```ts
export const createQuoteSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid().optional(),
  currencyCode: z.string().length(3).default('USD'),
  expiryDate: isoDate.optional(),
  introNotes: z.string().max(5000).optional(),
  terms: z.string().max(20_000).optional(),
  termsAndConditions: z.string().max(20_000).optional(),
});

export const updateQuoteSchema = z.object({
  siteId: z.string().guid().nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  introNotes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(20_000).nullable().optional(),
  termsAndConditions: z.string().max(20_000).nullable().optional(),
  taxRate: taxRate.nullable().optional(),
  billToName: z.string().max(255).nullable().optional(),
});
```

> Note: `z.string().length(2)` for country mirrors the `char(2)` column. The inferred types (`z.infer<...>`) update automatically — no separate type edits needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/invoices.test.ts src/validators/quotes.test.ts`
Expected: PASS. Then `PATH=… pnpm --filter @breeze/shared typecheck` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/invoices.ts packages/shared/src/validators/quotes.ts packages/shared/src/validators/invoices.test.ts packages/shared/src/validators/quotes.test.ts
git commit -m "feat(billing): validators accept seller contact + T&C fields"
```

---

### Task 4: API service wiring (settings, create/update, issue snapshot)

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts` (`updatePartnerBillingSettings`, `createManualInvoice`, `updateInvoice`, `issueInvoice`)
- Modify: `apps/api/src/services/quoteService.ts` (`createQuote`, `updateQuote`)
- Modify: `apps/api/src/services/quoteLifecycle.ts` (`sendQuote`)
- Test: `apps/api/src/__tests__/integration/billing-contact-info.integration.test.ts`

**Interfaces:**
- Consumes: `buildSellerSnapshot` (Task 2); new columns (Task 1); validated payloads (Task 3).
- Produces: issued invoices/quotes carry `sellerSnapshot` + `termsAndConditions`; partner settings persist contact fields.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/billing-contact-info.integration.test.ts`. Follow the existing integration harness conventions in this directory (real `breeze_app` DB, autoMigrate + per-test TRUNCATE, seed fresh per `it`). Model the seed/actor setup on a neighboring invoice integration test (e.g. `invoicePdf.integration.test.ts` or `invoices.integration.test.ts`) — reuse its helpers for creating a partner, org, and `InvoiceActor`.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
// Reuse the integration bootstrap + seed helpers from a neighboring spec in this dir.
import { db } from '../../db';
import { partners, invoices } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { updatePartnerBillingSettings, createManualInvoice, issueInvoice } from '../../services/invoiceService';
// ...import the local seed helpers (seedPartnerOrg, makeActor, addVisibleLine) used by sibling tests...

describe('billing contact info — snapshot at issue', () => {
  beforeEach(async () => { /* TRUNCATE per harness */ });

  it('persists partner seller contact fields', async () => {
    const { actor, partnerId } = await seedPartnerOrg();
    await updatePartnerBillingSettings({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingCompanyName: 'Acme MSP LLC', billingPhone: '+1 555 0100', billingWebsite: 'acme.test',
      billingAddressLine1: '1 Main St', billingAddressCity: 'Austin', billingAddressRegion: 'TX',
      billingAddressPostalCode: '78701', billingAddressCountry: 'US',
      billingTermsAndConditions: 'Net 30. Late fee 1.5%/mo.',
    }, actor);
    const [p] = await db.select().from(partners).where(eq(partners.id, partnerId)).limit(1);
    expect(p!.billingCompanyName).toBe('Acme MSP LLC');
    expect(p!.billingTermsAndConditions).toContain('Net 30');
  });

  it('snapshots seller contact + defaults T&C onto an issued invoice', async () => {
    const { actor, orgId, partnerId } = await seedPartnerOrg();
    await updatePartnerBillingSettings({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingCompanyName: 'Acme MSP LLC', billingAddressLine1: '1 Main St', billingAddressCountry: 'US',
      billingTermsAndConditions: 'Net 30.',
    }, actor);
    const inv = await createManualInvoice({ orgId }, actor);
    await addVisibleLine(inv.id, orgId); // a customer-visible line so issue is allowed
    await issueInvoice(inv.id, actor);
    const [issued] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
    const snap = issued!.sellerSnapshot as { name: string; address: { line1: string } };
    expect(snap.name).toBe('Acme MSP LLC');
    expect(snap.address.line1).toBe('1 Main St');
    expect(issued!.termsAndConditions).toBe('Net 30.');
  });

  it('does not overwrite a draft-supplied T&C with the partner default', async () => {
    const { actor, orgId } = await seedPartnerOrg();
    await updatePartnerBillingSettings({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, billingTermsAndConditions: 'Default terms' }, actor);
    const inv = await createManualInvoice({ orgId, termsAndConditions: 'Custom per-invoice terms' }, actor);
    await addVisibleLine(inv.id, orgId);
    await issueInvoice(inv.id, actor);
    const [issued] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
    expect(issued!.termsAndConditions).toBe('Custom per-invoice terms');
  });
});
```

> The `seedPartnerOrg`, `makeActor`, and `addVisibleLine` helpers must match the patterns the sibling integration specs already use. If a neighboring spec exposes reusable seed helpers, import them; otherwise inline the same insert sequence those specs use.

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/billing-contact-info.integration.test.ts`
Expected: FAIL — `createManualInvoice` rejects `termsAndConditions`, snapshot/T&C columns are null.

- [ ] **Step 3: Wire `updatePartnerBillingSettings`**

In `apps/api/src/services/invoiceService.ts`, extend the `patch` type and the write in `updatePartnerBillingSettings` (lines 303-328). Add to the `patch` parameter type the optional fields, then after the existing `if (patch.invoiceFooter !== undefined) ...` (line 320) add:

```ts
  for (const key of [
    'billingCompanyName', 'billingPhone', 'billingWebsite', 'billingAddressLine1', 'billingAddressLine2',
    'billingAddressCity', 'billingAddressRegion', 'billingAddressPostalCode', 'billingAddressCountry',
    'billingTermsAndConditions',
  ] as const) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
```

Update the `patch` type to:
```ts
  patch: {
    currencyCode: string; defaultTaxRate?: number | null; invoiceNumberPrefix: string;
    invoiceTermsDays: number; invoiceFooter?: string | null;
    billingCompanyName?: string | null; billingPhone?: string | null; billingWebsite?: string | null;
    billingAddressLine1?: string | null; billingAddressLine2?: string | null; billingAddressCity?: string | null;
    billingAddressRegion?: string | null; billingAddressPostalCode?: string | null; billingAddressCountry?: string | null;
    billingTermsAndConditions?: string | null;
  },
```

(The `.returning(...)` projection can stay as-is; the route returns the service result and the settings UI reloads via `GET /partners/me`, which already returns the full row.)

- [ ] **Step 4: Wire invoice create/update for T&C**

In `createManualInvoice` (lines 42-50) extend the input type and insert:

```ts
export async function createManualInvoice(input: { orgId: string; siteId?: string; notes?: string; termsAndConditions?: string }, actor: InvoiceActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, input.orgId);
  const rows = await db.insert(invoices).values({
    partnerId, orgId: input.orgId, siteId: input.siteId ?? null, status: 'draft',
    notes: input.notes ?? null, termsAndConditions: input.termsAndConditions ?? null, createdBy: actor.userId
  }).returning();
  return rows[0]!;
}
```

In `updateInvoice` (lines 243-257) extend the `patch` type with `termsAndConditions?: string | null` and add after the `notes` line:

```ts
  if (patch.termsAndConditions !== undefined) set.termsAndConditions = patch.termsAndConditions;
```

- [ ] **Step 5: Snapshot in `issueInvoice`**

In `apps/api/src/services/invoiceService.ts`, add the import at the top:
```ts
import { buildSellerSnapshot } from './sellerSnapshot';
```
In `issueInvoice`, in the final `db.update(invoices).set({...})` (lines 465-475), add two fields to the set object (the full `partner` row is in scope from line 427, and `inv` from line 407):

```ts
      sellerSnapshot: buildSellerSnapshot(partner),
      termsAndConditions: inv.termsAndConditions ?? partner?.billingTermsAndConditions ?? null,
```

(Leave the existing `terms: partner?.invoiceFooter ?? null` line unchanged — that is the footer snapshot.)

- [ ] **Step 6: Wire quote create/update for T&C**

In `apps/api/src/services/quoteService.ts`, in `createQuote` (lines 90-104) add to the insert values:
```ts
    termsAndConditions: input.termsAndConditions ?? null,
```
In `updateQuote` (lines 144-158) add after the `terms` line:
```ts
  if (input.termsAndConditions !== undefined) set.termsAndConditions = input.termsAndConditions;
```
(`CreateQuoteInput`/`UpdateQuoteInput` already gain `termsAndConditions` from Task 3's inferred types.)

- [ ] **Step 7: Snapshot in `sendQuote`**

In `apps/api/src/services/quoteLifecycle.ts`, add the import:
```ts
import { buildSellerSnapshot } from './sellerSnapshot';
```
Before the claim `db.update(quotes).set(...)` (lines 92-96), fetch the full partner row and include the snapshot/defaults in the set:

```ts
  const [partnerRow] = await db.select().from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
  const claimed = await db
    .update(quotes)
    .set({
      status: 'sent', quoteNumber, issueDate, sentAt: now, updatedAt: now,
      sellerSnapshot: buildSellerSnapshot(partnerRow),
      termsAndConditions: quote.termsAndConditions ?? partnerRow?.billingTermsAndConditions ?? null,
      terms: quote.terms ?? partnerRow?.invoiceFooter ?? null,
    })
    .where(and(eq(quotes.id, id), eq(quotes.status, 'draft')))
    .returning({ id: quotes.id });
```

(`partners` is already imported in this file — line 4. `quote` comes from `getQuote` at line 76 and carries `terms`/`termsAndConditions`.)

- [ ] **Step 8: Run the integration test to verify it passes**

Run the Step 2 command. Expected: PASS (all three cases). Also run the existing invoice + quote service unit tests to confirm no regression:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/invoices/settings.test.ts
```
Expected: PASS (existing settings route test still green — the schema additions are optional).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/quoteService.ts apps/api/src/services/quoteLifecycle.ts apps/api/src/__tests__/integration/billing-contact-info.integration.test.ts
git commit -m "feat(billing): snapshot seller contact + default T&C at issue (invoice + quote)"
```

---

### Task 5: PDF + email-HTML renderers (From block + T&C)

**Files:**
- Modify: `apps/api/src/services/invoicePdf.ts` (`renderInvoiceHtml`, `renderInvoicePdfBuffer`, `loadInvoiceForRender`)
- Modify: `apps/api/src/services/quotePdf.ts` (`renderQuotePdf`, `QuoteHeader`)
- Modify: `apps/api/src/services/quoteLifecycle.ts` + `apps/api/src/routes/quotes/quotes.ts` + `apps/api/src/routes/portal/quotes.ts` (pass `sellerSnapshot` to the quote PDF — it already passes the full `quote`, so confirm the header type carries it)
- Test: `apps/api/src/services/invoicePdf.test.ts`, `apps/api/src/services/quotePdf.test.ts`

**Interfaces:**
- Consumes: `invoice.sellerSnapshot`/`invoice.termsAndConditions`, `quote.sellerSnapshot`/`quote.termsAndConditions`, `buildSellerSnapshot`, `sellerAddressLines`.
- Produces: rendered From + T&C in PDF and email HTML; draft previews build a live snapshot when `sellerSnapshot` is null.

- [ ] **Step 1: Write failing renderer tests**

Append to `apps/api/src/services/invoicePdf.test.ts`:

```ts
import { renderInvoiceHtml, renderInvoicePdfBuffer } from './invoicePdf';

const sellerSnapshot = {
  name: 'Acme MSP LLC', phone: '+1 555 0100', email: 'billing@acme.test', website: 'acme.test',
  address: { line1: '1 Main St', line2: null, city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
};

it('renderInvoiceHtml shows the From block and T&C', () => {
  const html = renderInvoiceHtml(
    { invoiceNumber: 'INV-1', currencyCode: 'USD', subtotal: '10', taxTotal: '0', total: '10', amountPaid: '0', balance: '10', billToName: 'Cust', sellerSnapshot, termsAndConditions: 'Net 30 terms' } as never,
    [],
    { partnerName: 'Acme MSP LLC' },
  );
  expect(html).toContain('From');
  expect(html).toContain('billing@acme.test');
  expect(html).toContain('Net 30 terms');
});

it('renderInvoicePdfBuffer emits a %PDF with a seller snapshot present', async () => {
  const buf = await renderInvoicePdfBuffer(
    { invoiceNumber: 'INV-1', currencyCode: 'USD', subtotal: '10', taxTotal: '0', total: '10', amountPaid: '0', balance: '10', billToName: 'Cust', sellerSnapshot, termsAndConditions: 'Net 30' } as never,
    [],
    { partnerName: 'Acme MSP LLC' },
  );
  expect(buf.subarray(0, 4).toString()).toBe('%PDF');
});
```

Append to `apps/api/src/services/quotePdf.test.ts`:

```ts
it('renderQuotePdf includes the From block and T&C', async () => {
  const buf = await renderQuotePdf(
    { id: 'q1', quoteNumber: 'Q-1', currencyCode: 'USD', billToName: 'Cust',
      sellerSnapshot: { name: 'Acme MSP LLC', phone: null, email: 'billing@acme.test', website: null,
        address: { line1: '1 Main St', line2: null, city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' } },
      termsAndConditions: 'Valid 30 days' } as never,
    [], [], async () => null, { partnerName: 'Acme MSP LLC' },
  );
  expect(buf.subarray(0, 4).toString()).toBe('%PDF');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/invoicePdf.test.ts src/services/quotePdf.test.ts`
Expected: FAIL — `renderInvoiceHtml` output lacks "From"/email; type errors on `sellerSnapshot`/`termsAndConditions` until the header types are widened.

- [ ] **Step 3: Add a shared seller-address helper import + types to invoicePdf.ts**

At the top of `apps/api/src/services/invoicePdf.ts` add:
```ts
import { buildSellerSnapshot, sellerAddressLines, type SellerSnapshot } from './sellerSnapshot';
```
(The `InvoiceRow` type already includes `sellerSnapshot`/`termsAndConditions` after Task 1, since it is `typeof invoices.$inferSelect`.)

- [ ] **Step 4: Render From + T&C in `renderInvoiceHtml`**

In `renderInvoiceHtml` (line 89+), compute the seller lines near `const billTo = ...` (line 95):
```ts
  const seller = (invoice.sellerSnapshot as SellerSnapshot | null) ?? null;
  const sellerLines = sellerAddressLines(seller);
```
Add a "From" column inside the existing `display:flex` header block. Replace the bill-to/dates block (lines 126-137) so the row has three parts — From (left), Bill To (middle), dates (right):

```ts
      <div style="padding:24px;display:flex;justify-content:space-between;gap:24px;">
        <div>
          <div style="font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;">From</div>
          <div style="font-size:14px;font-weight:600;color:#111827;margin-top:4px;">${escapeHtml(seller?.name ?? branding.partnerName)}</div>
          ${sellerLines.map((l) => `<div style="font-size:13px;color:#4b5563;">${escapeHtml(l)}</div>`).join('')}
          ${seller?.phone ? `<div style="font-size:12px;color:#6b7280;">${escapeHtml(seller.phone)}</div>` : ''}
          ${seller?.email ? `<div style="font-size:12px;color:#6b7280;">${escapeHtml(seller.email)}</div>` : ''}
          ${seller?.website ? `<div style="font-size:12px;color:#6b7280;">${escapeHtml(seller.website)}</div>` : ''}
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;">Bill to</div>
          <div style="font-size:14px;font-weight:600;color:#111827;margin-top:4px;">${escapeHtml(invoice.billToName ?? '')}</div>
          ${billTo.map((l) => `<div style="font-size:13px;color:#4b5563;">${escapeHtml(l)}</div>`).join('')}
          ${invoice.billToTaxId ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">Tax ID: ${escapeHtml(invoice.billToTaxId)}</div>` : ''}
        </div>
        <div style="text-align:right;font-size:13px;color:#4b5563;">
          ${invoice.issueDate ? `<div>Issued: ${escapeHtml(formatDate(invoice.issueDate))}</div>` : ''}
          ${invoice.dueDate ? `<div>Due: ${escapeHtml(formatDate(invoice.dueDate))}</div>` : ''}
        </div>
      </div>
```

Add the T&C block between the notes block (line 157) and the footer block (line 158):

```ts
      ${invoice.termsAndConditions ? `<div style="padding:0 24px 16px;font-size:12px;color:#6b7280;"><div style="font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;margin-bottom:4px;">Terms &amp; Conditions</div>${escapeHtml(invoice.termsAndConditions)}</div>` : ''}
```

- [ ] **Step 5: Render From + T&C in `renderInvoicePdfBuffer`**

In `renderInvoicePdfBuffer` (line 179+), after the header rule (line 198) and before the bill-to block, draw the From block on the left and move Bill To to the right column. Replace lines 200-216 with:

```ts
      // From (seller) — left column; Bill To — right column; dates under Bill To.
      const seller = (invoice.sellerSnapshot as SellerSnapshot | null) ?? null;
      const rightX = left + contentWidth * 0.55;
      const rightW = contentWidth * 0.45;
      let y = 112;

      doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('FROM', left, y);
      doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(seller?.name ?? branding.partnerName, left, y + 12, { width: contentWidth * 0.5 });
      let fromY = y + 28;
      doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
      for (const aline of sellerAddressLines(seller)) { doc.text(aline, left, fromY, { width: contentWidth * 0.5 }); fromY += 13; }
      doc.fillColor('#6b7280').fontSize(9);
      if (seller?.phone) { doc.text(seller.phone, left, fromY, { width: contentWidth * 0.5 }); fromY += 12; }
      if (seller?.email) { doc.text(seller.email, left, fromY, { width: contentWidth * 0.5 }); fromY += 12; }
      if (seller?.website) { doc.text(seller.website, left, fromY, { width: contentWidth * 0.5 }); fromY += 12; }

      doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('BILL TO', rightX, y, { width: rightW });
      doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(invoice.billToName ?? '', rightX, y + 12, { width: rightW });
      let billY = y + 28;
      doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
      for (const aline of addressLines(invoice.billToAddress as BillToAddress | null)) { doc.text(aline, rightX, billY, { width: rightW }); billY += 13; }
      if (invoice.billToTaxId) { doc.fillColor('#6b7280').fontSize(9).text(`Tax ID: ${invoice.billToTaxId}`, rightX, billY, { width: rightW }); billY += 13; }
      doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
      if (invoice.issueDate) { doc.text(`Issued: ${formatDate(invoice.issueDate)}`, rightX, billY, { width: rightW }); billY += 14; }
      if (invoice.dueDate) { doc.text(`Due: ${formatDate(invoice.dueDate)}`, rightX, billY, { width: rightW }); billY += 14; }

      // Line table starts below the taller of the two columns.
      y = Math.max(fromY, billY) + 20;
```

> This replaces the old `let y = 112; ...` bill-to/date block and the subsequent `y = Math.max(billY, dateY) + 20;` (line 218). Remove the now-dead `dateX`/`dateY` lines (211-215) and the old line-table `y =` reassignment at 218 — the new block ends with the correct `y`.

Add the T&C block in the notes/footer area. Replace lines 267-276 with:

```ts
      // Notes (memo) + Terms & Conditions + footer/terms.
      if (invoice.notes) {
        y += 14;
        doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('NOTES', left, y); y += 12;
        doc.fillColor('#4b5563').fontSize(10).font('Helvetica').text(invoice.notes, left, y, { width: contentWidth });
        y = doc.y + 8;
      }
      if (invoice.termsAndConditions) {
        y += 6;
        doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('TERMS & CONDITIONS', left, y); y += 12;
        doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text(invoice.termsAndConditions, left, y, { width: contentWidth });
        y = doc.y + 8;
      }
      const footer = invoice.terms ?? branding.footerText ?? null;
      if (footer) {
        doc.fillColor('#9ca3af').fontSize(9).font('Helvetica').text(footer, left, Math.max(y, doc.page.height - 110), { width: contentWidth });
      }
```

- [ ] **Step 6: Draft-preview fallback in `loadInvoiceForRender`**

In `loadInvoiceForRender` (lines 290-307), the partner is already selected at line 294 — widen that select to include the contact fields, then fill a live snapshot when the invoice has none (draft preview). Change the partner select to:

```ts
  const [partner] = await db.select().from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
```
and before the `return`, add:
```ts
  if (!invoice.sellerSnapshot && partner) {
    (invoice as { sellerSnapshot: unknown }).sellerSnapshot = buildSellerSnapshot(partner);
  }
```
(Keep the existing `branding` object; it still reads `partner.name`/`partner.invoiceFooter`/`partner.currencyCode`, which the full-row select still provides.)

- [ ] **Step 7: Render From + T&C in the quote PDF**

In `apps/api/src/services/quotePdf.ts`:

Add to the top:
```ts
import { sellerAddressLines, type SellerSnapshot } from './sellerSnapshot';
```
Widen `QuoteHeader` (lines 77-98) by adding:
```ts
  sellerSnapshot?: unknown;
  termsAndConditions?: string | null;
```

In `renderQuotePdf`, replace the PREPARED FOR / dates block (lines 265-284) with a two-column From / Prepared-For layout:

```ts
  // ---- From (seller) left column; Prepared For + dates right column ---------
  let y = 112;
  const seller = (quote.sellerSnapshot as SellerSnapshot | null) ?? null;
  const rightX = c.left + c.contentWidth * 0.55;
  const rightW = c.contentWidth * 0.45;

  doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('FROM', c.left, y);
  doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(seller?.name ?? partnerName, c.left, y + 12, { width: c.contentWidth * 0.5 });
  let fromY = y + 28;
  doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
  for (const aline of sellerAddressLines(seller)) { doc.text(aline, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY += 13; }
  doc.fillColor('#6b7280').fontSize(9);
  if (seller?.phone) { doc.text(seller.phone, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY += 12; }
  if (seller?.email) { doc.text(seller.email, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY += 12; }
  if (seller?.website) { doc.text(seller.website, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY += 12; }

  let billY = y;
  if (quote.billToName) {
    doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('PREPARED FOR', rightX, billY, { width: rightW });
    doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(quote.billToName, rightX, billY + 12, { width: rightW });
    billY += 28;
  }
  doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
  for (const aline of addressLines(quote.billToAddress as BillToAddress | null)) { doc.text(aline, rightX, billY, { width: rightW }); billY += 13; }
  if (quote.billToTaxId) { doc.fillColor('#6b7280').fontSize(9).text(`Tax ID: ${quote.billToTaxId}`, rightX, billY, { width: rightW }); billY += 13; }
  doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
  if (quote.issueDate) { doc.text(`Issued: ${formatDate(quote.issueDate)}`, rightX, billY, { width: rightW }); billY += 14; }
  if (quote.expiryDate) { doc.text(`Valid until: ${formatDate(quote.expiryDate)}`, rightX, billY, { width: rightW }); billY += 14; }

  y = Math.max(fromY, billY) + 20;
```

(Delete the old `dateX`/`dateY` lines 278-282 and the `y = Math.max(billY, dateY) + 20;` at line 284 — the new block sets `y`.)

Add the T&C block after the recurring summary, before the footer. Between line 350 (`y = renderRecurringSummary(...)`) and line 352 (`const footer = ...`) insert:

```ts
  // ---- Terms & Conditions --------------------------------------------------
  if (quote.termsAndConditions) {
    y = ensureSpace(doc, y + 14, 60);
    doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('TERMS & CONDITIONS', c.left, y); y = doc.y + 4;
    doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text(quote.termsAndConditions, c.left, y, { width: c.contentWidth });
    y = doc.y;
  }
```

- [ ] **Step 8: Pass a live snapshot for quote draft previews**

The quote PDF route(s) build the `quote` object passed to `renderQuotePdf`. In `apps/api/src/routes/quotes/quotes.ts` (around line 90-107) and `apps/api/src/routes/portal/quotes.ts` (around line 56), where the partner row is selected for branding, widen that select to the full partner row and set a fallback before calling `renderQuotePdf`:

```ts
  const [partner] = await db.select().from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
  const quoteForRender = {
    ...quote,
    sellerSnapshot: quote.sellerSnapshot ?? buildSellerSnapshot(partner),
  };
```
Pass `quoteForRender` instead of `quote` to `renderQuotePdf`, and keep `footer: quote.terms ?? partner?.invoiceFooter ?? brand?.footerText ?? null` in the branding arg. Add `import { buildSellerSnapshot } from '../../services/sellerSnapshot';` to each route file. (`sendQuote` already snapshots at issue, so the emailed PDF needs no fallback — but adding `sellerSnapshot: quote.sellerSnapshot ?? buildSellerSnapshot(partnerRow)` to its `renderQuotePdf` call at line 134 is harmless and covers any legacy already-sent quote re-render.)

- [ ] **Step 9: Run renderer tests + verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/invoicePdf.test.ts src/services/quotePdf.test.ts`
Expected: PASS. Then typecheck the API: `PATH=… pnpm --filter @breeze/api exec tsc --noEmit` — expected: no new errors (pre-existing errors in `agents.test.ts`/`apiKeyAuth.test.ts` are known).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/invoicePdf.ts apps/api/src/services/quotePdf.ts apps/api/src/services/quoteLifecycle.ts apps/api/src/routes/quotes/quotes.ts apps/api/src/routes/portal/quotes.ts apps/api/src/services/invoicePdf.test.ts apps/api/src/services/quotePdf.test.ts
git commit -m "feat(billing): render seller From block + T&C in invoice/quote PDFs + email HTML"
```

---

### Task 6: Partner billing settings web UI

**Files:**
- Modify: `apps/web/src/components/billing/PartnerBillingSettings.tsx`
- Test: `apps/web/src/components/billing/PartnerBillingSettings.test.tsx` (extend if present, else create)

**Interfaces:**
- Consumes: `GET /orgs/partners/me` (full partner row — already returns new columns), `PATCH /partner/billing-settings` (Task 3/4 payload).
- Produces: editable company-name/address/phone/website + default T&C fields.

- [ ] **Step 1: Write the failing component test**

Create/extend `apps/web/src/components/billing/PartnerBillingSettings.test.tsx`. Mock `fetchWithAuth` to resolve `GET /orgs/partners/me` with a partner that has `billingCompanyName: 'Acme MSP LLC'` and assert it renders, and that Save posts the field. Follow the existing apps/web test setup (jsdom, `@testing-library/react`). Minimal assertion:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import PartnerBillingSettings from './PartnerBillingSettings';
// mock ../../lib/fetchWithAuth + runAction per existing tests in this dir

it('loads and shows the seller company name', async () => {
  // arrange fetchWithAuth GET to return { currencyCode:'USD', invoiceNumberPrefix:'INV', invoiceTermsDays:30, billingCompanyName:'Acme MSP LLC', ... }
  render(<PartnerBillingSettings />);
  await waitFor(() => expect((screen.getByTestId('partner-billing-company-name') as HTMLInputElement).value).toBe('Acme MSP LLC'));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/billing/PartnerBillingSettings.test.tsx`
Expected: FAIL — `partner-billing-company-name` testid not found.

- [ ] **Step 3: Extend the `PartnerBilling` type + state**

In `PartnerBillingSettings.tsx`, extend the interface (lines 10-16) and add state + load wiring:

```tsx
interface PartnerBilling {
  currencyCode: string;
  defaultTaxRate: string | null;
  invoiceNumberPrefix: string;
  invoiceTermsDays: number;
  invoiceFooter: string | null;
  billingCompanyName: string | null;
  billingPhone: string | null;
  billingWebsite: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingAddressCity: string | null;
  billingAddressRegion: string | null;
  billingAddressPostalCode: string | null;
  billingAddressCountry: string | null;
  billingTermsAndConditions: string | null;
}
```

Add `useState` hooks for each new field (string state, default `''`), e.g.:
```tsx
const [companyName, setCompanyName] = useState('');
const [phone, setPhone] = useState('');
const [website, setWebsite] = useState('');
const [addr1, setAddr1] = useState('');
const [addr2, setAddr2] = useState('');
const [city, setCity] = useState('');
const [region, setRegion] = useState('');
const [postal, setPostal] = useState('');
const [country, setCountry] = useState('');
const [terms, setTerms] = useState('');
```

In `load` (after line 42 `setFooter(...)`), populate them:
```tsx
setCompanyName(p.billingCompanyName ?? '');
setPhone(p.billingPhone ?? '');
setWebsite(p.billingWebsite ?? '');
setAddr1(p.billingAddressLine1 ?? '');
setAddr2(p.billingAddressLine2 ?? '');
setCity(p.billingAddressCity ?? '');
setRegion(p.billingAddressRegion ?? '');
setPostal(p.billingAddressPostalCode ?? '');
setCountry(p.billingAddressCountry ?? '');
setTerms(p.billingTermsAndConditions ?? '');
```

- [ ] **Step 4: Send the new fields on Save**

In `save` (the `JSON.stringify({...})` body, lines 60-67), add (use `null` for empty optional text, matching the existing `invoiceFooter` pattern — the billing UI↔Zod payload caution):

```tsx
          billingCompanyName: companyName.trim() === '' ? null : companyName.trim(),
          billingPhone: phone.trim() === '' ? null : phone.trim(),
          billingWebsite: website.trim() === '' ? null : website.trim(),
          billingAddressLine1: addr1.trim() === '' ? null : addr1.trim(),
          billingAddressLine2: addr2.trim() === '' ? null : addr2.trim(),
          billingAddressCity: city.trim() === '' ? null : city.trim(),
          billingAddressRegion: region.trim() === '' ? null : region.trim(),
          billingAddressPostalCode: postal.trim() === '' ? null : postal.trim(),
          billingAddressCountry: country.trim() === '' ? null : country.trim().toUpperCase(),
          billingTermsAndConditions: terms.trim() === '' ? null : terms,
```

Add the field dependencies to the `save` `useCallback` deps array.

- [ ] **Step 5: Add the form inputs**

Add a "Company contact (shown on quotes & invoices)" section before or after the footer field, following the existing field pattern (lines 136-144). Include a `data-testid="partner-billing-company-name"` input for company name, text inputs for phone/website/address parts (2-letter `maxLength={2}` country), and a `<textarea>` for default T&C with `data-testid="partner-billing-terms"`. Example for two fields (repeat the pattern for the rest):

```tsx
<div className="mt-4">
  <label className="text-sm font-medium" htmlFor="pb-company">Company name</label>
  <input id="pb-company" value={companyName} onChange={(e) => setCompanyName(e.target.value)}
    data-testid="partner-billing-company-name"
    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" />
</div>
<div className="mt-4">
  <label className="text-sm font-medium" htmlFor="pb-terms">Default terms &amp; conditions</label>
  <textarea id="pb-terms" rows={4} value={terms} onChange={(e) => setTerms(e.target.value)}
    placeholder="Payment terms, disclaimers, warranty language, etc."
    data-testid="partner-billing-terms"
    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" />
</div>
```

- [ ] **Step 6: Run to verify pass**

Run the Step 2 command. Expected: PASS. Then `PATH=… pnpm --filter @breeze/web exec astro check` (or the web typecheck script) — expected: no new type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/billing/PartnerBillingSettings.tsx apps/web/src/components/billing/PartnerBillingSettings.test.tsx
git commit -m "feat(web): edit seller contact profile + default T&C in partner billing settings"
```

---

### Task 7: Web invoice & quote editor/detail (T&C edit + From display)

**Files:**
- Modify: `apps/web/src/components/billing/InvoiceEditor.tsx` (add T&C textarea + save)
- Modify: `apps/web/src/components/billing/InvoiceDetail.tsx` (show From + T&C)
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` (add T&C textarea + save) and `QuoteDetail.tsx` (show From + T&C)
- Test: extend the corresponding `*.test.tsx` where present

**Interfaces:**
- Consumes: `PATCH /invoices/:id` + `PATCH /quotes/:id` with `termsAndConditions`; the invoice/quote row's `sellerSnapshot`/`termsAndConditions`.
- Produces: draft editors can set T&C; detail views show the From block (from snapshot) + T&C.

- [ ] **Step 1: Write the failing test (invoice editor T&C save)**

In `apps/web/src/components/billing/InvoiceEditor.test.tsx` (extend/create), assert that editing the T&C textarea and saving issues `PATCH /invoices/:id` with `{ termsAndConditions: 'Net 30' }`. Mirror the existing notes-save test in that file.

- [ ] **Step 2: Run to verify fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/billing/InvoiceEditor.test.tsx`
Expected: FAIL — no T&C textarea / PATCH not sent.

- [ ] **Step 3: Add T&C edit to `InvoiceEditor.tsx`**

Mirror the existing notes pattern (state at lines 35-36, `saveNotes` at 157-176). Add:
```tsx
const [terms, setTerms] = useState(invoice.termsAndConditions ?? '');
const [termsDirty, setTermsDirty] = useState(false);
```
and a `saveTerms` callback identical to `saveNotes` but with body `JSON.stringify({ termsAndConditions: terms })` and success message `'Terms saved'`. Render a labelled `<textarea data-testid="invoice-terms">` near the notes textarea, wired to `setTerms`/`setTermsDirty` and `saveTerms`.

- [ ] **Step 4: Show From + T&C in `InvoiceDetail.tsx`**

Add a read-only From block (from `invoice.sellerSnapshot`) near the Bill To area and a T&C block near where notes render. Use the same `SellerSnapshot` shape; render `name`, address lines, phone/email/website, and `invoice.termsAndConditions` when present. (Define a small local `sellerLines(snapshot)` mirroring `sellerAddressLines`, or import the shape; the web app cannot import the API service, so inline a 4-line helper.)

- [ ] **Step 5: Mirror for quotes**

In `QuoteEditor.tsx` add the same T&C textarea (`data-testid="quote-terms"`) wired to `PATCH /quotes/:id` with `{ termsAndConditions }`. In `QuoteDetail.tsx` show the From block + T&C from `quote.sellerSnapshot`/`quote.termsAndConditions`.

- [ ] **Step 6: Run tests + typecheck**

Run the Step 2 command (plus the quote editor test). Expected: PASS. Then web typecheck — expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/billing/InvoiceEditor.tsx apps/web/src/components/billing/InvoiceDetail.tsx apps/web/src/components/billing/quotes/QuoteEditor.tsx apps/web/src/components/billing/quotes/QuoteDetail.tsx apps/web/src/components/billing/**/*.test.tsx
git commit -m "feat(web): edit T&C + show seller From block on invoice/quote editor + detail"
```

---

### Task 8: Portal customer views (From block + T&C)

**Files:**
- Modify: `apps/portal/src/components/portal/InvoiceDetailView.tsx`
- Modify: `apps/portal/src/components/portal/QuoteDetailView.tsx`
- Test: extend the corresponding portal `*.test.tsx` if present

**Interfaces:**
- Consumes: the portal invoice/quote payload (already returns the full row → includes `sellerSnapshot`, `termsAndConditions`).
- Produces: customer-facing From block + T&C block.

- [ ] **Step 1: Write the failing test**

In the portal invoice view test (create/extend), render `InvoiceDetailView` with an `invoice` that has a `sellerSnapshot` + `termsAndConditions` and assert "From", the seller email, and the T&C text appear. Mirror the existing bill-to/notes rendering tests.

- [ ] **Step 2: Run to verify fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/portal exec vitest run src/components/portal/InvoiceDetailView.test.tsx`
Expected: FAIL — From/T&C not rendered.

- [ ] **Step 3: Add From + T&C to `InvoiceDetailView.tsx`**

Add a local seller-lines helper and render a From card beside the existing Bill To card (lines 228-232), plus a T&C card near the Notes card (lines 266-271):

```tsx
const seller = invoice.sellerSnapshot as
  | { name: string | null; phone: string | null; email: string | null; website: string | null;
      address: { line1: string|null; line2: string|null; city: string|null; region: string|null; postalCode: string|null; country: string|null } | null }
  | null;
const sellerLines = (() => {
  const a = seller?.address; if (!a) return [] as string[];
  const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(', ');
  return [a.line1, a.line2, cityLine, a.country].filter((s): s is string => !!s && s.trim().length > 0);
})();
```

```tsx
{seller?.name && (
  <div className="rounded-lg border p-4">
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">From</p>
    <p className="mt-1 text-sm font-medium">{seller.name}</p>
    {sellerLines.map((l, i) => <p key={i} className="text-sm text-muted-foreground">{l}</p>)}
    {seller.phone && <p className="text-sm text-muted-foreground">{seller.phone}</p>}
    {seller.email && <p className="text-sm text-muted-foreground">{seller.email}</p>}
    {seller.website && <p className="text-sm text-muted-foreground">{seller.website}</p>}
  </div>
)}
```

```tsx
{invoice.termsAndConditions && (
  <div className="rounded-lg border p-4">
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Terms &amp; Conditions</p>
    <p className="mt-1 whitespace-pre-wrap text-sm">{invoice.termsAndConditions}</p>
  </div>
)}
```

(Add `sellerSnapshot`/`termsAndConditions` to the portal `Invoice` TypeScript type used by this component.)

- [ ] **Step 4: Mirror for `QuoteDetailView.tsx`**

Add the same From card near the quote header and a T&C card near the Terms card (lines 206-211). Add the fields to the portal `Quote` type.

- [ ] **Step 5: Run tests + typecheck**

Run the Step 2 command (plus the quote view test). Expected: PASS. Then the portal typecheck/`astro check` — expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/portal/src/components/portal/InvoiceDetailView.tsx apps/portal/src/components/portal/QuoteDetailView.tsx apps/portal/src/components/portal/**/*.test.tsx
git commit -m "feat(portal): show seller From block + T&C on customer invoice/quote views"
```

---

## Final verification

- [ ] Run the full billing-related API suites single-fork:
  ```bash
  PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/invoicePdf.test.ts src/services/quotePdf.test.ts src/services/sellerSnapshot.test.ts src/routes/invoices/settings.test.ts
  PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/billing-contact-info.integration.test.ts
  ```
- [ ] Run shared + web + portal billing tests (commands in their tasks).
- [ ] `pnpm db:check-drift` clean.
- [ ] Manual smoke (optional, local docker): set seller contact in partner billing settings, create + issue an invoice and a quote, confirm the From block + T&C appear in the web detail, the portal view, and the downloaded PDF.

## Notes for the implementer

- **Snapshot, never live (after issue):** the renderers read `sellerSnapshot`/`termsAndConditions` off the row. The only live-build fallback is for **draft previews** (Task 5 Steps 6 & 8). Do not make issued documents re-resolve from the partner.
- **Footer vs T&C:** `terms` is the footer (unchanged); `termsAndConditions` is the new block. Don't conflate them.
- **Memo:** `invoices.notes` / `quotes.introNotes` already exist and already render — Task 5/7/8 only relabel/position them ("Notes"); no schema change.
- **Money/optional payload caution:** for new optional text fields send `null` (not `undefined`/empty string) when cleared, matching the existing `invoiceFooter` handling — this class of UI↔Zod mismatch has bitten billing before.
```

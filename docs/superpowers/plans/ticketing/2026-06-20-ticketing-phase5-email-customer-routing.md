# Ticketing Phase 5 — Email-to-Ticket Customer Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the org-resolution layer of email-to-ticket so inbound mail auto-routes to the right customer org via a configurable sender-domain → org mapping, with a triage-org fallback and opt-in unknown-sender contact onboarding.

**Architecture:** A new partner-axis `customer_email_domains` table maps a sender domain to a customer org. The inbound worker (`inboundEmailService.ts`) gains two new resolution steps after the existing portal-user lookup and before quarantine: (2) domain → org (always creates the ticket; optionally onboards a contact), (3) triage-org fallback (opt-in). Both new steps sit behind the existing `senderAuth.verified` (DMARC-pass) gate, so they inherit spoofing protection. Partner admins manage mappings and the triage toggle through new `ticket-config` endpoints and a settings card.

**Tech Stack:** Hono + Drizzle (Postgres, RLS as `breeze_app`), Zod (v4) shared validators, Vitest (unit/integration/RLS), Astro + React Islands web, BullMQ worker for inbound email.

**Spec:** `docs/superpowers/specs/ticketing/2026-06-20-ticketing-phase5-email-customer-routing-design.md`

## Global Constraints

- **Node pin:** prefix pnpm/vitest commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict). Fresh worktree needs `pnpm install` first.
- **Zod v4:** use `z.string().guid()` for UUIDs (never `.uuid()` — strict-RFC rejects nil sentinel). Existing ticket-config routes already use `.guid()`.
- **Migrations:** date-prefixed `2026-06-20-*.sql`; idempotent (`CREATE TABLE IF NOT EXISTS`, `pg_policies`/`DO $$ … EXCEPTION` guards); no inner `BEGIN/COMMIT`; no `gen_random_bytes` (pgcrypto absent — `gen_random_uuid()` is fine). Never edit a shipped migration.
- **RLS:** every tenant-scoped table is `ENABLE` + `FORCE ROW LEVEL SECURITY` with policies in the same migration. API connects as unprivileged `breeze_app`.
- **RLS forge tests** must run against a real DB as `breeze_app` with a non-BYPASSRLS role. Fresh worktrees need the gitignored `.env.test` symlink — confirm `rolbypassrls=false` for the test role or forge tests pass vacuously. Real-DB tests go in `apps/api/src/__tests__/integration/*.integration.test.ts`.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`).
- **Table name:** `customer_email_domains`; Drizzle export `customerEmailDomains`.

---

### Task 1: Migration + Drizzle schema for `customer_email_domains`

**Files:**
- Create: `apps/api/migrations/2026-06-20-a-customer-email-domains.sql`
- Modify: `apps/api/src/db/schema/emailInbound.ts` (add table; it already imports `partners`, `tickets`, and pg helpers)

**Interfaces:**
- Produces: Drizzle table `customerEmailDomains` with columns `{ id, partnerId, orgId, domain, autoCreateContact, isActive, createdBy, createdAt, updatedAt }`, re-exported through `apps/api/src/db/schema/index.ts` (it already `export *`s `emailInbound`).

- [ ] **Step 1: Write the migration file**

Create `apps/api/migrations/2026-06-20-a-customer-email-domains.sql`:

```sql
-- Phase 5 (native ticketing): sender-domain -> customer-org routing for email-to-ticket
-- Spec: docs/superpowers/specs/ticketing/2026-06-20-ticketing-phase5-email-customer-routing-design.md

CREATE TABLE IF NOT EXISTS customer_email_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL,
  domain VARCHAR(255) NOT NULL,
  auto_create_contact BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Org must belong to the partner (DB-enforced; mirrors ticket_categories composite FK).
-- Relies on the UNIQUE(id, partner_id) constraint on organizations already used by
-- ticket_categories and users. Add it if a fresh DB somehow lacks it (idempotent).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'organizations' AND c.contype IN ('p','u')
      AND c.conkey = (SELECT array_agg(attnum ORDER BY attnum)
                      FROM pg_attribute WHERE attrelid = t.oid AND attname IN ('id','partner_id'))
  ) THEN
    ALTER TABLE organizations ADD CONSTRAINT organizations_id_partner_id_key UNIQUE (id, partner_id);
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE customer_email_domains
    ADD CONSTRAINT customer_email_domains_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS customer_email_domains_partner_domain_uq
  ON customer_email_domains (partner_id, domain);
CREATE INDEX IF NOT EXISTS customer_email_domains_lookup_idx
  ON customer_email_domains (partner_id, is_active);

-- RLS: partner-axis (Shape 3) + denormalized org_id. System scope (the inbound worker)
-- sees all; partner scope sees only its own rows.
ALTER TABLE customer_email_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_email_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY customer_email_domains_partner_access ON customer_email_domains
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 2: Add the Drizzle table to `emailInbound.ts`**

Append to `apps/api/src/db/schema/emailInbound.ts` (it already imports `pgTable, uuid, varchar, text, jsonb, timestamp, boolean, index, uniqueIndex` and `partners`; add `organizations` and `users` imports if missing):

```typescript
export const customerEmailDomains = pgTable('customer_email_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull(),
  domain: varchar('domain', { length: 255 }).notNull(),
  autoCreateContact: boolean('auto_create_contact').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('customer_email_domains_partner_domain_uq').on(t.partnerId, t.domain),
  index('customer_email_domains_lookup_idx').on(t.partnerId, t.isActive)
]);
```

> Note: the composite FK `(org_id, partner_id)` is enforced in SQL only (Drizzle's `references()` is single-column); this mirrors `ticket_categories`. Do not add a single-column `org_id` FK in Drizzle — it would drift from the migration.

- [ ] **Step 3: Apply migration against a clean DB and verify no drift**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```
Expected: reports no schema drift between `emailInbound.ts` and the migration.

- [ ] **Step 4: Verify the table + RLS apply against empty Postgres (Check Migrations parity)**

Run the migration against a throwaway `postgres:16` (or local `breeze-postgres`) and confirm it applies cleanly and re-applies as a no-op:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsx src/db/autoMigrate.ts 2>&1 | tail -20
```
Expected: migration `2026-06-20-a-customer-email-domains` applied; second run logs it as already applied (no checksum error).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-20-a-customer-email-domains.sql apps/api/src/db/schema/emailInbound.ts
git commit -m "feat(ticketing): add customer_email_domains table + RLS (Phase 5)"
```

---

### Task 2: RLS coverage allowlists + functional forge test

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (add to `PARTNER_TENANT_TABLES` and `ORG_AXIS_POLICY_EXCLUDED_TABLES`)
- Create: `apps/api/src/__tests__/integration/customerEmailDomainsRls.integration.test.ts`

**Interfaces:**
- Consumes: `customerEmailDomains` from Task 1.

- [ ] **Step 1: Add the table to both allowlists**

In `rls-coverage.integration.test.ts`, add to the `PARTNER_TENANT_TABLES` map (near the `ticket_email_inbound` entry):
```typescript
  ['customer_email_domains', 'partner_id'],
```
And add to `ORG_AXIS_POLICY_EXCLUDED_TABLES` (it carries `org_id` but is partner-axis — same reason as `time_entries`):
```typescript
  'customer_email_domains', // partner-axis (Shape 3) carrying denormalized org_id
```

- [ ] **Step 2: Write the functional forge test (cross-partner + cross-org)**

Create `apps/api/src/__tests__/integration/customerEmailDomainsRls.integration.test.ts`. Re-seed fixtures inside each `it` (the `beforeEach` TRUNCATE wipes module-scope fixtures, which makes later cross-tenant cases vacuous). Pattern mirrors existing `*Rls.integration.test.ts` files:

```typescript
import { describe, it, expect } from 'vitest';
import { withDbAccessContext } from '../../db';
import { seedPartnerWithOrg } from './helpers'; // use the existing seed helpers in this dir

describe('customer_email_domains RLS', () => {
  it('partner A cannot read partner B rows', async () => {
    const a = await seedPartnerWithOrg();
    const b = await seedPartnerWithOrg();
    await withDbAccessContext({ scope: 'system' }, async (db) => {
      await db.execute(/* sql */`INSERT INTO customer_email_domains (partner_id, org_id, domain)
        VALUES (${b.partnerId}, ${b.orgId}, 'acme.com')`);
    });
    const rows = await withDbAccessContext(
      { scope: 'partner', partnerId: a.partnerId },
      (db) => db.execute(/* sql */`SELECT id FROM customer_email_domains`)
    );
    expect(rows.length).toBe(0);
  });

  it('forging a row for another partner org fails the WITH CHECK / composite FK', async () => {
    const a = await seedPartnerWithOrg();
    const b = await seedPartnerWithOrg();
    await expect(
      withDbAccessContext({ scope: 'partner', partnerId: a.partnerId }, (db) =>
        db.execute(/* sql */`INSERT INTO customer_email_domains (partner_id, org_id, domain)
          VALUES (${a.partnerId}, ${b.orgId}, 'evil.com')`)
      )
    ).rejects.toThrow(/row-level security|violates foreign key/i);
  });
});
```

> Adapt `seedPartnerWithOrg`/`withDbAccessContext` calls to the actual helper signatures in this integration dir (read a neighboring `*Rls.integration.test.ts` first). The two assertions that matter: a partner cannot SELECT another partner's rows, and a partner cannot INSERT a row pointing at another partner's org.

- [ ] **Step 3: Run the forge test (real DB) and confirm it passes**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/__tests__/integration/customerEmailDomainsRls.integration.test.ts --config vitest.integration.config.ts
```
Expected: PASS (2 tests). If the cross-partner read returns rows, the policy is wrong — fix the migration before continuing.

- [ ] **Step 4: Run the rls-coverage contract test**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/__tests__/integration/rls-coverage.integration.test.ts --config vitest.integration.config.ts
```
Expected: PASS — the new table is now accounted for in both allowlists.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/customerEmailDomainsRls.integration.test.ts
git commit -m "test(ticketing): RLS forge + coverage for customer_email_domains"
```

---

### Task 3: Org cascade-delete coverage

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`ORG_CASCADE_DELETE_ORDER`)

**Interfaces:**
- Consumes: `customer_email_domains` table name (string) from Task 1.

- [ ] **Step 1: Insert the table into `ORG_CASCADE_DELETE_ORDER` at the localeCompare slot**

The list is `localeCompare`-sorted and the contract test is strict about position (prefix-extension siblings do NOT sort adjacent-by-eye — see issue history). Insert `'customer_email_domains'` near `'custom_field_definitions'`. Add the line, then let the contract test (Step 2) confirm the exact slot — if it fails with an ordering error, move the line up/down one position until green.

```typescript
  'customer_email_domains',
  'custom_field_definitions',
```

- [ ] **Step 2: Run the tenantCascade list-contract + integration test**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tenantCascade.test.ts
```
Expected: PASS. If it reports an alpha-order violation, adjust the insertion point per the error and re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts
git commit -m "feat(ticketing): cascade-delete customer_email_domains on org erasure"
```

---

### Task 4: Shared validators (domain schema + freemail blocklist)

**Files:**
- Modify: `packages/shared/src/validators/ticketConfig.ts`
- Test: `packages/shared/src/validators/ticketConfig.test.ts`

**Interfaces:**
- Produces: `createCustomerEmailDomainSchema` (`{ domain: string; orgId: string; autoCreateContact?: boolean }`), `updateCustomerEmailDomainSchema` (`{ orgId?: string; autoCreateContact?: boolean; isActive?: boolean }`), `FREEMAIL_DOMAINS: ReadonlySet<string>`, types `CreateCustomerEmailDomainInput` / `UpdateCustomerEmailDomainInput`. Re-exported via `packages/shared/src/validators/index.ts` (already `export * from './ticketConfig'`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/validators/ticketConfig.test.ts`:

```typescript
import {
  createCustomerEmailDomainSchema,
  updateCustomerEmailDomainSchema,
} from './ticketConfig';

describe('createCustomerEmailDomainSchema', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';

  it('accepts a normal domain and lowercases it, defaulting autoCreateContact true', () => {
    const r = createCustomerEmailDomainSchema.parse({ domain: 'ACME.com', orgId });
    expect(r.domain).toBe('acme.com');
    expect(r.autoCreateContact).toBe(true);
  });

  it('rejects free-provider domains', () => {
    expect(() => createCustomerEmailDomainSchema.parse({ domain: 'gmail.com', orgId })).toThrow();
  });

  it('rejects malformed domains', () => {
    expect(() => createCustomerEmailDomainSchema.parse({ domain: 'not a domain', orgId })).toThrow();
  });

  it('update requires at least one field', () => {
    expect(() => updateCustomerEmailDomainSchema.parse({})).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/ticketConfig.test.ts
```
Expected: FAIL ("createCustomerEmailDomainSchema is not exported" / undefined).

- [ ] **Step 3: Implement the schemas**

Append to `packages/shared/src/validators/ticketConfig.ts`:

```typescript
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
]);

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,255}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/,
    'Enter a valid domain like acme.com',
  )
  .refine((d) => !FREEMAIL_DOMAINS.has(d), 'Free email providers cannot be mapped to a single organization');

export const createCustomerEmailDomainSchema = z.object({
  domain: domainSchema,
  orgId: z.string().guid(),
  autoCreateContact: z.boolean().optional().default(true),
});
export type CreateCustomerEmailDomainInput = z.infer<typeof createCustomerEmailDomainSchema>;

export const updateCustomerEmailDomainSchema = z
  .object({
    orgId: z.string().guid().optional(),
    autoCreateContact: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateCustomerEmailDomainInput = z.infer<typeof updateCustomerEmailDomainSchema>;
```

- [ ] **Step 4: Run to verify pass**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/ticketConfig.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/ticketConfig.ts packages/shared/src/validators/ticketConfig.test.ts
git commit -m "feat(ticketing): validators for customer email domain mapping"
```

---

### Task 5: Resolver — `resolveOrgBySenderDomain` + contact onboarding helpers

**Files:**
- Create: `apps/api/src/services/inboundEmail/resolveOrg.ts`
- Test: `apps/api/src/services/inboundEmail/resolveOrg.test.ts`

**Interfaces:**
- Consumes: `customerEmailDomains`, `portalUsers`, `partners` schema; the shared `db`.
- Produces:
  - `resolveOrgBySenderDomain(fromAddress: string, partnerId: string): Promise<{ orgId: string; autoCreateContact: boolean } | null>`
  - `findOrCreateEmailContact(orgId: string, email: string, name: string | null): Promise<string>` (returns portalUser id)
  - `loadPartnerInboundPolicy(partnerId: string): Promise<{ triageUnknownSenders: boolean; defaultTriageOrgId: string | null }>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/inboundEmail/resolveOrg.test.ts`. Mock `../../db` the same way the sibling `inboundEmailService.test.ts` does (read it first for the exact mock shape):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// (mock ../../db to return a chainable select/insert — copy the pattern from inboundEmailService.test.ts)

import { resolveOrgBySenderDomain } from './resolveOrg';

describe('resolveOrgBySenderDomain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the org + autoCreateContact for an active matching domain', async () => {
    // arrange db.select(...).where(...).limit() -> [{ orgId: 'org-1', autoCreateContact: true }]
    const r = await resolveOrgBySenderDomain('bob@Acme.com', 'partner-1');
    expect(r).toEqual({ orgId: 'org-1', autoCreateContact: true });
  });

  it('returns null when no domain matches', async () => {
    // arrange db ... -> []
    const r = await resolveOrgBySenderDomain('bob@nowhere.com', 'partner-1');
    expect(r).toBeNull();
  });

  it('returns null for an address with no @', async () => {
    expect(await resolveOrgBySenderDomain('garbage', 'partner-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/inboundEmail/resolveOrg.test.ts
```
Expected: FAIL ("resolveOrg" module not found).

- [ ] **Step 3: Implement the resolver module**

Create `apps/api/src/services/inboundEmail/resolveOrg.ts`:

```typescript
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { customerEmailDomains, partners } from '../../db/schema';
import { portalUsers } from '../../db/schema/portal';

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

export async function resolveOrgBySenderDomain(
  fromAddress: string,
  partnerId: string,
): Promise<{ orgId: string; autoCreateContact: boolean } | null> {
  const domain = domainOf(fromAddress);
  if (!domain) return null;
  const rows = await db
    .select({ orgId: customerEmailDomains.orgId, autoCreateContact: customerEmailDomains.autoCreateContact })
    .from(customerEmailDomains)
    .where(
      and(
        eq(customerEmailDomains.partnerId, partnerId),
        eq(customerEmailDomains.domain, domain),
        eq(customerEmailDomains.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findOrCreateEmailContact(
  orgId: string,
  email: string,
  name: string | null,
): Promise<string> {
  const lower = email.toLowerCase();
  const existing = await db
    .select({ id: portalUsers.id })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, lower)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(portalUsers)
    .values({ orgId, email: lower, name, passwordHash: null, authMethod: 'password', status: 'active' })
    .returning({ id: portalUsers.id });
  return inserted[0].id;
}

export async function loadPartnerInboundPolicy(
  partnerId: string,
): Promise<{ triageUnknownSenders: boolean; defaultTriageOrgId: string | null }> {
  const rows = await db.select({ settings: partners.settings }).from(partners).where(eq(partners.id, partnerId)).limit(1);
  const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>;
  const inbound =
    (((settings.ticketing as Record<string, unknown> | undefined)?.inbound) as
      | { defaultTriageOrgId?: string | null; triageUnknownSenders?: boolean }
      | undefined) ?? {};
  return {
    triageUnknownSenders: inbound.triageUnknownSenders === true,
    defaultTriageOrgId: inbound.defaultTriageOrgId ?? null,
  };
}
```

> Verify the `partners` export carries a `settings` JSONB column (ticketConfigService.ts reads `partners.settings` at the inbound config read). If `partners` is exported from a different schema file than the barrel, import it from there.

- [ ] **Step 4: Run to verify pass**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/inboundEmail/resolveOrg.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inboundEmail/resolveOrg.ts apps/api/src/services/inboundEmail/resolveOrg.test.ts
git commit -m "feat(ticketing): sender-domain org resolver + contact onboarding helpers"
```

---

### Task 6: Wire new resolution steps into the inbound dispatch

**Files:**
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.ts` (the new-ticket branch, currently ~lines 208–215)
- Test: `apps/api/src/services/inboundEmail/inboundEmailService.test.ts`

**Interfaces:**
- Consumes: `resolveOrgBySenderDomain`, `findOrCreateEmailContact`, `loadPartnerInboundPolicy` (Task 5); existing `findPortalUserInPartner`, `createFromEmail`, `logInbound`.

- [ ] **Step 1: Write failing tests for the three new branches**

Add to `inboundEmailService.test.ts` (mirror the existing `processInboundEmail` tests; the existing `senderAuth.verified` gate must be satisfied — pass a normalized email with `senderAuth: { verified: true, ... }`):

```typescript
describe('processInboundEmail — domain routing (Phase 5)', () => {
  it('routes a verified unknown sender whose domain is mapped, auto-creating a contact', async () => {
    // findPortalUserInPartner -> null; resolveOrgBySenderDomain -> { orgId: 'org-9', autoCreateContact: true }
    // expect findOrCreateEmailContact called with ('org-9', from, fromName)
    // expect createFromEmail called with orgId 'org-9' and the new contact id as submittedBy
    // expect logInbound(..., 'created', ticketId)
  });

  it('routes a mapped domain WITHOUT creating a contact when autoCreateContact is false', async () => {
    // resolveOrgBySenderDomain -> { orgId: 'org-9', autoCreateContact: false }
    // expect findOrCreateEmailContact NOT called; createFromEmail submittedBy === null
  });

  it('falls back to the triage org when enabled and no domain matches', async () => {
    // resolveOrgBySenderDomain -> null; loadPartnerInboundPolicy -> { triageUnknownSenders: true, defaultTriageOrgId: 'org-triage' }
    // expect createFromEmail orgId === 'org-triage', submittedBy === null
  });

  it('quarantines when nothing matches and triage is disabled', async () => {
    // resolveOrgBySenderDomain -> null; loadPartnerInboundPolicy -> { triageUnknownSenders: false, defaultTriageOrgId: null }
    // expect logInbound(..., 'quarantined', null)
  });
});
```

Mock `./resolveOrg` exports with `vi.mock('./resolveOrg', ...)`.

- [ ] **Step 2: Run to verify failure**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/inboundEmail/inboundEmailService.test.ts
```
Expected: FAIL (new branches not implemented).

- [ ] **Step 3: Implement the new branches**

Add the import near the top of `inboundEmailService.ts`:
```typescript
import { resolveOrgBySenderDomain, findOrCreateEmailContact, loadPartnerInboundPolicy } from './resolveOrg';
```

Replace the current new-ticket block (the `findPortalUserInPartner` → quarantine code, ~lines 208–215) with:

```typescript
// (5) Known portal-user sender -> their home org (most specific; wins over domain rules).
const sender = await findPortalUserInPartner(n.from, partnerId);
if (sender) {
  const t = await createFromEmail(n, partnerId, sender.orgId, null, null, sender.id);
  await logInbound(n, partnerId, 'created', t.id);
  return;
}

// (6) Sender domain mapped to a customer org -> always create; optionally onboard a contact.
const domainMatch = await resolveOrgBySenderDomain(n.from, partnerId);
if (domainMatch) {
  const submittedBy = domainMatch.autoCreateContact
    ? await findOrCreateEmailContact(domainMatch.orgId, n.from, n.fromName ?? null)
    : null;
  const t = await createFromEmail(n, partnerId, domainMatch.orgId, null, null, submittedBy);
  await logInbound(n, partnerId, 'created', t.id);
  return;
}

// (7) Triage fallback for unknown senders, if the partner opted in.
const policy = await loadPartnerInboundPolicy(partnerId);
if (policy.triageUnknownSenders && policy.defaultTriageOrgId) {
  const t = await createFromEmail(n, partnerId, policy.defaultTriageOrgId, null, null, null);
  await logInbound(n, partnerId, 'created', t.id);
  return;
}

// (8) Nothing matched -> quarantine.
await logInbound(n, partnerId, 'quarantined', null);
return;
```

> Match `createFromEmail`'s exact positional signature from the existing call site (`createFromEmail(n, partnerId, orgId, null, null, submittedBy)`); do not invent new parameters. This block sits AFTER the existing `senderAuth.verified` gate (~line 172), so all three new paths are spoofing-protected without new code.

- [ ] **Step 4: Run to verify pass**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/inboundEmail/inboundEmailService.test.ts
```
Expected: PASS (all branches).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inboundEmail/inboundEmailService.ts apps/api/src/services/inboundEmail/inboundEmailService.test.ts
git commit -m "feat(ticketing): route inbound email by sender domain + triage fallback"
```

---

### Task 7: Config service — domain CRUD + triage toggle read/write

**Files:**
- Modify: `apps/api/src/services/ticketConfigService.ts`
- Test: `apps/api/src/services/ticketConfigService.test.ts`

**Interfaces:**
- Consumes: `customerEmailDomains` schema; `createCustomerEmailDomainSchema`/`updateCustomerEmailDomainSchema` types.
- Produces:
  - `listCustomerEmailDomains(partnerId: string): Promise<Array<{ id; domain; orgId; orgName; autoCreateContact; isActive; createdAt }>>`
  - `createCustomerEmailDomain(partnerId, input: CreateCustomerEmailDomainInput, actor: { userId: string }): Promise<{ id; ... }>`
  - `updateCustomerEmailDomain(partnerId, id, input: UpdateCustomerEmailDomainInput): Promise<{ id; ... }>`
  - `deleteCustomerEmailDomain(partnerId, id): Promise<void>`
  - The existing inbound config read now also returns `triageUnknownSenders: boolean`.

- [ ] **Step 1: Write failing tests**

Add to `ticketConfigService.test.ts` (mirror existing service tests; mock `../db`):

```typescript
describe('customer email domains', () => {
  it('createCustomerEmailDomain rejects an org that is not in the partner (composite FK / 403 path)', async () => {
    // db.insert(...).returning() rejects with a FK violation -> service throws TicketConfigServiceError
  });
  it('listCustomerEmailDomains returns rows joined with org names for the partner', async () => {
    // db.select(...).leftJoin(organizations) -> [{ id, domain, orgId, orgName, autoCreateContact, isActive }]
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/ticketConfigService.test.ts
```
Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement the CRUD functions + triage read**

Add to `ticketConfigService.ts` (reuse the file's existing `TicketConfigServiceError`, `db`/`withDbAccessContext`, and `organizations` import; add `customerEmailDomains` to the schema import):

```typescript
export async function listCustomerEmailDomains(partnerId: string) {
  return db
    .select({
      id: customerEmailDomains.id,
      domain: customerEmailDomains.domain,
      orgId: customerEmailDomains.orgId,
      orgName: organizations.name,
      autoCreateContact: customerEmailDomains.autoCreateContact,
      isActive: customerEmailDomains.isActive,
      createdAt: customerEmailDomains.createdAt,
    })
    .from(customerEmailDomains)
    .leftJoin(organizations, eq(customerEmailDomains.orgId, organizations.id))
    .where(eq(customerEmailDomains.partnerId, partnerId))
    .orderBy(customerEmailDomains.domain);
}

export async function createCustomerEmailDomain(
  partnerId: string,
  input: CreateCustomerEmailDomainInput,
  actor: { userId: string },
) {
  try {
    const rows = await db
      .insert(customerEmailDomains)
      .values({
        partnerId,
        orgId: input.orgId,
        domain: input.domain,
        autoCreateContact: input.autoCreateContact,
        createdBy: actor.userId,
      })
      .returning();
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw new TicketConfigServiceError('That domain is already mapped', 409);
    if (isForeignKeyViolation(err)) throw new TicketConfigServiceError('That organization is not in your partner', 403);
    throw err;
  }
}

export async function updateCustomerEmailDomain(
  partnerId: string,
  id: string,
  input: UpdateCustomerEmailDomainInput,
) {
  const rows = await db
    .update(customerEmailDomains)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(customerEmailDomains.id, id), eq(customerEmailDomains.partnerId, partnerId)))
    .returning();
  if (!rows[0]) throw new TicketConfigServiceError('Domain mapping not found', 404);
  return rows[0];
}

export async function deleteCustomerEmailDomain(partnerId: string, id: string) {
  const rows = await db
    .delete(customerEmailDomains)
    .where(and(eq(customerEmailDomains.id, id), eq(customerEmailDomains.partnerId, partnerId)))
    .returning({ id: customerEmailDomains.id });
  if (!rows[0]) throw new TicketConfigServiceError('Domain mapping not found', 404);
}
```

In the existing inbound config read (the block around line 363–374 that builds `inboundCfg` → the returned object), add the triage flag to both the typed shape and the returned object:
```typescript
// widen the inboundCfg cast:
//   { enabled?; address?; defaultTriageOrgId?; autoresponderEnabled?; triageUnknownSenders?: boolean }
// and add to the returned inbound object:
triageUnknownSenders: inboundCfg.triageUnknownSenders === true,
```

> Reuse the file's existing `isUniqueViolation`/`isForeignKeyViolation` helpers if present; if not, detect Postgres error codes `23505` (unique) and `23503` (FK) on `err.code`. The 403-on-FK is defense-in-depth behind the explicit partner-ownership check added in the route (Task 8).

- [ ] **Step 4: Run to verify pass**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/ticketConfigService.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketConfigService.ts apps/api/src/services/ticketConfigService.test.ts
git commit -m "feat(ticketing): config service CRUD for customer email domains + triage flag"
```

---

### Task 8: Config routes — `/ticket-config/inbound-domains`

**Files:**
- Modify: `apps/api/src/routes/ticketConfig.ts`
- Test: `apps/api/src/routes/ticketConfig.test.ts`

**Interfaces:**
- Consumes: service functions from Task 7; `createCustomerEmailDomainSchema`/`updateCustomerEmailDomainSchema`; existing `scopes`, `writePerm`/`readPerm`, `adminMiddleware`, `requirePartnerId`, `handleServiceError`, `idParam`.

- [ ] **Step 1: Write failing route tests (incl. cross-partner 403/404)**

Add to `ticketConfig.test.ts` (mirror existing email-inbound route tests):

```typescript
describe('inbound-domains routes', () => {
  it('GET lists domains for the partner', async () => { /* 200 + data array */ });
  it('POST creates a mapping', async () => { /* 201/200 + data.id */ });
  it('POST mapping an org outside the partner returns 403', async () => {
    // service throws TicketConfigServiceError(403) -> handleServiceError -> 403
  });
  it('PATCH a mapping owned by another partner returns 404', async () => {
    // service update with mismatched partnerId -> not found -> 404
  });
  it('non-admin is rejected 403', async () => { /* adminMiddleware */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/ticketConfig.test.ts
```
Expected: FAIL (routes 404).

- [ ] **Step 3: Implement the routes**

Add to `ticketConfig.ts` (import the four service fns and the two schemas; mirror the `/email-inbound/:id/convert` handler idiom exactly):

```typescript
ticketConfigRoutes.get('/inbound-domains', scopes, readPerm, adminMiddleware, async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  const data = await listCustomerEmailDomains(partnerId);
  return c.json({ data });
});

ticketConfigRoutes.post('/inbound-domains', scopes, writePerm, adminMiddleware,
  zValidator('json', createCustomerEmailDomainSchema), async (c) => {
    const partnerId = requirePartnerId(c);
    if (partnerId instanceof Response) return partnerId;
    const auth = c.get('auth') as AuthContext;
    try {
      const row = await createCustomerEmailDomain(partnerId, c.req.valid('json'), { userId: auth.user.id });
      return c.json({ data: row });
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

ticketConfigRoutes.patch('/inbound-domains/:id', scopes, writePerm, adminMiddleware,
  zValidator('param', idParam), zValidator('json', updateCustomerEmailDomainSchema), async (c) => {
    const partnerId = requirePartnerId(c);
    if (partnerId instanceof Response) return partnerId;
    try {
      const row = await updateCustomerEmailDomain(partnerId, c.req.valid('param').id, c.req.valid('json'));
      return c.json({ data: row });
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

ticketConfigRoutes.delete('/inbound-domains/:id', scopes, writePerm, adminMiddleware,
  zValidator('param', idParam), async (c) => {
    const partnerId = requirePartnerId(c);
    if (partnerId instanceof Response) return partnerId;
    try {
      await deleteCustomerEmailDomain(partnerId, c.req.valid('param').id);
      return c.json({ data: { ok: true } });
    } catch (err) {
      return handleServiceError(c, err);
    }
  });
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/ticketConfig.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/ticketConfig.ts apps/api/src/routes/ticketConfig.test.ts
git commit -m "feat(ticketing): inbound-domains config endpoints"
```

---

### Task 9: Web UI — customer domains card + triage toggle un-stub

**Files:**
- Create: `apps/web/src/components/settings/CustomerDomainsCard.tsx`
- Modify: `apps/web/src/components/settings/InboundEmailCard.tsx` (un-stub triage picker + add toggle + render the new card)
- Test: `apps/web/src/components/settings/CustomerDomainsCard.test.tsx`

**Interfaces:**
- Consumes: `/ticket-config/inbound-domains` (GET/POST/PATCH/DELETE), `/orgs/organizations?limit=100`, `/ticket-config` (now returns `inbound.triageUnknownSenders`), `runAction`, `fetchWithAuth`.

- [ ] **Step 1: Write failing component test**

Create `CustomerDomainsCard.test.tsx` (mirror existing settings component tests; mock `fetchWithAuth`/`runAction`):

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { CustomerDomainsCard } from './CustomerDomainsCard';

it('lists existing domain mappings', async () => {
  // mock GET /ticket-config/inbound-domains -> [{ id:'1', domain:'acme.com', orgName:'ACME', autoCreateContact:true, isActive:true }]
  render(<CustomerDomainsCard />);
  await waitFor(() => expect(screen.getByText('acme.com')).toBeInTheDocument());
  expect(screen.getByText('ACME')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/settings/CustomerDomainsCard.test.tsx
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `CustomerDomainsCard.tsx`**

Create the component following `InboundEmailCard.tsx` conventions (`fetchWithAuth` for reads, `runAction` for mutations, `data-testid` attributes, org dropdown loaded from `/orgs/organizations?limit=100`). It renders: a table of `{domain → orgName, auto-create-contact toggle, active toggle, delete}`, and an "Add domain" row with a domain input + org `<select>` + a per-row auto-create-contact checkbox, POSTing to `/ticket-config/inbound-domains` via `runAction` and reloading the list. Surface validation errors (freemail/malformed → 400) through `runAction`'s error path.

```tsx
// Skeleton — full handlers mirror InboundEmailCard's loadConfig/saveConfig pattern.
export function CustomerDomainsCard() {
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  // loadRows(): fetchWithAuth('/ticket-config/inbound-domains') -> setRows(body.data)
  // loadOrgs(): fetchWithAuth('/orgs/organizations?limit=100') -> setOrgs(body.data)
  // addDomain(domain, orgId, autoCreateContact): runAction(POST ...) then loadRows()
  // updateRow(id, patch): runAction(PATCH ...) then loadRows()
  // removeRow(id): runAction(DELETE ...) then loadRows()
  return (/* table + add-row form with data-testid="customer-domains-card" */);
}
```

- [ ] **Step 4: Un-stub the triage picker and add the toggle in `InboundEmailCard.tsx`**

- Remove the `(reserved for future use)` span (line ~290) from the "Default triage organization" label.
- Add a "Route unknown senders to triage org" checkbox bound to `cfg.triageUnknownSenders`, saved via the existing `saveConfig` by extending its `Pick<...>` to include `triageUnknownSenders` and adding it to the `inbound` payload object (lines ~119–139).
- Add `triageUnknownSenders: boolean` to the `InboundConfig` type.
- Render `<CustomerDomainsCard />` below the inbound settings.

```tsx
// In saveConfig's inbound payload (after autoresponderEnabled):
triageUnknownSenders: next.triageUnknownSenders,
// New control near the triage-org picker:
<label className="mt-2 flex items-center gap-2 text-sm">
  <input
    type="checkbox"
    checked={cfg.triageUnknownSenders ?? false}
    disabled={saving || !cfg.defaultTriageOrgId}
    onChange={(e) => void saveConfig({ triageUnknownSenders: e.target.checked })}
    data-testid="inbound-triage-toggle"
  />
  Route unverified-but-unknown senders to the triage org instead of quarantining
</label>
```

- [ ] **Step 5: Run component tests + web typecheck**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/settings/CustomerDomainsCard.test.tsx src/components/settings/InboundEmailCard.test.tsx
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check
```
Expected: tests PASS; `astro check` clean (plain tsc skips `.astro`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/CustomerDomainsCard.tsx apps/web/src/components/settings/CustomerDomainsCard.test.tsx apps/web/src/components/settings/InboundEmailCard.tsx
git commit -m "feat(ticketing): customer email domain settings UI + triage fallback toggle"
```

---

## Self-Review

**Spec coverage:**
- Customer domain → org mapping → Tasks 1, 4, 5, 7, 8, 9 ✓
- Org-resolution precedence (portal user → domain → triage → quarantine) → Task 6 ✓
- Spoofing gate (reuse existing `senderAuth.verified`) → Task 6 sits behind it; no new code, noted ✓
- `customer_email_domains` schema, composite FK, unique, RLS partner-axis + org_id → Task 1 ✓
- rls-coverage both allowlists + forge test → Task 2 ✓
- Cascade order → Task 3 ✓
- Freemail guard → Task 4 ✓
- Auto-create contact (password-less, toggleable) → Tasks 5, 6 ✓
- Triage-org fallback in `partners.settings` JSONB + UI un-stub → Tasks 5, 7, 9 ✓
- Partner-admin CRUD API + IDOR 403 → Tasks 7, 8 ✓
- Web card + runAction → Task 9 ✓

**Placeholder scan:** UI handler bodies in Task 9 Step 3 are described as skeletons that explicitly mirror `InboundEmailCard`'s concrete `loadConfig`/`saveConfig`/`runAction` patterns (shown verbatim in the research) rather than left as "TODO"; every backend task carries complete code. Acceptable for a React card whose every primitive is established in the same directory.

**Type consistency:** `resolveOrgBySenderDomain` returns `{ orgId, autoCreateContact }` (Task 5) and is consumed with those exact fields (Task 6). `loadPartnerInboundPolicy` returns `{ triageUnknownSenders, defaultTriageOrgId }` (Task 5) consumed identically (Task 6). `triageUnknownSenders` flows JSONB → service read (Task 7) → config GET → UI (Task 9) under one name. Service fn names match between Tasks 7 and 8.

# Quote Acceptance On Behalf Of A Customer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is a SINGLE PR**, not a multi-wave feature — the spec says so explicitly
> (`Status: approved (Todd, in-session), single PR, no feature-lifecycle
> registration`). Do **not** call `register_feature` / `start_wave`. Branch once
> (`feat/quote-accept-on-behalf`), land once against `main`.

**Goal:** Give a tech an in-app "Accept on behalf" action that runs the existing
`acceptQuote` conversion pipeline (invoice numbered + issued, recurring lines
drafted as contracts, Pax8 staged) from a `draft | sent | viewed` quote, and
records honest provenance — who recorded it, by what method, against what
reference — so a dispute reviewer can tell an MSP-recorded acceptance from a
customer click.

**Architecture:** One new authenticated route
`POST /api/v1/quotes/:id/accept-on-behalf` in `routes/quotes/lifecycle.ts`,
gated on a new `quotes:accept` permission, calling the existing
`acceptQuote(params)` with four new parameters (`origin`, `method`,
`reference`, `actorUserId`). `acceptQuote` gains an origin-aware status guard
(`draft|sent|viewed` for `on_behalf`, `sent|viewed` for `customer`), an inline
draft→sent claim via a **new** `claimQuoteSent()` helper extracted from
`sendQuote` (delivery-free: no recipients, no token, no public link, no email),
and a direct acceptance-capture path that bypasses `getAcceptanceProvider()`.
`quote_acceptances` gains four columns. Everything downstream of the acceptance
insert — invoice issue, status flip, contracts, executed documents, Pax8, the
three post-commit side effects — is untouched.

**Tech Stack:** Hono + Drizzle + Postgres (hand-written SQL migrations), Vitest
(unit / integration configs), React + i18next (web), Astro + React islands
(portal), Starlight MDX (docs).

**Spec:** `docs/superpowers/specs/billing/2026-09-21-quote-accept-on-behalf-design.md`

---

## Global Constraints

- **Migration naming.** The newest committed migration is
  `apps/api/migrations/2026-10-25-130100-recovery-tokens-negotiated-capabilities.sql`.
  The two new files are therefore
  `2026-10-26-100000-quote-acceptances-on-behalf.sql` and
  `2026-10-26-100100-quotes-accept-permission.sql` — `localeCompare` order puts
  them after everything shipped. **Re-check with
  `ls apps/api/migrations/*.sql | xargs -n1 basename | sort | tail -1` before
  committing**: the pre-push hook re-runs `check-migration-naming.sh
  --against-ref origin/main`, so a migration that sorted fine at commit time can
  fail at push time if `origin/main` gained a later-sorting file meanwhile.
  Rename (both files, plus every path reference) if it does.
- **Never edit a shipped migration.** Fix forward.
- **Idempotent migrations.** `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF
  EXISTS` then re-add, explicit `IF NOT EXISTS` existence checks for permission
  rows (`permissions` has NO unique constraint on `(resource, action)` — `ON
  CONFLICT DO NOTHING` would silently duplicate on re-apply). No inner
  `BEGIN;`/`COMMIT;` — `autoMigrate` wraps each file in one transaction.
- **System scope before ANY write.** Every migration file here writes rows, so
  each opens with `SELECT set_config('breeze.scope', 'system', true);` (or
  `PERFORM set_config(...)` as the first statement inside a `DO` block).
  Enforced by `apps/api/src/db/migrationRlsScope.test.ts` (**Test API** job) —
  **never add a new file to its frozen 122-file baseline** (#4518).
- **Cleanup/back-fill statements report row counts.** Wrap in `DO $$ …
  GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING …; END $$;`, and report even a
  zero so a genuine 0 is distinguishable from an RLS-silenced no-op.
- **Export policy registration fires on a NEW COLUMN, not just a new table.**
  `quote_acceptances` is already in `CORE_ORG_CASCADE_DELETE_ORDER`, so all four
  new columns MUST be classified in `CORE_TENANT_EXPORT_POLICY`
  (`apps/api/src/services/tenantExportPolicyRegistry.ts:485`) in the SAME task
  that adds them. None is `json`/`jsonb`/`bytea`; none matches
  `SUSPICIOUS_NAME_PARTS` — all four go in `included`.
- **No other cascade-list change.** `quote_acceptances` has no `device_id` and
  no `ticket_id`, and is already in `CORE_ORG_CASCADE_DELETE_ORDER`. Verify with
  `grep -n 'quote_acceptances' apps/api/src/services/tenantCascade.ts` — do not
  take this on faith.
- **No RLS change.** `quote_acceptances` is shape 1 (direct `org_id`); its
  existing policy covers new columns. Sanity-run `rls-coverage` anyway.
- **Running one test file.** Use `cd apps/api && npx vitest run <path>` (or
  `cd apps/web && npx vitest run <path>`). **Never write `pnpm --filter <pkg>
  test -- --run <path>`** — pnpm forwards the literal `--` into argv, vitest
  stops flag parsing there, `--run` is swallowed as a positional filter, watch
  mode stays on and the FULL suite runs. `pnpm --filter <pkg> test --run <path>`
  (no `--`) also works. Vitest's path filter is a plain substring match, not a
  glob: to cover a file and its dotted siblings list them explicitly.
- **Integration + RLS suites are separate configs** (`vitest.integration.config.ts`,
  `vitest.config.rls.ts`) and do NOT run under `pnpm test`. They need real
  Postgres + Redis: `pnpm test-stack up` at the repo root for a per-worktree
  stack, `pnpm test-stack down` when finished (nothing reaps it for you).
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`).
  The new dialog component must be added to `TARGET_GLOBS` in
  `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` —
  `QuoteActions.tsx` is already there, and a new sibling file would otherwise
  be unguarded.
- **E2E/DOM queries use `data-testid`**, never text/role/CSS.
- **Files under ~500 lines** (soft). `QuoteActions.tsx` is already 1551 lines —
  the new dialog is a **separate file**, `AcceptOnBehalfDialog.tsx`.
- **Commit after every task** with a conventional message ending in the
  co-author trailer:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Spec deviations resolved during planning

Four statements in the spec do not match the code as it stands today. Each is
resolved here; the resolution is what the tasks implement.

1. **Spec §9: "`GET /quotes/:id` already returns the acceptance record."** It
   does not. `routes/quotes/quotes.ts:118-183` returns
   `{...detail, quote, blocks, branding, presentation, recipients,
   stripeConnected, stripeAccountCurrency, currencyWarning}` and never reads
   `quote_acceptances` (confirmed: the only non-test readers of that table are
   `quoteAcceptService.ts`, `quoteAcceptanceVerify.ts` and
   `contractDocumentService.ts`). **Resolution:** Task 9 *adds* an `acceptance`
   field to that response, not "extends a serializer".
2. **Spec §9: "The acceptance panel that today shows 'Accepted by \<signer\> on
   \<date\>'."** No such panel exists in `QuoteDetail.tsx`; the closest thing is
   the lifecycle `<dl data-testid="quote-detail-lifecycle">` at lines 273-281,
   which renders a bare `Accepted` stage from `quote.acceptedAt`.
   **Resolution:** Task 11 adds a new provenance line immediately after that
   `<dl>`, keyed off the new `detail.acceptance`.
3. **Spec §9: "Where the signature block would render for a converted quote"
   (portal).** The portal renders no signature block for a converted quote — it
   renders the `quote-accept-success` box (`QuoteDetailView.tsx:376-404`).
   **Resolution:** Task 12 adds the notice inside that box.
4. **Spec §10: "Migration replay via the standard `readFileSync` path."** The
   integration harness does not replay migrations per-file:
   `src/__tests__/integration/setup.ts` connects to an already-migrated test
   database (migrated by `autoMigrate` when the stack comes up) and the sibling
   quote suites (`quoteAccept.integration.test.ts`) import services directly.
   **Resolution:** Task 10 follows the sibling-suite shape (no `readFileSync`).
   Migration-file naming/ordering is already covered by `autoMigrate.test.ts`,
   so nothing is lost.

Two further corrections to the spec's DDL, both load-bearing:

5. **Spec §6 CHECK `(origin = 'customer') = (recorded_by_user_id IS NULL)` is
   incompatible with `ON DELETE SET NULL`.** Deleting the recording tech (org
   erasure deletes `users`) would null the column on an `on_behalf` row and the
   equality CHECK would abort the delete with 23514 — a latent GDPR-erasure
   bug of exactly the class CLAUDE.md warns about. **Resolution:** keep `ON
   DELETE SET NULL` and make the CHECK one-directional:
   `(origin = 'on_behalf') OR (recorded_by_user_id IS NULL)` — a customer row
   may never name a recorder; an on-behalf row may lose one to a deletion.
   The same one-directional shape is already what the spec's `reference` CHECK
   uses.
6. **The route must opt out of the ambient request transaction.** The handler
   calls `runOutsideDbContext(() => withSystemDbAccessContext(...))`, which only
   re-points the ALS `db` proxy — the auth middleware's outer
   `baseDb.transaction` stays held, so the accept runs on a SECOND pooled
   connection while the first sits idle-in-transaction (the #1105 class;
   `middleware/selfManagedDbContextRoutes.ts` documents exactly this).
   **Resolution:** Task 8 registers the route in
   `SELF_MANAGED_DB_CONTEXT_ROUTES` and wraps the org-scoped lookup in
   `withAuthDbAccessContext`, matching `/quotes/:id/send`.

---

### Task 1: `quotes:accept` permission constant + seed grants

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts` (the "Quotes /
  Proposals" block, lines 100-105 — `QUOTES_SEND` is line 103)
- Modify: `apps/api/src/db/seed.ts` — `DEFAULT_PERMISSIONS` (the `quotes` rows
  at lines 207-209) and every seeded role whose `permissions` array contains
  `'quotes:send'` (found with `grep -n "quotes:send" apps/api/src/db/seed.ts`)
- Test: `apps/api/src/routes/permissionsCatalog.test.ts` (existing — must stay
  green), plus a new assertion in
  `packages/shared/src/constants/permissions.test.ts` if that file exists;
  otherwise assert in the seed test below.

**Interfaces:**
- Produces: `PERMISSIONS.QUOTES_ACCEPT = { resource: 'quotes', action: 'accept' }`,
  re-exported to the API as `PERMISSIONS` via
  `apps/api/src/services/permissions.ts:381` (`export const PERMISSIONS = PERMISSION_GRANTS;`).
  Consumed by Task 8's route and Task 11's `can('quotes','accept')` gate.
- Produces: seed description string `'Record a customer acceptance on their
  behalf and convert the quote to an invoice'` — this string MUST be
  byte-identical between `seed.ts` and the migration in Task 3.

- [ ] **Step 1: Write the failing test.** Create
      `apps/api/src/db/seedQuotesAccept.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_PERMISSIONS, DEFAULT_ROLES } from './seed';

/**
 * The no-regression rule from the 2026-09-21 accept-on-behalf spec §7: every
 * seeded role that may SEND a quote may also RECORD an acceptance for it.
 * A fresh install seeds from DEFAULT_ROLES; an upgrade back-fills from
 * 2026-10-26-100100-quotes-accept-permission.sql. If these two disagree, two
 * databases disagree about who can convert a quote.
 */
describe('quotes:accept seeding', () => {
  it('registers the permission with the description the migration also uses', () => {
    const row = DEFAULT_PERMISSIONS.find((p) => p.resource === 'quotes' && p.action === 'accept');
    expect(row).toBeDefined();
    expect(row!.description).toBe(
      'Record a customer acceptance on their behalf and convert the quote to an invoice',
    );
  });

  it('grants quotes:accept to every seeded role holding quotes:send', () => {
    const senders = DEFAULT_ROLES.filter((r) => r.permissions.includes('quotes:send'));
    expect(senders.length).toBeGreaterThan(0); // the test is vacuous otherwise
    for (const role of senders) {
      expect(role.permissions, `${role.name} sends quotes but cannot accept them`)
        .toContain('quotes:accept');
    }
  });
});
```

  If `DEFAULT_PERMISSIONS` / `DEFAULT_ROLES` are not exported from `seed.ts`,
  export them (a pure `export const` addition, no behaviour change) — the test
  must read the real arrays, not a copy.

- [ ] **Step 2: Run it — expect RED.**

```bash
cd apps/api && npx vitest run src/db/seedQuotesAccept.test.ts
```

  Expected failure: `expected undefined to be defined` on the first test.

- [ ] **Step 3: Add the constant** in
      `packages/shared/src/constants/permissions.ts`, directly under
      `QUOTES_SEND`:

```ts
  // Quotes / Proposals (billing program — sub-project 4)
  QUOTES_READ: { resource: 'quotes', action: 'read' },
  QUOTES_WRITE: { resource: 'quotes', action: 'write' },
  QUOTES_SEND: { resource: 'quotes', action: 'send' },
  // Recording a customer's acceptance on their behalf (2026-09-21 spec §7).
  // Separate from `send` because it is the money-committing act: it numbers and
  // issues an invoice, drafts contracts and stages a Pax8 order. It is
  // back-filled to every role that already holds `send` (no new authority for
  // anyone), so an MSP that wants acceptance narrower than sending revokes it.
  QUOTES_ACCEPT: { resource: 'quotes', action: 'accept' },
  QUOTES_FULFILL: { resource: 'quotes', action: 'fulfill' },
```

- [ ] **Step 4: Add the seed rows.** In `apps/api/src/db/seed.ts`, after the
      `quotes:send` `DEFAULT_PERMISSIONS` entry (line 209):

```ts
  { resource: 'quotes', action: 'accept', description: 'Record a customer acceptance on their behalf and convert the quote to an invoice' },
```

  Then add `'quotes:accept'` immediately after `'quotes:send'` in **every**
  seeded role's `permissions` array that contains it (at time of writing that is
  the role at line ~381; re-grep rather than trusting the number). Leave
  `'*:*'` wildcard roles alone — grant matching is per-axis
  (`services/permissionMatching.ts`), so the wildcard already satisfies it.

- [ ] **Step 5: Run — expect GREEN**, and confirm the catalog test still passes:

```bash
cd apps/api && npx vitest run src/db/seedQuotesAccept.test.ts src/routes/permissionsCatalog.test.ts
cd packages/shared && npx vitest run src/constants
```

- [ ] **Step 6: Commit.**

```bash
git add packages/shared/src/constants/permissions.ts apps/api/src/db/seed.ts apps/api/src/db/seedQuotesAccept.test.ts
git commit -m "feat(quotes): add the quotes:accept permission and seed it alongside quotes:send

Accepting on a customer's behalf numbers and issues an invoice, drafts
contracts and stages a Pax8 order — the money-committing act. It gets its own
separately-revocable permission rather than riding on quotes:send, and is
seeded to every role that already sends so nobody gains authority.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration A — `quote_acceptances` provenance columns + Drizzle schema + export policy

**Files:**
- Create: `apps/api/migrations/2026-10-26-100000-quote-acceptances-on-behalf.sql`
- Modify: `apps/api/src/db/schema/quotes.ts` — the `quoteAcceptances` table at
  line 239, new columns after `renderLocale`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:485` — the
  `"quote_acceptances"` entry
- Test: `apps/api/src/db/migrationRlsScope.test.ts` (existing; must stay green
  WITHOUT adding the new file to its baseline), plus a new unit test asserting
  the export-policy classification

**Interfaces:**
- Produces (SQL): `quote_acceptances.origin text NOT NULL DEFAULT 'customer'`,
  `method varchar(32) NULL`, `reference text NULL`,
  `recorded_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL`, plus
  CHECKs `quote_acceptances_origin_chk`, `quote_acceptances_reference_chk`,
  `quote_acceptances_recorder_chk`.
- Produces (TS): `quoteAcceptances.origin: string`,
  `quoteAcceptances.method: string | null`,
  `quoteAcceptances.reference: string | null`,
  `quoteAcceptances.recordedByUserId: string | null`. Consumed by Task 6
  (insert) and Task 9 (serializer).

- [ ] **Step 1: Write the failing test.** Create
      `apps/api/src/services/tenantExportPolicyQuoteAcceptances.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CORE_TENANT_EXPORT_POLICY } from './tenantExportPolicyRegistry';
import { quoteAcceptances } from '../db/schema/quotes';
import { getTableConfig } from 'drizzle-orm/pg-core';

/**
 * The export-policy registry fires on a NEW COLUMN of an already-registered
 * org-cascade table, not just on a new table (CLAUDE.md, the one row of the
 * cascade table that behaves that way). This asserts the four on-behalf columns
 * are classified, and classified as ordinary customer data: none is json/jsonb/
 * bytea, and none matches SUSPICIOUS_NAME_PARTS.
 */
describe('quote_acceptances export policy covers the on-behalf columns', () => {
  const policy = CORE_TENANT_EXPORT_POLICY['quote_acceptances'];

  it('classifies every column of the Drizzle table', () => {
    const classified = new Set([
      ...policy.included, ...policy.reviewedIncluded,
      ...policy.excludedSensitive, ...policy.excludedOpen,
    ]);
    const columns = getTableConfig(quoteAcceptances).columns.map((c) => c.name);
    expect([...columns].filter((c) => !classified.has(c))).toEqual([]);
  });

  it('puts the four provenance columns in `included`', () => {
    for (const col of ['origin', 'method', 'reference', 'recorded_by_user_id']) {
      expect(policy.included, `${col} must be exported with the tenant's data`).toContain(col);
    }
  });
});
```

- [ ] **Step 2: Run it — expect RED.**

```bash
cd apps/api && npx vitest run src/services/tenantExportPolicyQuoteAcceptances.test.ts
```

  Expected failure: the first test reports the unclassified columns once the
  schema is updated; run it again after step 3 to see it name
  `origin/method/reference/recorded_by_user_id` before you touch the registry.
  (If `getTableConfig`'s import path differs in this Drizzle version, read
  another registry test in the repo and copy its column-enumeration shape
  rather than inventing one.)

- [ ] **Step 3: Write the migration**
      `apps/api/migrations/2026-10-26-100000-quote-acceptances-on-behalf.sql`:

```sql
-- Quote acceptance on behalf of a customer (spec 2026-09-21 §6). A tech who
-- closed the deal on the phone, by email or on a signed PO records the
-- acceptance in-app; the existing acceptQuote pipeline converts the quote. The
-- four columns below are what makes that record honest — a dispute reviewer
-- must be able to tell an MSP-recorded acceptance from a customer click, and
-- find the evidence.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT IF EXISTS / re-add.
-- No inner BEGIN/COMMIT — autoMigrate wraps this file in one transaction.
--
-- System scope FIRST, before the back-fill UPDATE below: breeze_current_scope()
-- defaults to 'none' and quote_acceptances is FORCE ROW LEVEL SECURITY, which
-- binds the table OWNER — the role migrations run as. Without this the UPDATE
-- matches ZERO rows silently and the RAISE WARNING prints a truthful-looking 0
-- (issue #4518). is_local = true scopes it to autoMigrate's transaction.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE quote_acceptances
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS method varchar(32),
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS recorded_by_user_id uuid;

-- ON DELETE SET NULL, not RESTRICT: an org erasure deletes `users`, and a
-- restricting FK here would abort the cascade with 23503 — the exact latent
-- GDPR-erasure failure the cascade contract exists to prevent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quote_acceptances_recorded_by_user_id_fkey'
      AND conrelid = 'quote_acceptances'::regclass
  ) THEN
    ALTER TABLE quote_acceptances
      ADD CONSTRAINT quote_acceptances_recorded_by_user_id_fkey
      FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Back-fill `method` on historical rows. TypedSignatureProvider is the only
-- acceptance provider that has ever run (services/acceptanceProvider.ts), so
-- every existing row was a typed signature. Row count is reported even when it
-- is 0: a silent 0 and an RLS-suppressed 0 look identical otherwise.
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE quote_acceptances SET method = 'typed-signature' WHERE method IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'back-filled method=typed-signature on % quote_acceptances row(s)', n;
END $$;

-- Constraints added AFTER the back-fill so an existing database is already
-- conformant when they are validated.
ALTER TABLE quote_acceptances DROP CONSTRAINT IF EXISTS quote_acceptances_origin_chk;
ALTER TABLE quote_acceptances
  ADD CONSTRAINT quote_acceptances_origin_chk
  CHECK (origin IN ('customer', 'on_behalf'));

-- One-directional: an on-behalf row must carry the reference a reviewer would
-- look for ("PO 4471", "email from J. Doe 2026-09-20 14:02"). A customer row
-- simply has none.
ALTER TABLE quote_acceptances DROP CONSTRAINT IF EXISTS quote_acceptances_reference_chk;
ALTER TABLE quote_acceptances
  ADD CONSTRAINT quote_acceptances_reference_chk
  CHECK (origin = 'customer' OR reference IS NOT NULL);

-- Also one-directional, DELIBERATELY. The spec proposed the equality
--   (origin = 'customer') = (recorded_by_user_id IS NULL)
-- which is incompatible with ON DELETE SET NULL above: deleting the recording
-- tech would null the column on an on_behalf row and abort the delete with
-- 23514. This shape keeps the real invariant that matters — a CUSTOMER row can
-- never name a recorder — while letting an on-behalf row outlive its recorder.
ALTER TABLE quote_acceptances DROP CONSTRAINT IF EXISTS quote_acceptances_recorder_chk;
ALTER TABLE quote_acceptances
  ADD CONSTRAINT quote_acceptances_recorder_chk
  CHECK (origin = 'on_behalf' OR recorded_by_user_id IS NULL);

COMMENT ON COLUMN quote_acceptances.origin IS
  'customer = the customer accepted (portal or public link); on_behalf = an MSP tech recorded their acceptance (spec 2026-09-21).';
COMMENT ON COLUMN quote_acceptances.reference IS
  'Where a dispute reviewer would find the customer''s agreement. Required for origin = on_behalf.';
```

- [ ] **Step 4: Mirror the columns in Drizzle.** In
      `apps/api/src/db/schema/quotes.ts`, inside `quoteAcceptances` (line 239),
      after `renderLocale`:

```ts
  // Acceptance provenance (spec 2026-09-21 §6). `origin` distinguishes a
  // customer click from an MSP-recorded acceptance; the other three are the
  // evidence trail for the latter. CHECK constraints in
  // 2026-10-26-100000-quote-acceptances-on-behalf.sql are the real invariant —
  // Drizzle types cannot express "required when origin = on_behalf".
  origin: text('origin').notNull().default('customer'),
  // 'typed-signature' for every customer row (the only provider that has ever
  // run); one of verbal|email|signed_document|purchase_order|other for an
  // on-behalf row.
  method: varchar('method', { length: 32 }),
  reference: text('reference'),
  // The tech who recorded it. NULL on customer rows, and NULL again on an
  // on-behalf row whose recorder was later deleted (ON DELETE SET NULL).
  recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
```

  Confirm `text`, `varchar`, `uuid` and a `users` import are already in scope in
  that file; add the `users` import from `./users` if it is not.

- [ ] **Step 5: Classify the columns.** Replace line 485 of
      `apps/api/src/services/tenantExportPolicyRegistry.ts`:

```ts
  // origin / method / reference / recorded_by_user_id (accept-on-behalf, spec
  // 2026-09-21 §6): the provenance of an acceptance. All four are plain
  // scalars — no json/jsonb/bytea open container, no SUSPICIOUS_NAME_PARTS
  // match, no credential material — so they are ordinary customer data the
  // tenant is entitled to export. `reference` is free text the tech typed
  // about the customer's own agreement; it belongs to the tenant.
  "quote_acceptances": tablePolicy("org_id", {"included":["id","quote_id","org_id","signer_name","signer_email","signed_at","ip_address","user_agent","quote_sha256","render_locale","origin","method","reference","recorded_by_user_id","created_at"],"reviewedIncluded":["hash_version"],"excludedSensitive":["acceptance_token_jti"],"excludedOpen":[]}),
```

- [ ] **Step 6: Run — expect GREEN**, and prove the migration guard did not
      quietly absorb the new file:

```bash
cd apps/api && npx vitest run src/services/tenantExportPolicyQuoteAcceptances.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
git diff --stat apps/api/src/db/migrationRlsScope.test.ts   # MUST be empty — no baseline edit
```

- [ ] **Step 7: Verify against a real database.**

```bash
pnpm test-stack up
export DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze_test"
pnpm db:migrate && pnpm db:check-drift
```

  `db:check-drift` must report no drift — that is what proves the Drizzle
  columns and the SQL agree.

- [ ] **Step 8: Commit.**

```bash
git add apps/api/migrations/2026-10-26-100000-quote-acceptances-on-behalf.sql apps/api/src/db/schema/quotes.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantExportPolicyQuoteAcceptances.test.ts
git commit -m "feat(quotes): record acceptance provenance on quote_acceptances

origin/method/reference/recorded_by_user_id, back-filling method to
typed-signature on historical rows under system scope. The recorder CHECK is
one-directional rather than the equality the spec sketched: with ON DELETE SET
NULL an equality would abort an org erasure with 23514 when the recording tech
is deleted.

All four columns classified in CORE_TENANT_EXPORT_POLICY in the same commit —
the export-policy contract fires on a new column of an already-registered
org-cascade table, not just on a new table.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Migration B — back-fill `quotes:accept` to existing roles

**Files:**
- Create: `apps/api/migrations/2026-10-26-100100-quotes-accept-permission.sql`
  (modelled on `apps/api/migrations/2026-10-16-190000-agreements-permission.sql`)
- Test: `apps/api/src/db/migrationRlsScope.test.ts` and
  `apps/api/src/db/autoMigrate.test.ts` (existing, must stay green)

**Interfaces:**
- Consumes: the `('quotes','send')` grant already present in
  `role_permissions`.
- Produces: a `permissions` row `('quotes','accept', …)` and one
  `role_permissions` row per role holding `quotes:send`.

- [ ] **Step 1: Write the failing test.** Create
      `apps/api/src/db/quotesAcceptPermissionMigration.test.ts` — a static
      contract test, so it runs in the **Test API** unit job rather than only
      under Integration:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PERMISSIONS } from './seed';

const FILE = path.resolve(
  __dirname, '../../migrations/2026-10-26-100100-quotes-accept-permission.sql',
);

/**
 * The description string is normative and lives in TWO places: DEFAULT_PERMISSIONS
 * (a fresh install seeds from there) and this migration (an upgrade back-fills
 * from here). A divergence means two databases disagree about what the
 * permission claims to do — the exact trap the agreements migration called out.
 */
describe('2026-10-26-100100-quotes-accept-permission.sql', () => {
  const sql = readFileSync(FILE, 'utf8');

  it('elects system scope before any write', () => {
    const firstWrite = sql.search(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    const scope = sql.indexOf("set_config('breeze.scope', 'system', true)");
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(scope).toBeLessThan(firstWrite);
  });

  it('carries the same description string as DEFAULT_PERMISSIONS', () => {
    const seeded = DEFAULT_PERMISSIONS.find((p) => p.resource === 'quotes' && p.action === 'accept');
    expect(sql).toContain(seeded!.description);
  });

  it('matches roles on the existing quotes:send GRANT, never on a role name', () => {
    expect(sql).toMatch(/resource = 'quotes' AND action = 'send'/);
    expect(sql).not.toMatch(/r\.name\s*=/);
  });

  it('uses an explicit existence check, not ON CONFLICT (permissions has no unique key)', () => {
    expect(sql).not.toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM permissions/);
  });
});
```

- [ ] **Step 2: Run it — expect RED** (`ENOENT` — the migration does not exist).

```bash
cd apps/api && npx vitest run src/db/quotesAcceptPermissionMigration.test.ts
```

- [ ] **Step 3: Write the migration.**

```sql
-- quotes:accept back-fill (spec 2026-09-21 §7). The new permission gates
-- POST /quotes/:id/accept-on-behalf, which numbers and issues an invoice.
--
-- THIS MIGRATION GRANTS NO NEW AUTHORITY. It re-issues, under a new name, a
-- capability every matched role already has: anyone who could SEND a quote
-- could already put it in front of a customer to accept. Matching is therefore
-- on the EXISTING GRANT, never on a role's name — it sweeps system role
-- templates, per-partner is_system clones AND custom (is_system = FALSE) roles
-- alike, exactly like 2026-10-16-190000-agreements-permission.sql. Scoping it
-- to is_system roles would silently strip the action from every partner who
-- built their own "Sales" role. A custom role cannot be forged into extra
-- privilege here, because the predicate IS the privilege it already holds.
-- Partners who want acceptance narrower than sending revoke it afterwards.
--
-- WILDCARDS NEED NO BACK-FILL. Grant matching is per-axis
-- (services/permissionMatching.ts), so the seeded Partner Admin's single '*:*'
-- row already satisfies quotes:accept at runtime. The defensive
-- ('quotes','*') lookup below is expected to be NULL on every real database
-- and says so loudly if it ever is not.
--
-- NOTE: `permissions` has NO UNIQUE constraint on (resource, action) — only a
-- primary key on id. ON CONFLICT DO NOTHING would have nothing to conflict
-- against and would insert a duplicate on every re-apply. Explicit existence
-- check instead.
--
-- NOTE: `role_permissions` IS PRIMARY KEY (role_id, permission_id), so the
-- back-fill uses SELECT DISTINCT even though only one source grant feeds it —
-- cheap, and correct if a second source is ever added.
--
-- System scope first: every write below would otherwise abort with 42501 on a
-- connection that does not bypass RLS (#4518). is_local = true scopes it to
-- autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

-- ============================================
-- 1. The permission row
-- ============================================
-- The description is normative and MUST stay byte-identical to
-- DEFAULT_PERMISSIONS in apps/api/src/db/seed.ts.
DO $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'quotes' AND action = 'accept'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('quotes', 'accept', 'Record a customer acceptance on their behalf and convert the quote to an invoice');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded quotes:accept permission row';
    END IF;
  END IF;
END $$;

-- ============================================
-- 2. No-regression back-fill
-- ============================================
DO $$
DECLARE
  n integer;
  v_accept_id uuid;
  v_send_id uuid;
  v_quotes_any_id uuid;
BEGIN
  -- Scalar lookups (not JOINs), so this stays correct even if a duplicate
  -- permissions row were ever present — always exactly one id.
  SELECT id INTO v_accept_id FROM permissions
  WHERE resource = 'quotes' AND action = 'accept' ORDER BY id LIMIT 1;

  SELECT id INTO v_send_id FROM permissions
  WHERE resource = 'quotes' AND action = 'send' ORDER BY id LIMIT 1;

  SELECT id INTO v_quotes_any_id FROM permissions
  WHERE resource = 'quotes' AND action = '*' ORDER BY id LIMIT 1;

  IF v_quotes_any_id IS NOT NULL THEN
    RAISE WARNING 'unexpected quotes:* wildcard permission row present — including it in the quotes:accept back-fill';
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_accept_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (v_send_id, v_quotes_any_id)
    AND v_accept_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_accept_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Always report, including 0: a 0 on a fresh install is expected, not
  -- evidence the INSERT silently no-op'd under RLS.
  RAISE WARNING 'granted quotes:accept to % role(s) holding quotes:send', n;
END $$;
```

- [ ] **Step 4: Run — expect GREEN**, plus the two contract suites:

```bash
cd apps/api && npx vitest run src/db/quotesAcceptPermissionMigration.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
git diff --stat apps/api/src/db/migrationRlsScope.test.ts   # MUST be empty
```

- [ ] **Step 5: Verify on the live test database** (the stack from Task 2 is
      still up), and confirm the back-fill actually fired:

```bash
pnpm db:migrate
psql "$DATABASE_URL" -c "SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.resource='quotes' AND p.action='accept';"
```

  The count must equal the number of roles holding `quotes:send`.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/migrations/2026-10-26-100100-quotes-accept-permission.sql apps/api/src/db/quotesAcceptPermissionMigration.test.ts
git commit -m "feat(quotes): back-fill quotes:accept to every role holding quotes:send

Matches on the existing grant, never on a role name, so system templates,
per-partner clones and custom roles are all swept. Grants no new authority:
anyone who could send a quote could already put it in front of a customer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `acceptQuoteOnBehalfSchema` in `@breeze/shared`

**Files:**
- Modify: `packages/shared/src/validators/quotes.ts` (next to
  `acceptQuoteSchema`, line 429, and the type exports at line 491)
- Test: `packages/shared/src/validators/quotes.acceptOnBehalf.test.ts` (new)

**Interfaces:**
- Produces: `acceptQuoteOnBehalfSchema` and
  `export type AcceptQuoteOnBehalfInput = z.infer<typeof acceptQuoteOnBehalfSchema>`,
  consumed by Task 8's route `zValidator('json', …)` and Task 11's web wrapper.
- Produces: `QUOTE_ACCEPT_ON_BEHALF_METHODS` — the method tuple, exported so the
  web select and the API enum cannot drift.

- [ ] **Step 1: Write the failing test.** Create
      `packages/shared/src/validators/quotes.acceptOnBehalf.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { acceptQuoteOnBehalfSchema, QUOTE_ACCEPT_ON_BEHALF_METHODS } from './quotes';

const valid = {
  method: 'purchase_order' as const,
  reference: 'PO 4471',
  signerName: 'Dana Buyer',
  signerEmail: 'dana@customer.example',
};

describe('acceptQuoteOnBehalfSchema', () => {
  it('accepts a complete body', () => {
    expect(acceptQuoteOnBehalfSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a body with no signer email', () => {
    const { signerEmail: _drop, ...rest } = valid;
    expect(acceptQuoteOnBehalfSchema.parse(rest).signerEmail).toBeUndefined();
  });

  it('accepts an explicitly null signer email', () => {
    expect(acceptQuoteOnBehalfSchema.parse({ ...valid, signerEmail: null }).signerEmail).toBeNull();
  });

  // The reference is the whole point of the evidence trail: a blank one is a
  // record a dispute reviewer cannot act on.
  it.each(['', '   '])('rejects a blank reference (%j)', (reference) => {
    expect(acceptQuoteOnBehalfSchema.safeParse({ ...valid, reference }).success).toBe(false);
  });

  it('trims the free-text fields', () => {
    const parsed = acceptQuoteOnBehalfSchema.parse({
      ...valid, reference: '  PO 4471  ', signerName: '  Dana Buyer  ',
    });
    expect(parsed.reference).toBe('PO 4471');
    expect(parsed.signerName).toBe('Dana Buyer');
  });

  it('rejects an unknown method', () => {
    expect(acceptQuoteOnBehalfSchema.safeParse({ ...valid, method: 'telepathy' }).success).toBe(false);
  });

  it('rejects a missing signer name', () => {
    const { signerName: _drop, ...rest } = valid;
    expect(acceptQuoteOnBehalfSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an oversize reference (DB column is text, but 500 is the API cap)', () => {
    expect(acceptQuoteOnBehalfSchema.safeParse({ ...valid, reference: 'x'.repeat(501) }).success).toBe(false);
  });

  // varchar(32) on quote_acceptances.method — the longest member must fit.
  it('keeps every method inside the 32-char column', () => {
    for (const m of QUOTE_ACCEPT_ON_BEHALF_METHODS) expect(m.length).toBeLessThanOrEqual(32);
  });
});
```

- [ ] **Step 2: Run it — expect RED.**

```bash
cd packages/shared && npx vitest run src/validators/quotes.acceptOnBehalf.test.ts
```

  Expected failure: `acceptQuoteOnBehalfSchema is not exported`.

- [ ] **Step 3: Implement.** In `packages/shared/src/validators/quotes.ts`,
      immediately after `acceptQuoteSchema` (line 432):

```ts
/** How the customer's agreement was obtained, for an MSP-recorded acceptance
 *  (spec 2026-09-21 §4). Exported as a tuple so the web method picker and the
 *  API enum are literally the same list — a drift here is a 400 the tech
 *  cannot diagnose. Every member must fit quote_acceptances.method varchar(32). */
export const QUOTE_ACCEPT_ON_BEHALF_METHODS = [
  'verbal', 'email', 'signed_document', 'purchase_order', 'other',
] as const;

/** Body for POST /quotes/:id/accept-on-behalf.
 *
 *  `reference` is required and non-blank on purpose: it is what a dispute
 *  reviewer would look for — "PO 4471", "email from J. Doe 2026-09-20 14:02",
 *  "call with owner, notes in T-0231". An acceptance recorded without one is a
 *  claim, not a record. */
export const acceptQuoteOnBehalfSchema = z.object({
  method: z.enum(QUOTE_ACCEPT_ON_BEHALF_METHODS),
  reference: z.string().trim().min(1).max(500),
  signerName: z.string().trim().min(1).max(255),
  signerEmail: z.string().trim().email().max(255).optional().nullable(),
});
```

  And beside the other type exports (line 491):

```ts
export type AcceptQuoteOnBehalfInput = z.infer<typeof acceptQuoteOnBehalfSchema>;
export type QuoteAcceptOnBehalfMethod = (typeof QUOTE_ACCEPT_ON_BEHALF_METHODS)[number];
```

  Confirm `validators/quotes.ts` is re-exported from `packages/shared/src/index.ts`
  (the existing `acceptQuoteSchema` is imported by the portal route, so it is);
  if the new names need adding to an explicit export list, add them.

- [ ] **Step 4: Run — expect GREEN.**

```bash
cd packages/shared && npx vitest run src/validators/quotes.acceptOnBehalf.test.ts src/validators/quotes.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add packages/shared/src/validators/quotes.ts packages/shared/src/validators/quotes.acceptOnBehalf.test.ts
git commit -m "feat(shared): acceptQuoteOnBehalfSchema for MSP-recorded quote acceptance

Reference is required and trimmed non-blank — it is the evidence a dispute
reviewer would look for, so an acceptance without one is a claim rather than a
record. The method tuple is exported so the web picker and the API enum cannot
drift.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Extract `claimQuoteSent` from `sendQuote` (pure move)

**Files:**
- Modify: `apps/api/src/services/quoteLifecycle.ts` — extract from `sendQuote`
  (line 145) the block spanning the quote-number allocation (line 282), the
  partner/org reads and bill-to freeze (lines 293-327), the presentation and
  locale stamps (lines 365-370), the conditional draft→sent `UPDATE` (lines
  371-396) and the parent supersede (lines 407-421)
- Test: `apps/api/src/services/quoteLifecycle.claimSent.test.ts` (new), plus the
  existing `apps/api/src/services/quoteLifecycle.test.ts` (must stay green
  unchanged — that is the whole proof this is a pure move)

**Interfaces:**
- Produces:

```ts
export interface ClaimQuoteSentResult {
  quoteNumber: string;
  issueDate: string;
  billToName: string | null;
  billToAddress: unknown;
  billToTaxId: string | null;
  sellerSnapshot: unknown;
  presentationSnapshot: { theme: string; pageSize: string };
  documentLocale: string;
  termsAndConditions: string | null;
  terms: string | null;
  partnerRow: typeof partners.$inferSelect | undefined;
  org: { name: string | null; billingContact: unknown; taxId: string | null } | undefined;
  superseded?: QuoteSupersedeResult;
}

export async function claimQuoteSent(
  quote: QuoteRow,
  opts: { now: Date; acceptTokenColumns?: Record<string, unknown>; parentToSupersede?: { id: string; status: SupersedableStatus } | null },
): Promise<ClaimQuoteSentResult>;
```

- Consumed by: `sendQuote` (unchanged behaviour) and Task 6's on-behalf draft
  claim.

- [ ] **Step 1: Write the failing test.** Create
      `apps/api/src/services/quoteLifecycle.claimSent.test.ts`. The single new
      assertion the spec asks for — the helper writes **no** link/token state —
      plus a shape assertion:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

// Same controllable Drizzle chain harness as quoteAcceptService.test.ts.
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(resolve);
    return chain;
  };
  const db = makeChain();
  return {
    db,
    assertInTransaction: () => {},
    getCurrentDbAccessContext: () => ({ scope: 'system' }),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withDbAccessContext: (_c: unknown, fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { claimQuoteSent } from './quoteLifecycle';
import { db } from '../db';

type Chain = { set: { mock: { calls: unknown[][] } } };

const draft = {
  id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
  quoteNumber: 'Q-2026-0001', issueDate: '2026-09-21', expiryDate: null,
  billToName: null, billToTaxId: null, sellerSnapshot: null,
  presentationSnapshot: null, documentLocale: null,
  termsAndConditions: null, terms: null, revisionOfQuoteId: null,
} as never;

describe('claimQuoteSent', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('flips draft→sent without writing any public-link or accept-token state', async () => {
    queueResult([{ id: 'p1', name: 'Acme MSP', documentTheme: null, documentPageSize: null, settings: {} }]); // partners
    queueResult([{ name: 'Customer Co', taxId: null, billingContact: null }]);                                 // organizations
    queueResult([{ id: 'q1' }]);                                                                               // claim .returning()

    await claimQuoteSent(draft, { now: new Date('2026-09-21T12:00:00Z') });

    const claim = (db as unknown as Chain).set.mock.calls[0]![0] as Record<string, unknown>;
    expect(claim).toMatchObject({ status: 'sent' });
    // The on-behalf accept reuses this helper precisely BECAUSE it mints
    // nothing the customer could act on: no token, no link, no recipients.
    for (const key of Object.keys(claim)) {
      expect(key, `claimQuoteSent must not write ${key}`).not.toMatch(/^(publicLink|acceptToken|publicToken|publicResponse)/);
    }
  });

  it('409s when the row is no longer a draft (the conditional claim matched 0 rows)', async () => {
    queueResult([{ id: 'p1', settings: {} }]);
    queueResult([{ name: 'Customer Co', taxId: null, billingContact: null }]);
    queueResult([]); // claim matched nothing

    await expect(claimQuoteSent(draft, { now: new Date() })).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 2: Run it — expect RED.**

```bash
cd apps/api && npx vitest run src/services/quoteLifecycle.claimSent.test.ts
```

  Expected failure: `claimQuoteSent is not a function`.

- [ ] **Step 3: Extract the helper.** In `quoteLifecycle.ts`, add above
      `sendQuote`:

```ts
/**
 * The draft→sent claim, WITHOUT delivery.
 *
 * Everything `sendQuote` does to freeze a quote and bind it to a customer —
 * allocate the number if a legacy draft lacks one, freeze the bill-to snapshot
 * from the org's Billing settings, stamp the seller snapshot, presentation and
 * render locale, set issueDate/sentAt, retire a revision's parent — and NOTHING
 * that puts a live credential in a customer's hands: no quote_recipients rows,
 * no accept token, no public-link columns, no email.
 *
 * Extracted so the on-behalf accept (spec 2026-09-21 §5) can claim a draft
 * inline without a second, drifting copy of this logic. `sendQuote` passes the
 * token identity columns it minted; the on-behalf caller passes none, which is
 * what makes the resulting `sent` quote honest — `sent` means "frozen and
 * customer-bound", and the acceptance row's origin tells anyone who needs to
 * know that the customer never received a link.
 *
 * MUST run inside the caller's transaction: the conditional
 * `WHERE status = 'draft'` predicate is what makes two concurrent claims
 * safe (the loser matches 0 rows and 409s), and the parent supersede below has
 * to commit or roll back with it.
 */
export async function claimQuoteSent(
  quote: QuoteRow,
  opts: {
    now: Date;
    /** Accept-token identity columns to stamp atomically with the flip.
     *  sendQuote passes them; the on-behalf accept passes nothing. */
    acceptTokenColumns?: Record<string, unknown>;
    /** Already locked + validated by the caller (sendQuote does this under
     *  FOR UPDATE before reading content). */
    parentToSupersede?: { id: string; status: SupersedableStatus } | null;
  },
): Promise<ClaimQuoteSentResult> {
  const now = opts.now;
  // Quotes are numbered at creation now; keep that number on issue. Only legacy
  // drafts created before number-at-creation still allocate here.
  let quoteNumber = quote.quoteNumber;
  if (!quoteNumber) {
    const year = new Date(quote.issueDate ?? Date.now()).getUTCFullYear();
    const counter = await allocateQuoteCounter(quote.partnerId, year);
    quoteNumber = formatQuoteNumber('Q', year, counter);
  }
  const issueDate = quote.issueDate ?? now.toISOString().slice(0, 10);

  const [partnerRow] = await db.select().from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
  const [org] = await db
    .select({
      name: organizations.name,
      taxId: organizations.taxId,
      billingContact: organizations.billingContact,
      billingAddressLine1: organizations.billingAddressLine1,
      billingAddressLine2: organizations.billingAddressLine2,
      billingAddressCity: organizations.billingAddressCity,
      billingAddressRegion: organizations.billingAddressRegion,
      billingAddressPostalCode: organizations.billingAddressPostalCode,
      billingAddressCountry: organizations.billingAddressCountry,
    })
    .from(organizations)
    .where(eq(organizations.id, quote.orgId))
    .limit(1);
  if (!org) {
    // The caller just read this quote in the SAME context, so its org should be
    // visible too — an unreadable org here (orphaned/deleted row) is anomalous.
    // The snapshot freezes ONCE, so a blank bill-to is permanent; log it rather
    // than let the loss be indistinguishable from "org saved no address".
    console.error(`[quoteLifecycle] org ${quote.orgId} not readable while freezing bill-to for quote ${quote.id} — claiming with an empty bill-to snapshot`);
  }
  const billToAddress = buildBillToAddress(org);
  // Preserve a real tech-entered "Prepared for" override, but fall back to the
  // org name when it is absent OR blank — updateQuote persists billToName
  // verbatim, including '', which a bare `?? org.name` would freeze as empty.
  const billToName = quote.billToName?.trim() ? quote.billToName : (org?.name ?? null);
  const billToTaxId = quote.billToTaxId ?? org?.taxId ?? null;
  const sellerSnapshot = quote.sellerSnapshot ?? buildSellerSnapshot(partnerRow);
  // Stamp the presentation ONCE: never overwrite an existing snapshot, so a
  // re-read always renders the document the customer was actually shown.
  const presentationSnapshot = (quote.presentationSnapshot as { theme: string; pageSize: string } | null) ?? {
    theme: resolveThemeId(partnerRow?.documentTheme),
    pageSize: resolvePageSize(partnerRow?.documentPageSize),
  };
  const documentLocale = quote.documentLocale ?? resolvePartnerDocumentLocale(partnerRow);
  const termsAndConditions = quote.termsAndConditions ?? partnerRow?.billingTermsAndConditions ?? null;
  const terms = quote.terms ?? partnerRow?.invoiceFooter ?? null;

  const claimed = await db
    .update(quotes)
    .set({
      status: 'sent', quoteNumber, issueDate, sentAt: now, updatedAt: now,
      ...(opts.acceptTokenColumns ?? {}),
      // Retire any schedule state atomically with the flip: a scheduled-send
      // claim, a stale failure marker, or a pending window must not survive
      // onto a sent quote (a leftover send_email_reason would render a false
      // "no email was delivered" banner).
      sendScheduledAt: null, sendJobId: null, sendEmailReason: null,
      billToName, billToAddress, billToTaxId,
      sellerSnapshot: buildSellerSnapshot(partnerRow),
      termsAndConditions, terms,
      presentationSnapshot, documentLocale,
    })
    .where(and(eq(quotes.id, quote.id), eq(quotes.status, 'draft')))
    .returning({ id: quotes.id });
  if (claimed.length === 0) {
    throw new QuoteServiceError('Quote was already sent', 409, 'INVALID_STATE');
  }

  let superseded: QuoteSupersedeResult | undefined;
  if (opts.parentToSupersede) {
    // The predicate re-asserts the allowed set even under the caller's
    // FOR UPDATE (belt to the strap). public_link_revoked_at is the
    // DB-authoritative revocation for the parent's link — no Redis revoke,
    // because Redis cannot join this transaction.
    const flipped = await db.update(quotes)
      .set({ status: 'superseded', publicLinkRevokedAt: now, updatedAt: now })
      .where(and(
        eq(quotes.id, opts.parentToSupersede.id),
        eq(quotes.orgId, quote.orgId),
        inArray(quotes.status, [...REVISABLE_STATUSES]),
      ))
      .returning({ id: quotes.id });
    if (flipped.length === 0) {
      throw new QuoteServiceError('The original quote settled while sending the revision', 409, 'PARENT_CONVERTED');
    }
    superseded = { parentQuoteId: opts.parentToSupersede.id, previousStatus: opts.parentToSupersede.status };
  }

  return {
    quoteNumber, issueDate, billToName, billToAddress, billToTaxId,
    sellerSnapshot, presentationSnapshot, documentLocale,
    termsAndConditions, terms, partnerRow, org, superseded,
  };
}
```

  Then rewrite `sendQuote` to call it, replacing lines 282-421 (keep the
  token mint at 353-357 BEFORE the call — the identity must be stamped
  atomically with the flip):

```ts
  const now = new Date();
  // Mint the public accept token BEFORE the claim so its identity is stamped
  // atomically with the draft→sent flip — a send can never commit without the
  // parts needed to reproduce the link it emailed. A token minted for a claim
  // that then loses the race is simply discarded with the 409.
  const { token, identity } = await createQuoteAcceptToken({
    quoteId: id, orgId: quote.orgId, partnerId: quote.partnerId,
    expiresAt: quote.expiryDate ? new Date(`${quote.expiryDate}T23:59:59Z`) : null,
  });
  const acceptUrl = buildPublicQuoteAcceptUrl(token);

  const claim = await claimQuoteSent(quote, {
    now,
    acceptTokenColumns: acceptTokenIdentityColumns(identity),
    parentToSupersede,
  });
  const { quoteNumber, partnerRow, org, presentationSnapshot, documentLocale } = claim;
  const supersededResult = claim.superseded;
```

  The recipient computation (lines 331-347) needs `org?.billingContact` and the
  parent-recipient read: keep both in `sendQuote`, moved to AFTER the
  `claimQuoteSent` call (they are reads and an insert into `quote_recipients`,
  which the helper deliberately does not do). `frozenQuote` (line 438) now
  builds from `claim` fields rather than recomputed locals.

- [ ] **Step 4: Run — expect GREEN, and the existing send suites unchanged.**

```bash
cd apps/api && npx vitest run src/services/quoteLifecycle.claimSent.test.ts src/services/quoteLifecycle.test.ts
cd apps/api && npx vitest run src/routes/quotes/lifecycle.test.ts
```

  If `quoteLifecycle.test.ts` needs ANY edit, the extraction was not a pure
  move — undo and redo it, do not adjust the test.

- [ ] **Step 5: Prove the send path still works end-to-end against Postgres**
      (the revision supersede path is the risky half):

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteLifecycle.integration.test.ts src/__tests__/integration/quoteRevisions.integration.test.ts src/__tests__/integration/quoteSendLockRelease.integration.test.ts
```

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/services/quoteLifecycle.ts apps/api/src/services/quoteLifecycle.claimSent.test.ts
git commit -m "refactor(quotes): extract a delivery-free claimQuoteSent from sendQuote

Pure move: the number allocation, bill-to/seller/presentation/locale freeze,
the conditional draft->sent claim and the revision parent supersede, with no
recipients, no accept token, no public-link columns and no email. sendQuote's
behaviour is unchanged (its existing suite passes untouched); the accept-on-behalf
path claims a draft through the same code rather than a second copy.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `acceptQuote` — on-behalf origin, draft claim, direct capture

**Files:**
- Modify: `apps/api/src/services/quoteAcceptService.ts` — `AcceptQuoteParams`
  (line 29), the status guard (line 173), the provider capture (line 269), the
  acceptance insert (lines 279-296)
- Modify: `apps/api/src/services/quoteEvents.ts` — `QuoteEvent` (line 12)
- Modify: `apps/api/src/services/quoteOutcomeNotify.ts` — `notifyQuoteOutcome`
  input (line 30) and the `emitQuoteEvent` call (line 46)
- Test: `apps/api/src/services/quoteAcceptService.onBehalf.test.ts` (new — a
  separate file so `quoteAcceptService.test.ts`'s 600-line harness stays
  focused), reusing that file's `queueAcceptHappyPath` shape

**Interfaces:**
- Consumes: `claimQuoteSent` (Task 5), `quoteAcceptances.origin/method/
  reference/recordedByUserId` (Task 2).
- Produces: `AcceptQuoteParams` gains `origin?: 'customer' | 'on_behalf'`,
  `method?: string | null`, `reference?: string | null`. `actorUserId` already
  exists and is now populated. Consumed by Task 8's route.
- Produces: `QuoteEvent` gains `origin?: 'customer' | 'on_behalf'` and
  `actorUserId?: string | null`; `notifyQuoteOutcome` gains the same two
  optional fields and forwards them.

- [ ] **Step 1: Write the failing tests.** Create
      `apps/api/src/services/quoteAcceptService.onBehalf.test.ts`. Copy the
      hoisted mocks and the `queueAcceptHappyPath` helper from
      `quoteAcceptService.test.ts` (lines 1-133) verbatim, add a
      `./quoteLifecycle` mock for `claimQuoteSent`, then:

```ts
const claimQuoteSentMock = vi.hoisted(() => vi.fn());
vi.mock('./quoteLifecycle', () => ({ claimQuoteSent: claimQuoteSentMock }));

const onBehalfParams = {
  quoteId: 'q1',
  signerName: 'Dana Buyer',
  signerEmail: 'dana@customer.example',
  ipAddress: '10.0.0.7',
  userAgent: 'Mozilla/5.0 tech-browser',
  acceptanceTokenJti: null,
  actorUserId: 'tech-1',
  origin: 'on_behalf' as const,
  method: 'purchase_order',
  reference: 'PO 4471',
};

describe('acceptQuote — origin on_behalf', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    stagePax8OrderFromQuoteMock.mockResolvedValue({ orderId: null, lineCount: 0 });
    claimQuoteSentMock.mockResolvedValue({ quoteNumber: 'Q-2026-0001', superseded: undefined });
  });

  it('stores the provenance columns on the acceptance row', async () => {
    queueAcceptHappyPath();
    await acceptQuote(onBehalfParams);
    const acceptanceInsert = (db as unknown as Chain).values.mock.calls[0]![0] as Record<string, unknown>;
    expect(acceptanceInsert).toMatchObject({
      origin: 'on_behalf',
      method: 'purchase_order',
      reference: 'PO 4471',
      recordedByUserId: 'tech-1',
      signerName: 'Dana Buyer',
      signerEmail: 'dana@customer.example',
      ipAddress: '10.0.0.7',
    });
  });

  // The provider abstraction represents HOW THE CUSTOMER SIGNED. Routing an
  // MSP-recorded acceptance through a "typed-signature" provider would mislabel
  // it as a signature the customer produced.
  it('bypasses the acceptance provider entirely', async () => {
    queueAcceptHappyPath();
    const { getAcceptanceProvider } = await import('./acceptanceProvider');
    const spy = vi.spyOn({ getAcceptanceProvider }, 'getAcceptanceProvider');
    await acceptQuote(onBehalfParams);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stamps the customer path with the provider method, not null', async () => {
    queueAcceptHappyPath();
    await acceptQuote(baseParams); // origin defaults to 'customer'
    const acceptanceInsert = (db as unknown as Chain).values.mock.calls[0]![0] as Record<string, unknown>;
    expect(acceptanceInsert).toMatchObject({
      origin: 'customer', method: 'typed-signature', reference: null, recordedByUserId: null,
    });
  });

  it('claims a draft to sent before the acceptance, through claimQuoteSent', async () => {
    queueAcceptHappyPath({ status: 'draft' });
    await acceptQuote(onBehalfParams);
    expect(claimQuoteSentMock).toHaveBeenCalledTimes(1);
    expect(claimQuoteSentMock.mock.calls[0]![0]).toMatchObject({ id: 'q1', status: 'draft' });
    // Delivery-free: no token identity handed to the helper.
    expect(claimQuoteSentMock.mock.calls[0]![1]).not.toHaveProperty('acceptTokenColumns');
  });

  it('does not claim a quote that is already sent', async () => {
    queueAcceptHappyPath({ status: 'sent' });
    await acceptQuote(onBehalfParams);
    expect(claimQuoteSentMock).not.toHaveBeenCalled();
  });

  it('still rejects a draft on the customer path (guard unchanged)', async () => {
    queueAcceptHappyPath({ status: 'draft' });
    await expect(acceptQuote(baseParams)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(claimQuoteSentMock).not.toHaveBeenCalled();
  });

  it.each(['expired', 'declined'])('rejects %s with 409 QUOTE_NOT_ACCEPTABLE', async (status) => {
    queueAcceptHappyPath({ status });
    await expect(acceptQuote(onBehalfParams)).rejects.toMatchObject({
      status: 409, code: 'QUOTE_NOT_ACCEPTABLE',
    });
  });

  it('rejects a superseded quote with 410 (existing guard runs first)', async () => {
    queueAcceptHappyPath({ status: 'superseded' });
    await expect(acceptQuote(onBehalfParams)).rejects.toMatchObject({ status: 410, code: 'QUOTE_SUPERSEDED' });
  });

  it('supersedes the parent when the claimed draft is a revision', async () => {
    queueAcceptHappyPath({ status: 'draft', revisionOfQuoteId: 'parent-1' });
    claimQuoteSentMock.mockResolvedValue({
      quoteNumber: 'Q-2026-0001-R2',
      superseded: { parentQuoteId: 'parent-1', previousStatus: 'sent' },
    });
    const res = await acceptQuote(onBehalfParams);
    expect(res.superseded).toEqual({ parentQuoteId: 'parent-1', previousStatus: 'sent' });
  });

  it('computes the same content hash as the customer path for the same quote', async () => {
    queueAcceptHappyPath();
    await acceptQuote(baseParams);
    const customerHash = ((db as unknown as Chain).values.mock.calls[0]![0] as Record<string, unknown>).quoteSha256;
    results.length = 0;
    vi.clearAllMocks();
    stagePax8OrderFromQuoteMock.mockResolvedValue({ orderId: null, lineCount: 0 });
    queueAcceptHappyPath();
    await acceptQuote(onBehalfParams);
    const onBehalfHash = ((db as unknown as Chain).values.mock.calls[0]![0] as Record<string, unknown>).quoteSha256;
    expect(onBehalfHash).toBe(customerHash);
  });
});
```

  Extend the `Chain` type in this file with `values` (it is already in
  `quoteAcceptService.test.ts`'s `Chain`).

- [ ] **Step 2: Run them — expect RED.**

```bash
cd apps/api && npx vitest run src/services/quoteAcceptService.onBehalf.test.ts
```

  Expected first failure: the acceptance insert has no `origin` property.

- [ ] **Step 3: Extend `AcceptQuoteParams`** (line 29):

```ts
export interface AcceptQuoteParams {
  quoteId: string;
  signerName: string;
  signerEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  acceptanceTokenJti?: string | null;
  actorUserId?: string | null;
  /** Who produced this acceptance. 'customer' (the default) is a portal or
   *  public-link click; 'on_behalf' is an MSP tech recording an agreement
   *  reached elsewhere (spec 2026-09-21). The two differ in exactly three
   *  places: the eligible statuses, whether a draft is claimed inline, and
   *  whether the acceptance provider runs. Everything after the acceptance
   *  insert is identical. */
  origin?: 'customer' | 'on_behalf';
  /** on_behalf: the request enum (verbal|email|signed_document|
   *  purchase_order|other). Ignored on the customer path, which takes the
   *  provider's own method. */
  method?: string | null;
  /** on_behalf only: where a dispute reviewer would find the agreement.
   *  Required by the route schema; the DB CHECK is the backstop. */
  reference?: string | null;
  contractRenderData?: ContractBlockRenderData[];
}
```

  Add `superseded?: QuoteSupersedeResult` to `AcceptQuoteResult` (line 47), so
  the route can audit a revision retired by an on-behalf accept the same way
  `/send` does.

- [ ] **Step 4: Replace the status guard** (line 173):

```ts
  const origin = params.origin ?? 'customer';
  // The on-behalf path may accept a DRAFT: the tech closed the deal before the
  // proposal ever went out, and making them send it first would email the
  // customer a live accept link for something already agreed. It is claimed to
  // 'sent' below — frozen and customer-bound, with no link minted.
  const acceptableStatuses = origin === 'on_behalf'
    ? ['draft', 'sent', 'viewed']
    : ['sent', 'viewed'];
  if (!acceptableStatuses.includes(quote.status)) {
    // 'expired' and 'declined' are terminal for this action and Revise is the
    // path forward — say so, rather than reporting a bare INVALID_STATE the
    // tech cannot act on. Everything else keeps the pre-existing code.
    if (origin === 'on_behalf' && (quote.status === 'expired' || quote.status === 'declined')) {
      throw new QuoteServiceError(
        `This quote is ${quote.status} and can no longer be accepted — use Revise to issue a new version.`,
        409, 'QUOTE_NOT_ACCEPTABLE',
      );
    }
    throw new QuoteServiceError(`Cannot accept a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }
```

  Note the ordering: the existing `superseded` / `publicLinkRevokedAt` 410
  (line 170) stays ABOVE this, and the `isQuoteExpired` 410 (line 179) stays
  below it, both unchanged.

- [ ] **Step 5: Claim the draft** immediately after the expiry guard
      (after line 181), before the blocks/lines reads:

```ts
  // Draft claim (spec §5). Runs BEFORE the content reads so the blocks and
  // lines this accept hashes are read from a quote already frozen and
  // customer-bound — the same order sendQuote establishes. Inside the caller's
  // transaction, so a later failure rolls the claim back with everything else.
  let supersededByClaim: QuoteSupersedeResult | undefined;
  if (origin === 'on_behalf' && quote.status === 'draft') {
    let parentToSupersede: { id: string; status: SupersedableStatus } | null = null;
    if (quote.revisionOfQuoteId) {
      const [parent] = await db.select({ id: quotes.id, status: quotes.status })
        .from(quotes)
        .where(and(eq(quotes.id, quote.revisionOfQuoteId), eq(quotes.orgId, quote.orgId)))
        .limit(1)
        .for('update');
      if (!parent) throw new QuoteServiceError('Original quote not found', 409, 'INVALID_STATE');
      if (parent.status === 'converted' || parent.status === 'accepted') {
        throw new QuoteServiceError(
          'The original quote was accepted while this revision was being drafted — it can no longer be accepted',
          409, 'PARENT_CONVERTED');
      }
      if (!isSupersedable(parent.status)) {
        throw new QuoteServiceError(`Cannot supersede a quote in status ${parent.status}`, 409, 'INVALID_STATE');
      }
      parentToSupersede = { id: parent.id, status: parent.status };
    }
    // No acceptTokenColumns: nothing the customer could act on is minted. A
    // customer holding the PARENT's link must not be able to accept it after
    // the tech accepted the child, which is what the supersede above closes.
    const claim = await claimQuoteSent(quote, { now, parentToSupersede });
    supersededByClaim = claim.superseded;
    // The in-memory row predates the freeze; overlay the committed values so
    // the content hash, the contract variables and the issued invoice all see
    // the same customer/seller identity a later re-read would.
    Object.assign(quote, {
      status: 'sent',
      quoteNumber: claim.quoteNumber,
      issueDate: claim.issueDate,
      billToName: claim.billToName,
      billToAddress: claim.billToAddress,
      billToTaxId: claim.billToTaxId,
      sellerSnapshot: claim.sellerSnapshot,
      presentationSnapshot: claim.presentationSnapshot,
      documentLocale: claim.documentLocale,
      termsAndConditions: claim.termsAndConditions,
      terms: claim.terms,
    });
  }
```

  Add the imports: `claimQuoteSent` from `./quoteLifecycle`, and
  `isSupersedable`, `type SupersedableStatus`, `type QuoteSupersedeResult` from
  `./quoteTypes` / `./quoteLifecycle` as appropriate. **Watch for an import
  cycle** — `quoteLifecycle.ts` does not import `quoteAcceptService.ts` today,
  so a one-way import is fine; verify with
  `grep -n "quoteAcceptService" apps/api/src/services/quoteLifecycle.ts`
  (expect no hits) before committing.

- [ ] **Step 6: Replace the capture + insert** (lines 269-296):

```ts
  // The on-behalf path builds the capture result directly rather than routing
  // through getAcceptanceProvider(). The provider abstraction represents HOW
  // THE CUSTOMER SIGNED; an MSP-recorded acceptance is not a signature, and
  // labelling it 'typed-signature' would put a claim the customer never made
  // into the permanent record.
  const captured = origin === 'on_behalf'
    ? {
        signerName: params.signerName.trim(),
        signerEmail: params.signerEmail?.trim() || null,
        method: params.method ?? 'other',
      }
    : await getAcceptanceProvider().capture({
        quoteId: quote.id,
        signerName: params.signerName,
        signerEmail: params.signerEmail,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        acceptanceTokenJti: params.acceptanceTokenJti,
      });

  // 1. Record the acceptance.
  const [acceptance] = await db
    .insert(quoteAcceptances)
    .values({
      quoteId: quote.id,
      orgId: quote.orgId,
      signerName: captured.signerName,
      signerEmail: captured.signerEmail,
      // Defense-in-depth: routes already resolve a single validated client IP,
      // but ip_address is varchar(64) — clamp so a stray long value can never
      // overflow and roll back the whole accept (C1). On the on-behalf path
      // this is the TECH's IP and user agent, not the customer's.
      ipAddress: params.ipAddress ? params.ipAddress.slice(0, 64) : null,
      userAgent: params.userAgent ?? null,
      quoteSha256,
      hashVersion: 2,
      acceptanceTokenJti: params.acceptanceTokenJti ?? null,
      renderLocale,
      origin,
      method: captured.method,
      reference: origin === 'on_behalf' ? (params.reference ?? null) : null,
      recordedByUserId: origin === 'on_behalf' ? (params.actorUserId ?? null) : null,
    })
    .returning({ id: quoteAcceptances.id });
```

  And add `superseded: supersededByClaim` to the returned
  `AcceptQuoteResult` object (line 550).

- [ ] **Step 7: Carry the origin onto the events bus.** In
      `services/quoteEvents.ts`:

```ts
export interface QuoteEvent {
  type: 'quote.viewed' | 'quote.accepted' | 'quote.declined';
  quoteId: string;
  orgId: string;
  partnerId: string;
  /** For an accept: who produced it. Absent on older emitters. An integration
   *  consuming this bus must be able to tell an MSP-recorded acceptance from a
   *  customer click without re-reading the acceptance row. */
  origin?: 'customer' | 'on_behalf';
  /** The tech who recorded an on-behalf acceptance. Null for a customer one. */
  actorUserId?: string | null;
}
```

  In `services/quoteOutcomeNotify.ts`, extend the input and the emit:

```ts
export async function notifyQuoteOutcome(input: {
  quoteId: string;
  outcome: 'accepted' | 'declined';
  source: 'customer' | 'msp';
  signerName?: string | null;
  /** Rides onto the bus event so an integration can distinguish an
   *  MSP-recorded acceptance (spec 2026-09-21 §5). */
  origin?: 'customer' | 'on_behalf';
  actorUserId?: string | null;
}): Promise<void> {
```

```ts
      await emitQuoteEvent({
        type: input.outcome === 'accepted' ? 'quote.accepted' : 'quote.declined',
        quoteId: input.quoteId, orgId: q.orgId, partnerId: q.partnerId,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      });
```

  `source: 'msp'` already returns right after the emit (line 50) with no
  creator email — which is exactly the contract the spec wants: a self-inflicted
  outcome needs no notification.

- [ ] **Step 8: Run — expect GREEN**, with the pre-existing accept suite too:

```bash
cd apps/api && npx vitest run src/services/quoteAcceptService.onBehalf.test.ts src/services/quoteAcceptService.test.ts src/services/quoteOutcomeNotify.test.ts
```

  (Drop `quoteOutcomeNotify.test.ts` from the command if no such file exists.)

- [ ] **Step 9: Commit.**

```bash
git add apps/api/src/services/quoteAcceptService.ts apps/api/src/services/quoteAcceptService.onBehalf.test.ts apps/api/src/services/quoteEvents.ts apps/api/src/services/quoteOutcomeNotify.ts
git commit -m "feat(quotes): accept a quote on a customer's behalf

acceptQuote takes origin/method/reference and populates actorUserId. The
on_behalf origin may accept a draft (claimed inline through claimQuoteSent —
frozen and customer-bound, no link minted), rejects expired/declined with a
409 that names Revise, and builds the acceptance capture directly instead of
routing through the typed-signature provider, which would label an
MSP-recorded acceptance as a signature the customer produced.

Everything after the acceptance insert is untouched: invoice issue, status
flip, contracts, executed documents, Pax8 staging. The content hash is
identical to the customer path, so tamper-evidence works the same for both.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Audit SSOT — `services/quoteAcceptOnBehalfAudit.ts`

**Files:**
- Create: `apps/api/src/services/quoteAcceptOnBehalfAudit.ts` (mirrors
  `services/quoteSupersedeAudit.ts`, 43 lines)
- Create: `apps/api/src/services/quoteAcceptOnBehalfAudit.test.ts`

**Interfaces:**
- Consumes: `RouteAuditInput` from `./auditEvents` (line 129).
- Produces: `acceptedOnBehalfAuditEvent(args): RouteAuditInput` with
  `action: 'quote.accepted_on_behalf'`. Consumed by Task 8's route via
  `writeRouteAudit(c, …)`.

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from 'vitest';
import { acceptedOnBehalfAuditEvent } from './quoteAcceptOnBehalfAudit';

describe('acceptedOnBehalfAuditEvent', () => {
  const args = {
    quoteId: 'q1', orgId: 'org1',
    method: 'purchase_order', reference: 'PO 4471',
    signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
    invoiceId: 'inv1', invoiceNumber: 'INV-2026-0042',
    contractIds: ['c1', 'c2'], wasDraft: true,
  };

  it('records the act against the quote whose status changed', () => {
    expect(acceptedOnBehalfAuditEvent(args)).toEqual({
      orgId: 'org1',
      action: 'quote.accepted_on_behalf',
      resourceType: 'quote',
      resourceId: 'q1',
      result: 'success',
      details: {
        method: 'purchase_order', reference: 'PO 4471',
        signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
        invoiceId: 'inv1', invoiceNumber: 'INV-2026-0042',
        contractIds: ['c1', 'c2'], wasDraft: true,
      },
    });
  });

  // wasDraft is the reviewer's flag for "the customer never saw this document
  // before the invoice" — it must be present even when false, not omitted.
  it('keeps wasDraft: false rather than dropping it', () => {
    expect(acceptedOnBehalfAuditEvent({ ...args, wasDraft: false }).details).toMatchObject({ wasDraft: false });
  });

  it('normalises an absent signer email and invoice number to null', () => {
    const e = acceptedOnBehalfAuditEvent({ ...args, signerEmail: undefined, invoiceNumber: null });
    expect(e.details).toMatchObject({ signerEmail: null, invoiceNumber: null });
  });
});
```

- [ ] **Step 2: Run it — expect RED** (module not found).

```bash
cd apps/api && npx vitest run src/services/quoteAcceptOnBehalfAudit.test.ts
```

- [ ] **Step 3: Implement.**

```ts
import { type RouteAuditInput } from './auditEvents';

/**
 * Single source of truth for the `quote.accepted_on_behalf` audit payload.
 *
 * Customer-initiated accepts are audit-less by design — they are anonymous, and
 * the acceptance row IS their record. An MSP-recorded acceptance is the
 * opposite: a named user committed the customer to an invoice, so it gets a
 * first-class audit row naming the evidence.
 *
 * This RETURNS the payload rather than writing it, mirroring
 * quoteSupersedeAudit.ts: the right writer differs by call path. The route uses
 * `writeRouteAudit`, which attributes the acting user from the Hono auth
 * context; writing from here would silently anonymise it. There is one caller
 * today, but the shape being unit-testable without HTTP is the point.
 *
 * `reference` is deliberately included verbatim: it is the whole evidence
 * trail, and an audit row that says an acceptance was recorded without saying
 * what it was recorded against is not worth writing.
 */
export function acceptedOnBehalfAuditEvent(args: {
  quoteId: string;
  orgId: string;
  method: string;
  reference: string;
  signerName: string;
  signerEmail?: string | null;
  invoiceId: string;
  /** Null for a degenerate recurring-only quote, which issues no invoice. */
  invoiceNumber?: string | null;
  contractIds: string[];
  /** True when the quote was a draft the accept claimed inline — i.e. the
   *  customer's first sight of this document will be the invoice. */
  wasDraft: boolean;
}): RouteAuditInput {
  return {
    orgId: args.orgId,
    action: 'quote.accepted_on_behalf',
    resourceType: 'quote',
    resourceId: args.quoteId,
    result: 'success',
    details: {
      method: args.method,
      reference: args.reference,
      signerName: args.signerName,
      signerEmail: args.signerEmail ?? null,
      invoiceId: args.invoiceId,
      invoiceNumber: args.invoiceNumber ?? null,
      contractIds: args.contractIds,
      wasDraft: args.wasDraft,
    },
  };
}
```

- [ ] **Step 4: Run — expect GREEN.**

```bash
cd apps/api && npx vitest run src/services/quoteAcceptOnBehalfAudit.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/quoteAcceptOnBehalfAudit.ts apps/api/src/services/quoteAcceptOnBehalfAudit.test.ts
git commit -m "feat(quotes): SSOT payload for the quote.accepted_on_behalf audit event

Mirrors quoteSupersedeAudit: returns the payload rather than writing it, so the
route's writeRouteAudit still attributes the acting tech, and the shape is
unit-testable without HTTP.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `POST /quotes/:id/accept-on-behalf`

**Files:**
- Modify: `apps/api/src/routes/quotes/lifecycle.ts` — new `acceptPerm` beside
  `sendPerm` (line 21), new route after `/:id/send` (line 101)
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.ts` — add the
  route beside the `/quotes/:id/send` entry (line 265)
- Test: `apps/api/src/routes/quotes/lifecycle.test.ts` (extend; it already has
  the real-`requirePermission` + mocked-`getUserPermissions` harness and the
  `appWith(scope, perms)` helper at line 92)

**Interfaces:**
- Consumes: `PERMISSIONS.QUOTES_ACCEPT` (Task 1),
  `acceptQuoteOnBehalfSchema` (Task 4), `acceptQuote` (Task 6),
  `acceptedOnBehalfAuditEvent` (Task 7), and the existing
  `emitAcceptInvoiceIssued` / `resolveAcceptInvoiceUrl` /
  `autoEmailAcceptedInvoice` / `notifyQuoteOutcome`.
- Produces: `{ data: { quote, invoiceId, invoiceIssued, contractIds, payUrl } }`
  — the portal accept's shape. Consumed by Task 11's web wrapper.

- [ ] **Step 1: Write the failing tests.** Append to
      `apps/api/src/routes/quotes/lifecycle.test.ts`. First extend the existing
      mock block near the top with the accept-path modules:

```ts
vi.mock('../../services/quoteAcceptService', () => ({
  acceptQuote: vi.fn(async () => ({
    quote: { id: 'q1', orgId: 'org1', status: 'converted', quoteNumber: 'Q-2026-0001' },
    acceptanceId: 'acc1', invoiceId: 'inv1', invoiceIssued: true,
    contractIds: ['c1'], pax8OrderId: null, contractDocumentIds: [], superseded: undefined,
  })),
  emitAcceptInvoiceIssued: vi.fn(),
  resolveAcceptInvoiceUrl: vi.fn(async () => 'https://portal.example/invoice/tok'),
  autoEmailAcceptedInvoice: vi.fn(),
}));
vi.mock('../../services/quoteOutcomeNotify', () => ({ notifyQuoteOutcome: vi.fn() }));
```

  then the suite:

```ts
describe('POST /:id/accept-on-behalf', () => {
  const BODY = {
    method: 'purchase_order', reference: 'PO 4471',
    signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
  };
  const jsonReq = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeEach(() => {
    vi.mocked(getQuote).mockResolvedValue({
      quote: { id: QUOTE_ID, orgId: 'org1', partnerId: 'p1', status: 'sent', quoteNumber: 'Q-2026-0001' },
      blocks: [], lines: [],
    } as never);
  });

  // D3: accepting is separately revocable from sending. A role that can send
  // must not silently gain the money-committing action.
  it('403s a quotes:send holder without quotes:accept', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write', 'quotes:send'])
      .request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(403);
  });

  it('200s a quotes:accept holder', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:accept'])
      .request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(200);
  });

  it('403s an organization-scoped token even with quotes:accept', async () => {
    const res = await appWith('organization', ['quotes:accept'])
      .request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(403);
  });

  it('400s a missing reference', async () => {
    const { reference: _drop, ...rest } = BODY;
    const res = await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(rest));
    expect(res.status).toBe(400);
  });

  it('400s an unknown method', async () => {
    const res = await appWith('partner', ['quotes:accept'])
      .request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq({ ...BODY, method: 'telepathy' }));
    expect(res.status).toBe(400);
  });

  it('forwards the origin, the body and the acting user to acceptQuote', async () => {
    const { acceptQuote } = await import('../../services/quoteAcceptService');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(acceptQuote)).toHaveBeenCalledWith(expect.objectContaining({
      quoteId: QUOTE_ID, origin: 'on_behalf',
      method: 'purchase_order', reference: 'PO 4471',
      signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
      actorUserId: 'u1',
    }));
  });

  it('writes the SSOT audit payload', async () => {
    const { writeRouteAudit } = await import('../../services/auditEvents');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'quote.accepted_on_behalf',
      resourceType: 'quote',
      resourceId: QUOTE_ID,
      details: expect.objectContaining({ method: 'purchase_order', reference: 'PO 4471', wasDraft: false }),
    }));
  });

  it('reports wasDraft when the quote was a draft before the accept', async () => {
    vi.mocked(getQuote).mockResolvedValue({
      quote: { id: QUOTE_ID, orgId: 'org1', partnerId: 'p1', status: 'draft' }, blocks: [], lines: [],
    } as never);
    const { writeRouteAudit } = await import('../../services/auditEvents');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ wasDraft: true }) }));
  });

  // §5: 'msp' emits the bus event and sends NO creator email — the actor
  // already knows, they did it.
  it('notifies the outcome as msp-sourced, carrying the origin', async () => {
    const { notifyQuoteOutcome } = await import('../../services/quoteOutcomeNotify');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(notifyQuoteOutcome)).toHaveBeenCalledWith(expect.objectContaining({
      quoteId: QUOTE_ID, outcome: 'accepted', source: 'msp',
      origin: 'on_behalf', actorUserId: 'u1',
    }));
  });

  it('answers the portal accept shape', async () => {
    const res = await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    const body = await res.json();
    expect(body.data).toMatchObject({
      invoiceId: 'inv1', invoiceIssued: true, contractIds: ['c1'],
      payUrl: 'https://portal.example/invoice/tok',
    });
    expect(body.data.quote.status).toBe('converted');
  });
});
```

  Add a matching guard test in
  `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts` if one exists
  (grep for it); otherwise assert the predicate inline in the suite above:

```ts
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';

it('opts out of the ambient request transaction', () => {
  // runOutsideDbContext only re-points the ALS db proxy — the middleware's
  // outer transaction would still be held across the accept, pinning a second
  // pooled connection (#1105 class).
  expect(isSelfManagedDbContextRoute('POST', `/api/v1/quotes/${QUOTE_ID}/accept-on-behalf`)).toBe(true);
});
```

  (Use whatever the module actually exports — read it before writing this
  import.)

- [ ] **Step 2: Run them — expect RED.**

```bash
cd apps/api && npx vitest run src/routes/quotes/lifecycle.test.ts
```

  Expected failure: 404 instead of 403/200 — the route does not exist.

- [ ] **Step 3: Register the self-managed route.** In
      `apps/api/src/middleware/selfManagedDbContextRoutes.ts`, beside the
      `/quotes/:id/send` entry (line 265):

```ts
  // Accept on behalf (spec 2026-09-21 §4). The handler runs the accept under
  // runOutsideDbContext(withSystemDbAccessContext(...)) because
  // partner_invoice_sequences is partner-axis and the whole accept must be one
  // transaction. runOutsideDbContext alone does NOT release the middleware's
  // ambient transaction, so without this entry the request pins TWO pooled
  // connections for the length of the accept. The handler opens its own short
  // withAuthDbAccessContext for the org-scoped lookup instead.
  { method: 'POST', pattern: /^\/api\/v1\/quotes\/[^/]+\/accept-on-behalf\/?$/ },
```

- [ ] **Step 4: Implement the route.** In
      `apps/api/src/routes/quotes/lifecycle.ts`, add the permission beside
      `sendPerm` (line 21):

```ts
const acceptPerm = requirePermission(PERMISSIONS.QUOTES_ACCEPT.resource, PERMISSIONS.QUOTES_ACCEPT.action);
```

  and the route after `/:id/send` (line 101):

```ts
// POST /:id/accept-on-behalf — the tech closed the deal on the phone, by email
// or on a signed PO, and records the customer's acceptance in-app. Runs the
// EXACT conversion pipeline a customer click runs (invoice numbered + issued at
// the quote's frozen totals and tax, recurring lines drafted as contracts, Pax8
// staged); the only differences are the eligible statuses, the inline draft
// claim, and the provenance stored on the acceptance row.
//
// Gated on quotes:accept, NOT quotes:send: this is the money-committing act,
// and an MSP may want it narrower than sending. Org access is enforced by the
// auth scope plus the org-scoped getQuote below, BEFORE the handler enters
// system context.
//
// Registered in SELF_MANAGED_DB_CONTEXT_ROUTES, so the auth middleware opens no
// ambient transaction: the lookup runs in a short withAuthDbAccessContext and
// the accept in its own system context. partner_invoice_sequences is
// partner-axis, invisible to an org-scoped context (#1375), and the whole
// accept must be ONE transaction — the same reason routes/portal/quotes.ts
// wraps its accept this way.
quoteLifecycleRoutes.post('/:id/accept-on-behalf',
  scopes, acceptPerm,
  zValidator('param', idParam), zValidator('json', acceptQuoteOnBehalfSchema),
  async (c) => {
    const id = c.req.valid('param').id;
    const body = c.req.valid('json');
    const auth = c.get('auth') as AuthContext;
    const actorUserId = auth.user?.id ?? null;
    try {
      // Org-access 404 + the pre-accept status, in the request's own scope.
      // Contract-block render data is pre-fetched here, OUTSIDE the accept
      // transaction: loadContractBlockRenderData resolves pinned template
      // versions under a SYSTEM context (the dual-axis template rows are
      // invisible to an org scope), and acceptQuote hard-fails if a contract
      // block is missing from the set.
      const { quote, blocks } = await withAuthDbAccessContext(auth, () => getQuote(id, quoteActorFrom(c)));
      const wasDraft = quote.status === 'draft';
      const contractRenderData = await loadContractBlockRenderData(blocks, { includeFileData: true });

      const res = await runOutsideDbContext(() => withSystemDbAccessContext(() => acceptQuote({
        quoteId: id,
        signerName: body.signerName,
        signerEmail: body.signerEmail ?? null,
        ipAddress: getTrustedClientIpOrUndefined(c) ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        actorUserId,
        origin: 'on_behalf',
        method: body.method,
        reference: body.reference,
        contractRenderData,
      })));

      // Post-commit, outside the DB context — identical to the portal accept.
      await emitAcceptInvoiceIssued(res, actorUserId);
      const payUrl = await resolveAcceptInvoiceUrl(res);
      // Both end in SMTP round trips and must never delay the response; both
      // swallow their own errors. source 'msp' emits the bus event and sends NO
      // creator email — the tech who did this already knows.
      void autoEmailAcceptedInvoice(res);
      void notifyQuoteOutcome({
        quoteId: id, outcome: 'accepted', source: 'msp',
        signerName: body.signerName, origin: 'on_behalf', actorUserId,
      });

      writeRouteAudit(c, acceptedOnBehalfAuditEvent({
        quoteId: id,
        orgId: res.quote.orgId,
        method: body.method,
        reference: body.reference,
        signerName: body.signerName,
        signerEmail: body.signerEmail ?? null,
        invoiceId: res.invoiceId,
        invoiceNumber: res.quote.quoteNumber ?? null,
        contractIds: res.contractIds,
        wasDraft,
      }));
      // Retiring a revision's parent is a separate, independently-auditable act
      // — the same rule /send follows.
      if (res.superseded) {
        writeRouteAudit(c, supersededAuditEvent({
          childQuoteId: id,
          orgId: res.quote.orgId,
          parentQuoteId: res.superseded.parentQuoteId,
          previousStatus: res.superseded.previousStatus,
          revisionNumber: res.quote.revisionNumber,
          emailed: false,
        }));
      }

      return c.json({ data: {
        quote: res.quote,
        invoiceId: res.invoiceId,
        invoiceIssued: res.invoiceIssued,
        contractIds: res.contractIds,
        payUrl,
      } });
    } catch (err) { return handleServiceError(c, err); }
  });
```

  **`invoiceNumber` correction:** `res.quote.quoteNumber` is the QUOTE number,
  not the invoice's. Read the issued invoice number from the accept result if
  Task 6 exposes it; otherwise add `invoiceNumber: string | null` to
  `AcceptQuoteResult` in Task 6 (set from `issueFields.invoiceNumber ?? null`
  at `quoteAcceptService.ts:392`) and use it here. Do this — an audit row that
  names the quote number in an `invoiceNumber` field is worse than an absent
  one. Adjust Task 6's commit if you reach this point first.

  Add the imports at the top of `lifecycle.ts`:

```ts
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { acceptQuoteOnBehalfSchema } from '@breeze/shared';
import { acceptQuote, emitAcceptInvoiceIssued, resolveAcceptInvoiceUrl, autoEmailAcceptedInvoice } from '../../services/quoteAcceptService';
import { notifyQuoteOutcome } from '../../services/quoteOutcomeNotify';
import { acceptedOnBehalfAuditEvent } from '../../services/quoteAcceptOnBehalfAudit';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
```

- [ ] **Step 5: Run — expect GREEN.**

```bash
cd apps/api && npx vitest run src/routes/quotes/lifecycle.test.ts
```

- [ ] **Step 6: Typecheck the API package** (the new route touches several
      service signatures):

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 7: Commit.**

```bash
git add apps/api/src/routes/quotes/lifecycle.ts apps/api/src/routes/quotes/lifecycle.test.ts apps/api/src/middleware/selfManagedDbContextRoutes.ts
git commit -m "feat(api): POST /quotes/:id/accept-on-behalf

Gated on quotes:accept (not quotes:send — this is the money-committing act and
must be separately revocable). Org access comes from the auth scope plus the
org-scoped getQuote before the handler enters system context; the route opts
out of the ambient request transaction so the accept does not pin a second
pooled connection behind it.

Writes one quote.accepted_on_behalf audit row through the SSOT payload, plus
the usual quote.superseded row when the accept retired a revision's parent.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Serializers — expose the acceptance record

**Files:**
- Modify: `apps/api/src/routes/quotes/quotes.ts` — the `GET /:id` handler
  (line 118), response object at line 179
- Modify: `apps/api/src/routes/portal/quotes.ts` — the `GET /quotes/:id`
  handler's response
- Test: `apps/api/src/routes/quotes/quotes.acceptance.test.ts` (new) and
  `apps/api/src/routes/portal/quotes.acceptance.test.ts` (new)

**Interfaces:**
- Produces (admin): `data.acceptance` —
  `{ id, signerName, signerEmail, signedAt, origin, method, reference,
  recordedBy: { id, name } | null } | null`. Consumed by Task 11.
- Produces (portal): `data.quote.acceptanceOrigin: 'customer' | 'on_behalf' | null`.
  Consumed by Task 12. **Origin only** — method and reference are internal
  detail the customer must not see.

- [ ] **Step 1: Write the failing tests.** In
      `apps/api/src/routes/quotes/quotes.acceptance.test.ts`, drive the mounted
      `GET /:id` with a mocked `getQuote` and a queued acceptance row, and
      assert:

```ts
  it('returns the acceptance record with its provenance and the recorder name', async () => {
    // … mount quoteCrudRoutes with quotes:read, queue one quote_acceptances row
    const body = await (await app.request(`/${QUOTE_ID}`)).json();
    expect(body.data.acceptance).toMatchObject({
      origin: 'on_behalf', method: 'purchase_order', reference: 'PO 4471',
      signerName: 'Dana Buyer',
      recordedBy: { id: 'tech-1', name: 'Sam Tech' },
    });
  });

  it('returns null acceptance for a quote nobody has accepted', async () => {
    const body = await (await app.request(`/${QUOTE_ID}`)).json();
    expect(body.data.acceptance).toBeNull();
  });

  // ON DELETE SET NULL means an on-behalf row can outlive its recorder. The
  // page must render "by a deleted user", not crash.
  it('survives a deleted recorder', async () => {
    const body = await (await app.request(`/${QUOTE_ID}`)).json();
    expect(body.data.acceptance.recordedBy).toBeNull();
  });
```

  And in `apps/api/src/routes/portal/quotes.acceptance.test.ts`:

```ts
  it('exposes the acceptance origin and nothing else', async () => {
    const body = await (await app.request(`/quotes/${QUOTE_ID}`)).json();
    expect(body.data.quote.acceptanceOrigin).toBe('on_behalf');
    // Method and reference are the MSP's internal evidence trail. Leaking them
    // to the customer's portal would publish free text a tech wrote about them.
    expect(JSON.stringify(body.data)).not.toContain('PO 4471');
    expect(JSON.stringify(body.data)).not.toContain('purchase_order');
  });
```

  Follow the mocking shape already used by the closest existing route test for
  each file — read it first rather than inventing a harness.

- [ ] **Step 2: Run them — expect RED.**

```bash
cd apps/api && npx vitest run src/routes/quotes/quotes.acceptance.test.ts src/routes/portal/quotes.acceptance.test.ts
```

- [ ] **Step 3: Implement the admin serializer.** In
      `routes/quotes/quotes.ts`, before the `return c.json(...)` at line 179:

```ts
    // The acceptance record. Not previously returned at all: an accepted quote
    // showed only a bare `Accepted` lifecycle stamp, with no signer, no method
    // and — once accept-on-behalf exists — no way to tell an MSP-recorded
    // acceptance from a customer click. Left-joined to `users` so a recorder
    // deleted since (ON DELETE SET NULL) reads as "unknown" rather than
    // dropping the whole row.
    const [acceptanceRow] = await db
      .select({
        id: quoteAcceptances.id,
        signerName: quoteAcceptances.signerName,
        signerEmail: quoteAcceptances.signerEmail,
        signedAt: quoteAcceptances.signedAt,
        origin: quoteAcceptances.origin,
        method: quoteAcceptances.method,
        reference: quoteAcceptances.reference,
        recordedByUserId: quoteAcceptances.recordedByUserId,
        recordedByName: users.name,
      })
      .from(quoteAcceptances)
      .leftJoin(users, eq(users.id, quoteAcceptances.recordedByUserId))
      .where(eq(quoteAcceptances.quoteId, id))
      .orderBy(quoteAcceptances.signedAt)
      .limit(1);
    const acceptance = acceptanceRow
      ? {
          id: acceptanceRow.id,
          signerName: acceptanceRow.signerName,
          signerEmail: acceptanceRow.signerEmail,
          signedAt: acceptanceRow.signedAt,
          origin: acceptanceRow.origin,
          method: acceptanceRow.method,
          reference: acceptanceRow.reference,
          recordedBy: acceptanceRow.recordedByUserId
            ? { id: acceptanceRow.recordedByUserId, name: acceptanceRow.recordedByName ?? null }
            : null,
        }
      : null;
```

  and add `acceptance` to the response object:

```ts
    return c.json({ data: {
      ...detail, quote: quoteForClient, blocks: blocksForEditor, branding, presentation, recipients,
      acceptance,
      stripeConnected, stripeAccountCurrency, currencyWarning,
    } });
```

  Add the `quoteAcceptances` and `users` imports. Confirm `users.name` is the
  display-name column in `db/schema/users.ts` (it may be `name` or
  `firstName`/`lastName` — read it and use whatever the rest of the app uses
  for a display name).

- [ ] **Step 4: Implement the portal serializer.** In
      `routes/portal/quotes.ts`, inside the `GET /quotes/:id` handler, before
      the `return c.json(...)`:

```ts
    // Origin ONLY. The method and the reference are the MSP's internal evidence
    // trail — free text a tech wrote about this customer — and publishing them
    // in the customer's own portal would be a disclosure, not a courtesy.
    const [acceptance] = await db
      .select({ origin: quoteAcceptances.origin })
      .from(quoteAcceptances)
      .where(and(eq(quoteAcceptances.quoteId, id), eq(quoteAcceptances.orgId, auth.user.orgId)))
      .orderBy(quoteAcceptances.signedAt)
      .limit(1);
```

  and add `acceptanceOrigin: acceptance?.origin ?? null` to the `quote` object
  in the response (beside `supersededByQuoteId`).

- [ ] **Step 5: Run — expect GREEN**, with the sibling route suites:

```bash
cd apps/api && npx vitest run src/routes/quotes/quotes.acceptance.test.ts src/routes/portal/quotes.acceptance.test.ts src/routes/quotes/quotes.test.ts src/routes/portal/quotes.test.ts
```

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/routes/quotes/quotes.ts apps/api/src/routes/portal/quotes.ts apps/api/src/routes/quotes/quotes.acceptance.test.ts apps/api/src/routes/portal/quotes.acceptance.test.ts
git commit -m "feat(api): return the quote acceptance record to the tech and its origin to the portal

GET /quotes/:id never returned the acceptance at all, so an accepted quote
showed a bare lifecycle stamp with no signer and no provenance. It now carries
origin/method/reference plus the recorder's display name, left-joined so a
recorder deleted since reads as unknown rather than dropping the row.

The portal gets `acceptanceOrigin` and nothing more: the method and reference
are the MSP's internal evidence trail about this customer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Integration proof against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/quoteAcceptOnBehalf.integration.test.ts`
  (shape copied from `quoteAccept.integration.test.ts`)

**Interfaces:**
- Consumes: `createQuote`, `addManualLine` (`services/quoteService`),
  `acceptQuote` (`services/quoteAcceptService`), `createPartner`,
  `createOrganization` (`./db-utils`).

Note: the harness connects to an already-migrated test database
(`setup.ts` loads `.env.test` and opens the pool), so there is **no per-file
`readFileSync` migration replay** — see "Spec deviations resolved", item 4.

- [ ] **Step 1: Write the failing test.**

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteAcceptances, quoteRecipients } from '../../db/schema/quotes';
import { invoices } from '../../db/schema/invoices';
import { contracts } from '../../db/schema/contracts';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { acceptQuote } from '../../services/quoteAcceptService';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);
function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function actorFor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}
async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partner, org };
  });
}

describe('accept on behalf — draft straight to issued invoice', () => {
  runDb('claims the draft, issues the invoice at the quote totals and records provenance', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);

    const created = await withDbAccessContext(ctx, () =>
      createQuote({ orgId: org.id, currencyCode: 'USD', taxRate: 10 } as never, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, {
      sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250,
      taxable: true, customerVisible: true, recurrence: 'one_time',
    } as never, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, {
      sourceType: 'manual', description: 'Managed services', quantity: 5, unitPrice: 99,
      taxable: true, customerVisible: true, recurrence: 'monthly',
    } as never, actor));

    // NOT sent. The tech closed it on the phone before it ever went out.
    const before = await withSystemDbAccessContext(() =>
      db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, created.id)));
    expect(before[0]!.status).toBe('draft');

    const res = await withSystemDbAccessContext(() => acceptQuote({
      quoteId: created.id, signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
      ipAddress: '10.0.0.7', userAgent: 'tech-browser',
      origin: 'on_behalf', method: 'purchase_order', reference: 'PO 4471',
      actorUserId: null,
    }));

    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(q!.status).toBe('converted');
    expect(q!.quoteNumber).toBeTruthy();   // claimed, so it carries its number
    expect(q!.sentAt).toBeTruthy();        // frozen and customer-bound
    // Delivery-free: the customer was never handed anything to click.
    expect(q!.acceptTokenJti).toBeNull();
    expect(q!.publicLinkRevokedAt).toBeNull();
    const recips = await withSystemDbAccessContext(() =>
      db.select().from(quoteRecipients).where(eq(quoteRecipients.quoteId, created.id)));
    expect(recips).toHaveLength(0);

    // The invoice is issued at the QUOTE's frozen totals and tax, not the org's
    // current rate — the charge must equal what was agreed.
    const [inv] = await withSystemDbAccessContext(() =>
      db.select().from(invoices).where(eq(invoices.id, res.invoiceId)));
    expect(inv!.status).toBe('sent');
    expect(inv!.invoiceNumber).toBeTruthy();
    expect(inv!.taxRate).toBe(q!.taxRate);
    expect(inv!.subtotal).toBe('250.00');   // only the one-time line
    expect(inv!.total).toBe('275.00');      // 250 + 10%

    // The recurring line became a draft contract.
    expect(res.contractIds).toHaveLength(1);
    const [contract] = await withSystemDbAccessContext(() =>
      db.select().from(contracts).where(eq(contracts.id, res.contractIds[0]!)));
    expect(contract!.status).toBe('draft');

    const [acc] = await withSystemDbAccessContext(() =>
      db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(acc!.origin).toBe('on_behalf');
    expect(acc!.method).toBe('purchase_order');
    expect(acc!.reference).toBe('PO 4471');
    expect(acc!.quoteSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  runDb('refuses a second accept on the same quote (one invoice, not two)', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' } as never, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, {
      sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250,
      taxable: false, customerVisible: true, recurrence: 'one_time',
    } as never, actor));

    const params = {
      quoteId: created.id, signerName: 'Dana Buyer', signerEmail: null,
      origin: 'on_behalf' as const, method: 'verbal', reference: 'call 2026-09-21', actorUserId: null,
    };
    await withSystemDbAccessContext(() => acceptQuote(params));
    await expect(withSystemDbAccessContext(() => acceptQuote(params)))
      .rejects.toMatchObject({ status: 409 });

    const invs = await withSystemDbAccessContext(() =>
      db.select().from(invoices).where(eq(invoices.orgId, org.id)));
    expect(invs).toHaveLength(1);
  });

  runDb('rejects a blank reference at the database, not only at the API', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' } as never, actor));
    // The CHECK is the backstop behind the Zod schema: a future caller that
    // skips validation must still not be able to write an evidence-less record.
    await expect(withSystemDbAccessContext(() => db.insert(quoteAcceptances).values({
      quoteId: created.id, orgId: org.id, signerName: 'X',
      quoteSha256: 'a'.repeat(64), hashVersion: 2,
      origin: 'on_behalf', method: 'verbal', reference: null, recordedByUserId: null,
    } as never))).rejects.toThrow(/quote_acceptances_reference_chk/);
  });
});
```

- [ ] **Step 2: Bring up a stack and run it — expect RED.**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteAcceptOnBehalf.integration.test.ts
```

  (If Tasks 2-6 are already landed this may pass immediately — in that case
  temporarily revert the `origin` column default in a scratch DB, or accept a
  green and note it; do NOT weaken the assertions to manufacture a red.)

- [ ] **Step 3: Run the contract suites that the new column touches.**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/quoteAccept.integration.test.ts
```

  All five must be green. `tenantCascade` in particular proves the
  `recorded_by_user_id` FK does not block an org erasure.

- [ ] **Step 4: Tear the stack down** (nothing does it for you):

```bash
pnpm test-stack down
```

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/__tests__/integration/quoteAcceptOnBehalf.integration.test.ts
git commit -m "test(quotes): integration proof for accept on behalf

Draft straight to an issued invoice at the quote's own frozen totals and tax
rate, with the recurring line drafted as a contract, nothing minted for the
customer to click, and the provenance columns populated. Plus the double-accept
refusal and the reference CHECK as a backstop behind Zod.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Web — API wrapper, dialog, gating, provenance line

**Files:**
- Modify: `apps/web/src/lib/api/quotes.ts` (beside `resendQuote`, line ~373)
- Create: `apps/web/src/components/billing/quotes/AcceptOnBehalfDialog.tsx`
  (separate file — `QuoteActions.tsx` is already 1551 lines)
- Modify: `apps/web/src/components/billing/quotes/QuoteActions.tsx` — gate
  beside `canSend` (line 887), button + dialog mount in the toolbar
- Modify: `apps/web/src/components/billing/quotes/QuoteDetail.tsx` — provenance
  line after the lifecycle `<dl>` (line 281)
- Modify: `apps/web/src/locales/en/billing.json` — `quotes.actions.acceptOnBehalf.*`
  and `quotes.detail.acceptedOnBehalf`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` — add the new
  component to `TARGET_GLOBS`
- Create: `apps/web/src/components/billing/quotes/QuoteActions.acceptOnBehalf.test.tsx`
- Create: `apps/web/src/components/billing/quotes/QuoteDetail.acceptance.test.tsx`

**Interfaces:**
- Consumes: `POST /quotes/:id/accept-on-behalf` (Task 8), `detail.acceptance`
  (Task 9), `QUOTE_ACCEPT_ON_BEHALF_METHODS` (Task 4).
- Produces: `acceptQuoteOnBehalf(id, body): Promise<Response>` in
  `lib/api/quotes.ts`.

- [ ] **Step 1: Write the failing tests.** Create
      `QuoteActions.acceptOnBehalf.test.tsx`, copying the mock preamble from
      `QuoteActions.resend.test.tsx` (lines 1-38) and its `sent()` fixture
      (lines 40-67), with `usePermissions` made controllable:

```tsx
const perms = vi.hoisted(() => ({ granted: ['quotes:read', 'quotes:send', 'quotes:accept'] }));
vi.mock('../../../lib/permissions', () => ({
  usePermissions: () => ({ can: (r: string, a: string) => perms.granted.includes(`${r}:${a}`) }),
}));
```

```tsx
describe('Accept on behalf', () => {
  beforeEach(() => { perms.granted = ['quotes:read', 'quotes:send', 'quotes:accept']; });

  // Hidden, not disabled, when the permission is missing — matching every other
  // quote action.
  it('hides the button without quotes:accept', () => {
    perms.granted = ['quotes:read', 'quotes:send'];
    render(<QuoteActions detail={sent()} variant="header" refresh={vi.fn()} />);
    expect(screen.queryByTestId('quote-accept-on-behalf')).toBeNull();
  });

  it.each(['draft', 'sent', 'viewed'] as const)('offers the button on %s', (status) => {
    render(<QuoteActions detail={sent({ status })} variant="header" refresh={vi.fn()} />);
    expect(screen.getByTestId('quote-accept-on-behalf')).toBeTruthy();
  });

  it.each(['expired', 'declined', 'converted', 'superseded'] as const)('hides it on %s', (status) => {
    render(<QuoteActions detail={sent({ status })} variant="header" refresh={vi.fn()} />);
    expect(screen.queryByTestId('quote-accept-on-behalf')).toBeNull();
  });

  // "This quote was never sent. The customer's first sight of it will be the
  // invoice." — the one consequence a tech cannot undo by voiding the invoice.
  it('warns about a never-sent draft, and only on a draft', () => {
    render(<QuoteActions detail={sent({ status: 'draft' })} variant="header" refresh={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect(screen.getByTestId('accept-on-behalf-draft-warning')).toBeTruthy();
  });

  it('shows no draft warning on a sent quote', () => {
    render(<QuoteActions detail={sent({ status: 'sent' })} variant="header" refresh={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect(screen.queryByTestId('accept-on-behalf-draft-warning')).toBeNull();
  });

  it('blocks submission until a reference is entered', () => {
    render(<QuoteActions detail={sent()} variant="header" refresh={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect(screen.getByTestId('accept-on-behalf-submit').hasAttribute('disabled')).toBe(true);
  });

  it('prefills the signer name from billToName and never from an email address', () => {
    render(<QuoteActions detail={sent({ billToName: 'Acme Inc.' })} variant="header" refresh={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect((screen.getByTestId('accept-on-behalf-signer-name') as HTMLInputElement).value).toBe('Acme Inc.');
  });

  it('submits the typed body through runAction and refreshes', async () => {
    const refresh = vi.fn();
    render(<QuoteActions detail={sent()} variant="header" refresh={refresh} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    fireEvent.change(screen.getByTestId('accept-on-behalf-method'), { target: { value: 'purchase_order' } });
    fireEvent.change(screen.getByTestId('accept-on-behalf-reference'), { target: { value: 'PO 4471' } });
    fireEvent.click(screen.getByTestId('accept-on-behalf-submit'));
    await waitFor(() => expect(api.acceptQuoteOnBehalf).toHaveBeenCalledWith('q-1', {
      method: 'purchase_order', reference: 'PO 4471',
      signerName: 'Acme Inc.', signerEmail: 'ap@customer.example',
    }));
    expect(runAction).toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
```

  And `QuoteDetail.acceptance.test.tsx`:

```tsx
  it('names the tech and the evidence for an on-behalf acceptance', () => {
    render(<QuoteDetail detail={converted({ acceptance: {
      id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
      origin: 'on_behalf', method: 'purchase_order', reference: 'PO 4471',
      recordedBy: { id: 'tech-1', name: 'Sam Tech' },
    } })} />);
    const line = screen.getByTestId('quote-acceptance-provenance').textContent ?? '';
    expect(line).toContain('Dana Buyer');
    expect(line).toContain('Sam Tech');
    expect(line).toContain('PO 4471');
  });

  it('renders nothing extra for a customer acceptance', () => {
    render(<QuoteDetail detail={converted({ acceptance: {
      id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
      origin: 'customer', method: 'typed-signature', reference: null, recordedBy: null,
    } })} />);
    expect(screen.queryByTestId('quote-acceptance-provenance')).toBeNull();
  });

  // ON DELETE SET NULL: the recorder can be gone.
  it('survives a deleted recorder', () => {
    render(<QuoteDetail detail={converted({ acceptance: {
      id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
      origin: 'on_behalf', method: 'verbal', reference: 'call notes T-0231', recordedBy: null,
    } })} />);
    expect(screen.getByTestId('quote-acceptance-provenance')).toBeTruthy();
  });
```

- [ ] **Step 2: Run them — expect RED.**

```bash
cd apps/web && npx vitest run src/components/billing/quotes/QuoteActions.acceptOnBehalf.test.tsx src/components/billing/quotes/QuoteDetail.acceptance.test.tsx
```

- [ ] **Step 3: Add the API wrapper.** In `apps/web/src/lib/api/quotes.ts`,
      after `resendQuote`:

```ts
/** Record a customer's acceptance on their behalf (POST
 *  /quotes/:id/accept-on-behalf). Gated server-side on quotes:accept. This
 *  runs the full conversion: the invoice is numbered and issued now, recurring
 *  lines become draft contracts, and the partner's auto-email flag is honoured.
 *  Callers MUST wrap this in `runAction` — see the module header. */
export function acceptQuoteOnBehalf(id: string, body: AcceptQuoteOnBehalfInput): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/accept-on-behalf`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
```

  with `import type { AcceptQuoteOnBehalfInput } from '@breeze/shared';` added
  to the existing type import block (line 21).

- [ ] **Step 4: Build `AcceptOnBehalfDialog.tsx`.** A self-contained component
      taking `{ open, onClose, quote, recipients, onAccepted }`, using the
      shared `Dialog` (`components/shared/Dialog.tsx`, props
      `open/onClose/title/labelledBy/maxWidth/className`) exactly as
      `QuoteActions.tsx:1475` does. Required structure:

  - `data-testid="accept-on-behalf-method"` — a `<select>` built from
    `QUOTE_ACCEPT_ON_BEHALF_METHODS`.
  - `data-testid="accept-on-behalf-reference"` — required text, helper copy
    "Where a reviewer would find the customer's agreement".
  - `data-testid="accept-on-behalf-signer-name"` — required, prefilled from
    `quote.billToName` when set, otherwise blank. **Never derive a name from an
    email address.**
  - `data-testid="accept-on-behalf-signer-email"` — optional, prefilled from
    `recipients[0]` when one exists.
  - A consequences block, always visible:
    - "An invoice for `<formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency)>`
      will be issued and numbered now."
    - "Recurring lines become draft contracts you activate later." — only when
      `lines.some((l) => l.recurrence !== 'one_time')`.
    - "The invoice will be emailed to the customer." — only when the partner's
      `autoEmailInvoiceOnQuoteAccept` is on. **Fetch it on dialog open**, from
      the same endpoint `PartnerBillingSettingsPage.tsx` reads (the partner
      settings payload at `apps/api/src/routes/orgs.ts:485` exposes
      `autoEmailInvoiceOnQuoteAccept`) — read
      `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx:60-70` for
      the exact path and treat it as ON unless the response says `false`, which
      is the server's own `!== false` default.
    - `data-testid="accept-on-behalf-draft-warning"` — only when
      `quote.status === 'draft'`: "This quote was never sent. The customer's
      first sight of it will be the invoice."
  - `data-testid="accept-on-behalf-submit"`, labelled "Accept and issue
    invoice", `disabled` until `reference.trim()` and `signerName.trim()` are
    both non-empty, submitting via:

```tsx
      await runAction({
        request: () => acceptQuoteOnBehalf(quote.id, {
          method, reference: reference.trim(),
          signerName: signerName.trim(),
          signerEmail: signerEmail.trim() || null,
        }),
        errorFallback: t('quotes.actions.acceptOnBehalf.error'),
        parseSuccess: (data) => (data as { data: { invoiceId: string; quote: { quoteNumber: string | null } } }).data,
        successMessage: (data) => t('quotes.actions.acceptOnBehalf.success', {
          number: data.quote.quoteNumber ?? '',
        }),
        onUnauthorized: UNAUTHORIZED,
      });
      onAccepted();
```

    with the repo's standard catch:

```tsx
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('quotes.actions.acceptOnBehalf.error') });
    }
```

- [ ] **Step 5: Gate and mount in `QuoteActions.tsx`.** Beside `canSend`
      (line 887):

```ts
  // Accepting on a customer's behalf is offered for exactly the statuses the
  // server will accept (services/quoteAcceptService.ts): a draft is claimed to
  // sent inline, an expired or declined quote needs Revise instead. Hidden —
  // not disabled — without the permission, matching the other quote actions.
  const canAcceptOnBehalf = can('quotes', 'accept')
    && (quote.status === 'draft' || quote.status === 'sent' || quote.status === 'viewed');
```

  Add `canAcceptOnBehalf` to the "nothing to show" early return at line 899.
  Render a secondary-styled button with
  `data-testid="quote-accept-on-behalf"` next to Send, and mount
  `<AcceptOnBehalfDialog … onAccepted={() => { setAcceptOpen(false); refresh(); }} />`.

- [ ] **Step 6: Add the provenance line in `QuoteDetail.tsx`,** directly after
      the lifecycle `<dl>` (closing tag at line 281):

```tsx
            {/* Provenance for an MSP-recorded acceptance. A customer click
                needs no line — the lifecycle stamp above says all there is to
                say. An on-behalf record must name who recorded it and against
                what, or the audit trail lives only in the audit log. */}
            {detail.acceptance?.origin === 'on_behalf' && (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="quote-acceptance-provenance">
                {t('quotes.detail.acceptedOnBehalf', {
                  signer: detail.acceptance.signerName,
                  // The recorder can be gone (ON DELETE SET NULL) — never render
                  // a blank where a person's name belongs.
                  recorder: detail.acceptance.recordedBy?.name ?? t('quotes.detail.deletedUser'),
                  date: shortDate(detail.acceptance.signedAt),
                  method: t(`quotes.detail.acceptMethod.${detail.acceptance.method}`),
                  reference: detail.acceptance.reference,
                })}
              </p>
            )}
```

  Use whatever date helper `QuoteDetail.tsx` already imports rather than
  introducing `shortDate` if it is not there.

- [ ] **Step 7: Add the copy** to `apps/web/src/locales/en/billing.json` under
      `quotes.actions` and `quotes.detail`:

```json
"acceptOnBehalf": {
  "button": "Accept on behalf",
  "title": "Record the customer's acceptance",
  "methodLabel": "How did they agree?",
  "method": {
    "verbal": "Verbally / by phone",
    "email": "By email",
    "signed_document": "Signed document",
    "purchase_order": "Purchase order",
    "other": "Other"
  },
  "referenceLabel": "Reference",
  "referenceHelp": "Where a reviewer would find the customer's agreement — a PO number, an email and date, or a ticket.",
  "signerNameLabel": "Who agreed",
  "signerEmailLabel": "Their email (optional)",
  "consequenceInvoice": "An invoice for {{amount}} will be issued and numbered now.",
  "consequenceContracts": "Recurring lines become draft contracts you activate later.",
  "consequenceEmail": "The invoice will be emailed to the customer.",
  "consequenceDraft": "This quote was never sent. The customer's first sight of it will be the invoice.",
  "submit": "Accept and issue invoice",
  "success": "Quote accepted. Invoice {{number}} issued.",
  "error": "Could not record the acceptance."
},
```

```json
"acceptedOnBehalf": "Accepted on behalf of {{signer}} by {{recorder}} on {{date}} · {{method}} · {{reference}}",
"deletedUser": "a deleted user",
```

  Only `en` is required; the other locales fall back.

- [ ] **Step 8: Register the new file in the mutation guard.** Add to
      `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`,
      beside `'src/components/billing/quotes/QuoteActions.tsx'` (line 189):

```ts
  // Accept on behalf (spec 2026-09-21): the dialog lives in its own file
  // because QuoteActions.tsx is already 1551 lines. It issues an invoice — a
  // silent failure here is a tech who believes a deal is closed and is not.
  'src/components/billing/quotes/AcceptOnBehalfDialog.tsx',
```

  No `runActionAllowlist.ts` entry is needed — the mutation goes through
  `runAction`, which is the point.

- [ ] **Step 9: Run — expect GREEN**, with the guard and the sibling suites:

```bash
cd apps/web && npx vitest run src/components/billing/quotes/QuoteActions.acceptOnBehalf.test.tsx src/components/billing/quotes/QuoteDetail.acceptance.test.tsx src/lib/__tests__/no-silent-mutations.test.ts
cd apps/web && npx vitest run src/components/billing/quotes/QuoteActions
cd apps/web && npx tsc --noEmit -p tsconfig.json
```

  Note the second command uses a bare substring (no trailing slash and no
  asterisk) so the dotted `QuoteActions.*.test.tsx` siblings are all picked up —
  check the reported file count is 7+.

- [ ] **Step 10: Commit.**

```bash
git add apps/web/src/lib/api/quotes.ts apps/web/src/components/billing/quotes/AcceptOnBehalfDialog.tsx apps/web/src/components/billing/quotes/QuoteActions.tsx apps/web/src/components/billing/quotes/QuoteActions.acceptOnBehalf.test.tsx apps/web/src/components/billing/quotes/QuoteDetail.tsx apps/web/src/components/billing/quotes/QuoteDetail.acceptance.test.tsx apps/web/src/locales/en/billing.json apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): Accept on behalf action and acceptance provenance

A confirmation dialog that states the consequences before they happen — the
invoice amount about to be numbered, whether recurring lines become draft
contracts, whether the customer will be emailed, and on a draft that the
customer's first sight of the document will be the invoice. The required
reference field is the safety step: there is no undo, because the accept also
drafts contracts and stages a Pax8 order.

The dialog is its own file; QuoteActions.tsx is already 1551 lines. It is
registered in the no-silent-mutations target set.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Portal — on-behalf notice

**Files:**
- Modify: `apps/portal/src/components/portal/QuoteDetailView.tsx` — the
  `status === 'converted'` block (lines 376-404)
- Modify: `apps/portal/src/lib/api.ts` — the `QuoteDetail` type, to carry
  `acceptanceOrigin`
- Create: `apps/portal/src/components/portal/QuoteDetailView.acceptOnBehalf.test.tsx`

**Interfaces:**
- Consumes: `quote.acceptanceOrigin` from the portal serializer (Task 9).

- [ ] **Step 1: Write the failing test.**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QuoteDetailView } from './QuoteDetailView';

// … build a converted `detail` fixture matching the portal QuoteDetail shape

describe('portal on-behalf notice', () => {
  it('tells the customer their provider recorded the acceptance', () => {
    render(<QuoteDetailView detail={converted({ acceptanceOrigin: 'on_behalf' })} />);
    expect(screen.getByTestId('quote-accepted-on-behalf').textContent).toContain('on your behalf');
  });

  it('shows nothing extra when the customer accepted it themselves', () => {
    render(<QuoteDetailView detail={converted({ acceptanceOrigin: 'customer' })} />);
    expect(screen.queryByTestId('quote-accepted-on-behalf')).toBeNull();
  });

  // The method and reference are the MSP's internal evidence trail — the portal
  // serializer never sends them, and this asserts the view never invents them.
  it('never renders a method or a reference', () => {
    const { container } = render(<QuoteDetailView detail={converted({ acceptanceOrigin: 'on_behalf' })} />);
    expect(container.textContent).not.toMatch(/purchase order|PO \d/i);
  });
});
```

- [ ] **Step 2: Run it — expect RED.**

```bash
cd apps/portal && npx vitest run src/components/portal/QuoteDetailView.acceptOnBehalf.test.tsx
```

- [ ] **Step 3: Implement.** Inside the `status === 'converted'` box
      (after the `<p>` at line 383):

```tsx
          {detail?.quote.acceptanceOrigin === 'on_behalf' && (
            // The customer never clicked anything — their provider recorded an
            // agreement reached elsewhere. Saying so plainly is what makes the
            // record honest from their side; the method and the reference are
            // the provider's internal detail and are deliberately absent.
            <p data-testid="quote-accepted-on-behalf">
              Accepted on your behalf by {branding.partnerName} on {shortDate(detail.quote.acceptedAt)}.
            </p>
          )}
```

  Add `acceptanceOrigin?: 'customer' | 'on_behalf' | null` to the portal
  `QuoteDetail['quote']` type in `apps/portal/src/lib/api.ts`. Use whatever
  partner-name and date helpers the file already has in scope.

- [ ] **Step 4: Run — expect GREEN.**

```bash
cd apps/portal && npx vitest run src/components/portal/QuoteDetailView
cd apps/portal && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 5: Commit.**

```bash
git add apps/portal/src/components/portal/QuoteDetailView.tsx apps/portal/src/components/portal/QuoteDetailView.acceptOnBehalf.test.tsx apps/portal/src/lib/api.ts
git commit -m "feat(portal): tell the customer when their provider recorded the acceptance

Origin only. The method and the reference are the MSP's internal evidence
trail about this customer and never reach the portal.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/reference/users-and-roles.mdx` — the
  `quotes` resource table (line 369 area) and the permission-constant table
  (lines 466-469)
- Modify: the quotes/proposals feature page (find it with
  `grep -rln "proposal" apps/docs/src/content/docs/features/ | head`; it is the
  page that documents sending a quote and the customer accept link)

- [ ] **Step 1: Locate the pages and confirm what they claim today.**

```bash
grep -rn "quotes:send\|QUOTES_SEND" apps/docs/src/content/docs/
grep -rln "accept link\|public accept\|proposal" apps/docs/src/content/docs/features/
```

- [ ] **Step 2: Add the permission row** to
      `apps/docs/src/content/docs/reference/users-and-roles.mdx`, after the
      `QUOTES_SEND` row (line 468):

```mdx
| `QUOTES_ACCEPT` | `quotes` | `accept` |
```

  and, in whichever table describes what each action permits, a line reading:

  > `accept` — record a customer's acceptance on their behalf (phone, email,
  > signed PO) and convert the quote to an invoice. Granted automatically to
  > every role that already held `send` when upgrading; revoke it if you want
  > acceptance narrower than sending.

- [ ] **Step 3: Document the action** on the quotes feature page — a short
      section covering: which statuses it works from (including a draft, and
      what that means for the customer), that the invoice is numbered and
      issued immediately at the quote's frozen totals and tax, that recurring
      lines become draft contracts, that the partner's "email the invoice on
      acceptance" setting is honoured, and that the reference field is what a
      dispute reviewer will look for. State plainly that there is no undo — the
      invoice can be voided like any other, but the contracts and staged Pax8
      order are not unwound.

- [ ] **Step 4: Build the docs** (this is what CI's `docs-check` job runs):

```bash
cd apps/docs && pnpm build
```

- [ ] **Step 5: Commit.**

```bash
git add apps/docs/src/content/docs/reference/users-and-roles.mdx apps/docs/src/content/docs/features/
git commit -m "docs: quotes:accept permission and the accept-on-behalf action

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Pre-PR verification

Run all of this before opening the PR — tenancy and migration code was touched,
so local unit-green is explicitly not enough.

```bash
# Unit suites, all four packages
pnpm test

# Contract + integration suites (need a live stack)
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteAcceptOnBehalf.integration.test.ts src/__tests__/integration/quoteAccept.integration.test.ts src/__tests__/integration/quoteRevisions.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls.ts
pnpm test-stack down

# Drift
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift

# Lint + build
pnpm lint && pnpm build
```

**Manual acceptance on a worktree stack** (spec §10): from a draft carrying one
recurring line, run Accept on behalf; confirm the invoice is numbered and
`sent`, the contract is drafted, and then — as the customer in the portal — that
the quote shows the on-behalf notice and the invoice pay link works. Two traps
from the revisions run: use `pressSequentially` for money inputs, and portal
islands do not hydrate under `wt-stack` (#3906), so verify the portal copy in
the server HTML rather than through the hydrated DOM.

**Follow-up issues to file at PR time** (spec §12):
1. Evidence attachment on an on-behalf acceptance (signed PDF / PO upload).
2. Decline on behalf — same dialog shape, `declineQuoteByActor` already exists.
3. Optional customer notification email on on-behalf acceptance ("Your provider
   recorded your acceptance of Q-…; reply if this is wrong").

**PR description must state** (per the CLAUDE.md settings rule, since this adds
no settings screen but does add a permission): the new permission, that it is
back-filled to `quotes:send` holders, and that the export-policy registry was
updated for four new columns on an existing org-cascade table.

---

## Self-Review — spec section → task coverage

| Spec § | Requirement | Task(s) |
|---|---|---|
| §2 D1 | Reuse the pipeline verbatim; invoice numbered and `sent` | 6 (nothing after the acceptance insert changed), 10 (proven against Postgres) |
| §2 D2 | Method + required reference + signer name/email | 2 (columns + CHECK), 4 (Zod), 6 (insert), 11 (dialog) |
| §2 D3 | New `quotes:accept`, back-filled to `quotes:send` holders | 1 (constant + seed), 3 (migration), 8 (route gate) |
| §2 D4 | `draft|sent|viewed` eligible; draft claimed inline | 5 (`claimQuoteSent`), 6 (guard + claim), 11 (button gating) |
| §3 | Non-goals (attachments, decline-on-behalf, countersignature, AI tool) | Not implemented; filed as follow-ups in Pre-PR verification |
| §4 route | `POST /quotes/:id/accept-on-behalf`, `requireScope` + `requirePermission`, org check before system context, render data pre-fetched | 8 |
| §4 body | `acceptQuoteOnBehalfSchema` | 4 |
| §4 response | `{ quote, invoiceId, invoiceIssued, contractIds, payUrl }` | 8 |
| §4 errors | 404 / 409 `QUOTE_NOT_ACCEPTABLE` / 409 converted / 410 superseded / 410 expired / 409 deleted references / 500 render data | 6 (new guard + existing guards preserved), 8 (route tests) |
| §5 params | `origin`, `actorUserId`, `method`, `reference` | 6 |
| §5 draft claim | Conditional UPDATE, number, snapshots, locale, `issueDate`/`sentAt`, no recipients/token/link/email, revision parent retired | 5 (helper), 6 (call site), 10 (asserted against Postgres) |
| §5 capture | Provider bypassed; tech's IP/UA clamped; hash unchanged | 6 (incl. the hash-parity test) |
| §5 notify | `source: 'msp'`, `origin` + `actorUserId` on the event payload | 6 (`quoteEvents` + `notifyQuoteOutcome`), 8 (route call) |
| §6 data | Four columns, CHECKs, back-fill with system scope + row count | 2 — **CHECK on the recorder made one-directional; rationale in "Spec deviations", item 5** |
| §6 registry | Export policy updated; no cascade change; no RLS change | 2 (+ verification commands in Global Constraints) |
| §6 Drizzle | Schema mirrors the four columns | 2 |
| §7 permission | Constant, seed, catalog, back-fill migration, docs | 1, 3, 13 |
| §8 audit | `quote.accepted_on_behalf` via `writeRouteAudit`, payload in an SSOT module | 7 (module), 8 (route call + test) |
| §9 action | Button gating, dialog fields, consequences block, primary label, `runAction`, refetch, API wrapper, `can` typing | 11 |
| §9 provenance | On-behalf line on the quote detail; serializer exposes the four fields + recorder name | 9 (serializer — **added, not extended**; see item 1), 11 (line — **new, not modified**; see item 2) |
| §9 portal | On-behalf notice; serializer exposes `origin` only | 9, 12 (**inside the existing accept-success box**; see item 3) |
| §10 route tests | RBAC, body validation, audit | 8 |
| §10 service tests | Draft claim, customer-draft rejection, 409/410 matrix, provenance columns, hash parity, revision supersede, concurrency | 6 (unit), 10 (concurrency proven against real Postgres, where a row lock is real) |
| §10 integration | Draft → accept → issued invoice at quote totals/tax, contracts, four fields, no public link | 10 (**no `readFileSync` replay**; see item 4) |
| §10 contract suites | `migrationRlsScope`, export policy ×2, `rls-coverage`, `permissionsCatalog` | 2, 3, 10, Pre-PR verification |
| §10 web tests | Gating, draft warning, typed body, `no-silent-mutations` | 11 |
| §10 manual | Worktree-stack walkthrough incl. portal | Pre-PR verification |
| §11 risks | Mis-click mitigation, extraction regression, back-fill coverage, single PR | 11 (consequences block + required reference), 5 (existing suite untouched + revisions integration), 3 (grant-matched), header (single PR) |
| §12 follow-ups | Three issues filed at PR time | Pre-PR verification |

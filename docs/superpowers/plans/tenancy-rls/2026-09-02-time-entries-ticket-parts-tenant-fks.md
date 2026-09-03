# time_entries / ticket_parts Tenant-Integrity FKs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it unrepresentable at the DATABASE level for a `time_entries` row to
carry an `org_id` belonging to another partner, and for a `time_entries` /
`ticket_parts` row to carry an `org_id` that disagrees with its parent ticket's.

**Architecture:** Two hand-written SQL migrations add composite foreign keys —
`time_entries (org_id, partner_id) -> organizations (id, partner_id)` (Wave 1) and
`(ticket_id, org_id) -> tickets (id, org_id)` on both tables (Wave 2) — each
preceded by an RLS-scoped, row-count-logged cleanup of any drifted rows. Wave 2
additionally teaches the two org-move transactions to defer the new
ticket-keyed constraints, because both rewrite `tickets.org_id` before the
children follow. No new tables, no new columns, no app-layer behaviour change:
the service layer already validates both axes and this plan proves it with
tests rather than adding a second, forgettable check.

**Tech Stack:** PostgreSQL 15+, Drizzle ORM (queries only — these FKs are
SQL-migration-only), Vitest integration suite (`vitest.integration.config.ts`,
real `breeze_app` role, RLS enforced), Hono.

**Spec:** GitHub issue [#4596](https://github.com/LanternOps/breeze/issues/4596)
(`[API][RLS] time_entries / ticket_parts accept an org_id from another
partner`). Surfaced by the block-hours spec pass on #4547, which will read these
rows per org for drawdown. Read the issue body alongside this plan — but read
"Corrections to the issue as filed" below FIRST: the issue's description of
`ticket_parts` is wrong in a way that changes the fix.

---

## Global Constraints

- **Postgres 15+ is required.** Wave 2 uses the column-list referential action
  `ON DELETE SET NULL (ticket_id)`, a PG15 feature. The repo already ships this
  form in `apps/api/migrations/2026-10-04-100002-portal-users-contact-composite-fk.sql`,
  so this floor is already assumed, not newly introduced by this plan.
- **Migration filenames must sort strictly after the newest migration on
  `origin/main`.** At the time of writing that is
  `2026-10-04-100003-portal-visibility-indexes.sql`. The names used below
  (`2026-10-05-100000-…`, `2026-10-05-100001-…`) satisfy that. **Re-check before
  every push** — the pre-push hook runs
  `scripts/check-migration-naming.sh --against-ref origin/main`, and a migration
  that landed on `main` after your branch was cut will fail it. Rename if it
  does. Do NOT reach for `2026-08-06-g-`: that date block is CLOSED.
- **Never edit a shipped migration.** Both files here are new. If either has
  already been merged when a defect is found, fix forward with a third file.
- **Migrations must be idempotent** (`DROP CONSTRAINT IF EXISTS` then re-add,
  `DO $$ … EXCEPTION`, `pg_constraint` existence checks) and must contain no
  inner `BEGIN;`/`COMMIT;` — `autoMigrate` already wraps each file in a
  transaction.
- **Every cleanup statement reports its row count unconditionally**, via
  `GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING '…', n;` — including when the
  count is zero. A suppressed zero is indistinguishable from the RLS no-op
  described in the next bullet, and a non-zero count here is potential evidence
  of a tenant-isolation incident.
- **Every cleanup statement must be preceded by
  `SELECT set_config('breeze.scope','system',true);`.** Both tables are
  `ENABLE` + `FORCE ROW LEVEL SECURITY` and `breeze_current_scope()` defaults to
  `'none'` (deny), so on managed Postgres — where the migration role is not a
  superuser — an unscoped `UPDATE` matches ZERO rows and reports a
  truthful-looking "cleaned 0". `is_local = true` scopes it to autoMigrate's
  per-file transaction. Reference: `2026-09-30-100000-rls-scoped-backfill-replay.sql`.
- **Every composite FK whose REFERENCED side includes a column literally named
  `org_id` MUST be `DEFERRABLE INITIALLY IMMEDIATE`.** Enforced by
  `apps/api/src/__tests__/integration/orgLifecycleFoundations.integration.test.ts:39`.
  Org merge runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent and child
  `org_id` in separate statements of one transaction. This applies to both Wave 2
  constraints (`-> tickets (id, org_id)`). It does NOT technically apply to the
  Wave 1 constraint (`-> organizations (id, partner_id)` — no referenced column
  is named `org_id`), but declare it `DEFERRABLE INITIALLY IMMEDIATE` anyway for
  uniformity and merge-safety.
- **Constraint names are part of the contract.** Tests and error handling pin
  them: `time_entries_org_partner_fk`, `time_entries_ticket_org_fk`,
  `ticket_parts_ticket_org_fk`.
- **`pnpm test` does NOT run the integration suite.** Everything this plan
  asserts about Postgres runs under `vitest.integration.config.ts` only. Local
  green is not CI green. See "CI traps" below.

---

## Corrections to the issue as filed

Verified against `origin/main` at `2e2e094e0`. Three claims in the issue body do
not survive reading the code, and one of them changes the fix:

1. **`ticket_parts` is NOT partner-axis.** The issue's title and first paragraph
   say both tables are protected by the partner-axis policy. They are not:
   `apps/api/migrations/2026-06-12-a-ticketing-time-parts.sql:67-82` gives
   `ticket_parts` four org-axis (Shape 1) policies —
   `breeze_has_org_access(org_id)` on SELECT/INSERT/UPDATE/DELETE — and the
   table has **no `partner_id` column at all**. Consequences:
   - A cross-partner `org_id` is **not writable** on `ticket_parts`: the RLS
     `WITH CHECK` already confines `org_id` to the caller's own accessible orgs.
   - The issue's proposed fix — "`FOREIGN KEY (org_id, partner_id) REFERENCES
     organizations (id, partner_id)` … and the same on `ticket_parts`" — is
     **not applicable** to `ticket_parts`. There is no second column to pair.
   - The **real** `ticket_parts` gap is different and narrower: nothing ties
     `ticket_parts.org_id` to its parent `tickets.org_id`, so a part can be
     attached to another tenant's ticket while carrying the writer's own
     `org_id`. That is a mis-attribution/data-integrity defect (it feeds
     `invoiceAssembly.ts:170-176`, which selects parts by `org_id`), not a
     cross-partner write. Wave 2 closes it with
     `(ticket_id, org_id) -> tickets (id, org_id)`.

2. **The `time_entries` hole is real, and is a defence-in-depth gap rather than
   a live exploit.** The partner-axis `WITH CHECK`
   (`breeze_has_partner_access(partner_id)`) genuinely permits any `org_id`
   whose organization row exists, including another partner's. But every
   application writer already blocks it — there are exactly three INSERT sites
   into these tables in the entire repo, all inside
   `apps/api/src/services/timeEntryService.ts` (`:461`, `:597`, `:926`), and each
   derives `org_id` from a link that has already been partner-checked:
   - `resolveTicketLink` (`:227-241`) rejects a ticket whose resolved partner is
     not the actor's (`TICKET_WRONG_PARTNER`) and then re-applies the actor's
     `accessibleOrgIds` allowlist (`TICKET_ORG_DENIED`).
   - `resolveAndLockOrgLink` (`:397-414`) rejects an org outside
     `accessibleOrgIds` and an org whose `partnerId` is not the actor's
     (`ORG_DENIED`).
   - `updateTimeEntry` (`:745-747`) rejects a relink whose partner differs.

   So the issue's "**Also check the app layer**" item is already satisfied on
   `main`. **Do not add a fourth redundant check.** Wave 1 instead pins this
   behaviour with tests so a future writer cannot quietly remove it, and adds
   the database backstop the tables never had. Label this honestly in the PR:
   *no known reachable exploit path today; #4547 adds new org-keyed readers and
   plausibly new writers, and the DB is the missing wall.*

3. **`organizations_id_partner_uq` exists** (`2026-04-11-users-rls.sql:66-78`) —
   confirmed, the issue is right about this. So does `tickets_id_org_uq`
   (`2026-09-25-ai-agents-ticket-triage.sql:34`), which Wave 2 needs. Neither
   wave has to create a unique index.

---

## Registration-list audit (CLAUDE.md tenancy section)

**Nothing to add. Both tables are already registered everywhere, and neither
wave adds a table or a column.** This was verified by grep, not by judgement —
record the same evidence in each PR body:

| List | File | Status |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `apps/api/src/services/tenantCascade.ts:462,464` | `ticket_parts` and `time_entries` both present, alphabetised, `organizations` last. Unchanged. |
| `CORE_TENANT_EXPORT_POLICY` | `apps/api/src/services/tenantExportPolicyRegistry.ts:405,415` | Both tables classified, every existing column bucketed. **No new columns in either wave**, so this list — the only one that fires on an `ADD COLUMN` — is untouched. |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `apps/api/src/routes/devices/core.ts:312` | N/A: neither table has a `device_id` column. |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `apps/api/src/routes/devices/core.ts:205` | N/A for the same reason. Both tables are instead in `CUSTOM_ORG_REWRITE_TABLES` (`core.ts:286`) because they denormalize `org_id` from the **ticket**, not the device — which is exactly why Wave 2 has to touch the move paths. |
| `AUDIT_ADMIN_REQUIRED_TABLES` | `apps/api/src/services/tenantCascade.ts` | N/A: neither table is append-only (no `REVOKE DELETE`, no immutability trigger). |
| `orgMergeRegistry` REPOINT_TABLES | `apps/api/src/services/orgMergeRegistry.ts:666,668` | Both present as plain repoints. **Relevant to Wave 2:** merge repoints `tickets.org_id` and the children's `org_id` in separate statements under `SET CONSTRAINTS ALL DEFERRED` (`orgMerge.ts:1022`), which only works because the new FKs are `DEFERRABLE`. |
| `rls-coverage.integration.test.ts` | `:132-135`, `:202` | `time_entries` already in `PARTNER_TENANT_TABLES` with axis `partner_id`. `ticket_parts` is Shape 1 (auto-discovered `org_id`). No allowlist edit. |

**FK-direction check (the part alphabetical order does not give you for free):**
neither wave introduces a NEW parent table for either child. `time_entries` and
`ticket_parts` already have `org_id -> organizations(id)` and
`ticket_id -> tickets(id)` edges, so `topologicalCascadeOrder()` produces the
same children-before-parents ordering it produces today. `tenantCascade.integration.test.ts`
proves this; run it.

**Partner-wide-first (epic #2135):** not applicable. Neither table is a config /
policy / template / rule / baseline table — they are transactional billing
records owned by exactly one organization (or, for a standalone `time_entries`
row, by no organization and only a partner). No `ownerScope` field, no
`canManagePartnerWidePolicies` gate, no `DUAL_AXIS_TENANT_TABLES` entry. Say
this explicitly in the PR body so a reviewer does not have to re-derive it.

---

## File structure

**Wave 1**
- Create: `apps/api/migrations/2026-10-05-100000-time-entries-org-partner-fk.sql`
- Create: `apps/api/src/__tests__/integration/timeEntriesOrgPartnerFk.integration.test.ts`
- Modify: `apps/api/src/db/schema/timeTracking.ts` (comment only — the FK is SQL-only)

**Wave 2**
- Create: `apps/api/migrations/2026-10-05-100001-ticket-child-org-fks.sql`
- Create: `apps/api/src/__tests__/integration/ticketChildOrgFks.integration.test.ts`
- Modify: `apps/api/src/services/ticketService.ts` (`moveTicketOrg` — defer the two new constraints)
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (same deferral)
- Modify: `apps/api/src/db/schema/timeTracking.ts` (comment only)

The waves are independently shippable and independently revertible. Wave 1
touches no application code at all and cannot affect either org-move path. Wave 2
is where the blast radius is. If Wave 2 has to be dropped, Wave 1 still closes
the cross-partner hole that #4596's title names.

---

## Design decisions (do not re-litigate mid-execution)

**Keep the existing single-column FKs; add the composites alongside.** The
`portal_users` precedent (`2026-10-04-100002`) DROPPED the superseded
single-column FK. Do **not** copy that here, for one concrete reason:
composite FKs are `MATCH SIMPLE`, so a `time_entries` row with `ticket_id` set
and `org_id NULL` is not considered a referencing row at all — its `ON DELETE
SET NULL` would never fire, leaving a dangling `ticket_id` after the ticket is
deleted. Postgres evaluates FK constraints conjunctively, so a surviving
single-column FK is redundant, never permissive. The cost is a second
referential action on the same column with identical effect (`SET NULL` on
`ticket_id` for `time_entries`; `CASCADE` for `ticket_parts`) and one extra lock
on `tickets`. That is the right trade.

**`MATCH SIMPLE` residual, accepted and documented:** a `time_entries` row with
`org_id IS NULL` is exempt from both composites. That is correct — a NULL
`org_id` means "attributed to no organization", and no org-keyed reader
(`invoiceAssembly.ts`, `orgCurrencyService.ts`, #4547 block-hours drawdown)
counts it. Do not "fix" this with `MATCH FULL`; that would break every
legitimate standalone timer.

**Cleanup direction differs per wave, on purpose.** Wave 1 nulls `org_id` (the
partner disagreement means we cannot know which org is correct, and nulling
preserves the billable labour and its currency snapshot —
`time_entries_currency_required_when_org_chk` is `org_id IS NULL OR
currency_code IS NOT NULL`, one-directional, so nulling `org_id` never violates
it). Wave 2 re-derives `org_id` from the parent ticket, because the ticket IS
the authority for a ticket-linked row — that is precisely what
`resolveTicketLink` does at write time.

---

## Wave 1 — `time_entries (org_id, partner_id) -> organizations (id, partner_id)`

Closes the cross-partner hole in the issue title. No application code changes.

### Task 1: Failing integration test for the cross-partner forge

**Files:**
- Test: `apps/api/src/__tests__/integration/timeEntriesOrgPartnerFk.integration.test.ts` (create)

**Interfaces:**
- Consumes: `createPartner`, `createOrganization`, `createUser` from
  `./db-utils`; `getTestDb` from `./setup`; `db`, `withDbAccessContext`,
  `DbAccessContext` from `../../db`.
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * #4596 — a `time_entries` row cannot carry an `org_id` from another partner.
 *
 * `time_entries` is RLS Shape 3 (partner-axis): `time_entries_partner_access`
 * checks `breeze_has_partner_access(partner_id)` and says nothing at all about
 * `org_id`, whose FK pointed at `organizations(id)` alone. A caller authorised
 * for partner A could therefore write a row attributing billable labour to
 * partner B's customer: RLS passed (partner matched), the FK passed (the org
 * existed), and every org-keyed reader downstream (invoiceAssembly, the #4547
 * block-hours drawdown) would have counted it against the victim's org.
 *
 * Every application writer already refuses this (three INSERT sites, all in
 * timeEntryService, all behind resolveTicketLink / resolveAndLockOrgLink).
 * This suite is about what the DATABASE refuses, which is what makes those
 * checks a nicety rather than the boundary — so the forge writes go through
 * the unprivileged `breeze_app` handle under a real RLS context, not the
 * admin pool.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { timeEntries, organizations, partners } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const seededPartnerIds: string[] = [];

// Shape copied verbatim from the proven fixture in
// time-entries-rls.integration.test.ts:140 — `accessibleOrgIds` is a real
// allowlist, not null (null means system-wide in the service layer and would
// weaken what these tests demonstrate).
function partnerCtx(partnerId: string, orgIds: string[], userId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId,
  };
}

async function seed() {
  const partnerA = await createPartner({});
  const partnerB = await createPartner({});
  seededPartnerIds.push(partnerA.id, partnerB.id);
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const techA = await createUser({ partnerId: partnerA.id });
  return { partnerA, partnerB, orgA, orgB, techA };
}

afterAll(async () => {
  const admin = getTestDb() as any;
  for (const id of seededPartnerIds) {
    await admin.execute(sql`DELETE FROM time_entries WHERE partner_id = ${id}::uuid`);
    await admin.execute(sql`DELETE FROM organizations WHERE partner_id = ${id}::uuid`);
    await admin.delete(partners).where(eq(partners.id, id));
  }
});

describe('time_entries org/partner composite FK (#4596)', () => {
  it('rejects an INSERT whose org_id belongs to another partner', async () => {
    const { partnerA, orgB, techA } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerA.id, [orgA.id, orgB.id], techA.id), () =>
        db.insert(timeEntries).values({
          partnerId: partnerA.id,   // RLS passes: this IS the caller's partner
          orgId: orgB.id,           // …but the org belongs to partner B
          userId: techA.id,
          startedAt: new Date(Date.now() - 60_000),
          endedAt: new Date(),
          durationMinutes: 1,
          currencyCode: 'USD',      // required by time_entries_currency_required_when_org_chk
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('rejects an UPDATE that moves a row onto another partner\'s org', async () => {
    const { partnerA, orgA, orgB, techA } = await seed();
    const [row] = await withDbAccessContext(partnerCtx(partnerA.id, [orgA.id, orgB.id], techA.id), () =>
      db.insert(timeEntries).values({
        partnerId: partnerA.id,
        orgId: orgA.id,
        userId: techA.id,
        startedAt: new Date(Date.now() - 60_000),
        endedAt: new Date(),
        durationMinutes: 1,
        currencyCode: 'USD',
      }).returning(),
    );
    await expect(
      withDbAccessContext(partnerCtx(partnerA.id, [orgA.id, orgB.id], techA.id), () =>
        db.update(timeEntries).set({ orgId: orgB.id }).where(eq(timeEntries.id, row!.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('still accepts a same-partner org and a NULL org (standalone entry)', async () => {
    const { partnerA, orgA, techA } = await seed();
    const inserted = await withDbAccessContext(partnerCtx(partnerA.id, [orgA.id], techA.id), async () => {
      const [linked] = await db.insert(timeEntries).values({
        partnerId: partnerA.id, orgId: orgA.id, userId: techA.id,
        startedAt: new Date(Date.now() - 60_000), endedAt: new Date(),
        durationMinutes: 1, currencyCode: 'USD',
      }).returning();
      const [standalone] = await db.insert(timeEntries).values({
        partnerId: partnerA.id, orgId: null, userId: techA.id,
        startedAt: new Date(Date.now() - 120_000), endedAt: new Date(Date.now() - 60_000),
        durationMinutes: 1,
      }).returning();
      return { linked, standalone };
    });
    expect(inserted.linked!.orgId).toBe(orgA.id);
    expect(inserted.standalone!.orgId).toBeNull();
  });

  it('declares the constraint DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const rows = (await (getTestDb() as any).execute(sql`
      SELECT condeferrable, condeferred FROM pg_constraint
      WHERE conname = 'time_entries_org_partner_fk'
        AND conrelid = 'time_entries'::regclass
    `)) as unknown as Array<{ condeferrable: boolean; condeferred: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.condeferrable).toBe(true);
    expect(rows[0]!.condeferred).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch the right tests fail for the right reason**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/timeEntriesOrgPartnerFk.integration.test.ts
```

Expected, BEFORE the migration exists: the first two tests FAIL because the
inserts/updates **succeed** (`rejects.toMatchObject` receives a resolved
promise), the DEFERRABLE test FAILS on `expect(rows).toHaveLength(1)` receiving
`0`, and the third test PASSES. If the first two instead fail with `42501`, your
`partnerCtx` is wrong — fix the fixture, not the assertion. **Do not proceed
until you have seen a real 0-length `pg_constraint` read**; that is the proof
the control can distinguish the two states.

- [ ] **Step 3: Commit the red test**

```bash
git add apps/api/src/__tests__/integration/timeEntriesOrgPartnerFk.integration.test.ts
git commit -m "test(tenancy): failing forge test for cross-partner time_entries.org_id (#4596)"
```

### Task 2: The migration

**Files:**
- Create: `apps/api/migrations/2026-10-05-100000-time-entries-org-partner-fk.sql`
- Modify: `apps/api/src/db/schema/timeTracking.ts` (comment on `orgId`)

**Interfaces:**
- Produces: constraint `time_entries_org_partner_fk` on `time_entries`,
  `DEFERRABLE INITIALLY IMMEDIATE`. Wave 2 and
  `orgLifecycleFoundations.integration.test.ts` both read it by name.

- [ ] **Step 1: Confirm the filename still sorts last**

```bash
git fetch origin main -q
git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
```

Expected: nothing sorts after `2026-10-05-100000-…`. If something does, bump the
6-digit time component (`100001`, `100002`, …) or the date, and update every
reference in this plan's Task 3 test.

- [ ] **Step 2: Write the migration**

```sql
-- #4596 — time_entries.org_id must belong to the row's own partner.
--
-- `time_entries` is RLS Shape 3 (partner-axis). `time_entries_partner_access`
-- (2026-06-12-a-ticketing-time-parts.sql:60) checks
-- `breeze_has_partner_access(partner_id)` and nothing else; `org_id`'s FK
-- pointed at `organizations(id)` alone. Nothing at the database level tied the
-- two, so a row authorised for partner A could attribute billable labour to
-- partner B's customer, and every org-keyed reader downstream (invoiceAssembly,
-- orgCurrencyService, the #4547 block-hours drawdown) would have counted it
-- against the victim's org.
--
-- Shape copied from `users` (2026-04-11-users-rls.sql §3/§6, the dual-axis
-- precedent): COMPOSITE against `organizations_id_partner_uq (id, partner_id)`,
-- which that migration already created. No new unique index is needed here.
--
-- The single-column `org_id -> organizations(id)` FK is KEPT. Postgres
-- evaluates FK constraints conjunctively, so a surviving single-column FK is
-- redundant rather than permissive, and keeping it means the composite's
-- MATCH SIMPLE semantics (below) can never leave `org_id` unprotected.
--
-- MATCH SIMPLE, accepted: a row with `org_id IS NULL` is exempt. That is
-- correct — a standalone timer is attributed to no organization, and no
-- org-keyed reader counts it. MATCH FULL would break every standalone entry.
--
-- DEFERRABLE INITIALLY IMMEDIATE: not strictly required by
-- orgLifecycleFoundations.integration.test.ts (no REFERENCED column here is
-- literally named `org_id`), but declared anyway so org merge —
-- which runs `SET CONSTRAINTS ALL DEFERRED` and repoints `time_entries.org_id`
-- as a plain registry repoint (orgMergeRegistry.ts:668) — can never be
-- reordered into a mid-walk abort by this constraint.
--
-- Registration (CLAUDE.md cascade table): NOTHING to add. No new table, no new
-- column. `time_entries` is already in CORE_ORG_CASCADE_DELETE_ORDER
-- (tenantCascade.ts:464), CORE_TENANT_EXPORT_POLICY
-- (tenantExportPolicyRegistry.ts:415, every column classified), the org-merge
-- REPOINT_TABLES, and PARTNER_TENANT_TABLES in rls-coverage. No new parent
-- table, so topologicalCascadeOrder is unchanged.

-- FORCE ROW LEVEL SECURITY + `breeze_current_scope()` defaulting to 'none'
-- means the cleanup below matches ZERO rows on managed Postgres without this,
-- and reports a truthful-looking "cleaned 0". `is_local = true` scopes it to
-- autoMigrate's per-file transaction.
-- See 2026-09-30-100000-rls-scoped-backfill-replay.sql for the write-up.
SELECT set_config('breeze.scope', 'system', true);

-- Cleanup BEFORE the constraint: a pre-existing drifted row would make the
-- ADD CONSTRAINT fail its initial validation and abort the whole file on every
-- database that has the drift, with no way to skip it.
--
-- Direction: NULL the org, do not delete the row and do not guess a
-- replacement org. The partner disagreement means we cannot know which org is
-- correct, and a time entry is billable labour someone performed — destroying
-- it is not recoverable. Nulling cannot violate
-- `time_entries_currency_required_when_org_chk`
-- (`org_id IS NULL OR currency_code IS NOT NULL`, one-directional), so the
-- currency snapshot survives untouched.
--
-- The count is reported UNCONDITIONALLY. A non-zero count is evidence that
-- labour was attributed to another tenant's customer — potentially a
-- tenant-isolation incident — and that forensic trail has to survive even when
-- the number is 0, because a suppressed 0 is indistinguishable from the RLS
-- no-op the set_config above prevents.
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE time_entries te
     SET org_id = NULL
    FROM organizations o
   WHERE o.id = te.org_id
     AND o.partner_id IS DISTINCT FROM te.partner_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'cleaned % cross-partner time_entries.org_id row(s)', n;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'time_entries_org_partner_fk'
       AND conrelid = 'time_entries'::regclass
  ) THEN
    ALTER TABLE time_entries
      ADD CONSTRAINT time_entries_org_partner_fk
      FOREIGN KEY (org_id, partner_id)
      REFERENCES organizations (id, partner_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- Supports the constraint's own lookup on the referencing side and the
-- "entries for this partner's org" reads in listTimeEntries. Partial: a NULL
-- org_id row is exempt from the FK and never probed by an org-keyed reader.
CREATE INDEX IF NOT EXISTS time_entries_org_partner_idx
  ON time_entries (org_id, partner_id) WHERE org_id IS NOT NULL;
```

- [ ] **Step 3: Document the FK in the Drizzle schema (comment only)**

In `apps/api/src/db/schema/timeTracking.ts`, replace the `orgId` line of
`timeEntries` with:

```ts
  // #4596: declared here as a plain single-column reference, but the real
  // tenancy constraint is the COMPOSITE `time_entries_org_partner_fk`
  // (org_id, partner_id) -> organizations (id, partner_id), DEFERRABLE
  // INITIALLY IMMEDIATE, in 2026-10-05-100000-time-entries-org-partner-fk.sql.
  // Drizzle cannot express a composite FK, so it is SQL-migration-only — same
  // convention as tickets.requesterContactId and portal_users.contactId.
  // The partner-axis RLS policy checks partner_id ONLY; this FK is what stops
  // a row attributing labour to another partner's organization.
  orgId: uuid('org_id').references(() => organizations.id),
```

- [ ] **Step 4: Apply the migration and re-run the suite**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/timeEntriesOrgPartnerFk.integration.test.ts
```

Expected: 4 passed. Watch the migration output for the
`cleaned N cross-partner time_entries.org_id row(s)` WARNING and record N in the
PR body — including when it is 0.

- [ ] **Step 5: Prove the migration is a replayable no-op**

```bash
pnpm db:migrate   # second run: breeze_migrations already has the row
psql "$DATABASE_URL" -c "\d time_entries" | grep org_partner_fk
```

Expected: exactly one `time_entries_org_partner_fk` line. Then force a genuine
re-apply to prove idempotency of the SQL itself:

```bash
psql "$DATABASE_URL" -f apps/api/migrations/2026-10-05-100000-time-entries-org-partner-fk.sql
```

Expected: no error, and still exactly one constraint.

- [ ] **Step 6: Run the contract suites this could plausibly break**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/time-entries-rls.integration.test.ts
```

Expected: all pass. `rls-coverage` needs the DB env vars set (it is not
skippable-silent — check it reported test counts, not zero).

- [ ] **Step 7: Check for schema drift**

```bash
pnpm db:check-drift
```

Expected: no NEW drift. Composite FKs are invisible to Drizzle, so the tool may
already report pre-existing composite-FK noise for `users` / `tickets` /
`portal_users`; compare against a run on `origin/main` if anything looks
unfamiliar, and do not "fix" drift by editing the schema file.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-05-100000-time-entries-org-partner-fk.sql \
        apps/api/src/db/schema/timeTracking.ts
git commit -m "fix(tenancy): composite (org_id, partner_id) FK on time_entries (#4596)"
```

### Task 3: Pin the app-layer guards that already exist

The issue asks to "check the app layer". It is already correct (see
"Corrections" above). Adding a fourth check would be dead code; instead make the
existing three un-deletable by test.

**Files:**
- Modify: `apps/api/src/services/timeEntryService.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/timeEntryService.test.ts` (match the file's
existing Drizzle-mock idiom — read the top of the file first and reuse its
mock builders rather than inventing new ones):

```ts
describe('#4596 — org/partner guards are the app-layer half of the composite FK', () => {
  it('resolveAndLockOrgLink refuses an org belonging to another partner', async () => {
    // org exists and is inside accessibleOrgIds, but its partnerId is not the
    // actor's. Without this branch the DB now raises a raw 23503 instead of a
    // typed 403, so this test protects the ERROR SHAPE, not just the refusal.
    mockOrgRow({ id: 'org-b', partnerId: 'partner-b' });
    await expect(
      resolveAndLockOrgLink('org-b', { ...baseActor, partnerId: 'partner-a', accessibleOrgIds: ['org-b'] }),
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });

  it('resolveAndLockOrgLink refuses an org outside accessibleOrgIds', async () => {
    await expect(
      resolveAndLockOrgLink('org-x', { ...baseActor, partnerId: 'partner-a', accessibleOrgIds: ['org-a'] }),
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts
```

Expected: PASS immediately — the guards already exist. **This is the one place
in this plan where a green-on-first-run test is correct.** Prove the test is not
vacuous by temporarily commenting out the `org.partnerId !== actor.partnerId`
condition in `resolveAndLockOrgLink` (`timeEntryService.ts:409`), re-running to
see the first test go RED, then restoring it. Do not commit the mutation.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/timeEntryService.test.ts
git commit -m "test(tenancy): pin timeEntryService org/partner guards (#4596)"
```

### Task 4: Open the Wave 1 PR

- [ ] **Step 1: Merge `main` and re-verify (PR CI tests the MERGE commit)**

```bash
git fetch origin main && git merge origin/main
scripts/check-migration-naming.sh --against-ref origin/main
```

If the naming guard fails, `main` gained a migration that sorts after yours —
rename the file, update the plan reference, re-run.

- [ ] **Step 2: Full local pre-PR pass**

```bash
pnpm lint
pnpm --filter @breeze/api test --run src/services/timeEntryService.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/timeEntriesOrgPartnerFk src/__tests__/integration/orgLifecycleFoundations src/__tests__/integration/tenantCascade
```

Note the two vitest traps: never insert `--` before `--run`, and vitest's path
filter is a plain substring match, not a glob — check the reported file count.

- [ ] **Step 3: Push and open the PR, then STOP**

PR body must include: the WARNING row count from the cleanup; the
registration-list audit table from this plan verbatim; the "Corrections to the
issue as filed" note about `ticket_parts`; and `Closes` only if Wave 2 is not
happening (otherwise reference `#4596` without closing it).

---

## Wave 2 — `(ticket_id, org_id) -> tickets (id, org_id)` on both tables

Closes the ticket/org disagreement — the real `ticket_parts` gap, and the
mis-attribution half for `time_entries`. **This wave changes both org-move
transactions.** It is independently shippable but must land AFTER Wave 1 (they
touch the same schema file; the migrations are otherwise independent).

### Task 5: Failing forge tests for both tables

**Files:**
- Test: `apps/api/src/__tests__/integration/ticketChildOrgFks.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
/**
 * #4596 Wave 2 — a ticket-linked billing row cannot disagree with its ticket's org.
 *
 * `time_entries.org_id` and `ticket_parts.org_id` are DENORMALIZED from the
 * parent ticket (Phase 3 spec §2) and both FK'd at `organizations(id)` alone.
 * Nothing tied either to `tickets.org_id`, so:
 *   - a part could be attached to another tenant's ticket while carrying the
 *     writer's own org_id — org-axis RLS on ticket_parts checks only the row's
 *     own org_id and never looks at the ticket;
 *   - a time entry could be attributed to org A while its ticket lived in org B,
 *     which is exactly the mis-attribution invoiceAssembly (selects by org_id)
 *     and the #4547 block-hours drawdown would inherit.
 *
 * Both org-move paths rewrite `tickets.org_id` BEFORE the children follow, so
 * both new constraints are DEFERRABLE and both transactions defer them by name.
 * The move regressions live in ticket-move-org.integration.test.ts and
 * time-entries-rls.integration.test.ts — this file covers the forges and the
 * constraint declarations.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { timeEntries, ticketParts, tickets } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const seededPartnerIds: string[] = [];
const admin = () => getTestDb() as any;

// Both shapes copied verbatim from the proven fixtures in
// time-entries-rls.integration.test.ts:140-152.
function orgCtx(orgId: string, userId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId };
}
function partnerCtx(partnerId: string, orgIds: string[], userId: string): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId };
}

async function seed() {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partner = await createPartner({});
  seededPartnerIds.push(partner.id);
  // TWO orgs under the SAME partner: this isolates the new ticket->org
  // constraint from Wave 1's org->partner constraint and from RLS. Every
  // rejection below must therefore be 23503 on a NAMED constraint, never 42501.
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const tech = await createUser({ partnerId: partner.id });
  const [ticketA] = await admin().insert(tickets).values({
    orgId: orgA.id, partnerId: partner.id,
    ticketNumber: `FK-${unique}`, subject: `child-org-fk ${unique}`, source: 'manual',
  }).returning();
  return { partner, orgA, orgB, tech, ticketA };
}

afterAll(async () => {
  for (const id of seededPartnerIds) {
    await admin().execute(sql`DELETE FROM ticket_parts WHERE ticket_id IN (SELECT id FROM tickets WHERE partner_id = ${id}::uuid)`);
    await admin().execute(sql`DELETE FROM time_entries WHERE partner_id = ${id}::uuid`);
    await admin().execute(sql`DELETE FROM tickets WHERE partner_id = ${id}::uuid`);
    await admin().execute(sql`DELETE FROM organizations WHERE partner_id = ${id}::uuid`);
    await admin().execute(sql`DELETE FROM partners WHERE id = ${id}::uuid`);
  }
});

describe('ticket-child org FKs (#4596 W2)', () => {
  it('ticket_parts: a part cannot carry an org_id its ticket does not have', async () => {
    const { orgB, ticketA } = await seed();
    // orgB's own tenant, writing a part it is fully authorised to own (RLS
    // WITH CHECK on org_id passes), attached to orgA's ticket.
    await expect(
      withDbAccessContext(orgCtx(orgB.id, tech.id), () =>
        db.insert(ticketParts).values({
          ticketId: ticketA.id, orgId: orgB.id,
          description: 'forged part', quantity: '1.00', currencyCode: 'USD',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('time_entries: an entry cannot carry an org_id its ticket does not have', async () => {
    const { partner, orgB, tech, ticketA } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partner.id, [orgA.id, orgB.id], tech.id), () =>
        db.insert(timeEntries).values({
          partnerId: partner.id, orgId: orgB.id, ticketId: ticketA.id, userId: tech.id,
          startedAt: new Date(Date.now() - 60_000), endedAt: new Date(),
          durationMinutes: 1, currencyCode: 'USD',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('a matching org_id is accepted on both tables', async () => {
    const { partner, orgA, tech, ticketA } = await seed();
    const [part] = await withDbAccessContext(orgCtx(orgA.id, tech.id), () =>
      db.insert(ticketParts).values({
        ticketId: ticketA.id, orgId: orgA.id,
        description: 'ok part', quantity: '1.00', currencyCode: 'USD',
      }).returning(),
    );
    const [entry] = await withDbAccessContext(partnerCtx(partner.id, [orgA.id, orgB.id], tech.id), () =>
      db.insert(timeEntries).values({
        partnerId: partner.id, orgId: orgA.id, ticketId: ticketA.id, userId: tech.id,
        startedAt: new Date(Date.now() - 60_000), endedAt: new Date(),
        durationMinutes: 1, currencyCode: 'USD',
      }).returning(),
    );
    expect(part!.orgId).toBe(orgA.id);
    expect(entry!.orgId).toBe(orgA.id);
  });

  it('deleting the ticket unlinks the time entry and cascades the part, for the app role', async () => {
    const { partner, orgA, tech, ticketA } = await seed();
    await withDbAccessContext(orgCtx(orgA.id, tech.id), () =>
      db.insert(ticketParts).values({
        ticketId: ticketA.id, orgId: orgA.id,
        description: 'cascade me', quantity: '1.00', currencyCode: 'USD',
      }),
    );
    const [entry] = await withDbAccessContext(partnerCtx(partner.id, [orgA.id, orgB.id], tech.id), () =>
      db.insert(timeEntries).values({
        partnerId: partner.id, orgId: orgA.id, ticketId: ticketA.id, userId: tech.id,
        startedAt: new Date(Date.now() - 60_000), endedAt: new Date(),
        durationMinutes: 1, currencyCode: 'USD',
      }).returning(),
    );
    await admin().execute(sql`DELETE FROM tickets WHERE id = ${ticketA.id}::uuid`);
    const parts = (await admin().execute(sql`SELECT id FROM ticket_parts WHERE ticket_id = ${ticketA.id}::uuid`)) as unknown as unknown[];
    expect(parts).toHaveLength(0);
    // The column-list ON DELETE SET NULL (ticket_id) must NOT null org_id: the
    // labour still belongs to that org after its ticket is gone. A bare
    // composite SET NULL would wipe the attribution.
    const rows = (await admin().execute(sql`
      SELECT ticket_id, org_id FROM time_entries WHERE id = ${entry!.id}::uuid
    `)) as unknown as Array<{ ticket_id: string | null; org_id: string | null }>;
    expect(rows[0]!.ticket_id).toBeNull();
    expect(rows[0]!.org_id).toBe(orgA.id);
  });

  it('both constraints are DEFERRABLE INITIALLY IMMEDIATE (merge contract)', async () => {
    const rows = (await admin().execute(sql`
      SELECT conname, condeferrable, condeferred FROM pg_constraint
      WHERE conname IN ('time_entries_ticket_org_fk', 'ticket_parts_ticket_org_fk')
      ORDER BY conname
    `)) as unknown as Array<{ conname: string; condeferrable: boolean; condeferred: boolean }>;
    expect(rows.map(r => r.conname)).toEqual(['ticket_parts_ticket_org_fk', 'time_entries_ticket_org_fk']);
    expect(rows.every(r => r.condeferrable && !r.condeferred)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm the failures**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticketChildOrgFks.integration.test.ts
```

Expected before the migration: forge tests 1 and 2 FAIL (the inserts succeed),
the DEFERRABLE test FAILS on a 0-row `pg_constraint` read, tests 3 and 4 PASS
(the existing single-column FKs already give the cascade/set-null behaviour —
test 4 exists to prove Wave 2 does not REGRESS it).

- [ ] **Step 3: Commit the red test**

```bash
git add apps/api/src/__tests__/integration/ticketChildOrgFks.integration.test.ts
git commit -m "test(tenancy): failing forge tests for ticket/org disagreement (#4596)"
```

### Task 6: The migration

**Files:**
- Create: `apps/api/migrations/2026-10-05-100001-ticket-child-org-fks.sql`
- Modify: `apps/api/src/db/schema/timeTracking.ts` (comments)

- [ ] **Step 1: Write the migration**

```sql
-- #4596 W2 — ticket-linked billing rows must agree with their ticket's org.
--
-- `time_entries.org_id` and `ticket_parts.org_id` are denormalized from the
-- parent ticket (Phase 3 spec §2) and were FK'd at `organizations(id)` alone.
-- Nothing tied either to `tickets.org_id`. `ticket_parts` is org-axis RLS
-- (Shape 1) so a cross-partner org_id was never writable there — but a part
-- attached to ANOTHER tenant's ticket while carrying the writer's own org_id
-- was, and invoiceAssembly selects parts by org_id. `time_entries` is
-- partner-axis, so the disagreement there is the mis-attribution the #4547
-- block-hours drawdown would inherit.
--
-- Shape copied from ticket_drafts_ticket_org_fk / action_intents_scope_ticket_org_fk
-- (2026-09-25-ai-agents-ticket-triage.sql), which already reference
-- `tickets_id_org_uq (id, org_id)` — created by that same migration, so no new
-- unique index is needed here.
--
-- DEFERRABLE INITIALLY IMMEDIATE is MANDATORY: the referenced side includes a
-- column literally named `org_id`, which
-- orgLifecycleFoundations.integration.test.ts asserts on. Org merge repoints
-- `tickets` and both children in separate statements under
-- `SET CONSTRAINTS ALL DEFERRED` (orgMerge.ts:1022) and would abort mid-walk
-- otherwise.
--
-- The two ORG-MOVE paths need a code change alongside this file — see
-- services/ticketService.ts (moveTicketOrg) and routes/devices/moveOrg.ts. Both
-- UPDATE `tickets.org_id` BEFORE rewriting the children, so with a merely
-- IMMEDIATE check they 23503 the instant the ticket UPDATE completes. They now
-- issue `SET CONSTRAINTS` for these two constraints BY NAME (never `ALL`, which
-- would also defer tickets_requester_contact_org_fk and the ticket_drafts /
-- action_intents FKs those paths deliberately keep immediate).
--
-- The single-column ticket FKs on both tables are KEPT. Composite FKs are
-- MATCH SIMPLE, so a `time_entries` row with `ticket_id` set and `org_id NULL`
-- is not a referencing row at all and its ON DELETE SET NULL would never fire,
-- leaving a dangling ticket_id. Postgres evaluates FKs conjunctively, so the
-- surviving single-column FK is redundant, never permissive. (This is the one
-- place this migration deliberately departs from the portal_users precedent in
-- 2026-10-04-100002, which dropped its superseded FK.)
--
-- Registration (CLAUDE.md cascade table): NOTHING to add. No new table, no new
-- column, and no new PARENT table for either child — both already FK
-- `tickets(id)`, so topologicalCascadeOrder() and
-- CORE_ORG_CASCADE_DELETE_ORDER are unchanged.

SELECT set_config('breeze.scope', 'system', true);

-- Cleanup BEFORE the constraints, so a drifted row cannot abort the file.
--
-- Direction: RE-DERIVE org_id from the parent ticket, do not null it. The
-- ticket IS the authority for a ticket-linked row — that is exactly what
-- resolveTicketLink does at write time (timeEntryService.ts:227-241), and it is
-- what both org-move paths do to these very columns.
--
-- Only rows whose org_id is non-NULL and disagrees are touched. A NULL org_id
-- on a ticket-linked time entry is left alone on purpose: backfilling it would
-- violate time_entries_currency_required_when_org_chk for a row that never got
-- a currency snapshot, and such a row is attributed to no organization, so no
-- org-keyed reader counts it.
--
-- Counts reported UNCONDITIONALLY (see the Wave 1 file for why a suppressed
-- zero is worse than a logged one).
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE time_entries te
     SET org_id = t.org_id
    FROM tickets t
   WHERE t.id = te.ticket_id
     AND te.org_id IS NOT NULL
     AND te.org_id IS DISTINCT FROM t.org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 're-derived % time_entries.org_id row(s) that disagreed with their ticket', n;

  UPDATE ticket_parts tp
     SET org_id = t.org_id
    FROM tickets t
   WHERE t.id = tp.ticket_id
     AND tp.org_id IS DISTINCT FROM t.org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 're-derived % ticket_parts.org_id row(s) that disagreed with their ticket', n;
END $$;

-- DROP + re-ADD rather than a bare ALTER CONSTRAINT: on a database built with
-- `drizzle-kit push` or hand-repaired, a same-named constraint could carry a
-- different definition. Re-adding is the only form that converges every shape.
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_ticket_org_fk;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_ticket_org_fk
  FOREIGN KEY (ticket_id, org_id)
  REFERENCES tickets (id, org_id)
  -- COLUMN-LIST form (PG15+). A bare composite SET NULL would also null
  -- `org_id` — silently destroying the org attribution of billable labour the
  -- moment its ticket is deleted. The labour still belongs to that org.
  ON DELETE SET NULL (ticket_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ticket_parts DROP CONSTRAINT IF EXISTS ticket_parts_ticket_org_fk;
ALTER TABLE ticket_parts
  ADD CONSTRAINT ticket_parts_ticket_org_fk
  FOREIGN KEY (ticket_id, org_id)
  REFERENCES tickets (id, org_id)
  -- Matches the existing single-column FK's action; a part has no meaning
  -- without its ticket.
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- Referencing-side index for both constraints' lookups and for the org-move
-- rewrites, which filter on ticket_id.
CREATE INDEX IF NOT EXISTS ticket_parts_ticket_org_idx ON ticket_parts (ticket_id, org_id);
CREATE INDEX IF NOT EXISTS time_entries_ticket_org_idx
  ON time_entries (ticket_id, org_id) WHERE ticket_id IS NOT NULL;
```

- [ ] **Step 2: Apply and watch the EXISTING move tests go red**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticket-move-org.integration.test.ts \
  src/__tests__/integration/time-entries-rls.integration.test.ts
```

Expected: `ticket-move-org` → "re-stamps org_id on all denormalized children"
and the cross-currency cases FAIL with `23503` naming
`time_entries_ticket_org_fk` / `ticket_parts_ticket_org_fk`;
`time-entries-rls` → "rewrites tickets, time_entries, and ticket_parts org_id
atomically" FAILS the same way. **This red is the point of the task** — it is
the pre-existing suite proving the constraint is live and that the move paths
genuinely need Task 7. Record the exact error text; if you see a different
constraint name, stop and re-read `moveTicketOrg`'s statement order.

- [ ] **Step 3: Commit (red move tests are expected at this commit)**

```bash
git add apps/api/migrations/2026-10-05-100001-ticket-child-org-fks.sql
git commit -m "fix(tenancy): composite (ticket_id, org_id) FKs on ticket billing children (#4596)"
```

### Task 7: Defer the new constraints in both org-move transactions

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (`moveTicketOrg`, ~`:2189`)
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (the move transaction)

**Interfaces:**
- Consumes: constraint names `time_entries_ticket_org_fk`,
  `ticket_parts_ticket_org_fk` from Task 6.

- [ ] **Step 1: `moveTicketOrg` — defer by name as the first statement**

In `apps/api/src/services/ticketService.ts`, inside
`await db.transaction(async (tx) => {`, **before** the
`readOrgStampingDefaultsMany` call, insert:

```ts
    // #4596 W2. `time_entries_ticket_org_fk` and `ticket_parts_ticket_org_fk`
    // are composite (ticket_id, org_id) -> tickets(id, org_id) and DEFERRABLE
    // INITIALLY IMMEDIATE — i.e. checked at the end of EACH statement unless
    // deferred here. The `tx.update(tickets)` below changes `tickets.org_id`
    // while both children still point at the OLD org, so without this the
    // ticket UPDATE 23503s the instant it completes.
    //
    // The children are rewritten a few statements later (the
    // TICKET_ORG_DENORMALIZED_TABLES loop), so deferring to COMMIT is exactly
    // right: at commit time every (ticket_id, org_id) pair resolves again.
    //
    // BY NAME, never `ALL`: `tickets_requester_contact_org_fk`,
    // `ticket_drafts_ticket_org_fk` and `action_intents_scope_ticket_org_fk`
    // are deliberately left IMMEDIATE here — the pre-UPDATE tombstone/delete
    // statements above exist precisely so those fail fast and loudly if a new
    // referencing row type is ever added without its own cleanup.
    await tx.execute(
      sql`SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk DEFERRED`
    );
```

Then extend the existing block comment above the `tx.update(tickets)` statement
(the one beginning "C1 fix (#4191 final review)") with a sentence noting that
its "no `SET CONSTRAINTS ... DEFERRED` is issued in this transaction" claim is
now scoped to the three constraints named there — the two #4596 constraints ARE
deferred. **Do not leave that comment stale; it is load-bearing for the next
person who touches this function.**

- [ ] **Step 2: `routes/devices/moveOrg.ts` — the same deferral**

Insert the same `SET CONSTRAINTS time_entries_ticket_org_fk,
ticket_parts_ticket_org_fk DEFERRED` as the first statement of that route's
`tx` callback, with a comment pointing at `moveTicketOrg` for the rationale and
noting that this path rewrites the same two tables via the ticket join
(`moveOrg.ts:397-403`) AFTER the tickets rows have already moved with the
device.

- [ ] **Step 3: Run the move suites green**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticket-move-org.integration.test.ts \
  src/__tests__/integration/time-entries-rls.integration.test.ts \
  src/__tests__/integration/ticketChildOrgFks.integration.test.ts
```

Expected: all pass, including "a second move of the same ticket to a third org
does not 23503" (`ticket-move-org.integration.test.ts:674`) — that test exists
because this exact failure mode has shipped before.

- [ ] **Step 4: Add a move regression that pins the deferral itself**

Append to `apps/api/src/__tests__/integration/ticket-move-org.integration.test.ts`,
inside the existing `describe('moveTicketOrg — service-level integration')`:

```ts
  it('#4596: moves a ticket that has BOTH an unbilled time entry and a part, and both org_ids follow', async () => {
    // Without the SET CONSTRAINTS deferral this fails with 23503 on
    // time_entries_ticket_org_fk the moment the tickets UPDATE completes —
    // the children still point at the source org at that instant.
    const f = await seedMovableTicketWithChildren();   // reuse this file's existing seed helper
    await moveTicketOrg(f.ticket.id, f.targetOrg.id, f.actor);
    expect((await readTicket(f.ticket.id))!.orgId).toBe(f.targetOrg.id);
    expect((await readTimeEntry(f.timeEntry.id))!.orgId).toBe(f.targetOrg.id);
    expect((await readPart(f.part.id))!.orgId).toBe(f.targetOrg.id);
  });
```

Read the file's existing helpers (`readTicket`/`readTimeEntry`/`readPart` at
`:245-257`) and its seed function before writing this — reuse them rather than
adding parallel fixtures.

- [ ] **Step 5: Verify the deferral is real, not accidental**

Temporarily comment out the `SET CONSTRAINTS` line in `moveTicketOrg`, re-run
the two move suites, and confirm they go RED with `23503`. Restore it. **A green
suite that would also be green without your change proves nothing.**

- [ ] **Step 6: Run the org-lifecycle and cascade contracts**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/orgMerge src/__tests__/integration/tenantCascade \
  src/__tests__/integration/tenant-export-policy src/__tests__/integration/tenantExportErasureRoundtrip
```

Expected: all pass. `orgLifecycleFoundations` is the one that fails loudly if
either constraint was declared non-deferrable.

**If any test in this shard replays a migration file that recreates these
constraints**, it must afterwards call
`reapplyOrgIdFkDeferrability(getTestDb(), ['time_entries_ticket_org_fk',
'ticket_parts_ticket_org_fk'])` — naming them explicitly. Never widen that
helper into a whole-database sweep: a sweep silently repaired three genuinely
non-deferrable FKs and `orgLifecycleFoundations` read green in CI for days while
failing on every fresh database. Our two migrations re-ADD with `DEFERRABLE`, so
a replay of THOSE files preserves deferrability and needs no helper call.

- [ ] **Step 7: Drift check and commit**

```bash
pnpm db:check-drift
pnpm lint
git add apps/api/src/services/ticketService.ts apps/api/src/routes/devices/moveOrg.ts \
        apps/api/src/__tests__/integration/ticket-move-org.integration.test.ts \
        apps/api/src/db/schema/timeTracking.ts
git commit -m "fix(tickets): defer the new ticket/org composite FKs across both org-move paths (#4596)"
```

### Task 8: Open the Wave 2 PR

- [ ] **Step 1: Merge `main`, re-check naming, re-run**

```bash
git fetch origin main && git merge origin/main
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketChildOrgFks src/__tests__/integration/ticket-move-org src/__tests__/integration/time-entries-rls src/__tests__/integration/orgLifecycleFoundations
```

- [ ] **Step 2: Push, open the PR with `Closes #4596`, and STOP**

Do not merge. PR body must carry both WARNING counts, the registration-list
audit, the `ticket_parts` correction, and an explicit statement that the app
layer was audited and found already correct (with the three line references) —
so a reviewer does not read "no app changes" as an oversight.

---

## CI traps that apply to both waves

- **Neither wave's assertions run under `pnpm test`.** Everything here lives in
  `vitest.integration.config.ts`, which `pnpm test` does not invoke. Local green
  on the unit suite says nothing about this work.
- **The `integration-test` job (4 shards) DOES block PRs targeting `main`** — it
  carries no `continue-on-error` and `ci-success` hard-fails on its result. So
  do NOT hand-dispatch CI to "get an integration run" on a normal PR; it already
  ran. (The `continue-on-error: pull_request` in `ci.yml` belongs to the separate
  non-blocking `smoke-test` job.)
- **A stacked PR gets NO CI at all.** `ci.yml` triggers on
  `pull_request: branches: [main]`. If Wave 2 is opened against the Wave 1
  branch instead of `main`, only the two `smoke-binary-source-*` workflows run
  and `gh pr checks` reads GREEN while nothing was tested. Either base Wave 2 on
  `main` (preferred — the migrations are independent) or dispatch per branch:
  `gh workflow run CI --ref <branch>`.
- **PR CI tests the MERGE commit, not your branch.** Merge `origin/main` and
  re-run locally before every push; a stale base is how a green PR reddens main.
- **`gh run rerun --failed` reuses the stale merge commit** after a fix lands on
  `main` — use `gh pr update-branch` instead.
- **Vitest scoping**: never write `pnpm --filter <pkg> test -- --run <path>` (the
  `--` makes vitest run the whole 1,470-file suite in watch mode). The path
  filter is a plain substring match — no globs, and a trailing slash silently
  skips sibling files. Always check the reported file count.
- **Integration tests must live in `apps/api/src/__tests__/integration/`** with
  the `.integration.test.ts` suffix, or they run in ZERO CI jobs. After the first
  CI run, open the shard log and confirm each new file actually EXECUTED — a
  skipped suite reports as green.

---

## Self-review notes

- **Spec coverage.** Issue item 1 (`set_config('breeze.scope','system')`) → both
  migrations, first statement. Item 2 (cleanup with logged count) → Wave 1
  nulls, Wave 2 re-derives, both `RAISE WARNING` unconditionally. Item 3
  (composite FK) → Wave 1 for `(org_id, partner_id)`; for `ticket_parts` the
  issue's proposal is not implementable and is replaced by Wave 2's
  `(ticket_id, org_id)`, with the reasoning recorded above. Item 4 (integration
  forge → `23503`) → Tasks 1 and 5. Item 5 ("export-policy registry unchanged")
  → confirmed by grep in the registration audit. Item 6 ("also check the app
  layer") → audited, found already correct, pinned by Task 3 instead of
  duplicated.
- The issue's suggestion of keeping the FK `NOT VALID` for `ticket_parts` if
  rows exist is **not** carried into this plan: Wave 2's cleanup re-derives from
  the ticket rather than deleting, so there is nothing left to hold back, and a
  `NOT VALID` constraint that nobody ever validates is a permanently open hole
  wearing a closed hole's name.

---

## Open questions (do not block execution; carry to the PR)

1. **Prod drift counts.** Both cleanups run blind. Worth a read-only audit query
   against both regions BEFORE the release that carries these migrations, so a
   non-zero count is investigated as a possible isolation incident rather than
   discovered in a Postgres log:
   `SELECT count(*) FROM time_entries te JOIN organizations o ON o.id = te.org_id WHERE o.partner_id IS DISTINCT FROM te.partner_id;`
   and the two ticket-disagreement equivalents. Expectation is 0 (the app layer
   has always been correct); confirming that is what makes the WARNING lines
   trustworthy.
2. **`ticket_parts` framing.** This plan reinterprets the issue's `ticket_parts`
   half (org-axis, not partner-axis; ticket disagreement, not cross-partner
   write). Confirm the reporter agrees before Wave 2 merges — it changes what
   "fixed" means for that table.
3. **Wave 2 sequencing vs. #4547.** The block-hours drawdown is the reader that
   made this matter. If #4547 starts before Wave 2 lands, its per-org reads
   should be written against the post-Wave-2 invariant (a ticket-linked row's
   `org_id` always equals its ticket's) so nothing has to be revisited.

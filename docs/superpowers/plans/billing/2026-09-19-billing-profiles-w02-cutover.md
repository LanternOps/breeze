---
tracking_issue: TBD
spec: docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md
wave: W02 — the cut-over (one PR). Closes LanternOps/breeze#4628
blast_radius: high (billing data, tenancy, migration)
---

# Billing Profiles W02: The Cut-Over — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three scattered places that price labour with **one**. Ship the profile tables, the Rates screen, the org billing-profile select, `resolveBillingRule()`, stamping on the entry, the always-a-default-card guarantee, the one-time conversion migration with its parity test, the `time_entries:manage_billing` override gate across every writer, and the removal of the six legacy rate fields from the UI and the API — as **one PR**, because a half-cut-over is five places instead of three.

**Architecture:** One PR, but internally ordered so each task is independently reviewable: tables → resolver (pure, no DB) → stamping → default-card guarantee → conversion migration + parity test → override gate → UI → legacy removal. The conversion is a single idempotent SQL migration guarded by `partners.labour_pricing_converted_at`, and it runs **after** a human has read the W01 dry-run report on both production regions. Legacy resolution survives only as a **test-only fixture** that the parity test compares against.

**Tech Stack:** Hono + Drizzle + postgres.js, hand-written idempotent SQL, Astro + React 19 islands + react-i18next, Vitest (unit + integration), the RLS/tenancy contract in `CLAUDE.md`, `runAction` for every web mutation.

**Spec:** `docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md` — §3.2–§3.4 (profiles, resolution, stamping), §3.6 (the conversion and the removal), §3.7 (overrides), §4.2–§4.4 (tables, columns, registration lists), §6 (API), §7 (UI), §9 (tests), §10 (closed decisions).

**Depends on:** W01 (`work_types`, `time_entries.work_type_id`, `ticket_categories.default_work_type_id`, the server-side category default, `billing_profiles:read|write`, the dry-run report) must be **merged**.

---

## READ THIS FIRST: the money-moving difference, sized against current code

Spec §3.6 declares two parity differences. One can move money, and Todd's Gate-A decision (§10 decision 1 = A, clean cut) was taken on the understanding that the dry-run names every affected org. Here is what the code actually says, so nobody has to re-derive it:

**The legacy chain is `apps/api/src/services/timeEntryService.ts:265`:**

```ts
defaultBillable: orgSettings?.defaultBillable ?? category?.defaultBillable ?? false,
```

**`org_ticket_settings.default_billable` is genuinely tri-state, and NULL is reachable through the product UI — not just through legacy data.** Verified at four layers:

| Layer | File:line | Shape |
|---|---|---|
| Migration | `apps/api/migrations/2026-06-13-a-ticketing-configuration.sql:38` | `default_billable boolean` — **nullable**, no default. The migration's own intent is "nullable = inherit" |
| Drizzle | `apps/api/src/db/schema/ticketConfig.ts:46` | `boolean('default_billable')` — **no `.notNull()`** |
| Service | `apps/api/src/services/ticketConfigService.ts:197` | `getOrgBillingDefaults` returns `defaultBillable: boolean \| null` |
| Validator | `packages/shared/src/validators/ticketConfig.ts:66` | `z.boolean().nullable().optional()` — an explicit `null` is accepted from a client |
| Web editor | `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx:23` | typed `boolean \| null`; a genuine **three-way** control: `'true' \| 'false' \| ''` at lines 97-98, mapped back to `true \| false \| null` at line 133, and sent in the PATCH at line 134 |

**By contrast, `ticket_categories.default_billable` is NOT nullable**: `apps/api/migrations/2026-06-09-a-native-ticketing-core.sql:68` creates it `BOOLEAN NOT NULL DEFAULT TRUE`, and `apps/api/src/db/schema/tickets.ts:26` declares `.notNull().default(true)`.

**What that means for the difference.** The `?? false` tail of the chain can only be reached when there is **no category at all** — an uncategorised ticket — *and* the org's `default_billable` is NULL. Those entries are silently non-billable today. After the conversion they are priced by the base row: **billable**, at the org's rate if it has one. So the population that moves money is exactly:

> orgs where `org_ticket_settings.default_billable IS NULL` **AND** `default_hourly_rate IS NOT NULL` **AND** `rate_currency = organizations.currency_code`, with at least one time entry on an uncategorised ticket.

The rate and currency conditions matter: with no rate (or a wrong-currency rate, which match-or-skip already ignores — `timeEntryService.ts:233-237`) the entries become billable-at-no-rate, which bills nothing and merely surfaces as `missingRate` at invoice assembly. With a matching-currency rate they start billing real money.

The org-editor's three-way control is why this is not a theoretical population. **W01's dry-run report enumerates it** (`apps/api/scripts/labour-pricing-dry-run.ts`), and Task 1 below is a STOP gate on that report having been read.

**The second declared difference — non-billable entries stop carrying a rate** — is observable by two currency guards that count any *unbilled entry with a rate*: `apps/api/src/services/orgCurrencyService.ts:225` (`isNotNull(timeEntries.hourlyRate)`) and `apps/api/src/services/ticketMoveCurrencyGuard.ts:106`. Their counts will drop after the conversion. That is correct, not a regression — but say so in the PR so nobody files it as a bug.

---

## Global Constraints

- **One PR.** Every task here lands together. A partially cut-over product prices labour in *more* places than it did before, which is the exact failure spec §1 exists to prevent.
- **Todd's closed decisions (§10), not open for re-litigation:** (1) **clean cut** — convert and remove the six legacy fields in this wave; (2) `time_entries:manage_billing` **binds everyone from release day**, no grant-pushing migration, release-noted; (3) **included hours never draw a block**.
- **Tenancy shape 3 (partner-axis)** for all four new tables: `breeze_has_partner_access(partner_id)`, `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, policy in the creating migration. None may be added to `DUAL_AXIS_TENANT_TABLES` or `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` (spec §4.1; both are shrink-only ratchets, the second at ceiling 0).
- **Migration naming.** Newest **committed** migration as of this plan is `apps/api/migrations/2026-10-20-140000-tickets-partner-org-composite-fk.sql`; W01 adds `2026-10-21-1000{00,01,02}-*`. W02 uses `2026-10-22-*`. **Re-check before committing** (`ls apps/api/migrations | sort | tail -5`) and bump if `origin/main` has moved; the pre-push hook re-checks against `origin/main` and will reject a file that no longer sorts last.
- **The conversion migration writes rows.** It **must** open with `SELECT set_config('breeze.scope','system',true);` before its first `INSERT`/`UPDATE`, report every count through `RAISE WARNING`, be idempotent (re-running is a no-op), and **must never join the `apps/api/src/db/migrationRlsScope.test.ts` frozen baseline** (#4518).
- **Existing time entries are never touched** by the conversion. Their rate, billable flag and status are already snapshots (spec §3.6).
- **Never edit a shipped migration.** Fix forward.
- **Eight-locale parity with real translations**: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`.
- **All web mutations through `runAction`** (`apps/web/src/lib/runAction.ts`).
- **Test commands:** `cd apps/api && npx vitest run <explicit paths>`; **never** `pnpm --filter … test -- --run <path>`; **never** a trailing-slash directory filter. Integration: `pnpm test-stack up` → `npx vitest run --config vitest.integration.config.ts <path>` → `pnpm test-stack down`.
- **Never catch a 23505/23503 inside `withDbAccessContext`** and continue.
- **Vocabulary:** never "agreement". The screen is **Rates**; a card is a **billing profile**; a label is a **work type**.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-22-100000-billing-profiles.sql` | New. `billing_profiles`, `billing_profile_rules`, `org_billing_profile_assignments` + RLS |
| `apps/api/migrations/2026-10-22-100100-time-entries-billing-stamp.sql` | New. `time_entries`: `billing_profile_id`, `coverage`, `billing_overridden`; `partners.labour_pricing_converted_at` |
| `apps/api/migrations/2026-10-22-100200-labour-pricing-conversion.sql` | New. **The row-writing conversion.** System scope first, `RAISE WARNING` counts, idempotent |
| `apps/api/migrations/2026-10-22-100300-manage-billing-permission.sql` | New. `time_entries:manage_billing` row + no back-fill (§10 decision 2) |
| `apps/api/src/db/schema/billingProfiles.ts` | New. Drizzle for the three tables |
| `apps/api/src/services/billingRuleResolver.ts` (+ `.test.ts`) | New. **Pure** `resolveBillingRule()` — no DB, no I/O (the `contractAllowance.ts` pattern) |
| `apps/api/src/services/billingProfileService.ts` (+ `.test.ts`) | New. Card CRUD, rows PUT, clone, assignment, `ensureDefaultProfile` |
| `apps/api/src/services/timeEntryService.ts` | Resolver switch, stamping, override gate via `actor.manageBilling` |
| `apps/api/src/routes/billingProfiles.ts` | Profile CRUD + `PUT /:id/rows` + `POST /:id/clone` (same file W01 created) |
| `apps/api/src/routes/orgs.ts` | `GET/PUT/DELETE /organizations/:orgId/billing-profile` |
| `apps/api/src/services/partnerService.ts` (or wherever partner creation lives) | Create the "Standard rates" profile on partner create |
| `apps/api/src/services/orgCurrencyService.ts` | Legacy rate warnings **rewritten** as "assigned card currency mismatch" |
| `apps/api/src/__tests__/integration/labourPricingConversionParity.integration.test.ts` | New. **The gate.** Legacy resolver as a test-only fixture |
| `apps/api/src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts` | New. Cross-partner forge, composite FK, org-token denial, suspended-org visibility |
| `apps/web/src/components/billing/BillingRatesTab.tsx` (+ `.test.tsx`) | New. The Rates grid: rows = profiles, columns = work types |
| `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx` | Flip the **reserved** `rates` tab on (lines 15-20, 159-168) |
| `apps/web/src/components/billing/OrgBillingSettings.tsx` | Billing-profile select + resolved-rate readout + currency-mismatch banner |
| `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx` | Billing section **deleted** — SLA only |
| `apps/web/src/components/settings/TicketCategoriesPage.tsx` | Three pricing fields **removed**; default-work-type select stays |
| `apps/web/src/components/settings/WorkTypesCard.tsx` | **Moved** from the Categories page into the Rates screen (W01 parked it there for one wave) |
| `apps/web/src/components/tickets/TicketTimeBilling.tsx`, `time/TimerWidget.tsx`, `time/TimesheetPage.tsx` | Outcome line; rate input read-only without `manage_billing` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | New assignment table; new `time_entries` columns; `org_ticket_settings` entry (line 422) keeps the six until W04 drops them |
| `apps/api/src/services/tenantCascade.ts` | `org_billing_profile_assignments` in `CORE_ORG_CASCADE_DELETE_ORDER` |
| `apps/api/src/services/orgMergeRegistry.ts` | `org_billing_profile_assignments: { kind: 'keep-survivor' }` |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `PARTNER_TENANT_TABLES` ×3; `ORG_AXIS_POLICY_EXCLUDED_TABLES` ×1 |

---

### Task 1: STOP GATE — the dry-run must have been read on both regions

**This task writes no code. Do not start Task 2 until it passes.**

Spec §11's focused second review made the clean cut conditional on one thing: *"provided the dry-run is read by a human before the writing run."* W01 shipped that report. Agents have no production SSH, so Todd runs it and records the output.

- [ ] **Step 1: Verify the recorded read exists**

```bash
gh issue view 4628 --comments | grep -i "WILL START BILLING"
```

The comment thread on `LanternOps/breeze#4628` must contain **two** dry-run outputs — one from the **EU** droplet and one from the **US** droplet — each produced by `pnpm --filter @breeze/api dry-run:labour-pricing`, and each explicitly acknowledged by Todd.

- [ ] **Step 2: If they are not both there, STOP**

Post this and end the session. Do not write the conversion migration "ready for when the gate clears" — an unreviewed conversion sitting in a branch is how it gets merged unreviewed.

> W02 is blocked on the §3.6 safeguard: the dry-run report must be run on **both** regions and read by a human before the conversion migration is written. Command (run from `/opt/breeze` or any checkout with `DATABASE_URL` pointed at the region):
>
> ```bash
> pnpm --filter @breeze/api dry-run:labour-pricing
> ```
>
> Paste both outputs here. The section that matters is `WILL START BILLING` — those orgs' uncategorised tickets are silently non-billable today and become billable at the org's rate after the cut-over. Every listed org needs an explicit "yes, that is correct" before this wave proceeds.

- [ ] **Step 3: Record the decision in the PR body**

When the gate clears, copy into the PR: the two run timestamps, the per-region count of orgs in `WILL START BILLING`, and Todd's acknowledgement. A reviewer must be able to see the gate was met without leaving the PR.

---

### Task 2: The three profile tables

**Files:**
- Create: `apps/api/migrations/2026-10-22-100000-billing-profiles.sql`
- Create: `apps/api/src/db/schema/billingProfiles.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES` ~line 187; `ORG_AXIS_POLICY_EXCLUDED_TABLES` ~line 125)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (~line 424)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Test: `apps/api/src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts`

**Interfaces (spec §4.2) — later tasks depend on these exact names:**

```
billing_profiles(
  id, partner_id, name, notes, currency_code -> supported_currencies(code),
  is_default boolean not null default false, is_active boolean not null default true,
  rounding_increment_minutes integer null,            -- NULL or 1..480
  base_coverage text not null,                        -- billable|included|non_billable
  base_hourly_rate numeric(10,2) null, base_minimum_minutes integer null,
  created_at, updated_at)
  UNIQUE (partner_id, lower(name)); UNIQUE (id, partner_id);
  partial UNIQUE (partner_id, currency_code) WHERE is_default AND is_active

billing_profile_rules(
  id, partner_id, billing_profile_id, work_type_id,
  coverage text not null, hourly_rate numeric(10,2) null, minimum_minutes integer null, notes)
  UNIQUE (billing_profile_id, work_type_id);
  FK (billing_profile_id, partner_id) -> billing_profiles ON DELETE CASCADE
  FK (work_type_id, partner_id)       -> work_types

org_billing_profile_assignments(
  id, org_id UNIQUE, partner_id, billing_profile_id, assigned_by, created_at, updated_at)
  FK (org_id, partner_id) -> organizations(id, partner_id) DEFERRABLE INITIALLY IMMEDIATE
  FK (billing_profile_id, partner_id) -> billing_profiles
```

**The base row is COLUMNS, not a NULL-work-type row.** That makes "every profile always answers" a `NOT NULL`, not a convention (spec §4.2). The cost is that the two coverage CHECKs are duplicated on `billing_profiles` — deliberate.

**`org_billing_profile_assignments` gets a PLAIN partner-axis policy, with the org axis applied app-layer.** Not `partner AND breeze_has_org_access(org_id)`. Spec §4.2 and the §11 r1 defect list are explicit about why: accessible-org ids **exclude suspended and archived orgs even for `orgAccess = 'all'`** (`apps/api/src/middleware/auth.ts:410-420`), so a conjunctive policy would make a suspended org's assignment vanish — and a suspended customer still has invoices to reconcile. `time_entries` is the precedent and is already in `ORG_AXIS_POLICY_EXCLUDED_TABLES` (`rls-coverage.integration.test.ts:136`) for exactly this reason. **The new table must be added to that list too**, or the "dual-list trap" the file documents fires: auto-discovery sees the `org_id` column, assumes shape 1, and demands a `breeze_has_org_access` the table intentionally does not have.

**The `(org_id, partner_id) → organizations(id, partner_id)` FK MUST be `DEFERRABLE INITIALLY IMMEDIATE`.** CLAUDE.md: org merge runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent and child `org_id` in separate statements; a non-deferrable one aborts the merge with 23503. Enforced by `orgLifecycleFoundations.integration.test.ts`'s "merge contract", which runs **only** in Integration Tests shard 2 — a unit-green PR still goes red there (#4585 did).

**Registration lists this task owes — all five, in this PR:**

| List | Entry | Why |
|---|---|---|
| `PARTNER_TENANT_TABLES` (`rls-coverage.integration.test.ts` ~:187) | all three, → `partner_id` | shape 3 |
| `ORG_AXIS_POLICY_EXCLUDED_TABLES` (~:125) | `org_billing_profile_assignments` | `org_id` under a partner-axis policy; `time_entries` precedent at :136 |
| `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`) | `org_billing_profile_assignments` | it has an `org_id` column — **always** |
| `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`) | `org_billing_profile_assignments`, all columns `included` | it is now in the org cascade list; no jsonb in this design |
| `orgMergeRegistry.ts` (~:424) | `org_billing_profile_assignments: { kind: 'keep-survivor' }` | `org_id` is UNIQUE, exactly like `org_ticket_settings` at :424 |

`billing_profiles` and `billing_profile_rules` have **no `org_id`**, so they owe none of the org-side lists. **All three are auto-discovered for partner erasure** — verified: `cascadeDeletePartner` (`tenantCascade.ts:1592`) has no static partner list; it sweeps `information_schema.columns WHERE column_name = 'partner_id'` (`:1776-1782`) and orders with `topologicalCascadeOrder` (`:1126`), which reads real FK edges from `pg_constraint`. `ticket_categories` is removed by exactly that sweep and appears in no static list (its `partner_id` FK is plain NO ACTION — `2026-06-09-a-native-ticketing-core.sql:87`). **The `GRANT … DELETE … TO breeze_app` on each new table is therefore load-bearing**: the sweep DELETEs as `breeze_app` under a system context with no role switch.

Two ordering consequences to get right, both handled by declaring the FKs in the database:
- `billing_profile_rules` → `billing_profiles` (ON DELETE CASCADE) and → `work_types`: all three carry `partner_id`, so all three are in the sweep set and the topological sort deletes rules first.
- `time_entries.billing_profile_id` → `billing_profiles` must be **NO ACTION** with no `SET NULL`. `time_entries` carries `partner_id` and is deleted before `billing_profiles`; a `SET NULL` would rewrite billing history during an erasure.

Also note: the user-facing `DELETE /partners/:id` (`apps/api/src/routes/orgs.ts:1329`) is a **soft** delete (`status: 'churned'`, `deletedAt`) and removes nothing; `cascadeDeletePartner` is reachable only from the canary path (`apps/api/src/routes/internal/synthetic.ts:152`). So the erasure ordering is a correctness contract, not a daily code path — which is why Task 15 makes it a test rather than trusting a read.

- [ ] **Step 1: Write the failing RLS integration test**

```ts
// apps/api/src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext } from '../../db';

const partnerA = randomUUID(); const partnerB = randomUUID();
const orgA = randomUUID(); const orgASuspended = randomUUID();
const profileA = randomUUID(); const profileB = randomUUID();

describe('billing profile tables — partner-axis RLS', () => {
  beforeAll(async () => { /* seed two partners, two orgs under A (one active, one suspended), one card each */ });
  afterAll(async () => { /* tear down in FK order: assignments, rules, profiles, orgs, partners */ });

  it('all three tables have ENABLE and FORCE row level security', async () => {
    const rows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('billing_profiles','billing_profile_rules','org_billing_profile_assignments')
    `))) as unknown as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows).toHaveLength(3);
    for (const r of rows) { expect(r.relrowsecurity).toBe(true); expect(r.relforcerowsecurity).toBe(true); }
  });

  it('FORGE: partner B cannot insert a profile attributed to partner A (42501)', async () => {
    await expect(withDbAccessContext({ scope: 'partner', currentPartnerId: partnerB, accessibleOrgIds: [] }, () =>
      db.execute(sql`INSERT INTO billing_profiles (partner_id, name, currency_code, base_coverage)
                     VALUES (${partnerA}, 'Forged', 'USD', 'billable')`),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('FORGE: a rule cannot join partner A\'s profile to partner B\'s work type (composite FK, 23503)', async () => {
    // Name the constraint explicitly -- a bare 23503 match would also pass on an
    // unrelated FK and would be a vacuous assertion.
    const err = await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO billing_profile_rules (partner_id, billing_profile_id, work_type_id, coverage)
      VALUES (${partnerA}, ${profileA}, ${'<a work type owned by partner B>'}, 'billable')
    `)).catch((e) => e);
    expect(err.code).toBe('23503');
    expect(String(err.constraint_name ?? err.constraint)).toContain('work_type');
  });

  it('XOR/CHECK: a non_billable rule may not carry a rate or a minimum (23514)', async () => {
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO billing_profile_rules (partner_id, billing_profile_id, work_type_id, coverage, hourly_rate)
      VALUES (${partnerA}, ${profileA}, ${'<work type A>'}, 'non_billable', 100)
    `))).rejects.toMatchObject({ code: '23514' });
  });

  it('only ONE active default card per (partner, currency) — the partial unique index (23505)', async () => {
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO billing_profiles (partner_id, name, currency_code, base_coverage, is_default, is_active)
      VALUES (${partnerA}, 'Second default', 'USD', 'billable', true, true)
    `))).rejects.toMatchObject({ code: '23505' });
  });

  it('an ORG-scoped token can neither read nor write an assignment', async () => {
    const rows = (await withDbAccessContext({ scope: 'organization', currentOrgId: orgA, accessibleOrgIds: [orgA] }, () =>
      db.execute(sql`SELECT id FROM org_billing_profile_assignments WHERE org_id = ${orgA}`),
    )) as unknown as unknown[];
    expect(rows).toHaveLength(0);
    await expect(withDbAccessContext({ scope: 'organization', currentOrgId: orgA, accessibleOrgIds: [orgA] }, () =>
      db.execute(sql`INSERT INTO org_billing_profile_assignments (org_id, partner_id, billing_profile_id)
                     VALUES (${orgA}, ${partnerA}, ${profileA})`),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('a SUSPENDED org\'s assignment stays readable to its partner — the whole reason the policy is not conjunctive', async () => {
    // CONTROL first: the row exists.
    const control = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT id FROM org_billing_profile_assignments WHERE org_id = ${orgASuspended}`),
    )) as unknown as unknown[];
    expect(control).toHaveLength(1);
    // A conjunctive `partner AND breeze_has_org_access(org_id)` policy would
    // return 0 here, because accessible-org ids exclude suspended orgs even for
    // orgAccess='all' (middleware/auth.ts:410-420). That is the bug this test
    // exists to prevent.
    const rows = (await withDbAccessContext({ scope: 'partner', currentPartnerId: partnerA, accessibleOrgIds: [orgA] }, () =>
      db.execute(sql`SELECT id FROM org_billing_profile_assignments WHERE org_id = ${orgASuspended}`),
    )) as unknown as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('cross-partner: partner B cannot read partner A\'s assignment', async () => {
    const rows = (await withDbAccessContext({ scope: 'partner', currentPartnerId: partnerB, accessibleOrgIds: [] }, () =>
      db.execute(sql`SELECT id FROM org_billing_profile_assignments WHERE org_id = ${orgA}`),
    )) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('the org/partner FK is DEFERRABLE INITIALLY IMMEDIATE (org-merge contract)', async () => {
    const rows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT condeferrable, condeferred FROM pg_constraint
      WHERE conname = 'org_billing_profile_assignments_org_partner_fk'
    `))) as unknown as Array<{ condeferrable: boolean; condeferred: boolean }>;
    expect(rows[0]).toEqual({ condeferrable: true, condeferred: false });
  });
});
```

`NOT VERIFIED: the withDbAccessContext argument shape for partner and organization scopes.` Copy it from `apps/api/src/__tests__/integration/time-entries-rls.integration.test.ts` (the closest precedent — same axis, same org-denormalisation shape). Also fill in the `<work type …>` placeholders from real seeded rows; leaving them as strings makes the test fail on a cast, not on the constraint.

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts
```

Expected: FAIL — `relation "billing_profiles" does not exist`.

- [ ] **Step 3: Write the migration** — `apps/api/migrations/2026-10-22-100000-billing-profiles.sql`, following `2026-10-21-100000-work-types.sql`'s structure exactly (header comment stating tenancy shape, registration lists and erasure behaviour; `CREATE TABLE IF NOT EXISTS`; `DO $$ … pg_constraint` guards for named constraints; `CREATE UNIQUE INDEX IF NOT EXISTS`; `ENABLE`/`FORCE`; `pg_policies`-guarded `CREATE POLICY`; explicit `GRANT SELECT, INSERT, UPDATE, DELETE`). Specifics:

```sql
-- base-row CHECKs, duplicated on billing_profiles because the base row is
-- columns rather than a NULL-work-type row (spec §4.2)
CONSTRAINT billing_profiles_base_coverage_chk
  CHECK (base_coverage IN ('billable','included','non_billable')),
CONSTRAINT billing_profiles_base_rate_only_when_billable_chk
  CHECK (base_coverage = 'billable' OR (base_hourly_rate IS NULL AND base_minimum_minutes IS NULL)),
CONSTRAINT billing_profiles_rounding_range_chk
  CHECK (rounding_increment_minutes IS NULL OR rounding_increment_minutes BETWEEN 1 AND 480)
```

```sql
-- one active default per (partner, currency)
CREATE UNIQUE INDEX IF NOT EXISTS billing_profiles_default_per_currency_uniq
  ON billing_profiles (partner_id, currency_code) WHERE is_default AND is_active;
```

```sql
-- DEFERRABLE INITIALLY IMMEDIATE: org merge runs SET CONSTRAINTS ALL DEFERRED
-- and re-points parent and child org_id in separate statements. A
-- non-deferrable FK aborts the merge with 23503 (CLAUDE.md; enforced by
-- orgLifecycleFoundations.integration.test.ts, Integration Tests shard 2 only).
ALTER TABLE org_billing_profile_assignments
  ADD CONSTRAINT org_billing_profile_assignments_org_partner_fk
  FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
  DEFERRABLE INITIALLY IMMEDIATE;
```

```sql
-- PLAIN partner-axis policy. NOT `partner AND breeze_has_org_access(org_id)`:
-- accessible-org ids exclude suspended and archived orgs even for
-- orgAccess='all' (middleware/auth.ts:410-420), so a conjunctive policy would
-- make a suspended customer's assignment vanish. The org axis is applied
-- app-layer (orgAxisSql / entryOrgAllowed), exactly as time_entries does it --
-- which is why this table joins time_entries in
-- ORG_AXIS_POLICY_EXCLUDED_TABLES.
CREATE POLICY org_billing_profile_assignments_partner_access ON org_billing_profile_assignments
  FOR ALL TO breeze_app
  USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 4: Drizzle schema** — `apps/api/src/db/schema/billingProfiles.ts` exporting `billingProfiles`, `billingProfileRules`, `orgBillingProfileAssignments` plus `$inferSelect` types. Declare composite FKs as **plain single-column references** with a comment pointing at the SQL migration, matching the convention already used at `apps/api/src/db/schema/timeTracking.ts:25-37`. Re-export from `schema/index.ts`.

- [ ] **Step 5: All five registration lists** — exactly as tabulated above. For `CORE_ORG_CASCADE_DELETE_ORDER` the array is **alphabetised by `localeCompare` with `organizations` last**, and `topologicalCascadeOrder`'s runtime `pg_constraint` read is what orders the real DELETE — but `tenantCascade.integration.test.ts` asserts the alphabetical property too, so place `org_billing_profile_assignments` correctly (it sorts **before** `org_documents`, not near `org_ticket_settings` — but check with `localeCompare`, do not eyeball it — `_` vs `b` at the diverging character has bitten this file before, see its comments around line 744).

- [ ] **Step 6: Run every contract suite**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
cd .. && pnpm db:check-drift
```

`orgMergeRegistry.integration.test.ts:417` asserts every `keep-survivor` table has a UNIQUE constraint on exactly `(org_id)` — that is the assertion the new entry must satisfy.

- [ ] **Step 7: Hand-verify the forge as `breeze_app`**, then commit:

```bash
git commit -m "feat(billing): billing profile tables, partner-axis RLS, five registration lists (#4628 W02)"
```

---

### Task 3: `resolveBillingRule()` — the pure resolver

**Files:**
- Create: `apps/api/src/services/billingRuleResolver.ts`
- Test: `apps/api/src/services/billingRuleResolver.test.ts`

**Interfaces:**
```ts
export type Coverage = 'billable' | 'included' | 'non_billable';
export interface ResolvedCard {
  id: string; currencyCode: string; roundingIncrementMinutes: number | null;
  baseCoverage: Coverage; baseHourlyRate: string | null; baseMinimumMinutes: number | null;
  rules: Array<{ workTypeId: string; coverage: Coverage; hourlyRate: string | null; minimumMinutes: number | null }>;
}
export interface BillingRule {
  billingProfileId: string | null; coverage: Coverage;
  hourlyRate: string | null; minimumMinutes: number | null;
  roundingIncrementMinutes: number | null;
  isBillable: boolean; billingStatus: 'not_billed' | 'contract';
  /** true when no card applied — the safety-net branch. Callers log at warn. */
  fellBackToNoCard: boolean;
}
export function resolveBillingRule(input: {
  orgCurrency: string | null;
  assignedCard: ResolvedCard | null;
  partnerDefaultCard: ResolvedCard | null;
  workTypeId: string | null;
}): BillingRule;
```

**Pure: no DB, no I/O, no imports from `../db`.** This is the `contractAllowance.ts` pattern. It is shared by create, timer start, edit, the quick-add hint, the org preview and `aiTimeEntryProposal.ts` (spec §3.3), so it has to be trivially testable and callable from anywhere.

**Two lookups, resolved as a unit (spec §3.3):**
```
card = org's assigned profile, if active and in the org's currency
       else the partner's default profile for the org's currency
       else none
row  = card's row for the entry's work type, else card's base row
```

**Stamping table (spec §3.4) — this is the part that is easy to get subtly wrong:**

| Row | Stamp |
|---|---|
| `billable` @ R | `isBillable: true`, `billingStatus: 'not_billed'`, `hourlyRate: R` (or `null`), `minimumMinutes`, `roundingIncrementMinutes` |
| `included` | `isBillable: **true**`, `billingStatus: 'contract'`, `hourlyRate: **null**` |
| `non_billable` | `isBillable: false`, `billingStatus: 'not_billed'`, `hourlyRate: null` |

**`hourlyRate` stays `null` on an included row on purpose, and `isBillable` stays `true`.** Spec §3.4 and the §11 r1 defect list: `getTicketBillingSummary`, `listBillables` (+ the billing CSV) and the timesheet money loop all filter on `is_billable AND hourly_rate IS NOT NULL` with **no status predicate** — so a rate on an included entry would inflate all three. Task 11 pins that with a money-reader test.

**Match-or-skip is a property of *which card*** (spec §3.3): a card in the wrong currency is never used and never converted. Never convert a rate between currencies here or anywhere.

- [ ] **Step 1: Write the failing table-driven test**

```ts
// apps/api/src/services/billingRuleResolver.test.ts
import { describe, expect, it } from 'vitest';
import { resolveBillingRule, type ResolvedCard } from './billingRuleResolver';

const card = (o: Partial<ResolvedCard> = {}): ResolvedCard => ({
  id: 'card-1', currencyCode: 'USD', roundingIncrementMinutes: null,
  baseCoverage: 'billable', baseHourlyRate: '150.00', baseMinimumMinutes: null, rules: [], ...o,
});

describe('which card', () => {
  it('prefers the ASSIGNED card over the partner default', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null,
      assignedCard: card({ id: 'assigned', baseHourlyRate: '225.00' }),
      partnerDefaultCard: card({ id: 'default', baseHourlyRate: '150.00' }),
    });
    expect(r.billingProfileId).toBe('assigned');
    expect(r.hourlyRate).toBe('225.00');
  });

  it('SKIPS a wrong-currency assigned card and falls to the partner default — never converts', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null,
      assignedCard: card({ id: 'assigned', currencyCode: 'EUR', baseHourlyRate: '200.00' }),
      partnerDefaultCard: card({ id: 'default', baseHourlyRate: '150.00' }),
    });
    expect(r.billingProfileId).toBe('default');
    expect(r.hourlyRate).toBe('150.00');
  });

  it('SKIPS an INACTIVE assigned card', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null,
      assignedCard: null, // an inactive card is filtered by the LOADER; this
                          // case pins that the resolver handles the null it gets
      partnerDefaultCard: card({ id: 'default' }),
    });
    expect(r.billingProfileId).toBe('default');
  });

  it('falls back to "billable, no rate" with fellBackToNoCard when there is NO card at all', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null, partnerDefaultCard: null });
    expect(r).toMatchObject({
      billingProfileId: null, coverage: 'billable', hourlyRate: null,
      isBillable: true, billingStatus: 'not_billed', fellBackToNoCard: true,
    });
  });

  it('a standalone entry with NO org resolves to the no-card safety net', () => {
    const r = resolveBillingRule({ orgCurrency: null, workTypeId: null, assignedCard: null, partnerDefaultCard: card() });
    expect(r.fellBackToNoCard).toBe(true);
    expect(r.billingProfileId).toBeNull();
  });
});

describe('which row', () => {
  it('uses the work-type row when one exists', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: 'wt-onsite', assignedCard: null,
      partnerDefaultCard: card({ rules: [{ workTypeId: 'wt-onsite', coverage: 'billable', hourlyRate: '225.00', minimumMinutes: 60 }] }),
    });
    expect(r).toMatchObject({ hourlyRate: '225.00', minimumMinutes: 60, coverage: 'billable' });
  });

  it('falls to the BASE row when the card has no row for that work type', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: 'wt-new', assignedCard: null,
      partnerDefaultCard: card({ baseHourlyRate: '150.00', rules: [{ workTypeId: 'wt-onsite', coverage: 'billable', hourlyRate: '225.00', minimumMinutes: null }] }),
    });
    expect(r.hourlyRate).toBe('150.00');
  });

  it('falls to the BASE row when the entry has NO work type', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseHourlyRate: '150.00', rules: [{ workTypeId: 'wt-onsite', coverage: 'billable', hourlyRate: '225.00', minimumMinutes: null }] }),
    });
    expect(r.hourlyRate).toBe('150.00');
  });
});

describe('what gets stamped (spec §3.4)', () => {
  it('billable @ R → isBillable true, not_billed, rate R', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseCoverage: 'billable', baseHourlyRate: '150.00', baseMinimumMinutes: 30, roundingIncrementMinutes: 15 }) });
    expect(r).toMatchObject({ isBillable: true, billingStatus: 'not_billed', hourlyRate: '150.00', minimumMinutes: 30, roundingIncrementMinutes: 15 });
  });

  it('INCLUDED → isBillable TRUE, status contract, rate NULL — the rate must be null or three money readers inflate', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseCoverage: 'included', baseHourlyRate: null }) });
    expect(r).toMatchObject({ coverage: 'included', isBillable: true, billingStatus: 'contract', hourlyRate: null });
  });

  it('INCLUDED discards any rate that somehow reached the row — defence in depth over the CHECK', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: 'wt-x', assignedCard: null,
      partnerDefaultCard: card({ rules: [{ workTypeId: 'wt-x', coverage: 'included', hourlyRate: '999.00', minimumMinutes: null }] }) });
    expect(r.hourlyRate).toBeNull();
  });

  it('non_billable → isBillable false, not_billed, rate NULL (today\'s entry minus the pointless rate)', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseCoverage: 'non_billable', baseHourlyRate: null }) });
    expect(r).toMatchObject({ coverage: 'non_billable', isBillable: false, billingStatus: 'not_billed', hourlyRate: null });
  });

  it('a billable row with NO rate is legal — "price at invoice review"; assembly buckets it as missingRate', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseCoverage: 'billable', baseHourlyRate: null }) });
    expect(r).toMatchObject({ isBillable: true, hourlyRate: null, fellBackToNoCard: false });
  });
});
```

- [ ] **Step 2: Run and watch it fail** — `cd apps/api && npx vitest run src/services/billingRuleResolver.test.ts`. Expected: `Cannot find module './billingRuleResolver'`.

- [ ] **Step 3: Implement**, satisfying exactly those cases and nothing more. No DB imports. The module header must state: pure function, no I/O, shared by six callers, and that the `fellBackToNoCard` branch is a **safety net only** — the default-card guarantee (Task 5) means it should never fire in production, and callers log at warn when it does.

- [ ] **Step 4: Green, then commit** — `git commit -m "feat(billing): pure resolveBillingRule (#4628 W02)"`.

---

### Task 4: `billingProfileService.ts` — card CRUD, rows, clone, assignment

**Files:**
- Create: `apps/api/src/services/billingProfileService.ts` (+ `.test.ts`)
- Modify: `apps/api/src/routes/billingProfiles.ts` (the file W01 created)
- Modify: `apps/api/src/routes/orgs.ts` (the org assignment endpoints)
- Test: `apps/api/src/routes/billingProfiles.test.ts`

**Interfaces:**
```ts
export async function listProfiles(partnerId: string): Promise<ResolvedCard[]>;
export async function createProfile(partnerId: string, input: CreateProfileInput): Promise<Profile>;
export async function updateProfile(id: string, partnerId: string, input: UpdateProfileInput): Promise<Profile>;
/** Whole card, one transaction (spec §6). Replaces every rule; never a partial merge. */
export async function replaceProfileRows(id: string, partnerId: string, rows: RowInput[]): Promise<ResolvedCard>;
export async function cloneProfile(id: string, partnerId: string, name: string): Promise<Profile>;
export async function setDefaultProfile(id: string, partnerId: string): Promise<Profile>;
export async function getOrgAssignment(orgId: string, partnerId: string): Promise<Assignment | null>;
export async function assignProfileToOrg(orgId: string, partnerId: string, profileId: string, assignedBy: string): Promise<Assignment>;
export async function clearOrgAssignment(orgId: string, partnerId: string): Promise<void>;
/** Loads the two candidate cards for the resolver. Filters inactive cards HERE,
 *  so resolveBillingRule never sees one (Task 3's "inactive" case). */
export async function loadCardsForOrg(orgId: string, partnerId: string, orgCurrency: string):
  Promise<{ assignedCard: ResolvedCard | null; partnerDefaultCard: ResolvedCard | null }>;
export class BillingProfileServiceError extends Error { constructor(message: string, public status: number, public code: string) }
```

**Routes** (partner scope, `billing_profiles:read|write` from W01):
- `GET /billing-profiles`, `POST /billing-profiles`, `PATCH /billing-profiles/:id`, `DELETE /billing-profiles/:id` (archive)
- `PUT /billing-profiles/:id/rows` — the whole card, **one transaction**
- `POST /billing-profiles/:id/clone`
- `GET/PUT/DELETE /organizations/:orgId/billing-profile`

**`PUT …/:id/rows` replaces the whole card in one transaction** (spec §6). Not per-row PATCHes: the Rates grid edits cells and saves a card, and a partial failure that left half a rate card applied would silently misprice.

**Assignment rejects a currency mismatch up front** with `409 PROFILE_CURRENCY_MISMATCH` (spec §3.3). Do not accept-and-skip: an operator who assigns a EUR card to a USD org must be told, not silently given the partner default.

- [ ] **Step 1: Write the failing service + route tests** covering: create/update/archive; `replaceProfileRows` is transactional (assert one `db.transaction` call and that a mid-way throw rolls back); clone copies base columns + every rule but **not** `is_default`; `setDefaultProfile` clears the previous default in the same currency in the same transaction (the partial unique index would otherwise 23505); `assignProfileToOrg` rejects a cross-currency card with 409 `PROFILE_CURRENCY_MISMATCH`; `assignProfileToOrg` rejects a card belonging to another partner with 404; `loadCardsForOrg` filters `is_active = false`; an **org-scoped** token gets 403 on every route.

`NOT VERIFIED: the transaction helper this repo uses inside a request (db.transaction vs the withDbAccessContext-provided handle).` Read `apps/api/src/db/index.ts` and an existing multi-statement service (`ticketConfigService.ts`'s upsert is the nearest) before writing `replaceProfileRows` — CLAUDE.md warns that `withDbAccessContext` is *already* one transaction, so a nested `db.transaction` may be a savepoint rather than a new transaction, which changes the rollback semantics your test must assert.

- [ ] **Step 2–4:** Run red → implement → green. Commit: `git commit -m "feat(billing): billing profile service and routes (#4628 W02)"`.

---

### Task 5: Every partner always has a default card

**Files:**
- Modify: wherever a partner is created (`grep -rn "insert(partners)" apps/api/src --include='*.ts'`)
- Modify: wherever an org is created and where an org's currency changes (`apps/api/src/services/orgCurrencyService.ts`)
- Modify: `apps/api/src/services/billingProfileService.ts` — `ensureDefaultProfile(partnerId, currency)`
- Test: co-located `.test.ts` for each + one integration proof

**Interfaces:**
- Produces: `export async function ensureDefaultProfile(partnerId: string, currencyCode: string): Promise<Profile>` — idempotent; creates a `"Standard rates"` card with `base_coverage = 'billable'`, `base_hourly_rate = NULL`, `is_default = true` if and only if no active default exists for that `(partner, currency)`.

**Why this is a task and not a line** (spec §3.3, §11): *"no card"* as a primary rule is an unauditable hole — an entry priced by a fallback has nothing behind it to answer "what did the card say on 3 March". Three call sites must guarantee a card exists:

1. **Partner creation** → a `"Standard rates"` card in the partner's currency.
2. **Org creation, and an org currency change**, into a currency with no default card → create one.
3. **The conversion** (Task 6) back-fills every existing partner.

Together these make the resolver's `fellBackToNoCard` branch unreachable in practice, and keep the Rates screen from ever being empty.

**Idempotency is load-bearing** and it races: two concurrent org creations in a new currency would both see "no default" and both insert. The partial unique index `(partner_id, currency_code) WHERE is_default AND is_active` turns that into a 23505 — so `ensureDefaultProfile` must use `ON CONFLICT DO NOTHING` and then re-select, **not** catch-and-continue (a caught 23505 inside `withDbAccessContext` aborts the request transaction; CLAUDE.md).

- [ ] **Step 1: Write the failing tests** — partner create makes exactly one card; calling `ensureDefaultProfile` twice makes one card; an org created in a currency the partner has no card for gets one; an org currency change into a new currency gets one; a concurrent double-call does not throw and yields one card.

- [ ] **Step 2–4:** red → implement → green, plus one integration test against real Postgres that runs two `ensureDefaultProfile` calls concurrently and asserts one row. Commit: `git commit -m "feat(billing): every partner always has a default rate card (#4628 W02)"`.

---

### Task 6: The conversion migration

**Files:**
- Create: `apps/api/migrations/2026-10-22-100100-time-entries-billing-stamp.sql` (the columns the conversion needs)
- Create: `apps/api/migrations/2026-10-22-100200-labour-pricing-conversion.sql` (**the row-writing one**)
- Modify: `apps/api/src/db/schema/timeTracking.ts`, `apps/api/src/db/schema/orgs.ts` (`partners.labourPricingConvertedAt`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `time_entries` entry, line 662)

**New columns (spec §4.3), all nullable or defaulted — no table rewrite:**
`time_entries`: `billing_profile_id` (composite `(…, partner_id)` FK, NO ACTION), `coverage`, `billing_overridden boolean NOT NULL DEFAULT false`, `minimum_minutes`, `rounding_increment_minutes`. (`billable_minutes` and its CHECK are **W03**, not this wave.)
`partners`: `labour_pricing_converted_at timestamptz`.

**Export-policy registration fires again.** `time_entries` is in `CORE_ORG_CASCADE_DELETE_ORDER`, so each `ADD COLUMN` must be classified in `CORE_TENANT_EXPORT_POLICY` — `billing_profile_id`, `coverage`, `billing_overridden`, `minimum_minutes`, `rounding_increment_minutes`, all `included` (none is json/jsonb/bytea; none matches `SUSPICIOUS_NAME_PARTS`). Both export suites need a live DB, so a unit-green PR goes red in Integration Tests shard 2.

**The conversion, step by step (spec §3.6). Every count goes through `RAISE WARNING`.**

1. **Default cards** — one `"Standard rates"` profile per currency in *{the partner's org currencies} ∪ {currencies any category rate was entered in} ∪ {the partner currency}*, base row *billable, no rate*.
2. **Categories → work types** — every category that carries a rate **or** is non-billable, **including inactive ones**. (Verified: `getCategoryDefaults`, `apps/api/src/services/timeEntryService.ts:195-213`, has **no `is_active` predicate**, so retired categories still price entries today.) `ticket_categories` has no unique name and is nested, so: same name + same pricing → one work type; same name + different pricing → parent-path suffix, with a `RAISE WARNING` naming them. Inactive categories make inactive work types.
3. **Rows** — a category with a rate gets a `billable @ rate` row **only in the card of the currency the rate was entered in**; in every other currency no row at all, never a converted number. A non-billable category gets a `non_billable` row in every card; a rate it also carried is dropped and counted.
4. **Org overrides** — for each org whose ticket settings carry a rate or a billable flag: clone the default card for the org's currency, name it after the org, overlay (a billable flag sets the coverage of every row **and** the base; a rate entered in the org's currency sets the rate of every billable row **and** the base; a wrong-currency rate is skipped, exactly as today), collapse rows equal to the base, assign it.
5. **Marker** — `partners.labour_pricing_converted_at` set in the same transaction. **The idempotency guard is this marker, not "partner has any profile"** — a hand-made card would otherwise skip that partner forever and silently lose its legacy pricing (spec §3.6 step 5 / §11). This is also why W01 shipped no profile tables: nobody *could* hand-make a card before the conversion.

**Mandatory migration header content** (CLAUDE.md + spec):
```sql
-- WRITES BILLING DATA. breeze.scope is elected to 'system' FIRST: it defaults
-- to 'none' and 425 of 442 tables are FORCE ROW LEVEL SECURITY, which binds the
-- OWNER. Without the election the UPDATEs match ZERO rows silently (the
-- RAISE WARNING would print a truthful-looking 0) and the INSERTs abort with
-- 42501. This file must NEVER join the migrationRlsScope.test.ts baseline.
SELECT set_config('breeze.scope', 'system', true);
```

Every `INSERT`/`UPDATE` block reports its count:
```sql
GET DIAGNOSTICS n = ROW_COUNT;
IF n > 0 THEN RAISE WARNING 'created % work types from priced categories', n; END IF;
```
**Report the count even when it is 0** for the two declared-difference populations — silently fixing data destroys the forensic trail, and a recorded 0 is itself evidence (the `2026-06-10-c` lesson).

**Existing time entries are NOT touched.** No `UPDATE time_entries` anywhere in this file. Their rate, billable flag and status are already snapshots.

**Idempotency:** guard the whole body on `WHERE labour_pricing_converted_at IS NULL`, and make every insert `ON CONFLICT DO NOTHING`. Task 7's parity suite asserts a second run is a no-op.

- [ ] **Step 1: Write the columns migration + Drizzle + export policy**, run `pnpm db:check-drift` and both export suites. Commit.
- [ ] **Step 2: Write Task 7's parity test FIRST and watch it fail** — the conversion is written against the parity test, not the other way round. Go to Task 7, come back.
- [ ] **Step 3: Write the conversion migration** to make Task 7 green.
- [ ] **Step 4: Prove idempotency** — apply, snapshot `billing_profiles`/`billing_profile_rules`/`org_billing_profile_assignments`, apply again, diff. Zero rows changed.
- [ ] **Step 5: Prove the hand-made-card case** — seed a partner with `labour_pricing_converted_at IS NULL` **and** an existing hand-made profile; run the conversion; assert it still converted that partner's legacy pricing (the §11 finding).
- [ ] **Step 6: Commit** — `git commit -m "feat(billing): one-time labour pricing conversion (#4628 W02)"`.

---

### Task 7: The conversion parity test — the gate for this wave

**Files:**
- Create: `apps/api/src/__tests__/integration/labourPricingConversionParity.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/fixtures/legacyLabourPricingResolver.ts` (**test-only**)

**Interfaces:**
- Produces: `export function legacyResolve(input: { orgSettings, category, orgCurrency }): { isBillable: boolean; hourlyRate: string | null }` — a **verbatim copy** of today's chain, kept only as a test fixture.

**The legacy resolver survives as a test-only fixture** (spec §9). Copy these two functions exactly, with their current line references in a comment so a reviewer can diff them against the originals before they are deleted from the service:
- `resolveDefaultRate` — `apps/api/src/services/timeEntryService.ts:233-239` (match-or-skip: org rate wins iff `rateCurrency === orgCurrency`, else category rate iff match, else null)
- the billable chain — `apps/api/src/services/timeEntryService.ts:265`: `orgSettings?.defaultBillable ?? category?.defaultBillable ?? false`

**Seed one partner per legacy shape (spec §9 — all sixteen, none optional):**

1. category with a rate · 2. non-billable category · 3. non-billable category **with** a rate · 4. org rate · 5. org billable-only · 6. **org row with `default_billable = NULL` and a rate** (the money-moving shape) · 7. org row absent · 8. org row present with all-NULL pricing · 9. wrong-currency org rate · 10. wrong-currency category rate · 11. **duplicate and case-colliding category names** · 12. **nested same-name categories with different rates** · 13. **inactive categories** · 14. a category currency no org uses · 15. org-only config with no priced category · 16. nothing at all · 17. a ticket whose `partner_id` is NULL.

**The assertion.** For every (org, category ∪ none) pair, **for an entry created with no `workTypeId`**, assert `legacyResolve(...)` output equals the new `resolveBillingRule(...)` output — with the two §3.6 differences asserted **explicitly** rather than excluded:

```ts
it('DIFFERENCE 1 (money-moving): an uncategorised ticket in an org with a rate and NULL billable default BECOMES billable', async () => {
  // Legacy: org.defaultBillable(null) ?? category(none) ?? false  =>  NOT billable
  expect(legacyResolve({ orgSettings: { defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'USD' }, category: null, orgCurrency: 'USD' }))
    .toEqual({ isBillable: false, hourlyRate: '150.00' });
  // New: priced by the base row => billable at the org's rate.
  const after = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: await loadAssignedCard(ORG_6), partnerDefaultCard: null });
  expect(after).toMatchObject({ isBillable: true, hourlyRate: '150.00' });
  // This is DECLARED, not a bug. Spec §3.6; Todd's §10 decision 1 = A; the W01
  // dry-run named every affected org and the Task 1 gate recorded the read.
});

it('DIFFERENCE 2: a non-billable entry no longer carries a rate', async () => {
  expect(legacyResolve({ orgSettings: null, category: { defaultBillable: false, defaultHourlyRate: '200.00', rateCurrency: 'USD' }, orgCurrency: 'USD' }))
    .toEqual({ isBillable: false, hourlyRate: '200.00' });        // today: a pointless rate
  const after = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null, partnerDefaultCard: await loadDefaultCard(PARTNER_3) });
  expect(after).toMatchObject({ isBillable: false, hourlyRate: null });
  // Observable by two currency guards that count unbilled entries WITH a rate:
  // orgCurrencyService.ts:225 and ticketMoveCurrencyGuard.ts:106. Their counts
  // drop after the conversion. Correct, not a regression — note it in the PR.
});

it('PARITY everywhere else: every other (org, category) pair resolves identically', async () => {
  for (const [orgId, categoryId] of everyPair()) { /* legacy === new */ }
});

it('re-running the conversion is a NO-OP', async () => { /* snapshot, replay, diff */ });

it('a partner with a HAND-MADE card still converts — the marker is the guard, not "has any profile"', async () => { /* … */ });
```

**Entries created with no `workTypeId` is the whole point of the assertion** (spec §11's first adopted finding): that is the path old mobile builds, the AI tools, the add-in and `intentReleaseWorker` take, and it is what W01's server-side category default exists to keep priced. A parity test that always supplies a work type would prove nothing about the population most at risk.

- [ ] **Step 1: Write the fixture and the suite. Run it — it must FAIL** (no conversion yet). If it passes before the conversion exists, the test is vacuous; fix it before proceeding.
- [ ] **Step 2:** Go implement Task 6 Step 3, return here, and run to green:
```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/labourPricingConversionParity.integration.test.ts
```
- [ ] **Step 3: Commit** — `git commit -m "test(billing): conversion parity suite with the two declared differences (#4628 W02)"`.

---

### Task 8: Resolver switch + stamping on the entry

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts`
- Modify: `apps/api/src/services/aiTimeEntryProposal.ts` (indirect — see note)
- Test: `apps/api/src/services/timeEntryService.test.ts`

**The swap.** `resolveTicketLink` (`timeEntryService.ts:241-269`) stops reading the six legacy columns and instead loads the two candidate cards via `loadCardsForOrg` and calls `resolveBillingRule`. Delete `resolveDefaultRate` (`:233-239`) from the service — it lives on only as Task 7's fixture. `getCategoryDefaults` (`:195-213`) keeps its `defaultWorkTypeId` select (W01) and loses the three pricing columns.

**Stamped on create and on timer start** (spec §3.4): `isBillable`, `billingStatus`, `hourlyRate`, `minimumMinutes`, `roundingIncrementMinutes`, `workTypeId`, `billingProfileId`, `coverage`, plus the existing `currencyCode` snapshot.

**Never re-priced by a config edit** (spec §3.7): editing a row, archiving a card, reassigning an org — none touches an existing entry. Task 9 pins that.

**Re-priced by an edit to the entry itself**, in `updateTimeEntry` only, while the entry is **not billed and not overridden**: changing `workTypeId`, or relinking `ticketId`. The relink case closes a latent bug — today a relink keeps the old org's rate. Any edit still clears approval. The new columns join `BILLED_LOCKED_ENTRY_FIELDS` (`timeEntryService.ts:375`, currently `['startedAt','endedAt','isBillable','hourlyRate','billingStatus','ticketId']`).

**No "work type at stop."** `stopRunningEntry` is a lock-free single-statement CAS, and mobile replays a stop as `PATCH { endedAt }` (§11). Timers are priced at **start**; a technician who started remote and ended on-site edits the entry.

**`aiTimeEntryProposal.ts` needs no direct change** — correcting the spec's §3.6 sweep list: it does **not** read the six columns. It goes through `getTicketTimeEntryDefaults` (`aiTimeEntryProposal.ts:47,120`), and its own header comment (`:30-32`) forbids reading the category directly. So it inherits the new resolution for free. What *does* need attention is `getTicketTimeEntryDefaults`'s **return shape** (`timeEntryService.ts:286-294`, today `{ hourlyRate, currencyCode, isBillable }`): widen it to carry `coverage`, `minimumMinutes` and the resolved profile so the quick-add can render the one-line outcome. Every caller of that function must be updated — `grep -rn "getTicketTimeEntryDefaults" apps/api/src`.

- [ ] **Step 1: Write the failing tests** — create/start stamp all eight fields; an `included` row stamps `billingStatus: 'contract'` with a null rate; a `non_billable` row stamps no rate; a `workTypeId` change on an unbilled, un-overridden entry re-prices; a `ticketId` relink re-prices to the **new** org's card (the latent-bug fix); a **billed** entry rejects a change to any `BILLED_LOCKED_ENTRY_FIELDS` member including the new columns; an **overridden** entry is not re-priced by a work-type change; every edit clears approval.
- [ ] **Step 2–4:** red → implement → green. Commit: `git commit -m "feat(billing): resolve and stamp billing terms on the time entry (#4628 W02)"`.

---

### Task 9: Stamp immunity

**Files:** `apps/api/src/__tests__/integration/billingStampImmunity.integration.test.ts`

Spec §3.7 and §9. Four proofs against real Postgres, because this is the promise the whole design rests on:

- [ ] Edit a profile row → an existing entry's `hourly_rate`, `is_billable`, `billing_status`, `coverage` are byte-identical.
- [ ] Archive a card → same.
- [ ] Reassign the org to a different card → same.
- [ ] `resetBilling` (Task 10, gated) **does** re-price; a **billed** entry is locked even for a `manage_billing` holder.

Each needs a **control**: read the row before and after, and assert the config edit actually landed — otherwise "unchanged" would also pass if the edit silently did nothing.

Commit: `git commit -m "test(billing): stamp immunity against config edits (#4628 W02)"`.

---

### Task 10: The `time_entries:manage_billing` override gate — in the SERVICE

**Files:**
- Create: `apps/api/migrations/2026-10-22-100300-manage-billing-permission.sql`
- Modify: `packages/shared/src/constants/permissions.ts`, `apps/api/src/db/seed.ts`, `apps/api/src/routes/permissionsCatalog.ts`
- Modify: `apps/api/src/services/timeEntryService.ts` (`TimeEntryActor`, lines 79-97)
- Modify: `apps/api/src/routes/timeEntries/timeEntries.ts` (line 47-48), `apps/api/src/routes/officeAddin/time.ts` (line 35), `apps/api/src/services/aiToolsTicketing.ts`, `apps/api/src/jobs/intentReleaseWorker.ts`
- Test: each of the four writer paths

**Interfaces:**
- Produces: `manageBilling: boolean` on `TimeEntryActor` (beside `manageAll`, `timeEntryService.ts:86`); `time_entries.billing_overridden` set true on a deviation; `resetBilling?: boolean` on `UpdateTimeEntryInput`.

**Enforced in the SERVICE, not the route.** Spec §3.7 and the §11 r1 defect list are explicit: the AI tool (`aiToolsTicketing.ts:1005-1013`), the Office add-in and `intentReleaseWorker` pass billing fields straight through and **would bypass a route gate**. There are four actor construction sites and they must all set `manageBilling`:

| Path | File:line | Today |
|---|---|---|
| REST | `apps/api/src/routes/timeEntries/timeEntries.ts:47-48` | `manageAll: auth.user.isPlatformAdmin \|\| hasPermission(perms,'*','*')` |
| Office add-in | `apps/api/src/routes/officeAddin/time.ts:35` | mirror actor builder |
| AI tool | `apps/api/src/services/aiToolsTicketing.ts` (time actions ~:983) | — |
| Worker | `apps/api/src/jobs/intentReleaseWorker.ts` | — (builds no `TimeEntryActor` of its own: it dispatches into `timeEntryActorFrom` at `aiToolsTicketing.ts:129`, the SAME site as the AI-tool row. Three construction sites, not four — nothing to modify in the worker; keep the WORKER test, it proves the shared site covers this path) |

Compute it as `auth.user.isPlatformAdmin || hasPermission(perms, 'time_entries', 'manage_billing')` — `permissionGrantMatches` (`apps/api/src/services/permissionMatching.ts:14-22`) already makes `*:*` match, so **Partner Admin passes with no data change and no back-fill migration** (§10 decision 2 = A).

**Scope of the gate:** required to set `hourlyRate`, `billingStatus` or `minimumMinutes` to something **the card did not resolve**, or to reset an override. Doing so sets `billing_overridden = true`, which is what the approval queue highlights.

**Echo is not an override.** The quick-add posts back the prefilled rate. A value equal to the resolved one — compared as **normalised numerics**, so `'225'` and `'225.00'` are equal — is not a deviation. Getting this wrong makes the ordinary quick-add throw 403 for every technician.

**`isBillable` and `workTypeId` stay technician-editable.** Both answer "what work was this"; a work-type change only ever lands on another *card* price; and an edit gate would be defeated by delete-and-recreate. Approval is the control (§11: this reviewer point was considered and **not adopted** — do not "fix" it).

**No grant-pushing migration** (§10 decision 2 = A). The migration INSERTs the permission row and back-fills **nothing**. The release note says so: technicians who typed rates by hand will need the permission or a card. Also add `manage_billing: 'Manage Billing'` to `ACTION_LABELS` (`apps/api/src/routes/permissionsCatalog.ts:52`) — `permissionsCatalog.test.ts:69` asserts every assignable permission's **resource** has a label, and without an action label the role matrix renders a raw key.

- [ ] **Step 1: Write the failing tests — one per writer path, all four**

```ts
it('REST: a caller WITHOUT manage_billing setting a rate the card did not resolve gets 403', async () => { /* … */ });
it('REST: ECHOING the resolved rate is allowed and does NOT set billing_overridden', async () => { /* … */ });
it('REST: numeric echo — resolved "225.00" vs posted "225" is NOT a deviation', async () => { /* … */ });
it('REST: a holder setting a different rate succeeds and sets billing_overridden = true', async () => { /* … */ });
it('REST: resetBilling requires the permission and re-prices from the card', async () => { /* … */ });
it('AI TOOL: the same deviation through aiToolsTicketing is refused — a route gate would have missed this', async () => { /* … */ });
it('OFFICE ADD-IN: the same deviation through routes/officeAddin/time.ts is refused', async () => { /* … */ });
it('WORKER: intentReleaseWorker cannot set an off-card rate', async () => { /* … */ });
it('isBillable and workTypeId remain editable WITHOUT the permission (deliberate, §11)', async () => { /* … */ });
```

The three non-REST cases are the ones that matter. A gate proven only through the REST route is exactly the r1 defect this design corrects.

- [ ] **Step 2–4:** red → implement → green. Include the permission migration (writes rows → `SELECT set_config('breeze.scope','system',true);` first; model on `apps/api/migrations/2026-10-16-190000-agreements-permission.sql`). Commit: `git commit -m "feat(billing): time_entries:manage_billing override gate in the service (#4628 W02)"`.

---

### Task 11: Money readers — an included entry adds no money

**Files:** tests in the three summary suites named by spec §3.4

Spec §9. `getTicketBillingSummary`, `listBillables` (+ the billing CSV) and the timesheet money loop all filter on `is_billable AND hourly_rate IS NOT NULL` with **no status predicate**. An included entry is `is_billable = true` with a `NULL` rate, so it must fall out of all three by the rate predicate alone.

- [ ] **Step 1:** For each of the three, add a case that puts one `included` entry (billable, `contract`, null rate) alongside a normal billable entry and asserts the money total is **exactly** the normal entry's — not merely "greater than zero".
- [ ] **Step 2:** Add `includedMinutes` to the ticket billing summary (spec §3.4) and assert it counts the included entry's minutes.
- [ ] **Step 3:** Commit — `git commit -m "test(billing): included entries add no money to the three summaries (#4628 W02)"`.

`NOT VERIFIED: the exact file paths of the three money readers.` Find them with `grep -rn "isNotNull(timeEntries.hourlyRate)" apps/api/src` — `orgCurrencyService.ts:225` already shows the idiom.

---

### Task 12: The Rates screen — and MOUNT it

**Files:**
- Create: `apps/web/src/components/billing/BillingRatesTab.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx`
- Move: `apps/web/src/components/settings/WorkTypesCard.tsx` → into the Rates screen
- Modify: `apps/web/src/locales/*/billing.json`

**The tab slot is already reserved and the file tells you exactly what to do.** Verified in `PartnerBillingSettingsPage.tsx`:
- Lines 15-19: *"`rates` is NOT in `BILLING_TABS`: it is a reserved slot in the TABS config below (a typed entry with no button and no panel)… **#4628 W02 adds the Rates panel and flips that one entry's `reserved` flag** — it does not re-order or re-lay-out this page. Do not add `'rates'` to this array or to `activeTab`'s type until #4628 W02 does."*
- Line 20: `const BILLING_TABS = ['defaults', 'documents', 'connections'] as const;`
- Lines 154-158: *"Tab order is Defaults · Documents · Rates (reserved) · Connections… so #4628 W02 can add the real tab as a one-entry diff… Never remove or reorder this entry."*
- Line 162: `{ id: 'rates', labelKey: 'partnerBillingSettingsTabs.rates', reserved: true },`
- Line 168: `renderedTabs = TABS.filter((tab) => !tab.reserved)` with a cast whose comment explains it is safe only while `reserved` entries are excluded.

So the change is: add `'rates'` to `BILLING_TABS` (line 20), **delete** `reserved: true` from line 162, and add the panel beside line 209. **The `renderedTabs` cast at line 168 must be revisited**: once nothing is reserved, `TABS.filter(...)` returns everything and the cast becomes a no-op — leave the filter in place (a future wave may reserve another slot) but confirm TypeScript is still satisfied. The `partnerBillingSettingsTabs.rates` i18n key already exists in all eight locales; verify with `grep -rn "partnerBillingSettingsTabs" apps/web/src/locales/*/billing.json` and only add one if it is missing.

**The screen (spec §7):** the issue's own table, literally. **Rows are billing profiles, columns are work types**, plus an "All other work" column. A cell reads `$150`, `Included`, `Non-billable` or `$225 · 1 h min`; click to edit. Column header menu: rename / archive / add work type. Row menu: clone, set default, archive, "used by N orgs". Rounding and currency sit on the row. **Work types are not a second tab under Ticketing** — which is why `WorkTypesCard` moves here from the Categories page, where W01 parked it for one wave.

**Saving a card is one `PUT …/:id/rows`** through `runAction` — the grid edits cells and saves a card, not a cell.

- [ ] **Step 1: Write the failing tests**

```tsx
// PartnerBillingSettingsPage.test.tsx — the MOUNT proof
it('MOUNT: the Rates tab button is rendered and selectable', async () => {
  renderPartnerBillingSettingsPage();
  await waitFor(() => expect(screen.getByTestId('billing-settings-tab-rates')).toBeInTheDocument());
  await userEvent.click(screen.getByTestId('billing-settings-tab-rates'));
  expect(screen.getByTestId('billing-rates-tab')).toBeInTheDocument();
});
it('MOUNT: #rates in the hash selects the tab (useHashTab)', async () => {
  window.location.hash = 'rates';
  renderPartnerBillingSettingsPage();
  await waitFor(() => expect(screen.getByTestId('billing-rates-tab')).toBeInTheDocument());
});
it('MOUNT: the work types manager lives HERE now, not on the Categories page', async () => {
  renderPartnerBillingSettingsPage();
  await userEvent.click(screen.getByTestId('billing-settings-tab-rates'));
  expect(screen.getByTestId('work-types-card')).toBeInTheDocument();
});
it('the tab order is Defaults · Documents · Rates · Connections', async () => {
  renderPartnerBillingSettingsPage();
  const ids = screen.getAllByRole('tab').map((b) => b.getAttribute('data-testid'));
  expect(ids).toEqual(['billing-settings-tab-defaults','billing-settings-tab-documents','billing-settings-tab-rates','billing-settings-tab-connections']);
});
```

```tsx
// BillingRatesTab.test.tsx
it('renders profiles as ROWS and work types as COLUMNS, with an "All other work" column', async () => { /* … */ });
it('a cell renders $150 / Included / Non-billable / "$225 · 1 h min" per coverage', async () => { /* … */ });
it('a work type with no row in this card shows "uses All other work"', async () => { /* … */ });
it('saving sends ONE PUT to /billing-profiles/:id/rows with the whole card', async () => { /* … */ });
it('the save goes through runAction — a failure is surfaced, not swallowed', async () => { /* … */ });
it('the row menu offers clone, set default, archive and "used by N orgs"', async () => { /* … */ });
it('currency and rounding are edited on the ROW, not per cell', async () => { /* … */ });
```

`NOT VERIFIED: renderPartnerBillingSettingsPage and whether the existing suite already asserts a three-tab order` (the fourth assertion above will conflict with such a test — **update it, do not delete it**).

- [ ] **Step 2–5:** red → build the grid → flip the reserved tab → move `WorkTypesCard` (delete its mount from `TicketCategoriesPage.tsx`) → i18n in eight locales → green:

```bash
cd apps/web && npx vitest run src/components/billing/BillingRatesTab.test.tsx src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/settings/TicketCategoriesPage.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
```

- [ ] **Step 6: Commit** — `git commit -m "feat(web): Settings → Billing → Rates screen (#4628 W02)"`.

---

### Task 13: Org billing-profile select, and the legacy fields out of the UI

**Files:**
- Modify: `apps/web/src/components/billing/OrgBillingSettings.tsx` (522 lines; the currency-impact warning is at line 390, its type at line 35)
- Modify: `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx` (**billing section deleted — SLA only**)
- Modify: `apps/web/src/components/settings/TicketCategoriesPage.tsx` (three pricing fields removed: checkbox at 509-510, rate input at 516-522; `Category` type at 22-26; draft shape at 39-40; the summary label at 108-113; PATCH body at 246-247)
- Modify: `apps/web/src/components/tickets/TicketTimeBilling.tsx`, `time/TimerWidget.tsx`, `time/TimesheetPage.tsx`
- Modify: `apps/api/src/services/orgCurrencyService.ts` (rewrite the warning), `apps/web/src/locales/*/{settings,billing,tickets}.json`
- Test: every co-located suite

**Org billing settings (spec §7):** one "Billing profile" select beside currency, showing the resolved card, read-only rates underneath, and a banner on currency mismatch. **This is the only place an assignment is edited.**

**`orgCurrencyService.ts`'s legacy warning is rewritten, and that is an API contract change.** Verified today: `orgDefaultRate: { configured, rateCurrency, willStopApplying }` (`orgCurrencyService.ts:62`), computed at `:297-307` from `org_ticket_settings.default_hourly_rate` + `ticket_categories.default_hourly_rate`, emitted at `:331-332`, and rendered by `OrgBillingSettings.tsx:390` (type at `:35`, test fixtures at `OrgBillingSettings.test.tsx:128,171`). Replace it with an **assigned-card currency mismatch** warning and update all four places together — a half-done rename leaves a warning that reads correctly and means nothing.

**Ticket quick-add / timer / timesheet (spec §7):** a one-line outcome ("Included in Silver", "$225/h · 1 h minimum"), and **the rate input is read-only without `manage_billing`**. The existing no-rate warning (`TicketTimeBilling.tsx:305`, #5321) stays.

- [ ] **Step 1: Write the failing tests** — including the **removal** assertions, which are the ones an executor forgets:

```tsx
it('REMOVED: the org ticket-settings editor no longer renders ANY billing field — SLA only', async () => {
  renderOrgTicketSettingsEditor();
  expect(screen.queryByTestId('org-ticket-settings-default-billable')).not.toBeInTheDocument();
  expect(screen.queryByTestId('org-ticket-settings-default-rate')).not.toBeInTheDocument();
  expect(screen.getByTestId('org-ticket-settings-sla-overrides')).toBeInTheDocument(); // control: the page still works
});
it('REMOVED: the PATCH body carries no defaultBillable and no defaultHourlyRate', async () => {
  renderOrgTicketSettingsEditor();
  await userEvent.click(screen.getByTestId('org-ticket-settings-save'));
  const body = JSON.parse(lastPatchBody());
  expect('defaultBillable' in body).toBe(false);
  expect('defaultHourlyRate' in body).toBe(false);
});
it('REMOVED: the category editor renders no pricing fields but KEEPS the default work type select', async () => { /* … */ });
it('MOUNT: OrgBillingSettings renders the billing-profile select and the resolved rates readout', async () => { /* … */ });
it('MOUNT: choosing a profile PUTs /organizations/:id/billing-profile through runAction', async () => { /* … */ });
it('shows the currency-mismatch banner when the assigned card is in another currency', async () => { /* … */ });
it('the quick-add shows the resolved outcome line ("Included in Silver")', async () => { /* … */ });
it('the rate input is READ-ONLY without manage_billing and editable with it', async () => { /* … */ });
```

`NOT VERIFIED: every test id in the removal assertions.` `OrgTicketSettingsEditor.test.tsx:28-30,138-139,164-203,284,302-336` and `TicketCategoriesPage.test.tsx:37,42,46,50,359-361,581,598` already exercise these fields — those existing cases are what you must **delete or invert**, and their ids are the real ones.

- [ ] **Step 2–5:** red → implement → i18n (remove `ticketCategoriesPage.defaultHourlyRate` from **all eight** `settings.json` files — English is at `apps/web/src/locales/en/settings.json:4257`; `keyUsage` will flag an orphan) → green:

```bash
cd apps/web && npx vitest run src/components/billing/OrgBillingSettings.test.tsx src/components/settings/OrgTicketSettingsEditor.test.tsx src/components/settings/TicketCategoriesPage.test.tsx src/components/tickets/TicketTimeBilling.test.tsx src/components/time src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
```

- [ ] **Step 6: Commit** — `git commit -m "feat(web): org billing profile select; legacy rate fields out of the UI (#4628 W02)"`.

---

### Task 14: The six legacy fields out of the API — the full sweep

**Files:** every row of the table below.

**Decision §10.1 = A, clean cut.** The resolver stops reading the six columns the day the conversion runs. The **columns themselves are dropped one release later (W04)** — this wave removes every *reader and writer*, and makes the public API **ignore them with a deprecation warning for one release**, then reject (spec §6).

**Verified inventory — every reader and writer, repo-wide.** This is the sweep; a miss here is a silently mispriced entry or a 500.

| Area | File:line | Field(s) | What it does |
|---|---|---|---|
| Service | `services/ticketConfigService.ts:195-197, 203-205` | ots ×3 | `getOrgBillingDefaults` return type + select — **delete the function** |
| Service | `services/ticketConfigService.ts:624-626, 631-633, 649-651` | ots ×3 | `toOrgTicketSettingsResponse` + `getOrgTicketSettings` projections |
| Service | `services/ticketConfigService.ts:695-709, 712, 719-722, 728` | ots rate/billable/currency | `upsertOrgTicketSettings` writes, incl. the `rate_currency` restamp `CASE` |
| Service | `services/timeEntryService.ts:197, 204-206` | tc ×3 | `getCategoryDefaults` — keep `defaultWorkTypeId` (W01), drop the three |
| Service | `services/timeEntryService.ts:233-239` | both rates | `resolveDefaultRate` — **delete**; survives only as Task 7's fixture |
| Service | `services/timeEntryService.ts:265, 267` | both billable/rate | the legacy chain in `resolveTicketLink` — replaced in Task 8 |
| Service | `services/timeEntryService.ts:291-293, 463, 474-475, 512, 588, 598-599, 647, 988` | resolved defaults | create / startTimer / `addTicketPart` seeding |
| Service | `services/orgCurrencyService.ts:62, 297, 299, 306-307, 331-332` | ots+tc rate/currency | readiness warnings — **rewritten** in Task 13 |
| Service | `services/aiTimeEntryProposal.ts:31-32` | comment only | update the comment; **no code change** (it goes through `getTicketTimeEntryDefaults`) |
| Registry | `services/tenantExportPolicyRegistry.ts:422` | ots ×3 | keep until W04 drops the columns — **do not remove now** |
| Route | `routes/orgTicketSettings.ts:65` + PATCH body | ots ×3 | stop accepting; deprecation warning |
| Route | `routes/ticketCategories.ts:197-200, 205, 208` | tc rate/currency | POST stamping — remove |
| Route | `routes/ticketCategories.ts:274-276, 280-282, 285-286, 288-290, 298` | tc rate/currency | PATCH tri-state + restamp logic — remove |
| **Route (grep-invisible)** | `routes/ticketCategories.ts:50` and `:101` | tc ×3 | **bare `.select()`** returns all three columns implicitly. A camelCase grep after removal finds nothing here. Add an explicit projection, or a reviewer will believe the sweep is complete when the API still emits them |
| Validator | `packages/shared/src/validators/ticketConfig.ts:58, 65, 66` | ots rate/billable | public contract — ignore-with-deprecation for one release |
| Validator | `packages/shared/src/validators/tickets.ts:194, 201, 202` | tc rate/billable | same |
| Web | `components/settings/OrgTicketSettingsEditor.tsx:22-23, 25, 95, 97-98, 133-134, 137, 141-142` | ots ×3 | Task 13 |
| Web | `components/settings/TicketCategoriesPage.tsx:22-26, 39-40, 108-113, 126, 139, 224-225, 233, 246-247, 509-510, 516, 521-522` | tc ×3 | Task 13 |
| Web | `components/billing/OrgBillingSettings.tsx:35, 390` | ots.rateCurrency | Task 13 |
| i18n | `locales/en/settings.json:4257` + 7 locales | `ticketCategoriesPage.defaultHourlyRate` | remove the key everywhere |
| E2E | `e2e-tests/tests/multi-currency.spec.ts:124` | ots.defaultHourlyRate | seeds an org rate via the settings API — **rewrite to assign a card** |
| Tests | `routes/orgTicketSettings.test.ts:99,104,141,143,151,157,167,173,179` | ots | delete/invert |
| Tests | `routes/ticketCategories.test.ts:90-91,275-276,321,366-378,408-422,427-439,444-456,460-473,477-489` | tc | delete/invert |
| Tests | `services/ticketConfigService.test.ts:139-140,521-532,543-549,560-587,591-601,605-608,618,624-635` | ots | delete/invert |
| Tests | `services/timeEntryService.test.ts:134,208-224,243,263,279,338-341,356-359,376,390-393,407-410,419,510,513,1000,1014,1454,1497,1844-1847,1857-1860` | both | the large one — rewrite against the resolver |
| Tests | `services/orgCurrencyService.test.ts:198-214` | ots | rewrite for the new warning |
| Tests | `services/aiTimeEntryProposal.test.ts:71,122`; `integration/aiTimeEntryProposal.integration.test.ts:122,396` | tc.defaultBillable | fixtures |
| Integration | `multiCurrencyWave6TicketAssembly.integration.test.ts:10,86,91,95,329,423`; `…VoidReissue…:138`; `orgCurrencyChange…:92,192`; `orgCurrencyCreationBarrier…:287-298`; `orgMerge…:454`; `orgStampingDefaultsErrorMapping…:88`; `ticket-config-rls…:264,286-287,498,558-581,618-641`; `time-entries-rls…:9,92,98-100` | both | fixtures seeding legacy rates |
| **Constraint-asserting suites** | `ticketingCurrencyMigration.integration.test.ts:95-96,102-103,114-126,183,188,230,246-248,288,291-315,318-352`; `ticketingCurrencyBackfill.integration.test.ts:104-105,114,117,137,141,157-160,180-181,196-197,206,210` | both | These assert the CHECK and the two FKs from `2026-08-30-ticketing-currency.sql`. They stay **green in W02** (the columns still exist) but **must be deleted in W04** with the drop migration. Leave a `// W04:` marker on each |

**Confirmed NOT to touch — zero references anywhere** (verified by repo-wide grep on all six spellings): `apps/mobile` (it uses only the resolved per-entry `isBillable`), all four Office add-ins, `packages/office-addin-core`, `apps/portal`, `ee/`, `apps/viewer`, `apps/helper`, `apps/docs`, `agent/`, `packages/extension-*`, **any MCP tool**, **any seed script**, `load-tests/`, `deploy/`, `monitoring/`. The spec's §3.6 sweep list is slightly over-broad on two counts, corrected here: `aiTimeEntryProposal.ts` reads them only through `getTicketTimeEntryDefaults` (comment change only), and there are no standalone fixture files — every fixture write is inline in the suites listed above.

- [ ] **Step 1: Write the deprecation test first**

```ts
it('PATCH /org-ticket-settings IGNORES defaultHourlyRate with a deprecation warning, and does not 400', async () => {
  const res = await orgTicketSettingsRoutes.request('/org-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultHourlyRate: 150, slaOverrides: {} }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.deprecationWarnings).toContain('defaultHourlyRate');
  expect(upsertSpy).toHaveBeenCalledWith(expect.not.objectContaining({ defaultHourlyRate: expect.anything() }));
});
```

One release of ignore-with-warning, then reject (spec §6). **Rejecting immediately would 400 every existing integration** — the point of the grace release is that a caller sending the old field keeps working while its rate quietly comes from the card instead.

- [ ] **Step 2: Work the table top to bottom.** After each area, re-grep to confirm:

```bash
grep -rn "defaultBillable\|default_billable\|defaultHourlyRate\|default_hourly_rate\|rateCurrency\|rate_currency" \
  apps/api/src apps/web/src packages/shared/src e2e-tests \
  --include='*.ts' --include='*.tsx' --include='*.json' | grep -v "docs/superpowers"
```

What should remain: the Drizzle column declarations (`schema/tickets.ts:26-29`, `schema/ticketConfig.ts:43-46`), the export-policy entry (`tenantExportPolicyRegistry.ts:422`), the two constraint-asserting suites, the deprecation handling, and Task 7's legacy fixture. **Nothing else.** And remember the two bare `.select()` call sites (`routes/ticketCategories.ts:50, :101`) that this grep cannot see.

- [ ] **Step 3: Full sweep green**

```bash
cd apps/api && npx vitest run && npx tsc --noEmit -p tsconfig.json
cd apps/web && npx vitest run
cd packages/shared && npx vitest run
cd .. && pnpm lint
```

- [ ] **Step 4: Commit** — `git commit -m "feat(billing): remove the six legacy rate fields from the API and UI (#4628 W02)"`.

---

### Task 15: Contract sweep, erasure proof, docs, release note, PR

- [ ] **Step 1: Every contract suite**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts \
  src/__tests__/integration/labourPricingConversionParity.integration.test.ts \
  src/__tests__/integration/billingStampImmunity.integration.test.ts
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/seed.test.ts
cd .. && pnpm db:check-drift && pnpm lint
```

- [ ] **Step 2: Prove partner erasure end to end.** Seed a partner with all four new tables populated, an org assignment and a stamped time entry; run `cascadeDeletePartner`; assert it completes with **no 23503** and leaves nothing behind. The `information_schema`/`topologicalCascadeOrder` discovery (`tenantCascade.ts:1773-1785`) is read from code, not exercised for *these* tables — this test is what makes it verified. Extend `tenantCascadePartner.integration.test.ts` or add a case to `billingProfilesPartnerRls.integration.test.ts`.

- [ ] **Step 3: Hand-verify as `breeze_app`** — forge a cross-partner insert into each of the three new tables; each must fail with `new row violates row-level security policy`.

- [ ] **Step 4: Amend the block-hours spec** (spec §5, a named step at approval). On `spec/4547-block-hours`, record the two amendments: (a) `contract` is terminal only when `contract_line_id IS NOT NULL` — a card-included entry stays editable by a billing manager, which is how out-of-scope work gets billed; (b) drawdown reads `COALESCE(billable_minutes, duration_minutes)`. And the confirmed assertion (§10 decision 3): **included hours do not draw a block** — they are born `contract`, so they never meet block eligibility.

- [ ] **Step 5: Note on #3198** (spec §5) — business report R2 gains a work-type group-by and an included-minutes column, in W04.

- [ ] **Step 6: Docs + release note.** The release note is not optional; §10 decision 2 is a behaviour change on upgrade day:
  - **`time_entries:manage_billing` binds everyone from release day.** Technicians who type rates by hand will need the permission or a card. Partner Admin (`*:*`) is unaffected.
  - **Self-hosters get the dry-run in the release notes** (spec §3.6): run `pnpm --filter @breeze/api dry-run:labour-pricing` **before** upgrading and read the `WILL START BILLING` section.
  - **Two declared parity differences**, both stated plainly, including that the two currency-guard counts drop.
  - Labour pricing now lives in exactly one place: Settings → Billing → Rates.

- [ ] **Step 7: PR body** — `Closes #4628`; the Task 1 gate record (both regions, timestamps, affected-org counts, Todd's acknowledgement); the five registration lists with reasons; the two declared differences; the permission change; the tab-flip diff in `PartnerBillingSettingsPage.tsx`; and the W04 follow-ups (drop the six columns, delete the two constraint-asserting suites, `billable_minutes` — W03).

- [ ] **Step 8: Tear down**

```bash
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

---

## Self-review notes for the executor

1. **Task 1 is a real gate.** No conversion code before the dry-run is read on both regions and recorded on #4628.
2. **`included` stamps a NULL rate and `isBillable: true`.** Three money readers filter on `is_billable AND hourly_rate IS NOT NULL` with no status predicate. A rate there inflates all three.
3. **The override gate lives in the SERVICE.** A route-only gate is bypassed by the AI tool, the add-in and the worker — the exact r1 defect this design corrects. Four actor construction sites, all four tested.
4. **`org_billing_profile_assignments` gets a PLAIN partner policy**, is in `ORG_AXIS_POLICY_EXCLUDED_TABLES`, and its org FK is `DEFERRABLE INITIALLY IMMEDIATE`. Each of those three has a specific failure it prevents; none is stylistic.
5. **The two bare `.select()` calls at `routes/ticketCategories.ts:50` and `:101`** are invisible to a post-removal grep. They emit all three category pricing columns implicitly.

---
tracking_issue: LanternOps/breeze#3205
---

# Device-Set Quote Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a recurring quote line the same device-set descriptor a contract line already has, derive its quantity server-side from the same snapshot helpers that will bill it, label it as an estimate everywhere the customer can see it, map it to the matching auto-quantity contract line at acceptance — and, on the way, fix #4693 so deleting a site can no longer silently widen a site-scoped contract line to the whole organization.

**Architecture:** Nine nullable columns on `quote_lines` reusing the **contract** enums (`contract_line_type`, `contract_overage_mode`), guarded by one total CHECK and three deferrable composite FKs. `contract_line_type IS NULL` is "an ordinary quote line" and is the whole feature switch. The quantity is derived by one read-only estimator (`quoteDeviceSet.ts`) over one `OrgDeviceSnapshot` per call, built by `buildOrgDeviceSnapshot` extracted from `contractService` so nothing counts devices with its own query. The shared validator delegates to W03's `contractLineInvariantIssues` rather than restating it. The acceptance hash is **versioned** (`quote_acceptances.hash_version`), so every signature already on file keeps verifying under the algorithm that produced it. Acceptance locks the referenced groups/sites `FOR SHARE` before `provider.capture()` and refuses a deleted reference before anything is written. On the contract side, `contract_lines.site_name` is stamped by every writer and backfilled from `sites`, `resolveLineQty` reports `unresolved: 'site_deleted'`, and `generateDueInvoice` refuses 409 `SITE_DELETED` instead of billing org-wide.

**Tech Stack:** Postgres 16, Drizzle ORM, Hono, Zod 4 (`z.string().guid()`, `.strict()`), Vitest (unit + `vitest.integration.config.ts` real-DB suites), React + react-i18next (8 locales), Astro (portal), pdfkit.

**Spec:** `docs/superpowers/specs/billing/2026-09-03-device-set-quote-lines-design.md`

**Wave:** #3205 W05 (wave sub-issue #4654; also closes #4693). Branch from `main` after W04 merges: `feature/3205-quote-lines/wave-4654`.

## Global Constraints

- **Nine nullable columns on `quote_lines`, reusing the contract enums verbatim** — `contract_line_type contract_line_type`, `device_roles text[]`, `device_group_id uuid`, `device_group_name varchar(255)`, `site_id uuid`, `site_name varchar(255)`, `included_quantity numeric(12,2)`, `overage_mode contract_overage_mode`, `overage_unit_price numeric(12,2)`. No quote-local twin enum: one vocabulary means `quoteToContract` maps 1:1 and a future line type cannot be spelled two ways. `contract_line_type IS NULL` ⇒ every other descriptor column NULL.
- **Recurring, non-bundle-child lines only, enforced in SQL** — `recurrence <> 'one_time'` and `parent_line_id IS NULL` are conjuncts of `quote_lines_device_set_chk`, not just validator rules. The merged-row validator rejects a `→ one_time` patch with a 400 so it never reaches the CHECK as a 500.
- **The quantity is server-derived and may be 0.** `quote_lines.quantity = applyAllowance(counted, line, 'included_units').billed`. The client may not supply it (create schema rejects it with a descriptor; the service rejects a `quantity` key on a stored descriptor line). Zero is a first-class outcome — quoting a brand-new customer with no devices enrolled is the single most common case.
- **Every renderer keys "is there recurring content" on `recurrence`, not on money.** Visibility predicates become line tests; amounts stay money-derived. A cadence with lines and no money renders `0.00`.
- **The acceptance hash is versioned.** `computeQuoteSha256(quote, blocks, lines, contractParts, version: 1 | 2 = 2)`; `version === 1` is byte-for-byte today's function. `quote_acceptances.hash_version smallint NOT NULL DEFAULT 1`; `acceptQuote` writes `2`; verification reads the column. No backfill, no re-hash. `v2` hashes **stamped values only** — never `device_group_id` / `site_id`, both FK-nullable after acceptance.
- **The org retarget defers ONE constraint BY NAME** — `SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED`, never `ALL`, so an unrelated tenancy violation in the same transaction still fails at the statement that caused it.
- **Acceptance takes `FOR SHARE` on every referenced `device_groups` / `sites` row before `provider.capture()`**, org-predicated, so a forged cross-tenant id simply does not come back and is reported as deleted.
- **The accepted price is frozen.** A device-set line becomes an auto-quantity contract line with `manualQuantity: null`, `catalogItemId: null` and the quote's `unitPrice` copied. The quote's estimated `quantity` is deliberately dropped.
- **`QUOTED_BY_QUOTES` ships end to end** — service check, both delete routes, the AI `manage_groups` tool, the Device Groups delete modal, eight locales, and tests at every layer. The message *is* the feature: the operator's only way out is to find the quote and edit the line.
- **`updateQuoteLineSchema` becomes `.strict()`** — a mis-keyed field is a 400 `Unrecognized key: "…"`, not a 200 that changed nothing. Verified safe: its one web caller is typed by the closed `LineUpdate` union.
- **#4693 is part of this wave**: `contract_lines.site_name` + a backfill from `sites` under `breeze.scope = system` with a logged row count + a **total** `contract_lines_site_stamp_chk`; `resolveLineQty` returns `unresolved: 'site_deleted'`; `generateDueInvoice` throws 409 `SITE_DELETED` before writing anything. A line that never had a site (`site_id` and `site_name` both NULL) still bills org-wide — that is its correct meaning, and the two states are now distinguishable.
- **Export policy fires on every new column.** `CORE_TENANT_EXPORT_POLICY` changes in three rows: the nine `quote_lines` columns, `contract_lines.site_name`, and `quote_acceptances.hash_version` — all `included`, following W01's `contract_lines.device_roles` precedent for the `text[]`. Nothing else in any registration list changes: `quote_lines` is already in `CORE_ORG_CASCADE_DELETE_ORDER` (`:344`, before `quotes` at `:348`), already in `REPOINT_TABLES` (table-level, so a new column needs nothing), RLS shape 1 (auto-discovered), and has no `device_id` column so none of the three device lists in `routes/devices/core.ts` apply.
- **Migration ceiling must be re-checked, not assumed.** Run `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -3` before creating anything. This worktree ends at W01's `2026-10-05-100100`; W02 adds `2026-10-06-100000` / `-100100`, W03 adds none, W04 adds `2026-10-07-100000`. **W05's floor is `2026-10-07-100000`** → `2026-10-08-100000-…` and `2026-10-08-100100-…` unless something newer landed, in which case bump the date past it and keep the `-100000-` / `-100100-` time components. `2026-08-06` is a closed date block; never reach for it.
- **Two migration files, not one.** The spec argues W05 needs no *enum* split; it does not require a single file. The #4693 contract stamp is independently useful, independently revertable and lands first (Task 1), so it gets `2026-10-08-100000-contract-lines-site-stamp.sql`; the quote-side schema gets `2026-10-08-100100-quote-lines-device-set.sql` (which also carries `quote_acceptances.hash_version`). Both are ordinary same-date files ordered by their time components, exactly as W02 does.
- Migrations are idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add, `DO $$` blocks), with **no inner `BEGIN;`/`COMMIT;`** (`autoMigrate` wraps each file in one transaction). Every cleanup/backfill statement reports its row count with `GET DIAGNOSTICS` + `RAISE WARNING`.
- **Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`** (`orgLifecycleFoundations.integration.test.ts` merge contract).
- Nothing counts devices with its own query. `buildOrgDeviceSnapshot` in `contractQuantities.ts` is the single assembly point; `contractService`'s `orgSnapshot` becomes a cached wrapper over it and W02's untouched tests are the parity proof.
- Run one test file with `cd apps/api && npx vitest run <path>` (never `pnpm --filter … test -- --run`). Integration suites: `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` with the test-stack env:
  `DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test`
  (`pnpm test-stack up` at the repo root, or `docker compose -f docker-compose.test.yml up -d`).
- The integration harness truncates the core tenant tables **between tests**, so every case seeds its own partner/org/site/devices inline. `devices.site_id` is **NOT NULL** — every seeded device names a site.

---

## File map

| File | Change |
|---|---|
| `apps/api/migrations/2026-10-08-100000-contract-lines-site-stamp.sql` (new) | `contract_lines.site_name`, system-scoped backfill with logged count, total site CHECK, re-added group CHECK (#4693) |
| `apps/api/migrations/2026-10-08-100100-quote-lines-device-set.sql` (new) | nine `quote_lines` columns, device-set CHECK, org preflight, three deferrable composite FKs, partial index, `quote_acceptances.hash_version` |
| `packages/shared/src/validators/contracts.ts` (+ `.test.ts`) | `ContractLineShape.siteName`, two persisted-mode rules, `PersistedContractLine.siteName`, merge rule |
| `packages/shared/src/validators/quotes.ts` (+ `.test.ts`) | `QUOTE_DEVICE_SET_TYPES`, `QuoteLineDeviceSetShape`, `quoteLineDeviceSetIssues`, create-schema fields + quantity rule, strict `updateQuoteLineSchema`, `mergeQuoteLinePatch` |
| `apps/api/src/db/schema/contracts.ts`, `quotes.ts` | Drizzle mirror (`contractLines.siteName`; nine `quoteLines` columns + index; `quoteAcceptances.hashVersion`) |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | three `included` rows |
| `apps/api/src/__tests__/integration/contractLinesSiteStampConstraints.integration.test.ts` (new) | #4693 CHECK/backfill/idempotency truth table |
| `apps/api/src/__tests__/integration/contractLineSiteDeleted.integration.test.ts` (new) | #4693 headline regression + the never-had-a-site control |
| `apps/api/src/__tests__/integration/quoteLinesDeviceSetConstraints.integration.test.ts` (new) | quote CHECK/FK/deferrable truth table |
| `apps/api/src/services/contractService.ts` (+ `.test.ts`) | `assertSiteInOrg` returns the row, writers stamp `site_name`, `resolveLineQty` `site_deleted`, generation 409, `orgSnapshot` wrapper, `assertSpecDeviceSetLine` |
| `apps/api/src/services/contractTypes.ts` | `'SITE_DELETED'`, estimate `unresolved` widening |
| `apps/api/src/services/contractQuantities.ts` (+ `.test.ts`) | `buildOrgDeviceSnapshot`, `OrgDeviceSnapshotResult` |
| `apps/api/src/services/quoteDeviceSet.ts` (+ `.test.ts`) (new) | `countQuoteDeviceSetLines`, `persistQuoteDeviceSetQuantities` |
| `apps/api/src/services/quoteService.ts` (+ `quoteService.deviceSet.test.ts`) | writers, refresh, estimate, retarget, clone, currency lock, `getQuote` joins, `CUSTOMER_LINE_FIELDS` |
| `apps/api/src/services/quoteLifecycle.ts` (+ `.test.ts`) | `deviceSetDrift[]` on `SendQuoteResult` |
| `apps/api/src/services/quoteContentHash.ts` (+ `.test.ts`) | `QuoteHashVersion`, `deviceSet` block, `version` key |
| `apps/api/src/services/quoteAcceptService.ts`, `quoteAcceptanceVerify.ts` (+ tests) | `assertQuoteLinesAcceptable` with `FOR SHARE`, `hash_version` write/read |
| `apps/api/src/services/quoteToContract.ts` (+ `.test.ts`) | descriptor fields, `siteName`, the type-aware line mapper |
| `apps/api/src/services/deviceGroupDelete.ts` (+ integration test) | `QUOTED_BY_QUOTES`, `listQuotesPricingGroup` |
| `apps/api/src/routes/quotes/quotes.ts` | `POST /:id/lines/refresh-device-counts`, `GET /:id/device-set-estimate` |
| `apps/api/src/routes/groups.ts`, `routes/devices/groups.ts`, `services/aiToolsFleet.ts` (+ tests) | 409 `GROUP_IN_USE_BY_QUOTES` |
| `apps/api/src/services/aiToolsQuotes.ts` (+ `.test.ts`) | `line` / `patch` tool descriptions |
| `apps/api/src/services/quotePdf.ts` (+ `.test.ts`) | recurrence-keyed visibility, estimate + allowance sentences |
| `apps/web/src/components/billing/quotes/*` (+ tests) | types, `LineUpdate`, descriptor controls, sub-labels, drift chip, recurrence-keyed document |
| `apps/portal/src/components/portal/quoteBlocks.tsx`, `QuoteDetailView.tsx`, `PublicQuoteView.tsx` (+ tests) | recurrence-keyed visibility, hardcoded-English sentences |
| `apps/web/src/components/contracts/*`, `components/devices/DeviceGroupsPage.tsx` (+ tests) | `site_deleted` copy, `GROUP_IN_USE_BY_QUOTES` branch |
| `apps/web/src/locales/*/billing.json`, `*/devices.json` | new keys in 8 locales |
| `apps/docs/src/content/docs/features/quotes.mdx`, `contracts.mdx` | new sections |
| `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` | descriptor-line seed + assertions |

---

### Task 1: #4693 part 1 — shared site-stamp invariants, migration, Drizzle, export policy, constraint truth table

**Files:**
- Modify: `packages/shared/src/validators/contracts.ts` (W03's `ContractLineShape`, `contractLineInvariantIssues`, `PersistedContractLine`, `mergeContractLinePatch`)
- Modify: `packages/shared/src/validators/contracts.test.ts` (append after the W04 allowance describes)
- Create: `apps/api/migrations/2026-10-08-100000-contract-lines-site-stamp.sql`
- Modify: `apps/api/src/db/schema/contracts.ts` (`contractLines`, beside `siteId`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:148` (`contract_lines` row)
- Create: `apps/api/src/__tests__/integration/contractLinesSiteStampConstraints.integration.test.ts`

**Interfaces:**

```ts
// packages/shared/src/validators/contracts.ts
export interface ContractLineShape {
  // …W01–W04 fields unchanged…
  siteName?: string | null;             // NEW (#4693)
}
export interface PersistedContractLine extends ContractLineShape {
  // …unchanged…
  siteName: string | null;              // NEW (#4693)
}
// contractLineInvariantIssues gains two rules, PERSISTED MODE ONLY:
//   present(siteId)   ⇒ present(siteName)
//   present(siteName) ⇒ lineType ∈ { per_device, per_device_role }
// mergeContractLinePatch: siteName follows siteId's tri-state; never read from the patch.
```

```sql
-- apps/api/migrations/2026-10-08-100000-contract-lines-site-stamp.sql
contract_lines.site_name varchar(255)                 -- backfilled from sites
contract_lines_site_stamp_chk                          -- total over line_type
contract_lines_device_group_chk                        -- re-added, widened to forbid a site stamp
```

- [ ] **Step 1: Write the failing validator tests**

Append to `packages/shared/src/validators/contracts.test.ts`:

```ts
// ---------------------------------------------------------------------------
// #4693 (shipped in #3205 W05): the site stamp.
//
// contract_lines_site_org_fk is ON DELETE SET NULL (site_id) with no stamp
// today, so deleting a site turns a site-scoped per_device line into an
// ORG-WIDE one and resolveLineQty bills every device in the org, silently and
// forever. The stamp is what makes "the site you priced was deleted"
// distinguishable from "never had a site".
//
// The rules are PERSISTED-ONLY on purpose. contractLineInputSchema has no
// siteName field — a caller names a site by id and the server resolves the name,
// exactly as it already does for deviceGroupName. `create` describes what a
// caller may send; `persisted` describes what a stored row may be.
// ---------------------------------------------------------------------------
describe('contract line site stamp (#4693)', () => {
  const SITE = '22222222-2222-4222-8222-222222222222';
  const GROUP = '33333333-3333-4333-8333-333333333333';
  const paths = (l: Parameters<typeof contractLineInvariantIssues>[0], mode: 'create' | 'persisted') =>
    contractLineInvariantIssues(l, { mode }).map((i) => i.path);

  it('persisted requires siteName whenever siteId is set', () => {
    expect(paths({ lineType: 'per_device', siteId: SITE }, 'persisted')).toEqual(['siteName']);
    expect(paths({ lineType: 'per_device', siteId: SITE, siteName: 'Dallas' }, 'persisted')).toEqual([]);
    expect(paths({ lineType: 'per_device_role', deviceRoles: ['server'], siteId: SITE, siteName: 'Dallas' }, 'persisted')).toEqual([]);
  });

  // THE WHOLE POINT: id NULL + stamp present is the DELETED state, and it is
  // legal on a stored row. id NULL + stamp NULL means "never had a site" and is
  // equally legal — resolveLineQty reads exactly that difference.
  it('persisted allows a stamped name with a NULL id, and no stamp at all', () => {
    expect(paths({ lineType: 'per_device', siteId: null, siteName: 'Dallas' }, 'persisted')).toEqual([]);
    expect(paths({ lineType: 'per_device', siteId: null, siteName: null }, 'persisted')).toEqual([]);
  });

  it('persisted rejects a site stamp on a type that cannot be site-scoped', () => {
    expect(paths({ lineType: 'flat', siteName: 'Dallas' }, 'persisted')).toEqual(['siteName']);
    expect(paths({ lineType: 'per_seat', siteName: 'Dallas' }, 'persisted')).toEqual(['siteName']);
    expect(paths({ lineType: 'manual', manualQuantity: '2', siteName: 'Dallas' }, 'persisted')).toEqual(['siteName']);
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GROUP, deviceGroupName: 'VIP', siteName: 'Dallas' }, 'persisted')).toEqual(['siteName']);
  });

  it('create ignores both rules — siteName is not an input field', () => {
    expect(paths({ lineType: 'per_device', siteId: SITE }, 'create')).toEqual([]);
    expect(paths({ lineType: 'per_seat', siteName: 'Dallas' }, 'create')).toEqual([]);
  });
});

describe('mergeContractLinePatch carries the site stamp (#4693)', () => {
  const current = {
    lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: true,
    catalogItemId: null, manualQuantity: null, siteId: '22222222-2222-4222-8222-222222222222',
    siteName: 'Dallas', deviceRoles: null, deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: null, overageMode: null, overageUnitPrice: null,
  } as never;

  it('an omitted siteId leaves the stamp alone', () => {
    expect(mergeContractLinePatch(current, { description: 'x' } as never)).toMatchObject({ siteId: '22222222-2222-4222-8222-222222222222', siteName: 'Dallas' });
  });

  // Clearing the site widens the line to the whole org DELIBERATELY, so the
  // stamp must go with it — otherwise the row reads as "site deleted".
  it('siteId: null clears the stamp, and the merged row is valid', () => {
    const merged = mergeContractLinePatch(current, { siteId: null } as never);
    expect(merged).toMatchObject({ siteId: null, siteName: null });
    expect(contractLineInvariantIssues(merged, { mode: 'persisted' })).toEqual([]);
  });

  // Re-pointing keeps the OLD stamp in the merged row; the service re-stamps
  // from the resolved site after the invariants run, exactly as it does for
  // deviceGroupName (W03 decision 7).
  it('a new siteId keeps the old stamp for the invariant pass', () => {
    const merged = mergeContractLinePatch(current, { siteId: '44444444-4444-4444-8444-444444444444' } as never);
    expect(merged).toMatchObject({ siteId: '44444444-4444-4444-8444-444444444444', siteName: 'Dallas' });
    expect(contractLineInvariantIssues(merged, { mode: 'persisted' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts`
Expected: FAIL — `siteName` is not on `ContractLineShape`, every `paths(...)` expecting `['siteName']` returns `[]`, and `mergeContractLinePatch` drops the key.

- [ ] **Step 3: Implement the validator changes**

In `packages/shared/src/validators/contracts.ts`, `ContractLineShape` gains:

```ts
  // #4693 (W05): the site's name, stamped at write. The composite site FK is
  // ON DELETE SET NULL (site_id), so the stamp OUTLIVES the id — that is the
  // whole mechanism: `id NULL + stamp` means DELETED, `id NULL + no stamp`
  // means the line was never site-scoped. Display and history only; billing
  // always reaches the live sites row by id (spec decision 22).
  siteName?: string | null;
```

In `contractLineInvariantIssues`, inside the `else` (persisted) branch, after the `deviceGroupName` rule:

```ts
    // #4693: a stored site-scoped line always carries its stamp. `create`
    // ignores both rules because contractLineInputSchema has no siteName field —
    // the writer resolves it from the site row, the same asymmetry
    // deviceGroupName already has.
    if (present(l.siteId) && !present(l.siteName)) {
      issues.push({ path: 'siteName', message: 'siteName must be stamped alongside siteId' });
    }
    if (present(l.siteName) && !SITE_SCOPABLE_LINE_TYPES.has(l.lineType)) {
      issues.push({ path: 'siteName', message: 'siteName is only valid on per_device and per_device_role lines' });
    }
```

`PersistedContractLine` gains `siteName: string | null;` beside `siteId`. In `mergeContractLinePatch`, immediately after the `siteId` line:

```ts
    // #4693: the stamp follows its id. Clearing siteId clears the stamp (the
    // line is deliberately org-wide now, NOT "site deleted"); re-pointing keeps
    // the old stamp so the invariants pass, and the service re-stamps from the
    // resolved site afterwards — deviceGroupName's rule, applied to sites.
    // Never read from the patch: siteName is not a patch field.
    siteName: patchHasKey(patch, 'siteId') ? (patch.siteId ? current.siteName : null) : current.siteName,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS — including every **unedited** W01/W02/W03/W04 describe. If one needed an edit, the `create` mode is no longer behaviour-preserving: fix the helper, not the test.

- [ ] **Step 5: Confirm the migration ceiling, then write the migration**

Run: `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -3`
Expected (with W01–W04 merged): `2026-10-06-100100-contract-lines-device-group.sql`, `2026-10-07-100000-contract-lines-allowance.sql` (W04's name), plus whatever else landed. If anything sorts after `2026-10-07-100000`, bump the date below past it.

Create `apps/api/migrations/2026-10-08-100000-contract-lines-site-stamp.sql`:

```sql
-- #4693 (shipped with #3205 wave 5 / #4654): stamp the site's NAME on a
-- site-scoped contract line.
-- Spec: docs/superpowers/specs/billing/2026-09-03-device-set-quote-lines-design.md
--       § "Contract-line site stamp (#4693)"
--
-- Wave 1's contract_lines_site_org_fk is
--   FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
--   ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE
-- with NO stamped name. So deleting a site turns a per_device line scoped to
-- "Dallas" into an ORG-WIDE line, resolveLineQty bills every device in the org,
-- and nothing distinguishes that state from a line that never had a site.
-- This file adds the column, backfills it from the live sites table, and then
-- makes the strong direction a constraint.

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS site_name varchar(255);

-- Backfill from the live sites table. This is not inventing evidence — it reads
-- the current truth for every line whose site still exists, which is what makes
-- the fix protect CONTRACTS THAT ALREADY EXIST rather than only new ones.
-- Without it the strong CHECK below could not be added at all, and every
-- currently site-scoped line would stay silently widenable forever.
--
-- breeze.scope = system is REQUIRED: contract_lines is forced-RLS and the
-- migration runs as an unprivileged role on managed Postgres, where a
-- context-less UPDATE silently affects 0 rows.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  UPDATE contract_lines cl SET site_name = s.name
    FROM sites s WHERE s.id = cl.site_id AND cl.site_name IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'stamped site_name on % existing contract_lines row(s) (#4693)', n;
END $$;

-- After the backfill the only rows with site_id set and no stamp would be ones
-- whose site vanished between the UPDATE and here, inside this transaction —
-- impossible. So the strong direction is enforceable from day one.
--
-- TOTAL over line_type, so no type is left unconstrained. Site-scopable types
-- may carry a site, and a carried site always carries its stamp; every other
-- type carries neither column. (Wave 1's CHECK only ever constrained roles, and
-- wave 2's only forbade a site_id on group lines — flat, manual and per_seat
-- were never constrained on the site axis at all. This closes that too.)
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_stamp_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_site_stamp_chk CHECK (
  CASE WHEN line_type IN ('per_device', 'per_device_role')
    THEN (site_id IS NULL OR site_name IS NOT NULL)
    ELSE site_id IS NULL AND site_name IS NULL END
);

-- Wave 2 forbids a site_id on a group line; the stamp has to be forbidden there
-- too or an internal writer could park a site_name on one. Redundant with the
-- ELSE arm above and kept anyway: wave 2's constraint is where a reader looks
-- for the group rules, and a wave-2 reader must not conclude a stamp is allowed.
-- DROP + re-ADD is the only way to widen a shipped CHECK (2026-10-06-100100 is
-- content-hash immutable).
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_group_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_group_chk CHECK (
  CASE WHEN line_type = 'per_device_group'
    THEN device_group_name IS NOT NULL AND site_id IS NULL AND site_name IS NULL
    ELSE device_group_id IS NULL AND device_group_name IS NULL END
);
```

**Accepted residual, recorded here and in the release note:** a contract line whose site was deleted *before* this migration has `site_id IS NULL` **and** `site_name IS NULL`, indistinguishable from a line that never had a site. Those rows keep billing org-wide. There is no way to recover a deleted site's name, and inventing one would be worse than the gap; the `RAISE WARNING` count is the forensic record of how many lines *were* protected.

- [ ] **Step 6: Drizzle + export policy**

`apps/api/src/db/schema/contracts.ts`, in `contractLines` immediately after `siteId`:

```ts
  // #4693: the site's name at write time. Survives the FK's ON DELETE SET NULL
  // (site_id), which is what makes a deleted site detectable. SQL-only
  // constraint: contract_lines_site_stamp_chk (2026-10-08-100000).
  siteName: varchar('site_name', { length: 255 }),
```

`apps/api/src/services/tenantExportPolicyRegistry.ts:148` — add `"site_name"` to the `contract_lines` `included` array, immediately after `"site_id"`. (Ordinary customer data: the name of one of the customer's own sites. Not `excludedOpen` — it is a `varchar`, not an open container.)

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: clean (nothing reads the column yet).

- [ ] **Step 7: Write the failing constraint integration suite**

Create `apps/api/src/__tests__/integration/contractLinesSiteStampConstraints.integration.test.ts`:

```ts
/**
 * Real-DB truth table for the #4693 contract_lines site stamp, as breeze_app
 * (forced RLS, no bypass). Mirrors contractLinesDeviceGroupConstraints.
 *
 * Also replays the migration file to prove the backfill and idempotency, which
 * is the only way to test a backfill whose precondition the shipped CHECK now
 * forbids: drop the constraint, null a stamp, re-run the file.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, contracts, contractLines, deviceGroups } from '../../db/schema';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-10-08-100000-contract-lines-site-stamp.sql');
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `SS ${sfx}`, slug: `ss-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'SO', slug: `so-${sfx}` })
      .returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: o!.id, name: `Dallas ${sfx}` }).returning({ id: sites.id, name: sites.name });
    const [g] = await db.insert(deviceGroups).values({ orgId: o!.id, name: `VIP ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id, name: deviceGroups.name });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'C', intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return { orgId: o!.id, site: site!, group: g!, contractId: c!.id };
  });
}

/** Raw insert as breeze_app so the CHECK — not Drizzle typing — is what rejects. */
async function rawLine(f: Awaited<ReturnType<typeof seed>>, cols: Record<string, unknown>) {
  return withSystemDbAccessContext(() => db.insert(contractLines).values({
    contractId: f.contractId, orgId: f.orgId, description: 'x', unitPrice: '1.00', taxable: false,
    ...cols,
  } as never).returning({ id: contractLines.id }));
}

describe('contract_lines site stamp constraints (#4693)', () => {
  runDb('accepts a site-scoped line WITH a stamp on both site-scopable types', async () => {
    const f = await seed();
    for (const lineType of ['per_device', 'per_device_role'] as const) {
      const rows = await rawLine(f, {
        lineType, siteId: f.site.id, siteName: f.site.name,
        ...(lineType === 'per_device_role' ? { deviceRoles: ['server'] } : {}),
      });
      expect(rows).toHaveLength(1);
    }
  });

  runDb('rejects site_id without site_name', async () => {
    const f = await seed();
    await expect(rawLine(f, { lineType: 'per_device', siteId: f.site.id })).rejects.toThrow(/contract_lines_site_stamp_chk/);
  });

  runDb('rejects a site stamp on flat, manual, per_seat and per_device_group', async () => {
    const f = await seed();
    await expect(rawLine(f, { lineType: 'flat', siteName: 'Dallas' })).rejects.toThrow(/contract_lines_site_stamp_chk/);
    await expect(rawLine(f, { lineType: 'per_seat', siteName: 'Dallas' })).rejects.toThrow(/contract_lines_site_stamp_chk/);
    await expect(rawLine(f, { lineType: 'manual', manualQuantity: '2', siteName: 'Dallas' })).rejects.toThrow(/contract_lines_site_stamp_chk/);
    // The re-added wave-2 constraint is the one that fires for a group line.
    await expect(rawLine(f, {
      lineType: 'per_device_group', deviceGroupId: f.group.id, deviceGroupName: f.group.name, siteName: 'Dallas',
    })).rejects.toThrow(/contract_lines_(device_group|site_stamp)_chk/);
  });

  runDb('accepts a line that never had a site, and one whose site was deleted', async () => {
    const f = await seed();
    expect(await rawLine(f, { lineType: 'per_device' })).toHaveLength(1);
    const [scoped] = await rawLine(f, { lineType: 'per_device', siteId: f.site.id, siteName: f.site.name });
    await withSystemDbAccessContext(() => db.delete(sites).where(eq(sites.id, f.site.id)));
    const [after] = await withSystemDbAccessContext(() =>
      db.select({ siteId: contractLines.siteId, siteName: contractLines.siteName })
        .from(contractLines).where(eq(contractLines.id, scoped!.id)));
    // The FK nulls the ID ONLY. The stamp is what survives — the whole fix.
    expect(after).toEqual({ siteId: null, siteName: f.site.name });
  });

  runDb('the backfill stamps a pre-existing site-scoped row, and re-applying is a no-op', async () => {
    const f = await seed();
    const [line] = await rawLine(f, { lineType: 'per_device', siteId: f.site.id, siteName: f.site.name });
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    await withSystemDbAccessContext(async () => {
      // Reproduce the pre-migration world: no CHECK, no stamp.
      await db.execute(sql.raw('ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_stamp_chk'));
      await db.execute(sql`UPDATE contract_lines SET site_name = NULL WHERE id = ${line!.id}`);
      await db.execute(sql.raw(migration));
    });
    const [restamped] = await withSystemDbAccessContext(() =>
      db.select({ siteName: contractLines.siteName }).from(contractLines).where(eq(contractLines.id, line!.id)));
    expect(restamped!.siteName).toBe(f.site.name);
    // Idempotency: a second run changes nothing and raises no error.
    await withSystemDbAccessContext(() => db.execute(sql.raw(migration)));
    const [again] = await withSystemDbAccessContext(() =>
      db.select({ siteName: contractLines.siteName }).from(contractLines).where(eq(contractLines.id, line!.id)));
    expect(again!.siteName).toBe(f.site.name);
    // And the constraint is back, so a forged row is rejected again.
    await expect(rawLine(f, { lineType: 'per_device', siteId: f.site.id })).rejects.toThrow(/contract_lines_site_stamp_chk/);
  });
});
```

- [ ] **Step 8: Run — red, then migrate, then green**

```bash
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractLinesSiteStampConstraints.integration.test.ts
```
Expected first run: FAIL (`column "site_name" does not exist`). Then:
```bash
cd apps/api && pnpm db:migrate && pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractLinesSiteStampConstraints.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: `db:check-drift` clean; both suites PASS. Watch the migrate output for `WARNING: stamped site_name on N existing contract_lines row(s) (#4693)`.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/validators/contracts.ts packages/shared/src/validators/contracts.test.ts \
  apps/api/migrations/2026-10-08-100000-contract-lines-site-stamp.sql \
  apps/api/src/db/schema/contracts.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/__tests__/integration/contractLinesSiteStampConstraints.integration.test.ts
git commit -m "feat(billing): stamp contract_lines.site_name with backfill and a total site CHECK (#4693, #3205 W05)"
```

---

### Task 2: #4693 part 2 — `assertSiteInOrg` returns the row, writers stamp, `site_deleted` resolution, `SITE_DELETED` generation refusal, web copy

**Files:**
- Modify: `apps/api/src/services/contractService.ts:67-72` (`assertSiteInOrg`), `:866-913` (`addContractLineToContract`), `:1206-1270` (`createContractWithLinesDetailed`), W03's `updateContractLine`, `:229-250` (`resolveLineQty`), `generateDueInvoice`, `summarizeActiveContractMrrByOrg`
- Modify: `apps/api/src/services/contractTypes.ts` (`ContractServiceErrorCode`, estimate `unresolved`)
- Modify: `apps/api/src/services/contractService.test.ts`
- Create: `apps/api/src/__tests__/integration/contractLineSiteDeleted.integration.test.ts`
- Modify: `apps/web/src/lib/api/contracts.ts` (`ContractLine.siteName`), `apps/web/src/components/contracts/ContractDetail.tsx`, `apps/web/src/components/contracts/DeviceCoverageNotice.tsx`
- Modify: `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`

**Interfaces:**

```ts
// contractService.ts
async function assertSiteInOrg(tx: DbExecutor, siteId: string, orgId: string): Promise<{ id: string; name: string }>;
// resolveLineQty: per_device | per_device_role branch, BEFORE counting —
//   line.siteId === null && line.siteName !== null  ⇒ { ...ZERO, live: true, unresolved: 'site_deleted' }
// contractTypes.ts
export type ContractServiceErrorCode = /* existing union */ | 'SITE_DELETED';
// ContractEstimate line: unresolved?: 'group_deleted' | 'site_deleted'
```

- [ ] **Step 1: Write the failing unit tests**

Append to `apps/api/src/services/contractService.test.ts` (the Drizzle-mock conventions of the surrounding file apply — queue the site row where the existing `assertSiteInOrg` test queues its `{ id }`):

```ts
// #4693: every writer stamps the site's name from the row assertSiteInOrg now
// RETURNS, with no extra query — the shape W02's assertGroupInOrg already has.
describe('contract line site stamp writers (#4693)', () => {
  it('addContractLineToContract writes site_name beside site_id', async () => {
    queueResult([{ id: CONTRACT_ID, orgId: 'org1', status: 'draft', currencyCode: 'USD' }]); // getOwnedContractOr404 + lock
    queueResult([{ id: SITE_A, name: 'Dallas' }]);                                            // assertSiteInOrg
    queueResult([{ id: 'line-1' }]);                                                          // insert … returning
    await addContractLineToContract(CONTRACT_ID, { lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: true, siteId: SITE_A }, ACTOR);
    expect(lastInsertValues()).toMatchObject({ siteId: SITE_A, siteName: 'Dallas' });
  });

  it('updateContractLine re-stamps on a new siteId and clears the stamp on siteId: null', async () => {
    // patch { siteId: SITE_B }
    expect(await patchLine({ siteId: SITE_B }, { siteId: SITE_A, siteName: 'Dallas' }, [{ id: SITE_B, name: 'HQ' }]))
      .toMatchObject({ siteId: SITE_B, siteName: 'HQ' });
    // patch { siteId: null } — deliberately org-wide, NOT "site deleted"
    expect(await patchLine({ siteId: null }, { siteId: SITE_A, siteName: 'Dallas' }, []))
      .toMatchObject({ siteId: null, siteName: null });
  });
});

// #4693: the resolver's whole job here is to REFUSE to count. Counting a line
// whose site is gone is the org-wide over-bill this stamp exists to make visible.
describe('resolveLineQty — deleted site (#4693)', () => {
  const snapshot = { devices: [{ id: 'd1', role: 'server', siteId: 'site-a' }, { id: 'd2', role: 'server', siteId: 'site-b' }], groups: new Map() };

  it.each(['per_device', 'per_device_role'] as const)('reports site_deleted for a %s line with a stamp and no id', (lineType) => {
    const r = resolveLineQty(snapshot as never, { lineType, siteId: null, siteName: 'Dallas', deviceRoles: lineType === 'per_device_role' ? ['server'] : null, deviceGroupId: null } as never);
    expect(r).toMatchObject({ quantity: 0, live: true, unresolved: 'site_deleted' });
  });

  // THE CONTROL. Without it this suite cannot tell a fix from a blanket refusal.
  it('still counts org-wide for a line that never had a site', () => {
    const r = resolveLineQty(snapshot as never, { lineType: 'per_device', siteId: null, siteName: null, deviceRoles: null, deviceGroupId: null } as never);
    expect(r).toMatchObject({ quantity: 2, unresolved: undefined });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts`
Expected: FAIL — `assertSiteInOrg` returns `void`, no writer sets `siteName`, and `resolveLineQty` counts the whole org for the deleted-site fixture (the bug, reproduced).

- [ ] **Step 3: Implement `assertSiteInOrg` and the writers**

Replace `assertSiteInOrg` (`contractService.ts:67-72`):

```ts
/** #4693: returns the site row so the caller can STAMP its name with no second
 *  query — the shape W02's assertGroupInOrg already has. The 400 SITE_NOT_IN_ORG
 *  behaviour is unchanged. */
async function assertSiteInOrg(tx: DbExecutor, siteId: string, orgId: string): Promise<{ id: string; name: string }> {
  const [row] = await tx.select({ id: sites.id, name: sites.name })
    .from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1);
  if (!row) throw new ContractServiceError('Site does not belong to this organization', 400, 'SITE_NOT_IN_ORG');
  return row;
}
```

In `addContractLineToContract` and `createContractWithLinesDetailed`, capture the return and stamp:

```ts
    const site = siteId ? await assertSiteInOrg(tx, siteId, c.orgId) : null;
```
…and in the insert values, beside `siteId: site?.id ?? null`, add `siteName: site?.name ?? null,`.

`createContractWithLinesDetailed` additionally honours an inherited stamp from the accepted quote (Task 9 supplies it):

```ts
      // #4693: acceptance passes the string the customer SIGNED. Prefer it over
      // a fresh read of a site that may have been renamed since the quote went
      // out; fall back to the live name for every other caller.
      siteName: site ? (l.siteName ?? site.name) : null,
```

In W03's `updateContractLine`, after the merged-row invariants pass and beside the `deviceGroupName` re-stamp:

```ts
    // #4693: re-stamp from the resolved site when the id changed; the merge has
    // already cleared the stamp when the patch set siteId to null.
    if (patchHasKey(patch, 'siteId')) {
      set.siteName = merged.siteId ? (await assertSiteInOrg(tx, merged.siteId, line.orgId)).name : null;
    }
```

- [ ] **Step 4: Implement the resolver, the estimate shape and the generation refusal**

`contractTypes.ts`: add `'SITE_DELETED'` to `ContractServiceErrorCode`, and widen the estimate line's `unresolved` to `'group_deleted' | 'site_deleted'`.

`resolveLineQty` (`contractService.ts:229-250`), first statement of the `per_device` / `per_device_role` branch:

```ts
      // #4693: site_id NULL with a stamped name means the site was DELETED.
      // Counting here would silently bill every device in the org — the exact
      // over-bill this stamp exists to make visible. Same shape as wave 2's
      // group_deleted, so estimate / list / MRR inherit their handling.
      // A line with NEITHER column set never had a site and correctly bills
      // org-wide; that distinction is the entire fix.
      if (line.siteId === null && line.siteName !== null) {
        return { ...ZERO, live: true, unresolved: 'site_deleted' };
      }
```

`generateDueInvoice`, in the same pre-write guard block that already refuses `GROUP_DELETED` (placed **before** `createManualInvoice`, so nothing is written):

```ts
      if ((l.lineType === 'per_device' || l.lineType === 'per_device_role') && l.siteId === null && l.siteName !== null) {
        throw new ContractServiceError(
          `contract line ${l.id} is scoped to site "${l.siteName}", which no longer exists`,
          409, 'SITE_DELETED', { contractLineId: l.id, siteName: l.siteName },
        );
      }
```

`summarizeActiveContractMrrByOrg`: extend the existing `unresolved` skip so `'site_deleted'` skips the contract with one `console.warn` naming the line — matching its `GROUP_EVALUATION_FAILED` handling. `listContracts` needs no change: it already renders `estimatedPeriodValue: null` for an unresolved line.

The worker's per-contract try/catch (`contractWorker.ts:93-98`) already rolls that contract back, logs, reports to Sentry and continues — a loud, recoverable stop instead of a silent org-wide invoice. No change; Step 7 asserts it.

- [ ] **Step 5: Run the unit tests**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts src/services/contractCoverage.test.ts src/jobs/contractWorker.test.ts`
Expected: PASS, including the untouched W01–W04 cases.

- [ ] **Step 6: Write the headline regression suite**

Create `apps/api/src/__tests__/integration/contractLineSiteDeleted.integration.test.ts`:

```ts
/**
 * #4693, the headline regression: deleting a site must not silently widen a
 * site-scoped contract line to the whole organization.
 *
 * Before this wave: DELETE /orgs/sites/:id nulls contract_lines.site_id (the
 * FK's ON DELETE SET NULL) and resolveLineQty then counts EVERY device in the
 * org, forever, with nothing to distinguish it from a line that never had a
 * site. The control case at the bottom is what proves the fix is a real
 * distinction and not a blanket refusal.
 *
 * devices.site_id is NOT NULL, so every seeded device names a site.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, contracts, contractLines, invoices, invoiceLines, contractBillingPeriods } from '../../db/schema';
import { computeContractEstimate, generateDueInvoice, listContracts, summarizeActiveContractMrrByOrg, ContractServiceError } from '../../services/contractService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed(opts: { scoped: boolean }) {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `SD ${sfx}`, slug: `sd-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'SDO', slug: `sdo-${sfx}` }).returning({ id: organizations.id });
    const [dallas] = await db.insert(sites).values({ orgId: o!.id, name: `Dallas ${sfx}` }).returning({ id: sites.id, name: sites.name });
    const [austin] = await db.insert(sites).values({ orgId: o!.id, name: `Austin ${sfx}` }).returning({ id: sites.id });
    // 2 devices at Dallas, 3 at Austin — 5 org-wide.
    const rows = [
      { siteId: dallas!.id, n: 2 }, { siteId: austin!.id, n: 3 },
    ].flatMap(({ siteId, n }) => Array.from({ length: n }, (_, i) => ({
      orgId: o!.id, siteId, agentId: `${siteId}-${i}-${sfx}`, hostname: `h${i}`, status: 'online' as const,
      osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '1', deviceRole: 'server' as const,
    })));
    await db.insert(devices).values(rows as never);
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: `C ${sfx}`, status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: new Date('2026-08-01T00:00:00Z'), currencyCode: 'USD',
    }).returning({ id: contracts.id, nextBillingAt: contracts.nextBillingAt });
    const [line] = await db.insert(contractLines).values({
      contractId: c!.id, orgId: o!.id, lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: false,
      ...(opts.scoped ? { siteId: dallas!.id, siteName: dallas!.name } : {}),
    } as never).returning({ id: contractLines.id });
    return { partnerId: p!.id, orgId: o!.id, dallas: dallas!, contract: c!, lineId: line!.id };
  });
}

describe('#4693 — a deleted site stops billing instead of widening it', () => {
  runDb('estimate counts only the scoped site before the delete', async () => {
    const f = await seed({ scoped: true });
    const est = await withSystemDbAccessContext(() => computeContractEstimate(f.contract.id, f.orgId));
    expect(est.lines[0]).toMatchObject({ quantity: 2 });
  });

  runDb('after the delete: id nulled, stamp kept, estimate unresolved, generation refuses, nothing written', async () => {
    const f = await seed({ scoped: true });
    await withSystemDbAccessContext(() => db.delete(sites).where(eq(sites.id, f.dallas.id)));

    // (a) the FK nulled the id and kept the stamp
    const [line] = await withSystemDbAccessContext(() =>
      db.select({ siteId: contractLines.siteId, siteName: contractLines.siteName })
        .from(contractLines).where(eq(contractLines.id, f.lineId)));
    expect(line).toEqual({ siteId: null, siteName: f.dallas.name });

    // (b) the estimate says so instead of counting five
    const est = await withSystemDbAccessContext(() => computeContractEstimate(f.contract.id, f.orgId));
    expect(est.lines[0]).toMatchObject({ quantity: 0, unresolved: 'site_deleted' });

    // (c) generation REFUSES and writes nothing — the assertion that the
    //     org-wide over-bill is gone.
    await expect(withSystemDbAccessContext(() => generateDueInvoice(f.contract.id)))
      .rejects.toMatchObject({ name: 'ContractServiceError', status: 409, code: 'SITE_DELETED' });
    const written = await withSystemDbAccessContext(async () => ({
      invoices: await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, f.orgId)),
      lines: await db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.orgId, f.orgId)),
      periods: await db.select({ id: contractBillingPeriods.id }).from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.contract.id)),
      contract: await db.select({ nextBillingAt: contracts.nextBillingAt }).from(contracts).where(eq(contracts.id, f.contract.id)),
    }));
    expect(written.invoices).toHaveLength(0);
    expect(written.lines).toHaveLength(0);
    expect(written.periods).toHaveLength(0);
    expect(written.contract[0]!.nextBillingAt).toEqual(f.contract.nextBillingAt);
  });

  runDb('the list degrades to null and the MRR rollup skips the contract with one warning', async () => {
    const f = await seed({ scoped: true });
    const neighbour = await seed({ scoped: false });
    await withSystemDbAccessContext(() => db.delete(sites).where(eq(sites.id, f.dallas.id)));
    const rows = await withSystemDbAccessContext(() => listContracts({ partnerId: f.partnerId }));
    expect(rows.find((r) => r.id === f.contract.id)!.estimatedPeriodValue).toBeNull();
    expect(rows.find((r) => r.id === neighbour.contract.id)!.estimatedPeriodValue).not.toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mrr = await withSystemDbAccessContext(() => summarizeActiveContractMrrByOrg([f.orgId]));
    expect(mrr.get(f.orgId) ?? 0).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  // THE CONTROL. Without it the suite cannot tell a fix from a blanket refusal:
  // a line that never had a site is SUPPOSED to bill every device in the org.
  runDb('a line that never had a site still bills org-wide — all five devices', async () => {
    const f = await seed({ scoped: false });
    const est = await withSystemDbAccessContext(() => computeContractEstimate(f.contract.id, f.orgId));
    expect(est.lines[0]).toMatchObject({ quantity: 5, unresolved: undefined });
    const inv = await withSystemDbAccessContext(() => generateDueInvoice(f.contract.id));
    expect(inv).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run the integration suite and the worker isolation case**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractLineSiteDeleted.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/contractDeviceGroups.integration.test.ts
```
Expected: PASS. Add one case to `src/jobs/contractWorker.test.ts` asserting a `SITE_DELETED` throw rolls that contract back, reports to Sentry and still generates the next contract (copy the `GROUP_DELETED` case verbatim, changing the code), and run `npx vitest run src/jobs/contractWorker.test.ts`.

- [ ] **Step 8: Web copy and the eight locales**

`apps/web/src/lib/api/contracts.ts`: `ContractLine` gains `siteName: string | null;` beside `siteId`.

`ContractDetail.tsx` — the estimate table's quantity cell already renders `t('contracts.shared.values.groupDeleted')` for `unresolved === 'group_deleted'` (W02); add the sibling branch:

```tsx
  {l.unresolved === 'site_deleted'
    ? t('contracts.shared.values.siteDeletedNamed', { name: l.siteName ?? '' })
    : l.unresolved === 'group_deleted'
      ? t('contracts.shared.values.groupDeleted')
      : formatQuantity(l.quantity)}
```

`DeviceCoverageNotice.tsx` — the same `site_deleted` cell/copy as the group-deleted one it already renders.

Locale keys in `billing.json` under `contracts.shared.values` (all eight files; `localeParity.test.ts` enforces it):

| key | en | de-DE | es-419 | fr-CA | fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|---|
| `siteDeleted` | site deleted | Standort gelöscht | sitio eliminado | site supprimé | site supprimé | sede eliminata | site excluído | konum silindi |
| `siteDeletedNamed` | site deleted: {{name}} | Standort gelöscht: {{name}} | sitio eliminado: {{name}} | site supprimé : {{name}} | site supprimé : {{name}} | sede eliminata: {{name}} | site excluído: {{name}} | konum silindi: {{name}} |

- [ ] **Step 9: Run web tests and commit**

Run: `cd apps/web && npx vitest run src/components/contracts src/lib/i18n && npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: PASS; tsc clean.

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts \
  apps/api/src/services/contractTypes.ts apps/api/src/jobs/contractWorker.test.ts \
  apps/api/src/__tests__/integration/contractLineSiteDeleted.integration.test.ts \
  apps/web/src/lib/api/contracts.ts apps/web/src/components/contracts apps/web/src/locales
git commit -m "fix(billing): a deleted site stops a contract line billing instead of widening it org-wide (#4693)"
```

---

### Task 3: Quote schema — nine columns, the CHECK, three deferrable FKs, `hash_version`, Drizzle, export policy, constraint truth table

**Files:**
- Create: `apps/api/migrations/2026-10-08-100100-quote-lines-device-set.sql`
- Modify: `apps/api/src/db/schema/quotes.ts:10` (import), `:52-99` (`quoteLines`), `:219-239` (`quoteAcceptances`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:299` (`quote_acceptances`), `:302` (`quote_lines`)
- Create: `apps/api/src/__tests__/integration/quoteLinesDeviceSetConstraints.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`

**Interfaces:**

```sql
quote_lines.contract_line_type contract_line_type      -- the CONTRACT enum, not a twin
quote_lines.device_roles text[]
quote_lines.device_group_id uuid          quote_lines.device_group_name varchar(255)
quote_lines.site_id uuid                  quote_lines.site_name varchar(255)
quote_lines.included_quantity numeric(12,2)
quote_lines.overage_mode contract_overage_mode
quote_lines.overage_unit_price numeric(12,2)
quote_lines_device_set_chk                              -- total, NULL-safe
quote_lines_quote_org_fk        (quote_id, org_id)      -> quotes (id, org_id)          ON DELETE CASCADE  DEFERRABLE INITIALLY IMMEDIATE
quote_lines_device_group_org_fk (device_group_id, org_id) -> device_groups (id, org_id) ON DELETE SET NULL (device_group_id) DEFERRABLE INITIALLY IMMEDIATE
quote_lines_site_org_fk         (site_id, org_id)       -> sites (id, org_id)           ON DELETE SET NULL (site_id)         DEFERRABLE INITIALLY IMMEDIATE
quote_lines_device_group_id_idx                         -- partial, WHERE device_group_id IS NOT NULL
quote_acceptances.hash_version smallint NOT NULL DEFAULT 1
```

- [ ] **Step 1: Write the failing constraint truth table**

Create `apps/api/src/__tests__/integration/quoteLinesDeviceSetConstraints.integration.test.ts`:

```ts
/**
 * Real-DB truth table for the #3205 W05 quote_lines device-set invariants, as
 * breeze_app (forced RLS, no bypass). Mirrors
 * contractLinesDeviceGroupConstraints / contractLinesAllowanceConstraints.
 *
 * A CHECK passes on TRUE *or NULL*, so every conjunct has to be proven to
 * REJECT rather than abstain — hence the single-non-NULL matrix over all nine
 * columns on a contract_line_type IS NULL line.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, deviceGroups, quotes, quoteBlocks, quoteLines } from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `QS ${sfx}`, slug: `qs-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'QA', slug: `qa-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'QB', slug: `qb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [siteA] = await db.insert(sites).values({ orgId: oA!.id, name: `Dallas ${sfx}` }).returning({ id: sites.id, name: sites.name });
    const [gA] = await db.insert(deviceGroups).values({ orgId: oA!.id, name: `VIP ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id, name: deviceGroups.name });
    const [qA] = await db.insert(quotes).values({ partnerId: p!.id, orgId: oA!.id, currencyCode: 'USD' }).returning({ id: quotes.id });
    const [blk] = await db.insert(quoteBlocks).values({ quoteId: qA!.id, orgId: oA!.id, blockType: 'line_items', content: {} }).returning({ id: quoteBlocks.id });
    return { partnerId: p!.id, orgA: oA!.id, orgB: oB!.id, site: siteA!, group: gA!, quoteId: qA!.id, blockId: blk!.id };
  });
}

/** Insert a quote line with the shared defaults; `cols` supplies the descriptor. */
async function line(f: Awaited<ReturnType<typeof seed>>, cols: Record<string, unknown>) {
  return withSystemDbAccessContext(() => db.insert(quoteLines).values({
    quoteId: f.quoteId, orgId: f.orgA, blockId: f.blockId, sourceType: 'manual',
    name: 'Endpoints', quantity: '3.00', unitPrice: '40.00', taxable: false,
    recurrence: 'monthly', ...cols,
  } as never).returning({ id: quoteLines.id }));
}

const CHK = /quote_lines_device_set_chk/;

describe('quote_lines_device_set_chk (#3205 W05)', () => {
  runDb('accepts each of the four device-set types on a recurring line', async () => {
    const f = await seed();
    expect(await line(f, { contractLineType: 'per_device' })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_device_role', deviceRoles: ['server'] })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_device_group', deviceGroupId: f.group.id, deviceGroupName: f.group.name })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_seat' })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_device', recurrence: 'annual' })).toHaveLength(1);
  });

  // A CHECK abstains on NULL. Each of the nine columns alone, on an ordinary
  // line, must therefore be shown to REJECT — otherwise the "all NULL together"
  // branch is decorative.
  runDb.each([
    ['contract_line_type is the discriminator, so a lone descriptor column is a forgery', { deviceRoles: ['server'] }],
    ['device_group_id', { deviceGroupId: null as unknown as string }],
    ['device_group_name', { deviceGroupName: 'VIP' }],
    ['site_id', { siteId: null as unknown as string }],
    ['site_name', { siteName: 'Dallas' }],
    ['included_quantity', { includedQuantity: '25' }],
    ['overage_mode', { overageMode: 'flag' }],
    ['overage_unit_price', { overageUnitPrice: '12.00' }],
  ] as const)('rejects %s on a line with contract_line_type NULL', async (_name, cols) => {
    const f = await seed();
    const nonNull = Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== null));
    if (Object.keys(nonNull).length === 0) return; // the two uuid rows are covered by the FK suite below
    await expect(line(f, nonNull)).rejects.toThrow(CHK);
  });

  runDb('rejects a descriptor on a one_time line and on a bundle child', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_device', recurrence: 'one_time' })).rejects.toThrow(CHK);
    const [parent] = await line(f, { sourceType: 'bundle' });
    await expect(line(f, { contractLineType: 'per_device', parentLineId: parent!.id })).rejects.toThrow(CHK);
  });

  runDb("rejects 'flat' and 'manual' — they have no device set", async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'flat' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'manual' })).rejects.toThrow(CHK);
  });

  runDb('roles are two-way, non-empty and closed; DUPLICATES are accepted by the DB', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_device_role' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', deviceRoles: ['server'] })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device_role', deviceRoles: [] })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device_role', deviceRoles: ['unknown'] })).rejects.toThrow(CHK);
    // `<@` is CONTAINMENT, not set equality: the validator is the ONLY duplicate
    // guard. Recorded here so nobody deletes the validator rule as redundant.
    expect(await line(f, { contractLineType: 'per_device_role', deviceRoles: ['server', 'server'] })).toHaveLength(1);
  });

  runDb('group lines require the stamp; the id is optional (the orphan state)', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_device_group', deviceGroupId: f.group.id })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', deviceGroupName: 'VIP' })).rejects.toThrow(CHK);
    expect(await line(f, { contractLineType: 'per_device_group', deviceGroupName: f.group.name })).toHaveLength(1);
  });

  runDb('site columns only on per_device / per_device_role, and an id always carries its stamp', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_seat', siteId: f.site.id, siteName: f.site.name })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device_group', deviceGroupName: f.group.name, siteName: 'Dallas' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', siteId: f.site.id })).rejects.toThrow(CHK);
    expect(await line(f, { contractLineType: 'per_device', siteId: f.site.id, siteName: f.site.name })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_device', siteName: f.site.name })).toHaveLength(1); // deleted-site state
  });

  runDb('the five allowance conjuncts, identical to contract_lines_allowance_chk', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '25' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', overageMode: 'flag' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '0', overageMode: 'flag' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '25.5', overageMode: 'flag' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '25', overageMode: 'bill' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '25', overageMode: 'flag', overageUnitPrice: '12.00' })).rejects.toThrow(CHK);
    expect(await line(f, { contractLineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00' })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_seat', includedQuantity: '25', overageMode: 'flag' })).toHaveLength(1);
  });
});

describe('quote_lines composite FKs (#3205 W05)', () => {
  runDb('all three report condeferrable = true (the org-merge contract)', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT conname, condeferrable FROM pg_constraint
       WHERE conrelid = 'quote_lines'::regclass
         AND conname IN ('quote_lines_quote_org_fk','quote_lines_device_group_org_fk','quote_lines_site_org_fk')
       ORDER BY conname`));
    expect(rows.map((r: Record<string, unknown>) => [r.conname, r.condeferrable]))
      .toEqual([['quote_lines_device_group_org_fk', true], ['quote_lines_quote_org_fk', true], ['quote_lines_site_org_fk', true]]);
  });

  runDb('a line whose org_id differs from its quote is rejected (23503)', async () => {
    const f = await seed();
    await expect(line(f, { orgId: f.orgB })).rejects.toMatchObject({ code: '23503' });
  });

  runDb('deleting a group nulls device_group_id and KEEPS device_group_name', async () => {
    const f = await seed();
    const [l] = await line(f, { contractLineType: 'per_device_group', deviceGroupId: f.group.id, deviceGroupName: f.group.name });
    await withSystemDbAccessContext(() => db.delete(deviceGroups).where(eq(deviceGroups.id, f.group.id)));
    const [after] = await withSystemDbAccessContext(() =>
      db.select({ deviceGroupId: quoteLines.deviceGroupId, deviceGroupName: quoteLines.deviceGroupName })
        .from(quoteLines).where(eq(quoteLines.id, l!.id)));
    expect(after).toEqual({ deviceGroupId: null, deviceGroupName: f.group.name });
  });

  runDb('deleting a site nulls site_id and KEEPS site_name', async () => {
    const f = await seed();
    const [l] = await line(f, { contractLineType: 'per_device', siteId: f.site.id, siteName: f.site.name });
    await withSystemDbAccessContext(() => db.delete(sites).where(eq(sites.id, f.site.id)));
    const [after] = await withSystemDbAccessContext(() =>
      db.select({ siteId: quoteLines.siteId, siteName: quoteLines.siteName })
        .from(quoteLines).where(eq(quoteLines.id, l!.id)));
    expect(after).toEqual({ siteId: null, siteName: f.site.name });
  });
});

describe('quote_acceptances.hash_version (#3205 W05)', () => {
  runDb('defaults to 1 — the truth for every acceptance recorded before this release', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'quote_acceptances' AND column_name = 'hash_version'`));
    expect(rows).toHaveLength(1);
    expect(String((rows[0] as Record<string, unknown>).column_default)).toContain('1');
    expect((rows[0] as Record<string, unknown>).is_nullable).toBe('NO');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteLinesDeviceSetConstraints.integration.test.ts
```
Expected: FAIL (`column "contract_line_type" of relation "quote_lines" does not exist`).

- [ ] **Step 3: Write the migration**

Re-run `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -3` (Task 1's file is now the ceiling). Create `apps/api/migrations/2026-10-08-100100-quote-lines-device-set.sql`:

```sql
-- #3205 wave 5 / #4654: device-set descriptors on recurring quote lines.
-- Spec: docs/superpowers/specs/billing/2026-09-03-device-set-quote-lines-design.md
--
-- No enum file is needed. contract_line_type gained per_device_group in wave 2's
-- 2026-10-06-100000 and contract_overage_mode was created by wave 4's
-- 2026-10-07-100000; both are committed before this file runs, and this file
-- only REFERENCES them. (The wave 1/2 two-file split exists only because
-- ALTER TYPE ... ADD VALUE cannot have its new value USED in the same
-- transaction.)

-- Deliberately the CONTRACT enums, not quote-local twins: one vocabulary means
-- quoteToContract maps 1:1 and a future line type cannot be spelled two ways.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS contract_line_type contract_line_type;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS device_roles text[];
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS device_group_id uuid;
-- Stamped at write. Survives group deletion (the FK nulls only the id) so an
-- accepted quote still says what it priced, the customer document needs no
-- join, and a NULL id beside a non-NULL stamp is the unambiguous
-- "the thing you priced was deleted" signal that blocks acceptance.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS device_group_name varchar(255);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS site_id uuid;
-- Same reasoning as device_group_name, and load-bearing for a second reason:
-- without it, site_id IS NULL cannot be told apart from "never had a site", and
-- acceptance would build an ORG-WIDE contract line from a site-scoped quote.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS site_name varchar(255);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS included_quantity numeric(12,2);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS overage_mode contract_overage_mode;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS overage_unit_price numeric(12,2);

-- The DB twin of quoteLineDeviceSetIssues. Every conjunct is NULL-SAFE: a CHECK
-- passes on TRUE *or NULL*, so each side of every `=` is a non-null boolean and
-- the CASE is total.
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_device_set_chk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_device_set_chk CHECK (
  CASE WHEN contract_line_type IS NULL THEN
    device_roles IS NULL AND device_group_id IS NULL AND device_group_name IS NULL
    AND site_id IS NULL AND site_name IS NULL
    AND included_quantity IS NULL AND overage_mode IS NULL AND overage_unit_price IS NULL
  ELSE
    -- Only the four auto-quantity types; 'flat' and 'manual' have no device set.
    contract_line_type IN ('per_device', 'per_device_role', 'per_device_group', 'per_seat')
    -- A one-time charge has no "each period" for a live count to mean anything,
    -- and a bundle child's quantity belongs to its parent.
    AND recurrence <> 'one_time'
    AND parent_line_id IS NULL
    -- Roles: two-way, non-empty, 1-D, no NULL element, closed vocabulary.
    -- Mirrors contract_lines_device_roles_chk (2026-10-05-100100).
    AND ((device_roles IS NOT NULL) = (contract_line_type = 'per_device_role'))
    AND (device_roles IS NULL OR (
          array_ndims(device_roles) = 1
      AND cardinality(device_roles) > 0
      AND array_position(device_roles, NULL) IS NULL
      AND device_roles <@ ARRAY['workstation','server','printer','router','switch',
                                'firewall','access_point','phone','iot','camera','nas']::text[]
    ))
    -- Group: the stamp is required on a group line and forbidden elsewhere; the
    -- id may be NULL on a group line only after the group was deleted (FK below).
    AND ((device_group_name IS NOT NULL) = (contract_line_type = 'per_device_group'))
    AND (device_group_id IS NULL OR contract_line_type = 'per_device_group')
    -- Site: only on per_device / per_device_role (a group is already a device
    -- set, and site-bound groups exist for the site case — wave 2 decision 6).
    -- A stamped id always carries a stamped name; a name may outlive its id.
    AND (site_id IS NULL OR contract_line_type IN ('per_device', 'per_device_role'))
    AND (site_name IS NULL OR contract_line_type IN ('per_device', 'per_device_role'))
    AND (site_id IS NULL OR site_name IS NOT NULL)
    -- Allowance: the same five conjuncts as contract_lines_allowance_chk.
    AND ((included_quantity IS NULL) = (overage_mode IS NULL))
    AND (included_quantity IS NULL OR included_quantity > 0)
    AND (included_quantity IS NULL OR included_quantity = floor(included_quantity))
    AND ((overage_unit_price IS NOT NULL) = (overage_mode IS NOT DISTINCT FROM 'bill'))
    AND (overage_unit_price IS NULL OR overage_unit_price >= 0)
  END
);

-- Ownership chain. quote_lines has only single-column FKs today, so nothing
-- proves a line's org_id is its quote's org_id. Preflight first: a mismatch is
-- a tenancy fault with no safe automatic fix.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
    WHERE q.org_id <> ql.org_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'quote_lines: % row(s) carry an org_id that differs from their quote; repair by hand before applying this migration', n;
  END IF;
END $$;

-- DEFERRABLE is load-bearing, not ceremony: updateQuote's org retarget updates
-- quotes.org_id and quote_lines.org_id in SEPARATE statements, and org merge
-- repoints them separately too. The sibling quote_recipients / quote_orders FKs
-- are non-deferrable only because those tables are empty on a draft.
-- The retarget defers THIS constraint BY NAME (SET CONSTRAINTS
-- quote_lines_quote_org_fk DEFERRED), never ALL, so every other deferrable FK
-- in that transaction still fails at the statement that caused it.
-- The target index quotes_id_org_uq already exists (db/schema/quotes.ts:134).
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_quote_org_fk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_quote_org_fk
  FOREIGN KEY (quote_id, org_id) REFERENCES quotes (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

-- SET NULL on the id only: the stamp survives so an accepted quote still says
-- what it priced. deleteDeviceGroup refuses while a draft/sent/viewed quote
-- names the group, so this fires only for terminal quotes and the delete race.
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_device_group_org_fk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_device_group_org_fk
  FOREIGN KEY (device_group_id, org_id) REFERENCES device_groups (id, org_id)
  ON DELETE SET NULL (device_group_id) DEFERRABLE INITIALLY IMMEDIATE;

-- Same shape as wave 1's contract_lines_site_org_fk, against the pre-existing
-- sites_id_org_id_uniq index (db/schema/orgs.ts:219).
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_site_org_fk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_site_org_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
  ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS quote_lines_device_group_id_idx
  ON quote_lines (device_group_id) WHERE device_group_id IS NOT NULL;

-- The acceptance hash is VERSIONED, not migrated. Every existing row is 1 by
-- the default, which is the TRUTH — those acceptances were hashed by the v1
-- algorithm — so no signature already given legal weight is re-hashed or
-- invalidated. acceptQuote writes 2; quoteAcceptanceVerify reads this column
-- and never infers a format from the data it is verifying.
ALTER TABLE quote_acceptances ADD COLUMN IF NOT EXISTS hash_version smallint NOT NULL DEFAULT 1;
```

- [ ] **Step 4: Drizzle mirror**

`apps/api/src/db/schema/quotes.ts` — extend the existing cross-schema import convention (`catalogItemTypeEnum` at `:10`):

```ts
import { contractLineTypeEnum, contractOverageModeEnum } from './contracts';
```

In `quoteLines`, immediately after `billingFrequency` (`:72`):

```ts
  // #3205 W05: device-set descriptor. All NULL together on an ordinary line —
  // contract_line_type IS NULL is the whole feature switch. The invariants live
  // in quote_lines_device_set_chk (SQL-only, like contract_lines_device_roles_chk)
  // and in quoteLineDeviceSetIssues.
  contractLineType: contractLineTypeEnum('contract_line_type'),
  deviceRoles: text('device_roles').array(),
  deviceGroupId: uuid('device_group_id'),
  // Stamped at write; outlives the id (the FK is ON DELETE SET NULL on the id
  // only), which is how a deleted reference is detected.
  deviceGroupName: varchar('device_group_name', { length: 255 }),
  siteId: uuid('site_id'),
  siteName: varchar('site_name', { length: 255 }),
  includedQuantity: numeric('included_quantity', { precision: 12, scale: 2 }),
  overageMode: contractOverageModeEnum('overage_mode'),
  overageUnitPrice: numeric('overage_unit_price', { precision: 12, scale: 2 }),
```

In the `quoteLines` extra config (`:93-99`), after `quote_lines_id_quote_uq`:

```ts
  index('quote_lines_device_group_id_idx').on(t.deviceGroupId).where(sql`${t.deviceGroupId} IS NOT NULL`),
  // The CHECK and all three composite FKs are SQL-only (2026-10-08-100100) —
  // the W01/W02 pattern. Drizzle cannot express ON DELETE SET NULL (col) or
  // DEFERRABLE, and drift detection compares columns/indexes, not constraints.
```

In `quoteAcceptances` (`:228`), after `quoteSha256`:

```ts
  // #3205 W05: which computeQuoteSha256 algorithm produced quoteSha256.
  // Existing rows default to 1 because that is what hashed them.
  hashVersion: integer('hash_version').notNull().default(1),
```

Run: `cd apps/api && pnpm db:migrate && pnpm db:check-drift`
Expected: the migration applies; drift check clean.

- [ ] **Step 5: Export policy**

`tenantExportPolicyRegistry.ts:302` — append to `quote_lines`' `included`, after `"sort_order"`:
`"contract_line_type","device_roles","device_group_id","device_group_name","site_id","site_name","included_quantity","overage_mode","overage_unit_price"`

`:299` — append `"hash_version"` to `quote_acceptances`' `included`.

`device_roles` is a `text[]` with a closed, CHECK-constrained vocabulary — `included`, exactly like `contract_lines.device_roles` (`:148`). The `excludedOpen` rule enumerates `json`/`jsonb`/`bytea`; a closed enum array is ordinary customer data. Nothing else in any registration list changes (Global Constraints).

- [ ] **Step 6: Extend the export/erasure round-trip**

In `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`, extend the quote seed with a `per_device_group` descriptor line (group + site + a `bill` allowance) and assert `quote_lines.json` carries `contract_line_type`, `device_roles`, `device_group_id`, `device_group_name`, `site_id`, `site_name`, `included_quantity`, `overage_mode` and `overage_unit_price`, then that erasure removes the line, the quote and the group.

- [ ] **Step 7: Run everything schema-shaped**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/quoteLinesDeviceSetConstraints.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: all PASS. `tenant-export-policy` fails loudly if any of the eleven new columns is unclassified — that is the guard, not a formality.

- [ ] **Step 8: Manual CHECK probe as `breeze_app`, then commit**

```bash
docker exec -it breeze-postgres-test psql -U breeze_app -d breeze_test -c \
  "INSERT INTO quote_lines (quote_id, org_id, source_type, quantity, unit_price, taxable, recurrence, contract_line_type) \
   SELECT id, org_id, 'manual', 1, 1, false, 'one_time', 'per_device' FROM quotes LIMIT 1;"
```
Expected: `new row for relation "quote_lines" violates check constraint "quote_lines_device_set_chk"`. Repeat with `contract_line_type = 'flat'` and with a `per_device` line carrying a `site_id` and no `site_name` — all three must fail on the same constraint.

```bash
git add apps/api/migrations/2026-10-08-100100-quote-lines-device-set.sql \
  apps/api/src/db/schema/quotes.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/__tests__/integration/quoteLinesDeviceSetConstraints.integration.test.ts \
  apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
git commit -m "feat(billing): quote_lines device-set columns, CHECK, deferrable composite FKs and quote_acceptances.hash_version (#3205 W05)"
```

---

### Task 4: Shared validators — `quoteLineDeviceSetIssues` by delegation, the server-derived quantity rule, a strict patch schema

**Files:**
- Modify: `packages/shared/src/validators/quotes.ts:1-3` (imports), `:92-116` (`quoteLineInputSchema`), `:121-141` (`updateQuoteLineSchema`)
- Modify: `packages/shared/src/validators/quotes.test.ts` (import line 2, append at the end)

**Interfaces:**

```ts
export const QUOTE_DEVICE_SET_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
export type QuoteDeviceSetType = typeof QUOTE_DEVICE_SET_TYPES[number];

export interface QuoteLineDeviceSetShape {
  contractLineType?: QuoteDeviceSetType | null;
  recurrence: 'one_time' | 'monthly' | 'annual';
  parentLineId?: string | null;
  deviceRoles?: readonly string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  includedQuantity?: number | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: number | null;
}
export function quoteLineDeviceSetIssues(
  l: QuoteLineDeviceSetShape, opts: { mode: 'create' | 'persisted' },
): Array<{ path: string; message: string }>;

export interface PersistedQuoteLine { /* the read-layer row shape, below */ }
export type UpdateQuoteLineInput = z.infer<typeof updateQuoteLineSchema>;   // .strict()
export function quoteLinePatchHasKey(patch: UpdateQuoteLineInput, key: keyof UpdateQuoteLineInput): boolean;
export function mergeQuoteLinePatch(current: PersistedQuoteLine, patch: UpdateQuoteLineInput): PersistedQuoteLine;
```

**Note — the shape carries NO `quantity` field.** "The client may not set the quantity" is not a property of a row (every stored device-set line has a perfectly valid quantity, so a shape-level rule would reject the whole table in `persisted` mode). It is a rule about *who may write the field*, and it lives in exactly two stateful places: the create schema's `superRefine`, and `updateLine` in the service (Task 6).

- [ ] **Step 1: Write the failing tests**

Extend the import at the top of `packages/shared/src/validators/quotes.test.ts` with `quoteLineDeviceSetIssues, mergeQuoteLinePatch, quoteLinePatchHasKey, QUOTE_DEVICE_SET_TYPES` and add `import { ALLOWANCE_LINE_TYPES, contractLineInvariantIssues } from './contracts';`. Append:

```ts
// ---------------------------------------------------------------------------
// #3205 W05 — the device-set descriptor on a quote line.
//
// quoteLineDeviceSetIssues does NOT restate the contract rules: it PROJECTS onto
// W03's ContractLineShape and calls contractLineInvariantIssues, so roles /
// group / site / allowance can never diverge between a quote line and the
// contract line it becomes — and #4547's future additions arrive here for free.
// ---------------------------------------------------------------------------
describe('quoteLineDeviceSetIssues (#3205 W05)', () => {
  const GROUP = '33333333-3333-4333-8333-333333333333';
  const SITE = '22222222-2222-4222-8222-222222222222';
  const rec = { recurrence: 'monthly' } as const;
  const paths = (l: Parameters<typeof quoteLineDeviceSetIssues>[0], mode: 'create' | 'persisted') =>
    quoteLineDeviceSetIssues(l, { mode }).map((i) => i.path);

  it('accepts each of the four types with its required fields, in both modes', () => {
    for (const mode of ['create', 'persisted'] as const) {
      expect(paths({ ...rec, contractLineType: 'per_device' }, mode)).toEqual([]);
      expect(paths({ ...rec, contractLineType: 'per_device_role', deviceRoles: ['server'] }, mode)).toEqual([]);
      expect(paths({ ...rec, contractLineType: 'per_seat' }, mode)).toEqual([]);
    }
    expect(paths({ ...rec, contractLineType: 'per_device_group', deviceGroupId: GROUP }, 'create')).toEqual([]);
    expect(paths({ ...rec, contractLineType: 'per_device_group', deviceGroupId: GROUP, deviceGroupName: 'VIP' }, 'persisted')).toEqual([]);
  });

  it('accepts a line with no descriptor at all', () => {
    expect(paths({ recurrence: 'one_time' }, 'create')).toEqual([]);
    expect(paths({ recurrence: 'one_time' }, 'persisted')).toEqual([]);
  });

  it('requires contractLineType when any descriptor column is present', () => {
    expect(paths({ ...rec, deviceRoles: ['server'] }, 'create')).toContain('contractLineType');
    expect(paths({ ...rec, siteName: 'Dallas' }, 'create')).toContain('contractLineType');
    expect(paths({ ...rec, includedQuantity: 25, overageMode: 'flag' }, 'create')).toContain('contractLineType');
  });

  it('rejects a type outside the device-set four', () => {
    for (const t of ['flat', 'manual'] as const) {
      expect(paths({ ...rec, contractLineType: t as never }, 'create')).toContain('contractLineType');
    }
  });

  // A one-time charge has no "each period" for a live count to mean anything;
  // a bundle child's quantity belongs to its parent.
  it('rejects a descriptor on a one_time line and on a bundle component', () => {
    expect(paths({ recurrence: 'one_time', contractLineType: 'per_device' }, 'create')).toContain('recurrence');
    expect(paths({ recurrence: 'one_time', contractLineType: 'per_device' }, 'persisted')).toContain('recurrence');
    expect(paths({ ...rec, contractLineType: 'per_device', parentLineId: 'abc' }, 'create')).toContain('parentLineId');
  });

  // The mode asymmetry, inherited from W03 for the same reason: the orphan state
  // is legal on a stored row and illegal on a new one.
  it('requires deviceGroupId in create and allows the orphan in persisted', () => {
    expect(paths({ ...rec, contractLineType: 'per_device_group' }, 'create')).toContain('deviceGroupId');
    expect(paths({ ...rec, contractLineType: 'per_device_group', deviceGroupName: 'VIP' }, 'persisted')).toEqual([]);
    expect(paths({ ...rec, contractLineType: 'per_device_group', deviceGroupId: GROUP }, 'persisted')).toContain('deviceGroupName');
  });

  it('restricts the site columns to per_device / per_device_role and pairs id with stamp', () => {
    expect(paths({ ...rec, contractLineType: 'per_seat', siteId: SITE, siteName: 'Dallas' }, 'create')).toContain('siteId');
    expect(paths({ ...rec, contractLineType: 'per_device', siteId: SITE }, 'create')).toContain('siteName');
    expect(paths({ ...rec, contractLineType: 'per_device', siteId: SITE, siteName: 'Dallas' }, 'create')).toEqual([]);
    // deleted-site state: stamp with no id, legal on a stored row
    expect(paths({ ...rec, contractLineType: 'per_device', siteName: 'Dallas' }, 'persisted')).toEqual([]);
  });

  it('two-way, non-empty, duplicate-free deviceRoles (the DB only checks containment)', () => {
    expect(paths({ ...rec, contractLineType: 'per_device_role' }, 'create')).toContain('deviceRoles');
    expect(paths({ ...rec, contractLineType: 'per_device', deviceRoles: ['server'] }, 'create')).toContain('deviceRoles');
    expect(paths({ ...rec, contractLineType: 'per_device_role', deviceRoles: [] }, 'create')).toContain('deviceRoles');
    expect(paths({ ...rec, contractLineType: 'per_device_role', deviceRoles: ['server', 'server'] }, 'create')).toContain('deviceRoles');
  });

  // THE DELEGATION PROOF. A fixture that fails contractLineInvariantIssues must
  // fail here with the SAME message, so a future contract-side rule is inherited
  // automatically rather than silently skipped on the quote side.
  it('inherits every W04 allowance rule verbatim, by message', () => {
    const cases: Array<[Partial<Parameters<typeof quoteLineDeviceSetIssues>[0]>, Record<string, unknown>]> = [
      [{ includedQuantity: 25 }, { includedQuantity: '25.00' }],
      [{ overageMode: 'flag' }, { overageMode: 'flag' }],
      [{ includedQuantity: 0, overageMode: 'flag' }, { includedQuantity: '0.00', overageMode: 'flag' }],
      [{ includedQuantity: 25.5, overageMode: 'flag' }, { includedQuantity: '25.50', overageMode: 'flag' }],
      [{ includedQuantity: 25, overageMode: 'bill' }, { includedQuantity: '25.00', overageMode: 'bill' }],
      [{ includedQuantity: 25, overageMode: 'flag', overageUnitPrice: 12 }, { includedQuantity: '25.00', overageMode: 'flag', overageUnitPrice: '12.00' }],
    ];
    for (const [quoteFields, contractFields] of cases) {
      const mine = quoteLineDeviceSetIssues({ ...rec, contractLineType: 'per_device', ...quoteFields } as never, { mode: 'create' });
      const theirs = contractLineInvariantIssues({ lineType: 'per_device', ...contractFields } as never, { mode: 'create' });
      expect(theirs.length).toBeGreaterThan(0);
      expect(mine.map((i) => i.message)).toEqual(expect.arrayContaining(theirs.map((i) => i.message)));
    }
  });

  // The divergence tripwire. These are equal TODAY; a future wave that widens
  // one without the other must fail here rather than silently accept a quote
  // line acceptance cannot map.
  it('QUOTE_DEVICE_SET_TYPES equals ALLOWANCE_LINE_TYPES', () => {
    expect([...QUOTE_DEVICE_SET_TYPES]).toEqual([...ALLOWANCE_LINE_TYPES]);
  });
});

describe('quoteLineInputSchema — device set and the server-derived quantity (#3205 W05)', () => {
  const GROUP = '33333333-3333-4333-8333-333333333333';
  const base = { sourceType: 'manual' as const, name: 'Servers', unitPrice: 40, taxable: true, recurrence: 'monthly' as const };
  const parse = (v: unknown) => quoteLineInputSchema.safeParse(v);

  // Decision 5, the whole reason the rule is stateful rather than a row invariant.
  it('requires quantity WITHOUT a descriptor and rejects it WITH one', () => {
    expect(parse({ ...base, quantity: 3 }).success).toBe(true);
    expect(parse({ ...base }).success).toBe(false);
    expect(parse({ ...base, contractLineType: 'per_device' }).success).toBe(true);
    const withBoth = parse({ ...base, contractLineType: 'per_device', quantity: 3 });
    expect(withBoth.success).toBe(false);
    expect(withBoth.error!.issues.map((i) => i.path.join('.'))).toContain('quantity');
  });

  it('accepts each type with its fields and an allowance', () => {
    expect(parse({ ...base, contractLineType: 'per_device_role', deviceRoles: ['server'] }).success).toBe(true);
    expect(parse({ ...base, contractLineType: 'per_device_group', deviceGroupId: GROUP }).success).toBe(true);
    expect(parse({ ...base, contractLineType: 'per_seat', includedQuantity: 25, overageMode: 'bill', overageUnitPrice: 12 }).success).toBe(true);
  });

  it('rejects a one_time descriptor, an unknown role, and a bad group id', () => {
    expect(parse({ ...base, recurrence: 'one_time', contractLineType: 'per_device' }).success).toBe(false);
    expect(parse({ ...base, contractLineType: 'per_device_role', deviceRoles: ['unknown'] }).success).toBe(false);
    expect(parse({ ...base, contractLineType: 'per_device_group', deviceGroupId: 'nope' }).success).toBe(false);
  });

  // The server stamps the names; a client that sends one is confused about who
  // owns the value, and silently ignoring it would let a forged document name
  // a group the line does not reference.
  it('does not accept deviceGroupName or siteName as input', () => {
    const r = parse({ ...base, contractLineType: 'per_device_group', deviceGroupId: GROUP, deviceGroupName: 'Forged' });
    expect(r.success && (r.data as Record<string, unknown>).deviceGroupName).toBeUndefined();
  });
});

describe('updateQuoteLineSchema is .strict() (#3205 W05)', () => {
  const parse = (v: unknown) => updateQuoteLineSchema.safeParse(v);

  // Decision 20's anchor. A NON-strict schema ACCEPTS this and silently drops
  // it: 200 OK, nothing changed, and the operator believes the line is now
  // per_seat. contractLineType is not patchable at all — remove and re-add.
  it('rejects contractLineType with the exact unrecognized-key message', () => {
    const r = parse({ contractLineType: 'per_seat' });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toContain('Unrecognized key: "contractLineType"');
  });

  it('rejects a mis-keyed field', () => {
    expect(parse({ deviceGroupID: '33333333-3333-4333-8333-333333333333' }).success).toBe(false);
  });

  // W03's nullability rule, applied unchanged: clearing deviceRoles or
  // deviceGroupId leaves a row the CHECK rejects; clearing the others does not.
  it('accepts null for siteId and the three allowance fields, not for roles or group', () => {
    expect(parse({ siteId: null }).success).toBe(true);
    expect(parse({ includedQuantity: null, overageMode: null, overageUnitPrice: null }).success).toBe(true);
    expect(parse({ deviceRoles: null }).success).toBe(false);
    expect(parse({ deviceGroupId: null }).success).toBe(false);
    expect(parse({ deviceRoles: ['server'] }).success).toBe(true);
  });

  it('preserves key ABSENCE so an omitted field is unchanged', () => {
    const out = parse({ siteId: null });
    expect(Object.prototype.hasOwnProperty.call(out.data!, 'includedQuantity')).toBe(false);
    expect(quoteLinePatchHasKey(out.data!, 'siteId')).toBe(true);
  });

  // THE STANDING GUARD. Every key of the web editor's LineUpdate type must still
  // parse, or the editor 400s on a field it has always sent. Adding a field to
  // LineUpdate without declaring it here now fails HERE instead of in production.
  it.each([
    ['name', { name: 'x' }], ['description', { description: 'x' }], ['quantity', { quantity: 2 }],
    ['unitPrice', { unitPrice: 10 }], ['taxable', { taxable: true }], ['recurrence', { recurrence: 'monthly' }],
    ['unitCost', { unitCost: 5 }], ['sku', { sku: 'S' }], ['partNumber', { partNumber: 'P' }],
    ['imageId', { imageId: '11111111-1111-4111-8111-111111111111' }], ['depositEligible', { depositEligible: true }],
  ])('still accepts LineUpdate key %s', (_k, body) => {
    expect(parse(body).success).toBe(true);
  });
});

describe('mergeQuoteLinePatch (#3205 W05)', () => {
  const current = {
    contractLineType: 'per_device_group', recurrence: 'monthly', parentLineId: null,
    deviceRoles: null, deviceGroupId: '33333333-3333-4333-8333-333333333333', deviceGroupName: 'VIP',
    siteId: null, siteName: null, includedQuantity: 25, overageMode: 'bill', overageUnitPrice: 12,
  } as never;

  it('leaves an omitted key unchanged', () => {
    expect(mergeQuoteLinePatch(current, {} as never)).toMatchObject({ includedQuantity: 25, overageMode: 'bill', deviceGroupName: 'VIP' });
  });

  it('clears a nullable key and keeps the merged row valid', () => {
    const merged = mergeQuoteLinePatch(current, { includedQuantity: null, overageMode: null, overageUnitPrice: null } as never);
    expect(merged).toMatchObject({ includedQuantity: null, overageMode: null, overageUnitPrice: null });
    expect(quoteLineDeviceSetIssues(merged, { mode: 'persisted' })).toEqual([]);
  });

  it('clearing only includedQuantity leaves a row the persisted rules reject', () => {
    const merged = mergeQuoteLinePatch(current, { includedQuantity: null } as never);
    expect(quoteLineDeviceSetIssues(merged, { mode: 'persisted' }).map((i) => i.path)).toContain('overageMode');
  });

  it('patching recurrence to one_time on a descriptor line is caught by the merged row, not the DB', () => {
    const merged = mergeQuoteLinePatch(current, { recurrence: 'one_time' } as never);
    expect(quoteLineDeviceSetIssues(merged, { mode: 'persisted' }).map((i) => i.path)).toContain('recurrence');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/quotes.test.ts`
Expected: FAIL — `quoteLineDeviceSetIssues` does not exist; `quoteLineInputSchema` strips the descriptor and still demands `quantity`; `updateQuoteLineSchema` accepts `contractLineType` and returns success.

- [ ] **Step 3: Implement the validators**

At the top of `packages/shared/src/validators/quotes.ts`:

```ts
import {
  contractLineInvariantIssues, ALLOWANCE_LINE_TYPES, OVERAGE_MODES,
  type ContractLineShape,
} from './contracts';
import { BILLABLE_DEVICE_ROLES } from './deviceRoles';
```

After `quoteLineRecurrenceSchema` (`:18`):

```ts
/** The four contract line types a quote line may name. Deliberately the CONTRACT
 *  enum's values, so acceptance maps 1:1 with no translation table. Equal to
 *  W04's ALLOWANCE_LINE_TYPES today; asserted equal by a test so a divergence is
 *  caught rather than silently accepted (#3205 W05). */
export const QUOTE_DEVICE_SET_TYPES =
  ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
export type QuoteDeviceSetType = typeof QUOTE_DEVICE_SET_TYPES[number];
const QUOTE_DEVICE_SET_TYPE_SET: ReadonlySet<string> = new Set(QUOTE_DEVICE_SET_TYPES);
const SITE_SCOPABLE_QUOTE_TYPES: ReadonlySet<string> = new Set(['per_device', 'per_device_role']);

const present = (v: unknown): boolean => v !== undefined && v !== null;
/** Quote money/quantities are NUMBERS; contract ones are 2dp STRINGS. The same
 *  conversion addManualLine already does at the service boundary. */
const str = (n: number | null | undefined): string | null | undefined =>
  n == null ? n : n.toFixed(2);

/** The descriptor as it appears on a quote line, in the QUOTE's conventions.
 *  Deliberately carries NO `quantity`: "the client may not set it" is a rule
 *  about who may WRITE the field, not a property of a row, and a stored line's
 *  quantity is always valid (spec decision 5). */
export interface QuoteLineDeviceSetShape {
  contractLineType?: QuoteDeviceSetType | null;
  recurrence: 'one_time' | 'monthly' | 'annual';
  parentLineId?: string | null;
  deviceRoles?: readonly string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  includedQuantity?: number | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: number | null;
}

/**
 * The quote-line descriptor rules (#3205 W05). Does NOT restate
 * contractLineInputSchema's refines — it PROJECTS onto W03's ContractLineShape
 * and calls contractLineInvariantIssues, so roles / group / site / allowance can
 * never diverge between a quote line and the contract line it becomes (and
 * #4547's future additions arrive here for free).
 *
 * 'create'    — a new line: deviceGroupId required on a group line.
 * 'persisted' — a stored or merged row: deviceGroupId may be null (the orphan
 *               state the FK produces), the stamps are required.
 */
export function quoteLineDeviceSetIssues(
  l: QuoteLineDeviceSetShape, opts: { mode: 'create' | 'persisted' },
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const anyDescriptorColumn =
    present(l.deviceRoles) || present(l.deviceGroupId) || present(l.deviceGroupName)
    || present(l.siteId) || present(l.siteName)
    || present(l.includedQuantity) || present(l.overageMode) || present(l.overageUnitPrice);

  if (!present(l.contractLineType)) {
    if (anyDescriptorColumn) {
      issues.push({ path: 'contractLineType', message: 'a device set needs a contractLineType' });
    }
    return issues;   // an ordinary quote line: nothing else applies.
  }
  if (!QUOTE_DEVICE_SET_TYPE_SET.has(l.contractLineType!)) {
    issues.push({ path: 'contractLineType', message: 'contractLineType must be one of per_device, per_device_role, per_device_group, per_seat' });
    return issues;   // the projection below would be meaningless.
  }
  if (l.recurrence === 'one_time') {
    issues.push({ path: 'recurrence', message: 'a device set is only valid on a monthly or annual line — a one-time charge has no billing period to count in' });
  }
  if (present(l.parentLineId)) {
    issues.push({ path: 'parentLineId', message: 'a bundle component cannot carry its own device set' });
  }
  // #4693's stamp rule, needed in BOTH modes here: unlike a contract line, a
  // quote line's site name is what the customer document renders, and a NULL id
  // beside a stamp is what blocks acceptance.
  if (present(l.siteId) && !present(l.siteName)) {
    issues.push({ path: 'siteName', message: 'siteName must be stamped alongside siteId' });
  }
  if (present(l.siteName) && !SITE_SCOPABLE_QUOTE_TYPES.has(l.contractLineType!)) {
    issues.push({ path: 'siteName', message: 'siteName is only valid on per_device and per_device_role lines' });
  }

  // Delegate the rest. `path` is re-mapped lineType → contractLineType so the
  // caller's error points at the field the quote API actually exposes.
  const projected: ContractLineShape = {
    lineType: l.contractLineType as ContractLineShape['lineType'],
    manualQuantity: undefined,
    siteId: l.siteId,
    siteName: l.siteName,
    deviceRoles: l.deviceRoles,
    deviceGroupId: l.deviceGroupId,
    deviceGroupName: l.deviceGroupName,
    includedQuantity: str(l.includedQuantity),
    overageMode: l.overageMode,
    overageUnitPrice: str(l.overageUnitPrice),
  };
  for (const issue of contractLineInvariantIssues(projected, opts)) {
    if (issue.path === 'siteName') continue;   // already reported above, in both modes
    issues.push({ path: issue.path === 'lineType' ? 'contractLineType' : issue.path, message: issue.message });
  }
  return issues;
}
```

`quoteLineInputSchema` (`:92-116`) — change `quantity` and add seven fields, then a `superRefine`:

```ts
  // Client may not set the quantity of a device-set line: the server derives it
  // from the same snapshot helpers that will bill it (decision 5). Required on
  // every other line exactly as today — enforced in the superRefine below,
  // which is the only place that can see whether a descriptor was submitted.
  quantity: positiveQty.optional(),
  // (unitPrice, taxable, customerVisible, recurrence, termMonths,
  //  billingFrequency, unitCost, sku, partNumber, procurementSource, vendorSku,
  //  manufacturer, depositEligible are unchanged, in their existing order)
  // #3205 W05: the device-set descriptor. deviceGroupName / siteName are NOT
  // input fields — the server resolves and stamps them.
  contractLineType: z.enum(QUOTE_DEVICE_SET_TYPES).optional(),
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  deviceGroupId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  includedQuantity: z.number().int().positive().max(9_999_999_999).optional(),
  overageMode: z.enum(OVERAGE_MODES).optional(),
  overageUnitPrice: money.optional(),
}).refine((d) => Boolean(d.name?.trim() || d.description?.trim()), {
  message: 'A line needs a name or a description', path: ['name'],
}).superRefine((l, ctx) => {
  for (const issue of quoteLineDeviceSetIssues(l as never, { mode: 'create' })) {
    ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  }
  if (l.contractLineType === undefined && l.quantity === undefined) {
    ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'quantity is required' });
  }
  if (l.contractLineType !== undefined && l.quantity !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'quantity is derived from the live device count on a device-set line — omit it' });
  }
});
```

`updateQuoteLineSchema` (`:121-141`) — add six fields, **no `contractLineType`**, and `.strict()`:

```ts
  // #3205 W05. deviceRoles / deviceGroupId are .optional() only: clearing either
  // leaves a row quote_lines_device_set_chk rejects. The other four are
  // .nullable().optional() because clearing each leaves a valid shape — W03's
  // own rule, applied unchanged.
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  deviceGroupId: z.string().guid().optional(),
  siteId: z.string().guid().nullable().optional(),
  includedQuantity: z.number().int().positive().max(9_999_999_999).nullable().optional(),
  overageMode: z.enum(OVERAGE_MODES).nullable().optional(),
  overageUnitPrice: money.nullable().optional(),
  // NO contractLineType: adding or removing a descriptor changes what the line
  // IS (W03's reasoning for lineType). Remove the line and add it again.
}).strict();
```

Then append the merge helpers:

```ts
/** A quote_lines row in read-layer shape (null = not applicable). */
export interface PersistedQuoteLine extends QuoteLineDeviceSetShape {
  contractLineType: QuoteDeviceSetType | null;
  parentLineId: string | null;
  deviceRoles: readonly string[] | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  siteId: string | null;
  siteName: string | null;
  includedQuantity: number | null;
  overageMode: 'bill' | 'flag' | null;
  overageUnitPrice: number | null;
}
export type UpdateQuoteLineInput = z.infer<typeof updateQuoteLineSchema>;

/** Key-presence test for a tri-state patch field: `=== undefined` cannot tell
 *  "leave it alone" from "clear it"; key presence can. */
export function quoteLinePatchHasKey(patch: UpdateQuoteLineInput, key: keyof UpdateQuoteLineInput): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

/**
 * Current persisted line ⊕ patch (#3205 W05). PURE, mirroring W03's
 * mergeContractLinePatch, so the service validates the MERGED row with
 * mode: 'persisted' and the editor can run the identical check before saving.
 *
 * contractLineType is never merged (not patchable). The two stamps are never
 * read from the patch: the service re-stamps them from the resolved group/site
 * AFTER the invariants run, and clearing siteId clears siteName with it.
 */
export function mergeQuoteLinePatch(current: PersistedQuoteLine, patch: UpdateQuoteLineInput): PersistedQuoteLine {
  const p = patch as Record<string, unknown>;
  return {
    ...current,
    recurrence: (p.recurrence as PersistedQuoteLine['recurrence']) ?? current.recurrence,
    deviceRoles: (p.deviceRoles as readonly string[] | undefined) ?? current.deviceRoles,
    deviceGroupId: (p.deviceGroupId as string | undefined) ?? current.deviceGroupId,
    deviceGroupName: current.deviceGroupName,
    siteId: quoteLinePatchHasKey(patch, 'siteId') ? ((p.siteId as string | null) ?? null) : current.siteId,
    siteName: quoteLinePatchHasKey(patch, 'siteId') ? (p.siteId ? current.siteName : null) : current.siteName,
    includedQuantity: quoteLinePatchHasKey(patch, 'includedQuantity') ? ((p.includedQuantity as number | null) ?? null) : current.includedQuantity,
    overageMode: quoteLinePatchHasKey(patch, 'overageMode') ? ((p.overageMode as 'bill' | 'flag' | null) ?? null) : current.overageMode,
    overageUnitPrice: quoteLinePatchHasKey(patch, 'overageUnitPrice') ? ((p.overageUnitPrice as number | null) ?? null) : current.overageUnitPrice,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/shared && npx vitest run src/validators/quotes.test.ts src/validators/contracts.test.ts`
Expected: PASS, with every pre-existing quote describe **unedited**.

- [ ] **Step 5: Typecheck downstream and commit**

Run: `cd packages/shared && npx tsc --noEmit -p tsconfig.json && cd ../../apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: `packages/shared` clean. `apps/api` now fails where `updateLine`'s hand-written input type does not admit the new keys — that is the compiler enforcing Task 6.

```bash
git add packages/shared/src/validators/quotes.ts packages/shared/src/validators/quotes.test.ts
git commit -m "feat(shared): quote-line device-set descriptor by delegation, server-derived quantity rule, strict patch schema (#3205 W05)"
```

---

### Task 5: Estimation — extract `buildOrgDeviceSnapshot`, add `quoteDeviceSet.ts`

**Files:**
- Modify: `apps/api/src/services/contractQuantities.ts` (add `buildOrgDeviceSnapshot`, `OrgDeviceSnapshotResult`)
- Modify: `apps/api/src/services/contractService.ts` (W02's private `orgSnapshot` becomes a cached wrapper)
- Create: `apps/api/src/services/quoteDeviceSet.ts`, `apps/api/src/services/quoteDeviceSet.test.ts`
- Create: `apps/api/src/__tests__/integration/quoteDeviceSetCounts.integration.test.ts`
- Unchanged (the parity proof): `contractService.test.ts`, `contractCoverage.test.ts`, `contractDeviceGroups.integration.test.ts`

**Interfaces:**

```ts
// contractQuantities.ts
export interface OrgDeviceSnapshotResult {
  snapshot: OrgDeviceSnapshot;
  /** Groups that could NOT be resolved, by id. Empty on the happy path. */
  groupErrors: ReadonlyMap<string, GroupEvaluationError>;
}
export async function buildOrgDeviceSnapshot(orgId: string, groupIds: readonly string[]): Promise<OrgDeviceSnapshotResult>;

// quoteDeviceSet.ts
export interface QuoteDeviceSetLine {
  id: string; description: string;
  contractLineType: QuoteDeviceSetType;
  deviceRoles: string[] | null;
  deviceGroupId: string | null; deviceGroupName: string | null;
  siteId: string | null; siteName: string | null;
  includedQuantity: string | null;
  overageMode: 'bill' | 'flag' | null; overageUnitPrice: string | null;
}
export interface QuoteDeviceSetCount {
  lineId: string; counted: number; billed: number;
  included: number | null; overage: number; overageMode: 'bill' | 'flag' | null;
  error?: 'GROUP_EVALUATION_FAILED' | 'GROUP_DELETED' | 'SITE_DELETED';
}
export async function countQuoteDeviceSetLines(orgId: string, lines: readonly QuoteDeviceSetLine[]): Promise<QuoteDeviceSetCount[]>;
export async function persistQuoteDeviceSetQuantities(
  tx: DbExecutor, quoteId: string, currencyCode: string, counts: readonly QuoteDeviceSetCount[],
): Promise<void>;
```

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/services/quoteDeviceSet.test.ts`:

```ts
/**
 * #3205 W05: ONE snapshot for the whole set, PER-LINE degradation.
 *
 * The promise this file exists to keep: a quote can price four groups, and one
 * broken filter must mark ONE line, not four. That is only possible because
 * buildOrgDeviceSnapshot RETURNS its failures instead of throwing them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const buildOrgDeviceSnapshot = vi.fn();
const countContractSeats = vi.fn();
vi.mock('./contractQuantities', () => ({ buildOrgDeviceSnapshot, countContractSeats }));

import { countQuoteDeviceSetLines, type QuoteDeviceSetLine } from './quoteDeviceSet';
import { GroupEvaluationError } from './groupMembership';

const ORG = 'org-1';
const A = 'site-a';
const line = (p: Partial<QuoteDeviceSetLine> & Pick<QuoteDeviceSetLine, 'id' | 'contractLineType'>): QuoteDeviceSetLine => ({
  description: p.id, deviceRoles: null, deviceGroupId: null, deviceGroupName: null,
  siteId: null, siteName: null, includedQuantity: null, overageMode: null, overageUnitPrice: null, ...p,
});

const devices = [
  { id: 'd1', role: 'server', siteId: A },
  { id: 'd2', role: 'server', siteId: 'site-b' },
  { id: 'd3', role: 'workstation', siteId: A },
];

beforeEach(() => {
  vi.clearAllMocks();
  buildOrgDeviceSnapshot.mockResolvedValue({
    snapshot: { devices, groups: new Map([['g-ok', { siteId: null, memberIds: new Set(['d1', 'd3']) }]]) },
    groupErrors: new Map(),
  });
  countContractSeats.mockResolvedValue(7);
});

describe('countQuoteDeviceSetLines', () => {
  it('builds exactly ONE snapshot for many lines, and passes every named group id', async () => {
    await countQuoteDeviceSetLines(ORG, [
      line({ id: 'l1', contractLineType: 'per_device' }),
      line({ id: 'l2', contractLineType: 'per_device_role', deviceRoles: ['server'] }),
      line({ id: 'l3', contractLineType: 'per_device_group', deviceGroupId: 'g-ok', deviceGroupName: 'VIP' }),
    ]);
    expect(buildOrgDeviceSnapshot).toHaveBeenCalledTimes(1);
    expect(buildOrgDeviceSnapshot).toHaveBeenCalledWith(ORG, ['g-ok']);
  });

  it('counts each type from the shared snapshot; per_seat never touches it', async () => {
    const out = await countQuoteDeviceSetLines(ORG, [
      line({ id: 'l1', contractLineType: 'per_device' }),
      line({ id: 'l2', contractLineType: 'per_device', siteId: A, siteName: 'Dallas' }),
      line({ id: 'l3', contractLineType: 'per_device_role', deviceRoles: ['server'] }),
      line({ id: 'l4', contractLineType: 'per_device_group', deviceGroupId: 'g-ok', deviceGroupName: 'VIP' }),
      line({ id: 'l5', contractLineType: 'per_seat' }),
    ]);
    expect(out.map((c) => [c.lineId, c.counted, c.billed])).toEqual([
      ['l1', 3, 3], ['l2', 2, 2], ['l3', 2, 2], ['l4', 2, 2], ['l5', 7, 7],
    ]);
    expect(countContractSeats).toHaveBeenCalledWith(ORG);
  });

  // The degradation promise, stated as a test.
  it('a failed group marks ONLY its own lines and leaves the others counted', async () => {
    buildOrgDeviceSnapshot.mockResolvedValueOnce({
      snapshot: { devices, groups: new Map([['g-ok', { siteId: null, memberIds: new Set(['d1']) }]]) },
      groupErrors: new Map([['g-bad', new GroupEvaluationError('malformed_filter', 'bad')]]),
    });
    const out = await countQuoteDeviceSetLines(ORG, [
      line({ id: 'l1', contractLineType: 'per_device' }),
      line({ id: 'l2', contractLineType: 'per_device_group', deviceGroupId: 'g-bad', deviceGroupName: 'Broken' }),
      line({ id: 'l3', contractLineType: 'per_device_group', deviceGroupId: 'g-ok', deviceGroupName: 'VIP' }),
    ]);
    expect(out[0]).toMatchObject({ lineId: 'l1', counted: 3, error: undefined });
    expect(out[1]).toMatchObject({ lineId: 'l2', error: 'GROUP_EVALUATION_FAILED' });
    expect(out[2]).toMatchObject({ lineId: 'l3', counted: 1, error: undefined });
  });

  // NEVER silently zeroed: a zero here would be persisted as an authoritative
  // count, which is the exact silent failure this wave removes.
  it('an orphaned group or site yields an error and no number', async () => {
    const out = await countQuoteDeviceSetLines(ORG, [
      line({ id: 'l1', contractLineType: 'per_device_group', deviceGroupId: null, deviceGroupName: 'Gone' }),
      line({ id: 'l2', contractLineType: 'per_device', siteId: null, siteName: 'Dallas' }),
    ]);
    expect(out[0]).toMatchObject({ lineId: 'l1', error: 'GROUP_DELETED', counted: 0, billed: 0 });
    expect(out[1]).toMatchObject({ lineId: 'l2', error: 'SITE_DELETED', counted: 0, billed: 0 });
  });

  // W04's boundary rows, proven on the quote side: with an allowance the base
  // bills the ALLOWANCE every period, whether the count reaches it or not.
  it.each([[0, 25, 0], [24, 25, 0], [25, 25, 0], [26, 25, 1]])(
    'applies the fixed allowance at counted %i', async (counted, billed, overage) => {
      buildOrgDeviceSnapshot.mockResolvedValueOnce({
        snapshot: { devices: Array.from({ length: counted }, (_, i) => ({ id: `x${i}`, role: 'server', siteId: A })), groups: new Map() },
        groupErrors: new Map(),
      });
      const [c] = await countQuoteDeviceSetLines(ORG, [
        line({ id: 'l1', contractLineType: 'per_device', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' }),
      ]);
      expect(c).toMatchObject({ counted, billed, included: 25, overage, overageMode: 'bill' });
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/quoteDeviceSet.test.ts`
Expected: FAIL (module not found; `buildOrgDeviceSnapshot` not exported).

- [ ] **Step 3: Extract `buildOrgDeviceSnapshot` into `contractQuantities.ts`**

Append to `apps/api/src/services/contractQuantities.ts`:

```ts
export interface OrgDeviceSnapshotResult {
  snapshot: OrgDeviceSnapshot;
  /** Groups that could NOT be resolved, by id. A caller degrades the lines that
   *  name a failed group and counts the rest; `snapshot.groups` simply has no
   *  entry for them. Empty on the happy path. */
  groupErrors: ReadonlyMap<string, GroupEvaluationError>;
}

/** Assemble ONE OrgDeviceSnapshot: the org's billable devices plus the member
 *  set of every named group. The single place a snapshot is built — contract
 *  billing (via contractService's per-calculation cache) and quote estimation
 *  both come through here, so nothing ever counts devices with its own query
 *  (#3205 roadmap, settled decision 1).
 *
 *  Returns failures instead of throwing them: a set of lines may reference
 *  several groups, and one bad filter must not decide the fate of the others.
 *  Callers that want all-or-nothing re-throw the first entry — which is exactly
 *  what contractService's orgSnapshot does, preserving W02's behaviour.
 *
 *  A group id that does not come back — deleted between the line read and here,
 *  or not in this org — is simply absent from BOTH maps; callers treat that like
 *  a null id (GROUP_DELETED / unresolved). */
export async function buildOrgDeviceSnapshot(
  orgId: string, groupIds: readonly string[] = [],
): Promise<OrgDeviceSnapshotResult> {
  const devicesList = await snapshotContractDevices(orgId);
  const groups = new Map<string, GroupMembers>();
  const groupErrors = new Map<string, GroupEvaluationError>();
  const wanted = [...new Set(groupIds)];
  if (wanted.length > 0) {
    const rows = await db.select({
      id: deviceGroups.id, orgId: deviceGroups.orgId, name: deviceGroups.name, type: deviceGroups.type,
      siteId: deviceGroups.siteId, filterConditions: deviceGroups.filterConditions,
    }).from(deviceGroups).where(and(inArray(deviceGroups.id, wanted), eq(deviceGroups.orgId, orgId)));
    for (const g of rows) {
      try {
        groups.set(g.id, await groupMembersForBilling(g));
      } catch (err) {
        if (err instanceof GroupEvaluationError) { groupErrors.set(g.id, err); continue; }
        throw err;
      }
    }
  }
  return { snapshot: { devices: devicesList, groups }, groupErrors };
}
```

In `contractService.ts`, W02's private `orgSnapshot` becomes a cached wrapper — same signature, same cache, same all-or-nothing behaviour:

```ts
/** The org's snapshot with the members of every group in `groupIds` resolved
 *  (once per calculation). Behaviour is unchanged from wave 2: ONE contract's
 *  estimate is all-or-nothing, and listContracts / the MRR rollup already catch
 *  GROUP_EVALUATION_FAILED per contract. The assembly itself now lives in
 *  contractQuantities.buildOrgDeviceSnapshot so quote estimation shares it. */
async function orgSnapshot(orgId: string, dc: DeviceCache, groupIds: readonly string[] = []): Promise<OrgDeviceSnapshot> {
  let entry = dc.get(orgId);
  if (!entry) { entry = { devices: [], groups: new Map(), attempted: new Set(), loaded: false }; dc.set(orgId, entry); }
  const missing = groupIds.filter((id) => !entry!.attempted.has(id));
  if (!entry.loaded || missing.length > 0) {
    for (const id of missing) entry.attempted.add(id);
    const { snapshot, groupErrors } = await buildOrgDeviceSnapshot(orgId, missing);
    if (!entry.loaded) { entry.devices = snapshot.devices; entry.loaded = true; }
    for (const [id, members] of snapshot.groups) entry.groups.set(id, members);
    for (const [id, err] of groupErrors) {
      const [g] = await db.select({ name: deviceGroups.name }).from(deviceGroups).where(eq(deviceGroups.id, id)).limit(1);
      throw new ContractServiceError(
        `Device group "${g?.name ?? id}" could not be evaluated (${err.reason})`, 500, 'GROUP_EVALUATION_FAILED',
        { groupId: id, groupName: g?.name ?? null, reason: err.reason },
      );
    }
  }
  return entry;
}
```

**This is a pure move.** W02's `contractService.test.ts`, `contractCoverage.test.ts` and `contractDeviceGroups.integration.test.ts` must pass **untouched** — that is the whole parity proof for the extraction. If one needs an edit, the wrapper is not behaviour-preserving.

- [ ] **Step 4: Implement `quoteDeviceSet.ts`**

Create `apps/api/src/services/quoteDeviceSet.ts`:

```ts
/**
 * #3205 W05: the read-only quote-line estimator.
 *
 * ONE snapshot per call, ONE result per line, PER-LINE degradation — the pattern
 * wave 2 established for listContracts. A single failing group marks that line
 * only. Reads never evaluate: getQuote does no counting at all, because the
 * quantity is persisted. Only the four write moments, the advisory endpoint and
 * the send-time drift check come through here.
 *
 * Must be called inside a DB access context (request for the editor, system for
 * the accept-adjacent paths). Never writes a membership row.
 */
import { and, eq } from 'drizzle-orm';
import type { QuoteDeviceSetType } from '@breeze/shared';
import { buildOrgDeviceSnapshot, countContractSeats } from './contractQuantities';
import { quantityFor } from './contractCoverage';
import { applyAllowance } from './contractAllowance';
import { computeLineTotal } from './quoteMathAdapter';   // the same helper quoteService uses
import { quoteLines } from '../db/schema';

export interface QuoteDeviceSetLine {
  id: string;
  /** For reporting only (drift toasts, error meta); never persisted here. */
  description: string;
  contractLineType: QuoteDeviceSetType;
  deviceRoles: string[] | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  siteId: string | null;
  siteName: string | null;
  includedQuantity: string | null;
  overageMode: 'bill' | 'flag' | null;
  overageUnitPrice: string | null;
}

export interface QuoteDeviceSetCount {
  lineId: string;
  /** What the helpers measured right now. */
  counted: number;
  /** applyAllowance(counted, line, 'included_units').billed — what goes on
   *  quote_lines.quantity. Equals `counted` with no allowance. */
  billed: number;
  included: number | null;
  overage: number;
  overageMode: 'bill' | 'flag' | null;
  /** Set instead of a number when this line could not be counted. The line's
   *  stored quantity is left untouched; nothing is ever silently zeroed. */
  error?: 'GROUP_EVALUATION_FAILED' | 'GROUP_DELETED' | 'SITE_DELETED';
}

const FAILED = (lineId: string, error: NonNullable<QuoteDeviceSetCount['error']>): QuoteDeviceSetCount =>
  ({ lineId, counted: 0, billed: 0, included: null, overage: 0, overageMode: null, error });

export async function countQuoteDeviceSetLines(
  orgId: string, lines: readonly QuoteDeviceSetLine[],
): Promise<QuoteDeviceSetCount[]> {
  if (lines.length === 0) return [];
  const groupIds = [...new Set(lines.map((l) => l.deviceGroupId).filter((id): id is string => !!id))];
  const { snapshot, groupErrors } = await buildOrgDeviceSnapshot(orgId, groupIds);
  const seats = lines.some((l) => l.contractLineType === 'per_seat') ? await countContractSeats(orgId) : 0;

  return lines.map((l) => {
    // A stamped name with a null id is the DELETED state (spec decision 4). Not
    // counted and not zeroed: a persisted stale count that reads as authoritative
    // is the silent failure this wave exists to remove.
    if (l.contractLineType === 'per_device_group' && l.deviceGroupId === null && l.deviceGroupName !== null) return FAILED(l.id, 'GROUP_DELETED');
    if (l.siteId === null && l.siteName !== null) return FAILED(l.id, 'SITE_DELETED');
    if (l.deviceGroupId && (groupErrors.has(l.deviceGroupId) || !snapshot.groups.has(l.deviceGroupId))) {
      return FAILED(l.id, groupErrors.has(l.deviceGroupId) ? 'GROUP_EVALUATION_FAILED' : 'GROUP_DELETED');
    }
    const counted = l.contractLineType === 'per_seat'
      ? seats
      : quantityFor(snapshot, {
          lineType: l.contractLineType, siteId: l.siteId, deviceRoles: l.deviceRoles, deviceGroupId: l.deviceGroupId,
        });
    const r = applyAllowance(counted, {
      includedQuantity: l.includedQuantity, overageMode: l.overageMode, overageUnitPrice: l.overageUnitPrice,
    }, 'included_units');
    return { lineId: l.id, counted: r.counted, billed: r.billed, included: r.included, overage: r.overage, overageMode: r.overageMode };
  });
}

/** Write the derived quantities and recompute each line's total. Errored lines
 *  are SKIPPED — their stored quantity stands. The caller runs
 *  recomputeAndPersist afterwards. */
export async function persistQuoteDeviceSetQuantities(
  tx: { update: typeof import('../db').db.update },
  quoteId: string, currencyCode: string, counts: readonly QuoteDeviceSetCount[],
): Promise<void> {
  for (const c of counts) {
    if (c.error) continue;
    const quantity = c.billed.toFixed(2);
    await tx.update(quoteLines)
      .set({ quantity, lineTotal: undefined as never })    // lineTotal set below from the row's own unitPrice
      .where(and(eq(quoteLines.id, c.lineId), eq(quoteLines.quoteId, quoteId)));
  }
}
```

**Correction to `persistQuoteDeviceSetQuantities`, applied while implementing:** `lineTotal` needs the line's `unitPrice`, so the function takes the rows it is updating rather than re-reading them per line. Final shape:

```ts
export async function persistQuoteDeviceSetQuantities(
  tx: DbExecutor, quoteId: string, currencyCode: string,
  rows: ReadonlyArray<{ id: string; unitPrice: string }>, counts: readonly QuoteDeviceSetCount[],
): Promise<void> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of counts) {
    if (c.error) continue;
    const row = byId.get(c.lineId);
    if (!row) continue;
    const quantity = c.billed.toFixed(2);
    await tx.update(quoteLines)
      .set({ quantity, lineTotal: computeLineTotal(quantity, row.unitPrice, currencyCode) })
      .where(and(eq(quoteLines.id, c.lineId), eq(quoteLines.quoteId, quoteId)));
  }
}
```

`computeLineTotal` is `quoteService`'s existing helper; export it from `quoteService.ts` (or lift it to a small shared module) rather than re-deriving the money rule here.

Also export the row → line mapper, so `quoteService` never hand-rolls the projection at its four call sites:

```ts
/** A quote_lines row projected onto the estimator's input. `contractLineType`
 *  is non-null by construction — every caller filters on it first. */
export function toQuoteDeviceSetLine(row: {
  id: string; name: string | null; description: string | null;
  contractLineType: string | null; deviceRoles: string[] | null;
  deviceGroupId: string | null; deviceGroupName: string | null;
  siteId: string | null; siteName: string | null;
  includedQuantity: string | null; overageMode: string | null; overageUnitPrice: string | null;
}): QuoteDeviceSetLine {
  return {
    id: row.id,
    description: row.name ?? row.description ?? '',
    contractLineType: row.contractLineType as QuoteDeviceSetType,
    deviceRoles: row.deviceRoles,
    deviceGroupId: row.deviceGroupId, deviceGroupName: row.deviceGroupName,
    siteId: row.siteId, siteName: row.siteName,
    includedQuantity: row.includedQuantity,
    overageMode: row.overageMode as 'bill' | 'flag' | null,
    overageUnitPrice: row.overageUnitPrice,
  };
}
```

`DbExecutor` is `contractService`'s existing transaction/db union; import it rather than redeclaring one.

- [ ] **Step 5: Run the unit test and the W02 parity suites**

Run: `cd apps/api && npx vitest run src/services/quoteDeviceSet.test.ts src/services/contractService.test.ts src/services/contractCoverage.test.ts src/services/contractQuantities.test.ts`
Expected: PASS, with the three contract suites **unedited**.

- [ ] **Step 6: Write and run the real-DB estimation suite**

Red first: write the whole file, run it, and confirm it fails against the real DB **before** touching anything else — the helpers exist by now, so a green first run means the fixtures are not exercising them (a seed that inserts no devices passes every count assertion at 0).

Create `apps/api/src/__tests__/integration/quoteDeviceSetCounts.integration.test.ts` — seed one org with a partner, two sites, and devices at each (`devices.site_id` is NOT NULL), a static group, one decommissioned device and one `is_ephemeral` device, then assert against the **real** helpers:

- `per_device` counts every billable device and **excludes** the decommissioned and ephemeral ones;
- `per_device` with a `siteId` counts only that site;
- `per_device_role` with `['server']` counts only servers;
- `per_device_group` counts the members present in the billable snapshot;
- `per_seat` equals `countContractSeats(orgId)` and is unaffected by device changes;
- a line naming a group in **another** org yields `GROUP_DELETED` (the group is simply absent from the org-predicated read), never a cross-tenant count;
- with `includedQuantity: '25.00'`, `billed === 25` at counted 0/24/25/26 and `overage` is 0/0/0/1.

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/quoteDeviceSetCounts.integration.test.ts \
  src/__tests__/integration/contractDeviceGroups.integration.test.ts \
  src/__tests__/integration/contractQuantities.integration.test.ts
```
Expected: PASS, with the two contract suites **unedited**.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/contractQuantities.ts apps/api/src/services/contractService.ts \
  apps/api/src/services/quoteDeviceSet.ts apps/api/src/services/quoteDeviceSet.test.ts \
  apps/api/src/__tests__/integration/quoteDeviceSetCounts.integration.test.ts
git commit -m "feat(billing): share one org device snapshot between contracts and quotes; per-line quote estimation (#3205 W05)"
```

---

### Task 6: Quote service — `addManualLine`, `updateLine`, refresh + estimate endpoints, AI tool descriptions

**Files:**
- Modify: `apps/api/src/services/quoteService.ts:1456` (`addManualLine`), `:1595` (`updateLine`), `:844` (`getQuote` line read); add `refreshQuoteDeviceCounts`, `quoteDeviceSetEstimate`
- Modify: `apps/api/src/services/quoteTypes.ts` (`QuoteServiceErrorCode`)
- Modify: `apps/api/src/routes/quotes/quotes.ts:229-241`
- Modify: `apps/api/src/services/aiToolsQuotes.ts:308-345` (tool descriptions)
- Create: `apps/api/src/services/quoteService.deviceSet.test.ts`
- Modify: `apps/api/src/services/aiToolsQuotes.test.ts`

**Interfaces:**

```ts
// quoteTypes.ts — QuoteServiceErrorCode gains:
//   'GROUP_NOT_IN_ORG' | 'SITE_NOT_IN_ORG' | 'DEVICE_SET_UNCOUNTABLE'
//   | 'INVALID_LINE_PATCH' | 'QUOTE_LINE_REFERENCE_DELETED'
// quoteService.ts
export async function refreshQuoteDeviceCounts(quoteId: string, actor: QuoteActor): Promise<QuoteDeviceSetCount[]>;
export async function quoteDeviceSetEstimate(quoteId: string, actor: QuoteActor): Promise<QuoteDeviceSetCount[]>;
// routes
POST /quotes/:id/lines/refresh-device-counts   -> { data: QuoteDeviceSetCount[] }   (drafts only)
GET  /quotes/:id/device-set-estimate           -> { data: QuoteDeviceSetCount[] }   (any status, read-only)
```

- [ ] **Step 1: Write the failing service tests**

Create `apps/api/src/services/quoteService.deviceSet.test.ts` (Drizzle-mock conventions of `quoteService.test.ts`; `countQuoteDeviceSetLines` is mocked so the service contract is what is under test):

```ts
/**
 * #3205 W05: the quote-line writers. The quantity is DERIVED, never accepted
 * from the client, and a line whose number cannot be computed is refused rather
 * than created at zero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const countQuoteDeviceSetLines = vi.fn();
vi.mock('./quoteDeviceSet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./quoteDeviceSet')>()),
  countQuoteDeviceSetLines,
}));

import { addManualLine, updateLine, refreshQuoteDeviceCounts } from './quoteService';
import { QuoteServiceError } from './quoteTypes';

const QUOTE = '11111111-1111-4111-8111-111111111111';
const GROUP = '33333333-3333-4333-8333-333333333333';
const SITE = '22222222-2222-4222-8222-222222222222';
const ACTOR = { userId: 'u1', partnerId: 'p1', scope: 'partner' as const, orgIds: null };

beforeEach(() => { vi.clearAllMocks(); countQuoteDeviceSetLines.mockResolvedValue([{ lineId: 'new', counted: 3, billed: 3, included: null, overage: 0, overageMode: null }]); });

describe('addManualLine with a device set', () => {
  it('stamps device_group_name and site_name and stores the DERIVED quantity', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ id: GROUP, name: 'VIP Laptops', type: 'static', siteId: null }]);   // assertGroupInOrg
    queueResult([{ id: 'line-1' }]);                                                   // insert … returning
    await addManualLine(QUOTE, {
      sourceType: 'manual', name: 'VIP', unitPrice: 40, taxable: true, recurrence: 'monthly',
      contractLineType: 'per_device_group', deviceGroupId: GROUP,
    } as never, ACTOR);
    expect(lastInsertValues()).toMatchObject({
      contractLineType: 'per_device_group', deviceGroupId: GROUP, deviceGroupName: 'VIP Laptops',
      quantity: '3.00', lineTotal: '120.00',
    });
  });

  // THE MOST IMPORTANT ROW IN THIS SUITE. Quoting a brand-new customer with no
  // devices enrolled yet is the single most common case; refusing the line would
  // make the feature useless for new-customer proposals.
  it('stores 0 for an org with no matching devices', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([{ lineId: 'new', counted: 0, billed: 0, included: null, overage: 0, overageMode: null }]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ id: 'line-1' }]);
    await addManualLine(QUOTE, {
      sourceType: 'manual', name: 'Servers', unitPrice: 40, taxable: true, recurrence: 'monthly',
      contractLineType: 'per_device_role', deviceRoles: ['server'],
    } as never, ACTOR);
    expect(lastInsertValues()).toMatchObject({ quantity: '0.00', lineTotal: '0.00' });
  });

  it('400s for a group from another org', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([]);   // assertGroupInOrg finds nothing
    await expect(addManualLine(QUOTE, {
      sourceType: 'manual', name: 'x', unitPrice: 1, taxable: false, recurrence: 'monthly',
      contractLineType: 'per_device_group', deviceGroupId: GROUP,
    } as never, ACTOR)).rejects.toMatchObject({ status: 400, code: 'GROUP_NOT_IN_ORG' });
  });

  // Creating a line at zero because the count FAILED would be indistinguishable
  // from the legitimate zero above. Refuse instead.
  it('400s DEVICE_SET_UNCOUNTABLE when the count fails, rather than creating a zero line', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([{ lineId: 'new', counted: 0, billed: 0, included: null, overage: 0, overageMode: null, error: 'GROUP_EVALUATION_FAILED' }]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ id: GROUP, name: 'Broken', type: 'dynamic', siteId: null }]);
    await expect(addManualLine(QUOTE, {
      sourceType: 'manual', name: 'x', unitPrice: 1, taxable: false, recurrence: 'monthly',
      contractLineType: 'per_device_group', deviceGroupId: GROUP,
    } as never, ACTOR)).rejects.toMatchObject({ status: 400, code: 'DEVICE_SET_UNCOUNTABLE', meta: { groupName: 'Broken' } });
  });

  it('representability-checks overageUnitPrice in the quote currency', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'JPY' });
    await expect(addManualLine(QUOTE, {
      sourceType: 'manual', name: 'x', unitPrice: 40, taxable: false, recurrence: 'monthly',
      contractLineType: 'per_device', includedQuantity: 25, overageMode: 'bill', overageUnitPrice: 12.5,
    } as never, ACTOR)).rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
  });
});

describe('updateLine on a device-set line', () => {
  const stored = {
    id: 'line-1', quoteId: QUOTE, quantity: '3.00', unitPrice: '40.00', recurrence: 'monthly', parentLineId: null,
    contractLineType: 'per_device_role', deviceRoles: ['server'], deviceGroupId: null, deviceGroupName: null,
    siteId: null, siteName: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
  };

  it('re-derives the quantity when the descriptor changes', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([{ lineId: 'line-1', counted: 9, billed: 9, included: null, overage: 0, overageMode: null }]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([stored]);
    queueResult([{ id: 'line-1' }]);
    await updateLine(QUOTE, 'line-1', { deviceRoles: ['server', 'workstation'] } as never, ACTOR);
    expect(lastUpdateValues()).toMatchObject({ quantity: '9.00', lineTotal: '360.00', deviceRoles: ['server', 'workstation'] });
  });

  // The schema cannot do this one: a PATCH body carries no contractLineType, so
  // only the service knows what the line IS.
  it('400s on a client-supplied quantity for a device-set line', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([stored]);
    await expect(updateLine(QUOTE, 'line-1', { quantity: 12 } as never, ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_LINE_PATCH' });
  });

  it('400s on recurrence: one_time for a device-set line, before the CHECK can 500', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([stored]);
    await expect(updateLine(QUOTE, 'line-1', { recurrence: 'one_time' } as never, ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_LINE_PATCH' });
  });

  it('re-stamps the group name when deviceGroupId changes', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([{ lineId: 'line-1', counted: 2, billed: 2, included: null, overage: 0, overageMode: null }]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ ...stored, contractLineType: 'per_device_group', deviceRoles: null, deviceGroupId: GROUP, deviceGroupName: 'Old' }]);
    queueResult([{ id: 'g2', name: 'New Group', type: 'static', siteId: null }]);
    queueResult([{ id: 'line-1' }]);
    await updateLine(QUOTE, 'line-1', { deviceGroupId: 'g2' } as never, ACTOR);
    expect(lastUpdateValues()).toMatchObject({ deviceGroupId: 'g2', deviceGroupName: 'New Group' });
  });

  it('clearing siteId clears the stamp and re-derives org-wide', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([{ lineId: 'line-1', counted: 11, billed: 11, included: null, overage: 0, overageMode: null }]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ ...stored, contractLineType: 'per_device', deviceRoles: null, siteId: SITE, siteName: 'Dallas' }]);
    queueResult([{ id: 'line-1' }]);
    await updateLine(QUOTE, 'line-1', { siteId: null } as never, ACTOR);
    expect(lastUpdateValues()).toMatchObject({ siteId: null, siteName: null, quantity: '11.00' });
  });

  it('leaves an ordinary line completely alone', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ ...stored, contractLineType: null, deviceRoles: null }]);
    queueResult([{ id: 'line-1' }]);
    await updateLine(QUOTE, 'line-1', { quantity: 12 } as never, ACTOR);
    expect(countQuoteDeviceSetLines).not.toHaveBeenCalled();
    expect(lastUpdateValues()).toMatchObject({ quantity: '12' });
  });
});

describe('refreshQuoteDeviceCounts', () => {
  it('is refused on a non-draft quote', async () => {
    queueNonDraftQuote({ id: QUOTE, status: 'sent' });
    await expect(refreshQuoteDeviceCounts(QUOTE, ACTOR)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('updates quantities and line totals and returns the per-line results', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([
      { lineId: 'l1', counted: 5, billed: 5, included: null, overage: 0, overageMode: null },
      { lineId: 'l2', counted: 0, billed: 0, included: null, overage: 0, overageMode: null, error: 'GROUP_DELETED' },
    ]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([
      { id: 'l1', contractLineType: 'per_device', unitPrice: '40.00', quantity: '3.00', deviceGroupId: null, deviceGroupName: null, siteId: null, siteName: null, deviceRoles: null, includedQuantity: null, overageMode: null, overageUnitPrice: null, name: 'A', description: null },
      { id: 'l2', contractLineType: 'per_device_group', unitPrice: '10.00', quantity: '7.00', deviceGroupId: null, deviceGroupName: 'Gone', siteId: null, siteName: null, deviceRoles: null, includedQuantity: null, overageMode: null, overageUnitPrice: null, name: 'B', description: null },
    ]);
    const out = await refreshQuoteDeviceCounts(QUOTE, ACTOR);
    expect(out).toHaveLength(2);
    // The errored line keeps its stored quantity — never silently zeroed.
    expect(updateCallsFor('l2')).toHaveLength(0);
    expect(lastUpdateValues()).toMatchObject({ quantity: '5.00', lineTotal: '200.00' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/quoteService.deviceSet.test.ts`
Expected: FAIL — `refreshQuoteDeviceCounts` does not exist and no writer knows about the descriptor.

- [ ] **Step 3: Implement `addManualLine`**

In `apps/api/src/services/quoteService.ts`, add beside `assertRepresentable` (`:1447`):

```ts
/** #3205 W05: resolve and STAMP a device group in the quote's org. Same shape as
 *  contractService's assertGroupInOrg — the stamp is what survives the FK's
 *  ON DELETE SET NULL and lets a deleted reference be detected. */
async function assertQuoteGroupInOrg(tx: DbExecutor, groupId: string, orgId: string) {
  const [row] = await tx.select({ id: deviceGroups.id, name: deviceGroups.name, type: deviceGroups.type })
    .from(deviceGroups).where(and(eq(deviceGroups.id, groupId), eq(deviceGroups.orgId, orgId))).limit(1);
  if (!row) throw new QuoteServiceError('Device group does not belong to this organization', 400, 'GROUP_NOT_IN_ORG');
  return row;
}
async function assertQuoteSiteInOrg(tx: DbExecutor, siteId: string, orgId: string) {
  const [row] = await tx.select({ id: sites.id, name: sites.name })
    .from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1);
  if (!row) throw new QuoteServiceError('Site does not belong to this organization', 400, 'SITE_NOT_IN_ORG');
  return row;
}
```

In `addManualLine`, after `assertRepresentable(unitPrice, q.currencyCode)`:

```ts
    // #3205 W05: the device-set descriptor. Resolve + stamp the references, then
    // DERIVE the quantity from the same helpers that will bill it (decision 5).
    const setType = input.contractLineType ?? null;
    const group = setType === 'per_device_group' && input.deviceGroupId
      ? await assertQuoteGroupInOrg(tx, input.deviceGroupId, q.orgId) : null;
    const site = setType && input.siteId ? await assertQuoteSiteInOrg(tx, input.siteId, q.orgId) : null;
    const overageUnitPrice = input.overageUnitPrice != null ? Number(input.overageUnitPrice).toFixed(2) : null;
    if (overageUnitPrice != null) assertRepresentable(overageUnitPrice, q.currencyCode);
    const includedQuantity = input.includedQuantity != null ? Number(input.includedQuantity).toFixed(2) : null;

    let quantity = String(input.quantity);
    if (setType) {
      const [count] = await countQuoteDeviceSetLines(q.orgId, [{
        id: 'new', description: input.name ?? input.description ?? '',
        contractLineType: setType, deviceRoles: input.deviceRoles ?? null,
        deviceGroupId: group?.id ?? null, deviceGroupName: group?.name ?? null,
        siteId: site?.id ?? null, siteName: site?.name ?? null,
        includedQuantity, overageMode: input.overageMode ?? null, overageUnitPrice,
      }]);
      // Refusing to create a line whose number cannot be computed is better than
      // creating one at zero: a zero from a FAILED count is indistinguishable
      // from the legitimate new-customer zero.
      if (count!.error) {
        throw new QuoteServiceError(
          'This device set could not be counted right now — check the device group and try again',
          400, 'DEVICE_SET_UNCOUNTABLE', { reason: count!.error, groupName: group?.name ?? null },
        );
      }
      quantity = count!.billed.toFixed(2);
    }
```

…and in the insert values, after `billingFrequency`:

```ts
      contractLineType: setType,
      deviceRoles: setType === 'per_device_role' ? (input.deviceRoles ?? null) : null,
      deviceGroupId: group?.id ?? null,
      deviceGroupName: group?.name ?? null,
      siteId: site?.id ?? null,
      siteName: site?.name ?? null,
      includedQuantity,
      overageMode: input.overageMode ?? null,
      overageUnitPrice,
```

with `quantity` and `lineTotal: computeLineTotal(quantity, unitPrice, q.currencyCode)` already reading the derived value.

- [ ] **Step 4: Implement `updateLine`**

Widen `updateLine`'s hand-written input type with the six patchable descriptor fields (`deviceRoles?`, `deviceGroupId?`, `siteId?: string | null`, `includedQuantity?: number | null`, `overageMode?`, `overageUnitPrice?: number | null`), then, after the `existing` read:

```ts
    // #3205 W05. A patch naming contractLineType is already a 400 at the
    // .strict() schema edge, so the service never sees one.
    if (existing.contractLineType) {
      // The stateful half of decision 5: the schema cannot check this, because a
      // PATCH body carries no contractLineType and only the service knows what
      // the line IS.
      if (input.quantity !== undefined) {
        throw new QuoteServiceError(
          'quantity is derived from the live device count on a device-set line — use POST /quotes/:id/lines/refresh-device-counts',
          400, 'INVALID_LINE_PATCH', { issues: [{ path: 'quantity', message: 'quantity is server-derived on a device-set line' }] },
        );
      }
      const merged = mergeQuoteLinePatch(existing as never, input as never);
      const issues = quoteLineDeviceSetIssues(merged, { mode: 'persisted' });
      if (issues.length > 0) throw new QuoteServiceError('Invalid line patch', 400, 'INVALID_LINE_PATCH', { issues });

      // Re-stamp only what moved; the merge has already cleared siteName when
      // the patch cleared siteId.
      if (input.deviceGroupId !== undefined && input.deviceGroupId !== existing.deviceGroupId) {
        const g = await assertQuoteGroupInOrg(tx, input.deviceGroupId, q.orgId);
        set.deviceGroupId = g.id; set.deviceGroupName = g.name;
      }
      if (Object.prototype.hasOwnProperty.call(input, 'siteId') && input.siteId !== existing.siteId) {
        const s = input.siteId ? await assertQuoteSiteInOrg(tx, input.siteId, q.orgId) : null;
        set.siteId = s?.id ?? null; set.siteName = s?.name ?? null;
      }
      for (const k of ['deviceRoles', 'includedQuantity', 'overageMode', 'overageUnitPrice'] as const) {
        if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
        const v = input[k];
        set[k] = k === 'includedQuantity' || k === 'overageUnitPrice'
          ? (v == null ? null : Number(v).toFixed(2))
          : (v ?? null);
      }
      if (set.overageUnitPrice) assertRepresentable(set.overageUnitPrice as string, q.currencyCode);

      // Re-derive whenever any descriptor or allowance field moved — the
      // descriptor just changed, so the number must (decision 6).
      const descriptorTouched = ['deviceRoles', 'deviceGroupId', 'siteId', 'includedQuantity', 'overageMode', 'overageUnitPrice']
        .some((k) => Object.prototype.hasOwnProperty.call(input, k));
      if (descriptorTouched) {
        const [count] = await countQuoteDeviceSetLines(q.orgId, [{
          id: lineId, description: (set.name as string) ?? existing.name ?? '',
          contractLineType: existing.contractLineType,
          deviceRoles: (set.deviceRoles as string[] | null) ?? existing.deviceRoles,
          deviceGroupId: (set.deviceGroupId as string | null) ?? existing.deviceGroupId,
          deviceGroupName: (set.deviceGroupName as string | null) ?? existing.deviceGroupName,
          siteId: (set.siteId as string | null) ?? existing.siteId,
          siteName: (set.siteName as string | null) ?? existing.siteName,
          includedQuantity: (set.includedQuantity as string | null) ?? existing.includedQuantity,
          overageMode: (set.overageMode as 'bill' | 'flag' | null) ?? existing.overageMode,
          overageUnitPrice: (set.overageUnitPrice as string | null) ?? existing.overageUnitPrice,
        }]);
        if (count!.error) {
          throw new QuoteServiceError('This device set could not be counted right now', 400, 'DEVICE_SET_UNCOUNTABLE', { reason: count!.error });
        }
        set.quantity = count!.billed.toFixed(2);
        set.lineTotal = computeLineTotal(set.quantity as string, (set.unitPrice as string) ?? existing.unitPrice, q.currencyCode);
      }
    }
```

`recurrence` is merged before the invariant run, so a `→ one_time` patch on a descriptor line is a 400 `INVALID_LINE_PATCH` (path `recurrence`) and never reaches the CHECK as a 500.

- [ ] **Step 5: Implement the two new service functions and the routes**

```ts
/** #3205 W05, decision 6: the explicit, auditable refresh. Drafts only — a
 *  sent quote's lines are immutable (lockDraftQuote). Same reasoning as W03's
 *  refreshCatalogPrice: a quantity must never move as a side effect of an
 *  unrelated edit. */
export async function refreshQuoteDeviceCounts(quoteId: string, actor: QuoteActor): Promise<QuoteDeviceSetCount[]> {
  return db.transaction(async (tx) => {
    const q = await lockDraftQuote(tx, quoteId, actor);
    const rows = await tx.select().from(quoteLines)
      .where(and(eq(quoteLines.quoteId, quoteId), isNotNull(quoteLines.contractLineType)));
    if (rows.length === 0) return [];
    const counts = await countQuoteDeviceSetLines(q.orgId, rows.map(toQuoteDeviceSetLine));
    await persistQuoteDeviceSetQuantities(tx, quoteId, q.currencyCode, rows, counts);
    await recomputeAndPersist(quoteId, tx);
    return counts;
  });
}

/** Advisory live counts for the editor's staleness chip and the send-time drift
 *  report. READ-ONLY and available in any status — it changes nothing, so a
 *  sent quote can be inspected without being repriced. */
export async function quoteDeviceSetEstimate(quoteId: string, actor: QuoteActor): Promise<QuoteDeviceSetCount[]> {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertQuoteAccess(actor, q);
  const rows = await db.select().from(quoteLines)
    .where(and(eq(quoteLines.quoteId, quoteId), isNotNull(quoteLines.contractLineType)));
  return countQuoteDeviceSetLines(q.orgId, rows.map(toQuoteDeviceSetLine));
}
```

Routes, after the existing line routes in `apps/api/src/routes/quotes/quotes.ts`:

```ts
quoteCrudRoutes.post('/:id/lines/refresh-device-counts', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await refreshQuoteDeviceCounts(c.req.valid('param').id, quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
// Read permission is quotes:read, not devices:read, following the
// GET /contracts/:id/estimate precedent: the caller already has org access to
// the quote, and the derived count is what they are entitled to see.
quoteCrudRoutes.get('/:id/device-set-estimate', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await quoteDeviceSetEstimate(c.req.valid('param').id, quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
```

`POST /quotes/:id/lines` and `PATCH /quotes/:id/lines/:lineId` need **no** signature change — the widened `quoteLineInputSchema` / `updateQuoteLineSchema` do the work.

- [ ] **Step 6: AI tool descriptions**

In `apps/api/src/services/aiToolsQuotes.ts`, append to the `line` description (`:337-345`) and, in shortened form, to the `patch` description (`:308-316`):

> A **recurring** line may instead bill a device set: set `contractLineType` to `per_device`, `per_device_role`, `per_device_group` or `per_seat` and **omit `quantity`** — the server counts the org's devices (or seats) itself and re-counts every billing period once the quote is accepted. `per_device_role` requires `deviceRoles`; `per_device_group` requires `deviceGroupId`; `per_device` and `per_device_role` may take a `siteId`. Any of the four may carry `includedQuantity` + `overageMode` (`bill` needs `overageUnitPrice`, in the quote's currency), which bills the included quantity every period even when the live count is lower. The quantity shown on the quote is an **estimate**, labelled as such on the customer's document; the contract bills the actual count. A device set cannot be added to a one-time line, changed after the line is created (remove and re-add), or set on a bundle component.

`REQUIRED_PARAMS` is unchanged — `manage_quotes` already wraps the shared schemas (`linePayload` `:119`, `linePatchPayload` `:120`), so the rules are enforced at runtime whatever the prose says.

Add to `aiToolsQuotes.test.ts`: `add_manual_line` accepts a `per_device_role` line with roles and no `quantity`, rejects one **with** a `quantity`, rejects a descriptor on a `one_time` line, rejects `per_device_group` with no `deviceGroupId`, and accepts an allowance; `update_line` rejects `contractLineType`.

- [ ] **Step 7: Run and commit**

Run: `cd apps/api && npx vitest run src/services/quoteService src/services/aiToolsQuotes src/routes/quotes && npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: PASS; tsc clean.

```bash
git add apps/api/src/services/quoteService.ts apps/api/src/services/quoteService.deviceSet.test.ts \
  apps/api/src/services/quoteTypes.ts apps/api/src/routes/quotes/quotes.ts \
  apps/api/src/services/aiToolsQuotes.ts apps/api/src/services/aiToolsQuotes.test.ts
git commit -m "feat(billing): device-set quote line writers, refresh + estimate endpoints, AI tool contract (#3205 W05)"
```

---

### Task 7: Org retarget, clone, revision, currency lock, customer projection, send-time drift

**Files:**
- Modify: `apps/api/src/services/quoteService.ts:1125-1170` (retarget), `:489-720` (`cloneQuoteCore`), `:1191-1227` (`changeQuoteCurrency`), `:76-81` (`CUSTOMER_LINE_FIELDS`), `:844` (`getQuote`)
- Modify: `apps/api/src/services/quoteLifecycle.ts:69-75`, `:380`
- Modify: `apps/api/src/services/quoteService.test.ts`, `apps/api/src/services/quoteLifecycle.test.ts`
- Create: `apps/api/src/__tests__/integration/quoteDeviceSetOrgRetarget.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/orgMerge.integration.test.ts`

**Interfaces:**

```ts
export interface QuoteDeviceSetDrift {
  lineId: string; description: string;
  storedQuantity: string; liveQuantity: number | null;
  reason?: 'org_retargeted';
  error?: 'GROUP_EVALUATION_FAILED' | 'GROUP_DELETED' | 'SITE_DELETED';
}
// SendQuoteResult gains: deviceSetDrift: QuoteDeviceSetDrift[]   // ALWAYS present, [] when clean
// updateQuote / cloneQuote responses gain the same array for reason: 'org_retargeted'
// CUSTOMER_LINE_FIELDS gains: contractLineType, deviceRoles, deviceGroupName, siteName,
//                             includedQuantity, overageMode, overageUnitPrice
//   — and NOT deviceGroupId / siteId (raw internal identifiers).
```

- [ ] **Step 1: Write the failing retarget integration suite**

Create `apps/api/src/__tests__/integration/quoteDeviceSetOrgRetarget.integration.test.ts`:

```ts
/**
 * #3205 W05 decision 7. Two claims, tested separately because they behave
 * differently and both are easy to get wrong:
 *
 *  - the retarget SUCCEEDS at all. Without the named
 *    `SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED` this is a 23503: the
 *    parent UPDATE quotes runs before the children's, and the FK is checked at
 *    end-of-statement. That regression is the reason this file exists.
 *  - an UNSCOPED descriptor is re-derived in the target org; a SCOPED one is
 *    cleared, keeps its stamp, is flagged, and has its quantity LEFT ALONE.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, deviceGroups, quotes, quoteBlocks, quoteLines } from '../../db/schema';
import { updateQuote, cloneQuote, reviseQuote, getQuote } from '../../services/quoteService';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ACTOR = (partnerId: string) => ({ userId: null, partnerId, scope: 'partner' as const, orgIds: null });

/** Org A has 2 servers, org B has 5 — so a CARRIED count and a RE-DERIVED one
 *  are distinguishable, which is the only way this assertion means anything. */
async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `RT ${sfx}`, slug: `rt-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'RA', slug: `ra-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'RB', slug: `rb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [sA] = await db.insert(sites).values({ orgId: oA!.id, name: `Dallas ${sfx}` }).returning({ id: sites.id, name: sites.name });
    const [sB] = await db.insert(sites).values({ orgId: oB!.id, name: `Austin ${sfx}` }).returning({ id: sites.id });
    const mk = (orgId: string, siteId: string, n: number) => Array.from({ length: n }, (_, i) => ({
      orgId, siteId, agentId: `${orgId}-${i}-${sfx}`, hostname: `h${i}`, status: 'online' as const,
      osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '1', deviceRole: 'server' as const,
    }));
    await db.insert(devices).values([...mk(oA!.id, sA!.id, 2), ...mk(oB!.id, sB!.id, 5)] as never);
    const [g] = await db.insert(deviceGroups).values({ orgId: oA!.id, name: `VIP ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id, name: deviceGroups.name });
    const [q] = await db.insert(quotes).values({ partnerId: p!.id, orgId: oA!.id, currencyCode: 'USD', status: 'draft' }).returning({ id: quotes.id });
    const [blk] = await db.insert(quoteBlocks).values({ quoteId: q!.id, orgId: oA!.id, blockType: 'line_items', content: {} }).returning({ id: quoteBlocks.id });
    const [unscoped, scopedGroup, scopedSite] = await db.insert(quoteLines).values([
      { quoteId: q!.id, orgId: oA!.id, blockId: blk!.id, sourceType: 'manual', name: 'Servers', quantity: '2.00', unitPrice: '40.00', taxable: false, recurrence: 'monthly', lineTotal: '80.00', contractLineType: 'per_device_role', deviceRoles: ['server'], includedQuantity: '25.00', overageMode: 'flag' },
      { quoteId: q!.id, orgId: oA!.id, blockId: blk!.id, sourceType: 'manual', name: 'VIP', quantity: '7.00', unitPrice: '10.00', taxable: false, recurrence: 'monthly', lineTotal: '70.00', contractLineType: 'per_device_group', deviceGroupId: g!.id, deviceGroupName: g!.name },
      { quoteId: q!.id, orgId: oA!.id, blockId: blk!.id, sourceType: 'manual', name: 'Dallas', quantity: '2.00', unitPrice: '5.00', taxable: false, recurrence: 'monthly', lineTotal: '10.00', contractLineType: 'per_device', siteId: sA!.id, siteName: sA!.name },
    ] as never).returning({ id: quoteLines.id });
    return { partnerId: p!.id, orgA: oA!.id, orgB: oB!.id, group: g!, site: sA!, quoteId: q!.id, unscoped: unscoped!.id, scopedGroup: scopedGroup!.id, scopedSite: scopedSite!.id };
  });
}

describe('quote org retarget with device-set lines (#3205 W05)', () => {
  // THE REGRESSION. Drop the named deferral and this is a 23503.
  runDb('succeeds and moves every child org_id', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => updateQuote(f.quoteId, { orgId: f.orgB }, ACTOR(f.partnerId)));
    const rows = await withSystemDbAccessContext(() =>
      db.select({ orgId: quoteLines.orgId }).from(quoteLines).where(eq(quoteLines.quoteId, f.quoteId)));
    expect(rows.every((r) => r.orgId === f.orgB)).toBe(true);
  });

  runDb('an UNSCOPED descriptor keeps its roles and allowance and is RE-DERIVED in the target org', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => updateQuote(f.quoteId, { orgId: f.orgB }, ACTOR(f.partnerId)));
    const [l] = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.id, f.unscoped)));
    // 5 servers in org B, not the 2 it was quoted at in org A.
    expect(l).toMatchObject({ quantity: '5.00', deviceRoles: ['server'], includedQuantity: '25.00', overageMode: 'flag' });
  });

  runDb('a SCOPED descriptor is cleared, keeps its stamp, is flagged, and keeps its quantity EXACTLY', async () => {
    const f = await seed();
    const res = await withSystemDbAccessContext(() => updateQuote(f.quoteId, { orgId: f.orgB }, ACTOR(f.partnerId)));
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, f.quoteId)));
    const group = rows.find((r) => r.id === f.scopedGroup)!;
    const site = rows.find((r) => r.id === f.scopedSite)!;
    // Never re-derived (the descriptor is incomplete, so any number is a
    // fiction) and never zeroed (a stale count that reads as authoritative is
    // the silent failure this wave removes).
    expect(group).toMatchObject({ deviceGroupId: null, deviceGroupName: f.group.name, quantity: '7.00' });
    expect(site).toMatchObject({ siteId: null, siteName: f.site.name, quantity: '2.00' });
    expect((res as { deviceSetDrift?: unknown[] }).deviceSetDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineId: f.scopedGroup, reason: 'org_retargeted' }),
      expect.objectContaining({ lineId: f.scopedSite, reason: 'org_retargeted' }),
    ]));
    const read = await withSystemDbAccessContext(() => getQuote(f.quoteId, ACTOR(f.partnerId)));
    expect(read.lines.find((l) => l.id === f.scopedGroup)).toMatchObject({ descriptorUnresolved: true });
  });

  runDb('a retargeted clone behaves identically', async () => {
    const f = await seed();
    const cloned = await withSystemDbAccessContext(() => cloneQuote(f.quoteId, { orgId: f.orgB }, ACTOR(f.partnerId)));
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, (cloned as { id: string }).id)));
    expect(rows.find((r) => r.contractLineType === 'per_device_role')).toMatchObject({ quantity: '5.00' });
    expect(rows.find((r) => r.contractLineType === 'per_device_group')).toMatchObject({ deviceGroupId: null, deviceGroupName: f.group.name, quantity: '7.00' });
  });

  runDb('a same-org clone and a revision carry every descriptor column AND the quantity verbatim', async () => {
    const f = await seed();
    const cloned = await withSystemDbAccessContext(() => cloneQuote(f.quoteId, {}, ACTOR(f.partnerId)));
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, (cloned as { id: string }).id)));
    expect(rows.find((r) => r.contractLineType === 'per_device_group')).toMatchObject({ deviceGroupId: f.group.id, deviceGroupName: f.group.name, quantity: '7.00' });
    // A revision that only changes terms must not silently move money.
    await withSystemDbAccessContext(() => db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, f.quoteId)));
    const rev = await withSystemDbAccessContext(() => reviseQuote(f.quoteId, {}, ACTOR(f.partnerId)));
    const revRows = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, (rev as { id: string }).id)));
    expect(revRows.find((r) => r.contractLineType === 'per_device_role')).toMatchObject({ quantity: '2.00' });
    await expect(withSystemDbAccessContext(() => reviseQuote(f.quoteId, { orgId: f.orgB } as never, ACTOR(f.partnerId))))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteDeviceSetOrgRetarget.integration.test.ts`
Expected: FAIL — the first case with a `23503` on `quote_lines_quote_org_fk` (the regression this file pins), the rest on missing behaviour.

- [ ] **Step 3: Implement the retarget**

In `updateQuote`'s `orgChanged` transaction (`quoteService.ts:1144-1165`), in this order:

```ts
    await db.transaction(async (tx) => {
      // #3205 W05 decision 7: defer THIS constraint BY NAME, never ALL. The
      // parent's org_id update and the children's are separate statements, and
      // quote_lines_quote_org_fk is checked at end-of-statement. Naming the one
      // constraint keeps every other deferrable FK in this transaction checking
      // at statement boundaries, so an unrelated tenancy violation still fails
      // where it happened instead of surfacing unattributably at COMMIT.
      await tx.execute(sql`SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED`);
      …existing lock / currency / contract-block guards…
      await tx.update(quotes).set(set).where(eq(quotes.id, id));
      await tx.update(quoteBlocks).set({ orgId: targetOrgId }).where(eq(quoteBlocks.quoteId, id));
      await tx.update(quoteLines).set({ orgId: targetOrgId }).where(eq(quoteLines.quoteId, id));
      await tx.update(quoteImages).set({ orgId: targetOrgId }).where(eq(quoteImages.quoteId, id));

      // Scoped descriptors name a row that belongs to the OLD org. Clear the
      // ids, KEEP the stamps, and leave the quantity exactly as it was. The
      // RETURNING *is* the drift report — the cleared set is enumerated, never
      // inferred.
      const cleared = await tx.update(quoteLines)
        .set({ deviceGroupId: null, siteId: null })
        .where(and(eq(quoteLines.quoteId, id), or(isNotNull(quoteLines.deviceGroupId), isNotNull(quoteLines.siteId))))
        .returning({ id: quoteLines.id, name: quoteLines.name, description: quoteLines.description, quantity: quoteLines.quantity });
      deviceSetDrift = cleared.map((l) => ({
        lineId: l.id, description: l.name ?? l.description ?? '',
        storedQuantity: l.quantity, liveQuantity: null, reason: 'org_retargeted' as const,
      }));

      // Unscoped descriptors name nothing org-owned, so they are complete and
      // their stored count — measured in a DIFFERENT org — is meaningless.
      // Re-derive in the target org, in the same transaction.
      const unscoped = await tx.select().from(quoteLines).where(and(
        eq(quoteLines.quoteId, id), isNotNull(quoteLines.contractLineType),
        isNull(quoteLines.deviceGroupId), isNull(quoteLines.siteId),
      ));
      if (unscoped.length > 0) {
        const counts = await countQuoteDeviceSetLines(targetOrgId, unscoped.map(toQuoteDeviceSetLine));
        await persistQuoteDeviceSetQuantities(tx, id, q.currencyCode, unscoped, counts);
      }
      await recomputeAndPersist(id, tx);
    });
```

…and return `deviceSetDrift` on the update result. Every cleared line rides back so the operator is told which lines they must re-pick before sending; acceptance refuses an unresolved line (Task 9) and a retarget is drafts-only, so there is always a chance to fix it.

`cloneQuoteCore`'s line mapper (`:687-716`) carries all nine columns, nulling the two ids when `orgChanged`:

```ts
        contractLineType: line.contractLineType,
        deviceRoles: line.deviceRoles,
        // Stamps are KEPT on a retargeted clone: they are what the amber
        // "re-select for this organization" chip renders, and what tells the
        // operator which group the line used to price.
        deviceGroupId: orgChanged ? null : line.deviceGroupId,
        deviceGroupName: line.deviceGroupName,
        siteId: orgChanged ? null : line.siteId,
        siteName: line.siteName,
        includedQuantity: line.includedQuantity,
        overageMode: line.overageMode,
        overageUnitPrice: line.overageUnitPrice,
```

…followed, when `orgChanged`, by the same "re-derive the unscoped lines, report the cleared ones" block before `recomputeAndPersist`. A same-org clone and a revision carry `quantity` verbatim.

`getQuote` (`:851`) — replace the bare line select with a left join so the editor sees **live** names, and derive the flag:

```ts
  // The stamp is display and history; the LIVE row is authority (decision 22).
  // The operator's editor shows the live name (a renamed site reads correctly
  // here); an already-sent customer document renders the stamp, which is what
  // that customer was shown.
  const lines = (await db.select({
      line: quoteLines,
      deviceGroup: { id: deviceGroups.id, name: deviceGroups.name, type: deviceGroups.type },
      site: { id: sites.id, name: sites.name },
    }).from(quoteLines)
    .leftJoin(deviceGroups, and(eq(deviceGroups.id, quoteLines.deviceGroupId), eq(deviceGroups.orgId, quoteLines.orgId)))
    .leftJoin(sites, and(eq(sites.id, quoteLines.siteId), eq(sites.orgId, quoteLines.orgId)))
    .where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder))
    .map(({ line, deviceGroup, site }) => ({
      ...line,
      deviceGroup: deviceGroup?.id ? deviceGroup : null,
      site: site?.id ? site : null,
      // A stamped name with a null id: the thing this line prices is gone.
      descriptorUnresolved: Boolean(
        (line.deviceGroupId === null && line.deviceGroupName !== null)
        || (line.siteId === null && line.siteName !== null),
      ),
    }));
```

- [ ] **Step 4: Customer projection and the currency lock**

`CUSTOMER_LINE_FIELDS` (`:76-81`) gains, after `'depositEligible'`:

```ts
  // #3205 W05: the descriptor as PROSE inputs. Deliberately NOT deviceGroupId /
  // siteId — raw internal identifiers, which the allowlist's stated intent
  // excludes and the four renderers have no use for.
  'contractLineType', 'deviceRoles', 'deviceGroupName', 'siteName',
  'includedQuantity', 'overageMode', 'overageUnitPrice',
```

`changeQuoteCurrency` (`:1191`), before the reprice branch:

```ts
  // #3205 W05 / W04 decision 15: repriceQuoteCatalogLines writes only
  // unit_price, line_total and unit_cost — it cannot re-derive a hand-entered
  // overage rate, which would survive the restamp in the OLD currency.
  const [stamped] = await db.select({ id: quoteLines.id }).from(quoteLines)
    .where(and(eq(quoteLines.quoteId, id), isNotNull(quoteLines.overageUnitPrice))).limit(1);
  if (stamped) {
    throw new QuoteServiceError(
      'This quote has a hand-entered overage price; clear it before changing the currency',
      409, 'CURRENCY_LOCKED',
    );
  }
```

Add to `quoteService.test.ts`: `toCustomerLines` carries the seven descriptor fields and **omits `deviceGroupId` and `siteId`**; `changeQuoteCurrency` is 409 `CURRENCY_LOCKED` with a stamped overage rate and proceeds once it is cleared.

- [ ] **Step 5: Send-time drift**

`SendQuoteResult` (`quoteLifecycle.ts:69-75`) gains `deviceSetDrift: QuoteDeviceSetDrift[]` — **always present**, `[]` when nothing drifted, the `priceBookGaps` discipline. In `sendQuote`, after the content read and **before** the draft→sent claim:

```ts
  // #3205 W05 decision 12: send REPORTS drift, it never fixes it. A
  // scheduled/undo-window send fires hours later, so refreshing here would
  // reprice a document behind the operator's back after they approved it.
  // Wrapped so it can NEVER block a send: silence is a bug, but so is a send
  // that fails because a group filter is broken.
  let deviceSetDrift: QuoteDeviceSetDrift[] = [];
  try {
    const counts = await quoteDeviceSetEstimate(id, actor);
    deviceSetDrift = counts.flatMap((c) => {
      const line = lines.find((l) => l.id === c.lineId);
      if (!line) return [];
      if (c.error) return [{ lineId: c.lineId, description: line.name ?? line.description ?? '', storedQuantity: line.quantity, liveQuantity: null, error: c.error }];
      return c.billed === Number(line.quantity) ? [] : [{ lineId: c.lineId, description: line.name ?? line.description ?? '', storedQuantity: line.quantity, liveQuantity: c.billed }];
    });
  } catch (err) {
    console.error('[quoteLifecycle] device-set drift check failed', id, err);
  }
```

…returned in the result object at `:380`. Add to `quoteLifecycle.test.ts`: a stored quantity that no longer matches the live count returns an entry and **still sends**; an evaluation failure returns an entry with `error` and **still sends**; a quote with no descriptor line returns `[]`.

- [ ] **Step 6: Org merge**

Extend `orgMerge.integration.test.ts` (or a sibling) with a merge whose source org's quotes carry descriptor lines. `quote_lines` is a plain `repoint` table (`orgMergeRegistry.ts:602`), so every line's `org_id` moves to the survivor and **both stamped names survive verbatim**. Assert: no FK violation at COMMIT (the merge already defers constraints); stamps unchanged; and a descriptor line whose group did **not** survive the merge reads back **orphaned** (id null, stamp present) rather than dangling.

- [ ] **Step 7: Run and commit**

```bash
cd apps/api && npx vitest run src/services/quoteService src/services/quoteLifecycle && \
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/quoteDeviceSetOrgRetarget.integration.test.ts \
  src/__tests__/integration/orgMerge.integration.test.ts
```
Expected: PASS.

```bash
git add apps/api/src/services/quoteService.ts apps/api/src/services/quoteService.test.ts \
  apps/api/src/services/quoteLifecycle.ts apps/api/src/services/quoteLifecycle.test.ts \
  apps/api/src/__tests__/integration/quoteDeviceSetOrgRetarget.integration.test.ts \
  apps/api/src/__tests__/integration/orgMerge.integration.test.ts
git commit -m "feat(billing): org-retarget semantics, customer projection, currency lock and send-time drift for device-set quote lines (#3205 W05)"
```

---

### Task 8: Content hash v2 and the persisted `hash_version`

**Files:**
- Modify: `apps/api/src/services/quoteContentHash.ts:10-14` (`HashableLine`), `:42-47` (signature), `:48-64` (canonical object)
- Modify: `apps/api/src/services/quoteAcceptService.ts:165-190`
- Modify: `apps/api/src/services/quoteAcceptanceVerify.ts:65`
- Modify: `apps/api/src/services/quoteContentHash.test.ts`, `apps/api/src/services/quoteAcceptanceVerify.test.ts`

**Interfaces:**

```ts
export type QuoteHashVersion = 1 | 2;
export function computeQuoteSha256(
  quote: HashableQuote, blocks: HashableBlock[], lines: HashableLine[],
  contractParts: HashableContractPart[], version?: QuoteHashVersion,   // default 2
): string;
// HashableLine gains: contractLineType?, deviceRoles?, deviceGroupName?, siteName?,
//                     includedQuantity?, overageMode?, overageUnitPrice?   (all `| null`)
```

- [ ] **Step 1: Pin the pre-W05 hex, on the CURRENT tree**

Before touching `quoteContentHash.ts`, capture the literal hash of the fixture the test will use. This is a **measured** value, not a placeholder — record it in the test as a constant.

```bash
cd apps/api && node --input-type=module -e "
import { computeQuoteSha256 } from './src/services/quoteContentHash.ts';
const quote = { id: 'q1', currencyCode: 'USD', subtotal: '100.00', taxTotal: '0.00', total: '100.00',
  oneTimeTotal: '0.00', monthlyRecurringTotal: '100.00', annualRecurringTotal: '0.00' };
const lines = [{ id: 'l1', description: 'Servers', quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00',
  recurrence: 'monthly', taxable: false, customerVisible: true, sortOrder: 0 }];
console.log(computeQuoteSha256(quote, [], lines, []));
"
```
(If the loader rejects the `.ts` import, run the same three lines through `npx tsx`.) Record the output as `PRE_W05_HEX` in Step 2.

- [ ] **Step 2: Write the failing hash tests**

Append to `apps/api/src/services/quoteContentHash.test.ts`:

```ts
// ---------------------------------------------------------------------------
// #3205 W05 decision 8: the hash is VERSIONED.
//
// An emit-only-when-present conditional would have kept old hashes stable by
// construction, and that is how the deposit and contract-parts blocks work. But
// it makes the hash's meaning depend on a VALUE rather than a declared format,
// so a bug in the condition is invisible until a real customer's acceptance
// fails to verify years later. A version marker makes the contract checkable.
// ---------------------------------------------------------------------------
const PRE_W05_HEX = '<paste the hex measured in Step 1>';

const quote = { id: 'q1', currencyCode: 'USD', subtotal: '100.00', taxTotal: '0.00', total: '100.00',
  oneTimeTotal: '0.00', monthlyRecurringTotal: '100.00', annualRecurringTotal: '0.00' };
const plain = { id: 'l1', description: 'Servers', quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00',
  recurrence: 'monthly', taxable: false, customerVisible: true, sortOrder: 0 };
const descriptor = { ...plain, contractLineType: 'per_device_role', deviceRoles: ['workstation', 'server'],
  deviceGroupName: null, siteName: 'Dallas', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' };

describe('computeQuoteSha256 versioning (#3205 W05)', () => {
  // The strongest form of the backward-compatibility claim: v1 IGNORES the new
  // columns rather than merely happening not to see them.
  it('v1 on a FULL descriptor line equals the pinned pre-W05 hex', () => {
    expect(computeQuoteSha256(quote as never, [], [descriptor] as never, [], 1)).toBe(PRE_W05_HEX);
    expect(computeQuoteSha256(quote as never, [], [plain] as never, [], 1)).toBe(PRE_W05_HEX);
  });

  // NOT a silent no-op: the `version` key is present, so even a descriptor-free
  // quote hashes differently under v2 — and that is exactly what makes it safe,
  // because the version is persisted rather than inferred.
  it('v2 differs from v1 on both a descriptor-free and a descriptor quote', () => {
    expect(computeQuoteSha256(quote as never, [], [plain] as never, [], 2)).not.toBe(PRE_W05_HEX);
    expect(computeQuoteSha256(quote as never, [], [descriptor] as never, [], 2)).not.toBe(PRE_W05_HEX);
  });

  it('defaults to v2', () => {
    expect(computeQuoteSha256(quote as never, [], [descriptor] as never, []))
      .toBe(computeQuoteSha256(quote as never, [], [descriptor] as never, [], 2));
  });

  it.each([
    ['type', { contractLineType: 'per_device' }],
    ['roles', { deviceRoles: ['server'] }],
    ['groupName', { contractLineType: 'per_device_group', deviceRoles: null, deviceGroupName: 'VIP', siteName: null }],
    ['siteName', { siteName: 'Austin' }],
    ['included', { includedQuantity: '30.00' }],
    ['overageMode', { overageMode: 'flag', overageUnitPrice: null }],
    ['overageUnitPrice', { overageUnitPrice: '13.00' }],
  ])('a v2 hash moves when %s changes', (_n, patch) => {
    expect(computeQuoteSha256(quote as never, [], [{ ...descriptor, ...patch }] as never, [], 2))
      .not.toBe(computeQuoteSha256(quote as never, [], [descriptor] as never, [], 2));
  });

  it('role ORDER does not move a v2 hash', () => {
    expect(computeQuoteSha256(quote as never, [], [{ ...descriptor, deviceRoles: ['server', 'workstation'] }] as never, [], 2))
      .toBe(computeQuoteSha256(quote as never, [], [descriptor] as never, [], 2));
  });

  // THE FALSE-TAMPER REGRESSION. quoteAcceptanceVerify recomputes from CURRENT
  // rows, and both ids are ON DELETE SET NULL, so hashing them would report a
  // legitimate group or site deletion as tampering on an accepted quote.
  it('nulling device_group_id or site_id does NOT move a v2 hash', () => {
    const withIds = { ...descriptor, deviceGroupId: 'g1', siteId: 's1' };
    const nulled = { ...descriptor, deviceGroupId: null, siteId: null };
    expect(computeQuoteSha256(quote as never, [], [nulled] as never, [], 2))
      .toBe(computeQuoteSha256(quote as never, [], [withIds] as never, [], 2));
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/quoteContentHash.test.ts`
Expected: FAIL — `computeQuoteSha256` takes four parameters, and every `v2` expectation equals the `v1` value.

- [ ] **Step 4: Implement**

`HashableLine` (`:10-14`) gains the seven optional fields. The signature becomes:

```ts
export type QuoteHashVersion = 1 | 2;

export function computeQuoteSha256(
  quote: HashableQuote,
  blocks: HashableBlock[],
  lines: HashableLine[],
  contractParts: HashableContractPart[],
  /** Which canonicalisation to use. v1 is byte-for-byte the pre-#3205-W05
   *  function — no `version` key, no `deviceSet`, whatever the rows carry — so
   *  every acceptance recorded before that release re-verifies identically
   *  forever. The version is READ FROM quote_acceptances.hash_version, never
   *  inferred from the data being verified. */
  version: QuoteHashVersion = 2,
): string {
```

In the canonical `quote` object, `version: 2` is the **first** key when `version === 2`:

```ts
    quote: {
      ...(version === 2 ? { version: 2 } : {}),
      id: quote.id, currency: quote.currencyCode,
      …unchanged…
    },
```

In the line mapper (`:59-64`), after the existing `depositEligible` spread:

```ts
        // The device set is part of what the customer signs. Emitted ONLY under
        // v2 and ONLY when the line HAS one, so a v2 quote with no descriptor
        // line still differs from its v1 hash by the `version` key alone — which
        // is the point: the format is declared, not guessed.
        //
        // STAMPED VALUES ONLY, never device_group_id / site_id: both are
        // ON DELETE SET NULL, and quoteAcceptanceVerify recomputes this hash
        // from current rows, so hashing an id would report a legitimate group
        // or site deletion as tampering on an already-accepted quote.
        // roles are sorted so insertion order cannot move the hash.
        ...(version === 2 && l.contractLineType ? { deviceSet: {
          type: l.contractLineType,
          roles: l.deviceRoles ? [...l.deviceRoles].sort() : null,
          groupName: l.deviceGroupName ?? null,
          siteName: l.siteName ?? null,
          included: l.includedQuantity ?? null,
          overageMode: l.overageMode ?? null,
          overageUnitPrice: l.overageUnitPrice ?? null,
        } } : {}),
```

`quoteAcceptService.ts:165` becomes `computeQuoteSha256(quote as any, blocks as any, lines as any, contractParts, 2)`, and the `quote_acceptances` insert (`:175-190`) adds `hashVersion: 2,` beside `quoteSha256`.

`quoteAcceptanceVerify.ts:65` reads the persisted version:

```ts
  // Read, never inferred. Deriving it ("does any line have a descriptor?")
  // re-creates the fragility the version exists to remove: a v1 quote whose
  // line later ACQUIRED a descriptor through a migration or a support edit
  // would silently verify under the wrong algorithm.
  const hashVersion = (acceptance.hashVersion ?? 1) as QuoteHashVersion;
  const recomputedSha256 = computeQuoteSha256(quote as any, blocks as any, lines as any, parts, hashVersion);
```

…and the returned object gains `hashVersion` so a verification report says which algorithm it used.

- [ ] **Step 5: Verification-level tests, both directions**

Append to `apps/api/src/services/quoteAcceptanceVerify.test.ts` (or the integration sibling, whichever the file's existing cases use — both directions are required or the test proves nothing):

- a seeded **pre-W05** acceptance (`hash_version = 1`, hash computed by v1) verifies **clean** today, and **still verifies clean after its quote's group has been deleted**;
- a **v2** acceptance on a descriptor quote verifies clean, and still verifies clean after the group is deleted (the ids are not hashed);
- a v2 acceptance whose `device_group_name` or `included_quantity` is **edited directly in the DB** reports `matches: false`;
- `quote_acceptances.hash_version` defaults to `1` on a row inserted without it and is `2` on one written by `acceptQuote`.

- [ ] **Step 6: Run and commit**

Run: `cd apps/api && npx vitest run src/services/quoteContentHash src/services/quoteAcceptanceVerify src/services/quoteAcceptService`
Expected: PASS.

```bash
git add apps/api/src/services/quoteContentHash.ts apps/api/src/services/quoteContentHash.test.ts \
  apps/api/src/services/quoteAcceptService.ts apps/api/src/services/quoteAcceptanceVerify.ts \
  apps/api/src/services/quoteAcceptanceVerify.test.ts
git commit -m "feat(billing): version the quote acceptance hash; v2 covers the device set by its stamped values (#3205 W05)"
```

---

### Task 9: Acceptance — the contract-line mapping, `FOR SHARE` locks, and `assertQuoteLinesAcceptable`

**Files:**
- Modify: `apps/api/src/services/quoteToContract.ts:16-42` (types), `:107-122` (line mapper)
- Modify: `apps/api/src/services/quoteAcceptService.ts:147` (the guard), the line read at `:126-137`
- Modify: `apps/api/src/services/contractService.ts` (`assertSpecDeviceSetLine`, `createContractWithLinesDetailed`)
- Modify: `apps/api/src/services/quoteToContract.test.ts`
- Create: `apps/api/src/__tests__/integration/quoteAcceptDeviceSet.integration.test.ts`

**Interfaces:**

```ts
// QuoteLineForContract gains: contractLineType, deviceRoles, deviceGroupId, siteId, siteName,
//                             includedQuantity, overageMode, overageUnitPrice
// NewContractLineSpec gains:  lineType widened to include 'per_device_group' (W02),
//                             deviceGroupId (W02), the three allowance fields (W04),
//                             siteName?: string | null   (NEW in W05, #4693)
export function assertQuoteLinesAcceptable(lines: readonly AcceptableQuoteLine[]): void;
```

**The exact interface a device-set quote line produces** — diff against the type, do not infer it:

| `NewContractLineSpec` field | Value from a device-set quote line | Owner |
|---|---|---|
| `lineType` | `l.contractLineType` (one of the four) | W05 |
| `description` | `name — description`, unchanged | pre-existing |
| `unitPrice` | `l.unitPrice`, **frozen** | pre-existing |
| `taxable` | `l.taxable` | pre-existing |
| `catalogItemId` | **always `null`** — the accepted price is never re-resolved | pre-existing |
| `manualQuantity` | **always `null`** — the contract counts for itself | W05 |
| `deviceRoles` | `l.deviceRoles` on `per_device_role`, else `null` | W01 |
| `deviceGroupId` | `l.deviceGroupId` on `per_device_group`, else `null` | W02 |
| `siteId` | `l.siteId` on `per_device` / `per_device_role`, else `null` | W01 |
| `siteName` | `l.siteName` on `per_device` / `per_device_role`, else `null` — **new** (#4693) | W05 |
| `includedQuantity` | `l.includedQuantity` | W04 |
| `overageMode` | `l.overageMode` | W04 |
| `overageUnitPrice` | `l.overageUnitPrice` | W04 |
| `sortOrder` | index within the cadence group, unchanged | pre-existing |
| `sourceQuoteLineId` | `l.sourceQuoteLineId`, unchanged (never persisted) | pre-existing |

Not passed, deliberately: `deviceGroupName` (the contract writer re-stamps it from the **live** group, W02) and the quote's estimated `quantity` (the contract resolves its own every period — the entire point).

- [ ] **Step 1: Write the failing pure-mapper tests**

Append to `apps/api/src/services/quoteToContract.test.ts`:

```ts
// #3205 W05: a recurring line WITH a descriptor becomes the matching
// auto-quantity contract line. Every other recurring line still becomes
// 'manual', unchanged — that is the compatibility claim.
describe('buildContractSpecsFromQuote — device-set lines (#3205 W05)', () => {
  const quote = { orgId: 'o1', partnerId: 'p1', quoteNumber: 'Q-1', currencyCode: 'USD', terms: null };
  const base = { sourceQuoteLineId: 'ql1', recurrence: 'monthly' as const, customerVisible: true,
    name: 'Servers', description: null, unitPrice: '40.00', quantity: '12.00', taxable: true,
    catalogItemId: 'cat-1', termMonths: null };

  it('maps each of the four types, freezing the price and dropping the estimate', () => {
    const lines = [
      { ...base, contractLineType: 'per_device_role', deviceRoles: ['server'], siteId: 's1', siteName: 'Dallas' },
      { ...base, sourceQuoteLineId: 'ql2', contractLineType: 'per_device_group', deviceGroupId: 'g1', deviceGroupName: 'VIP' },
      { ...base, sourceQuoteLineId: 'ql3', contractLineType: 'per_seat', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' },
      { ...base, sourceQuoteLineId: 'ql4', contractLineType: 'per_device' },
    ];
    const [spec] = buildContractSpecsFromQuote(quote as never, lines as never, '2026-09-01', null);
    expect(spec!.lines).toEqual([
      expect.objectContaining({ lineType: 'per_device_role', deviceRoles: ['server'], siteId: 's1', siteName: 'Dallas', deviceGroupId: null, manualQuantity: null, catalogItemId: null, unitPrice: '40.00' }),
      expect.objectContaining({ lineType: 'per_device_group', deviceGroupId: 'g1', siteId: null, siteName: null, deviceRoles: null, manualQuantity: null }),
      expect.objectContaining({ lineType: 'per_seat', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00', siteId: null, siteName: null }),
      expect.objectContaining({ lineType: 'per_device', deviceRoles: null, deviceGroupId: null, manualQuantity: null }),
    ]);
    // deviceGroupName is NOT passed: the contract writer re-stamps it from the
    // LIVE group (W02), so a rename between send and accept is reflected.
    expect(spec!.lines[1]).not.toHaveProperty('deviceGroupName');
  });

  it('a recurring line WITHOUT a descriptor still becomes manual with the quoted quantity', () => {
    const [spec] = buildContractSpecsFromQuote(quote as never, [{ ...base, contractLineType: null }] as never, '2026-09-01', null);
    expect(spec!.lines[0]).toMatchObject({ lineType: 'manual', manualQuantity: '12.00', catalogItemId: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement the mapper**

Run: `cd apps/api && npx vitest run src/services/quoteToContract.test.ts` — FAIL (every line maps to `manual`).

`QuoteLineForContract` (`:16-27`) gains the eight descriptor fields (both stamps included, so the guard can read them and the contract line can inherit `siteName`); `NewContractLineSpec` (`:29-42`) gains `siteName?: string | null`. Replace the line mapper (`:107-122`):

```ts
      lines: group.map((l, i) => {
        const base = {
          description: (l.name && l.description ? `${l.name} — ${l.description}` : (l.name ?? l.description ?? '')),
          unitPrice: l.unitPrice,
          taxable: l.taxable,
          // Deliberately drop the catalog link: the accepted price is frozen
          // and must never be re-resolved later. Unchanged by W05.
          catalogItemId: null,
          sourceQuoteLineId: l.sourceQuoteLineId,
          sortOrder: i,
        };
        if (!l.contractLineType) {
          return { ...base, lineType: 'manual' as const, manualQuantity: l.quantity };
        }
        // #3205 W05: the descriptor becomes the contract line's own quantity
        // resolver. The quote's estimated `quantity` is deliberately dropped —
        // the contract counts afresh every period, which is the point.
        const siteScopable = l.contractLineType === 'per_device' || l.contractLineType === 'per_device_role';
        return {
          ...base,
          lineType: l.contractLineType,
          manualQuantity: null,
          deviceRoles: l.contractLineType === 'per_device_role' ? l.deviceRoles : null,
          deviceGroupId: l.contractLineType === 'per_device_group' ? l.deviceGroupId : null,
          siteId: siteScopable ? l.siteId : null,
          // #4693: the contract line inherits the string the customer SIGNED,
          // not a fresh read of a site that may have been renamed since.
          siteName: siteScopable ? l.siteName : null,
          includedQuantity: l.includedQuantity,
          overageMode: l.overageMode,
          overageUnitPrice: l.overageUnitPrice,
        };
      }),
```

`assertSpecRoleLine` (`contractService.ts:223-227`, renamed `assertSpecDeviceSetLine` by W02) gains two rows:

```ts
  if ((line.lineType === 'per_device' || line.lineType === 'per_device_role') && line.siteName && !line.siteId) {
    throw new ContractServiceError('site-scoped line requires siteId', 400, 'INVALID_STATE');
  }
```

`createContractWithLinesDetailed` is otherwise unchanged — W02's `assertGroupInOrg` and W01's `assertSiteInOrg` already run there, and Task 2 already made the site writer prefer an inherited `l.siteName` over the live name.

- [ ] **Step 3: Implement `assertQuoteLinesAcceptable` with the `FOR SHARE` locks**

In `quoteAcceptService.ts`, extend the line read (`:131-137`) and add the guard immediately beside `assertContractRenderDataComplete` (`:147`) — **before the hash, before `provider.capture()`, before any insert**:

```ts
/**
 * #3205 W05. A device-set line whose group or site was deleted carries a
 * stamped NAME and a NULL id. Accepting it would either fail deep inside
 * contract creation (group) or silently build an ORG-WIDE contract line from a
 * site-scoped quote (site). Refuse the whole accept here — before the hash,
 * before provider.capture, before any insert — so nothing is written.
 *
 * Aborting the WHOLE accept (not just the line) is right: the customer is
 * signing one document at one total, and dropping a line would change the price
 * they agreed to.
 *
 * The message is customer-safe: the accept path is unauthenticated and the
 * error reaches the person clicking Accept. The identifying detail rides in
 * `meta` for the operator's log and Sentry.
 */
const QUOTE_LINE_REFERENCE_DELETED_MESSAGE =
  'This quote can no longer be accepted — one of the device sets it prices no longer exists. Please contact your provider for an updated quote.';

/** The subset of a quote_lines row this guard reads. The two ids are mutable
 *  here because the FOR SHARE re-read above nulls one that did not come back —
 *  "the row is not ours / is gone" and "the FK already nulled it" are the same
 *  state and must be reported the same way. */
interface AcceptableQuoteLine {
  id: string;
  contractLineType: string | null;
  deviceGroupId: string | null; deviceGroupName: string | null;
  siteId: string | null; siteName: string | null;
}

function assertQuoteLinesAcceptable(lines: readonly AcceptableQuoteLine[]): void {
  for (const l of lines) {
    if (!l.contractLineType) continue;
    if (l.deviceGroupName !== null && l.deviceGroupId === null) {
      throw new QuoteServiceError(QUOTE_LINE_REFERENCE_DELETED_MESSAGE, 409, 'QUOTE_LINE_REFERENCE_DELETED',
        { quoteLineId: l.id, reference: 'device_group', name: l.deviceGroupName });
    }
    if (l.siteName !== null && l.siteId === null) {
      throw new QuoteServiceError(QUOTE_LINE_REFERENCE_DELETED_MESSAGE, 409, 'QUOTE_LINE_REFERENCE_DELETED',
        { quoteLineId: l.id, reference: 'site', name: l.siteName });
    }
  }
}
```

The guard alone is only a snapshot, so the same statement that re-reads the referenced rows **locks** them, immediately before the guard call:

```ts
  // #3205 W05 decision 10. The stamps tell us what the line REFERENCES; these
  // reads tell us the rows still exist, and FOR SHARE keeps them existing until
  // COMMIT. Both predicates are org-scoped, so a forged id from another tenant
  // simply does not come back and is reported as deleted.
  //
  // FOR SHARE is the correct strength: acceptance does not modify these rows, it
  // only needs them to still exist. Its counterpart is deleteDeviceGroup's
  // FOR UPDATE (W02) — mutually exclusive, so a concurrent delete either WAITS
  // for this accept to commit and then finds the quote converted, or it WINS and
  // this lock request blocks until it commits, at which point the read below
  // comes back empty and the accept fails cleanly, before provider.capture().
  // Lock order is quote row (already held, :80) → device_groups / sites, which
  // is strictly deeper than deleteDeviceGroup's group-then-contract order and
  // shares no cycle with it.
  const setLines = lines.filter((l) => l.contractLineType !== null);
  if (setLines.length > 0) {
    const groupIds = [...new Set(setLines.map((l) => l.deviceGroupId).filter((v): v is string => !!v))];
    const siteIds = [...new Set(setLines.map((l) => l.siteId).filter((v): v is string => !!v))];
    const liveGroups = groupIds.length === 0 ? [] : await db.select({ id: deviceGroups.id })
      .from(deviceGroups).where(and(inArray(deviceGroups.id, groupIds), eq(deviceGroups.orgId, quote.orgId))).for('share');
    const liveSites = siteIds.length === 0 ? [] : await db.select({ id: sites.id })
      .from(sites).where(and(inArray(sites.id, siteIds), eq(sites.orgId, quote.orgId))).for('share');
    const liveGroupIds = new Set(liveGroups.map((g) => g.id));
    const liveSiteIds = new Set(liveSites.map((s) => s.id));
    // Treat "the id is set but the row did not come back" exactly like the
    // stamped-orphan state below: deleted, or never ours.
    for (const l of setLines) {
      if (l.deviceGroupId && !liveGroupIds.has(l.deviceGroupId)) { l.deviceGroupId = null; }
      if (l.siteId && !liveSiteIds.has(l.siteId)) { l.siteId = null; }
    }
  }
  assertQuoteLinesAcceptable(lines);
```

`QuoteServiceErrorCode` already gained `'QUOTE_LINE_REFERENCE_DELETED'` in Task 6.

- [ ] **Step 4: Write the acceptance integration suite**

Red first, case by case: write each numbered case below and watch it fail before wiring the behaviour it names. Cases 1-3 fail on the mapper before Step 2, cases 5-7 on the guard before Step 3; case 4 and case 8 must be **observed failing** by temporarily reverting the mapper's `manualQuantity: null`, or they are confirming rather than discriminating.

Create `apps/api/src/__tests__/integration/quoteAcceptDeviceSet.integration.test.ts` covering:

1. **Each of the four types** produces the matching contract line with roles/group/site/allowance carried, `manual_quantity IS NULL`, `catalog_item_id IS NULL` and the frozen `unit_price`.
2. The contract writer **re-stamps `device_group_name` from the live group** while `site_name` is **inherited verbatim from the quote line** — rename the site between send and accept and assert the contract line carries the **quote's** string and the **live** `site_id`, proving the customer-signed name wins (#4693).
3. A non-descriptor recurring line still becomes `manual` with `manualQuantity = quantity`; a one-time line still becomes an invoice line.
4. **The end-to-end claim of the whole wave:** the first generated invoice on the resulting contract bills the **live** count, not the quote's estimate. Seed the quote at 2 devices, enrol a third before generation, assert the invoice line quantity is 3.
5. An orphaned **group** line and an orphaned **site** line each abort with 409 `QUOTE_LINE_REFERENCE_DELETED` and leave **no `quote_acceptances` row, no invoice, no contract, and the quote still `sent`**; the message contains no group or site name (assert `expect(err.message).not.toContain(groupName)`).
6. **Race, decision 10, two connections.** With a `provider.capture()` spy: (a) start an acceptance that has taken its `FOR SHARE` locks and pause before commit, then issue `deleteDeviceGroup` on a referenced group from a second connection — the delete must **block**, and after the acceptance commits it must either find the quote converted or be refused; (b) run it the other way (delete commits first) and assert the acceptance fails with `QUOTE_LINE_REFERENCE_DELETED` **before `provider.capture()` is called** (`expect(captureSpy).not.toHaveBeenCalled()`) and writes nothing.
7. A **forged** group id from another org is treated as deleted, not as found.
8. **W05 × W07 seam:** a contract line created by quote acceptance is an **ordinary** contract line. Generate an invoice on such a contract and assert the same `source_type` / `source_id` / `source_contract_id` lineage, the same allowance split and the same coverage warning as one built by `addContractLineToContract`. W07 writes its per-invoice evidence off these fields and must not need a quote-acceptance special case; this test is the pin that says so.

- [ ] **Step 5: Run and commit**

```bash
cd apps/api && npx vitest run src/services/quoteToContract src/services/quoteAcceptService && \
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/quoteAcceptDeviceSet.integration.test.ts \
  src/__tests__/integration/contractLineAllowance.integration.test.ts
```
Expected: PASS.

```bash
git add apps/api/src/services/quoteToContract.ts apps/api/src/services/quoteToContract.test.ts \
  apps/api/src/services/quoteAcceptService.ts apps/api/src/services/contractService.ts \
  apps/api/src/__tests__/integration/quoteAcceptDeviceSet.integration.test.ts
git commit -m "feat(billing): accept a device-set quote into an auto-quantity contract line, with FOR SHARE locks and a pre-capture refusal (#3205 W05)"
```

---

### Task 10: `QUOTED_BY_QUOTES` — service, both routes, the AI tool, the Device Groups modal, eight locales

**Files:**
- Modify: `apps/api/src/services/deviceGroupDelete.ts` (W02's), `apps/api/src/__tests__/integration/deviceGroupDelete.integration.test.ts`
- Modify: `apps/api/src/routes/groups.ts` (delete handler), `apps/api/src/routes/devices/groups.ts` (delete handler), `apps/api/src/services/aiToolsFleet.ts` (`manage_groups` delete)
- Modify: `apps/api/src/routes/groups_update_delete.test.ts`, the `routes/devices/groups*` delete tests, `aiToolsFleet*` tests
- Modify: `apps/web/src/components/devices/DeviceGroupsPage.tsx` (+ `DeviceGroupsPage.staticGroups.test.tsx`)
- Modify: `apps/web/src/locales/*/devices.json` (8 files)

**Interfaces:**

```ts
export type DeviceGroupDeleteCode = 'NOT_FOUND' | 'HAS_CHILDREN' | 'BILLED_BY_CONTRACTS' | 'QUOTED_BY_QUOTES';
export class DeviceGroupDeleteError extends Error {
  code: DeviceGroupDeleteCode;
  contracts?: Array<{ id: string; name: string; status: string }>;
  quotes?: Array<{ id: string; quoteNumber: string | null; status: string }>;
  get contractCount(): number | undefined;
  get quoteCount(): number | undefined;
}
export async function listQuotesPricingGroup(executor, groupId: string):
  Promise<Array<{ id: string; quoteNumber: string | null; status: string }>>;   // draft | sent | viewed only
// Routes: 409 { error, code: 'GROUP_IN_USE_BY_QUOTES', quoteCount, quotes? }
```

**Why this ships end to end (decision 23):** a backend-only refusal produces a modal that says "Failed to delete group" and discards the reason — the exact defect W02 called out and fixed for its own 409. Half of this is not optional polish: the message *is* the feature, because the operator's only way out is to find the quote and edit the line.

- [ ] **Step 1: Write the failing service tests**

Append to `apps/api/src/__tests__/integration/deviceGroupDelete.integration.test.ts` (reusing W02's `seed` and adding a `quoteWithGroupLine` helper that inserts a quote in the given status plus a `per_device_group` line naming the group):

```ts
describe('deleteDeviceGroup — quoted groups (#3205 W05)', () => {
  // A live quote prices this group; the operator's only fix is to edit the quote.
  runDb.each(['draft', 'sent', 'viewed'])('refuses while a %s quote prices the group', async (status) => {
    const f = await seed();
    const quoteId = await quoteWithGroupLine(f, status);
    await expect(withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId))).rejects.toMatchObject({
      name: 'DeviceGroupDeleteError', code: 'QUOTED_BY_QUOTES', quoteCount: 1,
      quotes: [expect.objectContaining({ id: quoteId, status })],
    });
  });

  // Terminal quotes are HISTORY: their lines keep the stamp when the FK nulls
  // the id, and a converted quote's contract line is already guarded by W02.
  runDb.each(['accepted', 'declined', 'expired', 'converted', 'superseded'])(
    'deletes when only a %s quote references it, and the line keeps its stamp', async (status) => {
      const f = await seed();
      const quoteId = await quoteWithGroupLine(f, status);
      await withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId));
      const [line] = await withSystemDbAccessContext(() =>
        db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId)));
      expect(line).toMatchObject({ deviceGroupId: null, deviceGroupName: 'VIP' });
    });

  // The operator has to visit two different places, so the two counts are never
  // collapsed into one number.
  runDb('reports BOTH refusals when a contract and a quote each hold the group', async () => {
    const f = await seed();
    await contractWithGroupLine(f, 'active');
    await quoteWithGroupLine(f, 'sent');
    await expect(withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId)))
      .rejects.toMatchObject({ code: 'BILLED_BY_CONTRACTS', contractCount: 1, quoteCount: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement the service**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceGroupDelete.integration.test.ts` — FAIL (the delete succeeds).

In `apps/api/src/services/deviceGroupDelete.ts`:

```ts
export type DeviceGroupDeleteCode = 'NOT_FOUND' | 'HAS_CHILDREN' | 'BILLED_BY_CONTRACTS' | 'QUOTED_BY_QUOTES';

/** Quotes that still PRICE the group. Accepted, declined, expired, converted
 *  and superseded quotes do NOT block: their lines are historical, the stamp
 *  survives the FK's SET NULL, and a converted quote's contract line is already
 *  guarded by BILLED_BY_CONTRACTS. */
const QUOTE_BLOCKING_STATUSES = ['draft', 'sent', 'viewed'] as const;

export async function listQuotesPricingGroup(executor: Executor, groupId: string) {
  return executor
    .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, status: quotes.status })
    .from(quoteLines)
    .innerJoin(quotes, eq(quotes.id, quoteLines.quoteId))
    .where(and(eq(quoteLines.deviceGroupId, groupId), inArray(quotes.status, [...QUOTE_BLOCKING_STATUSES] as never)))
    .groupBy(quotes.id, quotes.quoteNumber, quotes.status)
    .orderBy(quotes.quoteNumber);
}
```

In `deleteDeviceGroup`, immediately after the contract check and **inside** the same `FOR UPDATE` transaction (which is what makes both checks race-safe — a concurrent line insert takes `FOR KEY SHARE` on the group row via its composite FK, so one side waits and the loser fails cleanly):

```ts
    const quoted = await listQuotesPricingGroup(tx, groupId);
    // Report contracts FIRST, then quotes, and never collapse them: the two
    // lists send the operator to two different places.
    if (billing.length > 0 || quoted.length > 0) {
      throw new DeviceGroupDeleteError(
        billing.length > 0 ? 'BILLED_BY_CONTRACTS' : 'QUOTED_BY_QUOTES',
        [
          billing.length > 0 ? `Group is billed by ${billing.length} contract(s); remove those contract lines first` : null,
          quoted.length > 0 ? `Group is priced by ${quoted.length} open quote(s); remove those quote lines first` : null,
        ].filter(Boolean).join('. '),
        billing.length > 0 ? billing.map((b) => ({ id: b.id, name: b.name, status: String(b.status) })) : undefined,
        quoted.length > 0 ? quoted.map((q) => ({ id: q.id, quoteNumber: q.quoteNumber, status: String(q.status) })) : undefined,
      );
    }
```

…widening the constructor and adding `get quoteCount()`. W02's existing `BILLED_BY_CONTRACTS` branch is replaced by this combined one, so its tests keep passing unchanged.

- [ ] **Step 3: Routes and the AI tool**

`routes/groups.ts` and `routes/devices/groups.ts` — extend the existing `DeviceGroupDeleteError` branch. Quote numbers are quote data: disclose them only to a `quotes:read` caller, mirroring W02's `contracts:read` gate.

```ts
        const canReadContracts = !!perms && hasPermission(perms, PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
        const canReadQuotes = !!perms && hasPermission(perms, PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
        return c.json({
          error: err.message,
          code: err.code === 'QUOTED_BY_QUOTES' ? 'GROUP_IN_USE_BY_QUOTES' : 'GROUP_IN_USE_BY_CONTRACTS',
          ...(err.contractCount ? { contractCount: err.contractCount } : {}),
          ...(err.quoteCount ? { quoteCount: err.quoteCount } : {}),
          ...(canReadContracts && err.contracts ? { contracts: err.contracts } : {}),
          ...(canReadQuotes && err.quotes ? { quotes: err.quotes } : {}),
        }, 409);
```

`aiToolsFleet.ts` `manage_groups` `delete` already returns `{ error: err.message, code: err.code }` for a `DeviceGroupDeleteError` (W02), so the new message flows through with no change — assert it in the AI-tool test rather than editing the handler.

Route tests: `DELETE /groups/:id` and `DELETE /devices/groups/:id` both return 409 `GROUP_IN_USE_BY_QUOTES` with `quoteCount`, including `quotes` only for a caller holding `quotes:read` and omitting it otherwise; a body carrying **both** refusals carries both counts.

- [ ] **Step 4: Web — the delete modal**

`DeviceGroupsPage.tsx` `handleConfirmDelete`, extending W02's 409 branch:

```tsx
      if (!response.ok) {
        if (response.status === 409) {
          const body = await response.json().catch(() => null) as {
            contractCount?: number; contracts?: Array<{ name: string }>;
            quoteCount?: number; quotes?: Array<{ quoteNumber: string | null }>;
          } | null;
          const parts: string[] = [];
          if (body?.contractCount) {
            const names = body.contracts?.map((c) => c.name).join(', ');
            parts.push(names
              ? t('deviceGroupsPage.billedByContracts', { count: body.contractCount, names })
              : t('deviceGroupsPage.billedByContractsCount', { count: body.contractCount }));
          }
          if (body?.quoteCount) {
            const numbers = body.quotes?.map((q) => q.quoteNumber).filter(Boolean).join(', ');
            parts.push(numbers
              ? t('deviceGroupsPage.quotedByQuotes', { count: body.quoteCount, names: numbers })
              : t('deviceGroupsPage.quotedByQuotesCount', { count: body.quoteCount }));
          }
          // BOTH sentences when the body carries both — never one merged number.
          if (parts.length > 0) throw new Error(parts.join(' '));
        }
        throw new Error(t('deviceGroupsPage.failedToDeleteGroup'));
      }
```

`DeviceGroupsPage.staticGroups.test.tsx` gains: the modal renders the quote numbers from a 409 body; the count-only variant when the body has no list; **both** sentences when the body carries contracts and quotes; and the generic message for any other failure.

- [ ] **Step 5: Locales (`devices.json`, 8 files)**

| key | en | de-DE | es-419 | fr-CA | fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|---|
| `deviceGroupsPage.quotedByQuotes` | This group is priced by {{count}} open quote(s): {{names}}. Remove those quote lines first. | Diese Gruppe wird von {{count}} offenen Angebot(en) bepreist: {{names}}. Entfernen Sie zuerst diese Angebotspositionen. | Este grupo tiene precio en {{count}} cotización(es) abierta(s): {{names}}. Elimina primero esas líneas de cotización. | Ce groupe est tarifé par {{count}} soumission(s) ouverte(s) : {{names}}. Retirez d'abord ces lignes de soumission. | Ce groupe est tarifé par {{count}} devis ouvert(s) : {{names}}. Supprimez d'abord ces lignes de devis. | Questo gruppo è quotato in {{count}} preventivo/i aperto/i: {{names}}. Rimuovi prima quelle righe di preventivo. | Este grupo é precificado por {{count}} orçamento(s) aberto(s): {{names}}. Remova primeiro essas linhas de orçamento. | Bu grup {{count}} açık teklifte fiyatlandırılıyor: {{names}}. Önce bu teklif satırlarını kaldırın. |
| `deviceGroupsPage.quotedByQuotesCount` | This group is priced by {{count}} open quote(s). Remove those quote lines first. | Diese Gruppe wird von {{count}} offenen Angebot(en) bepreist. Entfernen Sie zuerst diese Angebotspositionen. | Este grupo tiene precio en {{count}} cotización(es) abierta(s). Elimina primero esas líneas de cotización. | Ce groupe est tarifé par {{count}} soumission(s) ouverte(s). Retirez d'abord ces lignes de soumission. | Ce groupe est tarifé par {{count}} devis ouvert(s). Supprimez d'abord ces lignes de devis. | Questo gruppo è quotato in {{count}} preventivo/i aperto/i. Rimuovi prima quelle righe di preventivo. | Este grupo é precificado por {{count}} orçamento(s) aberto(s). Remova primeiro essas linhas de orçamento. | Bu grup {{count}} açık teklifte fiyatlandırılıyor. Önce bu teklif satırlarını kaldırın. |

- [ ] **Step 6: Run and commit**

```bash
cd apps/api && npx vitest run src/routes/groups src/routes/devices/groups src/services/aiToolsFleet && \
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceGroupDelete.integration.test.ts
cd ../web && npx vitest run src/components/devices/DeviceGroupsPage src/lib/i18n
```
Expected: PASS everywhere, including W02's untouched `BILLED_BY_CONTRACTS` cases.

```bash
git add apps/api/src/services/deviceGroupDelete.ts apps/api/src/routes/groups.ts apps/api/src/routes/devices/groups.ts \
  apps/api/src/__tests__/integration/deviceGroupDelete.integration.test.ts apps/api/src/routes/groups_update_delete.test.ts \
  apps/web/src/components/devices/DeviceGroupsPage.tsx apps/web/src/components/devices/DeviceGroupsPage.staticGroups.test.tsx \
  apps/web/src/locales
git commit -m "feat(groups): refuse deleting a device group priced by an open quote, end to end (#3205 W05)"
```

---

### Task 11: Renderers re-keyed on `recurrence`, the customer sentence in all four surfaces, the editor descriptor block, 8 locales

**Files:**
- Modify: `apps/api/src/services/quotePdf.ts:51-54`, `:156-200` (the local `QuoteLine` type), `:317-470` (`renderLineTable`), `:478-486`, `:533-545`, `:560-562` (+ `quotePdf.test.ts`)
- Modify: `apps/web/src/components/billing/quotes/QuoteDocument.tsx:129-224`, `:395-399`, `:528-538`, `:585-605` (+ `QuoteDocument.test.tsx`, new `QuoteDocument.zeroRecurring.test.tsx`)
- Modify: `apps/portal/src/components/portal/quoteBlocks.tsx:26-38`, `:44-149`; `QuoteDetailView.tsx:141-147`, `:261`, `:267`; `PublicQuoteView.tsx:60-61`, `:195`, `:201` (+ their tests)
- Modify: `apps/web/src/components/billing/quotes/quoteTypes.ts:164-202`, `quoteEditorShared.tsx:46-58`, `QuoteBlockCard.tsx:295-309, 763-826`, `QuoteLineRows.tsx:427-533, 534-1618`, `QuoteEditor.tsx` (send/retarget toasts) (+ new `QuoteEditor.deviceSet.test.tsx`)
- Modify: `apps/web/src/locales/*/billing.json` (8 files)

**Interfaces:**

```ts
// quoteTypes.ts — QuoteLine gains
  contractLineType: QuoteDeviceSetType | null;
  deviceRoles: string[] | null;
  deviceGroupId: string | null; deviceGroupName: string | null;
  siteId: string | null; siteName: string | null;
  includedQuantity: string | null;
  overageMode: 'bill' | 'flag' | null; overageUnitPrice: string | null;
  deviceGroup?: { id: string; name: string; type: string } | null;
  site?: { id: string; name: string } | null;
  descriptorUnresolved?: boolean;
// quoteEditorShared.tsx — LineUpdate gains (and NOT contractLineType)
  deviceRoles?: string[]; deviceGroupId?: string; siteId?: string | null;
  includedQuantity?: number | null; overageMode?: 'bill' | 'flag' | null; overageUnitPrice?: number | null;
```

**`LineUpdate` and `updateQuoteLineSchema` must be extended in the same commit** — the schema is now `.strict()`, so a key on one side and not the other 400s the editor. Task 4's table-driven parity test over `LineUpdate`'s key list is the standing guard from here on.

- [ ] **Step 1: Re-key recurring visibility on `recurrence` — write the failing tests FIRST**

Create `apps/web/src/components/billing/quotes/QuoteDocument.zeroRecurring.test.tsx`:

```tsx
/**
 * #3205 W05 decision 21. A device-set line counting ZERO devices is a
 * first-class, expected state (quoting a brand-new customer). But five of the
 * six surfaces that decide whether to show the recurring half of the document
 * infer it from monthlyRecurringTotal > 0 — so a zero-count quote silently drops
 * its recurring section AND the "estimated, billed at actual count" label that
 * explains the zero, leaving a document that looks like the MSP quoted nothing.
 *
 * Only the VISIBILITY tests change. Amounts stay money-derived: a cadence with
 * lines and no money renders 0.00, which is the honest reading.
 */
const zeroQuote = {
  currencyCode: 'USD', subtotal: '0.00', taxTotal: '0.00', total: '0.00',
  oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
  categoryBreakdown: [{ category: 'other', oneTimeTotal: '0.00', monthlyTotal: '0.00', annualTotal: '0.00' }],
};
const zeroLine = {
  id: 'l1', name: 'Servers', description: null, quantity: '0.00', unitPrice: '40.00', lineTotal: '0.00',
  recurrence: 'monthly', taxable: false, customerVisible: true, sortOrder: 0,
  contractLineType: 'per_device_role', deviceRoles: ['server'],
  deviceGroupName: null, siteName: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
};

describe('QuoteDocument with a zero-quantity recurring device-set line', () => {
  it('still renders the recurring summary, the cadence row, the table subtotal and the category row', () => {
    render(<QuoteDocument quote={zeroQuote as never} blocks={[]} lines={[zeroLine as never]} />);
    expect(screen.getByTestId('quote-document-first-period')).toBeInTheDocument();
    expect(screen.getByText(/Monthly recurring/i)).toBeInTheDocument();
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0);
    expect(screen.getByTestId('quote-document-category-other')).toBeInTheDocument();
  });

  // THE WHOLE POINT: the customer must be able to read WHY the number is zero.
  it('renders the estimate sentence', () => {
    render(<QuoteDocument quote={zeroQuote as never} blocks={[]} lines={[zeroLine as never]} />);
    expect(screen.getByText(/Estimated quantity/i)).toBeInTheDocument();
    expect(screen.getByTestId('quote-line-device-set-l1')).toHaveTextContent(/each billing period/i);
  });

  // THE REGRESSION CONTROL: the fix is in the visibility predicate, not in a
  // descriptor special case.
  it('renders identically for a plain manual recurring line at quantity 0', () => {
    const plain = { ...zeroLine, contractLineType: null, deviceRoles: null };
    render(<QuoteDocument quote={zeroQuote as never} blocks={[]} lines={[plain as never]} />);
    expect(screen.getByTestId('quote-document-first-period')).toBeInTheDocument();
    expect(screen.getByText(/Monthly recurring/i)).toBeInTheDocument();
  });
});
```

Add the equivalent assertions to the portal (`QuoteDetailView`, `PublicQuoteView`) and to `quotePdf.test.ts` (text assertion over the rendered buffer). Add to `packages/shared/src/utils/quoteMath.test.ts`: a quote with one one-time line and one **zero-value recurring** device-set line has an unchanged `dueOnAcceptanceTotal`, an unchanged `depositDueTotal`, and `validateQuoteDeposit` still accepts a percent deposit — asserted rather than assumed (`quoteMath.ts:142`, `:158` key on `recurrence === 'one_time'`, so the zero line is already invisible to deposit math).

Run the four suites; expected FAIL on every visibility assertion.

- [ ] **Step 2: Change the seven predicates**

| File | Line | Today | Becomes |
|---|---|---|---|
| `QuoteDocument.tsx` | `:398-399` | `Number(quote.monthlyRecurringTotal) > 0 \|\| Number(quote.annualRecurringTotal) > 0` | `lines.some((l) => l.recurrence !== 'one_time')` |
| `QuoteDocument.tsx` | `:591`, `:597` | per-cadence money `> 0` | `lines.some((l) => l.recurrence === 'monthly' \| 'annual')` |
| `QuoteDocument.tsx` | `:145-147` | `sums.monthly > 0` (`PricingTable` subtotal) | that cadence has a **row in this table** (`sorted.some((l) => l.recurrence === …)`) |
| `QuoteDocument.tsx` | `:532-534` | `Number(b.monthlyTotal) > 0` (category rows) | that category has a line of that cadence |
| `QuoteDetailView.tsx` | `:261`, `:267` | `hasRecurring && money > 0` | `hasRecurring && lineHasCadence(…)` — **`:141-147` already ORs a line test (`lineHasRecurring`) and needs no change** |
| `PublicQuoteView.tsx` | `:60-61`, `:195`, `:201` | money test | the same line test, using the `lineHasRecurring` shape `QuoteDetailView` already has |
| `quotePdf.ts` | `:544-545` (used `:585`, `:655`), `:484-486`, `:560-562` | money test | line test. **`:541-542` already ORs `recurringLines.monthly/annual` and needs no change** |

Amounts stay money-derived. `quotePdf.ts:541-542` and `quoteBlocks.tsx:64-67` (which already groups by `recurrence` and filters on `rows.length > 0`) are the in-repo precedent — the pattern simply was not applied consistently. The server-side `categoryBreakdown` must likewise emit a row for a category whose only line is zero-valued.

- [ ] **Step 3: The customer sentence, one wording, four renderers**

Two sentences, composed only from `CUSTOMER_LINE_FIELDS`, so no renderer needs a new fetch:

- **Always:** *"Estimated quantity — billed at the actual number of {servers | devices in “VIP Laptops” | devices at Dallas | seats} each billing period."*
- **Allowance, `bill`:** *"Includes 25; additional units billed at $12.00 each."*
- **Allowance, `flag`:** *"Includes 25; additional units are reported for review, not billed automatically."*

The set phrase is derived in priority order: `per_device_role` → the role labels (`getDeviceRoleLabel` in web; hardcoded English elsewhere); `per_device_group` → the **stamped** group name; `per_seat` → "seats"; `per_device` → "devices"; a stamped `siteName` appends "at {siteName}".

| Renderer | Where | Localisation |
|---|---|---|
| API PDF | `quotePdf.ts` — a sub-line under the title in `renderLineTable` (beside the blurb at `:441-446`), suffix logic beside `recurrenceSuffix` (`:51-54`) | hardcoded English (the file's existing convention — its rollup labels at `:630-632` are already English-only) |
| Web document preview | `QuoteDocument.tsx` `PricingTable` `:129-224` — an "Est." pill badge on the `:168`/`:180-181` recurrence-badge pattern, plus the sentence in the blurb slot `:184-185`, wrapped in `data-testid={`quote-line-device-set-${l.id}`}` | `quotes.document.deviceSet.*`, 8 locales |
| Portal + public | `apps/portal/src/components/portal/quoteBlocks.tsx` `PricingTable`, after `lineBlurb` (`:115-117`) | hardcoded English (`apps/portal` has no i18n framework; adding one is out of scope) |
| MSP editor | `QuoteLineRows.tsx` `ReadonlyLineRow` `:427-533` / `EditableLineRow` `:534-1618` | `quotes.editor.deviceSet.*`, 8 locales |

The portal quote-line type (feeding `quoteBlocks.tsx`) gains the seven customer fields, read-only — the portal never patches a line.

- [ ] **Step 4: The editor descriptor block**

`QuoteBlockCard.tsx` (the full manual form): when `recurrence !== 'one_time'`, a **"Bill by device set"** toggle revealing a type select (four options), then per type — a role multi-select (`per_device_role`), a group select fetched from `/device-groups?orgId=…&limit=200` with a Static/Dynamic tag (`per_device_group`, the W02 editor pattern), a site select with an "All sites" option (`per_device` / `per_device_role`), and W04's allowance block. The quantity input is **hidden and not sent** while the toggle is on (decision 5). Switching to `one_time` clears the whole descriptor — the mirror of the existing `depositSelectMode && rec === 'one_time'` gate at `QuoteLineRows.tsx:1362-1365`. Submit is disabled with an incomplete descriptor, using the `roleLineMissingRoles` pattern.

`GhostRow` (`QuoteLineRows.tsx:266-425`) is the fast-add path and does **not** grow the descriptor — it has no room and the full form is one click away.

Line rows get a muted sub-label — "Auto quantity · 12 servers · estimated" — plus, when the advisory estimate says the live count differs from the stored one, an amber "count changed: 12 → 15" chip with a **Refresh** button wired to `POST /quotes/:id/lines/refresh-device-counts`. An orphaned reference renders amber "Device group “VIP Laptops” was deleted — pick another" / "Site “Dallas” was deleted — pick another", driven by `descriptorUnresolved`. The type itself is not editable; the row says so.

`QuoteEditor.tsx`: one `warning` toast when `sendQuote`'s `deviceSetDrift` is non-empty, naming the lines; the retarget and retargeted-clone flows raise the same toast for their `reason: 'org_retargeted'` entries, worded for the action.

`QuoteEditor.deviceSet.test.tsx` asserts: the descriptor block appears only for a recurring line; it clears on switching to `one_time`; the quantity input is hidden and **no `quantity` key is sent**; submit is disabled with an incomplete descriptor; the drift chip and the orphan chip render; the send toast fires. `quoteTypes.parity.test.ts` keeps `QuoteLine` in step with the API shape.

- [ ] **Step 5: Locales (`billing.json`, 8 files)**

| key (`quotes.`) | en | de-DE | es-419 | fr-CA | fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|---|
| `document.deviceSet.badge` | Est. | Gesch. | Est. | Est. | Est. | Stima | Est. | Tah. |
| `document.deviceSet.estimate` | Estimated quantity — billed at the actual number of {{set}} each billing period. | Geschätzte Menge — abgerechnet wird die tatsächliche Anzahl {{set}} in jedem Abrechnungszeitraum. | Cantidad estimada: se factura la cantidad real de {{set}} en cada período de facturación. | Quantité estimée — facturée selon le nombre réel de {{set}} à chaque période de facturation. | Quantité estimée — facturée selon le nombre réel de {{set}} à chaque période de facturation. | Quantità stimata — fatturata in base al numero effettivo di {{set}} in ogni periodo di fatturazione. | Quantidade estimada — cobrada pelo número real de {{set}} em cada período de faturamento. | Tahmini miktar — her fatura döneminde gerçek {{set}} sayısı üzerinden faturalandırılır. |
| `document.deviceSet.setDevices` | devices | Geräte | dispositivos | appareils | appareils | dispositivi | dispositivos | cihazlar |
| `document.deviceSet.setSeats` | seats | Benutzerplätze | licencias | postes | postes | postazioni | licenças | kullanıcılar |
| `document.deviceSet.setGroup` | devices in “{{name}}” | Geräte in „{{name}}“ | dispositivos en “{{name}}” | appareils dans « {{name}} » | appareils dans « {{name}} » | dispositivi in “{{name}}” | dispositivos em “{{name}}” | “{{name}}” içindeki cihazlar |
| `document.deviceSet.atSite` | {{set}} at {{site}} | {{set}} am Standort {{site}} | {{set}} en {{site}} | {{set}} au site {{site}} | {{set}} sur le site {{site}} | {{set}} presso {{site}} | {{set}} em {{site}} | {{site}} konumundaki {{set}} |
| `document.deviceSet.allowanceBill` | Includes {{included}}; additional units billed at {{price}} each. | Enthält {{included}}; weitere Einheiten werden mit je {{price}} berechnet. | Incluye {{included}}; las unidades adicionales se facturan a {{price}} cada una. | Comprend {{included}}; les unités supplémentaires sont facturées {{price}} chacune. | Comprend {{included}}; les unités supplémentaires sont facturées {{price}} chacune. | Include {{included}}; le unità aggiuntive sono fatturate a {{price}} ciascuna. | Inclui {{included}}; unidades adicionais são cobradas a {{price}} cada. | {{included}} dahildir; ek birimler beher {{price}} olarak faturalandırılır. |
| `document.deviceSet.allowanceFlag` | Includes {{included}}; additional units are reported for review, not billed automatically. | Enthält {{included}}; weitere Einheiten werden zur Prüfung gemeldet, nicht automatisch berechnet. | Incluye {{included}}; las unidades adicionales se informan para revisión y no se facturan automáticamente. | Comprend {{included}}; les unités supplémentaires sont signalées pour révision, pas facturées automatiquement. | Comprend {{included}}; les unités supplémentaires sont signalées pour révision, pas facturées automatiquement. | Include {{included}}; le unità aggiuntive sono segnalate per revisione, non fatturate automaticamente. | Inclui {{included}}; unidades adicionais são reportadas para revisão, não cobradas automaticamente. | {{included}} dahildir; ek birimler otomatik faturalandırılmaz, inceleme için raporlanır. |
| `editor.deviceSet.toggle` | Bill by device set | Nach Gerätesatz abrechnen | Facturar por conjunto de dispositivos | Facturer par ensemble d'appareils | Facturer par ensemble d'appareils | Fattura per insieme di dispositivi | Cobrar por conjunto de dispositivos | Cihaz grubuna göre faturala |
| `editor.deviceSet.typeLabel` | Device set | Gerätesatz | Conjunto de dispositivos | Ensemble d'appareils | Ensemble d'appareils | Insieme di dispositivi | Conjunto de dispositivos | Cihaz grubu |
| `editor.deviceSet.types.per_device` | Per device | Pro Gerät | Por dispositivo | Par appareil | Par appareil | Per dispositivo | Por dispositivo | Cihaz başına |
| `editor.deviceSet.types.per_device_role` | Per device role | Pro Geräterolle | Por rol de dispositivo | Par rôle d'appareil | Par rôle d'appareil | Per ruolo dispositivo | Por função de dispositivo | Cihaz rolü başına |
| `editor.deviceSet.types.per_device_group` | Per device group | Pro Gerätegruppe | Por grupo de dispositivos | Par groupe d'appareils | Par groupe d'appareils | Per gruppo di dispositivi | Por grupo de dispositivos | Cihaz grubu başına |
| `editor.deviceSet.types.per_seat` | Per seat | Pro Benutzerplatz | Por licencia | Par poste | Par poste | Per postazione | Por licença | Kullanıcı başına |
| `editor.deviceSet.rolesLabel` | Device roles | Geräterollen | Roles de dispositivo | Rôles d'appareil | Rôles d'appareil | Ruoli dispositivo | Funções de dispositivo | Cihaz rolleri |
| `editor.deviceSet.groupLabel` | Device group | Gerätegruppe | Grupo de dispositivos | Groupe d'appareils | Groupe d'appareils | Gruppo di dispositivi | Grupo de dispositivos | Cihaz grubu |
| `editor.deviceSet.siteLabel` | Site (optional) | Standort (optional) | Sitio (opcional) | Site (facultatif) | Site (facultatif) | Sede (facoltativa) | Site (opcional) | Konum (isteğe bağlı) |
| `editor.deviceSet.allSites` | All sites | Alle Standorte | Todos los sitios | Tous les sites | Tous les sites | Tutte le sedi | Todos os sites | Tüm konumlar |
| `editor.deviceSet.quantityAuto` | Quantity is counted automatically | Menge wird automatisch gezählt | La cantidad se cuenta automáticamente | La quantité est comptée automatiquement | La quantité est comptée automatiquement | La quantità viene conteggiata automaticamente | A quantidade é contada automaticamente | Miktar otomatik olarak sayılır |
| `editor.deviceSet.autoSummary` | Auto quantity · {{count}} {{set}} · estimated | Automatische Menge · {{count}} {{set}} · geschätzt | Cantidad automática · {{count}} {{set}} · estimada | Quantité auto · {{count}} {{set}} · estimée | Quantité auto · {{count}} {{set}} · estimée | Quantità automatica · {{count}} {{set}} · stimata | Quantidade automática · {{count}} {{set}} · estimada | Otomatik miktar · {{count}} {{set}} · tahmini |
| `editor.deviceSet.driftChip` | count changed: {{stored}} → {{live}} | Anzahl geändert: {{stored}} → {{live}} | el conteo cambió: {{stored}} → {{live}} | le nombre a changé : {{stored}} → {{live}} | le nombre a changé : {{stored}} → {{live}} | conteggio cambiato: {{stored}} → {{live}} | contagem alterada: {{stored}} → {{live}} | sayı değişti: {{stored}} → {{live}} |
| `editor.deviceSet.refresh` | Refresh counts | Anzahl aktualisieren | Actualizar conteos | Actualiser les nombres | Actualiser les nombres | Aggiorna conteggi | Atualizar contagens | Sayıları yenile |
| `editor.deviceSet.groupDeleted` | Device group “{{name}}” was deleted — pick another | Gerätegruppe „{{name}}“ wurde gelöscht — bitte eine andere wählen | El grupo de dispositivos “{{name}}” fue eliminado: elige otro | Le groupe d'appareils « {{name}} » a été supprimé — choisissez-en un autre | Le groupe d'appareils « {{name}} » a été supprimé — choisissez-en un autre | Il gruppo di dispositivi “{{name}}” è stato eliminato — scegline un altro | O grupo de dispositivos “{{name}}” foi excluído — escolha outro | “{{name}}” cihaz grubu silindi — başka bir tane seçin |
| `editor.deviceSet.siteDeleted` | Site “{{name}}” was deleted — pick another | Standort „{{name}}“ wurde gelöscht — bitte einen anderen wählen | El sitio “{{name}}” fue eliminado: elige otro | Le site « {{name}} » a été supprimé — choisissez-en un autre | Le site « {{name}} » a été supprimé — choisissez-en un autre | La sede “{{name}}” è stata eliminata — scegline un'altra | O site “{{name}}” foi excluído — escolha outro | “{{name}}” konumu silindi — başka bir tane seçin |
| `editor.deviceSet.typeLocked` | A device set cannot be changed after the line is created — remove the line and add it again. | Ein Gerätesatz kann nach dem Anlegen der Position nicht geändert werden — Position entfernen und neu hinzufügen. | Un conjunto de dispositivos no se puede cambiar después de crear la línea: elimina la línea y agrégala de nuevo. | Un ensemble d'appareils ne peut pas être modifié après la création de la ligne — retirez la ligne et ajoutez-la de nouveau. | Un ensemble d'appareils ne peut pas être modifié après la création de la ligne — supprimez la ligne et ajoutez-la à nouveau. | Un insieme di dispositivi non può essere modificato dopo la creazione della riga — rimuovi la riga e aggiungila di nuovo. | Um conjunto de dispositivos não pode ser alterado após a criação da linha — remova a linha e adicione-a novamente. | Cihaz grubu, satır oluşturulduktan sonra değiştirilemez — satırı kaldırıp yeniden ekleyin. |
| `editor.deviceSet.includedLabel` | Included quantity | Enthaltene Menge | Cantidad incluida | Quantité incluse | Quantité incluse | Quantità inclusa | Quantidade incluída | Dahil miktar |
| `editor.deviceSet.overageModeLabel` | Above the allowance | Über dem Kontingent | Por encima del límite incluido | Au-delà du forfait | Au-delà du forfait | Oltre la soglia inclusa | Acima da franquia | Dahil miktarın üstü |
| `editor.deviceSet.overageBill` | Bill each extra unit | Jede zusätzliche Einheit berechnen | Facturar cada unidad adicional | Facturer chaque unité supplémentaire | Facturer chaque unité supplémentaire | Fattura ogni unità aggiuntiva | Cobrar cada unidade adicional | Her ek birimi faturala |
| `editor.deviceSet.overageFlag` | Report for review | Zur Prüfung melden | Informar para revisión | Signaler pour révision | Signaler pour révision | Segnala per revisione | Reportar para revisão | İnceleme için raporla |
| `editor.deviceSet.overagePriceLabel` | Overage price | Preis für Zusatzeinheiten | Precio por excedente | Prix des unités supplémentaires | Prix des unités supplémentaires | Prezzo eccedenza | Preço de excedente | Aşım fiyatı |
| `editor.deviceSet.driftToast` | {{count}} line(s) no longer match the live device count: {{lines}} | {{count}} Position(en) entsprechen nicht mehr der aktuellen Geräteanzahl: {{lines}} | {{count}} línea(s) ya no coinciden con el conteo actual de dispositivos: {{lines}} | {{count}} ligne(s) ne correspondent plus au nombre d'appareils actuel : {{lines}} | {{count}} ligne(s) ne correspondent plus au nombre d'appareils actuel : {{lines}} | {{count}} riga/righe non corrispondono più al conteggio dispositivi attuale: {{lines}} | {{count}} linha(s) não correspondem mais à contagem atual de dispositivos: {{lines}} | {{count}} satır artık güncel cihaz sayısıyla eşleşmiyor: {{lines}} |
| `editor.deviceSet.retargetToast` | {{count}} line(s) need a device group or site re-picked for this organization | {{count}} Position(en) benötigen eine neu gewählte Gerätegruppe oder einen Standort für diese Organisation | {{count}} línea(s) necesitan que se vuelva a elegir un grupo de dispositivos o sitio para esta organización | {{count}} ligne(s) nécessitent de resélectionner un groupe d'appareils ou un site pour cette organisation | {{count}} ligne(s) nécessitent de resélectionner un groupe d'appareils ou un site pour cette organisation | {{count}} riga/righe richiedono di riselezionare un gruppo di dispositivi o una sede per questa organizzazione | {{count}} linha(s) precisam que um grupo de dispositivos ou site seja escolhido novamente para esta organização | {{count}} satır için bu kuruluşa ait cihaz grubu veya konum yeniden seçilmeli |

- [ ] **Step 6: Run everything web + PDF, then commit**

```bash
cd apps/api && npx vitest run src/services/quotePdf
cd ../web && npx vitest run src/components/billing/quotes src/lib/i18n && npx tsc --noEmit -p tsconfig.json 2>&1 | head
cd ../portal && npx vitest run src/components/portal && npx tsc --noEmit -p tsconfig.json 2>&1 | head
cd ../../packages/shared && npx vitest run src/utils/quoteMath.test.ts
```
Expected: PASS everywhere, `localeParity.test.ts` included (`tr-TR` is part of this change, not a follow-up).

```bash
git add apps/api/src/services/quotePdf.ts apps/api/src/services/quotePdf.test.ts \
  apps/web/src/components/billing/quotes apps/web/src/locales \
  apps/portal/src/components/portal packages/shared/src/utils/quoteMath.test.ts
git commit -m "feat(web,portal,pdf): render device-set quote lines as an estimate and key recurring visibility on recurrence (#3205 W05)"
```

---

### Task 12: Docs and the release-notes draft

**Files:**
- Modify: `apps/docs/src/content/docs/features/quotes.mdx`
- Modify: `apps/docs/src/content/docs/features/contracts.mdx`
- Create: `docs/superpowers/release-notes/2026-09-03-device-set-quote-lines.md` (draft section for the next release write-up)

- [ ] **Step 1: `quotes.mdx` — a "Quoting by device set" section**

```md
## Quoting by device set

A **recurring** quote line can price a live device count instead of a fixed number. Turn on **Bill by device set** on a monthly or annual line and pick one of four:

| Device set | Bills |
|---|---|
| Per device | Every device on the organization, optionally narrowed to one site |
| Per device role | Only devices with the roles you choose (servers, workstations, firewalls…), optionally narrowed to one site |
| Per device group | The members of one device group. Dynamic groups are evaluated live |
| Per seat | The organization's active users |

The quantity is counted by Breeze, not typed in — the quantity box disappears while a device set is on. Any of the four can also carry an **included quantity**: the line then bills that quantity every period even when the live count is lower, and you choose whether the units above it are billed at a separate rate or just reported for review.

**The number on the quote is an estimate**, and the customer's document says so on every line ("Estimated quantity — billed at the actual number of servers each billing period"). A brand-new customer with nothing enrolled yet quotes at zero, and the document still shows the line and the explanation — that is the point.

Counts refresh when you add or edit the line, and when you press **Refresh counts**. They deliberately do **not** refresh when the quote is sent or accepted: sending reports which lines have drifted and leaves the numbers alone, so a scheduled send can never reprice a document you already approved.

A device set cannot be added to a one-time line or to a component of a bundle, and it cannot be changed after the line is created — remove the line and add it again. A device group that an open (draft, sent or viewed) quote prices cannot be deleted until that line is removed.

Accepting the quote creates a contract line of the matching type, with the price frozen at what the customer signed. From then on the contract counts for itself every billing period.
```

- [ ] **Step 2: `contracts.mdx` — acceptance and the deleted-site note**

In the quote-acceptance section, one sentence: *"A recurring quote line that bills a device set becomes a contract line of the matching type (per device, per device role, per device group or per seat) instead of a fixed-quantity line, with the accepted unit price frozen — so the contract bills the actual count every period."*

Then a short note:

```md
### If a site is deleted

A contract line scoped to a site records the site's name as well as its id. If that site is deleted, the line **stops billing and says so** — the contract detail shows "site deleted" and generating an invoice refuses with a named error — rather than quietly falling back to billing every device in the organization. Re-scope the line to another site, or remove it, and generation resumes.

Lines whose site was deleted *before* this behaviour shipped cannot be recovered: their site name was never recorded, so they are indistinguishable from a line that was always organization-wide.
```

- [ ] **Step 3: Release-notes draft**

Write `docs/superpowers/release-notes/2026-09-03-device-set-quote-lines.md` with a billing section covering:

- device-set quote lines (what they are, that the quantity is an estimate labelled on the customer document, that acceptance produces an auto-quantity contract line with the price frozen);
- **the #4693 behaviour change, explicitly**: from this release a site deletion makes site-scoped contract lines refuse generation (409 `SITE_DELETED`) instead of silently billing the whole organization. That is *louder* than today — an operator who deletes a site under an active contract now gets a failed generation and a Sentry report where they previously got an inflated invoice nobody noticed;
- **its residual**: lines whose site was deleted *before* this release stay ambiguous and keep billing org-wide, because the deleted site's name is unrecoverable. Operators who suspect an affected contract can find it by looking for a `per_device` line with no site on a contract that used to have one. The migration's `RAISE WARNING` row count records how many lines *were* protected;
- a device group priced by an open quote can no longer be deleted until the quote line is removed;
- `PATCH /quotes/:id/lines/:lineId` now rejects an unrecognised key with a 400 instead of accepting it and changing nothing (affects direct API/AI clients only);
- no feature flag, no backfill of acceptance hashes: `quote_acceptances.hash_version` defaults to `1`, so every signature already on file keeps verifying under the exact algorithm that produced it.

- [ ] **Step 4: Build and commit**

Run: `cd apps/docs && pnpm build 2>&1 | tail -3`
Expected: build succeeds.

```bash
git add apps/docs/src/content/docs/features/quotes.mdx apps/docs/src/content/docs/features/contracts.mdx \
  docs/superpowers/release-notes/2026-09-03-device-set-quote-lines.md
git commit -m "docs(billing): quoting by device set, and the deleted-site behaviour change (#3205 W05, #4693)"
```

---

### Task 13: Full verification and pull request

**Files:** none new.

- [ ] **Step 1: Full local verification on a fresh test stack**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd ../web && npx tsc --noEmit -p tsconfig.json
cd ../portal && npx tsc --noEmit -p tsconfig.json
cd ../../packages/shared && npx tsc --noEmit -p tsconfig.json
cd ../.. && pnpm lint
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
pnpm --filter @breeze/portal test --run

# fresh DB — the migrations must apply from empty, in order
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
cd apps/api && pnpm db:migrate && pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractLinesSiteStampConstraints.integration.test.ts \
  src/__tests__/integration/contractLineSiteDeleted.integration.test.ts \
  src/__tests__/integration/quoteLinesDeviceSetConstraints.integration.test.ts \
  src/__tests__/integration/quoteDeviceSetCounts.integration.test.ts \
  src/__tests__/integration/quoteDeviceSetOrgRetarget.integration.test.ts \
  src/__tests__/integration/quoteAcceptDeviceSet.integration.test.ts \
  src/__tests__/integration/deviceGroupDelete.integration.test.ts \
  src/__tests__/integration/contractDeviceGroups.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/contractQuantities.integration.test.ts \
  src/__tests__/integration/contractLineAllowance.integration.test.ts \
  src/__tests__/integration/orgMerge.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
npx vitest run --config vitest.config.rls.ts
```
Expected: all green. Watch the `db:migrate` output for the `#4693` `RAISE WARNING` row count.

- [ ] **Step 2: The manual checks from the spec's Testing section**

As `breeze_app` in psql: insert a `one_time` line with a `contract_line_type`, a `flat` descriptor line, and a `per_device` line with a `site_id` and no `site_name` — all three must fail on `quote_lines_device_set_chk`.

Then, in the UI: quote a brand-new org with zero devices (expect a `$0.00` line **with the estimate label and the recurring section still rendered**), enrol two servers, **Refresh counts**, send, accept, and confirm the contract's first generated invoice bills **two** — not the number on the quote.

Then, for #4693: scope a contract line to a site, delete the site, and confirm the contract detail shows "site deleted" and that **Generate** refuses with a named error instead of invoicing the whole org.

- [ ] **Step 3: Tear down the test stack, push, open the PR**

```bash
git push -u origin feature/3205-quote-lines/wave-4654
gh pr create --repo LanternOps/breeze --base main --title "feat(billing): device-set quote lines and contract-line site stamp (#3205 W05, #4693)" --body "$(cat <<'EOF'
Closes #4654
Closes #4693
Refs #3205

Spec: `docs/superpowers/specs/billing/2026-09-03-device-set-quote-lines-design.md`
Plan: `docs/superpowers/plans/billing/2026-09-03-device-set-quote-lines.md`

## What

- A **recurring** quote line can now carry the same device-set descriptor a contract line has — `per_device`, `per_device_role`, `per_device_group` or `per_seat`, optionally site-scoped, optionally with an included quantity + overage mode. The quantity is **derived server-side** from the same snapshot helpers that will bill it, may legitimately be **0** (the brand-new-customer case), and the client may not supply it.
- The customer's document labels it as an estimate on every surface — web preview, portal, public link and PDF — and "is there recurring content" is now keyed on `recurrence` instead of on money, so a zero-count quote no longer silently drops its entire recurring section *and* the sentence that explains the zero.
- **Acceptance maps a descriptor line to the matching auto-quantity contract line** with the price frozen (`manual_quantity NULL`, `catalog_item_id NULL`); every other recurring line still becomes `manual`. Referenced groups/sites are locked `FOR SHARE` and a deleted reference aborts the accept with a customer-safe 409 **before the hash, before `provider.capture()`, before any write**.
- The acceptance hash is **versioned**: `quote_acceptances.hash_version` defaults to `1`, `v1` is byte-for-byte the pre-W05 function, and `v2` covers the descriptor by its **stamped values only** — never the FK-nullable ids, so a legitimate group deletion can never report as tampering.
- Deleting a device group priced by a draft/sent/viewed quote is refused (`QUOTED_BY_QUOTES`) across the service, both routes, the AI tool and the Device Groups modal, in eight locales.
- **#4693 (fixed here):** `contract_lines.site_name` is stamped by every writer and backfilled from `sites`, so a deleted site is now distinguishable from "never had a site". `resolveLineQty` reports `unresolved: 'site_deleted'` and `generateDueInvoice` refuses 409 `SITE_DELETED` **before writing anything**, instead of silently billing every device in the organization forever.

## Migrations

- `2026-10-08-100000-contract-lines-site-stamp.sql` — `site_name`, a system-scoped backfill from `sites` with a logged row count, a **total** `contract_lines_site_stamp_chk`, and the re-added group CHECK widened to forbid a stray site stamp.
- `2026-10-08-100100-quote-lines-device-set.sql` — nine nullable `quote_lines` columns reusing the contract enums, a total NULL-safe CHECK, an org/quote preflight that raises on a pre-existing tenancy fault, three `DEFERRABLE INITIALLY IMMEDIATE` composite FKs, a partial index, and `quote_acceptances.hash_version`.

## Behaviour changes for existing data

1. **#4693 changes how existing contracts bill.** A site deletion now makes site-scoped lines refuse generation instead of quietly billing the whole org — a *louder*, recoverable failure. Residual: lines whose site was deleted **before** this release stay ambiguous and keep billing org-wide, because the name is unrecoverable. Named in the release note.
2. A device group priced by an open quote becomes undeletable until that line is removed.
3. `updateQuoteLineSchema` is `.strict()`: a quote-line PATCH with an unrecognised key is a 400 instead of a 200 that changed nothing. Verified to affect no product caller — the sole web caller is typed by the closed `LineUpdate` union.

No feature flag. Every existing quote line has `contract_line_type IS NULL`, takes the CHECK's first branch, projects identically to the customer, and accepts into a `manual` contract line exactly as today.

## Tests

Shared validators by delegation (a fixture failing `contractLineInvariantIssues` must fail identically here) plus the `QUOTE_DEVICE_SET_TYPES == ALLOWANCE_LINE_TYPES` tripwire and the `LineUpdate` key-list guard; real-DB CHECK/FK/deferrable truth tables for both tables incl. the single-non-NULL matrix; the #4693 headline regression **with the never-had-a-site control**; snapshot-extraction parity via W02's untouched suites; per-line degradation and the W04 allowance boundary rows on the quote side; the org retarget (which is a 23503 without the named deferral) with unscoped-re-derive vs scoped-cleared asserted separately; hash versioning pinned to a literal pre-W05 hex, in both verification directions; acceptance for all four types, the frozen price, the inherited `site_name`, the first invoice billing the live count, and **both** delete/accept race interleavings with a `provider.capture()` spy; group-delete refusal at every layer; zero-quantity rendering on all four renderers plus the plain-manual control; export policy and the erasure round-trip; org merge; the W05×W07 seam.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AXFWi7tAV9LWM2UCNMPrpZ
EOF
)"
```

Stop here. Do not merge. Report the PR URL and anything that was skipped or failed.

---

## Spec coverage

Every requirement in the spec maps to a task. Recorded so a reviewer can check the mapping rather than re-derive it.

| Spec decision / section | Task |
|---|---|
| 1, 2 — nine columns, `contract_line_type IS NULL` is the switch | 3 |
| 3 — recurring, non-bundle-child, enforced in SQL + the `→ one_time` 400 | 3 (CHECK), 4 (validator), 6 (service 400) |
| 4 — both stamps | 3 (CHECK), 6 (writers), 11 (rendering) |
| 5 — quantity server-derived, may be 0, outside the pure invariants | 4 (create schema), 6 (service patch rule), 5 (derivation), 11 (zero rendering) |
| 6 — refresh moments | 6 (add/patch/explicit), 7 (retarget/clone), 7 (never on send), 9 (never on accept) |
| 7 — retarget split + named deferral | 7 |
| 8 — versioned hash | 8 |
| 9 — acceptance mapping, frozen price | 9 |
| 10 — `assertQuoteLinesAcceptable` + `FOR SHARE` | 9 |
| 11 — `QUOTED_BY_QUOTES` | 10 |
| 12 — send reports drift | 7 |
| 13 — one estimator, `buildOrgDeviceSnapshot` extraction | 5 |
| 14 — validator delegates | 4 |
| 15 — type not patchable, rest is | 4 (schema), 6 (service) |
| 16 — `overage_unit_price` representability + currency lock | 6, 7 |
| 17 — `CUSTOMER_LINE_FIELDS` | 7 |
| 18 — registration lists (export policy only) | 1, 3 |
| 19, 22 — #4693 stamp, precedence | 1, 2, 9 |
| 20 — `.strict()` | 4 |
| 21 — renderers keyed on `recurrence` | 11 |
| 23 — `QUOTED_BY_QUOTES` end to end | 10 |
| Routes (`refresh-device-counts`, `device-set-estimate`, send response) | 6, 7 |
| AI tools (`manage_quotes`, `manage_groups`) | 6, 10 |
| Docs + release notes | 12 |
| Manual checks + full verification | 13 |

**Deliberate deviations from the spec, both recorded in Global Constraints:**

1. **Two migration files instead of one.** The spec's "one file" argument is only that no `ALTER TYPE … ADD VALUE` split is needed. Splitting the #4693 contract stamp (`2026-10-08-100000`) from the quote schema (`2026-10-08-100100`) lets Task 1 land and be reverted independently, and is the same same-date time-component pattern W02 uses. Ordering and idempotency are unaffected.
2. **`QuoteDetailView.tsx:141-147` and `quotePdf.ts:541-542` already OR a line-presence test** and are left alone; the spec's table lists them among the seven predicates to change. Only the per-cadence rows below them are money-gated and get the fix. Task 11's table records this per file.

**One value must be measured, not written from the spec:** the pinned pre-W05 hash hex in Task 8, Step 1. The command that produces it is given; paste the output into the test.

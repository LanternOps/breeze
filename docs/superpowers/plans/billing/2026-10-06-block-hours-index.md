---
spec: docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md
tracking_issue: LanternOps/breeze#4547
blast_radius: high (billing money paths, a new tenant table, row locks on time_entries)
---

# Block Hours — Program Index

Four waves implement the approved block-hours spec (Gate A 2026-09-02, amended 2026-09-19 by the
billing-profiles spec #4628 §5, and amended again at plan time — §"Plan-time amendments" in the
spec, summarised in "Spec deltas" below). **Every wave plan obeys this index.** Where a wave plan and
this index disagree, the index wins. Cross-wave names, types, SQL names and signatures are fixed here
so the four plans compose. A wave plan may **add** private helpers; it must not rename, re-type or
re-home anything below.

All line numbers were verified against `origin/main` @ `9b9f3fc28d` (2026-10-05).

## Waves

| Wave | Plan | Depends on | Migrations | Ships (user-visible) | Blast radius | Model tier (impl / review) |
|---|---|---|---|---|---|---|
| W01 Foundation | `2026-10-06-block-hours-w01-foundation.md` | — | 4 (`2026-12-14-1000NN-`) | nothing — schema, tenancy, registrations, fail-closed type plumbing | **high** (new tenant table, RLS, composite FKs, cascade/export/merge lists, a CHECK rewrite on `contract_lines`) | Sonnet / Opus |
| W02 Drawdown engine | `2026-10-06-block-hours-w02-drawdown-engine.md` | W01 merged | none | nothing — no API can create a block line yet; engine proven by integration tests over fixture rows | **high** (row locks on `time_entries` inside the billing transaction, invoice money, terminal-status guard, org-move refusals) | Opus / Opus |
| W03 Lines + contract UI | `2026-10-06-block-hours-w03-lines-and-contract-ui.md` | W02 merged | none | **feature opens**: MSP can add/edit/retire an `hour_block` line; estimate + contract detail show the live balance | high (opens money path; validators; AI tool surface) | Sonnet / Opus |
| W04 Portal, alerts, docs | `2026-10-06-block-hours-w04-portal-alerts-docs.md` | W03 merged | 1 (`2026-12-14-1300NN-`) | customer portal "Support hours" card (fail-closed flag), threshold alerts, docs + release notes | medium (portal read path in system context; a new `portal_branding` column) | Sonnet / Sonnet |

**Why the feature opens in W03, not W02.** Creating an `hour_block` line before both close paths
(billing-path close **and** the close-out sweep for expiry/cancel/retire) exist would let a contract
end with drawn-down hours stranded `not_billed`, which then bill ad hoc — spec Decision 6 option C,
which "must not ship". W02 therefore lands the whole engine behind a validator that cannot produce a
block line; W03 flips the validator.

**Why W01 ships nothing.** Adding `'hour_block'` to `contract_line_type` turns two `never` switches
into compile errors (`resolveLineQty` `contractService.ts:674-708`, `generateDueInvoice`
`contractService.ts:2101-2124`). W01 makes both explicit and **fail-closed** (throw
`HOUR_BLOCK_NOT_ENABLED`, 500) so a hand-forged row can never bill as anything; W02 replaces the
`generateDueInvoice` arm and W03 the `resolveLineQty` arm. `CONTRACT_LINE_TYPES` in
`@breeze/shared` does **not** gain `hour_block` until W03.

## Spec deltas decided at plan time (all reflected in the spec's "Plan-time amendments" section)

1. **Field vocabulary — W04 allowance columns are reused** (roadmap
   `2026-09-02-device-set-billing-roadmap.md:74`, settled; allowance spec §"Contract with #4547").
   `included_hours` → **`included_quantity`** (hours, `numeric(12,2)`), `overage_rate` →
   **`overage_unit_price`** (`numeric(12,2)`), plus `overage_mode`. Block-specific columns keep
   their spec names. The pure split uses `applyAllowance(consumed, spec, 'single_block')`
   (`contractAllowance.ts:56`) — already shipped for exactly this.
2. **`overage_mode` on a block is `'bill'` only in this slice** (Open Decision 10). Spec Decision 3
   (approved A) made the overage rate required; `'flag'` would let a block silently absorb unlimited
   hours. The CHECK and the invariant table pin `hour_block ⇒ overage_mode = 'bill'`.
3. **Ad-hoc labour billing must not take block-covered hours** (Open Decision 9). The spec only
   guarded the `issueInvoice` race. `gatherOrgTimeEntries` / `gatherTicketBillables`
   (`invoiceAssembly.ts:181`, `:222`) would sweep an open block period's entries onto a
   hand-built ad-hoc invoice, and issuing it before the period closes bills those hours ad hoc
   **and** charges the block fee. W02 adds `hourBlockHoldWindows()` and excludes held entries from
   both gatherers, reporting them as `heldForHourBlock`.
4. **Final-period close is a sweep, not a transition hook** (refines approved Decision 6 A). On an
   advance contract the final period is claimed on the run that expires the contract
   (`contractService.ts:2193-2197`) — it has not *ended* yet, so a hook at that moment cannot close
   it. W02 adds `runHourBlockCloseOutSweep()`: closes ended, claimed, unclosed periods of every block
   line the billing path will never visit again (contract not `active`, or line retired), and puts
   any overage on a **new draft invoice** that is never auto-issued.
5. **Expire/cancel retire the block line** (`hour_block_retired_at = now()`), so the
   one-live-block-per-org index frees up for a successor contract. Retired lines stop billing their
   fee; their claimed-but-unclosed periods still close via the sweep (bounded by
   `period_start < retired_at`).
6. **Org moves refuse block-drawn time** (Open Decision 11). `moveTicketOrg`
   (`ticketService.ts:3144` defers `time_entries_ticket_org_fk`) and the device mover
   (`routes/devices/core.ts:443`, `CUSTOM_ORG_REWRITE_TABLES`) rewrite `time_entries.org_id`. The new
   composite `(contract_line_id, org_id) → contract_lines(id, org_id)` FK would 23503 at commit. Both
   movers preflight and refuse with 409 `HOUR_BLOCK_DRAWN_TIME` naming the count. `orgMerge` is
   unaffected (it repoints both sides under `SET CONSTRAINTS ALL DEFERRED`, `orgMerge.ts:1088`).
7. **Hour-block overage stays out of the device-evidence totals.** `contract_billing_period_outcomes`
   `flagged_total` / `billed_overage_total` are `integer` device counts (`schema/contracts.ts`).
   Fractional hours never enter `overages[]` or those columns; block closes are reported in a new
   `GenerateResult.hourBlockCloses` and are evidenced by `contract_hour_periods` itself.
8. **The interactive "add contract line to invoice" AI action** (`aiToolsBilling.ts:343-406`) must
   never materialize block overage. W02/W03 keep `resolveLineQty`'s `hour_block` arm at
   `{ counted: 1, billed: 1, included: null, overage: 0, overageMode: null }` (fee only), so the
   estimate it reads cannot carry hours overage.
9. **Prerequisites already met.** #4596 shipped (`time_entries_org_partner_fk`,
   `schema/timeTracking.ts:31`), closing the spec's flagged cross-partner gap; `billable_minutes`
   shipped (`schema/timeTracking.ts:77`); the included-coverage → `billing_status='contract'` rule is
   live (`billingRuleResolver.ts:90`).
10. **Portal home** (Open Decision 7 amended → Open Decision 12). The portal already has a
   **Support usage** panel on the Tickets page (`services/portal/supportUsage.ts`,
   `SupportUsagePanel.tsx`, gated by `enable_support_usage`). The block card renders **in that
   panel's response and component** (one concept, one home), gated by its own fail-closed
   `enable_hour_block` flag (approved Decision 7 A), not added to `PORTAL_VISIBILITY_FLAG_KEYS`
   ("Enable all").

## Cross-wave contract

### C1. Migrations

Hand-written, idempotent, no inner `BEGIN/COMMIT`. None of them write rows, so none needs the
`set_config('breeze.scope','system',true)` preamble — **if any wave adds a data write, the preamble
and a `GET DIAGNOSTICS` row count become mandatory** (`migrationRlsScope.test.ts`). Newest committed
migration at planning: `2026-12-13-110200-org-erasure-fk-child-actions.sql`. **Re-check
`ls apps/api/migrations | LC_ALL=C sort | tail -1` when implementing**; if anything newer has
landed, rename to sort after it, keeping relative order.

| Wave | File | Content |
|---|---|---|
| W01 | `2026-12-14-100000-contract-line-type-hour-block.sql` | `ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'hour_block';` — alone, because a value added by `ADD VALUE` cannot be referenced in the same transaction and `autoMigrate` wraps each file in one |
| W01 | `2026-12-14-100100-contract-lines-hour-block.sql` | 5 `ADD COLUMN IF NOT EXISTS` (C2); `contract_lines_allowance_chk` DROP + re-ADD with `hour_block` in the type list and exempt from integrality; new `contract_lines_hour_block_chk`; partial unique `contract_lines_one_live_hour_block_per_org_uq` |
| W01 | `2026-12-14-100200-contract-hour-periods.sql` | table + indexes + 3 composite deferrable FKs + RLS (Shape 1) |
| W01 | `2026-12-14-100300-time-entries-contract-line.sql` | `time_entries.contract_line_id` + composite deferrable FK + NULL-org CHECK + partial index |
| W04 | `2026-12-14-130000-portal-branding-enable-hour-block.sql` | `portal_branding.enable_hour_block boolean NOT NULL DEFAULT false` |

### C2. Schema — `contract_lines` additions (W01)

Reused from W04 #4607 (no DDL change): `included_quantity numeric(12,2)` (hours), `overage_mode
contract_overage_mode` (must be `'bill'`), `overage_unit_price numeric(12,2)`.

New columns (Drizzle names in `apps/api/src/db/schema/contracts.ts`, inside `contractLines`):

| SQL | Drizzle | Type | Rule |
|---|---|---|---|
| `rollover_policy` | `rolloverPolicy` | `text` | `'none' \| 'carry_forward'`; required on `hour_block`, NULL otherwise |
| `rollover_cap_hours` | `rolloverCapHours` | `numeric(12,2)` | only under `carry_forward`; NULL = uncapped; `> 0` when set |
| `hour_block_alert_pct` | `hourBlockAlertPct` | `integer` | NULL or 1–100; only on `hour_block` |
| `hour_block_first_period_start` | `hourBlockFirstPeriodStart` | `date` (mode `'string'`) | required on `hour_block`; **server-stamped** at insert, never client-supplied, never patchable |
| `hour_block_retired_at` | `hourBlockRetiredAt` | `timestamptz` | NULL = live; only on `hour_block` |

`contract_lines_allowance_chk` (re-added, full text — the `ELSE` branch is unchanged):

```sql
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_allowance_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_allowance_chk CHECK (
  CASE WHEN line_type IN ('per_device', 'per_device_role', 'per_device_group', 'per_seat', 'hour_block') THEN
    ((included_quantity IS NULL) = (overage_mode IS NULL))
    AND (included_quantity IS NULL OR included_quantity > 0)
    -- Devices and seats are whole; hours are not (#4547).
    AND (line_type = 'hour_block' OR included_quantity IS NULL OR included_quantity = floor(included_quantity))
    AND ((overage_unit_price IS NOT NULL) = (overage_mode IS NOT DISTINCT FROM 'bill'))
    AND (overage_unit_price IS NULL OR overage_unit_price >= 0)
  ELSE
    included_quantity IS NULL AND overage_mode IS NULL AND overage_unit_price IS NULL
  END
);
```

`contract_lines_hour_block_chk` (NULL-safe: every conjunct is a non-null boolean):

```sql
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_hour_block_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_hour_block_chk CHECK (
  CASE WHEN line_type = 'hour_block' THEN
    included_quantity IS NOT NULL
    AND overage_mode IS NOT DISTINCT FROM 'bill'
    AND site_id IS NULL AND site_name IS NULL
    AND device_roles IS NULL AND device_group_id IS NULL AND device_group_name IS NULL
    AND manual_quantity IS NULL
    AND rollover_policy IS NOT NULL AND rollover_policy IN ('none', 'carry_forward')
    AND (rollover_cap_hours IS NULL OR (rollover_policy = 'carry_forward' AND rollover_cap_hours > 0))
    AND (hour_block_alert_pct IS NULL OR hour_block_alert_pct BETWEEN 1 AND 100)
    AND hour_block_first_period_start IS NOT NULL
  ELSE
    rollover_policy IS NULL AND rollover_cap_hours IS NULL AND hour_block_alert_pct IS NULL
    AND hour_block_first_period_start IS NULL AND hour_block_retired_at IS NULL
  END
);
CREATE UNIQUE INDEX IF NOT EXISTS contract_lines_one_live_hour_block_per_org_uq
  ON contract_lines (org_id)
  WHERE line_type = 'hour_block' AND hour_block_retired_at IS NULL;
```

### C3. Schema — `contract_hour_periods` (W01), Drizzle export `contractHourPeriods` in `schema/contracts.ts`

| SQL | Drizzle | Type |
|---|---|---|
| `id` | `id` | `uuid PK DEFAULT gen_random_uuid()` |
| `contract_line_id` | `contractLineId` | `uuid NOT NULL` |
| `contract_id` | `contractId` | `uuid NOT NULL` |
| `org_id` | `orgId` | `uuid NOT NULL REFERENCES organizations(id)` |
| `period_start`, `period_end` | `periodStart`, `periodEnd` | `date NOT NULL` (mode `'string'`), half-open |
| `included_hours`, `carried_in_hours`, `consumed_hours`, `overage_hours`, `carried_out_hours` | `includedHours`, … | `numeric(12,2) NOT NULL` |
| `foreign_currency_hours` | `foreignCurrencyHours` | `numeric(12,2) NOT NULL DEFAULT 0` — hours absorbed from entries stamped in a currency other than the contract's (Decision 8 flag) |
| `entry_count` | `entryCount` | `integer NOT NULL` |
| `overage_unit_price` | `overageUnitPrice` | `numeric(12,2) NOT NULL` — snapshot at close |
| `currency_code` | `currencyCode` | `char(3) NOT NULL` — contract's, snapshot |
| `overage_invoice_id` | `overageInvoiceId` | `uuid` NULL when overage 0 |
| `close_source` | `closeSource` | `text NOT NULL CHECK (close_source IN ('billing_run','close_out'))` |
| `closed_at` | `closedAt` | `timestamptz NOT NULL DEFAULT now()` |

- `contract_hour_periods_line_period_uq UNIQUE (contract_line_id, period_start)` — the idempotency key.
- `CHECK (period_end > period_start)`, `CHECK` every hours column `>= 0`, `CHECK (overage_hours = 0) = (overage_invoice_id IS NULL)` **is NOT added** (`ON DELETE SET NULL` on the invoice must stay legal).
- Indexes: `contract_hour_periods_org_idx (org_id)`, `contract_hour_periods_contract_idx (contract_id, period_start DESC)`.
- FKs, all `DEFERRABLE INITIALLY IMMEDIATE`:
  - `contract_hour_periods_contract_org_fk (contract_id, org_id) → contracts(id, org_id) ON DELETE CASCADE`
  - `contract_hour_periods_line_org_fk (contract_line_id, org_id) → contract_lines(id, org_id) ON DELETE RESTRICT`
  - `contract_hour_periods_invoice_org_fk (overage_invoice_id, org_id) → invoices(id, org_id) ON DELETE SET NULL (overage_invoice_id)`
- RLS: Shape 1, `ENABLE` + `FORCE`, four `breeze_org_isolation_{select,insert,update,delete}` policies on `public.breeze_has_org_access(org_id)` — verbatim pattern from `contract_billing_periods` (`2026-06-15-d-recurring-contracts.sql:115-130`). Not append-only.

### C4. Schema — `time_entries.contract_line_id` (W01)

`contractLineId: uuid('contract_line_id')` in `schema/timeTracking.ts` (plain column; composite FK SQL-only, comment it like `orgId`). SQL:

- `time_entries_contract_line_org_fk (contract_line_id, org_id) → contract_lines(id, org_id) ON DELETE SET NULL (contract_line_id) DEFERRABLE INITIALLY IMMEDIATE`
- `time_entries_contract_line_org_chk CHECK (contract_line_id IS NULL OR org_id IS NOT NULL)`
- `time_entries_contract_line_chk CHECK (contract_line_id IS NULL OR billing_status = 'contract')`
- `time_entries_contract_line_idx (contract_line_id) WHERE contract_line_id IS NOT NULL`

Server-written only: no Zod schema in `@breeze/shared` accepts `contractLineId`.

### C5. Registrations (W01, same PR as the DDL — CLAUDE.md step 4)

| List | File | Change |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `services/tenantCascade.ts:486-490` | `'contract_hour_periods'` between `'contract_documents'` and `'contract_lines'` (`localeCompare` order) |
| `CORE_TENANT_EXPORT_POLICY` | `services/tenantExportPolicyRegistry.ts` | new `contract_hour_periods` row, `tablePolicy('org_id', …)`, every column `included` (no json/jsonb/bytea); `contract_lines` row (`:322`) gains the five C2 columns in `included`; `time_entries` row gains `contract_line_id` in `included` |
| `REPOINT_TABLES` | `services/orgMergeRegistry.ts:731` (declaration; entries `:833-834`) | `"contract_hour_periods"` between `"contract_documents"` and `"contract_lines"` |
| `rls-coverage.integration.test.ts` | — | none (Shape 1 auto-discovered) |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CUSTOM_ORG_REWRITE_TABLES` / ticket lists | — | none (no `device_id`, no `ticket_id`) |
| W04: `CORE_TENANT_EXPORT_POLICY` `portal_branding` row | same file | `enable_hour_block` in `included` |

### C6. Shared (`packages/shared`)

W01 adds to `src/validators/contracts.ts` (exported, **not yet** in `CONTRACT_LINE_TYPES`):

```ts
export const HOUR_BLOCK_LINE_TYPE = 'hour_block' as const;
export const ROLLOVER_POLICIES = ['none', 'carry_forward'] as const;
export type RolloverPolicy = typeof ROLLOVER_POLICIES[number];
```

W03 adds `'hour_block'` to `CONTRACT_LINE_TYPES` and to `ALLOWANCE_LINE_TYPES`, extends
`ContractLineShape` with `rolloverPolicy?`, `rolloverCapHours?`, `hourBlockAlertPct?`, and adds the
hour-block rows to `contractLineInvariantIssues` (twin of C2's CHECKs). W03 adds
`HourBlockEstimate` (C8) to `src/types/` and re-exports it.

### C7. API service surface

`apps/api/src/services/contractHourBlocks.ts` (new, W02 — pure, no DB, no enum import):

```ts
export const HOUR_BLOCK_CLOSE_CAP = 12;
export type RolloverPolicy = 'none' | 'carry_forward';
export interface HourBlockLineSpec {
  includedQuantity: string;           // hours
  overageUnitPrice: string;
  rolloverPolicy: RolloverPolicy;
  rolloverCapHours: string | null;
}
/** Minutes → hours rounded to 2dp FIRST (round-each-then-sum, like timeEntryToLineSpec). */
export function entryHours(minutes: number): number;
export function sumEntryHours(minutes: readonly number[]): number; // exact 2dp, integer-cents arithmetic
export interface PeriodMath {
  includedHours: number; carriedInHours: number; openingHours: number;
  consumedHours: number; overageHours: number; carriedOutHours: number;
}
export function computePeriodMath(spec: HourBlockLineSpec, carriedInHours: number, consumedHours: number): PeriodMath;
export interface ClosablePeriod { index: number; periodStart: string; periodEnd: string }
/** Earliest-first, contiguous from the first unclosed claimed period; capped. */
export function selectClosablePeriods(args: {
  contractStartDate: string; intervalMonths: number;
  firstPeriodStart: string;           // hour_block_first_period_start
  retiredAt: Date | null;
  claimedPeriodStarts: ReadonlySet<string>;
  closedPeriodStarts: ReadonlySet<string>;
  todayISO: string;
  cap?: number;                       // default HOUR_BLOCK_CLOSE_CAP
}): { periods: ClosablePeriod[]; truncated: boolean; blockedBy: string | null };
```

`selectClosablePeriods` walks periods from `firstPeriodStart`; a period is closable iff it has
ended (`periodEnd <= todayISO`), is claimed, is not closed, and (if retired) `periodStart <
retiredAt::date`. It **stops** at the first period that is claimed+ended+unclosed but preceded by an
unclosed claimed period it could not close (contiguity), returning `blockedBy`. Unclaimed periods are
**skipped** (paused stretches, drafts — never entitled), not blocking.

`apps/api/src/services/contractHourBlockClose.ts` (new, W02 — DB, must run inside the caller's
system transaction):

```ts
export interface HourBlockCloseSummary {
  contractLineId: string; description: string;
  periodStart: string; periodEnd: string;
  includedHours: number; carriedInHours: number; consumedHours: number;
  overageHours: number; carriedOutHours: number; foreignCurrencyHours: number;
  entryCount: number;
  overageInvoiceLineId: string | null;
  closeSource: 'billing_run' | 'close_out';
}
/** Closes every closable period of one block line, earliest first. Caller holds the contract row lock. */
export async function closeHourBlockPeriods(args: {
  contract: typeof contracts.$inferSelect;
  line: typeof contractLines.$inferSelect;
  overageInvoice: { id: string; actor: InvoiceActor } | (() => Promise<{ id: string; actor: InvoiceActor }>);
  closeSource: 'billing_run' | 'close_out';
  asOf: Date;
}): Promise<{ closes: HourBlockCloseSummary[]; truncated: boolean }>;
/** [start, end) instants whose not_billed billable entries are reserved for a block (Open Decision 9). */
export async function hourBlockHoldWindows(orgId: string, asOf?: Date): Promise<Array<{ start: Date; end: Date | null; contractLineId: string }>>;
export async function runHourBlockCloseOutSweep(asOf?: Date): Promise<{ contracts: number; closes: number; errors: number }>;
```

`apps/api/src/services/contractHourBlockEstimate.ts` (new, W03):

```ts
/** Live figures for the OPEN period of one block line. Caller supplies a SYSTEM or a
 *  PARTNER-scoped db context for the owning partner (time_entries RLS is
 *  `system OR breeze_has_partner_access(partner_id)`); it opens none, and THROWS
 *  under org scope or no context rather than reporting zero hours used. */
export async function computeOpenHourBlockPeriod(
  contract: typeof contracts.$inferSelect,
  line: typeof contractLines.$inferSelect,
  asOf?: Date,
): Promise<HourBlockEstimate>;
```

Reused by `computeContractEstimate` (W03), the portal endpoint and the alert sweep (W04).

`overageInvoice` is an invoice id on the billing path (the run's draft) and a **lazy factory** on the
close-out path (creates a draft via `createManualInvoice` only when the first overage > 0 appears).

Changes to existing services (owner wave):

| Symbol | File | Wave | Change |
|---|---|---|---|
| `resolveLineQty` | `contractService.ts:674` | W01 fail-closed arm → **W03** fee-only arm `{counted:1,billed:1,included:null,overage:0,overageMode:null}`, `live:false`; a **retired** line returns all zeros (no fee in estimate/list/MRR, matching W02's billing skip) | |
| `generateDueInvoice` switch | `contractService.ts:2101` | W01 fail-closed → **W02**: `case 'hour_block'` bills fee only (`applyAllowance(1, NO_ALLOWANCE, 'single_block')`) and **skips retired lines**; after the claim (step 3) and before the outcomes insert, calls `closeHourBlockPeriods` for each `hour_block` line | |
| `GenerateResult` | `contractService.ts:1940` | W02 | `+ hourBlockCloses: HourBlockCloseSummary[]` (always present, `[]`), and `+ hourBlockCloseTruncated: boolean` |
| expire (×2) / `cancelContract` | `contractService.ts:2031`, `:2196`, `:1870` | W02 | stamp `hour_block_retired_at = now()` on the contract's live block lines in the same statement batch |
| `updateTimeEntry` / `deleteTimeEntry` | `timeEntryService.ts:1008`, `:1172` | W02 | `entry.billingStatus === 'contract' && entry.contractLineId !== null` gets the same `BILLED_LOCKED_ENTRY_FIELDS` 409 (new code `ENTRY_DRAWN_BY_BLOCK`) and delete refusal |
| `gatherOrgTimeEntries`, `gatherTicketBillables` | `invoiceAssembly.ts:181`, `:222` | W02 | exclude entries whose `ended_at` falls in `hourBlockHoldWindows(orgId)`; `AssemblyResult` gains `heldForHourBlock: { count: number; hours: number }` |
| `moveTicketOrg`, device org move | `ticketService.ts`, `routes/devices/moveOrg.ts` | W02 | preflight: any moving `time_entries` row with `contract_line_id IS NOT NULL` → 409 `HOUR_BLOCK_DRAWN_TIME` |
| `ContractServiceErrorCode` | `contractTypes.ts:49` | W01 `'HOUR_BLOCK_NOT_ENABLED'`; W02 `'HOUR_BLOCK_CLOSE_MISMATCH'`; W03 `'HOUR_BLOCK_EXISTS'`, `'HOUR_BLOCK_FIELD_LOCKED'` | |
| `addContractLineToContract`, `createContractWithLinesDetailed` | `:1570`, `:2223` | W03 | stamp `hourBlockFirstPeriodStart` (C9), map 23505 on the live-block index → 409 `HOUR_BLOCK_EXISTS`; `createContractWithLinesDetailed` (quote path) **rejects** `hour_block` |
| `updateContractLine` | `:1661` | W03 | patchable on a block: `description`, `unitPrice`, `taxable`, `includedQuantity`, `overageUnitPrice`, `rolloverPolicy`, `rolloverCapHours`, `hourBlockAlertPct`; `overageMode` cannot leave `'bill'`; first-period/retired never patchable (`HOUR_BLOCK_FIELD_LOCKED`) |
| `removeContractLine` | `:1791` | W03 | block line with ≥1 ledger row **or** any claimed period ≥ first_period_start → retire (`hour_block_retired_at = now()`), else delete |
| `computeContractEstimate` | `:858` | W03 | `+ hourBlock: HourBlockEstimate \| null` |
| `runContractBillingSweep` | `jobs/contractWorker.ts:47` | W02 logs `hourBlockCloses` / truncation; W02 runs `runHourBlockCloseOutSweep` after the billing sweep in the same job; **W04** runs `runHourBlockAlertSweep` before it | |

### C8. Estimate shape (W03), `packages/shared/src/types/contracts.ts` (or the existing contract types file)

```ts
export interface HourBlockEstimate {
  lineId: string;
  periodStart: string; periodEnd: string;          // the OPEN period, half-open
  includedHours: number; carriedInHours: number;
  consumedHours: number; unapprovedHours: number;  // unapproved ⊆ consumed (Decision 4)
  foreignCurrencyHours: number;                    // Decision 8 flag
  remainingHours: number; overageHours: number;
  overageUnitPrice: string; overageValue: string;  // overageValue via overageValue()
  alertPct: number | null;
  billingTiming: 'advance' | 'arrears';            // drives the "bills next invoice" note
  lateEntryHours: number;                          // not_billed entries in already-closed periods (spec "Out of scope" note)
}
```

### C9. Period rules (all waves)

- Periods are the contract's billing periods: `computePeriod(startDate, intervalMonths, idx)`
  (`contractMath.ts:30`), half-open `[periodStart, periodEnd)`.
- `hour_block_first_period_start` = **the first period whose block fee has not yet been claimed** —
  entitlement starts exactly where the fee starts (refined at plan time from the spec's "first period
  starting >= today", which under-delivers on arrears: the in-progress arrears period is still
  unclaimed and is billed the block fee at its end).
  - **active** contract: `duePeriodStartFor(billingTiming, nextBillingAt, intervalMonths)`
    (`contractMath.ts:74`) — advance: the next period (the current one was claimed without the fee);
    arrears: the period in progress.
  - **draft** contract: provisional stamp = the contract's first period; **re-stamped inside
    `activateContract`** (`contractService.ts:1815`) to the first period activation will claim
    (`duePeriodStartFor` over the `nextBillingAt` it sets), in the same transaction.
  - "today" is UTC (`todayISO`, moved to `contractMath.ts` by W03); contracts carry no timezone.
- Entry eligibility for a period (the claim query, W02): `org_id = contract.org_id AND is_billable
  AND billing_status = 'not_billed' AND ended_at IS NOT NULL AND ended_at >= periodStart::timestamptz
  AND ended_at < periodEnd::timestamptz`, `ORDER BY id FOR UPDATE`; minutes =
  `COALESCE(billable_minutes, duration_minutes, 0)`. Unapproved entries draw (Decision 4 A). Any
  currency draws (Decision 8 B) and is counted in `foreign_currency_hours`. NULL `hourly_rate` draws.
- Date → instant: period boundaries are dates; compare as `periodStart::date::timestamp AT TIME ZONE
  'UTC'` — the same convention the existing assembly range uses. W02 pins it with a boundary test.

### C10. Error codes (HTTP)

| Code | Status | Where |
|---|---|---|
| `HOUR_BLOCK_NOT_ENABLED` | 500 | W01 fail-closed arms (unreachable unless a row is forged) |
| `HOUR_BLOCK_CLOSE_MISMATCH` | 500 | W02 close: `UPDATE … RETURNING` count ≠ locked count (transaction aborts) |
| `ENTRY_DRAWN_BY_BLOCK` | 409 | W02 time-entry edit/delete of a block-drawn entry |
| `HOUR_BLOCK_DRAWN_TIME` | 409 | W02 org moves |
| `HOUR_BLOCK_EXISTS` | 409 | W03 second live block for the org |
| `HOUR_BLOCK_FIELD_LOCKED` | 400 | W03 patch of a locked field / `overageMode` away from `'bill'` |
| `PORTAL_HOUR_BLOCK_DISABLED` | 403 | W04 portal gate |

## Open Decisions (do not block on these — each wave states the default it implements)

Decisions 1–8 were settled at Gate A (2026-09-02) and are not reopened. New at plan time:

**9. Ad-hoc labour billing during an open block period.**
- **A — Hold:** `gatherOrgTimeEntries` / `gatherTicketBillables` skip entries inside a block's pending
  window and report `heldForHourBlock`. Pro: the block is the only path that can bill those hours —
  no fee-plus-ad-hoc double charge. Con: a tech who wants to bill a block-eligible hour ad hoc must
  mark the entry non-billable-to-block (not possible in this slice) or wait for the close.
- **B — Status quo:** let ad-hoc assembly take them; whichever is issued first wins. Pro: no change
  to assembly. Con: customer double-pays for any hour billed ad hoc in an open block period.
- **Recommend A** — B reintroduces exactly the double charge Decision 6 C was rejected for.
  *Implemented default: A (W02).*

**10. `overage_mode = 'flag'` on a block.**
- **A — `'bill'` only in this slice** (CHECK-enforced). Matches Decision 3 A (rate required).
- **B — Allow `'flag'`:** overage hours reported on close, no invoice line, entries still absorbed.
  Pro: "soft cap" MSPs. Con: unlimited free hours unless someone acts on a notice.
- **Recommend A**; B is additive later (relax one conjunct). *Implemented default: A (W01 CHECK, W03 validator).*

**11. Org moves of tickets/devices carrying block-drawn time.**
- **A — Refuse** with 409 `HOUR_BLOCK_DRAWN_TIME`. Pro: drawn history cannot drift orgs; reversible.
  Con: an operator must correct the ticket's org before the block closes or not at all.
- **B — Detach:** null `contract_line_id` on move. Con: the entry stays `contract` with no line, so
  it becomes editable and re-billable in the target org — a double-charge path.
- **Recommend A.** *Implemented default: A (W02).*

**12. Portal placement of the hours card.**
- **A — Inside the existing Support usage panel/response, own fail-closed `enable_hour_block` flag,
  not in "Enable all".** One home for "hours"; billing-sensitive flag stays explicit.
- **B — Separate portal page + nav item.** Con: a second "hours" surface.
- **Recommend A.** *Implemented default: A (W04).* Settings rule 9 statement for the W04 PR: home =
  Org → Portal settings (`OrgPortalSettingsEditor.tsx`), level = org, resolver = `portal_branding`
  row via `orgPortalSettings.ts`, places configured 0 → 1.

**13. A successor contract while a block is live on a draft/active one.** The live-block index is
per org and counts **draft** contracts' lines, so drafting next term's contract with a block requires
retiring the current block first.
- **A — Accept for slice 1** (documented in the editor error copy).
- **B — Exempt draft contracts** (index on a denormalized `contract_status` copy). Con: a trigger-kept copy of contract status on every line.
- **Recommend A.** *Implemented default: A.*

**14. Org merge when both orgs have a live block.** `contract_lines` is a plain repoint
(`orgMergeRegistry.ts:834`) and `contract_lines_one_live_hour_block_per_org_uq` is unique on
`(org_id)`, so merging two orgs that each carry a live block fails with 23505 mid-merge. (The ledger
and `time_entries` FKs are deferrable and repoint cleanly; this is only the live-block index.)
- **A — Merge preflight refuses** with a clear error ("both organizations have a live block of
  hours; retire one first") before any repoint. Pro: no silent billing change; reversible. Con: one
  manual step for the operator.
- **B — Custom merge policy retires the source org's live block** during the merge. Pro: no extra
  step. Con: silently ends a paid entitlement the customer may still be drawing on.
- **Recommend A.** *Implemented default: A, owned by W03* (must land before the feature opens), as a
  check in the merge engine's preflight beside the existing ones, with an `orgMerge.test.ts` case and an
  `orgMergeRegistry.integration.test.ts` case.

## Review Focus (program-level — the failure modes most likely to bite, each pinned by a named wave test)

1. **A period closes twice or never** — re-run, worker + manual `/generate` race, close-out sweep vs.
   billing run on the same contract. Pinned: W02 Task 6 (concurrent generate) + Task 8 (sweep vs. run).
2. **An hour is billed twice** — ad-hoc issue vs. close (W02 Task 5 concurrency), ad-hoc assembly in an
   open period (W02 Task 7), un-drawing via edit (W02 Task 4), org move (W02 Task 9), contract end
   without close (W02 Task 8).
3. **Free hours** — block added mid-period (first_period_start), pause/resume gap (unclaimed skipped),
   retired line still billing its fee. Pinned: W02 Task 3 (selector) + Task 6.
4. **Fractional-hour drift** — 20 min × 3 must be 0.99 h, not 1.00; consumed = Σ round(each).
   Pinned: W02 Task 2.
5. **Partner-axis read trap** — any drawdown read outside a system context sees zero `time_entries`.
   Pinned: W02 Task 5 (org-scoped context returns 0) and W04 Task 2 (portal handler).

## Verification bar (every wave)

- Red first for every unit; `cd apps/api && npx vitest run <files>` foreground, small batches.
- Typecheck every touched package (`cd apps/api && npx tsc --noEmit -p .` with
  `NODE_OPTIONS=--max-old-space-size=12288`; check the exit code, never pipe to `tail`).
- Integration suites against `pnpm test-stack up`; W01 and W02 also run
  `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`,
  `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`,
  `tenantExportErasureRoundtrip.integration.test.ts`, `orgMergeRegistry.integration.test.ts`,
  `orgLifecycleFoundations.integration.test.ts`, and the full `orgMerge.test.ts` (it reds only in the
  full unit suite).
- `pnpm db:check-drift` clean (W01, W04).
- PR review: `/pr-review-toolkit:review-pr`, one round.

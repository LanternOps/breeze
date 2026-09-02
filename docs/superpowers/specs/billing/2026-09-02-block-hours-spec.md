# Block Hours: Prepaid Hour Banks on Contracts

**Date:** 2026-09-02
**Status:** Draft — awaiting Todd's answers to the Open Decisions below
**Tracking issue:** LanternOps/breeze#4547
**Sibling:** LanternOps/breeze#3205 `per_device_role` contract lines (same MSP conversation, built first; spec `docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-role-design.md` on branch `billing-by-units`)
**Advisor quorum:** Fable design + Codex `gpt-5.6-sol` xhigh read-only review (2026-09-02). Codex found nine confirmed defects in the first draft, all folded in below; the one place we still disagree is Open Decision 8.
**Origin:** MSP demo follow-up, 2026-09-02.

## Problem

MSPs sell blocks of prepaid support hours — "10 hours a month", "40 hours for the term". Technician time draws the block down, the customer sees what is left, and hours past the block bill at a contracted overage rate. Unused hours either expire or roll forward.

Breeze models none of it. Verified against `origin/main` @ `01d588ae7d`:

- `contract_line_type` is `flat | per_device | per_seat | manual` (`apps/api/src/db/schema/contracts.ts`). `generateDueInvoice` and `resolveLineQty` (`apps/api/src/services/contractService.ts`) both switch on it; the `generateDueInvoice` switch ends in `const _exhaustive: never`, so a new value is a compile error there. `resolveLineQty` still ends in `default: { quantity: 0 }` — a silent zero, not a compile error. (#3205 closes that asymmetry; if it has not landed, this slice must.)
- `time_entries` (`apps/api/src/db/schema/timeTracking.ts`) carries `is_billable`, `hourly_rate`, `currency_code`, `duration_minutes`, `ticket_id`, `is_approved`, and `billing_status` (`not_billed | billed | no_charge | contract`). There is no `contract_id`.
- **Correction to the issue's current-state section.** The issue says the `contract` billing status "is defined but dead: … nothing ever writes it." Half right. No *system* path writes it — `invoiceService.issueInvoice` only ever flips `not_billed → billed` (lines 1301/1309) — but `billingStatusSchema` in `packages/shared/src/validators/timeEntries.ts` accepts the full enum on create and update, and `timeEntryService` line 738 persists whatever it is given. A technician can already set `contract` by hand today; it is a manual write-off marker with no meaning attached. This design gives it its system writer without changing the enum.
- `invoiceAssembly.gatherOrgTimeEntries` selects `is_billable = true AND billing_status = 'not_billed' AND ended_at BETWEEN …`, and explicitly `ne(billing_status, 'contract')`. Marking an entry `contract` is therefore already sufficient to withdraw it from ad-hoc labor billing.
- **`time_entries` is RLS Shape 3 (partner-axis)**, not org-axis: `time_entries_partner_access … breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id)`, and `org_id` is **nullable** (denormalized from the ticket for filtering only). The issue does not say this and it constrains the design: an org-scoped reader cannot see time entries at all, so every drawdown read must run in a **system** context (the billing worker already does: `runOutsideDbContext(() => withSystemDbAccessContext(...))`).
- `invoice_lines.source_type` is `time_entry | part | catalog | bundle | manual | contract` (`packages/shared/src/types/billing-enums.ts`). A contract-sourced line already carries `source_contract_id` lineage (#3778).
- Contract lines are editable — added *and hard-deleted* — on `draft` **and `active`** contracts (`assertEditable`, `contractService.ts:57`; `removeContractLine`, `:847`).
- `pauseContract` clears `next_billing_at`; `resumeContract` jumps the pointer to `periodIndexFor(today)` (`contractService.ts:885–908`). Paused periods are never billed and leave no trace — there is no pause history in the schema.
- `tickets` has **no `site_id`** — so a site-scoped hour block has no attribution path from a time entry. (See Out of scope.)
- Portal has Proposals / Invoices / Support / Devices / Equipment / Profile (`apps/portal/src/lib/navItems.ts`). No contracts surface of any kind.
- `user_notifications` carries a partial-unique `dedupe_key` (`apps/api/src/db/schema/notifications.ts`), which is the idempotency mechanism a threshold alert needs.
- `orgMerge` runs its repoint walk under `SET CONSTRAINTS ALL DEFERRED` (`orgMerge.ts:1022`), and `contract_lines` and `time_entries` are repointed as separate steps.

## Users & scope

| | |
|---|---|
| **Who configures** | An MSP technician with `contracts:write`, on one customer's contract. Ownership is **org-scoped**, not partner-wide. |
| **Who consumes** | Technicians (contract detail + estimate); the customer, read-only, in the portal. |
| **Who is billed** | The contract's org, in the contract's stamped currency. |

**Why org-scoped and not dual-axis.** CLAUDE.md's "partner-wide first" rule targets *config-ish* tables — "policies, templates, rules, windows, baselines" — because an MSP defines one policy and applies it to every org. A block-hours bank is the opposite: it is a **balance**, a transactional record of one customer's prepaid entitlement and its consumption. There is no meaningful "all orgs" hour bank; a partner-wide row would have no org to draw down against. It hangs off `contract_lines`, which is already `org_id NOT NULL` (RLS Shape 1), and its siblings `contract_billing_periods`, `contract_renewal_notices` and `invoices` are all org-scoped for the same reason. The new ledger table therefore takes **Shape 1: direct `org_id`, `breeze_has_org_access(org_id)`**, and this paragraph is the explicit justification the rule asks for. Codex independently agreed (finding 18).

## Proposed design

### 1. `hour_block` contract line type

One new value on `contract_line_type`. An `hour_block` line means: *this contract includes N hours per billing period at this flat price; hours beyond that bill at the overage rate.* Its `unit_price` is the block's price and its quantity is always 1 — identical arithmetic to `flat`, so MRR, the estimate and the invoice all work with a one-line change each.

New columns on `contract_lines`:

| Column | Type | Rule |
|---|---|---|
| `included_hours` | `numeric(10,2)` | required on `hour_block`, NULL on every other type, `> 0` |
| `rollover_policy` | `text` | `'none' \| 'carry_forward'`; required on `hour_block`, NULL otherwise |
| `rollover_cap_hours` | `numeric(10,2)` | only permitted when `rollover_policy = 'carry_forward'`; NULL = uncapped |
| `overage_rate` | `numeric(10,2)` | required on `hour_block`, `>= 0`, in the contract's currency |
| `hour_block_alert_pct` | `integer` | NULL = no alert; otherwise 1–100 |
| `hour_block_first_period_start` | `date` | required on `hour_block`; **stamped by the server at insert**, never client-supplied |
| `hour_block_retired_at` | `timestamptz` | NULL = live; set instead of deleting a block that has closed periods |

`text` + CHECK for `rollover_policy` rather than a second `pgEnum`: two values, no ordering semantics, and it avoids a third enum-in-its-own-file migration. One two-way CHECK expresses the whole shape (role-line precedent: `contract_lines_device_roles_chk`) — `hour_block` requires all of `included_hours > 0`, `rollover_policy IN ('none','carry_forward')`, `overage_rate >= 0`, `hour_block_first_period_start`, plus `site_id IS NULL`, and permits `rollover_cap_hours` only under `carry_forward` and `hour_block_alert_pct` only in 1–100; every other line type requires all seven columns NULL.

**`hour_block_first_period_start` closes a free-hours hole (Codex 9, CONFIRMED).** Lines can be added to an *active* contract. On an advance-billed contract the current period was already claimed and invoiced *without* the block fee, so a block added mid-period would absorb that whole period's hours — including work done before the line existed — for free. The server stamps the first period whose start is `>= today` at insert (`computePeriod` + `periodIndexFor`), and no period earlier than it is ever closable.

**`overage_rate` representability (Codex 20).** `hour_block` line creation runs the rate through the same `isRepresentableInCurrency` / `assertRepresentable` check `unit_price` gets. Otherwise a JPY contract accepts `1500.50` at create and only fails months later when the overage line is materialized, mid-billing-transaction.

**At most one live block per org — DB-enforced.** Partial unique index `(org_id) WHERE line_type = 'hour_block' AND hour_block_retired_at IS NULL`. This replaces the service-level existence check the first draft proposed, which Codex correctly called race-prone (finding 19: line creation locks only its own contract, so two concurrent adds on two contracts both pass). Replacing a block means retiring the old one first. One live block per org is what makes org-wide aggregate drawdown unambiguous without a `contract_id` on `time_entries`; see Open Decision 1.

**Retire, never delete, once history exists.** `removeContractLine` on an `hour_block` line that has at least one closed period sets `hour_block_retired_at` instead of deleting (Codex 13, CONFIRMED: the line is deletable on an active contract and a cascading FK would erase closed billing history). With no closed periods it deletes as before. The ledger's FK to the line is `ON DELETE RESTRICT`, so the database is the backstop rather than the intent.

### 2. Drawdown: ledgered at close, computed live while open

**Ledgered, not live.** The strongest argument for the ledger is not auditability, it is that a live computation is *wrong*. Carry-forward chains: period N's opening balance depends on N−1's leftover, which depends on N−2. A live fold from contract start re-derives every past period from the *current* contents of `time_entries` — so editing, deleting or back-dating one entry in a period invoiced three months ago silently restates the basis of an issued invoice, and the customer's remaining balance moves for a reason nobody can point at. A ledger row records what was decided and billed, and never moves. Codex agreed (finding 1).

**Rows are written at period CLOSE only.** The open period has no row; its figures are computed live from `included_hours + carried_in` (the last closed row's `carried_out`, or 0) minus a `SUM` over eligible entries. A read path must never write, and a materialized `consumed_hours` on an open period is a cache that is stale between sweeps and will be believed anyway. Alert idempotency does not need a row — `user_notifications.dedupe_key` provides it.

**Close happens inside `generateDueInvoice`**, in the same transaction that drafts the invoice, claims the period and advances the pointer. Marking entries `contract`, inserting the ledger row and adding the overage line must commit or roll back together; the function already holds the contract row lock and already runs in a system DB context, which is what the partner-axis `time_entries` read requires.

#### Which period closes — the claimed-period rule

The first draft said "close the most recent ended period with no ledger row". Codex demolished that on two counts, both CONFIRMED:

- **Rollover corruption (finding 8):** closing P2 while P0 and P1 are still missing freezes P2 with `carried_in = 0` and silently voids two periods of carry-forward.
- **Free hours across a pause (finding 10):** `pauseContract` clears `next_billing_at` and `resumeContract` jumps to today's period, so paused periods are never billed. Closing them anyway grants the customer included hours and rollover they never paid for, and the schema has no pause history to exclude them by.

The rule that fixes both:

> **A period is closable iff (a) it has ended, (b) it is `>= hour_block_first_period_start`, and (c) it was CLAIMED — a `contract_billing_periods` row exists for it. Close the EARLIEST closable unclosed period first and walk forward contiguously.**

Claim-gating is exact: a period the contract never billed was never entitled, so a paused stretch, a period before the block existed, and a period on a contract that was still a draft are all excluded by construction, with no new pause-history table. Earliest-first keeps the rollover chain contiguous.

For `arrears`, the period being billed is claimed in this same transaction and closes on the same invoice — block fee and overage together. For `advance`, the period claimed at its start closes on the run that claims its successor, so **the overage lands on the next invoice, one period behind**; the line description must carry the period dates ("Support hours over block, 2026-08-01 – 2026-09-01"). This is not a workaround: at the moment an advance invoice is cut, the hours it covers have not been worked, so its overage is unknowable.

**Catch-up is bounded.** The worker calls `generateDueInvoice` once per contract per sweep, so at most one claim accumulates per day and the unclosed backlog is naturally short. The close loop is nevertheless capped at 12 periods per run, oldest first, logging a structured warning when it hits the cap (Codex 6: the contract lock is held for this work, and an unbounded loop is an unbounded lock hold).

#### Claiming the entries

The first draft asserted that absorbing an entry off a live ad-hoc draft would make `issueInvoice` throw `CONCURRENT_MODIFICATION`. **That was wrong** (Codex 2, CONFIRMED): `issueInvoice` locks the source rows `FOR UPDATE` in `id` order and rejects any non-`not_billed` row with a 409 `SOURCE_ALREADY_BILLED` at `invoiceService.ts:1218`, well before the guarded flip. The hazard is real but the failure mode is a 409 that blows up an unrelated technician's invoice issue.

Codex further showed (finding 3, CONFIRMED) that a `NOT EXISTS (invoice_lines …)` predicate does not fix it: assembly gathers with an unlocked SELECT (`invoiceAssembly.ts:144`) and materializes later without a source lock, so the predicate only narrows a window it cannot close. And SUM-then-mark is itself unsafe at READ COMMITTED (finding 4) — a duration edit between the aggregate and the UPDATE would bill hours that were never summed.

So the close **claims rows, it does not count them**:

```
1. SELECT id, duration_minutes, hourly_rate, currency_code
     FROM time_entries
    WHERE org_id = :org AND is_billable AND billing_status = 'not_billed'
      AND ended_at >= :periodStart AND ended_at < :periodEnd
    ORDER BY id
      FOR UPDATE                       -- same lock class and ORDER BY id as issueInvoice
2. compute consumed / overage / carried_out from exactly those locked rows
3. UPDATE ... SET billing_status = 'contract', contract_line_id = :line
    WHERE id = ANY(:lockedIds) AND billing_status = 'not_billed'
   -- RETURNING count must equal :lockedIds.length or the transaction aborts
4. INSERT the ledger row (ON CONFLICT DO NOTHING on the period key)
5. add the overage line if overage > 0
```

`ORDER BY id` matches `issueInvoice`'s ordering exactly, so the two paths cannot deadlock against each other; the loser blocks and then sees `SOURCE_ALREADY_BILLED` (a 409 the tech can act on) or finds nothing left to claim. Steps 2 and 3 read the same locked set, so the aggregate can never disagree with what was marked.

**Eligible entries** for period `[periodStart, periodEnd)`: `org_id = contract.org_id`, `is_billable`, `billing_status = 'not_billed'`, `ended_at IS NOT NULL AND ended_at >= periodStart AND ended_at < periodEnd`. `no_charge` never draws down (an explicit write-off). Non-billable time never draws down. A NULL `hourly_rate` entry **does** draw down — the unit is hours, not money, and the block is what pays for it (it also stops being an `invoiceAssembly` `missingRate` orphan). Unapproved time is Open Decision 4; currency is Open Decision 8.

**Aggregate math, never a split entry.** A 2.5 h entry straddling the block boundary cannot be expressed as "1 h absorbed, 1.5 h overage" on one row. So every eligible entry in the period is marked, and the overage is one line for `max(0, consumed − opening)` hours at `overage_rate`. No entry is ever split.

**`contract` must become a terminal disposition.** `BILLED_LOCKED_ENTRY_FIELDS` only fires when `billing_status === 'billed'` (`timeEntryService.ts:721`), so today a technician can flip a `contract`-marked entry back to `not_billed` and have it billed again ad hoc — the customer pays for the same hour twice (Codex 13, CONFIRMED). This slice extends that guard to `'contract'`. Correcting a mis-drawn entry then means an explicit adjustment, not a silent status flip; the mechanism is Open Decision 6's sibling and is called out in Out of scope.

**Period arithmetic.** `computePeriod(startDate, intervalMonths, idx)` from `contractMath.ts`, unchanged — the block's period *is* the contract's billing period. `periodEnd` is the next period's start, so the range is half-open `[start, end)` and the predicate uses `< periodEnd`, deliberately not `<=`, so a boundary entry is counted exactly once.

### 3. Rollover

```
opening      = included_hours + carried_in
carried_in   = previous CLOSED row's carried_out, or 0 if there is none
consumed     = SUM over the LOCKED rows, each entry's hours rounded to 2dp first
               (the same round-hours-first rule as timeEntryToLineSpec)
overage      = max(0, consumed - opening)
leftover     = max(0, opening - consumed)
carried_out  = 'none'         -> 0
               'carry_forward' -> min(leftover, rollover_cap_hours ?? leftover)
```

A missing previous row means `carried_in = 0`, never reconstructed. Because closes are contiguous and earliest-first, "missing" now means only "this is the first period of the block". Carried hours have no separate expiry (Open Decision 5).

### 4. Overage line generation

One line per closed period with `overage > 0`, added through `addContractLine` so it inherits the contract row lock, the B2 currency guard and `source_contract_id` lineage:

```
source_type  = 'contract'      (no new source type)
source_id    = the hour_block contract_lines.id
quantity     = overage hours, 2dp
unit_price   = overage_rate
description  = "<line description> — hours over block, <periodStart> – <periodEnd>"
taxable      = the hour_block line's own `taxable`
```

No `catalogItemId`, so no price-book gap path. A period with `overage = 0` still gets a ledger row and still marks its entries; it just adds no line.

**Lock-order note (Codex 5, CONFIRMED).** `generateDueInvoice` locks the contract first, then `addContractLine` locks invoice → contract. That is *not* the repo's documented invoice-first ordering; it is safe only because the invoice is brand new and uncommitted in this transaction, so nothing else can hold it. The first draft claimed the ordering was "inherited". It is an exception and must be documented as one in the code, not restated as the rule.

### 5. Visibility

- **`computeContractEstimate`** gains `hourBlock: { lineId, periodStart, periodEnd, includedHours, carriedInHours, consumedHours, unapprovedHours, remainingHours, overageHours, overageRate, alertPct } | null` for the **open** period, computed live; `null` when the contract has no live `hour_block` line.
- **`ContractDetail.tsx`**: a bar — *"6.5 of 10 h used · 3.5 h remaining · period ends 1 Oct"* — plus the overage rate and, past the block, *"2.0 h over block → \$300 at period close"*, and for advance-billed contracts a one-line note that overage bills on the following invoice.
- **`ContractEditor.tsx`**: the `hour_block` branch of the add-line form (included hours, rollover policy + cap, overage rate, alert %); site select hidden. New i18n keys in all eight `apps/web/src/locales/*/billing.json` (the `tr-TR` parity test fails on a miss).
- **Portal**: a read-only "Support hours" card gated by a new `portal_branding.enable_hour_block` defaulting to **false** — fail-closed, matching `enableAssetCheckout` (Open Decision 7). New route under `apps/api/src/routes/portal/` behind `createPortalFeatureGate`; the handler must read in a **system** context (partner-axis `time_entries`) while scoping explicitly to `auth.user.orgId` — the portal's own org scope will not do it for you here.
- **Threshold alert**: `hour_block_alert_pct` non-NULL → `runHourBlockAlertSweep()` in `contractWorker`, run before `runContractBillingSweep` in the same job, behind the same `buildAutomationEligibleOrgPredicate` archived-tenant gate. On first crossing it writes `user_notifications` (`type: 'system'`, `priority: 'high'`, `dedupe_key = 'hour_block:<lineId>:<periodStart>:<pct>'` — the partial unique index makes redelivery a no-op) and emits `contract.hour_block_threshold` on the existing `contract-events` bus. Recipients: active users of the contract's partner holding `contracts:read` with access to the org, falling back to `contracts.created_by`.

### 6. Docs

`apps/docs/src/content/docs/features/contracts.mdx` — a "Block hours" row in the Contract Lines table and a short section on drawdown, rollover, and the advance-billing one-period lag. Release-notes entry under billing.

## Tenancy & data model impact

### New table: `contract_hour_periods`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `contract_line_id` | `uuid NOT NULL` | |
| `contract_id` | `uuid NOT NULL` | denormalized for cheap per-contract reads |
| `org_id` | `uuid NOT NULL` | → `organizations(id)` — the RLS axis |
| `period_start`, `period_end` | `date NOT NULL` | half-open `[start, end)` |
| `included_hours`, `carried_in_hours`, `consumed_hours`, `overage_hours`, `carried_out_hours` | `numeric(10,2) NOT NULL` | frozen at close |
| `overage_rate` | `numeric(10,2)` | snapshot of the line's rate at close |
| `currency_code` | `char(3) NOT NULL` | snapshot of the contract's currency, never restamped |
| `overage_invoice_id` | `uuid` | NULL when overage was 0 |
| `closed_at` | `timestamptz NOT NULL` | rows only exist closed |
| `created_at` | `timestamptz NOT NULL` | |

- `UNIQUE (contract_line_id, period_start)` — the idempotency key, mirroring `contract_billing_periods_contract_period_uq`. A second close is an `ON CONFLICT DO NOTHING` no-op, which is what makes the close re-entrant.
- `INDEX (org_id)`, `INDEX (contract_id, period_start DESC)`.

**Composite, same-org FKs — not three independent ones (Codex 15, CONFIRMED).** Shape-1 RLS only checks the row's own `org_id`, so three plain FKs would let an RLS-valid org-B ledger row point at org-A's contract, line or invoice. All three are composite against existing unique indexes:

```
(contract_id, org_id)        -> contracts (id, org_id)        [contracts_id_org_uq]        ON DELETE CASCADE
(contract_line_id, org_id)   -> contract_lines (id, org_id)    [contract_lines_id_org_uq]   ON DELETE RESTRICT
(overage_invoice_id, org_id) -> invoices (id, org_id)          [invoices_id_org_uq]         ON DELETE SET NULL (overage_invoice_id)
```

`ON DELETE RESTRICT` on the line is what forces retire-instead-of-delete. `SET NULL` uses the PG 15+ column list so `org_id` (NOT NULL) is not nulled with it.

**All three must be `DEFERRABLE INITIALLY IMMEDIATE` (Codex 17, CONFIRMED).** `orgMerge` repoints `contract_lines` and `time_entries` in separate steps under `SET CONSTRAINTS ALL DEFERRED` (`orgMerge.ts:1022`); a non-deferrable composite FK aborts whichever repoint runs first. The same applies to the new `time_entries` FK below. This matches the org-lifecycle convention already used for `invoices(org_id, partner_id)`.

**RLS — Shape 1, direct `org_id`.** Verbatim copy of the `contract_billing_periods` block in `2026-06-15-d-recurring-contracts.sql`: `ENABLE` + `FORCE ROW LEVEL SECURITY` and four `breeze_org_isolation_{select,insert,update,delete}` policies on `public.breeze_has_org_access(org_id)`, in the same migration that creates the table. Not append-only, so no `AUDIT_ADMIN_REQUIRED_TABLES` entry — the org-erasure cascade must be able to delete these rows.

### `time_entries.contract_line_id`

Absorbed entries are stamped `contract_line_id` in the same UPDATE that sets `billing_status = 'contract'`, so attribution is free and durable. FK `(contract_line_id, org_id) → contract_lines (id, org_id)`, `DEFERRABLE INITIALLY IMMEDIATE`, `ON DELETE SET NULL (contract_line_id)` (PG 15+ column list; a bare `SET NULL` would also null `org_id`). Because `org_id` is nullable and composite FKs are `MATCH SIMPLE`, a NULL-`org_id` row would satisfy the FK vacuously — a CHECK `contract_line_id IS NULL OR org_id IS NOT NULL` closes that. Partial index on `(contract_line_id) WHERE contract_line_id IS NOT NULL`.

**Pre-existing gap this exposes (Codex 16, CONFIRMED — not introduced here).** `time_entries` has independent `partner_id` and `org_id` FKs and its RLS checks only `partner_id`, so partner A can already write a row with `org_id` = an org belonging to partner B. The new line FK does not close it (the line and org would agree with each other, just not with the partner). The real fix is the dual-axis composite FK `(org_id, partner_id) → organizations(id, partner_id)` that `users` already carries — which needs a mismatch audit and a backfill and is therefore its own PR. **Flagged, not silently absorbed.** Track it separately before shipping this.

### Registration lists (all in the same PR)

| List | File | Entry |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `services/tenantCascade.ts` | `'contract_hour_periods'` between `'contract_documents'` and `'contract_lines'` (alphabetical, `organizations` last — the contract test asserts the ordering). **Correction to the first draft:** delete *safety* comes from the runtime FK topological sort over `pg_catalog` (`tenantCascade.ts:690`), not from where the string lands in the array (Codex 18). Alphabetical placement satisfies the contract test; the topo sort is what stops the FK violation. |
| `CORE_TENANT_EXPORT_POLICY` | `services/tenantExportPolicyRegistry.ts` | new `contract_hour_periods` row, `tablePolicy("org_id", …)`, **every column `included`** — no `json`/`jsonb`/`bytea` column exists, and none may be added without an `excludedOpen` review. |
| `CORE_TENANT_EXPORT_POLICY` (existing rows) | same file | `contract_lines` gains all seven new columns; `time_entries` gains `contract_line_id`; `portal_branding` gains `enable_hour_block`. **This is the registration that fires on a new COLUMN, not just a new table** — three long-registered tables gain columns and missing any one reddens `tenant-export-policy.integration.test.ts` on main. |
| `REPOINT_TABLES` | `services/orgMergeRegistry.ts` | `'contract_hour_periods'` — a plain `org_id` repoint; no unique key can collide, and `contract_line_id` keeps the two banks distinguishable. |
| `rls-coverage.integration.test.ts` | `apps/api/src/__tests__/integration/` | no allowlist entry — Shape 1 direct-`org_id` tables are auto-discovered. |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `routes/devices/core.ts` | n/a — no `device_id`. |

### Migrations

Named to sort after the newest committed file. At drafting, `origin/main`'s newest is `2026-10-04-100000-ticket-requester-contact.sql`, and the unmerged `billing-by-units` branch (#3205) holds `2026-10-04-100000-contract-line-type-per-device-role.sql` and `2026-10-04-100100-contract-lines-device-roles.sql`. **Re-check `ls apps/api/migrations | sort | tail -1` at implementation time and rename if the ceiling has moved** — CLAUDE.md's ratchet means today's date is not automatically sort-last.

1. `2026-10-06-100000-contract-line-type-hour-block.sql` — the enum value alone: `ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'hour_block';`. Split from (2) because Postgres refuses to *reference* a value added by `ALTER TYPE … ADD VALUE` in the same transaction, and `autoMigrate` wraps each file in one (precedent `2026-09-05-b-audit-actor-type-ai-agent.sql`; the `-- @no-transaction` directive is the alternative and is not needed here).
2. `2026-10-06-100100-contract-lines-hour-block-columns.sql` — seven `ADD COLUMN IF NOT EXISTS`, the two-way CHECK (drop-then-add for idempotency), and the partial unique index on the live block per org.
3. `2026-10-06-100200-contract-hour-periods.sql` — `CREATE TABLE IF NOT EXISTS`, indexes, the three deferrable composite FKs, RLS enable + force + four policies (guarded by `pg_policies` existence checks); `time_entries.contract_line_id` + its deferrable composite FK + NULL-org CHECK + partial index; `portal_branding.enable_hour_block`.

No backfill and no data cleanup: every column is nullable or defaulted and no existing row changes, so there is nothing to `UPDATE` — hence no `set_config('breeze.scope','system',true)` preamble and no `GET DIAGNOSTICS` row count. **If review adds one, both are mandatory**: `time_entries` and `contract_lines` are FORCE-RLS, and a bare `UPDATE` on managed Postgres is a silent 0-row no-op that CI's superuser will not catch.

### Code touchpoints

`apps/api/src/db/schema/{contracts,timeTracking,portal}.ts` (new `contractHourPeriods` in `contracts.ts`) · `packages/shared/src/validators/{contracts,timeEntries}.ts` · `apps/api/src/services/contractService.ts` (`resolveLineQty`, `generateDueInvoice`, `computeContractEstimate`, `addContractLineToContract`, `removeContractLine`, `createContractWithLinesDetailed`), new `contractHourBlocks.ts` (pure period/rollover math + the claim query, kept out of the 1,194-line `contractService.ts`), `timeEntryService.ts` (the `contract` disposition lock), `tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `userNotifications.ts` · `apps/api/src/jobs/contractWorker.ts` · `apps/api/src/routes/contracts/`, `apps/api/src/routes/portal/` · `apps/web/src/components/contracts/{ContractEditor,ContractDetail}.tsx`, `apps/web/src/lib/api/contracts.ts`, `apps/web/src/locales/*/billing.json` · `apps/portal/src/` · `apps/docs/src/content/docs/features/contracts.mdx`.

`quoteToContract.ts` is unchanged: quote acceptance produces fixed `manual` lines and a quote cannot express a block. `aiToolsContracts.ts` wraps `contractLineInputSchema` directly, so the AI `add_line` tool enforces the new rules at runtime with no tool-side change — but its exposed schema types `line` as a generic object, so the tool **description** must spell out `hour_block` and its fields or the model cannot discover them.

## Out of scope

- **Site-scoped blocks.** `tickets` has no `site_id`, so a time entry cannot be attributed to a site at all. Not a preference — there is no data.
- **Multiple concurrent blocks per org** (e.g. one per ticket category). Needs per-entry attribution at write time; Open Decision 1.
- **Technician-chosen contract on a time entry.** The stamp is written by the close.
- **Backdated entries into an already-closed period.** A closed period cannot re-close (the unique key blocks it), so late-entered work bills ad hoc even though the block covered that month (Codex 14, CONFIRMED). Acceptable for slice 1 — the honest alternative is an append-only adjustment row, which is a feature. Documented behaviour, not a silent one: the contract detail shows a "N h entered after period close" note.
- **Adjustments / reversing a drawdown.** With `contract` now terminal, correcting a mis-drawn entry needs an audited adjustment mechanism. Deferred with the item above.
- **Term-length blocks that do not follow the billing period** ("40 hours across a 12-month term, billed monthly"). Open Decision 5 names the escape hatch.
- **Prepaid dollar retainers** (a money bank, not an hour bank). Same table shape, different unit; a separate feature.
- **Drawdown from `ticket_parts`.** Blocks are labor.
- **The `time_entries` cross-partner `org_id` forge.** Pre-existing, flagged above, its own PR.
- **Reporting/utilization (#3198)** and the portal self-service billing surface (#3981) beyond the single hours card.

## Open Decisions

Numbered for Todd's answers. Each carries a recommendation. Where Codex and I disagree the disagreement is stated rather than resolved silently.

**1. How is a time entry attributed to a block?**
- **A — One live block per org, org-wide aggregate drawdown**, DB-enforced by the partial unique index; no `contract_id` on `time_entries`. Pro: no new column on a hot partner-axis table, no picker, no backfill; attribution is correct as of *close*, not as of a possibly-stale write. Con: a second block later needs per-entry attribution — the retrofit CLAUDE.md warns about.
- **B — `time_entries.contract_id` stamped at entry creation.** Pro: multiple blocks from day one. Con: an entry created before the block existed, or edited later, carries stale attribution, and all five creation paths (manual, timer, location, remote session, support session) must resolve it.
- **C — A now, with the close-time `contract_line_id` stamp designed in** (which this spec does), so B becomes purely additive: the column exists; the future change is "also settable at write time".
- **Recommend C** — A's cost with B's exit, and the stamp rides an UPDATE that already runs.

**2. Ledger row at close only, or a row for the open period too?**
- **A — Close only.** Open period computed live from the last closed row + a locked `SUM`. Reads never write; no stale cache; alert idempotency via `dedupe_key`.
- **B — Row at period open, `consumed_hours` refreshed daily, frozen at close.** Pro: one cheap row read serves the portal. Con: a `consumed_hours` that is stale between sweeps will be believed, and a GET that creates rows is a write on a read path.
- **Recommend A** (Codex agreed). The live aggregate is one indexed scan over a period's entries.

**3. What happens to hours past the block?**
- **A — `overage_rate` required; every eligible entry absorbed; one aggregate overage line.** Pro: exact aggregate math, never splits an entry, bills the *contracted* rate. Con: per-ticket labor detail vanishes from the invoice — the customer sees "3.5 h over block", not which tickets.
- **B — "Soft block": `overage_rate` nullable; absorb whole entries in `ended_at, id` order until full, leave the rest to bill ad hoc at their own rates.** Pro: itemized detail survives. Con: the straddling entry cannot be split, so part of the block goes unused, and two rate sources decide one bill.
- **C — Overage at each entry's own `hourly_rate`.** Same splitting problem, and the contract's overage rate becomes decorative.
- **Recommend A.** The demo ask was "hours beyond the block bill at an overage rate"; A is the only option where that is literally true.

**4. Does unapproved time draw down?**
- **A — Yes.** Matches `invoiceAssembly`, which bills unapproved time and merely flags it. The balance tracks reality; no jump when a batch is approved.
- **B — No; only `is_approved = true` draws down.** Pro: the bank does not move on unreviewed time. Con: "remaining" is optimistic and drops without warning, and a period can close with hours pending approval that then have nowhere to go (they are now the backdated-entry problem).
- **Recommend A**, with unapproved hours shown as a sub-figure ("6.5 h used, 1.0 h of it unapproved") so the exposure is visible.

**5. Do carried-forward hours expire?**
- **A — No expiry.** `carried_out` accumulates, capped by `rollover_cap_hours`. The cap is the term MSPs actually negotiate.
- **B — `rollover_expiry_periods`**, carried hours consumed first and voided after N periods. Needs per-vintage buckets, not one scalar.
- **Recommend A.** B is FIFO hour vintages — a feature, not a column.

**6. How does the FINAL period close on expiry or cancellation?**
`generateDueInvoice` marks a contract `expired` and clears `next_billing_at` in the same run that bills the last period (`contractService.ts:1095`), and `cancelContract` clears it too — and the worker only selects `active` contracts. So **the last period can never close through the billing path** (Codex 11, CONFIRMED); this needs a lifecycle hook, not logic inside generation.
- **A — A close-out step on the expire/cancel transitions**: close the final claimed period, and when overage > 0 create a **draft** invoice (never auto-issued, whatever `auto_issue` says) so a human sees it first.
- **B — Close the ledger and mark the entries, never invoice.** The MSP eats the overage. Predictable; loses money.
- **C — Do nothing; entries stay `not_billed` and bill ad hoc.** **This overbills** — hours inside the paid block get charged again at the ad-hoc rate.
- **Recommend A.** **C must not ship.**

**7. Is the portal hours card on by default?**
- **A — `portal_branding.enable_hour_block` defaults to `false`** (fail-closed, matching `enableAssetCheckout`). No customer discovers a bank the MSP has not mentioned; no self-hoster's portal changes on upgrade.
- **B — Defaults to `true`** (fail-open, matching `enableTickets`). The visibility the feature exists for reaches the customer without a second step.
- **Recommend A.** Billing visibility is where a surprise is expensive.

**8. Do entries stamped in a different currency draw down? — FABLE AND CODEX DISAGREE.**
Background: `time_entries.currency_code` is stamped from the org at creation and never restamped; a contract keeps its own stamp after an org currency change. A mismatch therefore means the org changed currency mid-contract.
- **A (Fable's first position) — No.** Absorbing marks the entry `contract`, permanently removing it from the ad-hoc invoice it would otherwise land on *in its own currency*. That is a silent cross-currency fold, exactly what `partitionByCurrency` / `blockedByCurrency` exist to prevent, and the repo's rule is that a mismatched row is reported, never quietly re-homed. Report them as a gap instead.
- **B (Codex's position, finding 12, CONFIRMED) — Yes, absorb regardless of currency.** Drawdown moves *hours*, not money: no conversion happens, and the overage is priced from the contract's own rate. Refusing means the customer pays the block fee **and** gets billed ad hoc for the very hours the block was supposed to cover — an economic double charge, and the prepaid hours expire unused. `blockedByCurrency` protects monetary *line assembly*; a drawdown is not a line.
- **Recommend B**, Codex's position. B is the stronger argument: A protects a rule at the cost of double-charging a customer, and the underlying anomaly (a contract stamped in a currency the org no longer uses) already has its own surface — the `GET /contracts/currency-mismatches` report. Mitigation: report mixed-currency drawdowns as an informational note on the estimate and in the worker log so the mis-stamp is visible, and add an integration test that proves no monetary conversion occurs.

## Test & rollout notes

Red first for each unit.

**Pure unit (no DB)** — new `contractHourBlocks.ts`, table-driven: opening/consumed/overage/carried-out across `none` and `carry_forward`, cap hit and not hit, `carried_in = 0` on the first period, consumed exactly equal to opening (overage 0, carried_out 0), consumed 0, hours rounding (20 min × 3 = 0.33 × 3 = 0.99, not 1.00 — the round-first rule); and the **closable-period selector**: earliest-first, contiguous, skips unclaimed periods, skips periods before `hour_block_first_period_start`, correct for both timings, and stops at the 12-period cap.

**Validators** — `hour_block` requires `included_hours > 0`, `rollover_policy`, `overage_rate`; every other type rejects all seven fields; `rollover_cap_hours` rejected under `'none'`; `site_id` rejected; `alert_pct` bounds; `hour_block_first_period_start` rejected from the client payload (server-stamped).

**Migration / RLS, real DB as `breeze_app`** — the CHECK truth table (each required field NULL on a block line; each field set on a `flat` line; `included_hours = 0`; cap under `'none'`; `alert_pct` 0 and 101); the partial unique index rejects a second live block for the org and *accepts* one when the first is retired; `time_entries.contract_line_id` set with `org_id` NULL rejected by the CHECK; a line from another org rejected by the composite FK; **all four new FKs verified `DEFERRABLE INITIALLY IMMEDIATE`** and an `orgMerge` repoint of `contract_lines` + `time_entries` succeeding under `SET CONSTRAINTS ALL DEFERRED`; deleting a block line with a closed period rejected by `ON DELETE RESTRICT`; cross-org ledger forge fails **42501**; a select under org B's context returns zero rows; `UNIQUE (contract_line_id, period_start)` blocks a double close. `autoMigrate.test.ts` covers the three-file ordering.

**Service, real DB** — arrears: fee and overage on one invoice. Advance: fee this run, that period's overage on the *next* run with the period dates in the description. Zero-overage period yields a ledger row, marked entries, no line. Carry-forward chains across three periods. Re-running a closed period is a no-op. **A pause/resume gap grants no hours** (the unclaimed periods are never closed) — the regression test for Codex 10. **A block added mid-period on an active advance contract does not absorb that period** — Codex 9. A `no_charge` and a non-billable entry are ignored. A second live block for the org is rejected. Deleting a block with history retires it and the ledger survives.

**Concurrency, real DB (must be concurrent, not sequential — Codex 3)** — two transactions: a block close and an `issueInvoice` over the same entries. Assert one wins, the other gets a clean 409 `SOURCE_ALREADY_BILLED` (never a 500, never a deadlock), and no entry ends up on both an invoice and a ledger. Second case: an entry's `duration_minutes` edited concurrently with a close — the ledger's `consumed_hours` must match exactly the rows it marked. Third: a technician attempting to flip a `contract` entry back to `not_billed` gets 409 `ENTRY_BILLED`.

**Worker** — `runHourBlockAlertSweep` crosses the threshold once and writes one notification; a second sweep the same period writes none (dedupe key); `alert_pct` NULL is skipped; an archived tenant is skipped by the same predicate the billing sweep uses; and the sweep reads in a **system** context — assert explicitly that an org-scoped context sees zero `time_entries`, which is the partner-axis trap.

**Export/erasure** — `tenant-export-policy.integration.test.ts` (three column-classification changes plus the new table) and `tenantExportErasureRoundtrip.integration.test.ts` extended to seed a contract with an `hour_block` line and a closed period, so `contract_hour_periods.json` appears in the manifest and the erasure half deletes it. `tenantCascade.integration.test.ts` for ordering; the `orgMerge` contract test for the repoint entry.

**Web/portal** — `ContractEditor.test.tsx` (block branch renders, payload shape, cap disabled under `'none'`, site select hidden); `ContractDetail` (bar, over-block state, advance-lag note, zero state); the portal card and its 403 when the flag is off; `tr-TR` locale parity.

**Manual, as `breeze_app` in psql** — forge a `contract_hour_periods` row for another org (must fail 42501); insert an `hour_block` line with `included_hours = NULL` (must fail the CHECK). Run `pnpm db:check-drift`.

**Rollout.** No API feature flag: the line type is opt-in per line and no existing contract changes behaviour. The portal surface is gated by `portal_branding.enable_hour_block`, default false (Open Decision 7). No backfill, so no staged deploy. Because the close writes to `time_entries` from the billing worker and now takes row locks there, the first production billing sweep after the release should be watched for lock waits: the worker's per-contract try/catch isolates a failure to one contract, and the period unique key makes a retry safe.

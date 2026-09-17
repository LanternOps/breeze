# Billing profiles and work types — design

Status: **draft, awaiting Todd's approval (Gate A)**.
Issues: LanternOps/breeze#4628 (billing profiles / rate cards, community, anchor) and
LanternOps/breeze#4615 (activity-type codes on time entries) — **one spec for both**, per
Todd's 2026-09-02 comment on #4628: the rate dimension is built once.
Advisor quorum: Fable position formed first; independent read-only review by an Opus
subagent, which verified its findings against the code. **Codex was unavailable** (flat-sub
usage cap until 2026-09-19 11:38), so the usual Codex `xhigh` seat was substituted. Ten
confirmed defects from the first draft are folded in. See §11 "Quorum record".

One decision was made by Todd before this spec and is **not open**: the resolved billing
terms are **stamped on the time entry**, and a later edit to a profile, a rule or an org's
assignment never rewrites an existing entry.

---

## 1. Problem

An MSP runs several commercial models at once: standard T&M, negotiated T&M, and managed
packages where some labour is included and the rest bills at package rates. Breeze can
express none of that. Today's chain (`resolveTicketLink`,
`apps/api/src/services/timeEntryService.ts:241-269`, ticketing-config spec D6) is:

> per-entry override → org blanket default (`org_ticket_settings`) → ticket-category
> default (`ticket_categories`) → `false` / `NULL`

Three structural gaps:

1. **No work-type dimension.** A rate hangs off the *ticket's category*, so one ticket
   cannot carry "1 h remote + 0.5 h on-site" at different rates (#4615). `time_entries.source`
   is provenance (`manual | timer | remote_session | …`), not a labour classification.
2. **The org default is one blanket number.** It cannot say "remote is included, on-site is
   $200, after-hours is $300". Category defaults are partner-wide, so they cannot vary by
   customer either. The only workaround is a duplicate category set per package.
3. **No minimums or rounding anywhere.** `timeEntryToLineSpec`
   (`services/invoiceAssembly.ts:88-99`) bills `duration_minutes / 60 × hourly_rate`, one
   invoice line per entry. A one-hour on-site minimum is applied by hand at invoice review.

And one governance gap: any holder of `time_entries:write` can set `hourlyRate`,
`isBillable` and `billingStatus` on an entry (`updateTimeEntry`, no further check). A
technician has to *know* the customer's commercial terms and can silently deviate from them.

The operating principle from #4628, adopted here: **technicians say what work they did;
Breeze decides how the customer bought it.**

## 2. Users and scope

| Actor | Does |
|---|---|
| Partner admin / billing manager | Defines work types and billing profiles once, partner-wide; assigns a profile to each org; overrides a stamped entry when the work was out of scope. |
| Technician | Picks a work type when logging time. Sees the outcome ("Included in Silver", "$225/h · 1 h minimum"). Does not pick a rate. |
| Approver | Reviews entries as today; the stamped source (`profile`, `manual`, …) tells them which entries deviate from the card. |
| Org-scoped users | **Nothing.** Labour billing is partner-side: `time_entries` is partner-axis RLS and an org token fails `breeze_has_partner_access`. Every table here follows suit. |
| Portal customers | No rates, no profiles. They *do* already see hours: `services/portal/supportUsage.ts` reads `time_entries` in system context and buckets `contract` entries as "covered by contract" — which is exactly where included work should land (§3.5, §3.6). |

Partner-Wide First (epic #2135) is satisfied natively: both new config objects are
**partner-owned and reused across orgs**. They are deliberately *not* `org_id XOR
partner_id` dual-ownership — see §4.1 for the justification the rule asks for.

## 3. Proposed design

### 3.1 Four primitives

1. **Work type** — partner-owned taxonomy of labour: Remote, On-site, Project, After-hours,
   Emergency. Lives on the **time entry**, not the ticket, so one ticket can mix them.
   Carries **no rates** (§3.3).
2. **Billing profile** — partner-owned, reusable, cloneable rate card in **one currency**.
   One profile per partner per currency may be the **default**.
3. **Billing profile rule** — one row per (profile, work type): coverage `included |
   billable`, hourly rate, minimum minutes, rounding increment, internal notes. Profiles are
   **sparse**: a missing rule falls through the chain in §3.4.
4. **Org assignment** — at most one profile per org.

Ticket categories stay what they are — a classification of the *problem* (network, email,
hardware) that drives SLA and routing. They gain one nullable column,
`default_work_type_id`, so "Project" tickets default the picker to "Project Work". Their
`default_hourly_rate` / `default_billable` remain as the legacy tail of the chain; nothing
is migrated or removed.

### 3.2 Work type on the entry

`time_entries.work_type_id`, nullable. Default when the caller sends none:

> explicit `workTypeId` → ticket category's `default_work_type_id` → partner's default work
> type (`work_types.is_default`) → `NULL`

Every *creation* goes through `createTimeEntry` or `startTimer` (REST, office add-in, AI/MCP
tools, suggestion confirm, `intentReleaseWorker`, mobile `create`), so the default chain
makes **old clients safe**: a mobile build with no picker still gets a work type and
therefore the right rule.

**Timers resolve at start; the work type changes only by an explicit `PATCH workTypeId`.**
There is no "work type at stop" in this design, for two verified reasons: `stopRunningEntry`
(`timeEntryService.ts:565-582`) is a single-statement CAS that never reads the row and
holds no ticket lock, so it cannot re-resolve without inverting the global tickets →
time_entries lock order; and mobile never calls `/stop` — queue v2 replays a stop as
`PATCH /time-entries/:id { endedAt }` (`apps/mobile/src/services/timeEntryReplay.ts`). All
re-resolution therefore lives in `updateTimeEntry`, which already takes the locks in the
right order. The technician who started remote and ended up on-site edits the entry.

**A partner with zero work types behaves exactly as today.** No flag, no mode switch: with
`work_type_id` NULL the resolver skips straight to the legacy chain (#4615 acceptance
criterion "entries with no activity type bill exactly as today").

### 3.3 Rates live only on profiles

#4615 proposed a default rate on the activity type. Rejected: it would give "standard
rates" two homes (the work type and the default profile) and an undefined winner. Instead
the partner's **default profile is the standard rate card**, and the work type is a pure
label. #4615's "partner can manage activity types with default rates" is met by work types
+ the default profile.

### 3.4 Resolution chain

One pure function, `resolveBillingRule()` in a new
`apps/api/src/services/billingRuleResolver.ts` — no DB, no I/O, the
`contractAllowance.ts` pattern — so create, timer, edit, the UI prefill, the org preview
and `aiTimeEntryProposal.ts` cannot disagree. For an entry in org **O** (currency **C**)
with work type **W**:

| # | Source | Hits when | `rate_source` |
|---|---|---|---|
| 1 | Per-entry override | an authorised caller sends billing fields that differ from what steps 2–6 resolve (§3.7) | `manual` |
| 2 | O's assigned profile | it is active, its currency = C, and it has a rule for W | `profile` |
| 3 | O's blanket default | `org_ticket_settings.default_hourly_rate` is set in currency C | `org_default` |
| 4 | Partner default profile for C | it has a rule for W | `default_profile` |
| 5 | Ticket category default | `default_hourly_rate` is set in currency C | `category_default` |
| 6 | None | — (rate `NULL`) | `none` |

- Steps 2 and 4 need W; with no work type they are skipped. Steps 3, 5, 6 resolve
  `is_billable` with today's unchanged expression
  (`org.defaultBillable ?? category.defaultBillable ?? false`), independently of where the
  rate came from. That can yield a non-billable entry carrying a rate (org
  `defaultBillable = false` + a default rate). It is today's behaviour and it is
  deliberate for some orgs (all-inclusive client, rate kept for reporting); "fixing" it
  here would start billing them. The legacy steps stay byte-for-byte legacy.
- **Match-or-skip** (multi-currency spec §7) applies at the *profile* level: a profile in
  the wrong currency is skipped whole, never converted. Assignment rejects a mismatched
  profile up front (409 `PROFILE_CURRENCY_MISMATCH`); a mismatch that arises later is
  skipped and bannered on the org page.
- Step 3 sits **above** step 4 on purpose (Open Decision 1): an org that pays a negotiated
  blanket $90 today must not jump to the standard card's $150 on-site rate the day the
  partner creates a default profile.
- Resolution keys on the **org**, not the ticket, so W06 org-linked suggestion entries
  (no ticket) resolve too. Standalone entries (no org) keep today's behaviour; a work type
  may still be set for reporting.

### 3.5 What a rule stamps

| Rule | Stamped on the entry |
|---|---|
| `billable`, rate R | `is_billable = true`, `billing_status = 'not_billed'`, `hourly_rate = R`, `minimum_minutes`, `rounding_increment_minutes` |
| `billable`, no rate | same with `hourly_rate = NULL` → lands in invoice assembly's existing `missingRate` bucket; a human prices it ("package-specific" in the issue's Gold row) |
| `included` | `is_billable = true`, `billing_status = 'contract'`, **`hourly_rate = NULL`**, `included_value_rate` = the rule's optional nominal rate, no minimum / increment |

Always also: `work_type_id`, `billing_profile_id` (the profile that produced the rule,
`NULL` for legacy sources), `rate_source`, **`coverage`** (`included | billable`, `NULL` on
legacy sources) and the existing `currency_code` snapshot. `coverage` is stamped rather than
inferred because `billing_status = 'contract'` has three writers — a profile, a block-hours
close (`contract_line_id` set), and a technician by hand today
(`assertRoutineBillingStatus` reserves only `billed`) — and because a billing manager may
later flip an included entry to `not_billed` (§5a), after which "what did the card say" is
unrecoverable from status alone.

**Included = `is_billable` + `billing_status = 'contract'`** (Open Decision 2). `contract`
already exists in the enum, already means "covered by the customer's contract", and the
portal already shows it that way. It keeps included work distinguishable from internal
non-billable time, which is what utilization and profitability reporting need.

**The nominal rate gets its own column, never `hourly_rate`.** The first draft put it in
`hourly_rate` on the claim that every money reader skips `contract`. That is false:
`getTicketBillingSummary` (`timeEntryService.ts:1243-1258`), `listBillables` (+ the billing
CSV, `routes/tickets/export.ts`) and the weekly-timesheet money loop all filter on
`is_billable AND hourly_rate IS NOT NULL` with **no status predicate**. With
`hourly_rate = NULL` on included work, every existing and future
`is_billable + hourly_rate` reader is correct by construction, and
`included_value_rate × hours` still lets a QBR say "we delivered $4,200 of included remote
support" from a snapshot. It is denominated in the entry's `currency_code`; included only
ever arises from a profile, which requires an org, so the currency is always stamped.
The ticket billing summary gains an `includedMinutes` figure beside `billableMinutes`
(which today counts every `is_billable` row regardless of status).

### 3.6 Minimums and rounding

Per **entry** (Open Decision 3), the ConnectWise / Autotask / Halo convention:

```
billable_minutes = GREATEST(
  COALESCE(minimum_minutes, 0),
  CASE WHEN rounding_increment_minutes > 0
       THEN CEIL(duration_minutes::numeric / rounding_increment_minutes) * rounding_increment_minutes
       ELSE duration_minutes END)
```

`billable_minutes` is a **plain column written by the service, pinned by a CHECK carrying
the identical expression** (`billable_minutes IS NULL OR billable_minutes = GREATEST(…)`),
`NULL` while a timer runs and on every pre-feature row. One TS pure function
(`computeBillableMinutes`, needed anyway for the UI hint and the defaults endpoint) and one
exported SQL fragment (for `stopRunningEntry`'s CAS, which computes duration in SQL from the
row's own stamped terms — no ticket read needed); the CHECK makes drift between them a
constraint violation, not a billing bug. A stored generated column was the first draft and
is rejected: `ADD COLUMN … GENERATED … STORED` rewrites the whole table under ACCESS
EXCLUSIVE on a hot billing table, the two existing generated columns in this database
(`device_event_logs.search_vector`, `td_synnex_price_availability.search_text`) are both
absent from the Drizzle schema, and `pnpm db:check-drift` cannot see this class of drift
(`scripts/check-drift.ts` replays migrations; it does not compare Drizzle to the DB).
The *terms* (`minimum_minutes`, `rounding_increment_minutes`) are the stamp; an authorised
user adjusts the billed quantity by editing the terms, never the derived number.

Consumers switch from `duration_minutes` to `COALESCE(billable_minutes, duration_minutes)`
for **money and billed quantity** only: `timeEntryToLineSpec`, `partitionTimeEntries`,
`getTicketBillingSummary`, `listBillables`, the weekly-timesheet amounts, the billing CSV,
and the portal's `supportUsage` billed / unbilled buckets (so the hours a customer sees
match the hours on their invoice). Utilization and timesheet *durations* keep **actual**
minutes. When the two differ the invoice line says so
(`On-site Support — 0.50 h worked, 1.00 h minimum`). Lines stay one per entry.

### 3.7 Overrides, edits and re-resolution

**Never re-resolved by a config edit.** Editing a rule, archiving a profile, reassigning an
org — none touches an existing entry.

**Re-resolved by an edit to the entry itself** — in `updateTimeEntry` only — while
`billing_status <> 'billed'` and `rate_source <> 'manual'`: changing `workTypeId`;
relinking `ticketId` (today a relink keeps the old org's rate — a latent bug this closes).
An authorised `resetBilling: true` on PATCH clears a manual override and re-resolves.
`billable_minutes` is recomputed whenever duration or the terms change, including at stop. Any edit
still clears approval (existing spec §3). `work_type_id`, the two term columns and
`billing_profile_id` join `BILLED_LOCKED_ENTRY_FIELDS`.

**Override gate** (Open Decision 4). New permission `time_entries:manage_billing`,
**enforced in the service, not the route**: `TimeEntryActor` gains `manageBilling: boolean`
(the `manageAll` precedent, `timeEntryService.ts:79-95`), defaulting to `false` in every
actor builder. A route-level gate would be bypassed by the non-route callers that pass
billing fields straight through today — `aiToolsTicketing.ts:1005-1013` (`hourlyRate`),
`:1055-1062` (`isBillable`), the office add-in, `intentReleaseWorker`. It is required to set
`hourlyRate`, `billingStatus`, `minimumMinutes`, `roundingIncrementMinutes` or
`resetBilling` to a value that **differs from the resolved one** on an entry **governed by
a card** (`rate_source IN ('profile','default_profile')`, or would be after the edit).
Two deliberate softenings:

- *Echo is not an override.* `TicketTimeBilling` prefills the rate and posts it back; a
  value equal to the resolved one keeps its resolved `rate_source`. Compared as
  **normalised numerics** (`'225'` = `'225.00'` = `225`), never as strings.
- *`isBillable` and `workTypeId` stay technician-editable.* Both answer "what work was
  this", which is the technician's knowledge and the feature's own principle. Changing a
  work type re-prices the entry, but only ever to **another card price**, and creation is
  open anyway (gating the edit would be defeated by delete-and-recreate). The control is
  the existing one: every edit clears approval, and the approval queue shows work type,
  coverage and source.

Legacy-mode entries (`org_default`, `category_default`, `none`) keep today's open
behaviour, so nothing changes for a partner until they create a profile.

**Who holds it.** Partner roles are per-partner *copies* snapshotted at creation
(`services/partnerCreate.ts:149-175`); `seedRoles` reconciles only the global templates.
Partner Admin copies hold `*:*` and pass with no data change. This feature ships **no
row-writing reconcile migration**: the permission joins the catalogue and the templates for
new partners, and an existing partner grants it through the role editor. (The first draft
nominated "Partner Billing" — that role holds no `time_entries:read/write` at all, so it
could not use the grant.) If Todd wants it pushed to existing non-admin roles, that is a
separate migration that INSERTs `role_permissions`, must open with
`SELECT set_config('breeze.scope','system',true);`, and must not join the
`migrationRlsScope.test.ts` baseline.

### 3.8 Invoice behaviour

Included entries never reach an invoice (status `contract`). Billable entries arrive with
the customer-specific rate and billed quantity already stamped, so assembly needs review,
not re-rating. `blockedByCurrency` and `missingRate` behave as today. Time lines keep
`catalogItemId: null`; mapping a work type to a catalog / QuickBooks service item is a
follow-up (§8).

## 4. Tenancy and data model impact

### 4.1 Why partner-axis, not dual-ownership

The Partner-Wide First rule asks every new config table to justify not being `org_id XOR
partner_id`. Justification: a work type is picked by a technician working *across* orgs and
referenced by partner-owned rules, so an org-owned work type is unreachable by design; and
an "org-specific rate card" is exactly a partner-owned profile assigned to one org (clone
→ rename → assign), which is the issue's own "Customer ABC – Negotiated T&M" example.
Precedent: `ticket_categories` (partner-axis) beside `org_ticket_settings` (org-axis).
There is no org-scoped reader of *rates*: org tokens (including org-scoped API keys,
`middleware/apiKeyAuth.ts`) fail `breeze_has_partner_access`, so they cannot read or write
`time_entries` today, and the portal reads entries in system context without ever touching
a rate card. These tables must **not** be added to `DUAL_AXIS_TENANT_TABLES` or
`PARTNER_WIDE_SELECT_BRANCH_EXEMPT` (the latter is a shrink-only ratchet at ceiling 0 — any
new entry fails CI).

### 4.2 `work_types` — shape 3 (partner-axis)

`id`, `partner_id` NOT NULL → `partners`, `name` varchar(100), `description`, `sort_order`,
`is_active` (archive, never hard-delete once referenced), `is_default`, timestamps.
`UNIQUE (partner_id, lower(name))`; `UNIQUE (id, partner_id)` (composite-FK target);
partial unique `(partner_id) WHERE is_default AND is_active`.
Policy: `breeze_has_partner_access(partner_id)`, ENABLE + FORCE, in the creating migration.
Register in `PARTNER_TENANT_TABLES`.

### 4.3 `billing_profiles` — shape 3

`id`, `partner_id` NOT NULL, `name`, `description` (internal), `currency_code` char(3) NOT
NULL → `supported_currencies`, `is_default`, `is_active`, `created_by`, timestamps.
`UNIQUE (partner_id, lower(name))`; `UNIQUE (id, partner_id)`; partial unique
`(partner_id, currency_code) WHERE is_default AND is_active`. `currency_code` is immutable
once the profile has a rule with a rate (same lock idea as a document with a monetary line).

### 4.4 `billing_profile_rules` — shape 3, owner column copied

`id`, `partner_id` NOT NULL, `billing_profile_id`, `work_type_id`, `coverage` varchar(16)
CHECK `IN ('included','billable')`, `hourly_rate` numeric(10,2) NULL (for an `included` rule
this is the nominal value rate, stamped to `included_value_rate`), `minimum_minutes` int
NULL CHECK `> 0`, `rounding_increment_minutes` int NULL CHECK `BETWEEN 1 AND 480`, `notes`,
timestamps. `UNIQUE (billing_profile_id, work_type_id)`.
CHECK `coverage = 'billable' OR (minimum_minutes IS NULL AND rounding_increment_minutes IS NULL)`.
Composite FKs `(billing_profile_id, partner_id) → billing_profiles(id, partner_id) ON
DELETE CASCADE` and `(work_type_id, partner_id) → work_types(id, partner_id)` (NO ACTION) —
a rule can never join a profile and a work type from different partners. FK checks bypass
RLS, so this must be structural, not app-layer.

### 4.5 `org_billing_profile_assignments` — shape 3 with a denormalized `org_id`

`id`, `org_id` NOT NULL **UNIQUE**, `partner_id` NOT NULL, `billing_profile_id` NOT NULL,
`assigned_by`, timestamps.

- `(org_id, partner_id) → organizations(id, partner_id)` — **`DEFERRABLE INITIALLY
  IMMEDIATE`** (org-merge contract; mirrors `time_entries_org_partner_fk`).
- `(billing_profile_id, partner_id) → billing_profiles(id, partner_id)` (NO ACTION — a
  profile in use is archived, not deleted).
- Policy: plain `breeze_has_partner_access(partner_id)` — exactly how `time_entries` solves
  the same problem. The org axis is applied **app-layer** (`orgAxisSql` /
  `entryOrgAllowed`, `timeEntryService.ts:718-733`) so a `selected`-org partner user never
  sees an ungranted org's assignment. The first draft used a conjunctive
  `partner AND breeze_has_org_access(org_id)` policy; rejected because
  `breeze.accessible_org_ids` is built with `status IN ('active','trial') AND deleted_at IS
  NULL` even for `orgAccess = 'all'` (`middleware/auth.ts:410-420`), so the assignment of
  every suspended or archived org would silently vanish — "Used by N orgs" undercounts and
  a request-context UPDATE matches zero rows — while that org's `time_entries` stay visible.
  An org token still cannot read or write the table: it fails the partner predicate.

**Why a table and not `org_ticket_settings.billing_profile_id`** (Open Decision 6).
(i) `org_ticket_settings` is org-axis and org-token-readable; an MSP's commercial terms do
not belong on a row the customer's own token can reach. (ii) FK checks bypass RLS, so
same-partner integrity has to be structural; this table gets it from two composite FKs,
whereas `org_ticket_settings` has no `partner_id` to build one on. (iii) Effective-dated
assignment ("Bronze → Silver on 1 October") becomes additive later: relax the unique to
`(org_id, effective_from)`.

### 4.6 New columns on existing tables

`time_entries`: `work_type_id`, `billing_profile_id` (both with composite
`(…, partner_id)` FKs to their shape-3 parents, NO ACTION), `rate_source` varchar(24) CHECK
`IN ('manual','profile','default_profile','org_default','category_default','none')`
(NULL = pre-feature row), `coverage` varchar(16) CHECK `IN ('included','billable')`,
`included_value_rate` numeric(10,2), `minimum_minutes`, `rounding_increment_minutes`,
`billable_minutes` int + the §3.6 CHECK (added `NOT VALID` then validated; every existing
row is `NULL` and passes). All nullable, no default, so **no table rewrite**. CHECK
`included_value_rate IS NULL OR coverage = 'included'`. Indexes on
`(partner_id, work_type_id)` and `(billing_profile_id)`. No backfill — old rows stay NULL
and read as "legacy".

`ticket_categories`: `default_work_type_id` with a composite `(…, partner_id)` FK.

### 4.7 Registration lists

| List | Owes |
|---|---|
| `PARTNER_TENANT_TABLES` (`rls-coverage.integration.test.ts`) | all four new tables |
| `ORG_AXIS_POLICY_EXCLUDED_TABLES` (same file, `:124`) | `org_billing_profile_assignments` — it carries `org_id` under a partner-axis policy, the "dual-list trap" the file's own comments name; `time_entries` is the precedent |
| `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`) | `org_billing_profile_assignments` (alphabetical; it is an FK *child* of `organizations` only) |
| `CORE_TENANT_EXPORT_POLICY` | the new assignment table **and the eight new `time_entries` columns** (`ADD COLUMN` on a registered table fires this). All `included`; no jsonb anywhere in this design. Partner-axis tables with no `org_id` need no entry |
| Audit log | work type, profile, rule and assignment mutations each record an audit event with before / after values. Stamping makes "what did the card say on 3 March" answerable **only** if rule edits are recorded — this is what an MSP is asked to prove in a billing dispute |
| `orgMergeRegistry.ts` | `org_billing_profile_assignments: { kind: 'keep-survivor' }` — same as `org_ticket_settings` (unique `org_id`) |
| `TICKET_ORG_DENORMALIZED_TABLES` / `CUSTOM_ORG_REWRITE_TABLES` | nothing new — `time_entries` is already there; the new columns are partner-keyed and survive an org move. The stamp is **not** re-resolved by an org move (snapshot rule, same as currency) |
| Device cascade lists | n/a (no `device_id`) |
| Partner erasure | **not-checked.** `tenantCascade.ts` exports no partner-level list; `time_entries` and `ticket_categories` now reference `work_types` / `billing_profiles` with NO ACTION FKs, so the plan must find where `ticket_categories` is removed on partner deletion and order the new tables after their referrers |

### 4.8 Migrations

DDL only, idempotent, no row writes (so no `breeze.scope` election is needed) and **no
seeding in SQL** — the standard five work types come from an explicit "Add standard work
types" button (`POST /work-types/seed-standard`). Filenames must sort after the newest
committed migration at authoring time (`2026-10-17-140000-…` as of this spec).

## 5. Cross-spec contracts

- **Block hours (#4547, approved, not yet planned).** Two amendments, cheap now:
  (a) `contract` is **terminal only when `contract_line_id IS NOT NULL`** (absorbed by a
  block at close). A profile-included entry (`contract_line_id IS NULL`) stays editable by a
  billing manager — flipping it to `not_billed` is how out-of-scope work gets billed.
  (b) Drawdown reads `COALESCE(billable_minutes, duration_minutes)`, so a one-hour minimum
  draws one hour.
  (c) **Asserted here, say if wrong:** for an org with both an hour block and an `included`
  rule, included hours **do not draw the block** — they are born `contract`, so they never
  meet block eligibility (`is_billable AND not_billed`). "Included" means covered by the
  flat fee; the block absorbs only work the card prices. The portal shows both as covered.
  (d) (a) reopens the very flip block hours closed, so the `billingStatus` gate in §3.7 is
  load-bearing. Hand-set `contract` entries (`rate_source` NULL) stay ungated, as today.
  These amendments live only in this document until the block-hours spec on
  `spec/4547-block-hours` is amended — a named next step at approval, not an assumption.
  Per-work-type blocks remain out of scope there and here.
- **Multi-currency.** Match-or-skip at profile level; all arithmetic via
  `multiplyToCurrency` / `toCents`; snapshots never restamped. **Org currency change:** the
  readiness report (`orgCurrencyService.ts:212-258`) gains a line when the org's assigned
  profile will stop matching — after the change the assignment is skipped and bannered until
  a profile in the new currency is assigned. Included entries carry no `hourly_rate`, so
  they strand no billable money; value reporting groups by the entry's `currency_code`.
- **Business reports (#3198).** R2 gains a `work type` group-by and a `billing profile`
  filter; "included minutes" becomes a first-class column. Its spec anticipated neither —
  a note goes on #3198 at registration. No cost-rate work here.
- **Agreements IA.** No "agreement" wording anywhere in this feature. UI noun: **Billing
  profile**; "rate card" appears only as helper text.

## 6. API surface

All routes partner-scope only (`requireScope('partner','system')`), `authMiddleware` first.

- `routes/workTypes.ts` — `GET/POST /work-types`, `PATCH/DELETE /work-types/:id` (delete =
  archive when referenced), `POST /work-types/seed-standard`. Permission: same as ticket
  categories (`tickets:read` / `tickets:write`).
- `routes/billingProfiles.ts` — CRUD, `PUT /billing-profiles/:id/rules` (whole-grid upsert
  in one transaction), `POST /billing-profiles/:id/clone`, `GET
  /billing-profiles/:id/organizations`. New permissions `billing_profiles:read|write`.
  (`billing:manage` exists; the plan confirms what it gates today before reusing it.)
- Org: `GET/PUT/DELETE /organizations/:orgId/billing-profile`, `GET
  /organizations/:orgId/billing-profile/effective-rates` (the resolver run per active work
  type, with the winning source per row).
- Time entries: `workTypeId` on create / start / stop / update; `resetBilling` on update;
  `minimumMinutes` / `roundingIncrementMinutes` on update (gated);
  `GET /tickets/:id/time-entry-defaults?workTypeId=` returns the full resolved rule and
  **stays on `time_entries:read`** — putting it behind `billing_profiles:read` would break
  the technician's picker.
- AI / MCP: the time tools accept `workType` (id or name) and a read-only
  `list_work_types`; a tool is never weaker than its route (#6096 / #6110 rule), and the
  service-level `manageBilling` gate (§3.7) covers the tool path by construction. No AI
  write access to profiles or assignments in this feature.

## 7. Web UI

- **Settings → Ticketing → Work types** tab (`TicketingSettingsTabs`): list, reorder,
  default, archive, "Add standard work types". Category editor gains "Default work type".
- **Settings → Billing → Billing profiles**: list (currency, Default badge, "Used by N
  orgs") and a grid editor — rows = active work types; columns = Coverage, Rate, Minimum,
  Round up to, Notes; an empty row reads "falls through to …". Clone. Tab state in
  `location.hash`.
- **Org record → Billing tab** (`OrgBillingTab.tsx`): profile selector, the effective-rates
  table with source chips, a banner when the blanket default rate shadows the default
  profile or the assigned profile's currency no longer matches.
- **`TicketTimeBilling`**: work type select first; a live hint from the defaults endpoint;
  rate input read-only without `time_entries:manage_billing` on a governed entry. Feed
  comment says `(included)` / `(billable)`.
- **`TimerWidget`** (work type at start; "change work type" is a PATCH, running or
  stopped), **`TimesheetPage`** (column + edit), billables
  list (source chip, "min applied" marker).
- All mutations via `runAction`; new i18n keys need real translations in every locale.
- Mobile and the office add-in get pickers in the last wave; until then the server-side
  default chain covers them.

## 8. Out of scope

- **Fixed surcharge / call-out fee** (Open Decision 5) — a per-entry surcharge
  double-charges a visit logged as two entries; `ticket_parts` already bills a call-out
  once as a catalog item.
- Effective-dated / scheduled assignment; contract-linked profiles; per-site profiles.
- Per-work-type hour blocks (block hours punts on it too).
- Auto-selecting After-hours / Emergency from the clock and org business hours.
- Work type → catalog item / QuickBooks service item / tax category mapping.
- Bulk "re-rate unbilled entries" tool (per-entry `resetBilling` only).
- Cost rates and margin by work type; hiding rates from technicians entirely;
  showing included work as $0 lines on invoices (the portal already shows covered hours).
- Migrating existing category / org default rates into profiles.

## 9. Test and rollout notes

- **Resolver**: table-driven unit suite over the §3.4 matrix — every source, currency
  skip at each profile step, no work type, no org, sparse profile, inactive profile.
- **Stamp immunity** (integration, real Postgres): create entry → edit rule, archive
  profile, reassign org → entry unchanged; `resetBilling` re-resolves; billed entry locked.
- **Tenancy**: `billingProfilesPartnerRls.integration.test.ts` — cross-partner forge 42501
  on all four tables; composite-FK 23503 for a rule / assignment / entry joining two
  partners; **org-scoped token cannot read or write the assignment table**; a `selected`-org
  partner user cannot see an ungranted org's assignment (app-layer); the assignment of a
  **suspended** org stays readable and writable by its partner. Then verify by hand as
  `breeze_app`.
- **Contracts**: `rls-coverage`, `tenantCascade`, both export-policy suites,
  `orgLifecycleFoundations` (merge contract — deferrable FK), org-merge keep-survivor.
  None run under `pnpm test`; `pnpm test-stack up` first.
- **`billable_minutes`**: property test that `computeBillableMinutes` and the SQL fragment
  agree over a grid of (duration, minimum, increment); an integration test that a
  hand-written wrong value violates the CHECK; stop-via-CAS and stop-via-PATCH (the mobile
  path) both land the right number.
- **Money readers**: included entries carry `hourly_rate = NULL`, so
  `getTicketBillingSummary`, `listBillables`, the billing CSV and the timesheet loop stay
  correct untouched — assert it with an included entry in each suite rather than trusting
  the construction. `includedMinutes` is new on the summary.
- **Override gate**: enforced through the service for the REST route, the AI tool
  (`aiToolsTicketing`), the office add-in and `intentReleaseWorker`; numeric-normalised
  echo (`'225'` vs `'225.00'`).
- **Invoice assembly**: minimum and rounding cases; description suffix; `missingRate` for
  a rate-less billable rule.
- **Rollout**: no flag. Zero work types = today's behaviour byte-for-byte; the override
  gate only binds entries governed by a card.
- **Suggested waves** (the plan finalises): **W01** work types + `work_type_id` + web
  pickers + AI param (delivers #4615's taxonomy; rates untouched) · **W02** profiles, rules,
  assignment, resolver, stamping (`coverage`, `included_value_rate`), included → `contract`,
  `includedMinutes`, org preview, service-level override gate, config audit events ·
  **W03** minimum / rounding, `billable_minutes`, money + portal readers, invoice lines · **W04**
  mobile + office add-in pickers, report / CSV dimensions, docs.

## 10. Open Decisions

1. **Where does an org's existing blanket default rate sit?**
   - **A — above the partner default profile**: no org is silently re-rated the day a
     default profile appears; con: an org with a blanket rate ignores the standard card
     until it is assigned a profile (the org page banners this).
   - **B — below it**: one mental model ("cards win"); con: creating a default profile
     re-prices every negotiated org at once.
   **Recommend A** — rollout must never change what a customer is charged.

2. **How is "included" stored on the entry?**
   - **A — `is_billable = true`, `billing_status = 'contract'`, `hourly_rate = NULL`,
     nominal value in its own `included_value_rate`, `coverage` stamped**: reuses the enum
     value that means exactly this and that the portal already renders; no money reader can
     mis-count it. Con: needs the §5(a) terminality amendment to block hours.
   - **B — `is_billable = false`**: simplest; con: indistinguishable from internal time
     without reading `rate_source`, and utilization undercounts customer work.
   - **C — new enum value `included`**: explicit; con: every `billing_status` switch,
     validator, filter and report grows a case for a distinction `contract_line_id IS
     NULL` already draws.
   **Recommend A.**

3. **Minimum billing: per entry or per visit?**
   - **A — per entry**: deterministic, stamped, industry convention; con: a visit split
     into two entries bills two minimums (approver clears one).
   - **B — per ticket per day per work type**: matches "one visit"; con: needs an org
     timezone, a cross-entry recompute on every edit / delete, and breaks stamp-once.
   **Recommend A.**

4. **Who may deviate from the card?**
   - **A — new `time_entries:manage_billing`, service-enforced, binding only card-governed
     entries; `isBillable` and `workTypeId` stay open**: the issue's "authorised override"
     without changing anything for partners who never create a profile. Admins (`*:*`) hold
     it on day one; other roles are granted it in the role editor (no data migration).
   - **B — no gate in v1**: stamp `manual` and rely on approval review.
   - **C — gate every entry for every partner**: consistent; con: behaviour change for all
     existing technicians on release day.
   **Recommend A.**

5. **Fixed surcharge / call-out fee in this feature?**
   - **A — defer**; call-outs stay a ticket part (catalog item, billed once).
   - **B — per-entry stamped surcharge, sibling invoice line**; con: double-charges split
     visits, second money column to currency-guard.
   **Recommend A.**

6. **Org → profile assignment storage.**
   - **A — new partner-axis `org_billing_profile_assignments`, one current row per org**:
     DB-enforced same-partner integrity; commercial terms off the org-readable row; dating
     additive later; con: one more table in five lists.
   - **B — column on `org_ticket_settings`**: no new table; con: an MSP's rate-card choice
     sits on an org-token-readable row, and same-partner integrity is app-layer only.
   - **C — table with `effective_from` now**: scheduled package changes and back-dated
     entries resolve correctly; con: more UI and resolver surface than anyone has asked for.
   **Recommend A.**

## 11. Quorum record (2026-09-17)

Seats: Fable (position formed and drafted first) and an **Opus** read-only reviewer that
checked each claim against the code and the approved block-hours spec. The usual Codex
`xhigh` seat was unavailable (usage cap until 2026-09-19 11:38); if Todd wants the Codex
opinion as well, it is a re-run after that date, not a blocker. Load-bearing reviewer
claims were re-read by the orchestrator before being folded in (D1, D2, D3, D5, D8).

**Accepted — first-draft defects, now fixed in the text above**

1. *Nominal rate in `hourly_rate`.* "Every money reader skips `contract`" was false —
   `getTicketBillingSummary`, `listBillables` / billing CSV and the timesheet loop have no
   status predicate. → own column `included_value_rate`; `hourly_rate` NULL when included.
2. *"Org / portal users see nothing."* The portal already reads `time_entries`
   (`supportUsage.ts`) and shows `contract` hours; it also joins the §3.6 reader sweep.
3. *Conjunctive RLS policy.* `breeze_has_org_access` excludes suspended / archived orgs
   even for `orgAccess = 'all'` → assignments would vanish. → plain shape 3 + app-layer org
   allowlist, the `time_entries` precedent.
4. *RLS allowlist guess.* The mechanism is `ORG_AXIS_POLICY_EXCLUDED_TABLES`; now named.
5. *Generated column.* Not the first in the DB, invisible to Drizzle, a full-table rewrite,
   and `db:check-drift` cannot verify it. → service-written column + identical CHECK.
6. *Route-level gate.* Bypassed by the AI tool, add-in and worker callers. → service-level
   `manageBilling` on `TimeEntryActor`.
7. *Role seeding.* Tenant role copies are not reconciled by the seed, and "Partner Billing"
   has no time-entry permissions. → no data migration; admins pass via `*:*`.
8. *Work type at stop.* `stopRunningEntry` is a lock-free CAS and mobile stops are PATCHes.
   → resolve at start, re-resolve only in `updateTimeEntry`.
9. *Coverage not stamped.* Inference from status breaks after an included → `not_billed`
   flip and cannot separate three `contract` writers. → `coverage` column.
10. *Included vs hour blocks* was asserted in a subordinate clause. → explicit §5(c)/(d),
    plus the cross-branch risk that the block-hours spec does not yet carry the amendments.

Also accepted: numeric-normalised echo comparison; audit events for config edits; the
defaults endpoint stays on `time_entries:read`; org-currency-change interplay; explicit
"do not add to `DUAL_AXIS_TENANT_TABLES` / `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`".

**Disagreements, resolved on the merits**

- *Reviewer: gate `workTypeId` changes on card-governed entries (it is the largest price
  lever).* **Not adopted.** Creation is open, so an edit gate is defeated by
  delete-and-recreate; a work-type change only ever lands on another *card* price; and
  "what work was this" is the technician's call by the feature's own principle. The control
  is approval: every edit clears it, and the queue shows work type, coverage and source.
  If Todd wants it tighter, the lever is approval policy, not this gate (Open Decision 4).
- *Reviewer: when the org blanket default wins the rate, force `is_billable = true`.*
  **Not adopted.** It would start billing orgs configured `defaultBillable = false` with a
  reporting rate. Legacy steps stay legacy (§3.4).

**Agreement without argument:** Open Decisions 1, 3, 5 as recommended; 2, 4, 6 as
recommended with the corrections above; partner-axis ownership (§4.1) — no org-scoped
reader of rates exists, including org-scoped API keys.

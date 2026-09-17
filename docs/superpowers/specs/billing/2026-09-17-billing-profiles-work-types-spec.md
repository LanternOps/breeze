# Billing profiles and work types — design

Status: **draft, awaiting Todd's approval (Gate A)**.
Issues: LanternOps/breeze#4628 (billing profiles / rate cards, community, anchor) and
LanternOps/breeze#4615 (activity-type codes on time entries) — **one spec for both**, per
Todd's 2026-09-02 comment on #4628: the rate dimension is built once.
Advisor quorum: Fable position formed first; independent read-only review by an Opus
subagent. **Codex was unavailable** (flat-sub usage cap until 2026-09-19 11:38), so the
usual Codex `xhigh` seat was substituted. See §11 "Quorum record".

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
| Org-scoped users, portal customers | **Nothing.** The whole labour-billing domain is partner-side: `time_entries` is partner-axis RLS and org tokens cannot read it. Every table here follows suit. |

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

Every creation path already funnels through `createTimeEntry` / `startTimer` / `stopTimer`
(REST, office add-in, AI/MCP tools, suggestion confirm, mobile — no bypass exists), so the
default chain makes **old clients safe**: a mobile build with no picker still gets a work
type and therefore the right rule. A timer may set or change its work type at **stop** (the
technician who started remote and ended up driving on-site).

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
  (`org.defaultBillable ?? category.defaultBillable ?? false`).
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
| `included` | `is_billable = true`, `billing_status = 'contract'`, `hourly_rate` = the rule's optional **nominal rate** (else `NULL`), no minimum / increment |

Always also: `work_type_id`, `billing_profile_id` (the profile that produced the rule,
`NULL` for legacy sources), `rate_source`, and the existing `currency_code` snapshot.

**Included = `is_billable` + `billing_status = 'contract'`** (Open Decision 2). `contract`
already exists in the enum and already means "covered by the customer's contract"; every
money reader already excludes it (`gatherOrgTimeEntries` takes `not_billed` only). It keeps
included work distinguishable from internal non-billable time, which is what utilization
and profitability reporting need ("included time remains available for reporting"). The
nominal rate lets a QBR say "we delivered $4,200 of included remote support" from a
snapshot instead of from today's card.

### 3.6 Minimums and rounding

Per **entry** (Open Decision 3), the ConnectWise / Autotask / Halo convention:

```
billable_minutes = GREATEST(
  COALESCE(minimum_minutes, 0),
  CASE WHEN rounding_increment_minutes > 0
       THEN CEIL(duration_minutes::numeric / rounding_increment_minutes) * rounding_increment_minutes
       ELSE duration_minutes END)
```

`billable_minutes` is a **stored generated column** on `time_entries` — one definition for
SQL aggregates and TypeScript alike, `NULL` while a timer runs. It would be the first
generated column in the schema; §9 lists the drift-check verification and the fallback.
The *terms* (`minimum_minutes`, `rounding_increment_minutes`) are the stamp; an authorised
user adjusts the billed quantity by editing the terms on the entry, never by editing a
derived number.

Consumers switch from `duration_minutes` to `COALESCE(billable_minutes, duration_minutes)`
for **money and billed quantity** only: `timeEntryToLineSpec`, `partitionTimeEntries`,
`getTicketBillingSummary`, `listBillables`, billing CSV. Utilization and timesheets keep
**actual** minutes. When the two differ the invoice line says so
(`On-site Support — 0.50 h worked, 1.00 h minimum`). Lines stay one per entry.

### 3.7 Overrides, edits and re-resolution

**Never re-resolved by a config edit.** Editing a rule, archiving a profile, reassigning an
org — none touches an existing entry.

**Re-resolved by an edit to the entry itself**, while `billing_status <> 'billed'` and
`rate_source <> 'manual'`: changing `workTypeId`; relinking `ticketId` (today a relink
keeps the old org's rate — a latent bug this closes); `stopTimer` with a work type. An
authorised `resetBilling: true` on PATCH clears a manual override and re-resolves. Any edit
still clears approval (existing spec §3). `work_type_id`, the two term columns and
`billing_profile_id` join `BILLED_LOCKED_ENTRY_FIELDS`.

**Override gate** (Open Decision 4). New permission `time_entries:manage_billing`. It is
required to set `hourlyRate`, `billingStatus`, `minimumMinutes` or
`roundingIncrementMinutes` to a value that **differs from the resolved one** on an entry
**governed by a card** (`rate_source IN ('profile','default_profile')`, or would be after
the edit). Two deliberate softenings:

- *Echo is not an override.* `TicketTimeBilling` prefills the rate and posts it back; a
  value equal to the resolved one keeps its resolved `rate_source`.
- *`isBillable` stays technician-editable.* "Was this chargeable work" is the technician's
  knowledge (rework, goodwill); the *price* is what the card governs. Approval reviews it.

Legacy-mode entries (`org_default`, `category_default`, `none`) keep today's open
behaviour, so nothing changes for a partner until they create a profile. `*:*` roles pass
automatically; the seed adds the permission to the partner admin and billing roles.

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
There is no org-scoped reader: org tokens cannot see `time_entries` today and must not see
an MSP's rates.

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
CHECK `IN ('included','billable')`, `hourly_rate` numeric(10,2) NULL, `minimum_minutes` int
NULL CHECK `> 0`, `rounding_increment_minutes` int NULL CHECK `BETWEEN 1 AND 480`, `notes`,
timestamps. `UNIQUE (billing_profile_id, work_type_id)`.
CHECK `coverage = 'billable' OR (minimum_minutes IS NULL AND rounding_increment_minutes IS NULL)`.
Composite FKs `(billing_profile_id, partner_id) → billing_profiles(id, partner_id) ON
DELETE CASCADE` and `(work_type_id, partner_id) → work_types(id, partner_id)` (NO ACTION) —
a rule can never join a profile and a work type from different partners. FK checks bypass
RLS, so this must be structural, not app-layer.

### 4.5 `org_billing_profile_assignments` — partner-axis **and** org-gated

`id`, `org_id` NOT NULL **UNIQUE**, `partner_id` NOT NULL, `billing_profile_id` NOT NULL,
`assigned_by`, timestamps.

- `(org_id, partner_id) → organizations(id, partner_id)` — **`DEFERRABLE INITIALLY
  IMMEDIATE`** (org-merge contract; mirrors `time_entries_org_partner_fk`).
- `(billing_profile_id, partner_id) → billing_profiles(id, partner_id)` (NO ACTION — a
  profile in use is archived, not deleted).
- Policy: `system OR (breeze_has_partner_access(partner_id) AND breeze_has_org_access(org_id))`.
  The conjunction is the point: a plain shape-1 policy would let an **org-scoped user
  reassign their own rate card**; a plain shape-3 policy would show a `selected`-org
  partner user assignments for orgs they were never granted.

**Why a table and not `org_ticket_settings.billing_profile_id`** (Open Decision 6). The
resolver reads the assigned profile in *system* context, so a forged cross-partner profile
id would leak another MSP's rates into the forger's entries. `org_ticket_settings` has no
`partner_id`, so same-partner integrity there could only be app-layer. The table gets it
from two composite FKs, and effective-dated assignment ("Bronze → Silver on 1 October")
becomes additive later: relax the unique to `(org_id, effective_from)`.

### 4.6 New columns on existing tables

`time_entries`: `work_type_id`, `billing_profile_id` (both with composite
`(…, partner_id)` FKs to their shape-3 parents, NO ACTION), `rate_source` varchar(24) CHECK
`IN ('manual','profile','default_profile','org_default','category_default','none')`
(NULL = pre-feature row), `minimum_minutes`, `rounding_increment_minutes`,
`billable_minutes` (generated). Indexes on `(partner_id, work_type_id)` and
`(billing_profile_id)`. No backfill — old rows stay NULL and read as "legacy".

`ticket_categories`: `default_work_type_id` with a composite `(…, partner_id)` FK.

### 4.7 Registration lists

| List | Owes |
|---|---|
| `PARTNER_TENANT_TABLES` (`rls-coverage.integration.test.ts`) | `work_types`, `billing_profiles`, `billing_profile_rules`; and `org_billing_profile_assignments` with whatever exemption `time_entries` uses for carrying an `org_id` under a partner-axis policy — the plan must read that mechanism, not guess it |
| `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`) | `org_billing_profile_assignments` (alphabetical; it is an FK *child* of `organizations` only) |
| `CORE_TENANT_EXPORT_POLICY` | the new assignment table **and the six new `time_entries` columns** (`ADD COLUMN` on a registered table fires this). All `included`; no jsonb anywhere in this design |
| `orgMergeRegistry.ts` | `org_billing_profile_assignments: { kind: 'keep-survivor' }` — same as `org_ticket_settings` (unique `org_id`) |
| `TICKET_ORG_DENORMALIZED_TABLES` / `CUSTOM_ORG_REWRITE_TABLES` | nothing new — `time_entries` is already there; the new columns are partner-keyed and survive an org move. The stamp is **not** re-resolved by an org move (snapshot rule, same as currency) |
| Device cascade lists | n/a (no `device_id`) |
| Partner erasure | `time_entries` and `ticket_categories` now reference `work_types` / `billing_profiles`; the plan verifies delete order wherever `ticket_categories` is removed today |

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
  draws one hour. Unchanged: included entries never draw down (they are not `not_billed`);
  per-work-type blocks remain out of scope there and here.
- **Multi-currency.** Match-or-skip at profile level; all arithmetic via
  `multiplyToCurrency` / `toCents`; snapshots never restamped.
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
  `GET /tickets/:id/time-entry-defaults?workTypeId=` returns the full resolved rule.
- AI / MCP: the time tools accept `workType` (id or name) and a read-only
  `list_work_types`; a tool is never weaker than its route (#6096 / #6110 rule). No AI
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
- **`TimerWidget`** (work type at stop), **`TimesheetPage`** (column + edit), billables
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
  showing included work as $0 lines on invoices or in the portal.
- Migrating existing category / org default rates into profiles.

## 9. Test and rollout notes

- **Resolver**: table-driven unit suite over the §3.4 matrix — every source, currency
  skip at each profile step, no work type, no org, sparse profile, inactive profile.
- **Stamp immunity** (integration, real Postgres): create entry → edit rule, archive
  profile, reassign org → entry unchanged; `resetBilling` re-resolves; billed entry locked.
- **Tenancy**: `billingProfilesPartnerRls.integration.test.ts` — cross-partner forge 42501
  on all four tables; composite-FK 23503 for a rule / assignment / entry joining two
  partners; **org-scoped token cannot read or write the assignment table**; `selected`-org
  partner user cannot see an ungranted org's assignment. Then verify by hand as
  `breeze_app`.
- **Contracts**: `rls-coverage`, `tenantCascade`, both export-policy suites,
  `orgLifecycleFoundations` (merge contract — deferrable FK), org-merge keep-survivor.
  None run under `pnpm test`; `pnpm test-stack up` first.
- **Generated column**: verify `pnpm db:check-drift` and Drizzle's `generatedAlwaysAs`
  round-trip before building on it. Fallback if it fights the tooling: a plain column
  written by the service from the same pure function plus a CHECK carrying the identical
  expression. Either way one definition.
- **Money readers sweep**: every reader of `hourly_rate` / `is_billable` must already
  exclude `contract`; included entries now carry a nominal rate, so a reader that does not
  will overstate billables. Grep, don't assume.
- **Invoice assembly**: minimum and rounding cases; description suffix; `missingRate` for
  a rate-less billable rule.
- **Rollout**: no flag. Zero work types = today's behaviour byte-for-byte; the override
  gate only binds entries governed by a card.
- **Suggested waves** (the plan finalises): **W01** work types + `work_type_id` + web
  pickers + AI param (delivers #4615's taxonomy; rates untouched) · **W02** profiles, rules,
  assignment, resolver, stamping, included → `contract`, org preview, override gate ·
  **W03** minimum / rounding, `billable_minutes`, money readers, invoice lines · **W04**
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
   - **A — `is_billable = true`, `billing_status = 'contract'`, optional nominal rate**:
     reuses the enum value that means exactly this; all money readers already skip it;
     aligned with block hours. Con: needs the §5(a) terminality amendment.
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
   - **A — new `time_entries:manage_billing`, binding only card-governed entries;
     `isBillable` stays open**: the issue's "authorised override" without changing anything
     for partners who never create a profile.
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
   - **A — new `org_billing_profile_assignments`, one current row per org**: DB-enforced
     same-partner integrity; dating additive later; con: one more table in four lists.
   - **B — column on `org_ticket_settings`**: no new table; con: same-partner check is
     app-layer only, under a system-context reader (the #2417 shape).
   - **C — table with `effective_from` now**: scheduled package changes and back-dated
     entries resolve correctly; con: more UI and resolver surface than anyone has asked for.
   **Recommend A.**

## 11. Quorum record (2026-09-17)

_Filled in after the independent review — see below._

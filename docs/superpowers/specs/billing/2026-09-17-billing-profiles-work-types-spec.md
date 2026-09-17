# Billing profiles and work types — design

Status: **draft r2, awaiting Todd's approval (Gate A)**.
Issues: LanternOps/breeze#4628 (billing profiles / rate cards, community, anchor) and
LanternOps/breeze#4615 (activity-type codes on time entries) — **one spec for both**, per
Todd's 2026-09-02 comment on #4628: the rate dimension is built once.
Advisor quorum: Fable + an independent Opus read-only reviewer (Codex usage-capped until
2026-09-19 11:38). See §11.

**r2 (2026-09-17) — consolidation rewrite.** Todd's review of r1: billing and ticketing
settings are already sprawling; this feature must consolidate, not add. r1 kept all three
existing places that price labour and added two more behind a six-step chain. r2 replaces
them: **labour pricing lives in exactly one place.**

Two decisions are Todd's and **not open**:

1. Resolved billing terms are **stamped on the time entry**; a later edit to a profile or
   an org's assignment never rewrites an existing entry.
2. **Consolidate.** This feature may not increase the number of places labour pricing is
   configured. It reduces them to one.

---

## 1. Problem

An MSP runs several commercial models at once: standard T&M, negotiated T&M, managed
packages where some labour is included and the rest bills at package rates. Breeze cannot
express that, and what it has is already scattered. Labour pricing is configured today in
**three places**, merged by a chain (`resolveTicketLink`, `timeEntryService.ts:241-269`)
that resolves the rate and the billable flag *independently*:

| Where | Fields | Screen |
|---|---|---|
| Ticket category (partner-wide) | default billable, default rate, rate currency | Settings → Ticketing → Categories |
| Org ticket settings (per org) | default billable, default rate, rate currency | Org settings → ticket settings, beside SLA overrides |
| The time entry | billable, rate, billing status | ticket quick-add, timesheet |

None of them can say "remote is included, on-site is $200 with a one-hour minimum". A rate
hangs off the *ticket's category*, so one ticket cannot mix remote and on-site time
(#4615). There are no minimums or rounding anywhere (`invoiceAssembly.ts:88-99` bills
`duration / 60 × rate`). And any holder of `time_entries:write` can set any rate on any
entry, so the technician has to know each customer's deal.

The principle from #4628, adopted here: **technicians say what work they did; Breeze
decides how the customer bought it.**

## 2. The whole design in five sentences

1. A **work type** says what the labour was (Remote, On-site, Project, After-hours,
   Emergency); the technician picks it on the time entry.
2. A **billing profile** is a rate card: one row per work type plus a required **"All
   other work"** row; each row is *Billable at $X*, *Included*, or *Non-billable*, with an
   optional minimum.
3. Every org uses **one** profile: the one assigned to it, otherwise the partner's default.
4. Breeze looks up the row, **stamps** it on the entry, and never re-prices that entry when
   the card changes.
5. Deviating from the card on an entry needs a permission.

That is the entire model. There is no chain: *which card* is one lookup, *which row* is
one lookup. The category and org rate fields are **converted into profiles and removed**
(§3.6).

| | Today | r1 draft | **r2** |
|---|---|---|---|
| Places labour pricing is configured | 3 | 5 | **1** |
| Resolution steps | 3, rate and billable resolved separately | 6, mixed | **2 lookups, resolved as a unit** |
| Settings fields | 6 | 6 + two new screens | **−6 fields, +1 screen, +2 selects** |

## 3. Proposed design

### 3.1 Work types

Partner-owned list. A label only — no rate, no default flag. Lives on the **time entry**,
so one ticket can mix them. A ticket category may name a **default work type** (one select
replacing the three pricing fields it loses) so the picker opens on the right value.
`workTypeId` is optional everywhere: an entry with none is priced by the profile's "All
other work" row, which is what keeps old mobile builds, the AI tools and the add-in
correct with no client change.

### 3.2 Billing profiles

Partner-owned, reusable, cloneable, in **one currency**. One profile per partner per
currency may be the **default**. A profile carries:

- a **base row** ("All other work") — required, so a profile always answers;
- zero or more **work-type rows**;
- one **rounding increment** for the whole card ("we bill in 15-minute blocks") — a
  property of how the MSP bills, not of a work type.

Each row has: **coverage** (`billable` | `included` | `non_billable`), **hourly rate**
(optional — a billable row with no rate means "price at invoice review", the issue's
"package-specific"), **minimum minutes** (billable rows only), internal **notes**.

"Customer ABC – Negotiated T&M" is a cloned profile assigned to one org. There are no
org-owned profiles, no inheritance between profiles and no fall-through from one card to
another: adding a work type later prices it by each card's base row until someone gives it
a row, and the grid shows that ("uses All other work").

### 3.3 Resolution

One pure function, `resolveBillingRule()`, in a new
`apps/api/src/services/billingRuleResolver.ts` (no DB, no I/O — the `contractAllowance.ts`
pattern), shared by create, timer start, edit, the quick-add hint, the org preview and
`aiTimeEntryProposal.ts`:

```
card = org's assigned profile, if active and in the org's currency
       else the partner's default profile for the org's currency
       else none
row  = card's row for the entry's work type, else card's base row
```

- **No card** (nothing assigned, no default in that currency): billable, no rate. The
  quick-add already warns on a missing rate (#5321) and invoice assembly already buckets it
  as `missingRate`. Nothing is ever silently unbilled.
- **Match-or-skip** (multi-currency spec §7) is a property of *which card*: a card in the
  wrong currency is never used and never converted. Assignment rejects one up front (409
  `PROFILE_CURRENCY_MISMATCH`); if an org's currency changes later the assignment is skipped
  and bannered, and the currency-change readiness report says so beforehand.
- Resolution keys on the **org**, so W06 org-linked suggestion entries (no ticket) resolve
  too. Standalone entries (no org) are unpriced as today; a work type may still be set.

### 3.4 What gets stamped

| Row | Entry |
|---|---|
| `billable` @ R | `is_billable = true`, `billing_status = 'not_billed'`, `hourly_rate = R` (or `NULL`), `minimum_minutes`, `rounding_increment_minutes` |
| `included` | `is_billable = true`, `billing_status = 'contract'`, `hourly_rate = NULL` |
| `non_billable` | `is_billable = false`, `billing_status = 'not_billed'`, `hourly_rate = NULL` — exactly today's non-billable entry |

Plus `work_type_id`, `billing_profile_id`, `coverage`, and the existing `currency_code`
snapshot.

**Included = `contract` status with no rate.** `contract` already exists, already means
"covered by the customer's contract", and the portal already renders it that way
(`services/portal/supportUsage.ts`). `hourly_rate` stays `NULL` on purpose:
`getTicketBillingSummary`, `listBillables` (+ the billing CSV) and the timesheet money loop
filter on `is_billable AND hourly_rate IS NOT NULL` with **no status predicate**, so a rate
on an included entry would inflate all three. `coverage` is stamped rather than inferred
because `contract` has three writers — a card, a block-hours close, and a technician by
hand — and because a billing manager may later flip an included entry to `not_billed` to
bill out-of-scope work. The ticket summary gains `includedMinutes`.

r1's "nominal value rate" for included work is **cut** (one more knob, one more money
column; a QBR can value included hours from the default card at report time).

### 3.5 Minimums and rounding

Per **entry** — the ConnectWise / Autotask / Halo convention:

```
billable_minutes = GREATEST(COALESCE(minimum_minutes, 0),
  CASE WHEN rounding_increment_minutes > 0
       THEN CEIL(duration_minutes::numeric / rounding_increment_minutes) * rounding_increment_minutes
       ELSE duration_minutes END)
```

`billable_minutes` is a plain column written by the service and **pinned by a CHECK
carrying the identical expression**; `NULL` while a timer runs and on pre-feature rows.
One TS pure function plus one exported SQL fragment (`stopRunningEntry` is a single-
statement CAS that computes duration in SQL); the CHECK turns drift between them into a
constraint violation. Not a generated column: that rewrites a hot billing table under
ACCESS EXCLUSIVE, and the two generated columns this database already has are invisible to
Drizzle and to `db:check-drift`.

Money and billed quantity read `COALESCE(billable_minutes, duration_minutes)`:
`timeEntryToLineSpec`, `partitionTimeEntries`, `getTicketBillingSummary`, `listBillables`,
timesheet amounts, billing CSV, and the portal's billed / unbilled buckets (so a customer's
hours match their invoice). Utilization and timesheet durations keep **actual** minutes.
When they differ the invoice line says so (`On-site — 0.50 h worked, 1.00 h minimum`).
Lines stay one per entry.

### 3.6 Removing the old pricing fields (the consolidation)

**Removed from the product in the cut-over wave:** `ticket_categories.default_billable`,
`default_hourly_rate`, `rate_currency` and `org_ticket_settings.default_billable`,
`default_hourly_rate`, `rate_currency`. The category editor keeps one select (default work
type); the org ticket-settings editor becomes SLA-only. The resolver stops reading the
columns the day the conversion runs; the columns are dropped one release later.

**A one-time, price-preserving conversion** turns the old data into profiles, per partner:

1. *Pricing-relevant categories* — those with a rate, or with `default_billable = false`.
   Each becomes a **work type of the same name** and the category's default work type.
   (A partner who priced by category was using categories as work types; this keeps every
   price and lets them rename or merge afterwards.)
2. A **default profile per currency the partner's orgs use** ("Standard rates"), base row
   *billable, no rate*. Each category from step 1 becomes a row: `billable @ rate` in the
   currency its rate was entered in; `non_billable` in every currency if it was
   non-billable.
3. For each org whose ticket settings carry a rate or a billable flag: **clone** the
   default profile for the org's currency, name it after the org, then overlay — a billable
   flag sets every row's coverage; a rate (only if entered in the org's currency, per
   match-or-skip) sets every row's rate — collapse rows equal to the base, and assign it.
   This reproduces "org default beats category default" exactly.
4. A partner with nothing configured gets nothing created.

This is exact parity with the legacy chain with **one deliberate difference**: a ticket
with *no category* in an org with *no defaults* resolves today to silently non-billable;
after, it is billable with no rate and shows up in the missing-rate warning. §9 pins the
rest with a parity test.

The conversion writes rows on billing data — high blast radius. It is one idempotent SQL
migration (`WHERE NOT EXISTS` on the partner having any profile), opening with
`SELECT set_config('breeze.scope','system',true);`, reporting every count through
`RAISE WARNING`, never joining the `migrationRlsScope.test.ts` baseline. Existing time
entries are **not touched**: their stamped rate, billable flag and status are already
snapshots. The plan's first task is a read-only count on both regions of how many
partners, categories and orgs carry these fields, to size it.

### 3.7 Overrides and edits

**Never re-priced by a config edit.** Editing a row, archiving a profile, reassigning an
org — none touches an existing entry.

**Re-priced by an edit to the entry itself**, in `updateTimeEntry` only, while the entry
is not billed and not overridden: changing `workTypeId`, or relinking `ticketId` (today a
relink keeps the old org's rate — a latent bug this closes). Timers are priced at start;
there is no "work type at stop", because `stopRunningEntry` takes no ticket lock and mobile
replays a stop as `PATCH { endedAt }` — the technician who started remote and ended
on-site edits the entry. Any edit still clears approval. The new columns join
`BILLED_LOCKED_ENTRY_FIELDS`.

**One permission: `time_entries:manage_billing`.** Required to set `hourlyRate`,
`billingStatus` or `minimumMinutes` to something the card did not resolve, or to reset an
override. Setting it marks the entry `billing_overridden = true`, which is what the
approval queue highlights.

- Enforced **in the service** via `manageBilling` on `TimeEntryActor` (the `manageAll`
  precedent), because the AI tool (`aiToolsTicketing.ts:1005-1013`), the add-in and
  `intentReleaseWorker` pass billing fields straight through and would bypass a route gate.
- *Echo is not an override*: the quick-add posts back the prefilled rate; a value equal to
  the resolved one (compared as normalised numerics) is not a deviation.
- `isBillable` and `workTypeId` stay technician-editable — both answer "what work was
  this", a work-type change only ever lands on another *card* price, and an edit gate would
  be defeated by delete-and-recreate. Approval is the control.
- Partner Admin role copies hold `*:*` and pass with no data change; other roles get it in
  the role editor. No role-reconcile migration.

Because the gate applies to every org-linked entry (there is no "legacy mode" left), the
release note says so: technicians who typed rates by hand will need the permission or a
card.

## 4. Tenancy and data model

### 4.1 Why partner-axis, not dual-ownership

Partner-Wide First asks a new config table to justify not being `org_id XOR partner_id`.
A work type is picked by technicians working *across* orgs; an "org-specific rate card" is
a partner-owned profile assigned to one org. There is no org-scoped reader of rates: org
tokens and org-scoped API keys fail `breeze_has_partner_access`, so they cannot read
`time_entries` today, and the portal reads entries in system context without touching a
card. Precedent: `ticket_categories`. None of these tables may be added to
`DUAL_AXIS_TENANT_TABLES` or `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` (a shrink-only ratchet at
ceiling 0).

### 4.2 Tables (all shape 3, `breeze_has_partner_access(partner_id)`, ENABLE + FORCE in the creating migration)

**`work_types`** — `id`, `partner_id`, `name`, `sort_order`, `is_active`, timestamps.
`UNIQUE (partner_id, lower(name))`, `UNIQUE (id, partner_id)`.

**`billing_profiles`** — `id`, `partner_id`, `name`, `notes`, `currency_code` →
`supported_currencies` (immutable once any row has a rate), `is_default`, `is_active`,
`rounding_increment_minutes` (NULL or 1–480), and the base row inline:
`base_coverage` NOT NULL, `base_hourly_rate`, `base_minimum_minutes`.
`UNIQUE (partner_id, lower(name))`, `UNIQUE (id, partner_id)`, partial unique
`(partner_id, currency_code) WHERE is_default AND is_active`. The base row is columns, not
a NULL-work-type row, so "every profile answers" is a NOT NULL, not a convention.

**`billing_profile_rules`** — `id`, `partner_id`, `billing_profile_id`, `work_type_id`,
`coverage`, `hourly_rate`, `minimum_minutes`, `notes`.
`UNIQUE (billing_profile_id, work_type_id)`; CHECK coverage in the three values; CHECK a
rate or minimum only on a `billable` row. Composite FKs
`(billing_profile_id, partner_id) → billing_profiles ON DELETE CASCADE` and
`(work_type_id, partner_id) → work_types` — FK checks bypass RLS, so same-partner
integrity has to be structural.

**`org_billing_profile_assignments`** — `id`, `org_id` **UNIQUE**, `partner_id`,
`billing_profile_id`, `assigned_by`, timestamps.
`(org_id, partner_id) → organizations(id, partner_id)` **DEFERRABLE INITIALLY IMMEDIATE**
(org-merge contract); `(billing_profile_id, partner_id) → billing_profiles`.
Plain partner-axis policy with the org axis applied app-layer (`orgAxisSql` /
`entryOrgAllowed`), exactly as `time_entries` does it. *Not* `partner AND
breeze_has_org_access(org_id)`: accessible-org ids exclude suspended and archived orgs even
for `orgAccess = 'all'` (`middleware/auth.ts:410-420`), so those assignments would vanish.
A table rather than a column on `org_ticket_settings` because that row is org-token-
readable, has no `partner_id` to hang a composite FK on, and — the point of this rewrite —
is exactly the row pricing is being moved *out* of.

### 4.3 Columns on existing tables

`time_entries` (+7, all nullable or defaulted, no table rewrite): `work_type_id`,
`billing_profile_id` (composite `(…, partner_id)` FKs), `coverage`, `billing_overridden`
boolean NOT NULL DEFAULT false, `minimum_minutes`, `rounding_increment_minutes`,
`billable_minutes` + the §3.5 CHECK (`NOT VALID`, then validated — every existing row is
NULL). `ticket_categories`: `default_work_type_id` (composite FK). Six columns leave
(§3.6) one release after the cut-over.

### 4.4 Registration lists

| List | Owes |
|---|---|
| `PARTNER_TENANT_TABLES` | all four tables |
| `ORG_AXIS_POLICY_EXCLUDED_TABLES` (`rls-coverage…:124`) | `org_billing_profile_assignments` — `org_id` under a partner-axis policy, the file's own "dual-list trap"; `time_entries` is the precedent |
| `CORE_ORG_CASCADE_DELETE_ORDER` | `org_billing_profile_assignments` |
| `CORE_TENANT_EXPORT_POLICY` | the assignment table, the seven new `time_entries` columns (`ADD COLUMN` fires this), and later the removal of the six dropped columns. All `included`; no jsonb in this design |
| `orgMergeRegistry.ts` | `org_billing_profile_assignments: { kind: 'keep-survivor' }` (unique `org_id`, like `org_ticket_settings`) |
| Ticket / device org-move lists | nothing — `time_entries` is already registered; the stamp is not re-priced by an org move (snapshot rule, same as currency) |
| Audit log | work type, profile, row and assignment mutations record before / after. Stamping makes "what did the card say on 3 March" answerable only if card edits are recorded |
| Partner erasure | **not-checked** — `tenantCascade.ts` has no partner-level list; the plan finds where `ticket_categories` is removed and orders the new NO ACTION FKs after their referrers |

## 5. Cross-spec contracts

- **Block hours (#4547, approved, unplanned)** — two amendments: (a) `contract` is
  terminal only when `contract_line_id IS NOT NULL`; a card-included entry stays editable by
  a billing manager, which is how out-of-scope work gets billed. (b) Drawdown reads
  `COALESCE(billable_minutes, duration_minutes)`. And one assertion to confirm: included
  hours **do not draw a block** — they are born `contract`, so they never meet block
  eligibility; "included" means covered by the flat fee. These live only here until the
  block-hours spec on `spec/4547-block-hours` is amended — a named step at approval.
- **Multi-currency** — match-or-skip per card; arithmetic via `multiplyToCurrency` /
  `toCents`; snapshots never restamped.
- **Business reports (#3198)** — R2 gains a work-type group-by and an included-minutes
  column; note goes on #3198 at registration.
- **Vocabulary** — never "agreement". UI noun: **Rates** (the screen), **billing profile**
  (a card).

## 6. API surface

Partner scope only; `authMiddleware` first.

- `routes/billingProfiles.ts` — work types and profiles together, because they are one
  screen: `GET/POST/PATCH/DELETE /work-types`; profile CRUD; `PUT
  /billing-profiles/:id/rows` (whole card, one transaction); `POST …/:id/clone`.
  Permissions `billing_profiles:read|write`.
- `GET/PUT/DELETE /organizations/:orgId/billing-profile`.
- Time entries: `workTypeId` on create / start / update; `minimumMinutes` and
  `resetBilling` on update (gated). `GET /tickets/:id/time-entry-defaults?workTypeId=`
  returns the resolved row and **stays on `time_entries:read`**.
- Category and org-ticket-settings APIs stop accepting the six removed fields (ignored with
  a deprecation warning for one release, then rejected).
- AI / MCP: time tools accept `workType` (id or name); read-only `list_work_types`. The
  service-level gate covers the tool path by construction. No AI writes to cards.

## 7. Web UI — one screen

**Settings → Billing → Rates.** The issue's own table, literally: **rows are billing
profiles, columns are work types**, plus an "All other work" column. A cell reads `$150`,
`Included`, `Non-billable` or `$225 · 1 h min`; click to edit. Column header menu: rename /
archive / add work type. Row menu: clone, set default, archive, "used by N orgs". Rounding
and currency sit on the row. Work types are *not* a second tab under Ticketing.

Everything else shrinks or stays put:

- **Org billing settings** (`OrgBillingSettings`, beside currency): one "Billing profile"
  select showing the resolved card, read-only rates underneath, a banner on currency
  mismatch. This is the only place an assignment is edited.
- **Category editor**: three pricing fields out, one "Default work type" select in.
- **Org ticket-settings editor**: billing section deleted; SLA only.
- **Ticket quick-add / timer / timesheet**: a work-type select; a one-line outcome
  ("Included in Silver", "$225/h · 1 h minimum"); the rate input is read-only without
  `manage_billing`.
- Mutations through `runAction`; new i18n keys translated in every locale; mobile and the
  add-in get pickers in the last wave (the base row covers them until then).

## 8. Out of scope

Fixed surcharge / call-out fee (a per-entry surcharge double-charges a split visit; ticket
parts already bill a call-out once) · effective-dated or contract-linked assignment ·
per-site profiles · per-work-type hour blocks · auto-selecting After-hours from the clock ·
work type → catalog / QuickBooks item mapping · bulk re-rate tool · cost rates and margin ·
hiding rates from technicians · $0 "included" lines on invoices · valuing included work.

A wider billing + ticketing **settings consolidation** (partner billing defaults, org
billing, ticketing tabs) is worth its own audit; this spec only guarantees it does not add
to the pile and removes six fields from it.

## 9. Test and rollout notes

- **Conversion parity** (integration, real Postgres) — the gate for the cut-over. Seed
  partners covering every legacy shape (category rate / non-billable category / org rate /
  org billable-only / wrong-currency org rate / wrong-currency category rate / nothing).
  For every (org, category ∪ none) pair assert legacy-resolver output == new-resolver
  output after conversion, with the single §3.6 exception asserted explicitly. The legacy
  resolver survives as a test-only fixture. Re-running the migration is a no-op.
- **Resolver** — table-driven: assigned / default / none, currency skip, work-type row vs
  base row, inactive card, no work type, no org.
- **Stamp immunity** — edit a row, archive a card, reassign the org → entry unchanged;
  `resetBilling` re-prices; billed entry locked.
- **Tenancy** — `billingProfilesPartnerRls.integration.test.ts`: cross-partner forge 42501
  on all four tables; composite-FK 23503 joining two partners; org token cannot read or
  write assignments; `selected`-org partner user cannot see an ungranted org's assignment;
  a **suspended** org's assignment stays readable. Then by hand as `breeze_app`.
- **Contracts** — `rls-coverage`, `tenantCascade`, both export-policy suites,
  `orgLifecycleFoundations` (deferrable FK), org-merge keep-survivor. `pnpm test-stack up`.
- **`billable_minutes`** — TS function and SQL fragment agree over a grid; a wrong
  hand-written value violates the CHECK; stop-via-CAS and stop-via-PATCH both land it.
- **Money readers** — an included entry in each of the three summary suites; assert it
  adds no money.
- **Override gate** — through the REST route, the AI tool, the add-in and the worker;
  numeric echo (`'225'` vs `'225.00'`).
- **Waves** (the plan finalises): **W01** tables, API, work type on entries + pickers, AI
  param — dark for pricing, delivers #4615's dimension · **W02 cut-over, one PR**: Rates
  screen, org select, resolver switch, stamping, conversion migration + parity test,
  override gate, legacy fields out of the UI and API · **W03** minimums / rounding,
  `billable_minutes`, money + portal readers, invoice lines · **W04** mobile + add-in
  pickers, report / CSV dimensions, docs, drop the six columns.

## 10. Open Decisions

Three are yours. The rest were settled by the quorum; say if you disagree.

1. **Clean cut or coexistence?**
   - **A — convert and remove the old category / org rate fields in the cut-over wave**
     (§3.6): one place, one rule; con: a row-writing migration on billing data, gated by
     the parity test, and one behaviour difference (uncategorised + no defaults becomes
     "billable, needs a rate" instead of silently non-billable).
   - **B — keep the old fields as a fallback under the cards** (r1): no data migration;
     con: five places, a six-step chain, and the retrofit later anyway.
   **Recommend A.**

2. **The override permission now binds everyone.**
   - **A — `time_entries:manage_billing` required to deviate from the card on any
     org-linked entry; admins hold it via `*:*`, others by role edit**: con: technicians
     who type rates today lose that on release day unless granted.
   - **B — also push the grant to every existing role that has `time_entries:write`** (a
     second row-writing migration): zero behaviour change on day one; con: the gate is
     decorative until someone removes grants.
   **Recommend A**, called out in the release notes.

3. **Confirm:** included hours do not draw down an hour block, and the two block-hours
   amendments in §5 are acceptable.

**Settled by quorum:** included = `contract` status, no rate, `coverage` stamped · minimum
per entry, rounding per card · dedicated partner-axis assignment table · surcharge deferred
· service-written `billable_minutes` + CHECK · timers priced at start.

## 11. Quorum record (2026-09-17)

Seats: Fable (drafted first) and an **Opus** read-only reviewer that checked claims against
the code and the block-hours spec; Codex `xhigh` unavailable (usage cap). The orchestrator
re-read the load-bearing reviewer claims before adopting them.

**r1 defects found by review, fixed:** a nominal rate in `hourly_rate` would have inflated
three summaries with no status predicate · "portal sees nothing" was false
(`supportUsage.ts`) · a conjunctive RLS policy hides suspended orgs' assignments · the RLS
allowlist is `ORG_AXIS_POLICY_EXCLUDED_TABLES` · a generated column rewrites the table and
is invisible to Drizzle and `check-drift` · a route-level gate is bypassed by the AI tool,
add-in and worker · tenant role copies are not reconciled by the seed and "Partner Billing"
holds no time-entry permissions · `stopRunningEntry` is a lock-free CAS and mobile stops
are PATCHes · coverage must be stamped · included-vs-block interplay made explicit.

**Reviewer points not adopted:** gating `workTypeId` edits (defeated by delete-and-
recreate; approval is the control); forcing `is_billable` when an org default rate wins
(moot in r2 — a row now carries coverage and rate together, which removes the incoherence
the reviewer identified at its root).

**r2 (consolidation)** was prompted by Todd, not by the quorum: both seats had accepted a
six-step chain layered over the legacy fields. r2's conversion rules (§3.6) get a focused
second review because they write billing data.

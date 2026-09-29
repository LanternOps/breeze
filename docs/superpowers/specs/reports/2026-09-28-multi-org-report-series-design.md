---
title: Multi-org report series (one definition, one report per org) + org visibility on the Reports list
date: 2026-09-28
status: draft — awaiting Todd's review
author: Todd Hebebrand (design), Claude (spec)
quorum: Fable + Codex gpt-6-astra xhigh, two rounds (second round against current main 92764125ed) — both picked the separate-table design (§3.1)
---

# Multi-org report series

## 1. Problem

On `/reports` under **All organizations**, an MSP sees a flat list of saved
reports with no indication of which organization each one belongs to. An MSP
running the same five monthly reports for 18 customers ends up with 90
near-identical rows: each one is created, edited and troubleshot separately.

Current state (main `92764125ed`):

- `reports` is dual-owner since Business Reports #3198
  (`apps/api/src/db/schema/reports.ts:78-84`, `reports_one_owner_chk`).
  - An **org-owned** row produces one report for one org.
  - A **partner-owned** row (`org_id NULL`) produces **one cross-org aggregate**
    output. It uses partner timezone, branding and `partner_wide` execution
    scope, and only partner callers with `org_access='all'` can read it.
    Contact recipients are refused (`routes/reports/recipients.ts:49-63`).
- The list API (`routes/reports/core.ts`) returns `orgId` but no org name. The
  runs list (`routes/reports/runs.ts`) returns `reportName` only.
  `ReportsList.tsx` has no org column. Only partner-owned rows get a
  `ScopeBadge` (`ReportsList.tsx:616`).
- `ReportBuilder` has no org picker. Under All organizations, **New Report and
  Templates return 400** "orgId is required when partner has multiple
  organizations" for a multi-org partner.
- Nothing produces **one report per org from one definition**. The closest
  precedent is the partner-wide AI narrative schedule. It mints one org-owned
  `reports` row per org via `source_ai_agent_schedule_id`
  (`services/aiAgents/narrativeReport.ts`), and org merge has a custom pass for
  it (`services/orgMergeRegistry.ts`, `reports` entry;
  `services/orgMergeCustomExecutors.ts`).
- A scheduled run whose recipients resolve to zero silently skips delivery
  (`jobs/reportScheduleWorker.ts`, `if (recipients.length > 0)`). Nothing
  records that it happened.

## 2. Decisions (Todd, 2026-09-28)

| # | Decision |
|---|---|
| D1 | A multi-org definition **fans out**: one separate output per targeted org, delivered to that org's contacts. It is not one combined document. Combined cross-org reports remain the existing partner-owned "aggregate" rows. |
| D2 | Targeting has two modes. **All orgs (live)**, the default, automatically includes current and future orgs minus explicit exclusions. **Chosen orgs** includes exactly the listed orgs. Single-org reports are unchanged. |
| D3 | Recipients: a **rule** (the org's primary contact by default, optionally contacts holding role X) resolved per org, **plus** per-org add/remove overrides, **plus** fixed internal CC addresses. An org resolving zero customer recipients is surfaced, never silent. |
| D4 | Existing near-duplicate per-org reports are consolidated **only through an opt-in "Combine" action**, never by automatic migration. |
| D5 | Series children are read-only except per-org recipient overrides. Any other per-org difference means **Detach**, which turns the child into a standalone org report. |
| D6 | `report_series` is **partner-only** (shape 3, `partner_id NOT NULL`). This is an explicit exception to the Partner-Wide-First dual-ownership default. Single-org definitions already live in `reports`, and a one-org series is simply "Chosen orgs: [X]". State this in the PR. |

## 3. Design

### 3.1 Why a separate table

**Rejected: a partner-owned `reports` row with a `delivery_mode` flag** acting
as the parent. A partner-owned `reports` row already means "aggregate". Giving
it a second, opposite meaning would require mode branches at nine existing
sites:

- worker discovery (`reportScheduleWorker.ts:237`);
- queued execution (`:472`);
- partner-type validation on create (`core.ts:599`);
- saved-report generation dispatch (`runs.ts:126`);
- list semantics (`core.ts:380`);
- the web list merge (`ReportsList.tsx:188`);
- the "All orgs" badge (`ReportsList.tsx:616`);
- editor classification (`ReportEditPage.tsx:208`);
- recipient editing (`ReportBuilder.tsx:807`).

Every future reader would also have to remember the flag. A separate table
keeps these facts true: "a `reports` row is something that executes", and
"partner-owned = aggregate".

**Rejected: executing partner rows directly as per-org runs** (no children).
`report_runs` has no `org_id` and reaches its tenant through `reports`.
Org-scoped users, the portal, deliverable evidence
(`service_deliverable_evidence` composite FKs) and recipient composite FKs all
need a report row with a concrete `org_id`.

### 3.2 Data model

**`report_series`** (new; shape 3 partner-axis; `PARTNER_TENANT_TABLES`)

| column | notes |
|---|---|
| `id` uuid PK | |
| `partner_id` uuid NOT NULL → partners ON DELETE CASCADE | RLS `breeze_has_partner_access(partner_id)`, enabled + forced |
| `name`, `type`, `format`, `schedule`, `config` jsonb | the shared definition; `config` has the same shape as `reports.config`, validated by the same zod schema plus the series restrictions below |
| `target_mode` text CHECK IN ('all','selected') | default `'all'` |
| `recipient_rule` jsonb | `{ primaryContact: boolean, roles: string[] }`, default `{primaryContact: true, roles: []}` |
| `internal_cc` text[] | fixed internal addresses. Children receive them as `config.emailRecipients`, the existing field. |
| `revision` integer NOT NULL default 1 | incremented by every shared-field or target change |
| `enabled` boolean NOT NULL default true | |
| `owner_user_id` uuid → users | the principal each child's execution scope is captured from (§3.4) |
| `created_by`, `created_at`, `updated_at` | |

Series restrictions:

- **Allowed types:** only org-executable, non-system-managed types. Rejected
  types:
  - `PARTNER_ONLY_DELIVERY_REPORT_TYPES`, i.e. business reports, which are
    aggregates by nature;
  - narrative, `ai_fleet_design`, portal self-service and the four
    managed-evidence types (registry `execution: 'managed_evidence'`). Loosening
    the managed-evidence rule later is a one-line change; every
    `execution: 'user'` org type is allowed.
- **Recurring schedules only:** `one_time` is rejected.
- **No org-specific references in `config`:** no site IDs, device IDs or group
  IDs, and no builder filters that name them. Rejected with 400 `series_config_org_specific`.
- **Write gate:** requires `reports:write` **and**
  `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts`).

**`report_series_org_targets`** (new; shape 1 direct `org_id`)

| column | notes |
|---|---|
| `id` uuid PK | |
| `series_id` uuid NOT NULL → report_series ON DELETE CASCADE | |
| `org_id` uuid NOT NULL → organizations | RLS `breeze_has_org_access(org_id)` |
| `created_at` | |

- **Meaning of a row:** in `target_mode='all'` a row is an **exclusion**; in
  `'selected'` it is an **inclusion**. Unique on `(series_id, org_id)`.
- **Same-partner check:** a constraint trigger asserts that
  `organizations.partner_id = report_series.partner_id`. It is `DEFERRABLE
  INITIALLY IMMEDIATE`, because org merge repoints `org_id`.
- **Registration:**
  - `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical);
  - a merge policy in `orgMergeRegistry.ts`: `repoint-dedupe` on
    `(series_id, org_id)`, and on collision **exclusion wins**, i.e. the row
    survives;
  - `CORE_TENANT_EXPORT_POLICY` (all columns `included`);
  - RLS coverage auto-discovers it.

**`reports`** (new columns)

| column | notes |
|---|---|
| `series_id` uuid NULL → report_series ON DELETE SET NULL | only set on org-owned rows. CHECK `series_id IS NULL OR org_id IS NOT NULL`. |
| `series_revision` integer NULL | the revision last applied to this child |
| `archived_at` timestamptz NULL | set when a child is excluded or its series is deleted. Archived rows never schedule and are hidden by default in the list. |

- **One active child per org:** partial unique
  `(org_id, series_id) WHERE series_id IS NOT NULL AND archived_at IS NULL`.
- **Same partner as the child's org:** a constraint trigger
  (`DEFERRABLE INITIALLY IMMEDIATE`) checks that the series partner equals the
  child org's partner.
- **Export policy:** `series_id`, `series_revision` and `archived_at` go to
  `included`.
- **Org merge:** extend the custom `reports` merge pass
  (`orgMergeCustomExecutors.ts`) with a series pass modelled on the narrative
  pass. When active children collide on `(survivor, series_id)`, the survivor
  keeps its row. The loser's child is **archived in place** and repointed into
  the survivor org, with its runs, evidence and history untouched. Its
  recipient overrides are unioned onto the survivor's child, with removes
  winning over adds. Runs are never deleted.
  - Why the loser's runs are not re-homed:
    `service_deliverable_evidence.sd_evidence_report_run_fk
    (report_run_id, report_id) → report_runs(id, report_id)` is neither
    deferrable nor `ON UPDATE`, so `UPDATE report_runs SET report_id` on an
    evidence-linked run raises 23503. The existing narrative, portal and
    fleet-design passes have that latent fault; it is filed separately.

**`report_schedule_recipients`** (new column)

- `mode` text NOT NULL default `'add'`, CHECK IN ('add','remove'). The
  existing rows are all adds, so today's behaviour is unchanged.
- The uniqueness key stays `(report_id, contact_id)`.
- Export policy: `mode` goes to `included`.
- The business-type refusal (`partnerOnlyDeliveryRefusal`) continues to apply.

**`report_runs`** (new columns)

- `delivery_status` text NULL, CHECK IN ('sent','partial','no_recipients','failed','not_scheduled').
  - `NULL` for ad-hoc and legacy runs.
  - `not_scheduled` for manual runs of a scheduled definition when no email was requested.
- `recipient_count` integer NULL. On a series child it counts customer recipients only, excluding the internal CC. On a non-series report there is no CC concept, so it counts contacts ∪ `config.emailRecipients`.
- `report_runs` has no `org_id`, so no export-policy entry is needed. This is
  confirmed during planning against the export registry's discovery rule.
- **Deliberately out of scope:** the per-recipient ledger
  `report_run_deliveries` stays narrative-only. The summary columns are enough
  for the list and the warnings.

### 3.3 Reconciler and worker gate

A new service, `services/reportSeries/reconcile.ts`. It exposes one entry point,
`reconcileSeries(seriesId, tx)`, plus `reconcileAllSeries()` for the repair
sweep.

**Target set.**
- `all` mode: every org of `series.partner_id` minus the target rows.
- `selected` mode: exactly the target rows.
- In both modes, only **eligible** orgs count: `organizations.status IN
  ('active','trial') AND deleted_at IS NULL`. Suspended, churned, offboarding,
  merging, archived and purging orgs are not targeted. Their child is archived,
  and it is unarchived automatically if the org returns to active.

**For each targeted org, one of three outcomes:**
- **No active child exists:** create one — org-owned, with the shared fields
  copied, `series_id` and `series_revision`, and the execution scope captured
  per §3.4.
- **An active child is at an old revision:** overwrite the shared fields and
  set `series_revision`.
- **An archived child exists with no active one:** unarchive it. This happens
  when an org is re-included, and it preserves the org's run history.

**Any active child whose org is no longer targeted** gets `archived_at = now()`.

**Triggers:**
1. **Transactionally** in every series create, edit, target change, enable or
   disable (the same transaction as the write).
2. A **repair sweep** in `processCheckSchedules` on every 5-minute tick. It
   picks up new orgs in `all` mode and repairs anything a crash left behind.
   A new org therefore starts receiving the report within 5 minutes. No
   org-creation hook is needed.

**Worker gate.** In `processRunScheduledReport`, before generating, a child
whose `series_id` is set must pass all three checks:
- its series is `enabled`;
- its org is still targeted;
- `series_revision = series.revision`.

On a revision mismatch the worker reconciles that child first and then runs.
On a disabled series or an untargeted org it skips and records the skip. This
closes the "job queued before the org was excluded" race. `findDueReports`
excludes rows with `archived_at IS NOT NULL`.

**Child writers.** `PUT /reports/:id`, the AI tool `generate_report`
(`services/aiToolsFleet.ts`) and any other writer of `reports` refuse edits to
series-owned shared fields on a child: 409 `series_managed`, with a message
pointing at the series. The allowed writes are recipient add/remove and the
explicit Detach, which clears `series_id` and bumps nothing on the series.

### 3.4 Authority

Scheduled runs execute as the user whose site-scope snapshot is on the
definition. System authority is refused.

- **Who can own a series:** `owner_user_id` must be a partner-scope user with
  `org_access='all'` and unrestricted site scope. The check runs at series
  write and again at reconcile.
- **Children:** each child captures the owner's execution scope for **its own
  org**. The fingerprint includes the org id (`services/siteScope.ts`). Live
  authority is still intersected on every run
  (`resolveLiveReportAuthority`).
- **When the owner can't reach an org:** the owner is deactivated, loses
  `org_access='all'`, or loses reach into a new org. The child is created or
  kept but marked **`blocked: no authority`**. It is never run with substitute
  or system authority.
- **Transfer owner:** `POST /reports/series/:id/transfer-owner` (partner-wide
  gate). It re-captures every child's scope in one transaction.

### 3.5 Recipients

At send time, each child resolves its recipients as:

```
customer = (rule matches in child's org  ∪  child 'add' rows)  −  child 'remove' rows
cc       = series.internal_cc  (the child's config.emailRecipients)
```

- **Rule matches:** `primaryContact` means the org-level primary contact
  (`contacts.is_primary AND contacts.site_id IS NULL`). `roles` means active
  contacts whose `roles && rule.roles`.
- **`recipient_count`:** `|customer|`.
- **`delivery_status`:**
  - `no_recipients` when `customer` and `cc` are both empty. Nothing is sent,
    and the list flags it.
  - `sent` when there is no customer recipient but there is CC. The org is
    still flagged "no customer recipient".
- **Branding:** the email and PDF use the existing branding path, which
  resolves the **partner's** branding via the org (`services/reportBranding.ts`).
  The org's name and data are the content. This is unchanged from today's
  org-owned reports.

### 3.6 API

New route group `routes/reports/series.ts`, mounted under `/reports/series`:

| route | behaviour |
|---|---|
| `POST /reports/series` | create the series and its targets, then reconcile, all in one transaction |
| `GET /reports/series` / `GET /:id` | the definition, targets, and a per-org status array (`orgId, orgName, state: active\|excluded\|blocked_no_authority\|blocked_no_recipients, childReportId, lastRun{status, deliveryStatus, recipientCount, completedAt}`) |
| `PATCH /:id` | edit shared fields (`.partial()`, which cannot change `partner_id`), bump the revision, reconcile |
| `PUT /:id/targets` | replace the target mode and rows, reconcile |
| `POST /:id/transfer-owner` | §3.4 |
| `DELETE /:id` | archive all children, then delete the series. Children survive, archived, with history intact, and `series_id` goes to NULL via SET NULL. |
| `POST /reports/:id/detach` | on a child: clear `series_id`, keep the row as a standalone org report |
| `GET /:id/recipients/preview` | per-org resolved recipient counts plus the list of orgs with no customer recipient; used by the form |
| `GET /reports/series/combine-candidates` / `POST /reports/series/combine` | §3.8 |

The existing list, `GET /reports`, gains:
- `orgName`, from a join, respecting RLS;
- `seriesId`, `seriesName` and `archivedAt`;
- a `?series=only|exclude` filter;
- archived rows excluded by default.

`GET /reports/runs` gains `orgId`, `orgName`, `seriesId` and `seriesName`.

### 3.7 Web UI

**Saved Reports list** (`ReportsList.tsx`)

- **A new Covers column** with three kinds (see the mockup below):
  - **Single org:** the org name, for org-owned standalone reports.
  - **"All organizations · Combined":** the existing partner-owned aggregates.
    This replaces today's lone `ScopeBadge`.
  - **Series:** "All orgs · N" or "N orgs", followed by "· One per organization".
- **A series is one expandable row.** The expanded drill-down has one line per
  org:
  - columns: org, state, last run, delivery status, recipient count;
  - actions: Run now (this org), Edit recipients, Exclude, Detach.
- **Last run column:** for a series it reads "Oct 1 · 17/18 delivered · 1 no
  recipient ⚠".
- **Filter chips:** All · Multi-org · Single-org · Combined. These combine with
  the org switcher.
- **With one org selected:** series children show as ordinary rows with a
  "Multi-org" badge that links to the series.
- **Recent Runs:** new Org and Series columns.

**Create/edit** (`ReportBuilder.tsx`)

- **A "Covers" control** as the first field, with three choices:
  - *One organization*: an org picker. This fixes the 400 under All
    organizations.
  - *One report per organization*: All orgs + exclusions, or Chosen orgs.
    Shown only to users who pass `canManagePartnerWidePolicies`.
  - *All organizations combined*: the existing partner-owned aggregate. The
    same gate and the same types as today.
- **Series mode recipients section:**
  - rule checkboxes and a role picker;
  - internal CC;
  - a live preview from `/recipients/preview`: "Resolves to 23 contacts across
    17 orgs · 1 org has no customer recipient: Acme Dental".
- **Site, device and group filters** are disabled in series mode, with an
  explanation.
- **Templates:** the same Covers control. Choosing a template no longer posts
  the ambient `currentOrgId` blindly.

**Child view** (`ReportEditPage.tsx`)

- Series fields are shown locked, with "Edit multi-org report" and "Detach"
  actions.
- Only the org's recipient add/remove list is editable.
- Org-scoped users see the child with a "Managed by your MSP" badge and no
  series controls.

### 3.8 Combine (opt-in consolidation)

- **Candidate query:** active, org-owned, non-series rows grouped by
  `(type, format, schedule, normalized config)`.
  - Normalized config means the schedule time, day and date plus the builder
    fields. Recipients and name are **not** part of the key, and nothing is
    grouped by name alone.
  - A group must span at least 2 orgs.
  - Excluded rows: portal self-service, narrative (`source_ai_agent_schedule_id`),
    managed-evidence and `ai_fleet_design` rows, business types, and any row
    whose config references sites, devices or groups.
- **Banner:** "N groups of near-identical reports could be combined."
- **Dialog (per group):**
  - lists each org's matching row(s), with name, last run and recipients;
  - the target defaults to **Chosen orgs = exactly these orgs**, so nothing new
    is sent; it can be switched to All orgs;
  - the recipient rule defaults to off (`{primaryContact: false, roles: []}`). Each org's existing contact
    recipients become that child's `add` overrides, so **every customer keeps
    receiving exactly what they receive today**.
  - The existing `config.emailRecipients` values present on **all** rows become
    the series internal CC. Values present on only some rows are shown in the
    dialog and must be resolved by the user before confirming.
- **On confirm** (one transaction):
  - create the series;
  - adopt one row per org in place (set `series_id` and `series_revision`,
    overwrite the shared fields with the series definition); these rows keep
    their `id`, runs and evidence links;
  - archive extra duplicates within the same org.
- **No undo endpoint:** each adopted row can be Detached individually.

## 4. Delivery (feature-lifecycle waves)

| Wave | Scope | Blast radius |
|---|---|---|
| **W01 — Org visibility** (independent; ships first) | `orgName` on `/reports` and `/reports/runs`; the Covers column (single org and Combined kinds); an Org column on Recent Runs; the org picker in New Report and Templates under All organizations (fixes the 400); `report_runs.delivery_status` and `recipient_count`, written by the worker; a "no recipients" warning on rows | Low: one additive migration on `report_runs` |
| **W02 — Series backend** | Migrations (two tables, `reports` and recipient columns, RLS, triggers); cascade, merge and export registration; the `series.ts` routes; the reconciler, repair sweep and worker gate; authority and transfer-owner; recipient rule and override resolution; `series_managed` refusals in every child writer, including AI tools | **High**: tenancy, migration, org merge. Full rigor, Sonnet/Opus review. |
| **W03 — Series UI** | The Covers control's series mode, recipient preview, grouped list and drill-down, locked child view, Exclude and Detach | Medium |
| **W04 — Combine** | Candidate query, dialog and in-place adoption | Medium: rewrites existing rows' shared fields |

## 5. Testing

**W01**
- Route tests: `orgName` present, and cross-org rows absent under an org token.
- Worker test: zero recipients → `delivery_status='no_recipients'` (the red
  first, against today's silent skip).
- `ReportsList` component test: the Covers column.
- `ReportBuilder` test: under All organizations with no org chosen, submit is
  blocked client-side and no 400 is reached.

**W02**
- `reportSeriesPartnerRls.integration.test.ts`:
  - forging a series or target under another partner fails with 42501;
  - an org token can't read `report_series`;
  - an org token reads its own child and its runs;
  - a same-partner trigger rejects a cross-partner target or child.
- Reconciler integration test (real Postgres):
  - `all` mode picks up a newly created org within one sweep;
  - exclusion archives the child and runs survive;
  - re-inclusion unarchives the same row;
  - a revision bump updates every child;
  - series delete leaves archived children with history.
- Worker test: a child queued before its org was excluded → skipped, not
  generated.
- Authority tests:
  - a narrowed or deactivated owner gives `blocked_no_authority` and never runs;
  - transfer-owner re-captures every child's scope.
- Org merge integration test: two orgs with active children of the same series
  merge without 23505 or 23503, runs are re-homed, and removes win.
- Contract suites: `test:rls-coverage`, `tenantCascade.integration`, the full
  unit run (for `orgMerge.test.ts`), `orgMergeRegistry.integration`,
  `tenant-export-policy.integration` and `tenantExportErasureRoundtrip.integration`.

**W03**
- Component tests: the series form (filters disabled, preview rendering),
  drill-down actions, the locked child view.
- Mutations go through `runAction`.

**W04**
- Candidate exclusion list (portal, narrative, evidence, fleet design,
  business, site-scoped config).
- Combine preserves each org's contact recipients as `add` overrides.
- Adopted rows keep their `id` and runs.
- CC disagreement blocks confirm.

## 6. Out of scope

- A per-recipient delivery ledger for non-narrative reports.
- Per-org overrides of anything except recipients (use Detach).
- Per-org schedule or time-of-day differences. Each child already fires at the
  series time in its **org's** timezone.
- Portal publication of series outputs. Children are ordinary org reports, and
  the portal's existing self-service gates are unchanged. Explicit portal
  publication is a follow-up if wanted.

---
issue: LanternOps/breeze#5784
spec: docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md
# tracking_issue: added by register_feature at Stage 4 — do not fill in by hand
tracking_issue: LanternOps/breeze#5812
---
# Evidence Reports for Service Plans — Plan Index

**Spec:** `docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md`
(Gate A approved 2026-09-14: OD-1 … OD-12 as recommended, explicitly **OD-5 = B**
(managed-evidence execution on `SystemReportExecutionAuthority` bound by a closed
server-owned registry) and **OD-12 = A** (publish on delivery, never on
generation); OD-7 firewall/VPN out of scope; **OD-11 day boundary**: generation
stays on the due day and the artifact states its coverage window.)

**Depends on:** `#5573` (service deliverables), whose plans are
`docs/superpowers/plans/billing/2026-09-10-service-deliverables*.md`. This feature
changes how `#5573`'s auto-evidence path is invoked; it does not change its
occurrence lifecycle.

One plan document per wave. Each wave is one PR on its own branch
`feature/<parent#>-service-plan-evidence-reports/wave-<sub-issue#>` with
`Closes #<sub-issue#>` in the PR body. **Every wave PR targets `main`** — never
stack a wave on a sibling branch (see "CI traps" below). State lives on GitHub
(feature-lifecycle); the wave issue is the source of truth for status, never this
index.

---

## Waves

| Wave | Plan | Scope | New data | Depends on |
|---|---|---|---|---|
| W01 | [Foundation: managed evidence definitions, system execution path, period semantics, publication gate](2026-09-14-service-plan-evidence-reports-w01-foundation.md) | Closed managed-evidence registry, `SystemReportExecutionAuthority` execution path, `deliverable_template_items.auto_evidence_report_type`, apply-time resolution, OD-11 period + prior-occurrence baseline, visible refusal state, OD-12 publication gate, reprovision script wiring, opt-in linkage backfill, the auto-evidence web pickers | none | #5573 W02 + W05 (shipped) |
| W02 | [`threat_detection_review`](2026-09-14-service-plan-evidence-reports-w02-threat-detection-review.md) | Huntress-backed evidence artifact end to end | none | W01 |
| W03 | [`endpoint_management_review`](2026-09-14-service-plan-evidence-reports-w03-endpoint-management-review.md) | Intune / M365 posture evidence artifact | none | W01 |
| W04 | [`vulnerability_management`](2026-09-14-service-plan-evidence-reports-w04-vulnerability-management.md) | Vulnerability detail artifact incl. exceptions expiring next period | none | W01 |
| W05 | [`signin_events` sync domain](2026-09-14-service-plan-evidence-reports-w05-signin-events-sync.md) | Seventh M365 sync domain + `m365_signin_events` table, RLS in the creating migration, three registration lists, 120-day retention | **yes** | W01 (independent of W02–W04) |
| W06 | [`identity_access_review`](2026-09-14-service-plan-evidence-reports-w06-identity-access-review.md) | Sign-in / identity / CA evidence artifact | none | W01, W05 |

W02, W03, W04 and W05 are mutually independent once W01 has merged and may run in
parallel. W06 needs both W01 and W05.

**Ship W05 at least one full deliverable period before W06's first artifact is
promised to a customer.** Graph retains sign-in logs ~30 days, so
`m365_signin_events` can only accumulate forward from first sync; a W06 artifact
generated the week W05 lands covers almost nothing and must say so.

---

## Migration slots reserved

The newest migration on `origin/main` at plan time (2026-09-14) is
`apps/api/migrations/2026-10-16-182600-ticket-comment-proposal-note-uq.sql`.
Repo filenames run **ahead of real time** (`apps/api/migrations/README.md`
Rule 3), so a file named for today would replay *before* main's newest. These
slots are chosen to sort after it.

| Slot | Wave | Contents | Writes rows? |
|---|---|---|---|
| `2026-10-17-090100-deliverable-template-auto-evidence-type.sql` | W01 | `ADD COLUMN IF NOT EXISTS auto_evidence_report_type report_type` on `deliverable_template_items` | no (DDL only) |
| `2026-10-17-090200-sd-evidence-report-run-idx.sql` | W01 | index `sd_evidence_report_run_idx` on `service_deliverable_evidence (report_run_id)` — the OD-12 gate's lookup key. **No new column**: the gate is derived from `service_deliverable_occurrences.status`/`delivered_at`, which already exist | no (DDL only) |
| `2026-10-17-090300-sd-occurrence-auto-evidence-status.sql` | W01 | `auto_evidence_attempted_at` + `auto_evidence_refusal` on `service_deliverable_occurrences` — the queryable half of the visible refusal state | no (DDL only) |
| `2026-10-17-091000-report-type-threat-detection-review.sql` | W02 | `ALTER TYPE report_type ADD VALUE` — **alone in the file** | no |
| `2026-10-17-092000-report-type-endpoint-management-review.sql` | W03 | `ALTER TYPE report_type ADD VALUE` — **alone in the file** | no |
| `2026-10-17-093000-report-type-vulnerability-management.sql` | W04 | `ALTER TYPE report_type ADD VALUE` — **alone in the file** | no |
| `2026-10-17-094000-m365-sync-domain-signin-events.sql` | W05 | `ALTER TYPE m365_sync_domain ADD VALUE` — **alone in the file** | no |
| `2026-10-17-094100-m365-signin-events.sql` | W05 | table + indexes + RLS enable/force/policy | no |
| `2026-10-17-095000-report-type-identity-access-review.sql` | W06 | `ALTER TYPE report_type ADD VALUE` — **alone in the file** | no |

Rules these slots obey, restated because each is a shipped-bug class:

- **An `ALTER TYPE … ADD VALUE` sits alone in its own migration file.** `autoMigrate`
  wraps each file in one transaction and a label added by `ALTER TYPE` cannot be
  *used* until that transaction commits. Precedent:
  `apps/api/migrations/2026-10-16-180700-report-type-hardware-lifecycle.sql`.
- **One enum label per wave, added by that wave.** A wave that slips must not
  leave a shipped, unusable label behind — enum labels cannot be dropped.
- **Every file is idempotent** (`ADD VALUE IF NOT EXISTS`, `ADD COLUMN IF NOT
  EXISTS`, `CREATE TABLE IF NOT EXISTS`, `pg_policies` existence checks) and
  carries **no inner `BEGIN;`/`COMMIT;`**.
- **No file in this feature writes rows**, so none needs
  `SELECT set_config('breeze.scope', 'system', true);`. If an executor adds a
  backfill to any of them, that line must precede the first `UPDATE`/`DELETE`/
  `INSERT` — and the file must **never** be added to `migrationRlsScope.test.ts`'s
  frozen baseline (#4518).
- **Re-check at the start of every wave**: `ls apps/api/migrations | sort | tail -3`
  and `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3`.
  Rename upward if `origin/main` gained a later file — the pre-push hook re-runs
  `scripts/check-migration-naming.sh --against-ref origin/main`, so a name that was
  fine at commit time can fail at push time.
- **Never edit a shipped migration.** Renaming counts as editing once merged.

---

## Cross-wave contracts

These four contracts are defined in **W01** and consumed verbatim by W02–W06.
A drift in any of them is a silent feature failure, not a compile error.

### 1. The managed-definition registry

**File:** `apps/api/src/services/managedEvidenceRegistry.ts` (new, W01 Task 3).

A **closed, server-owned** map from a registry key to a report type and its
default config. A partner cannot mint an entry; the object is a frozen module
constant and the only authority for what the system execution path may run.

```ts
export const MANAGED_EVIDENCE_REGISTRY = {
  threat_detection_review:   { type: 'threat_detection_review',   defaultConfig: { /* W02 */ } },
  endpoint_management_review:{ type: 'endpoint_management_review',defaultConfig: { /* W03 */ } },
  vulnerability_management:  { type: 'vulnerability_management',  defaultConfig: { /* W04 */ } },
  identity_access_review:    { type: 'identity_access_review',    defaultConfig: { /* W06 */ } },
} as const satisfies Record<string, ManagedEvidenceEntry>;
```

**The registry key is the report type string, identically spelled.** There is no
second naming space. W01 ships the registry with the map **empty** and the type
machinery in place; each of W02, W03, W04 and W06 adds exactly one entry in the
same PR that adds its enum label.

A hand-parallel tuple `MANAGED_EVIDENCE_REPORT_TYPES` lives in
`packages/shared/src/validators/deliverableTemplates.ts`, because the shared
validator cannot import from `apps/api`. `managedEvidenceRegistry.test.ts` pins
the two together, and W02 adds a second assertion pinning every registry entry to
a matching `PORTAL_DEFINITIONS` row (same `definitionName`, same config). Each
later wave therefore edits **three** places for its one type and the tests catch
any one of them being missed.

Per **OD-4 = A**, the *persisted* registry is the existing partial unique index
`reports_portal_self_service_org_type_uniq (org_id, type) WHERE portal_self_service`
(`apps/api/src/db/schema/reports.ts:99`). **No column is added to `reports`.**
"The managed definition for org O and type T" means: the single
`portal_self_service = true` row of that type in that org.

### 2. `deliverable_template_items.auto_evidence_report_type`

A **type**, never an id (W01 Task 1). A partner-wide template item has
`org_id IS NULL` and therefore can never name a `reports.id` — the composite FK
`(report_id, org_id) → reports(id, org_id)` would be unsatisfiable. Naming a type
is org-independent and resolves per target org at apply time (**OD-6 = A**), inside
`applyTemplateSet`'s existing all-or-nothing transaction, **on the real `tx`
executor** (the ambient `db` handle does not join a nested transaction —
`apps/api/src/services/serviceDeliverableService.ts:52`).

The column is `included` in `CORE_TENANT_EXPORT_POLICY` (an enum label, not a
secret). Because `deliverable_template_items` is already in
`CORE_ORG_CASCADE_DELETE_ORDER`, **this column addition alone reddens
`tenant-export-policy.integration.test.ts` until classified** — the one
registration rule that fires on a new *column*.

### 3. The publication gate (OD-12 = A)

Customer visibility of a managed-evidence run is keyed on the **occurrence being
delivered**, not on the run completing. Without this, `portalRunListPredicate`
(`apps/api/src/services/portal/reportsSelfService.ts:267-277`) — which filters on
`reports.org_id`, `portal_self_service = true` and `status = 'completed'`, with
**no type filter and no `requested_by_kind` filter** — would expose a security
finding to the customer at 05:18 on the due day, before the technician who is
supposed to review it has seen it.

**The gate is derived, not stamped — no new column.** A completed run is
portal-visible when it is *not* referenced by any deliverable evidence row, **or**
when a referencing evidence row's occurrence has `status = 'delivered'`. The
occurrence already carries `delivered_at`, `delivered_by_user_id` and
`delivered_via`, so the audit trail a stamped `published_at` column would have
bought already exists — and a derived gate cannot drift when a delivery is
reverted or the occurrence is waived, which a stamped column silently would.
The only DDL W01 needs for it is an index on
`service_deliverable_evidence (report_run_id)`.

The same gate is applied in **two** places, and missing either one defeats it:
`portalRunPredicate` / `portalRunListPredicate`
(`apps/api/src/services/portal/reportsSelfService.ts:254-277`, which govern list
and download) **and** `publishableEvidence`
(`apps/api/src/services/portal/serviceReadModel.ts:112`, which governs the
scorecard's evidence link).

W01 adds the gate and W02–W06 rely on it without re-implementing it. The
contract for later waves is one sentence: **provisioning a managed evidence
definition as `portal_self_service` does not publish its runs; delivery does.**

`portal_self_service = true` is still mandatory on the definition, because
`apps/api/src/services/portal/serviceReadModel.ts:112` requires it for the
evidence to appear on the scorecard at all. The gate is additive on top of it.

### 4. Period boundary and prior-occurrence baseline (OD-11 = A)

Two defects in the shipped path, both verified in the spec §3.1 rule 3:

- `apps/api/src/services/deliverableAutoEvidence.ts` **never calls
  `previousBaselineFor`**, so every sweep-generated run has `previous` undefined.
- `previousBaselineFor(reportId, scopeFingerprint)`
  (`apps/api/src/services/reportGenerationService.ts:86-104`) keys on report id and
  scope fingerprint **only**. Once an org has one shared managed definition per
  type, a monthly and a quarterly deliverable on that definition would compare
  each other's runs.

W01 therefore establishes:

- **The window is the occurrence's own period**, passed explicitly into
  generation. Generation still runs at 05:18 **on the due day** (#5573 semantics
  unchanged), so the period has not closed; **the artifact states the window it
  actually covers** — `covers <period_start> to <generated_at> UTC` — in
  `result.summary`, and every renderer prints it on the cover.
- **The baseline is the prior *comparable occurrence's* run** — same deliverable,
  same cadence — not "the last completed run of this report". The selector is
  keyed on deliverable + cadence, not report id.
- **Comparators live in `result.summary`, never only in `result.rows`**, so a
  later period can compare without re-reading raw rows. This is also what keeps
  raw-data retention short (W05: 120 days).

Every report generator W02–W06 receives the period and the prior-occurrence
baseline through the same parameter shape; none of them re-derives a window from
`now()`.

---

## One correction to the approved spec, argued not assumed

**W05's org-merge classification.** Spec §4.2 tells the executor to register
`m365_signin_events` as a *resolve-phase snapshot*, "alongside the five existing
M365 tables in `orgMergeCustomExecutors.ts:444`". **The W05 plan deliberately does
not do that**, and says why in full at its Task 4.

In short: those five tables are deleted on merge for two stated reasons
(`orgMergeRegistry.ts:410-421`) — they carry composite FKs that would be violated
at COMMIT, **and** every row is *"a re-derivable snapshot of a Microsoft tenant …
the next run repopulates"*. Neither holds for `m365_signin_events`: it carries
**no composite FK** (that is the point of omitting `connection_id`), and it is
**not re-derivable** — Graph retains sign-in logs ~30 days, so a merge that
deleted them would destroy evidence nothing can reproduce. The registry draws
exactly this distinction one screen further down
(`orgMergeRegistry.ts:422-426`): *"History is NEVER deleted: it cannot be
regenerated."* `m365_signin_events` belongs with the history tables as
`repoint-dedupe` on `graph_id`, and it already carries the unique index such a
classification needs.

No Open Decision covers this, and the spec's own §3.5.2 retention rationale
("Breeze accumulates forward from first sync only … those events are
unrecoverable") is the argument for treating it as history. W05's PR body states
the correction so a reviewer sees the reasoning rather than a silent divergence,
and its integration Case 7 proves the behaviour.

---

## Constraints that apply to every wave

- **Persisted data only. No Graph or vendor HTTP call inside a report run**
  (OD-2 = A). Freshness is a property the artifact *prints*, not something it
  fetches.
- **Freshness for M365-backed reports is `last_complete_snapshot_at`, never
  `last_success_at`.** `writeCompletion` (`apps/api/src/services/m365Sync/run.ts:373-376`)
  advances `lastSuccessAt` on a `partial` outcome too; only `lastCompleteSnapshotAt`
  means the tenant was enumerated. Staleness is judged against the sync cadence,
  not the reporting period.
- **Unmeasured ≠ zero.** Every section that can be unmeasured renders "N/A — no
  data" with the reason, following `pctOrNull`
  (`apps/api/src/services/securityComplianceReport.ts:48`) and `dataGap`
  (`apps/api/src/services/securityPosture.ts:265`). A missing-source artifact must
  never imply the review found zero problems. Coverage goes into `summary` as
  structured fields, not only as prose on the cover.
- **Readers are modelled on `securityComplianceReportVulnerabilities.ts`, never on
  `apps/api/src/services/aiAgents/sweepEvidence.ts`** — the latter is capped at 25
  rows/kind and 12 KB, excludes every jsonb/text column, and requires a pre-held
  SYSTEM context (a tenant-isolation hazard in a request path). No module from
  `#5751` is imported.
- **Site scope is applied in every query branch independently** (the
  `hardwareLifecycleReport.ts` precedent), and each type declares its
  restricted-scope behaviour (OD-8 = A).
- **The four types stay out of `PORTAL_REPORT_TYPES`** and out of the two
  duplicated portal-user execution allowlists in `reportGenerationService.ts`
  (`:248`, `:760`) — the customer sees and downloads what the plan produced but
  cannot generate it (OD-10 = A).
- **Every wave that adds a portal-provisioned type must widen `PortalRunDto.type`**
  (`packages/shared/src/types/portalVisibility.ts:246-252`) **and** the type union
  + label map in `apps/portal/src/components/portal/ReportRunList.tsx` — label
  only, no generate button. `portalRunListPredicate` has no type filter, so an
  unwidened union is a type lie the compiler cannot see because the value comes
  from the database. This is a per-wave task, not a one-off.
- **Rendering is proved on all three paths from the same stored result**:
  staff/browser (`apps/web/src/components/reports/reportExport.ts`), portal/server
  (`renderRunPdf`, `apps/api/src/services/portal/reportsSelfService.ts:589`) and
  scheduled email. A type with no `buildReportPdf` arm silently falls through to
  `renderGenericReport` and drops the entire designed summary — **no unit test
  catches that**, so each wave ships an explicit server-side PDF test.
- **The eight locale files localize the web UI only.** The PDF renderer is
  English; adding a locale block is not a localized artifact. Do not claim
  otherwise in a PR body.
- **No consent change anywhere in this feature.** Every Graph read is already
  granted by `customer-graph-read` manifest **v3**
  (`packages/shared/src/m365/profiles.ts:105-119`). Identity Protection, Defender
  for Endpoint/XDR and mailbox configuration are out of scope precisely because
  each is a **v4** bump forcing every existing customer to re-consent.

---

## CI traps — read before opening any wave PR

- **`pnpm test` does NOT run the integration or RLS contract suites.** They use
  separate vitest configs (`apps/api/vitest.integration.config.ts`,
  `vitest.config.rls.ts`) and need a live Postgres + Redis. Local unit-green is
  not CI-green. Bring up a private per-worktree stack with `pnpm test-stack up`
  and tear it down with `pnpm test-stack down` — **nothing reaps it for you**.
- **The registration-list suites only fail under Integration Tests.**
  `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`,
  `tenantExportErasureRoundtrip.integration.test.ts`,
  `orgLifecycleFoundations.integration.test.ts` and
  `rls-coverage.integration.test.ts` all need a real database, so a unit-green PR
  on a stale base can go green and redden `main` after merge. Cascade-list misses
  have shipped or blocked CI five times; code review caught them 0/5, the contract
  tests 5/5. Treat registration as a mechanical grep, not a judgement call.
- **Every wave PR targets `main`. Never stack a wave PR on a sibling branch.**
  `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based on a
  sibling branch runs **no CI at all** — only the two `smoke-binary-source-*`
  workflows, which makes `gh pr checks` read as green. If a stack is unavoidable,
  dispatch CI per branch before merging: `gh workflow run CI --ref <branch>`.
  Conversely, do **not** hand-dispatch CI on a PR that already targets `main` —
  the blocking `integration-test` job has already run.
- **Scoping a vitest run to one file:** use `cd apps/api && npx vitest run <path>`
  or `pnpm --filter @breeze/api test --run <path>`. **Never** write
  `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--`,
  vitest swallows `--run` as a positional filter, stays in watch mode and scans
  the whole project (1,470 files). Also note vitest's path filter is a plain
  substring match, not a glob: `vitest run src/routes/reports/` silently skips
  sibling files like `src/routes/reports.test.ts`.
- **Merge with `gh pr merge <N>`** — the merge queue owns the strategy. **Never
  `--admin`.**

### `M365_TENANT_SYNC_ENABLED` — W03, W04†, W05, W06

W03, W05 and W06 read M365 sync tables and are **inert unless
`M365_TENANT_SYNC_ENABLED` is on** (`apps/api/src/config/env.ts:226`, default
`false`). Each of those waves' rollout notes repeats this, and repeats the
mapping requirement:

> Setting a value in `/opt/breeze/.env` is **necessary but not sufficient**.
> Compose interpolation only happens for variables listed in the service's
> `environment:` block, so `M365_TENANT_SYNC_ENABLED` must be present in
> `/opt/breeze/.env` **and** explicitly mapped in the `api` service's
> `environment:` block of `/opt/breeze/docker-compose.yml`. Confirm per region
> before the wave's first artifact is promised to a customer.

† W04 (`vulnerability_management`) does **not** depend on M365 — it reads
`device_vulnerabilities` / `vulnerabilities`, which the agent and the NVD/MSRC/
Apple/OSV feeds populate regardless of the flag. It is listed here only so the
reader does not assume the flag gates every wave.

### Reprovision after every type-adding release

W01 wires `reports:reprovision-portal-definitions` into `apps/api/package.json`
(today `apps/api/scripts/reprovision-portal-report-definitions.ts` exists but is
referenced by **no** package script, CI job, Dockerfile or entrypoint — it is
hand-run, which is why orgs that enabled portal reports before a type existed
silently lack that definition). Every release that adds a report type must run it:

```bash
pnpm --filter @breeze/api reports:reprovision-portal-definitions            # dry run first
pnpm --filter @breeze/api reports:reprovision-portal-definitions --apply
```

Add the step to the release runbook entry for that release. Without it, orgs that
enabled portal reports earlier lack the new definition and their deliverables
never produce evidence.

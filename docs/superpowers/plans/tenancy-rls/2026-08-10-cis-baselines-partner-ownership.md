# cis_baselines partner ownership (dual-axis org XOR partner)

**Date:** 2026-08-10
**Epic:** #2135 (Partner-Wide First)
**Table:** `cis_baselines` — currently `org_id uuid NOT NULL` (`apps/api/src/db/schema/cisHardening.ts:63`), no partner axis.
**Goal:** an MSP defines one CIS benchmark baseline and it applies to every org under the partner, including orgs created later.

## Implementation status (updated 2026-08-10)

| Phase | State | Notes |
|---|---|---|
| 1 Migration | **done** | `2026-08-10-cis-baselines-partner-ownership.sql`; Q1 read branch included |
| 2 Schema + registration lists | **done** | export policy + `DUAL_AXIS_TENANT_TABLES`; cascade lists needed no edit, as predicted |
| 3 Write paths | **done** | `ownerScope` on create; `(id, orgId)` lookup replaced with owner-aware auth |
| 4 Read paths | **done** | `baselineVisibilityCondition()`; explicit `?orgId=` no longer excludes partner-wide |
| 5 Fan-out | **done** | extracted `selectCisScanTargetDevices()`; command payload re-tenanted to the device |
| 6 Agent ingest | **done** | system-context lookup; owner-aware guard; result + both events take the device's org |
| 7 Config-policy linkage | **done (no change)** | Q3 decided; verified CIS appears nowhere in `configurationPolicy.ts` |
| 8 Web UI | **in progress** | ownerScope selector + "All orgs" badge |
| 9 Tests | **done** | `cisBaselinesPartnerRls.integration.test.ts`, 14 cases, fan-out mutation-checked |
| 10 Sweep | **done** | see below; also caught `POST /cis/remediate` and the `apply_cis_remediation` AI tool |

Two findings worth recording against the plan's predictions:

- **The typechecker did most of Phase 5/6 discovery.** Making `org_id` nullable turned
  `eq(devices.orgId, baseline.orgId)` and both `publishEvent(..., baseline.orgId, ...)` calls
  into compile errors. The plan expected these to need manual hunting.
- **"Neither axis set" fails 42501, not 23514.** RLS rejects it before the CHECK is evaluated:
  with both columns NULL neither branch of the WITH CHECK can match. The test asserts what
  actually fires.

---

## 0. Verdict — is the partner axis a good fit here?

**Yes, and it is a better fit than most config tables.** A CIS Level-1 Windows benchmark is
not customer-specific data; it is an MSP standard. The current shape forces a partner with
40 orgs to hand-create 40 identical rows and 40 identical scan schedules, and there is no
way to change the benchmark version fleet-wide. Every ingredient the playbook needs already
exists: the evaluation worker (`cisJobs.ts`) runs in a **system** DB context, the child
tables (`cis_baseline_results`, `cis_remediation_actions`) already carry their own `org_id`
and are already keyed off the **device**, and `cis_baselines` has no inbound FK that needs
an org.

**But this is NOT a mechanical retrofit.** Three things make it materially harder than
`security_policies` (the reference migration):

1. **The agent command-result ingest reads `cis_baselines` inside an org-scoped RLS
   context with `currentPartnerId: null`.** A partner-wide baseline is invisible there.
   Left unfixed, every scheduled scan against a partner-wide baseline completes on the
   endpoint and then the result is silently dropped — the exact 0-row-read failure mode.
2. **Three read paths `innerJoin` `cis_baselines`.** If the baseline row is RLS-invisible
   to the reader, the join drops the *result* rows too. That is silent data loss on the
   Compliance tab, not a missing label.
3. **`cis_baselines` is a LEAF for cascade purposes but a JOIN PARENT for reads.** The
   cascade lists need almost no change; the read paths need a lot.

Risk is concentrated in Phases 4–6. Phases 1–3 and 8–9 are routine.

---

## Open questions needing a human decision

> **Decisions recorded 2026-08-10 (Todd).** Q1 → **yes**, adopt the recommendation
> (org-scoped read-only visibility via the `breeze_current_partner_id()` SELECT branch);
> Phase 1's migration is unblocked and should be written that way. Q3 → **no change** to
> `configurationPolicy.ts`, as recommended. Q2 and Q4 remain open: Q2 is a
> read-the-code question for whoever starts Phase 3 (mirror software policies, do not
> invent a fallback org), and Q4 is a product question that only matters if selective
> per-org assignment turns out to be a v1 requirement.

**Q1 — Should an ORG-scoped user see the partner-wide baselines that apply to their org?**
**DECIDED: yes** — proceed with the recommendation below.
Recommendation in this plan: **yes, read-only**, via the `breeze_current_partner_id()` SELECT
branch (exactly the mechanism in `apps/api/migrations/2026-06-13-catalog-partner-read-branch.sql`).
Rationale: without it, an org admin sees devices scanned against a baseline they cannot see,
and the `innerJoin` in `GET /cis/compliance` silently hides their own compliance results.
The alternative (partner-scope-only visibility) is cheaper but produces an empty Compliance
tab for org tokens, which is a worse bug than the one we set out to fix.
**Decide before Phase 1** — it changes the migration.

**Q2 — Does `writeRouteAudit` accept a null `orgId`?** Every CIS write route currently
audits with `orgId: baseline.orgId` / `orgId: device.orgId`. For a partner-wide create there
is no org. Confirm how `apps/api/src/services/auditEvents.ts` handles a partner-wide policy
audit today (check what `routes/software/policies.ts` does on a partner-wide create) and
mirror it. Do **not** invent a fallback org.

**Q3 — Should CIS become a linkable Configuration-Policy feature?**
`compliance` in `PARTNER_LINKABLE_FEATURE_TYPES` already maps to `automation_policies`, not
CIS. CIS has **no** `ConfigFeatureType` today and no entry in `FEATURE_TABLE_MAP`. This plan
recommends **no change** to `configurationPolicy.ts` — CIS baselines are self-scheduling
(`scan_schedule` on the row), they are not delivered through the config-policy pipeline.
Adding a `cis` feature type is a separate feature, not part of the partner-axis retrofit.
**DECIDED: no change** — `configurationPolicy.ts` is untouched by this plan.

**Q4 — Scoping a partner-wide baseline to a subset of orgs.** The playbook shape is
all-or-nothing per partner. If MSPs need "this baseline for my regulated customers only",
the answer is the selective-org-assignment work
(`docs/superpowers/plans/tenancy-rls/2026-07-08-partner-owned-policy-selective-org-assignment.md`),
not a variant of this migration. Out of scope here; flag if the requirement is actually v1.

---

## Phase 1 — Migration

**File:** `apps/api/migrations/2026-08-10-cis-baselines-partner-ownership.sql`

Naming notes, verified against the rules:
- The `2026-08-06` block is CLOSED — do not use `-g-`. A plain `2026-08-10-<slug>.sql` is correct.
- **The repo already contains future-dated migrations** (`2026-08-11` … `2026-08-19`), so
  "today's date sorts last" is **not** true in this worktree. It does not matter here:
  the only migrations that touch `cis_baselines` are `0001-baseline.sql` and
  `0048-cis-hardening.sql`, both of which sort well before. Verify with
  `grep -ln cis_baselines apps/api/migrations/*.sql` before writing — if that ever returns a
  file dated after ours, re-date.
- Three `2026-08-10-*` files already exist (`agent-versions-edition`, `extension-org-installs`,
  `installer-bootstrap-tokens-parent-index`). No conflict; no `-a-`/`-b-` infix needed because
  there is no cross-dependency.
- No inner `BEGIN;`/`COMMIT;`. Fully idempotent.

Copy `apps/api/migrations/2026-07-01-security-policies-partner-ownership.sql` as the skeleton.

### 1a. Schema

```sql
ALTER TABLE cis_baselines ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE cis_baselines ALTER COLUMN org_id DROP NOT NULL;
```

Then the guarded XOR CHECK (`DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...)`):

```sql
ALTER TABLE cis_baselines
  ADD CONSTRAINT cis_baselines_one_owner_chk
  CHECK ((org_id IS NULL) <> (partner_id IS NULL));
```

Then indexes:

```sql
CREATE INDEX IF NOT EXISTS cis_baselines_partner_id_idx ON cis_baselines(partner_id);
CREATE INDEX IF NOT EXISTS cis_baselines_partner_os_idx ON cis_baselines(partner_id, os_type);
```

**No backfill is required.** Every existing row has `org_id NOT NULL`, so the XOR CHECK is
already satisfied the moment `partner_id` defaults to NULL. There is no `UPDATE`/`DELETE`
cleanup statement in this migration, so the `GET DIAGNOSTICS n = ROW_COUNT` reporting rule
does not apply. Add a one-line comment saying so, so a reviewer does not go looking for it.

Order inside the file matters: `ADD COLUMN` → `DROP NOT NULL` → CHECK → indexes → RLS.
Do **not** drop NOT NULL before the column exists; do not add the CHECK before the drop.

### 1b. RLS

The existing policies are the four per-command `breeze_org_isolation_*` from
`0048-cis-hardening.sql:127-139`. Drop all four (plus a defensive
`DROP POLICY IF EXISTS cis_baselines_isolation`) and install:

- `cis_baselines_isolation` (FOR ALL) — the write/ownership policy:
  ```
  USING / WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  ```
- **If Q1 = yes**, additionally a `cis_baselines_partner_wide_select` policy FOR SELECT:
  ```
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())
  ```
  Separate policy, SELECT only — permissive policies OR together, so this widens reads
  without touching INSERT/UPDATE/DELETE. This is the shape of
  `2026-06-13-catalog-partner-read-branch.sql`, except that migration folds the branch into
  a single combined SELECT policy; a separate policy is preferred here so the
  `rls-coverage` dual-axis assertion still sees a policy whose predicate names
  `breeze_has_partner_access` for all four commands.

Re-assert `ENABLE`/`FORCE ROW LEVEL SECURITY` for idempotence.

**Deliberate:** agent contexts set `currentPartnerId: null`
(`apps/api/src/middleware/agentAuth.ts:657`, `apps/api/src/routes/agentWs.ts:1498`), so the
Q1 read branch does **not** leak partner-wide rows to agents. Phase 6 handles the agent
read a different way, on purpose.

### Verify Phase 1

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate            # apply twice — second run must be a clean no-op
pnpm db:migrate
pnpm db:check-drift        # after Phase 2 schema edit; expect no drift
pnpm --filter @breeze/api test -- autoMigrate.test.ts
```

Manual forge as `breeze_app` (`docker exec -it breeze-postgres psql -U breeze_app -d breeze`):
an insert with both axes set, and one with neither, must both fail `23514`; a cross-partner
partner-wide insert must fail `42501`.

---

## Phase 2 — Drizzle schema + the four registration lists

### 2a. `apps/api/src/db/schema/cisHardening.ts`

- `import { partners } from './partners';` (confirm the module path used by
  `securityPolicies` / `softwarePolicies` and copy it).
- `orgId: uuid('org_id').references(() => organizations.id)` — drop `.notNull()`.
- add `partnerId: uuid('partner_id').references(() => partners.id)`.
- add the two new indexes to the table's index block so `db:check-drift` stays clean.
- Leave `cisBaselineResults.orgId` and `cisRemediationActions.orgId` **NOT NULL**. They are
  device-tenanted, not baseline-tenanted. This is load-bearing — see Phase 5/6.

### 2b. `apps/api/src/services/tenantCascade.ts`

`cis_baselines`, `cis_baseline_results`, `cis_remediation_actions` are already in
`CORE_ORG_CASCADE_DELETE_ORDER` (lines 114-116) in the correct FK order
(`cis_baseline_results` < `cis_baselines` by `localeCompare`, and it is the FK child).
**No edit required.** Confirm the behaviour is still right after the change:

- Org erasure deletes results/actions by their own `org_id` and deletes only the
  **org-owned** baselines (`WHERE org_id = $1` skips partner-wide rows) — correct.
- Partner erasure uses an `information_schema`-driven sweep of every table with a
  `partner_id` column (`tenantCascade.ts:900,915`), so `cis_baselines` is picked up
  **automatically** once the column exists. `cis_baseline_results.baseline_id` is
  `ON DELETE CASCADE` and `cis_remediation_actions.baseline_id` is `ON DELETE SET NULL`,
  so no FK violation. Add a comment at lines 114-116 noting the dual axis so the next
  person does not "fix" it.

### 2c. `apps/api/src/services/tenantExportPolicyRegistry.ts`

**This is the row that fires on a new COLUMN, and it is the one that gets missed.**
Line 92's `cis_baselines` entry must gain `"partner_id"` to its `included` array, mirroring
`security_policies` (line 277) and `software_policies` (line 297) which both list
`partner_id` as `included`. Nothing else changes.

### 2d. `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

Add `'cis_baselines'` to `DUAL_AXIS_TENANT_TABLES` (line 268) with a comment in the house
style: converted from org-only in `2026-08-10-cis-baselines-partner-ownership`; the `org_id`
column means org auto-discovery already asserts the `breeze_has_org_access` branch, so this
entry is what asserts the `breeze_has_partner_access` branch; CHECK constraint
`cis_baselines_one_owner_chk`; functional proof in `cisBaselinesPartnerRls.integration.test.ts`.

### Verify Phase 2

```bash
pnpm db:check-drift
pnpm --filter @breeze/api test -- cascadeDelete.test.ts moveOrg.coverage.test.ts
pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts \
  tenantCascade.integration.test.ts tenant-export-policy.integration.test.ts \
  tenantExportErasureRoundtrip.integration.test.ts rls-coverage.integration.test.ts
```

(Integration suites need a live DB; locally they want `fsync=off` + tmpfs or they look hung.)

---

## Phase 3 — Write paths (`apps/api/src/routes/cisHardening.ts`)

### 3a. `POST /cis/baselines` (create) — lines 212-308

- `upsertBaselineSchema` gains `ownerScope: z.enum(['organization','partner']).optional()`.
- **Create-only.** If `body.id` is present and `body.ownerScope` is present, return 400
  (`ownerScope cannot be changed on an existing baseline`). The ownership axis is immutable
  after create, matching every other dual-axis table.
- When `ownerScope === 'partner'`:
  - gate on `canManagePartnerWidePolicies(auth)` from
    `apps/api/src/services/partnerWideAccess.ts` — the single source of truth. On failure
    return 403 with `PARTNER_WIDE_WRITE_DENIED_MESSAGE`.
  - **skip `resolveOrgId(auth, body.orgId, true)` entirely.** As written (line 221) it hard-
    fails a multi-org partner with `orgId is required` — that is exactly the caller who wants
    a partner-wide baseline. If `body.orgId` is also present, return 400
    (`orgId cannot be combined with ownerScope: "partner"`).
  - insert `{ orgId: null, partnerId: auth.partnerId }`. Derive the partner from the token,
    never from the body.
- When `ownerScope` is absent or `'organization'`: unchanged behaviour.
- Audit: resolve per Q2.

### 3b. `POST /cis/baselines` (update) — the `(id, orgId)` lookup at lines 230-242

This is the specific break. Replace:

```ts
.where(and(eq(cisBaselines.id, body.id), eq(cisBaselines.orgId, orgId)))
```

with an ownership-OR lookup:

```ts
const ownership: SQL[] = [];
const orgCond = auth.orgCondition(cisBaselines.orgId);   // null for system scope
if (orgCond) ownership.push(orgCond);
else ownership.push(sql`${cisBaselines.orgId} IS NOT NULL`); // system: any org-owned row
if (auth.scope === 'partner' && auth.partnerId) {
  ownership.push(and(isNull(cisBaselines.orgId), eq(cisBaselines.partnerId, auth.partnerId))!);
}
// system scope may also reach partner-wide rows
const where = and(eq(cisBaselines.id, body.id), or(...ownership));
```

The `auth.scope === 'partner'` gate is mandatory: an org token carries a `partnerId` but
never passes `breeze_has_partner_access`, so an app-layer partner branch on an org token
would produce a confusing 0-row 404 at best and an inconsistency claim at worst. RLS is
stricter than the app layer — do not claim parity in the comment.

Then, before the `UPDATE`: if `existing.partnerId !== null` and
`!canManagePartnerWidePolicies(auth)` → 403 `PARTNER_WIDE_WRITE_DENIED_MESSAGE`. A partner
user with `orgAccess: 'selected'` can *see* the partner-wide row (Q1 branch) but must not
edit it.

The `.set({...})` block must not touch `orgId`/`partnerId`.

### 3c. `POST /cis/scan` — lines 310-389

Three separate breaks:

1. Baseline lookup (lines 319-322): `auth.orgCondition(cisBaselines.orgId)` and
   `eq(cisBaselines.orgId, body.orgId)` both fail on `org_id NULL`. Use the same
   ownership-OR helper as 3b. When `body.orgId` is supplied **and** the baseline is
   partner-wide, `body.orgId` should be interpreted as "scan only this org's devices", not
   as an ownership filter — carry it forward to `scheduleCisScan` (see 3d) instead of
   applying it to the baseline query.
2. Device scoping (line 343): `eq(devices.orgId, baseline.orgId)` no-ops on NULL. Replace
   with an ownership-aware device condition (extract it — Phase 5 needs the same one):
   ```ts
   baseline.orgId
     ? eq(devices.orgId, baseline.orgId)
     : inArray(devices.orgId, db.select({ id: organizations.id }).from(organizations)
         .where(and(eq(organizations.partnerId, baseline.partnerId!),
                    ne(organizations.type, 'quick_support'))))
   ```
   The `quick_support` exclusion mirrors `apps/api/src/services/automationRuntime.ts:90,121`
   — the canonical partner fan-out in this repo. (`devices.isEphemeral = false` in Phase 5
   is the belt to this braces; keep both.)
   Additionally intersect with `auth.accessibleOrgIds` for a partner token with
   `orgAccess: 'selected'` — a partner-wide baseline must not let a selected-access tech
   scan devices in orgs outside their selection.
3. Audit (line 373): `orgId: baseline.orgId` is null for partner-wide. Per Q2.

### 3d. `scheduleCisScan` / job payload

`scheduleCisScan(baselineId, { requestedBy, deviceIds })` needs an optional
`targetOrgId?: string` so a partner-scope user can scan one org's devices against a
partner-wide baseline. Thread it into `RunBaselineScanJobData` and into the Phase 5 device
condition. Keep the jobId shape (`'-'` separators, never `':'` — BullMQ rejects a custom
jobId whose colon-split length ≠ 3, see #1101); append the org segment or `'all'`.

### Verify Phase 3

```bash
pnpm --filter @breeze/api test -- cisHardening_baselines.test.ts \
  cisHardening_scan_report.test.ts cisHardening_list_multitenant.test.ts \
  cisHardening_remediate.test.ts cisHardening_site_scope.test.ts
```

---

## Phase 4 — Read paths (the silent-data-loss phase)

Every one of these `innerJoin`s `cis_baselines`. If the baseline row is RLS-invisible, the
join drops the **result** row, not just the baseline label.

| Path | File:line | Join | Break |
|---|---|---|---|
| `GET /cis/baselines` | `routes/cisHardening.ts:176-180` | — | org-only filter; partner-wide rows never listed |
| `GET /cis/compliance` | `routes/cisHardening.ts:465` | inner | results vanish for org tokens |
| `GET /cis/devices/:id/report` | `routes/cisHardening.ts:611` | inner | same |
| `GET /cis/remediations` | `routes/cisHardening.ts:1054` | **left** | `baselineName` goes null — cosmetic only |
| AI `get_cis_compliance` | `services/aiToolsCisBenchmark.ts:152` | inner | same as compliance |
| AI `get_cis_device_report` | `services/aiToolsCisBenchmark.ts:293` | inner | same |
| Compliance report | `services/securityComplianceReport.ts:384-386` | none | reads results by `org_id` only — **safe, no change** |

**Fix, given Q1 = yes:** the `breeze_current_partner_id()` SELECT branch from Phase 1b makes
partner-wide baselines readable to any user token under that partner (org- *and* partner-
scoped), which makes all four `innerJoin`s correct again with **zero query changes**. That is
the whole reason Q1 is recommended.

**If Q1 = no**, all four inner joins must become `leftJoin` + null-tolerant mapping, and the
UI/AI response shapes must handle a null baseline. That is strictly more code and more risk.

**`GET /cis/baselines` still needs an explicit change either way** — RLS visibility does not
add rows to a query whose `WHERE` says `eq(cisBaselines.orgId, orgResult.orgId)`. Replace
lines 174-180 with:

```ts
const ownership: SQL[] = [];
if (orgResult.orgId) ownership.push(eq(cisBaselines.orgId, orgResult.orgId));
else { const c = auth.orgCondition(cisBaselines.orgId); if (c) ownership.push(c); }
if (auth.partnerId) {
  ownership.push(and(isNull(cisBaselines.orgId), eq(cisBaselines.partnerId, auth.partnerId))!);
}
if (ownership.length) conditions.push(or(...ownership)!);
```

Note the partner branch here is **not** gated on `auth.scope === 'partner'`, unlike the write
path in 3b — because with Q1 the RLS SELECT branch admits org tokens too, and an org admin
listing baselines *should* see the partner-wide ones that scan their devices. Add
`ownerScope: row.orgId ? 'organization' : 'partner'` to `mapBaselineRow` so the UI can badge
them without inferring from a null.

Also add `partnerId` to the `mapBaselineRow` output only if the web types need it; otherwise
keep the API surface to `ownerScope`.

### Verify Phase 4

Unit tests above, plus a new case in `cisHardening_list_multitenant.test.ts`: an org token
under partner P sees a partner-wide baseline of P and does **not** see one of partner Q.

---

## Phase 5 — Evaluation fan-out (`apps/api/src/jobs/cisJobs.ts`)

The worker runs under `runWithSystemDbAccess` (line 19-26), so RLS is not the problem here —
the `WHERE` clauses are.

### 5a. `processScheduleScans` (lines 74-136) — **no change needed**

It selects due baselines by `is_active` + `scan_schedule` with no org predicate, so
partner-wide rows are picked up automatically. One partner-wide baseline still produces one
job (correct — the job fans out). The `nextScanAt` write-back is per-baseline, so a
partner-wide baseline has one shared schedule across all orgs. That is the intended semantic;
say so in a comment.

### 5b. `processRunBaselineScan` (lines 138-213) — **the critical fan-out**

Line 169: `eq(devices.orgId, baseline.orgId)` silently matches **zero rows** when
`org_id IS NULL`. Replace with the ownership-aware condition from 3c (extract it into a
shared helper, e.g. `baselineDeviceOrgCondition(baseline)` in
`apps/api/src/services/cisHardening.ts`, and use it from both call sites):

```ts
const orgScope = baseline.orgId
  ? eq(devices.orgId, baseline.orgId)
  : inArray(devices.orgId, db.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.partnerId, baseline.partnerId!),
                 ne(organizations.type, 'quick_support'))));
const deviceConditions = [
  orgScope,
  eq(devices.isEphemeral, false),
  eq(devices.osType, baseline.osType),
  ne(devices.status, 'decommissioned'),
];
if (data.targetOrgId) deviceConditions.push(eq(devices.orgId, data.targetOrgId));
if (data.deviceIds?.length) deviceConditions.push(inArray(devices.id, data.deviceIds));
```

Keep the existing Quick Support commentary (lines 163-167) and extend it: the org subquery
already excludes `quick_support` orgs, and `isEphemeral = false` remains the per-device belt.

**Guard against the empty-partner case:** if `baseline.orgId === null && baseline.partnerId === null`
(should be impossible given the CHECK), log and return 0 rather than building a
match-everything predicate. `automationRuntime.ts:73-79,108-115` does exactly this; copy it.

### 5c. Per-device command payload (lines 188-200) — **must re-tenant**

```ts
orgId: baseline.orgId,   // ← NULL for a partner-wide baseline
```

Select `devices.orgId` alongside `devices.id` (line 180) and pass the **device's** org into
the payload. The agent echoes this payload back and it is what a technician reads in the
command log; a null there is a bug report waiting to happen.

### 5d. `processAggregateScores` (lines 215-290) — **no change needed**

It groups `cis_baseline_results` by `org_id`, which is already the device's org. The
`compliance.cis_score_changed` event is published per org — correct, and it stays correct
because of Phase 6.

### 5e. `processRemediationAction` (lines 292-364) — **no change needed**

It reads `cis_remediation_actions` by id and never consults the baseline's org.

### Verify Phase 5

- `pnpm --filter @breeze/api test -- cisJobs.test.ts` with a new table-driven case:
  org-owned baseline → devices of that org only; partner-wide baseline → devices across two
  orgs of the partner, and **none** from a second partner; quick_support org excluded;
  ephemeral device excluded.
- **One integration test against real Postgres proving the fan-out fires** (playbook step 5
  requires this — a mocked-Drizzle unit test cannot prove the subquery). Add it to the
  Phase 9 suite.

---

## Phase 6 — Agent ingest (`apps/api/src/routes/agents/helpers.ts`) — highest-risk phase

`handleCisCommandResult` (line 1152) runs under an **org-scoped** RLS context in both agent
transports:

- HTTP: `apps/api/src/middleware/agentAuth.ts:648-658` wraps the whole request
  (`scope: 'organization'`, `accessiblePartnerIds: []`, `currentPartnerId: null`). The result
  route's last path segment is `result`, which is **not** in
  `SELF_MANAGED_DB_CONTEXT_ACTIONS` (line 267), so the wrap definitely applies.
- WebSocket: `apps/api/src/routes/agentWs.ts:1832-1836` dispatches through
  `runWithAgentOrgDbAccess` with the same shape.

Consequence: the baseline lookup at lines 1168-1177 returns **0 rows** for a partner-wide
baseline, the handler logs `baseline ... not found` and returns, and the scan result is
discarded. Scheduled scans would appear to run and produce nothing, forever.

### 6a. Move the baseline lookup to a system context

```ts
const [baseline] = await runOutsideDbContext(() =>
  withSystemDbAccessContext(() =>
    db.select({ id: ..., orgId: ..., partnerId: ..., name: ..., osType: ... })
      .from(cisBaselines).where(eq(cisBaselines.id, baselineId)).limit(1)
  )
);
```

This is the heartbeat probe-config pattern (#1105). Two hazards to respect, both documented
in `agentWs.ts:1470-1490`:
- a **bare** nested `withSystemDbAccessContext` opens nothing — it silently runs inside the
  org transaction under org RLS. The `runOutsideDbContext(...)` wrapper is required.
- `runOutsideDbContext` does not release the outer pooled connection, so this briefly holds
  two. Keep the wrapped work to the single PK lookup and nothing else. Do **not** widen it to
  cover the insert.

Everything else in the handler stays in the ambient org context — the result INSERT is
org-scoped to the device's own org and must remain RLS-checked.

### 6b. Replace the org-equality check (lines 1186-1197)

Current: `if (!deviceRow || deviceRow.orgId !== baseline.orgId) return;`

New — the device must be *in scope of* the baseline, not *equal to* it:

```ts
if (baseline.orgId !== null) {
  if (deviceRow.orgId !== baseline.orgId) { warn; return; }
} else {
  const [org] = await db.select({ partnerId: organizations.partnerId })
    .from(organizations).where(eq(organizations.id, deviceRow.orgId)).limit(1);
  if (!org || org.partnerId !== baseline.partnerId) { warn; return; }
}
```

The `organizations` lookup can stay in the **ambient org context** — `organizations` is
id-keyed (shape 2) and the agent's own org is inside `accessibleOrgIds`. Verify that with a
functional test rather than assuming; if it 0-rows, fold it into the same system-context
block as 6a.

### 6c. Re-tenant every write and event to the DEVICE's org

- line 1284 `orgId: baseline.orgId` → **`orgId: deviceRow.orgId`**. This is the single most
  important line in the plan. `cis_baseline_results.org_id` is NOT NULL; a partner-wide
  baseline would otherwise attempt a NULL insert and throw inside a handler whose caller
  swallows errors (`commands.ts:483-486`, `commandResultHandlers.ts:436-438`) — a silent
  stop, not a visible failure.
- line ~1306 `publishEvent('compliance.cis_deviation', baseline.orgId, ...)` →
  `deviceRow.orgId`.
- the second `publishEvent` further down (`compliance.cis_score_changed`, line ~1330) — same
  change. Read the whole tail of the function; do not pattern-match on the first two.
- `compliance.cis_remediation_applied` at line ~1438 already publishes with `action.orgId`
  (the device's org) — **correct, leave alone.**
- the `apply_cis_remediation` branch (lines ~1350-1440) reads `cis_remediation_actions` by id
  (`:1373`, `:1435`) and never consults the baseline — confirm, then leave alone.

**The Go agent needs no change.** `agent/internal/heartbeat/handlers_cis.go:10-43` reads only
`level`, `customExclusions`, and `benchmarkVersion` from the command payload; `baselineId`
and `orgId` round-trip untouched through the command row. Phase 5c's payload change is
therefore API-side only, with no agent-version coupling.

### 6d. AI tool parity — `apps/api/src/services/aiToolsCisBenchmark.ts:424-436`

`if (!baseline || baseline.orgId !== orgId || ...)` is the twin of the route check at
`routes/cisHardening.ts:717`. Apply the same org-or-partner logic in both. The remediation
row insert (`orgId` at line 439) already uses `access.device.orgId` — correct, leave it.

`routes/cisHardening.ts:707-719`: the baseline lookup has **no** ownership predicate at all
(RLS carries it), so with the Q1 SELECT branch it keeps working; only the
`baseline.orgId !== device.orgId` comparison on line 717 needs the partner branch.

### Verify Phase 6

- `pnpm --filter @breeze/api test -- 'apps/api/src/routes/agents/helpers*.test.ts'`
- New unit cases: partner-wide baseline + device in a sibling org → result row inserted with
  the **device's** org; device under a *different* partner → rejected, no row.
- An integration test that runs the handler inside a real org-scoped
  `withDbAccessContext` and asserts a row lands. A mocked-db unit test **cannot** catch the
  RLS 0-row read — this is the one place where a green unit suite means nothing.

---

## Phase 7 — Configuration-policy linkage

**Recommended: no change.** See Q3. `configurationPolicy.ts` has no `cis` feature type,
`FEATURE_TABLE_MAP` is empty of it, and `compliance` already means `automation_policies`.
If Q3 comes back "yes, add it", that is: a new `ConfigFeatureType`, an entry in the dual-axis
branch of `validateFeaturePolicyExists` (~line 2140), `PARTNER_LINKABLE_FEATURE_TYPES`, and a
delivery mechanism that does not yet exist — treat it as a follow-up plan, not a phase here.

---

## Phase 8 — Web UI

**Build on the uncommitted working-tree changes, not on `main`.** `git status` shows 8
modified files under `apps/web/src/components/cisHardening/` and
`apps/web/src/components/auditBaselines/` plus three new test files. The relevant existing
state:

- `types.ts` — `Baseline` just gained `orgId: string`. Change to
  `orgId: string | null; ownerScope?: 'organization' | 'partner'`.
- `CisBaselineForm.tsx:63` — `const targetOrgId = baseline?.orgId ?? currentOrgId;` and the
  comment above it explicitly document the `(id, orgId)` lookup. Once Phase 3b lands, an edit
  of a partner-wide baseline must send **no** `orgId`. Update the comment too; leaving a
  comment that describes the old contract is worse than no comment.
- `CisBaselinesTab.tsx:25-37` — `canCreate` / `needsOrgChoice` currently *disable* the create
  button for a multi-org partner, with a comment saying "Baselines are org-owned
  (`cis_baselines.org_id` is NOT NULL)". That premise dies with this change. A multi-org
  partner with `orgAccess: 'all'` must be able to create a partner-wide baseline; the button
  stays disabled only for a partner who can neither pick an org nor manage partner-wide
  policies.

Work:

1. **Create-only ownerScope selector** in `CisBaselineForm.tsx`, mirroring
   `apps/web/src/components/software/PolicyForm.tsx:86-114` (radio fieldset, `data-testid`
   `cis-baseline-owner` / `-partner` / `-org`, i18n keys, shown only when
   `showOwnerScope` and `!baseline`). The server derives the partner from the token — never
   send a `partnerId`.
2. **"All orgs" badge** in `CisBaselinesTab.tsx` on rows where `ownerScope === 'partner'`.
3. **Rework the create gate** as above.
4. **Edit affordance:** a partner-wide row must not offer Edit to a user who cannot manage
   partner-wide policies (mirror the server's 403 rather than letting the user discover it).
5. **Scan button** on a partner-wide row scans every org under the partner. That is a much
   bigger blast radius than today's per-org scan — add a confirmation that names the org
   count. Not optional; a mis-click currently costs one org, after this it costs forty.
6. i18n keys must be added to **every** locale or the key-parity test reds main.

7. **`CisBaselinesTab.tsx:90-92` posts `/cis/scan` with `{ baselineId }` and no `orgId`.**
   For a partner-scope user on a partner-wide baseline that now means "every org". Send the
   `targetOrgId` from Phase 3d when the user is viewing a single org, so the fleet-wide scan
   is an explicit choice made in the confirmation of item 5, not a default.

`CisComplianceTab.tsx` / `CisRemediationsTab.tsx` / `CisHardeningPage.tsx` pass `orgId`
through as a filter only — no ownership logic; verify they still behave when the compliance
response contains results whose baseline is partner-wide.
`apps/web/src/lib/routeScope.ts:97` already registers `/cis-hardening` as `org-or-all`, so
fleet view is reachable — no routing change needed.

**Docs:** update `apps/docs/src/content/docs/features/cis-hardening.mdx` to describe the
partner-wide option. `docs/guides/ADMIN_GUIDE.md:1133-1173` and
`docs/security/COMPLIANCE.md:28-44` also describe CIS baselines as org-owned.

### Verify Phase 8

```bash
pnpm --filter @breeze/web test -- cisHardening
pnpm --filter @breeze/web test -- no-silent-mutations.test.ts
pnpm --filter @breeze/web test    # i18n key parity + literal-key gate
```

`e2e-tests/seed-fixtures.sql:128-140` seeds two org-owned baselines. Add a partner-wide one
so the badge and the "All orgs" path have E2E coverage.

---

## Phase 9 — Tests (playbook step 6)

1. **`apps/api/src/__tests__/integration/cisBaselinesPartnerRls.integration.test.ts`** —
   copy `securityPoliciesPartnerRls.integration.test.ts` (222 lines, 7 cases) verbatim in
   structure:
   - partner scope INSERTs a partner-wide baseline (`org_id NULL`, `partner_id` set)
   - partner scope SELECTs it back
   - a different partner can neither see nor forge it (expect `42501`)
   - org scope INSERT/SELECT of an org-owned baseline (unchanged shape)
   - the one-owner CHECK rejects both-axes and neither-axis (expect `23514`)
   - partner scope UPDATE + DELETE of its own partner-wide row
   - **plus, for Q1:** an org-scope caller under partner P **can** SELECT P's partner-wide
     baseline (this inverts the corresponding `security_policies` assertion — call that out
     in a comment so a reviewer doesn't think it was copied wrong), and **cannot** UPDATE or
     DELETE it, and an org-scope caller under partner Q cannot see it.
2. **Fan-out integration test** (playbook step 5, mandatory): partner-wide baseline + devices
   in two orgs of the partner + one device under another partner; run
   `processRunBaselineScan`; assert commands queued for exactly the first two, and assert the
   queued payload's `orgId` equals each **device's** org.
3. **Ingest integration test** (Phase 6): run `handleCisCommandResult` inside a real
   org-scoped `withDbAccessContext` for a partner-wide baseline; assert one
   `cis_baseline_results` row with `org_id = device.orgId`.
4. Unit suites extended: `cisJobs.test.ts`, `cisHardening_baselines.test.ts`,
   `cisHardening_list_multitenant.test.ts`, `cisHardening_scan_report.test.ts`,
   `cisHardening_remediate.test.ts`, `cisHardening_site_scope.test.ts`,
   `aiToolsCisBenchmark.compliance.test.ts`, `aiToolsCisBenchmark.siteScope.test.ts`,
   `agents/helpers.*.test.ts`.
5. `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts` references CIS
   — re-run it; a partner-wide baseline must not widen the site axis.

### Full pre-PR gate

```bash
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm --filter @breeze/api exec vitest run -c vitest.config.rls.ts
pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts
pnpm db:check-drift
```

`pnpm test` alone does **not** run the RLS/integration configs. Local green ≠ CI green.
If this lands as a stacked PR, `ci.yml` triggers only on `pull_request: branches: [main]` —
dispatch explicitly: `gh workflow run CI --ref <branch>`.

---

## Phase 10 — Repo-wide sweep (playbook step 7) — completed, enumerated

Every non-test file referencing `cisBaselines` / `cis_baselines`, with disposition:

| File | Ref | Disposition |
|---|---|---|
| `apps/api/src/db/schema/cisHardening.ts` | :63 `orgId.notNull()` | **Phase 2a** |
| `apps/api/src/routes/cisHardening.ts` | :176,178 list filter | Phase 4 |
| | :234-237 `(id, orgId)` update lookup | **Phase 3b** |
| | :256 update `.where(eq(id))` | safe (id already ownership-checked) |
| | :278 insert `orgId` | Phase 3a |
| | :320,322 scan baseline lookup | **Phase 3c** |
| | :343 `eq(devices.orgId, baseline.orgId)` | **Phase 3c** |
| | :373 audit `orgId: baseline.orgId` | Phase 3c / Q2 |
| | :413,450-458,465 compliance join | Phase 4 |
| | :611 device-report join | Phase 4 |
| | :714,717 `baseline.orgId !== device.orgId` | **Phase 6d** |
| | :1050,1054 remediations leftJoin | cosmetic; Phase 4 note |
| `apps/api/src/jobs/cisJobs.ts` | :76-88 due-baseline select | no change (5a) |
| | :119-128 `nextScanAt` write-back | no change |
| | :143-150 baseline load | add `partnerId` to projection |
| | :169 `eq(devices.orgId, baseline.orgId)` | **Phase 5b — the fan-out** |
| | :194 payload `orgId: baseline.orgId` | **Phase 5c** |
| | :216-249 aggregate by `org_id` | no change (5d) |
| | :297-357 remediation action | no change (5e) |
| `apps/api/src/routes/agents/helpers.ts` | :1168-1177 baseline select under org RLS | **Phase 6a** |
| | :1186-1197 org-equality guard | **Phase 6b** |
| | :1284 `orgId: baseline.orgId` insert | **Phase 6c** |
| | :~1306, ~1330 `publishEvent(..., baseline.orgId, ...)` | **Phase 6c** |
| | :~1350+ remediation branch | verify only |
| `apps/api/src/routes/agents/commands.ts` | :480-486 dispatch (swallows errors) | context only |
| `apps/api/src/services/commandResultHandlers.ts` | :425-438 WS dispatch (swallows errors) | context only |
| `apps/api/src/routes/agentWs.ts` | :1832-1836 org wrap | context only |
| `apps/api/src/middleware/agentAuth.ts` | :648-658 org wrap, `currentPartnerId: null` | context only |
| `apps/api/src/services/aiToolsCisBenchmark.ts` | :152,293 inner joins | Phase 4 |
| | :424-436 `baseline.orgId !== orgId` | **Phase 6d** |
| | :439 insert `orgId` (device's) | already correct |
| `apps/api/src/services/securityComplianceReport.ts` | :380-386 results by `org_id` | **no change** |
| `apps/api/src/services/tenantCascade.ts` | :114-116 | comment only (2b) |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | :92 | **add `partner_id`** (2c) |
| `apps/api/src/routes/devices/core.ts` | :114,234 device cascade lists | no change (device-keyed) |
| `apps/api/src/services/configurationPolicy.ts` | — | no CIS reference (Q3) |
| `apps/web/src/components/cisHardening/*` | 5 files | Phase 8 |
| `e2e-tests/seed-fixtures.sql` | :128-140 | Phase 8 |
| `apps/api/migrations/0001-baseline.sql`, `0048-cis-hardening.sql` | shipped | never edit |

**No MCP tool, alert bridge, or report endpoint reads `cis_baselines` by org.** The only AI
surface is `aiToolsCisBenchmark.ts` (`get_cis_compliance`, `get_cis_device_report`,
`apply_cis_remediation`), registered in `aiAgentSdkTools.ts:1181-1217` with tiers
1/1/3 — the tier gating is orthogonal to ownership and needs no change.

---

## Risk register

**High**

1. **Agent ingest 0-row read (Phase 6).** Fails completely silently — the handler's callers
   swallow exceptions and the `baseline not found` path is a `console.warn`. A mocked-db
   unit test will pass while production drops every partner-wide scan result. Mitigation:
   the Phase 9.3 integration test is not optional.
2. **`innerJoin` visibility (Phase 4).** If Q1 is answered "no", or the SELECT policy is
   written into the FOR-ALL policy's `WITH CHECK` by mistake, org admins lose their entire
   Compliance tab — existing org-owned data, not just new partner-wide data. This is a
   regression for customers who never use the feature.
3. **`cis_baseline_results.org_id` NOT NULL (Phase 6c).** A single missed
   `orgId: baseline.orgId` throws inside a swallowed handler. Grep for
   `baseline.orgId` across `helpers.ts` and confirm zero survivors before merging.

**Medium**

4. **`ALTER COLUMN org_id DROP NOT NULL` is one-way in practice.** Once a partner-wide row
   exists you cannot restore the NOT NULL without deleting it. There is no rollback plan
   beyond "delete the partner-wide rows first".
5. **Blast-radius change on the Scan button (Phase 8.5).** One click goes from one org to
   every org under the partner.
6. **Partner-scope `orgAccess: 'selected'`.** A selected-access tech can *see* a partner-wide
   baseline (Q1) and can scan through it. Phase 3c intersects with `accessibleOrgIds`;
   if that is missed, it is a site/org-scope escape.
7. **`apply_cis_remediation` (AI, tier 3) inserts remediation rows pre-approved** —
   `services/aiToolsCisBenchmark.ts:439-450` writes `status: 'queued'`,
   `approvalStatus: 'approved'` directly, bypassing the maker/checker hop the REST route
   enforces (`routes/cisHardening.ts:856-871`). That is pre-existing, but the partner axis
   multiplies its blast radius from one org to a whole partner. Not in scope to fix here —
   file it, and do **not** widen the tool's org resolution while touching this file.

**Low**

8. Migration date ordering — mitigated by the explicit `grep` check in Phase 1.
9. `writeRouteAudit` null-org handling (Q2) — annoying, not dangerous.
10. `jobs/cisJobs.ts:19-26` silently degrades to running **without** any DB access context
    (`console.warn` only) if `withSystemDbAccessContext` is missing from the module, unlike
    `auditBaselineJobs.ts:13-16` which throws. Pre-existing; worth tightening to a throw
    while in this file, since the fan-out now depends on system scope for correctness, not
    just convenience.

---

## Suggested PR split

The whole thing in one PR is ~15 files and two RLS-sensitive surfaces. Prefer two, in order:

- **PR 1 (data plane):** Phases 1, 2, 5, 6, 9.1–9.3. Migration, schema, registrations,
  fan-out, agent ingest, all contract/integration tests. Ships inert — no route accepts
  `ownerScope`, so no partner-wide row can be created yet. This is the safe way to prove the
  ingest and fan-out under real Postgres before any user can produce the rows.
- **PR 2 (control plane):** Phases 3, 4, 7, 8, 9.4. Routes, reads, AI tools, UI.

Stacked PRs get **no CI** (`ci.yml` triggers on `pull_request: branches: [main]` only) —
`gh workflow run CI --ref <branch>` per branch before merging, and rebase PR 2 with
`git rebase --onto` after PR 1 squash-merges.

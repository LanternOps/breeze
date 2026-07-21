# Partner-Level Cross-Org Reports — Design

> **Status:** Design pass for a future PR. No implementation lands with this doc.
> It exists so a follow-up implementer can write the migration, routes, and
> renderer changes without re-deriving the tenancy contract.

**Goal:** Let a partner (MSP) own a report whose scope is *all of its client
orgs*, not a single org — a fleet-wide roll-up that compares posture (and later
patch) across every organization the partner manages. This is the report that
sells an MSP's value upward: one artifact, one row per client org, one
partner-level summary.

**Non-goal:** rewriting the per-org reports. Everything that exists today
(org-scoped `security_compliance_posture`, the six tabular reports, the schedule
worker, the client-side PDF) keeps working unchanged. This adds a *second
ownership axis*, following the partner-wide-first principle already applied to
configuration/software/security policies.

---

## 1. Problem

`reports.orgId` is `NOT NULL` (`apps/api/src/db/schema/reports.ts:33`). Every
report belongs to exactly one org. A partner-scope user gets per-org reports
only:

- **List** (`routes/reports/core.ts:36-52`): partner scope filters
  `inArray(reports.orgId, auth.accessibleOrgIds)` — a flat union of per-org
  rows, never a cross-org aggregate.
- **Generator** (`services/securityComplianceReport.ts:158`):
  `generateSecurityCompliancePostureReport(orgId, …)` is single-org by
  construction — every query is `eq(..., orgId)`.
- **Renderer** (`packages/shared/src/reportPdf/reportPdf.ts`): the posture cover
  + per-*device* table assume one org's device fleet.

The MSP-shaped gap is a **fleet roll-up**: one posture table with one row per
client org (devices, posture score, unprotected count, critical findings, patch
currency), plus a partner-level headline (weighted-average score, best/worst
org). There is no way to express "owned by the partner, spanning all orgs" in
the current schema.

---

## 2. Ownership axis — dual-owner `reports`

Follow the **dual-owner precedent** already shipped for
`configuration_policies` (`apps/api/src/db/schema/configurationPolicies.ts:64-82`,
migration `2026-06-27-config-policies-partner-ownership.sql`), and identically for
`custom_field_definitions`, `software_catalog`, and `client_ai_prompt_templates`
— the dual-owner (org XOR partner) tables present on this branch. On main, `software_policies`
and `security_policies` gained the same axis in commit `e42b34ac0` (#2143),
which is **not** an ancestor of this branch yet (we're stacked one commit
behind); it will be once this branch rebases after #2148 merges, giving the
implementer two more copies of the template. The pattern is settled; we are the
next table onto it.

### 2.1 Schema change

In `reports.ts`:

- Make `orgId` **nullable** (drop `.notNull()`).
- Add nullable `partnerId: uuid('partner_id').references(() => partners.id)`.
- A report is owned by **either** an org (`org_id` set, `partner_id` NULL — the
  existing shape) **or** a partner (`partner_id` set, `org_id` NULL — the new
  "all orgs" shape). Exactly one axis per row.

### 2.2 Migration `2026-07-XX-b-partner-owned-reports.sql`

Idempotent, no inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file). Mirror
`2026-06-27-config-policies-partner-ownership.sql` step-for-step:

```sql
ALTER TABLE reports ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE reports ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'reports_one_owner_chk'
                   AND conrelid = 'reports'::regclass) THEN
    ALTER TABLE reports ADD CONSTRAINT reports_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS reports_partner_id_idx ON reports(partner_id);
```

`(org_id IS NULL) <> (partner_id IS NULL)` is true iff exactly one is set. No
backfill needed: every existing row already has `org_id` set and `partner_id`
NULL, which satisfies the CHECK — so this is a pure `ADD`/`DROP NOT NULL` with
no `UPDATE` sweep and no row-count logging requirement.

### 2.3 RLS — reports moves from Shape 1 to Shape 4 (dual-axis)

**Today** `reports` rides **Shape 1 auto-discovery** on its `org_id` column:
the RLS coverage test picks it up automatically because it has an `org_id`
column and org-isolation policies. Nothing lists it explicitly.

Once `org_id` is nullable and `partner_id` exists, the org-only policy is
wrong: `breeze_has_org_access(NULL)` is `FALSE`, so a partner-owned row
(`org_id` NULL) would be **structurally invisible and uncreatable** —
`new row violates row-level security policy` on every partner-owned insert.
This is the exact failure `custom_field_definitions` hit before
`2026-06-11-i-custom-fields-dual-axis-rls.sql`.

Replace the org-isolation policy with a **dual-axis** policy in the same
migration (copy the `configuration_policies_org_isolation` shape verbatim,
`2026-06-27-...:62-74`):

```sql
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON reports;  -- and insert/update/delete
-- (drop whatever the baseline named them; check pg_policies on a live DB first)

CREATE POLICY reports_owner_isolation ON reports
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK ( … same predicate … );
```

`breeze_has_partner_access` is **flat** (never tree traversal) — a partner sees
its own `partner_id`, full stop (per CLAUDE.md and `partner_scope_flat`).

### 2.4 `report_runs` — the FK-child blindspot (MUST fix in the same migration)

`report_runs` has **no `org_id` column**. It reaches its tenant by joining
through `reports`, and is allowlisted as an FK-child in
`rls-coverage.integration.test.ts:289` → `['report_runs', ['reports']]`. Its
current policy (`2026-06-13-b-fk-child-rls-backstop.sql:181-194`) is:

```sql
EXISTS (SELECT 1 FROM reports r
        WHERE r.id = report_runs.report_id AND public.breeze_has_org_access(r.org_id))
```

When a partner-owned report has `r.org_id = NULL`, `breeze_has_org_access(NULL)`
is FALSE — so **runs of partner-owned reports become invisible and unwritable**.
The schedule worker's `INSERT INTO report_runs` would 0-row / RLS-reject. This
is precisely the config-policy child-table problem
(`2026-06-27-...:77-98`): the parent gained a partner axis and every child
policy that gated on `cp.org_id` had to OR in `cp.partner_id`.

**Fix:** extend all four `report_runs` policies to:

```sql
EXISTS (SELECT 1 FROM reports r
        WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id)
               OR public.breeze_has_partner_access(r.partner_id)))
```

`breeze_has_org_access(NULL)` / `breeze_has_partner_access(NULL)` are both
FALSE, so the org-owned case is unchanged.

**Why this is a blindspot the contract test will NOT catch on its own:** the
FK-child assertion (`PARENT_FK_JOIN_POLICY_TABLES`) only checks that the policy
*text* contains `FROM reports` and `breeze_has_org_access` — it does not exercise
a partner-owned parent functionally. A migration that dual-owns `reports` but
forgets `report_runs` passes the static allowlist check and still silently
breaks partner-owned run reads/writes. Guard it with a **functional** breeze_app
insert test (§6), not just the allowlist.

### 2.5 Contract-test allowlist changes

In `rls-coverage.integration.test.ts`:

1. **Add `'reports'` to `DUAL_AXIS_TENANT_TABLES`** (`:204-239`) with a comment
   in the same style as the `configuration_policies` entry (`:220-230`).
   Rationale to spell out: the `org_id` column means org-tenant auto-discovery
   *already* asserts the `breeze_has_org_access` branch — this allowlist entry
   is the **only** thing that asserts the `breeze_has_partner_access`
   (partner-wide) branch. **This is the dual-axis contract blindspot**: without
   the entry, a regression that drops the partner branch from the policy still
   passes because the org branch alone satisfies auto-discovery.
2. `report_runs` **stays** in `PARENT_FK_JOIN_POLICY_TABLES` (`:289`) — its
   shape is unchanged (still FK-child through `reports`); only its predicate
   gains the OR.
3. Because the dual-axis static check is a blindspot, add a **functional**
   `reportsPartnerRls.integration.test.ts` (model on
   `configurationPoliciesPartnerRls.integration.test.ts`): as `breeze_app`,
   forge a cross-partner report insert → expect `42501`; violate the XOR CHECK
   (both axes set / neither set) → expect `23514`; insert a partner-owned report
   + run under partner context → expect visible; under a *different* partner /
   an org-scope caller → expect 0 rows.

---

## 3. Report types & generator

### 3.1 New enum value(s)

Add to `reportTypeEnum` (`reports.ts:5-13`) and the mirrored `reportTypeSchema`
(`routes/reports/schemas.ts:3-11`):

- `fleet_posture_rollup` — ship this first.
- `fleet_patch_rollup` — reserved for a later PR (same shape, patch metrics).

Enum additions require an `ALTER TYPE report_type ADD VALUE IF NOT EXISTS
'fleet_posture_rollup'` **as the only statement in its own migration file** —
under autoMigrate's per-file transaction the new label is uncommitted until the
file commits, so no later statement in the same file may reference it (see
`2026-06-29-a-report-type-security-compliance.sql`, which is exactly one line
for this reason). Use a same-day `-a-`/`-b-` split: `2026-07-XX-a-report-type-
fleet-rollup.sql` (the enum value, one line) sorts before `2026-07-XX-b-partner-
owned-reports.sql` (schema + RLS below). The schema/RLS migration does not
reference the new label in SQL, so it needs no dependency on the enum file at
apply time, but the ordering keeps them coherent.

### 3.2 Generator

New `generateFleetPostureRollup(partnerId, rawConfig, perms?)`, dispatched from
`reportGenerationService` alongside the existing types.

- **Discover orgs:** `SELECT id, name FROM organizations WHERE partner_id = $1`
  (flat — a partner's direct orgs).
- **Per-org loop:** call the existing
  `generateSecurityCompliancePostureReport(org.id, cfg, perms)` per org **under
  system context**. Reuse — do not fork — the per-org generator; its output
  `summary` (`PostureSummary`) already carries everything a roll-up row needs:
  `deviceCount`, `postureScore`, `controls.unprotectedCount`,
  `controls.patchCurrentPct`, and per-severity findings.
- **Emit one row per org**, e.g.
  `{ org: name, orgId, devices, postureScore, unprotected, criticalFindings, patchCurrentPct, edrCoveragePct }`.
  The per-device detail is intentionally dropped at this level (see cost note).
- **Partner-level summary:** weighted-average posture score (weight by
  `deviceCount`, not org count — a 500-device client should move the needle more
  than a 3-device one), best/worst org by score, fleet-wide device total,
  fleet-wide unprotected total.

Return the same `ReportResult` shape (`rows`, `rowCount`, `generatedAt`,
`summary`) so the run-snapshot storage, download endpoint, and email path all
work unchanged. The partner-level headline goes in `summary`; the per-org rows
go in `rows`.

**Trend baselines (Task 6) apply unchanged:** `previousBaselineFor(reportId)`
keys on the report row, not its owner axis — a partner-owned report's previous
run is found identically, and the scorecard trend chip reads
`summary.postureScore` exactly as today.

---

## 4. Renderer

`buildReportPdf` (`reportPdf.ts:1194`) already branches on
`opts.reportType === 'security_compliance_posture'`. Add a
`fleet_posture_rollup` branch that **reuses the scorecard primitives**:

- **Cover:** `drawScorecard(doc, partnerWeightedScore, caption, stats, top, trend)`
  (`reportPdf.ts:250`) — same big-numeral + band chip + trend chip used for the
  per-org cover. `stats` (the right-rail risk stats) become fleet totals: total
  orgs, total devices, total unprotected, orgs below threshold.
- **Body:** a **per-ORG** table (new) rather than the per-*device*
  `renderPostureTable` (`:1000`). Same `autoTable` styling, two-tier header,
  colored at-risk cells, and a totals footer row — copy the structure of
  `renderPostureTable` but with org-level columns (`Org`, `Devices`, `Score`,
  `Unprotected`, `Critical`, `Patch %`). The color thresholds
  (`postureCellColor`) carry over conceptually per metric.

No server PDF engine is introduced — the PDF is still built client-side from the
stored snapshot (download endpoint returns the snapshot for `format === 'pdf'`,
`routes/reports/runs.ts:219-221`) and rendered server-side only for scheduled
email attachments (`reportScheduleWorker.ts:212-234`). The renderer lives in
`@breeze/shared` so both paths share it.

---

## 5. Routes

Mirror `configurationPolicies/crud.ts:57-118` for ownership handling. **The
partner id is ALWAYS derived from `auth.partnerId`, never client-supplied.**

### 5.1 Create — `POST /reports`

Add `ownerScope: 'organization' | 'partner'` to `createReportSchema`
(`schemas.ts:90-97`), org default. When `ownerScope === 'partner'`:

- Require `auth.partnerId` (else 403 "Partner-wide reports require partner
  scope").
- Require `orgAccess === 'all'` — read `c.get('permissions').orgAccess`, exactly
  as `crud.ts:75-78`. A `selected`/`none`-access partner user must NOT create a
  partner rollup: the report would aggregate orgs they cannot individually see.
  System scope short-circuits the gate.
- Insert `{ partnerId: auth.partnerId, orgId: null, … }`. Never read a
  client-supplied partner id.

The current create (`core.ts:180-238`) always sets `orgId`; the partner branch
sits ahead of the org logic, like the config-policy handler.

### 5.2 List / get / runs — branch on the owner axis

- **List** (`core.ts:36-55`): the partner branch currently does
  `inArray(reports.orgId, accessibleOrgIds)`. Extend it to **also** include
  `eq(reports.partnerId, auth.partnerId)` (OR the two conditions) so a partner
  sees both its per-org reports and its partner-owned rollups. **Org-scope
  callers keep the pure `eq(reports.orgId, auth.orgId)` branch — they never see
  a `partner_id` filter, so partner rollups are invisible to them at the query
  layer** (RLS is the second gate; see §7).
- **`ensureOrgAccess` / `getReportWithOrgCheck`** (`helpers.ts:8-44`) are
  app-layer gates keyed on `report.orgId`. For a partner-owned report `orgId` is
  NULL, so `canAccessOrg(null)` returns false and the helper 404s. Add a partner
  branch: if `report.partnerId` is set, authorize iff
  `auth.scope === 'system'` OR `auth.partnerId === report.partnerId`. Without
  this, get/update/delete/generate of a partner-owned report all 404 even for
  its owning partner.
- **`getReportRunWithOrgCheck`** (`helpers.ts:46-78`) selects `reports.orgId`
  for its access check — also select `reports.partnerId` and apply the same
  partner branch.
- **Runs list** (`runs.ts:122-131`): partner branch mirrors the report list —
  OR in the partner-owned reports.

### 5.3 Schedule worker — partner-timezone branch

`findDueReports` (`reportScheduleWorker.ts:121-152`) `innerJoin`s
`organizations` on `reports.orgId` to resolve the timezone
(org → partner → UTC chain, `timezoneFor` at `:94-119`). For a partner-owned
report `orgId` is NULL, so the **`innerJoin` drops the row entirely** — a
partner-owned scheduled report would never fire.

Fix:

- Change the join to a `leftJoin` on `organizations`, and **also** `leftJoin`
  `partners` directly on `reports.partnerId` (in addition to the existing
  `organizations.partnerId` join). Resolve the timezone from the org chain when
  `org_id` is set, or **from `reports.partnerId`'s partner row** (partner
  timezone → UTC) when it's a partner-owned report. `timezoneFor` already
  accepts `(orgSettings, partnerTzColumn, partnerSettings)` with `orgTz` null —
  pass the directly-joined partner's `timezone`/`settings` for the org-less case.
- `processRunScheduledReport` (`:275-343`) resolves timezone the same way
  (`:285-291`) and calls `generateReport(report.type, report.orgId, …)`. For the
  rollup, dispatch on `report.partnerId` instead of `report.orgId` — the
  dispatcher must route `fleet_posture_rollup` to `generateFleetPostureRollup`
  with the partner id. `loadReportBrandingForOrg(report.orgId)` (`:338`) needs a
  partner-branding fallback (`loadReportBrandingForPartner`) for org-less
  reports — otherwise a NULL orgId hits the branding loader.

---

## 6. Web

Follow the config-policy web precedent
(`ConfigPolicyCreatePage.tsx:41-47`):

- **Scope gate:** `const { scope, partnerId } = getJwtClaims(); const isPartnerScope = scope === 'partner' && !!partnerId;`
  Gate on the **JWT scope**, not `useOrgStore().partners.length` (per
  `web_ispartnerscope_partners_length_gate_bug` — a partners-length gate is
  broken).
- **Builder** (`ReportBuilder.tsx`): show an owner-scope selector
  (Organization / All organizations) **only** to partner-scope users. Default to
  partner-wide when the user is on the All-orgs view (no concrete org selected),
  else the focused org — same defaulting logic as
  `ConfigPolicyCreatePage.tsx:44-47`. When partner-wide, restrict the report-type
  list to the rollup types.
- **`ReportsList.tsx`:** badge partner-wide rows ("All organizations") so they
  read distinctly from per-org reports, mirroring the config-policy list badge.

---

## 7. Security invariants (non-negotiable)

1. **Org-level users must NEVER see partner rollups.** Enforced twice:
   (a) the list/get query never applies a `partner_id` filter for
   `scope === 'organization'`; (b) RLS —
   `breeze_has_partner_access(partner_id)` is false for an org-scope token, so
   even a forged `?orgId`/id probe returns 0 rows. Double-gate, never rely on the
   query alone.
2. **Partner id always derived server-side** from `auth.partnerId`. `ownerScope`
   is the only client input; a client-supplied partner id is never read
   (`crud.ts:60-63` precedent). `ownerScope` should be **create-only** — do not
   let an update flip an org report into a partner rollup (mirrors the
   security-policy "ownerScope is create-only, kept out of settings JSONB"
   decision in #2143).
3. **`orgAccess === 'all'` gate** on partner-owned create (§5.1). A `selected`
   partner user aggregating orgs they can't individually see is a data-exposure
   escalation.
4. **RLS dual-owner policy + FK-child fix + allowlist entry** ship in the same
   migration/PR (§2.3–2.5). The `report_runs` predicate MUST gain the partner
   OR, or partner-owned runs silently break under RLS.
5. **Contract-test blindspots to call out explicitly in the PR:**
   - *Dual-axis blindspot:* the static allowlist check is satisfied by the
     org-access branch alone; only the `DUAL_AXIS_TENANT_TABLES` entry + a
     functional cross-partner forge test prove the partner branch.
   - *FK-child blindspot:* the `report_runs` static check only greps policy text
     for `FROM reports` + `breeze_has_org_access`; it does not exercise a
     partner-owned parent. A functional breeze_app insert against a
     partner-owned report is the only thing that catches a forgotten partner OR.

---

## 8. Cost / fan-out note

A `fleet_posture_rollup` fans out **one full posture generation per org**. The
per-org generator issues ~15 queries (EDR, AV, patches, vulns, DNS, backup,
c2c, m365, google, PAM, elevations, CIS, posture snapshot, devices,
security_status). A 100-org partner = ~1,500 queries per rollup.

Mitigations:

- **Enqueue as a normal scheduled run** — no new queue. The
  `reportScheduleWorker` already throttles at **concurrency 2**
  (`reportScheduleWorker.ts:427`), so at most two rollups generate at once. Do
  not parallelize the per-org loop inside a single rollup unboundedly; a simple
  sequential loop (or a small bounded map, e.g. 4-wide) keeps DB pressure
  predictable and respects the US DB connection ceiling.
- **Cap orgs per rollup initially (e.g. 100).** Beyond the cap, truncate and
  **log the truncation** (`console.warn` with partner id + total vs included
  count) so it lands in logs — never silently drop orgs from an attestation.
  Surface the truncation in the report `summary` too (e.g.
  `orgsIncluded`/`orgsTotal`) so the PDF can print "showing 100 of 137 orgs".
- Consider (later, not v1) reusing the most recent stored per-org posture
  snapshot instead of regenerating, if freshness allows — out of scope here.

---

## 9. Open questions

- **Per-org site filters in rollups** — skip in v1. The per-org generator
  accepts `cfg.sites`, but a partner-level rollup has no coherent cross-org site
  semantics. Rollup config ignores `sites`.
- **Org-level users seeing partner rollups** — answered: never (§7.1),
  RLS + route double-gate.
- **Does the rollup email attach one PDF?** — **Yes.** A single branded artifact
  is the entire point of the feature. The existing email path
  (`reportScheduleWorker.ts:212-234`) renders one PDF from the snapshot; it needs
  only the partner-branding fallback (§5.3) and the new renderer branch (§4). One
  attachment, one rollup.
- **Partner branding** — `loadReportBrandingForOrg` is org-keyed; a
  `loadReportBrandingForPartner` (or a partner fallback inside the existing
  loader) is required before org-less reports can render branded. Confirm the
  branding source table has a partner axis before implementation.

---

## 10. Implementation checklist (for the follow-up PR)

- [ ] `reports.ts`: nullable `orgId`, add `partnerId`.
- [ ] Migration `2026-07-XX-a-report-type-fleet-rollup.sql`: `ALTER TYPE
      report_type ADD VALUE IF NOT EXISTS 'fleet_posture_rollup'` (one line, its
      own file).
- [ ] Migration `2026-07-XX-b-partner-owned-reports.sql`: `ADD COLUMN` /
      `DROP NOT NULL` / one-owner CHECK / partner index / dual-axis RLS on
      `reports` / **partner-OR fix on `report_runs`'s four policies**.
- [ ] `rls-coverage.integration.test.ts`: add `reports` to
      `DUAL_AXIS_TENANT_TABLES` (with rationale comment); keep `report_runs` in
      the FK-child map.
- [ ] `reportsPartnerRls.integration.test.ts`: functional cross-partner forge
      (42501), XOR CHECK (23514), partner-owned run visibility.
- [ ] `schemas.ts`: `reportTypeSchema` + `fleet_posture_rollup`; `ownerScope` on
      `createReportSchema` (create-only).
- [ ] `securityCompliance`/new `generateFleetPostureRollup` + dispatcher wiring.
- [ ] `reportPdf.ts`: `fleet_posture_rollup` branch — scorecard cover + per-org
      table + truncation line.
- [ ] `routes/reports/core.ts` + `helpers.ts` + `runs.ts`: partner-axis branches
      (create gate, list OR, access-check partner branch).
- [ ] `reportScheduleWorker.ts`: partner-timezone leftJoin branch + partner
      dispatch + partner-branding fallback.
- [ ] Web: `ReportBuilder` owner-scope selector (partner-scope only),
      `ReportsList` partner-wide badge.
- [ ] Cap + truncation logging (default 100).

---

## Self-review notes

- **Grounded against current code**, not the brief's line numbers: `report_runs`
  is an FK-child through `reports` (`rls-coverage...:289`), *not* a table with
  its own `org_id` — the single most important correctness item here, and the
  brief's dual-owner discussion would silently break it without §2.4.
- The `orgAccess === 'all'` gate lives on `c.get('permissions').orgAccess`
  (`crud.ts:75-78`); #2143 later added `partnerOrgAccess` to `AuthContext` and a
  `canManagePartnerWidePolicies()` helper — the implementer should prefer that
  single capability check if it's available on this branch, and enforce it on
  update/delete too (not just create), per the #2143 lesson.
- The schedule worker's `innerJoin organizations` (`:133`) is a real footgun for
  org-less reports — flagged as `leftJoin` + direct partner join.
- Enum-value addition is specified as its own single-statement migration
  (`-a-` before the `-b-` schema/RLS file), matching
  `2026-06-29-a-report-type-security-compliance.sql` and the uncommitted-label
  transaction rule — not folded into the schema migration.

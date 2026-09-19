---
issue: LanternOps/breeze#5784
wave: W06
spec: docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md
# tracking_issue: added by register_feature at Stage 4 — do not fill in by hand
---
# Evidence Reports W06: `identity_access_review` (Sign-in Review) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The highest-value deliverable in the plan. Sign-in log review is the
single item every managed-security plan sells, every framework asks for, and no
MSP tool in this price band produces automatically. This wave turns W05's
accumulated `m365_signin_events` — plus the identity and conditional-access data
the `#5327` sync already holds — into that artifact, with the admin sign-in detail
table an auditor reads first.

**Architecture:** A new `report_type` enum label plus a pure aggregator over
`m365_signin_events` (W05), `m365_users`, `m365_ca_policies`, `m365_posture_rollups`
and `devices.active_vpns`. Zero new tables, **no consent change**. The one
structural difference from W02–W04: **M365 identity data has no site dimension**,
so under a restricted authority this type returns the `zeroSafeReport`
empty-but-shaped result rather than silently serving an org-wide identity view
(OD-8 = A).

**Tech Stack:** PostgreSQL + Drizzle, Hono + Zod, Vitest, jsPDF +
jspdf-autotable, Astro + React islands, react-i18next.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md`
§3.5.3 (contents, config, site scope), §3.5.2 (the three limits the artifact must
print), §3.1 (the shared contract), §5.3 (the per-type wiring checklist), §6, §9.1.

**Plan index:** `docs/superpowers/plans/billing/2026-09-14-service-plan-evidence-reports.md`

**Depends on:** **W01 and W05.** W05 must have been **running in production for at
least one full deliverable period** before this wave's first artifact is promised
to a customer — Graph retains sign-in logs only ~30 days, so
`m365_signin_events` can only accumulate forward from first sync.

---

## Global Constraints

- **Consent does not change.** Every Graph read behind this artifact is already
  granted by `customer-graph-read` manifest **v3**
  (`packages/shared/src/m365/profiles.ts:105-119`): `AuditLog.Read.All` for
  sign-ins, `Policy.Read.All` for conditional access,
  `User.Read.All` + `RoleManagement.Read.Directory` for the identity inventory.
  **Identity Protection risky users/events are out** — a manifest **v4** bump
  forcing every existing customer to re-consent.
- **Interactive sign-ins only.** The artifact says "interactive sign-ins", never
  "all sign-ins". Non-interactive, service-principal and managed-identity sign-ins
  are not persisted and must not be implied.
- **Three limits the artifact must print, every time**, because consent is
  necessary but not sufficient:
  1. **Graph sign-in download requires Entra ID P1/P2.** `AuditLog.Read.All`
     grants permission; the tenant's licence grants the data. W05 persists the
     `unlicensed` outcome as a complete, zero-update success (the same handling
     `signin_activity` uses, `domains/signinActivity.ts:12-14, 59`); this report
     renders a **data-gap page**, not an empty table.
  2. **Risk fields can come back `hidden` without P2.** W05 stores Graph's
     sentinel verbatim; this report renders that section as **unmeasured**, never
     as "no risk detected".
  3. **Graph retains sign-in logs ~30 days.** Breeze accumulates forward from
     first sync only, so the first monthly report after enabling is **partial**.
     The artifact prints the window it **actually** covers plus any gap where a
     sync outage exceeded Graph's own retention — those events are unrecoverable.
- **Freshness is `last_complete_snapshot_at`, never `last_success_at`.**
  `writeCompletion` (`apps/api/src/services/m365Sync/run.ts:368-387`) advances
  `lastSuccessAt` on a `partial` outcome too. `loadSyncSummary` states the rule
  (`apps/api/src/services/m365Sync/summary.ts:60-62`). Use W03's
  `loadDomainFreshness` if W03 has landed; if it has not, add it here with the
  identical name and shape so the two waves converge rather than fork.
- **Unmeasured ≠ zero, and `mfa_registered: NULL` means UNKNOWN.**
  `m365_posture_rollups` carries `users_mfa_unknown` and `admins_mfa_unknown` for
  exactly this reason. A NULL is never rendered as "not registered".
- **Site scope: this type refuses restricted authorities (OD-8 = A).** M365
  identity data has **no site dimension**, so serving it to a site-restricted
  technician would be a scope escalation. Under
  `authority.scope.kind === 'restricted'` the generator returns the `zeroSafeReport`
  empty-but-shaped result with a data-gap line saying the report is org-wide and
  the requester's access is site-limited. This is different from W02, W03 and W04
  and must not be "fixed" to match them.
- **Remote access is labelled client presence, not policy.**
  `devices.active_vpns` (`apps/api/src/db/schema/devices.ts:188`) records which
  overlay client is up on a device; the collector header is explicit that it
  carries *"NO secrets, peer lists, keys, or VPN management"*
  (`agent/internal/collectors/vpn.go:13-18`). The section title and body must say
  **client presence**, not "VPN policy review" — a customer reading the latter
  will believe a rule review happened.
- **Persisted data only. No Graph call inside a report run.**
- **The window comes from `EvidenceRunContext`, never from `now()`** (W01, OD-11).
- `identity_access_review` stays out of `PORTAL_REPORT_TYPES` and out of the two
  duplicated portal-user allowlists in `reportGenerationService.ts` (`:248-254`,
  `:760-765`) — OD-10 = A.
- `PortalRunDto.type` and the portal `ReportRunList` union **must** be widened:
  `portalRunListPredicate` has no type filter, so an unwidened union is a type lie
  the compiler cannot see because the value comes from the database.
- A type with no `buildReportPdf` arm silently falls through to
  `renderGenericReport` (`packages/shared/src/reportPdf/reportPdf.ts:2018-2020`)
  and drops the whole designed summary — **no unit test catches that**, so this
  wave ships an explicit server-side PDF test.
- **This artifact carries sign-in PII** (user principal names, IP addresses,
  cities). It reaches the customer only through W01's OD-12 delivery gate, and
  the PDF is never persisted (`report_runs.result` is jsonb only). Say both in
  the PR body.
- The eight locale files localize the **web UI only**; the PDF renderer is English.
- Migration filenames must sort after the newest on `origin/main` — re-check at
  the start of this wave.
- Run one API test file as `cd apps/api && npx vitest run <path>`. **Never**
  `pnpm --filter <pkg> test -- --run <path>`.
- Branch `feature/<parent#>-service-plan-evidence-reports/wave-<W06 sub-issue#>`,
  **targeting `main`**. PR body contains `Closes #<W06 sub-issue>`.

### Rollout gate — `M365_TENANT_SYNC_ENABLED`, and W05's head start

**This wave is inert unless `M365_TENANT_SYNC_ENABLED` is on**
(`apps/api/src/config/env.ts:222-228`, default `false`).

> Setting a value in `/opt/breeze/.env` is **necessary but not sufficient**.
> Compose interpolation only happens for variables listed in the service's
> `environment:` block, so `M365_TENANT_SYNC_ENABLED` must be present in
> `/opt/breeze/.env` **and** explicitly mapped in the `api` service's
> `environment:` block of `/opt/breeze/docker-compose.yml`. Confirm per region.

**And confirm W05 is actually accumulating before promising this artifact.** Run,
per region:

```sql
SELECT org_id, MIN(signed_in_at), MAX(signed_in_at), COUNT(*)
FROM m365_signin_events GROUP BY org_id ORDER BY 2;
```

An org whose earliest event is two days old gets a two-day report, and the
artifact will correctly say so — but a customer promised a monthly review will
read that as a failure. Ship this wave only where W05 has a full period behind it.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-17-095000-report-type-identity-access-review.sql` | enum add, **alone in the file** |
| `apps/api/src/db/schema/reports.ts` | the enum literal |
| `apps/api/src/services/reportGenerationService.ts` (+ `.test.ts`) | union + both exhaustive switches |
| `apps/api/src/services/managedEvidenceRegistry.ts` (+ `.test.ts`) | the wave's one registry entry |
| `packages/shared/src/validators/deliverableTemplates.ts` | `MANAGED_EVIDENCE_REPORT_TYPES` gains a member |
| `apps/api/src/routes/reports/schemas.ts` (+ `schemas.config.test.ts`) | config schema + parallel fields |
| `apps/api/src/services/identityAccessReport.ts` (+ `.test.ts`) | the generator |
| `packages/shared/src/types/identityAccessReport.ts` | the summary type |
| `packages/shared/src/utils/identityAccess.ts` (+ `.test.ts`) | shared arithmetic |
| `packages/shared/src/reportPdf/identityAccessPdf.ts` | the renderer |
| `packages/shared/src/reportPdf/reportPdf.ts` (+ `reportPdf.identityAccess.test.ts`) | arm + label |
| `apps/api/src/services/portal/reportsSelfService.ts` | `PORTAL_DEFINITIONS` entry |
| `packages/shared/src/types/portalVisibility.ts`, `apps/portal/src/components/portal/ReportRunList.tsx` | portal unions |
| `apps/web/src/components/reports/*` | six wiring points + options form |
| `apps/web/src/locales/*/reports.json` | key blocks × 8 locales |
| `apps/api/src/__tests__/integration/identityAccessEvidence.integration.test.ts` | sweep → evidence |

---

### Task 1: Enum migration

**Files:**
- Create: `apps/api/migrations/2026-10-17-095000-report-type-identity-access-review.sql`

**Interfaces:**
- Produces: the `report_type` label `'identity_access_review'`.

**Alone in the file.** `autoMigrate` wraps each file in one transaction, and a
label added by `ALTER TYPE` cannot be *used* until that transaction commits.
Precedent: `apps/api/migrations/2026-10-16-180700-report-type-hardware-lifecycle.sql`.

- [ ] **Step 1: Re-check the newest migration on `origin/main`**

```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
```
Rename upward if main gained something later than `2026-10-17-0950…`. W05's two
files sort before this one; there is no dependency between them beyond that, so a
fresh-DB replay in filename order is safe.

- [ ] **Step 2: Write the migration**

```sql
-- Identity & Access Review report: the report type (#5784 W06). Enum add ONLY,
-- in its own file: a label added by ALTER TYPE cannot be used until the
-- transaction that added it commits, and autoMigrate wraps each file in one
-- transaction (precedent: 2026-10-16-180700-report-type-hardware-lifecycle.sql).
-- No rows are written, so no breeze.scope election is required. Idempotent.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'identity_access_review';
```

- [ ] **Step 3: Run the guards and apply twice**

```bash
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
pnpm test-stack up
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
```
Expected: guards PASS, second migrate a clean no-op. **Never** add this file to
`migrationRlsScope.test.ts`'s frozen baseline.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-17-095000-report-type-identity-access-review.sql
git commit -m "feat(reports): identity_access_review report type enum label (#5784 W06)"
```

---

### Task 2: Type plumbing — enum literal, union, both switches, registry entry

**Files:**
- Modify: `apps/api/src/db/schema/reports.ts` (`pgEnum('report_type', …)` at `:22-40`)
- Modify: `apps/api/src/services/reportGenerationService.ts` (`ReportType` at `:19-45`; the dispatch switch; `zeroSafeReport` at `:808-854`)
- Modify: `apps/api/src/services/reportGenerationService.test.ts` (`REPORT_TYPES` at `:27-36`)
- Modify: `apps/api/src/services/managedEvidenceRegistry.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/validators/deliverableTemplates.ts`

- [ ] **Step 1: Add the pg enum literal ONLY, and watch the drift guard fail**

Add `'identity_access_review'` to the `pgEnum` in `reports.ts`, then run
`cd apps/api && npx vitest run src/services/reportGenerationService.test.ts`.
Expected: FAIL on *"the API-local ReportType union covers exactly the DB enum"*
(`:269-275`).

- [ ] **Step 2: Add the union member and both switch arms**

Append to the `ReportType` union:

```ts
  // #5784 W06. Service-plan evidence: interactive sign-in review, identity
  // inventory, conditional access posture and remote-access client presence.
  // Org-wide by construction — M365 identity has no site dimension — so a
  // restricted authority gets the zero-safe shape, never a silently org-wide
  // view. See services/identityAccessReport.ts.
  | 'identity_access_review'
```

Dispatch arm, beside `hardware_lifecycle`:

```ts
    case 'identity_access_review': {
      const { generateIdentityAccessReport } = await import('./identityAccessReport');
      return generateIdentityAccessReport(orgId, config, authority, evidence);
    }
```

The `await import(...)` keeps a heavy generator out of the hot path and avoids the
module cycle back to `assertReportExecutionPreflight`.

In `zeroSafeReport`, add `identity_access_review` to the `emptyRowsReport()` group
beside `hardware_lifecycle` — **not** a stored-artifact-only type. **This arm is
load-bearing for this wave in a way it is not for W02–W04**: it is the shape a
restricted authority actually receives, because the generator routes every
restricted request into it (Task 5), not only the zero-sites case.

In `reportGenerationService.test.ts`, add the literal to `REPORT_TYPES` (`:27-36`),
**not** to `STORED_ARTIFACT_ONLY_TYPES`.

- [ ] **Step 3: Add the registry entry and the shared tuple member**

In `managedEvidenceRegistry.ts`, replacing the `// W06 adds …` comment:

```ts
  identity_access_review: {
    type: 'identity_access_review',
    definitionName: `${MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX}Identity and access review`,
    defaultConfig: { dormantDays: 45, homeCountries: [], adminDetail: true },
  },
```

These three keys are the spec's stated config (§3.5.3). In
`packages/shared/src/validators/deliverableTemplates.ts`, add
`'identity_access_review'` to `MANAGED_EVIDENCE_REPORT_TYPES`.

- [ ] **Step 4: Run the guards to verify they pass**

```bash
cd apps/api && npx vitest run src/services/reportGenerationService.test.ts src/services/managedEvidenceRegistry.test.ts
npx tsc --noEmit -p tsconfig.json
cd ../../packages/shared && npx vitest run src/validators/deliverableTemplates.test.ts
```
Expected: PASS, clean. A missing-switch-arm complaint is the `never` default doing
its job — add the arm, do not cast.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/reports.ts apps/api/src/services/reportGenerationService.ts apps/api/src/services/reportGenerationService.test.ts apps/api/src/services/managedEvidenceRegistry.ts apps/api/src/services/managedEvidenceRegistry.test.ts packages/shared/src/validators/deliverableTemplates.ts
git commit -m "feat(reports): wire identity_access_review into the type system and managed registry (#5784 W06)"
```

---

### Task 3: Config schema and its test-pinned parallel field list

**Files:**
- Modify: `apps/api/src/routes/reports/schemas.ts`, `schemas.config.test.ts`

**Interfaces:**
- Produces: `identityAccessConfigSchema` (with `.default()`s) and
  `identityAccessConfigFields` (without), spread into `reportConfigFields` and
  `generateReportSchema.config`.

`schemas.config.test.ts:91-101` asserts the two key sets are equal. The `…Fields`
object must not apply defaults, or a saved config would be silently rewritten on
persistence.

**Note there is no `sites` key.** Every other curated type has one; this one does
not, because the report is org-wide by construction and a site selector would
promise filtering the data cannot deliver.

- [ ] **Step 1: Write the failing parity test**

```ts
it('keeps the identity access persistence fields in sync with the generation schema', () => {
  expect(Object.keys(identityAccessConfigFields).sort()).toEqual(
    Object.keys(identityAccessConfigSchema.shape).sort(),
  );
});

it('defaults an identity access config to the spec values', () => {
  expect(identityAccessConfigSchema.parse({})).toEqual({
    dormantDays: 45, homeCountries: [], adminDetail: true,
  });
});

it('has no sites key — the report is org-wide by construction', () => {
  // A site selector would promise a filter M365 identity data cannot deliver.
  expect(Object.keys(identityAccessConfigSchema.shape)).not.toContain('sites');
});

it('rejects a malformed home country code', () => {
  expect(() => identityAccessConfigSchema.parse({ homeCountries: ['United States'] })).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/reports/schemas.config.test.ts`
Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Add the enum literal, the schema and the fields**

Add `'identity_access_review'` to `reportTypeSchema` (`:13-31`) with a one-line
comment, then after the `hardwareLifecycle` pair (`:82-105`):

```ts
/**
 * Config for the Identity & Access Review report (#5784 W06, spec §3.5.3).
 * NO `sites` key on purpose: M365 identity data has no site dimension, and a
 * site selector would promise a filter the data cannot deliver. A restricted
 * authority gets the zero-safe shape instead (OD-8 = A).
 * `homeCountries` are ISO-3166 alpha-2 codes; sign-ins from outside the set are
 * called out. An empty set means the section renders as "not configured", NOT as
 * "no foreign sign-ins".
 */
export const identityAccessConfigSchema = z.object({
  dormantDays: z.number().int().min(1).max(365).optional().default(45),
  homeCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).optional().default([]),
  adminDetail: z.boolean().optional().default(true),
});

/** Same keys as `identityAccessConfigSchema` without `.default()`s — see
 *  `securityCompliancePostureConfigFields` for why the two are hand-parallel and
 *  test-pinned (schemas.config.test.ts). */
export const identityAccessConfigFields = {
  dormantDays: z.number().int().min(1).max(365).optional(),
  homeCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).optional(),
  adminDetail: z.boolean().optional(),
};
```

Spread `...identityAccessConfigFields` into **both** `reportConfigFields`
(`:125-151`) **and** `generateReportSchema.config` (`:182-202`).

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `cd apps/api && npx vitest run src/routes/reports/schemas.config.test.ts`

```bash
git add apps/api/src/routes/reports/schemas.ts apps/api/src/routes/reports/schemas.config.test.ts
git commit -m "feat(reports): identity_access_review config schema and parallel field list (#5784 W06)"
```

---

### Task 4: The shared summary type and arithmetic

**Files:**
- Create: `packages/shared/src/types/identityAccessReport.ts`
- Create: `packages/shared/src/utils/identityAccess.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/utils/index.ts`

**Interfaces:**
- Produces: `IdentityAccessSummary`, `SigninSummaryRow`, `AdminSigninRow`,
  `DormantAccountRow`, `CaPolicyRow`, `SigninCoverage`,
  `LEGACY_AUTH_CLIENT_APPS`, `isRiskFieldMeasured(value)`,
  `foreignCountrySignins(rows, homeCountries)`,
  `signinCoverageLine(coverage)`.
- Consumed by: the API generator (Task 5, with `satisfies`), the PDF renderer
  (Task 6) and the web preview (Task 8) — all three must agree.

- [ ] **Step 1: Write the summary type**

```ts
// packages/shared/src/types/identityAccessReport.ts
/**
 * Canonical shape of the Identity & Access Review report's `summary` snapshot
 * (#5784 W06). Single-sourced: the API produces it with `satisfies`, the shared
 * PDF renderer and the web preview consume it, and it is persisted in
 * report_runs.result — so EVERY field is optional and a legacy snapshot must
 * still render. Mirrors hardwareLifecycleReport.ts.
 *
 * Nulls are load-bearing and there are three distinct ways to be unmeasured
 * here, each of which must read differently on the page:
 *   * mfaRegistered NULL  = UNKNOWN, never "not registered". m365_posture_rollups
 *     carries users_mfa_unknown / admins_mfa_unknown for exactly this reason.
 *   * risk fields 'hidden' = the tenant has no P2; render the section unmeasured,
 *     never "no risk detected".
 *   * signinEvents null    = the tenant has no P1/P2, or Breeze has not synced
 *     this period; render a data-gap page, never an empty table.
 */

export type SigninCoverage = {
  /** Occurrence period (ISO dates), or the config date range for an ad-hoc run. */
  periodStart?: string;
  periodEnd?: string;
  /** What the events actually span. Breeze accumulates forward from first sync
   *  only and Graph keeps ~30 days, so the first monthly report is partial. */
  coveredFrom?: string | null;
  coveredTo?: string | null;
  generatedAt?: string;
  /** m365_sync_state.last_complete_snapshot_at for signin_events. NEVER
   *  last_success_at — a partial run succeeds without enumerating the tenant. */
  asOf?: string | null;
  lastStatus?: string | null;
  /** True when the tenant has no Entra ID P1/P2: permission was granted, the
   *  licence was not. A complete, zero-row success — NOT "no sign-ins". */
  unlicensed?: boolean;
  /** Any stretch inside the period with no events AND no successful sync —
   *  unrecoverable, because Graph's own retention has passed. */
  gapNote?: string | null;
  /** One human sentence naming every gap above. Rendered verbatim. */
  note?: string;
};

export type DormantAccountRow = {
  userPrincipalName: string | null;
  displayName: string | null;
  /** null means NEVER OBSERVED signing in, which is not the same as "long ago". */
  lastSuccessfulSignInAt: string | null;
  isAdmin: boolean;
  /** null = unknown, never false. */
  mfaRegistered: boolean | null;
};

export type AdminSigninRow = {
  signedInAt: string;
  userPrincipalName: string | null;
  appDisplayName: string | null;
  clientAppUsed: string | null;
  ipAddress: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  conditionalAccessStatus: string | null;
  statusErrorCode: number | null;
  /** Graph's 'hidden' sentinel survives here verbatim; the renderer treats it as
   *  unmeasured rather than as a risk level. */
  riskLevelAggregated: string | null;
};

export type CaPolicyRow = {
  displayName: string | null;
  state: 'enabled' | 'enabledForReportingButNotEnforced' | 'disabled' | string | null;
  /** True when last_changed_at falls inside the period — a CA change nobody
   *  announced is the finding. */
  changedThisPeriod: boolean;
  /** True when the policy is gone from the tenant but still held by Breeze. */
  isStale: boolean;
};

export type IdentityAccessSummary = {
  orgId?: string;
  orgName?: string | null;
  generatedAt?: string;
  coverage?: SigninCoverage;
  identity?: {
    usersTotal: number | null;
    usersEnabled: number | null;
    usersDisabled: number | null;
    admins: number | null;
    mfaRegistered: number | null;
    /** Counted separately and NEVER folded into "not registered". */
    mfaUnknown: number | null;
    adminsWithoutMfa: number | null;
    adminsMfaUnknown: number | null;
  };
  dormant?: { thresholdDays?: number; rows: DormantAccountRow[] } | null;
  signins?: {
    total: number | null;
    distinctUsers: number | null;
    failures: number | null;
    failuresByErrorCode: Record<string, number> | null;
    /** null when homeCountries is empty — "not configured", NOT "none". */
    outsideHomeCountries: number | null;
    legacyAuth: Record<string, number> | null;
    conditionalAccessFailures: number | null;
    /** null when every risk value came back as Graph's 'hidden' sentinel. */
    byRiskLevel: Record<string, number> | null;
  };
  /** The section an auditor reads first. Omitted when config.adminDetail is off. */
  adminSignins?: AdminSigninRow[] | null;
  conditionalAccess?: { policies: CaPolicyRow[] | null; changedThisPeriod: number | null };
  /** Labelled CLIENT PRESENCE, not policy: devices.active_vpns records which
   *  overlay client is up, and the collector carries no peer lists, keys or
   *  policy (agent/internal/collectors/vpn.go:13-18). */
  remoteAccess?: { byProvider: Record<string, number> | null; caveat: string } | null;
  rows?: AdminSigninRow[];
  dataGaps?: string[];
};
```

- [ ] **Step 2: Write the failing utils test**

```ts
describe('isRiskFieldMeasured', () => {
  it('treats Graph’s hidden sentinel as unmeasured, not as a risk level', () => {
    expect(isRiskFieldMeasured('hidden')).toBe(false);
    expect(isRiskFieldMeasured(null)).toBe(false);
    expect(isRiskFieldMeasured('none')).toBe(true);   // 'none' IS a measurement
    expect(isRiskFieldMeasured('high')).toBe(true);
  });
});

describe('foreignCountrySignins', () => {
  it('returns null when no home countries are configured — not configured, NOT none', () => {
    expect(foreignCountrySignins([{ locationCountry: 'RU' }] as never, [])).toBeNull();
  });

  it('counts sign-ins outside the configured set and ignores unknown locations', () => {
    expect(foreignCountrySignins([{ locationCountry: 'RU' }, { locationCountry: 'US' }, { locationCountry: null }] as never, ['US'])).toBe(1);
  });
});

describe('signinCoverageLine', () => {
  it('says the tenant is unlicensed rather than implying there were no sign-ins', () => {
    const line = signinCoverageLine({ unlicensed: true });
    expect(line).toMatch(/licen[cs]e/i);
    expect(line).not.toMatch(/\bno sign-ins\b/i);
  });

  it('names the shortfall when Breeze started collecting mid-period', () => {
    const line = signinCoverageLine({ periodStart: '2026-09-01', periodEnd: '2026-09-30', coveredFrom: '2026-09-20' });
    expect(line).toMatch(/2026-09-20/);
    expect(line).toMatch(/does not cover/i);
  });

  it('is empty when coverage spans the period and the tenant is licensed', () => {
    expect(signinCoverageLine({ periodStart: '2026-09-01', periodEnd: '2026-09-30', coveredFrom: '2026-09-01', coveredTo: '2026-09-30' })).toBe('');
  });
});
```

- [ ] **Step 3: Run to verify it fails, implement, run again**

Run: `cd packages/shared && npx vitest run src/utils/identityAccess.test.ts`
Expected: FAIL, then PASS.

`LEGACY_AUTH_CLIENT_APPS` is the set of `client_app_used` values that indicate
legacy authentication (`Other clients`, `IMAP4`, `POP3`, `SMTP`,
`Exchange ActiveSync`, `Authenticated SMTP`, `MAPI Over HTTP`,
`Offline Address Book`, `Exchange Web Services`, `AutoDiscover`) — check the
current Graph documentation for the exact strings rather than trusting this list
verbatim, and comment the source.

Export both modules from the `types` and `utils` barrels beside the
`hardwareLifecycle` lines.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/identityAccessReport.ts packages/shared/src/types/index.ts packages/shared/src/utils/identityAccess.ts packages/shared/src/utils/identityAccess.test.ts packages/shared/src/utils/index.ts
git commit -m "feat(shared): identity access report summary type and shared arithmetic (#5784 W06)"
```

---

### Task 5: The generator

**Files:**
- Create: `apps/api/src/services/identityAccessReport.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `identityAccessConfigSchema` (Task 3); `loadDomainFreshness`
  (W03 Task 4, or added here identically if W03 has not landed);
  `IdentityAccessSummary`, `isRiskFieldMeasured`, `foreignCountrySignins`,
  `signinCoverageLine`, `LEGACY_AUTH_CLIENT_APPS` (Task 4);
  `assertReportExecutionPreflight`, `ReportGenerationAuthority`,
  `EvidenceRunContext`, `ReportResult` (W01 Task 4); `m365SigninEvents` (W05
  Task 3), `m365Users`, `m365CaPolicies`, `m365PostureRollups`
  (`apps/api/src/db/schema/m365Sync.ts`), `devices`, `organizations`.
- Produces:
  `generateIdentityAccessReport(orgId, rawConfig, authority, evidence?): Promise<ReportResult>`.

**The one structural difference from W02–W04: a restricted authority gets
nothing.** M365 identity data has no site dimension. Serving it to a
site-restricted technician would hand them an org-wide identity view they are not
entitled to — a scope escalation. OD-8 = A resolves this by returning the
`zeroSafeReport` empty-but-shaped result with an explanatory data-gap line, which
matches the existing contract rather than inventing a new refusal. **Do not
"fix" this to filter by site; there is nothing to filter on.**

**Reader discipline (spec §3.1 rule 4).** Model the loaders on
`apps/api/src/services/securityComplianceReportVulnerabilities.ts` — a pure
aggregator plus thin loaders on plain `db` that throw rather than silently
undercounting. Do **not** reuse
`apps/api/src/services/aiAgents/sweepEvidence.ts`: capped at 25 rows/kind and
12 KB, excludes every jsonb/text column, and requires a pre-held SYSTEM context —
a tenant-isolation hazard in a request path.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns the zero-safe shape for a RESTRICTED authority, with an explanatory gap line', async () => {
  const res = await generateIdentityAccessReport(ORG, {}, AUTH_RESTRICTED_S1, PERIOD_SEP);
  // OD-8 = A. M365 identity has no site dimension; serving it to a
  // site-restricted technician would be a scope escalation.
  expect(res.rows).toEqual([]);
  expect(res.rowCount).toBe(0);
  expect((res.summary as IdentityAccessSummary).dataGaps?.join(' ')).toMatch(/org-wide/i);
  expect(signinQuerySpy).not.toHaveBeenCalled();   // and nothing was read
});

it('renders a data-gap page for an unlicensed tenant, never an empty table', async () => {
  freshness.signin_events = { asOf: hoursAgo(2), lastStatus: 'success', sources: { signinEvents: 'unlicensed' } };
  const res = await generateIdentityAccessReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP);
  const s = res.summary as IdentityAccessSummary;
  expect(s.coverage?.unlicensed).toBe(true);
  expect(s.signins?.total).toBeNull();           // unmeasured, NOT zero
  expect(s.dataGaps?.join(' ')).toMatch(/licen[cs]e/i);
});

it('states the actual coverage window when Breeze started collecting mid-period', async () => {
  earliestSignin = '2026-09-20T00:00:00Z';
  const res = await generateIdentityAccessReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP);
  const s = res.summary as IdentityAccessSummary;
  expect(s.coverage?.coveredFrom).toBe('2026-09-20T00:00:00Z');
  expect(s.coverage?.note).toMatch(/does not cover/i);
});

it('treats mfa_registered NULL as unknown, never as not registered', async () => {
  userRows.push({ mfaRegistered: null, isAdmin: true }, { mfaRegistered: false, isAdmin: true });
  const res = await generateIdentityAccessReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP);
  const s = res.summary as IdentityAccessSummary;
  expect(s.identity?.adminsWithoutMfa).toBe(1);
  expect(s.identity?.adminsMfaUnknown).toBe(1);
});

it('renders the risk section unmeasured when every value is Graph’s hidden sentinel', async () => {
  signinRows.push({ riskLevelAggregated: 'hidden' }, { riskLevelAggregated: 'hidden' });
  const res = await generateIdentityAccessReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP);
  expect((res.summary as IdentityAccessSummary).signins?.byRiskLevel).toBeNull();
});

it('reports outsideHomeCountries as null when none are configured', async () => {
  signinRows.push({ locationCountry: 'RU' });
  const res = await generateIdentityAccessReport(ORG, { homeCountries: [] }, AUTH_UNRESTRICTED, PERIOD_SEP);
  // "Not configured" and "no foreign sign-ins" must not read the same.
  expect((res.summary as IdentityAccessSummary).signins?.outsideHomeCountries).toBeNull();
});

it('includes only admin sign-ins in the admin detail section, and omits it when adminDetail is off', async () => {
  const on = await generateIdentityAccessReport(ORG, { adminDetail: true }, AUTH_UNRESTRICTED, PERIOD_SEP);
  expect((on.summary as IdentityAccessSummary).adminSignins?.every((r) => ADMIN_UPNS.has(r.userPrincipalName!))).toBe(true);
  const off = await generateIdentityAccessReport(ORG, { adminDetail: false }, AUTH_UNRESTRICTED, PERIOD_SEP);
  expect((off.summary as IdentityAccessSummary).adminSignins).toBeNull();
});

it('flags CA policies changed inside the period and stale ones', async () => {
  caRows.push({ displayName: 'MFA for admins', state: 'enabled', lastChangedAt: '2026-09-15T00:00:00Z', isStale: false },
              { displayName: 'Old rule', state: 'disabled', lastChangedAt: '2026-01-01T00:00:00Z', isStale: true });
  const res = await generateIdentityAccessReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP);
  const s = res.summary as IdentityAccessSummary;
  expect(s.conditionalAccess?.changedThisPeriod).toBe(1);
  expect(s.conditionalAccess?.policies?.find((p) => p.displayName === 'Old rule')?.isStale).toBe(true);
});

it('labels remote access as client presence, not policy', async () => {
  const res = await generateIdentityAccessReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP);
  expect((res.summary as IdentityAccessSummary).remoteAccess?.caveat).toMatch(/client presence/i);
});

it('uses the occurrence period, not now()', async () => {
  const res = await generateIdentityAccessReport(ORG, {}, AUTH_UNRESTRICTED, {
    periodStart: '2026-09-01', periodEnd: '2026-09-30', generatedAt: '2026-09-30T05:18:00Z', deliverableId: 'd1',
  });
  const s = res.summary as IdentityAccessSummary;
  expect(s.coverage?.periodStart).toBe('2026-09-01');
  expect(s.coverage?.generatedAt).toBe('2026-09-30T05:18:00Z');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/identityAccessReport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the generator**

Structure, following `hardwareLifecycleReport.ts:131-163`, with **one deliberate
departure** at the scope check:

```ts
export async function generateIdentityAccessReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
  evidence?: EvidenceRunContext,
): Promise<ReportResult> {
  const cfg = identityAccessConfigSchema.parse(rawConfig ?? {});
  const generatedAt = evidence?.generatedAt ?? new Date().toISOString();

  assertReportExecutionPreflight(orgId, cfg, authority, 'identity_access_review');

  // OD-8 = A, and the departure from W02-W04: ANY restricted authority gets the
  // zero-safe shape, not only one with zero sites. M365 identity data has no
  // site dimension, so there is nothing to filter on and serving it would be a
  // scope escalation. Read NOTHING before returning.
  if (authority.scope.kind === 'restricted') {
    return {
      rows: [], rowCount: 0, generatedAt,
      summary: restrictedSummary(orgId, generatedAt, evidence) satisfies IdentityAccessSummary,
    };
  }

  // 1. Freshness for the signin_events domain — last_complete_snapshot_at, never
  //    last_success_at. An `unlicensed` source renders the whole sign-in half as
  //    a data gap; the identity inventory and CA sections still render, because
  //    they come from other domains.
  // 2. Coverage: evidence period, plus MIN/MAX(signed_in_at) actually held, plus
  //    any in-period stretch with no events and no successful sync (gapNote).
  // 3. Identity inventory from m365_users + m365_posture_rollups; mfa NULL is
  //    counted into *Unknown, never into "without".
  // 4. Dormant accounts: enabled users whose last_successful_sign_in_at is older
  //    than cfg.dormantDays OR NULL. Render NULL as "never observed".
  // 5. Sign-in activity for the period from m365_signin_events: total, distinct
  //    users, failures by status_error_code, foreignCountrySignins(...),
  //    legacy auth by client_app_used against LEGACY_AUTH_CLIENT_APPS,
  //    conditional_access_status = 'failure' count, byRiskLevel over only
  //    values where isRiskFieldMeasured(...) is true — null if none are.
  // 6. Admin sign-in detail: every interactive sign-in by a user with
  //    m365_users.is_admin = true, when cfg.adminDetail. Also the `rows` body.
  // 7. Conditional access posture: m365_ca_policies by state, changedThisPeriod
  //    from last_changed_at inside the period, is_stale flagged.
  // 8. Remote access: devices.active_vpns grouped by provider, with the
  //    client-presence caveat string ALWAYS set.
}
```

Return `summary` typed with `satisfies IdentityAccessSummary`.

- [ ] **Step 4: Run to verify they pass, then commit**

Run: `cd apps/api && npx vitest run src/services/identityAccessReport.test.ts && npx tsc --noEmit -p tsconfig.json`

```bash
git add apps/api/src/services/identityAccessReport.ts apps/api/src/services/identityAccessReport.test.ts
git commit -m "feat(reports): identity and access review generator, org-wide with a restricted refusal (#5784 W06)"
```

---

### Task 6: The PDF renderer and its `buildReportPdf` arm

**Files:**
- Create: `packages/shared/src/reportPdf/identityAccessPdf.ts`
- Create: `packages/shared/src/reportPdf/reportPdf.identityAccess.test.ts`
- Modify: `packages/shared/src/reportPdf/reportPdf.ts`, `index.ts`

**Interfaces:**
- Consumes: `IdentityAccessSummary` (Task 4); the `PdfChrome` contract
  `hardwareLifecyclePdf.ts` declares — copy its shape, do **not** import
  `reportPdf.ts` back or you create a cycle.
- Produces: `renderIdentityAccessReport(doc, summary, opts, chrome)`;
  `REPORT_TYPE_LABELS.identity_access_review`; a `buildReportPdf` arm.

**The silent failure this task exists to prevent.** `buildReportPdf`'s final
`else` (`packages/shared/src/reportPdf/reportPdf.ts:2018-2020`) falls through to
`renderGenericReport`, which prints the rows as a plain table and **drops the
entire designed summary** — the admin detail table and every coverage caveat
included. On a PII-carrying identity artifact that is not merely an ugly PDF: the
caveats that keep it honest disappear while the sign-in rows remain. **No unit
test catches it** unless one is written for the arm specifically.

- [ ] **Step 1: Write the failing test**

```ts
it('routes to the identity access renderer, not renderGenericReport', () => {
  const spy = vi.spyOn(ident, 'renderIdentityAccessReport');
  buildReportPdf([], { reportType: 'identity_access_review', generatedAt: 'x', timezone: 'UTC', summary: SUMMARY });
  expect(spy).toHaveBeenCalledOnce();
});

it('prints the coverage note and says interactive sign-ins, never all sign-ins', () => {
  const doc = buildReportPdf([], { reportType: 'identity_access_review', generatedAt: 'x', timezone: 'UTC',
    summary: { ...SUMMARY, coverage: { note: 'Covers 2026-09-20 to 2026-09-30; collection began mid-period.' } } });
  const text = extractText(doc);
  expect(text).toMatch(/collection began mid-period/);
  expect(text).toMatch(/interactive sign-ins/i);
  expect(text).not.toMatch(/\ball sign-ins\b/i);
});

it('renders the risk section unmeasured rather than as no risk detected', () => {
  const doc = buildReportPdf([], { reportType: 'identity_access_review', generatedAt: 'x', timezone: 'UTC',
    summary: { ...SUMMARY, signins: { ...SUMMARY.signins, byRiskLevel: null } } });
  const text = extractText(doc);
  expect(text).toMatch(/N\/A|not available/i);
  expect(text).not.toMatch(/no risk detected/i);
});

it('labels remote access as client presence and never as a VPN policy review', () => {
  const doc = buildReportPdf([], { reportType: 'identity_access_review', generatedAt: 'x', timezone: 'UTC',
    summary: { ...SUMMARY, remoteAccess: { byProvider: { tailscale: 3 }, caveat: 'Client presence only; no policy or peer data is collected.' } } });
  const text = extractText(doc);
  expect(text).toMatch(/client presence/i);
  expect(text).not.toMatch(/VPN policy review/i);
});

it('falls through to the generic renderer when the summary is absent', () => {
  const spy = vi.spyOn(ident, 'renderIdentityAccessReport');
  buildReportPdf([{ a: 1 }], { reportType: 'identity_access_review', generatedAt: 'x', timezone: 'UTC' });
  expect(spy).not.toHaveBeenCalled();
});
```

Copy `extractText` from
`packages/shared/src/reportPdf/reportPdf.hardwareLifecycle.test.ts` — do not
invent a second helper.

- [ ] **Step 2: Run to verify it fails, then write the renderer**

Run: `cd packages/shared && npx vitest run src/reportPdf/reportPdf.identityAccess.test.ts`
Expected: FAIL.

Model the module on `packages/shared/src/reportPdf/hardwareLifecyclePdf.ts`: a
doc-comment naming the reader, a `PdfChrome` parameter carrying
`{ C, PAGE, drawHeaderBand, drawFooter, drawTitleBlock, drawSectionHeading }`, and
no import back into `reportPdf.ts`. Sections in order: cover + coverage note (with
"interactive sign-ins" in the title block); identity inventory; dormant accounts;
sign-in activity for the period; **admin sign-in detail** (autoTable, paginating
via `didDrawPage` — this is the section an auditor reads first, so it goes above
conditional access, not below); conditional access posture; remote access with its
caveat; changes since last period from `opts.previous`. Every unmeasured value
prints `N/A` with its reason; every colour is paired with a word.

- [ ] **Step 3: Add the arm and the label**

`REPORT_TYPE_LABELS` (`:165-171`) gains
`identity_access_review: 'Identity & Access Review',`. Add an arm immediately
before the final `else`, following the `hardware_lifecycle` shape (`:1996-2017`):
guard on the summary being present and shaped, draw the header band and footer,
then delegate. Widen `BuildOpts['summary']` and export the renderer from
`packages/shared/src/reportPdf/index.ts`.

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `cd packages/shared && npx vitest run src/reportPdf/ && npx tsc --noEmit`
Expected: PASS — check the reported file count includes both the new suite and the
existing `reportPdf.*` suites.

```bash
git add packages/shared/src/reportPdf
git commit -m "feat(shared): identity and access review PDF renderer and buildReportPdf arm (#5784 W06)"
```

---

### Task 7: Portal provisioning and the two portal unions

**Files:**
- Modify: `apps/api/src/services/portal/reportsSelfService.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/types/portalVisibility.ts`
- Modify: `apps/portal/src/components/portal/ReportRunList.tsx` (+ `.test.tsx`)

**The type lie the compiler cannot see.** `portalRunListPredicate`
(`reportsSelfService.ts:267-277`) filters on org, `portal_self_service` and
`status` — **no type filter**. Its `toDto` (`:279-301`) declares the row's `type`
as the three-value `PortalReportType`. A sweep-generated run of a new type flows
through as a value outside the declared union, and TypeScript cannot catch it
because the value comes from the database.

**This artifact carries sign-in PII**, so the OD-12 delivery gate matters more
here than anywhere else in the feature. Do not weaken it, and do not add this type
to the portal generate path.

- [ ] **Step 1: Write the failing tests**

```ts
it('provisions an identity access definition for an org enabling portal reports', async () => {
  await provisionPortalReportDefinitions({ orgId: ORG, createdBy: USER });
  expect(inserted.map((r) => r.type)).toContain('identity_access_review');
});

it('keeps identity_access_review OUT of the portal generate allowlist', () => {
  // A customer generating an identity report on demand would be a new compute
  // surface AND a new PII surface. OD-10 = A.
  expect(PORTAL_REPORT_TYPES).not.toContain('identity_access_review');
});
```

plus a label-renders / no-generate-button pair in `ReportRunList.test.tsx`.

- [ ] **Step 2: Run to verify they fail, then wire**

Append to `PORTAL_DEFINITIONS` (`:28-63`):

```ts
  {
    type: 'identity_access_review',
    name: 'Service evidence — Identity and access review',
    config: { dormantDays: 45, homeCountries: [], adminDetail: true },
  },
```

W02 added an assertion in `managedEvidenceRegistry.test.ts` that every registry
entry has a matching `PORTAL_DEFINITIONS` row with the same name and config — make
them match rather than loosening the assertion.

Widen three unions: `PortalRunDto.type`
(`packages/shared/src/types/portalVisibility.ts:246-259`); `toDto`'s `type`
parameter (prefer `PortalRunDto['type']`); and `ReportRunList.tsx`'s `ReportType`
union **and** its `GENERATING_COPY` total `Record` (`:16-27`) — a missed entry
there is a typecheck failure.

Do **not** add the type to `PORTAL_REPORT_TYPES` (`:131-137`) or to the two
allowlist literals in `reportGenerationService.ts` (`:248-254`, `:760-765`).

- [ ] **Step 3: Run to verify they pass, then commit**

```bash
cd apps/api && npx vitest run src/services/portal/ src/services/managedEvidenceRegistry.test.ts
cd ../portal && npx vitest run && pnpm --filter @breeze/portal typecheck
```

```bash
git add apps/api/src/services/portal packages/shared/src/types/portalVisibility.ts apps/portal/src/components/portal
git commit -m "feat(portal): provision and label identity access review runs, no self-serve generate (#5784 W06)"
```

---

### Task 8: Web wiring — six points plus the options form

**Files:**
- Modify: `apps/web/src/components/reports/ReportsList.tsx`, `ReportBuilder.tsx`,
  `ReportTemplates.tsx`, `ReportEditPage.tsx`, `ReportPreview.tsx`,
  `reportExport.ts`, `reportTypeSurvivesBuilder.test.ts`
- Create: `apps/web/src/components/reports/IdentityAccessOptionsForm.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/reports/ReportTemplates.identityAccess.test.tsx`

**Interfaces:**
- Produces: `DEFAULT_IDENTITY_ACCESS_OPTIONS`, `IdentityAccessOptionsFields`,
  `identityAccessOptionsFromConfig`, `type IdentityAccessOptions` — the same four
  exports `HardwareLifecycleOptionsForm.tsx` provides, so `ReportEditPage.tsx`
  wires identically.

**`ReportBuilder.tsx` breaks the build until mapped.** Its
`Record<LegacyReportType, BuilderReportType>` (`:160-184`) is exhaustive.
`identity_access_review` is curated, has its own options form, and is **not**
representable by the freeform builder, so it maps to `'activity'` and
`reportTypeSurvivesBuilder` must return **false** for it.

- [ ] **Step 1: Write the failing tests**

Add to `reportTypeSurvivesBuilder.test.ts`:
`expect(reportTypeSurvivesBuilder('identity_access_review')).toBe(false);`

Mirror `ReportTemplates.hardwareLifecycle.test.tsx` for the card → options-form
path and `HardwareLifecycleOptionsForm.test.tsx` for the form itself. Add one
more, specific to this type:

```tsx
it('does not offer a site selector — the report is org-wide', () => {
  render(<IdentityAccessOptionsFields value={DEFAULT_IDENTITY_ACCESS_OPTIONS} onChange={() => {}} />);
  expect(screen.queryByTestId('identity-access-sites')).toBeNull();
  expect(screen.getByTestId('identity-access-org-wide-note')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail, then wire the six points**

1. `ReportsList.tsx:36-42` — add the literal to the `ReportType` union. **No
   hardcoded label map**: `getReportTypeLabel` (`:225`) resolves
   `reports.reportsList.reportTypes.<type>` dynamically, so the label comes from
   Task 9.
2. `ReportBuilder.tsx:160-184` — `identity_access_review: 'activity',` with a
   comment saying it is curated and the builder never offers it.
3. `ReportTemplates.tsx` — add the literal to `reportTypeValues` (`:62-74`); add a
   template card (`:99-114` shape); add a `handleUseTemplate` branch (`:377-398`)
   that sets the options state and opens the options form, as `hardware_lifecycle`
   does.
4. `ReportEditPage.tsx` — import the four options-form exports, add
   `const isIdentityAccess = report.type === 'identity_access_review';` and a
   render branch beside `isLifecycle` (`:144-146`).
5. `ReportPreview.tsx` — a branch beside the `hardware_lifecycle` one (`:257-298`)
   rendering identity and sign-in tiles plus the coverage note, and add the
   literal to the `data.type !== 'hardware_lifecycle'` guard on the generic
   summary grid so the generic cards do not also render.
6. `reportExport.ts` — no branch needed (`exportReport` uses `reportType` only for
   the filename and hands it opaquely to `buildReportPdf`), but **widen its
   `summary` union** to include `IdentityAccessSummary` so the staff/browser path
   passes the designed summary — and its caveats — through to Task 6's arm rather
   than dropping them.

- [ ] **Step 3: Write the options form**

`IdentityAccessOptionsForm.tsx`, modelled on
`HardwareLifecycleOptionsForm.tsx`: a `dormantDays` number input, a
`homeCountries` multi-entry field (ISO-3166 alpha-2), an `adminDetail` checkbox,
and an **org-wide note** (`data-testid="identity-access-org-wide-note"`) saying
the report covers the whole organization and is unavailable to site-restricted
users. **No site selector** — there is nothing to filter on, and offering one
would promise a filter the data cannot deliver.

- [ ] **Step 4: Run to verify they pass, then commit**

Run: `cd apps/web && npx vitest run src/components/reports/ && pnpm --filter @breeze/web typecheck`
Expected: PASS, clean. A `ReportBuilder.tsx` `Record` complaint is the
exhaustiveness guard — add the mapping, do not cast.

```bash
git add apps/web/src/components/reports
git commit -m "feat(web): identity access review report wiring and options form (#5784 W06)"
```

---

### Task 9: Locale keys in all eight locales

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/reports.json`

**The name string is duplicated in three separate maps** — the repo's existing
shape. Per locale:

- `reports.reportPreview.reportTypes.identity_access_review`
- `reports.reportsList.reportTypes.identity_access_review`
- `reports.reportTemplates.reportTypes.identity_access_review`
- `reports.reportTemplates.templates.identity_access_review` — `{ name, description }`
- `reports.identityAccessOptions.*` — options-form labels, help text and the
  org-wide note
- `reports.reportPreview.identityAccess.*` — preview tile labels

**The description and the org-wide note carry meaning, not decoration.** The
template card description must say *interactive* sign-ins, and the org-wide note
must say the report is unavailable to site-restricted users — translate the
meaning, not the words.

- [ ] **Step 1: Add to `en` first, then write real translations in the other seven**

Not English copies. `apps/web/src/lib/i18n/translationCoverage.test.ts` fails a
locale when more than 20% of its flattened keys equal the English value verbatim,
**and** enforces a per-namespace exact-duplicate baseline that `reports.json`
already carries.

- [ ] **Step 2: Run both locale guards**

```bash
cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts src/lib/i18n/localeParity.test.ts src/components/reports/reportsPtBR.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/locales
git commit -m "feat(web): identity access review locale keys in eight locales (#5784 W06)"
```

---

### Task 10: Integration test — the sweep produces the artifact

**Files:**
- Create: `apps/api/src/__tests__/integration/identityAccessEvidence.integration.test.ts`

**Placement matters.** An integration test outside
`apps/api/src/__tests__/integration/` is picked up by **no** config and runs
**zero** tests while reporting success.

- [ ] **Case 1 — partner-wide template → artifact, never wired by hand.** Seed an
  org with `m365_sync_state` for `signin_events` (a **complete** snapshot),
  `m365_signin_events` spanning the period, `m365_users` (including admins and a
  NULL `mfa_registered`), `m365_ca_policies` (one changed in-period, one stale) and
  devices with `active_vpns`. Create a partner-wide template set with one monthly
  item carrying `autoEvidenceReportType: 'identity_access_review'`, apply it, run
  `runDeliverableSweep` on the due date, and assert a
  `service_deliverable_evidence` row of `kind='report_run'` points at a
  `completed` run of the new type.

- [ ] **Case 2 — a restricted technician gets nothing, and nothing is read.**
  Generate the same definition under a **restricted** authority with a real site.
  Assert `rows` is empty, `rowCount` is 0, and `summary.dataGaps` explains the
  report is org-wide. **This is the scope-escalation guard**; if identity rows come
  back, stop.

- [ ] **Case 3 — an unlicensed tenant produces a data-gap page, not an empty
  table.** Set `m365_sync_state.sources` for `signin_events` to the `unlicensed`
  outcome. Assert `summary.coverage.unlicensed` is `true`, `summary.signins.total`
  is **null**, and `dataGaps` is non-empty. If it reads `0`, stop.

- [ ] **Case 4 — the coverage window is honest about a mid-period start.** Delete
  events before the 20th of the period. Assert `summary.coverage.coveredFrom` is
  the 20th and `coverage.note` names the shortfall — the case every first monthly
  report after enabling W05 will hit.

- [ ] **Case 5 — mfa NULL is unknown, not "without".** Assert
  `summary.identity.adminsMfaUnknown` counts the NULL admin and
  `adminsWithoutMfa` does not.

- [ ] **Case 6 — OD-12 end to end, and the PII point.** Immediately after the
  sweep, assert the run is absent from the portal run list and that `renderRunPdf`
  refuses it — **this artifact carries user principal names and IP addresses, so
  the delivery gate is doing real work here.** Deliver the occurrence, then assert
  the run is listed, downloadable, and that `renderRunPdf` produces a buffer
  **whose text contains the coverage note and the words "interactive sign-ins"** —
  proving the server-side path reaches Task 6's arm, not `renderGenericReport`
  (which would drop every caveat while keeping the sign-in rows).

- [ ] **Step 2: Run the suite**

```bash
pnpm test-stack up
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/identityAccessEvidence.integration.test.ts
```
Expected: green with a **non-zero reported test count**.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/identityAccessEvidence.integration.test.ts
git commit -m "test(reports): identity access evidence produced by the sweep, end to end (#5784 W06)"
```

---

### Task 11: Wave verification and PR

- [ ] **Step 1: Unit suites** — `cd apps/api && npx vitest run`;
  `cd packages/shared && npx vitest run`; `cd apps/web && npx vitest run`;
  `cd apps/portal && npx vitest run` → all green.

- [ ] **Step 2: Typecheck and lint** — `pnpm --filter @breeze/web typecheck`,
  `pnpm --filter @breeze/portal typecheck`,
  `cd apps/api && npx tsc --noEmit -p tsconfig.json`, `pnpm lint` → clean.

- [ ] **Step 3: Contract suites on a live database**

```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/portalReportSelfService.integration.test.ts \
  src/__tests__/integration/m365SigninEvents.integration.test.ts \
  src/__tests__/integration/identityAccessEvidence.integration.test.ts
```
→ green, each with a non-zero test count. **`pnpm test` does not run these.** This
wave adds no table and no column, so cascade/RLS/export-policy must be unchanged.
W05's suite is included because this wave is its first reader.

- [ ] **Step 4: Prove all three render paths from one stored result** — portal /
  server (`renderRunPdf`, asserted in Case 6), staff / browser (`exportReport` in
  a component test), and the scheduled-email path (same `buildReportPdf` opts).
  A type with no arm degrades silently on the first and third, and here that
  degradation would strip the caveats off a PII-bearing document.

- [ ] **Step 5: Confirm W05 has a full period of data before promising anything**

Per region, against production:

```sql
SELECT org_id, MIN(signed_in_at), MAX(signed_in_at), COUNT(*)
FROM m365_signin_events GROUP BY org_id ORDER BY 2;
```
Record the answer in the PR. An org whose earliest event is days old gets a
days-long report — correct, and correctly labelled, but not what a customer
promised a monthly review expects.

- [ ] **Step 6: Manual smoke** (`pnpm wt-stack up`, with
  `M365_TENANT_SYNC_ENABLED=true`). Seed sign-in events, admins with and without
  MFA, and a CA policy changed in-period. Create the template item, apply it,
  trigger the sweep, and confirm the artifact leads with the coverage line, says
  "interactive sign-ins", puts admin detail above conditional access, and labels
  remote access as client presence. Confirm a site-restricted technician
  generating the same definition gets the empty shape with the org-wide
  explanation. Confirm a portal user cannot see the run until the occurrence is
  delivered.

- [ ] **Step 7: Tear down**

```bash
pnpm test-stack down && pnpm wt-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

- [ ] **Step 8: PR**

Against **`main`**, `Closes #<W06 sub-issue>`, linking the spec and the plan index,
with sections:

- **What the artifact claims** — *interactive* sign-ins only, for the window it
  actually covers. Non-interactive, service-principal and managed-identity
  sign-ins are out of the first cut and the artifact never implies otherwise.
- **The three limits it prints** — Entra ID P1/P2 is required for the data (the
  permission is not enough); risk fields come back `hidden` without P2 and render
  as unmeasured, never "no risk detected"; Graph keeps ~30 days so the first
  monthly report after enabling W05 is partial and says so.
- **Restricted scope is a refusal, not a filter (OD-8 = A)** — M365 identity has
  no site dimension, so a site-restricted technician gets the zero-safe shape with
  an explanation rather than a silently org-wide view. This differs from W02–W04
  on purpose.
- **Remote access is client presence, not policy** — `devices.active_vpns` records
  which overlay client is up; the collector carries no peer lists, keys or policy.
  The section says so.
- **PII and the delivery gate** — this artifact carries user principal names and
  IP addresses. It reaches the customer only through W01's OD-12 delivery gate
  (integration Case 6), the PDF is never persisted, and the type is out of
  `PORTAL_REPORT_TYPES` and both portal-user allowlists so a customer cannot
  generate one on demand.
- **No consent change** — every read is inside `customer-graph-read` v3. Identity
  Protection risky users/events remain out; adding them would be a v4 bump forcing
  every customer to re-consent.
- **Rollout** — **`M365_TENANT_SYNC_ENABLED` must be on**, and a value in
  `/opt/breeze/.env` is necessary but not sufficient: it must also be mapped in the
  `api` service's `environment:` block of `/opt/breeze/docker-compose.yml`.
  Confirm per region. **Confirm W05 has been accumulating for at least one full
  deliverable period** — paste the query result from Step 5. **This release must
  run `pnpm --filter @breeze/api reports:reprovision-portal-definitions`** (dry
  run, then `--apply`), or orgs that enabled portal reports earlier will lack the
  new definition.
- **Localization caveat** — the eight locale files localize the web UI only; the
  PDF renderer is English.

Run `/pr-review-toolkit:review-pr`; act only on confirmed, consequential findings.
Enqueue with `gh pr merge <N>` on green — **never `--admin`**. The PR targets
`main`, so CI already ran; do not hand-dispatch.

---

## Self-review

**Spec coverage.** §3.5.3 contents 1–7 (identity inventory with MFA-unknown
counted separately, dormant accounts, sign-in activity with failures/foreign
countries/legacy auth/CA failures, admin sign-in detail, conditional access
posture with in-period changes and stale policies, remote access as client
presence, changes since last period) → Tasks 4, 5, 6 and integration Cases 1 and
5; §3.5.3 config `{ dormantDays, homeCountries, adminDetail }` → Tasks 2 and 3,
spelled identically in the registry, the schema and `PORTAL_DEFINITIONS`; §3.5.3
site scope → the restricted refusal in Task 5 Step 3 and integration Case 2.
§3.5.2's three printed limits → Task 4's `SigninCoverage`, Task 5's tests, Task 6's
renderer tests and integration Cases 3 and 4; "interactive sign-ins" as the stated
event class → Global Constraints, Task 6's renderer test and integration Case 6.
§3.1 rules 1, 2, 2a, 3, 4, 5, 6 → Global Constraints and Tasks 4, 5, 6. §5.3
steps 1–11 → Tasks 1, 2, 2, 2, 3, 5, 4+6, 8, 9, 7 (step 10's reprovision run is in
the PR rollout section, where it can actually happen). §6 portal impact incl. the
`PortalRunDto` type lie → Task 7. §9.1 contract tests → Tasks 2, 3, 9, 11 Step 3;
new integration tests → Task 10; all-three-render-paths → Task 11 Step 4.
OD-8 = A → Task 5, Task 8's missing site selector, integration Case 2.
OD-10 = A → Task 7, stated twice. OD-12 → integration Case 6, with the PII reason
stated.

**Placeholders.** Five places deliberately instruct a lookup rather than guessing,
each naming what to read or check: the chainable db-mock dialect (Task 5 Step 1 →
`hardwareLifecycleReport.test.ts`), the PDF text-extraction helper (Task 6 Step 1 →
`reportPdf.hardwareLifecycle.test.ts`), the exact Graph `clientAppUsed` strings for
legacy auth (Task 4 Step 3 → current Graph documentation, with the source
commented), whether W03's `loadDomainFreshness` already exists or must be added
here with the identical name and shape (Global Constraints and Task 5's
Interfaces), and the options-form shape (Task 8 Step 3 →
`HardwareLifecycleOptionsForm.tsx`). Task 5 Step 3's numbered block specifies each
section's source and rule; it is a specification, not a TODO.

**Type consistency.** `IdentityAccessSummary`, `SigninCoverage`,
`DormantAccountRow`, `AdminSigninRow`, `CaPolicyRow`, `isRiskFieldMeasured`,
`foreignCountrySignins`, `signinCoverageLine`, `LEGACY_AUTH_CLIENT_APPS`,
`identityAccessConfigSchema`, `identityAccessConfigFields`,
`generateIdentityAccessReport`, `renderIdentityAccessReport`,
`DEFAULT_IDENTITY_ACCESS_OPTIONS`, `IdentityAccessOptionsFields`,
`identityAccessOptionsFromConfig` and `IdentityAccessOptions` are spelled
identically in every task that mentions them. The enum literal
`'identity_access_review'` is identical in the migration, the pg enum, the
`ReportType` union, both switches, `reportTypeSchema`, the registry key,
`MANAGED_EVIDENCE_REPORT_TYPES`, `PORTAL_DEFINITIONS`, `PortalRunDto`, the portal
component union, `REPORT_TYPE_LABELS`, all six web wiring points and every locale
key. `EvidenceRunContext`'s four fields match W01's definition exactly. The three
config keys are identical in the registry `defaultConfig`,
`identityAccessConfigSchema`, `identityAccessConfigFields` and the
`PORTAL_DEFINITIONS` entry — W02's registry/portal parity assertion enforces the
last pair.

**Cross-wave contracts consumed, not re-implemented.** The registry (W01 Task 3) —
one entry added. The publication gate (W01 Task 10) — only asserted, in Case 6,
where it carries the most weight in the whole feature. The period/baseline
contract (W01 Tasks 4, 7, 8) — the generator reads `EvidenceRunContext` and
`opts.previous`; it never derives a window from `now()` and never calls
`previousBaselineFor`. The template column (W01) — used, not changed. From W05:
the `m365_signin_events` table and columns, `signinEventsWindow`'s watermark
semantics, the `unlicensed` and `hidden` sentinels rendered as unmeasured, and the
`last_complete_snapshot_at` freshness contract read unchanged. **This wave changes
nothing in W05**; if it needs a schema change there, that is a W05 follow-up, not
an edit inside this wave.

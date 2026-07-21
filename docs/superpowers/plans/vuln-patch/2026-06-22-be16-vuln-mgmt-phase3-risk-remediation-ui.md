# BE-16 Vulnerability Management — Phase 3 (Risk Scoring + Remediation Workflow + UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "here are your vulnerabilities" into "do something about them" — a CVSS-primary priority score (escalated by KEV/EPSS), remediation that schedules patch jobs, an audited accept-risk / mitigate workflow with expiry, and the web UI (fleet dashboard + per-device tab) that exposes all of it.

**Architecture:** A pure scoring function blends CVSS (the spine) with KEV/EPSS modifiers into `device_vulnerabilities.riskScore`, refreshed by a recurring job. Mutation endpoints wrap in `runAction`, write audit logs, and (for remediation) reuse the existing **per-device install-command path** (`queueCommandForExecution(deviceId, 'install_patches', …)` — the same chokepoint `POST /devices/:id/patches/install` uses). That path already enforces approval, site-scope, MFA, and audit, and lets us target the *specific* patch that fixes a CVE on a *specific* device — which the config-policy `patch_jobs` path (re-resolves *all* approved-pending patches for a device) cannot. Accepted risks carry an expiry that a sweep job enforces. The web layer adds a fleet table (CVSS-sorted, filterable) and a per-device vulnerabilities tab with remediate/accept/mitigate actions.

**Tech Stack:** Hono (TS API), Drizzle ORM, PostgreSQL + RLS, BullMQ + Redis, Astro + React Islands (web), Vitest (api + web), Playwright (e2e).

**Source spec:** `internal/BE-16-vulnerability-management-v2.md`. **Predecessor plans:** Phase 1 (`...-phase1-msrc.md`), Phase 2 (`...-phase2-thirdparty-apple.md`).

> Revised 2026-06-23 per Codex review (corrections folded into tasks below).

## Global Constraints

- **Node:** prefix pnpm/vitest with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- **Web mutations** must wrap in `runAction` (`apps/web/src/lib/runAction.ts`); catch pattern per `CLAUDE.md` (401 → let auth redirect; non-401 ActionError already toasted). The `no-silent-mutations` test guards this — new handlers either use `runAction` or are allowlisted with rationale.
- **Audit:** every remediate / accept-risk / mitigate / manual-sync writes an `audit_logs` row (append-only) via the existing audit helper.
- **RLS/context:** tenant writes to `device_vulnerabilities` use the request `db`; partner-axis patch tables (`patch_approvals`) read under system context where needed (see `[[rls_partner_axis_read_needs_system_context]]`). `withSystemDbAccessContext` takes **only a callback** (`withSystemDbAccessContext(async () => { … })`, `apps/api/src/db/index.ts:187`) — there is no context-object argument; use the imported `db` proxy inside it. `withDbAccessContext(ctx, fn)` is the request-path variant that does take a context object.
- **Authz is not RLS:** RLS isolates *orgs*, not *sites* — site scope is intra-org. Any high-power per-device write (remediate) MUST gate with `requirePermission(devices.execute)` + `requireMfa()` at the route AND enforce the device's org+site access in the core via `auth.orgCondition(devices.orgId)` + `auth.canAccessSite(device.siteId)` (the context-free equivalent of `getDeviceWithOrgAndSiteCheck`, so the same check works on the SDK path that has no Hono `Context`). RLS alone is insufficient.
- **URL state:** web tab/selection state uses `window.location.hash`, not query params (see `DeviceDetails.tsx`).
- **Integration tests** run via `--config vitest.integration.config.ts`; web tests via `apps/web` vitest + jsdom.

## Interfaces inherited from Phases 1–2

- `device_vulnerabilities` (`orgId`, `deviceId`, `vulnerabilityId`, `softwareInventoryId`, `status` open|patched|mitigated|accepted, `riskScore`, `detectedAt`, `resolvedAt`, `mitigationNote`, `acceptedBy`, `acceptedUntil`).
- `vulnerabilities` (`cvssScore`, `severity`, `knownExploited`, `epssScore`, `patchAvailable`, `cveId`).
- `apps/api/src/routes/vulnerabilities.ts` — `vulnerabilityRoutes` (GET fleet + per-device from Phase 1).
- `apps/api/src/services/commandQueue.ts` → `queueCommandForExecution(deviceId, type, payload, { userId, preferHeartbeat })` (the install-command chokepoint remediation reuses).
- `apps/api/src/routes/devices/helpers.ts` → `getDeviceWithOrgAndSiteCheck(c, deviceId, auth)` / `SITE_ACCESS_DENIED` (per-device org+site gate).
- `apps/api/src/routes/patches/helpers.ts` → `resolvePartnerIdForOrg(orgId)`; `apps/api/src/routes/devices/patches.ts` → `getApprovedPatchIdsForPartner(partnerId, patchIds)` (partner-wide manual-approval gate — duplicate locally, it is a module-private helper).
- `apps/api/src/jobs/vulnerabilityJobs.ts` — queue + `initializeVulnerabilityJobs`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/vulnerabilityRiskScore.ts` (create) | Pure `computeRiskScore()` |
| `apps/api/src/jobs/vulnerabilityJobs.ts` (modify) | `risk-score-refresh` + `vuln-accept-expiry` recurring jobs |
| `apps/api/src/routes/vulnerabilities.ts` (modify) | `POST /remediate`, `POST /:id/accept-risk`, `POST /:id/mitigate`, `POST /sync` |
| `apps/api/src/services/vulnerabilityRemediation.ts` (create) | Map a vuln set → matching approved patch → `queueCommandForExecution('install_patches')` |
| `apps/web/src/lib/api/vulnerabilities.ts` (create) | Typed fetchers + action handlers (runAction) |
| `apps/web/src/components/vulnerabilities/VulnerabilityTable.tsx` (create) | Fleet dashboard table (CVSS-sorted, filters) |
| `apps/web/src/pages/vulnerabilities.astro` (create) | Fleet dashboard page + island |
| `apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx` (create) | Per-device tab + actions |
| `apps/web/src/components/devices/DeviceDetails.tsx` (modify) | Mount the new tab |
| `e2e-tests/tests/vulnerabilities.spec.ts` (create) | Dashboard + accept-risk happy path |

---

### Task 1: Risk-score function (pure, TDD)

**Files:**
- Create: `apps/api/src/services/vulnerabilityRiskScore.ts`
- Test: `apps/api/src/services/vulnerabilityRiskScore.test.ts`

**Interfaces:**
- Produces: `computeRiskScore(input: { cvssScore: number|null; knownExploited: boolean; epssScore: number|null }): number` — a 0–100 priority score. CVSS is the spine (`cvssScore*10`); EPSS adds a probability-weighted bump (`epss * 10`); KEV applies a **floor of 80** (a known-exploited CVE is never "low priority", even at CVSS 4) AND a small `+5` nudge so it still orders above a non-KEV CVE of the same CVSS. Result clamped to [0,100], 2 decimals.
  - **Null-CVSS handling (the correction):** a missing CVSS no longer yields `0` — that would sink an unscored-but-KEV or high-EPSS CVE to the bottom. Instead an unscored CVE gets a conservative baseline of **50** (treated as "medium, needs triage") to which the EPSS bump and KEV floor still apply. Only a CVE with *no* CVSS, *no* EPSS, and *not* KEV stays at the 50 baseline; a truly empty `{null,false,null}` therefore scores 50, not 0 — it is "unknown", not "safe".
  - **Tie-breaker:** the cap at 100 means multiple critical CVEs collapse to the same score, so callers must break ties on a secondary key. The query/UI sort is `riskScore DESC, knownExploited DESC, epssScore DESC NULLS LAST, cvssScore DESC NULLS LAST` (see Task 2 SQL + Task 6 table). `computeRiskScore` itself only returns the primary scalar; the secondary keys live on the row.

- [ ] **Step 1: Write the failing tests**

```ts
import { computeRiskScore } from './vulnerabilityRiskScore';

describe('computeRiskScore', () => {
  it('uses CVSS*10 as the base (CVSS is primary)', () => {
    expect(computeRiskScore({ cvssScore: 7.5, knownExploited: false, epssScore: 0 })).toBe(75);
  });
  it('floors a known-exploited (KEV) CVE at 80 even when CVSS is low', () => {
    // CVSS 4 -> base 40, but KEV floor lifts it to 80 (not the old flat +15 -> 55)
    expect(computeRiskScore({ cvssScore: 4.0, knownExploited: true, epssScore: 0 })).toBe(80);
  });
  it('nudges a high-CVSS KEV above its non-KEV twin, capped at 100', () => {
    // 98 + 5 KEV nudge = 103 -> capped 100
    expect(computeRiskScore({ cvssScore: 9.8, knownExploited: true, epssScore: 0 })).toBe(100);
    // a CVSS 8.0 KEV (80 + 5 = 85) outranks a CVSS 8.0 non-KEV (80)
    expect(computeRiskScore({ cvssScore: 8.0, knownExploited: true, epssScore: 0 })).toBe(85);
    expect(computeRiskScore({ cvssScore: 8.0, knownExploited: false, epssScore: 0 })).toBe(80);
  });
  it('adds an EPSS-weighted bump (epss 0..1 -> +0..10)', () => {
    expect(computeRiskScore({ cvssScore: 5.0, knownExploited: false, epssScore: 0.5 })).toBe(55);
  });
  it('does NOT sink an unscored-but-KEV CVE to the bottom', () => {
    // null CVSS -> baseline 50, KEV floor 80 still applies
    expect(computeRiskScore({ cvssScore: null, knownExploited: true, epssScore: null })).toBe(85); // 80 floor + 5 nudge
    // null CVSS + high EPSS still ranks meaningfully (50 baseline + 9)
    expect(computeRiskScore({ cvssScore: null, knownExploited: false, epssScore: 0.9 })).toBe(59);
  });
  it('gives a fully-unknown CVE a triage baseline of 50, not 0', () => {
    expect(computeRiskScore({ cvssScore: null, knownExploited: false, epssScore: null })).toBe(50);
  });
  it('clamps to 100', () => {
    expect(computeRiskScore({ cvssScore: 10, knownExploited: true, epssScore: 1 })).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/vulnerabilityRiskScore.test.ts`
Expected: FAIL ("computeRiskScore is not a function").

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/vulnerabilityRiskScore.ts

/** Baseline for an unscored CVE: "medium, needs triage" — NOT 0 (which would
 *  sink an unscored-but-KEV / high-EPSS CVE to the bottom of the list). */
export const UNSCORED_CVE_BASELINE = 50;
/** A known-exploited CVE is never low priority, even at a low CVSS. */
export const KEV_FLOOR = 80;
/** Small nudge so a KEV CVE orders above its non-KEV twin at the same CVSS. */
export const KEV_NUDGE = 5;

export function computeRiskScore(input: {
  cvssScore: number | null; knownExploited: boolean; epssScore: number | null;
}): number {
  // CVSS is the spine; a missing CVSS falls back to a triage baseline (not 0).
  let score = input.cvssScore == null ? UNSCORED_CVE_BASELINE : input.cvssScore * 10;
  score += (input.epssScore ?? 0) * 10;        // EPSS probability bump (0..10)
  if (input.knownExploited) {
    score = Math.max(score, KEV_FLOOR) + KEV_NUDGE; // floor THEN nudge above twin
  }
  score = Math.max(0, Math.min(100, score));
  return Math.round(score * 100) / 100;
}
```

> Tie-breaking past the cap is the caller's job: sort rows by
> `riskScore DESC, knownExploited DESC, epssScore DESC NULLS LAST, cvssScore DESC NULLS LAST`
> (Task 2 query + Task 6 table). The pure function returns only the scalar.

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/vulnerabilityRiskScore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/vulnerabilityRiskScore.ts apps/api/src/services/vulnerabilityRiskScore.test.ts
git commit -m "feat(vuln): CVSS-primary risk score with KEV/EPSS modifiers"
```

---

### Task 2: `risk-score-refresh` + `vuln-accept-expiry` jobs

**Files:**
- Modify: `apps/api/src/jobs/vulnerabilityJobs.ts`
- Test: `apps/api/src/jobs/vulnerabilityJobsRisk.integration.test.ts` (real DB)

**Interfaces:**
- Consumes: `computeRiskScore` (Task 1).
- Produces:
  - `refreshRiskScores(): Promise<number>` — recompute `device_vulnerabilities.riskScore` for all `status='open'` rows by joining `vulnerabilities`. Returns rows updated.
  - `expireAcceptedRisks(now: Date): Promise<number>` — set `status='open'`, `acceptedBy=null`, `acceptedUntil=null` where `status='accepted' AND acceptedUntil < now`. Returns rows reopened. (Accepts `now` as a param — scripts can't call argless `new Date()` deterministically in tests; pass it in.)

- [ ] **Step 1: Write the failing integration test**

```ts
it('refreshes riskScore from CVSS + KEV', async () => {
  const { orgId, dvId } = await seedOpenDeviceVuln({ cvss: 9.8, kev: true });
  const n = await refreshRiskScores();
  expect(n).toBeGreaterThanOrEqual(1);
  const row = await getDeviceVuln(dvId);
  expect(Number(row.riskScore)).toBe(100); // 98 + KEV nudge -> capped at 100
});
it('reopens an accepted risk past its expiry', async () => {
  const { dvId } = await seedAcceptedDeviceVuln({ acceptedUntil: new Date('2020-01-01') });
  const n = await expireAcceptedRisks(new Date('2026-06-22'));
  expect(n).toBe(1);
  expect((await getDeviceVuln(dvId)).status).toBe('open');
});
it('does not reopen an accepted risk before expiry', async () => {
  await seedAcceptedDeviceVuln({ acceptedUntil: new Date('2030-01-01') });
  expect(await expireAcceptedRisks(new Date('2026-06-22'))).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/jobs/vulnerabilityJobsRisk.integration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement + schedule**

Implement both functions. These are cross-org background passes, so wrap each in the **argless** `withSystemDbAccessContext(async () => { … })` (callback only — `apps/api/src/db/index.ts:187`; use the imported `db` proxy inside the callback). Prefer fetch-compute-write in batches using the TS `computeRiskScore` (single source of truth for the formula) over an inline SQL expression — if product re-weights the score, only Task 1 changes. Sketch:

```ts
import { withSystemDbAccessContext, db } from '../db';
import { eq, and, lt } from 'drizzle-orm';
import { computeRiskScore } from '../services/vulnerabilityRiskScore';

export async function refreshRiskScores(): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({
        id: deviceVulnerabilities.id,
        cvssScore: vulnerabilities.cvssScore,
        knownExploited: vulnerabilities.knownExploited,
        epssScore: vulnerabilities.epssScore,
      })
      .from(deviceVulnerabilities)
      .innerJoin(vulnerabilities, eq(deviceVulnerabilities.vulnerabilityId, vulnerabilities.id))
      .where(eq(deviceVulnerabilities.status, 'open'));
    let updated = 0;
    for (const r of rows) {
      const riskScore = computeRiskScore({
        cvssScore: r.cvssScore == null ? null : Number(r.cvssScore),
        knownExploited: r.knownExploited,
        epssScore: r.epssScore == null ? null : Number(r.epssScore),
      });
      await db.update(deviceVulnerabilities)
        .set({ riskScore: String(riskScore) })
        .where(eq(deviceVulnerabilities.id, r.id));
      updated++;
    }
    return updated;
  });
}

export async function expireAcceptedRisks(now: Date): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const reopened = await db.update(deviceVulnerabilities)
      .set({ status: 'open', acceptedBy: null, acceptedUntil: null })
      .where(and(
        eq(deviceVulnerabilities.status, 'accepted'),
        lt(deviceVulnerabilities.acceptedUntil, now),
      ))
      .returning({ id: deviceVulnerabilities.id });
    return reopened.length;
  });
}
```

(`numeric` columns come back as strings from postgres.js, hence the `Number(...)`/`String(...)` round-trips.) Register two repeatable jobs in `initializeVulnerabilityJobs`: `risk-score-refresh` (hourly `0 * * * *`) → `refreshRiskScores()`, and `vuln-accept-expiry` (daily `0 1 * * *`) → `expireAcceptedRisks(new Date())` (the job *handler* may call `new Date()` — only *workflow scripts* are barred from it, not jobs; `expireAcceptedRisks` itself takes `now` as a param so the test can pin it).

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/jobs/vulnerabilityJobsRisk.integration.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/vulnerabilityJobs.ts apps/api/src/jobs/vulnerabilityJobsRisk.integration.test.ts
git commit -m "feat(vuln): risk-score refresh + accepted-risk expiry jobs"
```

---

### Task 3: Remediation endpoint → per-device install command

**Why the install-command path, not `patch_jobs` (the correction):** a `patch_jobs` row does **not** mean "install patch X". Its executor (`patchJobExecutor.ts:305`) fans out from `targets.deviceIds` to a per-device queue, and the per-device worker re-resolves *all* approved-pending `device_patches` for that device (`patchApprovalEvaluator.ts:234`) — it is config-policy / ring-driven, not patch-targeted. Remediating a specific CVE means "install the *one* patch that fixes it on *this* device", which is exactly what the existing `POST /devices/:id/patches/install` chokepoint does via `queueCommandForExecution(deviceId, 'install_patches', { patchIds, patches }, { userId })` (`routes/devices/patches.ts:360-457`). We reuse that path. It already enforces the partner-wide approval gate and queues a single targeted command; if we used `patch_jobs` we could not scope the install to just the CVE's patch.

**Files:**
- Create: `apps/api/src/services/vulnerabilityRemediation.ts`
- Modify: `apps/api/src/routes/vulnerabilities.ts`
- Test: `apps/api/src/routes/vulnerabilitiesRemediate.integration.test.ts` (real DB)

**Interfaces:**
- Consumes: `queueCommandForExecution` (`services/commandQueue.ts`); `AuthContext` (`middleware/auth.ts`) — its `auth.orgCondition(col)` + `auth.canAccessSite(siteId)` closures (the same checks `getDeviceWithOrgAndSiteCheck` runs internally; pattern reference: `verifyDeviceAccess` in `services/aiTools.ts`); `createAuditLogAsync` (`services/auditService.ts`, the void delegate `writeRouteAudit` ultimately calls); `resolvePartnerIdForOrg` (`routes/patches/helpers.ts`); a partner-wide approval check (duplicate `getApprovedPatchIdsForPartner`'s body locally — it is module-private to `routes/devices/patches.ts`); `devices`, `device_vulnerabilities`, `vulnerabilities`, `patches`, `devicePatches`.
- Produces: `POST /api/v1/vulnerabilities/remediate` body `{ deviceVulnerabilityIds: string[] }`. **Authz mirrors the patch-install route exactly:** `requireScope('organization','partner','system')` + `requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)` + `requireMfa()` at the route. For each id: load the `device_vulnerabilities` row (RLS-scoped to org), enforce its device's org+**site** access directly from `auth` (RLS does not defend the intra-org site axis), pick the **matching approved, applicable patch** (predicate below), `queueCommandForExecution(deviceId, 'install_patches', …)`, and audit `'vulnerability.remediate'`. Returns `{ scheduled: number, skipped: Array<{ id: string; reason: string }> }`. The core service is **context-free** so BOTH the HTTP route AND the Phase 4 AI-tool handler (which runs on the SDK/stream path with no Hono `Context`) can call it: `remediateVulnerabilities(orgId: string, deviceVulnerabilityIds: string[], actorUserId: string, auth: AuthContext)`. It takes `auth` (not `c`) — both call sites possess an `AuthContext` — and does the org+site check + audit directly via `auth` + `createAuditLogAsync`, never via Hono-`Context`-bound helpers.

**CVE→patch match predicate (the correction — array-contains alone is wrong):** for a given `device_vulnerabilities` row, a patch is a remediation candidate only if ALL hold:
1. `patches.cveIds @> ARRAY[<vuln.cveId>]` — the patch advertises this CVE (`cveIds` is indexed, `db/schema/patches.ts:136`).
2. A `device_patches` row exists for `(deviceId, patchId)` with `status = 'pending'` — i.e. the device actually still needs it (`OUTSTANDING_DEVICE_PATCH_STATUSES = ['pending']`; `'missing'` is a stale tombstone, `'installed'` is done). This also implicitly enforces OS/source applicability, because agent scan ingestion only writes `device_patches` rows for patches that apply to that device.
3. The patch is **not superseded** — `patches.supersededBy IS NULL`. A superseded patch should never be the remediation target; if several candidates match, prefer the non-superseded, newest `releaseDate`.
4. The patch is **approved** for the device-org's partner (a partner-wide `patch_approvals.status='approved'` check — implemented as the local `approvedPatchIdsForPartner` helper below, duplicating the module-private `getApprovedPatchIdsForPartner` body, read under system context). Unapproved → skip with reason `'patch not approved'` (mirrors the install route's 409, but here it is a per-vuln skip, not a hard error).

If no candidate satisfies (1)+(2)+(3): skip with reason `'no available patch'`. If candidates exist but none is approved (4): skip with reason `'patch not approved'`.

- [ ] **Step 1: Write the failing integration test**

```ts
// Seed helper must establish the FULL remediable state (the correction):
//   - device (online, in an accessible site), org with a partner
//   - vulnerabilities row (cveId), device_vulnerabilities row (status 'open')
//   - patches row whose cveIds @> {cveId}, supersededBy NULL
//   - device_patches row (deviceId, patchId, status 'pending')
//   - patch_approvals row (partnerId, patchId, status 'approved')
// authHeaders(orgId) must carry an MFA-satisfied token + devices.execute perm.
it('queues an install command for a remediable device vuln', async () => {
  const { orgId, dvId, deviceId } = await seedRemediableDeviceVuln({ cveId: 'CVE-2025-50165' });
  const res = await app.request('/api/v1/vulnerabilities/remediate', {
    method: 'POST', headers: authHeaders(orgId),
    body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.scheduled).toBe(1);
  // A device_commands row of type install_patches was queued for the device.
  const cmds = await rawDb /* breeze_app pool, system ctx */
    .select().from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'install_patches')));
  expect(cmds.length).toBe(1);
  // Audit is fire-and-forget (the core calls createAuditLogAsync, which is void),
  // so POLL for the row rather than counting immediately (the correction).
  await expect.poll(
    async () => auditCount('vulnerability.remediate', orgId),
    { timeout: 5000, interval: 100 }
  ).toBeGreaterThanOrEqual(1);
});
it('skips a vuln whose patch is unapproved', async () => {
  const { orgId, dvId } = await seedRemediableDeviceVuln({ cveId: 'CVE-2025-50165', approved: false });
  const res = await app.request('/api/v1/vulnerabilities/remediate', {
    method: 'POST', headers: authHeaders(orgId),
    body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
  });
  const body = await res.json();
  expect(body.scheduled).toBe(0);
  expect(body.skipped[0].reason).toMatch(/not approved/i);
});
it('skips a vuln with no pending matching patch', async () => {
  const { orgId, dvId } = await seedDeviceVulnNoPatch(); // no patches.cveIds match / no pending device_patches
  const res = await app.request('/api/v1/vulnerabilities/remediate', {
    method: 'POST', headers: authHeaders(orgId),
    body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
  });
  const body = await res.json();
  expect(body.scheduled).toBe(0);
  expect(body.skipped[0].reason).toMatch(/no available patch/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/routes/vulnerabilitiesRemediate.integration.test.ts`
Expected: FAIL (404 — route not mounted yet).

- [ ] **Step 3: Implement service + route**

Add the service. It runs under the request DB context (do NOT wrap in `withSystemDbAccessContext` — these are tenant reads/writes on the request `db`, except the partner-axis approval read; see below):

```ts
// apps/api/src/services/vulnerabilityRemediation.ts
import { and, eq, isNull, sql, desc, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  devices, deviceVulnerabilities, vulnerabilities, patches, devicePatches, patchApprovals,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { resolvePartnerIdForOrg } from '../routes/patches/helpers';
import { queueCommandForExecution } from './commandQueue';
import { createAuditLogAsync } from './auditService';

export interface RemediateResult {
  scheduled: number;
  skipped: Array<{ id: string; reason: string }>;
}

/** Partner-wide manual-approval gate. Partner-axis (patch_approvals) is read under
 *  system context — the request org-scope cannot satisfy breeze_has_partner_access
 *  (see [[rls_partner_axis_read_needs_system_context]]). partnerId is server-derived
 *  from the device's org, so this is safe. */
async function approvedPatchIdsForPartner(partnerId: string, patchIds: string[]): Promise<Set<string>> {
  if (patchIds.length === 0) return new Set();
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () =>
      db.select({ patchId: patchApprovals.patchId })
        .from(patchApprovals)
        .where(and(
          eq(patchApprovals.partnerId, partnerId),
          eq(patchApprovals.status, 'approved'),
          inArray(patchApprovals.patchId, patchIds),
        ))
    )
  );
  return new Set(rows.map((r) => r.patchId));
}

export async function remediateVulnerabilities(
  orgId: string,
  deviceVulnerabilityIds: string[],
  actorUserId: string,
  auth: AuthContext,
): Promise<RemediateResult> {
  const result: RemediateResult = { scheduled: 0, skipped: [] };

  for (const dvId of deviceVulnerabilityIds) {
    // 1. Load the device-vuln + its CVE (RLS-scoped to the caller's org).
    const [row] = await db
      .select({
        id: deviceVulnerabilities.id,
        deviceId: deviceVulnerabilities.deviceId,
        cveId: vulnerabilities.cveId,
        status: deviceVulnerabilities.status,
      })
      .from(deviceVulnerabilities)
      .innerJoin(vulnerabilities, eq(deviceVulnerabilities.vulnerabilityId, vulnerabilities.id))
      .where(eq(deviceVulnerabilities.id, dvId))
      .limit(1);
    if (!row || row.status !== 'open') {
      result.skipped.push({ id: dvId, reason: 'not an open vulnerability' });
      continue;
    }

    // 2. Org + SITE gate, context-free (RLS does not defend the intra-org site
    //    axis). Mirror `verifyDeviceAccess` in aiTools.ts: filter the device by
    //    `auth.orgCondition(devices.orgId)`, then enforce `auth.canAccessSite`.
    const orgCond = auth.orgCondition(devices.orgId);
    const [device] = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(orgCond ? and(eq(devices.id, row.deviceId), orgCond) : eq(devices.id, row.deviceId))
      .limit(1);
    if (!device) { result.skipped.push({ id: dvId, reason: 'device not found' }); continue; }
    if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) {
      result.skipped.push({ id: dvId, reason: 'site access denied' }); continue;
    }

    // 3. Candidate patches: advertises the CVE, not superseded, and the device
    //    has a PENDING device_patches row for it (applicability + still-needed).
    const candidates = await db
      .select({ patchId: patches.id })
      .from(patches)
      .innerJoin(devicePatches, and(
        eq(devicePatches.patchId, patches.id),
        eq(devicePatches.deviceId, row.deviceId),
        eq(devicePatches.status, 'pending'),
      ))
      .where(and(
        sql`${patches.cveIds} @> ARRAY[${row.cveId}]::text[]`,
        isNull(patches.supersededBy),
      ))
      .orderBy(desc(patches.releaseDate));
    if (candidates.length === 0) { result.skipped.push({ id: dvId, reason: 'no available patch' }); continue; }

    // 4. Approval gate (partner-axis, system context).
    const partnerId = await resolvePartnerIdForOrg(orgId);
    const approved = partnerId
      ? await approvedPatchIdsForPartner(partnerId, candidates.map((p) => p.patchId))
      : new Set<string>();
    const target = candidates.find((p) => approved.has(p.patchId));
    if (!target) { result.skipped.push({ id: dvId, reason: 'patch not approved' }); continue; }

    // 5. Queue the targeted install command (same chokepoint as /patches/install).
    const queued = await queueCommandForExecution(
      row.deviceId, 'install_patches',
      { patchIds: [target.patchId] },
      { userId: actorUserId, preferHeartbeat: false },
    );
    if (!queued.command) { result.skipped.push({ id: dvId, reason: queued.error ?? 'failed to queue install command' }); continue; }

    // 6. Audit — context-free. `writeRouteAudit` only existed to pull actorId/
    //    actorEmail off the Hono `c.get('auth')` and IP/UA off the request; on
    //    the SDK path there is no request, so call the void delegate directly
    //    with explicit fields. Fire-and-forget (createAuditLogAsync is void).
    createAuditLogAsync({
      orgId,
      actorType: 'user',
      actorId: actorUserId,
      actorEmail: auth.user?.email,
      action: 'vulnerability.remediate',
      resourceType: 'device_vulnerability',
      resourceId: dvId,
      details: { deviceId: row.deviceId, cveId: row.cveId, patchId: target.patchId, commandId: queued.command.id },
    });
    result.scheduled++;
  }
  return result;
}
```

Then mount the route in `vulnerabilityRoutes` with the full authz stack (mirrors `routes/devices/patches.ts:360`):

```ts
const remediateSchema = z.object({ deviceVulnerabilityIds: z.array(z.string().guid()).min(1).max(200) });

vulnerabilityRoutes.post(
  '/remediate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', remediateSchema),
  async (c) => {
    // Thin binder: the route owns the middleware (requireScope/requirePermission/
    // requireMfa) and unwraps `auth` from the Hono context, then calls the
    // context-free core. orgId: in org scope it is auth.orgId; for partner/system
    // callers the device-vuln rows are RLS-scoped, but audit + approval need an
    // org — for the org-scope happy path use auth.orgId (see note below).
    const auth = c.get('auth');
    const { deviceVulnerabilityIds } = c.req.valid('json');
    const result = await remediateVulnerabilities(
      auth.orgId!, deviceVulnerabilityIds, auth.user.id, auth,
    );
    // 200-with-partial-failure: runAction treats {success:false} as a failure,
    // so report success only when at least one was scheduled OR nothing was asked.
    return c.json({ success: result.scheduled > 0 || deviceVulnerabilityIds.length === 0, ...result });
  }
);
```

> Note on `orgId` for partner/system scope: the snippet above uses `auth.orgId!` for the org-scope path. If you support partner/system callers remediating cross-org, derive `orgId` from each loaded `device.orgId` inside the loop instead and pass it to the audit/approval calls per-row. Keep the per-row site gate either way.

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/routes/vulnerabilitiesRemediate.integration.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/vulnerabilityRemediation.ts apps/api/src/routes/vulnerabilities.ts apps/api/src/routes/vulnerabilitiesRemediate.integration.test.ts
git commit -m "feat(vuln): remediate endpoint via per-device install command (approval/site/MFA gated)"
```

---

### Task 4: Accept-risk + mitigate endpoints

**Files:**
- Modify: `apps/api/src/routes/vulnerabilities.ts`
- Test: `apps/api/src/routes/vulnerabilitiesWorkflow.integration.test.ts` (real DB)

**Interfaces:**
- Produces:
  - `POST /api/v1/vulnerabilities/:id/accept-risk` body `{ reason: string; acceptedUntil: string (ISO) }` → set `status='accepted'`, `acceptedBy=actor`, `acceptedUntil`, `mitigationNote=reason`; audit `'vulnerability.accept_risk'`. 400 if `acceptedUntil` is in the past.
  - `POST /api/v1/vulnerabilities/:id/mitigate` body `{ note: string }` → set `status='mitigated'`, `mitigationNote=note`, `resolvedAt=now`; audit `'vulnerability.mitigate'`.

- [ ] **Step 1: Write the failing integration test**

```ts
it('accepts a risk with reason + future expiry', async () => {
  const { orgId, dvId, userId } = await seedOpenDeviceVuln({});
  const res = await app.request(`/api/v1/vulnerabilities/${dvId}/accept-risk`, {
    method: 'POST', headers: authHeaders(orgId, userId),
    body: JSON.stringify({ reason: 'compensating control in place', acceptedUntil: '2030-01-01T00:00:00Z' }),
  });
  expect(res.status).toBe(200);
  const row = await getDeviceVuln(dvId);
  expect(row.status).toBe('accepted');
  expect(row.acceptedBy).toBe(userId);
});
it('rejects accept-risk with a past expiry', async () => {
  const { orgId, dvId } = await seedOpenDeviceVuln({});
  const res = await app.request(`/api/v1/vulnerabilities/${dvId}/accept-risk`, {
    method: 'POST', headers: authHeaders(orgId),
    body: JSON.stringify({ reason: 'x', acceptedUntil: '2000-01-01T00:00:00Z' }),
  });
  expect(res.status).toBe(400);
});
it('mitigates with a note', async () => {
  const { orgId, dvId } = await seedOpenDeviceVuln({});
  const res = await app.request(`/api/v1/vulnerabilities/${dvId}/mitigate`, {
    method: 'POST', headers: authHeaders(orgId),
    body: JSON.stringify({ note: 'disabled the vulnerable feature' }),
  });
  expect(res.status).toBe(200);
  expect((await getDeviceVuln(dvId)).status).toBe('mitigated');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/routes/vulnerabilitiesWorkflow.integration.test.ts`
Expected: FAIL (404).

- [ ] **Step 3: Implement the two routes**

Add both to `vulnerabilityRoutes` with Zod validation. These are state changes on the org-scoped `device_vulnerabilities` table only (no patch execution), so they need `requirePermission` for a write permission (e.g. `PERMISSIONS.DEVICES_WRITE` — pick the one that matches the vuln-management RBAC; do NOT require `devices.execute`/MFA here, that gate is for the remediate path that queues a command). Writes via request `db` (RLS-scoped). Validate `acceptedUntil > now` (UTC) — reuse the existing date-boundary helper pattern from quotes (`isQuoteExpired`) if one is generalizable, else inline a UTC compare. Audit each via `writeRouteAudit` (fire-and-forget). The Task 4 tests above assert the *row state* by re-reading via `getDeviceVuln` (synchronous-after-await — safe). If you additionally assert an `audit_logs` count, POLL for it (`await expect.poll(() => auditCount(...), { timeout: 5000 }).toBeGreaterThanOrEqual(1)`) — `writeRouteAudit` → `createAuditLogAsync` is void/non-awaited (`services/auditEvents.ts:126`), so an immediate count races (the correction).

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/routes/vulnerabilitiesWorkflow.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/vulnerabilities.ts apps/api/src/routes/vulnerabilitiesWorkflow.integration.test.ts
git commit -m "feat(vuln): accept-risk + mitigate workflow endpoints"
```

---

### Task 5: Manual sync trigger (admin)

**Files:**
- Modify: `apps/api/src/routes/vulnerabilities.ts`
- Test: `apps/api/src/routes/vulnerabilitiesSync.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/vulnerabilities/sync` body `{ source: 'msrc'|'nvd'|'sofa'|'kev_epss' }` → enqueues a `vuln-source-sync` job for that source. **Platform-admin + MFA + rate-limited** (the correction: `platformAdminMiddleware` checks `isPlatformAdmin` but does NOT step-up MFA — `middleware/platformAdmin.ts`). Mirror `routes/thirdPartyCatalog/operations.ts:22-27` which gates an all-mutating admin router with `platformAdminMiddleware` then `requireMfa()`. Add a `userRateLimit` bucket (signature `userRateLimit(bucket, limit, windowSeconds)` — `middleware/userRateLimit.ts:11`) to cap manual triggers, and write an outcome audit row. Returns `{ enqueued: true, jobId }`.

- [ ] **Step 1: Write the failing test**

```ts
it('enqueues a sync job for an admin', async () => {
  const res = await app.request('/api/v1/vulnerabilities/sync', {
    method: 'POST', headers: adminHeaders, // platform-admin + MFA-satisfied token
    body: JSON.stringify({ source: 'nvd' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).enqueued).toBe(true);
});
it('forbids a non-admin', async () => {
  const res = await app.request('/api/v1/vulnerabilities/sync', {
    method: 'POST', headers: authHeaders(orgId),
    body: JSON.stringify({ source: 'nvd' }),
  });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/vulnerabilitiesSync.test.ts`
Expected: FAIL (404).

- [ ] **Step 3: Implement** — add the route gated by `platformAdminMiddleware` → `requireMfa()` → `userRateLimit('vuln-manual-sync', 10, 3600)` (10/hour/user). On a successful enqueue, `writeRouteAudit(c, { orgId: null, action: 'vulnerability.manual_sync', resourceType: 'vulnerability_source', resourceId: source, details: { jobId } })`. The handler calls `getVulnSourceSyncQueue().add('manual', { source })`. Note: `platformAdminMiddleware` already runs `authMiddleware` internally, so do NOT also mount the route's parent `authMiddleware` ahead of it on the same path — apply the admin guard inline on this route (or in a dedicated sub-router) so the org-scoped `requirePermission` used by the rest of `vulnerabilityRoutes` does not run for `/sync`.

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/vulnerabilitiesSync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/vulnerabilities.ts apps/api/src/routes/vulnerabilitiesSync.test.ts
git commit -m "feat(vuln): admin manual sync trigger"
```

---

### Task 6: Web — fleet vulnerability dashboard

**Files:**
- Create: `apps/web/src/lib/api/vulnerabilities.ts`
- Create: `apps/web/src/components/vulnerabilities/VulnerabilityTable.tsx`
- Create: `apps/web/src/pages/vulnerabilities.astro`
- Test: `apps/web/src/components/vulnerabilities/VulnerabilityTable.test.tsx`

**Route collision (the correction):** `/security/vulnerabilities` already exists as a *threats* UI (`apps/web/src/pages/security/vulnerabilities.astro` → `components/security/VulnerabilitiesPage`). This CVE fleet dashboard mounts at the **top-level `/vulnerabilities`** (new `apps/web/src/pages/vulnerabilities.astro`) — do NOT overwrite the security/threats page. Add a distinct primary-nav entry labelled "Vulnerabilities" pointing at `/vulnerabilities`; leave the Security → "Vulnerabilities" (threats) sub-nav untouched. If the dual "Vulnerabilities" label is confusing, label this one "Vulnerability Management" (or "CVEs") in the nav and keep the route `/vulnerabilities`.

**Interfaces:**
- Consumes: `GET /api/v1/vulnerabilities`.
- Produces: `fetchVulnerabilities(filters)` + `VulnerabilityTable` (sorted by riskScore desc with the `knownExploited, epssScore, cvssScore` tie-breakers from Task 1, severity + status filters, uses the shared `ResponsiveTable` primitive per `[[web_responsive_table_primitive_jsdom_dupe]]`).

- [ ] **Step 1: Write the failing component test**

```tsx
it('renders rows sorted by risk and shows a severity badge', async () => {
  vi.mocked(fetchVulnerabilities).mockResolvedValue({ items: [
    { id: '1', cveId: 'CVE-2025-1', cvssScore: 9.8, severity: 'Critical', knownExploited: true, epssScore: 0.9, riskScore: 100, status: 'open', deviceCount: 12 },
    { id: '2', cveId: 'CVE-2025-2', cvssScore: 5.0, severity: 'Medium', knownExploited: false, epssScore: 0.1, riskScore: 60, status: 'open', deviceCount: 3 },
  ]});
  render(<VulnerabilityTable />);
  const desktop = within(screen.getByTestId('responsive-table-desktop'));
  // test-id is `<entity>-row-<id>` per e2e-tests/README.md, NOT a repeated literal
  const rows = await desktop.findAllByTestId(/^vulnerability-row-/);
  expect(rows[0]).toHaveTextContent('CVE-2025-1'); // highest risk first
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/vulnerabilities/VulnerabilityTable.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the fetcher, table, and page**

`vulnerabilities.ts`: typed `fetchVulnerabilities(filters)` hitting the API. `VulnerabilityTable.tsx`: `ResponsiveTable` with columns CVE, severity badge, CVSS, risk, affected devices, status; severity/status `<select>` filters; per-row `data-testid={`vulnerability-row-${v.id}`}` (indexed id, per `e2e-tests/README.md` — `<entity>-row-<id>`). `vulnerabilities.astro`: page shell mounting the island at `/vulnerabilities` (top-level, non-colliding) with its own nav entry. No mutations here → no `runAction` needed (so no `TARGET_GLOBS` entry for this file).

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/vulnerabilities/VulnerabilityTable.test.tsx`
Expected: PASS.

- [ ] **Step 5: astro check + commit**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check` (plain tsc skips `.astro` — see `[[ci_astro_check_and_integration_tests_gotchas]]`)
Expected: no errors.

```bash
git add apps/web/src/lib/api/vulnerabilities.ts apps/web/src/components/vulnerabilities/VulnerabilityTable.tsx apps/web/src/pages/vulnerabilities.astro apps/web/src/components/vulnerabilities/VulnerabilityTable.test.tsx
git commit -m "feat(web): fleet vulnerability dashboard"
```

---

### Task 7: Web — per-device vulnerabilities tab + actions

**Files:**
- Create: `apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx`
- Modify: `apps/web/src/lib/api/vulnerabilities.ts` (add action handlers)
- Test: `apps/web/src/components/devices/DeviceVulnerabilitiesTab.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/vulnerabilities/devices/:deviceId`, `POST .../remediate`, `POST .../:id/accept-risk`, `POST .../:id/mitigate`.
- Produces: action handlers `remediateVuln`, `acceptVulnRisk`, `mitigateVuln` — all wrapped in `runAction`; tab component listing the device's open vulns with per-row actions; hash-based tab selection in `DeviceDetails`.

- [ ] **Step 1: Write the failing test**

```tsx
it('calls remediate via runAction when the button is clicked', async () => {
  vi.mocked(fetchDeviceVulnerabilities).mockResolvedValue({ items: [
    { id: 'dv1', cveId: 'CVE-2025-1', cvssScore: 9.8, severity: 'Critical', status: 'open', patchAvailable: true },
  ]});
  const spy = vi.spyOn(api, 'remediateVuln').mockResolvedValue({ scheduled: 1, skipped: [] });
  render(<DeviceVulnerabilitiesTab deviceId="d1" />);
  const desktop = within(screen.getByTestId('responsive-table-desktop'));
  // action-button id: `<action>-<id>` (a button, not a table row — rows are
  // `vulnerability-row-<id>` per the README convention).
  await userEvent.click(await desktop.findByTestId('remediate-dv1'));
  await waitFor(() => expect(spy).toHaveBeenCalledWith(['dv1']));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceVulnerabilitiesTab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the three `runAction`-wrapped handlers to `vulnerabilities.ts` (catch pattern: 401 → return; non-401 ActionError already toasted). Build `DeviceVulnerabilitiesTab` (ResponsiveTable, per-row `data-testid={`vulnerability-row-${v.id}`}` for rows, per-row Remediate/Accept/Mitigate buttons with `data-testid` like `remediate-${id}` / `accept-${id}` / `mitigate-${id}`; accept-risk opens a small reason+date modal).

Mount it in `DeviceDetails.tsx` as a new hash-routed tab — this requires **four** edits (the correction: it is not a one-liner), all already located:
1. **`Tab` union** (`DeviceDetails.tsx:60-82`): add `| 'vulnerabilities'` to the union.
2. **`VALID_TABS`** (`:128-133`): add `'vulnerabilities'` to the array (otherwise `getTabFromHash` rejects `#vulnerabilities` and falls back to `overview`).
3. **`tabs` list** (`:170-198`): add an entry, e.g. under the Inventory/Management group — `{ id: 'vulnerabilities', label: 'Vulnerabilities', icon: <ShieldAlert className="h-4 w-4" />, title: 'CVEs detected on this device' }` (import the icon from `lucide-react`).
4. **Render switch** (`:241+`, alongside `{activeTab === 'patches' && …}`): add `{activeTab === 'vulnerabilities' && (<DeviceVulnerabilitiesTab deviceId={device.id} />)}` and the import at the top of the file.

The existing `switchTab`/`hashchange` plumbing (`:152-165`) handles `#vulnerabilities` automatically once the three lookups above include it — no new effect needed.

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceVulnerabilitiesTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: no-silent-mutations + astro check**

First register the new mutation-bearing web files in the `TARGET_GLOBS` array of `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (the correction — the guard only enforces files in that list):
- `'src/components/devices/DeviceVulnerabilitiesTab.tsx'`
- `'src/lib/api/vulnerabilities.ts'` (holds the `remediateVuln`/`acceptVulnRisk`/`mitigateVuln` handlers)

(The fleet `VulnerabilityTable.tsx` + `pages/vulnerabilities.astro` have no mutations, so they stay out of `TARGET_GLOBS`.) If a handler legitimately can't use `runAction` (e.g. an aggregate partial-success handler), add a `// runaction-exempt: <reason>` marker at the call site instead — but the three handlers here are plain mutations and should use `runAction`.

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS (new handlers use runAction; new globs added).
Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx apps/web/src/components/devices/DeviceDetails.tsx apps/web/src/lib/api/vulnerabilities.ts apps/web/src/components/devices/DeviceVulnerabilitiesTab.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): per-device vulnerabilities tab with remediate/accept/mitigate"
```

---

### Task 8: E2E happy path + typecheck gate

**Files:**
- Create: `e2e-tests/tests/vulnerabilities.spec.ts`
- Modify: `e2e-tests/seed-fixtures.sql` (add vulnerability seed rows)

- [ ] **Step 1: Seed vuln fixtures (the correction)** — `e2e-tests/seed-fixtures.sql` currently seeds devices + patches + `device_patches` (see its `patches`/`device_patches` block, ~line 168) but **no** `vulnerabilities` / `device_vulnerabilities` rows, so the dashboard and device tab render empty in e2e. Add, idempotently (the file uses `WHERE NOT EXISTS` guards throughout — match that style): a `vulnerabilities` row (e.g. `cve_id='CVE-2025-E2E-1'`, `cvss_score=9.8`, `severity='Critical'`, `known_exploited=true`), and a `device_vulnerabilities` row linking it to the existing Windows seed device with `status='open'` and a `risk_score` (e.g. `100`). Reuse the `v_windows_device_id` / `v_org_id` locals already declared in the seed `DO $$` block. To exercise the accept-risk flow without a live agent, the row only needs to exist as `open`.

- [ ] **Step 2: Write the e2e spec** — log in, open `/vulnerabilities` (top-level route, NOT `/security/vulnerabilities`), assert the table renders rows (`data-testid` `vulnerability-row-<id>` selectors only), open a device's `#vulnerabilities` tab, accept a risk (fill the reason + future-date modal), assert the row moves to `accepted`. Use Page Objects per `e2e-tests/README.md`. (Remediate is harder to assert end-to-end without an online agent + approved patch, so the happy-path e2e covers the dashboard render + accept-risk; remediation is covered by the Task 3 integration test.)

- [ ] **Step 3: Typecheck both packages**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api typecheck && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check`
Expected: no errors.

- [ ] **Step 4: Run the e2e (local stack)** — per `worktree-stack` skill, bring up the stack and run:
Run: `cd e2e-tests && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test vulnerabilities.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e-tests/tests/vulnerabilities.spec.ts e2e-tests/seed-fixtures.sql
git commit -m "test(e2e): vulnerability dashboard + accept-risk happy path"
```

---

## Self-Review

**Spec coverage (v2 Phase 3):**
- Risk scoring (CVSS primary + KEV floor + EPSS, unscored→triage baseline, tie-breaker sort) → Task 1, 2. ✅
- Remediation → per-device approved install command (site/MFA/`devices.execute` gated) → Task 3. ✅
- Accept-risk (expiry + audit) + mitigate → Task 4; expiry sweep → Task 2. ✅
- Manual sync (admin + MFA + rate limit + audit) → Task 5. ✅
- UI: fleet dashboard (top-level `/vulnerabilities`, no collision) + per-device tab + actions → Task 6, 7; e2e (+ seed) → Task 8. ✅
- **Deferred:** AI tools + events (Phase 4); network devices (Phase 5).

**Placeholder scan:** real code in every code step; commands have expected output. ✅

**Type consistency:** `computeRiskScore` signature (Task 1) matches Task 2 usage; `remediateVuln(['dv1'])` shape (web Task 7) matches the `{ deviceVulnerabilityIds }` body (api Task 3); `accept-risk` body `{ reason, acceptedUntil }` consistent across Task 4 + Task 7 modal; remediation reuses `queueCommandForExecution(deviceId, 'install_patches', { patchIds })` — same chokepoint as `routes/devices/patches.ts:360`. The core service is **context-free** — `remediateVulnerabilities(orgId, deviceVulnerabilityIds, actorUserId, auth: AuthContext)` (NOT a Hono `Context`) — so Phase 4's SDK/stream AI-tool handler (no `c`) can call the same function; the HTTP route is a thin binder that unwraps `auth` from `c` and forwards the 4 args. ✅

**Authz consistency:** the remediate route carries `requireScope` + `requirePermission(devices.execute)` + `requireMfa()` and the context-free core enforces the intra-org site gate via `auth.orgCondition` + `auth.canAccessSite` (mirrors `getDeviceWithOrgAndSiteCheck` without a Hono `Context`) — RLS alone is insufficient. The `/sync` route carries `platformAdminMiddleware` + `requireMfa()` + `userRateLimit`. ✅

## Notes for the implementer

- **Risk formula is intentionally simple + explainable** — one pure function, reused by the job. If product wants a different weighting, change it in one place with the test. Remember the null-CVSS baseline (50) and KEV floor (80) so an unscored-but-exploited CVE never sorts to the bottom; tie-break in the query/UI, not the scalar.
- **Remediation is the per-device install-command path, not a `patch_jobs` row.** `enqueuePatchJob(patchJobId, delayMs?)` takes a job *id* and re-resolves all approved-pending patches for a device — it cannot target one CVE's patch. Use `queueCommandForExecution(deviceId, 'install_patches', { patchIds: [patchId] }, { userId })` after the CVE→patch match predicate + approval gate, exactly like `routes/devices/patches.ts:360`.
- **Authz ≠ RLS:** the remediate route MUST gate `devices.execute` + MFA, and the context-free core MUST run the org+site check via `auth.orgCondition` + `auth.canAccessSite` (the inline equivalent of `getDeviceWithOrgAndSiteCheck` — site axis is intra-org; RLS won't catch it). Accept-risk/mitigate are org-scoped state writes (a write permission, no MFA/execute needed).
- **Partner-axis patch reads:** the approval check reads `patch_approvals` (partner-axis) — wrap it in `runOutsideDbContext` + the argless `withSystemDbAccessContext(async () => …)` (`[[rls_partner_axis_read_needs_system_context]]`); the org-scope request context returns 0 rows otherwise.
- **Audit is fire-and-forget:** `writeRouteAudit` → `createAuditLogAsync` is void/non-awaited; never assert an `audit_logs` count immediately after the response — poll (`expect.poll`).
- **runAction is mandatory** for the three web action handlers, and the two mutation-bearing web files must be in `no-silent-mutations` `TARGET_GLOBS` — the test will fail otherwise.
- **Accepted→expired→open** is the only automatic status transition; everything else is user-driven. Don't let `refreshRiskScores` touch non-open rows.

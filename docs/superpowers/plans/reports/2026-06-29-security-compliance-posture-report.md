# Security & Compliance Posture Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `security_compliance_posture` report type that joins Breeze's existing security data (endpoint protection, encryption, firewall, password policy, local-admin exposure, patching, vulnerabilities, privileged-access/PAM, and security integrations) into per-device rows plus percent-implemented rollups an MSP can hand to a cyber-insurance application.

**Architecture:** A new generator function `generateSecurityCompliancePostureReport(orgId, config, perms)` lives in its own service file (`securityComplianceReport.ts`), is wired into the existing `reportGenerationService.generateReport` dispatcher and `ReportType` union, and emits a `ReportResult` with both `rows` (CSV/Excel body) and `summary` (PDF rollups). It rides the run/snapshot/download plumbing from the downloadable-report-runs work unchanged. The report type is added to the `report_type` Postgres enum via migration, and surfaced in the web builder + templates. The PDF is rendered client-side from the stored snapshot.

**Tech Stack:** Hono + Drizzle (API), PostgreSQL enum migration, `@breeze/shared` (no new deps), React + jsPDF (web), Vitest.

**Spec:** `docs/superpowers/specs/reports/2026-06-29-security-compliance-posture-report.md`

## Global Constraints

- **Prerequisite:** the downloadable-report-runs plan (`docs/superpowers/plans/reports/2026-06-29-downloadable-report-runs.md`) must be merged first — this plan imports `generateReport`, `siteScopeRequestAllowed`, `type ReportType`, and `type ReportResult` from `apps/api/src/services/reportGenerationService.ts`, which that plan creates. If those exports do not yet exist, stop and land that plan first.
- **No new agent telemetry.** TPM / Secure Boot / SMBv1 are out of scope (not collected). Read-only over existing tables.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, idempotent, date-prefixed `YYYY-MM-DD-<slug>.sql`, no inner `BEGIN;`/`COMMIT;`. Never edit a shipped migration. The Drizzle enum array in `schema/reports.ts` must be extended in the same PR so `db:check-drift` stays clean.
- **Enum-add safety:** `ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'security_compliance_posture';` is the only statement in its migration file. It must NOT be followed by any statement that *uses* the new label (the value is uncommitted inside `autoMigrate`'s per-file transaction until commit).
- **Site-scope security (mandatory):** the generator MUST honor `perms` and reject out-of-scope `config.sites` exactly as the existing generators do. Reuse `siteScopeRequestAllowed` (already guards the entry points) and resolve in-scope device IDs with the shared helper.
- **Tenancy:** `security_status`, `device_patches`, `device_vulnerabilities`, `s1_agents`, `huntress_agents`, `dns_filter_integrations`, `backup_configs`, `c2c_connections`, `m365_connections`, `google_workspace_connections`, `pam_org_config`, `pam_rules`, `elevation_requests` all carry `org_id` (or device→org). `authenticator_policies` is partner-scoped — read it with the org's `partnerId`. All reads go through the request DB-access context (the generator runs in-request).
- **No silent truncation:** devices with no `security_status` row are reported as "no data," never counted as compliant. CIS is bonus-only and renders "not yet assessed" when absent — never 0%.
- **CSV-injection safety:** tabular egress is already neutralized by `rowsToCsv`/`rowsToTsv` in the download path; emit plain strings/numbers in `rows`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-06-29-a-report-type-security-compliance.sql` (NEW) | `ALTER TYPE report_type ADD VALUE` |
| `apps/api/src/db/schema/reports.ts` (MODIFY) | add enum label to `reportTypeEnum` array |
| `apps/api/src/db/schema/reports.test.ts` (NEW) | asserts the enum contains the new label |
| `apps/api/src/routes/reports/schemas.ts` (MODIFY) | extend `reportTypeSchema`/`generateReportSchema` to accept the type + posture config |
| `apps/api/src/services/reportGenerationService.ts` (MODIFY) | export `resolveSiteAllowedDeviceIds`; add the new type to `ReportType`; add the dispatcher case |
| `apps/api/src/services/securityComplianceReport.ts` (NEW) | the generator + helpers (EDR merge, control rollups, PAM) |
| `apps/api/src/services/securityComplianceReport.test.ts` (NEW) | generator unit tests (Drizzle-mock) |
| `apps/web/src/components/reports/reportTypes.ts` (MODIFY or wherever the type list lives) | add the builder option + columns |
| `apps/web/src/components/reports/ReportTemplates.tsx` (MODIFY) | curated "Security & Compliance Posture" template |
| `apps/web/src/components/reports/reportExport.ts` (MODIFY) | PDF branch that renders the posture summary |
| `apps/web/src/components/reports/reportExport.posture.test.tsx` (NEW) | PDF/export shape test |

---

## Task 1: Add the report type to the enum

**Files:**
- Create: `apps/api/migrations/2026-06-29-a-report-type-security-compliance.sql`
- Modify: `apps/api/src/db/schema/reports.ts:5-12`
- Test: `apps/api/src/db/schema/reports.test.ts` (NEW)

**Interfaces:**
- Produces: the `'security_compliance_posture'` label on `reportTypeEnum` (consumed by Tasks 2, 3, 5).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema/reports.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reportTypeEnum } from './reports';

describe('reportTypeEnum', () => {
  it('includes the security & compliance posture type', () => {
    expect(reportTypeEnum.enumValues).toContain('security_compliance_posture');
  });

  it('keeps the original six types', () => {
    for (const t of [
      'device_inventory',
      'software_inventory',
      'alert_summary',
      'compliance',
      'performance',
      'executive_summary'
    ]) {
      expect(reportTypeEnum.enumValues).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/db/schema/reports.test.ts`
Expected: FAIL — `expected [ ...six... ] to contain 'security_compliance_posture'`.

- [ ] **Step 3: Add the label to the Drizzle enum**

In `apps/api/src/db/schema/reports.ts`, extend the array:

```ts
export const reportTypeEnum = pgEnum('report_type', [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture'
]);
```

- [ ] **Step 4: Write the migration**

Create `apps/api/migrations/2026-06-29-a-report-type-security-compliance.sql`:

```sql
-- Add the Security & Compliance Posture report type.
-- ALTER TYPE ... ADD VALUE is the ONLY statement in this file: under autoMigrate's
-- per-file transaction the new label is uncommitted until the file commits, so no
-- later statement here may use it. IF NOT EXISTS makes re-application a no-op.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'security_compliance_posture';
```

- [ ] **Step 5: Run schema test + drift check**

Run: `pnpm --filter @breeze/api exec vitest run src/db/schema/reports.test.ts`
Expected: PASS.

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift (enum array matches the migrated type).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-06-29-a-report-type-security-compliance.sql apps/api/src/db/schema/reports.ts apps/api/src/db/schema/reports.test.ts
git commit -m "feat(api): add security_compliance_posture report type to enum"
```

---

## Task 2: Validation schema for the new type + its config

**Files:**
- Modify: `apps/api/src/routes/reports/schemas.ts`
- Test: covered by Task 4's generator tests + an inline schema test here

**Interfaces:**
- Consumes: the enum label (Task 1).
- Produces: `securityCompliancePostureConfigSchema` and an extended report-type union accepting `'security_compliance_posture'` (consumed by the generate/create routes and Task 3).

- [ ] **Step 1: Inspect the existing schema to mirror it**

Run: `grep -nE "reportType|z.enum|generateReportSchema|config" apps/api/src/routes/reports/schemas.ts`
Expected: shows the existing `z.enum([...])` of report types and the `config` shape. Mirror that enum's member list — add `'security_compliance_posture'` to every `z.enum([...])` of report types in this file.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/reports/schemas.security.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateReportSchema, securityCompliancePostureConfigSchema } from './schemas';

describe('security_compliance_posture validation', () => {
  it('accepts the new report type in generateReportSchema', () => {
    const parsed = generateReportSchema.safeParse({
      type: 'security_compliance_posture',
      format: 'pdf',
      config: { sites: [], minPasswordLength: 8, maxLocalAdmins: 2 }
    });
    expect(parsed.success).toBe(true);
  });

  it('applies threshold defaults', () => {
    const cfg = securityCompliancePostureConfigSchema.parse({});
    expect(cfg.minPasswordLength).toBe(8);
    expect(cfg.maxLocalAdmins).toBe(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/reports/schemas.security.test.ts`
Expected: FAIL — `securityCompliancePostureConfigSchema` is not exported / type rejected.

- [ ] **Step 4: Add the config schema and extend the type enums**

In `apps/api/src/routes/reports/schemas.ts`:

(a) Add `'security_compliance_posture'` to each report-type `z.enum([...])` list in the file (the one used by `generateReportSchema` and any create schema).

(b) Add the config schema (place near the other config shapes):

```ts
/** Config for the Security & Compliance Posture report. Thresholds drive the
 *  pass/fail percentages; all optional with insurance-sensible defaults. */
export const securityCompliancePostureConfigSchema = z.object({
  sites: z.array(z.string().guid()).optional().default([]),
  // window for elevation activity + (future) trend; days back from now.
  windowDays: z.number().int().min(1).max(365).optional().default(30),
  // password-complexity floor: a device passes if minLength >= this AND lockout is set.
  minPasswordLength: z.number().int().min(1).max(64).optional().default(8),
  // local-admin exposure: a device is flagged if it has MORE than this many local admins.
  maxLocalAdmins: z.number().int().min(0).max(50).optional().default(2),
  // AV definitions older than this many days count as stale.
  maxAvDefinitionsAgeDays: z.number().int().min(1).max(365).optional().default(7)
});
```

> Note: if `generateReportSchema.config` is currently `z.record(z.any())` / loose, leave it loose (the generator reads via the config schema's `.parse`); this dedicated schema is what the generator uses internally. If `generateReportSchema` strictly unions per-type configs, add `securityCompliancePostureConfigSchema` to that union.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/reports/schemas.security.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/reports/schemas.ts apps/api/src/routes/reports/schemas.security.test.ts
git commit -m "feat(api): validate security_compliance_posture report type + config"
```

---

## Task 3: Export the site-scope helper from the generation service

**Files:**
- Modify: `apps/api/src/services/reportGenerationService.ts`

**Interfaces:**
- Produces: `export async function resolveSiteAllowedDeviceIds(orgId: string, siteIds: string[] | undefined, perms: UserPermissions | undefined): Promise<{ deviceIds: string[]; scoped: boolean }>` (or the exact existing signature — see Step 1). Consumed by Task 4.

The downloadable-report-runs plan moved `resolveSiteAllowedDeviceIds` into this service but it may be module-private. Task 4's generator needs it.

- [ ] **Step 1: Find the helper and its real signature**

Run: `grep -nE "resolveSiteAllowedDeviceIds|addAllowedSiteCondition|function asStringArray|siteScopeRequestAllowed" apps/api/src/services/reportGenerationService.ts`
Expected: shows the function and whether it is already `export`. Record its exact signature — Task 4 must call it verbatim.

- [ ] **Step 2: Export it (if not already)**

If `resolveSiteAllowedDeviceIds` is declared `async function resolveSiteAllowedDeviceIds(...)`, prefix `export`. Likewise export `asStringArray` if the generator needs array coercion. Do not change behavior.

```ts
export async function resolveSiteAllowedDeviceIds(/* existing params */) {
  /* existing body unchanged */
}
```

- [ ] **Step 3: Run existing report tests (no behavior change)**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/reports.test.ts`
Expected: PASS — exporting a symbol changes nothing.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/reportGenerationService.ts
git commit -m "refactor(api): export resolveSiteAllowedDeviceIds for reuse"
```

---

## Task 4: The generator (`securityComplianceReport.ts`)

**Files:**
- Create: `apps/api/src/services/securityComplianceReport.ts`
- Test: `apps/api/src/services/securityComplianceReport.test.ts`

**Interfaces:**
- Consumes: `resolveSiteAllowedDeviceIds` (Task 3); `securityCompliancePostureConfigSchema` (Task 2); `ReportResult` (downloadable-report-runs); the schema tables listed in Global Constraints.
- Produces: `export async function generateSecurityCompliancePostureReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions): Promise<ReportResult>`. Consumed by Task 5.

Output `ReportResult.rows` = per-device records; `ReportResult.summary` = the rollups in spec §3 (`controls`, `privilegedAccess`, `securityProducts`, `postureScore`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/securityComplianceReport.test.ts`. The generator runs many `db.select()` chains; the test drives them with a sequenced chainable mock (mirror the `selectChain` helper used in `reports.test.ts`).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./reportGenerationService', () => ({
  resolveSiteAllowedDeviceIds: vi.fn(async () => ({
    deviceIds: ['dev-1', 'dev-2', 'dev-3'],
    scoped: false
  }))
}));

import { db } from '../db';
import { generateSecurityCompliancePostureReport } from './securityComplianceReport';

/** Thenable that resolves to `rows` and supports any drizzle chain method. */
function selectChain(rows: any) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) {
    p[m] = () => p;
  }
  return p;
}

const ORG = '00000000-0000-0000-0000-000000000001';

/**
 * The generator issues its selects in this fixed order (see implementation):
 *  1 organizations (id,name,partnerId)   2 devices (in-scope)   3 security_status
 *  4 s1_agents   5 huntress_agents   6 device_patches+severity   7 device_vulns
 *  8 dns_filter  9 backup_configs   10 c2c_connections   11 m365   12 google
 * 13 pam_org_config   14 pam_rules (enabled)   15 elevation_requests
 * 16 authenticator_policies (only if org has partnerId)   17 latest org posture snapshot
 */
function mockGeneratorQueries(over: Partial<Record<number, any[]>> = {}) {
  const seq: any[][] = [
    /* 1 organizations */      [{ id: ORG, name: 'Acme Co', partnerId: 'p1' }],
    /* 2 devices */            [
      { id: 'dev-1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ' },
      { id: 'dev-2', hostname: 'pc-2', osType: 'macos', siteName: 'HQ' },
      { id: 'dev-3', hostname: 'pc-3', osType: 'windows', siteName: 'Remote' }
    ],
    /* 3 security_status */    [
      { deviceId: 'dev-1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 } },
      { deviceId: 'dev-2', provider: 'other', realTimeProtection: false, definitionsDate: null, encryptionStatus: 'unencrypted', firewallEnabled: false, passwordPolicySummary: { minLength: 4 }, localAdminSummary: { adminCount: 5 } }
      // dev-3 intentionally has NO security_status row → "no data" + unprotected
    ],
    /* 4 s1_agents */          [],
    /* 5 huntress_agents */    [{ deviceId: 'dev-1' }],
    /* 6 device_patches */     [{ deviceId: 'dev-2', severity: 'critical' }],
    /* 7 device_vulns */       [{ deviceId: 'dev-1', severity: 'high' }],
    /* 8 dns_filter */         [{ isActive: true, provider: 'cisco_umbrella', lastSyncStatus: 'success' }],
    /* 9 backup_configs */     [{ isActive: true, provider: 's3', encryption: true }],
    /* 10 c2c */               [],
    /* 11 m365 */              [{ status: 'active' }],
    /* 12 google */            [],
    /* 13 pam_org_config */    [{ uacInterceptionEnabled: true }],
    /* 14 pam_rules */         [{ id: 'r1' }, { id: 'r2' }],
    /* 15 elevation_requests*/ [{ approvedAt: new Date(), deniedByUserId: null }, { approvedAt: null, deniedByUserId: 'u1' }],
    /* 16 authenticator */     [{ requireEnrollment: true, enforceFrom: new Date(Date.now() - 86400000) }],
    /* 17 posture snapshot */  [{ overallScore: 82 }]
  ];
  for (const [i, rows] of Object.entries(over)) seq[Number(i) - 1] = rows;
  const m = vi.mocked(db.select);
  m.mockReset();
  for (const rows of seq) m.mockReturnValueOnce(selectChain(rows));
  // any extra calls resolve empty
  m.mockReturnValue(selectChain([]));
}

describe('generateSecurityCompliancePostureReport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges managed EDR with native AV and flags unprotected devices', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, { sites: [] });

    // dev-1: Huntress (managed) + Defender; dev-2: native only, RTP off → not protected; dev-3: no data
    const byHost = Object.fromEntries((r.rows as any[]).map((x) => [x.hostname, x]));
    expect(byHost['pc-1'].protectionManaged).toBe(true);
    expect(byHost['pc-1'].protection).toMatch(/Huntress/i);
    expect(byHost['pc-2'].protectionManaged).toBe(false);

    // EDR coverage = 1 managed of 3 in-scope devices
    expect(r.summary!.controls.edrCoveragePct).toBe(33);
    // unprotected = dev-2 (AV but RTP off) + dev-3 (no data) = 2
    expect(r.summary!.controls.unprotectedCount).toBe(2);
  });

  it('computes control percentages from security_status', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const c = r.summary!.controls;
    expect(c.encryptionPct).toBe(50);   // dev-1 encrypted of 2 reporting
    expect(c.firewallPct).toBe(50);     // dev-1 firewall on of 2 reporting
    expect(c.passwordComplexityPct).toBe(50); // dev-1 minLength 12 + lockout; dev-2 fails
  });

  it('summarizes privileged access from PAM tables', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const p = r.summary!.privilegedAccess;
    expect(p.uacInterceptionEnabled).toBe(true);
    expect(p.activePamRules).toBe(2);
    expect(p.elevationsApproved).toBe(1);
    expect(p.elevationsDenied).toBe(1);
    expect(p.mfaStepUpEnforced).toBe(true);
  });

  it('renders CIS as null (not 0) when no baseline scans exist', async () => {
    mockGeneratorQueries(); // no CIS query is issued by default path
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    expect(r.summary!.controls.cisAvgPassRate).toBeNull();
  });

  it('lists active security products', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const names = r.summary!.securityProducts.map((p) => p.product.toLowerCase());
    expect(names).toContain('huntress');
    expect(names.join(' ')).toMatch(/umbrella|dns/);
  });

  it('returns empty rows but a valid summary when no devices in scope', async () => {
    // deviceIds come from resolveSiteAllowedDeviceIds (not a db.select), so the
    // empty path is driven by overriding THAT mock, not a query in the sequence.
    const svc = await import('./reportGenerationService');
    vi.mocked(svc.resolveSiteAllowedDeviceIds).mockResolvedValueOnce({ deviceIds: [], scoped: false });
    mockGeneratorQueries(); // only query 1 (organizations) actually runs before early return
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    expect(r.rows).toEqual([]);
    expect(r.summary!.deviceCount).toBe(0);
    expect(r.summary!.controls.edrCoveragePct).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/securityComplianceReport.test.ts`
Expected: FAIL — `Cannot find module './securityComplianceReport'`.

- [ ] **Step 3: Implement the generator**

Create `apps/api/src/services/securityComplianceReport.ts`:

```ts
import { and, eq, inArray, gte, sql } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema/devices';
import { sites } from '../db/schema/sites';
import { organizations } from '../db/schema/orgs';
import { securityStatus, securityPostureOrgSnapshots } from '../db/schema/security';
import { s1Agents } from '../db/schema/sentinelOne';
import { huntressAgents } from '../db/schema/huntress';
import { devicePatches, patches } from '../db/schema/patches';
import { deviceVulnerabilities, vulnerabilities } from '../db/schema/vulnerabilityManagement';
import { dnsFilterIntegrations } from '../db/schema/dnsSecurity';
import { backupConfigs } from '../db/schema/backup';
import { c2cConnections } from '../db/schema/c2c';
import { m365Connections } from '../db/schema/m365';
import { googleWorkspaceConnections } from '../db/schema/google';
import { pamOrgConfig, pamRules } from '../db/schema/pam';
import { elevationRequests } from '../db/schema/elevations';
import { authenticatorPolicies } from '../db/schema/authenticatorPolicies';
import { resolveSiteAllowedDeviceIds } from './reportGenerationService';
import { securityCompliancePostureConfigSchema } from '../routes/reports/schemas';
import type { UserPermissions } from './permissions';
import type { ReportResult } from './reportGenerationService';

const pct = (num: number, denom: number): number =>
  denom === 0 ? 0 : Math.round((num / denom) * 100);

const daysAgo = (d: Date | null): number | null =>
  d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;

/** Build a human label for a device's detected protection products. */
function protectionLabel(opts: {
  managed: string[];           // e.g. ['Huntress','SentinelOne']
  nativeProvider: string | null;
  rtp: boolean | null;
}): string {
  const parts = [...opts.managed];
  if (opts.nativeProvider && opts.nativeProvider !== 'other') {
    parts.push(prettyProvider(opts.nativeProvider));
  }
  if (parts.length === 0) return 'None detected';
  const rtp = opts.rtp === true ? ' (RTP on)' : opts.rtp === false ? ' (RTP off)' : '';
  return parts.join(' + ') + rtp;
}

function prettyProvider(p: string): string {
  const map: Record<string, string> = {
    windows_defender: 'Defender',
    sentinelone: 'SentinelOne',
    crowdstrike: 'CrowdStrike',
    bitdefender: 'Bitdefender',
    sophos: 'Sophos',
    malwarebytes: 'Malwarebytes',
    eset: 'ESET',
    kaspersky: 'Kaspersky'
  };
  return map[p] ?? p;
}

function passwordComplexityPass(summary: unknown, minLength: number): boolean {
  if (!summary || typeof summary !== 'object') return false;
  const s = summary as Record<string, unknown>;
  const len = typeof s.minLength === 'number' ? s.minLength : 0;
  const lockout =
    typeof s.lockoutThreshold === 'number' ? s.lockoutThreshold > 0 : Boolean(s.lockoutEnabled);
  return len >= minLength && lockout;
}

function localAdminCount(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as Record<string, unknown>;
  return typeof s.adminCount === 'number' ? s.adminCount : null;
}

export async function generateSecurityCompliancePostureReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  perms?: UserPermissions
): Promise<ReportResult> {
  const cfg = securityCompliancePostureConfigSchema.parse(rawConfig ?? {});
  const generatedAt = new Date().toISOString();

  // (1) in-scope devices (honors site filter + perms via the shared helper)
  const { deviceIds } = await resolveSiteAllowedDeviceIds(orgId, cfg.sites, perms);

  // First (and only) organizations read — grab partnerId here too so we never
  // query organizations twice (keeps the select order deterministic for tests).
  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (deviceIds.length === 0) {
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: emptySummary(orgRow, generatedAt)
    };
  }

  const inScope = inArray(devices.id, deviceIds);

  // (1b) device meta
  const deviceRows = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      siteName: sites.name
    })
    .from(devices)
    .leftJoin(sites, eq(devices.siteId, sites.id))
    .where(and(eq(devices.orgId, orgId), inScope));

  // (2) security_status
  const ssRows = await db
    .select({
      deviceId: securityStatus.deviceId,
      provider: securityStatus.provider,
      realTimeProtection: securityStatus.realTimeProtection,
      definitionsDate: securityStatus.definitionsDate,
      encryptionStatus: securityStatus.encryptionStatus,
      firewallEnabled: securityStatus.firewallEnabled,
      passwordPolicySummary: securityStatus.passwordPolicySummary,
      localAdminSummary: securityStatus.localAdminSummary
    })
    .from(securityStatus)
    .where(and(eq(securityStatus.orgId, orgId), inArray(securityStatus.deviceId, deviceIds)));
  const ssByDevice = new Map(ssRows.map((r) => [r.deviceId, r]));

  // (3,4) managed EDR per device (orgId is denormalized on both agent tables)
  const s1Rows = await db
    .select({ deviceId: s1Agents.deviceId })
    .from(s1Agents)
    .where(and(eq(s1Agents.orgId, orgId), inArray(s1Agents.deviceId, deviceIds)));
  const huntressRows = await db
    .select({ deviceId: huntressAgents.deviceId })
    .from(huntressAgents)
    .where(and(eq(huntressAgents.orgId, orgId), inArray(huntressAgents.deviceId, deviceIds)));
  const s1Devices = new Set(s1Rows.map((r) => r.deviceId));
  const huntressDevices = new Set(huntressRows.map((r) => r.deviceId));

  // (5) pending critical patches per device
  const patchRows = await db
    .select({ deviceId: devicePatches.deviceId, severity: patches.severity })
    .from(devicePatches)
    .innerJoin(patches, eq(devicePatches.patchId, patches.id))
    .where(
      and(
        eq(devicePatches.orgId, orgId),
        inArray(devicePatches.deviceId, deviceIds),
        eq(devicePatches.status, 'pending')
      )
    );
  const pendingByDevice = new Map<string, { total: number; critical: number }>();
  for (const p of patchRows) {
    const e = pendingByDevice.get(p.deviceId) ?? { total: 0, critical: 0 };
    e.total += 1;
    if (p.severity === 'critical') e.critical += 1;
    pendingByDevice.set(p.deviceId, e);
  }

  // (6) open vulnerabilities per device by CVSS severity
  const vulnRows = await db
    .select({ deviceId: deviceVulnerabilities.deviceId, severity: vulnerabilities.severity })
    .from(deviceVulnerabilities)
    .innerJoin(vulnerabilities, eq(deviceVulnerabilities.vulnerabilityId, vulnerabilities.id))
    .where(inArray(deviceVulnerabilities.deviceId, deviceIds));
  const vulnByDevice = new Map<string, { critical: number; high: number }>();
  for (const v of vulnRows) {
    const e = vulnByDevice.get(v.deviceId) ?? { critical: 0, high: 0 };
    if (v.severity === 'critical') e.critical += 1;
    else if (v.severity === 'high') e.high += 1;
    vulnByDevice.set(v.deviceId, e);
  }

  // (7-11) security integrations (org-scoped; "in use" = active/connected)
  const [dns] = await db
    .select({ isActive: dnsFilterIntegrations.isActive, provider: dnsFilterIntegrations.provider, lastSyncStatus: dnsFilterIntegrations.lastSyncStatus })
    .from(dnsFilterIntegrations)
    .where(and(eq(dnsFilterIntegrations.orgId, orgId), eq(dnsFilterIntegrations.isActive, true)))
    .limit(1);
  const [backup] = await db
    .select({ isActive: backupConfigs.isActive, provider: backupConfigs.provider, encryption: backupConfigs.encryption })
    .from(backupConfigs)
    .where(and(eq(backupConfigs.orgId, orgId), eq(backupConfigs.isActive, true)))
    .limit(1);
  const [c2c] = await db
    .select({ status: c2cConnections.status, provider: c2cConnections.provider })
    .from(c2cConnections)
    .where(and(eq(c2cConnections.orgId, orgId), eq(c2cConnections.status, 'active')))
    .limit(1);
  const [m365] = await db
    .select({ status: m365Connections.status })
    .from(m365Connections)
    .where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.status, 'active')))
    .limit(1);
  const [google] = await db
    .select({ status: googleWorkspaceConnections.status })
    .from(googleWorkspaceConnections)
    .where(and(eq(googleWorkspaceConnections.orgId, orgId), eq(googleWorkspaceConnections.status, 'active')))
    .limit(1);

  // (12-15) privileged access
  const [pamCfg] = await db
    .select({ uacInterceptionEnabled: pamOrgConfig.uacInterceptionEnabled })
    .from(pamOrgConfig)
    .where(eq(pamOrgConfig.orgId, orgId))
    .limit(1);
  const pamRuleRows = await db
    .select({ id: pamRules.id })
    .from(pamRules)
    .where(and(eq(pamRules.orgId, orgId), eq(pamRules.enabled, true)));
  const windowStart = new Date(Date.now() - cfg.windowDays * 86400000);
  const elevationRows = await db
    .select({ approvedAt: elevationRequests.approvedAt, deniedByUserId: elevationRequests.deniedByUserId })
    .from(elevationRequests)
    .where(and(eq(elevationRequests.orgId, orgId), gte(elevationRequests.requestedAt, windowStart)));
  const elevationsApproved = elevationRows.filter((e) => e.approvedAt != null).length;
  const elevationsDenied = elevationRows.filter((e) => e.deniedByUserId != null).length;

  let mfaStepUpEnforced = false;
  if (orgRow?.partnerId) {
    const [authPol] = await db
      .select({ requireEnrollment: authenticatorPolicies.requireEnrollment, enforceFrom: authenticatorPolicies.enforceFrom })
      .from(authenticatorPolicies)
      .where(eq(authenticatorPolicies.partnerId, orgRow.partnerId))
      .limit(1);
    mfaStepUpEnforced =
      Boolean(authPol?.requireEnrollment) &&
      (!authPol?.enforceFrom || new Date(authPol.enforceFrom).getTime() <= Date.now());
  }

  // (16) latest org posture score (bonus; null if posture engine hasn't run)
  const [postureRow] = await db
    .select({ overallScore: securityPostureOrgSnapshots.overallScore })
    .from(securityPostureOrgSnapshots)
    .where(eq(securityPostureOrgSnapshots.orgId, orgId))
    .orderBy(sql`${securityPostureOrgSnapshots.capturedAt} DESC`)
    .limit(1);

  // ---- assemble per-device rows + counters ----
  let reporting = 0; // devices with a security_status row (the control denominator)
  let managedEdr = 0;
  let anyAv = 0;
  let unprotected = 0;
  let encrypted = 0;
  let firewall = 0;
  let pwPass = 0;
  let adminFlagged = 0;
  let patchCurrent = 0;

  const rows = deviceRows.map((d) => {
    const ss = ssByDevice.get(d.id);
    const managed: string[] = [];
    if (huntressDevices.has(d.id)) managed.push('Huntress');
    if (s1Devices.has(d.id)) managed.push('SentinelOne');
    const isManaged = managed.length > 0;
    const rtp = ss?.realTimeProtection ?? null;
    const hasNativeAv = Boolean(ss && ss.provider && ss.provider !== 'other' && rtp === true);
    const protectedDevice = isManaged || hasNativeAv;

    if (ss) reporting += 1;
    if (isManaged) managedEdr += 1;
    if (isManaged || hasNativeAv) anyAv += 1;
    if (!protectedDevice) unprotected += 1;

    const enc = ss?.encryptionStatus ?? 'unknown';
    if (ss && enc === 'encrypted') encrypted += 1;
    if (ss && ss.firewallEnabled === true) firewall += 1;
    if (ss && passwordComplexityPass(ss.passwordPolicySummary, cfg.minPasswordLength)) pwPass += 1;
    const admins = ss ? localAdminCount(ss.localAdminSummary) : null;
    if (admins != null && admins > cfg.maxLocalAdmins) adminFlagged += 1;

    const pend = pendingByDevice.get(d.id) ?? { total: 0, critical: 0 };
    if (ss && pend.critical === 0) patchCurrent += 1;
    const vuln = vulnByDevice.get(d.id) ?? { critical: 0, high: 0 };

    return {
      hostname: d.hostname,
      site: d.siteName ?? null,
      os: d.osType ?? '',
      protection: ss || isManaged ? protectionLabel({ managed, nativeProvider: ss?.provider ?? null, rtp }) : 'No data',
      protectionManaged: isManaged,
      realTimeProtection: rtp,
      avDefinitionsAgeDays: ss ? daysAgo(ss.definitionsDate) : null,
      encryption: ss ? enc : 'no data',
      firewall: ss ? ss.firewallEnabled : null,
      localAdmins: admins,
      pendingPatches: pend.total,
      criticalPatches: pend.critical,
      openVulnCritical: vuln.critical,
      openVulnHigh: vuln.high,
      cisPassRate: null, // CIS bonus not wired in v1; see spec §5
      posture: null
    };
  });

  const deviceCount = deviceRows.length;

  const securityProducts: Array<{ product: string; category: string; active: boolean; lastSyncStatus: string | null; deviceCoverage: number | null }> = [];
  if (huntressDevices.size > 0) securityProducts.push({ product: 'Huntress', category: 'mdr', active: true, lastSyncStatus: null, deviceCoverage: huntressDevices.size });
  if (s1Devices.size > 0) securityProducts.push({ product: 'SentinelOne', category: 'edr', active: true, lastSyncStatus: null, deviceCoverage: s1Devices.size });
  if (dns) securityProducts.push({ product: prettyDnsProvider(dns.provider), category: 'dns_filtering', active: true, lastSyncStatus: dns.lastSyncStatus ?? null, deviceCoverage: null });
  if (backup) securityProducts.push({ product: `Backup (${backup.provider})`, category: 'backup', active: true, lastSyncStatus: null, deviceCoverage: null });
  if (c2c) securityProducts.push({ product: `SaaS backup (${c2c.provider})`, category: 'backup', active: true, lastSyncStatus: null, deviceCoverage: null });
  if (m365) securityProducts.push({ product: 'Microsoft 365', category: 'identity', active: true, lastSyncStatus: null, deviceCoverage: null });
  if (google) securityProducts.push({ product: 'Google Workspace', category: 'identity', active: true, lastSyncStatus: null, deviceCoverage: null });

  return {
    rows,
    rowCount: rows.length,
    generatedAt,
    summary: {
      org: { id: orgRow?.id ?? orgId, name: orgRow?.name ?? 'Unknown' },
      generatedAt,
      deviceCount,
      controls: {
        edrCoveragePct: pct(managedEdr, deviceCount),
        anyAvCoveragePct: pct(anyAv, deviceCount),
        unprotectedCount: unprotected,
        encryptionPct: pct(encrypted, reporting),
        firewallPct: pct(firewall, reporting),
        patchCurrentPct: pct(patchCurrent, reporting),
        passwordComplexityPct: pct(pwPass, reporting),
        localAdminExposurePct: pct(adminFlagged, reporting),
        cisAvgPassRate: null,
        mfaIdentityConnected: Boolean(m365 || google),
        backupConfigured: Boolean(backup || c2c),
        backupEncrypted: backup ? Boolean(backup.encryption) : null,
        dnsFilteringActive: Boolean(dns)
      },
      privilegedAccess: {
        uacInterceptionEnabled: Boolean(pamCfg?.uacInterceptionEnabled),
        activePamRules: pamRuleRows.length,
        elevationsInWindow: elevationRows.length,
        elevationsApproved,
        elevationsDenied,
        mfaStepUpEnforced
      },
      securityProducts,
      postureScore: postureRow?.overallScore ?? null
    }
  };
}

function prettyDnsProvider(p: string): string {
  const map: Record<string, string> = {
    cisco_umbrella: 'Cisco Umbrella',
    cloudflare: 'Cloudflare Gateway',
    dnsfilter: 'DNSFilter',
    pihole: 'Pi-hole',
    opendns: 'OpenDNS',
    quad9: 'Quad9',
    adguard_home: 'AdGuard Home'
  };
  return map[p] ?? `DNS filtering (${p})`;
}

function emptySummary(orgRow: { id: string; name: string } | undefined, generatedAt: string) {
  return {
    org: { id: orgRow?.id ?? '', name: orgRow?.name ?? 'Unknown' },
    generatedAt,
    deviceCount: 0,
    controls: {
      edrCoveragePct: 0,
      anyAvCoveragePct: 0,
      unprotectedCount: 0,
      encryptionPct: 0,
      firewallPct: 0,
      patchCurrentPct: 0,
      passwordComplexityPct: 0,
      localAdminExposurePct: 0,
      cisAvgPassRate: null,
      mfaIdentityConnected: false,
      backupConfigured: false,
      backupEncrypted: null,
      dnsFilteringActive: false
    },
    privilegedAccess: {
      uacInterceptionEnabled: false,
      activePamRules: 0,
      elevationsInWindow: 0,
      elevationsApproved: 0,
      elevationsDenied: 0,
      mfaStepUpEnforced: false
    },
    securityProducts: [],
    postureScore: null
  };
}
```

> Column-name caveat: verify each imported table's exact column identifiers against its schema file before relying on them (e.g. `devices.osType` may be `osType` or `os_type`→`osType` in Drizzle; `deviceVulnerabilities.vulnerabilityId`; `backupConfigs.encryption`; `googleWorkspaceConnections` export name in `schema/google.ts`). The grep in Task 3 Step 1 plus `grep -nE "export const|: (uuid|varchar|boolean|integer|jsonb|timestamp)\(" <schemafile>` gives the real names. Fix imports/selects to match — do not invent columns.

- [ ] **Step 4: Run the generator tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/securityComplianceReport.test.ts`
Expected: PASS — all six cases green. If a select-order assertion fails, align `mockGeneratorQueries`'s sequence comment with the actual call order in the implementation (the order is the contract between test and code).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/securityComplianceReport.ts apps/api/src/services/securityComplianceReport.test.ts
git commit -m "feat(api): security & compliance posture report generator"
```

---

## Task 5: Wire the generator into the dispatcher

**Files:**
- Modify: `apps/api/src/services/reportGenerationService.ts`
- Test: `apps/api/src/routes/reports.test.ts` (add one case)

**Interfaces:**
- Consumes: `generateSecurityCompliancePostureReport` (Task 4).
- Produces: `generateReport('security_compliance_posture', …)` routes to the new generator; `ReportType` union includes the new label.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/reports.test.ts`, add:

```ts
import { generateReport } from '../services/reportGenerationService';

describe('generateReport dispatch — security_compliance_posture', () => {
  it('routes to the posture generator', async () => {
    const spy = vi.spyOn(
      await import('../services/securityComplianceReport'),
      'generateSecurityCompliancePostureReport'
    ).mockResolvedValue({ rows: [], rowCount: 0, summary: {} as any, generatedAt: 'x' });
    await generateReport('security_compliance_posture' as any, 'org-1', {}, undefined);
    expect(spy).toHaveBeenCalledWith('org-1', {}, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/reports.test.ts -t "security_compliance_posture"`
Expected: FAIL — `Invalid report type` thrown by the dispatcher's default case.

- [ ] **Step 3: Add the union member + dispatch case**

In `apps/api/src/services/reportGenerationService.ts`:

(a) Add to the `ReportType` union:

```ts
export type ReportType =
  | 'device_inventory'
  | 'software_inventory'
  | 'alert_summary'
  | 'compliance'
  | 'performance'
  | 'executive_summary'
  | 'security_compliance_posture';
```

(b) Import and add the case in `generateReport`:

```ts
import { generateSecurityCompliancePostureReport } from './securityComplianceReport';
// ...
    case 'security_compliance_posture':
      return generateSecurityCompliancePostureReport(orgId, config, perms);
```

> Watch for an import cycle: `securityComplianceReport.ts` imports `resolveSiteAllowedDeviceIds` and `type ReportResult` from `reportGenerationService.ts`, and this file now imports the generator from it. Type-only imports don't cycle at runtime; the value import (`generateSecurityCompliancePostureReport`) is fine because it's referenced lazily inside `generateReport`. If Node ESM complains, move the dispatcher's import to a dynamic `await import('./securityComplianceReport')` inside the case.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/reports.test.ts`
Expected: PASS — new dispatch case + all existing report cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/reportGenerationService.ts apps/api/src/routes/reports.test.ts
git commit -m "feat(api): dispatch security_compliance_posture to its generator"
```

---

## Task 6: Web — builder option, template, and PDF rendering

**Files:**
- Modify: the report-type option list consumed by `ReportBuilder.tsx` (find it in Step 1)
- Modify: `apps/web/src/components/reports/ReportTemplates.tsx`
- Modify: `apps/web/src/components/reports/reportExport.ts`
- Test: `apps/web/src/components/reports/reportExport.posture.test.tsx` (NEW)

**Interfaces:**
- Consumes: the `{ type:'security_compliance_posture', format:'pdf', data: { rows, summary } }` snapshot the download endpoint returns.
- Produces: a builder option, a curated template, and a `reportExport` PDF branch that renders the posture summary cover + sections.

- [ ] **Step 1: Locate the report-type registry and PDF entry point**

Run: `grep -rnE "executive_summary|reportType|ReportTypeOption|case 'compliance'" apps/web/src/components/reports/ | grep -vE "test"`
Expected: shows where report types are enumerated for the builder and how `reportExport.ts` switches on type for PDF. Mirror those patterns.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/components/reports/reportExport.posture.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { exportReport } from './reportExport';

vi.mock('jspdf', () => {
  const calls: string[] = [];
  const docMock = {
    text: (t: string) => { calls.push(String(t)); return docMock; },
    setFontSize: () => docMock,
    setFont: () => docMock,
    addPage: () => docMock,
    save: () => {},
    splitTextToSize: (t: string) => [t],
    autoTable: () => docMock,
    internal: { pageSize: { getWidth: () => 595, getHeight: () => 842 } },
    lastAutoTable: { finalY: 100 },
    __calls: calls
  };
  return { default: vi.fn(() => docMock), jsPDF: vi.fn(() => docMock) };
});

describe('exportReport — security_compliance_posture PDF', () => {
  it('renders the posture summary without throwing and prints control percentages', () => {
    const summary = {
      org: { id: 'o1', name: 'Acme Co' },
      generatedAt: '2026-06-29T00:00:00Z',
      deviceCount: 3,
      controls: {
        edrCoveragePct: 67, anyAvCoveragePct: 67, unprotectedCount: 1,
        encryptionPct: 100, firewallPct: 100, patchCurrentPct: 67,
        passwordComplexityPct: 50, localAdminExposurePct: 0, cisAvgPassRate: null,
        mfaIdentityConnected: true, backupConfigured: true, backupEncrypted: true,
        dnsFilteringActive: true
      },
      privilegedAccess: {
        uacInterceptionEnabled: true, activePamRules: 2, elevationsInWindow: 4,
        elevationsApproved: 3, elevationsDenied: 1, mfaStepUpEnforced: true
      },
      securityProducts: [{ product: 'Huntress', category: 'mdr', active: true, lastSyncStatus: null, deviceCoverage: 2 }],
      postureScore: 82
    };
    expect(() =>
      exportReport(
        [{ hostname: 'pc-1', protection: 'Huntress (RTP on)' }],
        { format: 'pdf', reportType: 'security_compliance_posture', summary } as any
      )
    ).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @breeze/web test -- reportExport.posture`
Expected: FAIL — `exportReport` has no `security_compliance_posture` branch / ignores `summary`.

- [ ] **Step 4: Add the PDF branch + builder option + template**

(a) In `reportExport.ts`, accept an optional `summary` in the options type and add a posture branch that, when `reportType === 'security_compliance_posture'` and `summary` is present, renders: a cover (org name, generatedAt, postureScore), a control-coverage block (loop the `controls` object into "Label: NN%"), a privileged-access block, a security-products table, then the per-device `rows` table (reuse the existing table renderer). Keep it defensive — every field optional-chained. Skeleton:

```ts
function renderPosturePdf(doc: jsPDF, rows: unknown[], summary: PostureSummary): void {
  let y = 60;
  doc.setFontSize(18).text(`Security & Compliance Posture — ${summary.org?.name ?? ''}`, 40, y);
  y += 24;
  doc.setFontSize(10).text(`Generated ${new Date(summary.generatedAt ?? Date.now()).toLocaleString()}`, 40, y);
  if (summary.postureScore != null) { y += 16; doc.text(`Overall posture score: ${summary.postureScore}/100`, 40, y); }

  y += 28; doc.setFontSize(13).text('Control coverage', 40, y);
  const c = summary.controls ?? ({} as PostureSummary['controls']);
  const lines = [
    `Managed EDR coverage: ${c.edrCoveragePct ?? 0}%`,
    `Any AV + real-time protection: ${c.anyAvCoveragePct ?? 0}%`,
    `Unprotected devices: ${c.unprotectedCount ?? 0}`,
    `Disk encryption: ${c.encryptionPct ?? 0}%`,
    `Host firewall: ${c.firewallPct ?? 0}%`,
    `Patch current (no critical pending): ${c.patchCurrentPct ?? 0}%`,
    `Password complexity: ${c.passwordComplexityPct ?? 0}%`,
    `Local-admin exposure (devices over threshold): ${c.localAdminExposurePct ?? 0}%`,
    `MFA / identity connected: ${c.mfaIdentityConnected ? 'Yes' : 'No'}`,
    `Backup configured: ${c.backupConfigured ? 'Yes' : 'No'}${c.backupEncrypted ? ' (encrypted)' : ''}`,
    `DNS filtering active: ${c.dnsFilteringActive ? 'Yes' : 'No'}`,
    `Hardening (CIS): ${c.cisAvgPassRate == null ? 'Not yet assessed' : c.cisAvgPassRate + '%'}`
  ];
  doc.setFontSize(10);
  for (const l of lines) { y += 14; doc.text(l, 48, y); }

  const p = summary.privilegedAccess;
  if (p) {
    y += 26; doc.setFontSize(13).text('Privileged access (PAM)', 40, y);
    doc.setFontSize(10);
    for (const l of [
      `UAC interception: ${p.uacInterceptionEnabled ? 'Enabled' : 'Disabled'}`,
      `Active PAM rules: ${p.activePamRules}`,
      `Elevations (window): ${p.elevationsInWindow} — ${p.elevationsApproved} approved / ${p.elevationsDenied} denied`,
      `MFA step-up enforced: ${p.mfaStepUpEnforced ? 'Yes' : 'No'}`
    ]) { y += 14; doc.text(l, 48, y); }
  }

  // security products + per-device detail via the existing autoTable renderer
  doc.addPage();
  // ...reuse existing renderTable(doc, rows) helper for the device table...
}
```

Wire it into the existing `exportReport` PDF switch so `reportType === 'security_compliance_posture'` calls `renderPosturePdf` when `options.summary` is present, else falls back to the plain table.

(b) In the builder's report-type option list (located in Step 1), add:

```ts
{ value: 'security_compliance_posture', label: 'Security & Compliance Posture',
  description: 'Insurance/vetting-ready: EDR, encryption, firewall, patching, vulns, PAM, integrations',
  columns: ['hostname', 'site', 'os', 'protection', 'encryption', 'firewall', 'pendingPatches', 'openVulnCritical'] }
```

(c) In `ReportTemplates.tsx`, add a curated template entry that targets `type: 'security_compliance_posture'`, `format: 'pdf'`, named "Security & Compliance Posture (Insurance)".

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @breeze/web test -- reportExport.posture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/reports/
git commit -m "feat(web): security & compliance posture builder option, template, and PDF"
```

---

## Task 7: Full verification

- [ ] **Step 1: API + web suites**

Run: `pnpm --filter @breeze/api test -- reports security && pnpm --filter @breeze/web test -- reports reportExport`
Expected: all PASS.

- [ ] **Step 2: Type-check (CI parity — tsc compiles tests)**

Run: `pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/web exec astro check`
Expected: no type errors. Watch for `arr[0]` non-null access (use `arr[0]!` or optional-chain) and unused imports.

- [ ] **Step 3: Schema drift**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift.

- [ ] **Step 4: RLS sanity (real DB)**

The generator only reads org-scoped tables through the request DB-access context; no new tables are created, so no RLS allowlist change is needed. Confirm the integration RLS contract still passes:

Run: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts rls-coverage`
Expected: PASS (unchanged — no new tables).

- [ ] **Step 5: Manual smoke (optional, needs running stack)**

Create a report of type "Security & Compliance Posture (Insurance)", format PDF, for an org with some devices reporting `security_status` and a Huntress/S1 integration. Click Generate → confirm Completed with a row count. Click Download → confirm the PDF shows the control-coverage cover, the privileged-access section, the security-products list, and the per-device table; confirm CSV/Excel download produces the per-device rows. Verify a device with no `security_status` row appears as "No data" and counts toward `unprotectedCount`.

---

## Self-Review Notes

- **Spec coverage:** §2 data sources → Task 4 queries (security_status, EDR agents, patches, vulns, integrations, PAM). §3 result shape → Task 4 return value. §4 EDR merge → Task 4 `protectionLabel` + managed/native counters + unprotected list. §5 scoring (CIS bonus, direct computation) → Task 4 `cisAvgPassRate: null` + `pct()` over `reporting`. §6 implementation surface → Tasks 1/2/5/6. §8 PDF template → Task 6. §7 data gaps → rendered "Not yet assessed" (Task 6 line) + "No data" rows (Task 4).
- **Partner-scope:** EDR per-device coverage uses the denormalized `orgId` on `s1_agents`/`huntress_agents` (no mapping join needed); `authenticator_policies` correctly resolved via `organizations.partnerId` (Task 4 step 3).
- **No silent truncation:** devices without `security_status` are "No data" and counted unprotected; CIS renders "Not yet assessed," never 0%.
- **Enum-add safety:** the `ALTER TYPE ADD VALUE` migration is value-only, isolated in its own file (Task 1).
- **Known deferral:** per-device CIS pass-rate (`cisPassRate`/`cisAvgPassRate`) is stubbed `null` in v1 — wiring `cis_baseline_results.findings` aggregation is a clean follow-up that needs no schema or report-shape change (the fields already exist in the result).
- **Open spec questions** (§9: per-org vs partner-wide, threshold defaults, disclaimer wording) do not block this plan — defaults are encoded in Task 2's config schema; partner-wide rollup would be a separate report type.

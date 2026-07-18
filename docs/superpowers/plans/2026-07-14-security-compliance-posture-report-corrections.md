# Security & Compliance Posture Report Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make posture-report vulnerability counts tenant-safe and accurate, make backup an explicit optional requirement, and render a complete deduplicated security-product inventory.

**Architecture:** Split the global CVE catalog read from the tenant finding read, then merge and normalize severity in a focused API helper. Build product inventory through a pure evidence aggregator, carry `backupRequired` through API/shared/web layers, and return cover-page product overflow to a continuation-page renderer before per-device detail.

**Tech Stack:** TypeScript, Hono, Drizzle ORM/PostgreSQL RLS, Zod, React, Vitest, jsPDF, pnpm/Turbo.

## Global Constraints

- Preserve the request-path tenant context for every tenant-scoped read; only the global `vulnerabilities` catalog may use `runOutsideDbContext` plus `withSystemDbAccessContext`.
- Do not change the posture score or its weights.
- New posture-template reports explicitly default `backupRequired` to `false`; missing persisted values mean required for backward compatibility.
- Optional backup remains visible as neutral evidence and never creates a recommendation.
- Product coverage is the union of unique in-scope device IDs; duplicate sources must not inflate it.
- Every summary product must appear in the PDF on the cover or a continuation page.
- No database migration is required; report config and summaries are JSON.
- Keep the template-duplication and Technician Activity mapping issues out of this change.
- Follow test-driven development: add one failing behavior test, verify the expected failure, implement the minimum change, and rerun before proceeding.

---

## File structure

**Create**

- `apps/api/src/services/securityComplianceReportVulnerabilities.ts` - tenant/system split loader plus severity aggregation.
- `apps/api/src/services/securityComplianceReportVulnerabilities.test.ts` - mixed-case, lifecycle, and incomplete-catalog unit coverage.
- `apps/api/src/services/securityComplianceReportProducts.ts` - pure product normalization, categorization, deduplication, and coverage aggregation.
- `apps/api/src/services/securityComplianceReportProducts.test.ts` - endpoint/managed product evidence coverage.
- `apps/api/src/__tests__/integration/securityComplianceReport.integration.test.ts` - real-Postgres tenant isolation and report-count regression.
- `apps/web/src/components/reports/PostureReportOptionsForm.tsx` - shared backup-requirement control for create and edit paths.
- `apps/web/src/components/reports/ReportEditPage.posture.test.tsx` - posture config preservation regression.

**Modify**

- `apps/api/src/services/securityComplianceReport.ts` - consume both helpers and emit `backupRequired`.
- `apps/api/src/services/securityComplianceReport.test.ts` - generator contract, query sequence, backup, and inventory assertions.
- `apps/api/src/routes/reports/schemas.ts` - accept and default `backupRequired` correctly.
- `apps/api/src/routes/reports/schemas.security.test.ts` - config validation/defaults.
- `apps/api/src/routes/reports/schemas.config.test.ts` - create/update preservation.
- `packages/shared/src/types/postureReport.ts` - persisted control field and `antivirus` category.
- `packages/shared/src/reportPdf/reportPdf.ts` - optional-backup presentation and non-truncating product pagination.
- `packages/shared/src/reportPdf/reportPdf.test.ts` - recommendation and product continuation assertions.
- `apps/web/src/components/reports/ReportTemplates.tsx` - posture-options step and explicit create config.
- `apps/web/src/components/reports/ReportTemplates.posture.test.tsx` - default/opt-in create payloads.
- `apps/web/src/components/reports/ReportEditPage.tsx` - posture-specific edit path that merges existing config.
- `apps/web/src/locales/en/reports.json`
- `apps/web/src/locales/es-419/reports.json`
- `apps/web/src/locales/de-DE/reports.json`
- `apps/web/src/locales/fr-FR/reports.json`
- `apps/web/src/locales/pt-BR/reports.json`
- `apps/docs/src/content/docs/features/reports.mdx` - document the backup requirement and compatibility behavior.

---

### Task 1: Tenant-safe vulnerability count loader

**Files:**

- Create: `apps/api/src/services/securityComplianceReportVulnerabilities.ts`
- Create: `apps/api/src/services/securityComplianceReportVulnerabilities.test.ts`

**Interfaces:**

- Produces: `loadOpenVulnerabilityCounts(deviceIds: string[]): Promise<Map<string, DeviceVulnerabilityCounts>>`
- Produces: `aggregateVulnerabilityCounts(findings, catalogRows): Map<string, DeviceVulnerabilityCounts>`
- `DeviceVulnerabilityCounts` is `{ critical: number; high: number }`.

- [ ] **Step 1: Write failing pure aggregation tests**

Create the test with actual source casing and an incomplete catalog case:

```ts
import { describe, expect, it } from 'vitest';
import { aggregateVulnerabilityCounts } from './securityComplianceReportVulnerabilities';

describe('aggregateVulnerabilityCounts', () => {
  it('normalizes source severity casing and counts findings per device', () => {
    const counts = aggregateVulnerabilityCounts(
      [
        { deviceId: 'd1', vulnerabilityId: 'v1' },
        { deviceId: 'd1', vulnerabilityId: 'v2' },
        { deviceId: 'd2', vulnerabilityId: 'v3' },
        { deviceId: 'd2', vulnerabilityId: 'v4' },
      ],
      [
        { id: 'v1', severity: 'HIGH' },
        { id: 'v2', severity: 'Critical' },
        { id: 'v3', severity: 'High' },
        { id: 'v4', severity: 'CRITICAL' },
      ],
    );

    expect(counts.get('d1')).toEqual({ high: 1, critical: 1 });
    expect(counts.get('d2')).toEqual({ high: 1, critical: 1 });
  });

  it('fails instead of publishing zeroes when referenced catalog rows are missing', () => {
    expect(() =>
      aggregateVulnerabilityCounts(
        [{ deviceId: 'd1', vulnerabilityId: 'missing' }],
        [],
      ),
    ).toThrow('Vulnerability catalog lookup incomplete');
  });
});
```

- [ ] **Step 2: Run the new unit test and verify RED**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/services/securityComplianceReportVulnerabilities.test.ts
```

Expected: FAIL because `securityComplianceReportVulnerabilities.ts` does not exist.

- [ ] **Step 3: Implement the pure aggregation and two-phase loader**

Create `securityComplianceReportVulnerabilities.ts` with these exact public contracts and query boundaries:

```ts
import { and, eq, inArray } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceVulnerabilities, vulnerabilities } from '../db/schema';

export type DeviceVulnerabilityCounts = { critical: number; high: number };

type FindingRow = { deviceId: string; vulnerabilityId: string };
type CatalogRow = { id: string; severity: string | null };

export function aggregateVulnerabilityCounts(
  findings: FindingRow[],
  catalogRows: CatalogRow[],
): Map<string, DeviceVulnerabilityCounts> {
  const catalogById = new Map(catalogRows.map((row) => [row.id, row]));
  const missingIds = [...new Set(
    findings
      .map((finding) => finding.vulnerabilityId)
      .filter((id) => !catalogById.has(id)),
  )];
  if (missingIds.length > 0) {
    throw new Error(
      `Vulnerability catalog lookup incomplete: ${missingIds.length} referenced record(s) missing`,
    );
  }

  const counts = new Map<string, DeviceVulnerabilityCounts>();
  for (const finding of findings) {
    const severity = catalogById.get(finding.vulnerabilityId)?.severity?.toLowerCase();
    if (severity !== 'critical' && severity !== 'high') continue;
    const current = counts.get(finding.deviceId) ?? { critical: 0, high: 0 };
    current[severity] += 1;
    counts.set(finding.deviceId, current);
  }
  return counts;
}

export async function loadOpenVulnerabilityCounts(
  deviceIds: string[],
): Promise<Map<string, DeviceVulnerabilityCounts>> {
  if (deviceIds.length === 0) return new Map();

  const findings = await db
    .select({
      deviceId: deviceVulnerabilities.deviceId,
      vulnerabilityId: deviceVulnerabilities.vulnerabilityId,
    })
    .from(deviceVulnerabilities)
    .where(and(
      inArray(deviceVulnerabilities.deviceId, deviceIds),
      eq(deviceVulnerabilities.status, 'open'),
    ));

  const vulnerabilityIds = [...new Set(findings.map((row) => row.vulnerabilityId))];
  if (vulnerabilityIds.length === 0) return new Map();

  const catalogRows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: vulnerabilities.id, severity: vulnerabilities.severity })
        .from(vulnerabilities)
        .where(inArray(vulnerabilities.id, vulnerabilityIds)),
    ),
  );

  return aggregateVulnerabilityCounts(findings, catalogRows);
}
```

- [ ] **Step 4: Rerun the focused test and verify GREEN**

Run the same Vitest command. Expected: 2 tests PASS.

- [ ] **Step 5: Commit the isolated loader**

```bash
git add apps/api/src/services/securityComplianceReportVulnerabilities.ts apps/api/src/services/securityComplianceReportVulnerabilities.test.ts
git commit -m "fix(reports): load vulnerability counts across RLS contexts"
```

---

### Task 2: Integrate vulnerability counts and prove tenant isolation

**Files:**

- Modify: `apps/api/src/services/securityComplianceReport.ts:1-527`
- Modify: `apps/api/src/services/securityComplianceReport.test.ts:1-300`
- Create: `apps/api/src/__tests__/integration/securityComplianceReport.integration.test.ts`

**Interfaces:**

- Consumes: `loadOpenVulnerabilityCounts(deviceIds)` from Task 1.
- Produces: unchanged report row fields `openVulnCritical` and `openVulnHigh`, now populated from the tenant-safe loader.

- [ ] **Step 1: Add a failing generator contract test**

Use a hoisted mock so the report unit test no longer relies on an impossible tenant/system join:

```ts
const vulnerabilityMocks = vi.hoisted(() => ({
  loadOpenVulnerabilityCounts: vi.fn(),
}));

vi.mock('./securityComplianceReportVulnerabilities', () => vulnerabilityMocks);
```

In `beforeEach`, set:

```ts
vulnerabilityMocks.loadOpenVulnerabilityCounts.mockResolvedValue(
  new Map([
    ['dev-1', { high: 2, critical: 1 }],
    ['dev-2', { high: 1, critical: 0 }],
  ]),
);
```

Add:

```ts
it('places tenant-safe open vulnerability counts into per-device rows', async () => {
  mockGeneratorQueries();
  const result = await generateSecurityCompliancePostureReport(ORG, {});
  const rows = Object.fromEntries((result.rows as any[]).map((row) => [row.hostname, row]));

  expect(vulnerabilityMocks.loadOpenVulnerabilityCounts).toHaveBeenCalledWith([
    'dev-1',
    'dev-2',
    'dev-3',
  ]);
  expect(rows['pc-1']).toMatchObject({ openVulnHigh: 2, openVulnCritical: 1 });
  expect(rows['pc-2']).toMatchObject({ openVulnHigh: 1, openVulnCritical: 0 });
});
```

Remove the old `device_vulns` result from `mockGeneratorQueries` and renumber its documented select sequence so the remaining Drizzle mocks stay aligned.

- [ ] **Step 2: Verify the generator test fails for the expected reason**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/services/securityComplianceReport.test.ts
```

Expected: the new test FAILS because the generator still performs the direct join and never calls the helper.

- [ ] **Step 3: Replace the direct join with the loader**

In `securityComplianceReport.ts`:

```ts
import { loadOpenVulnerabilityCounts } from './securityComplianceReportVulnerabilities';
```

Delete the direct `deviceVulnerabilities`/`vulnerabilities` joined select and its counting loop. After `deviceIds` is known, use:

```ts
const vulnByDevice = await loadOpenVulnerabilityCounts(deviceIds);
```

Remove the now-unused schema imports. Keep the row mapping unchanged:

```ts
const vuln = vulnByDevice.get(d.id) ?? { critical: 0, high: 0 };
```

- [ ] **Step 4: Rerun the generator unit suite**

Expected: all `securityComplianceReport.test.ts` tests PASS with the corrected select sequence.

- [ ] **Step 5: Write the real-Postgres cross-tenant regression test**

Create `apps/api/src/__tests__/integration/securityComplianceReport.integration.test.ts`. Use `setupTestEnvironment`, insert one device and one open finding in each of two organizations, and store catalog severities with different casing. Run the report inside organization A's context:

```ts
import './setup';

import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices, deviceVulnerabilities, vulnerabilities } from '../../db/schema';
import { generateSecurityCompliancePostureReport } from '../../services/securityComplianceReport';
import { setupTestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('security compliance report vulnerability isolation', () => {
  runDb('counts its own open catalog findings and excludes another organization', async () => {
    const envA = await setupTestEnvironment({ scope: 'organization' });
    const envB = await setupTestEnvironment({ scope: 'organization' });

    const seeded = await withSystemDbAccessContext(async () => {
      const [deviceA, deviceB] = await db.insert(devices).values([
        {
          orgId: envA.organization.id,
          siteId: envA.site.id,
          agentId: `posture-a-${Date.now()}`,
          hostname: 'posture-a',
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: 'test',
          status: 'offline',
        },
        {
          orgId: envB.organization.id,
          siteId: envB.site.id,
          agentId: `posture-b-${Date.now()}`,
          hostname: 'posture-b',
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: 'test',
          status: 'offline',
        },
      ]).returning({ id: devices.id, orgId: devices.orgId });

      const [catalogA, catalogB, patchedCatalog, mitigatedCatalog, acceptedCatalog] = await db.insert(vulnerabilities).values([
        { cveId: 'CVE-2026-71001', source: 'nvd', severity: 'HIGH', rawPayload: {} },
        { cveId: 'CVE-2026-71002', source: 'msrc', severity: 'Critical', rawPayload: {} },
        { cveId: 'CVE-2026-71003', source: 'nvd', severity: 'CRITICAL', rawPayload: {} },
        { cveId: 'CVE-2026-71004', source: 'nvd', severity: 'CRITICAL', rawPayload: {} },
        { cveId: 'CVE-2026-71005', source: 'nvd', severity: 'CRITICAL', rawPayload: {} },
      ]).returning({ id: vulnerabilities.id });

      await db.insert(deviceVulnerabilities).values([
        {
          orgId: envA.organization.id,
          deviceId: deviceA!.id,
          vulnerabilityId: catalogA!.id,
          status: 'open',
          detectedAt: new Date(),
        },
        {
          orgId: envB.organization.id,
          deviceId: deviceB!.id,
          vulnerabilityId: catalogB!.id,
          status: 'open',
          detectedAt: new Date(),
        },
        {
          orgId: envA.organization.id,
          deviceId: deviceA!.id,
          vulnerabilityId: patchedCatalog!.id,
          status: 'patched',
          detectedAt: new Date(),
        },
        {
          orgId: envA.organization.id,
          deviceId: deviceA!.id,
          vulnerabilityId: mitigatedCatalog!.id,
          status: 'mitigated',
          detectedAt: new Date(),
        },
        {
          orgId: envA.organization.id,
          deviceId: deviceA!.id,
          vulnerabilityId: acceptedCatalog!.id,
          status: 'accepted',
          detectedAt: new Date(),
        },
      ]);

      return { deviceA: deviceA!.id };
    });

    const result = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: envA.organization.id,
        accessibleOrgIds: [envA.organization.id],
        userId: envA.user.id,
      },
      () => generateSecurityCompliancePostureReport(envA.organization.id, { includeCis: false }),
    );

    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostname: 'posture-a',
        openVulnHigh: 1,
        openVulnCritical: 0,
      }),
    ]));
    expect(result.rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ hostname: 'posture-b' }),
    ]));
    expect(seeded.deviceA).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run the integration test**

Run:

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/securityComplianceReport.integration.test.ts
```

Expected: PASS when `DATABASE_URL` is available; otherwise the test is explicitly skipped.

- [ ] **Step 7: Commit the generator integration**

```bash
git add apps/api/src/services/securityComplianceReport.ts apps/api/src/services/securityComplianceReport.test.ts apps/api/src/__tests__/integration/securityComplianceReport.integration.test.ts
git commit -m "fix(reports): count posture vulnerabilities accurately"
```

---

### Task 3: Canonical security-product aggregation

**Files:**

- Create: `apps/api/src/services/securityComplianceReportProducts.ts`
- Create: `apps/api/src/services/securityComplianceReportProducts.test.ts`
- Modify: `apps/api/src/services/securityComplianceReport.ts:49-524`
- Modify: `apps/api/src/services/securityComplianceReport.test.ts:200-290`
- Modify: `packages/shared/src/types/postureReport.ts:16-24`

**Interfaces:**

- Produces: `SecurityProductEvidence` with optional `deviceIds`.
- Produces: `buildSecurityProductInventory(evidence): PostureProduct[]`.
- Produces: `prettySecurityProvider(provider)` and `categoryForEndpointProvider(provider)`.

- [ ] **Step 1: Write failing product aggregation tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildSecurityProductInventory } from './securityComplianceReportProducts';

describe('buildSecurityProductInventory', () => {
  it('includes native Defender and endpoint-only SentinelOne', () => {
    const result = buildSecurityProductInventory([
      { product: 'Defender', category: 'antivirus', active: true, deviceIds: ['d1', 'd2'] },
      { product: 'SentinelOne', category: 'edr', active: true, deviceIds: ['d3'] },
    ]);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ product: 'Defender', category: 'antivirus', deviceCoverage: 2 }),
      expect.objectContaining({ product: 'SentinelOne', category: 'edr', deviceCoverage: 1 }),
    ]));
  });

  it('deduplicates managed and endpoint evidence by unique device id', () => {
    const [sentinelOne] = buildSecurityProductInventory([
      { product: 'SentinelOne', category: 'edr', active: true, deviceIds: ['d1', 'd2'] },
      { product: 'sentinel one', category: 'edr', active: false, deviceIds: ['d2', 'd3'] },
    ]);
    expect(sentinelOne).toMatchObject({
      product: 'SentinelOne',
      active: true,
      deviceCoverage: 3,
    });
  });

  it('keeps RTP-off endpoint evidence visible as inactive', () => {
    expect(buildSecurityProductInventory([
      { product: 'Defender', category: 'antivirus', active: false, deviceIds: ['d1'] },
    ])).toEqual([
      expect.objectContaining({ product: 'Defender', active: false, deviceCoverage: 1 }),
    ]);
  });
});
```

- [ ] **Step 2: Run the product test and verify RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/securityComplianceReportProducts.test.ts
```

Expected: FAIL because the product module and `antivirus` category do not exist.

- [ ] **Step 3: Add the shared category and implement the pure aggregator**

Change the shared union:

```ts
export type PostureProductCategory =
  | 'antivirus'
  | 'edr'
  | 'mdr'
  | 'dns_filtering'
  | 'backup'
  | 'identity';
```

Create the API module with deterministic ordering and union coverage:

```ts
import type { PostureProduct, PostureProductCategory } from '@breeze/shared';

export type SecurityProductEvidence = Omit<PostureProduct, 'deviceCoverage'> & {
  deviceIds?: Iterable<string>;
};

const PROVIDER_NAMES: Record<string, string> = {
  windows_defender: 'Defender',
  sentinelone: 'SentinelOne',
  crowdstrike: 'CrowdStrike',
  bitdefender: 'Bitdefender',
  sophos: 'Sophos',
  malwarebytes: 'Malwarebytes',
  eset: 'ESET',
  kaspersky: 'Kaspersky',
  elastic_defend: 'Elastic Defend',
};

const EDR_PROVIDERS = new Set(['sentinelone', 'crowdstrike', 'elastic_defend']);
const CATEGORY_ORDER: PostureProductCategory[] = [
  'mdr',
  'edr',
  'antivirus',
  'dns_filtering',
  'backup',
  'identity',
];

export function prettySecurityProvider(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

export function categoryForEndpointProvider(provider: string): 'edr' | 'antivirus' {
  return EDR_PROVIDERS.has(provider) ? 'edr' : 'antivirus';
}

const productKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function buildSecurityProductInventory(
  evidence: SecurityProductEvidence[],
): PostureProduct[] {
  const merged = new Map<string, {
    product: string;
    category: PostureProductCategory;
    active: boolean;
    lastSyncStatus: string | null;
    deviceIds: Set<string> | null;
  }>();

  for (const item of evidence) {
    const key = productKey(item.product);
    const current = merged.get(key);
    const ids = item.deviceIds ? new Set(item.deviceIds) : null;
    if (!current) {
      merged.set(key, {
        product: item.product,
        category: item.category,
        active: item.active,
        lastSyncStatus: item.lastSyncStatus ?? null,
        deviceIds: ids,
      });
      continue;
    }
    current.active ||= item.active;
    current.lastSyncStatus ??= item.lastSyncStatus ?? null;
    if (ids) {
      current.deviceIds ??= new Set();
      for (const id of ids) current.deviceIds.add(id);
    }
  }

  return [...merged.values()]
    .map((item) => ({
      product: item.product,
      category: item.category,
      active: item.active,
      lastSyncStatus: item.lastSyncStatus,
      deviceCoverage: item.deviceIds?.size ?? null,
    }))
    .sort((a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
      || a.product.localeCompare(b.product),
    );
}
```

- [ ] **Step 4: Rerun the product tests**

Expected: all 3 tests PASS.

- [ ] **Step 5: Add a failing generator inventory test**

Extend the existing generator fixture so Defender is observed on four scoped devices, SentinelOne is both managed and observed on overlapping devices, and Huntress is managed. Assert exact unique coverage and one row per normalized product:

```ts
it('lists native and managed products once with unique scoped coverage', async () => {
  mockGeneratorQueries({
    3: [
      { deviceId: 'dev-1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
      { deviceId: 'dev-2', provider: 'sentinelone', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
      { deviceId: 'dev-3', provider: 'sentinelone', realTimeProtection: false, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
    ],
    4: [{ deviceId: 'dev-2' }, { deviceId: 'dev-3' }],
  });

  const summary = (await generateSecurityCompliancePostureReport(ORG, {})).summary as any;
  expect(summary.securityProducts.filter((p: any) => p.product === 'SentinelOne')).toEqual([
    expect.objectContaining({ category: 'edr', deviceCoverage: 2, active: true }),
  ]);
  expect(summary.securityProducts).toContainEqual(
    expect.objectContaining({ product: 'Defender', category: 'antivirus', deviceCoverage: 1 }),
  );
});
```

- [ ] **Step 6: Build evidence in the generator and use the aggregator**

Move provider display/category logic to the product module. Build `SecurityProductEvidence[]` in this order: Huntress managed evidence, SentinelOne managed evidence, every scoped non-`other` security-status row, then org integrations. Managed evidence is inserted first so its canonical name/category wins when later endpoint evidence merges into the same key. Then call:

```ts
const securityProducts = buildSecurityProductInventory(productEvidence);
```

For native rows, use:

```ts
productEvidence.push({
  product: prettySecurityProvider(row.provider),
  category: categoryForEndpointProvider(row.provider),
  active: row.realTimeProtection === true,
  lastSyncStatus: null,
  deviceIds: [row.deviceId],
});
```

Keep provider `other` out. Use the same `prettySecurityProvider` function in `protectionLabel` so row labels and inventory names cannot diverge.

- [ ] **Step 7: Run API and shared typechecks/tests**

```bash
pnpm --filter @breeze/api exec vitest run src/services/securityComplianceReportProducts.test.ts src/services/securityComplianceReport.test.ts
pnpm --filter @breeze/shared typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit product aggregation**

```bash
git add apps/api/src/services/securityComplianceReportProducts.ts apps/api/src/services/securityComplianceReportProducts.test.ts apps/api/src/services/securityComplianceReport.ts apps/api/src/services/securityComplianceReport.test.ts packages/shared/src/types/postureReport.ts
git commit -m "fix(reports): include all detected security products"
```

---

### Task 4: Backup requirement contract and neutral PDF behavior

**Files:**

- Modify: `apps/api/src/routes/reports/schemas.ts:15-132`
- Modify: `apps/api/src/routes/reports/schemas.security.test.ts`
- Modify: `apps/api/src/routes/reports/schemas.config.test.ts`
- Modify: `apps/api/src/services/securityComplianceReport.ts:101-527`
- Modify: `apps/api/src/services/securityComplianceReport.test.ts`
- Modify: `packages/shared/src/types/postureReport.ts:26-48`
- Modify: `packages/shared/src/reportPdf/reportPdf.ts:576-704`
- Modify: `packages/shared/src/reportPdf/reportPdf.test.ts`

**Interfaces:**

- Produces config: `backupRequired: boolean`, generation default `true`.
- Produces persisted summary: `controls.backupRequired?: boolean`.
- PDF compatibility rule: `controls.backupRequired !== false` means required.

- [ ] **Step 1: Add failing schema tests**

```ts
it('defaults omitted backupRequired to required for legacy reports', () => {
  expect(securityCompliancePostureConfigSchema.parse({}).backupRequired).toBe(true);
});

it.each([true, false])('accepts backupRequired=%s', (backupRequired) => {
  expect(securityCompliancePostureConfigSchema.parse({ backupRequired }).backupRequired)
    .toBe(backupRequired);
});

it('rejects non-boolean backupRequired', () => {
  expect(securityCompliancePostureConfigSchema.safeParse({ backupRequired: 'false' }).success)
    .toBe(false);
});
```

Add this create/update schema case in `schemas.config.test.ts`:

```ts
it('preserves posture backupRequired on create and update', () => {
  const created = createReportSchema.parse({
    name: 'Workstation posture',
    type: 'security_compliance_posture',
    schedule: 'one_time',
    format: 'pdf',
    config: { backupRequired: false },
  });
  expect(created.config.backupRequired).toBe(false);

  const updated = updateReportSchema.parse({
    config: { backupRequired: true },
  });
  expect(updated.config?.backupRequired).toBe(true);
});
```

- [ ] **Step 2: Run schema tests and verify RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/reports/schemas.security.test.ts src/routes/reports/schemas.config.test.ts
```

Expected: FAIL because `backupRequired` is stripped or missing.

- [ ] **Step 3: Add the config field to both schema paths**

In `securityCompliancePostureConfigSchema`:

```ts
backupRequired: z.boolean().optional().default(true),
```

In `securityCompliancePostureConfigFields`:

```ts
backupRequired: z.boolean().optional(),
```

Do not default the create/update field map: new template creation posts an explicit value, while stored legacy config may remain absent.

- [ ] **Step 4: Add failing summary and PDF tests**

Add `backupRequired?: boolean` to test fixture inputs and a helper to inspect jsPDF command text:

```ts
function pdfCommandText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: string[][] }).pages ?? [])
    .flat()
    .join('\n');
}

it('renders optional missing backup neutrally and omits the backup recommendation', () => {
  const summary: PostureSummary = {
    ...postureSummary,
    controls: {
      ...postureSummary.controls,
      backupRequired: false,
      backupConfigured: false,
    },
  };
  const text = pdfCommandText(buildReportPdf(postureRows, {
    ...opts,
    reportType: 'security_compliance_posture',
    summary,
  }));
  expect(text).toContain('Not required');
  expect(text).not.toContain('Configure backups');
});

it('keeps missing backup required for legacy summaries', () => {
  const summary: PostureSummary = {
    ...postureSummary,
    controls: { ...postureSummary.controls, backupConfigured: false },
  };
  expect(pdfCommandText(buildReportPdf(postureRows, {
    ...opts,
    reportType: 'security_compliance_posture',
    summary,
  }))).toContain('Configure backups');
});
```

Add a generator assertion:

```ts
it('carries the backup requirement without changing posture score', async () => {
  mockGeneratorQueries();
  const summary = (await generateSecurityCompliancePostureReport(ORG, {
    backupRequired: false,
  })).summary as any;
  expect(summary.controls.backupRequired).toBe(false);
  expect(summary.postureScore).toBe(82);
});
```

- [ ] **Step 5: Verify RED for summary/PDF behavior**

```bash
pnpm --filter @breeze/api exec vitest run src/services/securityComplianceReport.test.ts
pnpm --filter @breeze/shared exec vitest run src/reportPdf/reportPdf.test.ts
```

Expected: FAIL because the summary omits the policy and the PDF still renders backup as failed.

- [ ] **Step 6: Carry the field through empty and populated summaries**

Extend `emptySummary` to accept `backupRequired = true`, pass `cfg.backupRequired` at both empty-return sites, and emit:

```ts
backupRequired: cfg.backupRequired,
backupConfigured: Boolean(backup || c2c),
```

Add to `PostureControls`:

```ts
backupRequired?: boolean;
```

- [ ] **Step 7: Render optional backup neutrally**

Build the backup metric as:

```ts
const backupRequired = c.backupRequired !== false;
const backupValue = backupRequired
  ? `${yesNo(c.backupConfigured)}${c.backupConfigured && c.backupEncrypted ? ' (encrypted)' : ''}`
  : c.backupConfigured
    ? 'Optional; configured'
    : 'Not required';

const backupMetric: Metric = {
  label: 'Backup',
  value: backupValue,
  status: backupRequired ? boolStatus(c.backupConfigured) : 'neutral',
};
```

Change the recommendation condition to:

```ts
if (c.backupRequired !== false && c.backupConfigured === false) {
  recs.push({
    severity: 'bad',
    text: 'Configure backups - no backup solution is currently detected for this organization.',
  });
}
```

Use the repository's ASCII-hyphen PDF convention in new text.

- [ ] **Step 8: Rerun all focused schema, API, and PDF tests**

Expected: PASS.

- [ ] **Step 9: Commit the backup contract**

```bash
git add apps/api/src/routes/reports/schemas.ts apps/api/src/routes/reports/schemas.security.test.ts apps/api/src/routes/reports/schemas.config.test.ts apps/api/src/services/securityComplianceReport.ts apps/api/src/services/securityComplianceReport.test.ts packages/shared/src/types/postureReport.ts packages/shared/src/reportPdf/reportPdf.ts packages/shared/src/reportPdf/reportPdf.test.ts
git commit -m "feat(reports): make backup a posture report requirement"
```

---

### Task 5: Posture create/edit options and locale coverage

**Files:**

- Create: `apps/web/src/components/reports/PostureReportOptionsForm.tsx`
- Modify: `apps/web/src/components/reports/ReportTemplates.tsx:33-599`
- Modify: `apps/web/src/components/reports/ReportTemplates.posture.test.tsx`
- Modify: `apps/web/src/components/reports/ReportEditPage.tsx:18-134`
- Create: `apps/web/src/components/reports/ReportEditPage.posture.test.tsx`
- Modify: `apps/web/src/locales/en/reports.json`
- Modify: `apps/web/src/locales/es-419/reports.json`
- Modify: `apps/web/src/locales/de-DE/reports.json`
- Modify: `apps/web/src/locales/fr-FR/reports.json`
- Modify: `apps/web/src/locales/pt-BR/reports.json`

**Interfaces:**

- Produces: `PostureReportOptionsForm` props `{ backupRequired, busy, submitLabel, onBackupRequiredChange, onSubmit, onCancel }`.
- Create payload: `config.backupRequired` is always explicit.
- Edit payload: merges `{ ...existingConfig, backupRequired }` and sends only `config` in PUT.

- [ ] **Step 1: Write failing template creation tests**

Extend `ReportTemplates.posture.test.tsx`:

```tsx
it('opens posture options and creates backup-optional by default', async () => {
  mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-9' } }) }));
  render(<ReportTemplates />);
  await clickUseTemplate('Security & Compliance Posture (Insurance)');
  await userEvent.setup().click(screen.getByTestId('posture-options-submit'));

  expect(postCallBody()).toMatchObject({
    type: 'security_compliance_posture',
    config: { backupRequired: false },
  });
});

it('posts backupRequired true when the user opts in', async () => {
  mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-9' } }) }));
  render(<ReportTemplates />);
  await clickUseTemplate('Security & Compliance Posture (Insurance)');
  const user = userEvent.setup();
  await user.click(screen.getByTestId('posture-backup-required'));
  await user.click(screen.getByTestId('posture-options-submit'));

  expect(postCallBody()).toMatchObject({
    type: 'security_compliance_posture',
    config: { backupRequired: true },
  });
});
```

- [ ] **Step 2: Run the template test and verify RED**

```bash
pnpm --filter @breeze/web exec vitest run src/components/reports/ReportTemplates.posture.test.tsx
```

Expected: FAIL because direct creation happens immediately and no options controls exist.

- [ ] **Step 3: Create the reusable options component**

```tsx
import { useTranslation } from 'react-i18next';

type Props = {
  backupRequired: boolean;
  busy?: boolean;
  submitLabel: string;
  onBackupRequiredChange: (value: boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function PostureReportOptionsForm({
  backupRequired,
  busy = false,
  submitLabel,
  onBackupRequiredChange,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="posture-backup-required"
          type="checkbox"
          checked={backupRequired}
          onChange={(event) => onBackupRequiredChange(event.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">
            {t('reports.postureOptions.requireBackupCoverage')}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t('reports.postureOptions.requireBackupCoverageHelp')}
          </span>
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.postureOptions.cancel')}
        </button>
        <button
          data-testid="posture-options-submit"
          type="button"
          disabled={busy}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-60"
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the create options state and preserve the true report type**

In `ReportTemplates`, add the state and posture branch:

```ts
const [postureTemplate, setPostureTemplate] = useState<ReportTemplate | null>(null);
const [backupRequired, setBackupRequired] = useState(false);

const handleUseTemplate = useCallback((template: ReportTemplate) => {
  const type = template.defaults.type;
  if (type === 'security_compliance_posture') {
    setBackupRequired(false);
    setPostureTemplate(template);
    return;
  }
  if (type && !reportTypeSurvivesBuilder(type)) {
    void handleCreateDirect(template);
    return;
  }
  handleOpenBuilder(template);
}, [handleCreateDirect, handleOpenBuilder]);
```

Change the direct-create signature to:

```ts
const handleCreateDirect = useCallback(async (
  template: ReportTemplate,
  postureConfig: Record<string, unknown> = {},
) => {
  setCreatingId(template.id);
  try {
    await runAction({
      request: () => fetchWithAuth('/reports', {
        method: 'POST',
        body: JSON.stringify({
          name: template.defaults.name ?? template.name,
          type: template.defaults.type,
          schedule: template.defaults.schedule ?? 'one_time',
          format: template.defaults.format ?? 'pdf',
          ...(currentOrgId ? { orgId: currentOrgId } : {}),
          config: {
            dateRange: template.defaults.dateRange ?? { preset: 'last_30_days' },
            ...postureConfig,
          },
        }),
      }),
      errorFallback: t('reports.reportTemplates.errors.createReport'),
      successMessage: t('reports.reportTemplates.success.created', {
        name: template.defaults.name ?? template.name,
      }),
      onUnauthorized: () => {
        void navigateTo('/login', { replace: true });
      },
    });
    void navigateTo('/reports');
  } catch {
    // runAction has already surfaced the error or redirected a 401.
  } finally {
    setCreatingId(null);
  }
}, [currentOrgId, t]);
```

Build config as:

```ts
config: {
  dateRange: template.defaults.dateRange ?? { preset: 'last_30_days' },
  ...postureConfig,
},
```

Submit posture creation with:

```tsx
{postureTemplate && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
      <h2 className="text-lg font-semibold">
        {t('reports.reportTemplates.useTemplateTitle', {
          name: getTemplateDisplayName(postureTemplate),
        })}
      </h2>
      <div className="mt-5">
        <PostureReportOptionsForm
          backupRequired={backupRequired}
          busy={creatingId === postureTemplate.id}
          submitLabel={t('reports.postureOptions.createReport')}
          onBackupRequiredChange={setBackupRequired}
          onCancel={() => setPostureTemplate(null)}
          onSubmit={() => {
            void handleCreateDirect(postureTemplate, { backupRequired });
          }}
        />
      </div>
    </div>
  </div>
)}
```

Update the three existing posture tests so each calls `screen.getByTestId('posture-options-submit')` after `clickUseTemplate(...)` before waiting for the POST, toast, or navigation assertion. Replace the old assertion that the posture modal is absent with an assertion that the generic builder's custom fields are absent; the posture options modal is now expected.

- [ ] **Step 5: Rerun the template tests**

Expected: both new tests and the existing report-type preservation test PASS.

- [ ] **Step 6: Write the failing posture edit test**

Create `ReportEditPage.posture.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({
  navigateTo: (...args: unknown[]) => navigateTo(...args),
}));

const genericBuilder = vi.fn();
vi.mock('./ReportBuilder', () => ({
  default: () => {
    genericBuilder();
    return null;
  },
}));

vi.mock('@/lib/runAction', () => ({
  runAction: async ({ request }: { request: () => Promise<unknown> }) => request(),
}));

import ReportEditPage from './ReportEditPage';

const report = {
  id: 'report-1',
  name: 'Workstation posture',
  type: 'security_compliance_posture',
  schedule: 'one_time',
  format: 'pdf',
  config: { backupRequired: false, includeCis: false, maxLocalAdmins: 4 },
  lastGeneratedAt: null,
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

describe('ReportEditPage posture options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports/report-1' && !init?.method) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(report) });
      }
      if (url === '/reports/report-1' && init?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: report }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
  });

  it('preserves posture config and never renders the generic builder', async () => {
    render(<ReportEditPage reportId="report-1" />);
    const user = userEvent.setup();
    const checkbox = await screen.findByTestId('posture-backup-required');
    expect(checkbox).not.toBeChecked();
    expect(genericBuilder).not.toHaveBeenCalled();

    await user.click(checkbox);
    await user.click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => {
      const putCall = fetchWithAuth.mock.calls.find(
        ([url, init]) => url === '/reports/report-1' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(JSON.parse(String((putCall![1] as RequestInit).body))).toEqual({
        config: {
          backupRequired: true,
          includeCis: false,
          maxLocalAdmins: 4,
        },
      });
    });
  });
});
```

- [ ] **Step 7: Run the edit test and verify RED**

```bash
pnpm --filter @breeze/web exec vitest run src/components/reports/ReportEditPage.posture.test.tsx
```

Expected: FAIL because posture edit still routes through `ReportBuilder` and reconstructs generic config.

- [ ] **Step 8: Add the posture-specific edit branch**

When `report.type === 'security_compliance_posture'`, render `PostureReportOptionsForm` with the persisted value interpreted as:

```ts
const initialBackupRequired = config.backupRequired !== false;
```

On save, use `runAction` with:

```ts
request: () => fetchWithAuth(`/reports/${reportId}`, {
  method: 'PUT',
  body: JSON.stringify({
    config: { ...config, backupRequired },
  }),
}),
```

Keep the generic `ReportBuilder` branch unchanged for every other type.

- [ ] **Step 9: Add translation keys in all five locale files**

Add the same four keys under `reports.postureOptions` with these exact translations:

```json
// en/reports.json
"postureOptions": {
  "requireBackupCoverage": "Require backup coverage",
  "requireBackupCoverageHelp": "When optional, backup remains visible as neutral evidence and does not create a recommendation.",
  "cancel": "Cancel",
  "createReport": "Create report"
}

// es-419/reports.json
"postureOptions": {
  "requireBackupCoverage": "Exigir cobertura de respaldo",
  "requireBackupCoverageHelp": "Cuando es opcional, el respaldo permanece visible como evidencia neutral y no genera una recomendación.",
  "cancel": "Cancelar",
  "createReport": "Crear informe"
}

// de-DE/reports.json
"postureOptions": {
  "requireBackupCoverage": "Backup-Abdeckung voraussetzen",
  "requireBackupCoverageHelp": "Wenn Backups optional sind, bleiben sie als neutrale Nachweise sichtbar und erzeugen keine Empfehlung.",
  "cancel": "Abbrechen",
  "createReport": "Bericht erstellen"
}

// fr-FR/reports.json
"postureOptions": {
  "requireBackupCoverage": "Exiger une couverture de sauvegarde",
  "requireBackupCoverageHelp": "Lorsqu'elle est facultative, la sauvegarde reste visible comme preuve neutre et ne génère aucune recommandation.",
  "cancel": "Annuler",
  "createReport": "Créer le rapport"
}

// pt-BR/reports.json
"postureOptions": {
  "requireBackupCoverage": "Exigir cobertura de backup",
  "requireBackupCoverageHelp": "Quando opcional, o backup permanece visível como evidência neutra e não gera uma recomendação.",
  "cancel": "Cancelar",
  "createReport": "Criar relatório"
}
```

- [ ] **Step 10: Run web and translation coverage tests**

```bash
pnpm --filter @breeze/web exec vitest run src/components/reports/ReportTemplates.posture.test.tsx src/components/reports/ReportEditPage.posture.test.tsx src/lib/i18n/translationCoverage.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit the web options flow**

```bash
git add apps/web/src/components/reports/PostureReportOptionsForm.tsx apps/web/src/components/reports/ReportTemplates.tsx apps/web/src/components/reports/ReportTemplates.posture.test.tsx apps/web/src/components/reports/ReportEditPage.tsx apps/web/src/components/reports/ReportEditPage.posture.test.tsx apps/web/src/locales/en/reports.json apps/web/src/locales/es-419/reports.json apps/web/src/locales/de-DE/reports.json apps/web/src/locales/fr-FR/reports.json apps/web/src/locales/pt-BR/reports.json
git commit -m "feat(reports): configure posture backup requirement"
```

---

### Task 6: Non-truncating product inventory PDF

**Files:**

- Modify: `packages/shared/src/reportPdf/reportPdf.ts:502-650,1194-1235`
- Modify: `packages/shared/src/reportPdf/reportPdf.test.ts`

**Interfaces:**

- Changes: `renderPostureCover(...): PostureProduct[]` returns products not rendered on the cover.
- Produces: `renderPostureProductContinuation(doc, products, opts): void`.
- Consumes: `antivirus` category from Task 3.

- [ ] **Step 1: Write crowded and continuation PDF tests**

```ts
it('renders Huntress, SentinelOne, and Defender from the reference-like inventory', () => {
  const summary: PostureSummary = {
    ...postureSummary,
    securityProducts: [
      { product: 'Huntress', category: 'mdr', active: true, deviceCoverage: 6 },
      { product: 'SentinelOne', category: 'edr', active: true, deviceCoverage: 4 },
      { product: 'Defender', category: 'antivirus', active: true, deviceCoverage: 4 },
    ],
  };
  const text = pdfCommandText(buildReportPdf(postureRows, {
    ...opts,
    reportType: 'security_compliance_posture',
    summary,
  }));
  expect(text).toContain('Huntress');
  expect(text).toContain('SentinelOne');
  expect(text).toContain('Defender');
});

it('continues a large product inventory without dropping names', () => {
  const products = Array.from({ length: 24 }, (_, index) => ({
    product: `Security Product ${index + 1}`,
    category: 'antivirus' as const,
    active: true,
    deviceCoverage: index + 1,
  }));
  const doc = buildReportPdf([], {
    ...opts,
    reportType: 'security_compliance_posture',
    summary: { ...postureSummary, securityProducts: products },
  });
  const text = pdfCommandText(doc);
  for (const product of products) expect(text).toContain(product.product);
  expect(doc.getNumberOfPages()).toBeGreaterThan(1);
  expect(text).toContain('continued');
});
```

- [ ] **Step 2: Run the shared PDF test and verify RED**

```bash
pnpm --filter @breeze/shared exec vitest run src/reportPdf/reportPdf.test.ts
```

Expected: the crowded fixture drops later product names and the continuation assertion FAILS.

- [ ] **Step 3: Extract one product-row renderer**

Move the existing category/coverage/sync/degraded formatting into:

```ts
function drawPostureProductRow(doc: jsPDF, product: PostureProduct, y: number): number {
  const catLabel = PRODUCT_CATEGORY_LABELS[product.category] ?? product.category;
  const cat = product.product.toLowerCase().includes(catLabel.toLowerCase())
    ? ''
    : ` (${catLabel})`;
  const coverage = product.deviceCoverage != null ? ` - ${product.deviceCoverage} devices` : '';
  const syncOk = !product.lastSyncStatus || /^(ok|success|succeeded)$/i.test(product.lastSyncStatus);
  const sync = syncOk ? '' : ` - sync ${product.lastSyncStatus}`;
  const degraded = product.active === false ? ' - not reporting' : '';
  set.fill(doc, product.active === false ? C.warning : C.success);
  doc.circle(PAGE.mx + 1.4, y - 1.2, 1.2, 'F');
  set.text(doc, C.ink);
  doc.text(`${product.product}${cat}${coverage}`, PAGE.mx + 5, y);
  if (sync || degraded) {
    const baseW = doc.getTextWidth(`${product.product}${cat}${coverage}`);
    set.text(doc, C.warning);
    doc.text(`${sync}${degraded}`, PAGE.mx + 5 + baseW, y);
  }
  return y + 5.2;
}
```

Add `antivirus: 'Antivirus'` to `PRODUCT_CATEGORY_LABELS`.

- [ ] **Step 4: Return cover overflow explicitly**

Change `renderPostureCover` to return `PostureProduct[]`. Compute the number of product rows that fit above `PAGE.footY - 9`, reserving 4 mm for a continuation line when needed. Render the fitting slice through `drawPostureProductRow`. If products remain, draw:

```ts
doc.text(`+ ${overflow.length} product${overflow.length === 1 ? '' : 's'} continued on the next page`, PAGE.mx + 5, y);
```

Return `overflow`; return `[]` when all products fit.

- [ ] **Step 5: Render continuation pages before device detail**

Add a function that paginates until the overflow is empty:

```ts
function renderPostureProductContinuation(
  doc: jsPDF,
  products: PostureProduct[],
  opts: BuildOpts,
): void {
  let remaining = [...products];
  while (remaining.length > 0) {
    doc.addPage('a4', 'landscape');
    let y = drawTitleBlock(
      doc,
      'Security products in use',
      '',
      'Continued from the posture summary',
      PAGE.bandH + 8,
    );
    const rowsPerPage = Math.max(1, Math.floor((PAGE.footY - 12 - y) / 5.2));
    const pageProducts = remaining.slice(0, rowsPerPage);
    for (const product of pageProducts) y = drawPostureProductRow(doc, product, y);
    remaining = remaining.slice(pageProducts.length);
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
  }
}
```

In `buildReportPdf`:

```ts
const overflowProducts = renderPostureCover(doc, opts.summary as PostureSummary, opts, agg);
drawHeaderBand(doc, opts);
drawFooter(doc, opts);
renderPostureProductContinuation(doc, overflowProducts, opts);
if (records.length > 0) renderPostureTable(doc, records, opts);
```

- [ ] **Step 6: Rerun shared PDF tests**

Expected: all tests PASS and every generated product name is present in the jsPDF command stream.

- [ ] **Step 7: Commit product pagination**

```bash
git add packages/shared/src/reportPdf/reportPdf.ts packages/shared/src/reportPdf/reportPdf.test.ts
git commit -m "fix(reports): continue posture products across PDF pages"
```

---

### Task 7: Documentation, full verification, and visual inspection

**Files:**

- Modify: `apps/docs/src/content/docs/features/reports.mdx:230-245`
- Verify: all files changed in Tasks 1-6.

**Interfaces:**

- Documents: `backupRequired`, legacy-required behavior, product continuation, and accurate tenant-safe vulnerability counts.

- [ ] **Step 1: Update the report documentation**

Replace the posture-config paragraph with explicit behavior:

```md
The posture template asks whether backup coverage is required. New template-created
reports default this option off for workstation-oriented assessments. When backup
is optional, the PDF still shows detected backup products and labels missing backup
as `Not required`; it does not create a remediation recommendation. Existing reports
that predate this option retain required-backup behavior.

API callers can set `config.backupRequired` together with `sites`, `windowDays`,
`minPasswordLength`, `maxLocalAdmins`, `maxAvDefinitionsAgeDays`, and `includeCis`.
Open vulnerability totals are scoped through tenant findings and the global CVE
catalog, and the PDF continues long security-product inventories onto another page.
```

- [ ] **Step 2: Run focused test suites together**

```bash
pnpm --filter @breeze/api exec vitest run src/services/securityComplianceReportVulnerabilities.test.ts src/services/securityComplianceReportProducts.test.ts src/services/securityComplianceReport.test.ts src/routes/reports/schemas.security.test.ts src/routes/reports/schemas.config.test.ts
pnpm --filter @breeze/shared exec vitest run src/reportPdf/reportPdf.test.ts
pnpm --filter @breeze/web exec vitest run src/components/reports/ReportTemplates.posture.test.tsx src/components/reports/ReportEditPage.posture.test.tsx src/lib/i18n/translationCoverage.test.ts
```

Expected: all focused tests PASS with no warnings or unhandled rejections.

- [ ] **Step 3: Run the real-DB integration test**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/securityComplianceReport.integration.test.ts
```

Expected: PASS when the test database is available; record an explicit skip when `DATABASE_URL` is unavailable.

- [ ] **Step 4: Run package-level regression checks**

```bash
pnpm --filter @breeze/shared typecheck
pnpm --filter @breeze/api test:run
pnpm --filter @breeze/web exec vitest run
pnpm --filter @breeze/shared exec vitest run
```

Expected: all commands exit 0. If an unrelated pre-existing failure occurs, capture its exact test name and verify it also fails on the task's base commit before excluding it from the completion claim.

- [ ] **Step 5: Generate and inspect a reference-like PDF**

Create `tmp/pdfs/render-posture-corrections.ts` with `apply_patch` using this complete temporary fixture:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReportPdf } from '../../packages/shared/src/reportPdf/reportPdf';
import type { PostureProduct, PostureSummary } from '../../packages/shared/src/types/postureReport';

const baseProducts: PostureProduct[] = [
  { product: 'Huntress', category: 'mdr', active: true, deviceCoverage: 6 },
  { product: 'SentinelOne', category: 'edr', active: true, deviceCoverage: 4 },
  { product: 'Defender', category: 'antivirus', active: true, deviceCoverage: 4 },
];
const overflowProducts: PostureProduct[] = Array.from({ length: 12 }, (_, index) => ({
  product: `Reference Product ${index + 1}`,
  category: 'antivirus',
  active: index % 4 !== 0,
  deviceCoverage: index + 1,
}));
const summary: PostureSummary = {
  org: { id: 'reference-org', name: 'Reference Organization' },
  deviceCount: 8,
  postureScore: 77,
  controls: {
    edrCoveragePct: 75,
    anyAvCoveragePct: 100,
    unprotectedCount: 0,
    avDefinitionsCurrentPct: 88,
    encryptionPct: 100,
    firewallPct: 100,
    patchCurrentPct: 100,
    localAdminExposurePct: 86,
    backupRequired: false,
    backupConfigured: false,
  },
  privilegedAccess: {
    uacInterceptionEnabled: false,
    activePamRules: 0,
    windowDays: 30,
    elevationsInWindow: 0,
    elevationsApproved: 0,
    elevationsDenied: 0,
    mfaStepUpEnforced: false,
  },
  securityProducts: [...baseProducts, ...overflowProducts],
};
const rows = Array.from({ length: 8 }, (_, index) => ({
  hostname: `WORKSTATION-${index + 1}`,
  os: 'windows',
  site: 'Main',
  protection: index < 4 ? 'Huntress + Defender (RTP on)' : 'SentinelOne (RTP on)',
  protectionManaged: true,
  avDefinitionsAgeDays: index + 1,
  encryption: 'encrypted',
  firewall: true,
  localAdmins: index % 3,
  patchAssessed: true,
  pendingPatches: index + 1,
  criticalPatches: 0,
  openVulnHigh: index % 2,
  openVulnCritical: index === 0 ? 1 : 0,
}));

const outputPath = fileURLToPath(new URL('./posture-corrections.pdf', import.meta.url));
await mkdir(dirname(outputPath), { recursive: true });
const doc = buildReportPdf(rows, {
  generatedAt: 'Jul 14, 2026, 8:44 AM',
  timezone: 'America/Denver',
  reportType: 'security_compliance_posture',
  summary,
  branding: { name: 'Reference MSP', logoDataUrl: null, logoAspect: null },
});
await writeFile(outputPath, Buffer.from(doc.output('arraybuffer')));
```

Generate and render it with:

```bash
mkdir -p tmp/pdfs/posture-corrections
pnpm exec tsx tmp/pdfs/render-posture-corrections.ts
pdftoppm -png -r 144 tmp/pdfs/posture-corrections.pdf tmp/pdfs/posture-corrections/page
```

Inspect every PNG and confirm:

- cover metrics and recommendations do not overlap;
- optional backup is neutral and says `Not required`;
- the cover has an explicit product-continuation message;
- continuation pages list every supplied product;
- page headers, footers, and totals remain correct;
- per-device vulnerability counts are legible and aligned.

Delete only `tmp/pdfs/render-posture-corrections.ts`, `tmp/pdfs/posture-corrections.pdf`, and `tmp/pdfs/posture-corrections/` after inspection; do not touch the user's reference PDF.

- [ ] **Step 6: Check the final diff and working tree**

```bash
git diff --check
git status --short
git diff --stat c84fe2913..HEAD
```

Expected: no whitespace errors; only planned source/tests/docs are changed or committed. Preserve the user's pre-existing untracked `.githooks/*` files.

- [ ] **Step 7: Commit documentation if it was not included earlier**

```bash
git add apps/docs/src/content/docs/features/reports.mdx
git commit -m "docs(reports): explain posture backup requirements"
```

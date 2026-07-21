# Device Vulnerabilities Tab Reshape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the device details Vulnerabilities tab's flat CVE list with a per-device posture header plus a software-grouped remediation list (CVEs available as a per-group drill-down).

**Architecture:** Reuse the fleet view's tested aggregation (`fetchFleetFindingRows` + `groupFindings`) scoped to one device. A new endpoint `GET /vulnerabilities/devices/:deviceId/software` returns `{ groups, findings, stats }` in one round-trip; the web tab renders a header + expandable groups. No changes to the correlation pipeline or finding data.

**Tech Stack:** Hono + Zod (API), Drizzle (DB), React + Tailwind (web), Vitest (api + web unit), Vitest integration (`vitest.integration.config.ts`), `@breeze/shared` for wire DTOs.

## Global Constraints

- Wire DTOs are single-sourced in `packages/shared/src/types/vulnerability.ts` — api + web both import them; never redefine locally.
- The new route is **read-only** and tenant-scoped: org isolation via request RLS context; site axis via `assertDeviceSiteAccess` (RLS does NOT enforce sites). Register the route **before** the `/:cveId/devices` catch-all GET (that route's first-segment param shadows static-first-segment routes).
- Site-axis narrowing is fail-closed: an empty `allowedSiteIds` returns nothing.
- Follow existing file conventions; keep `DeviceVulnerabilitiesTab.tsx` cohesive (already ~450 lines — do not split it in this plan).
- Web mutations already go through `runAction` (existing `remediateVuln`) — do not add new silent mutation paths.

---

## File structure

- `packages/shared/src/types/vulnerability.ts` — add `DeviceVulnStats`, add a new `DeviceVulnFinding` (per-finding row + `groupKey`), add `DeviceVulnSoftwareResponse`.
  - NOTE: the pre-existing `DeviceVulnerabilityItem` lives **web-side** in `apps/web/src/lib/api/vulnerabilities.ts` and backs the OLD `GET /vulnerabilities/devices/:deviceId` endpoint — leave it untouched. The new endpoint uses the new shared `DeviceVulnFinding` (which carries `groupKey`); the reshaped tab consumes `DeviceVulnFinding`, not `DeviceVulnerabilityItem`.
- `apps/api/src/services/vulnerabilityFleetQueries.ts` — add optional `deviceId` filter to `fetchFleetFindingRows`.
- `apps/api/src/services/vulnerabilityFleetAggregation.ts` — add pure `computeDeviceStats(rows)`.
- `apps/api/src/services/vulnerabilityFleetAggregation.test.ts` — unit tests for `computeDeviceStats`.
- `apps/api/src/routes/vulnerabilities.ts` — new `GET /vulnerabilities/devices/:deviceId/software` route + a `toDeviceFindingItem` mapper.
- `apps/api/src/routes/vulnerabilities.test.ts` — route test (grouping + site-access gate).
- `apps/web/src/lib/api/vulnerabilities.ts` — `fetchDeviceSoftwareGroups`, `DeviceVulnerabilityItem.groupKey`, re-export new shared types.
- `apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx` — reshape to header + groups + drill-down.
- `apps/web/src/components/devices/DeviceVulnerabilitiesTab.test.tsx` — update tests.

---

## Task 1: Shared DTOs — `DeviceVulnStats` + device software response

**Files:**
- Modify: `packages/shared/src/types/vulnerability.ts` (add after `FleetVulnStats`, ~line 255)
- Test: none (type-only; consumed/tested by later tasks)

**Interfaces:**
- Produces:
  - `interface DeviceVulnStats { openTotal; critical; high; medium; low; unscored; kevFindingCount; patchReadyFindingCount }` (all `number`)
  - `interface DeviceVulnSoftwareResponse { groups: SoftwareGroup[]; findings: DeviceVulnFinding[]; stats: DeviceVulnStats }`
  - `interface DeviceVulnFinding` — the per-(device,CVE) row with `groupKey` (single-sourced here so api + web share it).

- [ ] **Step 1: Add the types**

In `packages/shared/src/types/vulnerability.ts`, after the `FleetVulnStats` interface, add:

```ts
/** Per-device severity/KEV/patch summary for the device Vulnerabilities tab header.
 *  Computed from the device's finding rows under the current status filter. */
export interface DeviceVulnStats {
  /** Findings in the current status filter (the "N findings" total). */
  openTotal: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** Severity null/unknown — the majority of real NVD findings. */
  unscored: number;
  /** Findings whose CVE is KEV (known exploited). */
  kevFindingCount: number;
  /** Open findings whose CVE has a patch available ("fixable now"). */
  patchReadyFindingCount: number;
}

/** A per-(device, CVE) finding row for the device tab, tagged with the software
 *  `groupKey` it rolls up under (buildGroupKey in vulnerabilityFleetAggregation).
 *  cvssVector is not carried by the fleet query layer, so it is always null here. */
export interface DeviceVulnFinding {
  id: string; // device_vulnerabilities id
  deviceId: string;
  vulnerabilityId: string;
  cveId: string;
  cvssScore: number | null;
  cvssVector: string | null;
  severity: VulnSeverity | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  status: VulnStatus;
  detectedAt: string;
  patchAvailable: boolean;
  /** The SoftwareGroup.groupKey this finding belongs to. */
  groupKey: string;
}

/** GET /vulnerabilities/devices/:deviceId/software payload. */
export interface DeviceVulnSoftwareResponse {
  groups: SoftwareGroup[];
  findings: DeviceVulnFinding[];
  stats: DeviceVulnStats;
}
```

- [ ] **Step 2: Verify the barrel re-exports them**

`packages/shared/src/types/vulnerability.ts` is re-exported by `packages/shared/src/index.ts` (or `types/index.ts`). Confirm with:

Run: `grep -rn "vulnerability" packages/shared/src/index.ts packages/shared/src/types/index.ts`
Expected: a `export * from './types/vulnerability'` (or equivalent) line already exists — no change needed. If missing, add `export * from './vulnerability';` to `packages/shared/src/types/index.ts`.

- [ ] **Step 3: Typecheck shared**

Run: `pnpm --filter @breeze/shared build` (or `pnpm --filter @breeze/shared exec tsc --noEmit`)
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/vulnerability.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): add DeviceVulnStats + device software response DTOs"
```

---

## Task 2: API — device filter on fetch + `computeDeviceStats`

**Files:**
- Modify: `apps/api/src/services/vulnerabilityFleetQueries.ts:25-43` (add `deviceId` to filter)
- Modify: `apps/api/src/services/vulnerabilityFleetAggregation.ts` (add `computeDeviceStats`)
- Test: `apps/api/src/services/vulnerabilityFleetAggregation.test.ts`

**Interfaces:**
- Consumes: `FleetFindingRow` (`@breeze/shared`), `DeviceVulnStats` (Task 1).
- Produces:
  - `fetchFleetFindingRows({ status, allowedSiteIds?, deviceId? })` — new optional `deviceId` narrows to one device.
  - `computeDeviceStats(rows: FleetFindingRow[]): DeviceVulnStats` — pure; counts reflect whatever rows are passed (endpoint pre-filters by status).

- [ ] **Step 1: Write the failing test for `computeDeviceStats`**

Add to `apps/api/src/services/vulnerabilityFleetAggregation.test.ts` (reuse the file's existing `row(...)` helper — it builds a `FleetFindingRow` with overrides):

```ts
import { computeDeviceStats } from './vulnerabilityFleetAggregation';

describe('computeDeviceStats', () => {
  it('counts severity spread, unscored, KEV, and patch-ready', () => {
    const rows = [
      row({ deviceVulnerabilityId: 'a', cveId: 'CVE-1', severity: 'critical', knownExploited: true, patchAvailable: true, status: 'open' }),
      row({ deviceVulnerabilityId: 'b', cveId: 'CVE-2', severity: 'high', patchAvailable: true, status: 'open' }),
      row({ deviceVulnerabilityId: 'c', cveId: 'CVE-3', severity: 'medium', status: 'open' }),
      row({ deviceVulnerabilityId: 'd', cveId: 'CVE-4', severity: null, status: 'open' }),
      row({ deviceVulnerabilityId: 'e', cveId: 'CVE-5', severity: 'low', status: 'open' }),
    ];
    expect(computeDeviceStats(rows)).toEqual({
      openTotal: 5,
      critical: 1,
      high: 1,
      medium: 1,
      low: 1,
      unscored: 1,
      kevFindingCount: 1,
      patchReadyFindingCount: 2,
    });
  });

  it('patchReady counts only OPEN patch-available findings', () => {
    const rows = [
      row({ deviceVulnerabilityId: 'a', severity: 'high', patchAvailable: true, status: 'open' }),
      row({ deviceVulnerabilityId: 'b', severity: 'high', patchAvailable: true, status: 'accepted' }),
    ];
    const s = computeDeviceStats(rows);
    expect(s.patchReadyFindingCount).toBe(1);
    expect(s.openTotal).toBe(2);
  });
});
```

If the file has no shared `row(...)` helper usable here, copy the one from the `groupFindings` describe block (it constructs a full `FleetFindingRow`). Do not invent new fields.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/vulnerabilityFleetAggregation.test.ts -t computeDeviceStats`
Expected: FAIL with "computeDeviceStats is not a function" (or import error).

- [ ] **Step 3: Implement `computeDeviceStats`**

In `apps/api/src/services/vulnerabilityFleetAggregation.ts`, after `computeStats`, add:

```ts
/** Per-device header summary. Counts reflect the rows passed in (the device
 *  route pre-filters by the selected status). `patchReadyFindingCount` mirrors
 *  the group/fleet definition: OPEN + patchAvailable. */
export function computeDeviceStats(rows: FleetFindingRow[]): DeviceVulnStats {
  let critical = 0, high = 0, medium = 0, low = 0, unscored = 0;
  let kevFindingCount = 0;
  let patchReadyFindingCount = 0;
  for (const r of rows) {
    switch ((r.severity ?? '').toLowerCase()) {
      case 'critical': critical += 1; break;
      case 'high': high += 1; break;
      case 'medium': medium += 1; break;
      case 'low': low += 1; break;
      default: unscored += 1; break;
    }
    if (r.knownExploited) kevFindingCount += 1;
    if (r.patchAvailable && r.status === 'open') patchReadyFindingCount += 1;
  }
  return {
    openTotal: rows.length,
    critical, high, medium, low, unscored,
    kevFindingCount,
    patchReadyFindingCount,
  };
}
```

Add `DeviceVulnStats` to the `import type { ... } from '@breeze/shared'` block at the top of the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/services/vulnerabilityFleetAggregation.test.ts -t computeDeviceStats`
Expected: PASS (both cases).

- [ ] **Step 5: Add `deviceId` filter to `fetchFleetFindingRows`**

In `apps/api/src/services/vulnerabilityFleetQueries.ts`, change the filter signature and add the condition:

```ts
export async function fetchFleetFindingRows(filters: {
  status: string;
  /** Site-axis narrowing; empty array = fail closed (return nothing). */
  allowedSiteIds?: string[];
  /** When set, narrow to a single device (device tab). */
  deviceId?: string;
}): Promise<FleetFindingRow[]> {
  const conditions: SQL[] = [];
  if (filters.status !== 'all') {
    conditions.push(eq(deviceVulnerabilities.status, filters.status));
  }
  if (filters.deviceId) {
    conditions.push(eq(deviceVulnerabilities.deviceId, filters.deviceId));
  }
  if (filters.allowedSiteIds !== undefined) {
    // ...unchanged...
```

(Only add the `deviceId` field to the type and the two lines pushing the condition; leave everything below untouched.)

- [ ] **Step 6: Typecheck + run the aggregation test file**

Run: `pnpm --filter @breeze/api exec vitest run src/services/vulnerabilityFleetAggregation.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/vulnerabilityFleetQueries.ts apps/api/src/services/vulnerabilityFleetAggregation.ts apps/api/src/services/vulnerabilityFleetAggregation.test.ts
git commit -m "feat(api): computeDeviceStats + device filter on fetchFleetFindingRows"
```

---

## Task 3: API — `GET /vulnerabilities/devices/:deviceId/software`

**Files:**
- Modify: `apps/api/src/routes/vulnerabilities.ts` (new route + mapper; imports)
- Test: `apps/api/src/routes/vulnerabilities.test.ts`

**Interfaces:**
- Consumes: `fetchFleetFindingRows` (Task 2, with `deviceId`), `groupFindings`, `computeDeviceStats` (Task 2), `buildGroupKey` (existing), `assertDeviceSiteAccess` (existing), `deviceParamSchema` + `listQuerySchema` (existing), `DeviceVulnFinding` / `DeviceVulnSoftwareResponse` (Task 1).
- Produces: `GET /vulnerabilities/devices/:deviceId/software?status=` → `DeviceVulnSoftwareResponse`.

- [ ] **Step 1: Write the failing route test**

Add a new `describe` block to `apps/api/src/routes/vulnerabilities.test.ts` using the file's **existing** helpers: `app()` (mounts `vulnerabilityRoutes`), the `fleetRow(overrides)` factory, `vi.mocked(fetchFleetFindingRows)`, `vi.mocked(db.select)`, the mutable `granted` set, and `ID`. The `assertDeviceSiteAccess` gate issues one `db.select().from(devices).where(...).limit(1)` — mock that first `select` to return a device row (auth mock's `canAccessSite` is `() => true`, so any siteId passes). Cross-tenant/unknown devices fall through the default `db.select` mock (`.limit()` → `[]`) → 404, which is the isolation behavior.

```ts
describe('GET /vulnerabilities/devices/:deviceId/software', () => {
  beforeEach(() => {
    granted.clear();
    granted.add('devices:read');
    delete permissionsState.allowedSiteIds;
    vi.mocked(db.select).mockReset();
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
  });

  it('groups a device’s findings by software and returns stats + tagged findings', async () => {
    // assertDeviceSiteAccess: device lookup returns a row (site accessible).
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ siteId: 'site-1' }]) }),
      }),
    } as never);
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow({ deviceVulnerabilityId: 'a', deviceId: ID, cveId: 'CVE-1', softwareInventoryId: 'sw1', softwareName: 'Google Chrome', softwareVendor: '', severity: 'critical', patchAvailable: true, status: 'open' }),
      fleetRow({ deviceVulnerabilityId: 'b', deviceId: ID, cveId: 'CVE-2', softwareInventoryId: 'sw1', softwareName: 'Google Chrome', softwareVendor: '', severity: 'medium', patchAvailable: true, knownExploited: false, status: 'open' }),
      fleetRow({ deviceVulnerabilityId: 'c', deviceId: ID, cveId: 'CVE-3', softwareInventoryId: null, deviceOsType: 'windows', severity: 'high', patchAvailable: false, knownExploited: false, status: 'open' }),
    ]);

    const res = await app().request(`/vulnerabilities/devices/${ID}/software?status=open`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(2); // Chrome + Windows OS
    const chrome = body.groups.find((g: any) => g.name === 'Google Chrome');
    expect(chrome.cveCount).toBe(2);
    expect(chrome.patchReadyFindingCount).toBe(2);
    expect(body.stats.openTotal).toBe(3);
    expect(body.stats.critical).toBe(1);
    expect(body.stats.patchReadyFindingCount).toBe(2);
    expect(body.findings.every((f: any) => typeof f.groupKey === 'string')).toBe(true);
    // fetchFleetFindingRows was called with the deviceId narrow.
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(expect.objectContaining({ deviceId: ID, status: 'open' }));
  });

  it('404s when the device is not in the caller’s tenant/site scope', async () => {
    // Default db.select mock: .limit() resolves [] → device not found.
    const res = await app().request(`/vulnerabilities/devices/${ID}/software`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/vulnerabilities.test.ts -t "software"`
Expected: FAIL with 404 (route not registered) or assertion errors.

- [ ] **Step 3: Add the mapper + route**

In `apps/api/src/routes/vulnerabilities.ts`:

Add `computeDeviceStats` to the import from `../services/vulnerabilityFleetAggregation` and `buildGroupKey` (it's exported there). Add `DeviceVulnFinding` to the `@breeze/shared` type import.

Add a mapper near the other helpers:

```ts
function toDeviceFindingItem(r: FleetFindingRow): DeviceVulnFinding {
  return {
    id: r.deviceVulnerabilityId,
    deviceId: r.deviceId,
    vulnerabilityId: r.vulnerabilityId,
    cveId: r.cveId,
    cvssScore: r.cvssScore,
    cvssVector: null, // fleet query layer does not carry the vector
    severity: r.severity,
    knownExploited: r.knownExploited,
    epssScore: r.epssScore,
    riskScore: r.riskScore,
    status: r.status,
    detectedAt: r.detectedAt,
    patchAvailable: r.patchAvailable,
    groupKey: buildGroupKey(r),
  };
}
```

Register the route **immediately after** the existing `GET /devices/:deviceId` route (line ~632), so it stays above the `/:cveId/devices` catch-all:

```ts
vulnerabilityRoutes.get(
  '/devices/:deviceId/software',
  zValidator('param', deviceParamSchema),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const { deviceId } = c.req.valid('param');
    const { status } = c.req.valid('query');
    // Intra-org site gate (RLS isolates orgs, not sites).
    const access = await assertDeviceSiteAccess(deviceId, auth);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    const rows = await fetchFleetFindingRows({
      status,
      deviceId,
      allowedSiteIds: perms?.allowedSiteIds,
    });
    return c.json({
      groups: groupFindings(rows),
      findings: rows.map(toDeviceFindingItem),
      stats: computeDeviceStats(rows),
    });
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/vulnerabilities.test.ts -t "software"`
Expected: PASS (both new cases).

- [ ] **Step 5: Run the full route test file (regression)**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/vulnerabilities.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/vulnerabilities.ts apps/api/src/routes/vulnerabilities.test.ts
git commit -m "feat(api): device-scoped software-groups endpoint for vuln tab"
```

---

## Task 4: Web — API client `fetchDeviceSoftwareGroups`

**Files:**
- Modify: `apps/web/src/lib/api/vulnerabilities.ts`
- Test: none new (covered via the component test in Task 5; this is a thin wrapper mirroring `fetchDeviceVulnerabilities`)

**Interfaces:**
- Consumes: `DeviceVulnSoftwareResponse`, `SoftwareGroup`, `DeviceVulnFinding` (Task 1, from `@breeze/shared`).
- Produces: `fetchDeviceSoftwareGroups(deviceId, { status }): Promise<DeviceVulnSoftwareResponse>`.

- [ ] **Step 1: Re-export new shared types + add the fetch**

In `apps/web/src/lib/api/vulnerabilities.ts`, add `DeviceVulnStats`, `DeviceVulnFinding`, `DeviceVulnSoftwareResponse` to the `export type { ... } from '@breeze/shared'` block. Then add, next to `fetchDeviceVulnerabilities`:

```ts
/** Device tab: software-grouped findings + posture stats for one device. */
export async function fetchDeviceSoftwareGroups(
  deviceId: string,
  filters: { status?: string } = {},
): Promise<DeviceVulnSoftwareResponse> {
  const res = await fetchWithAuth(
    `/vulnerabilities/devices/${deviceId}/software${buildVulnQuery({ status: filters.status })}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to load device vulnerabilities (${res.status})`);
  }
  const body = (await res.json()) as Partial<DeviceVulnSoftwareResponse>;
  return {
    groups: body.groups ?? [],
    findings: body.findings ?? [],
    stats: body.stats ?? {
      openTotal: 0, critical: 0, high: 0, medium: 0, low: 0, unscored: 0,
      kevFindingCount: 0, patchReadyFindingCount: 0,
    },
  };
}
```

Import `DeviceVulnSoftwareResponse` at the top's `@breeze/shared` value/type import as needed.

- [ ] **Step 2: Typecheck web**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api/vulnerabilities.ts
git commit -m "feat(web): fetchDeviceSoftwareGroups client"
```

---

## Task 5: Web — reshape `DeviceVulnerabilitiesTab`

**Files:**
- Modify: `apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx`
- Test: `apps/web/src/components/devices/DeviceVulnerabilitiesTab.test.tsx`

**Interfaces:**
- Consumes: `fetchDeviceSoftwareGroups` (Task 4), `remediateVuln`, `acceptVulnRisk`, `mitigateVuln`, `reopenVuln` (existing), `SoftwareGroup` / `DeviceVulnFinding` / `DeviceVulnStats`.
- Produces: reshaped device Vulnerabilities tab (no new exports).

**Behavior spec:**
- Header: tiles for Open total, Critical, High, Medium, Low, Unscored, KEV, Patch-ready — from `stats`. `data-testid="device-vuln-stats"`.
- Group list: one row per `SoftwareGroup` (already sorted by the server), showing `name`, `cveCount` (as "N CVEs") + finding count, `worstSeverity` badge, `patchReadyFindingCount`, and a `[Remediate all]` button. Row `data-testid={`vuln-group-${g.groupKey}`}`.
- Expand: clicking a group toggles a drill-down listing that group's findings (bucketed from `findings` by `groupKey`), reusing the existing per-finding row rendering + actions (Remediate / Accept risk / Mitigate / Reopen). Expand toggle `data-testid={`vuln-group-toggle-${g.groupKey}`}`.
- "Remediate all": posts `remediateVuln(patchReadyOpenIds)` where ids = findings in the group with `status==='open' && patchAvailable`. Disabled when that set is empty (tooltip "No patch available"). `data-testid={`vuln-group-remediate-${g.groupKey}`}`.
- Status filter, loading, error, and clean-vs-never-scanned empty states preserved.

- [ ] **Step 1: Write failing component tests**

Rewrite the data-fetch mock in `DeviceVulnerabilitiesTab.test.tsx` to stub `fetchDeviceSoftwareGroups` (instead of `fetchDeviceVulnerabilities`). Use an explicit fixture so `groupKey` testids are stable — Chrome group key is `sw:google chrome|` (empty vendor), OS group key is `os:windows`:

```ts
const RESPONSE = {
  stats: { openTotal: 3, critical: 1, high: 1, medium: 1, low: 0, unscored: 0, kevFindingCount: 1, patchReadyFindingCount: 2 },
  groups: [
    { groupKey: 'sw:google chrome|', kind: 'software', name: 'Google Chrome', vendor: null, versions: ['126.0'], deviceCount: 1, cveCount: 2, cveIds: ['CVE-1', 'CVE-2'], worstSeverity: 'critical', maxRiskScore: 90, kevCveCount: 1, maxEpss: 0.4, patchReadyFindingCount: 2, patchReadyDeviceCount: 1, tickets: [] },
    { groupKey: 'os:windows', kind: 'os', name: 'Windows OS updates', vendor: null, versions: [], deviceCount: 1, cveCount: 1, cveIds: ['CVE-3'], worstSeverity: 'high', maxRiskScore: 70, kevCveCount: 0, maxEpss: null, patchReadyFindingCount: 0, patchReadyDeviceCount: 0, tickets: [] },
  ],
  findings: [
    { id: 'a', deviceId: 'd1', vulnerabilityId: 'v1', cveId: 'CVE-1', cvssScore: 9.1, cvssVector: null, severity: 'critical', knownExploited: true, epssScore: 0.4, riskScore: 90, status: 'open', detectedAt: '2026-06-01T00:00:00.000Z', patchAvailable: true, groupKey: 'sw:google chrome|' },
    { id: 'b', deviceId: 'd1', vulnerabilityId: 'v2', cveId: 'CVE-2', cvssScore: 5.0, cvssVector: null, severity: 'medium', knownExploited: false, epssScore: null, riskScore: 40, status: 'open', detectedAt: '2026-06-01T00:00:00.000Z', patchAvailable: true, groupKey: 'sw:google chrome|' },
    { id: 'c', deviceId: 'd1', vulnerabilityId: 'v3', cveId: 'CVE-3', cvssScore: 7.0, cvssVector: null, severity: 'high', knownExploited: false, epssScore: null, riskScore: 70, status: 'open', detectedAt: '2026-06-01T00:00:00.000Z', patchAvailable: false, groupKey: 'os:windows' },
  ],
};
// vi.mock('../../lib/api/vulnerabilities') — fetchDeviceSoftwareGroups resolves RESPONSE;
// keep remediateVuln/acceptVulnRisk/mitigateVuln/reopenVuln as vi.fn() mocks.
```

Then add:

```ts
// mock returns: Chrome group (2 open patch-ready findings) + OS group (1 finding, no patch)
it('renders the posture header from stats', async () => {
  render(<DeviceVulnerabilitiesTab deviceId="d1" />);
  const header = await screen.findByTestId('device-vuln-stats');
  expect(header).toHaveTextContent('1'); // critical count etc.
  expect(header).toHaveTextContent(/Critical/i);
});

it('renders one row per software group, not per CVE', async () => {
  render(<DeviceVulnerabilitiesTab deviceId="d1" />);
  expect(await screen.findByTestId('vuln-group-sw:google chrome|')).toBeInTheDocument();
  expect(screen.getByTestId('vuln-group-os:windows')).toBeInTheDocument();
});

it('expands a group to reveal its CVE findings', async () => {
  render(<DeviceVulnerabilitiesTab deviceId="d1" />);
  const toggle = await screen.findByTestId('vuln-group-toggle-sw:google chrome|');
  fireEvent.click(toggle);
  expect(await screen.findByText('CVE-1')).toBeInTheDocument();
  expect(screen.getByText('CVE-2')).toBeInTheDocument();
});

it('Remediate all posts the group patch-ready open finding ids', async () => {
  const remediate = vi.mocked(remediateVuln).mockResolvedValue({ scheduled: 2, skipped: [] });
  render(<DeviceVulnerabilitiesTab deviceId="d1" />);
  fireEvent.click(await screen.findByTestId('vuln-group-remediate-sw:google chrome|'));
  await waitFor(() => expect(remediate).toHaveBeenCalledWith(['a', 'b']));
});

it('disables Remediate all when the group has no patch-ready findings', async () => {
  render(<DeviceVulnerabilitiesTab deviceId="d1" />);
  const btn = await screen.findByTestId('vuln-group-remediate-os:windows');
  expect(btn).toBeDisabled();
});
```

Keep/adapt the existing status-filter, empty-state, and per-finding-action tests to the new structure (per-finding action buttons now live inside an expanded group — expand first, then assert).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceVulnerabilitiesTab.test.tsx`
Expected: FAIL (header/group testids not found; still calling old fetch).

- [ ] **Step 3: Reshape the component**

Rewrite `DeviceVulnerabilitiesTab.tsx`:

1. State: replace `items` with `groups: SoftwareGroup[]`, `findings: DeviceVulnFinding[]`, `stats: DeviceVulnStats`, plus `expanded: Set<string>` (group keys). Keep `statusFilter`, `busyId`, `modal`, error/loading.
2. `load()` calls `fetchDeviceSoftwareGroups(deviceId, { status: statusFilter })` and sets the three pieces.
3. Add a `findingsByGroup = useMemo(() => groupBy(findings, f => f.groupKey))` map.
4. Header: render `stats` as a tile row with `data-testid="device-vuln-stats"`. Suggested tiles (label + count): Open (`openTotal`), Critical, High, Medium, Low, Unscored, KEV (`kevFindingCount`), Patch-ready (`patchReadyFindingCount`). Reuse the severity color classes already in `SEVERITY_BADGES`.
5. Group list: map `groups` to rows (`data-testid={`vuln-group-${g.groupKey}`}`), each with name, `${g.cveCount} CVEs`, `SeverityBadge severity={g.worstSeverity}`, `${g.patchReadyFindingCount} patch-ready`, an expand toggle button (`vuln-group-toggle-${g.groupKey}`), and `[Remediate all]` (`vuln-group-remediate-${g.groupKey}`).
6. Group remediate handler:

```ts
const groupPatchReadyIds = useCallback(
  (groupKey: string) =>
    (findingsByGroup.get(groupKey) ?? [])
      .filter((f) => f.status === 'open' && f.patchAvailable)
      .map((f) => f.id),
  [findingsByGroup],
);

const onRemediateGroup = useCallback(async (groupKey: string) => {
  const ids = groupPatchReadyIds(groupKey);
  if (ids.length === 0 || bulkBusy) return;
  setBulkBusy(true);
  try {
    await remediateVuln(ids);
    await load();
  } catch (err) {
    handleActionError(err, 'Failed to schedule remediation');
  } finally {
    setBulkBusy(false);
  }
}, [groupPatchReadyIds, bulkBusy, load]);
```

7. When a group is expanded, render its findings using the existing per-finding row markup (CVE id, `SeverityBadge`, CVSS, risk, KEV, patch badge) and the existing `rowActions(finding)` (Remediate/Accept/Mitigate/Reopen) — keep that helper, retyped to `DeviceVulnFinding`.
8. Keep the `VulnActionModal` and its submit wiring unchanged (still keyed by finding `id` + `cveId`).
9. Preserve error UI and the empty state: show the "clean vs never-scanned" copy when `groups.length === 0` (use `stats.openTotal`/total to distinguish, matching current wording).

Add a tiny local `groupBy` helper (or inline the reduce) — do not add a dependency.

- [ ] **Step 4: Run the component tests to verify they pass**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceVulnerabilitiesTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck web**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx apps/web/src/components/devices/DeviceVulnerabilitiesTab.test.tsx
git commit -m "feat(web): reshape device vulnerabilities tab into posture header + software groups"
```

---

## Task 6: Verify end-to-end + cleanup

**Files:** none (verification)

- [ ] **Step 1: Run the touched test suites**

Run: `pnpm --filter @breeze/api exec vitest run src/services/vulnerabilityFleetAggregation.test.ts src/routes/vulnerabilities.test.ts && pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceVulnerabilitiesTab.test.tsx`
Expected: all PASS.

- [ ] **Step 2: Typecheck both packages**

Run: `pnpm --filter @breeze/shared exec tsc --noEmit && pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Confirm the old `GET /vulnerabilities/devices/:deviceId` route + `listVulnerabilities` are still referenced or intentionally left**

Run: `grep -rn "fetchDeviceVulnerabilities\|/devices/:deviceId'" apps/web/src apps/api/src`
Expected: the old device-findings endpoint is no longer called by the tab. Decide: leave it (still used by any other caller / API consumers) — do NOT delete in this PR unless grep shows zero consumers. If zero web consumers remain, note it for a follow-up rather than removing here (avoid scope creep + external API-consumer breakage).

- [ ] **Step 4: Manual smoke (optional, if a stack is running)**

Load a device with many findings; confirm the header shows the real severity spread and the group list collapses the CVE wall (e.g. one "Google Chrome" row with a large CVE count), expand works, and "Remediate all" is disabled for no-patch groups.

---

## Self-review notes

- **Spec coverage:** posture header → Task 1 (`DeviceVulnStats`) + Task 2 (`computeDeviceStats`) + Task 5 (render); software groups → Task 3 (endpoint) + Task 5 (render); drill-down without 2nd round-trip → Task 3 (`findings[]` + `groupKey`) + Task 5 (`findingsByGroup`); Remediate-all → Task 5; site access → Task 3; status filter/empty/error preserved → Task 5. MSRC-sync + comparator explicitly out of scope (no task) per spec.
- **Type consistency:** `computeDeviceStats`, `fetchDeviceSoftwareGroups`, `DeviceVulnStats`, `DeviceVulnFinding`, `DeviceVulnSoftwareResponse`, `toDeviceFindingItem`, `buildGroupKey` used consistently across tasks.
- **Known nuance:** `DeviceVulnFinding.cvssVector` is always `null` (fleet query layer doesn't carry it) — the tab does not render the vector, so this is not a UI regression. Documented in Task 1.

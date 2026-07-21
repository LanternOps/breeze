# Vulnerabilities Fleet Triage UI Implementation Plan — Part 1: API (Tasks 1–7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only fleet `/vulnerabilities` page into a triage work queue: software-grouped table + CVE table, stat cards, slide-over drawers with remediate / accept-risk / mitigate / reopen / create-ticket actions, backed by 4 new read endpoints, 2 bulk mutation endpoints, a ticket-creation endpoint, and one migration adding `device_vulnerabilities.ticket_id`.

**Architecture:** Backend fetches raw per-finding rows (RLS org-scoped + app-layer site narrowing, catalog read under system context) and feeds them to a pure, unit-testable aggregation service. Frontend is a hash-routed page shell (`#software` default / `#cves`) with shared filter state, two table islands, and two drawers built on a `shared/Drawer.tsx` primitive extracted verbatim from the catalog editor drawer.

**Tech Stack:** Hono + Drizzle + Zod (API), Astro + React islands + Tailwind (web), Vitest (+jsdom), Playwright e2e.

**Spec:** `docs/superpowers/specs/vuln-patch/2026-07-04-vulnerabilities-triage-ui-design.md` (approved).

**Continues in:** `2026-07-05-vulnerabilities-triage-web.md` (Part 2: Web, Tasks 8–17). Task numbering is shared across both documents.

## Global Constraints

- **Group key format (opaque, stable):** `sw:<lower(trim(name))>|<lower(trim(coalesce(vendor,'')))>` for software findings; `os:<devices.osType>` (`os:windows` | `os:macos` | `os:linux`) for OS findings (`software_inventory_id IS NULL`). Normalization MUST be `lower(trim(...))` — that's what the correlation JOIN uses (`vulnerabilityCorrelation.ts:199-207`).
- **Bulk caps:** `deviceVulnerabilityIds` arrays are `z.array(z.string().uuid()).min(1).max(200)`. `reason`/`note` are `z.string().trim().min(1).max(2000)`. `acceptedUntil` is `z.string().datetime()` and must be in the future.
- **Bulk contract:** per-item fault-tolerant — `{ success, succeeded, skipped: [{id, reason}] }`; never fail the whole batch on one bad id. `success` is `true` iff at least one item succeeded (matches remediate's contract, `routes/vulnerabilities.ts:392-398`).
- **Group list cap:** hard cap 500 groups + `hasMore` boolean. No pagination.
- **Migration:** idempotent, no inner `BEGIN;`/`COMMIT;`, never edit shipped migrations. Filename `2026-07-04-device-vulnerabilities-ticket-link.sql`.
- **No new tables** → no RLS policy or allowlist changes anywhere.
- **Web:** all mutations via `runAction` (`apps/web/src/lib/runAction.ts`); new mutating/action components added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` with the count constant bumped in the same commit (current value **58**; all bumps happen in Part 2, ending at **63**).
- **URL state:** hash only (`#software`, `#cves`, `#software/<encodeURIComponent(groupKey)>`, `#cves/<cveId>`). Filters are transient React state — NOT query params.
- **Permissions (exact strings):** remediate = `devices:execute` + MFA (server-side `requireMfa()`); accept-risk & reopen = `vulnerabilities:accept_risk`; mitigate = `devices:write`; create-ticket = `tickets:write`; all reads = `devices:read` (router-level).
- **E2E:** `data-testid` attributes only, never text/role/CSS selectors.
- **Test commands:** API: `cd apps/api && pnpm vitest run <file>`. Web: `cd apps/web && pnpm vitest run <file>`. Drift: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift` (repo root, needs local Postgres).
- Route file `apps/api/src/routes/vulnerabilities.ts` is ~575 lines already — new query logic goes in NEW service files, not the route file.

---

### Task 1: Migration + Drizzle schema for `device_vulnerabilities.ticket_id`

**Files:**
- Create: `apps/api/migrations/2026-07-04-device-vulnerabilities-ticket-link.sql`
- Modify: `apps/api/src/db/schema/vulnerabilityManagement.ts` (imports at top; `deviceVulnerabilities` table at lines 96–114)

**Interfaces:**
- Consumes: existing `tickets` table (`apps/api/src/db/schema/portal.ts`, `id: uuid` PK).
- Produces: `deviceVulnerabilities.ticketId` Drizzle column (`uuid, nullable, FK → tickets.id ON DELETE SET NULL`) used by Tasks 3 (fetcher) and 7 (ticket endpoint).

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-07-04-device-vulnerabilities-ticket-link.sql`:

```sql
-- Vulnerabilities fleet triage UI: link findings to native tickets.
-- Spec: docs/superpowers/specs/vuln-patch/2026-07-04-vulnerabilities-triage-ui-design.md
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

ALTER TABLE device_vulnerabilities ADD COLUMN IF NOT EXISTS ticket_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'device_vulnerabilities_ticket_id_tickets_id_fk'
      AND table_name = 'device_vulnerabilities'
  ) THEN
    ALTER TABLE device_vulnerabilities
      ADD CONSTRAINT device_vulnerabilities_ticket_id_tickets_id_fk
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Partial index: most findings have no ticket; only index linked rows.
CREATE INDEX IF NOT EXISTS device_vuln_ticket_id_idx
  ON device_vulnerabilities (ticket_id) WHERE ticket_id IS NOT NULL;
```

The constraint name follows Drizzle's `<table>_<col>_<reftable>_<refcol>_fk` convention so `db:check-drift` sees no difference.

- [ ] **Step 2: Update the Drizzle schema**

In `apps/api/src/db/schema/vulnerabilityManagement.ts`, add to the imports block (which already imports from `./orgs`, `./devices`, `./users`, `./software`):

```ts
import { tickets } from './portal';
```

In the `deviceVulnerabilities` table definition, after the `acceptedUntil` column, add:

```ts
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
```

And add to the table's index object (third argument), after `statusIdx`:

```ts
  ticketIdx: index('device_vuln_ticket_id_idx').on(table.ticketId),
```

**Note on the partial index:** Drizzle's `index()` builder here declares a plain index while the SQL creates a partial one. If `pnpm db:check-drift` flags the `WHERE` clause mismatch, use Drizzle's `.where(sql\`ticket_id IS NOT NULL\`)` on the index builder (import `sql` from `drizzle-orm`) to match. If importing `tickets` from `./portal` creates a module cycle (build/test failure with undefined table), fall back to a plain `uuid('ticket_id')` column without `.references()` and keep the FK SQL-only — `portal.ts` itself uses this dodge for `categoryId`/`statusId`.

- [ ] **Step 3: Run the migration-ordering regression test and typecheck**

Run: `cd apps/api && pnpm vitest run src/db/autoMigrate.test.ts`
Expected: PASS

Run: `cd apps/api && pnpm tsc --noEmit 2>&1 | head -30`
Expected: no NEW errors mentioning `vulnerabilityManagement` or `portal` (pre-existing unrelated errors, if any, are fine).

- [ ] **Step 4: Verify drift check passes (requires local Postgres running)**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:migrate 2>/dev/null || true   # apply if a migrate script exists; otherwise the API dev server applies on boot
pnpm db:check-drift
```
Expected: exit 0, no drift reported. If the local DB is unavailable, note it in the commit message and rely on CI.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-04-device-vulnerabilities-ticket-link.sql apps/api/src/db/schema/vulnerabilityManagement.ts
git commit -m "feat(api): add device_vulnerabilities.ticket_id linkage column"
```

---

### Task 2: Pure aggregation service `vulnerabilityFleetAggregation.ts`

**Files:**
- Create: `apps/api/src/services/vulnerabilityFleetAggregation.ts`
- Test: `apps/api/src/services/vulnerabilityFleetAggregation.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no db).
- Produces (used by Tasks 3–4 routes and mirrored by web types in Task 9):
  - `interface FleetFindingRow` — the raw per-finding row shape (see code below).
  - `buildGroupKey(row): string`
  - `filterFindings(rows: FleetFindingRow[], f: FleetFindingFilters): FleetFindingRow[]`
  - `groupFindings(rows: FleetFindingRow[], opts?: { search?: string }): SoftwareGroup[]` — sorted `maxRiskScore` desc.
  - `computeStats(rows: FleetFindingRow[], now: Date): FleetVulnStats`
  - `buildGroupDetail(groupKey: string, rows: FleetFindingRow[]): SoftwareGroupDetail | null`
  - `toGroupFinding(row: FleetFindingRow): GroupFinding`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/vulnerabilityFleetAggregation.test.ts` (pure-function pattern, zero mocks — same style as `vulnerabilityRiskScore.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import {
  buildGroupKey,
  buildGroupDetail,
  computeStats,
  filterFindings,
  groupFindings,
  type FleetFindingRow,
} from './vulnerabilityFleetAggregation';

function row(overrides: Partial<FleetFindingRow> = {}): FleetFindingRow {
  return {
    deviceVulnerabilityId: 'dv-1',
    deviceId: 'dev-1',
    orgId: 'org-1',
    status: 'open',
    riskScore: 75,
    detectedAt: '2026-06-01T00:00:00.000Z',
    acceptedUntil: null,
    ticketId: null,
    softwareInventoryId: 'sw-1',
    softwareName: 'Google Chrome',
    softwareVendor: 'Google LLC',
    softwareVersion: '126.0.1',
    deviceName: 'WS-01',
    deviceOsType: 'windows',
    orgName: 'Acme',
    cveId: 'CVE-2026-0001',
    vulnerabilityId: 'v-1',
    severity: 'high',
    cvssScore: 8.1,
    epssScore: 0.4,
    knownExploited: false,
    patchAvailable: true,
    ...overrides,
  };
}

describe('buildGroupKey', () => {
  it('normalizes software name/vendor with lower(trim(...)) matching the correlation JOIN', () => {
    expect(buildGroupKey(row({ softwareName: '  Google Chrome ', softwareVendor: ' Google LLC ' })))
      .toBe('sw:google chrome|google llc');
  });

  it('treats null vendor as empty string', () => {
    expect(buildGroupKey(row({ softwareVendor: null }))).toBe('sw:google chrome|');
  });

  it('maps OS findings (null softwareInventoryId) to per-platform pseudo-groups', () => {
    expect(buildGroupKey(row({ softwareInventoryId: null, deviceOsType: 'macos' }))).toBe('os:macos');
  });
});

describe('filterFindings', () => {
  const rows = [
    row({ deviceVulnerabilityId: 'a', status: 'open', severity: 'critical', knownExploited: true }),
    row({ deviceVulnerabilityId: 'b', status: 'accepted', severity: 'high', patchAvailable: false }),
    row({ deviceVulnerabilityId: 'c', status: 'open', severity: 'low', knownExploited: false }),
  ];

  it('filters by status, passing everything through for "all"', () => {
    expect(filterFindings(rows, { status: 'open' }).map((r) => r.deviceVulnerabilityId)).toEqual(['a', 'c']);
    expect(filterFindings(rows, { status: 'all' })).toHaveLength(3);
  });

  it('applies severity, kevOnly, and patchAvailable finding-level filters', () => {
    expect(filterFindings(rows, { status: 'all', severity: 'critical' }).map((r) => r.deviceVulnerabilityId)).toEqual(['a']);
    expect(filterFindings(rows, { status: 'all', kevOnly: true }).map((r) => r.deviceVulnerabilityId)).toEqual(['a']);
    expect(filterFindings(rows, { status: 'all', patchAvailable: true }).map((r) => r.deviceVulnerabilityId)).toEqual(['a', 'c']);
  });
});

describe('groupFindings', () => {
  it('groups by normalized software identity and counts distinct devices/CVEs', () => {
    const groups = groupFindings([
      row({ deviceVulnerabilityId: 'a', deviceId: 'dev-1', cveId: 'CVE-1' }),
      row({ deviceVulnerabilityId: 'b', deviceId: 'dev-2', cveId: 'CVE-1', softwareName: 'google chrome' }),
      row({ deviceVulnerabilityId: 'c', deviceId: 'dev-1', cveId: 'CVE-2' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.deviceCount).toBe(2);
    expect(groups[0]!.cveCount).toBe(2);
    expect(groups[0]!.kind).toBe('software');
  });

  it('rolls OS findings into per-platform pseudo-groups with display names', () => {
    const groups = groupFindings([
      row({ softwareInventoryId: null, deviceOsType: 'windows' }),
      row({ deviceVulnerabilityId: 'b', deviceId: 'dev-2', softwareInventoryId: null, deviceOsType: 'macos' }),
    ]);
    const names = groups.map((g) => g.name).sort();
    expect(names).toEqual(['Windows OS updates', 'macOS updates']);
    expect(groups.every((g) => g.kind === 'os' && g.vendor === null)).toBe(true);
  });

  it('computes worstSeverity / maxRiskScore / maxEpss / kevCveCount / patch-ready counts', () => {
    const groups = groupFindings([
      row({ deviceVulnerabilityId: 'a', deviceId: 'dev-1', cveId: 'CVE-1', severity: 'high', riskScore: 70, epssScore: 0.2, knownExploited: false, patchAvailable: true, status: 'open' }),
      row({ deviceVulnerabilityId: 'b', deviceId: 'dev-2', cveId: 'CVE-2', severity: 'critical', riskScore: 95, epssScore: 0.9, knownExploited: true, patchAvailable: false, status: 'open' }),
      row({ deviceVulnerabilityId: 'c', deviceId: 'dev-2', cveId: 'CVE-1', severity: 'high', riskScore: 60, epssScore: 0.2, knownExploited: false, patchAvailable: true, status: 'accepted' }),
    ]);
    const g = groups[0]!;
    expect(g.worstSeverity).toBe('critical');
    expect(g.maxRiskScore).toBe(95);
    expect(g.maxEpss).toBe(0.9);
    expect(g.kevCveCount).toBe(1);
    // patch-ready counts only OPEN findings with a patch-available CVE
    expect(g.patchReadyFindingCount).toBe(1);
    expect(g.patchReadyDeviceCount).toBe(1);
  });

  it('sorts by maxRiskScore desc with nulls last', () => {
    const groups = groupFindings([
      row({ softwareName: 'Low', riskScore: 10 }),
      row({ deviceVulnerabilityId: 'b', softwareName: 'None', riskScore: null }),
      row({ deviceVulnerabilityId: 'c', softwareName: 'High', riskScore: 90 }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['High', 'Low', 'None']);
  });

  it('applies search across group name, vendor, and member CVE ids (case-insensitive)', () => {
    const rows = [
      row({ softwareName: 'Google Chrome', cveId: 'CVE-2026-0001' }),
      row({ deviceVulnerabilityId: 'b', softwareName: 'Zoom', softwareVendor: 'Zoom Video', cveId: 'CVE-2026-9999' }),
    ];
    expect(groupFindings(rows, { search: 'chrome' })).toHaveLength(1);
    expect(groupFindings(rows, { search: '9999' })[0]!.name).toBe('Zoom');
    expect(groupFindings(rows, { search: 'ZOOM VIDEO' })).toHaveLength(1);
    expect(groupFindings(rows, { search: 'nomatch' })).toHaveLength(0);
  });

  it('collects distinct ticketIds and versions', () => {
    const g = groupFindings([
      row({ ticketId: 't-1', softwareVersion: '2.0' }),
      row({ deviceVulnerabilityId: 'b', ticketId: 't-1', softwareVersion: '10.0' }),
      row({ deviceVulnerabilityId: 'c', ticketId: null, softwareVersion: '2.0' }),
    ])[0]!;
    expect(g.ticketIds).toEqual(['t-1']);
    expect(g.versions).toEqual(['2.0', '10.0']); // numeric-aware sort
  });
});

describe('computeStats', () => {
  const now = new Date('2026-07-05T00:00:00.000Z');

  it('computes the four stat-card numbers', () => {
    const stats = computeStats([
      row({ status: 'open', severity: 'critical' }),                                   // criticalOpen + patchReady
      row({ deviceVulnerabilityId: 'b', deviceId: 'dev-2', status: 'open', severity: 'high', knownExploited: true, cveId: 'CVE-K', patchAvailable: false }), // kev
      row({ deviceVulnerabilityId: 'c', deviceId: 'dev-3', status: 'open', severity: 'high', knownExploited: true, cveId: 'CVE-K', patchAvailable: false }), // same kev cve, 2nd device
      row({ deviceVulnerabilityId: 'd', status: 'accepted', acceptedUntil: '2026-07-10T00:00:00.000Z' }),  // expiring within 14d
      row({ deviceVulnerabilityId: 'e', status: 'accepted', acceptedUntil: '2026-12-01T00:00:00.000Z' }),  // not expiring soon
      row({ deviceVulnerabilityId: 'f', status: 'accepted', acceptedUntil: '2026-07-01T00:00:00.000Z' }),  // already expired — not counted
    ], now);
    expect(stats.criticalOpen).toBe(1);
    expect(stats.kevCveCount).toBe(1);
    expect(stats.kevDeviceCount).toBe(2);
    expect(stats.patchReadyFindingCount).toBe(1);
    expect(stats.acceptedExpiringSoon).toBe(1);
  });
});

describe('buildGroupDetail', () => {
  it('returns null for an unknown group', () => {
    expect(buildGroupDetail('sw:nope|', [row()])).toBeNull();
  });

  it('returns group summary + distinct CVEs (max risk each) + flat findings', () => {
    const detail = buildGroupDetail('sw:google chrome|google llc', [
      row({ deviceVulnerabilityId: 'a', cveId: 'CVE-1', riskScore: 60 }),
      row({ deviceVulnerabilityId: 'b', deviceId: 'dev-2', cveId: 'CVE-1', riskScore: 80 }),
      row({ deviceVulnerabilityId: 'c', cveId: 'CVE-2', riskScore: 40 }),
      row({ deviceVulnerabilityId: 'x', softwareName: 'Other App' }), // different group — excluded
    ]);
    expect(detail).not.toBeNull();
    expect(detail!.cves.map((c) => c.cveId)).toEqual(['CVE-1', 'CVE-2']); // sorted by maxRiskScore desc
    expect(detail!.cves[0]!.maxRiskScore).toBe(80);
    expect(detail!.findings).toHaveLength(3);
    expect(detail!.findings[0]).toMatchObject({ deviceVulnerabilityId: expect.any(String), deviceName: expect.any(String), status: 'open' });
    expect(detail!.group.deviceCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm vitest run src/services/vulnerabilityFleetAggregation.test.ts`
Expected: FAIL — cannot resolve `./vulnerabilityFleetAggregation`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/vulnerabilityFleetAggregation.ts`:

```ts
/**
 * Pure aggregation logic for the fleet vulnerabilities triage UI.
 *
 * Grouping key contract (opaque, URL-safe once encodeURIComponent'd, stable
 * across requests so `#software/<groupKey>` deep links work):
 *   software finding:  sw:<lower(trim(name))>|<lower(trim(coalesce(vendor,'')))>
 *   OS finding:        os:<devices.osType>          (softwareInventoryId IS NULL)
 * The lower(trim(...)) normalization deliberately matches the correlation
 * pipeline's JOIN (services/vulnerabilityCorrelation.ts) so one product maps
 * to one queue row regardless of inventory casing.
 *
 * No db access here — routes fetch FleetFindingRow[] via
 * services/vulnerabilityFleetQueries.ts and pass them in.
 */

export interface FleetFindingRow {
  deviceVulnerabilityId: string;
  deviceId: string;
  orgId: string;
  status: string; // open | patched | mitigated | accepted
  riskScore: number | null;
  detectedAt: string; // ISO
  acceptedUntil: string | null; // ISO
  ticketId: string | null;
  softwareInventoryId: string | null;
  softwareName: string | null;
  softwareVendor: string | null;
  softwareVersion: string | null;
  deviceName: string;
  deviceOsType: 'windows' | 'macos' | 'linux';
  orgName: string | null;
  cveId: string;
  vulnerabilityId: string;
  severity: string | null;
  cvssScore: number | null;
  epssScore: number | null;
  knownExploited: boolean;
  patchAvailable: boolean;
}

export interface FleetFindingFilters {
  status: string; // open | patched | mitigated | accepted | all
  severity?: string;
  kevOnly?: boolean;
  patchAvailable?: boolean;
}

export interface SoftwareGroup {
  groupKey: string;
  kind: 'software' | 'os';
  name: string;
  vendor: string | null;
  versions: string[];
  deviceCount: number;
  cveCount: number;
  cveIds: string[];
  worstSeverity: string | null;
  maxRiskScore: number | null;
  kevCveCount: number;
  maxEpss: number | null;
  /** Open findings whose CVE has a patch available ("fixable right now"). */
  patchReadyFindingCount: number;
  /** Distinct devices with at least one patch-ready open finding. */
  patchReadyDeviceCount: number;
  ticketIds: string[];
}

export interface FleetVulnStats {
  criticalOpen: number;
  kevCveCount: number;
  kevDeviceCount: number;
  patchReadyFindingCount: number;
  acceptedExpiringSoon: number;
}

export interface GroupCve {
  cveId: string;
  vulnerabilityId: string;
  severity: string | null;
  cvssScore: number | null;
  epssScore: number | null;
  knownExploited: boolean;
  patchAvailable: boolean;
  maxRiskScore: number | null;
}

export interface GroupFinding {
  deviceVulnerabilityId: string;
  deviceId: string;
  deviceName: string;
  orgId: string;
  orgName: string | null;
  cveId: string;
  status: string;
  patchAvailable: boolean;
  riskScore: number | null;
  detectedAt: string;
  ticketId: string | null;
}

export interface SoftwareGroupDetail {
  group: SoftwareGroup;
  cves: GroupCve[];
  findings: GroupFinding[];
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

const OS_GROUP_NAMES: Record<FleetFindingRow['deviceOsType'], string> = {
  windows: 'Windows OS updates',
  macos: 'macOS updates',
  linux: 'Linux OS updates',
};

const ACCEPTED_EXPIRING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function buildGroupKey(
  row: Pick<FleetFindingRow, 'softwareInventoryId' | 'softwareName' | 'softwareVendor' | 'deviceOsType'>,
): string {
  if (row.softwareInventoryId === null) return `os:${row.deviceOsType}`;
  const name = (row.softwareName ?? '').trim().toLowerCase();
  const vendor = (row.softwareVendor ?? '').trim().toLowerCase();
  return `sw:${name}|${vendor}`;
}

export function filterFindings(rows: FleetFindingRow[], f: FleetFindingFilters): FleetFindingRow[] {
  return rows.filter((r) => {
    if (f.status !== 'all' && r.status !== f.status) return false;
    if (f.severity && (r.severity ?? '').toLowerCase() !== f.severity) return false;
    if (f.kevOnly && !r.knownExploited) return false;
    if (f.patchAvailable && !r.patchAvailable) return false;
    return true;
  });
}

function summarizeGroup(groupKey: string, bucket: FleetFindingRow[]): SoftwareGroup {
  const first = bucket[0]!;
  const kind: SoftwareGroup['kind'] = groupKey.startsWith('os:') ? 'os' : 'software';
  const cveIds = new Set<string>();
  const kevCves = new Set<string>();
  const deviceIds = new Set<string>();
  const patchReadyDevices = new Set<string>();
  const versions = new Set<string>();
  const ticketIds = new Set<string>();
  let worst: string | null = null;
  let maxRisk: number | null = null;
  let maxEpss: number | null = null;
  let patchReadyFindingCount = 0;

  for (const r of bucket) {
    cveIds.add(r.cveId);
    if (r.knownExploited) kevCves.add(r.cveId);
    deviceIds.add(r.deviceId);
    if (r.softwareVersion) versions.add(r.softwareVersion);
    if (r.ticketId) ticketIds.add(r.ticketId);
    if (r.patchAvailable && r.status === 'open') {
      patchReadyFindingCount += 1;
      patchReadyDevices.add(r.deviceId);
    }
    const sev = (r.severity ?? '').toLowerCase();
    if ((SEVERITY_RANK[sev] ?? 0) > (worst ? (SEVERITY_RANK[worst] ?? 0) : 0)) worst = sev;
    if (r.riskScore !== null && (maxRisk === null || r.riskScore > maxRisk)) maxRisk = r.riskScore;
    if (r.epssScore !== null && (maxEpss === null || r.epssScore > maxEpss)) maxEpss = r.epssScore;
  }

  return {
    groupKey,
    kind,
    name: kind === 'os' ? OS_GROUP_NAMES[first.deviceOsType] : ((first.softwareName ?? '').trim() || 'Unknown software'),
    vendor: kind === 'os' ? null : (first.softwareVendor?.trim() || null),
    versions: [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    deviceCount: deviceIds.size,
    cveCount: cveIds.size,
    cveIds: [...cveIds].sort(),
    worstSeverity: worst,
    maxRiskScore: maxRisk,
    kevCveCount: kevCves.size,
    maxEpss,
    patchReadyFindingCount,
    patchReadyDeviceCount: patchReadyDevices.size,
    ticketIds: [...ticketIds],
  };
}

export function groupFindings(rows: FleetFindingRow[], opts: { search?: string } = {}): SoftwareGroup[] {
  const buckets = new Map<string, FleetFindingRow[]>();
  for (const row of rows) {
    const key = buildGroupKey(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  let groups = [...buckets.entries()].map(([key, bucket]) => summarizeGroup(key, bucket));

  const search = opts.search?.trim().toLowerCase();
  if (search) {
    groups = groups.filter(
      (g) =>
        g.name.toLowerCase().includes(search) ||
        (g.vendor ?? '').toLowerCase().includes(search) ||
        g.cveIds.some((id) => id.toLowerCase().includes(search)),
    );
  }

  return groups.sort((a, b) => {
    const riskA = a.maxRiskScore ?? -1;
    const riskB = b.maxRiskScore ?? -1;
    if (riskB !== riskA) return riskB - riskA;
    if (b.deviceCount !== a.deviceCount) return b.deviceCount - a.deviceCount;
    return a.name.localeCompare(b.name);
  });
}

export function computeStats(rows: FleetFindingRow[], now: Date): FleetVulnStats {
  const kevCves = new Set<string>();
  const kevDevices = new Set<string>();
  let criticalOpen = 0;
  let patchReadyFindingCount = 0;
  let acceptedExpiringSoon = 0;
  const nowMs = now.getTime();
  const soonMs = nowMs + ACCEPTED_EXPIRING_WINDOW_MS;

  for (const r of rows) {
    if (r.status === 'open') {
      if ((r.severity ?? '').toLowerCase() === 'critical') criticalOpen += 1;
      if (r.knownExploited) {
        kevCves.add(r.cveId);
        kevDevices.add(r.deviceId);
      }
      if (r.patchAvailable) patchReadyFindingCount += 1;
    } else if (r.status === 'accepted' && r.acceptedUntil) {
      const t = new Date(r.acceptedUntil).getTime();
      if (t > nowMs && t <= soonMs) acceptedExpiringSoon += 1;
    }
  }

  return {
    criticalOpen,
    kevCveCount: kevCves.size,
    kevDeviceCount: kevDevices.size,
    patchReadyFindingCount,
    acceptedExpiringSoon,
  };
}

export function toGroupFinding(r: FleetFindingRow): GroupFinding {
  return {
    deviceVulnerabilityId: r.deviceVulnerabilityId,
    deviceId: r.deviceId,
    deviceName: r.deviceName,
    orgId: r.orgId,
    orgName: r.orgName,
    cveId: r.cveId,
    status: r.status,
    patchAvailable: r.patchAvailable,
    riskScore: r.riskScore,
    detectedAt: r.detectedAt,
    ticketId: r.ticketId,
  };
}

export function buildGroupDetail(groupKey: string, rows: FleetFindingRow[]): SoftwareGroupDetail | null {
  const bucket = rows.filter((r) => buildGroupKey(r) === groupKey);
  if (bucket.length === 0) return null;

  const cveMap = new Map<string, GroupCve>();
  for (const r of bucket) {
    const existing = cveMap.get(r.cveId);
    if (!existing) {
      cveMap.set(r.cveId, {
        cveId: r.cveId,
        vulnerabilityId: r.vulnerabilityId,
        severity: r.severity,
        cvssScore: r.cvssScore,
        epssScore: r.epssScore,
        knownExploited: r.knownExploited,
        patchAvailable: r.patchAvailable,
        maxRiskScore: r.riskScore,
      });
    } else if (r.riskScore !== null && (existing.maxRiskScore === null || r.riskScore > existing.maxRiskScore)) {
      existing.maxRiskScore = r.riskScore;
    }
  }

  const cves = [...cveMap.values()].sort((a, b) => (b.maxRiskScore ?? -1) - (a.maxRiskScore ?? -1));
  const findings = bucket
    .map(toGroupFinding)
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName) || a.cveId.localeCompare(b.cveId));

  return { group: summarizeGroup(groupKey, bucket), cves, findings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run src/services/vulnerabilityFleetAggregation.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/vulnerabilityFleetAggregation.ts apps/api/src/services/vulnerabilityFleetAggregation.test.ts
git commit -m "feat(api): pure fleet vulnerability aggregation service"
```

---

### Task 3: Fleet finding fetcher + `GET /vulnerabilities/software` + `GET /vulnerabilities/stats`

**Files:**
- Create: `apps/api/src/services/vulnerabilityFleetQueries.ts`
- Modify: `apps/api/src/routes/vulnerabilities.ts` (add imports; register the two GET routes after the existing `GET /` handler at ~line 353)
- Test: `apps/api/src/routes/vulnerabilities.test.ts` (extend existing file)

**Interfaces:**
- Consumes: Task 2's `FleetFindingRow`, `filterFindings`, `groupFindings`, `computeStats`; Task 1's `ticketId` column.
- Produces:
  - `fetchFleetFindingRows(filters: { status: string; allowedSiteIds?: string[] }): Promise<FleetFindingRow[]>` (used by Tasks 4).
  - `fetchCveCatalogRecord(cveId: string): Promise<CveCatalogRecord | null>` (used by Task 4) where `CveCatalogRecord = { cveId, description, references: unknown, cvssVersion, cvssVector, cvssScore, epssScore, knownExploited, patchAvailable, severity, publishedAt, modifiedAt }` (scores as `number | null`, dates as ISO strings or null).
  - `GET /vulnerabilities/software?status&severity&search&kevOnly&patchAvailable` → `{ items: SoftwareGroup[], hasMore: boolean }`.
  - `GET /vulnerabilities/stats` → `FleetVulnStats`.
  - Route-file helper `boolQuerySchema` (reused by Task 5).

- [ ] **Step 1: Write the failing route tests**

In `apps/api/src/routes/vulnerabilities.test.ts`, add to the mock block (next to the existing `vi.mock('../services/vulnerabilityRemediation', ...)` call):

```ts
vi.mock('../services/vulnerabilityFleetQueries', () => ({
  fetchFleetFindingRows: vi.fn(async () => []),
  fetchCveCatalogRecord: vi.fn(async () => null),
}));
```

Import next to the other post-mock imports:

```ts
import { fetchFleetFindingRows, fetchCveCatalogRecord } from '../services/vulnerabilityFleetQueries';
import type { FleetFindingRow } from '../services/vulnerabilityFleetAggregation';
```

Add a shared fixture helper near the top-level helpers (after the `post` helper):

```ts
function fleetRow(overrides: Partial<FleetFindingRow> = {}): FleetFindingRow {
  return {
    deviceVulnerabilityId: 'dv-1',
    deviceId: 'dev-1',
    orgId: 'org-1',
    status: 'open',
    riskScore: 75,
    detectedAt: '2026-06-01T00:00:00.000Z',
    acceptedUntil: null,
    ticketId: null,
    softwareInventoryId: 'sw-1',
    softwareName: 'Google Chrome',
    softwareVendor: 'Google LLC',
    softwareVersion: '126.0.1',
    deviceName: 'WS-01',
    deviceOsType: 'windows',
    orgName: 'Acme',
    cveId: 'CVE-2026-0001',
    vulnerabilityId: 'v-1',
    severity: 'critical',
    cvssScore: 9.1,
    epssScore: 0.4,
    knownExploited: true,
    patchAvailable: true,
    ...overrides,
  };
}
```

Then add the describe blocks:

```ts
describe('GET /vulnerabilities/software (fleet work queue)', () => {
  beforeEach(() => {
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
  });

  it('403s without devices:read', async () => {
    granted.clear();
    const res = await app().request('/vulnerabilities/software');
    expect(res.status).toBe(403);
  });

  it('groups findings and returns items + hasMore', async () => {
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(),
      fleetRow({ deviceVulnerabilityId: 'dv-2', deviceId: 'dev-2', softwareName: 'google chrome ' }),
    ]);
    const res = await app().request('/vulnerabilities/software');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasMore).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      groupKey: 'sw:google chrome|google llc',
      kind: 'software',
      deviceCount: 2,
    });
  });

  it('passes status through and forwards allowedSiteIds from the permissions context', async () => {
    permissionsState.allowedSiteIds = ['site-1'];
    const res = await app().request('/vulnerabilities/software?status=accepted');
    expect(res.status).toBe(200);
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith({
      status: 'accepted',
      allowedSiteIds: ['site-1'],
    });
  });

  it('applies severity/kevOnly/patchAvailable/search filters', async () => {
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(),
      fleetRow({ deviceVulnerabilityId: 'dv-2', softwareName: 'Zoom', softwareVendor: 'Zoom', severity: 'low', knownExploited: false, patchAvailable: false, cveId: 'CVE-2026-2' }),
    ]);
    const res = await app().request('/vulnerabilities/software?severity=critical&kevOnly=true&patchAvailable=true&search=chrome');
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('Google Chrome');
  });

  it('400s on an invalid boolean param', async () => {
    const res = await app().request('/vulnerabilities/software?kevOnly=yes');
    expect(res.status).toBe(400);
  });
});

describe('GET /vulnerabilities/stats', () => {
  beforeEach(() => {
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
  });

  it('403s without devices:read', async () => {
    granted.clear();
    const res = await app().request('/vulnerabilities/stats');
    expect(res.status).toBe(403);
  });

  it('fetches ALL statuses and returns the four stat numbers', async () => {
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(), // open critical KEV patch-ready
      fleetRow({ deviceVulnerabilityId: 'dv-2', status: 'accepted', acceptedUntil: new Date(Date.now() + 5 * 864e5).toISOString() }),
    ]);
    const res = await app().request('/vulnerabilities/stats');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'all' }),
    );
    expect(body).toEqual({
      criticalOpen: 1,
      kevCveCount: 1,
      kevDeviceCount: 1,
      patchReadyFindingCount: 1,
      acceptedExpiringSoon: 1,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: FAIL — the new describes 404 (routes not registered) / cannot resolve `vulnerabilityFleetQueries`. Existing tests must still pass.

- [ ] **Step 3: Write the fetcher service**

Create `apps/api/src/services/vulnerabilityFleetQueries.ts`:

```ts
/**
 * DB fetch layer for the fleet vulnerabilities triage UI.
 *
 * Org isolation: RLS on the request's db context (same as the existing fleet
 * list in routes/vulnerabilities.ts). Site axis: app-layer narrowing via
 * allowedSiteIds -> devices.siteId (RLS does NOT cover sites). The global
 * `vulnerabilities` catalog is system-scoped reference data and is read under
 * a system context, mirroring readCatalogRows in routes/vulnerabilities.ts.
 */
import { and, eq, ilike, inArray, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceVulnerabilities, devices, organizations, softwareInventory, vulnerabilities } from '../db/schema';
import type { FleetFindingRow } from './vulnerabilityFleetAggregation';

export interface CveCatalogRecord {
  cveId: string;
  description: string;
  references: unknown;
  cvssVersion: string | null;
  cvssVector: string | null;
  cvssScore: number | null;
  epssScore: number | null;
  knownExploited: boolean;
  patchAvailable: boolean;
  severity: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function fetchFleetFindingRows(filters: {
  status: string;
  /** Site-axis narrowing; empty array = fail closed (return nothing). */
  allowedSiteIds?: string[];
}): Promise<FleetFindingRow[]> {
  const conditions: SQL[] = [];
  if (filters.status !== 'all') {
    conditions.push(eq(deviceVulnerabilities.status, filters.status));
  }
  if (filters.allowedSiteIds !== undefined) {
    if (filters.allowedSiteIds.length === 0) return [];
    const allowedDeviceRows = await db
      .select({ id: devices.id })
      .from(devices)
      .where(inArray(devices.siteId, filters.allowedSiteIds));
    const allowedDeviceIds = allowedDeviceRows.map((r) => r.id);
    if (allowedDeviceIds.length === 0) return [];
    conditions.push(inArray(deviceVulnerabilities.deviceId, allowedDeviceIds));
  }

  const findingRows = await db
    .select({
      id: deviceVulnerabilities.id,
      orgId: deviceVulnerabilities.orgId,
      deviceId: deviceVulnerabilities.deviceId,
      vulnerabilityId: deviceVulnerabilities.vulnerabilityId,
      softwareInventoryId: deviceVulnerabilities.softwareInventoryId,
      status: deviceVulnerabilities.status,
      riskScore: deviceVulnerabilities.riskScore,
      detectedAt: deviceVulnerabilities.detectedAt,
      acceptedUntil: deviceVulnerabilities.acceptedUntil,
      ticketId: deviceVulnerabilities.ticketId,
    })
    .from(deviceVulnerabilities)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  if (findingRows.length === 0) return [];

  const deviceIds = [...new Set(findingRows.map((r) => r.deviceId))];
  const deviceRows = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
    })
    .from(devices)
    .where(inArray(devices.id, deviceIds));
  const deviceById = new Map(deviceRows.map((d) => [d.id, d]));

  const orgIds = [...new Set(findingRows.map((r) => r.orgId))];
  const orgRows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(inArray(organizations.id, orgIds));
  const orgById = new Map(orgRows.map((o) => [o.id, o]));

  const swIds = [...new Set(findingRows.map((r) => r.softwareInventoryId).filter((v): v is string => v !== null))];
  const swRows =
    swIds.length > 0
      ? await db
          .select({
            id: softwareInventory.id,
            name: softwareInventory.name,
            vendor: softwareInventory.vendor,
            version: softwareInventory.version,
          })
          .from(softwareInventory)
          .where(inArray(softwareInventory.id, swIds))
      : [];
  const swById = new Map(swRows.map((s) => [s.id, s]));

  const vulnIds = [...new Set(findingRows.map((r) => r.vulnerabilityId))];
  const catalogRows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: vulnerabilities.id,
          cveId: vulnerabilities.cveId,
          severity: vulnerabilities.severity,
          cvssScore: vulnerabilities.cvssScore,
          epssScore: vulnerabilities.epssScore,
          knownExploited: vulnerabilities.knownExploited,
          patchAvailable: vulnerabilities.patchAvailable,
        })
        .from(vulnerabilities)
        .where(inArray(vulnerabilities.id, vulnIds)),
    ),
  );
  const catalogById = new Map(catalogRows.map((v) => [v.id, v]));

  const rows: FleetFindingRow[] = [];
  for (const f of findingRows) {
    const device = deviceById.get(f.deviceId);
    const catalog = catalogById.get(f.vulnerabilityId);
    // Orphaned rows (device deleted mid-request, catalog purge) — skip rather
    // than crash the whole queue.
    if (!device || !catalog) continue;
    const sw = f.softwareInventoryId ? swById.get(f.softwareInventoryId) : undefined;
    rows.push({
      deviceVulnerabilityId: f.id,
      deviceId: f.deviceId,
      orgId: f.orgId,
      status: f.status,
      riskScore: toNumber(f.riskScore),
      detectedAt: f.detectedAt.toISOString(),
      acceptedUntil: f.acceptedUntil ? f.acceptedUntil.toISOString() : null,
      ticketId: f.ticketId ?? null,
      softwareInventoryId: f.softwareInventoryId,
      // Inventory row can vanish between correlation and read; keep the finding
      // in the queue under a recognizable name instead of dropping it.
      softwareName: f.softwareInventoryId ? (sw?.name ?? 'Unknown software') : null,
      softwareVendor: sw?.vendor ?? null,
      softwareVersion: sw?.version ?? null,
      deviceName: device.displayName ?? device.hostname,
      deviceOsType: device.osType,
      orgName: orgById.get(f.orgId)?.name ?? null,
      cveId: catalog.cveId,
      vulnerabilityId: f.vulnerabilityId,
      severity: catalog.severity,
      cvssScore: toNumber(catalog.cvssScore),
      epssScore: toNumber(catalog.epssScore),
      knownExploited: catalog.knownExploited ?? false,
      patchAvailable: catalog.patchAvailable ?? false,
    });
  }
  return rows;
}

export async function fetchCveCatalogRecord(cveId: string): Promise<CveCatalogRecord | null> {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          cveId: vulnerabilities.cveId,
          description: vulnerabilities.description,
          references: vulnerabilities.references,
          cvssVersion: vulnerabilities.cvssVersion,
          cvssVector: vulnerabilities.cvssVector,
          cvssScore: vulnerabilities.cvssScore,
          epssScore: vulnerabilities.epssScore,
          knownExploited: vulnerabilities.knownExploited,
          patchAvailable: vulnerabilities.patchAvailable,
          severity: vulnerabilities.severity,
          publishedAt: vulnerabilities.publishedAt,
          modifiedAt: vulnerabilities.modifiedAt,
        })
        .from(vulnerabilities)
        .where(ilike(vulnerabilities.cveId, cveId))
        .limit(1),
    ),
  );
  if (!row) return null;
  return {
    ...row,
    cvssScore: toNumber(row.cvssScore),
    epssScore: toNumber(row.epssScore),
    knownExploited: row.knownExploited ?? false,
    patchAvailable: row.patchAvailable ?? false,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    modifiedAt: row.modifiedAt ? row.modifiedAt.toISOString() : null,
  };
}
```

- [ ] **Step 4: Register the routes**

In `apps/api/src/routes/vulnerabilities.ts`, add to the imports:

```ts
import { computeStats, filterFindings, groupFindings } from '../services/vulnerabilityFleetAggregation';
import { fetchFleetFindingRows } from '../services/vulnerabilityFleetQueries';
```

Add next to the existing inline zod schemas (after `mitigateSchema`, ~line 60):

```ts
// Query-string boolean: accepts "true"/"false" (any case), rejects everything else.
const boolQuerySchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');

const softwareQuerySchema = z.object({
  status: statusSchema.default('open'),
  severity: severitySchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  kevOnly: boolQuerySchema.optional(),
  patchAvailable: boolQuerySchema.optional(),
});

const SOFTWARE_GROUP_CAP = 500;
```

Register the routes immediately AFTER the existing `vulnerabilityRoutes.get('/', ...)` handler (~line 353) — static paths must be registered before the `/:cveId/devices` param route added in Task 4:

```ts
// Fleet work queue: one row per remediation unit (software product or OS
// pseudo-group). Group cardinality is fleet-bounded; hard cap + hasMore
// instead of pagination.
vulnerabilityRoutes.get('/software', zValidator('query', softwareQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const perms = c.get('permissions') as UserPermissions | undefined;
  const rows = await fetchFleetFindingRows({
    status: query.status,
    allowedSiteIds: perms?.allowedSiteIds,
  });
  const filtered = filterFindings(rows, {
    status: query.status,
    severity: query.severity,
    kevOnly: query.kevOnly,
    patchAvailable: query.patchAvailable,
  });
  const groups = groupFindings(filtered, { search: query.search });
  return c.json({
    items: groups.slice(0, SOFTWARE_GROUP_CAP),
    hasMore: groups.length > SOFTWARE_GROUP_CAP,
  });
});

// The four stat-card numbers in one call. Needs every status: open findings
// feed three cards, accepted findings feed the expiring-soon card.
vulnerabilityRoutes.get('/stats', async (c) => {
  const perms = c.get('permissions') as UserPermissions | undefined;
  const rows = await fetchFleetFindingRows({
    status: 'all',
    allowedSiteIds: perms?.allowedSiteIds,
  });
  return c.json(computeStats(rows, new Date()));
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: PASS — new describes green, all pre-existing tests still green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/vulnerabilityFleetQueries.ts apps/api/src/routes/vulnerabilities.ts apps/api/src/routes/vulnerabilities.test.ts
git commit -m "feat(api): fleet software-group and stats endpoints"
```

---

### Task 4: `GET /vulnerabilities/software/:groupKey` + `GET /vulnerabilities/:cveId/devices`

**Files:**
- Modify: `apps/api/src/routes/vulnerabilities.ts`
- Test: `apps/api/src/routes/vulnerabilities.test.ts`

**Interfaces:**
- Consumes: Task 2's `buildGroupDetail`, `toGroupFinding`; Task 3's `fetchFleetFindingRows`, `fetchCveCatalogRecord`.
- Produces:
  - `GET /vulnerabilities/software/:groupKey` → `SoftwareGroupDetail` (`{ group, cves, findings }`) or 404 `{ error: 'Group not found' }`.
  - `GET /vulnerabilities/:cveId/devices` → `{ cve: CveCatalogRecord, findings: GroupFinding[] }` or 404 `{ error: 'CVE not found' }`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/vulnerabilities.test.ts` (uses `fleetRow` from Task 3):

```ts
describe('GET /vulnerabilities/software/:groupKey (drawer payload)', () => {
  beforeEach(() => {
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
  });

  it('404s for an unknown group', async () => {
    const res = await app().request(`/vulnerabilities/software/${encodeURIComponent('sw:nope|')}`);
    expect(res.status).toBe(404);
  });

  it('400s on a key without the sw:/os: prefix', async () => {
    const res = await app().request('/vulnerabilities/software/garbage');
    expect(res.status).toBe(400);
  });

  it('returns group + cves + findings for a URL-encoded key, across ALL statuses', async () => {
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(),
      fleetRow({ deviceVulnerabilityId: 'dv-2', deviceId: 'dev-2', status: 'accepted', cveId: 'CVE-2026-0002', vulnerabilityId: 'v-2' }),
    ]);
    const res = await app().request(`/vulnerabilities/software/${encodeURIComponent('sw:google chrome|google llc')}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'all' }),
    );
    const body = await res.json();
    expect(body.group.groupKey).toBe('sw:google chrome|google llc');
    expect(body.cves).toHaveLength(2);
    expect(body.findings).toHaveLength(2);
    expect(body.findings[0]).toMatchObject({ deviceVulnerabilityId: expect.any(String), deviceName: expect.any(String) });
  });
});

describe('GET /vulnerabilities/:cveId/devices (CVE drawer payload)', () => {
  beforeEach(() => {
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
    vi.mocked(fetchCveCatalogRecord).mockReset().mockResolvedValue(null);
  });

  it('400s on a non-CVE-shaped id', async () => {
    const res = await app().request('/vulnerabilities/not-a-cve/devices');
    expect(res.status).toBe(400);
  });

  it('404s when the CVE is not in the catalog', async () => {
    const res = await app().request('/vulnerabilities/CVE-2026-0001/devices');
    expect(res.status).toBe(404);
  });

  it('returns the catalog record + fleet findings for the CVE (case-insensitive match)', async () => {
    vi.mocked(fetchCveCatalogRecord).mockResolvedValue({
      cveId: 'CVE-2026-0001',
      description: 'Bad bug',
      references: ['https://example.test/advisory'],
      cvssVersion: '3.1',
      cvssVector: 'CVSS:3.1/AV:N',
      cvssScore: 9.1,
      epssScore: 0.4,
      knownExploited: true,
      patchAvailable: true,
      severity: 'critical',
      publishedAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: null,
    });
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(),
      fleetRow({ deviceVulnerabilityId: 'dv-2', cveId: 'CVE-2026-9999', vulnerabilityId: 'v-9' }), // other CVE — excluded
    ]);
    const res = await app().request('/vulnerabilities/cve-2026-0001/devices');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cve.cveId).toBe('CVE-2026-0001');
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].deviceVulnerabilityId).toBe('dv-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: FAIL — new endpoints 404/miss.

- [ ] **Step 3: Implement the routes**

In `apps/api/src/routes/vulnerabilities.ts`, extend the aggregation import:

```ts
import { buildGroupDetail, computeStats, filterFindings, groupFindings, toGroupFinding } from '../services/vulnerabilityFleetAggregation';
import { fetchCveCatalogRecord, fetchFleetFindingRows } from '../services/vulnerabilityFleetQueries';
```

Add schemas next to `softwareQuerySchema`:

```ts
const groupKeyParamSchema = z.object({
  // Opaque group key: sw:<name>|<vendor> or os:<platform>. Hono decodes the
  // URL-encoded segment before validation.
  groupKey: z.string().min(4).max(600).regex(/^(sw:|os:)/),
});

const cveIdParamSchema = z.object({
  // Real-world CVE ids are CVE-YYYY-NNNN+, but seeded/e2e ids use letters too.
  cveId: z.string().trim().regex(/^CVE-\d{4}-[A-Za-z0-9-]{1,32}$/i),
});
```

Register `GET /software/:groupKey` directly after the `GET /software` handler:

```ts
vulnerabilityRoutes.get('/software/:groupKey', zValidator('param', groupKeyParamSchema), async (c) => {
  const { groupKey } = c.req.valid('param');
  const perms = c.get('permissions') as UserPermissions | undefined;
  // status 'all' so the drawer can show accepted/mitigated findings alongside
  // open ones (reopen lives in the drawers).
  const rows = await fetchFleetFindingRows({ status: 'all', allowedSiteIds: perms?.allowedSiteIds });
  const detail = buildGroupDetail(groupKey, rows);
  if (!detail) {
    return c.json({ error: 'Group not found' }, 404);
  }
  return c.json(detail);
});
```

Register `GET /:cveId/devices` LAST among the GET routes in this file (after `/software/:groupKey`, `/stats`, and the existing `/device/:deviceId` if present — a param in the first segment must not shadow static paths):

```ts
vulnerabilityRoutes.get('/:cveId/devices', zValidator('param', cveIdParamSchema), async (c) => {
  const { cveId } = c.req.valid('param');
  const cve = await fetchCveCatalogRecord(cveId);
  if (!cve) {
    return c.json({ error: 'CVE not found' }, 404);
  }
  const perms = c.get('permissions') as UserPermissions | undefined;
  const rows = await fetchFleetFindingRows({ status: 'all', allowedSiteIds: perms?.allowedSiteIds });
  const target = cveId.toLowerCase();
  const findings = rows
    .filter((r) => r.cveId.toLowerCase() === target)
    .map(toGroupFinding)
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName));
  return c.json({ cve, findings });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/vulnerabilities.ts apps/api/src/routes/vulnerabilities.test.ts
git commit -m "feat(api): software-group detail and CVE devices drawer endpoints"
```

---

### Task 5: Extend fleet `GET /vulnerabilities` with `kevOnly` / `patchAvailable` + richer aggregate rows

**Files:**
- Modify: `apps/api/src/routes/vulnerabilities.ts` (`listQuerySchema` ~line 35, `readCatalogRows` ~lines 194–226, `FleetRow` type ~lines 288–297, `aggregateFleet`/`mergeRows` ~lines 159–336)
- Test: `apps/api/src/routes/vulnerabilities.test.ts`

**Interfaces:**
- Consumes: Task 3's `boolQuerySchema`.
- Produces: `GET /vulnerabilities?status&severity&cve&kevOnly&patchAvailable` where the aggregated `FleetRow` gains `patchAvailable: boolean` and `statuses: string[]` (distinct finding statuses in the aggregate). The `cve` filter becomes a substring match. Web Task 11 consumes these fields.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/vulnerabilities.test.ts`:

```ts
describe('GET /vulnerabilities — kevOnly/patchAvailable params', () => {
  beforeEach(() => {
    granted.clear();
    delete permissionsState.allowedSiteIds;
    granted.add('devices:read');
    vi.mocked(db.select).mockReset();
  });

  it('accepts kevOnly/patchAvailable and still 200s', async () => {
    // db.select falls back to the default mock chain (resolves []), so an
    // empty fleet is fine — this asserts schema acceptance, not data flow.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    } as never);
    const res = await app().request('/vulnerabilities?kevOnly=true&patchAvailable=false');
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });

  it('400s on malformed boolean params', async () => {
    const res = await app().request('/vulnerabilities?kevOnly=1');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: FAIL — `kevOnly=true` currently 200s but `kevOnly=1` also 200s (unknown query keys ignored), so the 400 assertion fails.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/vulnerabilities.ts`:

1. Extend `listQuerySchema`:

```ts
const listQuerySchema = z.object({
  status: statusSchema.default('open'),
  severity: severitySchema.optional(),
  cve: z.string().trim().min(1).max(32).optional(),
  kevOnly: boolQuerySchema.optional(),
  patchAvailable: boolQuerySchema.optional(),
});
```

(If `boolQuerySchema` is declared below `listQuerySchema`, move it above.)

2. Thread the new filters through `listVulnerabilities` → `readCatalogRows`. In `readCatalogRows`'s filter-building block, add:

```ts
if (filters.kevOnly) {
  catalogConditions.push(eq(vulnerabilities.knownExploited, true));
}
if (filters.patchAvailable) {
  catalogConditions.push(eq(vulnerabilities.patchAvailable, true));
}
```

(Adapt the array name to the file's actual local — the function already collects `severity`/`cve` conditions; extend its `filters` parameter type with `kevOnly?: boolean; patchAvailable?: boolean`.)

3. Make the `cve` filter a substring match — change the existing `ilike(vulnerabilities.cveId, filters.cve)` to:

```ts
ilike(vulnerabilities.cveId, `%${filters.cve}%`)
```

so the shared filter-bar text search matches partial CVE ids on the `#cves` tab.

4. Extend the `FleetRow` type with:

```ts
  patchAvailable: boolean;
  statuses: string[];
```

and in `aggregateFleet` (which folds merged finding+catalog rows into one row per `vulnerabilityId`), carry `patchAvailable` from the catalog side and collect the distinct finding `status` values per aggregate into `statuses` (sorted, e.g. `[...new Set(statusesForThisCve)].sort()`). `mergeRows` already carries `status` on each merged item and `patchAvailable` is already projected by `readCatalogRows` — wire them through to the aggregate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: PASS (including all pre-existing fleet GET tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/vulnerabilities.ts apps/api/src/routes/vulnerabilities.test.ts
git commit -m "feat(api): kevOnly/patchAvailable filters and richer fleet CVE rows"
```

---

### Task 6: Bulk accept-risk + bulk mitigate endpoints

**Files:**
- Modify: `apps/api/src/routes/vulnerabilities.ts`
- Test: `apps/api/src/routes/vulnerabilities.test.ts`

**Interfaces:**
- Consumes: existing `loadFindingForWrite` pattern (`routes/vulnerabilities.ts:78-124`), `writeRouteAudit`, `PERMISSIONS.VULN_RISK_ACCEPT`, `requireVulnerabilityWrite`.
- Produces:
  - `POST /vulnerabilities/bulk/accept-risk` `{ deviceVulnerabilityIds, reason, acceptedUntil }` → `{ success, succeeded, skipped }`; permission `vulnerabilities:accept_risk`; per-item audit `vulnerability.accept_risk`.
  - `POST /vulnerabilities/bulk/mitigate` `{ deviceVulnerabilityIds, note }` → same shape; permission `devices:write`; per-item audit `vulnerability.mitigate`.
  - Route-file helper `loadFindingsForBulkWrite(ids, auth)` (reused by Task 7).

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/vulnerabilities.test.ts`. The db mock needs scripted chains for: findings select (`.from().where()` resolving rows), devices select (same), and the update (`.set().where()`); the top-of-file `db` mock already supports `update`. Use `mockReturnValueOnce` chains like the existing site-narrowing tests:

```ts
function mockBulkSelects(findingRows: unknown[], deviceRows: unknown[]) {
  const selectMock = vi.mocked(db.select);
  selectMock.mockReset();
  selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(findingRows) }),
  } as never);
  selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(deviceRows) }),
  } as never);
}

const DV1 = '11111111-1111-1111-8111-111111111111';
const DV2 = '22222222-2222-2222-8222-222222222222';

describe('POST /vulnerabilities/bulk/accept-risk', () => {
  beforeEach(() => {
    vi.mocked(writeRouteAudit).mockClear();
  });

  it('403s without vulnerabilities:accept_risk', async () => {
    const res = await post('/bulk/accept-risk', { deviceVulnerabilityIds: [DV1], reason: 'x', acceptedUntil: future });
    expect(res.status).toBe(403);
  });

  it('400s on validation failures (empty ids, >200 ids, past acceptedUntil)', async () => {
    granted.add('vulnerabilities:accept_risk');
    expect((await post('/bulk/accept-risk', { deviceVulnerabilityIds: [], reason: 'x', acceptedUntil: future })).status).toBe(400);
    expect((await post('/bulk/accept-risk', {
      deviceVulnerabilityIds: Array.from({ length: 201 }, () => DV1),
      reason: 'x',
      acceptedUntil: future,
    })).status).toBe(400);
    expect((await post('/bulk/accept-risk', {
      deviceVulnerabilityIds: [DV1],
      reason: 'x',
      acceptedUntil: new Date(Date.now() - 864e5).toISOString(),
    })).status).toBe(400);
  });

  it('updates valid findings, skips unknown ids per-item, audits each success', async () => {
    granted.add('vulnerabilities:accept_risk');
    mockBulkSelects(
      [{ id: DV1, orgId: 'org-1', deviceId: 'dev-1', status: 'open' }],
      [{ id: 'dev-1', siteId: 'site-1' }],
    );
    const res = await post('/bulk/accept-risk', { deviceVulnerabilityIds: [DV1, DV2], reason: 'compensating control', acceptedUntil: future });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      succeeded: 1,
      skipped: [{ id: DV2, reason: 'finding not found' }],
    });
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'vulnerability.accept_risk', resourceId: DV1 }),
    );
  });

  it('reports success:false when every item is skipped', async () => {
    granted.add('vulnerabilities:accept_risk');
    mockBulkSelects([], []);
    const res = await post('/bulk/accept-risk', { deviceVulnerabilityIds: [DV1], reason: 'x', acceptedUntil: future });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.skipped).toHaveLength(1);
  });
});

describe('POST /vulnerabilities/bulk/mitigate', () => {
  it('403s for a caller without devices:write', async () => {
    const res = await post('/bulk/mitigate', { deviceVulnerabilityIds: [DV1], note: 'firewalled' });
    expect(res.status).toBe(403);
  });

  it('mitigates valid findings with per-item audit', async () => {
    granted.add('devices:write');
    mockBulkSelects(
      [{ id: DV1, orgId: 'org-1', deviceId: 'dev-1', status: 'open' }],
      [{ id: 'dev-1', siteId: 'site-1' }],
    );
    vi.mocked(writeRouteAudit).mockClear();
    const res = await post('/bulk/mitigate', { deviceVulnerabilityIds: [DV1], note: 'firewalled' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, succeeded: 1, skipped: [] });
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'vulnerability.mitigate', resourceId: DV1 }),
    );
  });
});
```

Note: the auth mock in this file sets `canAccessSite: () => true`; the per-item "site access denied" branch is covered indirectly by the helper's device-row filtering (a device the org/site narrowing removed → `finding not found`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: FAIL — bulk routes 404.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/vulnerabilities.ts`, add schemas next to the existing ones:

```ts
const bulkAcceptRiskSchema = z.object({
  deviceVulnerabilityIds: z.array(z.string().uuid()).min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
  acceptedUntil: z.string().datetime(),
});

const bulkMitigateSchema = z.object({
  deviceVulnerabilityIds: z.array(z.string().uuid()).min(1).max(200),
  note: z.string().trim().min(1).max(2000),
});
```

Add the bulk loader helper next to `loadFindingForWrite`:

```ts
type BulkFindingRow = { id: string; orgId: string; deviceId: string; status: string };
type BulkAccess = { valid: BulkFindingRow[]; skipped: Array<{ id: string; reason: string }> };

/**
 * Batch analogue of loadFindingForWrite: resolves each id to a finding the
 * caller may write (org via RLS + orgCondition on the device row, site via
 * canAccessSite), collecting per-item skip reasons instead of failing the
 * batch. Duplicate ids are collapsed.
 */
async function loadFindingsForBulkWrite(ids: string[], auth: AuthContext): Promise<BulkAccess> {
  const unique = [...new Set(ids)];
  const rows = await db
    .select({
      id: deviceVulnerabilities.id,
      orgId: deviceVulnerabilities.orgId,
      deviceId: deviceVulnerabilities.deviceId,
      status: deviceVulnerabilities.status,
    })
    .from(deviceVulnerabilities)
    .where(inArray(deviceVulnerabilities.id, unique));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const deviceIds = [...new Set(rows.map((r) => r.deviceId))];
  const orgCond = auth.orgCondition(devices.orgId);
  const deviceRows =
    deviceIds.length > 0
      ? await db
          .select({ id: devices.id, siteId: devices.siteId })
          .from(devices)
          .where(orgCond ? and(inArray(devices.id, deviceIds), orgCond) : inArray(devices.id, deviceIds))
      : [];
  const deviceById = new Map(deviceRows.map((d) => [d.id, d]));

  const valid: BulkFindingRow[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'finding not found' });
      continue;
    }
    const device = deviceById.get(row.deviceId);
    if (!device) {
      // Device outside the caller's org scope reads as not-found (no existence leak).
      skipped.push({ id, reason: 'finding not found' });
      continue;
    }
    if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) {
      skipped.push({ id, reason: 'site access denied' });
      continue;
    }
    valid.push(row);
  }
  return { valid, skipped };
}
```

Register the routes next to the existing per-finding `POST /:id/accept-risk` (bulk routes have a static first segment, so they never collide with `/:id/*`):

```ts
vulnerabilityRoutes.post(
  '/bulk/accept-risk',
  requirePermission(PERMISSIONS.VULN_RISK_ACCEPT.resource, PERMISSIONS.VULN_RISK_ACCEPT.action),
  zValidator('json', bulkAcceptRiskSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceVulnerabilityIds, reason, acceptedUntil } = c.req.valid('json');

    if (new Date(acceptedUntil).getTime() <= Date.now()) {
      return c.json({ success: false, error: 'acceptedUntil must be in the future' }, 400);
    }

    const { valid, skipped } = await loadFindingsForBulkWrite(deviceVulnerabilityIds, auth);
    if (valid.length > 0) {
      await db
        .update(deviceVulnerabilities)
        .set({
          status: 'accepted',
          acceptedBy: auth.user.id,
          acceptedUntil: new Date(acceptedUntil),
          // Acceptance rationale reuses mitigation_note — same as the
          // per-finding accept-risk endpoint (no dedicated reason column).
          mitigationNote: reason,
          updatedAt: new Date(),
        })
        .where(inArray(deviceVulnerabilities.id, valid.map((v) => v.id)));
      for (const row of valid) {
        writeRouteAudit(c, {
          orgId: row.orgId,
          action: 'vulnerability.accept_risk',
          resourceType: 'device_vulnerability',
          resourceId: row.id,
          details: { acceptedUntil, reason, bulk: true },
        });
      }
    }
    return c.json({ success: valid.length > 0, succeeded: valid.length, skipped });
  },
);

vulnerabilityRoutes.post(
  '/bulk/mitigate',
  requireVulnerabilityWrite,
  zValidator('json', bulkMitigateSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceVulnerabilityIds, note } = c.req.valid('json');

    const { valid, skipped } = await loadFindingsForBulkWrite(deviceVulnerabilityIds, auth);
    if (valid.length > 0) {
      await db
        .update(deviceVulnerabilities)
        .set({ status: 'mitigated', mitigationNote: note, resolvedAt: new Date(), updatedAt: new Date() })
        .where(inArray(deviceVulnerabilities.id, valid.map((v) => v.id)));
      for (const row of valid) {
        writeRouteAudit(c, {
          orgId: row.orgId,
          action: 'vulnerability.mitigate',
          resourceType: 'device_vulnerability',
          resourceId: row.id,
          details: { note, bulk: true },
        });
      }
    }
    return c.json({ success: valid.length > 0, succeeded: valid.length, skipped });
  },
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/vulnerabilities.ts apps/api/src/routes/vulnerabilities.test.ts
git commit -m "feat(api): bulk accept-risk and mitigate endpoints with per-item skips"
```

---

### Task 7: `POST /vulnerabilities/tickets` — create ticket(s) from findings

**Files:**
- Modify: `apps/api/src/routes/vulnerabilities.ts`
- Test: `apps/api/src/routes/vulnerabilities.test.ts`

**Interfaces:**
- Consumes: Task 1's `ticketId` column; Task 6's `loadFindingsForBulkWrite`; `createTicket(input, actor)` + `TicketServiceError` from `apps/api/src/services/ticketService.ts`; `PERMISSIONS.TICKETS_WRITE`.
- Produces: `POST /vulnerabilities/tickets` `{ deviceVulnerabilityIds (1–200), title (1–255), description? (≤50000), priority ('low'|'normal'|'high'|'urgent', default 'normal') }` → `{ success, tickets: [{ ticketId, orgId, findingCount }], skipped }`. Cross-org selections create one ticket per org. Audit `vulnerability.ticket_create` per ticket.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/vulnerabilities.test.ts`. New mock in the mock block (keep the real error class via `importActual` so `instanceof` works):

```ts
vi.mock('../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../services/ticketService')>('../services/ticketService');
  return { ...actual, createTicket: vi.fn() };
});
```

Post-mock import: `import { createTicket, TicketServiceError } from '../services/ticketService';`

The auth mock needs `canAccessOrg`; extend the mocked `authMiddleware`'s auth object with `canAccessOrg: (id: string) => id !== 'org-denied'` (adjust the existing `c.set('auth', {...})` literal).

```ts
describe('POST /vulnerabilities/tickets', () => {
  const DV_ORG2 = '33333333-3333-3333-8333-333333333333';

  beforeEach(() => {
    vi.mocked(createTicket).mockReset();
    vi.mocked(writeRouteAudit).mockClear();
  });

  it('403s without tickets:write', async () => {
    const res = await post('/tickets', { deviceVulnerabilityIds: [DV1], title: 'Patch Chrome' });
    expect(res.status).toBe(403);
  });

  it('400s on validation failures (missing title, >200 ids)', async () => {
    granted.add('tickets:write');
    expect((await post('/tickets', { deviceVulnerabilityIds: [DV1] })).status).toBe(400);
    expect((await post('/tickets', {
      deviceVulnerabilityIds: Array.from({ length: 201 }, () => DV1),
      title: 'x',
    })).status).toBe(400);
  });

  it('splits a cross-org selection into one ticket per org and stamps ticket_id', async () => {
    granted.add('tickets:write');
    mockBulkSelects(
      [
        { id: DV1, orgId: 'org-1', deviceId: 'dev-1', status: 'open' },
        { id: DV2, orgId: 'org-1', deviceId: 'dev-1', status: 'open' },
        { id: DV_ORG2, orgId: 'org-2', deviceId: 'dev-2', status: 'open' },
      ],
      [
        { id: 'dev-1', siteId: 'site-1' },
        { id: 'dev-2', siteId: 'site-2' },
      ],
    );
    vi.mocked(createTicket)
      .mockResolvedValueOnce({ id: 't-1' } as never)
      .mockResolvedValueOnce({ id: 't-2' } as never);

    const res = await post('/tickets', {
      deviceVulnerabilityIds: [DV1, DV2, DV_ORG2],
      title: 'Patch Chrome fleet-wide',
      description: 'CVE-2026-0001',
      priority: 'high',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tickets).toEqual([
      { ticketId: 't-1', orgId: 'org-1', findingCount: 2 },
      { ticketId: 't-2', orgId: 'org-2', findingCount: 1 },
    ]);
    expect(vi.mocked(createTicket)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createTicket)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', subject: 'Patch Chrome fleet-wide', priority: 'high', source: 'manual' }),
      expect.objectContaining({ userId: 'u1' }),
    );
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'vulnerability.ticket_create', resourceType: 'ticket', resourceId: 't-1' }),
    );
  });

  it('skips findings in an org the caller cannot access', async () => {
    granted.add('tickets:write');
    mockBulkSelects(
      [{ id: DV1, orgId: 'org-denied', deviceId: 'dev-1', status: 'open' }],
      [{ id: 'dev-1', siteId: 'site-1' }],
    );
    const res = await post('/tickets', { deviceVulnerabilityIds: [DV1], title: 'x' });
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.tickets).toEqual([]);
    expect(body.skipped).toEqual([{ id: DV1, reason: 'access to organization denied' }]);
    expect(vi.mocked(createTicket)).not.toHaveBeenCalled();
  });

  it('maps a TicketServiceError into per-item skips without failing the batch', async () => {
    granted.add('tickets:write');
    mockBulkSelects(
      [{ id: DV1, orgId: 'org-1', deviceId: 'dev-1', status: 'open' }],
      [{ id: 'dev-1', siteId: 'site-1' }],
    );
    vi.mocked(createTicket).mockRejectedValue(new TicketServiceError('Organization not found', 404));
    const res = await post('/tickets', { deviceVulnerabilityIds: [DV1], title: 'x' });
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.skipped).toEqual([{ id: DV1, reason: 'Organization not found' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: FAIL — `/tickets` route 404s (reads as a failing status assertion).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/vulnerabilities.ts`, add imports:

```ts
import { createTicket, TicketServiceError } from '../services/ticketService';
```

Add the schema:

```ts
const bulkTicketSchema = z.object({
  deviceVulnerabilityIds: z.array(z.string().uuid()).min(1).max(200),
  title: z.string().trim().min(1).max(255),
  description: z.string().max(50_000).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});
```

Register the route (static path — before `/:id/*` POST routes or after, either is safe since `tickets` is a static segment; put it next to the bulk routes for cohesion):

```ts
vulnerabilityRoutes.post(
  '/tickets',
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('json', bulkTicketSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceVulnerabilityIds, title, description, priority } = c.req.valid('json');

    const { valid, skipped } = await loadFindingsForBulkWrite(deviceVulnerabilityIds, auth);

    // One ticket per org: a ticket is org-owned, so a cross-org selection
    // splits along org lines rather than leaking device names across tenants.
    const byOrg = new Map<string, BulkFindingRow[]>();
    for (const row of valid) {
      const bucket = byOrg.get(row.orgId);
      if (bucket) bucket.push(row);
      else byOrg.set(row.orgId, [row]);
    }

    const tickets: Array<{ ticketId: string; orgId: string; findingCount: number }> = [];
    for (const [orgId, rows] of byOrg) {
      if (!auth.canAccessOrg(orgId)) {
        for (const r of rows) skipped.push({ id: r.id, reason: 'access to organization denied' });
        continue;
      }
      try {
        const ticket = await createTicket(
          { orgId, subject: title, description, priority, source: 'manual' },
          { userId: auth.user.id, name: auth.user.name, email: auth.user.email },
        );
        await db
          .update(deviceVulnerabilities)
          .set({ ticketId: ticket.id, updatedAt: new Date() })
          .where(inArray(deviceVulnerabilities.id, rows.map((r) => r.id)));
        writeRouteAudit(c, {
          orgId,
          action: 'vulnerability.ticket_create',
          resourceType: 'ticket',
          resourceId: ticket.id,
          details: { deviceVulnerabilityIds: rows.map((r) => r.id), title },
        });
        tickets.push({ ticketId: ticket.id, orgId, findingCount: rows.length });
      } catch (err) {
        const reason = err instanceof TicketServiceError ? err.message : 'failed to create ticket';
        for (const r of rows) skipped.push({ id: r.id, reason });
      }
    }

    return c.json({ success: tickets.length > 0, tickets, skipped });
  },
);
```

If `auth.user.name` doesn't exist on `AuthContext['user']` (typecheck error), pass only `{ userId: auth.user.id, email: auth.user.email }` — `TicketActor.name` is optional.

- [ ] **Step 4: Run tests to verify they pass, then run the whole API suite**

Run: `cd apps/api && pnpm vitest run src/routes/vulnerabilities.test.ts`
Expected: PASS.

Run: `cd apps/api && pnpm vitest run src/routes/ src/services/ 2>&1 | tail -20`
Expected: no regressions in other route/service tests (the tickets route test mocks its own modules and is unaffected).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/vulnerabilities.ts apps/api/src/routes/vulnerabilities.test.ts
git commit -m "feat(api): create native tickets from vulnerability findings with cross-org split"
```

---

## Final verification for Part 1 (after Task 7)

- [ ] `cd apps/api && pnpm vitest run` — full API unit suite green.
- [ ] `pnpm db:check-drift` with a migrated local DB — no drift.
- [ ] Smoke against the worktree stack: `GET /api/v1/vulnerabilities/software`, `/stats`, `/software/<key>`, `/<cveId>/devices` return sane payloads for the seeded fixtures.

Then continue with Part 2: `2026-07-05-vulnerabilities-triage-web.md`.

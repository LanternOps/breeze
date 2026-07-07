# Device Vulnerabilities tab reshape — design

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan
**Area:** `apps/web` (device details), `apps/api` (vulnerabilities routes/services), `packages/shared`

## Problem

The device details **Vulnerabilities** tab (`apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx`)
renders a flat, risk-score-desc-sorted, one-row-per-CVE table. On a real device this
degenerates into a wall of near-identical rows: e.g. a device ~4 Chrome release-trains
behind shows ~400 Chrome CVEs, the top of which all read "Critical / CVSS 9.6", because
the risk-desc sort stacks the worst CVEs first and truncates the perceived variety.

The result hides the two things a technician actually needs:

1. **The shape of the problem** — how many findings, and the real severity spread
   (most of those 400 are unscored/medium, not critical).
2. **The remediation action** — nearly all of those findings collapse into a single
   fix ("update Google Chrome"), which the CVE list never surfaces.

This is a UI/presentation problem. The underlying finding data is correct (verified
against NVD at source; see the "Related / out of scope" section).

## Goal

Replace the flat CVE list as the *front door* with:

1. A **posture header** summarizing the device's findings.
2. A **software-grouped remediation list** (one row per software product / OS), with the
   CVE detail available as a per-group drill-down.

No finding information is lost — the CVE-level view becomes an expand instead of the
default.

## Prior art we reuse

The **fleet** vulnerabilities view already solved this exact modeling problem:

- `apps/api/src/services/vulnerabilityFleetQueries.ts` — `fetchFleetFindingRows()` returns
  `FleetFindingRow[]`, each carrying `softwareName / softwareVendor / softwareVersion`,
  `deviceOsType`, severity, CVSS, EPSS, KEV, `patchAvailable`, status, riskScore.
- `apps/api/src/services/vulnerabilityFleetAggregation.ts` — `groupFindings()` /
  `buildGroupKey()` / `summarizeGroup()` fold those rows into `SoftwareGroup[]`
  (`packages/shared/src/types/vulnerability.ts`): `groupKey`, `kind: 'software' | 'os'`,
  `name`, `vendor`, `versions[]`, `deviceCount`, `cveCount`, `cveIds[]`, `worstSeverity`,
  `maxRiskScore`, `kevCveCount`, `maxEpss`, `patchReadyFindingCount`,
  `patchReadyDeviceCount`, `tickets[]`.

The device tab simply never adopted this model. We bring it down to a single device.

## Design

### A. Data source — server-side, device-scoped (Approach A, chosen)

Add a `deviceId` filter to the fleet finding fetch and expose a device-scoped
software-groups endpoint, reusing the tested aggregation.

- **`fetchFleetFindingRows(filters)`** (`vulnerabilityFleetQueries.ts`): add optional
  `deviceId?: string`. When set, add `eq(deviceVulnerabilities.deviceId, deviceId)` to the
  finding `conditions`. Everything downstream (device/org/software/catalog joins, mapping)
  is unchanged.
- **New route** `GET /vulnerabilities/devices/:deviceId/software`
  (`apps/api/src/routes/vulnerabilities.ts`):
  - Same param + site-access gate as the existing `GET /vulnerabilities/devices/:deviceId`
    (`assertDeviceSiteAccess`), and the same `status` query param (`listQuerySchema` or a
    focused schema).
  - `rows = fetchFleetFindingRows({ status, deviceId, allowedSiteIds: perms?.allowedSiteIds })`.
  - `groups = groupFindings(rows)` (already severity-then-count ordered; confirm/normalize
    sort in the aggregation helper if needed).
  - `stats = computeDeviceStats(rows)` (see B).
  - Also map `rows` to the flat `DeviceVulnerabilityItem[]` (with `groupKey`) for the
    drill-down — see section C.
  - Register it **before** the `/:cveId/devices` catch-all GET (that route shadows
    static-first-segment routes), and alongside the other device GET so route ordering is
    obvious.
  - Returns `{ groups: SoftwareGroup[], findings: DeviceVulnerabilityItem[], stats: DeviceVulnStats }`.

Rationale vs. Approach B (fatten `DeviceVulnerabilityItem` + group in React): A keeps one
tested aggregation path, keeps the device and fleet views coherent, and yields the header
stats from the same rows for free. B duplicates grouping/severity-rollup logic and risks
drift.

### B. Posture header — `DeviceVulnStats`

New shared type (`packages/shared/src/types/vulnerability.ts`), computed **per device from
the same finding rows** (NOT the fleet-wide `/stats` endpoint):

```ts
export interface DeviceVulnStats {
  openTotal: number;          // findings in the current status filter
  critical: number;
  high: number;
  medium: number;
  low: number;
  unscored: number;           // severity null/unknown — the majority in practice
  kevFindingCount: number;    // findings whose CVE is KEV
  patchReadyFindingCount: number;
}
```

A pure `computeDeviceStats(rows: FleetFindingRow[]): DeviceVulnStats` helper (unit-tested)
lives next to `groupFindings`. Rendered as a compact tile/badge row above the group list.
The counts reflect the selected status filter (rows are already status-filtered by the
endpoint).

### C. Group list + drill-down (web)

`DeviceVulnerabilitiesTab.tsx`:

- Fetch from the new endpoint via a new `fetchDeviceSoftwareGroups(deviceId, { status })`
  in `apps/web/src/lib/api/vulnerabilities.ts`.
- Render the header (B) + a list of group rows sorted worst-severity then finding count:
  `name` (OS groups show the OS pseudo-name), finding count, worst-severity badge,
  patch-ready count, `[Remediate all]`.
- Each group row is **expandable**. On expand, show that group's CVE findings — reusing the
  current row rendering (CVE id, severity, CVSS, risk, KEV, patch-available badge) and the
  existing per-finding actions (Remediate / Accept risk / Mitigate / Reopen).
  - **No second round-trip:** the endpoint returns the flat per-device findings alongside the
    groups — `{ groups: SoftwareGroup[], findings: DeviceVulnerabilityItem[], stats }` — and
    each finding carries its `groupKey` (added to `DeviceVulnerabilityItem`) so the web layer
    buckets findings under their group locally on expand. This keeps the existing
    `DeviceVulnerabilityItem` shape (and its per-finding action wiring) intact rather than
    introducing a new drill-down type.

### D. Actions

- **Remediate all (group):** reuse `remediateVuln(deviceVulnerabilityIds)` with the group's
  **patch-ready open** finding IDs. Disabled with an explanatory tooltip when
  `patchReadyFindingCount === 0` (e.g. Chrome CVEs carry no NVD patch object — remediation
  is a version bump, not a one-click patch), matching today's per-row disable behavior.
- **Per-finding actions** unchanged inside the drill-down, including the Accept-risk /
  Mitigate modal and Reopen.
- Bulk "remediate selected" semantics remain Open-status-only.

### E. Status filter, empty/loading/error

- Keep the Open / Accepted / Mitigated / Patched / All selector. Header + groups both
  recompute for the selected status (endpoint re-queries).
- Preserve loading, error, and the empty-state wording that distinguishes a **clean**
  device from a **never-scanned** one.

## Testing

- **Unit (api):** `computeDeviceStats` (severity spread incl. unscored, KEV, patch-ready);
  `fetchFleetFindingRows` device filter narrows rows; `groupFindings` ordering.
- **Route/integration (api):** `GET /vulnerabilities/devices/:deviceId/software` groups a
  seeded device's findings, computes stats, and enforces `assertDeviceSiteAccess`
  (cross-site denied).
- **Web:** update `DeviceVulnerabilitiesTab.test.tsx` — header renders counts, group rows
  render + expand/collapse reveals CVEs, "Remediate all" posts the group's patch-ready IDs
  and disables at zero.

## Related / out of scope

From the 2026-07-06 prod investigation of the "5000 Chrome CVEs" scare
(`vuln_findings_count_real_nvd_not_seed_and_msrc_poison`):

- **MSRC sync is broken in prod** — a malformed upstream `cveId` (> `varchar(32)`) fails the
  whole MSRC batch upsert, staling Windows/Office CVE data. This is a **data-ingestion bug**,
  tracked separately; this UI reshape neither fixes nor depends on it.
- The version comparator was investigated and found **correct** (findings are real). No
  change here.
- **Not in this scope:** an explicit "update to exact fixed version X" remediation target on
  the group row. `SoftwareGroup` does not carry fixed-build data; this is a possible fast
  follow, not part of this design.

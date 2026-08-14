# Discovery Camera Auto-Identification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Network Discovery auto-types UniFi Protect cameras (and cameras generally) as `camera` instead of `unknown` — starting with the verified root cause of the SemoTech report: the UniFi Network sync clobbering discovered-asset types on every run — plus hostname heuristics, verified OUI coverage, an agent-side RTSP heuristic, and a UniFi Protect poll that reconciles cameras into `discovered_assets`, all without ever clobbering a manual type override (issue #2199).

**Root cause (verified 2026-07-03):** the reported G6 camera's asset row shows manufacturer **"Ubiquiti"** — the literal string written by `reconcileDiscoveredAsset` (`unifiSyncService.ts:108`), not the **"Ubiquiti Inc"** the OUI path would have written (verified: `toVendor('8C:ED:E1:AE:8A:7B') → "Ubiquiti Inc"`). So the camera DOES appear in the UniFi Network integration device list, and the row was last written by the sync path: `assetType()` returns `'unknown'` for the camera's `deviceType`, and the update at `unifiSyncService.ts:115-119` stamps `assetType` unconditionally — no `typeSource` guard, no `detectedAssetType` — erasing anything the scan inferred, on every sync. **Urgent:** PR #2200 fixes the manual "set type to Camera" save, but without the Task 1 guard the very next UniFi sync clobbers the user's manual choice back to `'unknown'`. Task 1 is therefore the highest-priority piece of this plan.

**Architecture:** Milestone 1 first fixes the sync clobber in `unifiSyncService.reconcileDiscoveredAsset` (typeSource-guarded `assetType` writes, `detectedAssetType` always recorded when known, never stamp `'unknown'` over a better value) and adds a structured log for unmapped UniFi `deviceType` values so we learn the real Protect string from the field instead of guessing it. It then adds `inferAssetTypeFromHostname` to `macVendorLookup.ts`, wired into the discovery worker's enrichment with precedence *agent classification > hostname > OUI vendor keyword* — still valuable for non-UniFi-integrated sites and other camera brands. Milestone 2 pins the (already-sufficient — verified `8C:ED:E1` resolves) Ubiquiti OUI coverage with regression tests, widens the camera-vendor keyword row, and adds the RTSP-554 heuristic to the agent classifier. Milestone 3 extends the agent's local-controller poller with a Protect Integration API client (symmetric to the existing Network client, with capability detection), ships cameras through the existing unifi-telemetry ingest, reconciles them by MAC into `discovered_assets` as `camera`, and adds the camera case to the cloud-side `assetType()` map.

**Tech Stack:** TypeScript (Hono API, Drizzle ORM, Vitest), Go (agent, stdlib `testing` + `httptest`), PostgreSQL enum `discovered_asset_type` (already contains `camera` — no migration needed anywhere in this plan).

**Shipping shape:** Milestones 1 + 2 (clobber fix + Phase 1 + Phase 2) ship together as one PR — and Task 1 must land before or with PR #2200's fix reaching users, or the next sync undoes their manual type choice. Milestone 3 (Phase 3) is its own PR.

## Global Constraints

- No migrations are expected in this plan; if one becomes necessary, never edit a shipped migration — fix forward.
- Auto-classification must NEVER clobber `typeSource='manual'`: every writer sets `detectedAssetType` unconditionally but writes `assetType` only for auto-typed rows.
- Partner-wide-first does NOT apply — no new config tables are created here.
- Test files live alongside source files (`foo.ts` → `foo.test.ts`, `foo.go` → `foo_test.go`).
- Go tests are table-driven and always run with `-race`.

---

## Milestone 1 — root-cause sync-clobber fix + Phase 1 hostname inference (first PR, with Milestone 2)

### Task 1: stop the UniFi sync clobbering discovered-asset types (root-cause fix)

The cloud Site Manager sync's `reconcileDiscoveredAsset` overwrites `assetType` unconditionally on every sync — this is what turned the reporter's G6 camera `'unknown'` and what would immediately undo PR #2200's manual-save fix. This task fixes the writer only; the Protect-specific camera case in `assetType()` stays in Milestone 3 (Task 9) because we must not invent the Protect `deviceType` string — instead this task logs unmapped values so the real string can be learned from the field.

**Files**
- Modify: `apps/api/src/services/unifi/unifiSyncService.ts` (line 1 import; `reconcileDiscoveredAsset` lines 64–133; `assetType()` is NOT touched here)
- Test: `apps/api/src/services/unifi/unifiSyncService.test.ts` (append)

**Interfaces**
- `reconcileDiscoveredAsset` signature unchanged (`(db: DbExecutor, device: UnifiDeviceDto, mapping: { orgId: string; siteId: string }) => Promise<string | null>`); it now selects `typeSource`, always writes `detectedAssetType` when the type is known, writes `assetType` only for non-manual rows, never stamps `'unknown'`, and emits one structured `console.warn` per unmapped non-empty `deviceType`.
- Insert path keeps `typeSource` at its column default `'auto'` (net-new rows are auto-typed by construction).

**Steps**

- [ ] Write the failing tests. In `apps/api/src/services/unifi/unifiSyncService.test.ts`, widen the vitest import at line 1 to:

```ts
import { describe, it, expect, vi } from 'vitest';
```

then append inside `describe('unifiSyncService.syncIntegration')`:

```ts
  it('does not clobber a manual type override when re-syncing an existing asset', async () => {
    const { writes, db } = scriptedDb({
      mappings: [BASE_MAPPING],
      existingAsset: { id: 'asset-x', typeSource: 'manual' },
    });
    const client = fakeClient([NET_NEW_DEVICE]); // 'uap' → access_point

    await syncIntegration({ db, client }, BASE_INTEGRATION, 'manual');

    const assetUpdates = writes.updates.filter((w) => w.table === discoveredAssets);
    expect(assetUpdates).toHaveLength(1);
    expect(assetUpdates[0]!.values).not.toHaveProperty('assetType');   // manual wins
    expect(assetUpdates[0]!.values.detectedAssetType).toBe('access_point'); // detection recorded
  });

  it('does not stamp unknown over an existing typed asset (the #2199 clobber)', async () => {
    const { writes, db } = scriptedDb({
      mappings: [BASE_MAPPING],
      existingAsset: { id: 'asset-y', typeSource: 'auto' },
    });
    // A Protect camera's deviceType is unmapped today → assetType() = 'unknown';
    // pre-fix, the sync stamped that 'unknown' over the scan's OUI inference.
    const client = fakeClient([{ ...NET_NEW_DEVICE, deviceType: 'weird-new-type' }]);

    await syncIntegration({ db, client }, BASE_INTEGRATION, 'manual');

    const assetUpdates = writes.updates.filter((w) => w.table === discoveredAssets);
    expect(assetUpdates).toHaveLength(1);
    expect(assetUpdates[0]!.values).not.toHaveProperty('assetType');
    expect(assetUpdates[0]!.values).not.toHaveProperty('detectedAssetType');
  });

  it('logs unmapped deviceType values so the real Protect string can be learned from the field', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { db } = scriptedDb({
        mappings: [BASE_MAPPING],
        existingAsset: { id: 'asset-y', typeSource: 'auto' },
      });
      const client = fakeClient([{ ...NET_NEW_DEVICE, deviceType: 'weird-new-type' }]);

      await syncIntegration({ db, client }, BASE_INTEGRATION, 'manual');

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('weird-new-type'));
    } finally {
      warnSpy.mockRestore();
    }
  });
```

- [ ] Run: `cd apps/api && npx vitest run src/services/unifi/unifiSyncService.test.ts` — all three fail: the manual-override update contains `assetType: 'access_point'`; the unknown case contains `assetType: 'unknown'`; no warn is emitted.

- [ ] Implement in `apps/api/src/services/unifi/unifiSyncService.ts`.

Change line 1 to:

```ts
import { and, eq, sql } from 'drizzle-orm';
```

Replace `reconcileDiscoveredAsset` (lines 64–133) with:

```ts
// Find-or-create a discovered_assets row for a UniFi device; return its id.
async function reconcileDiscoveredAsset(
  db: DbExecutor,
  device: UnifiDeviceDto,
  mapping: { orgId: string; siteId: string },
): Promise<string | null> {
  // discovered_assets.ip_address is inet NOT NULL — cannot create without an IP.
  if (!device.ip) return null;

  const aType = assetType(device.deviceType);

  // Field intelligence (#2199): we don't yet know what deviceType string the
  // Network integration API reports for Protect cameras. Log unmapped values so
  // the real string can be learned from production logs (or the reporter) — a
  // camera case is added to assetType() the moment we see it. Never guess it.
  if (aType === 'unknown' && device.deviceType) {
    console.warn(
      `[unifi-sync] unmapped UniFi deviceType ${JSON.stringify(device.deviceType)} ` +
      `(model=${device.model ?? 'unknown'}, unifiDeviceId=${device.unifiDeviceId}) — asset type left untouched`,
    );
  }

  // 1. Match by (org_id, mac) first — the stable identifier.
  let existing: { id: string; typeSource: string } | null = null;
  if (device.mac) {
    const byMac = await db
      .select({ id: discoveredAssets.id, typeSource: discoveredAssets.typeSource })
      .from(discoveredAssets)
      .where(
        and(
          eq(discoveredAssets.orgId, mapping.orgId),
          eq(discoveredAssets.macAddress, device.mac),
        ),
      )
      .limit(1);
    existing = byMac[0] ?? null;
  }

  // 2. Fall back to the (org_id, ip_address) unique key.
  if (!existing) {
    const byIp = await db
      .select({ id: discoveredAssets.id, typeSource: discoveredAssets.typeSource })
      .from(discoveredAssets)
      .where(
        and(
          eq(discoveredAssets.orgId, mapping.orgId),
          eq(discoveredAssets.ipAddress, device.ip),
        ),
      )
      .limit(1);
    existing = byIp[0] ?? null;
  }

  const baseEnrich = {
    macAddress: device.mac ?? undefined,
    hostname: device.name ?? undefined,
    manufacturer: 'Ubiquiti',
    model: device.model ?? undefined,
    isOnline: device.adoptionState === 'CONNECTED',
    lastSeenAt: new Date(),
  };

  if (existing) {
    // Type writes: never stamp 'unknown' over an existing row, and never clobber
    // a manual override (typeSource='manual') — the user's choice wins there.
    // detectedAssetType (what the sync sees) is recorded whenever known.
    const set = aType === 'unknown'
      ? baseEnrich
      : existing.typeSource === 'manual'
        ? { ...baseEnrich, detectedAssetType: aType }
        : { ...baseEnrich, detectedAssetType: aType, assetType: aType };
    await db.update(discoveredAssets).set(set).where(eq(discoveredAssets.id, existing.id));
    return existing.id;
  }

  // Net-new: insert, absorbing a race with agent discovery via the (org,ip)
  // unique key. typeSource stays at its column default 'auto'. On conflict the
  // row already existed, so the assetType write is gated on typeSource='auto'
  // in SQL (a JS-side check would race).
  const inserted = await db
    .insert(discoveredAssets)
    .values({
      orgId: mapping.orgId,
      siteId: mapping.siteId,
      ipAddress: device.ip,
      ...baseEnrich,
      assetType: aType,
      ...(aType === 'unknown' ? {} : { detectedAssetType: aType }),
    })
    .onConflictDoUpdate({
      target: [discoveredAssets.orgId, discoveredAssets.ipAddress],
      set: {
        ...baseEnrich,
        ...(aType === 'unknown' ? {} : {
          detectedAssetType: aType,
          assetType: sql`CASE WHEN ${discoveredAssets.typeSource} = 'auto' THEN ${aType}::discovered_asset_type ELSE ${discoveredAssets.assetType} END`,
        }),
      },
    })
    .returning({ id: discoveredAssets.id });
  return inserted[0]?.id ?? null;
}
```

- [ ] Run again: `cd apps/api && npx vitest run src/services/unifi/unifiSyncService.test.ts` — all green. Note: the pre-existing `creates a unifi_device...` test still passes (`uap` insert now also carries `detectedAssetType: 'access_point'`, which it does not assert against), and `classifies an unchanged device as unchanged` passes because its fixture's missing `typeSource` is not `'manual'`.
- [ ] Commit: `git add apps/api/src/services/unifi/unifiSyncService.ts apps/api/src/services/unifi/unifiSyncService.test.ts && git commit -m "fix(unifi): sync no longer clobbers discovered-asset types; log unmapped deviceType (#2199)"`

### Task 2: `inferAssetTypeFromHostname` helper

**Files**
- Modify: `apps/api/src/services/macVendorLookup.ts` (append after `inferAssetTypeFromVendor`, line 36)
- Test (create): `apps/api/src/services/macVendorLookup.test.ts`

**Interfaces**
- Produces: `export function inferAssetTypeFromHostname(hostname: string | null | undefined, vendor?: string | null): string | null` — returns a `discovered_asset_type` enum value or `null`. Consumed by Task 3 (`discoveryWorker.ts`).

**Steps**

- [ ] Write the failing test. Create `apps/api/src/services/macVendorLookup.test.ts` (this test file also hosts Task 4's OUI-pinning tests — real module, no mocks):

```ts
import { describe, expect, it } from 'vitest';
import { inferAssetTypeFromHostname } from './macVendorLookup';

describe('inferAssetTypeFromHostname — generic patterns (vendor-independent)', () => {
  it.each([
    ['Front-Door-Cam', 'camera'],
    ['garage-camera', 'camera'],
    ['NVR-01', 'camera'],
    ['office-doorbell', 'camera'],
    ['IPC-2CD2043', 'camera'],
    ['front_door_cam', 'camera'], // underscore separators (NetBIOS-style) count as boundaries
    ['HP-Printer-Floor2', 'printer'],
    ['MFP-Lobby', 'printer'],
    ['nas-backup', 'nas'],
    ['AP-Warehouse', 'access_point'],
    ['wap-guest', 'access_point'],
  ])('%s → %s', (hostname, expected) => {
    expect(inferAssetTypeFromHostname(hostname, null)).toBe(expected);
  });
});

describe('inferAssetTypeFromHostname — Ubiquiti-scoped camera model prefixes', () => {
  it.each([
    ['G6-Turret', 'Ubiquiti Inc'],
    ['G4-Bullet', 'Ubiquiti Inc'],
    ['SEMO-G5-Flex', 'Ubiquiti Networks Inc.'],
    ['AI-Pro', 'Ubiquiti Inc'],
    ['UNVR', 'Ubiquiti Inc'],
  ])('%s with vendor %s → camera', (hostname, vendor) => {
    expect(inferAssetTypeFromHostname(hostname, vendor)).toBe('camera');
  });
});

describe('inferAssetTypeFromHostname — must NOT match', () => {
  it.each([
    ['G6-Turret', null],            // bare G-series without a Ubiquiti vendor
    ['G6-Turret', 'Samsung'],       // G-series token on a non-Ubiquiti vendor
    ['AI-Pro', 'Dell'],
    ['LAPTOP-G6X2', 'Ubiquiti Inc'], // g6 not a whole token (g6x2)
    ['maison', 'Ubiquiti Inc'],      // "ai" embedded mid-word
    ['cheap-tv', null],              // "ap" embedded mid-word
    ['workstation-42', null],
    ['', null],
  ])('%s (vendor=%s) → null', (hostname, vendor) => {
    expect(inferAssetTypeFromHostname(hostname, vendor)).toBeNull();
  });

  it('returns null for null/undefined hostname', () => {
    expect(inferAssetTypeFromHostname(null, 'Ubiquiti Inc')).toBeNull();
    expect(inferAssetTypeFromHostname(undefined)).toBeNull();
  });
});
```

- [ ] Run it and confirm the failure mode: `cd apps/api && npx vitest run src/services/macVendorLookup.test.ts` — expect every test to fail with `inferAssetTypeFromHostname is not a function` (export does not exist yet).

- [ ] Implement. Append to `apps/api/src/services/macVendorLookup.ts`:

```ts
// Hostname-based type inference — consulted when agent classification returned
// 'unknown', BEFORE the vendor keyword fallback (a hostname names the product
// line; an OUI only names the manufacturer).
//
// Token boundaries are any non-alphanumeric character (hyphen, dot, underscore)
// or string edge — deliberately NOT \b, because underscore is a JS word char and
// NetBIOS-style names like "front_door_cam" must still match.
const GENERIC_HOSTNAME_PATTERNS: Array<[RegExp, string]> = [
  [/(^|[^a-z0-9])(cam|camera|doorbell|nvr|ipc)([^a-z0-9]|$)/, 'camera'],
  [/(^|[^a-z0-9])(printer|mfp)([^a-z0-9]|$)/, 'printer'],
  [/(^|[^a-z0-9])nas([^a-z0-9]|$)/, 'nas'],
  [/(^|[^a-z0-9])(ap|wap)([^a-z0-9]|$)/, 'access_point'],
];

// Ubiquiti ships APs, switches, gateways AND Protect cameras under one OUI, so
// UniFi camera model prefixes (G3–G6 / AI series, UNVR) only apply when the
// resolved vendor is Ubiquiti — a bare "G6" on an unknown vendor must NOT match.
const UBIQUITI_CAMERA_PATTERN = /(^|[^a-z0-9])(g[3-6]|ai|unvr)([^a-z0-9]|$)/;

export function inferAssetTypeFromHostname(
  hostname: string | null | undefined,
  vendor?: string | null,
): string | null {
  if (!hostname) return null;
  const lower = hostname.toLowerCase();
  for (const [pattern, role] of GENERIC_HOSTNAME_PATTERNS) {
    if (pattern.test(lower)) return role;
  }
  const vendorLower = (vendor ?? '').toLowerCase();
  if (
    (vendorLower.includes('ubiquiti') || vendorLower.includes('unifi')) &&
    UBIQUITI_CAMERA_PATTERN.test(lower)
  ) {
    return 'camera';
  }
  return null;
}
```

- [ ] Run again: `cd apps/api && npx vitest run src/services/macVendorLookup.test.ts` — expect all tests green.
- [ ] Commit: `git add apps/api/src/services/macVendorLookup.ts apps/api/src/services/macVendorLookup.test.ts && git commit -m "feat(discovery): hostname-based asset type inference helper (#2199)"`

### Task 3: wire hostname inference into discovery worker enrichment

**Files**
- Modify: `apps/api/src/jobs/discoveryWorker.ts` (import at line 30; enrichment block at lines 791–795)
- Test: `apps/api/src/jobs/discoveryWorker.test.ts` (mock factory at lines 66–69; add cases after line 256, inside `describe('processResults — type_source')`)

**Interfaces**
- Consumes: `inferAssetTypeFromHostname(hostname, vendor)` from Task 2.
- Produces: no new exports. Behavior contract: when `mapAssetType(host.assetType) === 'unknown'`, resolution order is hostname heuristic, then vendor keyword, then `'unknown'`. The result flows into the existing `assetData.assetType` / `detectedAssetType` / `typeSource` machinery, which already protects manual overrides (lines 819–853).

**Steps**

- [ ] Write the failing tests. In `apps/api/src/jobs/discoveryWorker.test.ts`, first extend the hoisted mock factory (lines 66–69) so the new export exists:

```ts
vi.mock('../services/macVendorLookup', () => ({
  lookupMacVendor: vi.fn(),
  inferAssetTypeFromVendor: vi.fn(),
  inferAssetTypeFromHostname: vi.fn()
}));
```

Then add this import after line 81 (`import { buildApprovalDecision } ...`):

```ts
import { lookupMacVendor, inferAssetTypeFromVendor, inferAssetTypeFromHostname } from '../services/macVendorLookup';
```

Then add these cases at the end of the `describe('processResults — type_source')` block (after the `does not propagate device role...` test, line 256):

```ts
  it('hostname inference beats vendor inference when agent type is unknown', async () => {
    vi.mocked(lookupMacVendor).mockReturnValue('Ubiquiti Inc');
    vi.mocked(inferAssetTypeFromHostname).mockReturnValue('camera');
    vi.mocked(inferAssetTypeFromVendor).mockReturnValue('access_point');
    selectQueue = [
      ...baseSelectQueue(),
      [],  // [6] no existing asset → insert path
      [],  // [7] auto-link
    ];

    await processResults(makeData([
      { ip: '192.168.1.60', mac: '8c:ed:e1:11:22:33', hostname: 'G6-Turret', assetType: 'unknown', methods: [] },
    ]));

    expect(inferAssetTypeFromHostname).toHaveBeenCalledWith('G6-Turret', 'Ubiquiti Inc');
    expect(capturedInsertValues).not.toBeNull();
    expect(capturedInsertValues!.assetType).toBe('camera');
    expect(capturedInsertValues!.detectedAssetType).toBe('camera');
  });

  it('falls back to vendor inference when the hostname yields nothing', async () => {
    vi.mocked(lookupMacVendor).mockReturnValue('Ubiquiti Inc');
    vi.mocked(inferAssetTypeFromHostname).mockReturnValue(null);
    vi.mocked(inferAssetTypeFromVendor).mockReturnValue('access_point');
    selectQueue = [
      ...baseSelectQueue(),
      [],  // [6] no existing asset
      [],  // [7] auto-link
    ];

    await processResults(makeData([
      { ip: '192.168.1.61', mac: '8c:ed:e1:44:55:66', hostname: 'U6-Office', assetType: 'unknown', methods: [] },
    ]));

    expect(capturedInsertValues!.assetType).toBe('access_point');
  });

  it('does not consult the hostname heuristic when the agent already classified the host', async () => {
    vi.mocked(inferAssetTypeFromHostname).mockReturnValue('camera');
    selectQueue = [
      ...baseSelectQueue(),
      [],  // [6] no existing asset
      [],  // [7] auto-link
    ];

    await processResults(makeData([
      { ip: '192.168.1.62', hostname: 'G6-Turret', assetType: 'printer', methods: [] },
    ]));

    expect(inferAssetTypeFromHostname).not.toHaveBeenCalled();
    expect(capturedInsertValues!.assetType).toBe('printer');
  });
```

- [ ] Run: `cd apps/api && npx vitest run src/jobs/discoveryWorker.test.ts` — the three new tests fail (`inferAssetTypeFromHostname` never called; `assetType` is `'unknown'` in the first case). All pre-existing tests must still pass.

- [ ] Implement. In `apps/api/src/jobs/discoveryWorker.ts`, change line 30 to:

```ts
import { lookupMacVendor, inferAssetTypeFromVendor, inferAssetTypeFromHostname } from '../services/macVendorLookup';
```

and replace lines 791–795 (`// Infer asset type from vendor ...` through the closing `}`) with:

```ts
    // Infer asset type when agent classification returned unknown.
    // Precedence: agent classification (ports/SNMP) > hostname heuristic > OUI
    // vendor keyword — a hostname identifies the product line while an OUI only
    // identifies the manufacturer, so the hostname is consulted first (it refines
    // the blanket ubiquiti→access_point mapping to 'camera' for Protect gear).
    let resolvedAssetType = mapAssetType(host.assetType);
    if (resolvedAssetType === 'unknown') {
      resolvedAssetType =
        inferAssetTypeFromHostname(host.hostname, resolvedManufacturer)
        ?? inferAssetTypeFromVendor(resolvedManufacturer)
        ?? 'unknown';
    }
```

- [ ] Run again: `cd apps/api && npx vitest run src/jobs/discoveryWorker.test.ts` — all green (the existing `type_source` manual-override tests prove the new inference still flows through the override guard).
- [ ] Commit: `git add apps/api/src/jobs/discoveryWorker.ts apps/api/src/jobs/discoveryWorker.test.ts && git commit -m "feat(discovery): consult hostname before OUI vendor when typing unknown assets (#2199)"`

---

## Milestone 2 — Phase 2: OUI coverage + agent RTSP heuristic (same PR as Milestone 1)

### Task 4: pin Ubiquiti OUI coverage and widen camera-vendor keywords

Research finding (2026-07-03, this plan): `@network-utils/vendor-lookup@1.0.12` **already resolves** `8C:ED:E1` and 30 other probed Ubiquiti allocations to `"Ubiquiti Inc"`, so no supplemental OUI table and no dependency bump are needed. The deliverable is a regression pin (so a future dependency bump that drops allocations fails CI) plus camera-vendor keyword additions.

**Files**
- Modify: `apps/api/src/services/macVendorLookup.ts` (line 22, camera keyword row)
- Test: `apps/api/src/services/macVendorLookup.test.ts` (append to the file created in Task 2)

**Interfaces**
- Consumes: `lookupMacVendor`, `inferAssetTypeFromVendor` (existing exports, unchanged signatures).
- Produces: no new exports; `VENDOR_ROLE_KEYWORDS` camera row gains `amcrest`, `lorex`, `uniview`, `verkada`.

**Steps**

- [ ] Write the failing tests. In `apps/api/src/services/macVendorLookup.test.ts`, first widen the existing import (added in Task 2) to:

```ts
import { inferAssetTypeFromHostname, inferAssetTypeFromVendor, lookupMacVendor } from './macVendorLookup';
```

then append:

```ts
describe('lookupMacVendor — Ubiquiti OUI coverage (regression pin, #2199)', () => {
  // Verified against @network-utils/vendor-lookup@1.0.12. If a dependency bump
  // drops any of these allocations, UniFi devices regress to 'unknown'.
  it.each([
    '8C:ED:E1:11:22:33', // the OUI from the SemoTech G6 camera report
    '9C:05:D6:11:22:33',
    'F4:E2:C6:11:22:33',
    '28:70:4E:11:22:33',
    '24:5A:4C:11:22:33',
    '94:2A:6F:11:22:33',
    'E4:38:83:11:22:33',
    '70:A7:41:11:22:33',
    'D8:B3:70:11:22:33',
    'AC:8B:A9:11:22:33',
    '00:15:6D:11:22:33', // legacy allocation — sanity anchor
  ])('%s resolves to a Ubiquiti vendor string', (mac) => {
    expect(lookupMacVendor(mac)?.toLowerCase()).toContain('ubiquiti');
  });

  it('returns null for locally-administered/random MACs (sentinel filtering)', () => {
    expect(lookupMacVendor('9E:05:D6:11:22:33')).toBeNull();
  });

  it('returns null for null/empty input', () => {
    expect(lookupMacVendor(null)).toBeNull();
    expect(lookupMacVendor('')).toBeNull();
  });
});

describe('inferAssetTypeFromVendor — camera vendor keywords', () => {
  it.each([
    'Amcrest Technologies',
    'Lorex Technology Inc',
    'Zhejiang Uniview Technologies Co., Ltd.',
    'Verkada Inc',
    'Hikvision Digital Technology', // pre-existing keyword — regression anchor
  ])('%s → camera', (vendor) => {
    expect(inferAssetTypeFromVendor(vendor)).toBe('camera');
  });

  it('keeps ubiquiti → access_point as the vendor-level fallback (hostname refines it)', () => {
    expect(inferAssetTypeFromVendor('Ubiquiti Inc')).toBe('access_point');
  });
});
```

- [ ] Run: `cd apps/api && npx vitest run src/services/macVendorLookup.test.ts` — the four new-vendor cases fail (`inferAssetTypeFromVendor` returns `null`); the OUI-pin cases should already pass (they document verified current behavior — if any fails, STOP and report: the library coverage assumption is wrong and a supplemental OUI table is needed after all).

- [ ] Implement. In `apps/api/src/services/macVendorLookup.ts`, replace line 22 with:

```ts
  [['hikvision', 'dahua', 'axis communications', 'vivotek', 'hanwha', 'avigilon', 'reolink', 'amcrest', 'lorex', 'uniview', 'verkada'], 'camera'],
```

- [ ] Run again: `cd apps/api && npx vitest run src/services/macVendorLookup.test.ts` — all green.
- [ ] Commit: `git add apps/api/src/services/macVendorLookup.ts apps/api/src/services/macVendorLookup.test.ts && git commit -m "test(discovery): pin Ubiquiti OUI coverage; add camera vendor keywords (#2199)"`

### Task 5: agent classifier — RTSP port 554 → camera

**Files**
- Modify: `agent/internal/discovery/classify.go` (insert between the access_point check ending line 86 and the gateway heuristic at line 89; update the priority comment at line 53)
- Test: `agent/internal/discovery/classify_test.go` (append a new table-driven test function)

**Interfaces**
- Consumes: existing `hasPort(host.OpenPorts, port int) bool`.
- Produces: `classifyType` may now return `"camera"`. No signature changes.

**Steps**

- [ ] Write the failing test. Append to `agent/internal/discovery/classify_test.go`:

```go
func TestClassifyAssetCamera(t *testing.T) {
	tests := []struct {
		name string
		host DiscoveredHost
		want string
	}{
		{
			name: "camera_by_rtsp_port",
			host: DiscoveredHost{
				IP:        "10.0.0.20",
				OpenPorts: []OpenPort{{Port: 554, Service: "rtsp"}},
			},
			want: "camera",
		},
		{
			name: "rtsp_beats_workstation_ports",
			host: DiscoveredHost{
				IP:        "10.0.0.21",
				OpenPorts: []OpenPort{{Port: 554, Service: "rtsp"}, {Port: 22, Service: "ssh"}},
			},
			want: "camera",
		},
		{
			name: "synology_nas_with_rtsp_stays_nas",
			host: DiscoveredHost{
				IP:        "10.0.0.22",
				SNMPData:  &SNMPInfo{SysDescr: "Synology DiskStation"},
				OpenPorts: []OpenPort{{Port: 554, Service: "rtsp"}},
			},
			want: "nas",
		},
		{
			name: "no_ports_stays_unknown",
			host: DiscoveredHost{
				IP: "10.0.0.23",
			},
			want: "unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assetType, _, _ := ClassifyAsset(tt.host)
			if assetType != tt.want {
				t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, tt.want)
			}
		})
	}
}
```

- [ ] Run: `cd agent && go test -race ./internal/discovery/ -run TestClassifyAssetCamera` — `camera_by_rtsp_port` and `rtsp_beats_workstation_ports` fail (got `"unknown"` / `"workstation"`).

- [ ] Implement. In `agent/internal/discovery/classify.go`, insert after the access_point block (after line 86, before the gateway heuristic comment):

```go
	// 7. Camera: RTSP (554). Checked AFTER NAS so a Synology running
	// Surveillance Station (which also serves RTSP) stays a NAS, and BEFORE the
	// workstation fallthrough so a camera with SSH open doesn't misclassify.
	if hasPort(host.OpenPorts, 554) {
		return "camera"
	}
```

and update the priority comment at line 53 to:

```go
// Priority order: printer > router > switch > firewall > NAS > access_point > camera > server > workstation > unknown
```

- [ ] Run again: `cd agent && go test -race ./internal/discovery/...` — all green (full package, to confirm no existing classification regressed).
- [ ] Commit: `git add agent/internal/discovery/classify.go agent/internal/discovery/classify_test.go && git commit -m "feat(agent): classify RTSP-exposing hosts as camera (#2199)"`

---

## Milestone 3 — Phase 3: UniFi Protect sync (separate PR)

### Task 6: agent Protect client (`PollProtect`)

**Files**
- Create: `agent/internal/unifi/protect.go`
- Modify: `agent/internal/unifi/client.go` (split `get` into `getRaw` + envelope wrapper, lines 115–144)
- Test (create): `agent/internal/unifi/protect_test.go`

**Interfaces**
- Produces (consumed by Task 7):

```go
type Camera struct {
	ID    string          `json:"id"`
	Mac   string          `json:"mac"`
	Name  string          `json:"name"`
	Model string          `json:"type"`
	State string          `json:"state"`
	IP    string          `json:"host"`
	Raw   json.RawMessage `json:"-"`
}

type ProtectSnapshot struct {
	Available  bool
	SkipReason string
	Cameras    []Camera
}

func (c *APIClient) PollProtect(ctx context.Context) (ProtectSnapshot, error)
```

> **VERIFY BEFORE MERGE (acceptable verification note, not a placeholder):** the Protect Integration API base path and camera field names below follow Ubiquiti's official integration API, which is served alongside the Network one (`/proxy/protect/integration/v1` vs `/proxy/network/integration/v1`, same `X-API-KEY`). The exact collection path (`/cameras`), the envelope behavior (`{"data":[...]}` vs bare array — the client tolerates both), and the field carrying the model string (`type`) and IP (`host`) MUST be confirmed against a live UniFi OS 4.x / Protect 5.3+ console before merging this PR. `protectAPIBase` is the single const to fix if the path differs.

**Steps**

- [ ] Write the failing tests. Create `agent/internal/unifi/protect_test.go`:

```go
package unifi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPollProtectParsesCameras(t *testing.T) {
	tests := []struct {
		name string
		body string // both envelope shapes must parse — Protect's envelope behavior is unconfirmed
	}{
		{
			name: "enveloped",
			body: `{"data":[{"id":"cam1","mac":"8CEDE1112233","name":"G6 Turret","type":"UVC G6 Turret","state":"CONNECTED","host":"10.0.0.42"}]}`,
		},
		{
			name: "bare_array",
			body: `[{"id":"cam1","mac":"8CEDE1112233","name":"G6 Turret","type":"UVC G6 Turret","state":"CONNECTED","host":"10.0.0.42"}]`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-API-KEY") != "k" {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				if r.URL.Path == "/proxy/protect/integration/v1/cameras" {
					w.Write([]byte(tt.body))
					return
				}
				w.WriteHeader(http.StatusNotFound)
			}))
			defer srv.Close()

			c := NewAPIClient(srv.URL, "k", srv.Client())
			snap, err := c.PollProtect(context.Background())
			if err != nil {
				t.Fatalf("PollProtect: %v", err)
			}
			if !snap.Available {
				t.Fatalf("expected Available=true, skip reason %q", snap.SkipReason)
			}
			if len(snap.Cameras) != 1 {
				t.Fatalf("expected 1 camera, got %+v", snap.Cameras)
			}
			cam := snap.Cameras[0]
			if cam.ID != "cam1" || cam.Mac != "8CEDE1112233" || cam.Name != "G6 Turret" ||
				cam.Model != "UVC G6 Turret" || cam.State != "CONNECTED" || cam.IP != "10.0.0.42" {
				t.Fatalf("unexpected camera: %+v", cam)
			}
			if len(cam.Raw) == 0 || string(cam.Raw) == "null" {
				t.Fatalf("camera Raw not captured: %q", cam.Raw)
			}
		})
	}
}

func TestPollProtectCapabilityDetection(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		wantAvail bool
		wantErr   bool
	}{
		{name: "protect_absent_404", status: http.StatusNotFound, wantAvail: false, wantErr: false},
		{name: "key_lacks_scope_403", status: http.StatusForbidden, wantAvail: false, wantErr: false},
		{name: "key_lacks_scope_401", status: http.StatusUnauthorized, wantAvail: false, wantErr: false},
		{name: "server_error_500_surfaces", status: http.StatusInternalServerError, wantAvail: true, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
			}))
			defer srv.Close()

			c := NewAPIClient(srv.URL, "k", srv.Client())
			snap, err := c.PollProtect(context.Background())
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if snap.Available != tt.wantAvail {
				t.Fatalf("Available = %v, want %v (skip %q)", snap.Available, tt.wantAvail, snap.SkipReason)
			}
			if !tt.wantAvail && snap.SkipReason == "" {
				t.Fatalf("expected a non-empty SkipReason when unavailable")
			}
		})
	}
}
```

- [ ] Run: `cd agent && go test -race ./internal/unifi/ -run TestPollProtect` — compile failure (`c.PollProtect undefined`) is the expected red.

- [ ] Implement. First refactor `agent/internal/unifi/client.go`: replace the existing `get` method (lines 115–144) with a raw-body variant plus the envelope wrapper (behavior of `get` is unchanged — all existing tests must stay green):

```go
// getRaw returns (rawBody, statusCode, error). A 404 returns (nil, 404, nil) so
// callers can treat "endpoint absent" as capability information, not an error.
func (c *APIClient) getRaw(ctx context.Context, path string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("X-API-KEY", c.apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, rerr := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return nil, resp.StatusCode, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fmt.Errorf("unifi api %s: status %d", path, resp.StatusCode)
	}
	if rerr != nil {
		// A read error on a 2xx is the real root cause; surfacing it here avoids
		// the misleading "bad json" we'd otherwise hit on the truncated body.
		return nil, resp.StatusCode, fmt.Errorf("unifi api %s: read body: %w", path, rerr)
	}
	return body, resp.StatusCode, nil
}

// get unwraps the Network integration API's {"data": ...} envelope.
func (c *APIClient) get(ctx context.Context, path string) (json.RawMessage, int, error) {
	body, status, err := c.getRaw(ctx, path)
	if err != nil || body == nil {
		return nil, status, err
	}
	var env envelope
	if uerr := json.Unmarshal(body, &env); uerr != nil {
		return nil, status, fmt.Errorf("unifi api %s: bad json: %w", path, uerr)
	}
	return env.Data, status, nil
}
```

Then create `agent/internal/unifi/protect.go`:

```go
package unifi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// UniFi Protect Integration API base — served by UniFi OS alongside the Network
// integration API and authenticated with the same X-API-KEY.
//
// VERIFY BEFORE MERGE: confirm this exact prefix and the /cameras collection
// against a live UniFi OS 4.x / Protect 5.3+ console. This const is the single
// place to fix if the console serves the Protect integration API elsewhere.
const protectAPIBase = "/proxy/protect/integration/v1"

// Camera is one Protect camera from GET {protectAPIBase}/cameras. Tags follow
// the Protect API's camelCase JSON: `type` carries the model string (e.g.
// "UVC G6 Turret"), `host` the camera's LAN IP, and `mac` is reported
// colonless-uppercase (e.g. "8CEDE1112233") — the API ingest normalizes it.
type Camera struct {
	ID    string          `json:"id"`
	Mac   string          `json:"mac"`
	Name  string          `json:"name"`
	Model string          `json:"type"`
	State string          `json:"state"` // "CONNECTED" | "DISCONNECTED" | ...
	IP    string          `json:"host"`
	Raw   json.RawMessage `json:"-"`
}

// ProtectSnapshot is the result of one Protect poll. Available=false is NOT an
// error: Protect isn't installed (404) or the API key lacks the Protect scope
// (401/403). Callers skip silently with a single log line (see collector.go).
type ProtectSnapshot struct {
	Available  bool
	SkipReason string // set only when Available=false
	Cameras    []Camera
}

// PollProtect reads the Protect camera list. Capability semantics:
//   - 404 on the Protect base        → Available=false, nil error.
//   - 401/403 (key lacks scope)      → Available=false, nil error.
//   - transport error / other non-2xx → Available=true, non-nil error (the
//     console should have Protect but the poll failed — worth surfacing).
func (c *APIClient) PollProtect(ctx context.Context) (ProtectSnapshot, error) {
	snap := ProtectSnapshot{Available: true}
	body, status, err := c.getRaw(ctx, protectAPIBase+"/cameras")
	if status == http.StatusNotFound {
		snap.Available = false
		snap.SkipReason = "protect not installed or integration API absent (404)"
		return snap, nil
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		snap.Available = false
		snap.SkipReason = fmt.Sprintf("api key lacks protect scope (%d)", status)
		return snap, nil
	}
	if err != nil {
		return snap, err
	}

	// Tolerate both the enveloped ({"data":[...]}) and bare-array shapes — the
	// Protect integration API's envelope behavior must be confirmed live.
	data := json.RawMessage(body)
	var env envelope
	if uerr := json.Unmarshal(body, &env); uerr == nil && env.Data != nil {
		data = env.Data
	}

	var cams []Camera
	if uerr := json.Unmarshal(data, &cams); uerr != nil {
		return snap, fmt.Errorf("decode protect cameras: %w", uerr)
	}
	raws := rawElems(data)
	for i := range cams {
		cams[i].Raw = rawAt(raws, i)
	}
	snap.Cameras = cams
	return snap, nil
}
```

- [ ] Run again: `cd agent && go test -race ./internal/unifi/...` — all green, including the pre-existing Network client tests (proves the `get` refactor preserved behavior).
- [ ] Commit: `git add agent/internal/unifi/protect.go agent/internal/unifi/protect_test.go agent/internal/unifi/client.go && git commit -m "feat(agent): UniFi Protect integration client with capability detection (#2199)"`

### Task 7: ship cameras through the collector telemetry upload

**Files**
- Modify: `agent/internal/unifi/collector.go` (DTOs after line 74; payload struct line 81; `RunOnce` lines 120–156)
- Test: `agent/internal/unifi/collector_test.go` (append)

**Interfaces**
- Consumes: `(*APIClient).PollProtect` from Task 6.
- Produces (wire contract consumed by Task 8's zod schema — field names must match exactly):

```go
type uploadCamera struct {
	UnifiCameraID string          `json:"unifiCameraId"`
	Mac           string          `json:"mac,omitempty"`
	Name          string          `json:"name,omitempty"`
	Model         string          `json:"model,omitempty"`
	State         string          `json:"state,omitempty"`
	IP            string          `json:"ip,omitempty"`
	Raw           json.RawMessage `json:"raw,omitempty"`
}
// telemetryPayload gains: Cameras []uploadCamera `json:"cameras,omitempty"`
```

**Steps**

- [ ] Write the failing tests. Append to `agent/internal/unifi/collector_test.go`:

```go
func TestRunOnceUploadsProtectCameras(t *testing.T) {
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/proxy/network/integration/v1/sites":
			w.Write([]byte(`{"data":[]}`))
		case "/proxy/protect/integration/v1/cameras":
			w.Write([]byte(`{"data":[{"id":"cam1","mac":"8CEDE1112233","name":"G6 Turret","type":"UVC G6 Turret","state":"CONNECTED","host":"10.0.0.42"}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer controller.Close()

	var mu sync.Mutex
	var got map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/agents/agent-1/unifi-telemetry" {
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(202)
			return
		}
		w.WriteHeader(404)
	}))
	defer api.Close()

	cfg := CollectorConfig{CollectorID: "c1", ControllerURL: controller.URL, APIKey: "k"}
	if err := RunOnce(context.Background(), CollectorDeps{APIBaseURL: api.URL, AgentID: "agent-1", HTTP: api.Client()}, cfg, controller.Client()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	camsRaw, ok := got["cameras"].([]any)
	if !ok || len(camsRaw) != 1 {
		t.Fatalf("expected 1 camera in payload, got %+v", got["cameras"])
	}
	c0, _ := camsRaw[0].(map[string]any)
	if c0["unifiCameraId"] != "cam1" || c0["mac"] != "8CEDE1112233" ||
		c0["model"] != "UVC G6 Turret" || c0["state"] != "CONNECTED" || c0["ip"] != "10.0.0.42" {
		t.Fatalf("unexpected camera payload: %+v", camsRaw[0])
	}
}

// A console without Protect (404 on the protect base) must upload normally with
// the cameras field omitted — capability absence is not an error.
func TestRunOnceProtectAbsentOmitsCameras(t *testing.T) {
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/proxy/network/integration/v1/sites" {
			w.Write([]byte(`{"data":[]}`))
			return
		}
		w.WriteHeader(404) // protect base included
	}))
	defer controller.Close()

	var mu sync.Mutex
	var got map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/agents/agent-1/unifi-telemetry" {
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(202)
			return
		}
		w.WriteHeader(404)
	}))
	defer api.Close()

	cfg := CollectorConfig{CollectorID: "c1", ControllerURL: controller.URL, APIKey: "k"}
	if err := RunOnce(context.Background(), CollectorDeps{APIBaseURL: api.URL, AgentID: "agent-1", HTTP: api.Client()}, cfg, controller.Client()); err != nil {
		t.Fatalf("RunOnce should succeed without Protect: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if _, present := got["cameras"]; present {
		t.Fatalf("cameras must be omitted when Protect is unavailable, got %+v", got["cameras"])
	}
	if got["error"] != nil {
		t.Fatalf("protect absence must not set payload error, got %v", got["error"])
	}
}
```

- [ ] Run: `cd agent && go test -race ./internal/unifi/ -run 'TestRunOnceUploadsProtectCameras|TestRunOnceProtectAbsentOmitsCameras'` — `TestRunOnceUploadsProtectCameras` fails (no `cameras` key in payload); the absence test may pass trivially pre-implementation (that is fine — it pins the invariant).

- [ ] Implement in `agent/internal/unifi/collector.go`. Add after `uploadSite` (line 79):

```go
type uploadCamera struct {
	UnifiCameraID string          `json:"unifiCameraId"`
	Mac           string          `json:"mac,omitempty"`
	Name          string          `json:"name,omitempty"`
	Model         string          `json:"model,omitempty"`
	State         string          `json:"state,omitempty"`
	IP            string          `json:"ip,omitempty"`
	Raw           json.RawMessage `json:"raw,omitempty"`
}
```

Add the field to `telemetryPayload` (after `Sites`):

```go
	Cameras     []uploadCamera `json:"cameras,omitempty"`
```

Add after `toUploadClients`:

```go
func toUploadCameras(in []Camera) []uploadCamera {
	out := make([]uploadCamera, len(in))
	for i, cam := range in {
		out[i] = uploadCamera{
			UnifiCameraID: cam.ID, Mac: cam.Mac, Name: cam.Name,
			Model: cam.Model, State: cam.State, IP: cam.IP, Raw: cam.Raw,
		}
	}
	return out
}
```

And in `RunOnce`, insert after the `if pollErr != nil { payload.Error = pollErr.Error() }` block (line 137), before `json.Marshal`:

```go
	// Protect cameras ride along when the console exposes the Protect
	// integration API. Protect absent / key unscoped is NOT an error — skip with
	// one log line. A Protect poll failure never degrades the Network telemetry
	// (payload.Error stays untouched); it is logged and cameras are omitted.
	if snap.FirmwareOK {
		protect, perr := api.PollProtect(ctx)
		switch {
		case perr != nil:
			deps.logf("[unifi] collector %s: protect poll failed: %v", cfg.CollectorID, perr)
		case !protect.Available:
			deps.logf("[unifi] collector %s: protect skipped: %s", cfg.CollectorID, protect.SkipReason)
		default:
			payload.Cameras = toUploadCameras(protect.Cameras)
		}
	}
```

- [ ] Run again: `cd agent && go test -race ./internal/unifi/...` — all green (existing `TestRunOnceUploadsTelemetry` serves 404 for the protect path, so it exercises the skip branch too).
- [ ] Commit: `git add agent/internal/unifi/collector.go agent/internal/unifi/collector_test.go && git commit -m "feat(agent): upload Protect cameras in unifi telemetry payload (#2199)"`

### Task 8: API ingest — accept cameras and reconcile them into discovered_assets

**Files**
- Modify: `apps/api/src/routes/agents/unifiTelemetry.ts` (add `cameraDto`; extend `telemetrySchema` line 55)
- Modify: `apps/api/src/services/unifi/unifiTelemetryService.ts` (new DTO; extend `TelemetryPayload`, `ReconcileResult`; camera reconcile loop in `reconcileTelemetry`)
- Test: `apps/api/src/routes/agents/unifiTelemetry.test.ts` (append one case)
- Test: `apps/api/src/services/unifi/unifiTelemetryService.test.ts` (append cases)

**Interfaces**
- Consumes: the Task 7 wire shape (`cameras: [{ unifiCameraId, mac, name, model, state, ip, raw }]`).
- Produces:

```ts
export interface TelemetryCameraDto {
  unifiCameraId: string; raw: unknown;
  mac?: string | null; name?: string | null; model?: string | null;
  state?: string | null; ip?: string | null;
}
// TelemetryPayload gains: cameras?: TelemetryCameraDto[];
export interface ReconcileResult { devicesUpserted: number; devicesStaled: number; clientsUpserted: number; clientsStaled: number; camerasReconciled: number; }
```

**Steps**

- [ ] Write the failing route test. Append to `apps/api/src/routes/agents/unifiTelemetry.test.ts` inside the existing `describe`:

```ts
  it('POST /agents/:id/unifi-telemetry passes Protect cameras through to the queue (zod must not strip them)', async () => {
    const body = {
      collectorId: 'c1', polledAt: '2026-07-03T00:00:00Z', firmwareOk: true, devices: [], clients: [],
      cameras: [{ unifiCameraId: 'cam1', mac: '8CEDE1112233', name: 'G6 Turret', model: 'UVC G6 Turret', state: 'CONNECTED', ip: '10.0.0.42', raw: { x: 1 } }],
    };
    const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    expect(worker.enqueueUnifiTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ cameras: [expect.objectContaining({ unifiCameraId: 'cam1', mac: '8CEDE1112233' })] }),
    );
  });
```

- [ ] Write the failing service tests. Append to `apps/api/src/services/unifi/unifiTelemetryService.test.ts` inside `describe('reconcileTelemetry')`:

```ts
  it('reconciles a Protect camera onto an existing scan asset by MAC and types it camera', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [],
      assetByMac: { '8c:ed:e1:11:22:33': { id: 'asset-cam', typeSource: 'auto' } },
    });

    const res = await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-07-03T00:00:00Z', firmwareOk: true, devices: [], clients: [],
      cameras: [{ unifiCameraId: 'cam1', mac: '8CEDE1112233', name: 'G6 Turret', model: 'UVC G6 Turret', state: 'CONNECTED', ip: '10.0.0.42', raw: {} }],
    });

    expect(res.camerasReconciled).toBe(1);
    const assetUpdates = writes.updates.filter((w) => w.table === discoveredAssets);
    expect(assetUpdates).toHaveLength(1);
    expect(assetUpdates[0]!.values.assetType).toBe('camera');
    expect(assetUpdates[0]!.values.detectedAssetType).toBe('camera');
    expect(assetUpdates[0]!.values.hostname).toBe('G6 Turret');
    expect(assetUpdates[0]!.values.model).toBe('UVC G6 Turret');
    expect(assetUpdates[0]!.values.manufacturer).toBe('Ubiquiti');
    expect(assetUpdates[0]!.values.isOnline).toBe(true);
    // Matched by MAC — no duplicate row.
    expect(writes.inserts.filter((w) => w.table === discoveredAssets)).toHaveLength(0);
  });

  it('never clobbers a manual type override when reconciling a camera', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [],
      assetByMac: { '8c:ed:e1:11:22:33': { id: 'asset-cam', typeSource: 'manual' } },
    });

    await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-07-03T00:00:00Z', firmwareOk: true, devices: [], clients: [],
      cameras: [{ unifiCameraId: 'cam1', mac: '8CEDE1112233', name: 'G6 Turret', model: 'UVC G6 Turret', state: 'CONNECTED', ip: '10.0.0.42', raw: {} }],
    });

    const assetUpdates = writes.updates.filter((w) => w.table === discoveredAssets);
    expect(assetUpdates).toHaveLength(1);
    expect(assetUpdates[0]!.values).not.toHaveProperty('assetType'); // manual override wins
    expect(assetUpdates[0]!.values.detectedAssetType).toBe('camera'); // detection still recorded
  });

  it('creates a net-new camera asset (typeSource auto) when nothing matches and an IP is present', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [],
    });

    const res = await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-07-03T00:00:00Z', firmwareOk: true, devices: [], clients: [],
      cameras: [{ unifiCameraId: 'cam1', mac: '8CEDE1112233', name: 'G6 Turret', model: 'UVC G6 Turret', state: 'DISCONNECTED', ip: '10.0.0.42', raw: {} }],
    });

    expect(res.camerasReconciled).toBe(1);
    const assetInserts = writes.inserts.filter((w) => w.table === discoveredAssets);
    expect(assetInserts).toHaveLength(1);
    expect(assetInserts[0]!.values.orgId).toBe('org-a');
    expect(assetInserts[0]!.values.siteId).toBe('site-a');
    expect(assetInserts[0]!.values.ipAddress).toBe('10.0.0.42');
    expect(assetInserts[0]!.values.macAddress).toBe('8c:ed:e1:11:22:33'); // canonicalized
    expect(assetInserts[0]!.values.assetType).toBe('camera');
    expect(assetInserts[0]!.values.detectedAssetType).toBe('camera');
    expect(assetInserts[0]!.values.typeSource).toBe('auto');
    expect(assetInserts[0]!.values.isOnline).toBe(false); // DISCONNECTED
  });

  it('skips a camera with neither a matching MAC row nor an IP', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [],
    });

    const res = await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-07-03T00:00:00Z', firmwareOk: true, devices: [], clients: [],
      cameras: [{ unifiCameraId: 'cam1', mac: 'FF:FF:FF:00:00:01', name: 'Orphan', model: null, state: 'CONNECTED', ip: null, raw: {} }],
    });

    expect(res.camerasReconciled).toBe(0);
    expect(writes.inserts.filter((w) => w.table === discoveredAssets)).toHaveLength(0);
    expect(writes.updates.filter((w) => w.table === discoveredAssets)).toHaveLength(0);
  });
```

- [ ] Run both: `cd apps/api && npx vitest run src/routes/agents/unifiTelemetry.test.ts src/services/unifi/unifiTelemetryService.test.ts` — the route test fails (zod strips the unknown `cameras` key, so `enqueueUnifiTelemetry` receives no `cameras`); the service tests fail (`camerasReconciled` is `undefined`, no writes).

- [ ] Implement the route. In `apps/api/src/routes/agents/unifiTelemetry.ts`, add after `clientDto` (line 54):

```ts
const cameraDto = z.object({
  unifiCameraId: z.string().min(1),
  mac: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
  raw: z.unknown(),
});
```

and add to `telemetrySchema` after the `sites` line:

```ts
  cameras: z.array(cameraDto).optional(),
```

- [ ] Implement the service. In `apps/api/src/services/unifi/unifiTelemetryService.ts`:

Add after `TelemetryClientDto` (line 20):

```ts
export interface TelemetryCameraDto {
  unifiCameraId: string; raw: unknown;
  mac?: string | null; name?: string | null; model?: string | null;
  state?: string | null; ip?: string | null;
}
```

Add to `TelemetryPayload` after `clients`:

```ts
  cameras?: TelemetryCameraDto[];
```

Replace the `ReconcileResult` interface (line 31) with:

```ts
export interface ReconcileResult { devicesUpserted: number; devicesStaled: number; clientsUpserted: number; clientsStaled: number; camerasReconciled: number; }
```

Add after `normalizeMac` (line 38):

```ts
// Protect reports MACs colonless-uppercase ("8CEDE1112233"); canonicalize to the
// colon-lowercase form discovered_assets stores. Already-delimited MACs pass
// through normalizeMac unchanged.
function normalizeProtectMac(mac: string): string {
  const bare = mac.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (bare.length === 12) return bare.match(/.{2}/g)!.join(':');
  return normalizeMac(mac);
}
```

In `reconcileTelemetry`, update the result initializer (line 107):

```ts
  const result: ReconcileResult = { devicesUpserted: 0, devicesStaled: 0, clientsUpserted: 0, clientsStaled: 0, camerasReconciled: 0 };
```

and insert this block after the Clients section's stale sweep (after line 215, before `return result;`):

```ts
  // --- Protect cameras (Phase 3, #2199) ---
  // Reconcile-by-MAC into discovered_assets: the Protect record types/labels the
  // already-scan-discovered row (typeSource stays 'auto' so manual overrides
  // win). Cameras carry no unifiSiteId — Protect is console-wide — so they land
  // on the collector's own org/site.
  for (const cam of payload.cameras ?? []) {
    const mac = cam.mac ? normalizeProtectMac(cam.mac) : null;
    const isOnline = (cam.state ?? '').toUpperCase() === 'CONNECTED';

    let existing: { id: string; typeSource: string } | null = null;
    if (mac) {
      const [row] = await db
        .select({ id: discoveredAssets.id, typeSource: discoveredAssets.typeSource })
        .from(discoveredAssets)
        .where(and(
          eq(discoveredAssets.orgId, collector.orgId),
          eq(sql`lower(replace(${discoveredAssets.macAddress}, '-', ':'))`, mac),
        ))
        .limit(1);
      existing = row ?? null;
    }

    if (existing) {
      await db.update(discoveredAssets).set({
        macAddress: mac ?? undefined,
        hostname: cam.name ?? undefined,
        manufacturer: 'Ubiquiti',
        model: cam.model ?? undefined,
        detectedAssetType: 'camera',
        // NEVER clobber a manual type override — only auto-typed rows get retyped.
        ...(existing.typeSource === 'manual' ? {} : { assetType: 'camera' as const }),
        isOnline,
        lastSeenAt: seenAt,
      }).where(eq(discoveredAssets.id, existing.id));
      result.camerasReconciled++;
      continue;
    }

    // Net-new needs an IP (ip_address is inet NOT NULL). A camera with neither a
    // matching MAC row nor an IP is skipped this poll — the next network scan
    // will discover it by IP and this loop will then match it by MAC.
    if (!cam.ip) continue;
    await db.insert(discoveredAssets).values({
      orgId: collector.orgId, siteId: collector.siteId, ipAddress: cam.ip,
      macAddress: mac, hostname: cam.name ?? null, manufacturer: 'Ubiquiti',
      model: cam.model ?? null,
      assetType: 'camera', detectedAssetType: 'camera', typeSource: 'auto',
      isOnline, lastSeenAt: seenAt,
    }).onConflictDoUpdate({
      target: [discoveredAssets.orgId, discoveredAssets.ipAddress],
      set: {
        macAddress: mac, hostname: cam.name ?? null, manufacturer: 'Ubiquiti',
        model: cam.model ?? null,
        detectedAssetType: 'camera',
        // Conflict = a row raced in by IP; retype only while it is auto-typed.
        assetType: sql`CASE WHEN ${discoveredAssets.typeSource} = 'auto' THEN 'camera'::discovered_asset_type ELSE ${discoveredAssets.assetType} END`,
        isOnline, lastSeenAt: seenAt,
      },
    });
    result.camerasReconciled++;
  }
```

(`and`, `eq`, `sql` are already imported at line 1 of this file.)

- [ ] Run again: `cd apps/api && npx vitest run src/routes/agents/unifiTelemetry.test.ts src/services/unifi/unifiTelemetryService.test.ts` — all green, including all pre-existing cases.
- [ ] Commit: `git add apps/api/src/routes/agents/unifiTelemetry.ts apps/api/src/services/unifi/unifiTelemetryService.ts apps/api/src/routes/agents/unifiTelemetry.test.ts apps/api/src/services/unifi/unifiTelemetryService.test.ts && git commit -m "feat(unifi): ingest Protect cameras and reconcile into discovered_assets as camera (#2199)"`

### Task 9: cloud sync — camera case in `assetType()`

Task 1 already fixed the writer (`reconcileDiscoveredAsset`) and added the unmapped-deviceType log. This task adds the camera mapping itself so a Protect device appearing in the Site Manager `/v1/devices` payload types as `camera` instead of triggering the unmapped-type log.

> **VERIFY BEFORE MERGE (acceptable verification note, not a placeholder):** `'uvc'` / `'camera'` / `'protect'` are candidate strings — we deliberately did NOT invent the authoritative one. Before merging, reconcile these cases against reality: the Task 1 `[unifi-sync] unmapped UniFi deviceType ...` production log lines (the reporter's G6 appears in the Network integration list, so the string will show up there), or a live console's `/v1/devices` payload. Add/adjust cases to match the observed string; keep the candidates that don't conflict.

**Files**
- Modify: `apps/api/src/services/unifi/unifiSyncService.ts` (`assetType()` lines 19–40)
- Test: `apps/api/src/services/unifi/unifiSyncService.test.ts` (append)

**Interfaces**
- Produces: `function assetType(deviceType: string | null): 'switch' | 'access_point' | 'router' | 'firewall' | 'camera' | 'unknown'` (module-private; return union gains `'camera'`). `reconcileDiscoveredAsset` (fixed in Task 1) needs no further change — it already writes `detectedAssetType`/guarded `assetType` for any known type.

**Steps**

- [ ] Write the failing test. Append to `apps/api/src/services/unifi/unifiSyncService.test.ts` inside `describe('unifiSyncService.syncIntegration')`:

```ts
  it('maps a Protect camera device type to a camera discovered_asset', async () => {
    const { writes, db } = scriptedDb({ mappings: [BASE_MAPPING] });
    const client = fakeClient([{
      ...NET_NEW_DEVICE,
      unifiDeviceId: 'cam1',
      deviceType: 'uvc',
      model: 'UVC G6 Turret',
      ip: '10.0.0.42',
      raw: { id: 'cam1', type: 'uvc' },
    }]);

    await syncIntegration({ db, client }, BASE_INTEGRATION, 'manual');

    const assetInserts = writes.inserts.filter((w) => w.table === discoveredAssets);
    expect(assetInserts).toHaveLength(1);
    expect(assetInserts[0]!.values.assetType).toBe('camera');
    expect(assetInserts[0]!.values.detectedAssetType).toBe('camera');
  });
```

- [ ] Run: `cd apps/api && npx vitest run src/services/unifi/unifiSyncService.test.ts` — the new test fails (insert has `assetType: 'unknown'` and no `detectedAssetType`).

- [ ] Implement. In `apps/api/src/services/unifi/unifiSyncService.ts`, replace `assetType()` (lines 19–40) with:

```ts
function assetType(
  deviceType: string | null,
): 'switch' | 'access_point' | 'router' | 'firewall' | 'camera' | 'unknown' {
  switch ((deviceType ?? '').toLowerCase()) {
    case 'usw':
    case 'switch':
      return 'switch';
    case 'uap':
    case 'ap':
      return 'access_point';
    case 'ugw':
    case 'usg':
    case 'udm':
    case 'gateway':
      return 'router';
    case 'ufg':
    case 'firewall':
      return 'firewall';
    // Candidate Protect strings — see the VERIFY BEFORE MERGE note above; the
    // authoritative value comes from the Task 1 unmapped-deviceType log.
    case 'uvc':
    case 'camera':
    case 'protect':
      return 'camera';
    default:
      return 'unknown';
  }
}
```

- [ ] Run again: `cd apps/api && npx vitest run src/services/unifi/unifiSyncService.test.ts` — all green (including the Task 1 guard tests, which are unaffected).
- [ ] Run the integration suite that touches this table if a local DB is up (optional but recommended): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/unifiCollectorUpsert.integration.test.ts`
- [ ] Commit: `git add apps/api/src/services/unifi/unifiSyncService.ts apps/api/src/services/unifi/unifiSyncService.test.ts && git commit -m "feat(unifi): map Protect camera deviceType in cloud sync assetType (#2199)"`

---

## Verification

**Unit tests (all milestones):**

```bash
cd apps/api && npx vitest run \
  src/services/unifi/unifiSyncService.test.ts \
  src/services/macVendorLookup.test.ts \
  src/jobs/discoveryWorker.test.ts \
  src/routes/agents/unifiTelemetry.test.ts \
  src/services/unifi/unifiTelemetryService.test.ts

cd agent && go test -race ./internal/discovery/... ./internal/unifi/...

# Full suites before each PR:
pnpm test --filter=@breeze/api
cd agent && go test -race ./...
```

**End-to-end (Milestones 1+2 — the reported scenario):** on a site with a UniFi integration syncing:
1. Manually set an asset's type to Camera (per PR #2200), trigger a UniFi sync (manual sync button or wait a cycle), and confirm the type SURVIVES the sync — this is the reported clobber, fixed by Task 1.
2. Confirm a previously scan-typed asset (e.g. OUI-inferred `access_point`) is no longer flipped to `unknown` by the sync, and that the sync now records `detected_asset_type`.
3. Check API logs for `[unifi-sync] unmapped UniFi deviceType` lines — capture the raw value reported for the G6 camera and feed it to Task 9.
4. Run a discovery scan against a subnet containing a camera with no open ports/SNMP: expect `camera` when the hostname matches (e.g. `G6-Turret` + Ubiquiti OUI), or `access_point` via the vendor fallback — never a regression to `unknown` for hosts that previously typed.

**Live verification (Milestone 3 — REQUIRED before merging the Phase 3 PR):** point an agent's UniFi collector at a real UniFi OS console running Protect:
1. Confirm the exact Protect endpoint: `curl -k -H 'X-API-KEY: <key>' https://<console>/proxy/protect/integration/v1/cameras` — adjust `protectAPIBase` (and the `Camera` JSON tags for `type`/`host`/envelope shape) in `agent/internal/unifi/protect.go` if the live response differs, updating `protect_test.go` fixtures to match reality. Also confirm the Site Manager `/v1/devices` deviceType string for cameras (Task 9's cases).
2. With Protect present: confirm cameras appear in `discovered_assets` typed `camera` (reconciled onto existing scan rows by MAC — no duplicates), and that a manually-overridden row keeps its type while `detected_asset_type` becomes `camera`.
3. With a Network-only console (or an API key without the Protect scope): confirm exactly one `protect skipped: ...` agent log line per poll, telemetry still ingests devices/clients normally, and the collector status stays `connected`.
4. Do not pollute real tenant data — use the dev/VM rig, not a customer org.

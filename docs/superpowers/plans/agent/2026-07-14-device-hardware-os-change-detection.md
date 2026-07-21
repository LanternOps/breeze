# Device Hardware & OS Change Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect hardware (RAM/CPU/disk/BIOS/serial) and OS-version changes on each agent and record them as `device_change_log` events, so the Phase 1 Change History tab shows "Memory 4 GB → 8 GB" / "OS updated".

**Architecture:** Agent-side diffing in the existing `change_tracker` collector (same snapshot/diff/ingest path as software/network), two new `change_type` enum values (`hardware`, `os_version`) threaded through the DB enum + three lockstep app-layer lists + the AI tool, and two new filter labels in the Phase 1 UI. No new subsystems; no server-side inventory diffing.

**Tech Stack:** Go agent collectors; PostgreSQL enum migration (autoMigrate); Hono/Zod API; Drizzle; React/i18n web.

**Spec:** `docs/superpowers/specs/agent/2026-07-14-device-hardware-os-change-detection-design.md`

## Global Constraints

- Two new `change_type` values only: `hardware` and `os_version`. No new `change_action` values (reuse `added`/`removed`/`modified`/`updated`).
- The two new values must be added to EVERY member of the lockstep set, in one coherent change per layer: Go `ChangeType` consts + `validTypes` map; DB `changeTypeEnum` pgEnum; the enum migration; `routes/changes.ts` `changeTypeValues`; `routes/agents/schemas.ts` `changeTypeValues`; `aiToolsAudit.ts` `query_change_log` enum + description; web `CHANGE_TYPES` + `typeLabel` + `badgeClassForType` + locale `type_*` keys.
- Migration: date-prefixed `YYYY-MM-DD-<slug>.sql`, idempotent (`ADD VALUE IF NOT EXISTS`), NO inner `BEGIN;`/`COMMIT;`, and it must NOT *use* the new enum values in the same file (only ADD them) — safe under autoMigrate's per-file transaction on PG12+.
- i18n: any new `en` key must be added to all 5 locales (`en`, `es-419`, `fr-FR`, `de-DE`, `pt-BR`) `devices.json` with exact key parity, string leaves, and NON-baseline-duplicate translations (a value byte-identical to English can red main). Guards: `localeParity.test.ts`, `keyUsage.test.ts`.
- Web enum labels use literal-key `t()` lookups (explicit `switch` cases), never dynamically constructed keys — required for the `keyUsage` static guard.
- First-run seeding: when the agent snapshot has no hardware/OS section yet, populate it and emit ZERO change records (never "changed from nothing").
- Agent reuses the inventory the heartbeat already collects (`HardwareCollector`, `InventoryCollector`) — the change tracker must not add its own hardware queries.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work on branch `ToddHebebrand/device-change-history-phase2`; do not push per-task.

---

### Task 1: DB migration — add `hardware` + `os_version` to `change_type`

**Files:**
- Create: `apps/api/migrations/2026-07-14-change-log-hardware-os-enum.sql`
- Reference (do not edit): `apps/api/src/db/autoMigrate.test.ts` (ordering regression test)

**Interfaces:**
- Produces: the DB enum `change_type` gains values `'hardware'`, `'os_version'` (consumed by Task 2's real-pg test and Task 3/4's agent submissions).

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-07-14-change-log-hardware-os-enum.sql`:

```sql
-- Phase 2 of #2502: hardware & OS change detection.
-- Adds two categories to the device_change_log change_type enum so the agent
-- can submit hardware (RAM/CPU/disk/BIOS/serial) and OS-version change events.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe in PG12+ as long as the new
-- value is not *used* in the same transaction. This file only ADDs the values
-- (no INSERT/DEFAULT/comparison uses them), so it runs safely under
-- autoMigrate's per-file transaction. Both statements are idempotent.

ALTER TYPE change_type ADD VALUE IF NOT EXISTS 'hardware';

ALTER TYPE change_type ADD VALUE IF NOT EXISTS 'os_version';
```

- [ ] **Step 2: Apply and verify idempotency**

Run (with a local DB): `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm --filter @breeze/api exec tsx src/db/autoMigrate.ts` (or run the API boot, which auto-migrates).
Expected: migration applies once; a second run is a no-op (file already in `breeze_migrations`); `SELECT enum_range(NULL::change_type);` includes `hardware,os_version`.

- [ ] **Step 3: Run the migration-ordering regression test**

Run: `pnpm --filter @breeze/api test -- autoMigrate`
Expected: PASS (the new date-prefixed file sorts correctly; it has no same-day dependency).

- [ ] **Step 4: Verify no drift**

Run: `pnpm db:check-drift`
Expected: no drift after Task 2 updates the Drizzle pgEnum (if run before Task 2, the pgEnum lag is expected — note it and proceed; re-run at end of Task 2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-14-change-log-hardware-os-enum.sql
git commit -m "feat(db): add hardware + os_version to change_type enum (#2502)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend enum wiring — pgEnum, both `changeTypeValues` arrays, AI tool

**Files:**
- Modify: `apps/api/src/db/schema/changes.ts:14-21` (pgEnum)
- Modify: `apps/api/src/routes/changes.ts:10-17` (read-route array)
- Modify: `apps/api/src/routes/agents/schemas.ts:673-680` (ingest array)
- Modify: `apps/api/src/services/aiToolsAudit.ts:197,206` (AI tool enum + description)
- Test: `apps/api/src/routes/agents/changes.integration.test.ts` (new or existing ingest integration test — real Postgres)

**Interfaces:**
- Consumes: DB enum from Task 1.
- Produces: `changeTypeValues` (both) now include `'hardware'`, `'os_version'` (consumed by ingest of agent submissions in Task 4); AI tool accepts the new filters.

- [ ] **Step 1: Extend the pgEnum** — `apps/api/src/db/schema/changes.ts`

```ts
export const changeTypeEnum = pgEnum('change_type', [
  'software',
  'service',
  'startup',
  'network',
  'scheduled_task',
  'user_account',
  'hardware',
  'os_version'
]);
```

- [ ] **Step 2: Extend the read-route array** — `apps/api/src/routes/changes.ts`

```ts
const changeTypeValues = [
  'software',
  'service',
  'startup',
  'network',
  'scheduled_task',
  'user_account',
  'hardware',
  'os_version'
] as const;
```

- [ ] **Step 3: Extend the ingest array** — `apps/api/src/routes/agents/schemas.ts`

```ts
export const changeTypeValues = [
  'software',
  'service',
  'startup',
  'network',
  'scheduled_task',
  'user_account',
  'hardware',
  'os_version'
] as const;
```

- [ ] **Step 4: Extend the AI tool enum + description** — `apps/api/src/services/aiToolsAudit.ts`

Description (line ~197):
```ts
      description: 'Search device configuration changes such as software installs/updates, service changes, startup drift, network changes, scheduled task changes, user account changes, hardware changes (memory/CPU/disk/BIOS/serial), and OS version updates.',
```
Enum (line ~206):
```ts
          changeType: {
            type: 'string',
            enum: ['software', 'service', 'startup', 'network', 'scheduled_task', 'user_account', 'hardware', 'os_version'],
            description: 'Optional change category filter'
          },
```

- [ ] **Step 5: Write a real-Postgres ingest test** (a pg enum cannot be validated by a mocked DB)

In `apps/api/src/routes/agents/changes.integration.test.ts` (follow the existing integration-test harness — see `test_integration_config_run_mechanics` conventions; runs on :5433), add a case that submits a change batch with `changeType: 'hardware'` and one with `changeType: 'os_version'` and asserts they persist:

```ts
it('accepts hardware and os_version change types', async () => {
  const res = await submitChanges(deviceId, [
    { timestamp: new Date().toISOString(), changeType: 'hardware', changeAction: 'modified', subject: 'Memory', beforeValue: { totalMb: 4096 }, afterValue: { totalMb: 8192 } },
    { timestamp: new Date().toISOString(), changeType: 'os_version', changeAction: 'updated', subject: 'Operating System', beforeValue: { version: '22H2' }, afterValue: { version: '23H2' } },
  ]);
  expect(res.status).toBe(200);
  const rows = await db.select().from(deviceChangeLog).where(eq(deviceChangeLog.deviceId, deviceId));
  expect(rows.map(r => r.changeType).sort()).toEqual(['hardware', 'os_version']);
});
```

- [ ] **Step 6: Run the ingest integration test + drift check**

Run: `pnpm --filter @breeze/api test:integration -- changes` and `pnpm db:check-drift`
Expected: PASS; no drift (pgEnum now matches the migration).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/changes.ts apps/api/src/routes/changes.ts apps/api/src/routes/agents/schemas.ts apps/api/src/services/aiToolsAudit.ts apps/api/src/routes/agents/changes.integration.test.ts
git commit -m "feat(api): wire hardware + os_version change types (enum, ingest, AI tool) (#2502)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Agent — capture hardware & OS state in the change snapshot

**Files:**
- Modify: `agent/internal/collectors/change_tracker.go` (Snapshot struct `:75-84`; `ChangeType` consts `:20-27`; `validTypes` map `:960-967`; `gatherCurrentSnapshot` `:263-417`)
- Reference (reuse, do not modify): `agent/internal/collectors/hardware.go` (`HardwareCollector`, `HardwareInfo`, `SystemInfo`, `CollectSystemInfo`)
- Test: `agent/internal/collectors/change_tracker_test.go`

**Interfaces:**
- Produces: `Snapshot.Hardware *HardwareState` and `Snapshot.System *SystemState` populated each cycle; new consts `ChangeTypeHardware = "hardware"`, `ChangeTypeOS = "os_version"`. (Consumed by Task 4's diff.)

- [ ] **Step 1: Add the ChangeType consts** — `change_tracker.go` const block (`:20-27`)

```go
	ChangeTypeSoftware    ChangeType = "software"
	ChangeTypeService     ChangeType = "service"
	ChangeTypeStartup     ChangeType = "startup"
	ChangeTypeNetwork     ChangeType = "network"
	ChangeTypeTask        ChangeType = "scheduled_task"
	ChangeTypeUserAccount ChangeType = "user_account"
	ChangeTypeHardware    ChangeType = "hardware"
	ChangeTypeOS          ChangeType = "os_version"
```
And add both to the `validTypes` map in `parseChangeIgnoreRules` (`:960-967`) so they're ignorable via `BREEZE_CHANGE_TRACKER_IGNORE`:
```go
		string(ChangeTypeHardware):    true,
		string(ChangeTypeOS):          true,
```

- [ ] **Step 2: Add snapshot state types + fields** — `change_tracker.go` (near the `Snapshot` struct `:75-84`)

```go
// HardwareState is the subset of hardware inventory the change tracker diffs.
type HardwareState struct {
	RAMTotalMB   uint64 `json:"ramTotalMb"`
	CPUModel     string `json:"cpuModel"`
	CPUCores     int    `json:"cpuCores"`
	DiskTotalGB  uint64 `json:"diskTotalGb"`
	BIOSVersion  string `json:"biosVersion"`
	SerialNumber string `json:"serialNumber"`
	Motherboard  string `json:"motherboard"`
}

// SystemState is the OS identity the change tracker diffs.
type SystemState struct {
	OSVersion string `json:"osVersion"`
	OSBuild   string `json:"osBuild"`
}
```
Add to `Snapshot` (pointer fields so "not yet collected" is distinguishable from zero — required for first-run seeding):
```go
	Hardware        *HardwareState                  `json:"hardware,omitempty"`
	System          *SystemState                    `json:"system,omitempty"`
```
`ensureSnapshotMaps` (`:507-529`) does NOT need changes — these are pointer singletons, not maps.

- [ ] **Step 3: Collect hardware/OS into the snapshot** — `gatherCurrentSnapshot` (`:263-417`)

Bump the WaitGroup (`wg.Add(6)` → `wg.Add(7)` at line ~306) and add a goroutine mirroring the existing error-fallback-to-previous-snapshot pattern (lines 339-413). Reuse a `HardwareCollector` (add `hwCollector := NewHardwareCollector()` alongside the existing `invCollector := NewInventoryCollector()` at line ~301). Confirm the exact hardware-collection method name in `hardware.go` (the method that returns `*HardwareInfo`, e.g. `CollectHardwareInfo()`; grep `func (c *HardwareCollector)` in `hardware.go`). Populate:

```go
	go collectWithTimeout(&wg, "hardware", func() {
		hw, err := hwCollector.CollectHardwareInfo() // confirm exact method name
		sys, sysErr := hwCollector.CollectSystemInfo()
		if err != nil || hw == nil {
			// fall back to previous snapshot's hardware (no spurious diff)
			snapshot.Hardware = c.lastSnapshot.Hardware
		} else {
			snapshot.Hardware = &HardwareState{
				RAMTotalMB:   hw.RAMTotalMB,
				CPUModel:     hw.CPUModel,
				CPUCores:     hw.CPUCores,
				DiskTotalGB:  hw.DiskTotalGB,
				BIOSVersion:  hw.BIOSVersion,
				SerialNumber: hw.SerialNumber,
				Motherboard:  strings.TrimSpace(hw.MotherboardManufacturer + " " + hw.MotherboardProduct),
			}
		}
		if sysErr != nil || sys == nil {
			snapshot.System = c.lastSnapshot.System
		} else {
			snapshot.System = &SystemState{OSVersion: sys.OSVersion, OSBuild: sys.OSBuild}
		}
	})
```
(Match the actual signature of `collectWithTimeout` in this file; if it passes a per-collector timeout arg, follow the existing call sites verbatim.)

- [ ] **Step 4: Write a test that the snapshot captures hardware/OS** — `change_tracker_test.go`

Extend the `baselineSnapshot()` fixture builder (`:93+`) to set `Hardware` and `System`, then add:

```go
func TestChangeTrackerSnapshotCapturesHardwareAndOS(t *testing.T) {
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.json")
	collector := NewChangeTrackerCollector(snapshotPath)
	collector.gatherSnapshot = func() (*Snapshot, error) { return baselineSnapshot(), nil }

	if _, err := collector.CollectChanges(); err != nil {
		t.Fatalf("CollectChanges error: %v", err)
	}
	if collector.lastSnapshot.Hardware == nil || collector.lastSnapshot.Hardware.RAMTotalMB == 0 {
		t.Fatalf("expected hardware captured in snapshot, got %+v", collector.lastSnapshot.Hardware)
	}
	if collector.lastSnapshot.System == nil || collector.lastSnapshot.System.OSVersion == "" {
		t.Fatalf("expected OS captured in snapshot, got %+v", collector.lastSnapshot.System)
	}
}
```

- [ ] **Step 5: Run tests**

Run: `cd agent && go test -race ./internal/collectors/ -run ChangeTracker`
Expected: PASS (including the existing drift test, unaffected).

- [ ] **Step 6: Commit**

```bash
git add agent/internal/collectors/change_tracker.go agent/internal/collectors/change_tracker_test.go
git commit -m "feat(agent): capture hardware & OS state in change snapshot (#2502)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Agent — diff hardware/OS and emit change records (with first-run seeding)

**Files:**
- Modify: `agent/internal/collectors/change_tracker.go` (new `diffHardware`/`diffOS`; wire into `CollectChanges` `:151-158` and `initialInventory` `:169-261`)
- Test: `agent/internal/collectors/change_tracker_test.go`

**Interfaces:**
- Consumes: `Snapshot.Hardware`/`Snapshot.System` (Task 3); `ChangeTypeHardware`/`ChangeTypeOS` (Task 3).
- Produces: `hardware`/`os_version` `ChangeRecord`s in `CollectChanges` output → shipped via the unchanged `sendConfigurationChanges` path.

- [ ] **Step 1: Write the diff functions** — `change_tracker.go` (mirror `diffServices` field-level style)

```go
func (c *ChangeTrackerCollector) diffHardware(current *Snapshot) []ChangeRecord {
	now := c.now()
	changes := make([]ChangeRecord, 0)
	prev := c.lastSnapshot.Hardware
	cur := current.Hardware
	if prev == nil || cur == nil {
		return changes // first-run seed or unavailable: no events
	}
	emit := func(subject string, before, after any) {
		changes = append(changes, ChangeRecord{
			Timestamp: now, ChangeType: ChangeTypeHardware, ChangeAction: ChangeActionModified,
			Subject:     subject,
			BeforeValue: map[string]any{"value": before},
			AfterValue:  map[string]any{"value": after},
		})
	}
	if prev.RAMTotalMB != cur.RAMTotalMB {
		emit("Memory", prev.RAMTotalMB, cur.RAMTotalMB)
	}
	if prev.CPUModel != cur.CPUModel || prev.CPUCores != cur.CPUCores {
		changes = append(changes, ChangeRecord{
			Timestamp: now, ChangeType: ChangeTypeHardware, ChangeAction: ChangeActionModified, Subject: "Processor",
			BeforeValue: map[string]any{"model": prev.CPUModel, "cores": prev.CPUCores},
			AfterValue:  map[string]any{"model": cur.CPUModel, "cores": cur.CPUCores},
		})
	}
	if prev.DiskTotalGB != cur.DiskTotalGB {
		emit("Storage", prev.DiskTotalGB, cur.DiskTotalGB)
	}
	if prev.BIOSVersion != cur.BIOSVersion {
		changes = append(changes, ChangeRecord{
			Timestamp: now, ChangeType: ChangeTypeHardware, ChangeAction: ChangeActionUpdated, Subject: "BIOS",
			BeforeValue: map[string]any{"value": prev.BIOSVersion}, AfterValue: map[string]any{"value": cur.BIOSVersion},
		})
	}
	if prev.SerialNumber != cur.SerialNumber {
		emit("System Serial", prev.SerialNumber, cur.SerialNumber)
	}
	if prev.Motherboard != cur.Motherboard {
		emit("Motherboard", prev.Motherboard, cur.Motherboard)
	}
	return changes
}

func (c *ChangeTrackerCollector) diffOS(current *Snapshot) []ChangeRecord {
	now := c.now()
	prev := c.lastSnapshot.System
	cur := current.System
	if prev == nil || cur == nil || prev.OSVersion == cur.OSVersion {
		return nil
	}
	return []ChangeRecord{{
		Timestamp: now, ChangeType: ChangeTypeOS, ChangeAction: ChangeActionUpdated, Subject: "Operating System",
		BeforeValue: map[string]any{"version": prev.OSVersion, "build": prev.OSBuild},
		AfterValue:  map[string]any{"version": cur.OSVersion, "build": cur.OSBuild},
	}}
}
```

- [ ] **Step 2: Wire into CollectChanges** — `change_tracker.go:151-158` (append before `filterNoise`)

```go
	changes = append(changes, c.diffUserAccounts(currentSnapshot)...)
	changes = append(changes, c.diffHardware(currentSnapshot)...)
	changes = append(changes, c.diffOS(currentSnapshot)...)
	changes = c.filterNoise(changes)
```

- [ ] **Step 3: Confirm first-run path** — `initialInventory` (`:169-261`)

`initialInventory` emits baseline "added" records for maps. Hardware/OS are singletons diffed only against a prior snapshot, and `diffHardware`/`diffOS` already return no records when `prev == nil`. Do NOT add hardware/OS to `initialInventory` (we don't want a baseline "added" for current specs). Add a one-line comment there noting hardware/OS are intentionally excluded from initial inventory (first observed state is the baseline, silently).

- [ ] **Step 4: Write drift + seeding tests** — `change_tracker_test.go`

Extend `driftedSnapshot()` (`:93+` sibling) to bump `Hardware.RAMTotalMB` (4096→8192) and `System.OSVersion`. Then:

```go
func TestChangeTrackerDetectsHardwareAndOSDrift(t *testing.T) {
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.json")
	collector := NewChangeTrackerCollector(snapshotPath)
	call := 0
	collector.gatherSnapshot = func() (*Snapshot, error) {
		call++
		if call == 1 {
			return baselineSnapshot(), nil // seeds; must emit nothing for hw/os
		}
		return driftedSnapshot(), nil
	}
	first, _ := collector.CollectChanges()
	for _, ch := range first {
		if ch.ChangeType == ChangeTypeHardware || ch.ChangeType == ChangeTypeOS {
			t.Fatalf("first run must not emit hardware/os events, got %s/%s", ch.ChangeType, ch.Subject)
		}
	}
	changes, _ := collector.CollectChanges()
	expectChange(t, changes, ChangeTypeHardware, ChangeActionModified, "Memory")
	expectChange(t, changes, ChangeTypeOS, ChangeActionUpdated, "Operating System")
}
```

- [ ] **Step 5: Run tests**

Run: `cd agent && go test -race ./internal/collectors/ -run ChangeTracker`
Expected: PASS (new + existing).

- [ ] **Step 6: Commit**

```bash
git add agent/internal/collectors/change_tracker.go agent/internal/collectors/change_tracker_test.go
git commit -m "feat(agent): diff & emit hardware and OS change events (#2502)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Web — add Hardware & OS Version filter labels

**Files:**
- Modify: `apps/web/src/components/devices/DeviceChangeHistoryTab.tsx` (`CHANGE_TYPES` `:35-42`; `typeLabel` `:61-78`; `badgeClassForType` `:95-112`)
- Modify: `apps/web/src/locales/{en,es-419,fr-FR,de-DE,pt-BR}/devices.json` (`deviceChangeHistoryTab.type_hardware`, `type_os_version`)
- Test: `apps/web/src/components/devices/DeviceChangeHistoryTab.test.tsx`

**Interfaces:**
- Consumes: the `hardware`/`os_version` change types (rows arrive from the API once agents report).
- Produces: two new options in the change-type filter with translated labels + badges.

- [ ] **Step 1: Extend `CHANGE_TYPES`** — `DeviceChangeHistoryTab.tsx:35-42`

```tsx
const CHANGE_TYPES = [
  "software",
  "service",
  "startup",
  "network",
  "scheduled_task",
  "user_account",
  "hardware",
  "os_version",
] as const;
```

- [ ] **Step 2: Add `typeLabel` cases** — `DeviceChangeHistoryTab.tsx:61-78` (before `default:`)

```tsx
    case "hardware":
      return t("deviceChangeHistoryTab.type_hardware");
    case "os_version":
      return t("deviceChangeHistoryTab.type_os_version");
```

- [ ] **Step 3: Add badge colors** — `badgeClassForType` (`:95-112`), before `default:` (pick classes consistent with the existing palette, e.g.):

```tsx
    case "hardware":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case "os_version":
      return "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300";
```

- [ ] **Step 4: Add locale keys to all 5 files** — after `type_user_account` in each `deviceChangeHistoryTab` block:

`en/devices.json`:
```json
    "type_hardware": "Hardware",
    "type_os_version": "OS Version",
```
`es-419/devices.json`:
```json
    "type_hardware": "Hardware",
    "type_os_version": "Versión del SO",
```
`fr-FR/devices.json`:
```json
    "type_hardware": "Matériel",
    "type_os_version": "Version du SE",
```
`de-DE/devices.json`:
```json
    "type_hardware": "Hardware",
    "type_os_version": "Betriebssystemversion",
```
`pt-BR/devices.json`:
```json
    "type_hardware": "Hardware",
    "type_os_version": "Versão do SO",
```
Note: `type_hardware` is "Hardware" in en/es/de (a legitimate loanword) — verify this does not trip the duplicate-baseline guard for es-419/de-DE. If it does, differentiate (e.g. es "Hardware (componentes)" is awkward — prefer confirming the guard only flags WITHIN-file dup or specific protected strings; `localeParity.test.ts` protected-literal handling allows identical technical/product terms). If the guard rejects, use es `"Equipo"` / de `"Gerätehardware"`.

- [ ] **Step 5: Extend a UI test** — `DeviceChangeHistoryTab.test.tsx`

Add an assertion that the type filter renders the two new options:
```tsx
it('offers hardware and os_version type filters', async () => {
  fetchWithAuthMock.mockResolvedValue(jsonResponse({ changes: [], total: 0, showing: 0, hasMore: false, nextCursor: null }));
  render(<DeviceChangeHistoryTab deviceId="dev-1" />);
  const select = await screen.findByTestId('change-history-type-filter');
  expect(within(select).getByText('Hardware')).toBeInTheDocument();
  expect(within(select).getByText('OS Version')).toBeInTheDocument();
});
```

- [ ] **Step 6: Run web tests**

Run: `pnpm --filter @breeze/web test -- DeviceChangeHistoryTab localeParity keyUsage`
Expected: PASS; parity + keyUsage green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/DeviceChangeHistoryTab.tsx apps/web/src/components/devices/DeviceChangeHistoryTab.test.tsx apps/web/src/locales/en/devices.json apps/web/src/locales/es-419/devices.json apps/web/src/locales/fr-FR/devices.json apps/web/src/locales/de-DE/devices.json apps/web/src/locales/pt-BR/devices.json
git commit -m "feat(web): Hardware & OS Version filters in Change History tab (#2502)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Verification (whole feature)

- Go: `cd agent && go test -race ./internal/collectors/...` green.
- API: `pnpm --filter @breeze/api test:integration -- changes` + `pnpm db:check-drift` green.
- Web: `pnpm --filter @breeze/web test -- DeviceChangeHistoryTab localeParity keyUsage` green.
- Manual/driven: seed a `device_change_log` row with `changeType='hardware'` (Memory 4096→8192) and one `os_version`, open the device `#change-history` tab, confirm the rows render with the new badges and the two new filter options work.

## Known scope note (see Execution Handoff)

Disk change detection uses **total fixed-disk capacity** (`HardwareInfo.DiskTotalGB`), emitting a `hardware`/`Storage`/`modified` event when it changes. **Per-physical-disk add/remove events are NOT in this plan** — the agent does not currently enumerate physical disks with stable serials (only aggregate `DiskTotalGB` and mount-point `DiskInfo`), so true add/remove would require new cross-platform physical-disk collection (WMI `Win32_DiskDrive`, `lsblk`, `diskutil`). Total-capacity change already covers the common "disk swapped/upgraded" case. Deferring add/remove to a follow-up is recommended.

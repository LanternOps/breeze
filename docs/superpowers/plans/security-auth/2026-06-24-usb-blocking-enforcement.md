# USB Blocking Enforcement (Tier 1, Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Peripheral Control "Block" and "Read-only" policy actions *actually enforce* on Windows (currently they are alert-only), without a kernel driver.

**Architecture:** The agent already runs `detect → evaluate → submit events` inside `handlePeripheralPolicySync`. We insert one new step — `enforce` — between `evaluate` and event submission. Enforcement is **declarative and convergent**: every policy sync recomputes the desired OS state from the *current* full policy set and converges to it (applies blocks when an active block policy covers a class, reverts them when no such policy remains). All OS-touching work hides behind an `Enforcer` interface so the decision logic is pure Go and unit-testable on Linux CI, while the Windows implementation is integration-verified on real hardware. Enforcement uses only documented Windows config surfaces (registry + Config Manager via `pnputil`), never a driver.

**Tech Stack:** Go 1.x agent (`agent/`), `golang.org/x/sys/windows/registry`, `pnputil.exe` (Win10 2004+ / Win11 21H2+), PowerShell/WMI for detection (already present). No new third-party deps.

## Global Constraints

- Agent module path: `github.com/breeze-rmm/agent`. All paths below are under `/Users/toddhebebrand/breeze/agent/`.
- Build tags: Windows-only files use `//go:build windows`; non-Windows fallbacks use `//go:build !windows`. Pure-logic files have **no** build tag and MUST compile/test on Linux CI.
- Run all Go tests with the pinned toolchain: prefix commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` is **not** needed for Go; use the repo's Go directly. Run from `agent/`: `go test -race ./...`.
- Enforcement MUST be reversible. When the desired state contains no active block for a class, the agent MUST revert any prior enforcement for that class. A machine must never be left permanently blocked because a policy was deleted.
- Enforcement MUST honor exceptions: a device whose evaluated `Action == "allow"` (because an exception matched) MUST NOT be disabled.
- Enforcement MUST be idempotent: applying the same desired state twice is a no-op and never errors on "already applied".
- Every enforcement attempt MUST be **probe-verified** (re-read the OS state after writing) and the verified outcome reported back in the peripheral event `details`. Do not trust a successful registry write as proof of blocking (a 2025 Windows servicing regression silently broke the Removable Storage Access path on some builds).
- Scope is **Tier 1 = Windows mass-storage / removable USB block + read-only**. Bluetooth and Thunderbolt block actions remain alert-only and must be reported as such. macOS and Linux remain alert-only in this plan (stub enforcer).
- Do not edit any shipped DB migration. This plan touches no DB schema — the API/DB/UI side is already complete.

---

## Design Decisions (read before starting)

**Mechanisms, in the order the Windows enforcer applies them for a `block` on class `storage` or `all_usb`:**

1. **Per-device runtime disable** of every *currently connected* device whose evaluated `Action == "block"`, via `pnputil /remove-device "<InstanceID>"` (InstanceID == the `DeviceID` we already capture in detection). This is immediate, needs no reboot, and naturally honors exceptions (excepted devices evaluate to `allow`, so we skip them).
2. **Durable gate to stop the next device** — chosen by whether the covering block policy has any allow-exceptions:
   - **No allow-exceptions:** set `HKLM\SYSTEM\CurrentControlSet\Services\USBSTOR` → `Start = 4` (disables the mass-storage driver class machine-wide; applied on next plug/reboot). Belt-and-suspenders, reliable, unaffected by the 2025 Removable-Storage-Access regression.
   - **Has allow-exceptions:** do **not** set the machine-wide gate (it would also block the excepted device). Rely on per-device disable (step 1) plus re-running on each policy sync. Record `gate: "per-device-only"` and `gateLimitation` in the event details so the gap (a device replugged between syncs is briefly usable until the next scan) is visible. Allow-list mode (`DenyUnspecified` + `AllowDeviceIDs` across the whole device ancestor chain) is explicitly **out of scope** for Tier 1 — note it as Tier 1.5.

**For a `read_only` action on `storage`/`all_usb`:** set the Removable Storage Access write-deny key
`HKLM\SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices\{53f5630d-b6bf-11d0-94f2-00a0c91efb8b}` → `Deny_Write = 1` (the Removable Disks class GUID). Immediate, no reboot. Because of the 2025 regression, probe-verify and, if the probe shows it did not take, downgrade the reported enforcement to `alert_only` with a `probeFailed` note (do **not** silently claim success).

**Revert (no active block/read-only for a class):**
- `USBSTOR` `Start` → `3` (the Windows default, on-demand). Only revert if a prior apply set it to 4 — detect via a sentinel value written alongside (see Task 6).
- `RemovableStorageDevices\{...}` `Deny_Write` → delete the value (or set 0).
- Per-device disabled nodes re-enable naturally on replug; no explicit re-enable needed, but we expose `pnputil /enable-device` in the interface for completeness/tests.

**Why declarative:** `handlePeripheralPolicySync` fires on every policy change *and* carries the full current policy set in `payload.Policies`. So the enforcer computes desired state from that full set every time and converges — there is no separate "unblock" command to implement.

---

## File Structure

```
agent/internal/peripheral/
  enforce.go            (NEW, no build tag)  — Enforcer interface, EnforcementPlan/Action types, planEnforcement() pure logic, Enforce() orchestration, fake-friendly seams
  enforce_test.go       (NEW, no build tag)  — unit tests for planEnforcement + Enforce orchestration via fake enforcer
  enforce_windows.go    (NEW, //go:build windows) — winEnforcer: registry + pnputil execution + probe verification
  enforce_stub.go       (NEW, //go:build !windows) — stubEnforcer: reports alert_only, no-ops
  evaluate.go           (MODIFY) — ToEvents() consumes enforcement outcomes instead of hardcoding "alert_only"
  evaluate_events_test.go (MODIFY) — assert event details reflect real/declined enforcement
  detect_windows.go     (MODIFY) — populate SerialNumber from USBSTOR DeviceID so serial exceptions actually match
  detect_windows_test.go (MODIFY) — assert serial parsed

agent/internal/heartbeat/
  handlers_peripheral.go (MODIFY) — call peripheral.Enforce() between Evaluate and ToEvents

apps/docs/src/content/docs/features/peripheral-control.mdx (MODIFY) — document Windows enforcement + remaining alert-only platforms
internal/completed/BE-25-usb-peripheral-control.md (MODIFY) — note enforcement now shipped for Windows
internal/blog/track2-02.md (MODIFY) — correct the misleading "Block prevents the device from mounting" claim to scope it to Windows
```

---

### Task 1: Enforcement plan types + pure planning logic

The decision layer: given evaluation results, compute the OS-independent plan (which classes to gate, which device instance IDs to disable, whether read-only). Pure Go, fully testable on CI.

**Files:**
- Create: `agent/internal/peripheral/enforce.go`
- Test: `agent/internal/peripheral/enforce_test.go`

**Interfaces:**
- Consumes: `EvaluationResult` (from `evaluate.go`: fields `Peripheral DetectedPeripheral`, `Policy *Policy`, `Action string`, `Excepted bool`).
- Produces:
  - `type ClassGate struct { Class string; HasExceptions bool }`
  - `type EnforcementPlan struct { BlockGates []ClassGate; DisableInstanceIDs []string; ReadOnlyClasses []string }`
  - `func planEnforcement(results []EvaluationResult, policies []Policy) EnforcementPlan`

- [ ] **Step 1: Write the failing test**

```go
package peripheral

import (
	"reflect"
	"testing"
)

func TestPlanEnforcement_BlockNoExceptions(t *testing.T) {
	policies := []Policy{{ID: "p1", DeviceClass: "storage", Action: "block", IsActive: true}}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{DeviceClass: "storage", DeviceID: "USBSTOR\\DISK&VEN_X\\123"}, Policy: &policies[0], Action: "block"},
	}
	got := planEnforcement(results, policies)
	want := EnforcementPlan{
		BlockGates:         []ClassGate{{Class: "storage", HasExceptions: false}},
		DisableInstanceIDs: []string{"USBSTOR\\DISK&VEN_X\\123"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plan mismatch:\n got=%+v\nwant=%+v", got, want)
	}
}

func TestPlanEnforcement_ExceptedDeviceNotDisabled(t *testing.T) {
	policies := []Policy{{ID: "p1", DeviceClass: "storage", Action: "block", IsActive: true,
		Exceptions: []ExceptionRule{{SerialNumber: "GOOD", Allow: true}}}}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{DeviceClass: "storage", DeviceID: "USBSTOR\\A", SerialNumber: "GOOD"}, Policy: &policies[0], Action: "allow", Excepted: true},
		{Peripheral: DetectedPeripheral{DeviceClass: "storage", DeviceID: "USBSTOR\\B", SerialNumber: "BAD"}, Policy: &policies[0], Action: "block"},
	}
	got := planEnforcement(results, policies)
	if len(got.DisableInstanceIDs) != 1 || got.DisableInstanceIDs[0] != "USBSTOR\\B" {
		t.Fatalf("expected only USBSTOR\\B disabled, got %+v", got.DisableInstanceIDs)
	}
	if len(got.BlockGates) != 1 || !got.BlockGates[0].HasExceptions {
		t.Fatalf("expected gate flagged HasExceptions, got %+v", got.BlockGates)
	}
}

func TestPlanEnforcement_ReadOnly(t *testing.T) {
	policies := []Policy{{ID: "p1", DeviceClass: "storage", Action: "read_only", IsActive: true}}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{DeviceClass: "storage", DeviceID: "USBSTOR\\C"}, Policy: &policies[0], Action: "read_only"},
	}
	got := planEnforcement(results, policies)
	if len(got.ReadOnlyClasses) != 1 || got.ReadOnlyClasses[0] != "storage" {
		t.Fatalf("expected read_only storage, got %+v", got.ReadOnlyClasses)
	}
	if len(got.DisableInstanceIDs) != 0 {
		t.Fatalf("read_only must not disable devices, got %+v", got.DisableInstanceIDs)
	}
}

func TestPlanEnforcement_NonStorageBlockIgnored(t *testing.T) {
	// Bluetooth/thunderbolt block stays alert-only in Tier 1: no plan entries.
	policies := []Policy{{ID: "p1", DeviceClass: "bluetooth", Action: "block", IsActive: true}}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{DeviceClass: "bluetooth", DeviceID: "BTHENUM\\X"}, Policy: &policies[0], Action: "block"},
	}
	got := planEnforcement(results, policies)
	if len(got.BlockGates) != 0 || len(got.DisableInstanceIDs) != 0 {
		t.Fatalf("bluetooth block must produce empty plan, got %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/peripheral/ -run TestPlanEnforcement -v`
Expected: FAIL — `undefined: planEnforcement`, `undefined: EnforcementPlan`, `undefined: ClassGate`.

- [ ] **Step 3: Write minimal implementation**

```go
package peripheral

// enforceableClasses are the only device classes Tier 1 enforces on Windows.
// Bluetooth and Thunderbolt block/read_only actions remain alert-only.
var enforceableClasses = map[string]bool{"storage": true, "all_usb": true}

// ClassGate describes a class-wide block to apply. HasExceptions disables the
// machine-wide durable gate (it would over-block the excepted device).
type ClassGate struct {
	Class         string
	HasExceptions bool
}

// EnforcementPlan is the OS-independent desired state derived from the current
// policy set and the current scan. It is recomputed on every policy sync.
type EnforcementPlan struct {
	BlockGates         []ClassGate
	DisableInstanceIDs []string
	ReadOnlyClasses    []string
}

// planEnforcement computes the desired enforcement state. Pure function: no OS calls.
func planEnforcement(results []EvaluationResult, policies []Policy) EnforcementPlan {
	plan := EnforcementPlan{}

	// Gates come from the policy set (a block policy with no connected device
	// must still arm the gate). Dedup by class.
	gateSeen := map[string]bool{}
	for i := range policies {
		p := &policies[i]
		if !p.IsActive || !enforceableClasses[p.DeviceClass] {
			continue
		}
		switch p.Action {
		case "block":
			if !gateSeen[p.DeviceClass] {
				gateSeen[p.DeviceClass] = true
				plan.BlockGates = append(plan.BlockGates, ClassGate{
					Class:         p.DeviceClass,
					HasExceptions: hasAllowException(p.Exceptions),
				})
			}
		case "read_only":
			if !containsStr(plan.ReadOnlyClasses, p.DeviceClass) {
				plan.ReadOnlyClasses = append(plan.ReadOnlyClasses, p.DeviceClass)
			}
		}
	}

	// Per-device disable comes from the scan: only devices that evaluated to
	// "block" (excepted devices evaluate to "allow" and are skipped).
	for _, r := range results {
		if r.Action == "block" && enforceableClasses[r.Peripheral.DeviceClass] && r.Peripheral.DeviceID != "" {
			plan.DisableInstanceIDs = append(plan.DisableInstanceIDs, r.Peripheral.DeviceID)
		}
	}
	return plan
}

func hasAllowException(exceptions []ExceptionRule) bool {
	for i := range exceptions {
		if exceptions[i].Allow {
			return true
		}
	}
	return false
}

func containsStr(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/peripheral/ -run TestPlanEnforcement -v`
Expected: PASS (all four subtests).

- [ ] **Step 5: Commit**

```bash
cd agent && git add internal/peripheral/enforce.go internal/peripheral/enforce_test.go
git commit -m "feat(agent): pure enforcement-plan logic for peripheral blocking"
```

---

### Task 2: Enforcer interface + Enforce() orchestration (fake-tested)

Define the OS abstraction and the convergence orchestrator. The orchestrator calls the platform `Enforcer`, collects per-target outcomes, and returns them so events can report the truth. Tests drive it with a fake.

**Files:**
- Modify: `agent/internal/peripheral/enforce.go`
- Modify: `agent/internal/peripheral/enforce_test.go`

**Interfaces:**
- Consumes: `EnforcementPlan`, `EvaluationResult` (Task 1).
- Produces:
  - `type EnforceOutcome struct { Mechanism string; Applied bool; Verified bool; Detail string }`
  - `type DeviceOutcome struct { InstanceID string; EnforceOutcome }`
  - `type EnforcementOutcome struct { GateOutcomes map[string]EnforceOutcome; DeviceOutcomes []DeviceOutcome; ReadOnlyOutcomes map[string]EnforceOutcome }`
  - `type Enforcer interface { ApplyGate(class string, hasExceptions bool) EnforceOutcome; RevertGate(class string) EnforceOutcome; DisableDevice(instanceID string) EnforceOutcome; ApplyReadOnly(class string) EnforceOutcome; RevertReadOnly(class string) EnforceOutcome }`
  - `func NewEnforcer() Enforcer` (platform-selected; defined in `enforce_windows.go` / `enforce_stub.go`)
  - `func Enforce(e Enforcer, plan EnforcementPlan, allClasses []string) EnforcementOutcome` — converges: applies gates/read-only in the plan and reverts classes in `allClasses` not in the plan.

- [ ] **Step 1: Write the failing test**

```go
type fakeEnforcer struct {
	gatesApplied  []string
	gatesReverted []string
	roApplied     []string
	roReverted    []string
	disabled      []string
}

func (f *fakeEnforcer) ApplyGate(class string, hasExceptions bool) EnforceOutcome {
	f.gatesApplied = append(f.gatesApplied, class)
	return EnforceOutcome{Mechanism: "fake-gate", Applied: true, Verified: true}
}
func (f *fakeEnforcer) RevertGate(class string) EnforceOutcome {
	f.gatesReverted = append(f.gatesReverted, class)
	return EnforceOutcome{Mechanism: "fake-gate", Applied: false, Verified: true}
}
func (f *fakeEnforcer) DisableDevice(id string) EnforceOutcome {
	f.disabled = append(f.disabled, id)
	return EnforceOutcome{Mechanism: "fake-disable", Applied: true, Verified: true}
}
func (f *fakeEnforcer) ApplyReadOnly(class string) EnforceOutcome {
	f.roApplied = append(f.roApplied, class)
	return EnforceOutcome{Mechanism: "fake-ro", Applied: true, Verified: true}
}
func (f *fakeEnforcer) RevertReadOnly(class string) EnforceOutcome {
	f.roReverted = append(f.roReverted, class)
	return EnforceOutcome{Mechanism: "fake-ro", Applied: false, Verified: true}
}

func TestEnforce_AppliesAndReverts(t *testing.T) {
	f := &fakeEnforcer{}
	plan := EnforcementPlan{
		BlockGates:         []ClassGate{{Class: "storage", HasExceptions: false}},
		DisableInstanceIDs: []string{"USBSTOR\\B"},
		ReadOnlyClasses:    nil,
	}
	// all enforceable classes; "all_usb" had a block last sync but isn't in this plan -> revert.
	out := Enforce(f, plan, []string{"storage", "all_usb"})

	if len(f.gatesApplied) != 1 || f.gatesApplied[0] != "storage" {
		t.Fatalf("expected storage gate applied, got %+v", f.gatesApplied)
	}
	if len(f.gatesReverted) != 1 || f.gatesReverted[0] != "all_usb" {
		t.Fatalf("expected all_usb gate reverted, got %+v", f.gatesReverted)
	}
	if len(f.disabled) != 1 || f.disabled[0] != "USBSTOR\\B" {
		t.Fatalf("expected device disabled, got %+v", f.disabled)
	}
	// read-only not in plan for either class -> both reverted
	if len(f.roReverted) != 2 {
		t.Fatalf("expected 2 read-only reverts, got %+v", f.roReverted)
	}
	if out.GateOutcomes["storage"].Mechanism != "fake-gate" {
		t.Fatalf("outcome not recorded: %+v", out.GateOutcomes)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/peripheral/ -run TestEnforce_ -v`
Expected: FAIL — `undefined: Enforce`, `undefined: EnforceOutcome`, `undefined: EnforcementOutcome`.

- [ ] **Step 3: Write minimal implementation**

Append to `enforce.go`:

```go
// EnforceOutcome records what one mechanism did and whether a post-write probe
// confirmed it. Applied=true means we set the block; Verified=false means the
// probe could NOT confirm it (caller should report alert_only, not success).
type EnforceOutcome struct {
	Mechanism string
	Applied   bool
	Verified  bool
	Detail    string
}

type DeviceOutcome struct {
	InstanceID string
	EnforceOutcome
}

type EnforcementOutcome struct {
	GateOutcomes     map[string]EnforceOutcome
	DeviceOutcomes   []DeviceOutcome
	ReadOnlyOutcomes map[string]EnforceOutcome
}

// Enforcer abstracts all OS-touching enforcement so the orchestrator is testable.
type Enforcer interface {
	ApplyGate(class string, hasExceptions bool) EnforceOutcome
	RevertGate(class string) EnforceOutcome
	DisableDevice(instanceID string) EnforceOutcome
	ApplyReadOnly(class string) EnforceOutcome
	RevertReadOnly(class string) EnforceOutcome
}

// Enforce converges the OS to `plan`. For every class in allClasses not covered
// by the plan, it reverts any prior gate/read-only so deleting a policy unblocks.
func Enforce(e Enforcer, plan EnforcementPlan, allClasses []string) EnforcementOutcome {
	out := EnforcementOutcome{
		GateOutcomes:     map[string]EnforceOutcome{},
		ReadOnlyOutcomes: map[string]EnforceOutcome{},
	}

	wantGate := map[string]ClassGate{}
	for _, g := range plan.BlockGates {
		wantGate[g.Class] = g
	}
	wantRO := map[string]bool{}
	for _, c := range plan.ReadOnlyClasses {
		wantRO[c] = true
	}

	for _, class := range allClasses {
		if g, ok := wantGate[class]; ok {
			out.GateOutcomes[class] = e.ApplyGate(class, g.HasExceptions)
		} else {
			out.GateOutcomes[class] = e.RevertGate(class)
		}
		if wantRO[class] {
			out.ReadOnlyOutcomes[class] = e.ApplyReadOnly(class)
		} else {
			out.ReadOnlyOutcomes[class] = e.RevertReadOnly(class)
		}
	}

	for _, id := range plan.DisableInstanceIDs {
		out.DeviceOutcomes = append(out.DeviceOutcomes, DeviceOutcome{
			InstanceID:     id,
			EnforceOutcome: e.DisableDevice(id),
		})
	}
	return out
}

// EnforceableClasses returns the classes Tier 1 manages, for the convergence
// revert sweep. Stable order for deterministic tests.
func EnforceableClasses() []string { return []string{"all_usb", "storage"} }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/peripheral/ -run TestEnforce_ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd agent && git add internal/peripheral/enforce.go internal/peripheral/enforce_test.go
git commit -m "feat(agent): convergent Enforce orchestrator with Enforcer seam"
```

---

### Task 3: Report real enforcement outcome in events (replace hardcoded alert_only)

`ToEvents` currently always stamps `enforcement: alert_only`. Make it take the `EnforcementOutcome` and report the verified truth per device: `blocked` (verified), `mounted_read_only` (verified), or `alert_only` (declined/unverified/unsupported class).

**Files:**
- Modify: `agent/internal/peripheral/evaluate.go:113-149` (the `ToEvents` function)
- Modify: `agent/internal/peripheral/evaluate_events_test.go`

**Interfaces:**
- Consumes: `EnforcementOutcome` (Task 2), `[]EvaluationResult`.
- Produces (changed signature): `func ToEvents(results []EvaluationResult, outcome EnforcementOutcome) []PeripheralEvent`

- [ ] **Step 1: Write the failing test**

Add to `evaluate_events_test.go`:

```go
func TestToEvents_VerifiedBlockReportsBlocked(t *testing.T) {
	pol := Policy{ID: "p1", Name: "No USB", DeviceClass: "storage", Action: "block"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage", DeviceID: "USBSTOR\\B"}, Policy: &pol, Action: "block"},
	}
	outcome := EnforcementOutcome{
		GateOutcomes: map[string]EnforceOutcome{"storage": {Mechanism: "usbstor-start", Applied: true, Verified: true}},
		DeviceOutcomes: []DeviceOutcome{
			{InstanceID: "USBSTOR\\B", EnforceOutcome: EnforceOutcome{Mechanism: "pnputil", Applied: true, Verified: true}},
		},
	}
	events := ToEvents(results, outcome)
	if events[0].EventType != "blocked" {
		t.Fatalf("expected eventType blocked, got %q", events[0].EventType)
	}
	if events[0].Details["enforcement"] != "blocked" {
		t.Fatalf("expected enforcement=blocked, got %v", events[0].Details["enforcement"])
	}
}

func TestToEvents_UnverifiedBlockFallsBackToAlertOnly(t *testing.T) {
	pol := Policy{ID: "p1", Name: "No USB", DeviceClass: "storage", Action: "block"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage", DeviceID: "USBSTOR\\B"}, Policy: &pol, Action: "block"},
	}
	outcome := EnforcementOutcome{
		DeviceOutcomes: []DeviceOutcome{
			{InstanceID: "USBSTOR\\B", EnforceOutcome: EnforceOutcome{Mechanism: "pnputil", Applied: true, Verified: false, Detail: "probe failed"}},
		},
	}
	events := ToEvents(results, outcome)
	if events[0].Details["enforcement"] != "alert_only" {
		t.Fatalf("unverified block must report alert_only, got %v", events[0].Details["enforcement"])
	}
	if events[0].Details["probeDetail"] != "probe failed" {
		t.Fatalf("expected probeDetail surfaced, got %v", events[0].Details["probeDetail"])
	}
}

func TestToEvents_BluetoothBlockStillAlertOnly(t *testing.T) {
	pol := Policy{ID: "p1", Name: "No BT", DeviceClass: "bluetooth", Action: "block"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "bluetooth", DeviceClass: "bluetooth", DeviceID: "BTHENUM\\X"}, Policy: &pol, Action: "block"},
	}
	events := ToEvents(results, EnforcementOutcome{})
	if events[0].Details["enforcement"] != "alert_only" {
		t.Fatalf("bluetooth block must stay alert_only, got %v", events[0].Details["enforcement"])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/peripheral/ -run TestToEvents_ -v`
Expected: FAIL — `too many arguments in call to ToEvents` (existing callers/tests pass one arg) and new assertions fail.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `ToEvents` in `evaluate.go` (lines 113-149) with:

```go
// ToEvents converts evaluation results into PeripheralEvents, stamping each with
// the *verified* enforcement outcome. A block/read_only that could not be
// verified (or that targets a non-enforced class/platform) reports alert_only.
func ToEvents(results []EvaluationResult, outcome EnforcementOutcome) []PeripheralEvent {
	deviceOut := map[string]EnforceOutcome{}
	for _, d := range outcome.DeviceOutcomes {
		deviceOut[d.InstanceID] = d.EnforceOutcome
	}

	events := make([]PeripheralEvent, 0, len(results))
	now := time.Now()
	for i, r := range results {
		eventType := "connected"
		details := map[string]any{}

		if r.Policy != nil {
			details["policyName"] = r.Policy.Name
			details["policyAction"] = r.Policy.Action
			details["excepted"] = r.Excepted

			switch r.Action {
			case "block":
				et, enf, dev := classifyBlockOutcome(r, deviceOut, outcome.GateOutcomes)
				eventType = et
				details["enforcement"] = enf
				applyOutcomeDetails(details, dev)
			case "read_only":
				ro := outcome.ReadOnlyOutcomes[r.Peripheral.DeviceClass]
				if ro.Applied && ro.Verified {
					eventType = "mounted_read_only"
					details["enforcement"] = "read_only"
				} else {
					details["enforcement"] = "alert_only"
				}
				applyOutcomeDetails(details, ro)
			}
		}

		events = append(events, PeripheralEvent{
			EventID:        fmt.Sprintf("scan-%d-%d", now.Unix(), i),
			PolicyID:       policyID(r.Policy),
			EventType:      eventType,
			PeripheralType: r.Peripheral.PeripheralType,
			Vendor:         r.Peripheral.Vendor,
			Product:        r.Peripheral.Product,
			SerialNumber:   r.Peripheral.SerialNumber,
			Details:        details,
			OccurredAt:     now,
		})
	}
	return events
}

// classifyBlockOutcome decides the event type/enforcement string for a block.
// A device counts as truly blocked if EITHER its per-device disable verified OR
// the class gate verified. Otherwise alert_only.
func classifyBlockOutcome(r EvaluationResult, deviceOut, gateOut map[string]EnforceOutcome) (eventType, enforcement string, used EnforceOutcome) {
	dev := deviceOut[r.Peripheral.DeviceID]
	gate := gateOut[r.Peripheral.DeviceClass]
	if dev.Applied && dev.Verified {
		return "blocked", "blocked", dev
	}
	if gate.Applied && gate.Verified {
		return "blocked", "blocked", gate
	}
	// Pick whichever outcome carries a detail to surface; default to device.
	if dev.Mechanism != "" {
		return "connected", "alert_only", dev
	}
	return "connected", "alert_only", gate
}

func applyOutcomeDetails(details map[string]any, o EnforceOutcome) {
	if o.Mechanism != "" {
		details["mechanism"] = o.Mechanism
	}
	if o.Detail != "" {
		details["probeDetail"] = o.Detail
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/peripheral/ -run TestToEvents_ -v`
Expected: PASS. (The existing `evaluate_events_test.go` cases that call `ToEvents(results)` with one arg will now fail to compile — fix them in Step 5 before committing.)

- [ ] **Step 5: Fix existing callers/tests, re-run package, commit**

Update any pre-existing `ToEvents(results)` calls in `evaluate_events_test.go` and `evaluate_integration_test.go` to `ToEvents(results, EnforcementOutcome{})`. Then:

Run: `cd agent && go test -race ./internal/peripheral/ -v`
Expected: PASS (whole package).

```bash
cd agent && git add internal/peripheral/evaluate.go internal/peripheral/evaluate_events_test.go internal/peripheral/evaluate_integration_test.go
git commit -m "feat(agent): events report verified enforcement outcome, not hardcoded alert_only"
```

---

### Task 4: Non-Windows stub enforcer

Keep macOS/Linux compiling and explicitly alert-only. This also lets CI (Linux) link `NewEnforcer()`.

**Files:**
- Create: `agent/internal/peripheral/enforce_stub.go`
- Test: covered by Task 2 fake; add one compile/behavior test guarded to non-windows.

**Interfaces:**
- Produces: `func NewEnforcer() Enforcer` (returns a stub whose every method reports `Applied:false, Verified:false`).

- [ ] **Step 1: Write the implementation**

```go
//go:build !windows

package peripheral

// stubEnforcer is the non-Windows enforcer: detection/eval still run, but no OS
// enforcement is applied. Every action reports alert_only via Applied=false.
type stubEnforcer struct{}

func NewEnforcer() Enforcer { return stubEnforcer{} }

func (stubEnforcer) ApplyGate(string, bool) EnforceOutcome {
	return EnforceOutcome{Mechanism: "unsupported", Applied: false, Verified: false, Detail: "enforcement not implemented on this OS"}
}
func (stubEnforcer) RevertGate(string) EnforceOutcome  { return EnforceOutcome{Mechanism: "unsupported"} }
func (stubEnforcer) DisableDevice(string) EnforceOutcome {
	return EnforceOutcome{Mechanism: "unsupported", Applied: false, Verified: false, Detail: "enforcement not implemented on this OS"}
}
func (stubEnforcer) ApplyReadOnly(string) EnforceOutcome {
	return EnforceOutcome{Mechanism: "unsupported", Applied: false, Verified: false, Detail: "enforcement not implemented on this OS"}
}
func (stubEnforcer) RevertReadOnly(string) EnforceOutcome { return EnforceOutcome{Mechanism: "unsupported"} }
```

- [ ] **Step 2: Write the failing test**

Create `agent/internal/peripheral/enforce_stub_test.go`:

```go
//go:build !windows

package peripheral

import "testing"

func TestStubEnforcer_AlertOnly(t *testing.T) {
	e := NewEnforcer()
	if out := e.DisableDevice("USBSTOR\\X"); out.Applied || out.Verified {
		t.Fatalf("stub must not claim enforcement, got %+v", out)
	}
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd agent && go test ./internal/peripheral/ -run TestStubEnforcer -v`
Expected: PASS (on the Linux/macOS dev machine).

- [ ] **Step 4: Commit**

```bash
cd agent && git add internal/peripheral/enforce_stub.go internal/peripheral/enforce_stub_test.go
git commit -m "feat(agent): non-Windows stub enforcer (alert-only)"
```

---

### Task 5: Wire Enforce into the policy-sync handler

Insert enforcement between evaluate and event submission, and report a summary in the command result.

**Files:**
- Modify: `agent/internal/heartbeat/handlers_peripheral.go:56-58`

**Interfaces:**
- Consumes: `peripheral.NewEnforcer`, `peripheral.planEnforcement` (unexported — see note), `peripheral.Enforce`, `peripheral.EnforceableClasses`, `peripheral.ToEvents`.

> NOTE: `planEnforcement` is unexported. Export a thin wrapper `func Plan(results []EvaluationResult, policies []Policy) EnforcementPlan { return planEnforcement(results, policies) }` in `enforce.go` so the heartbeat package can call it. Add this one-liner as part of this task and keep `planEnforcement` unexported for the focused unit tests.

- [ ] **Step 1: Add the exported wrapper**

In `agent/internal/peripheral/enforce.go`, add:

```go
// Plan exposes planEnforcement to other packages (the heartbeat handler).
func Plan(results []EvaluationResult, policies []Policy) EnforcementPlan {
	return planEnforcement(results, policies)
}
```

- [ ] **Step 2: Modify the handler**

In `handlers_peripheral.go`, replace lines 56-58:

```go
	// Evaluate detected devices against policies.
	results := peripheral.Evaluate(detected, payload.Policies)
	events := peripheral.ToEvents(results)
```

with:

```go
	// Evaluate detected devices against policies.
	results := peripheral.Evaluate(detected, payload.Policies)

	// Converge OS enforcement to the desired state (Windows: real block /
	// read-only; other platforms: alert-only stub). Reversible: classes no
	// longer covered by a block policy are reverted here.
	plan := peripheral.Plan(results, payload.Policies)
	outcome := peripheral.Enforce(peripheral.NewEnforcer(), plan, peripheral.EnforceableClasses())
	cmdLog.Info("peripheral enforcement applied",
		"gates", len(plan.BlockGates),
		"devicesDisabled", len(plan.DisableInstanceIDs),
		"readOnlyClasses", len(plan.ReadOnlyClasses),
	)

	events := peripheral.ToEvents(results, outcome)
```

- [ ] **Step 3: Build & test the agent**

Run: `cd agent && go build ./... && go test -race ./internal/heartbeat/ ./internal/peripheral/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd agent && git add internal/peripheral/enforce.go internal/heartbeat/handlers_peripheral.go
git commit -m "feat(agent): apply convergent peripheral enforcement in policy-sync handler"
```

---

### Task 6: Windows enforcer — registry gate, read-only, per-device disable, probe-verify

The real OS implementation. This is `//go:build windows` and cannot run on Linux CI; it is **integration-verified manually on a Windows VM** (Step 5). Keep the registry/exec calls thin and the value-mapping logic small.

**Files:**
- Create: `agent/internal/peripheral/enforce_windows.go`

**Interfaces:**
- Produces: `func NewEnforcer() Enforcer` (Windows build), `winEnforcer` implementing all five methods.

Key constants and behavior:
- USBSTOR gate key: `SYSTEM\CurrentControlSet\Services\USBSTOR`, value `Start` (DWORD). Block = `4`, default = `3`. Write a sentinel value `BreezeManaged` (DWORD `1`) alongside so RevertGate only restores `3` if *we* set it (never clobber a value an admin set for other reasons).
- Read-only key: `SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices\{53f5630d-b6bf-11d0-94f2-00a0c91efb8b}`, value `Deny_Write` (DWORD `1`); revert = delete the value.
- Per-device disable: `exec.Command("pnputil", "/remove-device", instanceID)`. (On Win11 21H2+, `/remove-device` forces a clean re-enumeration; if unavailable, fall back to `/disable-device`.) Treat non-zero exit as `Applied:false`.
- Gate-with-exceptions: when `hasExceptions` is true, do **not** write USBSTOR Start=4; return `EnforceOutcome{Mechanism:"per-device-only", Applied:true, Verified:true, Detail:"machine-wide gate skipped: policy has allow-exceptions"}` so events record the limitation.
- **Probe-verify** after every write: re-open the key and read the value back; only set `Verified:true` if the read matches the intended value. For per-device disable, probe by re-querying the device's `ConfigManagerErrorCode`/problem status (or simply re-run a `pnputil /enum-devices /instanceid <id>` and check it reports the device disabled); if the probe can't confirm, `Verified:false`.

- [ ] **Step 1: Write the implementation**

```go
//go:build windows

package peripheral

import (
	"fmt"
	"os/exec"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const (
	usbstorKeyPath = `SYSTEM\CurrentControlSet\Services\USBSTOR`
	usbstorValue   = "Start"
	usbstorBlock   = 4
	usbstorDefault = 3
	breezeManaged  = "BreezeManaged"

	removableStorageKey = `SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices\{53f5630d-b6bf-11d0-94f2-00a0c91efb8b}`
	denyWriteValue      = "Deny_Write"
)

type winEnforcer struct{}

func NewEnforcer() Enforcer { return winEnforcer{} }

func (winEnforcer) ApplyGate(class string, hasExceptions bool) EnforceOutcome {
	if hasExceptions {
		return EnforceOutcome{Mechanism: "per-device-only", Applied: true, Verified: true,
			Detail: "machine-wide gate skipped: policy has allow-exceptions"}
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, usbstorKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return EnforceOutcome{Mechanism: "usbstor-start", Detail: "open key: " + err.Error()}
	}
	defer k.Close()
	if err := k.SetDWordValue(usbstorValue, usbstorBlock); err != nil {
		return EnforceOutcome{Mechanism: "usbstor-start", Detail: "set Start: " + err.Error()}
	}
	_ = k.SetDWordValue(breezeManaged, 1)
	// Probe-verify.
	got, _, err := k.GetIntegerValue(usbstorValue)
	verified := err == nil && got == usbstorBlock
	return EnforceOutcome{Mechanism: "usbstor-start", Applied: true, Verified: verified,
		Detail: probeDetail(verified, "USBSTOR Start read-back mismatch")}
}

func (winEnforcer) RevertGate(class string) EnforceOutcome {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, usbstorKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return EnforceOutcome{Mechanism: "usbstor-start", Detail: "open key: " + err.Error()}
	}
	defer k.Close()
	// Only revert if WE set it (sentinel present), to avoid clobbering admin config.
	if managed, _, mErr := k.GetIntegerValue(breezeManaged); mErr != nil || managed != 1 {
		return EnforceOutcome{Mechanism: "usbstor-start", Applied: false, Verified: true,
			Detail: "not Breeze-managed; left untouched"}
	}
	if err := k.SetDWordValue(usbstorValue, usbstorDefault); err != nil {
		return EnforceOutcome{Mechanism: "usbstor-start", Detail: "restore Start: " + err.Error()}
	}
	_ = k.DeleteValue(breezeManaged)
	return EnforceOutcome{Mechanism: "usbstor-start", Applied: false, Verified: true}
}

func (winEnforcer) DisableDevice(instanceID string) EnforceOutcome {
	cmd := exec.Command("pnputil", "/remove-device", instanceID)
	if out, err := cmd.CombinedOutput(); err != nil {
		return EnforceOutcome{Mechanism: "pnputil", Applied: false, Verified: false,
			Detail: fmt.Sprintf("pnputil: %v: %s", err, strings.TrimSpace(string(out)))}
	}
	// Probe: device should no longer enumerate as present (removed) or report disabled.
	probe := exec.Command("pnputil", "/enum-devices", "/instanceid", instanceID)
	pout, _ := probe.CombinedOutput()
	verified := !strings.Contains(strings.ToLower(string(pout)), "status:              started")
	return EnforceOutcome{Mechanism: "pnputil", Applied: true, Verified: verified,
		Detail: probeDetail(verified, "device still reports started after remove")}
}

func (winEnforcer) ApplyReadOnly(class string) EnforceOutcome {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, removableStorageKey, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return EnforceOutcome{Mechanism: "removable-storage-deny-write", Detail: "create key: " + err.Error()}
	}
	defer k.Close()
	if err := k.SetDWordValue(denyWriteValue, 1); err != nil {
		return EnforceOutcome{Mechanism: "removable-storage-deny-write", Detail: "set Deny_Write: " + err.Error()}
	}
	got, _, err := k.GetIntegerValue(denyWriteValue)
	verified := err == nil && got == 1
	return EnforceOutcome{Mechanism: "removable-storage-deny-write", Applied: true, Verified: verified,
		Detail: probeDetail(verified, "Deny_Write read-back mismatch (possible 2025 servicing regression)")}
}

func (winEnforcer) RevertReadOnly(class string) EnforceOutcome {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, removableStorageKey, registry.SET_VALUE)
	if err != nil {
		// Key absent == nothing to revert.
		return EnforceOutcome{Mechanism: "removable-storage-deny-write", Applied: false, Verified: true}
	}
	defer k.Close()
	_ = k.DeleteValue(denyWriteValue)
	return EnforceOutcome{Mechanism: "removable-storage-deny-write", Applied: false, Verified: true}
}

func probeDetail(verified bool, failMsg string) string {
	if verified {
		return ""
	}
	return failMsg
}
```

- [ ] **Step 2: Cross-compile to verify it builds for Windows**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./...`
Expected: builds with no errors.

- [ ] **Step 3: Run the Linux test suite (ensures stub path still selected on dev box)**

Run: `cd agent && go test -race ./internal/peripheral/`
Expected: PASS (Windows file excluded by build tag on Linux).

- [ ] **Step 4: Commit**

```bash
cd agent && git add internal/peripheral/enforce_windows.go
git commit -m "feat(agent): Windows peripheral enforcer (USBSTOR gate, Deny_Write read-only, pnputil disable, probe-verify)"
```

- [ ] **Step 5: Manual integration verification on a Windows VM (REQUIRED before merge)**

Build the agent for Windows, install it on a Windows 11 VM as SYSTEM, then from the Breeze web UI:
1. Create a `storage` / `block` policy targeting the test device. Plug in a USB stick.
   - Expected: stick is removed/disabled (Device Manager shows it gone or with a problem code); the activity log event shows `eventType: blocked`, `details.enforcement: blocked`, `details.mechanism: pnputil` and/or `usbstor-start`. Verify a *newly* plugged stick is blocked after the next sync/reboot (USBSTOR gate).
2. Add an allow-exception by serial for a second stick; re-sync.
   - Expected: excepted stick mounts and is usable; event shows `excepted: true`; the blocked stick's event shows `mechanism: per-device-only` and the `gateLimitation` detail.
3. Create a `storage` / `read_only` policy; re-sync; plug a stick.
   - Expected: stick mounts read-only (writes fail); event `mounted_read_only`. (If the box is on a 2025-regressed build, event shows `alert_only` + `probeDetail` — this is correct, honest behavior.)
4. Disable/delete the block policy; re-sync.
   - Expected: USBSTOR `Start` restored to `3`, `Deny_Write` removed, sticks work again. Confirm the box is NOT permanently blocked.

Record the results in the PR description. Do not merge until steps 1 and 4 (block + clean revert) pass.

---

### Task 7: Populate SerialNumber in Windows detection (so serial exceptions match)

Serial-based exceptions silently never match today because `detect_windows.go` never sets `SerialNumber`. USB/USBSTOR instance IDs carry the serial as the last `\`-delimited segment. Parse it so exceptions and per-device targeting work.

**Files:**
- Modify: `agent/internal/peripheral/detect_windows.go:48-63`
- Modify: `agent/internal/peripheral/detect_windows_test.go`

**Interfaces:**
- Produces: `func parseSerial(deviceID string) string` (exported as unexported helper; tested directly — note these tests run only under `//go:build windows`, so verify via `GOOS=windows go vet` and the Windows VM, or move `parseSerial` into a no-tag file to test on CI — see Step 1).

> Decision: put `parseSerial` in the existing **no-build-tag** `evaluate.go`-adjacent space is wrong (it's detection logic). Instead create it in a new no-tag file `agent/internal/peripheral/serial.go` so it is unit-testable on Linux CI, and call it from `detect_windows.go`.

- [ ] **Step 1: Write the failing test**

Create `agent/internal/peripheral/serial_test.go` (no build tag):

```go
package peripheral

import "testing"

func TestParseSerial(t *testing.T) {
	cases := map[string]string{
		`USBSTOR\DISK&VEN_SANDISK&PROD_ULTRA&REV_1.00\4C530001234567890123&0`: "4C530001234567890123&0",
		`USB\VID_0781&PID_5583\0101a1b2c3`:                                     "0101a1b2c3",
		`USBSTOR\DISK`:                                                         "", // no serial segment
		``:                                                                     "",
	}
	for in, want := range cases {
		if got := parseSerial(in); got != want {
			t.Errorf("parseSerial(%q)=%q want %q", in, got, want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/peripheral/ -run TestParseSerial -v`
Expected: FAIL — `undefined: parseSerial`.

- [ ] **Step 3: Write minimal implementation**

Create `agent/internal/peripheral/serial.go`:

```go
package peripheral

import "strings"

// parseSerial extracts the serial/instance segment (the last backslash-delimited
// field) from a Windows USB/USBSTOR device instance ID. Returns "" if the ID has
// fewer than three segments (no per-instance field).
func parseSerial(deviceID string) string {
	parts := strings.Split(deviceID, `\`)
	if len(parts) < 3 {
		return ""
	}
	return parts[len(parts)-1]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/peripheral/ -run TestParseSerial -v`
Expected: PASS.

- [ ] **Step 5: Wire into detection**

In `detect_windows.go`, inside the `for _, e := range entities` loop, set the serial:

```go
		result = append(result, DetectedPeripheral{
			PeripheralType: pType,
			Vendor:         e.Manufacturer,
			Product:        e.Name,
			SerialNumber:   parseSerial(e.DeviceID),
			DeviceClass:    dClass,
			DeviceID:       e.DeviceID,
		})
```

- [ ] **Step 6: Verify Windows build + commit**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./... && go test ./internal/peripheral/`
Expected: builds; tests pass.

```bash
cd agent && git add internal/peripheral/serial.go internal/peripheral/serial_test.go internal/peripheral/detect_windows.go
git commit -m "feat(agent): parse USB serial from instance ID so serial exceptions match"
```

---

### Task 8: Documentation + correct misleading claims

Update the docs to state Windows now enforces, and fix the spec/blog claims the research flagged as misleading.

**Files:**
- Modify: `apps/docs/src/content/docs/features/peripheral-control.mdx` (the alert-only disclosure near lines 276-278 and 329)
- Modify: `internal/completed/BE-25-usb-peripheral-control.md`
- Modify: `internal/blog/track2-02.md:55`

- [ ] **Step 1: Update the feature doc**

Replace the alert-only disclosure paragraph (around line 276) with an accurate, platform-scoped statement:

```mdx
**Enforcement by platform:**

- **Windows:** `Block` and `Read-only` are enforced. Block disables matching
  connected devices (via Config Manager) and arms a machine-wide gate so new
  removable-storage devices are refused on the next insertion. Read-only sets the
  Removable Storage write-deny policy. Exceptions are honored per device; when a
  block policy has allow-exceptions, the machine-wide gate is skipped in favor of
  per-device enforcement (see Limitations). Every action is probe-verified — if
  the OS does not confirm the block, the event is reported as `alert-only` rather
  than falsely claiming success.
- **macOS / Linux:** `Block` and `Read-only` currently operate in **alert-only**
  mode. The agent logs and reports the policy decision but does not yet prevent
  device access. Robust macOS enforcement requires MDM; Linux enforcement
  (USBGuard) is planned.

**Limitations:** Bluetooth and Thunderbolt block actions are alert-only on all
platforms. On Windows, a block policy that contains allow-exceptions relies on
per-device enforcement re-applied at each policy sync, so a device unplugged and
replugged between syncs may be briefly usable until the next scan.
```

Also update the troubleshooting note near line 329 to say enforcement is active on Windows and alert-only on macOS/Linux.

- [ ] **Step 2: Update the BE-25 spec**

Add a status note at the top of `internal/completed/BE-25-usb-peripheral-control.md` stating that enforcement (block/read-only) shipped for Windows via registry + Config Manager (no kernel driver), per plan `docs/superpowers/plans/security-auth/2026-06-24-usb-blocking-enforcement.md`, and that macOS/Linux remain alert-only.

- [ ] **Step 3: Correct the blog claim**

In `internal/blog/track2-02.md` line 55, change the unqualified "Block prevents the device from mounting at all / Read-only mounts removable storage as a read-only volume" to scope it: enforcement is active on Windows; macOS/Linux are monitor/alert-only today.

- [ ] **Step 4: Verify docs build**

Run: `cd apps/docs && npm run build` (or the repo's docs build command).
Expected: docs build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/content/docs/features/peripheral-control.mdx internal/completed/BE-25-usb-peripheral-control.md internal/blog/track2-02.md
git commit -m "docs(peripheral): document Windows enforcement; correct alert-only claims"
```

---

## Self-Review Notes (gaps deliberately deferred — NOT in scope)

- **Bluetooth / Thunderbolt block enforcement** — stays alert-only (reported honestly). Future work.
- **macOS MDM-based enforcement and Linux USBGuard** — separate plans; stub enforcer reports alert-only.
- **Allow-list mode** (`DenyUnspecified` + `AllowDeviceIDs` ancestor chain) for exception-bearing block policies — Tier 1.5; current plan uses per-device enforcement with a documented gap.
- **Kernel-driver Tier 2** (true mid-transfer read/write veto, copy auditing, in-kernel VID/PID/serial allow-lists) — explicitly out of scope; months of effort + EV/WHQL signing. Gate behind real customer demand.
- **Real-time (event-driven) enforcement** — current model enforces on each policy sync / scan. Continuous WMI/PnP event subscription for instant block-on-insert is a future enhancement; the USBSTOR gate already covers new inserts machine-wide for the no-exception case.

## Verification Summary (whole-plan)

Run from `agent/`:
- `go test -race ./internal/peripheral/ ./internal/heartbeat/` — all green on Linux/macOS dev box.
- `GOOS=windows GOARCH=amd64 go build ./...` — Windows build compiles.
- Manual Windows VM verification (Task 6 Step 5) — block applies AND cleanly reverts; read-only applies; exceptions honored; probe-verify downgrades unconfirmed blocks to alert-only.

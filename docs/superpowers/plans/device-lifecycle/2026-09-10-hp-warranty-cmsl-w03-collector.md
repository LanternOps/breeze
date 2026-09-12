---
tracking_issue: LanternOps/breeze#5511
---

# Wave 03 — Agent collector: HP warranty via HP CMSL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows agent read HP warranty data out of HP's own WMI namespace, refresh it through `Get-HPWarrantyInfo` only when HP's own 30-day cache has genuinely lapsed, and report it to `PUT /agents/:id/warranty-info` as `source: 'agent_cmsl'` on a persisted, jittered, rate-limit-aware schedule.

**Architecture:** Three files in `agent/internal/collectors` — a **build-tag-free** `hp_warranty.go` holds every shared type (`HpWarrantyInfo`, `HpEntitlement`, `HpCollectError`, the tier and reason constants) and every line of logic worth testing (the PowerShell execution seam, the two scripts, the WMI JSON parser, the tier decision T0/T1/T2, rate-limit classification, entitlement bounding), while `hp_warranty_windows.go` (`//go:build windows`) and `hp_warranty_other.go` (`//go:build !windows`) hold **nothing but the platform entry point** — the real `CollectHpWarranty()` and the `(nil, nil)` stub respectively, both referencing the one shared struct. That split is the whole reason the suite runs on a macOS/Linux CI runner — it copies the existing `hardware_windows.go` (tagged, spawns PowerShell) + `hardware_wmi_parse.go` (tag-free, unit-tested by the tag-free `hardware_test.go`) precedent. Scheduling lives in `agent/internal/heartbeat/hp_warranty.go`: a persisted due-time file under `config.GetDataDir()` (the `reliability_state.go` pattern), a deterministic FNV-1a jitter offset keyed on the agent id, bounded transient retries and a much longer back-off after an HP 429 — plus the report call, which reuses `h.sendInventoryData("warranty-info", payload, …)` unchanged.

**Tech Stack:** Go 1.26.6 (`agent/go.mod:3`), stdlib only (`encoding/json`, `hash/fnv`, `regexp`, `time`), `go test -race`. No new module dependency — in particular **no** Go WMI binding (see Global Constraints).

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md` — layer 5 (collection) and layer 6 (reporting), **as amended by that document's "Corrections after ground-truth verification (2026-09-10)" section, which supersedes the body.**

**Cross-wave contract:** `contract-B-hp-cmsl.md` (coordinator, locked). Decisions D6, D7, D8, D9, D10 bind this wave. Where the contract and the spec body disagree, the contract wins.

**Wave:** W03, sub-issue `LanternOps/breeze#5514`. Feature `#5511`.

---

## ⛔ HARD GATE — do not start this wave until W01's lab probe has reported

**W01 (#5512) must have answered all three of its hardware questions, recorded on issue #5512, before Task 2 of this plan can be implemented.** This is not a formality: two of the three answers are *inputs to code in this plan*, not context.

| # | Question W01 must answer | What in THIS plan depends on it |
|---|---|---|
| 1 | Does `root/HP/InstrumentedServices/v1` exist **without** CMSL installed? | Task 3's tier decision. If the namespace is factory-populated, T0 succeeds on stock HP hardware and T2 becomes rare; if it only appears with CMSL, T2 is the common first state and the "report nothing, let the policy install it" branch carries the fleet for its first policy cycle. Either answer works — the code is the same — but the plan's log levels and the PR description must state which world we are in. |
| 2 | What does `Get-HPWarrantyInfo` **actually return, field by field**, including its own cache timestamp? | **Task 2's parser is written against that captured output, not against documentation.** Task 2 Step 1 pastes the probe's captured JSON verbatim into `agent/internal/collectors/testdata/hp_warranty_wmi_real.json` and the field-name candidate lists in `hp_warranty.go` are corrected to match. Implementing Task 2 without the fixture means shipping a parser validated only against a guess. |
| 3 | Does an old→new CMSL upgrade surface through the SYSTEM winget scan and a Breeze ring? | Nothing in this wave. This gates **W04**, not W03. Recorded here only so an implementer does not mistake a "no" on Q3 for a blocker on W03. |

**If Q2 has not been answered, stop and report.** Tasks 1 and 6–10 (stubs, scheduling, jitter, back-off, reporting, wiring) are genuinely independent of the probe and may be implemented first; Tasks 2–5 (parser, tiers, classification, bounding) may not.

---

## Global Constraints

Copied verbatim from the locked contract and the spec's corrections section. Every task's requirements implicitly include this section.

- **The agent has NO Go WMI binding, and this wave must not introduce one.** `yusufpapurcu/wmi` is an *indirect* dependency (`agent/go.mod:112`) imported by zero agent files; `go-ole` is direct (`agent/go.mod:18`) but drives only the Windows Update Agent COM API and VSS. Promoting `wmi` to a direct dependency is **rejected** by the contract (D7). Proof is quoted in §0 below.
- **T0 reads WMI through PowerShell**, via
  `runCollectorOutput(timeout, "powershell", "-NoProfile", "-NonInteractive", "-Command", utf8PowerShellCommand(script))`
  — the `agent/internal/collectors/hardware_windows.go:82-121` pattern, including its `Get-WmiSafe`-style graceful-degradation idea and a bounded timeout (D7).
- **File layout is fixed by D7:** `agent/internal/collectors/hp_warranty_windows.go` (`//go:build windows`) and `agent/internal/collectors/hp_warranty_other.go` (`//go:build !windows`), the stub returning `(nil, nil)` like `agent/internal/collectors/warranty_other.go:21`.
- **D7 WAS AMENDED (coordinator, 2026-09-10) — shared types are declared exactly ONCE, in the tag-free `hp_warranty.go`.** D7 originally required a *struct-parity* stub, mirroring `HpWarrantyInfo` in both build-tagged files. That requirement was lifted, and a reader checking the original contract should not read this plan as a divergence. Reason: the parity contract documented at `warranty_other.go:12-15` exists only because Apple's collector has **no** tag-free file — its struct has nowhere else to live, so it must be mirrored for `heartbeat.go` to type-check on every platform. This wave already introduces a tag-free `hp_warranty.go`, which removes that constraint; mirroring the struct anyway would preserve a real drift hazard in shipped agent code to imitate a precedent whose reason does not apply. **The two build-tagged files therefore hold nothing but the platform entry point.**
- **Do NOT retag `agent/internal/collectors/warranty_other.go`.** It is Apple's `//go:build !darwin` stub and already compiles on Windows. Its parity duplication is correct *for Apple* and is not something to "fix" while passing through.
- **Wire values (D9, D10):** `source` is exactly `'agent_cmsl'`; `manufacturer` is exactly `'HP'`. Entitlement objects sent by the agent carry `serviceLevelDescription`, `entitlementType`, `startDate`, `endDate` and **never** `provider` — W01 derives `provider` from the reporting source server-side, because `provider: 'apple' as const` (`apps/api/src/services/warrantySync.ts:367`) is a verified defect W01 fixes.
- **Entitlement bounds (D10), enforced client-side too:** at most **25** entitlements per report; each string field at most **200** characters; dates as ISO-8601 strings preserved as HP reports them. Client-side enforcement is not belt-and-braces — a schema rejection is a 400 that drops the *entire* warranty update, which is exactly how #1320 lost Apple coverage records.
- **Scheduling keys off HP's own cache timestamp (D8),** not a fixed interval: HP self-caches 30 days, so a day-25 invocation returns cached data and refreshes nothing. The collector carries its **own persisted due-time and bounded retries**; it does **NOT** ride the 15-minute `sendInventory` fan-out (`agent/internal/heartbeat/heartbeat.go:2120-2139`).
- **Per-device jitter is deterministic** (hash of the agent id → offset within the refresh window) and is **explicitly statistical, not a guarantee**: a fleet returning from a shared outage re-bunches because every device's persisted due time already elapsed. Say so in the code comment; do not claim a bound the design cannot deliver.
- **Back off on an HP 429 rather than retrying into the limit.** HP's limit is 300 requests / 5 minutes **per source IP** — a per-customer-NAT limit, not per-device. One saturated site is every HP device behind one NAT.
- **Report WHY collection failed rather than failing silently.** PowerShell 5.1 and TLS 1.2 are not universal on older Windows builds; a device that cannot collect must say which of those it was.
- **Reporting reuses the Apple transport unchanged:** `h.sendInventoryData("warranty-info", payload, "<label>")` (`agent/internal/heartbeat/heartbeat.go:2154-2185`) — **the endpoint is the FIRST argument**, the label the third. Model the payload on `sendAppleWarrantyInfo` (`:2405-2435`), including its belt-and-braces `runtime.GOOS` guard.
- **Consume W02's config seam; do not re-implement config parsing.** The gate is `warranty_settings.hp_cmsl_enabled`, dispatched through `agent/internal/heartbeat/warranty_config.go` (D6/D7, owner W02).
- **Out of scope, hard:** any file under `apps/api/`, the catalog package (W04), the config/opt-in surface (W02), `apps/web/`. If a task appears to need one, stop and report.
- **Go tests run with `-race` and must pass on a NON-Windows runner.** Every test in this wave mocks the command-execution seam; **no test shells out for real**. Command:
  ```bash
  cd agent && go test -race ./internal/collectors/... ./internal/heartbeat/...
  ```
- Table-driven tests for: tier selection, due-time computation from an HP cache timestamp, jitter determinism *and* distribution, and 429 back-off (spec §Testing).

---

## 0. Ground truth

Re-verified 2026-09-10 against this worktree (`/Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing`, branch `spec/hp-warranty-and-desired-state-install`). Every file cited below was opened; the quotes are verbatim. **Contract line numbers were re-confirmed, not trusted** — deviations are called out.

### 0.1 The "no Go WMI binding" claim, proven

`agent/go.mod:18` and `agent/go.mod:112`:

```
	github.com/go-ole/go-ole v1.2.6
```
```
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
```

`grep -rn "yusufpapurcu/wmi" agent --include="*.go"` → **exit status 1, zero matches.** The package is imported by no agent file; it is pulled in transitively by gopsutil.

`grep -rn "go-ole" agent --include="*.go"` → exactly three lines, none of them WMI:

```
agent/internal/backup/vss/vss_windows.go:16:	"github.com/go-ole/go-ole"
agent/internal/patching/windows.go:11:	"github.com/go-ole/go-ole"
agent/internal/patching/windows.go:12:	"github.com/go-ole/go-ole/oleutil"
```

`agent/go.mod:3` — `go 1.26.6`. (The W03 calibration reference plan says "Go 1.25"; that is stale, not wrong at the time.)

### 0.2 The stub whose `(nil, nil)` shape this wave copies — and whose duplication it does not

Full file, 22 lines. Note the parity comment at `:12-15` and the `(nil, nil)` return at `:20-21`:

```go
//go:build !darwin

package collectors

// AppleWarrantyInfo contains warranty data extracted from local macOS plists.
// On non-darwin platforms, this is a no-op.
type AppleWarrantyInfo struct {
	CoverageEndDate   string         `json:"coverageEndDate,omitempty"`
	CoverageStartDate string         `json:"coverageStartDate,omitempty"`
	DeviceName        string         `json:"deviceName,omitempty"`
	CoverageType      string         `json:"coverageType,omitempty"`
	// CoverageKind mirrors the darwin struct so heartbeat.go (compiled on all
	// platforms) type-checks on non-darwin; always "" here since collection
	// is a darwin-only no-op (#1320/#1344 build-tag parity).
	CoverageKind      string         `json:"coverageKind,omitempty"`
	Raw               map[string]any `json:"raw,omitempty"`
}

// CollectAppleWarranty is a no-op on non-darwin platforms.
func CollectAppleWarranty() (*AppleWarrantyInfo, error) {
	return nil, nil
}
```

Confirmed: `//go:build !darwin` at `:1`, parity comment `:12-15`, `return nil, nil` at `:21`. **This file is NOT retagged and NOT edited by this wave.**

**What this wave copies from it, and what it deliberately does not.** The `(nil, nil)` entry-point stub is copied exactly. The *duplicated struct* is not, and the comment at `:12-15` says why in its own words: the mirror exists "so heartbeat.go (compiled on all platforms) type-checks on non-darwin". `AppleWarrantyInfo` has nowhere else to live — there is no tag-free file in Apple's collector, only `warranty_darwin.go` and `warranty_other.go`. This wave already has a tag-free `hp_warranty.go` (for the reasons in §0.5), so the same type-checking guarantee is available from a single declaration, without two copies to drift apart. Coordinator amended D7 accordingly on 2026-09-10; see Global Constraints.

### 0.3 The canonical PowerShell-WMI precedent — `agent/internal/collectors/hardware_windows.go`

`:14`:
```go
const wmicTimeout = 15 * time.Second
```

`:82-98` — the batched collector and its `Get-WmiSafe` fallback helper:
```go
func collectPlatformHardware(hw *HardwareInfo) {
	// One batched PowerShell invocation fetches all WMI properties at once,
	// cutting ~9 cold-start process spawns per collection cycle down to one.
	// Each WMI class tries Get-CimInstance first (preferred, modern) and falls
	// back to Get-WmiObject for older hosts where CIM is unavailable.
	script := `
$ErrorActionPreference = 'SilentlyContinue'
function Get-WmiSafe($ClassName) {
  $r = $null
  if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
    try { $r = Get-CimInstance -ClassName $ClassName -ErrorAction Stop } catch {}
  }
  if ($null -eq $r -and (Get-Command Get-WmiObject -ErrorAction SilentlyContinue)) {
    try { $r = Get-WmiObject -Class $ClassName -ErrorAction Stop } catch {}
  }
  $r
}
```

`:118-128` — the `ConvertTo-Json -Compress` tail, the invocation, and the failure log:
```go
} | ConvertTo-Json -Compress
`

	out, err := runCollectorOutput(wmicTimeout, "powershell", "-NoProfile", "-NonInteractive", "-Command", utf8PowerShellCommand(script))
	if err != nil {
		// Whole-scan failure (powershell blocked by WDAC/AppLocker, WMI repository
		// corruption, timeout, …) leaves every WMI-derived field empty this cycle,
		// so log at Warn — Debug is suppressed at the default "info" level.
		slog.Warn("hardware WMI batch query failed; WMI-derived hardware fields empty this cycle", "error", err.Error())
		return
	}
```

Contract says `hardware_windows.go:82-121`. **Confirmed exactly** — `collectPlatformHardware` opens at `:82`, `Get-WmiSafe` is `:89-98`, the `runCollectorOutput` call is `:121`.

### 0.4 The execution seam — `agent/internal/collectors/command_limits.go`

**No build tag on this file** — it compiles on every platform, which is what makes the seam mockable from a darwin test.

`:16-24`:
```go
const (
	collectorShortCommandTimeout = 10 * time.Second
	collectorLongCommandTimeout  = 30 * time.Second
	collectorCommandOutputLimit  = 4 * 1024 * 1024
	collectorScannerLimit        = 1024 * 1024
	collectorFileReadLimit       = 1024 * 1024
	collectorStringLimit         = 512
	collectorResultLimit         = 5000
)
```

`:26-39`:
```go
// utf8PowerShellCommand wraps a PowerShell command so its stdout is emitted as
// UTF-8. Without this, PowerShell renders output using the console OEM codepage
// (e.g. CP852 on Polish Windows), which Go then decodes as UTF-8 and corrupts
// non-Latin characters into U+FFFD. See issue #979.
func utf8PowerShellCommand(command string) string {
	return "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" + command
}

func runCollectorOutput(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	return runCollectorOutputWithContext(ctx, timeout, name, args...)
}
```

`:41` — `func runCollectorOutputWithContext(parent context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {`

Contract says `command_limits.go:30,34,41`. **Confirmed exactly**: `utf8PowerShellCommand` body at `:31` with the signature at `:30`; `runCollectorOutput` at `:34`; `runCollectorOutputWithContext` at `:41`.

`:224-230` — the truncation helper this wave reuses for field bounding:
```go
func truncateCollectorString(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= collectorStringLimit {
		return value
	}
	return strings.TrimSpace(value[:collectorStringLimit]) + "... [truncated]"
}
```
Note `collectorStringLimit` is **512**, not the 200 D10 requires. This wave adds its own 200-char bound; it does not change the shared constant.

### 0.5 The tag-free-parse-file precedent — `agent/internal/collectors/hardware_wmi_parse.go`

`:1-16` (no build tag on line 1 — the file opens straight into `package collectors`):
```go
package collectors

import (
	"bytes"
	"encoding/json"
)

// gpuNameList is the GPU-name field of the batched WMI query. It exists to
// tolerate both shapes Windows can emit: a JSON array ("GPUNames":["a","b"])
// and — critically — a bare scalar string. Windows PowerShell 5.1 (the default
// shell on essentially every managed endpoint) collapses a single-element array
// to a scalar during ConvertTo-Json, so a one-GPU host (the common case) emits
// "GPUNames":"Intel UHD" rather than ["Intel UHD"]. Decoding straight into a
// []string would fail on those hosts and, because the caller treats any parse
// error as fatal, would drop the entire hardware record (serial, model, …).
type gpuNameList []string
```

`agent/internal/collectors/hardware_test.go:1-5` is likewise tag-free and calls the parser at `:266`:
```go
package collectors

import (
	"testing"
)
```
```go
			got, err := parseHardwareJSON([]byte(tt.input))
```

**This is the load-bearing precedent for this wave's architecture**: a tag-free parse file next to a tagged collector, unit-tested by a tag-free test, is how WMI parsing is already proven on non-Windows CI. The PowerShell-5.1 single-element-array collapse documented here recurs verbatim for `HP_Entitlements` and is handled in Task 2.

### 0.6 Existing seam-override test pattern — `agent/internal/collectors/software_darwin.go:12` and its test

```go
var softwareCommandOutput = runCollectorOutput
```

`agent/internal/collectors/software_darwin_test.go:33-40`:
```go
func TestDarwinCollectObservationReportsSourceEvidence(t *testing.T) {
	original := softwareCommandOutput
	t.Cleanup(func() { softwareCommandOutput = original })

	t.Run("complete", func(t *testing.T) {
		softwareCommandOutput = func(_ time.Duration, _ string, _ ...string) ([]byte, error) {
			return []byte(`{"SPApplicationsDataType":[{"_name":"Breeze","version":"1"}]}`), nil
		}
```

This wave copies the save/`t.Cleanup`/restore shape exactly, but declares its seam in the **tag-free** file so the override compiles on darwin and linux.

### 0.7 The 15-minute fan-out this wave must NOT join — `agent/internal/heartbeat/heartbeat.go:2112-2139`

```go
// sendInventory collects and sends the 15-minute inventory set: software, disk,
// network, configuration changes, connections, policy registry/config state, and
// Apple warranty info. All goroutines are tracked via inventoryWg for graceful shutdown.
//
// Note: hardware inventory, patch inventory, security status, and session inventory
// are intentionally absent here — each runs on its own independent cadence:
//   - hardware / patch:   daily (or configured), dispatched from the tick gate
//   - security / sessions: every 5 minutes, dispatched from their own tick gates
func (h *Heartbeat) sendInventory() {
	fns := []func(){
		h.sendSoftwareInventory,
		h.sendDiskInventory,
		h.sendNetworkInventory,
		h.sendConfigurationChanges,
		h.sendConnectionsInventory,
		h.sendPolicyRegistryState,
		h.sendPolicyConfigState,
		h.sendAppleWarrantyInfo,
	}
```

Confirmed: `func (h *Heartbeat) sendInventory()` at `:2120`, `h.sendAppleWarrantyInfo` registered at `:2129`, the slice closes at `:2130` and the function at `:2139`. Contract's `heartbeat.go:2120-2139` / `:2129` is **exact**. The doc comment's own "each runs on its own independent cadence … dispatched from the tick gate" is the pattern D8 requires for HP.

### 0.8 The transport — `agent/internal/heartbeat/heartbeat.go:2154-2185`

```go
// sendInventoryData marshals the payload and sends it to the given endpoint via PUT.
func (h *Heartbeat) sendInventoryData(endpoint string, payload any, label string) error {
	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal inventory", "label", label, "error", err.Error())
		return err
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/%s", h.serverURL(), h.config.AgentID, endpoint)
```

Confirmed: signature at `:2155`, **endpoint first**, label third; the function ends at `:2185`. Contract's `:2154-2185` is exact (`:2154` is the doc comment).

### 0.9 The payload to model — `agent/internal/heartbeat/heartbeat.go:2405-2435`

```go
func (h *Heartbeat) sendAppleWarrantyInfo() {
	if runtime.GOOS != "darwin" {
		return
	}
	info, err := collectors.CollectAppleWarranty()
	if err != nil {
		log.Warn("failed to collect Apple warranty info", "error", err.Error())
		return
	}
	if info == nil {
		log.Debug("no Apple warranty plist data found")
		return
	}

	payload := map[string]any{
		"source":            "agent_plist",
		"manufacturer":      "Apple",
		"coverageEndDate":   info.CoverageEndDate,
		"coverageStartDate": info.CoverageStartDate,
		"coverageType":      info.CoverageType,
		"deviceName":        info.DeviceName,
	}
	// Only include coverageKind when the NDO verb is recognized; omit the key for
	// timestamp-only/labelless/localized/plist-fallback coverage where it can't be
	// classified (#1320). The API schema tolerates an empty/absent value and treats
	// it as fixed for back-compat (#1344), so omitting it here is safe — no 400.
	if info.CoverageKind != "" {
		payload["coverageKind"] = info.CoverageKind
	}
	h.sendInventoryData("warranty-info", payload, "apple warranty")
}
```

Confirmed: `:2405-2435` exact. The belt-and-braces `runtime.GOOS` guard at `:2406-2408` is copied for HP (with `"windows"`), even though `hp_warranty_other.go` already makes collection a no-op — the guard is what stops a non-Windows agent from persisting schedule state and burning a heartbeat tick.

### 0.10 The persisted-state precedent — `agent/internal/heartbeat/reliability_state.go`

`:14-37`:
```go
const reliabilityStateFileName = "reliability_state.json"

// reliabilityPostInterval is the minimum spacing between reliability posts —
// metrics are meant to go out at most once per this window.
const reliabilityPostInterval = 24 * time.Hour

// reliabilityPostDue reports whether a reliability post is due given the last
// time one was sent and the current time. A zero `last` (never sent, or an
// unreadable/corrupt persisted state) is always due, so the first post fails
// open. Extracted as a pure function so the gate — the heart of #1906 — is
// unit-testable without driving the long-running heartbeat loop.
func reliabilityPostDue(last, now time.Time) bool {
	return now.Sub(last) > reliabilityPostInterval
}

// reliabilityState persists the last time reliability metrics were posted so
// the 24h send cadence survives agent restarts. Without it, every restart
// (crash, auto-update, machine reboot — frequent on POS/checkout boxes) reset
// the in-memory timer to its zero value and immediately re-posted an
// overlapping event-log window, creating duplicate device_reliability_history
// rows and inflating failure counts (issue #1906).
type reliabilityState struct {
	LastUpdate time.Time `json:"lastUpdate"`
}
```

`:39-53` — the path resolution this wave **deliberately diverges from**:
```go
// reliabilityStatePath mirrors ipStatePath: prefer the per-user ~/.breeze dir,
// fall back to the configured data dir, then a temp dir as a last resort.
func (h *Heartbeat) reliabilityStatePath() string {
	if homeDir, err := os.UserHomeDir(); err == nil && strings.TrimSpace(homeDir) != "" {
		return filepath.Join(homeDir, ".breeze", reliabilityStateFileName)
	}

	dataDir := strings.TrimSpace(config.GetDataDir())
	if dataDir == "" {
		tmpPath := filepath.Join(os.TempDir(), "breeze", reliabilityStateFileName)
		log.Warn("reliability state directory unavailable, falling back to temp dir", "path", tmpPath)
		return tmpPath
	}
	return filepath.Join(dataDir, reliabilityStateFileName)
}
```

`:79-99` — the atomic write this wave copies verbatim in shape:
```go
// saveLastReliabilityUpdate atomically persists the last-send timestamp.
func (h *Heartbeat) saveLastReliabilityUpdate(t time.Time) error {
	path := h.reliabilityStatePath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create reliability state directory %s: %w", dir, err)
	}

	payload, err := json.Marshal(reliabilityState{LastUpdate: t})
	if err != nil {
		return fmt.Errorf("failed to encode reliability state: %w", err)
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0600); err != nil {
		return fmt.Errorf("failed to write reliability state temp file %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("failed to persist reliability state %s: %w", path, err)
	}
	return nil
}
```

`agent/internal/config/config.go:1058-1068` — the data dir:
```go
// GetDataDir returns the platform-specific data directory for the agent
func GetDataDir() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(configDir(), "data")
	case "darwin":
		return "/Library/Application Support/Breeze/data"
	default:
		return "/var/lib/breeze"
	}
}
```

### 0.11 The tick-gate and bounded-retry precedent — `agent/internal/heartbeat/heartbeat.go`

`:2220-2222`:
```go
func dueForRun(now, last time.Time, interval time.Duration) bool {
	return now.Sub(last) > interval
}
```

`:2236-2241` (the retry-schedule rationale this wave mirrors for HP's *per-NAT* limit):
```go
const (
	maxPatchSendRetries  = 4
	patchRetryBaseDelay  = 5 * time.Minute
	patchRetryMaxDelay   = 2 * time.Hour
	patchRetryJitterFrac = 0.3
```

`:2248-2263`:
```go
func patchRetryDelay(failures int, jitterFrac, rnd float64) time.Duration {
	if failures < 1 || failures > maxPatchSendRetries {
		return 0
	}
	delay := patchRetryBaseDelay << (failures - 1) // 5m, 10m, 20m, 40m
	if delay > patchRetryMaxDelay {
		delay = patchRetryMaxDelay
	}
	if jitterFrac > 0 {
		// Additive-only: spreads a synchronized fleet forward in time without
		// any agent retrying sooner than the base delay.
		delay = time.Duration(float64(delay) * (1 + jitterFrac*rnd))
	}
	return delay
}
```

`:2276-2290` — the **claim gate**, the exact shape Task 8 copies:
```go
// claimPatchScanLocked decides whether a patch scan is due and, if so, claims
// it by advancing the gate so the next tick can't dispatch a duplicate
// concurrent scan. Returns whether the caller should dispatch.
//
// The decision and the state transition live together here (rather than being
// open-coded in the tick loop) so the whole gate is exercised by one test
// instead of only its pure predicate. Caller must hold h.mu.
func (h *Heartbeat) claimPatchScanLocked(now time.Time, interval time.Duration) bool {
	if !patchScanDue(now, h.lastPatchUpdate, h.nextPatchRetryAt, interval) {
		return false
	}
	h.lastPatchUpdate = now
```

`:1846-1885` — the tick body where the gate is evaluated under `h.mu` and dispatched after `h.mu.Unlock()`:
```go
			h.sendHeartbeatWithWatchdog()
			now := time.Now()
			// Send inventory every 15 minutes
			h.mu.Lock()
			shouldSendInventory := now.Sub(h.lastInventoryUpdate) > 15*time.Minute
```
…
```go
			patchIntervalHours := clampPatchScanIntervalHours(h.config.PatchScanIntervalHours)
			patchInterval := time.Duration(patchIntervalHours) * time.Hour
			shouldSendPatch := h.claimPatchScanLocked(now, patchInterval)
			h.mu.Unlock()
```

`:1789-1809` — the startup seeding of persisted cadence, which Task 6 mirrors:
```go
		startupNow := time.Now()
		persistedReliability := h.loadLastReliabilityUpdate()
		postReliability := reliabilityPostDue(persistedReliability, startupNow)
		h.mu.Lock()
		h.lastPostureUpdate = startupNow
		if postReliability {
			h.lastReliabilityUpdate = startupNow
		} else {
			h.lastReliabilityUpdate = persistedReliability
		}
```

`Heartbeat` struct — `:320`, with `mu sync.Mutex` at `:363` and the cadence fields at `:364-380`. `var log = logging.L("heartbeat")` at `:65`.

### 0.12 The config seam this wave consumes — `agent/internal/heartbeat/patch_source.go` (W02's template)

Full file, 57 lines. **Neither symbol is exported.** `:7-12`:
```go
// applyWinUpdate is the seam to the (Windows-only) enforcement. A package var so
// tests can capture the resolved enforce bool on any platform — the dispatch +
// payload-parse path is where a key-name regression would silently disable the
// whole feature, so it must be unit-tested even though the registry I/O cannot
// run on the CI agent.
var applyWinUpdate = winupdate.Apply
```

`:18-33` — note the **camelCase-first** inner parse:
```go
func (h *Heartbeat) applyPatchSourceConfig(raw any) {
	m, ok := raw.(map[string]any)
	if !ok {
		log.Warn("ignoring invalid patch_source_settings payload: not an object")
		return
	}

	// The API may send either snake_case or camelCase.
	v, present := m["exclusiveWindowsUpdate"]
	if !present {
		v, present = m["exclusive_windows_update"]
	}
	if !present {
		log.Warn("patch_source_settings received without exclusiveWindowsUpdate field")
		return
	}
```

Contract's `patch_source.go:12`, `:18`, `:26-29` — **all exact.**

### 0.13 `applyConfigUpdate` and the probe-path trap — `agent/internal/heartbeat/heartbeat.go:2851-2930`

```go
func (h *Heartbeat) applyConfigUpdate(update map[string]any) {
	if len(update) == 0 {
		return
	}

	// Apply event_log_settings if present
	elRaw, hasEL := update["event_log_settings"]
```
…snake_case-first outer keys at `:2857`, `:2867`, `:2879`, `:2889`, `:2901`, `:2910`…
```go
	registryRaw, hasRegistry := update["policy_registry_state_probes"]
	if !hasRegistry {
		registryRaw, hasRegistry = update["policyRegistryStateProbes"]
	}

	configRaw, hasConfig := update["policy_config_state_probes"]
	if !hasConfig {
		configRaw, hasConfig = update["policyConfigStateProbes"]
	}

	if !hasRegistry && !hasConfig {
		return
	}
```

Confirmed: `applyConfigUpdate` at `:2851`; probe path begins `:2918`; the unconditional `return` is `:2928-2930`. **W02 owns adding the warranty dispatch above `:2918`.** W03 does not touch this function.

### 0.14 Server-side shapes this wave produces against (W01's, do NOT redefine)

`apps/api/src/routes/agents/schemas.ts:658-675` — the *current* schema, which W01 widens with `entitlements`:
```ts
export const agentWarrantyInfoSchema = z.object({
  source: z.string().min(1).max(50),
  manufacturer: z.string().min(1).max(100),
  coverageEndDate: warrantyDateSchema,
  coverageStartDate: warrantyDateSchema,
  coverageType: z.string().max(200).optional(),
```

`apps/api/src/services/warrantySync.ts:315-321` — the *current* `AgentWarrantyData`, which W01 widens:
```ts
export interface AgentWarrantyData {
  source: string;
  manufacturer: string;
  serialNumber: string | null;
  coverageEndDate: string | null;
  coverageStartDate: string | null;
  coverageType: string | null;
```

`apps/api/src/services/warrantyProviders/types.ts:1-7` — the entitlement field names the agent's array must use (minus `provider`, which W01 derives):
```ts
export interface WarrantyEntitlement {
  provider: 'dell' | 'hp' | 'lenovo' | 'apple';
  serviceLevelDescription: string;
  entitlementType: string;
  startDate: string;
  endDate: string;
}
```

`apps/api/src/services/warrantySync.ts:364-373` — the defect W01 fixes, quoted so this wave never sends `provider` itself:
```ts
  // Build entitlements array from agent data
  const entitlements = data.coverageType
    ? [{
        provider: 'apple' as const,
```
Contract says the hardcode is at `:367`. **Confirmed at `:367`** (the spec body's `:364` points at the comment, not the line).

### 0.15 Deviations found from the contract

Two, both cosmetic, neither changes any decision:

1. Contract §Verified facts says `warranty_other.go:20` is the stub's return. `:20` is the `func CollectAppleWarranty()` line; the `return nil, nil` is `:21`. Immaterial.
2. `agent/go.mod:3` is `go 1.26.6`, not the `1.25` the sibling W03 calibration plan states. This wave targets what `go.mod` says.

**No substantive contract fact was found wrong.** The one item the contract does **not** settle is named in "Open contract question" below.

### 0.16 The one thing the CONTRACT does not settle — how W02's seam hands the flag to this wave

Contract D7 specifies W02's `warranty_config.go` as "a package-level func var for the platform call plus an unexported `func (h *Heartbeat) applyWarrantyConfig(raw any)`". It does **not** say where the resolved `hp_cmsl_enabled` boolean is *stored* for a later consumer. **W02's plan does, and W03 defers to it.**

`docs/superpowers/plans/device-lifecycle/2026-09-10-hp-warranty-cmsl-w02-opt-in-surface-and-delivery.md` (written concurrently with this plan; verified present 2026-09-10) states in its File structure section:

> - **Create** `agent/internal/heartbeat/warranty_config.go` + `warranty_config_test.go` — the seam, the parse, **and the accessor W03 reads**.

and names the pattern in its ground truth:

> `agent/internal/heartbeat/heartbeat.go:2809-2848` — `applyRequireManifestSigningKeyIDConfig`, the closest precedent for a **persisted control-plane boolean**: read current under `h.mu`, decide, write `h.config.X` under `h.mu`, then `config.SetAndPersist(...)` with a `log.Warn` on failure. `:4008-4012` — `func (h *Heartbeat) requireManifestSigningKeyID() bool { h.mu.Lock(); defer h.mu.Unlock(); return h.config.RequireManifestSigningKeyID }` — **the mutex-guarded accessor pattern W03 will need.**

So the expected shipped shape is a **persisted `h.config` field plus a mutex-guarded accessor**, not an in-memory flag. That is the better design and W03 adopts it: persisting the gate means a device that is enrolled, gated on, and then restarted before its next heartbeat still knows collection is authorised, instead of silently reverting to `false` until the next config update.

**W02's plan does not print the accessor's final name.** It is being written in a parallel session and its Go task body was not yet greppable when this plan was authored. Task 9 Step 1 therefore begins with the grep that reads the shipped name, and gives complete code for both outcomes:

- **Primary (expected):** W02 shipped an accessor. `hpCmslCollectionEnabled()` becomes a one-line delegate to it; W03 adds no storage at all.
- **Fallback:** W02 shipped only the parse and a platform func var. W03 declares the storage itself (a `sync/atomic` `atomic.Bool` field, a setter, and one added line in `applyWarrantyConfig`).

Either way there is exactly one named consumption point in this wave — `func (h *Heartbeat) hpCmslCollectionEnabled() bool` — and every other task reads only that. A duplicate declaration between the two waves is a *compile error*: loud and immediate, never silent.

---

## File structure

| File | Build tag | Responsibility |
|---|---|---|
| `agent/internal/collectors/hp_warranty.go` | **none** | **Every shared type, declared exactly once** — `HpWarrantyInfo`, `HpEntitlement`, `HpCollectError`, `IsHpRateLimited`, the `HpTier*` / `HpReason*` constants — plus everything testable: the `hpRunPowerShell` seam, both PowerShell scripts, the WMI JSON decoder + field-candidate lists, date normalisation, `hpCacheStale`, `collectHpWarrantyTiered`, 429 classification, entitlement bounding. |
| `agent/internal/collectors/hp_warranty_windows.go` | `//go:build windows` | **The platform entry point and nothing else**: `CollectHpWarranty()` delegating to the tag-free orchestrator. ~10 lines. Declares no type. |
| `agent/internal/collectors/hp_warranty_other.go` | `//go:build !windows` | **The platform entry point and nothing else**: `CollectHpWarranty()` returning `(nil, nil)`. ~8 lines. Declares no type. |
| `agent/internal/collectors/hp_warranty_test.go` | **none** | Table-driven tests for every function above. Runs on darwin/linux. |
| `agent/internal/collectors/hp_warranty_other_test.go` | `//go:build !windows` | The `(nil, nil)` stub contract. |
| `agent/internal/collectors/testdata/hp_warranty_wmi_real.json` | — | The probe's captured WMI output (Task 2 Step 1, from W01). |
| `agent/internal/heartbeat/hp_warranty.go` | **none** | Persisted `hpWarrantyState`, path resolution, load/save, `hpJitterOffset`, `hpNextDueAt`, `hpRetryDelay`, `hpRateLimitBackoff`, `claimHpWarrantyCycleLocked`, `sendHpWarrantyInfo`, `hpCmslCollectionEnabled`. |
| `agent/internal/heartbeat/hp_warranty_test.go` | **none** | Table-driven tests for due-time, jitter determinism + distribution, retry/back-off, the claim gate, and the payload shape. |
| `agent/internal/heartbeat/heartbeat.go` | **none** | Modified: four struct fields, startup seeding, one tick-gate call, one dispatch. |
| `agent/internal/heartbeat/warranty_config.go` | **none** | Modified by **one line** (Task 8) — W02's file, W03 only adds the setter call. |

---

## Task 1: Shared types and the two platform entry points

**Files:**
- Create: `agent/internal/collectors/hp_warranty.go` (all shared types — this is where `HpWarrantyInfo` lives, once)
- Create: `agent/internal/collectors/hp_warranty_windows.go` (entry point only)
- Create: `agent/internal/collectors/hp_warranty_other.go` (entry point only)
- Test: `agent/internal/collectors/hp_warranty_other_test.go`

**Interfaces:**
- Produces: `collectors.HpWarrantyInfo` (struct, declared once in the tag-free file), `collectors.HpEntitlement`, `collectors.CollectHpWarranty() (*HpWarrantyInfo, error)` (one declaration per build tag), `collectors.HpCollectError`, `collectors.IsHpRateLimited(error) bool`, and the `HpReason*` / `HpTier*` constants.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `agent/internal/collectors/hp_warranty_other_test.go`:

```go
//go:build !windows

package collectors

import "testing"

// The non-Windows stub must be a true no-op with the same signature as the
// Windows entry point. heartbeat.go compiles on every platform and calls this
// function, so a signature drift here is a cross-platform build break, not a
// runtime bug.
//
// Note what this test does NOT need to check: that the struct's field set
// matches across platforms. HpWarrantyInfo is declared once, in the tag-free
// hp_warranty.go, so there is no second copy to drift from (D7 as amended).
func TestCollectHpWarranty_IsANoOpOnNonWindows(t *testing.T) {
	info, err := CollectHpWarranty()
	if err != nil {
		t.Fatalf("CollectHpWarranty() error = %v, want nil on non-Windows", err)
	}
	if info != nil {
		t.Fatalf("CollectHpWarranty() = %#v, want nil on non-Windows", info)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/collectors/ -run TestCollectHpWarranty
```
Expected: FAIL to build — `undefined: CollectHpWarranty`.

- [ ] **Step 3: Create the tag-free shared types**

Create `agent/internal/collectors/hp_warranty.go`:

```go
package collectors

import (
	"errors"
	"fmt"
	"time"
)

// HpWarrantyInfo contains HP warranty data read from HP's own WMI namespace
// (root/HP/InstrumentedServices/v1), populated by HP's Client Management Script
// Library.
//
// Declared HERE, in the build-tag-free file, exactly once — not mirrored into
// hp_warranty_windows.go and hp_warranty_other.go. The parity duplication in
// warranty_other.go:12-15 exists because Apple's collector has no tag-free file
// and its struct has nowhere else to live; this collector does have one, so a
// single declaration gives heartbeat.go the same cross-platform type-checking
// guarantee with no second copy to drift from. (Contract D7, as amended
// 2026-09-10.)
type HpWarrantyInfo struct {
	SerialNumber      string          `json:"serialNumber,omitempty"`
	ProductNumber     string          `json:"productNumber,omitempty"`
	CoverageStartDate string          `json:"coverageStartDate,omitempty"`
	CoverageEndDate   string          `json:"coverageEndDate,omitempty"`
	CoverageType      string          `json:"coverageType,omitempty"`
	Entitlements      []HpEntitlement `json:"entitlements,omitempty"`

	// HPCacheTime is HP's OWN cache write timestamp, read out of WMI. It is the
	// scheduling input (contract D8): HP self-caches 30 days, so an arbitrary
	// day-25 invocation returns cached data and refreshes nothing. Never sent on
	// the wire — the server has its own receipt time and W01 has HP's real fetch
	// time, and conflating the three is exactly the defect the spec calls out.
	HPCacheTime time.Time `json:"-"`
	// Tier is one of HpTierT0/T1/T2 — diagnostic only.
	Tier string `json:"-"`
	// Reason is one of the HpReason* codes — diagnostic only.
	Reason string `json:"-"`
	// RateLimited is true when HP refused with a 429 during this cycle, even if
	// stale WMI data was still returned alongside. The scheduler must see this
	// to back off; an error return alone would lose it on the serve-stale path.
	RateLimited bool `json:"-"`
}

// Tier names for HP warranty collection (spec layer 5). They are diagnostic
// only — nothing on the wire carries them — but they are what an operator reads
// out of agent logs to tell "HP never installed CMSL" apart from "CMSL is there
// and HP's cache is simply still fresh".
const (
	// HpTierT0 — the data came from a local WMI read with no network I/O and no
	// CMSL invocation. The cheap, overwhelmingly common path.
	HpTierT0 = "t0_wmi"
	// HpTierT1 — HP's own 30-day cache had genuinely lapsed, so
	// Get-HPWarrantyInfo was invoked (network round trip to HP) and WMI re-read.
	HpTierT1 = "t1_refresh"
	// HpTierT2 — CMSL is not present on the device. Report nothing and let the
	// software policy install it.
	HpTierT2 = "t2_absent"
)

// Reason codes explaining why a collection produced no data, or produced stale
// data. The spec is explicit that "PowerShell 5.1 and TLS 1.2 prerequisites are
// not universal on older Windows builds. The collector must report *why* it
// could not collect rather than failing silently." These are the vocabulary for
// that: every non-OK exit carries exactly one.
const (
	HpReasonOK                = "ok"
	HpReasonNamespaceAbsent   = "wmi_namespace_absent"
	HpReasonNoWarrantyRow     = "wmi_no_warranty_row"
	HpReasonParseFailed       = "wmi_parse_failed"
	HpReasonPowerShellFailed  = "powershell_failed"
	HpReasonPowerShellTooOld  = "powershell_below_5_1"
	HpReasonCmslCmdletAbsent  = "cmsl_cmdlet_absent"
	HpReasonRefreshFailed     = "cmsl_refresh_failed"
	HpReasonRateLimited       = "hp_rate_limited"
)

// HpEntitlement is one HP service entitlement as reported by the device.
//
// The field names deliberately mirror WarrantyEntitlement in
// apps/api/src/services/warrantyProviders/types.ts:1-7 MINUS its `provider`
// field: W01 derives provider from the reporting source server-side, because
// hardcoding it is the verified defect at warrantySync.ts:367. An agent that
// sent `provider` would be asserting something the server is responsible for.
type HpEntitlement struct {
	ServiceLevelDescription string `json:"serviceLevelDescription,omitempty"`
	EntitlementType         string `json:"entitlementType,omitempty"`
	StartDate               string `json:"startDate,omitempty"`
	EndDate                 string `json:"endDate,omitempty"`
}

// HpCollectError explains a collection that produced nothing usable. Reason is
// one of the HpReason* constants (a stable, greppable code); Detail is the
// underlying message, already truncated, for human diagnosis.
type HpCollectError struct {
	Reason string
	Detail string
}

func (e *HpCollectError) Error() string {
	if e.Detail == "" {
		return "hp warranty collection failed: " + e.Reason
	}
	return fmt.Sprintf("hp warranty collection failed: %s: %s", e.Reason, e.Detail)
}

// IsHpRateLimited reports whether err is an HP rate-limit refusal. The caller
// backs off for hours rather than retrying, because HP's limit is 300 requests
// per 5 minutes per SOURCE IP — a per-customer-NAT limit. A 429 means the whole
// site's HP fleet is saturating one bucket, so retrying soon re-creates it.
func IsHpRateLimited(err error) bool {
	var hpErr *HpCollectError
	if !errorsAs(err, &hpErr) {
		return false
	}
	return hpErr.Reason == HpReasonRateLimited
}
```

Add the `errors.As` helper at the bottom of the same file:

```go
// errorsAs is errors.As, named locally so every *HpCollectError match in this
// package reads identically (Tasks 2, 3 and 5 each do one). Behaviour is
// identical to errors.As; it exists for call-site uniformity, not to change
// semantics — in particular it still unwraps.
func errorsAs(err error, target any) bool { return errors.As(err, target) }
```

The file's import block is already correct as written at the top of this step — `errors` for the helper above, `fmt` for `HpCollectError.Error`, `time` for `HpWarrantyInfo.HPCacheTime`. Later tasks widen it (`bytes`, `encoding/json`, `regexp`, `sort`, `strconv`, `strings`) as they add code.

- [ ] **Step 4: Create the non-Windows entry point**

Create `agent/internal/collectors/hp_warranty_other.go`. **It declares no type** — `HpWarrantyInfo` lives once in `hp_warranty.go` (Step 3). This file is the `(nil, nil)` stub and nothing else:

```go
//go:build !windows

package collectors

// CollectHpWarranty is a no-op on non-Windows platforms. HP CMSL is a Windows
// product and the WMI namespace it populates does not exist elsewhere.
//
// heartbeat.go compiles on every platform and calls this, so the signature must
// match the Windows entry point exactly — that cross-platform type-check is the
// reason this stub exists at all, and it is satisfied by the shared
// HpWarrantyInfo in hp_warranty.go without a second struct declaration here.
func CollectHpWarranty() (*HpWarrantyInfo, error) {
	return nil, nil
}
```

- [ ] **Step 5: Create the Windows entry point**

Create `agent/internal/collectors/hp_warranty_windows.go`:

```go
//go:build windows

package collectors

import "time"

// CollectHpWarranty runs the tiered HP warranty collection: T0 reads HP's WMI
// namespace, T1 invokes Get-HPWarrantyInfo only when HP's own cache has
// genuinely lapsed, T2 reports that CMSL is absent. All logic lives in the
// build-tag-free hp_warranty.go so it is unit-testable on a non-Windows CI
// runner — this file only supplies the platform entry point.
func CollectHpWarranty() (*HpWarrantyInfo, error) {
	return collectHpWarrantyTiered(time.Now())
}
```

- [ ] **Step 6: Add the orchestrator's signature so the Windows build resolves**

Append to `agent/internal/collectors/hp_warranty.go` (fleshed out in Task 3; this task only needs the symbol to exist):

```go
// collectHpWarrantyTiered runs T0 → T1 → T2 against `now`. Filled in by Task 3.
func collectHpWarrantyTiered(now time.Time) (*HpWarrantyInfo, error) {
	return nil, &HpCollectError{Reason: HpReasonNamespaceAbsent}
}
```

`"time"` is already in that file's import block from Step 3 (`HpWarrantyInfo.HPCacheTime` needs it), so no import change is required here.

- [ ] **Step 7: Run the tests and both cross-compiles**

```bash
cd agent && go test -race ./internal/collectors/ -run 'TestCollectHpWarranty'
cd agent && GOOS=windows GOARCH=amd64 go build ./internal/collectors/
cd agent && GOOS=darwin GOARCH=arm64 go build ./internal/collectors/
```
Expected: PASS, and both builds succeed. The two builds are what prove the *entry points* line up — each platform must supply exactly one `CollectHpWarranty` with the same signature over the one shared `HpWarrantyInfo`. A missing or mistyped stub is a build failure here, not a runtime surprise on a customer endpoint.

- [ ] **Step 8: Commit**

```bash
git add agent/internal/collectors/hp_warranty.go agent/internal/collectors/hp_warranty_windows.go agent/internal/collectors/hp_warranty_other.go agent/internal/collectors/hp_warranty_other_test.go
git commit -m "feat(agent): HP warranty collector scaffolding — shared types plus two platform entry points (W03)"
```

---

## Task 2: T0 — parse HP's WMI output from the probe's captured JSON

> **Blocked on the W01 gate, question 2.** Do not implement without `hp_warranty_wmi_real.json`.

**Files:**
- Create: `agent/internal/collectors/testdata/hp_warranty_wmi_real.json`
- Modify: `agent/internal/collectors/hp_warranty.go`
- Test: `agent/internal/collectors/hp_warranty_test.go`

**Interfaces:**
- Produces: `parseHpWarrantyWMI(raw []byte) (*HpWarrantyInfo, error)`, `hpEntitlementRows` (object-or-array tolerant decoder), `normalizeHpDate(string) string`, `parseHpTimestamp(string) time.Time`, `pickHpString(map[string]any, ...string) string`, and the field-candidate vars `hpSerialFields`, `hpProductNumberFields`, `hpCoverageStartFields`, `hpCoverageEndFields`, `hpCoverageTypeFields`, `hpCacheTimeFields`, `hpEntStartFields`, `hpEntEndFields`, `hpEntTypeFields`, `hpEntDescFields`.
- Consumes: `HpWarrantyInfo`, `HpEntitlement`, `HpCollectError`, the `HpReason*` constants (Task 1).

- [ ] **Step 1: Drop in the probe fixture**

Take the captured `Get-CimInstance` output recorded by W01 on issue #5512 and save it **verbatim** as `agent/internal/collectors/testdata/hp_warranty_wmi_real.json`, wrapped in the envelope the T0 script emits (Task 3):

```json
{"NamespacePresent":true,"Error":"","Warranty":{"SerialNumber":"5CD1234ABC","ProductNumber":"1A2B3C#ABA","WarrantyStartDate":"20240115000000.000000+000","WarrantyEndDate":"20270114000000.000000+000","WarrantyType":"HP 3 year Next Business Day Onsite","LastUpdate":"20260820113000.000000+000"},"Entitlements":[{"ServiceLevelDescription":"HP 3 year Next Business Day Onsite","OfferDescription":"Next Business Day Onsite","StartDate":"20240115000000.000000+000","EndDate":"20270114000000.000000+000"},{"ServiceLevelDescription":"HP 1 year Accidental Damage Protection","OfferDescription":"Accidental Damage Protection","StartDate":"20240115000000.000000+000","EndDate":"20250114000000.000000+000"}]}
```

**Then reconcile the candidate lists in Step 3 against the real property names in that file.** If HP's `HP_Warranty` class calls the end date something other than `WarrantyEndDate`/`EndDate`/`CoverageEndDate`, add the real name to `hpCoverageEndFields` — that is a one-line change to a named var, and it is the only place a name lives.

- [ ] **Step 2: Write the failing test**

Create `agent/internal/collectors/hp_warranty_test.go`:

```go
package collectors

import (
	"os"
	"testing"
	"time"
)

func TestParseHpWarrantyWMI_RealProbeFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/hp_warranty_wmi_real.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	info, err := parseHpWarrantyWMI(raw)
	if err != nil {
		t.Fatalf("parseHpWarrantyWMI() error = %v, want nil", err)
	}
	if info.SerialNumber == "" {
		t.Error("SerialNumber did not resolve — add the real property name to hpSerialFields")
	}
	if info.CoverageEndDate == "" {
		t.Error("CoverageEndDate did not resolve — add the real property name to hpCoverageEndFields")
	}
	if info.CoverageStartDate == "" {
		t.Error("CoverageStartDate did not resolve — add the real property name to hpCoverageStartFields")
	}
	if info.HPCacheTime.IsZero() {
		t.Error("HPCacheTime did not resolve — add the real property name to hpCacheTimeFields; scheduling (D8) depends on it")
	}
	if len(info.Entitlements) == 0 {
		t.Error("no entitlements parsed — check hpEntDescFields / the Entitlements envelope key")
	}
	for i, e := range info.Entitlements {
		if e.EndDate == "" {
			t.Errorf("entitlement %d has no EndDate — add the real property name to hpEntEndFields", i)
		}
	}
}

func TestParseHpWarrantyWMI_Table(t *testing.T) {
	tests := []struct {
		name        string
		raw         string
		wantErr     bool
		wantReason  string
		wantEnd     string
		wantEntLen  int
		wantCacheAt string // RFC3339, "" = zero
	}{
		{
			name:       "namespace absent is T2, not a parse failure",
			raw:        `{"NamespacePresent":false,"Error":"Invalid namespace","Warranty":null,"Entitlements":[]}`,
			wantErr:    true,
			wantReason: HpReasonNamespaceAbsent,
		},
		{
			name:       "namespace present but no warranty row",
			raw:        `{"NamespacePresent":true,"Error":"","Warranty":null,"Entitlements":[]}`,
			wantErr:    true,
			wantReason: HpReasonNoWarrantyRow,
		},
		{
			name:       "powershell below 5.1 is reported, not swallowed",
			raw:        `{"NamespacePresent":false,"Error":"powershell-below-5-1","Warranty":null,"Entitlements":[]}`,
			wantErr:    true,
			wantReason: HpReasonPowerShellTooOld,
		},
		{
			name:       "Get-CimInstance unavailable is reported distinctly",
			raw:        `{"NamespacePresent":false,"Error":"get-ciminstance-unavailable","Warranty":null,"Entitlements":[]}`,
			wantErr:    true,
			wantReason: HpReasonPowerShellFailed,
		},
		{
			name:       "not JSON at all",
			raw:        `Get-CimInstance : Invalid namespace`,
			wantErr:    true,
			wantReason: HpReasonParseFailed,
		},
		{
			name:        "CIM DATETIME dates normalise to YYYY-MM-DD and the cache time parses",
			raw:         `{"NamespacePresent":true,"Error":"","Warranty":{"SerialNumber":"X","WarrantyStartDate":"20240115000000.000000+000","WarrantyEndDate":"20270114000000.000000+000","LastUpdate":"20260820113000.000000+000"},"Entitlements":[]}`,
			wantEnd:     "2027-01-14",
			wantEntLen:  0,
			wantCacheAt: "2026-08-20T11:30:00Z",
		},
		{
			name:        "ISO-8601 dates are accepted as-is",
			raw:         `{"NamespacePresent":true,"Error":"","Warranty":{"SerialNumber":"X","StartDate":"2024-01-15","EndDate":"2027-01-14T00:00:00Z","LastUpdate":"2026-08-20T11:30:00Z"},"Entitlements":[]}`,
			wantEnd:     "2027-01-14",
			wantCacheAt: "2026-08-20T11:30:00Z",
		},
		{
			name:        "/Date(ms)/ dates are accepted",
			raw:         `{"NamespacePresent":true,"Error":"","Warranty":{"SerialNumber":"X","EndDate":"/Date(1799971200000)/","LastUpdate":"/Date(1787225400000)/"},"Entitlements":[]}`,
			wantEnd:     "2027-01-14",
			wantCacheAt: "2026-08-20T11:30:00Z",
		},
		{
			name: "PowerShell 5.1 collapses a single entitlement to an object, not an array (#hardware_wmi_parse.go lesson)",
			raw: `{"NamespacePresent":true,"Error":"","Warranty":{"SerialNumber":"X","EndDate":"2027-01-14"},` +
				`"Entitlements":{"ServiceLevelDescription":"HP 3y NBD","OfferDescription":"NBD Onsite","StartDate":"2024-01-15","EndDate":"2027-01-14"}}`,
			wantEnd:    "2027-01-14",
			wantEntLen: 1,
		},
		{
			name: "an entitlement with no usable field at all is dropped, the rest survive",
			raw: `{"NamespacePresent":true,"Error":"","Warranty":{"SerialNumber":"X","EndDate":"2027-01-14"},` +
				`"Entitlements":[{},{"ServiceLevelDescription":"HP 3y NBD","EndDate":"2027-01-14"}]}`,
			wantEnd:    "2027-01-14",
			wantEntLen: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info, err := parseHpWarrantyWMI([]byte(tt.raw))
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseHpWarrantyWMI() error = nil, want %s", tt.wantReason)
				}
				var hpErr *HpCollectError
				if !errorsAs(err, &hpErr) {
					t.Fatalf("error is %T, want *HpCollectError", err)
				}
				if hpErr.Reason != tt.wantReason {
					t.Fatalf("Reason = %q, want %q", hpErr.Reason, tt.wantReason)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseHpWarrantyWMI() error = %v, want nil", err)
			}
			if info.CoverageEndDate != tt.wantEnd {
				t.Errorf("CoverageEndDate = %q, want %q", info.CoverageEndDate, tt.wantEnd)
			}
			if len(info.Entitlements) != tt.wantEntLen {
				t.Errorf("len(Entitlements) = %d, want %d", len(info.Entitlements), tt.wantEntLen)
			}
			if tt.wantCacheAt == "" {
				if !info.HPCacheTime.IsZero() {
					t.Errorf("HPCacheTime = %v, want zero", info.HPCacheTime)
				}
			} else {
				want, perr := time.Parse(time.RFC3339, tt.wantCacheAt)
				if perr != nil {
					t.Fatalf("bad want in table: %v", perr)
				}
				if !info.HPCacheTime.Equal(want) {
					t.Errorf("HPCacheTime = %v, want %v", info.HPCacheTime, want)
				}
			}
		})
	}
}

func TestNormalizeHpDate(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"empty", "", ""},
		{"CIM DATETIME", "20270114000000.000000+000", "2027-01-14"},
		{"CIM DATETIME negative offset", "20270114000000.000000-420", "2027-01-14"},
		{"date only", "2027-01-14", "2027-01-14"},
		{"RFC3339", "2027-01-14T00:00:00Z", "2027-01-14"},
		{"US slash form HP sometimes emits", "01/14/2027", "2027-01-14"},
		{"dotnet date", "/Date(1799971200000)/", "2027-01-14"},
		{"unparseable is dropped, never forwarded", "sometime next year", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeHpDate(tt.in); got != tt.want {
				t.Fatalf("normalizeHpDate(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/collectors/ -run 'TestParseHpWarrantyWMI|TestNormalizeHpDate'
```
Expected: FAIL to build — `undefined: parseHpWarrantyWMI`, `undefined: normalizeHpDate`.

- [ ] **Step 4: Implement the parser**

Append to `agent/internal/collectors/hp_warranty.go`:

```go
// ---------------------------------------------------------------------------
// T0 — parsing HP's WMI output
//
// HP does not publish a stable schema for HP_Warranty / HP_Entitlements, and
// the property names below were taken from a real HP endpoint captured by the
// W01 lab probe (issue #5512), not from documentation. Each logical field
// therefore resolves through an ordered candidate list: the FIRST name present
// and non-empty wins. Adding a name HP uses on a model we have not seen is a
// one-line change to exactly one var — no parsing code changes.
// ---------------------------------------------------------------------------

var (
	hpSerialFields        = []string{"SerialNumber", "Serial", "SystemSerialNumber"}
	hpProductNumberFields = []string{"ProductNumber", "SKU", "ProductSKU", "SystemSKU"}
	hpCoverageStartFields = []string{"WarrantyStartDate", "StartDate", "CoverageStartDate", "PurchaseDate", "ShipDate"}
	hpCoverageEndFields   = []string{"WarrantyEndDate", "EndDate", "CoverageEndDate", "ExpirationDate"}
	hpCoverageTypeFields  = []string{"WarrantyType", "ServiceLevelDescription", "OfferDescription", "CoverageType", "Description"}
	// hpCacheTimeFields resolves HP's OWN cache write time. Scheduling (D8)
	// depends entirely on this: without it every device falls back to the
	// bootstrap cadence and re-invokes CMSL far more often than HP's 30-day
	// cache justifies.
	hpCacheTimeFields = []string{"LastUpdate", "LastUpdated", "LastRefresh", "Timestamp", "CacheDate", "RetrievedDate", "QueryDate"}

	hpEntDescFields  = []string{"ServiceLevelDescription", "Description", "ServiceLevel", "OfferDescription"}
	hpEntTypeFields  = []string{"OfferDescription", "EntitlementType", "Type", "ServiceType", "OfferType"}
	hpEntStartFields = []string{"StartDate", "ServiceStartDate", "CoverageStartDate"}
	hpEntEndFields   = []string{"EndDate", "ServiceEndDate", "CoverageEndDate", "ExpirationDate"}
)

// hpWmiEnvelope is the shape the T0 PowerShell script emits (Task 3). The
// Warranty and Entitlements members are decoded as raw property bags because
// their property names are HP's, not ours.
type hpWmiEnvelope struct {
	NamespacePresent bool               `json:"NamespacePresent"`
	Error            string             `json:"Error"`
	Warranty         map[string]any     `json:"Warranty"`
	Entitlements     hpEntitlementRows  `json:"Entitlements"`
}

// hpEntitlementRows tolerates both shapes Windows can emit for a class that
// returned one instance. Windows PowerShell 5.1 — the default shell on
// essentially every managed endpoint — collapses a single-element array to a
// bare object during ConvertTo-Json, so a device with exactly one entitlement
// (very common) emits an object where a multi-entitlement device emits an
// array. Decoding straight into a slice would fail on those hosts and, because
// a parse error is fatal here, would drop the ENTIRE warranty record. This is
// the same trap gpuNameList guards in hardware_wmi_parse.go.
type hpEntitlementRows []map[string]any

func (r *hpEntitlementRows) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		*r = nil
		return nil
	}
	if trimmed[0] == '[' {
		var rows []map[string]any
		if err := json.Unmarshal(trimmed, &rows); err != nil {
			return err
		}
		*r = rows
		return nil
	}
	var one map[string]any
	if err := json.Unmarshal(trimmed, &one); err != nil {
		return err
	}
	*r = hpEntitlementRows{one}
	return nil
}

// parseHpWarrantyWMI decodes the T0 script's envelope into an HpWarrantyInfo.
// A missing namespace is T2 (CMSL not installed) and is returned as a typed
// error rather than an empty struct, so the caller can tell "HP is not managed
// here" from "HP is managed and has nothing to say".
func parseHpWarrantyWMI(raw []byte) (*HpWarrantyInfo, error) {
	var env hpWmiEnvelope
	if err := json.Unmarshal(bytes.TrimSpace(raw), &env); err != nil {
		return nil, &HpCollectError{
			Reason: HpReasonParseFailed,
			Detail: truncateHpString(err.Error()),
		}
	}

	if !env.NamespacePresent {
		switch env.Error {
		case hpErrPowerShellTooOld:
			return nil, &HpCollectError{Reason: HpReasonPowerShellTooOld, Detail: "PowerShell 5.1 or newer is required by HP CMSL"}
		case hpErrCimUnavailable:
			return nil, &HpCollectError{Reason: HpReasonPowerShellFailed, Detail: "Get-CimInstance is unavailable on this host"}
		default:
			return nil, &HpCollectError{Reason: HpReasonNamespaceAbsent, Detail: truncateHpString(env.Error)}
		}
	}
	if len(env.Warranty) == 0 {
		return nil, &HpCollectError{Reason: HpReasonNoWarrantyRow, Detail: truncateHpString(env.Error)}
	}

	info := &HpWarrantyInfo{
		SerialNumber:      pickHpString(env.Warranty, hpSerialFields...),
		ProductNumber:     pickHpString(env.Warranty, hpProductNumberFields...),
		CoverageStartDate: normalizeHpDate(pickHpString(env.Warranty, hpCoverageStartFields...)),
		CoverageEndDate:   normalizeHpDate(pickHpString(env.Warranty, hpCoverageEndFields...)),
		CoverageType:      pickHpString(env.Warranty, hpCoverageTypeFields...),
		HPCacheTime:       parseHpTimestamp(pickHpString(env.Warranty, hpCacheTimeFields...)),
		Tier:              HpTierT0,
		Reason:            HpReasonOK,
	}

	for _, row := range env.Entitlements {
		ent := HpEntitlement{
			ServiceLevelDescription: pickHpString(row, hpEntDescFields...),
			EntitlementType:         pickHpString(row, hpEntTypeFields...),
			StartDate:               normalizeHpDate(pickHpString(row, hpEntStartFields...)),
			EndDate:                 normalizeHpDate(pickHpString(row, hpEntEndFields...)),
		}
		// A row with nothing usable is HP metadata noise, not an entitlement.
		// Forwarding it would push a blank row into device_warranty.entitlements
		// and show as an empty line in the device UI.
		if ent.ServiceLevelDescription == "" && ent.EntitlementType == "" && ent.EndDate == "" {
			continue
		}
		info.Entitlements = append(info.Entitlements, ent)
	}

	return info, nil
}

// pickHpString returns the first non-empty string value among names. Numeric
// and boolean WMI values are stringified rather than dropped — HP emits some
// dates as JSON numbers on older CMSL builds.
func pickHpString(m map[string]any, names ...string) string {
	for _, name := range names {
		v, ok := m[name]
		if !ok || v == nil {
			continue
		}
		var s string
		switch typed := v.(type) {
		case string:
			s = typed
		case float64:
			s = strconv.FormatFloat(typed, 'f', -1, 64)
		case bool:
			s = strconv.FormatBool(typed)
		default:
			continue
		}
		if s = strings.TrimSpace(s); s != "" {
			return s
		}
	}
	return ""
}

// hpDotNetDateRe matches the JavaScriptSerializer form ConvertTo-Json emits for
// [datetime] on Windows PowerShell 5.1: /Date(1799971200000)/, optionally with
// a trailing offset such as /Date(1799971200000+0000)/.
var hpDotNetDateRe = regexp.MustCompile(`^/Date\((-?\d+)(?:[+-]\d{4})?\)/$`)

// hpDateLayouts are tried in order for a plain string date. The CIM DATETIME
// layout ("20270114000000.000000+000") is first because it is what a raw WMI
// property carries when ConvertTo-Json does not coerce it.
var hpDateLayouts = []string{
	"20060102150405.000000-070",
	"20060102150405.000000+070",
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
	"01/02/2006",
	"1/2/2006",
}

// parseHpTimestamp resolves an HP-supplied timestamp to a time.Time in UTC,
// returning the zero time when it cannot be parsed. Callers MUST treat a zero
// return as "unknown" and never as "epoch" — hpCacheStale depends on that
// distinction to decide whether a refresh is warranted.
func parseHpTimestamp(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	if m := hpDotNetDateRe.FindStringSubmatch(value); m != nil {
		ms, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			return time.Time{}
		}
		return time.UnixMilli(ms).UTC()
	}
	for _, layout := range hpDateLayouts {
		if t, err := time.Parse(layout, value); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

// normalizeHpDate renders an HP date as YYYY-MM-DD, or "" when it cannot be
// parsed. Dropping an unparseable date is deliberate: agentWarrantyInfoSchema's
// warrantyDateSchema (schemas.ts:649-656) would coerce it to undefined anyway,
// and forwarding garbage risks tripping the .max(50) bound and 400-ing the
// whole report.
func normalizeHpDate(value string) string {
	t := parseHpTimestamp(value)
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02")
}

// truncateHpString bounds a diagnostic string to the same 200-char limit D10
// applies to reported fields, so a runaway PowerShell error can never inflate a
// log line or a payload field.
func truncateHpString(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= hpFieldMaxLen {
		return value
	}
	return strings.TrimSpace(value[:hpFieldMaxLen])
}
```

Extend the import block of `hp_warranty.go` to:

```go
import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)
```

and add the two script-sentinel constants plus the field bound near the top of the file (they are referenced above and fleshed out in Tasks 3 and 5):

```go
const (
	// hpErrPowerShellTooOld / hpErrCimUnavailable are sentinels the T0 script
	// writes into the envelope's Error field so the Go side can tell a genuine
	// prerequisite failure from an absent namespace. Both mean "cannot collect",
	// but only one of them is fixable by installing CMSL.
	hpErrPowerShellTooOld = "powershell-below-5-1"
	hpErrCimUnavailable   = "get-ciminstance-unavailable"

	// hpFieldMaxLen is D10's per-field bound: at most 200 characters.
	hpFieldMaxLen = 200
)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd agent && go test -race ./internal/collectors/ -run 'TestParseHpWarrantyWMI|TestNormalizeHpDate' -v
```
Expected: PASS, including `TestParseHpWarrantyWMI_RealProbeFixture`. **If the fixture subtest reports "did not resolve", add the real property name to the named var it points at and re-run — do not weaken the assertion.**

- [ ] **Step 6: Commit**

```bash
git add agent/internal/collectors/hp_warranty.go agent/internal/collectors/hp_warranty_test.go agent/internal/collectors/testdata/hp_warranty_wmi_real.json
git commit -m "feat(agent): parse HP_Warranty/HP_Entitlements WMI output from the W01 probe capture (W03)"
```

---

## Task 3: T0 — the mockable PowerShell seam and the WMI read

**Files:**
- Modify: `agent/internal/collectors/hp_warranty.go`
- Test: `agent/internal/collectors/hp_warranty_test.go`

**Interfaces:**
- Produces: `hpRunPowerShell` (package-level func var seam), `hpT0Script` (const), `readHpWarrantyWMI() (*HpWarrantyInfo, error)`, `hpWmiTimeout` / `hpRefreshTimeout` (consts).
- Consumes: `parseHpWarrantyWMI`, `HpCollectError`, `HpReason*` (Task 2); `runCollectorOutput`, `utf8PowerShellCommand` (`command_limits.go:34,30`).

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/collectors/hp_warranty_test.go`:

```go
// stubHpPowerShell installs a fake for the single PowerShell seam and returns a
// pointer to the recorded scripts. Every test in this file uses it; NO test in
// this wave ever spawns a real process, which is what lets the suite run on the
// darwin/linux CI runner (Global Constraints).
func stubHpPowerShell(t *testing.T, fn func(script string) ([]byte, error)) *[]string {
	t.Helper()
	original := hpRunPowerShell
	t.Cleanup(func() { hpRunPowerShell = original })
	var seen []string
	hpRunPowerShell = func(_ time.Duration, script string) ([]byte, error) {
		seen = append(seen, script)
		return fn(script)
	}
	return &seen
}

func TestReadHpWarrantyWMI_UsesTheSeamAndParsesTheEnvelope(t *testing.T) {
	seen := stubHpPowerShell(t, func(string) ([]byte, error) {
		return []byte(`{"NamespacePresent":true,"Error":"","Warranty":{"SerialNumber":"5CD1","EndDate":"2027-01-14","LastUpdate":"2026-08-20T11:30:00Z"},"Entitlements":[]}`), nil
	})

	info, err := readHpWarrantyWMI()
	if err != nil {
		t.Fatalf("readHpWarrantyWMI() error = %v, want nil", err)
	}
	if info.SerialNumber != "5CD1" || info.CoverageEndDate != "2027-01-14" {
		t.Fatalf("unexpected info: %#v", info)
	}
	if len(*seen) != 1 {
		t.Fatalf("PowerShell invocations = %d, want exactly 1 (T0 must be a single spawn)", len(*seen))
	}
	script := (*seen)[0]
	for _, want := range []string{
		"root/HP/InstrumentedServices/v1",
		"HP_Warranty",
		"HP_Entitlements",
		"ConvertTo-Json",
		"NamespacePresent",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("T0 script is missing %q", want)
		}
	}
	if strings.Contains(script, "Get-HPWarrantyInfo") {
		t.Error("T0 must not invoke Get-HPWarrantyInfo — that is T1, and doing it here defeats the whole point of the tiering")
	}
}

func TestReadHpWarrantyWMI_PowerShellFailureIsReportedNotSwallowed(t *testing.T) {
	stubHpPowerShell(t, func(string) ([]byte, error) {
		return nil, errors.New("powershell timed out: context deadline exceeded")
	})

	_, err := readHpWarrantyWMI()
	if err == nil {
		t.Fatal("readHpWarrantyWMI() error = nil, want a reported failure — the spec requires reporting WHY collection failed")
	}
	var hpErr *HpCollectError
	if !errorsAs(err, &hpErr) {
		t.Fatalf("error is %T, want *HpCollectError", err)
	}
	if hpErr.Reason != HpReasonPowerShellFailed {
		t.Fatalf("Reason = %q, want %q", hpErr.Reason, HpReasonPowerShellFailed)
	}
	if !strings.Contains(hpErr.Detail, "timed out") {
		t.Fatalf("Detail = %q, want the underlying message preserved", hpErr.Detail)
	}
}

func TestReadHpWarrantyWMI_PartialOutputWithAnErrorStillParses(t *testing.T) {
	// runCollectorOutput returns (output, err) together for a non-zero exit.
	// PowerShell writes our JSON to stdout and then exits non-zero because
	// $ErrorActionPreference tripped on an unrelated statement; the envelope is
	// still complete and must be used rather than discarded.
	stubHpPowerShell(t, func(string) ([]byte, error) {
		return []byte(`{"NamespacePresent":true,"Error":"","Warranty":{"SerialNumber":"5CD1","EndDate":"2027-01-14"},"Entitlements":[]}`),
			errors.New("exit status 1")
	})

	info, err := readHpWarrantyWMI()
	if err != nil {
		t.Fatalf("readHpWarrantyWMI() error = %v, want nil when a complete envelope was captured", err)
	}
	if info.SerialNumber != "5CD1" {
		t.Fatalf("unexpected info: %#v", info)
	}
}
```

Extend that test file's imports to:

```go
import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/collectors/ -run 'TestReadHpWarrantyWMI'
```
Expected: FAIL to build — `undefined: hpRunPowerShell`, `undefined: readHpWarrantyWMI`.

- [ ] **Step 3: Implement the seam, the script and the read**

Append to `agent/internal/collectors/hp_warranty.go`:

```go
// ---------------------------------------------------------------------------
// The PowerShell seam
//
// The agent has NO Go WMI binding: yusufpapurcu/wmi is an indirect dependency
// (agent/go.mod:112) imported by zero agent files, and go-ole (go.mod:18)
// drives only the Windows Update Agent COM API and VSS. Every WMI read in the
// agent today goes through PowerShell Get-CimInstance, and this one does too —
// see hardware_windows.go:82-121 for the canonical batched precedent. Promoting
// wmi to a direct dependency was considered and rejected (contract D7).
//
// hpRunPowerShell is a package-level var, declared in this BUILD-TAG-FREE file,
// so a darwin/linux test can replace it. That placement is the entire reason
// this wave's tier logic is testable on CI: a seam inside hp_warranty_windows.go
// would be invisible to every runner we actually have.
// ---------------------------------------------------------------------------

var hpRunPowerShell = func(timeout time.Duration, script string) ([]byte, error) {
	return runCollectorOutput(timeout, "powershell", "-NoProfile", "-NonInteractive", "-Command", utf8PowerShellCommand(script))
}

const (
	// hpWmiTimeout bounds the T0 read. Slightly above hardware_windows.go's
	// wmicTimeout (15s) because opening a vendor namespace on a cold WMI
	// repository is measurably slower than the Win32_* classes.
	hpWmiTimeout = 20 * time.Second
	// hpRefreshTimeout bounds the T1 refresh. Get-HPWarrantyInfo makes a real
	// network round trip to HP and is documented as slow on first use; five
	// minutes is generous but still bounded, and the call happens at most once
	// per HP cache lifetime (~30 days).
	hpRefreshTimeout = 5 * time.Minute
)

// hpT0Script reads HP's warranty namespace with no network I/O, no CMSL
// invocation and no 30-day-cache write. It emits one JSON envelope on stdout so
// the Go side never has to parse PowerShell's human-readable output.
//
// Structure notes:
//   - The PS 5.1 floor is checked first and reported as its own sentinel: HP
//     CMSL requires 5.1+, and "your PowerShell is too old" is a completely
//     different remediation from "CMSL is not installed" (spec Risks).
//   - Get-CimInstance availability is checked the same way, mirroring
//     hardware_windows.go's Get-WmiSafe guard.
//   - The namespace probe is a separate try/catch from the data read so an
//     "Invalid namespace" (T2 — no CMSL) is distinguishable from a namespace
//     that exists but has no rows yet.
//   - Cim*/PS* properties are excluded: they are CIM plumbing, they are large,
//     and none of them is a warranty field.
const hpT0Script = `
$ErrorActionPreference = 'SilentlyContinue'
$ns = 'root/HP/InstrumentedServices/v1'
$nsPresent = $false
$err = ''
$warranty = $null
$entitlements = @()
$v = $PSVersionTable.PSVersion
if ($v.Major -lt 5 -or ($v.Major -eq 5 -and $v.Minor -lt 1)) {
  $err = 'powershell-below-5-1'
} elseif (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) {
  $err = 'get-ciminstance-unavailable'
} else {
  try {
    $probe = @(Get-CimInstance -Namespace $ns -ClassName HP_Warranty -ErrorAction Stop)
    $nsPresent = $true
    $warranty = $probe | Select-Object -First 1 | Select-Object -Property * -ExcludeProperty Cim*, PS*
    $entitlements = @(Get-CimInstance -Namespace $ns -ClassName HP_Entitlements -ErrorAction SilentlyContinue |
      Select-Object -Property * -ExcludeProperty Cim*, PS*)
  } catch {
    $err = ([string]$_.Exception.Message).Trim()
  }
}
[PSCustomObject]@{
  NamespacePresent = $nsPresent
  Error            = $err
  Warranty         = $warranty
  Entitlements     = $entitlements
} | ConvertTo-Json -Depth 5 -Compress
`

// readHpWarrantyWMI performs the T0 read: one PowerShell spawn, no network, no
// CMSL invocation, no write to HP's 30-day cache.
//
// A non-zero exit that still produced a complete envelope is NOT treated as a
// failure. runCollectorOutput returns (output, err) together, and PowerShell
// exits non-zero for conditions our envelope already describes; discarding a
// good payload because of the exit code would turn a working device into a
// permanently unknown one.
func readHpWarrantyWMI() (*HpWarrantyInfo, error) {
	out, runErr := hpRunPowerShell(hpWmiTimeout, hpT0Script)
	if len(bytes.TrimSpace(out)) == 0 {
		detail := "powershell produced no output"
		if runErr != nil {
			detail = runErr.Error()
		}
		return nil, &HpCollectError{Reason: HpReasonPowerShellFailed, Detail: truncateHpString(detail)}
	}
	info, err := parseHpWarrantyWMI(out)
	if err != nil {
		// A run error alongside unparseable output is the more informative of
		// the two; surface it rather than the JSON syntax complaint.
		if runErr != nil {
			var hpErr *HpCollectError
			if errorsAs(err, &hpErr) && hpErr.Reason == HpReasonParseFailed {
				return nil, &HpCollectError{Reason: HpReasonPowerShellFailed, Detail: truncateHpString(runErr.Error())}
			}
		}
		return nil, err
	}
	return info, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && go test -race ./internal/collectors/ -run 'TestReadHpWarrantyWMI' -v
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/collectors/hp_warranty.go agent/internal/collectors/hp_warranty_test.go
git commit -m "feat(agent): T0 HP WMI read through a mockable PowerShell seam (W03)"
```

---

## Task 4: T1 — the CMSL refresh and 429 classification

**Files:**
- Modify: `agent/internal/collectors/hp_warranty.go`
- Test: `agent/internal/collectors/hp_warranty_test.go`

**Interfaces:**
- Produces: `hpT1Script` (const), `refreshHpWarranty() error`, `classifyHpRefreshOutput(out []byte, runErr error) error`, `hpLooksRateLimited(string) bool`, the `hpSentinel*` consts.
- Consumes: `hpRunPowerShell`, `hpRefreshTimeout` (Task 3); `HpCollectError`, `HpReason*` (Tasks 1–2).

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/collectors/hp_warranty_test.go`:

```go
func TestHpLooksRateLimited(t *testing.T) {
	tests := []struct {
		name string
		msg  string
		want bool
	}{
		{"bare 429 status", "The remote server returned an error: (429) Too Many Requests.", true},
		{"429 alone as a word", "HTTP 429", true},
		{"phrase without the number", "Request throttled, please try again later", true},
		{"hyphenated rate-limit", "rate-limit exceeded for this source address", true},
		{"spaced rate limit", "Rate Limit Exceeded", true},
		{"a serial number that merely contains 429 is NOT a rate limit", "Serial 5CD429ABCD not found", false},
		{"a 4290 status code is not 429", "returned status 4290", false},
		{"ordinary failure", "The term 'Get-HPWarrantyInfo' is not recognized", false},
		{"empty", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hpLooksRateLimited(tt.msg); got != tt.want {
				t.Fatalf("hpLooksRateLimited(%q) = %v, want %v", tt.msg, got, tt.want)
			}
		})
	}
}

func TestClassifyHpRefreshOutput(t *testing.T) {
	tests := []struct {
		name       string
		out        string
		runErr     error
		wantReason string // "" = success
	}{
		{name: "success sentinel", out: "BREEZE_HP_REFRESH_OK", wantReason: ""},
		{name: "success sentinel with surrounding noise", out: "VERBOSE: contacting HP\r\nBREEZE_HP_REFRESH_OK\r\n", wantReason: ""},
		{name: "cmsl absent", out: "BREEZE_HP_CMSL_ABSENT", wantReason: HpReasonCmslCmdletAbsent},
		{name: "powershell too old", out: "BREEZE_HP_PS_TOO_OLD", wantReason: HpReasonPowerShellTooOld},
		{
			name:       "hp refused with 429",
			out:        "BREEZE_HP_REFRESH_ERROR: The remote server returned an error: (429) Too Many Requests.",
			wantReason: HpReasonRateLimited,
		},
		{
			name:       "ordinary cmsl error",
			out:        "BREEZE_HP_REFRESH_ERROR: Unable to resolve warrantyapi.hp.com",
			wantReason: HpReasonRefreshFailed,
		},
		{
			name:       "no sentinel at all is a powershell failure, never a silent success",
			out:        "",
			runErr:     errors.New("powershell timed out: context deadline exceeded"),
			wantReason: HpReasonPowerShellFailed,
		},
		{
			name:       "output with no recognised sentinel is a refresh failure, not a pass",
			out:        "Get-HPWarrantyInfo : Access denied",
			wantReason: HpReasonRefreshFailed,
		},
		{
			name:       "a rate limit surfaced through the run error rather than the sentinel",
			out:        "",
			runErr:     errors.New("exit status 1 (stderr: HTTP 429 Too Many Requests)"),
			wantReason: HpReasonRateLimited,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := classifyHpRefreshOutput([]byte(tt.out), tt.runErr)
			if tt.wantReason == "" {
				if err != nil {
					t.Fatalf("classifyHpRefreshOutput() = %v, want nil", err)
				}
				return
			}
			var hpErr *HpCollectError
			if !errorsAs(err, &hpErr) {
				t.Fatalf("error is %T (%v), want *HpCollectError", err, err)
			}
			if hpErr.Reason != tt.wantReason {
				t.Fatalf("Reason = %q, want %q", hpErr.Reason, tt.wantReason)
			}
			if tt.wantReason == HpReasonRateLimited && !IsHpRateLimited(err) {
				t.Fatal("IsHpRateLimited() = false for a 429 — the scheduler would retry straight back into HP's per-NAT limit")
			}
		})
	}
}

func TestRefreshHpWarranty_ScriptShape(t *testing.T) {
	seen := stubHpPowerShell(t, func(string) ([]byte, error) {
		return []byte("BREEZE_HP_REFRESH_OK"), nil
	})
	if err := refreshHpWarranty(); err != nil {
		t.Fatalf("refreshHpWarranty() = %v, want nil", err)
	}
	if len(*seen) != 1 {
		t.Fatalf("PowerShell invocations = %d, want 1", len(*seen))
	}
	script := (*seen)[0]
	for _, want := range []string{"Get-HPWarrantyInfo", "Tls12", "BREEZE_HP_REFRESH_OK", "BREEZE_HP_CMSL_ABSENT"} {
		if !strings.Contains(script, want) {
			t.Errorf("T1 script is missing %q", want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/collectors/ -run 'TestHpLooksRateLimited|TestClassifyHpRefreshOutput|TestRefreshHpWarranty'
```
Expected: FAIL to build — `undefined: hpLooksRateLimited`, `undefined: classifyHpRefreshOutput`, `undefined: refreshHpWarranty`.

- [ ] **Step 3: Implement T1**

Append to `agent/internal/collectors/hp_warranty.go`:

```go
// ---------------------------------------------------------------------------
// T1 — refreshing HP's own cache
//
// Get-HPWarrantyInfo takes no parameters, runs against the local device, writes
// its results into the WMI classes T0 reads, and self-caches for 30 days. It is
// invoked ONLY when hpCacheStale says HP's own cache has genuinely lapsed —
// calling it inside the 30-day window returns cached data, refreshes nothing,
// and still consumes one of the 300-requests-per-5-minutes-per-SOURCE-IP budget
// the customer's whole NAT shares.
// ---------------------------------------------------------------------------

const (
	hpSentinelRefreshOK  = "BREEZE_HP_REFRESH_OK"
	hpSentinelCmslAbsent = "BREEZE_HP_CMSL_ABSENT"
	hpSentinelPSTooOld   = "BREEZE_HP_PS_TOO_OLD"
	hpSentinelRefreshErr = "BREEZE_HP_REFRESH_ERROR:"
)

// hpT1Script invokes the CMSL refresh. It communicates through sentinel tokens
// on stdout rather than exit codes, because PowerShell's exit status is not a
// reliable channel here: $ErrorActionPreference, module autoload noise and
// WDAC/AppLocker denials all produce exit codes that mean different things on
// different hosts, whereas a sentinel is unambiguous.
//
// TLS 1.2 is forced because CMSL's HP endpoints require it and older Windows
// builds still default to TLS 1.0 — one of the two prerequisites the spec's
// Risks section names. The -bor keeps any protocol the host already enabled.
const hpT1Script = `
$ErrorActionPreference = 'SilentlyContinue'
$v = $PSVersionTable.PSVersion
if ($v.Major -lt 5 -or ($v.Major -eq 5 -and $v.Minor -lt 1)) {
  Write-Output 'BREEZE_HP_PS_TOO_OLD'
  exit 0
}
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}
Import-Module HPCMSL -ErrorAction SilentlyContinue | Out-Null
if (-not (Get-Command Get-HPWarrantyInfo -ErrorAction SilentlyContinue)) {
  Write-Output 'BREEZE_HP_CMSL_ABSENT'
  exit 0
}
try {
  $null = Get-HPWarrantyInfo -ErrorAction Stop
  Write-Output 'BREEZE_HP_REFRESH_OK'
} catch {
  Write-Output ('BREEZE_HP_REFRESH_ERROR: ' + ([string]$_.Exception.Message).Trim())
}
exit 0
`

// hpRateLimitRe matches HP's rate-limit refusals. \b429\b is deliberately
// word-bounded: an unbounded "429" match would classify a serial number or a
// 4290 status as a rate limit and idle the device for hours for no reason.
var hpRateLimitRe = regexp.MustCompile(`(?i)\b429\b|too many requests|rate[ _-]?limit|throttl`)

// hpLooksRateLimited reports whether msg describes HP refusing for rate-limit
// reasons. HP's limit is 300 requests / 5 minutes per SOURCE IP — a
// per-customer-NAT budget, not a per-device one — so a true here must make the
// caller wait hours, not seconds.
func hpLooksRateLimited(msg string) bool {
	return hpRateLimitRe.MatchString(msg)
}

// classifyHpRefreshOutput turns the T1 script's stdout (plus any run error)
// into nil for success or a typed *HpCollectError. Unrecognised output is a
// refresh FAILURE, never an assumed success: treating "I don't understand this"
// as "it worked" would advance the schedule 30 days on a device that collected
// nothing.
func classifyHpRefreshOutput(out []byte, runErr error) error {
	text := strings.TrimSpace(string(out))

	switch {
	case strings.Contains(text, hpSentinelRefreshOK):
		return nil
	case strings.Contains(text, hpSentinelPSTooOld):
		return &HpCollectError{Reason: HpReasonPowerShellTooOld, Detail: "PowerShell 5.1 or newer is required by HP CMSL"}
	case strings.Contains(text, hpSentinelCmslAbsent):
		return &HpCollectError{Reason: HpReasonCmslCmdletAbsent, Detail: "Get-HPWarrantyInfo is not available; HP CMSL is not installed"}
	}

	detail := text
	if idx := strings.Index(text, hpSentinelRefreshErr); idx >= 0 {
		detail = strings.TrimSpace(text[idx+len(hpSentinelRefreshErr):])
	}
	if runErr != nil {
		if detail == "" {
			detail = runErr.Error()
		} else {
			detail = detail + " (" + runErr.Error() + ")"
		}
	}
	if hpLooksRateLimited(detail) {
		return &HpCollectError{Reason: HpReasonRateLimited, Detail: truncateHpString(detail)}
	}
	if text == "" && runErr != nil {
		return &HpCollectError{Reason: HpReasonPowerShellFailed, Detail: truncateHpString(runErr.Error())}
	}
	if detail == "" {
		detail = "Get-HPWarrantyInfo produced no recognised result"
	}
	return &HpCollectError{Reason: HpReasonRefreshFailed, Detail: truncateHpString(detail)}
}

// refreshHpWarranty runs T1 and reports whether HP's cache was refreshed.
func refreshHpWarranty() error {
	out, runErr := hpRunPowerShell(hpRefreshTimeout, hpT1Script)
	return classifyHpRefreshOutput(out, runErr)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && go test -race ./internal/collectors/ -run 'TestHpLooksRateLimited|TestClassifyHpRefreshOutput|TestRefreshHpWarranty' -v
```
Expected: PASS.

- [ ] **Step 5: Reconcile the 429 matcher against the probe capture**

Open the W01 probe record on issue #5512 and find the text HP produced for any refused/failed `Get-HPWarrantyInfo` call. If HP's wording is not matched by `hpRateLimitRe`, add the literal to the regex alternation **and add a table row for it in `TestHpLooksRateLimited`**. If W01 never triggered a refusal, note in the PR that the matcher is validated against HP's documented `429` status only.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/collectors/hp_warranty.go agent/internal/collectors/hp_warranty_test.go
git commit -m "feat(agent): T1 CMSL refresh with sentinel-based classification and 429 detection (W03)"
```

---

## Task 5: Tier selection — T0 / T1 / T2

**Files:**
- Modify: `agent/internal/collectors/hp_warranty.go`
- Test: `agent/internal/collectors/hp_warranty_test.go`

**Interfaces:**
- Produces: `hpCacheStale(cacheTime, now time.Time) bool`, `hpCacheTTL` / `hpRefreshMargin` (consts), and the real `collectHpWarrantyTiered(now time.Time) (*HpWarrantyInfo, error)` (replacing Task 1's placeholder).
- Consumes: `readHpWarrantyWMI` (Task 3), `refreshHpWarranty` (Task 4), `HpTier*` / `HpReason*` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/collectors/hp_warranty_test.go`:

```go
func TestHpCacheStale(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name  string
		cache time.Time
		want  bool
	}{
		{"unknown cache time is stale (we cannot prove it is fresh)", time.Time{}, true},
		{"written today", now.Add(-2 * time.Hour), false},
		{"day 25 — HP would return cached data and refresh nothing", now.Add(-25 * 24 * time.Hour), false},
		{"day 30 exactly — still inside HP's own TTL", now.Add(-30 * 24 * time.Hour), false},
		{"day 30 + 6h — inside the clock-skew margin", now.Add(-30*24*time.Hour - 6*time.Hour), false},
		{"day 30 + 13h — margin elapsed, refresh is worth a network call", now.Add(-30*24*time.Hour - 13*time.Hour), true},
		{"day 90", now.Add(-90 * 24 * time.Hour), true},
		{"a cache time in the future (clock skew) is not stale", now.Add(48 * time.Hour), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hpCacheStale(tt.cache, now); got != tt.want {
				t.Fatalf("hpCacheStale(%v, %v) = %v, want %v", tt.cache, now, got, tt.want)
			}
		})
	}
}

func TestCollectHpWarrantyTiered(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	fresh := now.Add(-3 * 24 * time.Hour).Format(time.RFC3339)
	stale := now.Add(-45 * 24 * time.Hour).Format(time.RFC3339)

	envelope := func(lastUpdate string) string {
		return `{"NamespacePresent":true,"Error":"","Warranty":{"SerialNumber":"5CD1","WarrantyEndDate":"2027-01-14","LastUpdate":"` +
			lastUpdate + `"},"Entitlements":[{"ServiceLevelDescription":"HP 3y NBD","EndDate":"2027-01-14"}]}`
	}

	tests := []struct {
		name string
		// responses is consumed in order, one per PowerShell spawn.
		responses  []struct {
			out string
			err error
		}
		wantTier      string
		wantReason    string
		wantErrReason string // "" = expect no error
		wantSpawns    int
		wantRateLimit bool
	}{
		{
			name: "T0 — fresh HP cache, no refresh, exactly one spawn",
			responses: []struct {
				out string
				err error
			}{{out: envelope(fresh)}},
			wantTier:   HpTierT0,
			wantReason: HpReasonOK,
			wantSpawns: 1,
		},
		{
			name: "T1 — stale HP cache refreshes then re-reads WMI",
			responses: []struct {
				out string
				err error
			}{
				{out: envelope(stale)},
				{out: hpSentinelRefreshOK},
				{out: envelope(now.Format(time.RFC3339))},
			},
			wantTier:   HpTierT1,
			wantReason: HpReasonOK,
			wantSpawns: 3,
		},
		{
			name: "T2 — namespace absent means CMSL is not installed; report nothing and let the policy install it",
			responses: []struct {
				out string
				err error
			}{{out: `{"NamespacePresent":false,"Error":"Invalid namespace","Warranty":null,"Entitlements":[]}`}},
			wantErrReason: HpReasonNamespaceAbsent,
			wantSpawns:    1,
		},
		{
			name: "namespace present but empty escalates to T1 rather than reporting nothing",
			responses: []struct {
				out string
				err error
			}{
				{out: `{"NamespacePresent":true,"Error":"","Warranty":null,"Entitlements":[]}`},
				{out: hpSentinelRefreshOK},
				{out: envelope(now.Format(time.RFC3339))},
			},
			wantTier:   HpTierT1,
			wantReason: HpReasonOK,
			wantSpawns: 3,
		},
		{
			name: "T1 refused with 429 — the stale T0 data is still served, flagged rate-limited",
			responses: []struct {
				out string
				err error
			}{
				{out: envelope(stale)},
				{out: hpSentinelRefreshErr + " The remote server returned an error: (429) Too Many Requests."},
			},
			wantTier:      HpTierT0,
			wantReason:    HpReasonRateLimited,
			wantSpawns:    2,
			wantRateLimit: true,
		},
		{
			name: "T1 failed and there was no T0 data at all — surface the refresh failure",
			responses: []struct {
				out string
				err error
			}{
				{out: `{"NamespacePresent":true,"Error":"","Warranty":null,"Entitlements":[]}`},
				{out: hpSentinelCmslAbsent},
			},
			wantErrReason: HpReasonCmslCmdletAbsent,
			wantSpawns:    2,
		},
		{
			name: "T1 succeeded but the re-read failed — the stale T0 data is still better than nothing",
			responses: []struct {
				out string
				err error
			}{
				{out: envelope(stale)},
				{out: hpSentinelRefreshOK},
				{out: "", err: errors.New("powershell timed out")},
			},
			wantTier:   HpTierT0,
			wantReason: HpReasonPowerShellFailed,
			wantSpawns: 3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			idx := 0
			original := hpRunPowerShell
			t.Cleanup(func() { hpRunPowerShell = original })
			spawns := 0
			hpRunPowerShell = func(_ time.Duration, _ string) ([]byte, error) {
				spawns++
				if idx >= len(tt.responses) {
					t.Fatalf("unexpected PowerShell spawn %d — the tier logic invoked more commands than the case allows", spawns)
				}
				r := tt.responses[idx]
				idx++
				return []byte(r.out), r.err
			}

			info, err := collectHpWarrantyTiered(now)

			if spawns != tt.wantSpawns {
				t.Errorf("PowerShell spawns = %d, want %d", spawns, tt.wantSpawns)
			}
			if tt.wantErrReason != "" {
				if err == nil {
					t.Fatalf("collectHpWarrantyTiered() error = nil, want %s", tt.wantErrReason)
				}
				var hpErr *HpCollectError
				if !errorsAs(err, &hpErr) {
					t.Fatalf("error is %T, want *HpCollectError", err)
				}
				if hpErr.Reason != tt.wantErrReason {
					t.Fatalf("Reason = %q, want %q", hpErr.Reason, tt.wantErrReason)
				}
				if info != nil {
					t.Fatalf("info = %#v, want nil alongside an error", info)
				}
				return
			}
			if err != nil {
				t.Fatalf("collectHpWarrantyTiered() error = %v, want nil", err)
			}
			if info.Tier != tt.wantTier {
				t.Errorf("Tier = %q, want %q", info.Tier, tt.wantTier)
			}
			if info.Reason != tt.wantReason {
				t.Errorf("Reason = %q, want %q", info.Reason, tt.wantReason)
			}
			if info.RateLimited != tt.wantRateLimit {
				t.Errorf("RateLimited = %v, want %v — the scheduler cannot back off from a flag it never sees", info.RateLimited, tt.wantRateLimit)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/collectors/ -run 'TestHpCacheStale|TestCollectHpWarrantyTiered'
```
Expected: `TestHpCacheStale` fails to build (`undefined: hpCacheStale`); `TestCollectHpWarrantyTiered` fails on every case because Task 1's placeholder returns `HpReasonNamespaceAbsent` with zero spawns.

- [ ] **Step 3: Implement**

In `agent/internal/collectors/hp_warranty.go`, **replace** Task 1's placeholder `collectHpWarrantyTiered` with the following, and add the two constants:

```go
const (
	// hpCacheTTL is HP's own self-cache lifetime: a Get-HPWarrantyInfo call
	// inside this window returns the stored WMI data without a network round
	// trip, so invoking early refreshes nothing and burns per-NAT budget.
	hpCacheTTL = 30 * 24 * time.Hour
	// hpRefreshMargin is added AFTER the TTL, not before it. HP's cache clock
	// and ours are not the same clock; refreshing at day 29 because our clock
	// ran fast would produce a guaranteed no-op call, which is the exact failure
	// the spec calls out ("an arbitrary day-25 invocation returns cached data
	// and refreshes nothing"). Waiting a further 12 hours guarantees HP's own
	// TTL has genuinely lapsed before we spend a request.
	hpRefreshMargin = 12 * time.Hour
)

// hpCacheStale reports whether HP's own cache has genuinely lapsed and a T1
// refresh is therefore worth a network round trip.
//
// A zero cacheTime means "unknown", which is treated as stale: we cannot prove
// the data is fresh, and the alternative — assuming freshness — would leave a
// device that never resolved a cache timestamp permanently un-refreshed.
// A cacheTime in the future (device clock behind HP's) is NOT stale: the safe
// direction under clock skew is to wait.
func hpCacheStale(cacheTime, now time.Time) bool {
	if cacheTime.IsZero() {
		return true
	}
	return now.Sub(cacheTime) > hpCacheTTL+hpRefreshMargin
}

// collectHpWarrantyTiered runs the three tiers, cheapest first.
//
//	T0 — read HP's WMI namespace. No network, no CMSL invocation, no cache write.
//	T1 — invoke Get-HPWarrantyInfo, but ONLY when T0 found no data or HP's own
//	     cache has genuinely lapsed, then re-read WMI.
//	T2 — the namespace does not exist: CMSL is not installed. Report nothing and
//	     let the software policy install it.
//
// Two deliberate "serve stale" branches exist. If T1 fails (429, network, CMSL
// gone) but T0 produced data, that data is returned with the failure recorded in
// Reason (and RateLimited when applicable) rather than discarded — month-old
// warranty dates are far more useful to an MSP than `status = 'unknown'`, which
// is the exact condition this whole feature exists to fix. The scheduler still
// sees the failure and backs off, because Reason and RateLimited travel on the
// struct.
func collectHpWarrantyTiered(now time.Time) (*HpWarrantyInfo, error) {
	info, err := readHpWarrantyWMI()
	if err != nil {
		var hpErr *HpCollectError
		// T2: the namespace is absent, so CMSL is not installed. There is
		// nothing to refresh — invoking T1 would only confirm what we know.
		if errorsAs(err, &hpErr) && hpErr.Reason == HpReasonNamespaceAbsent {
			return nil, err
		}
		// A prerequisite failure (PowerShell too old, Get-CimInstance missing)
		// is equally unfixable by a refresh.
		if errorsAs(err, &hpErr) &&
			(hpErr.Reason == HpReasonPowerShellTooOld || hpErr.Reason == HpReasonPowerShellFailed) {
			return nil, err
		}
		// Otherwise the namespace exists but held no usable warranty row — that
		// is exactly what a refresh is for. info stays nil; fall through to T1.
		info = nil
	}

	if info != nil && !hpCacheStale(info.HPCacheTime, now) {
		return info, nil
	}

	if refreshErr := refreshHpWarranty(); refreshErr != nil {
		if info == nil {
			return nil, refreshErr
		}
		var hpErr *HpCollectError
		if errorsAs(refreshErr, &hpErr) {
			info.Reason = hpErr.Reason
			info.RateLimited = hpErr.Reason == HpReasonRateLimited
		} else {
			info.Reason = HpReasonRefreshFailed
		}
		info.Tier = HpTierT0
		return info, nil
	}

	refreshed, reReadErr := readHpWarrantyWMI()
	if reReadErr != nil {
		if info == nil {
			return nil, reReadErr
		}
		var hpErr *HpCollectError
		if errorsAs(reReadErr, &hpErr) {
			info.Reason = hpErr.Reason
		} else {
			info.Reason = HpReasonParseFailed
		}
		info.Tier = HpTierT0
		return info, nil
	}

	refreshed.Tier = HpTierT1
	refreshed.Reason = HpReasonOK
	return refreshed, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && go test -race ./internal/collectors/ -run 'TestHpCacheStale|TestCollectHpWarrantyTiered' -v
```
Expected: PASS (8 + 7 subtests).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/collectors/hp_warranty.go agent/internal/collectors/hp_warranty_test.go
git commit -m "feat(agent): HP warranty tier selection keyed on HP's own cache timestamp (W03)"
```

---

## Task 6: Bound the report to D10's limits before it leaves the device

**Files:**
- Modify: `agent/internal/collectors/hp_warranty.go`
- Test: `agent/internal/collectors/hp_warranty_test.go`

**Interfaces:**
- Produces: `boundHpWarrantyInfo(*HpWarrantyInfo) *HpWarrantyInfo`, `maxHpEntitlements` (const).
- Consumes: `HpWarrantyInfo`, `HpEntitlement`, `hpFieldMaxLen` (Tasks 1–2).

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/collectors/hp_warranty_test.go`:

```go
func TestBoundHpWarrantyInfo(t *testing.T) {
	long := strings.Repeat("x", 900)

	t.Run("nil in, nil out", func(t *testing.T) {
		if got := boundHpWarrantyInfo(nil); got != nil {
			t.Fatalf("boundHpWarrantyInfo(nil) = %#v, want nil", got)
		}
	})

	t.Run("string fields are capped at 200 characters", func(t *testing.T) {
		got := boundHpWarrantyInfo(&HpWarrantyInfo{
			SerialNumber:  long,
			ProductNumber: long,
			CoverageType:  long,
			Entitlements: []HpEntitlement{{
				ServiceLevelDescription: long,
				EntitlementType:         long,
			}},
		})
		if len(got.SerialNumber) != hpFieldMaxLen {
			t.Errorf("len(SerialNumber) = %d, want %d", len(got.SerialNumber), hpFieldMaxLen)
		}
		if len(got.ProductNumber) != hpFieldMaxLen {
			t.Errorf("len(ProductNumber) = %d, want %d", len(got.ProductNumber), hpFieldMaxLen)
		}
		if len(got.CoverageType) != hpFieldMaxLen {
			t.Errorf("len(CoverageType) = %d, want %d", len(got.CoverageType), hpFieldMaxLen)
		}
		if len(got.Entitlements[0].ServiceLevelDescription) != hpFieldMaxLen {
			t.Errorf("len(ServiceLevelDescription) = %d, want %d", len(got.Entitlements[0].ServiceLevelDescription), hpFieldMaxLen)
		}
		if len(got.Entitlements[0].EntitlementType) != hpFieldMaxLen {
			t.Errorf("len(EntitlementType) = %d, want %d", len(got.Entitlements[0].EntitlementType), hpFieldMaxLen)
		}
	})

	t.Run("at most 25 entitlements survive, newest end date first", func(t *testing.T) {
		in := &HpWarrantyInfo{}
		// 40 entitlements ending on 40 consecutive days; the 25 with the latest
		// end dates must be the ones that survive.
		for i := 0; i < 40; i++ {
			in.Entitlements = append(in.Entitlements, HpEntitlement{
				ServiceLevelDescription: "ent",
				EndDate:                 time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, i).Format("2006-01-02"),
			})
		}
		got := boundHpWarrantyInfo(in)
		if len(got.Entitlements) != maxHpEntitlements {
			t.Fatalf("len(Entitlements) = %d, want %d", len(got.Entitlements), maxHpEntitlements)
		}
		if got.Entitlements[0].EndDate != "2027-02-09" {
			t.Errorf("first entitlement EndDate = %q, want the latest (2027-02-09) — dropping the longest coverage would understate the device", got.Entitlements[0].EndDate)
		}
		if got.Entitlements[maxHpEntitlements-1].EndDate != "2027-01-16" {
			t.Errorf("last retained EndDate = %q, want 2027-01-16", got.Entitlements[maxHpEntitlements-1].EndDate)
		}
	})

	t.Run("a report already inside the bounds is untouched", func(t *testing.T) {
		in := &HpWarrantyInfo{
			SerialNumber:      "5CD1",
			CoverageEndDate:   "2027-01-14",
			CoverageStartDate: "2024-01-15",
			CoverageType:      "HP 3y NBD",
			Entitlements:      []HpEntitlement{{ServiceLevelDescription: "HP 3y NBD", EndDate: "2027-01-14"}},
		}
		got := boundHpWarrantyInfo(in)
		if got.SerialNumber != "5CD1" || len(got.Entitlements) != 1 || got.Entitlements[0].EndDate != "2027-01-14" {
			t.Fatalf("unexpectedly modified: %#v", got)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/collectors/ -run TestBoundHpWarrantyInfo
```
Expected: FAIL to build — `undefined: boundHpWarrantyInfo`, `undefined: maxHpEntitlements`.

- [ ] **Step 3: Implement**

Append to `agent/internal/collectors/hp_warranty.go`:

```go
// maxHpEntitlements is D10's cap: at most 25 entitlements per report.
const maxHpEntitlements = 25

// boundHpWarrantyInfo enforces D10's bounds on the device, before anything is
// sent.
//
// This is NOT redundant with the server-side zod bounds W01 adds. A schema
// rejection is a 400 that drops the ENTIRE warranty update, not just the
// offending field — exactly the failure mode #1320 produced for Apple, where a
// single unexpected enum value silently lost every coverage record on the
// device. Clamping here means an HP box with 40 entitlements reports 25 and its
// coverage dates, instead of reporting nothing at all.
//
// When the cap bites, the entitlements with the LATEST end dates are kept: a
// device's longest-running coverage is the one an MSP renews against, and
// silently keeping whichever 25 HP happened to list first would understate it.
// Entitlements with no parseable end date sort last but are still eligible.
func boundHpWarrantyInfo(info *HpWarrantyInfo) *HpWarrantyInfo {
	if info == nil {
		return nil
	}

	info.SerialNumber = truncateHpString(info.SerialNumber)
	info.ProductNumber = truncateHpString(info.ProductNumber)
	info.CoverageType = truncateHpString(info.CoverageType)
	info.CoverageStartDate = truncateHpString(info.CoverageStartDate)
	info.CoverageEndDate = truncateHpString(info.CoverageEndDate)

	for i := range info.Entitlements {
		info.Entitlements[i].ServiceLevelDescription = truncateHpString(info.Entitlements[i].ServiceLevelDescription)
		info.Entitlements[i].EntitlementType = truncateHpString(info.Entitlements[i].EntitlementType)
		info.Entitlements[i].StartDate = truncateHpString(info.Entitlements[i].StartDate)
		info.Entitlements[i].EndDate = truncateHpString(info.Entitlements[i].EndDate)
	}

	if len(info.Entitlements) > maxHpEntitlements {
		sort.SliceStable(info.Entitlements, func(a, b int) bool {
			return info.Entitlements[a].EndDate > info.Entitlements[b].EndDate
		})
		info.Entitlements = info.Entitlements[:maxHpEntitlements]
	}

	return info
}
```

Add `"sort"` to the file's import block.

Then apply the bound at the single exit point, so nothing can bypass it. In `collectHpWarrantyTiered`, wrap **every** non-nil return of `info`/`refreshed`:

```go
	if info != nil && !hpCacheStale(info.HPCacheTime, now) {
		return boundHpWarrantyInfo(info), nil
	}
```
```go
		info.Tier = HpTierT0
		return boundHpWarrantyInfo(info), nil
	}
```
(both serve-stale branches)
```go
	refreshed.Tier = HpTierT1
	refreshed.Reason = HpReasonOK
	return boundHpWarrantyInfo(refreshed), nil
```

- [ ] **Step 4: Run the full collectors suite**

```bash
cd agent && go test -race ./internal/collectors/... && GOOS=windows GOARCH=amd64 go build ./internal/collectors/
```
Expected: PASS, Windows build clean.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/collectors/hp_warranty.go agent/internal/collectors/hp_warranty_test.go
git commit -m "feat(agent): clamp HP warranty reports to the 25-entitlement / 200-char contract bounds (W03)"
```

---

## Task 7: Persisted schedule state, deterministic jitter, and the due time

**Files:**
- Create: `agent/internal/heartbeat/hp_warranty.go`
- Create: `agent/internal/heartbeat/hp_warranty_test.go`
- Modify: `agent/internal/collectors/hp_warranty.go` (export the two cadence constants)

**Interfaces:**
- Produces: `hpWarrantyState` (struct), `hpWarrantyStateFileName` (const), `(*Heartbeat) hpWarrantyStatePath() string`, `(*Heartbeat) loadHpWarrantyState() hpWarrantyState`, `(*Heartbeat) saveHpWarrantyState(hpWarrantyState) error`, `hpJitterOffset(agentID string, window time.Duration) time.Duration`, `hpNextDueAt(cacheTime time.Time, agentID string, now time.Time) time.Time`, `hpBootstrapDueAt(agentID string, now time.Time) time.Time`, and the `hpRefreshJitterWindow` / `hpBootstrapJitterWindow` / `hpMinRecheckInterval` consts.
- Consumes: `collectors.HpCacheTTL`, `collectors.HpRefreshMargin` (exported in Step 3 below); `config.GetDataDir()` (`agent/internal/config/config.go:1059`).

### Where the persisted state lives, and why

`filepath.Join(config.GetDataDir(), "hp_warranty_state.json")`, mode 0600, written atomically (temp file + rename) — the `reliability_state.go:79-99` shape verbatim.

**This deliberately diverges from `reliabilityStatePath()`'s home-dir-first resolution** (`reliability_state.go:41-53`). That function prefers `~/.breeze`, which for a Windows service running as SYSTEM resolves to `C:\Windows\system32\config\systemprofile\.breeze`. That works, but it makes a machine-scoped schedule live in a per-account directory: change the service account (or run the agent interactively once) and the persisted due time silently disappears, the device believes it has never collected, and it re-invokes CMSL — a per-device bug that becomes a per-NAT rate-limit event when a fleet does it together. HP's 300-requests/5-minutes-per-source-IP budget is exactly the thing this state file exists to protect, so it goes in the machine-wide data dir with a temp-dir last resort. `config.GetDataDir()` is already the machine-wide location for agent data (`netcache.go:75` uses it the same way).

- [ ] **Step 1: Write the failing test**

Create `agent/internal/heartbeat/hp_warranty_test.go`:

```go
package heartbeat

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

func TestHpJitterOffset_IsDeterministic(t *testing.T) {
	const window = 24 * time.Hour
	first := hpJitterOffset("5CD1234ABC-agent-id", window)
	for i := 0; i < 100; i++ {
		if got := hpJitterOffset("5CD1234ABC-agent-id", window); got != first {
			t.Fatalf("hpJitterOffset is not deterministic: call %d = %v, first = %v", i, got, first)
		}
	}
	if first < 0 || first >= window {
		t.Fatalf("offset %v is outside [0, %v)", first, window)
	}
}

func TestHpJitterOffset_EdgeCases(t *testing.T) {
	if got := hpJitterOffset("", 24*time.Hour); got != 0 {
		t.Errorf("empty agent id offset = %v, want 0 (no id, no spread — and no panic)", got)
	}
	if got := hpJitterOffset("agent", 0); got != 0 {
		t.Errorf("zero window offset = %v, want 0", got)
	}
	if got := hpJitterOffset("agent", -time.Hour); got != 0 {
		t.Errorf("negative window offset = %v, want 0", got)
	}
}

func TestHpJitterOffset_SpreadsAFleetAcrossTheWindow(t *testing.T) {
	// The spread is STATISTICAL, not a guarantee (see the comment on
	// hpJitterOffset): a fleet returning from a shared outage re-bunches
	// because every device's persisted due time already elapsed. What this
	// test proves is the weaker, still-necessary property — that the hash
	// actually distributes rather than clumping every device into one hour.
	const (
		devices = 10000
		buckets = 24
		window  = 24 * time.Hour
	)
	counts := make([]int, buckets)
	for i := 0; i < devices; i++ {
		id := fmt.Sprintf("%08x-1111-2222-3333-%012x", i, i*2654435761)
		offset := hpJitterOffset(id, window)
		bucket := int(offset / time.Hour)
		if bucket < 0 || bucket >= buckets {
			t.Fatalf("offset %v mapped to bucket %d, outside [0,%d)", offset, bucket, buckets)
		}
		counts[bucket]++
	}
	// Uniform expectation is 416 per bucket. These bounds are ~±8 sigma, so a
	// correct hash can never trip them, while a constant or badly-biased one
	// always does. The function is deterministic, so this is not a flaky test:
	// it either passes for all time or fails for all time.
	for i, c := range counts {
		if c < 250 || c > 600 {
			t.Errorf("hour bucket %d holds %d of %d devices, want roughly %d — the jitter is not spreading the fleet", i, c, devices, devices/buckets)
		}
	}
}

func TestHpNextDueAt(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	const agentID = "agent-under-test"
	refreshJitter := hpJitterOffset(agentID, hpRefreshJitterWindow)
	bootstrapJitter := hpJitterOffset(agentID, hpBootstrapJitterWindow)
	cadence := hpCacheTTL + hpRefreshMargin

	tests := []struct {
		name  string
		cache time.Time
		want  time.Time
	}{
		{
			name:  "a cache written today is next due one HP cache lifetime after HP wrote it, plus this device's jitter",
			cache: now.Add(-2 * time.Hour),
			want:  now.Add(-2 * time.Hour).Add(cadence + refreshJitter),
		},
		{
			name:  "an unknown cache time schedules a full cadence from now, not from the epoch",
			cache: time.Time{},
			want:  now.Add(cadence + refreshJitter),
		},
		{
			name:  "a very stale cache (T1 just failed) is floored, never scheduled in the past",
			cache: now.Add(-200 * 24 * time.Hour),
			want:  now.Add(hpMinRecheckInterval + bootstrapJitter),
		},
		{
			name:  "a cache exactly at the cadence boundary is floored to the min recheck, not to now",
			cache: now.Add(-cadence),
			want:  now.Add(hpMinRecheckInterval + bootstrapJitter),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := hpNextDueAt(tt.cache, agentID, now)
			if !got.Equal(tt.want) {
				t.Fatalf("hpNextDueAt() = %v, want %v", got, tt.want)
			}
			if !got.After(now) {
				t.Fatalf("hpNextDueAt() = %v is not after now (%v) — a due time in the past is an every-tick collection loop", got, now)
			}
		})
	}
}

func TestHpBootstrapDueAt_DelaysTheFirstRunButNeverBeyondTheWindow(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 500; i++ {
		id := fmt.Sprintf("bootstrap-%d", i)
		got := hpBootstrapDueAt(id, now)
		if got.Before(now) {
			t.Fatalf("%s: bootstrap due %v is before now", id, got)
		}
		if got.After(now.Add(hpBootstrapJitterWindow)) {
			t.Fatalf("%s: bootstrap due %v is beyond the %v window — a policy rollout would take longer than a day to produce data", id, got, hpBootstrapJitterWindow)
		}
	}
}

func TestHpWarrantyState_RoundTrips(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BREEZE_DATA_DIR_OVERRIDE_FOR_TEST", "") // documents that no such override exists; see below
	h := &Heartbeat{hpWarrantyStatePathOverride: filepath.Join(dir, "hp_warranty_state.json")}

	want := hpWarrantyState{
		NextDueAt:     time.Date(2026, 10, 12, 3, 14, 0, 0, time.UTC),
		LastSuccessAt: time.Date(2026, 9, 10, 3, 14, 0, 0, time.UTC),
		LastAttemptAt: time.Date(2026, 9, 10, 3, 14, 0, 0, time.UTC),
		Failures:      2,
		RateLimitHits: 1,
		LastReason:    "hp_rate_limited",
	}
	if err := h.saveHpWarrantyState(want); err != nil {
		t.Fatalf("saveHpWarrantyState() = %v", err)
	}

	info, err := os.Stat(h.hpWarrantyStatePath())
	if err != nil {
		t.Fatalf("stat state file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("state file mode = %v, want 0600", perm)
	}

	got := h.loadHpWarrantyState()
	if !got.NextDueAt.Equal(want.NextDueAt) || got.Failures != 2 || got.RateLimitHits != 1 || got.LastReason != "hp_rate_limited" {
		t.Fatalf("round trip lost data: got %#v, want %#v", got, want)
	}
}

func TestHpWarrantyState_UnreadableOrCorruptFailsOpen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hp_warranty_state.json")
	h := &Heartbeat{hpWarrantyStatePathOverride: path}

	t.Run("absent", func(t *testing.T) {
		got := h.loadHpWarrantyState()
		if !got.NextDueAt.IsZero() || got.Failures != 0 {
			t.Fatalf("absent state = %#v, want the zero value", got)
		}
	})

	t.Run("corrupt", func(t *testing.T) {
		if err := os.WriteFile(path, []byte("{not json"), 0600); err != nil {
			t.Fatal(err)
		}
		got := h.loadHpWarrantyState()
		if !got.NextDueAt.IsZero() {
			t.Fatalf("corrupt state = %#v, want the zero value (fail open to a bootstrap run, never a permanent stall)", got)
		}
	})
}

func TestHpWarrantyStatePath_UsesTheMachineWideDataDir(t *testing.T) {
	h := &Heartbeat{}
	got := h.hpWarrantyStatePath()
	dataDir := config.GetDataDir()
	if dataDir != "" && filepath.Dir(got) != dataDir {
		t.Fatalf("hpWarrantyStatePath() = %q, want it inside the machine-wide data dir %q — a per-user path silently resets the schedule when the service account changes", got, dataDir)
	}
	if filepath.Base(got) != hpWarrantyStateFileName {
		t.Fatalf("state file name = %q, want %q", filepath.Base(got), hpWarrantyStateFileName)
	}
}
```

Delete the `t.Setenv` line above once you read this note: it exists only to make the intent explicit while reading the plan — **there is no data-dir env override in this codebase**, which is exactly why `hpWarrantyStatePathOverride` (a test-only field on `Heartbeat`, nil in production) is the seam. Do not add an env var.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'TestHpJitterOffset|TestHpNextDueAt|TestHpBootstrapDueAt|TestHpWarrantyState'
```
Expected: FAIL to build — `undefined: hpJitterOffset`, `undefined: hpNextDueAt`, `hpWarrantyStatePathOverride` is not a field of `Heartbeat`, etc.

- [ ] **Step 3: Export the two cadence constants from `collectors`**

In `agent/internal/collectors/hp_warranty.go`, immediately after the `hpCacheTTL`/`hpRefreshMargin` block added in Task 5, add:

```go
// HpCacheTTL and HpRefreshMargin are exported so the heartbeat scheduler
// computes its persisted due time from the SAME values the tier decision uses.
// Two independently maintained copies of "30 days" would drift the moment
// either side was tuned, and the symptom would be a device that wakes up,
// spawns PowerShell, learns HP's cache is still fresh, and goes back to sleep —
// on every cycle, forever, with no error anywhere.
const (
	HpCacheTTL      = hpCacheTTL
	HpRefreshMargin = hpRefreshMargin
)
```

- [ ] **Step 4: Implement the heartbeat-side state and schedule**

Create `agent/internal/heartbeat/hp_warranty.go`:

```go
package heartbeat

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
)

const hpWarrantyStateFileName = "hp_warranty_state.json"

// hpCacheTTL / hpRefreshMargin mirror the collector's tier decision through the
// exported constants, so the schedule and the tier can never disagree about how
// long HP's own cache lasts.
const (
	hpCacheTTL      = collectors.HpCacheTTL
	hpRefreshMargin = collectors.HpRefreshMargin

	// hpRefreshJitterWindow spreads a site's HP fleet across a day around its
	// natural due time.
	hpRefreshJitterWindow = 24 * time.Hour
	// hpBootstrapJitterWindow spreads the FIRST collection after the feature is
	// switched on. Without it, enabling the policy on 500 devices makes 500
	// agents reach the same gate on their next heartbeat; if HP's cache is stale
	// on all of them, that is 500 Get-HPWarrantyInfo calls from one NAT against
	// a 300-per-5-minutes budget. Six hours is 72 such windows.
	hpBootstrapJitterWindow = 6 * time.Hour
	// hpMinRecheckInterval floors the schedule. A device whose refresh failed
	// still has a stale HP cache, so hpNextDueAt would otherwise compute a due
	// time in the past and re-collect on every single heartbeat tick.
	hpMinRecheckInterval = 6 * time.Hour
)

// hpWarrantyState is the collector's own persisted schedule. It exists because
// the HP collector deliberately does NOT ride the 15-minute sendInventory
// fan-out (heartbeat.go:2120-2139) the Apple collector uses: HP's data changes
// at most monthly, and copying that lifecycle without persistent state would
// relaunch PowerShell every 15 minutes for days on end (contract D8).
type hpWarrantyState struct {
	// NextDueAt is when the next collection cycle may run. Zero means "never
	// collected" and triggers the bootstrap path.
	NextDueAt time.Time `json:"nextDueAt"`
	// LastSuccessAt / LastAttemptAt are diagnostic; nothing branches on them.
	LastSuccessAt time.Time `json:"lastSuccessAt,omitempty"`
	LastAttemptAt time.Time `json:"lastAttemptAt,omitempty"`
	// Failures counts consecutive non-rate-limit failures, driving the bounded
	// retry schedule. Reset on any success.
	Failures int `json:"failures,omitempty"`
	// RateLimitHits counts consecutive HP 429s, driving a much longer back-off
	// than an ordinary failure: HP's limit is per SOURCE IP, so a 429 means the
	// customer's whole NAT is saturated and retrying soon re-creates it.
	RateLimitHits int `json:"rateLimitHits,omitempty"`
	// LastReason is the last collectors.HpReason* code, so an operator can read
	// "why is this HP device still unknown" straight off the endpoint.
	LastReason string `json:"lastReason,omitempty"`
}

// hpWarrantyStatePath resolves the machine-wide state file.
//
// Unlike reliabilityStatePath (reliability_state.go:41-53) this does NOT prefer
// ~/.breeze. The HP schedule is machine-scoped and protects a per-source-IP
// rate limit: putting it in a per-account directory means a service-account
// change silently discards it, the device believes it has never collected, and
// a fleet doing that together produces exactly the 429 storm the schedule
// exists to prevent.
func (h *Heartbeat) hpWarrantyStatePath() string {
	if h.hpWarrantyStatePathOverride != "" {
		return h.hpWarrantyStatePathOverride
	}
	dataDir := strings.TrimSpace(config.GetDataDir())
	if dataDir == "" {
		tmpPath := filepath.Join(os.TempDir(), "breeze", hpWarrantyStateFileName)
		log.Warn("HP warranty state directory unavailable, falling back to temp dir", "path", tmpPath)
		return tmpPath
	}
	return filepath.Join(dataDir, hpWarrantyStateFileName)
}

// loadHpWarrantyState returns the persisted schedule, or the zero value when it
// is absent, unreadable or corrupt. Failing open to the zero value means the
// device takes the bootstrap path (a jittered first run) rather than stalling
// forever — the same fail-open choice reliability_state.go:55-59 documents.
func (h *Heartbeat) loadHpWarrantyState() hpWarrantyState {
	path := h.hpWarrantyStatePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("failed to read HP warranty state", "path", path, "error", err.Error())
		}
		return hpWarrantyState{}
	}
	var st hpWarrantyState
	if err := json.Unmarshal(raw, &st); err != nil {
		log.Warn("failed to decode HP warranty state", "path", path, "error", err.Error())
		return hpWarrantyState{}
	}
	return st
}

// saveHpWarrantyState atomically persists the schedule (temp file + rename),
// mirroring saveLastReliabilityUpdate (reliability_state.go:79-99).
func (h *Heartbeat) saveHpWarrantyState(st hpWarrantyState) error {
	path := h.hpWarrantyStatePath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create HP warranty state directory %s: %w", dir, err)
	}
	payload, err := json.Marshal(st)
	if err != nil {
		return fmt.Errorf("failed to encode HP warranty state: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0600); err != nil {
		return fmt.Errorf("failed to write HP warranty state temp file %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("failed to persist HP warranty state %s: %w", path, err)
	}
	return nil
}

// hpJitterOffset maps an agent id deterministically onto [0, window).
//
// Deterministic (FNV-1a, no rand) so the offset survives restarts and upgrades:
// a random offset re-rolled on every boot would let a restart-prone fleet
// re-synchronise, which is the failure this is meant to prevent.
//
// Be honest about what this does and does not buy. It spreads a fleet whose
// devices reach their due times independently. It does NOT bound concurrency:
// a site coming back from a shared outage has every device past its persisted
// due time simultaneously, and they all fire on their next heartbeat regardless
// of jitter. The 429 back-off (hpRateLimitBackoff), not the jitter, is what
// contains that case.
func hpJitterOffset(agentID string, window time.Duration) time.Duration {
	if window <= 0 || agentID == "" {
		return 0
	}
	sum := fnv.New64a()
	_, _ = sum.Write([]byte(agentID))
	return time.Duration(sum.Sum64() % uint64(window))
}

// hpBootstrapDueAt schedules a first-ever collection: soon, but spread across
// hpBootstrapJitterWindow so switching the policy on for a whole site does not
// produce a simultaneous CMSL stampede from one NAT.
func hpBootstrapDueAt(agentID string, now time.Time) time.Time {
	return now.Add(hpJitterOffset(agentID, hpBootstrapJitterWindow))
}

// hpNextDueAt computes the next collection time from HP's OWN cache timestamp
// (contract D8), not from a fixed interval. HP self-caches for 30 days, so a
// day-25 wake-up spawns PowerShell, learns nothing new and refreshes nothing.
//
// The result is always in the future: a device whose refresh failed still has a
// stale cache, so the natural computation lands in the past and would re-collect
// on every heartbeat tick. hpMinRecheckInterval plus the bootstrap jitter is the
// floor.
func hpNextDueAt(cacheTime time.Time, agentID string, now time.Time) time.Time {
	cadence := hpCacheTTL + hpRefreshMargin + hpJitterOffset(agentID, hpRefreshJitterWindow)

	var due time.Time
	if cacheTime.IsZero() {
		due = now.Add(cadence)
	} else {
		due = cacheTime.Add(cadence)
	}

	floor := now.Add(hpMinRecheckInterval + hpJitterOffset(agentID, hpBootstrapJitterWindow))
	if due.Before(floor) {
		return floor
	}
	return due
}
```

- [ ] **Step 5: Add the test-only path override to the `Heartbeat` struct**

In `agent/internal/heartbeat/heartbeat.go`, inside `type Heartbeat struct` (`:320`), directly after `patchSendFailures int` (`:380`), add:

```go
	// ---- HP warranty collection (W03) ----
	// hpWarrantyNextDue is the in-memory mirror of the persisted schedule,
	// seeded at startup and advanced under h.mu by claimHpWarrantyCycleLocked.
	hpWarrantyNextDue time.Time
	// hpWarrantyFailures / hpWarrantyRateLimitHits mirror the persisted counters
	// so the retry schedule survives neither more nor less than the file does.
	hpWarrantyFailures      int
	hpWarrantyRateLimitHits int
	// hpCmslEnabled is the FALLBACK collection gate — add it ONLY if Task 9
	// Step 1's grep shows W02 shipped no accessor of its own (see §0.16). When
	// W02 shipped one, delete this field: the gate is then a persisted
	// h.config field owned by W02, and a second in-memory copy here would go
	// stale the moment the two were written at different times. atomic because
	// applyConfigUpdate runs on the heartbeat-response goroutine while the tick
	// gate reads it under h.mu.
	hpCmslEnabled atomic.Bool
	// hpWarrantyStatePathOverride is a TEST-ONLY seam; nil/empty in production,
	// where hpWarrantyStatePath() resolves config.GetDataDir(). There is no env
	// var for this on purpose — a data-dir override would be a real, shippable
	// misconfiguration surface for a purely test-time need.
	hpWarrantyStatePathOverride string
```

`sync/atomic` is already imported (`headlessCachedAt atomic.Value`, `:406`); confirm before adding.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'TestHpJitterOffset|TestHpNextDueAt|TestHpBootstrapDueAt|TestHpWarrantyState' -v
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/collectors/hp_warranty.go agent/internal/heartbeat/hp_warranty.go agent/internal/heartbeat/hp_warranty_test.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): persisted HP warranty schedule with deterministic per-device jitter (W03)"
```

---

## Task 8: Bounded retries and the HP 429 back-off

**Files:**
- Modify: `agent/internal/heartbeat/hp_warranty.go`
- Test: `agent/internal/heartbeat/hp_warranty_test.go`

**Interfaces:**
- Produces: `hpRetryDelay(failures int) time.Duration`, `hpRateLimitBackoff(hits int) time.Duration`, `hpFailureDueAt(st hpWarrantyState, agentID string, now time.Time) time.Time`, and the `maxHpCollectRetries` / `hpRetryBaseDelay` / `hpRetryMaxDelay` / `hpRateLimitBackoffBase` / `hpRateLimitBackoffMax` consts.
- Consumes: `hpWarrantyState`, `hpJitterOffset`, `hpMinRecheckInterval`, `hpNextDueAt` (Task 7).

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/heartbeat/hp_warranty_test.go`:

```go
func TestHpRetryDelay(t *testing.T) {
	tests := []struct {
		name     string
		failures int
		want     time.Duration
	}{
		{"zero failures is not a retry", 0, 0},
		{"negative is not a retry", -1, 0},
		{"first retry", 1, 30 * time.Minute},
		{"second retry doubles", 2, time.Hour},
		{"third retry doubles again", 3, 2 * time.Hour},
		{"fourth retry doubles again", 4, 4 * time.Hour},
		{"fifth retry is capped, not exhausted", 5, 8 * time.Hour},
		{"beyond the cap stays at the cap", 12, 8 * time.Hour},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hpRetryDelay(tt.failures); got != tt.want {
				t.Fatalf("hpRetryDelay(%d) = %v, want %v", tt.failures, got, tt.want)
			}
		})
	}
}

func TestHpRateLimitBackoff(t *testing.T) {
	tests := []struct {
		name string
		hits int
		want time.Duration
	}{
		{"no hits", 0, 0},
		{"first 429", 1, 4 * time.Hour},
		{"second 429", 2, 8 * time.Hour},
		{"third 429", 3, 16 * time.Hour},
		{"fourth 429 hits the cap", 4, 32 * time.Hour},
		{"fifth 429 stays at the cap", 5, 48 * time.Hour},
		{"tenth 429 stays at the cap", 10, 48 * time.Hour},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hpRateLimitBackoff(tt.hits); got != tt.want {
				t.Fatalf("hpRateLimitBackoff(%d) = %v, want %v", tt.hits, got, tt.want)
			}
		})
	}
}

func TestHpRateLimitBackoff_IsAlwaysFarLongerThanAnOrdinaryRetry(t *testing.T) {
	// HP's limit is 300 requests / 5 minutes per SOURCE IP — per customer NAT,
	// not per device. Retrying a 429 on the ordinary failure schedule means the
	// whole site walks straight back into the limit together.
	for n := 1; n <= 6; n++ {
		if hpRateLimitBackoff(n) <= hpRetryDelay(n) {
			t.Fatalf("hpRateLimitBackoff(%d) = %v is not longer than hpRetryDelay(%d) = %v",
				n, hpRateLimitBackoff(n), n, hpRetryDelay(n))
		}
	}
	if hpRateLimitBackoff(1) < time.Hour {
		t.Fatalf("the first 429 back-off is %v — anything under an hour re-enters HP's window", hpRateLimitBackoff(1))
	}
}

func TestHpFailureDueAt(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	const agentID = "agent-under-test"
	jitter := hpJitterOffset(agentID, hpBootstrapJitterWindow)

	tests := []struct {
		name string
		st   hpWarrantyState
		want time.Duration // offset from now, before jitter
	}{
		{"a single ordinary failure", hpWarrantyState{Failures: 1}, 30 * time.Minute},
		{"three ordinary failures", hpWarrantyState{Failures: 3}, 2 * time.Hour},
		{"a rate limit outranks the ordinary schedule entirely", hpWarrantyState{Failures: 1, RateLimitHits: 1}, 4 * time.Hour},
		{"repeated rate limits keep escalating", hpWarrantyState{Failures: 4, RateLimitHits: 3}, 16 * time.Hour},
		{"no failures at all falls back to the min recheck", hpWarrantyState{}, hpMinRecheckInterval},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := hpFailureDueAt(tt.st, agentID, now)
			want := now.Add(tt.want + jitter)
			if !got.Equal(want) {
				t.Fatalf("hpFailureDueAt() = %v, want %v", got, want)
			}
			if !got.After(now) {
				t.Fatalf("hpFailureDueAt() = %v is not after now — that is a per-tick retry loop", got)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'TestHpRetryDelay|TestHpRateLimitBackoff|TestHpFailureDueAt'
```
Expected: FAIL to build — `undefined: hpRetryDelay`, `undefined: hpRateLimitBackoff`, `undefined: hpFailureDueAt`.

- [ ] **Step 3: Implement**

Append to `agent/internal/heartbeat/hp_warranty.go`:

```go
// Retry schedule. Deliberately slower than the patch-submission schedule
// (heartbeat.go:2236-2263, 5/10/20/40 minutes) because the payoff is different:
// a missed patch scan leaves posture stale within a 24h window, whereas HP
// warranty dates change at most once a year and a failed collection costs
// nothing until the next cycle. Retrying hard buys nothing and spends a shared
// rate-limit budget.
const (
	maxHpCollectRetries = 5
	hpRetryBaseDelay    = 30 * time.Minute
	hpRetryMaxDelay     = 8 * time.Hour
)

// Rate-limit back-off. HP's limit is 300 requests / 5 minutes per SOURCE IP —
// a per-customer-NAT budget shared by every HP device behind it. A 429
// therefore means "your site is saturating HP", not "this device was unlucky",
// and the only correct response is to leave for hours. Doubling from 4h to a
// 48h cap means a persistently limited site backs all the way off to roughly
// one attempt every two days while remaining eventually consistent.
const (
	hpRateLimitBackoffBase = 4 * time.Hour
	hpRateLimitBackoffMax  = 48 * time.Hour
)

// hpRetryDelay returns the delay before retrying after `failures` consecutive
// ordinary (non-rate-limit) failures. Unlike patchRetryDelay it does NOT return
// 0 past the attempt cap: HP collection has no "give up" state — a device that
// cannot collect today should still try tomorrow, just no more often than the
// cap. Returning 0 there would mean "due immediately", the exact opposite.
func hpRetryDelay(failures int) time.Duration {
	if failures < 1 {
		return 0
	}
	if failures > maxHpCollectRetries {
		failures = maxHpCollectRetries
	}
	delay := hpRetryBaseDelay << (failures - 1) // 30m, 1h, 2h, 4h, 8h
	if delay > hpRetryMaxDelay {
		delay = hpRetryMaxDelay
	}
	return delay
}

// hpRateLimitBackoff returns the delay after `hits` consecutive HP 429s.
func hpRateLimitBackoff(hits int) time.Duration {
	if hits < 1 {
		return 0
	}
	delay := hpRateLimitBackoffBase
	for i := 1; i < hits; i++ {
		delay *= 2
		if delay >= hpRateLimitBackoffMax {
			return hpRateLimitBackoffMax
		}
	}
	if delay > hpRateLimitBackoffMax {
		delay = hpRateLimitBackoffMax
	}
	return delay
}

// hpFailureDueAt computes the next attempt time after an unsuccessful cycle.
// A rate limit always outranks the ordinary schedule: a device that saw a 429
// AND an ordinary failure is still behind a saturated NAT.
//
// The per-device jitter is applied here too, so a whole site that failed
// together does not retry together — the one place jitter genuinely helps the
// re-bunching case the doc comment on hpJitterOffset is honest about.
func hpFailureDueAt(st hpWarrantyState, agentID string, now time.Time) time.Time {
	delay := hpMinRecheckInterval
	if st.RateLimitHits > 0 {
		delay = hpRateLimitBackoff(st.RateLimitHits)
	} else if st.Failures > 0 {
		delay = hpRetryDelay(st.Failures)
	}
	return now.Add(delay + hpJitterOffset(agentID, hpBootstrapJitterWindow))
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'TestHpRetryDelay|TestHpRateLimitBackoff|TestHpFailureDueAt' -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/hp_warranty.go agent/internal/heartbeat/hp_warranty_test.go
git commit -m "feat(agent): bounded HP collection retries with a per-NAT-aware 429 back-off (W03)"
```

---

## Task 9: The claim gate and W02's config seam

**Files:**
- Modify: `agent/internal/heartbeat/hp_warranty.go`
- Modify: `agent/internal/heartbeat/warranty_config.go` (**one line** — W02's file)
- Test: `agent/internal/heartbeat/hp_warranty_test.go`

**Interfaces:**
- Produces: `(*Heartbeat) hpCmslCollectionEnabled() bool`, `(*Heartbeat) setHpCmslCollectionEnabled(bool)`, `(*Heartbeat) claimHpWarrantyCycleLocked(now time.Time) bool`.
- Consumes: W02's `func (h *Heartbeat) applyWarrantyConfig(raw any)` in `agent/internal/heartbeat/warranty_config.go` (contract D6/D7) — **only** to add the setter call; the payload parse is W02's and is not re-implemented.

- [ ] **Step 1: Read what W02 actually shipped**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
cat agent/internal/heartbeat/warranty_config.go
grep -rn "hp_cmsl_enabled\|hpCmslEnabled\|applyWarrantyConfig" agent/internal/heartbeat/
```

The contract (D7) fixes the file and the function name but **not** where the resolved boolean is stored. W02's own plan says it ships "the seam, the parse, **and the accessor W03 reads**", modelled on `requireManifestSigningKeyID()` (`heartbeat.go:4008-4012`) — a mutex-guarded accessor over a persisted `h.config` field. See §0.16. Read the shipped name and take one of two branches:

- **Primary (expected) — W02 shipped an accessor.** W03 adds NO storage. Delete the `hpCmslEnabled atomic.Bool` field from Task 7 Step 5's struct block, skip Step 5 of this task entirely, and implement the two functions in Step 4 as delegates:

  ```go
  func (h *Heartbeat) hpCmslCollectionEnabled() bool {
      return h.<W02's accessor name>()
  }

  // setHpCmslCollectionEnabled exists for tests only when W02 owns the storage.
  // Production writes go through W02's applyWarrantyConfig, never through here.
  func (h *Heartbeat) setHpCmslCollectionEnabled(enabled bool) {
      h.mu.Lock()
      defer h.mu.Unlock()
      h.config.<W02's config field name> = enabled
  }
  ```
  Tests constructing a bare `&Heartbeat{}` must then also give it a `config: &config.Config{}` so the setter has somewhere to write — Task 10's `newHeartbeat` helper already does; add `config: &config.Config{}` to the `&Heartbeat{}` literals in `TestHpCmslCollectionEnabled_DefaultsOff`, `TestApplyWarrantyConfig_DrivesTheCollectionGate` and `TestClaimHpWarrantyCycleLocked`.

- **Fallback — W02 shipped only the parse and a platform func var, with no accessor.** Keep the `hpCmslEnabled atomic.Bool` field and implement Steps 3–5 exactly as written, including the one-line setter call in Step 5.

If `warranty_config.go` does not exist yet, W02 has not landed — **stop and report**; do not create W02's file.

- [ ] **Step 2: Write the failing test**

Append to `agent/internal/heartbeat/hp_warranty_test.go`:

```go
func TestHpCmslCollectionEnabled_DefaultsOff(t *testing.T) {
	h := &Heartbeat{}
	if h.hpCmslCollectionEnabled() {
		t.Fatal("HP CMSL collection is on by default — it must be opt-in; CMSL is a ~100MB HP module with HP telemetry rights and an unaccepted EULA")
	}
	h.setHpCmslCollectionEnabled(true)
	if !h.hpCmslCollectionEnabled() {
		t.Fatal("setHpCmslCollectionEnabled(true) did not take effect")
	}
	h.setHpCmslCollectionEnabled(false)
	if h.hpCmslCollectionEnabled() {
		t.Fatal("setHpCmslCollectionEnabled(false) did not revoke collection — a revoked policy must stop HP activity")
	}
}

func TestApplyWarrantyConfig_DrivesTheCollectionGate(t *testing.T) {
	// W02 owns the parse; this asserts only that the resolved value reaches
	// W03's gate. Both key spellings are covered because the API may send
	// either (contract D6) and every existing seam accepts both.
	tests := []struct {
		name string
		raw  any
		want bool
	}{
		{"snake_case true", map[string]any{"hp_cmsl_enabled": true}, true},
		{"camelCase true", map[string]any{"hpCmslEnabled": true}, true},
		{"snake_case false revokes", map[string]any{"hp_cmsl_enabled": false}, false},
		{"camelCase false revokes", map[string]any{"hpCmslEnabled": false}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &Heartbeat{}
			h.setHpCmslCollectionEnabled(!tt.want) // start from the opposite state
			h.applyWarrantyConfig(tt.raw)
			if got := h.hpCmslCollectionEnabled(); got != tt.want {
				t.Fatalf("hpCmslCollectionEnabled() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestClaimHpWarrantyCycleLocked(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)

	t.Run("disabled never claims, even when overdue", func(t *testing.T) {
		h := &Heartbeat{hpWarrantyNextDue: now.Add(-time.Hour)}
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.claimHpWarrantyCycleLocked(now) {
			t.Fatal("claimed a cycle with the policy disabled — HP activity must stop on revocation")
		}
	})

	t.Run("enabled and not yet due does not claim", func(t *testing.T) {
		h := &Heartbeat{hpWarrantyNextDue: now.Add(time.Hour)}
		h.setHpCmslCollectionEnabled(true)
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.claimHpWarrantyCycleLocked(now) {
			t.Fatal("claimed a cycle before its due time")
		}
	})

	t.Run("enabled and due claims exactly once", func(t *testing.T) {
		h := &Heartbeat{hpWarrantyNextDue: now.Add(-time.Minute)}
		h.setHpCmslCollectionEnabled(true)
		h.mu.Lock()
		defer h.mu.Unlock()
		if !h.claimHpWarrantyCycleLocked(now) {
			t.Fatal("did not claim an overdue cycle")
		}
		if h.claimHpWarrantyCycleLocked(now) {
			t.Fatal("claimed the SAME cycle twice — two concurrent PowerShell spawns per device")
		}
		if !h.hpWarrantyNextDue.After(now) {
			t.Fatalf("hpWarrantyNextDue = %v was not advanced past now on claim", h.hpWarrantyNextDue)
		}
	})

	t.Run("a zero due time (never collected) claims immediately so the bootstrap path can schedule", func(t *testing.T) {
		h := &Heartbeat{}
		h.setHpCmslCollectionEnabled(true)
		h.mu.Lock()
		defer h.mu.Unlock()
		if !h.claimHpWarrantyCycleLocked(now) {
			t.Fatal("a never-collected device did not claim")
		}
	})

	t.Run("the provisional advance is a real interval, not a token bump", func(t *testing.T) {
		h := &Heartbeat{hpWarrantyNextDue: now.Add(-time.Minute)}
		h.setHpCmslCollectionEnabled(true)
		h.mu.Lock()
		defer h.mu.Unlock()
		h.claimHpWarrantyCycleLocked(now)
		// If the cycle goroutine dies without persisting (panic, kill -9 between
		// claim and save), this provisional value is what stops the next tick
		// re-claiming 30 seconds later.
		if h.hpWarrantyNextDue.Sub(now) < hpMinRecheckInterval {
			t.Fatalf("provisional advance is %v, want at least %v so a crashed cycle cannot become a per-tick loop",
				h.hpWarrantyNextDue.Sub(now), hpMinRecheckInterval)
		}
	})
}

func TestClaimHpWarrantyCycleLocked_IsRaceFreeUnderConcurrentTicks(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	h := &Heartbeat{hpWarrantyNextDue: now.Add(-time.Hour)}
	h.setHpCmslCollectionEnabled(true)

	const goroutines = 32
	claims := make(chan bool, goroutines)
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		go func() {
			<-start
			h.mu.Lock()
			claimed := h.claimHpWarrantyCycleLocked(now)
			h.mu.Unlock()
			claims <- claimed
		}()
	}
	close(start)

	won := 0
	for i := 0; i < goroutines; i++ {
		if <-claims {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("%d goroutines claimed the cycle, want exactly 1", won)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'TestHpCmslCollectionEnabled|TestApplyWarrantyConfig|TestClaimHpWarrantyCycleLocked'
```
Expected: FAIL to build — `undefined: hpCmslCollectionEnabled`, `undefined: setHpCmslCollectionEnabled`, `undefined: claimHpWarrantyCycleLocked`. (`applyWarrantyConfig` resolves — it is W02's.)

- [ ] **Step 4: Implement the gate**

Append to `agent/internal/heartbeat/hp_warranty.go`. The `hpCmslCollectionEnabled` / `setHpCmslCollectionEnabled` bodies below are the **fallback** shape (W03 owns the storage); if Step 1 found W02's accessor, use the delegate bodies from Step 1 instead and keep everything else here — `claimHpWarrantyCycleLocked` is identical either way, and its doc comment is what the rest of the wave depends on.

```go
// hpCmslCollectionEnabled reports whether the effective warranty policy has HP
// CMSL collection switched on for this device.
//
// The value arrives via warranty_settings.hp_cmsl_enabled through W02's
// warranty_config.go seam (contract D6). This wave consumes that seam and does
// not re-implement the payload parse — a second parser is precisely the
// key-name regression the seam exists to prevent.
//
// The default is FALSE and must stay false: CMSL is a ~100 MB HP module with
// HP telemetry rights on the endpoint, and the feature is opt-in with a
// recorded consent (spec, "The EULA constrains the install channel").
func (h *Heartbeat) hpCmslCollectionEnabled() bool {
	return h.hpCmslEnabled.Load()
}

// setHpCmslCollectionEnabled records the policy's collection gate. Called from
// applyWarrantyConfig on the heartbeat-response goroutine.
//
// Revocation is load-bearing, not cosmetic: buildWarrantyConfigUpdate's
// contract (copied from buildPatchSourceConfigUpdate, helpers.ts:2852-2859)
// distinguishes a successfully resolved ABSENT policy — which sends false and
// must stop HP activity — from a resolver ERROR, which omits the block so a
// transient failure never revokes. Only the first ever reaches this setter.
func (h *Heartbeat) setHpCmslCollectionEnabled(enabled bool) {
	h.hpCmslEnabled.Store(enabled)
}

// claimHpWarrantyCycleLocked decides whether an HP warranty collection cycle is
// due and, if so, claims it by provisionally advancing the schedule so the next
// tick cannot dispatch a duplicate concurrent cycle. Returns whether the caller
// should dispatch. Caller must hold h.mu.
//
// The decision and the state transition live together here rather than being
// open-coded in the tick loop, for the reason claimPatchScanLocked
// (heartbeat.go:2276-2290) gives: one test then exercises the whole gate
// instead of only its predicate.
//
// The provisional advance is a full hpMinRecheckInterval, not a token bump. The
// dispatched cycle overwrites it with the real due time once it finishes; if it
// never finishes (panic recovered by observability.Recoverer, or the process is
// killed between claim and persist), this value is the only thing standing
// between the device and a PowerShell spawn on every heartbeat tick.
func (h *Heartbeat) claimHpWarrantyCycleLocked(now time.Time) bool {
	if !h.hpCmslCollectionEnabled() {
		return false
	}
	if !h.hpWarrantyNextDue.IsZero() && now.Before(h.hpWarrantyNextDue) {
		return false
	}
	h.hpWarrantyNextDue = now.Add(hpMinRecheckInterval)
	return true
}
```

- [ ] **Step 5: FALLBACK ONLY — wire W02's seam to the gate (ONE line)**

**Skip this step entirely if Step 1 found W02's accessor** — in that case W02 already writes the persisted field and adding a second write here would double-write the same value from the same function.

Otherwise, in `agent/internal/heartbeat/warranty_config.go`, at the point where W02's `applyWarrantyConfig` has resolved the boolean (the equivalent of `patch_source.go:40`'s `res, err := applyWinUpdate(enforce)`), add:

```go
	h.setHpCmslCollectionEnabled(enabled)
```

If W02's local variable is not called `enabled`, use its name. **Change nothing else in that file** — the parse, the logging and the dual-key handling are W02's and are already covered by W02's own tests.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'TestHpCmslCollectionEnabled|TestApplyWarrantyConfig|TestClaimHpWarrantyCycleLocked' -v
```
Expected: PASS, including the 32-goroutine race test under `-race`.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/heartbeat/hp_warranty.go agent/internal/heartbeat/warranty_config.go agent/internal/heartbeat/hp_warranty_test.go
git commit -m "feat(agent): HP warranty collection claim gate driven by the W02 config seam (W03)"
```

---

## Task 10: Run the cycle, report it, and wire it into the tick loop

**Files:**
- Modify: `agent/internal/heartbeat/hp_warranty.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` (startup seeding `:1789-1809`; tick gate `:1846-1885`)
- Test: `agent/internal/heartbeat/hp_warranty_test.go`

**Interfaces:**
- Produces: `(*Heartbeat) runHpWarrantyCycle(now time.Time)`, `(*Heartbeat) sendHpWarrantyInfo(info *collectors.HpWarrantyInfo) error`, `buildHpWarrantyPayload(*collectors.HpWarrantyInfo) map[string]any`, `hpCollectFn` (test seam), `(*Heartbeat) seedHpWarrantySchedule(now time.Time)`.
- Consumes: `collectors.CollectHpWarranty` (Task 1), `collectors.IsHpRateLimited` (Task 1), `collectors.HpCollectError` (Task 1), `h.sendInventoryData` (`heartbeat.go:2155`), `claimHpWarrantyCycleLocked` (Task 9), `hpNextDueAt` / `hpFailureDueAt` / `hpBootstrapDueAt` (Tasks 7–8).
- Consumes from **W01** (do not redefine): the widened `agentWarrantyInfoSchema` (`apps/api/src/routes/agents/schemas.ts:658-675`) and the widened `AgentWarrantyData` (`apps/api/src/services/warrantySync.ts:315-331`), specifically their new bounded `entitlements` array whose element fields are `serviceLevelDescription`, `entitlementType`, `startDate`, `endDate` — with `provider` derived server-side from `source`, never sent by the agent (D10).

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/heartbeat/hp_warranty_test.go`:

```go
func TestBuildHpWarrantyPayload(t *testing.T) {
	t.Run("carries the contract's fixed source and manufacturer", func(t *testing.T) {
		p := buildHpWarrantyPayload(&collectors.HpWarrantyInfo{CoverageEndDate: "2027-01-14"})
		if p["source"] != "agent_cmsl" {
			t.Errorf("source = %v, want agent_cmsl (contract D9 — this is what makes the row agent-owned server-side)", p["source"])
		}
		if p["manufacturer"] != "HP" {
			t.Errorf("manufacturer = %v, want HP", p["manufacturer"])
		}
	})

	t.Run("entitlements are omitted entirely when empty, never sent as an empty array", func(t *testing.T) {
		p := buildHpWarrantyPayload(&collectors.HpWarrantyInfo{CoverageEndDate: "2027-01-14"})
		if _, present := p["entitlements"]; present {
			t.Error("entitlements key present with no entitlements — an empty array would overwrite a populated column server-side")
		}
	})

	t.Run("entitlements never carry provider — W01 derives it from the source", func(t *testing.T) {
		p := buildHpWarrantyPayload(&collectors.HpWarrantyInfo{
			CoverageEndDate: "2027-01-14",
			Entitlements: []collectors.HpEntitlement{{
				ServiceLevelDescription: "HP 3y NBD",
				EntitlementType:         "NBD Onsite",
				StartDate:               "2024-01-15",
				EndDate:                 "2027-01-14",
			}},
		})
		ents, ok := p["entitlements"].([]map[string]any)
		if !ok || len(ents) != 1 {
			t.Fatalf("entitlements = %#v, want one element", p["entitlements"])
		}
		if _, present := ents[0]["provider"]; present {
			t.Error("the agent sent `provider` — warrantySync.ts:367 is W01's to fix, and an agent-supplied value would defeat it")
		}
		for _, k := range []string{"serviceLevelDescription", "entitlementType", "startDate", "endDate"} {
			if _, present := ents[0][k]; !present {
				t.Errorf("entitlement is missing %q — the field names must match WarrantyEntitlement in warrantyProviders/types.ts:1-7", k)
			}
		}
	})

	t.Run("nil info yields a nil payload, never a blank report", func(t *testing.T) {
		if p := buildHpWarrantyPayload(nil); p != nil {
			t.Fatalf("buildHpWarrantyPayload(nil) = %#v, want nil", p)
		}
	})

	t.Run("a report with no coverage dates and no entitlements is not worth sending", func(t *testing.T) {
		if p := buildHpWarrantyPayload(&collectors.HpWarrantyInfo{SerialNumber: "5CD1"}); p != nil {
			t.Fatalf("buildHpWarrantyPayload() = %#v, want nil — a serial-only report would flip data_source to agent_cmsl with nothing to show for it", p)
		}
	})
}

func TestRunHpWarrantyCycle(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	hpCache := now.Add(-2 * 24 * time.Hour)

	newHeartbeat := func(t *testing.T) (*Heartbeat, *int) {
		t.Helper()
		sent := 0
		h := &Heartbeat{
			config:                      &config.Config{AgentID: "agent-under-test"},
			hpWarrantyStatePathOverride: filepath.Join(t.TempDir(), "hp_warranty_state.json"),
			hpSendFn:                    func(map[string]any) error { sent++; return nil },
		}
		h.setHpCmslCollectionEnabled(true)
		return h, &sent
	}

	t.Run("a successful cycle reports once and schedules from HP's cache timestamp", func(t *testing.T) {
		h, sent := newHeartbeat(t)
		original := hpCollectFn
		t.Cleanup(func() { hpCollectFn = original })
		hpCollectFn = func() (*collectors.HpWarrantyInfo, error) {
			return &collectors.HpWarrantyInfo{
				CoverageEndDate: "2027-01-14",
				HPCacheTime:     hpCache,
				Tier:            collectors.HpTierT0,
				Reason:          collectors.HpReasonOK,
			}, nil
		}

		h.runHpWarrantyCycle(now)

		if *sent != 1 {
			t.Fatalf("reports sent = %d, want 1", *sent)
		}
		st := h.loadHpWarrantyState()
		want := hpNextDueAt(hpCache, "agent-under-test", now)
		if !st.NextDueAt.Equal(want) {
			t.Fatalf("persisted NextDueAt = %v, want %v (derived from HP's own cache timestamp, contract D8)", st.NextDueAt, want)
		}
		if st.Failures != 0 || st.RateLimitHits != 0 {
			t.Fatalf("counters not reset on success: %#v", st)
		}
		if !h.hpWarrantyNextDue.Equal(want) {
			t.Fatalf("in-memory due %v does not match persisted %v", h.hpWarrantyNextDue, want)
		}
	})

	t.Run("T2 (CMSL absent) reports nothing but records why", func(t *testing.T) {
		h, sent := newHeartbeat(t)
		original := hpCollectFn
		t.Cleanup(func() { hpCollectFn = original })
		hpCollectFn = func() (*collectors.HpWarrantyInfo, error) {
			return nil, &collectors.HpCollectError{Reason: collectors.HpReasonNamespaceAbsent, Detail: "Invalid namespace"}
		}

		h.runHpWarrantyCycle(now)

		if *sent != 0 {
			t.Fatalf("reports sent = %d, want 0 — T2 reports nothing and lets the policy install CMSL", *sent)
		}
		st := h.loadHpWarrantyState()
		if st.LastReason != collectors.HpReasonNamespaceAbsent {
			t.Fatalf("LastReason = %q, want %q — the spec requires reporting WHY collection failed", st.LastReason, collectors.HpReasonNamespaceAbsent)
		}
		if st.Failures != 1 {
			t.Fatalf("Failures = %d, want 1", st.Failures)
		}
		if !st.NextDueAt.After(now) {
			t.Fatalf("NextDueAt = %v is not in the future", st.NextDueAt)
		}
	})

	t.Run("an HP 429 escalates the rate-limit counter, not the ordinary failure counter", func(t *testing.T) {
		h, _ := newHeartbeat(t)
		original := hpCollectFn
		t.Cleanup(func() { hpCollectFn = original })
		hpCollectFn = func() (*collectors.HpWarrantyInfo, error) {
			return nil, &collectors.HpCollectError{Reason: collectors.HpReasonRateLimited, Detail: "(429) Too Many Requests"}
		}

		h.runHpWarrantyCycle(now)

		st := h.loadHpWarrantyState()
		if st.RateLimitHits != 1 {
			t.Fatalf("RateLimitHits = %d, want 1", st.RateLimitHits)
		}
		if got := st.NextDueAt.Sub(now); got < hpRateLimitBackoffBase {
			t.Fatalf("next attempt in %v, want at least %v — anything sooner walks the whole NAT back into HP's limit", got, hpRateLimitBackoffBase)
		}
	})

	t.Run("stale data served alongside a 429 is still reported AND still backs off", func(t *testing.T) {
		h, sent := newHeartbeat(t)
		original := hpCollectFn
		t.Cleanup(func() { hpCollectFn = original })
		hpCollectFn = func() (*collectors.HpWarrantyInfo, error) {
			return &collectors.HpWarrantyInfo{
				CoverageEndDate: "2027-01-14",
				HPCacheTime:     now.Add(-45 * 24 * time.Hour),
				Tier:            collectors.HpTierT0,
				Reason:          collectors.HpReasonRateLimited,
				RateLimited:     true,
			}, nil
		}

		h.runHpWarrantyCycle(now)

		if *sent != 1 {
			t.Fatalf("reports sent = %d, want 1 — month-old dates beat status='unknown', which is the whole point of the feature", *sent)
		}
		st := h.loadHpWarrantyState()
		if st.RateLimitHits != 1 {
			t.Fatalf("RateLimitHits = %d, want 1 — RateLimited on the struct is the only channel for a serve-stale 429", st.RateLimitHits)
		}
		if got := st.NextDueAt.Sub(now); got < hpRateLimitBackoffBase {
			t.Fatalf("next attempt in %v, want at least %v", got, hpRateLimitBackoffBase)
		}
	})

	t.Run("consecutive failures escalate the delay monotonically", func(t *testing.T) {
		h, _ := newHeartbeat(t)
		original := hpCollectFn
		t.Cleanup(func() { hpCollectFn = original })
		hpCollectFn = func() (*collectors.HpWarrantyInfo, error) {
			return nil, &collectors.HpCollectError{Reason: collectors.HpReasonRefreshFailed, Detail: "network unreachable"}
		}

		var previous time.Duration
		for attempt := 1; attempt <= 4; attempt++ {
			h.runHpWarrantyCycle(now)
			st := h.loadHpWarrantyState()
			if st.Failures != attempt {
				t.Fatalf("attempt %d: Failures = %d, want %d", attempt, st.Failures, attempt)
			}
			delay := st.NextDueAt.Sub(now)
			if attempt > 1 && delay <= previous {
				t.Fatalf("attempt %d: delay %v did not grow past %v", attempt, delay, previous)
			}
			previous = delay
		}
	})

	t.Run("a send failure does not advance the schedule as if it succeeded", func(t *testing.T) {
		h, _ := newHeartbeat(t)
		h.hpSendFn = func(map[string]any) error { return errors.New("503 from the API") }
		original := hpCollectFn
		t.Cleanup(func() { hpCollectFn = original })
		hpCollectFn = func() (*collectors.HpWarrantyInfo, error) {
			return &collectors.HpWarrantyInfo{CoverageEndDate: "2027-01-14", HPCacheTime: hpCache, Reason: collectors.HpReasonOK}, nil
		}

		h.runHpWarrantyCycle(now)

		st := h.loadHpWarrantyState()
		if st.Failures != 1 {
			t.Fatalf("Failures = %d, want 1 — collected-but-never-delivered is a failure, and pushing NextDueAt out 30 days would hide it for a month", st.Failures)
		}
		if got := st.NextDueAt.Sub(now); got > hpCacheTTL {
			t.Fatalf("NextDueAt is %v out, want a retry interval not a full cache lifetime", got)
		}
	})

	t.Run("a disabled policy never collects", func(t *testing.T) {
		h, sent := newHeartbeat(t)
		h.setHpCmslCollectionEnabled(false)
		collected := 0
		original := hpCollectFn
		t.Cleanup(func() { hpCollectFn = original })
		hpCollectFn = func() (*collectors.HpWarrantyInfo, error) {
			collected++
			return &collectors.HpWarrantyInfo{CoverageEndDate: "2027-01-14"}, nil
		}

		h.runHpWarrantyCycle(now)

		if collected != 0 || *sent != 0 {
			t.Fatalf("collected=%d sent=%d, want 0/0 with the policy disabled", collected, *sent)
		}
	})
}

func TestSeedHpWarrantySchedule(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)

	t.Run("a fresh device bootstraps into the jitter window, not immediately", func(t *testing.T) {
		h := &Heartbeat{
			config:                      &config.Config{AgentID: "fresh-device"},
			hpWarrantyStatePathOverride: filepath.Join(t.TempDir(), "hp_warranty_state.json"),
		}
		h.seedHpWarrantySchedule(now)
		want := hpBootstrapDueAt("fresh-device", now)
		if !h.hpWarrantyNextDue.Equal(want) {
			t.Fatalf("seeded due = %v, want %v", h.hpWarrantyNextDue, want)
		}
	})

	t.Run("a restart honours the persisted due time instead of collecting again", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "hp_warranty_state.json")
		h := &Heartbeat{config: &config.Config{AgentID: "restarted"}, hpWarrantyStatePathOverride: path}
		persisted := now.Add(11 * 24 * time.Hour)
		if err := h.saveHpWarrantyState(hpWarrantyState{NextDueAt: persisted, Failures: 2, RateLimitHits: 1}); err != nil {
			t.Fatal(err)
		}

		fresh := &Heartbeat{config: &config.Config{AgentID: "restarted"}, hpWarrantyStatePathOverride: path}
		fresh.seedHpWarrantySchedule(now)

		if !fresh.hpWarrantyNextDue.Equal(persisted) {
			t.Fatalf("seeded due = %v, want the persisted %v — a restart-prone endpoint must not re-collect on every boot (#1906's lesson)", fresh.hpWarrantyNextDue, persisted)
		}
		if fresh.hpWarrantyFailures != 2 || fresh.hpWarrantyRateLimitHits != 1 {
			t.Fatalf("counters not restored: failures=%d rateLimitHits=%d", fresh.hpWarrantyFailures, fresh.hpWarrantyRateLimitHits)
		}
	})
}
```

Extend that test file's imports to:

```go
import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'TestBuildHpWarrantyPayload|TestRunHpWarrantyCycle|TestSeedHpWarrantySchedule'
```
Expected: FAIL to build — `undefined: buildHpWarrantyPayload`, `undefined: hpCollectFn`, `undefined: runHpWarrantyCycle`, `undefined: seedHpWarrantySchedule`, `hpSendFn` is not a field of `Heartbeat`.

- [ ] **Step 3: Add the two seams to the `Heartbeat` struct**

In `agent/internal/heartbeat/heartbeat.go`, extend the W03 block added in Task 7 Step 5:

```go
	// hpSendFn is a TEST-ONLY seam for the report call; nil in production, where
	// runHpWarrantyCycle uses sendHpWarrantyInfo → sendInventoryData. Without it
	// a cycle test would have to stand up an HTTP server to prove a scheduling
	// decision, which is the wrong thing to make expensive.
	hpSendFn func(payload map[string]any) error
```

- [ ] **Step 4: Implement the cycle, the payload and the report**

Append to `agent/internal/heartbeat/hp_warranty.go`:

```go
// hpCollectFn is the collection seam. It defaults to the real collector, which
// is a genuine no-op on non-Windows (collectors/hp_warranty_other.go), so tests
// on the CI runner replace it rather than relying on that no-op — a test that
// passed only because collection returned (nil, nil) would prove nothing.
var hpCollectFn = collectors.CollectHpWarranty

// buildHpWarrantyPayload renders an HpWarrantyInfo for
// PUT /agents/:id/warranty-info, modelled on sendAppleWarrantyInfo
// (heartbeat.go:2405-2435).
//
// Returns nil when there is nothing worth reporting. That matters: an
// agent_cmsl row with no dates would still flip device_warranty.data_source to
// 'agent_cmsl' and, once W01's preservation generalisation lands, make the
// server preserve an empty row against future provider syncs.
//
// The entitlement objects mirror WarrantyEntitlement
// (warrantyProviders/types.ts:1-7) MINUS `provider`: W01 derives that from the
// reporting source server-side, because hardcoding it is the verified defect at
// warrantySync.ts:367. An agent-supplied `provider` would re-create it.
func buildHpWarrantyPayload(info *collectors.HpWarrantyInfo) map[string]any {
	if info == nil {
		return nil
	}
	if info.CoverageEndDate == "" && info.CoverageStartDate == "" && len(info.Entitlements) == 0 {
		return nil
	}

	payload := map[string]any{
		"source":            "agent_cmsl",
		"manufacturer":      "HP",
		"coverageEndDate":   info.CoverageEndDate,
		"coverageStartDate": info.CoverageStartDate,
		"coverageType":      info.CoverageType,
	}

	// Omitted, never sent empty: an empty array is a value the server would
	// write over a populated entitlements column.
	if len(info.Entitlements) > 0 {
		ents := make([]map[string]any, 0, len(info.Entitlements))
		for _, e := range info.Entitlements {
			ents = append(ents, map[string]any{
				"serviceLevelDescription": e.ServiceLevelDescription,
				"entitlementType":         e.EntitlementType,
				"startDate":               e.StartDate,
				"endDate":                 e.EndDate,
			})
		}
		payload["entitlements"] = ents
	}

	return payload
}

// sendHpWarrantyInfo PUTs the payload to /agents/:id/warranty-info, reusing the
// Apple transport unchanged. Note sendInventoryData takes the ENDPOINT first
// and the label third (heartbeat.go:2155).
func (h *Heartbeat) sendHpWarrantyInfo(payload map[string]any) error {
	if h.hpSendFn != nil {
		return h.hpSendFn(payload)
	}
	return h.sendInventoryData("warranty-info", payload, "hp warranty")
}

// seedHpWarrantySchedule restores the persisted schedule at startup, mirroring
// the reliability seeding at heartbeat.go:1789-1809. A device that has never
// collected bootstraps into the jitter window rather than firing immediately,
// so switching the policy on for a site does not produce a simultaneous CMSL
// stampede from one NAT.
func (h *Heartbeat) seedHpWarrantySchedule(now time.Time) {
	st := h.loadHpWarrantyState()
	next := st.NextDueAt
	if next.IsZero() {
		next = hpBootstrapDueAt(h.agentIDForJitter(), now)
	}
	h.mu.Lock()
	h.hpWarrantyNextDue = next
	h.hpWarrantyFailures = st.Failures
	h.hpWarrantyRateLimitHits = st.RateLimitHits
	h.mu.Unlock()
}

// agentIDForJitter returns the stable per-device key the jitter hashes. The
// agent id is a sha256 hash assigned at enrolment and never changes for the
// life of the enrolment, which is exactly the stability the offset needs.
func (h *Heartbeat) agentIDForJitter() string {
	if h.config == nil {
		return ""
	}
	return h.config.AgentID
}

// runHpWarrantyCycle performs one HP warranty collection: collect, report, then
// persist the next due time. Called from the tick loop only after
// claimHpWarrantyCycleLocked has claimed the cycle.
//
// Every exit path persists a schedule. A path that returned without persisting
// would leave only the claim's provisional advance, so the device would retry
// in hpMinRecheckInterval regardless of what happened — losing both the 30-day
// cadence on success and the 429 back-off on failure.
func (h *Heartbeat) runHpWarrantyCycle(now time.Time) {
	if !h.hpCmslCollectionEnabled() {
		return
	}

	h.mu.Lock()
	st := hpWarrantyState{
		Failures:      h.hpWarrantyFailures,
		RateLimitHits: h.hpWarrantyRateLimitHits,
	}
	h.mu.Unlock()
	st.LastAttemptAt = now

	info, err := hpCollectFn()

	switch {
	case err != nil:
		var hpErr *collectors.HpCollectError
		reason := "collect_failed"
		if errorsAsHp(err, &hpErr) {
			reason = hpErr.Reason
		}
		st.LastReason = reason
		if collectors.IsHpRateLimited(err) {
			st.RateLimitHits++
			log.Warn("HP refused the warranty refresh with a rate limit; backing off",
				"reason", reason, "rateLimitHits", st.RateLimitHits, "error", err.Error())
		} else {
			st.Failures++
			// Warn, not Debug: the whole point of the reason codes is that an
			// operator can tell "CMSL is not installed" from "PowerShell is too
			// old" without a lab visit, and Debug is suppressed at the default
			// level.
			log.Warn("HP warranty collection produced no data",
				"reason", reason, "failures", st.Failures, "error", err.Error())
		}
		st.NextDueAt = hpFailureDueAt(st, h.agentIDForJitter(), now)

	case info == nil:
		// Not an error and not data: the non-Windows no-op, or a Windows host
		// that resolved nothing worth sending. Neither is a failure to escalate.
		st.LastReason = collectors.HpReasonNoWarrantyRow
		st.Failures = 0
		st.RateLimitHits = 0
		st.NextDueAt = hpNextDueAt(time.Time{}, h.agentIDForJitter(), now)

	default:
		payload := buildHpWarrantyPayload(info)
		if payload == nil {
			st.LastReason = collectors.HpReasonNoWarrantyRow
			st.Failures = 0
			st.RateLimitHits = 0
			st.NextDueAt = hpNextDueAt(info.HPCacheTime, h.agentIDForJitter(), now)
			break
		}
		if sendErr := h.sendHpWarrantyInfo(payload); sendErr != nil {
			// Collected but never delivered. Treating this as success would push
			// the next attempt a full HP cache lifetime out and hide the outage
			// for a month.
			st.Failures++
			st.LastReason = "report_failed"
			st.NextDueAt = hpFailureDueAt(st, h.agentIDForJitter(), now)
			log.Warn("HP warranty report failed to send", "failures", st.Failures, "error", sendErr.Error())
			break
		}
		st.LastSuccessAt = now
		st.LastReason = info.Reason
		if info.RateLimited {
			// Stale data was served alongside a 429. The report succeeded, so
			// the ordinary failure counter resets — but HP still refused, so the
			// rate-limit back-off must still apply.
			st.RateLimitHits++
			st.Failures = 0
			st.NextDueAt = hpFailureDueAt(st, h.agentIDForJitter(), now)
			log.Warn("HP warranty reported from a stale cache after a rate limit; backing off",
				"rateLimitHits", st.RateLimitHits, "tier", info.Tier)
		} else {
			st.Failures = 0
			st.RateLimitHits = 0
			st.NextDueAt = hpNextDueAt(info.HPCacheTime, h.agentIDForJitter(), now)
			log.Info("HP warranty reported",
				"tier", info.Tier, "entitlements", len(info.Entitlements),
				"hpCacheTime", info.HPCacheTime.Format(time.RFC3339),
				"nextDueAt", st.NextDueAt.Format(time.RFC3339))
		}
	}

	h.mu.Lock()
	h.hpWarrantyNextDue = st.NextDueAt
	h.hpWarrantyFailures = st.Failures
	h.hpWarrantyRateLimitHits = st.RateLimitHits
	h.mu.Unlock()

	if err := h.saveHpWarrantyState(st); err != nil {
		// Non-fatal: the in-memory schedule above still holds for this process,
		// so the device does not spin. It only loses the schedule on restart.
		log.Warn("failed to persist HP warranty state", "error", err.Error())
	}
}

// errorsAsHp is errors.As specialised for *collectors.HpCollectError.
func errorsAsHp(err error, target **collectors.HpCollectError) bool {
	return errors.As(err, target)
}
```

Add `"errors"` to `agent/internal/heartbeat/hp_warranty.go`'s import block.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'TestBuildHpWarrantyPayload|TestRunHpWarrantyCycle|TestSeedHpWarrantySchedule' -v
```
Expected: PASS.

- [ ] **Step 6: Wire the cycle into startup and the tick loop**

In `agent/internal/heartbeat/heartbeat.go`, in the startup block, immediately after `h.mu.Unlock()` at `:1806` and before the `if postReliability {` at `:1807`, add:

```go
	// HP warranty has its own persisted cadence and does NOT join the 15-minute
	// sendInventory fan-out: HP self-caches 30 days, so riding that lifecycle
	// would relaunch PowerShell every 15 minutes for days (contract D8).
	h.seedHpWarrantySchedule(startupNow)
```

Then in the tick body, inside the `h.mu` critical section — after `shouldSendPatch := h.claimPatchScanLocked(now, patchInterval)` (`:1884`) and before `h.mu.Unlock()` (`:1885`) — add:

```go
			shouldCollectHpWarranty := h.claimHpWarrantyCycleLocked(now)
```

and after the `h.mu.Unlock()`, alongside the other post-unlock dispatches, add:

```go
			if shouldCollectHpWarranty {
				go func() {
					defer observability.Recoverer("heartbeat.hpWarranty")
					h.runHpWarrantyCycle(time.Now())
				}()
			}
```

`observability` is already imported and used the same way at `:2135`.

- [ ] **Step 7: Full verification**

```bash
cd agent && go vet ./internal/collectors/... ./internal/heartbeat/...
cd agent && go test -race ./internal/collectors/... ./internal/heartbeat/...
cd agent && GOOS=windows GOARCH=amd64 go build ./... && GOOS=linux GOARCH=amd64 go build ./... && GOOS=darwin GOARCH=arm64 go build ./...
```
Expected: vet clean, all tests PASS, all three cross-compiles succeed. The cross-compiles still earn their place with the struct declared once: the Windows build is the only place the `//go:build windows` entry point, its PowerShell scripts and the tagged half of the tree are compiled at all, and the darwin/linux builds prove the `!windows` stub still satisfies every caller — including `heartbeat.go`, which references `collectors.HpWarrantyInfo` on every platform.

- [ ] **Step 8: Commit**

```bash
git add agent/internal/heartbeat/hp_warranty.go agent/internal/heartbeat/hp_warranty_test.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): run and report the HP warranty cycle on its own persisted cadence (W03)"
```

---

## Verification checklist before opening the PR

- [ ] `cd agent && go test -race ./internal/collectors/... ./internal/heartbeat/...` — green.
- [ ] `cd agent && go vet ./internal/collectors/... ./internal/heartbeat/...` — clean.
- [ ] `cd agent && make build-all` — all platform/arch combinations build.
- [ ] `grep -rn "yusufpapurcu/wmi\|go-ole" agent/internal/collectors/` returns nothing — no WMI binding was introduced.
- [ ] `git diff --stat origin/main -- apps/ packages/ ee/` is **empty** — this wave touches no server, web or shared code.
- [ ] `git diff origin/main -- agent/internal/heartbeat/warranty_config.go` is **empty** (W02 shipped the accessor — the expected case) or **one added line** (the Task 9 Step 5 fallback). Anything more means this wave re-implemented W02's parse.
- [ ] `git diff origin/main -- agent/internal/collectors/warranty_other.go` is **empty** — Apple's `!darwin` stub was not retagged or "tidied".
- [ ] The two build-tagged files declare **no type**: `grep -n "^type " agent/internal/collectors/hp_warranty_windows.go agent/internal/collectors/hp_warranty_other.go` returns nothing, and `grep -c "^type HpWarrantyInfo" agent/internal/collectors/hp_warranty.go` returns `1`. This is D7 as amended (Global Constraints); a second declaration would reintroduce the drift hazard the amendment removed.
- [ ] `agent/internal/collectors/testdata/hp_warranty_wmi_real.json` contains the W01 probe's real capture, and `TestParseHpWarrantyWMI_RealProbeFixture` passes against it without any assertion having been weakened.
- [ ] No test spawns a real process: `grep -n "runCollectorOutput\|exec.Command" agent/internal/collectors/hp_warranty_test.go agent/internal/heartbeat/hp_warranty_test.go` returns nothing.
- [ ] PR body records W01's answer to lab question 1 (does the namespace exist without CMSL) and states which world the fleet is in.
- [ ] PR body includes `Closes #5514`.

---

## Self-review

**1. Spec coverage.** Walking spec layer 5 and layer 6, and contract D7/D8/D9/D10:

| Requirement | Task |
|---|---|
| `hp_warranty_windows.go` + `hp_warranty_other.go`, `(nil, nil)` stub, shared types declared once (D7 as amended) | 1 |
| Do not retag `warranty_other.go` | verified in the pre-PR checklist |
| T0 reads WMI via PowerShell `Get-CimInstance -Namespace`, no Go WMI binding | 3 (+ §0.1 proof) |
| T1 runs `Get-HPWarrantyInfo` only when the data is missing or HP's cache is genuinely stale, then re-reads WMI | 4, 5 |
| T2 — CMSL absent, report nothing, let the policy install it | 5 |
| Report WHY collection failed (PS 5.1 / TLS 1.2 not universal) | 2 (reason codes), 3 (T0 sentinels), 4 (T1 sentinels), 10 (persisted `LastReason` + Warn logs) |
| Scheduling keys off the ACTUAL HP cache timestamp, not a fixed interval | 5 (`hpCacheStale`), 7 (`hpNextDueAt`) |
| Own persisted due time and bounded retries; does not ride `sendInventory` | 7, 8, 10 |
| Distinct first-run/bootstrap behaviour | 7 (`hpBootstrapDueAt`), 10 (`seedHpWarrantySchedule`) |
| Deterministic per-device jitter, honestly described as statistical | 7 (implementation + doc comment + distribution test) |
| Back off on an HP 429 rather than retrying into the limit | 4 (detection), 8 (back-off), 10 (both the error and serve-stale paths) |
| Reuse `sendInventoryData("warranty-info", …)` with the `runtime.GOOS` guard | 10 |
| `source: 'agent_cmsl'`, `manufacturer: 'HP'` | 10 |
| Entitlements written against W01's widened schema/type, never redefined; `provider` omitted | 10 (Interfaces "Consumes"), 6 (bounds) |
| Gated by W02's `warranty_config.go` seam, config parsing not re-implemented | 9 |
| Table-driven tests: tier selection, due time from an HP cache timestamp, jitter determinism + distribution, 429 back-off | 5, 7, 7, 8 |
| Every test passes on a non-Windows runner with the command seam mocked | 3 (`stubHpPowerShell`), 10 (`hpCollectFn`, `hpSendFn`) |

One spec line is **deliberately not implemented here**: "the `runtime.GOOS` guard" appears in Task 10's Interfaces via `sendHpWarrantyInfo`, but the actual early return lives in `hp_warranty_other.go`'s `(nil, nil)` plus `hpCollectFn`. Task 10's cycle therefore runs harmlessly on non-Windows and takes the `info == nil` branch. That is intentional — it keeps the cycle itself testable on CI — and the `runtime.GOOS` belt-and-braces is redundant with a compile-time build tag, which is strictly stronger. Called out here rather than silently dropped.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N", no "write tests for the above". Every code step carries complete Go. The two forward-looking items are both concrete, named, one-line reconciliations against data that does not exist yet (Task 2 Step 1's field-candidate vars, Task 4 Step 5's regex alternation), each pointing at an exact identifier and each guarded by a failing assertion rather than a comment.

**3. Type consistency.** Cross-checked:
- `HpWarrantyInfo` fields — declared **once** in Task 1 Step 3's tag-free file, set in Task 2's parser, mutated in Tasks 5 and 6, read in Task 10's payload builder. `HPCacheTime`, `Tier`, `Reason`, `RateLimited` are `json:"-"`, so the struct's own JSON tags never reach the wire — Task 10 builds the payload explicitly instead of marshalling the struct, which is what keeps the scheduling fields out of the report.
- `HpEntitlement` — four fields, single declaration (Task 1), populated in Task 2, truncated in Task 6, rendered in Task 10. Names match `WarrantyEntitlement` minus `provider` throughout.
- `HpCollectError{Reason, Detail}` — constructed in Tasks 2, 3, 4; matched via `errorsAs` in Tasks 2/3/5 (collectors) and `errorsAsHp` in Task 10 (heartbeat, different package so a separate helper is required, not a duplicate name).
- `hpRunPowerShell(timeout time.Duration, script string) ([]byte, error)` — declared Task 3, overridden in Tasks 3, 4, 5 with the identical signature.
- `hpCacheTTL`/`hpRefreshMargin` — defined once in `collectors` (Task 5), exported (Task 7 Step 3), re-bound in `heartbeat` as aliases so there is exactly one source of truth.
- `hpWarrantyState` field names — written in Task 7, read/written in Tasks 8 (`hpFailureDueAt`) and 10 (`runHpWarrantyCycle`, `seedHpWarrantySchedule`). Consistent.
- `Heartbeat` fields added — `hpWarrantyNextDue`, `hpWarrantyFailures`, `hpWarrantyRateLimitHits`, `hpCmslEnabled`, `hpWarrantyStatePathOverride` (Task 7), `hpSendFn` (Task 10). Every one is referenced by a later task; none is orphaned.

**4. Gaps deliberately left, and who owns them.**
- The exact HP WMI property names and HP's 429 wording are W01 probe outputs, reconciled in Task 2 Step 1 and Task 4 Step 5.
- W02's storage shape for the config flag is unsettled by the *contract* but settled by *W02's plan* (§0.16): a persisted `h.config` field plus a mutex-guarded accessor. Task 9 Step 1 reads the shipped name and gives complete code for that primary path and for the fallback. This is the only place in the wave an implementer chooses between two written implementations, and both are fully specified.
- Manual refresh on an HP device (D11) stays W01's honest 409. This wave adds no trigger to upgrade it to "request agent collection" — doing so needs an `apps/api` route change, which is explicitly out of scope here.

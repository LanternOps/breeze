# Time Sync W01b Agent Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report Windows time configuration, synchronization evidence, domain role, timezone and Time-Service events to the W01a ingest endpoint without changing Windows configuration.

**Architecture:** A fakeable `timesync.System` separates Windows reads from deterministic collection and classification. The collector persists only `sequence` and `eventsSince` in `timesync-state.json` and reads fresh facts on every collection; heartbeat schedules guarded, cancellable collection and PUT delivery. W01a owns findings and health; W03b will add writers and reconciliation.

**Tech Stack:** Go 1.26.6, standard testing/race detector, `golang.org/x/sys/windows`, registry, SCM, netapi32, kernel32, read-only PowerShell event projection, existing heartbeat transport.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-28-time-sync-monitoring-design.md`

**Index:** `docs/superpowers/plans/monitoring/2026-09-28-time-sync.md`

## Global Constraints

All constraints in the index's Global constraints section apply.

- W01a is merged before implementation starts; use schemaVersion `1` and send `enforcement: null`.
- Windows floor: Windows 10 / Server 2016; non-Windows `NewSystem()` returns `nil` and `Collect` returns `nil, nil`.
- Fixed cadence: `30 min ± 10 %`; first run `2–5 min` after start.
- Transport: `sendInventoryData("time-status", snapshot, "time sync")`.
- State filename: `timesync-state.json`, under `config.GetDataDir()`.
- Unknown nullable fields are JSON `null`; known empty collections are `[]`; no `omitempty` on snapshot fields.
- Events: System log, `Microsoft-Windows-Time-Service`, all levels, first window `24 h`, snapshot maximum `100`, display tail `20`, message maximum `1000` UTF-16 units, properties maximum `10`, each maximum `500` UTF-16 units; R5 serialized budget `256 KiB` with display IDs reserved during trimming.
- Status method priority: `provider_api`, `w32tm_tokens`, `events`, `unavailable`; method names never change.
- No agent findings, clock-offset measurement, configuration writes, resync, settings dispatch, reconciliation or command handlers in this PR.
- No migration, database schema, API, shared-validator or web changes in this PR; all relevant contract names come from merged W01a.
- No new Go dependency; `golang.org/x/sys` is already required at `agent/go.mod:33`.
- Lab identifiers and raw lab evidence stay in private operator configuration; public evidence names only the Windows lab VM and the brzlab AD lab.
- Plan-authoring output is this document only. Commands below are implementation instructions, not commands run while authoring.

R7 approves the fallback ladder in advance. Task 1 probes the installed SDK and validates the token/event facts; the complete fallback below ships when method 1 lacks the required evidence. A real provider call ships only with its prototype and buffer ownership cited from the installed Windows SDK `w32time.h` and a passing L1/L3/L5/L9 comparison. Unproven source kinds remain `unknown`; they do not block a fallback release. Do not claim native-provider implementation or successful lab results from this document.

## Review Focus

2. **A non-English Windows** (German display language) — the snapshot must equal the English one
   field-for-field except `events[].message`. W01b lab L9 plus a unit test that feeds the status
   parser German `w32tm` text and asserts only locale-independent fields are extracted.
   Pinned by Tasks 1, 4 and 9; Task 9 explains fixed-input equality versus advancing live timestamps.

- Input: restart or failed PUT after collecting a failure event; expected: fresh facts and a new sequence are collected, uncommitted events are queried again, and the cursor advances only after a qualified API response; pinned by Tasks 7–8.
- Input: missing registry key, failed domain discovery, failed event query, or ambiguous reference token; expected: null/unknown or failed collection, never a fabricated healthy observation; pinned by Tasks 3–7.
- Input: stop while collecting/uploading or simultaneous ticker dispatch; expected: one cycle, cancellation reaches HTTP and exec, tracked goroutines drain; pinned by Task 8.

## File Structure

Every path below is relative to the repository root. New files have no current line number.

| Action | File | Responsibility |
|---|---|---|
| Create, then delete before final PR | `agent/internal/collectors/timesync/spike_windows_test.go` | Opt-in read-only lab probe; export discovery, published RPC layout checks, raw token/event evidence. |
| Create | `agent/internal/collectors/timesync/types.go` | Exact §B snapshot and §F.3 report JSON shapes. |
| Create | `agent/internal/collectors/timesync/types_test.go` | Wire keys, nulls and arrays. |
| Create | `agent/internal/collectors/timesync/hosts.go` | Shared-contract host validator and flag removal. |
| Create | `agent/internal/collectors/timesync/hosts_test.go` | Shared JSON fixture and odd-spacing cases. |
| Create | `agent/internal/collectors/timesync/system.go` | Complete OS-read interface and input facts. |
| Create | `agent/internal/collectors/timesync/fake_test.go` | Controllable fake with no network calls. |
| Create | `agent/internal/mgmtdetect/identity.go` | Minimal exported wrapper for existing identity detection. |
| Create | `agent/internal/mgmtdetect/identity_test.go` | Wrapper signature and unsupported-platform behavior. |
| Create | `agent/internal/collectors/timesync/domain.go` | Fail-closed role derivation and exact DNS-name comparison. |
| Create | `agent/internal/collectors/timesync/domain_test.go` | All roles, error boundaries and child-domain PDC. |
| Create | `agent/internal/collectors/timesync/status.go` | Provider/token/event ladder and source classification. |
| Create | `agent/internal/collectors/timesync/status_test.go` | Every source kind, both ladders, German tokens and ambiguity. |
| Create | `agent/internal/collectors/timesync/events.go` | Bounded union of new events and recent display events. |
| Create | `agent/internal/collectors/timesync/events_test.go` | Cursors, sorting, deduplication and UTF-16 caps. |
| Create | `agent/internal/collectors/timesync/system_windows.go` | Registry, SCM, native domain/timezone reads and status adapter. |
| Create | `agent/internal/collectors/timesync/system_events_windows.go` | Read-only all-level structured event query. |
| Create | `agent/internal/collectors/timesync/system_windows_test.go` | Native layout and command/query contract tests. |
| Create | `agent/internal/collectors/timesync/system_other.go` | Nil constructor on other platforms. |
| Create | `agent/internal/collectors/timesync/system_other_test.go` | Non-Windows silence. |
| Create | `agent/internal/collectors/command_export.go` | Context-aware wrapper over existing bounded command runner. |
| Create | `agent/internal/collectors/command_export_test.go` | Wrapper cancellation behavior. |
| Create | `agent/internal/collectors/timesync/collector.go` | Fresh fact collection, sequence allocation and `Commit(*Snapshot)` seam. |
| Create | `agent/internal/collectors/timesync/persist.go` | Bounded atomic JSON state, corruption recovery, sequence allocation. |
| Create | `agent/internal/collectors/timesync/collector_test.go` | Watermark, restart, write failure, concurrency and unknowns. |
| Create | `agent/internal/heartbeat/time_sync.go` | First-run timer, jitter, single-flight send, qualified response/commit and stop. |
| Create | `agent/internal/heartbeat/time_sync_test.go` | Scheduling, PUT, panic and cancellation tests. |
| Modify | `agent/internal/heartbeat/heartbeat.go:30,456,1002,1004,1845,2052,2136,2154,2175,2341,2361` | Mirror every hardware lifecycle wiring site. |
| Create | `agent/internal/collectors/timesync/live_windows_test.go` | Opt-in native lab assertions and sanitized evidence checks. |

Template audit: `git show --stat ddfcd2a044`, `8d79246f47`, `b9b294e759`, and `57c10e0c4f` were inspected. Agent-core package/persistence/tests and all heartbeat lifecycle sites from `8d79246f47` apply. Hardware policy settings are configurable; W01b's schedule is fixed, so its config additions do not apply. API registrations, monitor handlers and UI sites in the other commits are W01a/W02/W03a responsibilities. Follow current `hwhealth/persist.go:28–109` and `hardware_health.go:72–187`, including fixes since those commits.

### Task 1: Run the status-source spike before choosing a production ladder

**Files:**
- Create: `agent/internal/collectors/timesync/spike_windows_test.go` (temporary; build tag `windows && timesync_spike`).
- Read: `agent/internal/collectors/eventlogs_windows.go:248–282` (existing level-filtered query is unsuitable).
- Read: `agent/installer/breeze.wxs:137` (OS floor).

**Interfaces:**
- Consumes: `syscall.NewLazyDLL(string) *syscall.LazyDLL`, `(*syscall.LazyProc).Find() error`, Windows SDK headers on the lab machine.
- Produces: PR evidence for method 1 export/ABI availability, method 2 invariant tokens and method 3 insertion strings; no shipped API.

Choose a tagged `_windows_test.go` rather than an enrolled probe command. It runs through the Go test runner, cannot start a second agent, and has no entry in the production binary. The `timesync_spike` tag keeps OS-dependent reads out of ordinary unit tests. `TIMESYNC_SPIKE=1` is an additional opt-in. Capture stdout privately because source peers may identify infrastructure.

- [ ] Write the failing ABI-layout test first (the remainder of this file is supplied in the next step):

```go
//go:build windows && timesync_spike

package timesync

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestSpikePublishedRPCLayouts(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("this probe checks amd64 layouts")
	}
	if unsafe.Sizeof(w32timeNTPProviderData{}) != 24 {
		t.Fatal("provider layout is not 24 bytes")
	}
	if unsafe.Sizeof(w32timeNTPPeerInfo{}) != 56 {
		t.Fatal("peer layout is not 56 bytes")
	}
	if unsafe.Offsetof(w32timeNTPPeerInfo{}.WszUniqueName) != 40 {
		t.Fatal("peer name offset is not 40")
	}
}

func TestTimeSyncStatusSpike(t *testing.T) {
	if os.Getenv("TIMESYNC_SPIKE") != "1" {
		t.Skip("explicit native lab opt-in required")
	}
	p := syscall.NewLazyDLL("w32time.dll").NewProc("W32TimeQueryNTPProviderStatus")
	t.Logf("method1 export lookup: %v", p.Find())
	t.Log("method1 invocation disabled: export presence does not establish DLL ABI or free function")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "w32tm.exe", "/query", "/status", "/verbose").CombinedOutput()
	t.Logf("method2 exit=%v raw=%q", err, output)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel2()
	output, err = exec.CommandContext(ctx2, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", spikeEvents).CombinedOutput()
	if err != nil {
		t.Fatalf("method3 query failed: %v: %s", err, output)
	}
	var rows []map[string]any
	if err = json.Unmarshal(output, &rows); err != nil {
		t.Fatalf("method3 JSON: %v: %s", err, output)
	}
	for _, row := range rows {
		t.Logf("method3 %s", mustSpikeJSON(row))
	}
}

func mustSpikeJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(err)
	}
	return string(b)
}
```

- [ ] Run from the repository root:

```bash
(cd agent && GOOS=windows GOARCH=amd64 go test -c -tags timesync_spike -o /tmp/timesync-spike.test.exe ./internal/collectors/timesync)
```

Expected FAIL: `undefined: w32timeNTPProviderData`, `undefined: w32timeNTPPeerInfo`, `undefined: spikeEvents`.

- [ ] Append the following actual declarations and read-only probe script to the same file:

```go
// W32TIME_NTP_PROVIDER_DATA and W32TIME_NTP_PEER_INFO from MS-W32T.
// These are published RPC data declarations, NOT a verified DLL-call contract.
// Do not cast a DLL return buffer to either until its actual SDK ABI is established.
type w32timeNTPProviderData struct {
	UlSize       uint32
	UlError      uint32
	UlErrorMsgId uint32
	CPeerInfo    uint32
	PPeerInfo    *w32timeNTPPeerInfo
}

type w32timeNTPPeerInfo struct {
	UlSize                uint32
	UlResolveAttempts     uint32
	U64TimeRemaining      uint64
	U64LastSuccessfulSync uint64
	UlLastSyncError       uint32
	UlLastSyncErrorMsgId  uint32
	UlValidDataCounter    uint32
	UlAuthTypeMsgId       uint32
	WszUniqueName         *uint16
	UlMode                byte
	UlStratum             byte
	UlReachability        byte
	UlPeerPollInterval    byte
	UlHostPollInterval    byte
}

const spikeEvents = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
try {
  $r=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Time-Service';Id=35,37;StartTime=(Get-Date).AddDays(-1)} -MaxEvents 20 -ErrorAction Stop)
} catch {
  if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
  $r=@()
}
$a=@($r | ForEach-Object {
  [pscustomobject]@{
    recordId=[long]$_.RecordId; eventId=[int]$_.Id;
    occurredAt=$_.TimeCreated.ToUniversalTime().ToString('o');
    properties=@($_.Properties | ForEach-Object { [Convert]::ToString($_.Value,[Globalization.CultureInfo]::InvariantCulture) });
    message=[string]$_.Message
  }
}); ConvertTo-Json -InputObject $a -Depth 5 -Compress`
```

The layout sources are Microsoft's [W32TIME_NTP_PROVIDER_DATA](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-w32t/38cfb2cc-e996-4ec0-bc96-aad3fb7ca5d8) and [W32TIME_NTP_PEER_INFO](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-w32t/123072f7-8031-4e17-b1ae-f1c04348332e). The documented [W32TimeQueryProviderStatus RPC](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-w32t/ac3eb99f-1d01-4535-8ff5-2bf9d7dbb106) requires an RPC binding handle; it is not evidence for calling a same-looking DLL export. Never substitute its signature.

- [ ] Re-run the cross-build; expected PASS. On each native Windows lab machine, in the source checkout's `agent` directory:

```powershell
$env:TIMESYNC_SPIKE='1'
go test -race -tags timesync_spike -v ./internal/collectors/timesync/... -run 'TestSpikePublishedRPCLayouts|TestTimeSyncStatusSpike'
Remove-Item Env:TIMESYNC_SPIKE
```

- [ ] Inspect the installed SDK declarations before any native method-1 call:

```powershell
$headers=Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Include" -Filter w32time.h -Recurse -ErrorAction SilentlyContinue
$headers | ForEach-Object { Select-String -Path $_.FullName -Pattern 'W32TimeQueryNTPProviderStatus|W32TIME_NTP_PROVIDER_DATA|W32TIME_NTP_PEER_INFO' -Context 8,32 }
```

Record SDK version, OS build/architecture, exact prototype, ownership/free function, whether `u64LastSuccessfulSync` is an NTP fixed-point timestamp or FILETIME, polling-interval units, and how an active peer is distinguished from merely configured peers. The layouts above alone establish none of these. If there is no authoritative callable prototype, record method 1 as **ABI unavailable**, not as “API absent” when `Find` succeeds. Under R7 this gates only method 1; the fallback release is already approved. Require the installed `w32time.h` prototype/ownership citation and passing L1/L3/L5/L9 comparison before enabling method 1.

- [ ] Run the probe in English and German, also on Windows 10 and Server 2016 floor images. Evaluate in order:
  1. Export plus verified ABI; do not invoke an unknown prototype.
  2. Compare nine-line status order, reference-ID token, numeric stratum/poll exponent and whether special source tags distinguish local/free-running/VM-host states.
  3. Compare events 35/37 property arrays, their provider metadata, source spelling and UTC times; message wording is irrelevant.

Use local-clock, unsynchronized, VMIC, domain-hierarchy and manual-peer setups from Task 9. A numeric ReferenceId is not a source address. `LOCL` by itself is not proof of local-clock versus free-running distinction. Do not take a localized source phrase or localized last-sync date from method 2.

- [ ] Record this evidence table in the PR description, filling observed values from the probe, not from this plan:

| Method | English / German | Windows 10 / Server 2016 | Values actually established | Ownership / units established | Decision |
|---|---|---|---|---|---|
| DLL export + verified ABI | Record actual result | Record actual result | Active source and each nullable field separately | Prototype and allocator reference | Keep only with verified ABI |
| w32tm invariant tokens | Record actual result | Record actual result | Numeric stratum/poll; verified tags only | Seconds = 2^poll exponent | Keep only validated fields |
| events 35/37 properties | Record actual result | Record actual result | Source and last-known-good time | UTC SystemTime and insertion index | Runtime fallback |

- [ ] Select the ladder exactly. Task 4 supplies provider-first and fallback logic behind `System.ProviderStatus`; Task 6 supplies an explicit unavailable adapter because the DLL ABI is unverified. If native method 1 is ruled out, retain that adapter and delete the temporary probe at Task 9. If a verified method-1 implementation is supplied after satisfying R7's installed-SDK and L1/L3/L5/L9 requirements, replace **only** `windowsSystem.ProviderStatus`; retain method 2 and method 3 for runtime failures. Do not delete runtime fallbacks merely because the primary works on one machine. If method 2's positions are not stable on all tested versions/languages, replace the body of `parseW32tmTokens` with the exact alternative in Task 4. Do not silently enable any special source tag that this spike did not establish.

- [ ] Commit the spike only as a temporary implementation checkpoint; it must be removed before the final PR:

```bash
git add agent/internal/collectors/timesync/spike_windows_test.go
git commit -m "test(agent): probe time status sources on Windows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Define the wire contract, host rules and fakeable read boundary

**Files:**
- Create: `agent/internal/collectors/timesync/{types.go,types_test.go,hosts.go,hosts_test.go,system.go,fake_test.go}`.
- Read: `packages/shared/src/validators/timeSync.ts` and `__fixtures__/ntpServers.json` (W01a §B).
- Read: `agent/internal/collectors/hwhealth/types_test.go:12–65`, `persist_test.go:10–75`, `collector_test.go:27–47` for existing test style.

**Interfaces:**
- Consumes: exact §B JSON fields, §F.3 `EnforcementReport`, `mgmtdetect.IdentityStatus` (`types.go:98`).
- Produces: `ParseNtpServerHosts(raw string) []string`, `IsValidNtpServerHost(s string) bool`, `System`, `Snapshot`, nested wire types and `EnforcementReport`.

- [ ] Write `types_test.go` and `hosts_test.go`:

```go
// types_test.go
package timesync

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestWireKeysAndNulls(t *testing.T) {
	s := emptySnapshot(time.Unix(1, 0).UTC())
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]json.RawMessage
	if err = json.Unmarshal(b, &root); err != nil {
		t.Fatal(err)
	}
	keys := func(m map[string]json.RawMessage) []string {
		k := make([]string, 0, len(m))
		for n := range m {
			k = append(k, n)
		}
		sort.Strings(k)
		return k
	}
	want := strings.Fields("collectedAt config domain enforcement events schemaVersion sequence status timezone")
	if !reflect.DeepEqual(keys(root), want) {
		t.Fatal(string(b))
	}
	for field, expected := range map[string]string{"enforcement": "null", "events": "[]", "schemaVersion": "1"} {
		if string(root[field]) != expected {
			t.Fatalf("%s=%s", field, root[field])
		}
	}
	for field, expected := range map[string]string{
		"config":   "hostTimeProviderEnabled ntpServer policyManaged policyManagedValues serviceStartType serviceState specialPollIntervalSeconds type",
		"status":   "lastSuccessfulSyncAt lastSyncError method pollIntervalSeconds source sourceKind stratum",
		"domain":   "domainDns forestDns joinType pdcName role",
		"timezone": "autoUpdate biasMinutes dynamicDstDisabled windowsId",
	} {
		var nested map[string]json.RawMessage
		if err := json.Unmarshal(root[field], &nested); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(keys(nested), strings.Fields(expected)) {
			t.Fatalf("%s keys=%v", field, keys(nested))
		}
	}
	if strings.Contains(string(b), `:""`) {
		t.Fatal("unknown serialized as empty string")
	}
	var status map[string]json.RawMessage
	_ = json.Unmarshal(root["status"], &status)
	for _, name := range []string{"source", "lastSuccessfulSyncAt", "lastSyncError", "stratum", "pollIntervalSeconds"} {
		if string(status[name]) != "null" {
			t.Fatalf("%s not null", name)
		}
	}
}
```

```go
// hosts_test.go
package timesync

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestSharedHostFixture(t *testing.T) {
	b, err := os.ReadFile("../../../../packages/shared/src/validators/__fixtures__/ntpServers.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	}
	if err = json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Valid) == 0 || len(f.Invalid) == 0 {
		t.Fatal("empty shared fixture")
	}
	for _, s := range f.Valid {
		if !IsValidNtpServerHost(s) {
			t.Errorf("valid host rejected: %q", s)
		}
	}
	for _, s := range f.Invalid {
		if IsValidNtpServerHost(s) {
			t.Errorf("invalid host accepted: %q", s)
		}
	}
}

func TestParseNtpServerHosts(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want []string
	}{
		{"  time.a.com,0x9   time.b.com,0x8  ", []string{"time.a.com", "time.b.com"}},
		{"time.a.com,0x1,0x8", []string{"time.a.com"}},
		{"", []string{}},
		{"\tpeer.example.com,0x9\npeer.example.com,0x8", []string{"peer.example.com", "peer.example.com"}},
	} {
		if got := ParseNtpServerHosts(tc.raw); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%q: %v", tc.raw, got)
		}
	}
}
```

- [ ] Run: `cd agent && go test -race ./internal/collectors/timesync/...`; expected FAIL: `undefined: emptySnapshot`, `undefined: IsValidNtpServerHost`.

- [ ] Create `types.go`:

```go
package timesync

import "time"

type Snapshot struct {
	SchemaVersion int                `json:"schemaVersion"`
	Sequence      uint64             `json:"sequence"`
	CollectedAt   time.Time          `json:"collectedAt"`
	Config        Config             `json:"config"`
	Status        Status             `json:"status"`
	Domain        Domain             `json:"domain"`
	Timezone      Timezone           `json:"timezone"`
	Events        []Event            `json:"events"`
	Enforcement   *EnforcementReport `json:"enforcement"`
}

type Config struct {
	Type                       *string  `json:"type"`
	NtpServer                  *string  `json:"ntpServer"`
	SpecialPollIntervalSeconds *uint32  `json:"specialPollIntervalSeconds"`
	PolicyManaged              bool     `json:"policyManaged"`
	PolicyManagedValues        []string `json:"policyManagedValues"`
	ServiceState               string   `json:"serviceState"`
	ServiceStartType           string   `json:"serviceStartType"`
	HostTimeProviderEnabled    *bool    `json:"hostTimeProviderEnabled"`
}

type Status struct {
	Method               string     `json:"method"`
	Source               *string    `json:"source"`
	SourceKind           string     `json:"sourceKind"`
	LastSuccessfulSyncAt *time.Time `json:"lastSuccessfulSyncAt"`
	LastSyncError        *string    `json:"lastSyncError"`
	Stratum              *int       `json:"stratum"`
	PollIntervalSeconds  *uint32    `json:"pollIntervalSeconds"`
}

type Domain struct {
	JoinType  string  `json:"joinType"`
	Role      string  `json:"role"`
	DomainDNS *string `json:"domainDns"`
	ForestDNS *string `json:"forestDns"`
	PDCName   *string `json:"pdcName"`
}

type Timezone struct {
	WindowsID          *string `json:"windowsId"`
	BiasMinutes        *int32  `json:"biasMinutes"`
	DynamicDSTDisabled *bool   `json:"dynamicDstDisabled"`
	AutoUpdate         string  `json:"autoUpdate"`
}

type Event struct {
	RecordID   uint64    `json:"recordId"`
	EventID    uint32    `json:"eventId"`
	Level      int       `json:"level"`
	OccurredAt time.Time `json:"occurredAt"`
	Message    string    `json:"message"`
	Properties []string  `json:"properties"`
	// In-memory selection metadata only; never part of the wire or disk state.
	displayReserved bool
}

type EnforcementResult struct {
	ResultID    string         `json:"resultId"`
	Fingerprint string         `json:"fingerprint"`
	At          time.Time      `json:"at"`
	Outcome     string         `json:"outcome"`
	Reason      string         `json:"reason"`
	Before      map[string]any `json:"before"`
	After       map[string]any `json:"after"`
	Error       *string        `json:"error"`
}

type EnforcementReport struct {
	NTP      *EnforcementResult `json:"ntp"`
	Timezone *EnforcementResult `json:"timezone"`
}

func ptr[T any](v T) *T     { return &v }
func unknownStatus() Status { return Status{Method: "unavailable", SourceKind: "unknown"} }
func emptySnapshot(at time.Time) Snapshot {
	return Snapshot{
		SchemaVersion: 1, CollectedAt: at.UTC(),
		Config: Config{PolicyManagedValues: []string{}, ServiceState: "unknown", ServiceStartType: "unknown"},
		Status: unknownStatus(), Domain: Domain{JoinType: "unknown", Role: "unknown"},
		Timezone: Timezone{AutoUpdate: "unknown"}, Events: []Event{},
	}
}
```

`EnforcementResult` matches §F.3 keys but is not populated in W01b. W03b must restrict `Before`/`After` values to string, number, boolean or nil and validate its enum strings before sending; an `any` map is not permission to send nested objects. Using pointers here preserves the wire's nullability without inventing absent-field semantics.

- [ ] Create `hosts.go`:

```go
package timesync

import (
	"net/netip"
	"regexp"
	"strings"
)

var hostLabel = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
var peerFlags = regexp.MustCompile(`(?i)(?:,0x[0-9a-f]+)+$`)

func IsValidNtpServerHost(s string) bool {
	if len(s) == 0 || len(s) > 253 {
		return false
	}
	if ip, err := netip.ParseAddr(s); err == nil {
		return ip.Zone() == ""
	}
	for _, label := range strings.Split(s, ".") {
		if !hostLabel.MatchString(label) {
			return false
		}
	}
	return true
}

func ParseNtpServerHosts(raw string) []string {
	out := []string{}
	for _, item := range strings.Fields(raw) {
		out = append(out, peerFlags.ReplaceAllString(item, ""))
	}
	return out
}
```

- [ ] Create `system.go` and `fake_test.go`. The fake's default error is deliberate: unconfigured reads cannot become zero-valued facts.

```go
// system.go
package timesync

import (
	"context"
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/mgmtdetect"
)

var errUnavailable = errors.New("time sync read unavailable")

const serviceKey = `SYSTEM\CurrentControlSet\Services\W32Time`
const policyKey = `SOFTWARE\Policies\Microsoft\W32Time`

type RoleInfo struct {
	MachineRole          uint32
	DomainDNS, ForestDNS string
}
type ServiceInfo struct{ State, StartType string }

type System interface {
	ReadString(context.Context, string, string) (string, error)
	ReadDWORD(context.Context, string, string) (uint32, error)
	ValueNames(context.Context, string) ([]string, error)
	W32TimeService(context.Context) (ServiceInfo, error)
	ProviderStatus(context.Context) (Status, error)
	W32tmStatus(context.Context) ([]byte, error)
	Events(context.Context, time.Time, time.Time, int) ([]Event, error)
	RecentEvents(context.Context, time.Time, int) ([]Event, error)
	Identity(context.Context) (mgmtdetect.IdentityStatus, error)
	PrimaryDomain(context.Context) (RoleInfo, error)
	PDC(context.Context, string) (string, error)
	ComputerDNSName(context.Context) (string, error)
	DynamicTimezone(context.Context) (Timezone, error)
}
```

```go
// fake_test.go
package timesync

import (
	"context"
	"time"

	"github.com/breeze-rmm/agent/internal/mgmtdetect"
)

type fakeSystem struct {
	strings                                map[string]string
	dwords                                 map[string]uint32
	names                                  map[string][]string
	namesErr                               map[string]error
	service                                ServiceInfo
	identity                               mgmtdetect.IdentityStatus
	role                                   RoleInfo
	pdc, computer                          string
	provider                               Status
	providerErr                            error
	tokens                                 []byte
	events, recent                         []Event
	eventErr, roleErr, pdcErr, computerErr error
	zone                                   Timezone
	since, until                           time.Time
}

func (f *fakeSystem) ReadString(_ context.Context, p, n string) (string, error) {
	v, ok := f.strings[p+"|"+n]
	if !ok {
		return "", errUnavailable
	}
	return v, nil
}
func (f *fakeSystem) ReadDWORD(_ context.Context, p, n string) (uint32, error) {
	v, ok := f.dwords[p+"|"+n]
	if !ok {
		return 0, errUnavailable
	}
	return v, nil
}
func (f *fakeSystem) ValueNames(_ context.Context, p string) ([]string, error) {
	v, ok := f.names[p]
	if err := f.namesErr[p]; err != nil {
		return v, err
	}
	if !ok {
		return nil, errUnavailable
	}
	return v, nil
}
func (f *fakeSystem) W32TimeService(context.Context) (ServiceInfo, error) {
	if f.service.State == "" {
		return ServiceInfo{}, errUnavailable
	}
	return f.service, nil
}
func (f *fakeSystem) ProviderStatus(context.Context) (Status, error) {
	if f.provider.Source == nil {
		return unknownStatus(), errUnavailable
	}
	return f.provider, f.providerErr
}
func (f *fakeSystem) W32tmStatus(context.Context) ([]byte, error) {
	if f.tokens == nil {
		return nil, errUnavailable
	}
	return f.tokens, nil
}
func (f *fakeSystem) Events(_ context.Context, a, b time.Time, _ int) ([]Event, error) {
	f.since = a
	f.until = b
	return f.events, f.eventErr
}
func (f *fakeSystem) RecentEvents(context.Context, time.Time, int) ([]Event, error) {
	return f.recent, f.eventErr
}
func (f *fakeSystem) Identity(context.Context) (mgmtdetect.IdentityStatus, error) {
	if f.identity.Source == "" {
		return f.identity, errUnavailable
	}
	return f.identity, nil
}
func (f *fakeSystem) PrimaryDomain(context.Context) (RoleInfo, error) { return f.role, f.roleErr }
func (f *fakeSystem) PDC(context.Context, string) (string, error)     { return f.pdc, f.pdcErr }
func (f *fakeSystem) ComputerDNSName(context.Context) (string, error) {
	return f.computer, f.computerErr
}
func (f *fakeSystem) DynamicTimezone(context.Context) (Timezone, error) {
	if f.zone.WindowsID == nil {
		return Timezone{}, errUnavailable
	}
	return f.zone, nil
}
```

- [ ] Re-run `cd agent && go test -race ./internal/collectors/timesync/...`; expected PASS with the merged W01a fixture. Verify Windows compile: `cd agent && GOOS=windows go vet ./internal/collectors/timesync/...`.
- [ ] Commit:

```bash
git add agent/internal/collectors/timesync/types.go agent/internal/collectors/timesync/types_test.go agent/internal/collectors/timesync/hosts.go agent/internal/collectors/timesync/hosts_test.go agent/internal/collectors/timesync/system.go agent/internal/collectors/timesync/fake_test.go
git commit -m "feat(agent): define time sync snapshot and read interface" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Reuse identity detection and derive every domain role

**Files:**
- Create: `agent/internal/mgmtdetect/{identity.go,identity_test.go}`.
- Create: `agent/internal/collectors/timesync/{domain.go,domain_test.go}`.
- Read: `agent/internal/mgmtdetect/deep_identity_windows.go:13–43`, `deep_identity.go:5–47`, `types.go:98–116`.

**Interfaces:**
- Consumes: `System.Identity`, `PrimaryDomain`, `PDC`, `ComputerDNSName` from Task 2.
- Produces: `mgmtdetect.CollectIdentityStatus() IdentityStatus`; `readDomain(ctx context.Context, sys System) Domain`.

- [ ] Write `identity_test.go`:

```go
package mgmtdetect

import (
	"runtime"
	"testing"
)

func TestCollectIdentityStatusPublicWrapper(t *testing.T) {
	var collect func() IdentityStatus = CollectIdentityStatus
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return
	}
	got := collect()
	if got.DetectionSupported() {
		t.Fatal("unsupported platform advertised identity detection")
	}
}
```

Write `domain_test.go`:

```go
package timesync

import (
	"context"
	"testing"

	"github.com/breeze-rmm/agent/internal/mgmtdetect"
)

func TestDomainRoles(t *testing.T) {
	for _, tc := range []struct {
		join                             string
		machine                          uint32
		domain, forest, pdc, local, want string
	}{
		{"none", 0, "", "", "", "", "workgroup"},
		{"workplace", 0, "", "", "", "", "workgroup"},
		{"azure_ad", 0, "", "", "", "", "entra_only"},
		{"on_prem_ad", 1, "ad.example.com", "ad.example.com", "pdc.ad.example.com", "member.ad.example.com", "member"},
		{"hybrid_azure_ad", 3, "ad.example.com", "ad.example.com", "pdc.ad.example.com", "member.ad.example.com", "member"},
		{"on_prem_ad", 4, "ad.example.com", "ad.example.com", "pdc.ad.example.com", "dc.ad.example.com", "dc"},
		{"on_prem_ad", 5, "child.example.com", "example.com", "pdc.child.example.com", "PDC.CHILD.EXAMPLE.COM.", "pdc_emulator"},
		{"on_prem_ad", 5, "EXAMPLE.COM", "example.com", `\\pdc.example.com`, "pdc.example.com", "forest_root_pdc_emulator"},
		{"unknown", 0, "", "", "", "", "unknown"},
		{"on_prem_ad", 0, "ad.example.com", "ad.example.com", "pdc.ad.example.com", "pdc.ad.example.com", "unknown"},
	} {
		t.Run(tc.join+"/"+tc.want, func(t *testing.T) {
			f := &fakeSystem{identity: mgmtdetect.IdentityStatus{JoinType: mgmtdetect.JoinType(tc.join), Source: "dsregcmd"},
				role: RoleInfo{tc.machine, tc.domain, tc.forest}, pdc: tc.pdc, computer: tc.local}
			got := readDomain(context.Background(), f)
			if got.Role != tc.want {
				t.Fatalf("got %+v, want %s", got, tc.want)
			}
			if tc.pdc != "" && got.PDCName == nil {
				t.Fatal("resolved PDC omitted")
			}
		})
	}
}

func TestDomainFailuresAreUnknown(t *testing.T) {
	for _, fail := range []string{"identity", "role", "pdc", "computer", "missing_forest", "short_name", "identity_fallback"} {
		t.Run(fail, func(t *testing.T) {
			f := &fakeSystem{identity: mgmtdetect.IdentityStatus{JoinType: mgmtdetect.JoinTypeOnPremAD, Source: "dsregcmd"},
				role: RoleInfo{5, "ad.example.com", "ad.example.com"}, pdc: "pdc.ad.example.com", computer: "pdc.ad.example.com"}
			switch fail {
			case "identity":
				f.identity.Source = ""
			case "role":
				f.roleErr = errUnavailable
			case "pdc":
				f.pdcErr = errUnavailable
			case "computer":
				f.computerErr = errUnavailable
			case "missing_forest":
				f.role.ForestDNS = ""
			case "short_name":
				f.computer = "pdc"
			case "identity_fallback":
				f.identity.JoinType = mgmtdetect.JoinTypeNone
				f.identity.Source = "dsregcmd_error_no_fallback"
			}
			if got := readDomain(context.Background(), f); got.Role != "unknown" {
				t.Fatalf("%s: %+v", fail, got)
			}
		})
	}
}
```

- [ ] Run `cd agent && go test -race ./internal/mgmtdetect/... ./internal/collectors/timesync/...`; expected FAIL: `undefined: CollectIdentityStatus`, `undefined: readDomain`.
- [ ] Create `identity.go`:

```go
package mgmtdetect

// CollectIdentityStatus reuses the existing platform detector without running
// management-product discovery. Callers must inspect Source for failed detection.
func CollectIdentityStatus() IdentityStatus { return collectIdentityStatus() }
```

Create `domain.go`:

```go
package timesync

import (
	"context"
	"strings"
)

func nullableText(s string, max int) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return ptr(limitText(s, max))
}

func dnsName(s string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimLeft(strings.TrimSpace(s), `\`), "."))
}

func readDomain(ctx context.Context, sys System) Domain {
	d := Domain{JoinType: "unknown", Role: "unknown"}
	id, err := sys.Identity(ctx)
	if err != nil || !id.DetectionSupported() || id.Source == "dsregcmd_error_no_fallback" {
		return d
	}
	switch string(id.JoinType) {
	case "none", "workplace":
		d.JoinType = string(id.JoinType)
		d.Role = "workgroup"
		return d
	case "azure_ad":
		d.JoinType = "azure_ad"
		d.Role = "entra_only"
		return d
	case "on_prem_ad", "hybrid_azure_ad":
		d.JoinType = string(id.JoinType)
	default:
		return d
	}
	// dsregcmd's DomainName can be a NetBIOS name; only DsRole supplies domainDns.
	role, err := sys.PrimaryDomain(ctx)
	if err != nil {
		return d
	}
	d.DomainDNS = nullableText(role.DomainDNS, 255)
	d.ForestDNS = nullableText(role.ForestDNS, 255)
	if d.DomainDNS == nil || d.ForestDNS == nil {
		return d
	}
	pdc, pdcErr := sys.PDC(ctx, role.DomainDNS)
	if pdcErr == nil {
		d.PDCName = nullableText(dnsName(pdc), 255)
	}
	// Discovery failure remains fail-closed even on a known member.
	if pdcErr != nil || d.PDCName == nil {
		return d
	}
	switch role.MachineRole {
	case 1, 3:
		d.Role = "member"
		return d
	case 4, 5:
		local, err := sys.ComputerDNSName(ctx)
		if err != nil || !strings.Contains(local, ".") {
			return d
		}
		if dnsName(local) != dnsName(pdc) {
			d.Role = "dc"
			return d
		}
		d.Role = "pdc_emulator"
		if strings.EqualFold(role.DomainDNS, role.ForestDNS) {
			d.Role = "forest_root_pdc_emulator"
		}
	}
	return d
}
```

`nullableText` needs the following complete helper now, at the bottom of `domain.go`; Task 5 reuses it. Zod `.max()` measures JavaScript UTF-16 units, not bytes or Unicode scalar values.

```go
func limitText(s string, max int) string {
	used := 0
	var b strings.Builder
	for _, r := range s {
		n := 1
		if r > 0xffff {
			n = 2
		}
		if used+n > max {
			break
		}
		b.WriteRune(r)
		used += n
	}
	return b.String()
}
```

- [ ] Re-run the same race command; expected PASS. Run `cd agent && GOOS=windows go vet ./internal/mgmtdetect/... ./internal/collectors/timesync/...`; expected PASS.
- [ ] Commit:

```bash
git add agent/internal/mgmtdetect/identity.go agent/internal/mgmtdetect/identity_test.go agent/internal/collectors/timesync/domain.go agent/internal/collectors/timesync/domain_test.go
git commit -m "feat(agent): derive time sync domain role from native facts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Implement the provider-first ladder and conservative fallback

**Files:**
- Create: `agent/internal/collectors/timesync/{status.go,status_test.go}`.

**Interfaces:**
- Consumes: `System.ProviderStatus(context.Context) (Status,error)`, `W32tmStatus(context.Context) ([]byte,error)`, `[]Event`.
- Produces: `readStatus(ctx context.Context, sys System, events []Event) Status` and `parseW32tmTokens(raw string) Status`.

This implementation never parses the localized source line or date line. Numeric fields may be read by position only after Task 1 proves that layout on the floor and German images. Unproven special tags deliberately produce no source. In the fallback branch, a structured event supplies source; method stays `events` even when numeric fields came from w32tm. Configured `NtpServer` is never substituted for an observed source.

- [ ] Write `status_test.go`:

```go
package timesync

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

const germanStatus = `Sprungindikator: 0(keine Warnung)
Stratum: 4 (Sekundärreferenz)
Präzision: -23
Stammverzögerung: 0.001s
Stammabweichung: 0.004s
Referenz-ID: 0x4C4F434C (Quellenname: "LOCL")
Letzte erfolgreiche Synchronisierungszeit: 28.09.2026 14:00:00
Quelle: Lokale CMOS-Uhr
Abrufintervall: 6 (64s)
Phasenoffset: 0.00001s`

func TestGermanTokensNeverParseTranslatedValues(t *testing.T) {
	got := parseW32tmTokens(germanStatus)
	if got.Source != nil || got.LastSuccessfulSyncAt != nil || got.LastSyncError != nil || got.SourceKind != "unknown" {
		t.Fatalf("localized or ambiguous value inferred: %+v", got)
	}
	if got.Stratum == nil || *got.Stratum != 4 || got.PollIntervalSeconds == nil || *got.PollIntervalSeconds != 64 {
		t.Fatal(got)
	}
	english := strings.NewReplacer("Sprungindikator", "Leap Indicator", "Stratum", "Stratum",
		"Präzision", "Precision", "Stammverzögerung", "Root Delay", "Stammabweichung", "Root Dispersion",
		"Referenz-ID", "ReferenceId", "Letzte erfolgreiche Synchronisierungszeit", "Last Successful Sync Time",
		"Quelle", "Source", "Abrufintervall", "Poll Interval", "Lokale CMOS-Uhr", "Local CMOS Clock").Replace(germanStatus)
	if other := parseW32tmTokens(english); !reflect.DeepEqual(got, other) {
		t.Fatalf("locale changed facts: %+v %+v", got, other)
	}
	for _, raw := range []string{"", "Quelle: Zeitserver", strings.Replace(germanStatus, "0x4C4F434C", "bad-reference", 1)} {
		got := parseW32tmTokens(raw)
		if got.Source != nil || got.Stratum != nil || got.PollIntervalSeconds != nil {
			t.Fatalf("malformed layout accepted: %+v", got)
		}
	}
}

func TestProviderKindsAndLadder(t *testing.T) {
	for _, kind := range []string{"ntp_peer", "domain_peer", "local_clock", "free_running", "vm_host", "unknown"} {
		f := &fakeSystem{provider: Status{Source: ptr("structured source"), SourceKind: kind, Stratum: ptr(2)}}
		got := readStatus(context.Background(), f, nil)
		if got.Method != "provider_api" || got.SourceKind != kind || *got.Source != "structured source" {
			t.Fatal(got)
		}
	}
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	success := Event{EventID: 37, OccurredAt: at, Properties: []string{"peer.example.com,0x9 (ntp.m|0x9|transport)"}}
	for _, tc := range []struct{ typ, role, kind string }{
		{"NTP", "workgroup", "ntp_peer"}, {"NT5DS", "member", "domain_peer"}, {"AllSync", "member", "unknown"},
	} {
		e := success
		if tc.kind == "domain_peer" {
			e.Properties = []string{"dc.example.com (ntp.d|transport)"}
		}
		if tc.kind == "unknown" {
			e.Properties = []string{"peer.example.com"}
		}
		f := &fakeSystem{tokens: []byte(germanStatus)}
		got := readStatus(context.Background(), f, []Event{e})
		if got.Method != "events" || got.SourceKind != tc.kind || !got.LastSuccessfulSyncAt.Equal(at) {
			t.Fatal(got)
		}
		if got.Stratum == nil || *got.Stratum != 4 {
			t.Fatal("numeric token lost")
		}
	}
	f := &fakeSystem{}
	if got := readStatus(context.Background(), f, nil); got.Method != "unavailable" || got.Source != nil {
		t.Fatal(got)
	}
	f.provider = Status{Source: ptr("peer.example.com"), SourceKind: "ntp_peer"}
	f.providerErr = errUnavailable
	if got := readStatus(context.Background(), f, []Event{success}); got.Method != "events" {
		t.Fatal(got)
	}
}

func TestPlainEventHostsNeverInferKindFromConfiguration(t *testing.T) {
	for _, typ := range []string{"NTP", "NT5DS"} {
		t.Run(typ, func(t *testing.T) {
			at := time.Unix(100, 0).UTC()
			f := &fakeSystem{strings: map[string]string{serviceKey + `\Parameters|Type`: typ},
				role: RoleInfo{MachineRole: 3, DomainDNS: "example.com", ForestDNS: "example.com"}}
			e := Event{EventID: 37, OccurredAt: at, Properties: []string{"peer.example.com"}}
			got := readStatus(context.Background(), f, []Event{e})
			if got.Source == nil || *got.Source != "peer.example.com" || got.SourceKind != "unknown" || !got.LastSuccessfulSyncAt.Equal(at) {
				t.Fatal(got)
			}
		})
	}
}

func TestEventsAreLastKnownGoodNotTranslatedStatus(t *testing.T) {
	at := time.Unix(100, 0).UTC()
	bad := Event{EventID: 35, OccurredAt: at, Properties: []string{"Freilaufende Systemuhr"}, Message: "time.example.com"}
	got := readStatus(context.Background(), &fakeSystem{}, []Event{bad})
	if got.Source != nil || got.SourceKind != "unknown" {
		t.Fatalf("display text parsed: %+v", got)
	}
	got = readStatus(context.Background(), &fakeSystem{}, nil)
	if got.Source != nil || got.LastSuccessfulSyncAt != nil {
		t.Fatal("invented cached status", got)
	}
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected FAIL: `undefined: readStatus`, `undefined: parseW32tmTokens`.
- [ ] Create `status.go`:

```go
package timesync

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

var referenceToken = regexp.MustCompile(`^0x[0-9A-Fa-f]{8}(?:\s|$)`)
var integerToken = regexp.MustCompile(`^([0-9]+)(?:\s|\(|$)`)

func parseW32tmTokens(raw string) Status {
	s := unknownStatus()
	lines := []string{}
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) < 9 {
		return s
	}
	value := func(i int) string {
		_, v, ok := strings.Cut(lines[i], ":")
		if !ok {
			return ""
		}
		return strings.TrimSpace(v)
	}
	if !referenceToken.MatchString(value(5)) {
		return s
	}
	number := func(i int) (int, bool) {
		m := integerToken.FindStringSubmatch(value(i))
		if len(m) != 2 {
			return 0, false
		}
		v, e := strconv.Atoi(m[1])
		return v, e == nil
	}
	leap, ok := number(0)
	if !ok || leap > 3 {
		return s
	}
	stratum, ok := number(1)
	if !ok || stratum > 16 {
		return s
	}
	exponent, ok := number(8)
	if !ok || exponent > 30 {
		return s
	}
	s.Stratum = &stratum
	s.PollIntervalSeconds = ptr(uint32(1) << uint(exponent))
	// ReferenceId is not a hostname. LOCL is ambiguous between clock modes.
	// No special tag is enabled without Task 1 evidence for that exact mapping.
	return s
}

func eventSource(e Event) (string, string) {
	if len(e.Properties) == 0 {
		return "", "unknown"
	}
	raw := strings.TrimSpace(e.Properties[0])
	kind := "unknown"
	if i := strings.Index(raw, " ("); i >= 0 {
		suffix := strings.ToLower(raw[i:])
		switch {
		case strings.HasPrefix(suffix, " (ntp.m|"):
			kind = "ntp_peer"
		case strings.HasPrefix(suffix, " (ntp.d|"):
			kind = "domain_peer"
		default:
			return "", "unknown"
		}
		raw = raw[:i]
	}
	raw = peerFlags.ReplaceAllString(raw, "")
	if !IsValidNtpServerHost(raw) {
		return "", "unknown"
	}
	return raw, kind
}

func validKind(k string) bool {
	switch k {
	case "ntp_peer", "domain_peer", "local_clock", "free_running", "vm_host", "unknown":
		return true
	}
	return false
}

func readStatus(ctx context.Context, sys System, events []Event) Status {
	// Branch A: usable structured provider status wins; a failure takes Branch B.
	native, err := sys.ProviderStatus(ctx)
	if err == nil && native.Source != nil && strings.TrimSpace(*native.Source) != "" {
		native.Source = nullableText(*native.Source, 512)
		native.Method = "provider_api"
		if !validKind(native.SourceKind) {
			native.SourceKind = "unknown"
		}
		if native.LastSyncError != nil {
			native.LastSyncError = nullableText(*native.LastSyncError, 512)
		}
		if native.Stratum != nil && (*native.Stratum < 0 || *native.Stratum > 16) {
			native.Stratum = nil
		}
		return native
	}
	// Branch B: only proven numeric tokens, then event insertion strings.
	tokens := unknownStatus()
	if raw, e := sys.W32tmStatus(ctx); e == nil {
		tokens = parseW32tmTokens(string(raw))
	}
	best := unknownStatus()
	for _, e := range events {
		if e.EventID != 35 && e.EventID != 37 {
			continue
		}
		if best.LastSuccessfulSyncAt != nil && !e.OccurredAt.After(*best.LastSuccessfulSyncAt) {
			continue
		}
		src, kind := eventSource(e)
		if src == "" {
			continue
		}
		best = Status{Method: "events", Source: ptr(src), SourceKind: kind, LastSuccessfulSyncAt: ptr(e.OccurredAt.UTC())}
	}
	if tokens.Source != nil {
		tokens.Method = "w32tm_tokens"
		if best.Source != nil && strings.EqualFold(*best.Source, *tokens.Source) {
			tokens.LastSuccessfulSyncAt = best.LastSuccessfulSyncAt
		}
		return tokens
	}
	if tokens.Stratum != nil {
		best.Stratum = tokens.Stratum
	}
	if tokens.PollIntervalSeconds != nil {
		best.PollIntervalSeconds = tokens.PollIntervalSeconds
	}
	return best
}
```

Branch A is fully specified against `System.ProviderStatus`; it does not pretend that a real DLL adapter exists. No config or error text becomes a status fact. `lastSyncError` is null in the fallback because neither translated text nor an arbitrary event message is a machine-readable error code.

If Task 1 rules out all position-based tokens, replace the **entire** `parseW32tmTokens` function above with:

```go
func parseW32tmTokens(raw string) Status { return unknownStatus() }
```

Then remove `regexp` and `strconv` imports and the `referenceToken`/`integerToken` declarations from `status.go`. In `TestGermanTokensNeverParseTranslatedValues`, replace its numeric assertion with `if got.Stratum!=nil || got.PollIntervalSeconds!=nil { t.Fatal("unproven token parsed") }`; in `TestProviderKindsAndLadder`, replace `if got.Stratum==nil || *got.Stratum!=4 {t.Fatal("numeric token lost")}` with `if got.Stratum!=nil {t.Fatal("unproven token parsed")}`. Keep the German equality and translated-value assertions. This is the complete token-disabled variant; no date-label parser is an acceptable substitute.

- [ ] Re-run `cd agent && go test -race ./internal/collectors/timesync/...`; expected PASS for the selected variant. Run `cd agent && GOOS=windows go vet ./internal/collectors/timesync/...`; expected PASS.
- [ ] Commit:

```bash
git add agent/internal/collectors/timesync/status.go agent/internal/collectors/timesync/status_test.go
git commit -m "feat(agent): add locale-independent time status fallback ladder" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Bound events while preserving new failure signals and recent display history

**Files:**
- Create: `agent/internal/collectors/timesync/{events.go,events_test.go}`.

**Interfaces:**
- Consumes: `System.Events(ctx,since,until,100)` and `System.RecentEvents(ctx,until,20)`; `Event` from Task 2.
- Produces: `collectEvents(ctx context.Context,sys System,since,until time.Time) ([]Event,error)`.

Use two bounded queries: up to 100 new all-level Time-Service events plus the newest 20 any-ID display events. Reserve the newest-20 display IDs first, then use the remaining slots for fresh recognized signals and finally other fresh events. Deduplicate by `RecordID`, retaining the newest occurrence across both queries before selecting signals/display rows; sort newest first. Mark the newest-20 display IDs with unexported in-memory metadata so Task 7's serialized-size trimming cannot drop them. No reservation metadata is sent or persisted. The single §B array remains at most 100. Event-query failure fails collection and cannot advance the watermark.

- [ ] Write `events_test.go`:

```go
package timesync

import (
	"context"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func TestEventWindowAndCaps(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	since := now.Add(-time.Hour)
	f := &fakeSystem{}
	for i := 0; i < 140; i++ {
		f.events = append(f.events, Event{RecordID: uint64(i + 1), EventID: 134, Level: i % 6,
			OccurredAt: now.Add(-time.Duration(i) * time.Second), Message: strings.Repeat("😀", 800),
			Properties: []string{strings.Repeat("ü", 700), "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"}})
	}
	f.recent = []Event{{RecordID: 500, EventID: 999, Level: 4, OccurredAt: since.Add(-time.Hour), Properties: nil}}
	got, err := collectEvents(context.Background(), f, since, now)
	if err != nil || len(got) != 100 {
		t.Fatalf("%d %v", len(got), err)
	}
	if !f.since.Equal(since) || !f.until.Equal(now) {
		t.Fatal("window not passed through")
	}
	found := false
	for i, e := range got {
		if e.RecordID == 500 {
			found = true
		}
		if len(utf16.Encode([]rune(e.Message))) > 1000 || len(e.Properties) > 10 || e.Properties == nil {
			t.Fatal("event cap")
		}
		for _, p := range e.Properties {
			if len(utf16.Encode([]rune(p))) > 500 {
				t.Fatal("property cap")
			}
		}
		if i > 0 && e.OccurredAt.After(got[i-1].OccurredAt) {
			t.Fatal("not newest first")
		}
	}
	if !found {
		t.Fatal("recent display event lost on quiet window")
	}
}

func TestEventErrorsAndBoundaries(t *testing.T) {
	now := time.Unix(100000, 0).UTC()
	since := now.Add(-time.Hour)
	f := &fakeSystem{eventErr: errUnavailable}
	if _, err := collectEvents(context.Background(), f, since, now); err == nil {
		t.Fatal("query error hidden")
	}
	f.eventErr = nil
	e := Event{RecordID: 3, EventID: 37, Level: 4, OccurredAt: now.Add(-time.Second)}
	f.events = []Event{e, {RecordID: 1, OccurredAt: since}, {RecordID: 2, OccurredAt: now.Add(time.Second)}}
	f.recent = []Event{e}
	got, err := collectEvents(context.Background(), f, since, now)
	if err != nil || len(got) != 1 || got[0].RecordID != 3 {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestEventDeduplicationKeepsNewestOccurrenceByRecordID(t *testing.T) {
	now := time.Unix(100000, 0).UTC()
	since := now.Add(-time.Hour)
	old := Event{RecordID: 7, EventID: 134, Level: 3, OccurredAt: now.Add(-time.Minute), Message: "older", Properties: []string{}}
	latest := old
	latest.OccurredAt = now.Add(-time.Second)
	latest.Message = "newest"
	latest.EventID = 37
	for _, tc := range []struct {
		name          string
		fresh, recent []Event
	}{
		{"newest in recent", []Event{old}, []Event{latest}},
		{"newest in fresh", []Event{latest, old}, []Event{old}},
		{"duplicates within fresh", []Event{old, latest}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := collectEvents(context.Background(), &fakeSystem{events: tc.fresh, recent: tc.recent}, since, now)
			if err != nil || len(got) != 1 || got[0].RecordID != 7 || got[0].Message != "newest" || got[0].EventID != 37 || !got[0].OccurredAt.Equal(latest.OccurredAt) {
				t.Fatal(got, err)
			}
			if len(tc.recent) > 0 && !got[0].displayReserved {
				t.Fatal("deduplication lost display reservation")
			}
		})
	}
}

func TestAllTwentyDisplayEventsSurviveCountCap(t *testing.T) {
	now := time.Unix(100000, 0).UTC()
	since := now.Add(-time.Hour)
	f := &fakeSystem{}
	for i := 0; i < 100; i++ {
		f.events = append(f.events, Event{RecordID: uint64(i + 1), EventID: 134, Level: 3, OccurredAt: now.Add(-time.Duration(i+1) * time.Second)})
	}
	for i := 0; i < 20; i++ {
		f.recent = append(f.recent, Event{RecordID: uint64(1000 + i), EventID: 999, Level: 4, OccurredAt: since.Add(-time.Duration(i+1) * time.Hour)})
	}
	got, err := collectEvents(context.Background(), f, since, now)
	if err != nil || len(got) != 100 {
		t.Fatal(len(got), err)
	}
	reserved := 0
	for _, e := range got {
		if e.displayReserved {
			reserved++
		}
	}
	if reserved != 20 {
		t.Fatal("display reservation lost", reserved)
	}
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected FAIL: `undefined: collectEvents`.
- [ ] Create `events.go`:

```go
package timesync

import (
	"context"
	"sort"
	"time"
)

func isSignal(id uint32) bool {
	switch id {
	case 12, 24, 29, 35, 36, 37, 47, 52, 129, 134:
		return true
	}
	return false
}
func newest(events []Event) {
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].OccurredAt.Equal(events[j].OccurredAt) {
			return events[i].RecordID > events[j].RecordID
		}
		return events[i].OccurredAt.After(events[j].OccurredAt)
	})
}
func collectEvents(ctx context.Context, sys System, since, until time.Time) ([]Event, error) {
	fresh, err := sys.Events(ctx, since, until, 100)
	if err != nil {
		return nil, err
	}
	recent, err := sys.RecentEvents(ctx, until, 20)
	if err != nil {
		return nil, err
	}
	valid := func(e Event) bool {
		return !e.OccurredAt.IsZero() && !e.OccurredAt.After(until) && e.Level >= 0 && e.Level <= 5 && e.RecordID <= maxSafeSequence
	}
	// Sort before ID-only deduplication so a reused record ID retains its newest occurrence.
	union := append(append([]Event(nil), fresh...), recent...)
	newest(union)
	latest := map[uint64]Event{}
	for _, e := range union {
		if !valid(e) {
			continue
		}
		if _, ok := latest[e.RecordID]; !ok {
			latest[e.RecordID] = e
		}
	}
	recent = append([]Event(nil), recent...)
	newest(recent)
	reserved := map[uint64]bool{}
	for _, e := range recent {
		if len(reserved) == 20 {
			break
		}
		if valid(e) {
			reserved[e.RecordID] = true
		}
	}
	candidates := []Event{}
	freshIDs := map[uint64]bool{}
	for _, e := range fresh {
		if valid(e) && e.OccurredAt.After(since) {
			freshIDs[e.RecordID] = true
		}
	}
	for id, e := range latest {
		if reserved[id] || freshIDs[id] {
			candidates = append(candidates, e)
		}
	}
	newest(candidates)
	out := []Event{}
	seen := map[uint64]bool{}
	add := func(e Event) {
		if len(out) >= 100 || seen[e.RecordID] {
			return
		}
		seen[e.RecordID] = true
		e.OccurredAt = e.OccurredAt.UTC()
		e.Message = limitText(e.Message, 1000)
		properties := []string{}
		for i, p := range e.Properties {
			if i == 10 {
				break
			}
			properties = append(properties, limitText(p, 500))
		}
		e.Properties = properties
		e.displayReserved = reserved[e.RecordID]
		out = append(out, e)
	}
	// Reserve display rows first, then prioritize fresh signals within remaining capacity.
	for _, e := range candidates {
		if reserved[e.RecordID] {
			add(e)
		}
	}
	for _, e := range candidates {
		if freshIDs[e.RecordID] && isSignal(e.EventID) {
			add(e)
		}
	}
	for _, e := range candidates {
		add(e)
	}
	newest(out)
	return out, nil
}

const maxSafeSequence uint64 = 9007199254740991
```

- [ ] Re-run the same race command and `cd agent && GOOS=windows go vet ./internal/collectors/timesync/...`; expected PASS.
- [ ] Commit:

```bash
git add agent/internal/collectors/timesync/events.go agent/internal/collectors/timesync/events_test.go
git commit -m "feat(agent): collect bounded time service event evidence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Implement Windows reads and the non-Windows constructor

**Files:**
- Create: `agent/internal/collectors/{command_export.go,command_export_test.go}`.
- Create: `agent/internal/collectors/timesync/{system_windows.go,system_events_windows.go,system_windows_test.go,system_other.go}`.
- Read: `agent/internal/collectors/command_limits.go:34–68`, `agent/internal/svcquery/svcquery_windows.go:25–64,125–152`.

**Interfaces:**
- Consumes: raw SCM reads through `mgr.Connect`, `Service.Query`, `Service.Config`; `mgmtdetect.CollectIdentityStatus() mgmtdetect.IdentityStatus`, Task 2's `System`.
- Produces: `NewSystem() System`; `collectors.RunCollectorOutput(ctx context.Context,timeout time.Duration,name string,args ...string) ([]byte,error)`.

Use the existing command runner through a small exported wrapper; it already uses `exec.CommandContext`, argument arrays, stdout 4 MiB/stderr 64 KiB caps and `WaitDelay=10s`. The existing `runCollectorOutput` is package-private and cannot be named from `timesync`. No parent-to-child import is introduced, so there is no import cycle.

Use `Get-WinEvent` with `.Properties` projection because the existing collector already depends on Windows PowerShell and this avoids inventing an event-message parser. There is no level filter. All timestamps are emitted in UTC ISO form, all property conversions use invariant culture, empty results are `[]`, and actual access/query errors remain errors. PowerShell here only reads; agent writes remain absent.

- [ ] Write `command_export_test.go`:

```go
package collectors

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestRunCollectorOutputExportCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, err = RunCollectorOutput(ctx, time.Second, exe, "-test.run=^$")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("context lost: %v", err)
	}
}
```

Write `system_windows_test.go`:

```go
//go:build windows

package timesync

import (
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows/svc"
)

func TestNativeLayouts(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("amd64 layout assertion")
	}
	for name, pair := range map[string][2]uintptr{
		"dsrole":           {unsafe.Sizeof(dsRoleBasic{}), 48},
		"dcinfo":           {unsafe.Sizeof(dcInfo{}), 80},
		"dynamic timezone": {unsafe.Sizeof(dynamicTimezone{}), 432},
		"domain DNS":       {unsafe.Offsetof(dsRoleBasic{}.DomainNameDNS), 16},
		"DC domain":        {unsafe.Offsetof(dcInfo{}.DomainName), 40},
		"TZ key":           {unsafe.Offsetof(dynamicTimezone{}.TimeZoneKeyName), 172},
	} {
		if pair[0] != pair[1] {
			t.Fatalf("%s: %v", name, pair)
		}
	}
}

func TestServiceStateMapping(t *testing.T) {
	for _, tc := range []struct {
		in   svc.State
		want string
	}{
		{svc.Running, "running"}, {svc.Stopped, "stopped"}, {svc.StartPending, "start_pending"},
		{svc.ContinuePending, "start_pending"}, {svc.StopPending, "stop_pending"},
		{svc.PausePending, "stop_pending"}, {svc.Paused, "paused"}, {svc.State(0), "unknown"},
	} {
		if got := timeServiceState(tc.in); got != tc.want {
			t.Fatalf("%d=%s", tc.in, got)
		}
	}
}

func TestEventScriptUsesInsertionStringsAndAllLevels(t *testing.T) {
	script := eventScript(time.Unix(1, 0), time.Unix(2, 0), 100)
	for _, want := range []string{"Microsoft-Windows-Time-Service", ".Properties", "InvariantCulture", "-MaxEvents 100", "NoMatchingEventsFound", "ConvertTo-Json -InputObject"} {
		if !strings.Contains(script, want) {
			t.Fatalf("missing %s", want)
		}
	}
	if strings.Contains(script, "Level=") || strings.Contains(script, "Level =") {
		t.Fatal("events filtered by severity")
	}
	if !strings.Contains(script, "StartTime") || !strings.Contains(script, "EndTime") {
		t.Fatal("missing window")
	}
	if _, err := decodeEvents([]byte(`not JSON`)); err == nil {
		t.Fatal("bad query output hidden")
	}
	rows, err := decodeEvents([]byte(`[]`))
	if err != nil || rows == nil || len(rows) != 0 {
		t.Fatal(rows, err)
	}
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/... -run '^TestRunCollectorOutputExportCancellation$'`; expected FAIL: `undefined: RunCollectorOutput`.
- [ ] Run `cd agent && GOOS=windows go test -c -o /tmp/timesync.test.exe ./internal/collectors/timesync`; expected FAIL: undefined native layouts/query helpers.
- [ ] Create `command_export.go`:

```go
package collectors

import (
	"context"
	"time"
)

// RunCollectorOutput shares the collector command limits with subpackages.
func RunCollectorOutput(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	return runCollectorOutputWithContext(ctx, timeout, name, args...)
}
```

Create `system_other.go`:

```go
//go:build !windows

package timesync

func NewSystem() System { return nil }
```

Create `system_windows.go`:

```go
//go:build windows

package timesync

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/mgmtdetect"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type windowsSystem struct{}

var _ System = (*windowsSystem)(nil)

func NewSystem() System { return &windowsSystem{} }

func (*windowsSystem) ReadString(ctx context.Context, path, name string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
	if err != nil {
		return "", err
	}
	defer key.Close()
	value, _, err := key.GetStringValue(name)
	return value, err
}
func (*windowsSystem) ReadDWORD(ctx context.Context, path, name string) (uint32, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
	if err != nil {
		return 0, err
	}
	defer key.Close()
	value, typ, err := key.GetIntegerValue(name)
	if err != nil {
		return 0, err
	}
	if typ != registry.DWORD {
		return 0, fmt.Errorf("%s is not DWORD", name)
	}
	return uint32(value), nil
}
func (*windowsSystem) ValueNames(ctx context.Context, path string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer key.Close()
	return key.ReadValueNames(-1)
}

func timeServiceState(state svc.State) string {
	switch state {
	case svc.Running:
		return "running"
	case svc.Stopped:
		return "stopped"
	case svc.StartPending, svc.ContinuePending:
		return "start_pending"
	case svc.StopPending, svc.PausePending:
		return "stop_pending"
	case svc.Paused:
		return "paused"
	default:
		return "unknown"
	}
}
func (*windowsSystem) W32TimeService(ctx context.Context) (ServiceInfo, error) {
	if err := ctx.Err(); err != nil {
		return ServiceInfo{}, err
	}
	info := ServiceInfo{State: "unknown", StartType: "unknown"}
	// R8: keep svcquery unchanged for other callers; read raw SCM facts here.
	m, err := mgr.Connect()
	if err != nil {
		return info, err
	}
	defer m.Disconnect()
	service, err := m.OpenService("W32Time")
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return ServiceInfo{"not_installed", "unknown"}, nil
	}
	if err != nil {
		return info, err
	}
	defer service.Close()
	state, err := service.Query()
	if err != nil {
		return info, err
	}
	info.State = timeServiceState(state.State)
	cfg, err := service.Config()
	if err != nil {
		return info, err
	}
	switch cfg.StartType {
	case mgr.StartAutomatic:
		info.StartType = "auto"
		if cfg.DelayedAutoStart {
			info.StartType = "delayed_auto"
		}
	case mgr.StartDisabled:
		info.StartType = "disabled"
	case mgr.StartManual:
		info.StartType = "manual"
		key, e := registry.OpenKey(registry.LOCAL_MACHINE, serviceKey+`\TriggerInfo`, registry.ENUMERATE_SUB_KEYS)
		if e == nil {
			names, readErr := key.ReadSubKeyNames(-1)
			key.Close()
			if readErr != nil {
				return info, readErr
			}
			if len(names) > 0 {
				info.StartType = "trigger_manual"
			}
		} else if !errors.Is(e, syscall.ERROR_FILE_NOT_FOUND) {
			return info, e
		}
	default:
		info.StartType = "unknown"
	}
	return info, nil
}

func (*windowsSystem) ProviderStatus(ctx context.Context) (Status, error) {
	if err := ctx.Err(); err != nil {
		return unknownStatus(), err
	}
	// Keep the SPI and wire method stable. Task 1 has not established a callable
	// DLL ABI; a successful Find alone is insufficient to invoke this export.
	return unknownStatus(), errUnavailable
}
func (*windowsSystem) W32tmStatus(ctx context.Context) ([]byte, error) {
	return collectors.RunCollectorOutput(ctx, 10*time.Second, "w32tm.exe", "/query", "/status", "/verbose")
}
func (*windowsSystem) Identity(ctx context.Context) (mgmtdetect.IdentityStatus, error) {
	if err := ctx.Err(); err != nil {
		return mgmtdetect.IdentityStatus{}, err
	}
	id := mgmtdetect.CollectIdentityStatus()
	if err := ctx.Err(); err != nil {
		return id, err
	}
	if id.Source == "dsregcmd_error_no_fallback" || !id.DetectionSupported() {
		return id, errUnavailable
	}
	return id, nil
}

var netapi32 = windows.NewLazySystemDLL("netapi32.dll")
var dsRoleProc = netapi32.NewProc("DsRoleGetPrimaryDomainInformation")
var dsRoleFreeProc = netapi32.NewProc("DsRoleFreeMemory")
var dsGetDCProc = netapi32.NewProc("DsGetDcNameW")
var kernel32 = windows.NewLazySystemDLL("kernel32.dll")
var timezoneProc = kernel32.NewProc("GetDynamicTimeZoneInformation")

type dsRoleBasic struct {
	MachineRole      uint32
	Flags            uint32
	DomainNameFlat   *uint16
	DomainNameDNS    *uint16
	DomainForestName *uint16
	DomainGUID       windows.GUID
}
type dcInfo struct {
	DomainControllerName        *uint16
	DomainControllerAddress     *uint16
	DomainControllerAddressType uint32
	DomainGUID                  windows.GUID
	DomainName                  *uint16
	DNSForestName               *uint16
	Flags                       uint32
	DCSiteName                  *uint16
	ClientSiteName              *uint16
}

func wide(p *uint16) string {
	if p == nil {
		return ""
	}
	return windows.UTF16PtrToString(p)
}

func (*windowsSystem) PrimaryDomain(ctx context.Context) (RoleInfo, error) {
	if err := ctx.Err(); err != nil {
		return RoleInfo{}, err
	}
	if err := dsRoleProc.Find(); err != nil {
		return RoleInfo{}, err
	}
	if err := dsRoleFreeProc.Find(); err != nil {
		return RoleInfo{}, err
	}
	var p *dsRoleBasic
	result, _, _ := dsRoleProc.Call(0, 1, uintptr(unsafe.Pointer(&p)))
	if result != 0 {
		return RoleInfo{}, syscall.Errno(result)
	}
	if p == nil {
		return RoleInfo{}, errUnavailable
	}
	defer dsRoleFreeProc.Call(uintptr(unsafe.Pointer(p)))
	return RoleInfo{p.MachineRole, wide(p.DomainNameDNS), wide(p.DomainForestName)}, nil
}
func (*windowsSystem) PDC(ctx context.Context, domain string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := dsGetDCProc.Find(); err != nil {
		return "", err
	}
	name, err := windows.UTF16PtrFromString(domain)
	if err != nil {
		return "", err
	}
	var p *dcInfo
	const dsPDCRequired = 0x00000080
	const dsReturnDNSName = 0x40000000
	result, _, _ := dsGetDCProc.Call(0, uintptr(unsafe.Pointer(name)), 0, 0, dsPDCRequired|dsReturnDNSName, uintptr(unsafe.Pointer(&p)))
	if result != 0 {
		return "", syscall.Errno(result)
	}
	if p == nil {
		return "", errUnavailable
	}
	defer windows.NetApiBufferFree((*byte)(unsafe.Pointer(p)))
	return wide(p.DomainControllerName), nil
}
func (*windowsSystem) ComputerDNSName(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	size := uint32(256)
	buf := make([]uint16, size)
	err := windows.GetComputerNameEx(windows.ComputerNameDnsFullyQualified, &buf[0], &size)
	if errors.Is(err, windows.ERROR_MORE_DATA) {
		buf = make([]uint16, size)
		err = windows.GetComputerNameEx(windows.ComputerNameDnsFullyQualified, &buf[0], &size)
	}
	if err != nil {
		return "", err
	}
	return windows.UTF16ToString(buf), nil
}

type dynamicTimezone struct {
	Bias                        int32
	StandardName                [32]uint16
	StandardDate                windows.Systemtime
	StandardBias                int32
	DaylightName                [32]uint16
	DaylightDate                windows.Systemtime
	DaylightBias                int32
	TimeZoneKeyName             [128]uint16
	DynamicDaylightTimeDisabled byte
}

func (*windowsSystem) DynamicTimezone(ctx context.Context) (Timezone, error) {
	if err := ctx.Err(); err != nil {
		return Timezone{}, err
	}
	if err := timezoneProc.Find(); err != nil {
		return Timezone{}, err
	}
	var info dynamicTimezone
	result, _, callErr := timezoneProc.Call(uintptr(unsafe.Pointer(&info)))
	if uint32(result) == 0xffffffff {
		return Timezone{}, fmt.Errorf("GetDynamicTimeZoneInformation: %w", callErr)
	}
	// Contract reports base Bias, not the current DST-adjusted UTC offset.
	zone := Timezone{WindowsID: nullableText(windows.UTF16ToString(info.TimeZoneKeyName[:]), 128),
		DynamicDSTDisabled: ptr(info.DynamicDaylightTimeDisabled != 0), AutoUpdate: "unknown"}
	if info.Bias >= -1440 && info.Bias <= 1440 {
		zone.BiasMinutes = ptr(info.Bias)
	}
	return zone, nil
}
```

The native structures deliberately use pointers for LPWSTR and `windows.GUID`, not Go strings or packed byte arrays. Strings are copied before freeing their owning buffer. `DsRoleFreeMemory` frees DsRole allocations; `NetApiBufferFree` frees DsGetDcName allocations. All comparisons occur after normalizing DNS spelling. Windows itself owns the synchronous discovery-call timeout; cancellation is checked before each native read and again by the collector before persisting. Do not detach unbounded discovery goroutines to pretend the native call was cancelled.

Create `system_events_windows.go`:

```go
//go:build windows

package timesync

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
)

func eventScript(since, until time.Time, limit int) string {
	start := ""
	if !since.IsZero() {
		start = fmt.Sprintf(";StartTime=[datetime]::Parse('%s',[Globalization.CultureInfo]::InvariantCulture)", since.UTC().Format(time.RFC3339Nano))
	}
	return fmt.Sprintf(`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
try {
 $rows=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Time-Service'%s;EndTime=[datetime]::Parse('%s',[Globalization.CultureInfo]::InvariantCulture)} -MaxEvents %d -ErrorAction Stop)
} catch {
 if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
 $rows=@()
}
function Clip([string]$s,[int]$n) {
 if ($s.Length -le $n) { return $s }
 if ([char]::IsHighSurrogate($s[$n-1])) { $n-- }
 return $s.Substring(0,$n)
}
$result=@($rows | ForEach-Object {
 $entry=$_; $message=''; try { $message=[string]$entry.Message } catch { $message='' }
 [pscustomobject]@{
  recordId=[long]$entry.RecordId; eventId=[int]$entry.Id; level=[int]$entry.Level;
  occurredAt=$entry.TimeCreated.ToUniversalTime().ToString('o');
  message=(Clip $message 1000);
  properties=@($entry.Properties | Select-Object -First 10 | ForEach-Object { Clip ([Convert]::ToString($_.Value,[Globalization.CultureInfo]::InvariantCulture)) 500 })
 }
}); ConvertTo-Json -InputObject $result -Depth 5 -Compress`, start, until.UTC().Format(time.RFC3339Nano), limit)
}
func decodeEvents(b []byte) ([]Event, error) {
	events := []Event{}
	if err := json.Unmarshal(b, &events); err != nil {
		return nil, fmt.Errorf("decode Time-Service events: %w", err)
	}
	if events == nil {
		return nil, fmt.Errorf("event query returned null instead of an array")
	}
	return events, nil
}
func (*windowsSystem) Events(ctx context.Context, since, until time.Time, limit int) ([]Event, error) {
	if limit < 1 || limit > 100 {
		return nil, fmt.Errorf("invalid event limit %d", limit)
	}
	b, err := collectors.RunCollectorOutput(ctx, 30*time.Second, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", eventScript(since, until, limit))
	if err != nil {
		return nil, err
	}
	return decodeEvents(b)
}
func (s *windowsSystem) RecentEvents(ctx context.Context, until time.Time, limit int) ([]Event, error) {
	return s.Events(ctx, time.Time{}, until, limit)
}
```

- [ ] Run:

```bash
(cd agent && go test -race ./internal/collectors/... -run '^TestRunCollectorOutputExportCancellation$')
(cd agent && GOOS=windows go vet ./internal/collectors/timesync/... ./internal/mgmtdetect/... ./internal/collectors/...)
(cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/timesync.test.exe ./internal/collectors/timesync)
(cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/mgmtdetect.test.exe ./internal/mgmtdetect)
(cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/collectors.test.exe ./internal/collectors)
```

Expected PASS (cross-compile does not execute tests). Run natively in the Windows checkout: `cd agent; go test -race ./internal/collectors/timesync/... ./internal/mgmtdetect/...`. Expected PASS; lab-only tests remain opt-in.

- [ ] Commit:

```bash
git add agent/internal/collectors/command_export.go agent/internal/collectors/command_export_test.go agent/internal/collectors/timesync/system_windows.go agent/internal/collectors/timesync/system_events_windows.go agent/internal/collectors/timesync/system_windows_test.go agent/internal/collectors/timesync/system_other.go
git commit -m "feat(agent): read Windows time configuration and structured events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Collect fresh facts and persist only sequence and event cursor

**Files:**
- Create: `agent/internal/collectors/timesync/{collector.go,persist.go,collector_test.go,system_other_test.go}`.
- Read: `agent/internal/collectors/hwhealth/persist.go:28–109`, `state_recovery.go:23–75`.

**Interfaces:**
- Consumes: `System`, `readDomain`, `readStatus`, `collectEvents` from Tasks 2–6.
- Produces: `New(stateDir string,sys System) *Collector`; `(*Collector).Collect(ctx context.Context) (*Snapshot,error)` exactly as §H.
- Produces: `(*Collector).Commit(snapshot *Snapshot) error` (R4), consumed by Task 8 and W03b only after a 2xx response with `accepted: true` or `accepted: false, reason: "stale_sequence"`.
- Produces: `fitPayload(s *Snapshot) error`, the shared 256 KiB serialized budget helper. W03b calls it again after attaching enforcement to the same snapshot, preserving the collector's in-memory display reservation.

Every `Collect` performs fresh OS reads and reserves a new sequence atomically before returning. Only `sequence` and `eventsSince` persist; there is no pending snapshot, cached status or event-transfer buffer. Failed sends leave the committed cursor unchanged; the next call re-queries the events and reports current facts with a new sequence. `Commit` persists the accepted snapshot's collection boundary without changing the sequence. An older concurrent commit cannot move the cursor backward. Read-only management guards in W03b must use `System` directly, never `Collect` or `Commit`.

W01a's merged route must implement R4's qualified response, including `reason: "stale_sequence"`; an unqualified `accepted: false` does not commit. Its draft's omitted reason is an upstream correction, not permission to weaken the sender.

- [ ] Write `collector_test.go`:

```go
package timesync

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestFreshCollectionsAndCommittedEventCursor(t *testing.T) {
	dir := t.TempDir()
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	f := &fakeSystem{}
	c := New(dir, f)
	c.now = func() time.Time { return at }
	first, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Sequence != 1 || !f.since.Equal(at.Add(-24*time.Hour)) {
		t.Fatal(first, f.since)
	}
	if err = c.Commit(first); err != nil {
		t.Fatal(err)
	}
	f.events = []Event{{RecordID: 1, EventID: 134, Level: 3, OccurredAt: at.Add(time.Minute)}}
	c.now = func() time.Time { return at.Add(time.Hour) }
	failed, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if failed.Sequence != 2 || len(failed.Events) != 1 || !f.since.Equal(at) {
		t.Fatal(failed, f.since)
	}
	failed.Events[0].Message = "caller mutation"
	f.strings = map[string]string{serviceKey + `\Parameters|Type`: "NoSync"}
	// No Commit after a failed send. Restart must read current facts and replay the event.
	next := New(dir, f)
	next.now = func() time.Time { return at.Add(2 * time.Hour) }
	fresh, err := next.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Sequence != 3 || !fresh.CollectedAt.Equal(at.Add(2*time.Hour)) || *fresh.Config.Type != "NoSync" || !f.since.Equal(at) || len(fresh.Events) != 1 || fresh.Events[0].Message != "" {
		t.Fatal(fresh, f.since)
	}
	if err = next.Commit(fresh); err != nil {
		t.Fatal(err)
	}
	if err = next.Commit(failed); err != nil {
		t.Fatal(err)
	}
	if !next.state.EventsSince.Equal(fresh.CollectedAt) {
		t.Fatal("older commit rewound cursor")
	}
	next.now = func() time.Time { return at.Add(3 * time.Hour) }
	newer, err := next.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if newer.Sequence != 4 || len(newer.Events) != 0 || !f.since.Equal(fresh.CollectedAt) {
		t.Fatal(newer, f.since)
	}
	raw, err := os.ReadFile(filepath.Join(dir, stateName))
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	if err = json.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || keys["sequence"] == nil || keys["eventsSince"] == nil {
		t.Fatal("extra persisted state", string(raw))
	}
}

func TestEveryCollectReadsFreshFactsWithoutCommit(t *testing.T) {
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	f := &fakeSystem{}
	c := New(t.TempDir(), f)
	c.now = func() time.Time { return at }
	first, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	f.strings = map[string]string{serviceKey + `\Parameters|Type`: "NoSync"}
	c.now = func() time.Time { return at.Add(time.Minute) }
	fresh, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Sequence != first.Sequence+1 || fresh.CollectedAt.Equal(first.CollectedAt) || fresh.Config.Type == nil || *fresh.Config.Type != "NoSync" || !c.state.EventsSince.IsZero() {
		t.Fatal(fresh)
	}
}

func TestQueryAndPersistenceFailuresDoNotCommit(t *testing.T) {
	for _, failure := range []string{"events", "save", "commit"} {
		t.Run(failure, func(t *testing.T) {
			c := New(t.TempDir(), &fakeSystem{})
			f := c.sys.(*fakeSystem)
			if failure == "events" {
				f.eventErr = errUnavailable
			}
			if failure == "save" {
				c.save = func(string, any) error { return errors.New("disk full") }
			}
			snapshot, err := c.Collect(context.Background())
			if failure != "commit" {
				if err == nil || snapshot != nil || c.state.Sequence != 0 {
					t.Fatal("failed collection advanced state")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			c.save = func(string, any) error { return errors.New("disk full") }
			if err = c.Commit(snapshot); err == nil || c.state.Sequence != snapshot.Sequence || !c.state.EventsSince.IsZero() {
				t.Fatal("failed commit advanced state")
			}
			restarted := New(c.dir, f)
			if _, err = restarted.Collect(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !restarted.state.EventsSince.IsZero() {
				t.Fatal("failed commit reached disk")
			}
		})
	}
}

func TestCommitRejectsInvalidSnapshots(t *testing.T) {
	c := New(t.TempDir(), &fakeSystem{})
	snapshot, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []*Snapshot{nil, {}, {SchemaVersion: 1, Sequence: snapshot.Sequence + 1, CollectedAt: snapshot.CollectedAt}, {SchemaVersion: 1, Sequence: snapshot.Sequence}} {
		if err = c.Commit(invalid); err == nil {
			t.Fatal("invalid commit accepted")
		}
	}
	if !c.state.EventsSince.IsZero() {
		t.Fatal("invalid commit advanced cursor")
	}
}

func TestConcurrentCollectAllocatesDistinctSequences(t *testing.T) {
	c := New(t.TempDir(), &fakeSystem{})
	var wg sync.WaitGroup
	sequences := make(chan uint64, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			snapshot, err := c.Collect(context.Background())
			if err != nil {
				t.Error(err)
				return
			}
			sequences <- snapshot.Sequence
		}()
	}
	wg.Wait()
	close(sequences)
	seen := map[uint64]bool{}
	for sequence := range sequences {
		if seen[sequence] {
			t.Fatal("sequence reused", sequence)
		}
		seen[sequence] = true
	}
	for sequence := uint64(1); sequence <= 20; sequence++ {
		if !seen[sequence] {
			t.Fatal("sequence missing", sequence)
		}
	}
}

func TestCorruptStateRecoversAndWriteFailureStaysVisible(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "timesync-state.json")
	if err := os.WriteFile(p, []byte(`{"sequence":5000000000000,"eventsSince":`), 0600); err != nil {
		t.Fatal(err)
	}
	c := New(dir, &fakeSystem{})
	snapshot, err := c.Collect(context.Background())
	if err != nil || snapshot.Sequence <= 5000000000000 {
		t.Fatal(snapshot, err)
	}
	if _, err = os.Stat(p + ".corrupt"); err != nil {
		t.Fatal("no quarantine", err)
	}
	if err = c.Commit(snapshot); err != nil {
		t.Fatal(err)
	}
	c.state.Sequence = maxSafeSequence
	if snapshot, err = c.Collect(context.Background()); err == nil || snapshot != nil {
		t.Fatal("unsafe numeric sequence emitted")
	}
}

func TestPolicyReadsFailClosedAndRetainReadableNames(t *testing.T) {
	for _, tc := range []struct {
		name     string
		names    map[string][]string
		failures map[string]error
		managed  bool
		want     []string
	}{
		{"missing keys", map[string][]string{policyKey + `\Parameters`: {}, policyKey + `\TimeProviders\NtpClient`: {}}, nil, false, []string{}},
		{"access denied", nil, map[string]error{policyKey + `\Parameters`: errUnavailable}, true, []string{}},
		{"partial and sibling", map[string][]string{policyKey + `\Parameters`: {"Type"}, policyKey + `\TimeProviders\NtpClient`: {"SpecialPollInterval"}}, map[string]error{policyKey + `\Parameters`: errUnavailable}, true, []string{"SpecialPollInterval", "Type"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := readConfig(context.Background(), &fakeSystem{names: tc.names, namesErr: tc.failures})
			if got.PolicyManaged != tc.managed || !reflect.DeepEqual(got.PolicyManagedValues, tc.want) {
				t.Fatal(got)
			}
		})
	}
}

func TestConfigAndTimezoneFacts(t *testing.T) {
	for _, tc := range []struct {
		start uint32
		auto  string
	}{{3, "on"}, {4, "off"}, {2, "unknown"}, {0, "unknown"}} {
		f := &fakeSystem{
			strings: map[string]string{serviceKey + `\Parameters|Type`: "NTP", serviceKey + `\Parameters|NtpServer`: "peer.example.com,0x9"},
			dwords: map[string]uint32{serviceKey + `\TimeProviders\NtpClient|SpecialPollInterval`: 3600,
				serviceKey + `\TimeProviders\VMICTimeProvider|Enabled`: 1, `SYSTEM\CurrentControlSet\Services\tzautoupdate|Start`: tc.start},
			names:   map[string][]string{policyKey + `\Parameters`: {"Type"}, policyKey + `\TimeProviders\NtpClient`: {"SpecialPollInterval"}},
			service: ServiceInfo{"running", "trigger_manual"},
			zone:    Timezone{WindowsID: ptr("Eastern Standard Time"), BiasMinutes: ptr(int32(300)), DynamicDSTDisabled: ptr(false)},
		}
		c := New(t.TempDir(), f)
		s, err := c.Collect(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if s.Timezone.AutoUpdate != tc.auto || *s.Timezone.BiasMinutes != 300 || *s.Timezone.DynamicDSTDisabled {
			t.Fatal(s.Timezone)
		}
		if !s.Config.PolicyManaged || len(s.Config.PolicyManagedValues) != 2 || !*s.Config.HostTimeProviderEnabled || s.Config.ServiceStartType != "trigger_manual" {
			t.Fatal(s.Config)
		}
	}
	c := New(t.TempDir(), &fakeSystem{})
	s, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Config.Type != nil || s.Config.NtpServer != nil || s.Config.HostTimeProviderEnabled != nil || s.Timezone.WindowsID != nil {
		t.Fatal("unknown not null")
	}
	if s.Status.Method != "unavailable" || s.Domain.Role != "unknown" || s.Enforcement != nil {
		t.Fatal(s)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New(t.TempDir(), &fakeSystem{}).Collect(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestSnapshotBudgetPreservesEntireDisplayReservation(t *testing.T) {
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	f := &fakeSystem{}
	for i := 0; i < 100; i++ {
		e := Event{RecordID: uint64(i + 1), EventID: 134, Level: 3, OccurredAt: at.Add(-time.Duration(i+1) * time.Second), Message: string(make([]rune, 1000)), Properties: []string{}}
		for j := 0; j < 10; j++ {
			e.Properties = append(e.Properties, string(make([]rune, 500)))
		}
		f.events = append(f.events, e)
	}
	// Older display rows must survive even when trimming the newest signal backlog.
	for i := 0; i < 20; i++ {
		e := f.events[i]
		e.RecordID = uint64(1000 + i)
		e.OccurredAt = at.Add(-25*time.Hour - time.Duration(i)*time.Second)
		f.recent = append(f.recent, e)
	}
	c := New(t.TempDir(), f)
	c.now = func() time.Time { return at }
	snapshot, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	assertBudget := func() {
		t.Helper()
		b, err := json.Marshal(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		if len(b) > 256*1024 {
			t.Fatalf("%d bytes", len(b))
		}
		found := map[uint64]bool{}
		for i, e := range snapshot.Events {
			found[e.RecordID] = true
			if e.displayReserved && (len(e.Properties) != 10 || e.Properties[0] != string(make([]rune, 500))) {
				t.Fatal("reserved source evidence or property positions changed", e.RecordID)
			}
			if i > 0 && e.OccurredAt.After(snapshot.Events[i-1].OccurredAt) {
				t.Fatal("not newest first")
			}
		}
		for _, e := range f.recent {
			if !found[e.RecordID] {
				t.Fatal("reserved display row lost", e.RecordID)
			}
		}
		if len(snapshot.Events) > 100 {
			t.Fatal("event count cap")
		}
	}
	assertBudget()
	// W03b must use the same helper after attaching its enforcement report.
	snapshot.Enforcement = &EnforcementReport{NTP: &EnforcementResult{Error: ptr(string(make([]rune, 512)))}}
	if err = fitPayload(snapshot); err != nil {
		t.Fatal(err)
	}
	assertBudget()
}

func TestOversizedBasePayloadReturnsError(t *testing.T) {
	snapshot := emptySnapshot(time.Now())
	snapshot.Config.NtpServer = ptr(string(make([]rune, 256*1024)))
	if err := fitPayload(&snapshot); err == nil {
		t.Fatal("oversized base accepted")
	}
}
```

Write `system_other_test.go`:

```go
//go:build !windows

package timesync

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestNonWindowsCollectsNothing(t *testing.T) {
	dir := t.TempDir()
	if NewSystem() != nil {
		t.Fatal("non-Windows system exists")
	}
	got, err := New(dir, NewSystem()).Collect(context.Background())
	if err != nil || got != nil {
		t.Fatal(got, err)
	}
	if _, err = os.Stat(filepath.Join(dir, "timesync-state.json")); !os.IsNotExist(err) {
		t.Fatal("non-Windows state written")
	}
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected FAIL: `undefined: New`, `undefined: fitPayload`.
- [ ] Create `persist.go`:

```go
package timesync

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

const stateName = "timesync-state.json"
const maxStateBytes = 4 * 1024 * 1024

var salvageCounter = regexp.MustCompile(`"sequence"\s*:\s*([0-9]{1,20})`)

type diskState struct {
	Sequence    uint64    `json:"sequence"`
	EventsSince time.Time `json:"eventsSince"`
}

func writeState(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(b) > maxStateBytes {
		return fmt.Errorf("time sync state exceeds 4 MiB")
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp) }()
	if _, err = f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			time.Sleep(25 * time.Millisecond << uint(attempt-1))
		}
		if err = os.Rename(tmp, path); err == nil {
			return nil
		}
	}
	return fmt.Errorf("replace time sync state after 4 attempts: %w", err)
}
func readState(path string, now time.Time) (diskState, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		if _, e := os.Stat(path + ".corrupt"); e == nil {
			return diskState{Sequence: sequenceFloor(now, 0)}, nil
		}
		return diskState{}, nil
	}
	if err != nil {
		return diskState{}, err
	}
	b, readErr := io.ReadAll(io.LimitReader(f, maxStateBytes+1))
	_ = f.Close()
	if readErr != nil {
		return diskState{}, readErr
	}
	var state diskState
	decodeErr := json.Unmarshal(b, &state)
	if len(b) <= maxStateBytes && decodeErr == nil && state.Sequence <= maxSafeSequence {
		return state, nil
	}
	floor := uint64(0)
	if match := salvageCounter.FindSubmatch(b); len(match) == 2 {
		floor, _ = strconv.ParseUint(string(match[1]), 10, 64)
	}
	_ = os.Remove(path + ".corrupt")
	if err = os.Rename(path, path+".corrupt"); err != nil {
		return diskState{}, fmt.Errorf("quarantine time sync state: %w", err)
	}
	slog.Warn("recovered corrupt time sync state; recent events will be replayed")
	return diskState{Sequence: sequenceFloor(now, floor)}, nil
}
func sequenceFloor(now time.Time, salvaged uint64) uint64 {
	floor := uint64(0)
	if now.UnixMilli() > 0 {
		floor = uint64(now.UnixMilli())
	}
	if salvaged > floor && salvaged <= maxSafeSequence {
		floor = salvaged
	}
	return floor
}
```

Create `collector.go`:

```go
package timesync

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Collector struct {
	mu     sync.Mutex
	dir    string
	sys    System
	now    func() time.Time
	save   func(string, any) error
	loaded bool
	state  diskState
}

func New(stateDir string, sys System) *Collector {
	return &Collector{dir: stateDir, sys: sys, now: time.Now, save: writeState}
}
func (c *Collector) Collect(ctx context.Context) (*Snapshot, error) {
	if c.sys == nil {
		return nil, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	now := c.now().UTC()
	if !c.loaded {
		state, err := readState(filepath.Join(c.dir, stateName), now)
		if err != nil {
			return nil, err
		}
		c.state = state
		c.loaded = true
	}
	if c.state.Sequence >= maxSafeSequence {
		return nil, fmt.Errorf("time sync sequence exhausted")
	}
	since := c.state.EventsSince
	if since.IsZero() || since.After(now) {
		since = now.Add(-24 * time.Hour)
	}
	events, err := collectEvents(ctx, c.sys, since, now)
	if err != nil {
		return nil, err
	}
	s := emptySnapshot(now)
	s.Sequence = c.state.Sequence + 1
	s.Events = events
	s.Config = readConfig(ctx, c.sys)
	s.Domain = readDomain(ctx, c.sys)
	s.Status = readStatus(ctx, c.sys, events)
	if zone, e := c.sys.DynamicTimezone(ctx); e == nil {
		s.Timezone = zone
		s.Timezone.AutoUpdate = "unknown"
	}
	if start, e := c.sys.ReadDWORD(ctx, `SYSTEM\CurrentControlSet\Services\tzautoupdate`, "Start"); e == nil {
		switch start {
		case 3:
			s.Timezone.AutoUpdate = "on"
		case 4:
			s.Timezone.AutoUpdate = "off"
		}
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = fitPayload(&s); err != nil {
		return nil, err
	}
	next := c.state
	next.Sequence = s.Sequence
	if err = c.save(filepath.Join(c.dir, stateName), next); err != nil {
		return nil, err
	}
	c.state = next
	return &s, nil
}
func (c *Collector) Commit(snapshot *Snapshot) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.loaded || snapshot == nil || snapshot.SchemaVersion != 1 || snapshot.Sequence == 0 || snapshot.Sequence > c.state.Sequence || snapshot.CollectedAt.IsZero() {
		return fmt.Errorf("invalid time sync commit")
	}
	// Delayed commits are idempotent and cannot rewind an already committed boundary.
	if !snapshot.CollectedAt.After(c.state.EventsSince) {
		return nil
	}
	next := c.state
	next.EventsSince = snapshot.CollectedAt.UTC()
	if err := c.save(filepath.Join(c.dir, stateName), next); err != nil {
		return err
	}
	c.state = next
	return nil
}
func readConfig(ctx context.Context, sys System) Config {
	c := Config{ServiceState: "unknown", ServiceStartType: "unknown", PolicyManagedValues: []string{}}
	if value, err := sys.ReadString(ctx, serviceKey+`\Parameters`, "Type"); err == nil {
		switch value {
		case "NT5DS", "NTP", "NoSync", "AllSync":
			c.Type = ptr(value)
		}
	}
	if value, err := sys.ReadString(ctx, serviceKey+`\Parameters`, "NtpServer"); err == nil && strings.TrimSpace(value) != "" {
		c.NtpServer = ptr(limitText(value, 1024))
	}
	if value, err := sys.ReadDWORD(ctx, serviceKey+`\TimeProviders\NtpClient`, "SpecialPollInterval"); err == nil {
		c.SpecialPollIntervalSeconds = ptr(value)
	}
	if value, err := sys.ReadDWORD(ctx, serviceKey+`\TimeProviders\VMICTimeProvider`, "Enabled"); err == nil && value <= 1 {
		c.HostTimeProviderEnabled = ptr(value == 1)
	}
	values := map[string]bool{}
	for _, suffix := range []string{`\Parameters`, `\TimeProviders\NtpClient`} {
		names, err := sys.ValueNames(ctx, policyKey+suffix)
		if err != nil {
			c.PolicyManaged = true
		}
		for _, name := range names {
			if name != "" {
				values[limitText(name, 64)] = true
				c.PolicyManaged = true
			}
		}
	}
	for name := range values {
		c.PolicyManagedValues = append(c.PolicyManagedValues, name)
	}
	sort.Strings(c.PolicyManagedValues)
	if len(c.PolicyManagedValues) > 20 {
		c.PolicyManagedValues = c.PolicyManagedValues[:20]
	}
	if service, err := sys.W32TimeService(ctx); err == nil {
		c.ServiceState = service.State
		c.ServiceStartType = service.StartType
	}
	return c
}

const maxPayloadBytes = 256 * 1024

func fitPayload(s *Snapshot) error {
	for {
		b, err := json.Marshal(s)
		if err != nil {
			return err
		}
		if len(b) <= maxPayloadBytes {
			return nil
		}
		// Events are newest first. Remove only unreserved rows, oldest first.
		removable := -1
		for i := len(s.Events) - 1; i >= 0; i-- {
			if !s.Events[i].displayReserved {
				removable = i
				break
			}
		}
		if removable >= 0 {
			s.Events = append(s.Events[:removable], s.Events[removable+1:]...)
			continue
		}
		// Even 20 capped rows can exceed the byte budget after JSON escaping.
		// Preserve every reserved ID/time/level, property position and the first
		// insertion string (source evidence). Reduce display text and remaining
		// insertion-string lengths until the serialized body fits.
		changed := false
		shrink := func(value string) string {
			if value == "" {
				return value
			}
			changed = true
			return limitText(value, len([]rune(value))/2)
		}
		for i := range s.Events {
			s.Events[i].Message = shrink(s.Events[i].Message)
			for j := 1; j < len(s.Events[i].Properties); j++ {
				s.Events[i].Properties[j] = shrink(s.Events[i].Properties[j])
			}
		}
		if !changed {
			return fmt.Errorf("time sync base payload and reserved event metadata exceed 256 KiB")
		}
	}
}
```

The bool-only `policyManaged` contract cannot express an access-denied read. Treat policy-read failure conservatively as managed while retaining only value names actually read, including partial results and readable sibling keys. Missing keys return an empty successful list in the Windows adapter; they are not the same as access denied. W03b must re-read management state immediately before writing, as its spec requires.

R5 requires a 256 KiB serialized snapshot budget, including enforcement when W03b adds it. Character limits alone do not bound JSON bytes. Remove oldest unreserved events first; if the reserved display rows alone exceed the budget, shorten their display text and later insertion strings while keeping all reserved IDs, timestamps, levels, property positions and the first insertion string used as source evidence. Return an error if the base payload plus reserved metadata cannot fit. W03b must retain the selected event slice and call `fitPayload` after attaching enforcement; it must not JSON-roundtrip the snapshot (which drops the private reservation metadata), rebuild events or introduce another budget. Corrupt-state recovery deliberately replays the first 24 hours and uses a safe numeric sequence floor, mirroring hwhealth; read/write permission failures remain visible errors.

- [ ] Run:

```bash
(cd agent && go test -race ./internal/collectors/timesync/...)
(cd agent && GOOS=windows go vet ./internal/collectors/timesync/...)
(cd agent && GOOS=windows go test -c -o /tmp/timesync.test.exe ./internal/collectors/timesync)
```

Expected PASS. Verify `TestFreshCollectionsAndCommittedEventCursor`, `TestConcurrentCollectAllocatesDistinctSequences`, `TestSnapshotBudgetPreservesEntireDisplayReservation` and the disk-error tests actually ran.

- [ ] Commit:

```bash
git add agent/internal/collectors/timesync/collector.go agent/internal/collectors/timesync/persist.go agent/internal/collectors/timesync/collector_test.go agent/internal/collectors/timesync/system_other_test.go
git commit -m "feat(agent): persist time sync sequences and committed event cursors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Schedule, guard, send and stop through heartbeat

**Files:**
- Create: `agent/internal/heartbeat/{time_sync.go,time_sync_test.go}`.
- Modify: `agent/internal/heartbeat/heartbeat.go:30,456,1002,1004,1845,2052–2053,2136–2138,2154,2175,2341–2345,2361–2364`.
- Read: `agent/internal/heartbeat/hardware_health.go:15–23,72–114,130–187`, `hardware_health_test.go:32–34,78–155`.

**Interfaces:**
- Consumes: `timesync.New(stateDir string,sys System) *timesync.Collector`, `Collect`, `Commit(*timesync.Snapshot)` (Task 7); `collectors.Guard[T any](op string,fn func()(T,error)) (T,error)` at `collectors/safe.go:124`.
- Consumes: `(*Heartbeat).sendInventoryData(endpoint string,payload any,label string) error` at `heartbeat.go:2328`; `dueForRun(now,last time.Time,interval time.Duration) bool` at `heartbeat.go:2400`; `config.GetDataDir() string` at `config/config.go:1160`.
- Produces: `startTimeSync`, `timeSyncDueLocked`, `dispatchTimeSync`, `sendTimeSync`, `stopTimeSync` and the `lastTimeSyncUpdate` ticker gate.

- [ ] Write `time_sync_test.go`:

```go
package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/timesync"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

type timeCollectorFake struct {
	collect           func(context.Context) (*timesync.Snapshot, error)
	committed         atomic.Uint64
	commitErr         error
	committedSnapshot *timesync.Snapshot
}

func (f *timeCollectorFake) Collect(ctx context.Context) (*timesync.Snapshot, error) {
	return f.collect(ctx)
}
func (f *timeCollectorFake) Commit(snapshot *timesync.Snapshot) error {
	if f.commitErr != nil {
		return f.commitErr
	}
	f.committedSnapshot = snapshot
	f.committed.Store(snapshot.Sequence)
	return nil
}
func timeHeartbeat(t *testing.T, f *timeCollectorFake) *Heartbeat {
	t.Helper()
	cfg := config.Default()
	cfg.AgentID = "fixture-agent"
	cfg.ServerURL = "https://time.example.com"
	cfg.AuthToken = "fixture-token"
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return &Heartbeat{config: cfg, timeSyncCol: f, timeSyncContext: ctx, timeSyncCancel: cancel, retryCfg: httputil.DefaultRetryConfig()}
}
func TestTimeSyncScheduleAndSingleFlight(t *testing.T) {
	last := time.Unix(1000, 0)
	for i := 0; i < 100; i++ {
		id := string(rune(i))
		d := timeSyncFirstDelay(id)
		if d < 2*time.Minute || d > 5*time.Minute {
			t.Fatal(d)
		}
		interval := timeSyncInterval(id, last)
		if interval < 27*time.Minute || interval > 33*time.Minute {
			t.Fatal(interval)
		}
	}
	h := timeHeartbeat(t, &timeCollectorFake{})
	if h.timeSyncDueLocked(last, false) {
		t.Fatal("ran before delayed first run")
	}
	if !h.timeSyncDueLocked(last, true) {
		t.Fatal("first cycle not claimed")
	}
	if h.timeSyncDueLocked(last.Add(time.Hour), false) {
		t.Fatal("overlapping cycle claimed")
	}
	h.timeSyncRunning = false
	due := last.Add(timeSyncInterval(h.config.AgentID, last))
	if h.timeSyncDueLocked(due, false) {
		t.Fatal("strict gate boundary changed")
	}
	if !h.timeSyncDueLocked(due.Add(time.Nanosecond), false) {
		t.Fatal("due cycle missed")
	}
	h.timeSyncRunning = false
	h.stopTimeSync()
	if h.timeSyncDueLocked(due.Add(time.Hour), true) {
		t.Fatal("stopped collector restarted")
	}
}
func TestTimeSyncPUTAndQualifiedCommit(t *testing.T) {
	cases := []struct {
		name   string
		code   int
		body   string
		commit bool
	}{
		{"accepted", 200, `{"accepted":true}`, true},
		{"other 2xx accepted", 201, `{"accepted":true}`, true},
		{"stale sequence", 200, `{"accepted":false,"reason":"stale_sequence"}`, true},
		{"false without reason", 200, `{"accepted":false}`, false},
		{"other reason", 200, `{"accepted":false,"reason":"disabled"}`, false},
		{"missing accepted", 200, `{"reason":"stale_sequence"}`, false},
		{"null accepted", 200, `{"accepted":null,"reason":"stale_sequence"}`, false},
		{"wrong type", 200, `{"accepted":"true"}`, false},
		{"malformed", 200, `{`, false},
		{"trailing JSON", 200, `{"accepted":true}{}`, false},
		{"empty response", 204, "", false},
	}
	for _, code := range []int{400, 401, 403, 413, 422, 429, 503} {
		cases = append(cases, struct {
			name   string
			code   int
			body   string
			commit bool
		}{fmt.Sprint(code), code, `{"accepted":true}`, false})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := &timesync.Snapshot{SchemaVersion: 1, Sequence: 7, CollectedAt: time.Unix(100, 0).UTC()}
			f := &timeCollectorFake{collect: func(context.Context) (*timesync.Snapshot, error) { return snapshot, nil }}
			h := timeHeartbeat(t, f)
			h.retryCfg.MaxRetries = 0
			var calls atomic.Int32
			h.client = &http.Client{Transport: hardwareTransport(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				if r.Method != "PUT" || r.URL.Path != "/api/v1/agents/fixture-agent/time-status" || r.Header.Get("Authorization") != "Bearer fixture-token" {
					t.Error(r.Method, r.URL, r.Header)
				}
				var sent map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
					t.Error(err)
				}
				if string(sent["enforcement"]) != "null" || string(sent["sequence"]) != "7" {
					t.Error(sent)
				}
				return &http.Response{StatusCode: tc.code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			h.timeSyncRunning = true
			h.dispatchTimeSync()
			h.inventoryWg.Wait()
			if calls.Load() != 1 {
				t.Fatal("unexpected request count", calls.Load())
			}
			if tc.commit {
				if f.committed.Load() != 7 || f.committedSnapshot != snapshot {
					t.Fatal("qualified delivery did not commit exact snapshot")
				}
			} else if f.committed.Load() != 0 {
				t.Fatal("unqualified delivery committed")
			}
			if h.timeSyncRunning {
				t.Fatal("running gate stranded")
			}
		})
	}
}

func TestTimeSyncTransportAndCommitFailures(t *testing.T) {
	for _, phase := range []string{"transport", "commit"} {
		t.Run(phase, func(t *testing.T) {
			f := &timeCollectorFake{collect: func(context.Context) (*timesync.Snapshot, error) {
				return &timesync.Snapshot{SchemaVersion: 1, Sequence: 7}, nil
			}}
			if phase == "commit" {
				f.commitErr = errors.New("disk full")
			}
			h := timeHeartbeat(t, f)
			h.retryCfg.MaxRetries = 0
			h.client = &http.Client{Transport: hardwareTransport(func(*http.Request) (*http.Response, error) {
				if phase == "transport" {
					return nil, errors.New("connection lost")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"accepted":true}`))}, nil
			})}
			h.timeSyncRunning = true
			h.dispatchTimeSync()
			h.inventoryWg.Wait()
			if f.committed.Load() != 0 || h.timeSyncRunning {
				t.Fatal("failure committed or stranded gate")
			}
		})
	}
}

func TestTimeSyncResponseValidationDoesNotChangeOtherInventory(t *testing.T) {
	h := timeHeartbeat(t, &timeCollectorFake{})
	h.client = &http.Client{Transport: hardwareTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	if err := h.sendInventoryData("hardware-health", map[string]string{}, "hardware health"); err != nil {
		t.Fatal(err)
	}
}

func TestTimeSyncCollectionAndUploadCancellation(t *testing.T) {
	for _, phase := range []string{"collect", "upload"} {
		t.Run(phase, func(t *testing.T) {
			entered := make(chan struct{})
			f := &timeCollectorFake{collect: func(ctx context.Context) (*timesync.Snapshot, error) {
				if phase == "collect" {
					close(entered)
					<-ctx.Done()
					return nil, ctx.Err()
				}
				return &timesync.Snapshot{SchemaVersion: 1, Sequence: 1}, nil
			}}
			h := timeHeartbeat(t, f)
			h.client = &http.Client{Transport: hardwareTransport(func(r *http.Request) (*http.Response, error) {
				close(entered)
				<-r.Context().Done()
				return nil, r.Context().Err()
			})}
			h.timeSyncRunning = true
			h.dispatchTimeSync()
			<-entered
			h.stopTimeSync()
			done := make(chan struct{})
			go func() { h.inventoryWg.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("uncancelled cycle")
			}
			if f.committed.Load() != 0 {
				t.Fatal("cancelled send committed")
			}
		})
	}
}
func TestTimeSyncPanicAndNilDoNotSend(t *testing.T) {
	for _, panicNow := range []bool{false, true} {
		f := &timeCollectorFake{collect: func(context.Context) (*timesync.Snapshot, error) {
			if panicNow {
				panic("fixture panic")
			}
			return nil, nil
		}}
		h := timeHeartbeat(t, f)
		h.client = &http.Client{Transport: hardwareTransport(func(*http.Request) (*http.Response, error) { t.Error("unexpected send"); return nil, context.Canceled })}
		h.timeSyncRunning = true
		h.dispatchTimeSync()
		h.inventoryWg.Wait()
		if h.timeSyncRunning || f.committed.Load() != 0 {
			t.Fatal("guard failed to release gate")
		}
	}
}
func TestTimeSyncStartupTimerDrains(t *testing.T) {
	h := timeHeartbeat(t, &timeCollectorFake{collect: func(context.Context) (*timesync.Snapshot, error) { t.Error("timer fired immediately"); return nil, nil }})
	h.startTimeSync()
	h.stopTimeSync()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("startup timer not tracked")
	}
}
```

- [ ] Run `cd agent && go test -race ./internal/heartbeat/... -run '^TestTimeSync'`; expected FAIL: `unknown field timeSyncCol`, undefined schedule functions.
- [ ] Create `time_sync.go`:

```go
package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/collectors/timesync"
	"github.com/breeze-rmm/agent/internal/observability"
)

type timeSyncCollector interface {
	Collect(context.Context) (*timesync.Snapshot, error)
	Commit(*timesync.Snapshot) error
}

// A 2xx alone does not establish acceptance. Keep this specific to time-status.
func validateTimeSyncResponse(body io.Reader) error {
	const maxResponseBytes = 64 * 1024
	raw, err := io.ReadAll(io.LimitReader(body, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxResponseBytes {
		return fmt.Errorf("time sync response exceeds 64 KiB")
	}
	var result struct {
		Accepted *bool  `json:"accepted"`
		Reason   string `json:"reason"`
	}
	if err = json.Unmarshal(raw, &result); err != nil {
		return fmt.Errorf("invalid time sync response: %w", err)
	}
	if result.Accepted != nil && (*result.Accepted || result.Reason == "stale_sequence") {
		return nil
	}
	return errors.New("time sync response did not qualify for cursor commit")
}

type timeSyncSubmissionError struct{ status int }

func (e *timeSyncSubmissionError) Error() string {
	return fmt.Sprintf("inventory send failed for time sync: status %d", e.status)
}
func newTimeSyncCollector(dir string) timeSyncCollector {
	sys := timesync.NewSystem()
	if sys == nil {
		return nil
	}
	return timesync.New(dir, sys)
}
func timeSyncHash(id string, last time.Time) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(id + ":time-sync:" + strconv.FormatInt(last.UnixNano(), 10)))
	return h.Sum64()
}
func timeSyncFirstDelay(id string) time.Duration {
	return 2*time.Minute + time.Duration(timeSyncHash(id, time.Time{})%uint64(3*time.Minute+1))
}
func timeSyncInterval(id string, last time.Time) time.Duration {
	const interval = 30 * time.Minute
	offset := int64(timeSyncHash(id, last)%20001) - 10000
	return interval + time.Duration(int64(interval)*offset/100000)
}

// Caller holds h.mu. Claim before dispatch so ticks cannot overlap.
func (h *Heartbeat) timeSyncDueLocked(now time.Time, first bool) bool {
	if h.timeSyncCol == nil || h.timeSyncStopping || h.timeSyncRunning {
		return false
	}
	if !h.timeSyncStarted && !first {
		return false
	}
	if !first && !dueForRun(now, h.lastTimeSyncUpdate, timeSyncInterval(h.config.AgentID, h.lastTimeSyncUpdate)) {
		return false
	}
	h.timeSyncStarted = true
	h.timeSyncRunning = true
	h.lastTimeSyncUpdate = now
	return true
}
func (h *Heartbeat) startTimeSync() {
	h.mu.Lock()
	if h.timeSyncCol == nil || h.timeSyncStopping || h.timeSyncArmed {
		h.mu.Unlock()
		return
	}
	h.timeSyncArmed = true
	h.inventoryWg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.inventoryWg.Done()
		defer observability.Recoverer("heartbeat.timeSyncStartup")
		timer := time.NewTimer(timeSyncFirstDelay(h.config.AgentID))
		defer timer.Stop()
		select {
		case <-h.timeSyncContext.Done():
			return
		case now := <-timer.C:
			h.mu.Lock()
			due := h.timeSyncDueLocked(now, true)
			h.mu.Unlock()
			if due {
				h.dispatchTimeSync()
			}
		}
	}()
}
func (h *Heartbeat) dispatchTimeSync() {
	h.mu.Lock()
	if h.timeSyncStopping {
		h.timeSyncRunning = false
		h.mu.Unlock()
		return
	}
	h.inventoryWg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.inventoryWg.Done()
		defer observability.Recoverer("heartbeat.timeSync")
		h.sendTimeSync()
	}()
}
func (h *Heartbeat) sendTimeSync() {
	defer func() { h.mu.Lock(); h.timeSyncRunning = false; h.mu.Unlock() }()
	snapshot, err := collectors.Guard("time-sync", func() (*timesync.Snapshot, error) { return h.timeSyncCol.Collect(h.timeSyncContext) })
	if err != nil {
		log.Warn("time sync collection failed", "error", err)
		return
	}
	if snapshot == nil {
		return
	}
	if err = h.sendInventoryData("time-status", snapshot, "time sync"); err != nil {
		log.Warn("time sync submission failed", "error", err)
		return
	}
	if err = h.timeSyncCol.Commit(snapshot); err != nil {
		log.Warn("time sync cursor commit failed", "error", err)
	}
}
func (h *Heartbeat) stopTimeSync() {
	h.mu.Lock()
	h.timeSyncStopping = true
	cancel := h.timeSyncCancel
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}
```

No extra import is needed in `heartbeat.go`: the interface and constructor are in the same package. The original import at line 30 remains exactly `"github.com/breeze-rmm/agent/internal/collectors/hwhealth"`; this is an audited template site, not a needless import edit.

- [ ] Apply these exact replacements to `heartbeat.go`, checking the quoted anchors if line numbers moved after W01a. These partial excerpts are formatted in their enclosing Go declarations; retain the surrounding code and run `gofmt` on the completed file:

Anchor `heartbeat.go:456`:

```go
	hwDisabledSnapshot * hwhealth.Snapshot
```

Replacement:

```go
	hwDisabledSnapshot *hwhealth.Snapshot
	timeSyncCol        timeSyncCollector
	lastTimeSyncUpdate time.Time
	timeSyncContext    context.Context
	timeSyncCancel     context.CancelFunc
	timeSyncArmed      bool
	timeSyncStarted    bool
	timeSyncRunning    bool
	timeSyncStopping   bool
```

Anchor `heartbeat.go:1002`:

```go
		hwConfig:                       hwhealth.Config{Enabled: true, PollInterval: 10 * time.Minute, DiskHealthInterval: time.Hour},
```

Replacement:

```go
		hwConfig:                       hwhealth.Config{Enabled: true, PollInterval: 10 * time.Minute, DiskHealthInterval: time.Hour},
		timeSyncCol:                    newTimeSyncCollector(config.GetDataDir()),
```

Anchor `heartbeat.go:1004`:

```go
	h.hwContext, h.hwCancel = context.WithCancel(context.Background())
```

Replacement:

```go
	h.hwContext, h.hwCancel = context.WithCancel(context.Background())
	h.timeSyncContext, h.timeSyncCancel = context.WithCancel(context.Background())
```

Anchor `heartbeat.go:1844–1846`:

```go
func (h *Heartbeat) Start() {
	h.startHardwareHealth()
	h.startPamReconciliationRetryLoop()
```

Replacement:

```go
func (h *Heartbeat) Start() {
	h.startHardwareHealth()
	h.startTimeSync()
	h.startPamReconciliationRetryLoop()
```

Anchor `heartbeat.go:2052–2053`:

```go
			hwTiers := h.hardwareTiersLocked(now, false)
			h.mu.Unlock()
```

Replacement:

```go
			hwTiers := h.hardwareTiersLocked(now, false)
			timeSyncDue := h.timeSyncDueLocked(now, false)
			h.mu.Unlock()
```

Anchor `heartbeat.go:2136–2138`:

```go
			if hwTiers != nil {
				h.dispatchHardwareHealth(hwTiers)
			}
```

Replacement:

```go
			if hwTiers != nil {
				h.dispatchHardwareHealth(hwTiers)
			}
			if timeSyncDue {
				h.dispatchTimeSync()
			}
```

Anchor `heartbeat.go:2153–2155`:

```go
func (h *Heartbeat) DrainAndWait(ctx context.Context) {
	h.stopHardwareHealth()
	log.Info("draining in-flight commands and inventory goroutines")
```

Replacement:

```go
func (h *Heartbeat) DrainAndWait(ctx context.Context) {
	h.stopHardwareHealth()
	h.stopTimeSync()
	log.Info("draining in-flight commands and inventory goroutines")
```

Anchor `heartbeat.go:2173–2176`:

```go
func (h *Heartbeat) Stop() {
	h.stopOnce.Do(func() {
		h.stopHardwareHealth()
		shutdownTimeout := h.shutdownTimeout
```

Replacement:

```go
func (h *Heartbeat) Stop() {
	h.stopOnce.Do(func() {
		h.stopHardwareHealth()
		h.stopTimeSync()
		shutdownTimeout := h.shutdownTimeout
```

Anchor `heartbeat.go:2341–2345`:

```go
	parent := context.Background()
	if endpoint == "hardware-health" && h.hwContext != nil {
		parent = h.hwContext
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
```

Replacement:

```go
	parent := context.Background()
	if endpoint == "hardware-health" && h.hwContext != nil {
		parent = h.hwContext
	}
	if endpoint == "time-status" && h.timeSyncContext != nil {
		parent = h.timeSyncContext
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
```

Anchor in `sendInventoryData`, immediately after `defer resp.Body.Close()` (before the generic 2xx return):

```go
	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		log.Debug("inventory sent", "label", label)
		return nil
	} else {
		log.Warn("inventory send failed", "label", label, "status", resp.StatusCode)
	}
```

Replace that complete response-status branch:

```go
	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		if endpoint == "time-status" {
			if err := validateTimeSyncResponse(resp.Body); err != nil {
				return err
			}
		}
		log.Debug("inventory sent", "label", label)
		return nil
	} else {
		log.Warn("inventory send failed", "label", label, "status", resp.StatusCode)
	}
```

Anchor `heartbeat.go:2361–2364`:

```go
	if endpoint == "hardware-health" {
		return &hardwareSubmissionError{status: resp.StatusCode}
	}
	return fmt.Errorf("inventory send failed for %s: status %d", label, resp.StatusCode)
```

Replacement:

```go
	if endpoint == "hardware-health" {
		return &hardwareSubmissionError{status: resp.StatusCode}
	}
	if endpoint == "time-status" {
		return &timeSyncSubmissionError{status: resp.StatusCode}
	}
	return fmt.Errorf("inventory send failed for %s: status %d", label, resp.StatusCode)
```

Only qualified 2xx responses reach `Commit(snapshot)`. HTTP errors (including 400/413/422), authentication errors, 429, 5xx, transport failures, empty/malformed bodies and unqualified rejections leave `eventsSince` unchanged. There is nothing to discard: the next run always collects fresh facts and a new sequence. A failed cursor save is logged and the event window is replayed on the next run. Keep `validateTimeSyncResponse` when W03b adapts this transport; its send callback must have the same qualified-success meaning.

- [ ] Run:

```bash
(cd agent && go test -race ./internal/heartbeat/... -run '^TestTimeSync')
(cd agent && go test -race ./internal/collectors/timesync/...)
(cd agent && GOOS=windows go vet ./internal/heartbeat/... ./internal/collectors/timesync/...)
(cd agent && GOOS=windows go test -c -o /tmp/heartbeat.test.exe ./internal/heartbeat)
```

Expected PASS. No settings dispatch belongs in `applyConfigUpdate` in W01b; that is explicitly W03b's seam above its policy-probe early return.

- [ ] Commit:

```bash
git add agent/internal/heartbeat/time_sync.go agent/internal/heartbeat/time_sync_test.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): schedule and deliver guarded time sync snapshots" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Prove native behavior, L1–L5 and L9, and complete release verification

**Files:**
- Create: `agent/internal/collectors/timesync/live_windows_test.go`.
- Delete: temporary `agent/internal/collectors/timesync/spike_windows_test.go` after evidence is recorded.
- Read: `agent/Makefile:248–300` (`dev-push`), W01a `DeviceTimeSection.tsx` and GET time-status route from index §I/§E.

**Interfaces:**
- Consumes: the complete Windows `System`, `Collector`, installed-agent update path, W01a device Time section and `GET /api/v1/devices/:id/time-status`.
- Produces: native/race/cross-build evidence and PR table `L# | setup | expected | observed | PASS/FAIL`; no extra repository report or lab inventory.

The native test below has no network calls and never starts or enrolls an agent. It exercises real OS reads only with an explicit lab opt-in. Ordinary Windows unit runs execute only the fixed-input locale replay.

- [ ] Write the failing live/replay tests in `live_windows_test.go`:

```go
//go:build windows

package timesync

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/mgmtdetect"
)

func TestLocaleSnapshotReplay(t *testing.T) {
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	snapshots := []*Snapshot{}
	for _, german := range []bool{false, true} {
		tokens := germanStatus
		message := "Receiving valid time data"
		if !german {
			tokens = strings.NewReplacer("Sprungindikator", "Leap Indicator", "Quelle", "Source", "Abrufintervall", "Poll Interval").Replace(tokens)
		} else {
			message = "Gültige Zeitdaten werden empfangen"
		}
		f := &fakeSystem{tokens: []byte(tokens), identity: mgmtdetect.IdentityStatus{JoinType: mgmtdetect.JoinTypeNone, Source: "dsregcmd"},
			strings: map[string]string{serviceKey + `\Parameters|Type`: "NTP"},
			events: []Event{{RecordID: 1, EventID: 37, Level: 4, OccurredAt: at.Add(-time.Minute), Message: message,
				Properties: []string{"peer.example.com,0x9 (ntp.m|0x9|transport)"}}}}
		c := New(t.TempDir(), f)
		c.now = func() time.Time { return at }
		s, err := c.Collect(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		snapshots = append(snapshots, s)
	}
	if snapshots[0].Events[0].Message == snapshots[1].Events[0].Message {
		t.Fatal("fixture does not exercise locale")
	}
	for _, s := range snapshots {
		for i := range s.Events {
			s.Events[i].Message = ""
		}
	}
	if !reflect.DeepEqual(snapshots[0], snapshots[1]) {
		a, _ := json.Marshal(snapshots[0])
		b, _ := json.Marshal(snapshots[1])
		t.Fatalf("locale affected facts:\n%s\n%s", a, b)
	}
}

func TestLiveTimeSyncFacts(t *testing.T) {
	if os.Getenv("TIMESYNC_LIVE") != "1" {
		t.Skip("explicit lab-only opt-in required")
	}
	wantRole := os.Getenv("TIMESYNC_EXPECT_ROLE")
	if wantRole == "" {
		t.Fatal("TIMESYNC_EXPECT_ROLE must describe this lab scenario")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	sys := NewSystem()
	if sys == nil {
		t.Fatal("Windows constructor returned nil")
	}
	c := New(t.TempDir(), sys)
	s, err := c.Collect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if s.Domain.Role != wantRole {
		t.Fatalf("role=%s want=%s", s.Domain.Role, wantRole)
	}
	if s.Config.ServiceState == "unknown" || s.Timezone.WindowsID == nil {
		t.Fatal("native service/timezone read unavailable")
	}
	if want := os.Getenv("TIMESYNC_EXPECT_KIND"); want != "" && s.Status.SourceKind != want {
		t.Fatalf("source kind=%s want=%s", s.Status.SourceKind, want)
	}
	if want := os.Getenv("TIMESYNC_EXPECT_VMIC"); want != "" {
		if s.Config.HostTimeProviderEnabled == nil || (*s.Config.HostTimeProviderEnabled) != (want == "1") {
			t.Fatal("VMIC provider fact mismatch")
		}
	}
	// Full output is private diagnostic evidence; redact source/domain strings
	// before copying anything to a public PR.
	if os.Getenv("TIMESYNC_PRINT_PRIVATE") == "1" {
		b, _ := json.MarshalIndent(s, "", "  ")
		t.Log(string(b))
	}
	// No API response exists in this read-only test, so do not Commit.
	second, err := New(c.dir, sys).Collect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second.Sequence <= s.Sequence {
		t.Fatal("restart reused sequence")
	}
	t.Logf("schema=%d role=%s method=%s sourceKind=%s events=%d sequence advanced", s.SchemaVersion, s.Domain.Role, s.Status.Method, s.Status.SourceKind, len(s.Events))
}
```

- [ ] Establish the red lab baseline before updating the installed agent: W01a's device Time section reads “no data yet” for an agent that has never sent time status. Record that observation; do not manufacture a failing unit test. Cross-build the new test binary:

```bash
(cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/timesync.test.exe ./internal/collectors/timesync)
```

On Windows, prove the live assertion is sensitive to the scenario by setting `TIMESYNC_EXPECT_ROLE=forest_root_pdc_emulator` on the workgroup Windows lab VM and running the command below. Expected FAIL: `role=workgroup want=forest_root_pdc_emulator`. Restore the correct role immediately before continuing. No Windows setting changes are needed for this negative check.

- [ ] Implement the concrete lab setup and installed-agent update. Use the already-private `.env.dev` values read by the Makefile; set `BREEZE_DEV_DEVICE` to the appropriate enrolled test device in the operator's private environment before each push. Do not paste that ID, an access token or a lab hostname into this plan or a tracked script.

```bash
(cd agent && make dev-push PLATFORM=windows/amd64)
```

This builds a version `dev-<epoch>` and updates the existing installed agent through `/api/v1/dev/push` (`agent/Makefile:263–300`). Confirm that version in the device overview. Never run `breeze-agent run` beside the installed service. Wait up to 5 minutes plus one heartbeat tick for the first Time snapshot. To trigger a fresh first-run timer after changing lab configuration, restart the existing service:

```powershell
$agentService=Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'breeze-agent' }
if (@($agentService).Count -ne 1) { throw 'Expected exactly one installed Breeze agent service' }
Restart-Service -Name $agentService.Name
```

- [ ] Before each mutable lab scenario, save Windows configuration locally outside the checkout. The following registry backup preserves exact raw peer strings and VMIC presence; the service snapshot preserves original startup mode. The local backup path is private operator state, not PR content.

```powershell
$timeBackup=Join-Path $env:TEMP 'breeze-timesync-lab-backup'
New-Item -ItemType Directory -Force -Path $timeBackup | Out-Null
reg.exe export 'HKLM\SYSTEM\CurrentControlSet\Services\W32Time' (Join-Path $timeBackup 'w32time.reg') /y
Get-CimInstance Win32_Service -Filter "Name='W32Time'" | Select-Object State,StartMode | Export-Clixml (Join-Path $timeBackup 'service.xml')
Get-WinUILanguageOverride | Export-Clixml (Join-Path $timeBackup 'ui-language.xml')
Get-WinUserLanguageList | Export-Clixml (Join-Path $timeBackup 'user-languages.xml')
```

Run the native suite from a source checkout with the shared fixture at its repository-relative path. If copying only compiled test binaries, preserve the fixture's relative directory layout and set the working directory to `agent/internal/collectors/timesync` before running `timesync.test.exe`; copying a single EXE to an arbitrary directory will break the host fixture test.

```powershell
$env:TIMESYNC_LIVE='1'
$env:TIMESYNC_EXPECT_ROLE='workgroup'
go test -race ./internal/collectors/timesync/... -run 'TestLiveTimeSyncFacts|TestLocaleSnapshotReplay' -v
```

Run these from the `agent` directory. Expected PASS for workgroup setup. These are OS-read tests, not a second enrolled agent.

- [ ] **L1: default workgroup.** Leave the saved default W32Time settings unchanged. Verify `joinType=none` or `workplace`, `role=workgroup`, raw Type/peer list, actual service state/start type, timezone key and base Bias, and automatic-timezone intent. Compare the Time section with native facts:

```powershell
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time\Parameters' | Select-Object Type,NtpServer
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time\TimeProviders\NtpClient' | Select-Object SpecialPollInterval
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate' | Select-Object Start
Get-TimeZone | Select-Object Id
w32tm.exe /query /status /verbose
```

Expected web findings are determined by actual Windows state, not by assuming workgroup defaults are healthy. Compute the stale threshold from the snapshot: `effectivePoll = status.pollIntervalSeconds ?? config.specialPollIntervalSeconds ?? 604800`; threshold seconds `max(3 * effectivePoll, 86400)`. Record the last-known-good UTC timestamp, snapshot collection time, age and threshold in the PR's L1 evidence. With no last-success evidence, the UI must say unknown; only an active event 36 can then establish `sync_stale`. Do not move the system clock to force the result.

- [ ] **L2: unresolvable manual peer, then recovery.** On the Windows lab VM only:

```powershell
w32tm.exe /config /manualpeerlist:'unresolvable-time.example.invalid,0x9' /syncfromflags:manual /update
Restart-Service W32Time
w32tm.exe /resync /rediscover
```

`example.invalid` is a reserved synthetic failure target, not a real infrastructure hostname. Inspect new events without translated-text matching:

```powershell
Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Time-Service';StartTime=(Get-Date).AddHours(-1)} -MaxEvents 100 |
    Select-Object Id,Level,TimeCreated,@{N='Properties';E={@($_.Properties | ForEach-Object { $_.Value })}}
```

Wait for event 134, restart the installed agent, then expect `ntp_server_unresolvable` in Info → Time and event 134 in recent events. Record the actual level and insertion index. If this build emits a different event, record FAIL and resolve the W01a mapping mismatch; never patch the translated message into the Go parser.

Recover using the saved registry configuration, then resync:

```powershell
reg.exe import (Join-Path $timeBackup 'w32time.reg')
Restart-Service W32Time
w32tm.exe /resync /rediscover
```

Observe event 35 or 37 after the failure, collect another snapshot, and expect the DNS finding to clear. Repeat the invalid-peer setup once more and collect a later event 134; the finding must reappear. This exercises the W01a active-event rule across the actual Go event cursor, including failure → success → same failure.

- [ ] **L3: forest-root PDC on hierarchy.** On the forest-root PDC in the brzlab AD lab, with its config backed up:

```powershell
Import-Module ActiveDirectory
$domain=Get-ADDomain
$forest=Get-ADForest
if ($domain.DNSRoot -ne $forest.RootDomain) { throw 'This scenario requires the forest-root domain' }
$localFqdn=[System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName
if ($domain.PDCEmulator -ne $localFqdn) { throw 'Run this scenario on the forest-root PDC emulator' }
w32tm.exe /config /syncfromflags:domhier /update
Restart-Service W32Time
w32tm.exe /resync /rediscover
$env:TIMESYNC_EXPECT_ROLE='forest_root_pdc_emulator'
go test -race ./internal/collectors/timesync/... -run '^TestLiveTimeSyncFacts$' -v
```

Expected Time section: `Type=NT5DS`, role `forest_root_pdc_emulator`, resolved domain/forest/PDC facts, and `pdc_no_external_source`; capture event 12 when Windows emits it. Child-domain PDC behavior is pinned by Task 3's unit test and must never be mislabeled forest-root. No fleet-page assertion belongs to W01b; that page ships in W02.

- [ ] **L4: VMIC enabled on the same PDC.** Confirm this VM actually has the Hyper-V time integration provider before changing it:

```powershell
$vmic='HKLM:\SYSTEM\CurrentControlSet\Services\W32Time\TimeProviders\VMICTimeProvider'
if (-not (Test-Path $vmic)) { throw 'VMIC provider is absent; use the Hyper-V PDC lab VM' }
Set-ItemProperty -Path $vmic -Name Enabled -Type DWord -Value 1
Restart-Service W32Time
$env:TIMESYNC_EXPECT_VMIC='1'
go test -race ./internal/collectors/timesync/... -run '^TestLiveTimeSyncFacts$' -v
```

Restart the installed agent and expect `hostTimeProviderEnabled=true` and `dc_vm_host_sync` in Time even if the currently observed source is still a domain/manual peer. Record sourceKind independently: enabling a provider is not proof it is the selected source. If method 1 or a verified invariant tag can identify selected VM-host time, require `sourceKind=vm_host` in the native test using `TIMESYNC_EXPECT_KIND`; otherwise retain only the kind actually proved by the selected method (which may still prove a domain/manual peer), or `unknown` when none is proved. Record unsupported VM-host classification as the R7-approved limitation; do not fail the release for an unproven kind.

- [ ] **L5: member server on hierarchy.** On the member server in the brzlab AD lab:

```powershell
w32tm.exe /config /syncfromflags:domhier /update
Restart-Service W32Time
w32tm.exe /resync /rediscover
$env:TIMESYNC_EXPECT_ROLE='member'
$env:TIMESYNC_EXPECT_KIND='unknown'
Remove-Item Env:TIMESYNC_EXPECT_VMIC -ErrorAction SilentlyContinue
```

Use `unknown` for a plain-hostname fallback. Only if Task 1's chosen method proved domain-peer metadata for this scenario, set the stronger expectation before the test:

```powershell
$env:TIMESYNC_EXPECT_KIND='domain_peer'
```

Run the native assertion with that evidence-based expectation:

```powershell
go test -race ./internal/collectors/timesync/... -run '^TestLiveTimeSyncFacts$' -v
```

Expected Time section: `role=member`, `Type=NT5DS`, source matches the observed DC, with `sourceKind=domain_peer` only when the selected metadata proves it and `unknown` for a plain hostname; recent success and no time-source findings. Set the site's expected timezone to match the test VM, or leave the site at the `UTC` default, so an unrelated informational timezone mismatch does not confuse the assertion. A stopped/unreachable DC or actual stale event is a real finding, not a reason to weaken the test.

- [ ] **L9: German display language.** Use a disposable Windows client VM with a language-pack-capable edition. First take English probe/live evidence with the correct identity/role. Install the matching German language pack; on supported Windows 11 images:

```powershell
Install-Language -Language de-DE -CopyToSettings
Set-WinUserLanguageList -LanguageList de-DE,en-US -Force
Set-WinUILanguageOverride -Language de-DE
Set-Culture de-DE
Restart-Computer
```

For Windows 10 / Server 2016 where `Install-Language` is unavailable, mount the matching OS language-pack media and supply its private local CAB path interactively:

```powershell
$languageCab=Read-Host 'Full local path to the matching German language-pack CAB'
Add-WindowsPackage -Online -PackagePath $languageCab -NoRestart
Set-WinUserLanguageList -LanguageList de-DE,en-US -Force
Set-WinUILanguageOverride -Language de-DE
Set-Culture de-DE
Restart-Computer
```

After signing in, run `Get-UICulture` and verify German status labels with `w32tm.exe /query /status /verbose`. User language override alone does not guarantee the LocalSystem service uses German resources. For an actual installed-agent locale check, open `intl.cpl`, Administrative → Copy settings, copy the current language to the welcome screen and system accounts, restart, and verify the service's captured event messages/status evidence. Record both interactive and service contexts. Do not claim L9 passed if only an interactive shell changed language while the agent still ran in English.

Re-run Task 1's probe and the native tests, including `TestLocaleSnapshotReplay`; dev-push to this enrolled VM and check its Time section. Literal live snapshots naturally differ in sequence, collection time, last successful sync time and event record IDs. Compare stable configuration, identity/role, zone, source kind and extraction method, and independently account for advancing observations. The fixed-input replay must compare the whole snapshot field-for-field after removing only event messages; no other field is removed from that assertion. Unsupported/ambiguous facts must remain null/unknown in both languages.

- [ ] Restore every changed lab configuration after evidence is captured:

```powershell
reg.exe import (Join-Path $timeBackup 'w32time.reg')
$serviceBefore=Import-Clixml (Join-Path $timeBackup 'service.xml')
switch ($serviceBefore.StartMode) {
    'Auto' { Set-Service W32Time -StartupType Automatic }
    'Manual' { Set-Service W32Time -StartupType Manual }
    'Disabled' { Set-Service W32Time -StartupType Disabled }
}
if ($serviceBefore.State -eq 'Running') { Restart-Service W32Time } else { Stop-Service W32Time -ErrorAction SilentlyContinue }
Remove-Item Env:TIMESYNC_LIVE -ErrorAction SilentlyContinue
Remove-Item Env:TIMESYNC_EXPECT_ROLE -ErrorAction SilentlyContinue
Remove-Item Env:TIMESYNC_EXPECT_KIND -ErrorAction SilentlyContinue
Remove-Item Env:TIMESYNC_EXPECT_VMIC -ErrorAction SilentlyContinue
```

Prefer reverting the disposable VM snapshot after L9 to undo the system-account language copy and language-pack installation. Preserve private test output before reverting. Do not erase the production agent's state or re-enroll a lab device as a shortcut. If L2 was repeated after restoring its original config, restore once more before leaving the machine.

- [ ] Record actual evidence in the PR description using this table. “Observed” is filled only from the executor's runs; pending evidence is not PASS.

| L# | setup | expected | observed | PASS/FAIL |
|---|---|---|---|---|
| L1 | Windows lab VM, workgroup defaults | Role, source-method limitations, zone facts and stale age/threshold match OS | Record native test and Time section observations | Record result |
| L2 | Invalid manual peer, repair, repeat failure | 134 raises; later 35/37 clears; later 134 raises again | Record UTC ordering, IDs, levels, insertion index and UI finding | Record result |
| L3 | brzlab AD lab, forest-root PDC with NT5DS | Forest-root role and no-external-source finding | Record structured role and event evidence | Record result |
| L4 | Same PDC, VMIC Enabled=1 | VMIC fact and DC VM-host warning | Separate provider enabled from selected-source proof | Record result |
| L5 | brzlab AD lab member on hierarchy | Member, observed DC source, proven domain kind or unknown, successful sync, no source findings | Record native and web state | Record result |
| L9 | German client and service display context | Fixed-input equality except message; live facts remain locale-independent | Record OS/language/context, extraction methods and explained time changes | Record result |

Include a second method-coverage row for each §4.2 `sourceKind`: `local_clock`, `free_running`, `vm_host`, `domain_peer`, `ntp_peer`. Record what the chosen method proves and which kinds intentionally remain `unknown` under R7. Unit fake coverage does not establish native capability. An unsupported kind reported as `unknown` is an approved fallback limitation; a fabricated kind or a mismatch with proven evidence is FAIL. Method 1 additionally requires the installed `w32time.h` prototype/ownership citation and a passing L1/L3/L5/L9 comparison before shipping.

- [ ] Delete only the temporary spike file after recording evidence:

```bash
rm agent/internal/collectors/timesync/spike_windows_test.go
```

Keep the permanent native-layout tests and fixed-input German regression. Run final formatting and checks from the repository root:

```bash
gofmt -w agent/internal/collectors/timesync/*.go agent/internal/collectors/command_export.go agent/internal/collectors/command_export_test.go agent/internal/mgmtdetect/identity.go agent/internal/mgmtdetect/identity_test.go agent/internal/heartbeat/time_sync.go agent/internal/heartbeat/time_sync_test.go agent/internal/heartbeat/heartbeat.go
gofmt -l agent/internal/collectors/timesync/*.go agent/internal/collectors/command_export.go agent/internal/collectors/command_export_test.go agent/internal/mgmtdetect/identity.go agent/internal/mgmtdetect/identity_test.go agent/internal/heartbeat/time_sync.go agent/internal/heartbeat/time_sync_test.go agent/internal/heartbeat/heartbeat.go
(cd agent && go test -race ./internal/collectors/timesync/... ./internal/mgmtdetect/... ./internal/heartbeat/...)
(cd agent && GOOS=windows go vet ./internal/collectors/timesync/... ./internal/mgmtdetect/... ./internal/heartbeat/...)
(cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/timesync.test.exe ./internal/collectors/timesync)
(cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/mgmtdetect.test.exe ./internal/mgmtdetect)
(cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/heartbeat.test.exe ./internal/heartbeat)
(cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/collectors.test.exe ./internal/collectors)
```

`gofmt -l` must print nothing. Run these commands from the repo root; each `cd agent` uses a subshell so the block also works when pasted as a whole. On a Windows lab checkout, run the changed packages natively with the race detector and opt-in live test. Preserve the source checkout structure so the shared fixture resolves.

- [ ] Final release checks (executor only, after the targeted suites and lab gates pass):

```bash
(cd agent && go test -race ./...)
(cd agent && GOOS=windows go vet ./...)
git diff --check
git status --short
```

Expected PASS; no missing test packages, no native tests silently skipped when reporting lab proof, and no changes outside the file structure above. W01b has no tenancy changes, so the index's W01a/W02/W03a RLS/cascade/export integration-suite requirement does not apply; do not start a database stack for this Go-only PR. If implementation expands into tenancy, stop that scope expansion and amend the plan rather than silently skipping its contract suites.

- [ ] Commit permanent lab regression tests and removal of the spike; attach the lab evidence to the PR description, never to a new repo document:

```bash
git add agent/internal/collectors/timesync/live_windows_test.go agent/internal/collectors/timesync/spike_windows_test.go
git commit -m "test(agent): verify native time sync collection and locale parity" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Self-Review

### 1. Requirement-to-task coverage

| Owned spec/index requirement | Task(s) | Coverage / limit |
|---|---|---|
| §4.2 first-task status-source spike | 1 | Tagged Go probe, ordered evaluation, English/German and OS-floor evidence; native DLL invocation blocked on verified ABI. |
| §4.2 provider structures and provider-first ladder | 1, 4, 6 | Published RPC layout assertions, complete SPI ladder; method 1 requires installed-SDK ABI/ownership plus L1/L3/L5/L9 proof; R7 approves the complete fallback otherwise. |
| §4.2 five source kinds, locale-independent reads | 4, 9 | Every kind tested through fake provider; only validated provider/token/event metadata establishes a kind; plain hosts under NTP and NT5DS remain unknown (R7). |
| §4.1 W32Time config, policy presence and VMIC | 2, 6, 7 | Registry adapter, nullable facts, fail-closed managed flag on read failure, preserving readable names including partial-error results (R6). |
| §4.1 service state/start type | 6, 7 | Collector owns raw SCM reads and trigger presence; svcquery stays unchanged for other callers (R8). |
| §4.3 existing identity and role derivation | 3, 6 | Minimal exported wrapper; every role and API-failure path; DNS/forest equality; correct native buffers/frees. |
| §4.4 all-level Time-Service events | 5, 6 | Provider filter with insertion properties, UTC, no message parsing, query failures preserved. |
| §4.4 first 24 hours, since last successful run, max100 | 5, 7 | Fresh reads and distinct sequences on every call; only a qualified send commits eventsSince; failures/restarts replay uncommitted events (R4). |
| §4.4 recent20 any-ID display tail and serialized budget | 5, 7 | ID-only deduplication keeps newest occurrence; all display IDs survive the count/256 KiB caps, including after enforcement is attached (R5). |
| §4.5 native zone ID, Bias, DST-disabled and tzautoupdate | 6, 7 | Exact struct layout; raw base Bias; Start3/on,4/off,other/unknown tests. |
| §4.6 JSON and monotonic sequence | 2, 7 | Exact keys/nullability; persisted safe-integer sequence; restart/corruption/write-failure/concurrency cases. |
| §4.6 cadence and upload | 8 | 2–5m first timer, 27–33m repeat gate, PUT endpoint, qualified accepted/stale-sequence response validation, single-flight, stop/drain and cancellation. |
| §4 Guard and bounded exec | 6, 8 | Existing bounded runner wrapper, Guard at heartbeat boundary, panic test. |
| §B shared NTP host fixture and odd-spacing parser | 2 | Exact relative path; shared valid/invalid sets; multi-flag suffixes and empty array. |
| §H package layout and non-Windows behavior | 2–8 | All named files exist in implementation plan; additional files separate persistence/event exec and tests; nil/no send on other OSes. |
| §F.3 future enforcement compatibility | 2, 7 | Report shape exists, W01b always sends null. |
| §12 / §J L1–L5 and L9 | 9 | Dev-push, state backups, exact setup/recovery commands, Time section assertions and PR evidence table. |
| Index global agent verification | 6–9 | Targeted race cycles, Windows vet and test cross-builds, native execution, executor's final full Go verification. |
| W03b exclusion | 1–9 | No writer, policy apply, reconciliation or time command handler. |

### 2. Placeholder scan

All nine tasks remain. Embedded Go is formatted with `gofmt`, including partial heartbeat replacements formatted in enclosing declarations; no implementation files are written during authoring. Source anchors and cross-wave names were read-checked against W01a and W03b. Tasks 5, 7 and 8 now include ID-only newest-occurrence deduplication, display reservation under count/byte limits, fresh reads, distinct concurrent sequences, two-key persistence, cursor-save failures and qualified-response tests. Implementation and native lab tests are executor work and have not been run while authoring. R7 approves the complete fallback; the optional provider method still needs SDK/lab evidence before activation. PR evidence cells instruct the executor to record observations, not fabricate results.

### 3. Type consistency against the cross-wave contract

- `Snapshot` has exactly `schemaVersion`, `sequence`, `collectedAt`, `config`, `status`, `domain`, `timezone`, `events`, `enforcement`; no hardware-only `agentVersion`/snapshot ID leaks into the strict schema.
- All nested §B keys are present. Nullable Go pointers encode JSON null; enums are emitted only from closed branches. `EnforcementReport` has §F.3 `ntp`/`timezone` nullable results and is null in W01b.
- `uint64` sequences and record IDs are bounded to JavaScript safe integers; status strata are 0–16; DWORD intervals remain nonnegative; Bias is -1440–1440.
- Timestamp fields use `time.Time` and UTC output, acceptable to `z.string().datetime({offset:true})`. No locale date parser exists.
- Status uses only `provider_api`, `w32tm_tokens`, `events`, `unavailable`; unsupported distinctions stay `unknown`.
- `New`, `Collect`, `Commit`, `ParseNtpServerHosts`, `IsValidNtpServerHost`, `NewSystem`, package paths, state filename and `sendInventoryData("time-status", snapshot, "time sync")` match §H verbatim.
- Shared host fixture path is exactly `../../../../packages/shared/src/validators/__fixtures__/ntpServers.json`; four parents are correct from the package directory.
- No migration slot, schema version, built-in monitor version or W03b settings/command name changes.
- R4 defines `Commit(*Snapshot) error`; only `sequence` and `eventsSince` persist. W03b consumes this interface, retains `System` for direct guard reads, and reuses `fitPayload` after attaching enforcement without rebuilding the collector-selected events.
- R1 has no locale step in this Go-only plan; it adds no catalogs, translations or translation-baseline changes. R2–R3 and R11–R15 belong to the API/web or management waves; W01b does not redefine those contracts. R6–R10 and R16–R17 are covered here.

### 4. Review Focus coverage

| Input | Expected behavior | Pin |
|---|---|---|
| German w32tm text | No translated source/date parsing; same stable facts | Task 4 `TestGermanTokensNeverParseTranslatedValues`; Task 9 `TestLocaleSnapshotReplay` and L9 |
| Failed delivery and restart | Fresh facts/new sequence, unchanged committed cursor, unaccepted events replayed | Task 7 `TestFreshCollectionsAndCommittedEventCursor`; Task 8 `TestTimeSyncPUTAndQualifiedCommit` |
| Large/duplicate event sets | Newest occurrence per ID, all newest-20 display IDs retained, body ≤256 KiB | Task 5 deduplication/count tests; Task 7 `TestSnapshotBudgetPreservesEntireDisplayReservation` |
| Failed native reads and ambiguous tokens | Null/unknown, fail-closed role, no fabricated source | Tasks 3–7 table cases and explicit unavailable adapter |
| Overlap, panic, collect/upload cancellation | Single flight, released gate, tracked goroutine drain | Task 8 scheduling, panic and cancellation cases |

## Contract issues

1. **RESOLVED — unverified DLL ABI (R7).** The fallback ladder is approved in advance. Method 1 ships only if Task 1 cites its prototype and buffer-ownership rules from the installed Windows SDK `w32time.h` and passes the L1/L3/L5/L9 comparison. RPC layouts and export lookup alone do not establish a callable DLL ABI. Tasks 1, 4, 6 and 9 preserve the complete fallback without an unresolved release-design gate.

2. **RESOLVED — source-kind acceptance versus no guessing (R7).** Only kinds proved by the chosen provider, invariant token or validated event metadata are emitted. Unsupported kinds are `unknown`, an approved limitation. Task 4 removes config/role-based classification of plain hostnames and tests both NTP and NT5DS; Task 9 records supported and unknown kinds separately.

3. **RESOLVED — lossy svcquery state (R8).** Task 6 uses its own raw SCM reads for paused/pending state and delayed-auto/trigger-manual startup. Existing `svcquery.GetStatus` remains unchanged for other consumers.

4. **RESOLVED — private exec helper (R9).** Task 6 adds `collectors.RunCollectorOutput` as a thin context-aware wrapper over the existing bounded runner; `timesync` calls that exported helper.

5. **RESOLVED — cursor/display event union and budget (R4, R5).** Tasks 5 and 7 union since-cursor all-level events with the newest 20 of any age, deduplicate solely by record ID retaining the newest occurrence, reserve display IDs at both count and byte limits, sort newest first and cap at 100 / 256 KiB serialized. Only `sequence` and `eventsSince` persist. Every collection reads fresh facts, and Task 8 commits the cursor only after the qualified API response. W03b consumes `Commit(*Snapshot)` and the same budget helper; the old pending/acknowledge/discard design is removed.

6. **RESOLVED — L9 equality (R10).** Task 9 requires whole-snapshot fixed-input equality after removing only `events[].message`. Independent live runs compare stable fields while recording legitimate sequence, time and event differences.

7. **RESOLVED — branch convention (R16).** CLAUDE.md's feature-lifecycle rule takes precedence: `feature/<parent#>-time-sync/wave-<sub-issue#>`, with the index's `-b` suffix for W01b as the second PR in W01. This authoring task creates no branch.

8. **RESOLVED — spike corrections after merged W01a (R7).** If lab evidence disproves an event-ID meaning, a small API follow-up fixes it before the W01b agent release. Task 9 records a proved mapping mismatch as FAIL until corrected; this plan does not expand the Go-only PR or parse translated messages.

9. **RESOLVED — events branch source is the newest event 35 only (D3, R7; Task 4 review).** Event 35 ("now synchronizing with") names the chosen source; event 37 names a peer that is receiving data. Lab evidence (the Windows lab VM, a Hyper-V guest with VMIC active per `w32tm /query /source`): event 37 `time.windows.com,0x8 (ntp.m|…)` at 21:35:53 was followed by event 35 `VM IC Time Synchronization Provider` at 21:35:56. The Task 4 code as first written skipped the unparsable 35 and reported the older 37 peer as the source (`method=events`, `ntp_peer`), a false fact on every Hyper-V guest with VMIC active. `readStatus` now reads only the newest event 35 (record ID breaks a timestamp tie). If its `Properties[0]` is not host(+flags), `source` is `null`, `sourceKind` is `unknown` and `method` is `unavailable`. It never falls back to an older 35 or to any 37. This is agent-side selection logic, not an event-ID meaning, so it needs no API follow-up. The Task 4 code block above is superseded by `status.go`. **L-owed:** on an NTP-active host, confirm that event 35's `Properties[0]` has the `host,0xN (ntp.m|…)` form. This is INFERRED from the message template and not lab-checked, because every event 35 on the lab VM names VMIC.

10. **RESOLVED — events never set `lastSuccessfulSyncAt` (spec §14; Task 4 review).** Events 35/37 fire when the service starts or the source changes, not on every sync. Lab evidence: the lab VM's 35/37 history clusters at 7/16, 7/23, 8/6, 8/8, 8/28, 9/16, 9/24 and 9/28 (reboots and restarts), with gaps of up to three weeks while the clock stayed in sync. The W01a resolver raises `sync_stale` when `now − lastSuccessfulSyncAt > max(3 × (pollIntervalSeconds ?? specialPollIntervalSeconds ?? 604800), 24h)`, and `pollIntervalSeconds` is always `null` in the token-disabled variant. An event time therefore gives a false, alertable `sync_stale`: after 21 days on a workgroup host (SpecialPollInterval 604800) and, INFERRED without an AD lab, after one day on a domain member (default 3600, so the 24 h floor applies). With `method=events`, `lastSuccessfulSyncAt` is `null`. Only a proven method sets it: `provider_api`, or `w32tm_tokens` once L9 and floor evidence exist, and then only from its own field, never copied from an event. Events 35/37 stay in `events[]`, where the §5.3 rule uses them as success signals to clear failure findings. Spec §14's approved outcome applies: `sync_stale` falls back to event 36 only, and the UI shows "last sync unknown". The alternative was a W02/API change so that `sync_stale` ignores `lastSuccessfulSyncAt` when `status.method = 'events'`. It was not taken, because the agent fix needs no cross-PR ordering before the W01b agent release.

No contract decisions remain open. Native Windows observations and optional method-1 proof remain execution evidence, not completed work. R17 formatting applies to all nine tasks, with `gofmt -l` and Go vet included in final verification.

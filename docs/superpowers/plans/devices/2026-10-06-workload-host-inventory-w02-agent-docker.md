# Workload Host Inventory W02 — Agent Core + Docker/Podman Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent half of workload inventory: a read-only `workloads` collector with a `Driver` interface, Docker and Podman drivers (plus a detect-only containerd driver), the `workload_inventory_settings` delivery path, change-only upload to `PUT /api/v1/agents/{agentID}/workloads`, and the `workloadInventoryProtocolVersion` capability. Hyper-V and Proxmox drivers are W03 and are not registered here.

**Architecture:** `agent/internal/collectors/workloads/` owns types, image-reference normalization, a GET-only HTTP transport over a unix socket / named pipe, one Docker-compatible engine driver (used for both Docker and Podman), a detect-only containerd driver, and a `Collector` that always detects and enumerates only runtimes the settings enable. `agent/internal/heartbeat/workloads.go` runs one self-timed, cancellable worker: it applies settings, collects, hashes, and sends only when the hash changed or six hours passed, advancing the hash only after a 2xx. Nothing in this PR changes the API, database, shared validators or web app; W01 owns the server side of the contract.

**Tech Stack:** Go 1.26.6 (`agent/go.mod:3`), standard library `net/http`, `crypto/sha256`, `encoding/json`; `github.com/Microsoft/go-winio v0.6.2` (already required, `agent/go.mod:11`) for the Windows named pipe; existing `collectors.Guard`, `observability.Recoverer`, `httputil.Do`.

**Spec:** `docs/superpowers/specs/devices/2026-10-06-workload-host-inventory-design.md` — §5 (agent collector), the agent side of §7.2, and the capability in §5.3.

**Depends on:** W01 (API contract) is merged before the lab gate in Task 9. The unit tasks (1-8) need nothing from the server.

## Global Constraints

Exact values; every task conforms.

- **Wire contract (W01):** `PUT /api/v1/agents/{agentID}/workloads`, body `{ protocolVersion: 1, collectedAt, runtimes: [...] }`. The server rejects unknown keys, so the Go structs emit exactly the contract names and **always emit every key** (nullable fields as pointers that marshal to `null`, `workloads` as `[]` never `null`). `collectedAt` is UTC RFC 3339 with milliseconds and a `Z` suffix (`2026-10-06T12:00:00.123Z`).
- **Send path:** `sendInventoryData("workloads", payload, "workloads")` (`agent/internal/heartbeat/heartbeat.go:2403`), with an endpoint-specific context override next to the existing ones (`heartbeat.go:2417-2425`) so shutdown cancels an in-flight upload.
- **Runtimes registered in this wave:** Linux `docker`, `podman`, `containerd` (detect-only); Windows `docker` (named pipe). macOS and other OS: no drivers, no report. `hyperv` and `proxmox` are accepted in settings but have no driver until W03.
- **Endpoints and liveness sources:** Linux `/var/run/docker.sock`, `/run/podman/podman.sock`, `/run/containerd/containerd.sock`; Windows `\\.\pipe\docker_engine`; liveness sources `/var/run/docker.pid` + `/proc`, `docker` service, `/proc/*/cmdline`.
- **GET-only transport (§5.2):** methods `GET`/`HEAD` only; exact request allowlist `/_ping`, `/version`, `/containers/json?all=1`, `/images/json`; no redirects; no Docker SDK dependency; response caps 1 MiB (`/_ping`, `/version`) and 32 MiB (lists).
- **Timeouts:** 30 s per driver for `Detect` and, separately, for `Collect` (`workloads.DriverTimeout`); 25 s per HTTP request.
- **Detection vs collection:** detection always runs; `Collect` runs only when `Settings.RuntimeEnabled(runtime)`. Master switch off (the in-memory default before the first `configUpdate`) means detection-only reports with `collection: "disabled"`.
- **Never start a stopped daemon (spec §5.1 table).** Connecting to a socket-activated engine starts it, so `Detect` decides presence and liveness without dialing: socket file missing → `absent`; socket present → `present`; connect (`GET /_ping`, `GET /version`) **only if the daemon is already running**. Docker on Linux: `/var/run/docker.pid` names a pid whose `/proc/<pid>/comm` is `dockerd` (a stale or reused pid counts as stopped). Docker on Windows: the `docker` service is `SERVICE_RUNNING` (query opened with `SERVICE_QUERY_STATUS` only; `golang.org/x/sys` is already required at `agent/go.mod:34`; service not installed → `absent`, query failure → treated as stopped). Podman: a `podman system service` process exists (scan `/proc/*/cmdline`). Not running → detection `present` with reason `not_running`, and `Collect` returns `collection: "unavailable"`, `error: "daemon not running"` without dialing. A `docker.sock` that is a symlink to a `podman*` socket is `absent` for the docker driver, decided from the path alone.
- **Caps:** 1000 workloads per runtime, ordered `(state = running) desc, runtimeCreatedAt desc, workloadId asc`; above the cap `complete: false`, `observedCount` = true count. Serialized body capped at `MaxPayloadBytes = 1_750_000` (spec §5.4 byte budget: under 1.75 MB; the route limit is 2 MB); when over, the lowest-priority workloads (the tail of the order above) are dropped from the largest runtime, which is marked `complete: false`. A payload that would be rejected with 413 is never sent.
- **Field allowlist (§5.4):** from `GET /containers/json?all=1` only — id, first name (leading `/` stripped), `State`, `Image` (as listed), `ImageID`, `Created`, and the labels `com.docker.compose.project`, `com.docker.compose.service`, `com.docker.compose.project.working_dir`; from `GET /images/json` only — `Id`, `RepoTags`, `RepoDigests`. Never collected: environment, command, entrypoint, args, mounts, volumes, ports, networks, other labels, `Status`, history, logs, inspect output. `restartPolicy` and `startedAt` are `null` for containers in v1.
- **String bounds (bytes, clipped on a rune boundary agent-side so one value can never fail a whole report):** workloadId 128, name 255, rawState 40, imageRef 512, imageRepository 400, imageTag 128, imageDigest 80, imageId 80, guestOs 128, composeProject 128, composeService 128, composeWorkingDir 512, restartPolicy 30, runtimeVersion 64, error 500.
- **State mapping:** `running`→running, `paused`→paused, `restarting`→restarting, `exited|created|dead|stopped|configured|initialized`→stopped, anything else→other; `rawState` is the engine's own string.
- **Image normalization (pure, table-tested):** `nginx` → `docker.io/library/nginx` + `latest`; `user/app:1` → `docker.io/user/app` + `1`; `ghcr.io/o/r:t` → `ghcr.io/o/r` + `t`; first path component is a registry only if it contains `.` or `:` or equals `localhost`; `repo@sha256:…` → no tag; `repo:tag@sha256:…` → tag kept; a bare image id yields no repository. `imageDigest` is the `RepoDigests` entry whose normalized repository equals the container's normalized repository (digest part only), else `null`.
- **Schedule (§5.3):** own worker, first run 60-120 s after `Start()` (deterministic per agent id), interval from settings 15-1440 min (default 60) with ±10% jitter, send when the canonical hash changed or 6 h elapsed since the last accepted send, retry a failed send after at most 10 min, hash advances only after a 2xx.
- **Settings (§7.2):** heartbeat `configUpdate` key `workload_inventory_settings` (also `workloadInventorySettings`) = `{ enabled, docker_enabled, podman_enabled, hyperv_enabled, proxmox_enabled, interval_minutes }` (snake_case on the wire; the agent also accepts camelCase); `enabled` and a 15-1440 integer interval are required; a missing per-runtime flag defaults to `true`; an invalid payload is ignored entirely. Initial in-memory default `Enabled: false`. The apply call sits above the policy-probe early return in `applyConfigUpdate`.
- **Capability:** `SecurityCapabilities.WorkloadInventoryProtocolVersion int \`json:"workloadInventoryProtocolVersion,omitempty"\`` = `1`, declared unconditionally in `compiledSecurityCapabilities`.
- No new Go module dependency; no API, migration, shared-validator or web change; no change to `agent/internal/collectors/inventory.go:118` (the `docker*` interface skip stays).
- Public repo: neutral wording; fixtures use obviously fake values (`FIXTURE_*`); lab hostnames, addresses and device ids stay in private operator configuration.
- Plan-authoring output is this document only; commands below are implementation instructions, not commands run while authoring.

## Review Focus

Each failure mode below is pinned by a named test in the owning task. Review the test before the code.

1. **A mutating request is refused before any byte is written.** A `POST`/`DELETE`/`PUT`, any non-allowlisted path (`/containers/{id}/start`, `/containers/create`, `/containers/{id}/json`), or an allowlisted path with extra query must fail with `ErrReadOnly` without reaching the inner transport or the dialer. Pinned by Task 3 (`TestReadOnlyTransportRefusesBeforeAnyIO`, `TestReadOnlyClientNeverDialsForRefusedRequests`) and, independently, by the source grep in Task 8.
2. **`env`, `cmd`, `mounts`, ports, networks and non-compose labels present in the engine response never reach the payload.** The decode structs are the allowlist and a reflection test pins their field sets. Pinned by Task 4 (`TestDockerReportNeverContainsSensitiveFixtureValues`, `TestEngineStructsAreTheAllowlist`) and Task 1 (`TestWorkloadEmitsExactlyTheContractKeys`).
3. **A failed send does not advance the hash.** 503 and 400 leave `lastHash` empty and the next cycle sends again; a 2xx advances it and the unchanged report is then not resent. Pinned by Task 7 (`TestWorkloadsFailedSendDoesNotAdvanceHash`, `TestWorkloadsCycleIsChangeOnlyWithKeepalive`).
4. **A settings change during a collection discards the result.** A report built under stale settings is never sent; the cycle re-runs immediately under the new settings. Pinned by Task 7 (`TestWorkloadsSettingsChangeMidCollectionDiscardsResult`).
5. **Socket missing, permission denied and daemon down are three different states.** Missing socket → `absent`; access denied → `present` + `permission_denied`; connection refused or non-200 `/_ping` → `present` + `unavailable`; timeout or surprise → `unknown` (the server keeps the previous membership). Pinned by Task 4 (`TestDockerDetectMapsFailuresToDistinctStates`, `TestDockerDetectHTTPStatusMapping`, `TestDockerCollectReportsDetectionFailuresWithoutRequests`) and Task 6 (`TestCollectorMapsDetectionStates`).
9. **Detection never starts a stopped daemon.** With a stopped dockerd (no pid file, garbage, stale or reused pid) or no `podman system service` process, `Detect` and `Collect` make zero dial calls (the injected dialer fails the test if called) and report `present` + `unavailable` / `daemon not running`; a missing socket is `absent` without dialing; a `docker.sock` linked to Podman's socket is `absent` without dialing. Pinned by Task 4 (`TestDockerNeverConnectsUnlessDaemonIsAlreadyRunning`, `TestDockerSocketMissingIsAbsentWithoutConnecting`, `TestDockerSocketLinkedToPodmanIsAbsentWithoutConnecting`, `TestPodmanNeverConnectsWithoutARunningServiceProcess`, `TestCollectorReportsStoppedDaemonWithoutDialing`).
6. **A failed or truncated collection never looks like an empty host.** Non-`ok` collections carry no workloads; a cap, an images-list failure or a trimmed payload sets `complete: false`; duplicates and oversize values cannot make the server reject the whole report. Pinned by Task 4 (`TestDockerCollectFailureModes`, `TestDockerCapOrdersRunningFirstAndMarksIncomplete`), Task 6 (`TestFailedCollectionNeverCarriesWorkloads`, `TestCollectorBoundsDriverOutput`, `TestFitPayloadKeepsReportUnderTheBodyLimit`) and Task 1 (`TestBoundClipsOnRuneBoundaryAndDropsEmpty`).
7. **Off by default, and reachable.** The default settings enumerate nothing, and the settings key is dispatched even when a heartbeat carries no other config. Pinned by Task 1 (`TestSettingsRuntimeEnabled`), Task 6 (`TestCollectorDetectsAlwaysButCollectsOnlyWhenEnabled`) and Task 7 (`TestApplyConfigUpdateDispatchesWorkloadSettings`, `TestWorkloadsDisabledStateIsStillReported`).
8. **Shutdown drains.** An in-flight upload is cancelled by `stopWorkloads` and the worker goroutine is tracked by `inventoryWg`. Pinned by Task 7 (`TestWorkloadsStopCancelsInFlightUpload`, `TestWorkloadsLoopIsTrackedAndStops`).

## File Structure

Every path is relative to the repository root. Each Go code block below starts with a `// agent/...` comment that only labels the file path; it is not file content (drop it when creating the file). New files have no current line number; modified files cite verified current lines on `main` at plan time.

| Action | File | Responsibility |
|---|---|---|
| Create | `agent/internal/collectors/workloads/types.go` | `Runtime`, `Detection`, `Result`, `Driver`, wire structs `Workload`/`RuntimeReport`/`Report`, `Settings`, bounds. |
| Create | `agent/internal/collectors/workloads/types_test.go` | Golden JSON against the wire contract, exact key set, settings gating, bounds. |
| Create | `agent/internal/collectors/workloads/image.go` | `NormalizeImage`, `PickRepoDigest`, `IsImageID`. |
| Create | `agent/internal/collectors/workloads/image_test.go` | Table tests for every normalization rule. |
| Create | `agent/internal/collectors/workloads/transport.go` | `ReadOnlyTransport`, `newReadOnlyClient`, `DialFunc`, request allowlist. |
| Create | `agent/internal/collectors/workloads/dial_unix.go` | Unix-socket dialer and default endpoints (`//go:build !windows`). |
| Create | `agent/internal/collectors/workloads/dial_windows.go` | Named-pipe dialer via go-winio (`//go:build windows`). |
| Create | `agent/internal/collectors/workloads/transport_test.go` | Refusal-before-I/O, allowlist, dialer never called. |
| Create | `agent/internal/collectors/workloads/docker.go` | Docker-compatible engine driver: detection, list decode (allowlist structs), mapping, ordering, cap. |
| Create | `agent/internal/collectors/workloads/liveness.go`, `liveness_linux.go`, `liveness_windows.go`, `liveness_other.go` | Pre-connect gates: pid-file + `/proc` check for dockerd, `/proc/*/cmdline` scan for `podman system service`, read-only Windows service query; `liveness` enum. |
| Create | `agent/internal/collectors/workloads/liveness_test.go` | Fake pid file / fake proc dir tests with a dialer that fails the test if called. |
| Create | `agent/internal/collectors/workloads/docker_test.go` | Fixture-driven driver tests; failure-mode mapping; allowlist; Podman/Docker flavor split. |
| Create | `agent/internal/collectors/workloads/testdata/docker_containers.json`, `docker_images.json`, `docker_version.json`, `podman_version.json` | Fixtures: compose labels, bare, local build, digest-pinned, id-referenced, multi-arch repo digests, and fake env/cmd/mounts/label secrets. |
| Create | `agent/internal/collectors/workloads/drivers.go` | `newDockerDriver`, `newPodmanDriver`, detect-only `containerdDriver`. |
| Create | `agent/internal/collectors/workloads/drivers_linux.go`, `drivers_windows.go`, `drivers_other.go` | Per-OS `DefaultDrivers()` registration. |
| Create | `agent/internal/collectors/workloads/drivers_test.go`, `drivers_linux_test.go` | containerd detection, registration set. |
| Create | `agent/internal/collectors/workloads/collector.go` | `Collector`, panic guard, per-driver timeout, payload fit, canonical `Hash`. |
| Create | `agent/internal/collectors/workloads/collector_test.go` | Detect/collect gating, failure mapping, bounds, hash stability. |
| Create | `agent/internal/collectors/workloads/readonly_guard_test.go` | Source-level guard for mutating verbs/paths and unexpected `os/exec`. |
| Create | `agent/internal/heartbeat/workloads.go` | Settings parse/apply, self-timed worker loop, change-only send. |
| Create | `agent/internal/heartbeat/workloads_test.go` | Scheduling, send rules, discard, shutdown, capability. |
| Modify | `agent/internal/heartbeat/heartbeat.go:31` | Import `collectors/workloads`. |
| Modify | `agent/internal/heartbeat/heartbeat.go:280-281` | `WorkloadInventoryProtocolVersion` field on `SecurityCapabilities` (struct spans `:234-282`). |
| Modify | `agent/internal/heartbeat/heartbeat.go:473` | `workloads *workloadsRuntime` field next to `timeSync`. |
| Modify | `agent/internal/heartbeat/heartbeat.go:1059` | `h.initWorkloads()` after `h.initTimeSync()` in `NewWithVersion`. |
| Modify | `agent/internal/heartbeat/heartbeat.go:1917` | `h.startWorkloads()` after `h.startTimeSync()` in `Start()` (`:1915`). |
| Modify | `agent/internal/heartbeat/heartbeat.go:2228,2250` | `h.stopWorkloads()` in `DrainAndWait` and `Stop`. |
| Modify | `agent/internal/heartbeat/heartbeat.go:2420-2424` | Upload-context override for endpoint `workloads`. |
| Modify | `agent/internal/heartbeat/heartbeat.go:3288-3290` | Dispatch `workload_inventory_settings` above the policy-probe return (`:3292`). |
| Modify | `agent/internal/heartbeat/heartbeat.go:8000` | `WorkloadInventoryProtocolVersion: workloads.ProtocolVersion` in `compiledSecurityCapabilities` (`:7991`). |
| Unchanged | `agent/internal/collectors/inventory.go:118` | The `docker*` interface skip stays as is. |

Template audit: `agent/internal/collectors/hwhealth/source.go:18-23` (interface), `sources_linux.go`/`sources_other.go` (build-tag registration via `remainingSources`), `runner.go:40` (`runTool`), `collector.go:45,112` (`New`, `Run`) and `agent/internal/heartbeat/hardware_health.go:18,72,179,192` were read. This wave mirrors the package/driver split and the settings-apply semantics. It deliberately does **not** copy `runTool`: Docker and Podman collection uses no subprocess, and `readonly_guard_test.go` pins that (a runner copy arrives with the Hyper-V/Proxmox drivers in W03, which also adds its file to `execAllowedFiles`). The worker follows `agent/internal/heartbeat/time_sync.go:155-` (own timer and wake channel, tracked by `inventoryWg`) rather than `hardwareTiersLocked`, whose later ticks ride the main heartbeat loop (`heartbeat.go:2124`).

---

### Task 1: Package types, Driver interface, wire structs and golden JSON test

**Files:**
- Create: `agent/internal/collectors/workloads/types_test.go`
- Create: `agent/internal/collectors/workloads/types.go`

**Interfaces (produced):**

```go
type Runtime string // RuntimeDocker, RuntimePodman, RuntimeHyperV, RuntimeProxmox, RuntimeContainerd
type Detection struct{ State, Version, Reason string }
type Result struct {
	Collection    string
	Complete      bool
	Workloads     []Workload
	ObservedCount int
	Error         string
}
type Driver interface {
	Runtime() Runtime
	Detect(ctx context.Context) Detection
	Collect(ctx context.Context, d Detection) Result
}
type Workload struct{ /* 19 wire fields, pointers for nullable */ }
type RuntimeReport struct{ /* 8 wire fields */ }
type Report struct {
	ProtocolVersion int
	CollectedAt     string
	Runtimes        []RuntimeReport
}
type Settings struct {
	Enabled, Docker, Podman, HyperV, Proxmox bool
	IntervalMinutes                          int
}
func (s Settings) RuntimeEnabled(r Runtime) bool
func DefaultSettings() Settings
func (w *Workload) Bound()
```

- [ ] **Step 1: Write the failing test.** It pins the wire contract as literal JSON, so a renamed or extra key fails here before it can fail against the server.

```go
// agent/internal/collectors/workloads/types_test.go
package workloads

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func ptr[T any](v T) *T { return &v }

// The server rejects unknown keys, so these golden strings are the wire
// contract. Update them only together with the API's workloadsReportSchema.
const goldenMinimal = `{"protocolVersion":1,"collectedAt":"2026-10-06T12:00:00Z","runtimes":[{"runtime":"docker","detection":"absent","collection":"unavailable","complete":true,"runtimeVersion":null,"observedCount":0,"error":null,"workloads":[]}]}`

const goldenFull = `{"protocolVersion":1,"collectedAt":"2026-10-06T12:00:00Z","runtimes":[{"runtime":"docker","detection":"present","collection":"ok","complete":true,"runtimeVersion":"27.1.1","observedCount":1,"error":null,"workloads":[{"workloadId":"abc","kind":"container","name":"web","state":"running","rawState":"running","imageRef":"nginx:1.27","imageRepository":"docker.io/library/nginx","imageTag":"1.27","imageDigest":"sha256:d1","imageId":"sha256:a0","guestOs":null,"composeProject":"shop","composeService":"web","composeWorkingDir":"/srv/shop","restartPolicy":null,"cpuCount":null,"memoryMb":null,"startedAt":null,"runtimeCreatedAt":"2026-10-01T08:30:00Z"}]}]}`

func TestReportGoldenMinimal(t *testing.T) {
	r := Report{ProtocolVersion: 1, CollectedAt: "2026-10-06T12:00:00Z", Runtimes: []RuntimeReport{{
		Runtime: RuntimeDocker, Detection: DetectionAbsent, Collection: CollectionUnavailable,
		Complete: true, Workloads: []Workload{},
	}}}
	got, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != goldenMinimal {
		t.Fatalf("wire mismatch\n got: %s\nwant: %s", got, goldenMinimal)
	}
}

func TestReportGoldenFull(t *testing.T) {
	w := Workload{
		WorkloadID: "abc", Kind: KindContainer, Name: "web", State: StateRunning,
		RawState: ptr("running"), ImageRef: ptr("nginx:1.27"),
		ImageRepository: ptr("docker.io/library/nginx"), ImageTag: ptr("1.27"),
		ImageDigest: ptr("sha256:d1"), ImageID: ptr("sha256:a0"),
		ComposeProject: ptr("shop"), ComposeService: ptr("web"), ComposeWorkingDir: ptr("/srv/shop"),
		RuntimeCreatedAt: ptr("2026-10-01T08:30:00Z"),
	}
	r := Report{ProtocolVersion: 1, CollectedAt: "2026-10-06T12:00:00Z", Runtimes: []RuntimeReport{{
		Runtime: RuntimeDocker, Detection: DetectionPresent, Collection: CollectionOK,
		Complete: true, RuntimeVersion: ptr("27.1.1"), ObservedCount: 1, Workloads: []Workload{w},
	}}}
	got, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != goldenFull {
		t.Fatalf("wire mismatch\n got: %s\nwant: %s", got, goldenFull)
	}
}

// Every wire key is always present: a missing key is not the same as null to a
// strict nullable zod field, and an extra key is a 400 for the whole report.
func TestWorkloadEmitsExactlyTheContractKeys(t *testing.T) {
	want := []string{"workloadId", "kind", "name", "state", "rawState", "imageRef", "imageRepository",
		"imageTag", "imageDigest", "imageId", "guestOs", "composeProject", "composeService",
		"composeWorkingDir", "restartPolicy", "cpuCount", "memoryMb", "startedAt", "runtimeCreatedAt"}
	raw, _ := json.Marshal(Workload{})
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	var got []string
	for k := range m {
		got = append(got, k)
	}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
}

func TestSettingsRuntimeEnabled(t *testing.T) {
	s := DefaultSettings()
	if s.RuntimeEnabled(RuntimeDocker) {
		t.Fatal("default settings must not enumerate anything")
	}
	s.Enabled = true
	if !s.RuntimeEnabled(RuntimeDocker) || !s.RuntimeEnabled(RuntimePodman) {
		t.Fatal("enabled settings should enumerate docker and podman")
	}
	s.Podman = false
	if s.RuntimeEnabled(RuntimePodman) {
		t.Fatal("podman switch ignored")
	}
	if !s.RuntimeEnabled(RuntimeContainerd) {
		t.Fatal("containerd follows the master switch")
	}
	s.Enabled = false
	if s.RuntimeEnabled(RuntimeContainerd) {
		t.Fatal("master switch off must disable every runtime")
	}
}

func TestBoundClipsOnRuneBoundaryAndDropsEmpty(t *testing.T) {
	long := strings.Repeat("é", 400) // 800 bytes
	w := Workload{WorkloadID: strings.Repeat("a", 300), Name: long, ImageRef: ptr(long), RawState: ptr("")}
	w.Bound()
	if len(w.WorkloadID) != 128 {
		t.Fatalf("workloadId len = %d", len(w.WorkloadID))
	}
	if len(w.Name) > 255 || !strings.HasSuffix(w.Name, "é") {
		t.Fatalf("name not clipped on a rune boundary: len=%d", len(w.Name))
	}
	if w.ImageRef == nil || len(*w.ImageRef) > 512 {
		t.Fatal("imageRef not bounded")
	}
	if w.RawState != nil {
		t.Fatal("empty string must become null")
	}
}
```

- [ ] **Step 2: Run it and watch it fail to compile.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestReport|TestWorkloadEmits|TestSettings|TestBound'
```

Expected: FAIL, build error `undefined: Report` / `undefined: Workload` / `undefined: DefaultSettings`.

- [ ] **Step 3: Implement the types.**

```go
// agent/internal/collectors/workloads/types.go
// Package workloads inventories what a host runs: containers today, virtual
// machines in later drivers. Collection is read-only by construction (see
// transport.go) and reports only the fields listed in the field allowlist.
package workloads

import (
	"context"
	"unicode/utf8"
)

// ProtocolVersion is the wire protocol this build speaks. It is also declared
// as SecurityCapabilities.WorkloadInventoryProtocolVersion on every heartbeat.
const ProtocolVersion = 1

// Runtime names a workload runtime. The strings are wire values.
type Runtime string

const (
	RuntimeDocker     Runtime = "docker"
	RuntimePodman     Runtime = "podman"
	RuntimeHyperV     Runtime = "hyperv"
	RuntimeProxmox    Runtime = "proxmox"
	RuntimeContainerd Runtime = "containerd"
)

// Detection states (wire values).
const (
	DetectionPresent = "present"
	DetectionAbsent  = "absent"
	DetectionUnknown = "unknown"
)

// Collection states (wire values).
const (
	CollectionOK               = "ok"
	CollectionDisabled         = "disabled"
	CollectionUnavailable      = "unavailable"
	CollectionPermissionDenied = "permission_denied"
	CollectionError            = "error"
	CollectionUnsupported      = "unsupported"
)

// Detection.Reason codes. A present runtime that cannot be enumerated right
// now carries ReasonPermissionDenied or ReasonUnavailable so Collect can report
// the right collection state without a second round trip.
const (
	ReasonPermissionDenied = "permission_denied"
	ReasonUnavailable      = "unavailable"
	ReasonNotRunning       = "not_running"
	ReasonTimeout          = "timeout"
	ReasonUnreachable      = "unreachable"
	ReasonPanic            = "panic"
)

// Workload kinds and states (wire values).
const (
	KindContainer = "container"
	KindVM        = "vm"
	KindLXC       = "lxc"

	StateRunning    = "running"
	StateStopped    = "stopped"
	StatePaused     = "paused"
	StateRestarting = "restarting"
	StateOther      = "other"
)

const (
	// MaxWorkloadsPerRuntime is the per-runtime cap on reported workloads.
	MaxWorkloadsPerRuntime = 1000
	// MaxErrorLen bounds the error string on the wire.
	MaxErrorLen = 500
	// MaxPayloadBytes keeps the serialized report below 1.75 MB; the API body limit is 2 MB.
	MaxPayloadBytes = 1_750_000
)

// Detection is the cheap, always-run answer to "does this host run runtime X".
// It never lists workloads.
type Detection struct {
	State   string // DetectionPresent | DetectionAbsent | DetectionUnknown
	Version string
	Reason  string // machine code, see the Reason* constants; empty when none
}

// Result is what a driver returns from Collect.
type Result struct {
	Collection    string // one of the Collection* values except CollectionDisabled
	Complete      bool
	Workloads     []Workload
	ObservedCount int
	Error         string // short machine code, never raw runtime output
}

// Driver is one workload runtime. Implementations must be read-only.
type Driver interface {
	Runtime() Runtime
	Detect(ctx context.Context) Detection
	Collect(ctx context.Context, d Detection) Result
}

// Workload is one container, VM or LXC guest, using exactly the wire field
// names. Every nullable field is a pointer and is always emitted (null when
// unknown); the server rejects unknown keys, so this struct is the allowlist.
type Workload struct {
	WorkloadID        string  `json:"workloadId"`
	Kind              string  `json:"kind"`
	Name              string  `json:"name"`
	State             string  `json:"state"`
	RawState          *string `json:"rawState"`
	ImageRef          *string `json:"imageRef"`
	ImageRepository   *string `json:"imageRepository"`
	ImageTag          *string `json:"imageTag"`
	ImageDigest       *string `json:"imageDigest"`
	ImageID           *string `json:"imageId"`
	GuestOS           *string `json:"guestOs"`
	ComposeProject    *string `json:"composeProject"`
	ComposeService    *string `json:"composeService"`
	ComposeWorkingDir *string `json:"composeWorkingDir"`
	RestartPolicy     *string `json:"restartPolicy"`
	CPUCount          *int    `json:"cpuCount"`
	MemoryMB          *int    `json:"memoryMb"`
	StartedAt         *string `json:"startedAt"`
	RuntimeCreatedAt  *string `json:"runtimeCreatedAt"`
}

// RuntimeReport is one entry of Report.Runtimes.
type RuntimeReport struct {
	Runtime        Runtime    `json:"runtime"`
	Detection      string     `json:"detection"`
	Collection     string     `json:"collection"`
	Complete       bool       `json:"complete"`
	RuntimeVersion *string    `json:"runtimeVersion"`
	ObservedCount  int        `json:"observedCount"`
	Error          *string    `json:"error"`
	Workloads      []Workload `json:"workloads"`
}

// Report is the body of PUT /api/v1/agents/{agentID}/workloads.
type Report struct {
	ProtocolVersion int             `json:"protocolVersion"`
	CollectedAt     string          `json:"collectedAt"`
	Runtimes        []RuntimeReport `json:"runtimes"`
}

// Settings is the agent's view of workload_inventory_settings.
type Settings struct {
	Enabled         bool
	Docker          bool
	Podman          bool
	HyperV          bool
	Proxmox         bool
	IntervalMinutes int
}

// RuntimeEnabled reports whether the driver for r may run Collect. containerd
// has no per-runtime switch; it follows the master switch and its driver
// answers "unsupported" in v1.
func (s Settings) RuntimeEnabled(r Runtime) bool {
	if !s.Enabled {
		return false
	}
	switch r {
	case RuntimeDocker:
		return s.Docker
	case RuntimePodman:
		return s.Podman
	case RuntimeHyperV:
		return s.HyperV
	case RuntimeProxmox:
		return s.Proxmox
	case RuntimeContainerd:
		return true
	}
	return false
}

// DefaultSettings is the in-memory state before the first configUpdate:
// detection runs, enumeration is off.
func DefaultSettings() Settings {
	return Settings{Docker: true, Podman: true, HyperV: true, Proxmox: true, IntervalMinutes: 60}
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// clip truncates s to at most max bytes on a rune boundary. Bytes are at least
// as many as characters or UTF-16 units, so a clipped value satisfies any
// server-side length bound of the same number.
func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func clipPtr(p *string, max int) *string {
	if p == nil {
		return nil
	}
	return strp(clip(*p, max))
}

// Bound enforces the column bounds from the ingest contract so one oversized
// label can never make the server reject a whole report.
func (w *Workload) Bound() {
	w.WorkloadID = clip(w.WorkloadID, 128)
	w.Name = clip(w.Name, 255)
	w.RawState = clipPtr(w.RawState, 40)
	w.ImageRef = clipPtr(w.ImageRef, 512)
	w.ImageRepository = clipPtr(w.ImageRepository, 400)
	w.ImageTag = clipPtr(w.ImageTag, 128)
	w.ImageDigest = clipPtr(w.ImageDigest, 80)
	w.ImageID = clipPtr(w.ImageID, 80)
	w.GuestOS = clipPtr(w.GuestOS, 128)
	w.ComposeProject = clipPtr(w.ComposeProject, 128)
	w.ComposeService = clipPtr(w.ComposeService, 128)
	w.ComposeWorkingDir = clipPtr(w.ComposeWorkingDir, 512)
	w.RestartPolicy = clipPtr(w.RestartPolicy, 30)
}
```

- [ ] **Step 4: Run the tests.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestReport|TestWorkloadEmits|TestSettings|TestBound'
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit.**

```bash
git add agent/internal/collectors/workloads/types.go agent/internal/collectors/workloads/types_test.go
git commit -m "feat(agent): workload inventory types and wire contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Image reference normalization

**Files:**
- Create: `agent/internal/collectors/workloads/image_test.go`
- Create: `agent/internal/collectors/workloads/image.go`

**Interfaces (produced):**

```go
type ImageRef struct {
	Repository string // "registry/path", registry always explicit; "" for an image id
	Tag        string // "" when digest-pinned without a tag
	Digest     string // "sha256:..." of a pinned reference, else ""
	Pinned     bool
}
func NormalizeImage(ref string) ImageRef
func PickRepoDigest(repository string, repoDigests []string) string
func IsImageID(ref string) bool
```

- [ ] **Step 1: Write the failing table tests** (every rule in Global Constraints, plus Docker Hub host aliases, a lowercase-host rule, malformed digests, duplicate-digest determinism and the multi-arch two-repository case).

```go
// agent/internal/collectors/workloads/image_test.go
package workloads

import (
	"strings"
	"testing"
)

var (
	testDigestA = "sha256:" + strings.Repeat("a", 64)
	testDigestB = "sha256:" + strings.Repeat("b", 64)
)

func TestNormalizeImage(t *testing.T) {
	cases := []struct {
		in   string
		want ImageRef
	}{
		{"nginx", ImageRef{Repository: "docker.io/library/nginx", Tag: "latest"}},
		{"nginx:1.27", ImageRef{Repository: "docker.io/library/nginx", Tag: "1.27"}},
		{"user/app:1", ImageRef{Repository: "docker.io/user/app", Tag: "1"}},
		{"ghcr.io/o/r:t", ImageRef{Repository: "ghcr.io/o/r", Tag: "t"}},
		{"ghcr.io/o/r", ImageRef{Repository: "ghcr.io/o/r", Tag: "latest"}},
		{"localhost:5000/x", ImageRef{Repository: "localhost:5000/x", Tag: "latest"}},
		{"localhost/x:2", ImageRef{Repository: "localhost/x", Tag: "2"}},
		{"registry.example.com:5443/team/app:5", ImageRef{Repository: "registry.example.com:5443/team/app", Tag: "5"}},
		{"Registry.Example.COM/Team/app:v1", ImageRef{Repository: "registry.example.com/Team/app", Tag: "v1"}},
		{"docker.io/library/nginx:1", ImageRef{Repository: "docker.io/library/nginx", Tag: "1"}},
		{"docker.io/nginx", ImageRef{Repository: "docker.io/library/nginx", Tag: "latest"}},
		{"index.docker.io/user/app:3", ImageRef{Repository: "docker.io/user/app", Tag: "3"}},
		{"repo@" + testDigestA, ImageRef{Repository: "docker.io/library/repo", Digest: testDigestA, Pinned: true}},
		{"repo:tag@" + testDigestA, ImageRef{Repository: "docker.io/library/repo", Tag: "tag", Digest: testDigestA, Pinned: true}},
		{"ghcr.io/o/r@" + testDigestB, ImageRef{Repository: "ghcr.io/o/r", Digest: testDigestB, Pinned: true}},
		{"", ImageRef{}},
		{"sha256:" + strings.Repeat("c", 64), ImageRef{}},
		{strings.Repeat("c", 12), ImageRef{}},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := NormalizeImage(tc.in); got != tc.want {
				t.Fatalf("NormalizeImage(%q) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

func TestPickRepoDigest(t *testing.T) {
	multi := []string{
		"nginx@" + testDigestA,
		"registry.example.com/mirror/nginx@" + testDigestB,
	}
	cases := []struct {
		name, repo string
		digests    []string
		want       string
	}{
		{"hub repo", "docker.io/library/nginx", multi, testDigestA},
		{"mirror repo", "registry.example.com/mirror/nginx", multi, testDigestB},
		{"no match is a local build", "docker.io/library/myapp", multi, ""},
		{"empty list", "docker.io/library/nginx", nil, ""},
		{"empty repository", "", multi, ""},
		{"malformed digest skipped", "docker.io/library/nginx", []string{"nginx@sha256:short"}, ""},
		{"entry without digest skipped", "docker.io/library/nginx", []string{"nginx"}, ""},
		{"duplicates resolve deterministically", "docker.io/library/nginx",
			[]string{"nginx@" + testDigestB, "docker.io/library/nginx@" + testDigestA}, testDigestA},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PickRepoDigest(tc.repo, tc.digests); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run and watch it fail.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestNormalizeImage|TestPickRepoDigest'
```

Expected: FAIL, build error `undefined: NormalizeImage`.

- [ ] **Step 3: Implement.**

```go
// agent/internal/collectors/workloads/image.go
package workloads

import (
	"regexp"
	"sort"
	"strings"
)

// ImageRef is a container image reference split into the parts the API stores.
type ImageRef struct {
	// Repository is "registry/path" with the registry always spelled out
	// ("docker.io/library/nginx"). Empty when the reference names no repository
	// (an image id).
	Repository string
	// Tag is empty when the reference is digest-pinned without a tag, or empty.
	Tag string
	// Digest is the "sha256:..." part of a pinned reference; empty otherwise.
	Digest string
	// Pinned is true when the reference carries a digest.
	Pinned bool
}

var (
	imageIDPattern = regexp.MustCompile(`^(sha256:)?[0-9a-f]{12,64}$`)
	digestPattern  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

// IsImageID reports whether ref is a bare image id rather than a name.
func IsImageID(ref string) bool { return imageIDPattern.MatchString(ref) }

// NormalizeImage splits ref the way the container engines resolve it.
//
//	nginx                -> docker.io/library/nginx : latest
//	user/app:1           -> docker.io/user/app : 1
//	ghcr.io/o/r:t        -> ghcr.io/o/r : t
//	localhost:5000/x     -> localhost:5000/x : latest
//	repo@sha256:...      -> docker.io/library/repo, no tag, pinned
//	repo:tag@sha256:...  -> docker.io/library/repo : tag, pinned
func NormalizeImage(ref string) ImageRef {
	ref = strings.TrimSpace(ref)
	if ref == "" || IsImageID(ref) {
		return ImageRef{}
	}
	name, digest := ref, ""
	if i := strings.Index(name, "@"); i >= 0 {
		name, digest = name[:i], name[i+1:]
	}
	tag := ""
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		name, tag = name[:i], name[i+1:]
	}
	if name == "" {
		return ImageRef{}
	}
	registry, path := splitRegistry(name)
	if path == "" {
		return ImageRef{}
	}
	if registry == "docker.io" && !strings.Contains(path, "/") {
		path = "library/" + path
	}
	if tag == "" && digest == "" {
		tag = "latest"
	}
	return ImageRef{Repository: registry + "/" + path, Tag: tag, Digest: digest, Pinned: digest != ""}
}

// splitRegistry treats the first path component as a registry host when it
// contains a dot or a colon, or is "localhost"; otherwise the image lives on
// Docker Hub.
func splitRegistry(name string) (registry, path string) {
	i := strings.Index(name, "/")
	if i < 0 {
		return "docker.io", name
	}
	first := name[:i]
	if strings.ContainsAny(first, ".:") || first == "localhost" {
		host := strings.ToLower(first)
		switch host {
		case "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com":
			host = "docker.io"
		}
		return host, name[i+1:]
	}
	return "docker.io", name
}

// PickRepoDigest returns the digest part of the RepoDigests entry whose
// repository equals the normalized repository, or "" when none does (a locally
// built or loaded image). Entries look like "name@sha256:<hex>". When several
// match (the same repository pulled by different manifests) the smallest digest
// is returned so repeated collections agree.
func PickRepoDigest(repository string, repoDigests []string) string {
	if repository == "" {
		return ""
	}
	var matches []string
	for _, entry := range repoDigests {
		i := strings.Index(entry, "@")
		if i < 0 {
			continue
		}
		digest := entry[i+1:]
		if !digestPattern.MatchString(digest) {
			continue
		}
		if NormalizeImage(entry[:i]).Repository == repository {
			matches = append(matches, digest)
		}
	}
	if len(matches) == 0 {
		return ""
	}
	sort.Strings(matches)
	return matches[0]
}
```

- [ ] **Step 4: Run.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestNormalizeImage|TestPickRepoDigest'
```

Expected: PASS (18 normalization cases, 8 digest cases).

- [ ] **Step 5: Commit.**

```bash
git add agent/internal/collectors/workloads/image.go agent/internal/collectors/workloads/image_test.go
git commit -m "feat(agent): container image reference normalization

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: GET-only transport and unix-socket / named-pipe dialers

**Files:**
- Create: `agent/internal/collectors/workloads/transport_test.go`
- Create: `agent/internal/collectors/workloads/transport.go`
- Create: `agent/internal/collectors/workloads/dial_unix.go`
- Create: `agent/internal/collectors/workloads/dial_windows.go`

**Interfaces (produced):**

```go
var ErrReadOnly error
type DialFunc func(ctx context.Context) (net.Conn, error)
type ReadOnlyTransport struct{ Inner http.RoundTripper }
func (t ReadOnlyTransport) RoundTrip(req *http.Request) (*http.Response, error)
func newReadOnlyClient(dial DialFunc, timeout time.Duration) *http.Client
func endpointDialer(path string) DialFunc // per OS: unix socket / go-winio DialPipeContext
const defaultDockerEndpoint, defaultPodmanEndpoint, defaultContainerdEndpoint string // per OS
```

- [ ] **Step 1: Write the failing test.** The central assertion: for every refused request the inner transport's call count and the dialer's call count are both zero.

```go
// agent/internal/collectors/workloads/transport_test.go
package workloads

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type countingRoundTripper struct{ calls atomic.Int32 }

func (c *countingRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	c.calls.Add(1)
	return &http.Response{StatusCode: 200, Body: http.NoBody}, nil
}

func TestReadOnlyTransportRefusesBeforeAnyIO(t *testing.T) {
	cases := []struct{ method, url string }{
		{"POST", "http://engine/containers/create"},
		{"POST", "http://engine/containers/abc/start"},
		{"POST", "http://engine/containers/abc/stop"},
		{"DELETE", "http://engine/containers/abc"},
		{"PUT", "http://engine/containers/abc/archive"},
		{"PATCH", "http://engine/containers/json"},
		{"POST", "http://engine/containers/json?all=1"},
		{"POST", "http://engine/images/create?fromImage=nginx"},
		{"GET", "http://engine/containers/abc/json"},
		{"GET", "http://engine/containers/abc/logs"},
		{"GET", "http://engine/containers/json?all=1&filters=%7B%7D"},
		{"GET", "http://engine/containers/json?all=0"},
		{"GET", "http://engine/containers/json"},
		{"GET", "http://engine/images/json?all=1"},
		{"GET", "http://engine/v1.43/containers/json?all=1"},
		{"GET", "http://engine/system/df"},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.url, func(t *testing.T) {
			inner := &countingRoundTripper{}
			var body io.Reader
			if tc.method != "GET" {
				body = strings.NewReader("{}")
			}
			req, err := http.NewRequest(tc.method, tc.url, body)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := ReadOnlyTransport{Inner: inner}.RoundTrip(req)
			if !errors.Is(err, ErrReadOnly) {
				t.Fatalf("err = %v, want ErrReadOnly", err)
			}
			if resp != nil {
				t.Fatal("refused request produced a response")
			}
			if inner.calls.Load() != 0 {
				t.Fatal("inner transport was reached")
			}
		})
	}
}

func TestReadOnlyTransportAllowsTheAllowlist(t *testing.T) {
	for _, u := range []string{
		"http://engine/_ping",
		"http://engine/version",
		"http://engine/containers/json?all=1",
		"http://engine/images/json",
	} {
		inner := &countingRoundTripper{}
		req, _ := http.NewRequest("GET", u, nil)
		if _, err := (ReadOnlyTransport{Inner: inner}).RoundTrip(req); err != nil {
			t.Fatalf("%s refused: %v", u, err)
		}
		if inner.calls.Load() != 1 {
			t.Fatalf("%s did not reach inner", u)
		}
	}
}

// A refused request must not even open the socket: the dialer is never called.
func TestReadOnlyClientNeverDialsForRefusedRequests(t *testing.T) {
	var dials atomic.Int32
	client := newReadOnlyClient(func(context.Context) (net.Conn, error) {
		dials.Add(1)
		return nil, errors.New("must not dial")
	}, time.Second)
	for _, method := range []string{"POST", "DELETE", "PUT"} {
		req, _ := http.NewRequest(method, "http://engine/containers/abc/start", strings.NewReader("{}"))
		if _, err := client.Do(req); !errors.Is(err, ErrReadOnly) {
			t.Fatalf("%s: err = %v, want ErrReadOnly", method, err)
		}
	}
	if dials.Load() != 0 {
		t.Fatalf("dialer called %d times for refused requests", dials.Load())
	}
}

func TestReadOnlyClientGetOverCustomDialer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/_ping" {
			_, _ = w.Write([]byte("OK"))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	var dials atomic.Int32
	client := newReadOnlyClient(func(ctx context.Context) (net.Conn, error) {
		dials.Add(1)
		var d net.Dialer
		return d.DialContext(ctx, "tcp", srv.Listener.Addr().String())
	}, 2*time.Second)
	resp, err := client.Get("http://engine/_ping")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "OK" || dials.Load() != 1 {
		t.Fatalf("body=%q dials=%d", body, dials.Load())
	}
}
```

- [ ] **Step 2: Run and watch it fail.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestReadOnly'
```

Expected: FAIL, build error `undefined: ReadOnlyTransport` / `undefined: newReadOnlyClient` / `undefined: ErrReadOnly`.

- [ ] **Step 3: Implement the transport and both dialers.**

```go
// agent/internal/collectors/workloads/transport.go
package workloads

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// ErrReadOnly is returned for any request the read-only transport refuses.
var ErrReadOnly = errors.New("workloads: request refused by read-only transport")

// DialFunc opens one connection to a runtime's local API endpoint (a unix
// socket or a Windows named pipe).
type DialFunc func(ctx context.Context) (net.Conn, error)

// allowedRequests is the complete set of (path, raw query) pairs the Docker
// driver may issue. Anything else, including every mutating Docker API path,
// is refused before a connection is dialed.
var allowedRequests = map[string]map[string]bool{
	"/_ping":           {"": true},
	"/version":         {"": true},
	"/containers/json": {"all=1": true},
	"/images/json":     {"": true},
}

// ReadOnlyTransport wraps a RoundTripper and refuses everything except GET or
// HEAD on an allowlisted path and query. The agent runs as root/SYSTEM and the
// engine socket is root-equivalent, so "collection cannot change anything" is a
// property of this type, not a convention of its callers.
type ReadOnlyTransport struct {
	Inner http.RoundTripper
}

func (t ReadOnlyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body != nil {
		_ = req.Body.Close()
	}
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		return nil, fmt.Errorf("%w: method %s", ErrReadOnly, req.Method)
	}
	queries, ok := allowedRequests[req.URL.Path]
	if !ok {
		return nil, fmt.Errorf("%w: path %s", ErrReadOnly, req.URL.Path)
	}
	if !queries[req.URL.RawQuery] {
		return nil, fmt.Errorf("%w: query on %s", ErrReadOnly, req.URL.Path)
	}
	return t.Inner.RoundTrip(req)
}

// newReadOnlyClient builds an HTTP client that talks to one endpoint through
// dial. The URL host is ignored; keep-alives are off so no connection outlives
// a collection.
func newReadOnlyClient(dial DialFunc, timeout time.Duration) *http.Client {
	inner := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dial(ctx)
		},
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: timeout,
	}
	return &http.Client{
		Transport: ReadOnlyTransport{Inner: inner},
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
```

```go
// agent/internal/collectors/workloads/dial_unix.go
//go:build !windows

package workloads

import (
	"context"
	"net"
)

const (
	defaultDockerEndpoint     = "/var/run/docker.sock"
	defaultPodmanEndpoint     = "/run/podman/podman.sock"
	defaultContainerdEndpoint = "/run/containerd/containerd.sock"
)

// socketPathFor returns the endpoint when it is a filesystem socket Detect can
// stat before connecting.
func socketPathFor(endpoint string) string { return endpoint }

// endpointDialer dials a unix socket.
func endpointDialer(path string) DialFunc {
	return func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}
}
```

```go
// agent/internal/collectors/workloads/dial_windows.go
//go:build windows

package workloads

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

const (
	defaultDockerEndpoint     = `\\.\pipe\docker_engine`
	defaultPodmanEndpoint     = ""
	defaultContainerdEndpoint = ""
)

// socketPathFor returns "": a named pipe is not statted (opening it is a
// connection); the service-state check in liveness_windows.go decides instead.
func socketPathFor(string) string { return "" }

// endpointDialer dials a named pipe. winio.DialPipeContext opens it with
// read/write access, which the Docker engine pipe requires; the transport
// still only ever sends GET requests over it.
func endpointDialer(path string) DialFunc {
	return func(ctx context.Context) (net.Conn, error) {
		return winio.DialPipeContext(ctx, path)
	}
}
```

- [ ] **Step 4: Run, then prove the Windows file compiles.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestReadOnly'
cd agent && GOOS=windows GOARCH=amd64 go vet ./internal/collectors/workloads/
```

Expected: PASS (16 refused-request subtests, allowlist, dialer-never-called, GET over a custom dialer); `go vet` for Windows prints nothing.

- [ ] **Step 5: Commit.**

```bash
git add agent/internal/collectors/workloads/transport.go agent/internal/collectors/workloads/transport_test.go agent/internal/collectors/workloads/dial_unix.go agent/internal/collectors/workloads/dial_windows.go
git commit -m "feat(agent): read-only transport for container engine sockets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Docker-compatible engine driver (Detect, Collect, allowlist mapping, cap)

**Files:**
- Create: `agent/internal/collectors/workloads/testdata/docker_containers.json`
- Create: `agent/internal/collectors/workloads/testdata/docker_images.json`
- Create: `agent/internal/collectors/workloads/testdata/docker_version.json`
- Create: `agent/internal/collectors/workloads/testdata/podman_version.json`
- Create: `agent/internal/collectors/workloads/docker_test.go`
- Create: `agent/internal/collectors/workloads/liveness_test.go`
- Create: `agent/internal/collectors/workloads/docker.go`
- Create: `agent/internal/collectors/workloads/liveness.go`
- Create: `agent/internal/collectors/workloads/liveness_linux.go`
- Create: `agent/internal/collectors/workloads/liveness_windows.go`
- Create: `agent/internal/collectors/workloads/liveness_other.go`

**Interfaces (produced):**

```go
type engineDriver struct { /* runtime, client, socketPath, liveness, stat, resolve */ }
type engineOption func(*engineDriver)
func withSocketPath(p string) engineOption
func withLiveness(f func(context.Context) liveness) engineOption
func newEngineDriver(rt Runtime, dial DialFunc, opts ...engineOption) *engineDriver // nil dial => runtime has no endpoint here
func (d *engineDriver) preflight(ctx context.Context) (Detection, bool)            // decisions that need no connection
type liveness int // livenessRunning | livenessStopped | livenessAbsent
func pidFileLiveness(pidFile, procDir, comm string) func(context.Context) liveness
func podmanServiceLiveness(procDir string) func(context.Context) liveness
func isPodmanService(args []string) bool
type serviceState int // serviceUnknown | serviceMissing | serviceStopped | serviceRunning
func livenessFromService(state serviceState) liveness
func dockerLiveness() func(context.Context) liveness // per OS
func podmanLiveness() func(context.Context) liveness // per OS
const ReasonNotRunning = "not_running"               // types.go
func (d *engineDriver) Runtime() Runtime
func (d *engineDriver) Detect(ctx context.Context) Detection
func (d *engineDriver) Collect(ctx context.Context, det Detection) Result
func detectionFromError(err error) Detection
func mapContainer(c apiContainer, images map[string]apiImage) Workload
func orderAndCap(ws []Workload) ([]Workload, bool)
```

Fixture shape (all values fake): five containers — `shop-web-1` (compose project `shop`, `nginx:1.27`, running, multi-arch image with two `RepoDigests` for two repositories), `cache` (`redis`, bare, no tag), `builder` (`myapp:dev`, local build, no `RepoDigests`, exited, two names), `pinned` (`ghcr.io/o/r@sha256:…`, restarting), `old-web` (image id as the reference, dead). The first two carry `Command`, `Mounts`, `Env`, `Ports`, `HostConfig`, `NetworkSettings`, a non-compose label and a compose `config_files` label whose values contain `FIXTURE_*` markers that must never reach a report.

- [ ] **Step 1: Add the fixtures.**

```json
[
  {
    "Id": "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
    "Names": ["/shop-web-1"],
    "Image": "nginx:1.27",
    "ImageID": "sha256:a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
    "Command": "nginx -g 'daemon off;' --api-key=FIXTURE_CMD_SECRET",
    "Created": 1759307400,
    "Ports": [{"PrivatePort": 80, "PublicPort": 8080, "Type": "tcp"}],
    "Labels": {
      "com.docker.compose.project": "shop",
      "com.docker.compose.service": "web",
      "com.docker.compose.project.working_dir": "/srv/shop",
      "com.docker.compose.project.config_files": "/srv/shop/compose.yaml",
      "com.example.owner": "FIXTURE_LABEL_SECRET"
    },
    "State": "running",
    "Status": "Up 3 hours",
    "HostConfig": {"NetworkMode": "shop_default"},
    "NetworkSettings": {"Networks": {"shop_default": {"IPAddress": "172.18.0.2"}}},
    "Mounts": [{"Type": "bind", "Source": "/srv/shop/secrets", "Destination": "/run/secrets"}],
    "Env": ["DB_PASSWORD=FIXTURE_ENV_SECRET"]
  },
  {
    "Id": "2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b",
    "Names": ["/cache"],
    "Image": "redis",
    "ImageID": "sha256:b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
    "Command": "docker-entrypoint.sh redis-server --requirepass FIXTURE_CMD_SECRET",
    "Created": 1759000000,
    "Labels": {},
    "State": "running",
    "Status": "Up 5 days",
    "Mounts": []
  },
  {
    "Id": "3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c",
    "Names": ["/builder", "/legacy-alias/builder"],
    "Image": "myapp:dev",
    "ImageID": "sha256:c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
    "Command": "/app",
    "Created": 1757000000,
    "Labels": null,
    "State": "exited",
    "Status": "Exited (0) 2 days ago"
  },
  {
    "Id": "4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d",
    "Names": ["/pinned"],
    "Image": "ghcr.io/o/r@sha256:e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3",
    "ImageID": "sha256:9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f",
    "Created": 1758000000,
    "Labels": {"com.docker.compose.project": "tools"},
    "State": "restarting",
    "Status": "Restarting (1) 5 seconds ago"
  },
  {
    "Id": "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
    "Names": ["/old-web"],
    "Image": "sha256:a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
    "ImageID": "sha256:a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
    "Created": 1756000000,
    "Labels": {},
    "State": "dead",
    "Status": "Dead"
  }
]
```

```json
[
  {
    "Id": "sha256:a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
    "RepoTags": ["registry.example.com/mirror/nginx:1.27", "nginx:1.27"],
    "RepoDigests": [
      "registry.example.com/mirror/nginx@sha256:d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2",
      "nginx@sha256:d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"
    ],
    "Labels": {"org.example.image": "FIXTURE_IMAGE_LABEL"},
    "Size": 192000000
  },
  {
    "Id": "sha256:b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
    "RepoTags": ["redis:latest"],
    "RepoDigests": ["redis@sha256:f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4"],
    "Size": 117000000
  },
  {
    "Id": "sha256:c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
    "RepoTags": ["myapp:dev"],
    "RepoDigests": [],
    "Size": 54000000
  },
  {
    "Id": "sha256:9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f",
    "RepoTags": null,
    "RepoDigests": ["ghcr.io/o/r@sha256:e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3"],
    "Size": 9000000
  }
]
```

```json
{
  "Platform": {"Name": "Docker Engine - Community"},
  "Components": [
    {"Name": "Engine", "Version": "27.1.1", "Details": {"ApiVersion": "1.46", "Os": "linux"}},
    {"Name": "containerd", "Version": "1.7.19"},
    {"Name": "runc", "Version": "1.7.19"}
  ],
  "Version": "27.1.1",
  "ApiVersion": "1.46",
  "Os": "linux",
  "Arch": "amd64",
  "KernelVersion": "6.8.0-40-generic"
}
```

```json
{
  "Platform": {"Name": "linux/amd64/fedora-40"},
  "Components": [
    {"Name": "Podman Engine", "Version": "5.1.2", "Details": {"APIVersion": "5.1.2", "MinAPIVersion": "4.0.0"}},
    {"Name": "Conmon", "Version": "conmon version 2.1.12"}
  ],
  "Version": "5.1.2",
  "ApiVersion": "1.41",
  "Os": "linux",
  "Arch": "amd64"
}
```

- [ ] **Step 2: Write the failing driver tests.** They run a real `net/http` server behind a custom `DialFunc` and record every request line the engine sees. The liveness tests use a fake pid file, a fake proc directory and a dialer that fails the test if it is ever called, and drive the stopped-daemon path through the real `Collector` as well.

```go
// agent/internal/collectors/workloads/docker_test.go
package workloads

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"syscall"
	"testing"
)

func hex8(block string) string { return strings.Repeat(block, 8) }

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// fakeEngine serves canned responses and records every request line it sees.
type fakeEngine struct {
	mu       sync.Mutex
	requests []string
	routes   map[string]func(w http.ResponseWriter)
	srv      *httptest.Server
}

func newFakeEngine(t *testing.T, routes map[string]func(w http.ResponseWriter)) (*fakeEngine, DialFunc) {
	t.Helper()
	f := &fakeEngine{routes: routes}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.RequestURI()
		f.mu.Lock()
		f.requests = append(f.requests, r.Method+" "+key)
		f.mu.Unlock()
		if h, ok := f.routes[key]; ok {
			h(w)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f, func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", f.srv.Listener.Addr().String())
	}
}

func (f *fakeEngine) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

func serve(body []byte) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}
}

func status(code int) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) { w.WriteHeader(code) }
}

func dockerRoutes(t *testing.T) map[string]func(w http.ResponseWriter) {
	return map[string]func(w http.ResponseWriter){
		"/_ping":                 serve([]byte("OK")),
		"/version":               serve(fixture(t, "docker_version.json")),
		"/containers/json?all=1": serve(fixture(t, "docker_containers.json")),
		"/images/json":           serve(fixture(t, "docker_images.json")),
	}
}

func byName(ws []Workload) map[string]Workload {
	m := map[string]Workload{}
	for _, w := range ws {
		m[w.Name] = w
	}
	return m
}

func val(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestDockerDetectAndCollectFixture(t *testing.T) {
	eng, dial := newFakeEngine(t, dockerRoutes(t))
	d := newEngineDriver(RuntimeDocker, dial)
	det := d.Detect(context.Background())
	if det.State != DetectionPresent || det.Version != "27.1.1" || det.Reason != "" {
		t.Fatalf("detection = %+v", det)
	}
	res := d.Collect(context.Background(), det)
	if res.Collection != CollectionOK || !res.Complete || res.ObservedCount != 5 || len(res.Workloads) != 5 || res.Error != "" {
		t.Fatalf("result = %+v", res)
	}

	// Running first, then newest first: web, cache, pinned, builder, old-web.
	var order []string
	for _, w := range res.Workloads {
		order = append(order, w.Name)
	}
	if want := []string{"shop-web-1", "cache", "pinned", "builder", "old-web"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}

	ws := byName(res.Workloads)
	d1, d2 := "sha256:"+hex8("d1d1d1d1"), "sha256:"+hex8("d2d2d2d2")
	web := ws["shop-web-1"]
	checks := []struct{ name, got, want string }{
		{"web id", web.WorkloadID, hex8("1a1a1a1a")},
		{"web kind", web.Kind, KindContainer},
		{"web state", web.State, StateRunning},
		{"web raw", val(web.RawState), "running"},
		{"web ref", val(web.ImageRef), "nginx:1.27"},
		{"web repo", val(web.ImageRepository), "docker.io/library/nginx"},
		{"web tag", val(web.ImageTag), "1.27"},
		{"web digest (multi-arch, repo-matched)", val(web.ImageDigest), d1},
		{"web image id", val(web.ImageID), "sha256:" + hex8("a0a0a0a0")},
		{"web project", val(web.ComposeProject), "shop"},
		{"web service", val(web.ComposeService), "web"},
		{"web working dir", val(web.ComposeWorkingDir), "/srv/shop"},
		{"web created", val(web.RuntimeCreatedAt), "2025-10-01T08:30:00Z"},
		{"web started", val(web.StartedAt), "<nil>"},
		{"web restart policy", val(web.RestartPolicy), "<nil>"},
		{"redis ref", val(ws["cache"].ImageRef), "redis"},
		{"redis repo", val(ws["cache"].ImageRepository), "docker.io/library/redis"},
		{"redis tag", val(ws["cache"].ImageTag), "latest"},
		{"redis digest", val(ws["cache"].ImageDigest), "sha256:" + hex8("f4f4f4f4")},
		{"pinned tag", val(ws["pinned"].ImageTag), "<nil>"},
		{"pinned repo", val(ws["pinned"].ImageRepository), "ghcr.io/o/r"},
		{"pinned digest", val(ws["pinned"].ImageDigest), "sha256:" + hex8("e3e3e3e3")},
		{"pinned state", ws["pinned"].State, StateRestarting},
		{"pinned project", val(ws["pinned"].ComposeProject), "tools"},
		{"local build digest is null", val(ws["builder"].ImageDigest), "<nil>"},
		{"local build tag", val(ws["builder"].ImageTag), "dev"},
		{"first name wins", ws["builder"].Name, "builder"},
		{"exited is stopped", ws["builder"].State, StateStopped},
		{"exited raw", val(ws["builder"].RawState), "exited"},
		{"id-ref recovered from image tags", val(ws["old-web"].ImageRef), "nginx:1.27"},
		{"id-ref digest", val(ws["old-web"].ImageDigest), d1},
		{"dead is stopped", ws["old-web"].State, StateStopped},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
		}
	}
	// The mirror repository resolves to its own digest, not the Docker Hub one.
	if got := PickRepoDigest("registry.example.com/mirror/nginx", []string{
		"nginx@" + d1, "registry.example.com/mirror/nginx@" + d2}); got != d2 {
		t.Errorf("mirror digest = %q", got)
	}

	// Every request was a GET on the allowlist, in a bounded number of calls.
	want := []string{"GET /_ping", "GET /version", "GET /containers/json?all=1", "GET /images/json"}
	if got := eng.seen(); !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %v, want %v", got, want)
	}
}

// Env, command, mounts, ports, networks and non-compose labels are present in
// the fixture; none of them may reach the serialized report.
func TestDockerReportNeverContainsSensitiveFixtureValues(t *testing.T) {
	_, dial := newFakeEngine(t, dockerRoutes(t))
	d := newEngineDriver(RuntimeDocker, dial)
	res := d.Collect(context.Background(), d.Detect(context.Background()))
	raw, err := json.Marshal(res.Workloads)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"FIXTURE_CMD_SECRET", "FIXTURE_ENV_SECRET", "FIXTURE_LABEL_SECRET", "FIXTURE_IMAGE_LABEL",
		"/srv/shop/secrets", "/run/secrets", "shop_default", "172.18", "config_files", "compose.yaml",
		"daemon off", "redis-server", "Up 3 hours", "PublicPort", "DB_PASSWORD", "com.example.owner",
	} {
		if strings.Contains(string(raw), forbidden) {
			t.Errorf("report contains %q", forbidden)
		}
	}
}

// The decode structs are the allowlist: adding a field is a reviewed change.
func TestEngineStructsAreTheAllowlist(t *testing.T) {
	fields := func(v any) []string {
		var out []string
		rt := reflect.TypeOf(v)
		for i := 0; i < rt.NumField(); i++ {
			out = append(out, rt.Field(i).Name)
		}
		sort.Strings(out)
		return out
	}
	if got, want := fields(apiContainer{}), []string{"Created", "ID", "Image", "ImageID", "Labels", "Names", "State"}; !reflect.DeepEqual(got, want) {
		t.Errorf("apiContainer fields = %v, want %v", got, want)
	}
	if got, want := fields(apiImage{}), []string{"ID", "RepoDigests", "RepoTags"}; !reflect.DeepEqual(got, want) {
		t.Errorf("apiImage fields = %v, want %v", got, want)
	}
	if got, want := fields(composeLabels{}), []string{"Project", "Service", "WorkingDir"}; !reflect.DeepEqual(got, want) {
		t.Errorf("composeLabels fields = %v, want %v", got, want)
	}
}

func errDial(err error) DialFunc {
	return func(context.Context) (net.Conn, error) { return nil, err }
}

func TestDockerDetectMapsFailuresToDistinctStates(t *testing.T) {
	cases := []struct {
		name       string
		dial       DialFunc
		wantState  string
		wantReason string
	}{
		{"socket missing", errDial(&net.OpError{Op: "dial", Net: "unix", Err: syscall.ENOENT}), DetectionAbsent, ""},
		{"permission denied", errDial(&net.OpError{Op: "dial", Net: "unix", Err: syscall.EACCES}), DetectionPresent, ReasonPermissionDenied},
		{"daemon down", errDial(&net.OpError{Op: "dial", Net: "unix", Err: syscall.ECONNREFUSED}), DetectionPresent, ReasonUnavailable},
		{"timeout", errDial(context.DeadlineExceeded), DetectionUnknown, ReasonTimeout},
		{"surprise", errDial(fmt.Errorf("boom")), DetectionUnknown, ReasonUnreachable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			det := newEngineDriver(RuntimeDocker, tc.dial).Detect(context.Background())
			if det.State != tc.wantState || det.Reason != tc.wantReason {
				t.Fatalf("detection = %+v, want state %s reason %q", det, tc.wantState, tc.wantReason)
			}
		})
	}
}

func TestDockerDetectHTTPStatusMapping(t *testing.T) {
	for code, want := range map[int]Detection{
		http.StatusForbidden:           {State: DetectionPresent, Reason: ReasonPermissionDenied},
		http.StatusUnauthorized:        {State: DetectionPresent, Reason: ReasonPermissionDenied},
		http.StatusInternalServerError: {State: DetectionPresent, Reason: ReasonUnavailable},
	} {
		_, dial := newFakeEngine(t, map[string]func(http.ResponseWriter){"/_ping": status(code)})
		if got := newEngineDriver(RuntimeDocker, dial).Detect(context.Background()); got != want {
			t.Errorf("status %d: detection = %+v, want %+v", code, got, want)
		}
	}
}

func TestDockerCollectReportsDetectionFailuresWithoutRequests(t *testing.T) {
	eng, dial := newFakeEngine(t, dockerRoutes(t))
	d := newEngineDriver(RuntimeDocker, dial)
	res := d.Collect(context.Background(), Detection{State: DetectionPresent, Reason: ReasonPermissionDenied})
	if res.Collection != CollectionPermissionDenied || len(res.Workloads) != 0 {
		t.Fatalf("permission result = %+v", res)
	}
	res = d.Collect(context.Background(), Detection{State: DetectionPresent, Reason: ReasonUnavailable})
	if res.Collection != CollectionUnavailable {
		t.Fatalf("unavailable result = %+v", res)
	}
	if n := len(eng.seen()); n != 0 {
		t.Fatalf("made %d requests despite a failed detection", n)
	}
}

func TestDockerCollectFailureModes(t *testing.T) {
	routes := func(containers func(http.ResponseWriter), images func(http.ResponseWriter)) map[string]func(http.ResponseWriter) {
		return map[string]func(http.ResponseWriter){"/containers/json?all=1": containers, "/images/json": images}
	}
	cases := []struct {
		name       string
		routes     map[string]func(http.ResponseWriter)
		wantColl   string
		wantErr    string
		wantCount  int
		wantFull   bool
		wantDigest bool
	}{
		{"forbidden", routes(status(403), status(403)), CollectionPermissionDenied, ReasonPermissionDenied, 0, false, false},
		{"server error", routes(status(500), status(500)), CollectionError, "http_500", 0, false, false},
		{"garbled", routes(serve([]byte("{")), serve([]byte("[]"))), CollectionError, "decode_failed", 0, false, false},
		{"images failed", routes(serve(fixture(t, "docker_containers.json")), status(500)), CollectionOK, "images_list_failed", 5, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, dial := newFakeEngine(t, tc.routes)
			d := newEngineDriver(RuntimeDocker, dial)
			res := d.Collect(context.Background(), Detection{State: DetectionPresent})
			if res.Collection != tc.wantColl || res.Error != tc.wantErr || len(res.Workloads) != tc.wantCount || res.Complete != tc.wantFull {
				t.Fatalf("result = %+v", res)
			}
			for _, w := range res.Workloads {
				if w.ImageDigest != nil && w.Name != "pinned" {
					t.Fatalf("digest %q invented without an image list", *w.ImageDigest)
				}
			}
		})
	}
}

func TestDockerCollectDaemonGoneMidCollection(t *testing.T) {
	d := newEngineDriver(RuntimeDocker, errDial(&net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}))
	res := d.Collect(context.Background(), Detection{State: DetectionPresent})
	if res.Collection != CollectionUnavailable || res.Error != "daemon_unreachable" {
		t.Fatalf("result = %+v", res)
	}
}

func TestEngineGetRefusesOversizedBodies(t *testing.T) {
	_, dial := newFakeEngine(t, map[string]func(http.ResponseWriter){"/version": serve([]byte(strings.Repeat("x", 100)))})
	d := newEngineDriver(RuntimeDocker, dial)
	if _, _, err := d.get(context.Background(), "/version", 10); err != errTooLarge {
		t.Fatalf("err = %v, want errTooLarge", err)
	}
}

func TestDockerCapOrdersRunningFirstAndMarksIncomplete(t *testing.T) {
	var cs []map[string]any
	for i := 0; i < 1200; i++ {
		state := "exited"
		if i%2 == 0 {
			state = "running"
		}
		cs = append(cs, map[string]any{
			"Id": fmt.Sprintf("%064x", i), "Names": []string{fmt.Sprintf("/c%d", i)},
			"Image": "app:1", "ImageID": "sha256:" + hex8("a0a0a0a0"),
			"Created": 1700000000 + i, "State": state, "Labels": map[string]string{},
		})
	}
	// A duplicate id must not produce a duplicate workload (the server answers 400).
	cs = append(cs, cs[0])
	body, _ := json.Marshal(cs)
	_, dial := newFakeEngine(t, map[string]func(http.ResponseWriter){
		"/containers/json?all=1": serve(body), "/images/json": serve([]byte("[]")),
	})
	res := newEngineDriver(RuntimeDocker, dial).Collect(context.Background(), Detection{State: DetectionPresent})
	if len(res.Workloads) != MaxWorkloadsPerRuntime || res.ObservedCount != 1200 || res.Complete || res.Error != "truncated" {
		t.Fatalf("len=%d observed=%d complete=%v err=%q", len(res.Workloads), res.ObservedCount, res.Complete, res.Error)
	}
	for _, w := range res.Workloads[:600] {
		if w.State != StateRunning {
			t.Fatalf("running containers must sort first, got %s", w.State)
		}
	}
	ids := map[string]bool{}
	for _, w := range res.Workloads {
		if ids[w.WorkloadID] {
			t.Fatalf("duplicate workload id %s", w.WorkloadID)
		}
		ids[w.WorkloadID] = true
	}
}

func TestPodmanAndDockerShareASocketWithoutDoubleReporting(t *testing.T) {
	podmanRoutes := map[string]func(http.ResponseWriter){
		"/_ping": serve([]byte("OK")), "/version": serve(fixture(t, "podman_version.json")),
	}
	_, dial := newFakeEngine(t, podmanRoutes)
	if got := newEngineDriver(RuntimePodman, dial).Detect(context.Background()); got.State != DetectionPresent || got.Version != "5.1.2" {
		t.Fatalf("podman detection = %+v", got)
	}
	// /var/run/docker.sock symlinked to Podman: the docker driver steps aside.
	if got := newEngineDriver(RuntimeDocker, dial).Detect(context.Background()); got.State != DetectionAbsent {
		t.Fatalf("docker driver on a Podman socket = %+v, want absent", got)
	}
	_, dockerDial := newFakeEngine(t, dockerRoutes(t))
	if got := newEngineDriver(RuntimePodman, dockerDial).Detect(context.Background()); got.State != DetectionAbsent {
		t.Fatalf("podman driver on a Docker socket = %+v, want absent", got)
	}
}

func TestEngineWithoutEndpointIsAbsent(t *testing.T) {
	if got := newEngineDriver(RuntimePodman, nil).Detect(context.Background()); got.State != DetectionAbsent {
		t.Fatalf("detection = %+v", got)
	}
}
```

```go
// agent/internal/collectors/workloads/liveness_test.go
package workloads

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// noDial fails the test if anything tries to open a connection.
func noDial(t *testing.T) DialFunc {
	t.Helper()
	return func(context.Context) (net.Conn, error) {
		t.Error("dialed an engine socket whose daemon is not running")
		return nil, errors.New("must not dial")
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeProc writes procDir/<pid>/{comm,cmdline}.
func fakeProc(t *testing.T, procDir string, pid int, comm string, argv ...string) {
	t.Helper()
	dir := filepath.Join(procDir, strconv.Itoa(pid))
	writeFile(t, filepath.Join(dir, "comm"), comm+"\n")
	cmdline := ""
	for _, a := range argv {
		cmdline += a + "\x00"
	}
	writeFile(t, filepath.Join(dir, "cmdline"), cmdline)
}

type dockerHost struct {
	socket, pidFile, procDir string
}

// newDockerHost creates a socket stand-in file (Detect only stats it) and empty
// pid/proc locations.
func newDockerHost(t *testing.T) dockerHost {
	t.Helper()
	dir := t.TempDir()
	h := dockerHost{socket: filepath.Join(dir, "docker.sock"), pidFile: filepath.Join(dir, "docker.pid"), procDir: filepath.Join(dir, "proc")}
	writeFile(t, h.socket, "")
	if err := os.MkdirAll(h.procDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return h
}

func (h dockerHost) driver(dial DialFunc) *engineDriver {
	return newEngineDriver(RuntimeDocker, dial, withSocketPath(h.socket), withLiveness(pidFileLiveness(h.pidFile, h.procDir, "dockerd")))
}

func TestDockerNeverConnectsUnlessDaemonIsAlreadyRunning(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, h dockerHost)
	}{
		{"no pid file (stopped socket-activated daemon)", func(*testing.T, dockerHost) {}},
		{"garbage pid file", func(t *testing.T, h dockerHost) { writeFile(t, h.pidFile, "not-a-pid") }},
		{"zero pid", func(t *testing.T, h dockerHost) { writeFile(t, h.pidFile, "0\n") }},
		{"stale pid, process gone", func(t *testing.T, h dockerHost) { writeFile(t, h.pidFile, "4242\n") }},
		{"pid reused by another program", func(t *testing.T, h dockerHost) {
			writeFile(t, h.pidFile, "4242\n")
			fakeProc(t, h.procDir, 4242, "bash")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newDockerHost(t)
			tc.setup(t, h)
			d := h.driver(noDial(t))
			det := d.Detect(context.Background())
			if det.State != DetectionPresent || det.Reason != ReasonNotRunning {
				t.Fatalf("detection = %+v, want present/not_running", det)
			}
			res := d.Collect(context.Background(), det)
			if res.Collection != CollectionUnavailable || res.Error != "daemon not running" || len(res.Workloads) != 0 {
				t.Fatalf("collect = %+v", res)
			}
		})
	}
}

func TestDockerConnectsOnceDaemonIsRunning(t *testing.T) {
	h := newDockerHost(t)
	writeFile(t, h.pidFile, "4242\n")
	fakeProc(t, h.procDir, 4242, "dockerd", "/usr/bin/dockerd")
	_, dial := newFakeEngine(t, dockerRoutes(t))
	det := h.driver(dial).Detect(context.Background())
	if det.State != DetectionPresent || det.Version != "27.1.1" || det.Reason != "" {
		t.Fatalf("detection = %+v", det)
	}
}

func TestDockerSocketMissingIsAbsentWithoutConnecting(t *testing.T) {
	h := newDockerHost(t)
	if err := os.Remove(h.socket); err != nil {
		t.Fatal(err)
	}
	if det := h.driver(noDial(t)).Detect(context.Background()); det.State != DetectionAbsent {
		t.Fatalf("detection = %+v", det)
	}
}

// podman-docker links /var/run/docker.sock to Podman's socket. The docker driver
// must recognise that from the path alone, with no connection and no pid check.
func TestDockerSocketLinkedToPodmanIsAbsentWithoutConnecting(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "podman.sock")
	writeFile(t, target, "")
	link := filepath.Join(dir, "docker.sock")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	d := newEngineDriver(RuntimeDocker, noDial(t), withSocketPath(link), withLiveness(func(context.Context) liveness { return livenessRunning }))
	if det := d.Detect(context.Background()); det.State != DetectionAbsent {
		t.Fatalf("detection = %+v, want absent", det)
	}
}

func TestPodmanNeverConnectsWithoutARunningServiceProcess(t *testing.T) {
	dir := t.TempDir()
	socket, procDir := filepath.Join(dir, "podman.sock"), filepath.Join(dir, "proc")
	writeFile(t, socket, "")
	fakeProc(t, procDir, 1, "systemd", "/sbin/init")
	fakeProc(t, procDir, 200, "bash", "bash")
	fakeProc(t, procDir, 201, "podman", "/usr/bin/podman", "ps", "-a") // a CLI call, not the service
	fakeProc(t, procDir, 202, "conmon", "/usr/bin/conmon")
	writeFile(t, filepath.Join(procDir, "self-not-a-pid", "cmdline"), "podman\x00system\x00service\x00")

	d := newEngineDriver(RuntimePodman, noDial(t), withSocketPath(socket), withLiveness(podmanServiceLiveness(procDir)))
	det := d.Detect(context.Background())
	if det.State != DetectionPresent || det.Reason != ReasonNotRunning {
		t.Fatalf("detection = %+v, want present/not_running", det)
	}
	if res := d.Collect(context.Background(), det); res.Collection != CollectionUnavailable || res.Error != "daemon not running" {
		t.Fatalf("collect = %+v", res)
	}

	// Once a service process exists the driver connects.
	fakeProc(t, procDir, 300, "podman", "/usr/bin/podman", "--log-level=info", "system", "service", "--time=0")
	_, dial := newFakeEngine(t, map[string]func(http.ResponseWriter){
		"/_ping": serve([]byte("OK")), "/version": serve(fixture(t, "podman_version.json")),
	})
	d = newEngineDriver(RuntimePodman, dial, withSocketPath(socket), withLiveness(podmanServiceLiveness(procDir)))
	if det := d.Detect(context.Background()); det.State != DetectionPresent || det.Version != "5.1.2" {
		t.Fatalf("detection with a running service = %+v", det)
	}
}

func TestIsPodmanService(t *testing.T) {
	for name, tc := range map[string]struct {
		args []string
		want bool
	}{
		"plain":            {[]string{"/usr/bin/podman", "system", "service"}, true},
		"with flags":       {[]string{"podman", "--log-level=info", "system", "service", "--time=0"}, true},
		"cli ps":           {[]string{"/usr/bin/podman", "ps", "-a"}, false},
		"system prune":     {[]string{"podman", "system", "prune"}, false},
		"other binary":     {[]string{"/usr/bin/docker", "system", "service"}, false},
		"too short":        {[]string{"podman", "system"}, false},
		"empty cmdline":    {[]string{""}, false},
		"podman-remote":    {[]string{"podman-remote", "system", "service"}, false},
		"service not last": {[]string{"podman", "service", "system"}, false},
	} {
		if got := isPodmanService(tc.args); got != tc.want {
			t.Errorf("%s: isPodmanService(%v) = %v, want %v", name, tc.args, got, tc.want)
		}
	}
}

func TestLivenessFromService(t *testing.T) {
	for state, want := range map[serviceState]liveness{
		serviceRunning: livenessRunning,
		serviceMissing: livenessAbsent,
		serviceStopped: livenessStopped,
		serviceUnknown: livenessStopped, // when in doubt, do not connect
	} {
		if got := livenessFromService(state); got != want {
			t.Errorf("livenessFromService(%d) = %d, want %d", state, got, want)
		}
	}
}

// End to end through the collector: a stopped daemon is reported as present +
// unavailable when enumeration is on, as disabled when it is off, and neither
// path dials.
func TestCollectorReportsStoppedDaemonWithoutDialing(t *testing.T) {
	h := newDockerHost(t)
	c := New([]Driver{h.driver(noDial(t))}, WithClock(fixedNow))

	on := c.Collect(context.Background(), enabled()).Runtimes[0]
	if on.Detection != DetectionPresent || on.Collection != CollectionUnavailable || on.Error == nil || *on.Error != "daemon not running" || len(on.Workloads) != 0 || on.RuntimeVersion != nil {
		t.Fatalf("enabled = %+v", on)
	}
	off := c.Collect(context.Background(), DefaultSettings()).Runtimes[0]
	if off.Detection != DetectionPresent || off.Collection != CollectionDisabled {
		t.Fatalf("disabled = %+v", off)
	}
}
```

- [ ] **Step 3: Run and watch it fail.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestDocker|TestEngine|TestPodman|TestIsPodman|TestLiveness|TestCollectorReportsStopped'
```

Expected: FAIL, build error `undefined: newEngineDriver` / `undefined: apiContainer` / `undefined: pidFileLiveness`.

- [ ] **Step 4: Implement the driver and the liveness gates.** (`ReasonNotRunning` and the `socketPathFor` helpers are already in the Task 1 and Task 3 files above.)

```go
// agent/internal/collectors/workloads/docker.go
package workloads

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	maxListBytes  = 32 << 20
	maxSmallBytes = 1 << 20
	// engineTimeout bounds each HTTP request; the collector additionally gives
	// every driver a 30 s context for the whole Detect or Collect call.
	engineTimeout = 25 * time.Second

	labelComposeProject    = "com.docker.compose.project"
	labelComposeService    = "com.docker.compose.service"
	labelComposeWorkingDir = "com.docker.compose.project.working_dir"
)

var errTooLarge = errors.New("workloads: response too large")

// engineDriver speaks the Docker Engine API over a local socket or pipe. Podman
// serves the same endpoints, so one implementation backs both runtimes; the
// runtime field decides which flavor this driver reports.
type engineDriver struct {
	runtime Runtime
	client  *http.Client // nil when the runtime has no endpoint on this OS

	// Pre-connect gates. Connecting to a socket-activated engine starts it, so
	// Detect decides "present" and "running" without a connection first.
	socketPath string                         // unix socket to stat; "" on Windows
	liveness   func(context.Context) liveness // nil means always connect
	stat       func(string) (fs.FileInfo, error)
	resolve    func(string) (string, error)
}

type engineOption func(*engineDriver)

// withSocketPath makes Detect stat the socket before anything else: a missing
// socket is "absent" and a socket that is a symlink to Podman's is not Docker.
func withSocketPath(p string) engineOption { return func(d *engineDriver) { d.socketPath = p } }

// withLiveness adds the "is the daemon already running" check that must pass
// before any connection is made.
func withLiveness(f func(context.Context) liveness) engineOption {
	return func(d *engineDriver) { d.liveness = f }
}

func newEngineDriver(rt Runtime, dial DialFunc, opts ...engineOption) *engineDriver {
	d := &engineDriver{runtime: rt, stat: os.Stat, resolve: filepath.EvalSymlinks}
	if dial != nil {
		d.client = newReadOnlyClient(dial, engineTimeout)
	}
	for _, o := range opts {
		o(d)
	}
	return d
}

// preflight answers what can be known without opening a connection. It returns
// ok=true when the detection is final.
func (d *engineDriver) preflight(ctx context.Context) (Detection, bool) {
	if d.socketPath != "" {
		if _, err := d.stat(d.socketPath); err != nil {
			switch {
			case errors.Is(err, fs.ErrNotExist):
				return Detection{State: DetectionAbsent}, true
			case errors.Is(err, fs.ErrPermission):
				return Detection{State: DetectionPresent, Reason: ReasonPermissionDenied}, true
			default:
				return Detection{State: DetectionUnknown, Reason: ReasonUnreachable}, true
			}
		}
		if d.runtime == RuntimeDocker {
			// podman-docker symlinks /var/run/docker.sock to Podman's socket; that
			// engine is reported once, as podman.
			if target, err := d.resolve(d.socketPath); err == nil && strings.HasPrefix(filepath.Base(target), "podman") {
				return Detection{State: DetectionAbsent}, true
			}
		}
	}
	if d.liveness != nil {
		switch d.liveness(ctx) {
		case livenessAbsent:
			return Detection{State: DetectionAbsent}, true
		case livenessStopped:
			return Detection{State: DetectionPresent, Reason: ReasonNotRunning}, true
		}
	}
	return Detection{}, false
}

func (d *engineDriver) Runtime() Runtime { return d.runtime }

// engineVersion is the subset of GET /version the driver reads.
type engineVersion struct {
	Version    string `json:"Version"`
	Components []struct {
		Name string `json:"Name"`
	} `json:"Components"`
}

func (v engineVersion) known() bool { return v.Version != "" || len(v.Components) > 0 }

// isPodman is true when the engine behind the socket identifies as Podman, for
// example when /var/run/docker.sock is a symlink to Podman's socket.
func (v engineVersion) isPodman() bool {
	for _, c := range v.Components {
		if strings.HasPrefix(strings.ToLower(c.Name), "podman") {
			return true
		}
	}
	return false
}

// Detect answers "is this runtime here" with GET /_ping and GET /version only.
//
//	socket missing                       -> absent
//	socket present, daemon not running   -> present, Reason not_running (no connection made)
//	socket present, access denied        -> present, Reason permission_denied
//	socket present, daemon not answering -> present, Reason unavailable
//	timeout or an unexpected error       -> unknown (previous state is kept server-side)
func (d *engineDriver) Detect(ctx context.Context) Detection {
	if d.client == nil {
		return Detection{State: DetectionAbsent}
	}
	if det, final := d.preflight(ctx); final {
		return det
	}
	status, _, err := d.get(ctx, "/_ping", maxSmallBytes)
	if err != nil {
		return detectionFromError(err)
	}
	if det, failed := detectionFromStatus(status); failed {
		return det
	}
	var v engineVersion
	vs, vb, verr := d.get(ctx, "/version", maxSmallBytes)
	if verr == nil && vs == http.StatusOK {
		_ = json.Unmarshal(vb, &v)
	}
	if v.known() && v.isPodman() != (d.runtime == RuntimePodman) {
		return Detection{State: DetectionAbsent}
	}
	return Detection{State: DetectionPresent, Version: clip(v.Version, 64)}
}

func detectionFromError(err error) Detection {
	var netErr net.Error
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return Detection{State: DetectionAbsent}
	case errors.Is(err, fs.ErrPermission):
		return Detection{State: DetectionPresent, Reason: ReasonPermissionDenied}
	case errors.Is(err, syscall.ECONNREFUSED):
		return Detection{State: DetectionPresent, Reason: ReasonUnavailable}
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()):
		return Detection{State: DetectionUnknown, Reason: ReasonTimeout}
	default:
		return Detection{State: DetectionUnknown, Reason: ReasonUnreachable}
	}
}

func detectionFromStatus(status int) (Detection, bool) {
	switch {
	case status == http.StatusOK:
		return Detection{}, false
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return Detection{State: DetectionPresent, Reason: ReasonPermissionDenied}, true
	default:
		return Detection{State: DetectionPresent, Reason: ReasonUnavailable}, true
	}
}

// apiContainer is the allowlist for GET /containers/json: id, first name,
// state, image reference, image id, creation time and the three compose
// labels. Environment, command, mounts, ports, networks, host config and every
// other label are not declared here, so they are never decoded.
type apiContainer struct {
	ID      string        `json:"Id"`
	Names   []string      `json:"Names"`
	Image   string        `json:"Image"`
	ImageID string        `json:"ImageID"`
	Created int64         `json:"Created"`
	State   string        `json:"State"`
	Labels  composeLabels `json:"Labels"`
}

// composeLabels keeps the three compose labels and drops the rest at decode time.
type composeLabels struct {
	Project, Service, WorkingDir string
}

func (l *composeLabels) UnmarshalJSON(b []byte) error {
	var all map[string]string
	if err := json.Unmarshal(b, &all); err != nil {
		return nil // an unexpected label shape just means no compose metadata
	}
	l.Project = all[labelComposeProject]
	l.Service = all[labelComposeService]
	l.WorkingDir = all[labelComposeWorkingDir]
	return nil
}

// apiImage is the allowlist for GET /images/json.
type apiImage struct {
	ID          string   `json:"Id"`
	RepoTags    []string `json:"RepoTags"`
	RepoDigests []string `json:"RepoDigests"`
}

// Collect lists containers and images with two GET requests. It never calls
// inspect, so restart policy stays null and no environment is ever returned.
func (d *engineDriver) Collect(ctx context.Context, det Detection) Result {
	switch det.Reason {
	case ReasonNotRunning:
		return Result{Collection: CollectionUnavailable, Error: "daemon not running"}
	case ReasonPermissionDenied:
		return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}
	case ReasonUnavailable:
		return Result{Collection: CollectionUnavailable, Error: "daemon_unreachable"}
	}
	if d.client == nil {
		return Result{Collection: CollectionUnavailable, Error: "daemon_unreachable"}
	}
	status, body, err := d.get(ctx, "/containers/json?all=1", maxListBytes)
	if res, failed := failureResult(status, err); failed {
		return res
	}
	var containers []apiContainer
	if err := json.Unmarshal(body, &containers); err != nil {
		return Result{Collection: CollectionError, Error: "decode_failed"}
	}

	complete, code := true, ""
	images := map[string]apiImage{}
	istatus, ibody, ierr := d.get(ctx, "/images/json", maxListBytes)
	var list []apiImage
	if ierr != nil || istatus != http.StatusOK || json.Unmarshal(ibody, &list) != nil {
		complete, code = false, "images_list_failed"
	}
	for _, img := range list {
		images[normalizeImageID(img.ID)] = img
	}

	ws := buildContainerWorkloads(containers, images)
	observed := len(ws)
	ws, truncated := orderAndCap(ws)
	if truncated {
		complete = false
		if code == "" {
			code = "truncated"
		}
	}
	return Result{Collection: CollectionOK, Complete: complete, Workloads: ws, ObservedCount: observed, Error: code}
}

func failureResult(status int, err error) (Result, bool) {
	if err != nil {
		if errors.Is(err, errTooLarge) {
			return Result{Collection: CollectionError, Error: "response_too_large"}, true
		}
		switch det := detectionFromError(err); {
		case det.Reason == ReasonPermissionDenied:
			return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}, true
		case det.State == DetectionAbsent || det.Reason == ReasonUnavailable:
			return Result{Collection: CollectionUnavailable, Error: "daemon_unreachable"}, true
		case det.Reason == ReasonTimeout:
			return Result{Collection: CollectionUnavailable, Error: ReasonTimeout}, true
		default:
			return Result{Collection: CollectionError, Error: "request_failed"}, true
		}
	}
	switch {
	case status == http.StatusOK:
		return Result{}, false
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}, true
	default:
		return Result{Collection: CollectionError, Error: "http_" + strconv.Itoa(status)}, true
	}
}

func (d *engineDriver) get(ctx context.Context, pathAndQuery string, limit int64) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://engine"+pathAndQuery, nil)
	if err != nil {
		return 0, nil, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	if int64(len(body)) > limit {
		return resp.StatusCode, nil, errTooLarge
	}
	return resp.StatusCode, body, nil
}

func normalizeImageID(id string) string {
	id = strings.TrimSpace(id)
	if len(id) == 64 && !strings.HasPrefix(id, "sha256:") && IsImageID(id) {
		return "sha256:" + id
	}
	return id
}

func buildContainerWorkloads(containers []apiContainer, images map[string]apiImage) []Workload {
	seen := make(map[string]bool, len(containers))
	out := make([]Workload, 0, len(containers))
	for _, c := range containers {
		if c.ID == "" || seen[c.ID] {
			continue
		}
		seen[c.ID] = true
		out = append(out, mapContainer(c, images))
	}
	return out
}

func mapContainer(c apiContainer, images map[string]apiImage) Workload {
	imageID := normalizeImageID(c.ImageID)
	img := images[imageID]
	ref := strings.TrimSpace(c.Image)
	if IsImageID(ref) {
		// The engine reports a bare id when the tag has moved to another image;
		// recover a name from the image's own tags when it still has one.
		ref = ""
		if len(img.RepoTags) > 0 {
			tags := append([]string(nil), img.RepoTags...)
			sort.Strings(tags)
			ref = tags[0]
		}
	}
	parsed := NormalizeImage(ref)
	digest := PickRepoDigest(parsed.Repository, img.RepoDigests)
	if digest == "" && parsed.Pinned && digestPattern.MatchString(parsed.Digest) {
		digest = parsed.Digest
	}

	name := ""
	if len(c.Names) > 0 {
		name = strings.TrimPrefix(c.Names[0], "/")
	}
	if name == "" {
		name = clip(c.ID, 12)
	}
	w := Workload{
		WorkloadID:        c.ID,
		Kind:              KindContainer,
		Name:              name,
		State:             mapContainerState(c.State),
		RawState:          strp(c.State),
		ImageRef:          strp(ref),
		ImageRepository:   strp(parsed.Repository),
		ImageTag:          strp(parsed.Tag),
		ImageDigest:       strp(digest),
		ImageID:           strp(imageID),
		ComposeProject:    strp(c.Labels.Project),
		ComposeService:    strp(c.Labels.Service),
		ComposeWorkingDir: strp(c.Labels.WorkingDir),
	}
	if c.Created > 0 {
		w.RuntimeCreatedAt = strp(time.Unix(c.Created, 0).UTC().Format(time.RFC3339))
	}
	// StartedAt stays null: the list response only carries a relative "Up 3
	// hours" string, which is neither exact nor stable between collections.
	w.Bound()
	return w
}

func mapContainerState(raw string) string {
	switch strings.ToLower(raw) {
	case "running":
		return StateRunning
	case "paused":
		return StatePaused
	case "restarting":
		return StateRestarting
	case "exited", "created", "dead", "stopped", "configured", "initialized":
		return StateStopped
	default:
		return StateOther
	}
}

// orderAndCap sorts running workloads first, then newest first, then by id, and
// keeps at most MaxWorkloadsPerRuntime. The second result reports truncation.
func orderAndCap(ws []Workload) ([]Workload, bool) {
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	sort.SliceStable(ws, func(i, j int) bool {
		a, b := ws[i], ws[j]
		if ar, br := a.State == StateRunning, b.State == StateRunning; ar != br {
			return ar
		}
		if ac, bc := deref(a.RuntimeCreatedAt), deref(b.RuntimeCreatedAt); ac != bc {
			return ac > bc
		}
		return a.WorkloadID < b.WorkloadID
	})
	if len(ws) > MaxWorkloadsPerRuntime {
		return ws[:MaxWorkloadsPerRuntime:MaxWorkloadsPerRuntime], true
	}
	return ws, false
}
```

```go
// agent/internal/collectors/workloads/liveness.go
package workloads

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// liveness is what Detect learns about a runtime's daemon without opening a
// connection. A connection to a socket-activated engine starts the engine, so a
// stopped daemon must be recognized before anything dials.
type liveness int

const (
	livenessRunning liveness = iota // the daemon process exists; connecting is safe
	livenessStopped                 // installed, not running: report unavailable, never connect
	livenessAbsent                  // not installed
)

// pidFileLiveness reports livenessRunning only when pidFile names a process that
// exists under procDir and whose command name is comm. A missing, malformed or
// stale pid file, or a pid reused by another program, means "stopped".
func pidFileLiveness(pidFile, procDir, comm string) func(context.Context) liveness {
	return func(context.Context) liveness {
		raw, err := os.ReadFile(pidFile)
		if err != nil || len(raw) > 32 {
			return livenessStopped
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
		if err != nil || pid <= 0 {
			return livenessStopped
		}
		name, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), "comm"))
		if err != nil || strings.TrimSpace(string(name)) != comm {
			return livenessStopped
		}
		return livenessRunning
	}
}

// podmanServiceLiveness scans procDir/*/cmdline for a running
// `podman system service`. podman.socket is socket-activated, so the API socket
// existing says nothing about whether a service process is up.
func podmanServiceLiveness(procDir string) func(context.Context) liveness {
	return func(ctx context.Context) liveness {
		entries, err := os.ReadDir(procDir)
		if err != nil {
			return livenessStopped
		}
		for _, e := range entries {
			if ctx.Err() != nil {
				return livenessStopped
			}
			if _, err := strconv.Atoi(e.Name()); err != nil {
				continue
			}
			f, err := os.Open(filepath.Join(procDir, e.Name(), "cmdline"))
			if err != nil {
				continue
			}
			raw, _ := io.ReadAll(io.LimitReader(f, 4096))
			_ = f.Close()
			if isPodmanService(strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")) {
				return livenessRunning
			}
		}
		return livenessStopped
	}
}

// isPodmanService matches argv of `podman [global flags] system service ...`.
func isPodmanService(args []string) bool {
	if len(args) < 3 || filepath.Base(args[0]) != "podman" {
		return false
	}
	for i := 1; i+1 < len(args); i++ {
		if args[i] == "system" && args[i+1] == "service" {
			return true
		}
	}
	return false
}

// serviceState is the result of a read-only Windows service query.
type serviceState int

const (
	serviceUnknown serviceState = iota // the query itself failed
	serviceMissing
	serviceStopped
	serviceRunning
)

// livenessFromService maps a service query to a liveness. An unknown state is
// treated as stopped: when in doubt, do not connect.
func livenessFromService(state serviceState) liveness {
	switch state {
	case serviceRunning:
		return livenessRunning
	case serviceMissing:
		return livenessAbsent
	default:
		return livenessStopped
	}
}
```

```go
// agent/internal/collectors/workloads/liveness_linux.go
package workloads

import "context"

// dockerLiveness requires a live dockerd named in the default pid file.
func dockerLiveness() func(context.Context) liveness {
	return pidFileLiveness("/var/run/docker.pid", "/proc", "dockerd")
}

// podmanLiveness requires a running `podman system service` process.
func podmanLiveness() func(context.Context) liveness { return podmanServiceLiveness("/proc") }
```

```go
// agent/internal/collectors/workloads/liveness_windows.go
package workloads

import (
	"context"
	"errors"

	"golang.org/x/sys/windows"
)

// dockerLiveness connects to the pipe only while the `docker` service is
// running. The service is opened with SERVICE_QUERY_STATUS only, so the query
// cannot start or stop anything.
func dockerLiveness() func(context.Context) liveness {
	return func(context.Context) liveness { return livenessFromService(queryServiceState("docker")) }
}

func podmanLiveness() func(context.Context) liveness { return nil }

func queryServiceState(name string) serviceState {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return serviceUnknown
	}
	defer windows.CloseServiceHandle(scm)
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return serviceUnknown
	}
	svc, err := windows.OpenService(scm, namePtr, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return serviceMissing
		}
		return serviceUnknown
	}
	defer windows.CloseServiceHandle(svc)
	var status windows.SERVICE_STATUS
	if err := windows.QueryServiceStatus(svc, &status); err != nil {
		return serviceUnknown
	}
	if status.CurrentState == windows.SERVICE_RUNNING {
		return serviceRunning
	}
	return serviceStopped
}
```

```go
// agent/internal/collectors/workloads/liveness_other.go
//go:build !linux && !windows

package workloads

import "context"

func dockerLiveness() func(context.Context) liveness { return nil }
func podmanLiveness() func(context.Context) liveness { return nil }
```

- [ ] **Step 5: Run.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestDocker|TestEngine|TestPodman|TestIsPodman|TestLiveness|TestCollectorReportsStopped'
cd agent && GOOS=windows GOARCH=amd64 go vet ./internal/collectors/workloads/
```

Expected: PASS (20 tests) and a silent Windows vet (it compiles `liveness_windows.go`). The fixture test also asserts the four requests issued are exactly `GET /_ping`, `GET /version`, `GET /containers/json?all=1`, `GET /images/json`.

- [ ] **Step 6: Confirm the neighbouring collector is untouched.**

```bash
git diff --stat -- agent/internal/collectors/inventory.go
```

Expected: no output (the `docker*` interface skip at `inventory.go:118` is unchanged).

- [ ] **Step 7: Commit.**

```bash
git add agent/internal/collectors/workloads/docker.go agent/internal/collectors/workloads/docker_test.go agent/internal/collectors/workloads/liveness.go agent/internal/collectors/workloads/liveness_linux.go agent/internal/collectors/workloads/liveness_windows.go agent/internal/collectors/workloads/liveness_other.go agent/internal/collectors/workloads/liveness_test.go agent/internal/collectors/workloads/testdata
git commit -m "feat(agent): docker-compatible workload driver that never starts a stopped daemon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Podman and containerd drivers, per-OS registration

**Files:**
- Create: `agent/internal/collectors/workloads/drivers_test.go`
- Create: `agent/internal/collectors/workloads/drivers_linux_test.go`
- Create: `agent/internal/collectors/workloads/drivers.go`
- Create: `agent/internal/collectors/workloads/drivers_linux.go`
- Create: `agent/internal/collectors/workloads/drivers_windows.go`
- Create: `agent/internal/collectors/workloads/drivers_other.go`

Decision (stated, not asked): **containerd detect-only ships in W02.** It is a socket `stat` plus the rule "no Docker socket on the same host" (Docker bundles its own containerd and is reported as `docker`), so it costs nothing and gives Kubernetes nodes a host-axis entry. Its `Collect` returns `unsupported` and never lists containers (spec D6, OD-5). Podman reuses `engineDriver` unchanged, wired with the Task 4 gates (`withSocketPath`, `withLiveness`): docker needs a live dockerd (Linux pid file / Windows service), podman needs a running `podman system service`. A `docker.sock` that is really Podman's socket is reported once, as `podman`, decided from the path before any connection.

**Interfaces (produced):**

```go
func newDockerDriver() Driver
func newPodmanDriver() Driver
func newContainerdDriver() Driver
type containerdDriver struct {
	socket, dockerSocket string
	stat                 func(string) (fs.FileInfo, error)
}
func DefaultDrivers() []Driver // linux: docker, podman, containerd; windows: docker; other: nil
```

- [ ] **Step 1: Write the failing tests.**

```go
// agent/internal/collectors/workloads/drivers_test.go
package workloads

import (
	"context"
	"io/fs"
	"os"
	"testing"
)

func statOnly(existing ...string) func(string) (fs.FileInfo, error) {
	set := map[string]bool{}
	for _, p := range existing {
		set[p] = true
	}
	return func(p string) (fs.FileInfo, error) {
		if set[p] {
			return nil, nil
		}
		return nil, &fs.PathError{Op: "stat", Path: p, Err: fs.ErrNotExist}
	}
}

func TestContainerdIsDetectOnly(t *testing.T) {
	const sock, docker = "/run/containerd/containerd.sock", "/var/run/docker.sock"
	cases := []struct {
		name     string
		existing []string
		want     string
	}{
		{"kubernetes node", []string{sock}, DetectionPresent},
		{"docker host (bundled containerd)", []string{sock, docker}, DetectionAbsent},
		{"nothing installed", nil, DetectionAbsent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &containerdDriver{socket: sock, dockerSocket: docker, stat: statOnly(tc.existing...)}
			if got := d.Detect(context.Background()); got.State != tc.want {
				t.Fatalf("detection = %+v, want %s", got, tc.want)
			}
		})
	}
	d := &containerdDriver{socket: sock, dockerSocket: docker, stat: statOnly(sock)}
	res := d.Collect(context.Background(), Detection{State: DetectionPresent})
	if res.Collection != CollectionUnsupported || !res.Complete || len(res.Workloads) != 0 {
		t.Fatalf("collect = %+v", res)
	}
}

func TestContainerdStatErrorIsUnknownNotAbsent(t *testing.T) {
	d := &containerdDriver{socket: "/s", dockerSocket: "/d", stat: func(string) (fs.FileInfo, error) {
		return nil, &fs.PathError{Op: "stat", Path: "/s", Err: os.ErrInvalid}
	}}
	if got := d.Detect(context.Background()); got.State != DetectionUnknown {
		t.Fatalf("detection = %+v", got)
	}
}

func TestDefaultDriversHaveUniqueKnownRuntimes(t *testing.T) {
	seen := map[Runtime]bool{}
	for _, d := range DefaultDrivers() {
		if seen[d.Runtime()] {
			t.Fatalf("duplicate driver for %s", d.Runtime())
		}
		seen[d.Runtime()] = true
	}
	if seen[RuntimeHyperV] || seen[RuntimeProxmox] {
		t.Fatal("hyperv and proxmox drivers belong to a later wave")
	}
}
```

```go
// agent/internal/collectors/workloads/drivers_linux_test.go
package workloads

import "testing"

func TestLinuxRegistersDockerPodmanContainerd(t *testing.T) {
	got := map[Runtime]bool{}
	for _, d := range DefaultDrivers() {
		got[d.Runtime()] = true
	}
	for _, want := range []Runtime{RuntimeDocker, RuntimePodman, RuntimeContainerd} {
		if !got[want] {
			t.Errorf("missing %s driver", want)
		}
	}
	if len(got) != 3 {
		t.Errorf("registered %d drivers, want 3", len(got))
	}
}
```

- [ ] **Step 2: Run and watch it fail.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestContainerd|TestDefaultDrivers|TestLinuxRegisters'
```

Expected: FAIL, build error `undefined: containerdDriver` / `undefined: DefaultDrivers`.

- [ ] **Step 3: Implement.**

```go
// agent/internal/collectors/workloads/drivers.go
package workloads

import (
	"context"
	"errors"
	"io/fs"
	"os"
)

func endpointFor(path string) DialFunc {
	if path == "" {
		return nil
	}
	return endpointDialer(path)
}

// newDockerDriver never connects unless dockerd is already running: on Linux a
// live pid in /var/run/docker.pid, on Windows a running `docker` service.
func newDockerDriver() Driver {
	return newEngineDriver(RuntimeDocker, endpointFor(defaultDockerEndpoint),
		withSocketPath(socketPathFor(defaultDockerEndpoint)), withLiveness(dockerLiveness()))
}

// newPodmanDriver reads Podman's rootful API socket through the same
// Docker-compatible endpoints, and only while a `podman system service` process
// is already running (podman.socket is socket-activated). Rootless per-user
// sockets are out of scope: the agent runs as root and does not impersonate users.
func newPodmanDriver() Driver {
	return newEngineDriver(RuntimePodman, endpointFor(defaultPodmanEndpoint),
		withSocketPath(socketPathFor(defaultPodmanEndpoint)), withLiveness(podmanLiveness()))
}

// containerdDriver is detect-only in v1: it marks a host as a containerd (for
// example Kubernetes) node and never enumerates containers.
type containerdDriver struct {
	socket       string
	dockerSocket string
	stat         func(string) (fs.FileInfo, error)
}

func newContainerdDriver() Driver {
	return &containerdDriver{socket: defaultContainerdEndpoint, dockerSocket: defaultDockerEndpoint, stat: os.Stat}
}

func (d *containerdDriver) Runtime() Runtime { return RuntimeContainerd }

// Detect reports present when the containerd socket exists and no Docker socket
// does; Docker bundles its own containerd and is reported as docker instead.
func (d *containerdDriver) Detect(context.Context) Detection {
	if d.socket == "" {
		return Detection{State: DetectionAbsent}
	}
	if _, err := d.stat(d.socket); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Detection{State: DetectionAbsent}
		}
		return Detection{State: DetectionUnknown, Reason: ReasonUnreachable}
	}
	if d.dockerSocket != "" {
		if _, err := d.stat(d.dockerSocket); err == nil {
			return Detection{State: DetectionAbsent}
		}
	}
	return Detection{State: DetectionPresent}
}

func (d *containerdDriver) Collect(context.Context, Detection) Result {
	return Result{Collection: CollectionUnsupported, Complete: true}
}
```

```go
// agent/internal/collectors/workloads/drivers_linux.go
package workloads

// DefaultDrivers is the set of runtimes this OS can host. Hyper-V and Proxmox
// drivers register here in a later wave.
func DefaultDrivers() []Driver {
	return []Driver{newDockerDriver(), newPodmanDriver(), newContainerdDriver()}
}
```

```go
// agent/internal/collectors/workloads/drivers_windows.go
package workloads

// DefaultDrivers is the set of runtimes this OS can host. The Hyper-V driver
// registers here in a later wave.
func DefaultDrivers() []Driver {
	return []Driver{newDockerDriver()}
}
```

```go
// agent/internal/collectors/workloads/drivers_other.go
//go:build !linux && !windows

package workloads

// DefaultDrivers is empty on this OS. Docker Desktop on macOS exposes a
// per-user socket the root agent does not use, so reporting a runtime row for
// every workstation would only add noise; the collector sends nothing when it
// has no drivers.
func DefaultDrivers() []Driver { return nil }
```

- [ ] **Step 4: Run on the dev machine and prove every OS compiles.**

```bash
cd agent && go test -race ./internal/collectors/workloads/...
cd agent && GOOS=linux GOARCH=amd64 go vet ./internal/collectors/workloads/
cd agent && GOOS=windows GOARCH=amd64 go vet ./internal/collectors/workloads/
cd agent && GOOS=darwin GOARCH=arm64 go vet ./internal/collectors/workloads/
```

Expected: PASS and three silent `go vet` runs. `drivers_linux_test.go` only executes on a Linux runner (the `test-agent` CI job); `go vet` with `GOOS=linux` compiles it here.

- [ ] **Step 5: Commit.**

```bash
git add agent/internal/collectors/workloads/drivers.go agent/internal/collectors/workloads/drivers_linux.go agent/internal/collectors/workloads/drivers_windows.go agent/internal/collectors/workloads/drivers_other.go agent/internal/collectors/workloads/drivers_test.go agent/internal/collectors/workloads/drivers_linux_test.go
git commit -m "feat(agent): podman and containerd workload drivers with per-OS registration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Collector orchestration, payload fit and canonical hash

**Files:**
- Create: `agent/internal/collectors/workloads/collector_test.go`
- Create: `agent/internal/collectors/workloads/collector.go`

**Interfaces (produced):**

```go
const DriverTimeout = 30 * time.Second
type Collector struct{ /* drivers, clock, timeout */ }
type Option func(*Collector)
func WithClock(now func() time.Time) Option
func WithDriverTimeout(d time.Duration) Option
func New(drivers []Driver, opts ...Option) *Collector
func (c *Collector) HasDrivers() bool
func (c *Collector) Collect(ctx context.Context, s Settings) *Report // nil: no drivers, or ctx cancelled
func (r *Report) Hash() string                                       // sha256 hex, ignores collectedAt, runtime order and workload order
func (r *Report) fitPayload(maxBytes int)
```

Behavior pinned by the tests: `Detect` always runs; `Collect` runs only for enabled runtimes (`disabled` otherwise, with the detected version kept); `absent` → `collection: "unavailable"`, `complete: true`, no version; `unknown` → `unavailable`, `complete: false`, the reason as `error`; a panic in either call (via `collectors.Guard`) degrades only that runtime (`unknown`/`panic` or `error`/`panic`); each driver gets its own 30 s context; a non-`ok` collection carries no workloads; driver output is re-bounded (cap, string clipping, newline stripping, invalid collection state coerced to `error`); the hash covers detection, collection, completeness, version, counts and the error code, so any status change is a hash change; the byte budget matches spec §5.4 (`MaxPayloadBytes = 1_750_000`, tail of the priority order dropped from the largest runtime, that runtime marked `complete=false`, `observedCount` untouched; `TestFitPayloadKeepsReportUnderTheBodyLimit`).

- [ ] **Step 1: Write the failing tests.**

```go
// agent/internal/collectors/workloads/collector_test.go
package workloads

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type stubDriver struct {
	rt        Runtime
	detect    func(context.Context) Detection
	collect   func(context.Context, Detection) Result
	collected int
}

func (s *stubDriver) Runtime() Runtime                   { return s.rt }
func (s *stubDriver) Detect(c context.Context) Detection { return s.detect(c) }
func (s *stubDriver) Collect(c context.Context, d Detection) Result {
	s.collected++
	return s.collect(c, d)
}

func presentDriver(rt Runtime, ws ...Workload) *stubDriver {
	return &stubDriver{
		rt:     rt,
		detect: func(context.Context) Detection { return Detection{State: DetectionPresent, Version: "1.2.3"} },
		collect: func(context.Context, Detection) Result {
			return Result{Collection: CollectionOK, Complete: true, Workloads: ws, ObservedCount: len(ws)}
		},
	}
}

func wl(id string) Workload {
	return Workload{WorkloadID: id, Kind: KindContainer, Name: id, State: StateRunning}
}

func enabled() Settings { s := DefaultSettings(); s.Enabled = true; return s }

var fixedNow = func() time.Time { return time.Date(2026, 10, 6, 12, 0, 0, 123456789, time.UTC) }

func TestCollectorDetectsAlwaysButCollectsOnlyWhenEnabled(t *testing.T) {
	docker, podman := presentDriver(RuntimeDocker, wl("a")), presentDriver(RuntimePodman, wl("b"))
	c := New([]Driver{docker, podman}, WithClock(fixedNow))

	s := enabled()
	s.Podman = false
	rep := c.Collect(context.Background(), s)
	if rep.CollectedAt != "2026-10-06T12:00:00.123Z" || rep.ProtocolVersion != 1 {
		t.Fatalf("header = %+v", rep)
	}
	if docker.collected != 1 || podman.collected != 0 {
		t.Fatalf("collect calls docker=%d podman=%d", docker.collected, podman.collected)
	}
	d, p := rep.Runtimes[0], rep.Runtimes[1]
	if d.Collection != CollectionOK || len(d.Workloads) != 1 || d.RuntimeVersion == nil || *d.RuntimeVersion != "1.2.3" {
		t.Fatalf("docker = %+v", d)
	}
	if p.Detection != DetectionPresent || p.Collection != CollectionDisabled || !p.Complete || len(p.Workloads) != 0 || p.RuntimeVersion == nil {
		t.Fatalf("podman = %+v", p)
	}

	// Master switch off (the default): detection only, nothing enumerated.
	docker.collected = 0
	rep = c.Collect(context.Background(), DefaultSettings())
	if docker.collected != 0 {
		t.Fatal("Collect ran while the master switch is off")
	}
	for _, r := range rep.Runtimes {
		if r.Detection != DetectionPresent || r.Collection != CollectionDisabled || len(r.Workloads) != 0 {
			t.Fatalf("runtime = %+v", r)
		}
	}
}

func TestCollectorMapsDetectionStates(t *testing.T) {
	absent := &stubDriver{rt: RuntimeDocker, detect: func(context.Context) Detection { return Detection{State: DetectionAbsent} }}
	unknown := &stubDriver{rt: RuntimePodman, detect: func(context.Context) Detection {
		return Detection{State: DetectionUnknown, Reason: ReasonTimeout}
	}}
	garbage := &stubDriver{rt: RuntimeContainerd, detect: func(context.Context) Detection { return Detection{State: "maybe"} }}
	rep := New([]Driver{absent, unknown, garbage}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	a, u, g := rep.Runtimes[0], rep.Runtimes[1], rep.Runtimes[2]
	if a.Detection != DetectionAbsent || a.Collection != CollectionUnavailable || !a.Complete || a.RuntimeVersion != nil {
		t.Fatalf("absent = %+v", a)
	}
	if u.Detection != DetectionUnknown || u.Complete || u.Error == nil || *u.Error != ReasonTimeout {
		t.Fatalf("unknown = %+v", u)
	}
	if g.Detection != DetectionUnknown {
		t.Fatalf("invalid detection state not coerced: %+v", g)
	}
	for _, r := range rep.Runtimes {
		if r.Workloads == nil {
			t.Fatal("workloads must serialize as [] never null")
		}
	}
}

func TestCollectorPanicDegradesOnlyThatRuntime(t *testing.T) {
	bad := &stubDriver{
		rt:      RuntimeDocker,
		detect:  func(context.Context) Detection { return Detection{State: DetectionPresent} },
		collect: func(context.Context, Detection) Result { panic("driver bug") },
	}
	badDetect := &stubDriver{rt: RuntimeContainerd, detect: func(context.Context) Detection { panic("detect bug") }}
	good := presentDriver(RuntimePodman, wl("ok"))
	rep := New([]Driver{bad, good, badDetect}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	if r := rep.Runtimes[0]; r.Collection != CollectionError || r.Error == nil || *r.Error != ReasonPanic || len(r.Workloads) != 0 {
		t.Fatalf("panicking collect = %+v", r)
	}
	if r := rep.Runtimes[1]; r.Collection != CollectionOK || len(r.Workloads) != 1 {
		t.Fatalf("healthy driver affected: %+v", r)
	}
	if r := rep.Runtimes[2]; r.Detection != DetectionUnknown || r.Error == nil || *r.Error != ReasonPanic {
		t.Fatalf("panicking detect = %+v", r)
	}
}

func TestCollectorGivesEachDriverItsOwnTimeout(t *testing.T) {
	slow := &stubDriver{
		rt: RuntimeDocker,
		detect: func(ctx context.Context) Detection {
			<-ctx.Done()
			return Detection{State: DetectionUnknown, Reason: ReasonTimeout}
		},
	}
	fast := presentDriver(RuntimePodman, wl("x"))
	start := time.Now()
	rep := New([]Driver{slow, fast}, WithDriverTimeout(50*time.Millisecond), WithClock(fixedNow)).Collect(context.Background(), enabled())
	if time.Since(start) > 5*time.Second {
		t.Fatal("slow driver was not bounded")
	}
	if rep.Runtimes[1].Collection != CollectionOK {
		t.Fatalf("fast driver starved by slow one: %+v", rep.Runtimes[1])
	}
}

func TestCollectorReturnsNilWithoutDriversOrWhenCancelled(t *testing.T) {
	if New(nil).Collect(context.Background(), enabled()) != nil {
		t.Fatal("no drivers must mean no report")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if New([]Driver{presentDriver(RuntimeDocker)}).Collect(ctx, enabled()) != nil {
		t.Fatal("cancelled collection must not produce a report")
	}
}

func TestCollectorBoundsDriverOutput(t *testing.T) {
	long := wl("id")
	long.Name = strings.Repeat("n", 1000)
	many := make([]Workload, 0, MaxWorkloadsPerRuntime+5)
	for i := 0; i < MaxWorkloadsPerRuntime+5; i++ {
		many = append(many, wl(string(rune('a'+i%26))+strings.Repeat("x", i%7)))
	}
	d := &stubDriver{
		rt:     RuntimeDocker,
		detect: func(context.Context) Detection { return Detection{State: DetectionPresent} },
		collect: func(context.Context, Detection) Result {
			return Result{Collection: CollectionOK, Complete: true, Workloads: append(many, long), Error: "line1\nline2"}
		},
	}
	r := New([]Driver{d}, WithClock(fixedNow)).Collect(context.Background(), enabled()).Runtimes[0]
	if len(r.Workloads) != MaxWorkloadsPerRuntime || r.Complete {
		t.Fatalf("cap not enforced: len=%d complete=%v", len(r.Workloads), r.Complete)
	}
	if r.ObservedCount < len(many) || *r.Error != "line1 line2" {
		t.Fatalf("observed=%d error=%q", r.ObservedCount, *r.Error)
	}
	d.collect = func(context.Context, Detection) Result { return Result{Collection: "weird"} }
	if r := New([]Driver{d}, WithClock(fixedNow)).Collect(context.Background(), enabled()).Runtimes[0]; r.Collection != CollectionError {
		t.Fatalf("invalid collection state not coerced: %+v", r)
	}
}

func TestFailedCollectionNeverCarriesWorkloads(t *testing.T) {
	d := &stubDriver{
		rt:     RuntimeDocker,
		detect: func(context.Context) Detection { return Detection{State: DetectionPresent} },
		collect: func(context.Context, Detection) Result {
			return Result{Collection: CollectionUnavailable, Workloads: []Workload{wl("stale")}, Error: "daemon_unreachable"}
		},
	}
	r := New([]Driver{d}, WithClock(fixedNow)).Collect(context.Background(), enabled()).Runtimes[0]
	if len(r.Workloads) != 0 || r.ObservedCount != 0 || r.Complete {
		t.Fatalf("runtime = %+v", r)
	}
}

func TestFitPayloadKeepsReportUnderTheBodyLimit(t *testing.T) {
	big := func(rt Runtime, n int) RuntimeReport {
		ws := make([]Workload, n)
		for i := range ws {
			ws[i] = wl(strings.Repeat("z", 100) + string(rune('A'+i%26)))
			ws[i].Name = strings.Repeat("n", 250)
		}
		return RuntimeReport{Runtime: rt, Detection: DetectionPresent, Collection: CollectionOK, Complete: true, Workloads: ws, ObservedCount: n}
	}
	r := &Report{ProtocolVersion: 1, CollectedAt: "2026-10-06T12:00:00Z", Runtimes: []RuntimeReport{big(RuntimeDocker, 1000), big(RuntimePodman, 100)}}
	r.fitPayload(200_000)
	raw, _ := json.Marshal(r)
	if len(raw) > 200_000 {
		t.Fatalf("payload = %d bytes", len(raw))
	}
	if r.Runtimes[0].Complete || len(r.Runtimes[0].Workloads) >= 1000 {
		t.Fatal("largest runtime must be trimmed and marked incomplete")
	}
	if len(r.Runtimes[1].Workloads) == 0 {
		t.Fatal("the smaller runtime should not be emptied")
	}
	if r.Runtimes[0].ObservedCount != 1000 {
		t.Fatal("observedCount must keep the true count")
	}
}

func TestHashIgnoresCollectedAtAndOrderButNotContent(t *testing.T) {
	mk := func(at string, ids ...string) *Report {
		var ws []Workload
		for _, id := range ids {
			ws = append(ws, wl(id))
		}
		return &Report{ProtocolVersion: 1, CollectedAt: at, Runtimes: []RuntimeReport{
			{Runtime: RuntimePodman, Detection: DetectionAbsent, Collection: CollectionUnavailable, Complete: true, Workloads: []Workload{}},
			{Runtime: RuntimeDocker, Detection: DetectionPresent, Collection: CollectionOK, Complete: true, Workloads: ws},
		}}
	}
	base := mk("2026-10-06T12:00:00Z", "a", "b")
	if base.Hash() != mk("2026-10-06T13:00:00Z", "b", "a").Hash() {
		t.Fatal("hash must ignore collectedAt, runtime order and workload order")
	}
	if base.Hash() == mk("2026-10-06T12:00:00Z", "a", "b", "c").Hash() {
		t.Fatal("added workload must change the hash")
	}
	changed := mk("2026-10-06T12:00:00Z", "a", "b")
	changed.Runtimes[1].Workloads[0].State = StateStopped
	if base.Hash() == changed.Hash() {
		t.Fatal("state change must change the hash")
	}
	status := mk("2026-10-06T12:00:00Z", "a", "b")
	status.Runtimes[1].Complete = false
	if base.Hash() == status.Hash() {
		t.Fatal("completeness change must change the hash")
	}
	status = mk("2026-10-06T12:00:00Z", "a", "b")
	status.Runtimes[1].Collection = CollectionDisabled
	if base.Hash() == status.Hash() {
		t.Fatal("collection change must change the hash")
	}
	// Hash must not reorder the caller's slices.
	if base.Runtimes[0].Runtime != RuntimePodman {
		t.Fatal("Hash mutated the report")
	}
}
```

- [ ] **Step 2: Run and watch it fail.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestCollector|TestFailedCollection|TestFitPayload|TestHash'
```

Expected: FAIL, build error `undefined: New` / `undefined: Collector`.

- [ ] **Step 3: Implement.**

```go
// agent/internal/collectors/workloads/collector.go
package workloads

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
)

// DriverTimeout bounds one driver's Detect and, separately, its Collect.
const DriverTimeout = 30 * time.Second

// collectedAtLayout is RFC 3339 in UTC with millisecond precision. The API skips
// a report whose collectedAt is not newer than the stored one, so two reports in
// the same second (a settings change right after a send) must still order.
const collectedAtLayout = "2006-01-02T15:04:05.000Z"

// Collector runs every driver: Detect always, Collect only for runtimes the
// settings enable.
type Collector struct {
	drivers []Driver
	now     func() time.Time
	timeout time.Duration
}

// Option customizes a Collector (tests only).
type Option func(*Collector)

// WithClock replaces the clock used for Report.CollectedAt.
func WithClock(now func() time.Time) Option { return func(c *Collector) { c.now = now } }

// WithDriverTimeout replaces DriverTimeout.
func WithDriverTimeout(d time.Duration) Option { return func(c *Collector) { c.timeout = d } }

// New returns a Collector over drivers; pass DefaultDrivers() in production.
func New(drivers []Driver, opts ...Option) *Collector {
	c := &Collector{drivers: drivers, now: time.Now, timeout: DriverTimeout}
	for _, o := range opts {
		o(c)
	}
	return c
}

// HasDrivers reports whether this OS can host any workload runtime at all.
func (c *Collector) HasDrivers() bool { return len(c.drivers) > 0 }

// Collect produces one report. It returns nil when there are no drivers. A
// panicking driver degrades only its own runtime.
func (c *Collector) Collect(ctx context.Context, s Settings) *Report {
	if len(c.drivers) == 0 {
		return nil
	}
	report := &Report{
		ProtocolVersion: ProtocolVersion,
		CollectedAt:     c.now().UTC().Format(collectedAtLayout),
		Runtimes:        make([]RuntimeReport, 0, len(c.drivers)),
	}
	for _, d := range c.drivers {
		if ctx.Err() != nil {
			return nil
		}
		report.Runtimes = append(report.Runtimes, c.collectOne(ctx, d, s))
	}
	report.fitPayload(MaxPayloadBytes)
	return report
}

func (c *Collector) collectOne(ctx context.Context, d Driver, s Settings) RuntimeReport {
	rt := d.Runtime()
	dctx, cancel := context.WithTimeout(ctx, c.timeout)
	det, err := collectors.Guard("workloads.detect."+string(rt), func() (Detection, error) {
		return d.Detect(dctx), nil
	})
	cancel()
	if err != nil {
		det = Detection{State: DetectionUnknown, Reason: ReasonPanic}
	}
	rep := RuntimeReport{
		Runtime:        rt,
		Detection:      normalizeDetection(det.State),
		RuntimeVersion: strp(clip(det.Version, 64)),
		Workloads:      []Workload{},
	}
	switch rep.Detection {
	case DetectionAbsent:
		rep.Collection, rep.Complete = CollectionUnavailable, true
		rep.RuntimeVersion = nil
	case DetectionUnknown:
		rep.Collection = CollectionUnavailable
		rep.Error = strp(sanitizeError(det.Reason))
	default:
		if !s.RuntimeEnabled(rt) {
			rep.Collection, rep.Complete = CollectionDisabled, true
			return rep
		}
		cctx, ccancel := context.WithTimeout(ctx, c.timeout)
		res, cerr := collectors.Guard("workloads.collect."+string(rt), func() (Result, error) {
			return d.Collect(cctx, det), nil
		})
		ccancel()
		if cerr != nil {
			res = Result{Collection: CollectionError, Error: ReasonPanic}
		}
		fillFromResult(&rep, res)
	}
	return rep
}

func normalizeDetection(state string) string {
	switch state {
	case DetectionPresent, DetectionAbsent, DetectionUnknown:
		return state
	}
	return DetectionUnknown
}

func fillFromResult(rep *RuntimeReport, res Result) {
	switch res.Collection {
	case CollectionOK, CollectionUnavailable, CollectionPermissionDenied, CollectionError, CollectionUnsupported:
		rep.Collection = res.Collection
	default:
		rep.Collection, res.Error = CollectionError, "invalid_collection_state"
	}
	rep.Complete = res.Complete
	rep.Error = strp(sanitizeError(res.Error))
	if rep.Collection != CollectionOK {
		// The server ignores workloads of a failed collection; sending none keeps
		// a failed driver from ever looking like an empty host.
		return
	}
	ws := res.Workloads
	rep.ObservedCount = res.ObservedCount
	if rep.ObservedCount < len(ws) {
		rep.ObservedCount = len(ws)
	}
	if len(ws) > MaxWorkloadsPerRuntime {
		ws, rep.Complete = ws[:MaxWorkloadsPerRuntime], false
	}
	rep.Workloads = make([]Workload, len(ws))
	copy(rep.Workloads, ws)
	for i := range rep.Workloads {
		rep.Workloads[i].Bound()
	}
}

func sanitizeError(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	return clip(strings.TrimSpace(s), MaxErrorLen)
}

// fitPayload trims workloads until the serialized report fits maxBytes, taking
// from whichever runtime currently reports the most, and marks it incomplete.
// Workloads are already ordered most-relevant first, so the tail goes first.
func (r *Report) fitPayload(maxBytes int) {
	for {
		raw, err := json.Marshal(r)
		if err != nil || len(raw) <= maxBytes {
			return
		}
		largest := -1
		for i := range r.Runtimes {
			if len(r.Runtimes[i].Workloads) > 0 && (largest < 0 || len(r.Runtimes[i].Workloads) > len(r.Runtimes[largest].Workloads)) {
				largest = i
			}
		}
		if largest < 0 {
			return
		}
		rr := &r.Runtimes[largest]
		keep := len(rr.Workloads) * 9 / 10
		rr.Workloads = rr.Workloads[:keep:keep]
		rr.Complete = false
	}
}

// Hash is a stable digest of everything in the report except CollectedAt.
// Runtimes and workloads are sorted so driver ordering never changes it. The
// agent sends when the hash differs from the last accepted report; because the
// digest covers detection, collection, completeness, version, counts and the
// error code, any status change is a hash change.
func (r *Report) Hash() string {
	canon := Report{ProtocolVersion: r.ProtocolVersion, Runtimes: make([]RuntimeReport, len(r.Runtimes))}
	for i, rt := range r.Runtimes {
		rt.Workloads = append([]Workload(nil), rt.Workloads...)
		sort.Slice(rt.Workloads, func(a, b int) bool { return rt.Workloads[a].WorkloadID < rt.Workloads[b].WorkloadID })
		canon.Runtimes[i] = rt
	}
	sort.Slice(canon.Runtimes, func(a, b int) bool { return canon.Runtimes[a].Runtime < canon.Runtimes[b].Runtime })
	raw, _ := json.Marshal(canon)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
```

- [ ] **Step 4: Run.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestCollector|TestFailedCollection|TestFitPayload|TestHash'
```

Expected: PASS (9 tests). Two `recovered panic` log lines are expected output of the panic tests.

- [ ] **Step 5: Commit.**

```bash
git add agent/internal/collectors/workloads/collector.go agent/internal/collectors/workloads/collector_test.go
git commit -m "feat(agent): workload collector orchestration and canonical hash

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Heartbeat wiring — settings, own loop, change-only send, capability

**Files:**
- Create: `agent/internal/heartbeat/workloads_test.go`
- Create: `agent/internal/heartbeat/workloads.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` (seven small hunks below)

**Interfaces (produced):**

```go
type workloadsCollector interface {
	HasDrivers() bool
	Collect(ctx context.Context, s workloads.Settings) *workloads.Report
}
type workloadsRuntime struct { /* col, ctx, cancel, wake, started, stopping, settings, generation, lastHash, lastSent */ }
type workloadsUpload struct{ ctx context.Context; data any } // MarshalJSON passes data through
func parseWorkloadSettings(raw any) (workloads.Settings, bool)
func (h *Heartbeat) initWorkloads()
func (h *Heartbeat) applyWorkloadInventoryConfig(raw any)
func (h *Heartbeat) startWorkloads()
func (h *Heartbeat) stopWorkloads()
func (h *Heartbeat) runWorkloads(r *workloadsRuntime)
func (h *Heartbeat) workloadsCycle(r *workloadsRuntime, now time.Time) time.Duration
func workloadsShouldSend(prevHash, hash string, lastSent, now time.Time) bool
func workloadsFirstDelay(id string) time.Duration
func workloadsInterval(id string, interval time.Duration, last time.Time) time.Duration
// heartbeat.go:
type SecurityCapabilities struct{ /* ... */ WorkloadInventoryProtocolVersion int `json:"workloadInventoryProtocolVersion,omitempty"` }
```

Design notes for the reviewer:
- The parser accepts the wire's snake_case keys (`enabled`, `docker_enabled`, `podman_enabled`, `hyperv_enabled`, `proxmox_enabled`, `interval_minutes`) and camelCase equivalents; `TestParseWorkloadSettings` and `TestApplyConfigUpdateDispatchesWorkloadSettings` exercise both.
- One goroutine owns `lastHash`/`lastSent`, so the hash needs no lock; `settings`, `generation`, `started` and `stopping` are protected by `Heartbeat.mu`, the same rule the time-sync worker uses.
- `workloadsCycle` reads `generation` before collecting and compares after. A mismatch discards the report and returns `0` (immediate re-run). A report made under stale settings is never hashed or sent.
- A `wake` token that predates a cycle is drained at the start of that cycle, because the cycle already uses the settings the token announced.
- A failed send returns `min(next, 10 min)`; the hash and `lastSent` stay untouched.

- [ ] **Step 1: Write the failing tests.**

```go
// agent/internal/heartbeat/workloads_test.go
package heartbeat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/workloads"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

type fakeWorkloadsCollector struct {
	mu      sync.Mutex
	calls   int
	collect func(ctx context.Context, s workloads.Settings) *workloads.Report
}

func (f *fakeWorkloadsCollector) HasDrivers() bool { return true }
func (f *fakeWorkloadsCollector) Collect(ctx context.Context, s workloads.Settings) *workloads.Report {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return f.collect(ctx, s)
}

func workloadsReport(ids ...string) *workloads.Report {
	ws := []workloads.Workload{}
	for _, id := range ids {
		ws = append(ws, workloads.Workload{WorkloadID: id, Kind: workloads.KindContainer, Name: id, State: workloads.StateRunning})
	}
	return &workloads.Report{ProtocolVersion: 1, CollectedAt: "2026-10-06T12:00:00Z", Runtimes: []workloads.RuntimeReport{{
		Runtime: workloads.RuntimeDocker, Detection: workloads.DetectionPresent, Collection: workloads.CollectionOK,
		Complete: true, ObservedCount: len(ws), Workloads: ws,
	}}}
}

type workloadsTransport func(*http.Request) (*http.Response, error)

func (f workloadsTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type sentRequest struct {
	method, path, contentType string
	body                      []byte
}

// newWorkloadsHeartbeat wires a Heartbeat to a fake collector and a transport
// that records requests and answers with statuses[i] (200 once exhausted).
func newWorkloadsHeartbeat(t *testing.T, col *fakeWorkloadsCollector, statuses ...int) (*Heartbeat, *workloadsRuntime, *[]sentRequest) {
	t.Helper()
	cfg := config.Default()
	cfg.AgentID = "fixture-agent"
	cfg.ServerURL = "https://workloads.example.com"
	cfg.AuthToken = "fixture-token"
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	r := &workloadsRuntime{col: col, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), settings: workloads.DefaultSettings()}
	h := &Heartbeat{config: cfg, agentVersion: "fixture-version", retryCfg: httputil.DefaultRetryConfig(), workloads: r}
	h.retryCfg.MaxRetries = 0
	var mu sync.Mutex
	var sent []sentRequest
	h.client = &http.Client{Transport: workloadsTransport(func(req *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(req.Body)
		mu.Lock()
		sent = append(sent, sentRequest{req.Method, req.URL.Path, req.Header.Get("Content-Type"), body})
		n := len(sent)
		mu.Unlock()
		status := 200
		if n <= len(statuses) {
			status = statuses[n-1]
		}
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"accepted":true}`))}, nil
	})}
	return h, r, &sent
}

func fixedCollector(ids ...string) *fakeWorkloadsCollector {
	return &fakeWorkloadsCollector{collect: func(context.Context, workloads.Settings) *workloads.Report { return workloadsReport(ids...) }}
}

func TestParseWorkloadSettings(t *testing.T) {
	good := func(m map[string]any) workloads.Settings {
		t.Helper()
		s, ok := parseWorkloadSettings(m)
		if !ok {
			t.Fatalf("rejected %v", m)
		}
		return s
	}
	snake := good(map[string]any{"enabled": true, "docker_enabled": true, "podman_enabled": false, "hyperv_enabled": true, "proxmox_enabled": false, "interval_minutes": 30.0})
	camel := good(map[string]any{"enabled": true, "dockerEnabled": true, "podmanEnabled": false, "hypervEnabled": true, "proxmoxEnabled": false, "intervalMinutes": 30})
	want := workloads.Settings{Enabled: true, Docker: true, Podman: false, HyperV: true, Proxmox: false, IntervalMinutes: 30}
	if snake != want || camel != want {
		t.Fatalf("snake=%+v camel=%+v want=%+v", snake, camel, want)
	}
	if s := good(map[string]any{"enabled": false, "interval_minutes": 60.0}); !s.Docker || !s.Podman || !s.HyperV || !s.Proxmox {
		t.Fatalf("missing runtime switches must default to true: %+v", s)
	}
	for name, m := range map[string]any{
		"not an object":      "x",
		"missing enabled":    map[string]any{"interval_minutes": 60.0},
		"enabled not bool":   map[string]any{"enabled": "yes", "interval_minutes": 60.0},
		"missing interval":   map[string]any{"enabled": true},
		"interval too small": map[string]any{"enabled": true, "interval_minutes": 14.0},
		"interval too large": map[string]any{"enabled": true, "interval_minutes": 1441.0},
		"fractional":         map[string]any{"enabled": true, "interval_minutes": 30.5},
		"interval string":    map[string]any{"enabled": true, "interval_minutes": "60"},
		"switch not bool":    map[string]any{"enabled": true, "interval_minutes": 60.0, "docker_enabled": "no"},
	} {
		if _, ok := parseWorkloadSettings(m); ok {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestApplyWorkloadInventoryConfig(t *testing.T) {
	h, r, _ := newWorkloadsHeartbeat(t, fixedCollector())
	if r.settings.Enabled {
		t.Fatal("collection must be off until a policy enables it")
	}
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 15.0})
	if !r.settings.Enabled || r.generation != 1 || len(r.wake) != 1 {
		t.Fatalf("settings=%+v generation=%d wake=%d", r.settings, r.generation, len(r.wake))
	}
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 15.0}) // identical
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": "garbage"})                      // invalid
	if r.generation != 1 || r.settings.IntervalMinutes != 15 {
		t.Fatalf("repeat or invalid payload changed state: generation=%d settings=%+v", r.generation, r.settings)
	}
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": false, "interval_minutes": 15.0})
	if r.settings.Enabled || r.generation != 2 {
		t.Fatalf("disable not applied: %+v generation=%d", r.settings, r.generation)
	}
}

// The key sits above the policy-probe early return in applyConfigUpdate; a
// heartbeat that carries only this key must still reach the handler.
func TestApplyConfigUpdateDispatchesWorkloadSettings(t *testing.T) {
	for _, key := range []string{"workload_inventory_settings", "workloadInventorySettings"} {
		h, r, _ := newWorkloadsHeartbeat(t, fixedCollector())
		h.applyConfigUpdate(map[string]any{key: map[string]any{"enabled": true, "interval_minutes": 60.0}})
		if !r.settings.Enabled {
			t.Fatalf("%s did not reach applyWorkloadInventoryConfig", key)
		}
	}
}

func TestWorkloadsCycleSendsToTheContractEndpoint(t *testing.T) {
	h, r, sent := newWorkloadsHeartbeat(t, fixedCollector("a"))
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 60.0})
	next := h.workloadsCycle(r, time.Now())
	if len(*sent) != 1 {
		t.Fatalf("requests = %d", len(*sent))
	}
	req := (*sent)[0]
	if req.method != "PUT" || req.path != "/api/v1/agents/fixture-agent/workloads" || req.contentType != "application/json" {
		t.Fatalf("request = %+v", req)
	}
	var body map[string]any
	if err := json.Unmarshal(req.body, &body); err != nil {
		t.Fatal(err)
	}
	if body["protocolVersion"] != float64(1) || body["runtimes"] == nil {
		t.Fatalf("body = %s", req.body)
	}
	if next < 54*time.Minute || next > 66*time.Minute {
		t.Fatalf("next = %v, want 60 min +-10%%", next)
	}
}

func TestWorkloadsCycleIsChangeOnlyWithKeepalive(t *testing.T) {
	ids := []string{"a"}
	col := &fakeWorkloadsCollector{collect: func(context.Context, workloads.Settings) *workloads.Report { return workloadsReport(ids...) }}
	h, r, sent := newWorkloadsHeartbeat(t, col)
	now := time.Now()
	h.workloadsCycle(r, now)
	h.workloadsCycle(r, now.Add(time.Hour))
	if len(*sent) != 1 {
		t.Fatalf("unchanged report was resent: %d requests", len(*sent))
	}
	ids = []string{"a", "b"}
	h.workloadsCycle(r, now.Add(2*time.Hour))
	if len(*sent) != 2 {
		t.Fatalf("changed report not sent: %d requests", len(*sent))
	}
	h.workloadsCycle(r, now.Add(2*time.Hour+workloadsKeepalive-time.Minute))
	if len(*sent) != 2 {
		t.Fatal("keepalive fired early")
	}
	h.workloadsCycle(r, now.Add(2*time.Hour+workloadsKeepalive))
	if len(*sent) != 3 {
		t.Fatalf("keepalive not sent: %d requests", len(*sent))
	}
}

func TestWorkloadsFailedSendDoesNotAdvanceHash(t *testing.T) {
	h, r, sent := newWorkloadsHeartbeat(t, fixedCollector("a"), 503, 400)
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 1440.0})
	now := time.Now()
	next := h.workloadsCycle(r, now)
	if r.lastHash != "" || !r.lastSent.IsZero() {
		t.Fatal("hash advanced after a 503")
	}
	if next != workloadsRetryDelay {
		t.Fatalf("retry delay = %v, want %v even on a 24 h interval", next, workloadsRetryDelay)
	}
	h.workloadsCycle(r, now.Add(time.Minute)) // 400: permanent rejection, still not advanced
	if r.lastHash != "" || len(*sent) != 2 {
		t.Fatalf("hash=%q requests=%d after a 400", r.lastHash, len(*sent))
	}
	h.workloadsCycle(r, now.Add(2*time.Minute)) // 200
	if r.lastHash == "" || len(*sent) != 3 {
		t.Fatalf("hash=%q requests=%d after success", r.lastHash, len(*sent))
	}
	h.workloadsCycle(r, now.Add(3*time.Minute))
	if len(*sent) != 3 {
		t.Fatal("accepted report was resent")
	}
}

func TestWorkloadsSettingsChangeMidCollectionDiscardsResult(t *testing.T) {
	var h *Heartbeat
	changed := false
	col := &fakeWorkloadsCollector{}
	col.collect = func(_ context.Context, s workloads.Settings) *workloads.Report {
		if !changed {
			changed = true
			h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "docker_enabled": false, "interval_minutes": 60.0})
		}
		return workloadsReport("stale-under-old-settings")
	}
	var r *workloadsRuntime
	var sent *[]sentRequest
	h, r, sent = newWorkloadsHeartbeat(t, col)
	next := h.workloadsCycle(r, time.Now())
	if len(*sent) != 0 || r.lastHash != "" {
		t.Fatalf("a report made under stale settings was sent: %d requests", len(*sent))
	}
	if next != 0 {
		t.Fatalf("next = %v, want an immediate re-run", next)
	}
	h.workloadsCycle(r, time.Now())
	if len(*sent) != 1 || col.calls != 2 {
		t.Fatalf("re-run under new settings: requests=%d collects=%d", len(*sent), col.calls)
	}
}

func TestWorkloadsDisabledStateIsStillReported(t *testing.T) {
	col := &fakeWorkloadsCollector{collect: func(_ context.Context, s workloads.Settings) *workloads.Report {
		rep := workloadsReport()
		if !s.Enabled {
			rep.Runtimes[0].Collection = workloads.CollectionDisabled
		}
		return rep
	}}
	h, r, sent := newWorkloadsHeartbeat(t, col)
	h.workloadsCycle(r, time.Now()) // default settings: Enabled=false
	if len(*sent) != 1 || !strings.Contains(string((*sent)[0].body), `"collection":"disabled"`) {
		t.Fatalf("detection-only report not sent: %d requests", len(*sent))
	}
}

func TestWorkloadsNilReportSendsNothing(t *testing.T) {
	col := &fakeWorkloadsCollector{collect: func(context.Context, workloads.Settings) *workloads.Report { return nil }}
	h, r, sent := newWorkloadsHeartbeat(t, col)
	if next := h.workloadsCycle(r, time.Now()); next <= 0 || len(*sent) != 0 {
		t.Fatalf("next=%v requests=%d", next, len(*sent))
	}
}

func TestWorkloadsStopCancelsInFlightUpload(t *testing.T) {
	entered := make(chan struct{})
	h, r, _ := newWorkloadsHeartbeat(t, fixedCollector("a"))
	h.client = &http.Client{Transport: workloadsTransport(func(req *http.Request) (*http.Response, error) {
		close(entered)
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	h.inventoryWg.Add(1)
	go func() {
		defer h.inventoryWg.Done()
		h.workloadsCycle(r, time.Now())
	}()
	<-entered
	h.stopWorkloads()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("upload ignored shutdown")
	}
	if r.lastHash != "" {
		t.Fatal("cancelled upload advanced the hash")
	}
}

func TestWorkloadsLoopIsTrackedAndStops(t *testing.T) {
	h, r, _ := newWorkloadsHeartbeat(t, fixedCollector())
	h.startWorkloads()
	h.startWorkloads() // idempotent
	if !r.started {
		t.Fatal("not started")
	}
	h.stopWorkloads()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("worker goroutine leaked past stop")
	}
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 60.0})
	if r.settings.Enabled {
		t.Fatal("settings applied after stop")
	}
}

func TestWorkloadsWithoutRuntimeIsInert(t *testing.T) {
	h := &Heartbeat{} // an OS with no drivers never builds the runtime
	h.startWorkloads()
	h.stopWorkloads()
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 60.0})
}

func TestWorkloadsScheduleBounds(t *testing.T) {
	d := workloadsFirstDelay("agent-1")
	if d < time.Minute || d > 2*time.Minute {
		t.Fatalf("first delay = %v", d)
	}
	if workloadsFirstDelay("agent-1") != d || workloadsFirstDelay("agent-2") == d {
		t.Log("first delay is deterministic per agent id (a collision between two ids is possible but unlikely)")
	}
	for i := 0; i < 50; i++ {
		got := workloadsInterval("agent-1", 15*time.Minute, time.Unix(int64(i), 0))
		if got < 13*time.Minute+30*time.Second || got > 16*time.Minute+30*time.Second {
			t.Fatalf("interval = %v", got)
		}
	}
}

func TestHeartbeatDeclaresWorkloadInventoryCapability(t *testing.T) {
	caps := compiledSecurityCapabilities()
	if caps.WorkloadInventoryProtocolVersion != 1 {
		t.Fatalf("WorkloadInventoryProtocolVersion = %d, want 1", caps.WorkloadInventoryProtocolVersion)
	}
	body, err := json.Marshal(HeartbeatPayload{SecurityCapabilities: caps})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		SecurityCapabilities map[string]any `json:"securityCapabilities"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if v, ok := decoded.SecurityCapabilities["workloadInventoryProtocolVersion"]; !ok || v != float64(1) {
		t.Fatalf("capabilities on the wire = %v", decoded.SecurityCapabilities)
	}
}
```

- [ ] **Step 2: Run and watch it fail.**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'Workload'
```

Expected: FAIL, build error `undefined: workloadsRuntime` / `undefined: parseWorkloadSettings` / `h.workloads undefined`.

- [ ] **Step 3: Implement the worker.**

```go
// agent/internal/heartbeat/workloads.go
package heartbeat

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"math"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/workloads"
	"github.com/breeze-rmm/agent/internal/observability"
)

const (
	// workloadsKeepalive forces a send even when nothing changed, so the API's
	// "last seen" stays fresh for hosts whose workloads are static.
	workloadsKeepalive = 6 * time.Hour
	// workloadsRetryDelay is how soon a failed send is retried (never later than
	// the normal interval).
	workloadsRetryDelay = 10 * time.Minute
)

// workloadsCollector is the heartbeat's view of workloads.Collector; tests
// substitute a fake.
type workloadsCollector interface {
	HasDrivers() bool
	Collect(ctx context.Context, s workloads.Settings) *workloads.Report
}

// workloadsRuntime owns the one inventory worker. Fields marked "mu" are
// protected by Heartbeat.mu; the hash fields belong to the worker goroutine.
type workloadsRuntime struct {
	col    workloadsCollector
	ctx    context.Context
	cancel context.CancelFunc
	wake   chan struct{}

	started    bool               // mu
	stopping   bool               // mu
	settings   workloads.Settings // mu
	generation uint64             // mu; bumped on every accepted settings change

	lastHash string    // worker only; advanced only after a 2xx
	lastSent time.Time // worker only
}

// workloadsUpload carries the worker's context to sendInventoryData while
// serializing exactly as the report it wraps.
type workloadsUpload struct {
	ctx  context.Context
	data any
}

func (p workloadsUpload) MarshalJSON() ([]byte, error) { return json.Marshal(p.data) }

func (h *Heartbeat) initWorkloads() {
	col := workloads.New(workloads.DefaultDrivers())
	if !col.HasDrivers() {
		return // this OS cannot host a workload runtime we know about
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.workloads = &workloadsRuntime{
		col: col, ctx: ctx, cancel: cancel,
		wake:     make(chan struct{}, 1),
		settings: workloads.DefaultSettings(), // Enabled=false until a policy says otherwise
	}
}

// parseWorkloadSettings reads workload_inventory_settings in snake_case or
// camelCase. `enabled` and a valid 15..1440 interval are required; a missing
// per-runtime switch defaults to true (the column default), a non-boolean one
// invalidates the payload.
func parseWorkloadSettings(raw any) (workloads.Settings, bool) {
	m, ok := raw.(map[string]any)
	if !ok {
		return workloads.Settings{}, false
	}
	enabled, ok := m["enabled"].(bool)
	if !ok {
		return workloads.Settings{}, false
	}
	pick := func(snake, camel string) (any, bool) {
		if v, exists := m[snake]; exists {
			return v, true
		}
		v, exists := m[camel]
		return v, exists
	}
	flag := func(snake, camel string) (bool, bool) {
		v, exists := pick(snake, camel)
		if !exists {
			return true, true
		}
		b, ok := v.(bool)
		return b, ok
	}
	s := workloads.Settings{Enabled: enabled}
	var okDocker, okPodman, okHyperV, okProxmox bool
	s.Docker, okDocker = flag("docker_enabled", "dockerEnabled")
	s.Podman, okPodman = flag("podman_enabled", "podmanEnabled")
	s.HyperV, okHyperV = flag("hyperv_enabled", "hypervEnabled")
	s.Proxmox, okProxmox = flag("proxmox_enabled", "proxmoxEnabled")
	if !okDocker || !okPodman || !okHyperV || !okProxmox {
		return workloads.Settings{}, false
	}
	v, exists := pick("interval_minutes", "intervalMinutes")
	if !exists {
		return workloads.Settings{}, false
	}
	var minutes int
	switch n := v.(type) {
	case int:
		minutes = n
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) {
			return workloads.Settings{}, false
		}
		minutes = int(n)
	default:
		return workloads.Settings{}, false
	}
	if minutes < 15 || minutes > 1440 {
		return workloads.Settings{}, false
	}
	s.IntervalMinutes = minutes
	return s, true
}

// applyWorkloadInventoryConfig applies a workload_inventory_settings /
// workloadInventorySettings config update. An invalid payload is ignored and
// the previous settings stay in force. A real change bumps the generation so a
// collection already in flight is discarded, and wakes the worker.
func (h *Heartbeat) applyWorkloadInventoryConfig(raw any) {
	s, ok := parseWorkloadSettings(raw)
	if !ok {
		log.Warn("ignoring invalid workload_inventory_settings")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.workloads
	if r == nil || r.stopping || r.settings == s {
		return
	}
	r.settings = s
	r.generation++
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func workloadsHash(id string, last time.Time) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(id + ":workloads:" + strconv.FormatInt(last.UnixNano(), 10)))
	return h.Sum64()
}

// workloadsFirstDelay keeps the first cycle off the boot path and spreads a
// fleet that booted together over a minute: 60 s plus up to 60 s.
func workloadsFirstDelay(id string) time.Duration {
	return time.Minute + time.Duration(workloadsHash(id, time.Time{})%uint64(time.Minute+1))
}

// workloadsInterval jitters the configured interval by up to ±10%,
// deterministically from the agent id and the last run.
func workloadsInterval(id string, interval time.Duration, last time.Time) time.Duration {
	offset := int64(workloadsHash(id, last)%20001) - 10000
	return interval + time.Duration(int64(interval)*offset/100000)
}

// workloadsShouldSend is the change-only rule: send the first report, any
// report whose hash differs from the last accepted one, and a keepalive.
func workloadsShouldSend(prevHash, hash string, lastSent, now time.Time) bool {
	return prevHash == "" || prevHash != hash || now.Sub(lastSent) >= workloadsKeepalive
}

func (h *Heartbeat) startWorkloads() {
	h.mu.Lock()
	r := h.workloads
	if r == nil || r.started || r.stopping {
		h.mu.Unlock()
		return
	}
	r.started = true
	h.inventoryWg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.inventoryWg.Done()
		defer observability.Recoverer("heartbeat.workloads")
		h.runWorkloads(r)
	}()
}

// stopWorkloads cancels any in-flight collection or upload and prevents new
// cycles. It must run before inventoryWg.Wait so a blocked cycle unblocks.
func (h *Heartbeat) stopWorkloads() {
	h.mu.Lock()
	r := h.workloads
	if r != nil {
		r.stopping = true
	}
	h.mu.Unlock()
	if r != nil {
		r.cancel()
	}
}

func (h *Heartbeat) runWorkloads(r *workloadsRuntime) {
	timer := time.NewTimer(workloadsFirstDelay(h.config.AgentID))
	defer timer.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-timer.C:
		case <-r.wake:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		if r.ctx.Err() != nil {
			return
		}
		timer.Reset(h.workloadsCycle(r, time.Now()))
	}
}

// workloadsCycle runs one collect-and-maybe-send cycle and returns how long to
// wait before the next one.
//
//   - The settings generation is read before collecting and compared after; a
//     change in between discards the result and re-runs immediately, so a report
//     made under stale settings is never sent.
//   - The hash advances only after sendInventoryData returns nil (a 2xx). A
//     failed send leaves the old hash, so the next cycle sends again.
func (h *Heartbeat) workloadsCycle(r *workloadsRuntime, now time.Time) time.Duration {
	select { // a wake that predates this cycle is already satisfied by it
	case <-r.wake:
	default:
	}
	h.mu.Lock()
	generation, settings := r.generation, r.settings
	h.mu.Unlock()
	interval := time.Duration(settings.IntervalMinutes) * time.Minute
	next := workloadsInterval(h.config.AgentID, interval, now)

	report := r.col.Collect(r.ctx, settings)
	if report == nil {
		return next
	}
	h.mu.Lock()
	changed := r.generation != generation
	h.mu.Unlock()
	if changed {
		log.Debug("workload inventory settings changed during collection; discarding result")
		return 0
	}
	hash := report.Hash()
	if !workloadsShouldSend(r.lastHash, hash, r.lastSent, now) {
		return next
	}
	if err := h.sendInventoryData("workloads", workloadsUpload{ctx: r.ctx, data: report}, "workloads"); err != nil {
		log.Warn("workload inventory submission failed", "error", err)
		if next > workloadsRetryDelay {
			return workloadsRetryDelay
		}
		return next
	}
	r.lastHash, r.lastSent = hash, now
	return next
}
```

- [ ] **Step 4: Wire it into `heartbeat.go`.** Seven hunks; line numbers are current on `main` at plan time (re-grep each anchor, the file shifts).

1. Import (after `heartbeat.go:31`, alphabetical within the `collectors/...` group):

```go
	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"github.com/breeze-rmm/agent/internal/collectors/workloads"
```

2. `SecurityCapabilities` (`:279-281`): add the field before `PamReconciliation` and let `gofmt` realign the two neighbours.

```go
	ConsentPromptProtocolVersion int `json:"consentPromptProtocolVersion,omitempty"`
	// WorkloadInventoryProtocolVersion declares that this build speaks
	// protocol 1 of PUT /agents/{id}/workloads (container and VM inventory).
	// The API stores it non-sticky like the others so the device page can say
	// "agent too old" instead of "no data".
	WorkloadInventoryProtocolVersion int                      `json:"workloadInventoryProtocolVersion,omitempty"`
	PamReconciliation                *PamReconciliationStatus `json:"pamReconciliation,omitempty"`
```

3. `Heartbeat` struct (`:473`), after `timeSync`:

```go
	timeSync           *timeSyncRuntime
	workloads          *workloadsRuntime
```

4. `NewWithVersion` (`:1059`):

```go
	h.initTimeSync()
	h.initWorkloads()
```

5. `Start()` (`:1917`) and both shutdown paths (`DrainAndWait` `:2228`, `Stop` `:2250`):

```go
	h.startTimeSync()
	h.startWorkloads()
```

```go
	h.stopTimeSync()
	h.stopWorkloads()
```

6. `sendInventoryData` (`:2420-2424`), directly after the `time-status` override:

```go
	if endpoint == "workloads" {
		if upload, ok := payload.(workloadsUpload); ok && upload.ctx != nil {
			parent = upload.ctx
		}
	}
```

7. `applyConfigUpdate` (`:3288-3290`), directly after the time-sync block and **above** `policy_registry_state_probes` (`:3292`), whose branch returns unconditionally when neither probe key is present:

```go
	// Apply workload_inventory_settings. Same rule as warranty and time sync:
	// this must stay above the policy-probe early return or it never runs.
	wiRaw, hasWI := update["workload_inventory_settings"]
	if !hasWI {
		wiRaw, hasWI = update["workloadInventorySettings"]
	}
	if hasWI {
		h.applyWorkloadInventoryConfig(wiRaw)
	}
```

8. `compiledSecurityCapabilities` (`:8000`):

```go
		ConsentPromptProtocolVersion:     2,
		WorkloadInventoryProtocolVersion: workloads.ProtocolVersion,
```

Then `gofmt -w agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/workloads.go agent/internal/heartbeat/workloads_test.go` and confirm `gofmt -l` lists none of the three.

- [ ] **Step 5: Run the new tests and the whole package.**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'Workload'
cd agent && go test -race ./internal/heartbeat/...
```

Expected: PASS for both (14 workload tests). The full package run takes several minutes and catches any struct-literal or capability-contract test the new field disturbs.

- [ ] **Step 6: Prove the pinned behaviors can fail.** Two throwaway mutations, reverted immediately:

1. In `workloadsCycle`, move `r.lastHash, r.lastSent = hash, now` above the `sendInventoryData` call → `TestWorkloadsFailedSendDoesNotAdvanceHash` must FAIL.
2. In `workloadsCycle`, delete the `if changed { ... return 0 }` block → `TestWorkloadsSettingsChangeMidCollectionDiscardsResult` must FAIL.

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'TestWorkloadsFailedSendDoesNotAdvanceHash|TestWorkloadsSettingsChangeMidCollectionDiscardsResult'
```

Expected with a mutation applied: FAIL. After reverting: PASS. Do not commit a mutation.

- [ ] **Step 7: Commit.**

```bash
git add agent/internal/heartbeat/workloads.go agent/internal/heartbeat/workloads_test.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): workload inventory worker, settings delivery and capability

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Read-only source guard

**Files:**
- Create: `agent/internal/collectors/workloads/readonly_guard_test.go`

The transport (Task 3) makes mutation impossible for the engine socket. This test is the independent second line, and the one that also covers drivers added later: it scans every non-test `.go` file in the package and fails on a mutating HTTP verb, a mutating engine path, a Hyper-V/Proxmox mutating verb (`Start-VM`, `Stop-VM`, `pvesh create|set|delete`, `qm `, `pct `), an engine CLI mutation (`docker run`, …), any `http.NewRequest*` that is not `http.MethodGet`, and any `os/exec` import outside `execAllowedFiles` (empty in this wave).

- [ ] **Step 1: Write the guard.** It should pass on the current package; a guard that cannot fail is proved in Step 3.

```go
// agent/internal/collectors/workloads/readonly_guard_test.go
package workloads

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// forbiddenTokens are verbs and paths that would change state on a host. The
// package is read-only by construction (transport.go); this test is the
// second, independent line: it fails when someone adds a mutating call to any
// non-test source file of the package, whichever driver it is for.
var forbiddenTokens = []string{
	// HTTP verbs on the engine socket
	"http.MethodPost", "http.MethodPut", "http.MethodPatch", "http.MethodDelete",
	`"POST"`, `"PUT"`, `"PATCH"`, `"DELETE"`,
	// Docker / Podman mutating endpoints
	"/containers/create", "/start", "/stop", "/kill", "/restart", "/pause", "/unpause",
	"/remove", "/exec", "/prune", "/images/create", "/build", "/commit", "/rename",
	// Hyper-V
	"Start-VM", "Stop-VM", "Restart-VM", "Suspend-VM", "Resume-VM", "Remove-VM",
	"New-VM", "Set-VM", "Checkpoint-VM", "Restore-VMSnapshot", "Export-VM", "Import-VM",
	// Proxmox
	"pvesh create", "pvesh set", "pvesh delete", "pvesh put", "pvesh post",
	`"qm "`, `"pct "`, "`qm `", "`pct `",
	// engine CLIs (collection talks to the API, never the CLI)
	"docker run", "docker rm", "docker stop", "docker kill", "docker pull",
	"podman run", "podman rm", "podman stop", "podman pull",
}

// execAllowedFiles lists the source files allowed to import os/exec. This wave
// has none; a later driver adds its runner file here in the same change that
// adds the import, which makes the review of that change explicit.
var execAllowedFiles = map[string]bool{}

func packageSources(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		b, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatal(err)
		}
		out[name] = string(b)
	}
	if len(out) == 0 {
		t.Fatal("no source files found; the guard would pass vacuously")
	}
	return out
}

func TestPackageSourceHasNoMutatingVerbsOrPaths(t *testing.T) {
	for name, src := range packageSources(t) {
		for _, tok := range forbiddenTokens {
			if strings.Contains(src, tok) {
				t.Errorf("%s contains forbidden mutating token %q", name, tok)
			}
		}
	}
}

func TestPackageSourceOnlyBuildsGetRequests(t *testing.T) {
	newRequest := regexp.MustCompile(`http\.NewRequest(WithContext)?\(([^)]*)\)`)
	seen := 0
	for name, src := range packageSources(t) {
		for _, m := range newRequest.FindAllStringSubmatch(src, -1) {
			seen++
			if !strings.Contains(m[2], "http.MethodGet") {
				t.Errorf("%s builds a request that is not GET: %s", name, m[0])
			}
		}
	}
	if seen == 0 {
		t.Fatal("found no NewRequest call; the pattern needs updating or the guard is vacuous")
	}
}

func TestOnlyAllowlistedFilesImportOSExec(t *testing.T) {
	for name, src := range packageSources(t) {
		if strings.Contains(src, `"os/exec"`) && !execAllowedFiles[name] {
			t.Errorf("%s imports os/exec; add it to execAllowedFiles only with a read-only command allowlist", name)
		}
	}
}

// The guard must be able to fail: prove the token scan catches a planted verb.
func TestGuardDetectsAPlantedMutation(t *testing.T) {
	planted := `req, _ := http.NewRequest(http.MethodPost, "http://engine/containers/abc/start", nil)`
	hits := 0
	for _, tok := range forbiddenTokens {
		if strings.Contains(planted, tok) {
			hits++
		}
	}
	if hits < 2 {
		t.Fatalf("planted mutation matched %d forbidden tokens, want at least 2", hits)
	}
}
```

- [ ] **Step 2: Run it.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... -run 'TestPackageSource|TestOnlyAllowlisted|TestGuardDetects'
```

Expected: PASS (4 tests). It would FAIL if Tasks 3-4 contained a mutating token, which is the point of running it after them.

- [ ] **Step 3: Prove it can fail.** Append `// "POST"` to `agent/internal/collectors/workloads/docker.go`, rerun the command above, and expect FAIL with `docker.go contains forbidden mutating token "\"POST\""`. Revert the line and rerun to PASS. Do not commit the mutation.

- [ ] **Step 4: Run the whole package.**

```bash
cd agent && go test -race ./internal/collectors/workloads/...
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add agent/internal/collectors/workloads/readonly_guard_test.go
git commit -m "test(agent): source guard keeps workload collection read-only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Cross-compile check and lab gates L1 (Docker) and L4 (Podman)

**Files:** none (verification only; evidence goes in the PR description, with hostnames and device ids kept out).

This is a manual gate. It needs W01 merged and a local stack that runs it (`pnpm test-stack up` or `pnpm wt-stack up`), and one Linux VM per gate that is enrolled as a device against that stack. Do not run a second Breeze agent on a host that already has one installed; use a dedicated lab VM.

**Part A — cross-compile and package tests (no lab needed).**

- [ ] **Step 1: Build every OS the agent ships on.**

```bash
cd agent && GOOS=windows GOARCH=amd64 go build ./... && echo windows-ok
cd agent && GOOS=darwin GOARCH=arm64 go build ./... && echo darwin-ok
cd agent && GOOS=linux GOARCH=arm64 go build ./... && echo linux-arm64-ok
cd agent && GOOS=windows GOARCH=amd64 go vet ./internal/collectors/workloads/ ./internal/heartbeat/ && echo windows-vet-ok
```

Expected: `windows-ok`, `darwin-ok`, `linux-arm64-ok`, `windows-vet-ok`.

- [ ] **Step 2: Run the agent suite for the two touched trees.**

```bash
cd agent && go test -race ./internal/collectors/workloads/... ./internal/heartbeat/...
```

Expected: PASS.

**Part B — shared setup.**

Variables used below (private to the operator): `DEVICE_ID` is the lab VM's device id; `PG` is the local stack's Postgres container (`docker ps --format '{{.Names}}' | grep postgres`). The `breeze` superuser reads past RLS; the `set_config` line keeps the session in system scope in case the role is not a superuser. Run every query as:

```bash
q() { docker exec -i "$PG" psql -U breeze -d breeze -X -c "select set_config('breeze.scope','system',false)" -c "$1"; }
```

Policy: in the web UI create a configuration policy (partner-wide is fine) with the **Workload inventory** feature (W01), `enabled` on, Docker and Podman on, interval `15`, assigned to the lab device. Build and push the branch agent to the lab VM with `make dev-push` from `agent/` (see the `agent-log-debugging` skill; the device's platform is auto-detected), or install the branch binary by hand and restart the service.

Common checks after every enable or restart (the first cycle runs 60-120 s after the agent starts, then every ~15 min):

```bash
q "select hosts_workloads, workload_runtimes from devices where id = '$DEVICE_ID'"
q "select runtime, detection, collection, complete, runtime_version, observed_count, reported_count, last_error, collected_at from device_workload_runtimes where device_id = '$DEVICE_ID' order by runtime"
q "select runtime, kind, name, state, raw_state, image_repository, image_tag, left(image_digest, 19) as digest, compose_project, compose_service, restart_policy is null as restart_null, started_at is null as started_null from device_workloads where device_id = '$DEVICE_ID' order by name"
```

**Part C — L1: Linux Docker host (compose + bare + multi-arch + local build).**

- [ ] **L1-1. Create the workloads on the lab VM** (Docker Engine from the distribution or Docker's repository, then):

```bash
sudo mkdir -p /srv/shop && cd /srv/shop
sudo tee compose.yaml >/dev/null <<'EOF'
services:
  web:
    image: nginx:1.27
  cache:
    image: redis:7
EOF
sudo docker compose up -d
sudo docker run -d --name bare nginx:1.27
printf 'FROM busybox:1.36\nCMD ["sleep","3600"]\n' | sudo docker build -t localbuild:dev -
sudo docker run -d --name built localbuild:dev
sudo docker run -d --name paused-one busybox:1.36 sleep 3600 && sudo docker pause paused-one
sudo docker run --name stopped-one busybox:1.36 true
sudo docker run -d --name secretive -e API_KEY=lab-secret-value-123 -v /etc:/host-etc:ro busybox:1.36 sleep 3600
sudo docker events --filter type=container --format '{{.Time}} {{.Action}} {{.Actor.Attributes.name}}' > /tmp/docker-events.log &
```

Restart the agent (`sudo systemctl restart breeze-agent`) so the first cycle starts within two minutes.

- [ ] **L1-2. Expected rows** (after one cycle). `device_workload_runtimes`: `docker | present | ok | t | <engine version>`; `podman` and `containerd` have **no row** (absent runtimes are deleted); `devices.hosts_workloads = t`, `workload_runtimes = {docker}`. `device_workloads`: eight rows — `shop-web-1` (running, `docker.io/library/nginx`, tag `1.27`, project `shop`, service `web`), `shop-cache-1` (running, `docker.io/library/redis`, tag `7`), `bare` (same repository, tag and digest as `shop-web-1`), `built` (running, `docker.io/library/localbuild`, tag `dev`, **digest NULL**), `paused-one` (state `paused`), `stopped-one` (state `stopped`, raw `exited`), `secretive` (running), and the compose rows show `restart_null = t` and `started_null = t`.

- [ ] **L1-3. Multi-arch digest is the repo digest, not a platform digest.**

```bash
sudo docker image inspect nginx:1.27 --format '{{index .RepoDigests 0}}'
sudo docker buildx imagetools inspect nginx:1.27 | head -3
```

Expected: the digest part equals `image_digest` of `bare`/`shop-web-1` (the first 19 characters of the query output match), and equals the top-level index digest printed by `imagetools`.

- [ ] **L1-4. Nothing sensitive was collected.**

```bash
q "select count(*) from device_workloads dw where dw::text ilike '%lab-secret-value-123%' or dw::text ilike '%host-etc%' or dw::text ilike '%API_KEY%'"
```

Expected: `0`.

- [ ] **L1-5. The agent did not change the host.**

```bash
kill %1; cat /tmp/docker-events.log
```

Expected: only events for actions the operator ran in L1-1 (container create/start/pause/die); none with an empty or agent-related name after the setup commands, and no `start`, `stop`, `kill` or `create` events spaced at the agent's interval.

- [ ] **L1-6. Change-only and keepalive.** Wait two intervals with no host changes. `collected_at` in `device_workload_runtimes` does **not** advance on every interval (it advances at the 6 h keepalive and on change). In the agent log (`journalctl -u breeze-agent --since '-1h' | grep -i workload`) there are no `workload inventory submission failed` lines.

- [ ] **L1-7. Reflect lifecycle changes.** `sudo docker stop bare` → next cycle `bare` is `stopped`. `sudo docker rm -f bare` → next cycle the row is gone. `sudo docker run -d --name late busybox:1.36 sleep 3600` → a `late` row appears. Restart the agent between steps to avoid waiting a full interval.

- [ ] **L1-8. Disable.** Set Docker off in the policy (or the master switch off). After the next heartbeat (resolver cache is 120 s) and one cycle: `device_workloads` has no rows for the device, `device_workload_runtimes.collection = 'disabled'`, `devices.workload_runtimes` is still `{docker}`. Re-enable and confirm rows return.

- [ ] **L1-9. Daemon states.**

```bash
# not running, socket still present: the agent must not connect
sudo systemctl stop docker docker.socket
sudo python3 -c "import socket,time; s=socket.socket(socket.AF_UNIX); s.bind('/var/run/docker.sock'); time.sleep(1500)" &
```

Next cycle: `device_workload_runtimes.collection = 'unavailable'`, `last_error = 'daemon not running'`, the existing `device_workloads` rows are **kept** (spec D10), and `devices.workload_runtimes` still contains `docker`. Then stop the stub, remove `/var/run/docker.sock`, and confirm the next cycle reports `absent`: the runtime row and its workloads are deleted and `devices.workload_runtimes` no longer contains `docker`. Restore with `sudo systemctl start docker.socket docker`.

- [ ] **L1-10. A stopped socket-activated Docker stays stopped.** Make the daemon stopped but activatable: `sudo systemctl stop docker` (leave `docker.socket` active, so `/var/run/docker.sock` exists), confirm `systemctl is-active docker` prints `inactive`, `ls /var/run/docker.pid` fails, then wait at least two collection cycles (restart the agent to force the first). Expected: `systemctl is-active docker` is **still `inactive`** after every cycle, `journalctl -u docker --since '-30min'` shows no start, and the API shows `collection = 'unavailable'`, `last_error = 'daemon not running'`, rows kept. Then `sudo systemctl start docker` and confirm the next cycle returns to `ok`. A failure here (the daemon started by the agent) blocks the wave.

- [ ] **L1-11. Optional, Windows named pipe.** If a Windows host with a Docker engine is available, repeat L1-1/L1-2 against it and confirm the `docker` runtime reports over `\\.\pipe\docker_engine` (the compile and vet checks in Part A are the only Windows evidence otherwise; the Windows Docker pipe has no other gate in this wave, and the Hyper-V lab in W03 re-checks the shared Windows loop).

**Part D — L4: Podman host.**

- [ ] **L4-1. Set up** on a second Linux VM with the agent installed and the same policy assigned:

```bash
sudo apt-get install -y podman        # or: sudo dnf install -y podman
sudo systemctl enable --now podman.socket
# The agent connects only while a `podman system service` process exists, and the
# socket-activated unit exits after a short idle timeout by default. Keep one
# running for the gate with a drop-in that disables the idle timeout:
sudo systemctl edit podman.service      # add: [Service]\nExecStart=\nExecStart=/usr/bin/podman system service --time=0
sudo systemctl restart podman.service
pgrep -af 'podman.*system service'      # must print the process
sudo podman run -d --name p-web docker.io/library/nginx:1.27
sudo podman run -d --name p-cache docker.io/library/redis:7
sudo podman run --name p-done docker.io/library/busybox:1.36 true
sudo systemctl restart breeze-agent
```

- [ ] **L4-2. Expected.** `device_workload_runtimes`: `podman | present | ok | t | <podman version>`; **no `docker` row**; `devices.workload_runtimes = {podman}`. `device_workloads`: `p-web`, `p-cache` running with `image_repository` `docker.io/library/nginx` / `docker.io/library/redis`, tags `1.27` / `7`, and **`image_digest` populated** for both (proves the `/images/json` join on Podman's image-id format; if it is NULL, the id normalization in `normalizeImageID` is the first suspect), `p-done` stopped.

- [ ] **L4-3. Docker-compatible symlink is reported once.**

```bash
sudo apt-get install -y podman-docker   # creates /var/run/docker.sock -> Podman's socket
```

After a cycle the device still shows only `podman` (the docker driver sees that `/var/run/docker.sock` resolves to a `podman*` socket and reports `absent` without connecting); there are no `docker` rows.

- [ ] **L4-4. Disable and daemon states.** Disable behaves as L1-8. Stop the service (`sudo systemctl stop podman.service`, leave `podman.socket` active): after a cycle `collection = 'unavailable'`, `last_error = 'daemon not running'`, rows kept, and `systemctl is-active podman.service` is **still `inactive`** (the agent did not activate the socket). Expected consequence on stock installs: with the default idle timeout Podman inventory is usually `unavailable` (see Contract issues).

- [ ] **Step Z: Record evidence.** Paste into the PR description: the three query outputs for L1-2 and L4-2 (device ids and hostnames redacted), the L1-4 `0`, the L1-5 event log summary, the L1-9, L1-10 and L4-4 results, and the Part A command outputs. Tear down the lab stacks you brought up (`pnpm test-stack down` / `pnpm wt-stack down`) and say what is left running.

---

## Self-Review

**Spec §5 coverage map**

| Spec statement | Task |
|---|---|
| §5.1 package `agent/internal/collectors/workloads/`, `Runtime`, `Detection`, `Result`, `Driver` | 1 |
| §5.1 build-tagged per-OS driver registration (`drivers_linux.go`, `drivers_windows.go`, `drivers_other.go`) | 5 |
| §5.1 `docker` driver: socket / pipe exists → present; connect only when the daemon is already running (pid file / `docker` service); `/_ping` + `/version`, `/containers/json?all=1`, `/images/json` | 3, 4 |
| §5.1 `podman` driver on `/run/podman/podman.sock`; connect only when a `podman system service` process runs; otherwise `unavailable`; Docker and Podman both reported on one host | 4, 5 |
| §5.1 `containerd` detect-only (decision: shipped in W02) | 5 |
| §5.1 `hyperv`, `proxmox` drivers | W03 (not registered; guard test pins it) |
| §5.1 external-command runner with timeout and caps | W03 (no subprocess in this wave; Task 8 pins it) |
| §5.1 30 s per driver | 6 |
| §5.2 GET-only `RoundTripper`, path allowlist, no Docker SDK, mutation refused before a byte is written | 3, 8 |
| §5.3 own loop, first-run delay, ±10% jitter | 7 |
| §5.3 interval 15-1440 (default 60); detection on the same tick when enumeration is disabled | 6, 7 |
| §5.3 canonical hash; send on change or 6 h; hash advances only after 2xx | 6, 7 |
| §5.3 send via `sendInventoryData("workloads", …)` | 7 |
| §5.3 settings change mid-collection discards the result | 7 |
| §5.3 capability `WorkloadInventoryProtocolVersion = 1` | 7 |
| §5.4 field allowlist, never-collected list, no `inspect` | 4 |
| §5.4 byte budget 1.75 MB: drop lowest-priority workloads from the largest runtime, `complete=false` | 6 |
| §5.4 cap 1000 with ordering, `complete=false`, true `observedCount` | 4, 6 |
| §5.4 Hyper-V / Proxmox field lists | W03 |
| §5.5 privilege model (root / SYSTEM, main service not the helper) | 4, 7 (collector runs in the service goroutine; no helper IPC) |
| §5.5 macOS unsupported (no drivers, no Workloads section) | 5 |
| §5.5 grep guard for mutating verbs | 8 |
| §7.2 agent `applyWorkloadInventoryConfig`: `enabled` required, invalid ignored, default `Enabled: false`, above the policy-probe return | 7 |
| §13 agent tests: fixtures incl. multi-arch repo digests, Podman, GET-only refusal, allowlist, hash stability, failed send, mid-collection discard, `-race` | 3, 4, 6, 7 |
| §13 lab gates L1 and L4 | 9 |
| §13 `Get-VM` / `pvesh` fixtures, L2, L3 | W03 |
| Image normalization rules (wire-contract brief) | 2 |

**Placeholder scan:** no `TBD`/`TODO`; every code block above is the tested implementation; the only values left to the operator are the private lab identifiers (`DEVICE_ID`, `PG`).

**Type consistency:** `Settings.RuntimeEnabled` (Task 1) is the only gate read by `Collector.collectOne` (Task 6) and the only thing `parseWorkloadSettings` (Task 7) fills; `Report.Hash` (Task 6) is the value `workloadsCycle` compares; `ProtocolVersion` (Task 1) feeds both the wire body and `compiledSecurityCapabilities`.

## Contract issues

Resolved by the spec revision and now implemented as written:

- **Socket activation (was issue 1) — RESOLVED.** Detect never connects unless the daemon is already running (Task 4 gates, lab steps L1-10 and L4-4). Three small refinements the spec did not state, all in the conservative direction: the Docker pid file must name a process whose `/proc/<pid>/comm` is `dockerd` (a reused pid is "stopped"); the Windows service is queried with `windows.OpenService(..., SERVICE_QUERY_STATUS)` from `golang.org/x/sys/windows` rather than `svc/mgr`, because `mgr.OpenService` requests full access; and a `docker.sock` that resolves to a `podman*` socket is `absent` for the docker driver from the path alone.
- **`startedAt` is `null` for containers (was issue 2) — RESOLVED** in spec §5.4.
- **Hash = everything except `collectedAt`, millisecond precision (was issue 3, with the millisecond part of issue 6) — RESOLVED** in spec §5.3.
- **No drivers on macOS (was issue 7) — RESOLVED** in spec §5.5.

W05 handoff (recorded in the plan index, not W02 work): the agent maps `index.docker.io`, `registry-1.docker.io` and `registry.hub.docker.com` to `docker.io` and lowercases the registry host (compare repositories accordingly), and a failed `/images/json` yields null digests with `complete=false`, which W05 must read as "digest unknown", not `local`, until a complete snapshot arrives.

Still open or new (none blocks W02):

1. **Podman inventory is usually `unavailable` on stock installs (new).** `podman.socket` activates `podman.service`, whose default idle timeout makes the `podman system service` process exit seconds after the last request. With the "connect only when a service process is running" rule, a stock host will almost always report `present` + `unavailable` / `daemon not running`. Inventory works only where the service is kept running (a `--time=0` drop-in, as in lab step L4-1). The spec should say so in the docs wave, or accept a different rule for Podman.
2. **Docker liveness is only as good as the default pid file (new).** The check reads `/var/run/docker.pid`. A dockerd started with `--pidfile` elsewhere, or a packaged variant that keeps its pid file under another path (snap-style installs), is reported `unavailable` while running: a false negative, never a false start. Acceptable for v1; the gate stays conservative.
3. **Windows named pipe cannot be checked for existence without opening it (spec §5.1: "pipe … exists → present").** Opening the pipe is a connection. The plan treats `docker` service installed as "present" and service running as "safe to connect"; service missing is `absent`. Docker Desktop's `com.docker.service` is not matched, so Docker Desktop on Windows reports `absent`.
4. **`detection = absent` and `unknown` have no `collection` value in the spec (was issue 4).** Plan: `absent` → `collection: "unavailable"`, `complete: true`; `unknown` → `collection: "unavailable"`, `complete: false`, `error` = the reason code. W01 must ignore `collection` when `detection = absent` and treat `unknown` as "keep membership" while still upserting the row.
5. **Nullability of workload fields is unspecified (spec §6.1; was issue 5).** The agent emits every key every time, explicit `null` for unknowns. W01 must declare the nullable workload fields `.nullable()` (or `.nullish()`), not `.optional()`, or every report is a 400. `collectedAt` is UTC with milliseconds and a `Z` suffix so default `z.string().datetime()` accepts it. The agent keeps no persisted watermark, so a backward wall-clock step makes reports ignored by the ordering guard until the clock catches up.
6. **"Own loop … modelled on `heartbeat/hardware_health.go`" (spec §5.3; was issue 8).** Only the first run of the hardware loop has its own timer (`hardware_health.go:72`); every later tick rides the main heartbeat loop via `hardwareTiersLocked(now, false)` (`heartbeat.go:2124`, dispatched `:2210`). The plan models the worker on `heartbeat/time_sync.go:155-` (self-timed, wake channel, tracked by `inventoryWg`).
7. **`sendInventoryData` always uses `context.Background()` unless the endpoint has an override (`heartbeat.go:2417-2425`; was issue 9).** Without a `workloads` override an in-flight upload is not cancelled by shutdown. Plan adds the override (Task 7, hunk 6).
8. **Line references in the spec drifted (was issue 10).** `hwhealth.Source` is at `source.go:18-23` (spec: `:20-25`); `SecurityCapabilities` spans `heartbeat.go:234-282` (spec: `:234-262`), new field at `:280-281`; `applyHardwareMonitoringConfig` starts at `hardware_health.go:192`. Informational.
9. **`go-winio` is "already a dependency" (spec §5.1, `agent/go.mod:11`) but is imported today only by `agent/cmd/breeze-backup/dial_windows.go:23` and the session broker (was issue 11).** The main-service pipe dialer is a new use of the module, not a new module; `golang.org/x/sys` (`go.mod:34`) likewise needs no `go.mod` change.

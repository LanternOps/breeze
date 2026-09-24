# Hardware & RAID Monitoring — Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect and deliver bounded, read-only hardware-health observations on Windows and Linux using the W01 wire contract.

**Architecture:** A new `hwhealth` package owns detection, parsers, sequential collection, circuit breakers, identity merging and durable sequencing. Heartbeat owns the two jittered gates, configuration delivery and tracked uploads through the existing inventory transport. The server remains the only owner of health derivation, events, staleness and alerts.

**Tech Stack:** Go 1.26.6 standard library, existing `github.com/google/uuid`, Viper, PowerShell Storage cmdlets, storcli/perccli JSON, mdadm text and smartctl JSON.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-23-hardware-raid-monitoring-design.md`.
**Index:** `docs/superpowers/plans/monitoring/2026-09-23-hardware-monitoring.md`.
**Wave:** W02a, branch `feature/<parent#>-hardware-monitoring/wave-<sub#>`.
**Depends on:** W01 accepted agent transport and policy settings.

## Global Constraints

- Agent code ships to customer machines: `go test -race ./...`, fixture-driven parser tests, a
  native Windows run on VM `.55` for W02a/W02b/W05 (cross-compile has missed test bugs before).
- Files stay under ~500 lines; new code goes in new files next to the pattern it copies.

## Review Focus

1. A controller that reports 60+ drives in one `show all J` (≈ 1 MB JSON) — parser must stream/cap
   without truncating mid-object; W02a storcli test carries a 64-drive fixture. **Tasks 2, 5, 6.**
5. A vendor CLI that hangs forever (MegaCli on a dead controller) — cycle budget cancels it, the
   source reports `failed`, other sources still run, and after three cycles the breaker opens;
   W02a scheduler + breaker tests. **Tasks 2, 4, 13.**

## File Structure

All paths below are repository-relative; modifications use anchors from the inspected checkout.

| Action | File | Responsibility |
|---|---|---|
| Create | `agent/internal/collectors/hwhealth/types.go` | Contract structs and JSON round trip |
| Create | `agent/internal/collectors/hwhealth/types_test.go` | Contract structs and JSON round trip |
| Create | `agent/internal/collectors/hwhealth/source.go` | Source interface and adapter |
| Create | `agent/internal/collectors/hwhealth/keys.go` | Stable component identities |
| Create | `agent/internal/collectors/hwhealth/keys_test.go` | Stable component identities |
| Create | `agent/internal/collectors/hwhealth/runner.go` | Bounded subprocess execution |
| Create | `agent/internal/collectors/hwhealth/runner_test.go` | Bounded subprocess execution |
| Create | `agent/internal/collectors/hwhealth/detect.go` | Platform lookup and hourly detection cache |
| Create | `agent/internal/collectors/hwhealth/detect_linux.go` | Platform lookup and hourly detection cache |
| Create | `agent/internal/collectors/hwhealth/detect_windows.go` | Platform lookup and hourly detection cache |
| Create | `agent/internal/collectors/hwhealth/detect_other.go` | Platform lookup and hourly detection cache |
| Create | `agent/internal/collectors/hwhealth/detect_test.go` | Platform lookup and hourly detection cache |
| Create | `agent/internal/collectors/hwhealth/breaker.go` | Three-failure six-hour backoff |
| Create | `agent/internal/collectors/hwhealth/breaker_test.go` | Three-failure six-hour backoff |
| Create | `agent/internal/collectors/hwhealth/storcli.go` | Broadcom JSON normalization |
| Create | `agent/internal/collectors/hwhealth/storcli_test.go` | Broadcom JSON normalization |
| Create | `agent/internal/collectors/hwhealth/storcli_source.go` | Shared storcli/perccli commands, membership and progress |
| Create | `agent/internal/collectors/hwhealth/storcli_source_test.go` | Shared storcli/perccli commands, membership and progress |
| Create | `agent/internal/collectors/hwhealth/mdadm.go` | md arrays and stable member identity |
| Create | `agent/internal/collectors/hwhealth/mdadm_linux.go` | md arrays and stable member identity |
| Create | `agent/internal/collectors/hwhealth/mdadm_other.go` | md arrays and stable member identity |
| Create | `agent/internal/collectors/hwhealth/mdadm_test.go` | md arrays and stable member identity |
| Create | `agent/internal/collectors/hwhealth/storagespaces.go` | Storage Spaces pools, VDs and members |
| Create | `agent/internal/collectors/hwhealth/storagespaces_windows.go` | Storage Spaces pools, VDs and members |
| Create | `agent/internal/collectors/hwhealth/storagespaces_other.go` | Storage Spaces pools, VDs and members |
| Create | `agent/internal/collectors/hwhealth/storagespaces_test.go` | Storage Spaces pools, VDs and members |
| Create | `agent/internal/collectors/hwhealth/winpd.go` | Windows disks and reliability counters |
| Create | `agent/internal/collectors/hwhealth/winpd_windows.go` | Windows disks and reliability counters |
| Create | `agent/internal/collectors/hwhealth/winpd_other.go` | Windows disks and reliability counters |
| Create | `agent/internal/collectors/hwhealth/winpd_test.go` | Windows disks and reliability counters |
| Create | `agent/internal/collectors/hwhealth/smartctl.go` | SMART scan, exit bits and observations |
| Create | `agent/internal/collectors/hwhealth/smartctl_test.go` | SMART scan, exit bits and observations |
| Create | `agent/internal/collectors/hwhealth/merge.go` | Unambiguous identities and SMART replay |
| Create | `agent/internal/collectors/hwhealth/merge_test.go` | Unambiguous identities and SMART replay |
| Create | `agent/internal/collectors/hwhealth/persist.go` | Atomic state, vendor topology and SMART cache files |
| Create | `agent/internal/collectors/hwhealth/persist_test.go` | Atomic state and SMART cache files |
| Create | `agent/internal/collectors/hwhealth/collector.go` | Single-flight cycle, budget and fairness |
| Create | `agent/internal/collectors/hwhealth/collector_test.go` | Single-flight cycle, budget and fairness |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/optimal.json` | Synthetic storcli optimal fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/degraded.json` | Synthetic storcli degraded fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/failed.json` | Synthetic storcli failed fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/rebuilding-with-progress.json` | Synthetic storcli rebuilding-with-progress fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/predictive.json` | Synthetic storcli predictive fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/missing-member.json` | Synthetic storcli missing-member fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/multi-controller.json` | Synthetic storcli multi-controller fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/unrecognized-state.json` | Synthetic storcli unrecognized-state fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/truncated.json` | Synthetic storcli truncated fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storcli/64-drive.json` | Synthetic storcli 64-drive fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/optimal.json` | Synthetic perccli optimal fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/degraded.json` | Synthetic perccli degraded fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/failed.json` | Synthetic perccli failed fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/rebuilding-with-progress.json` | Synthetic perccli rebuilding-with-progress fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/predictive.json` | Synthetic perccli predictive fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/missing-member.json` | Synthetic perccli missing-member fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/multi-controller.json` | Synthetic perccli multi-controller fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/unrecognized-state.json` | Synthetic perccli unrecognized-state fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/truncated.json` | Synthetic perccli truncated fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/perccli/64-drive.json` | Synthetic perccli 64-drive fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/optimal.mdstat.txt` | Synthetic mdadm optimal fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/optimal.detail.txt` | Synthetic mdadm optimal fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/degraded.mdstat.txt` | Synthetic mdadm degraded fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/degraded.detail.txt` | Synthetic mdadm degraded fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/failed.mdstat.txt` | Synthetic mdadm failed fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/failed.detail.txt` | Synthetic mdadm failed fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/rebuilding-with-progress.mdstat.txt` | Synthetic mdadm rebuilding-with-progress fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/rebuilding-with-progress.detail.txt` | Synthetic mdadm rebuilding-with-progress fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/predictive.mdstat.txt` | Synthetic mdadm predictive fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/predictive.detail.txt` | Synthetic mdadm predictive fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/missing-member.mdstat.txt` | Synthetic mdadm missing-member fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/missing-member.detail.txt` | Synthetic mdadm missing-member fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/multi-controller.mdstat.txt` | Synthetic mdadm multi-controller fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/multi-controller.detail.txt` | Synthetic mdadm multi-controller fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/unrecognized-state.mdstat.txt` | Synthetic mdadm unrecognized-state fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/unrecognized-state.detail.txt` | Synthetic mdadm unrecognized-state fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/truncated.mdstat.txt` | Synthetic mdadm truncated fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/mdadm/truncated.detail.txt` | Synthetic mdadm truncated fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storage_spaces/optimal.json` | Synthetic storage_spaces optimal fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storage_spaces/degraded.json` | Synthetic storage_spaces degraded fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storage_spaces/failed.json` | Synthetic storage_spaces failed fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storage_spaces/rebuilding-with-progress.json` | Synthetic storage_spaces rebuilding-with-progress fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storage_spaces/predictive.json` | Synthetic storage_spaces predictive fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storage_spaces/missing-member.json` | Synthetic storage_spaces missing-member fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storage_spaces/multi-controller.json` | Synthetic storage_spaces multi-controller fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storage_spaces/unrecognized-state.json` | Synthetic storage_spaces unrecognized-state fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/storage_spaces/truncated.json` | Synthetic storage_spaces truncated fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/optimal.json` | Synthetic windows_physical_disk optimal fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/degraded.json` | Synthetic windows_physical_disk degraded fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/failed.json` | Synthetic windows_physical_disk failed fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/rebuilding-with-progress.json` | Synthetic windows_physical_disk rebuilding-with-progress fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/predictive.json` | Synthetic windows_physical_disk predictive fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/missing-member.json` | Synthetic windows_physical_disk missing-member fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/multi-controller.json` | Synthetic windows_physical_disk multi-controller fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/unrecognized-state.json` | Synthetic windows_physical_disk unrecognized-state fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/truncated.json` | Synthetic windows_physical_disk truncated fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/optimal.json` | Synthetic smartctl optimal fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/degraded.json` | Synthetic smartctl degraded fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/failed.json` | Synthetic smartctl failed fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/rebuilding-with-progress.json` | Synthetic smartctl rebuilding-with-progress fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/predictive.json` | Synthetic smartctl predictive fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/missing-member.json` | Synthetic smartctl missing-member fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/multi-controller.json` | Synthetic smartctl multi-controller fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/unrecognized-state.json` | Synthetic smartctl unrecognized-state fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/truncated.json` | Synthetic smartctl truncated fixture |
| Create | `agent/internal/collectors/hwhealth/testdata/smartctl/scan.json` | Synthetic smartctl scan fixture |
| Modify | `agent/internal/config/config.go:55,727` | Local Hardware.ToolDirs and save registration |
| Modify | `agent/internal/config/validate.go:3,182` | Validate absolute local directories |
| Create | `agent/internal/config/hardware_test.go` | Directory validation and persistence |
| Modify | `agent/internal/heartbeat/heartbeat.go:394,900,1765,1962,2051,2069,2090,2260,2275,2949` | Fields, gates, config, transport and shutdown hooks |
| Create | `agent/internal/heartbeat/hardware_health.go` | Jitter, config and tracked upload |
| Create | `agent/internal/heartbeat/hardware_health_test.go` | Scheduler/transport/config/shutdown regressions |

Read-only anchors: `command_limits.go:176` discards stdout on nonzero exit; its `collectorWaitDelay` is 10 s at :68. `safe.go:124` exports `Guard[T any](op string, fn func() (T, error)) (result T, err error)`. `hardware.go:202` exposes `(*HardwareCollector).CollectHardware() (*HardwareInfo, error)`; `hardware_windows.go:82–125` batches UTF-8 PowerShell. `inventory.go:46,98` reports filesystem inventory with the legacy healthy field; leave that contract intact. `change_tracker.go:612–650` supplies the JSON temporary-file/rename example. `battery_windows.go:1`, `battery_linux.go:1`, `battery_other.go:1` show build tags; hardware-health's other stub **includes darwin**. `state/state.go:58` is `Write(path string, s *AgentState) error`, not a generic JSON writer. `config/config.go:1071` is `GetDataDir() string`; `go.mod:3,20` already provides the Go version and uuid dependency.

Decisions: the runner lives in `hwhealth/runner.go` (index §H wins over the spec's extraction sentence). `perccli` is a distinct `Kind` instantiated with the same source/parser, never a Go type alias that loses the source tag. The exact storcli command list is Task 6; progress comes from read-only `show rebuild`, `show init`, and `show cc`. OS-visible model matching is case-insensitive substring matching for precisely `PERC`, `LOGICAL VOLUME`, `Virtual Disk`, `MR9`, `Smart Array`, `RAID` and requires a vendor VD. Additional internal helpers and portable parser files below are created here, not assumed to exist.

Run every shell block from the repository root unless it explicitly changes directory. Each code block names its destination; append blocks explicitly say so. Apply gofmt after Go edits. Red commands intentionally fail on the named missing symbol before implementation; green commands must return exit code 0. No API schema, migration, shared, or web file changes belong to this wave.

### Task 1: Define the wire types, source interface and stable keys

**Files:** Create `agent/internal/collectors/hwhealth/types.go`, `agent/internal/collectors/hwhealth/source.go`, `agent/internal/collectors/hwhealth/keys.go`, `agent/internal/collectors/hwhealth/types_test.go`, `agent/internal/collectors/hwhealth/keys_test.go`.
**Test:** `agent/internal/collectors/hwhealth/types_test.go`, `agent/internal/collectors/hwhealth/keys_test.go`.
**Interfaces:** Consumes index §B/§C. Produces `Kind`, `Tier`, `ComponentType`, `SourceStatus`, `Component`, `SourceReport`, `Snapshot`, `Config`, `Availability`, `Result`, `Source`, `TierRAID`, `TierDisk` and key builders below.

Index-facing §4.2 key contract (index §H references the design's key table):

| Type / source | Key |
|---|---|
| controller (vendor CLI) | `<source>:c<index>` |
| controller (synthetic) | `<source>:ctrl` |
| virtual_disk | `<controllerKey>:v<id>` / `mdadm:md0` / `zfs:pool:<name>` / `storage_spaces:vd:<ObjectId-hash>` |
| physical_disk (slotted) | `<controllerKey>:e<enclosure>:s<slot>`; `e-` without an enclosure |
| physical_disk (mdadm / zfs member) | `<vdKey>:m:<stable dev id>`; never `/dev/sdX` |
| physical_disk (windows_physical_disk) | `winpd:<UniqueId>` |
| physical_disk (smartctl standalone) | `smart:<serial>` for a trimmed, non-blank serial unique within the scan; otherwise `smart:dev:<type>:<name>` using the scan's exact `Type` and `Name` |
| cache_battery | `<controllerKey>:bbu` or `<controllerKey>:cv` |
| enclosure | `<controllerKey>:enc<id>` |
| bmc | `bmc:<source>` |
| collector (server only) | `collector:<source>` |

The SMART fallback is the authorized extension to §4.2: `smart:dev:megaraid,0:/dev/bus/0` and `smart:dev:megaraid,1:/dev/bus/0` identify distinct probes. An omitted scan type remains empty (`smart:dev::/dev/sda`); do not invent a type or use a scan ordinal. All other key formats and the unique-serial rule remain unchanged.

- [ ] **Step 1: Write the wire and identity tests (5 min).** `types_test.go`:
```go
package hwhealth
import("encoding/json";"reflect";"sort";"strings";"testing";"time")
func TestSnapshotWire(t *testing.T) {
 s:=Snapshot{SnapshotID:"4f370dba-213a-4b89-a333-012345678901",Sequence:7,CollectedAt:time.Unix(1,0).UTC(),AgentVersion:"test",PollIntervalMinutes:10,DiskHealthIntervalMinutes:60,TiersRun:[]string{"raid"},Sources:[]SourceReport{{Source:"storcli",Status:"ok",Complete:ptr(true),ToolVersion:"1",Path:"tool",DurationMs:1,Error:"detail",RetryAt:ptr(time.Unix(2,0).UTC()),Warnings:[]string{"note"}}},Components:[]Component{{ComponentKey:"storcli:c0:e-:s1",ComponentType:"physical_disk",ParentKey:ptr("storcli:c0"),Source:"storcli",Name:"Slot 1",Model:ptr("disk"),Serial:ptr("S"),Firmware:ptr("F"),SizeBytes:ptr(int64(1)),State:"online",StateDetail:ptr("Onln"),ProgressPercent:ptr(1),TemperatureC:ptr(30),MemberErrors:ptr(false),OSHealthStatus:ptr("healthy"),SmartPassed:ptr(true),Attributes:map[string]any{}}}}
 b,e:=json.Marshal(s);if e!=nil{t.Fatal(e)}
 var root map[string]json.RawMessage;if e=json.Unmarshal(b,&root);e!=nil{t.Fatal(e)}
 assertKeys(t,root,"snapshotId sequence collectedAt agentVersion pollIntervalMinutes diskHealthIntervalMinutes tiersRun sources components")
 var components,sources []map[string]json.RawMessage
 _=json.Unmarshal(root["components"],&components);_=json.Unmarshal(root["sources"],&sources)
 assertKeys(t,components[0],"componentKey componentType parentKey source name model serial firmware sizeBytes state stateDetail progressPercent temperatureC predictiveFailure alertExempt memberErrors osHealthStatus smartPassed attributes")
 assertKeys(t,sources[0],"source status complete toolVersion path durationMs error retryAt warnings")
 var round Snapshot;if e=json.Unmarshal(b,&round);e!=nil{t.Fatal(e)}
 if !reflect.DeepEqual(s,round){t.Fatalf("round trip: %#v",round)}
}
func assertKeys(t *testing.T,m map[string]json.RawMessage,want string){t.Helper();got:=[]string{};for k:=range m{got=append(got,k)};w:=strings.Fields(want);sort.Strings(got);sort.Strings(w);if !reflect.DeepEqual(got,w){t.Fatalf("keys %v want %v",got,w)}}
```
`keys_test.go`:
```go
package hwhealth
import "testing"
func TestKeys(t *testing.T){for _,tc:=range []struct{got,want string}{
 {controllerKey("storcli","0"),"storcli:c0"},
 {slotKey("perccli:c1","","3"),"perccli:c1:e-:s3"},
 {memberKey("mdadm:md0","ata-S1"),"mdadm:md0:m:ata-S1"},
 {smartKey(" S ","sat","/dev/sda",true),"smart:S"},
 {smartKey("S","sat","/dev/sda",false),"smart:dev:sat:/dev/sda"},
 {smartKey("","megaraid,0","/dev/bus/0",true),"smart:dev:megaraid,0:/dev/bus/0"},
 {smartKey("  ","megaraid,1","/dev/bus/0",true),"smart:dev:megaraid,1:/dev/bus/0"},
 {smartKey("S","megaraid,0","/dev/bus/0",false),"smart:dev:megaraid,0:/dev/bus/0"},
 {smartKey("S","megaraid,1","/dev/bus/0",false),"smart:dev:megaraid,1:/dev/bus/0"},
 {smartKey("","","/dev/sda",false),"smart:dev::/dev/sda"},
 }{if tc.got!=tc.want{t.Fatalf("%q != %q",tc.got,tc.want)}}}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: Snapshot`.
- [ ] **Step 3: Create the contract types (5 min).** `types.go`:
```go
package hwhealth
import "time"
type Kind string
type Tier string
type ComponentType string
type SourceStatus string
const(TierRAID Tier="raid";TierDisk Tier="disk")
type Component struct {
 ComponentKey string `json:"componentKey"`
 ComponentType ComponentType `json:"componentType"`
 ParentKey *string `json:"parentKey,omitempty"`
 Source Kind `json:"source"`
 Name string `json:"name"`
 Model *string `json:"model,omitempty"`
 Serial *string `json:"serial,omitempty"`
 Firmware *string `json:"firmware,omitempty"`
 SizeBytes *int64 `json:"sizeBytes,omitempty"`
 State string `json:"state"`
 StateDetail *string `json:"stateDetail,omitempty"`
 ProgressPercent *int `json:"progressPercent,omitempty"`
 TemperatureC *int `json:"temperatureC,omitempty"`
 PredictiveFailure bool `json:"predictiveFailure"`
 AlertExempt bool `json:"alertExempt"`
 MemberErrors *bool `json:"memberErrors,omitempty"`
 OSHealthStatus *string `json:"osHealthStatus,omitempty"`
 SmartPassed *bool `json:"smartPassed,omitempty"`
 Attributes map[string]any `json:"attributes"`
}
type SourceReport struct {
 Source Kind `json:"source"`
 Status SourceStatus `json:"status"`
 Complete *bool `json:"complete,omitempty"`
 ToolVersion string `json:"toolVersion,omitempty"`
 Path string `json:"path,omitempty"`
 DurationMs int64 `json:"durationMs,omitempty"`
 Error string `json:"error,omitempty"`
 RetryAt *time.Time `json:"retryAt,omitempty"`
 Warnings []string `json:"warnings,omitempty"`
}
type Snapshot struct {
 SnapshotID string `json:"snapshotId"`
 Sequence uint64 `json:"sequence"`
 CollectedAt time.Time `json:"collectedAt"`
 AgentVersion string `json:"agentVersion"`
 PollIntervalMinutes int `json:"pollIntervalMinutes"`
 DiskHealthIntervalMinutes int `json:"diskHealthIntervalMinutes"`
 TiersRun []string `json:"tiersRun"`
 Sources []SourceReport `json:"sources"`
 Components []Component `json:"components"`
}
type Config struct{Enabled bool;PollInterval time.Duration;DiskHealthInterval time.Duration}
func ptr[T any](v T)*T{return &v}
```
`source.go`:
```go
package hwhealth
import "context"
type Availability struct{Path,Version string;Available bool}
type Result struct{Components []Component;Complete bool;Warnings []string;ToolVersion string}
type Source interface{Name() Kind;Tier() Tier;Detect(context.Context) Availability;Collect(context.Context,Availability)(Result,error)}
type source struct{kind Kind;tier Tier;detect func(context.Context)Availability;collect func(context.Context,Availability)(Result,error)}
func(s *source)Name()Kind{return s.kind}
func(s *source)Tier()Tier{return s.tier}
func(s *source)Detect(c context.Context)Availability{return s.detect(c)}
func(s *source)Collect(c context.Context,a Availability)(Result,error){return s.collect(c,a)}
```
`keys.go`:
```go
package hwhealth
import("crypto/sha256";"fmt";"strings")
func controllerKey(k Kind,id string)string{return string(k)+":c"+id}
func slotKey(c,e,s string)string{if e==""{e="-"};return c+":e"+e+":s"+s}
func memberKey(v,id string)string{return v+":m:"+id}
func objectHash(id string)string{return fmt.Sprintf("%x",sha256.Sum256([]byte(id)))[:24]}
func smartKey(serial,deviceType,dev string,unique bool)string{serial=strings.TrimSpace(serial);if serial!=""&&unique{return "smart:"+serial};return "smart:dev:"+deviceType+":"+dev}
func component(k Kind,typ ComponentType,key,parent,name,raw,state string)Component{
 c:=Component{ComponentKey:key,ComponentType:typ,Source:k,Name:name,State:state,StateDetail:ptr(raw),Attributes:map[string]any{}}
 if parent!=""{c.ParentKey=ptr(parent)};return c
}
```
- [ ] **Step 4: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`.
- [ ] **Step 5: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{types.go,source.go,keys.go,types_test.go,keys_test.go}
git commit -m $'feat(agent): define hardware health wire contract\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 2: Keep exit-code data and bound subprocess output and lifetime

**Files:** Create `agent/internal/collectors/hwhealth/runner.go`, `agent/internal/collectors/hwhealth/runner_test.go`. Read-only reference `agent/internal/collectors/command_limits.go:26,68,148,176`.
**Test:** `agent/internal/collectors/hwhealth/runner_test.go`.
**Interfaces:** Consumes `context.Context`; produces contract `execResult`, `runTool(ctx context.Context, timeout time.Duration, path string, args ...string) (execResult, error)` and `runPowerShell(ctx context.Context, timeout time.Duration, script string) (execResult, error)`.

- [ ] **Step 1: Write helper-process tests (5 min).** `runner_test.go`:
```go
package hwhealth
import("context";"fmt";"os";"strings";"testing";"time")
func TestRunnerChild(t *testing.T){args:=os.Args;for i,a:=range args{if a!="hw-child"{continue};switch args[i+1]{case "exit":fmt.Print(`{"smart_status":{"passed":false}}`);os.Exit(8);case "hang":time.Sleep(time.Hour);case "overflow":fmt.Print(strings.Repeat("x",4*1024*1024+1))};os.Exit(0)}}
func TestRunner(t *testing.T){for _,tc:=range []struct{mode string;code int;bad,cap bool}{{"exit",8,false,false},{"hang",-1,true,false},{"overflow",0,true,true}}{t.Run(tc.mode,func(t *testing.T){d:=5*time.Second;if tc.mode=="hang"{d=50*time.Millisecond};start:=time.Now();r,e:=runTool(context.Background(),d,os.Args[0],"-test.run=TestRunnerChild","--","hw-child",tc.mode);if (e!=nil)!=tc.bad||r.Truncated!=tc.cap{t.Fatalf("%+v %v",r,e)};if !tc.bad&&(r.ExitCode!=tc.code||!strings.Contains(string(r.Stdout),"smart_status")){t.Fatal(r)};if len(r.Stdout)>4*1024*1024||time.Since(start)>12*time.Second{t.Fatal("unbounded runner")}})}}
func TestRunnerMissing(t *testing.T){_,e:=runTool(context.Background(),time.Second,"/nonexistent/hwhealth-tool");if e==nil{t.Fatal("spawn must fail")}}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: runTool`.
- [ ] **Step 3: Implement runner (5 min).** `runner.go`:
```go
package hwhealth
import("bytes";"context";"errors";"fmt";"os/exec";"time")
type execResult struct{Stdout,Stderr []byte;ExitCode int;Truncated bool;Duration time.Duration}
type toolRunner func(context.Context,time.Duration,string,...string)(execResult,error)
type limitBuffer struct{buf bytes.Buffer;limit int;overflow bool}
func(b *limitBuffer)Len()int{return b.buf.Len()}
func(b *limitBuffer)Bytes()[]byte{return b.buf.Bytes()}
func(b *limitBuffer)Write(p []byte)(int,error){n:=len(p);left:=b.limit-b.Len();if n>left{b.overflow=true;p=p[:left]};_,_=b.buf.Write(p);return n,nil}
func runTool(parent context.Context,timeout time.Duration,path string,args ...string)(execResult,error){
 ctx,cancel:=context.WithTimeout(parent,timeout);defer cancel();start:=time.Now()
 cmd:=exec.CommandContext(ctx,path,args...);out:=&limitBuffer{limit:4*1024*1024};errout:=&limitBuffer{limit:64*1024}
 cmd.Stdout=out;cmd.Stderr=errout;cmd.WaitDelay=10*time.Second;e:=cmd.Run()
 r:=execResult{Stdout:out.Bytes(),Stderr:errout.Bytes(),ExitCode:-1,Truncated:out.overflow||errout.overflow,Duration:time.Since(start)}
 if cmd.ProcessState!=nil{r.ExitCode=cmd.ProcessState.ExitCode()}
 if ctx.Err()!=nil{return r,ctx.Err()};if r.Truncated{return r,fmt.Errorf("output exceeds capture limit")}
 var exit *exec.ExitError
 if errors.As(e,&exit){return r,nil}
 if errors.Is(e,exec.ErrWaitDelay){return r,fmt.Errorf("output pipe did not close: %w",e)}
 return r,e
}
func runPowerShell(ctx context.Context,timeout time.Duration,script string)(execResult,error){
 return runTool(ctx,timeout,"powershell.exe","-NoProfile","-NonInteractive","-Command","[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"+script)
}
```
Nonzero exit is not `error`; timeout, overflow, spawn and pipe-incomplete errors are. A source must reject `Truncated` before JSON decoding. WaitDelay may add at most ten seconds of pipe cleanup beyond the source deadline; no other source starts beyond the four-minute cycle deadline.
- [ ] **Step 4: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`.
- [ ] **Step 5: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{runner.go,runner_test.go}
git commit -m $'feat(agent): bound hardware tool execution and preserve exit data\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 3: Detect tools with an hourly cache and validate local overrides

**Files:** Create `agent/internal/collectors/hwhealth/detect.go`, `agent/internal/collectors/hwhealth/detect_linux.go`, `agent/internal/collectors/hwhealth/detect_windows.go`, `agent/internal/collectors/hwhealth/detect_other.go`, `agent/internal/collectors/hwhealth/detect_test.go`, `agent/internal/config/hardware_test.go`; Modify `agent/internal/config/config.go:55,727`, `agent/internal/config/validate.go:3,182`.
**Test:** `agent/internal/collectors/hwhealth/detect_test.go`, `agent/internal/config/hardware_test.go`.
**Interfaces:** Produces `lookupTool(names []string, extraDirs []string) (path string, ok bool)`, `detection.get(now time.Time, probe func() Availability) Availability`, `wellKnownDirs() []string`, and `Config.Hardware.ToolDirs`. Consumes existing `(*config.Config).ValidateTiered() ValidationResult`, `Load(cfgFile string) (*Config, error)` and `SaveTo(cfg *Config, cfgFile string) error`.

- [ ] **Step 1: Write detection and config tests (5 min).** `detect_test.go`:
```go
package hwhealth
import("os";"path/filepath";"runtime";"testing";"time")
func TestDetectionCache(t *testing.T){n:=0;d:=detection{};now:=time.Unix(1,0);probe:=func()Availability{n++;return Availability{Available:true,Path:"gone"}};d.get(now,probe);d.get(now.Add(time.Minute),probe);if n!=1{t.Fatal(n)};d.get(now.Add(time.Hour),probe);if n!=2{t.Fatal(n)}}
func TestExtraDirs(t *testing.T){dir:=t.TempDir();name:="breeze-hw-fixture-tool";if runtime.GOOS=="windows"{name+=".exe"};p:=filepath.Join(dir,name);if e:=os.WriteFile(p,[]byte("fixture"),0700);e!=nil{t.Fatal(e)};got,ok:=lookupTool([]string{name},[]string{dir});if !ok||got!=p{t.Fatalf("%s %v",got,ok)}}
```
`agent/internal/config/hardware_test.go`:
```go
package config
import("path/filepath";"testing";"github.com/spf13/viper")
func TestHardwareToolDirs(t *testing.T){for _,bad:=range []string{"","relative/tools","bad\x00dir"}{c:=Default();c.Hardware.ToolDirs=[]string{bad};if !c.ValidateTiered().HasFatals(){t.Fatalf("accepted %q",bad)}};c:=Default();c.Hardware.ToolDirs=[]string{t.TempDir()};if c.ValidateTiered().HasFatals(){t.Fatal("absolute directory rejected")}}
func TestHardwareToolDirsRoundTrip(t *testing.T){viper.Reset();defer viper.Reset();c:=Default();c.Hardware.ToolDirs=[]string{t.TempDir()};p:=filepath.Join(t.TempDir(),"agent.yaml");if e:=SaveTo(c,p);e!=nil{t.Fatal(e)};viper.Reset();got,e:=Load(p);if e!=nil{t.Fatal(e)};if len(got.Hardware.ToolDirs)!=1||got.Hardware.ToolDirs[0]!=c.Hardware.ToolDirs[0]{t.Fatal(got.Hardware)}}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` and `cd agent && go test -race ./internal/config/...` → `undefined: detection`, `c.Hardware undefined`.
- [ ] **Step 3: Implement discovery (5 min).** `detect.go`:
```go
package hwhealth
import("os/exec";"path/filepath";"sync";"time")
func lookupTool(names []string,extraDirs []string)(string,bool){
 for _,n:=range names{if p,e:=exec.LookPath(n);e==nil{return p,true}}
 dirs:=append(append([]string{},wellKnownDirs()...),extraDirs...)
 for _,d:=range dirs{for _,n:=range names{if p,e:=exec.LookPath(filepath.Join(d,n));e==nil{return p,true}}};return "",false
}
type detection struct{mu sync.Mutex;checked time.Time;value Availability}
func(d *detection)get(now time.Time,probe func()Availability)Availability{d.mu.Lock();defer d.mu.Unlock();if d.checked.IsZero()||now.Sub(d.checked)>=time.Hour{d.value=probe();d.checked=now};return d.value}
```
`detect_linux.go`:
```go
//go:build linux
package hwhealth
func wellKnownDirs()[]string{return []string{"/opt/MegaRAID/storcli/","/opt/MegaRAID/perccli/","/opt/MegaRAID/MegaCli/","/usr/sbin","/usr/local/sbin","/opt/smartstorageadmin/ssacli/bin/","/usr/Arcconf/","/usr/StorMan/","/opt/dell/srvadmin/bin/","/opt/dell/srvadmin/sbin/","/usr/bin"}}
```
`detect_windows.go`:
```go
//go:build windows
package hwhealth
import("os";"path/filepath")
func wellKnownDirs()[]string{dirs:=[]string{};for _,key:=range []string{"ProgramFiles","ProgramFiles(x86)"}{root:=os.Getenv(key);if root==""{continue};for _,suffix:=range []string{`Dell\SysMgt\oma\bin`,`Dell\SysMgt\iDRAC Tools`,`Smart Storage Administrator\ssacli\bin`,`Compaq\Hpacucli\Bin`,`Adaptec\maxView Storage Manager`,`smartmontools\bin`}{dirs=append(dirs,filepath.Join(root,suffix))}};return append(dirs,`C:\storcli`, `C:\perccli`, `C:\MegaCli`)}
```
`detect_other.go`:
```go
//go:build !windows && !linux
package hwhealth
func wellKnownDirs()[]string{return nil}
```
- [ ] **Step 4: Add the local field, save registration and validation (5 min).** Insert in `Config` after `EnabledCollectors`:
```go
Hardware struct {
 ToolDirs []string `mapstructure:"tool_dirs" yaml:"tool_dirs"`
} `mapstructure:"hardware" yaml:"hardware"`
```
Insert in `saveToLocked` after `viper.Set("enabled_collectors", cfg.EnabledCollectors)`:
```go
viper.Set("hardware.tool_dirs", cfg.Hardware.ToolDirs)
```
Add `"path/filepath"` to `validate.go` imports; insert before the unknown-collectors loop:
```go
for _,dir:=range c.Hardware.ToolDirs {
 invalid:=strings.TrimSpace(dir)==""||!filepath.IsAbs(dir)
 for _,r:=range dir{if unicode.IsControl(r){invalid=true}}
 if invalid{result.Fatals=append(result.Fatals,fmt.Errorf("hardware.tool_dirs requires absolute paths without control characters"))}
}
```
Decision: directories need not exist at config-load time; no shell expansion or tool installation. W02a owns the field and lookup foundation required by §H; W02b adds the remaining source names to it.
- [ ] **Step 5: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` and `cd agent && go test -race ./internal/config/...` → `ok` for both packages.
- [ ] **Step 6: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/detect*.go agent/internal/config/{config.go,validate.go,hardware_test.go}
git commit -m $'feat(agent): detect hardware tools and persist local search paths\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 4: Implement the visible per-source circuit breaker

**Files:** Create `agent/internal/collectors/hwhealth/breaker.go`, `agent/internal/collectors/hwhealth/breaker_test.go`.
**Test:** `agent/internal/collectors/hwhealth/breaker_test.go`.
**Interfaces:** Produces `breaker.blocked(now time.Time) bool`, `breaker.finish(now time.Time, err error)`; Task 13 alone owns and mutates the breaker map while holding the cycle single-flight claim.

- [ ] **Step 1: Write the failure/backoff/recovery test (3 min).** `breaker_test.go`:
```go
package hwhealth
import("errors";"testing";"time")
func TestBreaker(t *testing.T){now:=time.Unix(100,0);b:=breaker{};for i:=0;i<2;i++{b.finish(now,errors.New("hung"));if b.blocked(now){t.Fatal("early backoff")}};b.finish(now,errors.New("hung"));if !b.blocked(now.Add(6*time.Hour-time.Nanosecond)){t.Fatal("missing backoff")};if b.blocked(now.Add(6*time.Hour)){t.Fatal("retry must be allowed")};b.finish(now.Add(6*time.Hour),nil);if b.failures!=0||b.lastError!=""||b.blocked(now){t.Fatal(b)}}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: breaker`.
- [ ] **Step 3: Implement (3 min).** `breaker.go`:
```go
package hwhealth
import "time"
type breaker struct{failures int;retryAt time.Time;lastError string}
func(b *breaker)blocked(now time.Time)bool{return now.Before(b.retryAt)}
func(b *breaker)finish(now time.Time,err error){if err==nil{*b=breaker{};return};b.failures++;b.lastError=err.Error();if b.failures>=3{b.retryAt=now.Add(6*time.Hour)}}
```
Unavailable, superseded, disabled and budget-skipped sources do not call `finish`; partial results with actual rows count as a successful observation with warnings. A timed-out source with no rows does call `finish`.
- [ ] **Step 4: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`.
- [ ] **Step 5: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{breaker.go,breaker_test.go}
git commit -m $'feat(agent): back off repeatedly failing hardware sources\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 5: Parse storcli and perccli controllers, disks, enclosures and batteries

**Files:** Create `agent/internal/collectors/hwhealth/storcli.go`, `agent/internal/collectors/hwhealth/storcli_test.go` and `agent/internal/collectors/hwhealth/testdata/{storcli,perccli}/{optimal,degraded,failed,rebuilding-with-progress,predictive,missing-member,multi-controller,unrecognized-state,truncated,64-drive}.json` beneath that package.
**Test:** `agent/internal/collectors/hwhealth/storcli_test.go`.
**Interfaces:** Consumes Task 1 key builders. Produces `parseStorcli(data []byte, kind Kind) (Result, error)`, `parseStorcliSections(data []byte, kind Kind, required ...string) (Result, error)`, `decodeStorcliControllers`, `decodeStorcliController`, `storcliNumericID`, `vendorState(typ ComponentType, raw string) string`, `jsonObject`, `textValue`, `number`, `walkJSON`, `mergeComponents` for later commands.

- [ ] **Step 1: Generate the raw fixtures and write parser assertions (5 min).** Run this complete generator from the repo root; it creates synthetic fixtures, not claimed hardware captures:
```bash
python3 - <<'PY'
import json,pathlib,copy
root=pathlib.Path('agent/internal/collectors/hwhealth/testdata')
def controller(i=0,n=1):
 return {'Command Status':{'Controller':i,'Status':'Success'},'Response Data':{'Basics':{'Model':'Fixture RAID','Serial Number':'CTRL'+str(i),'FW Package Build':'1'},'Status':{'Controller Status':'Optimal'},'VD LIST':[{'DG/VD':'0/0','TYPE':'RAID1','State':'Optl','Size':'1 TB','Name':'Mirror'}],'PD LIST':[{'EID:Slt':'252:'+str(s),'DID':s,'DG':0,'State':'Onln','Model':'Fixture Disk','SN':'SER'+str(i)+'-'+str(s),'Size':'1 TB','Predictive Failure Count':0,'Notes':'x'*16000} for s in range(n)],'Cachevault_Info':[{'State':'Optimal'}],'Enclosure LIST':[{'EID':252,'State':'OK'}]}}
for source in ('storcli','perccli'):
 d=root/source;d.mkdir(parents=True,exist_ok=True)
 for name in ('optimal','degraded','failed','rebuilding-with-progress','predictive','missing-member','multi-controller','unrecognized-state','64-drive'):
  c=controller(n=64 if name=='64-drive' else 1);r=c['Response Data']
  if name=='degraded':r['VD LIST'][0]['State']='Dgrd'
  if name=='failed':r['PD LIST'][0]['State']='UBad';r['Status']['Controller Status']='Failed'
  if name=='rebuilding-with-progress':r['PD LIST'][0].update(State='Rbld',**{'Progress%':42})
  if name=='predictive':r['PD LIST'][0]['Predictive Failure Count']=1
  if name=='missing-member':r['PD LIST'][0]['State']='Msng'
  if name=='unrecognized-state':r['VD LIST'][0]['State']='NewVendorState'
  doc={'Controllers':[c]+([controller(1)] if name=='multi-controller' else [])}
  (d/(name+'.json')).write_text(json.dumps(doc))
 (d/'truncated.json').write_text('{"Controllers":[{"Response Data":')
PY
```
`storcli_test.go`:
```go
package hwhealth
import("encoding/json";"os";"path/filepath";"testing")
func fixture(t *testing.T,source,name string)[]byte{t.Helper();b,e:=os.ReadFile(filepath.Join("testdata",source,name));if e!=nil{t.Fatal(e)};return b}
func findComponent(t *testing.T,cs []Component,key string)Component{t.Helper();for _,c:=range cs{if c.ComponentKey==key{return c}};t.Fatalf("missing %s in %+v",key,cs);return Component{}}
func TestStorcliFixtures(t *testing.T){for _,kind:=range []Kind{"storcli","perccli"}{for _,name:=range []string{"optimal","degraded","failed","rebuilding-with-progress","predictive","missing-member","multi-controller","unrecognized-state","truncated","64-drive"}{t.Run(string(kind)+"/"+name,func(t *testing.T){b:=fixture(t,string(kind),name+".json");r,e:=parseStorcli(b,kind);if name=="truncated"{if e==nil{t.Fatal("truncated accepted")};return};if e!=nil||!r.Complete{t.Fatalf("%+v %v",r,e)};c:=findComponent(t,r.Components,string(kind)+":c0:e252:s0");if c.Source!=kind{t.Fatal(c)};switch name{case "degraded":if findComponent(t,r.Components,string(kind)+":c0:v0").State!="degraded"{t.Fatal(r)};case "failed":if c.State!="failed"{t.Fatal(c)};case "predictive":if !c.PredictiveFailure{t.Fatal(c)};case "missing-member":if c.State!="missing"{t.Fatal(c)};case "unrecognized-state":v:=findComponent(t,r.Components,string(kind)+":c0:v0");if v.State!="unknown"||*v.StateDetail!="NewVendorState"{t.Fatal(v)};case "multi-controller":findComponent(t,r.Components,string(kind)+":c1");case "rebuilding-with-progress":if c.ProgressPercent==nil||*c.ProgressPercent!=42{t.Fatal(c)};case "64-drive":n:=0;for _,p:=range r.Components{if p.ComponentType=="physical_disk"{n++}};if n!=64||len(b)<1000000{t.Fatalf("drives=%d bytes=%d",n,len(b))}}})}}}
func TestStorcliIncompleteObservations(t *testing.T){
 for _,kind:=range []Kind{"storcli","perccli"}{for _,bad:=range []string{"response","pd-list","vd-list","null-list","wrong-list","pd-row","pd-missing-id","pd-id","pd-empty-slot","pd-text-slot","vd-id","controller-id"}{t.Run(string(kind)+"/"+bad,func(t *testing.T){
  var doc map[string]any;if e:=json.Unmarshal(fixture(t,string(kind),"multi-controller.json"),&doc);e!=nil{t.Fatal(e)}
  ctl:=doc["Controllers"].([]any)[0].(map[string]any);data:=ctl["Response Data"].(map[string]any)
  pd:=data["PD LIST"].([]any)[0].(map[string]any)
  switch bad{
  case "response":delete(ctl,"Response Data")
  case "pd-list":delete(data,"PD LIST")
  case "vd-list":delete(data,"VD LIST")
  case "null-list":data["PD LIST"]=nil
  case "wrong-list":data["PD LIST"]=map[string]any{}
  case "pd-row":data["PD LIST"]=[]any{"invalid"}
  case "pd-missing-id":delete(pd,"EID:Slt")
  case "pd-id":pd["EID:Slt"]="unparseable"
  case "pd-empty-slot":pd["EID:Slt"]="252:"
  case "pd-text-slot":pd["EID:Slt"]="252:slot"
  case "vd-id":data["VD LIST"].([]any)[0].(map[string]any)["DG/VD"]="0/"
  case "controller-id":delete(ctl["Command Status"].(map[string]any),"Controller")
  }
  b,e:=json.Marshal(doc);if e!=nil{t.Fatal(e)};r,e:=parseStorcli(b,kind)
  if e!=nil||r.Complete||len(r.Warnings)==0{t.Fatalf("result=%+v error=%v",r,e)}
  findComponent(t,r.Components,string(kind)+":c1:e252:s0")
  if bad!="response"&&bad!="controller-id"{findComponent(t,r.Components,string(kind)+":c0")}
 })}}
}
func TestStorcliMalformedControllerSiblings(t *testing.T){
 for _,kind:=range []Kind{"storcli","perccli"}{for _,bad:=range []string{"string-id","fractional-id","negative-id","null-id","status-scalar","response-scalar","response-array","controller-scalar"}{for _,badIndex:=range []int{0,1}{t.Run(string(kind)+"/"+bad+"/"+string(rune('0'+badIndex)),func(t *testing.T){
  var doc map[string]any;if e:=json.Unmarshal(fixture(t,string(kind),"multi-controller.json"),&doc);e!=nil{t.Fatal(e)}
  controllers:=doc["Controllers"].([]any);ctl:=controllers[badIndex].(map[string]any);status:=ctl["Command Status"].(map[string]any)
  switch bad{case "string-id":status["Controller"]="0";case "fractional-id":status["Controller"]=0.5;case "negative-id":status["Controller"]=-1;case "null-id":status["Controller"]=nil;case "status-scalar":ctl["Command Status"]=true;case "response-scalar":ctl["Response Data"]=42;case "response-array":ctl["Response Data"]=[]any{};case "controller-scalar":controllers[badIndex]="bad"}
  b,e:=json.Marshal(doc);if e!=nil{t.Fatal(e)};r,e:=parseStorcli(b,kind)
  if e!=nil||r.Complete||len(r.Warnings)==0{t.Fatalf("result=%+v error=%v",r,e)}
  valid:=string(kind)+":c"+string(rune('0'+1-badIndex));findComponent(t,r.Components,valid);findComponent(t,r.Components,valid+":v0");findComponent(t,r.Components,valid+":e252:s0")
  for _,c:=range r.Components{if c.ComponentKey==string(kind)+":c"+string(rune('0'+badIndex)){t.Fatal("invalid controller emitted",c)}}
 })}}}
}
func TestStorcliBatterySections(t *testing.T){
 cases:=[]struct{name string;value any;complete bool;state string}{
  {"empty-record",[]any{map[string]any{}},false,""},
  {"null-section",nil,false,""},{"object-section",map[string]any{"State":"Failed"},false,""},{"scalar-section","bad",false,""},
  {"null-row",[]any{nil},false,""},{"scalar-row",[]any{"Failed"},false,""},
  {"null-state",[]any{map[string]any{"State":nil}},false,""},{"numeric-state",[]any{map[string]any{"State":0}},false,""},
  {"present-only",[]any{map[string]any{"Present":true}},false,""},{"wrong-present",[]any{map[string]any{"Present":"false","State":"Failed"}},false,""},
  {"mixed",[]any{map[string]any{"State":"Failed"},map[string]any{}},false,"failed"},
  {"empty-list",[]any{},true,""},{"absent",[]any{map[string]any{"Present":false}},true,"missing"},
  {"empty-state",[]any{map[string]any{"State":""}},true,"missing"},{"failed",[]any{map[string]any{"State":"Failed"}},true,"failed"},
  {"unknown-state",[]any{map[string]any{"State":"NewVendorState"}},true,"unknown"},
 }
 for _,kind:=range []Kind{"storcli","perccli"}{for section,suffix:=range map[string]string{"Cachevault_Info":"cv","BBU_Info":"bbu"}{for _,tc:=range cases{t.Run(string(kind)+"/"+section+"/"+tc.name,func(t *testing.T){
  var doc map[string]any;if e:=json.Unmarshal(fixture(t,string(kind),"optimal.json"),&doc);e!=nil{t.Fatal(e)}
  data:=doc["Controllers"].([]any)[0].(map[string]any)["Response Data"].(map[string]any);delete(data,"Cachevault_Info");data[section]=tc.value
  b,e:=json.Marshal(doc);if e!=nil{t.Fatal(e)};r,e:=parseStorcliSections(b,kind,"PD LIST","VD LIST",section)
  if e!=nil||r.Complete!=tc.complete||(!tc.complete&&len(r.Warnings)==0){t.Fatalf("result=%+v error=%v",r,e)}
  findComponent(t,r.Components,string(kind)+":c0:e252:s0")
  key:=string(kind)+":c0:"+suffix;found:=false;for _,c:=range r.Components{if c.ComponentKey==key{found=true;if c.State!=tc.state{t.Fatal(c)}}};if found!=(tc.state!=""){t.Fatal("malformed battery emitted or valid battery lost",r)}
 })}}}
}
func TestStorcliExplicitEmptyLists(t *testing.T){
 r,e:=parseStorcli([]byte(`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Status":{"Controller Status":"Optimal"},"PD LIST":[],"VD LIST":[]}}]}`),"storcli")
 if e!=nil||!r.Complete||len(r.Components)!=1{t.Fatalf("%+v %v",r,e)}
}
func TestStorcliMapping(t *testing.T){for typ,rows:=range map[ComponentType]map[string]string{
 "virtual_disk":{"Optl":"optimal","Dgrd":"degraded","Pdgd":"partially_degraded","OfLn":"offline","Rec":"rebuilding"},
 "physical_disk":{"Onln":"online","GHS":"hotspare","DHS":"hotspare","UGood":"ready","UBad":"failed","Rbld":"rebuilding","CpyBck":"copyback","JBOD":"jbod","Offln":"offline","Msng":"missing","UGShld":"shielded","UGUnsp":"unknown"},
 "cache_battery":{"Optimal":"ok","Learning":"learning","Learn cycle active":"learning","Charging":"charging","Degraded":"degraded","Needs Attention":"degraded","Failed":"failed","":"missing"},
 "controller":{"Optimal":"ok","Needs Attention":"degraded","Failed":"failed"},
 }{for raw,want:=range rows{if got:=vendorState(typ,raw);got!=want{t.Fatalf("%s %s=%s want %s",typ,raw,got,want)}}}}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: parseStorcli`. With the pre-review parser already implemented, run the new tests before replacing it:
```bash
cd agent && go test -race ./internal/collectors/hwhealth/... -run 'TestStorcli(BatterySections|MalformedControllerSiblings|IncompleteObservations)' -count=1
```
Expect red: malformed battery sections remain complete, and a wrong-type controller envelope loses its valid sibling.
- [ ] **Step 3: Implement the JSON mapping and bounded parser (5 min).** `storcli.go`:
```go
package hwhealth
import("bytes";"encoding/json";"fmt";"io";"regexp";"sort";"strconv";"strings")
type jsonObject=map[string]any
func textValue(v any)string{if v==nil{return ""};return fmt.Sprint(v)}
func number(v any)int{n,_:=strconv.ParseFloat(strings.TrimSuffix(textValue(v),"%"),64);return int(n)}
func walkJSON(v any,path string,fn func(jsonObject,string)){switch x:=v.(type){case map[string]any:fn(x,path);keys:=[]string{};for k:=range x{keys=append(keys,k)};sort.Strings(keys);for _,k:=range keys{walkJSON(x[k],path+"/"+k,fn)};case []any:for _,y:=range x{walkJSON(y,path,fn)}}}
var vendorStates=map[ComponentType]map[string]string{
 "controller":{"Optimal":"ok","Needs Attention":"degraded","Failed":"failed"},
 "virtual_disk":{"Optl":"optimal","Dgrd":"degraded","Pdgd":"partially_degraded","OfLn":"offline","Rec":"rebuilding"},
 "physical_disk":{"Onln":"online","GHS":"hotspare","DHS":"hotspare","UGood":"ready","UBad":"failed","Rbld":"rebuilding","CpyBck":"copyback","JBOD":"jbod","Offln":"offline","Msng":"missing","UGShld":"shielded","UGUnsp":"unknown"},
 "cache_battery":{"Optimal":"ok","Learning":"learning","Learn cycle active":"learning","Charging":"charging","Degraded":"degraded","Needs Attention":"degraded","Failed":"failed","":"missing"},
 "enclosure":{"OK":"ok","Optimal":"ok","Degraded":"degraded","Failed":"failed"},
}
func vendorState(typ ComponentType,raw string)string{if s,ok:=vendorStates[typ][raw];ok{return s};return "unknown"}
func sizeBytes(raw any)*int64{fields:=strings.Fields(textValue(raw));if len(fields)!=2{return nil};n,e:=strconv.ParseFloat(fields[0],64);if e!=nil||n<0{return nil};scale:=map[string]float64{"B":1,"KB":1e3,"MB":1e6,"GB":1e9,"TB":1e12,"KiB":1024,"MiB":1048576,"GiB":1073741824,"TiB":1099511627776}[fields[1]];if scale==0{return nil};return ptr(int64(n*scale))}
var drivePath=regexp.MustCompile(`/c[0-9]+/e([0-9]+)/s([0-9]+)`)
var storcliSlotID=regexp.MustCompile(`^([0-9]+|-):([0-9]+)$`)
var storcliVDID=regexp.MustCompile(`^[0-9]+/[0-9]+$`)
// Keep each controller opaque until its own decode; one bad envelope cannot discard siblings.
func decodeStorcliControllers(data []byte)([]json.RawMessage,error){
 if len(data)>4*1024*1024{return nil,fmt.Errorf("storcli output exceeds 4 MiB")}
 var doc struct{Controllers []json.RawMessage}
 dec:=json.NewDecoder(bytes.NewReader(data));if e:=dec.Decode(&doc);e!=nil{return nil,e}
 var extra any;if e:=dec.Decode(&extra);e!=io.EOF{return nil,fmt.Errorf("trailing storcli JSON")}
 if doc.Controllers==nil{return nil,fmt.Errorf("missing Controllers")};return doc.Controllers,nil
}
func storcliNumericID(v any)(string,bool){
 var raw string;switch n:=v.(type){case json.Number:raw=string(n);case string:raw=n;default:return "",false}
 if raw==""{return "",false};for _,c:=range raw{if c<'0'||c>'9'{return "",false}}
 n,e:=strconv.Atoi(raw);if e!=nil||n<0{return "",false};return strconv.Itoa(n),true
}
func decodeStorcliController(raw json.RawMessage)(string,jsonObject,error){
 var ctl jsonObject;dec:=json.NewDecoder(bytes.NewReader(raw));dec.UseNumber();if e:=dec.Decode(&ctl);e!=nil{return "",nil,e}
 status,ok:=ctl["Command Status"].(map[string]any);if !ok{return "",nil,fmt.Errorf("invalid Command Status")}
 if status["Status"]!="Success"{return "",nil,fmt.Errorf("storcli command failed: %s",textValue(status["Description"]))}
 // A controller index is a required JSON integer; a string or omitted value is invalid.
 n,ok:=status["Controller"].(json.Number);if !ok{return "",nil,fmt.Errorf("missing or invalid controller identity")}
 id,ok:=storcliNumericID(n);if !ok{return "",nil,fmt.Errorf("invalid controller identity")}
 data,ok:=ctl["Response Data"].(map[string]any);if !ok||data==nil{return "",nil,fmt.Errorf("controller %s: invalid Response Data",id)}
 return id,data,nil
}
// A present section must be a list of records. Only explicit evidence yields a battery.
func storcliBatteryState(m jsonObject)(string,bool){
 present,hasPresent:=m["Present"];if hasPresent{if _,ok:=present.(bool);!ok{return "",false}}
 value,hasState:=m["State"];raw,ok:=value.(string);if hasState&&!ok{return "",false}
 if hasPresent&&present==false{return "",true};if !hasState{return "",false};return raw,true
}
func parseStorcli(data []byte,kind Kind)(Result,error){return parseStorcliSections(data,kind,"PD LIST","VD LIST")}
// The overview requires both lists; individual commands require only their own section.
func parseStorcliSections(data []byte,kind Kind,required ...string)(Result,error){
 r:=Result{Complete:true};controllers,e:=decodeStorcliControllers(data);if e!=nil{return Result{},e}
 malformed:=func(message string){r.Complete=false;r.Warnings=append(r.Warnings,message)}
 for _,raw:=range controllers{
  id,data,e:=decodeStorcliController(raw);if e!=nil{malformed(e.Error());continue}
  ck:=controllerKey(kind,id);byKey:=map[string]Component{};members:=map[string][]string{}
  for _,section:=range required{v,ok:=data[section];if !ok||v==nil{malformed(ck+": missing "+section);continue};if section=="PD LIST"||section=="VD LIST"{if _,ok:=v.([]any);!ok{malformed(ck+": invalid "+section)}}}
  for _,section:=range []string{"PD LIST","VD LIST"}{
   raw,exists:=data[section];if !exists{continue};list,ok:=raw.([]any);if !ok{malformed(ck+": invalid "+section);continue}
   for _,row:=range list{m,ok:=row.(map[string]any);if !ok{malformed(ck+": invalid "+section+" row");continue}
    if section=="PD LIST"&&!storcliSlotID.MatchString(textValue(m["EID:Slt"])){malformed(ck+": invalid PD identity")}
    if section=="VD LIST"&&!storcliVDID.MatchString(textValue(m["DG/VD"])){malformed(ck+": invalid VD identity")}
   }
  }
  for section,suffix:=range map[string]string{"Cachevault_Info":"cv","BBU_Info":"bbu"}{
   raw,exists:=data[section];if !exists{continue};list,ok:=raw.([]any);if !ok{malformed(ck+": invalid "+section);continue}
   for _,row:=range list{m,ok:=row.(map[string]any);if !ok{malformed(ck+": invalid "+section+" row");continue}
    state,ok:=storcliBatteryState(m);if !ok{malformed(ck+": invalid "+section+" record");continue}
    key:=ck+":"+suffix;byKey[key]=component(kind,"cache_battery",key,ck,strings.ToUpper(suffix),state,vendorState("cache_battery",state))
   }
  }
  walkJSON(data,"",func(m jsonObject,path string){
   if raw,ok:=m["Controller Status"];ok{c:=component(kind,"controller",ck,"",ck,textValue(raw),vendorState("controller",textValue(raw)));if basics,ok:=data["Basics"].(map[string]any);ok{c.Name=textValue(basics["Model"]);c.Model=ptr(c.Name);c.Serial=ptr(textValue(basics["Serial Number"]));c.Firmware=ptr(textValue(basics["FW Package Build"]))};byKey[ck]=c}
   if id,ok:=m["DG/VD"];ok{parts:=strings.Split(textValue(id),"/");if !storcliVDID.MatchString(textValue(id)){malformed(ck+": invalid VD identity");return};key:=ck+":v"+parts[1];raw:=textValue(m["State"]);c:=component(kind,"virtual_disk",key,ck,"VD "+parts[1],raw,vendorState("virtual_disk",raw));c.SizeBytes=sizeBytes(m["Size"]);c.Attributes["raidLevel"]=m["TYPE"];c.Attributes["diskGroup"]=parts[0];byKey[key]=c}
   eid,sl:="","";if id,ok:=m["EID:Slt"];ok{p:=storcliSlotID.FindStringSubmatch(textValue(id));if len(p)!=3{malformed(ck+": invalid EID:Slt");return};eid,sl=p[1],p[2]}
   if sl==""{if p:=drivePath.FindStringSubmatch(path);len(p)==3{eid,sl=p[1],p[2]}}
   if sl!=""{
    key:=slotKey(ck,eid,sl);c,exists:=byKey[key];if !exists{c=component(kind,"physical_disk",key,ck,"Slot "+sl,"","unknown")}
    if raw,ok:=m["State"];ok{c.StateDetail=ptr(textValue(raw));c.State=vendorState("physical_disk",textValue(raw))}
    if sn,ok:=m["SN"];ok{c.Serial=ptr(strings.TrimSpace(textValue(sn)))};if model,ok:=m["Model"];ok{c.Model=ptr(strings.TrimSpace(textValue(model)))};if fw,ok:=m["Firmware Revision"];ok{c.Firmware=ptr(textValue(fw))}
    if size:=sizeBytes(m["Size"]);size!=nil{c.SizeBytes=size};c.Attributes["enclosure"]=eid;c.Attributes["slot"]=sl;if dg,ok:=m["DG"];ok{c.Attributes["diskGroup"]=textValue(dg)}
    for src,dst:=range map[string]string{"Media Error Count":"mediaErrors","Other Error Count":"otherErrors","Intf":"interface","Med":"mediaType"}{if v,ok:=m[src];ok{c.Attributes[dst]=v}}
    c.PredictiveFailure=c.PredictiveFailure||number(m["Predictive Failure Count"])>0||strings.EqualFold(textValue(m["S.M.A.R.T alert flagged by drive"]),"Yes")
    if v,ok:=m["Drive Temperature"];ok{fields:=strings.Fields(textValue(v));if len(fields)>0{c.TemperatureC=ptr(number(strings.Split(fields[0],"C")[0]))}}
    if v,ok:=m["Progress%"];ok{n:=number(v);if n>=0&&n<=100{c.ProgressPercent=ptr(n)}}
    byKey[key]=c;if dg,ok:=m["DG"];ok{members[textValue(dg)]=append(members[textValue(dg)],key)}
   }
   if id,ok:=m["EID"];ok&&strings.Contains(path,"Enclosure"){raw:=textValue(m["State"]);key:=ck+":enc"+textValue(id);byKey[key]=component(kind,"enclosure",key,ck,"Enclosure "+textValue(id),raw,vendorState("enclosure",raw))}
  })
  for key,c:=range byKey{if c.ComponentType=="virtual_disk"{ids:=members[textValue(c.Attributes["diskGroup"])];sort.Strings(ids);c.Attributes["memberKeys"]=ids;byKey[key]=c}}
  keys:=[]string{};for k:=range byKey{keys=append(keys,k)};sort.Strings(keys);for _,k:=range keys{r.Components=append(r.Components,byKey[k])}
 }
 if len(r.Components)==0&&!r.Complete{return r,fmt.Errorf("storcli commands failed: %v",r.Warnings)};return r,nil
}
func mergeComponents(dst,src []Component)[]Component{index:=map[string]int{};for i,c:=range dst{index[c.ComponentKey]=i};for _,c:=range src{if i,ok:=index[c.ComponentKey];ok{old:=dst[i];if c.State=="unknown"&&c.StateDetail!=nil&&*c.StateDetail==""&&old.State!="unknown"{c.State=old.State;c.StateDetail=old.StateDetail};if c.Serial==nil{c.Serial=old.Serial};if c.Model==nil{c.Model=old.Model};if c.Firmware==nil{c.Firmware=old.Firmware};if c.SizeBytes==nil{c.SizeBytes=old.SizeBytes};if c.TemperatureC==nil{c.TemperatureC=old.TemperatureC};if c.ProgressPercent==nil{c.ProgressPercent=old.ProgressPercent};c.PredictiveFailure=c.PredictiveFailure||old.PredictiveFailure;for k,v:=range old.Attributes{if _,ok:=c.Attributes[k];!ok{c.Attributes[k]=v}};dst[i]=c}else{index[c.ComponentKey]=len(dst);dst=append(dst,c)}};return dst}
```
Missing/null lists and malformed identities make the source incomplete, while all identifiable observations from that controller and its siblings remain available for upsert. Explicit empty lists establish absence; omitted lists do not. CV/BBU sections must be arrays; each record needs a string `State` (including the explicit empty string) or boolean `Present:false`. Null/wrong-type values and `[{}]` make the source incomplete without emitting a fabricated battery. Each raw controller is decoded independently, so wrong-type identities, wrappers and response objects cannot discard valid siblings. A malformed `EID:Slt` cannot fall back to a path and become a fabricated identity.
- [ ] **Step 4: Run green and inspect fixture size (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`; `64-drive.json` assertions prove ≥1 MB and exactly 64 PDs for both source kinds.
```bash
cd agent && go test -race ./internal/collectors/hwhealth/... -run 'TestStorcli(BatterySections|MalformedControllerSiblings|IncompleteObservations)' -count=1
```
All cases must pass for storcli and perccli, with valid siblings preserved whether the malformed controller comes first or last.
- [ ] **Step 5: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{storcli.go,storcli_test.go,testdata/storcli,testdata/perccli}
git commit -m $'feat(agent): parse Broadcom hardware states with large fixtures\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 6: Execute the Broadcom command sequence and join operation progress

**Files:** Create `agent/internal/collectors/hwhealth/storcli_source.go`, `agent/internal/collectors/hwhealth/storcli_source_test.go`.
**Test:** `agent/internal/collectors/hwhealth/storcli_source_test.go`.
**Interfaces:** Consumes `parseStorcliSections`, `decodeStorcliControllers`, `decodeStorcliController`, `storcliNumericID`, `runTool`, `lookupTool`; produces `newStorcli(kind Kind, extra []string, run toolRunner) Source`. `perccli` uses this function with `Kind("perccli")` and its own executable names.

- [ ] **Step 1: Write command and partial-observation tests (5 min).** `storcli_source_test.go`:
```go
package hwhealth
import("context";"encoding/json";"errors";"strings";"testing";"time")
func TestStorcliCommands(t *testing.T){calls:=[]string{};s:=newStorcli("perccli",nil,func(_ context.Context,d time.Duration,p string,args ...string)(execResult,error){calls=append(calls,strings.Join(args," "));if d!=30*time.Second{t.Fatal(d)};if len(calls)==3{return execResult{},errors.New("timeout")};if len(calls)>5{return execResult{Stdout:[]byte(`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Progress":[{"EID:Slt":"252:0","Progress%":42}]}}]}`)},nil};return execResult{Stdout:fixture(t,"perccli","optimal.json")},nil});r,e:=s.Collect(context.Background(),Availability{Path:"tool",Available:true});if e!=nil||r.Complete||len(r.Components)==0||len(calls)!=8{t.Fatalf("%+v %v %v",r,e,calls)};want:=[]string{"/call show all J","/call/vall show all J","/call/eall/sall show all J","/call/cv show all J","/call/bbu show all J","/call/eall/sall show rebuild J","/call/vall show init J","/call/vall show cc J"};for i,w:=range want{if calls[i]!=w{t.Fatal(calls)}};c:=findComponent(t,r.Components,"perccli:c0:e252:s0");if c.ProgressPercent==nil||*c.ProgressPercent!=42{t.Fatal(c)}}
func TestStorcliRequiredCommandSections(t *testing.T){
 for _,kind:=range []Kind{"storcli","perccli"}{for _,bad:=range []int{-1,0,1,2}{t.Run(string(kind)+"/"+string(rune('A'+bad+1)),func(t *testing.T){
  call:=0;src:=newStorcli(kind,nil,func(context.Context,time.Duration,string,...string)(execResult,error){
   i:=call;call++;if i>=5{return execResult{Stdout:[]byte(`{"Controllers":[]}`)},nil}
   var doc map[string]any;if e:=json.Unmarshal(fixture(t,string(kind),"optimal.json"),&doc);e!=nil{t.Fatal(e)}
   ctl:=doc["Controllers"].([]any)[0].(map[string]any);data:=ctl["Response Data"].(map[string]any)
   switch i{case 1:ctl["Response Data"]=map[string]any{"VD LIST":data["VD LIST"]};case 2:ctl["Response Data"]=map[string]any{"PD LIST":data["PD LIST"]};case 3:ctl["Response Data"]=map[string]any{"Cachevault_Info":data["Cachevault_Info"]};case 4:ctl["Response Data"]=map[string]any{"BBU_Info":[]any{map[string]any{"State":"Optimal"}}}}
   if i==bad{if i==0{delete(ctl,"Response Data")}else{ctl["Response Data"]=map[string]any{}}}
   b,e:=json.Marshal(doc);if e!=nil{t.Fatal(e)};return execResult{Stdout:b},nil
  })
  r,e:=src.Collect(context.Background(),Availability{Available:true,Path:"fixture"})
  if e!=nil||r.Complete!=(bad==-1)||call!=8{t.Fatalf("%+v %v calls=%d",r,e,call)}
  findComponent(t,r.Components,string(kind)+":c0:e252:s0")
  findComponent(t,r.Components,string(kind)+":c0:v0")
 })}}
}
func TestStorcliSplitMembershipAndProgressFailure(t *testing.T){
 replies:=[]string{
 `{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Status":{"Controller Status":"Optimal"}}}]}`,
 `{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"VD LIST":[{"DG/VD":"0/0","State":"Optl"}]}}]}`,
 `{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"PD LIST":[{"EID:Slt":"1:2","DG":0,"State":"Onln"}]}}]}`,
 `{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Cachevault_Info":[{"Present":false}]}}]}`,
 `{"Controllers":[]}`, "", 
 `{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Progress":[{"VD":0,"Progress%":23}]}}]}`,
 `{"Controllers":[]}`,
 }
 call:=0;src:=newStorcli("storcli",nil,func(context.Context,time.Duration,string,...string)(execResult,error){i:=call;call++;if i==5{return execResult{},errors.New("rebuild query failed")};return execResult{Stdout:[]byte(replies[i])},nil})
 r,e:=src.Collect(context.Background(),Availability{Available:true,Path:"fixture"});if e!=nil||r.Complete{t.Fatalf("%+v %v",r,e)}
 vd:=findComponent(t,r.Components,"storcli:c0:v0");if vd.State!="initializing"||vd.ProgressPercent==nil||*vd.ProgressPercent!=23{t.Fatal(vd)}
 keys,ok:=vd.Attributes["memberKeys"].([]string);if !ok||len(keys)!=1||keys[0]!="storcli:c0:e1:s2"{t.Fatal(vd.Attributes)}
 if findComponent(t,r.Components,"storcli:c0:cv").State!="missing"{t.Fatal("confirmed absent cache battery lost")}
}
func TestStorcliProgressIdentity(t *testing.T){
 cases:=[]struct{name string;controller any;row map[string]any;valid bool;pd bool}{
  {"missing-controller",nil,map[string]any{"VD":0},false,false},
  {"string-controller","0",map[string]any{"VD":0},false,false},
  {"negative-controller",-1,map[string]any{"VD":0},false,false},
  {"fractional-controller",0.5,map[string]any{"VD":0},false,false},
  {"missing-vd",0,map[string]any{},false,false},{"null-vd",0,map[string]any{"VD":nil},false,false},
  {"negative-vd",0,map[string]any{"VD":-1},false,false},{"fractional-vd",0,map[string]any{"VD":0.5},false,false},
  {"object-vd",0,map[string]any{"VD":map[string]any{}},false,false},
  {"cross-controller-vd",0,map[string]any{"VD":"/c1/v0"},false,false},
  {"conflicting-vd",0,map[string]any{"VD":0,"VD ID":1},false,false},
  {"unobserved-vd",0,map[string]any{"VD":1},false,false},
  {"missing-slot",0,map[string]any{"EID:Slt":"252:"},false,true},
  {"text-slot",0,map[string]any{"EID:Slt":"252:slot"},false,true},
  {"cross-controller-drive",0,map[string]any{"Drive-ID":"/c1/e252/s0"},false,true},
  {"invalid-drive-fallback",0,map[string]any{"Drive-ID":"bad","EID:Slt":"252:0"},false,true},
  {"conflicting-drive",0,map[string]any{"Drive-ID":"/c0/e252/s1","EID:Slt":"252:0"},false,true},
  {"valid-vd-zero",0,map[string]any{"VD":0},true,false},
  {"valid-vd-path",0,map[string]any{"VD ID":"/c0/v0"},true,false},
  {"valid-slot",0,map[string]any{"EID:Slt":"252:0"},true,true},
  {"valid-drive",0,map[string]any{"Drive-ID":"/c0/e252/s0"},true,true},
 }
 for _,kind:=range []Kind{"storcli","perccli"}{for _,operation:=range []int{1,2}{for _,tc:=range cases{t.Run(string(kind)+"/"+tc.name+"/"+string(rune('0'+operation)),func(t *testing.T){
  r,e:=parseStorcli(fixture(t,string(kind),"multi-controller.json"),kind);if e!=nil{t.Fatal(e)}
  status:=map[string]any{"Status":"Success"};if tc.controller!=nil{status["Controller"]=tc.controller}
  row:=map[string]any{"Progress%":23};for k,v:=range tc.row{row[k]=v}
  // Keep a valid sibling AFTER the bad controller to prove parsing continues on errors.
  controllers:=[]any{map[string]any{"Command Status":status,"Response Data":map[string]any{"Progress":[]any{row}}},map[string]any{"Command Status":map[string]any{"Controller":1,"Status":"Success"},"Response Data":map[string]any{"Progress":[]any{map[string]any{"VD":0,"Progress%":61}}}}}
  b,e:=json.Marshal(map[string]any{"Controllers":controllers});if e!=nil{t.Fatal(e)};e=applyStorcliProgress(b,kind,&r,operation)
  if (e==nil)!=tc.valid||r.Complete!=tc.valid{t.Fatalf("valid=%v result=%+v error=%v",tc.valid,r,e)}
  key:=string(kind)+":c0:v0";wantState:="optimal";if tc.pd{key=string(kind)+":c0:e252:s0";wantState="online"}
  if tc.valid&&!tc.pd{wantState="initializing";if operation==2{wantState="checking"}}
  c:=findComponent(t,r.Components,key);if c.State!=wantState||(c.ProgressPercent!=nil)!=tc.valid{t.Fatal(c)};if tc.valid&&*c.ProgressPercent!=23{t.Fatal(c)}
  sibling:=findComponent(t,r.Components,string(kind)+":c1:v0");if sibling.ProgressPercent==nil||*sibling.ProgressPercent!=61{t.Fatal("valid sibling lost",sibling)}
 })}}}
}
func TestStorcliProgressTargetIdentity(t *testing.T){
 for _,bad:=range []string{"source","type","parent","missing-parent"}{t.Run(bad,func(t *testing.T){
  c:=component("storcli","virtual_disk","storcli:c0:v0","storcli:c0","VD","Optl","optimal")
  switch bad{case "source":c.Source="perccli";case "type":c.ComponentType="physical_disk";case "parent":c.ParentKey=ptr("storcli:c1");case "missing-parent":c.ParentKey=nil}
  r:=Result{Complete:true,Components:[]Component{c}}
  b:=[]byte(`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Progress":[{"VD":0,"Progress%":23}]}}]}`)
  if e:=applyStorcliProgress(b,"storcli",&r,1);e==nil||r.Complete{t.Fatal("mismatched target accepted",r,e)}
  if r.Components[0].State!="optimal"||r.Components[0].ProgressPercent!=nil{t.Fatal("mismatched target changed",r.Components[0])}
 })}
}
func TestStorcliProgressMalformedResponseAndPath(t *testing.T){
 for _,data:=range []any{42,[]any{},nil,map[string]any{"Drive /c1/e252/s0":map[string]any{"Progress%":23}}}{
  r,e:=parseStorcli(fixture(t,"storcli","multi-controller.json"),"storcli");if e!=nil{t.Fatal(e)}
  doc:=map[string]any{"Controllers":[]any{map[string]any{"Command Status":map[string]any{"Controller":0,"Status":"Success"},"Response Data":data},map[string]any{"Command Status":map[string]any{"Controller":1,"Status":"Success"},"Response Data":map[string]any{"Drive /c1/e252/s0":map[string]any{"Progress%":61}}}}}
  b,e:=json.Marshal(doc);if e!=nil{t.Fatal(e)};if e=applyStorcliProgress(b,"storcli",&r,0);e==nil||r.Complete{t.Fatal("invalid identity accepted",r,e)}
  if findComponent(t,r.Components,"storcli:c0:e252:s0").ProgressPercent!=nil{t.Fatal("wrong controller changed")}
  c:=findComponent(t,r.Components,"storcli:c1:e252:s0");if c.ProgressPercent==nil||*c.ProgressPercent!=61{t.Fatal(c)}
 }
}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: newStorcli`. `TestStorcliRequiredCommandSections` also rejects successful but empty overview/VD/PD replies while keeping observations from other commands; the complete split-command case must remain complete. Add the identity regressions before changing an existing implementation:
```bash
cd agent && go test -race ./internal/collectors/hwhealth/... -run 'TestStorcliProgress' -count=1
```
Expect red: the identityless controller changes `c0:v0`, and the existing parser accepts cross-controller paths or stops before processing a valid sibling.
- [ ] **Step 3: Implement read-only commands and progress (5 min).** `storcli_source.go`:
```go
package hwhealth
import("context";"errors";"fmt";"math";"regexp";"sort";"strconv";"strings";"time")
var storcliCommands=[][]string{{"/call","show","all","J"},{"/call/vall","show","all","J"},{"/call/eall/sall","show","all","J"},{"/call/cv","show","all","J"},{"/call/bbu","show","all","J"},{"/call/eall/sall","show","rebuild","J"},{"/call/vall","show","init","J"},{"/call/vall","show","cc","J"}}
func newStorcli(kind Kind,extra []string,run toolRunner)Source{return &source{kind:kind,tier:TierRAID,detect:func(context.Context)Availability{p,ok:=lookupTool([]string{string(kind)+"64",string(kind)},extra);return Availability{Path:p,Available:ok}},collect:func(ctx context.Context,a Availability)(Result,error){
 r:=Result{Complete:true};progress:=[3][]byte{}
 for i,args:=range storcliCommands{if ctx.Err()!=nil{r.Complete=false;r.Warnings=append(r.Warnings,"budget exceeded");break};out,e:=run(ctx,30*time.Second,a.Path,args...)
  if e==nil&&out.ExitCode!=0{e=fmt.Errorf("exit %d",out.ExitCode)}
  if e!=nil{r.Complete=false;r.Warnings=append(r.Warnings,strings.Join(args," ")+": "+e.Error());continue}
  if i>=5{progress[i-5]=out.Stdout;continue}
  required:=[][]string{{"PD LIST","VD LIST"},{"VD LIST"},{"PD LIST"},{"Cachevault_Info"},{"BBU_Info"}}
  parsed,e:=parseStorcliSections(out.Stdout,kind,required[i]...);if e!=nil{r.Complete=false;r.Warnings=append(r.Warnings,e.Error());continue};r.Complete=r.Complete&&parsed.Complete;r.Warnings=append(r.Warnings,parsed.Warnings...);r.Components=mergeComponents(r.Components,parsed.Components)
 }
 joinStorcliMembers(r.Components)
 for i,b:=range progress{if b==nil{continue};if e:=applyStorcliProgress(b,kind,&r,i);e!=nil{r.Complete=false;r.Warnings=append(r.Warnings,e.Error())}}
 if len(r.Components)==0&&!r.Complete{return r,fmt.Errorf("all %s queries failed: %v",kind,r.Warnings)};return r,nil
}}}
func joinStorcliMembers(rows []Component){
 for i:=range rows{v:=&rows[i];if v.ComponentType!="virtual_disk"||v.ParentKey==nil{continue};keys:=[]string{};for _,p:=range rows{if p.ComponentType=="physical_disk"&&p.ParentKey!=nil&&*p.ParentKey==*v.ParentKey&&p.Attributes["diskGroup"]!=nil&&textValue(p.Attributes["diskGroup"])==textValue(v.Attributes["diskGroup"]){keys=append(keys,p.ComponentKey)}};sort.Strings(keys);v.Attributes["memberKeys"]=keys}
}
var storcliProgressDrive=regexp.MustCompile(`^/c([0-9]+)/e([0-9]+)/s([0-9]+)$`)
var storcliProgressPath=regexp.MustCompile(`/c([0-9]+)/e([0-9]+)/s([0-9]+)(?:/|$)`)
var storcliProgressVD=regexp.MustCompile(`^/c([0-9]+)/v([0-9]+)$`)
func storcliProgressKey(m jsonObject,path string,kind Kind,controller string)(string,ComponentType,error){
 ck:=controllerKey(kind,controller);key:="";var typ ComponentType
 accept:=func(candidate string,t ComponentType)bool{if key!=""&&(candidate!=key||typ!=t){return false};key,typ=candidate,t;return true}
 drive:=func(p []string)bool{if len(p)!=4{return false};c,ok:=storcliNumericID(p[1]);if !ok||c!=controller{return false};enclosure,ok:=storcliNumericID(p[2]);if !ok{return false};slot,ok:=storcliNumericID(p[3]);return ok&&accept(slotKey(ck,enclosure,slot),"physical_disk")}
 invalid:=func()(string,ComponentType,error){return "","",fmt.Errorf("%s: missing, invalid or conflicting progress identity",ck)}
 if raw,exists:=m["Drive-ID"];exists{v,ok:=raw.(string);if !ok||!drive(storcliProgressDrive.FindStringSubmatch(v)){return invalid()}}
 for _,p:=range storcliProgressPath.FindAllStringSubmatch(path,-1){if !drive(p){return invalid()}}
 if raw,exists:=m["EID:Slt"];exists{
  v,ok:=raw.(string);if !ok{return invalid()};p:=storcliSlotID.FindStringSubmatch(v);if len(p)!=3{return invalid()}
  enclosure:=p[1];if enclosure!="-"{enclosure,ok=storcliNumericID(enclosure);if !ok{return invalid()}};slot,ok:=storcliNumericID(p[2]);if !ok||!accept(slotKey(ck,enclosure,slot),"physical_disk"){return invalid()}
 }
 for _,field:=range []string{"VD","VD ID"}{if raw,exists:=m[field];exists{
  id,ok:=storcliNumericID(raw)
  if !ok{v,isString:=raw.(string);if !isString{return invalid()};p:=storcliProgressVD.FindStringSubmatch(v);if len(p)!=3{return invalid()};c,valid:=storcliNumericID(p[1]);if !valid||c!=controller{return invalid()};id,ok=storcliNumericID(p[2])}
  if !ok||!accept(ck+":v"+id,"virtual_disk"){return invalid()}
 }}
 if key==""{return invalid()};return key,typ,nil
}
func applyStorcliProgress(b []byte,kind Kind,r *Result,operation int)(err error){
 defer func(){if err!=nil{r.Complete=false}}()
 controllers,e:=decodeStorcliControllers(b);if e!=nil{return e};issues:=[]error{}
 for _,raw:=range controllers{
  id,data,e:=decodeStorcliController(raw);if e!=nil{issues=append(issues,e);continue};ck:=controllerKey(kind,id)
  walkJSON(data,"",func(m jsonObject,path string){
   raw,exists:=m["Progress%"];if !exists{return}
   key,typ,e:=storcliProgressKey(m,path,kind,id);if e!=nil{issues=append(issues,e);return}
   value,e:=strconv.ParseFloat(strings.TrimSuffix(textValue(raw),"%"),64);if e!=nil||math.IsNaN(value)||math.IsInf(value,0)||value<0||value>100{issues=append(issues,fmt.Errorf("%s: invalid progress",key));return}
   for j:=range r.Components{c:=&r.Components[j];if c.ComponentKey!=key{continue}
    if c.Source!=kind||c.ComponentType!=typ||c.ParentKey==nil||*c.ParentKey!=ck{issues=append(issues,fmt.Errorf("%s: progress target identity mismatch",key));return}
    c.ProgressPercent=ptr(int(value));if typ=="virtual_disk"&&c.State=="optimal"{if operation==1{c.State="initializing"};if operation==2{c.State="checking"}};return
   }
   issues=append(issues,fmt.Errorf("%s: progress target not observed",key))
  })
 };return errors.Join(issues...)
}
```
Decision: unsupported progress queries or a failed battery query make the source incomplete, never manufacture `missing`. Explicit successful CV/BBU records with `Present: false` or empty State map to missing; an absent field alone is not evidence of absent hardware. Progress uses the same independent controller decoder as inventory. Missing/wrong-type/negative controller IDs, malformed component IDs, conflicting identifiers and cross-controller paths make the result incomplete and never mutate that row; valid sibling progress still applies. The target must already exist with the same source, component type and parent controller. A later W02b source can reuse the same runner without changing other collectors.
- [ ] **Step 4: Run green (2 min).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/... -run 'TestStorcli' -count=1
```
```bash
cd agent && go test -race ./internal/collectors/hwhealth/...
```
Both commands must return exit code 0; valid zero-valued controller/VD IDs still apply initialization and consistency-check progress.
- [ ] **Step 5: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{storcli_source.go,storcli_source_test.go}
git commit -m $'feat(agent): collect Broadcom commands and operation progress\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 7: Collect Linux md arrays and resolve stable member identities

**Files:** Modify `agent/internal/collectors/hwhealth/source.go` (created in Task 1, append after `Collect`); Create `agent/internal/collectors/hwhealth/mdadm.go`, `agent/internal/collectors/hwhealth/mdadm_linux.go`, `agent/internal/collectors/hwhealth/mdadm_other.go`, `agent/internal/collectors/hwhealth/mdadm_test.go` and `agent/internal/collectors/hwhealth/testdata/mdadm/{optimal,degraded,failed,rebuilding-with-progress,predictive,missing-member,multi-controller,unrecognized-state,truncated}.{mdstat,detail}.txt`.
**Test:** `agent/internal/collectors/hwhealth/mdadm_test.go`.
**Interfaces:** Produces `newMDADM(extra []string, run toolRunner, members map[string]string) Source`, `parseMD(name, mdstat, detail string, stable func(string) string, remembered map[string]string) (Result, error)`. Task 12 persists the remembered array-role → stable-device-id map in `hwhealth_state.json`.

- [ ] **Step 1: Create fixtures and tests (5 min).**
```bash
python3 - <<'PY'
from pathlib import Path
p=Path('agent/internal/collectors/hwhealth/testdata/mdadm');p.mkdir(parents=True,exist_ok=True)
for name in ('optimal','degraded','failed','rebuilding-with-progress','predictive','missing-member','multi-controller','unrecognized-state','truncated'):
 state={'degraded':'clean, degraded','failed':'inactive','rebuilding-with-progress':'clean, recovering','unrecognized-state':'vendor-new'}.get(name,'clean')
 member='removed' if name=='missing-member' else 'active sync /dev/sda1'
 number='-' if name=='missing-member' else '0'
 detail=f'/dev/md0:\n        Raid Level : raid1\n        Array Size : 1000000\n             State : {state}\n              UUID : array-uuid\n    Number   Major   Minor   RaidDevice State\n       {number}       8       1        0      {member}\n'
 stat='md0 : active raid1 sda1[0]\n      1000000 blocks [2/2] [UU]\n'
 if name=='rebuilding-with-progress':stat+='      [==>...] recovery = 42.5% (425/1000) finish=1min\n'
 if name=='multi-controller':stat+='md1 : active raid1 sdb1[0]\n'
 if name=='truncated':detail='/dev/md0:\n State :'
 (p/(name+'.mdstat.txt')).write_text(stat);(p/(name+'.detail.txt')).write_text(detail)
PY
```
`mdadm_test.go`:
```go
package hwhealth
import "testing"
func TestMDFixtures(t *testing.T){for _,name:=range []string{"optimal","degraded","failed","rebuilding-with-progress","predictive","missing-member","multi-controller","unrecognized-state","truncated"}{t.Run(name,func(t *testing.T){r,e:=parseMD("md0",string(fixture(t,"mdadm",name+".mdstat.txt")),string(fixture(t,"mdadm",name+".detail.txt")),func(string)string{return "ata-S1-part1"},map[string]string{"md0/0":"ata-S1-part1"});if name=="truncated"{if e==nil{t.Fatal("accepted truncation")};return};if e!=nil{t.Fatal(e)};v:=findComponent(t,r.Components,"mdadm:md0");p:=findComponent(t,r.Components,"mdadm:md0:m:ata-S1-part1");want:=map[string]string{"degraded":"degraded","failed":"failed","rebuilding-with-progress":"rebuilding","unrecognized-state":"unknown"}[name];if want==""{want="optimal"};if v.State!=want{t.Fatal(v)};if name=="rebuilding-with-progress"&&(v.ProgressPercent==nil||*v.ProgressPercent!=42){t.Fatal(v)};if name=="missing-member"&&p.State!="missing"{t.Fatal(p)};if name=="predictive"&&p.PredictiveFailure{t.Fatal("mdadm must not invent prediction")}})}}
func TestMDUnidentifiedRemovedMember(t *testing.T){r,e:=parseMD("md0",string(fixture(t,"mdadm","missing-member.mdstat.txt")),string(fixture(t,"mdadm","missing-member.detail.txt")),func(string)string{return ""},map[string]string{});if e!=nil||r.Complete{t.Fatalf("%+v %v",r,e)}}
func TestMDMappings(t *testing.T){for raw,want:=range map[string]string{"clean":"optimal","active":"optimal","clean, degraded":"degraded","recovering":"rebuilding","resyncing":"rebuilding","checking":"checking","reshaping":"migrating","inactive":"failed","new":"unknown"}{if mdArrayState(raw)!=want{t.Fatal(raw)}};for raw,want:=range map[string]string{"active sync":"online","faulty":"failed","spare":"hotspare","spare rebuilding":"rebuilding","removed":"missing","writemostly":"online","new":"unknown"}{if mdMemberState(raw)!=want{t.Fatal(raw)}}}
func TestMDSpareWithoutRaidRole(t *testing.T){
 detail:="/dev/md0:\n State : clean\n Number Major Minor RaidDevice State\n 2 8 3 - spare /dev/sdc1\n"
 r,e:=parseMD("md0","md0 : active raid1\n",detail,func(string)string{return "ata-SPARE"},map[string]string{})
 if e!=nil||!r.Complete{t.Fatalf("%+v %v",r,e)}
 if findComponent(t,r.Components,"mdadm:md0:m:ata-SPARE").State!="hotspare"{t.Fatal(r)}
}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: parseMD`.
- [ ] **Step 3: Implement portable text normalization (5 min).** `mdadm.go`:
```go
package hwhealth
import("fmt";"regexp";"strconv";"strings")
var mdProgress=regexp.MustCompile(`(recovery|resync|check|reshape)\s*=\s*([0-9.]+)%`)
func mdArrayState(raw string)string{for _,x:=range []struct{in,out string}{{"inactive","failed"},{"recovering","rebuilding"},{"resyncing","rebuilding"},{"checking","checking"},{"reshaping","migrating"},{"degraded","degraded"},{"clean","optimal"},{"active","optimal"}}{if strings.Contains(raw,x.in){return x.out}};return "unknown"}
func mdMemberState(raw string)string{for _,x:=range []struct{in,out string}{{"faulty","failed"},{"removed","missing"},{"spare rebuilding","rebuilding"},{"spare","hotspare"},{"active sync","online"},{"writemostly","online"}}{if strings.Contains(raw,x.in){return x.out}};return "unknown"}
func parseMD(name,mdstat,detail string,stable func(string)string,remembered map[string]string)(Result,error){
 r:=Result{Complete:true};raw:="";hasHeader:=false;for _,line:=range strings.Split(detail,"\n"){p:=strings.SplitN(line,":",2);if len(p)==2&&strings.TrimSpace(p[0])=="State"{raw=strings.TrimSpace(p[1])};if strings.Contains(line,"RaidDevice State"){hasHeader=true}}
 if raw==""||!hasHeader{return Result{},fmt.Errorf("incomplete mdadm detail")};vk:="mdadm:"+name
 ctrl:=component("mdadm","controller","mdadm:ctrl","","Linux md","active","ok");vd:=component("mdadm","virtual_disk",vk,"mdadm:ctrl",name,raw,mdArrayState(raw))
 section:="";active:=false;for _,line:=range strings.Split(mdstat,"\n"){if strings.Contains(line," : "){active=strings.HasPrefix(line,name+" : ")};if active{section+=line+"\n"}}
 if p:=mdProgress.FindStringSubmatch(section);len(p)==3{n,_:=strconv.ParseFloat(p[2],64);if n>=0&&n<=100{vd.ProgressPercent=ptr(int(n));vd.State=map[string]string{"recovery":"rebuilding","resync":"rebuilding","check":"checking","reshape":"migrating"}[p[1]]}}
 rows:=[]Component{};keys:=[]string{};for _,line:=range strings.Split(detail,"\n"){
  f:=strings.Fields(line);if len(f)<5{continue};if _,e:=strconv.Atoi(f[0]);e!=nil&&f[0]!="-"{continue};_,roleErr:=strconv.Atoi(f[3]);if roleErr!=nil&&f[3]!="-"{continue}
  role:=name+"/"+f[3];last:=f[len(f)-1];dev:="";if strings.HasPrefix(last,"/dev/"){dev=last;f=f[:len(f)-1]};stateRaw:=strings.Join(f[4:]," ");id:=""
  if dev!=""{id=stable(dev);if id!=""&&roleErr==nil{remembered[role]=id}}else if roleErr==nil{id=remembered[role]}
  if id==""{r.Complete=false;r.Warnings=append(r.Warnings,"no stable identity for "+role);continue}
  key:=memberKey(vk,id);c:=component("mdadm","physical_disk",key,"mdadm:ctrl",id,stateRaw,mdMemberState(stateRaw));c.Attributes["osDevice"]=dev;rows=append(rows,c);keys=append(keys,key)
 };vd.Attributes["memberKeys"]=keys;r.Components=append([]Component{ctrl,vd},rows...);return r,nil
}
```
- [ ] **Step 4: Implement Linux discovery and unsupported stub (5 min).** `mdadm_linux.go`:
```go
//go:build linux
package hwhealth
import("context";"fmt";"os";"path/filepath";"regexp";"sort";"time")
var mdNames=regexp.MustCompile(`(?m)^(md[^ ]+)\s+:`)
func stableMDDevice(dev string)string{target,e:=filepath.EvalSymlinks(dev);if e!=nil{return ""};paths,_:=filepath.Glob("/dev/disk/by-id/*");sort.Strings(paths);for _,p:=range paths{resolved,e:=filepath.EvalSymlinks(p);if e==nil&&resolved==target{return filepath.Base(p)}};return ""}
func newMDADM(extra []string,run toolRunner,members map[string]string)Source{return &source{kind:"mdadm",tier:TierRAID,detect:func(context.Context)Availability{b,e:=os.ReadFile("/proc/mdstat");p,ok:=lookupTool([]string{"mdadm"},extra);return Availability{Path:p,Available:e==nil&&mdNames.Match(b)&&ok}},collect:func(ctx context.Context,a Availability)(Result,error){
 b,e:=os.ReadFile("/proc/mdstat");if e!=nil{return Result{},e};r:=Result{Complete:true};for _,m:=range mdNames.FindAllSubmatch(b,-1){name:=string(m[1]);out,e:=run(ctx,15*time.Second,a.Path,"--detail","/dev/"+name);if e==nil&&out.ExitCode!=0{e=fmt.Errorf("mdadm exit %d",out.ExitCode)};if e!=nil{r.Complete=false;r.Warnings=append(r.Warnings,e.Error());continue};part,e:=parseMD(name,string(b),string(out.Stdout),stableMDDevice,members);if e!=nil{r.Complete=false;r.Warnings=append(r.Warnings,e.Error());continue};r.Components=mergeComponents(r.Components,part.Components);r.Complete=r.Complete&&part.Complete;r.Warnings=append(r.Warnings,part.Warnings...)};if !r.Complete&&len(r.Components)==0{return r,fmt.Errorf("mdadm collection failed: %v",r.Warnings)};return r,nil
}}}
```
`mdadm_other.go`:
```go
//go:build !linux
package hwhealth
func newMDADM(extra []string,run toolRunner,members map[string]string)Source{return unavailableSource("mdadm",TierRAID)}
```
Append to `source.go` (register this modification in this task's commit):
```go
func unavailableSource(k Kind,t Tier)Source{return &source{kind:k,tier:t,detect:func(context.Context)Availability{return Availability{}},collect:func(context.Context,Availability)(Result,error){return Result{},nil}}}
```
Decision: never fall back to `/dev/sdX`. A removed member reuses the persisted last known by-id for its array role; without prior identity omit it and mark incomplete. A native Linux md fixture tests the resolver with symlinks during W06; unit tests inject it and never read the host's arrays.
- [ ] **Step 5: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`.
- [ ] **Step 6: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{mdadm.go,mdadm_linux.go,mdadm_other.go,mdadm_test.go,source.go,testdata/mdadm}
git commit -m $'feat(agent): observe md arrays with stable member keys\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 8: Observe Storage Spaces pools, virtual disks and members

**Files:** Create `agent/internal/collectors/hwhealth/storagespaces.go`, `agent/internal/collectors/hwhealth/storagespaces_windows.go`, `agent/internal/collectors/hwhealth/storagespaces_other.go`, `agent/internal/collectors/hwhealth/storagespaces_test.go` and `agent/internal/collectors/hwhealth/testdata/storage_spaces/{optimal,degraded,failed,rebuilding-with-progress,predictive,missing-member,multi-controller,unrecognized-state,truncated}.json`.
**Test:** `agent/internal/collectors/hwhealth/storagespaces_test.go`.
**Interfaces:** Produces `parseSpaces([]byte) (Result, error)`, `newStorageSpaces() Source`; portable `windowsDisk`, `windowsState`, `osHealth` are consumed by Task 9. Pool=enclosure, not a new component type; VD ObjectId hashes and pool ObjectId hashes never use enumeration index.

- [ ] **Step 1: Generate fixtures and write Windows mapping tests (5 min).**
```bash
python3 - <<'PY'
from pathlib import Path
import json
p=Path('agent/internal/collectors/hwhealth/testdata/storage_spaces');p.mkdir(parents=True,exist_ok=True)
for name in ('optimal','degraded','failed','rebuilding-with-progress','predictive','missing-member','multi-controller','unrecognized-state'):
 op={'degraded':'Degraded','failed':'Detached','rebuilding-with-progress':'InService','unrecognized-state':'NewState'}.get(name,'OK')
 pd={'UniqueId':'PD1','ObjectId':'disk1','SerialNumber':'S1','FriendlyName':'Disk','HealthStatus':'Healthy','OperationalStatus':[{'predictive':'Predictive Failure','missing-member':'Lost Communication'}.get(name,'OK')],'Size':1000,'Usage':'AutoSelect'}
 vd={'ObjectId':'VD1','FriendlyName':'Mirror','HealthStatus':'Healthy','OperationalStatus':[op],'Size':1000,'MemberIds':['PD1'],'Progress':42 if name=='rebuilding-with-progress' else None}
 doc={'Pools':[{'ObjectId':'POOL1','FriendlyName':'Pool','HealthStatus':'Healthy'}],'VirtualDisks':[vd],'PhysicalDisks':[pd],'Warnings':[]}
 if name=='multi-controller':doc['Pools'].append({'ObjectId':'POOL2','FriendlyName':'Pool2','HealthStatus':'Warning'})
 (p/(name+'.json')).write_text(json.dumps(doc))
(p/'truncated.json').write_text('{"Pools":[')
PY
```
`storagespaces_test.go`:
```go
package hwhealth
import "testing"
func TestSpacesFixtures(t *testing.T){for _,name:=range []string{"optimal","degraded","failed","rebuilding-with-progress","predictive","missing-member","multi-controller","unrecognized-state","truncated"}{r,e:=parseSpaces(fixture(t,"storage_spaces",name+".json"));if name=="truncated"{if e==nil{t.Fatal("truncation accepted")};continue};if e!=nil||!r.Complete{t.Fatalf("%s %+v %v",name,r,e)};v:=findComponent(t,r.Components,"storage_spaces:vd:"+objectHash("VD1"));want:=map[string]string{"degraded":"degraded","failed":"offline","rebuilding-with-progress":"rebuilding","unrecognized-state":"unknown"}[name];if want==""{want="optimal"};if v.State!=want{t.Fatalf("%s %+v",name,v)};if name=="rebuilding-with-progress"&&(v.ProgressPercent==nil||*v.ProgressPercent!=42){t.Fatal(v)}}}
func TestWindowsMappings(t *testing.T){for raw,want:=range map[string]string{"OK":"optimal","InService":"rebuilding","Degraded":"degraded","Detached":"offline","Incomplete":"degraded","No Redundancy":"degraded","new":"unknown"}{if windowsState("virtual_disk",[]string{raw},"","Healthy")!=want{t.Fatal(raw)}};for raw,want:=range map[string]string{"OK":"online","Predictive Failure":"predictive_failure","Lost Communication":"missing","Transient Error":"degraded","Starting":"online","new":"unknown"}{if windowsState("physical_disk",[]string{raw},"","Healthy")!=want{t.Fatal(raw)}};if windowsState("physical_disk",[]string{"OK"},"Retired","Healthy")!="offline"||windowsState("physical_disk",[]string{"OK"},"HotSpare","Healthy")!="hotspare"||windowsState("physical_disk",[]string{"OK"},"","Unhealthy")!="failed"{t.Fatal("usage/health precedence")}}
func TestSpacesMissingPoolIdentity(t *testing.T){r,e:=parseSpaces([]byte(`{"Pools":[{"FriendlyName":"partial","HealthStatus":"Healthy"}],"VirtualDisks":[],"PhysicalDisks":[],"Warnings":[]}`));if e!=nil||r.Complete{t.Fatalf("%+v %v",r,e)};for _,c:=range r.Components{if c.ComponentType=="enclosure"{t.Fatal("invented pool identity",c)}}}

```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: parseSpaces`.
- [ ] **Step 3: Implement the portable parser (5 min).** `storagespaces.go`:
```go
package hwhealth
import("encoding/json";"fmt";"strings")
type windowsDisk struct{UniqueId,ObjectId,SerialNumber,FriendlyName,Model,FirmwareVersion,HealthStatus,Usage string;OperationalStatus []string;Size int64;Temperature,Wear *int;ReadErrorsTotal,WriteErrorsTotal *int64}
func osHealth(raw string)*string{v:=map[string]string{"Healthy":"healthy","Warning":"warning","Unhealthy":"unhealthy"}[raw];if v==""{return nil};return &v}
func windowsState(typ ComponentType,ops []string,usage,health string)string{
 if typ=="physical_disk"{if health=="Unhealthy"{return "failed"};if usage=="Retired"{return "offline"};if usage=="HotSpare"{return "hotspare"}}
 maps:=map[ComponentType]map[string]string{"virtual_disk":{"OK":"optimal","InService":"rebuilding","Degraded":"degraded","Detached":"offline","Incomplete":"degraded","No Redundancy":"degraded"},"physical_disk":{"OK":"online","Predictive Failure":"predictive_failure","Lost Communication":"missing","Transient Error":"degraded","Starting":"online"}}
 priority:=[]string{"Lost Communication","Detached","No Redundancy","Incomplete","Degraded","Predictive Failure","Transient Error","InService","Starting","OK"}
 for _,s:=range priority{for _,raw:=range ops{if raw==s{if out,ok:=maps[typ][raw];ok{return out}}}};return "unknown"
}
func diskComponent(k Kind,key,parent string,d windowsDisk)Component{raw:=strings.Join(d.OperationalStatus,", ");c:=component(k,"physical_disk",key,parent,d.FriendlyName,raw,windowsState("physical_disk",d.OperationalStatus,d.Usage,d.HealthStatus));if c.Name==""{c.Name=d.UniqueId};c.Serial=ptr(strings.TrimSpace(d.SerialNumber));c.Model=ptr(d.Model);c.Firmware=ptr(d.FirmwareVersion);c.SizeBytes=ptr(d.Size);c.OSHealthStatus=osHealth(d.HealthStatus);c.TemperatureC=d.Temperature;c.PredictiveFailure=c.State=="predictive_failure";c.Attributes["wearPercent"]=d.Wear;c.Attributes["readErrors"]=d.ReadErrorsTotal;c.Attributes["writeErrors"]=d.WriteErrorsTotal;return c}
func parseSpaces(b []byte)(Result,error){
 var doc struct{Pools []struct{ObjectId,FriendlyName,HealthStatus string};VirtualDisks []struct{ObjectId,FriendlyName,HealthStatus string;OperationalStatus []string;Size int64;MemberIds []string;Progress *int};PhysicalDisks []windowsDisk;Warnings []string}
 if e:=json.Unmarshal(b,&doc);e!=nil{return Result{},e};if doc.Pools==nil||doc.VirtualDisks==nil||doc.PhysicalDisks==nil{return Result{},fmt.Errorf("incomplete Storage Spaces response")}
 r:=Result{Complete:len(doc.Warnings)==0,Warnings:doc.Warnings};if len(doc.Pools)==0{return r,nil};ck:="storage_spaces:ctrl";r.Components=append(r.Components,component("storage_spaces","controller",ck,"","Storage Spaces","OK","ok"))
 for _,p:=range doc.Pools{if p.ObjectId==""{r.Complete=false;r.Warnings=append(r.Warnings,"pool ObjectId missing");continue};state:=map[string]string{"Healthy":"ok","Warning":"degraded","Unhealthy":"failed","Unknown":"unknown"}[p.HealthStatus];if state==""{state="unknown"};r.Components=append(r.Components,component("storage_spaces","enclosure",ck+":enc"+objectHash(p.ObjectId),ck,p.FriendlyName,p.HealthStatus,state))}
 for _,v:=range doc.VirtualDisks{if v.ObjectId==""{r.Complete=false;r.Warnings=append(r.Warnings,"VD ObjectId missing");continue};key:="storage_spaces:vd:"+objectHash(v.ObjectId);c:=component("storage_spaces","virtual_disk",key,ck,v.FriendlyName,strings.Join(v.OperationalStatus,", "),windowsState("virtual_disk",v.OperationalStatus,"",v.HealthStatus));c.SizeBytes=ptr(v.Size);c.OSHealthStatus=osHealth(v.HealthStatus);if v.Progress!=nil&&*v.Progress>=0&&*v.Progress<=100{c.ProgressPercent=v.Progress};keys:=[]string{};for _,id:=range v.MemberIds{keys=append(keys,slotKey(ck,"-",objectHash(id)))};c.Attributes["memberKeys"]=keys;r.Components=append(r.Components,c)}
 for _,d:=range doc.PhysicalDisks{if d.UniqueId==""{r.Complete=false;r.Warnings=append(r.Warnings,"PD UniqueId missing");continue};r.Components=append(r.Components,diskComponent("storage_spaces",slotKey(ck,"-",objectHash(d.UniqueId)),ck,d))};return r,nil
}
```
Decision: Storage Spaces has no physical bay number; use `e-` and the stable UniqueId hash as the source's slot identifier. Store actual enclosure/slot only when reported; do not pretend the hash is a physical bay. This closes the key-table gap for unslotted Storage Spaces members without adding a wire-key format.
- [ ] **Step 4: Implement one bounded Windows query and stubs (5 min).** `storagespaces_windows.go`:
```go
//go:build windows
package hwhealth
import("context";"fmt";"strings";"time")
const spacesScript=`$ErrorActionPreference='Stop'
$pools=@(Get-StoragePool -IsPrimordial $false)
$vds=@(); $pds=@(); $warnings=@(); $jobs=@()
try { $jobs=@(Get-StorageJob) } catch { $warnings += 'Storage job progress unavailable' }
foreach($p in $pools) {
 foreach($v in @(Get-VirtualDisk -StoragePool $p)) {
  $ids=@(Get-PhysicalDisk -VirtualDisk $v | ForEach-Object { [string]$_.UniqueId })
  $matching=@($jobs|Where-Object { $_.Name -like ('*'+$v.FriendlyName+'*') -and $_.PercentComplete -ne $null })
  $progress=$null; if($matching.Count -eq 1 -and @($pools|Get-VirtualDisk|Where-Object {$_.FriendlyName -eq $v.FriendlyName}).Count -eq 1) { $progress=[int]$matching[0].PercentComplete }
  $vds += [pscustomobject]@{ObjectId=[string]$v.ObjectId;FriendlyName=$v.FriendlyName;HealthStatus=[string]$v.HealthStatus;OperationalStatus=@($v.OperationalStatus|ForEach-Object{[string]$_});Size=$v.Size;MemberIds=$ids;Progress=$progress}
 }
 foreach($d in @(Get-PhysicalDisk -StoragePool $p)) {
  $pds += [pscustomobject]@{UniqueId=[string]$d.UniqueId;ObjectId=[string]$d.ObjectId;SerialNumber=$d.SerialNumber;FriendlyName=$d.FriendlyName;Model=$d.Model;FirmwareVersion=$d.FirmwareVersion;HealthStatus=[string]$d.HealthStatus;OperationalStatus=@($d.OperationalStatus|ForEach-Object{[string]$_});Usage=[string]$d.Usage;Size=$d.Size}
 }
}
[pscustomobject]@{Pools=@($pools|ForEach-Object{[pscustomobject]@{ObjectId=[string]$_.ObjectId;FriendlyName=$_.FriendlyName;HealthStatus=[string]$_.HealthStatus}});VirtualDisks=@($vds);PhysicalDisks=@($pds|Sort-Object UniqueId -Unique);Warnings=@($warnings)} | ConvertTo-Json -Depth 3 -Compress`
func newStorageSpaces()Source{return &source{kind:"storage_spaces",tier:TierRAID,detect:func(ctx context.Context)Availability{o,e:=runPowerShell(ctx,60*time.Second,`$ErrorActionPreference='Stop';@(Get-StoragePool -IsPrimordial $false).Count`);return Availability{Path:"powershell.exe",Available:e!=nil||o.ExitCode!=0||number(strings.TrimSpace(string(o.Stdout)))>0}},collect:func(ctx context.Context,a Availability)(Result,error){o,e:=runPowerShell(ctx,60*time.Second,spacesScript);if e!=nil{return Result{},e};if o.ExitCode!=0{return Result{},fmt.Errorf("Storage Spaces exit %d",o.ExitCode)};return parseSpaces(o.Stdout)}}}
```
`storagespaces_other.go`:
```go
//go:build !windows
package hwhealth
func newStorageSpaces()Source{return unavailableSource("storage_spaces",TierRAID)}
```
- [ ] **Step 5: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`. Native Windows execution is required in Task 14.
- [ ] **Step 6: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{storagespaces.go,storagespaces_windows.go,storagespaces_other.go,storagespaces_test.go,testdata/storage_spaces}
git commit -m $'feat(agent): collect Storage Spaces topology and states\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 9: Collect Windows physical disks and reliability counters

**Files:** Create `agent/internal/collectors/hwhealth/winpd.go`, `agent/internal/collectors/hwhealth/winpd_windows.go`, `agent/internal/collectors/hwhealth/winpd_other.go`, `agent/internal/collectors/hwhealth/winpd_test.go` and `agent/internal/collectors/hwhealth/testdata/windows_physical_disk/{optimal,degraded,failed,rebuilding-with-progress,predictive,missing-member,multi-controller,unrecognized-state,truncated}.json`.
**Test:** `agent/internal/collectors/hwhealth/winpd_test.go`.
**Interfaces:** Consumes `windowsDisk`, `diskComponent`; produces `parseWinPD([]byte) (Result, error)`, `newWinPD() Source`. Counter failures retain disk state and surface a warning.

- [ ] **Step 1: Create fixtures and parser tests (5 min).**
```bash
python3 - <<'PY'
from pathlib import Path
import json
p=Path('agent/internal/collectors/hwhealth/testdata/windows_physical_disk');p.mkdir(parents=True,exist_ok=True)
for name in ('optimal','degraded','failed','rebuilding-with-progress','predictive','missing-member','multi-controller','unrecognized-state'):
 op={'degraded':'Transient Error','predictive':'Predictive Failure','missing-member':'Lost Communication','unrecognized-state':'NewState','rebuilding-with-progress':'InService'}.get(name,'OK')
 d={'UniqueId':'D1','SerialNumber':'S1','FriendlyName':'Disk','Model':'Fixture SSD','HealthStatus':'Unhealthy' if name=='failed' else 'Healthy','OperationalStatus':[op],'Size':1000,'Temperature':31,'Wear':5,'ReadErrorsTotal':0,'WriteErrorsTotal':0}
 disks=[d]
 if name=='multi-controller':disks.append(dict(d,UniqueId='D2',SerialNumber='S2'))
 (p/(name+'.json')).write_text(json.dumps({'Disks':disks,'Warnings':[]}))
(p/'truncated.json').write_text('{"Disks":[')
PY
```
`winpd_test.go`:
```go
package hwhealth
import "testing"
func TestWinPDFixtures(t *testing.T){for _,name:=range []string{"optimal","degraded","failed","rebuilding-with-progress","predictive","missing-member","multi-controller","unrecognized-state","truncated"}{r,e:=parseWinPD(fixture(t,"windows_physical_disk",name+".json"));if name=="truncated"{if e==nil{t.Fatal("truncation accepted")};continue};if e!=nil{t.Fatal(e)};c:=findComponent(t,r.Components,"winpd:D1");want:=map[string]string{"degraded":"degraded","failed":"failed","predictive":"predictive_failure","missing-member":"missing","unrecognized-state":"unknown","rebuilding-with-progress":"unknown"}[name];if want==""{want="online"};if c.State!=want||c.TemperatureC==nil||*c.TemperatureC!=31{t.Fatalf("%s %+v",name,c)}}}
func TestWinPDIncompleteIdentity(t *testing.T){r,e:=parseWinPD([]byte(`{"Disks":[{"FriendlyName":"no id"}],"Warnings":[]}`));if e!=nil||r.Complete||len(r.Components)!=0{t.Fatalf("%+v %v",r,e)}}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: parseWinPD`.
- [ ] **Step 3: Implement parsing and one PowerShell invocation (5 min).** `winpd.go`:
```go
package hwhealth
import("encoding/json";"fmt")
func parseWinPD(b []byte)(Result,error){var doc struct{Disks []windowsDisk;Warnings []string};if e:=json.Unmarshal(b,&doc);e!=nil{return Result{},e};if doc.Disks==nil{return Result{},fmt.Errorf("missing Disks")};r:=Result{Complete:true,Warnings:doc.Warnings};for _,d:=range doc.Disks{if d.UniqueId==""{r.Complete=false;r.Warnings=append(r.Warnings,"disk UniqueId missing");continue};r.Components=append(r.Components,diskComponent("windows_physical_disk","winpd:"+d.UniqueId,"",d))};return r,nil}
```
`winpd_windows.go`:
```go
//go:build windows
package hwhealth
import("context";"fmt";"time")
const winPDScript=`$ErrorActionPreference='Stop'
$warnings=@();$disks=@()
foreach($d in @(Get-PhysicalDisk)) {
 $r=$null
 try { $r=$d | Get-StorageReliabilityCounter -ErrorAction Stop } catch { $warnings += ('Reliability counters unavailable for '+[string]$d.UniqueId) }
 $disks += [pscustomobject]@{UniqueId=[string]$d.UniqueId;ObjectId=[string]$d.ObjectId;SerialNumber=$d.SerialNumber;FriendlyName=$d.FriendlyName;Model=$d.Model;FirmwareVersion=$d.FirmwareVersion;HealthStatus=[string]$d.HealthStatus;OperationalStatus=@($d.OperationalStatus|ForEach-Object{[string]$_});Usage=[string]$d.Usage;Size=$d.Size;Temperature=$(if($r){$r.Temperature}else{$null});Wear=$(if($r){$r.Wear}else{$null});ReadErrorsTotal=$(if($r){$r.ReadErrorsTotal}else{$null});WriteErrorsTotal=$(if($r){$r.WriteErrorsTotal}else{$null})}
}
[pscustomobject]@{Disks=@($disks);Warnings=@($warnings)} | ConvertTo-Json -Depth 3 -Compress`
func newWinPD()Source{return &source{kind:"windows_physical_disk",tier:TierDisk,detect:func(context.Context)Availability{return Availability{Path:"powershell.exe",Available:true}},collect:func(ctx context.Context,a Availability)(Result,error){o,e:=runPowerShell(ctx,60*time.Second,winPDScript);if e!=nil{return Result{},e};if o.ExitCode!=0{return Result{},fmt.Errorf("Get-PhysicalDisk exit %d",o.ExitCode)};return parseWinPD(o.Stdout)}}}
```
`winpd_other.go`:
```go
//go:build !windows
package hwhealth
func newWinPD()Source{return unavailableSource("windows_physical_disk",TierDisk)}
```
Decision: unsupported `InService` on a plain physical disk stays unknown; only the Storage Spaces VD mapping defines rebuilding. Raw reliability counters never create predicted failures. PowerShell casts CIM enums to strings and arrays explicitly, including zero/one results.
- [ ] **Step 4: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`.
- [ ] **Step 5: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{winpd.go,winpd_windows.go,winpd_other.go,winpd_test.go,testdata/windows_physical_disk}
git commit -m $'feat(agent): report Windows disk state and reliability counters\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 10: Respect smartctl exit bits and collect bounded SMART evidence

**Files:** Create `agent/internal/collectors/hwhealth/smartctl.go`, `agent/internal/collectors/hwhealth/smartctl_test.go` and `agent/internal/collectors/hwhealth/testdata/smartctl/{scan,optimal,degraded,failed,rebuilding-with-progress,predictive,missing-member,multi-controller,unrecognized-state,truncated}.json`.
**Test:** `agent/internal/collectors/hwhealth/smartctl_test.go`.
**Interfaces:** Produces `newSMART(extra []string, run toolRunner, now func() time.Time) Source`, `smartDevice{Name, Type string}`, `parseSMART([]byte, int, smartDevice, time.Time) (Component, error)`. Consumes `toolRunner`, `smartKey(serial, deviceType, dev string, unique bool) string`. Preserve both scan identity fields through parsing and the final serial-uniqueness pass. The three-minute smartctl budget is nested inside the four-minute cycle budget.

- [ ] **Step 1: Create fixtures, exit-bit and shared-path identity tests (5 min).**
```bash
python3 - <<'PY'
from pathlib import Path
import json
p=Path('agent/internal/collectors/hwhealth/testdata/smartctl');p.mkdir(parents=True,exist_ok=True)
(p/'scan.json').write_text(json.dumps({'devices':[{'name':'/dev/sda','type':'sat'},{'name':'/dev/bus/0','type':'megaraid,1'},{'name':'/dev/sg0','type':'cciss,0'}]}))
for name in ('optimal','degraded','failed','rebuilding-with-progress','predictive','missing-member','multi-controller','unrecognized-state'):
 d={'serial_number':'SMART1','model_name':'Fixture SSD','firmware_version':'1','user_capacity':{'bytes':1000},'smart_status':{'passed':name!='failed'},'temperature':{'current':32},'power_on_time':{'hours':20},'ata_smart_attributes':{'table':[{'id':5,'raw':{'value':999}},{'id':197,'raw':{'value':100}}]},'nvme_smart_health_information_log':{'critical_warning':1 if name=='predictive' else 0,'percentage_used':99,'media_errors':1000,'unsafe_shutdowns':8}}
 if name=='unrecognized-state':d.pop('smart_status');d.pop('nvme_smart_health_information_log')
 if name=='missing-member':d={'messages':[{'string':'device open failed'}]}
 if name=='multi-controller':d['serial_number']='SMART2'
 (p/(name+'.json')).write_text(json.dumps(d))
(p/'truncated.json').write_text('{"smart_status":')
PY
```
`smartctl_test.go`:
```go
package hwhealth
import("context";"encoding/json";"fmt";"strings";"testing";"time")
func TestSMARTFixtures(t *testing.T){for _,name:=range []string{"optimal","degraded","failed","rebuilding-with-progress","predictive","missing-member","multi-controller","unrecognized-state","truncated"}{code:=0;if name=="missing-member"{code=2};c,e:=parseSMART(fixture(t,"smartctl",name+".json"),code,smartDevice{Name:"/dev/sda",Type:"sat"},time.Unix(10,0));if name=="missing-member"||name=="truncated"{if e==nil{t.Fatal(name)};continue};if e!=nil{t.Fatal(e)};if c.PredictiveFailure!=(name=="failed"||name=="predictive"){t.Fatalf("%s %+v",name,c)};if name=="unrecognized-state"&&c.State!="unknown"{t.Fatal(c)};if name=="failed"&&(c.SmartPassed==nil||*c.SmartPassed){t.Fatal(c)}}}
func TestSMARTExitBits(t *testing.T){for bit:=0;bit<8;bit++{c,e:=parseSMART(fixture(t,"smartctl","optimal.json"),1<<bit,smartDevice{Name:"/dev/sda",Type:"sat"},time.Unix(1,0));if (e!=nil)!=(bit<3){t.Fatalf("bit %d err %v",bit,e)};if bit==3&&(c.SmartPassed==nil||*c.SmartPassed||!c.PredictiveFailure){t.Fatal(c)}}}
func TestSMARTDeviceLimit(t *testing.T){count:=0;run:=func(_ context.Context,_ time.Duration,_ string,args ...string)(execResult,error){if args[0]=="--scan-open"{rows:=[]string{};for i:=0;i<65;i++{rows=append(rows,fmt.Sprintf(`{"name":"/dev/d%d","type":"sat"}`,i))};return execResult{Stdout:[]byte(`{"devices":[`+strings.Join(rows,",")+`]}`)},nil};count++;return execResult{Stdout:fixture(t,"smartctl","optimal.json")},nil};r,e:=newSMART(nil,run,time.Now).Collect(context.Background(),Availability{Available:true,Path:"smartctl"});if e!=nil||count!=64||r.Complete||len(r.Components)!=64{t.Fatalf("%d %+v %v",count,r,e)};for _,c:=range r.Components{if !strings.HasPrefix(c.ComponentKey,"smart:dev:"){t.Fatal("duplicate serial merged",c)}}}
// Shared by the source regression here and the full collector regression in Task 13.
func smartIdentityCases()[]struct{name string;serials,keys [2]string}{
 fallback:=[2]string{"smart:dev:megaraid,0:/dev/bus/0","smart:dev:megaraid,1:/dev/bus/0"}
 return []struct{name string;serials,keys [2]string}{
  {"blank",[2]string{"",""},fallback},
  {"whitespace",[2]string{" ","\t"},fallback},
  {"duplicate",[2]string{"DUP","DUP"},fallback},
  {"trimmed_duplicate",[2]string{" DUP ","DUP"},fallback},
  {"unique",[2]string{" A ","B"},[2]string{"smart:A","smart:B"}},
 }
}
func smartSharedPathSource(t *testing.T,serials [2]string,reverse,failedProbe bool)Source{
 t.Helper()
 return newSMART(nil,func(_ context.Context,timeout time.Duration,path string,args ...string)(execResult,error){
  if timeout!=15*time.Second||path!="fixture-smartctl"{t.Fatalf("unexpected invocation: %s %v",path,timeout)}
  if strings.Join(args," ")=="--scan-open -j"{
   devices:=[]map[string]string{{"name":"/dev/bus/0","type":"megaraid,0"},{"name":"/dev/bus/0","type":"megaraid,1"}}
   if reverse{devices[0],devices[1]=devices[1],devices[0]}
   if failedProbe{devices=append(devices[:1],append([]map[string]string{{"name":"/dev/bus/0","type":"megaraid,9"}},devices[1:]...)...)}
   b,e:=json.Marshal(map[string]any{"devices":devices});if e!=nil{t.Fatal(e)};return execResult{Stdout:b},nil
  }
  if len(args)!=5||strings.Join(args[:4]," ")!="-a -j /dev/bus/0 -d"{t.Fatalf("scan identity lost in command: %v",args)}
  i:=0;switch args[4]{case "megaraid,0":case "megaraid,1":i=1;case "megaraid,9":return execResult{ExitCode:2,Stdout:[]byte(`{}`)},nil;default:t.Fatalf("unexpected type: %s",args[4])}
  b,e:=json.Marshal(map[string]any{"serial_number":serials[i],"smart_status":map[string]any{"passed":i==0},"temperature":map[string]any{"current":30+i}});if e!=nil{t.Fatal(e)}
  return execResult{Stdout:b},nil
 },func()time.Time{return time.Unix(100,0)})
}
func assertSMARTIdentityRows(t *testing.T,rows []Component,keys [2]string){
 t.Helper();if len(rows)!=2{t.Fatalf("lost shared-path probes: %+v",rows)}
 for i,key:=range keys{
  c:=findComponent(t,rows,key)
  if c.Source!="smartctl"||c.Name!="/dev/bus/0"||c.Attributes["osDevice"]!="/dev/bus/0"||c.TemperatureC==nil||*c.TemperatureC!=30+i||c.SmartPassed==nil||*c.SmartPassed!=(i==0)||c.PredictiveFailure!=(i==1){t.Fatalf("probe evidence assigned to wrong identity: %+v",c)}
 }
}
func TestSMARTSharedPathIdentity(t *testing.T){
 for _,tc:=range smartIdentityCases(){for _,reverse:=range []bool{false,true}{for _,failedProbe:=range []bool{false,true}{
  t.Run(fmt.Sprintf("%s/reverse=%t/failed=%t",tc.name,reverse,failedProbe),func(t *testing.T){
   src:=smartSharedPathSource(t,tc.serials,reverse,failedProbe)
   r,e:=src.Collect(context.Background(),Availability{Available:true,Path:"fixture-smartctl"})
   if e!=nil||r.Complete==failedProbe{t.Fatalf("%+v %v",r,e)}
   assertSMARTIdentityRows(t,r.Components,tc.keys)
  })
 }}}
}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: parseSMART` (and `smartDevice`). When correcting an existing implementation, `TestSMARTSharedPathIdentity` must fail for blank and duplicate serials with the old name-only fallback.
- [ ] **Step 3: Implement scan/probe and normalization (5 min).** `smartctl.go`:
```go
package hwhealth
import("context";"encoding/json";"fmt";"strings";"time")
type smartDevice struct{Name,Type string}
func parseSMART(b []byte,exit int,dev smartDevice,now time.Time)(Component,error){
 if exit<0||exit&7!=0{return Component{},fmt.Errorf("SMART probe failed (exit %d)",exit)}
 var d struct{Serial string `json:"serial_number"`;Model string `json:"model_name"`;Firmware string `json:"firmware_version"`;Status struct{Passed *bool `json:"passed"`} `json:"smart_status"`;Temperature struct{Current *int `json:"current"`} `json:"temperature"`;Capacity struct{Bytes int64 `json:"bytes"`} `json:"user_capacity"`;Power struct{Hours int64 `json:"hours"`} `json:"power_on_time"`;ATA struct{Table []struct{ID int `json:"id"`;Raw struct{Value any `json:"value"`} `json:"raw"`} `json:"table"`} `json:"ata_smart_attributes"`;NVMe map[string]any `json:"nvme_smart_health_information_log"`}
 if e:=json.Unmarshal(b,&d);e!=nil{return Component{},e};passed:=d.Status.Passed;if exit&8!=0{passed=ptr(false)};state:="unknown";predict:=false
 if passed!=nil{if *passed{state="online"}else{state="predictive_failure";predict=true}}
 if number(d.NVMe["critical_warning"])!=0{predict=true};c:=component("smartctl","physical_disk",smartKey(d.Serial,dev.Type,dev.Name,false),"",dev.Name,"smartctl",state);c.Serial=ptr(strings.TrimSpace(d.Serial));c.Model=ptr(d.Model);c.Firmware=ptr(d.Firmware);c.SizeBytes=ptr(d.Capacity.Bytes);c.TemperatureC=d.Temperature.Current;c.SmartPassed=passed;c.PredictiveFailure=predict
 smart:=map[string]any{"observedAt":now.UTC().Format(time.RFC3339Nano),"powerOnHours":d.Power.Hours};attrs:=map[string]any{};for _,a:=range d.ATA.Table{switch a.ID{case 5,9,187,188,194,197,198,199:attrs[fmt.Sprint(a.ID)]=a.Raw.Value}};smart["ata"]=attrs
 for _,k:=range []string{"critical_warning","percentage_used","media_errors","unsafe_shutdowns"}{if v,ok:=d.NVMe[k];ok{smart[k]=v}};c.Attributes["smart"]=smart;c.Attributes["osDevice"]=dev.Name;return c,nil
}
func newSMART(extra []string,run toolRunner,now func()time.Time)Source{return &source{kind:"smartctl",tier:TierDisk,detect:func(context.Context)Availability{p,ok:=lookupTool([]string{"smartctl"},extra);return Availability{Path:p,Available:ok}},collect:func(parent context.Context,a Availability)(Result,error){
 ctx,cancel:=context.WithTimeout(parent,3*time.Minute);defer cancel();scan,e:=run(ctx,15*time.Second,a.Path,"--scan-open","-j");if e!=nil{return Result{},e};if scan.ExitCode&7!=0{return Result{},fmt.Errorf("smartctl scan exit %d",scan.ExitCode)}
 var doc struct{Devices []smartDevice};if e=json.Unmarshal(scan.Stdout,&doc);e!=nil{return Result{},e};if doc.Devices==nil{return Result{},fmt.Errorf("missing smartctl devices")}
 r:=Result{Complete:true};if len(doc.Devices)>64{doc.Devices=doc.Devices[:64];r.Complete=false;r.Warnings=append(r.Warnings,"scan limited to 64 devices")}
 counts:=map[string]int{};devices:=[]smartDevice{}
 for _,d:=range doc.Devices{if ctx.Err()!=nil{r.Complete=false;r.Warnings=append(r.Warnings,"SMART budget exceeded");break};args:=[]string{"-a","-j",d.Name};if d.Type!=""{args=append(args,"-d",d.Type)};o,e:=run(ctx,15*time.Second,a.Path,args...);var c Component;if e==nil{c,e=parseSMART(o.Stdout,o.ExitCode,d,now())};if e!=nil{r.Complete=false;r.Warnings=append(r.Warnings,d.Name+": "+e.Error());continue};serial:=strings.TrimSpace(*c.Serial);if serial!=""{counts[serial]++};r.Components=append(r.Components,c);devices=append(devices,d)}
 for i:=range r.Components{c:=&r.Components[i];c.ComponentKey=smartKey(*c.Serial,devices[i].Type,devices[i].Name,counts[*c.Serial]==1)}
 if len(r.Components)==0&&!r.Complete{return r,fmt.Errorf("all SMART probes failed: %v",r.Warnings)};return r,nil
}}}
```
Decision: bit 3 explicitly sets `SmartPassed=false` even if the JSON boolean disagrees, preserving server-derived critical health. Bits 4–7 only admit data; raw ATA counts and NVMe wear/error counters never set a health flag. A missing SMART overall status remains unknown rather than inventing a healthy self-assessment. Parsing starts with the typed device fallback; only the completed serial-count pass selects `smart:<serial>`. Append scan identities only for successful probes so failed probes cannot shift the type/name association. Blank and duplicate serials retain separate typed keys regardless of scan order.
- [ ] **Step 4: Run green (2 min).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/... -run 'Test(Keys|SMART)' -count=1
```
```bash
cd agent && go test -race ./internal/collectors/hwhealth/...
```
Both commands must return exit code 0. The shared-path matrix verifies exact keys and per-probe evidence with forward/reversed scans, blank/duplicate/unique serials and an intervening failed probe.
- [ ] **Step 5: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{smartctl.go,smartctl_test.go,testdata/smartctl}
git commit -m $'feat(agent): collect bounded SMART evidence with exit-bit semantics\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 11: Merge unique identities, replay SMART and retain Windows suppression across tiers

**Files:** Create `agent/internal/collectors/hwhealth/merge.go`, `agent/internal/collectors/hwhealth/merge_test.go`. The `Component.MarshalJSON` method lives in `merge.go`.
**Test:** `agent/internal/collectors/hwhealth/merge_test.go`.
**Interfaces:** Produces `smartCacheEntry`, `vendorTopology`, `updateVendorTopology(previous vendorTopology, rows []Component, reports []SourceReport, now time.Time, interval time.Duration) vendorTopology`, and `merge(rows []Component, cache map[string]smartCacheEntry, now time.Time, interval time.Duration, topology ...vendorTopology) []Component`. Enrichment retains vendor state and source, carries `SmartPassed` for server derivation, and never invents a smartctl source report on RAID-only polls.

- [ ] **Step 1: Write uniqueness, suppression, TTL and null-clearing tests (5 min).** `merge_test.go`:
```go
package hwhealth
import("encoding/json";"strings";"testing";"time")
func TestMergeRules(t *testing.T){now:=time.Unix(1000,0);vendor:=component("storcli","physical_disk","storcli:c0:e1:s1","storcli:c0","slot","Onln","online");vendor.Serial=ptr("S");smart:=component("smartctl","physical_disk","smart:S","","disk","SMART","predictive_failure");smart.Serial=ptr("S");smart.PredictiveFailure=true;smart.SmartPassed=ptr(false);smart.TemperatureC=ptr(42);smart.Attributes["smart"]=map[string]any{"observedAt":now.Format(time.RFC3339Nano)}
 cache:=map[string]smartCacheEntry{};rows:=merge([]Component{vendor,smart},cache,now,time.Hour);if len(rows)!=1||!rows[0].PredictiveFailure||rows[0].SmartPassed==nil||*rows[0].SmartPassed{t.Fatal(rows)}
 replay:=merge([]Component{vendor},cache,now.Add(time.Hour),time.Hour);if !replay[0].PredictiveFailure{t.Fatal("SMART lost on RAID tier")}
 expired:=merge([]Component{vendor},cache,now.Add(2*time.Hour),time.Hour);b,_:=json.Marshal(expired[0]);if expired[0].PredictiveFailure||!strings.Contains(string(b),`"smartPassed":null`)||!strings.Contains(string(b),`"temperatureC":null`){t.Fatal(string(b))}
 for _,serial:=range []string{"","S"}{v2:=vendor;v2.ComponentKey+="2";v2.Serial=ptr(serial);v1:=vendor;v1.Serial=ptr(serial);s:=smart;s.Serial=ptr(serial);got:=merge([]Component{v1,v2,s},map[string]smartCacheEntry{},now,time.Hour);if len(got)!=3{t.Fatal("ambiguous merge",got)}}
 s2:=smart;s2.ComponentKey="smart:dev:sat:/dev/second";if got:=merge([]Component{vendor,smart,s2},map[string]smartCacheEntry{},now,time.Hour);len(got)!=3{t.Fatal("duplicate smart serial merged")}
 win:=component("windows_physical_disk","physical_disk","winpd:1","","disk","OK","online");win.Serial=ptr("S");if got:=merge([]Component{vendor,win},map[string]smartCacheEntry{},now,time.Hour);len(got)!=1{t.Fatal(got)}
 vd:=component("storcli","virtual_disk","storcli:c0:v0","storcli:c0","VD","Optl","optimal");for _,model:=range []string{"PERC H730","LOGICAL VOLUME","Virtual Disk","MR9361","Smart Array","raid volume"}{win.Model=ptr(model);win.Serial=ptr("");got:=merge([]Component{vd,win},map[string]smartCacheEntry{},now,time.Hour);if !got[1].AlertExempt||got[1].Attributes["backedByVd"]!=true{t.Fatal(model)};got=merge([]Component{win},map[string]smartCacheEntry{},now,time.Hour);if got[0].AlertExempt{t.Fatal("no VD present")}}
}
```
Append to `merge_test.go`:
```go
func TestWindowsTopologyAcrossTiers(t *testing.T){
 now:=time.Unix(1000,0);interval:=10*time.Minute
 vd:=component("storcli","virtual_disk","storcli:c0:v0","","VD","Optl","optimal");vd.Serial=ptr("VD-S");vd.Model=ptr("PERC volume")
 pd:=component("storcli","physical_disk","storcli:c0:e1:s1","","PD","Onln","online");pd.Serial=ptr("PD-S");pd.Model=ptr("physical model")
 topology:=updateVendorTopology(nil,[]Component{vd,pd},nil,now,interval)
 win:=component("windows_physical_disk","physical_disk","winpd:1","","disk","OK","online");win.Model=ptr("PERC volume")
 for _,age:=range []time.Duration{time.Minute,2*interval-time.Nanosecond,2*interval}{
  fresh:=updateVendorTopology(topology,nil,nil,now.Add(age),interval)
  got:=merge([]Component{win},map[string]smartCacheEntry{},now.Add(age),time.Hour,fresh)
  if len(got)!=1||got[0].AlertExempt!=(age<2*interval){t.Fatal(age,got)}
 }
 for _,status:=range []SourceStatus{"failed","backing_off","superseded","disabled","unavailable","ok"}{
  got:=updateVendorTopology(topology,nil,[]SourceReport{{Source:"storcli",Status:status,Complete:ptr(false)}},now.Add(time.Minute),interval)
  if len(got)!=2||!got[pd.ComponentKey].ObservedAt.Equal(now){t.Fatal(status,got)}
 }
 partial:=updateVendorTopology(topology,[]Component{pd},[]SourceReport{{Source:"storcli",Status:"ok",Complete:ptr(false)}},now.Add(time.Minute),interval)
 if !partial[vd.ComponentKey].ObservedAt.Equal(now)||!partial[pd.ComponentKey].ObservedAt.Equal(now.Add(time.Minute)){t.Fatal(partial)}
 win.Serial=ptr("PD-S");if got:=merge([]Component{win},map[string]smartCacheEntry{},now,time.Hour,topology);len(got)!=0{t.Fatal("cached PD was duplicated",got)}
 duplicate:=pd;duplicate.ComponentKey+="2";ambiguous:=updateVendorTopology(topology,[]Component{duplicate},nil,now,interval)
 if got:=merge([]Component{win},map[string]smartCacheEntry{},now,time.Hour,ambiguous);len(got)!=1{t.Fatal("ambiguous serial dropped",got)}
 cleared:=updateVendorTopology(topology,nil,[]SourceReport{{Source:"storcli",Status:"ok",Complete:ptr(true)}},now.Add(time.Minute),interval)
 if len(cleared)!=0{t.Fatal("complete empty inventory did not replace topology",cleared)}
 if got:=updateVendorTopology(topology,nil,nil,now.Add(-time.Second),interval);len(got)!=0{t.Fatal("future evidence retained",got)}
}
```
- [ ] **Step 2: Run red (2 min).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/... -run 'Test(MergeRules|WindowsTopologyAcrossTiers)' -count=1
```
Expect missing `smartCacheEntry`/`updateVendorTopology` before implementation; the pre-review merge cannot accept retained topology.
- [ ] **Step 3: Implement merge and explicit nulls (5 min).** `merge.go`:
```go
package hwhealth
import("encoding/json";"strings";"time")
type smartCacheEntry struct{ObservedAt time.Time `json:"observedAt"`;Component Component `json:"component"`}
func serial(c Component)string{if c.Serial==nil{return ""};return strings.TrimSpace(*c.Serial)}
func vendorSource(k Kind)bool{switch k{case "storcli","perccli","megacli","ssacli","arcconf","omreport","mdadm","zfs","storage_spaces":return true};return false}
type vendorIdentity struct{
 Source Kind `json:"source"`
 Type ComponentType `json:"type"`
 Serial string `json:"serial"`
 Model string `json:"model"`
 ObservedAt time.Time `json:"observedAt"`
}
type vendorTopology map[string]vendorIdentity
func updateVendorTopology(previous vendorTopology,rows []Component,reports []SourceReport,now time.Time,interval time.Duration)vendorTopology{
 next:=vendorTopology{}
 for key,e:=range previous{if !now.Before(e.ObservedAt)&&now.Sub(e.ObservedAt)<2*interval{next[key]=e}}
 // Only a complete inventory proves removal. Partial/failed/skipped polls never renew unseen evidence.
 for _,r:=range reports{if vendorSource(r.Source)&&r.Status=="ok"&&r.Complete!=nil&&*r.Complete{for key,e:=range next{if e.Source==r.Source{delete(next,key)}}}}
 for _,c:=range rows{if !vendorSource(c.Source)||(c.ComponentType!="physical_disk"&&c.ComponentType!="virtual_disk"){continue};model:="";if c.Model!=nil{model=*c.Model};next[c.ComponentKey]=vendorIdentity{Source:c.Source,Type:c.ComponentType,Serial:serial(c),Model:model,ObservedAt:now}}
 return next
}
func merge(rows []Component,cache map[string]smartCacheEntry,now time.Time,interval time.Duration,topologies ...vendorTopology)[]Component{
 vendors,smarts,wins:=map[string]int{},map[string]int{},map[string]int{}
 topology:=updateVendorTopology(nil,rows,nil,now,interval);if len(topologies)>0{topology=topologies[0]}
 windowsVendors:=map[string]int{};hasVD:=false
 for _,e:=range topology{if e.Type=="virtual_disk"{hasVD=true};if e.Type=="physical_disk"&&e.Serial!=""{windowsVendors[e.Serial]++}}
 for _,c:=range rows{if c.ComponentType!="physical_disk"{continue};s:=serial(c);if s==""{continue};if vendorSource(c.Source){vendors[s]++};if c.Source=="smartctl"{smarts[s]++};if c.Source=="windows_physical_disk"{wins[s]++}}
 for s,e:=range cache{if now.Before(e.ObservedAt)||now.Sub(e.ObservedAt)>=2*interval||smarts[s]>1||vendors[s]>1{delete(cache,s)}}
 for _,c:=range rows{if c.Source!="smartctl"||serial(c)==""||smarts[serial(c)]!=1{continue};observed:=now;if obj,ok:=c.Attributes["smart"].(map[string]any);ok{if raw,ok:=obj["observedAt"].(string);ok{if t,e:=time.Parse(time.RFC3339Nano,raw);e==nil{observed=t}}};cache[serial(c)]=smartCacheEntry{ObservedAt:observed,Component:c}}
 out:=[]Component{};for _,input:=range rows{c:=input;c.Attributes=map[string]any{};for k,v:=range input.Attributes{c.Attributes[k]=v};s:=serial(c)
  if c.ComponentType=="physical_disk"&&vendorSource(c.Source)&&s!=""&&vendors[s]==1{if e,ok:=cache[s];ok&&smarts[s]<=1&&now.Sub(e.ObservedAt)<2*interval{c.PredictiveFailure=c.PredictiveFailure||e.Component.PredictiveFailure;c.SmartPassed=e.Component.SmartPassed;if e.Component.TemperatureC!=nil{c.TemperatureC=e.Component.TemperatureC};c.Attributes["smart"]=e.Component.Attributes["smart"]}}
  if c.Source=="smartctl"&&s!=""&&smarts[s]==1&&vendors[s]==1{continue}
  if c.Source=="windows_physical_disk"{if s!=""&&wins[s]==1&&windowsVendors[s]==1{continue};c.AlertExempt=false;delete(c.Attributes,"backedByVd");if hasVD&&c.Model!=nil{model:=strings.ToUpper(*c.Model);for _,pattern:=range []string{"PERC","LOGICAL VOLUME","VIRTUAL DISK","MR9","SMART ARRAY","RAID"}{if strings.Contains(model,pattern){c.AlertExempt=true;c.Attributes["backedByVd"]=true;break}}}}
  out=append(out,c)
 };return out
}
// Explicit null clears expired SMART fields; all other tags remain the §C tags.
func(c Component)MarshalJSON()([]byte,error){type wire Component;return json.Marshal(struct{wire;TemperatureC *int `json:"temperatureC"`;SmartPassed *bool `json:"smartPassed"`}{wire:wire(c),TemperatureC:c.TemperatureC,SmartPassed:c.SmartPassed})}
```
The marshaler is in `merge.go`, so no duplicate method is added to `types.go`. The `Component` struct declaration keeps the index's exact tags. Vendor health rows are never replayed from topology: expiry therefore restores vendor temperature/predictive evidence and drops only SMART contributions. SMART-only disk snapshots may retain standalone rows when no vendor PD is present in that snapshot, as required by the snapshot-local uniqueness rule. Windows suppression alone uses the last observed vendor VD/PD identities, with serials, models and observation timestamps persisted in Task 12. Task 13 prunes this evidence at 2 × the current RAID interval (and on a future timestamp), replaces a source on a complete inventory, and updates only observed identities after partial collection. Disk-only, failed, disabled and superseded polls cannot refresh its timestamps. No cached vendor health components or source reports are emitted.
- [ ] **Step 4: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`, including the earlier exact-key round trip.
- [ ] **Step 5: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{merge.go,merge_test.go}
git commit -m $'feat(agent): merge unique disk identities and replay SMART evidence\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 12: Persist sequence, fairness, member identity, vendor topology and SMART cache atomically

**Files:** Create `agent/internal/collectors/hwhealth/persist.go`, `agent/internal/collectors/hwhealth/persist_test.go`. Read-only reference `agent/internal/state/state.go:58–80`, `agent/internal/collectors/change_tracker.go:612–650`.
**Test:** `agent/internal/collectors/hwhealth/persist_test.go`.
**Interfaces:** Produces `diskState`, `readJSON(path string, value any) error`, `writeJSON(path string, value any) error`, `reserveSequence(dir string, state *diskState) error`. Uses exactly `hwhealth_state.json` (including `VendorTopology` with per-identity timestamps) and `hwhealth_smart_cache.json` under `Options.DataDir` (heartbeat supplies `config.GetDataDir()`). No call to `state.Write` with an incompatible argument.

- [ ] **Step 1: Write persistence and refusal-on-error tests (5 min).** `persist_test.go`:
```go
package hwhealth
import("os";"path/filepath";"testing";"time")
func TestSequenceAndCachePersistence(t *testing.T){dir:=t.TempDir();s:=diskState{MDMembers:map[string]string{"md0/0":"ata-S1"},Next:"smartctl"};if e:=reserveSequence(dir,&s);e!=nil{t.Fatal(e)};var restored diskState;if e:=readJSON(filepath.Join(dir,"hwhealth_state.json"),&restored);e!=nil{t.Fatal(e)};if restored.Sequence!=1||restored.Next!="smartctl"||restored.MDMembers["md0/0"]!="ata-S1"{t.Fatal(restored)};if e:=reserveSequence(dir,&restored);e!=nil||restored.Sequence!=2{t.Fatal(e)};cache:=map[string]smartCacheEntry{"S":{ObservedAt:time.Unix(100,0),Component:Component{ComponentKey:"smart:S",Serial:ptr("S"),Attributes:map[string]any{}}}};p:=filepath.Join(dir,"hwhealth_smart_cache.json");if e:=writeJSON(p,cache);e!=nil{t.Fatal(e)};var got map[string]smartCacheEntry;if e:=readJSON(p,&got);e!=nil||len(got)!=1{t.Fatal(e)};if _,e:=os.Stat(p+".tmp");!os.IsNotExist(e){t.Fatal("temp stranded")}}
func TestVendorTopologyPersistence(t *testing.T){
 dir:=t.TempDir();now:=time.Unix(1000,0)
 state:=diskState{VendorTopology:vendorTopology{
  "storcli:c0:v0":{Source:"storcli",Type:"virtual_disk",Serial:"VD-S",Model:"PERC volume",ObservedAt:now},
  "storcli:c0:e1:s1":{Source:"storcli",Type:"physical_disk",Serial:"PD-S",Model:"physical model",ObservedAt:now},
 }}
 if e:=reserveSequence(dir,&state);e!=nil{t.Fatal(e)};var got diskState
 if e:=readJSON(filepath.Join(dir,"hwhealth_state.json"),&got);e!=nil{t.Fatal(e)}
 if len(got.VendorTopology)!=2{t.Fatal(got)};for key,want:=range state.VendorTopology{have:=got.VendorTopology[key];if have.Source!=want.Source||have.Type!=want.Type||have.Serial!=want.Serial||have.Model!=want.Model||!have.ObservedAt.Equal(want.ObservedAt){t.Fatal(key,have)}}
}
func TestSequenceFailureDoesNotPublish(t *testing.T){dir:=t.TempDir();p:=filepath.Join(dir,"file");if e:=os.WriteFile(p,[]byte("x"),0600);e!=nil{t.Fatal(e)};s:=diskState{Sequence:12};if e:=reserveSequence(p,&s);e==nil||s.Sequence!=12{t.Fatalf("state=%+v error=%v",s,e)}}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: diskState`.
- [ ] **Step 3: Implement atomic files (5 min).** `persist.go`:
```go
package hwhealth
import("encoding/json";"errors";"fmt";"io";"os";"path/filepath";"time")
type diskState struct{Sequence uint64 `json:"sequence"`;Next Kind `json:"next"`;LastNone time.Time `json:"lastNone"`;MDMembers map[string]string `json:"mdMembers"`;VendorTopology vendorTopology `json:"vendorTopology,omitempty"`}
func readJSON(path string,value any)error{f,e:=os.Open(path);if errors.Is(e,os.ErrNotExist){return nil};if e!=nil{return e};defer f.Close();b,e:=io.ReadAll(io.LimitReader(f,4*1024*1024+1));if e!=nil{return e};if len(b)>4*1024*1024{return fmt.Errorf("hardware state exceeds 4 MB")};return json.Unmarshal(b,value)}
func writeJSON(path string,value any)error{
 b,e:=json.Marshal(value);if e!=nil{return e};if e=os.MkdirAll(filepath.Dir(path),0700);e!=nil{return e};tmp:=path+".tmp"
 f,e:=os.OpenFile(tmp,os.O_CREATE|os.O_TRUNC|os.O_WRONLY,0600);if e!=nil{return e};defer os.Remove(tmp)
 if _,e=f.Write(b);e!=nil{_ =f.Close();return e};if e=f.Sync();e!=nil{_ =f.Close();return e};if e=f.Close();e!=nil{return e}
 for attempt:=0;attempt<4;attempt++{if attempt>0{time.Sleep(25*time.Millisecond<<uint(attempt-1))};if e=os.Rename(tmp,path);e==nil{return nil}};return fmt.Errorf("replace hardware state after 4 attempts: %w",e)
}
func reserveSequence(dir string,state *diskState)error{if state.Sequence==^uint64(0){return fmt.Errorf("hardware sequence exhausted")};next:=*state;next.Sequence++;if e:=writeJSON(filepath.Join(dir,"hwhealth_state.json"),next);e!=nil{return e};*state=next;return nil}
```
A missing state file starts at zero; corrupt state is retained as a collector initialization error, never silently reset. Cache corruption is recoverable by dropping cache with a warning; absence is normal. Task 13 bounds cache size before writes and sends no snapshot unless sequence reservation succeeds. The writer uses private files and retries Windows sharing violations without modifying the lifecycle state package.
- [ ] **Step 4: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`.
- [ ] **Step 5: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{persist.go,persist_test.go}
git commit -m $'feat(agent): persist hardware sequences and SMART cache atomically\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 13: Orchestrate single-flight collection, budgets, fairness and snapshot limits

**Files:** Create `agent/internal/collectors/hwhealth/collector.go`, `agent/internal/collectors/hwhealth/collector_test.go`; modify Task 11's `agent/internal/collectors/hwhealth/merge.go` and Task 12's `agent/internal/collectors/hwhealth/persist.go` to bound topology capture and state writes.
**Test:** `agent/internal/collectors/hwhealth/collector_test.go`.
**Interfaces:** Produces exact contract `Options{DataDir string; ExtraToolDirs []string; Sources []Source; Now func() time.Time}`, `New(opts Options) *Collector`, `(*Collector).ApplyConfig(Config)`, `(*Collector).Run(ctx context.Context, tiers []Tier) (*Snapshot, error)`. Consumes every source and Tasks 4/11/12. Adds `boundedVendorTopology` with count/serialized-byte limits, and a shared `maxHardwareStateBytes` for persistence reads and writes. `Run` returns `(nil,nil)` for a skipped flight or suppressed daily/disabled duplicate; caller must not upload nil.

- [ ] **Step 1: Write scheduler and transport-limit regressions (5 min).** `collector_test.go`:
```go
package hwhealth
import("context";"encoding/json";"errors";"fmt";"os";"path/filepath";"strings";"sync";"testing";"time";"unicode/utf16";"unicode/utf8")
func fakeSource(k Kind,tier Tier,available bool,fn func(context.Context)(Result,error))Source{return &source{kind:k,tier:tier,detect:func(context.Context)Availability{return Availability{Available:available,Path:"fixture"}},collect:func(ctx context.Context,_ Availability)(Result,error){return fn(ctx)}}}
func good(ctx context.Context)(Result,error){return Result{Complete:true},nil}
func TestCollectorSingleFlight(t *testing.T){entered,release:=make(chan struct{}),make(chan struct{});s:=fakeSource("storcli",TierRAID,true,func(context.Context)(Result,error){close(entered);<-release;return good(context.Background())});c:=New(Options{DataDir:t.TempDir(),Sources:[]Source{s}});done:=make(chan struct{});go func(){defer close(done);if _,e:=c.Run(context.Background(),[]Tier{TierRAID});e!=nil{t.Error(e)}}();<-entered;if snap,e:=c.Run(context.Background(),[]Tier{TierRAID});snap!=nil||e!=nil{t.Fatal("queued a second flight")};c.ApplyConfig(Config{Enabled:true,PollInterval:5*time.Minute,DiskHealthInterval:15*time.Minute});close(release);<-done}
func TestCollectorBudgetFairnessBreaker(t *testing.T){now:=time.Unix(100,0);order:=[]Kind{};hang:=fakeSource("megacli",TierRAID,true,func(ctx context.Context)(Result,error){order=append(order,"megacli");<-ctx.Done();return Result{},ctx.Err()});other:=fakeSource("mdadm",TierRAID,true,func(ctx context.Context)(Result,error){order=append(order,"mdadm");return good(ctx)});c:=New(Options{DataDir:t.TempDir(),Sources:[]Source{hang,other},Now:func()time.Time{return now}});c.budget=20*time.Millisecond
 for cycle:=0;cycle<3;cycle++{s,e:=c.Run(context.Background(),[]Tier{TierRAID});if e!=nil||s==nil{t.Fatal(e)};if cycle==0{if len(order)!=1||s.Sources[1].Status!="failed"||s.Sources[1].Error!="budget exceeded"{t.Fatal(s)}};now=now.Add(10*time.Minute)}
 if len(order)<3||order[1]!="mdadm"{t.Fatal("starved remaining source",order)};s,e:=c.Run(context.Background(),[]Tier{TierRAID});if e!=nil{t.Fatal(e)};found:=false;for _,r:=range s.Sources{if r.Source=="megacli"&&r.Status=="backing_off"&&r.RetryAt!=nil{found=true}};if !found{t.Fatal(s.Sources)}
}
func TestCollectorNoneDisabledAndRestart(t *testing.T){now:=time.Unix(100,0);dir:=t.TempDir();opts:=Options{DataDir:dir,Sources:[]Source{fakeSource("smartctl",TierDisk,false,good)},Now:func()time.Time{return now}};c:=New(opts);s,e:=c.Run(context.Background(),[]Tier{TierRAID});if e!=nil||s.TiersRun[0]!="none"{t.Fatal(s,e)};c=New(opts);if s,e=c.Run(context.Background(),[]Tier{TierDisk});e!=nil||s!=nil{t.Fatal("daily none repeated",s,e)};now=now.Add(24*time.Hour);s,e=c.Run(context.Background(),[]Tier{TierRAID});if e!=nil||s.Sequence!=2{t.Fatal(s,e)};c.ApplyConfig(Config{Enabled:false,PollInterval:10*time.Minute,DiskHealthInterval:time.Hour});s,e=c.Run(context.Background(),nil);if e!=nil||s.TiersRun[0]!="disabled"||s.Sources[0].Status!="disabled"{t.Fatal(s,e)};if s,e=c.Run(context.Background(),nil);s!=nil||e!=nil{t.Fatal(s,e)}}
func TestCollectorDiskOnlyCapabilityIsNotNone(t *testing.T){c:=New(Options{DataDir:t.TempDir(),Sources:[]Source{fakeSource("smartctl",TierDisk,true,good)}});s,e:=c.Run(context.Background(),[]Tier{TierRAID});if e!=nil||s!=nil{t.Fatal("RAID-only empty poll must skip, not send none",s,e)};s,e=c.Run(context.Background(),[]Tier{TierDisk});if e!=nil||s.TiersRun[0]!="disk"{t.Fatal(s,e)}}
func TestCollectorPartialAndPrecedence(t *testing.T){pd:=component("storcli","physical_disk","storcli:c0:e1:s1","","slot","Onln","online");s:=fakeSource("storcli",TierRAID,true,func(context.Context)(Result,error){return Result{Components:[]Component{pd}},errors.New("second query failed")});p:=fakeSource("perccli",TierRAID,true,func(context.Context)(Result,error){t.Fatal("superseded CLI ran");return Result{},nil});c:=New(Options{DataDir:t.TempDir(),Sources:[]Source{s,p}});snap,e:=c.Run(context.Background(),[]Tier{TierRAID});if e!=nil||len(snap.Components)!=1||snap.Sources[0].Status!="ok"||*snap.Sources[0].Complete||snap.Sources[1].Status!="superseded"{t.Fatal(snap,e)}}
func TestCollectorConcurrentConfig(t *testing.T){c:=New(Options{DataDir:t.TempDir(),Sources:[]Source{fakeSource("smartctl",TierDisk,true,good)}});var wg sync.WaitGroup;for i:=0;i<10;i++{wg.Add(1);go func(){defer wg.Done();c.ApplyConfig(Config{Enabled:true,PollInterval:10*time.Minute,DiskHealthInterval:time.Hour});_,_=c.Run(context.Background(),[]Tier{TierDisk})}()};wg.Wait()}
func TestSnapshotLimits(t *testing.T){s:=Snapshot{Sources:[]SourceReport{{Source:"storcli",Status:"ok",Complete:ptr(true)}}};for i:=0;i<2001;i++{c:=component("storcli","physical_disk",strings.Repeat("k",201),"","disk","Onln","online");s.Components=append(s.Components,c)};limitSnapshot(&s);if len(s.Components)!=0||*s.Sources[0].Complete{t.Fatal("oversized keys must not be silently renamed")}}
func TestSnapshotUTF16Limits(t *testing.T){
 for _,tc:=range []struct{name,key string;keep bool}{
  {"bmp-at-limit",strings.Repeat("界",200),true},
  {"supplementary-at-limit",strings.Repeat("😀",100),true},
  {"supplementary-over-limit",strings.Repeat("😀",100)+"a",false},
  {"mixed-over-limit",strings.Repeat("a",199)+"😀",false},
 }{t.Run(tc.name,func(t *testing.T){
  c:=component("storcli","physical_disk",tc.key,"","disk","Onln","online")
  s:=Snapshot{Components:[]Component{c},Sources:[]SourceReport{{Source:"storcli",Status:"ok",Complete:ptr(true)}}};limitSnapshot(&s)
  if (len(s.Components)==1)!=tc.keep||*s.Sources[0].Complete!=tc.keep{t.Fatal(s)}
  if tc.keep&&s.Components[0].ComponentKey!=tc.key{t.Fatal("identity renamed")}
 })}
 for _,units:=range []int{200,201}{
  parent:=strings.Repeat("😀",100);if units==201{parent+="x"}
  c:=component("storcli","physical_disk","pd",parent,"disk","Onln","online")
  s:=Snapshot{Components:[]Component{c},Sources:[]SourceReport{{Source:"storcli",Status:"ok",Complete:ptr(true)}}};limitSnapshot(&s)
  if (s.Components[0].ParentKey!=nil)!=(units==200)||*s.Sources[0].Complete!=(units==200){t.Fatal(s)}
 }
 large:=strings.Repeat("😀",501)
 c:=component("storcli","physical_disk","pd","",large,"Onln","online");c.Model=ptr(large);c.Serial=ptr(large);c.Firmware=ptr(large);c.StateDetail=ptr(large)
 s:=Snapshot{AgentVersion:large,Components:[]Component{c},Sources:[]SourceReport{{Source:"storcli",Status:"ok",Complete:ptr(true),Path:large,ToolVersion:large,Error:large,Warnings:[]string{large}}}}
 limitSnapshot(&s);c=s.Components[0];r:=s.Sources[0]
 for _,field:=range []struct{value string;max int}{{c.Name,200},{*c.Model,200},{*c.Serial,200},{*c.StateDetail,200},{*c.Firmware,100},{r.Path,500},{r.ToolVersion,100},{r.Error,500},{r.Warnings[0],500}}{
  if !utf8.ValidString(field.value)||len(utf16.Encode([]rune(field.value)))!=field.max{t.Fatal(field)}
 }
 // Heartbeat injects the runtime version after Run; marshal must bound that late value too.
 s.AgentVersion=large;b,e:=json.Marshal(s);if e!=nil{t.Fatal(e)};var wire Snapshot;if e=json.Unmarshal(b,&wire);e!=nil{t.Fatal(e)}
 if len(utf16.Encode([]rune(wire.AgentVersion)))!=50{t.Fatal(wire.AgentVersion)}
 for _,tc:=range []struct{input string;max int;want string}{{"a😀b",2,"a"},{"a😀b",3,"a😀"},{"界😀",1,"界"},{"😀",1,""},{"😀",2,"😀"}}{if got:=cut(tc.input,tc.max);got!=tc.want||!utf8.ValidString(got){t.Fatal(tc,got)}}
}
func TestCollectorWindowsTopologyRestart(t *testing.T){
 now:=time.Unix(1000,0);observed:=now;interval:=10*time.Minute
 vd:=component("storcli","virtual_disk","storcli:c0:v0","","VD","Optl","optimal");vd.Serial=ptr("VD-S");vd.Model=ptr("PERC volume")
 pd:=component("storcli","physical_disk","storcli:c0:e1:s1","","PD","Onln","online");pd.Serial=ptr("PD-S");pd.Model=ptr("physical model")
 win:=component("windows_physical_disk","physical_disk","winpd:volume","","disk","OK","online");win.Model=ptr("PERC volume")
 winPD:=component("windows_physical_disk","physical_disk","winpd:member","","disk","OK","online");winPD.Serial=ptr("PD-S")
 vendorRows:=[]Component{vd,pd};vendorComplete:=true;vendorFailed:=false
 raid:=fakeSource("storcli",TierRAID,true,func(context.Context)(Result,error){if vendorFailed{return Result{},errors.New("tool failed")};return Result{Components:vendorRows,Complete:vendorComplete},nil})
 disk:=fakeSource("windows_physical_disk",TierDisk,true,func(context.Context)(Result,error){return Result{Components:[]Component{win,winPD},Complete:true},nil})
 opts:=Options{DataDir:t.TempDir(),Sources:[]Source{raid,disk},Now:func()time.Time{return now}}
 c:=New(opts);if _,e:=c.Run(context.Background(),[]Tier{TierRAID,TierDisk});e!=nil{t.Fatal(e)}
 c=New(opts);now=now.Add(time.Minute)
 check:=func(want bool){t.Helper();snap,e:=c.Run(context.Background(),[]Tier{TierDisk});if e!=nil||snap==nil{t.Fatal(snap,e)}
  volume:=findComponent(t,snap.Components,"winpd:volume");if volume.AlertExempt!=want||(volume.Attributes["backedByVd"]==true)!=want{t.Fatal(volume)}
  count:=2;if want{count=1};if len(snap.Components)!=count||len(snap.Sources)!=1||snap.Sources[0].Source!="windows_physical_disk"||len(snap.TiersRun)!=1||snap.TiersRun[0]!="disk"{t.Fatal("replayed vendor observations or lost PD suppression",snap)}
 }
 check(true)
 if !c.state.VendorTopology[vd.ComponentKey].ObservedAt.Equal(observed){t.Fatal("disk poll refreshed topology")}
 vendorRows=[]Component{pd};vendorComplete=false
 if _,e:=c.Run(context.Background(),[]Tier{TierRAID});e!=nil{t.Fatal(e)};check(true)
 vendorFailed=true;if _,e:=c.Run(context.Background(),[]Tier{TierRAID});e!=nil{t.Fatal(e)};check(true)
 now=observed.Add(2*interval+time.Minute);check(false)
 // A complete empty inventory immediately removes suppression, including after restart.
 vendorFailed=false;vendorComplete=true;vendorRows=[]Component{vd,pd}
 if _,e:=c.Run(context.Background(),[]Tier{TierRAID});e!=nil{t.Fatal(e)};check(true)
 vendorRows=nil;if _,e:=c.Run(context.Background(),[]Tier{TierRAID});e!=nil{t.Fatal(e)};c=New(opts);check(false)
 // A shorter policy interval applies to persisted timestamps without refreshing them.
 vendorRows=[]Component{vd,pd};if _,e:=c.Run(context.Background(),[]Tier{TierRAID});e!=nil{t.Fatal(e)}
 now=now.Add(10*time.Minute);c.ApplyConfig(Config{Enabled:true,PollInterval:5*time.Minute,DiskHealthInterval:time.Hour});check(false)
}
func TestCollectorFailedPersistenceRetriesNone(t *testing.T){
 dir:=t.TempDir();c:=New(Options{DataDir:dir,Sources:[]Source{fakeSource("smartctl",TierDisk,false,good)}})
 blocker:=filepath.Join(dir,"hwhealth_smart_cache.json.tmp");if e:=os.Mkdir(blocker,0700);e!=nil{t.Fatal(e)}
 if s,e:=c.Run(context.Background(),[]Tier{TierRAID});e==nil||s!=nil{t.Fatal("must not publish without persistence")}
 if !c.state.LastNone.IsZero(){t.Fatal("failed write consumed the daily gate")}
 if e:=os.Remove(blocker);e!=nil{t.Fatal(e)}
 if s,e:=c.Run(context.Background(),[]Tier{TierRAID});e!=nil||s==nil||s.Sequence!=1{t.Fatal(s,e)}
}
func TestCollectorUnavailableDoesNotTripBreaker(t *testing.T){
 c:=New(Options{DataDir:t.TempDir(),Sources:[]Source{fakeSource("smartctl",TierDisk,false,good),fakeSource("mdadm",TierRAID,true,good)}})
 for i:=0;i<4;i++{if _,e:=c.Run(context.Background(),[]Tier{TierRAID});e!=nil{t.Fatal(e)}}
 if c.breakers["smartctl"].failures!=0{t.Fatal("unavailable opened breaker")}
}
func TestCollectorSMARTSharedPathIdentity(t *testing.T){
 for _,tc:=range smartIdentityCases(){t.Run(tc.name,func(t *testing.T){
  for _,reverse:=range []bool{false,true}{for _,failedProbe:=range []bool{false,true}{
   smart:=smartSharedPathSource(t,tc.serials,reverse,failedProbe)
   src:=fakeSource("smartctl",TierDisk,true,func(ctx context.Context)(Result,error){return smart.Collect(ctx,Availability{Available:true,Path:"fixture-smartctl"})})
   c:=New(Options{DataDir:t.TempDir(),Sources:[]Source{src},Now:func()time.Time{return time.Unix(100,0)}})
   snap,e:=c.Run(context.Background(),[]Tier{TierDisk});if e!=nil||snap==nil{t.Fatalf("snapshot=%+v error=%v",snap,e)}
   assertSMARTIdentityRows(t,snap.Components,tc.keys)
   if len(snap.Sources)!=1{t.Fatal(snap.Sources)};report:=snap.Sources[0]
   if report.Source!="smartctl"||report.Status!="ok"||report.Complete==nil||*report.Complete==failedProbe{t.Fatal(report)}
   for _,warning:=range report.Warnings{if warning=="component output limited"{t.Fatal("identity collision reached payload filter")}}
   if tc.name!="unique"&&len(c.cache)!=0{t.Fatal("ambiguous serial cached",c.cache)}
  }}
 })}
}
func TestVendorTopologyBounds(t *testing.T){
 now:=time.Unix(1000,0)
 row:=func(i int)Component{return component("storcli","physical_disk",fmt.Sprintf("storcli:c0:e1:s%d",i),"storcli:c0","PD","Onln","online")}
 rows:=make([]Component,2000);for i:=range rows{rows[i]=row(i)}
 topology:=updateVendorTopology(nil,rows,nil,now,10*time.Minute);if len(topology)!=2000{t.Fatal("exact count limit rejected",len(topology))}
 // Partial inventories cannot accumulate an unbounded number of identities across cycles.
 got:=updateVendorTopology(topology,[]Component{row(2000)},nil,now.Add(time.Minute),10*time.Minute)
 if len(got)!=0{t.Fatal("overflow must disable suppression, not create false unique serials",len(got))}
 cases:=[]struct{name string;rows []Component}{{"count",append(rows,row(2000))}}
 for _,field:=range []string{"key","serial","model"}{c:=row(0);huge:=strings.Repeat("x",4*1024*1024);switch field{case "key":c.ComponentKey=huge;case "serial":c.Serial=&huge;case "model":c.Model=&huge};cases=append(cases,struct{name string;rows []Component}{field,[]Component{c}})}
 escaped:=make([]Component,1300);for i:=range escaped{c:=row(i);c.ComponentKey=fmt.Sprintf("%04d",i)+strings.Repeat("\x00",190);c.Serial=ptr(strings.Repeat("\x00",200));c.Model=ptr(strings.Repeat("\x00",200));escaped[i]=c}
 cases=append(cases,struct{name string;rows []Component}{"serialized-bytes",escaped})
 for _,tc:=range cases{t.Run(tc.name,func(t *testing.T){got:=updateVendorTopology(nil,tc.rows,nil,now,10*time.Minute);if len(got)!=0{t.Fatal("unbounded topology retained",len(got))};b,e:=json.Marshal(got);if e!=nil||len(b)>2*1024*1024{t.Fatal(len(b),e)}})}
 // Updating an existing identity does not consume an extra count or renew unseen evidence.
 replacement:=row(0);replacement.Serial=ptr("new")
 got=updateVendorTopology(topology,[]Component{replacement},nil,now.Add(time.Minute),10*time.Minute)
 if len(got)!=2000||got[replacement.ComponentKey].Serial!="new"||!got[row(1).ComponentKey].ObservedAt.Equal(now){t.Fatal("replacement or timestamp changed")}
}
func TestCollectorTopologyBoundedRestart(t *testing.T){
 now:=time.Unix(1000,0);rows:=[]Component{};complete:=true
 vd:=component("storcli","virtual_disk","storcli:c0:v0","storcli:c0","VD","Optl","optimal");vd.Model=ptr("PERC volume")
 win:=component("windows_physical_disk","physical_disk","winpd:volume","","disk","OK","online");win.Model=ptr("PERC volume")
 raid:=fakeSource("storcli",TierRAID,true,func(context.Context)(Result,error){return Result{Components:rows,Complete:complete},nil})
 disk:=fakeSource("windows_physical_disk",TierDisk,true,func(context.Context)(Result,error){return Result{Components:[]Component{win},Complete:true},nil})
 opts:=Options{DataDir:t.TempDir(),Sources:[]Source{raid,disk},Now:func()time.Time{return now}}
 c:=New(opts);rows=[]Component{vd}
 if _,e:=c.Run(context.Background(),[]Tier{TierRAID});e!=nil{t.Fatal(e)}
 // This raw model alone exceeded the state reader limit before wire-field truncation.
 huge:=vd;huge.Model=ptr(strings.Repeat("x",4*1024*1024));rows=[]Component{huge};complete=false
 snap,e:=c.Run(context.Background(),[]Tier{TierRAID});if e!=nil||snap==nil||len(snap.Components)!=1{t.Fatal("lost valid observations",snap,e)}
 if len(c.state.VendorTopology)!=0{t.Fatal("oversized topology persisted")}
 if snap.Sources[0].Complete==nil||*snap.Sources[0].Complete||len(snap.Sources[0].Warnings)==0{t.Fatal("topology limit not reported",snap.Sources)}
 b,e:=os.ReadFile(filepath.Join(opts.DataDir,"hwhealth_state.json"));if e!=nil||len(b)>4*1024*1024{t.Fatal(len(b),e)}
 c=New(opts);snap,e=c.Run(context.Background(),[]Tier{TierDisk});if e!=nil||snap==nil||snap.Sequence!=3{t.Fatal("restart wedged",snap,e)}
 if findComponent(t,snap.Components,"winpd:volume").AlertExempt{t.Fatal("limited topology suppressed disk")}
 rows=[]Component{vd};complete=true
 if _,e=c.Run(context.Background(),[]Tier{TierRAID});e!=nil{t.Fatal(e)}
 c=New(opts);snap,e=c.Run(context.Background(),[]Tier{TierDisk});if e!=nil||snap==nil||snap.Sequence!=5{t.Fatal(snap,e)}
 if !findComponent(t,snap.Components,"winpd:volume").AlertExempt{t.Fatal("normal topology did not recover")}
}
func TestHardwareStateWriteLimit(t *testing.T){
 dir:=t.TempDir();path:=filepath.Join(dir,"boundary.json")
 // A JSON string contributes two quote bytes. Reader and writer share the exact 4 MiB cap.
 atLimit:=strings.Repeat("x",4*1024*1024-2)
 if e:=writeJSON(path,atLimit);e!=nil{t.Fatal(e)};var restored string
 if e:=readJSON(path,&restored);e!=nil||restored!=atLimit{t.Fatal("boundary unreadable",e)}
 before,e:=os.ReadFile(path);if e!=nil{t.Fatal(e)}
 if e=writeJSON(path,atLimit+"x");e==nil{t.Fatal("oversized write accepted")}
 after,e:=os.ReadFile(path);if e!=nil||string(after)!=string(before){t.Fatal("last readable file replaced",e)}
 if _,e=os.Stat(path+".tmp");!os.IsNotExist(e){t.Fatal("oversized write touched temporary file",e)}
 state:=diskState{};if e=reserveSequence(dir,&state);e!=nil{t.Fatal(e)}
 statePath:=filepath.Join(dir,"hwhealth_state.json");before,e=os.ReadFile(statePath);if e!=nil{t.Fatal(e)}
 state.MDMembers=map[string]string{"md0/0":atLimit}
 if e=reserveSequence(dir,&state);e==nil||state.Sequence!=1{t.Fatal("failed reservation advanced sequence",state.Sequence,e)}
 after,e=os.ReadFile(statePath);if e!=nil||string(after)!=string(before){t.Fatal("sequence file overwritten",e)}
 var loaded diskState;if e=readJSON(statePath,&loaded);e!=nil||loaded.Sequence!=1{t.Fatal("restart state lost",e)}
 state.MDMembers=nil;if e=reserveSequence(dir,&state);e!=nil||state.Sequence!=2{t.Fatal("valid retry failed",e)}
}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `undefined: New`. Add the new regression tests before replacing the pre-review implementations, then run:
```bash
cd agent && go test -race ./internal/collectors/hwhealth/... -run 'Test(SnapshotUTF16Limits|CollectorWindowsTopologyRestart)' -count=1
```
Before changing topology and persistence, run these regressions against the pre-review implementations:
```bash
cd agent && go test -race ./internal/collectors/hwhealth/... -run 'Test(VendorTopologyBounds|CollectorTopologyBoundedRestart|HardwareStateWriteLimit)' -count=1
```
Expect red: identities accumulate beyond the cap, a large raw model poisons restart state, and the writer replaces the readable file with more than 4 MiB. The boundary test also requires exactly 4 MiB to remain readable.

Expect failure: the old limiter accepts 201-unit keys and the old collector clears Windows suppression on disk-only polls. The SMART regression uses Task 10's mocked scan/probe helper and checks the final snapshot after `merge` and `limitSnapshot`; restoring the name-only fallback must lose a row and fail this test.
- [ ] **Step 3: Implement construction and synchronized configuration (5 min).** Create `collector.go` with this block and append Step 4's methods:
```go
package hwhealth
import("context";"encoding/json";"fmt";"log/slog";"path/filepath";"runtime";"sort";"sync";"time";"unicode/utf16";"github.com/google/uuid";"github.com/breeze-rmm/agent/internal/collectors")
type Options struct{DataDir string;ExtraToolDirs []string;Sources []Source;Now func()time.Time}
type Collector struct{mu sync.Mutex;flight sync.Mutex;config Config;revision uint64;cancel context.CancelFunc;disabledReported bool;dir string;now func()time.Time;sources []Source;detect map[Kind]*detection;breakers map[Kind]*breaker;state diskState;cache map[string]smartCacheEntry;initErr error;budget time.Duration}
func New(opts Options)*Collector{
 if opts.Now==nil{opts.Now=time.Now};c:=&Collector{dir:opts.DataDir,now:opts.Now,config:Config{true,10*time.Minute,time.Hour},detect:map[Kind]*detection{},breakers:map[Kind]*breaker{},cache:map[string]smartCacheEntry{},budget:4*time.Minute}
 c.initErr=readJSON(filepath.Join(c.dir,"hwhealth_state.json"),&c.state);if c.state.MDMembers==nil{c.state.MDMembers=map[string]string{}}
 if e:=readJSON(filepath.Join(c.dir,"hwhealth_smart_cache.json"),&c.cache);e!=nil{slog.Warn("hardware SMART cache discarded","error",e);c.cache=map[string]smartCacheEntry{}};if c.cache==nil{c.cache=map[string]smartCacheEntry{}}
 c.sources=append([]Source{},opts.Sources...)
 if opts.Sources==nil&&(runtime.GOOS=="windows"||runtime.GOOS=="linux"){c.sources=[]Source{newStorcli("storcli",opts.ExtraToolDirs,runTool),newStorcli("perccli",opts.ExtraToolDirs,runTool),newMDADM(opts.ExtraToolDirs,runTool,c.state.MDMembers),newStorageSpaces(),newWinPD(),newSMART(opts.ExtraToolDirs,runTool,opts.Now)}}
 for _,s:=range c.sources{c.detect[s.Name()]=&detection{};c.breakers[s.Name()]=&breaker{}};return c
}
func(c *Collector)ApplyConfig(cfg Config){
 if cfg.PollInterval<5*time.Minute||cfg.PollInterval>60*time.Minute||cfg.DiskHealthInterval<15*time.Minute||cfg.DiskHealthInterval>1440*time.Minute{return}
 c.mu.Lock();defer c.mu.Unlock();if cfg==c.config{return};c.config=cfg;c.revision++;c.disabledReported=false;if c.cancel!=nil{c.cancel()}
}
```
The parent `collectors` package does not import `hwhealth`; its exported panic guard is safe to consume without an import cycle. Only heartbeat imports both packages. `Options.Sources` non-nil empty deliberately disables real probes in tests; nil selects platform defaults.
- [ ] **Step 4: Implement cycle and wire limits (5 min).** Append to `collector.go`:
```go
func(c *Collector)Run(parent context.Context,tiers []Tier)(*Snapshot,error){
 if !c.flight.TryLock(){return nil,nil};defer c.flight.Unlock();if c.initErr!=nil{return nil,c.initErr}
 ctx,cancel:=context.WithTimeout(parent,c.budget);defer cancel();c.mu.Lock();cfg,revision:=c.config,c.revision;c.cancel=cancel;disabledReported:=c.disabledReported;c.mu.Unlock();defer func(){c.mu.Lock();c.cancel=nil;c.mu.Unlock()}()
 if !cfg.Enabled&&disabledReported{return nil,nil};now:=c.now().UTC();snapshot:=&Snapshot{SnapshotID:uuid.NewString(),CollectedAt:now,PollIntervalMinutes:int(cfg.PollInterval/time.Minute),DiskHealthIntervalMinutes:int(cfg.DiskHealthInterval/time.Minute),TiersRun:[]string{},Sources:[]SourceReport{},Components:[]Component{}}
 requested:=map[Tier]bool{};for _,t:=range tiers{if t==TierRAID||t==TierDisk{requested[t]=true}}
 available:=map[Kind]Availability{};anyAvailable:=false
 if cfg.Enabled{for _,s:=range c.sources{if ctx.Err()!=nil{available[s.Name()]=Availability{Available:true};anyAvailable=true;continue};available[s.Name()]=c.detect[s.Name()].get(now,func()Availability{return s.Detect(ctx)});anyAvailable=anyAvailable||available[s.Name()].Available}}
 noTools:=cfg.Enabled&&!anyAvailable
 if noTools&&!c.state.LastNone.IsZero()&&now.Sub(c.state.LastNone)<24*time.Hour{return nil,nil}
 if !cfg.Enabled{snapshot.TiersRun=[]string{"disabled"}}else if noTools{snapshot.TiersRun=[]string{"none"}}
 order:=append([]Source{},c.sources...);for i,s:=range order{if s.Name()==c.state.Next{order=append(append([]Source{},order[i:]...),order[:i]...);break}}
 ranTiers:=map[Tier]bool{};next:=Kind("")
 for _,s:=range order{
  k:=s.Name();a:=available[k];report:=SourceReport{Source:k,Path:a.Path,ToolVersion:a.Version}
  if !cfg.Enabled{report.Status="disabled";snapshot.Sources=append(snapshot.Sources,report);continue}
  if !a.Available{report.Status="unavailable";snapshot.Sources=append(snapshot.Sources,report);continue}
  if k=="perccli"&&available["storcli"].Available{report.Status="superseded";snapshot.Sources=append(snapshot.Sources,report);continue}
  if !requested[s.Tier()]{continue};ranTiers[s.Tier()]=true;b:=c.breakers[k]
  if b.blocked(now){report.Status="backing_off";report.Error=b.lastError;report.RetryAt=ptr(b.retryAt);snapshot.Sources=append(snapshot.Sources,report);continue}
  if ctx.Err()!=nil{report.Status="failed";report.Error="budget exceeded";if next==""{next=k};snapshot.Sources=append(snapshot.Sources,report);continue}
  start:=time.Now();r,e:=collectors.Guard("hwhealth."+string(k),func()(Result,error){return s.Collect(ctx,a)});report.DurationMs=time.Since(start).Milliseconds();report.Warnings=r.Warnings;if r.ToolVersion!=""{report.ToolVersion=r.ToolVersion}
  if e!=nil&&len(r.Components)==0{report.Status="failed";report.Error=e.Error();b.finish(now,e)}else{report.Status="ok";report.Complete=ptr(r.Complete&&e==nil);if e!=nil{report.Warnings=append(report.Warnings,e.Error())};snapshot.Components=append(snapshot.Components,r.Components...);b.finish(now,nil)}
  snapshot.Sources=append(snapshot.Sources,report)
 }
 if cfg.Enabled&&!noTools{for _,t:=range []Tier{TierRAID,TierDisk}{if ranTiers[t]{snapshot.TiersRun=append(snapshot.TiersRun,string(t))}};if len(snapshot.TiersRun)==0{return nil,nil}}
 topology,topologyLimited:=boundedVendorTopology(c.state.VendorTopology,snapshot.Components,snapshot.Sources,now,cfg.PollInterval)
 if topologyLimited{for i:=range snapshot.Sources{report:=&snapshot.Sources[i];if vendorSource(report.Source)&&report.Status=="ok"{report.Complete=ptr(false);report.Warnings=append(report.Warnings,"vendor topology limited; Windows suppression disabled")}}}
 snapshot.Components=merge(snapshot.Components,c.cache,now,cfg.DiskHealthInterval,topology);limitSnapshot(snapshot)
 // Cache contains unique serial entries only. Bound retention on many changing devices.
 if len(c.cache)>64{keys:=[]string{};for k:=range c.cache{keys=append(keys,k)};sort.Slice(keys,func(i,j int)bool{return c.cache[keys[i]].ObservedAt.After(c.cache[keys[j]].ObservedAt)});for _,k:=range keys[64:]{delete(c.cache,k)}}
 c.mu.Lock();defer c.mu.Unlock();if revision!=c.revision{return nil,nil};if parent.Err()!=nil{return nil,parent.Err()}
 pending:=c.state;pending.VendorTopology=topology;pending.Next=next;if noTools{pending.LastNone=now}
 if e:=writeJSON(filepath.Join(c.dir,"hwhealth_smart_cache.json"),c.cache);e!=nil{return nil,fmt.Errorf("persist hardware SMART cache: %w",e)}
 if e:=reserveSequence(c.dir,&pending);e!=nil{return nil,e};c.state=pending;snapshot.Sequence=c.state.Sequence;if !cfg.Enabled{c.disabledReported=true};return snapshot,nil
}
// Zod string .max() uses JavaScript length: UTF-16 code units, not rune count.
func wireStringLen(s string)int{n:=0;for _,r:=range s{n+=utf16.RuneLen(r)};return n}
func cut(s string,n int)string{units:=0;for i,r:=range s{units+=utf16.RuneLen(r);if units>n{return s[:i]}};return s}
// Runtime version is injected by heartbeat after limitSnapshot; bound it at serialization.
func(s Snapshot)MarshalJSON()([]byte,error){type wire Snapshot;out:=wire(s);out.AgentVersion=cut(out.AgentVersion,50);return json.Marshal(out)}
func limitSnapshot(s *Snapshot){
 incomplete:=func(k Kind){for i:=range s.Sources{if s.Sources[i].Source==k&&s.Sources[i].Status=="ok"{s.Sources[i].Complete=ptr(false);s.Sources[i].Warnings=append(s.Sources[i].Warnings,"component output limited")}}}
 kept:=[]Component{};seen:=map[string]bool{}
 for _,c:=range s.Components{if wireStringLen(c.ComponentKey)>200||c.ComponentKey==""||wireStringLen(c.State)>40||c.State==""||seen[c.ComponentKey]||len(kept)>=2000{incomplete(c.Source);continue};seen[c.ComponentKey]=true;c.Name=cut(c.Name,200);if c.Name==""{c.Name=c.ComponentKey};for _,p:=range []*string{c.Model,c.Serial,c.StateDetail}{if p!=nil{*p=cut(*p,200)}};if c.Firmware!=nil{*c.Firmware=cut(*c.Firmware,100)};if c.ParentKey!=nil&&wireStringLen(*c.ParentKey)>200{c.ParentKey=nil;incomplete(c.Source)};if c.TemperatureC!=nil&&(*c.TemperatureC< -50||*c.TemperatureC>200){c.TemperatureC=nil};if c.ProgressPercent!=nil&&(*c.ProgressPercent<0||*c.ProgressPercent>100){c.ProgressPercent=nil};if c.Attributes==nil{c.Attributes=map[string]any{}}
  b,e:=json.Marshal(c.Attributes);if e!=nil||len(b)>8192{c.Attributes=map[string]any{};incomplete(c.Source)};kept=append(kept,c)
 };s.Components=kept
 for i:=range s.Sources{r:=&s.Sources[i];r.Path=cut(r.Path,500);r.ToolVersion=cut(r.ToolVersion,100);r.Error=cut(r.Error,500);if len(r.Warnings)>50{r.Warnings=r.Warnings[:50]};for j:=range r.Warnings{r.Warnings[j]=cut(r.Warnings[j],500)}}
 for len(s.Components)>0{b,e:=json.Marshal(s);if e==nil&&len(b)<2*1024*1024-1024{break};last:=s.Components[len(s.Components)-1];incomplete(last.Source);s.Components=s.Components[:len(s.Components)-1]}
 for i:=range s.Sources{if len(s.Sources[i].Warnings)>50{s.Sources[i].Warnings=s.Sources[i].Warnings[:50]}}
}
```
In `merge.go`, replace Task 11's entire `updateVendorTopology` function with the following block. Its signature stays unchanged for existing callers; the collector uses the second function to report limiting. The builder checks each entry before inserting it and never truncates an identity or serial. On any overflow it clears this auxiliary suppression cache, since retaining an arbitrary subset could turn duplicate serials into false unique matches.
```go
const maxVendorIdentities=2000
const maxVendorTopologyBytes=2*1024*1024
func updateVendorTopology(previous vendorTopology,rows []Component,reports []SourceReport,now time.Time,interval time.Duration)vendorTopology{
 next,_:=boundedVendorTopology(previous,rows,reports,now,interval);return next
}
func boundedVendorTopology(previous vendorTopology,rows []Component,reports []SourceReport,now time.Time,interval time.Duration)(vendorTopology,bool){
 next:=vendorTopology{};sizes:=map[string]int{};used:=2
 add:=func(key string,e vendorIdentity)bool{
  if key==""||wireStringLen(key)>200||wireStringLen(e.Serial)>200||wireStringLen(e.Model)>200{return false}
  if !vendorSource(e.Source)||(e.Type!="physical_disk"&&e.Type!="virtual_disk"){return false}
  // Include JSON escaping, field names and map-key bytes, not just the raw string lengths.
  b,err:=json.Marshal(map[string]vendorIdentity{key:e});if err!=nil{return false};size:=len(b)-2
  old,exists:=sizes[key];count:=len(next);bytes:=used-old+size
  if !exists{count++;if len(next)>0{bytes++}}
  if count>maxVendorIdentities||bytes>maxVendorTopologyBytes{return false}
  next[key]=e;sizes[key]=size;used=bytes;return true
 }
 replaced:=func(source Kind)bool{for _,r:=range reports{if r.Source==source&&r.Status=="ok"&&r.Complete!=nil&&*r.Complete{return true}};return false}
 for key,e:=range previous{
  if now.Before(e.ObservedAt)||now.Sub(e.ObservedAt)>=2*interval||replaced(e.Source){continue}
  if !add(key,e){return vendorTopology{},true}
 }
 for _,c:=range rows{
  if !vendorSource(c.Source)||(c.ComponentType!="physical_disk"&&c.ComponentType!="virtual_disk"){continue}
  model:="";if c.Model!=nil{model=*c.Model}
  if !add(c.ComponentKey,vendorIdentity{Source:c.Source,Type:c.ComponentType,Serial:serial(c),Model:model,ObservedAt:now}){return vendorTopology{},true}
 }
 return next,false
}
```
Also replace `merge`'s local topology initialization (the statement beginning `topology:=updateVendorTopology`) with this block, so supplying the bounded topology does not first build a second copy from raw rows:
```go
var topology vendorTopology
if len(topologies)>0{topology=topologies[0]}else{topology=updateVendorTopology(nil,rows,nil,now,interval)}
```
In `persist.go`, replace Task 12's `readJSON` and `writeJSON` functions with the following block. Keep `diskState`, `reserveSequence` and the existing imports. The common size guard runs before creating directories, opening a temporary file or replacing the current file; an oversized state cannot consume a sequence or poison the next restart.
```go
const maxHardwareStateBytes=4*1024*1024
func readJSON(path string,value any)error{
 f,e:=os.Open(path);if errors.Is(e,os.ErrNotExist){return nil};if e!=nil{return e};defer f.Close()
 b,e:=io.ReadAll(io.LimitReader(f,maxHardwareStateBytes+1));if e!=nil{return e}
 if len(b)>maxHardwareStateBytes{return fmt.Errorf("hardware state exceeds 4 MiB")};return json.Unmarshal(b,value)
}
func writeJSON(path string,value any)error{
 b,e:=json.Marshal(value);if e!=nil{return e}
 if len(b)>maxHardwareStateBytes{return fmt.Errorf("hardware state exceeds 4 MiB")}
 if e=os.MkdirAll(filepath.Dir(path),0700);e!=nil{return e};tmp:=path+".tmp"
 f,e:=os.OpenFile(tmp,os.O_CREATE|os.O_TRUNC|os.O_WRONLY,0600);if e!=nil{return e};defer os.Remove(tmp)
 if _,e=f.Write(b);e!=nil{_ =f.Close();return e};if e=f.Sync();e!=nil{_ =f.Close();return e};if e=f.Close();e!=nil{return e}
 for attempt:=0;attempt<4;attempt++{if attempt>0{time.Sleep(25*time.Millisecond<<uint(attempt-1))};if e=os.Rename(tmp,path);e==nil{return nil}};return fmt.Errorf("replace hardware state after 4 attempts: %w",e)
}
```
`tiersRun` contains actual scheduled tiers, including failed/backing-off attempts; it never claims a disk probe because cached SMART was replayed. `none` means no capability across both tiers and is persisted at most daily. A budget-skipped source is visible as failed but does not accrue a breaker strike. The next-cycle cursor is a source `Kind`, not a filtered index. Vendor topology capture is independently bounded before merge and payload filtering (2,000 identities, 2 MiB of serialized topology and 200 UTF-16 units per key/serial/model), passed only to Windows suppression, and committed with the reserved sequence; reading it never advances its observation timestamps. Within those bounds the existing TTL, complete-inventory replacement and partial-observation retention rules remain intact. Exceeding a topology bound disables auxiliary Windows suppression for that cycle, reports an incomplete vendor source with a warning, and still uploads the bounded real observations. The full state/cache writer separately enforces the reader's exact 4 MiB cap before replacing any readable file. Wire string limits use UTF-16 units for identity rejection and display-field truncation, always at a whole-rune boundary. Snapshot marshaling also limits the runtime version injected later by Task 14.
- [ ] **Step 5: Run green (2 min).** `cd agent && go test -race ./internal/collectors/hwhealth/...` → `ok`; the budget test uses 20 ms contexts, never sleeps four minutes.
```bash
cd agent && go test -race ./internal/collectors/hwhealth/... -run 'Test(VendorTopologyBounds|CollectorTopologyBoundedRestart|HardwareStateWriteLimit|StorcliBatterySections|StorcliMalformedControllerSiblings|StorcliProgress.*|SMARTSharedPathIdentity|CollectorSMARTSharedPathIdentity|StorcliIncompleteObservations|StorcliExplicitEmptyLists|StorcliRequiredCommandSections|WindowsTopologyAcrossTiers|VendorTopologyPersistence|CollectorWindowsTopologyRestart|SnapshotUTF16Limits)' -count=1
```
Expect exit code 0: both disks and their distinct SMART observations survive the complete collector path; a successful full scan remains complete. Keep the existing duplicate-key payload guard: the source now supplies distinct keys.

- [ ] **Step 6: Commit (2 min).**
```bash
git add agent/internal/collectors/hwhealth/{collector.go,collector_test.go,merge.go,persist.go}
git commit -m $'feat(agent): schedule bounded hardware cycles with fair retries\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 14: Wire configuration, jittered heartbeat gates and tracked delivery

**Files:** Modify `agent/internal/heartbeat/heartbeat.go:3,394,900,940,1765,1962,2051,2069,2090,2260,2275,2949`; Create `agent/internal/heartbeat/hardware_health.go`, `agent/internal/heartbeat/hardware_health_test.go`.
**Test:** `agent/internal/heartbeat/hardware_health_test.go`.
**Interfaces:** Consumes `hwhealth.New`, `ApplyConfig`, `Run`; existing `dueForRun(now, last time.Time, interval time.Duration) bool` at :2309 (strict `>`), `sendInventoryData(endpoint string, payload any, label string) error` at :2244, `applyConfigUpdate(update map[string]any)` at :2940. Produces `sendHardwareHealth(tiers []hwhealth.Tier)`, `applyHardwareMonitoringConfig(raw any)` and private gate/shutdown helpers below.

- [ ] **Step 1: Write config, jitter, startup, transport and shutdown tests (5 min).** `hardware_health_test.go`:
```go
package heartbeat
import("context";"encoding/json";"io";"net/http";"os";"strings";"sync/atomic";"testing";"time";"github.com/breeze-rmm/agent/internal/collectors/hwhealth";"github.com/breeze-rmm/agent/internal/config";"github.com/breeze-rmm/agent/internal/httputil")
type hardwareTestSource struct{collect func(context.Context)(hwhealth.Result,error)}
func(s hardwareTestSource)Name()hwhealth.Kind{return "storcli"}
func(s hardwareTestSource)Tier()hwhealth.Tier{return hwhealth.TierRAID}
func(s hardwareTestSource)Detect(context.Context)hwhealth.Availability{return hwhealth.Availability{Available:true}}
func(s hardwareTestSource)Collect(c context.Context,_ hwhealth.Availability)(hwhealth.Result,error){return s.collect(c)}
type hardwareTransport func(*http.Request)(*http.Response,error)
func(f hardwareTransport)RoundTrip(r *http.Request)(*http.Response,error){return f(r)}
func newHardwareTestHeartbeat(t *testing.T,source hwhealth.Source)*Heartbeat{t.Helper();cfg:=config.Default();cfg.AgentID="fixture-agent";cfg.ServerURL="https://hardware.example.com";cfg.AuthToken="fixture-token";ctx,cancel:=context.WithCancel(context.Background());t.Cleanup(cancel);return &Heartbeat{config:cfg,hwContext:ctx,hwCancel:cancel,hwConfig:hwhealth.Config{Enabled:true,PollInterval:10*time.Minute,DiskHealthInterval:time.Hour},hwhealthCol:hwhealth.New(hwhealth.Options{DataDir:t.TempDir(),Sources:[]hwhealth.Source{source}}),agentVersion:"fixture-version",retryCfg:httputil.DefaultRetryConfig()}}
func TestHardwareConfigAliases(t *testing.T){for _,camel:=range []bool{false,true}{h:=newHardwareTestHeartbeat(t,hardwareTestSource{collect:func(context.Context)(hwhealth.Result,error){return hwhealth.Result{Complete:true},nil}});outer,a,b:="hardware_monitoring_settings","poll_interval_minutes","disk_health_interval_minutes";if camel{outer,a,b="hardwareMonitoringSettings","pollIntervalMinutes","diskHealthIntervalMinutes"};h.applyConfigUpdate(map[string]any{outer:map[string]any{"enabled":false,a:float64(5),b:float64(15)}});if h.hwConfig.Enabled||h.hwConfig.PollInterval!=5*time.Minute||h.hwConfig.DiskHealthInterval!=15*time.Minute{t.Fatal(h.hwConfig)};before:=h.hwConfig;for _,bad:=range []any{"invalid",map[string]any{"enabled":true,a:5.5,b:15.0},map[string]any{"enabled":true,a:4.0,b:15.0}}{h.applyHardwareMonitoringConfig(bad);if h.hwConfig!=before{t.Fatal("invalid config replaced valid config")}}}}
func TestHardwareJitterAndFirstGate(t *testing.T){last:=time.Unix(1000,0);for i:=0;i<100;i++{d:=hardwareInterval(string(rune(i)),hwhealth.TierRAID,last,10*time.Minute);if d<9*time.Minute||d>11*time.Minute{t.Fatal(d)}};h:=newHardwareTestHeartbeat(t,hardwareTestSource{collect:func(context.Context)(hwhealth.Result,error){return hwhealth.Result{Complete:true},nil}});if h.hardwareTiersLocked(last,false)!=nil{t.Fatal("ran before startup timer")};tiers:=h.hardwareTiersLocked(last,true);if len(tiers)!=2{t.Fatal(tiers)};if h.hardwareTiersLocked(last.Add(time.Hour),false)!=nil{t.Fatal("running cycle queued")};h.hwRunning=false;due:=hardwareInterval(h.config.AgentID,hwhealth.TierRAID,last,h.hwConfig.PollInterval);if h.hardwareTiersLocked(last.Add(due),false)!=nil{t.Fatal("changed strict dueForRun boundary")};if got:=h.hardwareTiersLocked(last.Add(due+time.Nanosecond),false);len(got)!=1||got[0]!=hwhealth.TierRAID{t.Fatal(got)}}
func TestHardwarePUTAndConflictNoRetry(t *testing.T){for _,status:=range []int{200,409,413,422}{var calls atomic.Int32;h:=newHardwareTestHeartbeat(t,hardwareTestSource{collect:func(context.Context)(hwhealth.Result,error){return hwhealth.Result{Complete:true},nil}});h.client=&http.Client{Transport:hardwareTransport(func(r *http.Request)(*http.Response,error){calls.Add(1);if r.Method!="PUT"||r.URL.Path!="/api/v1/agents/fixture-agent/hardware-health"{t.Error(r.Method,r.URL)};var s hwhealth.Snapshot;if e:=json.NewDecoder(r.Body).Decode(&s);e!=nil{t.Error(e)};if s.AgentVersion!="fixture-version"||s.Sequence==0||s.SnapshotID==""{t.Error(s)};return &http.Response{StatusCode:status,Header:http.Header{},Body:io.NopCloser(strings.NewReader(`{"accepted":true}`))},nil})};h.dispatchHardwareHealth([]hwhealth.Tier{hwhealth.TierRAID});h.inventoryWg.Wait();if calls.Load()!=1{t.Fatal("unexpected retry",status,calls.Load())}}}
func TestHardwareCancellationAndTracking(t *testing.T){entered:=make(chan struct{});h:=newHardwareTestHeartbeat(t,hardwareTestSource{collect:func(ctx context.Context)(hwhealth.Result,error){close(entered);<-ctx.Done();return hwhealth.Result{},ctx.Err()}});h.dispatchHardwareHealth([]hwhealth.Tier{hwhealth.TierRAID});<-entered;h.stopHardwareHealth();done:=make(chan struct{});go func(){h.inventoryWg.Wait();close(done)}();select{case <-done:case <-time.After(time.Second):t.Fatal("untracked or uncancelled cycle")};h.dispatchHardwareHealth([]hwhealth.Tier{hwhealth.TierRAID});h.inventoryWg.Wait()}
func TestHardwareDisabledRetriesUntilAccepted(t *testing.T){
 h:=newHardwareTestHeartbeat(t,hardwareTestSource{collect:func(context.Context)(hwhealth.Result,error){t.Fatal("disabled source executed");return hwhealth.Result{},nil}})
 h.applyHardwareMonitoringConfig(map[string]any{"enabled":false,"poll_interval_minutes":10.0,"disk_health_interval_minutes":60.0});h.retryCfg.MaxRetries=0
 calls:=0;sequences:=[]uint64{}
 h.client=&http.Client{Transport:hardwareTransport(func(r *http.Request)(*http.Response,error){calls++;var snap hwhealth.Snapshot;if e:=json.NewDecoder(r.Body).Decode(&snap);e!=nil{t.Error(e)};sequences=append(sequences,snap.Sequence);status:=200;if calls==1{status=503};return &http.Response{StatusCode:status,Header:http.Header{},Body:io.NopCloser(strings.NewReader("{}"))},nil})}
 h.dispatchHardwareHealth([]hwhealth.Tier{});h.inventoryWg.Wait();if h.hwDisabledSnapshot==nil||h.hwDisabledQueued{t.Fatal("disabled status lost")}
 h.dispatchHardwareHealth([]hwhealth.Tier{});h.inventoryWg.Wait();if h.hwDisabledSnapshot!=nil||calls!=2||sequences[0]!=sequences[1]{t.Fatal("did not acknowledge the same status snapshot")}
}
func TestHardwareUploadCancellation(t *testing.T){
 entered:=make(chan struct{});h:=newHardwareTestHeartbeat(t,hardwareTestSource{collect:func(context.Context)(hwhealth.Result,error){return hwhealth.Result{Complete:true},nil}})
 h.retryCfg.MaxRetries=0;h.client=&http.Client{Transport:hardwareTransport(func(r *http.Request)(*http.Response,error){close(entered);<-r.Context().Done();return nil,r.Context().Err()})}
 h.dispatchHardwareHealth([]hwhealth.Tier{hwhealth.TierRAID});<-entered;h.stopHardwareHealth();done:=make(chan struct{});go func(){h.inventoryWg.Wait();close(done)}();select{case <-done:case <-time.After(time.Second):t.Fatal("upload ignored shutdown")}
}
func TestHardwareStartupTimerWiring(t *testing.T){
 if hardwareFirstRunDelay!=60*time.Second{t.Fatal("first run must be 60 seconds")}
 body,e:=os.ReadFile("heartbeat.go");if e!=nil{t.Fatal(e)}
 if !strings.Contains(string(body),"func (h *Heartbeat) Start() {\n\th.startHardwareHealth()"){t.Fatal("startup dispatch is not wired before heartbeat jitter")}
 h:=newHardwareTestHeartbeat(t,hardwareTestSource{collect:func(context.Context)(hwhealth.Result,error){t.Fatal("timer fired before 60 seconds");return hwhealth.Result{},nil}})
 h.startHardwareHealth();h.stopHardwareHealth();done:=make(chan struct{});go func(){h.inventoryWg.Wait();close(done)}();select{case <-done:case <-time.After(time.Second):t.Fatal("startup timer not tracked/cancelled")}
}
```
- [ ] **Step 2: Run red (2 min).** `cd agent && go test -race ./internal/heartbeat/...` → `unknown field hwContext` and missing hardware methods.
- [ ] **Step 3: Implement helper methods (5 min).** `hardware_health.go`:
```go
package heartbeat
import("errors";"fmt";"hash/fnv";"math";"strconv";"time";"github.com/breeze-rmm/agent/internal/collectors/hwhealth";"github.com/breeze-rmm/agent/internal/observability")
func hardwareInterval(id string,tier hwhealth.Tier,last time.Time,interval time.Duration)time.Duration{hash:=fnv.New64a();_,_=hash.Write([]byte(id+":"+string(tier)+":"+strconv.FormatInt(last.UnixNano(),10)));offset:=int64(hash.Sum64()%20001)-10000;return interval+time.Duration(int64(interval)*offset/100000)}
// Called under h.mu, including by the startup goroutine. Nil means no dispatch.
func(h *Heartbeat)hardwareTiersLocked(now time.Time,first bool)[]hwhealth.Tier{
 if h.hwStopping||h.hwRunning||h.hwhealthCol==nil{return nil};if !h.hwStarted&&!first{return nil};h.hwStarted=true
 if !h.hwConfig.Enabled{if h.hwDisabledQueued{return nil};h.hwDisabledQueued=true;h.hwRunning=true;return []hwhealth.Tier{}}
 tiers:=[]hwhealth.Tier{};if first||dueForRun(now,h.lastHwRaidRun,hardwareInterval(h.config.AgentID,hwhealth.TierRAID,h.lastHwRaidRun,h.hwConfig.PollInterval)){tiers=append(tiers,hwhealth.TierRAID)};if first||dueForRun(now,h.lastHwDiskRun,hardwareInterval(h.config.AgentID,hwhealth.TierDisk,h.lastHwDiskRun,h.hwConfig.DiskHealthInterval)){tiers=append(tiers,hwhealth.TierDisk)};if len(tiers)==0{return nil};for _,t:=range tiers{if t==hwhealth.TierRAID{h.lastHwRaidRun=now}else{h.lastHwDiskRun=now}};h.hwRunning=true;return tiers
}
const hardwareFirstRunDelay=60*time.Second
func(h *Heartbeat)startHardwareHealth(){
 h.mu.Lock();if h.hwhealthCol==nil||h.hwStopping{h.mu.Unlock();return};h.inventoryWg.Add(1);h.mu.Unlock()
 go func(){defer h.inventoryWg.Done();defer observability.Recoverer("heartbeat.hardwareHealthStartup");timer:=time.NewTimer(hardwareFirstRunDelay);defer timer.Stop();select{case <-h.hwContext.Done():return;case now:=<-timer.C:h.mu.Lock();tiers:=h.hardwareTiersLocked(now,true);h.mu.Unlock();if tiers!=nil{h.dispatchHardwareHealth(tiers)}}}()
}
func(h *Heartbeat)dispatchHardwareHealth(tiers []hwhealth.Tier){
 h.mu.Lock();if h.hwStopping{h.hwRunning=false;h.mu.Unlock();return};h.inventoryWg.Add(1);h.mu.Unlock()
 go func(){defer h.inventoryWg.Done();defer observability.Recoverer("heartbeat.hardwareHealth");h.sendHardwareHealth(tiers)}()
}
type hardwareSubmissionError struct{status int}
func(e *hardwareSubmissionError)Error()string{return fmt.Sprintf("inventory send failed for hardware health: status %d",e.status)}
func(h *Heartbeat)sendHardwareHealth(tiers []hwhealth.Tier){
 defer func(){h.mu.Lock();h.hwRunning=false;h.mu.Unlock()}()
 h.mu.Lock();snapshot:=h.hwDisabledSnapshot;h.mu.Unlock();var e error
 if snapshot==nil{snapshot,e=h.hwhealthCol.Run(h.hwContext,tiers)}
 if e!=nil{log.Warn("hardware health collection failed","error",e);h.mu.Lock();h.hwDisabledQueued=false;h.mu.Unlock();return}
 if snapshot==nil{h.mu.Lock();h.hwDisabledQueued=false;h.mu.Unlock();return};snapshot.AgentVersion=h.agentVersion
 e=h.sendInventoryData("hardware-health",snapshot,"hardware health")
 if e!=nil{log.Warn("hardware health submission failed","error",e)}
 disabled:=len(snapshot.TiersRun)==1&&snapshot.TiersRun[0]=="disabled";if !disabled{return}
 var status *hardwareSubmissionError;permanent:=errors.As(e,&status)&&status.status>=400&&status.status<500&&status.status!=429
 h.mu.Lock();defer h.mu.Unlock();h.hwDisabledSnapshot=nil
 if e!=nil&&!permanent&&!h.hwConfig.Enabled&&!h.hwStopping{h.hwDisabledSnapshot=snapshot;h.hwDisabledQueued=false}
}
func(h *Heartbeat)stopHardwareHealth(){h.mu.Lock();h.hwStopping=true;cancel:=h.hwCancel;h.mu.Unlock();if cancel!=nil{cancel()}}
func(h *Heartbeat)applyHardwareMonitoringConfig(raw any){
 m,ok:=raw.(map[string]any);if !ok{log.Warn("ignoring invalid hardware_monitoring_settings object");return};enabled,ok:=m["enabled"].(bool);if !ok{log.Warn("ignoring hardware monitoring config without enabled");return}
 integer:=func(snake,camel string)(int,bool){v,exists:=m[snake];if !exists{v=m[camel]};switch n:=v.(type){case int:return n,true;case float64:if !math.IsNaN(n)&&!math.IsInf(n,0)&&n==math.Trunc(n)&&n>=0&&n<=1440{return int(n),true}};return 0,false}
 raid,rok:=integer("poll_interval_minutes","pollIntervalMinutes");disk,dok:=integer("disk_health_interval_minutes","diskHealthIntervalMinutes");if !rok||!dok||raid<5||raid>60||disk<15||disk>1440{log.Warn("ignoring invalid hardware monitoring intervals");return}
 cfg:=hwhealth.Config{Enabled:enabled,PollInterval:time.Duration(raid)*time.Minute,DiskHealthInterval:time.Duration(disk)*time.Minute};h.mu.Lock();defer h.mu.Unlock();if cfg==h.hwConfig{return};wasEnabled:=h.hwConfig.Enabled;h.hwConfig=cfg;h.hwDisabledQueued=false;h.hwDisabledSnapshot=nil;if enabled&&!wasEnabled{h.lastHwRaidRun=time.Time{};h.lastHwDiskRun=time.Time{}};if h.hwhealthCol!=nil{h.hwhealthCol.ApplyConfig(cfg)}
}
```
- [ ] **Step 4: Apply the exact heartbeat insertion blocks (5 min).** Add the existing-module import to `heartbeat.go`:
```go
"github.com/breeze-rmm/agent/internal/collectors/hwhealth"
```
Inside `Heartbeat` at :394 add:
```go
hwhealthCol *hwhealth.Collector
hwConfig hwhealth.Config
lastHwRaidRun time.Time
lastHwDiskRun time.Time
hwContext context.Context
hwCancel context.CancelFunc
hwStarted bool
hwRunning bool
hwStopping bool
hwDisabledQueued bool
hwDisabledSnapshot *hwhealth.Snapshot
```
Inside `NewWithVersion`'s literal at :900 add:
```go
hwhealthCol: hwhealth.New(hwhealth.Options{DataDir:config.GetDataDir(),ExtraToolDirs:cfg.Hardware.ToolDirs}),
hwConfig: hwhealth.Config{Enabled:true,PollInterval:10*time.Minute,DiskHealthInterval:time.Hour},
```
Immediately after the literal ending at :939, before `h.accepting.Store(true)`:
```go
h.hwContext,h.hwCancel=context.WithCancel(context.Background())
```
First statement of `Start()` at :1765, before the existing startup jitter:
```go
h.startHardwareHealth()
```
Within the tick's held `h.mu` block at :1962:
```go
hwTiers:=h.hardwareTiersLocked(now,false)
```
In the dispatch block after unlocking, next to :2051:
```go
if hwTiers!=nil{h.dispatchHardwareHealth(hwTiers)}
```
First statement of `DrainAndWait(ctx context.Context)` at :2069 and first statement inside `Stop`'s `h.stopOnce.Do(func(){` at :2091 (insert the same complete statement at both anchors):
```go
h.stopHardwareHealth()
```
In `sendInventoryData` replace its context construction at :2260 with the following block; preserve its signature and every non-hardware endpoint's behavior:
```go
parent:=context.Background()
if endpoint=="hardware-health"&&h.hwContext!=nil{parent=h.hwContext}
ctx,cancel:=context.WithTimeout(parent,30*time.Second)
defer cancel()
```
Before its final error return at :2275 add:
```go
if endpoint=="hardware-health"{return &hardwareSubmissionError{status:resp.StatusCode}}
```
Before the existing event-log config case at :2949:
```go
hwRaw,hasHW:=update["hardware_monitoring_settings"]
if !hasHW{hwRaw,hasHW=update["hardwareMonitoringSettings"]}
if hasHW{h.applyHardwareMonitoringConfig(hwRaw)}
```
The cancellation occurs before `inventoryWg.Wait`, preventing new hardware Adds during drain. The timer is tracked and cancelled too. A failed upload uses existing transport retry policy; 409/413/422 are not retried (`httputil/retry_test.go:53`, existing conflict assertion). The next enabled cycle gets a newer sequence. A disabled snapshot is retried after a transport failure or retryable HTTP status, until accepted or rejected permanently; 409/413/422 discard it. Re-enabling clears that single pending status snapshot.
- [ ] **Step 5: Run green, format and verify platform builds (5 min).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/...
```
```bash
cd agent && go test -race ./internal/heartbeat/... ./internal/config/...
```
Both commands must print `ok`; inspect exit codes directly. Then:
```bash
gofmt -w agent/internal/collectors/hwhealth agent/internal/heartbeat/hardware_health.go agent/internal/heartbeat/hardware_health_test.go agent/internal/heartbeat/heartbeat.go agent/internal/config/config.go agent/internal/config/validate.go agent/internal/config/hardware_test.go
```
```bash
cd agent && go test -race ./...
```
```bash
cd agent && go vet ./...
```
```bash
cd agent && GOOS=darwin GOARCH=arm64 go test -c ./internal/collectors/hwhealth -o /tmp/breeze-hwhealth-darwin.test
```
```bash
cd agent && GOOS=windows GOARCH=amd64 go test -c ./internal/collectors/hwhealth -o /tmp/breeze-hwhealth-windows.test.exe
```
Native Windows validation is a release gate, not satisfied by the compile command. On the designated Windows VM's repository checkout, run these exact PowerShell commands and attach the output/exit codes to the W02a issue:
```powershell
Set-Location agent
go test -race ./internal/collectors/hwhealth/...
if ($LASTEXITCODE -ne 0) { throw 'hardware health tests failed' }
go test -race ./internal/heartbeat/... ./internal/config/...
if ($LASTEXITCODE -ne 0) { throw 'heartbeat/config tests failed' }
go test -race ./...
if ($LASTEXITCODE -ne 0) { throw 'agent suite failed' }
go vet ./...
if ($LASTEXITCODE -ne 0) { throw 'go vet failed' }
```
Run the same package tests natively on Linux to exercise its adapter. Windows race tests require the existing VM's C toolchain; record an unavailable VM/toolchain as an unmet release gate, never label a cross-compile a native pass. No lab disks are modified in W02a; W06 owns destructive fault injection and the complete alert proof.
- [ ] **Step 6: Commit (2 min).**
```bash
git add agent/internal/heartbeat/{heartbeat.go,hardware_health.go,hardware_health_test.go} agent/internal/collectors/hwhealth agent/internal/config/{config.go,validate.go,hardware_test.go}
git commit -m $'feat(agent): deliver hardware health on jittered tracked heartbeat gates\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

## Self-review

- Third-pass P2 (battery completeness, Task 5): validate CV/BBU section arrays and record types; `[{}]`, null/wrong-type states and malformed presence flags produce `Complete:false` without inventing a battery. Explicit empty lists and explicit absence retain their existing semantics; mixed lists retain valid observations.
- Third-pass P2 (controller isolation, Task 5): decode the outer envelope into raw controller messages and each controller's status/identity/`Response Data` independently. Regressions prove both storcli and perccli retain valid sibling controller/VD/PD observations when a malformed controller is first or last. The proposed source files do not yet exist in this checkout; verification used the plan's executable blocks and the index/design partial-observation contract.
- Third-pass P2 (progress identity, Task 6): share that controller decoder, validate component identifiers and embedded controller paths, reject conflicting identities, and verify source/type/parent on the observed target before changing progress/state. Missing controller identity cannot default to zero; valid zero IDs and valid siblings still work for init/CC/rebuild replies.
- Third-pass P2 (durable topology bounds, Task 13): bound capture to 2,000 identities / 2 MiB serialized topology, reject oversized identity fields without truncating serials, and enforce the same 4 MiB limit in the reader and writer before any file replacement. Overflow clears only auxiliary suppression evidence to avoid false uniqueness, retains real observations with an incomplete warning, and cannot wedge collection after restart. Tests cover cumulative partial inventories, escaped-byte size, large raw fields, exact reader/writer boundaries, preserved last-readable bytes, unconsumed sequence on failure, restart and recovery.
- Third-pass boundary: W02a supplies every new decoder, guard and regression itself. Task 13 completes the bounds on its own Task 11/12 helpers; no other wave must supply implementation. Only this plan document is changed; existing persistence references (`state.go` and `change_tracker.go`) remain read-only.

- Cross-plan P2 (storcli completeness): Task 5 validates successful wrappers, required response/list sections and controller/PD/VD identities. Missing sections or malformed records preserve valid observations with `Complete:false`; explicit empty lists remain complete. Task 6 supplies command-specific section requirements so split queries do not require unrelated lists. Parser regressions cover both storcli and perccli.
- Cross-plan P2 (Windows suppression): Task 11 uses the last observed vendor VD/PD serials and models, timestamped per identity. Tasks 12–13 persist them in `hwhealth_state.json`, retain them across restart and disk-only/failed/partial polls without renewing unseen evidence, and expire them at 2 × the current RAID interval. A complete source inventory replaces that source's topology. Regressions cover restart, expiry, policy shortening, partial/failing polls, removal and duplicate serials. SMART merging remains snapshot-local; cached vendor health rows are never replayed.
- Cross-plan P3 (wire string limits): Task 13 counts UTF-16 code units with `utf16.RuneLen`, rejects oversized keys, bounds all free-text fields without splitting supplementary characters, and limits the late-injected agent version during marshaling. Tests cover BMP, supplementary and mixed strings at and above each bound. Verified against the index §B Zod contract and [Zod 4.4.3's length check](https://github.com/colinhacks/zod/blob/v4.4.3/packages/zod/src/v4/core/checks.ts#L580-L583) (the version resolved in `pnpm-lock.yaml`); the current checkout has no implemented `hwhealth` package yet.
- Second-pass boundary: W02a supplies all parser, topology persistence, collector wiring and wire-limit tests in this plan. These fixes require no implementation changes from W01/W02b or any other wave; only this plan document is edited.

- Cross-plan P2 (SMART identity): Tasks 1 and 10 extend only the §4.2 fallback to `smart:dev:<type>:<name>` and retain the unique non-blank serial key. Task 10 carries the exact scan type/name through successful probes; tests cover shared paths, blank/whitespace/duplicate serials, scan reordering and an intervening failed probe. Task 13 checks those rows survive merge and payload filtering with completeness preserved. Task 11's synthetic fallback example uses the same format.
- Index synchronization boundary: the Task 1 table records the authorized SMART fallback extension for the index's §H → §4.2 contract reference; the index/design still need that fallback text synchronized by their owner. This wave supplies its own key builder and regressions and requires no implementation from another wave. Only this W02a plan is edited.

- Spec §4.1–§4.2: Task 1 fixes camelCase wire names and source-specific identities; Task 7 persists stable md member identities.
- Spec §5.1–§5.2: Tasks 5–10 cover storcli/perccli, mdadm, Storage Spaces, Windows disks and smartctl with raw fixtures and mapping tests.
- Spec §5.3 and §6.6: Task 3 creates hourly discovery and the local `hardware.tool_dirs` foundation; W02b extends it to the remaining sources.
- Spec §6.1–§6.4: Tasks 2, 4 and 13 cover partial observations, bounded execution, single-flight, fairness and visible backoff.
- Spec §6.5–§6.7: Tasks 11–14 preserve SMART evidence, cap payloads, persist sequence, deliver policy updates and track shutdown.
- Index §H overrides the spec's runner-location and config-key inconsistencies; state persistence follows the existing writer's idiom without changing its signature.
- Index §C/§H leaves runtime version injection to heartbeat; `Options` remains exact and `snapshot.AgentVersion` comes from the existing `h.agentVersion`.
- Spec §4.2 leaves unslotted Storage Spaces PD identity unspecified; Task 8 uses the contracted slotted format with a UniqueId hash, while pool/VD hashes use ObjectId.
- W01 owns ingest, health derivation and policy UI; W02b owns MegaCli/ssacli/arcconf/omreport/zfs and full Broadcom precedence; W03/W04 own alerts and display.
- W05 owns BMC sources; W06 owns live fault/recovery proof and release notes. W02a requires native Windows test evidence and an agent release.

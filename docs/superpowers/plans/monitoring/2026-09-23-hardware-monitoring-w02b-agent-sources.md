# Hardware & RAID Monitoring — W02b Agent Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect MegaCli, HPE, Adaptec, Dell OMSA and ZFS storage observations without duplicate Broadcom reporting or unsafe completeness claims.
**Architecture:** Extend W02a's `hwhealth.Source` implementations and feed its existing runner, scheduler, breaker and snapshot pipeline. Parse vendor output into the index §C `Component` and `Result` types; select Broadcom sources from cached detection results before executing storage commands. The API remains the sole authority for health derivation.
**Tech Stack:** Go standard library (`context`, `encoding/csv`, `encoding/json`, `regexp`, `testing`), W02a `hwhealth` package, fixture files.
**Spec:** `docs/superpowers/specs/monitoring/2026-09-23-hardware-raid-monitoring-design.md`.
**Index:** `docs/superpowers/plans/monitoring/2026-09-23-hardware-monitoring.md`.
**Wave:** W02b, branch `feature/<parent#>-hardware-monitoring/wave-<sub#>`.
**Depends on:** W02a merged or stacked beneath this branch; index §H interfaces must compile first.

## Global Constraints

- Agent code ships to customer machines: `go test -race ./...`, fixture-driven parser tests, a
  native Windows run on VM `.55` for W02a/W02b/W05 (cross-compile has missed test bugs before).
- Files stay under ~500 lines; new code goes in new files next to the pattern it copies.

## Review Focus

No index review-focus item is owned by W02b. Item 5 remains owned by W02a:

5. A vendor CLI that hangs forever (MegaCli on a dead controller) — cycle budget cancels it, the
   source reports `failed`, other sources still run, and after three cycles the breaker opens;
   W02a scheduler + breaker tests.

Task 11 pins the new sources' cancellation/error propagation into those existing tests; it does not recreate the scheduler or breaker.

## File Structure

All Go paths below are under `agent/internal/collectors/hwhealth/` unless shown otherwise.

| Action | File | Responsibility |
|---|---|---|
| Create | `vendor_states.go`, `vendor_states_test.go` | W02b-only state mappings and closed-vocabulary tests |
| Create | `vendor_text.go`, `vendor_text_test.go` | Bounded text records, component construction, partial-command collection |
| Create | `megacli.go`, `megacli_test.go` | MegaCli adapter, logical/physical disks, membership and BBU |
| Create | `ssacli.go`, `ssacli_test.go` | HPE controllers, arrays, disks and cache/battery |
| Create | `arcconf.go`, `arcconf_test.go` | Controller enumeration, devices and battery/ZMM |
| Create | `omreport.go`, `omreport_test.go` | SSV tables and per-controller physical disks |
| Create | `zfs_linux.go`, `zfs_linux_test.go` | Linux ZFS list/status parsing and stable member identity |
| Create | `zfs_json_linux.go`, `zfs_json_linux_test.go` | OpenZFS version gate and nested JSON |
| Modify | `detect.go` (W02a prerequisite, index §H:500) | Availability selection before collection |
| Modify | `collector.go` (W02a prerequisite, index §H:501) | Register sources and translate suppressed reports |
| Create | `precedence_test.go`, `sources_test.go` | Selection, real `New`/`Run` wiring and source failures |
| Create | `sources_linux.go`, `sources_other.go` | Platform registry additions |
| Create | `fixtures_test.go`, `fixtures_linux_test.go` | Complete §13 fixture matrix |
| Create | `testdata/megacli/*.{json,txt}`, `testdata/ssacli/*.{json,txt}`, `testdata/arcconf/*.{json,txt}`, `testdata/omreport/*.{json,txt}`, `testdata/zfs/*.{json,txt}` | Synthetic, fixture-only native output, never customer captures |
| Create | `tool_dirs_test.go` | Override lookup and documentation contract |
| Modify | `docs/guides/AGENT_INSTALLATION.md:534` | Agent-local tool directory instructions before Logging |

### Read evidence and implementation boundaries

Read in order: index, spec, root `CLAUDE.md`, required sources. W02a's plan and the `hwhealth/` directory were absent at initial inspection. W02a's plan appeared during final review and was then opened: `docs/superpowers/plans/monitoring/2026-09-23-hardware-monitoring-w02a-agent-core.md`. Its concrete planned declarations now anchor Tasks 9–10: detection at :352–353, test helpers at :461–462, `Collector`/`New` at :1032–1033, detection-map assembly at :1055, and the existing perccli suppression at :1065. These are line numbers in the prerequisite plan, not fabricated source-file anchors; the actual package is still absent in this checkout. W02a's `toolRunner` is reused, and the new mapping/test helpers have distinct names to avoid its storcli helpers.

Existing anchors inspected: `agent/internal/collectors/command_limits.go:176` defines `runCollectorBoundedOutput(timeout time.Duration, name string, args ...string) ([]byte, error)`; line 177 creates a background context and line 209 discards output on nonzero exit. `command_limits.go:41` defines `runCollectorOutputWithContext(parent context.Context, timeout time.Duration, name string, args ...string) ([]byte, error)` but its return type is not the new contract. Consume W02a's `runTool` unchanged. `hardware_linux.go:1` supplies the Linux build-tag idiom; lines 34 and 44 are `collectPlatformHardware` and its `lspci` execution. None of those files is modified.

Test patterns inspected: `command_limits_test.go:18` table/helper conventions, `:138` portable subprocess helper; `powershell_encoding_test.go:8` isolated tests; `runtime_stats_test.go:34` wire-contract assertions. Existing docs anchor: `docs/guides/AGENT_INSTALLATION.md:465` Configuration Options, `:477` YAML reference, `:534` Logging.

Decisions left to this plan: unknown vendor strings become `unknown` with raw `StateDetail`; a partial source returns parsed rows with `Complete=false` and nil error, while zero usable observations plus a command/parse failure returns an error. No executable download, shell command interpolation, remediation, or health field is introduced. Missing batteries explicitly reported by a tool produce `missing`; absence of a battery section alone does not fabricate one. Synthetic fixtures prove parsing, not vendor certification.

Every command block is run from the repository root in a fresh shell. The Go snippets are complete new declarations; append snippets explicitly say which existing file receives them. W02a owns `types.go`, `source.go`, `runner.go`, `keys.go`, `merge.go`, the detection-cache contract, config wiring and heartbeat scheduling. Key construction follows §4.2; W02a plan:256–258 defines `controllerKey(k Kind,id string) string`, `slotKey(c,e,s string) string`, and `memberKey(v,id string) string`, reused below.

### Task 1: Close the W02b state vocabulary

**Files:** Create `agent/internal/collectors/hwhealth/vendor_states.go`; Test: `agent/internal/collectors/hwhealth/vendor_states_test.go`.
**Interfaces:** Consumes `Kind`, `ComponentType` (index §C). Produces `remainingVendorState(Kind, ComponentType, string) string` and `remainingVendorStates map[string]map[string]string`; all later parsers retain the original input independently in `StateDetail`.

- [ ] **Step 1: Write the failing state-table test (3 minutes).** Create the test file:

```go
package hwhealth

import (
    "strings"
    "testing"
)

func TestVendorStates(t *testing.T) {
    // Mirrors HARDWARE_STATES in index §B / packages/shared/src/constants/hardwareHealth.ts.
    allowed := map[ComponentType]string{
        "controller": "ok degraded failed unknown",
        "virtual_disk": "optimal rebuilding initializing checking migrating degraded partially_degraded failed offline unknown",
        "physical_disk": "online hotspare ready jbod unconfigured rebuilding copyback foreign shielded predictive_failure degraded failed missing offline unknown",
        "cache_battery": "ok charging learning degraded failed missing unknown",
    }
    // Explicit expected mappings, independent of the implementation map.
    rows := []struct{ source Kind; typ ComponentType; raw, want string }{
        {"megacli","virtual_disk","Optimal|Degraded|Partially Degraded|Offline","optimal|degraded|partially_degraded|offline"},
        {"megacli","virtual_disk","Rebuild|Consistency Check|Initialization","rebuilding|checking|initializing"},
        {"megacli","physical_disk","Online, Spun Up|Hotspare, Spun Up|Unconfigured(good)|Unconfigured(bad)|Rebuild|Copyback|Failed|Offline|JBOD","online|hotspare|ready|failed|rebuilding|copyback|failed|offline|jbod"},
        {"megacli","cache_battery","Optimal|Learn Cycle Active|Battery Replacement required|Pack is about to fail|Degraded","ok|learning|failed|failed|degraded"},
        {"ssacli","controller","OK|Failed|Temporarily Disabled|Permanently Disabled","ok|failed|degraded|degraded"},
        {"ssacli","cache_battery","OK|Recharging|Failed|Not Present","ok|charging|failed|missing"},
        {"ssacli","virtual_disk","OK|Interim Recovery Mode|Failed|Recovering|Rebuilding|Ready for Rebuild|Transforming|Queued for Expansion|In Progress","optimal|degraded|failed|rebuilding|rebuilding|rebuilding|migrating|migrating|initializing"},
        {"ssacli","physical_disk","OK|Predictive Failure|Failed|Rebuilding|Erasing|Spare Drive","online|predictive_failure|failed|rebuilding|online|hotspare"},
        {"arcconf","virtual_disk","Optimal|Degraded|Suboptimal, Fault Tolerant|Failed|Impacted|Rebuilding","optimal|degraded|degraded|failed|failed|rebuilding"},
        {"arcconf","physical_disk","Online|Hot Spare|Ready|Failed|Rebuilding|Raw (Pass Through)","online|hotspare|ready|failed|rebuilding|jbod"},
        {"arcconf","cache_battery","Optimal|Charging|Not Installed|Failed","ok|charging|missing|failed"},
        {"omreport","virtual_disk","Ready|Degraded|Failed|Background Initialization|Resynching|Regenerating|Formatting","optimal|degraded|failed|initializing|rebuilding|rebuilding|initializing"},
        {"omreport","physical_disk","Online|Ready|Failed|Foreign|Blocked|Non-RAID|Rebuilding|Removed","online|ready|failed|foreign|offline|jbod|rebuilding|missing"},
        {"omreport","cache_battery","Ready|Degraded|Failed|Charging|Learning|Missing","ok|degraded|failed|charging|learning|missing"},
        {"zfs","virtual_disk","ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED|scrub|resilver","optimal|degraded|failed|offline|failed|failed|checking|rebuilding"},
        {"zfs","physical_disk","ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED","online|degraded|failed|offline|missing|missing"},
    }
    for _, row := range rows {
        wants := strings.Split(row.want, "|")
        for i, raw := range strings.Split(row.raw, "|") {
            t.Run(string(row.source)+"/"+string(row.typ)+"/"+raw, func(t *testing.T) {
                got := remainingVendorState(row.source, row.typ, raw)
                if got != wants[i] { t.Fatalf("%q maps to %q, want %q", raw, got, wants[i]) }
                if !strings.Contains(" "+allowed[row.typ]+" ", " "+got+" ") { t.Fatal("outside HARDWARE_STATES:", got) }
            })
        }
        if remainingVendorState(row.source,row.typ,"future vendor state") != "unknown" { t.Fatal("fallback must be unknown") }
    }
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: remainingVendorState`.
- [ ] **Step 3: Implement the state table (5 minutes).** Create `vendor_states.go`:

```go
package hwhealth

import "strings"

var remainingVendorStates = func() map[string]map[string]string {
    rows := []struct{ key, raw, normalized string }{
        {"megacli/controller","Optimal|OK|Degraded|Failed","ok|ok|degraded|failed"},
        {"megacli/virtual_disk","Optimal|Degraded|Partially Degraded|Offline|Rebuild|Consistency Check|Initialization","optimal|degraded|partially_degraded|offline|rebuilding|checking|initializing"},
        {"megacli/physical_disk","Online, Spun Up|Hotspare, Spun Up|Unconfigured(good)|Unconfigured(bad)|Rebuild|Copyback|Failed|Offline|JBOD","online|hotspare|ready|failed|rebuilding|copyback|failed|offline|jbod"},
        {"megacli/cache_battery","Optimal|Learn Cycle Active|Battery Replacement required|Pack is about to fail|Degraded","ok|learning|failed|failed|degraded"},
        {"ssacli/controller","OK|Failed|Temporarily Disabled|Permanently Disabled","ok|failed|degraded|degraded"},
        {"ssacli/cache_battery","OK|Recharging|Failed|Not Present","ok|charging|failed|missing"},
        {"ssacli/virtual_disk","OK|Interim Recovery Mode|Failed|Recovering|Rebuilding|Ready for Rebuild|Transforming|Queued for Expansion|In Progress","optimal|degraded|failed|rebuilding|rebuilding|rebuilding|migrating|migrating|initializing"},
        {"ssacli/physical_disk","OK|Predictive Failure|Failed|Rebuilding|Erasing|Spare Drive","online|predictive_failure|failed|rebuilding|online|hotspare"},
        {"arcconf/controller","Optimal|OK|Degraded|Failed","ok|ok|degraded|failed"},
        {"arcconf/virtual_disk","Optimal|Degraded|Suboptimal, Fault Tolerant|Failed|Impacted|Rebuilding","optimal|degraded|degraded|failed|failed|rebuilding"},
        {"arcconf/physical_disk","Online|Hot Spare|Ready|Failed|Rebuilding|Raw (Pass Through)","online|hotspare|ready|failed|rebuilding|jbod"},
        {"arcconf/cache_battery","Optimal|Charging|Not Installed|Failed","ok|charging|missing|failed"},
        {"omreport/controller","Ok|Non-Critical|Critical|Failed|Degraded","ok|degraded|failed|failed|degraded"},
        {"omreport/virtual_disk","Ready|Degraded|Failed|Background Initialization|Resynching|Regenerating|Formatting","optimal|degraded|failed|initializing|rebuilding|rebuilding|initializing"},
        {"omreport/physical_disk","Online|Ready|Failed|Foreign|Blocked|Non-RAID|Rebuilding|Removed","online|ready|failed|foreign|offline|jbod|rebuilding|missing"},
        {"omreport/cache_battery","Ready|Degraded|Failed|Charging|Learning|Missing","ok|degraded|failed|charging|learning|missing"},
        {"zfs/virtual_disk","ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED|scrub|resilver","optimal|degraded|failed|offline|failed|failed|checking|rebuilding"},
        {"zfs/physical_disk","ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED","online|degraded|failed|offline|missing|missing"},
    }
    out := make(map[string]map[string]string)
    for _, row := range rows {
        out[row.key] = make(map[string]string)
        values := strings.Split(row.normalized,"|")
        for i, raw := range strings.Split(row.raw,"|") { out[row.key][strings.ToLower(raw)] = values[i] }
    }
    return out
}()

func remainingVendorState(source Kind, typ ComponentType, raw string) string {
    if s := remainingVendorStates[string(source)+"/"+string(typ)][strings.ToLower(strings.TrimSpace(raw))]; s != "" { return s }
    return "unknown"
}
```

- [ ] **Step 4: Run green (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect PASS, including every §5.2 W02b state spelling. Flag tests belong to the source tasks.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/vendor_states.go agent/internal/collectors/hwhealth/vendor_states_test.go
git commit -m $'feat(agent): define remaining hardware source states\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 2: Preserve observations across command failures

**Files:** Create `agent/internal/collectors/hwhealth/vendor_text.go`; Test: `agent/internal/collectors/hwhealth/vendor_text_test.go`.
**Interfaces:** Consumes `runTool(ctx context.Context, timeout time.Duration, path string, args ...string) (execResult, error)`, `lookupTool(names []string, extraDirs []string) (path string, ok bool)`, `Source`, `Availability`, `Result`, W02a `toolRunner func(context.Context,time.Duration,string,...string)(execResult,error)` (W02a plan:293). Produces `cliSource`, `commandOutput`, `collectCLI`, `textComponent`, `textFields`, `firstText`, `textInt`, `textSize`, `textProgress`, `cliResult` and test helpers `w02bFixture`, `w02bComponent`.

- [ ] **Step 1: Write the failing test (3 minutes).** Create `vendor_text_test.go`:

```go
package hwhealth

import (
    "context"
    "errors"
    "os"
    "testing"
    "time"
)

func w02bFixture(t *testing.T, name string) []byte {
    t.Helper(); b, err := os.ReadFile("testdata/"+name)
    if err != nil { t.Fatal(err) }; return b
}
func w02bComponent(t *testing.T, r Result, key string) Component {
    t.Helper(); for _, c := range r.Components { if c.ComponentKey == key { return c } }
    t.Fatalf("missing %s in %+v",key,r); return Component{}
}
func TestCollectCLIPartial(t *testing.T) {
    s := &cliSource{kind:"megacli", timeout:30*time.Second, commands:[][]string{{"good"},{"bad"}}}
    s.run = func(ctx context.Context, d time.Duration, path string, args ...string)(execResult,error) {
        if args[0] == "bad" { return execResult{},errors.New("controller timeout") }
        return execResult{Stdout:[]byte("observed"),ExitCode:2},nil
    }
    s.parse = func(outputs []commandOutput) Result {
        if len(outputs)!=1 { t.Fatalf("outputs=%d",len(outputs)) }
        return Result{Complete:true,Components:[]Component{textComponent("megacli","controller","megacli:c0","","adapter","Optimal")}}
    }
    r, err := s.Collect(context.Background(),Availability{Available:true,Path:"fake"})
    if err!=nil || r.Complete || len(r.Components)!=1 || len(r.Warnings)==0 { t.Fatalf("lost partial observation: %+v %v",r,err) }
    s.kind="ssacli"
    if _,err=s.Collect(context.Background(),Availability{Available:true,Path:"fake"});err==nil { t.Fatal("non-MegaCli nonzero exit must fail") }
}
func TestOptionalNumericFields(t *testing.T) { for _,raw:=range []string{""," ","unknown"} { if textInt(raw)!=0 { t.Fatalf("%q",raw) } } }
func TestTextSizes(t *testing.T) {
    for _,tc:=range []struct{raw string;want int64}{{"100 GB",100000000000},{"1 GiB",1073741824},{"100G",107374182400}} {
        got:=textSize(tc.raw); if got==nil || *got!=tc.want { t.Fatalf("size %q=%v",tc.raw,got) }
    }
    if textSize("N/A")!=nil { t.Fatal("unknown size fabricated") }
}
func TestTextFieldColonInKey(t *testing.T) {
    f:=textFields("Reported Channel,Device(T:L): 0,3(3:0)\n")
    if f["reported channel,device(t:l)"]!="0,3(3:0)" { t.Fatalf("%v",f) }
}
func TestTextComponentUnknown(t *testing.T) {
    c:=textComponent("ssacli","physical_disk","ssacli:c0:e1:s1","ssacli:c0","disk","New State")
    if c.State!="unknown" || c.StateDetail==nil || *c.StateDetail!="New State" { t.Fatalf("%+v",c) }
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: cliSource`.
- [ ] **Step 3: Implement execution and parsing helpers (5 minutes).** Decision: explicit vendor KB/MB/GB/TB use SI units; IEC units and ZFS compact K/M/G/T use powers of 1024. Create `vendor_text.go`:

```go
package hwhealth

import (
    "context"
    "fmt"
    "regexp"
    "strconv"
    "strings"
    "time"
)

type commandOutput struct { args []string; text string }
type cliSource struct {
    kind Kind
    names, dirs []string
    timeout time.Duration
    commands [][]string
    expand func([]commandOutput) [][]string
    parse func([]commandOutput) Result
    run toolRunner
}
func(s *cliSource) Name() Kind { return s.kind }
func(s *cliSource) Tier() Tier { return Tier("raid") }
func(s *cliSource) Detect(ctx context.Context) Availability {
    if ctx.Err()!=nil { return Availability{} }
    path,ok:=lookupTool(s.names,s.dirs); return Availability{Path:path,Available:ok}
}
func(s *cliSource) Collect(ctx context.Context,a Availability)(Result,error) { return collectCLI(ctx,s,a) }
func collectCLI(ctx context.Context,s *cliSource,a Availability)(Result,error) {
    run:=s.run; if run==nil { run=runTool }
    outputs:=[]commandOutput{}; warnings:=[]string{}; complete:=true
    execute:=func(commands [][]string) {
        for _,args:=range commands {
            if ctx.Err()!=nil { complete=false; warnings=append(warnings,"cycle cancelled"); break }
            out,err:=run(ctx,s.timeout,a.Path,args...)
            if err!=nil || out.Truncated || (out.ExitCode!=0 && s.kind!="megacli") {
                complete=false; warnings=append(warnings,fmt.Sprintf("%s: exit=%d truncated=%t error=%v",strings.Join(args," "),out.ExitCode,out.Truncated,err)); continue
            }
            if strings.TrimSpace(string(out.Stdout))=="" { complete=false; warnings=append(warnings,"empty output: "+strings.Join(args," ")); continue }
            outputs=append(outputs,commandOutput{args:args,text:string(out.Stdout)})
        }
    }
    execute(s.commands)
    if s.expand!=nil { execute(s.expand(outputs)) }
    if len(outputs)==0 { return Result{},fmt.Errorf("%s: no usable command output",s.kind) }
    result:=s.parse(outputs)
    result.Complete=result.Complete && complete
    result.Warnings=append(result.Warnings,warnings...)
    if result.ToolVersion=="" { result.ToolVersion=a.Version }
    if len(result.Components)==0 && !result.Complete { return result,fmt.Errorf("%s: no recognizable records",s.kind) }
    return result,nil
}
func textFields(text string) map[string]string {
    out:=map[string]string{}
    for _,line:=range strings.Split(text,"\n") {
        k,v,ok:=strings.Cut(strings.TrimSpace(line),": ")
        if !ok { k,v,ok=strings.Cut(strings.TrimSpace(line),":") }
        if ok { out[strings.ToLower(strings.TrimSpace(k))]=strings.TrimSpace(v) }
    }; return out
}
func firstText(m map[string]string,keys ...string) string {
    for _,k:=range keys { if v:=m[strings.ToLower(k)];v!="" { return v } }; return ""
}
func textInt(s string) int { fields:=strings.Fields(s); if len(fields)==0 { return 0 }; n,_:=strconv.Atoi(fields[0]); return n }
func textPtr(s string)*string { if s=="" { return nil }; return &s }
func textComponent(source Kind,typ ComponentType,key,parent,name,raw string) Component {
    return Component{ComponentKey:key,ComponentType:typ,ParentKey:textPtr(parent),Source:source,Name:name,
        State:remainingVendorState(source,typ,raw),StateDetail:textPtr(raw),Attributes:map[string]any{}}
}
var sizePattern=regexp.MustCompile(`(?i)([0-9]+(?:\.[0-9]+)?)\s*(bytes|[KMGT]i?B|[KMGT])?`)
func textSize(raw string)*int64 {
    m:=sizePattern.FindStringSubmatch(raw); if m==nil { return nil }
    n,err:=strconv.ParseFloat(m[1],64); if err!=nil { return nil }
    unit:=strings.ToUpper(m[2]); scale:=map[string]float64{"":1,"BYTES":1,"KB":1e3,"MB":1e6,"GB":1e9,"TB":1e12,"K":1024,"M":1048576,"G":1073741824,"T":1099511627776,"KIB":1024,"MIB":1048576,"GIB":1073741824,"TIB":1099511627776}[unit]
    if n<0 || n*scale>=float64(1<<63) { return nil }; v:=int64(n*scale); return &v
}
var percentPattern=regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)\s*%`)
func textProgress(raw string)*int {
    m:=percentPattern.FindStringSubmatch(raw); if m==nil { return nil }; n,_:=strconv.ParseFloat(m[1],64)
    if n<0 || n>100 { return nil }; p:=int(n); return &p
}
func cliResult(components []Component,recognized,expected int) Result {
    r:=Result{Components:components,Complete:recognized==expected && recognized>0}
    if !r.Complete { r.Warnings=[]string{"unrecognized or incomplete command output"} }; return r
}
```

- [ ] **Step 4: Run green (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect PASS. Discard only the truncated command, retain earlier successfully parsed commands. Task 11 adds source-level fault matrices.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/vendor_text.go agent/internal/collectors/hwhealth/vendor_text_test.go
git commit -m $'feat(agent): preserve partial vendor observations\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 3: Add MegaCli records, flags and membership

**Files:** Create `agent/internal/collectors/hwhealth/megacli.go`; Test: `agent/internal/collectors/hwhealth/megacli_test.go`; Create `agent/internal/collectors/hwhealth/testdata/megacli/optimal.txt`.
**Interfaces:** Consumes Task 2 `cliSource`, helpers and index `Component`; produces `newMegaCLI([]string) *cliSource`, `parseMegaCLI([]commandOutput) Result`, `sortedComponents(map[string]Component) []Component`, test helper `fixtureOutputs(*testing.T, string, [][]string) []commandOutput`.

- [ ] **Step 1: Write fixture and failing test (5 minutes).** Save this literal as `testdata/megacli/optimal.txt`; `===` separates the five independent command captures:

```text
Adapter #0
Product Name: MegaRAID fixture adapter
Serial No: CTRL-TEST
FW Package Build: 1.0
Controller Status: Optimal
===
Adapter 0 -- Virtual Drive Information:
Virtual Drive: 0 (Target Id: 0)
Name: mirror
RAID Level: Primary-1, Secondary-0, RAID Level Qualifier-0
Size: 100 GB
State: Optimal
===
Adapter #0
Enclosure Device ID: 252
Slot Number: 3
Firmware state: Online, Spun Up
Inquiry Data: Fixture disk
Serial Number: DISK-TEST
Raw Size: 100 GB
Drive Temperature: 35C
Predictive Failure Count: 0
Drive has flagged a S.M.A.R.T alert: No
===
BBU status for Adapter: 0
Battery State: Optimal
Learn Cycle Active: No
Battery Replacement required: No
===
Adapter #0
Virtual Drive: 0 (Target Id: 0)
Enclosure Device ID: 252
Slot Number: 3
```

Create `megacli_test.go`:

```go
package hwhealth

import (
    "strings"
    "testing"
)
func fixtureOutputs(t *testing.T,path string,commands [][]string) []commandOutput {
    t.Helper(); parts:=strings.Split(string(w02bFixture(t,path)),"\n===\n")
    if len(parts)!=len(commands) { t.Fatalf("%s: %d captures, want %d",path,len(parts),len(commands)) }
    out:=make([]commandOutput,len(parts)); for i,p:=range parts { out[i]=commandOutput{commands[i],p} }; return out
}
func TestMegaCLI(t *testing.T) {
    s:=newMegaCLI(nil); outputs:=fixtureOutputs(t,"megacli/optimal.txt",s.commands)
    r:=s.parse(outputs)
    if !r.Complete { t.Fatalf("%+v",r) }
    pd:=w02bComponent(t,r,"megacli:c0:e252:s3")
    if pd.State!="online" || pd.Serial==nil || *pd.Serial!="DISK-TEST" { t.Fatalf("%+v",pd) }
    vd:=w02bComponent(t,r,"megacli:c0:v0")
    if strings.Join(vd.Attributes["memberKeys"].([]string),",")!=pd.ComponentKey { t.Fatal("membership lost") }
    outputs[2].text=strings.ReplaceAll(outputs[2].text,"Predictive Failure Count: 0","Predictive Failure Count: 1")
    if !w02bComponent(t,s.parse(outputs),pd.ComponentKey).PredictiveFailure { t.Fatal("predictive flag lost") }
    outputs[1].text += "\nOngoing Progresses:\nRebuild: 42%"
    vd=w02bComponent(t,s.parse(outputs),vd.ComponentKey)
    if vd.State!="rebuilding" || vd.ProgressPercent==nil || *vd.ProgressPercent!=42 { t.Fatalf("%+v",vd) }
    outputs[2].text+="\nEnclosure Device ID: 252\nSlot Number: 4\n"
    if s.parse(outputs).Complete { t.Fatal("malformed second disk grants completeness") }
    outputs=fixtureOutputs(t,"megacli/optimal.txt",s.commands)
    outputs[3].text="BBU status for Adapter: 0\nBBU is not present\n"
    if w02bComponent(t,s.parse(outputs),"megacli:c0:bbu").State!="missing" { t.Fatal("explicitly absent battery lost") }
    for _,tc:=range []struct{line,state string}{{"Learn Cycle Active: Yes","learning"},{"Battery Replacement required: Yes","failed"},{"Pack is about to fail: Yes","failed"}} {
        outputs[3].text="BBU status for Adapter: 0\nBattery State: Optimal\n"+tc.line+"\n"
        if w02bComponent(t,s.parse(outputs),"megacli:c0:bbu").State!=tc.state { t.Fatal(tc) }
    }
    outputs[2].text=strings.ReplaceAll(outputs[2].text,"S.M.A.R.T alert: No","S.M.A.R.T alert: Yes")
    if !w02bComponent(t,s.parse(outputs),pd.ComponentKey).PredictiveFailure { t.Fatal("SMART alert flag lost") }
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: newMegaCLI`.
- [ ] **Step 3: Implement the five commands and text parser (5 minutes).** Create `megacli.go`:

```go
package hwhealth

import (
    "regexp"
    "sort"
    "strings"
    "time"
)
func newMegaCLI(dirs []string)*cliSource {
    return &cliSource{kind:"megacli",names:[]string{"MegaCli64","MegaCli","megacli"},dirs:dirs,timeout:30*time.Second,
        commands:[][]string{{"-AdpAllInfo","-aALL"},{"-LDInfo","-Lall","-aALL"},{"-PDList","-aALL"},{"-AdpBbuCmd","-GetBbuStatus","-aALL"},{"-LDPDInfo","-aALL"}},parse:parseMegaCLI}
}
var megaAdapter=regexp.MustCompile(`(?im)^(?:BBU status for )?Adapter\s*[:#]?\s*(\d+)[^\n]*`)
var megaVD=regexp.MustCompile(`(?im)^Virtual Drive:\s*(\d+)[^\n]*`)
var megaPD=regexp.MustCompile(`(?im)^Enclosure Device ID:\s*([^\r\n]+)`)
func sortedComponents(m map[string]Component) []Component {
    keys:=make([]string,0,len(m)); for k:=range m { keys=append(keys,k) }; sort.Strings(keys)
    out:=make([]Component,0,len(keys)); for _,k:=range keys { out=append(out,m[k]) }; return out
}
// textBlocks returns [matched header, body] without dropping the header's identifier.
func textBlocks(re *regexp.Regexp,s string) [][2]string {
    hits:=re.FindAllStringIndex(s,-1); out:=make([][2]string,0,len(hits))
    for i,h:=range hits { end:=len(s); if i+1<len(hits) { end=hits[i+1][0] }; out=append(out,[2]string{s[h[0]:h[1]],s[h[1]:end]}) }; return out
}
func parseMegaCLI(outputs []commandOutput) Result {
    rows:=map[string]Component{}; memberships:=map[string][]string{}; recognized:=0
    for _,out:=range outputs {
        valid:=false; invalid:=false
        for _,adapter:=range textBlocks(megaAdapter,out.text) {
            id:=megaAdapter.FindStringSubmatch(adapter[0])[1]; ck:=controllerKey("megacli",id); f:=textFields(adapter[1])
            switch out.args[0] {
            case "-AdpAllInfo":
                if f["product name"]=="" { invalid=true; continue }; valid=true
                c:=textComponent("megacli","controller",ck,"",f["product name"],f["controller status"])
                c.Model=textPtr(f["product name"]); c.Serial=textPtr(f["serial no"]); c.Firmware=textPtr(f["fw package build"]); rows[ck]=c
            case "-LDInfo":
                for _,block:=range textBlocks(megaVD,adapter[1]) {
                    v:=textFields(block[1]); raw:=v["state"]; if raw=="" { invalid=true; continue }; valid=true
                    key:=ck+":v"+megaVD.FindStringSubmatch(block[0])[1]
                    c:=textComponent("megacli","virtual_disk",key,ck,firstText(v,"name","state"),raw)
                    c.SizeBytes=textSize(v["size"]); c.Attributes["raidLevel"]=v["raid level"]
                    for _,operation:=range []string{"Rebuild","Consistency Check","Initialization"} {
                        if progress:=textProgress(v[strings.ToLower(operation)]);progress!=nil && c.State!="offline" && c.State!="failed" {
                            c.State=remainingVendorState("megacli","virtual_disk",operation); c.ProgressPercent=progress
                        }
                    }; rows[key]=c
                }
                valid=valid || strings.Contains(out.text,"No Virtual Drive")
            case "-PDList":
                for _,block:=range textBlocks(megaPD,adapter[1]) {
                    p:=textFields(block[0]+"\n"+block[1]); if p["slot number"]=="" || p["firmware state"]=="" { invalid=true; continue }; valid=true
                    e:=p["enclosure device id"]; if e=="N/A" { e="-" }; key:=slotKey(ck,e,p["slot number"])
                    c:=textComponent("megacli","physical_disk",key,ck,"Slot "+p["slot number"],p["firmware state"])
                    c.Serial=textPtr(p["serial number"]); c.Model=textPtr(p["inquiry data"]); c.SizeBytes=textSize(p["raw size"])
                    c.PredictiveFailure=textInt(p["predictive failure count"])>0 || strings.EqualFold(p["drive has flagged a s.m.a.r.t alert"],"yes")
                    c.Attributes["enclosure"]=e; c.Attributes["slot"]=p["slot number"]; c.Attributes["mediaErrors"]=textInt(p["media error count"])
                    if v:=p["drive temperature"];v!="" { n:=textInt(strings.TrimSuffix(v,"C")); if n>=-50 && n<=200 { c.TemperatureC=&n } }
                    rows[key]=c
                }
                valid=valid || strings.Contains(out.text,"No Physical Drive")
            case "-AdpBbuCmd":
                raw:=f["battery state"]
                if strings.EqualFold(f["learn cycle active"],"yes") { raw="Learn Cycle Active" }
                if strings.EqualFold(f["battery replacement required"],"yes") { raw="Battery Replacement required" }
                if strings.EqualFold(f["pack is about to fail"],"yes") { raw="Pack is about to fail" }
                if raw!="" { valid=true; rows[ck+":bbu"]=textComponent("megacli","cache_battery",ck+":bbu",ck,"BBU",raw) }
                if strings.Contains(adapter[1],"BBU is not present") { valid=true; c:=textComponent("megacli","cache_battery",ck+":bbu",ck,"BBU","BBU is not present"); c.State="missing"; rows[c.ComponentKey]=c }
            case "-LDPDInfo":
                for _,vd:=range textBlocks(megaVD,adapter[1]) {
                    key:=ck+":v"+megaVD.FindStringSubmatch(vd[0])[1]; valid=true
                    for _,pd:=range textBlocks(megaPD,vd[1]) {
                        p:=textFields(pd[0]+"\n"+pd[1]); e:=p["enclosure device id"]; if e=="N/A" { e="-" }
                        if p["slot number"]!="" { memberships[key]=append(memberships[key],slotKey(ck,e,p["slot number"])) } else { invalid=true }
                    }
                }; valid=valid || strings.Contains(out.text,"No Virtual Drive")
            }
        }; if valid && !invalid { recognized++ }
    }
    for key,members:=range memberships { if c,ok:=rows[key];ok { sort.Strings(members); c.Attributes["memberKeys"]=members; rows[key]=c } }
    return cliResult(sortedComponents(rows),recognized,5)
}
```

- [ ] **Step 4: Run green (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect PASS; Task 2 already proves MegaCli exit 2 retains stdout.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/megacli.go agent/internal/collectors/hwhealth/megacli_test.go agent/internal/collectors/hwhealth/testdata/megacli
git commit -m $'feat(agent): collect MegaCli storage health\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 4: Add HPE Smart Array aliases and cache health

**Files:** Create `agent/internal/collectors/hwhealth/ssacli.go`, `agent/internal/collectors/hwhealth/ssacli_test.go`, `agent/internal/collectors/hwhealth/testdata/ssacli/optimal.txt`.
**Interfaces:** Consumes Tasks 1–3 helpers. Produces `newSSACLI([]string) *cliSource`, `parseSSACLI([]commandOutput) Result`. Arrays provide membership; they do not create an unsupported `array` component type.

- [ ] **Step 1: Write fixture and failing test (5 minutes).** Save `testdata/ssacli/optimal.txt`:

```text
Smart Array P440 in Slot 0
   Controller Status: OK
   Cache Status: OK
   Battery/Capacitor Status: OK
===
Smart Array P440 in Slot 0
   Serial Number: CTRL-TEST
   Firmware Version: 7.00
   Controller Status: OK
   Cache Status: OK
   Battery/Capacitor Status: OK
   array A
      logicaldrive 1 (100 GB, RAID 1, OK)
         Status: OK
         Size: 100 GB
         Fault Tolerance: 1
      physicaldrive 1I:1:3
         Status: OK
         Drive Type: Data Drive
         Serial Number: DISK-TEST
         Model: Fixture disk
         Size: 100 GB
         Current Temperature (C): 31
```

Create `ssacli_test.go`:

```go
package hwhealth

import (
    "reflect"
    "strings"
    "testing"
    "time"
)
func TestSSACLI(t *testing.T) {
    s:=newSSACLI(nil)
    if s.timeout!=60*time.Second || !reflect.DeepEqual(s.names,[]string{"ssacli","hpssacli","hpacucli"}) { t.Fatal("aliases or timeout") }
    outputs:=fixtureOutputs(t,"ssacli/optimal.txt",s.commands); r:=s.parse(outputs)
    if !r.Complete || len(r.Components)!=4 { t.Fatalf("%+v",r) }
    pd:=w02bComponent(t,r,"ssacli:c0:e1I-1:s3")
    vd:=w02bComponent(t,r,"ssacli:c0:v1")
    if vd.Attributes["memberKeys"].([]string)[0]!=pd.ComponentKey { t.Fatal("array membership") }
    outputs[0].text=strings.ReplaceAll(outputs[0].text,"Cache Status: OK","Cache Status: Temporarily Disabled")
    outputs[1].text=strings.ReplaceAll(outputs[1].text,"   Cache Status: OK\n","")
    r=s.parse(outputs)
    if w02bComponent(t,r,"ssacli:c0").State!="degraded" { t.Fatal("cache does not degrade controller") }
    for i:=range outputs { outputs[i].text=strings.ReplaceAll(outputs[i].text,"Battery/Capacitor Status: OK","Battery/Capacitor Status: Failed") }
    if w02bComponent(t,s.parse(outputs),"ssacli:c0:bbu").State!="failed" { t.Fatal("battery lost") }
    outputs[1].text+="\nSmart Array fixture in Slot 1\nController Status: OK\nphysicaldrive 1I:1:4\nModel: broken record\n"
    outputs[1].text+="\nSmart Array fixture in Slot 2\nController Status: OK\n"
    if s.parse(outputs).Complete { t.Fatal("later valid controller concealed malformed disk") }
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: newSSACLI`.
- [ ] **Step 3: Implement controller/array scoped parsing (5 minutes).** Decision: encode HPE port+box as enclosure `1I-1`, slot as bay `3`; unlike box alone this prevents collisions between ports. The key still has exactly the §4.2 `<controllerKey>:e<enclosure>:s<slot>` shape.

```go
package hwhealth

import (
    "regexp"
    "strings"
    "time"
)
var hpeController=regexp.MustCompile(`(?im)^([^\n]+?) in Slot\s+(\d+)[^\n]*`)
var hpeRecord=regexp.MustCompile(`(?im)^\s*(array\s+\S+|logicaldrive\s+\d+[^\n]*|physicaldrive\s+\S+[^\n]*)`)
func newSSACLI(dirs []string)*cliSource {
    return &cliSource{kind:"ssacli",names:[]string{"ssacli","hpssacli","hpacucli"},dirs:dirs,timeout:60*time.Second,
        commands:[][]string{{"ctrl","all","show","status"},{"ctrl","all","show","config","detail"}},parse:parseSSACLI}
}
func parseSSACLI(outputs []commandOutput) Result {
    rows:=map[string]Component{}; recognized:=0
    for _,out:=range outputs {
        valid:=false; invalid:=false
        for _,block:=range textBlocks(hpeController,out.text) {
            h:=hpeController.FindStringSubmatch(block[0]); ck:=controllerKey("ssacli",h[2])
            head:=block[1]; if loc:=hpeRecord.FindStringIndex(head);loc!=nil { head=head[:loc[0]] }
            f:=textFields(head); if f["controller status"]=="" { invalid=true; continue }; valid=true
            c:=textComponent("ssacli","controller",ck,"",h[1],f["controller status"])
            c.Model=textPtr(h[1]); c.Serial=textPtr(f["serial number"]); c.Firmware=textPtr(f["firmware version"])
            cache:=f["cache status"]; battery:=f["battery/capacitor status"]
            if c.State!="failed" && (strings.Contains(strings.ToLower(cache),"disabled") || battery=="Failed" || battery=="Not Present") {
                c.State="degraded"; c.StateDetail=textPtr("Cache: "+cache+"; Battery/Capacitor: "+battery)
            }
            if old,ok:=rows[ck];ok { if c.Serial==nil { c.Serial=old.Serial }; if c.Firmware==nil { c.Firmware=old.Firmware }; if old.State=="failed" || old.State=="degraded" && c.State!="failed" { c.State=old.State; c.StateDetail=old.StateDetail } }; rows[ck]=c
            if battery!="" { rows[ck+":bbu"]=textComponent("ssacli","cache_battery",ck+":bbu",ck,"Battery/Capacitor",battery) }
            array:=""; members:=map[string][]string{}; volumes:=map[string][]string{}
            for _,record:=range textBlocks(hpeRecord,block[1]) {
                header:=strings.Fields(record[0]); if len(header)<2 { continue }; f:=textFields(record[1])
                switch strings.ToLower(header[0]) {
                case "array": array=header[1]
                case "logicaldrive":
                    key:=ck+":v"+header[1]; raw:=f["status"]
                    if raw=="" { invalid=true; continue }
                    c:=textComponent("ssacli","virtual_disk",key,ck,"Logical Drive "+header[1],raw)
                    if f["parity initialization status"]=="In Progress" && c.State!="failed" { c.State="initializing" }
                    c.ProgressPercent=textProgress(firstText(f,"rebuild status","parity initialization status","transformation status"))
                    c.SizeBytes=textSize(f["size"]); c.Attributes["raidLevel"]=f["fault tolerance"]; rows[key]=c; volumes[array]=append(volumes[array],key)
                case "physicaldrive":
                    address:=strings.Split(header[1],":"); if len(address)!=3 || f["status"]=="" { invalid=true; continue }
                    enclosure:=address[0]+"-"+address[1]; key:=slotKey(ck,enclosure,address[2])
                    c:=textComponent("ssacli","physical_disk",key,ck,"Physical Drive "+header[1],f["status"])
                    if f["drive type"]=="Spare Drive" && c.State=="online" { c.State="hotspare" }
                    c.PredictiveFailure=c.State=="predictive_failure"; c.Serial=textPtr(f["serial number"]); c.Model=textPtr(f["model"]); c.SizeBytes=textSize(f["size"])
                    c.Attributes["enclosure"]=enclosure; c.Attributes["slot"]=address[2]
                    if raw:=f["current temperature (c)"];raw!="" { n:=textInt(raw); if n>=-50 && n<=200 { c.TemperatureC=&n } }
                    rows[key]=c; members[array]=append(members[array],key)
                }
            }
            for a,keys:=range volumes { for _,key:=range keys { c:=rows[key]; c.Attributes["memberKeys"]=members[a]; rows[key]=c } }
        }; if valid && !invalid { recognized++ }
    }; return cliResult(sortedComponents(rows),recognized,2)
}
```

- [ ] **Step 4: Run green (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect PASS.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/ssacli.go agent/internal/collectors/hwhealth/ssacli_test.go agent/internal/collectors/hwhealth/testdata/ssacli
git commit -m $'feat(agent): collect Smart Array health and cache status\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 5: Enumerate arcconf controllers and battery/ZMM

**Files:** Create `agent/internal/collectors/hwhealth/arcconf.go`, `agent/internal/collectors/hwhealth/arcconf_test.go`, `agent/internal/collectors/hwhealth/testdata/arcconf/optimal.txt`.
**Interfaces:** Consumes Task 2 command expansion and Task 3 `textBlocks`; produces `newARCCONF([]string) *cliSource`, `arcControllers(string) []string`, `parseARCCONF([]commandOutput) Result`.

- [ ] **Step 1: Write fixture and failing test (4 minutes).** Save `testdata/arcconf/optimal.txt`:

```text
Controllers found: 1
Controller #1
Firmware: 1.0
===
Controller information
Controller Status: Optimal
Controller Model: SmartRAID fixture
Controller Serial Number: CTRL-TEST
Firmware: 1.0
Logical device number 0
   Logical device name: mirror
   Status of logical device: Optimal
   RAID level: 1
   Size: 102400 MB
   Segment 0: Present (Controller:1,Channel:0,Device:3)
Device #0
   Device is a Hard drive
   State: Online
   Reported Channel,Device(T:L): 0,3(3:0)
   Serial number: DISK-TEST
   Model: Fixture disk
   Total Size: 102400 MB
   S.M.A.R.T. warnings: 0
Battery Information
   Status: Optimal
Command completed successfully.
```

Create `arcconf_test.go`:

```go
package hwhealth

import (
    "reflect"
    "strings"
    "testing"
)
func TestARCCONF(t *testing.T) {
    s:=newARCCONF(nil)
    outputs:=fixtureOutputs(t,"arcconf/optimal.txt",[][]string{{"GETVERSION"},{"GETCONFIG","1","AL"}})
    if got:=s.expand(outputs[:1]);!reflect.DeepEqual(got,[][]string{{"GETCONFIG","1","AL"}}) { t.Fatalf("%v",got) }
    r:=s.parse(outputs); if !r.Complete { t.Fatalf("%+v",r) }
    pd:=w02bComponent(t,r,"arcconf:c1:e-:s0-3"); if pd.State!="online" { t.Fatalf("%+v",pd) }
    vd:=w02bComponent(t,r,"arcconf:c1:v0")
    if vd.Attributes["memberKeys"].([]string)[0]!=pd.ComponentKey { t.Fatal("segment membership") }
    if w02bComponent(t,r,"arcconf:c1:bbu").State!="ok" { t.Fatal("battery") }
    outputs[1].text=strings.ReplaceAll(outputs[1].text,"Battery Information","Controller ZMM Information")
    if w02bComponent(t,s.parse(outputs),"arcconf:c1:cv").State!="ok" { t.Fatal("ZMM") }
    if !reflect.DeepEqual(arcControllers("Controllers found: 2\nController #1\nController #3\n"),[]string{"1","3"}) { t.Fatal("controller IDs must not be assumed contiguous") }
    outputs[1].text=strings.ReplaceAll(outputs[1].text,"   State: Online\n","")
    if s.parse(outputs).Complete { t.Fatal("missing disk state is malformed, not unknown") }
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: newARCCONF`.
- [ ] **Step 3: Implement enumeration and sections (5 minutes).** Decision: arcconf channel/device addresses with no reported enclosure use `e-` and the composite slot `channel-device`, preserving the index §4.2 missing-enclosure rule without channel collisions. Create `arcconf.go`:

```go
package hwhealth

import (
    "regexp"
    "strings"
    "time"
)
var arcID=regexp.MustCompile(`(?im)^\s*Controller\s+#(\d+)`)
var arcRecord=regexp.MustCompile(`(?im)^\s*(Logical device number\s+(\d+)|Device\s+#(\d+)|(?:Controller )?Battery Information|(?:Controller )?ZMM Information)[^\n]*`)
var arcAddress=regexp.MustCompile(`(\d+)\s*,\s*(\d+)`)
var arcSegment=regexp.MustCompile(`(?i)Channel:\s*(\d+)\s*,\s*Device:\s*(\d+)`)
func arcControllers(s string) []string {
    ids:=[]string{}; seen:=map[string]bool{}
    for _,m:=range arcID.FindAllStringSubmatch(s,-1) { if !seen[m[1]] { ids=append(ids,m[1]); seen[m[1]]=true } }; return ids
}
func newARCCONF(dirs []string)*cliSource {
    return &cliSource{kind:"arcconf",names:[]string{"arcconf"},dirs:dirs,timeout:30*time.Second,commands:[][]string{{"GETVERSION"}},
        expand:func(outputs []commandOutput)[][]string {
            commands:=[][]string{}; for _,out:=range outputs { if out.args[0]=="GETVERSION" { for _,id:=range arcControllers(out.text) { commands=append(commands,[]string{"GETCONFIG",id,"AL"}) } } }; return commands
        },parse:parseARCCONF}
}
func parseARCCONF(outputs []commandOutput) Result {
    rows:=map[string]Component{}; expected:=1; recognized:=0
    for _,out:=range outputs {
        if out.args[0]=="GETVERSION" {
            ids:=arcControllers(out.text); expected+=len(ids)
            if len(ids)>0 || strings.Contains(out.text,"Controllers found: 0") { recognized++ }; continue
        }
        if len(out.args)!=3 || !strings.Contains(out.text,"Command completed successfully.") { continue }
        head:=out.text; if loc:=arcRecord.FindStringIndex(head);loc!=nil { head=head[:loc[0]] }
        f:=textFields(head); if f["controller model"]=="" { continue }; recognized++
        ck:=controllerKey("arcconf",out.args[1]); c:=textComponent("arcconf","controller",ck,"",f["controller model"],f["controller status"])
        c.Model=textPtr(f["controller model"]); c.Serial=textPtr(f["controller serial number"]); c.Firmware=textPtr(f["firmware"]); rows[ck]=c
        for _,block:=range textBlocks(arcRecord,out.text) {
            h:=arcRecord.FindStringSubmatch(block[0]); f:=textFields(block[1]); var c Component
            switch {
            case h[2]!="":
                if f["status of logical device"]=="" { recognized--; continue }
                c=textComponent("arcconf","virtual_disk",ck+":v"+h[2],ck,firstText(f,"logical device name","status of logical device"),f["status of logical device"])
                c.Attributes["raidLevel"]=f["raid level"]; c.SizeBytes=textSize(f["size"]); members:=[]string{}
                for _,m:=range arcSegment.FindAllStringSubmatch(block[1],-1) { members=append(members,slotKey(ck,"-",m[1]+"-"+m[2])) }; c.Attributes["memberKeys"]=members
                c.ProgressPercent=textProgress(firstText(f,"rebuild progress","progress"))
            case h[3]!="":
                if !strings.Contains(strings.ToLower(block[1]),"hard drive") { continue }; if f["state"]=="" { recognized--; continue }
                a:=arcAddress.FindStringSubmatch(f["reported channel,device(t:l)"]); if a==nil { recognized--; continue }
                c=textComponent("arcconf","physical_disk",slotKey(ck,"-",a[1]+"-"+a[2]),ck,"Device "+a[1]+":"+a[2],f["state"])
                c.Serial=textPtr(f["serial number"]); c.Model=textPtr(f["model"]); c.SizeBytes=textSize(f["total size"])
                c.PredictiveFailure=textInt(f["s.m.a.r.t. warnings"])>0; c.Attributes["enclosure"]="-"; c.Attributes["slot"]=a[1]+"-"+a[2]
            default:
                if firstText(f,"status","state")=="" { recognized--; continue }
                suffix:=":bbu"; if strings.Contains(strings.ToUpper(block[0]),"ZMM") { suffix=":cv" }
                c=textComponent("arcconf","cache_battery",ck+suffix,ck,strings.TrimSpace(block[0]),firstText(f,"status","state"))
            }; rows[c.ComponentKey]=c
        }
    }; return cliResult(sortedComponents(rows),recognized,expected)
}
```

- [ ] **Step 4: Run green (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect PASS.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/arcconf.go agent/internal/collectors/hwhealth/arcconf_test.go agent/internal/collectors/hwhealth/testdata/arcconf
git commit -m $'feat(agent): collect arcconf controllers and cache modules\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 6: Add OMSA SSV tables with controller-scoped identities

**Files:** Create `agent/internal/collectors/hwhealth/omreport.go`, `agent/internal/collectors/hwhealth/omreport_test.go`, `agent/internal/collectors/hwhealth/testdata/omreport/optimal.txt`.
**Interfaces:** Consumes `cliSource`, `Component`. Produces `newOMReport([]string) *cliSource`, `ssvRows(string) ([]map[string]string, bool)`, `parseOMReport([]commandOutput) Result`. Task 9 prevents these commands from running whenever a Broadcom CLI is available.

- [ ] **Step 1: Write fixture and failing test (4 minutes).** Save `testdata/omreport/optimal.txt`:

```text
List of Controllers in the system
ID;Status;Name;State;Firmware Version
0;Ok;PERC fixture;Ready;1.0
===
Controller PERC fixture (Slot 0)
ID;Status;Name;State;Layout;Size
0;Ok;mirror;Ready;RAID-1;100 GB
===
Controller PERC fixture (Slot 0)
ID;Status;Name;State
0;Ok;Battery;Ready
===
ID;Status;Name;State;Failure Predicted;Serial No.;Capacity;Product ID
0:1:3;Ok;Disk 3;Online;No;DISK-TEST;100 GB;Fixture disk
```

Create `omreport_test.go`:

```go
package hwhealth

import (
    "reflect"
    "testing"
    "time"
)
func TestOMReport(t *testing.T) {
    s:=newOMReport(nil); if s.timeout!=60*time.Second { t.Fatal("timeout") }
    commands:=append(append([][]string{},s.commands...),[]string{"storage","pdisk","controller=0","-fmt","ssv"})
    out:=fixtureOutputs(t,"omreport/optimal.txt",commands)
    if !reflect.DeepEqual(s.expand(out[:3]),[][]string{{"storage","pdisk","controller=0","-fmt","ssv"}}) { t.Fatal("enumeration") }
    r:=s.parse(out); if !r.Complete { t.Fatalf("%+v",r) }
    if w02bComponent(t,r,"omreport:c0:e0-1:s3").State!="online" { t.Fatal("disk") }
    rows,ok:=ssvRows("ID;Name;State\n0;\"label;with separator\";Ready\n")
    if !ok || rows[0]["name"]!="label;with separator" { t.Fatal("SSV quoting") }
    if _,ok=ssvRows("ID;Name;State\n0;broken\n");ok { t.Fatal("ragged row accepted") }
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: newOMReport`.
- [ ] **Step 3: Implement SSV parsing (5 minutes).** Decision: controller sections, not global row IDs, scope VDs/batteries; an unscoped row with multiple controllers is rejected as partial, never assigned to controller zero.

```go
package hwhealth

import (
    "encoding/csv"
    "regexp"
    "strings"
    "time"
)
var omsaController=regexp.MustCompile(`(?im)^Controller[^\n]*\(Slot\s+(\d+)\)[^\n]*`)
func ssvRows(text string)([]map[string]string,bool) {
    var header []string; rows:=[]map[string]string{}; valid:=true
    for _,line:=range strings.Split(text,"\n") {
        if !strings.Contains(line,";") { continue }
        r:=csv.NewReader(strings.NewReader(line)); r.Comma=';'; r.FieldsPerRecord=-1
        values,err:=r.Read(); if err!=nil { valid=false; continue }
        if len(values)>0 && strings.EqualFold(strings.TrimSpace(values[0]),"ID") { header=values; continue }
        if header==nil { continue }; if len(values)!=len(header) { valid=false; continue }
        row:=map[string]string{}; for i,k:=range header { row[strings.ToLower(strings.TrimSpace(k))]=strings.TrimSpace(values[i]) }; rows=append(rows,row)
    }; return rows,valid && header!=nil
}
func newOMReport(dirs []string)*cliSource {
    return &cliSource{kind:"omreport",names:[]string{"omreport"},dirs:dirs,timeout:60*time.Second,
        commands:[][]string{{"storage","controller","-fmt","ssv"},{"storage","vdisk","-fmt","ssv"},{"storage","battery","-fmt","ssv"}},
        expand:func(outputs []commandOutput)[][]string {
            commands:=[][]string{}; for _,o:=range outputs { if o.args[1]=="controller" { rows,_:=ssvRows(o.text); for _,r:=range rows { if r["id"]!="" { commands=append(commands,[]string{"storage","pdisk","controller="+r["id"],"-fmt","ssv"}) } } } }; return commands
        },parse:parseOMReport}
}
func parseOMReport(outputs []commandOutput) Result {
    rows:=map[string]Component{}; ids:=[]string{}; recognized:=0; expected:=3
    for _,o:=range outputs { if o.args[1]=="controller" { table,_:=ssvRows(o.text); for _,r:=range table { ids=append(ids,r["id"]) } } }; expected+=len(ids)
    for _,o:=range outputs {
        typ:=ComponentType("controller"); switch o.args[1] { case "vdisk":typ="virtual_disk";case "pdisk":typ="physical_disk";case "battery":typ="cache_battery" }
        groups:=[][2]string{{"",o.text}}; if typ!="controller" && typ!="physical_disk" { if b:=textBlocks(omsaController,o.text);len(b)>0 { groups=b } }
        valid:=true
        for _,group:=range groups {
            table,ok:=ssvRows(group[1]); if !ok { valid=false }; controller:=""
            if h:=omsaController.FindStringSubmatch(group[0]);h!=nil { controller=h[1] }
            for _,arg:=range o.args { if strings.HasPrefix(arg,"controller=") { controller=strings.TrimPrefix(arg,"controller=") } }
            for _,r:=range table {
                id:=r["id"]; cid:=controller
                if typ=="controller" { cid=id } else if r["controller id"]!="" { cid=r["controller id"] }
                if cid=="" && len(ids)==1 { cid=ids[0] }; if cid=="" || id=="" { valid=false; continue }
                ck:=controllerKey("omreport",cid); key:=ck; parent:=ck; raw:=r["state"]
                switch typ {
                case "controller":parent=""; raw=r["status"]
                case "virtual_disk":key+=":v"+id
                case "cache_battery":key+=":bbu"
                case "physical_disk":
                    address:=strings.Split(id,":"); if len(address)<2 { valid=false; continue }
                    key=slotKey(ck,strings.Join(address[:len(address)-1],"-"),address[len(address)-1])
                }
                if raw=="" { valid=false; continue }; c:=textComponent("omreport",typ,key,parent,firstText(r,"name","id"),raw)
                c.Serial=textPtr(firstText(r,"serial no.","serial number")); c.Model=textPtr(firstText(r,"product id","name")); c.Firmware=textPtr(r["firmware version"])
                c.SizeBytes=textSize(firstText(r,"capacity","size")); c.ProgressPercent=textProgress(r["progress"]); c.PredictiveFailure=strings.EqualFold(r["failure predicted"],"yes")
                if typ=="virtual_disk" { c.Attributes["raidLevel"]=r["layout"] }; rows[key]=c
            }
        }; if valid { recognized++ }
    }; return cliResult(sortedComponents(rows),recognized,expected)
}
```

- [ ] **Step 4: Run green (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect PASS; malformed SSV cannot grant `complete:true`.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/omreport.go agent/internal/collectors/hwhealth/omreport_test.go agent/internal/collectors/hwhealth/testdata/omreport
git commit -m $'feat(agent): collect OMSA storage SSV output\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 7: Add Linux ZFS pools, stable leaves and text progress

**Files:** Create `agent/internal/collectors/hwhealth/zfs_linux.go`, `agent/internal/collectors/hwhealth/zfs_linux_test.go`, `agent/internal/collectors/hwhealth/testdata/zfs/optimal.txt`.
**Interfaces:** Consumes W02a `Source`, `runTool`, `lookupTool`; Task 2 text helpers. Produces `zfsSource`, `newZFSSource([]string) *zfsSource`, `parseZFSText(string,string,func(string) string) Result`, `stableZFSID(string) string`. Members' `ParentKey` is `zfs:ctrl`; membership lives on pool `attributes.memberKeys`.

- [ ] **Step 1: Write fixture and failing test (5 minutes).** Save `testdata/zfs/optimal.txt` (the first line uses literal tabs):

```text
tank	ONLINE	100G	20G	80G
===
  pool: tank
 state: ONLINE
  scan: none requested
config:
        NAME                         STATE     READ WRITE CKSUM
        tank                         ONLINE       0     0     0
          mirror-0                   ONLINE       0     0     0
            /dev/disk/by-id/ata-A     ONLINE       0     0     0
            /dev/disk/by-id/ata-B     ONLINE       0     0     0
errors: No known data errors
```

Create `zfs_linux_test.go`:

```go
//go:build linux

package hwhealth

import (
    "strings"
    "testing"
)
func TestZFSText(t *testing.T) {
    parts:=strings.Split(string(w02bFixture(t,"zfs/optimal.txt")),"\n===\n")
    r:=parseZFSText(parts[0],parts[1],func(s string)string { return strings.TrimPrefix(s,"/dev/disk/by-id/") })
    if !r.Complete || len(r.Components)!=4 { t.Fatalf("%+v",r) }
    vd:=w02bComponent(t,r,"zfs:pool:tank"); if len(vd.Attributes["memberKeys"].([]string))!=2 { t.Fatal("leaf membership") }
    status:=strings.ReplaceAll(parts[1],"scan: none requested","scan: resilver in progress\n        42.5% done")
    r=parseZFSText(parts[0],status,stableZFSID); vd=w02bComponent(t,r,"zfs:pool:tank")
    if vd.State!="rebuilding" || vd.ProgressPercent==nil || *vd.ProgressPercent!=42 { t.Fatalf("%+v",vd) }
    status=strings.ReplaceAll(status,"ata-A     ONLINE       0","ata-A     ONLINE       1")
    pd:=w02bComponent(t,parseZFSText(parts[0],status,stableZFSID),"zfs:pool:tank:m:ata-A")
    if pd.MemberErrors==nil || !*pd.MemberErrors || pd.PredictiveFailure { t.Fatal("member errors are their own flag") }
    r=parseZFSText(parts[0],strings.ReplaceAll(status,"/dev/disk/by-id/ata-A","/dev/sda"),func(s string)string {
        if s=="/dev/sda" { return "" }; return strings.TrimPrefix(s,"/dev/disk/by-id/")
    })
    if r.Complete { t.Fatal("unstable identity must not permit staling") }
}
```

- [ ] **Step 2: Run red on Linux (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: parseZFSText`. Linux-tagged tests must actually run; a macOS package pass is insufficient.
- [ ] **Step 3: Implement the text source (5 minutes).** Create `zfs_linux.go`:

```go
//go:build linux

package hwhealth

import (
    "context"
    "fmt"
    "os"
    "path/filepath"
    "regexp"
    "sort"
    "strconv"
    "strings"
    "time"
)

type zfsSource struct { dirs []string; run toolRunner; stable func(string) string }
func newZFSSource(dirs []string)*zfsSource { return &zfsSource{dirs:dirs,run:runTool,stable:stableZFSID} }
func(s *zfsSource) Name()Kind { return "zfs" }
func(s *zfsSource) Tier()Tier { return "raid" }
func(s *zfsSource) Detect(ctx context.Context)Availability {
    path,ok:=lookupTool([]string{"zpool"},s.dirs); if !ok { return Availability{} }
    out,err:=s.run(ctx,30*time.Second,path,"list","-H","-o","name,health,size,alloc,free")
    // A discovered binary whose pool probe fails must surface as failed during Collect.
    text:=strings.TrimSpace(string(out.Stdout))
    return Availability{Path:path,Available:err!=nil || out.ExitCode!=0 || out.Truncated || text!="" && text!="no pools available"}
}
func(s *zfsSource) Collect(ctx context.Context,a Availability)(Result,error) {
    list,err:=s.run(ctx,30*time.Second,a.Path,"list","-H","-o","name,health,size,alloc,free")
    if err!=nil || list.Truncated || list.ExitCode!=0 { return Result{},fmt.Errorf("zpool list failed: exit=%d: %v",list.ExitCode,err) }
    if text:=strings.TrimSpace(string(list.Stdout));text=="" || text=="no pools available" { return Result{Complete:true,Components:[]Component{}},nil }
    if rows,_:=zfsBase(string(list.Stdout));len(rows)==0 { return Result{},fmt.Errorf("unrecognized zpool list output") }
    status,err:=s.run(ctx,30*time.Second,a.Path,"status","-pP")
    r:=parseZFSText(string(list.Stdout),string(status.Stdout),s.stable)
    if err!=nil || status.Truncated || status.ExitCode!=0 { r=parseZFSText(string(list.Stdout),"",s.stable); r.Complete=false; r.Warnings=append(r.Warnings,"zpool status failed") }
    return r,nil
}
func stableZFSID(path string) string {
    if strings.HasPrefix(path,"/dev/disk/by-id/") { return filepath.Base(path) }
    if _,err:=strconv.ParseUint(path,10,64);err==nil { return path }
    if !strings.HasPrefix(path,"/dev/") { return "" }
    target,err:=filepath.EvalSymlinks(path); if err!=nil { return "" }
    entries,err:=os.ReadDir("/dev/disk/by-id"); if err!=nil { return "" }
    ids:=[]string{}
    for _,entry:=range entries { if p,err:=filepath.EvalSymlinks(filepath.Join("/dev/disk/by-id",entry.Name()));err==nil && p==target { ids=append(ids,entry.Name()) } }
    sort.Strings(ids); if len(ids)>0 { return ids[0] }; return ""
}
var zfsPoolBlock=regexp.MustCompile(`(?m)^\s*pool:\s*(\S+)\s*$`)
func zfsBase(list string)(map[string]Component,bool) {
    rows:=map[string]Component{}; complete:=true
    for _,line:=range strings.Split(strings.TrimSpace(list),"\n") {
        f:=strings.Fields(line); if len(f)!=5 { complete=false; continue }
        key:="zfs:pool:"+f[0]; c:=textComponent("zfs","virtual_disk",key,"zfs:ctrl",f[0],f[1]); c.SizeBytes=textSize(f[2]); c.Attributes["memberKeys"]=[]string{}; rows[key]=c
    }; if len(rows)>0 { ctrl:=textComponent("zfs","controller","zfs:ctrl","","ZFS","ok"); ctrl.State="ok"; rows[ctrl.ComponentKey]=ctrl }; return rows,complete
}
func zfsProgress(c *Component,operation string,progress *int) {
    if c.State=="failed" || c.State=="offline" || c.State=="unknown" { return }
    c.State=remainingVendorState("zfs","virtual_disk",operation); c.ProgressPercent=progress
}
func zfsMember(rows map[string]Component,pool,identity,path,raw string,read,write,checksum uint64) {
    key:=memberKey(pool,identity); c:=textComponent("zfs","physical_disk",key,"zfs:ctrl",identity,raw)
    errors:=read>0 || write>0 || checksum>0; c.MemberErrors=&errors
    c.Attributes["osDevice"]=path; c.Attributes["readErrors"]=read; c.Attributes["writeErrors"]=write; c.Attributes["checksumErrors"]=checksum; rows[key]=c
    vd:=rows[pool]; vd.Attributes["memberKeys"]=append(vd.Attributes["memberKeys"].([]string),key); rows[pool]=vd
}
func parseZFSText(list,status string,stable func(string)string) Result {
    rows,complete:=zfsBase(list); observed:=map[string]bool{}
    for _,block:=range textBlocks(zfsPoolBlock,status) {
        name:=zfsPoolBlock.FindStringSubmatch(block[0])[1]; key:="zfs:pool:"+name; vd,ok:=rows[key]; if !ok { complete=false; continue }
        f:=textFields(block[1]); if f["state"]=="" { complete=false; continue }
        vd.State=remainingVendorState("zfs","virtual_disk",f["state"]); vd.StateDetail=textPtr(f["state"])
        if strings.Contains(f["scan"],"in progress") {
            for _,operation:=range []string{"scrub","resilver"} { if strings.Contains(f["scan"],operation) { zfsProgress(&vd,operation,textProgress(block[1])) } }
        }; rows[key]=vd; observed[key]=true; table:=false; finished:=false
        for _,line:=range strings.Split(block[1],"\n") {
            f:=strings.Fields(line); if len(f)==0 { continue }
            if f[0]=="NAME" { table=true; continue }; if f[0]=="errors:" { finished=true; table=false }; if !table || len(f)<5 { continue }
            // Only leaf paths or unavailable numeric GUIDs are physical disks.
            if !strings.HasPrefix(f[0],"/dev/") { if _,err:=strconv.ParseUint(f[0],10,64);err!=nil { continue } }
            identity:=stable(f[0]); if identity=="" { complete=false; continue }
            counters:=[3]uint64{}; valid:=true
            for i:=0;i<3;i++ { n,err:=strconv.ParseUint(f[i+2],10,64); if err!=nil { valid=false }; counters[i]=n }
            if !valid { complete=false; continue }; zfsMember(rows,key,identity,f[0],f[1],counters[0],counters[1],counters[2])
        }; if !finished { complete=false }
    }
    for key,c:=range rows { if c.ComponentType=="virtual_disk" && !observed[key] { complete=false } }
    r:=Result{Components:sortedComponents(rows),Complete:complete}; if !complete { r.Warnings=[]string{"incomplete ZFS status or member without stable identity"} }; return r
}
```

- [ ] **Step 4: Run green on Linux (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `TestZFSText` PASS, including no synthetic mirror-0 disk.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/zfs_linux.go agent/internal/collectors/hwhealth/zfs_linux_test.go agent/internal/collectors/hwhealth/testdata/zfs/optimal.txt
git commit -m $'feat(agent): collect ZFS pools and stable member health\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 8: Prefer OpenZFS 2.3 JSON with text fallback

**Files:** Create `agent/internal/collectors/hwhealth/zfs_json_linux.go`, `agent/internal/collectors/hwhealth/zfs_json_linux_test.go`, `agent/internal/collectors/hwhealth/testdata/zfs/optimal.json`; Modify Task 7 `zfs_linux.go`, `(*zfsSource).Collect` declaration.
**Interfaces:** Consumes Task 7 `zfsBase`, `zfsMember`, `zfsProgress`. Produces `zfsJSONCapable(string) bool`, `parseZFSJSON(string,[]byte,func(string) string) (Result,error)`.

Decision: use `status -pP -j --json-int` only after numeric userland `zfs-<major>.<minor>` version detection; failed/invalid JSON falls back once to text within the same cycle context. JSON counters stay integers. The nested `pools`/`vdevs` format and `--json-int` are documented by [OpenZFS 2.3 zpool-status](https://openzfs.github.io/openzfs-docs/man/v2.3/8/zpool-status.8.html); the fixture below is independently authored.

- [ ] **Step 1: Write JSON fixture and failing tests (4 minutes).** Save `testdata/zfs/optimal.json`:

```json
{"pools":{"tank":{"name":"tank","state":"ONLINE","scan_stats":{"function":"SCRUB","state":"SCANNING","examined":42,"to_examine":100},"vdevs":{"tank":{"vdev_type":"root","vdevs":{"mirror-0":{"vdev_type":"mirror","vdevs":{"disk":{"vdev_type":"disk","guid":12345,"path":"/dev/disk/by-id/ata-A","state":"ONLINE","read_errors":1,"write_errors":0,"checksum_errors":0}}}}}}}}}
```

Create `zfs_json_linux_test.go`:

```go
//go:build linux

package hwhealth

import (
    "strings"
    "testing"
)
func TestZFSJSON(t *testing.T) {
    for _,tc:=range []struct{version string;want bool}{{"zfs-2.2.9",false},{"zfs-2.3.0-1",true},{"zfs-2.10.0",true},{"zfs-3.0.0",true},{"zfs-kmod-2.3.0",false},{"unknown",false}} {
        if zfsJSONCapable(tc.version)!=tc.want { t.Fatalf("version %q",tc.version) }
    }
    r,err:=parseZFSJSON("tank ONLINE 100G 20G 80G",w02bFixture(t,"zfs/optimal.json"),stableZFSID)
    if err!=nil || !r.Complete { t.Fatalf("%+v %v",r,err) }
    vd:=w02bComponent(t,r,"zfs:pool:tank"); if vd.State!="checking" || vd.ProgressPercent==nil || *vd.ProgressPercent!=42 { t.Fatalf("%+v",vd) }
    pd:=w02bComponent(t,r,"zfs:pool:tank:m:ata-A"); if pd.MemberErrors==nil || !*pd.MemberErrors { t.Fatal("counters") }
    if _,err=parseZFSJSON("tank ONLINE 100G 20G 80G",[]byte(`{"pools":`),stableZFSID);err==nil { t.Fatal("truncated JSON") }
    raw:=strings.ReplaceAll(string(w02bFixture(t,"zfs/optimal.json")),"/dev/disk/by-id/ata-A","/dev/sda")
    r,err=parseZFSJSON("tank ONLINE 100G 20G 80G",[]byte(raw),func(string)string{return ""})
    if err!=nil { t.Fatal(err) }; w02bComponent(t,r,"zfs:pool:tank:m:12345")
    raw=strings.ReplaceAll(raw,`"vdev_type":"disk"`,`"vdev_type":"future"`)
    r,err=parseZFSJSON("tank ONLINE 100G 20G 80G",[]byte(raw),stableZFSID)
    if err!=nil || r.Complete { t.Fatalf("unrecognized topology: %+v %v",r,err) }
}
```

- [ ] **Step 2: Run red on Linux (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: zfsJSONCapable`.
- [ ] **Step 3: Implement JSON parsing (5 minutes).** Create `zfs_json_linux.go`:

```go
//go:build linux

package hwhealth

import (
    "encoding/json"
    "fmt"
    "regexp"
    "sort"
    "strconv"
    "strings"
)
var zfsVersion=regexp.MustCompile(`(?m)^zfs-(\d+)\.(\d+)\.`)
func zfsJSONCapable(raw string)bool {
    m:=zfsVersion.FindStringSubmatch(raw); if m==nil { return false }; major,_:=strconv.Atoi(m[1]); minor,_:=strconv.Atoi(m[2]); return major>2 || major==2 && minor>=3
}
type zfsNumber string
func(n *zfsNumber) UnmarshalJSON(b []byte)error { s:=strings.Trim(string(b),`"`); if _,err:=strconv.ParseUint(s,10,64);err!=nil { return err }; *n=zfsNumber(s); return nil }
func(n zfsNumber) value()uint64 { v,_:=strconv.ParseUint(string(n),10,64); return v }
type zfsVdev struct {
    Type string `json:"vdev_type"`; GUID zfsNumber `json:"guid"`; Path string `json:"path"`; State string `json:"state"`
    Read zfsNumber `json:"read_errors"`; Write zfsNumber `json:"write_errors"`; Checksum zfsNumber `json:"checksum_errors"`
    Children map[string]zfsVdev `json:"vdevs"`
}
type zfsPoolJSON struct {
    Name string `json:"name"`; State string `json:"state"`
    Vdevs map[string]zfsVdev `json:"vdevs"`
    Special map[string]zfsVdev `json:"special"`; Dedup map[string]zfsVdev `json:"dedup"`; Logs map[string]zfsVdev `json:"logs"`
    Cache map[string]zfsVdev `json:"l2cache"`; Spares map[string]zfsVdev `json:"spares"`
    Scan struct { Function string `json:"function"`; State string `json:"state"`; Examined zfsNumber `json:"examined"`; Total zfsNumber `json:"to_examine"` } `json:"scan_stats"`
}
func parseZFSJSON(list string,data []byte,stable func(string)string)(Result,error) {
    var doc struct{ Pools map[string]zfsPoolJSON `json:"pools"` }
    if err:=json.Unmarshal(data,&doc);err!=nil { return Result{},err }; if doc.Pools==nil { return Result{},fmt.Errorf("ZFS JSON has no pools") }
    rows,complete:=zfsBase(list); observed:=map[string]bool{}
    for name,p:=range doc.Pools {
        if p.Name!="" { name=p.Name }; key:="zfs:pool:"+name; vd,ok:=rows[key]; if !ok || p.State=="" { complete=false; continue }
        observed[key]=true; vd.State=remainingVendorState("zfs","virtual_disk",p.State); vd.StateDetail=textPtr(p.State)
        if p.Scan.State=="SCANNING" && (p.Scan.Function=="SCRUB" || p.Scan.Function=="RESILVER") {
            var progress *int
            if p.Scan.Total.value()>0 { v:=int(100*float64(p.Scan.Examined.value())/float64(p.Scan.Total.value())); if v>100 { v=100 }; progress=&v }
            zfsProgress(&vd,strings.ToLower(p.Scan.Function),progress)
        }; rows[key]=vd
        var walk func(map[string]zfsVdev)
        walk=func(tree map[string]zfsVdev) {
            names:=make([]string,0,len(tree)); for n:=range tree { names=append(names,n) }; sort.Strings(names)
            for _,n:=range names {
                v:=tree[n]; if len(v.Children)>0 { walk(v.Children); continue }; if v.Type!="disk" && v.Type!="file" { complete=false; continue }
                id:=stable(v.Path); if id=="" { id=string(v.GUID) }; if id=="" || v.State=="" { complete=false; continue }
                zfsMember(rows,key,id,v.Path,v.State,v.Read.value(),v.Write.value(),v.Checksum.value())
            }
        }
        if len(p.Vdevs)==0 { complete=false }
        for _,tree:=range []map[string]zfsVdev{p.Vdevs,p.Special,p.Dedup,p.Logs,p.Cache,p.Spares} { walk(tree) }
    }
    for key,c:=range rows { if c.ComponentType=="virtual_disk" && !observed[key] { complete=false } }
    r:=Result{Components:sortedComponents(rows),Complete:complete}; if !complete { r.Warnings=[]string{"incomplete ZFS JSON topology"} }; return r,nil
}
```

- [ ] **Step 4: Replace Task 7's `Collect` method (4 minutes).** Complete replacement, using its existing imports:

```go
func(s *zfsSource) Collect(ctx context.Context,a Availability)(Result,error) {
    list,err:=s.run(ctx,30*time.Second,a.Path,"list","-H","-o","name,health,size,alloc,free")
    if err!=nil || list.Truncated || list.ExitCode!=0 { return Result{},fmt.Errorf("zpool list failed: exit=%d: %v",list.ExitCode,err) }
    if text:=strings.TrimSpace(string(list.Stdout));text=="" || text=="no pools available" { return Result{Complete:true,Components:[]Component{}},nil }
    if rows,_:=zfsBase(string(list.Stdout));len(rows)==0 { return Result{},fmt.Errorf("unrecognized zpool list output") }
    version,versionErr:=s.run(ctx,30*time.Second,a.Path,"version"); versionText:=strings.TrimSpace(string(version.Stdout))
    if len(versionText)>100 { versionText=versionText[:100] }; warnings:=[]string{}
    if versionErr==nil && version.ExitCode==0 && !version.Truncated && zfsJSONCapable(versionText) {
        output,jsonErr:=s.run(ctx,30*time.Second,a.Path,"status","-pP","-j","--json-int")
        if jsonErr==nil && output.ExitCode==0 && !output.Truncated {
            if r,parseErr:=parseZFSJSON(string(list.Stdout),output.Stdout,s.stable);parseErr==nil { r.ToolVersion=versionText; return r,nil }
        }; warnings=append(warnings,"ZFS JSON unavailable; used text status")
    }
    output,statusErr:=s.run(ctx,30*time.Second,a.Path,"status","-pP")
    status:=string(output.Stdout); if statusErr!=nil || output.ExitCode!=0 || output.Truncated { status=""; warnings=append(warnings,"zpool status failed") }
    r:=parseZFSText(string(list.Stdout),status,s.stable); r.ToolVersion=versionText; r.Warnings=append(r.Warnings,warnings...); return r,nil
}
```

- [ ] **Step 5: Run green on Linux (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `TestZFSJSON` and `TestZFSText` PASS.
- [ ] **Step 6: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/zfs_linux.go agent/internal/collectors/hwhealth/zfs_json_linux.go agent/internal/collectors/hwhealth/zfs_json_linux_test.go agent/internal/collectors/hwhealth/testdata/zfs/optimal.json
git commit -m $'feat(agent): prefer version-gated OpenZFS JSON\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 9: Select Broadcom precedence from cached availability

**Files:** Modify W02a `agent/internal/collectors/hwhealth/detect.go` (W02a plan:352–353, append the new helper); Create `agent/internal/collectors/hwhealth/precedence_test.go`.
**Interfaces:** Consumes `Availability`, `Kind`, W02a `(*detection).get(now time.Time, probe func() Availability) Availability`. Produces `broadcomSuperseded(available map[Kind]Availability) map[Kind]Kind`, mapping each installed loser to its selected winner. No changes to cache lifetime, `Availability`, or `SourceStatus`.

Decision: use the complete cached `available` map that W02a already assembles before its collection loop. Neither call `lookupTool` again nor consider collection success. This keeps selection independent of source order, breaker state and newly installed executables until the next hourly detection pass.

- [ ] **Step 1: Write the failing complete availability matrix (4 minutes).** Create `precedence_test.go`:

```go
package hwhealth

import (
    "context"
    "sync"
    "testing"
    "time"
)
type selectionStub struct { kind Kind; available bool; calls *int }
func(s selectionStub) Name()Kind{return s.kind}
func(s selectionStub) Tier()Tier{return "raid"}
func(s selectionStub) Detect(context.Context)Availability{return Availability{Available:s.available,Path:string(s.kind)}}
func(s selectionStub) Collect(context.Context,Availability)(Result,error){if s.calls!=nil{(*s.calls)++};return Result{Complete:true},nil}
func TestSourcePrecedence(t *testing.T) {
    for mask:=0;mask<16;mask++ {
        installed:=map[Kind]bool{"storcli":mask&8!=0,"perccli":mask&4!=0,"megacli":mask&2!=0,"omreport":mask&1!=0,"ssacli":true,"arcconf":true,"zfs":true}
        winner:=Kind("");for _,kind:=range []Kind{"storcli","perccli","megacli"}{if installed[kind]{winner=kind;break}}
        for _,order:=range [][]Kind{{"omreport","arcconf","ssacli","megacli","perccli","storcli","zfs"},{"storcli","perccli","megacli","ssacli","arcconf","omreport","zfs"}}{
            available:=map[Kind]Availability{};for _,k:=range order{available[k]=Availability{Available:installed[k]}}
            suppressed:=broadcomSuperseded(available)
            priority:=map[Kind]int{"storcli":3,"perccli":2,"megacli":1,"omreport":0}
            for _,kind:=range order{
                p,bc:=priority[kind];want:=Kind("")
                if installed[kind] && bc && winner!="" && p<priority[winner]{want=winner}
                if suppressed[kind]!=want{t.Fatalf("mask=%d %s winner=%s want=%s",mask,kind,suppressed[kind],want)}
                if available[kind].Available!=installed[kind]{t.Fatal("mutated cached availability")}
            }
        }
    }
}
func TestPrecedenceUsesDetectionCache(t *testing.T){
    now:=time.Date(2026,9,23,12,0,0,0,time.UTC);installed:=false;cache:=&detection{}
    probe:=func()Availability{return Availability{Available:installed}}
    available:=map[Kind]Availability{"megacli":{Available:true},"storcli":cache.get(now,probe)}
    installed=true;available["storcli"]=cache.get(now.Add(time.Minute),probe)
    if broadcomSuperseded(available)["megacli"]!=""{t.Fatal("new binary bypassed hourly cache")}
    available["storcli"]=cache.get(now.Add(time.Hour),probe)
    if broadcomSuperseded(available)["megacli"]!="storcli"{t.Fatal("hourly refresh ignored")}
}
func TestPrecedenceConcurrentRead(t *testing.T){
    available:=map[Kind]Availability{"storcli":{Available:true},"omreport":{Available:true}}
    var wg sync.WaitGroup
    for i:=0;i<16;i++{wg.Add(1);go func(){defer wg.Done();if broadcomSuperseded(available)["omreport"]!="storcli"{t.Error("precedence")}}()};wg.Wait()
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: broadcomSuperseded`.
- [ ] **Step 3: Append the pure selection helper to `detect.go` (3 minutes).** No new imports:

```go
func broadcomSuperseded(available map[Kind]Availability)map[Kind]Kind {
    suppressed:=map[Kind]Kind{};winner:=Kind("")
    family:=[]Kind{"storcli","perccli","megacli"}
    for _,kind:=range family{if available[kind].Available{winner=kind;break}}
    if winner==""{return suppressed}
    found:=false
    for _,kind:=range family{
        if kind==winner{found=true;continue}
        if found && available[kind].Available{suppressed[kind]=winner}
    }
    if available["omreport"].Available{suppressed["omreport"]=winner}
    return suppressed
}
```

- [ ] **Step 4: Run green (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect all 16 installed-tool combinations PASS, in both orders and under race detection.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/detect.go agent/internal/collectors/hwhealth/precedence_test.go
git commit -m $'feat(agent): select Broadcom precedence from cached detection\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 10: Register sources in the existing collector

**Files:** Modify W02a `agent/internal/collectors/hwhealth/collector.go` (W02a plan:1033,1055,1065; index §H:501: `Collector`, `New(opts Options) *Collector`, `(*Collector).Run(ctx, tiers []Tier) (*Snapshot,error)`); Create `agent/internal/collectors/hwhealth/sources_linux.go`, `agent/internal/collectors/hwhealth/sources_other.go`, `agent/internal/collectors/hwhealth/sources_test.go`.
**Interfaces:** Consumes Tasks 3–9 constructors and `broadcomSuperseded(map[Kind]Availability) map[Kind]Kind`. Produces `remainingSources([]string) []Source`; preserves the exact `New`/`Run` signatures and all W02a scheduler, breaker, cache and persistence code.

- [ ] **Step 1: Write failing registry and real pipeline tests (5 minutes).** Create `sources_test.go`:

```go
package hwhealth

import (
    "context"
    "errors"
    "runtime"
    "testing"
    "time"
)
func TestRemainingSources(t *testing.T) {
    names:=map[Kind]bool{};for _,s:=range remainingSources([]string{"custom"}){names[s.Name()]=true;if s.Tier()!="raid"{t.Fatal("tier")}}
    want:=0;if runtime.GOOS=="linux"{want=5};if runtime.GOOS=="windows"{want=4}
    if len(names)!=want { t.Fatalf("%s has %v",runtime.GOOS,names) }
}
type failingSelectedSource struct{ selectionStub }
func(s failingSelectedSource)Collect(context.Context,Availability)(Result,error){return Result{},errors.New("vendor hung")}
func TestCollectorKeepsSuppressionWhenWinnerFails(t *testing.T) {
    if runtime.GOOS!="linux" && runtime.GOOS!="windows" { t.Skip("supported agent OS only") }
    calls:=0
    col:=New(Options{DataDir:t.TempDir(),Sources:[]Source{
        failingSelectedSource{selectionStub{"storcli",true,nil}},selectionStub{"omreport",true,&calls},selectionStub{"ssacli",true,nil},
    }})
    col.ApplyConfig(Config{Enabled:true,PollInterval:10*time.Minute,DiskHealthInterval:time.Hour})
    snap,err:=col.Run(context.Background(),[]Tier{"raid"});if err!=nil{t.Fatal(err)}
    statuses:=map[Kind]SourceStatus{};for _,s:=range snap.Sources{statuses[s.Source]=s.Status}
    if statuses["storcli"]!="failed" || statuses["omreport"]!="superseded" || statuses["ssacli"]!="ok" || calls!=0 { t.Fatalf("statuses=%v calls=%d",statuses,calls) }
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `undefined: remainingSources`; after the factory compiles, `TestCollectorKeepsSuppressionWhenWinnerFails` must fail until the collection-loop branch changes.
- [ ] **Step 3: Add platform factories (3 minutes).** `sources_linux.go`:

```go
//go:build linux

package hwhealth

func remainingSources(dirs []string)[]Source {
    return []Source{newMegaCLI(dirs),newSSACLI(dirs),newARCCONF(dirs),newOMReport(dirs),newZFSSource(dirs)}
}
```

`sources_other.go`:

```go
//go:build !linux

package hwhealth

import "runtime"

func remainingSources(dirs []string)[]Source {
    if runtime.GOOS!="windows" { return nil }
    return []Source{newMegaCLI(dirs),newSSACLI(dirs),newARCCONF(dirs),newOMReport(dirs)}
}
```

- [ ] **Step 4: Insert the concrete registration and suppression hooks (5 minutes).** The inspected W02a plan:1037–1039 assigns default sources to `c.sources`, not `opts.Sources`. At the end of that existing `opts.Sources==nil` supported-platform branch, append:

```go
c.sources = append(c.sources, remainingSources(opts.ExtraToolDirs)...)
```

Keep the following `for _,s:=range c.sources` detection/breaker registration loop unchanged; it now registers the new sources too. Explicit `Options.Sources` remains an exact replacement, including non-nil empty slices.

In `(*Collector).Run`, after the entire `available` map has been populated by `c.detect[s.Name()].get(now, ...)` and before `noTools` (W02a plan:1055–1056), insert:

```go
superseded := map[Kind]Kind{}
if ctx.Err()==nil { superseded = broadcomSuperseded(available) }
```

Replace W02a's single `if k=="perccli" && available["storcli"].Available` branch (W02a plan:1065), after its unavailable check and before tier/breaker checks, with this full block:

```go
if winner,ok:=superseded[k];ok {
    report.Status="superseded"
    report.Warnings=[]string{"superseded by "+string(winner)}
    snapshot.Sources=append(snapshot.Sources,report)
    continue
}
```

The context guard avoids treating W02a’s budget-skipped detection sentinel (`Available:true`) as evidence of an installed winner. The existing `report` already contains the cached `Path` and `ToolVersion`; `Complete`, `RetryAt` and `Error` stay unset. Disabled reports exit earlier. Absent tools exit as `unavailable`; installed losers never reach the breaker or `Collect`. W02a's `limitSnapshot` still applies all payload/string/attribute bounds, and its existing single-flight lock protects the selection and collection cycle.

- [ ] **Step 5: Run green (3 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `TestCollectorKeepsSuppressionWhenWinnerFails` PASS and all W02a tests green. `cd agent && go vet ./...` — expect exit 0.
- [ ] **Step 6: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/collector.go agent/internal/collectors/hwhealth/sources_linux.go agent/internal/collectors/hwhealth/sources_other.go agent/internal/collectors/hwhealth/sources_test.go
git commit -m $'feat(agent): register remaining RAID sources in collector\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 11: Complete the fixture matrix and failure-path contract

**Files:** Create `agent/internal/collectors/hwhealth/fixtures_test.go`, `agent/internal/collectors/hwhealth/fixtures_linux_test.go`; Create `agent/internal/collectors/hwhealth/testdata/megacli/matrix.json`, `agent/internal/collectors/hwhealth/testdata/ssacli/matrix.json`, `agent/internal/collectors/hwhealth/testdata/arcconf/matrix.json`, `agent/internal/collectors/hwhealth/testdata/omreport/matrix.json`, `agent/internal/collectors/hwhealth/testdata/zfs/matrix.json`. Modify `sources_test.go` (Task 10, append tests).
**Interfaces:** Consumes the actual `Source.Collect` implementations, not a test-only parser. Produces fixture harness `sourceFixture`, `readSourceFixtures`, `checkSourceFixture`; no production interface changes.

Decision: the nine cases are optimal, degraded, failed, rebuilding-with-progress, predictive failure, missing member, multi-controller, unrecognized state, truncated output. ZFS's predictive-failure case exercises `MemberErrors=true` and explicitly keeps `PredictiveFailure=false` because §5.2 supplies no ZFS predictive flag. ZFS multi-controller means multiple pools under its one synthetic controller. Samples are synthetic native-format text/JSON with no real serials or infrastructure details.

- [ ] **Step 1: Write the complete matrix harness and fault tests (5 minutes).** Create `fixtures_test.go`:

```go
package hwhealth

import (
    "context"
    "encoding/json"
    "strings"
    "testing"
    "time"
)
type sourceCapture struct { Args []string; Text string; ExitCode int; Truncated bool }
type sourceWant struct { Key,State,Detail string; Progress *int; Predictive,MemberErrors *bool }
type sourceFixture struct { Name string; Captures []sourceCapture; Want []sourceWant; Complete,Error bool; PhysicalCount *int }
func readSourceFixtures(t *testing.T,kind string)[]sourceFixture {
    t.Helper();var cases []sourceFixture
    if err:=json.Unmarshal(w02bFixture(t,kind+"/matrix.json"),&cases);err!=nil{t.Fatal(err)}
    required:=map[string]bool{"optimal":false,"degraded":false,"failed":false,"rebuilding":false,"predictive_failure":false,"missing_member":false,"multi_controller":false,"unrecognized":false,"truncated":false}
    for _,tc:=range cases{if _,ok:=required[tc.Name];!ok{t.Fatal("unexpected case",tc.Name)};if required[tc.Name]{t.Fatal("duplicate case",tc.Name)};required[tc.Name]=true}
    for name,seen:=range required{if !seen{t.Fatal("missing case",name)}};return cases
}
func fixtureRunner(t *testing.T,tc sourceFixture,timeout time.Duration)toolRunner {
    t.Helper();return func(ctx context.Context,d time.Duration,path string,args ...string)(execResult,error){
        if d!=timeout{t.Fatalf("timeout=%s want=%s",d,timeout)}
        for _,capture:=range tc.Captures{if strings.Join(args,"\x00")==strings.Join(capture.Args,"\x00"){return execResult{Stdout:[]byte(capture.Text),ExitCode:capture.ExitCode,Truncated:capture.Truncated},nil}}
        t.Fatalf("unexpected command %v",args);return execResult{},nil
    }
}
func checkSourceFixture(t *testing.T,tc sourceFixture,r Result,err error){
    t.Helper();if (err!=nil)!=tc.Error{t.Fatalf("error=%v wantError=%t",err,tc.Error)}
    if r.Complete!=tc.Complete{t.Fatalf("complete=%t want=%t; warnings=%v",r.Complete,tc.Complete,r.Warnings)}
    seen:=map[string]bool{};physical:=0
    for _,c:=range r.Components{if seen[c.ComponentKey]{t.Fatal("duplicate key",c.ComponentKey)};seen[c.ComponentKey]=true;if c.ComponentType=="physical_disk"{physical++}}
    if tc.PhysicalCount!=nil && physical!=*tc.PhysicalCount{t.Fatalf("physical=%d want=%d",physical,*tc.PhysicalCount)}
    for _,want:=range tc.Want{
        c:=w02bComponent(t,r,want.Key)
        if c.State!=want.State{t.Fatalf("%s state=%s want=%s",want.Key,c.State,want.State)}
        if want.Detail!="" && (c.StateDetail==nil || *c.StateDetail!=want.Detail){t.Fatalf("raw state lost: %+v",c)}
        if want.Progress!=nil && (c.ProgressPercent==nil || *c.ProgressPercent!=*want.Progress){t.Fatalf("progress lost: %+v",c)}
        if want.Predictive!=nil && c.PredictiveFailure!=*want.Predictive{t.Fatalf("predictive lost: %+v",c)}
        if want.MemberErrors!=nil && (c.MemberErrors==nil || *c.MemberErrors!=*want.MemberErrors){t.Fatalf("member errors lost: %+v",c)}
    }
}
func TestVendorFixtureMatrix(t *testing.T){
    factories:=map[string]func([]string)*cliSource{"megacli":newMegaCLI,"ssacli":newSSACLI,"arcconf":newARCCONF,"omreport":newOMReport}
    for kind,factory:=range factories{for _,tc:=range readSourceFixtures(t,kind){t.Run(kind+"/"+tc.Name,func(t *testing.T){
        s:=factory(nil);s.run=fixtureRunner(t,tc,s.timeout);r,err:=s.Collect(context.Background(),Availability{Available:true,Path:"fixture"});checkSourceFixture(t,tc,r,err)
    })}}
}
func TestSourceCancellationAndEmptyOutput(t *testing.T){
    for _,factory:=range []func([]string)*cliSource{newMegaCLI,newSSACLI,newARCCONF,newOMReport}{
        s:=factory(nil);ctx,cancel:=context.WithCancel(context.Background());cancel()
        s.run=func(context.Context,time.Duration,string,...string)(execResult,error){t.Fatal("cancelled source spawned command");return execResult{},nil}
        if _,err:=s.Collect(ctx,Availability{Available:true,Path:"fixture"});err==nil{t.Fatal("cancelled source succeeded")}
        s.run=func(context.Context,time.Duration,string,...string)(execResult,error){return execResult{},nil}
        if _,err:=s.Collect(context.Background(),Availability{Available:true,Path:"fixture"});err==nil{t.Fatal("empty output succeeded")}
    }
}
func TestMissingNumericFields(t *testing.T){for _,s:=range []string{""," ","not reported"}{if textInt(s)!=0{t.Fatalf("%q",s)}}}
```

Create `fixtures_linux_test.go`:

```go
//go:build linux

package hwhealth

import (
    "context"
    "testing"
    "time"
)
func TestZFSFixtureMatrix(t *testing.T){
    for _,tc:=range readSourceFixtures(t,"zfs"){t.Run(tc.Name,func(t *testing.T){
        s:=newZFSSource(nil);s.run=fixtureRunner(t,tc,30*time.Second)
        r,err:=s.Collect(context.Background(),Availability{Available:true,Path:"fixture"});checkSourceFixture(t,tc,r,err)
    })}
}
func TestZFSJSONCommandFallback(t *testing.T){
    s:=newZFSSource(nil);calls:=0
    s.run=func(ctx context.Context,d time.Duration,path string,args ...string)(execResult,error){
        calls++;text:=""
        switch args[0]{case "list":text="tank ONLINE 100G 20G 80G";case "version":text="zfs-2.3.0";case "status":
            if len(args)>2{return execResult{Stdout:[]byte(`{"pools":`)},nil}
            text="  pool: tank\n state: ONLINE\nconfig:\n NAME STATE READ WRITE CKSUM\n /dev/disk/by-id/ata-A ONLINE 0 0 0\nerrors: No known data errors\n"
        };return execResult{Stdout:[]byte(text)},nil
    }
    r,err:=s.Collect(context.Background(),Availability{Path:"fixture",Available:true})
    if err!=nil || !r.Complete || calls!=4 || len(r.Warnings)==0{t.Fatalf("calls=%d r=%+v err=%v",calls,r,err)}
}
```

Append to Task 10's `sources_test.go`:

```go
func TestSuppressionSurvivesBreaker(t *testing.T){
    if runtime.GOOS!="linux" && runtime.GOOS!="windows"{t.Skip("supported agent OS only")}
    calls:=0;col:=New(Options{DataDir:t.TempDir(),Sources:[]Source{failingSelectedSource{selectionStub{"storcli",true,nil}},selectionStub{"omreport",true,&calls}}})
    col.ApplyConfig(Config{Enabled:true,PollInterval:10*time.Minute,DiskHealthInterval:time.Hour})
    for cycle:=0;cycle<4;cycle++{
        snapshot,err:=col.Run(context.Background(),[]Tier{"raid"});if err!=nil{t.Fatal(err)}
        for _,report:=range snapshot.Sources{
            if report.Source=="omreport" && report.Status!="superseded"{t.Fatalf("%+v",report)}
            if report.Source=="storcli" && cycle==3 && report.Status!="backing_off"{t.Fatalf("breaker did not open: %+v",report)}
        }
    };if calls!=0{t.Fatal("fallback executed while winner backed off")}
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `open testdata/megacli/matrix.json: no such file or directory` (map iteration may name another source first). This test is not a coverage-count assertion alone: it executes every actual source and checks observations, completeness, timeouts and flags.
- [ ] **Step 3: Generate the complete committed fixture matrix (5 minutes).** Run this full script from the repository root; it reads only Task 3–8 fixtures and writes the five new matrix files:

```python
from pathlib import Path
import copy, json, re
root=Path('agent/internal/collectors/hwhealth/testdata')
commands={
 'megacli':[['-AdpAllInfo','-aALL'],['-LDInfo','-Lall','-aALL'],['-PDList','-aALL'],['-AdpBbuCmd','-GetBbuStatus','-aALL'],['-LDPDInfo','-aALL']],
 'ssacli':[['ctrl','all','show','status'],['ctrl','all','show','config','detail']],
 'arcconf':[['GETVERSION'],['GETCONFIG','1','AL']],
 'omreport':[['storage','controller','-fmt','ssv'],['storage','vdisk','-fmt','ssv'],['storage','battery','-fmt','ssv'],['storage','pdisk','controller=0','-fmt','ssv']],
 'zfs':[['list','-H','-o','name,health,size,alloc,free'],['status','-pP']],
}
# Each tuple supplies native spelling, not a normalized pseudo-format.
settings={
 'megacli':('megacli:c0:v0','megacli:c0:e252:s3',1,'State: Optimal','State: Degraded',2,'Firmware state: Online, Spun Up','Firmware state: Failed','Firmware state: Future State'),
 'ssacli':('ssacli:c0:v1','ssacli:c0:e1I-1:s3',1,'Status: OK\n         Size','Status: Interim Recovery Mode\n         Size',1,'Status: OK\n         Drive Type','Status: Failed\n         Drive Type','Status: Future State\n         Drive Type'),
 'arcconf':('arcconf:c1:v0','arcconf:c1:e-:s0-3',1,'Status of logical device: Optimal','Status of logical device: Degraded',1,'State: Online','State: Failed','State: Future State'),
 'omreport':('omreport:c0:v0','omreport:c0:e0-1:s3',1,'mirror;Ready','mirror;Degraded',3,'Disk 3;Online','Disk 3;Failed','Disk 3;Future State'),
 'zfs':('zfs:pool:tank','zfs:pool:tank:m:ata-A',1,'state: ONLINE','state: DEGRADED',1,'ata-A     ONLINE','ata-A     FAULTED','ata-A     FutureState'),
}
for kind,cmds in commands.items():
 parts=(root/kind/'optimal.txt').read_text().split('\n===\n')
 base=[dict(Args=args,Text=text,ExitCode=0,Truncated=False) for args,text in zip(cmds,parts)]
 if kind=='zfs':base.append(dict(Args=['version'],Text='zfs-2.2.9',ExitCode=0,Truncated=False))
 vd,pd,vi,healthy,degraded,pi,online,failed,unknown=settings[kind]
 cases=[]
 def add(name,captures,want,complete=True,error=False,count=None):
  value=dict(Name=name,Captures=captures,Want=want,Complete=complete,Error=error)
  if count is not None:value['PhysicalCount']=count
  cases.append(value)
 def change(index,old,new):
  result=copy.deepcopy(base)
  assert old in result[index]['Text'],(kind,old)
  result[index]['Text']=result[index]['Text'].replace(old,new)
  return result
 def want(key,state,**extra):return dict(Key=key,State=state,**extra)
 add('optimal',copy.deepcopy(base),[want(vd,'optimal'),want(pd,'online')])
 add('degraded',change(vi,healthy,degraded),[want(vd,'degraded')])
 add('failed',change(pi,online,failed),[want(pd,'failed')])
 progress=copy.deepcopy(base)
 if kind=='megacli':progress[1]['Text']+='\nOngoing Progresses:\nRebuild: 42%\n'
 elif kind=='ssacli':progress[1]['Text']=progress[1]['Text'].replace(healthy,'Status: Rebuilding\n         Rebuild Status: 42%\n         Size')
 elif kind=='arcconf':progress[1]['Text']=progress[1]['Text'].replace(healthy,'Status of logical device: Rebuilding\n   Rebuild progress: 42%')
 elif kind=='omreport':progress[1]['Text']=progress[1]['Text'].replace('Layout;Size','Layout;Size;Progress').replace('mirror;Ready;RAID-1;100 GB','mirror;Resynching;RAID-1;100 GB;42%')
 else:progress[1]['Text']=progress[1]['Text'].replace('scan: none requested','scan: resilver in progress\n        42% done')
 add('rebuilding',progress,[want(vd,'rebuilding',Progress=42)])
 predictive=copy.deepcopy(base);expected=want(pd,'online',Predictive=True)
 if kind=='megacli':predictive[2]['Text']=predictive[2]['Text'].replace('Predictive Failure Count: 0','Predictive Failure Count: 1')
 elif kind=='ssacli':predictive[1]['Text']=predictive[1]['Text'].replace(online,'Status: Predictive Failure\n         Drive Type');expected['State']='predictive_failure'
 elif kind=='arcconf':predictive[1]['Text']=predictive[1]['Text'].replace('S.M.A.R.T. warnings: 0','S.M.A.R.T. warnings: 1')
 elif kind=='omreport':predictive[3]['Text']=predictive[3]['Text'].replace(';Online;No;',';Online;Yes;')
 else:predictive[1]['Text']=predictive[1]['Text'].replace('ata-A     ONLINE       0','ata-A     ONLINE       1');expected.update(Predictive=False,MemberErrors=True)
 add('predictive_failure',predictive,[expected])
 missing=copy.deepcopy(base);expected=[];count=0
 if kind=='megacli':missing[2]['Text']='Adapter #0\nNo Physical Drive\n';missing[4]['Text']='Adapter #0\nVirtual Drive: 0 (Target Id: 0)\n'
 elif kind=='ssacli':missing[1]['Text']=missing[1]['Text'].split('      physicaldrive')[0]
 elif kind=='arcconf':missing[1]['Text']=re.sub(r'Device #0.*?Battery Information','Battery Information',missing[1]['Text'],flags=re.S)
 elif kind=='omreport':missing[3]['Text']=missing[3]['Text'].split('\n')[0]+'\n'
 else:missing[1]['Text']=missing[1]['Text'].replace('ata-B     ONLINE','ata-B     UNAVAIL');expected=[want('zfs:pool:tank:m:ata-B','missing')];count=2
 add('missing_member',missing,expected,count=count)
 multi=copy.deepcopy(base)
 if kind=='megacli':
  for c in multi:c['Text']+='\n'+c['Text'].replace('Adapter #0','Adapter #1').replace('Adapter 0','Adapter 1').replace('Adapter: 0','Adapter: 1')
  expected=[want('megacli:c1:v0','optimal')];count=2
 elif kind=='ssacli':
  for c in multi:c['Text']+='\n'+c['Text'].replace('Slot 0','Slot 2')
  expected=[want('ssacli:c2:v1','optimal')];count=2
 elif kind=='arcconf':
  multi[0]['Text']=multi[0]['Text'].replace('Controllers found: 1','Controllers found: 2')+'\nController #2\n'
  multi.append(dict(Args=['GETCONFIG','2','AL'],Text=multi[1]['Text'].replace('Controller:1','Controller:2'),ExitCode=0,Truncated=False));expected=[want('arcconf:c2:v0','optimal')];count=2
 elif kind=='omreport':
  multi[0]['Text']+='\n1;Ok;Second controller;Ready;1.0\n'
  for i in [1,2]:multi[i]['Text']+='\n'+multi[i]['Text'].replace('Slot 0','Slot 1')
  multi.append(dict(Args=['storage','pdisk','controller=1','-fmt','ssv'],Text=multi[3]['Text'],ExitCode=0,Truncated=False));expected=[want('omreport:c1:v0','optimal')];count=2
 else:
  for i in [0,1]:multi[i]['Text']+='\n'+multi[i]['Text'].replace('tank','vault')
  expected=[want('zfs:pool:vault','optimal')];count=4
 add('multi_controller',multi,expected,count=count)
 detail='FutureState' if kind=='zfs' else 'Future State'
 add('unrecognized',change(pi,online,unknown),[want(pd,'unknown',Detail=detail)])
 truncated=copy.deepcopy(base);cut=1 if kind in ['arcconf','ssacli','zfs'] else len(base)-1
 truncated[cut]['Truncated']=True
 add('truncated',truncated,[],complete=False,error=kind=='arcconf')
 (root/kind/'matrix.json').write_text(json.dumps(cases,indent=2)+'\n')
```

- [ ] **Step 4: Run green and release gates (5 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect all 45 matrix cases PASS (36 on native Windows; ZFS's nine run on Linux). Then `cd agent && go test -race ./...` and `cd agent && go vet ./...` — both exit 0. Run those same commands in the native Windows lab checkout with a race-capable Go/C toolchain; attach test output to the wave issue. A cross-compile is not evidence of execution. Reuse W02a's scheduler/breaker tests, including index review-focus item 5; an unavailable lab keeps the wave's release gate open, never report it as passed.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add agent/internal/collectors/hwhealth/fixtures_test.go agent/internal/collectors/hwhealth/fixtures_linux_test.go agent/internal/collectors/hwhealth/sources_test.go agent/internal/collectors/hwhealth/testdata
git commit -m $'test(agent): cover hardware source fixture and failure matrix\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 12: Document and verify agent-local tool directories

**Files:** Modify `docs/guides/AGENT_INSTALLATION.md:534` (insert before `# Logging` in YAML reference); Create `agent/internal/collectors/hwhealth/tool_dirs_test.go`.
**Interfaces:** Consumes W02a `lookupTool(names []string, extraDirs []string) (path string, ok bool)` and existing config `Hardware.ToolDirs` (`mapstructure:"tool_dirs" yaml:"tool_dirs"` under `hardware`, index §H:515). No new setting, API route or UI control.

- [ ] **Step 1: Write failing lookup/documentation tests (4 minutes).** Create `tool_dirs_test.go`:

```go
package hwhealth

import (
    "os"
    "path/filepath"
    "runtime"
    "strings"
    "testing"
)
func TestToolDirsOverrideAndDocs(t *testing.T){
    dirs:=[]string{t.TempDir(),t.TempDir()};name:="breeze-hwhealth-fixture-tool"
    if runtime.GOOS=="windows"{name+=".exe"}
    local:=filepath.Join(dirs[1],name);if err:=os.WriteFile(local,[]byte("fixture; never executed"),0755);err!=nil{t.Fatal(err)}
    path,ok:=lookupTool([]string{name},dirs);if !ok || path!=local{t.Fatalf("override=%q %t",path,ok)}
    // A unique filename avoids installed tools; no global PATH mutation or tool execution.
    docs,err:=os.ReadFile(filepath.Join("..","..","..","..","docs","guides","AGENT_INSTALLATION.md"));if err!=nil{t.Fatal(err)}
    for _,needle:=range []string{"hardware:","tool_dirs:","'D:\\tools'","fixture-only","hpssacli","hpacucli","agent-local"}{
        if !strings.Contains(string(docs),needle){t.Fatalf("documentation missing %q",needle)}
    }
}
```

- [ ] **Step 2: Run red (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect `documentation missing "hardware:"`. Lookup already works through W02a; do not recreate that mechanism to make this task red.
- [ ] **Step 3: Insert the full documented configuration block (3 minutes).** At the inspected line 534, before `# Logging`, insert exactly this YAML (it remains inside the existing YAML fence):

```yaml
# Hardware monitoring tool discovery (agent-local)
# ----------------------------------------------
hardware:
  tool_dirs: []
  # Extra directories, searched after PATH and platform well-known directories.
  # Windows example: tool_dirs: ['D:\tools']
  # Linux example: tool_dirs: ['/opt/vendor-tools']
  # Install vendor tools yourself; Breeze does not download or bundle them.
  # Restart the agent after editing this local file. Discovery is cached for 1 hour.
  # This setting is agent-local, not delivered by configuration policy.
  # storcli > perccli > MegaCli; any installed Broadcom CLI suppresses omreport.
  # ssacli (including hpssacli and hpacucli) and arcconf run independently.
  # Collection is read-only. ssacli and omreport allow 60 seconds per command.
  # These vendor parsers are fixture-only until real hardware captures are verified.
  # Linux ZFS uses zpool and requires at least one pool for initial detection.

```

The existing W02a `ExtraToolDirs` plumbing reaches every Task 3–8 constructor through Task 10. W04 owns the customer-facing feature page at `apps/docs/src/content/docs/features/hardware-monitoring.mdx` and install links; W06 owns replacing fixture-only labels with observed evidence. This task creates neither page nor sidebar.

- [ ] **Step 4: Run green (2 minutes).** `cd agent && go test -race ./internal/collectors/hwhealth/...` — expect PASS. Re-run the full suite only if this test exposes a code change; Task 11 already runs the release gates.
- [ ] **Step 5: Commit (2 minutes).**

```bash
git add docs/guides/AGENT_INSTALLATION.md agent/internal/collectors/hwhealth/tool_dirs_test.go
git commit -m $'docs(agent): document local hardware tool directories\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

## Self-review

- Spec §5.1 W02b rows: all five source command families, timeout values, aliases, platform restrictions and read-only behavior are pinned in Tasks 3–8/11.
- Spec §5.2 and index §B: Task 1 hardcodes the allowed Go vocabulary and every W02b mapping; parser fixtures retain unknown raw `StateDetail` and exercise flags without sending health.
- Spec §§4.2/6.1: slot identity, HPE port+box enclosure encoding, arcconf `e-` channel/device slots, stable ZFS members, memberships and partial-observation completeness are pinned in Tasks 2–8.
- Spec D12/§6.5: Tasks 9–10 extend W02a’s pre-collection availability map, preserve failed/backing-off winner semantics and expose `superseded` through the exact `SourceReport` vocabulary.
- Spec §6.6: Task 12 documents `hardware.tool_dirs`; W02a retains config decoding, search order and its one-hour detection cache (index §H), with no policy or UI path added.
- Spec §13: Task 11 ships nine fixture scenarios per source plus native Windows/Linux execution gates; vendor captures remain fixture-only pending W06 lab proof.
- W02a retains runner, scheduling, budget fairness, persistence, breaker, smartctl replay and core sources; W01 owns validation/ingest/RLS and W03 owns alerts.
- W04 owns the feature UI/docs page; W05 owns BMC discovery/linking; W06 owns live hardware evidence and release coordination.
- Index §H integration resolved against W02a’s newly available plan: Tasks 9–10 append to `c.sources` and extend its existing `available` map; private names avoid W02a helper collisions and no cache/scheduler is replanned.

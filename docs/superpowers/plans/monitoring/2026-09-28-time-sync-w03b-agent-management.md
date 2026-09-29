# Time Sync W03b Agent Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce Windows time policies safely across machine roles, retain enforcement across restarts, and execute the three audited time-management commands.
**Architecture:** Serialize collection, policy changes, reconciliation and commands through one agent-owned controller; retain settings, per-kind attempt gates and latest results separately from collector sequence state. Reconciliation uses an injected read function backed by the W01b `System` through `Collector.Collect`, plus a platform-specific `Writer`; transport remains the existing time-status PUT. Every mutation is preceded by fresh guard reads and followed by read-back, with durable attempt reservations preventing restart-driven retry storms.
**Tech Stack:** Go 1.26.6, standard testing/race detector, golang.org/x/sys/windows/registry, existing SCM service tools, github.com/google/uuid.
**Spec:** `docs/superpowers/specs/monitoring/2026-09-28-time-sync-monitoring-design.md`
**Index:** `docs/superpowers/plans/monitoring/2026-09-28-time-sync.md`

## Global Constraints

All constraints in the index's Global constraints section apply.
- W03b changes Go agent code only; zero API, web, shared-validator, migration, monitor-version or tenancy changes.
- Windows 10 / Server 2016 minimum; non-Windows sends no time snapshots and performs no writes.
- Command timeout: 60 s; each exec timeout: 10 s; SCM start has the existing 30 s bound.
- Same-fingerprint minimum interval: 1 h; failure back-off: 1 h, 2 h, 4 h, 8 h, 16 h, 24 h maximum, independently per kind.
- `force=true` bypasses time gates only, never validation, role, GPO, read-back or persistence guards.
- Collector state: `timesync-state.json`; management state: `timesync-management.json`, schema version 1, maximum 1 MiB, mode 0600 in the agent state directory.
- Snapshot cadence: 30 min ±10%; first scheduled collection: 2–5 min after start; settings changes and commands request immediate snapshots.
- NTP servers: 0–5, at least 1 when enabled; poll interval: integer 15–1440 min; append exactly `,0x9` in the writer.
- Keep nullable JSON fields present; error text maximum 512 UTF-16 code units; UUID result IDs; §F.3 before/after contain only the specified scalar keys.
- Latest results survive disable/removal and restart; removing a policy stops enforcement without reverting Windows configuration.
- GPO/MDM/unknown management must fail closed in the W01b read layer; an unreadable role is `unknown`.
- PowerShell below is operator-only lab setup, never agent implementation; agent execs use argument arrays and no shell.
- Agent release requires L6–L8 plus L1/L3/L5 regression evidence on the installed agent, never a second agent process.

**Baseline qualification.** Initial read-only inspection at `354d359424` found the index and spec but none of the W01b/W03a implementation artifacts. Sibling plan documents appeared concurrently during authoring; they are not merged production code. This plan consumes their index contracts; it does not implement those waves. In particular, there are no truthful current line numbers for `timesync/*.go` or `heartbeat/time_sync.go`. Resolve Contract issues 1–3 against the merged dependency revision before implementation. All other modification anchors below are verified against this checkout. The proposed complete `time_sync.go` body preserves the index scheduling contract; reconcile it with the real W01b file before replacement so there is exactly one scheduler/collector. Do not implement two schedulers.

**Template audit.** `git show --stat` was read for all four supplied commits. `8d79246f47` supplies the applicable agent sites: package platform split, fake sources, bounded exec, persistence, collector tests, heartbeat fields/construction/ticker/start/stop/send/config dispatch and heartbeat tests. Its hardware config-file additions are inapplicable because time settings arrive only via §F.2. `ddfcd2a044`, `b9b294e759`, and `57c10e0c4f` have no additional W03b agent sites; their API/shared/web registrations belong to prior waves. Command registry completeness is an additional applicable site at `handlers_test.go:117–118`.

## Review Focus

No index Review focus item is assigned to W03b; items 1–5 remain owned by W01a/W01b. The following three inputs pin this PR's boundary regressions:
- Hand-edited `NtpServer` spacing, case and flag suffixes → compare normalized host sets, preserve correct domain hierarchy, and never execute invalid fixture input (Tasks 1–3; supports index item 3).
- Role/GPO changes between collection and each write, including a forest-root PDC becoming a child-domain PDC → stop further mutations, report `role_unknown`/`conflict_gpo`, and read actual partial changes (Tasks 3–4, L6/L7 in Task 7).
- Restart, overlapping command/config/tick, or failure after a durable attempt reservation → no duplicate writes within the gate, stable result IDs across snapshots, ordered sequence sends, and immediate follow-up after queued changes (Tasks 4–6).

## File Structure

Paths below are implementation outputs, not files to create while writing this plan.

| File | Responsibility |
|---|---|
| `agent/internal/collectors/timesync/settings.go` | Strict snake/camel settings parser and host validation. |
| `agent/internal/collectors/timesync/settings_test.go` | Payload boundaries and shared-fixture parity. |
| `agent/internal/collectors/timesync/management_types.go` | Management observations, result wire DTOs and persisted attempt state. |
| `agent/internal/collectors/timesync/writer.go` | Writer interface, validated argv construction and dependency seams. |
| `agent/internal/collectors/timesync/writer_windows.go` | Bounded exec, registry, timezone existence, SCM adapter. |
| `agent/internal/collectors/timesync/writer_other.go` | Unsupported platform constructor. |
| `agent/internal/collectors/timesync/writer_test.go` | Exact argv, invalid-host zero-call and write-error tests. |
| `agent/internal/collectors/timesync/writer_windows_test.go` | Native quote round-trip and read-only zone existence test. |
| `agent/internal/collectors/timesync/reconcile.go` | Desired role state, guards, apply/read-back and per-kind gates. |
| `agent/internal/collectors/timesync/reconcile_test.go` | Role/guard/outcome matrix, back-off, reset, force and timezone tests. |
| `agent/internal/collectors/timesync/management_store.go` | Atomic settings/result/gate persistence independent of collector state. |
| `agent/internal/collectors/timesync/management.go` | Serialized controller, System-backed reads, event preservation and snapshot overlay. |
| `agent/internal/collectors/timesync/management_commands.go` | Exact §F.4 command actions and result structures. |
| `agent/internal/collectors/timesync/management_test.go` | Restart, state errors, event retention, serialization and command read-back. |
| `agent/internal/heartbeat/time_sync.go` | Settings dispatch, single scheduler, controller lifecycle and upload. |
| `agent/internal/heartbeat/time_sync_test.go` | Config dispatch before early return, immediate send, cancellation and cadence. |
| `agent/internal/heartbeat/heartbeat.go` | Controller field, constructor/start/stop and upload-context hooks. |
| `agent/internal/heartbeat/handlers_timesync.go` | Three init-registered handlers with structured failures. |
| `agent/internal/heartbeat/handlers_timesync_test.go` | Real registry dispatch, payloads, outcomes and snapshot attempts. |
| `agent/internal/heartbeat/handlers_test.go` | Add three commands to registry completeness list. |
| `agent/internal/remote/tools/types.go` | Command constants only. |
| `agent/internal/privilege/check.go` | Elevated command list. |
| `agent/internal/privilege/timesync_test.go` | Portable elevation-registration tests. |

Existing W01b `Snapshot`, `EnforcementReport`, `System`, `New`, `NewSystem`, `Collect`, host helpers and sequence persistence are consumed unchanged. Management reads the **documented JSON representation** of Snapshot to avoid inventing unstated Go nested field names. `ManagementReport` is a local persistence DTO with §F.3's exact wire keys, not a replacement for W01b `EnforcementReport`. See Contract issue 2 about the absent concrete System interface.

### Task 1: Pin settings and management wire types

**Files:**
- Create: `agent/internal/collectors/timesync/settings.go`
- Create: `agent/internal/collectors/timesync/management_types.go`
- Test: `agent/internal/collectors/timesync/settings_test.go`
- Consume: index `:262–267` shared fixture; index `:549–554` W01b host helpers and collector contracts (absent locally; no invented source line).

**Interfaces:**
- Consumes: `IsValidNtpServerHost(s string) bool`, `ParseNtpServerHosts(raw string) []string` (index §H).
- Produces: `ParseSettings(raw any) (Settings, error)`, `ValidateSettings(s Settings) error`.
- Produces: `EnforcementResult`, `ManagementReport`, `ManagementState`, `Observation`, `ReadObservation func(context.Context) (Observation, error)`.

- [ ] Write the failing tests in `settings_test.go`:

```go
package timesync

import (
    "encoding/json"
    "os"
    "strings"
    "testing"
)

func settingsFixture() Settings {
    return Settings{EnforceNTP: true, NTPServers: []string{"time.cloudflare.com", "pool.ntp.org"},
        PollIntervalMinutes: 60, Fingerprint: "sha256:" + strings.Repeat("a", 64)}
}
func rawSettings(t *testing.T, s Settings) map[string]any {
    t.Helper()
    b, err := json.Marshal(s)
    if err != nil { t.Fatal(err) }
    var m map[string]any
    if err = json.Unmarshal(b, &m); err != nil { t.Fatal(err) }
    return m
}
func hostFixture(t *testing.T) (valid, invalid []string) {
    t.Helper()
    // Four parent components: package -> collectors -> internal -> agent -> repository.
    b, err := os.ReadFile("../../../../packages/shared/src/validators/__fixtures__/ntpServers.json")
    if err != nil { t.Fatal(err) }
    var f struct { Valid, Invalid []string }
    if err = json.Unmarshal(b, &f); err != nil { t.Fatal(err) }
    if len(f.Valid) == 0 || len(f.Invalid) == 0 { t.Fatal("empty shared host fixture") }
    return f.Valid, f.Invalid
}
func TestManagementSettingsHostFixture(t *testing.T) {
    valid, invalid := hostFixture(t)
    for _, host := range valid {
        s := settingsFixture(); s.NTPServers = []string{host}
        if _, err := ParseSettings(rawSettings(t, s)); err != nil { t.Fatalf("valid %q: %v", host, err) }
    }
    for _, host := range invalid {
        s := settingsFixture(); s.NTPServers = []string{host}
        if _, err := ParseSettings(rawSettings(t, s)); err == nil { t.Fatalf("accepted invalid %q", host) }
    }
}
func TestManagementSettingsShape(t *testing.T) {
    for _, camel := range []bool{false, true} {
        m := rawSettings(t, settingsFixture())
        if camel {
            for a, b := range map[string]string{"enforce_ntp":"enforceNtp", "ntp_servers":"ntpServers", "poll_interval_minutes":"pollIntervalMinutes"} {
                m[b] = m[a]; delete(m, a)
            }
            z := m["timezone"].(map[string]any)
            z["autoFix"] = z["auto_fix"]; delete(z, "auto_fix")
            z["expectedWindowsId"] = z["expected_windows_id"]; delete(z, "expected_windows_id")
        }
        if _, err := ParseSettings(m); err != nil { t.Fatal(err) }
    }
    for _, tc := range []struct{name string; change func(map[string]any)}{
        {"missing", func(m map[string]any){delete(m,"enforce_ntp")}},
        {"fraction",func(m map[string]any){m["poll_interval_minutes"]=15.5}},
        {"low",func(m map[string]any){m["poll_interval_minutes"]=14}},
        {"high",func(m map[string]any){m["poll_interval_minutes"]=1441}},
        {"empty",func(m map[string]any){m["ntp_servers"]=[]string{}}},
        {"six",func(m map[string]any){m["ntp_servers"]=[]string{"a","b","c","d","e","f"}}},
        {"null",func(m map[string]any){m["ntp_servers"]=nil}},
        {"unknown",func(m map[string]any){m["extra"]=true}},
        {"aliases",func(m map[string]any){m["enforceNtp"]=true}},
        {"fingerprint",func(m map[string]any){m["fingerprint"]=""}},
        {"zone-path",func(m map[string]any){m["timezone"].(map[string]any)["expected_windows_id"]=`..\UTC`}},
    } {
        t.Run(tc.name,func(t *testing.T){m:=rawSettings(t,settingsFixture());tc.change(m)
            if _,err:=ParseSettings(m);err==nil{t.Fatal("accepted invalid settings")}})
    }
    s:=settingsFixture();s.EnforceNTP=false;s.NTPServers=[]string{}
    if _,err:=ParseSettings(rawSettings(t,s));err!=nil{t.Fatal(err)}
}
func TestManagementResultNulls(t *testing.T) {
    r:=EnforcementResult{Before:map[string]any{"type":nil},After:map[string]any{"type":nil}}
    b,err:=json.Marshal(ManagementReport{NTP:&r});if err!=nil{t.Fatal(err)}
    if !strings.Contains(string(b),`"timezone":null`) || !strings.Contains(string(b),`"error":null`) {
        t.Fatal(string(b))
    }
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected FAIL: `undefined: Settings` after the W01b prerequisite is present. In this checkout the earlier failure is missing package; that is a prerequisite failure, not the intended red test.
- [ ] Create `management_types.go`:

```go
package timesync

import (
    "context"
    "encoding/json"
    "time"
    "unicode/utf16"
)

type Settings struct {
    EnforceNTP bool `json:"enforce_ntp"`
    NTPServers []string `json:"ntp_servers"`
    PollIntervalMinutes int `json:"poll_interval_minutes"`
    Timezone TimezoneSettings `json:"timezone"`
    Fingerprint string `json:"fingerprint"`
}
type TimezoneSettings struct {
    ExpectedWindowsID *string `json:"expected_windows_id"`
    AutoFix bool `json:"auto_fix"`
}
type ManagementReport struct {
    NTP *EnforcementResult `json:"ntp"`
    Timezone *EnforcementResult `json:"timezone"`
}
type AttemptGate struct {
    Fingerprint string `json:"fingerprint"`
    Next time.Time `json:"next"`
    Failures int `json:"failures"`
}
type ManagementState struct {
    Version int `json:"version"`
    Settings *Settings `json:"settings"`
    Report ManagementReport `json:"report"`
    NTPGate AttemptGate `json:"ntpGate"`
    TimezoneGate AttemptGate `json:"timezoneGate"`
    PendingEvents map[uint64]json.RawMessage `json:"pendingEvents"`
}
// These tags are a projection of index B, not additional wire fields.
type Observation struct {
    Config struct {
        Type *string `json:"type"`
        NTPServer *string `json:"ntpServer"`
        SpecialPollIntervalSeconds *int `json:"specialPollIntervalSeconds"`
        PolicyManaged bool `json:"policyManaged"`
        ServiceState string `json:"serviceState"`
        ServiceStartType string `json:"serviceStartType"`
    } `json:"config"`
    Domain struct { Role string `json:"role"` } `json:"domain"`
    Timezone struct {
        WindowsID *string `json:"windowsId"`
        AutoUpdate string `json:"autoUpdate"`
    } `json:"timezone"`
    Status struct { LastSuccessfulSyncAt *string `json:"lastSuccessfulSyncAt"` } `json:"status"`
}
type ReadObservation func(context.Context) (Observation, error)
func scalar[T any](p *T) any { if p==nil{return nil};return *p }
func value[T comparable](p *T, want T) bool {return p!=nil && *p==want}
func managementPtr[T any](v T) *T {return &v}
func errorText(err error) *string {
    if err==nil{return nil}
    runes:=make([]rune,0,512);units:=0
    for _,r:=range err.Error(){n:=utf16.RuneLen(r);if units+n>512{break};runes=append(runes,r);units+=n}
    s:=string(runes);return &s
}
```

Consume W01b `EnforcementResult` with `At time.Time` and its existing JSON tags; do not redeclare it or its private `ptr` helper. The concurrently authored W01b plan now provides that declaration at `2026-09-28-time-sync-w01b-agent-collector.md:404–417`; production source remains absent. Task 1 uses a uniquely named `managementPtr` helper to avoid collision. Contract issue 2 records this dependency-interface reconciliation.

- [ ] Create `settings.go`:

```go
package timesync

import (
    "encoding/json"
    "fmt"
    "regexp"
    "strings"
    "unicode/utf8"
)

var fingerprintPattern=regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
func zoneSyntax(id string) bool {
    return utf8.ValidString(id) && utf8.RuneCountInString(id)<=128 &&
        strings.TrimSpace(id)==id && id!="" && !strings.ContainsAny(id,"\\/\x00\r\n")
}
func ValidateSettings(s Settings) error {
    if !fingerprintPattern.MatchString(s.Fingerprint){return fmt.Errorf("invalid fingerprint")}
    if s.PollIntervalMinutes<15 || s.PollIntervalMinutes>1440{return fmt.Errorf("invalid poll interval")}
    if s.NTPServers==nil || len(s.NTPServers)>5 || (s.EnforceNTP && len(s.NTPServers)==0){return fmt.Errorf("invalid peer count")}
    for _,h:=range s.NTPServers{if !IsValidNtpServerHost(h){return fmt.Errorf("invalid NTP server host")}}
    if s.Timezone.ExpectedWindowsID!=nil && !zoneSyntax(*s.Timezone.ExpectedWindowsID){return fmt.Errorf("invalid timezone ID")}
    return nil
}
func canonicalObject(m map[string]json.RawMessage, aliases map[string]string, required []string) error {
    for old,next:=range aliases{if v,ok:=m[old];ok{
        if _,exists:=m[next];exists{return fmt.Errorf("duplicate settings alias %s",next)}
        m[next]=v;delete(m,old)
    }}
    allowed:=map[string]bool{}
    for _,key:=range required{allowed[key]=true;if _,ok:=m[key];!ok{return fmt.Errorf("missing %s",key)}}
    for key:=range m{if !allowed[key]{return fmt.Errorf("unknown setting %s",key)}}
    return nil
}
func ParseSettings(raw any) (Settings,error) {
    var out Settings
    b,err:=json.Marshal(raw);if err!=nil{return out,err}
    var m map[string]json.RawMessage
    if err=json.Unmarshal(b,&m);err!=nil || m==nil{return out,fmt.Errorf("settings must be an object")}
    err=canonicalObject(m,map[string]string{"enforceNtp":"enforce_ntp","ntpServers":"ntp_servers","pollIntervalMinutes":"poll_interval_minutes"},
        []string{"enforce_ntp","ntp_servers","poll_interval_minutes","timezone","fingerprint"})
    if err!=nil{return out,err}
    var z map[string]json.RawMessage
    if err=json.Unmarshal(m["timezone"],&z);err!=nil || z==nil{return out,fmt.Errorf("timezone must be an object")}
    if err=canonicalObject(z,map[string]string{"expectedWindowsId":"expected_windows_id","autoFix":"auto_fix"},[]string{"expected_windows_id","auto_fix"});err!=nil{return out,err}
    for _,key:=range []string{"enforce_ntp","ntp_servers","poll_interval_minutes","fingerprint"}{
        if string(m[key])=="null"{return out,fmt.Errorf("null %s",key)}
    }
    if string(z["auto_fix"])=="null"{return out,fmt.Errorf("null auto_fix")}
    m["timezone"],err=json.Marshal(z);if err!=nil{return out,err}
    b,err=json.Marshal(m);if err!=nil{return out,err}
    if err=json.Unmarshal(b,&out);err!=nil{return out,err}
    return out,ValidateSettings(out)
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected PASS for settings tests and the existing W01b collector tests.
- [ ] Commit:

```sh
git add agent/internal/collectors/timesync/settings.go agent/internal/collectors/timesync/management_types.go agent/internal/collectors/timesync/settings_test.go
git commit -m 'feat(timesync): validate delivered management settings' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 2: Implement bounded platform writers and prove argv

**Files:**
- Create: `agent/internal/collectors/timesync/writer.go`, `writer_windows.go`, `writer_other.go`
- Test: `agent/internal/collectors/timesync/writer_test.go`, `writer_windows_test.go`
- Reference: `agent/internal/remote/tools/services.go:97–119`, `services_windows.go:114–133` (existing SCM helper, not modified).

**Interfaces:**
- Consumes: Task 1 host/zone validation; `tools.StartService(payload map[string]any) tools.CommandResult`.
- Produces: `Writer`, `NewWriter() Writer`; `Manual(context.Context, []string, bool) error`, `Hierarchy(context.Context) error`, `Poll(context.Context,int) error`, `Update(context.Context) error`, `Automatic(context.Context) error`, `Start(context.Context) error`, `Resync(context.Context) (int,error)`, `ZoneExists(string) error`, `Timezone(context.Context,string) error`.

**Argument verification.** Go documents quoting Windows Args according to `CommandLineToArgvW`; local Go `src/os/exec/exec.go:407–414` confirms this. Therefore `/manualpeerlist:time.cloudflare.com,0x9 pool.ntp.org,0x9` is **one** argument without embedded quotes. Microsoft's shell examples quote the space-delimited value; Go supplies command-line quoting, not a shell. Do not set `SysProcAttr.CmdLine`. Unit tests pin the argument vector; Task 7 pins actual w32tm acceptance and registry read-back. [Go exec documentation](https://pkg.go.dev/os/exec), [Microsoft W32Time syntax](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings).

- [ ] Write `writer_test.go`:

```go
package timesync

import (
    "context"
    "errors"
    "reflect"
    "testing"
)
func TestManagementWriterArgv(t *testing.T) {
    ctx:=context.Background()
    for _,tc:=range []struct{name string;call func(Writer)error;want []string}{
        {"manual",func(w Writer)error{return w.Manual(ctx,[]string{"time.cloudflare.com","pool.ntp.org"},false)},[]string{"w32tm.exe","/config","/manualpeerlist:time.cloudflare.com,0x9 pool.ntp.org,0x9","/syncfromflags:manual","/update"}},
        {"root-pdc",func(w Writer)error{return w.Manual(ctx,[]string{"pool.ntp.org"},true)},[]string{"w32tm.exe","/config","/manualpeerlist:pool.ntp.org,0x9","/syncfromflags:manual","/reliable:yes","/update"}},
        {"domain",func(w Writer)error{return w.Hierarchy(ctx)},[]string{"w32tm.exe","/config","/syncfromflags:domhier","/update"}},
        {"update",func(w Writer)error{return w.Update(ctx)},[]string{"w32tm.exe","/config","/update"}},
        {"auto",func(w Writer)error{return w.Automatic(ctx)},[]string{"sc.exe","config","W32Time","start=","auto"}},
        {"resync",func(w Writer)error{_,e:=w.Resync(ctx);return e},[]string{"w32tm.exe","/resync","/rediscover"}},
        {"zone",func(w Writer)error{return w.Timezone(ctx,"Eastern Standard Time")},[]string{"tzutil.exe","/s","Eastern Standard Time"}},
    } {t.Run(tc.name,func(t *testing.T){var got []string
        w:=&commandWriter{run:func(_ context.Context,name string,args ...string)(int,error){got=append([]string{name},args...);return 0,nil},zone:func(string)error{return nil}}
        if err:=tc.call(w);err!=nil{t.Fatal(err)}
        if !reflect.DeepEqual(got,tc.want){t.Fatalf("argv=%q want=%q",got,tc.want)}
    })}
}
func TestManagementWriterRejectsHostsBeforeExec(t *testing.T) {
    _,invalid:=hostFixture(t)
    for _,host:=range invalid{t.Run(host,func(t *testing.T){calls:=0
        w:=&commandWriter{run:func(context.Context,string,...string)(int,error){calls++;return 0,nil}}
        if err:=w.Manual(context.Background(),[]string{host},false);err==nil{t.Fatal("invalid host accepted")}
        if calls!=0{t.Fatal("exec called for invalid host")}
    })}
}
func TestManagementWriterRegistrySCMAndFailures(t *testing.T) {
    poll,starts,execs:=0,0,0
    w:=&commandWriter{run:func(context.Context,string,...string)(int,error){execs++;return 7,errors.New("exec failed")},
        poll:func(n int)error{poll=n;return nil},start:func(context.Context)error{starts++;return nil},
        zone:func(string)error{return errors.New("unknown zone")}}
    if err:=w.Poll(context.Background(),3600);err!=nil || poll!=3600{t.Fatal(poll,err)}
    if err:=w.Start(context.Background());err!=nil || starts!=1{t.Fatal(starts,err)}
    if err:=w.Timezone(context.Background(),"Missing Zone");err==nil || execs!=0{t.Fatal("zone validation did not precede exec")}
    if code,err:=w.Resync(context.Background());code!=7 || err==nil{t.Fatal(code,err)}
    if err:=w.Poll(context.Background(),899);err==nil{t.Fatal("invalid poll")}
    c,cancel:=context.WithCancel(context.Background());cancel()
    if err:=w.Start(c);!errors.Is(err,context.Canceled){t.Fatal(err)}
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected FAIL: `undefined: Writer` and `undefined: commandWriter`.
- [ ] Create `writer.go`:

```go
package timesync

import (
    "context"
    "fmt"
    "strings"
)
type Writer interface {
    Manual(context.Context,[]string,bool) error
    Hierarchy(context.Context) error
    Poll(context.Context,int) error
    Update(context.Context) error
    Automatic(context.Context) error
    Start(context.Context) error
    Resync(context.Context)(int,error)
    ZoneExists(string) error
    Timezone(context.Context,string) error
}
type commandWriter struct {
    run func(context.Context,string,...string)(int,error)
    poll func(int)error
    start func(context.Context)error
    zone func(string)error
}
func(w *commandWriter)Manual(ctx context.Context,hosts []string,reliable bool)error{
    if len(hosts)<1 || len(hosts)>5{return fmt.Errorf("invalid peer count")}
    peers:=make([]string,len(hosts))
    for i,h:=range hosts{if !IsValidNtpServerHost(h){return fmt.Errorf("invalid NTP server host")};peers[i]=h+",0x9"}
    args:=[]string{"/config","/manualpeerlist:"+strings.Join(peers," "),"/syncfromflags:manual"}
    if reliable{args=append(args,"/reliable:yes")};args=append(args,"/update")
    _,err:=w.run(ctx,"w32tm.exe",args...);return err
}
func(w *commandWriter)Hierarchy(ctx context.Context)error{_,e:=w.run(ctx,"w32tm.exe","/config","/syncfromflags:domhier","/update");return e}
func(w *commandWriter)Update(ctx context.Context)error{_,e:=w.run(ctx,"w32tm.exe","/config","/update");return e}
func(w *commandWriter)Automatic(ctx context.Context)error{_,e:=w.run(ctx,"sc.exe","config","W32Time","start=","auto");return e}
func(w *commandWriter)Resync(ctx context.Context)(int,error){return w.run(ctx,"w32tm.exe","/resync","/rediscover")}
func(w *commandWriter)Poll(ctx context.Context,n int)error{
    if err:=ctx.Err();err!=nil{return err};if n<900 || n>86400{return fmt.Errorf("invalid poll seconds")};return w.poll(n)
}
func(w *commandWriter)Start(ctx context.Context)error{if e:=ctx.Err();e!=nil{return e};return w.start(ctx)}
func(w *commandWriter)ZoneExists(id string)error{if !zoneSyntax(id){return fmt.Errorf("invalid timezone ID")};return w.zone(id)}
func(w *commandWriter)Timezone(ctx context.Context,id string)error{
    if e:=w.ZoneExists(id);e!=nil{return e};_,e:=w.run(ctx,"tzutil.exe","/s",id);return e
}
```

- [ ] Create `writer_windows.go`:

```go
//go:build windows

package timesync

import (
    "context"
    "errors"
    "fmt"
    "os/exec"
    "path/filepath"
    "time"

    "github.com/breeze-rmm/agent/internal/remote/tools"
    "golang.org/x/sys/windows"
    "golang.org/x/sys/windows/registry"
)
func NewWriter() Writer {
    return &commandWriter{run:runTimeCommand,poll:writeTimePoll,start:startTimeService,zone:windowsZoneExists}
}
func runTimeCommand(parent context.Context,name string,args ...string)(int,error){
    ctx,cancel:=context.WithTimeout(parent,10*time.Second);defer cancel()
    dir,err:=windows.GetSystemDirectory();if err!=nil{return 1,err}
    // Fixed filenames supplied only by commandWriter; never a policy-controlled path.
    cmd:=exec.CommandContext(ctx,filepath.Join(dir,name),args...)
    cmd.WaitDelay=time.Second
    // Output is neither needed nor parsed; nil streams go to the null device.
    err=cmd.Run()
    if ctx.Err()!=nil{return 1,ctx.Err()}
    if err==nil{return 0,nil}
    var ee *exec.ExitError;if errors.As(err,&ee){return ee.ExitCode(),err}
    return 1,err
}
func writeTimePoll(n int)error{
    key,err:=registry.OpenKey(registry.LOCAL_MACHINE,`SYSTEM\CurrentControlSet\Services\W32Time\TimeProviders\NtpClient`,registry.SET_VALUE)
    if err!=nil{return err};defer key.Close()
    return key.SetDWordValue("SpecialPollInterval",uint32(n))
}
func windowsZoneExists(id string)error{
    if !zoneSyntax(id){return fmt.Errorf("invalid timezone ID")}
    key,err:=registry.OpenKey(registry.LOCAL_MACHINE,`SOFTWARE\Microsoft\Windows NT\CurrentVersion\Time Zones\`+id,registry.QUERY_VALUE)
    if err!=nil{return fmt.Errorf("timezone ID is not installed: %w",err)}
    return key.Close()
}
func startTimeService(ctx context.Context)error{
    if e:=ctx.Err();e!=nil{return e}
    // The reused SCM helper has a 30 s wait and no context parameter.
    if deadline,ok:=ctx.Deadline();ok && time.Until(deadline)<31*time.Second{return context.DeadlineExceeded}
    // services_windows.go:114-133 uses SCM, closes handles, and waits at most 30 s.
    result:=tools.StartService(map[string]any{"name":"W32Time"})
    if result.Status!="completed"{return fmt.Errorf("start W32Time: %s",result.Error)}
    return ctx.Err()
}
```

SCM start cannot be cancelled while inside the existing helper; it is bounded by its 30-second wait. Do not abandon it in an untracked goroutine. A role/GPO change cannot be made atomic with a Windows service operation; the immediate read guard narrows that race, and subsequent writes re-check.

- [ ] Create `writer_other.go`:

```go
//go:build !windows

package timesync

func NewWriter() Writer { return nil }
```

- [ ] Create `writer_windows_test.go`:

```go
//go:build windows

package timesync

import (
    "reflect"
    "testing"

    "golang.org/x/sys/windows"
)
func TestManagementWindowsQuoteRoundTrip(t *testing.T){
    want:=[]string{"w32tm.exe","/config","/manualpeerlist:time.cloudflare.com,0x9 pool.ntp.org,0x9","/syncfromflags:manual","/update"}
    got,err:=windows.DecomposeCommandLine(windows.ComposeCommandLine(want))
    if err!=nil || !reflect.DeepEqual(got,want){t.Fatal(got,err)}
}
func TestManagementInstalledZoneValidation(t *testing.T){
    if err:=windowsZoneExists("UTC");err!=nil{t.Fatal(err)}
    for _,id:=range []string{"",`..\UTC`,"UTC/child","Breeze Nonexistent Test Zone"}{
        if err:=windowsZoneExists(id);err==nil{t.Fatalf("accepted %q",id)}
    }
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected PASS, no real exec or registry writes.
- [ ] Run `cd agent && GOOS=windows go vet ./internal/collectors/timesync/...` and `cd agent && GOOS=windows go test -c -o /tmp/breeze-timesync.test.exe ./internal/collectors/timesync`; expected successful Windows type-check/compile. Run the two Windows-only tests natively in Task 7.
- [ ] Commit:

```sh
git add agent/internal/collectors/timesync/writer.go agent/internal/collectors/timesync/writer_windows.go agent/internal/collectors/timesync/writer_other.go agent/internal/collectors/timesync/writer_test.go agent/internal/collectors/timesync/writer_windows_test.go
git commit -m 'feat(timesync): add validated Windows time writers' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 3: Reconcile roles, re-read guards, and retain bounded attempt gates

**Files:**
- Create: `agent/internal/collectors/timesync/reconcile.go`
- Test: `agent/internal/collectors/timesync/reconcile_test.go`
- Consume: Tasks 1–2 only; no direct Windows reads or execs in this task.

**Interfaces:**
- Consumes: `ReadObservation`, `Writer`, `Settings`, `ManagementState`.
- Produces: `Reconciler.Run(ctx context.Context, force bool) error`; fields `Read ReadObservation`, `Writer Writer`, `Now func() time.Time`, `Save func(ManagementState) error`, `State *ManagementState`.
- Save occurs before the first mutation of a kind, and again after its result; a failed reservation performs zero writes. Caller serializes Run and settings changes.

**Comparison decision:** for manual roles compare `Type=NTP`, normalized host **sets** (case-insensitive, flags stripped with `ParseNtpServerHosts`, duplicate/order independent), poll seconds, `serviceStartType=auto`, and running service. For NT5DS roles compare `Type=NT5DS`, automatic/running service; preserve dormant manual peers and poll because §8.3's hierarchy branch does not change them. This resolves the compare/apply inconsistency explicitly in Contract issue 4. `/reliable:yes` is emitted whenever applying on the forest-root PDC; reliability itself is not a field in index B and cannot participate in its read-back comparison.

- [ ] Write `reconcile_test.go` (full fake and test code):

```go
package timesync

import (
    "context"
    "errors"
    "reflect"
    "strings"
    "testing"
    "time"

    "github.com/google/uuid"
)

type fakeTimeSystem struct {
    obs Observation
    calls []string
    reads int
    beforeRead func(*fakeTimeSystem)
    fail string
    mismatch bool
}
func newFakeTimeSystem(role string)*fakeTimeSystem{
    f:=&fakeTimeSystem{}
    f.obs.Domain.Role=role
    f.obs.Config.Type=managementPtr("NoSync")
    f.obs.Config.NTPServer=managementPtr("old.example,0x8")
    f.obs.Config.SpecialPollIntervalSeconds=managementPtr(900)
    f.obs.Config.ServiceStartType="manual"
    f.obs.Config.ServiceState="stopped"
    f.obs.Timezone.WindowsID=managementPtr("UTC");f.obs.Timezone.AutoUpdate="off"
    return f
}
func(f *fakeTimeSystem)read(context.Context)(Observation,error){
    f.reads++;if f.beforeRead!=nil{f.beforeRead(f)}
    if f.fail=="read"{return Observation{},errors.New("read failed")};return f.obs,nil
}
func(f *fakeTimeSystem)write(name string,apply func())error{
    f.calls=append(f.calls,name)
    if f.fail==name{return errors.New(name+" failed")}
    if !f.mismatch{apply()};return nil
}
func(f *fakeTimeSystem)Manual(_ context.Context,h []string,reliable bool)error{
    name:="manual";if reliable{name="reliable"}
    return f.write(name,func(){f.obs.Config.Type=managementPtr("NTP");f.obs.Config.NTPServer=managementPtr(strings.Join(h,",0x9 ")+",0x9")})
}
func(f *fakeTimeSystem)Hierarchy(context.Context)error{return f.write("hierarchy",func(){f.obs.Config.Type=managementPtr("NT5DS")})}
func(f *fakeTimeSystem)Poll(_ context.Context,n int)error{return f.write("poll",func(){f.obs.Config.SpecialPollIntervalSeconds=managementPtr(n)})}
func(f *fakeTimeSystem)Update(context.Context)error{return f.write("update",func(){})}
func(f *fakeTimeSystem)Automatic(context.Context)error{return f.write("auto",func(){f.obs.Config.ServiceStartType="auto"})}
func(f *fakeTimeSystem)Start(context.Context)error{return f.write("start",func(){f.obs.Config.ServiceState="running"})}
func(f *fakeTimeSystem)Resync(context.Context)(int,error){e:=f.write("resync",func(){});if e!=nil{return 5,e};return 0,nil}
func(f *fakeTimeSystem)ZoneExists(id string)error{if !zoneSyntax(id)||id=="Missing Zone"{return errors.New("missing zone")};return nil}
func(f *fakeTimeSystem)Timezone(_ context.Context,id string)error{return f.write("timezone",func(){f.obs.Timezone.WindowsID=managementPtr(id)})}
func fakeReconciler(f *fakeTimeSystem,now *time.Time)*Reconciler{
    s:=settingsFixture()
    return &Reconciler{Read:f.read,Writer:f,Now:func()time.Time{return *now},
        State:&ManagementState{Version:1,Settings:&s},Save:func(ManagementState)error{return nil}}
}
func TestReconcileRoleGuardOutcomeMatrix(t *testing.T){
    roles:=[]string{"workgroup","entra_only","forest_root_pdc_emulator","member","dc","pdc_emulator","unknown"}
    for _,role:=range roles{for _,gpo:=range []bool{false,true}{for _,mode:=range []string{"apply","compliant","exec","readback"}{
        t.Run(role+"/"+mode+"/"+map[bool]string{true:"gpo",false:"local"}[gpo],func(t *testing.T){
            now:=time.Date(2026,9,28,12,0,0,0,time.UTC)
            f:=newFakeTimeSystem(role);f.obs.Config.PolicyManaged=gpo;r:=fakeReconciler(f,&now)
            manual:=role=="workgroup"||role=="entra_only"||role=="forest_root_pdc_emulator"
            if mode=="compliant"{
                typ:="NT5DS";if manual{typ="NTP"}
                f.obs.Config.Type=managementPtr(typ);f.obs.Config.NTPServer=managementPtr("  POOL.NTP.ORG,0x8 time.cloudflare.com,0x1,0x8  ")
                f.obs.Config.SpecialPollIntervalSeconds=managementPtr(3600)
                f.obs.Config.ServiceStartType="auto";f.obs.Config.ServiceState="running"
            }
            if mode=="exec"{if manual{f.fail="manual";if role=="forest_root_pdc_emulator"{f.fail="reliable"}}else{f.fail="hierarchy"}}
            f.mismatch=mode=="readback"
            if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
            got:=r.State.Report.NTP;if got==nil{t.Fatal("missing result")}
            outcome,reason:="ok","applied"
            switch{case role=="unknown":outcome,reason="skipped","role_unknown"
            case gpo:outcome,reason="skipped","conflict_gpo"
            case mode=="compliant":reason="already_compliant"
            case mode=="exec":outcome,reason="failed","exec_failed"
            case mode=="readback":outcome,reason="failed","readback_mismatch"}
            if got.Outcome!=outcome||got.Reason!=reason{t.Fatalf("%+v",got)}
            if _,e:=uuid.Parse(got.ResultID);e!=nil{t.Fatal(e)}
            if got.Fingerprint!=r.State.Settings.Fingerprint{t.Fatal(got.Fingerprint)}
            if outcome=="skipped"||reason=="already_compliant"{if len(f.calls)!=0{t.Fatal(f.calls)}}
            if reason=="applied"{
                want:=[]string{"hierarchy","auto","start","resync"}
                if manual{first:="manual";if role=="forest_root_pdc_emulator"{first="reliable"};want=[]string{first,"poll","update","auto","start","resync"}}
                if !reflect.DeepEqual(f.calls,want){t.Fatal(f.calls,want)}
            }
        })
    }}}
}
func TestReconcileFreshGuardBeforeEveryWrite(t *testing.T){
    for _,guard:=range []string{"role","gpo"}{for stopAt:=0;stopAt<6;stopAt++{
        now:=time.Now();f:=newFakeTimeSystem("forest_root_pdc_emulator");r:=fakeReconciler(f,&now)
        f.beforeRead=func(f *fakeTimeSystem){if len(f.calls)==stopAt && f.reads>=2{
            if guard=="role"{f.obs.Domain.Role="pdc_emulator"}else{f.obs.Config.PolicyManaged=true}
        }}
        if e:=r.Run(context.Background(),true);e!=nil{t.Fatal(e)}
        if len(f.calls)!=stopAt{t.Fatalf("guard=%s stop=%d calls=%v",guard,stopAt,f.calls)}
        want:="role_unknown";if guard=="gpo"{want="conflict_gpo"}
        if r.State.Report.NTP.Reason!=want{t.Fatal(r.State.Report.NTP)}
    }}
}
func TestReconcileBackoffResetForceAndRestartState(t *testing.T){
    now:=time.Date(2026,9,28,12,0,0,0,time.UTC);f:=newFakeTimeSystem("workgroup");f.fail="manual";r:=fakeReconciler(f,&now)
    for _,hours:=range []int{1,2,4,8,16,24,24}{
        if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
        if d:=r.State.NTPGate.Next.Sub(now);d!=time.Duration(hours)*time.Hour{t.Fatal(d,hours)}
        id,calls:=r.State.Report.NTP.ResultID,len(f.calls)
        if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
        if r.State.Report.NTP.ResultID!=id||len(f.calls)!=calls{t.Fatal("limited run changed result or wrote")}
        now=r.State.NTPGate.Next
    }
    now=now.Add(-time.Hour)
    r.State.Settings.Fingerprint="sha256:"+strings.Repeat("b",64)
    if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
    if r.State.NTPGate.Failures!=1 || r.State.NTPGate.Next.Sub(now)!=time.Hour{t.Fatal(r.State.NTPGate)}
    id:=r.State.Report.NTP.ResultID
    if e:=r.Run(context.Background(),true);e!=nil{t.Fatal(e)}
    if r.State.Report.NTP.ResultID==id{t.Fatal("force did not bypass gate")}
}
func TestReconcileInvalidFixtureNeverWrites(t *testing.T){
    _,invalid:=hostFixture(t)
    for _,host:=range invalid{now:=time.Now();f:=newFakeTimeSystem("workgroup");r:=fakeReconciler(f,&now)
        r.State.Settings.NTPServers=[]string{host}
        if e:=r.Run(context.Background(),true);e!=nil{t.Fatal(e)}
        if len(f.calls)!=0 || r.State.Report.NTP.Reason!="invalid_settings" || r.State.Report.NTP.Outcome!="skipped"{t.Fatal(host,f.calls,r.State.Report)}
    }
}
func TestReconcileTimezoneAndNonfatalResync(t *testing.T){
    for _,tc:=range []struct{auto string;expected *string;fail string;reason string;outcome string}{
        {"on",managementPtr("Eastern Standard Time"),"","auto_timezone_on","skipped"},
        {"off",nil,"","no_expected_timezone","skipped"},
        {"unknown",managementPtr("Eastern Standard Time"),"","applied","ok"},
        {"off",managementPtr("UTC"),"","already_compliant","ok"},
        {"off",managementPtr("Missing Zone"),"","invalid_settings","skipped"},
        {"off",managementPtr("Eastern Standard Time"),"timezone","exec_failed","failed"},
    }{now:=time.Now();f:=newFakeTimeSystem("workgroup");r:=fakeReconciler(f,&now)
        r.State.Settings.EnforceNTP=false;r.State.Settings.Timezone=TimezoneSettings{tc.expected,true}
        f.obs.Timezone.AutoUpdate=tc.auto;f.fail=tc.fail
        if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
        got:=r.State.Report.Timezone;if got==nil||got.Reason!=tc.reason||got.Outcome!=tc.outcome{t.Fatal(got)}
        if tc.outcome=="skipped"&&len(f.calls)!=0{t.Fatal(f.calls)}
    }
    now:=time.Now();f:=newFakeTimeSystem("workgroup");f.fail="resync";r:=fakeReconciler(f,&now)
    if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
    if r.State.Report.NTP.Outcome!="ok" || r.State.Report.NTP.Error==nil{t.Fatal(r.State.Report.NTP)}
}
func TestReconcilePersistenceAndReadFailures(t *testing.T){
    now:=time.Now();f:=newFakeTimeSystem("workgroup");r:=fakeReconciler(f,&now)
    r.Save=func(ManagementState)error{return errors.New("disk full")}
    if e:=r.Run(context.Background(),true);e==nil||len(f.calls)!=0{t.Fatal(e,f.calls)}
    r.Save=func(ManagementState)error{return nil};f.fail="read"
    if e:=r.Run(context.Background(),true);e!=nil{t.Fatal(e)}
    if r.State.Report.NTP.Outcome!="failed" || len(f.calls)!=0{t.Fatal(r.State.Report)}
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected FAIL: `undefined: Reconciler`.
- [ ] Create `reconcile.go`:

```go
package timesync

import (
    "context"
    "errors"
    "fmt"
    "slices"
    "strings"
    "time"

    "github.com/google/uuid"
)

type Reconciler struct {
    Read ReadObservation
    Writer Writer
    Now func()time.Time
    Save func(ManagementState)error
    State *ManagementState
}
func manualRole(role string)bool{return role=="workgroup"||role=="entra_only"||role=="forest_root_pdc_emulator"}
func knownRole(role string)bool{return manualRole(role)||role=="member"||role=="dc"||role=="pdc_emulator"}
func normalizedHosts(raw string)[]string{
    h:=ParseNtpServerHosts(raw);for i:=range h{h[i]=strings.ToLower(h[i])};slices.Sort(h);return slices.Compact(h)
}
func matchesNTP(o Observation,s Settings)bool{
    if o.Config.ServiceStartType!="auto" || o.Config.ServiceState!="running"{return false}
    if !manualRole(o.Domain.Role){return value(o.Config.Type,"NT5DS")}
    return value(o.Config.Type,"NTP") && o.Config.NTPServer!=nil &&
        slices.Equal(normalizedHosts(*o.Config.NTPServer),normalizedHosts(strings.Join(s.NTPServers," "))) &&
        value(o.Config.SpecialPollIntervalSeconds,s.PollIntervalMinutes*60)
}
func ntpValues(o Observation)map[string]any{
    var start any;if o.Config.ServiceStartType!=""{start=o.Config.ServiceStartType}
    return map[string]any{"type":scalar(o.Config.Type),"ntpServer":scalar(o.Config.NTPServer),
        "specialPollIntervalSeconds":scalar(o.Config.SpecialPollIntervalSeconds),"serviceStartType":start}
}
func zoneValues(o Observation)map[string]any{return map[string]any{"windowsId":scalar(o.Timezone.WindowsID)}}
func newResult(s Settings,now time.Time,outcome,reason string,before,after map[string]any,err error)*EnforcementResult{
    fp:=s.Fingerprint;if len(fp)>80{fp=""}
    return &EnforcementResult{ResultID:uuid.NewString(),Fingerprint:fp,At:now.UTC(),
        Outcome:outcome,Reason:reason,Before:before,After:after,Error:errorText(err)}
}
func gateDelay(failures int)time.Duration{
    if failures<=1{return time.Hour};if failures>=6{return 24*time.Hour};return time.Hour<<uint(failures-1)
}
func(r *Reconciler)Run(ctx context.Context,force bool)error{
    if r.State.Settings==nil || r.Writer==nil{return nil}
    s:=*r.State.Settings
    if err:=ValidateSettings(s);err!=nil{
        r.State.Report.NTP=newResult(s,r.Now(),"skipped","invalid_settings",ntpValues(Observation{}),ntpValues(Observation{}),err)
        if s.Timezone.AutoFix{r.State.Report.Timezone=newResult(s,r.Now(),"skipped","invalid_settings",zoneValues(Observation{}),zoneValues(Observation{}),err)}
        return r.Save(*r.State)
    }
    if s.EnforceNTP{if e:=r.runKind(ctx,s,false,force);e!=nil{return e}}
    if s.Timezone.AutoFix{if e:=r.runKind(ctx,s,true,force);e!=nil{return e}}
    return nil
}
func(r *Reconciler)runKind(ctx context.Context,s Settings,zone,force bool)error{
    gate:=&r.State.NTPGate;slot:=&r.State.Report.NTP;values:=ntpValues
    if zone{gate=&r.State.TimezoneGate;slot=&r.State.Report.Timezone;values=zoneValues}
    if gate.Fingerprint!=s.Fingerprint{*gate=AttemptGate{Fingerprint:s.Fingerprint}}
    now:=r.Now();if !force && now.Before(gate.Next){return nil}
    // Reserve conservatively as a failure before any mutation, including across crashes.
    gate.Failures++;gate.Next=now.Add(gateDelay(gate.Failures))
    if e:=r.Save(*r.State);e!=nil{return fmt.Errorf("reserve time policy attempt: %w",e)}
    before,readErr:=r.Read(ctx)
    outcome,reason:="ok","already_compliant"
    var opErr error
    if readErr!=nil{outcome,reason,opErr="failed","exec_failed",readErr
    }else if !knownRole(before.Domain.Role){outcome,reason="skipped","role_unknown"
    }else if before.Config.PolicyManaged{outcome,reason="skipped","conflict_gpo"
    }else if zone{
        switch{
        case s.Timezone.ExpectedWindowsID==nil:outcome,reason="skipped","no_expected_timezone"
        case before.Timezone.AutoUpdate=="on":outcome,reason="skipped","auto_timezone_on"
        default:
            id:=*s.Timezone.ExpectedWindowsID
            if e:=r.Writer.ZoneExists(id);e!=nil{outcome,reason,opErr="skipped","invalid_settings",e
            }else if !value(before.Timezone.WindowsID,id){
                reason="applied";opErr=r.guarded(ctx,before.Domain.Role,true,func()error{return r.Writer.Timezone(ctx,id)})
            }
        }
    }else if !matchesNTP(before,s){reason="applied";opErr=r.applyNTP(ctx,before,s)}
    if opErr!=nil && reason=="applied"{
        var stop *guardStop
        if errors.As(opErr,&stop){outcome,reason="skipped",stop.reason}else{outcome,reason="failed","exec_failed"}
    }
    after:=before
    // Do not lose partial writes in before/after if a later command or guard fails.
    if readErr==nil{
        var e error;after,e=r.Read(ctx)
        if e!=nil{after=Observation{};outcome,reason,opErr="failed","exec_failed",errors.Join(opErr,e)}
    }
    if outcome=="ok"{
        same:=matchesNTP(after,s)
        if zone{same=s.Timezone.ExpectedWindowsID!=nil && value(after.Timezone.WindowsID,*s.Timezone.ExpectedWindowsID)}
        if !same{outcome,reason="failed","readback_mismatch"}
    }
    if outcome!="failed"{gate.Failures=0;gate.Next=now.Add(time.Hour)}
    *slot=newResult(s,now,outcome,reason,values(before),values(after),opErr)
    return r.Save(*r.State)
}
type guardStop struct{reason string}
func(e *guardStop)Error()string{return e.reason}
func(r *Reconciler)guarded(ctx context.Context,role string,zone bool,write func()error)error{
    if e:=ctx.Err();e!=nil{return e}
    fresh,e:=r.Read(ctx);if e!=nil{return e}
    if !knownRole(fresh.Domain.Role)||fresh.Domain.Role!=role{return &guardStop{"role_unknown"}}
    if fresh.Config.PolicyManaged{return &guardStop{"conflict_gpo"}}
    if zone && fresh.Timezone.AutoUpdate=="on"{return &guardStop{"auto_timezone_on"}}
    return write()
}
// resyncDiagnostic keeps a non-zero resync in Error without failing a verified apply.
type resyncDiagnostic struct{err error}
func(e *resyncDiagnostic)Error()string{return "resync after apply: "+e.err.Error()}
func(r *Reconciler)applyNTP(ctx context.Context,before Observation,s Settings)error{
    role:=before.Domain.Role
    guarded:=func(fn func()error)error{return r.guarded(ctx,role,false,fn)}
    if manualRole(role){
        if e:=guarded(func()error{return r.Writer.Manual(ctx,s.NTPServers,role=="forest_root_pdc_emulator")});e!=nil{return e}
        if e:=guarded(func()error{return r.Writer.Poll(ctx,s.PollIntervalMinutes*60)});e!=nil{return e}
        if e:=guarded(func()error{return r.Writer.Update(ctx)});e!=nil{return e}
    }else if e:=guarded(func()error{return r.Writer.Hierarchy(ctx)});e!=nil{return e}
    if e:=guarded(func()error{return r.Writer.Automatic(ctx)});e!=nil{return e}
    fresh,e:=r.Read(ctx);if e!=nil{return e}
    if fresh.Config.ServiceState!="running"{
        if e=guarded(func()error{return r.Writer.Start(ctx)});e!=nil{return e}
    }
    var resyncErr error
    e=guarded(func()error{_,resyncErr=r.Writer.Resync(ctx);return nil})
    if e!=nil{return e}
    if resyncErr!=nil{return &resyncDiagnostic{resyncErr}}
    return nil
}
```

The nonfatal resync distinction needs one exact replacement inside the newly created `runKind`, before `var stop *guardStop`:

```go
    if opErr!=nil && reason=="applied"{
        var diagnostic *resyncDiagnostic
        var stop *guardStop
        if errors.As(opErr,&diagnostic){
            // Read-back below still decides whether configuration applied successfully.
        }else if errors.As(opErr,&stop){outcome,reason="skipped",stop.reason}else{outcome,reason="failed","exec_failed"}
    }
```

This replaces the entire initial `if opErr!=nil && reason=="applied"` block above; no second error block remains.

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected PASS for the full role × GPO × outcome matrix, exact write order, all six pre-write guard positions, the shared invalid-host fixture and time gates.
- [ ] Run `cd agent && GOOS=windows go vet ./internal/collectors/timesync/...`; expected PASS.
- [ ] Commit:

```sh
git add agent/internal/collectors/timesync/reconcile.go agent/internal/collectors/timesync/reconcile_test.go
git commit -m 'feat(timesync): reconcile role-aware policy with durable attempt gates' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 4: Persist management state and serialize collection, commands and uploads

**Files:**
- Create: `agent/internal/collectors/timesync/management_store.go`, `management.go`, `management_commands.go`
- Test: `agent/internal/collectors/timesync/management_test.go`
- Consume: index §H `New(stateDir string, sys System) *Collector`, `Collect(ctx context.Context) (*Snapshot,error)`; verified persistence template `agent/internal/collectors/hwhealth/persist.go:50–89`.

**Interfaces:**
- Produces: `NewManagement(dir string, sys System, w Writer, send func(context.Context,any) error) (*Manager,error)`.
- Produces: `Manager.Apply(raw any) (bool,error)`, `Manager.Cycle(context.Context) error`, `Manager.Command(context.Context,string,map[string]any) (any,error)`.
- Produces §F.4 `ResyncResult` and `SetTimezoneResult` with nullable pointer fields; `time_apply_policy` returns `ManagementReport`.
- Consumes only the **specified** Collector signature, not invented `System.ReadConfig`/`System.ReadDomain` methods. Each guard collection is merged into the pending event buffer, preserving events drained by guard reads and the most recent persisted sequence.

- [ ] Write `management_test.go`:

```go
package timesync

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "os"
    "path/filepath"
    "sync"
    "testing"
    "time"
)
func managementFixture(t *testing.T,dir string,f *fakeTimeSystem,send func(context.Context,any)error)*Manager{
    t.Helper();var sequence uint64
    collect:=func(ctx context.Context)(*Snapshot,error){
        o,e:=f.read(ctx);if e!=nil{return nil,e};sequence++
        b,e:=json.Marshal(o);if e!=nil{return nil,e}
        var m map[string]any;if e=json.Unmarshal(b,&m);e!=nil{return nil,e}
        m["schemaVersion"]=1;m["sequence"]=sequence;m["collectedAt"]=time.Now().UTC().Format(time.RFC3339Nano)
        m["events"]=[]any{map[string]any{"recordId":sequence,"eventId":37,"level":4,"occurredAt":time.Now().UTC().Format(time.RFC3339Nano),"message":"event","properties":[]string{}}}
        m["enforcement"]=nil;b,e=json.Marshal(m);if e!=nil{return nil,e}
        var s Snapshot;if e=json.Unmarshal(b,&s);e!=nil{return nil,e};return &s,nil
    }
    manager,e:=newManagement(dir,collect,f,send)
    if e!=nil{t.Fatal(e)};return manager
}
func TestManagementRestartPersistsSettingsGatesAndResults(t *testing.T){
    dir:=t.TempDir();f:=newFakeTimeSystem("workgroup");sends:=0
    m:=managementFixture(t,dir,f,func(context.Context,any)error{sends++;return nil})
    s:=settingsFixture();if changed,e:=m.Apply(rawSettings(t,s));e!=nil||!changed{t.Fatal(changed,e)}
    if e:=m.Cycle(context.Background());e!=nil{t.Fatal(e)}
    id,calls:=m.state.Report.NTP.ResultID,len(f.calls)
    n:=managementFixture(t,dir,f,func(context.Context,any)error{return nil})
    if n.state.Settings.Fingerprint!=s.Fingerprint||n.state.Report.NTP.ResultID!=id{t.Fatal(n.state)}
    if e:=n.Cycle(context.Background());e!=nil{t.Fatal(e)}
    if len(f.calls)!=calls||n.state.Report.NTP.ResultID!=id{t.Fatal("restart reset gate")}
    s.EnforceNTP=false;s.NTPServers=[]string{};s.Fingerprint="sha256:"+fmt.Sprintf("%064x",2)
    if _,e:=n.Apply(rawSettings(t,s));e!=nil{t.Fatal(e)}
    if e:=n.Cycle(context.Background());e!=nil{t.Fatal(e)}
    if len(f.calls)!=calls||n.state.Report.NTP.ResultID!=id{t.Fatal("disable reverted or lost report")}
    if sends!=1{t.Fatal(sends)}
    if _,e:=os.Stat(filepath.Join(dir,"timesync-state.json"));!os.IsNotExist(e){t.Fatal("management test overwrote sequence state")}
}
func TestManagementInvalidDeliveryReportsWithoutExecutingOldPolicy(t *testing.T){
    f:=newFakeTimeSystem("workgroup");m:=managementFixture(t,t.TempDir(),f,func(context.Context,any)error{return nil})
    if _,e:=m.Apply(rawSettings(t,settingsFixture()));e!=nil{t.Fatal(e)}
    bad:=settingsFixture();bad.NTPServers=[]string{"a;bad"}
    if changed,e:=m.Apply(rawSettings(t,bad));e==nil||!changed{t.Fatal(changed,e)}
    if e:=m.Cycle(context.Background());e!=nil{t.Fatal(e)}
    if len(f.calls)!=0||m.state.Report.NTP.Reason!="invalid_settings"{t.Fatal(f.calls,m.state.Report)}
}
func TestManagementEventsAndFailedUploadRetainReport(t *testing.T){
    f:=newFakeTimeSystem("workgroup");attempt:=0;var bodies []map[string]json.RawMessage
    m:=managementFixture(t,t.TempDir(),f,func(_ context.Context,p any)error{
        b,e:=json.Marshal(p);if e!=nil{return e};var body map[string]json.RawMessage
        if e=json.Unmarshal(b,&body);e!=nil{return e};bodies=append(bodies,body);attempt++
        if attempt==1{return errors.New("offline")};return nil
    })
    if _,e:=m.Apply(rawSettings(t,settingsFixture()));e!=nil{t.Fatal(e)}
    if e:=m.Cycle(context.Background());e==nil{t.Fatal("upload error hidden")}
    id:=m.state.Report.NTP.ResultID
    if e:=m.Cycle(context.Background());e!=nil{t.Fatal(e)}
    if m.state.Report.NTP.ResultID!=id{t.Fatal("retry created new audit result")}
    for _,b:=range bodies{var events []any;if e:=json.Unmarshal(b["events"],&events);e!=nil{t.Fatal(e)}
        if len(events)<6{t.Fatal("guard reads discarded events",len(events))}
        var report ManagementReport;if e:=json.Unmarshal(b["enforcement"],&report);e!=nil{t.Fatal(e)}
        if report.NTP.ResultID!=id{t.Fatal(report)}
    }
}
func TestManagementCommandContracts(t *testing.T){
    for _,kind:=range []string{"time_resync","time_set_timezone","time_apply_policy"}{
        t.Run(kind,func(t *testing.T){f:=newFakeTimeSystem("workgroup");sent:=0
            m:=managementFixture(t,t.TempDir(),f,func(context.Context,any)error{sent++;return nil})
            if _,e:=m.Apply(rawSettings(t,settingsFixture()));e!=nil{t.Fatal(e)}
            payload:=map[string]any{};if kind=="time_set_timezone"{payload["windowsId"]="Eastern Standard Time"}
            result,e:=m.Command(context.Background(),kind,payload);if e!=nil{t.Fatal(e)}
            if sent!=1{t.Fatal("command did not send snapshot")}
            b,e:=json.Marshal(result);if e!=nil{t.Fatal(e)};var obj map[string]any
            if e=json.Unmarshal(b,&obj);e!=nil{t.Fatal(e)}
            switch kind{case "time_resync":if len(obj)!=4||obj["exitCode"]!=float64(0){t.Fatal(obj)}
            case "time_set_timezone":if len(obj)!=3||obj["after"]!="Eastern Standard Time"{t.Fatal(obj)}
            case "time_apply_policy":if len(obj)!=2||obj["ntp"]==nil{t.Fatal(obj)}}
        })
    }
}
func TestManagementCommandFailureAndForcedApply(t *testing.T){
    f:=newFakeTimeSystem("workgroup");sent:=0;m:=managementFixture(t,t.TempDir(),f,func(context.Context,any)error{sent++;return nil})
    if _,e:=m.Apply(rawSettings(t,settingsFixture()));e!=nil{t.Fatal(e)}
    if e:=m.Cycle(context.Background());e!=nil{t.Fatal(e)}
    id:=m.state.Report.NTP.ResultID
    if _,e:=m.Command(context.Background(),"time_apply_policy",map[string]any{});e!=nil{t.Fatal(e)}
    if id==m.state.Report.NTP.ResultID{t.Fatal("command did not force reconciliation")}
    beforeCalls:=len(f.calls)
    if _,e:=m.Command(context.Background(),"time_set_timezone",map[string]any{"windowsId":`..\UTC`});e==nil{t.Fatal("invalid timezone")}
    if len(f.calls)!=beforeCalls{t.Fatal("invalid timezone executed")}
    f.fail="resync"
    result,e:=m.Command(context.Background(),"time_resync",map[string]any{})
    if e==nil||result.(ResyncResult).ExitCode!=5||result.(ResyncResult).Error==nil{t.Fatal(result,e)}
    if sent!=4{t.Fatal(sent)}
}
func TestManagementSerializationAndStoreFailures(t *testing.T){
    f:=newFakeTimeSystem("workgroup");m:=managementFixture(t,t.TempDir(),f,func(context.Context,any)error{return nil})
    if _,e:=m.Apply(rawSettings(t,settingsFixture()));e!=nil{t.Fatal(e)}
    var wg sync.WaitGroup
    for i:=0;i<12;i++{wg.Add(1);go func(){defer wg.Done();if e:=m.Cycle(context.Background());e!=nil{t.Error(e)}}()};wg.Wait()
    if len(f.calls)!=6{t.Fatal("overlapping cycle wrote twice",f.calls)}
    m.save=func(ManagementState)error{return errors.New("read-only state directory")}
    if _,e:=m.Command(context.Background(),"time_apply_policy",map[string]any{});e==nil{t.Fatal("reservation error hidden")}
    if len(f.calls)!=6{t.Fatal("write occurred after failed reservation")}
}
func TestManagementCorruptStateFailsClosed(t *testing.T){
    dir:=t.TempDir();if e:=os.WriteFile(filepath.Join(dir,"timesync-management.json"),[]byte("{"),0600);e!=nil{t.Fatal(e)}
    m,e:=newManagement(dir,func(context.Context)(*Snapshot,error){return nil,nil},nil,func(context.Context,any)error{return nil})
    if e==nil||m==nil||m.state.Settings!=nil{t.Fatal(m,e)}
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected FAIL: `undefined: Manager`.
- [ ] Create `management_store.go`:

```go
package timesync

import (
    "encoding/json"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "time"
)
const managementFile="timesync-management.json"
const managementLimit=1024*1024
func loadManagement(path string)(ManagementState,error){
    s:=ManagementState{Version:1}
    f,e:=os.Open(path);if os.IsNotExist(e){return s,nil};if e!=nil{return s,e};defer f.Close()
    b,e:=io.ReadAll(io.LimitReader(f,managementLimit+1));if e!=nil{return s,e}
    if len(b)>managementLimit{return s,fmt.Errorf("management state exceeds 1 MiB")}
    if e=json.Unmarshal(b,&s);e!=nil{return ManagementState{Version:1},e}
    if s.Version!=1{return ManagementState{Version:1},fmt.Errorf("unsupported management state version")}
    if s.Settings!=nil{if e=ValidateSettings(*s.Settings);e!=nil{return ManagementState{Version:1},e}}
    return s,nil
}
func saveManagement(path string,s ManagementState)error{
    b,e:=json.Marshal(s);if e!=nil{return e};if len(b)>managementLimit{return fmt.Errorf("management state exceeds 1 MiB")}
    if e=os.MkdirAll(filepath.Dir(path),0700);e!=nil{return e}
    f,e:=os.CreateTemp(filepath.Dir(path),"timesync-management-*.tmp");if e!=nil{return e}
    name:=f.Name();defer os.Remove(name)
    if e=f.Chmod(0600);e!=nil{_ = f.Close();return e}
    if _,e=f.Write(b);e!=nil{_ = f.Close();return e}
    if e=f.Sync();e!=nil{_ = f.Close();return e};if e=f.Close();e!=nil{return e}
    for attempt:=0;attempt<4;attempt++{
        if attempt>0{time.Sleep(25*time.Millisecond<<uint(attempt-1))}
        if e=os.Rename(name,path);e==nil{return nil}
    }
    return fmt.Errorf("replace management state after 4 attempts: %w",e)
}
```

- [ ] Create `management.go`:

```go
package timesync

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "path/filepath"
    "reflect"
    "sort"
    "time"
)

type Manager struct {
    gate chan struct{}
    collect func(context.Context)(*Snapshot,error)
    acknowledge func(uint64)error
    writer Writer
    send func(context.Context,any)error
    now func()time.Time
    save func(ManagementState)error
    state ManagementState
    raw map[string]json.RawMessage
    events map[uint64]json.RawMessage
    skipOnce bool
    blocked error
}
func NewManagement(dir string,sys System,w Writer,send func(context.Context,any)error)(*Manager,error){
    c:=New(dir,sys)
    m,err:=newManagement(dir,c.Collect,w,send)
    // The W01b draft caches a pending snapshot until acknowledgement; index H omitted this.
    if a,ok:=any(c).(interface{Acknowledge(uint64)error});ok{m.acknowledge=a.Acknowledge}
    return m,err
}
func newManagement(dir string,collect func(context.Context)(*Snapshot,error),w Writer,send func(context.Context,any)error)(*Manager,error){
    path:=filepath.Join(dir,managementFile);s,e:=loadManagement(path)
    events:=s.PendingEvents;if events==nil{events=map[uint64]json.RawMessage{}}
    return &Manager{gate:make(chan struct{},1),collect:collect,writer:w,send:send,now:time.Now,state:s,
        events:events,save:func(s ManagementState)error{return saveManagement(path,s)}},e
}
func(m *Manager)lock(ctx context.Context)error{
    if e:=ctx.Err();e!=nil{return e}
    select{case m.gate<-struct{}{}:return nil;case <-ctx.Done():return ctx.Err()}
}
func(m *Manager)unlock(){<-m.gate}
func(m *Manager)Apply(raw any)(bool,error){
    _ = m.lock(context.Background());defer m.unlock()
    s,e:=ParseSettings(raw)
    if e==nil && m.state.Settings!=nil && m.state.Settings.Fingerprint==s.Fingerprint && !reflect.DeepEqual(*m.state.Settings,s){
        e=fmt.Errorf("settings changed without a new fingerprint")
    }
    if e!=nil{
        next:=m.state
        next.Report.NTP=newResult(s,m.now(),"skipped","invalid_settings",ntpValues(Observation{}),ntpValues(Observation{}),e)
        if s.Timezone.AutoFix{next.Report.Timezone=newResult(s,m.now(),"skipped","invalid_settings",zoneValues(Observation{}),zoneValues(Observation{}),e)}
        // Keep last valid settings, but upload this rejection before reconciling them again.
        m.state=next;m.skipOnce=true
        return true,errors.Join(e,m.save(next))
    }
    if m.state.Settings!=nil && reflect.DeepEqual(*m.state.Settings,s) && m.blocked==nil{return false,nil}
    next:=m.state;next.Settings=&s
    if e=m.save(next);e!=nil{m.blocked=e;return false,e}
    m.state=next;m.skipOnce=false;m.blocked=nil;return true,nil
}
func(m *Manager)read(ctx context.Context)(Observation,error){
    var o Observation
    s,e:=m.collect(ctx);if e!=nil{return o,e};if s==nil{return o,fmt.Errorf("time collection unavailable")}
    b,e:=json.Marshal(s);if e!=nil{return o,e}
    if e=json.Unmarshal(b,&o);e!=nil{return o,e}
    var raw map[string]json.RawMessage;if e=json.Unmarshal(b,&raw);e!=nil{return o,e}
    var events []json.RawMessage;if e=json.Unmarshal(raw["events"],&events);e!=nil{return o,e}
    for _,event:=range events{var key struct{RecordID uint64 `json:"recordId"`}
        if e=json.Unmarshal(event,&key);e!=nil{return o,e};m.events[key.RecordID]=event}
    m.raw=raw
    if _,e=m.boundedEvents();e!=nil{return o,e}
    m.state.PendingEvents=m.events
    // Transfer event ownership durably before releasing the collector's pending snapshot.
    if e=m.save(m.state);e!=nil{return o,e}
    if m.acknowledge!=nil{
        var sequence uint64;if e=json.Unmarshal(raw["sequence"],&sequence);e!=nil{return o,e}
        if e=m.acknowledge(sequence);e!=nil{return o,e}
    }
    return o,nil
}
func(m *Manager)reconciler()*Reconciler{return &Reconciler{Read:m.read,Writer:m.writer,Now:m.now,Save:m.save,State:&m.state}}
func(m *Manager)boundedEvents()([]json.RawMessage,error){
    type eventEntry struct{raw json.RawMessage;at time.Time;id uint64}
    entries:=make([]eventEntry,0,len(m.events))
    for id,raw:=range m.events{var e struct{OccurredAt string `json:"occurredAt"`}
        if err:=json.Unmarshal(raw,&e);err!=nil{return nil,err}
        at,err:=time.Parse(time.RFC3339Nano,e.OccurredAt);if err!=nil{return nil,err}
        entries=append(entries,eventEntry{raw,at,id})}
    sort.Slice(entries,func(i,j int)bool{if entries[i].at.Equal(entries[j].at){return entries[i].id>entries[j].id};return entries[i].at.After(entries[j].at)})
    if len(entries)>100{entries=entries[:100]}
    events:=make([]json.RawMessage,0,len(entries));retained:=map[uint64]json.RawMessage{}
    bytes:=2
    for _,e:=range entries{
        if bytes+len(e.raw)+1>480*1024{break}
        bytes+=len(e.raw)+1;events=append(events,e.raw);retained[e.id]=e.raw
    }
    m.events=retained;return events,nil
}
func(m *Manager)upload(ctx context.Context)error{
    if _,e:=m.read(ctx);e!=nil{return e}
    events,e:=m.boundedEvents();if e!=nil{return e}
    b,e:=json.Marshal(events);if e!=nil{return e};m.raw["events"]=b
    b,e=json.Marshal(m.state.Report);if e!=nil{return e};m.raw["enforcement"]=b
    if e=m.send(ctx,m.raw);e!=nil{return e}
    next:=m.state;next.PendingEvents=map[uint64]json.RawMessage{}
    if e=m.save(next);e!=nil{return e}
    m.state=next;m.events=next.PendingEvents;return nil
}
func(m *Manager)Cycle(ctx context.Context)error{
    if e:=m.lock(ctx);e!=nil{return e};defer m.unlock()
    if e:=ctx.Err();e!=nil{return e}
    if m.writer==nil{return nil}
    if m.blocked!=nil{return errors.Join(m.blocked,m.upload(ctx))}
    // Flush any previous failed result persistence before considering another mutation.
    if e:=m.save(m.state);e!=nil{return e}
    var e error
    if m.skipOnce{m.skipOnce=false}else{e=m.reconciler().Run(ctx,false)}
    return errors.Join(e,m.upload(ctx))
}
```

`read` uses the same Collector instance for every read, so sequences never go backwards. Event buffering compensates for full collections performed for guards. Guard events are durably transferred into management state before acknowledging a cached collector snapshot. A failed upload or restart retains them, within the same newest-event/size limits as the wire; latest enforcement results and gates are durable before upload. Do not instantiate a second collector for guard reads.

- [ ] Create `management_commands.go`:

```go
package timesync

import (
    "context"
    "errors"
    "fmt"
)

type ResyncResult struct {
    ExitCode int `json:"exitCode"`
    Before *string `json:"lastSuccessfulSyncAtBefore"`
    After *string `json:"lastSuccessfulSyncAtAfter"`
    Error *string `json:"error"`
}
type SetTimezoneResult struct {
    Before *string `json:"before"`
    After *string `json:"after"`
    Error *string `json:"error"`
}
func(m *Manager)Command(ctx context.Context,kind string,payload map[string]any)(any,error){
    if e:=m.lock(ctx);e!=nil{return nil,e};defer m.unlock()
    if m.writer==nil{return nil,fmt.Errorf("time management unsupported on this OS")}
    var result any
    var actionErr error
    switch kind{
    case "time_resync":result,actionErr=m.resync(ctx,payload)
    case "time_set_timezone":result,actionErr=m.setTimezone(ctx,payload)
    case "time_apply_policy":
        if len(payload)!=0{actionErr=fmt.Errorf("time_apply_policy payload must be empty")
        }else if m.blocked!=nil{actionErr=m.blocked
        }else if actionErr=m.save(m.state);actionErr==nil{actionErr=m.reconciler().Run(ctx,true)}
        result=m.state.Report
        if actionErr==nil && m.state.Settings!=nil{
            s:=m.state.Settings
            for _,kind:=range []struct{enabled bool;result *EnforcementResult}{
                {s.EnforceNTP,m.state.Report.NTP},{s.Timezone.AutoFix,m.state.Report.Timezone},
            }{
                r:=kind.result
                if kind.enabled && r!=nil && r.Fingerprint==s.Fingerprint && r.Outcome=="failed"{
                    actionErr=errors.Join(actionErr,fmt.Errorf("%s",r.Reason))
                }
            }
        }
    default:actionErr=fmt.Errorf("unknown time command")
    }
    // Even validation failures request a fresh snapshot; do not reconcile during manual commands.
    uploadErr:=m.upload(ctx)
    return result,errors.Join(actionErr,uploadErr)
}
func(m *Manager)resync(ctx context.Context,payload map[string]any)(ResyncResult,error){
    out:=ResyncResult{ExitCode:1}
    before,e:=m.read(ctx);out.Before=before.Status.LastSuccessfulSyncAt
    if e==nil && len(payload)!=0{e=fmt.Errorf("time_resync payload must be empty")}
    r:=m.reconciler()
    if e==nil && before.Config.ServiceState!="running"{e=r.guarded(ctx,before.Domain.Role,false,func()error{return m.writer.Start(ctx)})}
    if e==nil{e=r.guarded(ctx,before.Domain.Role,false,func()error{var x error;out.ExitCode,x=m.writer.Resync(ctx);return x})}
    after,readErr:=m.read(ctx);out.After=after.Status.LastSuccessfulSyncAt
    e=errors.Join(e,readErr);if e!=nil && out.ExitCode==0{out.ExitCode=1};out.Error=errorText(e)
    return out,e
}
func(m *Manager)setTimezone(ctx context.Context,payload map[string]any)(SetTimezoneResult,error){
    out:=SetTimezoneResult{}
    before,e:=m.read(ctx);out.Before=before.Timezone.WindowsID
    id,ok:=payload["windowsId"].(string)
    if e==nil && (!ok||len(payload)!=1){e=fmt.Errorf("time_set_timezone requires only windowsId")}
    if e==nil{e=m.writer.ZoneExists(id)}
    if e==nil{e=m.reconciler().guarded(ctx,before.Domain.Role,true,func()error{return m.writer.Timezone(ctx,id)})}
    after,readErr:=m.read(ctx);out.After=after.Timezone.WindowsID;e=errors.Join(e,readErr)
    if e==nil && !value(after.Timezone.WindowsID,id){e=fmt.Errorf("timezone readback_mismatch")}
    out.Error=errorText(e);return out,e
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected PASS; test filesystem writes are confined to `t.TempDir`, and no test makes network calls.
- [ ] Run `cd agent && GOOS=windows go vet ./internal/collectors/timesync/...` and `cd agent && GOOS=windows go test -c -o /tmp/breeze-timesync.test.exe ./internal/collectors/timesync`; expected PASS.
- [ ] Commit:

```sh
git add agent/internal/collectors/timesync/management_store.go agent/internal/collectors/timesync/management.go agent/internal/collectors/timesync/management_commands.go agent/internal/collectors/timesync/management_test.go
git commit -m 'feat(timesync): persist management state and command readback' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 5: Wire settings above the early return and share one cancellable scheduler

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go:456,1004,1845,2052,2154,2175,2341–2344,3194`.
- Modify dependency file: `agent/internal/heartbeat/time_sync.go` (index §H; absent in inspected checkout, complete proposed body below).
- Test: `agent/internal/heartbeat/time_sync_test.go`.
- Existing APIs: `config.GetDataDir()` at `agent/internal/config/config.go:1160`; `collectors.Guard` at `agent/internal/collectors/safe.go:124`; `sendInventoryData` at `heartbeat.go:2328`; hardware lifecycle template at `hardware_health.go:72–115,179–187`.

**Interfaces:**
- Produces: `Heartbeat.applyTimeSyncSettings(raw any)`, `initTimeSync()`, `startTimeSync()`, `stopTimeSync()`, `timeSyncTickLocked(now time.Time)`.
- Consumes Manager methods from Task 4 through `timeSyncManager` to permit fake heartbeat tests.
- Produces `timeSyncUpload.MarshalJSON() ([]byte,error)`; retains the snapshot's exact JSON while supplying the upload's parent context internally.

The actual policy-probe early return is **`heartbeat.go:3204–3206`**, not 3182. The settings block belongs before `registryRaw` at **3194**, alongside the existing warranty/hardware dispatch. `handlers.go` does not need editing for init registration.

- [ ] Write `time_sync_test.go`:

```go
package heartbeat

import (
    "context"
    "errors"
    "sync"
    "testing"
    "time"

    "github.com/breeze-rmm/agent/internal/config"
)

type fakeTimeManager struct {
    mu sync.Mutex
    applied []any
    cycles int
    commands []string
    payload map[string]any
    result any
    err error
    cycle func(context.Context)error
}
func(f *fakeTimeManager)Apply(raw any)(bool,error){f.mu.Lock();defer f.mu.Unlock();f.applied=append(f.applied,raw);return true,f.err}
func(f *fakeTimeManager)Cycle(ctx context.Context)error{
    f.mu.Lock();f.cycles++;fn:=f.cycle;f.mu.Unlock();if fn!=nil{return fn(ctx)};return nil
}
func(f *fakeTimeManager)Command(_ context.Context,kind string,p map[string]any)(any,error){
    f.mu.Lock();defer f.mu.Unlock();f.commands=append(f.commands,kind);f.payload=p;return f.result,f.err
}
func newTimeHeartbeat(f *fakeTimeManager)*Heartbeat{
    ctx,cancel:=context.WithCancel(context.Background())
    return &Heartbeat{config:&config.Config{AgentID:"fixture-agent"},timeSync:&timeSyncRuntime{
        manager:f,ctx:ctx,cancel:cancel,wake:make(chan struct{},1)}}
}
func TestTimeSettingsDispatchBeforeProbeReturn(t *testing.T){
    for _,key:=range []string{"time_sync_settings","timeSyncSettings"}{
        f:=&fakeTimeManager{};h:=newTimeHeartbeat(f)
        // No policy_registry_state_probes or policy_config_state_probes keys.
        h.applyConfigUpdate(map[string]any{key:map[string]any{"fingerprint":"fixture"}})
        if !h.timeSync.hasPending || len(h.timeSync.wake)!=1{t.Fatalf("%s dispatch lost",key)}
        h.applyConfigUpdate(map[string]any{"unrelated":true})
        if !h.timeSync.hasPending{t.Fatal("omitted settings cleared policy")}
        if len(f.applied)!=0{t.Fatal("heartbeat response blocked on management execution")}
        h.stopTimeSync()
    }
}
func TestTimeSettingsImmediateCycleAndCancellation(t *testing.T){
    entered:=make(chan struct{});f:=&fakeTimeManager{cycle:func(ctx context.Context)error{close(entered);<-ctx.Done();return ctx.Err()}}
    h:=newTimeHeartbeat(f);h.startTimeSync()
    h.applyTimeSyncSettings(map[string]any{"fingerprint":"fixture"})
    select{case <-entered:case <-time.After(time.Second):t.Fatal("settings did not trigger immediate collection")}
    h.stopTimeSync();done:=make(chan struct{});go func(){h.inventoryWg.Wait();close(done)}()
    select{case <-done:case <-time.After(time.Second):t.Fatal("time collection not cancelled/tracked")}
    h.applyTimeSyncSettings(map[string]any{})
    if len(f.applied)!=1 || h.timeSync.hasPending{t.Fatal("settings accepted after shutdown")}
}
func TestTimeCadenceAndNoDuplicateStart(t *testing.T){
    for i:=0;i<100;i++{id:=string(rune(i));d:=timeSyncFirstDelay(id)
        if d<2*time.Minute||d>5*time.Minute{t.Fatal(d)}
        d=timeSyncInterval(id,time.Unix(int64(i),0))
        if d<27*time.Minute||d>33*time.Minute{t.Fatal(d)}
    }
    f:=&fakeTimeManager{};h:=newTimeHeartbeat(f)
    now:=time.Now();h.mu.Lock();h.timeSync.started=true;h.timeSync.lastTimeSyncUpdate=now
    h.timeSyncTickLocked(now.Add(26*time.Minute));if len(h.timeSync.wake)!=0{t.Fatal("early tick")}
    h.timeSyncTickLocked(now.Add(34*time.Minute));if len(h.timeSync.wake)!=1{t.Fatal("due tick lost")}
    h.timeSyncTickLocked(now.Add(34*time.Minute));if len(h.timeSync.wake)!=1{t.Fatal("duplicate tick")}
    h.mu.Unlock();h.stopTimeSync()
}
func TestInvalidTimeSettingsStillWakeSnapshot(t *testing.T){
    f:=&fakeTimeManager{err:errors.New("invalid_settings")};h:=newTimeHeartbeat(f)
    h.applyTimeSyncSettings(map[string]any{"ntp_servers":[]string{"bad;host"}})
    if len(h.timeSync.wake)!=1{t.Fatal("rejection was not scheduled for reporting")};h.stopTimeSync()
}
```

- [ ] Run `cd agent && go test -race ./internal/heartbeat/...`; expected FAIL: unknown `timeSync` field / `timeSyncRuntime` before production code.
- [ ] Replace the dependency's `time_sync.go` with this complete body **after resolving the missing-baseline issue**. This is the W03b extension of the index's existing scheduler, not a second collector:

```go
package heartbeat

import (
    "context"
    "encoding/json"
    "hash/fnv"
    "strconv"
    "time"

    "github.com/breeze-rmm/agent/internal/collectors"
    "github.com/breeze-rmm/agent/internal/collectors/timesync"
    "github.com/breeze-rmm/agent/internal/config"
    "github.com/breeze-rmm/agent/internal/observability"
)

type timeSyncManager interface {
    Apply(any)(bool,error)
    Cycle(context.Context)error
    Command(context.Context,string,map[string]any)(any,error)
}
type timeSyncRuntime struct {
    manager timeSyncManager
    ctx context.Context
    cancel context.CancelFunc
    wake chan struct{}
    started bool // All scheduler fields below are protected by Heartbeat.mu.
    stopping bool
    lastTimeSyncUpdate time.Time
    pending any
    hasPending bool
}
type timeSyncUpload struct{ctx context.Context;data any}
func(p timeSyncUpload)MarshalJSON()([]byte,error){return json.Marshal(p.data)}
func timeSyncHash(s string)uint64{h:=fnv.New64a();_,_=h.Write([]byte(s));return h.Sum64()}
func timeSyncFirstDelay(id string)time.Duration{return 2*time.Minute+time.Duration(timeSyncHash(id)%180001)*time.Millisecond}
func timeSyncInterval(id string,last time.Time)time.Duration{
    offset:=int64(timeSyncHash(id+":"+strconv.FormatInt(last.UnixNano(),10))%20001)-10000
    return 30*time.Minute+time.Duration(int64(30*time.Minute)*offset/100000)
}
func(h *Heartbeat)initTimeSync(){
    sys:=timesync.NewSystem();writer:=timesync.NewWriter()
    if sys==nil || writer==nil{return}
    ctx,cancel:=context.WithCancel(context.Background())
    manager,err:=timesync.NewManagement(config.GetDataDir(),sys,writer,func(ctx context.Context,p any)error{
        return h.sendInventoryData("time-status",timeSyncUpload{ctx:ctx,data:p},"time sync")
    })
    if err!=nil{log.Warn("time management state rejected; enforcement disabled until valid delivery","error",err)}
    h.timeSync=&timeSyncRuntime{manager:manager,ctx:ctx,cancel:cancel,wake:make(chan struct{},1)}
}
func(h *Heartbeat)wakeTimeSyncLocked(){
    if h.timeSync==nil||h.timeSync.stopping{return}
    select{case h.timeSync.wake<-struct{}{}:default:}
}
func(h *Heartbeat)applyTimeSyncSettings(raw any){
    // Detach the payload from the heartbeat response before handing it to the worker.
    b,err:=json.Marshal(raw)
    var copy any
    if err==nil{err=json.Unmarshal(b,&copy)}
    if err!=nil{copy=nil} // Parser records invalid_settings, without an OS write.
    h.mu.Lock();defer h.mu.Unlock();r:=h.timeSync
    if r==nil||r.stopping{return}
    r.pending=copy;r.hasPending=true
    h.wakeTimeSyncLocked()
}
func(h *Heartbeat)timeSyncTickLocked(now time.Time){
    r:=h.timeSync
    if r==nil||!r.started||r.stopping||r.lastTimeSyncUpdate.IsZero(){return}
    if now.Before(r.lastTimeSyncUpdate.Add(timeSyncInterval(h.config.AgentID,r.lastTimeSyncUpdate))){return}
    h.wakeTimeSyncLocked()
}
func(h *Heartbeat)startTimeSync(){
    h.mu.Lock();r:=h.timeSync
    if r==nil||r.started||r.stopping{h.mu.Unlock();return}
    r.started=true;h.inventoryWg.Add(1);h.mu.Unlock()
    go func(){
        defer h.inventoryWg.Done();defer observability.Recoverer("heartbeat.timeSync")
        timer:=time.NewTimer(timeSyncFirstDelay(h.config.AgentID));defer timer.Stop()
        first:=timer.C
        for{
            scheduled:=false
            select{case <-r.ctx.Done():return;case <-first:first=nil;scheduled=true;case <-r.wake:}
            if r.ctx.Err()!=nil{return}
            h.mu.Lock()
            pending,hasPending:=r.pending,r.hasPending;r.pending=nil;r.hasPending=false
            h.mu.Unlock()
            if hasPending{
                changed,err:=r.manager.Apply(pending)
                if err!=nil{log.Warn("time sync settings rejected or not persisted","error",err)}
                // Repeated identical delivery does not turn a heartbeat into a collection tick.
                if !changed && err==nil{
                    h.mu.Lock();last:=r.lastTimeSyncUpdate
                    due:=!last.IsZero() && !time.Now().Before(last.Add(timeSyncInterval(h.config.AgentID,last)))
                    h.mu.Unlock()
                    if !scheduled && !due{continue}
                }
            }
            // An actual immediate cycle supersedes the delayed first collection.
            timer.Stop();first=nil
            h.mu.Lock();r.lastTimeSyncUpdate=time.Now();h.mu.Unlock()
            ctx,cancel:=context.WithTimeout(r.ctx,60*time.Second)
            _,err:=collectors.Guard("timesync.management",func()(bool,error){return true,r.manager.Cycle(ctx)})
            cancel();if err!=nil && r.ctx.Err()==nil{log.Warn("time sync cycle failed","error",err)}
        }
    }()
}
func(h *Heartbeat)stopTimeSync(){
    h.mu.Lock();r:=h.timeSync
    if r!=nil{r.stopping=true;r.cancel()};h.mu.Unlock()
}
```

- [ ] Apply the following exact `heartbeat.go` replacements (all anchors are pre-change line numbers):

At `:456`, replace:

```go
    hwDisabledSnapshot *hwhealth.Snapshot
```

with:

```go
    hwDisabledSnapshot *hwhealth.Snapshot
    timeSync           *timeSyncRuntime
```

At `:1004`, replace:

```go
    h.hwContext, h.hwCancel = context.WithCancel(context.Background())
```

with:

```go
    h.hwContext, h.hwCancel = context.WithCancel(context.Background())
    h.initTimeSync()
```

At `:1844–1846`, replace:

```go
func (h *Heartbeat) Start() {
    h.startHardwareHealth()
    h.startPamReconciliationRetryLoop()
```

with:

```go
func (h *Heartbeat) Start() {
    h.startHardwareHealth()
    h.startTimeSync()
    h.startPamReconciliationRetryLoop()
```

At `:2052–2053`, replace:

```go
                hwTiers := h.hardwareTiersLocked(now, false)
                h.mu.Unlock()
```

with:

```go
                hwTiers := h.hardwareTiersLocked(now, false)
                h.timeSyncTickLocked(now)
                h.mu.Unlock()
```

At `:2153–2154`, replace:

```go
func (h *Heartbeat) DrainAndWait(ctx context.Context) {
    h.stopHardwareHealth()
```

with:

```go
func (h *Heartbeat) DrainAndWait(ctx context.Context) {
    h.stopHardwareHealth()
    h.stopTimeSync()
```

At `:2173–2175`, replace:

```go
func (h *Heartbeat) Stop() {
    h.stopOnce.Do(func() {
        h.stopHardwareHealth()
```

with:

```go
func (h *Heartbeat) Stop() {
    h.stopOnce.Do(func() {
        h.stopHardwareHealth()
        h.stopTimeSync()
```

At `:2341–2344`, replace:

```go
    parent := context.Background()
    if endpoint == "hardware-health" && h.hwContext != nil {
        parent = h.hwContext
    }
```

with:

```go
    parent := context.Background()
    if endpoint == "hardware-health" && h.hwContext != nil {
        parent = h.hwContext
    }
    if endpoint == "time-status" {
        if upload, ok := payload.(timeSyncUpload); ok && upload.ctx != nil {
            parent = upload.ctx
        }
    }
```

At `:3194`, replace the single anchor line:

```go
    registryRaw, hasRegistry := update["policy_registry_state_probes"]
```

with:

```go
    tsRaw, hasTS := update["time_sync_settings"]
    if !hasTS {
        tsRaw, hasTS = update["timeSyncSettings"]
    }
    if hasTS {
        h.applyTimeSyncSettings(tsRaw)
    }

    registryRaw, hasRegistry := update["policy_registry_state_probes"]
```

- [ ] Add this full upload cancellation test to `time_sync_test.go`, extending its import block with `encoding/json`, `io`, `net/http`, `strings` and `sync/atomic`:

```go
func TestTimeUploadWireAndCancellation(t *testing.T){
    f:=&fakeTimeManager{};h:=newTimeHeartbeat(f);h.retryCfg.MaxRetries=0
    var calls atomic.Int32
    entered:=make(chan struct{})
    h.client=&http.Client{Transport:hardwareTransport(func(r *http.Request)(*http.Response,error){
        calls.Add(1)
        if r.Method!="PUT"||r.URL.Path!="/api/v1/agents/fixture-agent/time-status"{t.Error(r.Method,r.URL)}
        b,e:=io.ReadAll(r.Body);if e!=nil{t.Error(e)}
        var body map[string]any;if e=json.Unmarshal(b,&body);e!=nil{t.Error(e)}
        if len(body)!=2||body["sequence"]!=float64(3)||!strings.Contains(string(b),`"enforcement"`){t.Error(string(b))}
        close(entered);<-r.Context().Done();return nil,r.Context().Err()
    })}
    // config.ServerURL is used by serverURL(); no real network request is made.
    h.config.ServerURL="https://api.example.com"
    ctx,cancel:=context.WithCancel(h.timeSync.ctx)
    done:=make(chan error,1)
    go func(){done<-h.sendInventoryData("time-status",timeSyncUpload{ctx:ctx,data:map[string]any{"sequence":3,"enforcement":nil}},"time sync")}()
    select{case <-entered:case <-time.After(time.Second):t.Fatal("upload not dispatched")}
    cancel()
    select{case e:=<-done:if e==nil{t.Fatal("cancelled upload succeeded")};case <-time.After(time.Second):t.Fatal("upload lost command context")}
    if calls.Load()!=1{t.Fatal(calls.Load())};h.stopTimeSync()
}
```

`hardwareTransport` is the existing test RoundTripper at `hardware_health_test.go:32–34`; confirm its unchanged declaration on the merged baseline. `Config.ServerURL` exists at `config/config.go:57` (verified with `rg` before implementation).

- [ ] Run `cd agent && go test -race ./internal/heartbeat/...` and `cd agent && GOOS=windows go vet ./internal/heartbeat/...`; expected PASS, including existing hardware lifecycle tests.
- [ ] Commit:

```sh
git add agent/internal/heartbeat/time_sync.go agent/internal/heartbeat/time_sync_test.go agent/internal/heartbeat/heartbeat.go
git commit -m 'feat(timesync): reconcile settings immediately through heartbeat lifecycle' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 6: Register elevated commands and preserve structured failures

**Files:**
- Create: `agent/internal/heartbeat/handlers_timesync.go`
- Modify: `agent/internal/remote/tools/types.go:73–74`; `agent/internal/privilege/check.go:7–8`; `agent/internal/heartbeat/handlers_test.go:117–118`.
- Test: `agent/internal/heartbeat/handlers_timesync_test.go`, `agent/internal/privilege/timesync_test.go`.
- Registry consumed: `agent/internal/heartbeat/handlers.go:11–17`; init precedent `handlers_cis.go:10–13`; no duplicate direct entries in `handlers.go`.

**Interfaces:**
- Produces: `tools.CmdTimeResync = "time_resync"`, `tools.CmdTimeSetTimezone = "time_set_timezone"`, `tools.CmdTimeApplyPolicy = "time_apply_policy"`.
- Produces: `handleTimeResync(h *Heartbeat, cmd Command) tools.CommandResult`, `handleTimeSetTimezone`, `handleTimeApplyPolicy`, all matching `CommandHandler`.
- Consumes: `Manager.Command`, `tools.NewSuccessResult(data any,durationMs int64) CommandResult` (`types.go:310`), `privilege.RequiresElevation(cmdType string) bool` (`check.go:36`).
- `Command` (`heartbeat.go:337–341`) has no context; handlers derive a 60-second child of the time lifecycle context.

- [ ] Write `handlers_timesync_test.go`:

```go
package heartbeat

import (
    "encoding/json"
    "errors"
    "testing"

    "github.com/breeze-rmm/agent/internal/collectors/timesync"
    "github.com/breeze-rmm/agent/internal/remote/tools"
)
func TestTimeHandlersRegistryAndResults(t *testing.T){
    for _,tc:=range []struct{kind string;payload map[string]any;data any}{
        {"time_resync",map[string]any{},timesync.ResyncResult{ExitCode:0}},
        {"time_set_timezone",map[string]any{"windowsId":"UTC"},timesync.SetTimezoneResult{}},
        {"time_apply_policy",map[string]any{},timesync.ManagementReport{}},
    }{for _,failed:=range []bool{false,true}{
        f:=&fakeTimeManager{result:tc.data};if failed{f.err=errors.New("readback failed")}
        h:=newTimeHeartbeat(f)
        got,handled:=h.dispatchCommand(Command{ID:"time-fixture",Type:tc.kind,Payload:tc.payload})
        if !handled||len(f.commands)!=1||f.commands[0]!=tc.kind{t.Fatal(handled,f.commands)}
        if got.Result==nil{t.Fatal("structured result absent")}
        if failed && (got.Status!="failed"||got.ExitCode==0||got.Error==""){t.Fatal(got)}
        if !failed && got.Status!="completed"{t.Fatal(got)}
        // Transport must carry exact F.4 JSON even when Error disables stdout reparsing.
        want,e:=json.Marshal(tc.data);if e!=nil{t.Fatal(e)}
        actual,e:=json.Marshal(got.Result);if e!=nil{t.Fatal(e)}
        if string(actual)!=string(want){t.Fatal(string(actual),string(want))}
        ws:=toWSCommandResult("time-fixture",got)
        wire,e:=json.Marshal(ws.Result);if e!=nil{t.Fatal(e)}
        if string(wire)!=string(want){t.Fatal("WebSocket lost structured failure",string(wire))}
        if tc.kind=="time_set_timezone" && f.payload["windowsId"]!="UTC"{t.Fatal(f.payload)}
        h.stopTimeSync()
    }}
}
func TestTimeHandlerPreservesResyncExitCode(t *testing.T){
    message:="resync failed"
    f:=&fakeTimeManager{result:timesync.ResyncResult{ExitCode:7,Error:&message},err:errors.New(message)}
    h:=newTimeHeartbeat(f);defer h.stopTimeSync()
    got:=handleTimeResync(h,Command{Type:tools.CmdTimeResync,Payload:map[string]any{}})
    if got.ExitCode!=7||got.Result.(timesync.ResyncResult).ExitCode!=7{t.Fatal(got)}
}
func TestTimeHandlerUnsupported(t *testing.T){
    h:=&Heartbeat{}
    for _,kind:=range []string{"time_resync","time_set_timezone","time_apply_policy"}{
        got,handled:=h.dispatchCommand(Command{Type:kind,Payload:map[string]any{}})
        if !handled||got.Status!="failed"||got.Result==nil{t.Fatal(kind,got)}
    }
}
```

- [ ] Write `privilege/timesync_test.go` (no platform build tag):

```go
package privilege

import "testing"

func TestTimeCommandsRequireElevation(t *testing.T){
    for _,kind:=range []string{"time_resync","time_set_timezone","time_apply_policy"}{
        if !RequiresElevation(kind){t.Fatalf("%s missing elevated registration",kind)}
    }
}
```

- [ ] Run `cd agent && go test -race ./internal/heartbeat/...` and `cd agent && go test -race ./internal/privilege/...`; expected FAIL: missing `handleTimeResync` / `CmdTimeResync` and `time_resync missing elevated registration`.
- [ ] At `remote/tools/types.go:73–74`, replace:

```go
    // Boot performance
    CmdCollectBootPerformance    = "collect_boot_performance"
```

with:

```go
    // Time synchronization management (Windows).
    CmdTimeResync       = "time_resync"
    CmdTimeSetTimezone  = "time_set_timezone"
    CmdTimeApplyPolicy  = "time_apply_policy"

    // Boot performance
    CmdCollectBootPerformance    = "collect_boot_performance"
```

At `privilege/check.go:7–8`, replace:

```go
var elevatedCommandTypes = map[string]bool{
    tools.CmdSystemCleanupRun:         true,
```

with:

```go
var elevatedCommandTypes = map[string]bool{
    tools.CmdTimeResync:               true,
    tools.CmdTimeSetTimezone:          true,
    tools.CmdTimeApplyPolicy:          true,
    tools.CmdSystemCleanupRun:         true,
```

At `handlers_test.go:117–118`, replace:

```go
    // handlers_cis.go init()
    tools.CmdCisBenchmark, tools.CmdApplyCisRemediation,
```

with:

```go
    // handlers_cis.go init()
    tools.CmdCisBenchmark, tools.CmdApplyCisRemediation,

    // handlers_timesync.go init()
    tools.CmdTimeResync, tools.CmdTimeSetTimezone, tools.CmdTimeApplyPolicy,
```

- [ ] Create `handlers_timesync.go`:

```go
package heartbeat

import (
    "context"
    "fmt"
    "time"

    "github.com/breeze-rmm/agent/internal/collectors/timesync"
    "github.com/breeze-rmm/agent/internal/remote/tools"
)
func init(){
    handlerRegistry[tools.CmdTimeResync]=handleTimeResync
    handlerRegistry[tools.CmdTimeSetTimezone]=handleTimeSetTimezone
    handlerRegistry[tools.CmdTimeApplyPolicy]=handleTimeApplyPolicy
}
func handleTimeResync(h *Heartbeat,cmd Command)tools.CommandResult{return handleTimeCommand(h,cmd,tools.CmdTimeResync)}
func handleTimeSetTimezone(h *Heartbeat,cmd Command)tools.CommandResult{return handleTimeCommand(h,cmd,tools.CmdTimeSetTimezone)}
func handleTimeApplyPolicy(h *Heartbeat,cmd Command)tools.CommandResult{return handleTimeCommand(h,cmd,tools.CmdTimeApplyPolicy)}
func handleTimeCommand(h *Heartbeat,cmd Command,kind string)tools.CommandResult{
    start:=time.Now();var data any;var err error
    h.mu.Lock();r:=h.timeSync;stopped:=r==nil||r.stopping;h.mu.Unlock()
    if stopped{err=fmt.Errorf("time management unavailable on this agent")
    }else{
        ctx,cancel:=context.WithTimeout(r.ctx,60*time.Second);defer cancel()
        data,err=r.manager.Command(ctx,kind,cmd.Payload)
        if ctx.Err()!=nil{h.mu.Lock();h.wakeTimeSyncLocked();h.mu.Unlock()}
    }
    if data==nil{
        var message *string;if err!=nil{s:=err.Error();message=&s}
        switch kind{
        case tools.CmdTimeResync:data=timesync.ResyncResult{ExitCode:1,Error:message}
        case tools.CmdTimeSetTimezone:data=timesync.SetTimezoneResult{Error:message}
        case tools.CmdTimeApplyPolicy:data=timesync.ManagementReport{}
        }
    }
    result:=tools.NewSuccessResult(data,time.Since(start).Milliseconds())
    result.Result=data // Preserve F.4 on BOTH HTTP and WebSocket error paths.
    if err!=nil{result.Status="failed";result.ExitCode=1;result.Error=err.Error()}
    if resync,ok:=data.(timesync.ResyncResult);ok{
        result.ExitCode=resync.ExitCode
        if err!=nil && result.ExitCode==0{result.ExitCode=1}
    }
    return result
}
```

The elevation map integrates the existing privilege mechanism; it is not a new authorization boundary. The current call site at `heartbeat.go:6832–6835` warns on insufficient privilege. API permission/MFA/trust gating and one-hour offline expiry are W03a responsibilities; Windows access checks still fail the actual write if the service lacks rights.

- [ ] Run `cd agent && go test -race ./internal/heartbeat/...`, `cd agent && go test -race ./internal/privilege/...`, and `cd agent && go test -race ./internal/remote/tools/...`; expected PASS, including registry completeness/no-extra-entry tests.
- [ ] Run `cd agent && GOOS=windows go vet ./internal/heartbeat/... ./internal/privilege/... ./internal/remote/tools/...`; expected PASS.
- [ ] Commit:

```sh
git add agent/internal/heartbeat/handlers_timesync.go agent/internal/heartbeat/handlers_timesync_test.go agent/internal/heartbeat/handlers_test.go agent/internal/remote/tools/types.go agent/internal/privilege/check.go agent/internal/privilege/timesync_test.go
git commit -m 'feat(timesync): register elevated time commands and structured results' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 7: Pin command error evidence and complete release verification

**Files:**
- Modify Task 4 output: `agent/internal/collectors/timesync/management_commands.go`, `resync` final read-back block shown below; normalize formatting of the exact Go outputs listed in File Structure using the explicit gofmt command.
- Test: append to `agent/internal/collectors/timesync/management_test.go`, `reconcile_test.go` and `settings_test.go`.
- Lab evidence: PR description only; no repository lab results or infrastructure files.

**Interfaces:**
- Consumes exact §F.4 `ResyncResult.ExitCode`: the resync process's exit code remains 0 if it succeeded even when subsequent read-back fails; the outer `CommandResult` still reports command failure.
- Consumes index §J L6–L8 and existing L1/L3/L5 observations; produces a PR evidence table and an agent release go/no-go decision.

- [ ] Append the failing read-back regression to `management_test.go`:

```go
func TestManagementResyncReadFailurePreservesProcessExit(t *testing.T){
    f:=newFakeTimeSystem("workgroup");f.obs.Config.ServiceState="running"
    f.beforeRead=func(f *fakeTimeSystem){for _,call:=range f.calls{if call=="resync"{f.fail="read"}}}
    m:=managementFixture(t,t.TempDir(),f,func(context.Context,any)error{return nil})
    data,e:=m.Command(context.Background(),"time_resync",map[string]any{})
    got:=data.(ResyncResult)
    if e==nil||got.Error==nil{t.Fatal("read failure hidden",got,e)}
    if got.ExitCode!=0{t.Fatalf("successful resync process exit rewritten: %d",got.ExitCode)}
    if got.After!=nil{t.Fatal("invented last successful sync after failed read")}
}
```

- [ ] Run `cd agent && go test -race ./internal/collectors/timesync/...`; expected FAIL: `successful resync process exit rewritten: 1`.
- [ ] In Task 4's `management_commands.go`, replace exactly:

```go
    e=errors.Join(e,readErr);if e!=nil && out.ExitCode==0{out.ExitCode=1};out.Error=errorText(e)
```

with:

```go
    // ExitCode describes the resync process. CommandResult.Status describes the whole operation.
    e=errors.Join(e,readErr);out.Error=errorText(e)
```

- [ ] Append the full remaining boundary tests to `reconcile_test.go`:

```go
func TestReconcileTimezoneRoleGuardMatrix(t *testing.T){
    for _,role:=range []string{"workgroup","entra_only","forest_root_pdc_emulator","member","dc","pdc_emulator","unknown"}{
        for _,managed:=range []bool{false,true}{for _,mismatch:=range []bool{false,true}{
            now:=time.Now();f:=newFakeTimeSystem(role);f.obs.Config.PolicyManaged=managed;f.mismatch=mismatch
            r:=fakeReconciler(f,&now);r.State.Settings.EnforceNTP=false
            r.State.Settings.Timezone=TimezoneSettings{managementPtr("Eastern Standard Time"),true}
            if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
            got:=r.State.Report.Timezone;outcome,reason:="ok","applied"
            switch{case role=="unknown":outcome,reason="skipped","role_unknown"
            case managed:outcome,reason="skipped","conflict_gpo"
            case mismatch:outcome,reason="failed","readback_mismatch"}
            if got.Outcome!=outcome||got.Reason!=reason{t.Fatal(role,managed,mismatch,got)}
            if outcome=="skipped"&&len(f.calls)!=0{t.Fatal(f.calls)}
        }}
    }
}
func TestReconcileTimezoneGuardRereadsAutoUpdate(t *testing.T){
    now:=time.Now();f:=newFakeTimeSystem("workgroup");r:=fakeReconciler(f,&now)
    r.State.Settings.EnforceNTP=false;r.State.Settings.Timezone=TimezoneSettings{managementPtr("Eastern Standard Time"),true}
    f.beforeRead=func(f *fakeTimeSystem){if f.reads>=2{f.obs.Timezone.AutoUpdate="on"}}
    if e:=r.Run(context.Background(),true);e!=nil{t.Fatal(e)}
    if r.State.Report.Timezone.Reason!="auto_timezone_on"||len(f.calls)!=0{t.Fatal(r.State.Report,f.calls)}
}
func TestReconcileSuccessfulGateAndIndependentKinds(t *testing.T){
    now:=time.Now();f:=newFakeTimeSystem("workgroup");r:=fakeReconciler(f,&now)
    r.State.Settings.Timezone=TimezoneSettings{managementPtr("Eastern Standard Time"),true}
    f.fail="manual"
    if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
    if r.State.Report.NTP.Outcome!="failed"||r.State.Report.Timezone.Outcome!="ok"{t.Fatal(r.State.Report)}
    zoneID:=r.State.Report.Timezone.ResultID
    now=now.Add(30*time.Minute)
    if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
    if r.State.Report.Timezone.ResultID!=zoneID{t.Fatal("successful kind bypassed one-hour gate")}
    now=now.Add(30*time.Minute)
    if e:=r.Run(context.Background(),false);e!=nil{t.Fatal(e)}
    if r.State.NTPGate.Next.Sub(now)!=2*time.Hour||r.State.TimezoneGate.Next.Sub(now)!=time.Hour{t.Fatal(r.State)}
}
func TestReconcileEveryWriteFailureStopsLaterWrites(t *testing.T){
    for index,name:=range []string{"manual","poll","update","auto","start"}{
        now:=time.Now();f:=newFakeTimeSystem("workgroup");f.fail=name;r:=fakeReconciler(f,&now)
        if e:=r.Run(context.Background(),true);e!=nil{t.Fatal(e)}
        if len(f.calls)!=index+1||r.State.Report.NTP.Reason!="exec_failed"{t.Fatal(name,f.calls,r.State.Report)}
        if r.State.Report.NTP.After==nil{t.Fatal("partial read-back discarded")}
    }
}
```

- [ ] Extend Task 1's `settings_test.go` imports with `errors` and `unicode/utf16`, then append:

```go
func TestManagementErrorLengthUsesUTF16(t *testing.T){
    message:=errorText(errors.New(strings.Repeat("😀",300)))
    if message==nil || len(utf16.Encode([]rune(*message)))!=512{t.Fatal(message)}
    if errorText(nil)!=nil{t.Fatal("nil error must stay null")}
    if ntpValues(Observation{})["serviceStartType"]!=nil{t.Fatal("unknown start type must be null")}
}
```

- [ ] Append these complete state/deadline/event-boundary regressions to `management_test.go`:

```go
func TestManagementContextBoundsSerializationWait(t *testing.T){
    f:=newFakeTimeSystem("workgroup")
    m:=managementFixture(t,t.TempDir(),f,func(context.Context,any)error{return nil})
    if e:=m.lock(context.Background());e!=nil{t.Fatal(e)}
    ctx,cancel:=context.WithCancel(context.Background());cancel()
    done:=make(chan error,1)
    go func(){_,e:=m.Command(ctx,"time_resync",map[string]any{});done<-e}()
    select{case e:=<-done:if !errors.Is(e,context.Canceled){t.Fatal(e)}
    case <-time.After(time.Second):m.unlock();t.Fatal("cancelled command waited for another operation")}
    m.unlock()
    if len(f.calls)!=0{t.Fatal("cancelled command wrote")}
}
func TestManagementDisabledFailureDoesNotFailApply(t *testing.T){
    f:=newFakeTimeSystem("workgroup");f.fail="manual"
    m:=managementFixture(t,t.TempDir(),f,func(context.Context,any)error{return nil})
    s:=settingsFixture();if _,e:=m.Apply(rawSettings(t,s));e!=nil{t.Fatal(e)}
    if e:=m.Cycle(context.Background());e!=nil{t.Fatal(e)}
    if m.state.Report.NTP.Outcome!="failed"{t.Fatal(m.state.Report)}
    s.EnforceNTP=false;s.NTPServers=[]string{};s.Fingerprint="sha256:"+fmt.Sprintf("%064x",7)
    if _,e:=m.Apply(rawSettings(t,s));e!=nil{t.Fatal(e)}
    calls:=len(f.calls)
    if _,e:=m.Command(context.Background(),"time_apply_policy",map[string]any{});e!=nil{t.Fatal(e)}
    if len(f.calls)!=calls{t.Fatal("disabled policy wrote")}
}
func TestManagementAcknowledgesCachedReadsAfterDurableTransfer(t *testing.T){
    f:=newFakeTimeSystem("workgroup");dir:=t.TempDir()
    m:=managementFixture(t,dir,f,func(context.Context,any)error{return nil})
    base:=m.collect;var pending *Snapshot;acks:=0
    m.collect=func(ctx context.Context)(*Snapshot,error){if pending!=nil{return pending,nil};var e error;pending,e=base(ctx);return pending,e}
    m.acknowledge=func(uint64)error{
        saved,e:=loadManagement(filepath.Join(dir,managementFile));if e!=nil{return e}
        if len(saved.PendingEvents)==0{return errors.New("ack before durable event transfer")}
        acks++;pending=nil;return nil
    }
    if _,e:=m.Apply(rawSettings(t,settingsFixture()));e!=nil{t.Fatal(e)}
    if e:=m.Cycle(context.Background());e!=nil{t.Fatal(e)}
    if m.state.Report.NTP.Outcome!="ok" || acks<6{t.Fatal("guard reads were stale",m.state.Report,acks)}
    if _,e:=m.read(context.Background());e!=nil{t.Fatal(e)}
    n:=managementFixture(t,dir,f,func(context.Context,any)error{return nil})
    if len(n.events)==0{t.Fatal("acknowledged unsent event lost at restart")}
}
func TestManagementEventCapUsesInstants(t *testing.T){
    f:=newFakeTimeSystem("workgroup")
    m:=managementFixture(t,t.TempDir(),f,func(context.Context,any)error{return nil})
    for id:=uint64(1);id<=99;id++{m.events[id]=json.RawMessage(fmt.Sprintf(`{"recordId":%d,"occurredAt":"2026-09-28T13:00:00Z"}`,id))}
    m.events[100]=json.RawMessage(`{"recordId":100,"occurredAt":"2026-09-28T12:00:00Z"}`)
    m.events[101]=json.RawMessage(`{"recordId":101,"occurredAt":"2026-09-28T08:00:00.9-04:00"}`)
    got,e:=m.boundedEvents();if e!=nil{t.Fatal(e)}
    if len(got)!=100 || m.events[100]!=nil || m.events[101]==nil{t.Fatal("cap discarded newer fractional/offset event")}
}
```

- [ ] Run the targeted green cycle:

```sh
cd agent && go test -race ./internal/collectors/timesync/...
cd agent && go test -race ./internal/heartbeat/...
cd agent && go test -race ./internal/privilege/...
cd agent && go test -race ./internal/remote/tools/...
```

The expected PASS result includes no real network requests, real time-service writes, or sleeps to simulate the one-hour gate.

- [ ] Format the implementation files before final checks:

```sh
cd agent && gofmt -w internal/collectors/timesync/settings.go internal/collectors/timesync/settings_test.go internal/collectors/timesync/management_types.go internal/collectors/timesync/writer.go internal/collectors/timesync/writer_windows.go internal/collectors/timesync/writer_other.go internal/collectors/timesync/writer_test.go internal/collectors/timesync/writer_windows_test.go internal/collectors/timesync/reconcile.go internal/collectors/timesync/reconcile_test.go internal/collectors/timesync/management_store.go internal/collectors/timesync/management.go internal/collectors/timesync/management_commands.go internal/collectors/timesync/management_test.go internal/heartbeat/time_sync.go internal/heartbeat/time_sync_test.go internal/heartbeat/heartbeat.go internal/heartbeat/handlers_timesync.go internal/heartbeat/handlers_timesync_test.go internal/heartbeat/handlers_test.go internal/remote/tools/types.go internal/privilege/check.go internal/privilege/timesync_test.go
```

- [ ] Final agent verification (execute during implementation, **not while authoring this plan**):

```sh
cd agent && go test -race ./...
cd agent && GOOS=windows go vet ./...
cd agent && GOOS=windows go test -c -o /tmp/breeze-timesync.test.exe ./internal/collectors/timesync
cd agent && GOOS=windows go test -c -o /tmp/breeze-heartbeat.test.exe ./internal/heartbeat
cd agent && GOOS=windows go test -c -o /tmp/breeze-tools.test.exe ./internal/remote/tools
cd agent && GOOS=windows go test -c -o /tmp/breeze-privilege.test.exe ./internal/privilege
```

Expected PASS. The timesync compile includes `writer_windows.go` and the consumed W01b Windows System; compile the tools/heartbeat dependents as well, since build-tag success in one package is insufficient. These are cross-compiles, not claims of native Windows execution.

**Tenancy verification applicability:** W03b touches no tenancy code, schema, migration, cascade, export or merge registrations. The index's real-DB contract requirement explicitly names W01a/W02/W03a, so it does not apply here. Do not add API changes to make a Go PR pass; if the diff contains any such change, remove it from W03b and return it to its owner. No database stack is started by this plan.

- [ ] Native tests on the Windows lab VM, from a checkout of the implementation commit, with the installed service left as the sole agent:

```powershell
Set-Location agent
go test -race ./internal/collectors/timesync/...
go test -race ./internal/heartbeat/...
go test -race ./internal/privilege/...
go test -race ./internal/remote/tools/...
```

These unit tests use fake writers except the read-only timezone-key test. Confirm the native Go toolchain has a supported C compiler for `-race`; inability to run the race build is missing evidence, not PASS. Deploy the built agent via `cd agent && make dev-push` with the existing private deployment configuration and the selected device ID. The Makefile target is at `agent/Makefile:256`; do not put connection values or authentication tokens in tracked commands. Confirm the installed service's executable/version changed and that exactly one Breeze agent service/process owns the heartbeat.

- [ ] Capture pre-test rollback data locally on each participating VM before changing Windows or Breeze policies:

```powershell
$timeKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time'
$zoneBefore = (Get-TimeZone).Id
$autoZoneBefore = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate').Start
$serviceBefore = Get-CimInstance Win32_Service -Filter "Name='W32Time'"
& reg.exe export 'HKLM\SYSTEM\CurrentControlSet\Services\W32Time' "$env:TEMP\breeze-w03b-w32time-before.reg" /y
if ($LASTEXITCODE -ne 0) { throw 'Could not save W32Time rollback state' }
& w32tm.exe /query /configuration
& w32tm.exe /query /status /verbose
Get-ItemProperty "$timeKey\Parameters" -Name Type,NtpServer
Get-ItemProperty "$timeKey\TimeProviders\NtpClient" -Name SpecialPollInterval
Get-Service W32Time
```

Record config and device identifiers in private lab notes only. In the PR refer to roles and the approved lab labels. Capture the last snapshot sequence, current `enforcement` IDs and the audit event count before each test. Use Device → Info → Time and its route response, not assumptions from translated w32tm text.

**L6 — GPO wins on the member in the brzlab AD lab.**

- [ ] On the brzlab AD lab management console with the GroupPolicy and ActiveDirectory modules, create an isolated temporary OU and a GPO scoped only to the selected member. Save its original parent to the current operator session:

```powershell
Import-Module ActiveDirectory
Import-Module GroupPolicy
$domain = Get-ADDomain
$memberIdentity = Read-Host 'Member server computer account name in the brzlab AD lab'
$member = Get-ADComputer -Identity $memberIdentity
$originalParent = $member.DistinguishedName.Substring($member.DistinguishedName.IndexOf(',') + 1)
$ouName = 'Breeze Time Sync W03b Lab'
$labOU = New-ADOrganizationalUnit -Name $ouName -Path $domain.DistinguishedName -PassThru
Move-ADObject -Identity $member.DistinguishedName -TargetPath $labOU.DistinguishedName
$gpoName = 'Breeze Time Sync W03b Lab'
$gpo = New-GPO -Name $gpoName
New-GPLink -Guid $gpo.Id -Target $labOU.DistinguishedName -LinkEnabled Yes
Set-GPRegistryValue -Guid $gpo.Id -Key 'HKLM\SOFTWARE\Policies\Microsoft\W32Time\Parameters' -ValueName Type -Type String -Value 'NT5DS'
Set-GPRegistryValue -Guid $gpo.Id -Key 'HKLM\SOFTWARE\Policies\Microsoft\W32Time\Parameters' -ValueName NtpServer -Type String -Value 'time.cloudflare.com,0x9'
Set-GPRegistryValue -Guid $gpo.Id -Key 'HKLM\SOFTWARE\Policies\Microsoft\W32Time\TimeProviders\NtpClient' -ValueName Enabled -Type DWord -Value 1
```

If the named temporary OU/GPO already exists, stop and inspect ownership rather than reusing another test's objects. The temporary move is confined to the lab; retain the operator session for cleanup. Equivalent GPMC setup is Computer Configuration → Administrative Templates → System → Windows Time Service → Time Providers, “Configure Windows NTP Client”; ensure the link/security scope contains only the chosen member.

- [ ] On that member run `gpupdate /target:computer /force`, then:

```powershell
& w32tm.exe /query /configuration
Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\W32Time\Parameters'
Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\W32Time\TimeProviders\NtpClient'
```

- [ ] In Breeze, create a dedicated configuration policy at the lab's authorized org scope: Configuration Policies → New policy → Time sync. Set Enforce NTP on, servers `time.cloudflare.com` and `pool.ntp.org`, poll 60 min, expected timezone Site, auto-fix off; save and assign only the member. Confirm the next heartbeat contains `time_sync_settings` with a fingerprint and the member sends an immediate snapshot.
- [ ] Require `domain.role=member`, `config.policyManaged=true`, nonempty `policyManagedValues`, `enforcement.ntp.outcome=skipped`, `reason=conflict_gpo`, and finding `policy_conflict_gpo`. Before/after registry values remain unchanged. The device audit trail contains one `time_sync.enforced` system/device entry for that result ID with skipped outcome and equal before/after. An immediate ordinary snapshot repeats that same ID and adds no audit entry. Clicking Apply time policy now queues the existing `device.command.queue` audit entry and may produce a new skipped result ID; it must not write Windows configuration.
- [ ] Preserve `w32tm /query /configuration` before/after, command result JSON, snapshot report, and audit entries as PR attachments redacted to role labels. The unit fake proves zero writer calls; the lab additionally proves unchanged registry/service state and GPO provenance.

**L7 — Correct role policy, argv, read-back, restart and no-policy behavior.**

- [ ] Remove the temporary L6 policy using its saved objects, move the member back, then refresh machine policy:

```powershell
Remove-GPLink -Guid $gpo.Id -Target $labOU.DistinguishedName -Confirm:$false
Remove-GPO -Guid $gpo.Id -Confirm:$false
$memberNow = Get-ADComputer -Identity $memberIdentity
Move-ADObject -Identity $memberNow.DistinguishedName -TargetPath $originalParent
Set-ADOrganizationalUnit -Identity $labOU.DistinguishedName -ProtectedFromAccidentalDeletion $false
Remove-ADOrganizationalUnit -Identity $labOU.DistinguishedName -Confirm:$false
```

Run `gpupdate /target:computer /force` on the member. Confirm no effective W32Time policy values remain and `policyManaged=false`; do not delete inherited production-like policy keys to make the test pass.

- [ ] Assign the dedicated Breeze time policy to the Windows lab VM, the forest-root PDC and the member in the brzlab AD lab. Start from their recorded configurations. Click Apply time policy now on each device (force bypasses a previous L6 gate); inspect the immediate snapshots and exact command JSON.
- [ ] Run this read-back on **each** host:

```powershell
& w32tm.exe /query /configuration
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time\Parameters' -Name Type,NtpServer
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time\TimeProviders\NtpClient' -Name SpecialPollInterval
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time\Config' -Name AnnounceFlags
Get-CimInstance Win32_Service -Filter "Name='W32Time'" | Select-Object State,StartMode
& w32tm.exe /query /status /verbose
```

Expect workgroup and forest-root PDC `Type=NTP`, two separate peers both with `,0x9`, SpecialPollInterval 3600, Automatic and running service. Expect member `Type=NT5DS`, Automatic and running; its dormant manual list/poll need not change. Verify the root PDC's reliable advertisement in the configuration read-back, and inspect the w32tm manual-peer argv evidence from Task 2. Do not infer native argv success from cross-compilation alone. `enforcement.ntp` is `ok/applied` or `ok/already_compliant` with before/after facts; non-zero resync can accompany `ok` only when configuration read-back matches, with its diagnostic preserved in `error`.

- [ ] Confirm one `time_sync.enforced` audit event per distinct kind/resultId, system actor/device resource, correct fingerprint, outcome and before/after. Confirm command queuing has its separate `device.command.queue` audit entry. Trigger another snapshot before one hour and verify unchanged result IDs/no new enforcement audit; click Apply now again and verify a new result despite the rate gate.
- [ ] Restart the **installed** Breeze service on one test device without deleting state. Observe the same settings, gate and result IDs in `timesync-management.json` and subsequent snapshots. Remove its policy assignment; wait for a delivered default payload (not a missing key), then verify settings are persisted disabled, Windows configuration remains unchanged, and a restart does not resume enforcement.

**L8 — Auto-timezone intent and expected-zone handling.**

- [ ] On the Windows lab VM, make the current zone UTC through normal Windows settings. In Breeze edit the dedicated policy to expected timezone Pinned → `America/New_York`, with the “overrides the site timezone” provenance, and auto-fix on. First leave NTP enforcement off to isolate the timezone result.
- [ ] Set the Windows automatic-zone intent on using an elevated operator console, then click Apply time policy now:

```powershell
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate' -Name Start -Type DWord -Value 3
Get-TimeZone
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate' -Name Start
& w32tm.exe /query /configuration
```

Expect `timezone.autoUpdate=on`, unchanged `windowsId`, `enforcement.timezone=skipped/auto_timezone_on`, one deduplicated enforcement audit entry. It does not matter whether the tzautoupdate service is running.
- [ ] Set `Start=4`, click Apply time policy now, and read back:

```powershell
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate' -Name Start -Type DWord -Value 4
Get-TimeZone
& tzutil.exe /g
Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Time Zones\Eastern Standard Time'
& w32tm.exe /query /configuration
```

Expect `autoUpdate=off`, `windowsId=Eastern Standard Time`, `ok/applied`, and the audit before/after zone IDs. Set timezone to expected command returns exactly `{before,after,error}` and immediately sends a snapshot. Repeat Apply now with no drift for `ok/already_compliant`.
- [ ] Set expected mode Site with the test device assigned to a site whose zone is the UTC default (or with no expected mapped site zone), auto-fix still on. Require a newly delivered fingerprint and `expected_windows_id=null`; Apply now yields `skipped/no_expected_timezone` and no tzutil execution. Restore the site's original timezone and policy values after capturing evidence.

**L1/L3/L5 regression after enforcement.**

- [ ] Turn off/remove the test policy and verify the default settings payload has arrived on all three devices before restoring baseline configuration. Restore the saved W32Time registry snapshot locally and the original timezone/automatic-zone intent:

```powershell
& reg.exe import "$env:TEMP\breeze-w03b-w32time-before.reg"
if ($LASTEXITCODE -ne 0) { throw 'W32Time rollback failed' }
& tzutil.exe /s $zoneBefore
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate' -Name Start -Type DWord -Value $autoZoneBefore
& w32tm.exe /config /update
& w32tm.exe /query /configuration
```

Restore service running/stopped state to the saved `$serviceBefore.State` through the Services UI. Confirm the GPO and temporary OU are gone. Retain the local exports until the run is reviewed; never commit them.
- [ ] L1: on the Windows lab VM in workgroup/default configuration, run Resync from Breeze and inspect its immediate snapshot; verify workgroup role, config/timezone facts, null-preserving last-success fields, event collection, and server `sync_stale` threshold `max(3×effectivePoll,24h)`. Compare to W01b evidence; a failed resync reports its actual exit code and still attempts a snapshot.
- [ ] L3: on the forest-root PDC in the brzlab AD lab with enforcement disabled, set `w32tm /config /syncfromflags:domhier /update`, trigger Resync and collect. Verify forest-root PDC role, `Type=NT5DS`, `pdc_no_external_source` (including active event 12 when Windows emits it); no automatic reconfiguration occurs. Restore its recorded baseline again.
- [ ] L5: on the member in the brzlab AD lab, verify NT5DS, a domain-peer source, role member, and no unexpected findings after a successful sync. Compare `w32tm /query /configuration` and snapshot config on each host to prove enforcement has not broken collection or role derivation.

- [ ] Populate this evidence table in the PR description with actual observations and attachments; these are acceptance criteria, not preclaimed results:

| L# | Setup | Expected | Observed | PASS/FAIL |
|---|---|---|---|---|
| L6 | Member in the brzlab AD lab; scoped W32Time GPO plus Breeze enforcement | skipped/conflict_gpo, no Windows write, deduplicated audit | Record snapshot ID, before/after and audit evidence from run | Mark after execution |
| L7 | Windows lab VM; forest-root PDC and member in the brzlab AD lab | manual/manual+reliable/NT5DS, read-back ok, distinct audit IDs | Record three role-specific read-backs and command JSON | Mark after execution |
| L7 restart | Installed agent restart, then policy removal | retained settings/results/gates; defaults disable without revert | Record pre/post restart IDs and disabled payload | Mark after execution |
| L8 on | Automatic-zone intent Start=3 | skipped/auto_timezone_on, unchanged zone | Record intent, snapshot and audit | Mark after execution |
| L8 off | Start=4, pinned expected zone | ok/applied with correct before/after | Record zone registry existence and tzutil read-back | Mark after execution |
| L8 unset | Site UTC default, no pin | skipped/no_expected_timezone | Record null expected ID and unchanged zone | Mark after execution |
| L1 regression | Workgroup default, enforcement disabled | original collector/status/timezone behavior | Compare to W01b and attach fresh snapshot | Mark after execution |
| L3 regression | Forest-root PDC NT5DS, enforcement disabled | pdc_no_external_source, no repair | Attach config and finding evidence | Mark after execution |
| L5 regression | Member NT5DS | member/domain peer, no unexpected findings | Attach config and snapshot | Mark after execution |

These table cells are instructions for the future lab run, not implementation-code placeholders. Do not replace them with invented PASS values. No release until native tests, L6–L8 and regression checks pass; fix and rerun the failed case when they do not.

- [ ] Commit the final regression tests/correction after checks (lab evidence remains in the PR):

```sh
git add agent/internal/collectors/timesync/settings.go agent/internal/collectors/timesync/settings_test.go agent/internal/collectors/timesync/management_types.go agent/internal/collectors/timesync/writer.go agent/internal/collectors/timesync/writer_windows.go agent/internal/collectors/timesync/writer_other.go agent/internal/collectors/timesync/writer_test.go agent/internal/collectors/timesync/writer_windows_test.go agent/internal/collectors/timesync/reconcile.go agent/internal/collectors/timesync/reconcile_test.go agent/internal/collectors/timesync/management_store.go agent/internal/collectors/timesync/management.go agent/internal/collectors/timesync/management_commands.go agent/internal/collectors/timesync/management_test.go agent/internal/heartbeat/time_sync.go agent/internal/heartbeat/time_sync_test.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/handlers_timesync.go agent/internal/heartbeat/handlers_timesync_test.go agent/internal/heartbeat/handlers_test.go agent/internal/remote/tools/types.go agent/internal/privilege/check.go agent/internal/privilege/timesync_test.go
git commit -m 'test(timesync): pin command evidence and release boundary regressions' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

## Self-Review

| Owned requirement | Implementation and proof |
|---|---|
| Spec §8.1 / index F.2 strict settings, host syntax and defaults | Task 1 parser; Task 3 zero-writer invalid fixture; Task 4 invalid delivery reporting; Task 5 snake/camel dispatch before probe return. |
| Spec §8.2 persistence, missing-key retention, disabled defaults and immediate collection | Tasks 4–5; restart/removal L7. |
| D8 / §8.3.1 manual workgroup/Entra/root PDC; hierarchy member/DC/child PDC | Task 3 complete role matrix; L7 three available lab roles. |
| D9 / §8.3.2 unknown role, policyManaged and immediate re-reads | Task 3 each-write guard tests and Task 7 timezone matrix; L6 plus dependency fail-closed issue below. |
| §8.3.3 normalized hosts, Type, poll, service start | Task 3 comparison and odd-spacing fixture; documented NT5DS interpretation in issue 4. |
| §8.3.4 exact exec argv, reliable PDC, poll registry + update, auto start, SCM, resync | Task 2 argv/registry/SCM tests; Task 3 operation ordering/errors; L7 native read-back. |
| §8.3.5 read-back and partial failures | Tasks 3–4; Task 7 command exit/read-back regression and each-write failure test. |
| §8.3.6 rate-limit, capped back-off, fingerprint reset, force | Task 3 injected clock and durable reservation; Task 4 restart/concurrency; Task 7 per-kind gate test. |
| §8.3.7 / §8.5 / index F.3 UUIDs, exact keys, latest result resend | Tasks 1,3,4; Task 5 snapshot wrapper; L6–L8 audit/result-ID verification. API audit dedupe remains W03a. |
| §8.4 timezone expected/null, auto intent, validation and read-back | Tasks 1–4 and Task 7 matrix/L8; registry validation deliberate deviation in issue 5. |
| §9 / index F.4 resync, set timezone and forced policy commands | Tasks 4,6,7, explicit Result on failed transport, constants/init/complete registry/elevation. |
| §4.6 / index H cadence, single collector, nulls and non-Windows silence | Task 5 scheduling/start/stop/context hooks; Task 4 preserves collector wire data and events during guard reads. |
| §12 / index J agent race tests, Windows vet/test-c/native proof | Task 7 final verification and L6–L8 with L1/L3/L5 regression. |
| No API/web changes, no tenancy work or version bump in W03b | File Structure and Task 7 scope gate; existing W03a registration/version 5 consumed unchanged. |

**Placeholder scan:** PASS: zero matches for unfinished-work markers or prose-only code instructions. All implementation/test blocks contain complete bodies; evidence-table cells explicitly instruct the future operator to record real observations. No lab or test success is fabricated. Complete Go file/function blocks were syntax-checked through gofmt on stdin; partial modification anchors are intentionally not standalone programs; this is not a type-check or test run. The authoring pass executes none of the implementation/test/commit commands.

**Type consistency:** Settings use index F.2 snake_case on the wire, accepting camelCase aliases only at agent input; poll seconds are derived from minutes. Result enum values are restricted by construction to F.3's vocabulary, UUIDs use the existing google/uuid dependency, nil pointer fields encode JSON null, and before/after maps contain only F.3 scalar keys. F.4 results have exactly their prescribed fields; outer transport failures retain explicit structured Result. Snapshot overlay changes only `events` (bounded union of guard collections) and `enforcement`, preserving all W01b fields and the latest sequence. Management uses no API types, migration slots or built-in version edits. Concrete W01b Go declarations cannot be checked until the missing dependency is supplied; that limitation is a contract issue, not a successful type-check claim.

**Review Focus coverage:** odd spacing/flag suffix/case and invalid-host fixture are pinned in Tasks 1–3; role/GPO races are pinned before each write in Task 3 and in L6/L7; restart/concurrent cycle/command/result persistence is pinned in Task 4 and transport/lifecycle cancellation in Tasks 5–6. Index items 1,2,4,5 remain earlier-wave tests; L1/L3/L5 re-run exercises their collector integration without duplicating server resolver work.

## Contract issues

1. **Claimed merged prerequisites are not in this checkout.** Inspection HEAD is `354d359424` (plan-index commit). Index `docs/superpowers/plans/monitoring/2026-09-28-time-sync.md:19` lists W03b depending on W01b/W03a, and `:549–554` names the collector files, but `rg --files agent/internal/collectors/timesync` reports that directory absent; `agent/internal/heartbeat/time_sync.go`, the shared validator/fixture, and `apps/api/src/services/timeSync/` are also absent. Index `:470–488` names the missing W03a settings resolver/delivery. **Fix:** implement this plan on the actual merged W01b/W03a revision, verify their lab evidence, and re-anchor the dependency-owned files there; do not manufacture their implementation in W03b. No current-line anchor exists for an absent file.
2. **Index H does not fully specify Go read/report interfaces.** Index `:549` specifies Snapshot/EnforcementReport JSON but no Go member names, and `:552` lists System responsibilities without signatures. A plan using guessed `ReadConfig` or nested struct names would not be justified. **Fix proposed here:** consume the exact `New`/`Collect` signatures at `:551` and decode/overlay the index B JSON through a W03b observation adapter; merge events from all guard reads. The concurrently authored W01b plan at `:404–417` specifies `EnforcementResult.At time.Time`, which Task 1 consumes without redeclaration; source code must still be verified on the merged baseline. Prefer to document a narrow fresh-read System adapter in the index once its concrete W01b interface exists; until then this plan cannot claim compilation against that missing interface.
3. **Unknown management cannot be distinguished from unmanaged in the specified snapshot.** Spec D9 (`docs/superpowers/specs/monitoring/2026-09-28-time-sync-monitoring-design.md:71`) requires fail closed on unknown management; index B's `policyManaged` is a nonnullable boolean and index H `:552` provides no error semantics. **Fix:** W01b must return an error from Collect whenever policy-management reads cannot establish a safe answer (or document an explicit fail-closed true representation); W03b treats that error as failed/exec_failed and performs zero writes. Do not allow access-denied registry reads to become `policyManaged=false`. The sibling W01b draft now explicitly maps policy read errors to `PolicyManaged=true` (`2026-09-28-time-sync-w01b-agent-collector.md:1713–1731`), resolving the representation safely if that code is what merges. Pin it in the index and verify its real System test before release.
4. **NT5DS compare/apply mismatch.** Spec §8.3 `:509–510` compares normalized peers and SpecialPollInterval, but the hierarchy branch at `:515` only sets `/syncfromflags:domhier /update`. Comparing dormant manual fields to policy peers would make an otherwise-correct member fail forever. **Fix proposed here:** compare Type and automatic/running service on hierarchy roles; compare hosts/poll only on manual roles. Root-PDC `/reliable:yes` is always sent during an apply, but index B contains no reliability field for read-back; native L7 explicitly verifies it without adding a new wire field.
5. **Deliberate timezone-validation deviation requested for W03b.** Spec §8.4 `:534–535` and §9 `:549` require an embedded Windows-ID list. This plan instead validates syntax and the existence of `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Time Zones\<id>` before tzutil, for both automatic and command writes. **Fix:** record this approved change in the spec/index; server CLDR validation remains W03a, and the agent checks the installed Windows catalog rather than maintaining a second embedded list.
6. **Policy-probe line reference has drifted.** Index H `:565` points to `heartbeat.go ~3182`; the actual early return is `agent/internal/heartbeat/heartbeat.go:3204–3206`, with the insertion anchor at `:3194`. **Fix:** use Task 5's verified anchor above the block and retain the dispatch regression test.

7. **The emerging W01b pending-snapshot protocol is not in index H.** The concurrently authored W01b plan at `2026-09-28-time-sync-w01b-agent-collector.md:1671` returns cached pending data, with `Acknowledge(sequence uint64) error` at `:1691`. Calling Collect repeatedly without acknowledging would make guard reads stale forever. **Fix implemented here:** Task 4 detects that optional acknowledgement interface, durably transfers each collection’s events to management state, then acknowledges before the next read; tests pin fresh guard reads and restart retention. Add this protocol and its freshness guarantee to index H and verify the final merged collector implementation. A collector without that interface must return fresh reads on each Collect as the original index implied.

SCM helper accessibility is resolved without changing the contract: `startServiceOS` at `services_windows.go:114` is unexported, so Task 2 calls exported `tools.StartService` at `services.go:97`, which delegates to that helper. `handlers.go:14–16` explicitly supports init registration, so the plan intentionally does not edit its registry literal.

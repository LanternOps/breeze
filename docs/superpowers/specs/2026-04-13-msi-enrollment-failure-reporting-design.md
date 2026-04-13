# MSI Enrollment Failure Reporting — Design

**Date:** 2026-04-13
**Issue:** [#411](https://github.com/LanternOps/breeze/issues/411) — `[Installer] MSI install rolls back with 1603 when enrollment fails or is skipped`
**Status:** Draft — pending user review
**Target release:** v0.63.x (not a hotfix)

## Problem

The Breeze MSI currently fails with exit code 1603 (full rollback) whenever the `BreezeAgent` Windows service cannot start during the `InstallServices` standard action. The cascade is:

1. `EnrollAgent` custom action runs (or is skipped if no creds were supplied).
2. `InstallServices` starts `BreezeAgent` because `<ServiceControl Start="install" Wait="yes" />`.
3. `breeze-agent run` → `startAgent()` → `cfg.AgentID == ""` → returns `"agent not enrolled — run 'breeze-agent enroll <key>' first"` → process exits non-zero.
4. Windows SCM reports `Error 1920: Service 'Breeze Agent' failed to start`.
5. `<ServiceInstall Vital="yes" />` promotes that to a fatal install failure → MSI rolls back everything → `msiexec` exits 1603.

Two real failure modes both hit this cascade:
- **No creds supplied** (`msiexec /i breeze-agent.msi /qn`) — the Launch condition explicitly allows this for deferred enrollment, yet the install fails.
- **Bad creds supplied** (typo in key, wrong server URL, server unreachable) — the enroll CA exits non-zero but `Return="ignore"` swallows it; the cascade then fires on the unenrolled service.

In both cases the *cause* of the failure is invisible to the admin. `install.log` shows `Error 1920` but not `"401 Unauthorized: enrollment key not recognized"`. The admin sees 1603 and has no actionable signal.

## Goals

1. **`msiexec /qn` with no credentials succeeds.** Service is installed and starts into a "waiting for enrollment" idle loop. A later `breeze-agent enroll KEY --server URL` is picked up live without a service restart. Required for imaged/sysprep'd deployments and golden images.
2. **`msiexec /qn` with bad credentials fails loudly.** Install cleanly rolls back, msiexec exits non-zero, and a human-readable cause lands in *at least four* places the admin can find without knowing Breeze's internals.
3. **`msiexec /qn` with good credentials continues to work** exactly as it does today on the happy path.

## Non-goals

- MSI UI-mode error dialogs with specific cause text. Would require a DLL custom action wrapper; not worth the build complexity for this PR. Dialogs stay generic ("A custom action failed"); the actionable text is in install.log and Event Viewer.
- Automatic retry of failed enrollment from inside the MSI. A failed enroll rolls back; re-running msiexec with a fixed key is the retry path.
- Cross-platform enrollment failure reporting (.pkg, .deb, .rpm). The four output sinks are cross-platform but the MSI-specific plumbing is Windows-only.
- Changing the enrollment API endpoint or payload.

## Design decisions (confirmed with user in brainstorming)

| # | Decision | Reason |
|---|---|---|
| 1 | Scenario "no creds" → install succeeds, service runs idle | Imaged/sysprep'd deployment, golden images. Matches modern agent UX (Datto, Ninja). |
| 2 | Scenario "bad creds" → install fails cleanly | Prevents silent half-success on typos in mass deployments. |
| 3 | `startAgent` wait-for-enrollment loop is **unconditional**, not gated on a config flag | Gating on `cfg.WaitForEnrollment` is a chicken-and-egg problem — the flag lives in `agent.yaml` which is exactly what's missing. Applies cross-platform for symmetry. |
| 4 | Error text is delivered via **four sinks simultaneously**: stderr, `agent.log`, `enroll-last-error.txt`, Windows Event Log | Admins look in different places depending on deployment tool (GPO, Intune, manual msiexec). Write once, route everywhere. |
| 5 | No MSI dialog path (no DLL CA wrapper) | Keeps build simple. `/qn` is the dominant deployment mode; dialog value is marginal. |

## Architecture

```
  msiexec /i breeze.msi [ENROLLMENT_KEY=... SERVER_URL=...] /qn /l*v install.log
                              │
                              ▼
                      InstallFiles (copies breeze-agent.exe, etc.)
                              │
                              ▼
     ┌─────── EnrollAgent CA: breeze-agent.exe enroll --quiet ───────┐
     │                                                                │
     │  ENROLLMENT_KEY missing?  →  CA condition false, CA skipped    │
     │                                                                │
     │  enroll succeeds           →  exit 0                           │
     │                                                                │
     │  enroll fails (401/404/   →  enrollError() routes to 4 sinks:  │
     │    network/timeout/5xx)      1. stderr  → install.log          │
     │                              2. agent.log (slog)               │
     │                              3. enroll-last-error.txt          │
     │                              4. Windows Event Log              │
     │                             exit 10..16 (category)             │
     │                             Return="check" → MSI rolls back    │
     └────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                      InstallServices
                              │
                              ▼
               BreezeAgent service starts
                              │
                              ▼
              startAgent() — configuration check
                              │
         ┌────────── AgentID present? ──────────┐
         │                                      │
         │ yes                                  │ no
         ▼                                      ▼
  Normal startup path              waitForEnrollment() loop:
  (heartbeat, shipper, mTLS,         reload config every 10s;
   WS connection)                    unblock on non-empty AgentID.
                                     SCM sees Running throughout.
```

The service is always in `Running` state from SCM's perspective, whether or not enrollment has completed. "Enrolled" is an internal state, not an SCM state. This matches how Datto/Ninja/etc. behave and avoids the "did I start the service" footgun.

## Components

### Component 1 — Go agent: wait-for-enrollment loop

**File:** `agent/cmd/breeze-agent/main.go`

**Change:** Replace the hard error at line 239 (`return nil, fmt.Errorf("agent not enrolled ...")`) with a new helper `waitForEnrollment()` that polls `config.Load(cfgFile)` every 10 seconds until `AgentID` is non-empty.

```go
// waitForEnrollment blocks until agent.yaml contains a valid AgentID.
// Intended for post-MSI-install scenarios where the service starts before
// a later breeze-agent enroll call populates the config. Unconditional on
// all platforms; callers that need a timeout must wrap this.
func waitForEnrollment() *config.Config {
    log.Warn("agent not enrolled — waiting for enrollment (poll every 10s). " +
        "Run 'breeze-agent enroll <key> --server <url>' to complete setup.")
    eventlog.Info("BreezeAgent",
        "Waiting for enrollment. Run 'breeze-agent enroll <key> --server <url>'.")

    for {
        time.Sleep(10 * time.Second)
        cfg, err := config.Load(cfgFile)
        if err != nil {
            log.Debug("config reload failed while waiting for enrollment",
                "error", err.Error())
            continue
        }
        if cfg.AgentID != "" {
            log.Info("enrollment detected, continuing startup",
                "agentId", cfg.AgentID)
            return cfg
        }
    }
}
```

Inside `startAgent()`:

```go
if cfg.AgentID == "" {
    cfg = waitForEnrollment()
}
```

**Caveat — logging order:** today's `startAgent` calls `initLogging(cfg)` *after* the AgentID check. For the wait loop to log, `initLogging(cfg)` must be hoisted to run *before* the check. This is safe: `config.Load` returns `config.Default()` with env merges when `agent.yaml` is absent (verified in `agent/internal/config/config.go:185-204`), so `cfg.LogFile` has a default value and the file logger can initialize. Log shipping, heartbeat registration, and mTLS init stay downstream of the wait loop — they require an AgentID to function and are meaningless until enrollment completes.

**Platform behaviour:**
- **Windows service:** relies on Component 4 to signal Running before this blocks.
- **macOS launchd / Linux systemd:** no start deadline, wait loop is free. Service state is "running" from the init system's view throughout.
- **Console mode (`breeze-agent run` from a terminal):** identical wait loop, prints the Warn line to the terminal and idles until interrupted or enrolled.

### Component 2 — Go enroll command: structured errors + four output sinks

**Files:**
- Create: `agent/cmd/breeze-agent/enroll_error.go`
- Create: `agent/cmd/breeze-agent/enroll_error_test.go`
- Modify: `agent/cmd/breeze-agent/main.go` (route all enroll failure paths through `enrollError`)
- Modify: `agent/pkg/api/client.go` (add `ErrHTTPStatus` type; return it from `Enroll` on non-200)

**New type in `agent/pkg/api/client.go`:**

```go
// ErrHTTPStatus is returned by the api client when an HTTP request completes
// but the server returned a non-success status code. Callers can type-assert
// to classify the failure (auth, not found, rate limit, server error).
type ErrHTTPStatus struct {
    StatusCode int
    Body       string
}

func (e *ErrHTTPStatus) Error() string {
    return fmt.Sprintf("http %d: %s", e.StatusCode, e.Body)
}
```

Modify `Client.Enroll` line 125-127 to return `&ErrHTTPStatus{StatusCode: resp.StatusCode, Body: string(bodyBytes)}` instead of the current generic `fmt.Errorf`.

**New helper in `agent/cmd/breeze-agent/enroll_error.go`:**

```go
type enrollErrCategory int

const (
    catNetwork   enrollErrCategory = iota // dial/DNS/TLS/timeout
    catAuth                               // 401, 403
    catNotFound                           // 404
    catRateLimit                          // 429
    catServer                             // 5xx
    catConfig                             // save failed, perms
    catUnknown
)

// exitCode returns the process exit code for this category.
// Range 10..16 keeps the categories distinguishable in install.log
// without colliding with Go's default exit code (2 for runtime errors).
func (c enrollErrCategory) exitCode() int { return int(c) + 10 }

// enrollError writes a human-readable failure line to all four sinks
// (stderr → install.log, agent.log, enroll-last-error.txt, Windows Event
// Log) and exits the process with a category-specific code. Never returns.
//
// Injectable dependencies (exit, writeLastErrorFile, eventLogError) are
// package-level vars so tests can intercept without patching os.Exit.
func enrollError(cat enrollErrCategory, friendly string, detail error) {
    line := fmt.Sprintf("Enrollment failed: %s", friendly)
    if detail != nil {
        line += fmt.Sprintf(" (%v)", detail)
    }
    fmt.Fprintln(os.Stderr, line)
    log.Error("enrollment failed",
        "category", cat, "friendly", friendly, "error", detail)
    writeLastErrorFile(line)
    eventLogError("BreezeAgent", line)
    osExit(cat.exitCode())
}

// classifyEnrollError inspects an error from api.Client.Enroll and returns
// the appropriate category + user-facing message.
func classifyEnrollError(err error, serverURL string) (enrollErrCategory, string) {
    if err == nil {
        return catUnknown, ""
    }
    var httpErr *api.ErrHTTPStatus
    if errors.As(err, &httpErr) {
        switch {
        case httpErr.StatusCode == 401 || httpErr.StatusCode == 403:
            return catAuth, "enrollment key not recognized — verify the key " +
                "is active in Settings → Enrollment on the server"
        case httpErr.StatusCode == 404:
            return catNotFound, fmt.Sprintf(
                "enrollment endpoint not found on %s — check that SERVER_URL "+
                    "is correct (did you include /api or point at the wrong host?)",
                serverURL)
        case httpErr.StatusCode == 429:
            return catRateLimit, "rate limited by server — wait one minute " +
                "and retry the install"
        case httpErr.StatusCode >= 500:
            return catServer, fmt.Sprintf(
                "server error %d — contact Breeze support if this persists",
                httpErr.StatusCode)
        }
    }
    // Network-layer errors: dial, DNS, TLS, timeout, conn refused
    var urlErr *url.Error
    if errors.As(err, &urlErr) {
        return catNetwork, fmt.Sprintf(
            "server unreachable at %s — check firewall, DNS, and that "+
                "SERVER_URL is correct",
            serverURL)
    }
    return catUnknown, err.Error()
}
```

**Changes to `enrollDevice` in `main.go`:**

Every `fmt.Fprintf(os.Stderr, ...)` + `os.Exit(1)` pair gets replaced with a call to `enrollError`:

| Line | Before | After |
|---|---|---|
| 620-622 | "Server URL required" → exit 1 | `enrollError(catConfig, "server URL required — pass --server or set in config", nil)` |
| 701-704 | `client.Enroll` error → exit 1 | `cat, friendly := classifyEnrollError(err, cfg.ServerURL); enrollError(cat, friendly, err)` |
| 730-735 | `config.SaveTo` error → exit 1 | `enrollError(catConfig, "could not save agent.yaml — check that "+filepath.Dir(cfgFile)+" exists and is writable", err)` |

**Sinks:**

1. **stderr** — written directly by `enrollError`. Captured by `msiexec /l*v install.log` into the CustomAction section.
2. **agent.log** — written via the existing `logging` package's slog output. Requires minimal logging init in `enrollDevice` before the first failure can fire. The merged #410 PR already added structured logging init to `enrollDevice`; we reuse it.
3. **`enroll-last-error.txt`** — a new single-line plain-text file at `filepath.Join(config.ConfigDir(), "logs", "enroll-last-error.txt")`. Overwritten on each attempt. Format: `<RFC3339 timestamp> — <line>\n`. World-readable (0644). Mirrors the existing `writeStartupFailureMarker` pattern at `service_windows.go:24` but serves the enroll scope.
4. **Windows Event Log** — a new `internal/eventlog` package wrapping `golang.org/x/sys/windows/svc/eventlog`. Source name `BreezeAgent`. Event IDs: 1001 (info), 1002 (warning), 1003 (error). No-op stubs on macOS and Linux so the main.go call sites stay cross-platform.

### Component 3 — WiX MSI: enroll CA now fails cleanly

**File:** `agent/installer/breeze.wxs`

**Change A:** `<CustomAction Id="EnrollAgent" ... Return="ignore" />` → `Return="check"`.

When the enroll CA exits non-zero, `Return="check"` makes MSI treat it as fatal and rolls back the install. Because the CA is conditional on `SERVER_URL AND ENROLLMENT_KEY`, this only affects the "creds supplied" scenario — the "no creds" path skips the CA entirely and can never trigger a rollback.

**Change B:** `<ServiceInstall ... Vital="yes" />` and `<ServiceControl Start="install" Wait="yes" />` are **unchanged**. The service still starts during `InstallServices`; Component 1 makes that start succeed even without enrollment.

**Change C:** Replace the existing WiX XML comment above the `EnrollAgent` action with:

```xml
<!-- Enrollment runs after file copy but before InstallServices.
     Return="check" means a failure rolls back the install cleanly — admins
     see a specific cause in install.log and Event Viewer instead of 1603
     with no explanation.

     Installs without ENROLLMENT_KEY skip this CA entirely. The service
     starts anyway and idles in a wait-for-enrollment loop (see
     waitForEnrollment in cmd/breeze-agent/main.go), so a later
     `breeze-agent enroll KEY --server URL` is picked up live without a
     service restart. This is the intended flow for imaged/sysprep'd
     deployments. -->
```

**No change** to `InstallExecuteSequence` conditions, `SetEnrollAgentData` (already removed by #410), or the launch conditions.

### Component 4 — Windows service wrapper: signal Running before startFn blocks

**File:** `agent/cmd/breeze-agent/service_windows.go`

**Current code (lines 117-133):**

```go
func (s *breezeService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
    const accepted = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange

    changes <- svc.Status{State: svc.StartPending}

    comps, err := s.startFn()        // BLOCKS if wait loop is active
    if err != nil {
        ...
    }

    changes <- svc.Status{State: svc.Running, Accepts: accepted}  // too late
    log.Info("agent running as Windows service")

    for { /* SCM control loop */ }
}
```

The Running transition happens *after* `startFn` returns, which is fine today (startFn exits quickly) but breaks once `waitForEnrollment` can block for minutes or hours. SCM's default start deadline is 30 seconds; exceeding it kills the process.

**New flow:**

```go
func (s *breezeService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
    const accepted = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange

    changes <- svc.Status{State: svc.StartPending}
    // Promote to Running immediately. The startFn goroutine may spend a
    // long time in waitForEnrollment, but from SCM's perspective the
    // service is healthy and responding to control requests.
    changes <- svc.Status{State: svc.Running, Accepts: accepted}
    log.Info("agent running as Windows service (enrollment status pending)")

    compsCh := make(chan *agentComponents, 1)
    errCh := make(chan error, 1)
    go func() {
        comps, err := s.startFn()
        if err != nil {
            errCh <- err
            return
        }
        compsCh <- comps
    }()

    var comps *agentComponents
    for {
        select {
        case c := <-compsCh:
            comps = c
            // SCM session dispatch only works once comps is available.
            if comps != nil {
                // wire up session change channel as before
            }
        case err := <-errCh:
            log.Error("agent start failed", "error", err.Error())
            writeStartupFailureMarker(err)
            changes <- svc.Status{State: svc.StopPending}
            return true, 1
        case cr := <-r:
            // (existing SCM control request handling, gated on comps != nil
            //  for session-change events)
        }
    }
}
```

**Implication:** the `SessionChange` event handling (lines 146-158) currently dereferences `comps.hb` directly. Once we make start asynchronous, those events may arrive before `comps` is set. The fix is to buffer the most recent session-change event and replay it once `comps` becomes available, or to simply drop events that arrive before startup completes (the session broker will catch up on its next reconcile tick). The design prefers the drop-and-reconcile path — session change events are advisory, and the reconciliation loop is already the authoritative source for session state.

### Component 5 — Event log wrapper

**Files:**
- Create: `agent/internal/eventlog/eventlog.go` (no-op stub, build tag `!windows`)
- Create: `agent/internal/eventlog/eventlog_windows.go` (wraps `golang.org/x/sys/windows/svc/eventlog`)
- Create: `agent/internal/eventlog/eventlog_test.go`

**API:**

```go
package eventlog

// Info writes an informational event to the OS event log (Windows
// Application log; no-op on other platforms). Source is a short name
// like "BreezeAgent". Safe to call before the event source is formally
// registered — on Windows, the package lazily registers via
// InstallAsEventCreate on first use, wrapped in sync.Once.
func Info(source, message string)

// Warning writes a warning event.
func Warning(source, message string)

// Error writes an error event.
func Error(source, message string)
```

**Windows implementation notes:**

- Lazy registration via `eventlog.InstallAsEventCreate(source, eventlog.Info|eventlog.Warning|eventlog.Error)`. If registration fails because the source already exists, fall back to `eventlog.Open(source)`. If that also fails (non-admin process, corrupted registry), drop silently — the other three sinks already cover the failure.
- Event IDs are fixed at 1001/1002/1003 for now. A future refinement could use per-component IDs.
- `sync.Once` guards registration. Package-level `registeredSources map[string]*eventlog.Log` caches open handles keyed by source name.

**Non-Windows stub:**

```go
//go:build !windows
package eventlog
func Info(source, message string)    {}
func Warning(source, message string) {}
func Error(source, message string)   {}
```

## Testing

### Unit tests

**`agent/cmd/breeze-agent/enroll_error_test.go`** (cross-platform):
- `classifyEnrollError` with fake `api.ErrHTTPStatus` at every category boundary (401, 403, 404, 429, 500, 503) → assert correct category + message.
- `classifyEnrollError` with a synthetic `url.Error` wrapping `net.OpError` → asserts `catNetwork`.
- `enrollError` with injectable `osExit` and `writeLastErrorFile` hooks → assert stderr received the line, the last-error file hook was called, the event-log hook was called, and `osExit` received the category's exit code.

**`agent/internal/eventlog/eventlog_test.go`** (cross-platform):
- Non-Windows: calling `Info/Warning/Error` is a no-op and does not panic.
- Windows-gated: compile only (runtime registration requires admin in CI, skip).

**`agent/cmd/breeze-agent/main_test.go`** (cross-platform):
- Add `TestWaitForEnrollment` — writes an empty agent.yaml, spawns `waitForEnrollment` in a goroutine, writes a valid agent.yaml 500ms later, asserts the goroutine returns with the populated config. Use a test hook to shrink the poll interval from 10s to 50ms.
- Add `TestWaitForEnrollmentStaysBlockedOnEmptyConfig` — poll never unblocks for 1s, test cancels via `runtime.Goexit` or a context.

**`agent/cmd/breeze-agent/service_windows_test.go`** (`//go:build windows`):
- Mock `svc.Handler` — drive `Execute` with a fake `changes` channel, assert `svc.Running` is sent *before* `startFn` is called. Use a `startFn` that blocks on a channel so the test can observe the state transition without racing.

### Manual MSI smoke tests

The following scenarios must be verified on a Windows Server 2022 VM before merge. Documented here, not automated in this PR — automation is #412.

| # | Command | Expected |
|---|---|---|
| 1 | `msiexec /i breeze-agent.msi /qn /l*v install.log` (no creds) | msiexec exit 0. Service installed + Running. `agent.yaml` absent. `enroll-last-error.txt` absent. Event Viewer: BreezeAgent info "Waiting for enrollment". |
| 2 | `msiexec /i breeze-agent.msi ENROLLMENT_KEY=brz_valid SERVER_URL=https://valid.example /qn /l*v install.log` (good creds) | msiexec exit 0. Service installed + Running. `agent.yaml` present with AgentID. No enroll error files. |
| 3 | `msiexec /i breeze-agent.msi ENROLLMENT_KEY=brz_typo SERVER_URL=https://valid.example /qn /l*v install.log` (bad key) | msiexec exit 1603. No residual files in `C:\Program Files\Breeze`. Service not installed. `install.log` contains `Enrollment failed: enrollment key not recognized`. `enroll-last-error.txt` absent (it's in ProgramData which is also rolled back? verify — may need to be in a non-rollback directory). Event Viewer: BreezeAgent error entry. |
| 4 | `msiexec /i breeze-agent.msi ENROLLMENT_KEY=brz_valid SERVER_URL=https://unreachable.example /qn /l*v install.log` (network) | msiexec exit 1603. Install.log contains `Enrollment failed: server unreachable ...`. |
| 5 | Scenario 1 followed by `breeze-agent enroll brz_valid --server https://valid.example` run interactively (elevated shell) | Enroll succeeds. Running service picks up new config within 10s (one wait-loop tick). No service restart required. |

**Caveat on test 3:** `enroll-last-error.txt` lives in `C:\ProgramData\Breeze\logs\`, which is managed by `cmpProgramDataLogs` with `Permanent="yes"`. The `Permanent` attribute means the directory is not removed on rollback, so the file should survive a 1603 rollback. Must verify during testing — if the file does get removed, move the last-error path to `%TEMP%\breeze-enroll-last-error.txt` as a fallback.

## File-by-file summary

**Create:**
- `agent/cmd/breeze-agent/enroll_error.go`
- `agent/cmd/breeze-agent/enroll_error_test.go`
- `agent/internal/eventlog/eventlog.go` (`//go:build !windows`)
- `agent/internal/eventlog/eventlog_windows.go`
- `agent/internal/eventlog/eventlog_test.go`
- `docs/superpowers/specs/2026-04-13-msi-enrollment-failure-reporting-design.md` (this file)

**Modify:**
- `agent/cmd/breeze-agent/main.go` — `startAgent` calls `waitForEnrollment` instead of erroring; `enrollDevice` routes all failure paths through `enrollError`; add `waitForEnrollment` helper.
- `agent/cmd/breeze-agent/service_windows.go` — `Execute` signals Running before `startFn`, runs `startFn` in a goroutine, handles session-change events defensively.
- `agent/cmd/breeze-agent/main_test.go` — `TestWaitForEnrollment` + staying-blocked variant.
- `agent/cmd/breeze-agent/service_windows_test.go` — may not exist; create if absent. Windows-gated test for Running-before-startFn ordering.
- `agent/pkg/api/client.go` — add `ErrHTTPStatus` type; `Enroll` returns it on non-200.
- `agent/installer/breeze.wxs` — `EnrollAgent` CA `Return="check"`; updated XML comment.

**Not touched:**
- `agent/internal/config/` — no schema changes.
- `agent/internal/logging/` — reused as-is.
- `agent/installer/build-msi.ps1` — no changes.
- `.github/workflows/release.yml` — no changes.
- `docs/superpowers/plans/2026-04-12-registry-based-msi-enrollment.md` — #410 is already merged; this design builds on that foundation without touching it.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| SCM start deadline fires during startFn before `comps` is ready | Low (Running is signaled immediately) | Component 4 signals Running on Execute entry; SCM treats the process as started regardless of startFn progress. |
| Session change events arrive before `comps` is wired up | Medium | Drop events during the pre-comps window; session broker reconciliation loop is the authoritative source and will catch up. |
| `enroll-last-error.txt` is removed during MSI rollback | Medium | `cmpProgramDataLogs` uses `Permanent="yes"`; verify during manual testing. Fallback: write to `%TEMP%`. |
| Event Log source registration fails (non-admin helper process) | Low | Registration is best-effort wrapped in `sync.Once`; failure is silent and the other three sinks still fire. |
| `classifyEnrollError` miscategorizes a new server response | Low | The classifier falls through to `catUnknown` which still produces a readable error message using the raw error string. |
| Cross-platform `waitForEnrollment` blocks macOS/Linux console users unexpectedly | Low | The Warn line is explicit about what's happening and how to exit. Console users can Ctrl+C. Systemd/launchd users see the wait state in `journalctl` / `log show`. |
| A running service that's waiting for enrollment wastes memory/CPU indefinitely | Very low | The poll loop sleeps 10s between parses of a 2KB YAML file. Baseline cost is negligible; far cheaper than a failed install plus a support ticket. |

## Open questions

None. All questions raised during brainstorming (Q1/Q2/Q3) were resolved with the user.

## Follow-ups (not in scope)

- **#412** — CI workflow to build and test a signed MSI without cutting a full release. Would let us automate the five manual smoke-test scenarios above.
- **Dialog-mode error presentation** — a small DLL CA wrapper that calls `MsiProcessMessage` with the friendly text, so UI-mode installs also show the specific cause. Deferred pending demand.
- **Per-component Event Log IDs** — currently all events use 1001/1002/1003. Could add a registry of stable event IDs per subsystem (enroll=2001, heartbeat=3001, etc.) for easier filtering in SIEM tools.
- **`BreezeAgent` Event Log source registration at install time** — currently we register lazily on first use, which races with non-admin processes. A dedicated MSI custom action could register the source during install with SYSTEM credentials. Low priority — lazy registration has worked fine for every other agent-style product.

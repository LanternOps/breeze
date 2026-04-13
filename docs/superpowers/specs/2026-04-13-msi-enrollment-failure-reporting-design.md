# MSI Enrollment Failure Reporting — Design

**Date:** 2026-04-13
**Issue:** [#411](https://github.com/LanternOps/breeze/issues/411) — `[Installer] MSI install rolls back with 1603 when enrollment fails or is skipped`
**Status:** Draft v2 — addresses P1/P2/P3/P4 from first review
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
| 3 | Wait-for-enrollment loop is **unconditional** (not gated on a config flag) but runs **only on the unenrolled branch** | Gating on `cfg.WaitForEnrollment` is a chicken-and-egg problem — the flag lives in `agent.yaml` which is exactly what's missing. But the enrolled path must stay synchronous (see Decision 6) so today's "bad mTLS / bad heartbeat init fails the install" guarantee is preserved. |
| 4 | Error text is delivered via **four sinks simultaneously**: stderr, `agent.log`, `enroll-last-error.txt`, Windows Event Log | Admins look in different places depending on deployment tool (GPO, Intune, manual msiexec). Write once, route everywhere. |
| 5 | No MSI dialog path (no DLL CA wrapper) | Keeps build simple. `/qn` is the dominant deployment mode; dialog value is marginal. |
| 6 | Service `Execute` uses **two distinct start paths**: synchronous when already enrolled (today's behavior), async-after-Running when waiting for enrollment | P1 fix. Keeps today's "post-enroll mTLS / heartbeat / state-file failures fail the MSI install" guarantee on the happy path. Only the deferred-enrollment branch signals Running early, and only there can post-Running startup failures occur — which is acceptable because the install was intentionally no-creds and the admin expects async completion. |
| 7 | Waiter gates on a **complete enrolled state** (`AgentID != "" && AuthToken != ""`), exposed as `config.IsEnrolled(cfg)` | P2 fix. `config.SaveTo` writes `agent.yaml` before `secrets.yaml` (`agent/internal/config/config.go:313-376`); `AgentID` alone would let the waiter observe a torn write. Checking both fields is self-healing — on the rare torn read, the loop simply tries again 10s later. |
| 8 | `enroll-last-error.txt` is **removed at the start of each enroll attempt**, and `enrollError` rewrites it on failure | P3 fix. Prevents stale error files from lingering after a successful retry. Smoke-test scenario 1 (no-creds success) now verifies the file is absent. |
| 9 | `waitForEnrollment` takes `context.Context` and a pluggable `pollInterval` | P4 fix. Tests pass a cancellable context and a short interval (e.g. 10ms) so they can assert wait/unblock behavior without leaking goroutines or waiting 10s. Production callers pass `context.Background()` and the default 10s interval. |

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
              Execute() — config.Load + IsEnrolled(cfg)
                              │
         ┌── IsEnrolled(cfg)? ──┐
         │                      │
         │ yes                  │ no
         ▼                      ▼
  Synchronous path        Async path
  (today's behavior)      ───────────
  ────────────────        1. signal Running immediately
  1. startAgent(cfg)      2. waitForEnrollment(ctx, cfgFile)
     initializes heart-      polls every 10s, unblocks on
     beat, shipper,          IsEnrolled; SCM control loop
     mTLS, WS                still processes Stop/Shutdown
  2. any failure →        3. startAgent(enrolledCfg) runs
     MSI rollback           post-install; failures are
     (goal 3 preserved)     logged and stop the service
  3. signal Running         but cannot roll back the MSI
  4. enter service          (install already succeeded)
     control loop        4. enter service control loop
```

Decision 6 is the key architectural principle: enrolled installs keep today's strict semantics (any post-enroll init failure fails the install), while unenrolled installs are allowed to succeed early and finish setup later. This preserves goal 3 for the happy path and delivers goal 1 for imaged/sysprep'd deployments, without conflating the two.

## Components

### Component 1 — Go agent: split startAgent, add `waitForEnrollment` and `IsEnrolled`

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go`
- Modify: `agent/internal/config/config.go` (add `IsEnrolled` helper)

**Change 1.a — `config.IsEnrolled` helper:**

```go
// IsEnrolled reports whether cfg represents a complete enrollment — both
// the AgentID (written to agent.yaml) and the AuthToken (written to
// secrets.yaml). Callers that poll for enrollment readiness MUST use this
// predicate rather than checking AgentID alone, because SaveTo writes
// agent.yaml before secrets.yaml and a concurrent reader can otherwise
// observe a torn write.
func IsEnrolled(cfg *Config) bool {
    return cfg != nil && cfg.AgentID != "" && cfg.AuthToken != ""
}
```

**Change 1.b — split `startAgent` into config load + real startup:**

`startAgent()` today does three things: load config, check enrollment, and run the full startup pipeline. Split those:

```go
// startAgent performs the full startup pipeline assuming cfg is already
// enrolled. Returns the running components or an error if any
// initialization step fails (mTLS load, log shipper init, heartbeat
// bring-up, etc.). This function MUST NOT be called with an unenrolled
// cfg — callers must check config.IsEnrolled first and wait if needed.
func startAgent(cfg *config.Config) (*agentComponents, error) {
    // (existing body of startAgent from line 243 onward — FixConfigPermissions,
    //  initLogging, safemode check, mTLS cert load, log shipper, heartbeat,
    //  websocket connect. No behavior change.)
}
```

The enrollment check currently at `main.go:230-240` is removed from `startAgent`; callers (the service wrapper and the console-mode runner) are responsible for ensuring the config is enrolled before calling `startAgent`.

**Change 1.c — `waitForEnrollment` with context and pluggable interval:**

```go
// waitForEnrollmentPollInterval is the default wait-loop poll interval.
// Exposed as a package-level var so tests can shrink it without waiting
// real seconds.
var waitForEnrollmentPollInterval = 10 * time.Second

// waitForEnrollment polls agent.yaml + secrets.yaml every pollInterval
// until config.IsEnrolled(cfg) returns true, then returns the enrolled
// config. Returns nil if ctx is cancelled before enrollment completes.
//
// Intended for post-MSI-install scenarios where the service starts before
// a later `breeze-agent enroll` call populates the config. The ctx allows
// the caller (service wrapper or console-mode runner) to cancel the wait
// on shutdown, preventing goroutine leaks in tests and clean service
// stops in production.
func waitForEnrollment(ctx context.Context, cfgFile string) *config.Config {
    log.Warn("agent not enrolled — waiting for enrollment. " +
        "Run 'breeze-agent enroll <key> --server <url>' to complete setup.",
        "pollInterval", waitForEnrollmentPollInterval)
    eventlog.Info("BreezeAgent",
        "Waiting for enrollment. Run 'breeze-agent enroll <key> --server <url>'.")

    ticker := time.NewTicker(waitForEnrollmentPollInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            log.Info("waitForEnrollment cancelled", "reason", ctx.Err().Error())
            return nil
        case <-ticker.C:
            cfg, err := config.Load(cfgFile)
            if err != nil {
                log.Debug("config reload failed while waiting for enrollment",
                    "error", err.Error())
                continue
            }
            if config.IsEnrolled(cfg) {
                log.Info("enrollment detected, continuing startup",
                    "agentId", cfg.AgentID)
                return cfg
            }
        }
    }
}
```

**Change 1.d — console-mode runner (`runAgent`):**

The cross-platform console-mode path (invoked by `breeze-agent run` from a terminal, and by the macOS/Linux service managers that exec the agent binary as PID 1 of their service unit) now handles the wait loop directly before calling `startAgent`. The context is wired to `SIGINT`/`SIGTERM` via `signal.NotifyContext` so Ctrl+C in a terminal and `systemctl stop` / `launchctl kickstart -k` from the service manager all cancel the wait cleanly:

```go
func runAgent() {
    cfg, err := config.Load(cfgFile)
    if err != nil { /* fatal */ }
    initBootstrapLogging(cfg) // minimal init; full init happens in startAgent

    // Wire cancellation to OS signals so waitForEnrollment, startAgent,
    // and the main event loop all observe the same shutdown trigger.
    // signal.NotifyContext installs a signal handler that cancels ctx
    // on SIGINT or SIGTERM and restores the default handler on stop().
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    if !config.IsEnrolled(cfg) {
        cfg = waitForEnrollment(ctx, cfgFile)
        if cfg == nil {
            // ctx cancelled before enrollment arrived — clean exit.
            log.Info("agent shutting down without enrollment",
                "reason", ctx.Err().Error())
            return
        }
    }

    comps, err := startAgent(cfg)
    if err != nil { /* fatal */ }
    // enter run loop as today; ctx is passed through to shutdown plumbing
    // where it replaces the existing ad-hoc signal handling.
}
```

**Note on `service_windows.go`:** the Windows SCM service wrapper does NOT use `signal.NotifyContext` — SCM `Stop`/`Shutdown` requests arrive on the `<-chan svc.ChangeRequest` channel, not via `os.Interrupt`. The Windows wait loop uses its own `context.WithCancel` and cancels explicitly when it observes `svc.Stop` / `svc.Shutdown` on the request channel (see Component 4). Both paths converge on the same guarantee: `ctx.Done()` fires on legitimate shutdown signals for the host platform, and `waitForEnrollment` returns `nil` cleanly.

**Caveat — bootstrap logging:** today's `startAgent` calls `initLogging(cfg)` once, inline. We need logging available *before* the enrollment check (so `waitForEnrollment` can emit Warn/Info lines). Introduce a small `initBootstrapLogging(cfg)` that initializes only the stderr + file writers — no log shipper, no event-log init beyond the eventlog package's lazy path. `startAgent` retains `initLogging(cfg)` as today for any call-site that needs a re-init after enrollment arrives (if logging configuration can change on enrollment — it probably can't, but the re-init is a no-op in that case). Verify during implementation that `logging.Init` is idempotent.

**Platform behaviour:**
- **Windows service:** the service wrapper (Component 4) decides which path to take and only the unenrolled branch enters `waitForEnrollment`. The enrolled branch calls `startAgent` directly with its existing synchronous failure semantics.
- **macOS launchd / Linux systemd:** no SCM deadline concerns. The console-mode `runAgent` path above is what's invoked by the service; the wait loop is free.
- **Manual console (`breeze-agent run` from a terminal):** identical wait loop, prints the Warn line to the terminal and idles until Ctrl+C or enrollment arrives.

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

// clearEnrollLastError removes enroll-last-error.txt if present. Called
// at the start of every enrollment attempt so a successful retry leaves
// no residual error file for admins to find. Errors from os.Remove are
// silently ignored — the file may legitimately not exist, and we cannot
// fail an enrollment attempt over cleanup bookkeeping.
func clearEnrollLastError() {
    path := enrollLastErrorPath()
    if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
        log.Debug("could not clear stale enroll-last-error file",
            "path", path, "error", err.Error())
    }
}

// enrollLastErrorPath returns the platform-specific path to the
// single-line enrollment error marker. Windows: under ProgramData\Breeze\logs.
// Unix: under the existing LogDir() path.
func enrollLastErrorPath() string {
    return filepath.Join(config.LogDir(), "enroll-last-error.txt")
}

// writeLastErrorFile overwrites enroll-last-error.txt with a single line
// containing the RFC3339 timestamp and the friendly failure message.
// Intended to be called only by enrollError; exposed as a package-level
// var so tests can inject a fake.
var writeLastErrorFile = func(line string) {
    path := enrollLastErrorPath()
    if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
        return
    }
    content := fmt.Sprintf("%s — %s\n", time.Now().Format(time.RFC3339), line)
    _ = os.WriteFile(path, []byte(content), 0o644)
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

Every `fmt.Fprintf(os.Stderr, ...)` + `os.Exit(1)` pair gets replaced with a call to `enrollError`. Additionally, `enrollDevice` now clears any stale `enroll-last-error.txt` **immediately after logging init and before any validation or early return** — Decision 8's contract is that every attempt starts with a clean slate, including attempts that fail on server-URL validation before reaching the HTTP call. Placing the clear after validation would leave a stale marker behind whenever the current attempt fails early, which defeats the point:

```go
func enrollDevice(enrollmentKey string) {
    cfg, err := config.Load(cfgFile)
    if err != nil {
        cfg = config.Default()
    }
    initEnrollLogging(cfg, quietEnroll)

    // Clear any stale marker from a previous failed attempt FIRST —
    // before any validation or early return. Decision 8 says every
    // attempt starts from a clean state; a validation failure later in
    // this function must not leave a stale file behind.
    clearEnrollLastError()

    if serverURL != "" {
        cfg.ServerURL = serverURL
    }
    if cfg.ServerURL == "" {
        enrollError(catConfig, "server URL required — pass --server or set in config", nil)
    }
    // ... rest of enrollDevice unchanged apart from the failure-site swaps below.
}
```

On the success path (after `config.SaveTo` returns nil), nothing further is required — the file was already removed at the start of the attempt.

The failure-site replacements:

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

### Component 4 — Windows service wrapper: split sync/async by enrollment state

**File:** `agent/cmd/breeze-agent/service_windows.go`

**Goal:** preserve today's synchronous failure semantics on the enrolled path (Decision 6) while allowing the unenrolled path to report `Running` early and finish startup later.

**Current code (lines 117-133):**

```go
func (s *breezeService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
    const accepted = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange
    changes <- svc.Status{State: svc.StartPending}
    comps, err := s.startFn()        // synchronous — failures fail install
    if err != nil { ... }
    changes <- svc.Status{State: svc.Running, Accepts: accepted}
    for { /* SCM control loop */ }
}
```

**New shape.** `runAsService` is updated to take a `cfgFile` and pass it through instead of wrapping a `startFn` closure (so the service wrapper can do its own config load and decide which path to use):

```go
func runAsService(cfgFile string) error {
    h := &breezeService{
        cfgFile: cfgFile,
        stopCh:  make(chan struct{}),
    }
    return svc.Run("BreezeAgent", h)
}

func (s *breezeService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
    const accepted = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange
    changes <- svc.Status{State: svc.StartPending}

    // Load config synchronously to decide which path to take. A load
    // error is fatal on both paths — fail the install.
    cfg, err := config.Load(s.cfgFile)
    if err != nil {
        log.Error("failed to load config", "error", err.Error())
        writeStartupFailureMarker(err)
        changes <- svc.Status{State: svc.StopPending}
        return true, 1
    }
    initBootstrapLogging(cfg)

    if config.IsEnrolled(cfg) {
        // --- Synchronous enrolled path (preserves today's behaviour) ---
        comps, err := startAgent(cfg)
        if err != nil {
            log.Error("agent start failed", "error", err.Error())
            writeStartupFailureMarker(err)
            changes <- svc.Status{State: svc.StopPending}
            return true, 1
        }
        changes <- svc.Status{State: svc.Running, Accepts: accepted}
        log.Info("agent running as Windows service")
        return runServiceLoop(comps, r, changes)
    }

    // --- Async unenrolled path (MSI install with no creds) ---
    // SCM MUST see Running before we block in waitForEnrollment or the
    // service start deadline (~30s) will kill the process.
    changes <- svc.Status{State: svc.Running, Accepts: accepted}
    log.Info("agent running as Windows service (waiting for enrollment)")

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    enrolledCh := make(chan *config.Config, 1)
    go func() {
        enrolledCh <- waitForEnrollment(ctx, s.cfgFile)
    }()

    // Stay responsive to SCM control requests while waiting. Drop session
    // change events — we have no heartbeat wired up yet, and the session
    // broker's reconciliation loop will catch up once startAgent runs.
    var enrolledCfg *config.Config
waitLoop:
    for {
        select {
        case cfg := <-enrolledCh:
            enrolledCfg = cfg
            break waitLoop
        case cr := <-r:
            switch cr.Cmd {
            case svc.Interrogate:
                changes <- cr.CurrentStatus
            case svc.Stop, svc.Shutdown:
                log.Info("SCM stop while waiting for enrollment")
                cancel()
                changes <- svc.Status{State: svc.StopPending}
                return false, 0
            }
            // svc.SessionChange: ignore. No comps yet.
        }
    }

    if enrolledCfg == nil {
        // ctx was cancelled without enrollment — SCM stop path above
        // already handled the status transition.
        return false, 0
    }

    // Now run the real startup pipeline. Failures here are post-install
    // (the MSI already believes the service started); we log, write the
    // failure marker, and stop the service.
    comps, err := startAgent(enrolledCfg)
    if err != nil {
        log.Error("agent start failed after deferred enrollment",
            "error", err.Error())
        writeStartupFailureMarker(err)
        changes <- svc.Status{State: svc.StopPending}
        return true, 1
    }
    return runServiceLoop(comps, r, changes)
}
```

`runServiceLoop(comps, r, changes)` is a small refactor of the current `for { select { r }}` block at lines 135-163 — extracted so both paths can share it.

**Post-install failure semantics.** On the async path, a failure from `startAgent(enrolledCfg)` cannot roll back the MSI (the install has long completed). The failure is logged to `agent.log`, `agent-start-failed.txt`, and Event Log, and the service transitions to Stopped. Admins debug by checking those sinks and re-running `breeze-agent enroll` with corrected parameters plus `sc start BreezeAgent`. This matches how every other agent-style product handles deferred-enrollment startup failures and is an acceptable trade-off because the admin explicitly chose a no-creds install.

**Why the enrolled path is unchanged for SCM purposes.** Today's behaviour — post-enroll mTLS failure, heartbeat init error, log shipper failure → SCM Error 1920 → MSI 1603 — is preserved exactly. The enrolled path never reaches the async code.

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
- `TestWaitForEnrollment_UnblocksWhenConfigBecomesValid`: set `waitForEnrollmentPollInterval = 10 * time.Millisecond` for the test (restore via `t.Cleanup`), write a minimal agent.yaml + secrets.yaml with both `AgentID` and `AuthToken` populated after ~30ms, spawn `waitForEnrollment(ctx, tmpCfgFile)` in a goroutine, assert it returns the populated config within 500ms.
- `TestWaitForEnrollment_RespectsContextCancel`: point at a non-existent config file, `ctx, cancel := context.WithCancel(context.Background())`, run `waitForEnrollment` in a goroutine, cancel the context after 50ms, assert the goroutine returns `nil` within another 50ms. This is the test the previous draft could not implement — now the `ctx.Done()` branch in the select makes it trivial.
- `TestWaitForEnrollment_IgnoresTornWrite`: write only agent.yaml (with AgentID) but no secrets.yaml; `waitForEnrollment` must stay blocked. After 100ms, add secrets.yaml with AuthToken; waitForEnrollment must unblock. This is the P2 regression test — `IsEnrolled` prevents the torn-read footgun.

**`agent/internal/config/config_test.go`**:
- `TestIsEnrolled`: table-driven — `{nil → false, empty → false, agentIDOnly → false, tokenOnly → false, both → true}`.

**`agent/cmd/breeze-agent/service_windows_test.go`** (`//go:build windows`) — create if absent:
- `TestExecute_EnrolledPath_SignalsRunningAfterStartFn`: write a valid enrolled config to a temp file, stub `startAgent` to return a fake `*agentComponents` without doing real work (via a package-level hook, similar to `waitForEnrollmentPollInterval`), drive `Execute` with a mock `changes` chan, assert the order of emitted states is `StartPending → Running` and that `Running` arrives *after* the stub `startAgent` is called.
- `TestExecute_UnenrolledPath_SignalsRunningBeforeWait`: write an empty config to a temp file, stub `waitForEnrollment` to block on a test-controlled channel, assert `Execute` emits `StartPending → Running` *before* any interaction with the stub. Then unblock the stub and assert it proceeds into `startAgent`.
- `TestExecute_StopWhileWaiting`: same setup as above, emit `svc.Stop` on the request channel while `waitForEnrollment` is still blocked, assert `Execute` cancels the wait context and returns.

### Manual MSI smoke tests

The following scenarios must be verified on a Windows Server 2022 VM before merge. Documented here, not automated in this PR — automation is #412.

| # | Command | Expected |
|---|---|---|
| 1 | `msiexec /i breeze-agent.msi /qn /l*v install.log` (no creds) | msiexec exit 0. Service installed + Running. `agent.yaml` absent. `enroll-last-error.txt` absent. Event Viewer: BreezeAgent info "Waiting for enrollment". |
| 2 | `msiexec /i breeze-agent.msi ENROLLMENT_KEY=brz_valid SERVER_URL=https://valid.example /qn /l*v install.log` (good creds) | msiexec exit 0. Service installed + Running. `agent.yaml` present with AgentID. No enroll error files. |
| 3 | `msiexec /i breeze-agent.msi ENROLLMENT_KEY=brz_typo SERVER_URL=https://valid.example /qn /l*v install.log` (bad key) | msiexec exit 1603. No residual files in `C:\Program Files\Breeze` (InstallFiles rolled back). Service not installed. `C:\ProgramData\Breeze\logs\` **directory exists** (kept by `cmpProgramDataLogs Permanent="yes"`). `C:\ProgramData\Breeze\logs\enroll-last-error.txt` **PRESENT**, one line, containing `<RFC3339 timestamp> — Enrollment failed: enrollment key not recognized ...`. `install.log` contains the same friendly line captured from the CA's stderr. Event Viewer → Windows Logs → Application → source `BreezeAgent` → one Error entry. |
| 4 | `msiexec /i breeze-agent.msi ENROLLMENT_KEY=brz_valid SERVER_URL=https://unreachable.example /qn /l*v install.log` (network) | Same as scenario 3 but the friendly line is `Enrollment failed: server unreachable at https://unreachable.example — check firewall, DNS, and that SERVER_URL is correct ...`. `enroll-last-error.txt` PRESENT with this content. |
| 5 | Scenario 1 followed by `breeze-agent enroll brz_valid --server https://valid.example` run interactively (elevated shell) | Enroll succeeds. Running service picks up new config within 10s (one wait-loop tick). No service restart required. `enroll-last-error.txt` still absent (scenario 1 never created it; scenario 5 is a clean success). |

**On `enroll-last-error.txt` surviving rollback (definitive expected state for scenarios 3 and 4):** the file **is expected to survive**, and scenarios 3/4 assert its presence. Rationale: MSI's rollback reverses actions that MSI tracked (`InstallFiles`, `InstallServices`, property table writes). Files written by a CA via `os.WriteFile` are opaque to MSI — the installer has no record that they were created and therefore has no mechanism to remove them on rollback. The parent directory (`C:\ProgramData\Breeze\logs\`) additionally has `Permanent="yes"` on its component, so even the directory itself is preserved through rollback (which in turn preserves the file). This is not reliance on a fragile edge case — it is the standard MSI contract for CA-written artifacts, and it is what makes the "read the error after 1603" design possible.

Manual verification is still required to confirm no surprise (UAC redirection, `ProgramData` permissions on non-English locales, antivirus auto-quarantine of freshly-written root-owned files, etc.). If verification fails in a specific environment, the documented fallback is `%ProgramData%\Breeze\logs\` → `%TEMP%\breeze-enroll-last-error.txt`. `%TEMP%` is out of the MSI's purview for the same reason and is writable from any CA context. The spec does not switch preemptively because `%ProgramData%` is the discoverable path an admin would look in for a persistent agent-managed log.

## File-by-file summary

**Create:**
- `agent/cmd/breeze-agent/enroll_error.go`
- `agent/cmd/breeze-agent/enroll_error_test.go`
- `agent/internal/eventlog/eventlog.go` (`//go:build !windows`)
- `agent/internal/eventlog/eventlog_windows.go`
- `agent/internal/eventlog/eventlog_test.go`
- `docs/superpowers/specs/2026-04-13-msi-enrollment-failure-reporting-design.md` (this file)

**Modify:**
- `agent/cmd/breeze-agent/main.go` —
  - Refactor `startAgent` to take `cfg *config.Config` and assume it is already enrolled (callers do the wait).
  - Add `waitForEnrollment(ctx, cfgFile)` helper + `waitForEnrollmentPollInterval` package var.
  - Add `initBootstrapLogging(cfg)` for pre-start logging used by the wait loop.
  - Update `runAgent` console-mode path to call `config.Load` → `IsEnrolled` check → `waitForEnrollment` → `startAgent`.
  - `enrollDevice`: call `clearEnrollLastError()` at the start of every attempt; route all failure paths through `enrollError`.
- `agent/cmd/breeze-agent/service_windows.go` —
  - `runAsService` now takes `cfgFile string` instead of a `startFn` closure.
  - `Execute` splits into enrolled (synchronous, preserves today's failure semantics) and unenrolled (reports Running early, then `waitForEnrollment` with SCM control-loop responsiveness, then `startAgent`) branches.
  - Extract the post-startup `for { select { r } }` block into a shared `runServiceLoop(comps, r, changes)` helper used by both branches.
- `agent/cmd/breeze-agent/main_test.go` — `TestWaitForEnrollment_UnblocksWhenConfigBecomesValid`, `TestWaitForEnrollment_RespectsContextCancel`, `TestWaitForEnrollment_IgnoresTornWrite`.
- `agent/cmd/breeze-agent/service_windows_test.go` — may not exist; create if absent. `TestExecute_EnrolledPath_SignalsRunningAfterStartFn`, `TestExecute_UnenrolledPath_SignalsRunningBeforeWait`, `TestExecute_StopWhileWaiting`.
- `agent/internal/config/config.go` — add `IsEnrolled(cfg *Config) bool` helper.
- `agent/internal/config/config_test.go` — `TestIsEnrolled` table test.
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
| Enrolled-path install fails more silently than today (post-enroll mTLS/heartbeat init errors no longer fail the install) | **Avoided** — Decision 6 explicitly preserves synchronous start semantics on the enrolled path. Only the unenrolled branch reports Running early. |
| Waiter observes torn SaveTo write (AgentID set but AuthToken not yet persisted) | Low | `IsEnrolled` checks both fields. Torn read causes one extra poll cycle (10s); no incorrect bring-up. |
| `startAgent` fails on the async post-enrollment path and the service ends up Stopped without rolling back the install | **Accepted** | The admin chose `/qn` with no creds; a failure after deferred enrollment is debugged via `agent-start-failed.txt`, `agent.log`, and Event Log. They re-run `breeze-agent enroll` with corrected parameters and `sc start BreezeAgent`. |
| Session change events arrive during `waitLoop` before `comps` is wired up | Medium | Drop events during the wait window; session broker reconciliation loop is the authoritative source and will catch up once `startAgent` completes. Only `Interrogate`/`Stop`/`Shutdown` are handled during the wait. |
| `enroll-last-error.txt` is removed during MSI rollback on the bad-creds path | Low | The file is written by a CA via `os.WriteFile` — MSI has no record of it and cannot roll it back. `cmpProgramDataLogs` is `Permanent="yes"` so the parent directory also survives. Expected state is codified in smoke-test scenarios 3 and 4 (file PRESENT post-1603). Fallback if a specific environment breaks this: write to `%TEMP%\breeze-enroll-last-error.txt`. |
| Stale `enroll-last-error.txt` from an earlier failed attempt confuses admins after a successful retry | **Avoided** — `enrollDevice` calls `clearEnrollLastError()` at the start of every attempt (Decision 8). |
| Goroutine leak in `waitForEnrollment` tests | **Avoided** — `waitForEnrollment` takes `context.Context`, tests cancel via `context.WithCancel` (Decision 9). |
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

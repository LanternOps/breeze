# PAM Path B — Token-Launch Actuator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production, flag-gated Path B actuation strategy to the Windows agent that suppresses `consent.exe` and launches the target executable elevated via `LogonUser(~breeze_elev)` → `CreateProcessAsUser`, running as `~breeze_elev` on the user's interactive desktop.

**Architecture:** A new `tokenLaunchActuator` implements the existing `pamactuator.Actuator` interface behind a config-selected strategy. It reuses the shipped `Dismiss()` primitive to suppress the native prompt, the `elevaccount` lifecycle to mint/rotate the `~breeze_elev` credential, and the ETW-15028 discovery to obtain the target path + command line. The raw Win32 calls are isolated behind a `tokenLauncher` seam so the actuator's orchestration logic is unit-testable, while the syscall implementation is validated on a Windows VM.

**Tech Stack:** Go (agent, `golang.org/x/sys/windows`), TypeScript/Hono (API actuate route), Vitest (API tests), Go `testing` (agent tests).

## Global Constraints

- Go agent tests run with `-race`: `cd agent && go test -race ./...`.
- Windows-only code lives in `*_windows.go` (build tag `//go:build windows`); non-Windows builds MUST compile via `*_other.go` stubs. The agent CI builds Linux — every task must keep `go build ./...` green on Linux.
- The `~breeze_elev` password is agent-minted, never logged, never crosses the wire, and is zeroed after use (`zeroCredential`). Preserve this.
- `~breeze_elev` MUST be demoted + re-randomized after every actuation attempt, success or failure (guaranteed-demote defer).
- Default actuator strategy stays `sendinput` (Path A). Path B ships dark — enabled only via `agent.yaml`.
- Result `Reason` codes are short stable snake_case strings the server switches on — extend, never repurpose existing codes.
- Follow the existing `pamactuator` file layout and the `swapActuatorForTest` seam; do not restructure shipped files beyond what each task specifies.

---

## File Structure

- `agent/internal/config/config.go` — add `PAMActuatorStrategy` field (modify).
- `agent/internal/pamactuator/actuator.go` — add `Strategy` type + constants, extend `Request`, add `NewWithStrategy` (modify).
- `agent/internal/pamactuator/strategy_windows.go` — `newActuatorForStrategy` dispatch on Windows (create).
- `agent/internal/pamactuator/strategy_other.go` — `newActuatorForStrategy` stub on non-Windows (create).
- `agent/internal/pamactuator/tokenlaunch_windows.go` — `tokenLaunchActuator` + `tokenLauncher` seam + real syscall impl (create).
- `agent/internal/pamactuator/tokenlaunch_test.go` — unit tests for orchestration via fake `tokenLauncher` (create).
- `agent/internal/heartbeat/handlers_actuate.go` — strategy-aware actuator selection + plumb target/cmdline (modify).
- `agent/internal/heartbeat/pam_flow.go` — pass target/cmdline into actuation; strategy-aware deny (modify).
- `agent/internal/heartbeat/handlers_actuate_test.go` — update seam + add strategy/target tests (modify).
- `apps/api/src/routes/devices/actuateElevation.ts` — echo target path + command line into the `actuate_elevation` payload (modify).
- `apps/api/src/routes/devices/actuateElevation.test.ts` — assert payload carries target (modify/create).

---

## Phase 1 — The primitive, flag-gated dark

### Task 1: Config field `PAMActuatorStrategy`

**Files:**
- Modify: `agent/internal/config/config.go` (field near `PAMEnabled` ~line 96; default in the defaults block ~line 212; `viper.Set` ~line 440)
- Test: `agent/internal/config/config_test.go`

**Interfaces:**
- Produces: `Config.PAMActuatorStrategy string` (mapstructure `pam_actuator_strategy`), default `"sendinput"`.

- [ ] **Step 1: Write the failing test**

Add to `agent/internal/config/config_test.go`:

```go
func TestDefaultConfigPAMActuatorStrategy(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.PAMActuatorStrategy != "sendinput" {
		t.Fatalf("PAMActuatorStrategy default = %q, want \"sendinput\"", cfg.PAMActuatorStrategy)
	}
}
```

(If `DefaultConfig()` is named differently, match the existing constructor used elsewhere in `config_test.go`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/config/ -run TestDefaultConfigPAMActuatorStrategy`
Expected: FAIL — `PAMActuatorStrategy` undefined.

- [ ] **Step 3: Implement**

In `config.go`, directly below the `PAMEnabled` field:

```go
	// PAMActuatorStrategy selects the Windows elevation actuator: "sendinput"
	// (Path A — inject credentials into consent.exe) or "token_launch" (Path B —
	// suppress consent.exe and launch the target elevated via CreateProcessAsUser
	// as ~breeze_elev). Default "sendinput". Path B ships dark; flip per-device
	// via agent.yaml. Ignored when PAMEnabled is false.
	PAMActuatorStrategy string `mapstructure:"pam_actuator_strategy"`
```

In the defaults block, below `PAMEnabled: false,`:

```go
		PAMActuatorStrategy:          "sendinput",
```

In the persist block, below `viper.Set("pam_enabled", cfg.PAMEnabled)`:

```go
	viper.Set("pam_actuator_strategy", cfg.PAMActuatorStrategy)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/config/ -run TestDefaultConfigPAMActuatorStrategy`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/config.go agent/internal/config/config_test.go
git commit -m "feat(agent/pam): add pam_actuator_strategy config (default sendinput)"
```

---

### Task 2: Extend `pamactuator` — Request fields, Strategy, NewWithStrategy

**Files:**
- Modify: `agent/internal/pamactuator/actuator.go`
- Create: `agent/internal/pamactuator/strategy_windows.go`
- Create: `agent/internal/pamactuator/strategy_other.go`
- Test: `agent/internal/pamactuator/actuator_test.go` (add cases)

**Interfaces:**
- Produces:
  - `pamactuator.Request` gains `TargetPath string` and `CommandLine string`.
  - `type Strategy string`; consts `StrategySendInput Strategy = "sendinput"`, `StrategyTokenLaunch Strategy = "token_launch"`.
  - `func NewWithStrategy(s Strategy) Actuator`.
- Consumes: existing `Actuator`, `Result`, `newActuator()` (per-build-tag).

- [ ] **Step 1: Write the failing test**

Add to `agent/internal/pamactuator/actuator_test.go`:

```go
func TestNewWithStrategyReturnsNonNil(t *testing.T) {
	for _, s := range []Strategy{StrategySendInput, StrategyTokenLaunch, "bogus"} {
		if got := NewWithStrategy(s); got == nil {
			t.Fatalf("NewWithStrategy(%q) = nil", s)
		}
	}
}

func TestRequestCarriesTarget(t *testing.T) {
	r := Request{TargetPath: `C:\Windows\System32\mmc.exe`, CommandLine: `mmc.exe devmgmt.msc`}
	if r.TargetPath == "" || r.CommandLine == "" {
		t.Fatal("Request target fields not set")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/pamactuator/ -run 'TestNewWithStrategy|TestRequestCarriesTarget'`
Expected: FAIL — `NewWithStrategy`, `Strategy`, `TargetPath` undefined.

- [ ] **Step 3: Implement**

In `actuator.go`, add to the `Request` struct (after `TimeoutMs`):

```go
	// TargetPath is the absolute path of the executable to launch elevated.
	// Used only by the token_launch strategy (Path B); the sendinput strategy
	// ignores it (it injects into an already-pending consent.exe).
	TargetPath string

	// CommandLine is the full command line for the elevated launch (Path B).
	// Ignored by the sendinput strategy.
	CommandLine string
```

Append to `actuator.go`:

```go
// Strategy selects the concrete Windows actuator implementation.
type Strategy string

const (
	// StrategySendInput is Path A: inject dormant-admin credentials into the
	// live consent.exe prompt via SendInput on the secure desktop.
	StrategySendInput Strategy = "sendinput"
	// StrategyTokenLaunch is Path B: suppress consent.exe and launch the target
	// elevated via LogonUser(~breeze_elev) → CreateProcessAsUser.
	StrategyTokenLaunch Strategy = "token_launch"
)

// NewWithStrategy returns the Windows actuator for the given strategy. An
// unrecognized strategy falls back to the platform default (sendinput on
// Windows, no-op elsewhere). On non-Windows this always returns the no-op.
func NewWithStrategy(s Strategy) Actuator {
	return newActuatorForStrategy(s)
}
```

Create `agent/internal/pamactuator/strategy_windows.go`:

```go
//go:build windows

package pamactuator

// newActuatorForStrategy dispatches to the concrete Windows actuator. Unknown
// strategies fall back to the sendinput default.
func newActuatorForStrategy(s Strategy) Actuator {
	switch s {
	case StrategyTokenLaunch:
		return newTokenLaunchActuator()
	default:
		return &windowsActuator{}
	}
}
```

Create `agent/internal/pamactuator/strategy_other.go`:

```go
//go:build !windows

package pamactuator

// newActuatorForStrategy always returns the no-op on non-Windows: UAC and the
// secure desktop only exist on Windows.
func newActuatorForStrategy(_ Strategy) Actuator {
	return &noopActuator{}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/pamactuator/ && GOOS=windows go build ./internal/pamactuator/`

Note: `newTokenLaunchActuator` does not exist yet, so the `GOOS=windows` build will fail here. That is expected until Task 3 — for THIS task, on Linux the `strategy_other.go` path compiles and the tests pass. Run only:
`cd agent && go test -race ./internal/pamactuator/ -run 'TestNewWithStrategy|TestRequestCarriesTarget'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/pamactuator/actuator.go agent/internal/pamactuator/strategy_windows.go agent/internal/pamactuator/strategy_other.go agent/internal/pamactuator/actuator_test.go
git commit -m "feat(agent/pam): add actuator Strategy + NewWithStrategy + target Request fields"
```

---

### Task 3: `tokenLaunchActuator` (Windows) with testable seam

**Files:**
- Create: `agent/internal/pamactuator/tokenlaunch_windows.go`
- Test: `agent/internal/pamactuator/tokenlaunch_test.go`

**Interfaces:**
- Consumes: `Request{Username, Password, TargetPath, CommandLine, TimeoutMs, ElevationRequestID}`, `Result`, `Dismiss` behavior (via embedding `windowsActuator` for the deny path).
- Produces:
  - `type tokenLaunchActuator struct { launcher tokenLauncher }`
  - `func newTokenLaunchActuator() Actuator`
  - `type tokenLauncher interface { Launch(ctx, launchParams) launchOutcome }`
  - `type launchParams struct { Username, Password, TargetPath, CommandLine string; SessionID uint32 }`
  - `type launchOutcome struct { PID uint32; Reason string; Err error }` (Reason "" on success)
  - New `Result.Reason` codes: `logon_failed`, `set_session_failed`, `desktop_grant_failed`, `create_process_failed`, `session_lookup_failed`, `empty_target`.

**Design note for the implementer:** the actuator's job is orchestration — validate the request, resolve the user's session id, call `launcher.Launch`, map the outcome to a `Result`. All raw Win32 (`LogonUser`, `SetTokenInformation`, window-station/desktop DACL grant, `CreateProcessAsUser`) lives inside the concrete `winTokenLauncher` so it can be swapped for a fake in tests. `Trigger` does NOT promote/demote `~breeze_elev` — the heartbeat caller already wraps `Trigger` in the promote/guaranteed-demote pipeline (`handlers_actuate.go` `actuateElevation`), and Path B reuses that unchanged. `Dismiss` is inherited from `windowsActuator` (Path B suppresses the native prompt with the identical Escape primitive).

- [ ] **Step 1: Write the failing test**

Create `agent/internal/pamactuator/tokenlaunch_test.go`:

```go
//go:build windows

package pamactuator

import (
	"context"
	"errors"
	"testing"
)

type fakeLauncher struct {
	gotParams launchParams
	outcome   launchOutcome
}

func (f *fakeLauncher) Launch(_ context.Context, p launchParams) launchOutcome {
	f.gotParams = p
	return f.outcome
}

func newTestActuator(o launchOutcome) (*tokenLaunchActuator, *fakeLauncher) {
	fl := &fakeLauncher{outcome: o}
	return &tokenLaunchActuator{launcher: fl, sessionResolver: func() (uint32, error) { return 2, nil }}, fl
}

func TestTokenLaunchSuccess(t *testing.T) {
	act, fl := newTestActuator(launchOutcome{PID: 4321})
	res := act.Trigger(context.Background(), Request{
		Username:    "~breeze_elev",
		Password:    "s3cret",
		TargetPath:  `C:\Windows\System32\mmc.exe`,
		CommandLine: `mmc.exe devmgmt.msc`,
	})
	if !res.Success || res.Reason != "ok" {
		t.Fatalf("got success=%v reason=%q, want true/ok", res.Success, res.Reason)
	}
	if fl.gotParams.TargetPath == "" || fl.gotParams.SessionID != 2 {
		t.Fatalf("launcher got wrong params: %+v", fl.gotParams)
	}
	if fl.gotParams.Password == "" {
		t.Fatal("password not forwarded to launcher")
	}
}

func TestTokenLaunchEmptyTarget(t *testing.T) {
	act, _ := newTestActuator(launchOutcome{PID: 1})
	res := act.Trigger(context.Background(), Request{Username: "~breeze_elev", Password: "x"})
	if res.Success || res.Reason != "empty_target" {
		t.Fatalf("got success=%v reason=%q, want false/empty_target", res.Success, res.Reason)
	}
}

func TestTokenLaunchLauncherFailureMapsReason(t *testing.T) {
	act, _ := newTestActuator(launchOutcome{Reason: "logon_failed", Err: errors.New("bad creds")})
	res := act.Trigger(context.Background(), Request{
		Username: "~breeze_elev", Password: "x", TargetPath: `C:\a.exe`, CommandLine: `a.exe`,
	})
	if res.Success || res.Reason != "logon_failed" {
		t.Fatalf("got success=%v reason=%q, want false/logon_failed", res.Success, res.Reason)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && GOOS=windows go vet ./internal/pamactuator/` (or build the test on a Windows runner)
Expected: FAIL — `tokenLaunchActuator`, `tokenLauncher`, `launchParams`, `launchOutcome`, `newTokenLaunchActuator` undefined.

(Linux note: this test file is `//go:build windows`; to compile-check it on Linux use `GOOS=windows go build ./internal/pamactuator/`. It cannot be *run* off Windows.)

- [ ] **Step 3: Implement**

Create `agent/internal/pamactuator/tokenlaunch_windows.go`:

```go
//go:build windows

package pamactuator

import (
	"context"
	"log/slog"
)

// tokenLaunchActuator is the Path B implementation. Instead of typing
// credentials into consent.exe (windowsActuator), it launches the target
// executable elevated via LogonUser(~breeze_elev) → CreateProcessAsUser,
// running as ~breeze_elev on the requesting user's interactive desktop. The
// native consent.exe prompt is suppressed by the embedded windowsActuator's
// Dismiss (Escape) primitive — Path B reuses the deny path verbatim.
//
// The promote/demote of ~breeze_elev is the caller's responsibility
// (heartbeat.actuateElevation); this actuator only consumes the minted
// credential in the Request.
type tokenLaunchActuator struct {
	windowsActuator // inherit Dismiss (secure-desktop Escape)
	launcher        tokenLauncher
	// sessionResolver returns the interactive session id to place the launched
	// process into. Swappable for tests.
	sessionResolver func() (uint32, error)
}

func newTokenLaunchActuator() Actuator {
	return &tokenLaunchActuator{
		launcher:        &winTokenLauncher{},
		sessionResolver: activeConsoleSessionID,
	}
}

// launchParams is the resolved input to a single CreateProcessAsUser launch.
type launchParams struct {
	Username    string
	Password    string
	TargetPath  string
	CommandLine string
	SessionID   uint32
}

// launchOutcome reports the result of the raw launch. Reason is "" on success.
type launchOutcome struct {
	PID    uint32
	Reason string
	Err    error
}

// tokenLauncher performs the raw Win32 elevation launch. Isolated behind an
// interface so tokenLaunchActuator's orchestration is unit-testable with a
// fake; the concrete winTokenLauncher is validated on a Windows VM.
type tokenLauncher interface {
	Launch(ctx context.Context, p launchParams) launchOutcome
}

func (a *tokenLaunchActuator) Trigger(ctx context.Context, req Request) Result {
	if req.TargetPath == "" {
		return Result{Success: false, Reason: "empty_target",
			DetailMessage: "token_launch: no target executable in request"}
	}

	sess, err := a.sessionResolver()
	if err != nil {
		return Result{Success: false, Reason: "session_lookup_failed",
			DetailMessage: "resolving interactive session: " + err.Error()}
	}

	out := a.launcher.Launch(ctx, launchParams{
		Username:    req.Username,
		Password:    req.Password,
		TargetPath:  req.TargetPath,
		CommandLine: req.CommandLine,
		SessionID:   sess,
	})
	if out.Reason != "" {
		msg := out.Reason
		if out.Err != nil {
			msg = out.Err.Error()
		}
		slog.Warn("pamactuator: token_launch failed",
			"elevationRequestId", req.ElevationRequestID, "reason", out.Reason)
		return Result{Success: false, Reason: out.Reason, DetailMessage: msg}
	}

	slog.Info("pamactuator: token_launch complete",
		"elevationRequestId", req.ElevationRequestID, "pid", out.PID)
	return Result{Success: true, Reason: "ok",
		DetailMessage: "target launched elevated via CreateProcessAsUser"}
}
```

Then add the concrete `winTokenLauncher` and `activeConsoleSessionID` in the same file. **This is the raw-syscall layer — validate it on the Windows VM; the interface above keeps the orchestration green on any host.** Implement using `golang.org/x/sys/windows`:

```go
import "golang.org/x/sys/windows"

// activeConsoleSessionID returns the session id of the physical console.
func activeConsoleSessionID() (uint32, error) {
	id := windows.WTSGetActiveConsoleSessionId()
	if id == 0xFFFFFFFF {
		return 0, windows.ERROR_NO_SUCH_LOGON_SESSION
	}
	return id, nil
}

type winTokenLauncher struct{}

// Launch performs: LogonUser(user,pwd) → SetTokenInformation(TokenSessionId) →
// grant the logon SID access to winsta0\default → CreateProcessAsUser(target,
// cmdline, lpDesktop="winsta0\\default"). On any step failure it returns the
// matching Reason and never leaks handles. See the design doc "Known Win32
// wrinkles". The token is closed via defer; the desktop/winsta grant is revoked
// via defer regardless of launch outcome.
func (winTokenLauncher) Launch(ctx context.Context, p launchParams) launchOutcome {
	// 1. windows.LogonUser(user, ".", pwd, LOGON32_LOGON_INTERACTIVE,
	//    LOGON32_PROVIDER_DEFAULT, &hToken); on err → {Reason:"logon_failed", Err}
	// 2. windows.SetTokenInformation(hToken, TokenSessionId, &p.SessionID, 4);
	//    on err → {Reason:"set_session_failed", Err}
	// 3. grant p.Username's logon SID GENERIC access to the "winsta0" window
	//    station AND its "default" desktop DACL (OpenWindowStation/OpenDesktop +
	//    Get/SetSecurityInfo, add an allow ACE). Defer the revoke. On err →
	//    {Reason:"desktop_grant_failed", Err}
	// 4. si := windows.StartupInfo{Desktop: UTF16Ptr(`winsta0\default`)};
	//    windows.CreateProcessAsUser(hToken, nil, cmdlinePtr, nil, nil, false,
	//    0, nil, nil, &si, &pi); on err → {Reason:"create_process_failed", Err}
	// 5. close pi.Thread/pi.Process handles; return {PID: pi.ProcessId}
	return launchOutcome{Reason: "create_process_failed",
		Err: errFn("winTokenLauncher not yet implemented — wire on Windows VM")}
}
```

Leave the numbered comments as the implementation contract; the executor fills the real calls and iterates against the VM. Keep the fallback return so Linux `GOOS=windows go build` stays green before the VM pass. (Define a tiny `errFn` helper or use `errors.New`.)

- [ ] **Step 4: Run tests to verify they pass**

On a Windows runner: `cd agent && go test -race ./internal/pamactuator/ -run TestTokenLaunch`
Expected: PASS (orchestration tests use the fake launcher; they do not touch real Win32).
On Linux (compile gate): `cd agent && GOOS=windows go build ./internal/pamactuator/`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/pamactuator/tokenlaunch_windows.go agent/internal/pamactuator/tokenlaunch_test.go
git commit -m "feat(agent/pam): token_launch actuator (Path B) with testable launcher seam"
```

---

## Phase 2 — Wire selection + suppression ordering

### Task 4: Strategy-aware actuator selection in heartbeat

**Files:**
- Modify: `agent/internal/heartbeat/handlers_actuate.go` (`newActuator` var ~line 58; `actuateElevation` ~line 130)
- Modify: `agent/internal/heartbeat/pam_flow.go` (`denyConsent` ~line 131)
- Modify: `agent/internal/heartbeat/handlers_actuate_test.go` (`swapActuatorForTest` ~line 212 + call sites)

**Interfaces:**
- Consumes: `pamactuator.NewWithStrategy`, `pamactuator.Strategy`, `Config.PAMActuatorStrategy`.
- Produces: `func (h *Heartbeat) pamActuatorStrategy() pamactuator.Strategy`; `newActuator` becomes `func(pamactuator.Strategy) pamactuator.Actuator`.

- [ ] **Step 1: Write the failing test**

In `handlers_actuate_test.go`, add (adjust the config accessor to however `Heartbeat` exposes config in existing tests):

```go
func TestActuateUsesConfiguredStrategy(t *testing.T) {
	var gotStrategy pamactuator.Strategy
	swapActuatorForTest(t, func(s pamactuator.Strategy) pamactuator.Actuator {
		gotStrategy = s
		return fakeActuator{trigger: func(_ context.Context, r pamactuator.Request) pamactuator.Result {
			return pamactuator.Result{Success: true, Reason: "ok"}
		}}
	})
	h := newTestHeartbeatWithPAMStrategy(t, "token_launch") // helper in this test file
	h.actuateElevation(context.Background(), "req-1", 8000)
	if gotStrategy != pamactuator.StrategyTokenLaunch {
		t.Fatalf("actuator built with strategy %q, want token_launch", gotStrategy)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/heartbeat/ -run TestActuateUsesConfiguredStrategy`
Expected: FAIL — `swapActuatorForTest` signature mismatch / `newTestHeartbeatWithPAMStrategy` undefined.

- [ ] **Step 3: Implement**

In `handlers_actuate.go`, change the indirection:

```go
// newActuator is an indirection so tests can install a fake. Now strategy-aware
// so Path A (sendinput) and Path B (token_launch) share one selection point.
var newActuator = pamactuator.NewWithStrategy
```

Add a helper (same file):

```go
// pamActuatorStrategy resolves the configured Windows actuator strategy,
// defaulting to sendinput when unset or unknown.
func (h *Heartbeat) pamActuatorStrategy() pamactuator.Strategy {
	switch pamactuator.Strategy(h.config.PAMActuatorStrategy) {
	case pamactuator.StrategyTokenLaunch:
		return pamactuator.StrategyTokenLaunch
	default:
		return pamactuator.StrategySendInput
	}
}
```

(Use the actual field path the `Heartbeat` struct exposes config through — match how `PAMEnabled` is read elsewhere in `heartbeat`.)

In `actuateElevation`, change `act := newActuator()` to:

```go
	act := newActuator(h.pamActuatorStrategy())
```

In `pam_flow.go` `denyConsent`, change `res := newActuator().Dismiss(ctx)` to:

```go
	res := newActuator(h.pamActuatorStrategy()).Dismiss(ctx)
```

Update `swapActuatorForTest` in the test file to take `func(pamactuator.Strategy) pamactuator.Actuator`, and update every existing call site (lines ~94, ~142, ~170) to the new signature (their closures ignore the strategy arg: `func(pamactuator.Strategy) pamactuator.Actuator { return fakeActuator{...} }`). Add the `newTestHeartbeatWithPAMStrategy` helper mirroring the existing heartbeat test constructor but setting `PAMActuatorStrategy`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'Actuate|PamFlow'`
Expected: PASS (existing actuate + pam_flow tests still green under the new seam signature).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/handlers_actuate.go agent/internal/heartbeat/pam_flow.go agent/internal/heartbeat/handlers_actuate_test.go
git commit -m "feat(agent/pam): select actuator strategy from config in heartbeat"
```

---

### Task 5: Plumb target path + command line into actuation

**Files:**
- Modify: `agent/internal/heartbeat/handlers_actuate.go` (`actuateElevation` signature + Request build)
- Modify: `agent/internal/heartbeat/pam_flow.go` (`RunPamFlow` actuate branch ~line 112)
- Modify: `apps/api/src/routes/devices/actuateElevation.ts`
- Modify: `agent/internal/heartbeat/handlers_actuate_test.go`
- Test: `apps/api/src/routes/devices/actuateElevation.test.ts`

**Interfaces:**
- Consumes: `etwlua.Event.TargetExecutablePath`, `etwlua.Event.CommandLine`; the stored `elevation_requests` row's target on the server.
- Produces: `actuateElevation(ctx, requestID string, timeoutMs int, target pamTarget)` where `type pamTarget struct { Path, CommandLine string }`; the `actuate_elevation` command payload gains `targetPath` + `commandLine`.

**Rationale:** the local (`RunPamFlow`) path already holds `ev.TargetExecutablePath` / `ev.CommandLine`. The remote path (server-pushed `actuate_elevation`) must have the server **echo the stored request's target** so the agent holds no cross-request state. Path A ignores these fields, so this is additive and safe for the shipped strategy.

- [ ] **Step 1: Write the failing test (API)**

In `apps/api/src/routes/devices/actuateElevation.test.ts`, add a case asserting the queued command payload includes the target from the elevation_requests row:

```ts
it("echoes target path and command line into the actuate_elevation payload", async () => {
  // arrange: an approved elevation_requests row with
  //   target_executable_path = 'C:\\Windows\\System32\\mmc.exe'
  //   command_line = 'mmc.exe devmgmt.msc'
  const res = await postActuate(app, deviceId, requestId, { timeoutMs: 8000 });
  expect(res.status).toBe(202);
  const queued = getLastQueuedCommand();
  expect(queued.payload.targetPath).toBe("C:\\Windows\\System32\\mmc.exe");
  expect(queued.payload.commandLine).toBe("mmc.exe devmgmt.msc");
});
```

(Match the file's existing harness helpers — `postActuate`, command-capture — rather than these placeholder names.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- actuateElevation`
Expected: FAIL — payload has no `targetPath`.

- [ ] **Step 3: Implement (API)**

In `actuateElevation.ts`, when building the `actuate_elevation` command payload, read `target_executable_path` and `command_line` from the elevation_requests row already loaded for the CAS check and add them to the payload:

```ts
payload: {
  elevationRequestId: request.id,
  timeoutMs,
  targetPath: request.targetExecutablePath ?? "",
  commandLine: request.commandLine ?? "",
},
```

(Use the row's actual Drizzle column names.)

- [ ] **Step 4: Run test to verify it passes (API)**

Run: `pnpm test --filter=@breeze/api -- actuateElevation`
Expected: PASS

- [ ] **Step 5: Implement (agent) + test**

In `handlers_actuate.go`: add `type pamTarget struct{ Path, CommandLine string }`; extend `actuatePayload` with `TargetPath string \`json:"targetPath"\`` and `CommandLine string \`json:"commandLine"\``; change `actuateElevation` to accept a `pamTarget` and set `TargetPath`/`CommandLine` on the `pamactuator.Request`; pass `pamTarget{payload.TargetPath, payload.CommandLine}` from `handleActuateElevation`.

In `pam_flow.go` `RunPamFlow`, change the actuate call to pass the event's target:

```go
res := h.actuateElevation(actCtx, outcome.RequestID, defaultActuateTimeoutMs,
	pamTarget{Path: ev.TargetExecutablePath, CommandLine: ev.CommandLine})
```

Add an agent test asserting the target flows into the `pamactuator.Request` (via the fake actuator capturing `req.TargetPath`).

- [ ] **Step 6: Run agent tests**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'Actuate|PamFlow'`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add agent/internal/heartbeat/handlers_actuate.go agent/internal/heartbeat/pam_flow.go agent/internal/heartbeat/handlers_actuate_test.go apps/api/src/routes/devices/actuateElevation.ts apps/api/src/routes/devices/actuateElevation.test.ts
git commit -m "feat(pam): carry target path + command line into actuate_elevation (Path B)"
```

---

## Phase 3 — Hardening + on-VM validation

### Task 6: Guaranteed-demote coverage for the token-launch failure paths

**Files:**
- Test: `agent/internal/heartbeat/handlers_actuate_test.go`

**Interfaces:**
- Consumes: existing `newElevationAccountManager` seam + `fakeActuator`.

**Rationale:** `actuateElevation` already wraps `Trigger` in a promote → guaranteed-demote defer, so Path B inherits demote-on-failure for free. This task proves it — a token_launch `Trigger` returning any failure Reason must still Demote `~breeze_elev`.

- [ ] **Step 1: Write the failing test**

```go
func TestTokenLaunchFailureStillDemotes(t *testing.T) {
	var demoted bool
	swapElevationManagerForTest(t, func() elevaccount.AccountManager {
		return fakeManager{
			promote: func(context.Context) (elevaccount.Credential, error) {
				return elevaccount.Credential{Username: "~breeze_elev", Password: "x"}, nil
			},
			demote: func(context.Context) error { demoted = true; return nil },
		}
	})
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
			return pamactuator.Result{Success: false, Reason: "create_process_failed"}
		}}
	})
	h := newTestHeartbeatWithPAMStrategy(t, "token_launch")
	h.actuateElevation(context.Background(), "req-1", 8000, pamTarget{Path: `C:\a.exe`, CommandLine: `a.exe`})
	if !demoted {
		t.Fatal("~breeze_elev was not demoted after token_launch failure")
	}
}
```

(Use the existing manager-swap helper name from the current test file; if none exists, add `swapElevationManagerForTest` mirroring `swapActuatorForTest`. Reuse the existing `fakeManager`/`fakeActuator` if already defined.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/heartbeat/ -run TestTokenLaunchFailureStillDemotes`
Expected: FAIL until the helper/manager seam names are aligned (logic already present).

- [ ] **Step 3: Implement**

No production change expected — align helper names so the test compiles and passes against the existing guaranteed-demote defer. If a manager-swap seam does not exist, add it next to `newElevationAccountManager` (`var newElevationAccountManager = elevaccount.New` → swappable in tests).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestTokenLaunchFailureStillDemotes`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/handlers_actuate_test.go
git commit -m "test(agent/pam): token_launch failure still demotes ~breeze_elev"
```

---

### Task 7: On-VM validation matrix + enablement note

**Files:**
- Create: `docs/superpowers/plans/pam/2026-07-03-pam-path-b-vm-validation.md` (checklist artifact — not code)

**Rationale:** the raw `winTokenLauncher` syscalls (Task 3) and the suppression-then-launch ordering can only be proven on real hardware. This task records the exact manual matrix and the enablement steps, and is where the Task-3 syscall implementation is iterated to green.

- [ ] **Step 1: Write the validation checklist**

Create the file with:
- **Enable:** on the Windows test VM (100.101.150.55), set in `agent.yaml`: `pam_enabled: true`, `pam_actuator_strategy: token_launch`; ensure a PAM rule auto-approves the test target (e.g. `mmc.exe`); restart the agent.
- **Case A (approve/launch):** standard user launches the target → Breeze auto-approves → assert: native consent.exe does not survive, target runs elevated (Task Manager: elevated, running as `~breeze_elev`), process is visible on the user's desktop (not session 0).
- **Case B (deny/block):** rule set to auto-deny → target does not launch, consent.exe dismissed.
- **Case C (lifecycle):** after each case, assert `~breeze_elev` is NOT in Administrators and its password was re-randomized (`net localgroup administrators`).
- **Case D (CVE-2026-20824 / EDR):** run with the customer EDR stack present; confirm no consent.exe deadlock and no EDR block of the `CreateProcessAsUser` launch (cross-check the #1158 allowlist submissions).
- **Result reason codes to watch in agent logs:** `ok`, `logon_failed`, `set_session_failed`, `desktop_grant_failed`, `create_process_failed`, `session_lookup_failed`, `empty_target`.

- [ ] **Step 2: Execute the matrix on the VM**

Run each case; capture agent logs. Iterate the `winTokenLauncher` implementation (Task 3, Step 3) until Cases A–C pass. Record outcomes inline in the checklist file.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/pam/2026-07-03-pam-path-b-vm-validation.md agent/internal/pamactuator/tokenlaunch_windows.go
git commit -m "test(agent/pam): Path B on-VM validation matrix + winTokenLauncher wiring"
```

---

## Self-Review

**Spec coverage:**
- D1 (reuse ETW 15028) → Task 5 (uses `ev.TargetExecutablePath`/`CommandLine`), no new detection. ✓
- D2 (reuse `Dismiss` to suppress) → Task 3 (`tokenLaunchActuator` embeds `windowsActuator` for `Dismiss`); ordering doc'd in Task 7. ✓
- D3 (run as `~breeze_elev`) → Task 3 `winTokenLauncher.Launch` uses the minted credential. ✓
- D4 (strategy behind `Actuator` interface) → Tasks 2 + 4. ✓
- D5 (flag-gated, dark) → Task 1 default `sendinput`; Task 4 selection. ✓
- Win32 wrinkles (session id, desktop DACL, privileges) → Task 3 launcher contract + Task 7 VM cases. ✓
- AP boundary (launch AP-forward, suppression not) → documented in design; suppression reuse is Task 3, no AP claim added. ✓
- Guaranteed-demote on failure → Task 6. ✓
- Testing (Go unit via fakes + on-VM matrix) → Tasks 3, 6, 7. ✓
- Server-echo of target → Task 5 API change. ✓

**Placeholder scan:** the `winTokenLauncher.Launch` body is intentionally a numbered syscall contract with a compiling fallback (validated on-VM in Task 7) — this is the one place raw Win32 cannot be pre-written blind; every other step carries complete code. No TODO/TBD in orchestration logic.

**Type consistency:** `Strategy`, `StrategySendInput`/`StrategyTokenLaunch`, `NewWithStrategy`, `newActuatorForStrategy`, `tokenLauncher`/`launchParams`/`launchOutcome`, `pamTarget`, and the extended `Request`/`actuatePayload` fields are used consistently across Tasks 2–6. `newActuator` signature change (Task 4) is reflected in every call site and the test seam.

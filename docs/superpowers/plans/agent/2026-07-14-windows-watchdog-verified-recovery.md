# Windows Watchdog Verified Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make watchdog recovery verify every Windows service/process transition and never start or terminate the wrong agent process.

**Architecture:** Replace coarse restart/start/kill calls with a structured recovery request/result and an OS-neutral, fakeable Windows recovery state machine. Concrete Windows adapters provide fresh SCM state/PID, configured binary identity, and process-handle operations; main-loop recovery and journals consume the structured result.

**Tech Stack:** Go, Windows SCM, `golang.org/x/sys/windows/svc/mgr`, Windows process handles, watchdog state machine and health journal.

## Global Constraints

- Graceful stop timeout is 35 seconds, exceeding the current approximately 21-second maximum serial shutdown budget with margin.
- `Start` is called only from verified `Stopped` state.
- Initial `StartPending`, `StopPending`, `ContinuePending`, or `PausePending` is observation-only and does not consume an attempt/history slot.
- A failed side effect does consume the attempt/history slot.
- Forced recovery ignores the state-file PID for destructive action and re-queries the current SCM PID.
- Forced ordering is `validate -> terminate -> process exited -> (Stopped -> explicit start | SCM recovery already pending -> observe) -> Running with a new live PID`.
- PID, image, service ownership, or transition uncertainty fails closed.
- PID/image/ownership uncertainty returns a terminal failover disposition and cannot loop on attempt 2.
- Recovery observation and process-exit waits are cancellable so an SCM stop never waits for the 35-second recovery deadline.
- Existing heartbeat-based post-restart verification remains the application-health success criterion.
- Linux and macOS retain their existing behavior through structured adapter results.
- Design source: `docs/superpowers/specs/agent/2026-07-14-windows-agent-helper-lifecycle-durability-design.md`.
- This document is the watchdog phase; the sibling RDS and main-agent plans cover the other approved-design slices.

## File Structure

- Modify `agent/internal/watchdog/recovery.go`: structured request/result/error and attempt accounting.
- Modify `agent/internal/watchdog/recovery_test.go`: dispatch, observation, counting, and typed-error tests.
- Create `agent/internal/watchdog/recovery_windows_logic.go`: OS-neutral Windows recovery orchestration.
- Create `agent/internal/watchdog/recovery_windows_logic_test.go`: deterministic transition/order tests.
- Replace `agent/internal/watchdog/recovery_windows.go`: SCM/process backend and concrete controller.
- Create `agent/internal/watchdog/recovery_windows_test.go`: native Windows path parsing and process adapter tests.
- Modify `agent/internal/watchdog/recovery_linux.go`: structured adapter compatibility.
- Modify `agent/internal/watchdog/recovery_darwin.go`: structured adapter compatibility.
- Modify `agent/internal/watchdog/integration_test.go`: structured recovery harness.
- Modify `agent/cmd/breeze-watchdog/main.go`: request/result flow, pending verification, and journal fields.
- Modify `agent/cmd/breeze-watchdog/main_test.go`: journal mapping tests.
- Modify `agent/cmd/breeze-watchdog/failover_dispatch_test.go`: structured failover recovery.

---

### Task 1: Structured recovery contract and correct attempt accounting

**Files:**
- Modify: `agent/internal/watchdog/recovery.go:23-139`
- Modify: `agent/internal/watchdog/recovery_test.go`
- Modify: `agent/internal/watchdog/recovery_linux.go`
- Modify: `agent/internal/watchdog/recovery_darwin.go`

**Interfaces:**
- Produces: `RecoveryRequest`, `RecoveryResult`, `RecoveryError`, and `RecoveryFailureClass`.
- Replaces: three-method `serviceController` with `Recover(int, RecoveryRequest) (RecoveryResult, error)`.
- Changes: `RecoveryManager.Attempt(RecoveryRequest) (RecoveryResult, error)`.

- [ ] **Step 1: Write failing accounting and propagation tests**

```go
type fakeStructuredController struct {
	result RecoveryResult
	err    error
	calls  []int
}

func (f *fakeStructuredController) Recover(attempt int, req RecoveryRequest) (RecoveryResult, error) {
	f.calls = append(f.calls, attempt)
	result := f.result
	result.StateFilePID = req.StateFilePID
	return result, f.err
}

func TestObservationOnlyRecoveryDoesNotConsumeAttempt(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)}
	svc := &fakeStructuredController{result: RecoveryResult{Action: RecoveryActionObserve, ActionTaken: false}}
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, svc, clk)
	result, err := r.Attempt(RecoveryRequest{StateFilePID: 44})
	if err != nil || result.ActionTaken || r.Attempts() != 0 || r.Count24h() != 0 {
		t.Fatalf("result=%+v err=%v attempts=%d history=%d", result, err, r.Attempts(), r.Count24h())
	}
}

func TestFailedSideEffectConsumesAttempt(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)}
	svc := &fakeStructuredController{
		result: RecoveryResult{Action: RecoveryActionGraceful, ActionTaken: true, Phase: "wait_stopped"},
		err: &RecoveryError{Class: RecoveryFailureStopTimeout, Phase: "wait_stopped"},
	}
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, svc, clk)
	_, _ = r.Attempt(RecoveryRequest{StateFilePID: 44})
	if r.Attempts() != 1 || r.Count24h() != 1 {
		t.Fatalf("attempts=%d history=%d, want 1 and 1", r.Attempts(), r.Count24h())
	}
}

func TestStructuredResultPropagatesSCMPIDs(t *testing.T) {
	svc := &fakeStructuredController{result: RecoveryResult{OldPID: 100, NewPID: 200, Disposition: RecoveryDispositionVerifyHeartbeat, ActionTaken: true}}
	r := newRecoveryManagerWithDeps(3, 0, svc, &fakeClock{now: time.Now()})
	got, err := r.Attempt(RecoveryRequest{StateFilePID: 50})
	if err != nil || got.StateFilePID != 50 || got.OldPID != 100 || got.NewPID != 200 {
		t.Fatalf("result=%+v err=%v", got, err)
	}
}

func TestTerminalIdentityFailureExhaustsRecoveryWithoutRestartHistory(t *testing.T) {
	clk := &fakeClock{now: time.Now()}
	svc := &fakeStructuredController{
		result: RecoveryResult{Action: RecoveryActionForced, Disposition: RecoveryDispositionFailover},
		err: &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "validate_image"},
	}
	r := newRecoveryManagerWithDeps(3, time.Minute, svc, clk)
	_, _ = r.Attempt(RecoveryRequest{Intent: RecoveryIntentUnhealthy})
	clk.now = clk.now.Add(2 * time.Minute) // cooldown must not clear terminal exhaustion
	if r.CanAttempt() || r.Count24h() != 0 {
		t.Fatalf("canAttempt=%v history=%d, want false and 0", r.CanAttempt(), r.Count24h())
	}
	r.Reset()
	if !r.CanAttempt() {
		t.Fatal("explicit reset did not clear terminal exhaustion")
	}
}
```

- [ ] **Step 2: Run tests and verify interface failures**

Run: `cd agent && go test -race ./internal/watchdog -run 'TestObservationOnly|TestFailedSideEffect|TestStructuredResult' -count=1`

Expected: FAIL because the structured recovery types and controller method do not exist.

- [ ] **Step 3: Add the structured contract**

```go
type RecoveryAction string

const (
	RecoveryActionObserve  RecoveryAction = "observe"
	RecoveryActionGraceful RecoveryAction = "graceful_restart"
	RecoveryActionForced   RecoveryAction = "forced_restart"
	RecoveryActionStart    RecoveryAction = "ensure_started"
)

type RecoveryIntent string

const (
	RecoveryIntentUnhealthy    RecoveryIntent = "recover_unhealthy"
	RecoveryIntentEnsureStart  RecoveryIntent = "ensure_started"
	RecoveryIntentRestart      RecoveryIntent = "restart"
)

type RecoveryDisposition string

const (
	RecoveryDispositionNone            RecoveryDisposition = "none"
	RecoveryDispositionVerifyHeartbeat RecoveryDisposition = "verify_heartbeat"
	RecoveryDispositionFailover        RecoveryDisposition = "failover"
)

type RecoveryFailureClass string

const (
	RecoveryFailureQuery              RecoveryFailureClass = "query_failed"
	RecoveryFailureControl            RecoveryFailureClass = "control_failed"
	RecoveryFailureStopTimeout        RecoveryFailureClass = "stop_timeout"
	RecoveryFailureTransitionTimeout  RecoveryFailureClass = "transition_timeout"
	RecoveryFailureIdentityMismatch   RecoveryFailureClass = "identity_mismatch"
	RecoveryFailureProcessExitTimeout RecoveryFailureClass = "process_exit_timeout"
	RecoveryFailureStartTimeout       RecoveryFailureClass = "start_timeout"
	RecoveryFailureCanceled           RecoveryFailureClass = "canceled"
)

type RecoveryRequest struct {
	StateFilePID int
	Intent       RecoveryIntent
	Context      context.Context
}

type RecoveryResult struct {
	Intent                        RecoveryIntent
	Action                        RecoveryAction
	Phase                         string
	InitialState                  string
	FinalState                    string
	StateFilePID                  int
	OldPID                        int
	NewPID                        int
	Elapsed                       time.Duration
	ActionTaken                   bool
	Disposition                   RecoveryDisposition
}

type RecoveryError struct {
	Class RecoveryFailureClass
	Phase string
	State string
	PID   int
	Err   error
}

func (e *RecoveryError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("recovery %s failed during %s", e.Class, e.Phase)
	}
	return fmt.Sprintf("recovery %s failed during %s: %v", e.Class, e.Phase, e.Err)
}

func (e *RecoveryError) Unwrap() error { return e.Err }

type serviceController interface {
	Recover(attempt int, req RecoveryRequest) (RecoveryResult, error)
}
```

Normalize an empty `Intent` to `RecoveryIntentUnhealthy` and a nil `Context` to `context.Background()` at the `RecoveryManager` boundary for source compatibility, but set both explicitly at every production call site.

- [ ] **Step 4: Count only actual recovery actions**

```go
func (r *RecoveryManager) Attempt(req RecoveryRequest) (RecoveryResult, error) {
	if req.Intent == "" {
		req.Intent = RecoveryIntentUnhealthy
	}
	if req.Context == nil {
		req.Context = context.Background()
	}
	nextAttempt := r.attempts + 1
	result, err := r.svc.Recover(nextAttempt, req)
	result.StateFilePID = req.StateFilePID
	result.Intent = req.Intent
	if result.Disposition == "" {
		result.Disposition = RecoveryDispositionNone
	}
	if result.ActionTaken {
		r.attempts++
		r.lastAttempt = r.clk.Now()
		r.recordRestart(r.lastAttempt)
	}
	if result.Disposition == RecoveryDispositionFailover {
		r.attempts = r.maxAttempts
		r.terminalExhausted = true
	}
	return result, err
}
```

Add `terminalExhausted bool` to `RecoveryManager`. `CanAttempt` checks it before applying cooldown logic and always returns false while it is set; time passing must never clear it. Only explicit `Reset` clears the flag. Cancellation is not terminal failover: preserve `ActionTaken` for accounting if a control was already issued, return `RecoveryFailureCanceled`, and let watchdog shutdown proceed without another recovery transition.

For `RecoveryIntentUnhealthy`, adapt Darwin/Linux controllers so attempt 1 performs their existing graceful restart, attempt 2 performs their existing state-PID kill plus start, and later attempts ensure start. `RecoveryIntentEnsureStart` always runs only their start/ensure operation; `RecoveryIntentRestart` always runs their graceful restart, independent of escalation count. Return minimal structured fields with `ActionTaken=true` whenever a side effect was issued.

- [ ] **Step 5: Run watchdog unit tests and commit**

Run: `cd agent && go test -race ./internal/watchdog -count=1`

Expected: PASS after adapting existing history tests to pass `RecoveryRequest`.

```bash
git add agent/internal/watchdog/recovery.go agent/internal/watchdog/recovery_test.go agent/internal/watchdog/recovery_linux.go agent/internal/watchdog/recovery_darwin.go
git commit -m "refactor(watchdog): return structured recovery outcomes"
```

---

### Task 2: Fakeable Windows transition state machine

**Files:**
- Create: `agent/internal/watchdog/recovery_windows_logic.go`
- Create: `agent/internal/watchdog/recovery_windows_logic_test.go`

**Interfaces:**
- Consumes: structured contract from Task 1.
- Produces: `windowsRecoveryBackend`, `serviceSnapshot`, `watchedProcess`, and `windowsRecoveryController`.
- Keeps Windows API imports out of logic tests.

- [ ] **Step 1: Write ordered graceful and transitional tests**

```go
func TestGracefulStopTimeoutNeverStarts(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopPending, PID: 100},
	)
	controller := newTestWindowsRecoveryController(backend)
	controller.stopTimeout = 35 * time.Second
	result, err := controller.Recover(1, RecoveryRequest{StateFilePID: 99})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) {
		t.Fatalf("err=%v, want RecoveryError", err)
	}
	if backend.startCalls != 0 || !result.ActionTaken {
		t.Fatalf("startCalls=%d result=%+v", backend.startCalls, result)
	}
}

func TestInitialStopPendingObservesWithoutSideEffect(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceStopPending, PID: 100},
		serviceSnapshot{State: serviceStopped},
	)
	controller := newTestWindowsRecoveryController(backend)
	result, err := controller.Recover(1, RecoveryRequest{})
	if err != nil || result.Action != RecoveryActionObserve || result.ActionTaken || backend.stopCalls != 0 || backend.startCalls != 0 {
		t.Fatalf("result=%+v err=%v stop=%d start=%d", result, err, backend.stopCalls, backend.startCalls)
	}
}

func TestGracefulOrderIsStopStoppedStartRunning(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopPending, PID: 100},
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceStartPending, PID: 200},
		serviceSnapshot{State: serviceRunning, PID: 200},
	)
	controller := newTestWindowsRecoveryController(backend)
	result, err := controller.Recover(1, RecoveryRequest{})
	if err != nil || strings.Join(backend.operations, ",") != "query,stop,query,query,start,query,query" {
		t.Fatalf("result=%+v err=%v operations=%v", result, err, backend.operations)
	}
}
```

Add `TestGracefulAlreadyStoppedStartsWithoutStop`, `TestEnsureStartAlreadyRunningObserves`, `TestStartPendingToRunningReturnsHeartbeatDisposition`, `TestStartPendingToStoppedDefersStart`, `TestStartTimeout`, `TestRunningWithZeroPIDFails`, `TestRunningWithDeadPIDFails`, `TestStopControlRaceRequeriesAndObservesSCMRecovery`, and `TestStartControlRaceRequeriesWithoutSecondStart`. A `StartPending` observation that reaches `Running` returns `ActionTaken=false` and `Disposition=RecoveryDispositionVerifyHeartbeat`; an observation that ends in `Stopped` leaves disposition `none` so the next attempt can issue `Start`.

Add `TestRecoveryCancellationInterruptsPendingObservation` and `TestRecoveryCancellationInterruptsProcessExitWait`. Each starts recovery with a cancelable request context, waits until the fake backend reaches its deterministic wait barrier, cancels, and requires a prompt `RecoveryFailureCanceled` return with no subsequent `Start`. The second preserves `ActionTaken=true` because termination already occurred.

- [ ] **Step 2: Run and verify missing backend failures**

Run: `cd agent && go test -race ./internal/watchdog -run 'TestGraceful|TestInitialStopPending|TestEnsureStart' -count=1`

Expected: FAIL because the Windows logic layer does not exist.

- [ ] **Step 3: Define OS-neutral backend contracts**

```go
type serviceState string

const (
	serviceStopped         serviceState = "stopped"
	serviceStartPending    serviceState = "start_pending"
	serviceStopPending     serviceState = "stop_pending"
	serviceRunning         serviceState = "running"
	serviceContinuePending serviceState = "continue_pending"
	servicePausePending    serviceState = "pause_pending"
	servicePaused          serviceState = "paused"
)

type serviceSnapshot struct {
	State serviceState
	PID   int
}

type watchedProcess interface {
	ImagePath() (string, error)
	Alive() (bool, error)
	Terminate() error
	Wait(context.Context, time.Duration) error
	Close() error
}

type windowsRecoveryBackend interface {
	Query() (serviceSnapshot, error)
	ConfiguredBinaryPath() (string, error)
	Stop() error
	Start() error
	OpenProcess(pid int) (watchedProcess, error)
}

type recoveryClock interface {
	Now() time.Time
	Sleep(context.Context, time.Duration) error
}
```

- [ ] **Step 4: Implement graceful/observe/ensure state transitions**

For `RecoveryIntentUnhealthy`, `Recover(1, req)` runs graceful recovery, `Recover(2, req)` runs forced recovery, and later attempts ensure start. `RecoveryIntentEnsureStart` always selects the ensure-start branch and `RecoveryIntentRestart` always selects graceful restart, regardless of the attempt argument. Pending states call only `Query`/cancellable sleep and return `ActionTaken=false`; they never call stop/start. Every transition loop checks `req.Context` before each query and uses `recoveryClock.Sleep(req.Context, interval)`; process-exit waits receive the same context. Cancellation returns `RecoveryFailureCanceled` promptly and never escalates to failover. If bounded observation reaches `Running`, return the heartbeat-verification disposition. Graceful recovery captures the original nonzero PID, sets `ActionTaken=true` immediately before issuing `Stop` or `Start`, waits up to 35 seconds for stopped, starts only from stopped, then verifies running with a nonzero, live PID different from the original. Thus even a failed control call is counted, while a query/observation failure is not. Each `Recover` call uses named returns plus a defer to populate `Elapsed` and the last reached `Phase` on success and failure.

After any `Stop`/`Start` control error, immediately re-query SCM before classifying failure. If SCM is now pending, observe it without a competing control; if it is already in the requested terminal state, continue/verify; only an unchanged incompatible state returns `RecoveryFailureControl`. Add fake backend errors matching `ERROR_SERVICE_NOT_ACTIVE`, `ERROR_SERVICE_CANNOT_ACCEPT_CTRL`, and `ERROR_SERVICE_ALREADY_RUNNING` to prove these races do not escalate to forced termination.

- [ ] **Step 5: Run deterministic logic tests and commit**

Run: `cd agent && go test -race ./internal/watchdog -run 'TestGraceful|TestInitial|TestEnsure|TestStart|TestRecoveryCancellation' -count=1`

Expected: PASS without wall-clock sleeps.

```bash
git add agent/internal/watchdog/recovery_windows_logic.go agent/internal/watchdog/recovery_windows_logic_test.go
git commit -m "fix(watchdog): verify Windows service transitions"
```

---

### Task 3: Fresh SCM PID and fail-closed forced recovery

**Files:**
- Modify: `agent/internal/watchdog/recovery_windows_logic.go`
- Modify: `agent/internal/watchdog/recovery_windows_logic_test.go`

**Interfaces:**
- Consumes: `ConfiguredBinaryPath`, fresh `Query`, and process handles.
- Produces: `normalizeWindowsExecutablePath` and forced recovery order.

- [ ] **Step 1: Write forced-recovery identity and order tests**

```go
func TestForcedRecoveryUsesFreshSCMPIDNotStateFilePID(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 200},
		serviceSnapshot{State: serviceRunning, PID: 200},
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceRunning, PID: 300},
	)
	backend.configuredPath = `C:\Program Files\Breeze\breeze-agent.exe`
	backend.processes[200] = newFakeWatchedProcess(`C:\Program Files\Breeze\breeze-agent.exe`)
	backend.processes[300] = newFakeWatchedProcess(`C:\Program Files\Breeze\breeze-agent.exe`)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{StateFilePID: 999})
	if err != nil || result.OldPID != 200 || result.NewPID != 300 || !reflect.DeepEqual(backend.openedPIDs, []int{200, 300}) {
		t.Fatalf("result=%+v err=%v openedPIDs=%v", result, err, backend.openedPIDs)
	}
}

func TestForcedRecoveryImageMismatchDoesNotTerminateOrStart(t *testing.T) {
	backend := newFakeWindowsBackend(serviceSnapshot{State: serviceRunning, PID: 200})
	backend.configuredPath = `C:\Program Files\Breeze\breeze-agent.exe`
	proc := newFakeWatchedProcess(`C:\Windows\System32\notepad.exe`)
	backend.processes[200] = proc
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureIdentityMismatch || result.Disposition != RecoveryDispositionFailover || proc.terminateCalls != 0 || backend.startCalls != 0 {
		t.Fatalf("result=%+v err=%v terminate=%d start=%d", result, err, proc.terminateCalls, backend.startCalls)
	}
}

func TestForcedRecoveryOrdersExitBeforeStart(t *testing.T) {
	backend := forcedRecoverySuccessBackend(100, 200)
	_, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	want := "query,config,open:100,image,alive,query,terminate,wait,query,start,query,open:200,image,alive"
	if got := strings.Join(backend.operations, ","); got != want {
		t.Fatalf("operations=%q, want %q", got, want)
	}
}
```

Add `TestForcedRecoveryConfigQueryFailureEntersFailover`, `TestForcedRecoveryOpenProcessFailureEntersFailover`, `TestForcedRecoveryPIDChangesAfterOpenFailsClosed`, `TestForcedRecoverySamePIDPendingStateObservesWithoutTerminate`, `TestForcedRecoveryProcessExitTimeout`, `TestForcedRecoverySCMStoppedTimeout`, `TestForcedRecoveryRejectsSameNewPID`, `TestForcedRecoveryRejectsDeadNewProcess`, and `TestForcedRecoveryObservesAutomaticSCMRestartWithoutCallingStart`. Each asserts that no later unsafe operation occurs after the named failure. The same-PID pending-state case revalidates to `StopPending` and proves recovery boundedly observes without terminating. The automatic-restart case supplies `StartPending -> Running(new PID)` after termination, expects zero explicit `Start` calls, then requires the same new-process image/liveness verification and heartbeat disposition.

- [ ] **Step 2: Run and verify forced cases fail**

Run: `cd agent && go test -race ./internal/watchdog -run TestForcedRecovery -count=1`

Expected: FAIL because attempt 2 still uses the coarse state-file PID path.

- [ ] **Step 3: Implement fail-closed forced ordering**

The forced function must:

```go
snapshot, err := c.backend.Query()
if err != nil {
	result.Disposition = RecoveryDispositionFailover
	return result, recoveryQueryError("query_scm_pid", snapshot, err)
}
if snapshot.State == serviceStopped {
	return c.ensureStarted(result)
}
if isPendingState(snapshot.State) {
	return c.observeTransition(result, snapshot)
}
if snapshot.State != serviceRunning || snapshot.PID <= 0 {
	result.Disposition = RecoveryDispositionFailover
	return result, &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "validate_scm_owner", State: string(snapshot.State), PID: snapshot.PID}
}
result.OldPID = snapshot.PID
configured, err := c.backend.ConfiguredBinaryPath()
if err != nil {
	result.Disposition = RecoveryDispositionFailover
	return result, recoveryQueryError("service_config", snapshot, err)
}
proc, err := c.backend.OpenProcess(snapshot.PID)
if err != nil {
	result.Disposition = RecoveryDispositionFailover
	return result, recoveryQueryError("open_service_process", snapshot, err)
}
defer proc.Close()
actual, err := proc.ImagePath()
if err != nil || !sameWindowsExecutable(configured, actual) {
	result.Disposition = RecoveryDispositionFailover
	return result, &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "validate_image", PID: snapshot.PID, Err: err}
}
alive, err := proc.Alive()
if err != nil || !alive {
	result.Disposition = RecoveryDispositionFailover
	return result, &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "validate_process_live", PID: snapshot.PID, Err: err}
}
fresh, err := c.backend.Query()
if err != nil {
	result.Disposition = RecoveryDispositionFailover
	return result, &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "revalidate_scm_pid", PID: snapshot.PID, Err: err}
}
if isPendingState(fresh.State) {
	// SCM recovery or another controller already owns the transition.
	return c.observeTransition(result, fresh)
}
if fresh.State != serviceRunning || fresh.PID != snapshot.PID {
	result.Disposition = RecoveryDispositionFailover
	return result, &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "revalidate_scm_owner", PID: snapshot.PID}
}
result.ActionTaken = true
if err := proc.Terminate(); err != nil {
	result.Disposition = RecoveryDispositionFailover
	return result, &RecoveryError{Class: RecoveryFailureControl, Phase: "terminate", PID: snapshot.PID, Err: err}
}
if err := proc.Wait(req.Context, c.processExitTimeout); err != nil {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return result, &RecoveryError{Class: RecoveryFailureCanceled, Phase: "wait_process_exit", PID: snapshot.PID, Err: err}
	}
	result.Disposition = RecoveryDispositionFailover
	return result, &RecoveryError{Class: RecoveryFailureProcessExitTimeout, Phase: "wait_process_exit", PID: snapshot.PID, Err: err}
}
```

Configuration lookup, process open/image/liveness, PID revalidation, termination, process-exit, and post-termination ownership/transition uncertainty set `RecoveryDispositionFailover` before returning; `RecoveryManager` exhausts recovery, recording restart history only if a side effect occurred. After process exit, observe SCM. If it reaches `Stopped`, call `Start`; if SCM failure recovery has already entered `StartPending` or `Running`, do not call `Start` and observe it. In both branches require `Running`, a nonzero PID different from `OldPID`, open the new PID, and validate its image and liveness before returning the heartbeat-verification disposition.

Use one pure comparison helper in the OS-neutral logic file:

```go
func normalizeWindowsExecutablePath(path string) string {
	path = strings.Trim(strings.TrimSpace(path), `"`)
	path = strings.ReplaceAll(path, "/", `\`)
	path = strings.TrimPrefix(path, `\\?\`)
	return strings.ToLower(strings.TrimRight(path, `\`))
}

func sameWindowsExecutable(configured, actual string) bool {
	return normalizeWindowsExecutablePath(configured) == normalizeWindowsExecutablePath(actual)
}
```

- [ ] **Step 4: Run forced tests and commit**

Run: `cd agent && go test -race ./internal/watchdog -run TestForcedRecovery -count=1`

Expected: PASS with exact ordered operations.

```bash
git add agent/internal/watchdog/recovery_windows_logic.go agent/internal/watchdog/recovery_windows_logic_test.go
git commit -m "fix(watchdog): validate the SCM process before forced recovery"
```

---

### Task 4: Concrete Windows SCM and process adapters

**Files:**
- Replace: `agent/internal/watchdog/recovery_windows.go:1-71`
- Create: `agent/internal/watchdog/recovery_windows_test.go`

**Interfaces:**
- Implements: `windowsRecoveryBackend` and `watchedProcess`.
- Uses: `mgr.Service.Query().ProcessId`, `mgr.Service.Config().BinaryPathName`, `windows.OpenProcess`, `QueryFullProcessImageName`, `TerminateProcess`, and `WaitForSingleObject`.

- [ ] **Step 1: Write native Windows executable-path tests**

```go
//go:build windows

func TestConfiguredExecutablePath(t *testing.T) {
	tests := []struct{ command, want string }{
		{`"C:\Program Files\Breeze\breeze-agent.exe" run`, `C:\Program Files\Breeze\breeze-agent.exe`},
		{`C:\Breeze\breeze-agent.exe run`, `C:\Breeze\breeze-agent.exe`},
	}
	for _, tt := range tests {
		got, err := configuredExecutablePath(tt.command)
		if err != nil || !strings.EqualFold(got, tt.want) {
			t.Fatalf("configuredExecutablePath(%q)=%q,%v want %q", tt.command, got, err, tt.want)
		}
	}
}
```

Add `TestWindowsWatchedProcessImageAndAlive`, `TestWindowsWatchedProcessWaitTimeout`, `TestWindowsWatchedProcessWaitCanceled`, `TestWindowsWatchedProcessCloseIsIdempotent`, and `TestWindowsWatchedProcessImagePathGrowsBuffer`. Open the current process without invoking `Terminate`; require a nonempty image, `Alive()==(true,nil)`, a bounded wait timeout, cancellation well before a long timeout, and two successful `Close` calls. The buffer test injects `ERROR_INSUFFICIENT_BUFFER` until the allocated UTF-16 buffer grows and then succeeds.

- [ ] **Step 2: Run on Windows and verify failures**

Run on Windows: `cd agent && go test -race ./internal/watchdog -run 'TestConfiguredExecutablePath|TestWindowsWatchedProcess' -count=1`

Expected: FAIL because the concrete adapter functions do not exist.

- [ ] **Step 3: Implement SCM status/config mapping**

`Query` maps `svc.Status.State` and returns `int(status.ProcessId)`. `ConfiguredBinaryPath` calls `Service.Config`, decomposes `BinaryPathName` with `windows.DecomposeCommandLine`, rejects an empty or non-absolute first argument, canonicalizes it with `windows.FullPath`, and returns only that executable path. `Start` and `Stop` return wrapped SCM errors. `NewRecoveryManager` constructs `osServiceController` with this Windows backend/controller; Linux and Darwin keep their build-tagged structured controllers.

- [ ] **Step 4: Implement verified process handles**

Open with:

```go
access := uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.PROCESS_TERMINATE | windows.SYNCHRONIZE)
handle, err := windows.OpenProcess(access, false, uint32(pid))
```

`ImagePath` calls `QueryFullProcessImageName` with a buffer that doubles from `MAX_PATH` up to the 32,767-character Windows limit on `ERROR_INSUFFICIENT_BUFFER`. `Terminate` uses `TerminateProcess`. `Alive` uses zero-timeout `WaitForSingleObject`: `WAIT_TIMEOUT` means alive, `WAIT_OBJECT_0` means exited, and every other result/error fails closed. `Wait(ctx, timeout)` polls `WaitForSingleObject` in short bounded slices (capped at 100ms), checking `ctx.Done()` between slices, and requires `WAIT_OBJECT_0` before the deadline. `Close` is idempotent; process-handle methods serialize access so close cannot race an in-flight query/wait.

- [ ] **Step 5: Run native/cross-compile verification and commit**

Run on Windows: `cd agent && go test -race ./internal/watchdog -count=1`

Run elsewhere: `cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/watchdog.test.exe ./internal/watchdog`

Expected: native tests PASS and cross-compilation succeeds.

```bash
git add agent/internal/watchdog/recovery_windows.go agent/internal/watchdog/recovery_windows_test.go
git commit -m "feat(watchdog): add verified Windows SCM recovery backend"
```

---

### Task 5: Main-loop verification and structured journals

**Files:**
- Modify: `agent/cmd/breeze-watchdog/main.go:188-556,745-790`
- Modify: `agent/cmd/breeze-watchdog/main_test.go`
- Modify: `agent/cmd/breeze-watchdog/failover_dispatch_test.go`
- Modify: `agent/internal/watchdog/integration_test.go`

**Interfaces:**
- Consumes: `RecoveryRequest` and `RecoveryResult`.
- Produces: `recoveryJournalFields(RecoveryResult, error) map[string]any`.
- Enters pending heartbeat verification only for `RecoveryDispositionVerifyHeartbeat` and immediately enters the existing failover path for `RecoveryDispositionFailover`.
- Produces: a watchdog-run cancellation context driven independently by SCM stop or process signals and threaded through every recovery request.

- [ ] **Step 1: Write journal-field and pending-verification tests**

```go
func TestRecoveryJournalFieldsSeparateStateAndSCMPIDs(t *testing.T) {
	result := watchdog.RecoveryResult{
		Action: watchdog.RecoveryActionForced, Phase: "verify_running",
		InitialState: "running", FinalState: "running", StateFilePID: 50,
		OldPID: 100, NewPID: 200, ActionTaken: true, Elapsed: 1500 * time.Millisecond,
	}
	fields := recoveryJournalFields(result, nil)
	if fields["state_file_pid"] != 50 || fields["old_scm_pid"] != 100 || fields["new_scm_pid"] != 200 || fields["elapsed_ms"] != int64(1500) {
		t.Fatalf("fields=%v", fields)
	}
}

func TestObservationDoesNotEnterPendingVerification(t *testing.T) {
	result := watchdog.RecoveryResult{Action: watchdog.RecoveryActionObserve, ActionTaken: false, Disposition: watchdog.RecoveryDispositionNone}
	if shouldVerifyRecovery(result) {
		t.Fatal("observation-only result entered heartbeat verification")
	}
}
```

Add `TestTerminalRecoveryDispositionEntersFailoverImmediately`, `TestFailoverStartAgentUsesEnsureStartIntent`, and `TestFailoverRestartAgentUsesRestartIntent`. The terminal test expects no next recovery attempt; the command tests prove `start_agent` cannot select forced attempt 2 even when the manager already has one attempt and `restart_agent` deliberately selects verified graceful restart after reset.

Add `TestSCMStopCancelsInFlightRecoveryBeforeServiceStopDeadline`: inject a controller blocked in a cancellable transition wait, start `runWatchdog` with a stop channel, close the channel after the controller reaches its barrier, and require `runWatchdog` to return promptly with no later start/terminate operation. Run it under `-race`.

- [ ] **Step 2: Run tests and verify missing helpers**

Run: `cd agent && go test -race ./cmd/breeze-watchdog -run 'TestRecoveryJournalFields|TestObservationDoesNotEnter' -count=1`

Expected: FAIL because structured journal mapping is not wired.

- [ ] **Step 3: Replace bool-based recovery dispatch**

```go
result, err := recovery.Attempt(watchdog.RecoveryRequest{
	StateFilePID: pid,
	Intent: watchdog.RecoveryIntentUnhealthy,
	Context: runCtx,
})
fields := recoveryJournalFields(result, err)
if err != nil {
	journal.Log(watchdog.LevelError, "recovery.failed", fields)
} else if result.ActionTaken {
	journal.Log(watchdog.LevelInfo, "recovery.attempt_dispatched", fields)
} else {
	journal.Log(watchdog.LevelInfo, "recovery.observed_transition", fields)
}
if result.Disposition == watchdog.RecoveryDispositionFailover {
	pendingVerify = nil
	wd.HandleEvent(watchdog.EventRecoveryExhausted)
} else if err == nil && result.Disposition == watchdog.RecoveryDispositionVerifyHeartbeat {
	pendingVerify = &struct{ startedAt time.Time }{startedAt: time.Now()}
}
```

Replace the current same-goroutine `sigChan`/`stopCh` cases with a cancellation context whose cause records signal versus SCM stop. Tiny forwarding goroutines watch the signal and stop channels independently of the main state loop, cancel `runCtx`, and exit when it is done. The main loop selects on `runCtx.Done()`. Because recovery currently executes synchronously inside that loop, this independent cancellation path is required: after `Attempt` returns `RecoveryFailureCanceled`, log the shutdown cause, close IPC, and return without feeding a recovery/failover event. Thread `runCtx` through failover-dispatch helpers too, so `start_agent` and `restart_agent` requests use the same cancellation boundary.

The fields include intent, action, disposition, phase, initial/final state, state-file PID, old/new SCM PID, elapsed milliseconds, failure class, and action-taken. The terminal disposition uses the existing `EventRecoveryExhausted` transition and clears pending verification. Map failover commands exactly as follows:

```go
case "restart_agent":
	recovery.Reset()
	result, err := recovery.Attempt(watchdog.RecoveryRequest{Intent: watchdog.RecoveryIntentRestart, Context: runCtx})
case "start_agent":
	result, err := recovery.Attempt(watchdog.RecoveryRequest{Intent: watchdog.RecoveryIntentEnsureStart, Context: runCtx})
```

Do not infer command intent from attempt count. Adapt integration harness calls to pass explicit `RecoveryIntentUnhealthy`.

- [ ] **Step 4: Run watchdog packages with race detection**

Run: `cd agent && go test -race ./internal/watchdog ./cmd/breeze-watchdog -count=1`

Expected: PASS; heartbeat verification/flap tests remain green.

- [ ] **Step 5: Run full agent and Windows verification**

Run: `cd agent && go test -race ./...`

Run on Windows: `cd agent && go test -race ./internal/watchdog ./cmd/breeze-watchdog -count=1`

Expected: PASS with no race report.

- [ ] **Step 6: Commit main-loop integration**

```bash
git add agent/cmd/breeze-watchdog/main.go agent/cmd/breeze-watchdog/main_test.go agent/cmd/breeze-watchdog/failover_dispatch_test.go agent/internal/watchdog/integration_test.go
git commit -m "fix(watchdog): journal and verify Windows recovery outcomes"
```

## Plan Completion Gate

- A 15-second `StopPending` interval never causes premature `Start`.
- A 35-second stop timeout returns a typed failure and does not call `Start`.
- Transitional observation consumes no attempt or 24-hour restart record.
- Forced recovery uses and revalidates the fresh SCM PID.
- Image/PID mismatch, exit timeout, stopped timeout, and start timeout fail closed.
- Ownership/PID/image uncertainty exhausts recovery and enters failover without repeating forced attempt 2.
- SCM control races and automatic SCM restart are observed without competing `Stop`/`Start` calls.
- SCM stop or process signal cancels an in-flight transition/process wait promptly and does not leave the watchdog service stuck stopping.
- A successful forced recovery has a new live SCM PID and then enters heartbeat verification.
- Journal fields distinguish state-file PID from SCM old/new PIDs.
- Native Windows tests, watchdog race tests, and `cd agent && go test -race ./...` pass.

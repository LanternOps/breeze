package watchdog

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// testAgentImagePath is the configured service binary every forced-recovery
// fixture validates against.
const testAgentImagePath = `C:\Program Files\Breeze\breeze-agent.exe`

// This file is deliberately OS-neutral: it exercises the Windows recovery state
// machine through fakes so the transition ordering is testable on any host.
// Nothing here may import golang.org/x/sys/windows.

// Sentinel errors standing in for the SCM control errors the state machine must
// treat as races rather than failures. The logic never inspects the error
// identity — it always re-queries SCM — so plain sentinels are enough to prove
// the race handling without importing the windows package.
var (
	errFakeServiceNotActive       = errors.New("ERROR_SERVICE_NOT_ACTIVE")
	errFakeServiceCannotAcceptCtl = errors.New("ERROR_SERVICE_CANNOT_ACCEPT_CTRL")
	errFakeServiceAlreadyRunning  = errors.New("ERROR_SERVICE_ALREADY_RUNNING")
)

// fakeRecoveryClock is a virtual clock: Sleep advances time instantly so
// timeout paths run without wall-clock delay. Setting blockAtSleep makes the
// Nth Sleep park until the request context is canceled, which is the
// deterministic barrier the cancellation tests synchronize on.
type fakeRecoveryClock struct {
	mu           sync.Mutex
	now          time.Time
	sleeps       int
	blockAtSleep int
	reached      chan struct{}
}

func newFakeRecoveryClock() *fakeRecoveryClock {
	return &fakeRecoveryClock{
		now:     time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC),
		reached: make(chan struct{}),
	}
}

func (c *fakeRecoveryClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeRecoveryClock) Sleep(ctx context.Context, d time.Duration) error {
	c.mu.Lock()
	c.sleeps++
	n := c.sleeps
	c.mu.Unlock()

	if c.blockAtSleep > 0 && n == c.blockAtSleep {
		close(c.reached)
		<-ctx.Done()
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
	return nil
}

// fakeWatchedProcess records the process-handle operations the state machine
// performs, in order, on the owning backend.
type fakeWatchedProcess struct {
	backend        *fakeWindowsBackend
	imagePath      string
	imageErr       error
	alive          bool
	aliveErr       error
	terminateErr   error
	waitErr        error
	terminateCalls int
	closeCalls     int
	// blockWait parks Wait until the context is canceled, after signaling
	// waitReached. It is the barrier for the process-exit cancellation test.
	blockWait   bool
	waitReached chan struct{}
}

func newFakeWatchedProcess(imagePath string) *fakeWatchedProcess {
	return &fakeWatchedProcess{imagePath: imagePath, alive: true, waitReached: make(chan struct{})}
}

func (p *fakeWatchedProcess) ImagePath() (string, error) {
	p.backend.record("image")
	return p.imagePath, p.imageErr
}

func (p *fakeWatchedProcess) Alive() (bool, error) {
	p.backend.record("alive")
	return p.alive, p.aliveErr
}

func (p *fakeWatchedProcess) Terminate() error {
	p.backend.record("terminate")
	p.terminateCalls++
	return p.terminateErr
}

func (p *fakeWatchedProcess) Wait(ctx context.Context, _ time.Duration) error {
	p.backend.record("wait")
	if p.blockWait {
		close(p.waitReached)
		<-ctx.Done()
		return ctx.Err()
	}
	return p.waitErr
}

func (p *fakeWatchedProcess) Close() error {
	p.closeCalls++
	return nil
}

// fakeWindowsBackend replays a scripted sequence of SCM snapshots and records
// every backend operation so tests can assert exact ordering. Once the scripted
// snapshots are exhausted the last one repeats forever, which is what lets the
// timeout tests park SCM in a pending state.
type fakeWindowsBackend struct {
	mu             sync.Mutex
	snapshots      []serviceSnapshot
	queryIdx       int
	operations     []string
	stopCalls      int
	startCalls     int
	configuredPath string
	configErr      error
	queryErr       error
	stopErr        error
	startErr       error
	openErr        error
	processes      map[int]*fakeWatchedProcess
	openedPIDs     []int
}

func newFakeWindowsBackend(snapshots ...serviceSnapshot) *fakeWindowsBackend {
	return &fakeWindowsBackend{
		snapshots: snapshots,
		processes: map[int]*fakeWatchedProcess{},
	}
}

func (b *fakeWindowsBackend) record(op string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.operations = append(b.operations, op)
}

func (b *fakeWindowsBackend) ops() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.Join(b.operations, ",")
}

func (b *fakeWindowsBackend) Query() (serviceSnapshot, error) {
	b.record("query")
	if b.queryErr != nil {
		return serviceSnapshot{}, b.queryErr
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.snapshots) == 0 {
		return serviceSnapshot{}, errors.New("fake backend has no snapshots")
	}
	idx := b.queryIdx
	if idx >= len(b.snapshots) {
		idx = len(b.snapshots) - 1
	} else {
		b.queryIdx++
	}
	return b.snapshots[idx], nil
}

func (b *fakeWindowsBackend) ConfiguredBinaryPath() (string, error) {
	b.record("config")
	return b.configuredPath, b.configErr
}

func (b *fakeWindowsBackend) Stop() error {
	b.record("stop")
	b.mu.Lock()
	b.stopCalls++
	b.mu.Unlock()
	return b.stopErr
}

func (b *fakeWindowsBackend) Start() error {
	b.record("start")
	b.mu.Lock()
	b.startCalls++
	b.mu.Unlock()
	return b.startErr
}

func (b *fakeWindowsBackend) OpenProcess(pid int) (watchedProcess, error) {
	b.record("open:" + itoa(pid))
	b.mu.Lock()
	b.openedPIDs = append(b.openedPIDs, pid)
	b.mu.Unlock()
	if b.openErr != nil {
		return nil, b.openErr
	}
	proc, ok := b.processes[pid]
	if !ok {
		return nil, errors.New("fake backend has no process for pid")
	}
	proc.backend = b
	return proc, nil
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf []byte
	for v > 0 {
		buf = append([]byte{byte('0' + v%10)}, buf...)
		v /= 10
	}
	if neg {
		buf = append([]byte{'-'}, buf...)
	}
	return string(buf)
}

func newTestWindowsRecoveryController(backend *fakeWindowsBackend) *windowsRecoveryController {
	return newWindowsRecoveryController(backend, newFakeRecoveryClock())
}

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
	if recoveryErr.Class != RecoveryFailureStopTimeout {
		t.Fatalf("class=%q, want %q", recoveryErr.Class, RecoveryFailureStopTimeout)
	}
	if backend.startCalls != 0 || !result.ActionTaken {
		t.Fatalf("startCalls=%d result=%+v", backend.startCalls, result)
	}
	// A stop timeout is retryable: attempt 2 escalates to forced recovery, so
	// it must not latch terminal failover.
	if result.Disposition == RecoveryDispositionFailover {
		t.Fatalf("stop timeout must not be terminal, disposition=%q", result.Disposition)
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
	if result.Disposition != RecoveryDispositionNone {
		t.Fatalf("disposition=%q, want %q so the next attempt can start it", result.Disposition, RecoveryDispositionNone)
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
	if err != nil || backend.ops() != "query,stop,query,query,start,query,query" {
		t.Fatalf("result=%+v err=%v operations=%v", result, err, backend.operations)
	}
	if result.OldPID != 100 || result.NewPID != 200 || !result.ActionTaken {
		t.Fatalf("result=%+v", result)
	}
	if result.Disposition != RecoveryDispositionVerifyHeartbeat {
		t.Fatalf("disposition=%q, want %q", result.Disposition, RecoveryDispositionVerifyHeartbeat)
	}
	if result.InitialState != string(serviceRunning) || result.FinalState != string(serviceRunning) {
		t.Fatalf("initial=%q final=%q", result.InitialState, result.FinalState)
	}
}

func TestGracefulAlreadyStoppedStartsWithoutStop(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceRunning, PID: 200},
	)
	controller := newTestWindowsRecoveryController(backend)
	result, err := controller.Recover(1, RecoveryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if backend.stopCalls != 0 || backend.startCalls != 1 {
		t.Fatalf("stop=%d start=%d, want 0 and 1", backend.stopCalls, backend.startCalls)
	}
	if result.Action != RecoveryActionStart || !result.ActionTaken || result.NewPID != 200 {
		t.Fatalf("result=%+v", result)
	}
	if result.Disposition != RecoveryDispositionVerifyHeartbeat {
		t.Fatalf("disposition=%q", result.Disposition)
	}
}

func TestEnsureStartAlreadyRunningObserves(t *testing.T) {
	backend := newFakeWindowsBackend(serviceSnapshot{State: serviceRunning, PID: 100})
	controller := newTestWindowsRecoveryController(backend)
	// Attempt 2 would be the forced rung for RecoveryIntentUnhealthy. An
	// explicit ensure-start must never inherit that escalation.
	result, err := controller.Recover(2, RecoveryRequest{Intent: RecoveryIntentEnsureStart})
	if err != nil {
		t.Fatal(err)
	}
	if backend.startCalls != 0 || backend.stopCalls != 0 || result.ActionTaken {
		t.Fatalf("start=%d stop=%d result=%+v", backend.startCalls, backend.stopCalls, result)
	}
	if result.Action != RecoveryActionObserve {
		t.Fatalf("action=%q, want %q", result.Action, RecoveryActionObserve)
	}
	// Nothing was restarted, so there is nothing for the heartbeat check to
	// verify; claiming otherwise would report a recovery that never happened.
	if result.Disposition != RecoveryDispositionNone {
		t.Fatalf("disposition=%q, want %q", result.Disposition, RecoveryDispositionNone)
	}
}

func TestEnsureStartFromStoppedStarts(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceRunning, PID: 300},
	)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{Intent: RecoveryIntentEnsureStart})
	if err != nil {
		t.Fatal(err)
	}
	if backend.stopCalls != 0 || backend.startCalls != 1 || result.NewPID != 300 || !result.ActionTaken {
		t.Fatalf("stop=%d start=%d result=%+v", backend.stopCalls, backend.startCalls, result)
	}
}

func TestRestartIntentAlwaysGracefulRegardlessOfAttempt(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceRunning, PID: 200},
	)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{Intent: RecoveryIntentRestart})
	if err != nil {
		t.Fatal(err)
	}
	if got := backend.ops(); got != "query,stop,query,start,query" {
		t.Fatalf("operations=%q", got)
	}
	if result.Action != RecoveryActionGraceful {
		t.Fatalf("action=%q, want %q", result.Action, RecoveryActionGraceful)
	}
}

func TestStartPendingToRunningReturnsHeartbeatDisposition(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceStartPending, PID: 200},
		serviceSnapshot{State: serviceRunning, PID: 200},
	)
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if result.ActionTaken || result.Action != RecoveryActionObserve {
		t.Fatalf("result=%+v", result)
	}
	if result.Disposition != RecoveryDispositionVerifyHeartbeat || result.NewPID != 200 {
		t.Fatalf("result=%+v", result)
	}
	if backend.startCalls != 0 || backend.stopCalls != 0 {
		t.Fatalf("start=%d stop=%d", backend.startCalls, backend.stopCalls)
	}
}

func TestStartPendingToStoppedDefersStart(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceStartPending, PID: 200},
		serviceSnapshot{State: serviceStopped},
	)
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	// Deferring means: no competing Start now, and no disposition that would
	// make the caller believe the agent is on its way back.
	if backend.startCalls != 0 || result.ActionTaken || result.Disposition != RecoveryDispositionNone {
		t.Fatalf("start=%d result=%+v", backend.startCalls, result)
	}
}

func TestStartTimeout(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceStartPending, PID: 200},
	)
	controller := newTestWindowsRecoveryController(backend)
	result, err := controller.Recover(1, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureStartTimeout {
		t.Fatalf("err=%v, want %q", err, RecoveryFailureStartTimeout)
	}
	if !result.ActionTaken || result.Disposition == RecoveryDispositionVerifyHeartbeat {
		t.Fatalf("result=%+v", result)
	}
}

// TestRunningWithZeroPIDFails: SCM claims Running but names no PID. That is
// transition uncertainty, so the restart must not be reported as successful.
func TestRunningWithZeroPIDFails(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceRunning, PID: 0},
	)
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureIdentityMismatch {
		t.Fatalf("err=%v, want identity mismatch", err)
	}
	if result.Disposition != RecoveryDispositionFailover || result.NewPID != 0 {
		t.Fatalf("result=%+v", result)
	}
}

// TestRunningWithDeadPIDFails: SCM reports Running but still owns the PID we
// just restarted away from, so the "new" process is the old, dead one.
func TestRunningWithDeadPIDFails(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceRunning, PID: 100},
	)
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureIdentityMismatch {
		t.Fatalf("err=%v, want identity mismatch", err)
	}
	if result.Disposition != RecoveryDispositionFailover {
		t.Fatalf("result=%+v", result)
	}
}

func TestStopControlRaceRequeriesAndObservesSCMRecovery(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopPending, PID: 100},
		serviceSnapshot{State: serviceStopped},
	)
	backend.stopErr = errFakeServiceCannotAcceptCtl
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	if err != nil {
		t.Fatalf("a stop that lost the race to SCM must not be a failure: %v", err)
	}
	// SCM already owns the stop: observe it, never issue a competing start.
	if backend.startCalls != 0 || backend.stopCalls != 1 {
		t.Fatalf("start=%d stop=%d", backend.startCalls, backend.stopCalls)
	}
	if result.Disposition != RecoveryDispositionNone {
		t.Fatalf("result=%+v", result)
	}
	// The control was issued, so the attempt is still charged.
	if !result.ActionTaken {
		t.Fatalf("an issued control must consume the attempt: %+v", result)
	}
}

func TestStopControlRaceOnAlreadyStoppedServiceContinuesToStart(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceRunning, PID: 200},
	)
	backend.stopErr = errFakeServiceNotActive
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if backend.startCalls != 1 || result.NewPID != 200 {
		t.Fatalf("start=%d result=%+v", backend.startCalls, result)
	}
}

func TestStartControlRaceRequeriesWithoutSecondStart(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceRunning, PID: 200},
	)
	backend.startErr = errFakeServiceAlreadyRunning
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if backend.startCalls != 1 {
		t.Fatalf("startCalls=%d, want exactly 1", backend.startCalls)
	}
	if result.NewPID != 200 || result.Disposition != RecoveryDispositionVerifyHeartbeat {
		t.Fatalf("result=%+v", result)
	}
}

func TestControlErrorWithUnchangedStateIsControlFailure(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceRunning, PID: 100},
	)
	backend.stopErr = errors.New("access denied")
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureControl {
		t.Fatalf("err=%v, want %q", err, RecoveryFailureControl)
	}
	if backend.startCalls != 0 || !result.ActionTaken {
		t.Fatalf("start=%d result=%+v", backend.startCalls, result)
	}
}

func TestRecoveryCancellationInterruptsPendingObservation(t *testing.T) {
	backend := newFakeWindowsBackend(serviceSnapshot{State: serviceStopPending, PID: 100})
	clk := newFakeRecoveryClock()
	clk.blockAtSleep = 1
	controller := newWindowsRecoveryController(backend, clk)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type outcome struct {
		result RecoveryResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := controller.Recover(1, RecoveryRequest{Context: ctx})
		done <- outcome{result, err}
	}()

	select {
	case <-clk.reached:
	case <-time.After(5 * time.Second):
		t.Fatal("controller never reached the observation wait barrier")
	}
	cancel()

	var got outcome
	select {
	case got = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not interrupt the observation promptly")
	}

	var recoveryErr *RecoveryError
	if !errors.As(got.err, &recoveryErr) || recoveryErr.Class != RecoveryFailureCanceled {
		t.Fatalf("err=%v, want %q", got.err, RecoveryFailureCanceled)
	}
	// Cancellation is a shutdown, not a diagnosis: it must not latch failover.
	if got.result.Disposition == RecoveryDispositionFailover {
		t.Fatalf("cancellation escalated to failover: %+v", got.result)
	}
	if backend.startCalls != 0 || backend.stopCalls != 0 {
		t.Fatalf("start=%d stop=%d after cancellation", backend.startCalls, backend.stopCalls)
	}
}

func TestRecoveryCancellationInterruptsStopWaitAfterControl(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopPending, PID: 100},
	)
	clk := newFakeRecoveryClock()
	clk.blockAtSleep = 1
	controller := newWindowsRecoveryController(backend, clk)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type outcome struct {
		result RecoveryResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := controller.Recover(1, RecoveryRequest{Context: ctx})
		done <- outcome{result, err}
	}()

	select {
	case <-clk.reached:
	case <-time.After(5 * time.Second):
		t.Fatal("controller never reached the stop wait barrier")
	}
	cancel()

	var got outcome
	select {
	case got = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not interrupt the stop wait promptly")
	}

	var recoveryErr *RecoveryError
	if !errors.As(got.err, &recoveryErr) || recoveryErr.Class != RecoveryFailureCanceled {
		t.Fatalf("err=%v, want %q", got.err, RecoveryFailureCanceled)
	}
	// The Stop control was already issued, so the attempt stays charged.
	if !got.result.ActionTaken {
		t.Fatalf("result=%+v, want ActionTaken", got.result)
	}
	if backend.startCalls != 0 {
		t.Fatalf("startCalls=%d after cancellation, want 0", backend.startCalls)
	}
}

func TestQueryFailureIsNotAnAttempt(t *testing.T) {
	backend := newFakeWindowsBackend(serviceSnapshot{State: serviceRunning, PID: 100})
	backend.queryErr = errors.New("SCM unavailable")
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureQuery {
		t.Fatalf("err=%v, want %q", err, RecoveryFailureQuery)
	}
	if result.ActionTaken {
		t.Fatalf("a failed query issued no side effect: %+v", result)
	}
}

func TestUnexpectedInitialStateFailsClosed(t *testing.T) {
	backend := newFakeWindowsBackend(serviceSnapshot{State: servicePaused, PID: 100})
	result, err := newTestWindowsRecoveryController(backend).Recover(1, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureIdentityMismatch {
		t.Fatalf("err=%v, want identity mismatch", err)
	}
	if backend.stopCalls != 0 || backend.startCalls != 0 || result.Disposition != RecoveryDispositionFailover {
		t.Fatalf("stop=%d start=%d result=%+v", backend.stopCalls, backend.startCalls, result)
	}
}

// forcedRecoverySuccessBackend is the canonical happy-path forced fixture: SCM
// names oldPID twice (initial query + revalidation), the service settles
// Stopped once the process exits, then Start brings it back as newPID. Both
// processes carry the configured image.
func forcedRecoverySuccessBackend(oldPID, newPID int) *fakeWindowsBackend {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: oldPID},
		serviceSnapshot{State: serviceRunning, PID: oldPID},
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceRunning, PID: newPID},
	)
	backend.configuredPath = testAgentImagePath
	backend.processes[oldPID] = newFakeWatchedProcess(testAgentImagePath)
	backend.processes[newPID] = newFakeWatchedProcess(testAgentImagePath)
	return backend
}

// TestForcedRecoveryUsesFreshSCMPIDNotStateFilePID is the core safety property:
// the state-file PID is a stale hint that may have been recycled onto an
// unrelated process, so every destructive action must target the PID SCM names
// right now.
func TestForcedRecoveryUsesFreshSCMPIDNotStateFilePID(t *testing.T) {
	backend := forcedRecoverySuccessBackend(200, 300)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{StateFilePID: 999})
	if err != nil {
		t.Fatal(err)
	}
	if result.OldPID != 200 || result.NewPID != 300 {
		t.Fatalf("result=%+v, want OldPID=200 NewPID=300 from SCM, not the state file", result)
	}
	if !reflect.DeepEqual(backend.openedPIDs, []int{200, 300}) {
		t.Fatalf("openedPIDs=%v, want [200 300]: the state-file PID 999 must never be opened", backend.openedPIDs)
	}
	if result.StateFilePID != 999 || result.Disposition != RecoveryDispositionVerifyHeartbeat {
		t.Fatalf("result=%+v", result)
	}
}

// TestForcedRecoveryImageMismatchDoesNotTerminateOrStart: SCM named a PID whose
// image is not our agent. That PID was recycled onto someone else's process —
// terminating it would kill an arbitrary program.
func TestForcedRecoveryImageMismatchDoesNotTerminateOrStart(t *testing.T) {
	backend := newFakeWindowsBackend(serviceSnapshot{State: serviceRunning, PID: 200})
	backend.configuredPath = testAgentImagePath
	proc := newFakeWatchedProcess(`C:\Windows\System32\notepad.exe`)
	backend.processes[200] = proc
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureIdentityMismatch {
		t.Fatalf("err=%v, want identity mismatch", err)
	}
	if result.Disposition != RecoveryDispositionFailover {
		t.Fatalf("disposition=%q, want failover: an unidentifiable process is never retried", result.Disposition)
	}
	if proc.terminateCalls != 0 || backend.startCalls != 0 {
		t.Fatalf("terminate=%d start=%d, want 0 and 0", proc.terminateCalls, backend.startCalls)
	}
}

// TestForcedRecoveryOrdersExitBeforeStart pins the exact required ordering:
// validate -> terminate -> process exited -> Stopped -> start -> new live PID.
// Starting before the old process has actually exited is how two agents end up
// running at once.
func TestForcedRecoveryOrdersExitBeforeStart(t *testing.T) {
	backend := forcedRecoverySuccessBackend(100, 200)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	want := "query,config,open:100,image,alive,query,terminate,wait,query,start,query,open:200,image,alive"
	if got := backend.ops(); got != want {
		t.Fatalf("operations=%q,\n want %q", got, want)
	}
	if result.Action != RecoveryActionForced || !result.ActionTaken {
		t.Fatalf("result=%+v", result)
	}
	if result.Disposition != RecoveryDispositionVerifyHeartbeat || result.NewPID != 200 {
		t.Fatalf("result=%+v", result)
	}
}

// TestForcedRecoveryConfigQueryFailureEntersFailover: if we cannot read SCM's
// state or the configured binary path, we cannot prove what we would be
// killing. That is terminal, not retryable.
func TestForcedRecoveryConfigQueryFailureEntersFailover(t *testing.T) {
	t.Run("scm query fails", func(t *testing.T) {
		backend := forcedRecoverySuccessBackend(100, 200)
		backend.queryErr = errors.New("SCM unavailable")
		result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
		var recoveryErr *RecoveryError
		if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureQuery {
			t.Fatalf("err=%v, want %q", err, RecoveryFailureQuery)
		}
		if result.Disposition != RecoveryDispositionFailover || result.ActionTaken {
			t.Fatalf("result=%+v", result)
		}
		if got := backend.ops(); got != "query" {
			t.Fatalf("operations=%q, want no action after a failed query", got)
		}
	})

	t.Run("service config fails", func(t *testing.T) {
		backend := forcedRecoverySuccessBackend(100, 200)
		backend.configErr = errors.New("OpenService config denied")
		result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
		var recoveryErr *RecoveryError
		if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureQuery {
			t.Fatalf("err=%v, want %q", err, RecoveryFailureQuery)
		}
		if result.Disposition != RecoveryDispositionFailover {
			t.Fatalf("disposition=%q, want failover", result.Disposition)
		}
		if got := backend.ops(); got != "query,config" {
			t.Fatalf("operations=%q, want nothing opened or terminated", got)
		}
		if backend.startCalls != 0 || backend.processes[100].terminateCalls != 0 {
			t.Fatalf("start=%d terminate=%d", backend.startCalls, backend.processes[100].terminateCalls)
		}
	})
}

// TestForcedRecoveryOpenProcessFailureEntersFailover: a PID we cannot open is a
// PID we cannot identify.
func TestForcedRecoveryOpenProcessFailureEntersFailover(t *testing.T) {
	backend := forcedRecoverySuccessBackend(100, 200)
	backend.openErr = errors.New("access denied")
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureQuery {
		t.Fatalf("err=%v, want %q", err, RecoveryFailureQuery)
	}
	if result.Disposition != RecoveryDispositionFailover || result.ActionTaken {
		t.Fatalf("result=%+v", result)
	}
	if got := backend.ops(); got != "query,config,open:100" {
		t.Fatalf("operations=%q, want nothing terminated or started", got)
	}
}

// TestForcedRecoveryPIDChangesAfterOpenFailsClosed: SCM handed us a different
// PID between the identity check and the termination, so the handle we
// validated no longer belongs to the service. Killing it anyway would terminate
// a process the SCM has already moved on from.
func TestForcedRecoveryPIDChangesAfterOpenFailsClosed(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceRunning, PID: 200},
	)
	backend.configuredPath = testAgentImagePath
	backend.processes[100] = newFakeWatchedProcess(testAgentImagePath)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureIdentityMismatch {
		t.Fatalf("err=%v, want identity mismatch", err)
	}
	if recoveryErr.Phase != "revalidate_scm_owner" {
		t.Fatalf("phase=%q, want revalidate_scm_owner", recoveryErr.Phase)
	}
	if result.Disposition != RecoveryDispositionFailover || result.ActionTaken {
		t.Fatalf("result=%+v", result)
	}
	if backend.processes[100].terminateCalls != 0 || backend.startCalls != 0 {
		t.Fatalf("terminate=%d start=%d", backend.processes[100].terminateCalls, backend.startCalls)
	}
}

// TestForcedRecoverySamePIDPendingStateObservesWithoutTerminate: SCM entered a
// transition while we were validating. It already owns the recovery, so we
// bound-observe it instead of racing it with a termination.
func TestForcedRecoverySamePIDPendingStateObservesWithoutTerminate(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopPending, PID: 100},
		serviceSnapshot{State: serviceStopped},
	)
	backend.configuredPath = testAgentImagePath
	backend.processes[100] = newFakeWatchedProcess(testAgentImagePath)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	if err != nil {
		t.Fatalf("observing SCM's own transition is not a failure: %v", err)
	}
	if backend.processes[100].terminateCalls != 0 || backend.startCalls != 0 {
		t.Fatalf("terminate=%d start=%d, want 0 and 0", backend.processes[100].terminateCalls, backend.startCalls)
	}
	// Nothing was restarted, so nothing was charged and there is no recovery
	// for the heartbeat check to confirm.
	if result.ActionTaken || result.Disposition != RecoveryDispositionNone {
		t.Fatalf("result=%+v", result)
	}
	if result.Action != RecoveryActionObserve {
		t.Fatalf("action=%q, want %q", result.Action, RecoveryActionObserve)
	}
}

// TestForcedRecoveryProcessExitTimeout: the process did not exit, so the old
// agent may still hold its ports and locks. Starting a second one would be
// worse than failing over.
func TestForcedRecoveryProcessExitTimeout(t *testing.T) {
	backend := forcedRecoverySuccessBackend(100, 200)
	backend.processes[100].waitErr = errors.New("process still alive after 35s")
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureProcessExitTimeout {
		t.Fatalf("err=%v, want %q", err, RecoveryFailureProcessExitTimeout)
	}
	if result.Disposition != RecoveryDispositionFailover {
		t.Fatalf("disposition=%q, want failover", result.Disposition)
	}
	if backend.startCalls != 0 {
		t.Fatalf("startCalls=%d, want 0: never start while the old process may still be alive", backend.startCalls)
	}
	// The terminate was issued, so the attempt is charged.
	if !result.ActionTaken {
		t.Fatalf("result=%+v, want ActionTaken", result)
	}
}

// TestForcedRecoverySCMStoppedTimeout: the process exited but SCM never settled,
// so we cannot tell whether SCM is about to restart the service itself.
func TestForcedRecoverySCMStoppedTimeout(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopPending, PID: 100},
	)
	backend.configuredPath = testAgentImagePath
	backend.processes[100] = newFakeWatchedProcess(testAgentImagePath)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureStopTimeout {
		t.Fatalf("err=%v, want %q", err, RecoveryFailureStopTimeout)
	}
	if result.Disposition != RecoveryDispositionFailover || backend.startCalls != 0 {
		t.Fatalf("result=%+v start=%d", result, backend.startCalls)
	}
}

// TestForcedRecoveryRejectsSameNewPID: SCM still names the PID we terminated.
// The "new" process is the corpse of the old one.
func TestForcedRecoveryRejectsSameNewPID(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceRunning, PID: 100},
	)
	backend.configuredPath = testAgentImagePath
	backend.processes[100] = newFakeWatchedProcess(testAgentImagePath)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureIdentityMismatch {
		t.Fatalf("err=%v, want identity mismatch", err)
	}
	if result.Disposition != RecoveryDispositionFailover || result.NewPID != 0 {
		t.Fatalf("result=%+v", result)
	}
	if !reflect.DeepEqual(backend.openedPIDs, []int{100}) {
		t.Fatalf("openedPIDs=%v, want only the old PID", backend.openedPIDs)
	}
}

// TestForcedRecoveryRejectsDeadNewProcess: SCM says Running with a fresh PID but
// that process is already gone. Reporting a recovery here would strand the
// device.
func TestForcedRecoveryRejectsDeadNewProcess(t *testing.T) {
	backend := forcedRecoverySuccessBackend(100, 200)
	backend.processes[200].alive = false
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureIdentityMismatch {
		t.Fatalf("err=%v, want identity mismatch", err)
	}
	if result.Disposition != RecoveryDispositionFailover {
		t.Fatalf("disposition=%q, want failover", result.Disposition)
	}
}

// TestForcedRecoveryObservesAutomaticSCMRestartWithoutCallingStart: SCM's own
// failure-recovery action restarted the service after our termination. Issuing
// a competing Start would race it, so we observe — but still hold the new
// process to the same identity and liveness proof.
func TestForcedRecoveryObservesAutomaticSCMRestartWithoutCallingStart(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStartPending, PID: 200},
		serviceSnapshot{State: serviceRunning, PID: 200},
	)
	backend.configuredPath = testAgentImagePath
	backend.processes[100] = newFakeWatchedProcess(testAgentImagePath)
	backend.processes[200] = newFakeWatchedProcess(testAgentImagePath)
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if backend.startCalls != 0 {
		t.Fatalf("startCalls=%d, want 0: SCM already owns the restart", backend.startCalls)
	}
	want := "query,config,open:100,image,alive,query,terminate,wait,query,query,open:200,image,alive"
	if got := backend.ops(); got != want {
		t.Fatalf("operations=%q,\n want %q", got, want)
	}
	if result.NewPID != 200 || result.Disposition != RecoveryDispositionVerifyHeartbeat {
		t.Fatalf("result=%+v", result)
	}
}

// TestForcedRecoveryStartRaceEndingStoppedVerifiesNoNewProcess: our Start lost a
// race to SCM and the transition SCM owned ended back at Stopped. Nothing came
// up, so there is no new PID — the controller must not try to verify one, and
// must not report a recovery that did not happen.
func TestForcedRecoveryStartRaceEndingStoppedVerifiesNoNewProcess(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceStopPending, PID: 100},
		serviceSnapshot{State: serviceStopped},
	)
	backend.configuredPath = testAgentImagePath
	backend.processes[100] = newFakeWatchedProcess(testAgentImagePath)
	backend.startErr = errFakeServiceCannotAcceptCtl
	result, err := newTestWindowsRecoveryController(backend).Recover(2, RecoveryRequest{})
	if err != nil {
		t.Fatalf("losing a start race to SCM is not a failure: %v", err)
	}
	if result.Disposition != RecoveryDispositionVerifyHeartbeat && result.Disposition != RecoveryDispositionNone {
		t.Fatalf("disposition=%q", result.Disposition)
	}
	if result.Disposition == RecoveryDispositionVerifyHeartbeat {
		t.Fatalf("nothing came up, so nothing is coming back: %+v", result)
	}
	if result.NewPID != 0 {
		t.Fatalf("NewPID=%d, want 0", result.NewPID)
	}
	// Only the terminated process was ever opened: there is no new PID to open.
	if !reflect.DeepEqual(backend.openedPIDs, []int{100}) {
		t.Fatalf("openedPIDs=%v, want only the terminated PID", backend.openedPIDs)
	}
}

// TestRecoveryCancellationInterruptsProcessExitWait: the watchdog is shutting
// down mid-forced-recovery. The process-exit wait must unblock immediately
// rather than hold shutdown for the full recovery deadline, and a shutdown must
// never be diagnosed as failover.
func TestRecoveryCancellationInterruptsProcessExitWait(t *testing.T) {
	backend := forcedRecoverySuccessBackend(100, 200)
	proc := backend.processes[100]
	proc.blockWait = true
	controller := newTestWindowsRecoveryController(backend)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type outcome struct {
		result RecoveryResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := controller.Recover(2, RecoveryRequest{Context: ctx})
		done <- outcome{result, err}
	}()

	select {
	case <-proc.waitReached:
	case <-time.After(5 * time.Second):
		t.Fatal("controller never reached the process-exit wait barrier")
	}
	cancel()

	var got outcome
	select {
	case got = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not interrupt the process-exit wait promptly")
	}

	var recoveryErr *RecoveryError
	if !errors.As(got.err, &recoveryErr) || recoveryErr.Class != RecoveryFailureCanceled {
		t.Fatalf("err=%v, want %q", got.err, RecoveryFailureCanceled)
	}
	if got.result.Disposition == RecoveryDispositionFailover {
		t.Fatalf("cancellation escalated to failover: %+v", got.result)
	}
	// The terminate landed before the cancellation, so it stays charged.
	if !got.result.ActionTaken || proc.terminateCalls != 1 {
		t.Fatalf("result=%+v terminate=%d", got.result, proc.terminateCalls)
	}
	if backend.startCalls != 0 {
		t.Fatalf("startCalls=%d after cancellation, want 0", backend.startCalls)
	}
}

func TestNormalizeWindowsExecutablePath(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		actual     string
		want       bool
	}{
		{"identical", `C:\Program Files\Breeze\breeze-agent.exe`, `C:\Program Files\Breeze\breeze-agent.exe`, true},
		{"case insensitive", `C:\Program Files\Breeze\breeze-agent.exe`, `c:\program files\breeze\BREEZE-AGENT.EXE`, true},
		{"quoted service config", `"C:\Program Files\Breeze\breeze-agent.exe"`, `C:\Program Files\Breeze\breeze-agent.exe`, true},
		{"surrounding whitespace", "  C:\\Breeze\\breeze-agent.exe  ", `C:\Breeze\breeze-agent.exe`, true},
		{"forward slashes", `C:/Breeze/breeze-agent.exe`, `C:\Breeze\breeze-agent.exe`, true},
		{"extended-length prefix", `\\?\C:\Breeze\breeze-agent.exe`, `C:\Breeze\breeze-agent.exe`, true},
		{"different binary", `C:\Breeze\breeze-agent.exe`, `C:\Windows\System32\notepad.exe`, false},
		{"different directory", `C:\Breeze\breeze-agent.exe`, `C:\Temp\breeze-agent.exe`, false},
		{"empty actual", `C:\Breeze\breeze-agent.exe`, ``, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sameWindowsExecutable(tt.configured, tt.actual); got != tt.want {
				t.Fatalf("sameWindowsExecutable(%q, %q)=%v, want %v", tt.configured, tt.actual, got, tt.want)
			}
		})
	}
}

// TestSameWindowsExecutableRejectsEmptyPair: two unknowns are not a match. A
// backend that fails to report either path must never satisfy the identity gate.
func TestSameWindowsExecutableRejectsEmptyPair(t *testing.T) {
	if sameWindowsExecutable("", "") {
		t.Fatal("empty configured and actual paths must not compare equal")
	}
	if sameWindowsExecutable(`  `, `"" `) {
		t.Fatal("whitespace/quote-only paths must not compare equal")
	}
}

func TestRecoverPopulatesElapsedAndPhase(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100},
		serviceSnapshot{State: serviceStopPending, PID: 100},
	)
	controller := newTestWindowsRecoveryController(backend)
	result, err := controller.Recover(1, RecoveryRequest{})
	if err == nil {
		t.Fatal("expected stop timeout")
	}
	if result.Elapsed <= 0 {
		t.Fatalf("elapsed=%v, want the virtual clock delta", result.Elapsed)
	}
	if result.Phase != "wait_stopped" {
		t.Fatalf("phase=%q, want the last reached phase", result.Phase)
	}
}

// SCM can keep reporting the PRE-control state for a short window after a
// control is issued, before the service acknowledges the transition (a
// stopping agent needs ~100-200ms to reach STOP_PENDING). Treating that first
// read as a firm wrong answer made every graceful restart fail in 0-1ms with
// an orphaned stop already in flight — the exact "recovery transition_timeout
// failed during wait_stopped, elapsed_ms:0" seen on every field kill cycle
// (#2763). The wait must absorb a brief acknowledge delay.
func TestGracefulStopToleratesSlowScmAcknowledge(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100}, // initial query
		serviceSnapshot{State: serviceRunning, PID: 100}, // post-Stop: not yet acknowledged
		serviceSnapshot{State: serviceRunning, PID: 100}, // still not acknowledged
		serviceSnapshot{State: serviceStopPending, PID: 100},
		serviceSnapshot{State: serviceStopped},
		serviceSnapshot{State: serviceStopped}, // post-Start: not yet acknowledged
		serviceSnapshot{State: serviceStartPending, PID: 200},
		serviceSnapshot{State: serviceRunning, PID: 200},
	)
	controller := newTestWindowsRecoveryController(backend)
	result, err := controller.Recover(1, RecoveryRequest{StateFilePID: 99})
	if err != nil {
		t.Fatalf("graceful recovery must survive a slow SCM acknowledge, got %v", err)
	}
	if backend.stopCalls != 1 || backend.startCalls != 1 {
		t.Fatalf("stop=%d start=%d, want 1/1", backend.stopCalls, backend.startCalls)
	}
	if result.NewPID != 200 || result.FinalState != string(serviceRunning) {
		t.Fatalf("result=%+v, want NewPID=200 running", result)
	}
}

// The acknowledge grace must not mask a genuinely settled wrong answer: if
// SCM keeps reporting the non-target, non-pending state past the grace
// window, the wait still fails firmly.
func TestWaitForStateStillFailsOnFirmWrongAnswer(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceRunning, PID: 100}, // initial query
		serviceSnapshot{State: serviceRunning, PID: 100}, // repeats forever post-Stop
	)
	controller := newTestWindowsRecoveryController(backend)
	result, err := controller.Recover(1, RecoveryRequest{StateFilePID: 99})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) {
		t.Fatalf("err=%v, want RecoveryError", err)
	}
	if recoveryErr.Class != RecoveryFailureTransitionTimeout {
		t.Fatalf("class=%v, want transition timeout", recoveryErr.Class)
	}
	if backend.startCalls != 0 {
		t.Fatalf("start must never be issued after an unresolved stop, startCalls=%d", backend.startCalls)
	}
	if result.FinalState != string(serviceRunning) {
		t.Fatalf("final state %q, want running (the firm wrong answer)", result.FinalState)
	}
}

// Ensure-start that walks in on an in-flight stop transition must START the
// service once the transition settles to Stopped. The old observe-only
// behavior assumed "the next attempt will issue Start" — but on the
// recovery-exhaustion path (ensure-started-before-failover, #2763) there IS
// no next attempt, and the observed settle left the agent stopped forever.
func TestEnsureStartStartsAfterObservedStopSettles(t *testing.T) {
	backend := newFakeWindowsBackend(
		serviceSnapshot{State: serviceStopPending, PID: 100}, // initial query: stop in flight
		serviceSnapshot{State: serviceStopPending, PID: 100},
		serviceSnapshot{State: serviceStopped}, // transition settles
		serviceSnapshot{State: serviceStopped}, // post-Start: not yet acknowledged
		serviceSnapshot{State: serviceStartPending, PID: 300},
		serviceSnapshot{State: serviceRunning, PID: 300},
	)
	controller := newTestWindowsRecoveryController(backend)
	result, err := controller.Recover(2, RecoveryRequest{Intent: RecoveryIntentEnsureStart})
	if err != nil {
		t.Fatalf("ensure-start after observed settle: %v", err)
	}
	if backend.startCalls != 1 {
		t.Fatalf("startCalls=%d, want 1 — the settle must be followed by a Start", backend.startCalls)
	}
	if backend.stopCalls != 0 {
		t.Fatalf("ensure-start must never stop anything, stopCalls=%d", backend.stopCalls)
	}
	if result.NewPID != 300 || result.FinalState != string(serviceRunning) {
		t.Fatalf("result=%+v, want NewPID=300 running", result)
	}
}

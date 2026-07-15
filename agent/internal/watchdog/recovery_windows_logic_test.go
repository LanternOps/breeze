package watchdog

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

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

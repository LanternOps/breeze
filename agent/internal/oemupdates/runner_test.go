package oemupdates

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/flashguard"
)

const (
	testCommandID   = "8b2f6b8e-3d4a-4c1e-9f00-aabbccddeeff"
	testProtectorID = "4f1c2a9e-1b2c-4d5e-8f90-0123456789ab"
)

type fixedClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fixedClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fixedClock) Set(t time.Time) {
	c.mu.Lock()
	c.t = t
	c.mu.Unlock()
}

type fakePower struct {
	status PowerStatus
	err    error
}

func (p fakePower) Status() (PowerStatus, error) { return p.status, p.err }

type fakeProtectors struct {
	live  LiveProtectors
	err   error
	state string
	reads int
}

func (p *fakeProtectors) Live() (LiveProtectors, error) { p.reads++; return p.live, p.err }
func (p *fakeProtectors) State() string                 { return p.state }

type fakeSystem struct {
	bios string
	boot time.Time
}

func (s *fakeSystem) BiosVersion() (string, error) { return s.bios, nil }
func (s *fakeSystem) BootTime() (time.Time, error) { return s.boot, nil }

var desktopOnAC = PowerStatus{ACLineStatus: 1, BatteryFlag: 128, BatteryLifePercent: 255}

type runFixture struct {
	lane   *fakeLane
	ver    *fakeVerifier
	exec   *fakeExec
	store  *memStore
	clock  *fixedClock
	prot   *fakeProtectors
	sys    *fakeSystem
	guard  *flashguard.Guard
	deps   Deps
	req    RunRequest
	stages []string
}

func newRunFixture(t *testing.T) *runFixture {
	t.Helper()
	l := newFakeLane()
	l.setTool(ToolState{Present: true, Path: dcuPath, Version: "5.7.2"})
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// Today, not a fixed date: the run's context deadline runs on the real clock
	// and is measured from this one, so a date in the past starts every run
	// with its context already expired.
	now := time.Now().UTC().Truncate(time.Second)
	f := &runFixture{
		lane:  l,
		ver:   &fakeVerifier{publisher: "Dell Inc"},
		exec:  &fakeExec{},
		store: newMemStore(),
		clock: &fixedClock{t: now},
		prot:  &fakeProtectors{live: LiveProtectors{BitLockerOn: true, RecoveryPasswordIDs: []string{"{" + testProtectorID + "}"}}, state: BitLockerOn},
		sys:   &fakeSystem{bios: "1.20.0"},
		guard: flashguard.New(filepath.Join(base, "guard")),
	}
	f.deps = Deps{
		Exec: f.exec, Verifier: f.ver, Fetcher: &fakeFetcher{}, Power: fakePower{status: desktopOnAC},
		Protectors: f.prot, System: f.sys, Clock: f.clock, Store: f.store, Guard: f.guard,
		Preflight: func() error { return nil },
		Elevated:  func() bool { return true },
		Progress:  func(s string) { f.stages = append(f.stages, s) },
	}
	f.req = RunRequest{
		CommandID: testCommandID, Lane: LaneDell, Trigger: TriggerOnDemand,
		Categories: []string{CategoryDriver, CategoryBIOS}, BlockedUpdateIDs: []string{},
		RebootControlled: true, NotAfter: now.Add(4 * time.Hour),
		EscrowedProtectorIDs: []string{testProtectorID},
	}
	return f
}

func (f *runFixture) run() RunResult {
	return Run(context.Background(), f.req, f.lane, f.deps)
}

func errCode(r RunResult) string {
	if r.ErrorCode == nil {
		return ""
	}
	return *r.ErrorCode
}

func skipped(r RunResult, cat string) string {
	for _, s := range r.SkippedCategories {
		if s.Category == cat {
			return s.Reason
		}
	}
	return ""
}

func TestRunHappyPath(t *testing.T) {
	f := newRunFixture(t)
	r := f.run()
	if r.Outcome != OutcomeSuccess || r.Lane != LaneDell || r.ToolVersion == nil || *r.ToolVersion != "5.7.2" {
		t.Fatalf("result = %+v", r)
	}
	if err := r.Validate(); err != nil {
		t.Fatalf("result violates the contract: %v", err)
	}
	m, err := ReadMarker(f.store)
	if err != nil || m.EndedAt == nil || m.Outcome != OutcomeSuccess || !m.FlashStarted {
		t.Fatalf("marker after a bios run = %+v, %v", m, err)
	}
	pending, err := readPendingVerifications(f.store)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending = %+v, %v", pending, err)
	}
	if p := pending[0]; p.CommandID != testCommandID || p.BiosVersionBefore != "1.20.0" || !p.VerifyAfter.Equal(*m.EndedAt) {
		t.Fatalf("pending = %+v; verification must wait for a boot after the install ended", p)
	}
	want := []string{StageVerifying, StageInstalling, StageReporting}
	if len(f.stages) != len(want) {
		t.Fatalf("stages = %v, want %v", f.stages, want)
	}
	for i := range want {
		if f.stages[i] != want[i] {
			t.Fatalf("stages = %v, want %v", f.stages, want)
		}
	}
}

func TestRefusesWhenNotElevated(t *testing.T) {
	f := newRunFixture(t)
	f.deps.Elevated = func() bool { return false }
	r := f.run()
	if r.Outcome != OutcomeFailed || errCode(r) != "not_elevated" || len(f.exec.Calls()) != 0 {
		t.Fatalf("result = %+v", r)
	}
	if _, err := ReadMarker(f.store); err == nil {
		t.Fatal("a refused run wrote a marker")
	}
}

// Review Focus 4: a fast device clock refuses, the safe direction.
func TestRefusesAfterNotAfterWithRetryLater(t *testing.T) {
	f := newRunFixture(t)
	f.clock.Set(f.req.NotAfter.Add(-4 * time.Hour).Add(6 * time.Hour))
	r := f.run()
	if r.Outcome != OutcomeRetryLater || errCode(r) != "not_after_passed" {
		t.Fatalf("result = %+v", r)
	}
	if len(f.exec.Calls()) != 0 || len(f.lane.Applied()) != 0 {
		t.Fatal("ran after notAfter")
	}
	// Refused at the door, before the lock, the marker or any tool check.
	if _, err := ReadMarker(f.store); err == nil {
		t.Fatal("a run refused for notAfter wrote a marker")
	}
	if got := len(f.ver.Verified()); got != 0 {
		t.Fatalf("verified the tool %d times before refusing", got)
	}
}

func TestRunInFlightIsRetryLater(t *testing.T) {
	f := newRunFixture(t)
	release, err := AcquireRunLock(f.store)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if r := f.run(); r.Outcome != OutcomeRetryLater || errCode(r) != "run_in_flight" {
		t.Fatalf("result = %+v", r)
	}
}

func TestMarkerUnwritableFailsClosed(t *testing.T) {
	f := newRunFixture(t)
	f.store.failWrite = errors.New("disk full")
	r := f.run()
	if r.Outcome != OutcomeFailed || errCode(r) != "marker_unwritable" || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
}

func TestPreflightFailureIsRetryLater(t *testing.T) {
	f := newRunFixture(t)
	f.deps.Preflight = func() error { return errors.New("insufficient disk space") }
	if r := f.run(); r.Outcome != OutcomeRetryLater || errCode(r) != "preflight_failed" {
		t.Fatalf("result = %+v", r)
	}
}

func TestSignatureCheckedOnEveryRunNotCached(t *testing.T) {
	f := newRunFixture(t)
	f.run()
	f.run()
	if got := len(f.ver.Verified()); got != 2 {
		t.Fatalf("verified %d times over two runs, want 2", got)
	}
	if got := f.lane.detects.Load(); got != 1 {
		t.Fatalf("detect ran %d times, want 1: the gate stays cached", got)
	}
}

func TestWrongPublisherOnInstalledToolNeverRuns(t *testing.T) {
	f := newRunFixture(t)
	f.ver.publisher = "Dell Inc."
	r := f.run()
	if r.Outcome != OutcomeToolUnavailable || errCode(r) != "publisher_mismatch" || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
}

func TestBiosSkippedWhenRebootNotControlled(t *testing.T) {
	f := newRunFixture(t)
	f.req.RebootControlled = false
	r := f.run()
	if skipped(r, CategoryBIOS) != SkipNoRebootControl {
		t.Fatalf("skipped = %+v", r.SkippedCategories)
	}
	applied := f.lane.Applied()
	if len(applied) != 1 || len(applied[0].Categories) != 1 || applied[0].Categories[0] != CategoryDriver {
		t.Fatalf("applied = %+v, want drivers only", applied)
	}
	if r.Outcome != OutcomeSuccess {
		t.Fatalf("outcome = %s", r.Outcome)
	}
}

func TestBiosSkippedOnLowBattery(t *testing.T) {
	f := newRunFixture(t)
	f.deps.Power = fakePower{status: PowerStatus{ACLineStatus: 1, BatteryFlag: 2, BatteryLifePercent: 10}}
	r := f.run()
	if skipped(r, CategoryBIOS) != SkipPower {
		t.Fatalf("skipped = %+v", r.SkippedCategories)
	}
	if applied := f.lane.Applied(); len(applied) != 1 || applied[0].HasFlash() {
		t.Fatalf("applied = %+v", applied)
	}
}

func TestPowerReadErrorSkipsFlash(t *testing.T) {
	f := newRunFixture(t)
	f.deps.Power = fakePower{err: errors.New("no reading")}
	if r := f.run(); skipped(r, CategoryBIOS) != SkipPower {
		t.Fatalf("skipped = %+v", r.SkippedCategories)
	}
}

func TestAllSkippedForPowerIsBlockedOnBattery(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryBIOS, CategoryFirmware}
	f.deps.Power = fakePower{status: PowerStatus{ACLineStatus: 0, BatteryFlag: 1, BatteryLifePercent: 90}}
	r := f.run()
	if r.Outcome != OutcomeBlockedOnBattery || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
}

func TestAllSkippedForKeyIsBlockedNoRecoveryKey(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryBIOS, CategoryFirmware}
	f.req.EscrowedProtectorIDs = []string{"aaaaaaaa-1b2c-4d5e-8f90-0123456789ab"}
	r := f.run()
	if r.Outcome != OutcomeBlockedNoRecoveryKey || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
	if skipped(r, CategoryBIOS) != SkipNoRecoveryKey || skipped(r, CategoryFirmware) != SkipNoRecoveryKey {
		t.Fatalf("skipped = %+v", r.SkippedCategories)
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestProtectorReadErrorSkipsFlash(t *testing.T) {
	f := newRunFixture(t)
	f.prot.err = errors.New("powershell timed out")
	if r := f.run(); skipped(r, CategoryBIOS) != SkipNoRecoveryKey {
		t.Fatalf("skipped = %+v", r.SkippedCategories)
	}
}

func TestBitLockerOffNeedsNoKey(t *testing.T) {
	f := newRunFixture(t)
	f.prot.live = LiveProtectors{BitLockerOn: false}
	f.req.EscrowedProtectorIDs = []string{}
	r := f.run()
	if len(r.SkippedCategories) != 0 || r.Outcome != OutcomeSuccess {
		t.Fatalf("result = %+v", r)
	}
}

func TestProtectorsReadOnlyWhenFlashRemains(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryDriver}
	f.run()
	if f.prot.reads != 0 {
		t.Fatal("a driver-only run read BitLocker")
	}
}

func TestAllSkippedForRebootControlIsFailed(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryBIOS}
	f.req.RebootControlled = false
	r := f.run()
	if r.Outcome != OutcomeFailed || errCode(r) != "all_categories_skipped" || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
}

func TestGuardHeldOnlyWhileBiosOrFirmwareRuns(t *testing.T) {
	for _, tc := range []struct {
		name   string
		cats   []string
		wantOn bool
	}{
		{"bios", []string{CategoryDriver, CategoryBIOS}, true},
		{"firmware", []string{CategoryFirmware}, true},
		{"driver only", []string{CategoryDriver, CategoryApplication}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRunFixture(t)
			f.req.Categories = tc.cats
			var during bool
			f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
				_, during = f.guard.Active()
				return RunResult{Lane: LaneDell, Outcome: OutcomeSuccess}, nil
			}
			if _, active := f.guard.Active(); active {
				t.Fatal("section open before the run")
			}
			f.run()
			if during != tc.wantOn {
				t.Fatalf("section active during apply = %v, want %v", during, tc.wantOn)
			}
			if _, active := f.guard.Active(); active {
				t.Fatal("section still open after the run")
			}
		})
	}
}

func TestGuardRefusedIsBlockedRebootPending(t *testing.T) {
	f := newRunFixture(t)
	done, err := f.guard.AdmitPowerAction("test reboot")
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	r := f.run()
	if r.Outcome != OutcomeBlockedRebootPending || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
}

func TestNoGuardRefusesFlash(t *testing.T) {
	f := newRunFixture(t)
	f.deps.Guard = nil
	r := f.run()
	if r.Outcome != OutcomeFailed || errCode(r) != "flash_guard_unavailable" || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
}

func withRunDeadline(t *testing.T, d time.Duration) {
	t.Helper()
	prev := runDeadline
	runDeadline = d
	t.Cleanup(func() { runDeadline = prev })
}

// newOverdueRunFixture is a run whose context deadline has already passed on the
// real clock, which contexts run on, while the run's own clock, which recheck and
// the result mapping read, is still before it. The tool always starts, however
// long a loaded machine takes to reach it, and starts with the deadline in force.
// passDeadline moves the run's clock to the deadline: an Apply that overran.
func newOverdueRunFixture(t *testing.T) (f *runFixture, passDeadline func()) {
	t.Helper()
	withRunDeadline(t, time.Minute)
	f = newRunFixture(t)
	start := time.Now().Add(-time.Hour)
	f.clock.Set(start)
	f.req.NotAfter = start.Add(4 * time.Hour)
	return f, func() { f.clock.Set(start.Add(time.Minute)) }
}

// Review Focus 5: at the deadline a driver-only run is killed and fails.
func TestDriverOnlyRunKilledAtDeadline(t *testing.T) {
	f, _ := newOverdueRunFixture(t)
	f.req.Categories = []string{CategoryDriver}
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		if err := ctx.Err(); err != nil {
			return RunResult{Lane: LaneDell}, err
		}
		return RunResult{Lane: LaneDell, Outcome: OutcomeSuccess}, nil
	}
	r := f.run()
	if r.Outcome != OutcomeFailed || errCode(r) != "deadline_exceeded" {
		t.Fatalf("result = %+v", r)
	}
	if len(f.lane.Applied()) != 1 {
		t.Fatal("refused before the tool started; the deadline never reached the tool")
	}
}

// Review Focus 5: while the flash guard is held the process is never killed.
// When it ends late, what the tool reported stands (a reboot it needs must
// still be scheduled) and the overrun is named in errorCode.
func TestFlashNotKilledAtDeadline(t *testing.T) {
	f, passDeadline := newOverdueRunFixture(t)
	f.req.Categories = []string{CategoryBIOS}
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		if err := ctx.Err(); err != nil {
			return RunResult{Lane: LaneDell}, err
		}
		passDeadline()
		return RunResult{Lane: LaneDell, Outcome: OutcomeSuccessRebootRequired, RebootRequired: true, RawExitCode: int64Ptr(1)}, nil
	}
	r := f.run()
	if r.Outcome != OutcomeSuccessRebootRequired || errCode(r) != "flash_overran_deadline" {
		t.Fatalf("result = %+v", r)
	}
	if !r.RebootRequired || r.RawExitCode == nil || *r.RawExitCode != 1 {
		t.Fatal("an overrun flash must keep what the tool reported")
	}
}

func TestFlashOverrunWithNoToolResultIsInterrupted(t *testing.T) {
	f, passDeadline := newOverdueRunFixture(t)
	f.req.Categories = []string{CategoryBIOS}
	var held bool
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		_, held = f.guard.Active()
		passDeadline()
		return RunResult{Lane: LaneDell}, errors.New("tool vanished")
	}
	if r := f.run(); r.Outcome != OutcomeInterrupted || errCode(r) != "flash_overran_deadline" {
		t.Fatalf("result = %+v", r)
	}
	if !held {
		t.Fatal("the overrun was not under the flash guard")
	}
}

// The other side of the overrun: a deadline that passes before the flash guard
// is entered stops the run. Nothing irreversible began, so it is refused, not
// interrupted, and no tool starts and no verification is owed.
func TestDeadlinePassedBeforeTheInstallIsRefused(t *testing.T) {
	f, passDeadline := newOverdueRunFixture(t)
	f.req.Categories = []string{CategoryBIOS}
	f.lane.filter = func(cats, blocked []string) (FilterPlan, error) {
		passDeadline()
		return FilterPlan{Categories: cats, BlockedIDs: blocked}, nil
	}
	if r := f.run(); r.Outcome != OutcomeFailed || errCode(r) != "deadline_exceeded" {
		t.Fatalf("result = %+v", r)
	}
	if len(f.lane.Applied()) != 0 {
		t.Fatal("a tool started past the run deadline")
	}
	m, err := ReadMarker(f.store)
	if err != nil || m.FlashStarted {
		t.Fatalf("marker = %+v, %v; the flash guard must not be entered past the deadline", m, err)
	}
	if p, _ := readPendingVerifications(f.store); len(p) != 0 {
		t.Fatalf("pending = %+v; nothing ran, so nothing is owed", p)
	}
}

func TestFlashNotKilledWhenAgentStops(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryBIOS}
	ctx, cancel := context.WithCancel(context.Background())
	f.lane.apply = func(actx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		cancel()
		select {
		case <-actx.Done():
			return RunResult{Lane: LaneDell}, actx.Err()
		case <-time.After(100 * time.Millisecond):
			return RunResult{Lane: LaneDell, Outcome: OutcomeSuccess}, nil
		}
	}
	r := Run(ctx, f.req, f.lane, f.deps)
	if r.Outcome != OutcomeSuccess {
		t.Fatalf("a flash saw the agent's cancellation: %+v", r)
	}
}

func TestDriverRunStoppedByAgentIsInterrupted(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryDriver}
	ctx, cancel := context.WithCancel(context.Background())
	f.lane.apply = func(actx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		cancel()
		<-actx.Done()
		return RunResult{Lane: LaneDell}, actx.Err()
	}
	if r := Run(ctx, f.req, f.lane, f.deps); r.Outcome != OutcomeInterrupted || errCode(r) != "agent_stopping" {
		t.Fatalf("result = %+v", r)
	}
}

func TestLaneItemsAreSanitizedAndCapped(t *testing.T) {
	f := newRunFixture(t)
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		items := make([]Item, 250)
		for i := range items {
			items[i] = Item{Title: "Driver\x1b[0m\n", Category: CategoryDriver, Version: "1.0\t", Result: ItemInstalled}
		}
		return RunResult{Lane: LaneDell, Outcome: OutcomeSuccess, Items: items}, nil
	}
	r := f.run()
	if len(r.Items) != maxItems || r.Items[0].Title != "Driver[0m" || r.Items[0].Version != "1.0" {
		t.Fatalf("items = %d, first %+v", len(r.Items), r.Items[0])
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidLaneResultBecomesFailed(t *testing.T) {
	f := newRunFixture(t)
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		return RunResult{Lane: LaneDell, Outcome: "great"}, nil
	}
	r := f.run()
	if r.Outcome != OutcomeFailed || errCode(r) != "result_invalid" {
		t.Fatalf("result = %+v", r)
	}
}

func TestRestartAfterMarkerReportsInterrupted(t *testing.T) {
	f := newRunFixture(t)
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		// The agent "dies" here: the marker is read as a fresh process would.
		m, ok := ReadInterruptedMarker(f.store)
		if !ok || m.CommandID != testCommandID || !m.FlashStarted || m.Stage != StageInstalling {
			t.Errorf("mid-run marker = %+v ok=%v", m, ok)
		}
		if r := m.InterruptedResult(); r.Outcome != OutcomeInterrupted || r.Validate() != nil {
			t.Errorf("interrupted result = %+v", r)
		}
		return RunResult{Lane: LaneDell, Outcome: OutcomeSuccess}, nil
	}
	f.run()
}

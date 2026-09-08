package winsvcinstall

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// fastTimeouts opts out of DefaultTimeouts without being the zero struct.
// Poll 0 keeps the waits from sleeping; Settle 0 makes a STOPPED reading after
// a start request immediately conclusive.
func fastTimeouts() Timeouts {
	return Timeouts{Stop: time.Second, Start: time.Second, Poll: 0, Settle: 0}
}

type fakeService struct {
	rec *[]string

	// beforeStart is consumed one entry per Status() call until RequestStart is
	// accepted; the last entry repeats. afterStart takes over from then on.
	beforeStart []Status
	afterStart  []Status
	started     bool
	idx         int

	statusErr error
	stopErr   error
	reconfErr error
	recovErr  error
	startErr  error

	gotSpec    Spec
	gotExePath string
	closed     bool
}

func (f *fakeService) log(op string) { *f.rec = append(*f.rec, op) }

func (f *fakeService) Status() (Status, error) {
	f.log("status")
	if f.statusErr != nil {
		return Status{}, f.statusErr
	}
	queue := f.beforeStart
	if f.started {
		queue = f.afterStart
	}
	if len(queue) == 0 {
		return Status{State: StateStopped}, nil
	}
	i := f.idx
	if i >= len(queue) {
		i = len(queue) - 1
	}
	f.idx++
	return queue[i], nil
}

func (f *fakeService) RequestStop() error {
	f.log("stop")
	return f.stopErr
}

func (f *fakeService) Reconfigure(spec Spec, exePath string) error {
	f.log("reconfigure")
	f.gotSpec, f.gotExePath = spec, exePath
	return f.reconfErr
}

func (f *fakeService) SetRecoveryActions() error {
	f.log("recovery")
	return f.recovErr
}

func (f *fakeService) RequestStart() error {
	f.log("start")
	if f.startErr != nil {
		return f.startErr
	}
	f.started, f.idx = true, 0
	return nil
}

func (f *fakeService) Close() error {
	f.closed = true
	return nil
}

type fakeManager struct {
	rec []string
	// existing is the service Open returns; nil means ErrNotInstalled.
	existing  *fakeService
	created   *fakeService
	openErr   error
	createErr error
}

func (m *fakeManager) Open(name string) (Service, error) {
	m.rec = append(m.rec, "open")
	if m.openErr != nil {
		return nil, m.openErr
	}
	if m.existing == nil {
		return nil, ErrNotInstalled
	}
	m.existing.rec = &m.rec
	return m.existing, nil
}

func (m *fakeManager) Create(spec Spec, exePath string) (Service, error) {
	m.rec = append(m.rec, "create")
	if m.createErr != nil {
		return nil, m.createErr
	}
	if m.created == nil {
		m.created = &fakeService{}
	}
	m.created.rec = &m.rec
	m.created.gotSpec, m.created.gotExePath = spec, exePath
	return m.created, nil
}

func (m *fakeManager) Close() error { return nil }

const testExePath = `C:\Program Files\Breeze\breeze-agent.exe`

func testSpec() Spec {
	return Spec{
		Name:        "BreezeAgent",
		DisplayName: "Breeze RMM Agent",
		Description: "Breeze Remote Monitoring and Management Agent",
		Args:        []string{"run"},
	}
}

func newRequest(m *fakeManager, decide func(bool) StartDecision) Request {
	return Request{
		Spec: testSpec(),
		Stage: func() (string, error) {
			m.rec = append(m.rec, "stage")
			return testExePath, nil
		},
		Decide:   decide,
		Timeouts: fastTimeouts(),
	}
}

func seq(rec []string) string { return strings.Join(rec, " | ") }

// The headline regression for #5299: an existing, RUNNING service is sampled
// before it is stopped, the binary is staged only after the stop, and the
// service is started again at the end.
func TestInstallExistingRunningServiceSamplesStopsRestagesAndStarts(t *testing.T) {
	m := &fakeManager{existing: &fakeService{
		beforeStart: []Status{{State: StateRunning}, {State: StateStopped}},
		afterStart:  []Status{{State: StateRunning}},
	}}

	out, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(false)))
	if err != nil {
		t.Fatalf("Install: %v", err)
	}

	want := "open | status | stop | status | stage | reconfigure | recovery | start | status"
	if got := seq(m.rec); got != want {
		t.Fatalf("call sequence =\n  %q\nwant\n  %q", got, want)
	}
	if !out.Existed || !out.WasRunning || !out.Installed || !out.Started {
		t.Fatalf("outcome = %+v, want Existed/WasRunning/Installed/Started all true", out)
	}
	if out.StartReason != "it was running before this install" {
		t.Errorf("StartReason = %q", out.StartReason)
	}
	if m.existing.gotExePath != testExePath {
		t.Errorf("reconfigured to %q, want %q", m.existing.gotExePath, testExePath)
	}
	if m.existing.gotSpec.Name != "BreezeAgent" {
		t.Errorf("reconfigured spec = %+v", m.existing.gotSpec)
	}
}

// The state sample must precede our own stop. Reading it afterwards can only
// ever answer "not running", which is the inverted check that shipped #5252.
func TestInstallSamplesStateBeforeItsOwnStop(t *testing.T) {
	m := &fakeManager{existing: &fakeService{
		beforeStart: []Status{{State: StateRunning}, {State: StateStopped}},
		afterStart:  []Status{{State: StateRunning}},
	}}
	if _, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(false))); err != nil {
		t.Fatalf("Install: %v", err)
	}
	firstStatus, firstStop := indexOf(m.rec, "status"), indexOf(m.rec, "stop")
	if firstStatus < 0 || firstStop < 0 || firstStatus > firstStop {
		t.Fatalf("state was not sampled before the stop: %s", seq(m.rec))
	}
}

// Windows holds an exclusive lock on the image of a running service, so the
// binary can only be staged once the service is confirmed STOPPED.
func TestInstallStagesBinaryOnlyAfterTheServiceStopped(t *testing.T) {
	m := &fakeManager{existing: &fakeService{
		beforeStart: []Status{{State: StateRunning}, {State: StateStopped}},
		afterStart:  []Status{{State: StateRunning}},
	}}
	if _, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(false))); err != nil {
		t.Fatalf("Install: %v", err)
	}
	stop, stage := indexOf(m.rec, "stop"), indexOf(m.rec, "stage")
	if stop < 0 || stage < 0 {
		t.Fatalf("expected both a stop and a stage in the sequence, got: %s", seq(m.rec))
	}
	if stop > stage {
		t.Fatalf("binary staged before the stop: %s", seq(m.rec))
	}
}

// A stop that never completes must abort the install loudly rather than fall
// through to a binary copy that would fail with an unrelated file-lock error.
func TestInstallFailsWhenTheServiceNeverStops(t *testing.T) {
	m := &fakeManager{existing: &fakeService{
		beforeStart: []Status{{State: StateRunning}},
	}}
	req := newRequest(m, StartWhenRunningOrEnrolled(true))
	req.Timeouts = Timeouts{Stop: 0, Start: time.Second, Poll: 0, Settle: 0}

	out, err := Install(m, req)
	if err == nil {
		t.Fatal("Install returned nil error after the stop timed out")
	}
	if out.Installed {
		t.Errorf("outcome claims Installed after a failed stop: %+v", out)
	}
	if strings.Contains(seq(m.rec), "stage") {
		t.Errorf("staged the binary despite the stop failing: %s", seq(m.rec))
	}
}

// An enrolled host whose service happened to be down still wants it back: the
// agent is that host's only management path.
func TestInstallExistingStoppedServiceStartsWhenEnrolled(t *testing.T) {
	m := &fakeManager{existing: &fakeService{
		beforeStart: []Status{{State: StateStopped}},
		afterStart:  []Status{{State: StateRunning}},
	}}
	out, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(true)))
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if strings.Contains(seq(m.rec), "stop") {
		t.Errorf("stopped an already-stopped service: %s", seq(m.rec))
	}
	if !out.Started {
		t.Fatalf("outcome = %+v, want Started", out)
	}
	if out.StartReason != "this host is already enrolled" {
		t.Errorf("StartReason = %q", out.StartReason)
	}
}

// A fresh, un-enrolled host is deliberately left stopped — there is nothing for
// the agent to talk to a server about yet.
func TestInstallFreshUnenrolledHostIsLeftStopped(t *testing.T) {
	m := &fakeManager{}
	out, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(false)))
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	want := "open | stage | create | recovery"
	if got := seq(m.rec); got != want {
		t.Fatalf("call sequence =\n  %q\nwant\n  %q", got, want)
	}
	if out.Existed || out.Started {
		t.Fatalf("outcome = %+v, want a fresh install left stopped", out)
	}
	if !out.Installed {
		t.Errorf("outcome = %+v, want Installed", out)
	}
	if out.StartReason != "this host is not enrolled yet" {
		t.Errorf("StartReason = %q", out.StartReason)
	}
}

func TestInstallFreshEnrolledHostStarts(t *testing.T) {
	m := &fakeManager{created: &fakeService{afterStart: []Status{{State: StateRunning}}}}
	out, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(true)))
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !out.Started {
		t.Fatalf("outcome = %+v, want Started", out)
	}
	if m.created.gotExePath != testExePath {
		t.Errorf("created against %q, want %q", m.created.gotExePath, testExePath)
	}
}

// The watchdog rule: always end running, even on a fresh un-enrolled host.
func TestAlwaysStartStartsAFreshUnenrolledInstall(t *testing.T) {
	m := &fakeManager{created: &fakeService{afterStart: []Status{{State: StateRunning}}}}
	out, err := Install(m, newRequest(m, AlwaysStart()))
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !out.Started {
		t.Fatalf("outcome = %+v, want Started", out)
	}
}

// A start that the SCM refuses is a non-zero exit, not a silent success — that
// silence is how the Linux half of this bug went unnoticed until devices showed
// Offline. Installed stays true so the caller can still bootstrap the watchdog
// before surfacing the failure.
func TestInstallFailsWhenTheStartRequestIsRefused(t *testing.T) {
	m := &fakeManager{created: &fakeService{startErr: errors.New("access is denied")}}
	out, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(true)))
	if err == nil {
		t.Fatal("Install returned nil error after the start was refused")
	}
	if !strings.Contains(err.Error(), "access is denied") {
		t.Errorf("error does not carry the cause: %v", err)
	}
	if out.Started {
		t.Errorf("outcome claims Started: %+v", out)
	}
	if !out.Installed {
		t.Errorf("outcome = %+v, want Installed true so the caller can still install the watchdog", out)
	}
}

// StartService is asynchronous: "accepted" is not "running". A service that
// starts and dies must not be reported as installed and running.
func TestInstallFailsWhenTheServiceDiesImmediatelyAfterStarting(t *testing.T) {
	m := &fakeManager{created: &fakeService{
		afterStart: []Status{{State: StateStopped, Win32ExitCode: 1067}},
	}}
	_, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(true)))
	if err == nil {
		t.Fatal("Install returned nil error for a service that stopped right after starting")
	}
	if !strings.Contains(err.Error(), "1067") {
		t.Errorf("error does not report the exit code: %v", err)
	}
}

// A START_PENDING reading is not yet a success; Started must only be reported
// once the service is confirmed RUNNING.
func TestInstallWaitsThroughStartPendingBeforeReportingStarted(t *testing.T) {
	m := &fakeManager{created: &fakeService{
		afterStart: []Status{{State: StateStartPending}, {State: StateStartPending}, {State: StateRunning}},
	}}
	out, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(true)))
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !out.Started {
		t.Fatalf("outcome = %+v, want Started", out)
	}
	if n := countOf(m.rec, "status"); n != 3 {
		t.Errorf("polled Status %d times, want 3 (two START_PENDING then RUNNING)", n)
	}
}

// A service that never leaves START_PENDING must time out rather than hang or
// be reported as running.
func TestInstallTimesOutWaitingForRunning(t *testing.T) {
	m := &fakeManager{created: &fakeService{
		afterStart: []Status{{State: StateStartPending}},
	}}
	req := newRequest(m, StartWhenRunningOrEnrolled(true))
	req.Timeouts = Timeouts{Stop: time.Second, Start: 0, Poll: 0, Settle: time.Minute}

	out, err := Install(m, req)
	if err == nil {
		t.Fatal("Install returned nil error for a service stuck in START_PENDING")
	}
	if !strings.Contains(err.Error(), "START_PENDING") {
		t.Errorf("error does not report the last state: %v", err)
	}
	if out.Started {
		t.Errorf("outcome claims Started: %+v", out)
	}
}

// An Open failure that is not "not installed" must not be silently treated as a
// fresh install — that would create a second registration or mask an SCM
// permission problem.
func TestInstallPropagatesUnexpectedOpenErrors(t *testing.T) {
	m := &fakeManager{openErr: errors.New("access is denied")}
	if _, err := Install(m, newRequest(m, StartWhenRunningOrEnrolled(true))); err == nil {
		t.Fatal("Install swallowed an unexpected Open error")
	}
	if strings.Contains(seq(m.rec), "create") {
		t.Errorf("created a service after an unexpected Open error: %s", seq(m.rec))
	}
}

// Recovery actions are best-effort: a service that runs without a restart
// ladder is strictly better than an aborted install.
func TestInstallTreatsRecoveryActionFailureAsAWarning(t *testing.T) {
	m := &fakeManager{created: &fakeService{
		recovErr:   errors.New("no permission"),
		afterStart: []Status{{State: StateRunning}},
	}}
	warn := &strings.Builder{}
	req := newRequest(m, StartWhenRunningOrEnrolled(true))
	req.Warn = warn

	out, err := Install(m, req)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !out.Started {
		t.Fatalf("outcome = %+v, want Started", out)
	}
	if !strings.Contains(warn.String(), "recovery actions") {
		t.Errorf("recovery failure was not warned about: %q", warn.String())
	}
}

func TestStartWhenRunningOrEnrolled(t *testing.T) {
	cases := []struct {
		wasRunning, enrolled, wantStart bool
	}{
		{wasRunning: true, enrolled: true, wantStart: true},
		{wasRunning: true, enrolled: false, wantStart: true},
		{wasRunning: false, enrolled: true, wantStart: true},
		{wasRunning: false, enrolled: false, wantStart: false},
	}
	for _, c := range cases {
		got := StartWhenRunningOrEnrolled(c.enrolled)(c.wasRunning)
		if got.Start != c.wantStart {
			t.Errorf("wasRunning=%v enrolled=%v: Start=%v want %v", c.wasRunning, c.enrolled, got.Start, c.wantStart)
		}
		if got.Reason == "" {
			t.Errorf("wasRunning=%v enrolled=%v: empty reason", c.wasRunning, c.enrolled)
		}
	}
}

func TestAlwaysStartIsUnconditional(t *testing.T) {
	for _, wasRunning := range []bool{true, false} {
		if d := AlwaysStart()(wasRunning); !d.Start || d.Reason == "" {
			t.Errorf("AlwaysStart()(%v) = %+v", wasRunning, d)
		}
	}
}

func indexOf(rec []string, op string) int {
	for i, v := range rec {
		if v == op {
			return i
		}
	}
	return -1
}

func countOf(rec []string, op string) int {
	n := 0
	for _, v := range rec {
		if v == op {
			n++
		}
	}
	return n
}

// The message this whole issue is named after: "installed and running" was
// printed unconditionally. Summary must claim "is running" only when the
// service was actually observed RUNNING.
func TestSummaryClaimsRunningOnlyWhenStarted(t *testing.T) {
	cases := []Outcome{
		{Installed: true},
		{Installed: true, Existed: true},
		{Installed: true, StartReason: "this host is not enrolled yet"},
		{Installed: true, Existed: true, WasRunning: true, StartAttempted: true},
		{Installed: true, StartAttempted: true, Started: true},
		{Installed: true, Existed: true, StartAttempted: true, Started: true},
	}
	for _, o := range cases {
		got := o.Summary("BreezeAgent")
		if strings.Contains(got, "is running") != o.Started {
			t.Errorf("Summary(%+v) = %q; claims running=%v want %v",
				o, got, strings.Contains(got, "is running"), o.Started)
		}
		if !strings.Contains(got, "BreezeAgent") {
			t.Errorf("Summary(%+v) = %q, does not name the service", o, got)
		}
		if o.Existed && !strings.Contains(got, "upgraded") {
			t.Errorf("Summary(%+v) = %q, does not say upgraded", o, got)
		}
	}
}

// A start that was attempted and failed must not be reported with the
// "we deliberately left it stopped" wording.
func TestSummaryDistinguishesAFailedStartFromADeliberateOne(t *testing.T) {
	failed := Outcome{Installed: true, Existed: true, WasRunning: true, StartAttempted: true}.Summary("BreezeAgent")
	if !strings.Contains(failed, "FAILED TO START") {
		t.Errorf("failed-start summary = %q", failed)
	}
	deliberate := Outcome{Installed: true, StartReason: "this host is not enrolled yet"}.Summary("BreezeAgent")
	if !strings.Contains(deliberate, "not enrolled yet") {
		t.Errorf("deliberate-stop summary = %q", deliberate)
	}
	if strings.Contains(deliberate, "FAILED") {
		t.Errorf("deliberate-stop summary alarms the operator: %q", deliberate)
	}
}

package main

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/watchdog"
)

// fakeProcesses is a ProcessChecker over a fixed set of live PIDs.
type fakeProcesses map[int]bool

func (f fakeProcesses) IsAlive(pid int) bool { return f[pid] }
func (fakeProcesses) IsZombie(int) bool      { return false }

// fakeService returns a scripted service-manager answer and counts queries.
type fakeService struct {
	status  watchdog.AgentServiceStatus
	queries int
}

func (f *fakeService) query() watchdog.AgentServiceStatus {
	f.queries++
	return f.status
}

func newBootTestJournal(t *testing.T) *watchdog.Journal {
	t.Helper()
	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	return journal
}

func journalHas(j *watchdog.Journal, event string) bool {
	for _, e := range j.Recent(1000) {
		if e.Event == event {
			return true
		}
	}
	return false
}

// everRecovering reports whether the watchdog ever entered RECOVERING, the
// only state from which a recovery attempt (and a 24h budget charge) is made.
func everRecovering(wd *watchdog.Watchdog) bool {
	for _, r := range wd.StateHistory() {
		if r.State == watchdog.StateRecovering {
			return true
		}
	}
	return false
}

const bootTestDeadline = 2 * time.Minute

// #12291, the field trace: agent.state names the previous boot's agent (5824,
// gone) and SCM runs the new agent as 3412. Startup, the first process ticks
// (by which time the agent has rewritten agent.state) and the IPC reconnect
// must take the watchdog to MONITORING without ever entering RECOVERING.
func TestBootCheck_StalePIDHealthyServiceNeverRecovers(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceRunning, PID: 3412}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{3412: true})

	if skip := b.evaluate(t0, 5824, false, wd, journal); !skip {
		t.Fatal("startup: the stale-PID process check was not suppressed")
	}
	// Process ticks: first still the stale PID, then the refreshed one.
	b.evaluate(t0.Add(5*time.Second), 5824, false, wd, journal)
	b.evaluate(t0.Add(10*time.Second), 3412, false, wd, journal)
	if wd.State() != watchdog.StateConnecting {
		t.Fatalf("state = %s during the hold, want CONNECTING", wd.State())
	}
	if !b.active(wd) {
		t.Fatal("boot check ended before IPC connected")
	}

	// The IPC ticker's reconnect is what ends the hold.
	wd.HandleEvent(watchdog.EventIPCConnected)
	if b.active(wd) {
		t.Fatal("boot check still active after IPC connected")
	}
	if skip := b.evaluate(t0.Add(35*time.Second), 3412, true, wd, journal); skip {
		t.Fatal("a finished boot check still suppressed the process check")
	}

	if everRecovering(wd) {
		t.Fatalf("watchdog entered RECOVERING for a healthy agent: %+v", wd.StateHistory())
	}
	if wd.State() != watchdog.StateMonitoring {
		t.Fatalf("state = %s, want MONITORING", wd.State())
	}
	if journalHas(journal, "agent.not_found") {
		t.Fatal("agent.not_found journaled for a running agent")
	}
	if !journalHas(journal, "agent.boot_wait_service") {
		t.Fatal("the hold was not journaled")
	}
}

// Fresh install: no agent.state (PID 0) while the service is starting.
func TestBootCheck_NoStateFileServiceStartingHolds(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceStarting}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{})

	// Past the two-check confirmation, so a not-found verdict could not hide
	// behind its first, unconfirmed pass.
	for i := 0; i < 4; i++ {
		if skip := b.evaluate(t0.Add(time.Duration(i)*5*time.Second), 0, false, wd, journal); !skip {
			t.Fatalf("check %d: hold did not own the tick", i)
		}
	}
	if wd.State() != watchdog.StateConnecting || everRecovering(wd) {
		t.Fatalf("state = %s, want CONNECTING with no recovery", wd.State())
	}
	if !journalHas(journal, "agent.boot_wait_service") || journalHas(journal, "agent.not_found_unconfirmed") {
		t.Fatal("expected a hold and no not-found verdict")
	}
}

// The previous boot's PID is reused by an unrelated live process while the
// service manager runs the real agent: hold on the service, as for a dead PID.
func TestBootCheck_ReusedStalePIDRunningServiceHolds(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceRunning, PID: 3412}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{5824: true, 3412: true})

	for i := 0; i < 3; i++ {
		b.evaluate(t0.Add(time.Duration(i)*5*time.Second), 5824, false, wd, journal)
	}
	if wd.State() != watchdog.StateConnecting || !b.active(wd) {
		t.Fatalf("state = %s active = %v, want a held CONNECTING", wd.State(), b.active(wd))
	}
}

// At the deadline, an agent whose heartbeat loop is demonstrably running (but
// whose IPC never came up) is handed to the ordinary checks, not restarted.
func TestBootCheck_DeadlineWithHeartbeatReleases(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceRunning, PID: 3412}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{3412: true})

	b.evaluate(t0, 3412, false, wd, journal)
	if skip := b.evaluate(t0.Add(bootTestDeadline), 3412, true, wd, journal); skip {
		t.Fatal("released check still suppressed the ordinary process check")
	}
	if b.active(wd) || everRecovering(wd) || wd.State() != watchdog.StateConnecting {
		t.Fatalf("state = %s active = %v, want released CONNECTING with no recovery", wd.State(), b.active(wd))
	}
	if !journalHas(journal, "agent.boot_check_released") {
		t.Fatal("release not journaled")
	}
}

// A release because the service query failed must leave a warn-level trace:
// otherwise the journal cannot show that the check had no effect on this host.
func TestBootCheck_UnknownReleaseIsJournaledAsWarning(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceUnknown, Detail: "exit status 1: not loaded"}}
	b := newBootCheck(time.Now(), bootTestDeadline, svc.query, fakeProcesses{5824: true})

	b.evaluate(time.Now(), 5824, false, wd, journal)
	for _, e := range journal.Recent(100) {
		if e.Event == "agent.boot_check_released" {
			if e.Level != watchdog.LevelWarn || e.Data["service_detail"] != "exit status 1: not loaded" {
				t.Fatalf("release entry = %+v, want warn with the query detail", e)
			}
			return
		}
	}
	t.Fatal("release on an unknown service was not journaled")
}

// noteAgentUnhealthy's gate: dropped while the check owns the decision
// (holding, or with a first not-found pending), passed through after it.
func TestBootCheck_DeferUnhealthy(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceRunning, PID: 3412}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{3412: true})

	b.evaluate(t0, 5824, false, wd, journal)
	if !b.deferUnhealthy(t0.Add(time.Second), wd, journal) {
		t.Fatal("stale-heartbeat verdict not deferred during the hold")
	}
	if !journalHas(journal, "check.unhealthy_deferred_boot") {
		t.Fatal("deferral not journaled")
	}

	svc.status = watchdog.AgentServiceStatus{State: watchdog.AgentServiceStopped}
	b.evaluate(t0.Add(5*time.Second), 5824, false, wd, journal)
	if !b.deferUnhealthy(t0.Add(6*time.Second), wd, journal) {
		t.Fatal("verdict not deferred while a first not-found is pending")
	}

	b.evaluate(t0.Add(10*time.Second), 5824, false, wd, journal)
	if b.deferUnhealthy(t0.Add(11*time.Second), wd, journal) {
		t.Fatal("verdict still deferred after recovery started")
	}
	var nilCheck *bootCheck
	if nilCheck.deferUnhealthy(time.Now(), wd, journal) {
		t.Fatal("nil check deferred a verdict")
	}
}

// The agent really is gone: recovery starts at once, exactly as before.
func TestBootCheck_StalePIDServiceStoppedRecovers(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceStopped}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{})

	b.evaluate(t0, 5824, false, wd, journal)
	if wd.State() != watchdog.StateConnecting {
		t.Fatalf("state = %s after one not-found check, want CONNECTING", wd.State())
	}
	b.evaluate(t0.Add(5*time.Second), 5824, false, wd, journal)
	if wd.State() != watchdog.StateRecovering {
		t.Fatalf("state = %s, want RECOVERING", wd.State())
	}
	if !journalHas(journal, "agent.not_found") {
		t.Fatal("agent.not_found not journaled")
	}
	if b.active(wd) {
		t.Fatal("boot check still active after handing off to recovery")
	}
}

// The previous boot's PID now belongs to an unrelated process. Before #12291
// a live stale PID kept the watchdog waiting until the heartbeat went stale;
// with the service manager saying stopped it must recover now.
func TestBootCheck_ReusedStalePIDNotMistakenForAgent(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceStopped}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{5824: true})

	b.evaluate(t0, 5824, false, wd, journal)
	b.evaluate(t0.Add(5*time.Second), 5824, false, wd, journal)
	if wd.State() != watchdog.StateRecovering {
		t.Fatalf("state = %s, want RECOVERING", wd.State())
	}
}

// Running per the service manager but never reachable and never heartbeating:
// the hold ends at its deadline and recovery starts.
func TestBootCheck_HoldExpiresIntoRecovery(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceRunning, PID: 3412}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{3412: true})

	b.evaluate(t0, 3412, false, wd, journal)
	b.evaluate(t0.Add(bootTestDeadline-time.Second), 3412, false, wd, journal)
	if wd.State() != watchdog.StateConnecting {
		t.Fatalf("state = %s before the deadline, want CONNECTING", wd.State())
	}
	b.evaluate(t0.Add(bootTestDeadline), 3412, false, wd, journal)
	b.evaluate(t0.Add(bootTestDeadline+5*time.Second), 3412, false, wd, journal)
	if wd.State() != watchdog.StateRecovering {
		t.Fatalf("state = %s after the deadline, want RECOVERING", wd.State())
	}
}

// Service-manager query failed: the pre-#12291 decision on the state-file PID.
func TestBootCheck_UnknownServiceKeepsPriorBehaviour(t *testing.T) {
	unknown := watchdog.AgentServiceStatus{State: watchdog.AgentServiceUnknown, Detail: "query failed"}

	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	b := newBootCheck(time.Now(), bootTestDeadline, (&fakeService{status: unknown}).query, fakeProcesses{})
	b.evaluate(time.Now(), 5824, false, wd, journal)
	b.evaluate(time.Now(), 5824, false, wd, journal)
	if wd.State() != watchdog.StateRecovering {
		t.Fatalf("dead PID: state = %s, want RECOVERING", wd.State())
	}

	wd = watchdog.NewWatchdog(watchdog.Config{})
	b = newBootCheck(time.Now(), bootTestDeadline, (&fakeService{status: unknown}).query, fakeProcesses{5824: true})
	if skip := b.evaluate(time.Now(), 5824, false, wd, journal); skip {
		t.Fatal("live PID: the ordinary process check was suppressed")
	}
	if wd.State() != watchdog.StateConnecting || b.active(wd) {
		t.Fatalf("live PID: state = %s active = %v, want CONNECTING and released", wd.State(), b.active(wd))
	}
}

func TestBootCheckDeadlineCoversTwoIPCReconnects(t *testing.T) {
	if got := bootCheckDeadline(120*time.Second, 30*time.Second); got != 120*time.Second {
		t.Fatalf("got %v, want 120s", got)
	}
	if got := bootCheckDeadline(20*time.Second, 30*time.Second); got != 60*time.Second {
		t.Fatalf("got %v, want 60s", got)
	}
}

// At watchdog start SCM may not have started the agent yet (both services are
// auto-start, with no ordering), so "stopped" at t0 is not yet an answer. A
// not-found verdict must be seen again on the next check, on fresh evidence,
// before recovery starts.
func TestBootCheck_StoppedAtStartRunningAtFirstTickNeverRecovers(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceStopped}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{3412: true})

	b.evaluate(t0, 5824, false, wd, journal)
	if wd.State() != watchdog.StateConnecting {
		t.Fatalf("state = %s after one stopped answer, want CONNECTING", wd.State())
	}
	svc.status = watchdog.AgentServiceStatus{State: watchdog.AgentServiceRunning, PID: 3412}
	b.evaluate(t0.Add(5*time.Second), 3412, false, wd, journal)
	if everRecovering(wd) || !b.active(wd) {
		t.Fatalf("state = %s active = %v, want a held CONNECTING", wd.State(), b.active(wd))
	}
}

// Same with no service-manager answer: dead previous-boot PID at t0, the new
// agent's live PID in the state file at the first tick.
func TestBootCheck_UnknownDeadPIDThenLivePIDNeverRecovers(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceUnknown}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{3412: true})

	b.evaluate(t0, 5824, false, wd, journal)
	b.evaluate(t0.Add(5*time.Second), 3412, false, wd, journal)
	if everRecovering(wd) {
		t.Fatalf("watchdog entered RECOVERING: %+v", wd.StateHistory())
	}
}

// A hold between two not-found answers resets the confirmation.
func TestBootCheck_NotFoundConfirmationResetsOnHold(t *testing.T) {
	journal := newBootTestJournal(t)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	svc := &fakeService{status: watchdog.AgentServiceStatus{State: watchdog.AgentServiceStopped}}
	t0 := time.Now()
	b := newBootCheck(t0, bootTestDeadline, svc.query, fakeProcesses{})

	b.evaluate(t0, 5824, false, wd, journal)
	svc.status = watchdog.AgentServiceStatus{State: watchdog.AgentServiceStarting}
	b.evaluate(t0.Add(5*time.Second), 5824, false, wd, journal)
	svc.status = watchdog.AgentServiceStatus{State: watchdog.AgentServiceStopped}
	b.evaluate(t0.Add(10*time.Second), 5824, false, wd, journal)
	if wd.State() != watchdog.StateConnecting {
		t.Fatalf("state = %s, want CONNECTING (not-found seen once since the hold)", wd.State())
	}
	b.evaluate(t0.Add(15*time.Second), 5824, false, wd, journal)
	if wd.State() != watchdog.StateRecovering {
		t.Fatalf("state = %s, want RECOVERING", wd.State())
	}
}

// A nil boot check (IPC connected at startup) is never active.
func TestBootCheck_NilIsInactive(t *testing.T) {
	var b *bootCheck
	if b.active(watchdog.NewWatchdog(watchdog.Config{})) {
		t.Fatal("nil boot check reported active")
	}
}

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

	b.evaluate(t0, 0, false, wd, journal)
	if wd.State() != watchdog.StateConnecting || everRecovering(wd) {
		t.Fatalf("state = %s, want CONNECTING with no recovery", wd.State())
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

// A nil boot check (IPC connected at startup) is never active.
func TestBootCheck_NilIsInactive(t *testing.T) {
	var b *bootCheck
	if b.active(watchdog.NewWatchdog(watchdog.Config{})) {
		t.Fatal("nil boot check reported active")
	}
}

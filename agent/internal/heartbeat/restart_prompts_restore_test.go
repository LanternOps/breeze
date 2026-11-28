package heartbeat

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
)

// An agent restart in the middle of a campaign (#12827): the next agent
// process restores the restart, the heartbeat reports it again, and its card
// comes back as the same campaign, at the same time, with the budget the
// person left it at.
func TestRestartCardComesBackAfterAnAgentRestart(t *testing.T) {
	newMgr := restoreTestManagers(t)
	enabled := []string{"notice.info", "restart.prompt", "restart.final"}

	// First agent process: schedule, show the card, postpone on it.
	f1 := newRCFixture(t, enabled...)
	f1.owners = []prompthost.Owner{rcOwnerA}
	f1.clock.mu.Lock()
	f1.clock.t = time.Now()
	f1.clock.mu.Unlock()
	t1, os1 := &e2eTimers{fns: map[time.Duration][]func(){}}, 0
	m1 := newMgr(t1, &os1)
	f1.card.mgr = m1
	m1.SetRestartSurface(f1.card)
	if err := m1.ScheduleWithOptions(2*time.Hour, time.Now().Add(10*time.Hour), "Patch", "patch_job",
		patching.RebootOptions{Deferral: patching.DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60}}); err != nil {
		t.Fatal(err)
	}
	withDeadline(t, "lead rung", func() { t1.runAt(0) })
	shows := rcShows(f1.dir.take(), "assist-a")
	if len(shows) != 1 {
		t.Fatalf("lead card = %+v", shows)
	}
	cardID := shows[0].PromptID
	presentedBy(t, f1.host, "assist-a", shows[0])
	if res := actBy(t, f1.host, "assist-a", shows[0], "postpone"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("postpone = %+v", res)
	}
	before := m1.State()
	m1.Stop() // the agent service stops

	// Second agent process: a new prompt host over the same on-disk inbox.
	f2 := newRCFixture(t, enabled...)
	f2.owners = []prompthost.Owner{rcOwnerA}
	f2.clock.mu.Lock()
	f2.clock.t = time.Now()
	f2.clock.mu.Unlock()
	f2.host = prompthost.New(prompthost.Deps{Broker: f2.dir, Inbox: f1.inbox, Clock: f2.clock})
	promptkinds.Register(f2.host)
	f2.host.SetEnabledKinds(enabled)
	f2.card.host = f2.host
	t2, os2 := &e2eTimers{fns: map[time.Duration][]func(){}}, 0
	m2 := newMgr(t2, &os2)
	f2.card.mgr = m2
	m2.SetRestartSurface(f2.card)
	if !m2.RestorePendingReboot() {
		t.Fatal("the postponed restart was not restored after the agent restart")
	}
	got := m2.State()
	if !got.ScheduledAt.Round(0).Equal(before.ScheduledAt.Round(0)) || got.DeferralsUsed != 1 {
		t.Fatalf("restored = %v used %d, want %v used 1", got.ScheduledAt, got.DeferralsUsed, before.ScheduledAt)
	}
	// The console keeps showing it: the heartbeat reports an object, not the
	// null that cleared the device row before #12827.
	report := buildRebootStatusReport(got)
	if report == nil || !report.ScheduledAt.Round(0).Equal(before.ScheduledAt.Round(0)) || report.DeferralsUsed != 1 || report.MaxDeferrals != 3 {
		t.Fatalf("heartbeat rebootStatus after restore = %+v", report)
	}

	withDeadline(t, "restored lead rung", func() { t2.runAt(0) })
	shows = rcShows(f2.dir.take(), "assist-a")
	if len(shows) != 1 {
		t.Fatalf("restored card shows = %+v, want the card back once", shows)
	}
	if shows[0].PromptID != cardID {
		t.Errorf("restored card id = %q, want the same campaign's %q", shows[0].PromptID, cardID)
	}
	if shows[0].Timing.DeadlineUnixMs != before.ScheduledAt.UnixMilli() {
		t.Errorf("restored card time = %d, want %d", shows[0].Timing.DeadlineUnixMs, before.ScheduledAt.UnixMilli())
	}
	if shows[0].Copy.StateDetail != "2 postponements left" {
		t.Errorf("restored budget line = %q, want 2 postponements left", shows[0].Copy.StateDetail)
	}
	if os1 != 0 || os2 != 0 {
		t.Fatalf("OS invoked during the test: %d / %d", os1, os2)
	}
}

// The heartbeat's own entry point: RestorePendingReboot on the Heartbeat
// re-arms the restart, and the next heartbeat payload reports it.
func TestHeartbeatRestorePendingRebootFeedsTheNextHeartbeat(t *testing.T) {
	seams := tempRebootSeams(t)
	seams.BootID = func() string { return "linux:same-boot" }
	enrollment := func() string { return "agent-1" }
	// The audit log's agent starts: the writer, then the restoring process,
	// both 1.0.0.
	starts := []string{"start-1", "start-2"}
	startsAfter := func(tok string) ([]string, bool, error) {
		for i, s := range starts {
			if s == tok {
				return []string{"1.0.0"}[:len(starts)-1-i], true, nil
			}
		}
		return nil, false, nil
	}
	first := patching.NewRebootManagerWithSeams(func(string, string, string) {}, nil, 3, seams)
	first.SetEnrollment(enrollment)
	first.SetAgentRun(patching.AgentRun{Version: "1.0.0", StartToken: "start-1", StartsAfter: startsAfter})
	if err := first.Schedule(time.Hour, time.Now().Add(time.Hour), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	want := first.State().ScheduledAt
	first.Stop()

	h := &Heartbeat{
		rebootMgr:        patching.NewRebootManagerWithSeams(func(string, string, string) {}, nil, 3, seams),
		agentVersion:     "1.0.0",
		agentStartsAfter: startsAfter,
	}
	h.rebootMgr.SetEnrollment(enrollment)
	t.Cleanup(h.rebootMgr.Stop)
	if h.rebootStatusForHeartbeat() != nil {
		t.Fatal("setup: something scheduled before the restore")
	}
	if !h.RestorePendingReboot("start-2") {
		t.Fatal("Heartbeat.RestorePendingReboot restored nothing")
	}
	report := h.rebootStatusForHeartbeat()
	if report == nil || !report.ScheduledAt.Round(0).Equal(want.Round(0)) || report.Source != "patch_job" {
		t.Fatalf("heartbeat rebootStatus after restore = %+v, want the restart at %v", report, want)
	}
	if (&Heartbeat{}).RestorePendingReboot("start-3") {
		t.Fatal("a heartbeat with no reboot manager reported a restore")
	}

	// With the audit log disabled (no history) nothing is restored: it cannot
	// tell whether an older agent ran since.
	first.Stop()
	h.rebootMgr.Stop()
	noLog := &Heartbeat{rebootMgr: patching.NewRebootManagerWithSeams(func(string, string, string) {}, nil, 3, seams), agentVersion: "1.0.0"}
	noLog.rebootMgr.SetEnrollment(enrollment)
	t.Cleanup(noLog.rebootMgr.Stop)
	if noLog.RestorePendingReboot("") {
		t.Fatal("restored with the audit log disabled")
	}
}

// restoreTestManagers returns a constructor for successive agent processes on
// one machine: same boot, same enrollment, same version, sharing a ledger and
// an agent start history. Every OS restart is counted, never run.
func restoreTestManagers(t *testing.T) func(timers *e2eTimers, osCalls *int) *patching.RebootManager {
	t.Helper()
	dir := t.TempDir()
	var starts []string
	startsAfter := func(tok string) ([]string, bool, error) {
		for i, s := range starts {
			if s == tok {
				out := make([]string, 0, len(starts)-1-i)
				for range starts[i+1:] {
					out = append(out, "1.0.0")
				}
				return out, true, nil
			}
		}
		return nil, false, nil
	}
	return func(timers *e2eTimers, osCalls *int) *patching.RebootManager {
		m := patching.NewRebootManagerWithSeams(func(string, string, string) {}, nil, 3, patching.RebootSeams{
			Now:              time.Now,
			AfterFunc:        timers.afterFunc,
			ExecOSReboot:     func(time.Duration) error { *osCalls++; return nil },
			AbortOSReboot:    func() error { return nil },
			HistoryPath:      filepath.Join(dir, "history.json"),
			LedgerPath:       filepath.Join(dir, "ledger.json"),
			BootID:           func() string { return "linux:same-boot" },
			StateFileTrusted: func(string) error { return nil },
		})
		starts = append(starts, fmt.Sprintf("start-%d", len(starts)+1))
		m.SetEnrollment(func() string { return "agent-1" })
		m.SetAgentRun(patching.AgentRun{Version: "1.0.0", StartToken: starts[len(starts)-1], StartsAfter: startsAfter})
		return m
	}
}

// At agent start no helper is connected, so the restored restart's
// announcement draws no card. The first session that connects gets the card.
func TestRestoredRestartCardIsShownWhenTheFirstSessionConnects(t *testing.T) {
	newMgr := restoreTestManagers(t)
	enabled := []string{"notice.info", "restart.prompt", "restart.final"}

	t1, os1 := &e2eTimers{fns: map[time.Duration][]func(){}}, 0
	m1 := newMgr(t1, &os1)
	if err := m1.Schedule(time.Hour, time.Now().Add(time.Hour), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	m1.Stop()

	f := newRCFixture(t, enabled...)
	f.owners = nil // the agent just started: no helper yet
	f.clock.mu.Lock()
	f.clock.t = time.Now()
	f.clock.mu.Unlock()
	t2, os2 := &e2eTimers{fns: map[time.Duration][]func(){}}, 0
	m2 := newMgr(t2, &os2)
	f.card.mgr = m2
	m2.SetRestartSurface(f.card)
	t.Cleanup(m2.Stop)
	if !m2.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	withDeadline(t, "restored lead rung", func() { t2.runAt(0) })
	if shows := rcShows(f.dir.take(), "assist-a"); len(shows) != 0 {
		t.Fatalf("a card was drawn with no session connected: %+v", shows)
	}

	f.owners = []prompthost.Owner{rcOwnerA} // the helper connects
	withDeadline(t, "first session connects", m2.AudienceConnected)
	shows := rcShows(f.dir.take(), "assist-a")
	if len(shows) != 1 {
		t.Fatalf("cards after the first session connected = %+v, want the restored restart's card", shows)
	}
	if want := m2.State().ScheduledAt.UnixMilli(); shows[0].Timing.DeadlineUnixMs != want {
		t.Errorf("card time = %d, want %d", shows[0].Timing.DeadlineUnixMs, want)
	}
	withDeadline(t, "second session connects", m2.AudienceConnected)
	if again := rcShows(f.dir.take(), "assist-a"); len(again) != 0 {
		t.Fatalf("announced again to a later session: %+v", again)
	}
	if os1 != 0 || os2 != 0 {
		t.Fatalf("OS invoked during the test: %d / %d", os1, os2)
	}
}

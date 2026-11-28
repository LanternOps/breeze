package heartbeat

import (
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
	dir := t.TempDir()
	newMgr := func(timers *e2eTimers, osCalls *int) *patching.RebootManager {
		return patching.NewRebootManagerWithSeams(func(string, string, string) {}, nil, 3, patching.RebootSeams{
			Now:              time.Now,
			AfterFunc:        timers.afterFunc,
			ExecOSReboot:     func(time.Duration) error { *osCalls++; return nil },
			AbortOSReboot:    func() error { return nil },
			HistoryPath:      filepath.Join(dir, "history.json"),
			LedgerPath:       filepath.Join(dir, "ledger.json"),
			BootID:           func() string { return "linux:same-boot" },
			StateFileTrusted: func(string) error { return nil },
		})
	}
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
	// Real timers here: never let one reach the OS.
	seams.ExecOSReboot = func(time.Duration) error { t.Error("OS restart invoked"); return nil }
	seams.AbortOSReboot = func() error { return nil }
	first := patching.NewRebootManagerWithSeams(func(string, string, string) {}, nil, 3, seams)
	if err := first.Schedule(time.Hour, time.Now().Add(time.Hour), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	want := first.State().ScheduledAt
	first.Stop()

	h := &Heartbeat{rebootMgr: patching.NewRebootManagerWithSeams(func(string, string, string) {}, nil, 3, seams)}
	t.Cleanup(h.rebootMgr.Stop)
	if h.rebootStatusForHeartbeat() != nil {
		t.Fatal("setup: something scheduled before the restore")
	}
	if !h.RestorePendingReboot() {
		t.Fatal("Heartbeat.RestorePendingReboot restored nothing")
	}
	report := h.rebootStatusForHeartbeat()
	if report == nil || !report.ScheduledAt.Round(0).Equal(want.Round(0)) || report.Source != "patch_job" {
		t.Fatalf("heartbeat rebootStatus after restore = %+v, want the restart at %v", report, want)
	}
	if (&Heartbeat{}).RestorePendingReboot() {
		t.Fatal("a heartbeat with no reboot manager reported a restore")
	}
}

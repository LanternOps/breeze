// Guards on a restored restart (#12827): the minimum warning, the enrollment
// and agent-history checks, and the record's sanity bounds.
package patching

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"strings"
	"testing"
	"time"
)

// The probe from review: 30 seconds left when the agent comes back. The
// restart must not go to the OS at once; it gets the minimum warning period,
// and the OS command waits for the closing rung at the end of it.
func TestRestoreWithSecondsLeftStillWarnsForTheMinimumPeriod(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)
	g.clock.advance(30*time.Minute - 30*time.Second)

	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	st := b.rm.State()
	if want := g.clock.now().Add(minRestoreWarning); !st.ScheduledAt.Equal(want) {
		t.Fatalf("restored ScheduledAt = %v (%v from now), want now+%v", st.ScheduledAt, st.ScheduledAt.Sub(g.clock.now()), minRestoreWarning)
	}
	b.timers.runAt(0)
	if len(*b.osCalls) != 0 {
		t.Fatalf("the restart went to the OS the moment the agent started: %v", *b.osCalls)
	}
	closing := minRestoreWarning - finalNoticeLead
	for _, o := range b.timers.offsets() {
		if o > closing {
			t.Fatalf("a timer is armed at +%v, after the closing rung at +%v", o, closing)
		}
		if o < closing {
			b.timers.runAt(o)
		}
	}
	if len(*b.osCalls) != 0 {
		t.Fatal("the OS was invoked before the closing rung of the minimum period")
	}
	b.timers.runAt(closing)
	if len(*b.osCalls) != 1 {
		t.Fatalf("OS calls at the closing rung = %d, want 1", len(*b.osCalls))
	}

}

// Another agent restart inside the minimum period is a restore like any
// other: the time left is again never less than the minimum (the helper that
// may have shown the warning went with the old agent's session).
func TestASecondRestoreInsideThePeriodAgainLeavesTheMinimum(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	stopAgent(a)
	g.clock.advance(29 * time.Minute)
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	g.clock.advance(10 * time.Minute)
	stopAgent(b)
	c := g.manager()
	if !c.rm.RestorePendingReboot() {
		t.Fatal("not restored the second time")
	}
	if got, want := c.rm.State().ScheduledAt, g.clock.now().Add(minRestoreWarning); !got.Equal(want) {
		t.Fatalf("second restore ScheduledAt = %v, want now+%v", got, minRestoreWarning)
	}
}

// An agent that keeps restarting inside the period (a crash loop) moves the
// restart out each time, but the day-late cutoff counts from when it was
// first due, so it cannot be deferred for ever.
func TestRestoresThatKeepMovingTheRestartStopADayAfterItWasFirstDue(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(20*time.Minute, g.clock.now().Add(20*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	firstDue := a.rm.State().ScheduledAt
	stopAgent(a)
	for g.clock.now().Before(firstDue.Add(maxRestoreOverdue - 10*time.Minute)) {
		g.clock.advance(10 * time.Minute)
		p := g.manager()
		if !p.rm.RestorePendingReboot() {
			t.Fatalf("dropped at %v, before a day past the first due time %v", g.clock.now(), firstDue)
		}
		stopAgent(p)
	}
	g.clock.advance(20 * time.Minute)
	last := g.manager()
	if last.rm.RestorePendingReboot() {
		t.Fatalf("still restored %v after it was first due", g.clock.now().Sub(firstDue))
	}
	assertNothingArmed(t, last)
}

// A postponement after a restore is a new promise: the cutoff counts from
// the postponed time, not the restore's.
func TestAPostponementAfterARestoreResetsTheFirstDueTime(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.ScheduleWithOptions(20*time.Minute, g.clock.now().Add(48*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatal(err)
	}
	stopAgent(a)
	g.clock.advance(30 * time.Minute) // overdue: moved to +15m
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	if _, err := b.rm.Defer(); err != nil {
		t.Fatalf("Defer: %v", err)
	}
	l, err := readDeferralLedger(g.ledger)
	if err != nil || l.Pending == nil {
		t.Fatalf("ledger: %v", err)
	}
	if !l.Pending.FirstDueAt.Equal(l.Pending.ScheduledAt) {
		t.Fatalf("FirstDueAt = %v after a postponement to %v; want the postponed time", l.Pending.FirstDueAt, l.Pending.ScheduledAt)
	}
}

// One rule for every restore: the time left is never less than the minimum,
// and a restart with more left keeps its original time.
func TestRestoreLeavesAtLeastTheMinimumWarning(t *testing.T) {
	for _, left := range []time.Duration{-50 * time.Minute, 0, time.Second, 90 * time.Second, 5 * time.Minute, minRestoreWarning - time.Second, minRestoreWarning, 20 * time.Minute} {
		t.Run(left.String(), func(t *testing.T) {
			g := newRestoreRig(t)
			a := g.manager()
			if err := a.rm.Schedule(time.Hour, g.clock.now().Add(time.Hour), "Patch", "patch_job"); err != nil {
				t.Fatal(err)
			}
			original := a.rm.State().ScheduledAt
			stopAgent(a)
			g.clock.advance(time.Hour - left)
			b := g.manager()
			if !b.rm.RestorePendingReboot() {
				t.Fatal("not restored")
			}
			got := b.rm.State().ScheduledAt
			if left >= minRestoreWarning {
				if !got.Equal(original) {
					t.Fatalf("ScheduledAt = %v, want the original %v", got, original)
				}
				return
			}
			if want := g.clock.now().Add(minRestoreWarning); !got.Equal(want) {
				t.Fatalf("ScheduledAt = %v, want now+%v", got, minRestoreWarning)
			}
		})
	}
}

// The re-announcement at agent start reaches nobody when no helper is
// connected yet. The first session that connects is told, once.
func TestRestoredRestartIsAnnouncedToTheFirstSessionThatConnects(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(time.Hour, g.clock.now().Add(time.Hour), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	stopAgent(a)
	g.clock.advance(30 * time.Minute)
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	b.timers.runAt(0)
	atStart := len(*b.notes)

	g.clock.advance(2 * time.Minute)
	b.rm.AudienceConnected()
	if got := len(*b.notes); got != atStart+1 {
		t.Fatalf("notifications after the first session connected = %d, want %d", got, atStart+1)
	}
	last := (*b.notes)[len(*b.notes)-1]
	if !strings.Contains(last.body, "28 minutes") {
		t.Errorf("announcement body = %q, want the time left (28 minutes)", last.body)
	}
	if len(*b.prompts) != 0 {
		t.Errorf("the announcement opened a dialog: %v", *b.prompts)
	}
	b.rm.AudienceConnected()
	if got := len(*b.notes); got != atStart+1 {
		t.Fatalf("a second session re-announced again: %d notifications", got)
	}
}

func TestOnlyARestoredRestartIsReannouncedOnConnect(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(time.Hour, g.clock.now().Add(time.Hour), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	a.timers.runAt(0)
	n := len(*a.notes)
	a.rm.AudienceConnected()
	if len(*a.notes) != n {
		t.Fatal("a live (not restored) restart was re-announced on connect")
	}

	// Restored, then cancelled before anyone connected: nothing to announce.
	stopAgent(a)
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	if err := b.rm.Cancel(); err != nil {
		t.Fatal(err)
	}
	m := len(*b.notes)
	b.rm.AudienceConnected()
	if len(*b.notes) != m {
		t.Fatal("a cancelled restart was announced on connect")
	}
}

// Inside the closing minute the OS countdown is running and the closing rung
// already said so: connecting then adds nothing.
func TestNoReannouncementOnceTheOSCountdownRuns(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(time.Hour, g.clock.now().Add(time.Hour), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	stopAgent(a)
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	closing := time.Hour - finalNoticeLead
	g.clock.advance(closing)
	b.timers.runAt(closing)
	if len(*b.osCalls) != 1 {
		t.Fatalf("setup: OS calls = %d", len(*b.osCalls))
	}
	n := len(*b.notes)
	b.rm.AudienceConnected()
	if len(*b.notes) != n {
		t.Fatal("re-announced after the OS countdown started")
	}
}

// A reinstall or re-enroll keeps the data folder; the new enrollment must not
// inherit the old one's restart.
func TestRestoreDiscardsARecordFromAnotherEnrollment(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	stopAgent(a)

	g.agentID = "agent-2" // re-enrolled while the agent was down
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("restored the previous enrollment's restart")
	}
	assertNothingArmed(t, b)
	g.agentID = "agent-1"
	c := g.manager()
	if c.rm.RestorePendingReboot() {
		t.Fatal("the other enrollment's record was left on disk")
	}
}

func TestRestoreRefusesWithoutAnEnrollment(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	stopAgent(a)
	g.agentID = ""
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("restored without knowing this agent's enrollment")
	}
	assertNothingArmed(t, b)
}

// Rollback then re-upgrade in one boot: the older agent cancels without
// knowing the record exists, so its start alone must stop the restore.
func TestRestoreRefusesAfterAnotherAgentVersionRan(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(time.Hour, g.clock.now().Add(time.Hour), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	stopAgent(a)
	g.agentStarted("0.9.0") // rolled back; it ran (and may have cancelled)
	b := g.manager()        // re-upgraded to 1.0.0
	if b.rm.RestorePendingReboot() {
		t.Fatal("restored a restart an older agent ran over (and may have cancelled)")
	}
	assertNothingArmed(t, b)
}

func TestRestoreSurvivesADirectUpgrade(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(time.Hour, g.clock.now().Add(time.Hour), "Patch", "patch_job"); err != nil {
		t.Fatal(err)
	}
	stopAgent(a)
	g.version = "1.1.0"
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("an upgrade straight from a build with this fix lost the restart")
	}
	// The restore re-wrote the record as 1.1.0's; a further restart of 1.1.0
	// restores it again.
	stopAgent(b)
	c := g.manager()
	if !c.rm.RestorePendingReboot() {
		t.Fatal("not restored after the upgraded agent restarted")
	}
}

func TestRestoreRefusesWhenTheAgentHistoryCannotTell(t *testing.T) {
	for name, history := range map[string]func(string) ([]string, bool, error){
		"writer not in history": func(string) ([]string, bool, error) { return nil, false, nil },
		"history unreadable":    func(string) ([]string, bool, error) { return nil, false, errors.New("audit log unavailable") },
	} {
		t.Run(name, func(t *testing.T) {
			g := newRestoreRig(t)
			a := g.manager()
			if err := a.rm.Schedule(time.Hour, g.clock.now().Add(time.Hour), "Patch", "patch_job"); err != nil {
				t.Fatal(err)
			}
			stopAgent(a)
			g.history = history
			b := g.manager()
			if b.rm.RestorePendingReboot() {
				t.Fatal("restored without being able to tell whether another agent ran since")
			}
			assertNothingArmed(t, b)
		})
	}
	t.Run("writer had no start token", func(t *testing.T) {
		g := newRestoreRig(t)
		a := g.manager()
		a.rm.SetAgentRun(AgentRun{Version: g.version, StartsAfter: g.startsAfter})
		if err := a.rm.Schedule(time.Hour, g.clock.now().Add(time.Hour), "Patch", "patch_job"); err != nil {
			t.Fatal(err)
		}
		stopAgent(a)
		b := g.manager()
		if b.rm.RestorePendingReboot() {
			t.Fatal("restored a record whose writer could not be placed in the history")
		}
	})
}

func TestRestoreDiscardsAnImplausibleRecord(t *testing.T) {
	cases := map[string]func(r *PendingRebootRecord, l *DeferralLedger){
		// A Sub against a time this far back saturates; it must still read as
		// overdue by more than a day, never as "give it the fresh period".
		"scheduled time far in the past": func(r *PendingRebootRecord, _ *DeferralLedger) {
			r.ScheduledAt = time.Date(1, 1, 1, 0, 0, 0, 1, time.UTC)
		},
		"scheduled time decades ago": func(r *PendingRebootRecord, _ *DeferralLedger) { r.ScheduledAt = r.ScheduledAt.AddDate(-30, 0, 0) },
		"deadline far in the past": func(_ *PendingRebootRecord, l *DeferralLedger) {
			l.Deadline = time.Date(1, 1, 1, 0, 0, 0, 1, time.UTC)
		},
		"campaign at the maximum": func(r *PendingRebootRecord, _ *DeferralLedger) { r.Campaign = math.MaxUint64 },
		"campaign from the future": func(r *PendingRebootRecord, _ *DeferralLedger) {
			r.Campaign = uint64(time.Now().AddDate(1, 0, 0).UnixMilli())
		},
		"missing enrollment":   func(r *PendingRebootRecord, _ *DeferralLedger) { r.Enrollment = "" },
		"missing writer start": func(r *PendingRebootRecord, _ *DeferralLedger) { r.WriterStart = "" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			g := newRestoreRig(t)
			a := g.manager()
			if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
				t.Fatal(err)
			}
			stopAgent(a)
			raw, err := os.ReadFile(g.ledger)
			if err != nil {
				t.Fatal(err)
			}
			var l DeferralLedger
			if err := json.Unmarshal(raw, &l); err != nil || l.Pending == nil {
				t.Fatalf("setup: %v", err)
			}
			mutate(l.Pending, &l)
			raw, _ = json.Marshal(l)
			if err := os.WriteFile(g.ledger, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			b := g.manager()
			if b.rm.RestorePendingReboot() {
				t.Fatalf("restored an implausible record; ScheduledAt = %v", b.rm.State().ScheduledAt)
			}
			assertNothingArmed(t, b)
			if id := newCampaignID(g.clock.now()); id == 0 {
				t.Fatal("the campaign id wrapped to zero")
			}
		})
	}
}

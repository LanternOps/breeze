// A pending restart survives an agent restart (#12827).
//
// Every test here tears one manager down mid-campaign (Stop, which is what an
// agent service stop or upgrade does) and brings a fresh one up over the same
// on-disk record, the way the next agent process would.
package patching

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

const testBootID = "linux:boot-a"

// restoreRig is one "machine": a clock, a boot, and the agent data dir. Each
// manager() call is one agent process on it.
type restoreRig struct {
	t      *testing.T
	clock  *fakeClock
	ledger string
	boot   string
	// agentID is the enrollment, version the binary the next manager() runs.
	agentID string
	version string
	// starts is the agent start history (the audit log's agent_start
	// entries), oldest first. history overrides StartsAfter when set.
	starts  []agentStart
	history func(token string) ([]string, bool, error)
}

type agentStart struct{ token, version string }

func newRestoreRig(t *testing.T) *restoreRig {
	t.Helper()
	dir := t.TempDir()
	trustDataDirForTest(t, dir)
	return &restoreRig{
		t:       t,
		clock:   &fakeClock{t: time.Now().Truncate(time.Second)},
		ledger:  filepath.Join(dir, deferralLedgerFile),
		boot:    testBootID,
		agentID: "agent-1",
		version: "1.0.0",
	}
}

// agentStarted records an agent start of version, as its agent_start audit
// entry would, and returns its token.
func (g *restoreRig) agentStarted(version string) string {
	tok := fmt.Sprintf("start-%d", len(g.starts)+1)
	g.starts = append(g.starts, agentStart{token: tok, version: version})
	return tok
}

func (g *restoreRig) startsAfter(token string) ([]string, bool, error) {
	if g.history != nil {
		return g.history(token)
	}
	for i, s := range g.starts {
		if s.token == token {
			var vs []string
			for _, later := range g.starts[i+1:] {
				vs = append(vs, later.version)
			}
			return vs, true, nil
		}
	}
	return nil, false, nil
}

type restoreProc struct {
	rm      *RebootManager
	timers  *fakeTimers
	notes   *[]notifyCall
	osCalls *[]time.Duration
	prompts *[]string
}

func (g *restoreRig) manager() restoreProc {
	g.t.Helper()
	rm, timers, notes, osCalls := newTestManager(g.t, 3)
	rm.nowFn = g.clock.now
	ledger := g.ledger
	rm.deferralLedger = func() string { return ledger }
	boot := g.boot
	rm.SetBootID(func() string { return boot })
	agentID := g.agentID
	rm.SetEnrollment(func() string { return agentID })
	rm.SetAgentRun(AgentRun{Version: g.version, StartToken: g.agentStarted(g.version), StartsAfter: g.startsAfter})
	var mu sync.Mutex
	prompts := []string{}
	// A prompt nobody answers, recorded so a test can tell a dialog from a
	// plain warning.
	rm.promptFn = func(title, _ string, _ string, _ []string, _ time.Duration) (string, bool) {
		mu.Lock()
		defer mu.Unlock()
		prompts = append(prompts, title)
		return "", true
	}
	return restoreProc{rm: rm, timers: timers, notes: notes, osCalls: osCalls, prompts: &prompts}
}

// stopAgent is the agent service stopping: the manager is torn down, its
// timers die with the process, and whatever it put on disk stays.
func stopAgent(p restoreProc) { p.rm.Stop() }

func TestRestoredRestartFiresAtTheOriginalTimes(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	deadline := g.clock.now().Add(4 * time.Hour)
	if err := a.rm.ScheduleWithOptions(30*time.Minute, deadline, "Patch", "patch_job", allowDeferral(3, 25)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	a.timers.runAt(0)
	// The person postpones once: the restart moves from +30m to +55m.
	if _, err := a.rm.Defer(); err != nil {
		t.Fatalf("Defer: %v", err)
	}
	before := a.rm.State()
	campaign := a.rm.currentCampaign()

	// Three minutes later the agent service restarts.
	g.clock.advance(3 * time.Minute)
	stopAgent(a)
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("RestorePendingReboot = false: the postponed restart was lost across the agent restart")
	}

	got := b.rm.State()
	if !got.RebootScheduled {
		t.Fatal("restored manager reports nothing scheduled; the console would clear the pending restart")
	}
	if !got.ScheduledAt.Equal(before.ScheduledAt) {
		t.Fatalf("restored ScheduledAt = %v, want the original %v", got.ScheduledAt, before.ScheduledAt)
	}
	if !got.Deadline.Equal(deadline) {
		t.Errorf("restored Deadline = %v, want %v", got.Deadline, deadline)
	}
	if got.DeferralsUsed != 1 || got.MaxDeferrals != 3 || !got.DeferralAllowed {
		t.Errorf("restored budget = used %d of %d (allowed %v), want 1 of 3 — a postponement is neither given back nor double-counted",
			got.DeferralsUsed, got.MaxDeferrals, got.DeferralAllowed)
	}
	if got.Source != "patch_job" || got.Reason != "Patch" {
		t.Errorf("restored source/reason = %q/%q", got.Source, got.Reason)
	}
	if c := b.rm.currentCampaign(); c != campaign {
		t.Errorf("restored campaign = %d, want %d (the restart card and its tombstones are keyed by it)", c, campaign)
	}

	// 52 minutes are left. The postponed schedule had its 15- and 5-minute
	// reminders at +40m and +50m and its OS countdown at +54m from the
	// postponement; three minutes on, those are +37m, +47m and +51m: the same
	// wall-clock instants.
	remaining := before.ScheduledAt.Sub(g.clock.now())
	if remaining != 52*time.Minute {
		t.Fatalf("test arithmetic: remaining = %v", remaining)
	}
	offsets := b.timers.offsets()
	want := map[time.Duration]bool{0: false, 37 * time.Minute: false, 47 * time.Minute: false, 51 * time.Minute: false}
	for _, o := range offsets {
		if o < 0 {
			t.Fatalf("a timer was armed in the past: %v", offsets)
		}
		if _, ok := want[o]; ok {
			want[o] = true
		}
	}
	for o, seen := range want {
		if !seen {
			t.Errorf("no timer at +%v; armed %v", o, offsets)
		}
	}

	// The re-announcement at restore time warns without a dialog: the person
	// just answered one (#4941), and the next reminder asks again.
	b.timers.runAt(0)
	if len(*b.prompts) != 0 {
		t.Errorf("restore lead opened a dialog: %v", *b.prompts)
	}
	if len(*b.notes) != 1 {
		t.Fatalf("restore lead notifications = %d, want 1", len(*b.notes))
	}
	b.timers.runAt(37 * time.Minute)
	if len(*b.prompts) != 1 {
		t.Errorf("the next reminder must offer the choice again; prompts = %v", *b.prompts)
	}

	// Exactly one restart: the old process's timers are dead, the new one's
	// closing rung invokes the OS once.
	for _, o := range a.timers.offsets() {
		a.timers.runAt(o)
	}
	if len(*a.osCalls) != 0 {
		t.Fatalf("the stopped manager invoked the OS: %v", *a.osCalls)
	}
	b.timers.runAt(47 * time.Minute)
	if len(*b.osCalls) != 0 {
		t.Fatal("the OS was invoked before the closing rung")
	}
	b.timers.runAt(51 * time.Minute)
	if len(*b.osCalls) != 1 || (*b.osCalls)[0] != finalNoticeLead {
		t.Fatalf("restored manager OS calls = %v, want one with the %v grace", *b.osCalls, finalNoticeLead)
	}
}

func TestRestoredRestartKeepsTheBudgetAcrossFurtherPostponements(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	deadline := g.clock.now().Add(8 * time.Hour)
	if err := a.rm.ScheduleWithOptions(30*time.Minute, deadline, "Patch", "patch_job", allowDeferral(3, 30)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	for i := range 2 {
		if _, err := a.rm.Defer(); err != nil {
			t.Fatalf("Defer %d: %v", i, err)
		}
	}
	stopAgent(a)

	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	if _, err := b.rm.Defer(); err != nil {
		t.Fatalf("third postponement refused: %v", err)
	}
	if _, err := b.rm.Defer(); err == nil {
		t.Fatal("a fourth postponement was granted: the restore gave budget back")
	}

	// And again: the third postponement is on disk too.
	stopAgent(b)
	c := g.manager()
	if !c.rm.RestorePendingReboot() {
		t.Fatal("not restored the second time")
	}
	if got := c.rm.State().DeferralsUsed; got != 3 {
		t.Fatalf("DeferralsUsed after two agent restarts = %d, want 3", got)
	}
	if _, err := c.rm.Defer(); err == nil {
		t.Fatal("postponement granted past the budget after a second agent restart")
	}
}

func TestRestoreAfterTheRestartTimePassedGivesAFreshWarningPeriod(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(20*time.Minute, g.clock.now().Add(20*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)

	// The agent was down across the restart time.
	g.clock.advance(50 * time.Minute)
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("an overdue restart was dropped instead of re-warned")
	}
	st := b.rm.State()
	if want := g.clock.now().Add(minRestoreWarning); !st.ScheduledAt.Equal(want) {
		t.Fatalf("overdue ScheduledAt = %v, want now+%v = %v", st.ScheduledAt, minRestoreWarning, want)
	}
	// Everything before the closing rung warns; nothing invokes the OS.
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
		t.Fatal("an overdue restore restarted the machine before its fresh warning period ran out")
	}
	if len(*b.notes) < 1 {
		t.Fatal("an overdue restore did not warn at once")
	}

	// A second agent restart inside that period is a restore like any other:
	// again never less than the minimum left (the day-late cutoff, counted
	// from the first due time, bounds how often that can happen).
	g.clock.advance(5 * time.Minute)
	stopAgent(b)
	c := g.manager()
	if !c.rm.RestorePendingReboot() {
		t.Fatal("not restored the second time")
	}
	if got, want := c.rm.State().ScheduledAt, g.clock.now().Add(minRestoreWarning); !got.Equal(want) {
		t.Fatalf("second restore moved the restart to %v, want now+%v = %v", got, minRestoreWarning, want)
	}
}

// The deadline also passed while the agent was down: no postponement is left
// to offer, but the console still reports the ones the person spent.
func TestOverdueRestorePastTheDeadlineKeepsTheSpentCount(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	deadline := g.clock.now().Add(90 * time.Minute)
	if err := a.rm.ScheduleWithOptions(30*time.Minute, deadline, "Patch", "patch_job", allowDeferral(3, 30)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	for i := range 2 {
		if _, err := a.rm.Defer(); err != nil {
			t.Fatalf("Defer %d: %v", i, err)
		}
	}
	stopAgent(a)
	g.clock.advance(2 * time.Hour)
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	st := b.rm.State()
	if st.DeferralsUsed != 2 || st.MaxDeferrals != 3 {
		t.Fatalf("restored budget = %d of %d, want 2 of 3", st.DeferralsUsed, st.MaxDeferrals)
	}
	if _, err := b.rm.Defer(); err == nil {
		t.Fatal("a postponement was granted past the deadline")
	}
}

func TestRestoreDropsARestartOverdueByMoreThanADay(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(20*time.Minute, g.clock.now().Add(20*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)
	g.clock.advance(20*time.Minute + maxRestoreOverdue + time.Minute)
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("a restart more than a day overdue was restored")
	}
	assertNothingArmed(t, b)
}

func TestRestoreNeverResurrectsACancelledRestart(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.ScheduleWithOptions(30*time.Minute, g.clock.now().Add(2*time.Hour), "Patch", "patch_job", allowDeferral(3, 30)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	if _, err := a.rm.Defer(); err != nil {
		t.Fatalf("Defer: %v", err)
	}
	if err := a.rm.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	stopAgent(a)

	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("a cancelled restart came back after an agent restart")
	}
	assertNothingArmed(t, b)
}

func TestRestoreDiscardsARestartFromAnEarlierBoot(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)

	// The machine restarted (for any reason) while the agent was down.
	g.boot = "linux:boot-b"
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("a restart from the previous boot was restored: the machine would restart twice")
	}
	assertNothingArmed(t, b)
	// Discarded, not merely skipped: going back to the old boot id (which
	// cannot happen, but proves the record is gone) restores nothing either.
	g.boot = testBootID
	c := g.manager()
	if c.rm.RestorePendingReboot() {
		t.Fatal("the discarded record was still on disk")
	}
}

func TestRestoreRefusesWhenTheBootCannotBeIdentified(t *testing.T) {
	for name, boot := range map[string]string{
		"no boot id":          "",
		"process-scoped id":   "process:123:456",
		"unidentified at run": "",
	} {
		t.Run(name, func(t *testing.T) {
			g := newRestoreRig(t)
			a := g.manager()
			if name == "unidentified at run" {
				// Scheduled with a real id, restored without one.
				if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
					t.Fatalf("Schedule: %v", err)
				}
				stopAgent(a)
				g.boot = boot
			} else {
				g.boot = boot
				a = g.manager()
				if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
					t.Fatalf("Schedule: %v", err)
				}
				stopAgent(a)
			}
			b := g.manager()
			if b.rm.RestorePendingReboot() {
				t.Fatal("restored a restart without being able to tell whether the machine restarted since")
			}
			assertNothingArmed(t, b)
		})
	}
}

func TestRestoreAfterTheOSCommandWasIssuedDoesNothing(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	scheduleAndReachTheOSCountdown(t, a.rm, a.timers, 10*time.Minute)
	if len(*a.osCalls) != 1 {
		t.Fatalf("setup: OS calls = %d", len(*a.osCalls))
	}
	// The agent stops inside the OS grace minute; the OS countdown carries on
	// without it.
	stopAgent(a)
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("a restart already handed to the OS was armed again")
	}
	assertNothingArmed(t, b)
}

func TestRestoreDropsARestartTheCircuitBreakerBlocked(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	a.rm.maxRebootsPerDay = 1
	a.rm.rebootHistory = []time.Time{g.clock.now().Add(-time.Hour)}
	scheduleAndReachTheOSCountdown(t, a.rm, a.timers, 10*time.Minute)
	if len(*a.osCalls) != 0 {
		t.Fatal("setup: the breaker did not block")
	}
	stopAgent(a)
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("a restart the circuit breaker blocked came back after an agent restart")
	}
}

// Restart now leaves a minute. An agent restart inside it gets the minimum
// warning, like any restore, but never goes back to the hour-long schedule
// the person chose to cut short.
func TestRestoreAfterRestartNowLeavesTheMinimumNotTheOldSchedule(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.ScheduleWithOptions(time.Hour, g.clock.now().Add(2*time.Hour), "Patch", "patch_job", allowDeferral(3, 30)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	hourLong := a.rm.State().ScheduledAt
	if err := a.rm.UserRestartNow(a.rm.currentCampaign(), "native"); err != nil {
		t.Fatalf("UserRestartNow: %v", err)
	}
	stopAgent(a)
	b := g.manager()
	if !b.rm.RestorePendingReboot() {
		t.Fatal("not restored")
	}
	got := b.rm.State().ScheduledAt
	if want := g.clock.now().Add(minRestoreWarning); !got.Equal(want) {
		t.Fatalf("Restart now time after restore = %v, want now+%v = %v", got, minRestoreWarning, want)
	}
	if !got.Before(hourLong) {
		t.Fatalf("restore moved Restart now back to the hour-long schedule (%v)", hourLong)
	}
}

func TestRestoreOfAHoldRestartPastItsWindowDropsIt(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	deadline := g.clock.now().Add(40 * time.Minute)
	if err := a.rm.ScheduleWithOptions(30*time.Minute, deadline, "Firmware", "oem_update", RebootOptions{DeadlineAction: DeadlineActionHold}); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	stopAgent(a)
	g.clock.advance(time.Hour) // the window closed while the agent was down
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("a hold restart was restored after its window closed")
	}
	assertNothingArmed(t, b)
}

func TestRestoreIsANoOpWhenAScheduleIsAlreadyLive(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Old", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)
	b := g.manager()
	if err := b.rm.Schedule(10*time.Minute, g.clock.now().Add(10*time.Minute), "New", "manual"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if b.rm.RestorePendingReboot() {
		t.Fatal("restore replaced a live schedule")
	}
	if got := b.rm.State().Reason; got != "New" {
		t.Fatalf("live schedule reason = %q, want New", got)
	}
}

func TestRestoreDiscardsACorruptRecord(t *testing.T) {
	g := newRestoreRig(t)
	if err := os.WriteFile(g.ledger, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("restored from a corrupt record")
	}
	assertNothingArmed(t, b)
	if _, err := os.Stat(g.ledger); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("corrupt record left in place (stat err %v)", err)
	}
	// The manager still schedules normally afterwards.
	if err := b.rm.Schedule(10*time.Minute, g.clock.now().Add(10*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule after a corrupt record: %v", err)
	}
}

func TestRestoreDiscardsATamperedRecord(t *testing.T) {
	cases := map[string]func(r *PendingRebootRecord, l *DeferralLedger){
		"unknown version":           func(r *PendingRebootRecord, _ *DeferralLedger) { r.Version = 99 },
		"zero campaign":             func(r *PendingRebootRecord, _ *DeferralLedger) { r.Campaign = 0 },
		"no scheduled time":         func(r *PendingRebootRecord, _ *DeferralLedger) { r.ScheduledAt = time.Time{} },
		"restart a year out":        func(r *PendingRebootRecord, _ *DeferralLedger) { r.ScheduledAt = r.ScheduledAt.AddDate(1, 0, 0) },
		"deadline a year out":       func(_ *PendingRebootRecord, l *DeferralLedger) { l.Deadline = l.Deadline.AddDate(1, 0, 0) },
		"negative used":             func(_ *PendingRebootRecord, l *DeferralLedger) { l.Used = -1 },
		"used past the budget":      func(_ *PendingRebootRecord, l *DeferralLedger) { l.Used = 99 },
		"budget out of range":       func(r *PendingRebootRecord, _ *DeferralLedger) { r.MaxDeferrals = 1000 },
		"deferral minutes negative": func(r *PendingRebootRecord, _ *DeferralLedger) { r.DeferralMinutes = -5 },
		"unknown deadline action":   func(r *PendingRebootRecord, _ *DeferralLedger) { r.DeadlineAction = "explode" },
		"oversized reason":          func(r *PendingRebootRecord, _ *DeferralLedger) { r.Reason = string(make([]byte, 5000)) },
		"wrong boot":                func(r *PendingRebootRecord, _ *DeferralLedger) { r.BootID = "linux:someone-else" },
		"missing boot":              func(r *PendingRebootRecord, _ *DeferralLedger) { r.BootID = "" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			g := newRestoreRig(t)
			a := g.manager()
			if err := a.rm.ScheduleWithOptions(30*time.Minute, g.clock.now().Add(2*time.Hour), "Patch", "patch_job", allowDeferral(3, 30)); err != nil {
				t.Fatalf("ScheduleWithOptions: %v", err)
			}
			stopAgent(a)
			raw, err := os.ReadFile(g.ledger)
			if err != nil {
				t.Fatal(err)
			}
			var l DeferralLedger
			if err := json.Unmarshal(raw, &l); err != nil {
				t.Fatal(err)
			}
			if l.Pending == nil {
				t.Fatal("setup: no pending record written")
			}
			mutate(l.Pending, &l)
			raw, _ = json.Marshal(l)
			if err := os.WriteFile(g.ledger, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			b := g.manager()
			if b.rm.RestorePendingReboot() {
				t.Fatal("restored a tampered record")
			}
			assertNothingArmed(t, b)
		})
	}
}

func TestRestoreRefusesARecordOthersCouldWrite(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits; Windows relies on the data directory's protected ACL")
	}
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)
	if err := os.Chmod(g.ledger, 0o666); err != nil {
		t.Fatal(err)
	}
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("restored a record any local user could have written")
	}
	assertNothingArmed(t, b)
}

func TestPendingRecordIsWrittenOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits")
	}
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	info, err := os.Stat(g.ledger)
	if err != nil {
		t.Fatalf("no record written: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("record mode = %o, want 600", perm)
	}
}

// An older agent reads the same file as a plain deferral ledger: the pending
// section must not break that (downgrade mid-campaign).
func TestPendingRecordStaysReadableAsADeferralLedger(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	deadline := g.clock.now().Add(2 * time.Hour)
	if err := a.rm.ScheduleWithOptions(30*time.Minute, deadline, "Patch", "patch_job", allowDeferral(3, 30)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	if _, err := a.rm.Defer(); err != nil {
		t.Fatalf("Defer: %v", err)
	}
	raw, err := os.ReadFile(g.ledger)
	if err != nil {
		t.Fatal(err)
	}
	var old struct {
		Deadline time.Time `json:"deadline"`
		Used     int       `json:"used"`
	}
	if err := json.Unmarshal(raw, &old); err != nil {
		t.Fatalf("an older agent could not parse the file: %v", err)
	}
	if !old.Deadline.Equal(deadline) || old.Used != 1 {
		t.Fatalf("older agent reads deadline %v used %d, want %v and 1", old.Deadline, old.Used, deadline)
	}
}

func assertNothingArmed(t *testing.T, p restoreProc) {
	t.Helper()
	if st := p.rm.State(); st.RebootScheduled {
		t.Fatalf("a restart is scheduled at %v", st.ScheduledAt)
	}
	if offs := p.timers.offsets(); len(offs) != 0 {
		t.Fatalf("timers armed: %v", offs)
	}
}

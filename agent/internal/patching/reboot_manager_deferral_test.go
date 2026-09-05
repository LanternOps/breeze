// Deferral behaviour at the manager level (issue #3207).
//
// Kept in its own file so reboot_manager_test.go — the #3197 invariant suite —
// stays byte-for-byte unmodified: "with deferral disabled nothing changes" is
// only a real claim if those tests never had to be adjusted.
package patching

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

// fakeClock makes the deadline arithmetic exact instead of "within a few
// microseconds of time.Now()".
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// newDeferralTestManager wraps newTestManager with the two extra seams deferral
// needs: a temp-dir ledger path and a controllable clock.
func newDeferralTestManager(t *testing.T, maxPerDay int) (*RebootManager, *fakeTimers, *[]notifyCall, *[]time.Duration, *fakeClock, string) {
	t.Helper()
	rm, timers, notifications, osCalls := newTestManager(t, maxPerDay)
	dir := t.TempDir()
	ledger := filepath.Join(dir, "reboot_deferrals.json")
	clock := &fakeClock{t: time.Now().Truncate(time.Second)}
	rm.nowFn = clock.now
	rm.deferralLedger = func() string { return ledger }
	return rm, timers, notifications, osCalls, clock, ledger
}

func allowDeferral(max, minutes int) RebootOptions {
	return RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: max, DeferralMinutes: minutes}}
}

func TestScheduleKeepsDeferralOffByDefault(t *testing.T) {
	rm, _, _, _, clock, ledger := newDeferralTestManager(t, 3)

	if err := rm.Schedule(15*time.Minute, clock.now().Add(15*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	st := rm.State()
	if st.DeferralAllowed {
		t.Fatal("plain Schedule must not enable deferral — old call sites keep today's behaviour")
	}
	if st.MaxDeferrals != 0 || st.DeferralMinutes != 0 || st.DeferralsUsed != 0 {
		t.Errorf("deferral fields = %+v, want all zero", st)
	}
	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer must refuse when the policy did not enable it")
	}
	// Nothing may be written to disk for a schedule that cannot be deferred.
	if got := LoadDeferralLedger(ledger, clock.now().Add(15*time.Minute), clock.now()); got != 0 {
		t.Errorf("ledger read back %d, want 0 — deferral-off must not touch the ledger", got)
	}
}

// The deferral fields must reach the console through get_reboot_status, which
// marshals RebootState wholesale (rebootStateToMap) with no handler change.
func TestRebootStateSerialisesTheDeferralBudget(t *testing.T) {
	rm, _, _, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(3*time.Hour), "Patch", "patch_job", allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	data, err := json.Marshal(rm.State())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for key, want := range map[string]any{
		"deferralAllowed": true,
		"deferralsUsed":   float64(0),
		"maxDeferrals":    float64(2),
		"deferralMinutes": float64(60),
	} {
		if got[key] != want {
			t.Errorf("%s = %v, want %v", key, got[key], want)
		}
	}
}

func TestDeferReschedulesAndReNotifies(t *testing.T) {
	rm, timers, notifications, osCalls, clock, _ := newDeferralTestManager(t, 3)
	deadline := clock.now().Add(3 * time.Hour)
	if err := rm.ScheduleWithOptions(15*time.Minute, deadline, "Patch", "patch_job", allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	before := len(*notifications)

	newDelay, err := rm.Defer()
	if err != nil {
		t.Fatalf("Defer: %v", err)
	}
	// The 60-minute window is added to the 15-minute schedule, not to now — a
	// postponement pushes the restart out, it never pulls it in.
	if newDelay != 75*time.Minute {
		t.Errorf("newDelay = %v, want 75m (15m schedule + the 60m window)", newDelay)
	}
	st := rm.State()
	if st.DeferralsUsed != 1 {
		t.Errorf("DeferralsUsed = %d, want 1", st.DeferralsUsed)
	}
	if !st.RebootScheduled {
		t.Error("RebootScheduled = false after a deferral — the reboot must still be coming")
	}
	if !st.Deadline.Equal(deadline) {
		t.Errorf("Deadline = %v, want it unchanged at %v — a deferral may not move the hard stop", st.Deadline, deadline)
	}
	if want := clock.now().Add(75 * time.Minute); !st.ScheduledAt.Equal(want) {
		t.Errorf("ScheduledAt = %v, want %v", st.ScheduledAt, want)
	}
	// The re-schedule must emit its own lead notification (#3197 invariant:
	// the user is told, at offset 0, every time the countdown changes).
	timers.runAt(0)
	if len(*notifications) <= before {
		t.Error("deferral did not re-announce the new restart time")
	}
	if len(*osCalls) != 0 {
		t.Fatal("deferral must not invoke the OS reboot")
	}
}

func TestDeferRefusesPastTheBudget(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(3*time.Hour), "Patch", "patch_job", allowDeferral(1, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	if _, err := rm.Defer(); err != nil {
		t.Fatalf("first Defer: %v", err)
	}
	if _, err := rm.Defer(); err == nil {
		t.Fatal("second Defer must be refused at MaxDeferrals=1")
	}
	if got := rm.State().DeferralsUsed; got != 1 {
		t.Errorf("DeferralsUsed = %d after a refused deferral, want 1", got)
	}
}

// D5 / #3253: the deadline, not the counter, is the guarantee. A 60-minute
// window with 20 minutes of headroom yields 20, and the next request is refused
// because the clamp would leave less than MinRebootDelay.
func TestDeferClampsToTheHardDeadline(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	deadline := clock.now().Add(20 * time.Minute)
	if err := rm.ScheduleWithOptions(5*time.Minute, deadline, "Patch", "patch_job", allowDeferral(5, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)

	newDelay, err := rm.Defer()
	if err != nil {
		t.Fatalf("Defer: %v", err)
	}
	if newDelay != 20*time.Minute {
		t.Fatalf("newDelay = %v, want 20m clamped to the deadline", newDelay)
	}
	if landing := rm.State().ScheduledAt; landing.After(deadline) {
		t.Errorf("ScheduledAt %v is past the deadline %v", landing, deadline)
	}

	// Walk up to the deadline; the budget is nowhere near spent but there is no
	// room left, so the counter must not be able to buy any.
	clock.advance(20 * time.Minute)
	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer at the deadline must be refused even with postponements remaining")
	}
	if got := rm.State().DeferralsUsed; got != 1 {
		t.Errorf("DeferralsUsed = %d, want 1 — a refused deferral must not spend budget", got)
	}
}

func TestDeferDoesNotConsumeCircuitBreakerBudget(t *testing.T) {
	// D6: rebootHistory is appended only inside runOSReboot. Deferring must
	// leave the maxRebootsPerDay breaker completely untouched.
	rm, timers, _, osCalls, clock, _ := newDeferralTestManager(t, 1)
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	for i := 0; i < 3; i++ {
		if _, err := rm.Defer(); err != nil {
			t.Fatalf("Defer %d: %v", i, err)
		}
	}
	if got := len(rm.rebootHistory); got != 0 {
		t.Fatalf("rebootHistory has %d entries after three deferrals, want 0", got)
	}
	// Budget exhausted; let the final schedule run to completion. Each
	// postponement adds its window to the schedule: 15 -> 75 -> 135 -> 195.
	plan := PlanReboot(195 * time.Minute)
	timers.runAt(plan.OSInvokeAt)
	if len(*osCalls) != 1 {
		t.Fatalf("osCalls = %d, want 1 — three deferrals must not have burned the breaker", len(*osCalls))
	}
}

func TestDeferIsRefusedOnceTheOSCountdownHasStarted(t *testing.T) {
	// After OSInvokeAt the countdown lives in the OS, not this process. Granting
	// a deferral there would report success while the machine still went down.
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(5*time.Minute, clock.now().Add(3*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	plan := PlanReboot(5 * time.Minute)
	timers.runAt(plan.OSInvokeAt)
	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer must be refused once the OS countdown is running")
	}
}

func TestDeferIsRefusedWhenNothingIsScheduled(t *testing.T) {
	rm, _, _, _, clock, _ := newDeferralTestManager(t, 3)
	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer with no schedule must be refused")
	}

	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(3*time.Hour), "Patch", "patch_job", allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	if err := rm.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer after Cancel must be refused")
	}

	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(3*time.Hour), "Patch", "patch_job", allowDeferral(2, 60)); err != nil {
		t.Fatalf("re-ScheduleWithOptions: %v", err)
	}
	rm.Stop()
	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer after Stop must be refused")
	}
}

// A later plain Schedule is a fresh administrator decision with no deferral
// budget: the previous campaign's allowance must not survive it.
func TestPlainRescheduleClearsTheDeferralBudget(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(3*time.Hour), "Patch", "patch_job", allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	if _, err := rm.Defer(); err != nil {
		t.Fatalf("Defer: %v", err)
	}

	if err := rm.Schedule(30*time.Minute, clock.now().Add(3*time.Hour), "Second", "manual"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	st := rm.State()
	if st.DeferralAllowed || st.MaxDeferrals != 0 || st.DeferralsUsed != 0 {
		t.Fatalf("deferral state after a plain re-Schedule = %+v, want cleared", st)
	}
	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer must be refused after a plain re-Schedule")
	}
}

// The count has to survive an agent restart, or a user could reboot the service
// and postpone forever. Same campaign (same deadline) resumes; a new deadline
// is a new administrator decision and legitimately starts fresh.
func TestScheduleResumesTheLedgerForTheSameCampaign(t *testing.T) {
	rm, timers, _, _, clock, ledgerPath := newDeferralTestManager(t, 3)
	deadline := clock.now().Add(4 * time.Hour)
	if err := rm.ScheduleWithOptions(15*time.Minute, deadline, "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	for i := 0; i < 2; i++ {
		if _, err := rm.Defer(); err != nil {
			t.Fatalf("Defer %d: %v", i, err)
		}
	}
	if got := LoadDeferralLedger(ledgerPath, deadline, clock.now()); got != 2 {
		t.Fatalf("ledger on disk = %d, want 2", got)
	}

	// A fresh manager over the same ledger: same campaign resumes the count.
	restarted, _, _, _ := newTestManager(t, 3)
	restarted.nowFn = clock.now
	restarted.deferralLedger = func() string { return ledgerPath }
	if err := restarted.ScheduleWithOptions(15*time.Minute, deadline, "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatalf("restarted ScheduleWithOptions: %v", err)
	}
	if got := restarted.State().DeferralsUsed; got != 2 {
		t.Fatalf("resumed DeferralsUsed = %d, want 2 — restarting the agent must not refill the budget", got)
	}
	if _, err := restarted.Defer(); err != nil {
		t.Fatalf("third Defer: %v", err)
	}
	if _, err := restarted.Defer(); err == nil {
		t.Fatal("fourth Defer must be refused — the resumed count exhausted the budget")
	}

	// A different deadline is a different campaign: fresh budget.
	other, _, _, _ := newTestManager(t, 3)
	other.nowFn = clock.now
	other.deferralLedger = func() string { return ledgerPath }
	if err := other.ScheduleWithOptions(15*time.Minute, deadline.Add(time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatalf("other ScheduleWithOptions: %v", err)
	}
	if got := other.State().DeferralsUsed; got != 0 {
		t.Errorf("new-campaign DeferralsUsed = %d, want 0", got)
	}
}

// W3 fans the prompt out to every helper session and takes the first answer, so
// two sessions can answer at once. Concurrent grants must never exceed the
// budget.
func TestConcurrentDefersRespectTheBudget(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(6*time.Hour), "Patch", "patch_job", allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)

	const callers = 8
	var wg sync.WaitGroup
	var mu sync.Mutex
	granted := 0
	wg.Add(callers)
	for i := 0; i < callers; i++ {
		go func() {
			defer wg.Done()
			if _, err := rm.Defer(); err == nil {
				mu.Lock()
				granted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if granted != 2 {
		t.Fatalf("%d concurrent Defer calls granted %d, want exactly 2 (MaxDeferrals)", callers, granted)
	}
	if got := rm.State().DeferralsUsed; got != 2 {
		t.Errorf("DeferralsUsed = %d, want 2", got)
	}
}

// A postponement must never resurrect a reboot an operator has cancelled.
// Cancel and Defer race whenever a technician cancels from the console while
// the signed-in user is answering the prompt, and Defer re-schedules — so if
// Defer's checks and its re-schedule are not one atomic step, the cancelled
// reboot comes back with a fresh countdown.
//
// The invariant is decidable regardless of which goroutine wins: Cancel here
// always has something to cancel, so it always succeeds, and a successful
// Cancel must leave nothing scheduled. Either Defer finished first (and Cancel
// then cancelled the deferred schedule) or Cancel finished first (and Defer
// must refuse).
func TestDeferNeverResurrectsACancelledReboot(t *testing.T) {
	for i := 0; i < 300; i++ {
		rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
		if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(6*time.Hour), "Patch", "patch_job", allowDeferral(5, 60)); err != nil {
			t.Fatalf("iteration %d: ScheduleWithOptions: %v", i, err)
		}
		timers.runAt(0)

		var wg sync.WaitGroup
		var cancelErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			cancelErr = rm.Cancel()
		}()
		go func() {
			defer wg.Done()
			_, _ = rm.Defer()
		}()
		wg.Wait()

		if cancelErr != nil {
			t.Fatalf("iteration %d: Cancel: %v", i, cancelErr)
		}
		if st := rm.State(); st.RebootScheduled {
			t.Fatalf("iteration %d: a cancelled reboot was resurrected by a concurrent Defer: %+v", i, st)
		}
	}
}

// A postponement must never make the restart happen SOONER. With a policy
// window shorter than the remaining countdown — a 2-hour reboot delay and a
// 60-minute postponement, both well inside the configurable ranges — computing
// the new delay from "now" rather than from the scheduled time pulls the
// restart an hour forward. The user pressed Postpone and lost an hour.
//
// It also has to agree with the deadline the API derives
// (scheduledAt + maxDeferrals * deferralMinutes, see patchRebootHandler.ts):
// spending the whole budget must land exactly on the deadline, not short of it.
func TestDeferNeverPullsTheRestartEarlier(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	start := clock.now()
	// Exactly what the API sends for a 120-minute delay with 2 x 60m deferrals.
	deadline := start.Add(120*time.Minute + 2*60*time.Minute)
	if err := rm.ScheduleWithOptions(120*time.Minute, deadline, "Patch", "patch_job", allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	firstScheduledAt := rm.State().ScheduledAt

	newDelay, err := rm.Defer()
	if err != nil {
		t.Fatalf("Defer: %v", err)
	}
	if newDelay != 180*time.Minute {
		t.Errorf("newDelay = %v, want 180m (the scheduled 120m pushed out by the 60m window)", newDelay)
	}
	afterFirst := rm.State().ScheduledAt
	if !afterFirst.After(firstScheduledAt) {
		t.Fatalf("postponing moved the restart from %v to %v — a postponement must never pull it earlier",
			firstScheduledAt, afterFirst)
	}

	// The second and last postponement must land exactly on the deadline.
	if _, err := rm.Defer(); err != nil {
		t.Fatalf("second Defer: %v", err)
	}
	afterSecond := rm.State().ScheduledAt
	if !afterSecond.After(afterFirst) {
		t.Errorf("second postponement moved the restart from %v to %v", afterFirst, afterSecond)
	}
	if !afterSecond.Equal(deadline) {
		t.Errorf("after spending the whole budget ScheduledAt = %v, want the deadline %v", afterSecond, deadline)
	}
	if _, err := rm.Defer(); err == nil {
		t.Error("a third Defer must be refused at MaxDeferrals=2")
	}
}

// The on-disk count must never lag the in-memory one. If it can, the user gets
// back a postponement they already spent the next time the agent restarts.
// Measured before the ledger write was moved inside the lock: 141 of 300 trials
// disagreed. It is now written in the same critical section as the increment,
// so the two cannot diverge.
func TestConcurrentDefersLeaveTheLedgerAgreeingWithMemory(t *testing.T) {
	for i := 0; i < 50; i++ {
		rm, timers, _, _, clock, ledgerPath := newDeferralTestManager(t, 3)
		deadline := clock.now().Add(12 * time.Hour)
		if err := rm.ScheduleWithOptions(15*time.Minute, deadline, "Patch", "patch_job", allowDeferral(4, 60)); err != nil {
			t.Fatalf("iteration %d: ScheduleWithOptions: %v", i, err)
		}
		timers.runAt(0)

		var wg sync.WaitGroup
		wg.Add(4)
		for j := 0; j < 4; j++ {
			go func() {
				defer wg.Done()
				_, _ = rm.Defer()
			}()
		}
		wg.Wait()

		inMemory := rm.State().DeferralsUsed
		onDisk := LoadDeferralLedger(ledgerPath, deadline, clock.now())
		if onDisk != inMemory {
			t.Fatalf("iteration %d: ledger says %d postponements used, memory says %d — a restart would refill the budget",
				i, onDisk, inMemory)
		}
	}
}

// The ledger is best-effort by contract: a write failure must be logged and
// swallowed, never turned into a refused postponement. A mutation that
// propagated the error would strand the user with an un-postponable restart
// because of a permissions problem in the data dir.
func TestDeferSucceedsWhenTheLedgerCannotBeWritten(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory mode bits do not gate writes the same way on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("running as root, which ignores the directory mode that makes the write fail")
	}
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	dir := t.TempDir()
	readOnly := filepath.Join(dir, "locked")
	if err := os.Mkdir(readOnly, 0o500); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	rm.deferralLedger = func() string { return filepath.Join(readOnly, "reboot_deferrals.json") }

	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(6*time.Hour), "Patch", "patch_job", allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)

	newDelay, err := rm.Defer()
	if err != nil {
		t.Fatalf("Defer returned %v; an unwritable ledger must not refuse the postponement", err)
	}
	if newDelay != 75*time.Minute {
		t.Errorf("newDelay = %v, want 75m", newDelay)
	}
	if got := rm.State().DeferralsUsed; got != 1 {
		t.Errorf("DeferralsUsed = %d, want 1 — the in-memory count still holds for this process", got)
	}
}

// Cancel clears the reported budget, not just the schedule. A console showing a
// cancelled restart must not still advertise postponements against it.
func TestCancelClearsTheReportedDeferralBudget(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(6*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	if _, err := rm.Defer(); err != nil {
		t.Fatalf("Defer: %v", err)
	}
	if err := rm.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	st := rm.State()
	if st.DeferralAllowed || st.MaxDeferrals != 0 || st.DeferralMinutes != 0 || st.DeferralsUsed != 0 {
		t.Errorf("deferral fields after Cancel = allowed:%v used:%d max:%d window:%d, want all zero",
			st.DeferralAllowed, st.DeferralsUsed, st.MaxDeferrals, st.DeferralMinutes)
	}
}

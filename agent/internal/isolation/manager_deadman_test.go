package isolation

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/wire"
)

// Dead-man opt-in (#10103, plan W4d, spec §3.6 item 5). The window counts the
// time the agent ran without authenticated control-plane contact: a monotonic
// count advanced tick by tick, so a wall-clock change cannot move it, sleep does
// not count, and a restart starts it again.

const deadManWindow = 15 * time.Minute

// isolateDeadMan applies an episode whose spec carries a dead-man window.
func (h *harness) isolateDeadMan(id string, gen int, window time.Duration) {
	h.t.Helper()
	p := h.payload(id, gen, 72*time.Hour)
	params(p)["deadManSeconds"] = float64(window / time.Second)
	out := h.m.HandleIsolate(context.Background(), p)
	if out.Failed() || out.Result == nil || out.Result.State != StateVerified {
		h.t.Fatalf("isolate %s with dead-man %v: %+v (result %+v)", id, window, out, out.Result)
	}
}

// tickFor runs one tick per step until d has passed.
func (h *harness) tickFor(d, step time.Duration) {
	h.t.Helper()
	for elapsed := time.Duration(0); elapsed < d; elapsed += step {
		h.clock.Advance(step)
		h.m.Tick(context.Background())
	}
}

func (h *harness) selfReleased() bool {
	h.t.Helper()
	j := h.journal()
	return j.Phase == journal.PhaseReleased && j.Episode != nil && j.Episode.State == StateSelfReleased
}

func eventCount(j *journal.Journal, typ string) int {
	n, _ := countEvents(j, typ)
	return n
}

func TestDeadManZeroNeverSelfReleases(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.tickFor(6*time.Hour, 2*time.Minute)
	if j := h.journal(); j.Phase != journal.PhaseCommitted || eventCount(j, "released_dead_man") != 0 {
		t.Fatalf("a zero window released: phase %s events %v", j.Phase, eventTypes(j))
	}
	if !h.m.Active() || h.log.count("iso:Release") != 0 {
		t.Fatal("rules removed with the dead-man off")
	}
}

func TestDeadManReleasesOncePastTheWindow(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	if got := h.journal().Episode.DeadManSeconds; got != int(deadManWindow/time.Second) {
		t.Fatalf("journalled window %d", got)
	}
	h.tickFor(deadManWindow-time.Minute, time.Minute)
	if h.selfReleased() || !h.m.Active() {
		t.Fatal("released before the window passed")
	}
	h.tickFor(2*time.Minute, time.Minute)
	if !h.selfReleased() {
		j := h.journal()
		t.Fatalf("not self-released past the window: phase %s state %s", j.Phase, j.Episode.State)
	}
	if installed, _, _ := h.iso.state(); installed || h.m.Active() {
		t.Fatal("rules still installed after the dead-man release")
	}
	// Exactly once: further ticks, contact and a re-sent desired state change nothing.
	h.tickFor(time.Hour, 5*time.Minute)
	h.m.NoteControlPlaneContact()
	h.m.Reconcile(context.Background(), h.desired(idA, 1, DesiredIsolated, 72*time.Hour, true))
	h.m.Reconcile(context.Background(), h.desired(idA, 2, DesiredIsolated, 72*time.Hour, true))
	j := h.journal()
	if got := eventCount(j, "released_dead_man"); got != 1 {
		t.Fatalf("released_dead_man journalled %d times: %v", got, eventTypes(j))
	}
	if got := h.log.count("iso:Release"); got != 1 {
		t.Fatalf("Release called %d times", got)
	}
	if h.iso.applies != 1 {
		t.Fatalf("re-applied after the dead-man release (%d applies)", h.iso.applies)
	}
	r := h.m.Report()
	if r == nil || r.State != StateSelfReleased || r.IsolationID != idA || !containsReportEvent(r, "released_dead_man") {
		t.Fatalf("report %+v", r)
	}
	if j.PendingReport == nil || j.PendingReport.State != StateSelfReleased {
		t.Fatalf("pending report %+v", j.PendingReport)
	}
}

func containsReportEvent(r *Report, typ string) bool {
	for _, e := range r.Events {
		if e.Type == typ {
			return true
		}
	}
	return false
}

func TestDeadManContactRestartsTheWindow(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	h.tickFor(10*time.Minute, time.Minute)
	h.m.NoteControlPlaneContact()
	h.tickFor(10*time.Minute, time.Minute)
	if h.selfReleased() {
		t.Fatal("contact did not restart the window")
	}
	h.tickFor(6*time.Minute, time.Minute)
	if !h.selfReleased() {
		t.Fatal("no release a full window after the last contact")
	}
}

// A successful positive probe is authenticated contact too.
func TestDeadManVerifyRoundTripCountsAsContact(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	h.tickFor(10*time.Minute, time.Minute)
	before := h.log.count("verify ")
	// A changed address re-applies through a verified refresh (within one
	// re-verify interval), which runs the round trip.
	h.lookup.set(controlHost, "192.0.2.11", "2001:db8::11")
	h.tickFor(12*time.Minute, time.Minute)
	if h.log.count("verify ") == before {
		t.Fatal("no round trip ran")
	}
	if h.selfReleased() {
		t.Fatal("a verified round trip did not count as contact")
	}
}

// Sleep is not time without contact: the gap between ticks is not counted, and
// the device gets a grace period after waking to reach the control plane.
func TestDeadManSleepDoesNotCount(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	h.tickFor(14*time.Minute, time.Minute)
	h.clock.Advance(3 * time.Hour) // asleep (TTL is 72 h)
	h.m.Tick(context.Background())
	if h.selfReleased() {
		t.Fatal("released on the first tick after waking")
	}
	h.tickFor(DeadManWakeGrace-time.Minute, time.Minute)
	if h.selfReleased() {
		t.Fatal("released inside the wake grace")
	}
	h.tickFor(2*time.Minute, time.Minute)
	if !h.selfReleased() {
		t.Fatal("no release once the grace passed without contact")
	}
}

func TestDeadManContactDuringWakeGraceHolds(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	h.tickFor(14*time.Minute, time.Minute)
	h.clock.Advance(3 * time.Hour)
	h.m.Tick(context.Background())
	h.tickFor(2*time.Minute, time.Minute)
	h.m.NoteControlPlaneContact()
	h.tickFor(deadManWindow-time.Minute, time.Minute)
	if h.selfReleased() {
		t.Fatal("released although the device reached the control plane after waking")
	}
}

// The wall clock never feeds the window: a jump forward does not fire it early,
// a jump backward does not hold it off.
func TestDeadManIgnoresWallClockJumps(t *testing.T) {
	t.Run("forward", func(t *testing.T) {
		h := newHarness(t)
		h.isolateDeadMan(idA, 1, deadManWindow)
		h.tickFor(5*time.Minute, time.Minute)
		h.clock.SetWall(h.clock.Now().Add(24 * time.Hour)) // still before expiry
		h.tickFor(5*time.Minute, time.Minute)
		if h.selfReleased() {
			t.Fatal("a forward wall-clock jump fired the dead-man")
		}
	})
	t.Run("backward", func(t *testing.T) {
		h := newHarness(t)
		h.isolateDeadMan(idA, 1, deadManWindow)
		h.tickFor(5*time.Minute, time.Minute)
		h.clock.SetWall(h.clock.Now().Add(-30 * 24 * time.Hour))
		h.tickFor(11*time.Minute, time.Minute)
		if !h.selfReleased() {
			t.Fatal("a backward wall-clock jump held the dead-man off")
		}
	})
}

// A monotonic reading that goes backwards is treated like a gap, never as time
// without contact.
func TestDeadManMonotonicGoingBackwardsIsAGap(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	h.tickFor(14*time.Minute, time.Minute)
	h.clock.mu.Lock()
	h.clock.mono -= 10 * time.Minute
	h.clock.mu.Unlock()
	h.m.Tick(context.Background())
	h.tickFor(DeadManWakeGrace-time.Minute, time.Minute)
	if h.selfReleased() {
		t.Fatal("a monotonic step backwards fired the dead-man")
	}
}

// An agent restart starts the count again; it never resumes into a release.
func TestDeadManRestartStartsTheCountAgain(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	h.tickFor(14*time.Minute, time.Minute)
	h.m = h.newManager()
	h.m.Startup(context.Background())
	h.tickFor(14*time.Minute, time.Minute)
	if h.selfReleased() {
		t.Fatal("a restart carried the count into an early release")
	}
	h.tickFor(2*time.Minute, time.Minute)
	if !h.selfReleased() {
		t.Fatal("no release a full window after the restart")
	}
}

// A failed release is retried as the same dead-man release, not fired again.
func TestDeadManReleaseFailureRetriesOnce(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	h.iso.set(func(f *fakeIsolator) { f.releaseErr = errors.New("engine busy") })
	h.tickFor(deadManWindow+time.Minute, time.Minute)
	j := h.journal()
	if j.Phase != journal.PhaseReleasing {
		t.Fatalf("phase %s after a failed release", j.Phase)
	}
	h.iso.set(func(f *fakeIsolator) { f.releaseErr = nil })
	h.tickFor(3*time.Minute, time.Minute)
	j = h.journal()
	if !h.selfReleased() || eventCount(j, "released_dead_man") != 1 {
		t.Fatalf("phase %s events %v", j.Phase, eventTypes(j))
	}
	for _, e := range j.Events {
		if e.Type == "releasing" && e.Detail != ReleaseDeadMan {
			t.Fatalf("release re-classified as %q", e.Detail)
		}
	}
}

// The window is fixed for the episode at apply: a later block cannot change it.
func TestDeadManWindowPinnedForTheEpisode(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	for _, gen := range []int{1, 2} {
		d := h.desired(idA, gen, DesiredIsolated, 72*time.Hour, true)
		d.NetworkIsolation.DeadManSeconds = 0
		h.m.Reconcile(context.Background(), d)
		if got := h.journal().Episode.DeadManSeconds; got != int(deadManWindow/time.Second) {
			t.Fatalf("generation %d changed the window to %d", gen, got)
		}
	}
	h2 := newHarness(t)
	h2.mustIsolate(idA, 1)
	d := h2.desired(idA, 2, DesiredIsolated, 72*time.Hour, true)
	d.NetworkIsolation.DeadManSeconds = int(deadManWindow / time.Second)
	h2.m.Reconcile(context.Background(), d)
	if got := h2.journal().Episode.DeadManSeconds; got != 0 {
		t.Fatalf("an extend turned the dead-man on (%d)", got)
	}
	h2.tickFor(2*deadManWindow, time.Minute)
	if h2.selfReleased() {
		t.Fatal("an episode applied without a dead-man self-released")
	}
}

// --force and the break-glass code keep working while a dead-man counts down.
func TestDeadManLeavesLocalReleaseWorking(t *testing.T) {
	h := newHarness(t)
	h.isolateDeadMan(idA, 1, deadManWindow)
	h.tickFor(10*time.Minute, time.Minute)
	if err := h.m.LocalRelease(context.Background(), "", true); err != nil {
		t.Fatalf("--force: %v", err)
	}
	h.tickFor(deadManWindow, time.Minute)
	j := h.journal()
	if j.Episode.State != StateReleasedLocally || eventCount(j, "released_dead_man") != 0 {
		t.Fatalf("state %s events %v", j.Episode.State, eventTypes(j))
	}
}

func TestDeadManSpecBounds(t *testing.T) {
	h := newHarness(t)
	for _, secs := range []float64{1, 60, 899, 86401, -1} {
		p := h.payload(idA, 1, 72*time.Hour)
		params(p)["deadManSeconds"] = secs
		if out := h.m.HandleIsolate(context.Background(), p); out.ErrorCode != wire.ErrCodeIsolationInvalidSpec {
			t.Fatalf("deadManSeconds %v: code %q (%s)", secs, out.ErrorCode, out.Error)
		}
	}
	if h.iso.applies != 0 {
		t.Fatal("an out-of-range window was applied")
	}
	for _, secs := range []int{DeadManMinSeconds, DeadManMaxSeconds} {
		s := Spec{IsolationID: idA, Generation: 1, ExpiresAt: h.clock.Now().Add(time.Hour), DeadManSeconds: secs, Allow: h.allow()}
		if err := validateSpec(&s, h.clock.Now()); err != nil {
			t.Fatalf("deadManSeconds %d refused: %v", secs, err)
		}
	}
}

func TestDeadManAdvertisedOnlyWhenIsolationIs(t *testing.T) {
	if (Capability{Version: 0}).AdvertisesDeadMan() {
		t.Fatal("a build that cannot isolate advertises the dead-man")
	}
	if !(Capability{Version: CapabilityBase}).AdvertisesDeadMan() {
		t.Fatal("a build that can isolate does not advertise the dead-man")
	}
	// The numeric level stays independent of the dead-man flag (decision 28).
	if (Capability{Version: CapabilityBase}).AdvertisedVersion() != CapabilityReleaseToken {
		t.Fatal("advertised level changed")
	}
}

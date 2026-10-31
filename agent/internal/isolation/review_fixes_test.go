package isolation

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/wire"
)

// A build without an isolator (capability 0) that inherits a committed
// episode must never confirm absence it cannot observe: the release stays
// unresolved and recovery stays armed.
func TestUnsupportedBuildNeverConfirmsRelease(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.clock.Advance(72 * time.Hour)
	inert := NewManager(ManagerDeps{
		Isolator: unsupportedIsolator{}, Scheduler: h.sched, DataDir: h.dir,
		Resolver: NewResolver(h.lookup.lookup), VerifyRoundTrip: h.verify.call,
		Clock: h.clock, Dialer: h.dialer,
	})
	inert.Tick(context.Background())
	j := h.journal()
	if j.Phase != journal.PhaseReleasing {
		t.Fatalf("phase %s; a capability-0 build confirmed a release it cannot observe", j.Phase)
	}
	if h.log.count("sched:RemoveAll") != 0 {
		t.Fatal("recovery tasks removed although absence was never confirmed")
	}
}

func TestResolverBoundsSlowLookups(t *testing.T) {
	prevHost, prevAll := resolveHostTimeout, resolveTotalTimeout
	resolveHostTimeout, resolveTotalTimeout = 50*time.Millisecond, 150*time.Millisecond
	t.Cleanup(func() { resolveHostTimeout, resolveTotalTimeout = prevHost, prevAll })

	var calls atomic.Int32
	hang := func(ctx context.Context, host string) ([]netip.Addr, error) {
		calls.Add(1)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	r := NewResolver(hang)
	r.Seed(controlHost, addrs("192.0.2.10"))
	start := time.Now()
	got, err := r.Resolve(context.Background(), []string{controlHost})
	if err != nil || len(got[controlHost]) != 1 {
		t.Fatalf("a hung lookup did not fall back to the last-known-good set: %v %v", got, err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("one hung lookup took %v", d)
	}

	hosts := []string{"a.example.test", "b.example.test", "c.example.test", "d.example.test", "e.example.test", "f.example.test"}
	start = time.Now()
	_, err = r.Resolve(context.Background(), hosts)
	if err == nil {
		t.Fatal("hung lookups with no history must fail")
	}
	if d := time.Since(start); d > 600*time.Millisecond {
		t.Fatalf("six hung lookups took %v; the total cap did not bound them", d)
	}
}

// An orphan cleanup has no episode id, so its report fits neither server
// shape: it must be omitted, never sent as "nothing installed".
func TestReportOmittedWhileOrphanCleanupPending(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	if err := os.Remove(filepath.Join(h.dir, journal.FileName)); err != nil {
		t.Fatal(err)
	}
	h.iso.set(func(f *fakeIsolator) { f.releaseErr = errors.New("engine busy") })
	h.m = h.newManager()
	h.m.Startup(context.Background())
	if j := h.journal(); j.Phase != journal.PhaseReleasing || j.Episode != nil {
		t.Fatalf("expected a pending orphan cleanup, got %s %+v", j.Phase, j.Episode)
	}
	if r := h.m.Report(); r != nil {
		t.Fatalf("report %+v during an orphan cleanup; want nil", r)
	}
	h.iso.set(func(f *fakeIsolator) { f.releaseErr = nil })
	h.m.Tick(context.Background())
	if r := h.m.Report(); r == nil || r.Phase != journal.PhaseNone || r.IsolationID != "" {
		t.Fatalf("after cleanup: %+v", r)
	}
}

// A journal write failure after rules went in removes them (the commit could
// not be recorded) and reports mechanism_unavailable.
func TestManagerJournalWriteFailureRemovesUncommittedRules(t *testing.T) {
	h := newHarness(t)
	h.m.saveJournal = func(path string, j *journal.Journal) error {
		if j.Phase == journal.PhaseCommitted {
			return errors.New("disk full")
		}
		return journal.Save(path, j)
	}
	out := h.isolate(idA, 1)
	if out.ErrorCode != wire.ErrCodeIsolationMechanismUnavailable {
		t.Fatalf("outcome %+v", out)
	}
	if installed, _, _ := h.iso.state(); installed {
		t.Fatal("rules left installed when the commit could not be journalled")
	}
}

func TestManagerOnResumeEvaluatesExpiry(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.clock.Advance(73 * time.Hour) // slept through the expiry
	h.m.OnResume(context.Background())
	if j := h.journal(); j.Phase != journal.PhaseReleased || j.Episode.State != StateExpired {
		t.Fatalf("after resume: %s %+v", j.Phase, j.Episode)
	}
}

func TestManagerRetriesFailedExpiryArm(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.sched.set(func(s *fakeScheduler) { s.armExpiryErr = errors.New("task scheduler busy") })
	if out := h.m.HandleIsolate(context.Background(), h.payload(idA, 2, 100*time.Hour)); out.Failed() {
		t.Fatalf("extend %+v", out)
	}
	h.sched.set(func(s *fakeScheduler) { s.armExpiryErr = nil; s.expiry = nil })
	h.clock.Advance(time.Minute) // before the re-verify interval
	h.m.Tick(context.Background())
	h.sched.mu.Lock()
	defer h.sched.mu.Unlock()
	if len(h.sched.expiry) != 1 || h.sched.expiry[0].gen != 2 {
		t.Fatalf("failed expiry arm not retried on the next tick: %+v", h.sched.expiry)
	}
}

// A refresh whose revert to the prior rules also fails forces a re-verify
// on the very next tick instead of waiting out the interval.
func TestManagerFailedRevertForcesReverify(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.lookup.set(controlHost, "192.0.2.77")
	h.verify.set(func(v *fakeVerify) { v.err = errors.New("unreachable") })
	h.iso.set(func(f *fakeIsolator) { f.failApplyN = 3 }) // 1 = apply, 2 = refresh, 3 = revert
	h.clock.Advance(ReverifyInterval)
	h.m.Tick(context.Background())
	h.log.reset()
	h.clock.Advance(time.Minute)
	h.m.Tick(context.Background())
	if h.log.count("iso:Verify") == 0 {
		t.Fatal("a failed revert did not force a re-verify on the next tick")
	}
}

// The clock never mixes time bases: once the OS monotonic clock fails, the
// boot identity switches with it, so the monotonic expiry clause is never
// applied across the two.
func TestLatchingClockSwitchesBootWithMono(t *testing.T) {
	var fail atomic.Bool
	c := newLatchingClock(func() (time.Duration, bool) {
		if fail.Load() {
			return 0, false
		}
		return 500 * time.Hour, true
	}, func() string { return "linux:boot-a" })
	if c.BootID() != "linux:boot-a" || c.Mono() != 500*time.Hour {
		t.Fatalf("healthy clock: %q %v", c.BootID(), c.Mono())
	}
	fail.Store(true)
	m := c.Mono()
	if m >= 500*time.Hour {
		t.Fatalf("degraded Mono %v still on the OS base", m)
	}
	if c.BootID() == "linux:boot-a" {
		t.Fatal("boot ID unchanged after the monotonic clock degraded")
	}
	fail.Store(false)
	if c.BootID() == "linux:boot-a" {
		t.Fatal("the clock un-latched; it must stay on the process base")
	}

	// A caller that asks for BootID first must not get the OS boot ID paired
	// with a process-relative Mono read a moment later.
	var fail2 atomic.Bool
	c2 := newLatchingClock(func() (time.Duration, bool) {
		if fail2.Load() {
			return 0, false
		}
		return 500 * time.Hour, true
	}, func() string { return "linux:boot-b" })
	fail2.Store(true)
	if c2.BootID() == "linux:boot-b" {
		t.Fatal("BootID reported the OS boot while the monotonic clock is failing")
	}
}

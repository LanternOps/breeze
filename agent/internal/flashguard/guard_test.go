package flashguard

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

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

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 11, 5, 1, 0, 0, 0, time.UTC)}
}

func newGuard(t *testing.T, clock *fakeClock) *Guard {
	t.Helper()
	return New(t.TempDir(), WithClock(clock.now), WithLockWait(50*time.Millisecond))
}

func mustEnter(t *testing.T, g *Guard, ttl time.Duration) func() error {
	t.Helper()
	release, err := g.Enter("bios", "cmd-1", ttl)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	return release
}

func TestNoSectionIsANoOp(t *testing.T) {
	g := newGuard(t, newFakeClock())
	if s, ok := g.Active(); ok {
		t.Fatalf("Active with nothing entered = %+v", s)
	}
	done, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("AdmitPowerAction with no section: %v", err)
	}
	done()
	done() // release is idempotent
	// A second admission proves the first really let go.
	again, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("second AdmitPowerAction: %v", err)
	}
	again()
}

func TestSectionSurvivesProcessRestart(t *testing.T) {
	clock := newFakeClock()
	dir := t.TempDir()
	first := New(dir, WithClock(clock.now))
	if _, err := first.Enter("firmware", "cmd-9", time.Hour); err != nil {
		t.Fatalf("Enter: %v", err)
	}

	restarted := New(dir, WithClock(clock.now))
	s, ok := restarted.Active()
	if !ok {
		t.Fatal("a guard built after a restart must see the section")
	}
	if s.Kind != "firmware" || s.CommandID != "cmd-9" {
		t.Fatalf("section = %+v", s)
	}
	if !s.ExpiresAt.Equal(clock.now().Add(time.Hour)) {
		t.Fatalf("ExpiresAt = %v", s.ExpiresAt)
	}
	if _, err := restarted.AdmitPowerAction("reboot"); !errors.Is(err, ErrFlashInProgress) {
		t.Fatalf("admit after restart = %v, want ErrFlashInProgress", err)
	}
}

func TestExpiredSectionClearsOnRead(t *testing.T) {
	clock := newFakeClock()
	g := newGuard(t, clock)
	mustEnter(t, g, time.Hour)

	clock.advance(time.Hour)
	if s, ok := g.Active(); ok {
		t.Fatalf("a section at ExpiresAt counts as inactive, got %+v", s)
	}
	if _, err := os.Stat(filepath.Join(g.dir, sectionFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired section file should be cleared, stat err = %v", err)
	}
	done, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("admit after expiry: %v", err)
	}
	done()
}

func TestTTLIsCappedSoACrashCannotBlockRebootsForever(t *testing.T) {
	clock := newFakeClock()
	g := newGuard(t, clock)
	mustEnter(t, g, 24*time.Hour)

	s, ok := g.Active()
	if !ok {
		t.Fatal("section should be active")
	}
	if got := s.ExpiresAt.Sub(s.StartedAt); got != MaxTTL {
		t.Fatalf("TTL = %v, want the %v ceiling", got, MaxTTL)
	}
	clock.advance(MaxTTL)
	if _, ok := g.Active(); ok {
		t.Fatal("a section must not outlive MaxTTL")
	}
}

// The file is the cross-process channel, so what it says is bounded on read too.
func TestAFarFutureExpiryOnDiskIsStillCapped(t *testing.T) {
	clock := newFakeClock()
	g := newGuard(t, clock)
	writeRawSection(t, g, Section{Kind: "bios", CommandID: "cmd-1", StartedAt: clock.now(), ExpiresAt: clock.now().Add(1000 * time.Hour)})

	if _, ok := g.Active(); !ok {
		t.Fatal("a section inside MaxTTL of its start is active")
	}
	clock.advance(MaxTTL)
	if _, ok := g.Active(); ok {
		t.Fatal("ExpiresAt on disk must not extend a section past MaxTTL")
	}
}

// A clock wound back must not hold reboots for as long as it was wound.
func TestASectionFromTheFutureIsNotHonoured(t *testing.T) {
	clock := newFakeClock()
	g := newGuard(t, clock)
	start := clock.now().Add(100 * 24 * time.Hour)
	writeRawSection(t, g, Section{Kind: "bios", CommandID: "cmd-1", StartedAt: start, ExpiresAt: start.Add(time.Hour)})

	if s, ok := g.Active(); ok {
		t.Fatalf("section started 100 days from now should not block, got %+v", s)
	}
}

// An atomic write cannot tear, so a corrupt file means something unexpected
// happened. It may be a live flash, so it holds, but only for MaxTTL.
func TestACorruptSectionHoldsThenExpires(t *testing.T) {
	g := New(t.TempDir(), WithLockWait(50*time.Millisecond))
	if err := os.MkdirAll(g.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(g.dir, sectionFile)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := g.AdmitPowerAction("reboot"); !errors.Is(err, ErrFlashInProgress) {
		t.Fatalf("corrupt, fresh file: admit = %v, want ErrFlashInProgress", err)
	}
	old := time.Now().Add(-MaxTTL - time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	done, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("corrupt, stale file must not block forever: %v", err)
	}
	done()
}

func TestEnterRefusedWhileCountdownArmed(t *testing.T) {
	g := newGuard(t, newFakeClock())
	armed := true
	g.SetCountdownProbe(func() bool { return armed })

	if _, err := g.Enter("bios", "cmd-1", time.Hour); !errors.Is(err, ErrPowerActionPending) {
		t.Fatalf("Enter with countdown armed = %v, want ErrPowerActionPending", err)
	}
	if _, ok := g.Active(); ok {
		t.Fatal("a refused Enter must not leave a section behind")
	}
	armed = false
	mustEnter(t, g, time.Hour)
}

// A delayed reboot through the remote tools path has no manager to probe, and
// the countdown belongs to the OS, so it has to outlive this process.
func TestEnterRefusedWhileANotedCountdownRuns(t *testing.T) {
	clock := newFakeClock()
	dir := t.TempDir()
	g := New(dir, WithClock(clock.now), WithLockWait(50*time.Millisecond))
	g.NoteCountdown(30 * time.Minute)

	restarted := New(dir, WithClock(clock.now), WithLockWait(50*time.Millisecond))
	if _, err := restarted.Enter("bios", "cmd-1", time.Hour); !errors.Is(err, ErrPowerActionPending) {
		t.Fatalf("Enter during a noted countdown = %v, want ErrPowerActionPending", err)
	}
	clock.advance(30*time.Minute + CountdownSlack)
	mustEnter(t, restarted, time.Hour)
}

func TestNoteCountdownKeepsTheLaterDeadline(t *testing.T) {
	clock := newFakeClock()
	g := newGuard(t, clock)
	g.NoteCountdown(time.Hour)
	g.NoteCountdown(0)

	clock.advance(30 * time.Minute)
	if _, err := g.Enter("bios", "cmd-1", time.Hour); !errors.Is(err, ErrPowerActionPending) {
		t.Fatalf("a shorter note must not shorten a running countdown: %v", err)
	}
}

// A wound-back clock must not turn a noted countdown into a long block.
func TestAnImplausibleNotedCountdownIsIgnored(t *testing.T) {
	clock := newFakeClock()
	g := newGuard(t, clock)
	g.NoteCountdown(time.Hour)
	clock.t = clock.t.Add(-100 * 24 * time.Hour)
	mustEnter(t, g, time.Hour)
}

func TestEnterRefusedWhileAPowerActionIsExecuting(t *testing.T) {
	g := newGuard(t, newFakeClock())
	done, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("AdmitPowerAction: %v", err)
	}
	if _, err := g.Enter("bios", "cmd-1", time.Hour); !errors.Is(err, ErrPowerActionPending) {
		t.Fatalf("Enter during a power action = %v, want ErrPowerActionPending", err)
	}
	done()
	mustEnter(t, g, time.Hour)
}

func TestConcurrentPowerActionsDoNotBlockEachOther(t *testing.T) {
	g := newGuard(t, newFakeClock())
	first, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	defer first()
	second, err := g.AdmitPowerAction("shutdown")
	if err != nil {
		t.Fatalf("a second power action behaves as it did before the guard: %v", err)
	}
	second()
}

func TestAdmitRefusedDuringSection(t *testing.T) {
	g := newGuard(t, newFakeClock())
	release := mustEnter(t, g, time.Hour)

	if done, err := g.AdmitPowerAction("reboot"); !errors.Is(err, ErrFlashInProgress) || done != nil {
		t.Fatalf("admit during section = (%v, %v), want (nil, ErrFlashInProgress)", done != nil, err)
	}
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if err := release(); err != nil {
		t.Fatalf("release is idempotent: %v", err)
	}
	done, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("admit after release: %v", err)
	}
	done()
}

func TestEnterRefusedDuringAnotherSection(t *testing.T) {
	g := newGuard(t, newFakeClock())
	mustEnter(t, g, time.Hour)
	if _, err := g.Enter("firmware", "cmd-2", time.Hour); !errors.Is(err, ErrSectionActive) {
		t.Fatalf("second Enter = %v, want ErrSectionActive", err)
	}
}

// A late release from a section that expired must not end its successor's.
func TestStaleReleaseLeavesANewerSectionAlone(t *testing.T) {
	clock := newFakeClock()
	g := newGuard(t, clock)
	stale := mustEnter(t, g, time.Hour)
	clock.advance(time.Hour)

	if _, err := g.Enter("firmware", "cmd-2", time.Hour); err != nil {
		t.Fatalf("Enter after expiry: %v", err)
	}
	if err := stale(); err != nil {
		t.Fatalf("stale release: %v", err)
	}
	s, ok := g.Active()
	if !ok || s.CommandID != "cmd-2" {
		t.Fatalf("newer section must survive a stale release, got %+v active=%v", s, ok)
	}
}

func TestEnterValidatesItsArguments(t *testing.T) {
	g := newGuard(t, newFakeClock())
	if _, err := g.Enter("", "cmd-1", time.Hour); err == nil {
		t.Fatal("empty kind accepted")
	}
	if _, err := g.Enter("bios", "", time.Hour); err == nil {
		t.Fatal("empty command id accepted")
	}
	if _, err := g.Enter("bios", "cmd-1", 0); err == nil {
		t.Fatal("zero ttl accepted")
	}
}

// Enter is the safety decision, so it fails closed when the guard cannot record
// a section. Admission fails open: an agent whose data dir is unusable can never
// have entered a section, and must keep the reboots it had before this guard.
func TestUnusableDirRefusesEnterButNotPowerActions(t *testing.T) {
	file := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	g := New(filepath.Join(file, "flashguard"), WithLockWait(50*time.Millisecond))

	if _, err := g.Enter("bios", "cmd-1", time.Hour); err == nil {
		t.Fatal("Enter must refuse when the section cannot be recorded")
	}
	done, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("AdmitPowerAction must proceed when nothing could have been entered: %v", err)
	}
	done()
}

// Holds the invariant the guard exists for: at no instant is a section open
// while a power action is executing. Run with -race.
func TestAdmitAndEnterAreAtomic(t *testing.T) {
	g := New(t.TempDir())
	var inSection, inAction, violations atomic.Int64
	var wg sync.WaitGroup
	stop := time.Now().Add(300 * time.Millisecond)

	for i := 0; i < 4; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for time.Now().Before(stop) {
				release, err := g.Enter("bios", "cmd", time.Hour)
				if err != nil {
					continue
				}
				inSection.Add(1)
				if inAction.Load() != 0 {
					violations.Add(1)
				}
				inSection.Add(-1)
				_ = release()
			}
		}()
		go func() {
			defer wg.Done()
			for time.Now().Before(stop) {
				done, err := g.AdmitPowerAction("reboot")
				if err != nil {
					continue
				}
				inAction.Add(1)
				if inSection.Load() != 0 {
					violations.Add(1)
				}
				inAction.Add(-1)
				done()
			}
		}()
	}
	wg.Wait()
	if v := violations.Load(); v != 0 {
		t.Fatalf("a section and a power action overlapped %d times", v)
	}
}

func TestWaitForPowerActionProceedsOnceTheSectionEnds(t *testing.T) {
	g := New(t.TempDir(), WithWaitTiming(5*time.Millisecond, time.Minute))
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}

	admitted := make(chan error, 1)
	go func() {
		done, err := g.WaitForPowerAction("force_reboot")
		if done != nil {
			done()
		}
		admitted <- err
	}()

	select {
	case err := <-admitted:
		t.Fatalf("returned during the section: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	select {
	case err := <-admitted:
		if err != nil {
			t.Fatalf("WaitForPowerAction after release: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("WaitForPowerAction did not proceed after the section ended")
	}
}

// The wait is bounded, and running out never means acting during a flash.
func TestWaitForPowerActionGivesUpWithoutActing(t *testing.T) {
	g := New(t.TempDir(), WithWaitTiming(time.Millisecond, 20*time.Millisecond))
	if _, err := g.Enter("bios", "cmd-1", time.Hour); err != nil {
		t.Fatalf("Enter: %v", err)
	}
	done, err := g.WaitForPowerAction("force_reboot")
	if !errors.Is(err, ErrFlashInProgress) || done != nil {
		t.Fatalf("WaitForPowerAction past its ceiling = (%v, %v), want (nil, ErrFlashInProgress)", done != nil, err)
	}
}

func writeRawSection(t *testing.T, g *Guard, s Section) {
	t.Helper()
	if err := g.writeJSON(sectionFile, s); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}
}

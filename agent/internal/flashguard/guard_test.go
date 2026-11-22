package flashguard

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
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

// atomicityDeadline only turns a guard that refuses for ever into a failure rather
// than a test timeout. A passing run never comes near it.
const atomicityDeadline = 30 * time.Second

// atomicityProbe counts turns taken on each side of the guard and catches them
// overlapping. A turn retries until it gets in, then checks for the other side
// last thing before leaving its window. Because both sides check at the end of
// their window, any overlap at all is seen by whichever side leaves first.
type atomicityProbe struct {
	t                          *testing.T
	g                          *Guard
	inSection, inAction        atomic.Int64
	violations                 atomic.Int64
	sections, actions          atomic.Int64
	enterRefused, admitRefused atomic.Int64
}

// turn is one side's single turn: onRefused runs after each refusal, hold runs
// inside the window.
type turn func(onRefused, hold func())

func (p *atomicityProbe) section(onRefused, hold func()) {
	deadline := time.Now().Add(atomicityDeadline)
	for {
		release, err := p.g.Enter("bios", "cmd", time.Hour)
		if err == nil {
			p.sections.Add(1)
			p.inSection.Add(1)
			hold()
			if p.inAction.Load() != 0 {
				p.violations.Add(1)
			}
			p.inSection.Add(-1)
			if err := release(); err != nil {
				p.t.Errorf("release: %v", err)
			}
			return
		}
		if !errors.Is(err, ErrSectionActive) && !errors.Is(err, ErrPowerActionPending) {
			p.t.Errorf("Enter: %v", err)
			return
		}
		p.enterRefused.Add(1)
		onRefused()
		if time.Now().After(deadline) {
			p.t.Errorf("Enter still refused after %v: %v", atomicityDeadline, err)
			return
		}
		time.Sleep(lockRetryInterval)
	}
}

func (p *atomicityProbe) action(onRefused, hold func()) {
	deadline := time.Now().Add(atomicityDeadline)
	for {
		done, err := p.g.AdmitPowerAction("reboot")
		if err == nil {
			p.actions.Add(1)
			p.inAction.Add(1)
			hold()
			if p.inSection.Load() != 0 {
				p.violations.Add(1)
			}
			p.inAction.Add(-1)
			done()
			return
		}
		if !errors.Is(err, ErrFlashInProgress) {
			p.t.Errorf("AdmitPowerAction: %v", err)
			return
		}
		p.admitRefused.Add(1)
		onRefused()
		if time.Now().After(deadline) {
			p.t.Errorf("AdmitPowerAction still refused after %v: %v", atomicityDeadline, err)
			return
		}
		time.Sleep(lockRetryInterval)
	}
}

// headStart puts lead in its window and keeps it there until the other side has
// tried and been refused, so the conflict is certain rather than likely. If a
// broken guard lets the other side in instead, it finishes its turn inside lead's
// window and the overlap is counted.
func headStart(lead, other turn) {
	inWindow := make(chan struct{})
	contended := make(chan struct{})
	var openWindow, settle sync.Once
	opened := func() { openWindow.Do(func() { close(inWindow) }) }
	settled := func() { settle.Do(func() { close(contended) }) }

	var wg sync.WaitGroup
	wg.Go(func() {
		defer opened() // a lead that failed outright must not strand the wait below
		lead(func() {}, func() {
			opened()
			<-contended
		})
	})
	<-inWindow
	for range 2 {
		wg.Go(func() {
			defer settled()
			other(settled, func() {})
		})
	}
	wg.Wait()
}

// freeRace starts both sides at one instant. Each holds its window for one lock
// retry so that a turn polling the lock can land inside it.
func (p *atomicityProbe) freeRace() {
	start := make(chan struct{})
	hold := func() { time.Sleep(lockRetryInterval) }
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			<-start
			p.section(func() {}, hold)
		})
		wg.Go(func() {
			<-start
			p.action(func() {}, hold)
		})
	}
	close(start)
	wg.Wait()
}

// Holds the invariant the guard exists for: at no instant is a section open
// while a power action is executing. Run with -race.
//
// The guard's lock is not fair (see AdmitPowerAction), so a time-boxed loop on
// both sides can give either side no turn at all. Here each side has a fixed
// number of turns and stops competing once they are used, so neither can starve
// the other past the end of a round and the counts below are exact.
func TestAdmitAndEnterAreAtomic(t *testing.T) {
	logging.DiscardOutput() // every section logs twice
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	const raceRounds = 8
	p := &atomicityProbe{t: t, g: New(t.TempDir())}

	headStart(p.section, p.action)
	headStart(p.action, p.section)
	for i := 0; i < raceRounds && !t.Failed(); i++ {
		p.freeRace()
	}

	if v := p.violations.Load(); v != 0 {
		t.Fatalf("a section and a power action overlapped %d times", v)
	}
	if t.Failed() {
		return // a turn gave up, so the counts below would only add noise
	}
	// Every turn must have run, and each side must have been refused by the other
	// at least once, or the invariant was never exercised.
	const want = 3 + 2*raceRounds
	if p.sections.Load() != want || p.actions.Load() != want {
		t.Errorf("vacuous run: %d sections and %d power actions, want %d of each", p.sections.Load(), p.actions.Load(), want)
	}
	if p.enterRefused.Load() == 0 || p.admitRefused.Load() == 0 {
		t.Errorf("vacuous run: %d Enter refusals, %d admission refusals", p.enterRefused.Load(), p.admitRefused.Load())
	}
}

// An exclusive holder may be Enter between its check and its write, with no
// section on disk yet. An admission that outwaits it must hold, not proceed.
func TestAdmitRefusedWhileTheLockIsBusy(t *testing.T) {
	g := newGuard(t, newFakeClock())
	lock, err := g.acquire(lockExclusive, 0)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	done, err := g.AdmitPowerAction("reboot")
	if !errors.Is(err, ErrFlashInProgress) || done != nil {
		t.Fatalf("AdmitPowerAction with the lock busy = %v, done set %v; want ErrFlashInProgress", err, done != nil)
	}
	lock.release()

	// Nothing else changed, so the lock was the reason.
	done, err = g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("AdmitPowerAction after the lock was freed: %v", err)
	}
	done()
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

// A section file that exists but cannot be read (a sharing violation, a file
// replaced by a directory or a link) may be a live flash. It holds like a corrupt
// one, for MaxTTL from when it was written, and never longer.
func TestAnUnreadableSectionHoldsUntilItAgesOut(t *testing.T) {
	g := New(t.TempDir(), WithLockWait(50*time.Millisecond))
	path := filepath.Join(g.dir, sectionFile)
	if err := os.MkdirAll(path, 0o700); err != nil { // present, but not a regular file
		t.Fatal(err)
	}
	if _, err := g.AdmitPowerAction("reboot"); !errors.Is(err, ErrFlashInProgress) {
		t.Fatalf("admit with an unreadable section = %v, want ErrFlashInProgress", err)
	}
	if _, err := g.Enter("bios", "cmd-1", time.Hour); !errors.Is(err, ErrSectionActive) {
		t.Fatalf("Enter with an unreadable section = %v, want ErrSectionActive", err)
	}
	old := time.Now().Add(-MaxTTL - time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	done, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("an unreadable section older than MaxTTL must not block: %v", err)
	}
	done()
}

// Enter fails closed: a countdown it cannot read may be a reboot about to happen.
func TestAnUnreadableCountdownRefusesEnter(t *testing.T) {
	for _, tt := range []struct {
		name  string
		plant func(path string) error
	}{
		{"corrupt", func(path string) error { return os.WriteFile(path, []byte("{nope"), 0o600) }},
		{"not a file", func(path string) error { return os.MkdirAll(path, 0o700) }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			g := New(t.TempDir(), WithLockWait(50*time.Millisecond))
			if err := os.MkdirAll(g.dir, 0o700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(g.dir, countdownFile)
			if err := tt.plant(path); err != nil {
				t.Fatal(err)
			}
			if _, err := g.Enter("bios", "cmd-1", time.Hour); !errors.Is(err, ErrPowerActionPending) {
				t.Fatalf("Enter = %v, want ErrPowerActionPending", err)
			}
			old := time.Now().Add(-maxNotedCountdown - time.Minute)
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
			release, err := g.Enter("bios", "cmd-1", time.Hour)
			if err != nil {
				t.Fatalf("an unreadable countdown older than any countdown must not block: %v", err)
			}
			_ = release()
		})
	}
}

// Active runs on every heartbeat that re-offers an upgrade, and a corrupt section
// holds for hours: its warning is logged once, not on every read.
func TestACorruptSectionWarnsOnce(t *testing.T) {
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	g := New(t.TempDir(), WithLockWait(50*time.Millisecond))
	if err := os.MkdirAll(g.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(g.dir, sectionFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		g.Active()
		_, _ = g.AdmitPowerAction("reboot")
	}
	if got := strings.Count(buf.String(), "level=WARN"); got != 1 {
		t.Fatalf("logged %d WARN lines for one corrupt section, want 1:\n%s", got, buf.String())
	}
}

// A restart hands off to another process that stops this one a few seconds
// later. HoldFor keeps the admission through that gap, and still lets go if the
// restart never comes.
func TestHoldForKeepsTheAdmissionThenLetsGo(t *testing.T) {
	g := New(t.TempDir(), WithLockWait(50*time.Millisecond))
	done, err := g.AdmitPowerAction("agent_restart")
	if err != nil {
		t.Fatalf("AdmitPowerAction: %v", err)
	}
	HoldFor(done, time.Second) // longer than Enter waits for the lock
	runtime.GC()               // the held lock must not depend on staying reachable by luck
	if _, err := g.Enter("bios", "cmd-1", time.Hour); !errors.Is(err, ErrPowerActionPending) {
		t.Fatalf("Enter during the hand-off = %v, want ErrPowerActionPending", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		release, err := g.Enter("bios", "cmd-1", time.Hour)
		if err == nil {
			_ = release()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the hand-off hold never let go: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The watchdog and the agent must agree on one directory, so a relative one is
// refused rather than resolved against whatever each process's cwd is.
func TestARelativeDirFailsClosedForEnterAndOpenForAdmission(t *testing.T) {
	cwd := t.TempDir()
	t.Chdir(cwd)
	g := New("relative-flashguard", WithLockWait(50*time.Millisecond))
	if _, err := g.Enter("bios", "cmd-1", time.Hour); err == nil {
		t.Fatal("Enter accepted a relative directory")
	}
	done, err := g.AdmitPowerAction("reboot")
	if err != nil {
		t.Fatalf("admission fails open on an unusable directory: %v", err)
	}
	done()
	if _, err := os.Stat(filepath.Join(cwd, "relative-flashguard")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a relative directory was created in the working directory: %v", err)
	}
}

func TestNonPositiveTimingFallsBackToDefaults(t *testing.T) {
	g := New(t.TempDir(), WithLockWait(-1), WithWaitTiming(0, -1), WithClock(nil))
	if g.lockWait != defaultLockWait || g.waitPoll != defaultWaitPoll || g.waitMax != MaxTTL || g.now == nil {
		t.Fatalf("got lockWait=%v waitPoll=%v waitMax=%v now=%v", g.lockWait, g.waitPoll, g.waitMax, g.now != nil)
	}
}

func writeRawSection(t *testing.T, g *Guard, s Section) {
	t.Helper()
	if err := g.writeJSON(sectionFile, s); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}
}

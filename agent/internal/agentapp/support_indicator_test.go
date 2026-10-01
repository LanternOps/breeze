package agentapp

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeIndicatorUI records what the Quick Support viewing indicator drew.
type fakeIndicatorUI struct {
	mu      sync.Mutex
	active  bool
	viewer  string
	shows   []string
	starts  []int64
	hides   int
	console []string
}

func (f *fakeIndicatorUI) setActive(v bool) { f.mu.Lock(); f.active = v; f.mu.Unlock() }
func (f *fakeIndicatorUI) setViewer(v string) {
	f.mu.Lock()
	f.viewer = v
	f.mu.Unlock()
}

func (f *fakeIndicatorUI) snapshot() (shows []string, hides int, console []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.shows...), f.hides, append([]string(nil), f.console...)
}

func newTestIndicator(f *fakeIndicatorUI) *supportIndicator {
	return &supportIndicator{
		active: func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.active },
		viewer: func() string { f.mu.Lock(); defer f.mu.Unlock(); return f.viewer },
		show: func(label string, startedAtMs int64) {
			f.mu.Lock()
			f.shows = append(f.shows, label)
			f.starts = append(f.starts, startedAtMs)
			f.mu.Unlock()
		},
		hide: func() { f.mu.Lock(); f.hides++; f.mu.Unlock() },
		say:  func(s string) { f.mu.Lock(); f.console = append(f.console, s); f.mu.Unlock() },
		now:  func() time.Time { return time.UnixMilli(1_700_000_000_000) },
		kick: make(chan struct{}, 1),
	}
}

func TestSupportIndicatorShowsWhileViewedAndHidesWhenNot(t *testing.T) {
	f := &fakeIndicatorUI{viewer: "Billy from Olive Technology"}
	ind := newTestIndicator(f)

	ind.reconcile()
	if shows, hides, _ := f.snapshot(); len(shows) != 0 || hides != 0 {
		t.Fatalf("nothing is running: shows=%v hides=%d", shows, hides)
	}

	f.setActive(true)
	ind.reconcile()
	ind.reconcile() // idempotent while nothing changes
	shows, hides, console := f.snapshot()
	if len(shows) != 1 || shows[0] != "Billy from Olive Technology is viewing your screen" {
		t.Fatalf("shows=%v", shows)
	}
	if f.starts[0] != 1_700_000_000_000 {
		t.Fatalf("the pill's clock must start when the viewing started, got %d", f.starts[0])
	}
	if hides != 0 {
		t.Fatalf("hides=%d", hides)
	}
	joined := strings.Join(console, "\n")
	if !strings.Contains(joined, "Billy from Olive Technology is viewing your screen") ||
		!strings.Contains(joined, "close this window or press Ctrl+C") {
		t.Fatalf("the console must say who is viewing and how to stop: %q", joined)
	}

	f.setActive(false)
	ind.reconcile()
	ind.reconcile()
	shows, hides, console = f.snapshot()
	if hides != 1 || len(shows) != 1 {
		t.Fatalf("one hide expected: shows=%v hides=%d", shows, hides)
	}
	if !strings.Contains(console[len(console)-1], "no longer viewing") {
		t.Fatalf("the console must say viewing ended, got %q", console[len(console)-1])
	}
}

func TestSupportIndicatorNamesAGenericTechnicianWithoutIdentity(t *testing.T) {
	f := &fakeIndicatorUI{active: true}
	ind := newTestIndicator(f)
	ind.reconcile()
	if shows, _, _ := f.snapshot(); len(shows) != 1 || shows[0] != "A technician is viewing your screen" {
		t.Fatalf("shows=%v", shows)
	}
}

// A later start that carries a different identity relabels the indicator in
// place, keeping its clock, without another console announcement.
func TestSupportIndicatorRelabelsWhenTheViewerChanges(t *testing.T) {
	f := &fakeIndicatorUI{active: true, viewer: "Billy"}
	ind := newTestIndicator(f)
	ind.reconcile()
	f.setViewer("Sue")
	ind.reconcile()
	shows, hides, console := f.snapshot()
	if len(shows) != 2 || shows[1] != "Sue is viewing your screen" || hides != 0 {
		t.Fatalf("shows=%v hides=%d", shows, hides)
	}
	if f.starts[1] != f.starts[0] {
		t.Fatal("a relabel must keep the session clock")
	}
	n := 0
	for _, line := range console {
		if strings.Contains(line, "is viewing your screen") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("a relabel must not re-announce on the console: %q", console)
	}
}

// poke is called with the stream manager's lock held: it must never block,
// however many changes pile up before the worker runs.
func TestSupportIndicatorPokeNeverBlocks(t *testing.T) {
	ind := newTestIndicator(&fakeIndicatorUI{})
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			ind.poke()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("poke blocked with no worker draining it")
	}
}

func TestSupportIndicatorRunFollowsPokesAndHidesOnStop(t *testing.T) {
	f := &fakeIndicatorUI{}
	ind := newTestIndicator(f)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { ind.run(ctx, time.Hour); close(done) }()

	f.setActive(true)
	ind.poke()
	waitFor(t, "shown after a poke", func() bool { s, _, _ := f.snapshot(); return len(s) == 1 })

	f.setActive(false)
	ind.poke()
	waitFor(t, "hidden after a poke", func() bool { _, h, _ := f.snapshot(); return h == 1 })

	f.setActive(true)
	ind.poke()
	waitFor(t, "shown again", func() bool { s, _, _ := f.snapshot(); return len(s) == 2 })

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("run did not return on cancel")
	}
	if _, h, _ := f.snapshot(); h != 2 {
		t.Fatalf("stopping the indicator while shown must hide it, hides=%d", h)
	}
}

// A stop path that never pokes (none is known today, but the WebRTC manager's
// hooks fire on their own goroutines) is still caught by the safety poll.
func TestSupportIndicatorSafetyPollCatchesAMissedPoke(t *testing.T) {
	f := &fakeIndicatorUI{}
	ind := newTestIndicator(f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go ind.run(ctx, 10*time.Millisecond)

	f.setActive(true)
	waitFor(t, "shown by the poll", func() bool { s, _, _ := f.snapshot(); return len(s) == 1 })
	f.setActive(false)
	waitFor(t, "hidden by the poll", func() bool { _, h, _ := f.snapshot(); return h == 1 })
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting: %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

package agentapp

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/userhelper"
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
	// showFails makes the pill fail to appear (window creation failed).
	showFails bool
	// panicOnce makes the next active() read panic.
	panicOnce bool
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
		active: func() bool {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.panicOnce {
				f.panicOnce = false
				panic("boom")
			}
			return f.active
		},
		viewer: func() string { f.mu.Lock(); defer f.mu.Unlock(); return f.viewer },
		show: func(label string, startedAtMs int64) bool {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.showFails {
				return false
			}
			f.shows = append(f.shows, label)
			f.starts = append(f.starts, startedAtMs)
			return true
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

// A pill that fails to appear is not treated as shown: it is retried on the
// next reconcile, while the console announcement is made once regardless.
func TestSupportIndicatorRetriesAPillThatFailedToShow(t *testing.T) {
	f := &fakeIndicatorUI{active: true, viewer: "Billy", showFails: true}
	ind := newTestIndicator(f)
	ind.reconcile()
	shows, _, console := f.snapshot()
	if len(shows) != 0 {
		t.Fatalf("the pill failed: shows=%v", shows)
	}
	if len(console) != 1 || !strings.Contains(console[0], "Billy is viewing your screen") {
		t.Fatalf("the console must still tell the user: %q", console)
	}

	f.mu.Lock()
	f.showFails = false
	f.mu.Unlock()
	ind.reconcile()
	shows, _, console = f.snapshot()
	if len(shows) != 1 {
		t.Fatalf("the failed pill must be retried, shows=%v", shows)
	}
	if len(console) != 1 {
		t.Fatalf("a retry must not re-announce: %q", console)
	}
}

// A panic in one reconcile must not kill the worker: later changes are still
// followed.
func TestSupportIndicatorSurvivesAPanickingReconcile(t *testing.T) {
	f := &fakeIndicatorUI{panicOnce: true}
	ind := newTestIndicator(f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go ind.run(ctx, time.Hour)

	ind.poke() // may or may not be the one that panics; the initial reconcile is
	f.setActive(true)
	ind.poke()
	waitFor(t, "shown after a panic", func() bool { s, _, _ := f.snapshot(); return len(s) == 1 })
}

// A long technician name is shortened, never the sentence: the pill always
// ends "is viewing your screen" and fits the banner's label limit, and the
// cut never splits a multi-byte character.
func TestSupportIndicatorShortensALongViewerNameNotTheSentence(t *testing.T) {
	f := &fakeIndicatorUI{active: true, viewer: strings.Repeat("Ä", 400) + " from Olive Technology"}
	ind := newTestIndicator(f)
	ind.reconcile()
	shows, _, console := f.snapshot()
	if len(shows) != 1 {
		t.Fatalf("shows = %d, want 1", len(shows))
	}
	label := shows[0]
	if !strings.HasSuffix(label, " is viewing your screen") {
		t.Fatalf("label lost its sentence: %q", label)
	}
	if len(label) > userhelper.MaxBannerLabelBytes {
		t.Fatalf("label is %d bytes, over the %d-byte banner limit", len(label), userhelper.MaxBannerLabelBytes)
	}
	if !utf8.ValidString(label) {
		t.Fatalf("label is not valid UTF-8: %q", label)
	}
	if len(console) != 1 || !strings.Contains(console[0], label) {
		t.Fatalf("console line should carry the same label, got %q", console)
	}
}

// Control characters and bidirectional override/isolate characters in the
// server-supplied name are removed from both the pill and the console line,
// so the name cannot reorder or hide the rest of the text.
func TestSupportIndicatorStripsControlAndBidiCharactersFromTheViewerName(t *testing.T) {
	f := &fakeIndicatorUI{active: true, viewer: "Bil\u202ely\x1b[31m\u2066 from\u2069 Olive\r\nTech"}
	ind := newTestIndicator(f)
	ind.reconcile()
	shows, _, console := f.snapshot()
	if len(shows) != 1 || len(console) != 1 {
		t.Fatalf("shows=%q console=%q", shows, console)
	}
	for _, out := range []string{shows[0], console[0]} {
		for _, r := range out {
			if (r < 0x20 && r != '\n') || r == 0x7f || (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) {
				t.Fatalf("output %q still contains %U", out, r)
			}
		}
	}
	if want := "Billy[31m from Olive" + "Tech is viewing your screen"; shows[0] != want {
		t.Fatalf("pill = %q, want %q", shows[0], want)
	}
}

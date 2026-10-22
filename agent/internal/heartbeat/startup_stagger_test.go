package heartbeat

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// W09 (#8148, D7): the startup bulk bundle (inventory, hardware inventory,
// patch inventory) used to fire together right after the first heartbeat on
// every agent restarted at once. Each task now waits its own U(0, 120 s).

type fakeStaggerAfter struct {
	mu      sync.Mutex
	waits   []time.Duration
	chans   []chan time.Time
	changed chan struct{}
}

func newFakeStaggerAfter() *fakeStaggerAfter {
	return &fakeStaggerAfter{changed: make(chan struct{}, 64)}
}

func (f *fakeStaggerAfter) After(d time.Duration) <-chan time.Time {
	ch := make(chan time.Time, 1)
	f.mu.Lock()
	f.waits = append(f.waits, d)
	f.chans = append(f.chans, ch)
	f.mu.Unlock()
	f.changed <- struct{}{}
	return ch
}

func (f *fakeStaggerAfter) waitFor(t *testing.T, n int) []time.Duration {
	t.Helper()
	guard := time.After(5 * time.Second)
	for {
		f.mu.Lock()
		if len(f.waits) >= n {
			out := append([]time.Duration(nil), f.waits...)
			f.mu.Unlock()
			return out
		}
		f.mu.Unlock()
		select {
		case <-f.changed:
		case <-guard:
			t.Fatalf("only %d startup waits registered, want %d", len(f.waits), n)
		}
	}
}

func (f *fakeStaggerAfter) fire(i int) {
	f.mu.Lock()
	ch := f.chans[i]
	f.mu.Unlock()
	ch <- time.Now()
}

func seqRand(vals ...float64) func() float64 {
	var mu sync.Mutex
	i := 0
	return func() float64 {
		mu.Lock()
		defer mu.Unlock()
		v := vals[i%len(vals)]
		i++
		return v
	}
}

func TestStartupBundleIsStaggered(t *testing.T) {
	h := &Heartbeat{stopChan: make(chan struct{})}
	after := newFakeStaggerAfter()
	ran := make(chan string, 8)
	tasks := []startupTask{
		{name: "inventory", run: func() { ran <- "inventory" }},
		{name: "hardware", run: func() { ran <- "hardware" }},
		{name: "patches", run: func() { ran <- "patches" }},
	}
	h.staggerStartup(tasks, 120*time.Second, seqRand(0.1, 0.5, 0.9), after.After)

	waits := after.waitFor(t, 3)
	want := []time.Duration{12 * time.Second, 60 * time.Second, 108 * time.Second}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits = %v, want %v", waits, want)
		}
	}
	select {
	case name := <-ran:
		t.Fatalf("%s ran before its timer fired", name)
	default:
	}
	for i, name := range []string{"inventory", "hardware", "patches"} {
		after.fire(i)
		select {
		case got := <-ran:
			if got != name {
				t.Fatalf("fired %d ran %s, want %s", i, got, name)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s did not run after its timer fired", name)
		}
	}
	select {
	case name := <-ran:
		t.Fatalf("%s ran twice", name)
	default:
	}
}

func TestStartupStaggerStopsWithHeartbeat(t *testing.T) {
	h := &Heartbeat{stopChan: make(chan struct{})}
	after := newFakeStaggerAfter()
	ran := make(chan string, 8)
	var done sync.WaitGroup
	done.Add(1)
	h.staggerStartup([]startupTask{{name: "inventory", run: func() { ran <- "inventory" }}}, 120*time.Second, seqRand(0.5), func(d time.Duration) <-chan time.Time {
		defer done.Done()
		return after.After(d)
	})
	done.Wait()
	close(h.stopChan)
	after.fire(0) // both cases ready: stop must still win (checked first)
	select {
	case <-ran:
		t.Fatal("a startup task ran after Stop")
	case <-time.After(200 * time.Millisecond):
	}
}

// The first tick must not duplicate a delayed startup send: the gates are
// stamped at startup, after the bundle is scheduled (#3529).
func TestStartupStaggerKeepsGateStamps(t *testing.T) {
	src, err := os.ReadFile("heartbeat.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	call := strings.Index(s, "h.staggerStartup(")
	if call < 0 {
		t.Fatal("Start no longer staggers the startup bundle")
	}
	for _, gate := range []string{"h.lastInventoryUpdate = startupNow", "h.lastHardwareUpdate = startupNow", "h.lastPatchUpdate = startupNow"} {
		if i := strings.Index(s[call:], gate); i < 0 || i > 4000 {
			t.Errorf("%q is not stamped right after the staggered bundle", gate)
		}
	}
	for _, direct := range []string{"\tgo h.sendInventory()\n\tgo h.sendHardwareInventory()", "\tgo h.sendPatchInventory()\n\tgo h.runProcessSampler()"} {
		if strings.Contains(s, direct) {
			t.Errorf("startup bundle still launched directly: %q", direct)
		}
	}
}

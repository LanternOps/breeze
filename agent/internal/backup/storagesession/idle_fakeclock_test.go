package storagesession

import (
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeIdleClock drives the idle watchdog (idleAfterFunc) with virtual time
// (#7380). A timer only fires when the test calls Advance, so "slow but
// progressing" is asserted by ordering -- progress re-arms the watchdog
// before the virtual clock moves -- instead of racing a real-time chunk
// pacer against a real-time idle timeout on a loaded runner.
type fakeIdleClock struct {
	mu     sync.Mutex
	now    time.Duration
	timers []*fakeIdleTimer
	resets int // Reset calls seen across all timers (one per observed progress)
}

type fakeIdleTimer struct {
	c        *fakeIdleClock
	deadline time.Duration
	active   bool
	f        func()
}

// installFakeIdleClock swaps the package's idleAfterFunc seam for the test.
// It mutates a package global, so tests using it must not run in parallel.
func installFakeIdleClock(t *testing.T) *fakeIdleClock {
	t.Helper()
	c := &fakeIdleClock{}
	orig := idleAfterFunc
	idleAfterFunc = func(d time.Duration, f func()) idleTimer {
		c.mu.Lock()
		defer c.mu.Unlock()
		tm := &fakeIdleTimer{c: c, deadline: c.now + d, active: true, f: f}
		c.timers = append(c.timers, tm)
		return tm
	}
	t.Cleanup(func() { idleAfterFunc = orig })
	return c
}

func (t *fakeIdleTimer) Reset(d time.Duration) bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	was := t.active
	t.active = true
	t.deadline = t.c.now + d
	t.c.resets++
	return was
}

func (t *fakeIdleTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	was := t.active
	t.active = false
	return was
}

func (c *fakeIdleClock) resetCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.resets
}

// Advance moves virtual time forward by d and fires every armed timer now due.
func (c *fakeIdleClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now += d
	var due []*fakeIdleTimer
	for _, tm := range c.timers {
		if tm.active && tm.deadline <= c.now {
			tm.active = false
			due = append(due, tm)
		}
	}
	c.mu.Unlock()
	for _, tm := range due {
		tm.f()
	}
}

// waitResets blocks until at least n progress resets were observed. The wait
// bound only guards against a hung test; it is not part of the property.
func (c *fakeIdleClock) waitResets(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for c.resetCount() < n {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d progress resets (saw %d)", n, c.resetCount())
		}
		time.Sleep(time.Millisecond)
	}
}

// TestSlowButProgressingTransferIsNotCutOff: total virtual transfer time
// (8 x 150ms) is far beyond the 200ms idle timeout, but every chunk arrives
// inside the window, so the watchdog must never fire.
func TestSlowButProgressingTransferIsNotCutOff(t *testing.T) {
	const (
		chunks = 8
		idle   = 200 * time.Millisecond
		gap    = 150 * time.Millisecond // < idle: each chunk lands in time
	)
	clock := installFakeIdleClock(t)
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	key := "snapshots/s1/files/slow"

	release := make(chan struct{})
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	st.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Length", "8")
		w.WriteHeader(http.StatusOK)
		for i := 0; i < chunks; i++ {
			_, _ = w.Write([]byte("s"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			select {
			case <-release:
			case <-r.Context().Done():
				return true
			case <-done:
				return true
			}
		}
		return true
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{StorageIdleTimeout: idle})
	dst := filepath.Join(t.TempDir(), "o")
	errCh := make(chan error, 1)
	go func() { errCh <- p.Download(key, dst) }()

	var dlErr error
	finished := false
	// resets: 1 after the response headers, then one per body chunk read.
	for i := 0; i < chunks; i++ {
		clock.waitResets(t, i+2)
		clock.Advance(gap) // idle window is re-armed by the progress just seen
		// The last chunk completes the body (Content-Length reached), so
		// Download may legitimately return before the final release is taken.
		select {
		case release <- struct{}{}:
		case dlErr = <-errCh:
			finished = true
		}
		if finished {
			if i != chunks-1 || dlErr != nil {
				t.Fatalf("Download ended after %d of %d chunks: %v", i+1, chunks, dlErr)
			}
			break
		}
	}
	if !finished {
		dlErr = <-errCh
	}
	if dlErr != nil {
		t.Fatalf("Download: %v", dlErr)
	}
	if got := readFile(t, dst); got != strings.Repeat("s", chunks) {
		t.Fatalf("content = %q", got)
	}
	if got := len(st.recorded()); got != 1 {
		t.Fatalf("storage requests = %d, want 1", got)
	}
	if got := len(cp.calls()); got != 1 {
		t.Fatalf("resolve calls = %d, want 1", got)
	}
}

// TestNoProgressTransferIsCutOffOnFakeClock is the control for the test
// above: the same fake-clock harness must trip the watchdog when bytes stop
// arriving, so the "not cut off" result is not vacuous.
func TestNoProgressTransferIsCutOffOnFakeClock(t *testing.T) {
	const idle = 200 * time.Millisecond
	clock := installFakeIdleClock(t)
	noSleep(t)
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	key := "snapshots/s1/files/stuck-fake"

	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	st.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Length", "8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("s"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		select { // never send another byte
		case <-r.Context().Done():
		case <-done:
		}
		return true
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{StorageIdleTimeout: idle})
	dst := filepath.Join(t.TempDir(), "o")
	errCh := make(chan error, 1)
	go func() { errCh <- p.Download(key, dst) }()

	// Each attempt makes exactly two progress observations (headers, then the
	// single byte); only after both does virtual time pass with no further
	// progress, which must trip the watchdog and start the next attempt.
	for attempt := 1; attempt <= 1+maxStallRetries; attempt++ {
		clock.waitResets(t, 2*attempt)
		clock.Advance(idle)
	}
	if err := <-errCh; err == nil {
		t.Fatal("a transfer that stops making progress must fail")
	}
	if got := len(st.recorded()); got != 1+maxStallRetries {
		t.Fatalf("storage requests = %d, want %d", got, 1+maxStallRetries)
	}
}

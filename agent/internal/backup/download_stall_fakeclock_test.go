package backup

import (
	"sync"
	"testing"
	"time"
)

// fakeStallClock is a manually driven downloadClockInterface for the
// download stall-timeout tests (#7255). It never sleeps: a timer only fires
// when the test calls Advance, so the provider's chunk pacing and the
// watchdog's no-progress window advance in lockstep with what the test
// drives, instead of racing two independent real-time waits against a
// scheduler that may starve either goroutine on a loaded CI runner. The test
// asserts ordering ("still no stall after N intervals of progress"), not
// elapsed wall-clock time.
type fakeStallClock struct {
	t       *testing.T
	mu      sync.Mutex
	now     time.Time
	pending []*fakeStallTimer // timers currently waiting to fire
}

func newFakeStallClock(t *testing.T) *fakeStallClock {
	t.Helper()
	return &fakeStallClock{t: t, now: time.Unix(1_700_000_000, 0)}
}

func (c *fakeStallClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeStallClock) NewTimer(d time.Duration) downloadTimerInterface {
	c.mu.Lock()
	defer c.mu.Unlock()
	tm := &fakeStallTimer{clock: c, deadline: c.now.Add(d), ch: make(chan time.Time)}
	c.pending = append(c.pending, tm)
	return tm
}

// BlockUntil blocks (polling; there is no real time budget involved in the
// property under test, only in this settle-wait) until exactly n timers are
// pending. Tests use it between Advance calls to be sure a woken goroutine
// has re-registered (via Reset) or newly registered its next wait before the
// clock moves again.
func (c *fakeStallClock) BlockUntil(n int) {
	deadline := time.Now().Add(5 * time.Second)
	for {
		c.mu.Lock()
		got := len(c.pending)
		c.mu.Unlock()
		if got == n {
			return
		}
		if time.Now().After(deadline) {
			c.t.Fatalf("fakeStallClock.BlockUntil(%d): timed out with %d timers pending", n, got)
			return
		}
	}
}

// Advance moves the clock forward by d and fires (in registration order)
// every timer now due. Each fire is delivered on an unbuffered channel, so
// the send only completes once the owning goroutine's select has received
// it — Advance never returns claiming a tick was delivered before the
// consumer actually observed it.
func (c *fakeStallClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	var due []*fakeStallTimer
	var live []*fakeStallTimer
	for _, tm := range c.pending {
		if !tm.deadline.After(now) {
			due = append(due, tm)
		} else {
			live = append(live, tm)
		}
	}
	c.pending = live
	c.mu.Unlock()

	for _, tm := range due {
		tm.ch <- now
	}
}

type fakeStallTimer struct {
	clock    *fakeStallClock
	deadline time.Time
	ch       chan time.Time
}

func (t *fakeStallTimer) C() <-chan time.Time { return t.ch }

// Reset re-arms the timer for d after the clock's current time and makes it
// pending again -- as if a fresh NewTimer had been created with that
// deadline. It always reports the timer as having been active, matching how
// downloadWithStallTimeout uses it (it never Resets a timer it also Stopped).
func (t *fakeStallTimer) Reset(d time.Duration) bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	t.deadline = t.clock.now.Add(d)
	t.clock.pending = append(t.clock.pending, t)
	return true
}

// Stop removes the timer from the pending set if it is still there.
func (t *fakeStallTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	for i, p := range t.clock.pending {
		if p == t {
			t.clock.pending = append(t.clock.pending[:i], t.clock.pending[i+1:]...)
			return true
		}
	}
	return false
}

// driveChunkedTransfer advances fc by step exactly waits times, blocking
// between advances until the watchdog's window timer and the transfer's next
// chunk-pacing timer are both pending again. It models a producer that
// paces waits+1 chunks step apart, matching chunkedStallProvider and
// scriptedDownloadProvider.trickleManifest.
func driveChunkedTransfer(t *testing.T, fc *fakeStallClock, step time.Duration, waits int) {
	t.Helper()
	fc.BlockUntil(2)
	for i := 0; i < waits; i++ {
		fc.Advance(step)
		if i < waits-1 {
			fc.BlockUntil(2)
		}
	}
}

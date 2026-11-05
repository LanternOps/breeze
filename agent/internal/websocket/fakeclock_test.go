package websocket

import (
	"sort"
	"sync"
	"testing"
	"time"
)

// fakeWSClock drives the reconnect loop's waits with virtual time (W09,
// #8148). A waiter fires only when the test calls Advance, so a test asserts
// the exact wait the loop chose instead of racing it on a loaded runner. The
// only real-time bound is the 5 s hang guard in the Wait* helpers.
type fakeWSClock struct {
	mu      sync.Mutex
	now     time.Time
	waiters []*fakeWSWaiter
	// history records every non-zero After duration in registration order;
	// consumed is how far NextWait has read it.
	history  []time.Duration
	consumed int
	changed  chan struct{} // closed and replaced on every registration
}

type fakeWSWaiter struct {
	deadline time.Time
	ch       chan time.Time
}

// fakeWSEpoch is a realistic date so HTTP-date Retry-After values parse.
var fakeWSEpoch = time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)

// installFakeWSClock swaps wsClock for a fake. It mutates a package global —
// tests that use it must not call t.Parallel(). Call it BEFORE runClient so
// its cleanup (the restore) runs after the client has stopped and Start has
// returned (t.Cleanup is LIFO), and -race sees no read during the restore.
func installFakeWSClock(t *testing.T) *fakeWSClock {
	t.Helper()
	c := &fakeWSClock{now: fakeWSEpoch, changed: make(chan struct{})}
	orig := wsClock
	wsClock = c
	t.Cleanup(func() { wsClock = orig })
	return c
}

// installWSRand installs a constant rand for the reconnect loop. It mutates a
// package global — tests that use it must not call t.Parallel(). Install it
// before runClient for the same cleanup-order reason as installFakeWSClock.
func installWSRand(t *testing.T, v float64) {
	t.Helper()
	orig := wsRand
	wsRand = func() float64 { return v }
	t.Cleanup(func() { wsRand = orig })
}

func (c *fakeWSClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeWSClock) After(d time.Duration) <-chan time.Time {
	ch := make(chan time.Time, 1)
	c.mu.Lock()
	defer c.mu.Unlock()
	if d <= 0 {
		ch <- c.now
		return ch
	}
	c.waiters = append(c.waiters, &fakeWSWaiter{deadline: c.now.Add(d), ch: ch})
	c.history = append(c.history, d)
	close(c.changed)
	c.changed = make(chan struct{})
	return ch
}

// Advance moves virtual time forward by d and fires, in deadline order, every
// waiter now due.
func (c *fakeWSClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var due, keep []*fakeWSWaiter
	for _, w := range c.waiters {
		if !w.deadline.After(c.now) {
			due = append(due, w)
		} else {
			keep = append(keep, w)
		}
	}
	c.waiters = keep
	now := c.now
	c.mu.Unlock()
	sort.Slice(due, func(i, j int) bool { return due[i].deadline.Before(due[j].deadline) })
	for _, w := range due {
		select {
		case w.ch <- now:
		default:
		}
	}
}

// WaitForWaiters blocks until at least n waiters are pending.
func (c *fakeWSClock) WaitForWaiters(t *testing.T, n int) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		c.mu.Lock()
		pending, changed := len(c.waiters), c.changed
		c.mu.Unlock()
		if pending >= n {
			return
		}
		select {
		case <-changed:
		case <-deadline:
			t.Fatalf("fake clock: %d waiters pending after 5s, want %d", pending, n)
		}
	}
}

// NextWait blocks until the loop registers its next (not yet read) non-zero
// wait and returns its duration.
func (c *fakeWSClock) NextWait(t *testing.T) time.Duration {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		c.mu.Lock()
		if c.consumed < len(c.history) {
			d := c.history[c.consumed]
			c.consumed++
			c.mu.Unlock()
			return d
		}
		changed := c.changed
		c.mu.Unlock()
		select {
		case <-changed:
		case <-deadline:
			t.Fatal("fake clock: no new wait registered within 5s")
			return 0
		}
	}
}

// Registered returns how many non-zero waits have been registered so far.
func (c *fakeWSClock) Registered() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.history)
}

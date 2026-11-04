package isolation

import (
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// fakeClock is a settable Clock. Mono and BootID model the system monotonic
// clock and the boot identity; a "reboot" resets Mono and changes BootID.
type fakeClock struct {
	mu   sync.Mutex
	now  time.Time
	mono time.Duration
	boot string
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC), mono: time.Hour, boot: "boot-1"}
}

func (c *fakeClock) Now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeClock) Mono() time.Duration { c.mu.Lock(); defer c.mu.Unlock(); return c.mono }
func (c *fakeClock) BootID() string      { c.mu.Lock(); defer c.mu.Unlock(); return c.boot }
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mono += d
	c.mu.Unlock()
}

// SetWall moves only the wall clock (an admin or NTP changing the time).
func (c *fakeClock) SetWall(t time.Time) { c.mu.Lock(); c.now = t; c.mu.Unlock() }

// Reboot starts a new boot: new BootID, monotonic restarts near zero.
func (c *fakeClock) Reboot(id string, wall time.Time) {
	c.mu.Lock()
	c.boot, c.mono, c.now = id, 30*time.Second, wall
	c.mu.Unlock()
}

func committedJournal(c *fakeClock, ttl time.Duration) *journal.Journal {
	j := journal.New()
	j.Phase = journal.PhaseCommitted
	j.Episode = &journal.EpisodeRecord{IsolationID: "6f1c2a9e-4b3d-4c5e-8f70-1a2b3c4d5e6f", Generation: 1, ExpiresAt: c.Now().Add(ttl)}
	j.AppliedAtWall = c.Now()
	j.AppliedAtMono = int64(c.Mono())
	j.BootID = c.BootID()
	j.HighWaterWall = c.Now()
	return j
}

func TestExpiredWallClock(t *testing.T) {
	c := newFakeClock()
	j := committedJournal(c, 72*time.Hour)
	if exp, _ := Expired(j, c); exp {
		t.Fatal("expired immediately after apply")
	}
	c.Advance(72*time.Hour - time.Second)
	if exp, _ := Expired(j, c); exp {
		t.Fatal("expired one second early")
	}
	c.Advance(time.Second)
	exp, reason := Expired(j, c)
	if !exp || reason != ExpiryWallClock {
		t.Fatalf("Expired = %v %q, want true %q at expiresAt", exp, reason, ExpiryWallClock)
	}
}

// Same boot, wall clock set backwards: the monotonic clause still expires the
// episode once the TTL has elapsed.
func TestExpiredMonotonicSameBoot(t *testing.T) {
	c := newFakeClock()
	j := committedJournal(c, 2*time.Hour)
	start := c.Now()
	c.Advance(2 * time.Hour)
	c.SetWall(start.Add(-24 * time.Hour)) // someone wound the clock back a day
	exp, reason := Expired(j, c)
	if !exp || reason != ExpiryMonotonic {
		t.Fatalf("Expired = %v %q, want true %q", exp, reason, ExpiryMonotonic)
	}
}

// After a reboot the monotonic anchor is meaningless: a small Mono() in the
// new boot must not be compared with the old boot's AppliedAtMono.
func TestExpiredMonotonicIgnoredAcrossBoot(t *testing.T) {
	c := newFakeClock()
	j := committedJournal(c, 72*time.Hour)
	j.AppliedAtMono = int64(500 * time.Hour) // a value no new boot could reach soon
	c.Reboot("boot-2", c.Now().Add(time.Hour))
	if exp, reason := Expired(j, c); exp {
		t.Fatalf("expired across a reboot by %q", reason)
	}
}

// After a reboot, a wall clock more than 5 minutes behind the high-water mark
// counts as expired (refinement 4(ii)); within 5 minutes it does not.
func TestExpiredHighWaterAcrossNewBoot(t *testing.T) {
	c := newFakeClock()
	j := committedJournal(c, 72*time.Hour)
	j.HighWaterWall = c.Now().Add(10 * time.Hour) // the agent journalled this late a time before rebooting

	c.Reboot("boot-2", j.HighWaterWall.Add(-4*time.Minute))
	if exp, reason := Expired(j, c); exp {
		t.Fatalf("expired by %q with the wall clock only 4 min behind the high-water mark", reason)
	}

	c.Reboot("boot-3", j.HighWaterWall.Add(-6*time.Minute))
	exp, reason := Expired(j, c)
	if !exp || reason != ExpiryClockRollback {
		t.Fatalf("Expired = %v %q, want true %q", exp, reason, ExpiryClockRollback)
	}
}

// Within one boot the high-water clause does not apply (the monotonic clause
// covers a wall rollback there).
func TestExpiredHighWaterSameBootDoesNotFire(t *testing.T) {
	c := newFakeClock()
	j := committedJournal(c, 72*time.Hour)
	j.HighWaterWall = c.Now().Add(time.Hour)
	c.SetWall(c.Now().Add(-30 * time.Minute))
	if exp, reason := Expired(j, c); exp {
		t.Fatalf("expired in the same boot by %q", reason)
	}
}

func TestExpiredNoEpisode(t *testing.T) {
	c := newFakeClock()
	if exp, _ := Expired(nil, c); exp {
		t.Fatal("nil journal expired")
	}
	if exp, _ := Expired(journal.New(), c); exp {
		t.Fatal("empty journal expired")
	}
}

func TestSystemClock(t *testing.T) {
	c := SystemClock()
	a := c.Mono()
	time.Sleep(5 * time.Millisecond)
	b := c.Mono()
	if b < a {
		t.Fatalf("Mono went backwards: %v then %v", a, b)
	}
	first, second := c.BootID(), c.BootID()
	if first == "" || first != second {
		t.Fatalf("BootID empty or unstable: %q then %q", first, second)
	}
	if d := time.Since(c.Now()); d < -time.Second || d > time.Second {
		t.Fatalf("Now is %v off the wall clock", d)
	}
}

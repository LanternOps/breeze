package isolation

import (
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// Clock is the time source for expiry and the provisional deadline.
type Clock interface {
	// Now is the wall clock.
	Now() time.Time
	// Mono is a system-wide monotonic reading that includes time asleep
	// (CLOCK_BOOTTIME on Linux, CLOCK_MONOTONIC on macOS, GetTickCount64 on
	// Windows). It is comparable across processes, but only within one boot.
	Mono() time.Duration
	// BootID identifies the running boot.
	BootID() string
}

// HighWaterSlack is how far behind the journalled high-water wall time the
// clock may be after a reboot before the episode counts as expired.
const HighWaterSlack = 5 * time.Minute

// Expiry reasons returned by Expired.
const (
	ExpiryWallClock     = "wall_clock"
	ExpiryMonotonic     = "monotonic_ttl"
	ExpiryClockRollback = "clock_rollback"
)

// clockFacts is what the clock rule needs, from the journal or a LocalState.
type clockFacts struct {
	expiresAt     time.Time
	appliedAtWall time.Time
	appliedAtMono time.Duration
	bootID        string
	highWaterWall time.Time
}

// Expired implements the plan's clock rule (spec §3.6 item 2 plus Gate B
// refinement 4(ii)). An episode is expired when any of these holds:
//   - wall clock ≥ expiresAt;
//   - in the same boot, monotonic time since apply ≥ the TTL;
//   - after a reboot, wall clock < highWaterWall − 5 min.
//
// A clock moved backwards therefore cannot extend isolation.
func Expired(j *journal.Journal, c Clock) (bool, string) {
	if j == nil || j.Episode == nil {
		return false, ""
	}
	return expired(clockFacts{
		expiresAt:     j.Episode.ExpiresAt,
		appliedAtWall: j.AppliedAtWall,
		appliedAtMono: time.Duration(j.AppliedAtMono),
		bootID:        j.BootID,
		highWaterWall: j.HighWaterWall,
	}, c)
}

func expired(f clockFacts, c Clock) (bool, string) {
	if f.expiresAt.IsZero() {
		return false, ""
	}
	now := c.Now()
	if !now.Before(f.expiresAt) {
		return true, ExpiryWallClock
	}
	boot := c.BootID()
	if f.bootID != "" && f.bootID == boot && !f.appliedAtWall.IsZero() {
		ttl := f.expiresAt.Sub(f.appliedAtWall)
		if c.Mono()-f.appliedAtMono >= ttl {
			return true, ExpiryMonotonic
		}
	}
	if f.bootID != "" && f.bootID != boot && !f.highWaterWall.IsZero() && now.Before(f.highWaterWall.Add(-HighWaterSlack)) {
		return true, ExpiryClockRollback
	}
	return false, ""
}

// SystemClock is the real clock.
func SystemClock() Clock { return systemClock{} }

type systemClock struct{}

func (systemClock) Now() time.Time      { return time.Now() }
func (systemClock) Mono() time.Duration { return systemMono() }
func (systemClock) BootID() string      { return systemBootID() }

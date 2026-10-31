package updater

import (
	"errors"
	"math/rand/v2"
	"sync"
	"time"
)

// Backoff for an upgrade target whose artifact failed verification (#7516).
//
// A checksum or manifest failure is deterministic for a given target: the
// server will hand back the same bytes and the same expected checksum on the
// next attempt, so retrying on every heartbeat only burns bandwidth and API
// capacity. On 2026-09-29 a deploy-before-promote window made every offer
// unsatisfiable and the fleet retried about once a minute (up to 2,282
// attempts per device in 8 hours), which saturated the US API.
//
// The wait uses decorrelated jitter per consecutive failure of the SAME
// target: each delay is drawn uniformly from [TargetBackoffBase,
// min(TargetBackoffMax, 3 * previous delay)], starting from a previous delay
// of TargetBackoffBase. Waits therefore grow on average, never drop below the
// base, never exceed the cap, and a fleet that fails on the same deploy does
// not retry in lockstep. It is not a permanent stop, because
// the operator can fix the server side without changing the version (by
// redeploying matching binaries), and the device must then recover on its own.
// A different target version is never held back. When the operator promotes
// the build the server actually holds, the device upgrades on the next
// heartbeat.
const (
	TargetBackoffBase = 5 * time.Minute
	TargetBackoffMax  = 2 * time.Hour
)

// TargetBackoff tracks, per component, the one target version currently being
// backed off. The zero value is ready to use and safe for concurrent use.
// State is in memory only: an agent restart starts every target fresh.
type TargetBackoff struct {
	// Now is the clock; nil means time.Now. A test seam.
	Now func() time.Time
	// Rand returns a uniform value in [0, n) for n > 0; nil means
	// math/rand/v2. A test seam that pins the jitter.
	Rand func(n int64) int64

	mu      sync.Mutex
	entries map[string]targetBackoffEntry
}

type targetBackoffEntry struct {
	version  string
	failures int
	delay    time.Duration // the last delay applied; seeds the next draw
	until    time.Time
}

func (b *TargetBackoff) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

// Remaining reports whether component's target version is inside its backoff
// window and, if so, how long is left.
func (b *TargetBackoff) Remaining(component, version string) (time.Duration, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	e, ok := b.entries[component]
	if !ok || e.version != version {
		return 0, false
	}
	left := e.until.Sub(b.now())
	if left <= 0 {
		return 0, false
	}
	return left, true
}

// NoteFailure records a deterministic failure of component at version and
// starts its backoff. A version different from the one being tracked starts a
// new streak. Returns the consecutive-failure count and the wait applied.
func (b *TargetBackoff) NoteFailure(component, version string) (int, time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.entries == nil {
		b.entries = make(map[string]targetBackoffEntry)
	}
	e := b.entries[component]
	if e.version != version {
		e = targetBackoffEntry{version: version}
	}
	e.failures++
	delay := b.nextDelay(e.delay)
	e.delay = delay
	e.until = b.now().Add(delay)
	b.entries[component] = e
	return e.failures, delay
}

// Clear forgets component's streak, e.g. after a successful download.
func (b *TargetBackoff) Clear(component string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.entries, component)
}

// nextDelay draws the next decorrelated-jitter delay from the previous one (0
// at the start of a streak): uniform in [base, min(cap, 3*prev)].
func (b *TargetBackoff) nextDelay(prev time.Duration) time.Duration {
	if prev < TargetBackoffBase {
		prev = TargetBackoffBase
	}
	upper := TargetBackoffMax
	if prev < TargetBackoffMax/3 {
		upper = 3 * prev
	}
	span := int64(upper - TargetBackoffBase)
	if span <= 0 {
		return TargetBackoffBase
	}
	randN := b.Rand
	if randN == nil {
		randN = rand.Int64N
	}
	r := randN(span)
	if r < 0 || r >= span {
		r = 0 // a misbehaving seam must not break the bounds
	}
	return TargetBackoffBase + time.Duration(r)
}

// IsDeterministicArtifactFailure reports whether err means the artifact the
// server serves for this target cannot be verified, so an immediate retry
// would fail the same way: a checksum or size mismatch, or a manifest whose
// signature or signing key is rejected. Transport errors, 5xx/429, locked
// files and the like are transient and are not included. ErrUntrustedRelease
// (a 409 from the server) and ErrCodeSignatureInvalid are also excluded,
// because their callers already apply their own per-target cooldowns.
func IsDeterministicArtifactFailure(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, ErrChecksumMismatch) ||
		errors.Is(err, ErrManifestSignature) ||
		errors.Is(err, ErrManifestKey)
}

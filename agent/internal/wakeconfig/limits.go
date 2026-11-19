package wakeconfig

import "time"

// Write limits for Windows, NIC and (from W04) firmware settings. One attempt
// per setting per 24 h, and a setting stops being attempted after three
// consecutive failures until the policy fingerprint changes.
const (
	attemptInterval = 24 * time.Hour
	maxFailures     = 3
)

// LimitEntry is the persisted history of one setting key.
type LimitEntry struct {
	LastAttemptAt time.Time `json:"lastAttemptAt"`
	// Failures counts consecutive failures. An attempt is recorded as a failure
	// before the write runs and cleared once it reads back correct, so a crash
	// mid-write still counts against the setting.
	Failures int `json:"failures"`
}

// Limiter is persisted in the wake status state file. It fails closed: an
// unreadable or corrupt state file sets EmbargoUntil instead of handing out a
// fresh budget.
type Limiter struct {
	PolicyFingerprint string                `json:"policyFingerprint"`
	EmbargoUntil      time.Time             `json:"embargoUntil,omitzero"`
	Entries           map[string]LimitEntry `json:"entries,omitempty"`
}

// Observe resets the per-setting history when the policy fingerprint changed.
// The embargo is not lifted by a policy change.
func (l *Limiter) Observe(policyFP string) {
	if l.PolicyFingerprint == policyFP {
		return
	}
	l.PolicyFingerprint = policyFP
	l.Entries = nil
}

// Blocked reports whether the key has used up its consecutive failures.
func (l *Limiter) Blocked(key string) bool {
	return l.Entries[key].Failures >= maxFailures
}

// Allow reports whether the key may be attempted at now. A last attempt in the
// future (the clock went backwards) is treated as just now, so the key waits a
// full interval rather than being retried at once or locked out for years.
func (l *Limiter) Allow(key string, now time.Time) bool {
	if now.Before(l.EmbargoUntil) {
		return false
	}
	e, ok := l.Entries[key]
	if !ok {
		return true
	}
	if e.Failures >= maxFailures {
		return false
	}
	if e.LastAttemptAt.After(now) {
		e.LastAttemptAt = now
		l.Entries[key] = e
		return false
	}
	return now.Sub(e.LastAttemptAt) >= attemptInterval
}

// begin records an attempt as a provisional failure.
func (l *Limiter) begin(key string, now time.Time) {
	if l.Entries == nil {
		l.Entries = map[string]LimitEntry{}
	}
	e := l.Entries[key]
	e.LastAttemptAt = now
	e.Failures++
	l.Entries[key] = e
}

// succeeded clears the provisional failure; the attempt time stays so the
// 24 h limit holds for drift re-apply as well.
func (l *Limiter) succeeded(key string) {
	e := l.Entries[key]
	e.Failures = 0
	l.Entries[key] = e
}

// failures returns the consecutive failure count for key.
func (l *Limiter) failures(key string) int { return l.Entries[key].Failures }

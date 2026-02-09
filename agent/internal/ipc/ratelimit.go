package ipc

import (
	"sync"
	"time"
)

// RateLimiter provides per-identity connection rate limiting.
// Max attempts per window (sliding). In-memory only — IPC is local.
// Keys are identity strings: UID on Unix, SID on Windows.
type RateLimiter struct {
	maxAttempts int
	window      time.Duration
	mu          sync.Mutex
	attempts    map[string][]time.Time
	lastCleanup time.Time
}

// cleanupInterval controls how often we scan for and remove stale entries.
const cleanupInterval = 5 * time.Minute

// NewRateLimiter creates a rate limiter with the given max attempts per window.
func NewRateLimiter(maxAttempts int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		maxAttempts: maxAttempts,
		window:      window,
		attempts:    make(map[string][]time.Time),
		lastCleanup: time.Now(),
	}
}

// Allow checks whether an identity key is allowed to connect. If allowed, it records the attempt.
func (r *RateLimiter) Allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-r.window)

	// Periodically prune departed identities
	if now.Sub(r.lastCleanup) > cleanupInterval {
		for k, times := range r.attempts {
			allExpired := true
			for _, t := range times {
				if t.After(cutoff) {
					allExpired = false
					break
				}
			}
			if allExpired {
				delete(r.attempts, k)
			}
		}
		r.lastCleanup = now
	}

	// Prune expired entries for this key
	existing := r.attempts[key]
	pruned := make([]time.Time, 0, len(existing))
	for _, t := range existing {
		if t.After(cutoff) {
			pruned = append(pruned, t)
		}
	}

	if len(pruned) >= r.maxAttempts {
		r.attempts[key] = pruned
		return false
	}

	r.attempts[key] = append(pruned, now)
	return true
}

// Reset clears all rate limit state (for testing).
func (r *RateLimiter) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.attempts = make(map[string][]time.Time)
}

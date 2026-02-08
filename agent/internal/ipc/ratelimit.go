package ipc

import (
	"sync"
	"time"
)

// RateLimiter provides per-UID connection rate limiting.
// Max attempts per window (sliding). In-memory only — IPC is local.
type RateLimiter struct {
	maxAttempts int
	window      time.Duration
	mu          sync.Mutex
	attempts    map[uint32][]time.Time
	lastCleanup time.Time
}

// cleanupInterval controls how often we scan for and remove stale UIDs.
const cleanupInterval = 5 * time.Minute

// NewRateLimiter creates a rate limiter with the given max attempts per window.
func NewRateLimiter(maxAttempts int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		maxAttempts: maxAttempts,
		window:      window,
		attempts:    make(map[uint32][]time.Time),
		lastCleanup: time.Now(),
	}
}

// Allow checks whether a UID is allowed to connect. If allowed, it records the attempt.
func (r *RateLimiter) Allow(uid uint32) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-r.window)

	// Periodically prune departed UIDs
	if now.Sub(r.lastCleanup) > cleanupInterval {
		for u, times := range r.attempts {
			allExpired := true
			for _, t := range times {
				if t.After(cutoff) {
					allExpired = false
					break
				}
			}
			if allExpired {
				delete(r.attempts, u)
			}
		}
		r.lastCleanup = now
	}

	// Prune expired entries for this UID (allocate new slice to avoid retaining old data)
	existing := r.attempts[uid]
	pruned := make([]time.Time, 0, len(existing))
	for _, t := range existing {
		if t.After(cutoff) {
			pruned = append(pruned, t)
		}
	}

	if len(pruned) >= r.maxAttempts {
		r.attempts[uid] = pruned
		return false
	}

	r.attempts[uid] = append(pruned, now)
	return true
}

// Reset clears all rate limit state (for testing).
func (r *RateLimiter) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.attempts = make(map[uint32][]time.Time)
}

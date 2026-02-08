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
}

// NewRateLimiter creates a rate limiter with the given max attempts per window.
func NewRateLimiter(maxAttempts int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		maxAttempts: maxAttempts,
		window:      window,
		attempts:    make(map[uint32][]time.Time),
	}
}

// Allow checks whether a UID is allowed to connect. If allowed, it records the attempt.
func (r *RateLimiter) Allow(uid uint32) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-r.window)

	// Prune expired entries
	existing := r.attempts[uid]
	pruned := existing[:0]
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

package collectors

import (
	"sync"
	"time"
)

// hostProbeAvailabilityTTL is how long an answer about an optional host tool
// is trusted. Installing the tool is rare and a day is soon enough to notice,
// so a host without it pays for one check a day instead of one failure per
// tick (#10911). Same TTL as the security package's BitLocker and Defender
// gates.
const hostProbeAvailabilityTTL = 24 * time.Hour

// cachedHostProbe remembers the answer to a cheap question about the host (is
// this tool installed, which source applies here) for ttl. Each detect runs
// under the lock so concurrent callers share one check.
type cachedHostProbe[T any] struct {
	ttl    time.Duration
	detect func() T
	now    func() time.Time

	mu        sync.Mutex
	value     T
	checkedAt time.Time
	valid     bool
}

func newCachedHostProbe[T any](ttl time.Duration, detect func() T) *cachedHostProbe[T] {
	return &cachedHostProbe[T]{ttl: ttl, detect: detect, now: time.Now}
}

func (p *cachedHostProbe[T]) get() T {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	if !p.valid || now.Sub(p.checkedAt) >= p.ttl {
		p.value = p.detect()
		p.checkedAt = now
		p.valid = true
	}
	return p.value
}

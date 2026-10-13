package sim

import (
	"math"
	"sync"
	"sync/atomic"
	"time"
)

// Bucket is one timeline step. Counts are events that happened inside the
// step; WSLive is the live-socket gauge sampled in it.
type Bucket struct {
	T                 float64 `json:"t"` // seconds from run start
	WSLive            int64   `json:"wsLive"`
	WSConnects        uint64  `json:"wsConnects"`
	WSConnectFailures uint64  `json:"wsConnectFailures"`
	WSDisconnects     uint64  `json:"wsDisconnects"`
	Heartbeats        uint64  `json:"heartbeats"`     // logical heartbeats completed (after retries)
	HeartbeatSlow     uint64  `json:"heartbeatSlow"`  // heartbeat attempts over 1 s
	HeartbeatsLost    uint64  `json:"heartbeatsLost"` // logical heartbeats that failed after retries
	RequestsLost      uint64  `json:"requestsLost"`   // logical requests (any route) that failed after retries
	Attempts503       uint64  `json:"attempts503"`
	Attempts429       uint64  `json:"attempts429"`
	TransportErrors   uint64  `json:"transportErrors"`
	MaxHeartbeatGapS  float64 `json:"maxHeartbeatGapS"`
}

// slowHeartbeat is the descriptive per-second "slow" cut (spec G3's 1 s
// figure). It is a bucket boundary, not a gate.
const slowHeartbeat = time.Second

// Timeline holds one bucket per step over the whole run, plus the
// live-socket gauge (sockets whose serve loop is running).
type Timeline struct {
	mu      sync.Mutex
	start   time.Time
	step    time.Duration
	buckets []Bucket
	sampled int // highest bucket index SampleLive has written; -1 = none

	live atomic.Int64
}

// NewTimeline allocates ceil(length/step) buckets starting at start.
func NewTimeline(start time.Time, step, length time.Duration) *Timeline {
	if step <= 0 {
		step = time.Second
	}
	n := int((length + step - 1) / step)
	if n < 0 {
		n = 0
	}
	b := make([]Bucket, n)
	for i := range b {
		b[i].T = (time.Duration(i) * step).Seconds()
	}
	return &Timeline{start: start, step: step, buckets: b, sampled: -1}
}

// index returns the bucket index for ts, or -1 outside [start, start+length).
func (t *Timeline) index(ts time.Time) int {
	if ts.Before(t.start) {
		return -1
	}
	i := int(ts.Sub(t.start) / t.step)
	if i >= len(t.buckets) {
		return -1
	}
	return i
}

// at returns the bucket for ts or nil; the caller holds t.mu.
func (t *Timeline) at(ts time.Time) *Bucket {
	i := t.index(ts)
	if i < 0 {
		return nil
	}
	return &t.buckets[i]
}

func (t *Timeline) update(ts time.Time, f func(b *Bucket)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if b := t.at(ts); b != nil {
		f(b)
	}
}

func (t *Timeline) WSConnect(ts time.Time) { t.update(ts, func(b *Bucket) { b.WSConnects++ }) }
func (t *Timeline) WSConnectFailed(ts time.Time) {
	t.update(ts, func(b *Bucket) { b.WSConnectFailures++ })
}
func (t *Timeline) WSDisconnect(ts time.Time) { t.update(ts, func(b *Bucket) { b.WSDisconnects++ }) }

// SocketUp / SocketDown move the live gauge; SampleLive writes it into a bucket.
func (t *Timeline) SocketUp()   { t.live.Add(1) }
func (t *Timeline) SocketDown() { t.live.Add(-1) }

// SampleLive writes the current gauge into the bucket for ts and into every
// bucket since the previous sample that a late tick skipped, so a missed
// tick never reads as zero live sockets.
func (t *Timeline) SampleLive(ts time.Time) {
	v := t.live.Load()
	t.mu.Lock()
	defer t.mu.Unlock()
	i := t.index(ts)
	if i < 0 {
		return
	}
	from := i
	if t.sampled >= 0 && t.sampled < i {
		from = t.sampled + 1
	}
	for j := from; j <= i; j++ {
		t.buckets[j].WSLive = v
	}
	if i > t.sampled {
		t.sampled = i
	}
}

func countStatus(b *Bucket, status int, err error) {
	switch {
	case err != nil:
		b.TransportErrors++
	case status == 503:
		b.Attempts503++
	case status == 429:
		b.Attempts429++
	}
}

// HeartbeatAttempt records one heartbeat attempt (first try or retry).
func (t *Timeline) HeartbeatAttempt(ts time.Time, latency time.Duration, status int, err error) {
	t.update(ts, func(b *Bucket) {
		if err == nil && latency > slowHeartbeat {
			b.HeartbeatSlow++
		}
		countStatus(b, status, err)
	})
}

// Attempt records one attempt on a non-heartbeat route (503/429/transport only).
func (t *Timeline) Attempt(ts time.Time, status int, err error) {
	t.update(ts, func(b *Bucket) { countStatus(b, status, err) })
}

// Outcome records one logical request's final result, after the agent's retries.
func (t *Timeline) Outcome(route string, ts time.Time, ok bool) {
	t.update(ts, func(b *Bucket) {
		if route == RouteHeartbeat {
			b.Heartbeats++
			if !ok {
				b.HeartbeatsLost++
			}
		}
		if !ok {
			b.RequestsLost++
		}
	})
}

// HeartbeatGap records the time between one agent's consecutive successful
// heartbeats, as the maximum per bucket, in seconds.
func (t *Timeline) HeartbeatGap(ts time.Time, gap time.Duration) {
	t.update(ts, func(b *Bucket) { b.MaxHeartbeatGapS = math.Max(b.MaxHeartbeatGapS, gap.Seconds()) })
}

// Step is the bucket width.
func (t *Timeline) Step() time.Duration { return t.step }

// Buckets returns a copy of every bucket.
func (t *Timeline) Buckets() []Bucket {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]Bucket(nil), t.buckets...)
}

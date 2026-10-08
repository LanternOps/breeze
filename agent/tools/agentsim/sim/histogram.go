package sim

import (
	"math"
	"sync"
	"time"
)

// Histogram is a fixed log-bucket latency histogram: bucket i covers
// [base·growth^i, base·growth^(i+1)). With base 0.1 ms and growth 1.02 any
// reported quantile is within 2 % of the true value, and an hour of 2,000
// agents costs a few KB per route instead of one sample per request.
type Histogram struct {
	mu     sync.Mutex
	counts []uint64
	total  uint64
	max    time.Duration
}

const (
	histBase    = 100 * time.Microsecond
	histGrowth  = 1.02
	histBuckets = 720 // 0.1 ms · 1.02^720 ≈ 1,550 s, beyond any client timeout
)

func NewHistogram() *Histogram { return &Histogram{counts: make([]uint64, histBuckets)} }

func bucketFor(d time.Duration) int {
	if d <= histBase {
		return 0
	}
	i := int(math.Log(float64(d)/float64(histBase)) / math.Log(histGrowth))
	if i >= histBuckets {
		return histBuckets - 1
	}
	return i
}

func (h *Histogram) Observe(d time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.counts[bucketFor(d)]++
	h.total++
	if d > h.max {
		h.max = d
	}
}

// Quantile returns the upper edge of the bucket that holds quantile q, in
// milliseconds, capped at the observed maximum. Zero when empty.
func (h *Histogram) Quantile(q float64) float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.total == 0 {
		return 0
	}
	rank := uint64(math.Ceil(q * float64(h.total)))
	if rank == 0 {
		rank = 1
	}
	maxMs := float64(h.max) / float64(time.Millisecond)
	var seen uint64
	for i, c := range h.counts {
		seen += c
		if seen >= rank {
			upper := float64(histBase) * math.Pow(histGrowth, float64(i+1)) / float64(time.Millisecond)
			return math.Min(upper, maxMs)
		}
	}
	return maxMs
}

func (h *Histogram) Count() uint64 { h.mu.Lock(); defer h.mu.Unlock(); return h.total }

func (h *Histogram) MaxMs() float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return float64(h.max) / float64(time.Millisecond)
}

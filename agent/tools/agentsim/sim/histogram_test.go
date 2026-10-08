package sim

import (
	"math"
	"testing"
	"time"
)

func TestHistogramQuantilesWithinTwoPercent(t *testing.T) {
	h := NewHistogram()
	for ms := 1; ms <= 1000; ms++ {
		h.Observe(time.Duration(ms) * time.Millisecond)
	}
	for q, want := range map[float64]float64{0.50: 500, 0.95: 950, 0.99: 990} {
		got := h.Quantile(q)
		if math.Abs(got-want)/want > 0.02 {
			t.Errorf("p%.0f = %.2f ms, want %.0f ±2%%", q*100, got, want)
		}
	}
	if h.Count() != 1000 || h.MaxMs() != 1000 {
		t.Fatalf("count %d max %.1f", h.Count(), h.MaxMs())
	}
}

func TestEmptyHistogramIsZero(t *testing.T) {
	h := NewHistogram()
	if h.Quantile(0.99) != 0 || h.MaxMs() != 0 || h.Count() != 0 {
		t.Fatal("empty histogram must report zeros")
	}
}

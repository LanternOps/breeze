package wire

import (
	"math"
	"testing"
)

func TestJSONMillis(t *testing.T) {
	for _, c := range []struct {
		in   float64
		want int64
	}{
		{0, 0}, {-4, 0}, {math.NaN(), 0}, {math.Inf(-1), 0},
		{60000.9, 60000}, {1e30, 1 << 53}, {math.Inf(1), 1 << 53},
	} {
		if got := JSONMillis(c.in); got != c.want {
			t.Errorf("JSONMillis(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}

package heartbeat

import "testing"

func TestClampProcessSampleInterval(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{in: 0, want: 60},      // unset/zero → floor (no NewTicker(0) panic)
		{in: -5, want: 60},     // negative → floor
		{in: 30, want: 60},     // below min → floor
		{in: 60, want: 60},     // min boundary
		{in: 180, want: 180},   // default, in range
		{in: 3600, want: 3600}, // max boundary
		{in: 9999, want: 3600}, // above max → ceiling
	}
	for _, c := range cases {
		if got := clampProcessSampleInterval(c.in); got != c.want {
			t.Errorf("clampProcessSampleInterval(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

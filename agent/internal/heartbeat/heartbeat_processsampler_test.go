package heartbeat

import (
	"testing"
	"time"
)

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

func TestClampPatchScanIntervalHours(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{in: 0, want: 24},    // unset/zero → default 24 h
		{in: -1, want: 24},   // negative → default 24 h
		{in: 1, want: 1},     // min boundary
		{in: 24, want: 24},   // default, in range
		{in: 48, want: 48},   // arbitrary in-range value
		{in: 168, want: 168}, // max boundary (7 days)
		{in: 500, want: 168}, // above max → ceiling
	}
	for _, c := range cases {
		if got := clampPatchScanIntervalHours(c.in); got != c.want {
			t.Errorf("clampPatchScanIntervalHours(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestDueForRun(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	day := 24 * time.Hour
	cases := []struct {
		name     string
		last     time.Time
		interval time.Duration
		want     bool
	}{
		{name: "never run (zero value) is always due", last: time.Time{}, interval: day, want: true},
		{name: "interval fully elapsed", last: now.Add(-25 * time.Hour), interval: day, want: true},
		{name: "interval not yet elapsed", last: now.Add(-1 * time.Hour), interval: day, want: false},
		{name: "exactly at boundary is not due", last: now.Add(-day), interval: day, want: false},
		{name: "just past boundary is due", last: now.Add(-day - time.Second), interval: day, want: true},
	}
	for _, c := range cases {
		if got := dueForRun(now, c.last, c.interval); got != c.want {
			t.Errorf("%s: dueForRun = %v, want %v", c.name, got, c.want)
		}
	}
}

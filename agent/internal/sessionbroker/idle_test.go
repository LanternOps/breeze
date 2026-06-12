package sessionbroker

import (
	"testing"
	"time"
)

func TestFiletimeToTime(t *testing.T) {
	tests := []struct {
		name string
		ft   uint64
		want time.Time
	}{
		// Zero FILETIME means "no input recorded" (known console-session quirk);
		// must map to the zero time, never to 1601-01-01.
		{name: "zero_is_zero_time", ft: 0, want: time.Time{}},
		// 116444736000000000 = 100ns intervals between 1601-01-01 and 1970-01-01.
		{name: "unix_epoch", ft: 116444736000000000, want: time.Unix(0, 0).UTC()},
		// One second past the unix epoch (10_000_000 * 100ns = 1s).
		{name: "epoch_plus_1s", ft: 116444736000000000 + 10_000_000, want: time.Unix(1, 0).UTC()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := filetimeToTime(tt.ft)
			if !got.Equal(tt.want) {
				t.Fatalf("filetimeToTime(%d) = %v, want %v", tt.ft, got, tt.want)
			}
		})
	}
}

func TestIdleSince(t *testing.T) {
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		lastInput time.Time
		wantIdle  time.Duration
		wantKnown bool
	}{
		{name: "zero_last_input_is_unknown", lastInput: time.Time{}, wantIdle: 0, wantKnown: false},
		{name: "23_minutes_ago", lastInput: now.Add(-23 * time.Minute), wantIdle: 23 * time.Minute, wantKnown: true},
		{name: "future_input_clamps_to_zero", lastInput: now.Add(5 * time.Minute), wantIdle: 0, wantKnown: true},
		{name: "exactly_now", lastInput: now, wantIdle: 0, wantKnown: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			idle, known := idleSince(now, tt.lastInput)
			if idle != tt.wantIdle || known != tt.wantKnown {
				t.Fatalf("idleSince() = (%v, %v), want (%v, %v)", idle, known, tt.wantIdle, tt.wantKnown)
			}
		})
	}
}

func TestParseIdleSinceHint(t *testing.T) {
	tests := []struct {
		name   string
		value  string
		want   time.Time
		wantOK bool
	}{
		{name: "empty_is_unknown", value: "", wantOK: false},
		{name: "zero_is_unknown", value: "0", wantOK: false},
		// systemd usually prints the raw dbus value: microseconds since epoch.
		{name: "usec_integer", value: "1781265600000000", want: time.Unix(1781265600, 0).UTC(), wantOK: true},
		// Some loginctl versions print a formatted timestamp instead.
		{name: "formatted_timestamp", value: "Thu 2026-06-11 10:30:00 UTC",
			want: time.Date(2026, 6, 11, 10, 30, 0, 0, time.UTC), wantOK: true},
		{name: "garbage_is_unknown", value: "not-a-time", wantOK: false},
		{name: "usec_overflow_is_unknown", value: "18446744073709551615", wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseIdleSinceHint(tt.value)
			if ok != tt.wantOK {
				t.Fatalf("parseIdleSinceHint(%q) ok = %v, want %v", tt.value, ok, tt.wantOK)
			}
			if ok && !got.Equal(tt.want) {
				t.Fatalf("parseIdleSinceHint(%q) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

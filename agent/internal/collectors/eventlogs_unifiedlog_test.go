package collectors

import (
	"strings"
	"testing"
	"time"
)

func TestBuildUnifiedLogPredicateMerged(t *testing.T) {
	t.Parallel()

	got := buildUnifiedLogPredicate(true, true)

	if !strings.Contains(got, securityUnifiedLogPredicate) {
		t.Errorf("merged predicate missing security clauses: %q", got)
	}
	if !strings.Contains(got, hardwareUnifiedLogPredicate) {
		t.Errorf("merged predicate missing hardware clauses: %q", got)
	}
	want := "(" + securityUnifiedLogPredicate + ") OR (" + hardwareUnifiedLogPredicate + ")"
	if !strings.Contains(got, want) {
		t.Errorf("merged predicate should OR the two category predicates: %q", got)
	}
	if !strings.HasSuffix(got, ") AND (messageType >= error)") {
		t.Errorf("merged predicate must keep the source-side messageType filter: %q", got)
	}
}

func TestBuildUnifiedLogPredicateSingleCategory(t *testing.T) {
	t.Parallel()

	secOnly := buildUnifiedLogPredicate(true, false)
	if !strings.Contains(secOnly, "com.apple.opendirectoryd") {
		t.Errorf("security-only predicate missing security clauses: %q", secOnly)
	}
	if strings.Contains(secOnly, "com.apple.iokit") {
		t.Errorf("security-only predicate must not include hardware clauses: %q", secOnly)
	}
	if !strings.HasSuffix(secOnly, ") AND (messageType >= error)") {
		t.Errorf("security-only predicate must keep the messageType filter: %q", secOnly)
	}

	hwOnly := buildUnifiedLogPredicate(false, true)
	if !strings.Contains(hwOnly, "com.apple.iokit") {
		t.Errorf("hardware-only predicate missing hardware clauses: %q", hwOnly)
	}
	if strings.Contains(hwOnly, "com.apple.opendirectoryd") || strings.Contains(hwOnly, "com.apple.TCC") {
		t.Errorf("hardware-only predicate must not include security clauses: %q", hwOnly)
	}

	if got := buildUnifiedLogPredicate(false, false); got != "" {
		t.Errorf("no enabled categories should produce empty predicate, got %q", got)
	}
}

func TestClassifyUnifiedLogCategory(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		subsystem string
		message   string
		security  bool
		hardware  bool
		want      string
	}{
		{"opendirectoryd is security", "com.apple.opendirectoryd", "od lookup failed", true, true, "security"},
		{"TCC is security", "com.apple.TCC", "prompting policy", true, true, "security"},
		{"authentication message is security", "com.apple.something", "User Authentication failure for admin", true, true, "security"},
		{"authentication match is case-insensitive", "", "AUTHENTICATION error", true, true, "security"},
		{"iokit falls through to hardware", "com.apple.iokit.IOUSBHostFamily", "device reset", true, true, "hardware"},
		{"thermal message is hardware", "", "thermal pressure state changed", true, true, "hardware"},
		{"security-only stamps security regardless", "com.apple.iokit.IOUSBHostFamily", "device reset", true, false, "security"},
		{"hardware-only stamps hardware regardless", "com.apple.TCC", "prompting policy", false, true, "hardware"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := classifyUnifiedLogCategory(tt.subsystem, tt.message, tt.security, tt.hardware)
			if got != tt.want {
				t.Errorf("classifyUnifiedLogCategory(%q, %q, %v, %v) = %q, want %q",
					tt.subsystem, tt.message, tt.security, tt.hardware, got, tt.want)
			}
		})
	}
}

func TestUnifiedLogQueryStart(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)

	// Within the lookback window: passed through unchanged (no floor
	// truncation — this is what closes the old --last window-gap bug).
	since := now.Add(-14*time.Minute - 30*time.Second)
	if got := unifiedLogQueryStart(since, now); !got.Equal(since) {
		t.Errorf("in-window since should be unchanged, got %v want %v", got, since)
	}

	// Older than the max lookback (e.g. reliability's 24h first-run lookback):
	// clamped to now - unifiedLogMaxLookback.
	old := now.Add(-24 * time.Hour)
	if got := unifiedLogQueryStart(old, now); !got.Equal(now.Add(-unifiedLogMaxLookback)) {
		t.Errorf("old since should clamp to max lookback, got %v", got)
	}

	// A future since (clock step) clamps to now.
	future := now.Add(5 * time.Minute)
	if got := unifiedLogQueryStart(future, now); !got.Equal(now) {
		t.Errorf("future since should clamp to now, got %v", got)
	}
}

func TestUnifiedLogStartFormat(t *testing.T) {
	t.Parallel()

	// Pins the exact "YYYY-MM-DD HH:MM:SSZZZZZ" shape log(1) documents for
	// --start. This is the only stringly-typed contract with `log show`; a
	// regression (e.g. RFC3339's "T" separator) would kill security+hardware
	// collection fleet-wide on macOS with nothing but an agent-local Warn.
	ts := time.Date(2026, 7, 12, 12, 0, 0, 0, time.FixedZone("MDT", -6*60*60))
	if got := ts.Format(unifiedLogStartFormat); got != "2026-07-12 12:00:00-0600" {
		t.Errorf("unifiedLogStartFormat produced %q, want %q", got, "2026-07-12 12:00:00-0600")
	}
	if got := ts.UTC().Format(unifiedLogStartFormat); got != "2026-07-12 18:00:00+0000" {
		t.Errorf("unifiedLogStartFormat (UTC) produced %q, want %q", got, "2026-07-12 18:00:00+0000")
	}
}

func TestDefaultEventLogIntervalIsFifteenMinutes(t *testing.T) {
	t.Parallel()

	// Issue #2390: 5m default caused sustained subprocess churn on macOS.
	if got := NewEventLogCollector().IntervalMinutes(); got != 15 {
		t.Errorf("default intervalMinutes = %d, want 15", got)
	}
}

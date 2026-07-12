package collectors

import (
	"errors"
	"strings"
	"sync"
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

func TestRunEventLogSubCollectorsIsolatesFailingSource(t *testing.T) {
	t.Parallel()

	// Regression guard for the GAP-2 review finding on #2393: a persistently
	// failing unified-log query must NOT freeze the watermarks of the healthy
	// sources. With a shared watermark, the healthy sources' windows grew
	// unboundedly from the frozen `since`, and after the maxEvents cap the
	// oldest (already-sent) events won every pass — NEW crash/power events
	// were silently starved out.
	seed := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	c := NewEventLogCollector()
	c.lastCollectTime = seed

	var mu sync.Mutex
	var healthySince []time.Time
	var failingSince []time.Time

	subs := []eventLogSubCollector{
		{name: "unifiedlog", fn: func(since time.Time) ([]EventLogEntry, error) {
			mu.Lock()
			failingSince = append(failingSince, since)
			mu.Unlock()
			return nil, errors.New("log show timed out")
		}},
		{name: "power", fn: func(since time.Time) ([]EventLogEntry, error) {
			mu.Lock()
			healthySince = append(healthySince, since)
			mu.Unlock()
			return []EventLogEntry{{Category: "system", Level: "warning", EventID: "power:test"}}, nil
		}},
	}

	pass1 := seed.Add(15 * time.Minute)
	pass2 := seed.Add(30 * time.Minute)

	events := c.runEventLogSubCollectors(subs, pass1)
	if len(events) != 1 || events[0].Category != "system" {
		t.Fatalf("pass 1: healthy source's events must flow despite sibling failure, got %v", events)
	}
	events = c.runEventLogSubCollectors(subs, pass2)
	if len(events) != 1 {
		t.Fatalf("pass 2: healthy source's events must keep flowing, got %v", events)
	}

	// Healthy source advanced: first window starts at the seed, second at pass1.
	if !healthySince[0].Equal(seed) || !healthySince[1].Equal(pass1) {
		t.Errorf("healthy source windows = %v, want [%v %v]", healthySince, seed, pass1)
	}
	// Failing source retries its own window from the seed both times.
	if !failingSince[0].Equal(seed) || !failingSince[1].Equal(seed) {
		t.Errorf("failing source windows = %v, want [%v %v]", failingSince, seed, seed)
	}
	// And the failing source's stall is invisible to the healthy watermark.
	if got := c.sourceSince("power"); !got.Equal(pass2) {
		t.Errorf("power watermark = %v, want %v", got, pass2)
	}
	if got := c.sourceSince("unifiedlog"); !got.Equal(seed) {
		t.Errorf("unifiedlog watermark = %v, want seed %v", got, seed)
	}
}

func TestSourceWatermarkFallsBackToSeed(t *testing.T) {
	t.Parallel()

	seed := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	c := NewEventLogCollector()
	c.lastCollectTime = seed

	// Before any success, every source uses the shared seed — this is what
	// preserves the reliability collector's initial-lookback stamping.
	if got := c.sourceSince("unifiedlog"); !got.Equal(seed) {
		t.Errorf("sourceSince before success = %v, want seed %v", got, seed)
	}

	later := seed.Add(time.Hour)
	c.advanceSourceWatermark("unifiedlog", later)
	if got := c.sourceSince("unifiedlog"); !got.Equal(later) {
		t.Errorf("sourceSince after advance = %v, want %v", got, later)
	}
	// Other sources are unaffected.
	if got := c.sourceSince("power"); !got.Equal(seed) {
		t.Errorf("sibling sourceSince = %v, want seed %v", got, seed)
	}
}

func TestDefaultEventLogIntervalIsFifteenMinutes(t *testing.T) {
	t.Parallel()

	// Issue #2390: 5m default caused sustained subprocess churn on macOS.
	if got := NewEventLogCollector().IntervalMinutes(); got != 15 {
		t.Errorf("default intervalMinutes = %d, want 15", got)
	}
}

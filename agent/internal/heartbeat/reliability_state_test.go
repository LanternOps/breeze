package heartbeat

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// useTempHome points os.UserHomeDir at a throwaway dir so the reliability state
// file lands under <tmp>/.breeze instead of the real home directory.
func useTempHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)        // unix
	t.Setenv("USERPROFILE", tmp) // windows
	return tmp
}

func TestReliabilityStateRoundTrip(t *testing.T) {
	tmp := useTempHome(t)
	h := &Heartbeat{}

	// No state yet → zero time, so the caller treats it as "never sent".
	if got := h.loadLastReliabilityUpdate(); !got.IsZero() {
		t.Fatalf("expected zero time for missing state, got %v", got)
	}

	want := time.Now().UTC().Truncate(time.Second)
	if err := h.saveLastReliabilityUpdate(want); err != nil {
		t.Fatalf("saveLastReliabilityUpdate: %v", err)
	}

	if got := h.loadLastReliabilityUpdate(); !got.Equal(want) {
		t.Fatalf("round-trip mismatch: want %v, got %v", want, got)
	}

	// File persisted under <home>/.breeze/.
	if _, err := os.Stat(filepath.Join(tmp, ".breeze", reliabilityStateFileName)); err != nil {
		t.Fatalf("reliability state file not at expected path: %v", err)
	}
}

func TestLoadLastReliabilityUpdateCorruptIsZero(t *testing.T) {
	tmp := useTempHome(t)
	h := &Heartbeat{}

	dir := filepath.Join(tmp, ".breeze")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, reliabilityStateFileName), []byte("{not valid json"), 0600); err != nil {
		t.Fatal(err)
	}

	// Corrupt state must fail open to "never sent", not crash or block sends.
	if got := h.loadLastReliabilityUpdate(); !got.IsZero() {
		t.Fatalf("expected zero time for corrupt state, got %v", got)
	}
}

// reliabilityPostDue is the gate that defines #1906's fix: a recently-sent
// (persisted) timestamp must suppress the next post, while a stale/zero one
// must let it through. Table-tested directly so a flipped comparison or lost
// seed is caught without driving the heartbeat loop.
func TestReliabilityPostDue(t *testing.T) {
	now := time.Date(2026, 6, 25, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		last time.Time
		want bool
	}{
		{"never sent (zero) → due", time.Time{}, true},
		{"sent 25h ago → due", now.Add(-25 * time.Hour), true},
		{"sent just over 24h ago → due", now.Add(-24*time.Hour - time.Second), true},
		{"sent exactly 24h ago → not due", now.Add(-24 * time.Hour), false},
		{"sent 1h ago → not due", now.Add(-time.Hour), false},
		{"sent in the future (clock skew) → not due", now.Add(time.Hour), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := reliabilityPostDue(tc.last, now); got != tc.want {
				t.Fatalf("reliabilityPostDue(%v, now) = %v, want %v", tc.last, got, tc.want)
			}
		})
	}
}

// persistReliabilitySent must write a timestamp a restart can read back, and
// that timestamp must gate the next post (reliabilityPostDue == false).
func TestPersistReliabilitySentSurvivesRestart(t *testing.T) {
	useTempHome(t)
	h := &Heartbeat{}

	sentAt := time.Now().UTC().Truncate(time.Second)
	h.persistReliabilitySent(sentAt)

	// Simulate a restart: a fresh Heartbeat reading the same file must see it,
	// and the gate must NOT be due (so no immediate re-post on boot).
	restarted := &Heartbeat{}
	persisted := restarted.loadLastReliabilityUpdate()
	if !persisted.Equal(sentAt) {
		t.Fatalf("persisted timer not readable after restart: want %v, got %v", sentAt, persisted)
	}
	if reliabilityPostDue(persisted, time.Now()) {
		t.Fatalf("recently-sent timer should gate the next post, but it reported due: %v", persisted)
	}
}

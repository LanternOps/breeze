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

// markReliabilitySent must update both the in-memory timer and the persisted
// file, so a restart that reads the file gets the same gate value.
func TestMarkReliabilitySentPersistsAndSeeds(t *testing.T) {
	useTempHome(t)
	h := &Heartbeat{}

	sentAt := time.Now().UTC().Truncate(time.Second)
	h.markReliabilitySent(sentAt)

	h.mu.Lock()
	inMem := h.lastReliabilityUpdate
	h.mu.Unlock()
	if !inMem.Equal(sentAt) {
		t.Fatalf("in-memory timer not updated: want %v, got %v", sentAt, inMem)
	}

	// Simulate a restart: a fresh Heartbeat reading the same file must see it,
	// and the 24h gate must NOT have elapsed (so no immediate re-post).
	restarted := &Heartbeat{}
	persisted := restarted.loadLastReliabilityUpdate()
	if !persisted.Equal(sentAt) {
		t.Fatalf("persisted timer not readable after restart: want %v, got %v", sentAt, persisted)
	}
	if time.Since(persisted) > 24*time.Hour {
		t.Fatalf("recently-sent timer should gate the next post, but 24h already elapsed: %v", persisted)
	}
}

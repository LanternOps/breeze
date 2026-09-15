package desktopfence

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreLoadMissingFileIsEmpty(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "fence.json"))
	state, err := s.Load()
	if err != nil {
		t.Fatalf("Load on a missing file: %v", err)
	}
	if len(state.Sessions) != 0 {
		t.Fatalf("missing file must load empty, got %d sessions", len(state.Sessions))
	}
}

func TestStoreRoundTripsGenerationsAsDecimalStrings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fence.json")
	s := NewStore(path)
	// A generation above 2^53 must survive without float rounding.
	const big = int64(1) << 60
	in := State{Sessions: map[string]Entry{
		"s1": {HighWater: big + 1, HasHighWater: true, UpdatedAtUnixMs: 42},
		"s2": {Terminal: true, SyncedGeneration: 7},
	}}
	if err := s.Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"highWater":"1152921504606846977"`) {
		t.Fatalf("generation must be encoded as a decimal string, got %s", raw)
	}
	out, err := NewStore(path).Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if out.Sessions["s1"] != in.Sessions["s1"] || out.Sessions["s2"] != in.Sessions["s2"] {
		t.Fatalf("round trip mismatch:\n in=%#v\nout=%#v", in.Sessions, out.Sessions)
	}
}

// The join token and the in-process sync flag are process-local: neither
// survives a Save/Load round trip, so a restart can neither rejoin a call
// that no longer exists nor trust a sync it did not perform.
func TestStoreDoesNotPersistProcessLocalFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fence.json")
	s := NewStore(path)
	if err := s.Save(State{Sessions: map[string]Entry{
		"s": {HighWater: 3, HasHighWater: true, HighWaterCommandID: "cmd", Synced: true},
	}}); err != nil {
		t.Fatal(err)
	}
	out, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	got := out.Sessions["s"]
	if got.HighWaterCommandID != "" || got.Synced {
		t.Fatalf("process-local fields leaked through the store: %#v", got)
	}
	if got.HighWater != 3 || !got.HasHighWater {
		t.Fatalf("durable fields lost: %#v", got)
	}
}

func TestStoreSaveIsAtomicAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fence.json")
	s := NewStore(path)
	for i := int64(1); i <= 3; i++ {
		if err := s.Save(State{Sessions: map[string]Entry{"s": {HighWater: i, HasHighWater: true}}}); err != nil {
			t.Fatalf("Save %d: %v", i, err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "fence.json" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("expected only fence.json after atomic replace, got %v", names)
	}
	out, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if out.Sessions["s"].HighWater != 3 {
		t.Fatalf("last write must win, got %d", out.Sessions["s"].HighWater)
	}
}

func TestStoreCorruptFileIsQuarantined(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fence.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(path)
	_, err := s.Load()
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("corrupt file must surface ErrCorrupt, got %v", err)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("corrupt file must be moved aside, stat err=%v", statErr)
	}
	if _, statErr := os.Stat(path + ".corrupt"); statErr != nil {
		t.Fatalf("corrupt file must be preserved as .corrupt for forensics: %v", statErr)
	}
	// After quarantine the store is usable again.
	state, err := s.Load()
	if err != nil || len(state.Sessions) != 0 {
		t.Fatalf("Load after quarantine: state=%#v err=%v", state, err)
	}
}

func TestStoreRejectsNonCanonicalGeneration(t *testing.T) {
	for _, body := range []string{
		`{"schemaVersion":1,"sessions":{"s":{"highWater":7,"hasHighWater":true}}}`,
		`{"schemaVersion":1,"sessions":{"s":{"highWater":"007","hasHighWater":true}}}`,
		`{"schemaVersion":1,"sessions":{"s":{"highWater":"-1","hasHighWater":true}}}`,
		`{"schemaVersion":2,"sessions":{}}`,
	} {
		dir := t.TempDir()
		path := filepath.Join(dir, "fence.json")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := NewStore(path).Load(); !errors.Is(err, ErrCorrupt) {
			t.Fatalf("%s: want ErrCorrupt, got %v", body, err)
		}
	}
}

func TestStoreSaveFailureIsReported(t *testing.T) {
	dir := t.TempDir()
	// A file where the directory should be makes MkdirAll / CreateTemp fail.
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(filepath.Join(blocker, "fence.json"))
	if err := s.Save(State{}); err == nil {
		t.Fatal("Save into an unwritable location must fail")
	}
}

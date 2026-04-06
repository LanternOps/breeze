package watchdog

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestJournalWriteAndRead writes two entries and verifies Recent returns both
// with the correct level, event, and data fields.
func TestJournalWriteAndRead(t *testing.T) {
	dir := t.TempDir()
	j, err := NewJournal(dir, 1, 3)
	if err != nil {
		t.Fatalf("NewJournal: %v", err)
	}
	defer j.Close()

	j.Log(LevelInfo, "startup", map[string]any{"version": "1.0.0"})
	j.Log(LevelWarn, "high_cpu", map[string]any{"pct": 95})

	entries := j.Recent(10)
	if len(entries) != 2 {
		t.Fatalf("Recent(10) returned %d entries, want 2", len(entries))
	}

	e0 := entries[0]
	if e0.Level != LevelInfo {
		t.Errorf("entries[0].Level = %q, want %q", e0.Level, LevelInfo)
	}
	if e0.Event != "startup" {
		t.Errorf("entries[0].Event = %q, want %q", e0.Event, "startup")
	}
	if e0.Data["version"] != "1.0.0" {
		t.Errorf("entries[0].Data[version] = %v, want 1.0.0", e0.Data["version"])
	}
	if e0.Time.IsZero() {
		t.Error("entries[0].Time is zero")
	}

	e1 := entries[1]
	if e1.Level != LevelWarn {
		t.Errorf("entries[1].Level = %q, want %q", e1.Level, LevelWarn)
	}
	if e1.Event != "high_cpu" {
		t.Errorf("entries[1].Event = %q, want %q", e1.Event, "high_cpu")
	}
	// Recent() returns entries from the in-memory buffer — the original Go value
	// is stored (int), not a JSON-decoded float64. Accept both to be robust.
	switch pct := e1.Data["pct"].(type) {
	case float64:
		if pct != 95 {
			t.Errorf("entries[1].Data[pct] = %v, want 95", pct)
		}
	case int:
		if pct != 95 {
			t.Errorf("entries[1].Data[pct] = %v, want 95", pct)
		}
	default:
		t.Errorf("entries[1].Data[pct] unexpected type %T value %v", e1.Data["pct"], e1.Data["pct"])
	}
}

// TestJournalRecentLimit verifies that Recent(n) returns only the last n entries
// when more than n entries have been written.
func TestJournalRecentLimit(t *testing.T) {
	dir := t.TempDir()
	j, err := NewJournal(dir, 1, 3)
	if err != nil {
		t.Fatalf("NewJournal: %v", err)
	}
	defer j.Close()

	const total = 20
	for i := 0; i < total; i++ {
		j.Log(LevelInfo, fmt.Sprintf("event_%d", i), nil)
	}

	got := j.Recent(5)
	if len(got) != 5 {
		t.Fatalf("Recent(5) returned %d entries, want 5", len(got))
	}

	// The last 5 entries should be event_15 … event_19.
	for i, e := range got {
		want := fmt.Sprintf("event_%d", total-5+i)
		if e.Event != want {
			t.Errorf("got[%d].Event = %q, want %q", i, e.Event, want)
		}
	}
}

// TestJournalRotation writes enough data to trigger at least one rotation using
// a tiny maxSize (0 → minRotateSize = 4 KB), then checks that multiple files
// exist in the directory but not more than maxFiles rotated files.
func TestJournalRotation(t *testing.T) {
	dir := t.TempDir()
	const maxFiles = 2
	// Passing 0 for maxSizeMB → maxBytes = 0 < minRotateSize → clamped to 4096.
	j, err := NewJournal(dir, 0, maxFiles)
	if err != nil {
		t.Fatalf("NewJournal: %v", err)
	}
	defer j.Close()

	// Write enough data to rotate several times. Each entry is ~100 bytes;
	// 4096 / 100 ≈ 41 entries per file, so 200 entries should trigger ~4 rotations.
	payload := strings.Repeat("x", 80)
	for i := 0; i < 200; i++ {
		j.Log(LevelInfo, "fill", map[string]any{"pad": payload, "seq": i})
	}

	if err := j.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Count files in the directory.
	infos, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}

	var journalFiles []string
	for _, info := range infos {
		name := info.Name()
		if strings.HasPrefix(name, "watchdog-journal") && strings.HasSuffix(name, ".log") {
			journalFiles = append(journalFiles, name)
		}
	}

	// We expect more than 1 file (rotation happened).
	if len(journalFiles) < 2 {
		t.Fatalf("expected multiple journal files after rotation, got %d: %v",
			len(journalFiles), journalFiles)
	}

	// Count rotated files only (exclude the active file).
	var rotated []string
	for _, name := range journalFiles {
		if name != journalFileName {
			rotated = append(rotated, name)
		}
	}

	// Rotated file count must not exceed maxFiles.
	if len(rotated) > maxFiles {
		t.Fatalf("rotated file count = %d, want <= %d; files: %v",
			len(rotated), maxFiles, rotated)
	}

	// Verify ReadFromDisk works on the closed journal (reopen logic not needed
	// here — we call the helper directly).
	allEntries, err := readJournalDir(filepath.Join(dir))
	if err != nil {
		t.Fatalf("readJournalDir: %v", err)
	}
	if len(allEntries) == 0 {
		t.Error("ReadFromDisk returned no entries")
	}
}

package macrelocate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRecordRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if r, err := ReadRecord(dir); err != nil || r != nil {
		t.Fatalf("ReadRecord on empty dir = %+v, %v; want nil, nil", r, err)
	}
	want := Record{
		From:       "/usr/local/bin/breeze-agent",
		To:         "/Library/Breeze/bin/breeze-agent",
		RecordedAt: time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC),
	}
	if err := WriteRecord(dir, want); err != nil {
		t.Fatalf("WriteRecord: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, RecordFileName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("record mode = %o, want 0600", info.Mode().Perm())
	}
	got, err := ReadRecord(dir)
	if err != nil || got == nil {
		t.Fatalf("ReadRecord = %+v, %v", got, err)
	}
	if got.From != want.From || got.To != want.To || !got.RecordedAt.Equal(want.RecordedAt) {
		t.Fatalf("ReadRecord = %+v, want %+v", *got, want)
	}
	if err := ClearRecord(dir); err != nil {
		t.Fatalf("ClearRecord: %v", err)
	}
	if err := ClearRecord(dir); err != nil {
		t.Fatalf("ClearRecord on missing record must be a no-op, got %v", err)
	}
	if r, err := ReadRecord(dir); err != nil || r != nil {
		t.Fatalf("ReadRecord after clear = %+v, %v", r, err)
	}
}

func TestReadRecordRejectsCorruptRecord(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, RecordFileName), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRecord(dir); err == nil {
		t.Fatal("want an error for a corrupt record")
	}
}

func TestFDAGuidanceNamesTheNewPathAndFitsHealthReason(t *testing.T) {
	msg := FDAGuidance(Record{From: "/usr/local/bin/breeze-agent", To: "/Library/Breeze/bin/breeze-agent"})
	for _, want := range []string{"/usr/local/bin/breeze-agent", "/Library/Breeze/bin/breeze-agent", "Full Disk Access"} {
		if !strings.Contains(msg, want) {
			t.Errorf("guidance missing %q: %s", want, msg)
		}
	}
	// The API caps a health component reason at 512 characters; a longer one
	// would get the whole healthStatus observation dropped server-side.
	if len(msg) > 512 {
		t.Fatalf("guidance is %d chars, want <= 512", len(msg))
	}
}

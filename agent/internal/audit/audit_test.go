package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

func TestNilLoggerLogDoesNotPanic(t *testing.T) {
	var l *Logger
	l.Log("test_event", "cmd-1", map[string]any{"key": "value"})
	// Should not panic
}

func TestNilLoggerCloseDoesNotPanic(t *testing.T) {
	var l *Logger
	err := l.Close()
	if err != nil {
		t.Fatalf("nil Close() returned error: %v", err)
	}
}

func TestNilLoggerDroppedCountReturnsNegOne(t *testing.T) {
	var l *Logger
	got := l.DroppedCount()
	if got != -1 {
		t.Fatalf("nil DroppedCount() = %d, want -1", got)
	}
}

func TestWorkingLoggerDroppedCountReturnsZero(t *testing.T) {
	l := newTestLogger(t)
	defer l.Close()
	if got := l.DroppedCount(); got != 0 {
		t.Fatalf("DroppedCount() = %d, want 0", got)
	}
}

func TestLogWritesJSONLEntry(t *testing.T) {
	l := newTestLogger(t)
	l.Log(EventAgentStart, "", map[string]any{"version": "1.0"})
	l.Close()

	data, err := os.ReadFile(l.filePath)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}

	var entry Entry
	if err := json.Unmarshal([]byte(lines[0]), &entry); err != nil {
		t.Fatalf("unmarshal entry: %v", err)
	}

	if entry.EventType != EventAgentStart {
		t.Fatalf("eventType = %q, want %q", entry.EventType, EventAgentStart)
	}
	if entry.PrevHash != "genesis" {
		t.Fatalf("prevHash = %q, want genesis", entry.PrevHash)
	}
	if entry.EntryHash == "" {
		t.Fatal("entryHash is empty")
	}
}

func TestHashChainLinking(t *testing.T) {
	l := newTestLogger(t)
	l.Log(EventAgentStart, "", nil)
	l.Log(EventCommandReceived, "cmd-1", map[string]any{"type": "reboot"})
	l.Log(EventCommandExecuted, "cmd-1", map[string]any{"status": "completed"})
	l.Close()

	entries := readEntries(t, l.filePath)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}

	// First entry links to genesis
	if entries[0].PrevHash != "genesis" {
		t.Fatalf("entry[0].PrevHash = %q, want genesis", entries[0].PrevHash)
	}

	// Each subsequent entry links to the previous entry's hash
	for i := 1; i < len(entries); i++ {
		if entries[i].PrevHash != entries[i-1].EntryHash {
			t.Fatalf("entry[%d].PrevHash = %q, want entry[%d].EntryHash = %q",
				i, entries[i].PrevHash, i-1, entries[i-1].EntryHash)
		}
	}
}

func TestRotationWritesSentinel(t *testing.T) {
	l := newTestLogger(t)
	// Set max size very small to trigger rotation
	l.maxSize = 200

	// Write entries until rotation happens
	for i := 0; i < 10; i++ {
		l.Log(EventCommandReceived, "cmd-x", map[string]any{"i": i})
	}
	l.Close()

	entries := readEntries(t, l.filePath)
	if len(entries) == 0 {
		t.Fatal("no entries in current log file after rotation")
	}

	// First entry in rotated file should be the sentinel
	if entries[0].EventType != EventLogRotated {
		t.Fatalf("first entry after rotation eventType = %q, want %q",
			entries[0].EventType, EventLogRotated)
	}

	// Sentinel should have details about previous file
	if entries[0].Details == nil {
		t.Fatal("sentinel details is nil")
	}
	prevFile, _ := entries[0].Details["previousFile"].(string)
	if prevFile == "" {
		t.Fatal("sentinel has no previousFile in details")
	}

	// Verify sentinel prevHash is non-empty (links to old file)
	if entries[0].PrevHash == "" || entries[0].PrevHash == "genesis" {
		t.Fatalf("sentinel prevHash = %q, should link to last entry of old file", entries[0].PrevHash)
	}
}

func TestCriticalEventsSet(t *testing.T) {
	expected := []string{EventPrivilegedOp, EventAgentStart, EventAgentStop, EventConfigChange}
	for _, e := range expected {
		if !criticalEvents[e] {
			t.Errorf("event %q should be in criticalEvents", e)
		}
	}
	// Non-critical events should not be in the set
	nonCritical := []string{EventCommandReceived, EventCommandExecuted, EventScriptExecution}
	for _, e := range nonCritical {
		if criticalEvents[e] {
			t.Errorf("event %q should NOT be in criticalEvents", e)
		}
	}
}

func TestDroppedCountIncrementsOnWriteFailure(t *testing.T) {
	l := newTestLogger(t)

	// Close the underlying file and replace with a read-only file to force write failures
	l.file.Close()
	f, err := os.Open(l.filePath) // read-only
	if err != nil {
		t.Fatalf("open read-only: %v", err)
	}
	l.file = f

	// Attempt to log — should fail at l.file.Write and increment dropped counter
	l.Log(EventCommandReceived, "cmd-1", nil)

	if got := l.DroppedCount(); got != 1 {
		t.Fatalf("DroppedCount() = %d, want 1", got)
	}
	l.file.Close()
}

func TestRotationSentinelCrossFileHashChain(t *testing.T) {
	l := newTestLogger(t)
	l.maxSize = 200 // trigger rotation quickly

	// Write enough entries to trigger rotation
	for i := 0; i < 10; i++ {
		l.Log(EventCommandReceived, "cmd-x", map[string]any{"i": i})
	}
	l.Close()

	// Read the current (rotated) file
	entries := readEntries(t, l.filePath)
	if len(entries) == 0 {
		t.Fatal("no entries in current file after rotation")
	}

	// First entry must be the sentinel
	if entries[0].EventType != EventLogRotated {
		t.Fatalf("first entry eventType = %q, want %q", entries[0].EventType, EventLogRotated)
	}

	// Sentinel prevHash should NOT be "genesis" (it links to previous file)
	if entries[0].PrevHash == "genesis" || entries[0].PrevHash == "" {
		t.Fatalf("sentinel prevHash = %q, expected non-genesis (cross-file link)", entries[0].PrevHash)
	}

	// Read the backup file and verify the chain endpoint
	backupEntries := readEntries(t, l.filePath+".1")
	if len(backupEntries) == 0 {
		t.Fatal("no entries in backup file")
	}
	lastBackupHash := backupEntries[len(backupEntries)-1].EntryHash
	if entries[0].PrevHash != lastBackupHash {
		t.Fatalf("sentinel prevHash = %q, want last backup entry hash = %q",
			entries[0].PrevHash, lastBackupHash)
	}
}

func TestLengthPrefixedHashConsistency(t *testing.T) {
	l := newTestLogger(t)
	defer l.Close()

	// Write an entry with fields that could collide with pipe-delimited hashing
	l.Log(EventCommandReceived, "a|b", map[string]any{"key": "value"})

	entries := readEntries(t, l.filePath)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].EntryHash == "" {
		t.Fatal("entry hash is empty")
	}
}

// --- helpers ---

func newTestLogger(t *testing.T) *Logger {
	t.Helper()
	dir := t.TempDir()
	cfg := &config.Config{
		AuditMaxSizeMB:  50,
		AuditMaxBackups: 3,
	}
	_ = cfg // We manually construct the logger to control the path.

	filePath := filepath.Join(dir, "audit.jsonl")
	l := &Logger{
		filePath:   filePath,
		maxSize:    50 * 1024 * 1024,
		maxBackups: 3,
		prevHash:   "genesis",
	}
	if err := l.openFile(); err != nil {
		t.Fatalf("openFile: %v", err)
	}
	return l
}

func readEntries(t *testing.T, filePath string) []Entry {
	t.Helper()
	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return nil
	}
	entries := make([]Entry, 0, len(lines))
	for _, line := range lines {
		var e Entry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatalf("unmarshal line %q: %v", line, err)
		}
		entries = append(entries, e)
	}
	return entries
}

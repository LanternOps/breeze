package mgmtdetect

import (
	"testing"
)

func TestProcessSnapshotContainsSelf(t *testing.T) {
	snap, err := newProcessSnapshot()
	if err != nil {
		t.Fatalf("failed to take snapshot: %v", err)
	}
	if snap.count() == 0 {
		t.Error("snapshot should contain at least one process")
	}
}

func TestProcessSnapshotIsRunning(t *testing.T) {
	snap, err := newProcessSnapshot()
	if err != nil {
		t.Fatalf("failed to take snapshot: %v", err)
	}
	if snap.isRunning("definitely_not_a_real_process_12345.exe") {
		t.Error("should not find nonexistent process")
	}
}

func TestProcessSnapshotIsRunningCaseInsensitive(t *testing.T) {
	snap := &processSnapshot{names: map[string]bool{"chrome": true, "firefox.exe": true}}

	if !snap.isRunning("Chrome") {
		t.Error("expected case-insensitive match for Chrome")
	}
	if !snap.isRunning("CHROME") {
		t.Error("expected case-insensitive match for CHROME")
	}
	if !snap.isRunning("chrome") {
		t.Error("expected match for exact case")
	}
	if snap.isRunning("safari") {
		t.Error("expected no match for safari")
	}
	if !snap.isRunning("Firefox.exe") {
		t.Error("expected case-insensitive match for Firefox.exe")
	}
	if !snap.isRunning("FIREFOX.EXE") {
		t.Error("expected case-insensitive match for FIREFOX.EXE")
	}
}

func TestProcessSnapshotCount(t *testing.T) {
	snap := &processSnapshot{names: map[string]bool{"a": true, "b": true, "c": true}}
	if snap.count() != 3 {
		t.Errorf("expected count 3, got %d", snap.count())
	}
}

func TestProcessSnapshotEmpty(t *testing.T) {
	snap := &processSnapshot{names: make(map[string]bool)}
	if snap.count() != 0 {
		t.Errorf("expected count 0, got %d", snap.count())
	}
	if snap.isRunning("anything") {
		t.Error("expected no match in empty snapshot")
	}
}

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

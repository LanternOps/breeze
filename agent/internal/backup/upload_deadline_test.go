package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// #7105 item 1: the per-file deadline scales with size at the 64 KiB/s stall
// floor, and before the cap it had no ceiling — ~17 h for a 4 GB file and ~7
// days for a 40 GB one (#2798). Pin the ceiling and the exact size at which it
// starts to bind.
func TestUploadDeadline_Ceiling(t *testing.T) {
	restore := setUploadTimeoutFloorForTest(5 * time.Minute)
	defer restore()

	ceilingBytes := int64(uploadTimeoutCeiling/time.Second) * uploadMinThroughputBps
	const GiB = int64(1024 * 1024 * 1024)

	tests := []struct {
		name string
		size int64
		want time.Duration
	}{
		{"exactly the ceiling-equivalent size", ceilingBytes, uploadTimeoutCeiling},
		{"just under the ceiling still scales", ceilingBytes - uploadMinThroughputBps, uploadTimeoutCeiling - time.Second},
		{"just over the ceiling is capped", ceilingBytes + uploadMinThroughputBps, uploadTimeoutCeiling},
		{"40 GiB is capped, not ~7 days", 40 * GiB, uploadTimeoutCeiling},
		{"1 TiB is capped", 1024 * GiB, uploadTimeoutCeiling},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := uploadDeadline(tt.size); got != tt.want {
				t.Errorf("uploadDeadline(%d) = %v, want %v", tt.size, got, tt.want)
			}
		})
	}

	if uploadTimeoutCeiling != 24*time.Hour {
		t.Fatalf("uploadTimeoutCeiling = %v, want 24h (the server's no-transfer ceiling, BACKUP_NO_TRANSFER_MAX_WINDOW_MS)", uploadTimeoutCeiling)
	}
}

// #7105 item 2: a per-file deadline that expires on the manifest (or any other
// publish-time upload) used to surface as errBackupStopped — the same sentinel
// a user cancel produces — so the run was reported as stopped and the stall was
// never logged. It must now read as a stall, distinct from a cancel.
func TestPublishSnapshotManifest_DeadlineExpiryIsAStallNotAStop(t *testing.T) {
	restoreFloor := setUploadTimeoutFloorForTest(50 * time.Millisecond)
	defer restoreFloor()

	_, err := publishSnapshotManifest(context.Background(), &stallOnceProvider{}, "", nil, &Snapshot{ID: "snap-1"})
	if err == nil {
		t.Fatal("want an error when the manifest upload stalls past its deadline")
	}
	if errors.Is(err, errBackupStopped) {
		t.Fatalf("deadline expiry reported as a job stop: %v", err)
	}
	if !strings.Contains(err.Error(), "upload stalled") {
		t.Fatalf("want an 'upload stalled' error, got %v", err)
	}
}

func TestPublishLayoutManifest_DeadlineExpiryIsAStallNotAStop(t *testing.T) {
	restoreFloor := setUploadTimeoutFloorForTest(50 * time.Millisecond)
	defer restoreFloor()

	_, err := publishLayoutManifest(context.Background(), &stallOnceProvider{}, "", nil, "snap-1", nil)
	if err == nil {
		t.Fatal("want an error when the layout manifest upload stalls past its deadline")
	}
	if errors.Is(err, errBackupStopped) {
		t.Fatalf("deadline expiry reported as a job stop: %v", err)
	}
}

func TestPublishSystemState_ArtifactDeadlineExpiryIsAStallNotAStop(t *testing.T) {
	restoreFloor := setUploadTimeoutFloorForTest(50 * time.Millisecond)
	defer restoreFloor()

	staging := t.TempDir()
	if err := os.WriteFile(filepath.Join(staging, "reg.hiv"), []byte("hive"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := &systemstate.SystemStateManifest{
		Artifacts: []systemstate.Artifact{{Path: "reg.hiv", SizeBytes: 4}},
	}

	_, err := publishSystemState(context.Background(), &stallOnceProvider{}, "", nil, "snap-1", staging, manifest)
	if err == nil {
		t.Fatal("want an error when a system state artifact upload stalls past its deadline")
	}
	if errors.Is(err, errBackupStopped) {
		t.Fatalf("deadline expiry reported as a job stop: %v", err)
	}
	if !strings.Contains(err.Error(), "upload stalled") {
		t.Fatalf("want an 'upload stalled' error, got %v", err)
	}
}

// A real job cancel must still come back as errBackupStopped, unwrapped, so
// callers keep aborting the run instead of recording a failure.
func TestUploadWithDeadline_JobCancelStaysAStop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	_, err := uploadWithDeadline(ctx, &stallOnceProvider{}, "", writeTempFile(t, "x"), "remote/x", 1)
	if !errors.Is(err, errBackupStopped) {
		t.Fatalf("want errBackupStopped for a job cancel, got %v", err)
	}
}

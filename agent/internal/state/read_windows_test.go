//go:build windows

package state

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestReadDoesNotBlockConcurrentRename is the regression test for the
// 2026-07-22 incident: a reader holding agent.state open without
// FILE_SHARE_DELETE makes the agent's MoveFileEx(REPLACE_EXISTING) fail with
// ERROR_SHARING_VIOLATION. Hammer Read while Write renames over the same
// destination; with the share-delete open every rename must succeed.
func TestReadDoesNotBlockConcurrentRename(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)

	if err := Write(path, &AgentState{Status: StatusRunning, PID: 1, Version: "1.0.0", Timestamp: time.Now()}); err != nil {
		t.Fatalf("seed Write: %v", err)
	}

	stop := make(chan struct{})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			select {
			case <-stop:
				return
			default:
			}
			// Errors are fine (mid-swap transients); holding the handle in a
			// way that blocks the rename is what this test exists to catch —
			// that surfaces as Write failures below.
			_, _ = Read(path)
		}
	}()

	// Use the raw WriteFile+Rename pair, NOT state.Write: Write's bounded
	// retry would silently heal a partially effective fix (e.g. a dropped
	// FILE_SHARE_DELETE flag that only sometimes collides), and this test
	// must prove every single rename succeeds with a reader mid-flight.
	tmpPath := path + ".tmp"
	payload := []byte(`{"status":"running","pid":1,"version":"1.0.0"}`)
	for i := 0; i < 500; i++ {
		if err := os.WriteFile(tmpPath, payload, 0644); err != nil {
			close(stop)
			<-readerDone
			t.Fatalf("WriteFile %d: %v", i, err)
		}
		if err := os.Rename(tmpPath, path); err != nil {
			close(stop)
			<-readerDone
			t.Fatalf("Rename %d failed under concurrent reads: %v", i, err)
		}
	}
	close(stop)
	<-readerDone
}

// TestReadMissingFileIsNotExistWindows pins the os.IsNotExist contract of the
// CreateFile-based reader: Read must keep returning (nil, nil) for a missing
// file, same as the os.ReadFile it replaced.
func TestReadMissingFileIsNotExistWindows(t *testing.T) {
	dir := t.TempDir()

	got, err := Read(filepath.Join(dir, "nope.state"))
	if err != nil || got != nil {
		t.Fatalf("Read missing = (%+v, %v), want (nil, nil)", got, err)
	}

	// And the raw reader maps ERROR_FILE_NOT_FOUND so os.IsNotExist holds.
	_, rawErr := readStateFile(filepath.Join(dir, "nope.state"))
	if !os.IsNotExist(rawErr) {
		t.Fatalf("readStateFile missing-file error = %v, want os.IsNotExist", rawErr)
	}
}

//go:build windows

package state

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestReadDoesNotBlockConcurrentRename is the regression test for the
// 2026-07-22 incident: a reader holding agent.state open collides with the
// agent replacing it. The share-delete reader (read_windows.go) stops
// ERROR_SHARING_VIOLATION, but os.Rename's MoveFileEx(REPLACE_EXISTING) still
// fails ~78% of the time with ERROR_ACCESS_DENIED (delete-pending target) —
// renameStateFile uses POSIX rename semantics to make the swap succeed every
// time. Hammer Read while renameStateFile replaces the destination; every
// rename must succeed with NO retry (renameStateFile, not state.Write, so a
// retry loop cannot mask a regression in the primitive).
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

	// Use WriteFile + renameStateFile directly, NOT state.Write: Write's
	// bounded retry would silently heal a partially effective fix, and this
	// test must prove every single rename succeeds with a reader mid-flight.
	tmpPath := path + ".tmp"
	payload := []byte(`{"status":"running","pid":1,"version":"1.0.0"}`)
	for i := 0; i < 500; i++ {
		if err := os.WriteFile(tmpPath, payload, 0644); err != nil {
			close(stop)
			<-readerDone
			t.Fatalf("WriteFile %d: %v", i, err)
		}
		if err := renameStateFile(tmpPath, path); err != nil {
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

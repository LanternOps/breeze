package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
)

// The server revokes a restore's read session when the command stops being
// live (it timed out); every later resolve answers 410. The helper must stop
// the restore there, keep the files it already wrote, and answer with a body
// the server can record as "session ended after N of M files" instead of one
// failure per remaining file.
func TestStorageSessionWiring_RestoreStopsWhenTheSessionIsRevoked(t *testing.T) {
	origWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = origWorkRoot })

	const n = 120
	files := map[string][]byte{}
	for i := range n {
		files[fmt.Sprintf("f%03d.txt", i)] = fmt.Appendf(nil, "payload-%d", i)
	}

	e := newBrokeredEnv(t)
	e.seedBrokeredSnapshot("snap-restore-revoked", files)
	// The manifest's resolve and two small batches succeed; the session is
	// revoked from then on.
	var resolves int
	orig := e.api.Config.Handler
	e.api.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/objects:resolve") {
			e.mu.Lock()
			resolves++
			revoked := resolves > 3
			e.mu.Unlock()
			if revoked {
				http.Error(w, "session revoked", http.StatusGone)
				return
			}
		}
		orig.ServeHTTP(w, r)
	})
	session := e.session()
	session["maxBatch"] = 2
	target := t.TempDir()
	payload := sessionPayloadJSON(t, map[string]any{"snapshotId": "snap-restore-revoked", "targetPath": target, "storageSession": session})

	result := execBackupRestoreWithProgress(context.Background(), "c-restore", payload, nil, &vaultManagerRef{}, nil)

	var got struct {
		Status            string   `json:"status"`
		FilesRestored     int      `json:"filesRestored"`
		FilesFailed       int      `json:"filesFailed"`
		FilesNotAttempted int      `json:"filesNotAttempted"`
		FailedFiles       []string `json:"failedFiles"`
		Error             string   `json:"error"`
		Code              string   `json:"code"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &got); err != nil {
		t.Fatalf("stdout is not a restore result body (stderr=%q): %v (%q)", result.Stderr, err, result.Stdout)
	}
	if got.Code != backup.ResultCodeStorageSessionLost || got.FilesFailed != 0 || len(got.FailedFiles) != 0 {
		t.Fatalf("result = %+v, want code %q and no failed files", got, backup.ResultCodeStorageSessionLost)
	}
	if got.FilesNotAttempted == 0 || got.FilesRestored+got.FilesNotAttempted != n {
		t.Fatalf("restored=%d notAttempted=%d, want every one of %d files accounted for, some not attempted", got.FilesRestored, got.FilesNotAttempted, n)
	}
	wantStatus := "partial"
	if got.FilesRestored == 0 {
		wantStatus = "failed"
	}
	if got.Status != wantStatus || !strings.Contains(got.Error, "storage session ended") {
		t.Fatalf("status=%q error=%q, want %s with a session-ended reason", got.Status, got.Error, wantStatus)
	}
	if result.Success {
		t.Fatal("an unfinished restore must not be a successful command")
	}
	// The reported count is what is actually on disk, nothing rolled back.
	onDisk, err := os.ReadDir(filepath.Join(target, "data"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(onDisk) != got.FilesRestored {
		t.Fatalf("%d files on disk, result says %d restored", len(onDisk), got.FilesRestored)
	}
	wantCounts := fmt.Sprintf("after %d of %d files (%d restored, 0 failed); the remaining %d were not attempted",
		got.FilesRestored, n, got.FilesRestored, got.FilesNotAttempted)
	if !strings.Contains(got.Error, wantCounts) {
		t.Fatalf("error = %q, want the counts %q", got.Error, wantCounts)
	}
	e.mu.Lock()
	fetches := len(e.storageHeaders)
	e.mu.Unlock()
	if fetches > n/4 {
		t.Fatalf("storage saw %d object fetches for %d files after the session was revoked; want the run to stop", fetches, n)
	}
}

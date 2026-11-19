package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// The server revokes a verification's read session when the command stops
// being live; every later resolve answers 410. The helper must stop at that
// point and still answer with a COMPLETED command whose body carries the
// counts, so the server records "session ended" rather than one failure per
// remaining file (484,767 of them in production).
func TestStorageSessionWiring_VerifyStopsWhenTheSessionIsRevoked(t *testing.T) {
	origWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = origWorkRoot })

	const n = 120
	files := map[string][]byte{}
	for i := range n {
		files[fmt.Sprintf("f%03d.txt", i)] = []byte(fmt.Sprintf("payload-%d", i))
	}

	type body struct {
		Status         string   `json:"status"`
		FilesVerified  int      `json:"filesVerified"`
		FilesFailed    int      `json:"filesFailed"`
		FilesUnchecked int      `json:"filesUnchecked"`
		FailedFiles    []string `json:"failedFiles"`
		Error          string   `json:"error"`
		Code           string   `json:"code"`
		CleanedUp      *bool    `json:"cleanedUp"`
	}
	cases := []struct {
		name string
		run  func(payload json.RawMessage) backupipc.BackupCommandResult
	}{
		{"verify", func(payload json.RawMessage) backupipc.BackupCommandResult {
			return execBackupVerifyContext(context.Background(), "c-verify", payload, nil, &vaultManagerRef{}, nil)
		}},
		{"test restore", func(payload json.RawMessage) backupipc.BackupCommandResult {
			return execBackupTestRestoreContext(context.Background(), "c-test-restore", payload, nil, &vaultManagerRef{}, nil)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newBrokeredEnv(t)
			e.seedBrokeredSnapshot("snap-revoked", files)
			// The manifest's resolve and two small batches succeed; the
			// session is revoked from then on.
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
			payload := sessionPayloadJSON(t, map[string]any{"snapshotId": "snap-revoked", "storageSession": session})

			result := tc.run(payload)
			if !result.Success {
				t.Fatalf("command failed (stderr=%q): the counts would be discarded", result.Stderr)
			}
			var got body
			if err := json.Unmarshal([]byte(result.Stdout), &got); err != nil {
				t.Fatalf("stdout is not a result body: %v (%q)", err, result.Stdout)
			}
			if got.Code != backup.ResultCodeStorageSessionLost || got.FilesFailed != 0 || len(got.FailedFiles) != 0 {
				t.Fatalf("result = %+v, want code %q and no failed files", got, backup.ResultCodeStorageSessionLost)
			}
			if got.FilesUnchecked == 0 || got.FilesVerified+got.FilesUnchecked != n {
				t.Fatalf("verified=%d unchecked=%d, want every one of %d files accounted for, some unchecked", got.FilesVerified, got.FilesUnchecked, n)
			}
			wantStatus := "partial"
			if got.FilesVerified == 0 {
				wantStatus = "failed"
			}
			if got.Status != wantStatus || !strings.Contains(got.Error, "storage session ended") {
				t.Fatalf("status=%q error=%q, want %s with a session-ended reason", got.Status, got.Error, wantStatus)
			}
			if got.CleanedUp != nil && !*got.CleanedUp {
				t.Fatal("test restore directory was not cleaned up")
			}
			e.mu.Lock()
			fetches := len(e.storageHeaders)
			e.mu.Unlock()
			if fetches > n/4 {
				t.Fatalf("storage saw %d object fetches for %d files after the session was revoked; want the run to stop", fetches, n)
			}
		})
	}
}

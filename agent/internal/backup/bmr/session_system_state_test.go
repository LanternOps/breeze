package bmr

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// TestSnapshotExpectsSystemState pins the #5412 derivation shared by every
// bootstrap-driven caller (bmr-recover, breeze-backup rebuild --token, the
// recovery console): a system_image snapshot expects system state even
// when the server's systemStateManifest column is NULL — that NULL is
// exactly the symptom of a failed state collection, not evidence the
// snapshot never had any.
func TestSnapshotExpectsSystemState(t *testing.T) {
	tests := []struct {
		name string
		snap *AuthenticatedSnapshot
		want bool
	}{
		{"nil snapshot", nil, false},
		{"file backup, no manifest", &AuthenticatedSnapshot{BackupType: "file"}, false},
		{"file backup, null manifest", &AuthenticatedSnapshot{BackupType: "file", SystemStateManifest: json.RawMessage(`null`)}, false},
		{"system_image, null manifest", &AuthenticatedSnapshot{BackupType: "system_image", SystemStateManifest: json.RawMessage(`null`)}, true},
		{"system_image, manifest omitted", &AuthenticatedSnapshot{BackupType: "system_image"}, true},
		{"no backupType, real manifest", &AuthenticatedSnapshot{SystemStateManifest: json.RawMessage(`{"platform":"linux","schemaVersion":1}`)}, true},
		{"system_image, real manifest", &AuthenticatedSnapshot{BackupType: "system_image", SystemStateManifest: json.RawMessage(`{}`)}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SnapshotExpectsSystemState(tt.snap); got != tt.want {
				t.Fatalf("SnapshotExpectsSystemState(%+v) = %v, want %v", tt.snap, got, tt.want)
			}
		})
	}
}

// TestRunRecoveryWithToken_SystemImageNullManifest_NeverCompleted is the
// end-to-end shape from issue #5412: the bootstrap says backupType
// "system_image" with a NULL systemStateManifest, the snapshot in storage
// has files but no system-state/manifest.json. Before the fix the session
// derived ExpectSystemState solely from the manifest column, so the run
// applied no OS state and still reported "completed" to the server.
func TestRunRecoveryWithToken_SystemImageNullManifest_NeverCompleted(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-5412-system-image"
	buildOrdinaryManifestFixture(t, provider, snapshotID)
	useFakeRestorer(t, &fakeStateRestorer{})

	var mu sync.Mutex
	var reported map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/backup/bmr/recover/authenticate":
			_, _ = w.Write([]byte(`{"bootstrap":{"version":1,"tokenId":"token-1","deviceId":"device-1","snapshotId":"db-snapshot-1",` +
				`"snapshot":{"id":"snapshot-db-id","snapshotId":"` + snapshotID + `","backupType":"system_image","systemStateManifest":null},` +
				`"backupConfig":{"provider":"local","providerConfig":{"path":` + mustJSON(baseDir) + `}}}}`))
		case "/api/v1/backup/bmr/recover/complete":
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			_ = json.Unmarshal(body, &reported)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"restoreJobId": "job-1", "status": "ok"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	result, err := RunRecoveryWithToken(RecoveryConfig{RecoveryToken: "brz_rec_test", ServerURL: server.URL})
	if err != nil {
		t.Fatalf("RunRecoveryWithToken: %v", err)
	}
	if result.Status == "completed" {
		t.Fatalf("a system_image snapshot with no system state must never complete; got %+v", result)
	}
	if result.StateApplied {
		t.Fatal("StateApplied must be false when no state manifest existed")
	}
	mu.Lock()
	defer mu.Unlock()
	if reported == nil || reported["status"] == "completed" {
		t.Fatalf("server was told status=%v, want anything but completed", reported["status"])
	}
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

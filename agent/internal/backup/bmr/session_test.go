package bmr

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func TestAuthenticateRecoverySession(t *testing.T) {
	var gotToken string
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/backup/bmr/recover/authenticate" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		gotToken = body["token"]
		_ = json.NewEncoder(w).Encode(map[string]any{
			"bootstrap": BootstrapResponse{
				Version:      BootstrapResponseVersion,
				TokenID:      "token-1",
				DeviceID:     "device-1",
				SnapshotID:   "db-snapshot-1",
				TargetConfig: map[string]any{},
				Download: &AuthenticatedDownloadDescriptor{
					Type:            "breeze_proxy",
					Method:          "GET",
					URL:             server.URL + "/api/v1/backup/bmr/recover/download",
					PathQueryParam:  "path",
					TokenQueryParam: "token",
					PathPrefix:      "snapshots/provider-snapshot-1",
				},
				Snapshot: &AuthenticatedSnapshot{
					ID:         "snapshot-db-id",
					SnapshotID: "provider-snapshot-1",
					Size:       2048,
					FileCount:  2,
				},
			},
		})
	}))
	defer server.Close()

	resp, err := authenticateRecoverySession(server.URL, "brz_rec_test")
	if err != nil {
		t.Fatalf("authenticateRecoverySession: %v", err)
	}
	if gotToken != "brz_rec_test" {
		t.Fatalf("token = %q, want brz_rec_test", gotToken)
	}
	if resp.Snapshot == nil || resp.Snapshot.SnapshotID != "provider-snapshot-1" {
		t.Fatalf("snapshot = %+v, want provider snapshot id", resp.Snapshot)
	}
	if resp.Download == nil || resp.Download.PathPrefix != "snapshots/provider-snapshot-1" {
		t.Fatalf("download descriptor = %+v, want snapshot-scoped download access", resp.Download)
	}
}

func TestDecodeBootstrapResponseLegacyFallback(t *testing.T) {
	data, err := json.Marshal(AuthenticateResponse{
		TokenID:    "token-legacy",
		DeviceID:   "device-legacy",
		SnapshotID: "snapshot-legacy",
		TargetConfig: map[string]any{
			"provider": "local",
			"path":     "/var/lib/breeze-backups",
		},
		Snapshot: &AuthenticatedSnapshot{
			ID:         "snapshot-db-id",
			SnapshotID: "provider-snapshot-legacy",
		},
	})
	if err != nil {
		t.Fatalf("marshal legacy response: %v", err)
	}

	resp, err := decodeBootstrapResponse(data)
	if err != nil {
		t.Fatalf("decodeBootstrapResponse: %v", err)
	}
	if resp.Version != BootstrapResponseVersion {
		t.Fatalf("version = %d, want %d", resp.Version, BootstrapResponseVersion)
	}
	if resp.Snapshot == nil || resp.Snapshot.SnapshotID != "provider-snapshot-legacy" {
		t.Fatalf("snapshot = %+v, want legacy provider snapshot id", resp.Snapshot)
	}
}

func TestReportRecoveryCompletion(t *testing.T) {
	var gotStatus string
	var gotToken string
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/backup/bmr/recover/complete" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		gotToken = body["token"].(string)
		gotStatus = body["result"].(map[string]any)["status"].(string)
		_ = json.NewEncoder(w).Encode(map[string]any{"restoreJobId": "job-1", "status": "completed"})
	}))
	defer server.Close()

	err := reportRecoveryCompletion(server.URL, "brz_rec_test", &RecoveryResult{Status: "completed"})
	if err != nil {
		t.Fatalf("reportRecoveryCompletion: %v", err)
	}
	if gotToken != "brz_rec_test" {
		t.Fatalf("token = %q, want brz_rec_test", gotToken)
	}
	if gotStatus != "completed" {
		t.Fatalf("status = %q, want completed", gotStatus)
	}
}

func TestRunRecoveryWithToken_UsesAuthenticatedBootstrap(t *testing.T) {
	var completeStatus atomic.Value
	var seenRecoveryToken string
	origRunRecovery := runRecovery
	defer func() { runRecovery = origRunRecovery }()
	runRecovery = func(cfg RecoveryConfig, provider providers.BackupProvider) (*RecoveryResult, error) {
		destPath := filepath.Join(t.TempDir(), "manifest.json")
		if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", destPath); err != nil {
			t.Fatalf("provider download failed: %v", err)
		}
		downloaded, err := os.ReadFile(destPath)
		if err != nil {
			t.Fatalf("read downloaded manifest: %v", err)
		}
		if string(downloaded) != `{"ok":true}` {
			t.Fatalf("downloaded payload = %q, want manifest json", string(downloaded))
		}
		if cfg.SnapshotID != "provider-snapshot-1" {
			t.Fatalf("snapshotId = %q, want provider-snapshot-1", cfg.SnapshotID)
		}
		if cfg.TargetPaths["/src/data"] != "/dst/data" {
			t.Fatalf("target override missing: %+v", cfg.TargetPaths)
		}
		if _, ok := provider.(*recoveryDownloadProvider); !ok {
			t.Fatalf("provider type = %T, want authenticated recovery download provider", provider)
		}
		return &RecoveryResult{Status: "completed", FilesRestored: 1}, nil
	}

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/backup/bmr/recover/authenticate":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			seenRecoveryToken = body["token"]
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bootstrap": BootstrapResponse{
					Version:    BootstrapResponseVersion,
					TokenID:    "token-1",
					DeviceID:   "device-1",
					SnapshotID: "db-snapshot-1",
					TargetConfig: map[string]any{
						"targetPaths": map[string]any{
							"/src/data": "/dst/data",
						},
					},
					Download: &AuthenticatedDownloadDescriptor{
						Type:            "breeze_proxy",
						Method:          "GET",
						URL:             server.URL + "/api/v1/backup/bmr/recover/download",
						PathQueryParam:  "path",
						TokenQueryParam: "token",
						PathPrefix:      "snapshots/provider-snapshot-1",
					},
					Snapshot: &AuthenticatedSnapshot{
						ID:         "snapshot-db-id",
						SnapshotID: "provider-snapshot-1",
					},
				},
			})
		case "/api/v1/backup/bmr/recover/download":
			if got := r.URL.Query().Get("token"); got != "brz_rec_test" {
				http.Error(w, "missing token", http.StatusUnauthorized)
				return
			}
			if got := r.URL.Query().Get("path"); got != "snapshots/provider-snapshot-1/manifest.json" {
				http.Error(w, "unexpected path", http.StatusBadRequest)
				return
			}
			_, _ = io.WriteString(w, `{"ok":true}`)
		case "/api/v1/backup/bmr/recover/complete":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			completeStatus.Store(body["result"].(map[string]any)["status"].(string))
			_ = json.NewEncoder(w).Encode(map[string]any{"restoreJobId": "job-1", "status": "completed"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	result, err := RunRecoveryWithToken(RecoveryConfig{
		RecoveryToken: "brz_rec_test",
		ServerURL:     server.URL,
	})
	if err != nil {
		t.Fatalf("RunRecoveryWithToken: %v", err)
	}
	if result.Status != "completed" {
		t.Fatalf("result status = %q, want completed", result.Status)
	}
	if seenRecoveryToken != "brz_rec_test" {
		t.Fatalf("token = %q, want brz_rec_test", seenRecoveryToken)
	}
	if status, _ := completeStatus.Load().(string); status != "completed" {
		t.Fatalf("completion status = %q, want completed", status)
	}
}

func TestRunRecoveryWithToken_RequiresServerAuthentication(t *testing.T) {
	origRunRecovery := runRecovery
	defer func() { runRecovery = origRunRecovery }()

	calledRecovery := false
	runRecovery = func(cfg RecoveryConfig, provider providers.BackupProvider) (*RecoveryResult, error) {
		calledRecovery = true
		return &RecoveryResult{Status: "completed"}, nil
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/backup/bmr/recover/authenticate":
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		case "/api/v1/backup/bmr/recover/complete":
			t.Fatal("complete should not be called after auth failure")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	_, err := RunRecoveryWithToken(RecoveryConfig{
		RecoveryToken: "brz_rec_test",
		ServerURL:     server.URL,
	})
	if err == nil {
		t.Fatal("expected RunRecoveryWithToken to fail when authenticate is rejected")
	}
	if calledRecovery {
		t.Fatal("expected recovery runner not to be invoked without server authentication")
	}
}

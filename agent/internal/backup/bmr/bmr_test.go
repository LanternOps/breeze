package bmr

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func TestRecoveryConfigSerialization(t *testing.T) {
	cfg := RecoveryConfig{
		RecoveryToken: "brz_rec_abc123",
		ServerURL:     "https://api.breeze.example.com",
		SnapshotID:    "snapshot-20260329T120000Z-abcd",
		DeviceID:      "d1234567-abcd-efgh-ijkl-000000000001",
		TargetPaths: map[string]string{
			"/opt/app/data": "/mnt/restore/app/data",
		},
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal RecoveryConfig: %v", err)
	}

	var decoded RecoveryConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal RecoveryConfig: %v", err)
	}

	if decoded.RecoveryToken != cfg.RecoveryToken {
		t.Errorf("RecoveryToken: got %q, want %q", decoded.RecoveryToken, cfg.RecoveryToken)
	}
	if decoded.ServerURL != cfg.ServerURL {
		t.Errorf("ServerURL: got %q, want %q", decoded.ServerURL, cfg.ServerURL)
	}
	if decoded.SnapshotID != cfg.SnapshotID {
		t.Errorf("SnapshotID: got %q, want %q", decoded.SnapshotID, cfg.SnapshotID)
	}
	if decoded.DeviceID != cfg.DeviceID {
		t.Errorf("DeviceID: got %q, want %q", decoded.DeviceID, cfg.DeviceID)
	}
	if len(decoded.TargetPaths) != 1 {
		t.Fatalf("TargetPaths length: got %d, want 1", len(decoded.TargetPaths))
	}
	if decoded.TargetPaths["/opt/app/data"] != "/mnt/restore/app/data" {
		t.Errorf("TargetPaths override wrong: got %q", decoded.TargetPaths["/opt/app/data"])
	}
}

func TestRecoveryConfigNoTargetPaths(t *testing.T) {
	cfg := RecoveryConfig{
		RecoveryToken: "tok",
		ServerURL:     "https://example.com",
		SnapshotID:    "snap-1",
		DeviceID:      "dev-1",
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// targetPaths should be omitted when nil.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}
	if _, exists := raw["targetPaths"]; exists {
		t.Error("expected targetPaths to be omitted when nil")
	}
}

func TestRecoveryResultSerialization(t *testing.T) {
	result := RecoveryResult{
		Status:          "completed",
		FilesRestored:   42,
		BytesRestored:   1024 * 1024 * 500,
		StateApplied:    true,
		DriversInjected: 3,
		Validated:       true,
		Warnings:        []string{"minor warning 1"},
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal RecoveryResult: %v", err)
	}

	var decoded RecoveryResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal RecoveryResult: %v", err)
	}

	if decoded.Status != "completed" {
		t.Errorf("Status: got %q, want %q", decoded.Status, "completed")
	}
	if decoded.FilesRestored != 42 {
		t.Errorf("FilesRestored: got %d, want 42", decoded.FilesRestored)
	}
	if decoded.BytesRestored != 1024*1024*500 {
		t.Errorf("BytesRestored: got %d, want %d", decoded.BytesRestored, 1024*1024*500)
	}
	if !decoded.StateApplied {
		t.Error("StateApplied: expected true")
	}
	if decoded.DriversInjected != 3 {
		t.Errorf("DriversInjected: got %d, want 3", decoded.DriversInjected)
	}
	if !decoded.Validated {
		t.Error("Validated: expected true")
	}
	if len(decoded.Warnings) != 1 {
		t.Fatalf("Warnings length: got %d, want 1", len(decoded.Warnings))
	}
}

func TestRecoveryResultFailedWithError(t *testing.T) {
	result := RecoveryResult{
		Status: "failed",
		Error:  "disk full",
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded RecoveryResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Status != "failed" {
		t.Errorf("Status: got %q, want %q", decoded.Status, "failed")
	}
	if decoded.Error != "disk full" {
		t.Errorf("Error: got %q, want %q", decoded.Error, "disk full")
	}
	if decoded.Warnings != nil {
		t.Error("Warnings: expected nil for omitempty")
	}
}

func TestValidationResultSerialization(t *testing.T) {
	tests := []struct {
		name   string
		result ValidationResult
	}{
		{
			name: "all_passed",
			result: ValidationResult{
				Passed:          true,
				ServicesRunning: true,
				NetworkUp:       true,
				CriticalFiles:   true,
			},
		},
		{
			name: "partial_failure",
			result: ValidationResult{
				Passed:          false,
				ServicesRunning: true,
				NetworkUp:       false,
				CriticalFiles:   true,
				Failures:        []string{"network connectivity check failed"},
			},
		},
		{
			name: "all_failed",
			result: ValidationResult{
				Passed:          false,
				ServicesRunning: false,
				NetworkUp:       false,
				CriticalFiles:   false,
				Failures: []string{
					"network down",
					"missing /etc/passwd",
					"sshd not running",
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.result)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			var decoded ValidationResult
			if err := json.Unmarshal(data, &decoded); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			if decoded.Passed != tt.result.Passed {
				t.Errorf("Passed: got %v, want %v", decoded.Passed, tt.result.Passed)
			}
			if decoded.ServicesRunning != tt.result.ServicesRunning {
				t.Errorf("ServicesRunning: got %v, want %v", decoded.ServicesRunning, tt.result.ServicesRunning)
			}
			if decoded.NetworkUp != tt.result.NetworkUp {
				t.Errorf("NetworkUp: got %v, want %v", decoded.NetworkUp, tt.result.NetworkUp)
			}
			if decoded.CriticalFiles != tt.result.CriticalFiles {
				t.Errorf("CriticalFiles: got %v, want %v", decoded.CriticalFiles, tt.result.CriticalFiles)
			}
			if len(decoded.Failures) != len(tt.result.Failures) {
				t.Errorf("Failures count: got %d, want %d", len(decoded.Failures), len(tt.result.Failures))
			}
		})
	}
}

func TestVMRestoreConfigSerialization(t *testing.T) {
	cfg := VMRestoreConfig{
		SnapshotID: "snap-123",
		Hypervisor: "hyperv",
		VMName:     "test-vm",
		MemoryMB:   4096,
		CPUCount:   2,
		DiskSizeGB: 100,
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded VMRestoreConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Hypervisor != "hyperv" {
		t.Errorf("Hypervisor: got %q, want %q", decoded.Hypervisor, "hyperv")
	}
	if decoded.MemoryMB != 4096 {
		t.Errorf("MemoryMB: got %d, want 4096", decoded.MemoryMB)
	}
}

func TestVMEstimateSerialization(t *testing.T) {
	est := VMEstimate{
		RecommendedMemoryMB: 8192,
		RecommendedCPU:      4,
		RequiredDiskGB:      250,
		Platform:            "windows",
		OSVersion:           "Windows Server 2022",
	}

	data, err := json.Marshal(est)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded VMEstimate
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.RecommendedMemoryMB != 8192 {
		t.Errorf("RecommendedMemoryMB: got %d, want 8192", decoded.RecommendedMemoryMB)
	}
	if decoded.RequiredDiskGB != 250 {
		t.Errorf("RequiredDiskGB: got %d, want 250", decoded.RequiredDiskGB)
	}
	if decoded.Platform != "windows" {
		t.Errorf("Platform: got %q, want %q", decoded.Platform, "windows")
	}
}

func TestRunRecoveryWithToken_AuthenticatesAndCompletes(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "bmr-session-snapshot"
	sourcePath := "/original/data.txt"
	restorePath := filepath.Join(t.TempDir(), "restored", "data.txt")

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "data.txt")
	content := []byte("restored by token-driven bmr")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}

	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "data.txt.gz"))
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload snapshot file: %v", err)
	}

	manifest := backup.Snapshot{
		ID: snapshotID,
		Files: []backup.SnapshotFile{
			{SourcePath: sourcePath, BackupPath: backupPath, Size: int64(len(content))},
		},
		Size: int64(len(content)),
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifestPath := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestPath, manifestData, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := provider.Upload(manifestPath, filepath.ToSlash(path.Join("snapshots", snapshotID, "manifest.json"))); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	var completionToken string
	var completionResult RecoveryResult
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/backup/bmr/recover/authenticate":
			var payload map[string]string
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode authenticate payload: %v", err)
			}
			if payload["token"] != "brz_rec_test" {
				t.Fatalf("unexpected token %q", payload["token"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bootstrap": BootstrapResponse{
					Version:     BootstrapResponseVersion,
					TokenID:     "token-1",
					DeviceID:    "device-1",
					SnapshotID:  "db-snapshot-1",
					RestoreType: "bare_metal",
					TargetConfig: map[string]any{
						"targetPaths": map[string]string{
							sourcePath: restorePath,
						},
					},
					Snapshot: &AuthenticatedSnapshot{
						ID:         "db-snapshot-1",
						SnapshotID: snapshotID,
						Size:       int64(len(content)),
						FileCount:  1,
					},
					BackupConfig: &AuthenticatedProviderConfig{
						ID:       "cfg-1",
						Provider: "local",
						ProviderConfig: map[string]any{
							"path": baseDir,
						},
					},
					AuthenticatedAt: "2026-03-31T12:00:00.000Z",
				},
			})
		case "/api/v1/backup/bmr/recover/complete":
			var payload struct {
				Token  string         `json:"token"`
				Result RecoveryResult `json:"result"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode complete payload: %v", err)
			}
			completionToken = payload.Token
			completionResult = payload.Result
			_ = json.NewEncoder(w).Encode(map[string]any{"restoreJobId": "restore-1", "status": payload.Result.Status})
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
		t.Fatalf("RunRecoveryWithToken failed: %v", err)
	}
	if result == nil {
		t.Fatal("expected recovery result")
	}
	if completionToken != "brz_rec_test" {
		t.Fatalf("completion token = %q, want brz_rec_test", completionToken)
	}
	if completionResult.FilesRestored != 1 {
		t.Fatalf("completion filesRestored = %d, want 1", completionResult.FilesRestored)
	}
	restored, err := os.ReadFile(restorePath)
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if !bytes.Equal(restored, content) {
		t.Fatalf("restored content mismatch: got %q", string(restored))
	}
}

func TestProviderFromAuthenticatedConfig_S3(t *testing.T) {
	provider, err := providerFromAuthenticatedConfig(map[string]any{
		"provider": "s3",
		"providerConfig": map[string]any{
			"bucket":    "bucket-1",
			"region":    "us-east-1",
			"accessKey": "abc",
			"secretKey": "def",
		},
	})
	if err != nil {
		t.Fatalf("providerFromAuthenticatedConfig: %v", err)
	}
	if provider == nil {
		t.Fatal("expected provider")
	}
}

package bmr

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

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
		FailedFiles:     2,
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
	if decoded.FailedFiles != 2 {
		t.Errorf("FailedFiles: got %d, want 2", decoded.FailedFiles)
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

// TestRestoreSourcePath_PrefersOriginalPathUnderVSS proves restoreFiles'
// helper itself: OriginalPath wins whenever set, never the VSS
// shadow-device SourcePath (D8) — mirrors backup's own restoreSourcePath.
func TestRestoreSourcePath_PrefersOriginalPathUnderVSS(t *testing.T) {
	const shadow = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\assure\src\x`
	const original = `C:\assure\src\x`

	f := manifestFile{SourcePath: shadow, OriginalPath: original}
	if got := restoreSourcePath(f); got != original {
		t.Fatalf("restoreSourcePath = %q, want the original path %q, not the shadow device path", got, original)
	}

	plain := manifestFile{SourcePath: "/data/plain.txt"}
	if got := restoreSourcePath(plain); got != "/data/plain.txt" {
		t.Fatalf("restoreSourcePath (no OriginalPath) = %q, want SourcePath %q", got, "/data/plain.txt")
	}
}

// TestRestoreFiles_DefaultTargetUsesOriginalPathNotShadowPath is D8's core
// proof for BMR's default (no --target-path override) restore destination:
// a manifest entry whose SourcePath is a VSS shadow-copy device path must
// land under its OriginalPath, never under the shadow path — before this
// field existed, bmr's manifestFile silently dropped `originalPath` on
// decode (no matching struct field), so every VSS-backed BMR recovery
// restored under the literal shadow-device path.
func TestRestoreFiles_DefaultTargetUsesOriginalPathNotShadowPath(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "bmr-vss-default"
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "x.gz"))

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "x")
	content := []byte("bmr-default-target-content")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	// restoreFiles writes directly to the (default or overridden) target
	// path with no containment check of its own (unlike RestoreFromSnapshotContext),
	// so both paths here live under an isolated temp root.
	restoreRoot := t.TempDir()
	originalPath := filepath.Join(restoreRoot, "assure", "src", "x")
	shadowSourcePath := filepath.Join(restoreRoot, "vss-shadow-copy-1", "assure", "src", "x")

	manifest := &snapshotManifest{
		ID: snapshotID,
		Files: []manifestFile{
			{SourcePath: shadowSourcePath, OriginalPath: originalPath, BackupPath: backupPath, Size: int64(len(content))},
		},
		Size: int64(len(content)),
	}

	filesRestored, bytesRestored, warnings, _, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err != nil {
		t.Fatalf("restoreFiles failed: %v (warnings: %v)", err, warnings)
	}
	if filesRestored != 1 {
		t.Fatalf("filesRestored = %d, want 1 (warnings: %v)", filesRestored, warnings)
	}
	if bytesRestored != int64(len(content)) {
		t.Fatalf("bytesRestored = %d, want %d", bytesRestored, len(content))
	}

	restored, err := os.ReadFile(originalPath)
	if err != nil {
		t.Fatalf("expected the file to land at the original path %q: %v", originalPath, err)
	}
	if !bytes.Equal(restored, content) {
		t.Fatalf("restored content = %q, want %q", restored, content)
	}
	if _, statErr := os.Stat(shadowSourcePath); statErr == nil {
		t.Fatalf("file was restored under the shadow-copy path %q instead of the original path", shadowSourcePath)
	}
}

// TestRestoreFiles_TargetPathOverrideKeyedByOriginalPath proves D8's other
// half: RecoveryConfig.TargetPaths overrides are documented as "original ->
// target path overrides" (see that field's doc comment) and must actually
// be looked up by the ORIGINAL path — a caller (the server, a human
// operator) only ever knows the real, human-visible location, never the
// per-run VSS shadow-device path, so a lookup keyed by SourcePath would
// never hit under VSS.
func TestRestoreFiles_TargetPathOverrideKeyedByOriginalPath(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "bmr-vss-override"
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "x.gz"))

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "x")
	content := []byte("bmr-override-target-content")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	restoreRoot := t.TempDir()
	shadowSourcePath := filepath.Join(restoreRoot, "vss-shadow-copy-1", "assure", "src", "x")
	originalPath := filepath.Join(restoreRoot, "assure", "src", "x")
	overrideTarget := filepath.Join(t.TempDir(), "alt-restore-location", "x")

	manifest := &snapshotManifest{
		ID: snapshotID,
		Files: []manifestFile{
			{SourcePath: shadowSourcePath, OriginalPath: originalPath, BackupPath: backupPath, Size: int64(len(content))},
		},
		Size: int64(len(content)),
	}
	cfg := RecoveryConfig{
		TargetPaths: map[string]string{
			originalPath: overrideTarget,
		},
	}

	filesRestored, _, warnings, _, err := restoreFiles(context.Background(), manifest, cfg, provider)
	if err != nil {
		t.Fatalf("restoreFiles failed: %v (warnings: %v)", err, warnings)
	}
	if filesRestored != 1 {
		t.Fatalf("filesRestored = %d, want 1 (warnings: %v)", filesRestored, warnings)
	}

	restored, err := os.ReadFile(overrideTarget)
	if err != nil {
		t.Fatalf("expected the file to land at the override target %q (keyed by the original path): %v", overrideTarget, err)
	}
	if !bytes.Equal(restored, content) {
		t.Fatalf("restored content = %q, want %q", restored, content)
	}
	if _, statErr := os.Stat(originalPath); statErr == nil {
		t.Fatalf("file should not have landed at the un-overridden original path %q once an override was configured", originalPath)
	}
}

// TestRestoreFiles_CapsWarningsAndCountsFailedFiles proves D14's fix: with
// every file failing to restore (the observed shape once the download route's
// per-token rate limiter starts returning 429s — see D13), restoreFiles must
// not accumulate one warning string per failure. 9,900 such strings blew the
// /bmr/recover/complete request past the API's default 1MB body-limit gate
// ("Request body too large"), so the server never even learned the recovery's
// outcome. Warnings are capped at 50 individual entries plus one summary
// line; FailedFiles carries the true count for the caller/telemetry.
func TestRestoreFiles_CapsWarningsAndCountsFailedFiles(t *testing.T) {
	const totalFiles = 10000
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir) // nothing uploaded: every Download fails

	snapshotID := "bmr-mass-failure"
	restoreRoot := t.TempDir()

	files := make([]manifestFile, totalFiles)
	for i := 0; i < totalFiles; i++ {
		files[i] = manifestFile{
			SourcePath: filepath.Join(restoreRoot, fmt.Sprintf("f%d", i)),
			BackupPath: filepath.ToSlash(path.Join("snapshots", snapshotID, "files", fmt.Sprintf("f%d.gz", i))),
			Size:       10,
		}
	}
	manifest := &snapshotManifest{ID: snapshotID, Files: files, Size: int64(totalFiles * 10)}

	filesRestored, _, warnings, failedFiles, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err == nil {
		t.Fatal("expected restoreFiles to report an error when every file fails")
	}
	if filesRestored != 0 {
		t.Fatalf("filesRestored = %d, want 0", filesRestored)
	}
	if failedFiles != totalFiles {
		t.Fatalf("failedFiles = %d, want %d", failedFiles, totalFiles)
	}
	if len(warnings) > 51 {
		t.Fatalf("len(warnings) = %d, want <= 51", len(warnings))
	}
	last := warnings[len(warnings)-1]
	if !strings.Contains(last, "9950 more") {
		t.Fatalf("last warning = %q, want it to mention '9950 more' (10000 failures - 50 individually-listed)", last)
	}
}

// TestRestoreFiles_ReappliesModeAndModTime proves O20's fix: restoreFiles
// must reapply the manifest's captured mode and modTime after a successful
// download, mirroring backup.RestoreFromSnapshot's fidelity guarantee
// (restore.go ~:241). Before this, manifestFile carried neither field, so
// every file BMR actually restored during the live D13 run (134 of them)
// landed with drifted permissions and mtimes.
func TestRestoreFiles_ReappliesModeAndModTime(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "bmr-metadata"
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "secret.gz"))

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "secret")
	content := []byte("sensitive-bytes")
	if err := os.WriteFile(srcPath, content, 0o600); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	wantMTime := time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC)
	restoreRoot := t.TempDir()
	targetPath := filepath.Join(restoreRoot, "secret")

	manifest := &snapshotManifest{
		ID: snapshotID,
		Files: []manifestFile{
			{SourcePath: targetPath, BackupPath: backupPath, Size: int64(len(content)), Mode: 0o600, ModTime: wantMTime},
		},
		Size: int64(len(content)),
	}

	filesRestored, _, warnings, failedFiles, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err != nil {
		t.Fatalf("restoreFiles failed: %v (warnings: %v)", err, warnings)
	}
	if filesRestored != 1 || failedFiles != 0 {
		t.Fatalf("filesRestored=%d failedFiles=%d, want 1/0 (warnings: %v)", filesRestored, failedFiles, warnings)
	}

	info, statErr := os.Stat(targetPath)
	if statErr != nil {
		t.Fatalf("stat restored file: %v", statErr)
	}
	if runtime.GOOS != "windows" {
		if info.Mode().Perm() != 0o600 {
			t.Errorf("mode = %o, want 0600", info.Mode().Perm())
		}
	}
	if !info.ModTime().Truncate(time.Second).Equal(wantMTime) {
		t.Errorf("modTime = %v, want %v", info.ModTime(), wantMTime)
	}
}

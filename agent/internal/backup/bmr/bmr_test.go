package bmr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

// breakerFakeProvider is a minimal in-memory BackupProvider used to
// exercise restoreFiles' consecutive-failure circuit breaker
// (maxConsecutiveDownloadFailures, bmr.go) under scripted per-call
// success/failure sequences. Unlike providers.NewLocalProvider (used by the
// fixtures elsewhere in this file), it never touches disk, so tests can
// assert an exact provider.Download call count.
type breakerFakeProvider struct {
	// downloadErr, given the 0-based index of this Download call, returns
	// the error Download should return for that call (nil for success). A
	// nil downloadErr means every call succeeds.
	downloadErr func(callIndex int) error
	calls       int
}

func (p *breakerFakeProvider) Download(_, _ string) error {
	idx := p.calls
	p.calls++
	if p.downloadErr == nil {
		return nil
	}
	return p.downloadErr(idx)
}

func (p *breakerFakeProvider) Upload(_, _ string) error        { return nil }
func (p *breakerFakeProvider) List(_ string) ([]string, error) { return nil, nil }
func (p *breakerFakeProvider) Delete(_ string) error           { return nil }

// TestRestoreFiles_CapsWarningsAndCountsFailedFiles proves D14's fix: with
// most files failing to restore (the observed shape once the download route's
// per-token rate limiter starts returning 429s — see D13), restoreFiles must
// not accumulate one warning string per failure. 9,900 such strings blew the
// /bmr/recover/complete request past the API's default 1MB body-limit gate
// ("Request body too large"), so the server never even learned the recovery's
// outcome. Warnings are capped at 50 individual entries plus one summary
// line; FailedFiles carries the true count for the caller/telemetry.
//
// Failures here are spread out — never more than
// maxConsecutiveDownloadFailures-1 in a row — so this exercises D14's cap
// without ALSO tripping the consecutive-failure circuit breaker added
// alongside it (proven separately by
// TestRestoreFiles_CircuitBreakerStopsAfterConsecutiveFailures): every file
// in the manifest must still be attempted.
func TestRestoreFiles_CapsWarningsAndCountsFailedFiles(t *testing.T) {
	const cycles = 10
	cycleLen := maxConsecutiveDownloadFailures // cycleLen-1 failures then 1 success, repeated
	totalFiles := cycles * cycleLen

	snapshotID := "bmr-mass-failure"
	restoreRoot := t.TempDir()

	provider := &breakerFakeProvider{
		downloadErr: func(idx int) error {
			if idx%cycleLen == cycleLen-1 {
				return nil // one success per cycle resets the breaker
			}
			return errors.New("simulated download failure")
		},
	}

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
		t.Fatal("expected restoreFiles to report an error when most files fail")
	}
	if provider.calls != totalFiles {
		t.Fatalf("provider.Download call count = %d, want %d (breaker must not trip on this cadence)", provider.calls, totalFiles)
	}
	wantFailed := totalFiles - cycles // one success per cycle
	if failedFiles != wantFailed {
		t.Fatalf("failedFiles = %d, want %d", failedFiles, wantFailed)
	}
	if filesRestored != cycles {
		t.Fatalf("filesRestored = %d, want %d", filesRestored, cycles)
	}
	if len(warnings) > maxRecoveryWarnings+1 {
		t.Fatalf("len(warnings) = %d, want <= %d", len(warnings), maxRecoveryWarnings+1)
	}
	last := warnings[len(warnings)-1]
	wantMore := wantFailed - maxRecoveryWarnings
	wantSubstr := fmt.Sprintf("%d more", wantMore)
	if !strings.Contains(last, wantSubstr) {
		t.Fatalf("last warning = %q, want it to mention %q", last, wantSubstr)
	}
}

// TestRestoreFiles_CircuitBreakerStopsAfterConsecutiveFailures proves the
// consecutive-failure circuit breaker (maxConsecutiveDownloadFailures,
// bmr.go): with every download failing, restoreFiles must stop attempting
// further files once it has accumulated maxConsecutiveDownloadFailures
// failures in a row, rather than working through the whole manifest.
// Without this, a large manifest against a server that has disappeared
// mid-recovery would burn downloadWithRetry's full multi-minute retry
// budget on every single remaining file.
func TestRestoreFiles_CircuitBreakerStopsAfterConsecutiveFailures(t *testing.T) {
	const totalFiles = 30 // > maxConsecutiveDownloadFailures, so the breaker must trip before the end
	snapshotID := "bmr-breaker-all-fail"
	restoreRoot := t.TempDir()

	provider := &breakerFakeProvider{
		downloadErr: func(int) error { return errors.New("simulated download failure") },
	}

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
		t.Fatal("expected restoreFiles to return an error when the circuit breaker trips")
	}
	if !strings.Contains(err.Error(), "consecutive") {
		t.Fatalf("err = %q, want it to mention 'consecutive'", err.Error())
	}
	if provider.calls != maxConsecutiveDownloadFailures {
		t.Fatalf("provider.Download call count = %d, want %d (breaker must stop further attempts, not just stop counting)", provider.calls, maxConsecutiveDownloadFailures)
	}
	if failedFiles != maxConsecutiveDownloadFailures {
		t.Fatalf("failedFiles = %d, want %d", failedFiles, maxConsecutiveDownloadFailures)
	}
	if filesRestored != 0 {
		t.Fatalf("filesRestored = %d, want 0", filesRestored)
	}
	foundAbortWarning := false
	for _, w := range warnings {
		if strings.Contains(w, "consecutive") && strings.Contains(w, "not attempted") {
			foundAbortWarning = true
			break
		}
	}
	if !foundAbortWarning {
		t.Fatalf("warnings = %v, want one mentioning consecutive failures and files not attempted", warnings)
	}
}

// TestRestoreFiles_CircuitBreakerNotTrippedByAlternatingFailures proves the
// breaker only counts a CONSECUTIVE run of failures: a fail/success
// alternation that never strings together maxConsecutiveDownloadFailures
// failures in a row must never trip the breaker, and every file in the
// manifest gets attempted.
func TestRestoreFiles_CircuitBreakerNotTrippedByAlternatingFailures(t *testing.T) {
	const totalFiles = 41 // odd, so the run also ends on a failure
	snapshotID := "bmr-breaker-alternating"
	restoreRoot := t.TempDir()

	provider := &breakerFakeProvider{
		downloadErr: func(idx int) error {
			if idx%2 == 0 {
				return errors.New("simulated download failure")
			}
			return nil
		},
	}

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
	if provider.calls != totalFiles {
		t.Fatalf("provider.Download call count = %d, want %d (breaker must not trip on alternating failures)", provider.calls, totalFiles)
	}
	wantFailed := totalFiles/2 + 1 // indices 0,2,4,...,40 fail
	if failedFiles != wantFailed {
		t.Fatalf("failedFiles = %d, want %d", failedFiles, wantFailed)
	}
	wantRestored := totalFiles - wantFailed
	if filesRestored != wantRestored {
		t.Fatalf("filesRestored = %d, want %d", filesRestored, wantRestored)
	}
	if err == nil {
		t.Fatal("expected an error since not every file restored")
	}
	if strings.Contains(err.Error(), "consecutive") {
		t.Fatalf("err = %q, must not mention 'consecutive' (breaker should not have tripped)", err.Error())
	}
	for _, w := range warnings {
		if strings.Contains(w, "aborting after") {
			t.Fatalf("warnings = %v, must not contain an abort/breaker warning", warnings)
		}
	}
}

// TestRestoreFiles_CancelledContextBeforeLoopReturnsCtxErr proves
// restoreFiles checks ctx at the very first loop iteration and, with zero
// files downloaded, returns ctx.Err() itself — not a generic wrapped
// message — so callers can distinguish cancellation from an ordinary
// restore failure.
func TestRestoreFiles_CancelledContextBeforeLoopReturnsCtxErr(t *testing.T) {
	restoreRoot := t.TempDir()
	provider := &breakerFakeProvider{
		downloadErr: func(int) error { return nil },
	}

	manifest := &snapshotManifest{
		ID: "bmr-breaker-cancelled",
		Files: []manifestFile{
			{SourcePath: filepath.Join(restoreRoot, "f0"), BackupPath: "snapshots/x/files/f0.gz", Size: 10},
		},
		Size: 10,
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	filesRestored, bytesRestored, _, failedFiles, err := restoreFiles(ctx, manifest, RecoveryConfig{}, provider)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled (ctx.Err() itself)", err)
	}
	if provider.calls != 0 {
		t.Fatalf("provider.Download call count = %d, want 0 (no downloads once ctx is already cancelled)", provider.calls)
	}
	if filesRestored != 0 || bytesRestored != 0 || failedFiles != 0 {
		t.Fatalf("filesRestored=%d bytesRestored=%d failedFiles=%d, want all 0", filesRestored, bytesRestored, failedFiles)
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

// TestRestoreFiles_ReplacesReadOnlyDestination covers D19b: restoring onto a
// machine where the target file already exists carrying the Windows
// ReadOnly attribute (mapped by Go to a 0444-style mode with the owner-write
// bit cleared) must succeed, mirroring restore.go's D19 fix for the ordinary
// restore path (TestMoveFile_ReadOnlyDestination_CopyFallbackPath). BMR's
// destination-creation happens inside whichever providers.BackupProvider is
// in use (the HTTP recoveryDownloadProvider in production,
// providers.LocalProvider here in tests) — restoreFiles itself must clear
// the read-only bit and retry the download once, since neither provider
// implementation is something this package may edit. Before the fix, a
// non-root user cannot open a 0444 file for writing on any OS, so this test
// is RED prior to the fix.
func TestRestoreFiles_ReplacesReadOnlyDestination(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores file mode bits; this test requires a non-root user")
	}

	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "bmr-readonly-dest"
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "readonly.gz"))

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "readonly")
	content := []byte("new-bytes")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	restoreRoot := t.TempDir()
	targetPath := filepath.Join(restoreRoot, "readonly.txt")
	if err := os.WriteFile(targetPath, []byte("old"), 0o644); err != nil {
		t.Fatalf("pre-create destination: %v", err)
	}
	if err := os.Chmod(targetPath, 0o444); err != nil {
		t.Fatalf("chmod destination read-only: %v", err)
	}

	manifest := &snapshotManifest{
		ID:    snapshotID,
		Files: []manifestFile{{SourcePath: targetPath, BackupPath: backupPath, Size: int64(len(content))}},
		Size:  int64(len(content)),
	}

	filesRestored, _, warnings, failedFiles, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err != nil {
		t.Fatalf("restoreFiles failed: %v (warnings: %v)", err, warnings)
	}
	if filesRestored != 1 || failedFiles != 0 {
		t.Fatalf("filesRestored=%d failedFiles=%d, want 1/0 (warnings: %v)", filesRestored, failedFiles, warnings)
	}

	got, readErr := os.ReadFile(targetPath)
	if readErr != nil {
		t.Fatalf("read restored destination: %v", readErr)
	}
	if string(got) != string(content) {
		t.Fatalf("destination content = %q, want %q", got, content)
	}
}

// TestRestoreFiles_ReadOnlySourceModeReappliedOverReadOnlyDestination proves
// that once D19b's create-retry lets the download land, the existing
// mode-reapply step (~restoreFiles:408, O20) still puts the read-only bit
// BACK: a source file captured as read-only in the manifest must end up
// read-only again at the destination, not merely writable because the fix
// had to clear that bit to get the bytes down. Uses the same pre-existing
// read-only destination as TestRestoreFiles_ReplacesReadOnlyDestination.
func TestRestoreFiles_ReadOnlySourceModeReappliedOverReadOnlyDestination(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores file mode bits; this test requires a non-root user")
	}

	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "bmr-readonly-src-and-dest"
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "readonly.gz"))

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "readonly")
	content := []byte("new-bytes")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	restoreRoot := t.TempDir()
	targetPath := filepath.Join(restoreRoot, "readonly.txt")
	if err := os.WriteFile(targetPath, []byte("old"), 0o644); err != nil {
		t.Fatalf("pre-create destination: %v", err)
	}
	if err := os.Chmod(targetPath, 0o444); err != nil {
		t.Fatalf("chmod destination read-only: %v", err)
	}

	manifest := &snapshotManifest{
		ID:    snapshotID,
		Files: []manifestFile{{SourcePath: targetPath, BackupPath: backupPath, Size: int64(len(content)), Mode: 0o444}},
		Size:  int64(len(content)),
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
		t.Fatalf("stat restored destination: %v", statErr)
	}
	if info.Mode().Perm()&0o200 != 0 {
		t.Fatalf("destination mode = %o, want owner-write bit cleared (read-only) after restore", info.Mode().Perm())
	}
	if runtime.GOOS != "windows" {
		if info.Mode().Perm() != 0o444 {
			t.Errorf("mode = %o, want 0444", info.Mode().Perm())
		}
	}
}

// TestRestoreFiles_CapsFidelityWarningsWithoutCountingAsFailedFiles proves
// the silent-failure review's item 2 fix: the chmod/chtimes post-restore
// fidelity warnings (added alongside O20's mode/mtime reapply) bypassed
// D14's cap by appending directly to warnings, so a systematic chmod
// failure across a large recovery could still blow past the API's warnings
// size limit the same way D14 fixed for download failures. Since the file's
// BYTES are restored fine when only the metadata reapply fails, these
// failures also must NOT count toward failedFiles/FailedFiles — that field
// means "bytes not restored".
func TestRestoreFiles_CapsFidelityWarningsWithoutCountingAsFailedFiles(t *testing.T) {
	const totalFiles = 10000
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "bmr-fidelity-mass-failure"
	restoreRoot := t.TempDir()

	// Upload one shared object and reference it from every manifest entry —
	// exercises 10,000 real downloads (and therefore 10,000 real chmod
	// calls) without the cost of 10,000 separate uploads.
	srcPath := filepath.Join(t.TempDir(), "shared")
	if err := os.WriteFile(srcPath, []byte("x"), 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "shared.gz"))
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	files := make([]manifestFile, totalFiles)
	for i := 0; i < totalFiles; i++ {
		files[i] = manifestFile{
			SourcePath: filepath.Join(restoreRoot, fmt.Sprintf("f%d", i)),
			BackupPath: backupPath,
			Size:       1,
			Mode:       0o644,
		}
	}
	manifest := &snapshotManifest{ID: snapshotID, Files: files, Size: totalFiles}

	origChmod := chmodFile
	chmodFile = func(string, os.FileMode) error { return errors.New("injected chmod failure") }
	defer func() { chmodFile = origChmod }()

	filesRestored, _, warnings, failedFiles, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err != nil {
		t.Fatalf("restoreFiles failed: %v (warnings head: %v)", err, warnings[:min(5, len(warnings))])
	}
	if filesRestored != totalFiles {
		t.Fatalf("filesRestored = %d, want %d", filesRestored, totalFiles)
	}
	if failedFiles != 0 {
		t.Fatalf("failedFiles = %d, want 0 (bytes were restored fine; only metadata reapply failed)", failedFiles)
	}
	if len(warnings) > maxRecoveryWarnings+2 {
		t.Fatalf("len(warnings) = %d, want capped near %d (one summary line), not one entry per failure", len(warnings), maxRecoveryWarnings)
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "more metadata failures") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected a summary line mentioning 'more metadata failures', got %d warnings, tail: %v", len(warnings), warnings[max(0, len(warnings)-3):])
	}
}

// TestRestoreFiles_FidelityFailureThenSuccessBothWarnUncapped proves the
// cap is on warning STRINGS, not files: a single chtimes failure below the
// cap still produces a readable per-file warning (not silently dropped),
// and the file still counts as restored.
func TestRestoreFiles_FidelityFailureThenSuccessBothWarnUncapped(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "bmr-fidelity-single"
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "x.gz"))

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "x")
	content := []byte("fidelity-single-content")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	restoreRoot := t.TempDir()
	targetPath := filepath.Join(restoreRoot, "x")
	manifest := &snapshotManifest{
		ID: snapshotID,
		Files: []manifestFile{
			{SourcePath: targetPath, BackupPath: backupPath, Size: int64(len(content)), ModTime: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)},
		},
		Size: int64(len(content)),
	}

	origChtimes := chtimesFile
	chtimesFile = func(string, time.Time, time.Time) error { return errors.New("injected chtimes failure") }
	defer func() { chtimesFile = origChtimes }()

	filesRestored, _, warnings, failedFiles, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err != nil {
		t.Fatalf("restoreFiles failed: %v (warnings: %v)", err, warnings)
	}
	if filesRestored != 1 || failedFiles != 0 {
		t.Fatalf("filesRestored=%d failedFiles=%d, want 1/0 (warnings: %v)", filesRestored, failedFiles, warnings)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "could not reapply mtime") {
		t.Fatalf("warnings = %v, want exactly one mtime-reapply warning", warnings)
	}
}

// W02: restoreFiles must recreate a symlink/directory manifest entry
// directly (no download attempted for its empty BackupPath) — mirrors
// backup.RestoreContentlessEntry's contract (agent/internal/backup/restore.go)
// for BMR's independent manifestFile mirror.
func TestRestoreFiles_RecreatesSymlinkWithoutDownload(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "bmr-symlink"
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "real.gz"))
	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "real")
	content := []byte("real file content")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	restoreRoot := t.TempDir()
	realTarget := filepath.Join(restoreRoot, "assure", "real")
	linkTarget := filepath.Join(restoreRoot, "assure", "link")
	dirTarget := filepath.Join(restoreRoot, "assure", "empty")

	manifest := &snapshotManifest{
		ID: snapshotID,
		Files: []manifestFile{
			{SourcePath: realTarget, BackupPath: backupPath, Size: int64(len(content))},
			{SourcePath: linkTarget, Kind: "symlink", LinkTarget: "real"},
			{SourcePath: dirTarget, Kind: "dir", ModeBits: 0o700},
		},
		Size: int64(len(content)),
	}

	filesRestored, _, warnings, failedFiles, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err != nil {
		t.Fatalf("restoreFiles failed: %v (warnings: %v)", err, warnings)
	}
	if failedFiles != 0 {
		t.Fatalf("failedFiles = %d, warnings: %v", failedFiles, warnings)
	}
	if filesRestored != 3 {
		t.Fatalf("filesRestored = %d, want 3 (1 file + 1 link + 1 dir)", filesRestored)
	}
	got, err := os.Readlink(linkTarget)
	if err != nil || got != "real" {
		t.Fatalf("symlink = %q, err = %v", got, err)
	}
	if fi, statErr := os.Stat(dirTarget); statErr != nil || !fi.IsDir() {
		t.Fatalf("dir missing: %v", statErr)
	}
	// failedFiles==0 above already proves no download was attempted (and
	// failed) for the content-less entries' empty BackupPath — LocalProvider
	// errors on a download of a nonexistent/empty key.
}

// Review finding #1 (PR #5520): restoreFiles must never write THROUGH an
// ancestor that is a symlink — a prior (possibly interrupted) run may have
// already recreated a directory-shaped manifest entry as a symlink pointing
// outside the intended restore root. Uses a TargetPaths override so the
// "override base" half of the guard is exercised (see
// symlinkAncestorBase): the override is built the way a real caller (the
// rebuild engine) builds one — stagingRoot + the original relative path —
// so the guard can recover stagingRoot as the trusted root to walk from.
func TestRestoreFiles_ResumedRunDoesNotWriteThroughRestoredSymlink(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "bmr-escape"
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "pwned.gz"))
	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "pwned")
	content := []byte("pwned content")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	stagingRoot := t.TempDir()
	outside := t.TempDir()
	// Exactly what a resumed run sees: a prior run already recreated
	// /escape as a symlink pointing OUTSIDE the staging root.
	if err := os.Symlink(outside, filepath.Join(stagingRoot, "escape")); err != nil {
		t.Fatal(err)
	}

	origPath := filepath.Join(string(filepath.Separator), "escape", "pwned")
	manifest := &snapshotManifest{
		ID: snapshotID,
		Files: []manifestFile{
			{SourcePath: origPath, BackupPath: backupPath, Size: int64(len(content))},
		},
		Size: int64(len(content)),
	}
	cfg := RecoveryConfig{
		TargetPaths: map[string]string{
			origPath: filepath.Join(stagingRoot, "escape", "pwned"),
		},
	}

	filesRestored, _, warnings, failedFiles, _ := restoreFiles(context.Background(), manifest, cfg, provider)

	if _, statErr := os.Stat(filepath.Join(outside, "pwned")); statErr == nil {
		t.Fatal("restoreFiles wrote through the symlink into the outside directory")
	}
	if failedFiles != 1 {
		t.Fatalf("failedFiles = %d, want 1 (warnings: %v)", failedFiles, warnings)
	}
	if filesRestored != 0 {
		t.Fatalf("filesRestored = %d, want 0", filesRestored)
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "symlink") {
			found = true
		}
	}
	if !found {
		t.Errorf("warnings = %v, want one mentioning symlink", warnings)
	}
}

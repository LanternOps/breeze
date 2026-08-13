package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

type encryptionTestProvider struct {
	algorithm string
	kmsKeyID  string
}

func (p *encryptionTestProvider) Upload(_, _ string) error        { return nil }
func (p *encryptionTestProvider) Download(_, _ string) error      { return nil }
func (p *encryptionTestProvider) List(_ string) ([]string, error) { return nil, nil }
func (p *encryptionTestProvider) Delete(_ string) error           { return nil }
func (p *encryptionTestProvider) SetServerSideEncryption(algorithm, kmsKeyID string) {
	p.algorithm = algorithm
	p.kmsKeyID = kmsKeyID
}

func TestExecBackupRestoreWithProgressNilManager(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"commandId":  "restore-1",
		"snapshotId": "snap-1",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execBackupRestoreWithProgress(context.Background(), "", payload, nil, nil, nil)
	if result.Success {
		t.Fatal("expected restore to fail without a configured backup manager")
	}
	if result.Stderr != "backup not configured on this device" {
		t.Fatalf("unexpected stderr: %q", result.Stderr)
	}
}

func TestExecBackupRestoreWithProgressUsesWrapperCommandID(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "restore-progress-1"
	prefix := filepath.Join("snapshots", snapshotID)

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "hello.txt")
	if err := os.WriteFile(srcPath, []byte("hello world"), 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	backupPath := filepath.ToSlash(filepath.Join(prefix, "files", "hello.txt.gz"))
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload source file: %v", err)
	}

	manifest := backup.Snapshot{
		ID: snapshotID,
		Files: []backup.SnapshotFile{
			{SourcePath: "/original/hello.txt", BackupPath: backupPath, Size: 11},
		},
		Size: 11,
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifestPath := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestPath, manifestBytes, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := provider.Upload(manifestPath, filepath.ToSlash(filepath.Join(prefix, "manifest.json"))); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider})

	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()

	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	progressCh := make(chan backupipc.BackupProgress, 1)
	go func() {
		for i := 0; i < 2; i++ {
			clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
			env, recvErr := clientIPC.Recv()
			if recvErr != nil {
				t.Errorf("recv progress: %v", recvErr)
				return
			}
			if env.Type != backupipc.TypeBackupProgress {
				t.Errorf("unexpected message type: %s", env.Type)
				return
			}
			var progress backupipc.BackupProgress
			if unmarshalErr := json.Unmarshal(env.Payload, &progress); unmarshalErr != nil {
				t.Errorf("unmarshal progress: %v", unmarshalErr)
				return
			}
			if i == 0 {
				progressCh <- progress
			}
		}
	}()

	payload, err := json.Marshal(map[string]any{
		"snapshotId": snapshotID,
		"targetPath": t.TempDir(),
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execBackupRestoreWithProgress(context.Background(), "wrapper-cmd-1", payload, mgr, nil, serverIPC)
	if !result.Success {
		t.Fatalf("expected restore to succeed, got stderr %q", result.Stderr)
	}

	select {
	case progress := <-progressCh:
		if progress.CommandID != "wrapper-cmd-1" {
			t.Fatalf("progress CommandID = %q, want wrapper-cmd-1", progress.CommandID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for restore progress")
	}
}

func TestApplyCommandStorageEncryptionConfiguresS3SSE(t *testing.T) {
	provider := &encryptionTestProvider{}
	payload, err := json.Marshal(map[string]any{
		"storageEncryption": map[string]any{
			"required":     true,
			"mode":         "s3-sse-kms",
			"keyReference": "arn:aws:kms:us-east-1:123456789012:key/abcd",
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	if err := applyCommandStorageEncryption(provider, payload); err != nil {
		t.Fatalf("apply encryption: %v", err)
	}
	if provider.algorithm != "aws:kms" || provider.kmsKeyID != "arn:aws:kms:us-east-1:123456789012:key/abcd" {
		t.Fatalf("provider encryption = %q/%q", provider.algorithm, provider.kmsKeyID)
	}
}

func TestApplyCommandStorageEncryptionFailsClosedForUnsupportedProvider(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"storageEncryption": map[string]any{
			"required": true,
			"mode":     "s3-sse-s3",
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	err = applyCommandStorageEncryption(providers.NewLocalProvider(t.TempDir()), payload)
	if err == nil {
		t.Fatal("expected unsupported provider error")
	}
	if err.Error() != "backup storage encryption is required but the configured provider cannot enforce it" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApplyCommandStorageEncryptionAllowsDisabledPayload(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"storageEncryption": map[string]any{
			"required": false,
			"mode":     "disabled",
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	if err := applyCommandStorageEncryption(providers.NewLocalProvider(t.TempDir()), payload); err != nil {
		t.Fatalf("disabled encryption should not fail: %v", err)
	}
}

func TestExecBMRRecoverRequiresTokenAndServer(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"snapshotId": "snap-1",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execBMRRecover(context.Background(), payload, nil)
	if result.Success {
		t.Fatal("expected BMR recovery to fail without token/server")
	}
	if result.Stderr != "bmr recovery requires recoveryToken and serverUrl" {
		t.Fatalf("unexpected stderr: %q", result.Stderr)
	}
}

func TestExecBMRRecoverUsesTokenDrivenRunner(t *testing.T) {
	origRunner := runBMRRecovery
	defer func() { runBMRRecovery = origRunner }()

	var gotCfg any
	runBMRRecovery = func(ctx context.Context, cfg bmr.RecoveryConfig) (*bmr.RecoveryResult, error) {
		gotCfg = cfg
		if ctx == nil {
			t.Fatal("expected context to be provided")
		}
		return &bmr.RecoveryResult{Status: "completed"}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"recoveryToken": "brz_rec_test",
		"serverUrl":     "https://api.example.com",
		"targetPaths": map[string]string{
			"/src": "/dst",
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execBMRRecover(context.Background(), payload, nil)
	if !result.Success {
		t.Fatalf("expected BMR recovery to succeed, got stderr %q", result.Stderr)
	}
	cfg, ok := gotCfg.(bmr.RecoveryConfig)
	if !ok {
		t.Fatalf("runner did not receive RecoveryConfig, got %T", gotCfg)
	}
	if cfg.RecoveryToken != "brz_rec_test" || cfg.ServerURL != "https://api.example.com" {
		t.Fatalf("runner cfg = %+v", cfg)
	}
}

// defaultVSS's OS decision must be asserted on EVERY platform, not just
// Windows: the internal/backup package (and this VSS-by-default flip) is
// excluded from the Windows CI job, so a `runtime.GOOS == "windows"`-based
// expectation is vacuously true on the Linux runners that actually run these
// tests. Passing goos explicitly makes windows→true testable everywhere.
func TestDefaultVSS(t *testing.T) {
	tests := []struct {
		name        string
		goos        string
		systemImage bool
		want        bool
	}{
		{"windows file backup defaults VSS on", "windows", false, true},
		{"windows system_image defaults VSS off", "windows", true, false},
		{"linux file backup defaults VSS off", "linux", false, false},
		{"linux system_image defaults VSS off", "linux", true, false},
		{"darwin file backup defaults VSS off", "darwin", false, false},
		{"darwin system_image defaults VSS off", "darwin", true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := defaultVSS(tt.goos, tt.systemImage); got != tt.want {
				t.Fatalf("defaultVSS(%q, %v) = %v, want %v", tt.goos, tt.systemImage, got, tt.want)
			}
		})
	}
}

func TestManagerFromBackupRunPayload(t *testing.T) {
	tests := []struct {
		name            string
		payload         string
		wantNil         bool // manager is nil (fall back to agent.yaml manager)
		wantErr         bool
		wantProvider    string   // "s3" | "local" | "" (skip provider assertion)
		wantBucket      string   // for s3
		wantBasePath    string   // for local
		wantPaths       []string // expected manager paths
		wantSystemImage bool     // expected SystemStateEnabled
		wantVSS         bool     // expected VSSEnabled
	}{
		{
			name:    "empty payload falls back to agent.yaml manager",
			payload: "",
			wantNil: true,
		},
		{
			name:    "missing providerConfig falls back",
			payload: `{"provider":"s3","paths":["/data"]}`,
			wantNil: true,
		},
		{
			name:    "missing provider falls back",
			payload: `{"providerConfig":{"bucket":"b"},"paths":["/data"]}`,
			wantNil: true,
		},
		{
			name:         "s3 provider with paths",
			payload:      `{"provider":"s3","providerConfig":{"bucket":"my-bucket","region":"us-east-1","accessKey":"AK","secretKey":"SK"},"paths":["/etc","/home/user"]}`,
			wantProvider: "s3",
			wantBucket:   "my-bucket",
			wantPaths:    []string{"/etc", "/home/user"},
			wantVSS:      runtime.GOOS == "windows",
		},
		{
			name:         "local provider with path",
			payload:      `{"provider":"local","providerConfig":{"path":"/var/backups"},"paths":["/data"]}`,
			wantProvider: "local",
			wantBasePath: filepath.Clean("/var/backups"),
			wantPaths:    []string{"/data"},
			wantVSS:      runtime.GOOS == "windows",
		},
		{
			name:         "vss:true forces VSS on for file backups regardless of OS",
			payload:      `{"provider":"local","providerConfig":{"path":"/var/backups"},"paths":["/data"],"vss":true}`,
			wantProvider: "local",
			wantBasePath: filepath.Clean("/var/backups"),
			wantPaths:    []string{"/data"},
			wantVSS:      true,
		},
		{
			name:         "vss:false forces VSS off for file backups regardless of OS",
			payload:      `{"provider":"local","providerConfig":{"path":"/var/backups"},"paths":["/data"],"vss":false}`,
			wantProvider: "local",
			wantBasePath: filepath.Clean("/var/backups"),
			wantPaths:    []string{"/data"},
			wantVSS:      false,
		},
		{
			// system_image mode manages its own consistency (system state
			// collection), so an absent vss field must not default it on even on
			// Windows.
			name:            "system_image mode without vss override defaults to VSS off",
			payload:         `{"provider":"s3","providerConfig":{"bucket":"my-bucket","region":"us-east-1","accessKey":"AK","secretKey":"SK"},"systemImage":true}`,
			wantProvider:    "s3",
			wantBucket:      "my-bucket",
			wantSystemImage: true,
			wantVSS:         false,
		},
		{
			name:            "vss:true overrides system_image mode's default-off",
			payload:         `{"provider":"s3","providerConfig":{"bucket":"my-bucket","region":"us-east-1","accessKey":"AK","secretKey":"SK"},"systemImage":true,"vss":true}`,
			wantProvider:    "s3",
			wantBucket:      "my-bucket",
			wantSystemImage: true,
			wantVSS:         true,
		},
		{
			name:    "unsupported provider errors",
			payload: `{"provider":"dropbox","providerConfig":{"bucket":"b"},"paths":["/data"]}`,
			wantErr: true,
		},
		{
			name:    "empty paths errors",
			payload: `{"provider":"s3","providerConfig":{"bucket":"b","region":"r"},"paths":[]}`,
			wantErr: true,
		},
		{
			name:    "malformed payload errors",
			payload: `{"provider":`,
			wantErr: true,
		},
		{
			// The server fans a `system_image` selection out as a backup_run
			// carrying `systemImage:true` and no `paths` (backupWorker.ts
			// resolveBackupTargets). Before the fix this tripped the "backup_run
			// payload has no paths" guard and the job failed outright.
			name:            "system_image mode needs no paths",
			payload:         `{"provider":"s3","providerConfig":{"bucket":"my-bucket","region":"us-east-1","accessKey":"AK","secretKey":"SK"},"systemImage":true}`,
			wantProvider:    "s3",
			wantBucket:      "my-bucket",
			wantSystemImage: true,
			wantVSS:         false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mgr, err := managerFromBackupRunPayload(json.RawMessage(tt.payload))
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got mgr=%v err=nil", mgr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.wantNil {
				if mgr != nil {
					t.Fatalf("expected nil manager (fallback), got %+v", mgr)
				}
				return
			}
			if mgr == nil {
				t.Fatal("expected a manager, got nil")
			}

			// Retention MUST be 0: the server owns retention and the agent must
			// never prune remote storage (DeleteSnapshotContext no-ops on 0).
			if got := mgr.GetRetention(); got != 0 {
				t.Fatalf("retention = %d, want 0 (server owns retention)", got)
			}

			gotPaths := mgr.GetPaths()
			if len(gotPaths) != len(tt.wantPaths) {
				t.Fatalf("paths = %v, want %v", gotPaths, tt.wantPaths)
			}
			for i := range tt.wantPaths {
				if gotPaths[i] != tt.wantPaths[i] {
					t.Errorf("paths[%d] = %q, want %q", i, gotPaths[i], tt.wantPaths[i])
				}
			}

			if got := mgr.GetSystemStateEnabled(); got != tt.wantSystemImage {
				t.Fatalf("SystemStateEnabled = %v, want %v", got, tt.wantSystemImage)
			}

			if got := mgr.GetVSSEnabled(); got != tt.wantVSS {
				t.Fatalf("VSSEnabled = %v, want %v", got, tt.wantVSS)
			}

			provider := mgr.GetProvider()
			switch tt.wantProvider {
			case "s3":
				s3p, ok := provider.(*providers.S3Provider)
				if !ok {
					t.Fatalf("provider type = %T, want *providers.S3Provider", provider)
				}
				if s3p.Bucket != tt.wantBucket {
					t.Errorf("bucket = %q, want %q", s3p.Bucket, tt.wantBucket)
				}
			case "local":
				localP, ok := provider.(*providers.LocalProvider)
				if !ok {
					t.Fatalf("provider type = %T, want *providers.LocalProvider", provider)
				}
				if localP.BasePath != tt.wantBasePath {
					t.Errorf("basePath = %q, want %q", localP.BasePath, tt.wantBasePath)
				}
			}
		})
	}
}

func TestParseBackupRunExcludes(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		want    []string // nil = fall back to config excludes
		wantErr bool
	}{
		{
			name:    "empty payload returns nil (config fallback)",
			payload: "",
			want:    nil,
		},
		{
			name:    "missing excludes field returns nil (old-server compat)",
			payload: `{"paths":["/data"],"jobId":"j1"}`,
			want:    nil,
		},
		{
			name:    "explicit empty list disables exclusions (non-nil empty)",
			payload: `{"paths":["/data"],"excludes":[]}`,
			want:    []string{},
		},
		{
			name:    "populated excludes decoded alongside other payload fields",
			payload: `{"jobId":"j1","paths":["C:\\Users"],"excludes":["*.tmp","node_modules/**"],"storageEncryption":{"required":false,"mode":"disabled"}}`,
			want:    []string{"*.tmp", "node_modules/**"},
		},
		{
			name:    "malformed payload returns error",
			payload: `{"excludes":`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseBackupRunExcludes(json.RawMessage(tt.payload))
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if (got == nil) != (tt.want == nil) {
				t.Fatalf("nil-ness mismatch: got %#v, want %#v (nil vs empty is the compat contract)", got, tt.want)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("excludes[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// blockingRunProvider mirrors backup_test.go's blockingUploadProvider
// (package backup, unreachable from here): it signals once upload has
// started, then blocks until the context passed to UploadContext is done.
type blockingRunProvider struct {
	once    sync.Once
	started chan struct{}
}

func newBlockingRunProvider() *blockingRunProvider {
	return &blockingRunProvider{started: make(chan struct{})}
}

func (p *blockingRunProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

func (p *blockingRunProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	p.once.Do(func() { close(p.started) })
	<-ctx.Done()
	return ctx.Err()
}

func (p *blockingRunProvider) Download(remotePath, localPath string) error { return nil }
func (p *blockingRunProvider) List(prefix string) ([]string, error)        { return []string{}, nil }
func (p *blockingRunProvider) Delete(remotePath string) error              { return nil }

// TestBackupStopCancelsPayloadDispatchedBackupRun proves the fix for the bug
// this task addresses: executeCommand's "backup_run" case builds (or, as
// here, is handed) an ephemeral BackupManager that never goes through
// mgr.Stop() — only backup_stop's commandCanceller.cancelAll() can reach it.
// Before RunBackupContext/commandCanceller.track wiring, cancelAll had
// nothing tracked for this command and the run kept going.
func TestBackupStopCancelsPayloadDispatchedBackupRun(t *testing.T) {
	provider := newBlockingRunProvider()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write temp file: %v", err)
	}

	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider, Paths: []string{dir}})
	commandCanceller := newActiveCommandCanceller()

	req := backupipc.BackupCommandRequest{
		CommandID:   "run-1",
		CommandType: "backup_run",
	}

	resultCh := make(chan backupipc.BackupCommandResult, 1)
	go func() {
		resultCh <- executeCommand(req, mgr, nil, nil, commandCanceller)
	}()

	select {
	case <-provider.started:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for backup upload to start")
	}

	if !commandCanceller.cancelAll() {
		t.Fatal("cancelAll should report an active command was cancelled")
	}

	select {
	case result := <-resultCh:
		if result.Success {
			t.Fatalf("expected backup_run to fail after backup_stop cancelled it, got success: %+v", result)
		}
		if result.Stderr != "backup stopped" {
			t.Fatalf("stderr = %q, want %q", result.Stderr, "backup stopped")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("backup_run did not unwind after backup_stop cancelled it")
	}
}

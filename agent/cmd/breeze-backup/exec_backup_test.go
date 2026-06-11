package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
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

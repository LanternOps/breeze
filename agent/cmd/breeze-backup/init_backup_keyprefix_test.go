package main

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/config"
)

// #9441: agent.yaml's backup_s3_prefix reaches the manager's S3 provider, and
// an invalid one disables the manager rather than writing at the bucket root.
func TestInitBackupManager_AppliesS3KeyPrefix(t *testing.T) {
	base := config.Config{
		AgentID:           "agent-prefix-test",
		BackupEnabled:     true,
		BackupPaths:       []string{t.TempDir()},
		BackupProvider:    "s3",
		BackupS3Bucket:    "bucket",
		BackupS3Region:    "us-east-1",
		BackupS3AccessKey: "k",
		BackupS3SecretKey: "s",
	}

	cfg := base
	cfg.BackupS3Prefix = " /msp/acme/ "
	mgr := initBackupManager(&cfg)
	if mgr == nil {
		t.Fatal("initBackupManager returned nil for a valid prefix")
	}
	s3p, ok := mgr.GetProvider().(*providers.S3Provider)
	if !ok {
		t.Fatalf("provider = %T, want *providers.S3Provider", mgr.GetProvider())
	}
	if got := s3p.KeyPrefix(); got != "msp/acme" {
		t.Fatalf("KeyPrefix() = %q, want msp/acme", got)
	}

	cfg = base
	if mgr := initBackupManager(&cfg); mgr == nil || mgr.GetProvider().(*providers.S3Provider).KeyPrefix() != "" {
		t.Fatal("no backup_s3_prefix must leave the provider at the bucket root")
	}

	cfg = base
	cfg.BackupS3Prefix = "a//b"
	if mgr := initBackupManager(&cfg); mgr != nil {
		t.Fatal("an invalid backup_s3_prefix must disable the agent.yaml backup manager, not fall back to the bucket root")
	}
	if err := agentYAMLBackupConfigError(&cfg); err == nil || !strings.Contains(err.Error(), "backup_s3_prefix") {
		t.Fatalf("agentYAMLBackupConfigError = %v, want it to name backup_s3_prefix", err)
	}
	cfg.BackupS3Prefix = "msp"
	if err := agentYAMLBackupConfigError(&cfg); err != nil {
		t.Fatalf("agentYAMLBackupConfigError(valid) = %v", err)
	}
}

// The vault must not quietly swap the refused S3 primary for a local one.
func TestBuildVaultManager_RefusesLocalFallbackWhenS3PrefixInvalid(t *testing.T) {
	cfg := &config.Config{
		BackupEnabled:   true,
		BackupPaths:     []string{t.TempDir()},
		BackupProvider:  "s3",
		BackupS3Bucket:  "bucket",
		BackupS3Region:  "us-east-1",
		BackupS3Prefix:  "a//b",
		BackupLocalPath: t.TempDir(),
		VaultEnabled:    true,
		VaultPath:       t.TempDir(),
	}
	vm, err := buildVaultManager(cfg, initBackupManager(cfg))
	if err == nil || vm != nil || !strings.Contains(err.Error(), "backup_s3_prefix") {
		t.Fatalf("buildVaultManager = %v, %v; want a backup_s3_prefix error and no vault", vm, err)
	}
}

// A command needing the agent.yaml manager reports why it is disabled, not
// the false "backup not configured on this device".
func TestExecuteCommand_ReportsDisabledAgentYAMLManager(t *testing.T) {
	prev := agentYAMLBackupDisabledReason
	t.Cleanup(func() { agentYAMLBackupDisabledReason = prev })
	agentYAMLBackupDisabledReason = "agent.yaml backup manager is disabled: backup_s3_prefix: invalid key prefix"
	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "l", CommandType: "backup_list"}, nil, &vaultManagerRef{}, nil, newActiveCommandCanceller())
	if result.Success || !strings.Contains(result.Stderr, "backup_s3_prefix") {
		t.Fatalf("result = %+v, want a failure naming backup_s3_prefix", result)
	}
}

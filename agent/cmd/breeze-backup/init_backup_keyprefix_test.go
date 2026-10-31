package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
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
}

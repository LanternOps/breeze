package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/spf13/viper"
)

func TestExecVaultConfigurePreservesEnabledWhenOmitted(t *testing.T) {
	cfgPath := writeTempAgentConfig(t, "vault_enabled: true\nvault_path: "+filepath.Join(t.TempDir(), "vault")+"\nvault_retention_count: 3\n")
	loadTempConfig(t, cfgPath)

	vaultState := &vaultManagerRef{}
	payload, err := json.Marshal(map[string]any{
		"retentionCount": 5,
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execVaultConfigure(payload, nil, vaultState)
	if !result.Success {
		t.Fatalf("expected configure to succeed, got stderr %q", result.Stderr)
	}
	if vaultState.Get() == nil {
		t.Fatal("expected vault manager to remain enabled")
	}

	cfg, err := config.Reload()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if !cfg.VaultEnabled {
		t.Fatal("expected vault_enabled to remain true")
	}
	if cfg.VaultRetentionCount != 5 {
		t.Fatalf("vault_retention_count = %d, want 5", cfg.VaultRetentionCount)
	}
}

func TestExecVaultConfigureCanEnableFromNil(t *testing.T) {
	cfgPath := writeTempAgentConfig(t, "vault_enabled: false\n")
	loadTempConfig(t, cfgPath)

	vaultState := &vaultManagerRef{}
	vaultPath := filepath.Join(t.TempDir(), "vault")
	payload, err := json.Marshal(map[string]any{
		"vaultPath": vaultPath,
		"enabled":   true,
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execVaultConfigure(payload, nil, vaultState)
	if !result.Success {
		t.Fatalf("expected configure to succeed, got stderr %q", result.Stderr)
	}
	if vaultState.Get() == nil {
		t.Fatal("expected vault manager to be initialized")
	}

	cfg, err := config.Reload()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if !cfg.VaultEnabled {
		t.Fatal("expected vault_enabled to be true")
	}
	if cfg.VaultPath != vaultPath {
		t.Fatalf("vault_path = %q, want %q", cfg.VaultPath, vaultPath)
	}
}

// #8385: a policy-managed device has no agent.yaml backup manager (mgr == nil
// is the normal state), so vault_configure and vault_sync must not fall
// through to "backup not configured on this device".
func TestExecuteCommandVaultConfigureWithoutBackupManager(t *testing.T) {
	cfgPath := writeTempAgentConfig(t, "vault_enabled: false\n")
	loadTempConfig(t, cfgPath)

	vaultState := &vaultManagerRef{}
	vaultPath := filepath.Join(t.TempDir(), "vault")
	payload, _ := json.Marshal(map[string]any{"vaultPath": vaultPath, "retentionCount": 4, "enabled": true})

	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "vc", CommandType: "vault_configure", Payload: payload},
		nil, vaultState, nil, newActiveCommandCanceller())
	if !result.Success {
		t.Fatalf("vault_configure without a backup manager failed: %q", result.Stderr)
	}
	if vaultState.Get() == nil {
		t.Fatal("expected vault manager to be initialized")
	}
}

// configuredVault loads an agent.yaml with a vault and no backup config, and
// returns the vault state the helper would build at startup.
func configuredVault(t *testing.T) (string, *vaultManagerRef) {
	t.Helper()
	vaultPath := filepath.Join(t.TempDir(), "vault")
	cfgPath := writeTempAgentConfig(t, "vault_enabled: true\nvault_path: "+vaultPath+"\nbackup_local_path: "+t.TempDir()+"\n")
	loadTempConfig(t, cfgPath)
	cfg, err := config.Reload()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	vm, err := buildVaultManager(cfg, nil)
	if err != nil || vm == nil {
		t.Fatalf("buildVaultManager: vm=%v err=%v", vm, err)
	}
	vaultState := &vaultManagerRef{}
	vaultState.Set(vm)
	return vaultPath, vaultState
}

func TestExecuteCommandVaultSyncWithoutBackupManagerReachesVault(t *testing.T) {
	vaultPath, vaultState := configuredVault(t)

	payload, _ := json.Marshal(map[string]any{"vaultId": "v1", "vaultPath": vaultPath, "snapshotId": "snap-missing"})
	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "vs", CommandType: "vault_sync", Payload: payload},
		nil, vaultState, nil, newActiveCommandCanceller())
	if result.Success {
		t.Fatal("expected sync of a missing snapshot to fail")
	}
	if !strings.Contains(result.Stderr, "vault sync failed") {
		t.Fatalf("vault_sync without a backup manager did not reach the vault: %q", result.Stderr)
	}
}

func TestExecVaultSyncRejectsVaultPathMismatch(t *testing.T) {
	vaultPath, vaultState := configuredVault(t)

	other := filepath.Join(t.TempDir(), "other-vault")
	payload, _ := json.Marshal(map[string]any{"vaultId": "v2", "vaultPath": other, "snapshotId": "snap-1"})
	result := execVaultSync(payload, vaultState)
	if result.Success {
		t.Fatal("expected a sync for a different vault path to fail")
	}
	if !strings.Contains(result.Stderr, "is configured for vault path") {
		t.Fatalf("unexpected stderr: %q", result.Stderr)
	}

	// The same path with a trailing separator is the same vault.
	same, _ := json.Marshal(map[string]any{"vaultId": "v1", "vaultPath": vaultPath + string(filepath.Separator), "snapshotId": "snap-1"})
	result = execVaultSync(same, vaultState)
	if strings.Contains(result.Stderr, "is configured for vault path") {
		t.Fatalf("trailing separator treated as a different vault: %q", result.Stderr)
	}
}

func loadTempConfig(t *testing.T, cfgPath string) {
	t.Helper()
	viper.Reset()
	t.Cleanup(viper.Reset)
	if _, err := config.Load(cfgPath); err != nil {
		t.Fatalf("load config %s: %v", cfgPath, err)
	}
}

func writeTempAgentConfig(t *testing.T, body string) string {
	t.Helper()
	cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return cfgPath
}

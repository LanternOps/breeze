package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
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

// The API sends {"enabled":false} when a device's last active vault is
// deactivated or deleted (#8385).
func TestExecuteCommandVaultConfigureDisableTearsDownVault(t *testing.T) {
	_, vaultState := configuredVault(t)

	payload, _ := json.Marshal(map[string]any{"enabled": false})
	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "vd", CommandType: "vault_configure", Payload: payload},
		nil, vaultState, nil, newActiveCommandCanceller())
	if !result.Success {
		t.Fatalf("vault_configure enabled:false failed: %q", result.Stderr)
	}
	if vaultState.Get() != nil {
		t.Fatal("expected the vault manager to be cleared")
	}
	cfg, err := config.Reload()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if cfg.VaultEnabled {
		t.Fatal("expected vault_enabled to be persisted as false")
	}

	sync, _ := json.Marshal(map[string]any{"vaultId": "v1", "snapshotId": "snap-1"})
	result = executeCommand(backupipc.BackupCommandRequest{CommandID: "vs2", CommandType: "vault_sync", Payload: sync},
		nil, vaultState, nil, newActiveCommandCanceller())
	if result.Success || !strings.Contains(result.Stderr, "vault is not configured") {
		t.Fatalf("expected a sync after disable to fail as not configured, got success=%v stderr=%q", result.Success, result.Stderr)
	}
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

// writeStoreSnapshot lays out a minimal snapshot (manifest + one data file)
// under a LocalProvider store root, the shape SyncSnapshot reads.
func writeStoreSnapshot(t *testing.T, storeRoot, snapshotID string) {
	t.Helper()
	// LocalProvider refuses a store root other accounts can read.
	if err := os.Chmod(storeRoot, 0o700); err != nil {
		t.Fatalf("chmod store root: %v", err)
	}
	store := providers.NewLocalProvider(storeRoot)
	src := filepath.Join(t.TempDir(), "object")
	for key, body := range map[string]string{
		"snapshots/" + snapshotID + "/files/a.gz":    "data for " + snapshotID,
		"snapshots/" + snapshotID + "/manifest.json": `{"id":"` + snapshotID + `"}`,
	} {
		if err := os.WriteFile(src, []byte(body), 0o600); err != nil {
			t.Fatalf("write %s: %v", key, err)
		}
		if err := store.Upload(src, key); err != nil {
			t.Fatalf("upload %s: %v", key, err)
		}
	}
}

func vaultHasSnapshot(vaultPath, snapshotID string) bool {
	_, err := os.Stat(filepath.Join(vaultPath, "snapshots", snapshotID, "manifest.json"))
	return err == nil
}

func defaultStorePath(t *testing.T) string {
	t.Helper()
	cfg, err := config.Reload()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if cfg.BackupLocalPath == "" {
		t.Fatal("configuredVault did not set backup_local_path")
	}
	return cfg.BackupLocalPath
}

// #11858: Sync now names the snapshot's own destination. A device whose
// policy-linked local destination is not the helper's default store is synced
// from that destination, not from the default one.
func TestExecVaultSyncReadsThePayloadDestination(t *testing.T) {
	vaultPath, vaultState := configuredVault(t)
	destination := t.TempDir()
	writeStoreSnapshot(t, destination, "snap-dest")

	payload, _ := json.Marshal(map[string]any{
		"vaultId": "v1", "vaultPath": vaultPath, "snapshotId": "snap-dest",
		"provider": "local", "providerConfig": map[string]any{"path": destination},
	})
	result := execVaultSync(payload, vaultState)
	if !result.Success {
		t.Fatalf("expected sync from the payload destination to succeed, got %q", result.Stderr)
	}
	if !vaultHasSnapshot(vaultPath, "snap-dest") {
		t.Fatal("snapshot was not copied into the vault")
	}
}

// A payload that names no destination (a snapshot written before destinations
// were recorded) still reads the helper's own store.
func TestExecVaultSyncWithoutDestinationReadsTheDefaultStore(t *testing.T) {
	vaultPath, vaultState := configuredVault(t)
	writeStoreSnapshot(t, defaultStorePath(t), "snap-default")

	payload, _ := json.Marshal(map[string]any{"vaultId": "v1", "vaultPath": vaultPath, "snapshotId": "snap-default"})
	result := execVaultSync(payload, vaultState)
	if !result.Success {
		t.Fatalf("expected sync from the default store to succeed, got %q", result.Stderr)
	}
	if !vaultHasSnapshot(vaultPath, "snap-default") {
		t.Fatal("snapshot was not copied into the vault")
	}
}

// A destination the helper cannot build is refused, never replaced by the
// default store.
func TestExecVaultSyncRefusesAnUnusableDestination(t *testing.T) {
	vaultPath, vaultState := configuredVault(t)
	writeStoreSnapshot(t, defaultStorePath(t), "snap-x")

	payload, _ := json.Marshal(map[string]any{
		"vaultId": "v1", "vaultPath": vaultPath, "snapshotId": "snap-x",
		"provider": "ftp", "providerConfig": map[string]any{"path": "/nowhere"},
	})
	result := execVaultSync(payload, vaultState)
	if result.Success {
		t.Fatal("expected an unsupported destination to be refused")
	}
	if !strings.Contains(result.Stderr, "unsupported backup provider") {
		t.Fatalf("unexpected stderr: %q", result.Stderr)
	}
	if vaultHasSnapshot(vaultPath, "snap-x") {
		t.Fatal("an unusable destination fell back to the default store")
	}
}

// A payload that names a provider but not a usable destination is refused: it
// must never be read as "no destination" and synced from the default store.
func TestExecVaultSyncRefusesAProviderWithoutADestination(t *testing.T) {
	for name, extra := range map[string]map[string]any{
		"no providerConfig": {"provider": "local"},
		"empty local path":  {"provider": "local", "providerConfig": map[string]any{"path": ""}},
		"no path field":     {"provider": "local", "providerConfig": map[string]any{}},
	} {
		t.Run(name, func(t *testing.T) {
			vaultPath, vaultState := configuredVault(t)
			writeStoreSnapshot(t, defaultStorePath(t), "snap-y")

			body := map[string]any{"vaultId": "v1", "vaultPath": vaultPath, "snapshotId": "snap-y"}
			for k, v := range extra {
				body[k] = v
			}
			payload, _ := json.Marshal(body)
			result := execVaultSync(payload, vaultState)
			if result.Success {
				t.Fatal("expected a provider without a destination to be refused")
			}
			if !strings.Contains(result.Stderr, "but no usable destination") {
				t.Fatalf("unexpected stderr: %q", result.Stderr)
			}
			if vaultHasSnapshot(vaultPath, "snap-y") {
				t.Fatal("a provider without a destination fell back to the default store")
			}
		})
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

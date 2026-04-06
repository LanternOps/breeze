package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

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

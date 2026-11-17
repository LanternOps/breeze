//go:build linux || darwin

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// A configured vault that cannot start (here: an existing root that is not
// private) reports why from the vault commands instead of claiming that no
// vault is configured.
func TestVaultCommandsReportVaultStartupError(t *testing.T) {
	vaultPath := filepath.Join(t.TempDir(), "vault")
	if err := os.MkdirAll(vaultPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(vaultPath, 0o755); err != nil {
		t.Fatal(err)
	}
	cfgPath := writeTempAgentConfig(t, "vault_enabled: true\nvault_path: "+vaultPath+"\nvault_retention_count: 3\n")
	loadTempConfig(t, cfgPath)
	cfg, err := config.Reload()
	if err != nil {
		t.Fatal(err)
	}

	vaultState := initVaultState(cfg, nil)
	if vaultState.Get() != nil {
		t.Fatal("a vault with a non-private root must not start")
	}

	payload, err := json.Marshal(map[string]any{"snapshotId": "snap-1"})
	if err != nil {
		t.Fatal(err)
	}
	for name, result := range map[string]func() (bool, string){
		"status": func() (bool, string) { r := execVaultStatus(vaultState); return r.Success, r.Stderr },
		"sync":   func() (bool, string) { r := execVaultSync(payload, vaultState); return r.Success, r.Stderr },
	} {
		ok, stderr := result()
		if ok {
			t.Fatalf("%s: expected failure", name)
		}
		if strings.Contains(stderr, "not configured") || !strings.Contains(stderr, "dedicated backup directory") {
			t.Fatalf("%s: expected the vault startup error, got %q", name, stderr)
		}
	}
}

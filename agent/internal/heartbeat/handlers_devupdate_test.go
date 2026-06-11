package heartbeat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"

	"github.com/breeze-rmm/agent/internal/config"
)

// loadEphemeralConfigForPersist sets up a real (but throwaway) agent.yaml
// + viper state so config.SetAndPersist can write without exploding. The
// dev_update auto_update policy unconditionally calls SetAndPersist on
// the disabling branch and we want the test to exercise that real path
// rather than mocking it away.
func loadEphemeralConfigForPersist(t *testing.T) *config.Config {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte(`agent_id: 00000000-0000-0000-0000-000000000001
server_url: https://api.example.test
auth_token: brz_test_inline
log_level: info
auto_update: true
`), 0o600); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}
	t.Cleanup(viper.Reset)

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg
}

func TestHandleDevUpdate_RejectedWhenDisabled(t *testing.T) {
	// Default (allow_dev_update unset → false): a dev_update command with a
	// valid URL + checksum must be refused outright, BEFORE any download, so a
	// compromised/MITM'd control plane cannot push an unsigned binary.
	h := &Heartbeat{config: &config.Config{AllowDevUpdate: false}}
	cmd := Command{Payload: map[string]any{
		"downloadUrl": "https://api.example.test/agent-binary",
		"checksum":    "abc123",
		"component":   "agent",
	}}

	result := handleDevUpdate(h, cmd)

	if result.Status != "failed" {
		t.Fatalf("expected failed result when dev_update disabled, got %q", result.Status)
	}
	if !strings.Contains(result.Error, "disabled") {
		t.Fatalf("expected 'disabled' rejection, got %q", result.Error)
	}
}

func TestHandleDevUpdate_GatePassesWhenEnabled(t *testing.T) {
	// With allow_dev_update: true the gate is passed — the command proceeds
	// (and then fails downloading from the unreachable test URL). The point is
	// that it is NOT rejected by the disabled-gate.
	cfg := loadEphemeralConfigForPersist(t)
	cfg.AllowDevUpdate = true
	h := &Heartbeat{config: cfg}
	cmd := Command{Payload: map[string]any{
		"downloadUrl":        "https://api.example.test/agent-binary",
		"checksum":           "abc123",
		"component":          "agent",
		"preserveAutoUpdate": true,
	}}

	result := handleDevUpdate(h, cmd)

	if strings.Contains(result.Error, "disabled") {
		t.Fatalf("gate should pass when allow_dev_update=true, but got disabled rejection: %q", result.Error)
	}
}

func TestApplyDevUpdateAutoUpdatePolicy_DefaultDisablesAutoUpdate(t *testing.T) {
	cfg := loadEphemeralConfigForPersist(t)
	cfg.AutoUpdate = true
	h := &Heartbeat{config: cfg}

	applyDevUpdateAutoUpdatePolicy(h, false)

	if h.config.AutoUpdate {
		t.Fatal("expected h.config.AutoUpdate=false after default dev push")
	}
	if got := viper.GetBool("auto_update"); got {
		t.Fatal("expected viper auto_update=false (persisted)")
	}
}

func TestApplyDevUpdateAutoUpdatePolicy_PreserveLeavesAutoUpdateUntouched(t *testing.T) {
	cfg := loadEphemeralConfigForPersist(t)
	cfg.AutoUpdate = true
	h := &Heartbeat{config: cfg}

	applyDevUpdateAutoUpdatePolicy(h, true)

	if !h.config.AutoUpdate {
		t.Fatal("expected h.config.AutoUpdate to stay true when preserveAutoUpdate=true (recovery push)")
	}
	if got := viper.GetBool("auto_update"); !got {
		t.Fatal("expected viper auto_update to stay true (no persist call)")
	}
}

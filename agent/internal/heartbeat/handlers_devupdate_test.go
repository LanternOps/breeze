package heartbeat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/netpolicy"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/updater"
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

	if h.autoUpdate() {
		t.Fatal("expected autoUpdate()=false after default dev push")
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

	if !h.autoUpdate() {
		t.Fatal("expected autoUpdate() to stay true when preserveAutoUpdate=true (recovery push)")
	}
	if got := viper.GetBool("auto_update"); !got {
		t.Fatal("expected viper auto_update to stay true (no persist call)")
	}
}

// TestDevUpdaterConfig_MatchesLiveServerURLProviders proves dev_update's
// updater.Config is wired identically to the ordinary auto-update path
// (doUpgrade in heartbeat.go): a live-resolving ServerURL provider (so a
// backup-server-URL promotion mid-flight is honored, not a captured
// snapshot) plus the resolved BackupServerURL. A dev_update path that built
// its own Config independently — or forgot BackupServerURL — would diverge
// silently here.
func TestDevUpdaterConfig_MatchesLiveServerURLProviders(t *testing.T) {
	cfg := &config.Config{
		ServerURL:       "https://primary.example",
		BackupServerURL: "https://backup.example",
	}
	h := &Heartbeat{config: cfg, agentVersion: "1.2.3"}

	updaterCfg := devUpdaterConfig(h)

	if updaterCfg.ServerURL == nil {
		t.Fatal("ServerURL provider must not be nil")
	}
	if got := updaterCfg.ServerURL(); got != "https://primary.example" {
		t.Fatalf("ServerURL() = %q, want %q", got, "https://primary.example")
	}
	if updaterCfg.BackupServerURL != "https://backup.example" {
		t.Fatalf("BackupServerURL = %q, want %q", updaterCfg.BackupServerURL, "https://backup.example")
	}

	// The provider must be LIVE (h.serverURL), not a value captured once —
	// promoting the backup after devUpdaterConfig was built must be visible
	// through the same provider, exactly like doUpgrade's updaterCfg.
	h.mu.Lock()
	h.config.ServerURL = "https://promoted.example"
	h.mu.Unlock()
	if got := updaterCfg.ServerURL(); got != "https://promoted.example" {
		t.Fatalf("ServerURL() after promotion = %q, want %q (provider went stale)", got, "https://promoted.example")
	}
}

// TestDevUpdaterConfig_RejectsSSRFTarget proves dev_update's downloader is
// the same netpolicy-enforced client as the ordinary auto-update path, not a
// separate unaudited one: a downloadUrl pointed at a loopback/private/
// metadata address is rejected regardless of the AllowDevUpdate gate being
// enabled and regardless of dev_update's checksum-only (not signed-manifest)
// trust model, because destination safety and payload trust are enforced
// independently. This exercises the exact updater.Config devUpdaterConfig
// builds and handleDevUpdateUserHelper/handleDevUpdateDesktopHelper use,
// without needing to trip their windows/darwin platform gates (this suite
// runs on ubuntu-latest in CI) or wait on handleDevUpdateAgent's background
// goroutine.
func TestDevUpdaterConfig_RejectsSSRFTarget(t *testing.T) {
	cfg := &config.Config{
		AllowDevUpdate: true,
		ServerURL:      "https://control.example",
	}
	h := &Heartbeat{
		config:       cfg,
		secureToken:  secmem.NewSecureString("brz_test"),
		agentVersion: "1.2.3",
	}

	u := updater.New(devUpdaterConfig(h))

	_, err := u.DownloadAndVerify("https://169.254.169.254/latest/meta-data/", "deadbeef")
	if err == nil {
		t.Fatal("expected the dev_update downloader to reject a cloud-metadata target")
	}
	reason, ok := updater.PolicyRejectionReason(err)
	if !ok {
		t.Fatalf("expected a *netpolicy.PolicyError in the chain, got %v", err)
	}
	if reason != netpolicy.ReasonForbiddenAddress {
		t.Fatalf("policy rejection reason = %q, want %q", reason, netpolicy.ReasonForbiddenAddress)
	}
}

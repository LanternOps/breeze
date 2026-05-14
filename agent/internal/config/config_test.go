package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

func TestIsEnrolled(t *testing.T) {
	tests := []struct {
		name string
		cfg  *Config
		want bool
	}{
		{"nil config", nil, false},
		{"empty config", &Config{}, false},
		{"agent id only (torn write)", &Config{AgentID: "abc"}, false},
		{"auth token only (torn write)", &Config{AuthToken: "tok"}, false},
		{"both present", &Config{AgentID: "abc", AuthToken: "tok"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsEnrolled(tt.cfg); got != tt.want {
				t.Errorf("IsEnrolled(%+v) = %v, want %v", tt.cfg, got, tt.want)
			}
		})
	}
}

func TestSaveToKeepsFullAgentTokensOutOfAgentYAML(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_agent"
	cfg.WatchdogAuthToken = "brz_watchdog"
	cfg.HelperAuthToken = "brz_helper"
	cfg.OrgID = "org-1"
	cfg.SiteID = "site-1"

	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo returned error: %v", err)
	}

	agentYAML, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read agent.yaml: %v", err)
	}
	text := string(agentYAML)
	for _, forbidden := range []string{"\nauth_token:", "\nwatchdog_auth_token:", "brz_agent", "brz_watchdog"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("agent.yaml contains %q:\n%s", forbidden, text)
		}
	}
	if strings.HasPrefix(text, "auth_token:") || strings.HasPrefix(text, "watchdog_auth_token:") {
		t.Fatalf("agent.yaml contains full-token key:\n%s", text)
	}
	if !strings.Contains(text, "helper_auth_token: brz_helper") {
		t.Fatalf("agent.yaml missing helper-scoped token:\n%s", text)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if loaded.AuthToken != "brz_agent" {
		t.Fatalf("AuthToken = %q, want brz_agent", loaded.AuthToken)
	}
	if loaded.WatchdogAuthToken != "brz_watchdog" {
		t.Fatalf("WatchdogAuthToken = %q, want brz_watchdog", loaded.WatchdogAuthToken)
	}
	if loaded.HelperAuthToken != "brz_helper" {
		t.Fatalf("HelperAuthToken = %q, want brz_helper", loaded.HelperAuthToken)
	}
}

func TestMigrateInlineSecretsToSecretFileScrubsAgentYAML(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte(`
agent_id: agent-1
server_url: https://api.example.test
auth_token: brz_agent_inline
watchdog_auth_token: brz_watchdog_inline
helper_auth_token: brz_helper
`), 0o640); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}

	if err := migrateInlineSecretsToSecretFile(cfgPath); err != nil {
		t.Fatalf("migrateInlineSecretsToSecretFile returned error: %v", err)
	}

	agentYAML, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read scrubbed agent.yaml: %v", err)
	}
	text := string(agentYAML)
	for _, forbidden := range []string{"brz_agent_inline", "brz_watchdog_inline", "\nauth_token:", "\nwatchdog_auth_token:"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("scrubbed agent.yaml contains %q:\n%s", forbidden, text)
		}
	}
	if !strings.Contains(text, "helper_auth_token: brz_helper") {
		t.Fatalf("scrubbed agent.yaml lost helper token:\n%s", text)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load after migration returned error: %v", err)
	}
	if loaded.AuthToken != "brz_agent_inline" {
		t.Fatalf("AuthToken = %q, want migrated token", loaded.AuthToken)
	}
	if loaded.WatchdogAuthToken != "brz_watchdog_inline" {
		t.Fatalf("WatchdogAuthToken = %q, want migrated token", loaded.WatchdogAuthToken)
	}
}

func TestSetAndPersistScrubsLegacyInlineSecrets(t *testing.T) {
	defer viper.Reset()

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte(`
agent_id: agent-1
server_url: https://api.example.test
auth_token: brz_agent_inline
watchdog_auth_token: brz_watchdog_inline
helper_auth_token: brz_helper
log_level: info
`), 0o640); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}

	if _, err := Load(cfgPath); err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if err := SetAndPersist("log_level", "debug"); err != nil {
		t.Fatalf("SetAndPersist returned error: %v", err)
	}

	agentYAML, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read scrubbed agent.yaml: %v", err)
	}
	text := string(agentYAML)
	for _, forbidden := range []string{"brz_agent_inline", "brz_watchdog_inline", "\nauth_token:", "\nwatchdog_auth_token:"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("agent.yaml contains %q after SetAndPersist:\n%s", forbidden, text)
		}
	}
	if !strings.Contains(text, "log_level: debug") {
		t.Fatalf("agent.yaml missing persisted non-secret update:\n%s", text)
	}

	secretsYAML, err := os.ReadFile(filepath.Join(dir, "secrets.yaml"))
	if err != nil {
		t.Fatalf("read secrets.yaml: %v", err)
	}
	secretsText := string(secretsYAML)
	for _, required := range []string{"auth_token: brz_agent_inline", "watchdog_auth_token: brz_watchdog_inline"} {
		if !strings.Contains(secretsText, required) {
			t.Fatalf("secrets.yaml missing %q:\n%s", required, secretsText)
		}
	}
}

// TestSaveToWritesAtomicallyWithoutLeftoverTempFiles guards #642: SaveTo must
// not leave .partial scratch files behind on success, and the on-disk files
// must contain the full serialized config (not zero-length or truncated).
func TestSaveToWritesAtomicallyWithoutLeftoverTempFiles(t *testing.T) {
	defer viper.Reset()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	const agentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg := Default()
	cfg.AgentID = agentID
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_agent_atomic"
	cfg.WatchdogAuthToken = "brz_watchdog_atomic"

	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".partial") || strings.Contains(e.Name(), ".tmp") {
			t.Fatalf("SaveTo left scratch file %q behind", e.Name())
		}
	}

	agentInfo, err := os.Stat(cfgPath)
	if err != nil {
		t.Fatalf("stat agent.yaml: %v", err)
	}
	if agentInfo.Size() == 0 {
		t.Fatalf("agent.yaml is zero-length after SaveTo")
	}
	secretsInfo, err := os.Stat(filepath.Join(dir, "secrets.yaml"))
	if err != nil {
		t.Fatalf("stat secrets.yaml: %v", err)
	}
	if secretsInfo.Size() == 0 {
		t.Fatalf("secrets.yaml is zero-length after SaveTo")
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.AgentID != agentID || loaded.AuthToken != "brz_agent_atomic" || loaded.WatchdogAuthToken != "brz_watchdog_atomic" {
		t.Fatalf("Load returned incomplete config: %+v", loaded)
	}

	// On POSIX, the perm set at OpenFile time must survive — preserving the
	// TOCTOU-permission property the previous code's comment called out.
	// Skip on Windows where POSIX mode bits don't map directly.
	if runtime.GOOS != "windows" {
		if mode := agentInfo.Mode().Perm(); mode != 0o640 {
			t.Errorf("agent.yaml mode = %o, want 0640", mode)
		}
		if mode := secretsInfo.Mode().Perm(); mode != 0o600 {
			t.Errorf("secrets.yaml mode = %o, want 0600", mode)
		}
	}
}

// TestAtomicWriteFileOverwritesExistingFile verifies the helper correctly
// replaces an existing file (the common case — every SaveTo after enrollment).
func TestAtomicWriteFileOverwritesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(path, []byte("old: value\n"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := atomicWriteFile(path, []byte("new: value\n"), 0o640); err != nil {
		t.Fatalf("atomicWriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "new: value\n" {
		t.Fatalf("content = %q, want %q", got, "new: value\n")
	}
	// No .partial leftover.
	if _, err := os.Stat(path + ".partial"); !os.IsNotExist(err) {
		t.Fatalf("expected .partial removed, got err=%v", err)
	}
}

// TestAtomicWriteFileRecoversFromStaleTemp guards the case where a previous
// crash left a .partial behind. The next write must succeed, not fail with
// O_EXCL EEXIST. Asserts both the new file is correct and the stale .partial
// was cleaned up — together these pin the pre-Remove + O_EXCL contract.
func TestAtomicWriteFileRecoversFromStaleTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	stalePartial := path + ".partial"
	if err := os.WriteFile(stalePartial, []byte("stale-contents-from-prior-crash"), 0o600); err != nil {
		t.Fatalf("seed stale: %v", err)
	}
	if err := atomicWriteFile(path, []byte("fresh\n"), 0o640); err != nil {
		t.Fatalf("atomicWriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "fresh\n" {
		t.Fatalf("content = %q, want fresh", got)
	}
	// The stale .partial must be gone (consumed by the rename), not just
	// overwritten with the fresh content — otherwise we'd be silently
	// leaking scratch files on every crash recovery.
	if _, err := os.Stat(stalePartial); !os.IsNotExist(err) {
		t.Fatalf("stale .partial still present after recovery, stat err=%v", err)
	}
}

// TestAtomicWriteFileCleansUpOnOpenFailure verifies that when the initial
// OpenFile fails (here: parent dir does not exist), no .partial is left
// behind. Pins the no-leftover invariant against future refactors that
// might drop the os.Remove calls in the error paths.
func TestAtomicWriteFileCleansUpOnOpenFailure(t *testing.T) {
	dir := t.TempDir()
	// path under a non-existent subdir → OpenFile fails with ENOENT.
	path := filepath.Join(dir, "does-not-exist", "agent.yaml")
	err := atomicWriteFile(path, []byte("data"), 0o640)
	if err == nil {
		t.Fatalf("expected error from atomicWriteFile, got nil")
	}
	if _, statErr := os.Stat(path + ".partial"); !os.IsNotExist(statErr) {
		t.Fatalf(".partial should not exist after failed open, stat err=%v", statErr)
	}
}

package config

import (
	"os"
	"path/filepath"
	"testing"
)

// writeHelperAgentYAML writes an agent.yaml with the full set of helper-relevant
// keys and returns its path.
func writeHelperAgentYAML(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}
	return path
}

func TestLoadHelperConfig(t *testing.T) {
	path := writeHelperAgentYAML(t, ""+
		"agent_id: agent-123\n"+
		"server_url: https://primary.example.com\n"+
		"helper_auth_token: helper-secret\n"+
		"ipc_socket_path: /tmp/breeze-helper.sock\n"+
		"log_shipping_level: info\n"+
		"desktop_debug: true\n")

	cfg, err := LoadHelperConfig(path)
	if err != nil {
		t.Fatalf("LoadHelperConfig() error = %v", err)
	}
	if cfg.AgentID != "agent-123" {
		t.Errorf("AgentID = %q, want agent-123", cfg.AgentID)
	}
	if cfg.ServerURL != "https://primary.example.com" {
		t.Errorf("ServerURL = %q", cfg.ServerURL)
	}
	if cfg.HelperAuthToken != "helper-secret" {
		t.Errorf("HelperAuthToken = %q, want helper-secret", cfg.HelperAuthToken)
	}
	if cfg.IPCSocketPath != "/tmp/breeze-helper.sock" {
		t.Errorf("IPCSocketPath = %q", cfg.IPCSocketPath)
	}
	if cfg.LogShippingLevel != "info" {
		t.Errorf("LogShippingLevel = %q, want info", cfg.LogShippingLevel)
	}
	if !cfg.DesktopDebug {
		t.Errorf("DesktopDebug = false, want true")
	}
}

// TestLoadHelperConfigKeepsDefaultsForAbsentKeys asserts absent keys leave the
// Default() value untouched (notably LogShippingLevel, which the shipper reads).
func TestLoadHelperConfigKeepsDefaultsForAbsentKeys(t *testing.T) {
	path := writeHelperAgentYAML(t, ""+
		"agent_id: agent-123\n"+
		"server_url: https://primary.example.com\n"+
		"helper_auth_token: helper-secret\n")

	cfg, err := LoadHelperConfig(path)
	if err != nil {
		t.Fatalf("LoadHelperConfig() error = %v", err)
	}
	if want := Default().LogShippingLevel; cfg.LogShippingLevel != want {
		t.Errorf("LogShippingLevel = %q, want default %q", cfg.LogShippingLevel, want)
	}
	if cfg.IPCSocketPath != "" {
		t.Errorf("IPCSocketPath = %q, want empty", cfg.IPCSocketPath)
	}
	if cfg.DesktopDebug {
		t.Errorf("DesktopDebug = true, want default false")
	}
}

// TestLoadHelperConfigIgnoresSecretsFile is the regression test for #2483:
// LoadHelperConfig must NOT read secrets.yaml at all. It returns the
// helper_auth_token from agent.yaml even when a secrets.yaml sitting beside it
// carries a different value (Load() would have merged the secrets one).
func TestLoadHelperConfigIgnoresSecretsFile(t *testing.T) {
	path := writeHelperAgentYAML(t, ""+
		"agent_id: agent-123\n"+
		"server_url: https://primary.example.com\n"+
		"helper_auth_token: from-agent-yaml\n")

	secretsPath := filepath.Join(filepath.Dir(path), "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("helper_auth_token: from-secrets-yaml\n"), 0600); err != nil {
		t.Fatalf("write secrets.yaml: %v", err)
	}

	cfg, err := LoadHelperConfig(path)
	if err != nil {
		t.Fatalf("LoadHelperConfig() error = %v", err)
	}
	if cfg.HelperAuthToken != "from-agent-yaml" {
		t.Errorf("HelperAuthToken = %q, want from-agent-yaml (secrets.yaml must be ignored)", cfg.HelperAuthToken)
	}
}

// TestLoadHelperConfigSucceedsWithUnreadableSecretsFile reproduces the exact
// bug: a root-only secrets.yaml the helper user cannot read. LoadHelperConfig
// must still succeed where Load() returns an error. Skipped when running as
// root, which bypasses filesystem permissions.
func TestLoadHelperConfigSucceedsWithUnreadableSecretsFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses file permissions; cannot simulate EACCES")
	}
	path := writeHelperAgentYAML(t, ""+
		"agent_id: agent-123\n"+
		"server_url: https://primary.example.com\n"+
		"helper_auth_token: helper-secret\n")

	secretsPath := filepath.Join(filepath.Dir(path), "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("auth_token: root-only\n"), 0600); err != nil {
		t.Fatalf("write secrets.yaml: %v", err)
	}
	if err := os.Chmod(secretsPath, 0000); err != nil {
		t.Fatalf("chmod secrets.yaml: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(secretsPath, 0600) })

	// Sanity check: the full Load() DOES fail on the unreadable secrets file.
	if _, err := Load(path); err == nil {
		t.Fatal("expected Load() to fail on unreadable secrets.yaml (bug precondition)")
	}

	cfg, err := LoadHelperConfig(path)
	if err != nil {
		t.Fatalf("LoadHelperConfig() error = %v (must ignore unreadable secrets.yaml)", err)
	}
	if cfg.AgentID != "agent-123" || cfg.HelperAuthToken != "helper-secret" {
		t.Errorf("cfg = %+v, want agent-123 / helper-secret from agent.yaml", cfg)
	}
}

func TestLoadHelperConfigErrors(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		if _, err := LoadHelperConfig(filepath.Join(t.TempDir(), "nope.yaml")); err == nil {
			t.Fatal("expected an error for a missing config file")
		}
	})

	t.Run("malformed yaml", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "agent.yaml")
		if err := os.WriteFile(path, []byte("agent_id: [unclosed\n"), 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadHelperConfig(path); err == nil {
			t.Fatal("expected a parse error for malformed yaml")
		}
	})
}

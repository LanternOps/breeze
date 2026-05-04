package config

import (
	"os"
	"path/filepath"
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

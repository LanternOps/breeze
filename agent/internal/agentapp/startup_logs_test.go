package agentapp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

// The config repair runs before the log file is opened; what it logs (for
// example moving a helper token out of agent.yaml) must still end up in the
// agent log file rather than in a service's discarded stdout.
func TestConfigRepairLogsReachTheAgentLogFile(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)
	t.Cleanup(func() { logging.Init("text", "info", os.Stdout) })

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte("agent_id: agent-1\nhelper_auth_token: brz_helper_legacy\n"), 0o644); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}
	viper.SetConfigFile(cfgPath)

	cfg := config.Default()
	cfg.LogFile = filepath.Join(dir, "logs", "agent.log")
	if err := os.MkdirAll(filepath.Dir(cfg.LogFile), 0o755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}
	cfg.LogLevel = "info"

	repairConfigThenInitLogging(cfg, func() {
		// Any persisted config write runs the same agent.yaml scrub as the
		// startup permission repair.
		if err := config.SetAndPersist("log_level", "info"); err != nil {
			t.Fatalf("SetAndPersist: %v", err)
		}
	})

	data, err := os.ReadFile(cfg.LogFile)
	if err != nil {
		t.Fatalf("read agent log: %v", err)
	}
	if !strings.Contains(string(data), "helper token found in agent.yaml") {
		t.Fatalf("config repair log line missing from the agent log file:\n%s", data)
	}
	if strings.Contains(string(data), "brz_helper_legacy") {
		t.Fatalf("agent log carries the token value:\n%s", data)
	}
}

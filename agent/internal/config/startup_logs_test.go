package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
)

// The agent runs FixConfigPermissions before the file logger exists, so its
// records are held and written once logging is set up — not lost to the
// service's discarded stdout.
func TestStartupLogsAreHeldUntilLoggingIsInitialized(t *testing.T) {
	var early, late bytes.Buffer
	logging.Init("text", "info", &early)
	t.Cleanup(func() {
		FlushStartupLogs()
		logging.Init("text", "info", os.Stdout)
	})
	t.Cleanup(resetHelperTokenRotationStateForTest)

	HoldStartupLogs()
	cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte("agent_id: agent-1\nhelper_auth_token: brz_helper_legacy\n"), 0o644); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}
	fixAgentYAMLPermissions(cfgPath)

	if strings.Contains(early.String(), "helper token found in agent.yaml") {
		t.Fatalf("startup record was written before logging was initialized:\n%s", early.String())
	}

	logging.Init("text", "info", &late)
	FlushStartupLogs()

	out := late.String()
	if !strings.Contains(out, "helper token found in agent.yaml") || !strings.Contains(out, "component=config") {
		t.Fatalf("held startup record missing from the initialized log:\n%s", out)
	}
	if strings.Contains(out, "brz_helper_legacy") {
		t.Fatalf("startup log carries the token value:\n%s", out)
	}

	// After the flush, records go straight to the logger again.
	late.Reset()
	log.Warn("after flush")
	if !strings.Contains(late.String(), "after flush") {
		t.Fatalf("record after the flush was not written directly:\n%s", late.String())
	}
}

// Holding is bounded: a runaway producer cannot grow memory without limit,
// and the flush says how many records were dropped.
func TestStartupLogHoldIsBounded(t *testing.T) {
	var out bytes.Buffer
	logging.Init("text", "info", &out)
	t.Cleanup(func() {
		FlushStartupLogs()
		logging.Init("text", "info", os.Stdout)
	})

	HoldStartupLogs()
	for i := 0; i < maxHeldStartupLogs+5; i++ {
		log.Info("held record")
	}
	FlushStartupLogs()

	if got := strings.Count(out.String(), "held record"); got != maxHeldStartupLogs {
		t.Fatalf("flushed %d held records, want %d", got, maxHeldStartupLogs)
	}
	if !strings.Contains(out.String(), "dropped=5") {
		t.Fatalf("flush did not report the dropped records:\n%s", out.String())
	}
}

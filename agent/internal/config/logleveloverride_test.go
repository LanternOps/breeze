package config

import (
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
)

// The agent writes and every helper reads the override at this path, so it
// must resolve to the shared config directory (next to agent.yaml), not a
// per-user or per-process location (#7416).
func TestLogLevelOverridePathIsInConfigDir(t *testing.T) {
	got := LogLevelOverridePath()
	want := filepath.Join(ConfigDir(), logging.LevelOverrideFileName)
	if got != want {
		t.Fatalf("LogLevelOverridePath() = %q, want %q", got, want)
	}
	if filepath.Dir(got) != ConfigDir() {
		t.Fatalf("override path %q is not directly in the config dir %q", got, ConfigDir())
	}
}

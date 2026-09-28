//go:build darwin

package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// The decision logic lives (and is tested, on every platform) in
// internal/macrelocate; this pins the agent-specific wiring.
func TestAgentRelocateConfig(t *testing.T) {
	cfg := agentRelocateConfig()
	if cfg.LegacyDir != securefs.LegacyExecutableDir || cfg.TrustedDir != securefs.TrustedExecutableDir {
		t.Fatalf("dirs = %q -> %q", cfg.LegacyDir, cfg.TrustedDir)
	}
	if cfg.PlistPath != "/Library/LaunchDaemons/com.breeze.agent.plist" {
		t.Fatalf("plist = %q", cfg.PlistPath)
	}
	if len(cfg.Siblings) != 1 || cfg.Siblings[0] != "breeze-backup" {
		t.Fatalf("siblings = %v", cfg.Siblings)
	}
	if cfg.RecordDir != "/Library/Application Support/Breeze" {
		t.Fatalf("record dir = %q, want the config dir the heartbeat reads", cfg.RecordDir)
	}
	d := defaultRelocateDeps()
	if d.VerifyLocation == nil || d.RemoveLegacyFile == nil || d.WriteRecord == nil || d.Log == nil {
		t.Fatal("production deps must be fully wired")
	}
}

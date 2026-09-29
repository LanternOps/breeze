//go:build darwin

package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// The decision logic and the shared production deps live (and are tested,
// on Linux CI too) in internal/macrelocate; this pins the watchdog-specific
// configuration.
func TestWatchdogRelocateConfig(t *testing.T) {
	cfg := watchdogRelocateConfig()
	if cfg.LegacyDir != securefs.LegacyExecutableDir || cfg.TrustedDir != securefs.TrustedExecutableDir {
		t.Fatalf("dirs = %q -> %q", cfg.LegacyDir, cfg.TrustedDir)
	}
	if cfg.PlistPath != "/Library/LaunchDaemons/com.breeze.watchdog.plist" {
		t.Fatalf("plist = %q", cfg.PlistPath)
	}
	if cfg.RecordDir != "" || len(cfg.Siblings) != 0 {
		t.Fatalf("watchdog must not record or clean siblings: %+v", cfg)
	}
}

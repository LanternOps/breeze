//go:build darwin

package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// The decision logic lives (and is tested, on every platform) in
// internal/macrelocate; this pins the watchdog-specific wiring.
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
	d := defaultRelocateDeps()
	if d.VerifyLocation == nil || d.RemoveLegacyFile == nil || d.Log == nil {
		t.Fatal("production deps must be fully wired")
	}
}

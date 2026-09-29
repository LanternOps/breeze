//go:build darwin

package main

import (
	"log/slog"

	"github.com/breeze-rmm/agent/internal/macrelocate"
	"github.com/breeze-rmm/agent/internal/securefs"
)

// watchdogRelocateConfig describes the watchdog binary for
// internal/macrelocate. No RecordDir: the device page reports the agent's
// Full Disk Access, not the watchdog's.
func watchdogRelocateConfig() macrelocate.Config {
	return macrelocate.Config{
		LegacyDir:  securefs.LegacyExecutableDir,
		TrustedDir: securefs.TrustedExecutableDir,
		PlistPath:  watchdogPlistDst,
	}
}

// maybeMigrateLegacyInstall is the darwin entry point called from
// runWatchdog. See internal/macrelocate for the rationale (#7211).
func maybeMigrateLegacyInstall() {
	macrelocate.Run(watchdogRelocateConfig(), macrelocate.DefaultDeps(slog.Default()))
}

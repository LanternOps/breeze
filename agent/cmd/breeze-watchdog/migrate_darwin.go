//go:build darwin

package main

import (
	"log/slog"
	"os"
	"os/exec"
	"syscall"
	"time"

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

// defaultRelocateDeps mirrors internal/agentapp's identical wiring.
func defaultRelocateDeps() macrelocate.Deps {
	return macrelocate.Deps{
		Geteuid:        os.Geteuid,
		Executable:     os.Executable,
		VerifyLocation: securefs.VerifyTrustedExecutablePathChain,
		Migrate: func(legacyPath, trustedDir string) (string, error) {
			return securefs.MigrateExecutableToTrustedDir(nil, legacyPath, trustedDir)
		},
		StartDetached: func(script string) error {
			cmd := exec.Command("/bin/sh", "-c", script)
			cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			if err := cmd.Start(); err != nil {
				return err
			}
			return cmd.Process.Release()
		},
		ReadFile:         os.ReadFile,
		Lstat:            os.Lstat,
		RemoveLegacyFile: securefs.RemoveRegularFileNoFollow,
		WriteRecord:      macrelocate.WriteRecord,
		Now:              time.Now,
		Log:              slog.Default(),
	}
}

// maybeMigrateLegacyInstall is the darwin entry point called from
// runWatchdog. See internal/macrelocate for the rationale (#7211).
func maybeMigrateLegacyInstall() {
	macrelocate.Run(watchdogRelocateConfig(), defaultRelocateDeps())
}

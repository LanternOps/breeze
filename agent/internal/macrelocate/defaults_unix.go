//go:build darwin || linux

package macrelocate

import (
	"log/slog"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// DefaultDeps is the production wiring the agent and the watchdog both use.
// It is built for linux too (where Run is never called) so its wiring is
// exercised by the required Linux CI job, not only the advisory macOS one.
func DefaultDeps(log *slog.Logger) Deps {
	return Deps{
		Geteuid:        os.Geteuid,
		Executable:     os.Executable,
		VerifyLocation: securefs.VerifyTrustedExecutablePathChain,
		Migrate:        migrateToTrustedDir,
		StartDetached: func(script string) error {
			// script comes from BuildRelocateScript: fixed plist path plus
			// this process's own executable path and its trusted twin.
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
		WriteRecord:      WriteRecord,
		Now:              time.Now,
		Log:              log,
	}
}

//go:build windows

package bmr

import (
	"log/slog"
	"os/exec"
	"path/filepath"
)

// windowsRestorer applies Windows-specific system state during BMR.
type windowsRestorer struct{}

func newRestorer() Restorer {
	return &windowsRestorer{}
}

// RestoreSystemState applies the Windows system state that is safe to apply
// to the running OS: the certificate database and the firewall policy.
// Registry hives and the BCD store are collected for reference only and
// never applied here (#5470, Option B); see restoreWindowsLiveState in
// restore_windows_logic.go.
func (r *windowsRestorer) RestoreSystemState(stagingDir string) (RestoreReport, error) {
	slog.Info("bmr: restoring Windows system state", "stagingDir", stagingDir)
	report, err := restoreWindowsLiveState(stagingDir)
	if err != nil {
		return report, err
	}
	slog.Info("bmr: Windows system state restore complete", "nothingApplied", report.NothingApplied != "")
	return report, nil
}

// InjectDrivers installs drivers from the given directory using pnputil.
func (r *windowsRestorer) InjectDrivers(driverDir string) (int, error) {
	slog.Info("bmr: injecting Windows drivers", "driverDir", driverDir)

	pattern := filepath.Join(driverDir, "*.inf")
	cmd := exec.Command("pnputil", "/add-driver", pattern, "/install", "/subdirs")
	output, err := cmd.CombinedOutput()
	if err != nil {
		slog.Warn("bmr: pnputil driver injection had errors",
			"error", err.Error(),
			"output", string(output),
		)
	}

	// Count .inf files as an approximation of drivers processed.
	matches, _ := filepath.Glob(filepath.Join(driverDir, "**", "*.inf"))
	count := len(matches)
	if count == 0 {
		topLevel, _ := filepath.Glob(pattern)
		count = len(topLevel)
	}

	slog.Info("bmr: driver injection complete", "driversProcessed", count)
	return count, err
}

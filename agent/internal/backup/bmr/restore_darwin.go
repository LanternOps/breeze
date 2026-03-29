//go:build darwin

package bmr

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
)

// darwinRestorer applies macOS-specific system state during BMR.
type darwinRestorer struct{}

func newRestorer() Restorer {
	return &darwinRestorer{}
}

// RestoreSystemState applies macOS system state from the staging directory.
// This includes system preferences, LaunchDaemons/LaunchAgents, and network
// configuration.
func (r *darwinRestorer) RestoreSystemState(stagingDir string) error {
	slog.Info("bmr: restoring macOS system state", "stagingDir", stagingDir)

	if err := r.restorePreferences(stagingDir); err != nil {
		slog.Warn("bmr: preferences restore had errors", "error", err.Error())
	}
	if err := r.restoreLaunchItems(stagingDir); err != nil {
		slog.Warn("bmr: launch items restore had errors", "error", err.Error())
	}
	if err := r.restoreNetworkConfig(stagingDir); err != nil {
		slog.Warn("bmr: network config restore failed", "error", err.Error())
	}

	slog.Info("bmr: macOS system state restore complete")
	return nil
}

// InjectDrivers is a no-op on macOS (kext injection is not supported via BMR).
func (r *darwinRestorer) InjectDrivers(_ string) (int, error) {
	slog.Info("bmr: driver injection not applicable on macOS")
	return 0, nil
}

// restorePreferences copies backed-up preference plists back to /Library/Preferences/.
func (r *darwinRestorer) restorePreferences(stagingDir string) error {
	srcDir := filepath.Join(stagingDir, "preferences")
	if _, err := os.Stat(srcDir); os.IsNotExist(err) {
		return nil
	}

	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return fmt.Errorf("read preferences dir: %w", err)
	}

	destDir := "/Library/Preferences"
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		src := filepath.Join(srcDir, entry.Name())
		dst := filepath.Join(destDir, entry.Name())

		data, readErr := os.ReadFile(src)
		if readErr != nil {
			slog.Warn("bmr: read pref file failed", "file", entry.Name(), "error", readErr.Error())
			continue
		}
		if writeErr := os.WriteFile(dst, data, 0o644); writeErr != nil {
			slog.Warn("bmr: write pref file failed", "file", entry.Name(), "error", writeErr.Error())
			continue
		}
		slog.Info("bmr: preference restored", "file", entry.Name())
	}
	return nil
}

// restoreLaunchItems copies LaunchDaemons and LaunchAgents plists back.
func (r *darwinRestorer) restoreLaunchItems(stagingDir string) error {
	targets := []struct {
		src  string
		dest string
	}{
		{filepath.Join(stagingDir, "LaunchDaemons"), "/Library/LaunchDaemons"},
		{filepath.Join(stagingDir, "LaunchAgents"), "/Library/LaunchAgents"},
	}

	for _, target := range targets {
		if _, err := os.Stat(target.src); os.IsNotExist(err) {
			continue
		}
		entries, err := os.ReadDir(target.src)
		if err != nil {
			slog.Warn("bmr: read launch dir failed", "dir", target.src, "error", err.Error())
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			src := filepath.Join(target.src, entry.Name())
			dst := filepath.Join(target.dest, entry.Name())

			data, readErr := os.ReadFile(src)
			if readErr != nil {
				slog.Warn("bmr: read launch item failed", "file", entry.Name(), "error", readErr.Error())
				continue
			}
			if writeErr := os.WriteFile(dst, data, 0o644); writeErr != nil {
				slog.Warn("bmr: write launch item failed", "file", entry.Name(), "error", writeErr.Error())
				continue
			}
			slog.Info("bmr: launch item restored", "file", entry.Name(), "dest", target.dest)
		}
	}
	return nil
}

// restoreNetworkConfig restores network settings via networksetup.
func (r *darwinRestorer) restoreNetworkConfig(stagingDir string) error {
	confPath := filepath.Join(stagingDir, "network_config.plist")
	if _, err := os.Stat(confPath); os.IsNotExist(err) {
		return nil
	}

	// Copy the SystemConfiguration preferences plist.
	dest := "/Library/Preferences/SystemConfiguration/preferences.plist"
	data, err := os.ReadFile(confPath)
	if err != nil {
		return fmt.Errorf("read network config: %w", err)
	}
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return fmt.Errorf("write network config: %w", err)
	}

	// Poke configd to reload.
	cmd := exec.Command("killall", "configd")
	if output, runErr := cmd.CombinedOutput(); runErr != nil {
		slog.Warn("bmr: configd reload failed", "error", runErr.Error(), "output", string(output))
	}

	slog.Info("bmr: network configuration restored")
	return nil
}

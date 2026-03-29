package systemstate

import (
	"fmt"
	"log/slog"
	"os"
)

// CollectSystemState gathers all platform-specific system state artifacts
// into a temporary staging directory. The caller is responsible for adding
// the staging directory contents to the backup archive and cleaning up
// the staging directory when finished.
func CollectSystemState() (manifest *SystemStateManifest, stagingDir string, err error) {
	stagingDir, err = os.MkdirTemp("", "breeze-systemstate-*")
	if err != nil {
		return nil, "", fmt.Errorf("systemstate: failed to create staging dir: %w", err)
	}

	collector := NewCollector()
	manifest, err = collector.CollectState(stagingDir)
	if err != nil {
		// Clean up staging dir on failure.
		if removeErr := os.RemoveAll(stagingDir); removeErr != nil {
			slog.Warn("systemstate: failed to clean up staging dir after error",
				"dir", stagingDir, "error", removeErr.Error())
		}
		return nil, "", fmt.Errorf("systemstate: collection failed: %w", err)
	}

	slog.Info("systemstate: collection complete",
		"platform", manifest.Platform,
		"artifacts", len(manifest.Artifacts),
		"stagingDir", stagingDir,
	)
	return manifest, stagingDir, nil
}

// CollectHardwareOnly captures hardware information without performing
// a full system state collection. Useful for inventory and recovery planning.
func CollectHardwareOnly() (*HardwareProfile, error) {
	collector := NewCollector()
	profile, err := collector.CollectHardwareProfile()
	if err != nil {
		return nil, fmt.Errorf("systemstate: hardware profile failed: %w", err)
	}
	return profile, nil
}

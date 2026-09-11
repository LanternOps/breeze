package systemstate

import (
	"fmt"
	"log/slog"
	"os"
	"sort"
)

// manifestSchemaVersion is the current SystemStateManifest shape version —
// see SystemStateManifest.SchemaVersion's doc comment.
const manifestSchemaVersion = 1

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
	if manifest != nil {
		manifest.SchemaVersion = manifestSchemaVersion
	}
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

// missingRequired returns the subset of failed (incomplete) collection steps
// that are required for a restorable system image. A non-empty result means the
// collection must be treated as a hard failure rather than a best-effort
// partial — an image missing these classes (e.g. registry/boot on Windows)
// would not boot at restore time, so it must not present as a full capture.
// The required set is supplied by each platform collector.
func missingRequired(incomplete []string, required map[string]bool) []string {
	var missing []string
	for _, s := range incomplete {
		if required[s] {
			missing = append(missing, s)
		}
	}
	return missing
}

// sortedRequiredSteps returns the sorted step names required is required==true
// for, so SystemStateManifest.RequiredSteps has a stable, deterministic order
// independent of Go's map iteration — callers set manifest.RequiredSteps to
// this so a consumer (bare-metal recovery) can independently enforce the same
// required-step policy the collector itself enforces via missingRequired.
func sortedRequiredSteps(required map[string]bool) []string {
	if len(required) == 0 {
		return nil
	}
	steps := make([]string, 0, len(required))
	for name, isRequired := range required {
		if isRequired {
			steps = append(steps, name)
		}
	}
	sort.Strings(steps)
	return steps
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

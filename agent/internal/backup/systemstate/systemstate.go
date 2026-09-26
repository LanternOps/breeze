package systemstate

import (
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
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

// collectionStep is one named system-state collection step.
type collectionStep struct {
	name string
	fn   func(stagingDir string) ([]Artifact, error)
}

// runCollectionSteps runs each step into stagingDir, appending artifacts to
// manifest and recording failed steps in manifest.IncompleteSteps. Individual
// step failures are logged and do not abort the run. It returns an error when
// no step produced an artifact, or when a step in required failed.
//
// A failed step's artifacts are still recorded: a step may return the pieces
// it did capture alongside its error (collectRegistryHives returns the hives
// that saved with a *registrySaveError), and those files are already in
// stagingDir, so the manifest lists them rather than silently omitting them
// (#7001). This does not soften the pass/fail decision — the step is still in
// IncompleteSteps, and a required step's failure still returns an error that
// carries the step's own reason (#6505).
func runCollectionSteps(manifest *SystemStateManifest, steps []collectionStep, stagingDir string, required map[string]bool) error {
	var requiredErrs []error
	for _, s := range steps {
		arts, err := s.fn(stagingDir)
		manifest.Artifacts = append(manifest.Artifacts, arts...)
		if err != nil {
			slog.Warn("systemstate: step failed", "step", s.name, "error", err.Error(), "partialArtifacts", len(arts))
			manifest.IncompleteSteps = append(manifest.IncompleteSteps, s.name)
			if required[s.name] {
				requiredErrs = append(requiredErrs, fmt.Errorf("%s: %w", s.name, err))
			}
		}
	}

	missing := missingRequired(manifest.IncompleteSteps, required)
	if len(manifest.Artifacts) == 0 {
		if len(missing) > 0 {
			// Every step failed (e.g. an unelevated agent): still carry the
			// required steps' reasons so the failed hives reach error_log.
			return fmt.Errorf("system state collection produced no artifacts - all %d steps failed: %w",
				len(steps), &requiredStepsError{Missing: missing, StepErrs: requiredErrs})
		}
		return fmt.Errorf("system state collection produced no artifacts - all %d steps failed", len(steps))
	}
	if len(missing) > 0 {
		// Carry each required step's own error (e.g. the registry step's
		// "reg save failed for hive(s) [SAM SECURITY]: ...") on the returned
		// error. This string is what lands in backup_jobs.error_log; naming
		// only the step left operators without the failed hive (#6505).
		return &requiredStepsError{Missing: missing, StepErrs: requiredErrs}
	}
	return nil
}

// requiredStepsError reports that one or more required collection steps
// failed, so the captured image would not be restorable. StepErrs holds each
// failed required step's error (prefixed with the step name) and is exposed via
// Unwrap so errors.As/errors.Is still reach the underlying step error (e.g.
// *registrySaveError).
type requiredStepsError struct {
	Missing  []string
	StepErrs []error
}

func (e *requiredStepsError) Error() string {
	msg := fmt.Sprintf("system state collection missing required artifact(s) %v - image would not be restorable", e.Missing)
	if len(e.StepErrs) == 0 {
		return msg
	}
	reasons := make([]string, len(e.StepErrs))
	for i, err := range e.StepErrs {
		reasons[i] = err.Error()
	}
	return msg + ": " + strings.Join(reasons, "; ")
}

func (e *requiredStepsError) Unwrap() []error { return e.StepErrs }

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

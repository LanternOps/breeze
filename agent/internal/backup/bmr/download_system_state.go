package bmr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// ErrNoSystemState is returned by DownloadSystemState when
// snapshots/<id>/system-state/manifest.json does not exist and expect was
// false — "this snapshot never captured system state", not an error.
var ErrNoSystemState = errors.New("bmr: no system state found in snapshot")

// DownloadSystemState fetches snapshots/<id>/system-state/manifest.json and
// every artifact into stagingDir, verifying each checksum before returning.
//
// Unlike applySystemState's artifact loop (best-effort: a bad artifact is
// discarded and logged as a warning so a live recovery still applies
// whatever it can), DownloadSystemState fails hard on the FIRST verification
// problem it hits. It exists for callers — the rebuild engine's preflight
// phase — whose whole point is to refuse before any write happens, never to
// silently proceed past a corrupted artifact. expect=true makes a missing
// manifest a hard error (the caller already knows the snapshot advertises
// system state, e.g. via layout/bootstrap metadata); expect=false returns
// the sentinel ErrNoSystemState so the caller can treat "nothing to
// restore" as a soft outcome. The caller owns stagingDir — it is neither
// created nor removed here.
func DownloadSystemState(ctx context.Context, provider providers.BackupProvider, snapshotID string, expect bool, stagingDir string) (*systemstate.SystemStateManifest, []string, error) {
	stateManifestKey := path.Join(snapshotRootDir, snapshotID, systemStatePath, "manifest.json")

	tmpFile, tmpErr := os.CreateTemp("", "bmr-state-manifest-*.json")
	if tmpErr != nil {
		return nil, nil, fmt.Errorf("bmr: create temp: %w", tmpErr)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer func() { _ = os.Remove(tmpPath) }()

	if dlErr := provider.Download(stateManifestKey, tmpPath); dlErr != nil {
		if expect {
			return nil, nil, fmt.Errorf("bmr: snapshot advertises system state but system-state/manifest.json is missing: %w", dlErr)
		}
		return nil, nil, ErrNoSystemState
	}

	data, readErr := os.ReadFile(tmpPath)
	if readErr != nil {
		return nil, nil, fmt.Errorf("bmr: read state manifest: %w", readErr)
	}
	var stateManifest systemstate.SystemStateManifest
	if err := json.Unmarshal(data, &stateManifest); err != nil {
		return nil, nil, fmt.Errorf("bmr: decode state manifest: %w", err)
	}

	var warnings []string
	if blocking := intersectStrings(stateManifest.RequiredSteps, stateManifest.IncompleteSteps); len(blocking) > 0 {
		return nil, nil, fmt.Errorf("bmr: required system-state steps incomplete: %s", strings.Join(blocking, ", "))
	}
	if nonRequired := subtractStrings(stateManifest.IncompleteSteps, stateManifest.RequiredSteps); len(nonRequired) > 0 {
		warnings = append(warnings, fmt.Sprintf("system state capture incomplete for non-required steps: %s", strings.Join(nonRequired, ", ")))
	}
	if expect && len(stateManifest.Artifacts) == 0 {
		return nil, nil, fmt.Errorf("bmr: system-state manifest has no artifacts")
	}

	for _, artifact := range stateManifest.Artifacts {
		if ctx != nil && ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		localPath, pathErr := resolveStagingArtifactPath(stagingDir, artifact.Path)
		if pathErr != nil {
			return nil, nil, fmt.Errorf("artifact %s (%s): %w", artifact.Name, artifact.Path, pathErr)
		}
		if mkErr := os.MkdirAll(filepath.Dir(localPath), 0o750); mkErr != nil {
			return nil, nil, fmt.Errorf("artifact %s (%s): create dir: %w", artifact.Name, artifact.Path, mkErr)
		}
		if artifact.LinkTarget != "" {
			if rmErr := os.Remove(localPath); rmErr != nil && !os.IsNotExist(rmErr) {
				return nil, nil, fmt.Errorf("artifact %s (%s): clear existing path: %w", artifact.Name, artifact.Path, rmErr)
			}
			if symErr := symlinkFile(artifact.LinkTarget, localPath); symErr != nil {
				return nil, nil, fmt.Errorf("artifact %s (%s): create symlink: %w", artifact.Name, artifact.Path, symErr)
			}
			continue
		}
		remoteKey := path.Join(snapshotRootDir, snapshotID, systemStatePath, artifact.Path)
		if dlErr := provider.Download(remoteKey, localPath); dlErr != nil {
			_ = os.Remove(localPath)
			return nil, nil, fmt.Errorf("artifact %s (%s): download: %w", artifact.Name, artifact.Path, dlErr)
		}
		if verifyErr := verifyArtifactIntegrity(localPath, artifact); verifyErr != nil {
			_ = os.Remove(localPath)
			return nil, nil, fmt.Errorf("artifact %s (%s): %w", artifact.Name, artifact.Path, verifyErr)
		}
		if artifact.Checksum == "" {
			warnings = append(warnings, fmt.Sprintf("artifact %s (%s) has no checksum (older manifest schema), unverified", artifact.Name, artifact.Path))
		}
		warnings = append(warnings, applyArtifactMetadata(localPath, artifact)...)
	}
	return &stateManifest, warnings, nil
}

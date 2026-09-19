package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// fetchLayout downloads and decodes snapshots/<id>/layout.json. A missing
// object or an unsupported schema version is a RefusalError, not a plain
// error — preflight surfaces it verbatim as the operator-facing refusal
// reason.
func fetchLayout(ctx context.Context, provider providers.BackupProvider, snapshotID string) (*layout.Manifest, error) {
	tmp, err := os.CreateTemp("", "breeze-layout-*.json")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := provider.Download(path.Join("snapshots", snapshotID, "layout.json"), tmpPath); err != nil {
		return nil, &RefusalError{Reason: layout.ReasonNilManifest + " for snapshot " + snapshotID + " (was the backup taken with the whole-machine profile?)"}
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, err
	}
	var m layout.Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("decode layout.json: %w", err)
	}
	if m.SchemaVersion != layout.SchemaVersion {
		return nil, &RefusalError{Reason: fmt.Sprintf("layout schema version %d is not supported by this helper (supports %d)", m.SchemaVersion, layout.SchemaVersion)}
	}
	return &m, nil
}

// fetchManifest downloads and decodes snapshots/<id>/manifest.json — the
// ordinary whole-machine file backup manifest (same shape as
// backup.downloadManifest's own snapshots/<id>/manifest.json read).
func fetchManifest(ctx context.Context, provider providers.BackupProvider, snapshotID string) (*backup.Snapshot, error) {
	tmp, err := os.CreateTemp("", "breeze-manifest-*.json")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := provider.Download(path.Join("snapshots", snapshotID, "manifest.json"), tmpPath); err != nil {
		return nil, &RefusalError{Reason: "snapshot manifest not found for " + snapshotID}
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, err
	}
	var s backup.Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("decode manifest.json: %w", err)
	}
	return &s, nil
}

// SnapshotAdvertisesSystemState reports whether the snapshot in storage
// looks like a whole-machine (system_image) capture that should carry
// system state: it has snapshots/<id>/system-state/manifest.json, or a
// layout.json (only ever written by the system_image profile). It is the
// local-provider stand-in for bmr.SnapshotExpectsSystemState when there is
// no server bootstrap to ask (breeze-backup rebuild --provider-config,
// #5412). Only a positively confirmed absence (providers.ErrObjectNotFound)
// of both objects yields false; any other download failure is returned so
// a transport blip never silently downgrades the run to files-only.
func SnapshotAdvertisesSystemState(ctx context.Context, provider providers.BackupProvider, snapshotID string) (bool, error) {
	for _, key := range []string{
		path.Join("snapshots", snapshotID, "system-state", "manifest.json"),
		path.Join("snapshots", snapshotID, "layout.json"),
	} {
		if ctx != nil && ctx.Err() != nil {
			return false, ctx.Err()
		}
		tmp, err := os.CreateTemp("", "breeze-probe-*.json")
		if err != nil {
			return false, err
		}
		tmpPath := tmp.Name()
		_ = tmp.Close()
		err = provider.Download(key, tmpPath)
		_ = os.Remove(tmpPath)
		switch {
		case err == nil:
			return true, nil
		case errors.Is(err, providers.ErrObjectNotFound):
			continue
		default:
			return false, fmt.Errorf("probe %s: %w", key, err)
		}
	}
	return false, nil
}

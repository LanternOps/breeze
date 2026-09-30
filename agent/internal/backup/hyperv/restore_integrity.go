package hyperv

// Integrity expectations for the restores that rebuild a VM disk from a file
// snapshot (vm_restore_from_backup, vm_instant_boot). Platform-neutral so the
// rules are tested on any OS.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// vmRestoreManifest matches the snapshot manifest shape for deserialization.
type vmRestoreManifest struct {
	ID    string               `json:"id"`
	Files []vmRestoreManifFile `json:"files"`
	Size  int64                `json:"size"`
}

// fetchVMRestoreManifest fetches and parses a snapshot manifest from the
// provider. With an expectation (which must be for snapshotID) the manifest
// is fetched through integrity.FetchControlObject, so in attested mode its
// bytes match the snapshot attestation before they are parsed; the returned
// warnings then carry the unattested-snapshot warning once for an override or
// informational expectation. Without one it is downloaded as before.
func fetchVMRestoreManifest(ctx context.Context, snapshotID string, provider providers.BackupProvider, expect *integrity.Expectation) (*vmRestoreManifest, []string, error) {
	if err := expect.CheckSnapshot(snapshotID); err != nil {
		return nil, nil, err
	}
	manifestKey := path.Join("snapshots", snapshotID, "manifest.json")

	var data []byte
	var warnings []string
	if expect.Present() {
		var err error
		data, warnings, err = integrity.FetchControlObject(ctx, provider, expect, integrity.RoleManifest, manifestKey, "")
		if err != nil {
			return nil, nil, fmt.Errorf("download manifest: %w", err)
		}
		if w := expect.UnattestedWarning(); w != "" {
			warnings = append(warnings, w)
		}
	} else {
		tmpFile, err := os.CreateTemp("", "vmrestore-manifest-*.json")
		if err != nil {
			return nil, nil, fmt.Errorf("create temp: %w", err)
		}
		tmpPath := tmpFile.Name()
		_ = tmpFile.Close()
		defer os.Remove(tmpPath)

		if err := provider.Download(manifestKey, tmpPath); err != nil {
			return nil, nil, fmt.Errorf("download manifest: %w", err)
		}

		data, err = os.ReadFile(tmpPath)
		if err != nil {
			return nil, nil, fmt.Errorf("read manifest: %w", err)
		}
	}

	var manifest vmRestoreManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, nil, fmt.Errorf("decode manifest: %w", err)
	}
	return &manifest, warnings, nil
}

// appendBoundedWarnings appends add to dst, keeping at most maxReportedFiles
// entries (the server keeps no more). Earlier entries win.
func appendBoundedWarnings(dst []string, add ...string) []string {
	for _, w := range add {
		if len(dst) >= maxReportedFiles {
			break
		}
		dst = append(dst, w)
	}
	return dst
}

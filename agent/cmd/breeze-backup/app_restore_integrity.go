package main

// Integrity expectations for the database and VM restores (hyperv_restore,
// mssql_restore, mssql_verify, vm_restore_from_backup, vm_instant_boot).
// Without an `integrity` block in the payload every path below behaves as it
// did before expectations existed.

import (
	"context"
	"encoding/json"
	"os"
	"path"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// appRestoreIntegrity reads a restore command's integrity block and refuses
// one issued for another snapshot than snapshotID. (nil, nil) when the
// payload carries none; any error fails the command.
func appRestoreIntegrity(payload json.RawMessage, snapshotID string) (*integrity.Expectation, error) {
	e, err := integrity.FromPayload(payload)
	if err != nil {
		return nil, err
	}
	if err := e.CheckSnapshot(snapshotID); err != nil {
		return nil, err
	}
	return e, nil
}

// readAppSnapshotManifest returns the bytes of snapshots/<id>/manifest.json.
// With an expectation the manifest is fetched through
// integrity.FetchControlObject, so in attested mode its bytes match the
// attestation before anything parses them; without one it is downloaded as
// before. tempPattern names the temporary download file.
func readAppSnapshotManifest(ctx context.Context, provider providers.BackupProvider, snapshotID, tempPattern string, expect *integrity.Expectation) ([]byte, []string, error) {
	manifestKey := path.Join("snapshots", snapshotID, "manifest.json")
	if expect.Present() {
		return integrity.FetchControlObject(ctx, provider, expect, integrity.RoleManifest, manifestKey, "")
	}

	tempFile, err := os.CreateTemp("", tempPattern)
	if err != nil {
		return nil, nil, err
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	defer func() { _ = os.Remove(tempPath) }()

	if err := provider.Download(manifestKey, tempPath); err != nil {
		return nil, nil, err
	}
	data, err := os.ReadFile(tempPath)
	if err != nil {
		return nil, nil, err
	}
	return data, nil, nil
}

// withUnattestedWarning appends the unattested-snapshot warning (once) when
// the expectation is an override or informational one.
func withUnattestedWarning(warnings []string, expect *integrity.Expectation) []string {
	if w := expect.UnattestedWarning(); w != "" {
		return append(warnings, w)
	}
	return warnings
}

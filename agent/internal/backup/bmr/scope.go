package bmr

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// ScopeRefusalError is returned by ApplyManifestScope when the manifest
// cannot be honoured safely: an unparseable object key, or external
// references present without a negotiated, verified, matching file index.
// It is a distinct type (not a bare error) so every caller can distinguish
// "refuse this recovery" (post a `refused` progress update, write nothing)
// from any other failure mode via errors.As.
type ScopeRefusalError struct {
	Reason   string
	External int
	First    string
}

func (e *ScopeRefusalError) Error() string { return "bmr: " + e.Reason }

// scopedProvider is implemented by *recoveryDownloadProvider
// (download_provider.go, Task 9). A provider that does not implement it
// (e.g. the plain local/S3 providers used outside token-mode recovery) is
// never confined — see ApplyManifestScope's first branch.
type scopedProvider interface {
	MembershipNegotiated() bool
	ExtendAdmissible(keys []string)
	Admits(key string) bool
}

// ExternalObjectKeys returns the sorted, de-duplicated keys of content
// entries whose snapshot segment differs from ownSnapshotID. A key that
// fails ParseObjectKey is returned in bad (also sorted, de-duplicated) —
// callers must treat any non-empty bad as a hard refusal, never silently
// skip it (an unparseable key could be a malformed reference to anything).
func ExternalObjectKeys(backupPaths []string, ownSnapshotID string) (external []string, bad []string) {
	extSet := map[string]struct{}{}
	badSet := map[string]struct{}{}
	for _, key := range backupPaths {
		if key == "" {
			continue
		}
		ext, _, ok := IsExternalObjectKey(key, ownSnapshotID)
		if !ok {
			badSet[key] = struct{}{}
			continue
		}
		if ext {
			extSet[key] = struct{}{}
		}
	}
	for k := range extSet {
		external = append(external, k)
	}
	for k := range badSet {
		bad = append(bad, k)
	}
	sort.Strings(external)
	sort.Strings(bad)
	return external, bad
}

// ApplyManifestScope is called once, after the manifest is downloaded and
// BEFORE any target write. It never performs I/O itself (WidenScopeFromManifest
// and RunRecoveryContext's own manifest download do that) — it only
// classifies backupPaths against ownSnapshotID and decides whether the
// provider's admissible set may be widened.
func ApplyManifestScope(provider providers.BackupProvider, ownSnapshotID string, backupPaths []string, manifestSHA256 string, fi *FileIndexInfo) error {
	sp, ok := provider.(scopedProvider)
	if !ok {
		// Not a token-mode recovery provider (e.g. CLI --target against a
		// plain S3/local provider outside the recovery flow) — no
		// confinement applies.
		return nil
	}

	external, bad := ExternalObjectKeys(backupPaths, ownSnapshotID)
	if len(bad) > 0 {
		return &ScopeRefusalError{
			Reason: fmt.Sprintf("manifest contains %d unparseable object key(s) (first: %q); refusing rather than guessing scope", len(bad), bad[0]),
			First:  bad[0],
		}
	}
	if len(external) == 0 {
		return nil
	}
	if !sp.MembershipNegotiated() {
		return &ScopeRefusalError{
			Reason:   fmt.Sprintf("this backup references %d file(s) stored with earlier snapshots and the server did not grant cross-snapshot downloads. Upgrade the Breeze server or choose a self-contained (full) snapshot.", len(external)),
			External: len(external),
			First:    external[0],
		}
	}
	if fi == nil {
		// The server negotiated the capability (so it CAN speak this
		// protocol) but did not send a fileIndex — meaning the server
		// believed this snapshot was self-contained (referenced_files
		// NULL/0, e.g. from an older agent that never recorded the count)
		// even though the manifest we just read proves otherwise. Never
		// widen scope on an assumption; refuse and let the operator
		// re-create the recovery so the server can re-evaluate it.
		return &ScopeRefusalError{
			Reason:   fmt.Sprintf("this backup references %d file(s) stored with earlier snapshots but the server has no verified file index for it; create the recovery again or choose a self-contained (full) snapshot.", len(external)),
			External: len(external),
			First:    external[0],
		}
	}
	if fi.Status != "complete" {
		return &ScopeRefusalError{
			Reason:   "the server's file index for this snapshot is not ready (fileIndex present but not complete); the recovery should not have reached this phase",
			External: len(external),
			First:    external[0],
		}
	}
	if fi.ManifestSHA256 != manifestSHA256 {
		return &ScopeRefusalError{
			Reason:   "the server's file index does not match this snapshot's manifest; create the recovery again.",
			External: len(external),
			First:    external[0],
		}
	}
	sp.ExtendAdmissible(external)
	return nil
}

// WidenScopeFromManifest downloads snapshots/<id>/manifest.json through
// provider into a temp file, hashes it, parses the entries, and calls
// ApplyManifestScope. It is the CLI token-mode path's gate (buildTokenModeOptions),
// run before rebuild.Run / DryRun ever starts — the rebuild engine's own
// manifest fetch happens later, independently, inside preflight.
// bs.Snapshot must be non-nil (callers already require this for every
// other field they read off it).
func WidenScopeFromManifest(ctx context.Context, provider providers.BackupProvider, bs *BootstrapResponse) error {
	if bs == nil || bs.Snapshot == nil {
		return fmt.Errorf("bmr: WidenScopeFromManifest: bootstrap missing snapshot")
	}
	snapshotID := bs.Snapshot.SnapshotID

	tmp, err := os.CreateTemp("", "bmr-scope-manifest-*.json")
	if err != nil {
		return fmt.Errorf("bmr: create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)

	manifestKey := "snapshots/" + snapshotID + "/manifest.json"
	if err := provider.Download(manifestKey, tmpPath); err != nil {
		return fmt.Errorf("bmr: download manifest for scope check: %w", err)
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return fmt.Errorf("bmr: read manifest for scope check: %w", err)
	}
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])

	var manifest snapshotManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return fmt.Errorf("bmr: decode manifest for scope check: %w", err)
	}
	paths := make([]string, 0, len(manifest.Files))
	for _, f := range manifest.Files {
		if f.BackupPath == "" {
			continue // dirs/symlinks/placeholders carry no BackupPath
		}
		paths = append(paths, f.BackupPath)
	}
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	return ApplyManifestScope(provider, snapshotID, paths, sha, bs.Snapshot.FileIndex)
}

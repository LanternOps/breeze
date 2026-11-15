package backup

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/objectkey"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VaultConfig defines configuration for the local vault.
type VaultConfig struct {
	VaultPath      string
	RetentionCount int
	Enabled        bool
}

// VaultManager manages a local vault (a disk or USB drive attached to the
// device; network shares are refused by the local provider) that mirrors
// snapshots from the primary backup provider for offline or fast-local recovery.
//
// The vault mirrors primary's key layout. An incremental snapshot's manifest
// references unchanged files by the absolute key they were first uploaded
// under, inside an older snapshot's prefix (see referenceEntry), so a vault
// snapshot is complete only when the vault holds every key its manifest
// references, wherever it lives (#11857). Sync copies by the manifest and
// retention keeps by the manifests of the snapshots it keeps.
type VaultManager struct {
	config  VaultConfig
	primary providers.BackupProvider
	vault   providers.BackupProvider // LocalProvider pointed at VaultPath
}

// vaultMu serializes the vault's mutations (sync and retention) within the
// helper process. vault_sync is not an execution-queue workload, so a manual
// sync can run beside the sync that follows a backup, and a reconfigure
// builds a new VaultManager over the same directory. Retention that ran
// between one sync's reference copies and its manifest upload would delete
// those copies (no manifest references them yet), leaving a vault snapshot
// that reports complete without its bytes.
var vaultMu sync.Mutex

// VaultStatus reports the current state of the local vault.
type VaultStatus struct {
	Enabled        bool   `json:"enabled"`
	VaultPath      string `json:"vaultPath"`
	SnapshotCount  int    `json:"snapshotCount"`
	TotalSizeBytes int64  `json:"totalSizeBytes"`
	LastSyncAt     string `json:"lastSyncAt,omitempty"`
}

// VaultSyncResult reports a completed sync. FileCount and TotalBytes cover
// every object the vault copy of the snapshot consists of: the objects under
// its own prefix (manifest included) plus the objects its manifest
// references under older snapshots' prefixes, whether this run copied them
// or the vault already held them. TotalBytes is the stored size in the vault
// (0 when the vault provider cannot report sizes).
type VaultSyncResult struct {
	SnapshotID       string `json:"snapshotId"`
	VaultPath        string `json:"vaultPath,omitempty"`
	FileCount        int    `json:"fileCount"`
	TotalBytes       int64  `json:"totalBytes"`
	ManifestVerified bool   `json:"manifestVerified"`
}

// NewVaultManager creates a VaultManager. It creates the vault directory if
// needed and initializes a LocalProvider for it.
func NewVaultManager(cfg VaultConfig, primary providers.BackupProvider) (*VaultManager, error) {
	if cfg.VaultPath == "" {
		return nil, errors.New("vault path is required")
	}
	if primary == nil {
		return nil, errors.New("primary provider is required")
	}
	if cfg.RetentionCount <= 0 {
		cfg.RetentionCount = 3
	}

	vault := providers.NewLocalProvider(cfg.VaultPath)
	if err := vault.Prepare(); err != nil {
		return nil, fmt.Errorf("failed to create vault directory: %w", err)
	}

	return &VaultManager{
		config:  cfg,
		primary: primary,
		vault:   vault,
	}, nil
}

// SyncSnapshot copies a snapshot from the primary provider into the vault.
// See syncSnapshotFrom.
func (v *VaultManager) SyncSnapshot(snapshotID string) (*VaultSyncResult, error) {
	vaultMu.Lock()
	defer vaultMu.Unlock()
	return v.syncSnapshotFrom(v.primary, snapshotID)
}

// syncSnapshotFrom copies snapshotID from primary into the vault:
//  1. Download and decode the manifest; validate every key it references.
//  2. Collect the objects to hold: everything under the snapshot's own prefix
//     on primary, plus every non-empty BackupPath the manifest references
//     (an incremental entry's key lies under an older snapshot's prefix).
//  3. Copy each object the vault lacks, at the same key.
//  4. Only when every object is in the vault, upload the manifest.
//
// Any object that cannot be copied fails the sync and the manifest is not
// uploaded, so the vault never presents a snapshot it cannot restore. The
// objects this run created are then deleted again: no manifest would ever
// reference them, so retention would never reclaim them. Deleting them is
// safe because vaultMu is held and they were absent before this run under
// every spelling (vaultKeyFold), so no complete vault snapshot references
// them. Anything not proven absent is left: an orphan costs space, a wrong
// delete costs a backup.
func (v *VaultManager) syncSnapshotFrom(primary providers.BackupProvider, snapshotID string) (*VaultSyncResult, error) {
	if primary == nil {
		return nil, errors.New("primary provider is required")
	}
	if !validVaultSnapshotID(snapshotID) {
		return nil, fmt.Errorf("vault sync: snapshot ID %q is not a valid snapshot ID", snapshotID)
	}
	prefix := path.Join(snapshotRootDir, snapshotID)
	manifestKey := path.Join(prefix, snapshotManifestKey)

	// 1. Download the manifest from primary and read the keys it references.
	manifestTmp, err := os.CreateTemp("", "vault-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp manifest: %w", err)
	}
	manifestTmpPath := manifestTmp.Name()
	_ = manifestTmp.Close()
	defer os.Remove(manifestTmpPath)

	if err := primary.Download(manifestKey, manifestTmpPath); err != nil {
		return nil, fmt.Errorf("failed to download manifest from primary: %w", err)
	}
	manifest, err := readManifestReferences(manifestTmpPath, snapshotID)
	if err != nil {
		return nil, fmt.Errorf("vault sync refused snapshot %s: %w", snapshotID, err)
	}

	// 2. Everything under the snapshot's own prefix on primary, plus every
	// referenced key. The manifest itself is uploaded last (step 4).
	primaryFiles, err := listSnapshotPrefixItems(primary, snapshotID)
	if err != nil {
		return nil, fmt.Errorf("failed to list primary snapshot files: %w", err)
	}
	want := make(map[string]struct{}, len(primaryFiles)+len(manifest.refs))
	for _, file := range primaryFiles {
		want[file] = struct{}{}
	}
	for key := range manifest.refs {
		want[key] = struct{}{}
	}
	delete(want, manifestKey)
	objects := sortedKeys(want)

	// 3. Copy what the vault lacks. The vault is listed once per snapshot
	// prefix the objects fall under.
	inVault, listed := v.vaultObjectsUnder(objects)
	var errs []error
	// copied holds only keys proven absent before this run: their prefix was
	// listed and held no object under ANY spelling of the key (vaultKeyFold).
	// On a case- or normalization-insensitive vault the listing spells an
	// object as it is on disk, so a key the manifest spells differently is
	// copied again (rewriting the same object in place), but it was already
	// there, possibly for a complete snapshot, and a failed sync must not
	// delete it. A key under a prefix whose listing failed is likewise copied
	// but never counted.
	var copied []string
	for _, file := range objects {
		// Skipping the copy needs the exact key: on a case-sensitive vault a
		// differently-spelled object is a different object.
		if _, exists := inVault.exact[file]; exists {
			continue
		}
		if err := v.copyFromPrimary(primary, file); err != nil {
			errs = append(errs, err)
			slog.Warn("vault sync: object not copied", "snapshotId", snapshotID, "key", file, "error", err.Error())
			continue
		}
		if _, preexisting := inVault.folded[vaultKeyFold(file)]; listed[snapshotIDOfKey(file)] && !preexisting {
			copied = append(copied, file)
		}
	}
	if len(errs) > 0 {
		v.removeCopied(snapshotID, copied)
		return nil, fmt.Errorf("vault sync failed: %d of %d objects of snapshot %s could not be copied, so the vault does not hold this snapshot: %w",
			len(errs), len(objects), snapshotID, errors.Join(errs...))
	}

	// 4. Every object is in the vault: the manifest makes the snapshot visible.
	if err := v.vault.Upload(manifestTmpPath, manifestKey); err != nil {
		v.removeCopied(snapshotID, copied)
		return nil, fmt.Errorf("vault sync failed at manifest upload: %w", err)
	}

	// The result counts each object once: on a case-insensitive primary the
	// listing and the manifest can spell one object two ways.
	held := distinctByFold(append(objects, manifestKey))
	syncResult := &VaultSyncResult{
		SnapshotID:       snapshotID,
		VaultPath:        v.config.VaultPath,
		FileCount:        len(held),
		ManifestVerified: true,
	}
	if totalSize, ok := v.vaultSizeOf(held); ok {
		syncResult.TotalBytes = totalSize
	}

	slog.Info("vault sync completed", "snapshotId", snapshotID,
		"objects", len(held), "referencedObjects", manifest.externalRefs)
	return syncResult, nil
}

// distinctByFold returns keys without the later ones whose vaultKeyFold
// repeats an earlier one's. It is for counting only, never for deciding what
// to copy or delete.
func distinctByFold(keys []string) []string {
	seen := make(map[string]struct{}, len(keys))
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		folded := vaultKeyFold(key)
		if _, dup := seen[folded]; dup {
			continue
		}
		seen[folded] = struct{}{}
		out = append(out, key)
	}
	return out
}

// removeCopied deletes the objects a failed sync copied (see
// syncSnapshotFrom). Best effort: a leftover is only unreclaimed space.
func (v *VaultManager) removeCopied(snapshotID string, copied []string) {
	for _, key := range copied {
		if err := v.vault.Delete(key); err != nil && !errors.Is(err, providers.ErrObjectNotFound) {
			slog.Warn("vault sync: could not remove an object copied by the failed sync",
				"snapshotId", snapshotID, "key", key, "error", err.Error())
		}
	}
}

// copyFromPrimary copies one object from primary into the vault at the same
// key, through a temporary file. LocalProvider.Upload writes through a
// temporary file renamed over the key, so an interrupted copy never leaves a
// truncated object that a later sync would take as present.
func (v *VaultManager) copyFromPrimary(primary providers.BackupProvider, key string) error {
	tmpFile, err := os.CreateTemp("", "vault-sync-*")
	if err != nil {
		return fmt.Errorf("temp file for %s: %w", key, err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer func() { _ = os.Remove(tmpPath) }()

	if err := primary.Download(key, tmpPath); err != nil {
		return fmt.Errorf("download %s: %w", key, err)
	}
	if err := v.vault.Upload(tmpPath, key); err != nil {
		return fmt.Errorf("upload %s to vault: %w", key, err)
	}
	return nil
}

// vaultHeld is what the vault listing showed before a sync copied anything:
// each key exactly as listed, and each key's vaultKeyFold.
type vaultHeld struct {
	exact  map[string]struct{}
	folded map[string]struct{}
}

// vaultObjectsUnder returns the vault's objects under each snapshot prefix
// that keys fall under, and which prefixes were listed successfully. A
// prefix whose listing fails is treated as empty, so its objects are copied
// again rather than assumed present, and is absent from listed. An item is
// taken as under the prefix when its snapshot segment folds to the prefix's
// (a provider may spell the prefix as stored), so no object the vault holds
// under another spelling is missed when proving a key absent.
func (v *VaultManager) vaultObjectsUnder(keys []string) (held vaultHeld, listed map[string]bool) {
	held = vaultHeld{exact: map[string]struct{}{}, folded: map[string]struct{}{}}
	listed = map[string]bool{}
	tried := map[string]bool{}
	rootFold := vaultKeyFold(snapshotRootDir)
	for _, key := range keys {
		id := snapshotIDOfKey(key)
		if id == "" || tried[id] {
			continue
		}
		tried[id] = true
		items, err := v.vault.List(path.Join(snapshotRootDir, id) + "/")
		if err != nil {
			slog.Warn("vault: failed to list existing vault objects, will copy them again",
				"snapshotId", id, "error", err.Error())
			continue
		}
		listed[id] = true
		idFold := vaultKeyFold(id)
		for _, item := range items {
			parts := strings.SplitN(path.Clean(item), "/", 3)
			if len(parts) < 3 || vaultKeyFold(parts[0]) != rootFold || vaultKeyFold(parts[1]) != idFold {
				continue
			}
			held.exact[item] = struct{}{}
			held.folded[vaultKeyFold(item)] = struct{}{}
		}
	}
	return held, listed
}

// vaultSizeOf sums the stored sizes of keys in the vault, read in one walk
// per snapshot prefix. A key the size listing spells differently (the
// spelling on disk of a case- or normalization-insensitive vault) is found by
// its vaultKeyFold when exactly one listed object has that fold.
func (v *VaultManager) vaultSizeOf(keys []string) (int64, bool) {
	sizer, ok := v.vault.(interface {
		ObjectSizes(string) (map[string]int64, error)
	})
	if !ok {
		return 0, false
	}
	type prefixSizes struct {
		exact  map[string]int64
		folded map[string]int64 // -1: more than one object has this fold
	}
	byPrefix := map[string]*prefixSizes{}
	var total int64
	for _, key := range keys {
		id := snapshotIDOfKey(key)
		sizes, seen := byPrefix[id]
		if !seen {
			exact, err := sizer.ObjectSizes(path.Join(snapshotRootDir, id))
			if err != nil {
				slog.Warn("vault sync: could not read object sizes, reporting no size",
					"snapshotId", id, "error", err.Error())
				return 0, false
			}
			sizes = &prefixSizes{exact: exact, folded: make(map[string]int64, len(exact))}
			for listedKey, size := range exact {
				folded := vaultKeyFold(listedKey)
				if _, dup := sizes.folded[folded]; dup {
					sizes.folded[folded] = -1
				} else {
					sizes.folded[folded] = size
				}
			}
			byPrefix[id] = sizes
		}
		size, found := sizes.exact[key]
		if !found {
			size, found = sizes.folded[vaultKeyFold(key)]
		}
		if !found || size < 0 {
			slog.Warn("vault sync: a copied object is missing from the size listing, reporting no size", "key", key)
			return 0, false
		}
		total += size
	}
	return total, true
}

// EnforceRetention deletes the oldest snapshots from the vault beyond the
// configured retention count. See enforceRetention.
func (v *VaultManager) EnforceRetention() error {
	vaultMu.Lock()
	defer vaultMu.Unlock()
	return v.enforceRetention()
}

// enforceRetention keeps the newest RetentionCount snapshots and drops the
// rest. A dropped snapshot's objects (those under its own prefix, and those
// its manifest references under older prefixes) are deleted unless a kept
// snapshot's manifest references them or they lie under a kept snapshot's
// own prefix; its manifest is deleted last, and only once every other
// deletion for it succeeded, so a partly-deleted snapshot stays listed and
// the next retention finishes it.
//
// Every keep decision compares folded keys (vaultKeyFold). The vault listing
// returns keys as stored on disk, and on a case- or normalization-insensitive
// vault filesystem that spelling can differ from the one a kept manifest
// records (snapshot A's "Dir/b.txt" and "dir/c.txt" share one directory
// "Dir", listed as "Dir/c.txt.gz" while a kept incremental references
// "dir/c.txt.gz"): an exact comparison would delete the only copy. Folding
// can only keep more, so it applies on every provider.
//
// Every manifest in the vault must be read first: an unreadable one could
// be a kept snapshot whose references are unknown, so retention then deletes
// nothing and returns why. Only the kept snapshots' references are held
// (folded) while retention runs; a dropped snapshot's manifest is read again
// when its turn comes, one at a time.
func (v *VaultManager) enforceRetention() error {
	snapshots, err := v.readVaultSnapshots()
	if err != nil {
		return fmt.Errorf("vault retention deleted nothing: %w", err)
	}
	if len(snapshots) <= v.config.RetentionCount {
		return nil
	}

	// readVaultSnapshots sorts oldest-first.
	cut := len(snapshots) - v.config.RetentionCount
	dropped, kept := snapshots[:cut], snapshots[cut:]
	keep := vaultKeepSet{keys: map[string]struct{}{}, ids: map[string]struct{}{}}
	for _, snap := range kept {
		keep.ids[vaultKeyFold(snap.id)] = struct{}{}
		ts, err := v.scanVaultManifest(snap.manifestKey, snap.id, func(key string, _ objectkey.Parsed) {
			keep.keys[vaultKeyFold(key)] = struct{}{}
		})
		if err != nil {
			return fmt.Errorf("vault retention deleted nothing: kept snapshot %s could not be read again: %w", snap.id, err)
		}
		if !ts.Equal(snap.timestamp) {
			return fmt.Errorf("vault retention deleted nothing: kept snapshot %s changed while retention ran", snap.id)
		}
	}

	var errs []error
	for _, snap := range dropped {
		if _, shared := keep.ids[vaultKeyFold(snap.id)]; shared {
			// Two snapshot IDs that fold together share one directory on a
			// case-insensitive vault: deleting this one's manifest could delete
			// the kept one's. Leave it.
			slog.Warn("vault retention: not dropping a snapshot whose ID folds onto a kept snapshot's",
				"snapshotId", snap.id)
			continue
		}
		if err := v.dropVaultSnapshot(snap, keep); err != nil {
			errs = append(errs, err)
		}
	}

	return errors.Join(errs...)
}

// vaultKeepSet is what retention must not delete, folded with vaultKeyFold:
// every key a kept manifest references, and every kept snapshot's ID (an
// object under a kept snapshot's own prefix is never deleted).
type vaultKeepSet struct {
	keys map[string]struct{}
	ids  map[string]struct{}
}

// dropVaultSnapshot deletes one dropped snapshot's objects that keep does not
// hold, then its manifest (see enforceRetention).
func (v *VaultManager) dropVaultSnapshot(snap vaultSnapshot, keep vaultKeepSet) error {
	m, err := v.readVaultManifest(snap.manifestKey, snap.id)
	if err != nil {
		return fmt.Errorf("snapshot %s not deleted, its manifest could not be read again: %w", snap.id, err)
	}
	items, err := listSnapshotPrefixItems(v.vault, snap.id)
	if err != nil {
		return fmt.Errorf("list snapshot %s: %w", snap.id, err)
	}
	candidates := make(map[string]struct{}, len(items)+len(m.refs))
	for _, item := range items {
		candidates[item] = struct{}{}
	}
	for key := range m.refs {
		candidates[key] = struct{}{}
	}
	m = nil

	// The manifest, under any spelling, is deleted last.
	manifestFold := vaultKeyFold(snap.manifestKey)
	var errs []error
	keptForNewer := map[string]struct{}{}
	for _, key := range sortedKeys(candidates) {
		folded := vaultKeyFold(key)
		if folded == manifestFold {
			continue
		}
		if _, referenced := keep.keys[folded]; referenced {
			keptForNewer[folded] = struct{}{}
			continue
		}
		parsed, err := validateManifestObjectKey(key)
		if err != nil {
			errs = append(errs, fmt.Errorf("not deleting %q: %w", key, err))
			continue
		}
		if _, underKept := keep.ids[vaultKeyFold(parsed.SnapshotID)]; underKept {
			continue
		}
		if err := v.vault.Delete(key); err != nil && !errors.Is(err, providers.ErrObjectNotFound) {
			errs = append(errs, fmt.Errorf("delete %s: %w", key, err))
		}
	}
	if len(errs) > 0 {
		slog.Warn("vault retention: snapshot only partly deleted, its manifest is kept so the next retention retries",
			"snapshotId", snap.id, "errors", len(errs))
		return errors.Join(errs...)
	}
	if err := v.vault.Delete(snap.manifestKey); err != nil && !errors.Is(err, providers.ErrObjectNotFound) {
		return fmt.Errorf("delete %s: %w", snap.manifestKey, err)
	}
	slog.Info("vault retention: deleted snapshot", "snapshotId", snap.id,
		"keptForNewerSnapshots", len(keptForNewer))
	return nil
}

// SyncAfterBackup syncs a snapshot to vault and enforces retention.
func (v *VaultManager) SyncAfterBackup(snapshotID string) (*VaultSyncResult, error) {
	return v.SyncAfterBackupFrom(v.primary, snapshotID)
}

// SyncAfterBackupFrom is SyncAfterBackup reading the snapshot from primary
// instead of the vault's startup primary: a backup written through a
// command-built provider (a policy-managed device has no agent.yaml manager)
// lives only there.
func (v *VaultManager) SyncAfterBackupFrom(primary providers.BackupProvider, snapshotID string) (*VaultSyncResult, error) {
	vaultMu.Lock()
	defer vaultMu.Unlock()
	result, err := v.syncSnapshotFrom(primary, snapshotID)
	if err != nil {
		return result, err
	}
	if err := v.enforceRetention(); err != nil {
		// The command still fails (as a retention error always has), but the
		// message says the snapshot itself reached the vault.
		return result, fmt.Errorf("snapshot %s was copied to the vault, but %w", snapshotID, err)
	}
	return result, nil
}

// GetStatus returns the current vault status including snapshot count and
// total size.
func (v *VaultManager) GetStatus() (*VaultStatus, error) {
	status := &VaultStatus{
		Enabled:   v.config.Enabled,
		VaultPath: v.config.VaultPath,
	}

	snapshots, err := ListSnapshots(v.vault)
	if err != nil && len(snapshots) == 0 {
		// Return status with zero counts if listing fails
		return status, err
	}

	status.SnapshotCount = len(snapshots)

	// Sort by timestamp descending to find last sync
	if len(snapshots) > 0 {
		sort.Slice(snapshots, func(i, j int) bool {
			return snapshots[i].Timestamp.After(snapshots[j].Timestamp)
		})
		status.LastSyncAt = snapshots[0].Timestamp.Format(time.RFC3339)
	}

	// Compute total size from all snapshot files
	if totalSize, ok := v.vaultTotalSize(snapshotRootDir); ok {
		status.TotalSizeBytes = totalSize
	}

	return status, nil
}

// vaultTotalSize sums the sizes of the vault objects under prefix, read in
// one walk through the vault provider's store root.
func (v *VaultManager) vaultTotalSize(prefix string) (int64, bool) {
	sizer, ok := v.vault.(interface {
		ObjectSizes(string) (map[string]int64, error)
	})
	if !ok {
		return 0, false
	}
	sizes, err := sizer.ObjectSizes(prefix)
	if err != nil {
		return 0, false
	}
	var total int64
	for _, size := range sizes {
		total += size
	}
	return total, true
}

// Path returns the configured vault path.
func (v *VaultManager) Path() string {
	return v.config.VaultPath
}

// GetProvider returns the vault's LocalProvider, useful for constructing
// a FallbackProvider that tries vault before cloud.
func (v *VaultManager) GetProvider() providers.BackupProvider {
	return v.vault
}

package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// referenceDecision classifies one walked file against the previous
// manifest's index — see decideFile.
type referenceDecision int

const (
	// decideUpload means the file must be uploaded (new, changed, or no
	// usable previous manifest).
	decideUpload referenceDecision = iota
	// decideReference means the file is unchanged since the previous
	// snapshot: its bytes already live under an older snapshot's prefix and
	// this run just carries that entry forward rather than re-uploading it.
	decideReference
)

// previousManifest fetches the newest completed snapshot's manifest that
// belongs to THIS run's backup identity — see ListSnapshots, which only
// returns snapshots that actually have an uploaded manifest.json (a
// partial/aborted prefix without one is not a completed snapshot) — for
// reference-decision comparisons.
//
// identity is this run's BackupIdentity (see BackupManager.runBackupIdentity
// / Snapshot.BackupIdentity's doc comment). A bucket can hold snapshots from
// MULTIPLE devices and run kinds with no key prefix between them (D6), so
// "the newest snapshot in the bucket" is a different question from "the
// newest snapshot for THIS device/run". previousManifest answers the
// second one: it scans ListSnapshots' results (ascending by Timestamp) from
// the newest backward and returns the first candidate whose BackupIdentity
// equals identity exactly. A candidate with any other identity — including
// a legacy manifest with no BackupIdentity at all, which never equals
// anything, empty string included — is skipped. If identity itself is
// empty (this run has no known identity — see BackupConfig.AgentID), no
// candidate can be proven to be "this run's own" snapshot, so this returns
// immediately without even listing.
//
// Returns (nil, reason) when no previous manifest is usable: no snapshot
// exists yet for this destination, every candidate belongs to a different
// identity, this run itself has no identity, or fetching/parsing failed.
// reason is always non-empty in that case so callers can log it directly.
// Dedupe is strictly an optimization — it must never fail or block a run —
// so this function never returns an error; every failure mode collapses to
// "run full" via a nil *Snapshot.
func previousManifest(ctx context.Context, provider providers.BackupProvider, identity string) (*Snapshot, string) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Sprintf("context already done: %v", err)
	}
	if identity == "" {
		return nil, "this run has no known backup identity, nothing to safely match a previous snapshot against"
	}
	snapshots, err := ListSnapshots(provider)
	if err != nil {
		// ANY fetch/parse problem — including one corrupt manifest among
		// several otherwise-valid ones (ListSnapshots joins per-item errors)
		// — fails open to a full run rather than risk building a reference
		// index off a partially-trusted snapshot list.
		return nil, fmt.Sprintf("failed to list previous snapshots: %v", err)
	}
	if len(snapshots) == 0 {
		return nil, "no previous snapshot for this destination"
	}
	// ListSnapshots sorts ascending by Timestamp; scan from the newest
	// backward for the first candidate that actually belongs to this run's
	// identity — see the doc comment above for why "newest overall" is the
	// wrong question in a bucket shared by multiple devices/run-kinds.
	skippedForeign := 0
	for i := len(snapshots) - 1; i >= 0; i-- {
		candidate := snapshots[i]
		if candidate.BackupIdentity != identity {
			skippedForeign++
			continue
		}
		log.Info("using previous manifest for incremental reference dedupe",
			"baseSnapshotId", candidate.ID,
			"baseTimestamp", candidate.Timestamp,
			"candidates", len(snapshots),
			"skippedForeign", skippedForeign,
		)
		return &candidate, ""
	}
	return nil, fmt.Sprintf(
		"no matching previous snapshot for this backup identity (%d of %d candidate(s) belonged to a different device/run/destination)",
		skippedForeign, len(snapshots))
}

// fetchServerOwnedBase downloads and validates the manifest for
// baseSnapshotID as this run's incremental-dedupe base, per the D18
// server-owned-base protocol (§3.1). Unlike previousManifest (legacy
// bucket-listing mode), the server has already chosen the base id — this
// function only fetches and validates it belongs to this device/
// destination/run-kind (the same D6 identity guard as previousManifest); it
// never lists the bucket. Returns (nil, reason) on ANY failure — empty id,
// download error, decode error, or identity mismatch — collapsing to a full
// run, exactly like previousManifest's fail-open contract. reason is always
// non-empty in that case so callers can log it directly.
func fetchServerOwnedBase(ctx context.Context, provider providers.BackupProvider, baseSnapshotID, identity string) (*Snapshot, string) {
	if ctx == nil {
		ctx = context.Background()
	}
	if baseSnapshotID == "" {
		return nil, "server selected no base for this run (full run)"
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Sprintf("context already done: %v", err)
	}
	if identity == "" {
		return nil, "this run has no known backup identity, cannot safely validate the server-selected base"
	}

	manifestKey := path.Join(snapshotRootDir, baseSnapshotID, snapshotManifestKey)
	tempFile, err := os.CreateTemp("", "base-manifest-*.json")
	if err != nil {
		return nil, fmt.Sprintf("failed to create temp file for base manifest: %v", err)
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	defer os.Remove(tempPath)

	if err := provider.Download(manifestKey, tempPath); err != nil {
		return nil, fmt.Sprintf("failed to download server-selected base manifest %s: %v", manifestKey, err)
	}
	data, err := os.ReadFile(tempPath)
	if err != nil {
		return nil, fmt.Sprintf("failed to read downloaded base manifest: %v", err)
	}
	var candidate Snapshot
	if err := json.Unmarshal(data, &candidate); err != nil {
		return nil, fmt.Sprintf("failed to decode base manifest %s: %v", manifestKey, err)
	}
	if candidate.BackupIdentity != identity {
		return nil, fmt.Sprintf(
			"server-selected base %s has BackupIdentity %q, this run's identity is %q — refusing to use a foreign snapshot as a dedupe base (D6)",
			baseSnapshotID, candidate.BackupIdentity, identity)
	}
	return &candidate, ""
}

// buildPreviousIndex converts a previous snapshot's file list into the
// lookup map decideFile compares walked files against, keyed by
// journalEntryKey — the SAME originalPath-else-sourcePath rule the
// checkpoint journal uses (see journalEntryKey/journalLookupKey) — so a
// stable logical file matches its prior entry regardless of whether VSS
// rewrote SourcePath in either run. Returns nil for a nil prev (no usable
// previous manifest), which decideFile treats identically to a miss on
// every lookup (always decideUpload).
func buildPreviousIndex(prev *Snapshot) map[string]SnapshotFile {
	if prev == nil {
		return nil
	}
	idx := make(map[string]SnapshotFile, len(prev.Files))
	for _, f := range prev.Files {
		idx[journalEntryKey(f)] = f
	}
	return idx
}

// decideFile classifies a walked file f against the previous manifest's
// index prev (nil = no usable previous manifest → always decideUpload),
// implementing the design's decision table:
//
//   - no entry for f's key → decideUpload (new file).
//   - entry found but Size differs → decideUpload ("anything else" in the
//     design table — a size change is never a reference even if some other
//     signal matched).
//   - entry found, Size equal, ModTime equal → decideReference (the common
//     fast path — no hashing needed).
//   - entry found, Size equal, ModTime differs → sha256 the file: equal to
//     entry.Checksum → decideReference (with the refreshed ModTime); a hash
//     error OR a mismatch → decideUpload (fail closed — never reference a
//     file whose current bytes couldn't be verified against the old
//     checksum).
//
// A decideReference result's SnapshotFile carries the OLD entry's
// BackupPath + Checksum (the bytes already live under an older snapshot's
// prefix — BackupPath is absolute, so restore/verify need zero changes) and
// the CURRENT stat fields (Size/ModTime/Mode/SourcePath/OriginalPath) so
// the new manifest reflects this run's own view of the file. A decideUpload
// result's SnapshotFile is the zero value — the caller builds the real
// entry itself after the upload actually completes, exactly as before
// incremental backups existed.
func decideFile(f backupFile, prev map[string]SnapshotFile) (referenceDecision, SnapshotFile) {
	entry, ok := prev[journalLookupKey(f)]
	if !ok || entry.Size != f.size {
		return decideUpload, SnapshotFile{}
	}
	if entry.ModTime.Equal(f.modTime) {
		return decideReference, referenceEntry(f, entry)
	}
	sum, err := sha256File(f.sourcePath)
	if err != nil || sum != entry.Checksum {
		return decideUpload, SnapshotFile{}
	}
	return decideReference, referenceEntry(f, entry)
}

// referenceEntry builds the manifest entry for a file decideFile decided to
// reference: see decideFile's doc comment for exactly which fields come
// from the old entry vs. the current stat.
func referenceEntry(f backupFile, prevEntry SnapshotFile) SnapshotFile {
	return SnapshotFile{
		SourcePath:   f.sourcePath,
		OriginalPath: f.originalPath,
		BackupPath:   prevEntry.BackupPath,
		Size:         f.size,
		ModTime:      f.modTime,
		Checksum:     prevEntry.Checksum,
		Mode:         uint32(f.mode.Perm()),
	}
}

// isReferenceEntry reports whether entry's bytes live under an OLDER
// snapshot's prefix rather than snapshotID's own — the design's "no isRef
// flag" signal: a BackupPath outside the owning snapshot's own prefix IS
// the reference marker, since restore/verify already resolve BackupPath as
// an absolute key regardless of which snapshot's prefix it falls under.
// RunBackupContext uses this to derive BackupJob.ReferencedFiles/
// ReferencedBytes purely by inspecting the finished manifest, so Snapshot
// itself never needs extra reference-count fields (the manifest stays
// clean — see the design's manifest-v2 section).
func isReferenceEntry(entry SnapshotFile, snapshotID string) bool {
	ownPrefix := path.Join(snapshotRootDir, snapshotID) + "/"
	return !strings.HasPrefix(entry.BackupPath, ownPrefix)
}

// NOTE: this package used to also carry isUnderDir/markSystemStateFiles/
// systemStateArtifactsMissing, a detector for the #3026 failure signature (a
// manifest recording system-state artifacts that the file walk never actually
// saw). That whole mechanism assumed system-state artifacts were walked as
// ordinary files (appended into backupPaths) alongside everything else.
// Wave 1 of the D15 bare-metal-recovery contract (see
// docs/superpowers/plans/backup/2026-09-09-bmr-system-state-contract.md)
// moved system-state artifacts to their own remote prefix, published
// directly from the manifest by publishSystemState (snapshot.go) rather than
// discovered via the file walk — so a walked `files` slice never contains
// staging-dir entries at all anymore, and the old detector would misfire on
// EVERY run that collects any system state (markedFiles would always be 0).
// publishSystemState's own per-artifact stat/upload is a strictly stronger
// replacement: it fails loudly if an artifact the manifest describes isn't
// actually on disk, rather than inferring the mismatch indirectly from the
// file walk. Removed rather than left inert.

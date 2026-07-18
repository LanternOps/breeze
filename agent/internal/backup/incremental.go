package backup

import (
	"context"
	"fmt"
	"path"
	"path/filepath"
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

// previousManifest fetches the newest completed snapshot's manifest for
// this provider — see ListSnapshots, which only returns snapshots that
// actually have an uploaded manifest.json (a partial/aborted prefix without
// one is not a completed snapshot) — for reference-decision comparisons.
//
// Returns (nil, reason) when no previous manifest is usable: either there
// simply isn't one yet (first run for this destination) or fetching/parsing
// one failed. reason is always non-empty in that case so callers can log it
// directly. Dedupe is strictly an optimization — it must never fail or
// block a run — so this function never returns an error; every failure
// mode collapses to "run full" via a nil *Snapshot.
func previousManifest(ctx context.Context, provider providers.BackupProvider) (*Snapshot, string) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Sprintf("context already done: %v", err)
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
	// ListSnapshots sorts ascending by Timestamp; the newest is last.
	newest := snapshots[len(snapshots)-1]
	return &newest, ""
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
//   - f is a system-state staging artifact (f.systemState) → always
//     decideUpload, never even looked up. CollectSystemState stages into a
//     fresh os.MkdirTemp root every run, so these paths are inherently
//     ephemeral and referencing them would be meaningless — see
//     markSystemStateFiles for the explicit, defensive exclusion (rather
//     than relying on the temp-dir path simply never colliding).
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
	if f.systemState {
		return decideUpload, SnapshotFile{}
	}
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

// isUnderDir reports whether p is dir itself or a descendant of it. Used by
// markSystemStateFiles; dir == "" always reports false (no staging dir to
// exclude, e.g. a non-system-state run).
func isUnderDir(p, dir string) bool {
	if dir == "" {
		return false
	}
	rel, err := filepath.Rel(dir, p)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// markSystemStateFiles flags every file in files whose sourcePath falls
// under stagingDir (the run's system-state staging root — see
// collectSystemState's call site in RunBackupContext, and note it may have
// been VSS-rewritten by the time it's passed here; pass whichever value was
// ACTUALLY walked) as backupFile.systemState = true, so decideFile always
// uploads them.
//
// This exclusion is defense-in-depth, not strictly load-bearing for
// correctness in production: CollectSystemState creates a fresh
// os.MkdirTemp root every run, so a staging file's sourcePath is already
// guaranteed never to appear as a key in a PREVIOUS manifest's index
// (buildPreviousIndex) — the natural "new file" miss in decideFile would
// reach the same decideUpload outcome on its own. Making it explicit here
// keeps the exclusion correct independent of that randomness assumption
// (e.g. a test double that reuses a fixed staging path across simulated
// runs) and gives readers/reviewers a single obvious place the "never
// referenced" rule lives, matching the design doc's explicit callout.
func markSystemStateFiles(files []backupFile, stagingDir string) {
	if stagingDir == "" {
		return
	}
	for i := range files {
		if isUnderDir(files[i].sourcePath, stagingDir) {
			files[i].systemState = true
		}
	}
}

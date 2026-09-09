package backup

import (
	"context"
	"fmt"
	"path"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
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
// collectSystemState's call site in RunBackupContext) as
// backupFile.systemState = true, so decideFile always uploads them.
//
// stagingDir is always the live path collectSystemState returned, never a VSS
// shadow-device path: rewritePathsForVSS deliberately skips the staging index
// because the dir is created after the snapshot is taken (#3026). That is what
// keeps this prefix comparable to the sourcePaths collectBackupFilesFromPaths
// actually produced.
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
//
// Returns the number of files marked, so the caller can detect a manifest that
// describes artifacts no collected file was matched to — see
// systemStateArtifactsMissing.
func markSystemStateFiles(files []backupFile, stagingDir string) int {
	if stagingDir == "" {
		return 0
	}
	marked := 0
	for i := range files {
		if isUnderDir(files[i].sourcePath, stagingDir) {
			files[i].systemState = true
			marked++
		}
	}
	return marked
}

// systemStateArtifactsMissing reports the #3026 failure signature: the run
// recorded a manifest describing system-state artifacts, but not one collected
// file was matched to the staging directory those artifacts were written to.
//
// The manifest is written from the collector's own return value, so it says
// nothing about whether the artifacts reached the snapshot. #3026 was one route
// to that divergence (the staging dir rewritten onto a VSS shadow path that
// predates it); the walk failing on the staging root, or a user exclude pattern
// matching artifact names, are others. On a run that also has configured file
// paths each one produces a green job whose restore point is missing the system
// state it claims. Rather than guard only the route that was fixed, make the
// outcome itself loud.
//
// A manifest with no artifacts is not a divergence — there is nothing to match
// — so it is excluded rather than reported on every such run.
func systemStateArtifactsMissing(manifest *systemstate.SystemStateManifest, markedFiles int) bool {
	return manifest != nil && len(manifest.Artifacts) > 0 && markedFiles == 0
}

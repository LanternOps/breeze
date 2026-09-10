package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// RestoreConfig configures a restore operation.
type RestoreConfig struct {
	SnapshotID    string
	TargetPath    string   // where to restore files
	SelectedPaths []string // if non-empty, only restore files matching these prefixes
}

// RestoreResult tracks the outcome of a restore.
type RestoreResult struct {
	SnapshotID    string   `json:"snapshotId"`
	Status        string   `json:"status"` // completed, partial, failed
	FilesRestored int      `json:"filesRestored"`
	BytesRestored int64    `json:"bytesRestored"`
	FilesFailed   int      `json:"filesFailed"`
	FailedFiles   []string `json:"failedFiles,omitempty"`
	Warnings      []string `json:"warnings,omitempty"`
	StagingDir    string   `json:"stagingDir,omitempty"`
	Error         string   `json:"error,omitempty"`
}

// ProgressFunc is called after each file is restored.
type ProgressFunc func(phase string, current, total int64, message string)

// RestoreFromSnapshot downloads files from a backup snapshot and restores them
// to the target path or original source paths.
func RestoreFromSnapshot(provider providers.BackupProvider, cfg RestoreConfig, progressFn ProgressFunc) (*RestoreResult, error) {
	return RestoreFromSnapshotContext(context.Background(), provider, cfg, progressFn)
}

// RestoreFromSnapshotContext downloads files from a backup snapshot and restores them
// to the target path or original source paths with cooperative cancellation.
func RestoreFromSnapshotContext(ctx context.Context, provider providers.BackupProvider, cfg RestoreConfig, progressFn ProgressFunc) (*RestoreResult, error) {
	if provider == nil {
		return nil, errors.New("backup provider is required")
	}
	if cfg.SnapshotID == "" {
		return nil, errors.New("snapshot ID is required")
	}

	result := &RestoreResult{SnapshotID: cfg.SnapshotID}
	checkCancelled := func() bool {
		if ctx == nil || ctx.Err() == nil {
			return false
		}
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		if result.FilesRestored > 0 {
			result.Status = "partial"
		} else {
			result.Status = "failed"
		}
		return true
	}

	if checkCancelled() {
		return result, nil
	}

	// 1. Download and parse manifest
	snapshot, err := downloadManifest(provider, cfg.SnapshotID)
	if err != nil {
		result.Status = "failed"
		return result, fmt.Errorf("download manifest: %w", err)
	}

	// 2. Filter files by selected paths, then split into the three restore
	// passes: regular files (today's download loop), symlinks, and
	// directories — directories go last so their modes/owners are applied
	// AFTER every child has been written (see the two passes appended below
	// the main loop).
	files := filterFiles(snapshot.Files, cfg.SelectedPaths)
	var contentFiles, links, dirs []SnapshotFile
	for _, f := range files {
		switch f.Kind {
		case KindSymlink:
			links = append(links, f)
		case KindDir:
			dirs = append(dirs, f)
		default:
			contentFiles = append(contentFiles, f)
		}
	}
	files = contentFiles
	total := int64(len(contentFiles) + len(links) + len(dirs))
	if total == 0 {
		result.Status = "completed"
		if len(cfg.SelectedPaths) > 0 {
			result.Warnings = append(result.Warnings, "no files matched the selected paths")
		}
		return result, nil
	}
	applyOwnership := restoreCanApplyOwnership()
	ownershipWarned := false
	warnOwnership := func() {
		if applyOwnership || ownershipWarned {
			return
		}
		ownershipWarned = true
		result.Warnings = append(result.Warnings, "ownership/special mode bits not applied: restore is not running as root")
	}

	// base is the restore root every write must stay under — computed once
	// here (rather than only inside the links/dirs pass below) because the
	// file loop needs it too: a RESUMED restore's file pass must never
	// write THROUGH an ancestor a previous (possibly interrupted) run
	// already recreated as a symlink pointing outside base (review finding,
	// PR #5520). See EnsureNoSymlinkAncestor.
	base := cfg.TargetPath
	if base == "" {
		base = filepath.Join(os.TempDir(), "breeze-restore")
	}

	// 3. Create or reuse a deterministic staging directory so partial restores
	// can resume on a subsequent attempt.
	stagingDir, err := restoreStagingDir(cfg)
	if err != nil {
		result.Status = "failed"
		return result, fmt.Errorf("resolve staging dir: %w", err)
	}
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		result.Status = "failed"
		return result, fmt.Errorf("create staging dir: %w", err)
	}
	result.StagingDir = stagingDir

	// 4. Load resume state if it exists
	resumeState, err := LoadResumeState(stagingDir)
	if err != nil {
		slog.Warn("failed to load resume state, starting fresh", "error", err.Error())
	}
	if resumeState == nil {
		resumeState = &ResumeState{
			SnapshotID:     cfg.SnapshotID,
			CompletedFiles: make(map[string]bool),
		}
	}

	if progressFn != nil {
		progressFn("starting", 0, total, fmt.Sprintf("restoring %d files", total))
	}

	// 5. Restore each file
	for i, file := range files {
		if checkCancelled() {
			return result, nil
		}

		current := int64(i + 1)
		displayPath := restoreSourcePath(file)
		targetPath := resolveTargetPath(cfg.TargetPath, displayPath)

		// Skip already-completed files (resume)
		if resumeState.CompletedFiles[file.BackupPath] {
			if info, statErr := os.Stat(targetPath); statErr == nil && info.Size() == file.Size {
				result.FilesRestored++
				result.BytesRestored += file.Size
				if progressFn != nil {
					progressFn("restoring", current, total,
						fmt.Sprintf("skipped (resumed): %s", displayPath))
				}
				continue
			}
			delete(resumeState.CompletedFiles, file.BackupPath)
		}

		// Download to staging
		stagingFile := filepath.Join(stagingDir, stagingFileName(file.BackupPath))
		if err := os.MkdirAll(filepath.Dir(stagingFile), 0o755); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			slog.Warn("failed to create staging subdir",
				"file", displayPath, "error", err.Error())
			continue
		}

		dlErr := provider.Download(file.BackupPath, stagingFile)
		if dlErr != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			slog.Warn("failed to download file",
				"backupPath", file.BackupPath, "error", dlErr.Error())
			continue
		}
		if checkCancelled() {
			_ = os.Remove(stagingFile)
			return result, nil
		}

		// Path containment check
		{
			cleaned := filepath.Clean(targetPath)
			cleanBase := filepath.Clean(base)
			if !strings.HasPrefix(cleaned, cleanBase+string(filepath.Separator)) && cleaned != cleanBase {
				result.Warnings = append(result.Warnings, fmt.Sprintf("path traversal blocked: %s", displayPath))
				result.FilesFailed++
				os.Remove(stagingFile)
				continue
			}
		}

		// A RESUMED restore's file pass must never write THROUGH an
		// ancestor a previous run already recreated as a symlink — lexical
		// containment above only checks the literal target path string, not
		// what the filesystem actually resolves through to get there.
		if err := EnsureNoSymlinkAncestor(base, targetPath); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings, err.Error())
			_ = os.Remove(stagingFile)
			slog.Warn("refusing to restore through a symlinked ancestor", "target", targetPath, "error", err.Error())
			continue
		}

		// Create target directory
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			os.Remove(stagingFile)
			slog.Warn("failed to create target dir",
				"target", targetPath, "error", err.Error())
			continue
		}

		// Move from staging to target
		if err := moveFile(stagingFile, targetPath); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			os.Remove(stagingFile)
			slog.Warn("failed to move file to target",
				"staging", stagingFile, "target", targetPath, "error", err.Error())
			continue
		}

		// Verify the restored bytes against the manifest BEFORE declaring the
		// file restored. This is the path that writes real user data, so a
		// corrupt/truncated object must not be silently reported "restored"
		// (VerifyIntegrity/TestRestore run this same fail-closed check, but only
		// against throwaway dirs — the real restore needs it too). Size is
		// always checked; the SHA-256 when the manifest carries one.
		if info, statErr := os.Stat(targetPath); statErr != nil || info == nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			slog.Warn("failed to stat restored file", "target", targetPath, "error", fmt.Sprint(statErr))
			continue
		} else if info.Size() != file.Size {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings,
				fmt.Sprintf("restored %s failed size check: manifest %d, restored %d", displayPath, file.Size, info.Size()))
			slog.Warn("restored file failed size check",
				"target", targetPath, "manifestSize", file.Size, "restoredSize", info.Size())
			continue
		}
		if file.Checksum != "" && !checksumMatches(targetPath, file.Checksum) {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings,
				fmt.Sprintf("restored %s failed checksum check (manifest %s)", displayPath, file.Checksum))
			slog.Warn("restored file failed checksum check", "target", targetPath)
			continue
		}

		// Reapply the original Unix permissions/full mode bits, owner (root
		// only) and modification time so a restore is faithful — see
		// applyEntryMetadata's doc comment. Best-effort: a chmod/chtimes/
		// chown failure must not fail an otherwise-good restore, but IS
		// surfaced in result.Warnings so the caller knows fidelity was
		// partial.
		result.Warnings = append(result.Warnings, applyEntryMetadata(targetPath, file, applyOwnership)...)
		if !applyOwnership && (file.Owner != nil || file.ModeBits&uint32(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0) {
			warnOwnership()
		}

		result.FilesRestored++
		result.BytesRestored += file.Size
		resumeState.CompletedFiles[file.BackupPath] = true
		resumeState.BytesRestored += file.Size

		// Save resume state after each successful file
		if saveErr := SaveResumeState(stagingDir, resumeState); saveErr != nil {
			slog.Warn("failed to save resume state", "error", saveErr.Error())
		}

		if progressFn != nil {
			progressFn("restoring", current, total,
				fmt.Sprintf("restored: %s", displayPath))
		}
	}

	// Pass 2: symlinks (parents exist now, from the file pass above). Pass
	// 3: directories last so their modes/owners are applied after every
	// child (file or symlink) has been written under them.
	contained := func(p string) bool {
		cleaned, cleanBase := filepath.Clean(p), filepath.Clean(base)
		return cleaned == cleanBase || strings.HasPrefix(cleaned, cleanBase+string(filepath.Separator))
	}
	for _, entry := range append(links, dirs...) {
		if checkCancelled() {
			return result, nil
		}
		displayPath := restoreSourcePath(entry)
		targetPath := resolveTargetPath(cfg.TargetPath, displayPath)
		if !contained(targetPath) {
			result.Warnings = append(result.Warnings, fmt.Sprintf("path traversal blocked: %s", displayPath))
			result.FilesFailed++
			continue
		}
		// Same ancestor-symlink guard as the file pass above: MkdirAll (for
		// a KindDir entry) or the symlink branch's own MkdirAll(Dir(...))
		// would otherwise happily traverse THROUGH an ancestor a previous
		// run already turned into a symlink (review finding, PR #5520).
		if err := EnsureNoSymlinkAncestor(base, targetPath); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings, err.Error())
			continue
		}
		if err := RestoreContentlessEntry(targetPath, entry, applyOwnership); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings, fmt.Sprintf("could not recreate %s: %v", displayPath, err))
			continue
		}
		if !applyOwnership && entry.Owner != nil {
			warnOwnership()
		}
		result.FilesRestored++
	}

	if checkCancelled() {
		return result, nil
	}

	// 6. Determine status
	switch {
	case result.FilesFailed == 0 && result.FilesRestored > 0:
		result.Status = "completed"
	case result.FilesRestored == 0:
		result.Status = "failed"
	default:
		result.Status = "partial"
	}

	// 7. Clean up staging on success
	if result.Status == "completed" {
		if err := os.RemoveAll(stagingDir); err != nil {
			slog.Warn("failed to clean up staging dir", "dir", stagingDir, "error", err.Error())
		} else {
			result.StagingDir = ""
		}
	}

	return result, nil
}

// downloadManifest fetches and parses the manifest for a snapshot.
func downloadManifest(provider providers.BackupProvider, snapshotID string) (*Snapshot, error) {
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)

	tmpFile, err := os.CreateTemp("", "restore-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("create temp manifest: %w", err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := provider.Download(manifestKey, tmpPath); err != nil {
		return nil, fmt.Errorf("download manifest: %w", err)
	}

	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}

	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	return &snapshot, nil
}

// filterFiles returns only the files whose restoreSourcePath (see that
// function — OriginalPath when VSS rewrote SourcePath, else SourcePath)
// matches at least one of the selected paths. If selectedPaths is empty,
// all files are returned.
//
// Matching against restoreSourcePath, not the raw SourcePath, matters
// because the API indexes and validates selectedPaths against each file's
// ORIGINAL path (D8): under VSS, SourcePath is a per-run shadow-copy device
// path like \\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\assure\src\x,
// which a caller selecting "C:\assure\src\x" would never match.
func filterFiles(files []SnapshotFile, selectedPaths []string) []SnapshotFile {
	if len(selectedPaths) == 0 {
		return files
	}

	var matched []SnapshotFile
	for _, f := range files {
		for _, selected := range selectedPaths {
			if pathSelectionMatches(restoreSourcePath(f), selected) {
				matched = append(matched, f)
				break
			}
		}
	}
	return matched
}

// pathSelectionMatches reports whether sourcePath was selected by selected:
// either sourcePath IS selected (a single file was chosen), or sourcePath
// lies inside the directory selected names (sourcePath starts with selected
// plus a path separator). A bare strings.HasPrefix(sourcePath, selected) —
// the old behavior — also matches any sibling that merely shares selected as
// a leading substring: selecting "/x/prefix/pick.txt" wrongly also matched
// "/x/prefix/pick.txt.bak", "/x/prefix/pick.txt2", and
// "/x/prefix/pick.txtx/inner.txt", which an in-place restore then silently
// overwrote even though the operator never selected them (D5).
//
// Both "/" and "\" are accepted as the directory-boundary separator
// regardless of which one selected itself uses: manifests written on
// Windows store SourcePath with backslashes, while a caller (e.g. a web UI
// that always speaks forward slashes) may pass a selection in the other
// convention. A trailing separator on selected is normalised away first so
// "/x/prefix/" and "/x/prefix" select identically.
func pathSelectionMatches(sourcePath, selected string) bool {
	trimmed := strings.TrimRight(selected, `/\`)
	if sourcePath == trimmed {
		return true
	}
	return strings.HasPrefix(sourcePath, trimmed+"/") || strings.HasPrefix(sourcePath, trimmed+`\`)
}

// volumeName strips a leading volume/drive name (e.g. "C:") from a path. It
// defaults to filepath.VolumeName, which is a no-op off Windows. Tests override
// it with a Windows-style implementation so the embedded-drive case can be
// exercised on any host (Linux/macOS CI would otherwise assert the wrong
// behavior, since filepath.VolumeName never strips a drive letter there).
var volumeName = filepath.VolumeName

// restoreSourcePath returns the path a restore should re-root files under:
// f.OriginalPath when VSS rewrote f.SourcePath to a per-run-ephemeral
// shadow-copy device path (e.g.
// \\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\assure\src\x — see
// SnapshotFile.OriginalPath's doc comment), else f.SourcePath itself (the
// common, non-VSS case, where SourcePath is already the real path). Same
// rule as journalEntryKey (checkpoint-journal resume identity) — reused
// here — but restore/verify/BMR need it independently: SourcePath is the
// READ-time location a backup was taken FROM, and once the shadow copy VSS
// rewrote it under is gone (the very next backup run, or a reboot),
// restoring under that literal device path either writes into a stale/
// nonexistent shadow device or, worse, silently splits one logical file
// tree across ShadowCopy1/ShadowCopy2/... depending on which run's shadow
// ID happened to be live (D8). Every restore/verify/BMR call that computes
// a destination path or matches a path selection against a manifest entry
// MUST go through this, never f.SourcePath directly.
func restoreSourcePath(f SnapshotFile) string {
	return journalEntryKey(f)
}

// stripVolumeAndLeadingSeparators removes the volume/drive (e.g. "C:") and any
// leading separators so an ABSOLUTE source path maps UNDER a target base.
// Otherwise filepath.Join("C:\\restore", "C:\\Users\\x") yields an invalid
// Windows path with an embedded drive letter, and MkdirAll fails for every
// file — i.e. restore-to-an-alternate-location was completely broken on Windows.
func stripVolumeAndLeadingSeparators(sourcePath string) string {
	rel := sourcePath
	if vol := volumeName(rel); vol != "" {
		rel = rel[len(vol):]
	}
	return strings.TrimLeft(rel, `\/`)
}

// resolveTargetPath determines where to restore a file. If targetBase is set,
// the full relative source path is preserved under targetBase to maintain
// directory structure and prevent name collisions. Otherwise the original
// source path is used.
func resolveTargetPath(targetBase, sourcePath string) string {
	rel := stripVolumeAndLeadingSeparators(sourcePath)
	if targetBase == "" {
		// Use a safe temp directory instead of the original absolute path
		return filepath.Join(os.TempDir(), "breeze-restore", rel)
	}
	// Preserve full path structure under the target base
	// e.g., targetBase="/restore", sourcePath="path_0/reports/config.json"
	// → "/restore/path_0/reports/config.json"
	return filepath.Join(targetBase, rel)
}

func restoreStagingDir(cfg RestoreConfig) (string, error) {
	keyData, err := json.Marshal(struct {
		TargetPath    string   `json:"targetPath"`
		SelectedPaths []string `json:"selectedPaths"`
	}{
		TargetPath:    cfg.TargetPath,
		SelectedPaths: cfg.SelectedPaths,
	})
	if err != nil {
		return "", fmt.Errorf("encode staging key: %w", err)
	}

	sum := sha256.Sum256(keyData)
	stagingKey := hex.EncodeToString(sum[:8])
	return filepath.Join(os.TempDir(), "breeze-restore-staging", cfg.SnapshotID, stagingKey), nil
}

// clearReadOnly clears the owner-write bit on dst so a subsequent
// open-for-write/rename onto it can succeed. On Windows, Go maps the
// FILE_ATTRIBUTE_READONLY attribute to exactly this bit (0o200), so this
// doubles as "clear the ReadOnly attribute" there. It never touches
// directories and never follows symlinks (Lstat), and it is a no-op — not
// an error — when dst is already writable. restored reports whether it
// actually changed anything, so callers only retry (and only log) when a
// change was made.
func clearReadOnly(dst string) (restored bool, err error) {
	info, err := os.Lstat(dst)
	if err != nil {
		return false, err
	}
	if info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, nil
	}
	perm := info.Mode().Perm()
	if perm&0o200 != 0 {
		return false, nil
	}
	if err := os.Chmod(dst, perm|0o200); err != nil {
		return false, err
	}
	return true, nil
}

// moveFile attempts os.Rename first (fast, same filesystem), then falls back
// to copy+delete for cross-filesystem moves.
//
// A destination that exists and carries the Windows ReadOnly attribute (very
// common for app config files being restored in place) makes os.Rename fail
// with "Access is denied" — Windows enforces the read-only attribute on
// rename, unlike Unix where directory permissions alone govern rename (D19).
// When that happens, clear the write-protection on dst and retry the rename
// once before falling back to copyAndDelete, which now can also recover from
// the same condition via clearReadOnly.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if _, statErr := os.Lstat(dst); statErr == nil {
		if restored, clearErr := clearReadOnly(dst); clearErr == nil && restored {
			slog.Debug("cleared read-only attribute on restore target before retrying rename", "target", dst)
			if err := os.Rename(src, dst); err == nil {
				return nil
			}
		}
	}
	// Cross-filesystem fallback: copy then delete
	return copyAndDelete(src, dst)
}

// copyAndDelete copies src to dst then removes src.
func copyAndDelete(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}

	dstFile, err := os.Create(dst)
	if err != nil {
		if restored, clearErr := clearReadOnly(dst); clearErr == nil && restored {
			slog.Debug("cleared read-only attribute on restore target before retrying create", "target", dst)
			dstFile, err = os.Create(dst)
		}
	}
	if err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("create destination: %w", err)
	}

	_, err = io.Copy(dstFile, srcFile)
	closeErr := dstFile.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = srcFile.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("copy file: %w", err)
	}

	if err := os.Remove(src); err != nil {
		slog.Warn("failed to remove staging file after copy", "path", src, "error", err.Error())
	}
	return nil
}

// stagingFileName derives a short, injective local filename for downloading
// file.BackupPath into the staging directory. The object key can be
// arbitrarily long (snapshot prefix + "files/" + the full original source
// path — proven in production to exceed 400 characters for a nested,
// long-named source file), and naively flattening it into one path
// component (the old approach: replace every "/" with "_") easily exceeds
// the filesystem's per-component name limit (~255 bytes on ext4/APFS/NTFS),
// so opening the destination file fails with "file name too long" and the
// file is silently dropped into failedFiles even though the object exists
// in storage and both VerifyIntegrity and TestRestore — which restore under
// the object's real, unflattened directory structure via resolveTargetPath,
// not a single flattened component — read it back fine (D4).
//
// A hex-encoded SHA-256 digest of the BackupPath is both bounded (fixed 64
// hex chars + ".gz" = 67, comfortably under any filesystem limit) and
// collision-resistant, so distinct BackupPaths never share a staging file.
// The ".gz" suffix is cosmetic only — nothing parses this name back into a
// BackupPath; resume state (ResumeState.CompletedFiles, restore_resume.go)
// and every restore-loop lookup key off file.BackupPath directly, never off
// the staging filename, so this stays consistent with resume behavior.
func stagingFileName(backupPath string) string {
	sum := sha256.Sum256([]byte(backupPath))
	return hex.EncodeToString(sum[:]) + ".gz"
}

// EnsureNoSymlinkAncestor walks every path component strictly below base up
// to filepath.Dir(target), lstat'ing each one, and refuses if any component
// is a symlink. A resumed restore's file pass must never write THROUGH a
// symlink an earlier pass (or a prior interrupted run) planted under the
// restore root — e.g. a manifest entry recreating /etc as a symlink to an
// absolute path outside base, followed by a file entry for /etc/passwd:
// lexical containment on the final target path alone does not catch this,
// since MkdirAll/os.Create happily follow an intermediate symlink to wherever
// it points (review finding, PR #5520). A missing component is fine —
// MkdirAll creates it fresh — so this stops (returns nil) at the first
// component that doesn't exist yet; deeper components can't exist either.
func EnsureNoSymlinkAncestor(base, target string) error {
	cleanBase := filepath.Clean(base)
	dir := filepath.Clean(filepath.Dir(target))
	rel, err := filepath.Rel(cleanBase, dir)
	if err != nil {
		// Can't relate (e.g. different volumes on Windows) — nothing this
		// helper can walk; the caller's own containment check governs.
		return nil
	}
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		// dir IS base (nothing below it to check) or isn't under base at
		// all — out of this helper's scope.
		return nil
	}
	cur := cleanBase
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if part == "" || part == "." {
			continue
		}
		cur = filepath.Join(cur, part)
		info, statErr := os.Lstat(cur)
		if statErr != nil {
			return nil
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to write %s: ancestor %s is a symlink", target, cur)
		}
	}
	return nil
}

// applyEntryMetadata reapplies mode bits (full ModeBits when known, else the
// perm-only Mode), owner (root only) and mtime to a restored regular file.
func applyEntryMetadata(targetPath string, entry SnapshotFile, applyOwnership bool) []string {
	var warnings []string
	switch {
	case entry.ModeBits != 0:
		if err := os.Chmod(targetPath, os.FileMode(entry.ModeBits)); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply mode %o to %s: %v", entry.ModeBits, entry.SourcePath, err))
		}
	case entry.Mode != 0:
		if err := os.Chmod(targetPath, os.FileMode(entry.Mode).Perm()); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply mode %o to %s: %v", os.FileMode(entry.Mode).Perm(), entry.SourcePath, err))
		}
	}
	if applyOwnership {
		if err := applyOwner(targetPath, entry.Owner); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply owner to %s: %v", entry.SourcePath, err))
		}
	}
	if !entry.ModTime.IsZero() {
		if err := os.Chtimes(targetPath, entry.ModTime, entry.ModTime); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply mtime to %s: %v", entry.SourcePath, err))
		}
	}
	return warnings
}

// RestoreContentlessEntry recreates a symlink or directory entry at
// targetPath. Exported because bmr's reinstall-then-recover path and the
// rebuild engine (W03) recreate the same entries.
func RestoreContentlessEntry(targetPath string, entry SnapshotFile, applyOwnership bool) error {
	switch entry.Kind {
	case KindSymlink:
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		if existing, err := os.Lstat(targetPath); err == nil {
			// Only an existing SYMLINK may be replaced (the resume case: a
			// prior run already planted the correct link, or a stale one
			// pointing somewhere else). Anything else — a regular file, a
			// real directory — must be refused, never silently destroyed
			// (review finding, PR #5520).
			if existing.Mode()&os.ModeSymlink == 0 {
				return fmt.Errorf("%s exists and is not a symlink", targetPath)
			}
			if cur, rerr := os.Readlink(targetPath); rerr == nil && cur == entry.LinkTarget {
				break // already correct (resume)
			}
			if err := os.Remove(targetPath); err != nil {
				return err
			}
		}
		if err := os.Symlink(entry.LinkTarget, targetPath); err != nil {
			return err
		}
	case KindDir:
		if err := os.MkdirAll(targetPath, 0o755); err != nil {
			return err
		}
		mode := os.FileMode(entry.ModeBits)
		if !applyOwnership {
			// A non-root owner may legitimately set sticky/setgid on its own
			// directory (Linux/macOS both permit this); setuid on a
			// directory is vanishingly rare and this path can't confirm
			// root, so it errs conservative and strips only that bit.
			mode &^= os.ModeSetuid
		}
		if entry.ModeBits != 0 {
			if err := os.Chmod(targetPath, mode); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("entry %s has content; use the file path", entry.SourcePath)
	}
	if applyOwnership {
		if err := applyOwner(targetPath, entry.Owner); err != nil {
			return err
		}
	}
	return nil
}

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
	"sort"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/securefs"
)

// RestoreConfig configures a restore operation.
type RestoreConfig struct {
	SnapshotID    string
	TargetPath    string   // where to restore files
	SelectedPaths []string // if non-empty, only restore files matching these prefixes
	WorkRoot      string   // privileged agent-data root for staging and default restores
	// Integrity is the integrity expectation delivered with the command; nil
	// when the server sent none (the earlier checks apply unchanged).
	Integrity *integrity.Expectation

	// SecurityDescriptorsAsCaptured applies every recorded Windows security
	// descriptor as captured, without checking that the machine running the
	// restore recognises the principals it names. Only for a whole-machine
	// rebuild, where the restored tree becomes the machine those accounts
	// belong to (the helper itself may be running in a recovery
	// environment that recognises none of them). Never set from a command
	// payload.
	SecurityDescriptorsAsCaptured bool

	// JunctionTargetsAsCaptured recreates every junction (#7325) pointing
	// at its target exactly as recorded, never rewritten under TargetPath.
	// Only for a whole-machine rebuild: the restore writes through a
	// recovery-time drive letter or volume GUID path, but the junction must
	// resolve on the machine the rebuilt volume becomes. Never set from a
	// command payload — see junctionRestoreTarget.
	JunctionTargetsAsCaptured bool
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
	// Code is the stable code of the first integrity check that failed
	// (integrity_mismatch, missing_checksum, …); set only when the command
	// carried an integrity expectation.
	Code string `json:"code,omitempty"`

	// SecurityDescriptorQuarantined counts the Windows entries whose recorded
	// security descriptor named principals the target does not recognise, so
	// they were restored with the restrictive quarantine descriptor (owner
	// Administrators; SYSTEM and Administrators only) instead; the paths are
	// listed in SecurityDescriptorQuarantinedPaths.
	SecurityDescriptorQuarantined      int      `json:"securityDescriptorQuarantined,omitempty"`
	SecurityDescriptorQuarantinedPaths []string `json:"securityDescriptorQuarantinedPaths,omitempty"`
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
	if err := validateSnapshotID(cfg.SnapshotID); err != nil {
		return nil, err
	}
	// Without a target AND without a work root there is nowhere durable to put
	// the result: the work root would be an ephemeral MkdirTemp that this
	// function removes on return, and the default target lives inside it, so
	// the restore would delete exactly what it just wrote. Fail loudly instead.
	if cfg.TargetPath == "" && cfg.WorkRoot == "" {
		return nil, errors.New("restore requires a target path or a configured work root")
	}
	securefs.LogLegacyStagingTrees(slog.Warn)
	workRoot, ephemeralWorkRoot, err := prepareRestoreWorkRoot(cfg.WorkRoot)
	if err != nil {
		return nil, fmt.Errorf("prepare restore work root: %w", err)
	}
	if ephemeralWorkRoot {
		defer func() { _ = os.RemoveAll(workRoot) }()
	}
	targetBase := cfg.TargetPath
	if targetBase == "" {
		targetBase = filepath.Join(workRoot, "restored", cfg.SnapshotID)
	}
	if !filepath.IsAbs(targetBase) {
		return nil, errors.New("restore target path must be absolute")
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

	// 1. Download and parse manifest. With an integrity expectation the
	// manifest bytes are checked against the snapshot attestation before a
	// byte of them is parsed.
	if err := cfg.Integrity.CheckSnapshot(cfg.SnapshotID); err != nil {
		result.Status = "failed"
		return result, err
	}
	snapshot, manifestWarnings, err := downloadVerifiedManifest(ctx, provider, cfg.SnapshotID, workRoot, cfg.Integrity)
	if err != nil {
		result.Status = "failed"
		result.Code = integrityResultCode(cfg.Integrity, err)
		return result, fmt.Errorf("download manifest: %w", err)
	}
	if w := cfg.Integrity.UnattestedWarning(); w != "" {
		result.Warnings = append(result.Warnings, w)
	}
	result.Warnings = append(result.Warnings, manifestWarnings...)

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
	// Junctions (#7325) live in their own manifest array and get their own
	// pass, after every other entry is in place.
	junctions := filterJunctions(snapshot.Junctions, cfg.SelectedPaths)
	total := int64(len(contentFiles) + len(links) + len(dirs) + len(junctions))
	if total == 0 {
		result.Status = "completed"
		if len(cfg.SelectedPaths) > 0 {
			result.Warnings = append(result.Warnings, "no files matched the selected paths")
		}
		return result, nil
	}
	// NTFS security descriptors (W06a): Windows only — see restore_sd.go.
	// The restore privilege scope (SeRestore/SeTakeOwnership/SeSecurity) is
	// held for this run only and released when it returns.
	secDescs, secWarnings := newRestoreSecurity(snapshot.SecurityDescriptors, append(append(append([]SnapshotFile(nil), contentFiles...), links...), dirs...), restoreAppliesSecurityDescriptors)
	result.Warnings = append(result.Warnings, secWarnings...)
	secDescs.asCaptured = cfg.SecurityDescriptorsAsCaptured
	if secDescs.active() {
		release := enableRestoreSDPrivileges()
		defer release()
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

	// Directories whose recorded descriptor is to be restricted are created
	// and restricted BEFORE anything is restored beneath them, so an entry
	// restored there without a descriptor of its own inherits the
	// restriction rather than the target's ACL. A directory that cannot be
	// restricted blocks everything beneath it. Plans are computed once per
	// directory here and reused by the directory pass below.
	dirPlans, preRestricted, blockedDirs := restrictDirectoriesFirst(targetBase, dirs, secDescs, applyOwnership, result)
	blockedBeneath := func(relative string) string {
		for _, b := range blockedDirs {
			if strings.HasPrefix(relative, b+string(filepath.Separator)) {
				return b
			}
		}
		return ""
	}

	// 3. Create or reuse a deterministic staging directory so partial restores
	// can resume on a subsequent attempt.
	stagingDir, err := restoreStagingDir(cfg, workRoot)
	if err != nil {
		result.Status = "failed"
		return result, fmt.Errorf("resolve staging dir: %w", err)
	}
	if err := securefs.EnsurePrivateDir(stagingDir); err != nil {
		result.Status = "failed"
		return result, fmt.Errorf("create staging dir: %w", err)
	}
	result.StagingDir = stagingDir

	// 4. Load resume state (snapshot + journal) if it exists. Progress is
	// journaled per file and compacted when the run ends without completing
	// (restore_resume.go, #7333); a completed run discards it below.
	resume := openResumeTracker(stagingDir, cfg.SnapshotID)
	defer resume.close()

	// Tell a batching provider which objects are coming, in order, so it
	// can authorize them a window at a time rather than one per download.
	pending := make([]SnapshotFile, 0, len(files))
	for _, f := range files {
		if !resume.completed(f.BackupPath) {
			pending = append(pending, f)
		}
	}
	providers.PrepareDownloads(provider, contentKeys(pending))

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
		relativeTarget, relErr := restoreRelativePath(displayPath)
		if relErr != nil {
			result.Warnings = append(result.Warnings, fmt.Sprintf("invalid restore path %s: %v", displayPath, relErr))
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			continue
		}
		targetPath := filepath.Join(targetBase, relativeTarget)
		if blocked := blockedBeneath(relativeTarget); blocked != "" {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings, fmt.Sprintf("not restored %s: its directory could not be restricted", displayPath))
			continue
		}

		// Skip already-completed files (resume). In attested mode the file
		// on disk must still hold exactly the attested bytes: a size match
		// alone would keep content that changed since the earlier run.
		if resume.completed(file.BackupPath) {
			if resumedFileIntact(targetBase, relativeTarget, file, cfg.Integrity) {
				result.FilesRestored++
				result.BytesRestored += file.Size
				if progressFn != nil {
					progressFn("restoring", current, total,
						fmt.Sprintf("skipped (resumed): %s", displayPath))
				}
				continue
			}
			resume.forget(file.BackupPath)
		}

		// Download to staging, then check the staged bytes against the
		// manifest BEFORE declaring the file restored (downloadAndCheckStaged).
		stagingFile := filepath.Join(stagingDir, stagingFileName(file.BackupPath))
		check, dlWarnings, dlErr := downloadAndCheckStaged(ctx, provider, file, stagingFile, cfg.Integrity)
		if dlErr != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			_ = os.Remove(stagingFile)
			if result.Code == "" {
				result.Code = integrityResultCode(cfg.Integrity, dlErr)
			}
			if w := storedBytesFailureWarning(displayPath, file, dlErr, cfg.Integrity); w != "" {
				result.Warnings = append(result.Warnings, w)
			}
			slog.Warn("restored file failed its download or content check",
				"backupPath", file.BackupPath, "target", targetPath, "error", dlErr.Error())
			continue
		}
		result.Warnings = append(result.Warnings, dlWarnings...)
		if check.Warning != "" {
			result.Warnings = append(result.Warnings, fmt.Sprintf("restored %s: %s", displayPath, check.Warning))
			slog.Warn("restored volatile file differs from its manifest entry (advisory, not a failure)", "target", targetPath)
		}
		if checkCancelled() {
			_ = os.Remove(stagingFile)
			return result, nil
		}

		// No pathname containment check, MkdirAll or moveFile here: the
		// publication below walks the target hierarchy with directory
		// descriptors/handles and refuses a symlink or reparse point at every
		// component. That subsumes both the lexical containment check and
		// EnsureNoSymlinkAncestor (which only lstat's, and so is decided
		// before the write rather than during it), including the RESUMED case
		// where an earlier pass recreated an ancestor as a symlink.

		// Publish only verified bytes. Linux, macOS and Windows pin the
		// target hierarchy with directory descriptors/handles and never follow
		// a destination symlink/reparse point. Mode (full ModeBits when the
		// manifest carries them, else the perm-only Mode), owner, mtime,
		// Windows attributes and the captured NTFS security descriptor (W06a)
		// are all applied to the pinned temporary's handle BEFORE the atomic
		// replace, so #5520's fidelity is preserved without any
		// post-publication pathname chmod/chown/chtimes/SetSecurity — the
		// exact operations this boundary (SEC-121) exists to remove.
		mode := os.FileMode(file.Mode).Perm()
		if file.ModeBits != 0 {
			mode = os.FileMode(file.ModeBits)
		}
		// A descriptor naming principals this machine does not recognise, or
		// one that cannot be read, is replaced by the restrictive quarantine
		// descriptor (restore_sd.go).
		secPlan := secDescs.entryPlan(file)
		installWarnings, err := securefs.InstallFileWithSecurity(targetBase, relativeTarget, stagingFile, mode, file.ModTime, entryOwner(file, applyOwnership), file.WinAttrs, secPlan.applier)
		if err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings, fmt.Sprintf("could not restore %s: %v", displayPath, err))
			_ = os.Remove(stagingFile)
			slog.Warn("failed to install restored file", "target", targetPath, "error", err.Error())
			continue
		}
		for _, warning := range installWarnings {
			result.Warnings = append(result.Warnings, fmt.Sprintf("restored %s with reduced fidelity: %v", displayPath, warning))
		}
		secDescs.record(result, displayPath, secPlan)
		if !applyOwnership && (file.Owner != nil || file.ModeBits&uint32(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0) {
			warnOwnership()
		}

		result.FilesRestored++
		result.BytesRestored += file.Size
		// One journal append per file — not a rewrite of the whole state.
		resume.markCompleted(file.BackupPath, file.Size)

		if progressFn != nil {
			progressFn("restoring", current, total,
				fmt.Sprintf("restored: %s", displayPath))
		}
	}

	// Pass 2: symlinks (parents exist now, from the file pass above). Pass
	// 3: directories last so their modes/owners are applied after every
	// child (file or symlink) has been written under them.
	//
	// Directory security descriptors are collected here and applied in a
	// post-pass after this loop: a restrictive DACL applied as each
	// directory is created could deny the restore the access it still needs
	// for later entries beneath it. Symlinks/junctions never take one.
	type dirSD struct {
		relative, display string
		plan              sdPlan
	}
	var dirSecurity []dirSD
	var dirAttrs []pendingDirAttrs
	for j, entry := range append(links, dirs...) {
		if checkCancelled() {
			return result, nil
		}
		dirIndex := j - len(links) // index into dirs; negative for a link
		displayPath := restoreSourcePath(entry)
		relativeEntry, relErr := restoreRelativePath(displayPath)
		if relErr != nil {
			if errors.Is(relErr, securefs.ErrInvalidWindowsName) {
				result.Warnings = append(result.Warnings, fmt.Sprintf("invalid restore path %s: %v", displayPath, relErr))
			} else {
				result.Warnings = append(result.Warnings, fmt.Sprintf("path traversal blocked: %s", displayPath))
			}
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			continue
		}
		if blockErr, blocked := blockedDirErr(blockedDirs, relativeEntry, dirIndex, dirPlans); blocked {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings, fmt.Sprintf("not restored %s: %s", displayPath, blockErr))
			continue
		}
		// securefs walks to the entry's parent with directory descriptors and
		// refuses a symlink at every component, so neither pass can be routed
		// through an ancestor an earlier pass recreated as a link. The link
		// itself is created with symlinkat and the directory with mkdirat,
		// both relative to that pinned parent — never by pathname.
		var entryErr error
		skippedExistingPlaceholder := false
		switch entry.Kind {
		case KindSymlink:
			var linkWarnings []error
			linkWarnings, entryErr = securefs.InstallSymlink(targetBase, relativeEntry, entry.LinkTarget, entryOwner(entry, applyOwnership))
			for _, warning := range linkWarnings {
				result.Warnings = append(result.Warnings, fmt.Sprintf("recreated %s with reduced fidelity: %v", displayPath, warning))
			}
		case KindDir:
			// Placeholder (review fix, #5493): a pattern-excluded directory
			// (e.g. /tmp, /proc under the whole-machine preset) is recorded
			// purely so a rebuild recreates it at all — it is NOT a
			// deliberately-configured mode/owner capture the way an
			// ordinary empty-dir entry is. If it already exists, a customer
			// may have tightened its permissions since the backup ran; an
			// ordinary backup_restore must not silently revert that. Only
			// apply mode/owner when this restore is the one creating the
			// directory. securefs.StatFile is the symlink-safe existence
			// check: it walks the same descriptor-pinned path InstallDir
			// would, so this can't be fooled by a planted symlink into
			// skipping (or performing) the wrong directory's metadata
			// apply.
			if entry.Placeholder {
				if info, statErr := securefs.StatFile(targetBase, relativeEntry); statErr == nil && info.IsDir() {
					skippedExistingPlaceholder = true
				}
			}
			if !skippedExistingPlaceholder {
				mode := os.FileMode(entry.ModeBits)
				if !applyOwnership {
					// A non-root owner may legitimately set sticky/setgid on
					// its own directory; setuid on a directory is
					// vanishingly rare and this path cannot confirm root,
					// so it strips only that bit.
					mode &^= os.ModeSetuid
				}
				entryErr = securefs.InstallDir(targetBase, relativeEntry, mode, entry.ModeBits != 0, entryOwner(entry, applyOwnership), entry.ModTime)
				if entryErr == nil {
					// A Hidden or System folder must come back Hidden/System
					// rather than plain (#5407, #6506). Deferred to a
					// post-pass below, after every entry is in place.
					if entry.WinAttrs != 0 {
						dirAttrs = append(dirAttrs, pendingDirAttrs{relative: relativeEntry, display: displayPath, attrs: entry.WinAttrs})
					}
					if plan := dirPlans[dirIndex]; plan.applier != nil && !preRestricted[dirIndex] {
						dirSecurity = append(dirSecurity, dirSD{relative: relativeEntry, display: displayPath, plan: plan})
					}
				}
			}
		default:
			entryErr = fmt.Errorf("entry %s has content; use the file path", displayPath)
		}
		if entryErr != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings, fmt.Sprintf("could not recreate %s: %v", displayPath, entryErr))
			continue
		}
		if !skippedExistingPlaceholder && !applyOwnership && entry.Owner != nil {
			warnOwnership()
		}
		result.FilesRestored++
	}

	// Junctions last among the entries (#7325): every file, symlink and
	// directory is already written, so nothing is ever routed through a
	// junction this pass creates. Before the directory attribute and
	// security post-passes, so a restrictive parent DACL or ReadOnly cannot
	// stand between the restore and the junction it still has to create.
	if checkCancelled() {
		return result, nil
	}
	restoreJunctions(targetBase, junctions, cfg.JunctionTargetsAsCaptured, result)

	result.Warnings = append(result.Warnings, applyDirWinAttrs(targetBase, dirAttrs)...)

	// Directory security descriptors, now that every file, symlink and
	// directory is in place. Deepest first, so a parent's DACL can never
	// stand between the restore and a child it has yet to update. Each
	// directory is reached by securefs's pinned, reparse-refusing walk from
	// the volume root and the descriptor is set on THAT handle — never on a
	// joined pathname a swapped-in junction could redirect (SEC-121).
	sort.SliceStable(dirSecurity, func(i, j int) bool {
		return strings.Count(dirSecurity[i].relative, string(filepath.Separator)) > strings.Count(dirSecurity[j].relative, string(filepath.Separator))
	})
	for _, ds := range dirSecurity {
		plan := ds.plan
		secErr := securefs.ApplyDirSecurity(targetBase, ds.relative, *plan.applier)
		switch {
		case secErr == nil:
			secDescs.record(result, ds.display, plan)
		case plan.verdict == sdQuarantine:
			// The directory could not be restricted, so it keeps the
			// target's inherited ACL: report it failed, never restored.
			result.FilesRestored--
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, ds.display)
			result.Warnings = append(result.Warnings, fmt.Sprintf("could not restrict %s, whose recorded security descriptor names principals this machine does not recognise or cannot be read: %v", ds.display, secErr))
		default:
			result.Warnings = append(result.Warnings, fmt.Sprintf("recreated %s with reduced fidelity: could not reapply security descriptor: %v", ds.display, secErr))
		}
	}
	result.Warnings = append(result.Warnings, secDescs.finish()...)

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
		// Nothing left to resume. Release the journal handle first: an open
		// handle would block removing the staging dir on Windows.
		resume.discard()
		if err := os.RemoveAll(stagingDir); err != nil {
			slog.Warn("failed to clean up staging dir", "dir", stagingDir, "error", err.Error())
		} else {
			result.StagingDir = ""
		}
	}

	return result, nil
}

// contentKeys returns the object keys of the entries that carry content,
// in manifest order, for providers.PrepareDownloads.
func contentKeys(files []SnapshotFile) []string {
	keys := make([]string, 0, len(files))
	for _, f := range files {
		if f.HasContent() && f.BackupPath != "" {
			keys = append(keys, f.BackupPath)
		}
	}
	return keys
}

// downloadManifest fetches and parses the manifest for a snapshot without
// an integrity expectation.
func downloadManifest(provider providers.BackupProvider, snapshotID, workRoot string) (*Snapshot, error) {
	snapshot, _, err := downloadVerifiedManifest(context.Background(), provider, snapshotID, workRoot, nil)
	return snapshot, err
}

// plainDownload is the transfer restores have always used: the provider's
// own Download, not cancelled mid-object (cancellation is checked between
// files).
func plainDownload(_ context.Context, p providers.BackupProvider, key, dest string) error {
	return p.Download(key, dest)
}

// downloadVerifiedManifest fetches and parses the manifest for a snapshot.
// In attested mode the bytes must match the attested manifest object before
// they are decoded (a vault copy that does not is replaced by primary
// storage's, with a warning); otherwise it is downloaded as before.
func downloadVerifiedManifest(ctx context.Context, provider providers.BackupProvider, snapshotID, workRoot string, e *integrity.Expectation) (*Snapshot, []string, error) {
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)
	if workRoot == "" {
		workRoot = os.TempDir()
	}
	tmpPath, warnings, err := integrity.DownloadVerifiedControlObjectVia(ctx, plainDownload, provider, e, integrity.RoleManifest, manifestKey, workRoot)
	if err != nil {
		if e.Attested() {
			return nil, nil, err
		}
		return nil, nil, fmt.Errorf("download manifest: %w", err)
	}
	defer func() { _ = os.Remove(tmpPath) }()

	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read manifest: %w", err)
	}

	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, nil, fmt.Errorf("decode manifest: %w", err)
	}
	return &snapshot, warnings, nil
}

// integrityResultCode is the result code for err when the command carried an
// integrity expectation and err is an integrity check failure, else "".
func integrityResultCode(e *integrity.Expectation, err error) string {
	if !e.Present() {
		return ""
	}
	return integrity.FailureCode(err)
}

// storedBytes is what a manifest entry says about its stored object.
func storedBytes(file SnapshotFile) integrity.Stored {
	return integrity.Stored{Size: file.Size, SHA256: file.Checksum, Volatile: file.Volatile}
}

// downloadAndCheckStaged downloads one entry's object into stagingFile and
// checks it against the entry: exactly in attested mode, with the earlier
// rules otherwise (see integrity.CheckStoredBytes). With an expectation a
// vault copy that fails the check is replaced by primary storage's copy.
func downloadAndCheckStaged(ctx context.Context, provider providers.BackupProvider, file SnapshotFile, stagingFile string, e *integrity.Expectation) (integrity.CheckResult, []string, error) {
	return integrity.DownloadCheckedVia(ctx, plainDownload, provider, file.BackupPath, stagingFile, storedBytes(file), e)
}

// storedBytesFailureWarning is the result warning for a file that failed its
// download or content check ("" for a plain download failure, which is
// reported through FailedFiles only, as before).
func storedBytesFailureWarning(displayPath string, file SnapshotFile, err error, e *integrity.Expectation) string {
	switch {
	case e.Present() && integrity.FailureCode(err) != "":
		return fmt.Sprintf("restored %s failed integrity check (%s): %v", displayPath, integrity.FailureCode(err), err)
	case errors.Is(err, integrity.ErrSizeMismatch):
		return fmt.Sprintf("restored %s failed size check: %v", displayPath, err)
	case errors.Is(err, integrity.ErrChecksumMismatch):
		return fmt.Sprintf("restored %s failed checksum check (manifest %s)", displayPath, file.Checksum)
	default:
		return ""
	}
}

// resumedFileIntact reports whether a file an earlier run of this restore
// completed can be skipped: the published file must still be there with the
// manifest's size and, in attested mode, exactly the attested content.
func resumedFileIntact(targetBase, relativeTarget string, file SnapshotFile, e *integrity.Expectation) bool {
	info, err := securefs.StatFile(targetBase, relativeTarget)
	if err != nil || info.Size() != file.Size {
		return false
	}
	if !e.Attested() {
		return true
	}
	if file.Checksum == "" {
		return false
	}
	f, err := securefs.OpenFile(targetBase, relativeTarget)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return err == nil && n == file.Size && strings.EqualFold(hex.EncodeToString(h.Sum(nil)), file.Checksum)
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

// RestoreKey returns the path an entry restores under, relative to the
// restore target: restoreSourcePath (OriginalPath when VSS rewrote
// SourcePath) with the volume and leading separators stripped — exactly
// what resolveTargetPath joins under the target base. Separators are left
// as recorded (a Windows manifest's `\` stays `\`), so
// filepath.Join(root, RestoreKey(f)) is the file the restore wrote on the
// host that ran the restore. Callers outside this package (the rebuild
// engine's validate/winValidate) must use this, never f.SourcePath.
func RestoreKey(f SnapshotFile) string {
	return stripVolumeAndLeadingSeparators(restoreSourcePath(f))
}

// RestoreSourceKey is restoreSourcePath exported: the exact string
// RestoreResult.FailedFiles entries are written under (displayPath in the
// download loop above — OriginalPath when VSS rewrote SourcePath, else
// SourcePath itself; volume NOT stripped, separators as recorded). Use this,
// never RestoreKey, to look an entry up in a FailedFiles-derived set (e.g.
// the rebuild engine's r.failedFiles, populated unchanged from
// RestoreResult.FailedFiles) — RestoreKey is the relative-to-target-base
// path an entry restores under on disk, a different string for any Windows
// entry (it additionally strips the drive volume and leading separators).
func RestoreSourceKey(f SnapshotFile) string {
	return restoreSourcePath(f)
}

// RestoreVolume is the volume (drive, e.g. "D:") RestoreKey strips from an
// entry: restoreSourcePath's volume — OriginalPath's for a VSS entry, never
// the shadow-copy device of SourcePath — or "" when the recorded path
// carries none. A restore into one target base flattens every volume into
// it, so the rebuild engine uses this to refuse a snapshot whose entries
// span more than the root volume.
func RestoreVolume(f SnapshotFile) string {
	return volumeName(restoreSourcePath(f))
}

// SetVolumeNameForTest overrides the package-level volumeName hook restore.go
// uses to strip a leading Windows drive volume, returning a restore func.
// Exported (test-only by convention, never called from non-test code) so an
// external package's test — rebuild/validate_test.go's
// TestValidate_UsesRestoreKey — can exercise RestoreKey's Windows-path
// branch on a non-Windows CI runner, exactly like restore_volume_test.go's
// unexported withWindowsVolumeName does for this package's own tests.
func SetVolumeNameForTest(f func(string) string) (restore func()) {
	orig := volumeName
	volumeName = f
	return func() { volumeName = orig }
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

func restoreStagingDir(cfg RestoreConfig, workRoot string) (string, error) {
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
	return filepath.Join(workRoot, "staging", cfg.SnapshotID, stagingKey), nil
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

func prepareRestoreWorkRoot(configured string) (string, bool, error) {
	if configured == "" {
		root, err := os.MkdirTemp("", "breeze-restore-work-")
		if err != nil {
			return "", false, err
		}
		if err := os.Chmod(root, 0o700); err != nil {
			_ = os.RemoveAll(root)
			return "", false, err
		}
		return root, true, nil
	}
	if !filepath.IsAbs(configured) {
		return "", false, errors.New("configured restore work root must be absolute")
	}
	root := filepath.Join(configured, "restore-work")
	if err := securefs.EnsurePrivateDir(root); err != nil {
		return "", false, err
	}
	return root, false, nil
}

// entryOwner converts a manifest owner into the securefs form, and returns nil
// when this process cannot apply ownership at all (non-root). Ownership is
// applied to a pinned descriptor inside securefs, never by pathname.
func entryOwner(entry SnapshotFile, applyOwnership bool) *securefs.Owner {
	if !applyOwnership || entry.Owner == nil {
		return nil
	}
	return &securefs.Owner{UID: entry.Owner.UID, GID: entry.Owner.GID}
}

func restoreRelativePath(sourcePath string) (string, error) {
	return securefs.CleanRelative(stripVolumeAndLeadingSeparators(sourcePath))
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

func validateSnapshotID(snapshotID string) error {
	clean, err := securefs.CleanRelative(snapshotID)
	if err != nil || clean != snapshotID || filepath.Base(clean) != clean {
		return errors.New("snapshot ID must be a single safe path component")
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
// BackupPath; resume state (resumeTracker, restore_resume.go)
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
		// Placeholder (review fix, #5493): see the matching comment in
		// RestoreFromSnapshotContext's dir pass above — a pattern-excluded
		// directory's manifest entry exists purely so a rebuild recreates
		// it at all, not because its mode/owner were deliberately captured.
		// If it's already there, a customer may have tightened its
		// permissions since the backup; leave it untouched rather than
		// silently reverting that, and skip the applyOwnership tail below
		// too (return directly).
		if entry.Placeholder {
			if info, err := os.Lstat(targetPath); err == nil && info.IsDir() {
				return nil
			}
		}
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
		// Windows attributes last (#5407, review finding) — see the matching
		// call in RestoreFromSnapshotContext's KindDir pass. A Hidden/System
		// directory that is only recorded when empty still has to come back
		// Hidden/System.
		if err := applyWinAttrs(targetPath, entry.WinAttrs); err != nil {
			return err
		}
	default:
		return fmt.Errorf("entry %s has content; use the file path", restoreSourcePath(entry))
	}
	if applyOwnership {
		if err := applyOwner(targetPath, entry.Owner); err != nil {
			return err
		}
	}
	return nil
}

// restrictDirectoriesFirst computes every directory's descriptor plan once
// and, for each directory to be restricted, creates it and applies the
// restrictive descriptor now, shallowest first, before any entry beneath it
// is restored. It returns the plans (by index into dirs), which directories
// were restricted here, and the relative paths of directories that could not
// be restricted (reported failed; nothing beneath them is restored).
func restrictDirectoriesFirst(targetBase string, dirs []SnapshotFile, secDescs *restoreSecurity, applyOwnership bool, result *RestoreResult) (map[int]sdPlan, map[int]bool, []string) {
	plans := make(map[int]sdPlan, len(dirs))
	restricted := make(map[int]bool)
	var blocked []string
	var order []int
	for i, d := range dirs {
		plans[i] = secDescs.entryPlan(d)
		if plans[i].verdict == sdQuarantine && plans[i].applier != nil {
			order = append(order, i)
		}
	}
	sort.SliceStable(order, func(a, b int) bool {
		return strings.Count(restoreSourcePath(dirs[order[a]]), "/")+strings.Count(restoreSourcePath(dirs[order[a]]), `\`) <
			strings.Count(restoreSourcePath(dirs[order[b]]), "/")+strings.Count(restoreSourcePath(dirs[order[b]]), `\`)
	})
	for _, i := range order {
		d := dirs[i]
		display := restoreSourcePath(d)
		rel, err := restoreRelativePath(display)
		if err != nil {
			continue // the directory pass reports it
		}
		if d.Placeholder {
			if info, statErr := securefs.StatFile(targetBase, rel); statErr == nil && info.IsDir() {
				continue // an existing placeholder directory is left untouched
			}
		}
		mode := os.FileMode(d.ModeBits)
		if !applyOwnership {
			mode &^= os.ModeSetuid
		}
		err = securefs.InstallDir(targetBase, rel, mode, d.ModeBits != 0, entryOwner(d, applyOwnership), d.ModTime)
		if err == nil {
			err = securefs.ApplyDirSecurity(targetBase, rel, *plans[i].applier)
		}
		if err != nil {
			blocked = append(blocked, rel)
			plans[i] = sdPlan{verdict: sdQuarantine, reason: fmt.Sprintf("its directory could not be restricted: %v", err)}
			continue
		}
		restricted[i] = true
		secDescs.record(result, display, plans[i])
	}
	return plans, restricted, blocked
}

// blockedDirErr reports whether an entry of the link/directory pass must not
// be restored: it is itself a directory that could not be restricted, or it
// lies beneath one.
func blockedDirErr(blocked []string, relative string, dirIndex int, plans map[int]sdPlan) (string, bool) {
	for _, b := range blocked {
		if relative == b && dirIndex >= 0 {
			return plans[dirIndex].reason, true
		}
		if strings.HasPrefix(relative, b+string(filepath.Separator)) {
			return "its directory could not be restricted", true
		}
	}
	return "", false
}

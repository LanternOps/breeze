package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VerifyResult holds the outcome of a backup integrity check.
type VerifyResult struct {
	SnapshotID    string `json:"snapshotId"`
	Status        string `json:"status"` // passed, failed, partial
	FilesVerified int    `json:"filesVerified"`
	// FilesSizeOnly counts files verified by size only because the manifest
	// carried no checksum for them (an older manifest, or a checksum that
	// failed to compute at backup time). Non-zero means "passed" is weaker than
	// a full checksum verification — size-only can't catch same-size bit-rot.
	FilesSizeOnly int `json:"filesSizeOnly,omitempty"`
	FilesFailed   int `json:"filesFailed"`
	// FilesIncomplete is the number of files the BACKUP run could not upload,
	// read from the manifest's incompleteFiles (#6350). These files are absent
	// from the manifest's file list, so verification can never observe them
	// directly — without this the check walks only what was stored, finds it
	// all present, and reports `passed` with zero failures on a restore point
	// that is knowingly missing data. Non-zero forces Status off `passed`.
	FilesIncomplete int `json:"filesIncomplete,omitempty"`
	// FilesUnchecked is the number of files the run never reached a verdict
	// on because its time budget ran out (#6598). Non-zero means Status is
	// never `passed` and Error says how far the run got.
	FilesUnchecked int      `json:"filesUnchecked,omitempty"`
	SizeBytes      int64    `json:"sizeBytes"`
	DurationMs     int64    `json:"durationMs"`
	FailedFiles    []string `json:"failedFiles,omitempty"`
	// Warnings carries advisory notes that did not fail a file — currently
	// only a size/checksum mismatch on a Volatile entry (#5581): the source
	// kept changing while it was backed up, so the manifest describes the
	// last pre-upload measurement rather than any single instant, and a
	// mismatch against it is expected rather than corruption.
	Warnings []string `json:"warnings,omitempty"`
	Error    string   `json:"error,omitempty"`
}

// TestRestoreResult holds the outcome of a test restore operation.
type TestRestoreResult struct {
	SnapshotID    string `json:"snapshotId"`
	Status        string `json:"status"`
	FilesVerified int    `json:"filesVerified"`
	FilesFailed   int    `json:"filesFailed"`
	// FilesUnchecked — see VerifyResult.FilesUnchecked.
	FilesUnchecked     int      `json:"filesUnchecked,omitempty"`
	SizeBytes          int64    `json:"sizeBytes"`
	RestoreTimeSeconds int      `json:"restoreTimeSeconds"`
	RestorePath        string   `json:"restorePath"`
	CleanedUp          bool     `json:"cleanedUp"`
	FailedFiles        []string `json:"failedFiles,omitempty"`
	// Warnings carries advisory notes that did not fail a file — see
	// VerifyResult.Warnings.
	Warnings []string `json:"warnings,omitempty"`
	Error    string   `json:"error,omitempty"`
}

// VerifyIntegrity checks a snapshot's manifest and validates each file
// can be downloaded and read from the provider.
func VerifyIntegrity(provider providers.BackupProvider, snapshotID string) (*VerifyResult, error) {
	return VerifyIntegrityContext(context.Background(), provider, snapshotID)
}

func VerifyIntegrityContext(ctx context.Context, provider providers.BackupProvider, snapshotID string) (*VerifyResult, error) {
	return VerifyIntegrityWithOptions(ctx, provider, snapshotID, VerifyOptions{})
}

// VerifyIntegrityWithOptions is VerifyIntegrityContext with progress
// reporting and an overall time budget (see VerifyOptions). Objects are
// downloaded verifyDownloadConcurrency at a time, each bounded by a per-file
// deadline, so one stalled transfer fails only its own file (#6598).
func VerifyIntegrityWithOptions(ctx context.Context, provider providers.BackupProvider, snapshotID string, opts VerifyOptions) (*VerifyResult, error) {
	start := time.Now()
	result := &VerifyResult{SnapshotID: snapshotID}

	if err := ctx.Err(); err != nil {
		result.DurationMs = time.Since(start).Milliseconds()
		return result, err
	}
	runCtx, stopRun := opts.runContext(ctx)
	defer stopRun()

	// Download and parse manifest
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)
	tempManifest, err := os.CreateTemp("", "verify-manifest-*.json")
	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to create temp file: %v", err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result, nil
	}
	tempManifestPath := tempManifest.Name()
	_ = tempManifest.Close()
	defer os.Remove(tempManifestPath)

	if err := downloadWithStallTimeout(runCtx, provider, manifestKey, tempManifestPath); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			result.DurationMs = time.Since(start).Milliseconds()
			return result, ctxErr
		}
		result.Status = "failed"
		result.Error = manifestDownloadError(runCtx, opts, err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result, nil
	}
	if err := ctx.Err(); err != nil {
		result.DurationMs = time.Since(start).Milliseconds()
		return result, err
	}

	manifestData, err := os.ReadFile(tempManifestPath)
	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to read manifest: %v", err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result, nil
	}

	var snapshot Snapshot
	if err := json.Unmarshal(manifestData, &snapshot); err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("invalid manifest JSON: %v", err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result, nil
	}

	// Verify each file by downloading through the provider, several at once.
	// Each worker writes only its own outcomes[i]; runFileChecks returns after
	// every worker has finished, and the tally below walks outcomes in
	// manifest order so failed files and warnings are reported
	// deterministically.
	files := snapshot.Files
	outcomes := make([]fileCheckOutcome, len(files))
	finished := 0
	runFileChecks(runCtx, len(files), func(i int) {
		outcomes[i] = verifySnapshotFile(runCtx, provider, files[i])
	}, func(i int) {
		if outcomes[i].state == fileNotChecked {
			return // interrupted by the run ending — not a finished entry
		}
		finished++
		if opts.Progress != nil {
			opts.Progress(finished, len(files))
		}
	})

	for i, o := range outcomes {
		switch o.state {
		case fileVerified:
			result.FilesVerified++
			result.SizeBytes += o.size
			if o.sizeOnly {
				result.FilesSizeOnly++
			}
			result.Warnings = append(result.Warnings, o.warnings...)
		case fileFailed:
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, files[i].BackupPath)
		}
	}

	if err := ctx.Err(); err != nil {
		result.DurationMs = time.Since(start).Milliseconds()
		return result, err
	}
	result.FilesUnchecked = countUnchecked(files, outcomes)

	// Determine status
	result.FilesIncomplete = snapshot.IncompleteFiles
	total := result.FilesVerified + result.FilesFailed
	switch {
	case result.FilesUnchecked > 0:
		// Only the run's own time budget leaves files unchecked without an
		// error (a caller cancel returned above). Never `passed`: part of the
		// snapshot was not looked at.
		if result.FilesVerified == 0 {
			result.Status = "failed"
		} else {
			result.Status = "partial"
		}
		result.Error = timeBudgetMessage("verification", opts.TimeBudget,
			result.FilesVerified, result.FilesFailed, countContentFiles(files))
		log.Warn("verification stopped at its time budget; reporting partial counts",
			"phase", "verify", "snapshotId", snapshotID,
			"filesVerified", result.FilesVerified, "filesFailed", result.FilesFailed,
			"filesUnchecked", result.FilesUnchecked)
	case total == 0:
		result.Status = "failed"
		result.Error = "no files in snapshot"
	case result.FilesFailed == 0:
		result.Status = "passed"
	case result.FilesVerified == 0:
		result.Status = "failed"
	default:
		result.Status = "partial"
	}

	// A snapshot whose backup run could not upload every file is an incomplete
	// restore point, however clean the stored objects are. Downgrade `passed`
	// and say what is missing, so an operator is not told a snapshot is
	// verified when files are known to be absent from it (#6350).
	if snapshot.IncompleteFiles > 0 {
		if result.Status == "passed" {
			result.Status = "partial"
		}
		result.Warnings = append(result.Warnings, incompleteSnapshotWarning(&snapshot))
		log.Warn("snapshot manifest reports files that never uploaded; verification cannot be a pass",
			"phase", "verify", "snapshotId", snapshotID,
			"incompleteFiles", snapshot.IncompleteFiles,
			"filesVerified", result.FilesVerified)
	}

	result.DurationMs = time.Since(start).Milliseconds()
	return result, nil
}

// verifySnapshotFile downloads one manifest entry to a temp file and checks
// it against the manifest. Runs on a runFileChecks worker goroutine.
func verifySnapshotFile(ctx context.Context, provider providers.BackupProvider, file SnapshotFile) fileCheckOutcome {
	if !file.HasContent() {
		// Content-less entry (symlink/directory): no uploaded object to
		// verify — see SnapshotFile.HasContent's doc comment.
		return fileCheckOutcome{state: fileSkipped}
	}
	failed := fileCheckOutcome{state: fileFailed}

	tempFile, err := os.CreateTemp("", "verify-file-*")
	if err != nil {
		log.Warn("temp file create failed", "phase", "verify", "backupPath", file.BackupPath, "error", err.Error())
		return failed
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	defer os.Remove(tempPath)

	// Download the file from provider (provider validates gzip on .gz files)
	dlErr := downloadWithDeadline(ctx, provider, file.BackupPath, tempPath, downloadDeadline(file.Size))
	if ctx.Err() != nil {
		// The run ended (caller cancel or time budget) mid-download: no
		// verdict on this file either way.
		logInterruptedDownload("verify", file.BackupPath, dlErr)
		return fileCheckOutcome{state: fileNotChecked}
	}
	if dlErr != nil {
		log.Warn("download failed", "phase", "verify", "backupPath", file.BackupPath, "error", dlErr.Error())
		return failed
	}

	// Validate the downloaded object against the manifest so SILENT
	// corruption (bit-rot, truncation, tampering) is caught — not just a
	// missing object. Downloading proves presence; without this a wrong-bytes
	// object passed as "verified" (the remote/cloud providers, unlike
	// LocalProvider, do not gzip-validate, and the manifest previously stored
	// no checksum). Size is always checked; the SHA-256 is checked whenever
	// the manifest carries one (manifests written before checksums were added
	// do not — those are counted as size-only via FilesSizeOnly).
	info, statErr := os.Stat(tempPath)
	if statErr != nil || info == nil {
		log.Warn("stat failed", "phase", "verify", "backupPath", file.BackupPath, "error", errString(statErr))
		return failed
	}
	outcome := fileCheckOutcome{state: fileVerified, size: info.Size()}
	if info.Size() != file.Size {
		if !file.Volatile {
			log.Warn("size mismatch", "phase", "verify", "backupPath", file.BackupPath,
				"expectedBytes", file.Size, "actualBytes", info.Size())
			return failed
		}
		// The source kept changing while it was backed up (#5581): the
		// manifest's Size describes the last pre-upload measurement, not
		// necessarily the object's current state. Advisory only — count the
		// file verified, don't fail it.
		outcome.warnings = append(outcome.warnings, fmt.Sprintf("%s: size differs from manifest (manifest %d, actual %d) — file was volatile during backup", file.BackupPath, file.Size, info.Size()))
		log.Warn("volatile file size mismatch (advisory, not a failure)", "phase", "verify", "backupPath", file.BackupPath,
			"expectedBytes", file.Size, "actualBytes", info.Size())
	}
	if file.Checksum == "" {
		outcome.sizeOnly = true
		return outcome
	}
	if !checksumMatches(tempPath, file.Checksum) {
		if !file.Volatile {
			log.Warn("checksum mismatch", "phase", "verify", "backupPath", file.BackupPath,
				"expected", file.Checksum)
			return failed
		}
		outcome.warnings = append(outcome.warnings,
			fmt.Sprintf("%s: checksum differs from manifest (manifest %s) — file was volatile during backup", file.BackupPath, file.Checksum))
		log.Warn("volatile file checksum mismatch (advisory, not a failure)", "phase", "verify", "backupPath", file.BackupPath,
			"expected", file.Checksum)
	}
	return outcome
}

// maxVerifyIncompletePathsReported caps how many missing source paths the
// warning names; the manifest itself already caps what it stores.
const maxVerifyIncompletePathsReported = 5

// incompleteSnapshotWarning renders the manifest's recorded upload failures as
// an operator-readable warning line.
func incompleteSnapshotWarning(snapshot *Snapshot) string {
	msg := fmt.Sprintf("%d file(s) never uploaded during the backup run and are absent from this snapshot", snapshot.IncompleteFiles)
	names := snapshot.IncompleteFilePaths
	if len(names) == 0 {
		return msg
	}
	shown := names
	if len(shown) > maxVerifyIncompletePathsReported {
		shown = shown[:maxVerifyIncompletePathsReported]
	}
	msg += ": " + strings.Join(shown, "; ")
	if len(names) > len(shown) {
		msg += fmt.Sprintf(" (+%d more)", len(names)-len(shown))
	}
	return msg
}

// errString renders an error for a structured log attribute. The log shipper
// JSON-marshals attrs and a raw error marshals to {}, so errors are logged as
// strings. Used where the error may be nil (a stat that returned nil info
// without an error), which err.Error() would panic on.
func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

const restoreTestPrefix = "breeze-restore-test"

// TestRestore downloads a snapshot to a private directory beneath workRoot and
// verifies each file. workRoot must be the privileged agent data directory.
// progressFn is called after each manifest entry with (current, total) counts. Can be nil.
func TestRestore(provider providers.BackupProvider, snapshotID, workRoot string, progressFn func(current, total int)) (*TestRestoreResult, error) {
	return TestRestoreContext(context.Background(), provider, snapshotID, workRoot, progressFn)
}

func TestRestoreContext(ctx context.Context, provider providers.BackupProvider, snapshotID, workRoot string, progressFn func(current, total int)) (*TestRestoreResult, error) {
	return TestRestoreWithOptions(ctx, provider, snapshotID, workRoot, VerifyOptions{Progress: progressFn})
}

// TestRestoreWithOptions is TestRestoreContext with an overall time budget
// (see VerifyOptions). Like VerifyIntegrityWithOptions it downloads several
// objects at once, each bounded by a per-file deadline (#6598).
func TestRestoreWithOptions(ctx context.Context, provider providers.BackupProvider, snapshotID, workRoot string, opts VerifyOptions) (*TestRestoreResult, error) {
	start := time.Now()
	result := &TestRestoreResult{SnapshotID: snapshotID}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if err := validateSnapshotID(snapshotID); err != nil {
		return nil, err
	}
	operationRoot, ephemeral, err := prepareRestoreWorkRoot(workRoot)
	if err != nil {
		return nil, fmt.Errorf("prepare test-restore work root: %w", err)
	}
	if ephemeral {
		defer func() { _ = os.RemoveAll(operationRoot) }()
	}
	runCtx, stopRun := opts.runContext(ctx)
	defer stopRun()

	// Download and parse manifest
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)
	tempManifest, err := os.CreateTemp(operationRoot, "restore-manifest-*.json")
	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to create temp file: %v", err)
		return result, nil
	}
	tempManifestPath := tempManifest.Name()
	_ = tempManifest.Close()
	defer os.Remove(tempManifestPath)

	if err := downloadWithStallTimeout(runCtx, provider, manifestKey, tempManifestPath); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return result, ctxErr
		}
		result.Status = "failed"
		result.Error = manifestDownloadError(runCtx, opts, err)
		return result, nil
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}

	manifestData, err := os.ReadFile(tempManifestPath)
	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to read manifest: %v", err)
		return result, nil
	}

	var snapshot Snapshot
	if err := json.Unmarshal(manifestData, &snapshot); err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("invalid manifest JSON: %v", err)
		return result, nil
	}

	// Create a fresh, unguessable directory for every run. The parent is
	// restricted to the privileged agent account by prepareRestoreWorkRoot.
	restoreDir, err := os.MkdirTemp(operationRoot, restoreTestPrefix+"-")
	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to create restore dir: %v", err)
		return result, nil
	}
	if err := os.Chmod(restoreDir, 0o700); err != nil {
		_ = os.RemoveAll(restoreDir)
		return nil, fmt.Errorf("restrict test-restore directory: %w", err)
	}
	result.RestorePath = restoreDir

	cleanup := func() {
		if cleanErr := os.RemoveAll(restoreDir); cleanErr != nil {
			log.Warn("cleanup failed", "phase", "restore", "path", restoreDir, "error", cleanErr.Error())
			result.CleanedUp = false
		} else {
			result.CleanedUp = true
		}
	}

	// Resolve every destination up front, serially, so concurrent workers
	// never share one: two entries that resolve to the same path (a
	// case-only difference on a case-insensitive volume) would otherwise
	// race on a single file and fail each other's checks.
	files := snapshot.Files
	destPaths, pathErrs := testRestoreDestinations(restoreDir, files)

	// Restore each file, several at once. Workers write only their own
	// outcomes[i]; the tally walks outcomes in manifest order.
	outcomes := make([]fileCheckOutcome, len(files))
	finished := 0
	runFileChecks(runCtx, len(files), func(i int) {
		outcomes[i] = restoreSnapshotFile(runCtx, provider, files[i], destPaths[i], pathErrs[i])
	}, func(i int) {
		if outcomes[i].state == fileNotChecked {
			return
		}
		finished++
		if opts.Progress != nil {
			opts.Progress(finished, len(files))
		}
	})

	for i, o := range outcomes {
		switch o.state {
		case fileVerified:
			result.FilesVerified++
			result.SizeBytes += o.size
			result.Warnings = append(result.Warnings, o.warnings...)
		case fileFailed:
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, files[i].BackupPath)
		}
	}

	if err := ctx.Err(); err != nil {
		result.RestoreTimeSeconds = int(time.Since(start).Seconds())
		cleanup()
		return result, err
	}
	result.FilesUnchecked = countUnchecked(files, outcomes)

	// Determine status
	switch {
	case result.FilesUnchecked > 0:
		// Same rule as VerifyIntegrityWithOptions: only the run's own time
		// budget gets here, and a partly-restored snapshot is never a pass.
		if result.FilesVerified == 0 {
			result.Status = "failed"
		} else {
			result.Status = "partial"
		}
		result.Error = timeBudgetMessage("test restore", opts.TimeBudget,
			result.FilesVerified, result.FilesFailed, countContentFiles(files))
		log.Warn("test restore stopped at its time budget; reporting partial counts",
			"phase", "restore", "snapshotId", snapshotID,
			"filesVerified", result.FilesVerified, "filesFailed", result.FilesFailed,
			"filesUnchecked", result.FilesUnchecked)
	case result.FilesVerified+result.FilesFailed == 0:
		result.Status = "failed"
		result.Error = "no files in snapshot"
	case result.FilesFailed == 0:
		result.Status = "passed"
	case result.FilesVerified == 0:
		result.Status = "failed"
	default:
		result.Status = "partial"
	}

	// Same rule as VerifyIntegrityContext (#6350): a test restore of a snapshot
	// that is knowingly missing files restored everything it was given, which
	// is not the same as a complete restore point.
	if snapshot.IncompleteFiles > 0 {
		if result.Status == "passed" {
			result.Status = "partial"
		}
		result.Warnings = append(result.Warnings, incompleteSnapshotWarning(&snapshot))
		log.Warn("snapshot manifest reports files that never uploaded; test restore cannot be a pass",
			"phase", "restore", "snapshotId", snapshotID,
			"incompleteFiles", snapshot.IncompleteFiles,
			"filesVerified", result.FilesVerified)
	}

	result.RestoreTimeSeconds = int(time.Since(start).Seconds())
	cleanup()
	return result, nil
}

// testRestoreDestinations maps each manifest entry to its path under
// restoreDir. An entry whose path is invalid gets its error instead. A
// destination already claimed by an earlier entry (compared
// case-insensitively, since the volume may be) is given a unique suffix: a
// test restore only proves each object round-trips, so the exact name is
// immaterial, but two workers writing one file is not.
func testRestoreDestinations(restoreDir string, files []SnapshotFile) ([]string, []error) {
	dests := make([]string, len(files))
	errs := make([]error, len(files))
	claimed := make(map[string]bool, len(files))
	for i, file := range files {
		if !file.HasContent() {
			continue
		}
		relative, err := restoreRelativePath(restoreSourcePath(file))
		if err != nil {
			errs[i] = err
			continue
		}
		dest := filepath.Join(restoreDir, relative)
		key := strings.ToLower(dest)
		if claimed[key] {
			dest = fmt.Sprintf("%s.breeze-dup-%d", dest, i)
			key = strings.ToLower(dest)
		}
		claimed[key] = true
		dests[i] = dest
	}
	return dests, errs
}

// restoreSnapshotFile downloads one manifest entry to destPath and checks it
// against the manifest. Runs on a runFileChecks worker goroutine.
func restoreSnapshotFile(ctx context.Context, provider providers.BackupProvider, file SnapshotFile, destPath string, pathErr error) fileCheckOutcome {
	if !file.HasContent() {
		// Content-less entry (symlink/directory): no uploaded object to
		// restore — see SnapshotFile.HasContent's doc comment. The real
		// restore path (restore.go) recreates these directly; a test
		// restore's job is only to prove the uploaded OBJECTS round-trip.
		return fileCheckOutcome{state: fileSkipped}
	}
	failed := fileCheckOutcome{state: fileFailed}
	if pathErr != nil {
		log.Warn("invalid restore path", "phase", "restore", "sourcePath", restoreSourcePath(file), "error", pathErr.Error())
		return failed
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		log.Warn("create target dir failed", "phase", "restore", "destPath", destPath, "error", err.Error())
		return failed
	}

	dlErr := downloadWithDeadline(ctx, provider, file.BackupPath, destPath, downloadDeadline(file.Size))
	if ctx.Err() != nil {
		logInterruptedDownload("restore", file.BackupPath, dlErr)
		return fileCheckOutcome{state: fileNotChecked}
	}
	info, statErr := os.Stat(destPath)
	switch {
	case dlErr != nil:
		log.Warn("download failed", "phase", "restore", "backupPath", file.BackupPath, "error", dlErr.Error())
		return failed
	case statErr != nil || info == nil:
		log.Warn("stat failed", "phase", "restore", "backupPath", file.BackupPath, "error", errString(statErr))
		return failed
	case info.Size() != file.Size && !file.Volatile:
		// A real test-restore must confirm the bytes came back intact, not
		// just that a file appeared (same blind spot as VerifyIntegrity).
		log.Warn("size mismatch", "phase", "restore", "backupPath", file.BackupPath,
			"expectedBytes", file.Size, "actualBytes", info.Size())
		return failed
	case file.Checksum != "" && !file.Volatile && !checksumMatches(destPath, file.Checksum):
		log.Warn("checksum mismatch", "phase", "restore", "backupPath", file.BackupPath,
			"expected", file.Checksum)
		return failed
	}
	outcome := fileCheckOutcome{state: fileVerified, size: info.Size()}
	if file.Volatile && (info.Size() != file.Size || (file.Checksum != "" && !checksumMatches(destPath, file.Checksum))) {
		outcome.warnings = []string{fmt.Sprintf("%s: differs from manifest — file was volatile during backup", file.BackupPath)}
		log.Warn("volatile file mismatch (advisory, not a failure)", "phase", "restore", "backupPath", file.BackupPath)
	}
	return outcome
}

// CleanupRestoreDir removes a test restore directory after validating the path
// is within the expected prefix to prevent path traversal.
func CleanupRestoreDir(dirPath, workRoot string) error {
	operationRoot, ephemeral, err := prepareRestoreWorkRoot(workRoot)
	if err != nil {
		return err
	}
	if ephemeral {
		defer func() { _ = os.RemoveAll(operationRoot) }()
		return errors.New("cleanup requires a configured restore work root")
	}
	relative, err := filepath.Rel(operationRoot, filepath.Clean(dirPath))
	if err != nil || filepath.Dir(relative) != "." || !strings.HasPrefix(filepath.Base(relative), restoreTestPrefix+"-") {
		return fmt.Errorf("path %q is outside the configured test-restore root", dirPath)
	}
	return os.RemoveAll(dirPath)
}

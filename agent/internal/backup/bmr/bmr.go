package bmr

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

const (
	snapshotRootDir     = "snapshots"
	snapshotFilesDir    = "files"
	snapshotManifestKey = "manifest.json"
	systemStatePath     = "system-state"

	// maxRecoveryWarnings bounds how many individual per-file restore-failure
	// strings restoreFiles will accumulate into RecoveryResult.Warnings
	// before collapsing the rest into a single summary line (D14). See
	// RecoveryResult.FailedFiles for the uncapped true count.
	maxRecoveryWarnings = 50
)

// chmodFile, chtimesFile, and lchownFile are seams over
// os.Chmod/os.Chtimes/os.Lchown so tests can force deterministic
// post-restore fidelity failures without depending on filesystem-specific
// chmod/chtimes/chown error behavior. lchownFile is also used by
// applyArtifactMetadata (system-state artifacts) — see its doc comment for
// why ownership is best-effort (EPERM is common when not running as root).
var (
	chmodFile   = os.Chmod
	chtimesFile = os.Chtimes
	lchownFile  = os.Lchown
	// symlinkFile is a seam over os.Symlink (used by applySystemState's
	// symlink-artifact branch) so tests can force a deterministic
	// symlink-creation failure without depending on filesystem permission
	// quirks — e.g. a test running as root bypasses the directory-write
	// check that would otherwise produce the failure.
	symlinkFile = os.Symlink
)

// maxConsecutiveDownloadFailures bounds how many per-file restore failures
// (mkdir or download — the ones that call addFailure below) restoreFiles
// tolerates in a row before aborting the whole recovery. downloadWithRetry
// (download_provider.go) already retries a single file's transient errors
// for up to ~5 minutes; without this breaker, a manifest of thousands of
// files against a server that has disappeared mid-recovery would spend
// that full retry budget on EVERY file in turn — a 10,000-file manifest
// could run for days instead of failing fast. Any successful file restore
// resets the counter back to zero; chmod/chtimes fidelity failures
// (addFidelityFailure) do NOT count toward it, since the file's bytes were
// already restored fine. It is a package-level var (not const) so tests
// can shrink it to keep fixtures small.
var maxConsecutiveDownloadFailures = 25

// newRestorerFunc is a package-level indirection over the platform-specific
// newRestorer() (restore_linux.go / restore_windows.go / restore_darwin.go,
// each behind its own //go:build tag) purely so tests can inject a fake
// Restorer without needing to run on that real OS or shell out to
// systemctl/reg/launchctl. It is a var initialized from the build-tagged
// func, not a redefinition of it — restore_linux.go is owned by a sibling
// wave and is not touched here.
var newRestorerFunc = newRestorer

// RunRecovery orchestrates a full bare metal recovery.
//
// Steps:
//  1. Download system state manifest from the provider
//  2. Download and apply system state (platform-specific restorer)
//  3. Download and restore all backed-up files
//  4. Run post-restore validation
//  5. Return RecoveryResult
func RunRecovery(cfg RecoveryConfig, provider providers.BackupProvider) (*RecoveryResult, error) {
	return RunRecoveryContext(context.Background(), cfg, provider)
}

func RunRecoveryContext(ctx context.Context, cfg RecoveryConfig, provider providers.BackupProvider) (*RecoveryResult, error) {
	if provider == nil {
		return nil, fmt.Errorf("bmr: backup provider is required")
	}
	if cfg.SnapshotID == "" {
		return nil, fmt.Errorf("bmr: snapshotId is required")
	}

	result := &RecoveryResult{Status: "failed"}
	checkCancelled := func() bool {
		if ctx == nil || ctx.Err() == nil {
			return false
		}
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		if result.FilesRestored > 0 || result.StateApplied {
			result.Status = "partial"
			return true
		}
		result.Status = "failed"
		return true
	}

	slog.Info("bmr: starting recovery",
		"snapshotId", cfg.SnapshotID,
		"deviceId", cfg.DeviceID,
	)

	// 1. Download snapshot manifest.
	if checkCancelled() {
		return result, ctx.Err()
	}
	manifest, err := downloadManifest(cfg.SnapshotID, provider)
	if err != nil {
		result.Error = fmt.Sprintf("failed to download manifest: %s", err.Error())
		return result, err
	}

	slog.Info("bmr: manifest downloaded",
		"files", len(manifest.Files),
		"snapshotSize", manifest.Size,
	)

	// 2. Download and apply system state.
	if checkCancelled() {
		return result, ctx.Err()
	}
	stateResult := applySystemState(ctx, cfg, provider)
	result.StateApplied = stateResult.applied
	result.DriversInjected = stateResult.drivers
	result.Warnings = append(result.Warnings, stateResult.warnings...)
	stateErr := stateResult.err
	if stateErr != nil {
		slog.Warn("bmr: system state restore had errors", "error", stateErr.Error())
	}
	if checkCancelled() {
		return result, ctx.Err()
	}

	// 3. Download and restore files.
	if checkCancelled() {
		return result, ctx.Err()
	}
	filesRestored, bytesRestored, fileWarnings, failedFiles, filesErr := restoreFiles(ctx, manifest, cfg, provider)
	result.FilesRestored = filesRestored
	result.BytesRestored = bytesRestored
	result.FailedFiles = failedFiles
	result.Warnings = append(result.Warnings, fileWarnings...)
	if filesErr != nil {
		result.Error = fmt.Sprintf("file restore errors: %s", filesErr.Error())
	}
	if checkCancelled() {
		return result, ctx.Err()
	}

	// 4. Post-restore validation.
	if checkCancelled() {
		return result, ctx.Err()
	}
	validation, valErr := Validate(stateResult.serviceUnits)
	if valErr != nil {
		result.Warnings = append(result.Warnings, fmt.Sprintf("validation error: %s", valErr.Error()))
	} else {
		result.Validated = validation.Passed
		if !validation.Passed {
			result.Warnings = append(result.Warnings, validation.Failures...)
		}
	}

	// 5. Determine final status.
	//
	// stateBlocksCompletion is true whenever a system-state manifest was
	// actually found (stateResult.manifestFound) but the state was not
	// fully/successfully applied (stateResult.applied is false) — covering
	// both a required-step violation / download failure (stateErr != nil,
	// already excluded from "completed" by the first switch case below) and
	// the checksum/size verification failures folded into `applied` itself.
	// Before this fix, applySystemState could skip/fail state application
	// silently (err == nil, applied == false) and still let status land on
	// "completed" (D15/O10) purely because filesErr/stateErr were both nil.
	stateBlocksCompletion := stateResult.manifestFound && !stateResult.applied
	switch {
	case filesErr == nil && stateErr == nil && !stateBlocksCompletion:
		result.Status = "completed"
	case result.FilesRestored > 0 || result.StateApplied:
		result.Status = "partial"
	default:
		result.Status = "failed"
	}

	slog.Info("bmr: recovery complete",
		"status", result.Status,
		"filesRestored", result.FilesRestored,
		"failedFiles", result.FailedFiles,
		"bytesRestored", result.BytesRestored,
		"stateApplied", result.StateApplied,
		"validated", result.Validated,
	)

	return result, nil
}

// snapshotManifest matches the backup.Snapshot structure for deserialization.
type snapshotManifest struct {
	ID    string         `json:"id"`
	Files []manifestFile `json:"files"`
	Size  int64          `json:"size"`
}

type manifestFile struct {
	SourcePath string `json:"sourcePath"`
	// OriginalPath is SourcePath reconstructed back through a VSS
	// shadow-copy rewrite — mirrors backup.SnapshotFile.OriginalPath (see
	// that field's doc comment). Empty except on a Windows run where VSS
	// was active and this file's root was rewritten. Must be preferred over
	// SourcePath everywhere a restore chooses a destination — see
	// restoreSourcePath (D8): before this field existed, BMR's manifestFile
	// silently dropped `originalPath` on decode (no matching struct field),
	// so every VSS-backed BMR recovery restored under the literal
	// \\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN\... shadow-device
	// path instead of the real location.
	OriginalPath string `json:"originalPath,omitempty"`
	BackupPath   string `json:"backupPath"`
	Size         int64  `json:"size"`
	// Mode and ModTime mirror backup.SnapshotFile's identically-tagged
	// fields (agent/internal/backup/snapshot.go) — bmr's manifestFile is a
	// deliberately independent JSON-shaped mirror (see snapshotManifest's
	// doc comment), so it carries its own copies rather than importing
	// backup for two fields. Before these existed, restoreFiles silently
	// dropped `mode`/`modTime` on decode (no matching struct fields), so
	// every BMR-restored file landed with drifted permissions/mtimes (O20).
	Mode    uint32    `json:"mode,omitempty"`
	ModTime time.Time `json:"modTime"`
}

// restoreSourcePath returns the path a BMR restore should re-root file
// under: file.OriginalPath when VSS rewrote SourcePath to a per-run
// shadow-copy device path, else file.SourcePath. Mirrors backup's
// (unexported) restoreSourcePath / journalEntryKey rule — bmr's
// manifestFile is a deliberately independent JSON-shaped mirror of
// backup.SnapshotFile (see snapshotManifest's doc comment above), so it
// carries its own copy of the same fallback rule rather than importing
// backup for one function.
func restoreSourcePath(file manifestFile) string {
	if file.OriginalPath != "" {
		return file.OriginalPath
	}
	return file.SourcePath
}

func downloadManifest(snapshotID string, provider providers.BackupProvider) (*snapshotManifest, error) {
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)

	tmpFile, err := os.CreateTemp("", "bmr-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("bmr: create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := provider.Download(manifestKey, tmpPath); err != nil {
		return nil, fmt.Errorf("bmr: download manifest: %w", err)
	}

	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("bmr: read manifest: %w", err)
	}

	var manifest snapshotManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("bmr: decode manifest: %w", err)
	}
	return &manifest, nil
}

// systemStateResult carries applySystemState's outcome. It replaced a
// 4-value naked return (applied bool, drivers int, warnings []string, err
// error) once tracking "was a manifest actually found" became necessary for
// the status-derivation fix (RunRecoveryContext step 5) — a plain bool
// return couldn't distinguish "no state existed" from "state existed but
// failed to verify/apply" without an extra parameter creeping into every
// call site.
type systemStateResult struct {
	// applied is true only when: the state manifest was downloaded, every
	// required-step gate passed, every artifact download+verification
	// succeeded (see verifyArtifactIntegrity), and the platform Restorer
	// returned nil. Before this fix, applied (then a naked `applied` return)
	// was set unconditionally to true right after a successful
	// RestoreSystemState call, with no regard for whether any artifacts
	// actually verified — including the degenerate case where every
	// artifact failed to download and RestoreSystemState ran against an
	// empty staging dir (D15/O10's "completed, stateApplied: false" was the
	// closest observed symptom of the sibling status bug this also feeds).
	applied bool
	drivers int
	// warnings accumulates non-fatal issues: unverified (checksum-less)
	// artifacts, non-required incomplete capture steps, driver injection
	// errors, and per-artifact download/verification failures.
	warnings []string
	// err is set only for FATAL conditions: a required capture step never
	// completed (manifest.RequiredSteps ∩ manifest.IncompleteSteps), the
	// bootstrap advertised system state that could not be found
	// (cfg.ExpectSystemState with a 404 on the manifest itself), or the
	// platform Restorer itself returned an error.
	err error
	// manifestFound is true once system-state/manifest.json was
	// successfully downloaded and decoded — independent of `applied` — so
	// RunRecoveryContext's status derivation can tell "state was never
	// captured for this snapshot" (fine, status unaffected) apart from
	// "state was captured but this run did not fully apply it" (must not
	// report status "completed"), regardless of whether ExpectSystemState
	// happened to be set.
	manifestFound bool
	// serviceUnits is the list of systemd unit names read from the staged
	// services/systemd.txt artifact (Linux only; nil on every other
	// platform or when that artifact wasn't staged), captured before the
	// staging dir is removed so validate.go's post-restore service probe
	// can check them. See enabledSystemdUnitsFromStaging (validate.go).
	serviceUnits []string
}

func applySystemState(ctx context.Context, cfg RecoveryConfig, provider providers.BackupProvider) systemStateResult {
	// Download system state manifest from the snapshot.
	stateManifestKey := path.Join(snapshotRootDir, cfg.SnapshotID, systemStatePath, "manifest.json")

	tmpFile, tmpErr := os.CreateTemp("", "bmr-state-manifest-*.json")
	if tmpErr != nil {
		return systemStateResult{err: fmt.Errorf("bmr: create temp: %w", tmpErr)}
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	if dlErr := provider.Download(stateManifestKey, tmpPath); dlErr != nil {
		if cfg.ExpectSystemState {
			// The bootstrap said this snapshot has system state (see
			// hasSystemStateManifest, session.go) — a missing manifest here
			// is not "no state to restore", it's a broken/incomplete
			// snapshot. Fatal, not the soft warning below.
			return systemStateResult{
				err: fmt.Errorf("bmr: snapshot advertises system state but system-state/manifest.json is missing: %w", dlErr),
			}
		}
		slog.Info("bmr: no system state manifest found, skipping", "error", dlErr.Error())
		return systemStateResult{warnings: []string{"no system state found in snapshot, skipping state restore"}}
	}

	data, readErr := os.ReadFile(tmpPath)
	if readErr != nil {
		return systemStateResult{err: fmt.Errorf("bmr: read state manifest: %w", readErr)}
	}

	var stateManifest systemstate.SystemStateManifest
	if err := json.Unmarshal(data, &stateManifest); err != nil {
		return systemStateResult{err: fmt.Errorf("bmr: decode state manifest: %w", err)}
	}

	var warnings []string

	// Required-step enforcement: independently re-derive the producer's own
	// gate (systemstate.missingRequired) instead of trusting that the
	// producer never published a manifest with a required-and-incomplete
	// step — a corrupted upload, a partial retry, or a future producer bug
	// should not silently pass here just because SOME manifest exists.
	if blocking := intersectStrings(stateManifest.RequiredSteps, stateManifest.IncompleteSteps); len(blocking) > 0 {
		return systemStateResult{
			manifestFound: true,
			err:           fmt.Errorf("bmr: required system-state steps incomplete: %s", strings.Join(blocking, ", ")),
		}
	}
	if nonRequired := subtractStrings(stateManifest.IncompleteSteps, stateManifest.RequiredSteps); len(nonRequired) > 0 {
		warnings = append(warnings, fmt.Sprintf("system state capture incomplete for non-required steps: %s", strings.Join(nonRequired, ", ")))
	}

	// Download artifacts to staging directory.
	stagingDir, stagingErr := os.MkdirTemp("", "bmr-state-staging-*")
	if stagingErr != nil {
		return systemStateResult{manifestFound: true, warnings: warnings, err: fmt.Errorf("bmr: create staging dir: %w", stagingErr)}
	}
	defer os.RemoveAll(stagingDir)

	verificationFailed := false
	for _, artifact := range stateManifest.Artifacts {
		if ctx != nil && ctx.Err() != nil {
			return systemStateResult{manifestFound: true, warnings: warnings, serviceUnits: enabledSystemdUnitsFromStaging(stagingDir)}
		}
		localPath := filepath.Join(stagingDir, artifact.Path)
		if mkErr := os.MkdirAll(filepath.Dir(localPath), 0o750); mkErr != nil {
			warnings = append(warnings, fmt.Sprintf("failed to create dir for %s: %s", artifact.Name, mkErr.Error()))
			verificationFailed = true
			continue
		}

		if artifact.LinkTarget != "" {
			// Symlink artifact (systemstate.Artifact.LinkTarget's doc
			// comment): no bytes were uploaded for this one — the manifest
			// entry alone is enough to recreate the link. Never downloaded,
			// never checksum/size-verified (SizeBytes==0, Checksum=="" by
			// construction), and no metadata (Mode/UID/GID/ModTime) to
			// reapply — a symlink has no independent content or POSIX
			// metadata of its own worth restoring separately from the link
			// itself.
			if rmErr := os.Remove(localPath); rmErr != nil && !os.IsNotExist(rmErr) {
				warnings = append(warnings, fmt.Sprintf("failed to clear existing path before creating symlink %s: %s", artifact.Name, rmErr.Error()))
				verificationFailed = true
				continue
			}
			if symErr := symlinkFile(artifact.LinkTarget, localPath); symErr != nil {
				warnings = append(warnings, fmt.Sprintf("failed to create symlink %s -> %s: %s", artifact.Name, artifact.LinkTarget, symErr.Error()))
				verificationFailed = true
				continue
			}
			continue
		}

		remoteKey := path.Join(snapshotRootDir, cfg.SnapshotID, systemStatePath, artifact.Path)
		if dlErr := provider.Download(remoteKey, localPath); dlErr != nil {
			warnings = append(warnings, fmt.Sprintf("failed to download %s: %s", artifact.Name, dlErr.Error()))
			verificationFailed = true
			continue
		}
		if verifyErr := verifyArtifactIntegrity(localPath, artifact); verifyErr != nil {
			warnings = append(warnings, fmt.Sprintf("artifact %s failed verification, discarding: %s", artifact.Name, verifyErr.Error()))
			_ = os.Remove(localPath)
			verificationFailed = true
			continue
		}
		if artifact.Checksum == "" {
			// Older manifest (schemaVersion 0) or a collection-time hashing
			// failure — accept it best-effort but flag it, per plan §2/B1c.
			warnings = append(warnings, fmt.Sprintf("artifact %s has no checksum (older manifest schema), unverified", artifact.Name))
		}
		warnings = append(warnings, applyArtifactMetadata(localPath, artifact)...)
	}

	// Capture the Linux enabled-services list from staging BEFORE it's
	// removed (the defer above fires when this function returns) — Validate
	// runs later, in RunRecoveryContext step 4, well after this staging dir
	// is gone.
	serviceUnits := enabledSystemdUnitsFromStaging(stagingDir)

	// Apply system state via platform-specific restorer.
	restorer := newRestorerFunc()
	if restoreErr := restorer.RestoreSystemState(stagingDir); restoreErr != nil {
		return systemStateResult{
			manifestFound: true,
			warnings:      warnings,
			err:           fmt.Errorf("bmr: restore system state: %w", restoreErr),
			serviceUnits:  serviceUnits,
		}
	}

	drivers := 0
	driverDir := filepath.Join(stagingDir, "drivers")
	if info, statErr := os.Stat(driverDir); statErr == nil && info.IsDir() {
		count, dErr := restorer.InjectDrivers(driverDir)
		if dErr != nil {
			warnings = append(warnings, fmt.Sprintf("driver injection errors: %s", dErr.Error()))
		}
		drivers = count
	}

	return systemStateResult{
		applied:       !verificationFailed,
		drivers:       drivers,
		warnings:      warnings,
		manifestFound: true,
		serviceUnits:  serviceUnits,
	}
}

// verifyArtifactIntegrity checks a downloaded system-state artifact against
// the manifest's recorded size and (when present) sha256 checksum. A
// missing Checksum (older manifest schema, or a collection-time hashing
// failure) is NOT an error here — the caller logs an "unverified" warning
// for that case instead; only an actual mismatch fails the artifact.
func verifyArtifactIntegrity(localPath string, artifact systemstate.Artifact) error {
	info, statErr := os.Stat(localPath)
	if statErr != nil {
		return fmt.Errorf("stat downloaded artifact: %w", statErr)
	}
	if artifact.SizeBytes > 0 && info.Size() != artifact.SizeBytes {
		return fmt.Errorf("size mismatch: downloaded %d bytes, manifest says %d", info.Size(), artifact.SizeBytes)
	}
	if artifact.Checksum == "" {
		return nil
	}
	sum, err := sha256HexFile(localPath)
	if err != nil {
		return fmt.Errorf("compute checksum: %w", err)
	}
	if !strings.EqualFold(sum, artifact.Checksum) {
		return fmt.Errorf("checksum mismatch: downloaded %s, manifest says %s", sum, artifact.Checksum)
	}
	return nil
}

// applyArtifactMetadata reapplies a downloaded regular artifact's staged
// mode, ownership, and modification time to localPath — best effort,
// mirroring restoreFiles' post-download fidelity step (chmodFile/
// chtimesFile) for ordinary backed-up files: a failure here (most commonly
// EPERM chowning to a uid/gid this process doesn't have privilege for) is
// recorded as a warning, never folded into verificationFailed, since the
// artifact's BYTES already downloaded and verified fine — only the
// metadata reapply failed. Each field is applied only when non-zero (see
// systemstate.Artifact's Mode/UID/GID/ModTime doc comments: zero means
// "unavailable at collection time or artifact predates this field", not
// "explicitly zero"). Never called for a symlink artifact — see the
// LinkTarget branch in applySystemState's artifact loop, which never
// reaches this function.
func applyArtifactMetadata(localPath string, artifact systemstate.Artifact) []string {
	var warnings []string
	if artifact.Mode != 0 {
		if err := chmodFile(localPath, fileModeFromArtifactMode(artifact.Mode)); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply mode %04o to %s: %s", artifact.Mode, artifact.Name, err.Error()))
		}
	}
	if artifact.UID != 0 || artifact.GID != 0 {
		if err := lchownFile(localPath, artifact.UID, artifact.GID); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply ownership %d:%d to %s: %s", artifact.UID, artifact.GID, artifact.Name, err.Error()))
		}
	}
	if !artifact.ModTime.IsZero() {
		if err := chtimesFile(localPath, artifact.ModTime, artifact.ModTime); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply mtime to %s: %s", artifact.Name, err.Error()))
		}
	}
	return warnings
}

// fileModeFromArtifactMode inverts systemstate.modeFromInfo: it converts
// Artifact.Mode's traditional POSIX st_mode & 07777 encoding (permission
// bits OR'd with setuid/setgid/sticky at their traditional octal positions
// 04000/02000/01000) back into a Go os.FileMode with the corresponding
// os.ModeSetuid/os.ModeSetgid/os.ModeSticky bits set — those live at
// entirely different bit positions in Go's FileMode than in the raw octal
// encoding, so a bare cast would silently drop them. Only os.Chmod (via
// chmodFile) needs this; a raw permission-only cast would restore the file
// world-writable-safe but silently lose a legitimately staged setuid/setgid
// bit (e.g. /usr/bin/sudo, ping) on every BMR restore.
func fileModeFromArtifactMode(raw uint32) os.FileMode {
	fm := os.FileMode(raw & 0o777)
	if raw&0o4000 != 0 {
		fm |= os.ModeSetuid
	}
	if raw&0o2000 != 0 {
		fm |= os.ModeSetgid
	}
	if raw&0o1000 != 0 {
		fm |= os.ModeSticky
	}
	return fm
}

func sha256HexFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	// Read-only handle: nothing buffered to lose, so a Close failure here
	// (already-closed fd, or a similarly benign race) is not worth
	// propagating — discard explicitly rather than leaving it unchecked
	// (mirrors systemstate.sha256File's identical seam).
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// intersectStrings returns the elements common to both a and b (order
// follows a), used by the required-step gate above.
func intersectStrings(a, b []string) []string {
	set := make(map[string]bool, len(b))
	for _, s := range b {
		set[s] = true
	}
	var out []string
	for _, s := range a {
		if set[s] {
			out = append(out, s)
		}
	}
	return out
}

// subtractStrings returns the elements of a not present in b (order follows
// a), used to separate "incomplete but not required" steps from the
// required-step gate above.
func subtractStrings(a, b []string) []string {
	set := make(map[string]bool, len(b))
	for _, s := range b {
		set[s] = true
	}
	var out []string
	for _, s := range a {
		if !set[s] {
			out = append(out, s)
		}
	}
	return out
}

func restoreFiles(
	ctx context.Context,
	manifest *snapshotManifest,
	cfg RecoveryConfig,
	provider providers.BackupProvider,
) (filesRestored int, bytesRestored int64, warnings []string, failedFiles int, err error) {
	// consecutiveFailures tracks the current run of back-to-back per-file
	// download/write failures for the circuit breaker below. Any
	// successful file restore resets it to zero.
	consecutiveFailures := 0

	// addFailure records a per-file failure. It always increments
	// failedFiles (the true count, reported via RecoveryResult.FailedFiles)
	// and consecutiveFailures (the circuit breaker's counter), but stops
	// appending individual warning strings once maxRecoveryWarnings is
	// reached — see the const's doc comment (D14).
	addFailure := func(format string, args ...any) {
		failedFiles++
		consecutiveFailures++
		if len(warnings) < maxRecoveryWarnings {
			warnings = append(warnings, fmt.Sprintf(format, args...))
		}
	}

	// addFidelityFailure records a post-restore metadata (chmod/chtimes)
	// failure. Unlike addFailure, it does NOT increment failedFiles or
	// consecutiveFailures: the file's bytes were already downloaded and
	// verified successfully, only the permission/mtime reapply failed, so
	// this is neither a restore failure nor grounds to trip the circuit
	// breaker. It still shares the same maxRecoveryWarnings cap on
	// individual warning strings (D14) — a systematic chmod/chtimes failure
	// (e.g. a read-only restore target) must not blow past the API's
	// warnings size limit any more than a wave of download failures may.
	fidelityFailures := 0
	addFidelityFailure := func(format string, args ...any) {
		fidelityFailures++
		if len(warnings) < maxRecoveryWarnings {
			warnings = append(warnings, fmt.Sprintf(format, args...))
		}
	}

	breakerTripped := false
	for _, file := range manifest.Files {
		if ctx != nil && ctx.Err() != nil {
			if filesRestored > 0 {
				return filesRestored, bytesRestored, warnings, failedFiles, nil
			}
			return filesRestored, bytesRestored, warnings, failedFiles, ctx.Err()
		}
		// TargetPaths overrides are keyed by the ORIGINAL path (see
		// RecoveryConfig.TargetPaths's doc comment: "original -> target
		// path overrides") — under VSS, file.SourcePath is a per-run
		// shadow-copy device path a caller would never know to key an
		// override by (D8).
		origPath := restoreSourcePath(file)
		targetPath := origPath
		if override, ok := cfg.TargetPaths[origPath]; ok {
			targetPath = override
		}

		dir := filepath.Dir(targetPath)
		if mkErr := os.MkdirAll(dir, 0o750); mkErr != nil {
			addFailure("mkdir failed for %s: %s", dir, mkErr.Error())
			if consecutiveFailures >= maxConsecutiveDownloadFailures {
				breakerTripped = true
				break
			}
			continue
		}

		if dlErr := provider.Download(file.BackupPath, targetPath); dlErr != nil {
			addFailure("restore failed for %s: %s", file.SourcePath, dlErr.Error())
			if consecutiveFailures >= maxConsecutiveDownloadFailures {
				breakerTripped = true
				break
			}
			continue
		}
		consecutiveFailures = 0
		if ctx != nil && ctx.Err() != nil {
			return filesRestored, bytesRestored, warnings, failedFiles, nil
		}

		// Reapply the manifest's captured mode + mtime, best-effort — exactly
		// like restore.go's post-restore fidelity step (~:241). A
		// chmod/chtimes failure must not fail an otherwise-good restore, but
		// IS surfaced in warnings so the caller knows fidelity was partial.
		// Mode==0 / a zero ModTime means "unknown" (pre-fidelity manifest) →
		// leave the OS default (O20).
		if file.Mode != 0 {
			if chmodErr := chmodFile(targetPath, os.FileMode(file.Mode).Perm()); chmodErr != nil {
				addFidelityFailure("could not reapply mode %o to %s: %s", os.FileMode(file.Mode).Perm(), origPath, chmodErr.Error())
				slog.Warn("bmr: failed to reapply file mode on restore",
					"target", targetPath, "mode", file.Mode, "error", chmodErr.Error())
			}
		}
		if !file.ModTime.IsZero() {
			if chtimesErr := chtimesFile(targetPath, file.ModTime, file.ModTime); chtimesErr != nil {
				addFidelityFailure("could not reapply mtime to %s: %s", origPath, chtimesErr.Error())
				slog.Warn("bmr: failed to reapply mtime on restore",
					"target", targetPath, "error", chtimesErr.Error())
			}
		}

		filesRestored++
		bytesRestored += file.Size
	}

	if breakerTripped {
		skipped := len(manifest.Files) - filesRestored - failedFiles
		if len(warnings) < maxRecoveryWarnings {
			warnings = append(warnings, fmt.Sprintf(
				"aborting after %d consecutive file failures; %d files not attempted",
				maxConsecutiveDownloadFailures, skipped))
		}
	}

	if failedFiles > maxRecoveryWarnings {
		warnings = append(warnings,
			fmt.Sprintf("... and %d more file restore failures", failedFiles-maxRecoveryWarnings))
	}
	if fidelityFailures > maxRecoveryWarnings {
		warnings = append(warnings,
			fmt.Sprintf("... and %d more metadata failures", fidelityFailures-maxRecoveryWarnings))
	}

	if breakerTripped {
		return filesRestored, bytesRestored, warnings, failedFiles,
			fmt.Errorf("bmr: aborted after %d consecutive file failures (%d of %d files restored)",
				maxConsecutiveDownloadFailures, filesRestored, len(manifest.Files))
	}

	if filesRestored == 0 && len(manifest.Files) > 0 {
		return 0, 0, warnings, failedFiles, fmt.Errorf("bmr: all %d files failed to restore", len(manifest.Files))
	}
	if filesRestored < len(manifest.Files) {
		return filesRestored, bytesRestored, warnings, failedFiles,
			fmt.Errorf("bmr: %d of %d files failed to restore", len(manifest.Files)-filesRestored, len(manifest.Files))
	}
	return filesRestored, bytesRestored, warnings, failedFiles, nil
}

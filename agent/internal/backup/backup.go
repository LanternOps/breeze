// Package backup provides backup orchestration for the Breeze agent.
package backup

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/backup/vss"
)

const (
	jobStatusRunning   = "running"
	jobStatusCompleted = "completed"
	jobStatusFailed    = "failed"
	jobStatusSkipped   = "skipped"
	jobStatusStopped   = "stopped"
)

var errBackupStopped = errors.New("backup stopped")

// collectSystemState is a seam over systemstate.CollectSystemState so tests can
// exercise the failure and partial-collection paths deterministically — the
// real collector shells out to OS tools and succeeds on any CI host, which
// would otherwise leave the system-state fail-loud/warning branches uncovered.
var collectSystemState = systemstate.CollectSystemState

// BackupConfig defines backup configuration settings.
type BackupConfig struct {
	Provider           providers.BackupProvider
	Paths              []string
	Excludes           []string // Glob exclusion patterns for file-mode backups (see excludeMatcher)
	Retention          int
	VSSEnabled         bool   // Windows only: create VSS shadow copy before backup
	SystemStateEnabled bool   // Collect system state alongside file backup
	StagingDir         string // Base directory for temporary staging (empty = OS temp dir)
}

// BackupJob tracks the state of a backup run.
// JSON tags matter: this struct is serialized into the backup command result's
// `stdout`, and both the server (backupCommandResultSchema / applyBackupCommandResultToJob)
// and the agent's own autoSyncToVault read camelCase fields (`snapshot`,
// `bytesBackedUp`, `filesBackedUp`). Without tags Go emits PascalCase and the
// server can't record snapshot id / size (total_size stays null).
type BackupJob struct {
	ID            string    `json:"id"`
	StartedAt     time.Time `json:"startedAt"`
	CompletedAt   time.Time `json:"completedAt"`
	Snapshot      *Snapshot `json:"snapshot"`
	FilesBackedUp int       `json:"filesBackedUp"`
	BytesBackedUp int64     `json:"bytesBackedUp"`
	Status        string    `json:"status"`
	// Error is the agent's internal failure record. It is NOT the wire failure
	// carrier: marshaling a non-nil `error` interface yields `{}`, and the
	// server's backupCommandResultSchema doesn't read an `error` field anyway.
	// On failure RunBackupWithExcludes returns the error separately, marshalResult
	// routes it to the command result's stderr, and the server reads the reason
	// from `result.error || result.stderr` (routes/agentWs.ts). Keep this field
	// for in-process inspection (e.g. autoSyncToVault) only.
	Error error `json:"error,omitempty"`
	// Warning is a non-fatal completion note surfaced to the server (the
	// backupCommandResultSchema `warning` field → the job's errorLog → UI). Used
	// when a run completes but is degraded — e.g. a partial system-state
	// collection where some artifact classes failed — so a partial system_image
	// backup doesn't silently present as a full, restorable capture.
	Warning             string                           `json:"warning,omitempty"`
	VSSMetadata         *vss.VSSMetadata                 `json:"vssMetadata,omitempty"`         // nil when VSS was not used
	SystemStateManifest *systemstate.SystemStateManifest `json:"systemStateManifest,omitempty"` // nil when system state was not collected
}

// BackupManager orchestrates on-demand backups. Backup scheduling is owned by
// the server: the API fans a policy out per selection and dispatches
// backup_run commands, which the helper executes via RunBackupWithExcludes.
// There is deliberately no agent-local scheduler (#2452).
type BackupManager struct {
	config BackupConfig

	mu         sync.Mutex
	jobRunning bool
	jobCancel  context.CancelFunc
	jobDoneCh  chan struct{}
	progressFn ProgressFn
}

// SetProgressFn registers a callback invoked with files/bytes-done-vs-total
// as RunBackupContext's snapshot upload loop progresses (throttled — see
// progressThrottle in snapshot.go). Pass nil to stop reporting. The helper's
// backup_run handler calls this on whichever manager instance actually runs
// the command — including ephemeral payload-built managers — right before
// invoking RunBackupContext, since there is no other reference to a
// long-lived manager for those runs.
func (m *BackupManager) SetProgressFn(fn ProgressFn) {
	m.mu.Lock()
	m.progressFn = fn
	m.mu.Unlock()
}

// NewBackupManager creates a new BackupManager.
func NewBackupManager(config BackupConfig) *BackupManager {
	return &BackupManager{
		config: config,
	}
}

// GetProvider returns the configured backup provider.
func (m *BackupManager) GetProvider() providers.BackupProvider {
	return m.config.Provider
}

// GetPaths returns the configured backup source paths.
func (m *BackupManager) GetPaths() []string {
	return m.config.Paths
}

// GetRetention returns the configured retention count. On the helper's
// backup_run path this is 0: retention is owned by the server, and 0 makes
// DeleteSnapshotContext a no-op so the agent never prunes remote storage.
func (m *BackupManager) GetRetention() int {
	return m.config.Retention
}

// GetStagingDir returns the configured staging base directory, or an empty
// string if none is set (callers should pass "" to os.MkdirTemp to use the
// OS default temp directory).
func (m *BackupManager) GetStagingDir() string {
	return m.config.StagingDir
}

// GetSystemStateEnabled reports whether this manager collects system state
// (system_image mode) alongside/instead of file paths.
func (m *BackupManager) GetSystemStateEnabled() bool {
	return m.config.SystemStateEnabled
}

// GetVSSEnabled reports whether this manager creates a VSS shadow copy
// before a file-mode backup (Windows only; see BackupConfig.VSSEnabled).
func (m *BackupManager) GetVSSEnabled() bool {
	return m.config.VSSEnabled
}

// Stop cancels an in-flight backup job and waits for it to unwind. It reports
// whether a job was actually running (false = nothing to stop).
func (m *BackupManager) Stop() bool {
	m.mu.Lock()
	if !m.jobRunning {
		m.mu.Unlock()
		return false
	}
	jobCancel := m.jobCancel
	jobDoneCh := m.jobDoneCh
	m.mu.Unlock()

	log.Printf("[backup] stopping backup manager")
	if jobCancel != nil {
		jobCancel()
	}
	if jobDoneCh != nil {
		<-jobDoneCh
	}
	m.mu.Lock()
	if m.jobDoneCh == jobDoneCh {
		m.jobCancel = nil
		m.jobDoneCh = nil
	}
	m.mu.Unlock()
	log.Printf("[backup] backup manager stopped")
	return true
}

// RunBackup triggers an immediate backup run using the configured exclusion
// patterns.
func (m *BackupManager) RunBackup() (*BackupJob, error) {
	return m.RunBackupWithExcludes(nil)
}

// RunBackupWithExcludes triggers an immediate backup run. A non-nil excludes
// slice overrides the configured exclusion patterns for this run only (an
// empty non-nil slice disables exclusions); nil falls back to the config
// excludes. Server-dispatched backup_run commands pass their policy excludes
// here (#2418). It delegates to RunBackupContext with a background context
// (no external cancellation source, same as before RunBackupContext existed).
func (m *BackupManager) RunBackupWithExcludes(excludes []string) (*BackupJob, error) {
	return m.RunBackupContext(context.Background(), excludes)
}

// RunBackupContext is identical to RunBackupWithExcludes except the run's
// internal context is derived from the caller-supplied ctx (via
// context.WithCancel) instead of context.Background(). This lets an external
// cancellation source — e.g. the breeze-backup helper's commandCanceller,
// tracking a server-dispatched backup_run's commandID — abort an in-flight
// run the same way Stop() does, even for ephemeral per-command managers that
// never go through Stop() (#2452 follow-up: backup_stop must actually cancel
// payload-manager runs, not just agent.yaml-manager runs).
func (m *BackupManager) RunBackupContext(ctx context.Context, excludes []string) (*BackupJob, error) {
	if excludes == nil {
		excludes = m.config.Excludes
	}
	if m.config.Provider == nil {
		return nil, errors.New("backup provider is required")
	}
	// A system-state-only run (system_image mode) legitimately has no file
	// paths — the collected system-state staging dir is appended to
	// backupPaths below and becomes the entire snapshot. Only require file
	// paths when system-state collection is off.
	if len(m.config.Paths) == 0 && !m.config.SystemStateEnabled {
		return nil, errors.New("backup paths are required")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	m.mu.Lock()
	if m.jobRunning {
		m.mu.Unlock()
		return nil, errors.New("backup already running")
	}
	m.jobRunning = true
	runCtx, cancel := context.WithCancel(ctx)
	jobDoneCh := make(chan struct{})
	m.jobCancel = cancel
	m.jobDoneCh = jobDoneCh
	m.mu.Unlock()
	defer func() {
		cancel()
		close(jobDoneCh)
		m.mu.Lock()
		if m.jobDoneCh == jobDoneCh {
			m.jobCancel = nil
			m.jobDoneCh = nil
		}
		m.jobRunning = false
		m.mu.Unlock()
	}()

	job := &BackupJob{
		ID:        newJobID(),
		StartedAt: time.Now().UTC(),
		Status:    jobStatusRunning,
	}
	backupPaths := append([]string(nil), m.config.Paths...)
	stopBackupRun := func() (*BackupJob, error) {
		job.Status = jobStatusStopped
		job.CompletedAt = time.Now().UTC()
		job.Error = errBackupStopped
		return job, errBackupStopped
	}

	// VSS: create shadow copy on Windows for application-consistent backup
	var vssSession *vss.VSSSession
	if m.config.VSSEnabled && runtime.GOOS == "windows" {
		if err := runCtx.Err(); err != nil {
			return stopBackupRun()
		}
		vssStart := time.Now()
		provider := vss.NewProvider(vss.DefaultConfig())
		vssCtx, cancel := context.WithTimeout(runCtx, 10*time.Minute)
		session, vssErr := provider.CreateShadowCopy(vssCtx, extractVolumes(m.config.Paths))
		cancel()
		if vssErr != nil {
			log.Printf("[backup] VSS shadow copy failed, proceeding without VSS: %v", vssErr)
		} else {
			vssSession = session
			job.VSSMetadata = &vss.VSSMetadata{
				ShadowCopyID: session.ID,
				CreationTime: session.CreatedAt,
				Writers:      session.Writers,
				ExposedPaths: session.ShadowPaths,
				Warnings:     session.Warnings,
				DurationMs:   time.Since(vssStart).Milliseconds(),
			}
			if len(session.Warnings) > 0 {
				log.Printf("[backup] VSS completed with %d warning(s): %v", len(session.Warnings), session.Warnings)
			}
			defer func() {
				if releaseErr := provider.ReleaseShadowCopy(session); releaseErr != nil {
					log.Printf("[backup] failed to release VSS shadow copy: %v", releaseErr)
				}
			}()
		}
	}

	// System state collection: gather OS config, hardware profile, etc.
	var systemStateErr error
	if m.config.SystemStateEnabled {
		if err := runCtx.Err(); err != nil {
			return stopBackupRun()
		}
		manifest, stagingDir, ssErr := collectSystemState()
		if ssErr != nil {
			systemStateErr = ssErr
			log.Printf("[backup] system state collection failed, proceeding without: %v", ssErr)
		} else {
			job.SystemStateManifest = manifest
			// Collection succeeded on all *required* artifacts (missing a
			// required class returns an error above and fails the run). Any
			// remaining incomplete steps are best-effort classes (certs, iis,
			// ...) — surface them as a completion warning so a degraded capture
			// is visible without discarding an otherwise-usable backup.
			if len(manifest.IncompleteSteps) > 0 {
				job.Warning = fmt.Sprintf("system state collection incomplete: %v failed", manifest.IncompleteSteps)
				log.Printf("[backup] %s", job.Warning)
			}
			// Append staging dir to backup paths so artifacts are included in snapshot
			backupPaths = append(backupPaths, stagingDir)
			defer func() {
				if removeErr := os.RemoveAll(stagingDir); removeErr != nil {
					log.Printf("[backup] failed to clean up system state staging dir: %v", removeErr)
				}
			}()
		}
	}

	// Rewrite paths to shadow copy device paths when VSS is active
	if vssSession != nil {
		backupPaths = rewritePathsForVSS(backupPaths, vssSession.ShadowPaths)
	}

	if err := runCtx.Err(); err != nil {
		return stopBackupRun()
	}
	files, scanErr := m.collectBackupFilesFromPaths(runCtx, backupPaths, newExcludeMatcher(excludes))
	if scanErr != nil {
		if errors.Is(scanErr, errBackupStopped) {
			return stopBackupRun()
		}
		log.Printf("[backup] backup file scan completed with errors: %v", scanErr)
	}
	if vssSession != nil {
		// Recover the pre-VSS-rewrite path for each file so the checkpoint
		// journal has a stable resume key — see originalPathsForVSS and the
		// backupFile.originalPath doc comment.
		originalPathsForVSS(files, vssSession.ShadowPaths)
	}
	if len(files) == 0 {
		if err := runCtx.Err(); err != nil {
			return stopBackupRun()
		}
		// A system-state-only run (no configured file paths) that produced
		// nothing is a hard failure, not a no-op skip: there are no files to
		// fall back on, so a green empty snapshot would silently protect
		// nothing. Surface the collection error (or a synthetic one).
		if m.config.SystemStateEnabled && len(m.config.Paths) == 0 {
			runErr := systemStateErr
			if runErr == nil {
				runErr = errors.New("system state collection produced no artifacts")
			}
			job.Status = jobStatusFailed
			job.CompletedAt = time.Now().UTC()
			job.Error = errors.Join(scanErr, runErr)
			return job, job.Error
		}
		job.Status = jobStatusSkipped
		job.CompletedAt = time.Now().UTC()
		job.Error = scanErr
		return job, scanErr
	}

	m.mu.Lock()
	progressFn := m.progressFn
	m.mu.Unlock()
	if progressFn != nil {
		var bytesTotal int64
		for _, f := range files {
			bytesTotal += f.size
		}
		// Initial "scanning done" notice: totals are now known even though
		// nothing has uploaded yet, so the server learns the run's scope
		// before the (throttled) per-file progress calls start arriving.
		progressFn(0, len(files), 0, bytesTotal)
	}

	// Checkpoint journal: keyed by destination identity (provider kind +
	// endpoint/bucket/path + the *configured* source paths — never the
	// VSS-rewritten or system-state-staging paths in backupPaths, which are
	// ephemeral per run and would defeat identity matching across runs).
	// journalDir falls back to the OS temp dir when no staging dir is
	// configured, same as every other staging fallback in this package.
	journalDir := m.GetStagingDir()
	if journalDir == "" {
		journalDir = os.TempDir()
	}
	journal, resumedJournal, journalErr := openSnapshotJournal(journalDir, backupIdentity(m.config.Provider, m.config.Paths), journalMaxAge)
	if journalErr != nil {
		// A journal is a best-effort checkpoint, never a correctness
		// requirement: degrade to a journal-less run rather than failing
		// the backup over it.
		log.Printf("[backup] failed to open checkpoint journal, proceeding without resume support: %v", journalErr)
		journal = nil
	}
	if journal != nil {
		if staleID, ok := journal.StaleSnapshotID(); ok {
			// StaleSnapshotID covers both an actually-stale (>journalMaxAge)
			// journal and the (near-impossible) identity-mismatch case — see
			// openSnapshotJournal — so the message below is deliberately
			// generic rather than claiming a specific cause.
			log.Printf("[backup] discarding unusable checkpoint journal (snapshot %s, older than %s or identity-mismatched), cleaning up its remote prefix",
				staleID, journalMaxAge)
			cleanupSnapshotPrefix(m.config.Provider, staleID)
		}
		if resumedJournal {
			log.Printf("[backup] resuming interrupted backup: journal snapshot %s (%d bytes already uploaded)",
				journal.snapshotID, journal.ResumedBytes())
		}
	}

	snapshot, snapErr := createSnapshotWithProgress(runCtx, m.config.Provider, files, progressFn, journal)
	if errors.Is(snapErr, errBackupStopped) {
		return stopBackupRun()
	}
	job.CompletedAt = time.Now().UTC()
	job.Snapshot = snapshot
	if snapshot != nil {
		job.FilesBackedUp = len(snapshot.Files)
		job.BytesBackedUp = snapshot.Size
	}

	retentionErr := error(nil)
	if err := runCtx.Err(); err != nil {
		return stopBackupRun()
	}
	if snapshot != nil && m.config.Retention > 0 {
		retentionErr = DeleteSnapshotContext(runCtx, m.config.Provider, m.config.Retention)
		if retentionErr != nil {
			if errors.Is(retentionErr, errBackupStopped) {
				return stopBackupRun()
			}
			log.Printf("[backup] failed to enforce snapshot retention: %v", retentionErr)
		}
	}

	if snapErr != nil {
		if errors.Is(snapErr, errBackupStopped) {
			return stopBackupRun()
		}
		combinedErr := errors.Join(scanErr, snapErr)
		job.Status = jobStatusFailed
		job.Error = combinedErr
		return job, combinedErr
	}

	job.Status = jobStatusCompleted
	job.Error = errors.Join(scanErr, retentionErr)
	return job, nil
}

type backupFile struct {
	sourcePath   string
	snapshotPath string
	size         int64
	modTime      time.Time
	mode         os.FileMode
	// originalPath is sourcePath reconstructed back through a VSS shadow-copy
	// rewrite (see rewritePathsForVSS / originalPathsForVSS), i.e. the real
	// on-disk path the user configured. Empty when VSS is off or this file
	// wasn't under a rewritten root — sourcePath IS already stable in that
	// case. This exists solely so the checkpoint journal has a stable resume
	// key: sourcePath itself is per-run-ephemeral under VSS (a fresh shadow
	// copy device path every run), so keying the journal on it would make
	// resume silently never match on Windows-with-VSS.
	originalPath string
}

func (m *BackupManager) collectBackupFiles() ([]backupFile, error) {
	return m.collectBackupFilesFromPaths(context.Background(), m.config.Paths, newExcludeMatcher(m.config.Excludes))
}

func (m *BackupManager) collectBackupFilesFromPaths(ctx context.Context, paths []string, excl *excludeMatcher) ([]backupFile, error) {
	var files []backupFile
	var errs []error
	seen := make(map[string]struct{})

	for idx, root := range paths {
		if err := ctx.Err(); err != nil {
			return files, errBackupStopped
		}
		if root == "" {
			errs = append(errs, fmt.Errorf("backup path at index %d is empty", idx))
			continue
		}
		cleanRoot := filepath.Clean(root)
		info, err := os.Stat(cleanRoot)
		if err != nil {
			errs = append(errs, fmt.Errorf("failed to stat backup path %s: %w", cleanRoot, err))
			continue
		}

		rootLabel := fmt.Sprintf("path_%d", idx)
		if !info.IsDir() {
			if !info.Mode().IsRegular() {
				continue
			}
			relPath := filepath.Base(cleanRoot)
			if excl.matches(relPath) {
				continue
			}
			snapshotPath := filepath.ToSlash(filepath.Join(rootLabel, relPath))
			if _, exists := seen[snapshotPath]; exists {
				log.Printf("[backup] duplicate backup path skipped: %s", snapshotPath)
				continue
			}
			seen[snapshotPath] = struct{}{}
			files = append(files, backupFile{
				sourcePath:   cleanRoot,
				snapshotPath: snapshotPath,
				size:         info.Size(),
				modTime:      info.ModTime(),
				mode:         info.Mode(),
			})
			continue
		}

		err = filepath.WalkDir(cleanRoot, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return errBackupStopped
			}
			if walkErr != nil {
				errs = append(errs, fmt.Errorf("walk error for %s: %w", path, walkErr))
				return nil
			}
			if entry.IsDir() {
				// An excluded directory is skipped entirely (fs.SkipDir), not
				// just its immediate files (#2418).
				if excl != nil && path != cleanRoot {
					relPath, relErr := filepath.Rel(cleanRoot, path)
					if relErr == nil && excl.matches(filepath.ToSlash(relPath)) {
						return fs.SkipDir
					}
				}
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				errs = append(errs, fmt.Errorf("failed to read info for %s: %w", path, err))
				return nil
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			relPath, err := filepath.Rel(cleanRoot, path)
			if err != nil {
				errs = append(errs, fmt.Errorf("failed to resolve relative path for %s: %w", path, err))
				return nil
			}
			if excl.matches(filepath.ToSlash(relPath)) {
				return nil
			}
			snapshotPath := filepath.ToSlash(filepath.Join(rootLabel, relPath))
			if _, exists := seen[snapshotPath]; exists {
				log.Printf("[backup] duplicate backup path skipped: %s", snapshotPath)
				return nil
			}
			seen[snapshotPath] = struct{}{}
			files = append(files, backupFile{
				sourcePath:   path,
				snapshotPath: snapshotPath,
				size:         info.Size(),
				modTime:      info.ModTime(),
				mode:         info.Mode(),
			})
			return nil
		})
		if err != nil {
			if errors.Is(err, errBackupStopped) {
				return files, errBackupStopped
			}
			errs = append(errs, fmt.Errorf("backup walk failed for %s: %w", cleanRoot, err))
		}
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].snapshotPath < files[j].snapshotPath
	})

	if len(files) == 0 && len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return files, errors.Join(errs...)
}

// extractVolumes returns unique volume roots from a list of paths.
// e.g., ["C:\\Users\\data", "C:\\Logs", "D:\\Backups"] -> ["C:", "D:"]
func extractVolumes(paths []string) []string {
	seen := make(map[string]struct{})
	var volumes []string
	for _, p := range paths {
		vol := filepath.VolumeName(p)
		if vol == "" {
			continue
		}
		if _, ok := seen[vol]; !ok {
			seen[vol] = struct{}{}
			volumes = append(volumes, vol)
		}
	}
	return volumes
}

// rewritePathsForVSS rewrites source paths to use VSS shadow copy device paths.
// e.g., "C:\\Users\\data" with shadow "C:" -> "\\\\?\\GLOBALROOT\\...\\Users\\data"
func rewritePathsForVSS(paths []string, shadowPaths map[string]string) []string {
	rewritten := make([]string, len(paths))
	for i, p := range paths {
		vol := filepath.VolumeName(p)
		if shadow, ok := shadowPaths[vol]; ok {
			rest := p[len(vol):]
			rewritten[i] = shadow + rest
		} else {
			rewritten[i] = p // fallback: use original path
		}
	}
	return rewritten
}

// originalPathsForVSS sets backupFile.originalPath for every file whose
// sourcePath was rewritten to a VSS shadow-copy device path by
// rewritePathsForVSS, by inverting shadowPaths (volume -> shadow root) into
// shadow root -> volume and substituting the matching prefix back. Files
// whose sourcePath doesn't start with any known shadow root are left with
// an empty originalPath — rewritePathsForVSS's own fallback means their
// sourcePath was never rewritten in the first place, so it's already
// stable and originalPath would be redundant.
//
// A no-op (files left untouched) when shadowPaths is empty, i.e. VSS is
// off — the normal case and the only one on non-Windows.
func originalPathsForVSS(files []backupFile, shadowPaths map[string]string) {
	if len(shadowPaths) == 0 {
		return
	}
	shadowToVolume := make(map[string]string, len(shadowPaths))
	for vol, shadow := range shadowPaths {
		if shadow == "" {
			continue
		}
		shadowToVolume[shadow] = vol
	}
	for i := range files {
		p := files[i].sourcePath
		for shadow, vol := range shadowToVolume {
			if p == shadow {
				files[i].originalPath = vol
				break
			}
			if strings.HasPrefix(p, shadow+string(filepath.Separator)) {
				files[i].originalPath = vol + p[len(shadow):]
				break
			}
		}
	}
}

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
	ID                  string                           `json:"id"`
	StartedAt           time.Time                        `json:"startedAt"`
	CompletedAt         time.Time                        `json:"completedAt"`
	Snapshot            *Snapshot                        `json:"snapshot"`
	FilesBackedUp       int                              `json:"filesBackedUp"`
	BytesBackedUp       int64                            `json:"bytesBackedUp"`
	Status              string                           `json:"status"`
	// Error is the agent's internal failure record. It is NOT the wire failure
	// carrier: marshaling a non-nil `error` interface yields `{}`, and the
	// server's backupCommandResultSchema doesn't read an `error` field anyway.
	// On failure RunBackupWithExcludes returns the error separately, marshalResult
	// routes it to the command result's stderr, and the server reads the reason
	// from `result.error || result.stderr` (routes/agentWs.ts). Keep this field
	// for in-process inspection (e.g. autoSyncToVault) only.
	Error               error                            `json:"error,omitempty"`
	VSSMetadata         *vss.VSSMetadata                 `json:"vssMetadata,omitempty"`         // nil when VSS was not used
	SystemStateManifest *systemstate.SystemStateManifest `json:"systemStateManifest,omitempty"` // nil when system state was not collected
}

// BackupManager orchestrates on-demand backups. Backup scheduling is owned by
// the server: the API fans a policy out per selection and dispatches
// backup_run commands, which the helper executes via RunBackupWithExcludes.
// There is deliberately no agent-local scheduler (#2452).
type BackupManager struct {
	config BackupConfig

	mu               sync.Mutex
	jobRunning       bool
	jobCancel        context.CancelFunc
	jobDoneCh        chan struct{}
	lastSnapshotTime time.Time
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
// here (#2418).
func (m *BackupManager) RunBackupWithExcludes(excludes []string) (*BackupJob, error) {
	if excludes == nil {
		excludes = m.config.Excludes
	}
	if m.config.Provider == nil {
		return nil, errors.New("backup provider is required")
	}
	if len(m.config.Paths) == 0 {
		return nil, errors.New("backup paths are required")
	}

	m.mu.Lock()
	if m.jobRunning {
		m.mu.Unlock()
		return nil, errors.New("backup already running")
	}
	m.jobRunning = true
	ctx, cancel := context.WithCancel(context.Background())
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
		if err := ctx.Err(); err != nil {
			return stopBackupRun()
		}
		vssStart := time.Now()
		provider := vss.NewProvider(vss.DefaultConfig())
		vssCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
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
	if m.config.SystemStateEnabled {
		if err := ctx.Err(); err != nil {
			return stopBackupRun()
		}
		manifest, stagingDir, ssErr := systemstate.CollectSystemState()
		if ssErr != nil {
			log.Printf("[backup] system state collection failed, proceeding without: %v", ssErr)
		} else {
			job.SystemStateManifest = manifest
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

	if err := ctx.Err(); err != nil {
		return stopBackupRun()
	}
	cutoff := m.lastSnapshotTime
	files, scanErr := m.collectBackupFilesFromPaths(ctx, backupPaths, cutoff, newExcludeMatcher(excludes))
	if scanErr != nil {
		if errors.Is(scanErr, errBackupStopped) {
			return stopBackupRun()
		}
		log.Printf("[backup] backup file scan completed with errors: %v", scanErr)
	}
	if len(files) == 0 {
		if err := ctx.Err(); err != nil {
			return stopBackupRun()
		}
		job.Status = jobStatusSkipped
		job.CompletedAt = time.Now().UTC()
		job.Error = scanErr
		return job, scanErr
	}

	snapshot, snapErr := CreateSnapshotContext(ctx, m.config.Provider, files)
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
	if err := ctx.Err(); err != nil {
		return stopBackupRun()
	}
	if snapshot != nil && m.config.Retention > 0 {
		retentionErr = DeleteSnapshotContext(ctx, m.config.Provider, m.config.Retention)
		if retentionErr != nil {
			if errors.Is(retentionErr, errBackupStopped) {
				return stopBackupRun()
			}
			log.Printf("[backup] failed to enforce snapshot retention: %v", retentionErr)
		}
	}

	if snapshot != nil && snapshot.Timestamp.After(m.lastSnapshotTime) {
		m.lastSnapshotTime = snapshot.Timestamp
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
}

func (m *BackupManager) collectBackupFiles(cutoff time.Time) ([]backupFile, error) {
	return m.collectBackupFilesFromPaths(context.Background(), m.config.Paths, cutoff, newExcludeMatcher(m.config.Excludes))
}

func (m *BackupManager) collectBackupFilesFromPaths(ctx context.Context, paths []string, cutoff time.Time, excl *excludeMatcher) ([]backupFile, error) {
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
			if !info.Mode().IsRegular() || !shouldIncludeFile(info.ModTime(), cutoff) {
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
			if !info.Mode().IsRegular() || !shouldIncludeFile(info.ModTime(), cutoff) {
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

func shouldIncludeFile(modTime, cutoff time.Time) bool {
	if cutoff.IsZero() {
		return true
	}
	return modTime.After(cutoff)
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

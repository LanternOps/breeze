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
)

// BackupConfig defines backup configuration settings.
type BackupConfig struct {
	Provider           providers.BackupProvider
	Paths              []string
	Schedule           time.Duration
	Retention          int
	VSSEnabled         bool   // Windows only: create VSS shadow copy before backup
	SystemStateEnabled bool   // Collect system state alongside file backup
	StagingDir         string // Base directory for temporary staging (empty = OS temp dir)
}

// BackupJob tracks the state of a backup run.
type BackupJob struct {
	ID                   string
	StartedAt            time.Time
	CompletedAt          time.Time
	Snapshot             *Snapshot
	FilesBackedUp        int
	BytesBackedUp        int64
	Status               string
	Error                error
	VSSMetadata          *vss.VSSMetadata                  // nil when VSS was not used
	SystemStateManifest  *systemstate.SystemStateManifest  // nil when system state was not collected
}

// BackupManager orchestrates scheduled and on-demand backups.
type BackupManager struct {
	config BackupConfig

	mu               sync.Mutex
	jobRunning       bool
	schedulerRunning bool
	stopCh           chan struct{}
	doneCh           chan struct{}
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

// GetStagingDir returns the configured staging base directory, or an empty
// string if none is set (callers should pass "" to os.MkdirTemp to use the
// OS default temp directory).
func (m *BackupManager) GetStagingDir() string {
	return m.config.StagingDir
}

// Start begins scheduled backups.
func (m *BackupManager) Start() error {
	if m.config.Provider == nil {
		return errors.New("backup provider is required")
	}
	if m.config.Schedule <= 0 {
		log.Printf("[backup] backup schedule disabled")
		return nil
	}

	m.mu.Lock()
	if m.schedulerRunning {
		m.mu.Unlock()
		return errors.New("backup manager already started")
	}
	m.schedulerRunning = true
	m.stopCh = make(chan struct{})
	m.doneCh = make(chan struct{})
	m.mu.Unlock()

	log.Printf("[backup] starting backup manager (schedule=%v)", m.config.Schedule)
	go m.runScheduler()
	return nil
}

// Stop stops scheduled backups.
func (m *BackupManager) Stop() {
	m.mu.Lock()
	if !m.schedulerRunning {
		m.mu.Unlock()
		return
	}
	stopCh := m.stopCh
	doneCh := m.doneCh
	m.schedulerRunning = false
	m.stopCh = nil
	m.doneCh = nil
	m.mu.Unlock()

	log.Printf("[backup] stopping backup manager")
	close(stopCh)
	<-doneCh
	log.Printf("[backup] backup manager stopped")
}

// RunBackup triggers an immediate backup run.
func (m *BackupManager) RunBackup() (*BackupJob, error) {
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
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.jobRunning = false
		m.mu.Unlock()
	}()

	job := &BackupJob{
		ID:        newJobID(),
		StartedAt: time.Now().UTC(),
		Status:    jobStatusRunning,
	}

	// VSS: create shadow copy on Windows for application-consistent backup
	var vssSession *vss.VSSSession
	if m.config.VSSEnabled && runtime.GOOS == "windows" {
		vssStart := time.Now()
		provider := vss.NewProvider(vss.DefaultConfig())
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		session, vssErr := provider.CreateShadowCopy(ctx, extractVolumes(m.config.Paths))
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
		manifest, stagingDir, ssErr := systemstate.CollectSystemState()
		if ssErr != nil {
			log.Printf("[backup] system state collection failed, proceeding without: %v", ssErr)
		} else {
			job.SystemStateManifest = manifest
			// Append staging dir to backup paths so artifacts are included in snapshot
			m.config.Paths = append(m.config.Paths, stagingDir)
			defer func() {
				if removeErr := os.RemoveAll(stagingDir); removeErr != nil {
					log.Printf("[backup] failed to clean up system state staging dir: %v", removeErr)
				}
			}()
		}
	}

	// Rewrite paths to shadow copy device paths when VSS is active
	backupPaths := m.config.Paths
	if vssSession != nil {
		backupPaths = rewritePathsForVSS(m.config.Paths, vssSession.ShadowPaths)
	}

	cutoff := m.lastSnapshotTime
	files, scanErr := m.collectBackupFilesFromPaths(backupPaths, cutoff)
	if scanErr != nil {
		log.Printf("[backup] backup file scan completed with errors: %v", scanErr)
	}
	if len(files) == 0 {
		job.Status = jobStatusSkipped
		job.CompletedAt = time.Now().UTC()
		job.Error = scanErr
		return job, scanErr
	}

	snapshot, snapErr := CreateSnapshot(m.config.Provider, files)
	job.CompletedAt = time.Now().UTC()
	job.Snapshot = snapshot
	if snapshot != nil {
		job.FilesBackedUp = len(snapshot.Files)
		job.BytesBackedUp = snapshot.Size
	}

	retentionErr := error(nil)
	if snapshot != nil && m.config.Retention > 0 {
		retentionErr = DeleteSnapshot(m.config.Provider, m.config.Retention)
		if retentionErr != nil {
			log.Printf("[backup] failed to enforce snapshot retention: %v", retentionErr)
		}
	}

	if snapshot != nil && snapshot.Timestamp.After(m.lastSnapshotTime) {
		m.lastSnapshotTime = snapshot.Timestamp
	}
	if snapErr != nil {
		combinedErr := errors.Join(scanErr, snapErr)
		job.Status = jobStatusFailed
		job.Error = combinedErr
		return job, combinedErr
	}

	job.Status = jobStatusCompleted
	job.Error = errors.Join(scanErr, retentionErr)
	return job, nil
}

func (m *BackupManager) runScheduler() {
	defer close(m.doneCh)
	if _, err := m.RunBackup(); err != nil {
		log.Printf("[backup] initial scheduled backup failed: %v", err)
	}

	ticker := time.NewTicker(m.config.Schedule)
	defer ticker.Stop()

	for {
		select {
		case <-m.stopCh:
			return
		case <-ticker.C:
			if _, err := m.RunBackup(); err != nil {
				log.Printf("[backup] scheduled backup failed: %v", err)
			}
		}
	}
}

type backupFile struct {
	sourcePath   string
	snapshotPath string
	size         int64
	modTime      time.Time
}

func (m *BackupManager) collectBackupFiles(cutoff time.Time) ([]backupFile, error) {
	return m.collectBackupFilesFromPaths(m.config.Paths, cutoff)
}

func (m *BackupManager) collectBackupFilesFromPaths(paths []string, cutoff time.Time) ([]backupFile, error) {
	var files []backupFile
	var errs []error
	seen := make(map[string]struct{})

	for idx, root := range paths {
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
			if walkErr != nil {
				errs = append(errs, fmt.Errorf("walk error for %s: %w", path, walkErr))
				return nil
			}
			if entry.IsDir() {
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

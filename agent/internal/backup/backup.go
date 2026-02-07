// Package backup provides backup orchestration for the Breeze agent.
package backup

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

const (
	jobStatusRunning   = "running"
	jobStatusCompleted = "completed"
	jobStatusFailed    = "failed"
	jobStatusSkipped   = "skipped"
)

// BackupConfig defines backup configuration settings.
type BackupConfig struct {
	Provider  providers.BackupProvider
	Paths     []string
	Schedule  time.Duration
	Retention int
}

// BackupJob tracks the state of a backup run.
type BackupJob struct {
	ID            string
	StartedAt     time.Time
	CompletedAt   time.Time
	Snapshot      *Snapshot
	FilesBackedUp int
	BytesBackedUp int64
	Status        string
	Error         error
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

	cutoff := m.lastSnapshotTime
	files, scanErr := m.collectBackupFiles(cutoff)
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
	var files []backupFile
	var errs []error
	seen := make(map[string]struct{})

	for idx, root := range m.config.Paths {
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

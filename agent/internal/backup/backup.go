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
	"github.com/breeze-rmm/agent/internal/config"
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
	Warning string `json:"warning,omitempty"`
	// ErrorCount is the number of per-file upload failures in a PARTIALLY
	// successful run (some files uploaded, some skipped/stalled/exhausted).
	// 0 on a clean run. Carried in the command result JSON so the server can
	// persist it to the job's error_count column alongside the Warning text —
	// without it a partial snapshot presents server-side as a green job with
	// zero errors.
	ErrorCount          int                              `json:"errorCount,omitempty"`
	VSSMetadata         *vss.VSSMetadata                 `json:"vssMetadata,omitempty"`         // nil when VSS was not used
	SystemStateManifest *systemstate.SystemStateManifest `json:"systemStateManifest,omitempty"` // nil when system state was not collected
	// ReferencedFiles/ReferencedBytes count how much of FilesBackedUp/
	// BytesBackedUp this run satisfied by referencing an older snapshot's
	// object instead of re-uploading (see decideFile / isReferenceEntry).
	// FilesBackedUp/BytesBackedUp keep their existing meaning — "protected
	// by this snapshot" (total) — these two fields say how much of that
	// total was dedupe savings. Both 0 on a full backup (no previous
	// manifest was usable) or any run predating incremental backups.
	ReferencedFiles int   `json:"referencedFiles,omitempty"`
	ReferencedBytes int64 `json:"referencedBytes,omitempty"`
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

	// Whole-run progress keepalive. The long pre-upload phases below (VSS
	// creation up to 10min, system-state collection, tree walk,
	// previous-manifest download) emit no progress of their own, so the API's
	// stale-progress reaper would treat a healthy job as dead and fail it
	// before the first byte uploads. Capture the callback up front and heartbeat
	// every progressKeepaliveInterval from run start until the upload loop's own
	// live-counter keepalive takes over. Best-effort/fire-and-forget, matching
	// the existing progress sends. The stop func is idempotent and joins the
	// goroutine (no leak); the defer is a safety net for every early return, and
	// it is stopped explicitly before the upload loop so the two keepalives
	// never emit concurrently.
	m.mu.Lock()
	progressFn := m.progressFn
	m.mu.Unlock()
	stopRunKeepalive := startRunKeepalive(runCtx, progressFn)
	defer stopRunKeepalive()

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
	// systemStateStagingDir/systemStateStagingIdx let us recover, after any
	// VSS rewrite below, whichever staging-root value was ACTUALLY walked —
	// see the assignment right after the VSS rewrite for why the raw
	// stagingDir returned here isn't necessarily it.
	var systemStateStagingDir string
	systemStateStagingIdx := -1
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
			systemStateStagingIdx = len(backupPaths)
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
	if systemStateStagingIdx >= 0 && systemStateStagingIdx < len(backupPaths) {
		// The staging dir's OS temp volume commonly coincides with a
		// VSS-shadowed backup volume, so rewritePathsForVSS above may have
		// rewritten it too — capture whichever value was actually walked
		// (this index in the possibly-rewritten backupPaths) rather than
		// the pre-rewrite path from collectSystemState, so
		// markSystemStateFiles below compares against the same sourcePath
		// prefix collectBackupFilesFromPaths actually produced.
		systemStateStagingDir = backupPaths[systemStateStagingIdx]
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
	markSystemStateFiles(files, systemStateStagingDir)
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

	// Previous-manifest fetch for incremental reference decisions (manifest
	// v2). Fail-open: any fetch/parse problem collapses to a loud log line
	// and a full run — dedupe is strictly an optimization and must never
	// fail or block a backup (see previousManifest's doc comment).
	//
	// Skipped entirely for a system-state-only run (no configured file
	// paths): every one of its files is staging-dir and therefore already
	// excluded from reference decisions by markSystemStateFiles above, so
	// there is nothing eligible to dedupe against — the extra remote
	// list+manifest-download would be pure waste.
	var prevSnapshot *Snapshot
	incrementalDedupeActive := !m.config.SystemStateEnabled || len(m.config.Paths) > 0
	if incrementalDedupeActive {
		prev, reason := previousManifest(runCtx, m.config.Provider)
		if prev == nil {
			log.Printf("[backup] running full backup (no reference dedupe): %s", reason)
		} else {
			prevSnapshot = prev
		}
	}

	// Hand off from the whole-run keepalive to the upload loop's own
	// live-counter keepalive: stop it here so the two never emit concurrently
	// (the upload-phase keepalive reports real filesDone/bytesDone, which the
	// whole-run one cannot see). The remaining pre-upload work (journal open,
	// stale-prefix cleanup) is fast local/one-shot I/O, not a reaper concern.
	stopRunKeepalive()

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
	// The journal dir comes from resolveJournalDir: explicit StagingDir, else
	// a root-owned per-user/agent dir — NEVER the world-writable OS temp dir
	// (a deterministic root-owned filename there is a symlink/tamper surface;
	// a forged journal can trigger remote snapshot cleanup or silent file
	// skips). If no secure dir exists, the run simply doesn't journal: resume
	// is an optimization, never worth a world-writable root-owned write.
	var journal *snapshotJournal
	var resumedJournal bool
	if journalDir, ok := resolveJournalDir(m.GetStagingDir()); !ok {
		log.Printf("[backup] no secure checkpoint journal directory available (only the world-writable temp dir); proceeding without resume support")
	} else {
		var journalErr error
		journal, resumedJournal, journalErr = openSnapshotJournal(journalDir, backupIdentity(m.config.Provider, m.config.Paths), journalMaxAge)
		if journalErr != nil {
			// A journal is a best-effort checkpoint, never a correctness
			// requirement: degrade to a journal-less run rather than failing
			// the backup over it.
			log.Printf("[backup] failed to open checkpoint journal, proceeding without resume support: %v", journalErr)
			journal = nil
		}
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

	snapshot, snapErr := createSnapshotWithProgress(runCtx, m.config.Provider, files, progressFn, journal, prevSnapshot)
	if errors.Is(snapErr, errBackupStopped) {
		return stopBackupRun()
	}
	job.CompletedAt = time.Now().UTC()
	job.Snapshot = snapshot
	if snapshot != nil {
		job.FilesBackedUp = len(snapshot.Files)
		job.BytesBackedUp = snapshot.Size
		// Derived purely from the finished manifest (no isRef flag — see
		// isReferenceEntry) rather than a counter threaded out of
		// createSnapshotWithProgress: Snapshot itself must stay clean of any
		// reference-count fields (they're result/wire-only, not manifest
		// content — see BackupJob.ReferencedFiles's doc comment).
		for _, f := range snapshot.Files {
			if isReferenceEntry(f, snapshot.ID) {
				job.ReferencedFiles++
				job.ReferencedBytes += f.Size
			}
		}
	}

	retentionErr := error(nil)
	if err := runCtx.Err(); err != nil {
		return stopBackupRun()
	}
	// Agent-side retention pruning is DISABLED whenever incremental dedupe is
	// active for this run. Incremental is now unconditional (previousManifest is
	// consulted on every file-mode run), and a reference entry carries the
	// ORIGINAL upload's BackupPath forward: an unchanged file's bytes live under
	// the OLDEST snapshot's prefix indefinitely while every newer manifest
	// references back into it. DeleteSnapshotContext deletes an expired
	// snapshot's ENTIRE prefix with ZERO reference-awareness, so pruning the
	// oldest prefix here would strand every retained manifest's references as
	// dangling pointers — an unrestorable backup that only surfaces at restore
	// time. Only a reference-aware GC may prune, and the server is the sole
	// retention authority (dispatched runs pin Retention:0 — see exec_backup.go's
	// server-owns-retention invariant). Reference-aware agent-side pruning for
	// standalone storage reclamation is deliberately deferred: reimplementing
	// mark-and-sweep GC on the agent is out of scope and too risky to one-shot.
	if snapshot != nil && m.config.Retention > 0 && !incrementalDedupeActive {
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

	// Per-file upload failures on a PARTIAL success (some files uploaded,
	// some skipped/stalled/retry-exhausted): the job still completes — the
	// snapshot is real and restorable for what it contains — but the
	// failures must be visible server-side rather than silently swallowed
	// (a green job that is an incomplete restore point). Fold them into
	// Warning (which the server persists to the job's errorLog) and
	// ErrorCount, appending after any earlier system-state warning.
	if snapshot != nil && len(snapshot.UploadFailures) > 0 {
		job.ErrorCount = len(snapshot.UploadFailures)
		failureWarning := summarizeUploadFailures(snapshot.UploadFailures, len(files))
		appendWarning(job, failureWarning)
		log.Printf("[backup] %s", failureWarning)
	}

	// Collection-phase (scan) errors — permission-denied files, walk failures,
	// unreadable stat — are folded into the SAME ErrorCount/Warning summary as
	// upload failures so they're visible on the wire. scanErr is an errors.Join
	// of per-file errors; without this a run that silently skipped hundreds of
	// unreadable files would complete as a GREEN job with errorCount 0, because
	// BackupJob.Error marshals to `{}` and the server never reads it (see the
	// Error field's doc comment). Success path only: on a hard failure scanErr
	// already rides job.Error alongside the fatal error above.
	if scanFailures := flattenJoinedErrors(scanErr); len(scanFailures) > 0 {
		job.ErrorCount += len(scanFailures)
		scanWarning := summarizeScanErrors(scanFailures)
		appendWarning(job, scanWarning)
		log.Printf("[backup] %s", scanWarning)
	}

	job.Status = jobStatusCompleted
	job.Error = errors.Join(scanErr, retentionErr)
	return job, nil
}

// maxUploadFailureDetails caps how many individual per-file error messages
// summarizeUploadFailures includes in a job Warning — the full list can be
// thousands of entries, and the Warning lands in a DB text column and the UI.
const maxUploadFailureDetails = 5

// summarizeUploadFailures renders a partial-success run's per-file upload
// failures as a human-readable Warning fragment:
// "N of M files failed to upload: <first errors> (+K more)".
func summarizeUploadFailures(failures []error, filesTotal int) string {
	if len(failures) == 0 {
		return ""
	}
	details := make([]string, 0, maxUploadFailureDetails)
	for i, err := range failures {
		if i >= maxUploadFailureDetails {
			break
		}
		details = append(details, err.Error())
	}
	summary := fmt.Sprintf("%d of %d files failed to upload: %s",
		len(failures), filesTotal, strings.Join(details, "; "))
	if len(failures) > maxUploadFailureDetails {
		summary += fmt.Sprintf(" (+%d more)", len(failures)-maxUploadFailureDetails)
	}
	return summary
}

// summarizeScanErrors renders a run's collection-phase (scan) failures as a
// human-readable Warning fragment: "N file(s) could not be read during
// collection: <first errors> (+K more)". Detail count is capped the same way
// as summarizeUploadFailures (the full list can be thousands of entries and
// the Warning lands in a DB text column and the UI).
func summarizeScanErrors(failures []error) string {
	if len(failures) == 0 {
		return ""
	}
	details := make([]string, 0, maxUploadFailureDetails)
	for i, err := range failures {
		if i >= maxUploadFailureDetails {
			break
		}
		details = append(details, err.Error())
	}
	summary := fmt.Sprintf("%d file(s) could not be read during collection: %s",
		len(failures), strings.Join(details, "; "))
	if len(failures) > maxUploadFailureDetails {
		summary += fmt.Sprintf(" (+%d more)", len(failures)-maxUploadFailureDetails)
	}
	return summary
}

// flattenJoinedErrors unwraps an errors.Join tree (or a single wrapped error)
// into its individual leaf errors so per-file failures can be counted. Returns
// nil for a nil error. collectBackupFilesFromPaths returns its per-file errors
// as one errors.Join, and this recovers the individual count for ErrorCount.
func flattenJoinedErrors(err error) []error {
	if err == nil {
		return nil
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var out []error
		for _, e := range joined.Unwrap() {
			out = append(out, flattenJoinedErrors(e)...)
		}
		return out
	}
	return []error{err}
}

// appendWarning appends fragment to job.Warning, joining with "; " when the
// job already carries an earlier warning (e.g. a partial system-state note).
func appendWarning(job *BackupJob, fragment string) {
	if fragment == "" {
		return
	}
	if job.Warning != "" {
		job.Warning += "; " + fragment
	} else {
		job.Warning = fragment
	}
}

// startRunKeepalive launches a best-effort heartbeat goroutine that re-emits a
// zero-progress notice via onProgress every progressKeepaliveInterval, covering
// the long pre-upload phases of a run (VSS creation, system-state collection,
// tree walk, previous-manifest download) that emit no progress of their own.
// Without it the API's stale-progress reaper can fail a healthy job before its
// first upload. onProgress==nil yields a no-op stop func. The returned stop
// func is idempotent and joins the goroutine (no leak); callers must stop it
// before the upload loop's own live-counter keepalive begins so the two never
// emit concurrently.
func startRunKeepalive(ctx context.Context, onProgress ProgressFn) (stop func()) {
	if onProgress == nil {
		return func() {}
	}
	ticker := time.NewTicker(progressKeepaliveInterval)
	stopCh := make(chan struct{})
	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		for {
			select {
			case <-stopCh:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				// Totals are unknown until the scan completes; a zero heartbeat
				// exists purely to refresh the server's last_progress_at during
				// the pre-upload phases. filesDone stays 0, so nothing the loop
				// later reports can appear to go backwards.
				onProgress(0, 0, 0, 0)
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			ticker.Stop()
			close(stopCh)
			<-doneCh
		})
	}
}

// journalHomeDirFn/journalDataDirFn are test seams over the secure journal
// dir fallback chain (there is no way to make os.UserHomeDir AND the
// compiled-in config data dir both unavailable from a test otherwise).
var (
	journalHomeDirFn = os.UserHomeDir
	journalDataDirFn = config.GetDataDir
)

// resolveJournalDir returns the directory the checkpoint journal may live in
// and whether journaling is allowed at all. Precedence mirrors the heartbeat
// backup-result outbox's fallback chain (backupResultOutboxDir in
// internal/heartbeat), minus its final temp-dir fallback:
//
//  1. An explicitly configured StagingDir — the operator chose it, use it
//     as-is (openSnapshotJournal creates it 0700 if missing).
//  2. The per-user ~/.breeze dir, then the agent's config data dir — both
//     owned by the invoking user (root/SYSTEM for the helper), not
//     world-writable.
//  3. NOTHING (ok=false): if the only remaining option is os.TempDir(), the
//     run must not journal at all. A deterministic root-owned filename in a
//     world-writable directory is a symlink/tamper surface — a forged
//     journal can trigger remote snapshot cleanup or silent file skips —
//     and resume is an optimization, never worth that trade.
func resolveJournalDir(stagingDir string) (dir string, ok bool) {
	if strings.TrimSpace(stagingDir) != "" {
		return stagingDir, true
	}
	if homeDir, err := journalHomeDirFn(); err == nil && strings.TrimSpace(homeDir) != "" {
		return filepath.Join(homeDir, ".breeze", "backup-journal"), true
	}
	if dataDir := strings.TrimSpace(journalDataDirFn()); dataDir != "" {
		return filepath.Join(dataDir, "backup-journal"), true
	}
	return "", false
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
	// systemState marks a file collected from the run's system-state
	// staging directory (see markSystemStateFiles / collectSystemState's
	// call site in RunBackupContext). decideFile always uploads these —
	// they are never reference candidates, see markSystemStateFiles's doc
	// comment for why this is explicit rather than incidental.
	systemState bool
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

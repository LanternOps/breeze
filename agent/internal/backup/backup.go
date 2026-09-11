// Package backup provides backup orchestration for the Breeze agent.
package backup

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/backup/vss"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

// log is the package logger. Everything in this package used to call stdlib
// log.Printf, which writes raw text to stderr and so bypassed slog, the log
// file and the log shipper entirely — under a Windows service that stderr is
// NUL, which is why a hung backup produced no diagnostics anywhere (#2790).
// Routing through logging.L also tags every line with component=backup so it
// is filterable via the diagnostic-logs API.
var log = logging.L("backup")

const (
	jobStatusRunning   = "running"
	jobStatusCompleted = "completed"
	jobStatusFailed    = "failed"
	jobStatusSkipped   = "skipped"
	jobStatusStopped   = "stopped"
	// jobStatusPartial is a terminal status for a run that produced a real,
	// restorable snapshot but lost a disproportionate share of the work to
	// per-file failures. Distinct from jobStatusFailed on purpose: the
	// snapshot exists and can be restored from, so anything that treats it as
	// "no backup happened" would be wrong. See classifyCompletionStatus.
	jobStatusPartial = "partial"
)

var errBackupStopped = errors.New("backup stopped")

// ErrPublishLeaseExpired is returned when a server-dispatched run (D18
// §3.1) cannot publish its manifest because the server's publish lease
// (BackupConfig.PublishLeaseExpiresAt, minus the 1h publishMargin) expired
// before upload finished. The server treats a late result past lease
// expiry as failed — returning this distinct, unwrapped-comparable error
// lets logs and tests tell it apart from an ordinary publish failure. No
// manifest is uploaded and nothing is deleted: the partial, manifest-less
// prefix is reclaimed by GC's existing manifest-less-prefix rule.
var ErrPublishLeaseExpired = errors.New("backup publish lease expired before manifest could be published")

// ErrJournalExpiredAtPublish is the same fail-closed rule as
// ErrPublishLeaseExpired but keyed on the checkpoint journal's age for a
// RESUMED run: if journalMaxAge has elapsed by the time upload finishes,
// the server can no longer distinguish this manifest from an abandoned
// resume attempt, so publishing is refused.
var ErrJournalExpiredAtPublish = errors.New("checkpoint journal expired before manifest could be published")

// collectSystemState is a seam over systemstate.CollectSystemState so tests can
// exercise the failure and partial-collection paths deterministically — the
// real collector shells out to OS tools and succeeds on any CI host, which
// would otherwise leave the system-state fail-loud/warning branches uncovered.
var collectSystemState = systemstate.CollectSystemState

// collectLayout is the seam over layout.Collect (disk layout for bare-metal
// rebuilds, spec §5.2). Same rationale as collectSystemState above.
var collectLayout = layout.Collect

// BackupConfig defines backup configuration settings.
type BackupConfig struct {
	Provider           providers.BackupProvider
	Paths              []string
	Excludes           []string // Glob exclusion patterns for file-mode backups (see excludeMatcher)
	Retention          int
	VSSEnabled         bool   // Windows only: create VSS shadow copy before backup
	SystemStateEnabled bool   // Collect system state alongside file backup
	StagingDir         string // Base directory for temporary staging (empty = OS temp dir)

	// AgentID identifies the DEVICE this manager is running on, for
	// incremental-dedupe base-snapshot selection (see runBackupIdentity /
	// Snapshot.BackupIdentity). backupIdentity(Provider, Paths) alone
	// distinguishes DESTINATIONS, not devices: two devices backing up to the
	// same bucket with the same configured paths produce the identical
	// string, which is exactly how D6 happened — one device's incremental
	// run picked another device's snapshot as its dedupe base and
	// re-uploaded everything (or worse, would have silently referenced a
	// same-path/size/mtime coincidence as though it were its own data).
	//
	// The caller should populate this from config.Config.AgentID — the
	// agent's enrollment identifier, which is guaranteed non-empty for any
	// enrolled agent (config.IsEnrolled checks AgentID != "") — rather than
	// config.Config.DeviceID, which is left empty on any agent that enrolled
	// before that field existed and never backfills on its own (see its doc
	// comment in internal/config/config.go).
	//
	// Empty (the zero value — e.g. CreateSnapshotContext callers with no
	// manager/device context, or a caller that hasn't wired AgentID through
	// yet) means this run stamps no BackupIdentity onto its own manifest,
	// and previousManifest then refuses to match ANY previous snapshot
	// against it — including one this same process produced earlier under
	// the same empty identity — since an unstamped run cannot prove whose
	// snapshot it is either way. Fail-open to a full backup, the same safe
	// default as every other dedupe failure mode in this package.
	AgentID string

	// AgentVersion is stamped onto a collected system state manifest's
	// CollectorVersion field (see systemstate.SystemStateManifest) so a
	// restore can tell which agent/helper build produced it. The systemstate
	// package itself has no notion of "the agent version" — it collects OS
	// state, not agent identity — so this is wired through BackupConfig the
	// same way AgentID is (see that field's doc comment): the caller
	// populates it from the running binary's version string (e.g. breeze-
	// backup's `version` build var). Empty means the manifest carries no
	// CollectorVersion, e.g. an older caller that hasn't wired this through.
	AgentVersion string

	// VSSProvider overrides where a VSS-enabled run gets its provider from.
	// Nil — the production case, and what every real caller sets — means
	// "use the platform provider", i.e. vss.NewProvider on Windows and no VSS
	// anywhere else. See resolveVSSProvider for the exact resolution.
	//
	// It exists because the snapshot-liveness wiring in RunBackupContext
	// (#3260/#3266: build the shadow-root probe from the live session and hand
	// it to the upload loop) was otherwise unreachable from a test — the only
	// real provider is Windows-only and process-global, so a refactor could
	// drop or misroute that wiring while every liveness unit test still passed
	// and the protection was silently disconnected (#3270).
	//
	// Scoped to the provider ONLY, deliberately. It says nothing about how a
	// session is created, held or released, so the COM-lifetime rewrite of that
	// plumbing (#3269) is free to change the session's shape underneath without
	// touching this field.
	VSSProvider vss.Provider

	// BaseSnapshotID switches this run between server-owned base selection
	// (D18 §3.1) and the legacy bucket-listing previousManifest path. nil
	// means the dispatching server predates the field (legacy mode,
	// unchanged behavior — see exec_backup.go's payload decode). A non-nil
	// pointer to "" means the server explicitly selected no base for this
	// run (full run, no dedupe attempted). A non-nil pointer to a snapshot
	// id means the server selected that snapshot as this run's dedupe base
	// — fetchServerOwnedBase fetches and validates it (D6 identity guard)
	// before use, failing open to a full run on any problem (download
	// error, decode error, or identity mismatch).
	BaseSnapshotID *string

	// PublishLeaseExpiresAt is the deadline (verbatim from the backup_run
	// payload's publishLeaseExpiresAt field) after which this run must not
	// publish snapshots/<id>/manifest.json — see leaseGate. Set for every
	// server-dispatched file/system_image run, base or not (it fences late
	// results server-side too, D18 §3.1). Zero value means the dispatching
	// server predates the field, disabling the check entirely (legacy
	// behavior: publish whenever ready). There is no renewal — this is
	// exactly what the server chose at dispatch time.
	PublishLeaseExpiresAt time.Time
}

// BackupJob tracks the state of a backup run.
// JSON tags matter: this struct is serialized into the backup command result's
// `stdout`, and both the server (backupCommandResultSchema / applyBackupCommandResultToJob)
// and the agent's own autoSyncToVault read camelCase fields (`snapshot`,
// `bytesBackedUp`, `filesBackedUp`). Without tags Go emits PascalCase and the
// server can't record snapshot id / size (total_size stays null).
type BackupJob struct {
	ID          string    `json:"id"`
	StartedAt   time.Time `json:"startedAt"`
	CompletedAt time.Time `json:"completedAt"`
	// Snapshot is nil whenever no snapshot was created — most notably a
	// fail-loud run (D11: e.g. a system-state-only run whose collection
	// errored). `omitempty` is load-bearing, not cosmetic: the API's
	// backupCommandResultSchema models this field as
	// `backupSnapshotResultSchema.optional()` (apps/api/src/routes/backup/
	// resultSchemas.ts), and Zod's `.optional()` accepts a MISSING key but
	// rejects an explicit `null`. Without `omitempty` a failed run's body
	// carries `"snapshot":null`, which 400s the whole result at the API and
	// discards the real failure reason (Stderr/job.Error) the job otherwise
	// carried correctly — see TestBackupJob_FailedRunJSON_OmitsNullSnapshot
	// and TestMarshalBackupRunResultFailedSystemImageRunOmitsNullSnapshot.
	Snapshot      *Snapshot `json:"snapshot,omitempty"`
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
	// LayoutManifest is the disk layout captured for bare-metal rebuilds
	// (snapshots/<id>/layout.json). nil on file-only runs and when capture
	// failed. BareMetal is the guard verdict for that layout; on capture
	// failure it is non-nil with Restorable=false and the error as the reason,
	// so the server never mistakes "unknown" for "restorable".
	LayoutManifest *layout.Manifest      `json:"layoutManifest,omitempty"`
	BareMetal      *layout.Restorability `json:"bareMetal,omitempty"`
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
// GetAgentID returns the device identity stamped into manifests for
// incremental-dedupe base selection (BackupConfig.AgentID).
func (m *BackupManager) GetAgentID() string {
	return m.config.AgentID
}

func (m *BackupManager) GetPaths() []string {
	return m.config.Paths
}

// GetExcludes returns the configured file-exclusion glob patterns
// (BackupConfig.Excludes). RunBackupContext's excludes parameter overrides
// this per-run when non-nil (#2418); this is the config-level fallback.
func (m *BackupManager) GetExcludes() []string {
	return m.config.Excludes
}

// GetRetention returns the configured retention count. It is retained for
// config-shape compatibility only: agent-side retention pruning has been
// removed entirely (D18 §3.5) — the server is the sole retention/GC
// authority. This value drives no behavior anywhere in this package.
func (m *BackupManager) GetRetention() int {
	return m.config.Retention
}

// GetBaseSnapshotID returns the server-selected incremental-dedupe base for
// this run (D18 §3.1): nil in legacy mode, a pointer to "" for an
// explicit full run, a pointer to a snapshot id otherwise.
func (m *BackupManager) GetBaseSnapshotID() *string {
	return m.config.BaseSnapshotID
}

// GetPublishLeaseExpiresAt returns the deadline this run must publish its
// manifest by (zero value = no lease, legacy server).
func (m *BackupManager) GetPublishLeaseExpiresAt() time.Time {
	return m.config.PublishLeaseExpiresAt
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

// resolveVSSProvider decides whether a run takes the VSS path, and with which
// provider. The second return is the whole gate: false means "no shadow copy
// this run" and the caller skips the block entirely.
//
// An injected BackupConfig.VSSProvider bypasses the runtime.GOOS check on
// purpose. That check is not a statement about the platform, it is a statement
// about the only provider that used to be reachable here: vss.NewProvider
// compiles to a stub off Windows, and calling it there would fail every run
// with ErrVSSNotSupported and stamp a spurious "VSS failed" warning onto the
// job. Supplying a provider is the caller asserting it works on this host, so
// re-deriving that answer from GOOS would just make the seam unusable off
// Windows — which is exactly the platform the wiring needs to be testable on.
// Nothing in production sets the field, so the production decision is
// unchanged.
func (m *BackupManager) resolveVSSProvider() (vss.Provider, bool) {
	if !m.config.VSSEnabled {
		return nil, false
	}
	if m.config.VSSProvider != nil {
		return m.config.VSSProvider, true
	}
	if runtime.GOOS != "windows" {
		return nil, false
	}
	return vss.NewProvider(vss.DefaultConfig()), true
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

	log.Info("stopping backup manager")
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
	log.Info("backup manager stopped")
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
	ctx, release, err := AcquireExecution(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
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
	log.Info("backup run starting",
		"jobId", job.ID,
		"paths", strings.Join(backupPaths, string(os.PathListSeparator)),
		"excludeCount", len(excludes),
		"vssEnabled", m.config.VSSEnabled,
		"systemStateEnabled", m.config.SystemStateEnabled,
		"retention", m.config.Retention,
	)
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
	// journalDirsForExclude is threaded into collectBackupFilesFromPaths
	// below so the walker never backs up this run's own checkpoint-journal
	// files (or another run's, sharing the same directory) as ordinary
	// content — see collectBackupFilesFromPaths's journalDirs doc comment
	// and #5581. Holds the LITERAL journal directory whenever one resolved,
	// even if opening the journal itself failed (the directory can still
	// hold OTHER journal files, e.g. from a concurrent run with a different
	// destination identity); a second, VSS-shadow-rewritten form is
	// appended below once vssSession is known (a VSS run's walker only ever
	// visits shadow-copy paths, never the literal ones — see that block's
	// comment). Left nil only when resolveJournalDir found nowhere secure
	// to journal at all, matching "no journal, nothing to exclude".
	var journalDirsForExclude []string
	if journalDir, ok := resolveJournalDir(m.GetStagingDir()); !ok {
		log.Warn("no secure checkpoint journal directory available, proceeding without resume support")
	} else {
		journalDirsForExclude = append(journalDirsForExclude, journalDir)
		var journalErr error
		journal, resumedJournal, journalErr = openSnapshotJournal(journalDir, backupIdentity(m.config.Provider, m.config.Paths), journalMaxAge)
		if journalErr != nil {
			// A journal is a best-effort checkpoint, never a correctness
			// requirement: degrade to a journal-less run rather than failing
			// the backup over it.
			log.Warn("failed to open checkpoint journal, proceeding without resume support", "error", journalErr.Error())
			journal = nil
		}
	}
	// The journal is now open earlier than it used to be (before VSS/scan,
	// P2 fix) — a stop/failure between here and createSnapshotWithProgress's
	// call site (VSS ctx cancellation, a scan/system-state failure, the
	// resume-shortcut's own early returns) would otherwise leak the open
	// file descriptor and leave an unresolved journal on disk. journalOwned
	// flips true only once the journal's fd lifecycle has been handed off
	// (to createSnapshotWithProgress, or resolved directly by the
	// resume-shortcut's own Complete() call below); every other exit path
	// closes it here via Abandon() (idempotent alongside Complete() — both
	// just Close() the file; a resumable journal with zero new entries is
	// harmless to leave for pickup on the next run).
	journalOwned := false
	if journal != nil {
		defer func() {
			if !journalOwned {
				journal.Abandon()
			}
		}()
	}
	if journal != nil {
		if staleID, ok := journal.StaleSnapshotID(); ok {
			// StaleSnapshotID covers both an actually-stale (>journalMaxAge)
			// journal and the (near-impossible) identity-mismatch case — see
			// openSnapshotJournal — so the message below is deliberately
			// generic rather than claiming a specific cause. The agent no
			// longer cleans up the STALE JOURNAL'S remote prefix itself
			// (D18 §3.5): that prefix belongs to a PRIOR, different run
			// (not this run's own in-progress prefix, which is the only
			// exception §3.5 keeps — see abortStopped/abortSourceGone in
			// snapshot.go), so it is simply dropped and GC's existing
			// manifest-less-prefix rule reclaims it.
			log.Warn("discarding unusable checkpoint journal",
				"snapshotId", staleID,
				"maxAge", journalMaxAge.String(),
			)
		}
		if resumedJournal {
			log.Info("resuming interrupted backup from checkpoint journal",
				"snapshotId", journal.snapshotID,
				"resumedBytes", journal.ResumedBytes(),
			)
		}
	}

	// Resume-with-already-published-manifest, checked BEFORE any source
	// scanning (P2 fix): a resumed run whose manifest is already published
	// must report success even if the configured source has since vanished
	// — the len(files)==0 exits later in this function (and in
	// createSnapshotWithProgress) must never get a chance to fail this run
	// first. See fetchPublishedManifest's three-state contract: only a
	// CONFIRMED-absent result falls through to a normal run; any other
	// error fails the job closed right here.
	if journal != nil && resumedJournal {
		resumePrefix := path.Join(snapshotRootDir, journal.snapshotID)
		existing, fetchErr := fetchPublishedManifest(runCtx, m.config.Provider, resumePrefix)
		if fetchErr != nil {
			job.Status = jobStatusFailed
			job.CompletedAt = time.Now().UTC()
			job.Error = fmt.Errorf("resume check failed, refusing to guess whether %s was already published: %w", resumePrefix, fetchErr)
			return job, job.Error
		}
		if existing != nil {
			log.Info("resume: manifest already published, skipping the entire run",
				"snapshotId", existing.ID,
				"files", len(existing.Files),
			)
			if err := journal.Complete(); err != nil {
				log.Warn("failed to remove completed checkpoint journal", "error", err.Error())
			}
			journalOwned = true
			job.Status = jobStatusCompleted
			job.CompletedAt = time.Now().UTC()
			job.Snapshot = existing
			job.FilesBackedUp = len(existing.Files)
			job.BytesBackedUp = existing.Size
			for _, f := range existing.Files {
				// A content-less entry (symlink/dir) is never a reference —
				// isReferenceEntry already guards on BackupPath=="", this is
				// belt-and-suspenders against the same miscount (review
				// finding, PR #5520).
				if f.HasContent() && isReferenceEntry(f, existing.ID) {
					job.ReferencedFiles++
					job.ReferencedBytes += f.Size
				}
			}
			return job, nil
		}
		// existing == nil, fetchErr == nil: confirmed absent — proceed to
		// VSS/scan/upload normally, reusing this SAME journal (no second
		// open) all the way down to createSnapshotWithProgress's call site.
	}
	// VSS: create shadow copy on Windows for application-consistent backup
	var vssSession *vss.VSSSession
	if provider, useVSS := m.resolveVSSProvider(); useVSS {
		if err := runCtx.Err(); err != nil {
			return stopBackupRun()
		}
		vssStart := time.Now()
		vssCtx, cancel := context.WithTimeout(runCtx, 10*time.Minute)
		session, vssErr := provider.CreateShadowCopy(vssCtx, extractVolumes(m.config.Paths))
		cancel()
		if vssErr == nil && session == nil {
			// (nil, nil) is a contract violation, not a success: the success
			// branch below dereferences the session immediately. Now that the
			// provider is injectable (BackupConfig.VSSProvider) that branch is
			// reachable from an implementation this package does not own, so
			// convert it into the same visible no-VSS outcome as a creation
			// failure rather than panicking the whole agent run.
			vssErr = errors.New("vss provider returned no session and no error")
		}
		if vssErr != nil {
			log.Warn("VSS shadow copy failed, proceeding without VSS",
				"elapsedMs", time.Since(vssStart).Milliseconds(),
				"error", vssErr.Error(),
			)
			// #3027: the worst VSS outcome used to be the quietest one. When the
			// session never starts there is no VSSMetadata to send, so without
			// this the run reaches the server indistinguishable from a clean
			// VSS-backed backup — every path read live, every locked file at
			// risk of being skipped, and nothing anywhere saying so. The
			// per-path warning further down only fires when a session DID
			// start, so it cannot cover this branch.
			appendWarning(job, vssCreationFailureWarning(vssErr))
		} else {
			vssSession = session
			job.VSSMetadata = buildVSSMetadata(session, time.Since(vssStart).Milliseconds())
			if len(session.Warnings) > 0 {
				log.Warn("VSS completed with warnings",
					"warningCount", len(session.Warnings),
					"warnings", strings.Join(session.Warnings, "; "),
				)
			}
			defer func() {
				if releaseErr := provider.ReleaseShadowCopy(session); releaseErr != nil {
					log.Warn("failed to release VSS shadow copy", "error", releaseErr.Error())
				}
			}()
		}
	}

	// System state collection: gather OS config, hardware profile, etc.
	var systemStateErr error
	// systemStateStagingIdx is always noStagingIdx now: the staging dir is
	// published separately (see publishSystemState) rather than appended to
	// backupPaths, so there is never an entry in backupPaths for the VSS
	// rewrite below to protect. Kept as a named constant purely so
	// rewritePathsForVSS/reportableLiveReads (D8/D12's VSS machinery, out of
	// scope for this change) keep their existing "no staging dir" signature
	// unchanged.
	var systemStateStagingDir string
	systemStateStagingIdx := noStagingIdx
	if m.config.SystemStateEnabled {
		if err := runCtx.Err(); err != nil {
			return stopBackupRun()
		}
		manifest, stagingDir, ssErr := collectSystemState()
		if ssErr != nil {
			systemStateErr = ssErr
			log.Warn("system state collection failed, proceeding without", "error", ssErr.Error())
			// systemStateErr alone only fails the run when there is nothing
			// else to fall back on (the len(files)==0 branch below). A run that
			// ALSO has configured file paths keeps going and completes green,
			// so without this the operator is never told the system state is
			// absent — the same silent outcome as #3026, reached by a different
			// route. CollectSystemState only errors when a REQUIRED class
			// failed, i.e. the capture would not boot at restore time.
			appendWarning(job, "system state was not collected: "+ssErr.Error())
		} else {
			manifest.CollectorVersion = m.config.AgentVersion
			job.SystemStateManifest = manifest
			// Collection succeeded on all *required* artifacts (missing a
			// required class returns an error above and fails the run). Any
			// remaining incomplete steps are best-effort classes (certs, iis,
			// ...) — surface them as a completion warning so a degraded capture
			// is visible without discarding an otherwise-usable backup.
			if len(manifest.IncompleteSteps) > 0 {
				// appendWarning, NOT a raw assignment: this used to be the
				// first and only writer of job.Warning, but it is now one of
				// several (the collection-failure note above, the live-read
				// note and the uncaptured-artifacts note below). A raw
				// assignment here silently discards whichever of those ran
				// first.
				//
				// The VSS note is the one that mattered most: the VSS block
				// above runs first, and a wedged VSS/writer subsystem is
				// exactly what tends to leave system state incomplete too, so
				// the two co-occur. Overwriting here destroyed that note on
				// the one run where both mattered — and when the session never
				// started there is no VSSMetadata, so job.Warning is the only
				// channel that outcome has.
				incomplete := fmt.Sprintf("system state collection incomplete: %v failed", manifest.IncompleteSteps)
				appendWarning(job, incomplete)
				log.Warn("system state collection incomplete", "warning", incomplete)
			}
			// The staging dir is published to snapshots/<id>/system-state/ as
			// its own step (see publishSystemState in snapshot.go), never
			// appended to backupPaths — Option A of the D15 bare-metal-recovery
			// contract (see docs/superpowers/plans/backup/
			// 2026-09-09-bmr-system-state-contract.md). Record it so the
			// publish step(s) below can find it, and clean it up once this run
			// is done with it either way.
			systemStateStagingDir = stagingDir
			defer func() {
				if removeErr := os.RemoveAll(stagingDir); removeErr != nil {
					log.Warn("failed to clean up system state staging dir", "dir", stagingDir, "error", removeErr.Error())
				}
			}()
		}

		// Disk layout — independent of system-state success: a partial state
		// capture with a good layout is still worth knowing about, and vice
		// versa. Never fatal: the run is still a valid file backup.
		//
		// ErrUnsupportedPlatform (no collector for this GOOS, e.g. darwin) is
		// an EXPECTED, permanent condition, not a collection failure — it
		// never becomes a run warning, and job.BareMetal stays nil exactly
		// like a file-only run, so a healthy system-state run on an
		// unsupported platform stays warning-free.
		if lm, lerr := collectLayout(runCtx); lerr != nil {
			if errors.Is(lerr, layout.ErrUnsupportedPlatform) {
				log.Debug("disk layout capture skipped: unsupported platform")
			} else {
				log.Warn("disk layout capture failed", "error", lerr.Error())
				appendWarning(job, "disk layout was not captured: "+lerr.Error())
				job.BareMetal = &layout.Restorability{Restorable: false, Reasons: []string{"disk layout was not captured: " + lerr.Error()}}
			}
		} else {
			job.LayoutManifest = lm
			verdict := layout.Assess(lm)
			job.BareMetal = &verdict
			if !verdict.Restorable {
				appendWarning(job, "not bare-metal restorable: "+strings.Join(verdict.Reasons, "; "))
			}
		}
	}

	// sourceLiveness watches the shadow-copy roots this run reads from so the
	// upload loop can tell "the snapshot died" apart from "these files are
	// bad" (#3260).
	//
	// Built at the very top of the VSS block — before the path rewrite, and well
	// before the file walk, which on a large volume runs for minutes. That
	// ordering is load-bearing: newShadowRootLiveness calibrates by stat-ing
	// each root once and watching only the ones that answer, so it has to run
	// while the snapshot is as fresh as it will ever be. Calibrating after the
	// walk would risk arming the guard against a snapshot that had already
	// started to go.
	//
	// Stays nil for a non-VSS run: reading the live filesystem has nothing to
	// defend.
	var sourceLiveness sourceLivenessFn

	// Rewrite paths to shadow copy device paths when VSS is active
	if vssSession != nil {
		sourceLiveness = newShadowRootLiveness(vssSession.ShadowPaths)
		var unmappedIdx []int
		backupPaths, unmappedIdx = rewritePathsForVSS(backupPaths, vssSession.ShadowPaths, systemStateStagingIdx)

		// journalDirsForExclude was computed from the LITERAL staging dir
		// above, before this rewrite — but the walker below only ever
		// visits the REWRITTEN backupPaths on a VSS run, never the literal
		// ones. That alone would make the hard-exclude silently never fire
		// under VSS: VSS snapshots the WHOLE volume, so the shadow copy
		// also contains whatever the journal directory held at the instant
		// of the snapshot (a real, uploadable file, not a hypothetical) —
		// only the whole-machine preset's glob exclude would be left
		// protecting a whole-machine run, and nothing would protect a
		// custom path selection (review finding on #5583). Run every
		// already-collected literal journal dir through the SAME
		// volume→shadow substitution rewritePathsForVSS just used, and add
		// whichever ones actually mapped to a shadow root (a dir on a
		// volume VSS couldn't shadow is unmapped — matches
		// rewritePathsForVSS's own live-volume fallback, nothing to add).
		literalJournalDirs := journalDirsForExclude
		rewrittenJournalDirs, unmappedJournalIdx := rewritePathsForVSS(literalJournalDirs, vssSession.ShadowPaths, noStagingIdx)
		unmappedJournalSet := make(map[int]struct{}, len(unmappedJournalIdx))
		for _, idx := range unmappedJournalIdx {
			unmappedJournalSet[idx] = struct{}{}
		}
		for i, shadowed := range rewrittenJournalDirs {
			if _, unmapped := unmappedJournalSet[i]; unmapped {
				continue
			}
			journalDirsForExclude = append(journalDirsForExclude, shadowed)
		}
		if liveReads := reportableLiveReads(backupPaths, unmappedIdx, systemStateStagingIdx); len(liveReads) > 0 {
			shadowedVolumes := make([]string, 0, len(vssSession.ShadowPaths))
			for vol := range vssSession.ShadowPaths {
				shadowedVolumes = append(shadowedVolumes, vol)
			}
			sort.Strings(shadowedVolumes)
			summary := summarizeLiveReads(liveReads)
			// Overlaps the provider's own UnprotectedVolumes warning for a
			// volume whose snapshot failed — every non-staging path's volume
			// was requested, so that is the common cause. What it adds is
			// path-level detail, and it uniquely covers the case the provider
			// cannot see: VSS reported total success but the path never
			// matched a shadow root.
			log.Warn("VSS is active but some backup paths are NOT routed through the shadow copy; "+
				"they will be read from the live volume, where in-use files can fail or be captured torn",
				"jobId", job.ID,
				"unmappedPathCount", len(liveReads),
				"paths", summary,
				"shadowedVolumes", strings.Join(shadowedVolumes, ", "),
			)
			// The log line alone is endpoint-local. Both server-visible channels
			// are used, deliberately, because they carry different things:
			// job.VSSMetadata (#3027) is the structured record — per-writer
			// state, unprotected volumes, shadow paths — persisted to
			// backup_jobs.vss_metadata for the device tab's VSS panel, while
			// this warning is the loud, always-rendered summary that survives
			// even when the IPC bounding drops vssMetadata as a bulk field
			// (result_bounds.go). The warning also uniquely covers the case
			// the VSS provider cannot see: VSS reported total success but the
			// path never matched a shadow root, so UnprotectedVolumes is empty.
			appendWarning(job, "read from the live volume, not the VSS shadow copy: "+summary)
		}
	}

	if err := runCtx.Err(); err != nil {
		return stopBackupRun()
	}
	// The tree walk emits nothing of its own and can run for many minutes on a
	// large volume, so without a bounding pair of log lines it is
	// indistinguishable from a hang. Same reasoning as the per-file upload
	// timing in snapshot.go (#2790).
	log.Info("scanning backup paths", "jobId", job.ID, "pathCount", len(backupPaths))
	scanStart := time.Now()
	files, scanErr := m.collectBackupFilesFromPaths(runCtx, backupPaths, newExcludeMatcher(excludes), journalDirsForExclude)
	if scanErr != nil {
		if errors.Is(scanErr, errBackupStopped) {
			return stopBackupRun()
		}
		log.Warn("backup file scan completed with errors", "error", scanErr.Error())
	}
	log.Info("scan complete",
		"jobId", job.ID,
		"files", len(files),
		"elapsedMs", time.Since(scanStart).Milliseconds(),
	)
	if vssSession != nil {
		// Recover the pre-VSS-rewrite path for each file so the checkpoint
		// journal has a stable resume key — see originalPathsForVSS and the
		// backupFile.originalPath doc comment.
		originalPathsForVSS(files, vssSession.ShadowPaths)
	}
	// NOTE: system-state artifacts are no longer part of `files` at all (see
	// the SystemStateEnabled block above) — they are uploaded by
	// publishSystemState from job.SystemStateManifest/systemStateStagingDir
	// directly, below and after createSnapshotWithProgress. That function
	// reads each artifact straight from disk and fails loudly if one is
	// missing or unreadable, which is a strictly stronger guarantee than the
	// old "did the file walk happen to see it" proxy check this replaced —
	// see the plan doc's Wave 1 section for why the old check (markSystem-
	// StateFiles/systemStateArtifactsMissing) is now dead code and was
	// removed rather than left inert.
	// Gate manifest publication whenever server-owned mode is on (D18
	// §3.1) — keyed on BaseSnapshotID being present, NOT on the lease
	// being non-zero (P1 fix): Task 1's payload validation guarantees a
	// non-zero lease whenever BaseSnapshotID is set, but the gate's
	// INSTALLATION must not itself depend on that value, or a payload that
	// somehow slipped validation with a zero lease would run completely
	// ungated instead of hitting checkPublish's fail-closed zero-lease
	// branch. Legacy servers (nil BaseSnapshotID) get the unwrapped
	// provider and fully unchanged behavior. Applies to full runs too, not
	// just incremental ones — the server fences every dispatched run's
	// late-result window this way.
	//
	// Built BEFORE the len(files)==0 branch below (moved here on the D15
	// merge) because that branch's state-only-zero-files publish path
	// (publishSystemState + publishSnapshotManifest, D15 Wave 1) also
	// writes snapshots/<id>/system-state/manifest.json and
	// snapshots/<id>/manifest.json directly — isManifestPath matches both
	// by basename, so leaseGate fences that path exactly like the ordinary
	// createSnapshotWithProgress call below. Using the raw m.config.Provider
	// there instead would let a state-only run publish past its lease with
	// no fence at all.
	uploadProvider := m.config.Provider
	if m.config.BaseSnapshotID != nil {
		uploadProvider = &leaseGate{
			BackupProvider:        m.config.Provider,
			publishLeaseExpiresAt: m.config.PublishLeaseExpiresAt,
			journal:               journal,
		}
	}

	if len(files) == 0 {
		if err := runCtx.Err(); err != nil {
			return stopBackupRun()
		}
		stateHasArtifacts := systemStateStagingDir != "" && job.SystemStateManifest != nil && len(job.SystemStateManifest.Artifacts) > 0
		if !stateHasArtifacts && m.config.SystemStateEnabled && len(m.config.Paths) == 0 {
			// A system-state-only run (no configured file paths) that
			// collected nothing: success depends entirely on what was
			// collected above, since there is no ordinary-files fallback.
			// Nothing to publish (collection failed, or produced a manifest
			// with zero artifacts) is a hard failure — a green empty
			// snapshot would silently protect nothing.
			runErr := systemStateErr
			if runErr == nil {
				runErr = errors.New("system state collection produced no artifacts")
			}
			job.Status = jobStatusFailed
			job.CompletedAt = time.Now().UTC()
			job.Error = errors.Join(scanErr, runErr)
			return job, job.Error
		}
		if stateHasArtifacts {
			// State was collected with at least one artifact — publish it
			// even though the ordinary file walk yielded nothing.
			// Deliberately NOT gated on len(m.config.Paths)==0: a MIXED run
			// (SystemStateEnabled with configured file paths too) can walk
			// zero files just as easily — an empty directory, everything
			// excluded, or a stale configured path — and losing the
			// already-collected state in that case is exactly as silent a
			// failure as the pure state-only case this branch was written
			// for. Publish it as its own snapshot: system-state/ artifacts +
			// manifest, plus the ordinary (empty-files) manifest.json so the
			// snapshot-id group stays "manifest-bearing" for GC (see
			// markLiveBackupObjects in apps/api/src/jobs/backupRetention.ts).
			// A publish failure here is a hard job failure, not `completed`
			// — there is no ordinary-files fallback for this snapshot.
			snapshot := &Snapshot{
				ID:        newSnapshotID(),
				Timestamp: time.Now().UTC(),
				// Files must be a non-nil empty slice, not the zero value: the
				// field has no `omitempty` (a genuine empty-files manifest
				// must still round-trip as "files":[]), and a nil slice
				// encodes as `"files":null`, which the API's resultSchemas/
				// queueSchemas reject (z.array(...).optional() accepts a
				// missing key or [] but not null) — that silently drops the
				// whole job result server-side.
				Files:          []SnapshotFile{},
				BackupIdentity: m.runBackupIdentity(),
			}
			prefix := path.Join(snapshotRootDir, snapshot.ID)
			if pubErr := publishSystemState(runCtx, uploadProvider, snapshot.ID, systemStateStagingDir, job.SystemStateManifest); pubErr != nil {
				job.Status = jobStatusFailed
				job.CompletedAt = time.Now().UTC()
				job.Error = fmt.Errorf("system state publish failed: %w", pubErr)
				return job, job.Error
			}
			if job.LayoutManifest != nil {
				if pubErr := publishLayoutManifest(runCtx, uploadProvider, snapshot.ID, job.LayoutManifest); pubErr != nil {
					job.Status = jobStatusFailed
					job.CompletedAt = time.Now().UTC()
					job.Error = fmt.Errorf("layout manifest publish failed: %w", pubErr)
					return job, job.Error
				}
			}
			if pubErr := publishSnapshotManifest(runCtx, uploadProvider, snapshot, prefix); pubErr != nil {
				job.Status = jobStatusFailed
				job.CompletedAt = time.Now().UTC()
				job.Error = fmt.Errorf("system state publish failed: %w", pubErr)
				return job, job.Error
			}
			job.Snapshot = snapshot
			job.BytesBackedUp = 0
			job.CompletedAt = time.Now().UTC()
			job.Status = jobStatusCompleted
			log.Info("backup run finished with state artifacts but zero walked files",
				"status", job.Status,
				"jobId", job.ID,
				"snapshotId", snapshot.ID,
				"artifacts", len(job.SystemStateManifest.Artifacts),
				"configuredPaths", len(m.config.Paths),
				"elapsedMs", time.Since(job.StartedAt).Milliseconds(),
			)
			return job, nil
		}
		job.Status = jobStatusSkipped
		job.CompletedAt = time.Now().UTC()
		job.Error = scanErr
		return job, scanErr
	}

	// This run's backup identity (device + destination + run kind — see
	// runBackupIdentity/Snapshot.BackupIdentity) is computed once and reused
	// both to select this run's dedupe base below and to stamp the new
	// snapshot's own manifest, so a LATER run can find this one without
	// picking up another device's or run-kind's snapshot instead (D6).
	runIdentity := m.runBackupIdentity()

	// Previous-manifest fetch for incremental reference decisions (manifest
	// v2). Fail-open: any fetch/parse problem collapses to a loud log line
	// and a full run — dedupe is strictly an optimization and must never
	// fail or block a backup (see previousManifest's doc comment).
	//
	// A system-state-only run (SystemStateEnabled with no configured file
	// paths) never reaches this line at all — see the len(files)==0 branch
	// above, which returns before this point since system-state artifacts
	// are no longer part of `files` (they are published separately by
	// publishSystemState). So len(m.config.Paths) > 0 always holds by the
	// time we get here; this expression is kept as an explicit guard rather
	// than assumed, so a future change to the branches above fails safe
	// (skips dedupe) instead of silently building a reference index off an
	// unintended run shape.
	var prevSnapshot *Snapshot
	incrementalDedupeActive := !m.config.SystemStateEnabled || len(m.config.Paths) > 0
	if incrementalDedupeActive {
		if m.config.BaseSnapshotID != nil {
			// Server-owned mode (D18 §3.1): the protocol switch is presence
			// of baseSnapshotId in the backup_run payload (see
			// exec_backup.go). The agent never lists the bucket to choose a
			// base in this mode.
			prev, reason := fetchServerOwnedBase(runCtx, m.config.Provider, *m.config.BaseSnapshotID, runIdentity)
			if prev == nil {
				log.Info("running full backup, no reference dedupe",
					"mode", "server-owned",
					"baseSnapshotId", *m.config.BaseSnapshotID,
					"reason", reason,
				)
			} else {
				prevSnapshot = prev
				log.Info("using server-selected base for incremental reference dedupe",
					"mode", "server-owned",
					"baseSnapshotId", prev.ID,
				)
			}
		} else {
			// Legacy mode: server predates the field, fall back to the
			// original bucket-listing lookup.
			prev, reason := previousManifest(runCtx, m.config.Provider, runIdentity)
			if prev == nil {
				log.Info("running full backup, no reference dedupe", "mode", "legacy", "reason", reason)
			} else {
				prevSnapshot = prev
			}
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
		// No snapshot exists yet — createSnapshotWithProgress mints the ID
		// below and emits it on its own first (forced) progress call.
		progressFn(0, len(files), 0, bytesTotal, "")
	}

	// D18 W03 hoisted the journal-open (and its stale-journal handling) to
	// before VSS/scan, and removed the agent-side stale-journal remote
	// cleanup entirely (D18 §3.5) — see that block earlier in this
	// function. D15's snapshotOpts/withSystemState wiring is independent of
	// that and slots in here unchanged.
	snapshotOpts := []createSnapshotOption{withRunIdentity(runIdentity)}
	if m.config.SystemStateEnabled && systemStateStagingDir != "" && job.SystemStateManifest != nil && len(job.SystemStateManifest.Artifacts) > 0 {
		// Publish system state under this call's own snapshot ID, BEFORE its
		// ordinary manifest.json — see withSystemState's doc comment. This
		// replaces a separate publishSystemState call this function used to
		// make AFTER createSnapshotWithProgress returned, which published the
		// ordinary manifest first (wrong order — D15 Wave 1 finding #4).
		snapshotOpts = append(snapshotOpts, withSystemState(systemStateStagingDir, job.SystemStateManifest))
	}
	if m.config.SystemStateEnabled && job.LayoutManifest != nil {
		snapshotOpts = append(snapshotOpts, withLayout(job.LayoutManifest))
	}
	// Ownership of the journal's fd lifecycle transfers to
	// createSnapshotWithProgress from here on (it has its own
	// completed/Abandon defer) — this function's defer above must not also
	// Abandon() it out from under that call.
	journalOwned = true
	snapshot, snapErr := createSnapshotWithProgress(runCtx, uploadProvider, files, progressFn, journal, prevSnapshot, sourceLiveness, snapshotOpts...)
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
			// See the identical guard/comment above: a content-less entry
			// is never a reference (review finding, PR #5520).
			if f.HasContent() && isReferenceEntry(f, snapshot.ID) {
				job.ReferencedFiles++
				job.ReferencedBytes += f.Size
			}
		}
	}

	if err := runCtx.Err(); err != nil {
		return stopBackupRun()
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

	// A run with BOTH configured file paths and system state (SystemStateEnabled
	// with len(m.config.Paths) > 0 — the state-only case above already handled
	// SystemStateEnabled with no configured paths) already published its
	// collected system state INSIDE createSnapshotWithProgress above, via the
	// withSystemState option — before its ordinary manifest, per D15 Wave 1
	// finding #4. A publish failure there surfaces as snapErr (checked
	// above), which fails the job loudly: a system_image-shaped run that
	// reports `completed` while its state silently never reached the
	// snapshot is exactly the bug this fixes, so a partial success (files
	// ok, state missing) must not read as `completed`.

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
		log.Warn("snapshot completed with upload failures", "warning", failureWarning, "errorCount", job.ErrorCount)
	}

	// Volatile files (#5581): kept changing while being backed up, so their
	// manifest entry describes the last pre-upload measurement rather than
	// any single instant an observer could point to. Not an error (the
	// files ARE backed up, and restore/verify treat a mismatch on them as
	// advisory) — surfaced as a Warning only, no ErrorCount contribution.
	if snapshot != nil && snapshot.VolatileFiles > 0 {
		volatileWarning := fmt.Sprintf("%d file(s) were modified while being backed up (recorded as volatile)", snapshot.VolatileFiles)
		appendWarning(job, volatileWarning)
		log.Warn("snapshot completed with volatile files", "warning", volatileWarning, "volatileFiles", snapshot.VolatileFiles)
	}

	// Collection-phase (scan) errors — permission-denied files, walk failures,
	// unreadable stat — are folded into the SAME ErrorCount/Warning summary as
	// upload failures so they're visible on the wire. scanErr is an errors.Join
	// of per-file errors; without this a run that silently skipped hundreds of
	// unreadable files would complete as a GREEN job with errorCount 0, because
	// BackupJob.Error marshals to `{}` and the server never reads it (see the
	// Error field's doc comment). Success path only: on a hard failure scanErr
	// already rides job.Error alongside the fatal error above.
	scanFailures := flattenJoinedErrors(scanErr)
	if len(scanFailures) > 0 {
		job.ErrorCount += len(scanFailures)
		scanWarning := summarizeScanErrors(scanFailures)
		appendWarning(job, scanWarning)
		log.Warn("snapshot completed with scan failures", "warning", scanWarning)
	}

	// Proportionality gate (#3000). The failures above are already visible via
	// Warning/ErrorCount, but until now a run that stored essentially nothing
	// carried the same terminal status as a clean one. classifyCompletionStatus
	// downgrades only a DISPROPORTIONATE loss to `partial`; a handful of
	// failures in a large run still completes, preserving the deliberate
	// partial-success design above.
	job.Status = classifyCompletionStatus(job.BytesBackedUp, totalScannedBytes(files), job.ErrorCount, len(files)+len(scanFailures))
	job.Error = scanErr
	log.Info("backup run finished",
		"status", job.Status,
		"jobId", job.ID,
		"snapshotId", snapshotID(snapshot),
		"filesBackedUp", job.FilesBackedUp,
		"bytesBackedUp", job.BytesBackedUp,
		"referencedFiles", job.ReferencedFiles,
		"referencedBytes", job.ReferencedBytes,
		"errorCount", job.ErrorCount,
		"elapsedMs", time.Since(job.StartedAt).Milliseconds(),
	)
	return job, nil
}

// snapshotID returns s.ID, or "" for a nil snapshot, so completion logging
// never has to guard the nil case inline.
func snapshotID(s *Snapshot) string {
	if s == nil {
		return ""
	}
	return s.ID
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
// buildVSSMetadata converts a live VSS session into the metadata block the
// server persists to backup_jobs.vss_metadata (#3027).
//
// Extracted from RunBackupContext's Windows-gated branch so it is directly
// callable from a portable test — the original inline struct literal copied
// five of the session's six diagnostic fields and silently dropped
// UnprotectedVolumes, and nothing could reach it to notice.
func buildVSSMetadata(session *vss.VSSSession, durationMs int64) *vss.VSSMetadata {
	if session == nil {
		return nil
	}
	return &vss.VSSMetadata{
		ShadowCopyID: session.ID,
		CreationTime: session.CreatedAt,
		Writers:      session.Writers,
		ExposedPaths: session.ShadowPaths,
		// Copied, not derived: ExposedPaths lists only the volumes that
		// SUCCEEDED, so a volume with no shadow device is indistinguishable
		// from one that was never requested. Omitting this was how a
		// partially-snapshotted run reached the server looking clean.
		UnprotectedVolumes: session.UnprotectedVolumes,
		Warnings:           session.Warnings,
		DurationMs:         durationMs,
	}
}

// vssCreationFailureWarning is the server-visible note for the worst VSS
// outcome, which used to be the quietest one: when CreateShadowCopy fails
// outright there is no VSSMetadata to send at all, so without this the run
// reaches the server indistinguishable from a clean VSS-backed backup — every
// path read live, every locked file at risk of being skipped, and nothing
// anywhere saying so. The per-path warning raised after the shadow-path
// rewrite only fires when a session DID start, so it cannot cover this branch.
func vssCreationFailureWarning(vssErr error) string {
	return "VSS shadow copy could not be created, so every path was read from the live volume, " +
		"where in-use files can be skipped or captured torn: " + vssErr.Error()
}

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
				// later reports can appear to go backwards. This keepalive only
				// runs before the snapshot is created, so it never has an ID.
				onProgress(0, 0, 0, 0, "")
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
	// kind is "" for a regular file, KindSymlink or KindDir for a
	// content-less entry — see SnapshotFile.Kind. linkTarget is the verbatim
	// os.Readlink result for a symlink. modeBits/owner are the full Unix
	// mode (perm + setuid/setgid/sticky) and uid/gid; nil/0 on Windows.
	kind       string
	linkTarget string
	modeBits   uint32
	owner      *FileOwner
	// placeholder mirrors SnapshotFile.Placeholder — see that field's doc
	// comment (snapshot.go). Set only via contentlessEntry for a KindDir
	// entry the walker force-recorded because the directory matched an
	// exclude pattern (#5493).
	placeholder bool
}

// fullModeBits keeps perm + setuid/setgid/sticky; everything else (type bits)
// is dropped so the value round-trips through os.Chmod.
func fullModeBits(mode os.FileMode) uint32 {
	return uint32(mode & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky))
}

// dirNeedsEntry decides whether a directory gets its own manifest entry:
// empty directories always (nothing else recreates them); otherwise only
// when mode/owner differ from the MkdirAll default the restore would apply.
func dirNeedsEntry(info os.FileInfo, owner *FileOwner, empty bool) bool {
	if empty {
		return true
	}
	if runtime.GOOS == "windows" {
		return false
	}
	if fullModeBits(info.Mode()) != 0o755 {
		return true
	}
	if owner == nil {
		return false
	}
	// Compare against the CURRENT PROCESS's own effective owner rather than
	// a hardcoded 0:0: a restore's MkdirAll creates directories owned by
	// whichever identity runs it. In production both the whole-machine
	// backup and the bare-metal restore run as root, so this reduces to
	// "owner != 0:0" exactly as designed. Hardcoding 0:0 instead would flag
	// EVERY non-empty directory a non-root run walks (dev machines, and
	// this package's own test suite on a non-root CI runner) as needing an
	// entry, since every directory is legitimately owned by that non-root
	// user — a false positive on every single directory, not a rare edge
	// case.
	return owner.UID != os.Geteuid() || owner.GID != os.Getegid()
}

func (m *BackupManager) collectBackupFiles() ([]backupFile, error) {
	return m.collectBackupFilesFromPaths(context.Background(), m.config.Paths, newExcludeMatcher(m.config.Excludes), nil)
}

// isWithinDir reports whether path IS dir, or lies somewhere inside it.
// Used to hard-exclude this run's own checkpoint-journal directory from the
// backup walk (see collectBackupFilesFromPaths's journalDirs parameter)
// independent of any user-configured exclude pattern: a live journal file
// growing while the walker is mid-scan is exactly the #5581 failure mode,
// and this guard must keep working even when an operator edits or removes
// the whole-machine preset excludes that also target this directory
// (apps/web/.../backupTabPresets.ts) by name. An unresolvable relative path
// (different volumes on Windows, etc.) is treated as "not within" — the
// same fail-open default filepath.Rel errors already get everywhere else in
// this file.
func isWithinDir(path, dir string) bool {
	if dir == "" {
		return false
	}
	path = filepath.Clean(path)
	dir = filepath.Clean(dir)
	if path == dir {
		return true
	}
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// isWithinAnyDir reports whether path is within (or equal to) any of dirs —
// see isWithinDir. collectBackupFilesFromPaths passes both the journal's
// literal directory and, on a VSS run, its shadow-copy-rewritten form
// (#5583 review fix): the walker only ever visits ONE of those two forms
// depending on whether VSS is active, but journalDirs carries both
// unconditionally, so this must check every candidate rather than just the
// first.
func isWithinAnyDir(path string, dirs []string) bool {
	for _, dir := range dirs {
		if isWithinDir(path, dir) {
			return true
		}
	}
	return false
}

// journalDirs, when non-empty, are every path form that identifies this
// run's own checkpoint-journal directory: the literal directory (see
// resolveJournalDir) and, on a VSS run, its shadow-copy-rewritten form —
// the walker below visits the REWRITTEN backupPaths under VSS, never the
// literal ones, and VSS snapshots the whole volume, so the shadow copy also
// contains whatever the journal directory held at snapshot time (#5583).
// Every directory's subtree is skipped entirely regardless of excl, so the
// walker never captures the very journal file this run is writing to (or
// another run's, in the same directory) as ordinary backup content. Empty
// for callers with no journal context (the collectBackupFiles() test/legacy
// helper above).
func (m *BackupManager) collectBackupFilesFromPaths(ctx context.Context, paths []string, excl *excludeMatcher, journalDirs []string) ([]backupFile, error) {
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
			if excl.matches(relPath) || isWithinAnyDir(cleanRoot, journalDirs) {
				continue
			}
			snapshotPath := filepath.ToSlash(filepath.Join(rootLabel, relPath))
			if _, exists := seen[snapshotPath]; exists {
				log.Debug("duplicate backup path skipped", "snapshotPath", snapshotPath)
				continue
			}
			seen[snapshotPath] = struct{}{}
			files = append(files, backupFile{
				sourcePath:   cleanRoot,
				snapshotPath: snapshotPath,
				size:         info.Size(),
				modTime:      info.ModTime(),
				mode:         info.Mode(),
				modeBits:     fullModeBits(info.Mode()),
				owner:        fileOwner(info),
			})
			continue
		}

		// walkedDir/dirs/childCount defer the "does this directory need its
		// own manifest entry" decision until after the walk: emptiness is
		// only known once every child has been visited (see dirNeedsEntry).
		// childCount is keyed by the ABSOLUTE parent path and counts only
		// children that actually make it into the backup (non-excluded
		// files/symlinks/subdirs) — an excluded child, file or directory,
		// does NOT count. That matters two ways (#5493):
		//   - a directory whose children are ALL excluded (e.g. a cache dir
		//     holding only *.tmp files under a "*.tmp" exclude) still reads
		//     as empty and gets its own manifest entry, same as a directory
		//     that was always empty.
		//   - a directory that is ITSELF excluded (walkedDir.forced below)
		//     is force-recorded regardless of childCount/mode — its contents
		//     are skipped, but the directory's presence, mode, and ownership
		//     still need to survive a rebuild. This is what keeps mount
		//     points like /proc, /tmp, and /var/tmp (whole-machine preset
		//     excludes) present after a bare-metal restore: nothing else in
		//     the manifest recreates them, and systemd/update-initramfs
		//     require them to exist.
		type walkedDir struct {
			path, rel string
			// forced marks a directory that was itself pattern-excluded
			// (never the journal dir — see the walker below, which checks
			// journalDirs first and returns before this can be set for
			// it): it always gets a manifest entry — mode and ownership
			// recorded, contents skipped — bypassing dirNeedsEntry's
			// "would the default MkdirAll suffice" check, since nothing
			// else will ever recreate this directory. Carried into the
			// resulting backupFile/SnapshotFile as Placeholder, which
			// restore uses to avoid re-permissioning an already-existing
			// directory (review fix, #5493).
			forced bool
		}
		var dirs []walkedDir
		childCount := map[string]int{}

		err = filepath.WalkDir(cleanRoot, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return errBackupStopped
			}
			if walkErr != nil {
				errs = append(errs, fmt.Errorf("walk error for %s: %w", path, walkErr))
				return nil
			}
			relPath, relErr := filepath.Rel(cleanRoot, path)
			if relErr != nil {
				errs = append(errs, fmt.Errorf("failed to resolve relative path for %s: %w", path, relErr))
				return nil
			}
			slashRel := filepath.ToSlash(relPath)
			if entry.IsDir() {
				if path == cleanRoot {
					return nil
				}
				// An excluded directory's CONTENTS are skipped entirely
				// (fs.SkipDir), not just its immediate files (#2418). The
				// journal-dir check rides the same fs.SkipDir path so the
				// whole checkpoint journal subtree — not just files that
				// happen to match a glob — is pruned in one step (#5581).
				//
				// The journal-dir check runs FIRST and unconditionally wins
				// (review fix): the journal directory is this run's own
				// ephemeral bookkeeping location and must NEVER appear in
				// the manifest at all — not even if it also happens to
				// match a user-configured exclude pattern (e.g. an explicit
				// "**/backup-journal/**" exclude, or simply a pattern broad
				// enough to catch it incidentally). Checking journalDirs
				// first, and returning before excludedByPattern is even
				// evaluated, means that combination can never accidentally
				// force an entry for it — see
				// TestRunBackupContext_JournalHardExclude_MatchesVSSShadowPath
				// and TestRunBackupContext_JournalHardExclude_WinsOverMatchingUserExclude.
				//
				// Only THEN does a PATTERN-excluded directory get
				// force-recorded (see walkedDir.forced above): it
				// represents a real, user-owned filesystem location (e.g.
				// /proc, /tmp under the whole-machine preset) that a
				// rebuild must still recreate.
				if isWithinAnyDir(path, journalDirs) {
					return fs.SkipDir
				}
				if excl != nil && excl.matches(slashRel) {
					dirs = append(dirs, walkedDir{path: path, rel: slashRel, forced: true})
					return fs.SkipDir
				}
				dirs = append(dirs, walkedDir{path: path, rel: slashRel})
				childCount[filepath.Dir(path)]++
				return nil
			}
			if excl.matches(slashRel) || isWithinAnyDir(path, journalDirs) {
				return nil
			}
			childCount[filepath.Dir(path)]++
			snapshotPath := filepath.ToSlash(filepath.Join(rootLabel, relPath))
			if _, exists := seen[snapshotPath]; exists {
				log.Debug("duplicate backup path skipped", "snapshotPath", snapshotPath)
				return nil
			}
			info, err := entry.Info() // Lstat semantics: never follows the link
			if err != nil {
				errs = append(errs, fmt.Errorf("failed to read info for %s: %w", path, err))
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				target, linkErr := os.Readlink(path)
				if linkErr != nil {
					errs = append(errs, fmt.Errorf("failed to read symlink %s: %w", path, linkErr))
					return nil
				}
				seen[snapshotPath] = struct{}{}
				files = append(files, backupFile{
					sourcePath: path, snapshotPath: snapshotPath, modTime: info.ModTime(), mode: info.Mode(),
					kind: KindSymlink, linkTarget: target, owner: fileOwner(info),
				})
				return nil
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			seen[snapshotPath] = struct{}{}
			files = append(files, backupFile{
				sourcePath:   path,
				snapshotPath: snapshotPath,
				size:         info.Size(),
				modTime:      info.ModTime(),
				mode:         info.Mode(),
				modeBits:     fullModeBits(info.Mode()),
				owner:        fileOwner(info),
			})
			return nil
		})
		if err != nil {
			if errors.Is(err, errBackupStopped) {
				return files, errBackupStopped
			}
			errs = append(errs, fmt.Errorf("backup walk failed for %s: %w", cleanRoot, err))
		}

		for _, d := range dirs {
			info, statErr := os.Lstat(d.path)
			if statErr != nil {
				continue
			}
			owner := fileOwner(info)
			// A forced (pattern-excluded — never the journal dir, see the
			// walker above) entry always gets recorded — dirNeedsEntry's
			// emptiness/mode/owner heuristics are about whether the default
			// restore behavior (MkdirAll 0755) would already recreate it
			// correctly; an excluded directory is never recreated by
			// anything else in the manifest, so it always needs its own
			// entry regardless of what dirNeedsEntry would say. It is also
			// marked Placeholder (review fix, #5493): restore must only
			// apply its mode/owner when creating it fresh, never re-apply
			// them over a directory a customer may have deliberately
			// reconfigured since the backup — see SnapshotFile.Placeholder.
			if !d.forced && !dirNeedsEntry(info, owner, childCount[d.path] == 0) {
				continue
			}
			snapshotPath := filepath.ToSlash(filepath.Join(rootLabel, d.rel))
			if _, exists := seen[snapshotPath]; exists {
				continue
			}
			seen[snapshotPath] = struct{}{}
			files = append(files, backupFile{
				sourcePath: d.path, snapshotPath: snapshotPath, modTime: info.ModTime(), mode: info.Mode(),
				kind: KindDir, modeBits: fullModeBits(info.Mode()), owner: owner, placeholder: d.forced,
			})
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

// noStagingIdx is the stagingIdx sentinel for a run with no system-state
// staging directory: no index is excluded from the VSS rewrite or from the
// live-read warning.
const noStagingIdx = -1

// reportableLiveReads selects, from rewritePathsForVSS's unmapped indices, the paths
// actually worth reporting.
//
// Two exclusions, both deliberate:
//
//   - stagingIdx, the system-state staging dir (#3025 added this exclusion;
//     #3026 extended it to the rewrite). The agent creates it itself during
//     this run, after the snapshot, so it is excluded from the rewrite and can
//     only ever be read live (see rewritePathsForVSS). That makes it an
//     expected member of the unmapped set on every run where VSS is active and
//     system-state collection succeeded, not a symptom of anything.
//   - Anything whose volume is not a local drive letter. VSS cannot snapshot a
//     UNC share, and filepath.VolumeName yields "" for a relative or
//     drive-rooted path, which extractVolumes never even requests. Reporting
//     those would fire on every run of an unchanged config, and a warning that
//     is always on is a warning operators learn to ignore.
//
// Split out as a pure function because the caller needs a real elevated
// Windows box and a live VSS provider to reach, so this is the only way the
// selection logic itself is testable.
func reportableLiveReads(paths []string, unmapped []int, stagingIdx int) []string {
	var liveReads []string
	for _, idx := range unmapped {
		if idx == stagingIdx || idx < 0 || idx >= len(paths) {
			continue
		}
		if !isLocalVolumePath(paths[idx]) {
			continue
		}
		liveReads = append(liveReads, paths[idx])
	}
	return liveReads
}

// isLocalVolumePath reports whether p is rooted on a local drive letter
// ("C:..."), the only shape VSS can snapshot and therefore the only shape
// whose absence from the shadow map is worth reporting.
func isLocalVolumePath(p string) bool {
	vol := filepath.VolumeName(p)
	return len(vol) == 2 && vol[1] == ':'
}

// summarizeLiveReads renders the unmapped paths for an operator-facing message,
// capped like every other per-item summary in this file. The cap is not
// cosmetic: this string is promoted into job.Warning, which the IPC result
// bounding truncates and appends to (see cmd/breeze-backup/result_bounds.go),
// so an unbounded join can be cut mid-path or crowd out other diagnostics.
func summarizeLiveReads(paths []string) string {
	if len(paths) <= maxUploadFailureDetails {
		return strings.Join(paths, "; ")
	}
	return strings.Join(paths[:maxUploadFailureDetails], "; ") +
		fmt.Sprintf(" (+%d more)", len(paths)-maxUploadFailureDetails)
}

// rewritePathsForVSS rewrites source paths to use VSS shadow copy device paths.
// e.g., "C:\\Users\\data" with shadow "C:" -> "\\\\?\\GLOBALROOT\\...\\Users\\data"
//
// NOTE: as of Wave 1 of the D15 bare-metal-recovery contract, the caller
// (RunBackupContext) never appends the system-state staging dir into
// backupPaths anymore — it is published separately (see
// snapshot.go's publishSystemState) — so stagingIdx is always noStagingIdx in
// production today. The parameter and the exclusion logic below are kept
// (rather than removed) because this function's own tests exercise it
// directly, and because a future caller that DOES need to walk a directory
// alongside VSS-rewritten paths can still opt in without re-deriving this.
//
// stagingIdx (noStagingIdx when the run has none) is the index of the
// system-state staging directory, which is excluded from the rewrite. It is
// created by collectSystemState AFTER the shadow copy was taken, so it does
// not exist inside that point-in-time image — but %TEMP% normally sits on C:,
// normally one of the shadowed backup volumes, so rewriting it would map it
// onto a snapshot path that is simply absent. The walk then finds nothing,
// markSystemStateFiles matches zero files, and a run that also has configured
// file paths still reports success with SystemStateManifest set: silent,
// partial data loss (#3026). (A system-state-ONLY run trips the len(files)==0
// hard-failure guard instead, so it fails loudly rather than silently.) The
// live volume is the only place those artifacts exist, so that is where the
// path must keep pointing.
//
// Reachable whenever VSS and system-state collection are both on for the same
// run — an agent.yaml enabling backup_vss_enabled and
// backup_system_state_enabled, or a system_image run with an explicit vss
// override. Server-dispatched system_image runs default VSS off (defaultVSS in
// cmd/breeze-backup/exec_backup.go), so this is opt-in rather than universal.
//
// The second return value holds the indices of paths left pointing at the live
// volume — those that found no shadow root, plus stagingIdx when it is in
// range. The no-shadow-root fallback is deliberate — a volume whose snapshot
// failed is still worth a best-effort read — but it is also indistinguishable,
// from the walk onward, from a successful VSS backup. It is how a shadowPaths key-format change would
// silently reintroduce #2999, so the caller reports it rather than letting it
// pass unnoticed. Indices, not paths, so the caller can tell an unshadowed user
// volume (worth a warning) apart from the staging dir it wrote itself (never
// worth one) — see reportableLiveReads.
func rewritePathsForVSS(paths []string, shadowPaths map[string]string, stagingIdx int) ([]string, []int) {
	rewritten := make([]string, len(paths))
	var unmapped []int
	for i, p := range paths {
		vol := filepath.VolumeName(p)
		shadow, ok := shadowPaths[vol]
		if !ok || i == stagingIdx {
			rewritten[i] = p // fallback: use original path
			unmapped = append(unmapped, i)
			continue
		}
		rewritten[i] = shadow + p[len(vol):]
	}
	return rewritten, unmapped
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

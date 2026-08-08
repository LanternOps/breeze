// Package vss provides Volume Shadow Copy Service (VSS) integration for
// application-consistent backups on Windows. Non-Windows platforms receive
// a stub that returns ErrVSSNotSupported.
package vss

import (
	"context"
	"errors"
	"time"
)

// Sentinel errors returned by the VSS provider.
var (
	ErrVSSNotSupported = errors.New("vss: not supported on this platform")
	ErrVSSTimeout      = errors.New("vss: operation timed out")
	ErrVSSWriterFailed = errors.New("vss: one or more writers failed")
	ErrVSSNoVolumes    = errors.New("vss: no volumes specified")

	// ErrVSSSessionInProgress means this run could not start creating a snapshot
	// set because another one was being created. It does NOT mean only one
	// session may be live at a time: concurrent runs on separate providers each
	// get their own shadow copy, and only the creation interval is serialised
	// (#3269 — see snapshotCreationGate for why the scope stops there).
	//
	// It is returned in two situations:
	//   - the caller's context ended while waiting for the process-wide
	//     creation gate, i.e. another run's snapshot creation outlasted this
	//     run's creation deadline; and
	//   - CreateShadowCopy was called on a provider that is already holding a
	//     live session, which is a caller bug and fails immediately.
	//
	// Callers should treat it as "no VSS for this run" and degrade to a live
	// read with a visible warning, exactly as they do for any other creation
	// failure — not as a reason to retry in a loop.
	ErrVSSSessionInProgress = errors.New("vss: another shadow copy session is already active in this process")
)

// WriterStatus describes the state of a single VSS writer.
type WriterStatus struct {
	Name      string `json:"name"`
	ID        string `json:"id"`
	State     string `json:"state"` // stable, failed, waiting, unknown
	LastError string `json:"lastError,omitempty"`
}

// VSSSession tracks an active shadow copy set.
type VSSSession struct {
	ID          string            `json:"id"`          // the snapshot SET id
	Volumes     []string          `json:"volumes"`     // every volume REQUESTED
	ShadowPaths map[string]string `json:"shadowPaths"` // volume -> shadow device path

	// UnprotectedVolumes lists requested volumes that resolved no shadow device
	// path. Those are read LIVE, so in-use files on them may be skipped — a
	// non-empty value means this is NOT a complete snapshot, and callers must
	// surface it rather than treating the session as a clean VSS backup.
	// Compare against Volumes: ShadowPaths alone cannot tell you what is missing.
	UnprotectedVolumes []string `json:"unprotectedVolumes,omitempty"`

	Writers   []WriterStatus `json:"writers"`
	Warnings  []string       `json:"warnings,omitempty"`
	CreatedAt time.Time      `json:"createdAt"`
}

// VSSMetadata is the metadata block persisted alongside a backup snapshot. It
// rides the backup command result's `vssMetadata` key and is persisted to
// backup_jobs.vss_metadata (see apps/api/src/routes/backup/resultSchemas.ts —
// the two shapes are pinned together by backupAgentContract.test.ts).
type VSSMetadata struct {
	ShadowCopyID string            `json:"shadowCopyId"`
	CreationTime time.Time         `json:"creationTime"`
	Writers      []WriterStatus    `json:"writers"`
	ExposedPaths map[string]string `json:"exposedPaths"`

	// UnprotectedVolumes mirrors VSSSession.UnprotectedVolumes and MUST be
	// carried here: it is the only field that says the snapshot is incomplete.
	// ExposedPaths alone cannot — it lists what succeeded, never what was
	// requested, so a volume that resolved no shadow device is simply absent
	// and reads identically to a volume that was never asked for.
	UnprotectedVolumes []string `json:"unprotectedVolumes,omitempty"`

	Warnings   []string `json:"warnings,omitempty"`
	DurationMs int64    `json:"durationMs"`
}

// Config holds VSS provider configuration.
type Config struct {
	Enabled        bool `json:"enabled"`
	TimeoutSeconds int  `json:"timeoutSeconds"` // default 600
	RetryOnFailure bool `json:"retryOnFailure"` // default true
}

// DefaultConfig returns production-safe defaults.
func DefaultConfig() Config {
	return Config{
		Enabled:        true,
		TimeoutSeconds: 600,
		RetryOnFailure: true,
	}
}

// Provider abstracts VSS operations so callers are platform-agnostic.
type Provider interface {
	// CreateShadowCopy creates a VSS snapshot set for the given volumes and
	// keeps it alive until ReleaseShadowCopy is called for the same session.
	//
	// On Windows the returned session is backed by real COM resources held open
	// on a dedicated thread, so a successful call MUST be paired with exactly
	// one ReleaseShadowCopy.
	//
	// Concurrency, precisely: snapshot *creation* is serialised process-wide, so
	// a call made while another run is creating a snapshot set QUEUES rather
	// than failing, and then proceeds — two concurrent runs on two providers may
	// each end up holding their own live session. ErrVSSSessionInProgress means
	// only that this call gave up: either ctx ended while it was queued, or it
	// was made on a provider that already holds a live session.
	CreateShadowCopy(ctx context.Context, volumes []string) (*VSSSession, error)

	// ReleaseShadowCopy ends the session. On Windows it signals BackupComplete
	// to the VSS writers and then drops the last reference to the
	// IVssBackupComponents, which is what allows Windows to reclaim the
	// auto-release shadow copies. It is idempotent, and it does not fail a
	// backup: a non-nil return reports that the writer handshake or the session
	// identity was wrong, never that the caller's data is at risk.
	//
	// Not calling it leaks the snapshot and blocks every later session in the
	// process until a lifetime backstop reclaims it.
	ReleaseShadowCopy(session *VSSSession) error

	// ListWriters enumerates registered VSS writers and their current state.
	ListWriters(ctx context.Context) ([]WriterStatus, error)

	// GetShadowPath returns the device path for the given volume within the session.
	GetShadowPath(session *VSSSession, volume string) (string, error)
}

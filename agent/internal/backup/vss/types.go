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
	// CreateShadowCopy creates a VSS snapshot set for the given volumes.
	CreateShadowCopy(ctx context.Context, volumes []string) (*VSSSession, error)

	// ReleaseShadowCopy marks the end of the session. On Windows this does not
	// delete anything and cannot fail: the shadow copies are non-persistent and
	// Windows reclaims them when the process exits. Do not read a nil return as
	// "cleanup was verified" — see the Windows implementation for what it
	// deliberately does not do.
	ReleaseShadowCopy(session *VSSSession) error

	// ListWriters enumerates registered VSS writers and their current state.
	ListWriters(ctx context.Context) ([]WriterStatus, error)

	// GetShadowPath returns the device path for the given volume within the session.
	GetShadowPath(session *VSSSession, volume string) (string, error)
}

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
	State     string `json:"state"`               // stable, failed, waiting, unknown
	LastError string `json:"lastError,omitempty"`
}

// VSSSession tracks an active shadow copy set.
type VSSSession struct {
	ID          string            `json:"id"`
	Volumes     []string          `json:"volumes"`
	ShadowPaths map[string]string `json:"shadowPaths"` // volume -> shadow device path
	Writers     []WriterStatus    `json:"writers"`
	CreatedAt   time.Time         `json:"createdAt"`
}

// VSSMetadata is the metadata block persisted alongside a backup snapshot.
type VSSMetadata struct {
	ShadowCopyID string            `json:"shadowCopyId"`
	CreationTime time.Time         `json:"creationTime"`
	Writers      []WriterStatus    `json:"writers"`
	ExposedPaths map[string]string `json:"exposedPaths"`
	DurationMs   int64             `json:"durationMs"`
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

	// ReleaseShadowCopy releases the shadow copy set and frees COM resources.
	ReleaseShadowCopy(session *VSSSession) error

	// ListWriters enumerates registered VSS writers and their current state.
	ListWriters(ctx context.Context) ([]WriterStatus, error)

	// GetShadowPath returns the device path for the given volume within the session.
	GetShadowPath(session *VSSSession, volume string) (string, error)
}

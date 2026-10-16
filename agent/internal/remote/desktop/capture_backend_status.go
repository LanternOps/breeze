package desktop

import (
	"errors"
	"time"
)

// ScreenCaptureKitVerdictStatus describes the recorded ScreenCaptureKit
// verdict for the account the process runs as (#8058). Only macOS desktop
// helpers have one; elsewhere Supported is false.
type ScreenCaptureKitVerdictStatus struct {
	Supported bool `json:"supported"`
	// Path is the verdict file.
	Path string `json:"path,omitempty"`
	// Present is true when a verdict is recorded.
	Present bool `json:"present"`
	// Applies is true when capture sessions will skip ScreenCaptureKit
	// because of it.
	Applies bool `json:"applies"`
	// Reason is "declined", "capture_failed" or "operator".
	Reason     string     `json:"reason,omitempty"`
	Detail     string     `json:"detail,omitempty"`
	RecordedAt *time.Time `json:"recordedAt,omitempty"`
	// StaleReason says what changed when a recorded verdict no longer
	// applies.
	StaleReason string `json:"staleReason,omitempty"`
	// Error is set when the verdict could not be read; it is then ignored.
	Error string `json:"error,omitempty"`
}

// ErrCaptureVerdictUnsupported is returned where there is no ScreenCaptureKit
// verdict to change.
var ErrCaptureVerdictUnsupported = errors.New("the ScreenCaptureKit verdict exists only for the macOS desktop helper")

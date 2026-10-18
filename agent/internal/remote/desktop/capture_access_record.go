//go:build unix

package desktop

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"time"
)

// The persisted capture-access record (#8390).
//
// When a real session captures through ScreenCaptureKit, this process held
// the Screen Recording grant: ScreenCaptureKit returns no frame without it
// (CoreGraphics does, wallpaper only, so a CoreGraphics frame is never
// recorded). The non-capturing access check reads this record where
// preflight is unreliable (macOS 26+). It lives next to the ScreenCaptureKit
// verdict, with the same owner-only checks, and goes stale under the same
// fingerprint rules: a new helper binary, a macOS update, or the preflight
// answer flipping.

const (
	captureAccessFileName = "capture-access.json"
	captureAccessSchema   = 1
)

type captureAccessRecord struct {
	Schema      int            `json:"schema"`
	Backend     string         `json:"backend"`
	RecordedAt  time.Time      `json:"recordedAt"`
	Fingerprint sckFingerprint `json:"fingerprint"`
}

func newCaptureAccessRecord(at time.Time, fp sckFingerprint) captureAccessRecord {
	return captureAccessRecord{
		Schema:      captureAccessSchema,
		Backend:     captureBackendScreenCaptureKit,
		RecordedAt:  at.UTC(),
		Fingerprint: fp,
	}
}

// staleReason returns "" while the record still applies to a host whose
// current fingerprint is cur, and otherwise says what changed.
func (r captureAccessRecord) staleReason(cur sckFingerprint) string {
	return sckVerdict{Reason: "", Fingerprint: r.Fingerprint}.staleReason(cur)
}

func (s *sckVerdictStore) accessPath() string { return filepath.Join(s.dir, captureAccessFileName) }

// loadAccess returns the stored record, or nil with no error when there is
// none.
func (s *sckVerdictStore) loadAccess() (*captureAccessRecord, error) {
	data, err := s.readRecord("capture-access record", captureAccessFileName)
	if err != nil || data == nil {
		return nil, err
	}
	var r captureAccessRecord
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("capture-access record %s is not valid JSON: %w", s.accessPath(), err)
	}
	if r.Schema != captureAccessSchema || r.Backend != captureBackendScreenCaptureKit {
		return nil, fmt.Errorf("capture-access record %s is not a recognised record (schema %d, backend %q)",
			s.accessPath(), r.Schema, r.Backend)
	}
	return &r, nil
}

func (s *sckVerdictStore) saveAccess(r captureAccessRecord) error {
	return s.writeRecord(captureAccessFileName, r)
}

func (s *sckVerdictStore) clearAccess() (removed bool, err error) {
	return s.removeRecord(captureAccessFileName)
}

// recordAccess saves the record after a session captured through
// ScreenCaptureKit. Failure is logged: the check then falls back to its
// other signals.
func (p sckSessionPolicy) recordAccess() {
	store, err := p.store()
	if err == nil {
		err = store.saveAccess(newCaptureAccessRecord(p.now(), p.fingerprint()))
	}
	if err != nil {
		slog.Warn("ScreenCaptureKit captured but the capture-access record could not be saved; "+
			"where preflight misreports, permission checks cannot use this session as proof of the grant",
			"error", err.Error())
	}
}

// clearAccess removes the record after a session's ScreenCaptureKit capture
// was refused: the grant may have been revoked, and a record from before it
// must not keep reporting one.
func (p sckSessionPolicy) clearAccess() {
	store, err := p.store()
	if err != nil {
		return
	}
	if removed, err := store.clearAccess(); err != nil {
		slog.Warn("could not remove the capture-access record after a permission refusal",
			"path", store.accessPath(), "error", err.Error())
	} else if removed {
		slog.Info("removed the capture-access record after a permission refusal", "path", store.accessPath())
	}
}

// lastSessionCaptured reports whether a recorded ScreenCaptureKit session
// still applies to this host. Any problem reading it means no.
func (p sckSessionPolicy) lastSessionCaptured() bool {
	store, err := p.store()
	if err != nil {
		return false
	}
	r, err := store.loadAccess()
	if err != nil {
		slog.Warn("ignoring the capture-access record", "path", store.accessPath(), "error", err.Error())
		return false
	}
	if r == nil {
		return false
	}
	if why := r.staleReason(p.fingerprint()); why != "" {
		slog.Debug("the capture-access record no longer applies", "path", store.accessPath(), "stale", why)
		return false
	}
	return true
}

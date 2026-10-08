//go:build unix

package desktop

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// The persisted ScreenCaptureKit verdict (#8058).
//
// When a capture session finds that ScreenCaptureKit cannot capture on this
// host — the user declined its consent (SCStreamErrorUserDeclined, -3801), or
// it never produced a frame (#6105) — while CoreGraphics can, the desktop
// helper records that here and later sessions go straight to CoreGraphics.
// Before this the verdict lived only as long as the helper process, so every
// helper restart asked ScreenCaptureKit again and, on Sequoia, put macOS's own
// consent dialog back in front of the user.
//
// Only the macOS desktop helper uses it (capture_darwin.go). It carries a
// `unix` build tag rather than `darwin` so the Linux CI job tests it.
//
// Location and trust: ~/Library/Application Support/Breeze/capture-backend.json
// for the console user the helper runs as. The directory is created 0700 and
// the file written 0600 by atomic rename. A directory or file that is a
// symlink, is not owned by the process's uid, or is writable by group/other
// is refused, so no other unprivileged account can plant or redirect a
// verdict. A refused or unreadable verdict is treated as absent: the helper
// then behaves as it did before #8058 (ScreenCaptureKit is tried), never
// worse.

const (
	sckVerdictFileName  = "capture-backend.json"
	sckVerdictSchema    = 1
	sckVerdictMaxBytes  = 16 << 10
	sckVerdictMaxDetail = 512

	// sckVerdictReasonDeclined: ScreenCaptureKit reported the user declined
	// (SCStreamErrorUserDeclined, -3801) and CoreGraphics then captured.
	sckVerdictReasonDeclined = "declined"
	// sckVerdictReasonCaptureFailed: ScreenCaptureKit initialised but never
	// produced a frame on any attempt, and CoreGraphics then captured (#6105).
	sckVerdictReasonCaptureFailed = "capture_failed"
	// sckVerdictReasonOperator: an operator pinned CoreGraphics with
	// `breeze-desktop-helper capture-backend pin-coregraphics`. It does not go
	// stale; only `capture-backend reset` removes it.
	sckVerdictReasonOperator = "operator"
)

// sckFingerprint captures what the verdict depends on. A change to any field
// means "permissions may have changed" and retires a recorded (non-operator)
// verdict: a new helper binary (every agent upgrade replaces it, and macOS
// keys screen-capture grants to the binary), a macOS update, or the Screen
// Recording preflight answer flipping (granted or revoked in System Settings).
type sckFingerprint struct {
	HelperPath               string `json:"helperPath"`
	HelperSize               int64  `json:"helperSize"`
	HelperModTime            int64  `json:"helperModTimeUnixNano"`
	OSBuild                  string `json:"osBuild"`
	ScreenRecordingPreflight bool   `json:"screenRecordingPreflight"`
}

// sckVerdict is the on-disk record.
type sckVerdict struct {
	Schema      int            `json:"schema"`
	Backend     string         `json:"backend"`
	Reason      string         `json:"reason"`
	Detail      string         `json:"detail,omitempty"`
	RecordedAt  time.Time      `json:"recordedAt"`
	Fingerprint sckFingerprint `json:"fingerprint"`
}

func newSCKVerdict(reason, detail string, at time.Time, fp sckFingerprint) sckVerdict {
	if len(detail) > sckVerdictMaxDetail {
		detail = detail[:sckVerdictMaxDetail]
	}
	return sckVerdict{
		Schema:      sckVerdictSchema,
		Backend:     captureBackendCoreGraphics,
		Reason:      reason,
		Detail:      detail,
		RecordedAt:  at.UTC(),
		Fingerprint: fp,
	}
}

// staleReason returns "" while the verdict still applies to a host whose
// current fingerprint is cur, and otherwise says what changed.
func (v sckVerdict) staleReason(cur sckFingerprint) string {
	if v.Reason == sckVerdictReasonOperator {
		return ""
	}
	rec := v.Fingerprint
	switch {
	case rec.HelperPath != cur.HelperPath || rec.HelperSize != cur.HelperSize || rec.HelperModTime != cur.HelperModTime:
		return "the desktop helper binary changed"
	case rec.OSBuild != cur.OSBuild:
		return fmt.Sprintf("the macOS build changed (%s -> %s)", rec.OSBuild, cur.OSBuild)
	case rec.ScreenRecordingPreflight != cur.ScreenRecordingPreflight:
		return fmt.Sprintf("the Screen Recording preflight changed (%t -> %t)",
			rec.ScreenRecordingPreflight, cur.ScreenRecordingPreflight)
	}
	return ""
}

func validSCKVerdictReason(reason string) bool {
	switch reason {
	case sckVerdictReasonDeclined, sckVerdictReasonCaptureFailed, sckVerdictReasonOperator:
		return true
	}
	return false
}

// sckVerdictStore reads and writes the verdict file for one account.
type sckVerdictStore struct {
	dir string
	uid int
}

func (s *sckVerdictStore) path() string { return filepath.Join(s.dir, sckVerdictFileName) }

// checkOwnerOnly refuses anything not owned by s.uid or writable by
// group/other. info must come from Lstat/Fstat so a symlink is seen as one.
func (s *sckVerdictStore) checkOwnerOnly(what, path string, info fs.FileInfo) error {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%s %s: cannot read its owner", what, path)
	}
	if int(st.Uid) != s.uid {
		return fmt.Errorf("%s %s is owned by uid %d, not %d", what, path, st.Uid, s.uid)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%s %s is writable by group or other (mode %o)", what, path, info.Mode().Perm())
	}
	return nil
}

// checkDir validates the verdict directory. exists is false when it is absent.
func (s *sckVerdictStore) checkDir() (exists bool, err error) {
	info, err := os.Lstat(s.dir)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return true, fmt.Errorf("verdict directory %s is not a directory (mode %s)", s.dir, info.Mode())
	}
	return true, s.checkOwnerOnly("verdict directory", s.dir, info)
}

// load returns the stored verdict, or nil with no error when there is none.
func (s *sckVerdictStore) load() (*sckVerdict, error) {
	exists, err := s.checkDir()
	if err != nil || !exists {
		return nil, err
	}
	f, err := os.OpenFile(s.path(), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open verdict %s: %w", s.path(), err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("verdict %s is not a regular file", s.path())
	}
	if err := s.checkOwnerOnly("verdict", s.path(), info); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, sckVerdictMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > sckVerdictMaxBytes {
		return nil, fmt.Errorf("verdict %s is larger than %d bytes", s.path(), sckVerdictMaxBytes)
	}
	var v sckVerdict
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, fmt.Errorf("verdict %s is not valid JSON: %w", s.path(), err)
	}
	if v.Schema != sckVerdictSchema || v.Backend != captureBackendCoreGraphics || !validSCKVerdictReason(v.Reason) {
		return nil, fmt.Errorf("verdict %s is not a recognised record (schema %d, backend %q, reason %q)",
			s.path(), v.Schema, v.Backend, v.Reason)
	}
	return &v, nil
}

// save writes v atomically (temp file in the same directory, then rename).
func (s *sckVerdictStore) save(v sckVerdict) error {
	exists, err := s.checkDir()
	if err != nil {
		return err
	}
	if !exists {
		if err := os.MkdirAll(s.dir, 0o700); err != nil {
			return err
		}
		if _, err := s.checkDir(); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, "."+sckVerdictFileName+".*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.path()); err != nil {
		return err
	}
	committed = true
	return nil
}

// clear removes the verdict. removed is false when there was none.
func (s *sckVerdictStore) clear() (removed bool, err error) {
	exists, err := s.checkDir()
	if err != nil || !exists {
		return false, err
	}
	err = os.Remove(s.path())
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

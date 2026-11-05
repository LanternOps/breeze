package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Persistent per-version latch for an agent self-update that did not take
// effect (#9751).
//
// On Windows the binary swap runs in a detached PowerShell helper after the
// agent has already reported success, so a swap that fails restarts the OLD
// binary with nothing logged at warn or above. The server re-offers the same
// version on the next heartbeat, so the agent downloads and swaps again,
// roughly once a minute and indefinitely: thousands of attempts per device
// within days. Every attempt restarts the
// process, so an in-memory backoff (TargetBackoff, the untrusted/code-signature
// cooldowns) resets each time and never builds up. This latch is stored on disk.
//
// The wait doubles per consecutive failure of the SAME version: 1h, 2h, 4h,
// 8h, 16h, then a 24h cap. After the first few failures the device retries a
// broken version about once a day. It never stops retrying entirely, because
// the cause may be cleared on the host (an AV exclusion, a released file lock)
// or on the server (a rebuilt artifact) without the version changing, and the
// device must then recover on its own. A different target version is never
// held back. A successful update to the latched version, or an offer of any
// other version that then succeeds, clears the latch.
const (
	FailureLatchBase = time.Hour
	FailureLatchMax  = 24 * time.Hour
	// FailureLatchReasonMax bounds the stored reason (bytes).
	FailureLatchReasonMax = 512
	// failureLatchFileMax bounds what Load will read, so a planted or
	// corrupted file cannot make the agent read an arbitrary amount.
	failureLatchFileMax = 16 << 10
)

// FailureLatchState is the persisted latch for one target version.
type FailureLatchState struct {
	Version       string    `json:"version"`
	Failures      int       `json:"failures"`
	LastFailureAt time.Time `json:"lastFailureAt"`
	RetryAt       time.Time `json:"retryAt"`
	Reason        string    `json:"reason,omitempty"`
}

// FailureLatch stores FailureLatchState as JSON at Path. Safe for concurrent
// use within one process. The zero Path disables it (every call is a no-op
// that blocks nothing).
type FailureLatch struct {
	Path string
	// Now is the clock; nil means time.Now. A test seam.
	Now func() time.Time

	mu        sync.Mutex
	warnedBad bool // guarded by mu
}

// FailureLatchDelay is the wait after the n-th consecutive failure of one
// version: FailureLatchBase doubled per failure, capped at FailureLatchMax.
// n <= 0 returns 0.
func FailureLatchDelay(n int) time.Duration {
	if n <= 0 {
		return 0
	}
	d := FailureLatchBase
	for i := 1; i < n; i++ {
		d *= 2
		if d >= FailureLatchMax {
			return FailureLatchMax
		}
	}
	return d
}

func (l *FailureLatch) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

// Load returns the stored state. ok is false when nothing usable is stored: no
// file, an unreadable or oversized file, or JSON that does not decode to a
// state with a version. Such files are treated as absent, so a damaged latch
// never blocks an update.
func (l *FailureLatch) Load() (FailureLatchState, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.loadLocked()
}

func (l *FailureLatch) loadLocked() (FailureLatchState, bool) {
	if l.Path == "" {
		return FailureLatchState{}, false
	}
	f, err := os.Open(l.Path)
	if err != nil {
		if !os.IsNotExist(err) {
			l.warnBadOnce("update failure latch unreadable; treating as empty", err)
		}
		return FailureLatchState{}, false
	}
	defer func() { _ = f.Close() }() // read-only handle; close errors carry no information here
	data, err := io.ReadAll(io.LimitReader(f, failureLatchFileMax+1))
	if err == nil && len(data) > failureLatchFileMax {
		err = errors.New("file exceeds size limit")
	}
	if err != nil {
		l.warnBadOnce("update failure latch unreadable or oversized; treating as empty", err)
		return FailureLatchState{}, false
	}
	var st FailureLatchState
	if err := json.Unmarshal(data, &st); err != nil || st.Version == "" || st.Failures < 1 {
		if err == nil {
			err = errors.New("missing version or failure count")
		}
		l.warnBadOnce("update failure latch is corrupt; treating as empty until the next update outcome rewrites it", err)
		return FailureLatchState{}, false
	}
	l.warnedBad = false
	return st, true
}

// warnBadOnce logs a damaged-latch warning once until the latch reads cleanly
// again. Load runs on every heartbeat that carries an offer, and the warning
// ships at the default level, so repeating it would flood the server logs.
func (l *FailureLatch) warnBadOnce(msg string, err error) {
	if l.warnedBad {
		return
	}
	l.warnedBad = true
	log.Warn(msg, "path", l.Path, "error", err.Error())
}

// Remaining reports whether version is latched now and, if so, how long until
// it may be retried. A clock earlier than the recorded failure (the clock moved
// backwards) lifts the latch rather than stranding the device behind a retry
// time computed on the wrong clock.
func (l *FailureLatch) Remaining(version string) (FailureLatchState, time.Duration, bool) {
	st, ok := l.Load()
	if !ok || st.Version != version {
		return st, 0, false
	}
	now := l.now()
	if now.Before(st.LastFailureAt) {
		return st, 0, false
	}
	// Never further out than the cap from the failure itself, whatever the
	// file says, so a damaged or planted retryAt cannot strand the device.
	retryAt := st.RetryAt
	if limit := st.LastFailureAt.Add(FailureLatchMax); retryAt.After(limit) {
		retryAt = limit
	}
	left := retryAt.Sub(now)
	if left <= 0 {
		return st, 0, false
	}
	return st, left, true
}

// NoteFailure records a failure of version and returns the new state. A
// version different from the stored one starts a new streak. The state is
// written atomically (temp file + rename). The returned state is valid even
// when the write fails, so the caller can still log it.
func (l *FailureLatch) NoteFailure(version, reason string) (FailureLatchState, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	st, ok := l.loadLocked()
	if !ok || st.Version != version {
		st = FailureLatchState{Version: version}
	}
	st.Failures++
	now := l.now()
	st.LastFailureAt = now
	st.RetryAt = now.Add(FailureLatchDelay(st.Failures))
	if len(reason) > FailureLatchReasonMax {
		// Drop a rune split by the cut rather than store invalid UTF-8.
		reason = strings.ToValidUTF8(reason[:FailureLatchReasonMax], "")
	}
	st.Reason = reason
	if l.Path == "" {
		return st, nil
	}
	return st, l.writeLocked(st)
}

func (l *FailureLatch) writeLocked(st FailureLatchState) error {
	data, err := json.Marshal(st)
	if err != nil {
		return fmt.Errorf("encode update failure latch: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(l.Path), 0o755); err != nil {
		return fmt.Errorf("create update failure latch dir: %w", err)
	}
	tmp := l.Path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write update failure latch: %w", err)
	}
	if err := os.Rename(tmp, l.Path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace update failure latch: %w", err)
	}
	return nil
}

// Clear forgets the latch. Removing an absent latch is not an error.
func (l *FailureLatch) Clear() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Path == "" {
		return nil
	}
	if err := os.Remove(l.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

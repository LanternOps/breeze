package logging

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// A shipping-level override is a temporary change to the minimum level a
// process ships to the API, set by the `set_log_level` command (#7416).
//
// It is persisted to a small JSON file next to agent.yaml so that:
//
//   - it survives a restart of the agent service — the shipper re-reads it
//     at Start instead of coming back at log_shipping_level; and
//   - it reaches the helper processes (desktop helper, user helper, backup
//     helper), which each run their own shipper and never see the command.
//     Every shipper started with a LevelOverridePath re-reads the file every
//     levelOverridePollInterval. No IPC message is involved, so helpers built
//     before this change simply ignore the file.
//
// An override is ALWAYS bounded: it carries an absolute expiry that is at
// most MaxLevelOverrideDuration in the future, both when it is written and
// when it is read (a rolled-back clock or a hand-edited file cannot pin a
// verbose level). Once expired, every process falls back to its configured
// base level — no timer, no revert command. The expired file is left in place
// and ignored; the next override overwrites it.
//
// The file only ever ADDS or REPLACES an override in a running process; its
// absence never clears one. That keeps an in-memory override alive when the
// write failed (it is reported as not persisted) and leaves expiry as the
// single way an override ends.

// LevelOverrideFileName is the override file's name inside the agent config
// directory (config.ConfigDir()).
const LevelOverrideFileName = "log_shipping_override.json"

// MaxLevelOverrideDuration bounds how long an override can stay in effect.
const MaxLevelOverrideDuration = 24 * time.Hour

// levelOverridePollInterval is how often a running shipper re-reads the
// override file. A var so tests can shorten it.
var levelOverridePollInterval = 30 * time.Second

// levelOverrideWriteMu serialises WriteLevelOverride within a process.
var levelOverrideWriteMu sync.Mutex

// ErrShipperNotInitialized is returned when no shipper is running in this
// process (agent not enrolled, or log shipping not configured).
var ErrShipperNotInitialized = errors.New("log shipper not initialized")

// LevelOverride is the persisted override.
type LevelOverride struct {
	Level     string    `json:"level"`
	ExpiresAt time.Time `json:"expiresAt"`
	SetAt     time.Time `json:"setAt,omitempty"`
}

// LevelOverrideStatus reports what ApplyShipperLevelOverride actually did.
type LevelOverrideStatus struct {
	Level        string
	BaseLevel    string
	ExpiresAt    time.Time
	Persisted    bool
	PersistError string
}

// validShipLevel reports whether s is one of the level names the command
// accepts. parseLevel silently maps anything else to Info, so validation must
// happen before it.
func validShipLevel(s string) bool {
	switch s {
	case "debug", "info", "warn", "error":
		return true
	}
	return false
}

func levelName(l slog.Level) string {
	switch {
	case l <= slog.LevelDebug:
		return "debug"
	case l <= slog.LevelInfo:
		return "info"
	case l <= slog.LevelWarn:
		return "warn"
	default:
		return "error"
	}
}

// ReadLevelOverride returns the override stored at path when it is valid and
// active at now. ok is false with a nil error when the file is absent or the
// override has expired; a non-nil error means the file exists but cannot be
// trusted (unreadable, malformed, unknown level, or beyond the bound).
func ReadLevelOverride(path string, now time.Time) (LevelOverride, bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return LevelOverride{}, false, nil
		}
		return LevelOverride{}, false, err
	}
	var o LevelOverride
	if err := json.Unmarshal(raw, &o); err != nil {
		return LevelOverride{}, false, fmt.Errorf("parse %s: %w", filepath.Base(path), err)
	}
	if !validShipLevel(o.Level) {
		return LevelOverride{}, false, fmt.Errorf("invalid override level %q", o.Level)
	}
	if !o.ExpiresAt.After(now) {
		return LevelOverride{}, false, nil
	}
	if o.ExpiresAt.Sub(now) > MaxLevelOverrideDuration {
		return LevelOverride{}, false, fmt.Errorf("override expiry %s is more than %s away", o.ExpiresAt.Format(time.RFC3339), MaxLevelOverrideDuration)
	}
	return o, true, nil
}

// WriteLevelOverride atomically replaces the override file. It is made
// readable to all local users (0644 / BUILTIN\Users read): it holds only a
// level name and timestamps, and helpers running as the logged-in user must
// be able to read it.
func WriteLevelOverride(path string, o LevelOverride) error {
	// Serialise writers in this process: two set_log_level commands running
	// at once would otherwise interleave on the shared temp file.
	levelOverrideWriteMu.Lock()
	defer levelOverrideWriteMu.Unlock()
	return writeLevelOverrideLocked(path, o)
}

// writeLevelOverrideLocked is WriteLevelOverride's body; the caller holds
// levelOverrideWriteMu.
func writeLevelOverrideLocked(path string, o LevelOverride) error {
	data, err := json.Marshal(o)
	if err != nil {
		return err
	}
	// A fixed temp name (not CreateTemp) so a crash between write and rename
	// leaves at most one stray file, which the next write reuses.
	tmpName := path + ".tmp"
	cleanup := func() { _ = os.Remove(tmpName) }
	tmp, err := os.OpenFile(tmpName, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	// Before the rename, so the file never appears with the wrong access.
	if err := makeLevelOverrideFileReadable(tmpName); err != nil {
		cleanup()
		return err
	}
	if err := renameWithRetry(tmpName, path); err != nil {
		cleanup()
		return err
	}
	return nil
}

// renameWithRetry retries a failed rename briefly. On Windows a rename over a
// file that another process has open fails, because Go opens files without
// FILE_SHARE_DELETE, and every helper re-reads this file every 30 seconds.
// The read takes microseconds, so a few short retries clear the collision.
func renameWithRetry(from, to string) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if err = os.Rename(from, to); err == nil {
			return nil
		}
		time.Sleep(time.Duration(attempt+1) * 20 * time.Millisecond)
	}
	return err
}

// ApplyShipperLevelOverride sets a bounded shipping-level override on this
// process's shipper and persists it for restarts and helper processes.
//
// The in-memory override is applied even when persisting fails; that case is
// reported through Persisted/PersistError rather than as an error, because the
// running agent really is shipping at the new level.
func ApplyShipperLevelOverride(level string, d time.Duration) (LevelOverrideStatus, error) {
	if !validShipLevel(level) {
		return LevelOverrideStatus{}, fmt.Errorf("invalid level %q", level)
	}
	if d <= 0 || d > MaxLevelOverrideDuration {
		return LevelOverrideStatus{}, fmt.Errorf("override duration %s outside (0, %s]", d, MaxLevelOverrideDuration)
	}

	shipperMu.RLock()
	s := globalShipper
	shipperMu.RUnlock()
	if s == nil {
		return LevelOverrideStatus{}, ErrShipperNotInitialized
	}

	// One lock across the in-memory set and the file write, so concurrent
	// commands land in the file in the same order as in memory and a restart
	// comes back at the last command, not an earlier one. Nothing below logs.
	levelOverrideWriteMu.Lock()
	defer levelOverrideWriteMu.Unlock()

	now := s.clock()
	expiresAt := now.Add(d)
	s.setLevelOverride(parseLevel(level), expiresAt, now)

	st := LevelOverrideStatus{
		Level:     level,
		BaseLevel: s.baseLevelName(),
		ExpiresAt: expiresAt,
	}
	if s.overridePath == "" {
		st.PersistError = "no override path configured"
		return st, nil
	}
	if err := writeLevelOverrideLocked(s.overridePath, LevelOverride{Level: level, ExpiresAt: expiresAt.UTC(), SetAt: now.UTC()}); err != nil {
		st.PersistError = err.Error()
		return st, nil
	}
	st.Persisted = true
	return st, nil
}

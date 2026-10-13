package watchdoginstall

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// File names in the machine config directory (config.MachineConfigDir()).
// All three are registered in config's reclaimAgentEntries.
const (
	// StateFileName holds the disposable attempt counters (Record, JSON).
	StateFileName = "watchdog-install.state"
	// OptOutFileName is the durable operator opt-out marker, written by
	// `service install --no-watchdog` and removed by `--watchdog`. It is a
	// separate file so corrupting, resetting or rewriting the state (or
	// agent.yaml) can never silently re-enable a deliberately absent watchdog.
	OptOutFileName = "watchdog.disabled"
	// LockFileName is the cross-process install lock (see AcquireLock).
	LockFileName = "watchdog-install.lock"
)

// SchemaVersion is the only Record schema this build reads. Any other value is
// treated as corrupt (fail closed), never guessed at.
const SchemaVersion = 1

// MaxRecordedAttempts bounds Record.Attempts (and what is reported upstream).
const MaxRecordedAttempts = 1000

// CorruptStateDefer is how long a corrupt or unreadable state file defers the
// next attempt: the slow cadence, never "retry now".
const CorruptStateDefer = 24 * time.Hour

// Record is the persisted retry state for installing a missing watchdog.
type Record struct {
	SchemaVersion  int        `json:"v"`
	BudgetVersion  string     `json:"budgetVersion,omitempty"` // agent version the budget belongs to
	Attempts       int        `json:"attempts"`
	FirstAttemptAt time.Time  `json:"firstAttemptAt,omitempty"`
	LastAttemptAt  time.Time  `json:"lastAttemptAt,omitempty"`
	NextAttemptAt  time.Time  `json:"nextAttemptAt,omitempty"`
	LastClass      ErrorClass `json:"lastClass,omitempty"`
	Terminal       bool       `json:"terminal,omitempty"`
}

// Store reads and writes the state file and opt-out marker in Dir. Dir must be
// set explicitly (the machine config dir in production, a temp dir in tests);
// an empty Dir is an error, never a default.
type Store struct {
	Dir string
	Now func() time.Time
}

var errNoDir = errors.New("watchdoginstall: store directory not set")

func (s Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s Store) path(name string) (string, error) {
	if s.Dir == "" {
		return "", errNoDir
	}
	return filepath.Join(s.Dir, name), nil
}

// Load returns the persisted record. A missing file is a fresh (zero) record.
// A file that cannot be read or parsed, or carries an unknown schema version or
// out-of-range values, yields corrupt=true and a record deferred by
// CorruptStateDefer — fail closed to the slow cadence. err is non-nil only for
// a misconfigured Store.
func (s Store) Load() (rec Record, corrupt bool, err error) {
	p, err := s.path(StateFileName)
	if err != nil {
		return Record{}, false, err
	}
	data, readErr := os.ReadFile(p)
	if errors.Is(readErr, fs.ErrNotExist) {
		return Record{}, false, nil
	}
	if readErr == nil {
		if decodeErr := json.Unmarshal(data, &rec); decodeErr == nil && rec.valid() {
			return rec, false, nil
		}
	}
	return Record{
		SchemaVersion: SchemaVersion,
		NextAttemptAt: s.now().Add(CorruptStateDefer),
	}, true, nil
}

func (r Record) valid() bool {
	if r.SchemaVersion != SchemaVersion {
		return false
	}
	if r.Attempts < 0 || r.Attempts > MaxRecordedAttempts {
		return false
	}
	if r.LastClass != "" && !r.LastClass.Valid() {
		return false
	}
	return len(r.BudgetVersion) <= 64
}

// Save atomically replaces the state file: temp file in the same directory,
// fsync, chmod 0600, rename. An interrupted Save leaves the previous file
// intact (or an orphan temp that the next Save's directory never confuses
// with the real name).
func (s Store) Save(rec Record) error {
	p, err := s.path(StateFileName)
	if err != nil {
		return err
	}
	rec.SchemaVersion = SchemaVersion
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return writeAtomic(p, data)
}

// Reset removes the state file. It NEVER touches the opt-out marker.
func (s Store) Reset() error {
	p, err := s.path(StateFileName)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// OptedOut reports whether the operator opted out of the watchdog. Only a
// marker that is definitely absent (ENOENT) reads as "not opted out"; any other
// stat outcome — present, permission error, I/O error, unset Dir — reads as
// opted out, because an ambiguous state must not trigger a privileged install.
func (s Store) OptedOut() bool {
	optedOut, _ := s.OptOutState()
	return optedOut
}

// OptOutState is OptedOut plus the reason when the answer was forced by a
// failed check (err != nil ⇒ optedOut is true, fail closed). Callers that can
// log should, so a permission or I/O fault is not mistaken for operator intent.
func (s Store) OptOutState() (optedOut bool, err error) {
	p, err := s.path(OptOutFileName)
	if err != nil {
		return true, err
	}
	_, err = os.Lstat(p)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	default:
		return true, err
	}
}

// SetOptedOut writes (true) or removes (false) the opt-out marker. Both are
// idempotent.
func (s Store) SetOptedOut(optedOut bool) error {
	p, err := s.path(OptOutFileName)
	if err != nil {
		return err
	}
	if !optedOut {
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("remove watchdog opt-out marker: %w", err)
		}
		return nil
	}
	body := []byte("Breeze watchdog installation disabled by `service install --no-watchdog`.\n" +
		"Run `service install --watchdog` to re-enable it.\n")
	if err := writeAtomic(p, body); err != nil {
		return fmt.Errorf("write watchdog opt-out marker: %w", err)
	}
	return nil
}

func writeAtomic(dst string, data []byte) error {
	dir := filepath.Dir(dst)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(dst)+"-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return err
	}
	ok = true
	if runtime.GOOS != "windows" {
		// Best effort: persist the rename itself across power loss.
		if d, err := os.Open(dir); err == nil {
			_ = d.Sync()
			_ = d.Close()
		}
	}
	return nil
}

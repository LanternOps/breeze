package macrelocate

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// RecordFileName is the relocation record's file name inside the agent
// config directory.
const RecordFileName = "executable-relocation.json"

// HealthComponent is the agent self-health component (heartbeat
// healthStatus.components) that reports a relocation still waiting for its
// Full Disk Access re-grant.
const HealthComponent = "macos_fda_relocation"

// ErrCorruptRecord marks a record file that exists but cannot be parsed.
// Only this error justifies discarding the record; any other read failure
// may be transient, and a discarded record is never recreated.
var ErrCorruptRecord = errors.New("corrupt relocation record")

// Record notes that the agent binary was relocated, so the heartbeat can
// report the lost Full Disk Access grant until it is re-granted.
type Record struct {
	From       string    `json:"from"`
	To         string    `json:"to"`
	RecordedAt time.Time `json:"recordedAt"`
}

// WriteRecord atomically writes r to dir/RecordFileName, mode 0600.
func WriteRecord(dir string, r Record) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+RecordFileName+".tmp-*")
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
	if _, err := tmp.Write(data); err != nil {
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
	if err := os.Rename(tmpName, filepath.Join(dir, RecordFileName)); err != nil {
		return err
	}
	committed = true
	return nil
}

// ReadRecord returns the record in dir, or nil with no error when there is
// none.
func ReadRecord(dir string) (*Record, error) {
	data, err := os.ReadFile(filepath.Join(dir, RecordFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r Record
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("%w: parse %s: %v", ErrCorruptRecord, RecordFileName, err)
	}
	return &r, nil
}

// ClearRecord removes the record; a missing record is not an error.
func ClearRecord(dir string) error {
	err := os.Remove(filepath.Join(dir, RecordFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// FDAGuidance is the health-component reason shown while the relocated
// binary has no Full Disk Access. It stays under the API's 512-character
// reason cap.
func FDAGuidance(r Record) string {
	// Deliberately silent on WHY it moved: 0.118.0–0.118.2 relocated every
	// install, safe or not, and those relocations are recorded too.
	return fmt.Sprintf("Agent binary was relocated from %s to %s. "+
		"macOS ties Full Disk Access to the binary path, so it must be re-granted for %s "+
		"(System Settings > Privacy & Security > Full Disk Access, or an MDM PPPC profile).",
		r.From, r.To, r.To)
}

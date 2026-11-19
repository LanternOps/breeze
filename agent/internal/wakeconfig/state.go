package wakeconfig

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("wakeconfig")

// StateFileName lives under config.GetDataDir().
const StateFileName = "wake_status_state.json"

// DefaultStatePath is where the state is persisted.
func DefaultStatePath() string { return filepath.Join(config.GetDataDir(), StateFileName) }

// State is the persisted adapter memory, the last accepted upload, and the
// apply limiter and pending writes.
type State struct {
	Adapters              AdapterMemory `json:"adapters"`
	LastUploadAt          time.Time     `json:"lastUploadAt"`
	LastUploadFingerprint string        `json:"lastUploadFingerprint"`
	Apply                 ApplyState    `json:"apply"`
}

// loadState is loadStateAt at the current time.
func loadState(path string) State { return loadStateAt(path, time.Now()) }

// loadStateAt returns the persisted state. A missing file is a clean start. An
// unreadable or corrupt one starts empty with a warning, and embargoes writes
// for 24 h from now: the write limiter is lost, and losing it must not hand
// out a fresh budget.
func loadStateAt(path string, now time.Time) State {
	st := State{Adapters: AdapterMemory{}}
	embargo := func() State {
		st.Apply.Limiter.EmbargoUntil = now.UTC().Add(attemptInterval)
		return st
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Warn("wake status state unreadable; starting empty, writes paused 24 h", "error", err.Error())
			return embargo()
		}
		return st
	}
	var parsed State
	if err := json.Unmarshal(raw, &parsed); err != nil {
		log.Warn("wake status state corrupt; starting empty, writes paused 24 h", "error", err.Error())
		return embargo()
	}
	if parsed.Adapters == nil {
		parsed.Adapters = AdapterMemory{}
	}
	return parsed
}

// saveState writes atomically (tmp + rename) with mode 0600.
func saveState(path string, st State) error {
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), StateFileName+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, os.ErrPermission) {
		// Chmod is a no-op on Windows; elsewhere a failure is not fatal.
		log.Debug("wake status state chmod failed", "error", err.Error())
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return err
	}
	return nil
}

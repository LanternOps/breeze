package rollback

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type record struct {
	Digest      string      `json:"digest"`
	Directive   Directive   `json:"directive"`
	Phase       Phase       `json:"phase"`
	Observation Observation `json:"observation"`
}

type stateFile struct {
	SchemaVersion int               `json:"schemaVersion"`
	Active        *record           `json:"active,omitempty"`
	Tombstones    map[string]record `json:"tombstones"`
	Pending       []Observation     `json:"pendingObservations,omitempty"`
	LegacyPending *Observation      `json:"pendingObservation,omitempty"`
}

type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(path string) *Store { return &Store{path: path} }

func (s *Store) loadLocked() (stateFile, error) {
	state := stateFile{SchemaVersion: 1, Tombstones: map[string]record{}}
	payload, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(payload, &state); err != nil {
		return state, fmt.Errorf("decode rollback state: %w", err)
	}
	if state.SchemaVersion != 1 {
		return state, fmt.Errorf("unsupported rollback state schema")
	}
	if state.Tombstones == nil {
		state.Tombstones = map[string]record{}
	}
	if len(state.Pending) == 0 && state.LegacyPending != nil {
		state.Pending = append(state.Pending, *state.LegacyPending)
	}
	state.LegacyPending = nil
	return state, nil
}

func (s *Store) saveLocked(state stateFile) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".rollback-state-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(name)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := replaceStateFile(name, s.path); err != nil {
		return err
	}
	if err := syncStateDir(s.path); err != nil {
		return err
	}
	ok = true
	return nil
}

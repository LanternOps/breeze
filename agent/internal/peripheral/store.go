package peripheral

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"

	"github.com/breeze-rmm/agent/internal/config"
)

const policiesFile = "peripheral_policies.json"
const policyV2StateFile = "peripheral_policy_v2_state.json"

// Store manages local persistence of peripheral policies.
type Store struct {
	mu          sync.RWMutex
	policies    []Policy
	path        string
	v2Path      string
	writeAtomic func(string, []byte) error
}

// NewStore creates a Store that persists policies in the agent data directory.
func NewStore() *Store {
	return &Store{
		path:   filepath.Join(config.GetDataDir(), policiesFile),
		v2Path: filepath.Join(config.GetDataDir(), policyV2StateFile),
	}
}

func atomicWriteFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return err
	}
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
	return os.Rename(tmpName, path)
}

func (s *Store) writer() func(string, []byte) error {
	if s.writeAtomic != nil {
		return s.writeAtomic
	}
	return atomicWriteFile
}

// Save writes policies to disk atomically (write tmp + rename).
func (s *Store) Save(policies []Policy) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(policies, "", "  ")
	if err != nil {
		return err
	}

	if err := s.writer()(s.path, data); err != nil {
		return err
	}
	s.policies = append([]Policy(nil), policies...)
	return nil
}

func (s *Store) statePath() string {
	if s.v2Path != "" {
		return s.v2Path
	}
	return filepath.Join(filepath.Dir(s.path), policyV2StateFile)
}

// SaveV2State atomically replaces the last fully-applied v2 policy state.
func (s *Store) SaveV2State(state PeripheralPolicyStateV2) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := s.writer()(s.statePath(), data); err != nil {
		return err
	}
	persisted, err := readV2StateFile(s.statePath())
	if err != nil {
		return err
	}
	if persisted == nil {
		return errors.New("peripheral v2 state missing after save")
	}
	if !reflect.DeepEqual(*persisted, state) {
		return errors.New("peripheral v2 state failed readback verification")
	}
	return nil
}

// LoadV2State returns nil when no v2 policy has yet been applied. Corrupt state
// is an error and must fail closed instead of being treated as first boot.
func (s *Store) LoadV2State() (*PeripheralPolicyStateV2, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return readV2StateFile(s.statePath())
}

func readV2StateFile(path string) (*PeripheralPolicyStateV2, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var state PeripheralPolicyStateV2
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

// Load reads policies from disk into memory.
func (s *Store) Load() ([]Policy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			s.policies = nil
			return nil, nil
		}
		return nil, err
	}

	var policies []Policy
	if err := json.Unmarshal(data, &policies); err != nil {
		return nil, err
	}
	s.policies = policies
	return policies, nil
}

// Policies returns the in-memory copy. Call Load first to populate.
func (s *Store) Policies() []Policy {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.policies
}

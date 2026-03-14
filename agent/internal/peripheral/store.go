package peripheral

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/breeze-rmm/agent/internal/config"
)

const policiesFile = "peripheral_policies.json"

// Store manages local persistence of peripheral policies.
type Store struct {
	mu       sync.RWMutex
	policies []Policy
	path     string
}

// NewStore creates a Store that persists policies in the agent data directory.
func NewStore() *Store {
	return &Store{
		path: filepath.Join(config.GetDataDir(), policiesFile),
	}
}

// Save writes policies to disk atomically (write tmp + rename).
func (s *Store) Save(policies []Policy) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.policies = policies

	data, err := json.MarshalIndent(policies, "", "  ")
	if err != nil {
		return err
	}

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
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
